import type { AtomTable, AtomRelationTable } from "../../research/research.sql"

export type AtomRow = typeof AtomTable.$inferSelect
export type AtomRelationRow = typeof AtomRelationTable.$inferSelect

export type AtomType = "fact" | "method" | "theorem" | "verification"
export type RelationType = "motivates" | "formalizes" | "derives" | "analyzes" | "validates" | "contradicts" | "other"

export interface TraversalOptions {
  seedAtomIds: string[]
  maxDepth: number
  maxAtoms?: number
  relationTypes?: RelationType[]
  atomTypes?: AtomType[]
}

export interface TraversedAtom {
  atom: AtomRow
  claim: string
  evidence: string
  distance: number
  path: string[]
  relationChain: RelationType[]
  claimEmbedding?: number[] // Optional: for semantic search (Phase 2)
}

export interface RankedAtom extends TraversedAtom {
  score: number
  baseScore?: number
  atomQuality?: number
  queryOverlap?: number
}

export interface AtomwiseOptions {
  enabled?: boolean
  baseWeight?: number
  qualityWeight?: number
  overlapWeight?: number
}

export interface PromptBuilderOptions {
  template: "graphrag" | "compact"
  includeEvidence: boolean
  includeMetadata: boolean
}

export interface AtomContent {
  claim: string
  evidence: string
}

// Phase 3: Community Detection Types
export interface Community {
  id: string
  atomIds: string[]
  summary: string
  keywords: string[]
  dominantType: AtomType
  size: number
  density: number
  timestamp: number
}

export interface CommunityFilterOptions {
  communityIds?: string[]
  minCommunitySize?: number
  maxCommunitySize?: number
  dominantTypes?: AtomType[]
}

export interface CommunityPruneOptions {
  minSize?: number
  minDensity?: number
  minInternalEdges?: number
  minKeywords?: number
  maxHubRatio?: number
  forceRefresh?: boolean
}

export interface CommunityPruneMetrics {
  size: number
  density: number
  internalEdges: number
  maxEdges: number
  keywordCount: number
  hubRatio: number
}

export interface PrunedCommunity {
  community: Community
  pruned: boolean
  reasons: string[]
  metrics: CommunityPruneMetrics
}

export interface CommunityPruneResult {
  kept: Community[]
  removed: PrunedCommunity[]
  decisions: PrunedCommunity[]
}

export interface CommunityPruneSummary {
  beforeNodes: number
  afterNodes: number
  beforeCommunities: number
  afterCommunities: number
  beforeScore: number
  afterScore: number
}

export interface AtomQualityMetrics {
  degree: number
  degreeScore: number
  bridgeCommunities: number
  bridgeScore: number
  communityScore: number
  evidenceScore: number
  informationScore: number
  score: number
}

export interface GraphQualityReport {
  structure: {
    totalCommunities: number
    avgCommunitySize: number
    avgDensity: number
    isolatedAtomRatio: number
    bridgeAtomRatio: number
  }
  semantic: {
    intraCommunitySimilarity: number
    interCommunitySeparation: number
    summaryCoherence: number
    keywordUniqueness: number
  }
  research: {
    typeCoverage: number
    evidenceCoverage: number
    verificationCoverage: number
    contradictionExposure: number
  }
  stability: {
    pruneRetentionRatio: number
    relationSuggestionConfidence: number
    extensionSuggestionConfidence: number
  }
}

export interface ArticleCommunityComparisonBreakdown {
  semantic: number
  type: number
  evidence: number
  relation: number
  flow: number
  structure: number
  keywords: number
}

export interface ArticleCommunityMatch {
  sourceCommunityId: string
  targetCommunityId: string | null
  sourceSize: number
  targetSize: number | null
  sourceWeight: number
  targetWeight: number | null
  score: number
  breakdown: ArticleCommunityComparisonBreakdown
}

export interface ArticleCommunityDirection {
  articleId: string
  score: number
  coverage: number
  matches: ArticleCommunityMatch[]
}

export interface ArticleCommunitySummary {
  articleId: string
  atomCount: number
  communityCount: number
}

export interface ArticleCommunityComparisonReport {
  articleIds: [string, string]
  similarity: number
  threshold: number
  articles: {
    left: ArticleCommunitySummary
    right: ArticleCommunitySummary
  }
  communities: {
    left: Community[]
    right: Community[]
  }
  directional: {
    leftToRight: ArticleCommunityDirection
    rightToLeft: ArticleCommunityDirection
  }
}
