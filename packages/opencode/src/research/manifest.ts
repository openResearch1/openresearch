import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "../util/filesystem"

// ── Zod Schemas (all paths are relative to project root) ──

export const ManifestProjectSchema = z.object({
  version: z.string().default("1.0"),
  research_project_id: z.string(),
  background_path: z.string().nullable(),
  goal_path: z.string().nullable(),
  macro_table_path: z.string().nullable(),
  synced_at: z.number(),
})

export const ManifestAtomSchema = z.object({
  atom_id: z.string(),
  atom_name: z.string(),
  atom_type: z.enum(["fact", "method", "theorem", "verification"]),
  atom_claim_path: z.string().nullable(),
  atom_evidence_type: z.enum(["math", "experiment"]),
  atom_evidence_status: z.enum(["pending", "in_progress", "proven", "disproven"]),
  atom_evidence_path: z.string().nullable(),
  atom_evidence_assessment_path: z.string().nullable(),
  article_id: z.string().nullable(),
  time_created: z.number(),
  time_updated: z.number(),
})

export const ManifestRelationSchema = z.object({
  atom_id_source: z.string(),
  atom_id_target: z.string(),
  relation_type: z.enum(["motivates", "formalizes", "derives", "analyzes", "validates", "contradicts", "other"]),
  note: z.string().nullable(),
  time_created: z.number(),
  time_updated: z.number(),
})

export const ManifestExperimentSchema = z.object({
  exp_id: z.string(),
  exp_name: z.string(),
  baseline_branch_name: z.string().nullable(),
  exp_branch_name: z.string().nullable(),
  exp_result_path: z.string().nullable(),
  exp_result_summary_path: z.string().nullable(),
  exp_plan_path: z.string().nullable(),
  atom_id: z.string().nullable(),
  code_name: z.string().nullable(),
  head_commit: z.string().nullable(),
  status: z.enum(["pending", "running", "done", "idle", "failed"]),
  started_at: z.number().nullable(),
  finished_at: z.number().nullable(),
  time_created: z.number(),
  time_updated: z.number(),
})

export const ManifestArticleSchema = z.object({
  article_id: z.string(),
  path: z.string(),
  title: z.string().nullable(),
  source_url: z.string().nullable(),
  status: z.enum(["pending", "parsed", "failed"]),
  time_created: z.number(),
  time_updated: z.number(),
})

export const ManifestCodeSchema = z.object({
  code_id: z.string(),
  code_name: z.string(),
  article_id: z.string().nullable(),
  time_created: z.number(),
  time_updated: z.number(),
})

export type ManifestProject = z.infer<typeof ManifestProjectSchema>
export type ManifestAtom = z.infer<typeof ManifestAtomSchema>
export type ManifestRelation = z.infer<typeof ManifestRelationSchema>
export type ManifestExperiment = z.infer<typeof ManifestExperimentSchema>
export type ManifestArticle = z.infer<typeof ManifestArticleSchema>
export type ManifestCode = z.infer<typeof ManifestCodeSchema>

export interface ManifestData {
  project: ManifestProject
  atoms: ManifestAtom[]
  relations: ManifestRelation[]
  experiments: ManifestExperiment[]
  articles: ManifestArticle[]
  codes: ManifestCode[]
}

// ── Manifest Directory Layout ──

export namespace Manifest {
  function manifestDir(worktree: string) {
    return path.join(worktree, ".openresearch", "manifest")
  }

  function sortedJson(obj: unknown): string {
    return JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort(), 2)
  }

  /** Write the full manifest to disk. Removes stale files for deleted entities. */
  export async function write(worktree: string, data: ManifestData): Promise<void> {
    const dir = manifestDir(worktree)

    // Write project.json
    await Filesystem.write(path.join(dir, "project.json"), sortedJson(data.project))

    // Write atoms
    const atomsDir = path.join(dir, "atoms")
    await writeEntityDir(atomsDir, data.atoms, (a) => a.atom_id)

    // Write relations
    const relationsDir = path.join(dir, "relations")
    await writeEntityDir(
      relationsDir,
      data.relations,
      (r) => `${r.atom_id_source}__${r.atom_id_target}__${r.relation_type}`,
    )

    // Write experiments
    const experimentsDir = path.join(dir, "experiments")
    await writeEntityDir(experimentsDir, data.experiments, (e) => e.exp_id)

    // Write articles
    const articlesDir = path.join(dir, "articles")
    await writeEntityDir(articlesDir, data.articles, (a) => a.article_id)

    // Write codes
    const codesDir = path.join(dir, "codes")
    await writeEntityDir(codesDir, data.codes, (c) => c.code_id)
  }

  async function writeEntityDir<T extends Record<string, unknown>>(
    dir: string,
    entities: T[],
    keyFn: (entity: T) => string,
  ): Promise<void> {
    await fs.mkdir(dir, { recursive: true })

    const expectedFiles = new Set<string>()
    for (const entity of entities) {
      const filename = `${keyFn(entity)}.json`
      expectedFiles.add(filename)
      await Filesystem.write(path.join(dir, filename), sortedJson(entity))
    }

    // Remove stale files (entities that no longer exist)
    try {
      const existing = await fs.readdir(dir)
      for (const file of existing) {
        if (file.endsWith(".json") && !expectedFiles.has(file)) {
          await fs.unlink(path.join(dir, file)).catch(() => {})
        }
      }
    } catch {
      // Directory may not exist yet
    }
  }

  /** Read the full manifest from disk. */
  export async function read(worktree: string): Promise<ManifestData | null> {
    const dir = manifestDir(worktree)
    const projectPath = path.join(dir, "project.json")

    if (!(await Filesystem.exists(projectPath))) {
      return null
    }

    const project = ManifestProjectSchema.parse(await Filesystem.readJson(projectPath))
    const atoms = await readEntityDir(path.join(dir, "atoms"), ManifestAtomSchema)
    const relations = await readEntityDir(path.join(dir, "relations"), ManifestRelationSchema)
    const experiments = await readEntityDir(path.join(dir, "experiments"), ManifestExperimentSchema)
    const articles = await readEntityDir(path.join(dir, "articles"), ManifestArticleSchema)
    const codes = await readEntityDir(path.join(dir, "codes"), ManifestCodeSchema)

    return { project, atoms, relations, experiments, articles, codes }
  }

  async function readEntityDir<T>(dir: string, schema: z.ZodType<T>): Promise<T[]> {
    if (!(await Filesystem.exists(dir))) return []
    const files = await fs.readdir(dir)
    const results: T[] = []
    for (const file of files) {
      if (!file.endsWith(".json")) continue
      try {
        const data = await Filesystem.readJson(path.join(dir, file))
        results.push(schema.parse(data))
      } catch {
        // Skip invalid files
      }
    }
    return results
  }

  // ── Path conversion helpers ──

  /** Convert an absolute path to relative (for manifest serialization) */
  export function toRelativePath(worktree: string, absolutePath: string | null): string | null {
    if (!absolutePath) return null
    return path.relative(worktree, absolutePath)
  }

  /** Convert a relative path to absolute (for DB deserialization) */
  export function toAbsolutePath(worktree: string, relativePath: string | null): string | null {
    if (!relativePath) return null
    if (path.isAbsolute(relativePath)) return relativePath
    return path.join(worktree, relativePath)
  }

  /**
   * Extract code_name from an experiment's absolute code_path.
   * code_path pattern: <worktree>/code/<code_name>/.openresearch_worktrees/<expId>
   */
  export function extractCodeName(codePath: string): string | null {
    const match = codePath.match(/\/code\/([^/]+)\//)
    return match ? match[1] : null
  }

  /**
   * Rebuild absolute code_path from code_name and expId.
   */
  export function buildCodePath(worktree: string, codeName: string, expId: string): string {
    return path.join(worktree, "code", codeName, ".openresearch_worktrees", expId)
  }
}
