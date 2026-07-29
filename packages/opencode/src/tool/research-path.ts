import z from "zod"

import { ResearchPath } from "@/research/research-path"
import { Tool } from "./tool"

const atom = z.object({
  atomId: z.string().describe("Atom ID from the current Research Project"),
  role: ResearchPath.Role.default("member").describe("Use seed for the Atom that initiated the direction"),
})

export const ResearchPathTool = Tool.define("research_path", {
  description:
    "Read or maintain persistent Research Paths. A Path is the current attention subgraph for one research direction. " +
    "All project sessions may read Paths. Only the research agent in the creating main Research session may create, update, complete, or cancel one. " +
    "Verification stages are derived from the Atom graph; cycles are returned as iterative groups. " +
    "Cancelled Paths are permanent research history; start a new Path rather than restoring one.",
  parameters: z.discriminatedUnion("action", [
    z.object({
      action: z.literal("read"),
      researchPathId: z.string().optional().describe("Omit to list every Path in the current Research Project"),
    }),
    z.object({
      action: z.literal("create"),
      title: z.string().trim().min(1).describe("Short name for the research direction"),
      brief: z.string().trim().min(1).describe("Objective, scope, constraints, and intended research approach"),
      summary: z.string().trim().min(1).optional().describe("Optional initial progress summary"),
      atoms: z.array(atom).default([]).describe("Initial attention subgraph membership"),
    }),
    z.object({
      action: z.literal("update"),
      researchPathId: z.string(),
      title: z.string().trim().min(1).optional(),
      brief: z.string().trim().min(1).optional(),
      summary: z.string().trim().min(1).nullable().optional(),
      addAtoms: z.array(atom).default([]).describe("Atoms to add, or existing members whose role should change"),
      removeAtomIds: z.array(z.string()).default([]),
    }),
    z.object({
      action: z.literal("transition"),
      researchPathId: z.string(),
      status: z.enum(["completed", "cancelled"]),
      summary: z.string().trim().min(1).optional().describe("Final conclusion, progress, or failure experience"),
    }),
  ]),
  async execute(params, ctx) {
    if (params.action === "read") {
      const researchProjectID = await ResearchPath.project(ctx.sessionID)
      if (!researchProjectID) throw new Error("Current Session is not part of a Research Project")
      const result = params.researchPathId
        ? ResearchPath.get(researchProjectID, params.researchPathId)
        : ResearchPath.list(researchProjectID)
      if (params.researchPathId && !result) throw new Error("Research Path not found")
      return {
        title: params.researchPathId ? "Research Path" : "Research Paths",
        output: JSON.stringify(result, null, 2),
        metadata: {},
      }
    }

    const result =
      params.action === "create"
        ? await ResearchPath.create({
            sessionID: ctx.sessionID,
            agent: ctx.agent,
            title: params.title,
            brief: params.brief,
            summary: params.summary,
            atoms: params.atoms.map((item) => ({ atomID: item.atomId, role: item.role })),
          })
        : params.action === "update"
          ? await ResearchPath.update({
              sessionID: ctx.sessionID,
              agent: ctx.agent,
              researchPathID: params.researchPathId,
              title: params.title,
              brief: params.brief,
              summary: params.summary,
              add: params.addAtoms.map((item) => ({ atomID: item.atomId, role: item.role })),
              remove: params.removeAtomIds,
            })
          : await ResearchPath.transition({
              sessionID: ctx.sessionID,
              agent: ctx.agent,
              researchPathID: params.researchPathId,
              status: params.status,
              summary: params.summary,
            })

    return {
      title: `${params.action === "transition" ? params.status : params.action}: ${result.title}`,
      output: JSON.stringify(result, null, 2),
      metadata: {},
    }
  },
})
