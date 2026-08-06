import { For, Match, Show, Switch, createEffect, createMemo, createResource, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"

import type { CollabAgent } from "@opencode-ai/sdk/v2/client"
import type { ResearchPathsListResponse, ResearchResultsListResponse } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { Markdown } from "@opencode-ai/ui/markdown"
import { Select } from "@opencode-ai/ui/select"

import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import type { CollabActivity } from "@/pages/session/composer/session-collab-activity"
import { clock, historical, tree } from "@/pages/session/composer/session-collab-visibility"

const colors: Record<string, string> = {
  pending: "bg-icon-weak",
  running: "bg-icon-success-base",
  blocked_on_children: "bg-icon-warning-base",
  waiting_interaction: "bg-icon-warning-base",
  completed: "bg-icon-info-base",
  failed: "bg-icon-critical-base",
  canceled: "bg-icon-weak",
}

function Empty(props: { title: string; description: string }) {
  return (
    <div class="h-full flex items-center justify-center px-8 pb-24 text-center">
      <div class="max-w-72 flex flex-col gap-1.5">
        <div class="text-14-medium text-text-strong">{props.title}</div>
        <div class="text-12-regular text-text-weak">{props.description}</div>
      </div>
    </div>
  )
}

type Path = ResearchPathsListResponse[number]
type Member = Path["atoms"][number]
type Result = ResearchResultsListResponse[number]
type ResultAtom = Result["atoms"][number]
type PathFilter = Path["status"] | "all"

const pathFilters: PathFilter[] = ["active", "completed", "cancelled", "all"]
const pathFilterLabels: Record<PathFilter, string> = {
  active: "Active",
  completed: "Completed",
  cancelled: "Cancelled",
  all: "All",
}

const pathColors: Record<Path["status"], string> = {
  active: "bg-icon-success-base",
  completed: "bg-icon-info-base",
  cancelled: "bg-icon-weak",
}

const evidenceColors: Record<Member["atom_evidence_status"], string> = {
  pending: "bg-icon-weak",
  in_progress: "bg-icon-warning-base",
  proven: "bg-icon-success-base",
  disproven: "bg-icon-critical-base",
}

const evidenceLabels: Record<Member["atom_evidence_status"], string> = {
  pending: "Pending",
  in_progress: "In progress",
  proven: "Proven",
  disproven: "Disproven",
}

const typeLabels: Record<Member["atom_type"], string> = {
  fact: "Fact",
  method: "Method",
  theorem: "Theorem",
  verification: "Verification",
}

const relationLabels: Record<Path["relations"][number]["relation_type"], string> = {
  motivates: "motivates",
  grounds: "grounds",
  formalized_by: "is formalized by",
  derives: "derives",
  analyzed_by: "is analyzed by",
  evaluated_by: "is evaluated by",
  contradicts: "contradicts",
  other: "relates to",
}

const date = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

function counts(path: Path) {
  return path.atoms.reduce(
    (result, atom) => ({ ...result, [atom.atom_evidence_status]: result[atom.atom_evidence_status] + 1 }),
    { pending: 0, in_progress: 0, proven: 0, disproven: 0 },
  )
}

function PathCard(props: { path: Path; selected: boolean; onSelect: () => void }) {
  const count = createMemo(() => counts(props.path))
  return (
    <button
      type="button"
      class="w-full min-w-0 rounded-md border px-3 py-3 text-left transition-colors"
      classList={{
        "border-border-strong bg-background-stronger": props.selected,
        "border-border-weak-base bg-background-base hover:bg-surface-raised-base-hover": !props.selected,
      }}
      aria-pressed={props.selected}
      onClick={props.onSelect}
    >
      <span class="flex items-center gap-2 text-11-regular text-text-weak capitalize">
        <span class={`size-1.5 rounded-full ${pathColors[props.path.status]}`} />
        <span>{props.path.status}</span>
        <span class="ml-auto">{date.format(props.path.time_updated)}</span>
      </span>
      <span class="mt-1.5 block text-13-semibold text-text-strong truncate">{props.path.title}</span>
      <span class="mt-0.5 block text-11-regular text-text-weak line-clamp-2">{props.path.brief}</span>
      <span class="mt-2 flex flex-wrap gap-x-2.5 gap-y-1 text-10-regular text-text-weak">
        <span>{props.path.atoms.length} atoms</span>
        <Show when={count().proven > 0}>
          <span>{count().proven} proven</span>
        </Show>
        <Show when={count().disproven > 0}>
          <span>{count().disproven} disproven</span>
        </Show>
        <Show when={count().in_progress > 0}>
          <span>{count().in_progress} in progress</span>
        </Show>
      </span>
    </button>
  )
}

function PathAtomCard(props: { atom: Member; onOpen: () => void }) {
  return (
    <button
      type="button"
      class="min-w-0 rounded-md border border-border-weak-base bg-background-base px-3 py-2.5 text-left hover:bg-surface-raised-base-hover transition-colors"
      onClick={props.onOpen}
    >
      <span class="flex items-start gap-2">
        <span class={`mt-1.5 size-1.5 shrink-0 rounded-full ${evidenceColors[props.atom.atom_evidence_status]}`} />
        <span class="min-w-0 flex-1">
          <span class="block text-12-medium text-text-strong truncate">{props.atom.atom_name}</span>
          <span class="mt-0.5 flex flex-wrap gap-x-2 text-10-regular text-text-weak">
            <span>{typeLabels[props.atom.atom_type]}</span>
            <span>{evidenceLabels[props.atom.atom_evidence_status]}</span>
            <Show when={props.atom.role === "seed"}>
              <span class="text-text-base">Seed</span>
            </Show>
            <Show when={props.atom.locked}>
              <span>Locked</span>
            </Show>
          </span>
        </span>
      </span>
    </button>
  )
}

function PathDetail(props: {
  path: Path
  onOpenSession: (sessionID: string) => void
  onOpenAtom: (atom: Member) => void
}) {
  const sync = useSync()
  const members = createMemo(() => new Map(props.path.atoms.map((atom) => [atom.atom_id, atom])))
  const names = createMemo(() => new Map(props.path.atoms.map((atom) => [atom.atom_id, atom.atom_name])))
  const creator = createMemo(() => sync.session.get(props.path.creator_session_id))
  const seeds = createMemo(() => props.path.atoms.filter((atom) => atom.role === "seed").length)

  return (
    <div class="h-full overflow-y-auto">
      <div class="max-w-3xl mx-auto px-5 py-5">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 text-11-regular text-text-weak capitalize">
              <span class={`size-2 rounded-full ${pathColors[props.path.status]}`} />
              <span>{props.path.status}</span>
              <span>Updated {date.format(props.path.time_updated)}</span>
            </div>
            <h2 class="mt-1 text-16-semibold text-text-strong break-words">{props.path.title}</h2>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-md border border-border-weak-base px-2.5 py-1.5 text-11-medium text-text-base hover:bg-surface-raised-base-hover"
            onClick={() => props.onOpenSession(props.path.creator_session_id)}
          >
            Open session
          </button>
        </div>

        <div class="mt-5 grid gap-4">
          <section>
            <div class="text-10-medium uppercase tracking-wide text-text-weak">Brief</div>
            <p class="mt-1.5 whitespace-pre-wrap text-13-regular text-text-base">{props.path.brief}</p>
          </section>
          <Show when={props.path.summary}>
            <section class="rounded-md border border-border-weak-base bg-background-stronger px-3.5 py-3">
              <div class="text-10-medium uppercase tracking-wide text-text-weak">Summary</div>
              <p class="mt-1.5 whitespace-pre-wrap text-12-regular text-text-base">{props.path.summary}</p>
            </section>
          </Show>
          <div class="flex flex-wrap gap-x-4 gap-y-1 text-11-regular text-text-weak">
            <span>{props.path.atoms.length} atoms</span>
            <span>{seeds()} seeds</span>
            <span>{props.path.relations.length} relations</span>
            <span title={props.path.creator_session_id}>
              Created by {creator()?.title ?? props.path.creator_session_id.slice(0, 12)}
            </span>
          </div>
        </div>

        <section class="mt-7">
          <div class="mb-2 flex items-center justify-between">
            <h3 class="text-12-semibold text-text-strong">Attention subgraph</h3>
            <span class="text-10-regular text-text-weak">Click an atom to open it</span>
          </div>
          <Show
            when={props.path.stages.length > 0}
            fallback={
              <div class="rounded-md border border-dashed border-border-weak-base px-4 py-6 text-center text-11-regular text-text-weak">
                No atoms added yet
              </div>
            }
          >
            <div class="flex flex-col">
              <For each={props.path.stages}>
                {(stage, index) => (
                  <div class="relative flex gap-3 pb-5 last:pb-0">
                    <Show when={index() < props.path.stages.length - 1}>
                      <div class="absolute left-3 top-7 bottom-0 border-l border-border-weak-base" />
                    </Show>
                    <div class="relative z-10 size-6 shrink-0 rounded-full border border-border-base bg-background-base flex items-center justify-center text-10-medium text-text-base">
                      {stage.index}
                    </div>
                    <div class="min-w-0 flex-1 pt-0.5">
                      <div class="mb-2 flex items-baseline gap-2">
                        <span class="text-11-medium text-text-strong">Step {stage.index}</span>
                        <Show when={stage.groups.length > 1}>
                          <span class="text-10-regular text-text-weak">{stage.groups.length} parallel branches</span>
                        </Show>
                      </div>
                      <div class="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-2">
                        <For each={stage.groups}>
                          {(group) => {
                            const atoms = createMemo(() =>
                              group.atom_ids.flatMap((id) => {
                                const atom = members().get(id)
                                return atom ? [atom] : []
                              }),
                            )
                            return (
                              <Show
                                when={group.cyclic}
                                fallback={
                                  <For each={atoms()}>
                                    {(atom) => <PathAtomCard atom={atom} onOpen={() => props.onOpenAtom(atom)} />}
                                  </For>
                                }
                              >
                                <div class="col-span-full rounded-md border border-border-base bg-background-stronger p-2.5">
                                  <div class="mb-2 flex items-baseline justify-between gap-2 px-0.5">
                                    <span class="text-10-medium uppercase tracking-wide text-text-base">
                                      Iterative loop
                                    </span>
                                    <span class="text-10-regular text-text-weak">No fixed internal order</span>
                                  </div>
                                  <div class="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2">
                                    <For each={atoms()}>
                                      {(atom) => <PathAtomCard atom={atom} onOpen={() => props.onOpenAtom(atom)} />}
                                    </For>
                                  </div>
                                </div>
                              </Show>
                            )
                          }}
                        </For>
                      </div>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </section>

        <Show when={props.path.relations.length > 0}>
          <section class="mt-7 pb-3">
            <h3 class="mb-2 text-12-semibold text-text-strong">Relations in this path</h3>
            <div class="divide-y divide-border-weak-base rounded-md border border-border-weak-base">
              <For each={props.path.relations}>
                {(relation) => (
                  <div class="px-3 py-2 text-11-regular text-text-weak">
                    <span class="text-text-base">
                      {names().get(relation.atom_id_source) ?? relation.atom_id_source}
                    </span>
                    <span class="mx-1.5">{relationLabels[relation.relation_type]}</span>
                    <span class="text-text-base">
                      {names().get(relation.atom_id_target) ?? relation.atom_id_target}
                    </span>
                    <Show when={relation.note}>
                      <span class="ml-1.5">{relation.note}</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </section>
        </Show>
      </div>
    </div>
  )
}

export function ControllerPathsTab(props: {
  researchProjectId: string
  currentSessionId?: string
  title: string
  description: string
  onOpenSession: (sessionID: string) => void
}) {
  const sdk = useSDK()
  const [state, setState] = createStore({
    selected: "",
    compact: false,
    filter: "active" as PathFilter,
  })
  const [paths, { refetch }] = createResource(
    () => props.researchProjectId,
    async (researchProjectId) => {
      const result = await sdk.client.research.paths.list({ researchProjectId })
      return result.data ?? []
    },
  )
  const visible = createMemo(() =>
    state.filter === "all" ? (paths() ?? []) : (paths() ?? []).filter((path) => path.status === state.filter),
  )
  const selected = createMemo(() => visible().find((path) => path.research_path_id === state.selected))
  let root!: HTMLDivElement

  createEffect(() => {
    const items = visible()
    if (!items.length) {
      setState("selected", "")
      return
    }
    if (!items.some((path) => path.research_path_id === state.selected)) setState("selected", items[0].research_path_id)
  })

  onMount(() => {
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => setState("compact", entry.contentRect.width < 680))
    observer.observe(root)
    onCleanup(() => observer.disconnect())
  })

  const pathsUnsub = sdk.event.on("research.paths.updated", (event) => {
    if (event.properties.researchProjectId === props.researchProjectId) void refetch()
  })
  const atomsUnsub = sdk.event.on("research.atoms.updated", (event) => {
    if (event.properties.researchProjectId === props.researchProjectId) void refetch()
  })
  onCleanup(() => {
    pathsUnsub()
    atomsUnsub()
  })

  const openAtom = async (atom: Member) => {
    const result = await sdk.client.research.atom.session.create({ atomId: atom.atom_id }).catch(() => undefined)
    const sessionID = result?.data?.session_id
    if (!sessionID) return
    if (props.currentSessionId) sessionStorage.setItem(`atom-session-return-${sessionID}`, props.currentSessionId)
    props.onOpenSession(sessionID)
  }

  return (
    <div ref={root} class="h-full min-h-0">
      <Switch>
        <Match when={paths.loading && !paths()}>
          <div class="h-full flex items-center justify-center text-11-regular text-text-weak">Loading...</div>
        </Match>
        <Match when={paths.error}>
          <div class="h-full flex items-center justify-center text-11-regular text-text-critical-base">
            Failed to load Research Paths
          </div>
        </Match>
        <Match when={paths()?.length === 0}>
          <Empty title={props.title} description={props.description} />
        </Match>
        <Match when={true}>
          <div class={`h-full min-h-0 flex ${state.compact ? "flex-col" : "flex-row"}`}>
            <div
              class={`shrink-0 overflow-y-auto p-3 ${state.compact ? "max-h-[42%] w-full border-b border-border-weak-base" : "h-full w-[38%] min-w-56 border-r border-border-weak-base"}`}
            >
              <div class="mb-3 flex items-center justify-between gap-2 px-1">
                <span class="text-11-medium uppercase tracking-wide text-text-weak">Research paths</span>
                <div class="flex items-center gap-2">
                  <span class="text-10-regular text-text-weak">{visible().length}</span>
                  <Select
                    aria-label="Filter Research Paths by status"
                    options={pathFilters}
                    current={state.filter}
                    label={(filter) => pathFilterLabels[filter]}
                    onSelect={(filter) => filter && setState("filter", filter)}
                    variant="secondary"
                    size="small"
                    valueClass="text-10-regular"
                    triggerStyle={{ "min-width": "6rem" }}
                  />
                </div>
              </div>
              <Show
                when={visible().length > 0}
                fallback={
                  <div class="rounded-md border border-dashed border-border-weak-base px-3 py-6 text-center text-11-regular text-text-weak">
                    No {state.filter === "all" ? "matching" : state.filter} paths
                  </div>
                }
              >
                <div class="flex flex-col gap-2">
                  <For each={visible()}>
                    {(path) => (
                      <PathCard
                        path={path}
                        selected={path.research_path_id === state.selected}
                        onSelect={() => setState("selected", path.research_path_id)}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </div>
            <div class="min-h-0 min-w-0 flex-1">
              <Show
                when={selected()}
                keyed
                fallback={
                  <Empty
                    title={`No ${state.filter === "all" ? "matching" : state.filter} paths`}
                    description="Choose another status to view Research Path history."
                  />
                }
              >
                {(path) => <PathDetail path={path} onOpenSession={props.onOpenSession} onOpenAtom={openAtom} />}
              </Show>
            </div>
          </div>
        </Match>
      </Switch>
    </div>
  )
}

function ResultCard(props: { result: Result; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      class="w-full min-w-0 rounded-md border px-3 py-3 text-left transition-colors"
      classList={{
        "border-border-strong bg-background-stronger": props.selected,
        "border-border-weak-base bg-background-base hover:bg-surface-raised-base-hover": !props.selected,
      }}
      aria-pressed={props.selected}
      onClick={props.onSelect}
    >
      <span class="block text-13-semibold text-text-strong truncate">{props.result.title}</span>
    </button>
  )
}

function ResultAtomCard(props: { atom: ResultAtom; onOpen: () => void }) {
  return (
    <button
      type="button"
      disabled={!props.atom.available}
      class="min-w-0 rounded-md border border-border-weak-base bg-background-base px-3 py-2.5 text-left transition-colors enabled:hover:bg-surface-raised-base-hover disabled:opacity-60"
      onClick={props.onOpen}
    >
      <span class="flex items-start gap-2">
        <span
          class={`mt-1.5 size-1.5 shrink-0 rounded-full ${props.atom.available ? "bg-icon-success-base" : "bg-icon-weak"}`}
        />
        <span class="min-w-0 flex-1">
          <span class="block text-12-medium text-text-strong truncate">{props.atom.atom_name}</span>
          <span class="mt-0.5 flex flex-wrap gap-x-2 text-10-regular text-text-weak">
            <span>{props.atom.atom_type ? typeLabels[props.atom.atom_type] : "Unavailable"}</span>
            <Show when={props.atom.locked}>
              <span>Locked</span>
            </Show>
          </span>
        </span>
      </span>
    </button>
  )
}

function ResultDetail(props: {
  result: Result
  onOpenSession: (sessionID: string) => void
  onOpenAtom: (atom: ResultAtom) => void
}) {
  const names = createMemo(() => new Map(props.result.atoms.map((atom) => [atom.atom_id, atom.atom_name])))
  return (
    <div class="h-full overflow-y-auto">
      <div class="max-w-3xl mx-auto px-5 py-5 pb-10">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 text-11-regular text-text-weak">
              <span class="size-2 rounded-full bg-icon-success-base" />
              <span>Accepted</span>
              <span>{date.format(props.result.time_created)}</span>
            </div>
            <h2 class="mt-1 text-16-semibold text-text-strong break-words">{props.result.title}</h2>
          </div>
          <div class="flex shrink-0 gap-2">
            <button
              type="button"
              class="rounded-md border border-border-weak-base px-2.5 py-1.5 text-11-medium text-text-base hover:bg-surface-raised-base-hover"
              onClick={() => props.onOpenSession(props.result.source_session_id)}
            >
              Research
            </button>
            <button
              type="button"
              class="rounded-md border border-border-weak-base px-2.5 py-1.5 text-11-medium text-text-base hover:bg-surface-raised-base-hover"
              onClick={() => props.onOpenSession(props.result.reviewer_session_id)}
            >
              Reviewer
            </button>
          </div>
        </div>

        <section class="mt-6">
          <div class="mb-2 text-10-medium uppercase tracking-wide text-text-weak">Result</div>
          <Markdown text={props.result.summary} class="text-13-regular" />
        </section>

        <section class="mt-6 rounded-md border border-border-weak-base bg-background-stronger px-4 py-3.5">
          <div class="mb-2 text-10-medium uppercase tracking-wide text-text-weak">Reviewer evaluation</div>
          <Markdown text={props.result.evaluation} class="text-12-regular" />
        </section>

        <section class="mt-7">
          <div class="mb-2 flex items-baseline justify-between gap-2">
            <h3 class="text-12-semibold text-text-strong">Accepted Atom subset</h3>
            <span class="text-10-regular text-text-weak">{props.result.atoms.length} atoms</span>
          </div>
          <div class="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-2">
            <For each={props.result.atoms}>
              {(atom) => <ResultAtomCard atom={atom} onOpen={() => props.onOpenAtom(atom)} />}
            </For>
          </div>
        </section>

        <Show when={props.result.relations.length > 0}>
          <section class="mt-7">
            <h3 class="mb-2 text-12-semibold text-text-strong">Relations in this result</h3>
            <div class="divide-y divide-border-weak-base rounded-md border border-border-weak-base">
              <For each={props.result.relations}>
                {(relation) => (
                  <div class="px-3 py-2 text-11-regular text-text-weak">
                    <span class="text-text-base">
                      {names().get(relation.atom_id_source) ?? relation.atom_id_source}
                    </span>
                    <span class="mx-1.5">{relationLabels[relation.relation_type]}</span>
                    <span class="text-text-base">
                      {names().get(relation.atom_id_target) ?? relation.atom_id_target}
                    </span>
                    <Show when={relation.note}>
                      <span class="ml-1.5">{relation.note}</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </section>
        </Show>
      </div>
    </div>
  )
}

export function ControllerResultsTab(props: {
  researchProjectId: string
  currentSessionId?: string
  title: string
  description: string
  onOpenSession: (sessionID: string) => void
}) {
  const sdk = useSDK()
  const [state, setState] = createStore({ selected: "", compact: false })
  const [results, { refetch }] = createResource(
    () => props.researchProjectId,
    async (researchProjectId) => {
      const result = await sdk.client.research.results.list({ researchProjectId })
      return result.data ?? []
    },
  )
  const selected = createMemo(() => results()?.find((result) => result.research_result_id === state.selected))
  let root!: HTMLDivElement

  createEffect(() => {
    const items = results()
    if (!items?.length) {
      setState("selected", "")
      return
    }
    if (!items.some((result) => result.research_result_id === state.selected)) {
      setState("selected", items[0].research_result_id)
    }
  })

  onMount(() => {
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => setState("compact", entry.contentRect.width < 680))
    observer.observe(root)
    onCleanup(() => observer.disconnect())
  })

  const resultsUnsub = sdk.event.on("research.results.updated", (event) => {
    if (event.properties.researchProjectId === props.researchProjectId) void refetch()
  })
  const atomsUnsub = sdk.event.on("research.atoms.updated", (event) => {
    if (event.properties.researchProjectId === props.researchProjectId) void refetch()
  })
  onCleanup(() => {
    resultsUnsub()
    atomsUnsub()
  })

  const openAtom = async (atom: ResultAtom) => {
    if (!atom.available) return
    const result = await sdk.client.research.atom.session.create({ atomId: atom.atom_id }).catch(() => undefined)
    const sessionID = result?.data?.session_id
    if (!sessionID) return
    if (props.currentSessionId) sessionStorage.setItem(`atom-session-return-${sessionID}`, props.currentSessionId)
    props.onOpenSession(sessionID)
  }

  return (
    <div ref={root} class="h-full min-h-0">
      <Switch>
        <Match when={results.loading && !results()}>
          <div class="h-full flex items-center justify-center text-11-regular text-text-weak">Loading...</div>
        </Match>
        <Match when={results.error}>
          <div class="h-full flex items-center justify-center text-11-regular text-text-critical-base">
            Failed to load Research Results
          </div>
        </Match>
        <Match when={results()?.length === 0}>
          <Empty title={props.title} description={props.description} />
        </Match>
        <Match when={true}>
          <div class={`h-full min-h-0 flex ${state.compact ? "flex-col" : "flex-row"}`}>
            <div
              class={`shrink-0 overflow-y-auto p-3 ${state.compact ? "max-h-[42%] w-full border-b border-border-weak-base" : "h-full w-[38%] min-w-56 border-r border-border-weak-base"}`}
            >
              <div class="mb-3 flex items-baseline justify-between gap-2 px-1">
                <span class="text-11-medium uppercase tracking-wide text-text-weak">Accepted results</span>
                <span class="text-10-regular text-text-weak">{results()?.length}</span>
              </div>
              <div class="flex flex-col gap-2">
                <For each={results()}>
                  {(result) => (
                    <ResultCard
                      result={result}
                      selected={result.research_result_id === state.selected}
                      onSelect={() => setState("selected", result.research_result_id)}
                    />
                  )}
                </For>
              </div>
            </div>
            <div class="min-h-0 min-w-0 flex-1">
              <Show when={selected()} keyed>
                {(result) => <ResultDetail result={result} onOpenSession={props.onOpenSession} onOpenAtom={openAtom} />}
              </Show>
            </div>
          </div>
        </Match>
      </Switch>
    </div>
  )
}

export function ControllerAgentsTab(props: {
  activity: CollabActivity
  empty: string
  showCompleted: string
  hideCompleted: string
  onOpen: (agent: CollabAgent) => void
}) {
  const [state, setState] = createStore({ history: false })
  const all = createMemo(() => {
    const root = props.activity.rootAgent()
    return root ? [root, ...props.activity.children()] : []
  })
  const now = clock(all)
  const past = createMemo(() => props.activity.children().filter(historical))
  const agents = createMemo(() => {
    const root = props.activity.rootAgent()
    return root ? tree(root, all(), now(), state.history) : []
  })

  createEffect(() => {
    props.activity.rootAgent()?.id
    setState("history", false)
  })

  return (
    <div class="h-full overflow-y-auto px-4 py-5">
      <Show when={props.activity.ready()} fallback={<div class="text-12-regular text-text-weak">Loading...</div>}>
        <Show when={props.activity.rootAgent()} fallback={<Empty title={props.empty} description="" />} keyed>
          {(root) => (
            <div class="max-w-3xl mx-auto">
              <Show when={past().length > 0}>
                <div class="mb-2 flex justify-end px-3">
                  <Button variant="ghost" size="small" class="px-2" onClick={() => setState("history", (value) => !value)}>
                    {state.history ? props.hideCompleted : `${props.showCompleted} (${past().length})`}
                  </Button>
                </div>
              </Show>
              <AgentNode node={root} nodes={agents()} depth={0} onOpen={props.onOpen} />
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}

function AgentNode(props: {
  node: CollabAgent
  nodes: CollabAgent[]
  depth: number
  onOpen: (agent: CollabAgent) => void
}) {
  const children = createMemo(() => props.nodes.filter((agent) => agent.parent_agent_id === props.node.id))
  return (
    <div class="relative">
      <Show when={props.depth > 0}>
        <div
          class="absolute -top-2 bottom-1 border-l border-border-weak-base"
          style={{ left: `${props.depth * 20 - 10}px` }}
        />
      </Show>
      <button
        type="button"
        class="relative w-full min-w-0 flex items-start gap-3 rounded-md px-3 py-2.5 text-left hover:bg-surface-raised-base-hover transition-colors"
        style={{ "padding-left": `${props.depth * 20 + 12}px` }}
        onClick={() => props.onOpen(props.node)}
      >
        <span class={`mt-1.5 size-2 rounded-full shrink-0 ${colors[props.node.status] ?? "bg-icon-weak"}`} />
        <span class="min-w-0 flex-1">
          <span class="flex items-baseline gap-2 min-w-0">
            <span class="text-13-medium text-text-strong truncate">{props.node.name}</span>
            <span class="text-11-regular text-text-weak shrink-0">{props.node.subagent_type}</span>
          </span>
          <span class="block text-11-regular text-text-weak capitalize">{props.node.status.replaceAll("_", " ")}</span>
          <Show when={props.node.error?.message}>
            <span class="mt-1 block text-12-regular text-text-critical-base line-clamp-2">
              {props.node.error?.message}
            </span>
          </Show>
        </span>
      </button>
      <For each={children()}>
        {(child) => <AgentNode node={child} nodes={props.nodes} depth={props.depth + 1} onOpen={props.onOpen} />}
      </For>
    </div>
  )
}
