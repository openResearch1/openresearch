import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { TextField } from "@opencode-ai/ui/text-field"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { useNavigate } from "@solidjs/router"
import { Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLayout } from "@/context/layout"
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

type PathPickerProps = {
  title: string
  mode: PickerMode
  multiple?: boolean
  acceptExt?: string[]
  startDir?: () => string | undefined
  onSelect: (value: string | string[]) => void
  onClose: () => void
}

function DialogPathPicker(props: PathPickerProps) {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const language = useLanguage()
  const [filter, setFilter] = createSignal("")
  const [selected, setSelected] = createSignal<Set<string>>(new Set())

  const home = createMemo(() => props.startDir?.() || sync.data.path.home || sync.data.path.directory || "/")
  const [cwd, setCwd] = createSignal("")

  // Initialize cwd from home on first render
  createEffect(() => {
    const h = home()
    if (h && !cwd()) setCwd(h)
  })

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

  const [items] = createResource(
    () => ({ base: cwd(), q: cleanInput(filter()) }),
    async ({ base, q }) => {
      if (!base) return [] as ListItem[]

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

      const found = await sdk.client.find
        .files({ directory: base, query: q, type: props.mode === "files" ? "file" : "directory", limit: 50 })
        .then((x) => x.data ?? [])
        .catch(() => [])

      return found.map((rel) => ({
        path: trimTrailing(joinPath(base, rel)),
        type: (props.mode === "files" ? "file" : "directory") as "file" | "directory",
      }))
    },
  )

  const filtered = createMemo(() => {
    const list = items() ?? []
    if (!props.acceptExt || props.mode !== "files") return list
    const allow = props.acceptExt.map((e) => e.toLowerCase())
    return list.filter(
      (item) => item.type === "directory" || allow.some((ext) => item.path.toLowerCase().endsWith(ext)),
    )
  })

  const handleItemClick = (item: ListItem) => {
    if (item.type === "directory") {
      enterDir(item.path)
      return
    }

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
  }

  const confirm = () => {
    const base = Array.from(selected())
    if (base.length === 0) return
    props.onSelect(props.multiple ? base : base[0])
    props.onClose()
  }

  const cancel = () => {
    setSelected(new Set<string>())
    props.onClose()
  }

  return (
    <Dialog title={props.title} class="w-full max-w-[560px] max-h-[60vh] mx-auto flex flex-col">
      <div class="flex flex-col gap-3 p-4 min-h-0 flex-1">
        <div class="flex items-center gap-2 shrink-0">
          <Button variant="ghost" onClick={goUp} disabled={cwd() === "/"} class="shrink-0 px-2">
            ..
          </Button>
          <div class="text-12-regular text-text-weak truncate flex-1">{cwd()}</div>
        </div>

        <div class="shrink-0">
          <TextField label={language.t("dialog.newProject.form.folderDialog.search.label")} placeholder={language.t("dialog.newProject.form.folderDialog.search.placeholder")} value={filter()} onChange={setFilter} autoFocus />
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
              <Show when={props.multiple && item.type !== "directory"}>
                <input type="checkbox" class="shrink-0" checked={selected().has(item.path)} />
              </Show>
            </div>
          )}
        </List>

        <Show when={props.multiple}>
          <div class="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={cancel}>
              {language.t("dialog.newProject.form.paper.fileDialog.button.cancel")}
            </Button>
            <Button onClick={confirm} disabled={selected().size === 0}>
              {language.t("dialog.newProject.form.paper.fileDialog.button.confirm", { count: selected().size })}
            </Button>
          </div>
        </Show>

        <Show when={props.mode === "directories" && !props.multiple}>
          <div class="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={props.onClose}>
              {language.t("dialog.newProject.form.location.folderDialog.button.cancel")}
            </Button>
            <Button
              onClick={() => {
                props.onSelect(cwd())
                props.onClose()
              }}
            >
              {language.t("dialog.newProject.form.location.folderDialog.button.confirm")}
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
  const language = useLanguage()

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
      <Dialog title={language.t("dialog.newProject.form.title")} class="w-full max-w-[600px] mx-auto">
        <div class="flex flex-col gap-5 p-6 pt-0 max-h-[70vh] overflow-y-auto pr-1">
          <TextField label={language.t("dialog.newProject.form.name.label")} placeholder={language.t("dialog.newProject.form.name.placeholder")} value={name()} onChange={setName} />

          <div class="flex flex-col gap-2">
            <label class="text-12-medium text-text-strong">{language.t("dialog.newProject.form.location.label")}</label>
            <div class="flex items-center gap-2">
              <TextField
                value={targetDir()}
                placeholder={language.t("dialog.newProject.form.location.placeholder")}
                onChange={setTargetDir}
                class="flex-1"
              />
              <Button variant="ghost" onClick={() => setTargetDir("")}>
                {language.t("dialog.newProject.form.location.button.clear")}
              </Button>
              <Button variant="secondary" onClick={() => setPicker("target")}>
                {language.t("dialog.newProject.form.location.button.select")}
              </Button>
            </div>
            <div class="text-12-regular text-text-weak">{language.t("dialog.newProject.form.location.tip")}</div>
          </div>

          <div class="flex flex-col gap-2">
            <label class="text-12-medium text-text-strong">{language.t("dialog.newProject.form.paper.label")}</label>
            <div class="flex items-center gap-2">
              <TextField value={paperPaths().join(", ") || ""} placeholder={language.t("dialog.newProject.form.paper.placeholder")} readOnly class="flex-1" />
              <Button variant="ghost" onClick={() => setPaperPaths([])}>
                {language.t("dialog.newProject.form.paper.button.clear")}
              </Button>
              <Button variant="secondary" onClick={() => setPicker("papers")}>
                {language.t("dialog.newProject.form.paper.button.select")}
              </Button>
            </div>
            <div class="text-12-regular text-text-weak">{language.t("dialog.newProject.form.paper.tip")}</div>
          </div>

          <div class="flex flex-col gap-2">
            <label class="text-12-medium text-text-strong">{language.t("dialog.newProject.form.background.label")}</label>
            <div class="flex items-center gap-2">
              <TextField value={backgroundPath() ?? ""} placeholder={language.t("dialog.newProject.form.background.placeholder")} readOnly class="flex-1" />
              <Button variant="ghost" onClick={() => setBackgroundPath(undefined)}>
                {language.t("dialog.newProject.form.background.button.clear")}
              </Button>
              <Button variant="secondary" onClick={() => setPicker("background")}>
                {language.t("dialog.newProject.form.background.button.select")}
              </Button>
            </div>
            <div class="text-12-regular text-text-weak">{language.t("dialog.newProject.form.background.tip")}</div>
          </div>

          <div class="flex flex-col gap-2">
            <label class="text-12-medium text-text-strong">{language.t("dialog.newProject.form.goal.label")}</label>
            <div class="flex items-center gap-2">
              <TextField value={goalPath() ?? ""} placeholder={language.t("dialog.newProject.form.goal.placeholder")} readOnly class="flex-1" />
              <Button variant="ghost" onClick={() => setGoalPath(undefined)}>
                {language.t("dialog.newProject.form.goal.button.clear")}
              </Button>
              <Button variant="secondary" onClick={() => setPicker("goal")}>
                {language.t("dialog.newProject.form.goal.button.select")}
              </Button>
            </div>
            <div class="text-12-regular text-text-weak">{language.t("dialog.newProject.form.goal.tip")}</div>
          </div>

          <Show when={error()} keyed>
            {(err) => <div class="text-12-regular text-icon-critical-strong">{err}</div>}
          </Show>

          <div class="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => dialog.close()}>
              {language.t("dialog.newProject.form.cancel")}
            </Button>
            <Button onClick={handleCreate} disabled={!canSubmit() || submitting()} loading={submitting()}>
              {language.t("dialog.newProject.form.submit")}
            </Button>
          </div>
        </div>
      </Dialog>

      <Show when={picker() === "target"}>
        <DialogPathPicker
          title={language.t("dialog.newProject.form.location.folderDialog.title")}
          mode="directories"
          startDir={() => targetDir() || undefined}
          onSelect={(v) => setTargetDir(Array.isArray(v) ? v[0] : v)}
          onClose={() => setPicker(null)}
        />
      </Show>

      <Show when={picker() === "papers"}>
        <DialogPathPicker
          title={language.t("dialog.newProject.form.paper.fileDialog.title")}
          mode="files"
          multiple
          acceptExt={[".pdf"]}
          onSelect={(v) => setPaperPaths(Array.isArray(v) ? v : [v])}
          onClose={() => setPicker(null)}
        />
      </Show>

      <Show when={picker() === "background"}>
        <DialogPathPicker
          title={language.t("dialog.newProject.form.background.fileDialog.title")}
          mode="files"
          acceptExt={[".md"]}
          onSelect={(v) => setBackgroundPath(Array.isArray(v) ? v[0] : v)}
          onClose={() => setPicker(null)}
        />
      </Show>

      <Show when={picker() === "goal"}>
        <DialogPathPicker
          title={language.t("dialog.newProject.form.goal.fileDialog.title")}
          mode="files"
          acceptExt={[".md"]}
          onSelect={(v) => setGoalPath(Array.isArray(v) ? v[0] : v)}
          onClose={() => setPicker(null)}
        />
      </Show>
    </>
  )
}
