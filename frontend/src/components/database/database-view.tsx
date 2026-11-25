import { useEffect, useMemo, useRef, useState } from "react"
import { cn } from "cn"
import {
  CalendarDays,
  ChartColumn,
  ClipboardList,
  Copy,
  Download,
  History,
  Kanban,
  LayoutGrid,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Table2,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { useSearchParams } from "react-router"
import { toast } from "sonner"

import { BoardView } from "@/components/database/board"
import { CalendarView } from "@/components/database/calendar-view"
import { ChartView } from "@/components/database/chart-view"
import { FormsDialog } from "@/components/database/forms"
import { GalleryView } from "@/components/database/gallery"
import { GridView } from "@/components/database/grid"
import { DataHistoryDialog } from "@/components/database/history"
import { RowSheet } from "@/components/database/row-sheet"
import { ColumnsButton, FilterButton, SortButton } from "@/components/database/toolbar"
import type { ViewProps } from "@/components/database/types"
import { useDialogs } from "@/components/dialogs"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { useTable } from "@/hooks/use-table"
import { errorMessage } from "@/hooks/use-vault"
import { ApiError, tableExportUrl, type View, type ViewType } from "@/lib/api"
import { newId, viewRows } from "@/lib/table"

export const viewTypes: { type: ViewType; label: string; icon: React.ComponentType<{ className?: string }>; hint: string }[] = [
  { type: "table", label: "Table", icon: Table2, hint: "Rows and columns, like a sheet" },
  { type: "board", label: "Board", icon: Kanban, hint: "Cards in lanes by a select column" },
  { type: "calendar", label: "Calendar", icon: CalendarDays, hint: "Rows on their dates" },
  { type: "gallery", label: "Gallery", icon: LayoutGrid, hint: "Cards in a grid" },
  { type: "chart", label: "Chart", icon: ChartColumn, hint: "Bars, lines or a pie of your numbers" },
]

const views: Record<ViewType, React.ComponentType<ViewProps>> = {
  table: GridView,
  board: BoardView,
  calendar: CalendarView,
  chart: ChartView,
  gallery: GalleryView,
}

const remember = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k) ?? ""
    } catch {
      return ""
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      // Not remembered in private mode.
    }
  },
}

/** A database page's rows: its views, the toolbar, and the open row. */
export function DatabaseView({ path, editable, embedded }: { path: string; editable: boolean; /** Shown inside another page: the open row stays out of the address bar. */ embedded?: boolean }) {
  const table = useTable(path)
  const { data, error, isLoading } = table
  const [params, setParams] = useSearchParams()
  const [localRow, setLocalRow] = useState<{ path: string; id: string } | null>(null)
  const [viewId, setViewId] = useState(() => remember.get(`quire.view.${path}`))
  const [search, setSearch] = useState("")
  const [searching, setSearching] = useState(false)
  const [formsOpen, setFormsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const { prompt, confirm } = useDialogs()

  const view = data?.schema.views.find((v) => v.id === viewId) ?? data?.schema.views[0]
  const rows = useMemo(() => (data && view ? viewRows(data, view, search) : []), [data, view, search])

  // ?row=<id> opens a row (links from the calendar), ?rowdb=<path> one of another database.
  const openId = embedded ? (localRow?.id ?? "") : (params.get("row") ?? "")
  const openPath = embedded ? (localRow?.path ?? path) : params.get("rowdb") || path
  const openRow = (p: string, id: string) =>
    embedded ? setLocalRow({ path: p, id }) : setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set("row", id)
        if (p !== path) next.set("rowdb", p)
        else next.delete("rowdb")
        return next
      },
      { replace: false },
    )
  const closeRow = () =>
    embedded ? setLocalRow(null) : setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete("row")
        next.delete("rowdb")
        return next
      },
      { replace: true },
    )

  useEffect(() => {
    if (view) remember.set(`quire.view.${path}`, view.id)
  }, [path, view])

  if (error instanceof ApiError && error.status === 404) {
    return <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">This database's rows file is missing. Restore it from page history or a backup.</p>
  }
  if (isLoading || !data || !view) {
    return (
      <div className="grid gap-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  const addView = (type: ViewType) => {
    const label = viewTypes.find((v) => v.type === type)!.label
    const taken = new Set(data.schema.views.map((v) => v.name))
    let name = label
    for (let i = 2; taken.has(name); i++) name = `${label} ${i}`
    const v: View = { id: newId("v"), name, type }
    const cols = data.schema.columns
    if (type === "board") v.groupBy = cols.find((c) => c.type === "select")?.id
    if (type === "calendar") v.dateColumn = cols.find((c) => c.type === "date")?.id ?? cols.find((c) => c.type === "created")?.id
    if (type === "chart") {
      const x = cols.find((c) => c.type === "select") ?? cols.find((c) => c.type === "date") ?? cols[0]
      const y = cols.find((c) => c.type === "number")
      v.chart = { kind: "bar", x: x.id, y: y?.id, aggregate: y ? "sum" : "count" }
    }
    void table.saveSchema({ ...data.schema, views: [...data.schema.views, v] })
    setViewId(v.id)
  }

  const renameView = async (v: View) => {
    const name = await prompt({ title: "Rename view", defaultValue: v.name, confirm: "Rename" })
    if (name?.trim()) void table.updateView(v.id, { name: name.trim() })
  }

  const deleteView = async (v: View) => {
    if (data.schema.views.length < 2) return
    const ok = await confirm({ title: `Delete the “${v.name}” view?`, description: "The rows stay; only this way of looking at them goes.", confirm: "Delete", destructive: true })
    if (!ok) return
    void table.saveSchema({ ...data.schema, views: data.schema.views.filter((x) => x.id !== v.id) })
    setViewId(data.schema.views.find((x) => x.id !== v.id)!.id)
  }

  const importFile = async (file: File | undefined) => {
    if (!file) return
    const id = toast.loading(`Importing ${file.name}…`)
    const before = data.rows.length
    try {
      const res = await table.importRows(file)
      if (res) toast.success(`Added ${res.rows.length - before} rows`, { id })
      else toast.dismiss(id)
    } catch (e) {
      toast.error(errorMessage(e), { id })
    }
  }

  const Body = views[view.type] ?? GridView
  const props: ViewProps = { data, table, view, rows, editable, openRow }

  return (
    <section aria-label="Database" className="not-prose">
      {/* On a phone the views get the first row to themselves and the tools go under them; side by side the views were squeezed to one. */}
      <div className="mb-2 flex flex-wrap items-center gap-x-1 gap-y-1.5 border-b pb-1.5 max-sm:border-b-0 max-sm:pb-0">
        <div role="tablist" aria-label="Views" className="-mb-[7px] flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto max-sm:mb-0 max-sm:basis-full max-sm:border-b">
          {data.schema.views.map((v) => {
            const Icon = viewTypes.find((t) => t.type === v.type)?.icon ?? Table2
            const active = v.id === view.id
            return (
              <div key={v.id} className={cn("group flex shrink-0 items-center border-b-2 pb-1", active ? "border-foreground" : "border-transparent")}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setViewId(v.id)}
                  onDoubleClick={() => editable && void renameView(v)}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-md px-2 text-[0.8125rem] transition-colors hover:bg-accent",
                    active ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  <Icon className="size-3.5" />
                  {v.name}
                </button>
                {editable && active && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-xs" aria-label={`${v.name} view options`} className="text-muted-foreground">
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-48">
                      <DropdownMenuItem onSelect={() => void renameView(v)}>
                        <Pencil /> Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => {
                          const copy = { ...structuredClone(v), id: newId("v"), name: `${v.name} copy` }
                          void table.saveSchema({ ...data.schema, views: [...data.schema.views, copy] })
                          setViewId(copy.id)
                        }}
                      >
                        <Copy /> Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" disabled={data.schema.views.length < 2} onSelect={() => void deleteView(v)}>
                        <Trash2 /> Delete view
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            )
          })}
          {editable && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="Add a view" className="mb-1 shrink-0 text-muted-foreground">
                  <Plus />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel className="text-xs text-muted-foreground">Add a view</DropdownMenuLabel>
                {viewTypes.map((t) => (
                  <DropdownMenuItem key={t.type} onSelect={() => addView(t.type)} className="items-start">
                    <t.icon className="mt-0.5" />
                    <span className="grid">
                      <span>{t.label}</span>
                      <span className="text-xs text-muted-foreground">{t.hint}</span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {searching ? (
            <div className="flex h-7 items-center gap-1 rounded-md border px-2">
              <Search className="size-3.5 text-muted-foreground" />
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearch("")
                    setSearching(false)
                  }
                }}
                onBlur={() => !search && setSearching(false)}
                placeholder="Search rows"
                aria-label="Search rows"
                className="w-32 bg-transparent text-[0.8125rem] outline-none"
              />
              {search && (
                <button type="button" aria-label="Clear search" onClick={() => (setSearch(""), setSearching(false))}>
                  <X className="size-3.5 text-muted-foreground" />
                </button>
              )}
            </div>
          ) : (
            <Button variant="ghost" size="icon-sm" aria-label="Search rows" className="text-muted-foreground" onClick={() => setSearching(true)}>
              <Search />
            </Button>
          )}
          <FilterButton data={data} view={view} table={table} editable={editable} />
          <SortButton data={data} view={view} table={table} editable={editable} />
          {(view.type === "table" || view.type === "gallery" || view.type === "board") && <ColumnsButton data={data} view={view} table={table} />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Database actions" className="text-muted-foreground">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={() => setFormsOpen(true)} disabled={!editable}>
                <ClipboardList /> Forms…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => fileInput.current?.click()} disabled={!editable}>
                <Upload /> Import CSV or Excel…
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={tableExportUrl(path)} download>
                  <Download /> Download as CSV
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setHistoryOpen(true)}>
                <History /> Data history
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={fileInput}
            type="file"
            hidden
            accept=".csv,.tsv,.txt,.xlsx,text/csv"
            onChange={(e) => {
              void importFile(e.target.files?.[0])
              e.target.value = ""
            }}
          />
        </div>
      </div>

      <Body {...props} />

      {openId && <RowSheet path={openPath} row={openId} onClose={closeRow} editable={editable} openRow={openRow} />}
      {formsOpen && <FormsDialog data={data} table={table} open={formsOpen} onOpenChange={setFormsOpen} />}
      {historyOpen && <DataHistoryDialog path={path} table={table} open={historyOpen} onOpenChange={setHistoryOpen} />}
    </section>
  )
}
