import { useSyncExternalStore } from "react"

const query = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(pointer: coarse)") : null

/** Whether the main way of pointing is a finger rather than a mouse or trackpad. */
export function coarsePointer() {
  return query?.matches ?? false
}

function subscribe(fn: () => void) {
  query?.addEventListener("change", fn)
  return () => query?.removeEventListener("change", fn)
}

/** coarsePointer, kept up to date (an iPad gains and loses a trackpad). */
export function useCoarsePointer() {
  return useSyncExternalStore(subscribe, coarsePointer, () => false)
}
