import z from "zod"

import { ResearchPath } from "@/research/research-path"
import { Tool } from "./tool"

const atom = z.object({
  atomId: z.string().describe("Atom ID from the current Research Project"),
  role: ResearchPath.Role.default("member").describe("Use seed for the Atom that initiated the direction"),
})

const parameters = z
  .object({
    action: z.enum(["read", "create", "update", "transition"]).describe("Research Path action to execute."),
    researchPathId: z
      .string()
      .optional()
      .describe("Research Path ID required by update and transition; optional for read to list every Path."),
    title: z.string().trim().min(1).optional().describe("Short Path title required by create."),
    brief: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Objective, scope, constraints, and intended approach required by create."),
    summary: z.string().trim().min(1).nullable().optional().describe("Progress or final outcome summary."),
    atoms: z.array(atom).default([]).describe("Initial attention subgraph membership for create."),
    addAtoms: z
      .array(atom)
      .default([])
      .describe("Atoms to add during update, or existing members whose role should change."),
    removeAtomIds: z.array(z.string()).default([]).describe("Atom IDs to remove during update."),
    status: z.enum(["completed", "cancelled"]).optional().describe("Terminal status required by transition."),
  })
  .superRefine((value, ctx) => {
    if (value.action === "create") {
      if (!value.title) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["title"], message: "title is required for create" })
      }
      if (!value.brief) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["brief"], message: "brief is required for create" })
      }
      if (value.summary === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["summary"], message: "summary cannot be null for create" })
      }
      return
    }

    if (value.action === "update") {
      if (!value.researchPathId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["researchPathId"],
          message: "researchPathId is required for update",
        })
      }
      return
    }

    if (value.action === "transition") {
      if (!value.researchPathId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["researchPathId"],
          message: "researchPathId is required for transition",
        })
      }
      if (!value.status) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "status is required for transition" })
      }
      if (value.summary === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["summary"],
          message: "summary cannot be null for transition",
        })
      }
    }
  })

export const ResearchPathTool = Tool.define("research_path", {
  description:
    "Read or maintain persistent Research Paths. A Path is the current attention subgraph for one research direction. " +
    "All project sessions may read Paths. Only the research agent in the creating main Research session may create, update, complete, or cancel one. " +
    "Verification stages are derived from the Atom graph; cycles are returned as iterative groups. " +
    "Cancelled Paths are permanent research history; start a new Path rather than restoring one.",
  parameters,
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
            title: params.title!,
            brief: params.brief!,
            summary: params.summary ?? undefined,
            atoms: params.atoms.map((item) => ({ atomID: item.atomId, role: item.role })),
          })
        : params.action === "update"
          ? await ResearchPath.update({
              sessionID: ctx.sessionID,
              agent: ctx.agent,
              researchPathID: params.researchPathId!,
              title: params.title,
              brief: params.brief,
              summary: params.summary,
              add: params.addAtoms.map((item) => ({ atomID: item.atomId, role: item.role })),
              remove: params.removeAtomIds,
            })
          : await ResearchPath.transition({
              sessionID: ctx.sessionID,
              agent: ctx.agent,
              researchPathID: params.researchPathId!,
              status: params.status!,
              summary: params.summary ?? undefined,
            })

    return {
      title: `${params.action === "transition" ? params.status : params.action}: ${result.title}`,
      output: JSON.stringify(result, null, 2),
      metadata: {},
    }
  },
})
