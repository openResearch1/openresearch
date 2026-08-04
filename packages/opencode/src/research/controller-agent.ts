import { Collab } from "@/collab"
import { CollabAgentNode } from "@/collab/agent-node"
import { Agent } from "@/agent/agent"
import { Instance } from "@/project/instance"
import { Session } from "@/session"

export namespace ControllerAgent {
  export function list() {
    return CollabAgentNode.loadByProject(Instance.project.id).filter(
      (agent) =>
        agent.subagent_type === "controller" && !agent.parent_agent_id && agent.root_agent_id === agent.id,
    )
  }

  export function get(sessionId: string) {
    const agent = CollabAgentNode.loadBySessionId(sessionId)
    if (!agent) return
    if (agent.subagent_type !== "controller" || agent.parent_agent_id || agent.root_agent_id !== agent.id) return
    return agent
  }

  export async function create(researchProjectId: string) {
    if (!(await Agent.get("controller"))) throw new Error("Controller agent is unavailable")
    const session = await Session.create({})
    const agent = await Collab.ensureRootFromSession(session.id, {
      name: "Controller",
      subagentType: "controller",
      spec: {
        initialPrompt: "",
        policy: { on_fail: "continue" },
        metadata: { researchProjectId, controllerRole: "controller" },
      },
    }).catch(async (error) => {
      await Session.remove(session.id).catch(() => {})
      throw error
    })
    if (agent.subagent_type !== "controller" || agent.parent_agent_id || agent.root_agent_id !== agent.id) {
      await Session.remove(session.id).catch(() => {})
      throw new Error("Failed to create Controller root")
    }
    return { session, agent }
  }
}
