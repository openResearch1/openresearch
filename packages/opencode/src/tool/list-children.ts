import z from "zod"
import { Collab } from "@/collab"
import { Tool } from "./tool"
import DESCRIPTION from "./list-children.txt"

const parameters = z.object({})

// Per-session polling counter keyed by the current assistant message (turn).
// Collab's child_done callbacks mean LLMs should never poll list_children —
// but some models do anyway, burning tokens and cluttering the session. We
// enforce a soft cap: first call is silent, subsequent calls within the same
// turn get a warning, and beyond MAX_CALLS_PER_TURN we throw so the model
// actually has to stop.
const pollState = new Map<string, { messageID: string; count: number }>()
const MAX_CALLS_PER_TURN = 2

export const ListChildrenTool = Tool.define("list_children", async () => {
  return {
    description: DESCRIPTION,
    parameters,
    async execute(_params: z.infer<typeof parameters>, ctx) {
      // Bump per-turn call counter (new turn = fresh count)
      const last = pollState.get(ctx.sessionID)
      const count = last?.messageID === ctx.messageID ? last.count + 1 : 1
      pollState.set(ctx.sessionID, { messageID: ctx.messageID, count })

      if (count > MAX_CALLS_PER_TURN) {
        throw new Error(
          `list_children called ${count} times in this assistant turn — STOP POLLING. ` +
            `Children report back asynchronously via child_done messages; the framework ` +
            `automatically re-invokes your LLM with a child_done summary when peers complete. ` +
            `End your turn now and DO NOT call this tool again until you receive a child_done ` +
            `notification. Do not use bash sleep or any other workaround to wait — the ` +
            `framework handles waiting for you.`,
        )
      }

      const parentNode = Collab.getBySession(ctx.sessionID)
      if (!parentNode) {
        const meta: { count: number; parentAgentId: string | null } = { count: 0, parentAgentId: null }
        return {
          title: "list_children",
          metadata: meta,
          output: "No Collab agent bound to this session yet. Spawn a child first.",
        }
      }
      const children = Collab.children(parentNode.id)

      // Metadata only. Child summary / progress intentionally NOT included here —
      // surfacing them makes LLMs poll this tool to read completed results, which
      // defeats the async child_done callback model. To read a child's full output,
      // call `read_agent_output(agent_id)`.
      const rows = children.map((c) => ({
        agent_id: c.id,
        name: c.name,
        subagent_type: c.subagent_type,
        status: c.status,
        active_children: c.active_children,
        spawned_at: c.time_started ?? c.time_created,
        ended_at: c.time_ended ?? null,
      }))

      const meta: { count: number; parentAgentId: string | null } = {
        count: rows.length,
        parentAgentId: parentNode.id,
      }

      const warning =
        count > 1
          ? [
              "",
              `POLLING WARNING: You have called list_children ${count} times in this turn.`,
              "Do NOT poll. End your turn — the framework auto-resumes your LLM with",
              "child_done messages when peers complete. Another call this turn will throw.",
            ].join("\n")
          : ""

      return {
        title: "list_children",
        metadata: meta,
        output: JSON.stringify({ children: rows }, null, 2) + warning,
      }
    },
  }
})
