import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "cn"
import { CircleAlert, Copy, GripVertical, Maximize2, MoreHorizontal, Plus, Trash2, ArrowUpToLine, ArrowDownToLine } from "lucide-react"
import { toast } from "sonner"

import { alignRight, CellView, editText, FilePicker, listEditor, OptionPicker, RelationPicker, TextEditor, TypeIcon, ValueText } from "@/components/database/cells"
import { ColumnMenu } from "@/components/database/column-settings"
import type { ViewProps } from "@/components/database/types"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import type { Column, Row, TableData } from "@/lib/api"
import { cellOf, freshName, isStored, newId, plain, resultKind, summarize, summaryKinds, summaryLabel } from "@/lib/table"

const GUTTER = 64
const ROW_H = 33
const HEADER_H = 33
const ADD_W = 44
const MIN_W = 80
const MAX_W = 800

type Pos = { r: number; c: number }
type Move = "down" | "right" | "left" | "up"
type Editing = { row: string; col: string; initial: string }

const widthOf = (col: Column, primary: boolean) => Math.min(MAX_W, Math.max(MIN_W, col.width ?? (primary ? 240 : 180)))

/** Quotes a value for TSV the way spreadsheets do, when it needs it. */
const tsvCell = (s: string) => (/[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

/** Reads TSV pasted from a spreadsheet: quoted cells may hold tabs and newlines. */
function parseTSV(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  const t = text.replace(/\r\n?/g, "\n").replace(/\n$/, "")
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === "") quoted = true
    else if (ch === "\t") {
      row.push(cell)
      cell = ""
    } else if (ch === "\n") {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
    } else cell += ch
  }
  row.push(cell)
  rows.push(row)
  return rows
}

/** A sheet-like table: select, type, paste, drag and total like a spreadsheet. */
export function GridView({ data, table, view, rows: viewRows, editable, openRow }: ViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)

  // Rows added here stay in view even if the filters would hide them, until
  // the view changes, so you can fill in what you just added.
  const [keep, setKeep] = useState<string[]>([])
  useEffect(() => setKeep([]), [view.id])
  const rows = useMemo(() => {
    if (!keep.length) return viewRows
    const shown = new Set(viewRows.map((r) => r.id))
    const extra = keep.flatMap((id) => (shown.has(id) ? [] : data.rows.filter((r) => r.id === id)))
    return extra.length ? [...viewRows, ...extra] : viewRows
  }, [viewRows, keep, data.rows])

  const hidden = useMemo(() => new Set(view.hidden ?? []), [view.hidden])
  const cols = useMemo(() => data.schema.columns.filter((c, i) => i === 0 || !hidden.has(c.id)), [data.schema.columns, hidden])
  const primaryId = data.schema.columns[0]?.id

  // Widths while resizing, before they're saved.
  const [resizing, setResizing] = useState<{ id: string; w: number } | null>(null)
  const widths = cols.map((c) => (resizing?.id === c.id ? resizing.w : widthOf(c, c.id === primaryId)))
  const lefts = widths.reduce<number[]>((acc, _, i) => (acc.push(i === 0 ? GUTTER : acc[i - 1] + widths[i - 1]), acc), [])
  const total = GUTTER + widths.reduce((a, b) => a + b, 0) + (editable ? ADD_W : 0)

  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    scrollPaddingStart: HEADER_H,
    scrollPaddingEnd: ROW_H * 2,
    getItemKey: (i) => rows[i]?.id ?? i,
  })
  useEffect(() => virtual.measure(), [view.wrap, virtual])

  // ── Selection ──
  const [active, setActive] = useState<Pos | null>(null)
  const [anchor, setAnchor] = useState<Pos | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const dragSelect = useRef(false)
  const range = active && anchor ? { r0: Math.min(active.r, anchor.r), r1: Math.max(active.r, anchor.r), c0: Math.min(active.c, anchor.c), c1: Math.max(active.c, anchor.c) } : null
  const inRange = (r: number, c: number) => !!range && r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1
  const multi = !!range && (range.r0 !== range.r1 || range.c0 !== range.c1)

  // Keep the selection inside the table as rows and columns come and go.
  useEffect(() => {
    const clamp = (p: Pos | null) => (p && (p.r >= rows.length || p.c >= cols.length) ? { r: Math.min(p.r, rows.length - 1), c: Math.min(p.c, cols.length - 1) } : p)
    if (!rows.length) {
      setActive(null)
      setAnchor(null)
      return
    }
    setActive(clamp)
    setAnchor(clamp)
  }, [rows.length, cols.length])

  const focusGrid = () => scrollRef.current?.focus({ preventScroll: true })

  const select = useCallback(
    (p: Pos, extend = false) => {
      setActive(p)
      if (!extend) setAnchor(p)
      virtual.scrollToIndex(p.r, { align: "auto" })
      requestAnimationFrame(() => {
        const el = scrollRef.current?.querySelector<HTMLElement>(`[data-cell="${p.r}:${p.c}"]`)
        const box = scrollRef.current
        if (!el || !box || p.c === 0) return
        // Keep the cell clear of the sticky first columns.
        const left = el.offsetLeft - GUTTER - widths[0]
        if (left < box.scrollLeft) box.scrollLeft = left
        else if (el.offsetLeft + el.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = el.offsetLeft + el.offsetWidth - box.clientWidth
      })
    },
    [virtual, widths],
  )

  const canEdit = (col: Column) => editable && isStored(col.type)

  const startEdit = (p: Pos, initial?: string) => {
    const row = rows[p.r]
    const col = cols[p.c]
    if (!row || !col || !canEdit(col)) return
    if (col.type === "checkbox") {
      void table.setCell(row.id, col.id, row.cells[col.id] === "true" ? "" : "true")
      return
    }
    setEditing({ row: row.id, col: col.id, initial: initial ?? editText(col, row.cells[col.id] ?? "") })
  }

  const step = (p: Pos, move: Move): Pos => {
    switch (move) {
      case "down":
        return { r: Math.min(rows.length - 1, p.r + 1), c: p.c }
      case "up":
        return { r: Math.max(0, p.r - 1), c: p.c }
      case "right":
        return { r: p.r, c: Math.min(cols.length - 1, p.c + 1) }
      case "left":
        return { r: p.r, c: Math.max(0, p.c - 1) }
    }
  }

  const commit = (value: string, move?: Move) => {
    const e = editing
    setEditing(null)
    if (e) {
      const row = data.rows.find((r) => r.id === e.row)
      const col = cols.find((c) => c.id === e.col)
      if (row && col && value !== editText(col, row.cells[col.id] ?? "")) void table.setCell(row.id, col.id, value)
    }
    if (active && move) select(step(active, move))
    focusGrid()
  }

  const cancel = () => {
    setEditing(null)
    focusGrid()
  }

  // ── Clipboard ──
  // Menus and pickers render in portals, but their events still bubble here
  // through React; only the grid's own focus counts.
  const own = (e: React.SyntheticEvent) => e.target === scrollRef.current

  const copy = (e: React.ClipboardEvent) => {
    if (!range || editing || !own(e)) return
    e.preventDefault()
    const lines: string[] = []
    for (let r = range.r0; r <= range.r1; r++) {
      const cells: string[] = []
      for (let c = range.c0; c <= range.c1; c++) {
        const col = cols[c]
        const row = rows[r]
        // Selects copy their names, numbers their plain value, so they paste back.
        cells.push(tsvCell(isStored(col.type) && col.type !== "relation" ? (row.cells[col.id] ?? "") : plain(cellOf(data, row, col))))
      }
      lines.push(cells.join("\t"))
    }
    e.clipboardData.setData("text/plain", lines.join("\n"))
  }

  const paste = (e: React.ClipboardEvent) => {
    if (!editable || !active || editing || !own(e)) return
    const text = e.clipboardData.getData("text/plain")
    if (!text) return
    e.preventDefault()
    let grid = parseTSV(text)
    const top = range ? { r: range.r0, c: range.c0 } : active
    // One value pasted over a range fills it.
    if (grid.length === 1 && grid[0].length === 1 && multi && range) {
      grid = Array.from({ length: range.r1 - range.r0 + 1 }, () => Array.from({ length: range.c1 - range.c0 + 1 }, () => grid[0][0]))
    }
    const updates: { id: string; cells: Record<string, string> }[] = []
    const extra: { cells: Record<string, string> }[] = []
    grid.forEach((line, i) => {
      const cells: Record<string, string> = {}
      line.forEach((v, j) => {
        const col = cols[top.c + j]
        if (col && isStored(col.type) && col.type !== "relation") cells[col.id] = v
      })
      if (!Object.keys(cells).length) return
      const row = rows[top.r + i]
      if (row) updates.push({ id: row.id, cells })
      else extra.push({ cells })
    })
    if (updates.length) void table.setCells(updates)
    if (extra.length) {
      void table.addRows(extra).then((ids) => setKeep((k) => [...k, ...ids]))
    }
    setAnchor({ r: top.r + grid.length - 1, c: Math.min(cols.length - 1, top.c + Math.max(...grid.map((g) => g.length)) - 1) })
    setActive(top)
  }

  const clearRange = () => {
    if (!range || !editable) return
    const updates: { id: string; cells: Record<string, string> }[] = []
    for (let r = range.r0; r <= range.r1; r++) {
      const cells: Record<string, string> = {}
      for (let c = range.c0; c <= range.c1; c++) {
        const col = cols[c]
        if (canEdit(col) && rows[r].cells[col.id]) cells[col.id] = ""
      }
      if (Object.keys(cells).length) updates.push({ id: rows[r].id, cells })
    }
    if (updates.length) void table.setCells(updates)
  }

  // ── Rows ──
  const nextAfter = (id: string) => data.rows[data.rows.findIndex((r) => r.id === id) + 1]?.id ?? ""

  const addRow = async (before = "") => {
    const ids = await table.addRows([{ cells: {} }], before)
    if (!ids.length) return
    setKeep((k) => [...k, ...ids])
    // Wait for the row to render, then type its name.
    requestAnimationFrame(() => setPendingEdit(ids[0]))
  }
  const [pendingEdit, setPendingEdit] = useState("")
  useEffect(() => {
    if (!pendingEdit) return
    const r = rows.findIndex((x) => x.id === pendingEdit)
    if (r < 0) return
    setPendingEdit("")
    select({ r, c: 0 })
    if (editable) setEditing({ row: pendingEdit, col: cols[0].id, initial: "" })
  }, [pendingEdit, rows]) // eslint-disable-line react-hooks/exhaustive-deps

  /** The rows a row menu acts on: the selected rows if it's among them. */
  const targetRows = (row: Row) => {
    const i = rows.findIndex((r) => r.id === row.id)
    if (range && i >= range.r0 && i <= range.r1 && range.r1 > range.r0) return rows.slice(range.r0, range.r1 + 1)
    return [row]
  }

  const deleteRows = (list: Row[]) => {
    const before = nextAfter(list[list.length - 1].id)
    const copies = list.map((r) => ({ cells: r.cells }))
    void table.deleteRows(list.map((r) => r.id))
    toast(list.length === 1 ? "Deleted the row" : `Deleted ${list.length} rows`, {
      action: { label: "Undo", onClick: () => void table.addRows(copies, before) },
    })
    setAnchor(active)
  }

  const duplicate = (list: Row[]) => void table.addRows(list.map((r) => ({ cells: { ...r.cells } })), nextAfter(list[list.length - 1].id))

  const [menuRow, setMenuRow] = useState<Row | null>(null)
  const rowMenu = (row: Row, Item: typeof ContextMenuItem | typeof DropdownMenuItem, Separator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator) => {
    const list = targetRows(row)
    return (
      <>
        <Item onSelect={() => openRow(data.path, row.id)}>
          <Maximize2 /> Open
        </Item>
        {editable && (
          <>
            <Item onSelect={() => void addRow(row.id)}>
              <ArrowUpToLine /> Insert above
            </Item>
            <Item onSelect={() => void addRow(nextAfter(row.id))}>
              <ArrowDownToLine /> Insert below
            </Item>
            <Item onSelect={() => duplicate(list)}>
              <Copy /> {list.length > 1 ? `Duplicate ${list.length} rows` : "Duplicate"}
            </Item>
            <Separator />
            <Item variant="destructive" onSelect={() => deleteRows(list)}>
              <Trash2 /> {list.length > 1 ? `Delete ${list.length} rows` : "Delete"}
            </Item>
          </>
        )}
      </>
    )
  }

  // Row dragging: only when the view keeps the rows in their own order.
  const sorted = (view.sorts?.length ?? 0) > 0
  const [rowDrag, setRowDrag] = useState<{ ids: string[]; to: number } | null>(null)
  const startRowDrag = (e: React.PointerEvent, row: Row) => {
    if (!editable || sorted) return
    e.preventDefault()
    e.stopPropagation()
    const ids = targetRows(row).map((r) => r.id)
    const indexAt = (y: number) => {
      const box = rowsRef.current?.getBoundingClientRect()
      if (!box) return 0
      const off = y - box.top
      const item = virtual.getVirtualItems().find((v) => off >= v.start && off < v.end)
      if (!item) return off < 0 ? 0 : rows.length
      return off < item.start + item.size / 2 ? item.index : item.index + 1
    }
    setRowDrag({ ids, to: indexAt(e.clientY) })
    const move = (ev: PointerEvent) => setRowDrag({ ids, to: indexAt(ev.clientY) })
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      setRowDrag(null)
      const to = indexAt(ev.clientY)
      const before = rows.slice(to).find((r) => !ids.includes(r.id))?.id ?? ""
      const from = rows.findIndex((r) => r.id === ids[0])
      if (to !== from && to !== from + ids.length) void table.moveRows(ids, before)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  // ── Columns ──
  const [menuCol, setMenuCol] = useState("")
  const [freshCol, setFreshCol] = useState("")
  const suppressClick = useRef(false)
  const [colDrag, setColDrag] = useState<{ id: string; to: number } | null>(null)

  const addColumn = () => {
    const c: Column = { id: newId("c"), name: freshName(data.schema.columns, "Column"), type: "text" }
    void table.saveSchema({ ...data.schema, columns: [...data.schema.columns, c] })
    setFreshCol(c.id)
    setMenuCol(c.id)
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ left: scrollRef.current.scrollWidth }))
  }

  const startResize = (e: React.PointerEvent, col: Column, i: number) => {
    e.preventDefault()
    e.stopPropagation()
    const x0 = e.clientX
    const w0 = widths[i]
    let w = w0
    const move = (ev: PointerEvent) => {
      w = Math.round(Math.min(MAX_W, Math.max(MIN_W, w0 + ev.clientX - x0)))
      setResizing({ id: col.id, w })
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      if (w !== w0) void table.updateColumn(col.id, { width: w })
      setTimeout(() => setResizing(null), 0)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  const startColDrag = (e: React.PointerEvent<HTMLElement>, col: Column, i: number) => {
    if (!editable || i === 0 || e.button !== 0 || !e.currentTarget.contains(e.target as Node)) return
    const x0 = e.clientX
    let dragging = false
    const indexAt = (x: number) => {
      const box = headerRef.current?.getBoundingClientRect()
      if (!box) return i
      const off = x - box.left
      for (let j = 1; j < cols.length; j++) if (off < lefts[j] + widths[j] / 2) return j
      return cols.length
    }
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientX - x0) < 5) return
      dragging = true
      setColDrag({ id: col.id, to: Math.max(1, indexAt(ev.clientX)) })
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      setColDrag(null)
      if (!dragging) return
      suppressClick.current = true
      const to = Math.max(1, indexAt(ev.clientX))
      if (to === i || to === i + 1) return
      // Place it relative to the visible column it was dropped before.
      const all = data.schema.columns.filter((c) => c.id !== col.id)
      const beforeId = cols[to]?.id
      const at = beforeId ? all.findIndex((c) => c.id === beforeId) : all.length
      all.splice(Math.max(1, at), 0, col)
      void table.saveSchema({ ...data.schema, columns: all })
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  // ── Keyboard ──
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing || !active || e.defaultPrevented || !own(e)) return
    const mod = e.metaKey || e.ctrlKey
    const col = cols[active.c]
    const arrows: Record<string, Move> = { ArrowDown: "down", ArrowUp: "up", ArrowLeft: "left", ArrowRight: "right" }
    if (arrows[e.key]) {
      e.preventDefault()
      let p = step(active, arrows[e.key])
      if (mod) {
        p = { ArrowDown: { r: rows.length - 1, c: active.c }, ArrowUp: { r: 0, c: active.c }, ArrowLeft: { r: active.r, c: 0 }, ArrowRight: { r: active.r, c: cols.length - 1 } }[e.key]!
      }
      select(p, e.shiftKey)
      return
    }
    switch (e.key) {
      case "Tab":
        e.preventDefault()
        select(step(active, e.shiftKey ? "left" : "right"))
        return
      case "Enter":
        e.preventDefault()
        if (e.shiftKey) select(step(active, "up"))
        else if (canEdit(col)) startEdit(active)
        else select(step(active, "down"))
        return
      case "F2":
        e.preventDefault()
        startEdit(active)
        return
      case " ":
        if (col.type === "checkbox") {
          e.preventDefault()
          startEdit(active)
        } else if (e.shiftKey) {
          e.preventDefault()
          openRow(data.path, rows[active.r].id)
        }
        return
      case "Delete":
      case "Backspace":
        e.preventDefault()
        clearRange()
        return
      case "Escape":
        if (multi) setAnchor(active)
        else {
          setActive(null)
          setAnchor(null)
        }
        return
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault()
      setAnchor({ r: 0, c: 0 })
      setActive({ r: rows.length - 1, c: cols.length - 1 })
      return
    }
    // Typing starts editing, replacing what's there, as in a spreadsheet.
    if (e.key.length === 1 && !mod && !e.altKey && canEdit(col)) {
      e.preventDefault()
      if (listEditor(col.type) || col.type === "date") startEdit(active)
      else startEdit(active, e.key)
    }
  }

  // Clicks outside the grid end the selection's highlight but keep the cell.
  useLayoutEffect(() => {
    const up = () => (dragSelect.current = false)
    window.addEventListener("pointerup", up)
    return () => window.removeEventListener("pointerup", up)
  }, [])

  const onCellDown = (e: React.PointerEvent<HTMLElement>, p: Pos) => {
    const target = e.target as HTMLElement
    if (e.button !== 0 || !e.currentTarget.contains(target) || target.closest("a,button,[data-no-select]")) return
    const already = active?.r === p.r && active?.c === p.c && !multi
    if (e.shiftKey && active) {
      setActive(p)
      return
    }
    select(p)
    focusGrid()
    dragSelect.current = e.pointerType === "mouse"
    // Checkboxes toggle on a click; other cells edit on a second click (and a
    // second tap on a phone).
    const col = cols[p.c]
    if (col.type === "checkbox" ? canEdit(col) : already && !editing && canEdit(col)) startEdit(p)
  }

  const items = virtual.getVirtualItems()
  const summaries = view.summaries ?? {}

  const cellBox = (c: number) =>
    cn(
      "relative flex shrink-0 items-center border-r border-b px-2 text-sm",
      c === 0 && "sticky z-[5] bg-background font-medium",
      alignRight(cols[c]) && "justify-end",
    )

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        tabIndex={0}
        role="grid"
        aria-label={view.name}
        aria-rowcount={rows.length}
        onKeyDown={onKeyDown}
        onCopy={copy}
        onPaste={paste}
        className="relative max-h-[70vh] overflow-auto rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-ring/40 select-none"
      >
        <div style={{ width: total }} className="min-w-full">
          {/* Header */}
          <div ref={headerRef} role="row" className="sticky top-0 z-20 flex bg-background" style={{ height: HEADER_H }}>
            <div className="sticky left-0 z-[6] shrink-0 border-r border-b bg-background" style={{ width: GUTTER }} />
            {cols.map((col, c) => {
              const err = data.errors[col.id]
              return (
                <div
                  key={col.id}
                  role="columnheader"
                  className={cn("relative shrink-0 border-r border-b bg-background", c === 0 && "sticky z-[6]", colDrag?.id === col.id && "opacity-50")}
                  style={{ width: widths[c], left: c === 0 ? GUTTER : undefined }}
                >
                  <ColumnMenu
                    data={data}
                    table={table}
                    view={view}
                    col={col}
                    editable={editable}
                    fresh={freshCol === col.id}
                    open={menuCol === col.id}
                    onOpenChange={(o) => {
                      setMenuCol(o ? col.id : "")
                      if (!o) setFreshCol("")
                    }}
                  >
                    <button
                      type="button"
                      onPointerDown={(e) => startColDrag(e, col, c)}
                      onClick={(e) => {
                        if (suppressClick.current || resizing) {
                          suppressClick.current = false
                          e.preventDefault()
                        }
                      }}
                      title={col.description || undefined}
                      className={cn("flex h-full w-full items-center gap-1.5 px-2 text-left text-[0.8125rem] font-normal text-muted-foreground hover:bg-accent", alignRight(col) && "flex-row-reverse text-right")}
                    >
                      <TypeIcon type={col.type} />
                      <span className="min-w-0 flex-1 truncate">{col.name}</span>
                      {err && (
                        <span title={err}>
                          <CircleAlert className="size-3.5 shrink-0 text-destructive/70" />
                        </span>
                      )}
                    </button>
                  </ColumnMenu>
                  {editable && (
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${col.name}`}
                      onPointerDown={(e) => startResize(e, col, c)}
                      className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize touch-none hover:bg-ring/40"
                    />
                  )}
                  {colDrag && colDrag.to === c && colDrag.id !== col.id && <div className="absolute top-0 -left-px z-10 h-full w-0.5 bg-ring" />}
                </div>
              )
            })}
            {editable && (
              <button
                type="button"
                aria-label="Add a column"
                onClick={addColumn}
                className="grid shrink-0 place-items-center border-b text-muted-foreground hover:bg-accent"
                style={{ width: ADD_W }}
              >
                <Plus className="size-4" />
              </button>
            )}
            {colDrag && colDrag.to === cols.length && <div className="absolute top-0 z-10 h-full w-0.5 bg-ring" style={{ left: lefts[cols.length - 1] + widths[cols.length - 1] }} />}
          </div>

          {/* Rows */}
          <ContextMenu modal={false}>
            <ContextMenuTrigger asChild disabled={!rows.length}>
              <div
                ref={rowsRef}
                className="relative"
                style={{ height: virtual.getTotalSize() }}
                onContextMenu={(e) => {
                  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-row]")?.dataset.row
                  const row = rows.find((r) => r.id === id)
                  if (!row) return e.preventDefault()
                  setMenuRow(row)
                }}
              >
                {items.map((vi) => {
                  const row = rows[vi.index]
                  const r = vi.index
                  const rowSelected = !!range && r >= range.r0 && r <= range.r1
                  return (
                    <div
                      key={vi.key}
                      data-index={vi.index}
                      data-row={row.id}
                      ref={virtual.measureElement}
                      role="row"
                      aria-rowindex={r + 2}
                      className={cn("group/row absolute top-0 left-0 flex w-full", editing?.row === row.id && "z-30")}
                      style={{ transform: `translateY(${vi.start}px)`, minHeight: ROW_H }}
                    >
                      <div
                        className={cn(
                          "sticky left-0 z-[6] flex shrink-0 items-center border-r border-b bg-background pl-1 text-xs text-muted-foreground tabular-nums",
                          rowSelected && multi && "bg-brand-soft",
                        )}
                        style={{ width: GUTTER }}
                      >
                        <button
                          type="button"
                          aria-label={`Select row ${r + 1}`}
                          onClick={(e) => {
                            if (e.shiftKey && active) setActive({ r, c: cols.length - 1 })
                            else {
                              setAnchor({ r, c: 0 })
                              setActive({ r, c: cols.length - 1 })
                            }
                            focusGrid()
                          }}
                          className="w-7 text-center group-hover/row:hidden"
                        >
                          {r + 1}
                        </button>
                        <span className="hidden items-center group-hover/row:flex">
                          {editable && !sorted ? (
                            <span
                              role="button"
                              tabIndex={-1}
                              aria-label="Drag to move"
                              onPointerDown={(e) => startRowDrag(e, row)}
                              className="grid h-6 w-4 cursor-grab touch-none place-items-center rounded hover:bg-accent active:cursor-grabbing"
                            >
                              <GripVertical className="size-3.5" />
                            </span>
                          ) : (
                            <span className="w-4" />
                          )}
                          <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                              <button type="button" aria-label="Row actions" className="grid size-6 place-items-center rounded hover:bg-accent">
                                <MoreHorizontal className="size-3.5" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="w-48">
                              {rowMenu(row, DropdownMenuItem, DropdownMenuSeparator)}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </span>
                        <button
                          type="button"
                          aria-label="Open row"
                          title="Open"
                          onClick={() => openRow(data.path, row.id)}
                          // No hovering on a touch screen: there it always shows, as the way into a row.
                          className="ml-auto grid size-6 place-items-center rounded opacity-0 group-hover/row:opacity-100 hover:bg-accent focus-visible:opacity-100 pointer-coarse:opacity-100"
                        >
                          <Maximize2 className="size-3.5" />
                        </button>
                      </div>
                      {cols.map((col, c) => {
                        const isActive = active?.r === r && active?.c === c
                        const isEditing = editing?.row === row.id && editing?.col === col.id
                        return (
                          <div
                            key={col.id}
                            role="gridcell"
                            aria-selected={isActive}
                            data-cell={`${r}:${c}`}
                            className={cellBox(c)}
                            style={{ width: widths[c], left: c === 0 ? GUTTER : undefined, minHeight: ROW_H }}
                            onPointerDown={(e) => onCellDown(e, { r, c })}
                            onPointerEnter={() => dragSelect.current && setActive({ r, c })}
                            onDoubleClick={() => !isEditing && col.type !== "checkbox" && startEdit({ r, c })}
                          >
                            {inRange(r, c) && multi && <div className="pointer-events-none absolute inset-0 bg-brand-soft/70" />}
                            <div className={cn("relative flex min-w-0 flex-1 items-center py-1", alignRight(col) && "justify-end", view.wrap ? "" : "overflow-hidden")}>
                              <GridCell data={data} row={row} col={col} wrap={!!view.wrap} openRow={openRow} />
                            </div>
                            {isActive && <div className="pointer-events-none absolute -inset-px z-[7] rounded-[2px] ring-2 ring-ring ring-inset" />}
                            {isEditing && <CellEditorOverlay data={data} row={row} col={col} initial={editing.initial} onCommit={commit} onCancel={cancel} />}
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
                {rowDrag && (
                  <div
                    className="pointer-events-none absolute left-0 z-40 h-0.5 bg-ring"
                    style={{ width: total, top: rowDrag.to < rows.length ? (virtual.getVirtualItems().find((v) => v.index === rowDrag.to)?.start ?? virtual.getTotalSize()) : virtual.getTotalSize() }}
                  />
                )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">{menuRow && rowMenu(menuRow, ContextMenuItem, ContextMenuSeparator)}</ContextMenuContent>
          </ContextMenu>

          {/* New row */}
          {editable ? (
            <button
              type="button"
              onClick={() => void addRow()}
              className="sticky left-0 flex h-[33px] w-full max-w-[min(100%,100vw)] items-center gap-2 border-b px-3 text-left text-[0.8125rem] text-muted-foreground hover:bg-accent/60"
              style={{ width: "100%" }}
            >
              <Plus className="size-3.5" /> New row
              {rows.length === 0 && <span className="text-xs text-muted-foreground/70">· No rows yet. Add one, or paste from a spreadsheet.</span>}
            </button>
          ) : (
            rows.length === 0 && <p className="sticky left-0 px-3 py-6 text-sm text-muted-foreground">No rows to show.</p>
          )}

          {/* Totals */}
          <div className="sticky bottom-0 z-20 flex bg-background" style={{ height: ROW_H }}>
            <div className="sticky left-0 z-[6] shrink-0 border-t border-r bg-background" style={{ width: GUTTER }} />
            {cols.map((col, c) => (
              <SummaryCell
                key={col.id}
                data={data}
                rows={viewRows}
                col={col}
                kind={summaries[col.id] ?? ""}
                editable={editable}
                width={widths[c]}
                sticky={c === 0}
                onChange={(kind) => {
                  const next = { ...summaries }
                  if (kind) next[col.id] = kind
                  else delete next[col.id]
                  void table.updateView(view.id, { summaries: next })
                }}
              />
            ))}
            {editable && <div className="shrink-0 border-t" style={{ width: ADD_W }} />}
          </div>
        </div>
      </div>
    </div>
  )
}

/** A cell's content in the grid. Computed columns show their problems. */
function GridCell({ data, row, col, wrap, openRow }: { data: TableData; row: Row; col: Column; wrap: boolean; openRow: ViewProps["openRow"] }) {
  if (!isStored(col.type)) {
    if (data.errors[col.id]) return <span className="font-mono text-xs text-muted-foreground/60" title={data.errors[col.id]}>–</span>
    return <ValueText value={cellOf(data, row, col)} col={col} wrap={wrap} />
  }
  return <CellView data={data} row={row} col={col} wrap={wrap} onOpenRow={openRow} />
}

/** The editor laid over a cell: a text box, or a picker for lists. */
function CellEditorOverlay({
  data,
  row,
  col,
  initial,
  onCommit,
  onCancel,
}: {
  data: TableData
  row: Row
  col: Column
  initial: string
  onCommit: (value: string, move?: Move) => void
  onCancel: () => void
}) {
  const value = useRef(row.cells[col.id] ?? "")
  if (listEditor(col.type)) {
    const done = () => onCommit(value.current)
    return (
      <Popover open onOpenChange={(o) => !o && done()}>
        <PopoverAnchor asChild>
          <div className="absolute inset-0" data-no-select />
        </PopoverAnchor>
        <PopoverContent align="start" sideOffset={2} className="w-auto gap-0 p-0" onKeyDown={(e) => e.stopPropagation()}>
          {col.type === "relation" ? (
            <RelationPicker col={col} data={data} value={value.current} onChange={(v) => (value.current = v)} onDone={done} />
          ) : col.type === "file" ? (
            <FilePicker value={value.current} onChange={(v) => (value.current = v)} />
          ) : (
            <OptionPicker col={col} value={value.current} onChange={(v) => (value.current = v)} onDone={done} />
          )}
        </PopoverContent>
      </Popover>
    )
  }
  return (
    <div
      data-no-select
      className="absolute top-0 left-0 z-30 flex min-h-full w-full min-w-[12rem] items-start rounded-[2px] bg-background px-2 py-[6px] shadow-md ring-2 ring-ring"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <TextEditor col={col} initial={initial} onCommit={onCommit} onCancel={onCancel} />
    </div>
  )
}

/** A column's total in the footer; click to choose what it shows. */
function SummaryCell({
  data,
  rows,
  col,
  kind,
  editable,
  width,
  sticky,
  onChange,
}: {
  data: TableData
  rows: Row[]
  col: Column
  kind: string
  editable: boolean
  width: number
  sticky: boolean
  onChange: (kind: string) => void
}) {
  const numeric = resultKind(col) === "number" || col.type === "rollup"
  const kinds = summaryKinds.filter((k) => (!k.numeric || numeric) && ((k.kind !== "checked" && k.kind !== "percent") || col.type === "checkbox" || resultKind(col) === "bool"))
  const value = kind ? summarize(data, rows, col, kind) : ""
  const box = cn("group/sum flex h-full shrink-0 items-center justify-end gap-1.5 border-t border-r bg-background px-2 text-xs", sticky && "sticky z-[6]")
  const style = { width, left: sticky ? GUTTER : undefined }
  const content = kind ? (
    <>
      <span className="text-muted-foreground">{summaryLabel(kind)}</span>
      <span className="truncate font-medium tabular-nums">{value}</span>
    </>
  ) : (
    <span className="text-muted-foreground opacity-0 transition-opacity group-hover/sum:opacity-100">Calculate</span>
  )
  if (!editable) {
    return (
      <div className={box} style={style}>
        {kind && content}
      </div>
    )
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(box, "hover:bg-accent")} style={style} aria-label={`Total for ${col.name}`}>
          {content}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{col.name}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onChange("")}>None</DropdownMenuItem>
        {kinds.map((k) => (
          <DropdownMenuItem key={k.kind} onSelect={() => onChange(k.kind)} className={cn(k.kind === kind && "font-medium")}>
            {k.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
