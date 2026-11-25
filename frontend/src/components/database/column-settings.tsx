import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { cn } from "cn"
import {
  ArrowDown,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Copy,
  EyeOff,
  ListFilter,
  Loader2,
  Plus,
  Trash2,
  WrapText,
  X,
} from "lucide-react"

import { TypeIcon } from "@/components/database/cells"
import { useDialogs } from "@/components/dialogs"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import type { TableActions } from "@/hooks/use-table"
import { api, type Column, type ColumnType, type SelectOption, type TableData, type View } from "@/lib/api"
import { titleOf } from "@/lib/notes"
import { colorNames, colorOf, columnTypes, display, filterOps, freshName, fromFormula, isStored, newId, splitMulti } from "@/lib/table"

/** The settings a column takes when it becomes a type. */
function retype(col: Column, type: ColumnType): Column {
  const next: Column = { id: col.id, name: col.name, type, width: col.width, description: col.description }
  if (type === "select" || type === "multi") next.options = col.options ?? []
  if (type === "number" && col.type === "number") Object.assign(next, { format: col.format, decimals: col.decimals, currency: col.currency })
  if (type === "rollup") next.aggregate = "show"
  return next
}

const numberFormats = [
  { value: "number", label: "Number" },
  { value: "currency", label: "Currency" },
  { value: "percent", label: "Percent" },
]

const resultFormats = [
  { value: "auto", label: "Automatic" },
  { value: "number", label: "Number" },
  { value: "currency", label: "Currency" },
  { value: "percent", label: "Percent" },
  { value: "date", label: "Date" },
  { value: "text", label: "Text" },
  { value: "checkbox", label: "Checkbox" },
]

const aggregates = [
  { value: "show", label: "Show the values" },
  { value: "count", label: "Count rows" },
  { value: "filled", label: "Count filled" },
  { value: "unique", label: "Count unique" },
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "min", label: "Smallest" },
  { value: "max", label: "Largest" },
  { value: "checked", label: "Count checked" },
  { value: "percent", label: "Percent checked" },
]

const label = "text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground"
const action = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.8125rem] hover:bg-accent disabled:pointer-events-none disabled:opacity-50 [&>svg]:size-3.5 [&>svg]:text-muted-foreground"

/**
 * A column's header menu: its name, type, type settings and what you can do
 * with it in this view. children is the header that opens it.
 */
export function ColumnMenu({
  data,
  table,
  view,
  col,
  editable,
  open,
  onOpenChange,
  fresh,
  children,
}: {
  data: TableData
  table: TableActions
  view: View
  col: Column
  editable: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  /** A column just added: its name is selected for typing over. */
  fresh?: boolean
  children: React.ReactNode
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[min(36rem,var(--radix-popover-content-available-height))] w-80 gap-0 overflow-y-auto p-0"
        onOpenAutoFocus={(e) => !fresh && e.preventDefault()}
      >
        {open && <ColumnSettings data={data} table={table} view={view} col={col} editable={editable} fresh={fresh} close={() => onOpenChange(false)} />}
      </PopoverContent>
    </Popover>
  )
}

function ColumnSettings({
  data,
  table,
  view,
  col,
  editable,
  fresh,
  close,
}: {
  data: TableData
  table: TableActions
  view: View
  col: Column
  editable: boolean
  fresh?: boolean
  close: () => void
}) {
  const { confirm } = useDialogs()
  const columns = data.schema.columns
  const index = columns.findIndex((c) => c.id === col.id)
  const primary = index === 0
  const [name, setName] = useState(col.name)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (fresh) nameRef.current?.select()
  }, [fresh])

  const update = (patch: Partial<Column>) => void table.updateColumn(col.id, patch)
  const commitName = () => {
    const n = name.replace(/[{}[\]/]/g, " ").replace(/\s+/g, " ").trim()
    if (!n || n === col.name) return setName(col.name)
    if (columns.some((c) => c.id !== col.id && c.name.toLowerCase() === n.toLowerCase())) return setName(col.name)
    update({ name: n })
  }

  const hasValues = data.rows.some((r) => r.cells[col.id])
  const changeType = async (type: ColumnType) => {
    if (type === col.type) return
    if (isStored(col.type) && !isStored(type) && hasValues) {
      const ok = await confirm({
        title: `Make “${col.name}” a ${columnTypes.find((t) => t.type === type)?.label.toLowerCase()}?`,
        description: "Its values are worked out instead of typed in, so the values in it now go. They stay in the data history.",
        confirm: "Change type",
        destructive: true,
      })
      if (!ok) return
    }
    if (type === "relation" && hasValues) {
      // Text can't be read as links to rows, so start the column empty.
      await table.setCells(data.rows.filter((r) => r.cells[col.id]).map((r) => ({ id: r.id, cells: { [col.id]: "" } })))
    }
    const s = data.schema
    void table.saveSchema({ ...s, columns: s.columns.map((c) => (c.id === col.id ? retype(c, type) : c)) })
  }

  const setView = (patch: Partial<View>) => void table.updateView(view.id, patch)
  const insert = (offset: 0 | 1) => {
    const c: Column = { id: newId("c"), name: freshName(columns, "Column"), type: "text" }
    const next = [...columns]
    next.splice(Math.max(1, index + offset), 0, c)
    void table.saveSchema({ ...data.schema, columns: next })
    close()
  }
  const duplicate = () => {
    const c: Column = { ...structuredClone(col), id: newId("c"), name: freshName(columns, `${col.name} copy`) }
    const next = [...columns]
    next.splice(index + 1, 0, c)
    void table.saveSchema({ ...data.schema, columns: next }).then(() => {
      // The copy starts with the same values.
      if (isStored(col.type)) {
        const rows = data.rows.filter((r) => r.cells[col.id]).map((r) => ({ id: r.id, cells: { [c.id]: r.cells[col.id] } }))
        if (rows.length) void table.setCells(rows)
      }
    })
    close()
  }
  const remove = async () => {
    const ok = await confirm({
      title: `Delete the “${col.name}” column?`,
      description: "Its values go with it. They stay in the data history if you need them back.",
      confirm: "Delete",
      destructive: true,
    })
    if (!ok) return
    void table.saveSchema({ ...data.schema, columns: columns.filter((c) => c.id !== col.id) })
    close()
  }

  return (
    <div className="grid">
      <div className="grid gap-2 border-b p-3">
        <div className="flex items-center gap-2">
          <TypeIcon type={col.type} className="size-4" />
          <Input
            ref={nameRef}
            value={name}
            disabled={!editable}
            aria-label="Column name"
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitName()
                close()
              }
              if (e.key === "Escape") setName(col.name)
            }}
            className="h-8"
          />
        </div>
        {editable && (
          <>
            <Select value={col.type} onValueChange={(t) => void changeType(t as ColumnType)} disabled={primary}>
              <SelectTrigger size="sm" className="w-full text-[0.8125rem]" aria-label="Column type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-80">
                {columnTypes.map((t, i) => (
                  <div key={t.type}>
                    {(i === 11 || i === 12) && <SelectSeparator />}
                    <SelectItem value={t.type}>
                      <TypeIcon type={t.type} />
                      <span>{t.label}</span>
                      <span className="text-xs text-muted-foreground">{t.hint}</span>
                    </SelectItem>
                  </div>
                ))}
              </SelectContent>
            </Select>
            {primary && <p className="text-xs text-muted-foreground">The first column names each row, so it stays text.</p>}
          </>
        )}
      </div>

      {editable && <TypeSettings data={data} table={table} col={col} />}

      {editable && (
        <div className="grid gap-1.5 border-b p-3">
          <span className={label}>Description</span>
          <DescriptionInput value={col.description ?? ""} onCommit={(v) => update({ description: v || undefined })} />
        </div>
      )}

      <div className="grid p-1.5">
        <button type="button" className={action} onClick={() => (setView({ sorts: [{ column: col.id }] }), close())}>
          <ArrowUp /> Sort ascending
        </button>
        <button type="button" className={action} onClick={() => (setView({ sorts: [{ column: col.id, desc: true }] }), close())}>
          <ArrowDown /> Sort descending
        </button>
        {editable && (
          <button
            type="button"
            className={action}
            onClick={() => {
              setView({ filters: [...(view.filters ?? []), { column: col.id, op: filterOps(col)[0].op, value: "" }] })
              close()
            }}
          >
            <ListFilter /> Filter by this column
          </button>
        )}
        <button type="button" className={action} disabled={primary} onClick={() => (setView({ hidden: [...(view.hidden ?? []), col.id] }), close())}>
          <EyeOff /> Hide in this view
        </button>
        <label className={cn(action, "cursor-pointer")}>
          <WrapText /> Wrap text
          <Switch size="sm" className="ml-auto" checked={!!view.wrap} onCheckedChange={(v) => setView({ wrap: v || undefined })} />
        </label>
        {editable && (
          <>
            <div className="my-1 h-px bg-border" />
            <button type="button" className={action} disabled={primary} onClick={() => insert(0)}>
              <ArrowLeftToLine /> Insert left
            </button>
            <button type="button" className={action} onClick={() => insert(1)}>
              <ArrowRightToLine /> Insert right
            </button>
            <button type="button" className={action} disabled={primary} onClick={duplicate}>
              <Copy /> Duplicate
            </button>
            <button type="button" className={cn(action, "text-destructive [&>svg]:text-destructive")} disabled={primary} onClick={() => void remove()}>
              <Trash2 /> Delete column
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function DescriptionInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value)
  return (
    <Input
      value={v}
      placeholder="What goes in this column"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() !== value && onCommit(v.trim())}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className="h-8 text-[0.8125rem]"
    />
  )
}

/** Settings that depend on the column's type. */
function TypeSettings({ data, table, col }: { data: TableData; table: TableActions; col: Column }) {
  const update = (patch: Partial<Column>) => void table.updateColumn(col.id, patch)
  switch (col.type) {
    case "number":
      return (
        <Section title="Format">
          <NumberFormat col={col} formats={numberFormats} update={update} />
        </Section>
      )
    case "date":
      return (
        <Section title="Format">
          <label className="flex items-center justify-between gap-2 text-[0.8125rem]">
            Include the time
            <Switch size="sm" checked={col.format === "datetime"} onCheckedChange={(v) => update({ format: v ? "datetime" : undefined })} />
          </label>
        </Section>
      )
    case "select":
    case "multi":
      return (
        <Section title="Options">
          <OptionsEditor data={data} table={table} col={col} />
        </Section>
      )
    case "relation":
      return (
        <Section title="Links to">
          <RelationTarget data={data} col={col} update={update} />
        </Section>
      )
    case "rollup":
      return (
        <Section title="Rollup">
          <RollupSettings data={data} col={col} update={update} />
          <span className={cn(label, "mt-2")}>Show as</span>
          <NumberFormat col={col} formats={resultFormats} update={update} />
        </Section>
      )
    case "formula":
      return (
        <Section title="Formula">
          <FormulaEditor data={data} col={col} onSave={(formula) => update({ formula })} />
          <span className={cn(label, "mt-2")}>Show as</span>
          <NumberFormat col={col} formats={resultFormats} update={update} />
        </Section>
      )
  }
  return null
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5 border-b p-3">
      <span className={label}>{title}</span>
      {children}
    </div>
  )
}

/** Number, currency or percent, with decimal places and the currency. */
function NumberFormat({ col, formats, update }: { col: Column; formats: { value: string; label: string }[]; update: (p: Partial<Column>) => void }) {
  const format = col.format || formats[0].value
  const numeric = format === "number" || format === "currency" || format === "percent"
  return (
    <div className="grid gap-1.5">
      <Select value={format} onValueChange={(f) => update({ format: f === "auto" ? undefined : f })}>
        <SelectTrigger size="sm" className="w-full text-[0.8125rem]" aria-label="Format">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {formats.map((f) => (
            <SelectItem key={f.value} value={f.value}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {numeric && (
        <div className="flex gap-1.5">
          <Select value={col.decimals === undefined ? "auto" : String(col.decimals)} onValueChange={(d) => update({ decimals: d === "auto" ? undefined : Number(d) })}>
            <SelectTrigger size="sm" className="flex-1 text-[0.8125rem]" aria-label="Decimal places">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Decimals: as typed</SelectItem>
              {[0, 1, 2, 3, 4].map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d === 0 ? "Whole numbers" : `${d} decimal ${d === 1 ? "place" : "places"}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {format === "currency" && <CurrencyInput value={col.currency || "USD"} onCommit={(c) => update({ currency: c })} />}
        </div>
      )}
    </div>
  )
}

function CurrencyInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value)
  const commit = () => {
    const c = v.trim().toUpperCase()
    let ok = /^[A-Z]{3}$/.test(c)
    if (ok) {
      try {
        new Intl.NumberFormat(undefined, { style: "currency", currency: c })
      } catch {
        ok = false
      }
    }
    if (ok && c !== value) onCommit(c)
    else setV(value)
  }
  return (
    <Input
      value={v}
      maxLength={3}
      aria-label="Currency code"
      title="Currency code, like USD, EUR or GBP"
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className="h-7 w-16 text-center text-[0.8125rem] uppercase"
    />
  )
}

/**
 * Renames, recolours, reorders and removes select options. Renaming or
 * removing one changes the rows that use it too.
 */
function OptionsEditor({ data, table, col }: { data: TableData; table: TableActions; col: Column }) {
  const options = col.options ?? []
  const [adding, setAdding] = useState("")
  const setOptions = (next: SelectOption[]) => void table.updateColumn(col.id, { options: next })

  /** Rewrites rows that hold an option's name; to "" drops it. */
  const rewriteRows = (from: string, to: string) => {
    const updates = data.rows.flatMap((r) => {
      const raw = r.cells[col.id] ?? ""
      if (!raw) return []
      if (col.type === "select") return raw.toLowerCase() === from.toLowerCase() ? [{ id: r.id, cells: { [col.id]: to } }] : []
      const items = splitMulti(raw)
      if (!items.some((i) => i.toLowerCase() === from.toLowerCase())) return []
      const next = items.flatMap((i) => (i.toLowerCase() === from.toLowerCase() ? (to ? [to] : []) : [i]))
      return [{ id: r.id, cells: { [col.id]: next.join(", ") } }]
    })
    if (updates.length) void table.setCells(updates)
  }

  const rename = (i: number, name: string) => {
    const n = name.replace(/,/g, " ").replace(/\s+/g, " ").trim()
    const old = options[i].name
    if (!n || n === old || options.some((o, j) => j !== i && o.name.toLowerCase() === n.toLowerCase())) return false
    setOptions(options.map((o, j) => (j === i ? { ...o, name: n } : o)))
    rewriteRows(old, n)
    return true
  }
  const move = (i: number, by: number) => {
    const next = [...options]
    const [o] = next.splice(i, 1)
    next.splice(i + by, 0, o)
    setOptions(next)
  }
  const add = () => {
    const n = adding.replace(/,/g, " ").replace(/\s+/g, " ").trim()
    setAdding("")
    if (!n || options.some((o) => o.name.toLowerCase() === n.toLowerCase())) return
    setOptions([...options, { name: n, color: colorNames[options.length % colorNames.length] }])
  }

  return (
    <div className="grid gap-1">
      {options.length === 0 && <p className="text-xs text-muted-foreground">No options yet. Add some here, or type new ones in a cell.</p>}
      {options.map((o, i) => (
        <div key={o.name} className="group flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={`Colour of ${o.name}`} className="grid size-6 shrink-0 place-items-center rounded hover:bg-accent">
                <span className={cn("size-3 rounded-full", colorOf(o.color).dot)} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-36">
              {colorNames.map((c) => (
                <DropdownMenuItem key={c} onSelect={() => setOptions(options.map((x, j) => (j === i ? { ...x, color: c } : x)))}>
                  <span className={cn("size-3 rounded-full", colorOf(c).dot)} />
                  <span className="capitalize">{c}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <OptionName name={o.name} onCommit={(n) => rename(i, n)} />
          <span className="flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
            <Button variant="ghost" size="icon-xs" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
              <ChevronUp />
            </Button>
            <Button variant="ghost" size="icon-xs" aria-label="Move down" disabled={i === options.length - 1} onClick={() => move(i, 1)}>
              <ChevronDown />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${o.name}`}
              onClick={() => {
                setOptions(options.filter((_, j) => j !== i))
                rewriteRows(o.name, "")
              }}
            >
              <X />
            </Button>
          </span>
        </div>
      ))}
      <div className="flex items-center gap-1 pt-1">
        <Plus className="mx-1.5 size-3.5 text-muted-foreground" />
        <input
          value={adding}
          placeholder="Add an option"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          onBlur={add}
          className="h-7 flex-1 bg-transparent text-[0.8125rem] outline-none placeholder:text-muted-foreground"
        />
      </div>
    </div>
  )
}

function OptionName({ name, onCommit }: { name: string; onCommit: (n: string) => boolean }) {
  const [v, setV] = useState(name)
  return (
    <input
      value={v}
      aria-label="Option name"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== name && !onCommit(v) && setV(name)}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className="h-7 min-w-0 flex-1 rounded px-1.5 text-[0.8125rem] outline-none hover:bg-accent focus:bg-accent"
    />
  )
}

function RelationTarget({ data, col, update }: { data: TableData; col: Column; update: (p: Partial<Column>) => void }) {
  const { data: tables, isLoading } = useQuery({ queryKey: ["tables"], queryFn: api.tables })
  const target = data.targets[col.id] || col.target || ""
  if (isLoading) return <Loader2 className="size-4 animate-spin text-muted-foreground" />
  return (
    <>
      <Select value={target || undefined} onValueChange={(t) => update({ target: t })}>
        <SelectTrigger size="sm" className="w-full text-[0.8125rem]" aria-label="Database it links to">
          <SelectValue placeholder="Choose a database…" />
        </SelectTrigger>
        <SelectContent>
          {(tables ?? []).map((t) => (
            <SelectItem key={t.path} value={t.path}>
              {t.title}
              <span className="text-xs text-muted-foreground">{t.path === data.path ? "this database" : t.path.split("/")[0]}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {data.errors[col.id] && <p className="text-xs text-destructive">{data.errors[col.id]}</p>}
    </>
  )
}

function RollupSettings({ data, col, update }: { data: TableData; col: Column; update: (p: Partial<Column>) => void }) {
  const relations = data.schema.columns.filter((c) => c.type === "relation")
  const rel = relations.find((c) => c.id === col.relation)
  const target = rel ? data.targets[rel.id] || rel.target || "" : ""
  const { data: other } = useQuery({ queryKey: ["table", target], queryFn: () => api.table(target), enabled: !!target })
  if (!relations.length) return <p className="text-xs text-muted-foreground">Add a relation column first. A rollup totals values from the rows it links to.</p>
  return (
    <div className="grid gap-1.5">
      <Select value={col.relation || undefined} onValueChange={(r) => update({ relation: r, field: undefined })}>
        <SelectTrigger size="sm" className="w-full text-[0.8125rem]" aria-label="Relation">
          <SelectValue placeholder="Through relation…" />
        </SelectTrigger>
        <SelectContent>
          {relations.map((r) => (
            <SelectItem key={r.id} value={r.id}>
              <TypeIcon type="relation" /> {r.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {rel && (
        <Select value={col.field || undefined} onValueChange={(f) => update({ field: f })} disabled={!other}>
          <SelectTrigger size="sm" className="w-full text-[0.8125rem]" aria-label="Column to read">
            <SelectValue placeholder={target ? `Column of ${titleOf(target)}…` : "Choose its database first"} />
          </SelectTrigger>
          <SelectContent>
            {(other?.schema.columns ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                <TypeIcon type={c.type} /> {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Select value={col.aggregate || "show"} onValueChange={(a) => update({ aggregate: a })}>
        <SelectTrigger size="sm" className="w-full text-[0.8125rem]" aria-label="Combine">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {aggregates.map((a) => (
            <SelectItem key={a.value} value={a.value}>
              {a.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {data.errors[col.id] && <p className="text-xs text-destructive">{data.errors[col.id]}</p>}
    </div>
  )
}

// ── Formula editor ──

type Suggestion = { insert: string; label: string; hint?: string; keepOpen?: boolean }

/**
 * Edits a formula with suggestions for column names (after { or [) and
 * functions, and a preview of the first rows' results.
 */
export function FormulaEditor({ data, col, onSave }: { data: TableData; col: Column; onSave: (formula: string) => void }) {
  const [text, setText] = useState(col.formula ?? "")
  const [caret, setCaret] = useState(0)
  const [pick, setPick] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const { data: functions } = useQuery({ queryKey: ["functions"], queryFn: api.functions, staleTime: Infinity })
  const { data: tables } = useQuery({ queryKey: ["tables"], queryFn: api.tables })
  const [preview, setPreview] = useState<{ error?: string; values: { title: string; text: string }[] } | null>(null)
  const [checking, setChecking] = useState(false)

  // Preview as you type, a moment after you stop.
  useEffect(() => {
    if (!text.trim()) {
      setPreview(null)
      return
    }
    setChecking(true)
    let live = true
    const t = setTimeout(async () => {
      try {
        const res = await api.previewFormula(data.path, text, col.id)
        if (!live) return
        const fmt = { ...col, type: "formula" as const }
        setPreview({ error: res.error, values: res.values.map((v) => ({ title: v.title, text: display(fromFormula(v.value), fmt) || "–" })) })
      } catch {
        if (live) setPreview(null)
      } finally {
        if (live) setChecking(false)
      }
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [text, data.path, col.id, col.format, col.decimals, col.currency]) // eslint-disable-line react-hooks/exhaustive-deps

  const suggestions = useMemo<{ from: number; items: Suggestion[] }>(() => {
    const before = text.slice(0, caret)
    // Inside quotes, nothing to suggest.
    if ((before.match(/"/g)?.length ?? 0) % 2 === 1) return { from: caret, items: [] }
    const ref = /([{[])([^{}[\]]*)$/.exec(before)
    if (ref) {
      const [, open, part] = ref
      const close = open === "{" ? "}" : "]"
      const q = part.toLowerCase()
      const from = caret - part.length - 1
      if (open === "[" && part.includes("/")) {
        const [db, colPart] = [part.slice(0, part.lastIndexOf("/")), part.slice(part.lastIndexOf("/") + 1).toLowerCase()]
        const t = tables?.find((x) => x.title.toLowerCase() === db.toLowerCase())
        return {
          from,
          items: (t?.columns ?? [])
            .filter((c) => c.name.toLowerCase().includes(colPart))
            .map((c) => ({ insert: `[${t!.title}/${c.name}]`, label: `${t!.title}/${c.name}` })),
        }
      }
      const items: Suggestion[] = data.schema.columns
        .filter((c) => c.id !== col.id && c.name.toLowerCase().includes(q))
        .map((c) => ({ insert: `${open}${c.name}${close}`, label: c.name, hint: open === "{" ? "this row" : "whole column" }))
      if (open === "[") {
        for (const t of tables ?? []) {
          if (t.path !== data.path && t.title.toLowerCase().includes(q)) items.push({ insert: `[${t.title}/`, label: `${t.title}/…`, hint: "another database", keepOpen: true })
        }
      }
      return { from, items }
    }
    const word = /(^|[^A-Za-z0-9_.])([A-Za-z][A-Za-z0-9_.]*)$/.exec(before)
    if (word && functions) {
      const part = word[2].toUpperCase()
      return {
        from: caret - word[2].length,
        items: functions
          .filter((f) => f.name.startsWith(part) && f.name !== part)
          .slice(0, 8)
          .map((f) => ({ insert: `${f.name}(`, label: f.name, hint: f.help })),
      }
    }
    return { from: caret, items: [] }
  }, [text, caret, data.schema.columns, data.path, col.id, functions, tables])

  // The help for the function the caret is in, so you know its arguments.
  const currentHelp = useMemo(() => {
    const before = text.slice(0, caret)
    let depth = 0
    for (let i = before.length - 1; i >= 0; i--) {
      if (before[i] === ")") depth++
      else if (before[i] === "(") {
        if (depth === 0) {
          const name = /([A-Za-z][A-Za-z0-9_.]*)$/.exec(before.slice(0, i))?.[1]?.toUpperCase()
          return functions?.find((f) => f.name === name)?.help
        }
        depth--
      }
    }
    return undefined
  }, [text, caret, functions])

  const items = suggestions.items
  const choose = (s: Suggestion) => {
    const next = text.slice(0, suggestions.from) + s.insert + text.slice(caret)
    const at = suggestions.from + s.insert.length
    setText(next)
    setCaret(at)
    setPick(0)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(at, at)
    })
  }
  const dirty = text !== (col.formula ?? "")

  return (
    <div className="grid gap-1.5">
      <div className="relative">
        <textarea
          ref={ref}
          value={text}
          spellCheck={false}
          rows={3}
          placeholder="{Price} * {Qty}"
          aria-label="Formula"
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart)
            setPick(0)
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault()
              onSave(text.trim())
              return
            }
            if (!items.length) return
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault()
              setPick((p) => (p + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length)
            } else if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault()
              choose(items[Math.min(pick, items.length - 1)])
            } else if (e.key === "Escape") {
              e.stopPropagation()
              setCaret(-1)
            }
          }}
          className="w-full resize-y rounded-md border bg-transparent px-2.5 py-2 font-mono text-[0.8125rem] leading-5 outline-none focus:border-ring focus:ring-3 focus:ring-ring/30"
        />
        {items.length > 0 && caret >= 0 && (
          <div role="listbox" className="absolute inset-x-0 top-full z-10 mt-1 max-h-52 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
            {items.map((s, i) => (
              <button
                key={s.insert + s.label}
                type="button"
                role="option"
                aria-selected={i === pick}
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(s)
                }}
                className={cn("grid w-full rounded px-2 py-1 text-left", i === pick && "bg-accent")}
              >
                <span className="truncate font-mono text-xs">{s.label}</span>
                {s.hint && <span className="truncate text-[0.6875rem] text-muted-foreground">{s.hint}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {currentHelp && <p className="font-mono text-[0.6875rem] text-muted-foreground">{currentHelp}</p>}
      <div className="min-h-5 text-xs">
        {checking && !preview ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : preview?.error ? (
          <p className="text-destructive">{preview.error}</p>
        ) : preview && preview.values.length > 0 ? (
          <div className="grid gap-0.5 rounded-md bg-muted/60 px-2 py-1.5">
            {preview.values.map((v, i) => (
              <div key={i} className="flex justify-between gap-3">
                <span className="truncate text-muted-foreground">{v.title}</span>
                <span className="shrink-0 font-mono tabular-nums">{v.text}</span>
              </div>
            ))}
          </div>
        ) : preview ? (
          <p className="text-muted-foreground">Looks right. Add a row to see a result.</p>
        ) : null}
      </div>
      <p className="text-[0.6875rem] leading-4 text-muted-foreground">
        <code className="font-mono">{"{Column}"}</code> is this row's value, <code className="font-mono">[Column]</code> the whole column,{" "}
        <code className="font-mono">[Database/Column]</code> another database's. <code className="font-mono">&</code> joins text. Try{" "}
        <code className="font-mono">{'IF({Paid}, 0, {Amount})'}</code> or <code className="font-mono">{'SUMIF([Category], "Food", [Amount])'}</code>.
      </p>
      <div className="flex justify-end gap-1.5">
        {dirty && (
          <Button variant="ghost" size="sm" onClick={() => setText(col.formula ?? "")}>
            Reset
          </Button>
        )}
        <Button size="sm" disabled={!dirty} onClick={() => onSave(text.trim())}>
          Save formula
        </Button>
      </div>
    </div>
  )
}
