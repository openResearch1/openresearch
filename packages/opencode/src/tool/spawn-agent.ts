import z from "zod"
import { Agent } from "@/agent/agent"
import { Collab } from "@/collab"
import { AgentPolicySchema, type AgentSpec } from "@/collab/types"
import { MessageV2 } from "@/session/message-v2"
import { PermissionNext } from "@/permission/next"
import { Tool } from "./tool"
import DESCRIPTION from "./spawn-agent.txt"

const parameters = z.object({
  agent_type: z.string().describe("Name of the agent to spawn (any registered agent type, primary or subagent)"),
  name: z.string().describe("Short, human-readable task name"),
  prompt: z.string().describe("Initial prompt for the spawned agent"),
  model: z
    .object({
      providerID: z.string(),
      modelID: z.string(),
    })
    .optional(),
  policy: AgentPolicySchema.optional(),
})

export const SpawnAgentTool = Tool.define("spawn_agent", async (ctx) => {
  // Dynamically inject the list of agents the caller can spawn into the tool
  // description, similar to the `task` tool. We include ALL agent types
  // (primary + subagent + all) because this framework is for general-purpose
  // multi-agent collaboration, not restricted to one-shot subtask calls.
  const all = await Agent.list()
  const visible = all.filter((a) => a.hidden !== true)
  const caller = ctx?.agent
  const accessible = caller
    ? visible.filter((a) => PermissionNext.evaluate("spawn_agent", a.name, caller.permission).action !== "deny")
    : visible

  const agentList = accessible
    .map((a) => `- \`${a.name}\` [${a.mode}]: ${a.description ?? "(no description)"}`)
    .join("\n")

  const description = DESCRIPTION.replace("{agents}", agentList || "- (none currently accessible)")

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      await ctx.ask({
        permission: "spawn_agent",
        patterns: [params.agent_type],
        always: ["*"],
        metadata: {
          description: params.name,
          agent_type: params.agent_type,
        },
      })

      const agent = await Agent.get(params.agent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.agent_type}`)

      // Make sure the current primary session is a Collab root if it is not yet.
      const parentNode = Collab.getBySession(ctx.sessionID)
      if (!parentNode) {
        await Collab.ensureRootFromSession(ctx.sessionID, {
          name: "root",
          subagentType: ctx.agent,
          spec: { initialPrompt: "" },
        })
      }

      // Model resolution order (mirrors the `task` tool):
      //   1. explicit params.model from the LLM
      //   2. target agent's configured agent.model
      //   3. parent turn's model (read off the current assistant message)
      // Never fall through to Provider.defaultModel() — that's what caused the
      // bug where Opus parents spawned GPT children.
      const parentMsg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (parentMsg.info.role !== "assistant") throw new Error("spawn_agent called outside an assistant turn")
      const inheritedModel = {
        providerID: parentMsg.info.providerID,
        modelID: parentMsg.info.modelID,
      }
      const resolvedModel = params.model ?? agent.model ?? inheritedModel

      const spec: AgentSpec = {
        initialPrompt: params.prompt,
        model: resolvedModel,
        policy: params.policy,
      }

      const info = await Collab.spawn({
        parentSessionId: ctx.sessionID,
        name: params.name,
        subagentType: params.agent_type,
        spec,
      })

      ctx.metadata({
        title: params.name,
        metadata: {
          agentId: info.id,
          sessionId: info.session_id,
          agentType: info.subagent_type,
        },
      })

      return {
        title: params.name,
        metadata: {
          agentId: info.id,
          sessionId: info.session_id,
          agentType: info.subagent_type,
        },
        output: [
          `agent_id: ${info.id}`,
          `session_id: ${info.session_id}`,
          `status: ${info.status}`,
          "",
          "IMPORTANT — the spawned agent is now running asynchronously in the background.",
          "YOU MUST END YOUR TURN NOW. The framework will automatically re-invoke your LLM",
          "with a `child_done` message as soon as the peer completes — you do not need to",
          "poll, wait, or do anything else. Specifically:",
          "  - DO NOT call `list_children` to check status.",
          "  - DO NOT call `bash sleep` or any other waiting workaround.",
          "  - DO NOT keep producing text or tool calls in this turn hoping to 'wait'.",
          "Just stop. You will be re-woken with the result.",
          "",
          "If the eventual `child_done` summary is truncated (has a `[truncated]` marker)",
          "and you need the full text, call `read_agent_output(agent_id)` AFTER you've",
          "been re-woken — not during this turn.",
        ].join("\n"),
      }
    },
  }
})
