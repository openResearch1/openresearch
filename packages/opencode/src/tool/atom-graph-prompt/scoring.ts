import type { TraversedAtom } from "./types"
import { cosineSimilarity } from "./embedding"

/**
 * 评分权重配置
 */
export interface ScoringWeights {
  distance: number // 图距离权重
  type: number // Atom 类型权重
  semantic: number // 语义相似度权重
  temporal: number // 时间新近度权重
  relationChain: number // 关系链质量权重
}

/**
 * 默认权重
 */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  distance: 0.25,
  type: 0.2,
  semantic: 0.3,
  temporal: 0.15,
  relationChain: 0.1,
}

/**
 * Atom 类型的基础分数
 */
const TYPE_SCORES = {
  theorem: 10, // 理论最重要
  method: 8,
  verification: 6,
  fact: 4,
} as const

/**
 * 关系类型的质量分数
 */
const RELATION_SCORES = {
  evaluated_by: 10, // 验证关系最重要
  analyzed_by: 9,
  derives: 8,
  grounds: 7,
  formalized_by: 7,
  motivates: 6,
  contradicts: 5, // 矛盾也很重要
  other: 3,
} as const

/**
 * 为单个 atom 计算综合分数
 */
export function scoreAtom(
  atom: TraversedAtom,
  queryEmbedding: number[] | null,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): number {
  let totalScore = 0

  // 1. 距离分数（越近越好）
  // 距离为 0 得 10 分，距离为 1 得 5 分，距离为 2 得 3.33 分
  const distanceScore = (1 / (atom.distance + 1)) * 10
  totalScore += weights.distance * distanceScore

  // 2. 类型分数
  const typeScore = TYPE_SCORES[atom.atom.atom_type] || 0
  totalScore += weights.type * typeScore

  // 3. 关系链分数（基于路径中关系的质量）
  let relationScore = 0
  if (atom.relationChain.length > 0) {
    const avgRelationScore =
      atom.relationChain.reduce((sum, relType) => {
        return sum + (RELATION_SCORES[relType] || 0)
      }, 0) / atom.relationChain.length
    relationScore = avgRelationScore
  } else {
    relationScore = 10 // 起始节点给满分
  }
  totalScore += weights.relationChain * relationScore

  // 4. 语义相似度分数（如果提供了查询向量）
  if (queryEmbedding && atom.claimEmbedding) {
    const similarity = cosineSimilarity(queryEmbedding, atom.claimEmbedding)
    const semanticScore = (similarity + 1) * 5 // 归一化到 0-10
    totalScore += weights.semantic * semanticScore
  }

  // 5. 时间新近度分数
  const now = Date.now()
  const ageInDays = (now - atom.atom.time_created) / (1000 * 60 * 60 * 24)
  // 最近 7 天得 10 分，30 天得 5 分，90 天以上得 1 分
  let temporalScore = 10
  if (ageInDays > 7) {
    temporalScore = Math.max(1, 10 - (ageInDays - 7) / 10)
  }
  totalScore += weights.temporal * temporalScore

  return totalScore
}

/**
 * 为多个 atoms 批量计算分数并排序
 */
export function scoreAndRankAtoms(
  atoms: TraversedAtom[],
  queryEmbedding: number[] | null,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): Array<TraversedAtom & { score: number }> {
  const scored = atoms.map((atom) => ({
    ...atom,
    score: scoreAtom(atom, queryEmbedding, weights),
  }))

  // 按分数降序排序
  scored.sort((a, b) => b.score - a.score)

  return scored
}

/**
 * 根据分数和多样性选择 atoms
 *
 * 使用 MMR (Maximal Marginal Relevance) 算法平衡相关性和多样性
 */
export function selectDiverseAtoms(
  scoredAtoms: Array<TraversedAtom & { score: number }>,
  maxCount: number,
  diversityWeight: number = 0.3,
): Array<TraversedAtom & { score: number }> {
  if (scoredAtoms.length <= maxCount) {
    return scoredAtoms
  }

  const selected: Array<TraversedAtom & { score: number }> = []
  const remaining = [...scoredAtoms]

  // 1. 选择分数最高的作为第一个
  selected.push(remaining.shift()!)

  // 2. 迭代选择剩余的
  while (selected.length < maxCount && remaining.length > 0) {
    let bestIdx = 0
    let bestScore = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]

      // 计算与已选择 atoms 的最小距离（多样性）
      let minDiversity = Infinity
      for (const selectedAtom of selected) {
        // 使用类型和距离作为多样性指标
        const typeDiff = candidate.atom.atom_type === selectedAtom.atom.atom_type ? 0 : 1
        const distDiff = Math.abs(candidate.distance - selectedAtom.distance)
        const diversity = typeDiff + distDiff * 0.5
        minDiversity = Math.min(minDiversity, diversity)
      }

      // MMR 分数 = (1 - λ) * relevance + λ * diversity
      const mmrScore = (1 - diversityWeight) * candidate.score + diversityWeight * minDiversity * 2

      if (mmrScore > bestScore) {
        bestScore = mmrScore
        bestIdx = i
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0])
  }

  return selected
}

/**
 * 解释分数组成（用于调试和可解释性）
 */
export function explainScore(
  atom: TraversedAtom,
  queryEmbedding: number[] | null,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): {
  total: number
  breakdown: {
    distance: number
    type: number
    semantic: number
    temporal: number
    relationChain: number
  }
} {
  const distanceScore = (1 / (atom.distance + 1)) * 10
  const typeScore = TYPE_SCORES[atom.atom.atom_type] || 0

  let relationScore = 0
  if (atom.relationChain.length > 0) {
    relationScore =
      atom.relationChain.reduce((sum, relType) => {
        return sum + (RELATION_SCORES[relType] || 0)
      }, 0) / atom.relationChain.length
  } else {
    relationScore = 10
  }

  let semanticScore = 0
  if (queryEmbedding && atom.claimEmbedding) {
    const similarity = cosineSimilarity(queryEmbedding, atom.claimEmbedding)
    semanticScore = (similarity + 1) * 5
  }

  const now = Date.now()
  const ageInDays = (now - atom.atom.time_created) / (1000 * 60 * 60 * 24)
  let temporalScore = 10
  if (ageInDays > 7) {
    temporalScore = Math.max(1, 10 - (ageInDays - 7) / 10)
  }

  return {
    total: scoreAtom(atom, queryEmbedding, weights),
    breakdown: {
      distance: weights.distance * distanceScore,
      type: weights.type * typeScore,
      semantic: weights.semantic * semanticScore,
      temporal: weights.temporal * temporalScore,
      relationChain: weights.relationChain * relationScore,
    },
  }
}
