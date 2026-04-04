import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { useSDK } from "@/context/sdk"
import type { ResearchAtomsListResponse } from "@opencode-ai/sdk/v2"
import { AtomGraphView } from "./atom-graph-view"
import { AtomDetailFullscreen } from "./atom-detail-fullscreen"

type Atom = ResearchAtomsListResponse["atoms"][number]
type Relation = ResearchAtomsListResponse["relations"][number]
type AtomKind = "fact" | "method" | "theorem" | "verification"
type RelationKind = "motivates" | "formalizes" | "derives" | "analyzes" | "validates" | "contradicts" | "other"

const TYPE_LABELS: Record<string, string> = {
  fact: "Fact",
  method: "Method",
  theorem: "Theorem",
  verification: "Verification",
}

const EVIDENCE_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  in_progress: "In Progress",
  proven: "Proven",
  disproven: "Disproven",
}

const RELATION_LABELS: Record<string, string> = {
  depends_on: "depends on",
  supports: "supports",
  contradicts: "contradicts",
  other: "related to",
}

function AtomCard(props: { atom: Atom; relations: Relation[]; atomMap: Map<string, Atom>; onClick: () => void }) {
  const outgoing = createMemo(() => props.relations.filter((r) => r.atom_id_source === props.atom.atom_id))
  const incoming = createMemo(() => props.relations.filter((r) => r.atom_id_target === props.atom.atom_id))
  const relCount = createMemo(() => outgoing().length + incoming().length)

  return (
    <div
      class="rounded-md border border-border-weak-base bg-background-base px-3 py-2.5 flex flex-col gap-1.5 cursor-pointer hover:bg-background-stronger transition-colors"
      onClick={props.onClick}
    >
      <div class="flex items-start justify-between gap-2">
        <div class="text-13-semibold text-text-strong truncate flex-1">{props.atom.atom_name}</div>
        <div class="shrink-0 rounded-full px-1.5 py-0.5 text-11-regular bg-background-stronger text-text-weak">
          {TYPE_LABELS[props.atom.atom_type] ?? props.atom.atom_type}
        </div>
      </div>
      <div class="flex items-center gap-2 text-11-regular text-text-weak">
        <span>{EVIDENCE_STATUS_LABELS[props.atom.atom_evidence_status] ?? props.atom.atom_evidence_status}</span>
        <Show when={relCount() > 0 ? relCount() : null} keyed>
          {(count) => (
            <>
              <span class="text-border-base">·</span>
              <span>
                {count} {count === 1 ? "relation" : "relations"}
              </span>
            </>
          )}
        </Show>
      </div>
      <Show when={outgoing().length > 0 ? outgoing() : null} keyed>
        {(rels) => (
          <div class="flex flex-col gap-0.5 mt-0.5">
            <For each={rels}>
              {(rel) => {
                const target = createMemo(() => props.atomMap.get(rel.atom_id_target))
                return (
                  <div class="text-11-regular text-text-weak truncate">
                    → {RELATION_LABELS[rel.relation_type] ?? rel.relation_type}{" "}
                    <span class="text-text-base">{target()?.atom_name ?? rel.atom_id_target.slice(0, 8)}</span>
                  </div>
                )
              }}
            </For>
          </div>
        )}
      </Show>
    </div>
  )
}

function AtomListView(props: {
  atoms: Atom[]
  relations: Relation[]
  atomMap: Map<string, Atom>
  loading: boolean
  error: boolean
  onAtomClick: (atomId: string) => void
}) {
  return (
    <Switch>
      <Match when={props.loading && props.atoms.length === 0}>
        <div class="flex items-center justify-center py-10 text-12-regular text-text-weak">Loading…</div>
      </Match>
      <Match when={props.error}>
        <div class="flex items-center justify-center py-10 text-12-regular text-text-weak">Failed to load atoms</div>
      </Match>
      <Match when={props.atoms.length === 0}>
        <div class="flex items-center justify-center py-10 text-12-regular text-text-weak">
          No atoms in this project yet
        </div>
      </Match>
      <Match when={true}>
        <For each={props.atoms}>
          {(atom) => (
            <AtomCard
              atom={atom}
              relations={props.relations}
              atomMap={props.atomMap}
              onClick={() => props.onAtomClick(atom.atom_id)}
            />
          )}
        </For>
      </Match>
    </Switch>
  )
}

type SubTab = "list" | "graph"

export function AtomsTab(props: { researchProjectId: string; currentSessionId?: string }) {
  const sdk = useSDK()
  const navigate = useNavigate()
  const [atoms, setAtoms] = createSignal<Atom[]>([])
  const [relations, setRelations] = createSignal<Relation[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal(false)

  // Initialize subTab with saved state from localStorage
  const getSavedViewMode = (): SubTab => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("atoms-tab-view-mode")
      if (saved === "list" || saved === "graph") {
        return saved
      }
    }
    return "list"
  }

  const [subTab, setSubTab] = createSignal<SubTab>(getSavedViewMode())
  const [showDetail, setShowDetail] = createSignal(false)
  const [hasOpenedDetail, setHasOpenedDetail] = createSignal(false)
  const [detailOrigin, setDetailOrigin] = createSignal({ x: 0, y: 0, width: 0, height: 0 })
  const [focusAtomId, setFocusAtomId] = createSignal<string | null>(null)
  let detailBtnRef!: HTMLButtonElement

  const atomMap = createMemo(() => new Map(atoms().map((a) => [a.atom_id, a])))
  const safeAtoms = createMemo(() => atoms())
  const safeRelations = createMemo(() => relations())

  const fetchAtoms = async () => {
    try {
      setLoading(true)
      setError(false)
      const res = await sdk.client.research.atoms.list({ researchProjectId: props.researchProjectId })
      if (res.data) {
        setAtoms(res.data.atoms)
        setRelations(res.data.relations)
      }
    } catch (e) {
      console.error("Failed to fetch atoms", e)
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    fetchAtoms().then((r) => {})
  })

  createEffect(() => {
    const unsub = sdk.event.on("research.atoms.updated" as any, () => {
      fetchAtoms().then((r) => {})
    })
    onCleanup(unsub)
  })

  // Save subTab state to localStorage when it changes
  createEffect(() => {
    const currentTab = subTab()
    if (typeof window !== "undefined") {
      localStorage.setItem("atoms-tab-view-mode", currentTab)
    }
  })

  const handleAtomClick = async (atomId: string) => {
    try {
      const res = await sdk.client.research.atom.session.create({ atomId })
      const sessionId = res.data?.session_id
      if (sessionId) {
        // Store the current session ID in sessionStorage for back navigation
        if (props.currentSessionId) {
          sessionStorage.setItem(`atom-session-return-${sessionId}`, props.currentSessionId)
        }
        navigate(`/${base64Encode(sdk.directory)}/session/${sessionId}`)
      }
    } catch (err) {
      console.error("[atoms-tab] failed to get/create atom session", err)
    }
  }

  const handleRelationCreate = async (input: { sourceAtomId: string; targetAtomId: string; relationType: string }) => {
    await sdk.client.research.relation.create({
      researchProjectId: props.researchProjectId,
      source_atom_id: input.sourceAtomId,
      target_atom_id: input.targetAtomId,
      relation_type: input.relationType as RelationKind,
    })
  }

  const handleRelationUpdate = async (input: {
    sourceAtomId: string
    targetAtomId: string
    relationType: string
    nextRelationType: string
  }) => {
    await sdk.client.research.relation.update({
      researchProjectId: props.researchProjectId,
      source_atom_id: input.sourceAtomId,
      target_atom_id: input.targetAtomId,
      relation_type: input.relationType as RelationKind,
      next_relation_type: input.nextRelationType as RelationKind,
    })
  }

  const handleRelationDelete = async (input: { sourceAtomId: string; targetAtomId: string; relationType: string }) => {
    await sdk.client.research.relation.delete({
      researchProjectId: props.researchProjectId,
      source_atom_id: input.sourceAtomId,
      target_atom_id: input.targetAtomId,
      relation_type: input.relationType as RelationKind,
    })
  }

  const handleAtomDelete = async (atomId: string) => {
    await sdk.client.research.atom.delete({
      researchProjectId: props.researchProjectId,
      atomId,
    })
  }

  const handleAtomCreate = async (input: { name: string; type: AtomKind }) => {
    const res = await sdk.client.research.atom.create({
      researchProjectId: props.researchProjectId,
      name: input.name,
      type: input.type,
    })
    if (!res.data) {
      throw new Error("Failed to create atom")
    }
    return res.data
  }

  const handleAtomViewDetail = (atomId: string) => {
    const rect = detailBtnRef.getBoundingClientRect()
    setDetailOrigin({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    setFocusAtomId(atomId)
    setHasOpenedDetail(true)
    setShowDetail(true)
  }

  return (
    <div class="relative flex-1 min-h-0 overflow-hidden h-full flex flex-col">
      <div class="px-3 pt-3 pb-1 flex items-center justify-between">
        <div class="text-12-semibold text-text-weak uppercase tracking-wider">Atoms</div>
        <div class="flex items-center gap-1">
          <button
            class={`px-2 py-1 rounded text-11-regular transition-colors ${
              subTab() === "list" ? "bg-background-stronger text-text-strong" : "text-text-weak hover:text-text-base"
            }`}
            onClick={() => setSubTab("list")}
          >
            List
          </button>
          <button
            class={`px-2 py-1 rounded text-11-regular transition-colors ${
              subTab() === "graph" ? "bg-background-stronger text-text-strong" : "text-text-weak hover:text-text-base"
            }`}
            onClick={() => setSubTab("graph")}
          >
            Graph
          </button>
          <button
            ref={detailBtnRef}
            class={`px-2 py-1 rounded text-11-regular transition-colors ${
              showDetail() ? "bg-background-stronger text-text-strong" : "text-text-weak hover:text-text-base"
            }`}
            onClick={() => {
              const rect = detailBtnRef.getBoundingClientRect()
              setDetailOrigin({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
              setHasOpenedDetail(true)
              setShowDetail(true)
            }}
          >
            Detail
          </button>
        </div>
      </div>
      <div class="flex-1 min-h-0 overflow-auto px-3 pb-3">
        <Switch>
          <Match when={subTab() === "list"}>
            <div class="flex flex-col gap-2">
              <AtomListView
                atoms={safeAtoms()}
                relations={safeRelations()}
                atomMap={atomMap()}
                loading={loading()}
                error={error()}
                onAtomClick={handleAtomClick}
              />
            </div>
          </Match>
          <Match when={subTab() === "graph"}>
            <div class="h-full min-h-[400px]">
              <AtomGraphView
                atoms={safeAtoms()}
                relations={safeRelations()}
                loading={loading()}
                error={error()}
                onAtomClick={handleAtomClick}
                onAtomCreate={handleAtomCreate}
                onAtomDelete={handleAtomDelete}
                onRelationCreate={handleRelationCreate}
                onRelationUpdate={handleRelationUpdate}
                onRelationDelete={handleRelationDelete}
                onAtomViewDetail={handleAtomViewDetail}
                researchProjectId={props.researchProjectId}
              />
            </div>
          </Match>
        </Switch>
      </div>

      <Show when={hasOpenedDetail()}>
        <AtomDetailFullscreen
          atoms={safeAtoms()}
          relations={safeRelations()}
          loading={loading()}
          error={error()}
          onAtomClick={handleAtomClick}
          onAtomCreate={handleAtomCreate}
          onAtomDelete={handleAtomDelete}
          onRelationCreate={handleRelationCreate}
          onRelationUpdate={handleRelationUpdate}
          onRelationDelete={handleRelationDelete}
          researchProjectId={props.researchProjectId}
          originRect={detailOrigin()}
          visible={showDetail()}
          focusAtomId={focusAtomId()}
          onClose={() => {
            setShowDetail(false)
            setFocusAtomId(null)
          }}
        />
      </Show>
    </div>
  )
}
