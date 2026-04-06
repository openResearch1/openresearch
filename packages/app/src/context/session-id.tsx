import { createContext, useContext, type JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"

interface SessionIDContextValue {
  id?: string
  dir: string
}

const SessionIDContext = createContext<SessionIDContextValue>()

export function SessionIDProvider(props: { sessionID: string; directory: string; children: JSX.Element }) {
  const value = {
    get id() {
      return props.sessionID
    },
    get dir() {
      return base64Encode(props.directory)
    },
  }
  return <SessionIDContext.Provider value={value}>{props.children}</SessionIDContext.Provider>
}

export function useSessionID(): SessionIDContextValue {
  const ctx = useContext(SessionIDContext)
  if (ctx) return ctx
  const params = useParams()
  return params as unknown as SessionIDContextValue
}
