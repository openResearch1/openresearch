import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useSessionID } from "@/context/session-id"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { useData } from "@opencode-ai/ui/context"
import { PromptInput } from "@/components/prompt-input"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { getSessionHandoff, setSessionHandoff } from "@/pages/session/handoff"
import { SessionPermissionDock } from "@/pages/session/composer/session-permission-dock"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import type { SessionComposerState } from "@/pages/session/composer/session-composer-state"
import { SessionTodoDock } from "@/pages/session/composer/session-todo-dock"
import { SessionWorkflowDock } from "@/pages/session/composer/session-workflow-dock"
import { SessionCollabPopover } from "@/pages/session/composer/session-collab-popover"
import type { CollabActivity } from "@/pages/session/composer/session-collab-activity"
import type { SessionResearch } from "@/pages/session/session-research"

export function SessionComposerRegion(props: {
  compact?: boolean
  state: SessionComposerState
  collabActivity: CollabActivity
  research: SessionResearch
  kind?: "controller" | "main" | "atom" | "experiment"
  ready: boolean
  centered: boolean
  inputRef: (el: HTMLDivElement) => void
  newSessionWorktree: string
  onNewSessionWorktreeReset: () => void
  onSubmit: () => void
  onResponseSubmit: () => void
  setPromptDockRef: (el: HTMLDivElement) => void
  visualDuration?: number
  bounce?: number
  dockOpenVisualDuration?: number
  dockOpenBounce?: number
  dockCloseVisualDuration?: number
  dockCloseBounce?: number
  drawerExpandVisualDuration?: number
  drawerExpandBounce?: number
  drawerCollapseVisualDuration?: number
  drawerCollapseBounce?: number
  subtitleDuration?: number
  subtitleTravel?: number
  subtitleEdge?: number
  countDuration?: number
  countMask?: number
  countMaskHeight?: number
  countWidthDuration?: number
}) {
  const params = useSessionID()
  const prompt = usePrompt()
  const language = useLanguage()
  const navigate = useNavigate()
  const data = useData()

  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const handoffPrompt = createMemo(() => getSessionHandoff(sessionKey())?.prompt)
  const openSession = (id: string) => {
    if (data.navigateToSession) return data.navigateToSession(id)
    navigate(`/${params.dir}/session/${id}`)
  }
  const collab = () => (
    <Show when={params.id}>
      <SessionCollabPopover
        activity={props.collabActivity}
        title={language.t("session.collab.title")}
        openLabel={language.t("session.collab.open")}
        runningLabel={language.t("session.collab.running")}
        blockedLabel={language.t("session.collab.blocked")}
        pendingLabel={language.t("session.collab.pending")}
        emptyLabel={language.t("session.collab.empty")}
        emptyActiveLabel={language.t("session.collab.emptyActive")}
        showCompletedLabel={language.t("session.collab.showCompleted")}
        hideCompletedLabel={language.t("session.collab.hideCompleted")}
        onOpenAgent={(agent) => openSession(agent.session_id)}
      />
    </Show>
  )

  const previewPrompt = () =>
    prompt
      .current()
      .map((part) => {
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        if (part.type === "terminal") return `@terminal:${part.title}`
        if (part.type === "image") return `[image:${part.filename}]`
        return part.content
      })
      .join("")
      .trim()

  createEffect(() => {
    if (!prompt.ready()) return
    setSessionHandoff(sessionKey(), { prompt: previewPrompt() })
  })

  const open = createMemo(() => props.ready && props.state.dock() && !props.state.closing())
  const config = createMemo(() =>
    open()
      ? {
          visualDuration: props.dockOpenVisualDuration ?? props.visualDuration ?? 0.3,
          bounce: props.dockOpenBounce ?? props.bounce ?? 0,
        }
      : {
          visualDuration: props.dockCloseVisualDuration ?? props.visualDuration ?? 0.3,
          bounce: props.dockCloseBounce ?? props.bounce ?? 0,
        },
  )
  const progress = useSpring(() => (open() ? 1 : 0), config)
  const value = createMemo(() => Math.max(0, Math.min(1, progress())))
  const [height, setHeight] = createSignal(320)
  const dock = createMemo(() => (props.ready && props.state.dock()) || value() > 0.001)
  const full = createMemo(() => Math.max(78, height()))
  const [contentRef, setContentRef] = createSignal<HTMLDivElement>()

  createEffect(() => {
    const el = contentRef()
    if (!el) return
    const update = () => {
      setHeight(el.getBoundingClientRect().height)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  })

  return (
    <div
      ref={props.setPromptDockRef}
      data-component="session-prompt-dock"
      classList={{
        "shrink-0 w-full flex flex-col justify-center items-center bg-background-stronger pointer-events-none": true,
        "pb-3": !props.compact,
        "pb-2": !!props.compact,
      }}
    >
      <div
        data-slot="session-composer-content"
        classList={{
          "w-full pointer-events-auto": true,
          "px-3": !props.compact,
          "px-2.5": !!props.compact,
          "md:max-w-[1000px] md:mx-auto": props.centered,
        }}
      >
        <Show when={props.state.questionRequest()} keyed>
          {(request) => (
            <div>
              <SessionQuestionDock request={request} onSubmit={props.onResponseSubmit} />
            </div>
          )}
        </Show>

        <Show when={props.state.permissionRequest()} keyed>
          {(request) => (
            <div>
              <SessionPermissionDock
                request={request}
                responding={props.state.permissionResponding()}
                onDecide={(response) => {
                  props.onResponseSubmit()
                  props.state.decide(response)
                }}
              />
            </div>
          )}
        </Show>

        <Show when={!props.state.blocked()}>
          <Show
            when={prompt.ready()}
            fallback={
              <div class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none">
                {handoffPrompt() || language.t("prompt.loading")}
              </div>
            }
          >
            <Show when={dock()}>
              <div
                classList={{
                  "overflow-hidden": value() < 0.98,
                  "pointer-events-none": value() < 0.98,
                }}
                style={{
                  "max-height": value() >= 0.98 ? "none" : `${full() * value()}px`,
                }}
              >
                <div ref={setContentRef} class="pb-9">
                  <Show when={props.state.workflow()} keyed>
                    {(workflow) => (
                      <div class="mb-3">
                        <SessionWorkflowDock
                          workflow={workflow}
                          title={language.t("session.workflow.title")}
                          collapseLabel={language.t("session.workflow.collapse")}
                          expandLabel={language.t("session.workflow.expand")}
                          stepLabel={language.t("session.workflow.step")}
                          waitingLabel={language.t("session.workflow.waiting")}
                          runningLabel={language.t("session.workflow.running")}
                          completedLabel={language.t("session.workflow.completed")}
                          failedLabel={language.t("session.workflow.failed")}
                          failedManualLabel={language.t("session.workflow.failedManual")}
                          failedAutoLabel={language.t("session.workflow.failedAuto")}
                          cancelledLabel={language.t("session.workflow.cancelled")}
                        />
                      </div>
                    )}
                  </Show>
                  <Show when={props.state.todos().length > 0}>
                    <SessionTodoDock
                      todos={props.state.todos()}
                      title={language.t("session.todo.title")}
                      collapseLabel={language.t("session.todo.collapse")}
                      expandLabel={language.t("session.todo.expand")}
                      dockProgress={value()}
                      visualDuration={props.visualDuration}
                      bounce={props.bounce}
                      expandVisualDuration={props.drawerExpandVisualDuration}
                      expandBounce={props.drawerExpandBounce}
                      collapseVisualDuration={props.drawerCollapseVisualDuration}
                      collapseBounce={props.drawerCollapseBounce}
                      subtitleDuration={props.subtitleDuration}
                      subtitleTravel={props.subtitleTravel}
                      subtitleEdge={props.subtitleEdge}
                      countDuration={props.countDuration}
                      countMask={props.countMask}
                      countMaskHeight={props.countMaskHeight}
                      countWidthDuration={props.countWidthDuration}
                    />
                  </Show>
                </div>
              </div>
            </Show>
            <Show when={props.collabActivity.ready() && props.research.ready()}>
              <Show
                when={!props.collabActivity.controlled()}
                fallback={
                  <div class="relative z-10 rounded-md border border-border-base bg-background-base px-3 py-2.5 text-13-regular text-text-weak flex items-center gap-2">
                    <div class="min-w-0 flex-1">
                      <span class="text-text-strong">
                        Controlled by {props.collabActivity.controller()?.name ?? "parent agent"}.
                      </span>{" "}
                      Direct input is disabled until this task finishes.
                      <Show when={props.collabActivity.controller()} keyed>
                        {(controller) => (
                          <button
                            type="button"
                            class="ml-2 text-text-base underline underline-offset-2"
                            onClick={() => openSession(controller.session_id)}
                          >
                            Open controller
                          </button>
                        )}
                      </Show>
                    </div>
                    {collab()}
                  </div>
                }
              >
                <div
                  classList={{
                    "relative z-10": true,
                  }}
                  style={{
                    "margin-top": `${-36 * value()}px`,
                  }}
                >
                  <PromptInput
                    compact={props.compact}
                    agent={props.collabActivity.controllerRoot() ? "controller" : undefined}
                    research={props.kind === "controller" ? undefined : props.kind}
                    ref={props.inputRef}
                    newSessionWorktree={props.newSessionWorktree}
                    onNewSessionWorktreeReset={props.onNewSessionWorktreeReset}
                    onSubmit={props.onSubmit}
                    actions={collab()}
                  />
                </div>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}
