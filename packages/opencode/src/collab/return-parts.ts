import { CollabAgentNode } from "./agent-node"
import type {
  ChildDonePayload,
  ChildFailedPayload,
  ChildProgressPayload,
  ChildWaitingPayload,
  RemoteTaskTerminalPayload,
} from "./types"

/**
 * The shape we push into `SessionPrompt.prompt({ parts })` when delivering
 * inter-agent messages (child_done / child_failed / child_progress) to a
 * parent agent's session. The frontend registers a
 * `collab_return` Part renderer that gives these their own card UI, instead
 * of falling back to plain text.
 */
export type ChildReturnKind =
  | "child_done"
  | "child_failed"
  | "child_waiting"
  | "child_progress"
  | "remote_task_terminal"
  | "cancel"
  | "user_input"
  | "system"

export type ReturnPartDraft = {
  type: "collab_return"
  kind: ChildReturnKind
  childAgentId?: string
  childName?: string
  childSessionId?: string
  headline: string
  body: string
  payload?: Record<string, unknown>
}

export type PromptPartDraft = { type: "text"; text: string } | ReturnPartDraft

export const MAX_TEXT = 8 * 1024

export function truncate(text: string, max: number = MAX_TEXT) {
  if (text.length <= max) return text
  return text.slice(0, max) + "\n...[truncated]"
}

function childSessionIdForAgent(childAgentId?: string): string | undefined {
  if (!childAgentId) return undefined
  const child = CollabAgentNode.tryLoad(childAgentId)
  return child?.session_id
}

export function buildChildDonePart(p: ChildDonePayload): ReturnPartDraft {
  const body = p.summary.trim().length > 0 ? p.summary : "(no summary)"
  return {
    type: "collab_return",
    kind: "child_done",
    childAgentId: p.childAgentId,
    childName: p.childName,
    childSessionId: childSessionIdForAgent(p.childAgentId),
    headline: `Child ${p.childName ?? p.childAgentId} completed`,
    body,
    payload: p.result,
  }
}

export function buildChildFailedPart(p: ChildFailedPayload): ReturnPartDraft {
  const body = p.detail ? `${p.message}\n\n${p.detail}` : p.message
  return {
    type: "collab_return",
    kind: "child_failed",
    childAgentId: p.childAgentId,
    childName: p.childName,
    childSessionId: childSessionIdForAgent(p.childAgentId),
    headline: `Child ${p.childName ?? p.childAgentId} failed (${p.reason})`,
    body,
  }
}

export function buildChildWaitingPart(p: ChildWaitingPayload): ReturnPartDraft {
  const body = [
    p.message ?? "The child agent is waiting for input.",
    "",
    `Resume it with: resume_agent(agent_id=${p.childAgentId}, prompt=<your answer>)`,
  ].join("\n")
  return {
    type: "collab_return",
    kind: "child_waiting",
    childAgentId: p.childAgentId,
    childName: p.childName,
    childSessionId: p.childSessionId,
    headline: `Child ${p.childName ?? p.childAgentId} is waiting for input`,
    body,
    payload: {
      workflowInstanceId: p.workflowInstanceId,
      waitMessageId: p.waitMessageId,
      reason: p.reason,
      message: p.message,
    },
  }
}

export function buildChildProgressPart(p: ChildProgressPayload): ReturnPartDraft {
  const tools =
    p.tools.length > 0 ? ` · tools: ${p.tools.map((t) => `${t.name}(${t.ok ? "ok" : "err"})`).join(", ")}` : ""
  // Status-only ping: tell the parent LLM "this child is still working at
  // step N". The full child assistant prose is NOT shipped here — it bloats
  // the parent's context and encourages it to write verbose acks.
  return {
    type: "collab_return",
    kind: "child_progress",
    childAgentId: p.childAgentId,
    childName: p.childName,
    childSessionId: childSessionIdForAgent(p.childAgentId),
    headline: `${p.childName ?? p.childAgentId} · step ${p.turn}${tools}`,
    body: "",
  }
}

export function buildRemoteTaskTerminalPart(p: RemoteTaskTerminalPayload): ReturnPartDraft {
  const error = p.errorMessage ? `\nError: ${p.errorMessage}` : ""
  return {
    type: "collab_return",
    kind: "remote_task_terminal",
    headline: `Remote task ${p.title} reached ${p.status}`,
    body: [
      `Task ID: ${p.taskId}`,
      `Experiment: ${p.expId}`,
      `Kind: ${p.kind}`,
      `Status: ${p.status}`,
      `Log: ${p.logPath ?? "-"}${error}`,
      "",
      "Call experiment_remote_task_get with this taskId if you need the latest log tail before continuing.",
    ].join("\n"),
    payload: {
      taskId: p.taskId,
      expId: p.expId,
      kind: p.kind,
      status: p.status,
      logPath: p.logPath,
      errorMessage: p.errorMessage,
    },
  }
}

/** Apply body truncation right before handing to SessionPrompt. */
export function finalizeParts(parts: PromptPartDraft[]): PromptPartDraft[] {
  return parts.map((p) => ({
    ...p,
    ...(p.type === "collab_return" ? { body: truncate(p.body) } : {}),
  }))
}

export function matchParts(stored: { type: string; [key: string]: unknown }[], drafts: PromptPartDraft[]) {
  if (stored.length !== drafts.length) return false
  return drafts.every((draft, index) => {
    const part = stored[index]
    if (part.type !== draft.type) return false
    if (draft.type === "text") return part.text === draft.text
    return (
      part.kind === draft.kind &&
      part.childAgentId === draft.childAgentId &&
      part.childName === draft.childName &&
      part.childSessionId === draft.childSessionId &&
      part.headline === draft.headline &&
      part.body === draft.body &&
      JSON.stringify(part.payload) === JSON.stringify(draft.payload)
    )
  })
}
