import path from "path"
import { Database, eq, inArray } from "@/storage/db"
import { ArticleTable, AtomTable } from "@/research/research.sql"
import { Filesystem } from "@/util/filesystem"
import { articleTitle, isArticleDirectory, listArticleSources } from "./article-source"

type Hit = {
  path: string
  title: string
  score: number
  exact: boolean
}

function words(text: string) {
  return Array.from(new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []))
}

function read(file: string | null) {
  if (!file) return Promise.resolve("")
  return Filesystem.exists(file).then((exists) => {
    if (!exists) return ""
    return Filesystem.readText(file)
  })
}

function alias(title: string) {
  const head = title.split(/[\s:(,]/)[0] ?? ""
  const out = new Set<string>()

  if (head && (/[-0-9]/.test(head) || (head.length > 6 && head.replace(/[^A-Z]/g, "").length >= 2))) {
    out.add(head.toLowerCase())
  }

  const lower = head.toLowerCase()
  if (lower.includes("-to-")) {
    const [left, right] = lower.split("-to-")
    if (left && right) out.add(`${left[0]}2${right[0]}`)
  }

  return [...out]
}

function match(text: string, files: string[]): Hit | undefined {
  const body = text.toLowerCase()
  const source = words(body)

  return files
    .map((file) => {
      const title = articleTitle(file)
      const extra = alias(title)
      const names = [title, ...extra]
      const pool = new Set(words(`${title} ${path.basename(file)} ${extra.join(" ")}`))
      const overlap = source.filter((item) => pool.has(item)).length
      const exact = names.some((name) => name && body.includes(name.toLowerCase())) ? 1 : 0
      return {
        path: file,
        title,
        score: exact * 100 + overlap * 2 + (pool.size > 0 ? overlap / pool.size : 0),
        exact: Boolean(exact),
      } satisfies Hit
    })
    .sort((left, right) => right.score - left.score)[0]
}

export async function repairContainerArticles(researchProjectId: string) {
  const arts = Database.use((db) =>
    db.select().from(ArticleTable).where(eq(ArticleTable.research_project_id, researchProjectId)).all(),
  )
  const atoms = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.research_project_id, researchProjectId)).all())
  const now = Date.now()
  const seen = new Map(arts.map((art) => [art.path, art]))
  const out: Array<{
    articleId: string
    path: string
    atomCount: number
    candidates: string[]
    assigned: Array<{ atomIds: string[]; path: string; title: string; score: number }>
  }> = []

  for (const art of arts) {
    if (!(await Filesystem.exists(art.path))) continue
    if (!(await Filesystem.isDir(art.path))) continue
    if (await isArticleDirectory(art.path)) continue

    const group = atoms.filter((atom) => atom.article_id === art.article_id)
    if (group.length === 0) continue

    const files = await listArticleSources(art.path)
    if (files.length === 0) continue

    const hits = new Map<string, Hit>()

    await Promise.all(
      group.map(async (atom) => {
        const text = `${atom.atom_name}\n${await read(atom.atom_claim_path)}\n${await read(atom.atom_evidence_path)}`
        const best = match(text, files)
        if (!best || !best.exact) return
        hits.set(atom.atom_id, best)
      }),
    )

    const assigned = Array.from(
      group.reduce((acc, atom) => {
        const hit = hits.get(atom.atom_id)
        if (!hit) return acc
        const item = acc.get(hit.path) ?? { atomIds: [], path: hit.path, title: hit.title, score: [] as number[] }
        item.atomIds.push(atom.atom_id)
        item.score.push(hit.score)
        acc.set(hit.path, item)
        return acc
      }, new Map<string, { atomIds: string[]; path: string; title: string; score: number[] }>()).values(),
    ).map((item) => ({
      atomIds: item.atomIds,
      path: item.path,
      title: item.title,
      score: Number((item.score.reduce((sum, val) => sum + val, 0) / item.score.length).toFixed(4)),
    }))

    if (assigned.length === 0) continue

    Database.transaction(() => {
      for (const item of assigned) {
        let row = seen.get(item.path)
        if (!row) {
          const article_id = crypto.randomUUID()
          const next = {
            article_id,
            research_project_id: researchProjectId,
            path: item.path,
            title: item.title,
            source_url: null,
            status: art.status,
            time_created: now,
            time_updated: now,
          }
          Database.use((db) => db.insert(ArticleTable).values(next).run())
          seen.set(item.path, next)
          row = next
        }

        Database.use((db) =>
          db
            .update(AtomTable)
            .set({ article_id: row.article_id, time_updated: now })
            .where(inArray(AtomTable.atom_id, item.atomIds))
            .run(),
        )
      }
    })

    out.push({
      articleId: art.article_id,
      path: art.path,
      atomCount: group.length,
      candidates: files,
      assigned,
    })
  }

  return out
}
