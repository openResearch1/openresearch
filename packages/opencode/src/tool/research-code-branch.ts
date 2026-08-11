import z from "zod"

import { CodeBranch } from "@/research/code-branch"
import { Research } from "@/research/research"

import { Tool } from "./tool"

export const ResearchCodeBranchQueryTool = Tool.define("research_code_branch_query", {
  description:
    "List local branches for a code root with each branch's HEAD SHA, latest commit subject and time. Use this before experiment_create to select and lock a baseline branch.",
  parameters: z.object({
    codeRoot: z.string().describe("Local Git code root returned by research_code_query."),
  }),
  async execute(params, ctx) {
    const research = await Research.getResearchProjectId(ctx.sessionID)
    if (!research) throw new Error("current session is not associated with any research project")
    const info = CodeBranch.experiments(await CodeBranch.list(params.codeRoot), research)
    return {
      title: `${info.branches.length} local branch(es)`,
      output: JSON.stringify(info, null, 2),
      metadata: info,
    }
  },
})
