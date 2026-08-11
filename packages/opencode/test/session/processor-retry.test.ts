import { expect, spyOn, test } from "bun:test"
import { APICallError } from "ai"

import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { tmpdir } from "../fixture/fixture"

test("session processor stops after the configured provider retry budget", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "bounded retries" })
      const assistant = (await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: session.id,
        role: "assistant",
        parentID: Identifier.ascending("message"),
        mode: "general",
        agent: "general",
        modelID: "model",
        providerID: "provider",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })) as MessageV2.Assistant
      const stream = spyOn(LLM, "stream").mockRejectedValue(
        new APICallError({
          message: "temporarily unavailable",
          url: "https://provider.invalid",
          requestBodyValues: {},
          statusCode: 503,
          isRetryable: true,
        }),
      )
      const processor = SessionProcessor.create({
        assistantMessage: assistant,
        sessionID: session.id,
        model: { providerID: "provider" } as never,
        abort: new AbortController().signal,
        retry: { count: 3, deadline: Date.now() + 60_000, delay: 0 },
      })
      try {
        expect(await processor.process({} as never)).toBe("stop")
        expect(stream).toHaveBeenCalledTimes(4)
        expect(MessageV2.APIError.isInstance(processor.message.error)).toBe(true)
      } finally {
        stream.mockRestore()
      }
    },
  })
})
