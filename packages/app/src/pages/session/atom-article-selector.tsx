import { createEffect, For, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { showToast } from "@opencode-ai/ui/toast"
import type { ResearchArticleListResponse } from "@opencode-ai/sdk/v2"

import { useSDK } from "@/context/sdk"

type Article = ResearchArticleListResponse[number]

export function sync(select: HTMLSelectElement | undefined, value: string) {
  if (select) select.value = value
}

function message(input: unknown) {
  if (input instanceof Error) return input.message
  if (input && typeof input === "object" && "message" in input && typeof input.message === "string") {
    return input.message
  }
  if (input && typeof input === "object" && "data" in input) return message(input.data)
  return "Failed to update source article"
}

export function AtomArticleSelector(props: {
  researchProjectId: string
  atomId: string
  articleId: string | null
  locked: boolean
  onUpdated?: () => void | Promise<void>
}) {
  const sdk = useSDK()
  let select: HTMLSelectElement | undefined
  const [state, setState] = createStore({
    articles: [] as Article[],
    value: props.articleId ?? "",
    loading: true,
    saving: false,
  })

  createEffect(() => setState("value", props.articleId ?? ""))
  createEffect(() => {
    state.articles.length
    sync(select, state.value)
  })
  createEffect(() => {
    const researchProjectId = props.researchProjectId
    let active = true
    setState("loading", true)
    sdk.client.research.article
      .list({ researchProjectId })
      .then((res) => {
        if (active && res.data) setState("articles", res.data)
      })
      .catch(() => {
        if (active) setState("articles", [])
      })
      .finally(() => {
        if (active) setState("loading", false)
      })
    onCleanup(() => {
      active = false
    })
  })

  const update = async (value: string) => {
    if (value === (props.articleId ?? "") || state.saving) return
    const previous = props.articleId ?? ""
    setState({ value, saving: true })
    try {
      const res = await sdk.client.research.atom.update({
        researchProjectId: props.researchProjectId,
        atomId: props.atomId,
        article_id: value || null,
      })
      if (!res.data) throw new Error(message(res.error))
      void Promise.resolve(props.onUpdated?.()).catch(() => undefined)
    } catch (error) {
      setState("value", previous)
      showToast({ variant: "error", title: "Failed to update source article", description: message(error) })
    } finally {
      setState("saving", false)
    }
  }

  return (
    <div class="flex items-center gap-1.5 min-w-0 text-[11px]">
      <span class="text-text-weak shrink-0">Source:</span>
      <select
        ref={select}
        aria-label="Source article"
        value={state.value}
        disabled={props.locked || state.loading || state.saving}
        onChange={(event) => update(event.currentTarget.value)}
        class="min-w-0 max-w-60 rounded border border-border-weak-base bg-background-stronger px-1.5 py-0.5 text-[11px] text-text-base outline-none focus:border-border-base disabled:opacity-50"
        title={props.locked ? "Unlock the atom before changing its source article" : undefined}
      >
        <option value="">No linked article</option>
        <For each={state.articles}>
          {(article) => (
            <option value={article.article_id} title={article.article_id}>
              {article.title || article.filename} ({article.article_id.slice(0, 8)})
            </option>
          )}
        </For>
      </select>
      {state.saving && <span class="text-[11px] text-text-weak shrink-0">Saving...</span>}
    </div>
  )
}
