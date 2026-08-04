import { describe, expect, spyOn, test } from "bun:test"

import { Collab } from "../../src/collab"
import { CollabLoop } from "../../src/collab/loop"
import { ProjectTable } from "../../src/project/project.sql"
import { Instance } from "../../src/project/instance"
import { ControllerAgent } from "../../src/research/controller-agent"
import { ResearchPath } from "../../src/research/research-path"
import { AtomRelationTable, AtomTable, ResearchProjectTable } from "../../src/research/research.sql"
import { ResearchRoutes } from "../../src/server/routes/research"
import { Session } from "../../src/session"
import { Database } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

async function seed() {
  const session = await Session.create({ title: "Research" })
  const other = await Session.create({ title: "Other" })
  const research = crypto.randomUUID()
  const first = crypto.randomUUID()
  const second = crypto.randomUUID()
  const foreign = crypto.randomUUID()
  const project = crypto.randomUUID()
  const foreignResearch = crypto.randomUUID()
  const now = Date.now()

  Database.use((db) => {
    db.insert(ResearchProjectTable)
      .values({
        research_project_id: research,
        project_id: Instance.project.id,
        time_created: now,
        time_updated: now,
      })
      .run()
    db.insert(ProjectTable)
      .values({
        id: project,
        worktree: `${Instance.directory}-foreign`,
        sandboxes: [],
        time_created: now,
        time_updated: now,
      })
      .run()
    db.insert(ResearchProjectTable)
      .values({
        research_project_id: foreignResearch,
        project_id: project,
        time_created: now,
        time_updated: now,
      })
      .run()
    db.insert(AtomTable)
      .values([
        {
          atom_id: first,
          research_project_id: research,
          atom_name: "Promising method",
          atom_type: "method",
          atom_evidence_type: "math",
          atom_evidence_status: "proven",
          time_created: now,
          time_updated: now,
        },
        {
          atom_id: second,
          research_project_id: research,
          atom_name: "Failed validation",
          atom_type: "verification",
          atom_evidence_type: "experiment",
          atom_evidence_status: "disproven",
          time_created: now,
          time_updated: now,
        },
        {
          atom_id: foreign,
          research_project_id: foreignResearch,
          atom_name: "Foreign atom",
          atom_type: "fact",
          atom_evidence_type: "math",
          atom_evidence_status: "pending",
          time_created: now,
          time_updated: now,
        },
      ])
      .run()
    db.insert(AtomRelationTable)
      .values({
        atom_id_source: first,
        atom_id_target: second,
        relation_type: "evaluated_by",
        time_created: now,
        time_updated: now,
      })
      .run()
  })

  return { session, other, research, first, second, foreign }
}

describe("research.path", () => {
  test("allows a Controller Research Main to own Paths but rejects its descendants", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const controller = await ControllerAgent.create(item.research)
        const start = spyOn(CollabLoop, "start").mockResolvedValue()
        try {
          const main = await Collab.spawn({
            parentAgentId: controller.agent.id,
            name: "Research Main",
            subagentType: "research",
            spec: { initialPrompt: "research" },
          })
          const leaf = await Collab.spawn({
            parentAgentId: main.id,
            name: "Research leaf",
            subagentType: "research",
            spec: { initialPrompt: "focused work" },
          })
          const task = await Session.create({ parentID: main.session_id, title: "Research task" })
          const path = await ResearchPath.create({
            sessionID: main.session_id,
            agent: "research",
            title: "Controller direction",
            brief: "Maintain this direction from the Controller Research Main.",
            atoms: [],
          })

          expect(path.creator_session_id).toBe(main.session_id)
          expect(
            await ResearchPath.update({
              sessionID: main.session_id,
              agent: "research",
              researchPathID: path.research_path_id,
              summary: "Main-owned progress",
              add: [],
              remove: [],
            }),
          ).toMatchObject({ summary: "Main-owned progress" })
          await expect(
            ResearchPath.create({
              sessionID: leaf.session_id,
              agent: "research",
              title: "Denied leaf",
              brief: "Leaf agents cannot own Paths.",
              atoms: [],
            }),
          ).rejects.toThrow("main Research session")
          await expect(
            ResearchPath.create({
              sessionID: task.id,
              agent: "research",
              title: "Denied task",
              brief: "Task agents cannot own Paths.",
              atoms: [],
            }),
          ).rejects.toThrow("main Research session")
        } finally {
          start.mockRestore()
        }
      },
    })
  })

  test("persists multiple attention subgraphs with Atom state and relations", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        const first = await ResearchPath.create({
          sessionID: item.session.id,
          agent: "research",
          title: "Validate the method",
          brief: "Test the method while preserving negative evidence.",
          atoms: [
            { atomID: item.first, role: "seed" },
            { atomID: item.second, role: "member" },
          ],
        })
        const second = await ResearchPath.create({
          sessionID: item.session.id,
          agent: "research",
          title: "Independent direction",
          brief: "Keep a second active direction.",
          atoms: [],
        })

        expect(first.status).toBe("active")
        expect(first.atoms).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ atom_id: item.first, role: "seed", atom_evidence_status: "proven" }),
            expect.objectContaining({ atom_id: item.second, role: "member", atom_evidence_status: "disproven" }),
          ]),
        )
        expect(first.relations).toEqual([
          expect.objectContaining({
            atom_id_source: item.first,
            atom_id_target: item.second,
            relation_type: "evaluated_by",
          }),
        ])
        expect(first.stages).toEqual([
          { index: 1, groups: [{ atom_ids: [item.first], cyclic: false }] },
          { index: 2, groups: [{ atom_ids: [item.second], cyclic: false }] },
        ])
        expect(ResearchPath.sequence(first.atoms, [])).toEqual([
          {
            index: 1,
            groups: [
              { atom_ids: [item.first], cyclic: false },
              { atom_ids: [item.second], cyclic: false },
            ],
          },
        ])
        expect(
          ResearchPath.sequence(first.atoms, [
            ...first.relations,
            {
              atom_id_source: item.second,
              atom_id_target: item.first,
              relation_type: "contradicts",
              note: null,
            },
          ]),
        ).toEqual(first.stages)
        expect(
          ResearchPath.sequence(first.atoms, [
            ...first.relations,
            {
              atom_id_source: item.second,
              atom_id_target: item.first,
              relation_type: "analyzed_by",
              note: null,
            },
          ]),
        ).toEqual([{ index: 1, groups: [{ atom_ids: [item.first, item.second], cyclic: true }] }])
        expect(ResearchPath.list(item.research).filter((path) => path.status === "active")).toHaveLength(2)
        expect(second.stages).toEqual([])
        expect(second.creator_session_id).toBe(item.session.id)
      },
    })
  })

  test("enforces project, agent, owner, and terminal lifecycle rules", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const item = await seed()
        await expect(
          ResearchPath.create({
            sessionID: item.session.id,
            agent: "plan",
            title: "Denied",
            brief: "Wrong agent.",
            atoms: [],
          }),
        ).rejects.toThrow("research agent")
        await expect(
          ResearchPath.create({
            sessionID: item.session.id,
            agent: "research",
            title: "Denied",
            brief: "Foreign Atom.",
            atoms: [{ atomID: item.foreign, role: "seed" }],
          }),
        ).rejects.toThrow("same Research Project")

        const path = await ResearchPath.create({
          sessionID: item.session.id,
          agent: "research",
          title: "Negative direction",
          brief: "Record an inconclusive attempt.",
          atoms: [{ atomID: item.second, role: "seed" }],
        })
        await expect(
          ResearchPath.update({
            sessionID: item.other.id,
            agent: "research",
            researchPathID: path.research_path_id,
            title: "Stolen",
            add: [],
            remove: [],
          }),
        ).rejects.toThrow("creating Session")

        const cancelled = await ResearchPath.transition({
          sessionID: item.session.id,
          agent: "research",
          researchPathID: path.research_path_id,
          status: "cancelled",
          summary: "The validation disproved the direction.",
        })
        expect(cancelled).toMatchObject({
          status: "cancelled",
          summary: "The validation disproved the direction.",
        })
        await expect(
          ResearchPath.update({
            sessionID: item.session.id,
            agent: "research",
            researchPathID: path.research_path_id,
            summary: "Resume",
            add: [],
            remove: [],
          }),
        ).rejects.toThrow("cannot be changed")

        const response = await ResearchRoutes.request(`/project/${item.research}/paths`)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual([expect.objectContaining({ status: "cancelled" })])
      },
    })
  })
})
