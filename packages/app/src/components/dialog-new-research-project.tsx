import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { TextField } from "@opencode-ai/ui/text-field"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { useNavigate } from "@solidjs/router"
import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLayout } from "@/context/layout"
import { useDialog } from "@opencode-ai/ui/context/dialog"

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

  const canPick = (item: ListItem) => item.type === "file" || (props.allowDirs && item.type === "directory")

  const handleItemClick = (item: ListItem) => {
    if (item.type === "directory" && props.mode === "files" && !props.allowDirs) {
      enterDir(item.path)
      return
    }

    if (!canPick(item)) return

    if (!props.multiple) {
      props.onSelect(item.path)
      props.onClose()
      return
    }

    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(item.path)) next.delete(item.path)
      else next.add(item.path)
      return next
    })

    // Clear validation error when selection changes
    setValidationError(undefined)
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
    <Dialog title={props.title} class="w-full max-w-[560px] max-h-[60vh] mx-auto flex flex-col">
      <div class="flex flex-col gap-3 p-4 min-h-0 flex-1">
        <div class="flex items-center gap-2 shrink-0">
          <Button variant="ghost" onClick={goUp} disabled={cwd() === "/"} class="shrink-0 px-2">
            <Icon name="arrow-up" size="small" />
          </Button>
          <div class="text-12-regular text-text-weak truncate flex-1">{cwd()}</div>
        </div>

        <div class="shrink-0">
          <TextField label="搜索" placeholder="输入文件名搜索" value={filter()} onChange={setFilter} autoFocus />
        </div>

        <List
          class="flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
          items={filtered}
          key={(item) => item.path}
          emptyMessage="无匹配结果"
          loadingMessage="加载中..."
          onSelect={(item) => item && handleItemClick(item)}
        >
          {(item) => (
            <div class="flex items-center justify-between rounded-md px-2 py-1 hover:bg-surface-strong/40 cursor-pointer">
              <div class="flex items-center gap-3 min-w-0">
                <FileIcon node={{ path: item.path, type: item.type }} class="shrink-0 size-4" />
                <div class="flex items-center text-14-regular min-w-0 gap-1">
                  <span class="text-text-weak truncate">{getFilename(item.path)}</span>
                  <Show when={item.type === "directory"}>
                    <span class="text-text-weak text-11-regular">/</span>
                  </Show>
                </div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <Show when={item.type === "directory" && props.mode === "files"}>
                  <Button
                    variant="ghost"
                    onClick={(e: MouseEvent) => {
                      e.stopPropagation()
                      enterDir(item.path)
                    }}
                    class="px-2"
                  >
                    进入
                  </Button>
                </Show>
                <Show when={props.multiple && canPick(item)}>
                  <input type="checkbox" class="shrink-0" checked={selected().has(item.path)} />
                </Show>
              </div>
            </div>
          )}
        </List>

        <Show when={props.multiple}>
          <Show when={validationError()}>
            <div class="text-12-regular text-icon-critical-base px-2">{validationError()}</div>
          </Show>
          <div class="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={cancel}>
              取消
            </Button>
            <Button onClick={confirm} disabled={selected().size === 0 || isValidating() || !!validationError()}>
              {isValidating() ? "验证中..." : `确认选择 (${selected().size})`}
            </Button>
          </div>
        </Show>

        <Show when={props.mode === "directories" && !props.multiple}>
          <div class="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={props.onClose}>
              取消
            </Button>
            <Button
              onClick={() => {
                props.onSelect(cwd())
                props.onClose()
              }}
            >
              选择此文件夹
            </Button>
          </div>
        </Show>
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

  const [name, setName] = createSignal("")
  const [targetDir, setTargetDir] = createSignal("")
  const [paperPaths, setPaperPaths] = createSignal<string[]>([])
  const [backgroundPath, setBackgroundPath] = createSignal<string>()
  const [goalPath, setGoalPath] = createSignal<string>()
  const [picker, setPicker] = createSignal<null | "target" | "papers" | "background" | "goal">(null)
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const canSubmit = createMemo(() => {
    const title = name().trim()
    const target = targetDir().trim()
    const papers = paperPaths()
    return !!title && !!target && papers.length > 0
  })

  const reset = () => {
    setName("")
    setTargetDir("")
    setPaperPaths([])
    setBackgroundPath(undefined)
    setGoalPath(undefined)
    setPicker(null)
    setError(undefined)
  }

  let isMounted = true
  onCleanup(() => {
    isMounted = false
  })

  async function handleCreate() {
    if (!canSubmit()) return

    const projectName = name().trim()
    const parentDir = targetDir().trim()
    const fullPath = `${parentDir}/${projectName}`

    const payload = {
      name: projectName,
      targetPath: fullPath,
      papers: paperPaths(),
      backgroundPath: backgroundPath(),
      goalPath: goalPath(),
    }

    // 保存当前的目标路径，避免在异步回调中访问 signal
    const currentTargetDir = fullPath

    setSubmitting(true)
    setError(undefined)

    try {
      const res = await sdk.client.research.project.create(payload)

      if (!isMounted) return

      const projectID = res?.data?.project_id
      const researchID = res?.data?.research_project_id
      if (!projectID || !researchID) throw new Error("创建科研项目失败")

      props.onSelect(currentTargetDir)
    } catch (err: unknown) {
      if (!isMounted) return
      const message = err instanceof Error ? err.message : "创建失败"
      setError(message)
    } finally {
      if (isMounted) {
        setSubmitting(false)
      }
    }
  }

  return (
    <>
      <Dialog title="新建科研项目" class="w-full max-w-[600px] mx-auto">
        <div class="flex flex-col gap-5 p-6 pt-0 max-h-[70vh] overflow-y-auto pr-1">
          <TextField label="科研项目名" placeholder="请输入科研项目名称" value={name()} onChange={setName} />

          <div class="flex flex-col gap-2">
            <label class="text-12-medium text-text-strong">创建位置</label>
            <div class="flex items-center gap-2">
              <TextField
                value={targetDir()}
                placeholder="请输入或选择项目创建位置"
                onChange={setTargetDir}
                class="flex-1"
              />
              <Button variant="ghost" onClick={() => setTargetDir("")}>
                清除
              </Button>
              <Button variant="secondary" onClick={() => setPicker("target")}>
                选择文件夹
              </Button>
            </div>
            <div class="text-12-regular text-text-weak">支持手动输入，也支持搜索文件夹后选择创建位置</div>
          </div>

          <div class="flex flex-col gap-2">
            <label class="text-12-medium text-text-strong">论文源（可多选 PDF 或 LaTeX 文件夹）</label>
            <div class="flex items-center gap-2">
              <TextField value={paperPaths().join(", ") || ""} placeholder="请选择论文源路径" readOnly class="flex-1" />
              <Button variant="ghost" onClick={() => setPaperPaths([])}>
                清除
              </Button>
              <Button variant="secondary" onClick={() => setPicker("papers")}>
                选择文件或文件夹
              </Button>
            </div>
            <div class="text-12-regular text-text-weak">支持一次选择多篇 PDF，或选择 LaTeX 源码文件夹</div>
          </div>

          <div class="flex flex-col gap-2">
            <label class="text-12-medium text-text-strong">科研背景（可选，Markdown）</label>
            <div class="flex items-center gap-2">
              <TextField value={backgroundPath() ?? ""} placeholder="不上传则由 AI 自动生成" readOnly class="flex-1" />
              <Button variant="ghost" onClick={() => setBackgroundPath(undefined)}>
                清除
              </Button>
              <Button variant="secondary" onClick={() => setPicker("background")}>
                选择文件
              </Button>
            </div>
            <div class="text-12-regular text-text-weak">不上传则由 AI 自动生成背景</div>
          </div>

          <div class="flex flex-col gap-2">
            <label class="text-12-medium text-text-strong">科研目标（可选，Markdown）</label>
            <div class="flex items-center gap-2">
              <TextField value={goalPath() ?? ""} placeholder="不上传则由 AI 自动生成" readOnly class="flex-1" />
              <Button variant="ghost" onClick={() => setGoalPath(undefined)}>
                清除
              </Button>
              <Button variant="secondary" onClick={() => setPicker("goal")}>
                选择文件
              </Button>
            </div>
            <div class="text-12-regular text-text-weak">不上传则由 AI 自动生成目标</div>
          </div>

          <Show when={error()} keyed>
            {(err) => <div class="text-12-regular text-icon-critical-strong">{err}</div>}
          </Show>

          <div class="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => dialog.close()}>
              取消
            </Button>
            <Button onClick={handleCreate} disabled={!canSubmit() || submitting()} loading={submitting()}>
              创建
            </Button>
          </div>
        </div>
      </Dialog>

      <Show when={picker() === "target"}>
        <DialogPathPicker
          title="选择创建位置"
          mode="directories"
          startDir={() => targetDir() || undefined}
          onSelect={(v) => setTargetDir(Array.isArray(v) ? v[0] : v)}
          onClose={() => setPicker(null)}
        />
      </Show>

      <Show when={picker() === "papers"}>
        <DialogPathPicker
          title="选择论文源 (PDF 或 LaTeX 文件夹，可多选)"
          mode="files"
          multiple
          acceptExt={[".pdf"]}
          allowDirs
          onSelect={(v) => setPaperPaths(Array.isArray(v) ? v : [v])}
          onClose={() => setPicker(null)}
        />
      </Show>

      <Show when={picker() === "background"}>
        <DialogPathPicker
          title="选择科研背景 (Markdown)"
          mode="files"
          acceptExt={[".md"]}
          onSelect={(v) => setBackgroundPath(Array.isArray(v) ? v[0] : v)}
          onClose={() => setPicker(null)}
        />
      </Show>

      <Show when={picker() === "goal"}>
        <DialogPathPicker
          title="选择科研目标 (Markdown)"
          mode="files"
          acceptExt={[".md"]}
          onSelect={(v) => setGoalPath(Array.isArray(v) ? v[0] : v)}
          onClose={() => setPicker(null)}
        />
      </Show>
    </>
  )
}
