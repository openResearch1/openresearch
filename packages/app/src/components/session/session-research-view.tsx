import { Match, Switch } from "solid-js"

import { Icon } from "@opencode-ai/ui/icon"
import { Mark } from "@opencode-ai/ui/logo"

import { useLanguage } from "@/context/language"

export type ResearchSessionKind = "controller" | "atom" | "experiment"

const copy = {
  controller: {
    title: "session.controller.welcome.title",
    description: "session.controller.welcome.description",
  },
  atom: {
    title: "session.atom.welcome.title",
    description: "session.atom.welcome.description",
  },
  experiment: {
    title: "session.experiment.welcome.title",
    description: "session.experiment.welcome.description",
  },
} as const

export function ResearchSessionView(props: { kind: ResearchSessionKind }) {
  const language = useLanguage()

  return (
    <div class="size-full flex flex-col">
      <div class="h-12 shrink-0" aria-hidden />
      <div class="flex-1 px-6 pb-30 flex items-center justify-center text-center">
        <div class="w-full max-w-md flex flex-col items-center gap-6">
          <Switch>
            <Match when={props.kind === "controller"}>
              <Mark class="w-10" />
            </Match>
            <Match when={props.kind === "atom"}>
              <div class="size-10 flex items-center justify-center rounded-md border border-border-weak-base bg-surface-raised-base text-icon-base">
                <Icon name="atom" size="large" />
              </div>
            </Match>
            <Match when={props.kind === "experiment"}>
              <div class="size-10 flex items-center justify-center rounded-md border border-border-weak-base bg-surface-raised-base text-icon-base">
                <Icon name="experiment" size="large" />
              </div>
            </Match>
          </Switch>
          <div class="flex flex-col items-center gap-2">
            <div class="text-20-medium text-text-strong">{language.t(copy[props.kind].title)}</div>
            <div class="max-w-sm text-13-regular text-text-weak leading-5">
              {language.t(copy[props.kind].description)}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
