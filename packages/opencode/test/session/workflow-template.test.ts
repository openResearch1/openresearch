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

describe("experiment workflow templates", () => {
  test("registers the lightweight v2 flow with approval gates", async () => {
    const flow = WorkflowTemplates.flow("experiment_execution_v2", "default")
    expect(flow?.steps).toEqual(["plan", "implement", "execute"])

    const template = WorkflowTemplates.get("experiment_execution_v2")
    expect(template?.defs.plan.policy.can_next).toEqual(["plan_approved == true"])
    expect(template?.defs.plan.policy.can_wait_interaction).toBe(true)
    expect(template?.defs.implement.policy.can_next).toEqual(["run_approved == true"])
    expect(template?.defs.implement.policy.can_wait_interaction).toBe(true)
    expect(template?.defs.execute.policy.can_next).toEqual(["execution_complete == true"])

    const plan = await WorkflowTemplates.prompt("experiment_execution_v2", "plan")
    expect(plan).toContain("workflow.wait_interaction")
    expect(plan).toContain("Do not modify experiment code in this phase")

    const implement = await WorkflowTemplates.prompt("experiment_execution_v2", "implement")
    expect(implement).toContain("Do not sync code")
    expect(implement).toContain("run_approved: true")

    const execute = await WorkflowTemplates.prompt("experiment_execution_v2", "execute")
    expect(execute).toContain("Decide what is needed from the current state instead of following a fixed sequence")
    expect(execute).toContain("execution_complete: true")
  })

  test("keeps the v1 template registered for active workflows", () => {
    const flow = WorkflowTemplates.flow("experiment_execution_v1", "default")
    expect(flow?.steps).toContain("plan_user_review")
    expect(flow?.steps).toContain("run_user_review")
  })
})
