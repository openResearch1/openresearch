import { describe, expect, test } from "bun:test"

import { defaultRemoteCodePath, resolveRemoteCodePath } from "../../src/research/remote-code-sync"

const server = {
  mode: "ssh_config" as const,
  host_alias: "gpu-box",
  resource_root: "/data/opencode/",
}

describe("research.remote-code-sync", () => {
  test("builds the default path under resource_root", () => {
    expect(defaultRemoteCodePath(server, "exp-1")).toBe("/data/opencode/experiments/exp-1")
    expect(defaultRemoteCodePath({ ...server, resource_root: "/" }, "exp-1")).toBe("/experiments/exp-1")
  })

  test("resolves legacy relative paths under resource_root", () => {
    expect(resolveRemoteCodePath(server, "exp-1", "experiments/exp-1")).toBe(
      "/data/opencode/experiments/exp-1",
    )
  })

  test("preserves explicit absolute and home-relative paths", () => {
    expect(resolveRemoteCodePath(server, "exp-1", "/mnt/code/exp-1")).toBe("/mnt/code/exp-1")
    expect(resolveRemoteCodePath(server, "exp-1", "~/code/exp-1")).toBe("~/code/exp-1")
  })

  test("requires an absolute resource_root for generated paths", () => {
    expect(() => defaultRemoteCodePath({ ...server, resource_root: undefined }, "exp-1")).toThrow(
      "remote server resource_root is required for code sync",
    )
    expect(() => defaultRemoteCodePath({ ...server, resource_root: "data/opencode" }, "exp-1")).toThrow(
      "remote server resource_root must be an absolute path",
    )
  })
})
