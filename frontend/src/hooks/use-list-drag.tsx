import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

/** How far the pointer moves before a press on a row becomes a drag. */
export const DRAG_START = 4
/** How long a finger rests on a row before it picks the row up. */
export const LONG_PRESS = 400

/** The nearest ancestor that scrolls vertically. */
export function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let e = el.parentElement; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY
    if ((o === "auto" || o === "scroll") && e.scrollHeight > e.clientHeight) return e
  }
  return null
}

/** list with the item at from moved to index to. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/** The row being dragged, and where the insertion line is (from the list's top), if anywhere. */
type ListDrag = { from: number; line: number | null }

/**
 * Drags the rows of a flat list into a new order. Rows are the elements
 * marked data-index inside boxRef, which needs `position: relative` for the
 * line. With a mouse or pen a row lifts once the pointer moves a little, so
 * a click still works; with a finger after a long press, so a swipe still
 * scrolls, or at once from an element marked data-grip. Escape cancels.
 * Uses pointer events rather than the browser's drag and drop, which some
 * browsers don't deliver reliably, and which menus and dialogs fight with.
 */
export function useListDrag(onDrop: (from: number, to: number) => void) {
  const boxRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const ghostAt = useRef({ x: 0, y: 0 })
  const cancelDrag = useRef<(() => void) | null>(null)
  const [drag, setDrag] = useState<ListDrag | null>(null)
  const lifted = drag !== null

  useEffect(() => () => cancelDrag.current?.(), [])

  const paintGhost = () => {
    const g = ghostRef.current
    if (g) g.style.transform = `translate(${ghostAt.current.x}px, ${ghostAt.current.y}px)`
  }
  useLayoutEffect(paintGhost, [lifted])

  const start = (e: React.PointerEvent<HTMLElement>, from: number) => {
    const box = boxRef.current
    if (!box || cancelDrag.current || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return
    if ((e.target as Element).closest("[data-nodrag]")) return
    const touch = e.pointerType === "touch"
    const grip = touch && !!(e.target as Element).closest("[data-grip]")
    const scroller = scrollParent(box)
    const startX = e.clientX
    const startY = e.clientY
    // The ghost sits beside the pointer, or above a finger, so the line stays visible.
    const offset = touch ? { x: 16, y: -48 } : { x: 14, y: 10 }
    let x = startX
    let y = startY
    let active = false
    let to: number | null = null
    let line: number | null = null
    let frame = 0
    const press = touch && !grip ? setTimeout(() => activate(), LONG_PRESS) : undefined

    const update = () => {
      const b = box.getBoundingClientRect()
      const rows = [...box.querySelectorAll<HTMLElement>("[data-index]")].map((el) => el.getBoundingClientRect())
      let next: number | null = null
      let top: number | null = null
      if (rows.length && x >= b.left - 48 && x <= b.right + 48 && y >= b.top - 48 && y <= b.bottom + 48) {
        let gap = rows.findIndex((r) => y < r.top + r.height / 2)
        if (gap < 0) gap = rows.length
        // Either side of the row itself changes nothing.
        if (gap !== from && gap !== from + 1) {
          next = gap > from ? gap - 1 : gap
          const above = rows[gap - 1]
          const below = rows[gap]
          const mid = above && below ? (above.bottom + below.top) / 2 : below ? below.top - 1 : above.bottom + 1
          top = mid - b.top - 1
        }
      }
      to = next
      if (top !== line) {
        line = top
        setDrag({ from, line })
      }
    }
    // Scroll the list while the pointer is near its top or bottom edge.
    const tick = () => {
      if (scroller) {
        const r = scroller.getBoundingClientRect()
        const edge = 32
        const dy = y < r.top + edge ? (y - r.top - edge) / 3 : y > r.bottom - edge ? (y - r.bottom + edge) / 3 : 0
        if (dy) {
          scroller.scrollTop += Math.max(-12, Math.min(12, dy))
          update()
        }
      }
      frame = requestAnimationFrame(tick)
    }
    const activate = () => {
      if (active) return
      active = true
      ghostAt.current = { x: x + offset.x, y: y + offset.y }
      setDrag({ from, line: null })
      document.documentElement.classList.add("list-dragging")
      window.getSelection()?.removeAllRanges()
      frame = requestAnimationFrame(tick)
      update()
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      x = ev.clientX
      y = ev.clientY
      if (!active) {
        const far = Math.hypot(x - startX, y - startY)
        // A finger that moves before the long press is scrolling.
        if (touch && !grip) {
          if (far > 8) end(false)
          return
        }
        if (far < DRAG_START) return
        activate()
      }
      ghostAt.current = { x: x + offset.x, y: y + offset.y }
      paintGhost()
      update()
    }
    const end = (commit: boolean) => {
      clearTimeout(press)
      cancelAnimationFrame(frame)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up, true)
      window.removeEventListener("pointercancel", cancel)
      window.removeEventListener("keydown", key, true)
      window.removeEventListener("touchmove", hold)
      window.removeEventListener("contextmenu", noMenu, true)
      cancelDrag.current = null
      if (!active) return
      document.documentElement.classList.remove("list-dragging")
      // Letting go over a row would otherwise click it: in a menu, that
      // picks the item. This runs before the row sees the pointer go up, and
      // stops the one click that follows, but never a later one.
      const done = () => {
        window.removeEventListener("click", swallow, true)
        window.removeEventListener("pointerdown", done, true)
        window.removeEventListener("keydown", done, true)
      }
      const swallow = (ev: MouseEvent) => {
        ev.preventDefault()
        ev.stopPropagation()
        done()
      }
      window.addEventListener("click", swallow, true)
      window.addEventListener("pointerdown", done, true)
      window.addEventListener("keydown", done, true)
      setTimeout(done)
      setDrag(null)
      if (commit && to !== null) onDrop(from, to)
    }
    const up = (ev: PointerEvent) => ev.pointerId === e.pointerId && end(true)
    const cancel = (ev: PointerEvent) => ev.pointerId === e.pointerId && end(false)
    // Escape cancels the drag, and only the drag: the menu or dialog stays open.
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !active) return
      ev.preventDefault()
      ev.stopPropagation()
      end(false)
    }
    // Once a finger has picked a row up, it drags instead of scrolling.
    const hold = (ev: TouchEvent) => {
      if (active && ev.cancelable) ev.preventDefault()
    }
    const noMenu = (ev: Event) => {
      if (active || touch) ev.preventDefault()
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up, true)
    window.addEventListener("pointercancel", cancel)
    window.addEventListener("keydown", key, true)
    window.addEventListener("touchmove", hold, { passive: false })
    window.addEventListener("contextmenu", noMenu, true)
    cancelDrag.current = () => end(false)
  }

  return { boxRef, ghostRef, drag, start }
}

/** The row under the pointer while it's dragged. */
export function DragGhost({ ghostRef, children }: { ghostRef: React.Ref<HTMLDivElement>; children: React.ReactNode }) {
  return createPortal(
    <div
      ref={ghostRef}
      aria-hidden
      className="pointer-events-none fixed top-0 left-0 z-[60] flex h-8 w-max max-w-56 items-center gap-2 rounded-md border bg-popover/95 px-2.5 text-sm text-popover-foreground shadow-lg"
    >
      {children}
    </div>,
    document.body,
  )
}

/** Where a dragged row would land. */
export function DropLine({ top }: { top: number }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-1.5 z-10 h-0.5 rounded-full bg-brand before:absolute before:-top-[3px] before:-left-1.5 before:size-2 before:rounded-full before:border-2 before:border-brand before:bg-popover before:content-['']"
      style={{ top }}
    />
  )
}
