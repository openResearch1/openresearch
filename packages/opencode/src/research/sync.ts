import path from "path"
import { Database, eq, and } from "../storage/db"
import {
  ResearchProjectTable,
  AtomTable,
  AtomRelationTable,
  ExperimentTable,
  ArticleTable,
  CodeTable,
} from "./research.sql"
import { ProjectTable } from "../project/project.sql"
import { Manifest, type ManifestData, type ManifestAtom, type ManifestExperiment } from "./manifest"
import { git } from "../util/git"

export namespace Sync {
  // ── Serialize: DB → Manifest ──

  /** Read all research entities from DB and write to .openresearch/manifest/ */
  export async function serializeToManifest(researchProjectId: string, worktree: string): Promise<ManifestData> {
    const researchProject = Database.use((db) =>
      db
        .select()
        .from(ResearchProjectTable)
        .where(eq(ResearchProjectTable.research_project_id, researchProjectId))
        .get(),
    )
    if (!researchProject) {
      throw new Error(`Research project not found: ${researchProjectId}`)
    }

    const atoms = Database.use((db) =>
      db.select().from(AtomTable).where(eq(AtomTable.research_project_id, researchProjectId)).all(),
    )
    const atomIds = atoms.map((a) => a.atom_id)

    let relations: (typeof AtomRelationTable.$inferSelect)[] = []
    if (atomIds.length > 0) {
      const allRelations = Database.use((db) => db.select().from(AtomRelationTable).all())
      relations = allRelations.filter((r) => atomIds.includes(r.atom_id_source) || atomIds.includes(r.atom_id_target))
    }

    const experiments = Database.use((db) =>
      db.select().from(ExperimentTable).where(eq(ExperimentTable.research_project_id, researchProjectId)).all(),
    )
    const articles = Database.use((db) =>
      db.select().from(ArticleTable).where(eq(ArticleTable.research_project_id, researchProjectId)).all(),
    )
    const codes = Database.use((db) =>
      db.select().from(CodeTable).where(eq(CodeTable.research_project_id, researchProjectId)).all(),
    )

    // Build code_id → code_name map for experiment path resolution
    const codeNameMap = new Map<string, string>()
    for (const code of codes) {
      codeNameMap.set(code.code_id, code.code_name)
    }

    const manifestData: ManifestData = {
      project: {
        version: "1.0",
        research_project_id: researchProjectId,
        background_path: Manifest.toRelativePath(worktree, researchProject.background_path),
        goal_path: Manifest.toRelativePath(worktree, researchProject.goal_path),
        macro_table_path: Manifest.toRelativePath(worktree, researchProject.macro_table_path),
        synced_at: Date.now(),
      },
      atoms: atoms.map(
        (atom): ManifestAtom => ({
          atom_id: atom.atom_id,
          atom_name: atom.atom_name,
          atom_type: atom.atom_type,
          atom_claim_path: Manifest.toRelativePath(worktree, atom.atom_claim_path),
          atom_evidence_type: atom.atom_evidence_type,
          atom_evidence_status: atom.atom_evidence_status,
          atom_evidence_path: Manifest.toRelativePath(worktree, atom.atom_evidence_path),
          atom_evidence_assessment_path: Manifest.toRelativePath(worktree, atom.atom_evidence_assessment_path),
          article_id: atom.article_id,
          time_created: atom.time_created,
          time_updated: atom.time_updated,
        }),
      ),
      relations: relations.map((r) => ({
        atom_id_source: r.atom_id_source,
        atom_id_target: r.atom_id_target,
        relation_type: r.relation_type,
        note: r.note,
        time_created: r.time_created,
        time_updated: r.time_updated,
      })),
      experiments: await Promise.all(
        experiments.map(async (exp): Promise<ManifestExperiment> => {
          const codeName = Manifest.extractCodeName(exp.code_path)
          let headCommit: string | null = null
          if (codeName) {
            const wtPath = path.join(worktree, "code", codeName, ".openresearch_worktrees", exp.exp_id)
            const result = await git(["rev-parse", "HEAD"], { cwd: wtPath }).catch(() => null)
            if (result && result.exitCode === 0) {
              headCommit = result.text().trim()
            }
          }

          return {
            exp_id: exp.exp_id,
            exp_name: exp.exp_name,
            baseline_branch_name: exp.baseline_branch_name,
            exp_branch_name: exp.exp_branch_name,
            exp_result_path: Manifest.toRelativePath(worktree, exp.exp_result_path),
            exp_result_summary_path: Manifest.toRelativePath(worktree, exp.exp_result_summary_path),
            exp_plan_path: Manifest.toRelativePath(worktree, exp.exp_plan_path),
            atom_id: exp.atom_id,
            code_name: codeName,
            head_commit: headCommit,
            status: exp.status,
            started_at: exp.started_at,
            finished_at: exp.finished_at,
            time_created: exp.time_created,
            time_updated: exp.time_updated,
          }
        }),
      ),
      articles: articles.map((a) => ({
        article_id: a.article_id,
        path: Manifest.toRelativePath(worktree, a.path) ?? a.path,
        title: a.title,
        source_url: a.source_url,
        status: a.status,
        time_created: a.time_created,
        time_updated: a.time_updated,
      })),
      codes: codes.map((c) => ({
        code_id: c.code_id,
        code_name: c.code_name,
        article_id: c.article_id,
        time_created: c.time_created,
        time_updated: c.time_updated,
      })),
    }

    await Manifest.write(worktree, manifestData)
    return manifestData
  }

  // ── Reconcile: Manifest → DB ──

  export interface ReconcileResult {
    inserted: { atoms: number; relations: number; experiments: number; articles: number; codes: number }
    updated: { atoms: number; relations: number; experiments: number; articles: number; codes: number }
    deleted: { atoms: number; relations: number; experiments: number; articles: number; codes: number }
  }

  /**
   * Reconcile manifest data with local DB.
   * - Entities in manifest but not in DB → INSERT
   * - Entities in both but manifest is newer → UPDATE
   * - Entities in DB but not in manifest → DELETE
   */
  export function reconcileFromManifest(
    manifest: ManifestData,
    researchProjectId: string,
    projectId: string,
    worktree: string,
  ): ReconcileResult {
    const result: ReconcileResult = {
      inserted: { atoms: 0, relations: 0, experiments: 0, articles: 0, codes: 0 },
      updated: { atoms: 0, relations: 0, experiments: 0, articles: 0, codes: 0 },
      deleted: { atoms: 0, relations: 0, experiments: 0, articles: 0, codes: 0 },
    }

    Database.transaction(() => {
      // Ensure research project exists
      const existing = Database.use((db) =>
        db
          .select()
          .from(ResearchProjectTable)
          .where(eq(ResearchProjectTable.research_project_id, researchProjectId))
          .get(),
      )
      if (!existing) {
        Database.use((db) =>
          db
            .insert(ResearchProjectTable)
            .values({
              research_project_id: researchProjectId,
              project_id: projectId,
              background_path: Manifest.toAbsolutePath(worktree, manifest.project.background_path),
              goal_path: Manifest.toAbsolutePath(worktree, manifest.project.goal_path),
              macro_table_path: Manifest.toAbsolutePath(worktree, manifest.project.macro_table_path),
              time_created: Date.now(),
              time_updated: Date.now(),
            })
            .run(),
        )
      } else {
        Database.use((db) =>
          db
            .update(ResearchProjectTable)
            .set({
              background_path: Manifest.toAbsolutePath(worktree, manifest.project.background_path),
              goal_path: Manifest.toAbsolutePath(worktree, manifest.project.goal_path),
              macro_table_path: Manifest.toAbsolutePath(worktree, manifest.project.macro_table_path),
              time_updated: Date.now(),
            })
            .where(eq(ResearchProjectTable.research_project_id, researchProjectId))
            .run(),
        )
      }

      // ── Reconcile Articles (before atoms, since atoms reference articles) ──
      reconcileArticles(manifest, researchProjectId, worktree, result)

      // ── Reconcile Codes ──
      reconcileCodes(manifest, researchProjectId, result)

      // ── Reconcile Atoms ──
      reconcileAtoms(manifest, researchProjectId, worktree, result)

      // ── Reconcile Relations ──
      reconcileRelations(manifest, result)

      // ── Reconcile Experiments ──
      reconcileExperiments(manifest, researchProjectId, worktree, result)
    })

    return result
  }

  function reconcileArticles(
    manifest: ManifestData,
    researchProjectId: string,
    worktree: string,
    result: ReconcileResult,
  ) {
    const dbArticles = Database.use((db) =>
      db.select().from(ArticleTable).where(eq(ArticleTable.research_project_id, researchProjectId)).all(),
    )
    const dbMap = new Map(dbArticles.map((a) => [a.article_id, a]))
    const manifestIds = new Set(manifest.articles.map((a) => a.article_id))

    for (const ma of manifest.articles) {
      const existing = dbMap.get(ma.article_id)
      if (!existing) {
        Database.use((db) =>
          db
            .insert(ArticleTable)
            .values({
              article_id: ma.article_id,
              research_project_id: researchProjectId,
              path: Manifest.toAbsolutePath(worktree, ma.path) ?? ma.path,
              title: ma.title,
              source_url: ma.source_url,
              status: ma.status,
              time_created: ma.time_created,
              time_updated: ma.time_updated,
            })
            .run(),
        )
        result.inserted.articles++
      } else if (ma.time_updated > existing.time_updated) {
        Database.use((db) =>
          db
            .update(ArticleTable)
            .set({
              path: Manifest.toAbsolutePath(worktree, ma.path) ?? ma.path,
              title: ma.title,
              source_url: ma.source_url,
              status: ma.status,
              time_updated: ma.time_updated,
            })
            .where(eq(ArticleTable.article_id, ma.article_id))
            .run(),
        )
        result.updated.articles++
      }
    }

    // Delete articles not in manifest
    for (const [id] of dbMap) {
      if (!manifestIds.has(id)) {
        Database.use((db) => db.delete(ArticleTable).where(eq(ArticleTable.article_id, id)).run())
        result.deleted.articles++
      }
    }
  }

  function reconcileCodes(manifest: ManifestData, researchProjectId: string, result: ReconcileResult) {
    const dbCodes = Database.use((db) =>
      db.select().from(CodeTable).where(eq(CodeTable.research_project_id, researchProjectId)).all(),
    )
    const dbMap = new Map(dbCodes.map((c) => [c.code_id, c]))
    const manifestIds = new Set(manifest.codes.map((c) => c.code_id))

    for (const mc of manifest.codes) {
      const existing = dbMap.get(mc.code_id)
      if (!existing) {
        Database.use((db) =>
          db
            .insert(CodeTable)
            .values({
              code_id: mc.code_id,
              research_project_id: researchProjectId,
              code_name: mc.code_name,
              article_id: mc.article_id,
              time_created: mc.time_created,
              time_updated: mc.time_updated,
            })
            .run(),
        )
        result.inserted.codes++
      } else if (mc.time_updated > existing.time_updated) {
        Database.use((db) =>
          db
            .update(CodeTable)
            .set({
              code_name: mc.code_name,
              article_id: mc.article_id,
              time_updated: mc.time_updated,
            })
            .where(eq(CodeTable.code_id, mc.code_id))
            .run(),
        )
        result.updated.codes++
      }
    }

    for (const [id] of dbMap) {
      if (!manifestIds.has(id)) {
        Database.use((db) => db.delete(CodeTable).where(eq(CodeTable.code_id, id)).run())
        result.deleted.codes++
      }
    }
  }

  function reconcileAtoms(
    manifest: ManifestData,
    researchProjectId: string,
    worktree: string,
    result: ReconcileResult,
  ) {
    const dbAtoms = Database.use((db) =>
      db.select().from(AtomTable).where(eq(AtomTable.research_project_id, researchProjectId)).all(),
    )
    const dbMap = new Map(dbAtoms.map((a) => [a.atom_id, a]))
    const manifestIds = new Set(manifest.atoms.map((a) => a.atom_id))

    for (const ma of manifest.atoms) {
      const existing = dbMap.get(ma.atom_id)
      if (!existing) {
        Database.use((db) =>
          db
            .insert(AtomTable)
            .values({
              atom_id: ma.atom_id,
              research_project_id: researchProjectId,
              atom_name: ma.atom_name,
              atom_type: ma.atom_type,
              atom_claim_path: Manifest.toAbsolutePath(worktree, ma.atom_claim_path),
              atom_evidence_type: ma.atom_evidence_type,
              atom_evidence_status: ma.atom_evidence_status,
              atom_evidence_path: Manifest.toAbsolutePath(worktree, ma.atom_evidence_path),
              atom_evidence_assessment_path: Manifest.toAbsolutePath(worktree, ma.atom_evidence_assessment_path),
              article_id: ma.article_id,
              session_id: null,
              time_created: ma.time_created,
              time_updated: ma.time_updated,
            })
            .run(),
        )
        result.inserted.atoms++
      } else if (ma.time_updated > existing.time_updated) {
        Database.use((db) =>
          db
            .update(AtomTable)
            .set({
              atom_name: ma.atom_name,
              atom_type: ma.atom_type,
              atom_claim_path: Manifest.toAbsolutePath(worktree, ma.atom_claim_path),
              atom_evidence_type: ma.atom_evidence_type,
              atom_evidence_status: ma.atom_evidence_status,
              atom_evidence_path: Manifest.toAbsolutePath(worktree, ma.atom_evidence_path),
              atom_evidence_assessment_path: Manifest.toAbsolutePath(worktree, ma.atom_evidence_assessment_path),
              article_id: ma.article_id,
              time_updated: ma.time_updated,
            })
            .where(eq(AtomTable.atom_id, ma.atom_id))
            .run(),
        )
        result.updated.atoms++
      }
    }

    for (const [id] of dbMap) {
      if (!manifestIds.has(id)) {
        Database.use((db) => db.delete(AtomTable).where(eq(AtomTable.atom_id, id)).run())
        result.deleted.atoms++
      }
    }
  }

  function reconcileRelations(manifest: ManifestData, result: ReconcileResult) {
    // Relations use composite PK: (source, target, type)
    const manifestRelKeys = new Set(
      manifest.relations.map((r) => `${r.atom_id_source}__${r.atom_id_target}__${r.relation_type}`),
    )

    // Get current DB relations for atoms in manifest
    const atomIds = new Set(manifest.atoms.map((a) => a.atom_id))
    const allDbRelations = Database.use((db) => db.select().from(AtomRelationTable).all())
    const relevantDbRelations = allDbRelations.filter(
      (r) => atomIds.has(r.atom_id_source) || atomIds.has(r.atom_id_target),
    )
    const dbRelKeys = new Set(
      relevantDbRelations.map((r) => `${r.atom_id_source}__${r.atom_id_target}__${r.relation_type}`),
    )

    for (const mr of manifest.relations) {
      const key = `${mr.atom_id_source}__${mr.atom_id_target}__${mr.relation_type}`
      if (!dbRelKeys.has(key)) {
        Database.use((db) =>
          db
            .insert(AtomRelationTable)
            .values({
              atom_id_source: mr.atom_id_source,
              atom_id_target: mr.atom_id_target,
              relation_type: mr.relation_type,
              note: mr.note,
              time_created: mr.time_created,
              time_updated: mr.time_updated,
            })
            .run(),
        )
        result.inserted.relations++
      } else {
        // Update if note changed
        const dbRel = relevantDbRelations.find(
          (r) =>
            r.atom_id_source === mr.atom_id_source &&
            r.atom_id_target === mr.atom_id_target &&
            r.relation_type === mr.relation_type,
        )
        if (dbRel && mr.time_updated > dbRel.time_updated) {
          Database.use((db) =>
            db
              .update(AtomRelationTable)
              .set({ note: mr.note, time_updated: mr.time_updated })
              .where(
                and(
                  eq(AtomRelationTable.atom_id_source, mr.atom_id_source),
                  eq(AtomRelationTable.atom_id_target, mr.atom_id_target),
                  eq(AtomRelationTable.relation_type, mr.relation_type),
                ),
              )
              .run(),
          )
          result.updated.relations++
        }
      }
    }

    // Delete relations not in manifest
    for (const dbRel of relevantDbRelations) {
      const key = `${dbRel.atom_id_source}__${dbRel.atom_id_target}__${dbRel.relation_type}`
      if (!manifestRelKeys.has(key)) {
        Database.use((db) =>
          db
            .delete(AtomRelationTable)
            .where(
              and(
                eq(AtomRelationTable.atom_id_source, dbRel.atom_id_source),
                eq(AtomRelationTable.atom_id_target, dbRel.atom_id_target),
                eq(AtomRelationTable.relation_type, dbRel.relation_type),
              ),
            )
            .run(),
        )
        result.deleted.relations++
      }
    }
  }

  function reconcileExperiments(
    manifest: ManifestData,
    researchProjectId: string,
    worktree: string,
    result: ReconcileResult,
  ) {
    const dbExperiments = Database.use((db) =>
      db.select().from(ExperimentTable).where(eq(ExperimentTable.research_project_id, researchProjectId)).all(),
    )
    const dbMap = new Map(dbExperiments.map((e) => [e.exp_id, e]))
    const manifestIds = new Set(manifest.experiments.map((e) => e.exp_id))

    for (const me of manifest.experiments) {
      const codePath = me.code_name ? Manifest.buildCodePath(worktree, me.code_name, me.exp_id) : ""

      const existing = dbMap.get(me.exp_id)
      if (!existing) {
        Database.use((db) =>
          db
            .insert(ExperimentTable)
            .values({
              exp_id: me.exp_id,
              research_project_id: researchProjectId,
              exp_name: me.exp_name,
              exp_session_id: null,
              baseline_branch_name: me.baseline_branch_name,
              exp_branch_name: me.exp_branch_name,
              exp_result_path: Manifest.toAbsolutePath(worktree, me.exp_result_path),
              atom_id: me.atom_id,
              exp_result_summary_path: Manifest.toAbsolutePath(worktree, me.exp_result_summary_path),
              exp_plan_path: Manifest.toAbsolutePath(worktree, me.exp_plan_path),
              remote_server_id: null,
              code_path: codePath,
              status: me.status === "running" ? "idle" : me.status,
              started_at: me.started_at,
              finished_at: me.finished_at,
              time_created: me.time_created,
              time_updated: me.time_updated,
            })
            .run(),
        )
        result.inserted.experiments++
      } else if (me.time_updated > existing.time_updated) {
        Database.use((db) =>
          db
            .update(ExperimentTable)
            .set({
              exp_name: me.exp_name,
              baseline_branch_name: me.baseline_branch_name,
              exp_branch_name: me.exp_branch_name,
              exp_result_path: Manifest.toAbsolutePath(worktree, me.exp_result_path),
              atom_id: me.atom_id,
              exp_result_summary_path: Manifest.toAbsolutePath(worktree, me.exp_result_summary_path),
              exp_plan_path: Manifest.toAbsolutePath(worktree, me.exp_plan_path),
              code_path: codePath || existing.code_path,
              status: me.status === "running" ? existing.status : me.status,
              time_updated: me.time_updated,
            })
            .where(eq(ExperimentTable.exp_id, me.exp_id))
            .run(),
        )
        result.updated.experiments++
      }
    }

    for (const [id] of dbMap) {
      if (!manifestIds.has(id)) {
        Database.use((db) => db.delete(ExperimentTable).where(eq(ExperimentTable.exp_id, id)).run())
        result.deleted.experiments++
      }
    }
  }

  // ── Utility: format reconcile result for display ──

  export function formatResult(result: ReconcileResult): string {
    const parts: string[] = []
    const { inserted, updated, deleted } = result
    const total = (obj: Record<string, number>) => Object.values(obj).reduce((a, b) => a + b, 0)

    if (total(inserted) > 0) {
      const items: string[] = []
      if (inserted.atoms) items.push(`${inserted.atoms} atoms`)
      if (inserted.articles) items.push(`${inserted.articles} articles`)
      if (inserted.experiments) items.push(`${inserted.experiments} experiments`)
      if (inserted.codes) items.push(`${inserted.codes} codes`)
      if (inserted.relations) items.push(`${inserted.relations} relations`)
      parts.push(`added ${items.join(", ")}`)
    }
    if (total(updated) > 0) {
      const items: string[] = []
      if (updated.atoms) items.push(`${updated.atoms} atoms`)
      if (updated.articles) items.push(`${updated.articles} articles`)
      if (updated.experiments) items.push(`${updated.experiments} experiments`)
      parts.push(`updated ${items.join(", ")}`)
    }
    if (total(deleted) > 0) {
      const items: string[] = []
      if (deleted.atoms) items.push(`${deleted.atoms} atoms`)
      if (deleted.articles) items.push(`${deleted.articles} articles`)
      if (deleted.experiments) items.push(`${deleted.experiments} experiments`)
      parts.push(`removed ${items.join(", ")}`)
    }

    return parts.length > 0 ? parts.join("; ") : "no changes"
  }
}
