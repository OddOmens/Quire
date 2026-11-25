/** Runs fn once the browser has nothing better to do (or soon, where it can't say). Returns a cancel. */
export function whenIdle(fn: () => void, timeout = 2500) {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(fn, { timeout })
    return () => cancelIdleCallback(id)
  }
  const id = setTimeout(fn, 800)
  return () => clearTimeout(id)
}
