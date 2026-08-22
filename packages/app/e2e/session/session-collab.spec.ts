import type { CollabAgent } from "@opencode-ai/sdk/v2/client"

import { withSession } from "../actions"
import { test, expect } from "../fixtures"
import { sessionCollabPopoverSelector, sessionCollabTriggerSelector } from "../selectors"

function agent(input: Partial<CollabAgent>): CollabAgent {
  return {
    id: "collab_root",
    session_id: "session",
    parent_agent_id: null,
    name: "Collab root",
    project_id: "project",
    root_agent_id: "collab_root",
    run_id: null,
    initiator: null,
    subagent_type: "general",
    status: "idle",
    phase: "main_loop",
    spec: { initialPrompt: "" },
    result: null,
    error: null,
    active_children: 0,
    spawned_total: 1,
    time_created: 1,
    time_updated: 1,
    time_started: 1,
    time_ended: null,
    ...input,
  }
}

test("Collab history opens on demand with completed agents folded", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, "e2e Collab popover", async (session) => {
    const root = agent({ session_id: session.id })
    const child = agent({
      id: "collab_completed",
      session_id: "collab_completed_session",
      parent_agent_id: root.id,
      name: "Completed Collab agent",
      status: "completed",
      time_ended: 2,
      time_updated: 2,
    })

    await page.route("**/collab/session/*/agent*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ agent: root }) })
    })
    await page.route("**/collab/tree/*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ root, nodes: [root, child] }),
      })
    })
    await gotoSession(session.id)

    await expect(page.locator('[data-component="session-collab-dock"]')).toHaveCount(0)
    const trigger = page.locator(sessionCollabTriggerSelector)
    await expect(trigger).toBeVisible()
    await expect(page.locator(sessionCollabPopoverSelector)).toHaveCount(0)

    await trigger.click()
    const popover = page.locator(sessionCollabPopoverSelector)
    await expect(popover).toBeVisible()
    await expect(popover.getByText("Completed Collab agent")).toHaveCount(0)
    await expect(popover.getByText("No active Collab agents.")).toBeVisible()

    await popover.getByRole("button", { name: /show completed/i }).click()
    await expect(popover.getByText("Completed Collab agent")).toBeVisible()

    await page.keyboard.press("Escape")
    await expect(popover).toHaveCount(0)
  })
})
