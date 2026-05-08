import path from "path"
import { describe, expect, spyOn, test } from "bun:test"
import { fileURLToPath } from "url"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"
import { Workflow } from "../../src/workflow"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("session.prompt missing file", () => {
  test("does not fail the prompt when a file part is missing", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "does-not-exist.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "please review @does-not-exist.ts" },
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "does-not-exist.ts",
            },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const hasFailure = msg.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
        )
        expect(hasFailure).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("keeps stored part order stable when file resolution is async", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "still-missing.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "still-missing.ts",
            },
            { type: "text", text: "after-file" },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const stored = await MessageV2.get({
          sessionID: session.id,
          messageID: msg.info.id,
        })
        const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

        expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
        expect(text[1]?.includes("Read tool failed to read")).toBe(true)
        expect(text[2]).toBe("after-file")

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt special characters", () => {
  test("handles filenames with # character", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "file#name.txt"), "special content\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const template = "Read @file#name.txt"
        const parts = await SessionPrompt.resolvePromptParts(template)
        const fileParts = parts.filter((part) => part.type === "file")

        expect(fileParts.length).toBe(1)
        expect(fileParts[0].filename).toBe("file#name.txt")
        expect(fileParts[0].url).toContain("%23")

        const decodedPath = fileURLToPath(fileParts[0].url)
        expect(decodedPath).toBe(path.join(tmp.path, "file#name.txt"))

        const message = await SessionPrompt.prompt({
          sessionID: session.id,
          parts,
          noReply: true,
        })
        const stored = await MessageV2.get({ sessionID: session.id, messageID: message.info.id })
        const textParts = stored.parts.filter((part) => part.type === "text")
        const hasContent = textParts.some((part) => part.text.includes("special content"))
        expect(hasContent).toBe(true)

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt agent variant", () => {
  test("applies agent variant only when using agent model", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          agent: {
            build: {
              model: "openai/gpt-5.2",
              variant: "xhigh",
            },
          },
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})

          const other = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: "opencode", modelID: "kimi-k2.5-free" },
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          })
          if (other.info.role !== "user") throw new Error("expected user message")
          expect(other.info.variant).toBeUndefined()

          const match = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "hello again" }],
          })
          if (match.info.role !== "user") throw new Error("expected user message")
          expect(match.info.model).toEqual({ providerID: "openai", modelID: "gpt-5.2" })
          expect(match.info.variant).toBe("xhigh")

          const override = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            variant: "high",
            parts: [{ type: "text", text: "hello third" }],
          })
          if (override.info.role !== "user") throw new Error("expected user message")
          expect(override.info.variant).toBe("high")

          await Session.remove(session.id)
        },
      })
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })
})

describe("session.prompt workflow wait_interaction", () => {
  test("breaks the current loop immediately after wait_interaction", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const meta = Workflow.start({
          sessionID: session.id,
          templateID: "simple_test_v1",
          flowID: "child_parent_interaction",
        })
        Workflow.next({ sessionID: session.id, instanceID: meta.instance.id })

        const args = {
          action: "wait_interaction" as const,
          instance_id: meta.instance.id,
          reason: "need parent input",
          message: "Please answer before I continue.",
        }
        let turns = 0
        const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
          if (input.small) {
            return {
              text: Promise.resolve("Workflow Wait"),
              fullStream: (async function* () {})(),
            } as unknown as Awaited<ReturnType<typeof LLM.stream>>
          }
          if (!input.tools.workflow) {
            return {
              fullStream: (async function* () {
                yield {
                  type: "finish-step",
                  finishReason: "stop",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                }
                yield { type: "finish" }
              })(),
            } as unknown as Awaited<ReturnType<typeof LLM.stream>>
          }
          turns++
          const output =
            turns === 1
              ? (Workflow.wait({
                  sessionID: session.id,
                  instanceID: meta.instance.id,
                  userMessageID: input.user.id,
                  reason: args.reason,
                  message: args.message,
                }),
                { output: "workflow is waiting", title: "", metadata: {} })
              : { output: "unexpected second model step", title: "", metadata: {} }
          return {
            fullStream: (async function* () {
              yield { type: "start" }
              yield { type: "tool-input-start", id: "call_wait", toolName: "workflow" }
              yield { type: "tool-call", toolCallId: "call_wait", toolName: "workflow", input: args }
              yield { type: "tool-result", toolCallId: "call_wait", toolName: "workflow", input: args, output }
              yield {
                type: "finish-step",
                finishReason: "tool-calls",
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              }
              yield { type: "finish" }
            })(),
          } as unknown as Awaited<ReturnType<typeof LLM.stream>>
        })

        try {
          await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: "opencode", modelID: "kimi-k2.5-free" },
            parts: [{ type: "text", text: "wait for input" }],
          })

          expect(turns).toBe(1)
          expect(Workflow.latest(session.id)?.status).toBe("waiting_interaction")
          const messages = await Session.messages({ sessionID: session.id })
          const text = messages.flatMap((msg) => msg.parts.filter((part) => part.type === "text").map((part) => part.text))
          expect(text.some((part) => part.includes("Workflow forced another model step"))).toBe(false)
        } finally {
          stream.mockRestore()
          await Session.remove(session.id)
        }
      },
    })
  })
})
