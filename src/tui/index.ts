import { Plugin } from "@opencode/plugin/tui"
import { jsx } from "@opentui/solid/jsx-runtime"
import { formatGoalSidebar } from "./format.js"

// OpenCode 1.x TUI plugin contract (retired by OpenCode 2, kept for 1.x hosts).
type GoalTuiApi = {
  slots: {
    register(plugin: {
      order?: number
      slots: {
        sidebar_content: (context: unknown, props: { session_id: string }) => unknown
      }
    }): unknown
  }
  state: {
    path: { directory: string; worktree: string }
    session: {
      status(sessionID: string): unknown
      messages(sessionID: string): ReadonlyArray<unknown>
    }
  }
}

type GoalTuiModule = {
  id: string
  tui(api: GoalTuiApi, options?: Record<string, unknown>, meta?: unknown): Promise<void>
}

const tui: GoalTuiModule["tui"] = async (api) => {
  api.slots.register({
    order: 340,
    slots: {
      sidebar_content: (_context, props) => {
        // Host session state is intentionally touched so normal status/message
        // transitions re-evaluate this read-only filesystem projection.
        api.state.session.status(props.session_id)
        api.state.session.messages(props.session_id).length
        const root = api.state.path.directory || api.state.path.worktree
        return formatGoalSidebar(root, props.session_id)
      },
    },
  })
}

// OpenCode 2.x CLI plugin contract. The host validates the default export as
// Plugin.define({ id, setup }) from "@opencode/plugin/tui"; the 1.x `tui` key
// is ignored by V2 hosts and `setup` is ignored by 1.x hosts.
const v2 = Plugin.define({
  id: "opencode-goal",
  setup(context) {
    return context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) =>
        jsx("text", {
          // Getter children mirror Solid's compiled <text>{expr}</text>: the
          // body re-runs when reactive host state read inside it changes.
          // Plain tsc (react-jsx) would evaluate children eagerly, so the
          // getter is written by hand.
          get children() {
            // Host session state is intentionally touched so normal
            // status/message transitions re-evaluate this read-only
            // filesystem projection.
            context.data.session.status(sessionID)
            context.data.session.message.list(sessionID).length
            const root = context.location?.directory ?? context.data.location.default().directory
            return formatGoalSidebar(root, sessionID)
          },
        }),
    })
  },
})

const plugin: GoalTuiModule & Plugin.Definition = {
  ...v2,
  tui,
}

export default plugin
