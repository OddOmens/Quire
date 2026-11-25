import { QueryClient } from "@tanstack/react-query"

import { api, ApiError } from "@/lib/api"
import { whenIdle } from "@/lib/idle"
import { pathFromUrl } from "@/lib/notes"
import { startOffline } from "@/lib/offline"
import { restoreShell, wasSignedIn } from "@/lib/shell-cache"
import { loadScreen, screenFor } from "@/routes"

/**
 * Starts everything the first screen needs at once, before React renders:
 * the session check, the screen's code, and the data the sidebar and the
 * screen will ask for. They used to run one after another. The keys and
 * fetchers are the components' own, so they find the answers (or the request
 * still under way) instead of asking again.
 */

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Ask even when the browser says it's offline: the copy on this device
      // may have the answer (lib/offline.ts), and the browser is often wrong.
      networkMode: "always",
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
    mutations: { networkMode: "always" },
  },
})

restoreShell(queryClient)
void startOffline()

// staleTime 0: ask even when a copy from the last visit is in the cache.
const fetch = <T>(queryKey: unknown[], queryFn: () => Promise<T>) => void queryClient.prefetchQuery({ queryKey, queryFn, staleTime: 0 })

const screen = screenFor(location.pathname)
if (screen) void loadScreen(screen).catch(() => {})

if (screen === "share") {
  let token = ""
  try {
    token = decodeURIComponent(location.pathname.split("/")[2] ?? "")
  } catch {
    // A malformed link: the screen shows that it doesn't work.
  }
  if (token) void queryClient.prefetchQuery({ queryKey: ["public", token], queryFn: () => api.publicPage(token), retry: false })
} else {
  // No record of a session in this browser: the sign-in screen is likely next.
  if (!wasSignedIn() && screen !== "login" && screen !== "setup") void loadScreen("login").catch(() => {})
  fetch(["session"], api.session)
  // Only a browser that was signed in asks for the rest up front. Anyone
  // else waits for the session check, as before, rather than collecting
  // refusals from the server.
  if (wasSignedIn() && screen !== "login" && screen !== "setup") {
    fetch(["tree"], api.tree)
    fetch(["spaces"], api.spaces)
    fetch(["account"], api.account)
    const path = pathFromUrl(location.pathname)
    if (path) fetch(["note", path], () => api.note(path))

    // Then, quietly, the screens most likely to be opened next.
    const saveData = (navigator as { connection?: { saveData?: boolean } }).connection?.saveData
    if (!saveData) {
      whenIdle(() => {
        for (const next of ["page", "home", "space"] as const) if (next !== screen) void loadScreen(next).catch(() => {})
      }, 4000)
    }
  }
}
