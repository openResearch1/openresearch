import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type JSX,
} from "solid-js"
import { useParams } from "@solidjs/router"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { type Session } from "@opencode-ai/sdk/v2/client"
import type { ResearchProjectSessionTreeResponse } from "@opencode-ai/sdk/v2"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { NewSessionItem, SessionItem, SessionSkeleton } from "./sidebar-items"
import type { WorkspaceSidebarContext } from "./sidebar-workspace"
import { showToast } from "@opencode-ai/ui/toast"

type TreeAtom = ResearchProjectSessionTreeResponse["atoms"][number]

export function ResearchSessionTree(props: {
  slug: Accessor<string>
  mobile?: boolean
  ctx: WorkspaceSidebarContext
  showNew: Accessor<boolean>
  loading: Accessor<boolean>
  sessions: Accessor<Session[]>
  children: Accessor<Map<string, string[]>>
  hasMore: Accessor<boolean>
  loadMore: () => Promise<void>
  researchProjectId: string
  directory: string
}): JSX.Element {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const params = useParams()

  const client = createMemo(() => globalSDK.createClient({ directory: props.directory, throwOnError: false }))

  const [treeVersion, setTreeVersion] = createSignal(0)

  const [tree, { refetch }] = createResource(
    () => ({ rpId: props.researchProjectId, _v: treeVersion() }),
    async ({ rpId }) => {
      try {
        const res = await client().research.project.sessionTree({ researchProjectId: rpId })
        return (res as any).data as ResearchProjectSessionTreeResponse | undefined
      } catch {
        return undefined
      }
    },
  )

  // Refetch when session count changes (new atom/experiment session created)
  createEffect(
    on(
      () => props.sessions().length,
      () => setTreeVersion((v) => v + 1),
      { defer: true },
    ),
  )

  // Listen for research.atoms.updated events
  createEffect(() => {
    const unsub = globalSDK.event.on(props.directory, (event) => {
      if ((event as any).type === "research.atoms.updated") {
        setTreeVersion((v) => v + 1)
      }
    })
    onCleanup(unsub)
  })

  const atomSessionIdSet = createMemo(() => new Set(tree()?.atomSessionIds ?? []))
  const expSessionIdSet = createMemo(() => new Set(tree()?.expSessionIds ?? []))

  const normalSessions = createMemo(() =>
    props.sessions().filter((s) => !atomSessionIdSet().has(s.id) && !expSessionIdSet().has(s.id)),
  )

  const sessionMap = createMemo(() => {
    const map = new Map<string, Session>()
    for (const s of props.sessions()) map.set(s.id, s)
    return map
  })

  // session ID → atom_id mapping for locate
  const sessionToAtomId = createMemo(() => {
    const map = new Map<string, string>()
    for (const atom of tree()?.atoms ?? []) {
      if (atom.session_id) map.set(atom.session_id, atom.atom_id)
      for (const exp of atom.experiments) {
        if (exp.exp_session_id) map.set(exp.exp_session_id, atom.atom_id)
      }
    }
    return map
  })

  // Which atom the current session belongs to
  const activeAtomId = createMemo(() => {
    const id = params.id
    return id ? sessionToAtomId().get(id) : undefined
  })

  // Level 1 atoms collapsible: auto-expand when current session is in tree, user toggle takes priority
  const [atomsUserOpen, setAtomsUserOpen] = createSignal<boolean | undefined>(undefined)
  const atomsOpen = createMemo(() => atomsUserOpen() ?? !!activeAtomId())
  // Reset user override when active atom changes
  createEffect(on(activeAtomId, () => setAtomsUserOpen(undefined), { defer: true }))

  const [exporting, setExporting] = createSignal(false)

  const handleExport = async () => {
    if (exporting()) return
    setExporting(true)
    try {
      const res = await client().research.project.export({ researchProjectId: props.researchProjectId } as any)
      const data = res.data as { zip_path: string; zip_name: string; size: number } | undefined
      if (data) {
        showToast({
          title: language.t("research.export.success"),
          description: `${data.zip_name} (${(data.size / 1024 / 1024).toFixed(2)} MB)`,
          variant: "success",
        })
      }
    } catch (err) {
      showToast({
        title: language.t("research.export.failed"),
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    } finally {
      setExporting(false)
    }
  }

  return (
    <nav class="flex flex-col gap-1 px-3">
      {/* Export button */}
      <div class="flex items-center justify-between px-2 pt-2 pb-1">
        <div class="text-11-regular text-text-weak uppercase tracking-wider">
          {language.t("sidebar.research.project")}
        </div>
        <Tooltip value={language.t("research.export.tooltip")} placement="top">
          <IconButton
            icon="download"
            variant="ghost"
            size="small"
            class="size-5"
            onClick={handleExport}
            disabled={exporting()}
            aria-label={language.t("research.export.button")}
          />
        </Tooltip>
      </div>

      <Show when={props.showNew()}>
        <NewSessionItem
          slug={props.slug()}
          mobile={props.mobile}
          sidebarExpanded={props.ctx.sidebarExpanded}
          clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
          setHoverSession={props.ctx.setHoverSession}
        />
      </Show>
      <Show when={props.loading()}>
        <SessionSkeleton />
      </Show>

      {/* Level 1: Normal Conversations - always expanded */}
      <Show when={normalSessions().length > 0}>
        <div class="flex items-center justify-between px-2 pt-2 pb-1">
          <div class="text-11-regular text-text-weak uppercase tracking-wider">
            {language.t("sidebar.research.conversations")}
          </div>
          <Tooltip value={language.t("command.session.viewArchived")} placement="top">
            <IconButton
              icon="archive"
              variant="ghost"
              size="small"
              class="size-5"
              onClick={() => props.ctx.showArchivedSessionsDialog(props.directory)}
              aria-label={language.t("command.session.viewArchived")}
            />
          </Tooltip>
        </div>
        <For each={normalSessions()}>
          {(session) => (
            <SessionItem
              session={session}
              slug={props.slug()}
              mobile={props.mobile}
              children={props.children()}
              sidebarExpanded={props.ctx.sidebarExpanded}
              sidebarHovering={props.ctx.sidebarHovering}
              nav={props.ctx.nav}
              hoverSession={props.ctx.hoverSession}
              setHoverSession={props.ctx.setHoverSession}
              clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
              prefetchSession={props.ctx.prefetchSession}
              archiveSession={props.ctx.archiveSession}
            />
          )}
        </For>
      </Show>

      {/* Level 1: Atoms list - collapsible */}
      <Show when={tree()?.atoms && tree()!.atoms.length > 0}>
        <Collapsible variant="ghost" class="shrink-0" open={atomsOpen()} onOpenChange={setAtomsUserOpen}>
          <div class="px-0 py-1">
            <Collapsible.Trigger class="flex items-center justify-between w-full px-2 py-1 rounded-md hover:bg-surface-raised-base-hover">
              <div class="flex items-center gap-1 min-w-0 flex-1">
                <span class="text-11-regular text-text-weak uppercase tracking-wider">
                  {language.t("sidebar.research.atoms")} ({tree()!.atoms.length})
                </span>
              </div>
            </Collapsible.Trigger>
          </div>
          <Collapsible.Content>
            <div class="flex flex-col gap-0.5">
              <For each={tree()!.atoms}>
                {(atom) => (
                  <AtomGroup
                    atom={atom}
                    slug={props.slug}
                    mobile={props.mobile}
                    ctx={props.ctx}
                    sessionMap={sessionMap}
                    childrenMap={props.children}
                    activeAtomId={activeAtomId}
                    activeSessionId={() => params.id}
                  />
                )}
              </For>
            </div>
          </Collapsible.Content>
        </Collapsible>
      </Show>
    </nav>
  )
}

function AtomGroup(props: {
  atom: TreeAtom
  slug: Accessor<string>
  mobile?: boolean
  ctx: WorkspaceSidebarContext
  sessionMap: Accessor<Map<string, Session>>
  childrenMap: Accessor<Map<string, string[]>>
  activeAtomId: Accessor<string | undefined>
  activeSessionId: Accessor<string | undefined>
}): JSX.Element {
  const atomSession = createMemo(() =>
    props.atom.session_id ? props.sessionMap().get(props.atom.session_id) : undefined,
  )

  const expSessions = createMemo(
    () =>
      props.atom.experiments
        .filter((exp) => exp.exp_session_id)
        .map((exp) => ({
          exp,
          session: props.sessionMap().get(exp.exp_session_id!),
        }))
        .filter((item) => item.session !== undefined) as Array<{
        exp: TreeAtom["experiments"][number]
        session: Session
      }>,
  )

  const hasContent = createMemo(() => !!atomSession() || expSessions().length > 0)

  // Auto-expand this atom group when the current session belongs to it
  const isActiveGroup = createMemo(() => props.activeAtomId() === props.atom.atom_id)
  const [userOpen, setUserOpen] = createSignal<boolean | undefined>(undefined)
  const open = createMemo(() => userOpen() ?? isActiveGroup())
  createEffect(on(isActiveGroup, () => setUserOpen(undefined), { defer: true }))

  return (
    <Collapsible variant="ghost" class="shrink-0 pl-2" open={open()} onOpenChange={setUserOpen}>
      <div class="py-0.5">
        <Collapsible.Trigger class="flex items-center justify-between w-full px-2 py-1 rounded-md hover:bg-surface-raised-base-hover">
          <div class="flex items-center gap-1.5 min-w-0 flex-1">
            <Icon name="atom" size="small" class="text-icon-base shrink-0" />
            <span class="text-13-medium text-text-base min-w-0 truncate">{props.atom.atom_name}</span>
          </div>
        </Collapsible.Trigger>
      </div>
      <Collapsible.Content>
        <div class="flex flex-col gap-0.5 pl-2">
          <Show when={!hasContent()}>
            <div class="px-2 py-1 text-12-regular text-text-weak">No sessions</div>
          </Show>

          {/* Level 3: Atom session */}
          <Show when={atomSession()} keyed>
            {(session) => (
              <AtomSessionItem
                session={session}
                slug={props.slug()}
                mobile={props.mobile}
                icon="atom"
                ctx={props.ctx}
                childrenMap={props.childrenMap}
                active={() => props.activeSessionId() === session.id}
              />
            )}
          </Show>

          {/* Level 3: Experiment sessions */}
          <For each={expSessions()}>
            {(item) => (
              <AtomSessionItem
                session={item.session}
                slug={props.slug()}
                mobile={props.mobile}
                icon="experiment"
                ctx={props.ctx}
                childrenMap={props.childrenMap}
                active={() => props.activeSessionId() === item.session.id}
              />
            )}
          </For>
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}

function AtomSessionItem(props: {
  session: Session
  slug: string
  mobile?: boolean
  icon: "atom" | "experiment"
  ctx: WorkspaceSidebarContext
  childrenMap: Accessor<Map<string, string[]>>
  active: Accessor<boolean>
}): JSX.Element {
  let el: HTMLDivElement | undefined

  // Scroll into view when this item becomes the active session
  createEffect(() => {
    if (props.active() && el) {
      requestAnimationFrame(() => el!.scrollIntoView({ block: "nearest", behavior: "smooth" }))
    }
  })

  return (
    <div ref={el} class="flex items-center gap-0">
      <div class="shrink-0 size-5 flex items-center justify-center">
        <Icon name={props.icon} size="small" class="text-icon-weak" />
      </div>
      <div class="flex-1 min-w-0">
        <SessionItem
          session={props.session}
          slug={props.slug}
          mobile={props.mobile}
          dense
          children={props.childrenMap()}
          sidebarExpanded={props.ctx.sidebarExpanded}
          sidebarHovering={props.ctx.sidebarHovering}
          nav={props.ctx.nav}
          hoverSession={props.ctx.hoverSession}
          setHoverSession={props.ctx.setHoverSession}
          clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
          prefetchSession={props.ctx.prefetchSession}
          archiveSession={props.ctx.archiveSession}
        />
      </div>
    </div>
  )
}
