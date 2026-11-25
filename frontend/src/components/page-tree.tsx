import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { Editor } from "@tiptap/core"
import { cn } from "cn"
import { ArrowDown, ArrowUp, ChevronRight, Copy, FileText, FolderInput, MoreHorizontal, Pencil, Plus, Table2, Trash2 } from "lucide-react"
import { Link } from "react-router"
import { toast } from "sonner"

import { useDialogs } from "@/components/dialogs"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSidebar } from "@/components/ui/sidebar"
import { DRAG_START, LONG_PRESS, scrollParent } from "@/hooks/use-list-drag"
import { useCurrentPath, useResolver, useTree, useVaultActions } from "@/hooks/use-vault"
import { ancestorsOf, baseOf, folderOf, pageUrl, parentOf, type PageNode } from "@/lib/notes"
import { openMoveDialog, openNewDatabase } from "@/lib/ui-events"

const OPEN_KEY = "quire.open"
/** How long to hover over a collapsed page before it opens. */
const EXPAND_DELAY = 600
/** How far left or right to move per level when dropping between pages. */
const INDENT_STEP = 20

function loadOpen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]"))
  } catch {
    return new Set()
  }
}

const count = (n: PageNode): number => n.children.reduce((s, c) => s + 1 + count(c), 0)

/** Where a dragged page goes: under parent (a space or page path), before a sibling or last. */
type Drop = { parent: string; before: string; into?: string }
/** What the tree shows for it: an insertion line, or a highlighted row to nest under. */
type Hint = { line?: { top: number; left: number; width: number }; into?: string }
type VisibleRow = { path: string; base: string; depth: number; open: boolean; kids: boolean; r: DOMRect }

/**
 * Works out the drop under the pointer. The top and bottom quarter of a row
 * drop between pages; the middle nests under that page. Between pages, at
 * the end of a group of sub-pages, moving left or right picks the level.
 * Below every page means the end of the space's top level.
 */
function locate(box: HTMLElement, space: string, self: string, depth0: number, dx: number, x: number, y: number): { drop: Drop; hint: Hint } | null {
  const b = box.getBoundingClientRect()
  if (x < b.left - 48 || x > b.right + 48) return null
  const rows: VisibleRow[] = [...box.querySelectorAll<HTMLElement>("[data-row]")].map((el) => {
    const path = el.dataset.row!
    return { path, base: baseOf(path), depth: Number(el.dataset.depth), open: el.dataset.open === "1", kids: el.dataset.kids === "1", r: el.getBoundingClientRect() }
  })
  const within = (base: string) => base === self || base.startsWith(self + "/")
  if (!rows.length) return { drop: { parent: space, before: "" }, hint: {} }
  const last = rows[rows.length - 1]

  const gap = (g: number, forced?: number) => {
    const above = rows[g - 1]
    const below = rows[g]
    const max = above ? above.depth + (above.open ? 1 : 0) : 0
    const min = below ? below.depth : 0
    const depth = Math.max(min, Math.min(max, forced ?? depth0 + Math.round(dx / INDENT_STEP)))
    let folder: string
    let before = ""
    if (below && below.depth === depth) {
      folder = folderOf(below.base)
      before = below.path
    } else {
      folder = folderOf(above.base.split("/").slice(0, depth + 2).join("/"))
    }
    if (within(folder)) return null
    // Dropping right where it already is changes nothing.
    if (folder === folderOf(self)) {
      const i = rows.findIndex((r) => r.base === self)
      const next = rows.slice(i + 1).find((r) => r.depth <= depth0)
      const after = next && next.depth === depth0 ? next.path : ""
      if (before === rows[i]?.path || before === after) return null
    }
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const top = above && below ? (above.r.bottom + below.r.top) / 2 : below ? below.r.top - 1 : above.r.bottom + 1
    const left = rem * (0.25 + depth * 0.875 + 1.25)
    return {
      drop: { parent: folder.includes("/") ? `${folder}.md` : folder, before },
      hint: { line: { top: top - b.top - 1, left, width: Math.max(24, b.width - left - 4) } },
    }
  }

  if (y > last.r.bottom + 4) return gap(rows.length, 0)
  let i = rows.findIndex((r) => y < r.r.bottom + 0.5)
  if (i < 0) i = rows.length - 1
  const row = rows[i]
  const rel = (y - row.r.top) / row.r.height
  if (rel < 0.25) return gap(i)
  if (rel > 0.75) return gap(i + 1)
  if (within(row.base)) return null
  return { drop: { parent: row.path, before: "", into: row.path }, hint: { into: row.path } }
}

/**
 * One space's pages, nested. Drag a row to reorder it, or drop it on another
 * page to nest it there. Dragging uses pointer events rather than the
 * browser's drag and drop, which some browsers don't deliver reliably.
 */
export function PageTree({ space, pages }: { space: string; pages: PageNode[] }) {
  const current = useCurrentPath()
  const [open, setOpen] = useState(loadOpen)
  const [drag, setDrag] = useState<{ path: string; title: string } | null>(null)
  const [hint, setHint] = useState<Hint | null>(null)
  const actions = useVaultActions()
  const resolver = useResolver()
  const { data: tree } = useTree()
  // Database pages get their own icon; the tree nodes don't carry the kind.
  const databases = new Set((tree?.notes ?? []).filter((n) => n.kind === "database").map((n) => n.path))
  const boxRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const ghostAt = useRef({ x: 0, y: 0 })
  const cancelDrag = useRef<(() => void) | null>(null)

  // Reveal the open page.
  useEffect(() => {
    if (!current) return
    setOpen((prev) => {
      const missing = ancestorsOf(current).filter((a) => !prev.has(baseOf(a)))
      if (!missing.length) return prev
      const next = new Set(prev)
      missing.forEach((a) => next.add(baseOf(a)))
      return next
    })
  }, [current])

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...open]))
    } catch {
      // Not remembered in private mode.
    }
  }, [open])

  useEffect(() => () => cancelDrag.current?.(), [])

  const paintGhost = () => {
    const g = ghostRef.current
    if (g) g.style.transform = `translate(${ghostAt.current.x}px, ${ghostAt.current.y}px)`
  }
  useLayoutEffect(paintGhost, [drag])

  const toggle = (base: string, force?: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (force ?? !next.has(base)) next.add(base)
      else next.delete(base)
      return next
    })

  /**
   * Picks a page up: with a mouse or pen once the pointer moves a little, so
   * clicks still open the page; with a finger after a long press, so swipes
   * still scroll. Escape cancels.
   */
  const startDrag = (e: React.PointerEvent<HTMLElement>, node: PageNode, depth: number) => {
    const box = boxRef.current
    if (!box || cancelDrag.current || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return
    if ((e.target as Element).closest("[data-nodrag]")) return
    const touch = e.pointerType === "touch"
    const self = baseOf(node.path)
    const scroller = scrollParent(box)
    const startX = e.clientX
    const startY = e.clientY
    // The ghost sits beside the pointer, or above a finger, so the line and
    // the highlighted row under it stay visible.
    const offset = touch ? { x: 16, y: -48 } : { x: 14, y: 10 }
    let x = startX
    let y = startY
    let active = false
    let drop: Drop | null = null
    let editor: (HTMLElement & { editor?: Editor }) | null = null
    let shown = ""
    let frame = 0
    let expand: { path: string; timer: ReturnType<typeof setTimeout> } | null = null
    const press = touch ? setTimeout(() => activate(), LONG_PRESS) : undefined

    const update = () => {
      const found = locate(box, space, self, depth, x - startX, x, y)
      drop = found?.drop ?? null
      // Off the sidebar, over an editable page: drop a link to the page there.
      editor = found ? null : (document.elementFromPoint(x, y)?.closest<HTMLElement>(".ProseMirror[contenteditable=true]") ?? null)
      const next = found?.hint ?? null
      const key = JSON.stringify(next)
      if (key !== shown) {
        shown = key
        setHint(next)
      }
      const into = drop?.into
      const el = into ? box.querySelector<HTMLElement>(`[data-row="${CSS.escape(into)}"]`) : null
      const closed = el?.dataset.kids === "1" && el.dataset.open !== "1"
      if (expand && (!closed || expand.path !== into)) {
        clearTimeout(expand.timer)
        expand = null
      }
      if (into && closed && !expand) {
        expand = { path: into, timer: setTimeout(() => (toggle(baseOf(into), true), requestAnimationFrame(update)), EXPAND_DELAY) }
      }
    }
    // Scroll the sidebar while the pointer is near its top or bottom edge.
    const tick = () => {
      if (scroller) {
        const r = scroller.getBoundingClientRect()
        const edge = 40
        const dy = y < r.top + edge ? (y - r.top - edge) / 3 : y > r.bottom - edge ? (y - r.bottom + edge) / 3 : 0
        if (dy && x >= r.left - 48 && x <= r.right + 48) {
          scroller.scrollTop += Math.max(-16, Math.min(16, dy))
          update()
        }
      }
      frame = requestAnimationFrame(tick)
    }
    const activate = () => {
      if (active) return
      active = true
      ghostAt.current = { x: x + offset.x, y: y + offset.y }
      setDrag({ path: node.path, title: node.title })
      document.documentElement.classList.add("tree-dragging")
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
        if (touch) {
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
      if (expand) clearTimeout(expand.timer)
      cancelAnimationFrame(frame)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", cancel)
      window.removeEventListener("keydown", key, true)
      window.removeEventListener("touchmove", hold)
      window.removeEventListener("contextmenu", noMenu, true)
      cancelDrag.current = null
      if (!active) return
      document.documentElement.classList.remove("tree-dragging")
      // Letting go over a row would otherwise open that page.
      const swallow = (ev: MouseEvent) => {
        ev.preventDefault()
        ev.stopPropagation()
      }
      window.addEventListener("click", swallow, true)
      setTimeout(() => window.removeEventListener("click", swallow, true))
      setDrag(null)
      setHint(null)
      if (!commit) return
      if (drop) {
        if (drop.into) toggle(baseOf(drop.into), true)
        void actions.reorder(node.path, drop.parent, drop.before)
      } else if (editor?.editor) {
        const ed = editor.editor
        const at = ed.view.posAtCoords({ left: x, top: y })
        const target = resolver.count(node.title) > 1 ? self : node.title
        if (at) ed.chain().focus().insertContentAt(at.pos, { type: "pageLink", attrs: { target } }).run()
      }
    }
    const up = (ev: PointerEvent) => ev.pointerId === e.pointerId && end(true)
    const cancel = (ev: PointerEvent) => ev.pointerId === e.pointerId && end(false)
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !active) return
      ev.preventDefault()
      ev.stopPropagation()
      end(false)
    }
    // Once a finger has picked a page up, it drags instead of scrolling.
    const hold = (ev: TouchEvent) => {
      if (active && ev.cancelable) ev.preventDefault()
    }
    const noMenu = (ev: Event) => {
      if (active || touch) ev.preventDefault()
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", cancel)
    window.addEventListener("keydown", key, true)
    window.addEventListener("touchmove", hold, { passive: false })
    window.addEventListener("contextmenu", noMenu, true)
    cancelDrag.current = () => end(false)
  }

  if (!pages.length) {
    return (
      <div className="px-2 py-2 text-[0.8125rem] text-muted-foreground">
        No pages yet.{" "}
        <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => void actions.createPage(space)}>
          Create one
        </button>
      </div>
    )
  }

  const ctx: Ctx = { space, open, toggle, current, over: hint?.into ?? null, dragging: drag?.path ?? null, startDrag, actions, databases }
  return (
    <div ref={boxRef} className="relative flex flex-col gap-px pb-4">
      {pages.map((n, i) => (
        <Row key={n.path} node={n} depth={0} siblings={pages} index={i} ctx={ctx} />
      ))}
      {hint?.line && (
        <div
          aria-hidden
          className="pointer-events-none absolute z-10 h-0.5 rounded-full bg-brand before:absolute before:-top-[3px] before:-left-1.5 before:size-2 before:rounded-full before:border-2 before:border-brand before:bg-sidebar before:content-['']"
          style={hint.line}
        />
      )}
      {drag &&
        createPortal(
          <div
            ref={ghostRef}
            aria-hidden
            className="pointer-events-none fixed top-0 left-0 z-50 flex h-8 w-max max-w-56 items-center gap-2 rounded-md border bg-popover/95 px-2.5 text-sm text-popover-foreground shadow-lg"
          >
            {databases.has(drag.path) ? <Table2 className="size-4 shrink-0 text-muted-foreground" /> : <FileText className="size-4 shrink-0 text-muted-foreground" />}
            <span className="truncate">{drag.title}</span>
          </div>,
          document.body,
        )}
    </div>
  )
}

type Ctx = {
  space: string
  open: Set<string>
  toggle: (base: string, force?: boolean) => void
  current: string
  /** The row a dragged page would nest under. */
  over: string | null
  dragging: string | null
  startDrag: (e: React.PointerEvent<HTMLElement>, node: PageNode, depth: number) => void
  actions: ReturnType<typeof useVaultActions>
  /** Paths of pages that are databases. */
  databases: Set<string>
}

function Row({ node, depth, siblings, index, ctx }: { node: PageNode; depth: number; siblings: PageNode[]; index: number; ctx: Ctx }) {
  const base = baseOf(node.path)
  const isOpen = ctx.open.has(base)
  const hasChildren = node.children.length > 0
  const active = ctx.current === node.path
  const [menu, setMenu] = useState(false)
  const { isMobile, setOpenMobile } = useSidebar()
  const { prompt } = useDialogs()
  const parent = parentOf(node.path) || ctx.space

  const rename = async () => {
    const name = await prompt({ title: "Rename page", defaultValue: node.title, confirm: "Rename" })
    if (name) await ctx.actions.rename(node.path, name)
  }

  return (
    <div>
      <div
        data-row={node.path}
        data-depth={depth}
        data-open={hasChildren && isOpen ? "1" : "0"}
        data-kids={hasChildren ? "1" : "0"}
        onPointerDown={(e) => ctx.startDrag(e, node, depth)}
        onDragStart={(e) => e.preventDefault()}
        className={cn(
          "group/row relative flex h-8 items-center rounded-md pr-1 pointer-coarse:h-10 text-sm text-sidebar-foreground transition-colors select-none [-webkit-touch-callout:none]",
          !ctx.dragging && "hover:bg-sidebar-accent",
          active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
          ctx.over === node.path && "bg-brand-soft ring-1 ring-brand/50 hover:bg-brand-soft",
          ctx.dragging === node.path && "opacity-40",
        )}
        style={{ paddingLeft: `${0.25 + depth * 0.875}rem` }}
      >
        <button
          type="button"
          tabIndex={hasChildren ? 0 : -1}
          aria-label={hasChildren ? (isOpen ? "Collapse" : "Expand") : undefined}
          onClick={() => hasChildren && ctx.toggle(base)}
          className={cn("grid size-6 shrink-0 place-items-center rounded text-muted-foreground", hasChildren && "hover:bg-background/80 hover:text-foreground")}
        >
          {hasChildren ? (
            <ChevronRight className={cn("size-3.5 transition-transform duration-150", isOpen && "rotate-90")} />
          ) : (
            <span className="size-1 rounded-full bg-muted-foreground/60" />
          )}
        </button>
        <Link
          to={pageUrl(node.path)}
          draggable={false}
          onClick={() => isMobile && setOpenMobile(false)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-1 outline-none focus-visible:underline",
            node.virtual && "text-muted-foreground",
          )}
        >
          {ctx.databases.has(node.path) && <Table2 aria-label="Database" className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="truncate">{node.title}</span>
        </Link>
        <div
          data-nodrag
          className={cn("flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100", !ctx.dragging && "group-hover/row:opacity-100", menu && "opacity-100")}
        >
          <DropdownMenu open={menu} onOpenChange={setMenu}>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={`Actions for ${node.title}`} className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-background/80 hover:text-foreground">
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuItem onSelect={() => (ctx.toggle(base, true), void ctx.actions.createPage(node.path))}>
                <Plus /> Add sub-page
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => (ctx.toggle(base, true), openNewDatabase(node.path))}>
                <Table2 /> Add database
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void rename()}>
                <Pencil /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem disabled={index === 0} onSelect={() => void ctx.actions.reorder(node.path, parent, siblings[index - 1].path)}>
                <ArrowUp /> Move up
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={index === siblings.length - 1}
                onSelect={() => void ctx.actions.reorder(node.path, parent, siblings[index + 2]?.path ?? "")}
              >
                <ArrowDown /> Move down
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openMoveDialog(node.path)}>
                <FolderInput /> Move to…
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  void navigator.clipboard?.writeText(`${location.origin}${pageUrl(node.path)}`)
                  toast.success("Link copied")
                }}
              >
                <Copy /> Copy link
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void ctx.actions.remove(node.path, count(node))}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            aria-label={`Add a sub-page to ${node.title}`}
            title="Add sub-page"
            onClick={() => {
              ctx.toggle(base, true)
              void ctx.actions.createPage(node.path)
            }}
            className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-background/80 hover:text-foreground"
          >
            <Plus className="size-4" />
          </button>
        </div>
      </div>
      {hasChildren && isOpen && (
        <div className="flex flex-col gap-px pt-px">
          {node.children.map((c, i) => (
            <Row key={c.path} node={c} depth={depth + 1} siblings={node.children} index={i} ctx={ctx} />
          ))}
        </div>
      )}
    </div>
  )
}
