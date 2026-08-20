import { createMemo, type JSX } from "solid-js"

import { useData } from "../context/data"
import { TextShimmer } from "./text-shimmer"

const colors = ["blue", "violet", "cyan", "rose", "lime", "orange"] as const

function color(agent: string) {
  const name = agent.toLowerCase()
  if (name === "atom") return "atom"
  if (name.startsWith("experiment") || name.startsWith("project_runtime")) return "experiment"
  if (name === "explore" || name.includes("search")) return "explore"
  if (name === "general") return "general"
  if (name === "build" || name.includes("commit") || name.includes("code")) return "build"
  if (name === "plan" || name.includes("review")) return "plan"
  if (name.startsWith("research") || name.startsWith("deep_research") || name.includes("evidence")) return "research"
  const hash = [...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0)
  return colors[hash % colors.length]
}

function tone(status: string) {
  const value = status.toLowerCase()
  if (value === "done" || value === "completed") return "success"
  if (value === "failed") return "error"
  if (value === "waiting") return "waiting"
  if (value === "running") return "running"
  if (value === "canceled" || value === "cancelled") return "muted"
  return "neutral"
}

function label(agent: string) {
  if (agent.toLowerCase() === "atom") return "Atom"
  return agent
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ")
}

export function SubagentSessionItem(props: {
  agent: string
  title: string
  status: string
  statusTone?: "neutral" | "success" | "error" | "waiting" | "running" | "muted"
  sessionId?: string
  active?: boolean
  tooltip?: string
}) {
  const data = useData()
  const href = createMemo(() => {
    if (!props.sessionId) return
    const direct = data.sessionHref?.(props.sessionId)
    if (direct) return direct
    if (typeof window === "undefined") return
    const path = window.location.pathname
    const index = path.indexOf("/session")
    if (index === -1) return
    return `${path.slice(0, index)}/session/${props.sessionId}`
  })

  const click = (event: MouseEvent) => {
    const url = href()
    const sessionId = props.sessionId
    if (!url || !sessionId) return
    event.stopPropagation()
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (!data.navigateToSession || typeof window === "undefined") return
    event.preventDefault()
    if (data.navigateToSession(sessionId)) return
    const before = window.location.pathname + window.location.search + window.location.hash
    setTimeout(() => {
      const after = window.location.pathname + window.location.search + window.location.hash
      if (after === before) window.location.assign(url)
    }, 50)
  }

  const content = (): JSX.Element => (
    <>
      <span data-slot="subagent-session-agent" data-tone={color(props.agent)}>
        {label(props.agent)}
      </span>
      <span data-slot="subagent-session-title">{props.title}</span>
      <span data-slot="subagent-session-status" data-tone={props.statusTone ?? tone(props.status)}>
        <TextShimmer text={props.status} active={props.active === true} />
      </span>
    </>
  )

  return (
    <div data-component="subagent-session-block">
      <a
        data-component="subagent-session-item"
        data-disabled={href() ? undefined : ""}
        href={href()}
        onClick={click}
        title={props.tooltip}
        aria-disabled={href() ? undefined : "true"}
        aria-label={`${label(props.agent)}: ${props.title}, ${props.status}`}
      >
        {content()}
      </a>
    </div>
  )
}
