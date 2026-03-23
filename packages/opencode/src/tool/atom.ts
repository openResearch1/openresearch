import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Database, eq, and } from "../storage/db"
import { AtomTable, AtomRelationTable } from "../research/research.sql"
import { Research } from "../research/research"
import { Bus } from "@/bus"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { rm } from "fs/promises"

type AtomRow = typeof AtomTable.$inferSelect

const atomKinds = ["fact", "method", "theorem", "verification"] as const

export const AtomCreateTool = Tool.define("atom_create", {
  description:
    "Create a new atom (the smallest verifiable unit of knowledge). " +
    "An atom consists of a claim and its evidence. " +
    "Use this tool when you need to add a new claim of fact, method, theorem, or verification to the research project. " +
    "IMPORTANT: All content and evidence MUST use markdown syntax with proper LaTeX math formulas ($...$ for inline, $$...$$ for block) and code blocks (```language).",
  parameters: z.object({
    name: z.string().describe("A short descriptive name for the atom"),
    type: z.enum(atomKinds).describe("The kind of atom: fact, method, theorem, or verification"),
    content: z
      .string()
      .describe(
        "The detailed description of the atom's claim. " +
          "MUST use markdown syntax. " +
          "For math formulas, use LaTeX syntax: inline formulas with $...$, block formulas with $$...$$. " +
          "For code blocks, use triple backticks with language specification. " +
          "Example: 'The formula $E = mc^2$ shows energy-mass equivalence.'",
      ),
    articleId: z.string().optional().describe("The article ID this atom originates from (if from literature)"),
    evidence: z
      .string()
      .optional()
      .describe(
        "The detailed description of the atom's evidence." +
          "MUST use markdown syntax. " +
          "For math formulas, use LaTeX syntax: inline formulas with $...$, block formulas with $$...$$. " +
          "For code blocks, use triple backticks with language specification. " +
          "Example: 'Proof: $$\\int_0^1 x^2 dx = \\frac{1}{3}$$'",
      ),
  }),
  async execute(params, ctx) {
    const researchProjectId = await Research.getResearchProjectId(ctx.sessionID)
    if (!researchProjectId) {
      return {
        title: "Failed",
        output: "Current session is not associated with any research project.",
        metadata: {
          atomId: undefined as string | undefined,
        },
      }
    }

    const atomId = crypto.randomUUID()
    const atomDir = path.join(Instance.directory, "atom_list", atomId)
    const contentPath = path.join(atomDir, "content.md")

    await Filesystem.write(contentPath, params.content)

    let proofPath: string | null = null
    if (params.evidence) {
      proofPath = path.join(atomDir, "proof.md")
      await Filesystem.write(proofPath, params.evidence)
    }

    const now = Date.now()
    Database.use((db) =>
      db
        .insert(AtomTable)
        .values({
          atom_id: atomId,
          research_project_id: researchProjectId,
          atom_name: params.name,
          atom_type: params.type,
          atom_content_path: contentPath,
          atom_proof_type: "math",
          atom_proof_status: "pending",
          atom_proof_result_path: proofPath,
          article_id: params.articleId ?? null,
          time_created: now,
          time_updated: now,
        })
        .run(),
    )

    await Bus.publish(Research.Event.AtomsUpdated, { researchProjectId })

    return {
      title: `Created atom: ${params.name}`,
      output: [
        `Atom created successfully.`,
        `- ID: ${atomId}`,
        `- Name: ${params.name}`,
        `- Type: ${params.type}`,
        `- Content path: ${contentPath}`,
        params.articleId ? `- Source article: ${params.articleId}` : `- Source: user created`,
      ].join("\n"),
      metadata: {
        atomId: atomId as string | undefined,
      },
    }
  },
})

function formatAtom(row: AtomRow): string {
  return [
    `atom_id: ${row.atom_id}`,
    `name: ${row.atom_name}`,
    `type: ${row.atom_type}`,
    `proof_type: ${row.atom_proof_type}`,
    `proof_status: ${row.atom_proof_status}`,
    `research_project_id: ${row.research_project_id}`,
    row.atom_content_path ? `content_path: ${row.atom_content_path}` : null,
    row.atom_proof_plan_path ? `proof_plan_path: ${row.atom_proof_plan_path}` : null,
    row.atom_proof_result_path ? `proof_result_path: ${row.atom_proof_result_path}` : null,
    row.article_id ? `article_id: ${row.article_id}` : null,
    row.exp_id ? `exp_id: ${row.exp_id}` : null,
    row.session_id ? `session_id: ${row.session_id}` : null,
    `time_created: ${row.time_created}`,
    `time_updated: ${row.time_updated}`,
  ]
    .filter(Boolean)
    .join("\n")
}

export const AtomQueryTool = Tool.define("atom_query", {
  description:
    "Query atom information for the current session. " +
    "If the current session is bound to a specific atom, returns that atom's details. " +
    "Otherwise, returns all atoms in the research project.",
  parameters: z.object({}),
  async execute(_params, ctx) {
    // 1. Check if current session is directly bound to an atom
    let parentSessionId = await Research.getParentSessionId(ctx.sessionID)
    if (!parentSessionId) {
      parentSessionId = ctx.sessionID
    }
    const bound = Database.use((db) =>
      db.select().from(AtomTable).where(eq(AtomTable.session_id, parentSessionId)).get(),
    )

    if (bound) {
      return {
        title: `Atom: ${bound.atom_name}`,
        output: formatAtom(bound),
        metadata: { count: 1 },
      }
    }

    // 2. Fall back: find research project and return all its atoms
    const researchProjectId = await Research.getResearchProjectId(ctx.sessionID)
    if (!researchProjectId) {
      return {
        title: "No atoms",
        output: "Current session is not associated with any research project.",
        metadata: { count: 0 },
      }
    }

    const atoms = Database.use((db) =>
      db.select().from(AtomTable).where(eq(AtomTable.research_project_id, researchProjectId)).all(),
    )

    if (atoms.length === 0) {
      return {
        title: "No atoms",
        output: "No atoms found in this research project.",
        metadata: { count: 0 },
      }
    }

    const output = atoms.map((a, i) => `--- Atom ${i + 1} ---\n${formatAtom(a)}`).join("\n\n")
    return {
      title: `${atoms.length} atom(s)`,
      output,
      metadata: { count: atoms.length },
    }
  },
})

const relationKinds = ["motivates", "formalizes", "derives", "analyzes", "validates", "contradicts", "other"] as const

export const AtomBatchCreateTool = Tool.define("atom_batch_create", {
  description:
    "Batch create atoms and their relations in one call. " +
    "The atoms list defines each atom. The relations list defines edges between atoms, " +
    "where source and target are zero-based indexes into the atoms list. " +
    "IMPORTANT: All content and evidence MUST use markdown syntax with proper LaTeX math formulas ($...$ for inline, $$...$$ for block) and code blocks (```language).",
  parameters: z.object({
    atoms: z
      .array(
        z.object({
          name: z.string().describe("A short descriptive name for the atom"),
          type: z.enum(atomKinds).describe("The kind of atom: fact, method, theorem, or verification"),
          content: z
            .string()
            .describe(
              "The detailed description of the atom's claim. " +
                "MUST use markdown syntax. " +
                "For math formulas, use LaTeX syntax: inline formulas with $...$, block formulas with $$...$$. " +
                "For code blocks, use triple backticks with language specification. " +
                "Example: 'The formula $E = mc^2$ shows energy-mass equivalence.'",
            ),
          articleId: z.string().optional().describe("The source article ID (if from literature)"),
          evidence: z
            .string()
            .optional()
            .describe(
              "The detailed description of the atom's evidence." +
                "MUST use markdown syntax. " +
                "For math formulas, use LaTeX syntax: inline formulas with $...$, block formulas with $$...$$. " +
                "For code blocks, use triple backticks with language specification. " +
                "Example: 'Proof: $$\\int_0^1 x^2 dx = \\frac{1}{3}$$'",
            ),
        }),
      )
      .min(1)
      .describe("List of atoms to create"),
    relations: z
      .array(
        z.object({
          source: z.number().int().min(0).describe("Index of the source atom in the atoms list"),
          target: z.number().int().min(0).describe("Index of the target atom in the atoms list"),
          relationType: z
            .enum(relationKinds)
            .describe(
              "The type of relation between atoms: motivates, formalizes, derives, analyzes, validates, contradicts, or other",
            ),
        }),
      )
      .optional()
      .describe("Relations between atoms, using indexes from the atoms list"),
  }),
  async execute(params, ctx) {
    const researchProjectId = await Research.getResearchProjectId(ctx.sessionID)
    if (!researchProjectId) {
      return {
        title: "Failed",
        output: "Current session is not associated with any research project.",
        metadata: { atomCount: 0, relationCount: 0 },
      }
    }

    // Validate relation indexes
    for (const rel of params.relations ?? []) {
      if (rel.source >= params.atoms.length) {
        return {
          title: "Failed",
          output: `Invalid relation: source index ${rel.source} out of range (${params.atoms.length} atoms).`,
          metadata: { atomCount: 0, relationCount: 0 },
        }
      }
      if (rel.target >= params.atoms.length) {
        return {
          title: "Failed",
          output: `Invalid relation: target index ${rel.target} out of range (${params.atoms.length} atoms).`,
          metadata: { atomCount: 0, relationCount: 0 },
        }
      }
    }

    //TODO use roll back on fail

    // Generate IDs and write content files
    const atomIds: string[] = []
    const hasProof: boolean[] = []
    for (const atom of params.atoms) {
      const atomId = crypto.randomUUID()
      atomIds.push(atomId)
      const contentPath = path.join(Instance.directory, "atom_list", atomId, "content.md")
      await Filesystem.write(contentPath, atom.content)
      if (atom.evidence) {
        const proofPath = path.join(Instance.directory, "atom_list", atomId, "proof.md")
        await Filesystem.write(proofPath, atom.evidence)
        hasProof.push(true)
      } else {
        hasProof.push(false)
      }
    }

    // Insert atoms and relations in a single transaction
    const now = Date.now()
    Database.transaction(() => {
      const atomValues = params.atoms.map((atom, i) => ({
        atom_id: atomIds[i],
        research_project_id: researchProjectId,
        atom_name: atom.name,
        atom_type: atom.type,
        atom_content_path: path.join(Instance.directory, "atom_list", atomIds[i], "content.md"),
        atom_proof_type: "math" as const,
        atom_proof_status: "pending" as const,
        atom_proof_result_path: hasProof[i] ? path.join(Instance.directory, "atom_list", atomIds[i], "proof.md") : null,
        article_id: atom.articleId ?? null,
        time_created: now,
        time_updated: now,
      }))
      Database.use((db) => db.insert(AtomTable).values(atomValues).run())

      const relations = params.relations ?? []
      if (relations.length > 0) {
        const relationValues = relations.map((rel) => ({
          atom_id_source: atomIds[rel.source],
          atom_id_target: atomIds[rel.target],
          relation_type: rel.relationType,
          time_created: now,
          time_updated: now,
        }))
        Database.use((db) => db.insert(AtomRelationTable).values(relationValues).run())
      }
    })

    await Bus.publish(Research.Event.AtomsUpdated, { researchProjectId })

    const lines = [
      `Created ${atomIds.length} atom(s) and ${(params.relations ?? []).length} relation(s).`,
      "",
      ...params.atoms.map((atom, i) => `[${i}] ${atomIds[i]} - ${atom.name} (${atom.type})`),
      ...((params.relations ?? []).length > 0
        ? [
            "",
            "Relations:",
            ...(params.relations ?? []).map((rel) => `  [${rel.source}] → [${rel.target}] (${rel.relationType})`),
          ]
        : []),
    ]

    return {
      title: `Created ${atomIds.length} atom(s)`,
      output: lines.join("\n"),
      metadata: { atomCount: atomIds.length, relationCount: (params.relations ?? []).length },
    }
  },
})

export const AtomDeleteTool = Tool.define("atom_delete", {
  description:
    "Delete one or more atoms and all their related relations. " +
    "This will permanently remove the atoms, their content files, proof files, and all relations pointing to or from these atoms.",
  parameters: z.object({
    atomIds: z.array(z.string()).describe("Array of atom IDs to delete"),
  }),
  async execute(params, ctx) {
    const researchProjectId = await Research.getResearchProjectId(ctx.sessionID)
    if (!researchProjectId) {
      return {
        title: "Failed",
        output: "Current session is not associated with any research project.",
        metadata: { deleted: false, deletedCount: 0 },
      }
    }

    if (params.atomIds.length === 0) {
      return {
        title: "No atoms to delete",
        output: "No atom IDs provided for deletion.",
        metadata: { deleted: false, deletedCount: 0 },
      }
    }

    // Check if all atoms exist and belong to the research project
    const atoms = Database.use((db) =>
      db.select().from(AtomTable).where(eq(AtomTable.research_project_id, researchProjectId)).all(),
    )

    const atomMap = new Map(atoms.map((atom) => [atom.atom_id, atom]))
    const validAtomIds: string[] = []
    const invalidAtomIds: string[] = []

    for (const atomId of params.atomIds) {
      if (atomMap.has(atomId)) {
        validAtomIds.push(atomId)
      } else {
        invalidAtomIds.push(atomId)
      }
    }

    if (validAtomIds.length === 0) {
      return {
        title: "Failed",
        output: `No valid atoms found for deletion. Invalid IDs: ${invalidAtomIds.join(", ")}`,
        metadata: { deleted: false, deletedCount: 0 },
      }
    }

    // Delete atom directories and files
    const deletePromises = validAtomIds.map(async (atomId) => {
      const atomDir = path.join(Instance.directory, "atom_list", atomId)
      try {
        await rm(atomDir, { recursive: true, force: true })
      } catch (error) {
        // Directory might not exist, continue with deletion
        console.warn(`Failed to remove atom directory ${atomDir}:`, error)
      }
    })

    await Promise.all(deletePromises)

    // Delete atoms and related relations in a transaction
    Database.transaction(() => {
      // Delete relations where any of these atoms are source or target
      for (const atomId of validAtomIds) {
        Database.use((db) => db.delete(AtomRelationTable).where(eq(AtomRelationTable.atom_id_source, atomId)).run())
        Database.use((db) => db.delete(AtomRelationTable).where(eq(AtomRelationTable.atom_id_target, atomId)).run())
      }

      // Delete the atoms themselves
      for (const atomId of validAtomIds) {
        Database.use((db) => db.delete(AtomTable).where(eq(AtomTable.atom_id, atomId)).run())
      }
    })

    // Notify about atoms update
    await Bus.publish(Research.Event.AtomsUpdated, { researchProjectId })

    // Prepare output summary
    const deletedAtoms = validAtomIds.map((atomId) => atomMap.get(atomId)!)
    const lines = [`Successfully deleted ${validAtomIds.length} atom(s).`, "", "Deleted atoms:"]

    for (const atom of deletedAtoms) {
      lines.push(`- ${atom.atom_name} (${atom.atom_type})`)
    }

    if (invalidAtomIds.length > 0) {
      lines.push("", `Invalid atom IDs (not found or not in current project): ${invalidAtomIds.join(", ")}`)
    }

    lines.push("", "All related relations have been removed.")

    return {
      title: `Deleted ${validAtomIds.length} atom(s)`,
      output: lines.join("\n"),
      metadata: {
        deleted: true,
        deletedCount: validAtomIds.length,
      },
    }
  },
})

export const AtomRelationQueryTool = Tool.define("atom_relation_query", {
  description:
    "Query atom relations in the current research project. " +
    "Returns all relations or filters by atom, direction, or relation type.",
  parameters: z.object({
    atomId: z
      .string()
      .optional()
      .describe("The atom ID to query relations for (returns all relations if not provided)"),
    direction: z
      .enum(["in", "out", "all"])
      .optional()
      .default("all")
      .describe("Filter by direction: in (incoming), out (outgoing), all (default)"),
    relationType: z.enum(relationKinds).optional().describe("Filter by relation type"),
  }),
  async execute(params, ctx) {
    const researchProjectId = await Research.getResearchProjectId(ctx.sessionID)
    if (!researchProjectId) {
      return {
        title: "No relations",
        output: "Current session is not associated with any research project.",
        metadata: { count: 0 },
      }
    }

    const allAtoms = Database.use((db) =>
      db.select().from(AtomTable).where(eq(AtomTable.research_project_id, researchProjectId)).all(),
    )
    const atomMap = new Map(allAtoms.map((a) => [a.atom_id, a]))

    let relations = Database.use((db) => db.select().from(AtomRelationTable).all())

    if (params.atomId && params.direction === "in") {
      relations = relations.filter((r) => r.atom_id_target === params.atomId)
    } else if (params.atomId && params.direction === "out") {
      relations = relations.filter((r) => r.atom_id_source === params.atomId)
    }

    if (params.relationType) {
      relations = relations.filter((r) => r.relation_type === params.relationType)
    }

    if (relations.length === 0) {
      return {
        title: "No relations",
        output: params.atomId
          ? `No relations found for atom ${params.atomId}`
          : "No relations found in this research project.",
        metadata: { count: 0 },
      }
    }

    const lines = relations.map((r) => {
      const sourceAtom = atomMap.get(r.atom_id_source)
      const targetAtom = atomMap.get(r.atom_id_target)
      const sourceName = sourceAtom?.atom_name ?? r.atom_id_source.slice(0, 8)
      const targetName = targetAtom?.atom_name ?? r.atom_id_target.slice(0, 8)
      const sourceType = sourceAtom?.atom_type ?? "unknown"
      const targetType = targetAtom?.atom_type ?? "unknown"
      return `- ${sourceName} (${sourceType}) → ${targetName} (${targetType}) [${r.relation_type}]`
    })

    return {
      title: `${relations.length} relation(s)`,
      output: lines.join("\n"),
      metadata: { count: relations.length },
    }
  },
})

export const AtomRelationCreateTool = Tool.define("atom_relation_create", {
  description:
    "Create a relation between two existing atoms. " +
    "The relation connects a source atom to a target atom with a specific type.",
  parameters: z.object({
    sourceAtomId: z.string().describe("The ID of the source atom"),
    targetAtomId: z.string().describe("The ID of the target atom"),
    relationType: z
      .enum(relationKinds)
      .describe("The type of relation: motivates, formalizes, derives, analyzes, validates, contradicts, or other"),
    note: z.string().optional().describe("Optional note for the relation"),
  }),
  async execute(params, ctx) {
    const researchProjectId = await Research.getResearchProjectId(ctx.sessionID)
    if (!researchProjectId) {
      return {
        title: "Failed",
        output: "Current session is not associated with any research project.",
        metadata: { created: false },
      }
    }

    const sourceAtom = Database.use((db) =>
      db.select().from(AtomTable).where(eq(AtomTable.atom_id, params.sourceAtomId)).get(),
    )
    if (!sourceAtom) {
      return {
        title: "Failed",
        output: `Source atom not found: ${params.sourceAtomId}`,
        metadata: { created: false },
      }
    }

    const targetAtom = Database.use((db) =>
      db.select().from(AtomTable).where(eq(AtomTable.atom_id, params.targetAtomId)).get(),
    )
    if (!targetAtom) {
      return {
        title: "Failed",
        output: `Target atom not found: ${params.targetAtomId}`,
        metadata: { created: false },
      }
    }

    const now = Date.now()
    try {
      Database.use((db) =>
        db
          .insert(AtomRelationTable)
          .values({
            atom_id_source: params.sourceAtomId,
            atom_id_target: params.targetAtomId,
            relation_type: params.relationType,
            note: params.note ?? null,
            time_created: now,
            time_updated: now,
          })
          .run(),
      )
    } catch (error: any) {
      if (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        return {
          title: "Failed",
          output: `Relation already exists: ${sourceAtom.atom_name} → ${targetAtom.atom_name} [${params.relationType}]`,
          metadata: { created: false },
        }
      }
      throw error
    }

    await Bus.publish(Research.Event.AtomsUpdated, { researchProjectId })

    return {
      title: "Created relation",
      output: `Created relation: ${sourceAtom.atom_name} (${sourceAtom.atom_type}) → ${targetAtom.atom_name} (${targetAtom.atom_type}) [${params.relationType}]`,
      metadata: { created: true },
    }
  },
})

export const AtomRelationDeleteTool = Tool.define("atom_relation_delete", {
  description:
    "Delete one or more relations between atoms. " +
    "If relationType is not provided, deletes all relations between the source and target.",
  parameters: z.object({
    sourceAtomId: z.string().describe("The ID of the source atom"),
    targetAtomId: z.string().describe("The ID of the target atom"),
    relationType: z
      .enum(relationKinds)
      .optional()
      .describe("The type of relation to delete (deletes all if not provided)"),
  }),
  async execute(params, ctx) {
    const researchProjectId = await Research.getResearchProjectId(ctx.sessionID)
    if (!researchProjectId) {
      return {
        title: "Failed",
        output: "Current session is not associated with any research project.",
        metadata: { deleted: false, deletedCount: 0 },
      }
    }

    const existingRelations = Database.use((db) =>
      db.select().from(AtomRelationTable).where(eq(AtomRelationTable.atom_id_source, params.sourceAtomId)).all(),
    ).filter((r) => r.atom_id_target === params.targetAtomId)

    if (existingRelations.length === 0) {
      return {
        title: "Failed",
        output: `No relations found between ${params.sourceAtomId} and ${params.targetAtomId}`,
        metadata: { deleted: false, deletedCount: 0 },
      }
    }

    const toDelete = params.relationType
      ? existingRelations.filter((r) => r.relation_type === params.relationType)
      : existingRelations

    if (toDelete.length === 0) {
      return {
        title: "Failed",
        output: params.relationType
          ? `No relation of type [${params.relationType}] found between atoms`
          : "No relations to delete",
        metadata: { deleted: false, deletedCount: 0 },
      }
    }

    Database.use((db) => {
      if (params.relationType) {
        db.delete(AtomRelationTable)
          .where(
            and(
              eq(AtomRelationTable.atom_id_source, params.sourceAtomId),
              eq(AtomRelationTable.atom_id_target, params.targetAtomId),
              eq(AtomRelationTable.relation_type, params.relationType),
            ),
          )
          .run()
      } else {
        for (const rel of toDelete) {
          db.delete(AtomRelationTable)
            .where(
              and(
                eq(AtomRelationTable.atom_id_source, params.sourceAtomId),
                eq(AtomRelationTable.atom_id_target, params.targetAtomId),
                eq(AtomRelationTable.relation_type, rel.relation_type),
              ),
            )
            .run()
        }
      }
    })

    await Bus.publish(Research.Event.AtomsUpdated, { researchProjectId })

    const deletedTypes = toDelete.map((r) => r.relation_type).join(", ")
    return {
      title: `Deleted ${toDelete.length} relation(s)`,
      output: `Deleted relations: ${params.sourceAtomId.slice(0, 8)} → ${params.targetAtomId.slice(0, 8)} [${deletedTypes}]`,
      metadata: { deleted: true, deletedCount: toDelete.length },
    }
  },
})
