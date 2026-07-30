import z from "zod"
import { linkKinds } from "@/research/research.sql"
import { Tool } from "./tool"
import { Database, eq } from "../storage/db"
import { AtomTable, ExperimentTable } from "../research/research.sql"
import { Research } from "../research/research"
import { buildPrompt } from "./atom-graph-prompt/builder"
import type { RelationType, AtomType } from "./atom-graph-prompt/types"
import { hybridSearch, graphOnlySearch } from "./atom-graph-prompt/hybrid"
import { DEFAULT_WEIGHTS } from "./atom-graph-prompt/scoring"
import { estimatePromptTokens } from "./atom-graph-prompt/token-budget"

/**
 * Phase 2 增强版：支持语义搜索和智能选择
 */
export const AtomGraphPromptSmartTool = Tool.define("atom_graph_prompt_smart", {
  description:
    "智能 Atom Graph Prompt 生成工具（Phase 2）。" +
    "支持自然语言查询、语义搜索、智能评分和 Token 预算管理。" +
    "可以通过自然语言查询找到相关的研究内容，并智能选择最相关的 atoms。",
  parameters: z.object({
    // 查询方式（二选一）
    query: z.string().optional().describe("自然语言查询，用于语义搜索相关的 atoms。例如：'如何提升模型收敛速度？'"),
    atomIds: z
      .array(z.string())
      .optional()
      .describe("起始 Atom IDs（可选）。如果提供了 query，会从语义搜索结果开始；否则从这些 IDs 开始"),

    // 图遍历参数
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

    // 语义搜索参数
    semanticTopK: z.number().default(5).describe("语义搜索返回的 top K atoms，默认 5"),
    semanticThreshold: z.number().default(0.5).describe("语义相似度阈值（0-1），默认 0.5"),

    // 智能选择参数
    diversityWeight: z.number().default(0.3).describe("多样性权重（0-1），默认 0.3。越高越倾向选择不同类型的 atoms"),
    scoringWeights: z
      .object({
        distance: z.number().default(0.25),
        type: z.number().default(0.2),
        semantic: z.number().default(0.3),
        temporal: z.number().default(0.15),
        relationChain: z.number().default(0.1),
      })
      .optional()
      .describe("评分权重配置（可选）"),

    // Phase 3: 社区过滤参数
    communityIds: z.array(z.string()).optional().describe("只包含指定社区 ID 中的 atoms"),
    minCommunitySize: z.number().optional().describe("只包含社区大小 >= 此值的 atoms"),
    maxCommunitySize: z.number().optional().describe("只包含社区大小 <= 此值的 atoms"),
    communityDominantTypes: z
      .array(z.enum(["fact", "method", "theorem", "verification"]))
      .optional()
      .describe("只包含主导类型为指定类型的社区中的 atoms"),

    // Token 预算
    maxTokens: z.number().optional().describe("最大 token 数量限制（可选）。如果指定，会自动调整内容以适应预算"),

    // Prompt 配置
    template: z
      .enum(["graphrag", "compact"])
      .default("graphrag")
      .describe("Prompt 模板风格：graphrag（详细结构化）或 compact（简洁高效）"),
    includeEvidence: z.boolean().default(true).describe("是否包含 evidence 内容"),
    includeMetadata: z.boolean().default(true).describe("是否包含元数据（类型、距离、时间等）"),
  }),
  async execute(params, ctx) {
    // 1. 确定起始 atom IDs（如果没有提供 query 且没有 atomIds）
    let seedAtomIds = params.atomIds

    if (!params.query && (!seedAtomIds || seedAtomIds.length === 0)) {
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
          output: "No query or atom IDs provided, and current session is not bound to any atom.",
          metadata: { atomCount: 0 } as any,
        }
      }
    }

    // 2. 执行混合检索
    const searchResult = await hybridSearch({
      query: params.query,
      seedAtomIds,
      maxDepth: params.maxDepth,
      relationTypes: params.relationTypes as RelationType[] | undefined,
      atomTypes: params.atomTypes as AtomType[] | undefined,
      semanticTopK: params.semanticTopK,
      semanticThreshold: params.semanticThreshold,
      communityFilter:
        params.communityIds || params.minCommunitySize || params.maxCommunitySize || params.communityDominantTypes
          ? {
              communityIds: params.communityIds,
              minCommunitySize: params.minCommunitySize,
              maxCommunitySize: params.maxCommunitySize,
              dominantTypes: params.communityDominantTypes as AtomType[] | undefined,
            }
          : undefined,
      maxAtoms: params.maxAtoms,
      diversityWeight: params.diversityWeight,
      scoringWeights: params.scoringWeights || DEFAULT_WEIGHTS,
      maxTokens: params.maxTokens,
      includeEvidence: params.includeEvidence,
      includeMetadata: params.includeMetadata,
    })

    if (searchResult.atoms.length === 0) {
      return {
        title: "No atoms found",
        output: "No atoms found matching the criteria.",
        metadata: {
          atomCount: 0,
          totalFound: searchResult.metadata.totalFound,
        } as any,
      }
    }

    // 3. 构建 Prompt
    const prompt = buildPrompt(searchResult.atoms, {
      template: params.template,
      includeEvidence: params.includeEvidence,
      includeMetadata: params.includeMetadata,
    })

    // 4. 计算实际使用的 tokens
    const estimatedTokens = estimatePromptTokens(
      searchResult.atoms,
      params.template,
      params.includeEvidence,
      params.includeMetadata,
    )

    // 5. 返回结果
    return {
      title: `Generated prompt from ${searchResult.atoms.length} atom(s)${params.query ? " (semantic search)" : ""}`,
      output: prompt,
      metadata: {
        atomCount: searchResult.atoms.length,
        totalFound: searchResult.metadata.totalFound,
        fromSemanticSearch: searchResult.metadata.fromSemanticSearch,
        fromGraphTraversal: searchResult.metadata.fromGraphTraversal,
        seedAtomIds: seedAtomIds as string[] | undefined,
        query: params.query,
        maxDepth: params.maxDepth,
        template: params.template,
        estimatedTokens,
        tokensUsed: searchResult.metadata.tokensUsed,
        budgetUsed: searchResult.metadata.budgetUsed,
        topScores: searchResult.atoms.slice(0, 5).map((a) => ({
          atomId: a.atom.atom_id,
          atomName: a.atom.atom_name,
          score: a.score.toFixed(2),
        })),
      } as any,
    }
  },
})
