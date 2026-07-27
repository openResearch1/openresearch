import { expect, test } from "bun:test"

import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionOwnership } from "../../src/session/ownership"
import { tmpdir } from "../fixture/fixture"

test("session ownership claims are exclusive and token-safe", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "ownership" })
      const first = SessionOwnership.claim(session.id, "human")
      expect(first).toBeFunction()
      expect(SessionOwnership.claim(session.id, "human")).toBeUndefined()
      expect(SessionOwnership.claim(session.id, "collab")).toBeUndefined()

      first!()
      const second = SessionOwnership.claim(session.id, "collab")
      expect(second).toBeFunction()
      first!()
      expect(SessionOwnership.current(session.id)).toBe("collab")
      second!()
      expect(SessionOwnership.current(session.id)).toBeUndefined()

      const third = SessionOwnership.claim(session.id, "human")
      expect(third).toBeFunction()
      SessionOwnership.revoke(session.id)
      if (!third!.signal.aborted) {
        await Promise.race([
          new Promise<void>((resolve) => third!.signal.addEventListener("abort", () => resolve(), { once: true })),
          Bun.sleep(2000).then(() => {
            throw new Error("revoked ownership did not abort")
          }),
        ])
      }
      expect(third!.signal.aborted).toBe(true)
      third!()
    },
  })
})
