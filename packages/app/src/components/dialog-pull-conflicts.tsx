import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"

interface DialogPullConflictsProps {
  title: string
  message: string
  directory: string
}

export function DialogPullConflicts(props: DialogPullConflictsProps) {
  const dialog = useDialog()

  const openInVSCode = () => {
    // Open the project folder in VS Code, then switch to the SCM (git) tab
    window.open(`vscode://file/${props.directory}`, "_blank")
    setTimeout(() => {
      window.open("vscode://command/workbench.view.scm", "_blank")
    }, 500)
  }

  return (
    <Dialog title={props.title} class="w-full max-w-[560px] mx-auto">
      <div class="flex flex-col gap-4 px-6 pb-6 pt-1">
        <div class="flex items-start gap-2 px-3 py-2 rounded-lg bg-error-base/10 text-error-base">
          <span class="text-12-regular">Conflicts must be resolved before continuing.</span>
        </div>
        <pre class="text-13-regular text-text-base bg-surface-raised-base rounded-lg px-4 py-3 overflow-x-auto whitespace-pre-wrap break-words max-h-[320px] overflow-y-auto m-0">
          {props.message}
        </pre>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            Close
          </Button>
          <Button variant="primary" size="large" onClick={openInVSCode}>
            Open in VS Code
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
