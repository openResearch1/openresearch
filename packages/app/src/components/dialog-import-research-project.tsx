import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogPathPicker } from "./dialog-new-research-project"
import { getFilename } from "@opencode-ai/util/path"

interface DialogImportResearchProjectProps {
  onSelect: (directory: string) => void
}

/** Extract a project name from a zip filename like "my_project_export_1234567890.zip" */
function projectNameFromZip(zipPath: string): string {
  const filename = getFilename(zipPath) || ""
  // Strip .zip extension
  const base = filename.replace(/\.zip$/i, "")
  // Remove _export_<timestamp> suffix
  return base.replace(/_export_\d+$/, "")
}

export function DialogImportResearchProject(props: DialogImportResearchProjectProps) {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const language = useLanguage()
  const dialog = useDialog()

  const [zipPath, setZipPath] = createSignal("")
  const [projectName, setProjectName] = createSignal("")
  const [parentDir, setParentDir] = createSignal(sync.data.path.home || "")
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [picker, setPicker] = createSignal<"zip" | "parent" | null>(null)
  const [nameManuallyEdited, setNameManuallyEdited] = createSignal(false)

  let isMounted = true
  onCleanup(() => {
    isMounted = false
  })

  // Auto-fill project name when zip file is selected (unless user has manually edited)
  createEffect(() => {
    const zip = zipPath()
    if (zip && !nameManuallyEdited()) {
      const name = projectNameFromZip(zip)
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
    return zipPath().trim() && projectName().trim() && parentDir().trim() && !submitting()
  }

  async function handleImport() {
    if (!canSubmit()) return

    const zip = zipPath().trim()
    const target = targetDirectory()

    setSubmitting(true)
    setError(undefined)

    try {
      const res = await (sdk.client.research.project as any).import({
        zipPath: zip,
        targetDirectory: target,
      })

      if (!isMounted) return

      const projectID = res?.data?.project_id
      const researchID = res?.data?.research_project_id
      if (!projectID || !researchID) throw new Error(language.t("research.import.failed"))

      props.onSelect(target)
    } catch (err: unknown) {
      if (!isMounted) return
      const message = err instanceof Error ? err.message : language.t("research.import.error")
      setError(message)
      setSubmitting(false)
    }
  }

  return (
    <>
      <Dialog title={language.t("research.import.title")} fit class="w-full max-w-[640px] mx-auto">
        <div class="flex flex-col gap-5 px-6 pb-6 pt-1">
          <div class="bg-surface-raised-base rounded-lg px-4">
            {/* Zip file selector */}
            <div class="py-3 border-b border-border-weak-base">
              <label class="text-12-medium text-text-weak mb-1.5 block">
                {language.t("research.import.zip.label")}
              </label>
              <div class="flex items-center gap-2">
                <TextField
                  value={zipPath()}
                  placeholder={language.t("research.import.zip.placeholder")}
                  onChange={setZipPath}
                  class="flex-1"
                />
                <IconButton icon="folder" variant="ghost" onClick={() => setPicker("zip")} />
              </div>
            </div>

            {/* Project name */}
            <div class="py-3 border-b border-border-weak-base">
              <TextField
                label={language.t("research.import.name.label")}
                placeholder={language.t("research.import.name.placeholder")}
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
                {language.t("research.import.location.label")}
              </label>
              <div class="flex items-center gap-2">
                <TextField
                  value={parentDir()}
                  placeholder={language.t("research.import.location.placeholder")}
                  onChange={setParentDir}
                  class="flex-1"
                />
                <IconButton icon="folder" variant="ghost" onClick={() => setPicker("parent")} />
              </div>
            </div>
          </div>

          {/* Target path preview */}
          <Show when={targetDirectory()}>
            <div class="px-3 py-2 rounded-lg bg-surface-raised-base text-12-regular text-text-weak break-all">
              {language.t("research.import.target.preview")} <span class="text-text-base">{targetDirectory()}</span>
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
          <Button variant="primary" onClick={handleImport} disabled={!canSubmit()} loading={submitting()}>
            {language.t("research.import.button")}
          </Button>
        </div>
      </Dialog>

      <Show when={picker() === "zip"}>
        <DialogPathPicker
          title={language.t("research.import.zip.picker")}
          mode="files"
          acceptExt={[".zip"]}
          onSelect={(value) => {
            const selected = Array.isArray(value) ? value[0] : value
            setZipPath(selected)
            // Reset manual edit flag so auto-fill kicks in
            setNameManuallyEdited(false)
            setPicker(null)
          }}
          onClose={() => setPicker(null)}
        />
      </Show>

      <Show when={picker() === "parent"}>
        <DialogPathPicker
          title={language.t("research.import.location.picker")}
          mode="directories"
          onSelect={(value) => {
            setParentDir(Array.isArray(value) ? value[0] : value)
            setPicker(null)
          }}
          onClose={() => setPicker(null)}
        />
      </Show>
    </>
  )
}
