import type { FileContent } from "@opencode-ai/sdk/v2"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  type JSX,
} from "solid-js"
import { useI18n } from "../context/i18n"
import {
  dataUrlFromMediaValue,
  hasMediaValue,
  isBinaryContent,
  markdownTextFromValue,
  mediaKindFromPath,
  normalizeMimeType,
  svgTextFromValue,
} from "../pierre/media"
import { Button } from "./button"
import { Markdown } from "./markdown"

export type FileMediaOptions = {
  mode?: "auto" | "off"
  path?: string
  current?: unknown
  before?: unknown
  after?: unknown
  readFile?: (path: string) => Promise<FileContent | undefined>
  onSave?: (content: string) => Promise<void>
  onLoad?: () => void
  onError?: (ctx: { kind: "image" | "audio" | "svg" }) => void
}

function mediaValue(cfg: FileMediaOptions, mode: "image" | "audio") {
  if (cfg.current !== undefined) return cfg.current
  if (mode === "image") return cfg.after ?? cfg.before
  return cfg.after ?? cfg.before
}

export function FileMedia(props: { media?: FileMediaOptions; fallback: () => JSX.Element }) {
  let editorEl: HTMLTextAreaElement | undefined
  let previewEl: HTMLDivElement | undefined
  let syncing = false
  const i18n = useI18n()
  const cfg = () => props.media
  const [editing, setEditing] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [value, setValue] = createSignal<string>()
  const kind = createMemo(() => {
    const media = cfg()
    if (!media || media.mode === "off") return
    return mediaKindFromPath(media.path)
  })

  const isBinary = createMemo(() => {
    const media = cfg()
    if (!media || media.mode === "off") return false
    if (kind()) return false
    return isBinaryContent(media.current as any)
  })

  const onLoad = () => props.media?.onLoad?.()

  const deleted = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || !k) return false
    if (k === "svg") return false
    if (media.current !== undefined) return false
    return !hasMediaValue(media.after as any) && hasMediaValue(media.before as any)
  })

  const direct = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || (k !== "image" && k !== "audio")) return
    return dataUrlFromMediaValue(mediaValue(media, k), k)
  })

  const request = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || (k !== "image" && k !== "audio")) return
    if (media.current !== undefined) return
    if (deleted()) return
    if (direct()) return
    if (!media.path || !media.readFile) return

    return {
      key: `${k}:${media.path}`,
      kind: k,
      path: media.path,
      readFile: media.readFile,
      onError: media.onError,
    }
  })

  const [loaded] = createResource(request, async (input) => {
    return input.readFile(input.path).then(
      (result) => {
        const src = dataUrlFromMediaValue(result as any, input.kind)
        if (!src) {
          input.onError?.({ kind: input.kind })
          return { key: input.key, error: true as const }
        }

        return {
          key: input.key,
          src,
          mime: input.kind === "audio" ? normalizeMimeType(result?.mimeType) : undefined,
        }
      },
      () => {
        input.onError?.({ kind: input.kind })
        return { key: input.key, error: true as const }
      },
    )
  })

  const remote = createMemo(() => {
    const input = request()
    const value = loaded()
    if (!input || !value || value.key !== input.key) return
    return value
  })

  const src = createMemo(() => {
    const value = remote()
    return direct() ?? (value && "src" in value ? value.src : undefined)
  })
  const status = createMemo(() => {
    if (direct()) return "ready" as const
    if (!request()) return "idle" as const
    if (loaded.loading) return "loading" as const
    if (remote()?.error) return "error" as const
    if (src()) return "ready" as const
    return "idle" as const
  })
  const audioMime = createMemo(() => {
    const value = remote()
    return value && "mime" in value ? value.mime : undefined
  })

  const svgSource = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "svg") return
    return svgTextFromValue(media.current as any)
  })
  const svgSrc = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "svg") return
    return dataUrlFromMediaValue(media.current as any, "svg")
  })
  const svgInvalid = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "svg") return
    if (svgSource() !== undefined) return
    if (!hasMediaValue(media.current as any)) return
    return [media.path, media.current] as const
  })

  const markdownValue = createMemo(() => {
    const media = cfg()
    if (!media) return
    return markdownTextFromValue(media.current ?? media.after ?? media.before)
  })

  createEffect(
    on(
      markdownValue,
      (next) => {
        if (next === undefined) return
        setValue(next)
        if (!editing()) setDraft(next)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      svgInvalid,
      (value) => {
        if (!value) return
        cfg()?.onError?.({ kind: "svg" })
      },
      { defer: true },
    ),
  )

  function base64ToBlob(dataUrl: string): string | undefined {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) return
    const [, mime, b64] = match
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return URL.createObjectURL(new Blob([bytes], { type: mime }))
  }

  const pdfDataUrl = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "pdf") return
    return dataUrlFromMediaValue(media.current as any, "pdf")
  })

  const pdfRequest = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "pdf") return
    if (media.current !== undefined) return
    if (!media.path || !media.readFile) return
    return { key: `pdf:${media.path}`, path: media.path, readFile: media.readFile }
  })

  const [pdfLoaded] = createResource(pdfRequest, async (input) => {
    return input.readFile(input.path).then(
      (result) => {
        const src = dataUrlFromMediaValue(result as any, "pdf")
        if (!src) return { key: input.key, error: true as const }
        return { key: input.key, src }
      },
      () => ({ key: input.key, error: true as const }),
    )
  })

  const pdfUrl = createMemo<string | undefined>((prev) => {
    if (prev) URL.revokeObjectURL(prev)

    const dataUrl = pdfDataUrl()
    if (!dataUrl) {
      const req = pdfRequest()
      const val = pdfLoaded()
      if (!req || !val || val.key !== req.key) return
      if (!("src" in val)) return
      return base64ToBlob(val.src)
    }
    return base64ToBlob(dataUrl)
  })

  onCleanup(() => {
    const url = pdfUrl()
    if (url) URL.revokeObjectURL(url)
  })

  const kindLabel = (value: "image" | "audio") =>
    i18n.t(value === "image" ? "ui.fileMedia.kind.image" : "ui.fileMedia.kind.audio")

  const syncScroll = (from?: HTMLElement, to?: HTMLElement) => {
    if (!from || !to || syncing) return

    const maxFrom = Math.max(0, from.scrollHeight - from.clientHeight)
    const maxTo = Math.max(0, to.scrollHeight - to.clientHeight)
    const ratio = maxFrom > 0 ? from.scrollTop / maxFrom : 0

    syncing = true
    to.scrollTop = ratio * maxTo
    requestAnimationFrame(() => {
      syncing = false
    })
  }

  createEffect(
    on(
      () => [draft(), editing()] as const,
      ([, open]) => {
        if (!open) return
        requestAnimationFrame(() => syncScroll(editorEl, previewEl))
      },
      { defer: true },
    ),
  )

  return (
    <Switch>
      <Match when={kind() === "image" || kind() === "audio"}>
        <Show
          when={src()}
          fallback={(() => {
            const media = cfg()
            const k = kind()
            if (!media || (k !== "image" && k !== "audio")) return props.fallback()
            const label = kindLabel(k)

            if (deleted()) {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.removed", { kind: label })}
                </div>
              )
            }
            if (status() === "loading") {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.loading", { kind: label })}
                </div>
              )
            }
            if (status() === "error") {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.error", { kind: label })}
                </div>
              )
            }
            return (
              <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                {i18n.t("ui.fileMedia.state.unavailable", { kind: label })}
              </div>
            )
          })()}
        >
          {(value) => {
            const k = kind()
            if (k !== "image" && k !== "audio") return props.fallback()
            if (k === "image") {
              return (
                <div class="flex justify-center bg-background-stronger px-6 py-4">
                  <img
                    src={value()}
                    alt={cfg()?.path}
                    class="max-h-[60vh] max-w-full rounded border border-border-weak-base bg-background-base object-contain"
                    onLoad={onLoad}
                  />
                </div>
              )
            }

            return (
              <div class="flex justify-center bg-background-stronger px-6 py-4">
                <audio class="w-full max-w-xl" controls preload="metadata" onLoadedMetadata={onLoad}>
                  <source src={value()} type={audioMime()} />
                </audio>
              </div>
            )
          }}
        </Show>
      </Match>
      <Match when={kind() === "svg"}>
        {(() => {
          if (svgSource() === undefined && svgSrc() == null) return props.fallback()

          return (
            <div class="flex flex-col gap-4 px-6 py-4">
              <Show when={svgSource() !== undefined}>{props.fallback()}</Show>
              <Show when={svgSrc()}>
                {(value) => (
                  <div class="flex justify-center">
                    <img
                      src={value()}
                      alt={cfg()?.path}
                      class="max-h-[60vh] max-w-full rounded border border-border-weak-base bg-background-base object-contain"
                      onLoad={onLoad}
                    />
                  </div>
                )}
              </Show>
            </div>
          )
        })()}
      </Match>
      <Match when={kind() === "pdf"}>
        <Show
          when={pdfUrl()}
          fallback={
            <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
              {pdfLoaded.loading ? "Loading PDF…" : "PDF unavailable"}
            </div>
          }
        >
          {(url) => (
            <div class="h-[calc(100vh-4rem)] w-full">
              <object data={url()} type="application/pdf" class="h-full w-full border-0" onLoad={onLoad}>
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  PDF preview not supported in this browser
                </div>
              </object>
            </div>
          )}
        </Show>
      </Match>
      <Match when={kind() === "markdown"}>
        {(() => {
          const media = cfg()
          if (!media) return props.fallback()
          const text = value() ?? markdownValue()
          if (text === undefined) return props.fallback()
          const editable = !!media.onSave && !!media.path
          const edit = () => {
            setValue(text)
            setDraft(text)
            setEditing(true)
          }
          const cancel = () => {
            setDraft(text)
            setEditing(false)
          }
          const save = async () => {
            const next = draft()
            if (!editable || next === text || saving()) {
              cancel()
              return
            }

            setSaving(true)
            try {
              await media.onSave?.(next)
              setValue(next)
              setEditing(false)
            } finally {
              setSaving(false)
            }
          }

          return (
            <div class="flex flex-col gap-3 px-6 py-4 overflow-auto" data-component="file-markdown-preview">
              <Show when={editable}>
                <div class="flex items-center justify-end gap-2">
                  <Show
                    when={editing()}
                    fallback={
                      <Button size="small" variant="secondary" onClick={edit}>
                        {i18n.t("ui.messagePart.title.edit")}
                      </Button>
                    }
                  >
                    <Button size="small" variant="ghost" onClick={cancel} disabled={saving()}>
                      {i18n.t("ui.common.cancel")}
                    </Button>
                    <Button size="small" variant="primary" onClick={save} disabled={saving()}>
                      {i18n.t("ui.common.save")}
                    </Button>
                  </Show>
                </div>
              </Show>
              <Show when={editing()} fallback={<Markdown text={text} />}>
                <div class="grid min-h-[24rem] grid-cols-1 gap-3 lg:grid-cols-2">
                  <div class="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border-weak-base bg-background-base">
                    <div class="border-b border-border-weak-base px-3 py-2 text-12-medium text-text-weak">Markdown</div>
                    <div class="min-h-0 flex-1">
                      <textarea
                        ref={editorEl}
                        value={draft()}
                        class="min-h-[24rem] h-full w-full resize-none border-0 bg-transparent px-3 py-2 font-mono text-sm leading-6 text-text-base outline-none"
                        onInput={(event: InputEvent & { currentTarget: HTMLTextAreaElement }) => {
                          setDraft(event.currentTarget.value)
                          syncScroll(event.currentTarget, previewEl)
                        }}
                        onScroll={(event) => syncScroll(event.currentTarget, previewEl)}
                        onKeyDown={(event: KeyboardEvent) => {
                          if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                            event.preventDefault()
                            void save()
                          }
                        }}
                      />
                    </div>
                  </div>
                  <div class="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border-weak-base bg-background-base">
                    <div class="border-b border-border-weak-base px-3 py-2 text-12-medium text-text-weak">Preview</div>
                    <div
                      ref={previewEl}
                      class="min-h-[24rem] overflow-auto px-3 py-2"
                      onScroll={(event) => syncScroll(event.currentTarget, editorEl)}
                    >
                      <Markdown text={draft()} />
                    </div>
                  </div>
                </div>
              </Show>
            </div>
          )
        })()}
      </Match>
      <Match when={isBinary()}>
        <div class="flex min-h-56 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <div class="text-14-semibold text-text-strong">
            {cfg()?.path?.split("/").pop() ?? i18n.t("ui.fileMedia.binary.title")}
          </div>
          <div class="text-14-regular text-text-weak">
            {(() => {
              const path = cfg()?.path
              if (!path) return i18n.t("ui.fileMedia.binary.description.default")
              return i18n.t("ui.fileMedia.binary.description.path", { path })
            })()}
          </div>
        </div>
      </Match>
      <Match when={true}>{props.fallback()}</Match>
    </Switch>
  )
}
