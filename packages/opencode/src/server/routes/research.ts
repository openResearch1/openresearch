import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import z from "zod"
import path from "path"
import { Filesystem } from "@/util/filesystem"
import { Database } from "@/storage/db"
import { Project } from "@/project/project"
import { Instance } from "@/project/instance"
import { ResearchProjectTable, ArticleTable, AtomTable, AtomRelationTable } from "@/research/research.sql"
import { eq } from "drizzle-orm"
import { Session } from "@/session"
import { Research } from "@/research/research"
import { linkKinds } from "@/research/research.sql"
import { Bus } from "@/bus"
import { errors } from "../error"
import fs from "fs"
import { rm } from "fs/promises"
import { git } from "@/util/git"

const createSchema = z.object({
  name: z.string().min(1, "name required"),
  targetPath: z.string().min(1, "targetPath required"),
  papers: z.array(z.string().min(1)).min(1, "papers required"),
  backgroundPath: z.string().optional(),
  goalPath: z.string().optional(),
})

async function copyFile(src: string, dest: string) {
  const file = Bun.file(src)
  if (!(await file.exists())) throw new Error(`file not found: ${src}`)
  await fs.promises.cp(src, dest, { force: false })
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
  atom_experiments_plan_path: z.string().nullable(),
  atom_evidence_path: z.string().nullable(),
  atom_evidence_assessment_path: z.string().nullable(),
  article_id: z.string().nullable(),
  exp_id: z.string().nullable(),
  session_id: z.string().nullable(),
  time_created: z.number(),
  time_updated: z.number(),
})

const atomRelationSchema = z.object({
  atom_id_source: z.string(),
  atom_id_target: z.string(),
  relation_type: z.string(),
  note: z.string().nullable(),
  time_created: z.number(),
  time_updated: z.number(),
})

const atomRelationCreateSchema = z.object({
  source_atom_id: z.string().min(1, "source atom required"),
  target_atom_id: z.string().min(1, "target atom required"),
  relation_type: z.enum(linkKinds),
  note: z.string().optional(),
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

      const source = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, body.source_atom_id)).get())
      if (!source || source.research_project_id !== researchProjectId) {
        return c.json({ success: false, message: `source atom not found: ${body.source_atom_id}` }, 404)
      }

      const target = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.atom_id, body.target_atom_id)).get())
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
      }
      if (body.backgroundPath && !(await Filesystem.exists(body.backgroundPath))) {
        return c.json({ success: false, message: "background file not found" }, 400)
      }
      if (body.goalPath && !(await Filesystem.exists(body.goalPath))) {
        return c.json({ success: false, message: "goal file not found" }, 400)
      }

      await Filesystem.write(path.join(target, ".keep"), "")

      const paperTargets: { src: string; dest: string }[] = paperSources.map((src) => {
        const dest = path.join(target, path.basename(src))
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
                  atom: atomSchema.nullable(),
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

      // Query the atom that has the matching session_id
      const atom = Database.use((db) => db.select().from(AtomTable).where(eq(AtomTable.session_id, sessionId)).get())

      return c.json({ atom: atom || null })
    },
  )
