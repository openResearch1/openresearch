import type {
  ResearchExperimentBySessionResponse,
  ResearchProjectGetResponse,
  ResearchSessionAtomGetResponse,
} from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, on, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"

import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"

type Project = ResearchProjectGetResponse
type Atom = NonNullable<ResearchSessionAtomGetResponse["atom"]>
type Experiment = NonNullable<ResearchExperimentBySessionResponse>
export type SessionResearchSnapshot = {
  project: Project | null
  atom: Atom | null
  experiment: Experiment | null
}

const snapshots = new Map<string, SessionResearchSnapshot>()
const cacheKey = (directory: string, id: string, projectID?: string) =>
  `${directory}\n${id}\n${projectID ?? ""}`

export function primeSessionResearch(input: {
  directory: string
  sessionID: string
  projectID?: string
  value: SessionResearchSnapshot
}) {
  const key = cacheKey(input.directory, input.sessionID, input.projectID)
  snapshots.delete(key)
  snapshots.set(key, input.value)
  while (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value!)
}

export function getSessionResearch(directory: string, sessionID: string, projectID?: string) {
  return snapshots.get(cacheKey(directory, sessionID, projectID))
}

export function useSessionResearch(sessionID: Accessor<string | undefined>) {
  const sdk = useSDK()
  const sync = useSync()
  const projects = new Map<string, Promise<Project | null>>()
  const [state, setState] = createStore({
    key: "",
    ready: false,
    error: undefined as unknown,
    project: null as Project | null,
    atom: null as Atom | null,
    experiment: null as Experiment | null,
  })
  let version = 0
  let atomVersion = 0
  let experimentVersion = 0

  const project = (directory: string, id: string) => {
    const projectKey = `${directory}\n${id}`
    const cached = projects.get(projectKey)
    if (cached) return cached
    const request = sdk.client.research.project
      .get({ projectId: id })
      .then((result) => {
        if (result.error && result.response.status !== 404) throw result.error
        return result.data ?? null
      })
      .catch((error) => {
        projects.delete(projectKey)
        throw error
      })
    projects.set(projectKey, request)
    return request
  }

  const hydrate = async (
    directory: string,
    id: string | undefined,
    projectID: string | undefined,
    force = false,
  ) => {
    const current = ++version
    atomVersion++
    experimentVersion++
    if (!id) {
      setState({ key: "", ready: true, error: undefined, project: null, atom: null, experiment: null })
      return
    }

    const stateKey = cacheKey(directory, id, projectID)
    const cached = force ? undefined : getSessionResearch(directory, id, projectID)
    if (cached) {
      setState({ key: stateKey, ready: true, error: undefined, ...cached })
      return
    }

    setState({ key: stateKey, ready: false, error: undefined, project: null, atom: null, experiment: null })
    const result = await Promise.all([
      projectID ? project(directory, projectID) : Promise.resolve(null),
      sdk.client.research.session.atom.get({ sessionId: id }).then((value) => {
        if (value.error) throw value.error
        return value.data?.atom ?? null
      }),
      sdk.client.research.experiment.bySession({ sessionId: id }).then((value) => {
        if (value.error) throw value.error
        return value.data ?? null
      }),
    ]).catch((error) => {
      if (current === version && sdk.directory === directory && sessionID() === id) {
        setState({ key: stateKey, ready: true, error })
      }
      return undefined
    })
    if (!result) return
    if (current !== version || sdk.directory !== directory || sessionID() !== id) return

    const [research, atom, experiment] = result
    const value = { project: research, atom, experiment }
    primeSessionResearch({ directory, sessionID: id, projectID, value })
    setState({ key: stateKey, ready: true, error: undefined, ...value })
  }

  createEffect(
    on(
      [() => sdk.directory, sessionID, () => sync.project?.id] as const,
      ([directory, id, projectID]) => void hydrate(directory, id, projectID),
    ),
  )
  onCleanup(() => {
    version++
    atomVersion++
    experimentVersion++
  })
  const current = () => {
    const id = sessionID()
    return state.key === (id ? cacheKey(sdk.directory, id, sync.project?.id) : "")
  }
  const snapshot = () => {
    const id = sessionID()
    if (!id) return
    return getSessionResearch(sdk.directory, id, sync.project?.id)
  }
  const ready = () => {
    if (current()) return state.ready
    if (!sessionID()) return true
    return !!snapshot()
  }
  const projectValue = () => (current() ? state.project : (snapshot()?.project ?? null))
  const atomValue = () => (current() ? state.atom : (snapshot()?.atom ?? null))
  const experimentValue = () => (current() ? state.experiment : (snapshot()?.experiment ?? null))

  const refreshExperiment = async () => {
    const id = sessionID()
    if (!id) return
    const directory = sdk.directory
    const current = ++experimentVersion
    const experiment = await sdk.client.research.experiment
      .bySession({ sessionId: id })
      .then((result) => {
        if (result.error) throw result.error
        return result.data ?? null
      })
      .catch(() => undefined)
    if (experiment === undefined) return
    if (current !== experimentVersion || sdk.directory !== directory || sessionID() !== id) return
    const value = { project: state.project, atom: state.atom, experiment }
    primeSessionResearch({ directory, sessionID: id, projectID: sync.project?.id, value })
    setState({ experiment, ready: true })
  }

  const refreshAtom = async () => {
    const id = sessionID()
    if (!id) return
    const directory = sdk.directory
    const current = ++atomVersion
    const atom = await sdk.client.research.session.atom
      .get({ sessionId: id })
      .then((result) => {
        if (result.error) throw result.error
        return result.data?.atom ?? null
      })
      .catch(() => undefined)
    if (atom === undefined) return
    if (current !== atomVersion || sdk.directory !== directory || sessionID() !== id) return
    const value = { project: state.project, atom, experiment: state.experiment }
    primeSessionResearch({ directory, sessionID: id, projectID: sync.project?.id, value })
    setState({ atom, ready: true })
  }

  return {
    ready,
    project: projectValue,
    atom: atomValue,
    experiment: experimentValue,
    kind: createMemo(() => {
      if (!ready()) return
      if (experimentValue()) return "experiment" as const
      if (atomValue()) return "atom" as const
      if (projectValue()) return "main" as const
    }),
    error: () => (current() ? state.error : undefined),
    refresh: () => hydrate(sdk.directory, sessionID(), sync.project?.id, true),
    refreshAtom,
    refreshExperiment,
  }
}

export type SessionResearch = ReturnType<typeof useSessionResearch>
