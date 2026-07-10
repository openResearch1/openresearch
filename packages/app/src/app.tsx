import "@/index.css"
import { File } from "@opencode-ai/ui/file"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { Font } from "@opencode-ai/ui/font"
import { ThemeProvider } from "@opencode-ai/ui/theme"
import { MetaProvider } from "@solidjs/meta"
import { BaseRouterProps, Navigate, Route, Router, useLocation, useParams } from "@solidjs/router"
import { Component, createMemo, ErrorBoundary, type JSX, lazy, type ParentProps, Show, Suspense } from "solid-js"
import { CommandProvider } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { GlobalSyncProvider } from "@/context/global-sync"
import { HighlightsProvider } from "@/context/highlights"
import { LanguageProvider, useLanguage } from "@/context/language"
import { LayoutProvider } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { PromptProvider } from "@/context/prompt"
import { type ServerConnection, ServerProvider, useServer } from "@/context/server"
import { SettingsProvider } from "@/context/settings"
import { TerminalProvider } from "@/context/terminal"
import DirectoryLayout, { DirectoryDataProvider } from "@/pages/directory-layout"
import { CollabPeersProvider } from "@/context/collab-peers"
import Layout from "@/pages/layout"
import { ErrorPage } from "./pages/error"
import { Dynamic } from "solid-js/web"
import { decode64 } from "@/utils/base64"
import { SDKProvider } from "@/context/sdk"
import { SyncProvider } from "@/context/sync"
import { SessionIDProvider } from "@/context/session-id"

const Home = lazy(() => import("@/pages/home"))
const Session = lazy(() => import("@/pages/session"))
const Loading = () => <div class="size-full" />

const HomeRoute = () => (
  <Suspense fallback={<Loading />}>
    <Home />
  </Suspense>
)

const SessionRoute = () => (
  <SessionProviders>
    <Suspense fallback={<Loading />}>
      <Session />
    </Suspense>
  </SessionProviders>
)

const RemoteSessionRoute = () => {
  const params = useParams()
  const location = useLocation()
  const directory = createMemo(() => decode64(params.dir) ?? "")
  const session = createMemo(() => params.id)
  const back = createMemo(() => `/remote/project/${encodeURIComponent(directory())}${location.search}`)

  return (
    <Show when={directory() && session()}>
      <SDKProvider directory={directory}>
        <SyncProvider>
          <DirectoryDataProvider directory={directory()} remote>
            <SessionIDProvider sessionID={session()!} directory={directory()}>
              <SessionProviders>
                <div class="mx-auto h-full w-full max-w-[720px] min-h-0 bg-background-base overflow-hidden">
                  <Suspense fallback={<Loading />}>
                    <Session remote backHref={back()} />
                  </Suspense>
                </div>
              </SessionProviders>
            </SessionIDProvider>
          </DirectoryDataProvider>
        </SyncProvider>
      </SDKProvider>
    </Show>
  )
}

const SessionIndexRoute = () => <Navigate href="session" />

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.locale, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __OPENCODE__?: {
      updaterEnabled?: boolean
      deepLinks?: string[]
      wsl?: boolean
    }
  }
}

function MarkedProviderWithNativeParser(props: ParentProps) {
  const platform = usePlatform()
  return <MarkedProvider nativeParser={platform.parseMarkdown}>{props.children}</MarkedProvider>
}

function AppContextProviders(props: ParentProps) {
  return (
    <SettingsProvider>
      <PermissionProvider>
        <LayoutProvider>
          <NotificationProvider>
            <ModelsProvider>
              <CommandProvider>
                <HighlightsProvider>
                  {props.children}
                </HighlightsProvider>
              </CommandProvider>
            </ModelsProvider>
          </NotificationProvider>
        </LayoutProvider>
      </PermissionProvider>
    </SettingsProvider>
  )
}

function AppShellProviders(props: ParentProps) {
  return (
    <AppContextProviders>
      <Layout>{props.children}</Layout>
    </AppContextProviders>
  )
}

function SessionProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <FileProvider>
        <PromptProvider>
          <CommentsProvider>{props.children}</CommentsProvider>
        </PromptProvider>
      </FileProvider>
    </TerminalProvider>
  )
}

function RouterRoot(props: ParentProps<{ appChildren?: JSX.Element }>) {
  const location = useLocation()
  const remote = createMemo(() => location.pathname.startsWith("/remote/session/"))

  if (remote()) {
    return (
      <AppContextProviders>
        <div class="relative h-screen w-screen min-h-0 overflow-hidden bg-background-base">
          {props.appChildren}
          {props.children}
        </div>
      </AppContextProviders>
    )
  }

  return (
    <AppShellProviders>
      {props.appChildren}
      {props.children}
    </AppShellProviders>
  )
}

export function AppBaseProviders(props: ParentProps) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider>
        <LanguageProvider>
          <UiI18nBridge>
            <ErrorBoundary fallback={(error) => <ErrorPage error={error} />}>
              <DialogProvider>
                <MarkedProviderWithNativeParser>
                  <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                </MarkedProviderWithNativeParser>
              </DialogProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.key} keyed>
      {props.children}
    </Show>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
}) {
  return (
    <ServerProvider defaultServer={props.defaultServer} servers={props.servers}>
      <ServerKey>
        <GlobalSDKProvider>
          <GlobalSyncProvider>
            <CollabPeersProvider>
              <Dynamic
                component={props.router ?? Router}
                root={(routerProps) => <RouterRoot appChildren={props.children}>{routerProps.children}</RouterRoot>}
              >
                <Route path="/" component={HomeRoute} />
                <Route path="/remote/session/:dir/:id" component={RemoteSessionRoute} />
                <Route path="/:dir" component={DirectoryLayout}>
                  <Route path="/" component={SessionIndexRoute} />
                  <Route path="/session/:id?" component={SessionRoute} />
                </Route>
              </Dynamic>
            </CollabPeersProvider>
          </GlobalSyncProvider>
        </GlobalSDKProvider>
      </ServerKey>
    </ServerProvider>
  )
}
