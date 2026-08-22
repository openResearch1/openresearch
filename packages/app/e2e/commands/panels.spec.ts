import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import { sessionComposerDockSelector, sessionTimelineHeaderSelector } from "../selectors"
import { modKey } from "../utils"

const expanded = async (el: { getAttribute: (name: string) => Promise<string | null> }) => {
  const value = await el.getAttribute("aria-expanded")
  if (value !== "true" && value !== "false") throw new Error(`Expected aria-expanded to be true|false, got: ${value}`)
  return value === "true"
}

test("review panel can be toggled via keybind", async ({ page, gotoSession }) => {
  await gotoSession()

  const reviewPanel = page.locator("#review-panel")

  const treeToggle = page.getByRole("button", { name: "Toggle file tree" }).first()
  await expect(treeToggle).toBeVisible()
  if (await expanded(treeToggle)) await treeToggle.click()
  await expect(treeToggle).toHaveAttribute("aria-expanded", "false")

  const reviewToggle = page.getByRole("button", { name: "Toggle review" }).first()
  await expect(reviewToggle).toBeVisible()
  if (await expanded(reviewToggle)) await reviewToggle.click()
  await expect(reviewToggle).toHaveAttribute("aria-expanded", "false")
  await expect(reviewPanel).toHaveAttribute("aria-hidden", "true")

  await page.keyboard.press(`${modKey}+Shift+R`)
  await expect(reviewToggle).toHaveAttribute("aria-expanded", "true")
  await expect(reviewPanel).toHaveAttribute("aria-hidden", "false")

  await page.keyboard.press(`${modKey}+Shift+R`)
  await expect(reviewToggle).toHaveAttribute("aria-expanded", "false")
  await expect(reviewPanel).toHaveAttribute("aria-hidden", "true")
})

test("closing review expands the session content", async ({ page, sdk, gotoSession }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  await withSession(sdk, `e2e review width ${Date.now()}`, async (session) => {
    await sdk.session.promptAsync({
      sessionID: session.id,
      noReply: true,
      parts: [{ type: "text", text: "e2e review width" }],
    })
    await gotoSession(session.id)

    const tree = page.getByRole("button", { name: "Toggle file tree" }).first()
    if (await expanded(tree)) await tree.click()
    await expect(tree).toHaveAttribute("aria-expanded", "false")

    const review = page.getByRole("button", { name: "Toggle review" }).first()
    if (!(await expanded(review))) await review.click()
    await expect(review).toHaveAttribute("aria-expanded", "true")

    const width = (selector: string) =>
      page.locator(selector).evaluate((element) => element.getBoundingClientRect().width)
    const dock = sessionComposerDockSelector
    const composer = '[data-slot="session-composer-content"]'
    const parts = [
      composer,
      '[role="log"]',
      `${sessionTimelineHeaderSelector} [data-slot="session-title-content"]`,
    ]

    await expect.poll(() => width(dock)).toBeLessThan(700)
    const narrow = await width(composer)

    await review.click()
    await expect(review).toHaveAttribute("aria-expanded", "false")
    await expect.poll(() => width(composer)).toBeGreaterThan(narrow * 1.2)

    for (const part of parts) {
      await expect.poll(() => width(part)).toBeGreaterThan(990)
      expect(await width(part)).toBeLessThanOrEqual(1000)
    }
  })
})
