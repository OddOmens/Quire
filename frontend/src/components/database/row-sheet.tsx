import { useState } from "react"
import { cn } from "cn"
import { Copy, Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { CellView, editText, FilePicker, OptionPicker, RelationPicker, TextEditor, TypeIcon, ValueText } from "@/components/database/cells"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { useTable, type TableActions } from "@/hooks/use-table"
import type { Column, Row, TableData } from "@/lib/api"
import { titleOf } from "@/lib/notes"
import { cellOf, formatDate } from "@/lib/table"

/** A row of a database, opened in a panel with every field to edit. */
export function RowSheet({
  path,
  row,
  onClose,
  editable,
  openRow,
}: {
  path: string
  row: string
  onClose: () => void
  editable: boolean
  openRow: (path: string, id: string) => void
}) {
  const table = useTable(path)
  const data = table.data
  const r = data?.rows.find((x) => x.id === row)
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
        {!data ? (
          <div className="grid h-40 place-items-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : !r ? (
          <div className="p-6">
            <SheetTitle>This row is gone</SheetTitle>
            <SheetDescription>It may have been deleted on another device.</SheetDescription>
          </div>
        ) : (
          <RowFields data={data} table={table} row={r} editable={editable} openRow={openRow} onDeleted={onClose} />
        )}
      </SheetContent>
    </Sheet>
  )
}

function RowFields({
  data,
  table,
  row,
  editable,
  openRow,
  onDeleted,
}: {
  data: TableData
  table: TableActions
  row: Row
  editable: boolean
  openRow: (path: string, id: string) => void
  onDeleted: () => void
}) {
  const [primary, ...rest] = data.schema.columns
  return (
    <div className="flex min-h-full flex-col">
      <div className="px-6 pt-12 pb-4">
        <p className="mb-1 text-xs text-muted-foreground">{titleOf(data.path)}</p>
        <SheetTitle className="sr-only">{row.cells[primary.id] || "Untitled"}</SheetTitle>
        <SheetDescription className="sr-only">Every field of this row</SheetDescription>
        {editable ? (
          <TitleInput key={row.id} value={row.cells[primary.id] ?? ""} onCommit={(v) => void table.setCell(row.id, primary.id, v)} />
        ) : (
          <h2 className="text-2xl font-bold tracking-tight">{row.cells[primary.id] || "Untitled"}</h2>
        )}
      </div>
      <dl className="grid gap-px px-3 pb-6">
        {rest.map((col) => (
          <div key={col.id} className="grid grid-cols-[minmax(7rem,10rem)_1fr] items-start gap-2 rounded-md px-3 py-1.5 hover:bg-accent/50">
            <dt className="flex min-h-8 items-center gap-1.5 text-[0.8125rem] text-muted-foreground" title={col.description}>
              <TypeIcon type={col.type} />
              <span className="truncate">{col.name}</span>
            </dt>
            <dd className="min-h-8 min-w-0">
              <Field data={data} table={table} row={row} col={col} editable={editable} openRow={openRow} />
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-auto flex items-center gap-2 border-t px-6 py-3 text-xs text-muted-foreground">
        {row.created && <span>Added {formatDate(isoLocal(row.created), true)}</span>}
        {editable && (
          <span className="ml-auto flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const cells = Object.fromEntries(data.schema.columns.filter((c) => row.cells[c.id]).map((c) => [c.id, row.cells[c.id]]))
                await table.addRows([{ cells }], nextRow(data, row))
                toast.success("Duplicated the row")
              }}
            >
              <Copy /> Duplicate
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                const cells = row.cells
                void table.deleteRows([row.id])
                onDeleted()
                toast("Deleted the row", { action: { label: "Undo", onClick: () => void table.addRows([{ cells }], nextRow(data, row)) } })
              }}
            >
              <Trash2 /> Delete
            </Button>
          </span>
        )}
      </div>
    </div>
  )
}

/** The id of the row after this one, so an undo puts it back in place. */
const nextRow = (data: TableData, row: Row) => data.rows[data.rows.findIndex((r) => r.id === row.id) + 1]?.id ?? ""

/** An RFC 3339 time as the local "YYYY-MM-DDTHH:MM" formatDate reads. */
export function isoLocal(ts: string) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function TitleInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value)
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur()
        if (e.key === "Escape") setV(value)
      }}
      placeholder="Untitled"
      aria-label="Title"
      className="w-full bg-transparent text-2xl font-bold tracking-tight outline-none placeholder:text-muted-foreground/40"
    />
  )
}

/** One field of the panel: shown as its value, edited in place. */
export function Field({
  data,
  table,
  row,
  col,
  editable,
  openRow,
}: {
  data: TableData
  table: TableActions
  row: Row
  col: Column
  editable: boolean
  openRow: (path: string, id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const raw = row.cells[col.id] ?? ""
  const set = (v: string) => void table.setCell(row.id, col.id, v)
  const box = "flex min-h-8 w-full items-center rounded-md px-2 py-1 text-sm"
  if (col.type === "formula" || col.type === "rollup" || col.type === "created") {
    const err = data.errors[col.id]
    return (
      <div className={cn(box, "text-muted-foreground")} title={err}>
        {err ? <span className="truncate text-xs text-destructive">{err}</span> : <ValueText value={cellOf(data, row, col)} col={col} wrap />}
      </div>
    )
  }
  if (!editable) {
    return (
      <div className={box}>
        <CellView data={data} row={row} col={col} wrap onOpenRow={openRow} />
      </div>
    )
  }
  if (col.type === "checkbox") {
    return (
      <button type="button" className={cn(box, "hover:bg-accent")} onClick={() => set(raw === "true" ? "" : "true")} aria-pressed={raw === "true"} aria-label={col.name}>
        <CellView data={data} row={row} col={col} />
      </button>
    )
  }
  if (col.type === "select" || col.type === "multi" || col.type === "relation" || col.type === "file") {
    return (
      <Popover open={editing} onOpenChange={setEditing}>
        <PopoverTrigger asChild>
          <button type="button" className={cn(box, "text-left hover:bg-accent")}>
            {raw ? <CellView data={data} row={row} col={col} wrap onOpenRow={openRow} /> : <span className="text-muted-foreground/60">Empty</span>}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto gap-0 p-0">
          {col.type === "relation" ? (
            <RelationPicker col={col} data={data} value={raw} onChange={set} onDone={() => setEditing(false)} />
          ) : col.type === "file" ? (
            <FilePicker value={raw} onChange={set} />
          ) : (
            <OptionPicker col={col} value={raw} onChange={set} onDone={() => setEditing(false)} />
          )}
        </PopoverContent>
      </Popover>
    )
  }
  if (editing) {
    return (
      <div className={cn(box, "bg-background ring-2 ring-ring/40")}>
        <TextEditor
          col={col}
          initial={editText(col, raw)}
          onCommit={(v) => {
            setEditing(false)
            if (v !== editText(col, raw)) set(v)
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    )
  }
  return (
    <button type="button" onClick={() => setEditing(true)} className={cn(box, "text-left hover:bg-accent")}>
      {raw ? <CellView data={data} row={row} col={col} wrap onOpenRow={openRow} /> : <span className="text-muted-foreground/60">Empty</span>}
    </button>
  )
}
