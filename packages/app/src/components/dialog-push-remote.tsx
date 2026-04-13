import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { createSignal } from "solid-js"
import { useSDK } from "@/context/sdk"
import { showToast } from "@opencode-ai/ui/toast"

export function DialogPushRemote() {
  const dialog = useDialog()
  const sdk = useSDK()
  const [url, setUrl] = createSignal("")
  const [loading, setLoading] = createSignal(false)

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    const value = url().trim()
    if (!value) return

    setLoading(true)
    await sdk.client.sync
      .push({ remoteUrl: value })
      .then((res) => {
        if (res.data?.ok) {
          showToast({
            title: "Push complete",
            description: res.data.message,
            variant: "success",
          })
          dialog.close()
        } else {
          showToast({
            title: "Push failed",
            description: res.data?.message ?? "Unknown error",
            variant: "error",
          })
        }
      })
      .catch(() => {
        showToast({
          title: "Push failed",
          description: "Failed to push research project",
          variant: "error",
        })
      })
      .finally(() => setLoading(false))
  }

  return (
    <Dialog title="Set Remote Repository" class="w-full max-w-[480px] mx-auto">
      <form onSubmit={handleSubmit} class="flex flex-col gap-6 p-6 pt-0">
        <p class="text-13-regular text-text-weak">
          No remote repository configured. Enter a git remote URL to push to.
        </p>
        <TextField
          autofocus
          type="text"
          label="Repository URL"
          placeholder="git@github.com:user/repo.git"
          value={url()}
          onChange={(v) => setUrl(v)}
        />
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={loading() || !url().trim()}>
            {loading() ? "Pushing..." : "Push"}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
