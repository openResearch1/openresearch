import z from "zod"

import { ResearchResult } from "@/research/research-result"
import { Tool } from "./tool"

export const ResearchResultQueryTool = Tool.define("research_result_query", {
  description: "List accepted Research Results in the current project, or read one result by ID.",
  parameters: z.object({
    resultId: z.string().optional().describe("Accepted Research Result ID. Omit to list all results."),
  }),
  async execute(params, ctx) {
    const researchProjectID = await ResearchResult.project(ctx.sessionID)
    if (!researchProjectID) throw new Error("Current Session is not part of a Research Project")
    const result = params.resultId
      ? ResearchResult.get(researchProjectID, params.resultId)
      : ResearchResult.list(researchProjectID)
    if (params.resultId && !result) throw new Error("Research Result not found")
    return {
      title: params.resultId ? "Research Result" : "Research Results",
      output: JSON.stringify(result, null, 2),
      metadata: { count: Array.isArray(result) ? result.length : 1 },
    }
  },
})

export const ResearchResultSubmitTool = Tool.define("research_result_submit", {
  description:
    "Accept and submit the exact proven Atom subset assigned to this Reviewer as a project Research Result. " +
    "Only a delegated Reviewer may call this tool, and only after independently checking every claim and its evidence. " +
    "The submitted Atoms are locked after acceptance.",
  parameters: z.object({
    atomIds: z.array(z.string()).min(1).describe("The exact Atom IDs supplied for this review."),
    title: z.string().trim().min(1).describe("Concise title for the accepted result."),
    summary: z.string().trim().min(1).describe("Markdown synthesis of the accepted scientific result."),
    evaluation: z
      .string()
      .trim()
      .min(1)
      .describe("Markdown Reviewer evaluation explaining why this Atom subset is a meaningful result."),
  }),
  async execute(params, ctx) {
    const result = await ResearchResult.submit({
      sessionID: ctx.sessionID,
      agent: ctx.agent,
      atomIDs: params.atomIds,
      title: params.title,
      summary: params.summary,
      evaluation: params.evaluation,
    })
    return {
      title: `Accepted result: ${result.title}`,
      output: JSON.stringify(result, null, 2),
      metadata: { resultId: result.research_result_id, atomCount: result.atoms.length },
    }
  },
})
