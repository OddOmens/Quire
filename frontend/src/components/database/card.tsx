import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { cn } from "cn"

import { CellView, CheckMark } from "@/components/database/cells"
import { DRAG_START, LONG_PRESS, scrollParent } from "@/hooks/use-list-drag"
import { fileUrl, type Column, type Row, type TableData, type View } from "@/lib/api"
import { cellOf, display, fileList } from "@/lib/table"

/**
 * Where a dragged card would land: the drop zone under the pointer (an
 * element marked data-drop) and the card (data-card) it would go before,
 * or "" for the end of the zone.
 */
export type DropTarget = { zone: string; before: string }

/**
 * Drags cards between zones: board lanes, calendar days. Like useListDrag it
 * uses pointer events rather than the browser's drag and drop (which some
 * browsers don't deliver), lifts after a small move with a mouse or a long
 * press with a finger, and Escape cancels.
 */
export function usePointerDrag<T>(onDrop: (item: T, target: DropTarget) => void) {
  const [drag, setDrag] = useState<{ item: T; target: DropTarget | null } | null>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const ghostAt = useRef({ x: 0, y: 0 })
  const cancel = useRef<(() => void) | null>(null)
  const drop = useRef(onDrop)
  drop.current = onDrop
  const lifted = drag !== null

  useEffect(() => () => cancel.current?.(), [])
  const paint = () => {
    const g = ghostRef.current
    if (g) g.style.transform = `translate(${ghostAt.current.x}px, ${ghostAt.current.y}px)`
  }
  useLayoutEffect(paint, [lifted])

  const start = (e: React.PointerEvent<HTMLElement>, item: T) => {
    if (cancel.current || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return
    if ((e.target as Element).closest("[data-nodrag],a,input,textarea")) return
    const touch = e.pointerType === "touch"
    const startX = e.clientX
    const startY = e.clientY
    const offset = touch ? { x: 16, y: -48 } : { x: 12, y: 8 }
    let x = startX
    let y = startY
    let active = false
    let target: DropTarget | null = null
    let frame = 0
    const press = touch ? setTimeout(() => activate(), LONG_PRESS) : undefined

    const hit = (): DropTarget | null => {
      const el = document.elementFromPoint(x, y)
      const zone = el?.closest<HTMLElement>("[data-drop]")
      if (!zone) return null
      const cards = [...zone.querySelectorAll<HTMLElement>("[data-card]")]
      const next = cards.find((c) => {
        const r = c.getBoundingClientRect()
        return y < r.top + r.height / 2
      })
      return { zone: zone.dataset.drop ?? "", before: next?.dataset.card ?? "" }
    }
    const update = () => {
      const t = hit()
      if (t?.zone !== target?.zone || t?.before !== target?.before) {
        target = t
        setDrag({ item, target })
      }
    }
    // Scroll whatever is under the pointer when it nears an edge.
    const tick = () => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null
      const h = el?.closest<HTMLElement>("[data-hscroll]")
      if (h) {
        const r = h.getBoundingClientRect()
        const dx = x < r.left + 40 ? -10 : x > r.right - 40 ? 10 : 0
        if (dx) h.scrollLeft += dx
      }
      const v = el ? scrollParent(el) : null
      if (v) {
        const r = v.getBoundingClientRect()
        const dy = y < r.top + 32 ? -10 : y > r.bottom - 32 ? 10 : 0
        if (dy) v.scrollTop += dy
      }
      frame = requestAnimationFrame(tick)
    }
    const activate = () => {
      if (active) return
      active = true
      ghostAt.current = { x: x + offset.x, y: y + offset.y }
      setDrag({ item, target: null })
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
        if (touch) {
          if (far > 8) end(false) // a finger that moves first is scrolling
          return
        }
        if (far < DRAG_START) return
        activate()
      }
      ghostAt.current = { x: x + offset.x, y: y + offset.y }
      paint()
      update()
    }
    const end = (commit: boolean) => {
      clearTimeout(press)
      cancelAnimationFrame(frame)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up, true)
      window.removeEventListener("pointercancel", cancelEv)
      window.removeEventListener("keydown", key, true)
      window.removeEventListener("touchmove", hold)
      window.removeEventListener("contextmenu", noMenu, true)
      cancel.current = null
      if (!active) return
      document.documentElement.classList.remove("list-dragging")
      // Letting go over a card would click it open; swallow that one click.
      const done = () => {
        window.removeEventListener("click", swallow, true)
        window.removeEventListener("pointerdown", done, true)
      }
      const swallow = (ev: MouseEvent) => {
        ev.preventDefault()
        ev.stopPropagation()
        done()
      }
      window.addEventListener("click", swallow, true)
      window.addEventListener("pointerdown", done, true)
      setTimeout(done)
      setDrag(null)
      if (commit && target) drop.current(item, target)
    }
    const up = (ev: PointerEvent) => ev.pointerId === e.pointerId && end(true)
    const cancelEv = (ev: PointerEvent) => ev.pointerId === e.pointerId && end(false)
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !active) return
      ev.preventDefault()
      ev.stopPropagation()
      end(false)
    }
    const hold = (ev: TouchEvent) => {
      if (active && ev.cancelable) ev.preventDefault()
    }
    const noMenu = (ev: Event) => {
      if (active || touch) ev.preventDefault()
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up, true)
    window.addEventListener("pointercancel", cancelEv)
    window.addEventListener("keydown", key, true)
    window.addEventListener("touchmove", hold, { passive: false })
    window.addEventListener("contextmenu", noMenu, true)
    cancel.current = () => end(false)
  }

  return { drag, ghostRef, start }
}

/**
 * Props that make a card open its row on click or Enter. A div rather than a
 * button, since the card holds links and chips of its own.
 */
export function opener(open: () => void) {
  return {
    role: "button",
    tabIndex: 0,
    onClick: open,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        open()
      }
    },
  } as const
}

/** Whether a cell has something worth showing on a card. */
function shown(data: TableData, row: Row, col: Column) {
  const c = cellOf(data, row, col)
  if (c.kind === "bool") return c.b
  if (c.kind === "error") return true
  return display(c, col) !== ""
}

/** The fields a card shows: visible in the view, not the title, not empty. */
export function cardFields(data: TableData, view: View, row: Row, skip: string[] = []) {
  const hidden = new Set([...(view.hidden ?? []), ...skip])
  return data.schema.columns.slice(1).filter((c) => !hidden.has(c.id) && shown(data, row, c))
}

const imageExt = /\.(png|jpe?g|gif|webp|avif)$/i

/** The first picture in the row's file columns, for a gallery cover. */
export function coverOf(data: TableData, view: View, row: Row) {
  const hidden = new Set(view.hidden ?? [])
  for (const c of data.schema.columns) {
    if (c.type !== "file" || hidden.has(c.id)) continue
    const img = fileList(row.cells[c.id] ?? "").find((p) => imageExt.test(p))
    if (img) return fileUrl(img)
  }
  return ""
}

/** A row as a card: its title, then its fields, compactly. */
export function RowCard({
  data,
  view,
  row,
  skip,
  cover,
  openRow,
  className,
  limit = 6,
}: {
  data: TableData
  view: View
  row: Row
  skip?: string[]
  cover?: string
  openRow: (path: string, id: string) => void
  className?: string
  limit?: number
}) {
  const primary = data.schema.columns[0]
  const title = row.cells[primary.id]?.trim()
  const fields = cardFields(data, view, row, skip).slice(0, limit)
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-card text-left text-card-foreground shadow-xs transition-colors hover:bg-accent/40", className)}>
      {cover !== undefined && (
        <div className="aspect-[16/10] w-full overflow-hidden border-b bg-muted">
          {cover && <img src={cover} alt="" loading="lazy" draggable={false} className="size-full object-cover" />}
        </div>
      )}
      <div className="grid gap-1.5 px-3 py-2.5">
        <div className={cn("text-sm leading-snug font-medium break-words", !title && "text-muted-foreground")}>{title || "Untitled"}</div>
        {fields.map((c) => (
          <div key={c.id} title={c.name} className="flex min-w-0 items-center gap-1.5 text-[0.8125rem] text-muted-foreground [&_a]:text-[0.8125rem]">
            {c.type === "checkbox" || (cellOf(data, row, c).kind === "bool" && c.type !== "select") ? (
              <>
                <CheckMark checked className="size-3.5" />
                <span className="truncate">{c.name}</span>
              </>
            ) : (
              <span className="min-w-0 truncate text-foreground/85">
                <CellView data={data} row={row} col={c} onOpenRow={openRow} />
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
