import z from "zod"
import { linkKinds } from "@/research/research.sql"
import { Tool } from "./tool"
import { Database, eq } from "../storage/db"
import { AtomTable, ExperimentTable } from "../research/research.sql"
import { Research } from "../research/research"
import { traverseAtomGraph } from "./atom-graph-prompt/traversal"
import { buildPrompt } from "./atom-graph-prompt/builder"
import type { RelationType, AtomType } from "./atom-graph-prompt/types"

export const AtomGraphPromptTool = Tool.define("atom_graph_prompt", {
  description:
    "将 Atom Graph 转换为结构化 Prompt，支持多跳遍历和智能上下文选择。" +
    "借鉴 GraphRAG 的设计，生成适合 LLM 理解的研究上下文。",
  parameters: z.object({
    atomIds: z.array(z.string()).optional().describe("起始 Atom IDs，如果不提供则使用当前 session 绑定的 atom"),
    maxDepth: z.number().default(2).describe("最大遍历深度（跳数），默认 2"),
    maxAtoms: z.number().default(10).describe("最多返回的 Atom 数量，默认 10"),
    relationTypes: z
      .array(z.enum(linkKinds))
      .optional()
      .describe("只遍历指定类型的关系"),
    atomTypes: z
      .array(z.enum(["fact", "method", "theorem", "verification"]))
      .optional()
      .describe("只包含指定类型的 Atom"),
    template: z
      .enum(["graphrag", "compact"])
      .default("graphrag")
      .describe("Prompt 模板风格：graphrag（详细结构化）或 compact（简洁高效）"),
    includeEvidence: z.boolean().default(true).describe("是否包含 evidence 内容"),
    includeMetadata: z.boolean().default(true).describe("是否包含元数据（类型、距离、时间等）"),
  }),
  async execute(params, ctx) {
    // 1. 确定起始 atom IDs
    let seedAtomIds = params.atomIds

    if (!seedAtomIds || seedAtomIds.length === 0) {
      // 尝试从当前 session 获取绑定的 atom
      let parentSessionId = await Research.getParentSessionId(ctx.sessionID)
      if (!parentSessionId) {
        parentSessionId = ctx.sessionID
      }

      // 检查 session 是否直接绑定到 atom
      const boundAtom = Database.use((db) =>
        db.select().from(AtomTable).where(eq(AtomTable.session_id, parentSessionId)).get(),
      )

      if (boundAtom) {
        seedAtomIds = [boundAtom.atom_id]
      } else {
        // 检查是否是实验 session
        const experiment = Database.use((db) =>
          db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_session_id, parentSessionId)).get(),
        )

        if (experiment?.atom_id) {
          seedAtomIds = [experiment.atom_id]
        }
      }

      if (!seedAtomIds || seedAtomIds.length === 0) {
        return {
          title: "No atoms found",
          output: "No atom IDs provided and current session is not bound to any atom.",
          metadata: { atomCount: 0 } as any,
        }
      }
    }

    // 2. 遍历图
    const traversedAtoms = await traverseAtomGraph({
      seedAtomIds,
      maxDepth: params.maxDepth,
      maxAtoms: params.maxAtoms,
      relationTypes: params.relationTypes as RelationType[] | undefined,
      atomTypes: params.atomTypes as AtomType[] | undefined,
    })

    if (traversedAtoms.length === 0) {
      return {
        title: "No atoms found",
        output: "No atoms found matching the criteria.",
        metadata: { atomCount: 0 } as any,
      }
    }

    // 3. 构建 Prompt
    const prompt = buildPrompt(traversedAtoms, {
      template: params.template,
      includeEvidence: params.includeEvidence,
      includeMetadata: params.includeMetadata,
    })

    // 4. 返回结果
    return {
      title: `Generated prompt from ${traversedAtoms.length} atom(s)`,
      output: prompt,
      metadata: {
        atomCount: traversedAtoms.length,
        seedAtomIds: seedAtomIds as string[],
        maxDepth: params.maxDepth,
        template: params.template,
      } as any,
    }
  },
})
