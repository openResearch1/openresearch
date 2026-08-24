import type { CollabAgent, ResearchExperimentBySessionResponse } from "@opencode-ai/sdk/v2/client"

import { withSession } from "../actions"
import { test, expect } from "../fixtures"
import {
  promptSelector,
  sessionCollabPopoverSelector,
  sessionCollabTriggerSelector,
  sessionControlNoticeSelector,
} from "../selectors"

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

function experiment(sessionID: string): NonNullable<ResearchExperimentBySessionResponse> {
  return {
    exp_id: "exp_e2e",
    kind: "experiment",
    runtime_key: null,
    research_project_id: "research_e2e",
    exp_name: "Completed Collab experiment",
    exp_session_id: sessionID,
    baseline_branch_name: null,
    baseline_commit_sha: null,
    exp_branch_name: null,
    exp_result_path: null,
    atom_id: null,
    exp_result_summary_path: null,
    exp_plan_path: null,
    remote_server_id: null,
    remote_server_config: null,
    code_path: "",
    remote_code_path: null,
    status: "idle",
    started_at: null,
    finished_at: null,
    time_created: 1,
    time_updated: 1,
    atom: null,
    article: null,
  }
}

test("Collab experiment navigation stays in the SPA without loading flashes", async ({ page, sdk, gotoSession }) => {
  test.setTimeout(120_000)
  await withSession(sdk, "e2e Collab popover", async (session) => {
    await withSession(sdk, "e2e Collab child", async (childSession) => {
      await sdk.session.promptAsync({
        sessionID: childSession.id,
        noReply: true,
        parts: [{ type: "text", text: "e2e Collab child" }],
      })
      await expect
        .poll(
          () => sdk.session.messages({ sessionID: childSession.id, limit: 1 }).then((result) => result.data?.length ?? 0),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0)

      const root = agent({ session_id: session.id })
      const child = agent({
        id: "collab_completed",
        session_id: childSession.id,
        parent_agent_id: root.id,
        name: "Completed Collab agent",
        status: "completed",
        spec: { initialPrompt: "", metadata: { expId: "exp_e2e" } },
        time_ended: 2,
        time_updated: 2,
      })

      await page.route("**/collab/session/*/agent*", async (route) => {
        const current = route.request().url().includes(childSession.id) ? child : root
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ agent: current }) })
      })
      await page.route("**/collab/tree/*", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 150))
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ root, nodes: [root, child] }),
        })
      })
      await page.route("**/research/project/by-project/*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            research_project_id: "research_e2e",
            project_id: "project",
            background_path: null,
            goal_path: null,
            macro_table_path: null,
            time_created: 1,
            time_updated: 1,
          }),
        })
      })
      await page.route("**/research/session/*/atom*", async (route) => {
        if (route.request().url().includes(childSession.id)) await new Promise((resolve) => setTimeout(resolve, 150))
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ atom: null }) })
      })
      await page.route("**/research/experiment/session/*", async (route) => {
        const childRequest = route.request().url().includes(childSession.id)
        if (childRequest) await new Promise((resolve) => setTimeout(resolve, 150))
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(childRequest ? experiment(childSession.id) : null),
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

      const documents: string[] = []
      const errors: string[] = []
      const request = (req: { url: () => string; resourceType: () => string }) => {
        if (req.resourceType() === "document") documents.push(req.url())
      }
      const onError = (error: Error) => errors.push(error.message)
      page.on("request", request)
      page.on("pageerror", onError)
      const token = crypto.randomUUID()
      await page.evaluate((value) => {
        Reflect.set(window, "__opencodeCollabNavigation", value)
        Reflect.set(window, "__opencodeCollabPagehide", false)
        Reflect.set(window, "__opencodeCollabLoading", false)
        window.addEventListener("pagehide", () => Reflect.set(window, "__opencodeCollabPagehide", true), { once: true })
        const loading = '[data-component="session-loading"], [data-component="app-loading"]'
        const mark = (records: MutationRecord[]) => {
          const found = records.some((record) =>
            [...record.addedNodes].some(
              (node) => node instanceof Element && (node.matches(loading) || !!node.querySelector(loading)),
            ),
          )
          if (found) Reflect.set(window, "__opencodeCollabLoading", true)
        }
        const observer = new MutationObserver(mark)
        observer.observe(document.body, { childList: true, subtree: true })
        Reflect.set(window, "__opencodeCollabLoadingObserver", observer)
      }, token)

      await popover.getByRole("button", { name: /completed collab agent/i }).click()
      await expect(page).toHaveURL(new RegExp(`/session/${childSession.id}(?:[/?#]|$)`), { timeout: 30_000 })

      const parent = page.locator('nav[aria-label="collab agent ancestors"] a').first()
      await expect(parent).toBeVisible({ timeout: 30_000 })
      const notice = page.locator(sessionControlNoticeSelector)
      await expect(notice).toContainText("Controlled by Collab root.")
      await expect(page.locator(promptSelector)).toHaveCount(0)
      await notice.getByRole("button", { name: "Open controller" }).click()
      await expect(page).toHaveURL(new RegExp(`/session/${session.id}(?:[/?#]|$)`), { timeout: 30_000 })
      await page.waitForTimeout(250)

      expect(await page.evaluate(() => Reflect.get(window, "__opencodeCollabNavigation"))).toBe(token)
      expect(await page.evaluate(() => Reflect.get(window, "__opencodeCollabPagehide"))).toBe(false)
      expect(await page.evaluate(() => Reflect.get(window, "__opencodeCollabLoading"))).toBe(false)
      expect(documents).toEqual([])
      expect(errors).toEqual([])
      await page.evaluate(() => {
        const observer = Reflect.get(window, "__opencodeCollabLoadingObserver")
        if (observer instanceof MutationObserver) observer.disconnect()
      })
      page.off("request", request)
      page.off("pageerror", onError)
    })
  })
})
