import { describe, expect, test } from "bun:test"
import z from "zod"

import { ResearchPathTool } from "../../src/tool/research-path"

describe("tool.research-path schema", () => {
  test("emits a function-compatible object root", async () => {
    const tool = await ResearchPathTool.init()
    const schema = z.toJSONSchema(tool.parameters)

    expect(schema.type).toBe("object")
    expect(schema.anyOf).toBeUndefined()
    expect(schema.properties?.action).toMatchObject({
      type: "string",
      enum: ["read", "create", "update", "transition"],
    })
  })

  test("keeps action-specific validation", async () => {
    const tool = await ResearchPathTool.init()
    const parse = (input: unknown) => tool.parameters.safeParse(input)

    expect(parse({ action: "read" }).success).toBe(true)
    expect(parse({ action: "create", title: "Direction", brief: "Validate the idea" }).success).toBe(true)
    expect(parse({ action: "update", researchPathId: "path-1" }).success).toBe(true)
    expect(parse({ action: "transition", researchPathId: "path-1", status: "completed" }).success).toBe(true)

    expect(parse({ action: "create", brief: "Missing title" }).success).toBe(false)
    expect(parse({ action: "update" }).success).toBe(false)
    expect(parse({ action: "transition", researchPathId: "path-1" }).success).toBe(false)
    expect(parse({ action: "create", title: "Direction", brief: "Validate", summary: null }).success).toBe(false)
  })
})
