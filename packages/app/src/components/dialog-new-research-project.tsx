import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { TextField } from "@opencode-ai/ui/text-field"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tag } from "@opencode-ai/ui/tag"
import { getFilename } from "@opencode-ai/util/path"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"

function cleanInput(value: string) {
  const first = (value ?? "").split(/\r?\n/)[0] ?? ""
  return first.replace(/[\u0000-\u001F\u007F]/g, "").trim()
}

function trimTrailing(input: string) {
  const v = input.replace(/\\/g, "/")
  if (!v) return v
  if (v === "/") return v
  return v.replace(/\/+$/, "")
}

function joinPath(base: string, rel: string) {
  const b = trimTrailing(base)
  if (!b) return rel
  if (!rel) return b
  if (rel.startsWith("/")) return rel
  if (b.endsWith("/")) return b + rel
  return `${b}/${rel}`
}

type PickerMode = "files" | "directories"

export type PathPickerProps = {
  title: string
  mode: PickerMode
  multiple?: boolean
  acceptExt?: string[]
  allowDirs?: boolean
  startDir?: () => string | undefined
  onSelect: (value: string | string[]) => void
  onClose: () => void
  validateSelection?: (paths: string[]) => Promise<{ valid: boolean; error?: string }>
}

export function DialogPathPicker(props: PathPickerProps) {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const language = useLanguage()
  const [filter, setFilter] = createSignal("")
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [validationError, setValidationError] = createSignal<string>()
  const [isValidating, setIsValidating] = createSignal(false)

  const home = createMemo(() => props.startDir?.() || sync.data.path.home || sync.data.path.directory || "/")
  const [cwd, setCwd] = createSignal(home())

  const goUp = () => {
    const cur = cwd()
    if (!cur || cur === "/") return
    const parent = cur.replace(/\/[^/]+\/?$/, "") || "/"
    setCwd(parent)
    setFilter("")
  }

  const enterDir = (dirPath: string) => {
    setCwd(dirPath)
    setFilter("")
  }

  type ListItem = { path: string; type: "file" | "directory" }

  const [items, setItems] = createSignal<ListItem[]>([])

  createEffect(() => {
    const base = cwd()
    const q = cleanInput(filter())
    if (!base) {
      setItems([])
      return
    }

    const fetchItems = async () => {
      if (!q) {
        const nodes = await sdk.client.file
          .list({ directory: base, path: "" })
          .then((x) => x.data ?? [])
          .catch(() => [])

        return nodes
          .filter((n) => {
            if (props.mode === "files") return true
            return n.type === "directory"
          })
          .map((n) => ({ path: trimTrailing(n.absolute), type: n.type as "file" | "directory" }))
      }

      if (props.mode === "files" && props.allowDirs) {
        const [files, dirs] = await Promise.all([
          sdk.client.find
            .files({ directory: base, query: q, type: "file", limit: 50 })
            .then((x) => x.data ?? [])
            .catch(() => []),
          sdk.client.find
            .files({ directory: base, query: q, type: "directory", limit: 50 })
            .then((x) => x.data ?? [])
            .catch(() => []),
        ])

        return [
          ...files.map((rel) => ({ path: trimTrailing(joinPath(base, rel)), type: "file" as const })),
          ...dirs.map((rel) => ({ path: trimTrailing(joinPath(base, rel)), type: "directory" as const })),
        ]
      }

      const found = await sdk.client.find
        .files({ directory: base, query: q, type: props.mode === "files" ? "file" : "directory", limit: 50 })
        .then((x) => x.data ?? [])
        .catch(() => [])

      return found.map((rel) => ({
        path: trimTrailing(joinPath(base, rel)),
        type: (props.mode === "files" ? "file" : "directory") as "file" | "directory",
      }))
    }

    fetchItems()
      .then(setItems)
      .catch(() => setItems([]))
  })

  const filtered = createMemo(() => {
    let list = items()

    // Filter hidden files/directories
    list = list.filter((item) => {
      const name = item.path.split("/").pop() || item.path
      return !name.startsWith(".")
    })

    // Filter by search query
    const q = cleanInput(filter()).toLowerCase()
    if (q) {
      list = list.filter((item) => {
        const name = item.path.split("/").pop() || item.path
        return name.toLowerCase().includes(q)
      })
    }

    // Filter by accepted extensions
    if (props.acceptExt && props.mode === "files") {
      const allow = props.acceptExt.map((e) => e.toLowerCase())
      list = list.filter(
        (item) => item.type === "directory" || allow.some((ext) => item.path.toLowerCase().endsWith(ext)),
      )
    }

    return list
  })

  const canPick = (item: ListItem) => {
    if (props.mode === "directories") return item.type === "directory"
    return item.type === "file" || (props.allowDirs && item.type === "directory")
  }

  // 用延时区分单击和双击，避免双击进入目录时误触发选中
  let clickTimer: ReturnType<typeof setTimeout> | null = null

  const handleItemClick = (item: ListItem) => {
    if (clickTimer) {
      clearTimeout(clickTimer)
      clickTimer = null
    }

    clickTimer = setTimeout(() => {
      clickTimer = null

      if (!canPick(item)) {
        if (item.type === "directory") enterDir(item.path)
        return
      }

      if (!props.multiple) {
        setSelected((prev) => {
          const next = new Set<string>()
          if (!prev.has(item.path)) next.add(item.path)
          return next
        })
      } else {
        setSelected((prev) => {
          const next = new Set(prev)
          if (next.has(item.path)) next.delete(item.path)
          else next.add(item.path)
          return next
        })
      }

      setValidationError(undefined)
    }, 200)
  }

  const handleItemDblClick = (item: ListItem) => {
    if (clickTimer) {
      clearTimeout(clickTimer)
      clickTimer = null
    }
    if (item.type === "directory") {
      enterDir(item.path)
    }
  }

  const confirm = async () => {
    const base = Array.from(selected())
    if (base.length === 0) return

    // Validate selection if validator is provided
    if (props.validateSelection) {
      setIsValidating(true)
      try {
        const result = await props.validateSelection(base)
        setIsValidating(false)
        if (!result.valid) {
          setValidationError(result.error || "Invalid selection")
          return
        }
      } catch (error) {
        setIsValidating(false)
        setValidationError("Validation failed")
        return
      }
    }

    props.onSelect(props.multiple ? base : base[0])
    props.onClose()
  }

  const cancel = () => {
    setSelected(new Set<string>())
    setValidationError(undefined)
    props.onClose()
  }

  return (
    <Dialog
      title={props.title}
      action={<IconButton icon="close" variant="ghost" onClick={props.onClose} />}
      class="w-full max-w-[560px] max-h-[60vh] mx-auto flex flex-col"
    >
      <div class="flex flex-col gap-3 p-4 min-h-0 flex-1">
        <div class="flex items-center gap-2 shrink-0">
          <Button variant="ghost" onClick={goUp} disabled={cwd() === "/"} class="shrink-0 px-2">
            <Icon name="arrow-up" size="small" />
          </Button>
          <div class="text-12-regular text-text-weak truncate flex-1">{cwd()}</div>
        </div>

        <div class="shrink-0">
          <TextField
            label={language.t("pathPicker.search")}
            placeholder={language.t("pathPicker.search.placeholder")}
            value={filter()}
            onChange={setFilter}
            autoFocus
          />
        </div>

        <List
          class="flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
          items={filtered}
          key={(item) => item.path}
          emptyMessage={language.t("pathPicker.empty")}
          loadingMessage={language.t("pathPicker.loading")}
          onSelect={(item) => item && handleItemClick(item)}
        >
          {(item) => (
            <div
              class={`w-full flex items-center gap-3 cursor-pointer rounded-md px-2 py-1 transition-colors ${
                selected().has(item.path) ? "bg-surface-weak" : ""
              }`}
              onDblClick={() => handleItemDblClick(item)}
            >
              <FileIcon node={{ path: item.path, type: item.type }} class="shrink-0 size-4" />
              <div class="flex items-center text-14-regular min-w-0 gap-1">
                <span class="text-text-weak truncate">
                  {(() => {
                    const q = cleanInput(filter())
                    if (!q) return getFilename(item.path)
                    const base = cwd()
                    const prefix = base.endsWith("/") ? base : base + "/"
                    return item.path.startsWith(prefix) ? item.path.slice(prefix.length) : getFilename(item.path)
                  })()}
                </span>
                <Show when={item.type === "directory"}>
                  <span class="text-text-weak text-11-regular">/</span>
                </Show>
              </div>
            </div>
          )}
        </List>

        <Show when={validationError()}>
          <div class="text-12-regular text-icon-critical-base px-2">{validationError()}</div>
        </Show>
        <div class="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={cancel}>
            {language.t("pathPicker.cancel")}
          </Button>
          <Button onClick={confirm} disabled={selected().size === 0 || isValidating() || !!validationError()}>
            {isValidating()
              ? language.t("pathPicker.validating")
              : language.t("pathPicker.confirm", { count: String(selected().size) })}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

interface DialogNewResearchProjectProps {
  onSelect: (result: string) => void
}

export function DialogNewResearchProject(props: DialogNewResearchProjectProps) {
  const dialog = useDialog()
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const language = useLanguage()
  const defaultDir = () => sync.data.path.home || sync.data.path.directory || ""

  const [name, setName] = createSignal("research_project_1")
  const [targetDir, setTargetDir] = createSignal(defaultDir())
  const [paperPaths, setPaperPaths] = createSignal<string[]>([])
  const [picker, setPicker] = createSignal<null | "target" | "papers">(null)
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [dragging, setDragging] = createSignal(false)

  // 自动生成不重复的默认项目名
  createEffect(() => {
    const dir = defaultDir()
    if (!dir) return
    setTargetDir(dir)
    sdk.client.file
      .list({ directory: dir, path: "" })
      .then((res) => {
        if (!isMounted) return
        const existing = new Set((res.data ?? []).map((n) => n.name))
        let idx = 1
        while (existing.has(`research_project_${idx}`)) idx++
        setName(`research_project_${idx}`)
      })
      .catch(() => {})
  })

  const canSubmit = createMemo(() => {
    const title = name().trim()
    const target = targetDir().trim()
    const papers = paperPaths()
    return !!title && !!target && papers.length > 0
  })

  let isMounted = true
  onCleanup(() => {
    isMounted = false
  })

  const addPapers = (paths: string[]) => {
    setPaperPaths((prev) => {
      const existing = new Set(prev)
      const newPaths = paths.filter((p) => !existing.has(p))
      return [...prev, ...newPaths]
    })
  }

  const removePaper = (path: string) => {
    setPaperPaths((prev) => prev.filter((p) => p !== path))
  }

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(true)
  }

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(false)
  }

  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return
    const formData = new FormData()
    for (const file of files) {
      formData.append("files", file)
    }
    const res = await sdk.client.research.upload(undefined, {
      body: formData as unknown,
      bodySerializer: null,
      headers: { "Content-Type": null },
    } as any)
    if (!isMounted) return
    const data = res.data as { paths: string[] } | undefined
    if (!data?.paths?.length) throw new Error(language.t("research.new.upload.failed"))
    addPapers(data.paths)
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(false)

    const dt = e.dataTransfer
    if (!dt?.files?.length) return

    const files = Array.from(dt.files).filter((f) => f.name.toLowerCase().endsWith(".pdf"))
    if (files.length === 0) return
    uploadFiles(files).catch((err) => {
      if (!isMounted) return
      setError(err instanceof Error ? err.message : language.t("research.new.upload.failed"))
    })
  }

  const handlePickPapers = () => {
    setPicker("papers")
  }

  async function handleCreate() {
    if (!canSubmit()) return

    const projectName = name().trim()
    const parentDir = targetDir().trim()
    const fullPath = `${parentDir}/${projectName}`

    const payload = {
      name: projectName,
      targetPath: fullPath,
      papers: paperPaths(),
      backgroundPath: undefined,
      goalPath: undefined,
    }

    const currentTargetDir = fullPath

    setSubmitting(true)
    setError(undefined)

    try {
      const res = await sdk.client.research.project.create(payload)

      if (!isMounted) return

      const projectID = res?.data?.project_id
      const researchID = res?.data?.research_project_id
      if (!projectID || !researchID) throw new Error(language.t("research.new.create.failed"))

      // onSelect triggers dialog.close() which starts unmounting the portal.
      // Do NOT update any signals after this point — the reactive root is
      // still alive for 100ms while Kobalte has already torn down the DOM,
      // so signal writes (e.g. setSubmitting) would re-evaluate stale
      // <Show> accessors and throw.
      props.onSelect(currentTargetDir)
    } catch (err: unknown) {
      if (!isMounted) return
      const message = err instanceof Error ? err.message : language.t("research.new.create.error")
      setError(message)
      setSubmitting(false)
    }
  }

  return (
    <>
      <Dialog title={language.t("research.new.title")} fit class="w-full max-w-[640px] mx-auto">
        <div class="flex flex-col gap-5 px-6 pb-6 pt-1 max-h-[75vh] overflow-y-auto">
          {/* Project info section */}
          <div class="bg-surface-raised-base rounded-lg px-4">
            <div class="py-3 border-b border-border-weak-base">
              <TextField
                label={language.t("research.new.name.label")}
                placeholder={language.t("research.new.name.placeholder")}
                value={name()}
                onChange={setName}
              />
            </div>
            <div class="py-3">
              <label class="text-12-medium text-text-weak mb-1.5 block">
                {language.t("research.new.location.label")}
              </label>
              <div class="flex items-center gap-2">
                <TextField
                  value={targetDir()}
                  placeholder={language.t("research.new.location.placeholder")}
                  onChange={setTargetDir}
                  class="flex-1"
                />
                <Button variant="secondary" onClick={() => setPicker("target")}>
                  {language.t("research.new.location.select")}
                </Button>
              </div>
            </div>
          </div>

          {/* 拖拽上传区域 */}
          <div
            class={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 cursor-pointer transition-all ${
              dragging()
                ? "border-accent-base bg-accent-base/10 scale-[1.01]"
                : "border-border-base bg-surface-inset-base hover:border-accent-base/50 hover:bg-surface-inset-base/80"
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={handlePickPapers}
          >
            <div
              class={`flex items-center justify-center size-10 rounded-lg transition-colors ${
                dragging() ? "bg-accent-base/20 text-accent-base" : "bg-surface-raised-base text-text-weak"
              }`}
            >
              <Icon name="cloud-upload" />
            </div>
            <div class="text-13-regular text-text-weak text-center">
              {(() => {
                const raw = language.t("research.new.drop.hint")
                const match = raw.match(/^(.*)<1>(.*)<\/1>(.*)$/)
                if (!match) return raw
                return (
                  <>
                    {match[1]}
                    <span class="text-accent-base cursor-pointer hover:underline font-medium">{match[2]}</span>
                    {match[3]}
                  </>
                )
              })()}
            </div>
            <div class="text-11-regular text-text-weaker">{language.t("research.new.drop.note")}</div>
          </div>

          {/* 已选论文列表 */}
          <div class="flex flex-col rounded-lg bg-surface-raised-base overflow-hidden">
            <div class="flex items-center justify-between px-4 py-2.5 border-b border-border-weak-base">
              <div class="flex items-center gap-2">
                <Icon name="bullet-list" size="small" class="text-text-weak" />
                <span class="text-12-medium text-text-strong">{language.t("research.new.papers.label")}</span>
              </div>
              <Show when={paperPaths().length > 0}>
                <Tag>{paperPaths().length}</Tag>
              </Show>
            </div>
            <div class="min-h-[100px] max-h-[200px] overflow-y-auto">
              <Show
                when={paperPaths().length > 0}
                fallback={
                  <div class="flex flex-col items-center justify-center gap-1.5 h-full min-h-[100px] py-6">
                    <Icon name="file-tree" class="text-text-weaker" />
                    <span class="text-12-regular text-text-weaker">{language.t("research.new.papers.empty")}</span>
                  </div>
                }
              >
                <div class="flex flex-col px-1 py-1">
                  <For each={paperPaths()}>
                    {(path) => (
                      <div class="flex items-center justify-between gap-2 px-3 py-2 rounded-md hover:bg-surface-strong/40 group transition-colors">
                        <div class="flex items-center gap-2.5 min-w-0">
                          <FileIcon
                            node={{ path, type: path.endsWith(".pdf") ? "file" : "directory" }}
                            class="shrink-0 size-4"
                          />
                          <span class="text-13-regular text-text-base truncate">{path.split("/").pop() || path}</span>
                        </div>
                        <IconButton
                          icon="close-small"
                          variant="ghost"
                          onClick={(e: MouseEvent) => {
                            e.stopPropagation()
                            removePaper(path)
                          }}
                          class="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                        />
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>

          <Show when={error()} keyed>
            {(err) => (
              <div class="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-surface-critical-weak">
                <Icon name="warning" size="small" class="text-icon-critical-base shrink-0" />
                <span class="text-12-regular text-text-strong">{err}</span>
              </div>
            )}
          </Show>

          <div class="flex justify-end gap-2 border-t border-border-weak-base pt-4">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("research.new.cancel")}
            </Button>
            <Button size="large" onClick={handleCreate} disabled={!canSubmit() || submitting()} loading={submitting()}>
              {language.t("research.new.create")}
            </Button>
          </div>
        </div>
      </Dialog>

      <Show when={picker() === "target"}>
        <DialogPathPicker
          title={language.t("research.new.picker.location")}
          mode="directories"
          startDir={() => targetDir() || undefined}
          onSelect={(v) => setTargetDir(Array.isArray(v) ? v[0] : v)}
          onClose={() => setPicker(null)}
        />
      </Show>

      <Show when={picker() === "papers"}>
        <DialogPathPicker
          title={language.t("research.new.picker.papers")}
          mode="files"
          multiple
          acceptExt={[".pdf"]}
          allowDirs
          onSelect={(v) => addPapers(Array.isArray(v) ? v : [v])}
          onClose={() => setPicker(null)}
        />
      </Show>
    </>
  )
}
