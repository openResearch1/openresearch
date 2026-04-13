import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { showToast } from "@opencode-ai/ui/toast"
import { DialogPathPicker } from "./dialog-new-research-project"

interface DialogCloneProjectProps {
  onSelect?: (directory: string) => void
}

/** Extract a project name from a git URL like "git@github.com:user/my-repo.git" */
function projectNameFromUrl(gitUrl: string): string {
  // Handle various URL formats
  const cleaned = gitUrl
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
  const lastSlash = cleaned.lastIndexOf("/")
  const lastColon = cleaned.lastIndexOf(":")
  const sep = Math.max(lastSlash, lastColon)
  return sep >= 0 ? cleaned.slice(sep + 1) : cleaned
}

export function DialogCloneProject(props: DialogCloneProjectProps) {
  const dialog = useDialog()
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const language = useLanguage()

  const [url, setUrl] = createSignal("")
  const [projectName, setProjectName] = createSignal("")
  const [parentDir, setParentDir] = createSignal(sync.data.path.home || "")
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [picker, setPicker] = createSignal(false)
  const [nameManuallyEdited, setNameManuallyEdited] = createSignal(false)

  let isMounted = true
  onCleanup(() => {
    isMounted = false
  })

  // Auto-fill project name when URL changes (unless manually edited)
  createEffect(() => {
    const gitUrl = url()
    if (gitUrl && !nameManuallyEdited()) {
      const name = projectNameFromUrl(gitUrl)
      if (name) setProjectName(name)
    }
  })

  const targetDirectory = createMemo(() => {
    const parent = parentDir().trim()
    const name = projectName().trim()
    if (!parent || !name) return ""
    const sep = parent.endsWith("/") ? "" : "/"
    return `${parent}${sep}${name}`
  })

  const canSubmit = () => {
    return url().trim() && projectName().trim() && parentDir().trim() && !loading()
  }

  async function handleClone() {
    if (!canSubmit()) return

    const gitUrl = url().trim()
    const directory = targetDirectory()

    setLoading(true)
    setError(undefined)

    try {
      const res = await sdk.client.sync.clone({ url: gitUrl, body_directory: directory })

      if (!isMounted) return

      if (res.data?.ok) {
        showToast({
          title: language.t("research.clone.success"),
          description: res.data.message,
          variant: "success",
        })
        dialog.close()
        if (props.onSelect) {
          props.onSelect(res.data.directory || directory)
        }
      } else {
        setError(res.data?.message ?? language.t("research.clone.error"))
        setLoading(false)
      }
    } catch {
      if (!isMounted) return
      setError(language.t("research.clone.failed"))
      setLoading(false)
    }
  }

  return (
    <>
      <Dialog title={language.t("research.clone.title")} fit class="w-full max-w-[640px] mx-auto">
        <div class="flex flex-col gap-5 px-6 pb-6 pt-1">
          <div class="bg-surface-raised-base rounded-lg px-4">
            {/* Repository URL */}
            <div class="py-3 border-b border-border-weak-base">
              <TextField
                autofocus
                label={language.t("research.clone.url.label")}
                placeholder="git@github.com:user/repo.git"
                value={url()}
                onChange={setUrl}
              />
            </div>

            {/* Project name */}
            <div class="py-3 border-b border-border-weak-base">
              <TextField
                label={language.t("research.clone.name.label")}
                placeholder={language.t("research.clone.name.placeholder")}
                value={projectName()}
                onChange={(v) => {
                  setProjectName(v)
                  setNameManuallyEdited(true)
                }}
              />
            </div>

            {/* Parent directory selector */}
            <div class="py-3">
              <label class="text-12-medium text-text-weak mb-1.5 block">
                {language.t("research.clone.location.label")}
              </label>
              <div class="flex items-center gap-2">
                <TextField
                  value={parentDir()}
                  placeholder={language.t("research.clone.location.placeholder")}
                  onChange={setParentDir}
                  class="flex-1"
                />
                <IconButton icon="folder" variant="ghost" onClick={() => setPicker(true)} />
              </div>
            </div>
          </div>

          {/* Target path preview */}
          <Show when={targetDirectory()}>
            <div class="px-3 py-2 rounded-lg bg-surface-raised-base text-12-regular text-text-weak break-all">
              {language.t("research.clone.target.preview")} <span class="text-text-base">{targetDirectory()}</span>
            </div>
          </Show>

          <Show when={error()}>
            <div class="flex items-start gap-2 px-3 py-2 rounded-lg bg-error-base/10 text-error-base">
              <span class="text-12-regular">{error()}</span>
            </div>
          </Show>
        </div>

        <div class="flex items-center justify-end gap-2 px-6 pb-6">
          <Button variant="secondary" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={handleClone} disabled={!canSubmit()} loading={loading()}>
            {language.t("research.clone.button")}
          </Button>
        </div>
      </Dialog>

      <Show when={picker()}>
        <DialogPathPicker
          title={language.t("research.clone.location.picker")}
          mode="directories"
          onSelect={(value) => {
            setParentDir(Array.isArray(value) ? value[0] : value)
            setPicker(false)
          }}
          onClose={() => setPicker(false)}
        />
      </Show>
    </>
  )
}
