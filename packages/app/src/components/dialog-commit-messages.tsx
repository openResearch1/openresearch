import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { createSignal, For, Show } from "solid-js"

export interface DirtyExperimentInfo {
  expId: string
  expName: string
  codeName: string
}

interface DialogCommitMessagesProps {
  defaultMessage?: string
  dirtyExperiments?: DirtyExperimentInfo[]
  needsLocalCommitMessage?: boolean
  onConfirm: (result: {
    message?: string
    commitMessages?: Record<string, string>
    localCommitMessage?: string
  }) => void
}

export function DialogCommitMessages(props: DialogCommitMessagesProps) {
  const dialog = useDialog()
  const [mainMessage, setMainMessage] = createSignal(props.defaultMessage ?? "")
  const [messages, setMessages] = createSignal<Record<string, string>>({})
  const [localMessage, setLocalMessage] = createSignal("")

  const allFilled = () => {
    if (props.defaultMessage !== undefined && !mainMessage().trim()) return false
    if (props.dirtyExperiments?.length) {
      const m = messages()
      for (const exp of props.dirtyExperiments) {
        if (!m[exp.expId]?.trim()) return false
      }
    }
    if (props.needsLocalCommitMessage && !localMessage().trim()) return false
    return true
  }

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    if (!allFilled()) return
    props.onConfirm({
      message: props.defaultMessage !== undefined ? mainMessage() : undefined,
      commitMessages: props.dirtyExperiments?.length ? messages() : undefined,
      localCommitMessage: props.needsLocalCommitMessage ? localMessage() : undefined,
    })
    dialog.close()
  }

  return (
    <Dialog title="Commit Messages" class="w-full max-w-[560px] mx-auto">
      <form onSubmit={handleSubmit} class="flex flex-col gap-4 p-6 pt-0">
        <p class="text-13-regular text-text-weak">Please review and edit the commit messages before syncing.</p>
        <Show when={props.defaultMessage !== undefined}>
          <TextField autofocus label="Push commit message" value={mainMessage()} onChange={(v) => setMainMessage(v)} />
        </Show>
        <For each={props.dirtyExperiments}>
          {(exp) => (
            <TextField
              label={`Experiment: ${exp.expName} (${exp.codeName})`}
              placeholder="Describe your changes..."
              value={messages()[exp.expId] || ""}
              onChange={(v) => setMessages((prev) => ({ ...prev, [exp.expId]: v }))}
            />
          )}
        </For>
        <Show when={props.needsLocalCommitMessage}>
          <TextField
            label="Project local changes"
            placeholder="Describe your local changes..."
            value={localMessage()}
            onChange={(v) => setLocalMessage(v)}
          />
        </Show>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={!allFilled()}>
            Confirm
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
