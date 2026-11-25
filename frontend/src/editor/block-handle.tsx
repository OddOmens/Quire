import { useEffect, useRef, useState } from "react"
import type { Editor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import { cn } from "cn"
import { ArrowDown, ArrowUp, Bookmark, Copy, FileSearch, GripVertical, Link2, MonitorPlay, Palette, Paperclip, Plus, Repeat2, Trash2 } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { dragSlop, edgeScroll, handlePlace, inTopHalf, sideZone } from "@/editor/drag"
import { containers, deleteBlockAt, duplicateBlockAt, moveBlockAt, moveBlockBeside, moveBlockTo } from "@/editor/blocks"
import { colorBlock } from "@/editor/marks"
import { linkCardOf, pdfBlockOf, type LinkCard } from "@/editor/media"
import { ColorSwatches } from "@/editor/menus"
import { coarsePointer, useCoarsePointer } from "@/lib/pointer"

const lists = new Set(["bulletList", "orderedList", "taskList"])
const listItems = new Set(["listItem", "taskItem"])

type Hit = { pos: number; node: PMNode; el: HTMLElement }

/** Sent to the editor's element to open the block menu for the block the caret is in. */
export const BLOCK_MENU_EVENT = "quire:block-menu"
type Box = { top: number; left: number; width: number; height: number }

/** How far left of the text the handle can sit (list items push it further). */
const GUTTER = 96

/**
 * The block under the pointer. Lists give their items; columns, callouts,
 * toggles and quotes give the blocks inside them. The first line of a
 * callout or quote stands for the whole of it, as a toggle's title does,
 * unless `exact` (used when dropping, where every gap counts).
 */
function blockAtPoint(view: EditorView, x: number, y: number, exact = false): Hit | null {
  const contains = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    return r.height > 0 && y >= r.top - 3 && y <= r.bottom + 3
  }
  const dom = (pos: number) => {
    const el = view.nodeDOM(pos)
    return el instanceof HTMLElement ? el : null
  }
  /** The child of the node whose content starts at `start` that is under the pointer. */
  const among = (parent: PMNode, start: number): Hit | null => {
    let hit: Hit | null = null
    parent.forEach((node, offset) => {
      if (hit) return
      const pos = start + offset
      const el = dom(pos)
      if (!el || !contains(el)) return
      const name = node.type.name
      const self = { pos, node, el }
      if (lists.has(name)) {
        hit = among(node, pos + 1) ?? self
      } else if (listItems.has(name)) {
        // A nested list's items come before the item that holds them.
        let nested: Hit | null = null
        node.forEach((child, coff) => {
          const cpos = pos + 1 + coff
          const cel = !nested && lists.has(child.type.name) ? dom(cpos) : null
          if (cel && contains(cel)) nested = among(child, cpos + 1)
        })
        hit = nested ?? self
      } else if (name === "columns") {
        // The column under the pointer; the gap between two belongs to the one on its right.
        let col: Hit | null = null
        node.forEach((column, coff) => {
          const cpos = pos + 1 + coff
          const cel = col ? null : dom(cpos)
          if (cel && x <= cel.getBoundingClientRect().right) col = among(column, cpos + 1) ?? { pos: cpos, node: column, el: cel }
        })
        const found = col as Hit | null
        // Under a short column there's nothing to pick but the columns as a whole.
        hit = found && found.node.type.name !== "column" ? found : exact && found ? found : self
      } else if (containers.has(name)) {
        const inner = among(node, pos + 1)
        const first = inner && inner.pos === pos + 1 && (name === "callout" || name === "blockquote")
        hit = inner && (exact || !first) ? inner : self
      } else {
        hit = self
      }
    })
    return hit
  }
  return among(view.state.doc, 0)
}

/** The top-level block closest to y, for a pointer that is over none. */
function nearestBlock(view: EditorView, y: number): Hit | null {
  let best: Hit | null = null
  let gap = Infinity
  view.state.doc.forEach((node, pos) => {
    const el = view.nodeDOM(pos)
    if (!(el instanceof HTMLElement)) return
    const r = el.getBoundingClientRect()
    const d = r.height > 0 ? Math.max(r.top - y, y - r.bottom, 0) : Infinity
    if (d < gap) {
      gap = d
      best = { pos, node, el }
    }
  })
  return best
}

type Drop =
  | { kind: "gap"; pos: number; line: Box }
  | { kind: "side"; beside: number; side: "left" | "right"; line: Box }

/**
 * Where the block at `from` lands if dropped at the pointer: in the gap
 * above or below the block there, anywhere on the page it fits; or, near a
 * block's left or right edge, beside it in columns. The box is the line to
 * draw, in viewport coordinates.
 */
function dropTarget(view: EditorView, from: number, x: number, y: number, sides = true): Drop | null {
  const { state } = view
  const node = state.doc.nodeAt(from)
  // Past the last block, before the first, or in the sliver between two: the nearest one.
  let hit = blockAtPoint(view, x, y, true) ?? nearestBlock(view, y)
  if (!node || !hit) return null
  const end = from + node.nodeSize
  if (hit.pos >= from && hit.pos < end) return null

  // Beside: the outer fifth of a block, for anything but list items.
  if (sides && !listItems.has(node.type.name) && node.type.name !== "columns") {
    let target: Hit | null = hit
    // A list is one block; inside columns, the column is what a new one goes beside.
    const $hit = state.doc.resolve(hit.pos)
    for (let d = $hit.depth; d > 0; d--) {
      const name = $hit.node(d).type.name
      if (lists.has(name) || name === "column") {
        const pos = $hit.before(d)
        const el = view.nodeDOM(pos)
        target = el instanceof HTMLElement ? { pos, node: $hit.node(d), el } : null
      }
    }
    if (target && target.node.type.name !== "columns") {
      const r = target.el.getBoundingClientRect()
      const side = sideZone(x, r, target.node.type.name === "column")
      if (side && moveBlockBeside(state, from, target.pos, side)) {
        return { kind: "side", beside: target.pos, side, line: { top: r.top, left: side === "left" ? r.left - 8 : r.right + 6, width: 2, height: r.height } }
      }
    }
  }

  // Under a short column: at the end of that column.
  if (hit.node.type.name === "column" && hit.node.type.contentMatch.matchType(node.type)) {
    const r = (hit.el.lastElementChild ?? hit.el).getBoundingClientRect()
    const c = hit.el.getBoundingClientRect()
    return { kind: "gap", pos: hit.pos + hit.node.nodeSize - 1, line: { top: r.bottom + 2, left: c.left, width: c.width, height: 2 } }
  }

  // Above or below: climb out until the block fits among its new neighbours.
  for (;;) {
    const $pos = state.doc.resolve(hit.pos)
    if ($pos.parent.canReplaceWith($pos.index(), $pos.index(), node.type)) break
    if ($pos.depth === 0) return null
    const pos = $pos.before()
    const el = view.nodeDOM(pos)
    if (!(el instanceof HTMLElement)) return null
    hit = { pos, node: $pos.parent, el }
    if (hit.pos >= from && hit.pos < end) return null
  }
  const r = hit.el.getBoundingClientRect()
  const before = inTopHalf(y, r)
  const pos = before ? hit.pos : hit.pos + hit.node.nodeSize
  return { kind: "gap", pos, line: { top: (before ? r.top - 4 : r.bottom + 3) - 1, left: r.left, width: r.width, height: 2 } }
}

/**
 * The block the caret is in (or the block that is selected whole), as
 * blockAtPoint would give it. A touch screen has no pointer resting over a
 * block, so this is the block its grip is for.
 */
function blockAtCaret(view: EditorView): Hit | null {
  const { selection } = view.state
  if (selection instanceof NodeSelection && selection.node.isBlock) {
    const el = view.nodeDOM(selection.from)
    if (el instanceof HTMLElement) {
      const r = el.getBoundingClientRect()
      return blockAtPoint(view, r.left + 1, r.top + Math.min(r.height / 2, 12))
    }
  }
  try {
    const at = view.coordsAtPos(selection.from)
    return blockAtPoint(view, at.left + 1, (at.top + at.bottom) / 2)
  } catch {
    // The page is being redrawn; the next change asks again.
    return null
  }
}

/** The left edge of what the page scrolls in: the grip stays right of it. */
function scrollerLeft(el: HTMLElement) {
  for (let e = el.parentElement; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY
    if (o === "auto" || o === "scroll") return e.getBoundingClientRect().left
  }
  return 0
}

/** Below this the page is too narrow for columns worth making by dragging. */
const SIDE_BY_SIDE_MIN = 560

/** The nearest ancestor that scrolls vertically. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let e = el.parentElement; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY
    if ((o === "auto" || o === "scroll") && e.scrollHeight > e.clientHeight) return e
  }
  return null
}

const turnInto = [
  { label: "Text", run: (e: Editor) => e.chain().focus().setParagraph().run() },
  { label: "Heading 1", run: (e: Editor) => e.chain().focus().setHeading({ level: 1 }).run() },
  { label: "Heading 2", run: (e: Editor) => e.chain().focus().setHeading({ level: 2 }).run() },
  { label: "Heading 3", run: (e: Editor) => e.chain().focus().setHeading({ level: 3 }).run() },
  { label: "Heading 4", run: (e: Editor) => e.chain().focus().setHeading({ level: 4 }).run() },
  { label: "Bulleted list", run: (e: Editor) => e.chain().focus().toggleBulletList().run() },
  { label: "Numbered list", run: (e: Editor) => e.chain().focus().toggleOrderedList().run() },
  { label: "To-do list", run: (e: Editor) => e.chain().focus().toggleTaskList().run() },
  { label: "Toggle", run: (e: Editor) => e.chain().focus().setToggle().run() },
  { label: "Toggle heading 1", run: (e: Editor) => e.chain().focus().setToggle(1).run() },
  { label: "Toggle heading 2", run: (e: Editor) => e.chain().focus().setToggle(2).run() },
  { label: "Toggle heading 3", run: (e: Editor) => e.chain().focus().setToggle(3).run() },
  { label: "Quote", run: (e: Editor) => e.chain().focus().toggleBlockquote().run() },
  { label: "Callout", run: (e: Editor) => e.chain().focus().toggleCallout().run() },
  { label: "Code block", run: (e: Editor) => e.chain().focus().toggleCodeBlock().run() },
]

/** What a toggle can become: a plain toggle or a toggle heading. */
const toggleKinds = [
  { label: "Toggle", level: 0 },
  { label: "Toggle heading 1", level: 1 },
  { label: "Toggle heading 2", level: 2 },
  { label: "Toggle heading 3", level: 3 },
]

/** The handle as shown: which block it's for, where it sits, and what its menu offers. */
type Handle = {
  pos: number
  top: number
  left: number
  /** The grip's width: a finger gets as much as the page's margin has. */
  width: number
  textblock: boolean
  type: string
  /** How a line that is only a web link is showing, and whether its site can be embedded. */
  link: "" | LinkCard
  embeddable: boolean
  /** An attached PDF, as a file card or as a preview. */
  pdf: "" | "card" | "preview"
}

/**
 * The ⋮⋮ grip and + beside the block under the pointer. Drag the grip to
 * move the block; click it for block actions. On a touch screen the grip
 * (alone: the bar above the keyboard adds blocks) sits beside the block the
 * caret is in, and is dragged or tapped the same way.
 */
export function BlockHandle({ editor, container }: { editor: Editor; container: React.RefObject<HTMLDivElement | null> }) {
  const [hit, setHit] = useState<Handle | null>(null)
  const [menu, setMenu] = useState(false)
  const [drag, setDrag] = useState<{ source: Box; line: Box | null } | null>(null)
  const dragging = useRef(false)
  const dragged = useRef(false)
  const menuRef = useRef(menu)
  menuRef.current = menu
  const hitRef = useRef(hit)
  hitRef.current = hit
  const touch = useCoarsePointer()
  /** Puts the touch grip back beside the caret's block, after a drag say. */
  const resync = useRef(() => {})

  useEffect(() => {
    const view = editor.view
    const box = container.current
    if (!box) return
    // The handle sits in the gutter left of the text, outside the box, so
    // track the pointer over the box plus that gutter rather than the box alone.
    const onMove = (e: MouseEvent) => {
      // A tap also sends a mouse move; on a touch screen the caret decides.
      if (coarsePointer()) return
      if (dragging.current || menuRef.current || !editor.isEditable) return
      const b = box.getBoundingClientRect()
      if (e.clientX < b.left - GUTTER || e.clientX > b.right + 16 || e.clientY < b.top || e.clientY > b.bottom) {
        setHit(null)
        return
      }
      // On the way from a block to its handle the pointer may cross other
      // blocks (the column to the left, say): it still means this block.
      const now = hitRef.current
      const held = now && view.nodeDOM(now.pos)
      if (now && held instanceof HTMLElement) {
        const hr = held.getBoundingClientRect()
        if (e.clientY >= hr.top - 3 && e.clientY <= hr.bottom + 3 && e.clientX < hr.left && e.clientX >= b.left + now.left - 4) return
      }
      const h = blockAtPoint(view, e.clientX, e.clientY)
      if (h) place(h)
    }
    const place = (h: Hit) => {
      const b = box.getBoundingClientRect()
      const r = h.el.getBoundingClientRect()
      const card = linkCardOf(h.node)
      // Line up with the block's first line of text.
      const style = getComputedStyle(h.el)
      const line = parseFloat(style.lineHeight) || 26
      const first = h.node.type.name === "listItem" || h.node.type.name === "taskItem" ? 26 : Math.min(r.height, line)
      const fingers = coarsePointer()
      const at = handlePlace(r, b, {
        firstLine: first,
        indent: h.node.type.name === "taskItem" ? 6 : h.node.type.name === "listItem" ? 26 : 0,
        touch: fingers,
        limit: fingers ? scrollerLeft(box) : 0,
      })
      const next: Handle = {
        pos: h.pos,
        ...at,
        textblock: h.node.isTextblock || h.node.firstChild?.isTextblock === true,
        type: h.node.type.name,
        link: card?.kind ?? "",
        embeddable: card?.embeddable ?? false,
        pdf: pdfBlockOf(h.node) ?? "",
      }
      // Typing asks again on every letter; nothing has moved most times.
      setHit((prev) => (prev && (Object.keys(next) as (keyof Handle)[]).every((k) => prev[k] === next[k]) ? prev : next))
    }
    // Touch screens have no pointer to hover with: the grip goes beside the
    // block the caret is in, once the page has been tapped into, and stays
    // there with the keyboard put away so there's a whole screen to drag in.
    let tapped = editor.isFocused
    // A field of a block's own that was tapped into, like a toggle's title:
    // the caret is elsewhere then, and the grip is for that block.
    let field: HTMLElement | null = null
    let frame = 0
    const sync = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!coarsePointer() || dragging.current || menuRef.current || view.isDestroyed) return
        let h: Hit | null = null
        if (tapped && editor.isEditable) {
          const r = field?.isConnected ? field.getBoundingClientRect() : null
          h = r ? blockAtPoint(view, r.left + 1, r.top + r.height / 2) : blockAtCaret(view)
        }
        if (h) place(h)
        else setHit(null)
      })
    }
    resync.current = sync
    const onFocus = (e: FocusEvent) => {
      const el = e.target
      field = el instanceof HTMLElement && el !== view.dom && !el.isContentEditable ? el : null
      tapped = true
      sync()
    }
    const onLeave = () => {
      if (!menuRef.current && !dragging.current) setHit(null)
    }
    // The bar above the keyboard (touch-bar.tsx) asks for the menu of the
    // block the caret is in.
    const onAsk = () => {
      if (!editor.isEditable) return
      const h = blockAtCaret(view)
      if (!h) return
      place(h)
      setMenu(true)
    }
    view.dom.addEventListener(BLOCK_MENU_EVENT, onAsk)
    window.addEventListener("mousemove", onMove)
    document.addEventListener("mouseleave", onLeave)
    const hide = () => (coarsePointer() ? sync() : !menuRef.current && !dragging.current && setHit(null))
    editor.on("update", hide)
    editor.on("selectionUpdate", sync)
    view.dom.addEventListener("focusin", onFocus)
    // Pictures loading, the keyboard opening and the screen turning all move blocks.
    const resized = new ResizeObserver(sync)
    resized.observe(view.dom)
    return () => {
      cancelAnimationFrame(frame)
      resized.disconnect()
      editor.off("selectionUpdate", sync)
      view.dom.removeEventListener("focusin", onFocus)
      window.removeEventListener("mousemove", onMove)
      document.removeEventListener("mouseleave", onLeave)
      view.dom.removeEventListener(BLOCK_MENU_EVENT, onAsk)
      editor.off("update", hide)
    }
  }, [editor, container])

  if (!hit || !editor.isEditable) return null
  const view = editor.view

  /**
   * Drags with pointer events rather than the browser's drag and drop,
   * which behaves differently from browser to browser around editable text.
   * Escape cancels.
   */
  const startDrag = (e: React.PointerEvent) => {
    const box = container.current
    if (e.button !== 0 || !box) return
    const from = hit.pos
    const doc = view.state.doc
    const node = doc.nodeAt(from)
    if (!node) return
    const scroller = scrollParent(box)
    const pointer = e.pointerId
    const slop = dragSlop(e.pointerType)
    const fingers = e.pointerType === "touch" || coarsePointer()
    // On a phone, a block dropped at another's edge would make columns too thin to read.
    const sides = box.getBoundingClientRect().width >= SIDE_BY_SIDE_MIN
    // Without the keyboard up, moving a block shouldn't bring it up.
    const focused = view.hasFocus()
    const startX = e.clientX
    const startY = e.clientY
    let x = startX
    let y = startY
    let active = false
    let target: Drop | null = null
    let frame = 0

    const update = () => {
      const el = view.nodeDOM(from)
      if (!(el instanceof HTMLElement)) return
      const b = box.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      target = dropTarget(view, from, x, y, sides)
      // Dropping right where it already is moves nothing.
      if (target?.kind === "gap" && target.pos >= from && target.pos <= from + node.nodeSize) target = null
      setDrag({
        source: { top: r.top - b.top, left: r.left - b.left, width: r.width, height: r.height },
        line: target ? { ...target.line, top: target.line.top - b.top, left: target.line.left - b.left } : null,
      })
    }
    // Scroll while the pointer is near the top or bottom edge.
    const tick = () => {
      if (scroller) {
        const dy = edgeScroll(y, scroller.getBoundingClientRect())
        if (dy) {
          scroller.scrollTop += dy
          update()
        }
      }
      frame = requestAnimationFrame(tick)
    }
    const move = (ev: PointerEvent) => {
      // A second finger on the screen isn't the one holding the block.
      if (ev.pointerId !== pointer) return
      x = ev.clientX
      y = ev.clientY
      if (!active) {
        if (Math.abs(y - startY) < slop && Math.abs(x - startX) < slop) return
        active = true
        dragging.current = true
        document.documentElement.classList.add("block-dragging")
        frame = requestAnimationFrame(tick)
      }
      update()
    }
    const end = (commit: boolean) => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", cancel)
      window.removeEventListener("keydown", key, true)
      cancelAnimationFrame(frame)
      if (!active) return
      document.documentElement.classList.remove("block-dragging")
      dragging.current = false
      // Letting go over the grip would otherwise open its menu.
      dragged.current = true
      setTimeout(() => (dragged.current = false))
      setDrag(null)
      if (!fingers) setHit(null)
      // Skip if the page changed underneath, from a reload off disk say.
      if (commit && target && view.state.doc === doc) {
        const tr = target.kind === "gap" ? moveBlockTo(view.state, from, target.pos) : moveBlockBeside(view.state, from, target.beside, target.side)
        if (tr) view.dispatch(tr.scrollIntoView())
      }
      if (focused || !fingers) view.focus()
      // The grip follows the block to where it landed.
      if (fingers) resync.current()
    }
    const up = (ev: PointerEvent) => ev.pointerId === pointer && end(true)
    const cancel = (ev: PointerEvent) => ev.pointerId === pointer && end(false)
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return
      ev.preventDefault()
      ev.stopPropagation()
      end(false)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", cancel)
    window.addEventListener("keydown", key, true)
  }

  const selectBlock = () => {
    const node = view.state.doc.nodeAt(hit.pos)
    if (!node) return
    // Put the cursor inside so "turn into" acts on this block.
    const inside = node.isTextblock ? hit.pos + 1 : hit.pos + 2
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(Math.min(inside, view.state.doc.content.size)))))
  }
  // The menu holds on to focus until it has closed, so hand it back to the
  // text afterwards; otherwise ⌘Z and typing go nowhere.
  const refocus = () => setTimeout(() => !view.isDestroyed && view.focus())
  const run = (tr: ReturnType<typeof moveBlockAt>) => {
    if (tr) view.dispatch(tr)
    refocus()
    setHit(null)
  }

  return (
    <>
      {drag && <div className="block-drag-source" style={drag.source} />}
      {drag?.line && <div className="block-drop-line" style={drag.line} />}
      <div className={cn("block-handle", touch && "touch", drag && (touch ? "lifted" : "invisible"))} style={{ top: hit.top, left: hit.left }} contentEditable={false}>
        {!touch && <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Add a block below"
              className="block-handle-btn"
              onClick={() => {
                const node = view.state.doc.nodeAt(hit.pos)
                if (!node) return
                const at = hit.pos + node.nodeSize
                const para = view.state.schema.nodes.paragraph.create(null, view.state.schema.text("/"))
                const tr = view.state.tr.insert(at, para)
                tr.setSelection(TextSelection.create(tr.doc, at + 2))
                view.dispatch(tr)
                view.focus()
                setHit(null)
              }}
            >
              <Plus className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Add a block below</TooltipContent>
        </Tooltip>}
        <DropdownMenu open={menu} onOpenChange={setMenu}>
          <span className="relative grid">
            {/* The menu anchors here; the grip opens it on click only, so dragging doesn't. */}
            <DropdownMenuTrigger asChild>
              <span aria-hidden className="pointer-events-none absolute inset-0" />
            </DropdownMenuTrigger>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={touch ? "Drag to move, tap for options" : "Drag to move, click for options"}
                  aria-haspopup="menu"
                  aria-expanded={menu}
                  className="block-handle-btn cursor-grab touch-none active:cursor-grabbing"
                  style={touch ? { width: hit.width } : undefined}
                  // Keep focus and the text selection in the editor.
                  onMouseDown={(e) => e.preventDefault()}
                  onPointerDown={startDrag}
                  onClick={() => !dragged.current && setMenu(true)}
                >
                  <GripVertical className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" hidden={touch}>
                <span className="font-medium">Drag</span> to move · <span className="font-medium">Click</span> for options
              </TooltipContent>
            </Tooltip>
          </span>
          <DropdownMenuContent align="start" side="bottom" className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
            {hit.type === "toggle" ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Repeat2 /> Turn into
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-44">
                  {toggleKinds.map((t) => (
                    <DropdownMenuItem
                      key={t.label}
                      onSelect={() => {
                        const node = view.state.doc.nodeAt(hit.pos)
                        if (node) run(view.state.tr.setNodeMarkup(hit.pos, undefined, { ...node.attrs, level: t.level }))
                      }}
                    >
                      {t.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : hit.textblock && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Repeat2 /> Turn into
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-44">
                  {turnInto.map((t) => (
                    <DropdownMenuItem
                      key={t.label}
                      onSelect={() => {
                        selectBlock()
                        t.run(editor)
                        refocus()
                        setHit(null)
                      }}
                    >
                      {t.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {hit.link &&
              (["link", "bookmark", "embed"] as const)
                .filter((kind) => kind !== hit.link && (kind !== "embed" || hit.embeddable))
                .map((kind) => (
                  <DropdownMenuItem
                    key={kind}
                    onSelect={() => {
                      editor.commands.setLinkCard(kind, hit.pos)
                      refocus()
                      setHit(null)
                    }}
                  >
                    {kind === "link" ? <Link2 /> : kind === "bookmark" ? <Bookmark /> : <MonitorPlay />}
                    {kind === "link" ? "Show as a link" : kind === "bookmark" ? "Show as a bookmark" : "Show as an embed"}
                  </DropdownMenuItem>
                ))}
            {hit.pdf && (
              <DropdownMenuItem
                onSelect={() => {
                  editor.commands.togglePdfPreview(hit.pos)
                  setHit(null)
                }}
              >
                {hit.pdf === "card" ? <FileSearch /> : <Paperclip />} {hit.pdf === "card" ? "Show a preview" : "Show as a file card"}
              </DropdownMenuItem>
            )}
            {hit.type !== "horizontalRule" && hit.type !== "image" && hit.type !== "embed" && hit.type !== "toc" && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Palette /> Colour
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-[11.5rem] p-0">
                  <ColorSwatches
                    menu
                    onText={(c) => {
                      colorBlock(editor, hit.pos, "text", c)
                      refocus()
                      setHit(null)
                    }}
                    onBackground={(c) => {
                      colorBlock(editor, hit.pos, "background", c)
                      refocus()
                      setHit(null)
                    }}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuItem onSelect={() => run(moveBlockAt(view.state, hit.pos, "up"))}>
              <ArrowUp /> Move up <DropdownMenuShortcut>⌘⇧↑</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => run(moveBlockAt(view.state, hit.pos, "down"))}>
              <ArrowDown /> Move down <DropdownMenuShortcut>⌘⇧↓</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => run(duplicateBlockAt(view.state, hit.pos))}>
              <Copy /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => run(deleteBlockAt(view.state, hit.pos))}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  )
}
