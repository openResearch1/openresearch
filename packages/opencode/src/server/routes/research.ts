import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import z from "zod"
import path from "path"
import os from "os"
import { Filesystem } from "@/util/filesystem"
import { Database } from "@/storage/db"
import { Project } from "@/project/project"
import { ProjectTable } from "@/project/project.sql"
import {
  ResearchProjectTable,
  ArticleTable,
  CodeTable,
  AtomTable,
  AtomRelationTable,
  ExperimentTable,
  RemoteServerTable,
  ExperimentExecutionWatchTable,
  ExperimentWatchTable,
  RemoteTaskTable,
} from "@/research/research.sql"
import { and, desc, eq } from "drizzle-orm"
import { Session } from "@/session"
import { linkKinds } from "@/research/research.sql"
import { Bus } from "@/bus"
import { errors } from "../error"
import fs from "fs"
import { rm } from "fs/promises"
import { git } from "@/util/git"
import { Research } from "@/research/research.ts"
import { ensureGitignore, GIT_ENV, gitErr, ensureRepoInitialized } from "@/session/experiment-guard"
import { Instance } from "@/project/instance"
import { Snapshot } from "@/snapshot"
import { computeExperimentDiff } from "@/util/git-diff"
import { checkExperimentReadyByExpId } from "@/session/experiment-guard"
import { forceRefreshWatch } from "@/research/experiment-watcher"
import { forceRefreshRemoteTask } from "@/research/experiment-remote-task-watcher"
import { ExperimentExecutionWatch } from "@/research/experiment-execution-watch"
import { ExperimentRemoteTask } from "@/research/experiment-remote-task"
import { ZipWriter, ZipReader, BlobReader, BlobWriter } from "@zip.js/zip.js"
// @ts-ignore - unzipper has no type declarations
import unzipper from "unzipper"
import {
  normalizeRemoteServerConfig,
  type RemoteServerConfig,
  RemoteServerConfigSchema,
  RemoteServerInputSchema,
} from "@/research/remote-server"
import { parseSshConfig } from "@/research/ssh-config"
import { readRemoteTaskLog } from "@/research/remote-task-runner"

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

/**
 * Check whether a directory looks like a single article source (e.g. LaTeX project)
 * rather than a container that holds multiple articles.
 *
 * A directory is considered an article if it contains at least one `.tex` file at
 * the top level.  A directory that only contains `.pdf` files or sub-directories
 * (but no `.tex` files) is treated as a container folder — not a single article.
 */
async function isArticleDirectory(dir: string): Promise<boolean> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true })
  return entries.some((e) => !e.isDirectory() && e.name.endsWith(".tex"))
}

const uniqueID = () => crypto.randomUUID()
const REMOTE_TASK_VISIBLE_MS = 60 * 1000

function taskVisible(task: ReturnType<typeof ExperimentRemoteTask.current>, now: number) {
  if (!task) return false
  if (task.status === "pending" || task.status === "running") return true
  return task.time_updated + REMOTE_TASK_VISIBLE_MS > now
}

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

const experimentSchema = z.object({
  exp_id: z.string(),
  research_project_id: z.string(),
  exp_name: z.string(),
  exp_session_id: z.string().nullable(),
  baseline_branch_name: z.string().nullable(),
  exp_branch_name: z.string().nullable(),
  exp_result_path: z.string().nullable(),
  atom_id: z.string().nullable(),
  exp_result_summary_path: z.string().nullable(),
  exp_plan_path: z.string().nullable(),
  remote_server_id: z.string().nullable(),
  remote_server_config: RemoteServerConfigSchema.nullable(),
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
  remote_task_title: z.string().nullable(),
  remote_task_kind: z.enum(["resource_download", "experiment_run"]).nullable(),
  remote_task_status: z.enum(["pending", "running", "finished", "failed", "canceled"]).nullable(),
  remote_task_target_path: z.string().nullable(),
  remote_task_screen_name: z.string().nullable(),
  remote_task_log_path: z.string().nullable(),
  remote_task_error_message: z.string().nullable(),
})

const articleSchema = z.object({
  article_id: z.string(),
  research_project_id: z.string(),
  path: z.string(),
  title: z.string().nullable(),
  source_url: z.string().nullable(),
  status: z.enum(["pending", "parsed", "failed"]),
  time_created: z.number(),
  time_updated: z.number(),
})

const watchLogSchema = z.object({
  ok: z.boolean(),
  path: z.string(),
  content: z.string(),
})

const codeSchema = z.object({
  code_id: z.string(),
  research_project_id: z.string(),
  code_name: z.string(),
  article_id: z.string().nullable(),
  time_created: z.number(),
  time_updated: z.number(),
})

const VALID_CODE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const GITHUB_URL_RE = /^https?:\/\/(www\.)?github\.com\/.+\/.+/

function resolveRemoteServerConfig(remoteServerId: string | null): RemoteServerConfig | null {
  if (!remoteServerId) return null
  const server = Database.use((db) =>
    db.select().from(RemoteServerTable).where(eq(RemoteServerTable.id, remoteServerId)).get(),
  )
  if (!server) return null
  try {
    return normalizeRemoteServerConfig(JSON.parse(server.config))
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

const atomCreateSchema = z.object({
  name: z.string().min(1, "name required"),
  type: z.enum(["fact", "method", "theorem", "verification"]),
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
  macro_table_path: z.string().nullable(),
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
      let row = Database.use((db) =>
        db.select().from(ResearchProjectTable).where(eq(ResearchProjectTable.project_id, projectId)).get(),
      )

      // If not found in database, try to recover from memo file
      if (!row) {
        try {
          let project
          try {
            project = await Project.get(projectId)
          } catch (err) {
            project = undefined
          }

          if (project) {
            const memoPath = path.join(project.worktree, ".opencode-research.json")
            if (await Filesystem.exists(memoPath)) {
              const memo = await Filesystem.readJson<{ research_project_id: string; project_id: string }>(memoPath)

              // Check if this research project exists in database
              const existingResearch = Database.use((db) =>
                db
                  .select()
                  .from(ResearchProjectTable)
                  .where(eq(ResearchProjectTable.research_project_id, memo.research_project_id))
                  .get(),
              )

              if (existingResearch) {
                // Update the project_id to current one
                Database.use((db) =>
                  db
                    .update(ResearchProjectTable)
                    .set({ project_id: projectId, time_updated: Date.now() })
                    .where(eq(ResearchProjectTable.research_project_id, memo.research_project_id))
                    .run(),
                )

                // Fetch the updated row
                row = Database.use((db) =>
                  db.select().from(ResearchProjectTable).where(eq(ResearchProjectTable.project_id, projectId)).get(),
                )
              }
            }
          }
        } catch (err) {
          // Silently fail recovery attempt
        }
      }

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
    "/project/:researchProjectId/atom",
    describeRoute({
      summary: "Create atom",
      description: "Create a lightweight atom with starter claim and evidence files.",
      operationId: "research.atom.create",
      responses: {
        200: {
          description: "Created atom",
          content: {
            "application/json": {
              schema: resolver(atomSchema),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator("json", atomCreateSchema),
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
        return c.json({ success: false, message: `research project not found: ${researchProjectId}` }, 404)
      }

      const atomId = uniqueID()
      const atomDir = path.join(Instance.directory, "atom_list", atomId)
      const claimPath = path.join(atomDir, "claim.md")
      const evidencePath = path.join(atomDir, "evidence.md")
      const evidenceAssessmentPath = path.join(atomDir, "evidence_assessment.md")

      await Filesystem.write(claimPath, "# Claim\n")
      await Filesystem.write(evidencePath, "# Evidence\n")
      await Filesystem.write(evidenceAssessmentPath, "")

      const now = Date.now()
      Database.use((db) =>
        db
          .insert(AtomTable)
          .values({
            atom_id: atomId,
            research_project_id: researchProjectId,
            atom_name: body.name.trim(),
            atom_type: body.type,
            atom_claim_path: claimPath,
            atom_evidence_type: "math",
            atom_evidence_status: "pending",
            atom_evidence_path: evidencePath,
            atom_evidence_assessment_path: evidenceAssessmentPath,
            article_id: null,
            session_id: null,
            time_created: now,
            time_updated: now,
          })
          .run(),
      )

      await Bus.publish(Research.Event.AtomsUpdated, { researchProjectId })

      const atom = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, atomId)).get())
      if (!atom) {
        return c.json({ success: false, message: `atom not found after create: ${atomId}` }, 404)
      }

      return c.json(atom)
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
        // Remove experiment worktree and branch
        if (exp.exp_branch_name) {
          const baseRepo = path.resolve(exp.code_path, "../..")
          await git(["worktree", "remove", exp.code_path, "--force"], { cwd: baseRepo }).catch(() => {})
          await git(["branch", "-D", exp.exp_branch_name], { cwd: baseRepo }).catch(() => {})
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
    "/upload",
    describeRoute({
      summary: "Upload files",
      description: "Upload files to a temporary directory and return their server-side paths.",
      operationId: "research.upload",
      responses: {
        200: {
          description: "Uploaded file paths",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  paths: z.array(z.string()),
                }),
              ),
            },
          },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      const formData = await c.req.formData()
      const files = formData.getAll("files")

      if (files.length === 0) {
        return c.json({ success: false, message: "no files provided" }, 400)
      }

      const uploadDir = path.join(os.tmpdir(), "opencode-uploads", uniqueID())
      await fs.promises.mkdir(uploadDir, { recursive: true })

      const paths: string[] = []
      for (const file of files) {
        if (!(file instanceof File)) continue
        if (!file.name.toLowerCase().endsWith(".pdf")) continue
        const dest = path.join(uploadDir, file.name)
        const buffer = Buffer.from(await file.arrayBuffer())
        await fs.promises.writeFile(dest, buffer)
        paths.push(dest)
      }

      if (paths.length === 0) {
        return c.json({ success: false, message: "no valid PDF files in upload" }, 400)
      }

      return c.json({ paths })
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
                  macro_table_path: z.string().nullable(),
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
        if (await Filesystem.isDir(src)) {
          if (!(await isArticleDirectory(src))) {
            return c.json(
              {
                success: false,
                message:
                  `"${path.basename(src)}" looks like a folder containing articles, not a single article. ` +
                  `Please select individual PDF files or LaTeX source folders instead.`,
              },
              400,
            )
          }
        } else if (path.extname(src).toLowerCase() !== ".pdf") {
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

        // Invalidate Instance cache so subsequent requests return the correct project ID
        await Instance.reload({
          directory: target,
          worktree: target,
          project: project.project,
        }).catch(() => {})

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
              macro_table_path: null,
              time_created: now,
              time_updated: now,
            })
            .run(),
        )

        const articles = paperTargets.map((file) => ({
          article_id: uniqueID(),
          research_project_id: researchProjectID,
          path: file.dest,
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
          macro_table_path: null,
        }
      })

      // Write research project ID to a memo file in the project directory
      // This allows recovery of the association if the project is deleted and reloaded
      const memoPath = path.join(target, ".opencode-research.json")
      await Filesystem.write(
        memoPath,
        JSON.stringify(
          {
            research_project_id: result.research_project_id,
            project_id: result.project_id,
            created_at: Date.now(),
          },
          null,
          2,
        ),
      )

      return c.json(result)
    },
  )
  .get(
    "/project/:researchProjectId/articles",
    describeRoute({
      summary: "List articles for a research project",
      description: "Return article IDs and file names for a research project, useful for dropdown selectors.",
      operationId: "research.article.list",
      responses: {
        200: {
          description: "List of articles",
          content: {
            "application/json": {
              schema: resolver(
                z.array(
                  z.object({
                    article_id: z.string(),
                    filename: z.string(),
                    title: z.string().nullable(),
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
      const articles = Database.use((db) =>
        db.select().from(ArticleTable).where(eq(ArticleTable.research_project_id, researchProjectId)).all(),
      )
      return c.json(
        articles.map((a) => ({
          article_id: a.article_id,
          filename: a.path.split("/").pop() ?? a.path,
          title: a.title,
        })),
      )
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
      if (await Filesystem.isDir(sourcePath)) {
        if (!(await isArticleDirectory(sourcePath))) {
          return c.json(
            {
              success: false,
              message:
                `"${path.basename(sourcePath)}" looks like a folder containing articles, not a single article. ` +
                `Please select individual PDF files or LaTeX source folders instead.`,
            },
            400,
          )
        }
      } else if (path.extname(sourcePath).toLowerCase() !== ".pdf") {
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
  .get(
    "/branches",
    describeRoute({
      summary: "List git branches for a code path",
      description:
        "List local git branches under the given code path. If a branch is associated with an experiment, returns the experiment name as displayName.",
      operationId: "research.branches",
      responses: {
        200: {
          description: "List of branches",
          content: {
            "application/json": {
              schema: resolver(
                z.array(
                  z.object({
                    branch: z.string(),
                    displayName: z.string(),
                    experimentId: z.string().nullable(),
                  }),
                ),
              ),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "query",
      z.object({
        codePath: z.string().min(1, "codePath required"),
      }),
    ),
    async (c) => {
      const { codePath } = c.req.valid("query")

      if (!fs.existsSync(codePath)) {
        return c.json({ success: false, message: `codePath not found: ${codePath}` }, 400)
      }

      const result = await git(["branch", "--format=%(refname:short)"], { cwd: codePath })
      if (result.exitCode !== 0) {
        return c.json({ success: false, message: `git error: ${result.stderr.toString()}` }, 400)
      }

      const raw = result.text().trim()
      if (!raw) {
        return c.json([])
      }

      const branches: string[] = []
      for (const line of raw.split("\n")) {
        const name = line.trim()
        if (!name) continue
        branches.push(name)
      }

      // find experiments linked to these branches
      const experiments = Database.use((db) => db.select().from(ExperimentTable).all())
      const expByBranch = new Map<string, { expId: string; expName: string }>()
      for (const exp of experiments) {
        if (exp.exp_branch_name) {
          expByBranch.set(exp.exp_branch_name, { expId: exp.exp_id, expName: exp.exp_name })
        }
      }

      const items = branches.map((branch) => {
        const exp = expByBranch.get(branch)
        return {
          branch,
          displayName: exp ? exp.expName : branch,
          experimentId: exp ? exp.expId : null,
        }
      })

      return c.json(items)
    },
  )
  // ── Code CRUD ──
  .get(
    "/project/:researchProjectId/codes",
    describeRoute({
      summary: "List codes for a research project",
      description: "Query all code records belonging to a research project.",
      operationId: "research.code.list",
      responses: {
        200: {
          description: "List of code records",
          content: {
            "application/json": {
              schema: resolver(z.array(codeSchema)),
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
      const codes = Database.use((db) =>
        db.select().from(CodeTable).where(eq(CodeTable.research_project_id, researchProjectId)).all(),
      )
      return c.json(codes)
    },
  )
  .get(
    "/code/:codeId",
    describeRoute({
      summary: "Get a code record",
      description: "Get a single code record by its ID.",
      operationId: "research.code.get",
      responses: {
        200: {
          description: "Code record",
          content: {
            "application/json": {
              schema: resolver(codeSchema),
            },
          },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const codeId = c.req.param("codeId")
      const code = Database.use((db) => db.select().from(CodeTable).where(eq(CodeTable.code_id, codeId)).get())
      if (!code) {
        return c.json({ success: false, message: `code not found: ${codeId}` }, 404)
      }
      return c.json(code)
    },
  )
  .delete(
    "/code/:codeId",
    describeRoute({
      summary: "Delete a code record",
      description: "Delete a code record and its directory on disk.",
      operationId: "research.code.delete",
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
      const codeId = c.req.param("codeId")
      const code = Database.use((db) => db.select().from(CodeTable).where(eq(CodeTable.code_id, codeId)).get())
      if (!code) {
        return c.json({ success: false, message: `code not found: ${codeId}` }, 404)
      }
      const codeDir = path.join(Instance.directory, "code", code.code_name)
      await rm(codeDir, { recursive: true, force: true }).catch(() => {})
      Database.use((db) => db.delete(CodeTable).where(eq(CodeTable.code_id, codeId)).run())
      return c.json({ success: true })
    },
  )
  .post(
    "/project/:researchProjectId/code",
    describeRoute({
      summary: "Create a code record",
      description:
        "Clone a GitHub repository or copy a local directory into the project's code/ directory, and create a code record.",
      operationId: "research.code.create",
      responses: {
        200: {
          description: "Created code record",
          content: {
            "application/json": {
              schema: resolver(codeSchema),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "json",
      z.object({
        codeName: z.string().min(1, "codeName required"),
        source: z.string().min(1, "source required"),
        articleId: z.string().optional(),
      }),
    ),
    async (c) => {
      const researchProjectId = c.req.param("researchProjectId")
      const body = c.req.valid("json")

      // Validate research project
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

      // Validate code_name
      if (!VALID_CODE_NAME_RE.test(body.codeName) || body.codeName === "." || body.codeName === "..") {
        return c.json(
          {
            success: false,
            message:
              "invalid codeName: must start with alphanumeric and contain only letters, digits, dots, hyphens, underscores",
          },
          400,
        )
      }

      // Validate articleId if provided
      if (body.articleId) {
        const article = Database.use((db) =>
          db.select().from(ArticleTable).where(eq(ArticleTable.article_id, body.articleId!)).get(),
        )
        if (!article) {
          return c.json({ success: false, message: `article not found: ${body.articleId}` }, 404)
        }
      }

      const codeDest = path.join(Instance.directory, "code", body.codeName)
      if (await Filesystem.exists(codeDest)) {
        return c.json({ success: false, message: `code directory already exists: ${body.codeName}` }, 400)
      }

      const isGithub = GITHUB_URL_RE.test(body.source)

      if (isGithub) {
        const result = await git(["clone", "--depth", "1", body.source, codeDest], {
          cwd: Instance.directory,
        })
        if (result.exitCode !== 0) {
          const errMsg = result.stderr?.toString().trim() || result.text?.().trim() || "git clone failed"
          return c.json({ success: false, message: `failed to clone repository: ${errMsg}` }, 400)
        }
      } else {
        const srcDir = path.resolve(body.source)
        if (!(await Filesystem.exists(srcDir))) {
          return c.json({ success: false, message: `local directory not found: ${srcDir}` }, 400)
        }
        const stat = fs.statSync(srcDir)
        if (!stat.isDirectory()) {
          return c.json({ success: false, message: `source is not a directory: ${srcDir}` }, 400)
        }
        await fs.promises.mkdir(path.dirname(codeDest), { recursive: true })
        await fs.promises.cp(srcDir, codeDest, { recursive: true })
      }

      // Ensure the code directory is a git repository with proper .gitignore
      const hasGit = await Filesystem.exists(path.join(codeDest, ".git"))
      if (!hasGit) {
        const init = await git(["init", "--quiet"], { cwd: codeDest })
        if (init.exitCode !== 0) {
          await rm(codeDest, { recursive: true, force: true }).catch(() => {})
          return c.json({ success: false, message: `failed to git init: ${gitErr(init, "unknown error")}` }, 500)
        }

        await ensureGitignore(codeDest)

        const add = await git(["add", "."], { cwd: codeDest })
        if (add.exitCode !== 0) {
          await rm(codeDest, { recursive: true, force: true }).catch(() => {})
          return c.json({ success: false, message: `failed to git add: ${gitErr(add, "unknown error")}` }, 500)
        }

        const commit = await git(["commit", "-m", "init", "--allow-empty"], {
          cwd: codeDest,
          env: GIT_ENV,
        })
        if (commit.exitCode !== 0) {
          await rm(codeDest, { recursive: true, force: true }).catch(() => {})
          return c.json({ success: false, message: `failed to git commit: ${gitErr(commit, "unknown error")}` }, 500)
        }
      } else {
        // Pre-existing git repo: ensure .gitignore has required rules
        const changed = await ensureGitignore(codeDest)
        if (changed) {
          await git(["add", ".gitignore"], { cwd: codeDest })
          await git(["commit", "-m", "update .gitignore"], { cwd: codeDest, env: GIT_ENV })
        }
      }

      const now = Date.now()
      const codeId = uniqueID()
      Database.use((db) =>
        db
          .insert(CodeTable)
          .values({
            code_id: codeId,
            research_project_id: researchProjectId,
            code_name: body.codeName,
            article_id: body.articleId ?? null,
            time_created: now,
            time_updated: now,
          })
          .run(),
      )

      const created = Database.use((db) => db.select().from(CodeTable).where(eq(CodeTable.code_id, codeId)).get())!
      return c.json(created)
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
                  exp_name: z.string(),
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
        expName: z.string().min(1, "expName required"),
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
      const session = await Session.create({ title: `Exp: ${body.expName}` })

      const expDir = path.join(Instance.directory, "exp_results", expId)
      const expResultPath = path.join(expDir, "result.wandb")
      const expResultSummaryPath = path.join(expDir, "summary.md")
      const expPlanPath = path.join(expDir, "plan.md")

      await Filesystem.write(path.join(expDir, ".keep"), "")
      await Filesystem.write(expPlanPath, "")

      // Ensure repo is initialised and create worktree for the experiment
      const initResult = await ensureRepoInitialized(body.codePath)
      if (!initResult.ok) {
        return c.json(
          { success: false, message: `Failed to initialise repo at ${body.codePath}: ${initResult.message}` },
          400,
        )
      }

      const baselineExists = await git(["rev-parse", "--verify", body.baselineBranch], { cwd: body.codePath })
      if (baselineExists.exitCode !== 0) {
        return c.json(
          { success: false, message: `baseline branch "${body.baselineBranch}" not found at ${body.codePath}` },
          400,
        )
      }

      const worktreePath = path.join(body.codePath, ".openresearch_worktrees", expId)
      const createWorktree = await git(["worktree", "add", worktreePath, body.baselineBranch, "-b", expId], {
        cwd: body.codePath,
        env: GIT_ENV,
      })
      if (createWorktree.exitCode !== 0) {
        return c.json(
          {
            success: false,
            message: `failed to create worktree for ${expId}: ${createWorktree.stderr?.toString().trim() || "unknown error"}`,
          },
          400,
        )
      }

      const now = Date.now()
      Database.use((db) =>
        db
          .insert(ExperimentTable)
          .values({
            exp_id: expId,
            research_project_id: atom.research_project_id,
            exp_name: body.expName,
            atom_id: body.atomId,
            exp_session_id: session.id,
            baseline_branch_name: body.baselineBranch,
            exp_branch_name: expId,
            exp_result_path: expResultPath,
            exp_result_summary_path: expResultSummaryPath,
            exp_plan_path: expPlanPath,
            code_path: worktreePath,
            remote_server_id: body.remoteServerId ?? null,
            status: "pending",
            time_created: now,
            time_updated: now,
          })
          .run(),
      )

      ExperimentExecutionWatch.createOrGet(expId, `${body.expName} for ${atom.atom_name}`, "pending")

      return c.json({
        exp_id: expId,
        exp_name: body.expName,
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
    "/experiment/:expId/session",
    describeRoute({
      summary: "Create or get session for an experiment",
      description:
        "If the experiment already has a session that is not archived, returns its session ID. Otherwise creates a new session and binds it to the experiment.",
      operationId: "research.experiment.session.create",
      responses: {
        200: {
          description: "Session ID for the experiment",
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
      const expId = c.req.param("expId")

      const experiment = Database.use((db) =>
        db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, expId)).get(),
      )
      if (!experiment) {
        return c.json({ success: false, message: `experiment not found: ${expId}` }, 404)
      }

      if (experiment.exp_session_id) {
        const existing = await Session.get(experiment.exp_session_id).catch(() => undefined)
        if (existing && !existing.time.archived) {
          return c.json({ session_id: experiment.exp_session_id, created: false })
        }
      }

      const session = await Session.create({ title: `Exp: ${experiment.exp_name}` })

      Database.use((db) =>
        db
          .update(ExperimentTable)
          .set({ exp_session_id: session.id, time_updated: Date.now() })
          .where(eq(ExperimentTable.exp_id, expId))
          .run(),
      )

      return c.json({ session_id: session.id, created: true })
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
          description: "Experiment not found",
          content: {
            "application/json": {
              schema: resolver(z.object({ ready: z.literal(false), message: z.string() })),
            },
          },
        },
        500: {
          description: "Worktree directory does not exist",
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

      // Resolve status from experiment_execution_watch if available
      const executionWatch = Database.use((db) =>
        db
          .select()
          .from(ExperimentExecutionWatchTable)
          .where(eq(ExperimentExecutionWatchTable.exp_id, experiment.exp_id))
          .orderBy(desc(ExperimentExecutionWatchTable.time_updated))
          .get(),
      )
      const executionStatusMap: Record<string, "pending" | "running" | "done" | "idle" | "failed"> = {
        pending: "pending",
        running: "running",
        finished: "done",
        failed: "failed",
        canceled: "idle",
      }
      const resolvedStatus = executionWatch ? (executionStatusMap[executionWatch.status] ?? "pending") : "pending"

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
        status: resolvedStatus,
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
                          exp_name: z.string(),
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
          exp_name: exp.exp_name,
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
                    config: RemoteServerConfigSchema,
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
          config: normalizeRemoteServerConfig(JSON.parse(s.config)),
          time_created: s.time_created,
          time_updated: s.time_updated,
        })),
      )
    },
  )
  .post(
    "/server/import-ssh-config",
    describeRoute({
      summary: "Import remote servers from SSH config",
      operationId: "research.server.importSshConfig",
      responses: {
        200: {
          description: "Imported remote servers",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  imported: z.array(
                    z.object({
                      id: z.string(),
                      config: RemoteServerConfigSchema,
                    }),
                  ),
                  skipped: z.array(z.string()),
                }),
              ),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "json",
      z.object({
        path: z.string(),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json")
      if (!(await Filesystem.exists(body.path))) {
        return c.json({ success: false, message: `ssh config not found: ${body.path}` }, 400)
      }

      const text = await Filesystem.readText(body.path)
      const hosts = parseSshConfig(text)
      const rows = Database.use((db) => db.select().from(RemoteServerTable).all())
      const imported: { id: string; config: RemoteServerConfig }[] = []
      const skipped: string[] = []

      for (const host of hosts) {
        const config = normalizeRemoteServerConfig({
          mode: "ssh_config",
          host_alias: host.alias,
          ssh_config_path: body.path,
          user: host.user,
        })
        if (config.mode !== "ssh_config") continue

        const dup = rows.find((row) => {
          try {
            const item = normalizeRemoteServerConfig(JSON.parse(row.config))
            return (
              item.mode === "ssh_config" &&
              item.host_alias === config.host_alias &&
              item.ssh_config_path === config.ssh_config_path
            )
          } catch {
            return false
          }
        })

        if (dup) {
          skipped.push(host.alias)
          continue
        }

        const id = uniqueID()
        const now = Date.now()
        Database.use((db) =>
          db
            .insert(RemoteServerTable)
            .values({
              id,
              config: JSON.stringify(config),
              time_created: now,
              time_updated: now,
            })
            .run(),
        )
        rows.push({
          id,
          config: JSON.stringify(config),
          time_created: now,
          time_updated: now,
        })
        imported.push({ id, config })
      }

      return c.json({ imported, skipped })
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
                  config: RemoteServerConfigSchema,
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
        config: RemoteServerInputSchema,
      }),
    ),
    async (c) => {
      const body = c.req.valid("json")
      const config = normalizeRemoteServerConfig(body.config)
      const id = uniqueID()
      const now = Date.now()
      Database.use((db) =>
        db
          .insert(RemoteServerTable)
          .values({
            id,
            config: JSON.stringify(config),
            time_created: now,
            time_updated: now,
          })
          .run(),
      )
      return c.json({ id, config })
    },
  )
  .patch(
    "/server/:serverId",
    describeRoute({
      summary: "Update a remote server",
      operationId: "research.server.update",
      responses: {
        200: {
          description: "Updated remote server",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  id: z.string(),
                  config: RemoteServerConfigSchema,
                }),
              ),
            },
          },
        },
        ...errors(404),
      },
    }),
    validator(
      "json",
      z.object({
        config: RemoteServerInputSchema,
      }),
    ),
    async (c) => {
      const serverId = c.req.param("serverId")
      const row = Database.use((db) => db.select().from(RemoteServerTable).where(eq(RemoteServerTable.id, serverId)).get())
      if (!row) {
        return c.json({ success: false, message: `server not found: ${serverId}` }, 404)
      }
      const body = c.req.valid("json")
      const config = normalizeRemoteServerConfig(body.config)
      Database.use((db) =>
        db
          .update(RemoteServerTable)
          .set({
            config: JSON.stringify(config),
            time_updated: Date.now(),
          })
          .where(eq(RemoteServerTable.id, serverId))
          .run(),
      )
      return c.json({ id: serverId, config })
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
      const now = Date.now()
      const taskMap = new Map(
        executionWatches
          .map((w) => {
            const task =
              w.status === "failed" ? ExperimentRemoteTask.latest(w.exp_id) : ExperimentRemoteTask.current(w.exp_id)
            return taskVisible(task, now) ? ([w.exp_id, task] as const) : null
          })
          .filter(Boolean) as Array<readonly [string, ReturnType<typeof ExperimentRemoteTask.current>]>,
      )

      return c.json(
        executionWatches
          .map((w) => {
            const exp = expMap.get(w.exp_id)
            const task = taskMap.get(w.exp_id)
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
              error_message: w.error_message ?? null,
              started_at: w.started_at,
              finished_at: w.finished_at,
              time_created: w.time_created,
              time_updated: w.time_updated,
              wandb_entity: w.wandb_entity,
              wandb_project: w.wandb_project,
              wandb_run_id: w.wandb_run_id,
              remote_task_title: task?.title ?? null,
              remote_task_kind: task?.kind ?? null,
              remote_task_status: task?.status ?? null,
              remote_task_target_path: task?.target_path ?? null,
              remote_task_screen_name: task?.screen_name ?? null,
              remote_task_log_path: task?.log_path ?? null,
              remote_task_error_message: task?.error_message ?? null,
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
      Database.use((db) => db.delete(RemoteTaskTable).where(eq(RemoteTaskTable.exp_id, watch.exp_id)).run())
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
      const tasks = Database.use((db) =>
        db.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.exp_id, watch.exp_id)).all(),
      )
      const hasRemoteTask = tasks.length > 0
      const internal = watch.wandb_run_id
        ? ExperimentExecutionWatch.findInternal(watch.exp_id, watch.wandb_run_id)
        : undefined
      const runs = await Promise.all(
        [
          internal ? forceRefreshWatch(internal.watch_id, { preserveStage: true }) : undefined,
          hasRemoteTask ? forceRefreshRemoteTask(watch.exp_id, { preserveStage: true }) : undefined,
        ].filter(Boolean) as Array<Promise<{ success: boolean; message: string }>>,
      )
      const result =
        runs.length === 0
          ? { success: true, message: "execution watch refreshed" }
          : {
              success: runs.every((item) => item.success),
              message: runs.map((item) => item.message).join("; "),
            }
      if (!result.success && result.message.includes("not found")) {
        return c.json(result, 404)
      }
      return c.json(result)
    },
  )
  .post(
    "/experiment-watch/:watchId/refresh-wandb",
    describeRoute({
      summary: "Force refresh W&B watch",
      operationId: "research.experimentWatch.refreshWandb",
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
      if (!internal) {
        return c.json({ success: false, message: `wandb watch not found for: ${watchId}` }, 404)
      }
      const result = await forceRefreshWatch(internal.watch_id, { preserveStage: true })
      if (!result.success && result.message.includes("not found")) {
        return c.json(result, 404)
      }
      return c.json(result)
    },
  )
  .post(
    "/experiment-watch/:watchId/refresh-remote-task",
    describeRoute({
      summary: "Force refresh remote task watch",
      operationId: "research.experimentWatch.refreshRemoteTask",
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
      const tasks = Database.use((db) =>
        db.select().from(RemoteTaskTable).where(eq(RemoteTaskTable.exp_id, watch.exp_id)).all(),
      )
      if (!tasks.length) {
        return c.json({ success: false, message: `remote task not found for: ${watchId}` }, 404)
      }
      const result = await forceRefreshRemoteTask(watch.exp_id, { preserveStage: true })
      if (!result.success && result.message.includes("not found")) {
        return c.json(result, 404)
      }
      return c.json(result)
    },
  )
  .get(
    "/experiment-watch/:watchId/log",
    describeRoute({
      summary: "Read remote task log for a watch",
      operationId: "research.experimentWatch.log",
      responses: {
        200: {
          description: "Remote log content",
          content: {
            "application/json": {
              schema: resolver(watchLogSchema),
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
      const task = Database.use((db) =>
        db
          .select()
          .from(RemoteTaskTable)
          .where(eq(RemoteTaskTable.exp_id, watch.exp_id))
          .orderBy(desc(RemoteTaskTable.time_updated))
          .get(),
      )
      if (!task?.log_path) {
        return c.json({ success: false, message: `remote log not found for watch: ${watchId}` }, 404)
      }
      const server = normalizeRemoteServerConfig(JSON.parse(task.server))
      const result = await readRemoteTaskLog({
        server,
        logPath: task.log_path,
      })
      if (!result.ok && !result.output) {
        return c.json({ success: false, message: `failed to read remote log: ${task.log_path}` }, 404)
      }
      return c.json({
        ok: result.ok,
        path: task.log_path,
        content: result.output,
      })
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
      Database.use((db) => db.delete(RemoteTaskTable).where(eq(RemoteTaskTable.exp_id, expId)).run())
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
      // Remove experiment worktree and branch from the code repo
      if (experiment.exp_branch_name) {
        const baseRepo = path.resolve(experiment.code_path, "../..")
        await git(["worktree", "remove", experiment.code_path, "--force"], { cwd: baseRepo }).catch(() => {})
        await git(["branch", "-D", experiment.exp_branch_name], { cwd: baseRepo }).catch(() => {})
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
        expName: z.string().optional(),
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
      if (body.expName !== undefined) updates.exp_name = body.expName
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
  .post(
    "/project/:researchProjectId/export",
    describeRoute({
      summary: "Export research project",
      description: "Export research project to a zip file containing all data and files.",
      operationId: "research.project.export",
      responses: {
        200: {
          description: "Export successful",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  zip_path: z.string(),
                  zip_name: z.string(),
                  size: z.number(),
                }),
              ),
            },
          },
        },
        ...errors(404, 500),
      },
    }),
    async (c) => {
      const researchProjectId = c.req.param("researchProjectId")

      const researchProject = Database.use((db) =>
        db
          .select()
          .from(ResearchProjectTable)
          .where(eq(ResearchProjectTable.research_project_id, researchProjectId))
          .get(),
      )
      if (!researchProject) {
        return c.json({ success: false, message: "research project not found" }, 404)
      }

      const project = Database.use((db) =>
        db.select().from(ProjectTable).where(eq(ProjectTable.id, researchProject.project_id)).get(),
      )
      if (!project) {
        return c.json({ success: false, message: "project not found" }, 404)
      }

      try {
        // Collect all database records
        const atoms = Database.use((db) =>
          db.select().from(AtomTable).where(eq(AtomTable.research_project_id, researchProjectId)).all(),
        )
        const atomIds = atoms.map((a) => a.atom_id)

        let relations: (typeof AtomRelationTable.$inferSelect)[] = []
        if (atomIds.length > 0) {
          const allRelations = Database.use((db) => db.select().from(AtomRelationTable).all())
          relations = allRelations.filter(
            (r) => atomIds.includes(r.atom_id_source) || atomIds.includes(r.atom_id_target),
          )
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

        const remoteServerIds = [...new Set(experiments.map((e) => e.remote_server_id).filter(Boolean))] as string[]
        const remoteServers: (typeof RemoteServerTable.$inferSelect)[] = []
        for (const serverId of remoteServerIds) {
          const server = Database.use((db) =>
            db.select().from(RemoteServerTable).where(eq(RemoteServerTable.id, serverId)).get(),
          )
          if (server) remoteServers.push(server)
        }

        const expIds = experiments.map((e) => e.exp_id)
        const experimentWatches =
          expIds.length > 0
            ? Database.use((db) => db.select().from(ExperimentWatchTable).all()).filter((w) =>
                expIds.includes(w.exp_id),
              )
            : []
        const experimentExecutionWatches =
          expIds.length > 0
            ? Database.use((db) => db.select().from(ExperimentExecutionWatchTable).all()).filter((w) =>
                expIds.includes(w.exp_id),
              )
            : []
        const remoteTasks =
          expIds.length > 0
            ? Database.use((db) => db.select().from(RemoteTaskTable).all()).filter((w) => expIds.includes(w.exp_id))
            : []

        // Create metadata
        const metadata = {
          version: "1.0",
          exported_at: Date.now(),
          source_worktree: project.worktree,
          research_project: researchProject,
          atoms,
          atom_relations: relations,
          experiments,
          articles,
          codes,
          remote_servers: remoteServers,
          watches: {
            experiment_watches: experimentWatches,
            experiment_execution_watches: experimentExecutionWatches,
            remote_tasks: remoteTasks,
          },
        }

        // Create zip file
        const timestamp = Date.now()
        const projectName = path.basename(project.worktree).replace(/[^a-zA-Z0-9_-]/g, "_")
        const zipName = `${projectName}_export_${timestamp}.zip`
        const zipPath = path.join(path.dirname(project.worktree), zipName)

        const zipWriter = new ZipWriter(new BlobWriter())

        // Add metadata.json
        const metadataContent = new TextEncoder().encode(JSON.stringify(metadata, null, 2))
        await zipWriter.add("metadata.json", new BlobReader(new Blob([metadataContent])))

        // Add atom files
        for (const atom of atoms) {
          const atomDir = path.join(project.worktree, "atom_list", atom.atom_id)
          if (await Filesystem.exists(atomDir)) {
            const addAtomDir = async (dir: string, prefix: string) => {
              const entries = await fs.promises.readdir(dir, { withFileTypes: true })
              for (const entry of entries) {
                const fullPath = path.join(dir, entry.name)
                const entryZipPath = `${prefix}/${entry.name}`
                if (entry.isDirectory()) {
                  await addAtomDir(fullPath, entryZipPath)
                } else {
                  const content = await fs.promises.readFile(fullPath)
                  await zipWriter.add(entryZipPath, new BlobReader(new Blob([new Uint8Array(content)])))
                }
              }
            }
            await addAtomDir(atomDir, `atom_list/${atom.atom_id}`)
          }
        }

        // Add article files
        for (const article of articles) {
          if (await Filesystem.exists(article.path)) {
            if (await Filesystem.isDir(article.path)) {
              // Article is a directory (e.g. LaTeX source folder), add recursively
              const addArticleDir = async (dir: string, prefix: string) => {
                const entries = await fs.promises.readdir(dir, { withFileTypes: true })
                for (const entry of entries) {
                  const fullPath = path.join(dir, entry.name)
                  const entryZipPath = `${prefix}/${entry.name}`
                  if (entry.isDirectory()) {
                    await addArticleDir(fullPath, entryZipPath)
                  } else {
                    const content = await fs.promises.readFile(fullPath)
                    await zipWriter.add(entryZipPath, new BlobReader(new Blob([new Uint8Array(content)])))
                  }
                }
              }
              await addArticleDir(article.path, `articles/${path.basename(article.path)}`)
            } else {
              const content = await fs.promises.readFile(article.path)
              const filename = path.basename(article.path)
              await zipWriter.add(`articles/${filename}`, new BlobReader(new Blob([new Uint8Array(content)])))
            }
          }
        }

        // Add entire code directory (including .git, worktrees, etc.)
        const codeRootDir = path.join(project.worktree, "code")
        if (await Filesystem.exists(codeRootDir)) {
          const addDirToZip = async (dir: string, prefix: string) => {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true })
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name)
              const entryZipPath = `${prefix}/${entry.name}`
              if (entry.isDirectory()) {
                await addDirToZip(fullPath, entryZipPath)
              } else {
                const content = await fs.promises.readFile(fullPath)
                await zipWriter.add(entryZipPath, new BlobReader(new Blob([new Uint8Array(content)])))
              }
            }
          }
          await addDirToZip(codeRootDir, "code")
        }

        // Add experiment results
        for (const exp of experiments) {
          const expDir = path.join(project.worktree, "exp_results", exp.exp_id)
          if (await Filesystem.exists(expDir)) {
            const addDirectory = async (dir: string, prefix: string) => {
              const entries = await fs.promises.readdir(dir, { withFileTypes: true })
              for (const entry of entries) {
                const fullPath = path.join(dir, entry.name)
                const zipPath = path.join(prefix, entry.name)
                if (entry.isDirectory()) {
                  await addDirectory(fullPath, zipPath)
                } else {
                  const content = await fs.promises.readFile(fullPath)
                  await zipWriter.add(zipPath, new BlobReader(new Blob([new Uint8Array(content)])))
                }
              }
            }
            await addDirectory(expDir, `exp_results/${exp.exp_id}`)
          }
        }

        // Helper: recursively add a file or directory to zip
        const addPathToZip = async (fsPath: string, zipPrefix: string) => {
          if (await Filesystem.isDir(fsPath)) {
            const entries = await fs.promises.readdir(fsPath, { withFileTypes: true })
            for (const entry of entries) {
              const fullPath = path.join(fsPath, entry.name)
              const entryZipPath = `${zipPrefix}/${entry.name}`
              if (entry.isDirectory()) {
                await addPathToZip(fullPath, entryZipPath)
              } else {
                const content = await fs.promises.readFile(fullPath)
                await zipWriter.add(entryZipPath, new BlobReader(new Blob([new Uint8Array(content)])))
              }
            }
          } else {
            const content = await fs.promises.readFile(fsPath)
            await zipWriter.add(zipPrefix, new BlobReader(new Blob([new Uint8Array(content)])))
          }
        }

        // Add background.md and goal.md if they exist
        if (researchProject.background_path && (await Filesystem.exists(researchProject.background_path))) {
          await addPathToZip(researchProject.background_path, path.basename(researchProject.background_path))
        }
        if (researchProject.goal_path && (await Filesystem.exists(researchProject.goal_path))) {
          await addPathToZip(researchProject.goal_path, path.basename(researchProject.goal_path))
        }

        // Add .opencode-research.json
        const memoPath = path.join(project.worktree, ".opencode-research.json")
        if (await Filesystem.exists(memoPath)) {
          const content = await fs.promises.readFile(memoPath)
          await zipWriter.add(".opencode-research.json", new BlobReader(new Blob([new Uint8Array(content)])))
        }

        // Close and save zip
        const blob = await zipWriter.close()
        const buffer = await blob.arrayBuffer()
        await fs.promises.writeFile(zipPath, Buffer.from(buffer))

        return c.json({
          zip_path: zipPath,
          zip_name: zipName,
          size: buffer.byteLength,
        })
      } catch (err) {
        return c.json({ success: false, message: "export failed", error: `${err}` }, 500)
      }
    },
  )
  .post(
    "/import-project",
    describeRoute({
      summary: "Import research project",
      description: "Import research project from a zip file.",
      operationId: "research.project.import",
      responses: {
        200: {
          description: "Import successful",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  project_id: z.string(),
                  research_project_id: z.string(),
                }),
              ),
            },
          },
        },
        ...errors(400, 500),
      },
    }),
    validator(
      "json",
      z.object({
        zipPath: z.string().min(1, "zipPath required"),
        targetDirectory: z.string().min(1, "targetDirectory required"),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json")
      const zipPath = Filesystem.resolve(body.zipPath)
      const targetDir = Filesystem.resolve(body.targetDirectory)

      if (!(await Filesystem.exists(zipPath))) {
        return c.json({ success: false, message: "zip file not found" }, 400)
      }

      if (await Filesystem.exists(targetDir)) {
        return c.json({ success: false, message: "target directory already exists" }, 400)
      }

      try {
        // Extract zip to target directory using @zip.js/zip.js
        await fs.promises.mkdir(targetDir, { recursive: true })

        const zipData = await fs.promises.readFile(zipPath)
        const zipReader = new ZipReader(new BlobReader(new Blob([new Uint8Array(zipData)])))
        const entries = await zipReader.getEntries()

        for (const entry of entries) {
          if (entry.directory || !entry.getData) continue
          const entryPath = path.join(targetDir, entry.filename)
          await fs.promises.mkdir(path.dirname(entryPath), { recursive: true })
          const blob = await entry.getData(new BlobWriter())
          const buffer = await blob.arrayBuffer()
          await fs.promises.writeFile(entryPath, Buffer.from(buffer))
        }
        await zipReader.close()

        // Read metadata
        const metadataPath = path.join(targetDir, "metadata.json")
        if (!(await Filesystem.exists(metadataPath))) {
          throw new Error("metadata.json not found in zip")
        }

        const metadata = await Filesystem.readJson<{
          version: string
          source_worktree?: string
          research_project: typeof ResearchProjectTable.$inferSelect
          atoms: (typeof AtomTable.$inferSelect)[]
          atom_relations: (typeof AtomRelationTable.$inferSelect)[]
          experiments: (typeof ExperimentTable.$inferSelect)[]
          articles: (typeof ArticleTable.$inferSelect)[]
          codes: (typeof CodeTable.$inferSelect)[]
          remote_servers: (typeof RemoteServerTable.$inferSelect)[]
          watches: {
            experiment_watches: (typeof ExperimentWatchTable.$inferSelect)[]
            experiment_execution_watches: (typeof ExperimentExecutionWatchTable.$inferSelect)[]
            remote_tasks: (typeof RemoteTaskTable.$inferSelect)[]
          }
        }>(metadataPath)

        // Initialize git repository
        await Filesystem.write(path.join(targetDir, ".gitignore"), "/code/\n")
        const init = await git(["init", "--quiet"], { cwd: targetDir })
        if (init.exitCode !== 0) throw new Error(gitError(init, "failed to initialize git repository"))

        const add = await git(["add", "."], { cwd: targetDir })
        if (add.exitCode !== 0) throw new Error(gitError(add, "failed to stage files"))

        const commit = await git(["commit", "-m", "Imported research project", "--allow-empty"], {
          cwd: targetDir,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "OpenCode",
            GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "opencode@local",
            GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "OpenCode",
            GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "opencode@local",
          },
        })
        if (commit.exitCode !== 0) throw new Error(gitError(commit, "failed to create initial commit"))

        // Create project
        const project = await Project.fromDirectory(targetDir)
        if (project.project.id === "global") throw new Error("failed to resolve project id")

        await Instance.reload({
          directory: targetDir,
          worktree: targetDir,
          project: project.project,
        }).catch(() => {})

        // Check if research project already exists
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

        // Import database records with new IDs
        const result = Database.transaction(() => {
          const now = Date.now()
          const newResearchProjectId = uniqueID()
          const oldToNewAtomId = new Map<string, string>()
          const oldToNewExpId = new Map<string, string>()
          const oldToNewArticleId = new Map<string, string>()
          const oldToNewCodeId = new Map<string, string>()

          // Create research project
          const backgroundPath = metadata.research_project.background_path
            ? path.join(targetDir, path.basename(metadata.research_project.background_path))
            : null
          const goalPath = metadata.research_project.goal_path
            ? path.join(targetDir, path.basename(metadata.research_project.goal_path))
            : null

          Database.use((db) =>
            db
              .insert(ResearchProjectTable)
              .values({
                research_project_id: newResearchProjectId,
                project_id: project.project.id,
                background_path: backgroundPath,
                goal_path: goalPath,
                macro_table_path: null,
                time_created: now,
                time_updated: now,
              })
              .run(),
          )

          // Import atoms
          for (const atom of metadata.atoms) {
            const newAtomId = uniqueID()
            oldToNewAtomId.set(atom.atom_id, newAtomId)

            const atomDir = path.join(targetDir, "atom_list", newAtomId)
            const oldAtomDir = path.join(targetDir, "atom_list", atom.atom_id)

            // Rename atom directory
            if (fs.existsSync(oldAtomDir)) {
              fs.renameSync(oldAtomDir, atomDir)
            }

            Database.use((db) =>
              db
                .insert(AtomTable)
                .values({
                  atom_id: newAtomId,
                  research_project_id: newResearchProjectId,
                  atom_name: atom.atom_name,
                  atom_type: atom.atom_type,
                  atom_claim_path: path.join(atomDir, "claim.md"),
                  atom_evidence_type: atom.atom_evidence_type,
                  atom_evidence_status: atom.atom_evidence_status,
                  atom_evidence_path: path.join(atomDir, "evidence.md"),
                  atom_evidence_assessment_path: path.join(atomDir, "evidence_assessment.md"),
                  article_id: null, // Will be updated later
                  session_id: null, // Sessions are not imported
                  time_created: now,
                  time_updated: now,
                })
                .run(),
            )
          }

          // Import articles
          for (const article of metadata.articles) {
            const newArticleId = uniqueID()
            oldToNewArticleId.set(article.article_id, newArticleId)

            const articlePath = path.join(targetDir, "articles", path.basename(article.path))

            Database.use((db) =>
              db
                .insert(ArticleTable)
                .values({
                  article_id: newArticleId,
                  research_project_id: newResearchProjectId,
                  path: articlePath,
                  title: article.title,
                  source_url: article.source_url,
                  status: article.status,
                  time_created: now,
                  time_updated: now,
                })
                .run(),
            )
          }

          // Update atom article references
          for (const atom of metadata.atoms) {
            if (atom.article_id) {
              const newAtomId = oldToNewAtomId.get(atom.atom_id)
              const newArticleId = oldToNewArticleId.get(atom.article_id)
              if (newAtomId && newArticleId) {
                Database.use((db) =>
                  db.update(AtomTable).set({ article_id: newArticleId }).where(eq(AtomTable.atom_id, newAtomId)).run(),
                )
              }
            }
          }

          // Import atom relations
          for (const relation of metadata.atom_relations) {
            const newSourceId = oldToNewAtomId.get(relation.atom_id_source)
            const newTargetId = oldToNewAtomId.get(relation.atom_id_target)
            if (newSourceId && newTargetId) {
              Database.use((db) =>
                db
                  .insert(AtomRelationTable)
                  .values({
                    atom_id_source: newSourceId,
                    atom_id_target: newTargetId,
                    relation_type: relation.relation_type,
                    note: relation.note,
                    time_created: now,
                    time_updated: now,
                  })
                  .run(),
              )
            }
          }

          // Import codes
          for (const code of metadata.codes) {
            const newCodeId = uniqueID()
            oldToNewCodeId.set(code.code_id, newCodeId)

            Database.use((db) =>
              db
                .insert(CodeTable)
                .values({
                  code_id: newCodeId,
                  research_project_id: newResearchProjectId,
                  code_name: code.code_name,
                  article_id: code.article_id ? (oldToNewArticleId.get(code.article_id) ?? null) : null,
                  time_created: now,
                  time_updated: now,
                })
                .run(),
            )
          }

          // Import experiments (keep original exp_id to match existing worktrees)
          for (const exp of metadata.experiments) {
            oldToNewExpId.set(exp.exp_id, exp.exp_id)

            const expDir = path.join(targetDir, "exp_results", exp.exp_id)
            const codeName = path.basename(path.resolve(exp.code_path, "../.."))
            const newCodePath = path.join(targetDir, "code", codeName, ".openresearch_worktrees", exp.exp_id)

            Database.use((db) =>
              db
                .insert(ExperimentTable)
                .values({
                  exp_id: exp.exp_id,
                  research_project_id: newResearchProjectId,
                  exp_name: exp.exp_name,
                  exp_session_id: null, // Sessions are not imported
                  baseline_branch_name: exp.baseline_branch_name,
                  exp_branch_name: exp.exp_branch_name,
                  exp_result_path: expDir,
                  atom_id: exp.atom_id ? (oldToNewAtomId.get(exp.atom_id) ?? null) : null,
                  exp_result_summary_path: exp.exp_result_summary_path
                    ? path.join(expDir, path.basename(exp.exp_result_summary_path))
                    : null,
                  exp_plan_path: exp.exp_plan_path ? path.join(expDir, path.basename(exp.exp_plan_path)) : null,
                  remote_server_id: null, // Remote servers are not imported
                  code_path: newCodePath,
                  status: "idle",
                  started_at: null,
                  finished_at: null,
                  time_created: now,
                  time_updated: now,
                })
                .run(),
            )
          }

          // Import experiment watches
          if (metadata.watches) {
            for (const w of metadata.watches.experiment_watches ?? []) {
              const newExpId = oldToNewExpId.get(w.exp_id)
              if (!newExpId) continue
              Database.use((db) =>
                db
                  .insert(ExperimentWatchTable)
                  .values({
                    watch_id: uniqueID(),
                    exp_id: newExpId,
                    wandb_entity: w.wandb_entity,
                    wandb_project: w.wandb_project,
                    wandb_api_key: w.wandb_api_key,
                    wandb_run_id: w.wandb_run_id,
                    status: w.status,
                    last_polled_at: w.last_polled_at,
                    wandb_state: w.wandb_state,
                    error_message: w.error_message,
                    time_created: now,
                    time_updated: now,
                  })
                  .run(),
              )
            }

            for (const w of metadata.watches.experiment_execution_watches ?? []) {
              const newExpId = oldToNewExpId.get(w.exp_id)
              if (!newExpId) continue
              Database.use((db) =>
                db
                  .insert(ExperimentExecutionWatchTable)
                  .values({
                    watch_id: uniqueID(),
                    exp_id: newExpId,
                    status: w.status,
                    stage: w.stage,
                    title: w.title,
                    message: w.message,
                    wandb_entity: w.wandb_entity,
                    wandb_project: w.wandb_project,
                    wandb_run_id: w.wandb_run_id,
                    error_message: w.error_message,
                    started_at: w.started_at,
                    finished_at: w.finished_at,
                    time_created: now,
                    time_updated: now,
                  })
                  .run(),
              )
            }

            for (const w of metadata.watches.remote_tasks ?? []) {
              const newExpId = oldToNewExpId.get(w.exp_id)
              if (!newExpId) continue
              Database.use((db) =>
                db
                  .insert(RemoteTaskTable)
                  .values({
                    task_id: uniqueID(),
                    exp_id: newExpId,
                    kind: w.kind,
                    resource_key: w.resource_key,
                    title: w.title,
                    status: w.status,
                    server: w.server,
                    remote_root: w.remote_root,
                    target_path: w.target_path,
                    screen_name: w.screen_name,
                    command: w.command,
                    pid: null,
                    log_path: w.log_path,
                    source_selection: w.source_selection,
                    method: w.method,
                    error_message: w.error_message,
                    last_polled_at: w.last_polled_at,
                    stopped_at: w.stopped_at,
                    time_created: now,
                    time_updated: now,
                  })
                  .run(),
              )
            }
          }

          return {
            project_id: project.project.id,
            research_project_id: newResearchProjectId,
          }
        })

        // Fix git worktree absolute paths
        if (metadata.source_worktree) {
          const codeDir = path.join(targetDir, "code")
          if (await Filesystem.exists(codeDir)) {
            const codeEntries = await fs.promises.readdir(codeDir, { withFileTypes: true })
            for (const codeEntry of codeEntries) {
              if (!codeEntry.isDirectory()) continue
              const repoDir = path.join(codeDir, codeEntry.name)
              const gitWorktreesDir = path.join(repoDir, ".git", "worktrees")
              if (!(await Filesystem.exists(gitWorktreesDir))) continue

              const wtEntries = await fs.promises.readdir(gitWorktreesDir, { withFileTypes: true })
              for (const wtEntry of wtEntries) {
                if (!wtEntry.isDirectory()) continue
                // Fix .git/worktrees/<name>/gitdir -> points to worktree's .git file
                const gitdirFile = path.join(gitWorktreesDir, wtEntry.name, "gitdir")
                if (await Filesystem.exists(gitdirFile)) {
                  const content = (await fs.promises.readFile(gitdirFile, "utf-8")).trim()
                  const fixed = content.replace(metadata.source_worktree, targetDir)
                  await fs.promises.writeFile(gitdirFile, fixed + "\n")
                }
              }

              // Fix worktree .git files -> point back to main repo's .git/worktrees/<name>
              const worktreesRoot = path.join(repoDir, ".openresearch_worktrees")
              if (!(await Filesystem.exists(worktreesRoot))) continue
              const expEntries = await fs.promises.readdir(worktreesRoot, { withFileTypes: true })
              for (const expEntry of expEntries) {
                if (!expEntry.isDirectory()) continue
                const dotGitFile = path.join(worktreesRoot, expEntry.name, ".git")
                if (await Filesystem.exists(dotGitFile)) {
                  const content = (await fs.promises.readFile(dotGitFile, "utf-8")).trim()
                  const fixed = content.replace(metadata.source_worktree, targetDir)
                  await fs.promises.writeFile(dotGitFile, fixed + "\n")
                }
              }
            }
          }
        }

        // Write memo file
        const memoPath = path.join(targetDir, ".opencode-research.json")
        await Filesystem.write(
          memoPath,
          JSON.stringify(
            {
              research_project_id: result.research_project_id,
              project_id: result.project_id,
              created_at: Date.now(),
            },
            null,
            2,
          ),
        )

        // Clean up metadata.json
        await fs.promises.unlink(metadataPath).catch(() => {})

        return c.json(result)
      } catch (err) {
        // Clean up on failure
        await rm(targetDir, { recursive: true, force: true }).catch(() => {})
        return c.json({ success: false, message: "import failed", error: `${err}` }, 500)
      }
    },
  )
