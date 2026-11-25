/** App-wide dialogs, opened from anywhere without threading callbacks. */

export const openPalette = () => window.dispatchEvent(new Event("quire:palette"))

/** Create a space. */
export const openSpaceDialog = () => window.dispatchEvent(new Event("quire:space-dialog"))

export const openMoveDialog = (path: string) => window.dispatchEvent(new CustomEvent("quire:move", { detail: path }))

/** Put the spaces in order. */
export const openArrangeSpaces = () => window.dispatchEvent(new Event("quire:arrange-spaces"))

/** Create a database under parent (a space or page path), or import one from a file. */
export const openNewDatabase = (parent: string, mode: "new" | "import" = "new") =>
  window.dispatchEvent(new CustomEvent("quire:new-database", { detail: { parent, mode } }))

export function onUiEvent<T>(name: "quire:palette" | "quire:space-dialog" | "quire:move" | "quire:arrange-spaces" | "quire:new-database", fn: (detail: T) => void) {
  const handler = (e: Event) => fn((e as CustomEvent<T>).detail)
  window.addEventListener(name, handler)
  return () => window.removeEventListener(name, handler)
}
