import { $ } from "bun"
import { expect, test } from "bun:test"

import { CodeBranch } from "../../src/research/code-branch"
import { tmpdir } from "../fixture/fixture"

test("lists local branch heads with current and default branches", async () => {
  await using tmp = await tmpdir({ git: true })
  await $`git branch -m main`.cwd(tmp.path).quiet()
  await Bun.write(`${tmp.path}/baseline.txt`, "baseline\n")
  await $`git add baseline.txt`.cwd(tmp.path).quiet()
  await $`git commit -m ${"baseline implementation"}`.cwd(tmp.path).quiet()
  await $`git switch -c feature`.cwd(tmp.path).quiet()
  await Bun.write(`${tmp.path}/feature.txt`, "feature\n")
  await $`git add feature.txt`.cwd(tmp.path).quiet()
  await $`git commit -m ${"feature experiment"}`.cwd(tmp.path).quiet()

  const info = await CodeBranch.list(tmp.path)
  const main = info.branches.find((branch) => branch.branch === "main")!
  const feature = info.branches.find((branch) => branch.branch === "feature")!

  expect(info.codeRoot).toBe(tmp.path)
  expect(info.currentBranch).toBe("feature")
  expect(info.defaultBranch).toBe("main")
  expect(main.default).toBe(true)
  expect(main.subject).toBe("baseline implementation")
  expect(feature.current).toBe(true)
  expect(feature.subject).toBe("feature experiment")
  expect(feature.headSha).toMatch(/^[0-9a-f]{40}$/)
  expect(feature.ref).toBe("refs/heads/feature")
})
