import { Database, eq, and } from "../../storage/db"
import { AtomTable, AtomRelationTable, normalizeLinks } from "../../research/research.sql"
import { Filesystem } from "../../util/filesystem"
import type { TraversalOptions, TraversedAtom, RelationType } from "./types"

interface QueueItem {
  atomId: string
  distance: number
  path: string[]
  relationChain: RelationType[]
}

/**
 * 使用 BFS 遍历 Atom Graph
 */
export async function traverseAtomGraph(options: TraversalOptions): Promise<TraversedAtom[]> {
  const { seedAtomIds, maxDepth, maxAtoms, relationTypes, atomTypes } = options

  const visited = new Map<string, TraversedAtom>()
  const queue: QueueItem[] = []

  // 初始化队列
  for (const atomId of seedAtomIds) {
    queue.push({
      atomId,
      distance: 0,
      path: [atomId],
      relationChain: [],
    })
  }

  while (queue.length > 0 && visited.size < (maxAtoms || Infinity)) {
    const current = queue.shift()!

    if (visited.has(current.atomId) || current.distance > maxDepth) {
      continue
    }

    // 获取 atom 数据
    const atom = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, current.atomId)).get())

    if (!atom) continue

    // 应用 atom 类型过滤
    if (atomTypes && !atomTypes.includes(atom.atom_type as any)) {
      continue
    }

    // 读取文件内容
    let claim = ""
    let evidence = ""

    try {
      if (atom.atom_claim_path) {
        claim = await Filesystem.readText(atom.atom_claim_path)
      }
      if (atom.atom_evidence_path) {
        evidence = await Filesystem.readText(atom.atom_evidence_path)
      }
    } catch (error) {
      // 文件不存在时降级处理
      console.warn(`Failed to read atom content for ${current.atomId}:`, error)
    }

    // 添加到已访问
    visited.set(current.atomId, {
      atom,
      claim,
      evidence,
      distance: current.distance,
      path: current.path,
      relationChain: current.relationChain,
    })

    // 如果达到最大深度，不再扩展
    if (current.distance >= maxDepth) {
      continue
    }

    // 获取邻居（出边）
    const relations = normalizeLinks(
      Database.use((db) =>
        db.select().from(AtomRelationTable).where(eq(AtomRelationTable.atom_id_source, current.atomId)).all(),
      ),
    )

    // 过滤关系类型
    const filteredRelations =
      relationTypes && relationTypes.length > 0
        ? relations.filter((r) => relationTypes.includes(r.relation_type))
        : relations

    // 添加邻居到队列
    for (const rel of filteredRelations) {
      if (!visited.has(rel.atom_id_target)) {
        queue.push({
          atomId: rel.atom_id_target,
          distance: current.distance + 1,
          path: [...current.path, rel.atom_id_target],
          relationChain: [...current.relationChain, rel.relation_type],
        })
      }
    }
  }

  return Array.from(visited.values())
}
