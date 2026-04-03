import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import z from "zod"
import path from "path"
import { Filesystem } from "@/util/filesystem"
import { Database } from "@/storage/db"
import { Project } from "@/project/project"
import { ProjectTable } from "@/project/project.sql"
import {
  ResearchProjectTable,
  ArticleTable,
  AtomTable,
  AtomRelationTable,
  ExperimentTable,
  RemoteServerTable,
  ExperimentExecutionWatchTable,
  ExperimentWatchTable,
  LocalDownloadWatchTable,
} from "@/research/research.sql"
import { and, eq } from "drizzle-orm"
import { Session } from "@/session"
import { linkKinds } from "@/research/research.sql"
import { Bus } from "@/bus"
import { errors } from "../error"
import fs from "fs"
import { rm } from "fs/promises"
import { git } from "@/util/git"
import { Research } from "@/research/research.ts"
import { Instance } from "@/project/instance"
import { Snapshot } from "@/snapshot"
import { computeExperimentDiff } from "@/util/git-diff"
import { checkExperimentReadyByExpId } from "@/session/experiment-guard"
import { forceRefreshWatch } from "@/research/experiment-watcher"
import { forceRefreshLocalDownload } from "@/research/experiment-local-download-watcher"
import { ExperimentExecutionWatch } from "@/research/experiment-execution-watch"

const createSchema = z.object({
  name: z.string().min(1, "name required"),
  targetPath: z.string().min(1, "targetPath required"),
  papers: z.array(z.string().min(1)).min(1, "papers required"),
  backgroundPath: z.string().optional(),
  goalPath: z.string().optional(),
})

async function copyFile(src: string, dest: string) {
  if (!(await Filesystem.exists(src))) throw new Error(`file not found: ${src}`)
  await fs.promises.cp(src, dest, { force: false, recursive: await Filesystem.isDir(src) })
}

const uniqueID = () => crypto.randomUUID()

function gitError(result: { stderr?: Buffer; text?: () => string }, fallback: string) {
  const text = result.stderr?.toString().trim() || result.text?.().trim() || fallback
  return text
}

const atomSchema = z.object({
  atom_id: z.string(),
  research_project_id: z.string(),
  atom_name: z.string(),
  atom_type: z.string(),
  atom_claim_path: z.string().nullable(),
  atom_evidence_type: z.string(),
  atom_evidence_status: z.string(),
  atom_evidence_path: z.string().nullable(),
  atom_evidence_assessment_path: z.string().nullable(),
  article_id: z.string().nullable(),
  session_id: z.string().nullable(),
  time_created: z.number(),
  time_updated: z.number(),
})

const remoteServerConfigSchema = z.object({
  address: z.string(),
  port: z.number(),
  user: z.string(),
  password: z.string(),
  resource_root: z.string().optional(),
  wandb_api_key: z.string().optional(),
  wandb_project_name: z.string().optional(),
})

const experimentSchema = z.object({
  exp_id: z.string(),
  research_project_id: z.string(),
  exp_session_id: z.string().nullable(),
  baseline_branch_name: z.string().nullable(),
  exp_branch_name: z.string().nullable(),
  exp_result_path: z.string().nullable(),
  atom_id: z.string().nullable(),
  exp_result_summary_path: z.string().nullable(),
  exp_plan_path: z.string().nullable(),
  remote_server_id: z.string().nullable(),
  remote_server_config: remoteServerConfigSchema.nullable(),
  code_path: z.string(),
  status: z.enum(["pending", "running", "done", "idle", "failed"]),
  started_at: z.number().nullable(),
  finished_at: z.number().nullable(),
  time_created: z.number(),
  time_updated: z.number(),
})

const watchListItemSchema = z.object({
  watch_id: z.string(),
  kind: z.literal("experiment"),
  exp_id: z.string(),
  exp_session_id: z.string().nullable(),
  exp_result_path: z.string().nullable(),
  title: z.string(),
  status: z.enum(["pending", "running", "finished", "failed", "canceled"]),
  stage: z.enum([
    "planning",
    "coding",
    "deploying_code",
    "setting_up_env",
    "local_downloading",
    "syncing_resources",
    "remote_downloading",
    "verifying_resources",
    "running_experiment",
    "watching_wandb",
  ]),
  message: z.string().nullable(),
  error_message: z.string().nullable(),
  started_at: z.number().nullable(),
  finished_at: z.number().nullable(),
  time_created: z.number(),
  time_updated: z.number(),
  wandb_entity: z.string().nullable(),
  wandb_project: z.string().nullable(),
  wandb_run_id: z.string().nullable(),
  local_download_resource_name: z.string().nullable(),
  local_download_local_path: z.string().nullable(),
  local_download_log_path: z.string().nullable(),
  local_download_status_path: z.string().nullable(),
})

const articleSchema = z.object({
  article_id: z.string(),
  research_project_id: z.string(),
  path: z.string(),
  code_path: z.string().nullable(),
  title: z.string().nullable(),
  source_url: z.string().nullable(),
  status: z.enum(["pending", "parsed", "failed"]),
  time_created: z.number(),
  time_updated: z.number(),
})

type RemoteServerConfig = z.infer<typeof remoteServerConfigSchema>

function resolveRemoteServerConfig(remoteServerId: string | null): RemoteServerConfig | null {
  if (!remoteServerId) return null
  const server = Database.use((db) =>
    db.select().from(RemoteServerTable).where(eq(RemoteServerTable.id, remoteServerId)).get(),
  )
  if (!server) return null
  try {
    return JSON.parse(server.config) as RemoteServerConfig
  } catch {
    return null
  }
}

function withRemoteServerConfig<T extends { remote_server_id: string | null }>(
  exp: T,
): T & { remote_server_config: RemoteServerConfig | null } {
  return { ...exp, remote_server_config: resolveRemoteServerConfig(exp.remote_server_id) }
}

const experimentSessionResponseSchema = experimentSchema
  .extend({
    atom: atomSchema.nullable(),
    article: articleSchema.nullable(),
  })
  .nullable()

const atomRelationSchema = z.object({
  atom_id_source: z.string(),
  atom_id_target: z.string(),
  relation_type: z.string(),
  note: z.string().nullable(),
  time_created: z.number(),
  time_updated: z.number(),
})

const commitDiffSchema = z.object({
  hash: z.string(),
  message: z.string(),
  author: z.string(),
  date: z.string(),
  diffs: z.array(Snapshot.FileDiff),
})

const experimentDiffResponseSchema = z.object({
  commits: z.array(commitDiffSchema),
})

const atomRelationCreateSchema = z.object({
  source_atom_id: z.string().min(1, "source atom required"),
  target_atom_id: z.string().min(1, "target atom required"),
  relation_type: z.enum(linkKinds),
  note: z.string().optional(),
})

const atomRelationDeleteSchema = z.object({
  source_atom_id: z.string().min(1, "source atom required"),
  target_atom_id: z.string().min(1, "target atom required"),
  relation_type: z.enum(linkKinds),
})

const atomRelationUpdateSchema = atomRelationDeleteSchema.extend({
  next_relation_type: z.enum(linkKinds),
})

const atomRelationDeleteResponseSchema = z.object({
  source_atom_id: z.string(),
  target_atom_id: z.string(),
  relation_type: z.enum(linkKinds),
  deleted: z.literal(true),
})

const atomDeleteResponseSchema = z.object({
  atom_id: z.string(),
  deleted: z.literal(true),
})

const researchProjectSchema = z.object({
  research_project_id: z.string(),
  project_id: z.string(),
  background_path: z.string().nullable(),
  goal_path: z.string().nullable(),
  time_created: z.number(),
  time_updated: z.number(),
})

export const ResearchRoutes = new Hono()
  .get(
    "/project/by-project/:projectId",
    describeRoute({
      summary: "Get research project by project ID",
      description: "Look up the research project associated with a given project ID.",
      operationId: "research.project.get",
      responses: {
        200: {
          description: "Research project found",
          content: {
            "application/json": {
              schema: resolver(researchProjectSchema),
            },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const projectId = c.req.param("projectId")
      const row = Database.use((db) =>
        db.select().from(ResearchProjectTable).where(eq(ResearchProjectTable.project_id, projectId)).get(),
      )
      if (!row) {
        return c.json({ success: false, message: "no research project for this project" }, 404)
      }
      return c.json(row)
    },
  )
  .get(
    "/project/:researchProjectId/atoms",
    describeRoute({
      summary: "List atoms and relations",
      description: "Query all atoms and atom relations for a research project.",
      operationId: "research.atoms.list",
      responses: {
        200: {
          description: "Atoms and relations",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  atoms: z.array(atomSchema),
                  relations: z.array(atomRelationSchema),
                }),
              ),
            },
          },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      const researchProjectId = c.req.param("researchProjectId")

      const atoms = Database.use((db) =>
        db.select().from(AtomTable).where(eq(AtomTable.research_project_id, researchProjectId)).all(),
      )

      const atomIds = atoms.map((a) => a.atom_id)

      let relations: (typeof AtomRelationTable.$inferSelect)[] = []
      if (atomIds.length > 0) {
        const allRelations = Database.use((db) => db.select().from(AtomRelationTable).all())
        relations = allRelations.filter((r) => atomIds.includes(r.atom_id_source) || atomIds.includes(r.atom_id_target))
      }

      return c.json({ atoms, relations })
    },
  )
  .post(
    "/project/:researchProjectId/relation",
    describeRoute({
      summary: "Create atom relation",
      description: "Create a directed relation between two atoms in the same research project.",
      operationId: "research.relation.create",
      responses: {
        200: {
          description: "Created relation",
          content: {
            "application/json": {
              schema: resolver(atomRelationSchema),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator("json", atomRelationCreateSchema),
    async (c) => {
      const researchProjectId = c.req.param("researchProjectId")
      const body = c.req.valid("json")

      if (body.source_atom_id === body.target_atom_id) {
        return c.json({ success: false, message: "source and target atoms must be different" }, 400)
      }

      const source = Database.use((db) =>
        db.select().from(AtomTable).where(eq(AtomTable.atom_id, body.source_atom_id)).get(),
      )
      if (!source || source.research_project_id !== researchProjectId) {
        return c.json({ success: false, message: `source atom not found: ${body.source_atom_id}` }, 404)
      }

      const target = Database.use((db) =>
        db.select().from(AtomTable).where(eq(AtomTable.atom_id, body.target_atom_id)).get(),
      )
      if (!target || target.research_project_id !== researchProjectId) {
        return c.json({ success: false, message: `target atom not found: ${body.target_atom_id}` }, 404)
      }

      const now = Date.now()

      try {
        Database.use((db) =>
          db
            .insert(AtomRelationTable)
            .values({
              atom_id_source: body.source_atom_id,
              atom_id_target: body.target_atom_id,
              relation_type: body.relation_type,
              note: body.note ?? null,
              time_created: now,
              time_updated: now,
            })
            .run(),
        )
      } catch (error: any) {
        if (error?.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
          return c.json({ success: false, message: "relation already exists" }, 400)
        }
        throw error
      }

      await Bus.publish(Research.Event.AtomsUpdated, { researchProjectId })

      return c.json({
        atom_id_source: body.source_atom_id,
        atom_id_target: body.target_atom_id,
        relation_type: body.relation_type,
        note: body.note ?? null,
        time_created: now,
        time_updated: now,
      })
    },
  )
  .patch(
    "/project/:researchProjectId/relation",
    describeRoute({
      summary: "Update atom relation",
      description: "Update the type of an existing directed relation between two atoms in the same research project.",
      operationId: "research.relation.update",
      responses: {
        200: {
          description: "Updated relation",
          content: {
            "application/json": {
              schema: resolver(atomRelationSchema),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator("json", atomRelationUpdateSchema),
    async (c) => {
      const researchProjectId = c.req.param("researchProjectId")
      const body = c.req.valid("json")

      const source = Database.use((db) =>
        db.select().from(AtomTable).where(eq(AtomTable.atom_id, body.source_atom_id)).get(),
      )
      if (!source || source.research_project_id !== researchProjectId) {
        return c.json({ success: false, message: `source atom not found: ${body.source_atom_id}` }, 404)
      }

      const target = Database.use((db) =>
        db.select().from(AtomTable).where(eq(AtomTable.atom_id, body.target_atom_id)).get(),
      )
      if (!target || target.research_project_id !== researchProjectId) {
        return c.json({ success: false, message: `target atom not found: ${body.target_atom_id}` }, 404)
      }

      const existing = Database.use((db) =>
        db
          .select()
          .from(AtomRelationTable)
          .where(
            and(
              eq(AtomRelationTable.atom_id_source, body.source_atom_id),
              eq(AtomRelationTable.atom_id_target, body.target_atom_id),
              eq(AtomRelationTable.relation_type, body.relation_type),
            ),
          )
          .get(),
      )
      if (!existing) {
        return c.json({ success: false, message: "relation not found" }, 404)
      }

      if (body.next_relation_type === body.relation_type) {
        return c.json(existing)
      }

      const conflict = Database.use((db) =>
        db
          .select()
          .from(AtomRelationTable)
          .where(
            and(
              eq(AtomRelationTable.atom_id_source, body.source_atom_id),
              eq(AtomRelationTable.atom_id_target, body.target_atom_id),
              eq(AtomRelationTable.relation_type, body.next_relation_type),
            ),
          )
          .get(),
      )
      if (conflict) {
        return c.json({ success: false, message: "relation already exists" }, 400)
      }

      const now = Date.now()
      Database.transaction(() => {
        Database.use((db) =>
          db
            .delete(AtomRelationTable)
            .where(
              and(
                eq(AtomRelationTable.atom_id_source, body.source_atom_id),
                eq(AtomRelationTable.atom_id_target, body.target_atom_id),
                eq(AtomRelationTable.relation_type, body.relation_type),
              ),
            )
            .run(),
        )
        Database.use((db) =>
          db
            .insert(AtomRelationTable)
            .values({
              atom_id_source: body.source_atom_id,
              atom_id_target: body.target_atom_id,
              relation_type: body.next_relation_type,
              note: existing.note,
              time_created: existing.time_created,
              time_updated: now,
            })
            .run(),
        )
      })

      await Bus.publish(Research.Event.AtomsUpdated, { researchProjectId })

      return c.json({
        atom_id_source: body.source_atom_id,
        atom_id_target: body.target_atom_id,
        relation_type: body.next_relation_type,
        note: existing.note,
        time_created: existing.time_created,
        time_updated: now,
      })
    },
  )
  .delete(
    "/project/:researchProjectId/relation",
    describeRoute({
      summary: "Delete atom relation",
      description: "Delete a directed relation between two atoms in the same research project.",
      operationId: "research.relation.delete",
      responses: {
        200: {
          description: "Deleted relation",
          content: {
            "application/json": {
              schema: resolver(atomRelationDeleteResponseSchema),
            },
          },
        },
        ...errors(404),
      },
    }),
    validator("json", atomRelationDeleteSchema),
    async (c) => {
      const researchProjectId = c.req.param("researchProjectId")
      const body = c.req.valid("json")

      const source = Database.use((db) =>
        db.select().from(AtomTable).where(eq(AtomTable.atom_id, body.source_atom_id)).get(),
      )
      if (!source || source.research_project_id !== researchProjectId) {
        return c.json({ success: false, message: `source atom not found: ${body.source_atom_id}` }, 404)
      }

      const target = Database.use((db) =>
        db.select().from(AtomTable).where(eq(AtomTable.atom_id, body.target_atom_id)).get(),
      )
      if (!target || target.research_project_id !== researchProjectId) {
        return c.json({ success: false, message: `target atom not found: ${body.target_atom_id}` }, 404)
      }

      const existing = Database.use((db) =>
        db
          .select()
          .from(AtomRelationTable)
          .where(
            and(
              eq(AtomRelationTable.atom_id_source, body.source_atom_id),
              eq(AtomRelationTable.atom_id_target, body.target_atom_id),
              eq(AtomRelationTable.relation_type, body.relation_type),
            ),
          )
          .get(),
      )
      if (!existing) {
        return c.json({ success: false, message: "relation not found" }, 404)
      }

      Database.use((db) =>
        db
          .delete(AtomRelationTable)
          .where(
            and(
              eq(AtomRelationTable.atom_id_source, body.source_atom_id),
              eq(AtomRelationTable.atom_id_target, body.target_atom_id),
              eq(AtomRelationTable.relation_type, body.relation_type),
            ),
          )
          .run(),
      )

      await Bus.publish(Research.Event.AtomsUpdated, { researchProjectId })

      return c.json({
        source_atom_id: body.source_atom_id,
        target_atom_id: body.target_atom_id,
        relation_type: body.relation_type,
        deleted: true as const,
      })
    },
  )
  .delete(
    "/project/:researchProjectId/atom/:atomId",
    describeRoute({
      summary: "Delete atom",
      description: "Delete one atom and all relations pointing to or from it.",
      operationId: "research.atom.delete",
      responses: {
        200: {
          description: "Deleted atom",
          content: {
            "application/json": {
              schema: resolver(atomDeleteResponseSchema),
            },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const researchProjectId = c.req.param("researchProjectId")
      const atomId = c.req.param("atomId")

      const atom = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, atomId)).get())
      if (!atom || atom.research_project_id !== researchProjectId) {
        return c.json({ success: false, message: `atom not found: ${atomId}` }, 404)
      }

      const dir = path.join(Instance.directory, "atom_list", atomId)
      try {
        await rm(dir, { recursive: true, force: true })
      } catch (error) {
        console.warn(`Failed to remove atom directory ${dir}:`, error)
      }

      if (atom.session_id) {
        await Session.remove(atom.session_id)
      }

      // Delete associated experiments
      const experiments = Database.use((db) =>
        db.select().from(ExperimentTable).where(eq(ExperimentTable.atom_id, atomId)).all(),
      )
      for (const exp of experiments) {
        // Delete experiment watchers
        Database.use((db) => db.delete(ExperimentWatchTable).where(eq(ExperimentWatchTable.exp_id, exp.exp_id)).run())
        // Delete experiment record
        Database.use((db) => db.delete(ExperimentTable).where(eq(ExperimentTable.exp_id, exp.exp_id)).run())
        // Clean up experiment session
        if (exp.exp_session_id) {
          await Session.remove(exp.exp_session_id).catch(() => {})
        }
        // Delete experiment results directory
        const expDir = path.join(Instance.directory, "exp_results", exp.exp_id)
        await rm(expDir, { recursive: true, force: true }).catch(() => {})
        // Delete experiment git branch
        if (exp.exp_branch_name) {
          const codePath = exp.code_path
          const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: codePath }).catch(() => null)
          const currentBranch = head?.stdout?.toString().trim()
          if (currentBranch === exp.exp_branch_name) {
            const baseline = exp.baseline_branch_name || "master"
            await git(["checkout", "-f", baseline], { cwd: codePath }).catch(() => {})
            await git(["clean", "-fd"], { cwd: codePath }).catch(() => {})
          }
          await git(["branch", "-D", exp.exp_branch_name], { cwd: codePath }).catch(() => {})
        }
      }

      Database.transaction(() => {
        Database.use((db) => db.delete(AtomRelationTable).where(eq(AtomRelationTable.atom_id_source, atomId)).run())
        Database.use((db) => db.delete(AtomRelationTable).where(eq(AtomRelationTable.atom_id_target, atomId)).run())
        Database.use((db) => db.delete(AtomTable).where(eq(AtomTable.atom_id, atomId)).run())
      })

      await Bus.publish(Research.Event.AtomsUpdated, { researchProjectId })

      return c.json({
        atom_id: atomId,
        deleted: true as const,
      })
    },
  )
  // ── Atom update ──
  .patch(
    "/research/:researchProjectId/atom/:atomId",
    describeRoute({
      summary: "Update an atom's mutable fields",
      operationId: "research.atom.update",
      responses: {
        200: {
          description: "Updated atom",
          content: {
            "application/json": {
              schema: resolver(atomSchema),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "json",
      z.object({
        evidence_status: z.enum(["pending", "in_progress", "proven", "disproven"]).optional(),
        evidence_type: z.enum(["math", "experiment"]).optional(),
      }),
    ),
    async (c) => {
      const researchProjectId = c.req.param("researchProjectId")
      const atomId = c.req.param("atomId")
      const body = c.req.valid("json")

      const atom = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, atomId)).get())
      if (!atom || atom.research_project_id !== researchProjectId) {
        return c.json({ success: false, message: `atom not found: ${atomId}` }, 404)
      }

      const updates: Record<string, unknown> = { time_updated: Date.now() }
      if (body.evidence_status) updates.atom_evidence_status = body.evidence_status
      if (body.evidence_type) updates.atom_evidence_type = body.evidence_type

      Database.use((db) => db.update(AtomTable).set(updates).where(eq(AtomTable.atom_id, atomId)).run())

      await Bus.publish(Research.Event.AtomsUpdated, { researchProjectId })

      const updated = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, atomId)).get())!
      return c.json(updated)
    },
  )
  .post(
    "/project",
    describeRoute({
      summary: "Create research project",
      description: "Create OpenCode project with research metadata and uploaded articles.",
      operationId: "research.project.create",
      responses: {
        200: {
          description: "Created research project",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  project_id: z.string(),
                  research_project_id: z.string(),
                  articles: z.array(z.object({ article_id: z.string(), path: z.string() })),
                  background_path: z.string().nullable(),
                  goal_path: z.string().nullable(),
                }),
              ),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("json", createSchema),
    async (c) => {
      // todo 增加事务， 创建失败时删除临时文件!!!!

      const body = c.req.valid("json")
      const target = Filesystem.resolve(body.targetPath)

      if (await Filesystem.exists(target)) {
        return c.json({ success: false, message: "target path already exists" }, 400)
      }

      const paperSources = body.papers
      for (const src of paperSources) {
        if (!(await Filesystem.exists(src))) {
          return c.json({ success: false, message: `paper not found: ${src}` }, 400)
        }
        if (!(await Filesystem.isDir(src)) && path.extname(src).toLowerCase() !== ".pdf") {
          return c.json({ success: false, message: `unsupported article source: ${src}` }, 400)
        }
      }
      if (body.backgroundPath && !(await Filesystem.exists(body.backgroundPath))) {
        return c.json({ success: false, message: "background file not found" }, 400)
      }
      if (body.goalPath && !(await Filesystem.exists(body.goalPath))) {
        return c.json({ success: false, message: "goal file not found" }, 400)
      }

      await Filesystem.write(path.join(target, ".keep"), "")
      await Filesystem.write(path.join(target, "articles", ".keep"), "")
      await Filesystem.write(path.join(target, ".gitignore"), "/code/\n")

      const articlesDir = path.join(target, "articles")
      const paperTargets: { src: string; dest: string }[] = paperSources.map((src) => {
        const dest = path.join(articlesDir, path.basename(src))
        return { src, dest }
      })

      const backgroundDest = body.backgroundPath ? path.join(target, path.basename(body.backgroundPath)) : undefined
      const goalDest = body.goalPath ? path.join(target, path.basename(body.goalPath)) : undefined

      for (const file of paperTargets) {
        if (await Filesystem.exists(file.dest)) {
          return c.json({ success: false, message: `paper already exists at destination: ${file.dest}` }, 400)
        }
      }
      if (backgroundDest && (await Filesystem.exists(backgroundDest))) {
        return c.json({ success: false, message: "background destination already exists" }, 400)
      }
      if (goalDest && (await Filesystem.exists(goalDest))) {
        return c.json({ success: false, message: "goal destination already exists" }, 400)
      }

      for (const file of paperTargets) await copyFile(file.src, file.dest)
      if (backgroundDest && body.backgroundPath) await copyFile(body.backgroundPath, backgroundDest)
      if (goalDest && body.goalPath) await copyFile(body.goalPath, goalDest)

      let project: Awaited<ReturnType<typeof Project.fromDirectory>>
      try {
        const hasGit = await Filesystem.exists(path.join(target, ".git"))
        if (!hasGit) {
          const init = await git(["init", "--quiet"], {
            cwd: target,
          })
          if (init.exitCode !== 0) throw new Error(gitError(init, "failed to initialize git repository"))

          const add = await git(["add", "."], {
            cwd: target,
          })
          if (add.exitCode !== 0) throw new Error(gitError(add, "failed to stage initial research project files"))

          const commit = await git(["commit", "-m", "init", "--allow-empty"], {
            cwd: target,
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "OpenCode",
              GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "opencode@local",
              GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "OpenCode",
              GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "opencode@local",
            },
          })
          if (commit.exitCode !== 0) throw new Error(gitError(commit, "failed to create initial git commit"))
        }
        project = await Project.fromDirectory(target)
        if (project.project.id === "global") throw new Error("failed to resolve initialized project id")

        const existing = Database.use((db) =>
          db
            .select({ research_project_id: ResearchProjectTable.research_project_id })
            .from(ResearchProjectTable)
            .where(eq(ResearchProjectTable.project_id, project.project.id))
            .get(),
        )
        if (existing) {
          return c.json(
            {
              success: false,
              message: "research project already exists for this git repository",
              research_project_id: existing.research_project_id,
              project_id: project.project.id,
            },
            400,
          )
        }
      } catch (err) {
        return c.json({ success: false, message: "failed to create project", error: `${err}` }, 400)
      }

      const result = Database.transaction(() => {
        const now = Date.now()
        const researchProjectID = uniqueID()

        Database.use((db) =>
          db
            .insert(ResearchProjectTable)
            .values({
              research_project_id: researchProjectID,
              project_id: project.project.id,
              background_path: backgroundDest ?? null,
              goal_path: goalDest ?? null,
              time_created: now,
              time_updated: now,
            })
            .run(),
        )

        const articles = paperTargets.map((file) => ({
          article_id: uniqueID(),
          research_project_id: researchProjectID,
          path: file.dest,
          code_path: null,
          time_created: now,
          time_updated: now,
        }))
        if (articles.length > 0) Database.use((db) => db.insert(ArticleTable).values(articles).run())

        return {
          project_id: project.project.id,
          research_project_id: researchProjectID,
          articles: articles.map((a) => ({ article_id: a.article_id, path: a.path })),
          background_path: backgroundDest ?? null,
          goal_path: goalDest ?? null,
        }
      })

      return c.json(result)
    },
  )
  .post(
    "/project/:researchProjectId/article",
    describeRoute({
      summary: "Add article to research project",
      description: "Add a single article (paper/PDF) to an existing research project.",
      operationId: "research.article.create",
      responses: {
        200: {
          description: "Created article",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  article_id: z.string(),
                  path: z.string(),
                  title: z.string().nullable(),
                  source_url: z.string().nullable(),
                }),
              ),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "json",
      z.object({
        sourcePath: z.string().min(1, "sourcePath required"),
        title: z.string().optional(),
        sourceUrl: z.string().optional(),
      }),
    ),
    async (c) => {
      const researchProjectId = c.req.param("researchProjectId")
      const body = c.req.valid("json")

      const project = Database.use((db) =>
        db
          .select()
          .from(ResearchProjectTable)
          .where(eq(ResearchProjectTable.research_project_id, researchProjectId))
          .get(),
      )
      if (!project) {
        return c.json({ success: false, message: "research project not found" }, 404)
      }

      const sourcePath = Filesystem.resolve(body.sourcePath)
      if (!(await Filesystem.exists(sourcePath))) {
        return c.json({ success: false, message: `source file not found: ${body.sourcePath}` }, 400)
      }
      if (!(await Filesystem.isDir(sourcePath)) && path.extname(sourcePath).toLowerCase() !== ".pdf") {
        return c.json({ success: false, message: `unsupported article source: ${body.sourcePath}` }, 400)
      }

      const projectInfo = Database.use((db) =>
        db.select().from(ProjectTable).where(eq(ProjectTable.id, project.project_id)).get(),
      )
      if (!projectInfo) {
        return c.json({ success: false, message: "project not found" }, 404)
      }
      const articlesDir = path.join(projectInfo.worktree, "articles")
      await Filesystem.write(path.join(articlesDir, ".keep"), "")

      const destPath = path.join(articlesDir, path.basename(sourcePath))
      if (await Filesystem.exists(destPath)) {
        return c.json({ success: false, message: `article already exists: ${path.basename(sourcePath)}` }, 400)
      }

      await copyFile(sourcePath, destPath)

      const now = Date.now()
      const articleId = uniqueID()

      Database.use((db) =>
        db
          .insert(ArticleTable)
          .values({
            article_id: articleId,
            research_project_id: researchProjectId,
            path: destPath,
            code_path: null,
            title: body.title ?? null,
            source_url: body.sourceUrl ?? null,
            status: "pending",
            time_created: now,
            time_updated: now,
          })
          .run(),
      )

      return c.json({
        article_id: articleId,
        path: destPath,
        title: body.title ?? null,
        source_url: body.sourceUrl ?? null,
      })
    },
  )
  .post(
    "/atom/:atomId/session",
    describeRoute({
      summary: "Create or get session for an atom",
      description:
        "If the atom already has a session, returns its session ID. Otherwise creates a new session and binds it to the atom.",
      operationId: "research.atom.session.create",
      responses: {
        200: {
          description: "Session ID for the atom",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  session_id: z.string(),
                  created: z.boolean(),
                }),
              ),
            },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const atomId = c.req.param("atomId")

      const atom = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, atomId)).get())
      if (!atom) {
        return c.json({ success: false, message: `atom not found: ${atomId}` }, 404)
      }

      if (atom.session_id) {
        const existing = await Session.get(atom.session_id).catch(() => undefined)
        if (existing && !existing.time.archived) {
          return c.json({ session_id: atom.session_id, created: false })
        }
      }

      const session = await Session.create({ title: `Atom: ${atom.atom_name}` })

      Database.use((db) =>
        db
          .update(AtomTable)
          .set({ session_id: session.id, time_updated: Date.now() })
          .where(eq(AtomTable.atom_id, atomId))
          .run(),
      )

      return c.json({ session_id: session.id, created: true })
    },
  )
  .get(
    "/session/:sessionId/atom",
    describeRoute({
      summary: "Get atom by session ID",
      description: "Query the atom associated with a given session ID. Returns null if no atom found for this session.",
      operationId: "research.session.atom.get",
      responses: {
        200: {
          description: "Atom associated with the session",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  atom: atomSchema.extend({ experiments: z.array(experimentSchema) }).nullable(),
                }),
              ),
            },
          },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      const sessionId = c.req.param("sessionId")

      // First check if the session exists
      const session = await Session.get(sessionId).catch(() => undefined)
      if (!session) {
        return c.json({ success: false, message: `session not found: ${sessionId}` }, 404)
      }

      // Resolve to parent session ID before querying atom
      const parentSessionId = (await Research.getParentSessionId(sessionId)) ?? sessionId

      // Query the atom that has the matching session_id
      const atom = Database.use((db) =>
        db.select().from(AtomTable).where(eq(AtomTable.session_id, parentSessionId)).get(),
      )

      if (!atom) {
        return c.json({ atom: null })
      }

      const experiments = Database.use((db) =>
        db.select().from(ExperimentTable).where(eq(ExperimentTable.atom_id, atom.atom_id)).all(),
      )

      return c.json({ atom: { ...atom, experiments: experiments.map(withRemoteServerConfig) } })
    },
  )
  .get(
    "/code-paths",
    describeRoute({
      summary: "List available code paths",
      description:
        "List subdirectories under the research project's code/ directory that can be used as experiment code paths.",
      operationId: "research.codePaths",
      responses: {
        200: {
          description: "List of code paths",
          content: {
            "application/json": {
              schema: resolver(z.array(z.object({ name: z.string(), path: z.string() }))),
            },
          },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      const codeDir = path.join(Instance.directory, "code")
      if (!fs.existsSync(codeDir)) {
        return c.json([])
      }
      const entries = fs.readdirSync(codeDir, { withFileTypes: true })
      const codePaths = entries
        .filter((e) => e.isDirectory())
        .map((e) => ({
          name: e.name,
          path: path.join(codeDir, e.name),
        }))
      return c.json(codePaths)
    },
  )
  .post(
    "/experiment",
    describeRoute({
      summary: "Create experiment for an atom",
      description:
        "Create a new experiment for a given atom. Creates a dedicated session, sets up result paths, and inserts the experiment record.",
      operationId: "research.experiment.create",
      responses: {
        200: {
          description: "Created experiment",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  exp_id: z.string(),
                  atom_id: z.string(),
                  atom_name: z.string(),
                  session_id: z.string(),
                  baseline_branch: z.string(),
                  exp_branch: z.string(),
                  exp_result_path: z.string(),
                  exp_result_summary_path: z.string(),
                }),
              ),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "json",
      z.object({
        atomId: z.string().min(1, "atomId required"),
        baselineBranch: z.string().optional().default("master"),
        remoteServerId: z.string().optional(),
        codePath: z.string().min(1, "codePath required"),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json")

      const atom = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, body.atomId)).get())
      if (!atom) {
        return c.json({ success: false, message: `atom not found: ${body.atomId}` }, 404)
      }
      const expId = uniqueID()
      const session = await Session.create({ title: `Exp: ${atom.atom_name}` })

      const expDir = path.join(Instance.directory, "exp_results", expId)
      const expResultPath = path.join(expDir, "result.wandb")
      const expResultSummaryPath = path.join(expDir, "summary.md")
      const expPlanPath = path.join(expDir, "plan.md")

      await Filesystem.write(path.join(expDir, ".keep"), "")
      await Filesystem.write(expPlanPath, "")

      const now = Date.now()
      Database.use((db) =>
        db
          .insert(ExperimentTable)
          .values({
            exp_id: expId,
            research_project_id: atom.research_project_id,
            atom_id: body.atomId,
            exp_session_id: session.id,
            baseline_branch_name: body.baselineBranch,
            exp_branch_name: expId,
            exp_result_path: expResultPath,
            exp_result_summary_path: expResultSummaryPath,
            exp_plan_path: expPlanPath,
            code_path: body.codePath,
            remote_server_id: body.remoteServerId ?? null,
            status: "pending",
            time_created: now,
            time_updated: now,
          })
          .run(),
      )

      return c.json({
        exp_id: expId,
        atom_id: body.atomId,
        atom_name: atom.atom_name,
        session_id: session.id,
        baseline_branch: body.baselineBranch,
        exp_branch: expId,
        exp_result_path: expResultPath,
        exp_result_summary_path: expResultSummaryPath,
        remote_server_config: resolveRemoteServerConfig(body.remoteServerId ?? null),
      })
    },
  )
  .post(
    "/experiment/:expId/ready",
    describeRoute({
      summary: "Prepare experiment environment",
      description:
        "Initialise git if needed, check for conflicts with other running experiments on the same article, and switch to the experiment branch.",
      operationId: "research.experiment.ready",
      responses: {
        200: {
          description: "Experiment is ready",
          content: {
            "application/json": {
              schema: resolver(z.object({ ready: z.literal(true) })),
            },
          },
        },
        404: {
          description: "Experiment, atom, or article not found",
          content: {
            "application/json": {
              schema: resolver(z.object({ ready: z.literal(false), message: z.string() })),
            },
          },
        },
        409: {
          description: "Another experiment is already running on the same article",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  ready: z.literal(false),
                  message: z.string(),
                  conflicts: z.array(z.object({ exp_id: z.string(), exp_session_id: z.string().nullable() })),
                }),
              ),
            },
          },
        },
        500: {
          description: "Git or branch operation failed",
          content: {
            "application/json": {
              schema: resolver(z.object({ ready: z.literal(false), message: z.string() })),
            },
          },
        },
      },
    }),
    async (c) => {
      const expId = c.req.param("expId")
      const result = await checkExperimentReadyByExpId(expId)

      if (result.ready) {
        return c.json({ ready: true as const })
      }

      switch (result.reason) {
        case "not_found":
          return c.json({ ready: false as const, message: result.message }, 404)
        case "conflict":
          return c.json({ ready: false as const, message: result.message, conflicts: result.conflicts }, 409)
        case "git_error":
          return c.json({ ready: false as const, message: result.message }, 500)
      }
    },
  )
  .get(
    "/experiment/session/:sessionId",
    describeRoute({
      summary: "Get experiment by session",
      description:
        "Resolve the experiment linked to a session (walks up to parent session). Returns the experiment, its linked atom, and the atom's article. Each field is independently nullable.",
      operationId: "research.experiment.bySession",
      responses: {
        200: {
          description: "Experiment with linked atom and article",
          content: {
            "application/json": {
              schema: resolver(experimentSessionResponseSchema),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    async (c) => {
      const sessionId = c.req.param("sessionId")
      const session = await Session.get(sessionId).catch(() => undefined)
      if (!session) {
        return c.json({ success: false, message: `session not found: ${sessionId}` }, 404)
      }

      const parentSessionId = (await Research.getParentSessionId(sessionId)) ?? sessionId

      const experiment = Database.use((db) =>
        db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_session_id, parentSessionId)).get(),
      )
      if (!experiment) {
        return c.json(null satisfies z.infer<typeof experimentSessionResponseSchema>)
      }

      const atom = experiment.atom_id
        ? (Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, experiment.atom_id!)).get()) ??
          null)
        : null

      const article = atom?.article_id
        ? (Database.use((db) =>
            db.select().from(ArticleTable).where(eq(ArticleTable.article_id, atom.article_id!)).get(),
          ) ?? null)
        : null

      return c.json({
        ...withRemoteServerConfig(experiment),
        atom,
        article,
      } satisfies z.infer<typeof experimentSessionResponseSchema>)
    },
  )
  .get(
    "/experiment/:expId/diff",
    describeRoute({
      summary: "Get experiment branch diff",
      description: "Compare the experiment branch against its baseline branch and return file diffs grouped by commit.",
      operationId: "research.experiment.diff",
      responses: {
        200: {
          description: "Commits with file diffs",
          content: {
            "application/json": {
              schema: resolver(experimentDiffResponseSchema),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    async (c) => {
      const expId = c.req.param("expId")

      const experiment = Database.use((db) =>
        db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, expId)).get(),
      )
      if (!experiment) {
        return c.json({ success: false, message: `experiment not found: ${expId}` }, 404)
      }

      const { exp_branch_name: expBranch, baseline_branch_name: baselineBranch } = experiment
      if (!expBranch || !baselineBranch) {
        return c.json({ success: false, message: "experiment missing branch configuration" }, 400)
      }

      const codePath = experiment.code_path

      // Verify branches exist
      const expExists = await git(["rev-parse", "--verify", expBranch], { cwd: codePath })
      if (expExists.exitCode !== 0) {
        return c.json({ success: false, message: `experiment branch "${expBranch}" not found` }, 400)
      }
      const baseExists = await git(["rev-parse", "--verify", baselineBranch], { cwd: codePath })
      if (baseExists.exitCode !== 0) {
        return c.json({ success: false, message: `baseline branch "${baselineBranch}" not found` }, 400)
      }

      // Get commit list: baseline..exp (newest first)
      const logResult = await git(["log", "--format=%H%n%s%n%an%n%aI", `${baselineBranch}..${expBranch}`], {
        cwd: codePath,
      })
      if (logResult.exitCode !== 0) {
        return c.json({ success: false, message: "failed to list commits" }, 400)
      }

      const logLines = logResult.text().trim().split("\n").filter(Boolean)
      const commits: z.infer<typeof commitDiffSchema>[] = []

      // Parse commits (every 4 lines = one commit)
      for (let i = 0; i + 3 < logLines.length; i += 4) {
        const hash = logLines[i]
        const message = logLines[i + 1]
        const author = logLines[i + 2]
        const date = logLines[i + 3]

        // Skip auto-generated gitignore commits
        if (message === "update .gitignore") continue

        // Diff this commit against its parent, filtering out .gitignore
        const diffs = (await computeExperimentDiff(codePath, `${hash}^`, hash)).filter((d) => d.file !== ".gitignore")
        if (diffs.length === 0) continue

        commits.push({ hash, message, author, date, diffs })
      }

      // Uncommitted changes (working tree vs latest commit on exp branch) — shown first
      const uncommittedDiffs = (await computeExperimentDiff(codePath, expBranch)).filter((d) => d.file !== ".gitignore")
      if (uncommittedDiffs.length > 0) {
        commits.unshift({
          hash: "working-tree",
          message: "Uncommitted changes",
          author: "",
          date: "",
          diffs: uncommittedDiffs,
        })
      }

      return c.json({ commits } satisfies z.infer<typeof experimentDiffResponseSchema>)
    },
  )
  .get(
    "/project/:researchProjectId/session-tree",
    describeRoute({
      summary: "Get session tree for research project",
      description:
        "Returns atoms with their linked sessions and experiments, plus lists of atom/experiment session IDs for filtering from the normal session list.",
      operationId: "research.project.sessionTree",
      responses: {
        200: {
          description: "Session tree",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  atomSessionIds: z.array(z.string()),
                  expSessionIds: z.array(z.string()),
                  atoms: z.array(
                    z.object({
                      atom_id: z.string(),
                      atom_name: z.string(),
                      atom_type: z.string(),
                      atom_evidence_status: z.string(),
                      session_id: z.string().nullable(),
                      experiments: z.array(
                        z.object({
                          exp_id: z.string(),
                          exp_session_id: z.string().nullable(),
                          status: z.enum(["pending", "running", "done", "idle", "failed"]),
                        }),
                      ),
                    }),
                  ),
                }),
              ),
            },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const researchProjectId = c.req.param("researchProjectId")

      const project = Database.use((db) =>
        db
          .select()
          .from(ResearchProjectTable)
          .where(eq(ResearchProjectTable.research_project_id, researchProjectId))
          .get(),
      )
      if (!project) {
        return c.json({ success: false, message: "research project not found" }, 404)
      }

      const atoms = Database.use((db) =>
        db.select().from(AtomTable).where(eq(AtomTable.research_project_id, researchProjectId)).all(),
      )

      const experiments = Database.use((db) =>
        db.select().from(ExperimentTable).where(eq(ExperimentTable.research_project_id, researchProjectId)).all(),
      )

      const atomSessionIds: string[] = []
      const expSessionIds: string[] = []

      for (const atom of atoms) {
        if (atom.session_id) atomSessionIds.push(atom.session_id)
      }
      for (const exp of experiments) {
        if (exp.exp_session_id) expSessionIds.push(exp.exp_session_id)
      }

      const expsByAtom = new Map<string, typeof experiments>()
      for (const exp of experiments) {
        if (!exp.atom_id) continue
        const list = expsByAtom.get(exp.atom_id)
        if (list) list.push(exp)
        else expsByAtom.set(exp.atom_id, [exp])
      }

      const atomTree = atoms.map((atom) => ({
        atom_id: atom.atom_id,
        atom_name: atom.atom_name,
        atom_type: atom.atom_type,
        atom_evidence_status: atom.atom_evidence_status,
        session_id: atom.session_id,
        experiments: (expsByAtom.get(atom.atom_id) ?? []).map((exp) => ({
          exp_id: exp.exp_id,
          exp_session_id: exp.exp_session_id,
          status: exp.status,
          remote_server_config: resolveRemoteServerConfig(exp.remote_server_id),
        })),
      }))

      return c.json({
        atomSessionIds,
        expSessionIds,
        atoms: atomTree,
      })
    },
  )
  // ── Remote Server CRUD ──
  .get(
    "/server",
    describeRoute({
      summary: "List all remote servers",
      operationId: "research.server.list",
      responses: {
        200: {
          description: "List of remote servers",
          content: {
            "application/json": {
              schema: resolver(
                z.array(
                  z.object({
                    id: z.string(),
                    config: remoteServerConfigSchema,
                    time_created: z.number(),
                    time_updated: z.number(),
                  }),
                ),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      const servers = Database.use((db) => db.select().from(RemoteServerTable).all())
      return c.json(
        servers.map((s) => ({
          id: s.id,
          config: JSON.parse(s.config),
          time_created: s.time_created,
          time_updated: s.time_updated,
        })),
      )
    },
  )
  .post(
    "/server",
    describeRoute({
      summary: "Create a remote server",
      operationId: "research.server.create",
      responses: {
        200: {
          description: "Created remote server",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  id: z.string(),
                  config: remoteServerConfigSchema,
                }),
              ),
            },
          },
        },
      },
    }),
    validator(
      "json",
      z.object({
        config: remoteServerConfigSchema,
      }),
    ),
    async (c) => {
      const body = c.req.valid("json")
      const id = uniqueID()
      const now = Date.now()
      Database.use((db) =>
        db
          .insert(RemoteServerTable)
          .values({
            id,
            config: JSON.stringify(body.config),
            time_created: now,
            time_updated: now,
          })
          .run(),
      )
      return c.json({ id, config: body.config })
    },
  )
  .delete(
    "/server/:serverId",
    describeRoute({
      summary: "Delete a remote server",
      operationId: "research.server.delete",
      responses: {
        200: {
          description: "Deleted",
          content: {
            "application/json": {
              schema: resolver(z.object({ success: z.boolean() })),
            },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const serverId = c.req.param("serverId")
      const server = Database.use((db) =>
        db.select().from(RemoteServerTable).where(eq(RemoteServerTable.id, serverId)).get(),
      )
      if (!server) {
        return c.json({ success: false, message: `server not found: ${serverId}` }, 404)
      }
      Database.use((db) =>
        db
          .update(ExperimentTable)
          .set({ remote_server_id: null })
          .where(eq(ExperimentTable.remote_server_id, serverId))
          .run(),
      )
      Database.use((db) => db.delete(RemoteServerTable).where(eq(RemoteServerTable.id, serverId)).run())
      return c.json({ success: true })
    },
  )
  // ── Experiment watch list ──
  .get(
    "/experiment-watch",
    describeRoute({
      summary: "List all watch records",
      operationId: "research.experimentWatch.list",
      responses: {
        200: {
          description: "Watch list",
          content: {
            "application/json": {
              schema: resolver(z.array(watchListItemSchema)),
            },
          },
        },
      },
    }),
    async (c) => {
      // Resolve current project's research_project_id
      const projectId = Instance.project.id
      const researchProject = Database.use((db) =>
        db.select().from(ResearchProjectTable).where(eq(ResearchProjectTable.project_id, projectId)).get(),
      )

      // Get experiments scoped to this research project
      const experiments = researchProject
        ? Database.use((db) =>
            db
              .select()
              .from(ExperimentTable)
              .where(eq(ExperimentTable.research_project_id, researchProject.research_project_id))
              .all(),
          )
        : []
      const expMap = new Map(experiments.map((e) => [e.exp_id, e]))
      const expIds = new Set(experiments.map((e) => e.exp_id))

      const executionWatches = Database.use((db) => db.select().from(ExperimentExecutionWatchTable).all()).filter((w) =>
        expIds.has(w.exp_id),
      )
      const localWatches = Database.use((db) => db.select().from(LocalDownloadWatchTable).all()).filter((w) =>
        expIds.has(w.exp_id),
      )
      const localMap = new Map(
        [...localWatches].sort((a, b) => b.time_updated - a.time_updated).map((w) => [w.exp_id, w] as const),
      )

      return c.json(
        executionWatches
          .map((w) => {
            const exp = expMap.get(w.exp_id)
            const local = localMap.get(w.exp_id)
            return {
              watch_id: w.watch_id,
              kind: "experiment" as const,
              exp_id: w.exp_id,
              exp_session_id: exp?.exp_session_id ?? null,
              exp_result_path: exp?.exp_result_path ?? null,
              title: w.title,
              status: w.status,
              stage: w.stage,
              message: w.message,
              error_message: w.error_message,
              started_at: w.started_at,
              finished_at: w.finished_at,
              time_created: w.time_created,
              time_updated: w.time_updated,
              wandb_entity: w.wandb_entity,
              wandb_project: w.wandb_project,
              wandb_run_id: w.wandb_run_id,
              local_download_resource_name: local?.resource_name ?? null,
              local_download_local_path: local?.local_path ?? null,
              local_download_log_path: local?.log_path ?? null,
              local_download_status_path: local?.status_path ?? null,
            }
          })
          .sort((a, b) => b.time_updated - a.time_updated),
      )
    },
  )
  // ── Experiment result runs ──
  .get(
    "/experiment/:expId/runs",
    describeRoute({
      summary: "List W&B run result directories for an experiment",
      operationId: "research.experiment.runs",
      responses: {
        200: {
          description: "List of run directories with their files",
          content: {
            "application/json": {
              schema: resolver(
                z.array(
                  z.object({
                    name: z.string(),
                    path: z.string(),
                    files: z.array(z.string()),
                  }),
                ),
              ),
            },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const expId = c.req.param("expId")
      const experiment = Database.use((db) =>
        db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, expId)).get(),
      )
      if (!experiment) {
        return c.json({ success: false, message: `experiment not found: ${expId}` }, 404)
      }
      if (!experiment.exp_result_path) {
        return c.json([])
      }
      const wandbDir = experiment.exp_result_path
      if (!fs.existsSync(wandbDir)) {
        return c.json([])
      }
      const entries = fs.readdirSync(wandbDir, { withFileTypes: true })
      const runs = entries
        .filter((e) => e.isDirectory())
        .map((e) => {
          const runPath = path.join(wandbDir, e.name)
          const files = fs.readdirSync(runPath).filter((f) => fs.statSync(path.join(runPath, f)).isFile())
          return { name: e.name, path: runPath, files }
        })
      return c.json(runs)
    },
  )
  // ── Experiment watch delete ──
  .delete(
    "/experiment-watch/:watchId",
    describeRoute({
      summary: "Delete a watch record",
      operationId: "research.experimentWatch.delete",
      responses: {
        200: {
          description: "Deleted",
          content: {
            "application/json": {
              schema: resolver(z.object({ success: z.boolean() })),
            },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const watchId = c.req.param("watchId")
      const watch = Database.use((db) =>
        db
          .select()
          .from(ExperimentExecutionWatchTable)
          .where(eq(ExperimentExecutionWatchTable.watch_id, watchId))
          .get(),
      )
      if (!watch) {
        return c.json({ success: false, message: `watch not found: ${watchId}` }, 404)
      }
      Database.use((db) =>
        db.delete(ExperimentExecutionWatchTable).where(eq(ExperimentExecutionWatchTable.watch_id, watchId)).run(),
      )
      Database.use((db) => db.delete(ExperimentWatchTable).where(eq(ExperimentWatchTable.exp_id, watch.exp_id)).run())
      Database.use((db) =>
        db.delete(LocalDownloadWatchTable).where(eq(LocalDownloadWatchTable.exp_id, watch.exp_id)).run(),
      )
      return c.json({ success: true })
    },
  )
  // ── Experiment watch force refresh ──
  .post(
    "/experiment-watch/:watchId/refresh",
    describeRoute({
      summary: "Force refresh a watch",
      operationId: "research.experimentWatch.refresh",
      responses: {
        200: {
          description: "Refresh result",
          content: {
            "application/json": {
              schema: resolver(z.object({ success: z.boolean(), message: z.string() })),
            },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const watchId = c.req.param("watchId")
      const watch = Database.use((db) =>
        db
          .select()
          .from(ExperimentExecutionWatchTable)
          .where(eq(ExperimentExecutionWatchTable.watch_id, watchId))
          .get(),
      )
      if (!watch) {
        return c.json({ success: false, message: `watch not found: ${watchId}` }, 404)
      }
      const internal = watch.wandb_run_id
        ? ExperimentExecutionWatch.findInternal(watch.exp_id, watch.wandb_run_id)
        : undefined
      const result =
        watch.stage === "local_downloading"
          ? await forceRefreshLocalDownload(watch.exp_id)
          : internal
            ? await forceRefreshWatch(internal.watch_id)
            : { success: true, message: "execution watch refreshed" }
      if (!result.success && result.message.includes("not found")) {
        return c.json(result, 404)
      }
      return c.json(result)
    },
  )
  // ── Experiment delete & update ──
  .delete(
    "/experiment/:expId",
    describeRoute({
      summary: "Delete an experiment",
      operationId: "research.experiment.delete",
      responses: {
        200: {
          description: "Deleted",
          content: {
            "application/json": {
              schema: resolver(z.object({ success: z.boolean() })),
            },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const expId = c.req.param("expId")
      const experiment = Database.use((db) =>
        db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, expId)).get(),
      )
      if (!experiment) {
        return c.json({ success: false, message: `experiment not found: ${expId}` }, 404)
      }
      // Delete experiment watchers
      Database.use((db) => db.delete(ExperimentWatchTable).where(eq(ExperimentWatchTable.exp_id, expId)).run())
      Database.use((db) => db.delete(LocalDownloadWatchTable).where(eq(LocalDownloadWatchTable.exp_id, expId)).run())
      Database.use((db) =>
        db.delete(ExperimentExecutionWatchTable).where(eq(ExperimentExecutionWatchTable.exp_id, expId)).run(),
      )
      Database.use((db) => db.delete(ExperimentTable).where(eq(ExperimentTable.exp_id, expId)).run())
      if (experiment.exp_session_id) {
        await Session.remove(experiment.exp_session_id).catch(() => {})
      }
      // Delete experiment results directory
      const expDir = path.join(Instance.directory, "exp_results", expId)
      await rm(expDir, { recursive: true, force: true }).catch(() => {})
      // Delete experiment branch from the code repo
      if (experiment.exp_branch_name) {
        const codePath = experiment.code_path
        // Check if we're on the experiment branch; if so, switch away first
        const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: codePath })
        const currentBranch = head.stdout?.toString().trim()
        if (currentBranch === experiment.exp_branch_name) {
          const baseline = experiment.baseline_branch_name || "master"
          await git(["checkout", "-f", baseline], { cwd: codePath }).catch(() => {})
          await git(["clean", "-fd"], { cwd: codePath }).catch(() => {})
        }
        await git(["branch", "-D", experiment.exp_branch_name], { cwd: codePath }).catch(() => {})
      }
      return c.json({ success: true })
    },
  )
  .patch(
    "/experiment/:expId",
    describeRoute({
      summary: "Update experiment baseline branch or remote server",
      operationId: "research.experiment.update",
      responses: {
        200: {
          description: "Updated experiment",
          content: {
            "application/json": {
              schema: resolver(experimentSchema),
            },
          },
        },
        ...errors(404),
      },
    }),
    validator(
      "json",
      z.object({
        baselineBranch: z.string().optional(),
        remoteServerId: z.string().nullable().optional(),
        codePath: z.string().optional(),
      }),
    ),
    async (c) => {
      const expId = c.req.param("expId")
      const body = c.req.valid("json")

      const experiment = Database.use((db) =>
        db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, expId)).get(),
      )
      if (!experiment) {
        return c.json({ success: false, message: `experiment not found: ${expId}` }, 404)
      }

      const updates: Record<string, unknown> = { time_updated: Date.now() }
      if (body.baselineBranch !== undefined) updates.baseline_branch_name = body.baselineBranch
      if (body.remoteServerId !== undefined) updates.remote_server_id = body.remoteServerId
      if (body.codePath !== undefined) updates.code_path = body.codePath

      Database.use((db) => db.update(ExperimentTable).set(updates).where(eq(ExperimentTable.exp_id, expId)).run())

      const updated = Database.use((db) =>
        db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, expId)).get(),
      )!
      return c.json(withRemoteServerConfig(updated))
    },
  )
