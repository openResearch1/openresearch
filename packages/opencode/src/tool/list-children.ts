import z from "zod"
import { Collab } from "@/collab"
import { Tool } from "./tool"
import DESCRIPTION from "./list-children.txt"

const parameters = z.object({})

export const ListChildrenTool = Tool.define("list_children", async () => {
  return {
    description: DESCRIPTION,
    parameters,
    async execute(_params: z.infer<typeof parameters>, ctx) {
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
      const latest = Collab.listLatestProgress(parentNode.id)

      const rows = children.map((c) => ({
        agent_id: c.id,
        name: c.name,
        subagent_type: c.subagent_type,
        status: c.status,
        active_children: c.active_children,
        spawned_at: c.time_started ?? c.time_created,
        ended_at: c.time_ended ?? null,
        summary: c.result?.summary ?? null,
        latest_progress: latest[c.id] ?? null,
      }))

      const meta: { count: number; parentAgentId: string | null } = {
        count: rows.length,
        parentAgentId: parentNode.id,
      }
      return {
        title: "list_children",
        metadata: meta,
        output: JSON.stringify({ children: rows }, null, 2),
      }
    },
  }
})
