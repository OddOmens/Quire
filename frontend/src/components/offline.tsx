import { useEffect, useRef, useSyncExternalStore } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { CloudOff, CloudUpload, Loader2 } from "lucide-react"
import { Link, useNavigate } from "react-router"
import { toast } from "sonner"

import { useCurrentPath } from "@/hooks/use-vault"
import { pageUrl, titleOf } from "@/lib/notes"
import { flush, offlineState, settle, syncSoon, watchOffline, type OfflineEvent, type Pending } from "@/lib/offline"

/** The copy of the vault on this device (lib/offline.ts): whether it's on, what's waiting to be sent. */
export function useOffline() {
  return useSyncExternalStore(watchOffline, offlineState)
}

/** What an offline change is waiting for, when it isn't just a connection. */
export function stuckReason(p: Pending) {
  if (p.clash) return "Changed on another device too"
  if (p.gone) return "Deleted or moved on another device"
  if (p.error) return p.error
  return ""
}

/** Asks about one change the server wouldn't take as it was. */
function ask(p: Pending) {
  const title = titleOf(p.path)
  const id = `offline:${p.path}`
  const run = (choice: Parameters<typeof settle>[1]) => () => void settle(p.path, choice).catch((e) => toast.error(e instanceof Error ? e.message : "That didn't work"))
  if (p.clash) {
    toast.warning(`“${title}” changed on another device while this one was offline`, {
      id,
      description: "Keep the version from this device, or the one saved elsewhere. Both stay in page history.",
      duration: Infinity,
      action: { label: "Keep mine", onClick: run("mine") },
      cancel: { label: "Keep theirs", onClick: run("theirs") },
    })
  } else if (p.gone) {
    toast.warning(`“${title}” was deleted or moved on another device`, {
      id,
      description: "What you wrote here while offline hasn't been saved anywhere else.",
      duration: Infinity,
      action: { label: "Bring it back", onClick: run("mine") },
      cancel: { label: "Discard", onClick: run("discard") },
    })
  } else if (p.error) {
    toast.error(`Changes to “${title}” couldn't be sent`, {
      id,
      description: `${p.error}. They're still on this device.`,
      duration: Infinity,
      action: { label: "Try again", onClick: run("retry") },
    })
  }
}

/**
 * Keeps the screens in step with the copy on this device: pages sent after
 * being written offline, pages the server renamed, and questions about
 * changes it wouldn't take. Rendered once, inside the signed-in frame.
 */
export function OfflineWatcher() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const current = useCurrentPath()
  const here = useRef(current)
  here.current = current
  const { pending } = useOffline()
  const asked = useRef(new Set<string>())

  // Signed in (again): send what was waiting, and bring the copy up to date.
  useEffect(() => {
    void flush()
    syncSoon()
  }, [])

  useEffect(() => {
    const on = (e: Event) => {
      const ev = (e as CustomEvent<OfflineEvent>).detail
      if (ev.type === "saved" || ev.type === "moved") {
        qc.setQueryData(["note", ev.note.path], ev.note)
        if (ev.type === "moved") {
          qc.removeQueries({ queryKey: ["note", ev.from], exact: true })
          if (here.current === ev.from) navigate(pageUrl(ev.to), { replace: true })
        }
        for (const key of ["tree", "spaces", "tags", "graph", "tasks", "missing-links", "calendar"]) void qc.invalidateQueries({ queryKey: [key] })
        void qc.invalidateQueries({ queryKey: ["note"], predicate: (q) => q.queryKey[1] !== ev.note.path })
      } else {
        void qc.invalidateQueries()
      }
    }
    window.addEventListener("quire:offline", on)
    return () => window.removeEventListener("quire:offline", on)
  }, [qc, navigate])

  useEffect(() => {
    const stuck = new Map(pending.filter(stuckReason).map((p) => [`${p.path}\n${stuckReason(p)}`, p]))
    for (const [key, p] of stuck) {
      if (asked.current.has(key)) continue
      asked.current.add(key)
      ask(p)
    }
    // Settled ones don't need their question any more.
    for (const key of asked.current) {
      if (stuck.has(key)) continue
      asked.current.delete(key)
      const path = key.slice(0, key.indexOf("\n"))
      if (![...stuck.values()].some((p) => p.path === path)) toast.dismiss(`offline:${path}`)
    }
  }, [pending])

  return null
}

/**
 * Says so when Quire is running from the copy on this device, or has changes
 * waiting to be sent. Nothing when all is well. Links to the setting.
 */
export function OfflineBadge({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  const { enabled, reachable, pending, syncing, progress } = useOffline()
  if (!enabled && !pending.length) return null
  const waiting = pending.length
  let icon = null
  let text = ""
  if (!reachable) {
    icon = <CloudOff className="size-3.5" />
    text = waiting ? `Offline · ${waiting} to send` : "Offline"
  } else if (waiting) {
    icon = <CloudUpload className="size-3.5" />
    text = `${waiting} to send`
  } else if (syncing && progress && progress.total > 20) {
    icon = <Loader2 className="size-3.5 animate-spin" />
    text = `Downloading ${progress.done}/${progress.total}`
  } else {
    return null
  }
  return (
    <Link
      to="/settings/offline"
      onClick={onNavigate}
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border bg-background px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${className ?? ""}`}
    >
      {icon}
      {text}
    </Link>
  )
}
