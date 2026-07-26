import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

export function createWorkflowHideTimer(input: {
  closeMs: () => number
  hide: (id: string | undefined) => void
}) {
  let timer: number | undefined

  return {
    update(id: string | undefined, status: string | undefined) {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = undefined
      input.hide(undefined)
      if (!id || !status || !["completed", "failed", "cancelled"].includes(status)) return

      timer = window.setTimeout(() => {
        input.hide(id)
        timer = undefined
      }, input.closeMs())
    },
    dispose() {
      if (timer === undefined) return
      window.clearTimeout(timer)
    },
  }
}

export function createWorkflowVisibility<T extends { instance: { id: string; status: string } }>(
  source: () => T | undefined,
  closeMs: () => number,
) {
  const [store, setStore] = createStore({
    hidden: undefined as string | undefined,
  })
  const timer = createWorkflowHideTimer({
    closeMs,
    hide: (id) => setStore("hidden", id),
  })

  createEffect(
    on(
      () => [source()?.instance.id, source()?.instance.status] as const,
      ([id, status]) => timer.update(id, status),
    ),
  )

  onCleanup(timer.dispose)

  return createMemo(() => {
    const item = source()
    if (!item || item.instance.id === store.hidden) return
    return item
  })
}
