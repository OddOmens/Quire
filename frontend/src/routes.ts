/**
 * The code for each screen, loaded when it's first shown. Kept apart from
 * App.tsx so the app can start fetching the screen in the address bar before
 * React has rendered anything (lib/boot.ts).
 */
export const screens = {
  home: () => import("@/pages/home"),
  space: () => import("@/pages/space"),
  spaceSettings: () => import("@/pages/space-settings"),
  page: () => import("@/pages/page"),
  graph: () => import("@/pages/graph"),
  tasks: () => import("@/pages/tasks"),
  tags: () => import("@/pages/tags"),
  trash: () => import("@/pages/trash"),
  settings: () => import("@/pages/settings"),
  share: () => import("@/pages/share"),
  calendar: () => import("@/pages/calendar"),
  ask: () => import("@/pages/ask"),
  form: () => import("@/pages/form"),
  login: () => import("@/pages/login"),
  setup: () => import("@/pages/setup"),
}

export type Screen = keyof typeof screens
export type ScreenModule<K extends Screen> = Awaited<ReturnType<(typeof screens)[K]>>

const loaded: { [K in Screen]?: ScreenModule<K> } = {}

/** Loads a screen's code, remembering it so a screen that's already here renders at once. */
export function loadScreen<K extends Screen>(name: K): Promise<ScreenModule<K>> {
  return (screens[name]() as Promise<ScreenModule<K>>).then((m) => {
    loaded[name] = m as (typeof loaded)[K]
    return m
  })
}

export const loadedScreen = <K extends Screen>(name: K) => loaded[name] as ScreenModule<K> | undefined

/** The screen a URL shows; the same table as the routes in App.tsx. */
export function screenFor(pathname: string): Screen | undefined {
  const [first = "", , third] = pathname.split("/").slice(1)
  switch (first) {
    case "":
      return "home"
    case "p":
      return "page"
    case "s":
      return third === "settings" ? "spaceSettings" : third === "graph" ? "graph" : third === "tasks" ? "tasks" : third ? undefined : "space"
    case "graph":
    case "tags":
    case "trash":
    case "calendar":
    case "ask":
    case "form":
    case "settings":
    case "share":
    case "login":
    case "setup":
      return first
  }
  return undefined
}
