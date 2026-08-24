import { describe, expect, test } from "bun:test"

import { dict as en } from "../i18n/en"
import { dict as zh } from "../i18n/zh"
import { children, isResearchTool, payload, registerResearchTools } from "./research-tools"

const tools = [
  ["article_query", "ui.tool.research.article.query"],
  ["article_status_update", "ui.tool.research.article.status"],
  ["research_code_query", "ui.tool.research.code.query"],
  ["research_code_branch_query", "ui.tool.research.code.branches"],
  ["research_background_edit", "ui.tool.research.project.background"],
  ["research_goal_edit", "ui.tool.research.project.goal"],
  ["research_macro_edit", "ui.tool.research.project.macro"],
  ["research_info", "ui.tool.research.project.info"],
  ["research_path", "ui.tool.research.project.path"],
  ["research_result_query", "ui.tool.research.result.query"],
  ["research_result_submit", "ui.tool.research.result.submit"],
  ["convert", "ui.tool.research.document.convert"],
  ["read_agent_output", "ui.tool.research.agent.output"],
] as const

const row = {
  agent_id: "agent_1",
  name: "Inspect frontend",
  subagent_type: "explore",
  status: "running",
  active_children: 0,
  spawned_at: 1,
  ended_at: null,
}

describe("research tool children output", () => {
  test("parses child rows", () => {
    expect(children(JSON.stringify({ children: [row] }))).toEqual([row])
  })

  test("ignores a polling warning after the payload", () => {
    const output = `${JSON.stringify({ children: [row] }, null, 2)}\nPOLLING WARNING: Do not poll.`
    expect(children(output)).toEqual([row])
  })

  test("preserves an empty child list", () => {
    expect(children('{"children":[]}')).toEqual([])
  })

  test("rejects plain, malformed, and truncated output", () => {
    expect(children("No Collab agent bound to this session yet.")).toBeUndefined()
    expect(children('{"children":[')).toBeUndefined()
    expect(children(JSON.stringify({ children: [row] }), true)).toBeUndefined()
  })
})

describe("research tool cards", () => {
  test("registers the new tool renderers", () => {
    const registered: Array<{ name: string; render?: unknown }> = []
    registerResearchTools((input) => registered.push(input))

    for (const [name] of tools) {
      expect(isResearchTool(name)).toBe(true)
      expect(registered.filter((item) => item.name === name)).toHaveLength(1)
      expect(registered.find((item) => item.name === name)?.render).toBeFunction()
    }
  })

  test("provides English and Chinese titles", () => {
    for (const [, key] of tools) {
      expect(en[key]).toBeTruthy()
      expect(zh[key]).toBeTruthy()
    }
  })

  test("parses complete structured output", () => {
    expect(payload('\u001b[32m{"status":"completed","items":[1]}\u001b[0m')).toEqual({
      status: "completed",
      items: [1],
    })
  })

  test("rejects malformed and backend-truncated output", () => {
    expect(payload('{"items":[')).toBeUndefined()
    expect(payload('{"items":[]}', true)).toBeUndefined()
  })
})
