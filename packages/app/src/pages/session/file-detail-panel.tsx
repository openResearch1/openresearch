import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useFile } from "@/context/file"
import { useSDK } from "@/context/sdk"
import { Markdown } from "@opencode-ai/ui/markdown"

export function FileDetailPanel(props: { path: string; title: string; onClose: () => void; leftOffset?: number }) {
  const file = useFile()
  const sdk = useSDK()
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [saving, setSaving] = createSignal(false)

  let editorEl: HTMLTextAreaElement | undefined
  let previewEl: HTMLDivElement | undefined

  // Load & watch file
  createEffect(() => {
    const path = props.path
    if (!path) return
    file.load(path).catch(console.error)
    let mounted = true
    const unsub = sdk.event.on("file.watcher.updated" as any, (event: { file: string; event: string }) => {
      if (!mounted) return
      if (
        (event.file === path || event.file.endsWith(path) || path.endsWith(event.file)) &&
        (event.event === "change" || event.event === "add")
      ) {
        file.load(path, { force: true }).catch(console.error)
      }
    })
    onCleanup(() => {
      mounted = false
      unsub()
    })
  })

  const content = createMemo(() => {
    const path = props.path
    if (!path) return null
    return file.get(path)?.content?.content ?? null
  })

  const startEdit = () => {
    setDraft(content() ?? "")
    setEditing(true)
  }

  const cancelEdit = () => {
    setDraft("")
    setEditing(false)
  }

  const save = async () => {
    if (saving()) return
    const text = draft()
    const current = content()
    if (text === current) {
      cancelEdit()
      return
    }
    setSaving(true)
    try {
      await file.save(props.path, text)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault()
      void save()
    }
    if (e.key === "Escape") {
      e.preventDefault()
      if (editing()) cancelEdit()
      else props.onClose()
    }
  }

  const syncScroll = (source: HTMLElement, target?: HTMLElement) => {
    if (!target) return
    const ratio = source.scrollTop / (source.scrollHeight - source.clientHeight || 1)
    target.scrollTop = ratio * (target.scrollHeight - target.clientHeight || 1)
  }

  return (
    <div
      class="absolute bg-background-base flex flex-col"
      style={{
        top: "0",
        right: "0",
        bottom: "0",
        left: `${props.leftOffset ?? 0}px`,
        "z-index": "10",
        animation: "file-detail-slide-in 200ms cubic-bezier(0.4, 0, 0.2, 1) forwards",
      }}
      onKeyDown={handleKeyDown}
    >
      <style>{`
        @keyframes file-detail-slide-in {
          from { opacity: 0; transform: translateX(40px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>

      {/* Header */}
      <div class="flex items-center justify-between px-4 py-2.5 border-b border-border-base shrink-0">
        <div class="flex items-center gap-2 min-w-0">
          <button
            onClick={props.onClose}
            class="flex items-center justify-center w-7 h-7 rounded-md bg-transparent text-text-weak cursor-pointer hover:text-text-base hover:bg-background-stronger transition-colors shrink-0"
            title="Back"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span class="text-sm font-semibold text-text-base truncate">{props.title}</span>
          <span class="text-[11px] text-text-weakest truncate">{props.path}</span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <Show
            when={editing()}
            fallback={
              <button
                onClick={startEdit}
                class="px-3 py-1 rounded border border-border-base bg-transparent text-text-weak text-xs cursor-pointer hover:text-text-base hover:bg-background-stronger transition-colors"
              >
                Edit
              </button>
            }
          >
            <button
              onClick={cancelEdit}
              disabled={saving()}
              class="px-3 py-1 rounded border border-border-base bg-transparent text-text-weak text-xs cursor-pointer hover:text-text-base transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving()}
              class="px-3 py-1 rounded border border-accent-base bg-accent-base/10 text-accent-base text-xs cursor-pointer hover:bg-accent-base/20 transition-colors"
              style={{ opacity: saving() ? "0.6" : "1" }}
            >
              {saving() ? "Saving..." : "Save"}
            </button>
          </Show>
        </div>
      </div>

      {/* Content */}
      <div class="flex-1 min-h-0 overflow-hidden">
        <Show
          when={editing()}
          fallback={
            <div class="h-full overflow-y-auto p-6">
              <Show when={content()} fallback={<div class="text-xs text-text-weakest">No content</div>}>
                {(text) => <Markdown text={text()} class="text-12-regular" />}
              </Show>
            </div>
          }
        >
          <div class="h-full grid grid-cols-2 gap-0">
            {/* Editor */}
            <div class="flex flex-col min-h-0 border-r border-border-base">
              <div class="border-b border-border-base px-3 py-1.5 text-[11px] font-medium text-text-weak uppercase tracking-wider shrink-0">
                Markdown
              </div>
              <div class="flex-1 min-h-0">
                <textarea
                  ref={editorEl}
                  value={draft()}
                  class="h-full w-full resize-none border-0 bg-transparent px-4 py-3 font-mono text-sm leading-6 text-text-base outline-none"
                  onInput={(e) => {
                    setDraft(e.currentTarget.value)
                    syncScroll(e.currentTarget, previewEl)
                  }}
                  onScroll={(e) => syncScroll(e.currentTarget, previewEl)}
                  onKeyDown={(e: KeyboardEvent) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                      e.preventDefault()
                      void save()
                    }
                  }}
                />
              </div>
            </div>
            {/* Preview */}
            <div class="flex flex-col min-h-0">
              <div class="border-b border-border-base px-3 py-1.5 text-[11px] font-medium text-text-weak uppercase tracking-wider shrink-0">
                Preview
              </div>
              <div
                ref={previewEl}
                class="flex-1 min-h-0 overflow-y-auto px-4 py-3"
                onScroll={(e) => syncScroll(e.currentTarget, editorEl)}
              >
                <Markdown text={draft()} class="text-12-regular" />
              </div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}
