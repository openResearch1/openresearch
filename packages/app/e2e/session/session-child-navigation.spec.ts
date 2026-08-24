import { seedSessionTask, waitSessionIdle, withSession } from "../actions"
import { test, expect } from "../fixtures"
import { promptSelector, sessionControlNoticeSelector } from "../selectors"

test("task tool child-session link does not trigger stale show errors", async ({ page, sdk, gotoSession }) => {
  test.setTimeout(120_000)

  const errs: string[] = []
  const onError = (err: Error) => {
    errs.push(err.message)
  }
  page.on("pageerror", onError)

  const title = `e2e child nav ${Date.now()}`
  await withSession(sdk, title, async (session) => {
    const child = await seedSessionTask(sdk, {
      sessionID: session.id,
      description: "Open child session",
      prompt: "Search the repository for AssistantParts and then reply with exactly CHILD_OK.",
    })
    await waitSessionIdle(sdk, child.sessionID, 90_000)

    try {
      await gotoSession(session.id)

      const link = page
        .locator('a[data-component="subagent-session-item"]')
        .filter({ hasText: /open child session/i })
        .first()
      await expect(link).toBeVisible({ timeout: 30_000 })

      const documents: string[] = []
      const request = (req: { url: () => string; resourceType: () => string }) => {
        if (req.resourceType() === "document") documents.push(req.url())
      }
      page.on("request", request)

      const token = crypto.randomUUID()
      await page.evaluate((value) => {
        Reflect.set(window, "__opencodeSessionNavigation", value)
        Reflect.set(window, "__opencodeSessionPagehide", false)
        Reflect.set(window, "__opencodeSessionLoading", false)
        window.addEventListener("pagehide", () => Reflect.set(window, "__opencodeSessionPagehide", true), { once: true })
        const loading = '[data-component="session-loading"], [data-component="app-loading"]'
        const mark = (records: MutationRecord[]) => {
          const found = records.some((record) =>
            [...record.addedNodes].some(
              (node) => node instanceof Element && (node.matches(loading) || !!node.querySelector(loading)),
            ),
          )
          if (found) Reflect.set(window, "__opencodeSessionLoading", true)
        }
        const observer = new MutationObserver(mark)
        observer.observe(document.body, { childList: true, subtree: true })
        Reflect.set(window, "__opencodeSessionLoadingObserver", observer)
      }, token)
      await link.click()

      await expect(page).toHaveURL(new RegExp(`/session/${child.sessionID}(?:[/?#]|$)`), { timeout: 30_000 })
      await expect(page.locator("[data-timeline-staging]")).toHaveCount(0)
      await expect(page.locator("[data-session-timeline] .scroll-view__viewport")).toHaveJSProperty("scrollTop", 0)
      const notice = page.locator(sessionControlNoticeSelector)
      await expect(notice).toContainText(`Controlled by ${title}.`)
      await expect(page.locator(promptSelector)).toHaveCount(0)
      await expect(page.locator('nav[aria-label="parent session"] a')).toBeVisible()
      await notice.getByRole("button", { name: "Open controller" }).click()
      await expect(page).toHaveURL(new RegExp(`/session/${session.id}(?:[/?#]|$)`), { timeout: 30_000 })
      await expect(page.locator("[data-timeline-staging]")).toHaveCount(0)
      await expect(page.locator("[data-session-timeline] .scroll-view__viewport")).toHaveJSProperty("scrollTop", 0)
      await page.waitForTimeout(250)

      expect(await page.evaluate(() => Reflect.get(window, "__opencodeSessionNavigation"))).toBe(token)
      expect(await page.evaluate(() => Reflect.get(window, "__opencodeSessionPagehide"))).toBe(false)
      expect(await page.evaluate(() => Reflect.get(window, "__opencodeSessionLoading"))).toBe(false)
      expect(documents).toEqual([])
      expect(errs).toEqual([])
      await page.evaluate(() => {
        const observer = Reflect.get(window, "__opencodeSessionLoadingObserver")
        if (observer instanceof MutationObserver) observer.disconnect()
      })
      page.off("request", request)
    } finally {
      page.off("pageerror", onError)
    }
  })
})
