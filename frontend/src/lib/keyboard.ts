/**
 * The on-screen keyboard. iPhones and iPads don't resize the page for it:
 * they lay the keyboard over the bottom of the page and slide the page up
 * under the notch if the caret would be hidden. Here the covered height is
 * measured and published as the CSS variable --kb, the app's frame ends
 * above it (components/app-shell.tsx), and whatever is being typed in is
 * scrolled back into the part of the page that's left.
 */

type Listener = (covered: number) => void

const listeners = new Set<Listener>()
let covered = 0

/** How many pixels of the bottom of the page the keyboard covers now. */
export function keyboardHeight() {
  return covered
}

/** How much of the bottom of the page is taken by the keyboard and the editor's bar above it: popups keep out of it. */
export function coveredBottom() {
  const style = document.documentElement.style
  return (parseFloat(style.getPropertyValue("--kb")) || 0) + (parseFloat(style.getPropertyValue("--touchbar-h")) || 0)
}

/** Calls back when the keyboard opens, closes or changes height. */
export function onKeyboard(fn: Listener) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Keyboards are at least this tall; less is the browser's own bars moving. */
const MIN_KEYBOARD = 120

export function measure(innerHeight: number, viewport: { height: number; offsetTop: number; scale: number }) {
  // Zoomed in with two fingers, the visible part is smaller for that reason instead.
  if (viewport.scale > 1.01) return 0
  const kb = Math.round(innerHeight - viewport.height - viewport.offsetTop)
  return kb >= MIN_KEYBOARD ? kb : 0
}

export function watchKeyboard() {
  const vv = window.visualViewport
  if (!vv) return
  const root = document.documentElement
  let frame = 0
  const update = () => {
    const kb = measure(window.innerHeight, vv)
    // The page itself never scrolls inside the app, so if the keyboard slid
    // it up, slide it back: the frame now ends above the keyboard instead.
    if (kb > 0 && root.scrollHeight <= window.innerHeight + 1 && (window.scrollY > 0 || vv.offsetTop > 0)) window.scrollTo(0, 0)
    if (kb === covered) return
    covered = kb
    root.style.setProperty("--kb", `${kb}px`)
    root.toggleAttribute("data-keyboard", kb > 0)
    for (const fn of listeners) fn(kb)
    if (kb === 0) return
    // Once the frame has its new height, bring the field being typed in back into view.
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      const el = document.activeElement
      // The editor scrolls to its own caret (editor/touch-bar.tsx).
      if (el instanceof HTMLElement && !el.closest(".ProseMirror")) el.scrollIntoView({ block: "nearest" })
    })
  }
  vv.addEventListener("resize", update)
  vv.addEventListener("scroll", update)
  update()
}
