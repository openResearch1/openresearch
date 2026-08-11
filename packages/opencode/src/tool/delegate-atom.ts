import z from "zod"

import { Tool } from "./tool"
import DESCRIPTION from "./delegate-atom.txt"

const parameters = z.object({
  atom_id: z.string().describe("The existing Atom ID to delegate work to"),
  prompt: z.string().min(1).describe("The scoped task for the Atom coordinator"),
})

type Metadata = {
  atomId: string
  agentId?: string
  sessionId?: string
  runId: string
  status: string
  reason?: "human_control" | "leased" | "not_quiescent"
}

export const DelegateAtomTool = Tool.define<typeof parameters, Metadata>("delegate_atom", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const run = `${ctx.sessionID}:${ctx.callID || ctx.messageID}`
    await ctx.ask({
      permission: "delegate_atom",
      patterns: [params.atom_id],
      always: ["*"],
      metadata: { description: params.prompt, atom_id: params.atom_id },
    })

    const { AtomAgent } = await import("@/research/atom-agent")
    const current = ctx.extra?.model as { providerID?: string; id?: string } | undefined
    try {
      const result = await AtomAgent.delegate({
        atomId: params.atom_id,
        sourceSessionId: ctx.sessionID,
        agent: ctx.agent,
        prompt: params.prompt,
        model: current?.providerID && current.id ? { providerID: current.providerID, modelID: current.id } : undefined,
        runId: run,
      })
      const metadata: Metadata = {
        atomId: result.atomId,
        agentId: result.agentId,
        sessionId: result.sessionId,
        runId: result.runId,
        status: result.status,
      }
      ctx.metadata({ title: "resume_agent", metadata })
      const terminal = result.status === "completed" || result.status === "failed" || result.status === "canceled"
      return {
        title: "resume_agent",
        metadata,
        output: terminal
          ? [
              `agent_id: ${result.agentId}`,
              `session_id: ${result.sessionId}`,
              `run_id: ${result.runId}`,
              `status: ${result.status}`,
              "",
              "This idempotent delegation request already reached a terminal state and was released. Its standard child callback is the source of truth.",
            ].join("\n")
          : [
              `agent_id: ${result.agentId}`,
              `session_id: ${result.sessionId}`,
              `run_id: ${result.runId}`,
              `status: ${result.status}`,
              "",
              "The Atom is running asynchronously. END YOUR TURN NOW and wait for the standard child callback.",
              "Do not poll. If this run reports child_waiting, resume the Atom with the requested follow-up. After done/failed/canceled release, resume the Atom session again for new work.",
            ].join("\n"),
      }
    } catch (err) {
      if (!(err instanceof AtomAgent.BusyError)) throw err
      const owner = err.ownerSessionID ? ` Controller session: ${err.ownerSessionID}.` : ""
      const output =
        err.reason === "leased"
          ? `Atom ${params.atom_id} is already active.${owner} Wait for that session to finish or choose another Atom.`
          : err.reason === "human_control"
            ? `Atom ${params.atom_id} has active direct human control. Finish that interaction, then resume the Atom session.`
            : `Atom ${params.atom_id} is not fully settled. Wait for its active work, callbacks, and remote listeners to finish, then resume the Atom session.`
      const metadata: Metadata = { atomId: params.atom_id, runId: run, status: "busy", reason: err.reason }
      ctx.metadata({ title: "resume_agent", metadata })
      return { title: "resume_agent", metadata, output }
    }
  },
})
