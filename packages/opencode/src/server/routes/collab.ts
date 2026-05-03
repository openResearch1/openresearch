import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import z from "zod"
import { Collab, CollabAgentNode } from "@/collab"
import { Instance } from "@/project/instance"
import { AgentInfoSchema, CollabMsgKindSchema, MessageInfoSchema } from "@/collab/types"
import { errors } from "../error"

const treeResponseSchema = z
  .object({
    root: AgentInfoSchema,
    nodes: z.array(AgentInfoSchema),
  })
  .meta({ ref: "CollabTreeResponse" })

const activeAgentsResponseSchema = z
  .object({
    agents: z.array(AgentInfoSchema),
  })
  .meta({ ref: "CollabActiveAgentsResponse" })

const peerSessionIdsResponseSchema = z
  .object({
    session_ids: z.array(z.string()),
  })
  .meta({ ref: "CollabPeerSessionIdsResponse" })

const messagesResponseSchema = z
  .object({
    agent_id: z.string(),
    messages: z.array(MessageInfoSchema),
  })
  .meta({ ref: "CollabMessagesResponse" })

const sessionAgentResponseSchema = z
  .object({
    agent: AgentInfoSchema.nullable(),
  })
  .meta({ ref: "CollabSessionAgentResponse" })

const cancelBodySchema = z.object({
  reason: z.string().optional(),
})

const cancelResponseSchema = z
  .object({
    agent_id: z.string(),
    canceled: z.boolean(),
  })
  .meta({ ref: "CollabCancelResponse" })

const messagesQuerySchema = z.object({
  kind: CollabMsgKindSchema.optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
})

function toMessageInfo(row: ReturnType<typeof Collab.listMessages>[number]) {
  return {
    id: row.id,
    recipient_agent_id: row.recipient_agent_id,
    sender_agent_id: row.sender_agent_id,
    kind: row.kind,
    payload: row.payload_json,
    status: row.status,
    time_created: row.time_created,
    time_updated: row.time_updated,
    time_consumed: row.time_consumed,
  }
}

export const CollabRoutes = new Hono()
  .get(
    "/active",
    describeRoute({
      summary: "List active Collab agents in the current project",
      description:
        "Return every collab_agent with status pending, running, or blocked_on_children for the current project.",
      operationId: "collab.active.list",
      responses: {
        200: {
          description: "Active agents",
          content: { "application/json": { schema: resolver(activeAgentsResponseSchema) } },
        },
      },
    }),
    async (c) => {
      const agents = CollabAgentNode.loadActiveByProject(Instance.project.id)
      return c.json({ agents })
    },
  )
  .get(
    "/peer-sessions",
    describeRoute({
      summary: "List session ids of all Collab peer agents (non-root) in current project",
      description:
        "Returns the set of session ids that belong to peer (non-root) Collab agents. Used by the UI sidebar to hide peer sessions from the flat session list — they are only ever reached via the parent agent's dock.",
      operationId: "collab.peerSessions.list",
      responses: {
        200: {
          description: "Peer session ids",
          content: { "application/json": { schema: resolver(peerSessionIdsResponseSchema) } },
        },
      },
    }),
    async (c) => {
      const ids = CollabAgentNode.loadPeerSessionIdsByDirectory(Instance.project.id, Instance.directory)
      return c.json({ session_ids: ids })
    },
  )
  .get(
    "/tree/:rootAgentId",
    describeRoute({
      summary: "Get the Collab agent tree",
      description: "Return the full tree of AgentNodes rooted at rootAgentId.",
      operationId: "collab.tree.get",
      responses: {
        200: {
          description: "Tree found",
          content: { "application/json": { schema: resolver(treeResponseSchema) } },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const rootAgentId = c.req.param("rootAgentId")
      const nodes = Collab.tree(rootAgentId)
      const root = nodes.find((n) => n.id === rootAgentId)
      if (!root) {
        return c.json({ success: false, message: `No agent ${rootAgentId}` }, 404)
      }
      return c.json({ root, nodes })
    },
  )
  .get(
    "/agent/:agentId",
    describeRoute({
      summary: "Get a single Collab agent",
      description: "Return detail for a single AgentNode.",
      operationId: "collab.agent.get",
      responses: {
        200: {
          description: "Agent found",
          content: { "application/json": { schema: resolver(AgentInfoSchema) } },
        },
        ...errors(404),
      },
    }),
    async (c) => {
      const agentId = c.req.param("agentId")
      const info = Collab.tryGet(agentId)
      if (!info) return c.json({ success: false, message: `No agent ${agentId}` }, 404)
      return c.json(info)
    },
  )
  .get(
    "/agent/:agentId/messages",
    describeRoute({
      summary: "Get an agent's inbox messages",
      description: "Return inbox messages (pending + consumed) for an agent.",
      operationId: "collab.agent.messages",
      responses: {
        200: {
          description: "Messages",
          content: { "application/json": { schema: resolver(messagesResponseSchema) } },
        },
        ...errors(404),
      },
    }),
    validator("query", messagesQuerySchema),
    async (c) => {
      const agentId = c.req.param("agentId")
      const target = Collab.tryGet(agentId)
      if (!target) return c.json({ success: false, message: `No agent ${agentId}` }, 404)
      const { kind, limit } = c.req.valid("query")
      const rows = Collab.listMessages(agentId, { kind, limit })
      return c.json({
        agent_id: agentId,
        messages: rows.map(toMessageInfo),
      })
    },
  )
  .get(
    "/session/:sessionId/agent",
    describeRoute({
      summary: "Get the Collab agent bound to a session",
      description: "Look up whether a session is bound to a Collab AgentNode.",
      operationId: "collab.session.agent.get",
      responses: {
        200: {
          description: "Lookup result (agent may be null)",
          content: { "application/json": { schema: resolver(sessionAgentResponseSchema) } },
        },
      },
    }),
    async (c) => {
      const sessionId = c.req.param("sessionId")
      const info = Collab.getBySession(sessionId) ?? null
      return c.json({ agent: info })
    },
  )
  .post(
    "/agent/:agentId/cancel",
    describeRoute({
      summary: "Cancel a Collab agent",
      description: "Post a cancel message to this agent and propagate to its descendants.",
      operationId: "collab.agent.cancel",
      responses: {
        200: {
          description: "Cancel requested",
          content: { "application/json": { schema: resolver(cancelResponseSchema) } },
        },
        ...errors(404),
      },
    }),
    validator("json", cancelBodySchema),
    async (c) => {
      const agentId = c.req.param("agentId")
      const target = Collab.tryGet(agentId)
      if (!target) return c.json({ success: false, message: `No agent ${agentId}` }, 404)
      const body = c.req.valid("json")
      await Collab.cancel(agentId, body.reason)
      return c.json({ agent_id: agentId, canceled: true })
    },
  )
