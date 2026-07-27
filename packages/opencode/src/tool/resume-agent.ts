import z from "zod"
import { Collab } from "@/collab"
import { Tool } from "./tool"
import DESCRIPTION from "./resume-agent.txt"

const parameters = z.object({
  agent_id: z.string().describe("The id of the waiting/completed/failed/canceled peer to resume"),
  prompt: z.string().describe("The new instruction to deliver to the resumed peer"),
})

export const ResumeAgentTool = Tool.define("resume_agent", async () => {
  return {
    description: DESCRIPTION,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const mk = (
        ok: boolean,
        extra?: { status?: string; session_id?: string },
      ): { ok: boolean; agent_id: string; status?: string; session_id?: string } => ({
        ok,
        agent_id: params.agent_id,
        ...(extra?.status ? { status: extra.status } : {}),
        ...(extra?.session_id ? { session_id: extra.session_id } : {}),
      })

      let target = Collab.tryGet(params.agent_id)
      if (!target) {
        return { title: "resume_agent", metadata: mk(false), output: `No agent ${params.agent_id}` }
      }

      const callerNode = Collab.getBySession(ctx.sessionID)
      if (!callerNode) {
        return {
          title: "resume_agent",
          metadata: mk(false),
          output: "Caller session is not a Collab agent; spawn a peer first.",
        }
      }
      target =
        (await import("@/research/experiment-agent").then((mod) => mod.ExperimentAgent.recover(params.agent_id))) ??
        target
      if (target.root_agent_id !== callerNode.root_agent_id) {
        const atomId = target.spec.metadata?.atomId
        if (typeof atomId === "string" && atomId === callerNode.spec.metadata?.atomId) {
          return {
            title: "resume_agent",
            metadata: mk(false, { status: target.status, session_id: target.session_id }),
            output: `Experiment agent ${params.agent_id} is still finishing reconciliation with its Atom. Retry this same agent; do not spawn a replacement.`,
          }
        }
        return {
          title: "resume_agent",
          metadata: mk(false),
          output: `Permission denied: ${params.agent_id} is not in your subtree.`,
        }
      }

      await ctx.ask({
        permission: "resume_agent",
        patterns: [params.agent_id],
        always: ["*"],
        metadata: {
          description: "resume_agent",
          agent_id: params.agent_id,
        },
      })

      try {
        const current = ctx.extra?.model as { providerID?: string; id?: string } | undefined
        const info = await Collab.resume({
          agentId: params.agent_id,
          prompt: params.prompt,
          model: current?.providerID && current.id ? { providerID: current.providerID, modelID: current.id } : undefined,
        })
        return {
          title: "resume_agent",
          metadata: mk(true, { status: info.status, session_id: info.session_id }),
          output: [
            `agent_id: ${info.id}`,
            `session_id: ${info.session_id}`,
            `status: ${info.status}`,
            "",
            "Queued. You will receive a new `child_done` message when the peer finishes the additional turn.",
          ].join("\n"),
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          title: "resume_agent",
          metadata: mk(false),
          output: `Resume failed: ${msg}`,
        }
      }
    },
  }
})
