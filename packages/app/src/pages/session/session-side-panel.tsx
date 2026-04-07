import { For, Match, Show, Switch, createEffect, createMemo, createResource, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { useNavigate, useParams } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Mark } from "@opencode-ai/ui/logo"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@opencode-ai/ui/context/dialog"

import FileTree from "@/components/file-tree"
import { SessionContextUsage } from "@/components/session-context-usage"
import { DialogSelectFile } from "@/components/dialog-select-file"
import { DialogPathPicker } from "@/components/dialog-new-research-project"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { showToast } from "@opencode-ai/ui/toast"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import { createOpenSessionFileTab, getTabReorderIndex, type Sizing } from "@/pages/session/helpers"
import { StickyAddButton } from "@/pages/session/review-tab"
import { AtomsTab } from "@/pages/session/atoms-tab"
import { AtomSessionTab } from "@/pages/session/atom-session-tab"
import { ExpPlanTab, ExpHistoryChangeTab, ExpResultTab, ExpProgressTab } from "@/pages/session/experiment-tab"
import { ServersTab } from "@/pages/session/servers-tab"
import { WatchesTab } from "@/pages/session/watches-tab"
import { CodesTab } from "@/pages/session/codes-tab"
import { setSessionHandoff } from "@/pages/session/handoff"

function DialogArticleImport(props: {
  count: number
  onSkip: () => void
  onParse: () => void
}) {
  const dialog = useDialog()

  return (
    <Dialog title="Parse Added Articles" fit class="w-full max-w-[420px] mx-auto">
      <div class="px-6 py-5 flex flex-col gap-4">
        <p class="text-13-regular text-text-weak">
          Added {props.count} article{props.count > 1 ? "s" : ""}. Parse the new article
          {props.count > 1 ? "s" : ""} into the research graph now?
        </p>
        <div class="flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              dialog.close()
              props.onSkip()
            }}
          >
            Later
          </Button>
          <Button
            onClick={() => {
              dialog.close()
              props.onParse()
            }}
          >
            Parse Now
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function SessionSidePanel(props: {
  reviewPanel: () => JSX.Element
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  size: Sizing
}) {
  const params = useParams()
  const navigate = useNavigate()
  const layout = useLayout()
  const sdk = useSDK()
  const sync = useSync()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const tabs = createMemo(() => layout.tabs(sessionKey))
  const view = createMemo(() => layout.view(sessionKey))

  const reviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const fileOpen = createMemo(() => isDesktop() && layout.fileTree.opened())
  const open = createMemo(() => reviewOpen() || fileOpen())
  const reviewTab = createMemo(() => isDesktop())
  const panelWidth = createMemo(() => {
    if (!open()) return "0px"
    if (reviewOpen()) return `calc(100% - ${layout.session.width()}px)`
    return `${layout.fileTree.width()}px`
  })
  const treeWidth = createMemo(() => (fileOpen() ? `${layout.fileTree.width()}px` : "0px"))

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const diffs = createMemo(() => (params.id ? (sync.data.session_diff[params.id] ?? []) : []))
  const reviewCount = createMemo(() => Math.max(info()?.summary?.files ?? 0, diffs().length))
  const hasReview = createMemo(() => reviewCount() > 0)
  const diffsReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    if (!hasReview()) return true
    return sync.data.session_diff[id] !== undefined
  })

  const projectId = createMemo(() => sync.project?.id)
  const [researchProject] = createResource(projectId, async (id) => {
    try {
      const res = await sdk.client.research.project.get({ projectId: id })
      return res.data ?? undefined
    } catch {
      return undefined
    }
  })
  const isResearchProject = createMemo(() => !!researchProject())

  // Check if current session is an atom session
  const [atomSession, { refetch: refetchAtomSession }] = createResource(
    () => params.id,
    async (sessionId) => {
      if (!sessionId) return null
      try {
        const res = await sdk.client.research.session.atom.get({ sessionId })
        return res.data?.atom ?? null
      } catch {
        return null
      }
    },
  )
  const isAtomSession = createMemo(() => !!atomSession())

  // Check if current session is an experiment session
  const [experimentSession, { refetch: refetchExperimentSession }] = createResource(
    () => params.id,
    async (sessionId) => {
      if (!sessionId) return null
      try {
        const res = await sdk.client.research.experiment.bySession({ sessionId })
        return res.data ?? null
      } catch {
        return null
      }
    },
  )
  const isExpSession = createMemo(() => !!experimentSession())

  // Record the last main (non-atom, non-exp) session for this research project
  // so atom/exp sessions can use it as a fallback return target
  createEffect(() => {
    const rp = researchProject()
    const sessionId = params.id
    if (rp && sessionId && !isAtomSession() && !isExpSession()) {
      sessionStorage.setItem(`research-project-main-session-${rp.research_project_id}`, sessionId)
    }
  })

  const atomGraphSessionId = createMemo(() => {
    const rpId = atomSession()?.research_project_id ?? experimentSession()?.research_project_id
    if (!rpId) return
    return sessionStorage.getItem(`research-project-main-session-${rpId}`) ?? undefined
  })
  const mainSessionId = createMemo(() => {
    if (params.id && !isAtomSession() && !isExpSession()) return params.id
    return atomGraphSessionId()
  })

  const openAtomGraphSession = () => {
    const sessionId = atomGraphSessionId()
    if (!sessionId || !params.dir) return
    localStorage.setItem("atoms-tab-view-mode", "graph")
    const key = `${params.dir}/${sessionId}`
    layout.tabs(key).setActive("atoms")
    layout.view(key).reviewPanel.open()
    navigate(`/${base64Encode(sdk.directory)}/session/${sessionId}`)
  }

  const returnFromExperimentSession = () => {
    if (window.history.length > 1) {
      window.history.back()
      return
    }

    openAtomGraphSession()
  }

  // Fetch experiment diff data at panel level; refetch when switching to the changes tab
  const [experimentDiff, { refetch: refetchExperimentDiff }] = createResource(
    () => experimentSession()?.exp_id,
    async (expId) => {
      if (!expId) return null
      try {
        const res = await sdk.client.research.experiment.diff({ expId })
        return (
          (
            res.data as
              | { commits: Array<{ hash: string; message: string; author: string; date: string; diffs: any[] }> }
              | undefined
          )?.commits ?? []
        )
      } catch {
        return []
      }
    },
  )

  const reviewEmptyKey = createMemo(() => {
    if (sync.project && !sync.project.vcs) return "session.review.noVcs"
    if (sync.data.config.snapshot === false) return "session.review.noSnapshot"
    return "session.review.noChanges"
  })

  const diffFiles = createMemo(() => diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const _openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
  })
  // Track which session ID has been "settled" (resources finished loading).
  // Before settling, block programmatic "review" tab writes from overwriting
  // the stored active tab during session switches.
  let settledSessionId: string | undefined
  createEffect(() => {
    if (!atomSession.loading && !experimentSession.loading) {
      settledSessionId = params.id
    }
  })

  let normalizedSessionId: string | undefined
  createEffect(() => {
    if (params.id !== settledSessionId) return
    if (normalizedSessionId === params.id) return

    const active = tabs().active()
    const next = isAtomSession() ? "atom-content" : isResearchProject() && !isExpSession() ? "atoms" : undefined
    if (!next) {
      normalizedSessionId = params.id
      return
    }

    if (active === undefined || active === "review") {
      tabs().setActive(next)
    }
    normalizedSessionId = params.id
  })

  const openTab = (value: string) => {
    if (value === "review" && params.id !== settledSessionId) return
    _openTab(value)
  }

  const contextOpen = createMemo(() => tabs().active() === "context" || tabs().all().includes("context"))
  const openedTabs = createMemo(() =>
    tabs()
      .all()
      .filter((tab) => {
        return (
          tab !== "context" &&
          tab !== "review" &&
          tab !== "atoms" &&
          tab !== "atom-content" &&
          tab !== "atom-evidence" &&
          tab !== "atom-plan" &&
          tab !== "atom-assessment" &&
          tab !== "servers" &&
          tab !== "watches" &&
          tab !== "codes" &&
          tab !== "exp-info" &&
          tab !== "exp-plan" &&
          tab !== "exp-history" &&
          tab !== "exp-result"
        )
      }),
  )

  const activeTab = createMemo(() => {
    const active = tabs().active()
    if (active === "context") return "context"
    if (active === "review" && reviewTab() && !isExpSession()) return "review"
    if (active === "atoms" && isResearchProject() && !isAtomSession() && !isExpSession()) return "atoms"
    if (active === "servers" && isResearchProject() && !isAtomSession() && !isExpSession()) return "servers"
    if (active === "watches" && isResearchProject() && !isAtomSession() && !isExpSession()) return "watches"
    if (active === "codes" && isResearchProject() && !isAtomSession() && !isExpSession()) return "codes"
    if (active === "atom-content" && isAtomSession()) return "atom-content"
    if (active === "atom-evidence" && isAtomSession()) return "atom-evidence"
    if (active === "atom-plan" && isAtomSession()) return "atom-plan"
    if (active === "atom-assessment" && isAtomSession()) return "atom-assessment"
    if (active === "exp-info" && isExpSession()) return "exp-info"
    if (active === "exp-plan" && isExpSession()) return "exp-plan"
    if (active === "exp-history" && isExpSession()) return "exp-history"
    if (active === "exp-result" && isExpSession()) return "exp-result"
    if (active && file.pathFromTab(active)) return normalizeTab(active)

    // Fallback: pick a sensible default tab
    const first = openedTabs()[0]
    if (first) return first
    if (contextOpen()) return "context"
    if (isExpSession()) return "exp-info"
    if (isAtomSession()) return "atom-content"
    // For research projects, default to "atoms" instead of "review"
    if (isResearchProject()) return "atoms"
    if (reviewTab() && hasReview()) return "review"
    return "empty"
  })

  // Refetch experiment diff when switching to the changes tab, and poll while active
  createEffect(() => {
    if (activeTab() === "exp-history" && experimentSession()?.exp_id) {
      refetchExperimentDiff()
      const timer = setInterval(() => refetchExperimentDiff(), 5000)
      onCleanup(() => clearInterval(timer))
    }
  })

  const activeFileTab = createMemo(() => {
    const active = activeTab()
    if (!openedTabs().includes(active)) return
    return active
  })

  const fileTreeTab = () => layout.fileTree.tab()

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    layout.fileTree.setTab(value)
  }

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <Show when={isDesktop()}>
      <aside
        id="review-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 h-full flex shrink-0 overflow-hidden bg-background-base"
        classList={{
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !props.size.active(),
        }}
        style={{ width: panelWidth() }}
      >
        <div class="size-full flex border-l border-border-weaker-base">
          <div
            aria-hidden={!reviewOpen()}
            inert={!reviewOpen()}
            class="relative min-w-0 h-full flex-1 overflow-hidden bg-background-base"
            classList={{
              "pointer-events-none": !reviewOpen(),
            }}
          >
            <div class="size-full min-w-0 h-full bg-background-base">
              <DragDropProvider
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragOver={handleDragOver}
                collisionDetector={closestCenter}
              >
                <DragDropSensors />
                <ConstrainDragYAxis />
                <Tabs value={activeTab()} onChange={openTab}>
                  <div class="sticky top-0 shrink-0 flex">
                    <Tabs.List
                      ref={(el: HTMLDivElement) => {
                        const stop = createFileTabListSync({ el, contextOpen })
                        onCleanup(stop)
                      }}
                    >
                      <Show when={isExpSession()}>
                        <Tabs.Trigger value="exp-info">
                          <div class="flex items-center gap-1.5">
                            <div>Info</div>
                          </div>
                        </Tabs.Trigger>
                        <Tabs.Trigger value="exp-plan">
                          <div class="flex items-center gap-1.5">
                            <div>Plan</div>
                          </div>
                        </Tabs.Trigger>
                        <Tabs.Trigger value="exp-history">
                          <div class="flex items-center gap-1.5">
                            <div>Changes</div>
                          </div>
                        </Tabs.Trigger>
                        <Tabs.Trigger value="exp-result">
                          <div class="flex items-center gap-1.5">
                            <div>Result</div>
                          </div>
                        </Tabs.Trigger>
                        <button
                          class="ml-auto shrink-0 px-2 py-1 text-11-regular text-text-weak hover:text-text-base transition-colors"
                          onClick={returnFromExperimentSession}
                        >
                          ← Return
                        </button>
                        <Show when={atomGraphSessionId()}>
                          <button
                            class="shrink-0 px-2 py-1 text-11-regular text-text-weak hover:text-text-base transition-colors"
                            onClick={openAtomGraphSession}
                          >
                            ← Atom Graph
                          </button>
                        </Show>
                      </Show>
                      <Show when={!isExpSession() && isResearchProject() && !isAtomSession()}>
                        <Tabs.Trigger value="atoms">
                          <div class="flex items-center gap-1.5">
                            <div>Atoms</div>
                          </div>
                        </Tabs.Trigger>
                        <Tabs.Trigger value="servers">
                          <div class="flex items-center gap-1.5">
                            <div>Servers</div>
                          </div>
                        </Tabs.Trigger>
                        <Tabs.Trigger value="watches">
                          <div class="flex items-center gap-1.5">
                            <div>Watches</div>
                          </div>
                        </Tabs.Trigger>
                        <Tabs.Trigger value="codes">
                          <div class="flex items-center gap-1.5">
                            <div>Codes</div>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      <Show when={!isExpSession() && isAtomSession()}>
                        <Tabs.Trigger value="atom-content">
                          <div class="flex items-center gap-1.5">
                            <div>Claim</div>
                          </div>
                        </Tabs.Trigger>
                        <Tabs.Trigger value="atom-evidence">
                          <div class="flex items-center gap-1.5">
                            <div>Evidence</div>
                          </div>
                        </Tabs.Trigger>
                        <Tabs.Trigger value="atom-plan">
                          <div class="flex items-center gap-1.5">
                            <div>Experiment</div>
                          </div>
                        </Tabs.Trigger>
                        <Tabs.Trigger value="atom-assessment">
                          <div class="flex items-center gap-1.5">
                            <div>Assessment</div>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      <Show when={!isExpSession() && reviewTab()}>
                        <Tabs.Trigger value="review">
                          <div class="flex items-center gap-1.5">
                            <div>{language.t("session.tab.review")}</div>
                            <Show when={hasReview()}>
                              <div>{reviewCount()}</div>
                            </Show>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      <Show when={!isExpSession() && isAtomSession()}>
                        <Show when={atomGraphSessionId()}>
                          <button
                            class="ml-auto shrink-0 px-2 py-1 text-11-regular text-text-weak hover:text-text-base transition-colors"
                            onClick={openAtomGraphSession}
                          >
                            ← Atom Graph
                          </button>
                        </Show>
                      </Show>
                      <Show when={contextOpen()}>
                        <Tabs.Trigger
                          value="context"
                          closeButton={
                            <TooltipKeybind
                              title={language.t("common.closeTab")}
                              keybind={command.keybind("tab.close")}
                              placement="bottom"
                              gutter={10}
                            >
                              <IconButton
                                icon="close-small"
                                variant="ghost"
                                class="h-5 w-5"
                                onClick={() => tabs().close("context")}
                                aria-label={language.t("common.closeTab")}
                              />
                            </TooltipKeybind>
                          }
                          hideCloseButton
                          onMiddleClick={() => tabs().close("context")}
                        >
                          <div class="flex items-center gap-2">
                            <SessionContextUsage variant="indicator" />
                            <div>{language.t("session.tab.context")}</div>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      <SortableProvider ids={openedTabs()}>
                        <For each={openedTabs()}>{(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}</For>
                      </SortableProvider>
                      <StickyAddButton>
                        <TooltipKeybind
                          title={language.t("command.file.open")}
                          keybind={command.keybind("file.open")}
                          class="flex items-center"
                        >
                          <IconButton
                            icon="plus-small"
                            variant="ghost"
                            iconSize="large"
                            class="!rounded-md"
                            onClick={() =>
                              dialog.show(() => <DialogSelectFile mode="files" onOpenFile={showAllFiles} />)
                            }
                            aria-label={language.t("command.file.open")}
                          />
                        </TooltipKeybind>
                      </StickyAddButton>
                    </Tabs.List>
                  </div>

                  <Show when={reviewTab()}>
                    <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "review"}>{props.reviewPanel()}</Show>
                    </Tabs.Content>
                  </Show>

                  <Show when={isResearchProject() && !isAtomSession() ? researchProject() : null} keyed>
                    {(project) => (
                      <>
                        <Tabs.Content value="atoms" class="flex flex-col h-full overflow-hidden contain-strict">
                          <Show when={activeTab() === "atoms"}>
                            <AtomsTab researchProjectId={project.research_project_id} currentSessionId={params.id} />
                          </Show>
                        </Tabs.Content>
                        <Tabs.Content value="servers" class="flex flex-col h-full overflow-hidden contain-strict">
                          <Show when={activeTab() === "servers"}>
                            <ServersTab />
                          </Show>
                        </Tabs.Content>
                        <Tabs.Content value="watches" class="flex flex-col h-full overflow-hidden contain-strict">
                          <Show when={activeTab() === "watches"}>
                            <WatchesTab onOpenFile={(filePath) => openTab(file.tab(filePath))} />
                          </Show>
                        </Tabs.Content>
                        <Tabs.Content value="codes" class="flex flex-col h-full overflow-hidden contain-strict">
                          <Show when={activeTab() === "codes"}>
                            <CodesTab researchProjectId={project.research_project_id} />
                          </Show>
                        </Tabs.Content>
                      </>
                    )}
                  </Show>

                  <Show when={isAtomSession() && atomSession()} keyed>
                    {(atom) => (
                      <>
                        <Tabs.Content value="atom-content" class="flex flex-col h-full overflow-hidden contain-strict">
                          <Show when={activeTab() === "atom-content"}>
                            <AtomSessionTab
                              atom={atom}
                              activeTab="content"
                              onRefresh={refetchAtomSession}
                              onOpenFile={(filePath) => openTab(file.tab(filePath))}
                            />
                          </Show>
                        </Tabs.Content>
                        <Tabs.Content value="atom-evidence" class="flex flex-col h-full overflow-hidden contain-strict">
                          <Show when={activeTab() === "atom-evidence"}>
                            <AtomSessionTab
                              atom={atom}
                              activeTab="evidence"
                              onRefresh={refetchAtomSession}
                              onOpenFile={(filePath) => openTab(file.tab(filePath))}
                            />
                          </Show>
                        </Tabs.Content>
                        <Tabs.Content value="atom-plan" class="flex flex-col h-full overflow-hidden contain-strict">
                          <Show when={activeTab() === "atom-plan"}>
                            <AtomSessionTab
                              atom={atom}
                              activeTab="plan"
                              onRefresh={refetchAtomSession}
                              onOpenFile={(filePath) => openTab(file.tab(filePath))}
                            />
                          </Show>
                        </Tabs.Content>
                        <Tabs.Content
                          value="atom-assessment"
                          class="flex flex-col h-full overflow-hidden contain-strict"
                        >
                          <Show when={activeTab() === "atom-assessment"}>
                            <AtomSessionTab
                              atom={atom}
                              activeTab="assessment"
                              onRefresh={refetchAtomSession}
                              onOpenFile={(filePath) => openTab(file.tab(filePath))}
                            />
                          </Show>
                        </Tabs.Content>
                      </>
                    )}
                  </Show>

                  <Show when={isExpSession() && experimentSession()} keyed>
                    {(experiment) => (
                      <>
                        <Tabs.Content value="exp-info" class="flex flex-col h-full overflow-hidden contain-strict">
                          <Show when={activeTab() === "exp-info"}>
                            <ExpProgressTab experiment={experiment} onUpdated={refetchExperimentSession} />
                          </Show>
                        </Tabs.Content>
                        <Tabs.Content value="exp-plan" class="flex flex-col h-full overflow-hidden contain-strict">
                          <Show when={activeTab() === "exp-plan"}>
                            <ExpPlanTab experiment={experiment} />
                          </Show>
                        </Tabs.Content>
                        <Tabs.Content value="exp-history" class="flex flex-col h-full overflow-hidden contain-strict">
                          <Show when={activeTab() === "exp-history"}>
                            <ExpHistoryChangeTab
                              experiment={experiment}
                              commits={experimentDiff.latest ?? []}
                              loading={experimentDiff.loading}
                              error={experimentDiff.error}
                              onRefresh={refetchExperimentDiff}
                            />
                          </Show>
                        </Tabs.Content>
                        <Tabs.Content value="exp-result" class="flex flex-col h-full overflow-hidden contain-strict">
                          <Show when={activeTab() === "exp-result"}>
                            <ExpResultTab
                              experiment={experiment}
                              onOpenFile={(filePath) => openTab(file.tab(filePath))}
                            />
                          </Show>
                        </Tabs.Content>
                      </>
                    )}
                  </Show>

                  <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                    <Show when={activeTab() === "empty"}>
                      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                        <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                          <Mark class="w-14 opacity-10" />
                          <div class="text-14-regular text-text-weak max-w-56">
                            {language.t("session.files.selectToOpen")}
                          </div>
                        </div>
                      </div>
                    </Show>
                  </Tabs.Content>

                  <Show when={contextOpen()}>
                    <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "context"}>
                        <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                          <SessionContextTab />
                        </div>
                      </Show>
                    </Tabs.Content>
                  </Show>

                  <Show when={activeFileTab()} keyed>
                    {(tab) => <FileTabContent tab={tab} />}
                  </Show>
                </Tabs>
                <DragOverlay>
                  <Show when={store.activeDraggable} keyed>
                    {(tab) => {
                      const path = createMemo(() => file.pathFromTab(tab))
                      return (
                        <div data-component="tabs-drag-preview">
                          <Show when={path()}>{(p) => <FileVisual active path={p()} />}</Show>
                        </div>
                      )
                    }}
                  </Show>
                </DragOverlay>
              </DragDropProvider>
            </div>
          </div>

          <div
            id="file-tree-panel"
            aria-hidden={!fileOpen()}
            inert={!fileOpen()}
            class="relative min-w-0 h-full shrink-0 overflow-hidden"
            classList={{
              "pointer-events-none": !fileOpen(),
              "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                !props.size.active(),
            }}
            style={{ width: treeWidth() }}
          >
            <div
              class="h-full flex flex-col overflow-hidden group/filetree"
              classList={{ "border-l border-border-weaker-base": reviewOpen() }}
            >
              <Tabs
                variant="pill"
                value={fileTreeTab()}
                onChange={setFileTreeTabValue}
                class="h-full"
                data-scope="filetree"
              >
                <Tabs.List>
                  <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                    {reviewCount()}{" "}
                    {language.t(reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other")}
                  </Tabs.Trigger>
                  <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                    {language.t("session.files.all")}
                  </Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content value="changes" class="bg-background-stronger px-3 py-0">
                  <Switch>
                    <Match when={hasReview()}>
                      <Show
                        when={diffsReady()}
                        fallback={
                          <div class="px-2 py-2 text-12-regular text-text-weak">
                            {language.t("common.loading")}
                            {language.t("common.loading.ellipsis")}
                          </div>
                        }
                      >
                        <FileTree
                          path=""
                          class="pt-3"
                          allowed={diffFiles()}
                          kinds={kinds()}
                          draggable={false}
                          active={props.activeDiff}
                          onFileClick={(node) => props.focusReviewDiff(node.path)}
                        />
                      </Show>
                    </Match>
                    <Match when={true}>
                      {empty(
                        language.t(sync.project && !sync.project.vcs ? "session.review.noChanges" : reviewEmptyKey()),
                      )}
                    </Match>
                  </Switch>
                </Tabs.Content>
                <Tabs.Content value="all" class="bg-background-stronger px-3 py-0">
                  <Switch>
                    <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                    <Match when={true}>
                      <Show when={isResearchProject()}>
                        <div class="pt-3 pb-2 flex items-center justify-between">
                          <span class="text-11-regular text-text-weak uppercase tracking-wider">Files</span>
                          <IconButton
                            icon="plus-small"
                            variant="ghost"
                            class="size-5 rounded-md"
                            aria-label="Add Article"
                            onClick={() => {
                              dialog.show(() => (
                                <DialogPathPicker
                                  title="Select Articles"
                                  mode="files"
                                  multiple={true}
                                  acceptExt={[".pdf"]}
                                  allowDirs
                                  validateSelection={async (paths: string[]) => {
                                    const rpId = researchProject()?.research_project_id
                                    if (!rpId) return { valid: false, error: "Research project not found" }

                                    const projectInfo = sync.project
                                    if (!projectInfo) return { valid: false, error: "Project info not found" }

                                    const articlesDir = `${projectInfo.worktree}/articles`

                                    // Get list of existing files in articles directory
                                    let existingFiles: string[] = []
                                    try {
                                      const result = await sdk.client.file.list({ directory: articlesDir, path: "" })
                                      existingFiles = (result.data || [])
                                        .filter((node) => node.type === "file")
                                        .map((node) => node.name)
                                    } catch (error) {
                                      // Directory might not exist yet, which is fine
                                      console.log("Articles directory not found, will be created")
                                    }

                                    // Check for duplicates
                                    const duplicates: string[] = []
                                    for (const path of paths) {
                                      const filename = path.split("/").pop() || path
                                      if (existingFiles.includes(filename)) {
                                        duplicates.push(filename)
                                      }
                                    }

                                    if (duplicates.length > 0) {
                                      return {
                                        valid: false,
                                        error: `以下文件已存在: ${duplicates.join(", ")}`,
                                      }
                                    }

                                    return { valid: true }
                                  }}
                                  onSelect={async (paths: string | string[]) => {
                                    const selectedPaths = Array.isArray(paths) ? paths : [paths]
                                    if (selectedPaths.length === 0) return

                                    const rpId = researchProject()?.research_project_id
                                    if (!rpId) return

                                    // Add all articles
                                    let successCount = 0
                                    let errorCount = 0
                                    const articleIds: string[] = []
                                    for (const path of selectedPaths) {
                                      try {
                                        const res = await sdk.client.research.article.create({
                                          researchProjectId: rpId,
                                          sourcePath: path,
                                        })
                                        if (res.data?.article_id) articleIds.push(res.data.article_id)
                                        successCount++
                                      } catch (error: any) {
                                        errorCount++
                                        console.error("Failed to add article:", error)
                                      }
                                    }

                                    // Refresh file tree to show new articles
                                    await file.tree.refresh("")
                                    // Also refresh the articles directory specifically
                                    await file.tree.refresh("articles")

                                    // Show result
                                    if (successCount > 0) {
                                      showToast({
                                        title: "Articles Added",
                                        description: `Successfully added ${successCount} article(s)`,
                                        variant: "success",
                                      })
                                      if (articleIds.length > 0) {
                                        dialog.show(() => (
                                          <DialogArticleImport
                                            count={successCount}
                                            onSkip={() => {}}
                                            onParse={() => {
                                              const sessionID = mainSessionId()
                                              if (!sessionID) {
                                                showToast({
                                                  title: "Parse Not Started",
                                                  description: "Open a main research session to start incremental parsing.",
                                                  variant: "error",
                                                })
                                                return
                                              }

                                              const prompt = [
                                                "Incrementally process only these newly added article IDs.",
                                                `Target article IDs: ${articleIds.join(", ")}`,
                                                "Build each target article's local atom tree separately.",
                                                "After local trees are built, link the target trees among themselves and against already parsed article trees.",
                                                "Do not rebuild existing article-local trees.",
                                                "Do not rewrite background.md or goal.md unless they are currently missing.",
                                              ].join("\n")

                                              void sdk.client.session
                                                .promptAsync({
                                                  sessionID,
                                                  agent: "research_project_init",
                                                  parts: [{ type: "text", text: prompt }],
                                                })
                                                .then(() => {
                                                  showToast({
                                                    title: "Incremental Parse Started",
                                                    description: `Started parsing ${articleIds.length} article(s)`,
                                                    variant: "success",
                                                  })
                                                })
                                                .catch((error) => {
                                                  console.error("Failed to start incremental parse:", error)
                                                  showToast({
                                                    title: "Parse Start Failed",
                                                    description:
                                                      error instanceof Error ? error.message : "Failed to start incremental parse",
                                                    variant: "error",
                                                  })
                                                })
                                            }}
                                          />
                                        ))
                                      }
                                    }
                                    if (errorCount > 0) {
                                      showToast({
                                        title: "Some Articles Failed",
                                        description: `Failed to add ${errorCount} article(s)`,
                                        variant: "error",
                                      })
                                    }
                                  }}
                                  onClose={() => {
                                    dialog.close()
                                  }}
                                />
                              ))
                            }}
                          />
                        </div>
                      </Show>
                      <FileTree
                        path=""
                        class="pt-3"
                        modified={diffFiles()}
                        kinds={kinds()}
                        onFileClick={(node) => openTab(file.tab(node.path))}
                      />
                    </Match>
                  </Switch>
                </Tabs.Content>
              </Tabs>
            </div>
            <Show when={fileOpen()}>
              <div onPointerDown={() => props.size.start()}>
                <ResizeHandle
                  direction="horizontal"
                  edge="start"
                  size={layout.fileTree.width()}
                  min={200}
                  max={480}
                  collapseThreshold={160}
                  onResize={(width) => {
                    props.size.touch()
                    layout.fileTree.resize(width)
                  }}
                  onCollapse={layout.fileTree.close}
                />
              </div>
            </Show>
          </div>
        </div>
      </aside>
    </Show>
  )
}
