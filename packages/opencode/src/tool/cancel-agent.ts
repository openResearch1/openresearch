import z from "zod"
import { Collab } from "@/collab"
import { CollabAgentNode } from "@/collab/agent-node"
import { Tool } from "./tool"
import DESCRIPTION from "./cancel-agent.txt"

const parameters = z.object({
  agent_id: z.string(),
  reason: z.string().optional(),
})

export const CancelAgentTool = Tool.define("cancel_agent", async () => {
  return {
    description: DESCRIPTION,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const mk = (ok: boolean): { ok: boolean; agent_id: string } => ({ ok, agent_id: params.agent_id })

      let target = Collab.tryGet(params.agent_id)
      if (!target) {
        return { title: "cancel_agent", metadata: mk(false), output: `No agent ${params.agent_id}` }
      }

      const callerNode = Collab.getBySession(ctx.sessionID)
      if (!callerNode) {
        return {
          title: "cancel_agent",
          metadata: mk(false),
          output: "Caller session is not a Collab agent; cannot cancel other agents.",
        }
      }
      if (!Collab.isAncestor(callerNode.id, target.id)) {
        return {
          title: "cancel_agent",
          metadata: mk(false),
          output: `Permission denied: ${params.agent_id} is not in your subtree.`,
        }
      }

      await ctx.ask({
        permission: "cancel_agent",
        patterns: [params.agent_id],
        always: ["*"],
        metadata: {
          description: params.reason ?? "cancel requested",
          agent_id: params.agent_id,
        },
      })

      target = Collab.tryGet(params.agent_id)
      if (!target || !Collab.isAncestor(callerNode.id, target.id)) {
        return {
          title: "cancel_agent",
          metadata: mk(false),
          output: `Permission denied: ${params.agent_id} is no longer in your subtree.`,
        }
      }

      await Collab.cancel(params.agent_id, params.reason, {
        parentAgentId: target.parent_agent_id,
        runId: target.run_id,
        lifecycle: CollabAgentNode.lifecycle(target.spec),
      })

      return {
        title: "cancel_agent",
        metadata: mk(true),
        output: `Requested cancel for ${params.agent_id}${params.reason ? `: ${params.reason}` : ""}`,
      }
    },
  }
})
