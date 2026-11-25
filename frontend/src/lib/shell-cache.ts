import type { QueryClient, QueryKey } from "@tanstack/react-query"

import { whenIdle } from "@/lib/idle"

/**
 * Keeps the few answers the app's frame is drawn from (who's signed in, the
 * spaces, the list of pages) in this browser, so a reload shows the sidebar
 * at once instead of a spinner. They stand in only until the server answers,
 * and it's asked straight away (lib/boot.ts). No page text is kept, not even
 * the excerpts, and signing out or being signed out removes all of it.
 */

const STORE = "quire.shell"
/** Remembers that this browser was signed in, so the next load can ask for everything at once. */
const SIGNED_IN = "quire.signed-in"
/** The queries kept, by the first part of their key. */
const KEPT = ["session", "account", "spaces", "tree"]
/** How long after the last change the stored copy is rewritten. */
const WRITE_DELAY = 1000
/** Vaults whose page list is bigger than this aren't worth a slow, full localStorage. */
const MAX_CHARS = 2_000_000
// This file's own name changes with every build, so a new build never reads
// answers shaped for an old one.
const BUILD = import.meta.env.DEV ? "dev" : new URL(import.meta.url).pathname

type Saved = { build: string; queries: { key: QueryKey; data: unknown; at: number }[] }

const kept = (key: QueryKey) => key.length === 1 && KEPT.includes(key[0] as string)

export function forgetShell() {
  try {
    localStorage.removeItem(STORE)
    localStorage.removeItem(SIGNED_IN)
  } catch {
    // Nothing was kept without storage.
  }
}

/** Whether this browser was signed in when it last heard from the server. */
export function wasSignedIn() {
  try {
    return localStorage.getItem(SIGNED_IN) === "1"
  } catch {
    return false
  }
}

/** What goes into storage for a query: the page list without its excerpts. */
function trimmed(key: QueryKey, data: unknown) {
  if (key[0] !== "tree") return data
  const tree = data as { notes?: Record<string, unknown>[] }
  return { ...tree, notes: tree.notes?.map((n) => ({ ...n, excerpt: "" })) }
}

function save(qc: QueryClient) {
  const session = qc.getQueryData<{ authenticated?: boolean }>(["session"])
  if (!session?.authenticated) return forgetShell()
  const queries: Saved["queries"] = []
  for (const q of qc.getQueryCache().getAll()) {
    if (kept(q.queryKey) && q.state.status === "success" && q.state.data !== undefined) {
      queries.push({ key: q.queryKey, data: trimmed(q.queryKey, q.state.data), at: q.state.dataUpdatedAt })
    }
  }
  try {
    const text = JSON.stringify({ build: BUILD, queries } satisfies Saved)
    localStorage.setItem(SIGNED_IN, "1")
    if (text.length > MAX_CHARS) return localStorage.removeItem(STORE)
    localStorage.setItem(STORE, text)
  } catch {
    // Private mode or a full quota: the next load just starts cold.
    forgetShell()
  }
}

/**
 * Fills the cache from the last visit and keeps the stored copy up to date.
 * Restored answers keep their age, so they count as stale and are refetched.
 */
export function restoreShell(qc: QueryClient) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null") as Saved | null
    if (saved?.build === BUILD && Array.isArray(saved.queries)) {
      for (const q of saved.queries) {
        if (kept(q.key)) qc.setQueryData(q.key, q.data, { updatedAt: q.at })
      }
    } else if (saved) {
      forgetShell()
    }
  } catch {
    forgetShell()
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  qc.getQueryCache().subscribe((e) => {
    if (!kept(e.query.queryKey)) return
    if (e.type !== "removed" && !(e.type === "updated" && e.action.type === "success")) return
    // Not while typing: a save refreshes the page list every few seconds.
    clearTimeout(timer)
    timer = setTimeout(() => whenIdle(() => save(qc)), WRITE_DELAY)
  })
}
