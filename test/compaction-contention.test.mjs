import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenCodeGoalPlugin from "../dist/index.js"
import { GoalStore } from "../dist/persistence/store.js"
import { pauseGoal, editGoal } from "../dist/domain/goal.js"
import { addProgressNote } from "../dist/runtime/progress.js"

const SESSION = "session-compaction-contention"
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 5)) }
async function waitFor(predicate) {
  const deadline = Date.now() + 1500
  while (Date.now() < deadline) {
    if (await predicate()) return
    await tick()
  }
  assert.fail("condition was not met")
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "goal-compaction-contention-"))
  const prompts = [], pending = []
  const client = { session: {
    prompt(arg) { prompts.push(arg); return new Promise((resolve, reject) => pending.push({ resolve, reject })) },
    abort() { return Promise.resolve(true) },
  } }
  const hooks = await OpenCodeGoalPlugin({ client, directory: root })
  const output = { parts: [{ type: "text", text: "raw" }] }
  await hooks["command.execute.before"]({ command: "goal", sessionID: SESSION, arguments: "finish original objective" }, output)
  await hooks["chat.message"](
    { sessionID: SESSION, messageID: "user-initial", agent: "build", model: { providerID: "p", modelID: "m" } },
    { message: { id: "user-initial" }, parts: output.parts },
  )
  const store = new GoalStore(root)
  const initial = await store.load(SESSION)
  await store.save({ ...initial, execution: { ...initial.execution, modelContext: { contextLimit: 200000, lastInputTokens: 12000, lastRequestTokens: 12000 } } })
  const idle = () => hooks.event({ event: { type: "session.idle", properties: { sessionID: SESSION } } })
  const compact = () => hooks["experimental.compaction.autocontinue"]({ sessionID: SESSION }, { enabled: true })
  async function bindPrompt(index) {
    await hooks["chat.message"](
      { sessionID: SESSION, messageID: `user-continuation-${index}`, agent: "build", model: { providerID: "p", modelID: "m" } },
      { message: { id: `user-continuation-${index}` }, parts: prompts[index].body.parts },
    )
  }
  return { root, hooks, store, prompts, pending, idle, compact, bindPrompt,
    async cleanup() { for (const item of pending) item.resolve({}); await tick(); await rm(root, { recursive: true, force: true }) },
  }
}

function coreSave(stack) { return stack.includes("/opencode/plugin.js:") }
function hostLimitSave(stack) { return stack.includes("/opencode/host-limits.js:") }

test("real host-limit context reset racing compaction fallback retries core CAS and dispatches once", async () => {
  const f = await fixture()
  const save = GoalStore.prototype.save
  let held = false, release
  const barrier = new Promise((resolve) => { release = resolve })
  let coreAttempts = 0, hostWrites = 0
  GoalStore.prototype.save = async function (goal) {
    const stack = new Error().stack
    if (coreSave(stack)) {
      coreAttempts += 1
      if (!held) { held = true; await barrier }
    }
    const result = await save.call(this, goal)
    if (hostLimitSave(stack)) { hostWrites += 1; release() }
    return result
  }
  try {
    await f.compact()
    await waitFor(() => f.prompts.length === 1)
    assert.equal(hostWrites, 1)
    assert.equal(coreAttempts, 2, "the first stale save is recomputed against the outer wrapper's generation")
    const goal = await f.store.load(SESSION)
    assert.equal(goal.execution.modelContext.lastInputTokens, undefined, "core retry preserves the context reset")
    await f.idle(); await tick()
    assert.equal(f.prompts.length, 1, "duplicate compaction idle cannot add a second prompt")
    await f.bindPrompt(0)
  } finally { GoalStore.prototype.save = save; release(); await f.cleanup() }
})

for (const change of ["pause", "edit"]) {
  test(`compaction CAS retry honors a concurrent ${change} instead of dispatching the stale objective`, async () => {
    const f = await fixture()
    const save = GoalStore.prototype.save
    let injected = false
    GoalStore.prototype.save = async function (goal) {
      if (!injected && coreSave(new Error().stack)) {
        injected = true
        // The user action also competes with the real host-limit reset. Make
        // that action durable before releasing the old core generation.
        for (let attempt = 0; attempt < 6; attempt++) {
          const latest = await f.store.load(SESSION)
          const changed = change === "pause" ? pauseGoal(latest, "human paused during compaction") : editGoal(latest, { objective: "replacement objective" })
          try { await save.call(f.store, changed); break }
          catch (error) { if (error.kind !== "stale_write" || attempt === 5) throw error }
        }
      }
      return await save.call(this, goal)
    }
    try {
      await f.compact()
      await waitFor(async () => {
        const latest = await f.store.load(SESSION)
        return change === "pause" ? latest.status === "paused" : latest.objective === "replacement objective"
      })
      await tick()
      assert.equal(injected, true)
      assert.equal(f.prompts.length, 0)
      const latest = await f.store.load(SESSION)
      if (change === "pause") assert.equal(latest.status, "paused")
      else assert.equal(latest.objective, "replacement objective")
    } finally { GoalStore.prototype.save = save; await f.cleanup() }
  })
}

test("exhausted compaction CAS retries report the error and keep the next safe idle retryable", async () => {
  const f = await fixture()
  const save = GoalStore.prototype.save, logError = console.error
  const diagnostics = []
  let armed = true, attempts = 0
  console.error = (...args) => diagnostics.push(args.join(" "))
  GoalStore.prototype.save = async function (goal) {
    if (armed && coreSave(new Error().stack)) {
      attempts += 1
      const latest = await f.store.load(SESSION)
      await save.call(f.store, addProgressNote(latest, { summary: `competing write ${attempts}` }))
    }
    return await save.call(this, goal)
  }
  try {
    await f.compact()
    await waitFor(() => diagnostics.length > 0)
    assert.equal(attempts, 6, "retry is bounded and schedules no background timer loop")
    assert.equal(f.prompts.length, 0)
    assert.equal((await f.store.load(SESSION)).status, "active")
    assert.match(diagnostics[0], /Post-compaction continuation failed.*stale_write/)
    armed = false
    await f.idle()
    await waitFor(() => f.prompts.length === 1)
    await f.idle(); await tick()
    assert.equal(f.prompts.length, 1)
    await f.bindPrompt(0)
  } finally { GoalStore.prototype.save = save; console.error = logError; await f.cleanup() }
})

test("compaction within an unresolved Goal-owned SDK turn defers exactly once until the old request settles", async () => {
  const f = await fixture()
  try {
    await f.idle()
    assert.equal(f.prompts.length, 1)
    await f.bindPrompt(0)
    await f.compact(); await tick()
    await f.idle(); await f.idle(); await tick()
    assert.equal(f.prompts.length, 1, "no overlapping SDK turn is started")
    f.pending[0].resolve({})
    await waitFor(() => f.prompts.length === 2)
    await f.idle(); await tick()
    assert.equal(f.prompts.length, 2, "the deferred continuation is not duplicated by a late idle")
    await f.bindPrompt(1)
  } finally { await f.cleanup() }
})

test("assistant usage CAS retry preserves a concurrent wrapper update and accounts the message once", async () => {
  const f = await fixture()
  const save = GoalStore.prototype.save
  let injected = false
  GoalStore.prototype.save = async function (goal) {
    if (!injected && coreSave(new Error().stack)) {
      injected = true
      const latest = await f.store.load(SESSION)
      await save.call(f.store, addProgressNote(latest, { summary: "concurrent wrapper telemetry" }))
    }
    return await save.call(this, goal)
  }
  const info = { id: "assistant-result", sessionID: SESSION, parentID: "user-initial", role: "assistant", text: "completed useful isolated work",
    time: { created: 100, completed: 200 }, tokens: { input: 10, output: 2, reasoning: 0 }, cost: 0 }
  try {
    await f.hooks.event({ event: { type: "message.updated", properties: { info } } })
    await f.hooks.event({ event: { type: "message.updated", properties: { info } } })
    const goal = await f.store.load(SESSION)
    assert.equal(injected, true)
    assert.equal(goal.usage.turns, 1)
    assert.equal(goal.usage.seenMessageIDs.filter((id) => id === info.id).length, 1)
    assert.ok(goal.progressNotes.some((note) => note.summary === "concurrent wrapper telemetry"))
  } finally { GoalStore.prototype.save = save; await f.cleanup() }
})


test("chat.params context telemetry CAS retry cannot abort the next assistant request", async () => {
  const f = await fixture()
  const save = GoalStore.prototype.save
  let injected = false
  GoalStore.prototype.save = async function (goal) {
    if (!injected && coreSave(new Error().stack)) {
      injected = true
      const latest = await f.store.load(SESSION)
      await save.call(f.store, addProgressNote(latest, { summary: "concurrent wrapper before request" }))
    }
    return await save.call(this, goal)
  }
  try {
    await f.hooks["chat.params"]({ sessionID: SESSION, model: { limit: { context: 128000, output: 8000 } } })
    const goal = await f.store.load(SESSION)
    assert.equal(injected, true)
    assert.equal(goal.execution.modelContext.contextLimit, 128000)
    assert.ok(goal.progressNotes.some((note) => note.summary === "concurrent wrapper before request"))
  } finally { GoalStore.prototype.save = save; await f.cleanup() }
})
