import { useEffect, useState, type ComponentType, type ReactNode } from "react"

/**
 * A component whose code loads when it's first rendered, like React.lazy but
 * without Suspense. React holds back whatever replaces a Suspense fallback
 * for up to 300 ms so spinners don't flicker, which added 300 ms to every
 * first load; this shows the fallback itself and swaps the moment the code
 * is here. A stale file after an update is handled in main.tsx (reload).
 */
export function deferred<P extends object>(load: () => Promise<ComponentType<P>>, fallback: ReactNode = null) {
  let Loaded: ComponentType<P> | undefined
  let loading: Promise<unknown> | undefined
  const preload = () =>
    (loading ??= load().then(
      (c) => (Loaded = c),
      () => (loading = undefined),
    ))

  function Deferred(props: P) {
    const [, update] = useState(0)
    const Here = Loaded
    useEffect(() => {
      if (Here) return
      let live = true
      void preload().then(() => live && update((n) => n + 1))
      return () => {
        live = false
      }
    }, [Here])
    return Here ? <Here {...props} /> : fallback
  }
  Deferred.preload = preload
  return Deferred
}
