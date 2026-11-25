import { useEffect, useState } from "react"
import type { LucideIconData } from "lucide-react"

// Any Lucide icon by name, loaded on demand: the name → import() map is its
// own chunk and each icon's data is a tiny chunk of its own (see the
// lucide-icons plugin in vite.config.ts), so the main bundle doesn't carry the
// ~2,000 icons. Render the data with lucide-react's <Icon icon={…} />. Loaded
// icons are cached, so they show straight away the next time a menu opens.

type Loaders = Record<string, () => Promise<{ default: LucideIconData }>>

let loaders: Promise<Loaders> | undefined
const loaded = new Map<string, LucideIconData | null>()
const pending = new Map<string, Promise<LucideIconData | null>>()

const loadLoaders = () =>
  (loaders ??= import("virtual:lucide-icon-loaders").then(
    (m) => m.default,
    (err) => {
      loaders = undefined // try again next time, e.g. after a network blip
      throw err
    },
  ))

/** Resolves to the icon's data, or null when Lucide has no icon by that name. */
export function loadLucideIcon(name: string): Promise<LucideIconData | null> {
  const done = loaded.get(name)
  if (done !== undefined) return Promise.resolve(done)
  let p = pending.get(name)
  if (!p) {
    p = loadLoaders()
      .then(async (map) => (Object.hasOwn(map, name) ? (await map[name]()).default : null))
      .then((icon) => {
        loaded.set(name, icon)
        return icon
      })
      .finally(() => pending.delete(name))
    pending.set(name, p)
  }
  return p
}

/** The icon's data once loaded: undefined while loading, null when there's no such icon (or no name). */
export function useLucideIcon(name: string | undefined): LucideIconData | null | undefined {
  const [state, setState] = useState<{ name: string; icon: LucideIconData | null }>()
  useEffect(() => {
    if (!name || loaded.has(name)) return
    let live = true
    loadLucideIcon(name).then(
      (icon) => live && setState({ name, icon }),
      () => live && setState({ name, icon: null }),
    )
    return () => {
      live = false
    }
  }, [name])
  if (!name) return null
  const cached = loaded.get(name)
  if (cached !== undefined) return cached
  return state?.name === name ? state.icon : undefined
}
