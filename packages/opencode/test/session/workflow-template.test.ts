import { describe, expect, test } from "bun:test"
import { WorkflowTemplates } from "../../src/workflow/templates"

describe("workflow spawn_agent test flow", () => {
  test("registers instructions for yielding while a spawned agent runs", async () => {
    const flow = WorkflowTemplates.flow("simple_test_v1", "spawn_agent_wait")
    expect(flow?.steps).toEqual(["spawn_wait", "spawn_finish"])

    const summary = await WorkflowTemplates.summary("simple_test_v1", "spawn_agent_wait")
    expect(summary).toContain("Do not call `workflow.next` in the same turn that creates the child agent")

    const prompt = await WorkflowTemplates.prompt("simple_test_v1", "spawn-wait")
    expect(prompt).toContain("After `spawn_agent` returns, stop the turn immediately")
  })

  test("registers parent-driven wait_interaction workflow", async () => {
    const parent = WorkflowTemplates.flow("simple_test_v1", "spawn_agent_parent_wait")
    expect(parent?.steps).toEqual(["parent_wait_child", "parent_wait_finish"])

    const child = WorkflowTemplates.flow("simple_test_v1", "child_parent_interaction")
    expect(child?.steps).toEqual(["child_wait_parent", "child_wait_finish"])

    const prompt = await WorkflowTemplates.prompt("simple_test_v1", "parent-wait-child")
    expect(prompt).toContain("When resumed with `child_waiting`, call `resume_agent`")

    const childPrompt = await WorkflowTemplates.prompt("simple_test_v1", "child-wait-parent")
    expect(childPrompt).toContain("call `workflow.wait_interaction`")
  })
})
