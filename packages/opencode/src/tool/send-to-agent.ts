import z from "zod"
import { Collab } from "@/collab"
import { Tool } from "./tool"
import DESCRIPTION from "./send-to-agent.txt"

const parameters = z.object({
  agent_id: z.string(),
  text: z.string(),
})

export const SendToAgentTool = Tool.define("send_to_agent", async () => {
  return {
    description: DESCRIPTION,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const mk = (ok: boolean): { ok: boolean; agent_id: string } => ({ ok, agent_id: params.agent_id })

      const target = Collab.tryGet(params.agent_id)
      if (!target) {
        return { title: "send_to_agent", metadata: mk(false), output: `No agent ${params.agent_id}` }
      }

      const callerNode = Collab.getBySession(ctx.sessionID)
      if (!callerNode) {
        return {
          title: "send_to_agent",
          metadata: mk(false),
          output: "Caller session is not a Collab agent; spawn a child first.",
        }
      }
      if (target.root_agent_id !== callerNode.root_agent_id) {
        return {
          title: "send_to_agent",
          metadata: mk(false),
          output: `Permission denied: ${params.agent_id} is not in your subtree.`,
        }
      }

      await ctx.ask({
        permission: "send_to_agent",
        patterns: [params.agent_id],
        always: ["*"],
        metadata: {
          description: "send_to_agent",
          agent_id: params.agent_id,
        },
      })

      await Collab.sendUserInput(params.agent_id, { text: params.text })

      return {
        title: "send_to_agent",
        metadata: mk(true),
        output: `Posted ${params.text.length} chars to ${params.agent_id} inbox`,
      }
    },
  }
})
