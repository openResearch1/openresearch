import { seedSessionTask, withSession } from "../actions"
import { test, expect } from "../fixtures"

test("task tool child-session link does not trigger stale show errors", async ({ page, sdk, gotoSession }) => {
  test.setTimeout(120_000)

  const errs: string[] = []
  const onError = (err: Error) => {
    errs.push(err.message)
  }
  page.on("pageerror", onError)

  await withSession(sdk, `e2e child nav ${Date.now()}`, async (session) => {
    const child = await seedSessionTask(sdk, {
      sessionID: session.id,
      description: "Open child session",
      prompt: "Search the repository for AssistantParts and then reply with exactly CHILD_OK.",
    })

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
        window.addEventListener("pagehide", () => Reflect.set(window, "__opencodeSessionPagehide", true), { once: true })
      }, token)
      await link.click()

      await expect(page).toHaveURL(new RegExp(`/session/${child.sessionID}(?:[/?#]|$)`), { timeout: 30_000 })
      await page.locator('nav[aria-label="parent session"] a').click()
      await expect(page).toHaveURL(new RegExp(`/session/${session.id}(?:[/?#]|$)`), { timeout: 30_000 })
      await page.waitForTimeout(250)

      expect(await page.evaluate(() => Reflect.get(window, "__opencodeSessionNavigation"))).toBe(token)
      expect(await page.evaluate(() => Reflect.get(window, "__opencodeSessionPagehide"))).toBe(false)
      expect(documents).toEqual([])
      expect(errs).toEqual([])
      page.off("request", request)
    } finally {
      page.off("pageerror", onError)
    }
  })
})
