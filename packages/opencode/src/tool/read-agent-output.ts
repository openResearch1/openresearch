import z from "zod"
import { Collab } from "@/collab"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Tool } from "./tool"
import DESCRIPTION from "./read-agent-output.txt"

const parameters = z.object({
  agent_id: z.string().describe("The child agent's id (from spawn_agent / list_children / child_done card)"),
  include_progress: z
    .boolean()
    .optional()
    .describe("If true, include the full child_progress history (may be large; default false)"),
  max_bytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Cap on returned summary length in bytes (default 65536 = 64KB)"),
})

const DEFAULT_MAX_BYTES = 64 * 1024

export const ReadAgentOutputTool = Tool.define("read_agent_output", async () => {
  return {
    description: DESCRIPTION,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const target = Collab.tryGet(params.agent_id)
      if (!target) {
        throw new Error(`No agent ${params.agent_id}`)
      }

      // Only let the caller read agents in its own subtree.
      const caller = Collab.getBySession(ctx.sessionID)
      if (!caller) {
        throw new Error("Caller session is not a Collab agent; spawn a child first.")
      }
      if (target.root_agent_id !== caller.root_agent_id) {
        throw new Error(`Permission denied: ${params.agent_id} is not in your subtree.`)
      }

      const maxBytes = params.max_bytes ?? DEFAULT_MAX_BYTES
      const fullText = await extractFullFinalText(target.session_id)
      const truncated = fullText.length > maxBytes
      const summaryText = truncated ? fullText.slice(0, maxBytes) + "\n...[truncated]" : fullText

      const payload: Record<string, unknown> = {
        agent_id: target.id,
        name: target.name,
        subagent_type: target.subagent_type,
        status: target.status,
        spawned_at: target.time_started ?? target.time_created,
        ended_at: target.time_ended ?? null,
        summary: summaryText,
        summary_truncated: truncated,
        summary_bytes: fullText.length,
      }

      if (target.error) {
        payload.error = target.error
      }

      if (params.include_progress) {
        const progressMsgs = Collab.listMessages(target.id, { kind: "child_progress", limit: 500 })
        payload.progress = progressMsgs.map((m) => m.payload_json)
      }

      return {
        title: "read_agent_output",
        metadata: {
          agent_id: target.id,
          status: target.status,
          truncated,
        },
        output: JSON.stringify(payload, null, 2),
      }
    },
  }
})

/**
 * Return the concatenation of all non-empty text parts from the most recent
 * assistant message in the agent's session. Concatenating (rather than just
 * taking the first text part, as CollabLoop.extractSessionSummary does) lets
 * us recover messages whose final assistant turn was split across multiple
 * text parts — e.g. streamed in chunks or interleaved with reasoning parts.
 */
async function extractFullFinalText(sessionID: string): Promise<string> {
  const msgs = await Session.messages({ sessionID })
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (msg.info.role !== "assistant") continue
    const texts: string[] = []
    for (const part of msg.parts) {
      if (part.type === "text") {
        const txt = (part as MessageV2.TextPart).text
        if (typeof txt === "string" && txt.trim().length > 0) texts.push(txt)
      }
    }
    if (texts.length > 0) return texts.join("\n\n")
  }
  return ""
}
