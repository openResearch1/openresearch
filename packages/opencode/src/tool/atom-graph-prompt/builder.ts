import type { TraversedAtom, PromptBuilderOptions, Community } from "./types"
import { Database, eq } from "../../storage/db"
import { AtomRelationTable, normalizeLinks } from "../../research/research.sql"

/**
 * 构建 GraphRAG 风格的 Prompt
 */
export function buildPrompt(atoms: TraversedAtom[], options: PromptBuilderOptions): string {
  if (options.template === "graphrag") {
    return buildGraphRAGPrompt(atoms, options)
  } else {
    return buildCompactPrompt(atoms, options)
  }
}

/**
 * GraphRAG 风格模板
 */
function buildGraphRAGPrompt(atoms: TraversedAtom[], options: PromptBuilderOptions): string {
  const sections: string[] = []

  // 标题
  sections.push("# Research Context Graph")
  sections.push("")
  sections.push("You are analyzing a research project with the following knowledge atoms:")
  sections.push("")

  // Atoms 部分
  sections.push("## Atoms (Knowledge Units)")
  sections.push("")

  atoms.forEach((atom, index) => {
    sections.push(`### Atom ${index + 1}: ${atom.atom.atom_name} [${atom.atom.atom_type}]`)
    sections.push("")
    sections.push("**Claim:**")
    sections.push(atom.claim || "(No claim available)")
    sections.push("")

    if (options.includeEvidence && atom.evidence) {
      sections.push("**Evidence:**")
      sections.push(atom.evidence)
      sections.push("")
    }

    if (options.includeMetadata) {
      sections.push("**Metadata:**")
      sections.push(`- Type: ${atom.atom.atom_type}`)
      sections.push(`- Distance from query: ${atom.distance} hops`)
      sections.push(`- Created: ${new Date(atom.atom.time_created).toISOString()}`)
      sections.push("")
    }
  })

  // 关系部分
  const relationships = extractRelationships(atoms)
  if (relationships.length > 0) {
    sections.push("## Relationships")
    sections.push("")
    relationships.forEach((rel) => {
      sections.push(`- ${rel.sourceName} --[${rel.relationType}]--> ${rel.targetName}`)
    })
    sections.push("")
  }

  // 指令部分
  sections.push("## Instructions")
  sections.push("")
  sections.push("Based on the above research context graph, please analyze the relationships")
  sections.push("between atoms and their types (fact/method/theorem/verification).")
  sections.push("Consider how facts motivate or ground downstream work, methods are analyzed by theorems,")
  sections.push("and methods or theorems are evaluated by verification results.")
  sections.push("")

  return sections.join("\n")
}

/**
 * Compact 模板（Token 高效）
 */
function buildCompactPrompt(atoms: TraversedAtom[], options: PromptBuilderOptions): string {
  const sections: string[] = []

  sections.push("Research Context:")
  sections.push("")

  atoms.forEach((atom, index) => {
    const claimSummary = atom.claim.substring(0, 200).replace(/\n/g, " ")
    sections.push(`${index + 1}. [${atom.atom.atom_type}] ${atom.atom.atom_name}: ${claimSummary}...`)
  })

  sections.push("")

  const relationships = extractRelationships(atoms)
  if (relationships.length > 0) {
    const relSummary = relationships
      .slice(0, 5)
      .map((r) => `${r.sourceName}->${r.targetName}`)
      .join(", ")
    sections.push(`Relationships: ${relSummary}${relationships.length > 5 ? "..." : ""}`)
  }

  return sections.join("\n")
}

/**
 * 从 atoms 中提取关系
 */
function extractRelationships(atoms: TraversedAtom[]): Array<{
  sourceName: string
  targetName: string
  relationType: string
}> {
  const atomMap = new Map(atoms.map((a) => [a.atom.atom_id, a.atom.atom_name]))
  const atomIds = Array.from(atomMap.keys())

  if (atomIds.length === 0) return []

  // 获取这些 atoms 之间的所有关系
  const relations = normalizeLinks(Database.use((db) => db.select().from(AtomRelationTable).all()))

  // 过滤出只在当前 atoms 集合内的关系
  const filtered = relations.filter((r) => atomMap.has(r.atom_id_source) && atomMap.has(r.atom_id_target))

  return filtered.map((r) => ({
    sourceName: atomMap.get(r.atom_id_source) || r.atom_id_source,
    targetName: atomMap.get(r.atom_id_target) || r.atom_id_target,
    relationType: r.relation_type,
  }))
}

/**
 * 构建社区级别的 Prompt（Phase 3）
 *
 * 为多个社区生成结构化的 prompt，突出社区结构
 */
export function buildCommunityPrompt(
  communities: Community[],
  atomsByCommunity: Map<string, TraversedAtom[]>,
  options: PromptBuilderOptions,
): string {
  if (options.template === "graphrag") {
    return buildCommunityGraphRAGPrompt(communities, atomsByCommunity, options)
  } else {
    return buildCommunityCompactPrompt(communities, atomsByCommunity, options)
  }
}

/**
 * 社区级别的 GraphRAG 模板
 */
function buildCommunityGraphRAGPrompt(
  communities: Community[],
  atomsByCommunity: Map<string, TraversedAtom[]>,
  options: PromptBuilderOptions,
): string {
  const sections: string[] = []

  // 标题
  sections.push("# Research Context Graph (Community View)")
  sections.push("")
  sections.push(`You are analyzing a research project organized into ${communities.length} communities:`)
  sections.push("")

  // 社区概览
  sections.push("## Communities Overview")
  sections.push("")
  communities.forEach((community, index) => {
    sections.push(`### Community ${index + 1}: ${community.dominantType.toUpperCase()} (${community.size} atoms)`)
    sections.push("")
    sections.push(`**Summary:** ${community.summary}`)
    sections.push("")
    sections.push(`**Keywords:** ${community.keywords.join(", ")}`)
    sections.push("")
    sections.push(`**Density:** ${(community.density * 100).toFixed(1)}%`)
    sections.push("")
  })

  // 每个社区的详细内容
  sections.push("## Detailed Community Content")
  sections.push("")

  communities.forEach((community, commIndex) => {
    const atoms = atomsByCommunity.get(community.id) || []
    if (atoms.length === 0) return

    sections.push(`### Community ${commIndex + 1} Atoms`)
    sections.push("")

    atoms.forEach((atom, atomIndex) => {
      sections.push(`#### Atom ${commIndex + 1}.${atomIndex + 1}: ${atom.atom.atom_name} [${atom.atom.atom_type}]`)
      sections.push("")
      sections.push("**Claim:**")
      sections.push(atom.claim || "(No claim available)")
      sections.push("")

      if (options.includeEvidence && atom.evidence) {
        sections.push("**Evidence:**")
        sections.push(atom.evidence)
        sections.push("")
      }

      if (options.includeMetadata) {
        sections.push("**Metadata:**")
        sections.push(`- Type: ${atom.atom.atom_type}`)
        sections.push(`- Community: ${commIndex + 1}`)
        sections.push(`- Created: ${new Date(atom.atom.time_created).toISOString()}`)
        sections.push("")
      }
    })
  })

  // 关系部分
  const allAtoms = Array.from(atomsByCommunity.values()).flat()
  const relationships = extractRelationships(allAtoms)
  if (relationships.length > 0) {
    sections.push("## Relationships")
    sections.push("")
    relationships.forEach((rel) => {
      sections.push(`- ${rel.sourceName} --[${rel.relationType}]--> ${rel.targetName}`)
    })
    sections.push("")
  }

  // 指令部分
  sections.push("## Instructions")
  sections.push("")
  sections.push("Based on the above community-structured research context, please:")
  sections.push("1. Analyze the relationships within and between communities")
  sections.push("2. Identify key themes in each community")
  sections.push("3. Consider how different communities relate to each other")
  sections.push("")

  return sections.join("\n")
}

/**
 * 社区级别的 Compact 模板
 */
function buildCommunityCompactPrompt(
  communities: Community[],
  atomsByCommunity: Map<string, TraversedAtom[]>,
  options: PromptBuilderOptions,
): string {
  const sections: string[] = []

  sections.push(`Research Context (${communities.length} communities):`)
  sections.push("")

  communities.forEach((community, commIndex) => {
    const atoms = atomsByCommunity.get(community.id) || []
    sections.push(`Community ${commIndex + 1} [${community.dominantType}, ${community.size} atoms]:`)
    sections.push(`  ${community.summary}`)
    sections.push("")

    atoms.forEach((atom, atomIndex) => {
      const claimSummary = atom.claim.substring(0, 150).replace(/\n/g, " ")
      sections.push(
        `  ${commIndex + 1}.${atomIndex + 1}. [${atom.atom.atom_type}] ${atom.atom.atom_name}: ${claimSummary}...`,
      )
    })
    sections.push("")
  })

  return sections.join("\n")
}
