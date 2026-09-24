# OpenCode V2 migration continuation plan

## Decision and baseline

Recorded 2026-09-24. Migration is deferred while the owner establishes an
AI-assisted reverse-engineering benchmark on V1 with the existing Goal runtime.
This document is a handoff for future implementation, not a claim of V2 support.

- Fork: https://github.com/bbuklov/opencode-goal
- Inspected branch: `v2-tui-migration`.
- Inspected commit: `def0cf75e3dbbee7e47dca574825ea852fb4aca7`.
- Package version: `1.3.36`.
- Installed host: **OpenCode 2.0.15**, confirmed with both `opencode --version`
  and `opencode2 --version`. Both commands currently run V2.
- Local plugin SDK/schema/protocol: **2.0.15**; V1 plugin SDK: **1.18.9**.
- Existing exact V2 host CI targets **2.0.11**, with an additional moving preview
  lane. Those results must not be assumed to prove behavior on 2.0.15.
- `npm run check` passed during the assessment. No complete test suite or host
  migration experiments were run for this assessment.
- A pre-existing untracked `package-lock.json` was present; do not overwrite or
  include it as an incidental part of this documentation/migration work.

Target the installed **2.0.15** contract first. If the owner later chooses another
host version, explicitly update this baseline and rerun the capability probes.
Keep V1 functional until the V2 acceptance matrix is complete. Do not silently
replace the user's V2 installation or share mutable test profiles between hosts.

## Current implementation and reusable assets

`src/server.ts` provides both the V1 server entry and V2 setup entry.
`src/opencode2/experimental.ts` is a roughly 800-line preview, not a full runtime.
With `OPENCODE_GOAL_V2_DIRECT_LIFECYCLE` enabled its native command admits a user
message, arms a one-use capability and asks the model to invoke a control tool.
Only create/edit/pause/resume/clear and status/contract/audit are supported.
Read commands currently call `session.prompt(..., resume: true)`, so they do not
preserve V1's no-model-response behavior.

Reusable code includes `src/domain`, `src/persistence`, `src/runtime`,
`src/verification`, the parser in `src/opencode/command.ts`, formatters, and the
existing unit/eval/real-host fixtures. V1 behavior is composed in `src/index.ts`;
its wrapper order is semantically important. Read that file and each installed
wrapper before treating `src/opencode/plugin.ts` as the complete specification.

The TUI already has a V2 entry in `src/tui/index.ts`; the installer already detects
the host major version. Review and test those implementations instead of
assuming they need to be written from scratch.

Related scope statement: [V2 promotion scope](opencode2-promotion-scope.md).

## Architecture decisions

1. Native `/goal` must parse and execute trusted host-side operations directly.
   Mutation must not depend on model willingness, tool selection, or model text.
2. Extract a shared command/application layer from V1 as needed. Reuse state
   transitions, stores, parsers and output formatters; avoid duplicating the
   complete V1 implementation inside the preview adapter.
3. Keep host integration separate: response presentation, interruption, prompt
   delivery, events, session access and UI are adapter responsibilities.
4. A model-visible lifecycle tool is a separate feature with explicit authority
   checks. The existing one-use tool is not required to implement native commands.
5. Use actual 2.0.15 SDK types at the boundary. The current handwritten context
   interface and pervasive `any` hide API incompatibilities.
6. Preserve state formats where possible. If persistence must change, define
   versioning, fixtures, migration and rollback behavior before writing new data.
7. Make continuation coordination explicit. User steering, Plan restrictions,
   delegated tasks, verifier children, queue progression, compaction, restart,
   and retry recovery must agree on who may send the next prompt.
8. Preserve session-specific Location resolution and project isolation. Do not
   infer a session's directory solely from the plugin instance's location.

## Phase 0 — establish host contracts before broad implementation

- [ ] Pin a reproducible 2.0.15 test host and SDK; record host/package versions,
      commit, platform and fixture provider with every host result.
- [ ] Read installed SDK declarations first. If implementation details are
      required, fetch the matching OpenCode source revision/tag and record its
      identity; do not use an unpinned development branch as the specification.
- [ ] Prove native command execution can persist state without a model call.
- [ ] Prove deterministic status output without a model call or autonomous
      wake-up. Investigate `session.synthetic` with `resume: false`; it is a
      candidate, not a verified V1 `noReply` equivalent. Check actual TUI display
      and inbox effects. The command executor itself returns `void`.
- [ ] Prove interruption behavior while a tool/model call is active, including
      late events and pending inbox items. In installed 2.0.15 the input uses
      `resume`; newer web examples may show a different name.
- [ ] Capture event traces for prompt admission, primary execution, steps,
      tools, usage, idle, compaction, failure and retry.
- [ ] Determine whether subscriptions replay events, their ordering guarantees,
      cancellation behavior and how execution/message/step IDs correlate.
- [ ] Verify the route for child-session lifecycle and session discovery.
      The full 2.0.15 client has list/remove/active/compact/diff; the plugin's
      `ctx.session` exposes a smaller subset. Verify a supported client/RPC route
      instead of assuming those methods are directly available on the context.
- [ ] Prove cleanup on plugin unload: unsubscribe, cancel timers and invalidate
      pending dispatches. Do not swallow required registration failures.

Exit: executable host probes and a capability matrix separating verified
behavior, unsupported behavior, and open questions. Resolve critical gaps before
promising full parity; document any intentional behavior change for the owner.

## Phase 1 — full native command surface

Port all 20 parser actions:

| Group | Actions | Required behavior |
| --- | --- | --- |
| Read | status, contract, audit, doctor, list, history, queue | Deterministic formatting, no model work, no lifecycle mutation |
| Lifecycle | create, edit, pause, resume, clear | Conflict checks; interruption; correct state and continuation semantics |
| Budget | budget | Preserve accounting; exhausted limits block resume; increasing limits may auto-resume as in V1 |
| Archive | history_prune, restore | Selector validation; retention; restore stays paused |
| Sequence | add, queue_remove, queue_move, queue_clear, next | Preserve ordering; use `GoalSequenceStore.promoteNext` |

- [ ] Preserve V1 parser behavior, including multiline input and options.
- [ ] Reuse exact V1 status/contract/audit/history/doctor formatters and lifecycle
      output semantics, including localization where applicable.
- [ ] Create/edit/resume/next emit a continuation only when appropriate.
- [ ] Pause/clear stop active work and prevent stale events from restarting it.
- [ ] Doctor remains readable with corrupt storage; do not unconditionally load
      the active Goal before dispatching it.
- [ ] Preserve Plan/restricted-agent rules, conflict handling, notification
      transitions and project/session selection.
- [ ] Test direct command provenance, attempts to spoof commands in ordinary
      text/tool inputs, concurrent mutations, and session Location failures.
- [ ] Run shared command tests against both adapters and a V2 host smoke test.

Exit: all commands work on 2.0.15 without requiring a model to mutate state;
read operations do not spend model tokens or start work.

## Phase 2 — execution, steering and accounting

Use the following as investigation destinations, not mechanical substitutions:

| V1 integration | V2 destination |
| --- | --- |
| chat.message | prompt hook plus inbox/execution identity |
| chat.params / system context | context hook; model.request for transport settings |
| tool.execute.before/after | tool execute.before/execute.after hooks |
| event bus | event.subscribe |
| message.updated usage | execution/step/usage events with defined accounting source |
| session.idle/status | corresponding V2 events plus execution identity |
| compaction hooks | compaction hook and completion/failure events |

- [ ] Define what counts as a Goal turn; distinguish primary requests from
      title/generate/compaction/verifier work.
- [ ] Choose authoritative usage inputs and deduplicate by stable identity.
      Do not add both cumulative totals and step deltas.
- [ ] Preserve token, cost, turn, runtime and host-limit semantics.
- [ ] Implement prompt ownership and idempotent dispatch. A user intervention
      invalidates pending autonomous continuations for the old revision.
- [ ] Preserve task deferral, Plan boundaries, natural-language model-mediated
      resume, model switching and coexistence with Loop.
- [ ] Test late/duplicate events, pause vs idle, edit vs pending continuation,
      concurrent sessions and multiple plugin instances.

Exit: multi-turn work continues once per eligible transition, respects user
control and limits, and accounts for usage without duplication.

## Phase 3 — progress and execution telemetry

- [ ] Port mutation fingerprints, shell progress and current-revision evidence.
- [ ] Exclude Goal's own persistence/control-plane writes from task progress.
- [ ] Replace missing patch-part signals with verified tool/VCS observations.
      Handle pre-existing changes, untracked files and non-Git projects; a raw
      working-tree diff alone is not proof of progress in the current turn.
- [ ] Port Todo telemetry without treating completed Todos as completion proof.
- [ ] Preserve cadence, no-progress and empty-turn guards.
- [ ] Port tool failure/permission-denial handling and batch-related semantics
      where supported by the selected V2 host.

Exit: productive shell-only work is recognized; empty activity and Goal metadata
writes do not reset stall detection.

## Phase 4 — completion and semantic verifier

- [ ] Preserve host checks, file contracts, constraints, evidence and audit data.
- [ ] Port verifier child creation, permissions, isolation, timeouts, usage
      treatment, result retrieval and cleanup through verified APIs.
- [ ] Bind verifier results and completion transitions to Goal ID and revision;
      discard results from an earlier objective or a cancelled verification.
- [ ] Preserve completion gate ordering and queue promotion rules.
- [ ] Reuse false-completion and constraint-preservation fixtures; add host
      coverage for verifier failure, timeout, interruption and stale results.

Exit: the model's claim cannot complete an unverified Goal; successful evidence
can complete only the matching current revision.

## Phase 5 — compaction, restart and infrastructure recovery

- [ ] Define the owner of post-compaction continuation. No duplicate prompts
      when the host also resumes; no deadlock when it does not.
- [ ] Preserve Goal context across manual and automatic compaction, including
      failed compaction and user interruption during compaction.
- [ ] Snapshot startup goals before admitting new work to avoid recovery races.
- [ ] Recover eligible active goals after clean restart and hard process death.
      Paused, completed or exhausted goals must not resume unexpectedly.
- [ ] Preserve persisted backoff, retry classification, no-progress limits and
      transport failure handling; distinguish retry from a completed turn.
- [ ] Reconcile pending dispatch/state after crashes; account for stale locks
      and ensure multiple processes do not both continue the same Goal.
- [ ] Repeat Loop/task/Plan coexistence tests across these recovery paths.

Exit: restart/compaction/retry scenarios produce bounded, attributable recovery
without duplicate execution, lost user steering or false completion.

## Phase 6 — delivery and promotion

- [ ] Verify TUI sidebar, deterministic read output and notification transport;
      server-side toast calls may require a V2 client/RPC replacement.
- [ ] Verify clean install, update, uninstall, exports and command discoverability
      on V1 and exact V2; avoid duplicate legacy/native `/goal` registration.
- [ ] Keep an exact 2.0.15 CI lane; optionally add a newer-host compatibility lane.
      Update CI path filters to cover shared runtime/domain/persistence changes.
- [ ] Run `npm run release:check`, relevant existing canaries and V2 host probes.
- [ ] Test macOS and Linux; define Windows support explicitly if not verified.
- [ ] Run real-provider smoke tests after deterministic provider fixtures pass.
- [ ] Run the owner's V1 reverse-engineering baseline on V2 with the same task
      fixtures, model/settings, tools and budgets; repeat stochastic trials.
- [ ] Update README, changelog, installer messages, package compatibility and
      `opencode2-promotion-scope.md` to match demonstrated support.
- [ ] Remove preview warnings/gates only when the corresponding capability has
      evidence. A working loader or command surface does not establish parity.

## Required acceptance scenarios

Each scenario needs a named automated test or a recorded reproducible host run:

1. All 20 actions, including errors and selectors; read commands call no model.
2. Goal creation, multiple productive turns and independently verified completion.
3. Pause/clear during a running tool and late idle events; no automatic restart.
4. Edit during execution/verification; no stale evidence or continuation applies.
5. Budget exhaustion, denied resume and increased-budget auto-resume.
6. Queue promotion once, archive/restore paused, and corrupt-storage doctor.
7. Todo-only/metadata-only activity does not fake progress or completion.
8. Child task deferral and restricted-agent boundaries throughout continuation.
9. Manual/automatic compaction, failure and exactly one eligible continuation.
10. Clean restart, hard crash, retry recovery and multiple-instance contention.
11. Loop coexistence and ordinary/foreign commands do not manufacture authority.
12. Cross-project Location separation and cleanup after plugin reload/unload.

For each phase record: commit, tests, exact host version, result/log artifact,
remaining gaps and next action. Keep secrets and private reverse-engineering
artifacts out of committed logs.

## Effort and resume instructions

Initial estimate with an agent-assisted developer: **60–120 focused hours**,
roughly **2–4 working weeks** including integration iterations. Confidence is
medium until Phase 0. Approximate allocation: contracts 4–8h; commands 8–16h;
runtime 12–24h; progress/verifier 12–24h; recovery 16–32h; release 8–16h.
An upstream host limitation can extend calendar time beyond this estimate.

When resuming: read this plan, inspect the current diff and latest handoff,
reconfirm the owner's target host, then execute Phase 0. Do not start by merely
adding parser branches or removing the preview environment gate. Run host tests
at each phase rather than deferring all integration checks to the end.

## References

- https://opencode.ai/v2/docs/build/plugins
- https://opencode.ai/v2/docs/build/plugins/migrate-v1
- https://opencode.ai/v2/docs/migrate-v1
- Installed exact SDK: `node_modules/@opencode/plugin/dist/promise/`
- Full client types: `node_modules/@opencode/plugin/node_modules/@opencode/client/dist/`
- Existing V2 tests: `test/opencode2-*.test.mjs`
- Existing host probes: `scripts/opencode2-*.mjs`
- Existing V2 CI: `.github/workflows/opencode2-canary.yml`

Web documentation moves independently of 2.0.15. Prefer exact installed types
and observed host behavior when examples disagree.
