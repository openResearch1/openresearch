import z from "zod"
import { Tool } from "./tool"
import { Database, eq } from "../storage/db"
import { Research } from "../research/research"
import { ArticleTable, AtomTable } from "../research/research.sql"

export const ResearchInfoTool = Tool.define("research_info", {
  description:
    "View the current research project information, including background path, goal path, macro table path, article count, and atom count.",
  parameters: z.object({}),
  async execute(_params, ctx) {
    const researchProjectId = await Research.getResearchProjectId(ctx.sessionID)
    if (!researchProjectId) {
      return {
        title: "No project",
        output: "Current session is not associated with any research project.",
        metadata: { found: false },
      }
    }

    const project = Research.getResearchProject(researchProjectId)
    if (!project) {
      return {
        title: "Not found",
        output: "Research project not found.",
        metadata: { found: false },
      }
    }

    const articles = Database.use((db) =>
      db.select().from(ArticleTable).where(eq(ArticleTable.research_project_id, researchProjectId)).all(),
    )

    const atoms = Database.use((db) =>
      db.select().from(AtomTable).where(eq(AtomTable.research_project_id, researchProjectId)).all(),
    )

    const lines = [
      `research_project_id: ${project.research_project_id}`,
      `project_id: ${project.project_id}`,
      `background_path: ${project.background_path ?? "(not set)"}`,
      `goal_path: ${project.goal_path ?? "(not set)"}`,
      `macro_table_path: ${project.macro_table_path ?? "(not set)"}`,
      `time_created: ${project.time_created}`,
      `time_updated: ${project.time_updated}`,
      "",
      `--- Articles (${articles.length}) ---`,
      ...articles.map((a) => `  [${a.article_id}] ${a.title ?? "(untitled)"} | status: ${a.status} | path: ${a.path}`),
      "",
      `--- Atoms (${atoms.length}) ---`,
      ...atoms.map(
        (a) => `  [${a.atom_id}] ${a.atom_name} | type: ${a.atom_type} | evidence: ${a.atom_evidence_status}`,
      ),
    ]

    return {
      title: `Research: ${researchProjectId}`,
      output: lines.join("\n"),
      metadata: { found: true },
    }
  },
})
