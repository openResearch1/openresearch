import { batch, createEffect, createMemo, Show, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate, useParams } from "@solidjs/router"

import type { CollabAgent } from "@opencode-ai/sdk/v2"
import { DataProvider, type AgentInfo, type AgentTarget } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"

import { SDKProvider, useSDK } from "@/context/sdk"
import { SyncProvider, useSync } from "@/context/sync"
import { LocalProvider } from "@/context/local"
import { useGlobalSDK } from "@/context/global-sdk"
import { decode64 } from "@/utils/base64"
import { useLanguage } from "@/context/language"

export function DirectoryDataProvider(props: ParentProps<{ directory: string; remote?: boolean }>) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const cache = new Map<string, AgentInfo>()
  const inflight = new Map<string, Promise<AgentInfo | undefined>>()
  let catalog: Promise<AgentInfo[]> | undefined
  const slug = createMemo(() => base64Encode(props.directory))
  const path = (sessionID: string) =>
    props.remote ? `/remote/session/${slug()}/${sessionID}` : `/${slug()}/session/${sessionID}`
  const kind = (agent: CollabAgent) =>
    agent.subagent_type === "research" && typeof agent.spec.metadata?.atomId === "string" ? "atom" : agent.subagent_type
  const keys = (target: AgentTarget) =>
    [
      target.agentId ? `agent:${target.agentId}` : undefined,
      target.sessionId ? `session:${target.sessionId}` : undefined,
      target.atomId ? `atom:${target.atomId}` : undefined,
      target.experimentId ? `experiment:${target.experimentId}` : undefined,
    ].filter((key): key is string => !!key)
  const remember = (info: AgentInfo) => {
    keys(info).forEach((key) => cache.set(key, info))
    return info
  }
  const describe = (agent: CollabAgent) =>
    remember({
      type: kind(agent),
      name: agent.name,
      agentId: agent.id,
      sessionId: agent.session_id,
      atomId: typeof agent.spec.metadata?.atomId === "string" ? agent.spec.metadata.atomId : undefined,
      experimentId: typeof agent.spec.metadata?.expId === "string" ? agent.spec.metadata.expId : undefined,
    })
  const list = () => {
    if (catalog) return catalog
    catalog = (async () => {
      const project = await sdk.client.project.current().then((result) => result.data)
      if (!project) return []
      const research = await sdk.client.research.project.get({ projectId: project.id }).then((result) => result.data)
      if (!research) return []
      const tree = await sdk.client.research.project
        .sessionTree({ researchProjectId: research.research_project_id })
        .then((result) => result.data)
      return (tree?.atoms ?? []).flatMap((atom) => [
        remember({ type: "atom", name: atom.atom_name, atomId: atom.atom_id, sessionId: atom.session_id ?? undefined }),
        ...atom.experiments.map((experiment) =>
          remember({
            type: "experiment",
            name: experiment.exp_name,
            experimentId: experiment.exp_id,
            sessionId: experiment.exp_session_id ?? undefined,
          }),
        ),
      ])
    })().catch(() => {
      catalog = undefined
      return []
    })
    return catalog
  }
  const resolve = (target: AgentTarget) => {
    const aliases = keys(target)
    const cached = aliases.map((key) => cache.get(key)).find((value): value is AgentInfo => !!value)
    if (cached) return cached
    const active = aliases
      .map((key) => inflight.get(key))
      .find((value): value is Promise<AgentInfo | undefined> => !!value)
    if (active) return active

    const request = (async () => {
      const direct = target.agentId
        ? await sdk.client.collab.agent
            .get({ agentId: target.agentId })
            .then((result) => result.data)
            .catch(() => undefined)
        : undefined
      const bound =
        direct || !target.sessionId
          ? undefined
          : await sdk.client.collab.session.agent
              .get({ sessionId: target.sessionId })
              .then((result) => result.data?.agent ?? undefined)
              .catch(() => undefined)
      const agent = direct ?? bound
      if (agent) return describe(agent)
      if (target.sessionId) {
        const atom = await sdk.client.research.session.atom
          .get({ sessionId: target.sessionId })
          .then((result) => result.data?.atom ?? undefined)
          .catch(() => undefined)
        if (atom) {
          return remember({
            type: "atom",
            name: atom.atom_name,
            atomId: atom.atom_id,
            sessionId: atom.session_id ?? target.sessionId,
          })
        }
        const experiment = await sdk.client.research.experiment
          .bySession({ sessionId: target.sessionId })
          .then((result) => result.data)
          .catch(() => undefined)
        if (experiment?.kind === "experiment") {
          return remember({
            type: "experiment",
            name: experiment.exp_name,
            experimentId: experiment.exp_id,
            sessionId: experiment.exp_session_id ?? target.sessionId,
          })
        }
      }
      if (!target.atomId && !target.experimentId) return
      await list()
      return keys(target)
        .map((key) => cache.get(key))
        .find((value): value is AgentInfo => !!value)
    })().finally(() => aliases.forEach((key) => inflight.delete(key)))

    aliases.forEach((key) => inflight.set(key, request))
    return request
  }

  return (
    <DataProvider
      data={sync.data}
      directory={props.directory}
      onNavigateToSession={(sessionID: string) => {
        navigate(path(sessionID))
      }}
      onSessionHref={path}
      onResolveAgentInfo={resolve}
    >
      <LocalProvider>{props.children}</LocalProvider>
    </DataProvider>
  )
}

export default function Layout(props: ParentProps) {
  const params = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const directory = createMemo(() => decode64(params.dir) ?? "")
  const [state, setState] = createStore({ invalid: "", resolved: "" })

  createEffect(() => {
    if (!params.dir) return
    const raw = directory()
    if (!raw) {
      if (state.invalid === params.dir) return
      setState("invalid", params.dir)
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: language.t("directory.error.invalidUrl"),
      })
      navigate("/", { replace: true })
      return
    }

    const current = params.dir
    globalSDK
      .createClient({
        directory: raw,
        throwOnError: true,
      })
      .path.get()
      .then((x) => {
        if (params.dir !== current) return
        const next = x.data?.directory ?? raw
        batch(() => {
          setState("invalid", "")
          setState("resolved", next)
        })
        if (next === raw) return
        const path = location.pathname.slice(current.length + 1)
        navigate(`/${base64Encode(next)}${path}${location.search}${location.hash}`, { replace: true })
      })
      .catch(() => {
        if (params.dir !== current) return
        batch(() => {
          setState("invalid", "")
          setState("resolved", raw)
        })
      })
  })

  return (
    <Show when={state.resolved}>
      {(resolved) => (
        <SDKProvider directory={resolved}>
          <SyncProvider>
            <DirectoryDataProvider directory={resolved()}>{props.children}</DirectoryDataProvider>
          </SyncProvider>
        </SDKProvider>
      )}
    </Show>
  )
}
