import { cn } from "cn"
import { ArrowDown, ArrowUp, ArrowUpDown, Eye, EyeOff, ListFilter, Plus, Trash2, X } from "lucide-react"

import { TypeIcon } from "@/components/database/cells"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { TableActions } from "@/hooks/use-table"
import type { Column, TableData, View, ViewFilter } from "@/lib/api"
import { filterOps, resultKind } from "@/lib/table"

const pill = "h-7 gap-1.5 px-2 text-[0.8125rem] font-normal text-muted-foreground"

/** Filters for a view: each a column, a test and maybe a value. */
export function FilterButton({ data, view, table, editable }: { data: TableData; view: View; table: TableActions; editable: boolean }) {
  const filters = view.filters ?? []
  const columns = data.schema.columns
  const set = (next: ViewFilter[], match = view.match) => void table.updateView(view.id, { filters: next, match })
  const active = filters.length
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className={cn(pill, active && "bg-brand-soft text-brand hover:bg-brand-soft hover:text-brand")}>
          <ListFilter /> {active ? `${active} ${active === 1 ? "filter" : "filters"}` : <span className="max-md:sr-only">Filter</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(34rem,calc(100vw-2rem))] gap-2 p-3">
        {filters.length === 0 && <p className="px-1 text-sm text-muted-foreground">No filters. Every row shows.</p>}
        {filters.map((f, i) => {
          const col = columns.find((c) => c.id === f.column)
          if (!col) return null
          const ops = filterOps(col)
          const op = ops.find((o) => o.op === f.op) ?? ops[0]
          const update = (patch: Partial<ViewFilter>) => set(filters.map((x, j) => (j === i ? { ...x, ...patch } : x)))
          return (
            <div key={i} className="flex flex-wrap items-center gap-1.5 sm:flex-nowrap">
              <span className="w-12 shrink-0 text-xs text-muted-foreground">
                {i === 0 ? (
                  "Where"
                ) : i === 1 ? (
                  <Select value={view.match ?? "all"} onValueChange={(m) => set(filters, m as "all" | "any")} disabled={!editable}>
                    <SelectTrigger size="sm" className="h-7 w-14 px-1.5 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">and</SelectItem>
                      <SelectItem value="any">or</SelectItem>
                    </SelectContent>
                  </Select>
                ) : view.match === "any" ? (
                  "or"
                ) : (
                  "and"
                )}
              </span>
              <ColumnSelect columns={columns} value={f.column} onChange={(c) => update({ column: c, op: filterOps(columns.find((x) => x.id === c)!)[0].op, value: "" })} />
              <Select value={op.op} onValueChange={(o) => update({ op: o })} disabled={!editable}>
                <SelectTrigger size="sm" className="h-7 w-36 shrink-0 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ops.map((o) => (
                    <SelectItem key={o.op} value={o.op}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {op.needsValue ? <FilterValue col={col} value={f.value ?? ""} onChange={(v) => update({ value: v })} /> : <span className="flex-1" />}
              <Button variant="ghost" size="icon-xs" aria-label="Remove filter" onClick={() => set(filters.filter((_, j) => j !== i))} disabled={!editable}>
                <X />
              </Button>
            </div>
          )
        })}
        {editable && (
          <div className="flex items-center justify-between pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                const col = columns[0]
                set([...filters, { column: col.id, op: filterOps(col)[0].op, value: "" }])
              }}
            >
              <Plus /> Add a filter
            </Button>
            {filters.length > 0 && (
              <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => set([])}>
                <Trash2 /> Clear
              </Button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function FilterValue({ col, value, onChange }: { col: Column; value: string; onChange: (v: string) => void }) {
  if (col.type === "select" || col.type === "multi") {
    return (
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 text-xs">
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {(col.options ?? []).map((o) => (
            <SelectItem key={o.name} value={o.name}>
              {o.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }
  const kind = resultKind(col)
  return (
    <Input
      type={kind === "date" ? "date" : "text"}
      inputMode={kind === "number" ? "decimal" : undefined}
      value={value}
      placeholder="Value"
      onChange={(e) => onChange(e.target.value)}
      className="h-7 min-w-0 flex-1 text-xs"
    />
  )
}

function ColumnSelect({ columns, value, onChange }: { columns: Column[]; value: string; onChange: (id: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="h-7 w-36 shrink-0 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {columns.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            <TypeIcon type={c.type} /> {c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Sorting for a view: columns in order of priority. */
export function SortButton({ data, view, table, editable }: { data: TableData; view: View; table: TableActions; editable: boolean }) {
  const sorts = view.sorts ?? []
  const columns = data.schema.columns
  const set = (next: View["sorts"]) => void table.updateView(view.id, { sorts: next })
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className={cn(pill, sorts.length && "bg-brand-soft text-brand hover:bg-brand-soft hover:text-brand")}>
          <ArrowUpDown /> {sorts.length ? `${sorts.length} ${sorts.length === 1 ? "sort" : "sorts"}` : <span className="max-md:sr-only">Sort</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] gap-2 p-3">
        {sorts.length === 0 && <p className="px-1 text-sm text-muted-foreground">Rows are in the order you put them.</p>}
        {sorts.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <ColumnSelect columns={columns} value={s.column} onChange={(c) => set(sorts.map((x, j) => (j === i ? { ...x, column: c } : x)))} />
            <Select value={s.desc ? "desc" : "asc"} onValueChange={(d) => set(sorts.map((x, j) => (j === i ? { ...x, desc: d === "desc" } : x)))}>
              <SelectTrigger size="sm" className="h-7 flex-1 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asc">
                  <ArrowUp /> Ascending
                </SelectItem>
                <SelectItem value="desc">
                  <ArrowDown /> Descending
                </SelectItem>
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon-xs" aria-label="Remove sort" onClick={() => set(sorts.filter((_, j) => j !== i))}>
              <X />
            </Button>
          </div>
        ))}
        {editable && (
          <div className="pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                const unused = columns.find((c) => !sorts.some((s) => s.column === c.id)) ?? columns[0]
                set([...sorts, { column: unused.id }])
              }}
            >
              <Plus /> Add a sort
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Shows and hides columns in a view. The first column always shows. */
export function ColumnsButton({ data, view, table }: { data: TableData; view: View; table: TableActions }) {
  const hidden = new Set(view.hidden ?? [])
  const toggle = (id: string) => {
    const next = new Set(hidden)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    void table.updateView(view.id, { hidden: [...next] })
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className={cn(pill, hidden.size && "text-foreground")} aria-label="Show and hide columns">
          <EyeOff /> <span className="max-lg:sr-only">{hidden.size ? `${hidden.size} hidden` : "Columns"}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 gap-0 p-1.5">
        {data.schema.columns.map((c, i) => (
          <button
            key={c.id}
            type="button"
            disabled={i === 0}
            onClick={() => toggle(c.id)}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-60 disabled:hover:bg-transparent"
          >
            <TypeIcon type={c.type} />
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            {hidden.has(c.id) ? <EyeOff className="size-3.5 text-muted-foreground" /> : <Eye className="size-3.5" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
