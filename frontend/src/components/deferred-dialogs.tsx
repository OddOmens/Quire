import { useEffect, useRef, useState, type ComponentType } from "react"

import { deferred } from "@/lib/deferred"
import { whenIdle } from "@/lib/idle"

type Trigger = {
  /** Window events that open the dialog (lib/ui-events.ts). */
  events: string[]
  /** Key presses the dialog answers to itself. */
  key?: (e: KeyboardEvent) => boolean
}

/**
 * A dialog that's mounted on every screen but rarely opened. Its code loads
 * once the page is idle, or the moment it's first asked for; that request
 * (the event or key press) is passed on once the dialog is listening.
 */
function dialog(load: () => Promise<ComponentType>, { events, key }: Trigger) {
  let pending: Event | null = null
  // Mounts with the dialog, after it, so the dialog's own listeners are in place.
  function Ready({ then }: { then: () => void }) {
    const run = useRef(then)
    useEffect(() => run.current(), [])
    return null
  }
  const Dialog = deferred(async () => {
    const Loaded = await load()
    return function WithReady({ then }: { then: () => void }) {
      return (
        <>
          <Loaded />
          <Ready then={then} />
        </>
      )
    }
  })

  return function DeferredDialog() {
    const [wanted, setWanted] = useState(false)
    const [ready, setReady] = useState(false)

    useEffect(() => {
      if (ready) return
      const cancel = whenIdle(() => setWanted(true))
      const ask = (e: Event) => {
        pending = e
        setWanted(true)
      }
      const onKey = (e: KeyboardEvent) => {
        if (!key?.(e)) return
        e.preventDefault()
        ask(e)
      }
      for (const name of events) window.addEventListener(name, ask)
      window.addEventListener("keydown", onKey)
      return () => {
        cancel()
        for (const name of events) window.removeEventListener(name, ask)
        window.removeEventListener("keydown", onKey)
      }
    }, [ready])

    if (!wanted) return null
    return (
      <Dialog
        then={() => {
          setReady(true)
          const e = pending
          pending = null
          // Once the listeners above are gone, so it's heard only by the dialog.
          if (e) setTimeout(() => window.dispatchEvent(e))
        }}
      />
    )
  }
}

const mod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey

export const CommandPalette = dialog(() => import("@/components/command-palette").then((m) => m.CommandPalette), {
  events: ["quire:palette"],
  // ⌘K opens it; ⌘⇧N (new page) lives there too.
  key: (e) => mod(e) && ((e.key.toLowerCase() === "k" && !e.shiftKey) || (e.key.toLowerCase() === "n" && e.shiftKey)),
})
export const SpaceDialog = dialog(() => import("@/components/space-dialog").then((m) => m.SpaceDialog), { events: ["quire:space-dialog"] })
export const ArrangeSpacesDialog = dialog(() => import("@/components/arrange-spaces-dialog").then((m) => m.ArrangeSpacesDialog), { events: ["quire:arrange-spaces"] })
export const MoveDialog = dialog(() => import("@/components/move-dialog").then((m) => m.MoveDialog), { events: ["quire:move"] })
export const NewDatabaseDialog = dialog(() => import("@/components/new-database-dialog").then((m) => m.NewDatabaseDialog), { events: ["quire:new-database"] })
