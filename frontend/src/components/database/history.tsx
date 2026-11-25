import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { cn } from "cn"
import { Columns3, History, Loader2, RotateCcw, Rows3 } from "lucide-react"
import { toast } from "sonner"

import { TypeIcon } from "@/components/database/cells"
import { useDialogs } from "@/components/dialogs"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { TableActions } from "@/hooks/use-table"
import { api, type ColumnType, type Revision, type Schema } from "@/lib/api"
import { formatBytes, titleOf } from "@/lib/notes"
import { typeLabel } from "@/lib/table"

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : "numeric" })
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
const sourceLabel: Record<string, string> = { edit: "Edited", form: "Form answers", restore: "Restored", earlier: "Earlier version", disk: "Changed outside Quire" }
const isRows = (r: Revision) => r.path.toLowerCase().endsWith(".csv")

/** Earlier versions of a database's rows and columns, to look at and restore. */
export function DataHistoryDialog({ path, table, open, onOpenChange }: { path: string; table: TableActions; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { data: revisions, isLoading } = useQuery({ queryKey: ["table-history", path], queryFn: () => api.tableHistory(path), enabled: open })
  const [selected, setSelected] = useState<number | null>(null)
  const { data: rev, isFetching } = useQuery({ queryKey: ["revision", selected], queryFn: () => api.revision(selected!), enabled: open && selected !== null })
  const [busy, setBusy] = useState(false)
  const { confirm } = useDialogs()

  useEffect(() => {
    if (open && revisions?.length && (selected === null || !revisions.some((r) => r.id === selected))) setSelected(revisions[0].id)
  }, [open, revisions, selected])

  // The newest version of each file is what's there now.
  const current = useMemo(() => {
    const ids = new Set<number>()
    const seen = new Set<string>()
    for (const r of revisions ?? []) {
      if (!seen.has(r.path)) {
        seen.add(r.path)
        ids.add(r.id)
      }
    }
    return ids
  }, [revisions])

  const groups = useMemo(() => {
    const out: [string, Revision[]][] = []
    for (const r of revisions ?? []) {
      const d = day(r.updated)
      if (out.at(-1)?.[0] === d) out.at(-1)![1].push(r)
      else out.push([d, [r]])
    }
    return out
  }, [revisions])

  const chosen = revisions?.find((r) => r.id === selected)

  const restore = async () => {
    if (!chosen) return
    const ok = await confirm({
      title: isRows(chosen) ? "Restore these rows?" : "Restore these columns and views?",
      description: `${isRows(chosen) ? "The rows" : "The columns, views and forms"} go back to how they were at ${time(chosen.updated)} on ${day(chosen.updated)}. What's there now stays in this history.`,
      confirm: "Restore",
    })
    if (!ok) return
    setBusy(true)
    const res = await table.restore(chosen.id)
    setBusy(false)
    if (res) {
      toast.success("Version restored")
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(44rem,88vh)] flex-col gap-0 p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Data history</DialogTitle>
          <DialogDescription>Versions of the rows and columns of “{titleOf(path)}”. Changes within a few minutes of each other are grouped.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="grid flex-1 place-items-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : !revisions?.length ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <History />
              </EmptyMedia>
              <EmptyTitle>No history yet</EmptyTitle>
              <EmptyDescription>Versions appear here once you change this database.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex min-h-0 flex-1 max-sm:flex-col">
            <div className="shrink-0 overflow-y-auto border-r bg-surface p-2 max-sm:max-h-40 max-sm:border-r-0 max-sm:border-b sm:w-64">
              {groups.map(([d, list]) => (
                <div key={d} className="mb-2">
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{d}</div>
                  {list.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelected(r.id)}
                      className={cn("flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent", r.id === selected && "bg-accent")}
                    >
                      {isRows(r) ? <Rows3 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /> : <Columns3 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
                      <span className="grid min-w-0">
                        <span className="font-medium">
                          {time(r.updated)}
                          {current.has(r.id) && <span className="ml-2 text-xs font-normal text-brand">Current</span>}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {isRows(r) ? "Rows" : "Columns and views"} · {sourceLabel[r.source] ?? r.source} · {formatBytes(r.size)}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
                {rev && rev.id === selected ? (
                  isRows(rev) ? (
                    <RowsPreview csv={rev.content ?? ""} />
                  ) : (
                    <SchemaPreview json={rev.content ?? ""} />
                  )
                ) : (
                  isFetching && <Loader2 className="mx-auto mt-10 size-5 animate-spin text-muted-foreground" />
                )}
              </div>
              <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
                <Button onClick={() => void restore()} disabled={busy || !chosen || current.has(chosen.id)}>
                  {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />} Restore this version
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Reads CSV records, quotes and all, stopping after limit rows. */
function parseCSV(text: string, limit: number) {
  const out: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  let i = 0
  let more = false
  for (; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      out.push(row)
      row = []
      field = ""
      if (out.length > limit) {
        more = i < text.length - 1
        break
      }
    } else field += ch
  }
  if (i >= text.length && (field || row.length)) {
    row.push(field)
    out.push(row)
  }
  return { records: out, more }
}

function RowsPreview({ csv }: { csv: string }) {
  const { records, more } = useMemo(() => parseCSV(csv, 20), [csv])
  const total = useMemo(() => Math.max(0, csv.split("\n").filter((l) => l.trim()).length - 1), [csv])
  if (records.length < 1) return <p className="text-sm text-muted-foreground">No rows in this version.</p>
  // The id and creation time columns are bookkeeping; leave them out.
  const [header, ...rows] = records
  const keep = header.map((h, i) => (h === "_id" || h === "_created" ? -1 : i)).filter((i) => i >= 0)
  return (
    <div className="grid gap-2">
      <p className="text-xs text-muted-foreground">
        {more ? `The first ${rows.length} of about ${total} rows` : `${rows.length} ${rows.length === 1 ? "row" : "rows"}`}
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-[0.8125rem]">
          <thead className="bg-surface text-left text-xs text-muted-foreground">
            <tr>
              {keep.map((i) => (
                <th key={i} className="border-b px-2.5 py-1.5 font-medium whitespace-nowrap">
                  {header[i]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 20).map((r, j) => (
              <tr key={j} className="border-b last:border-b-0">
                {keep.map((i) => (
                  <td key={i} className="max-w-56 truncate px-2.5 py-1.5" title={r[i]}>
                    {r[i]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SchemaPreview({ json }: { json: string }) {
  const schema = useMemo(() => {
    try {
      return JSON.parse(json) as Partial<Schema>
    } catch {
      return null
    }
  }, [json])
  if (!schema) return <p className="text-sm text-muted-foreground">This version can't be read.</p>
  const columns = schema.columns ?? []
  return (
    <div className="grid gap-5 text-sm">
      <section>
        <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Columns</h3>
        <ul className="grid gap-px rounded-lg border p-1">
          {columns.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-md px-2 py-1">
              <TypeIcon type={c.type as ColumnType} />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="text-xs text-muted-foreground">{typeLabel(c.type as ColumnType)}</span>
              {c.formula && <code className="max-w-48 truncate rounded bg-muted px-1 font-mono text-xs">{c.formula}</code>}
            </li>
          ))}
        </ul>
      </section>
      {!!schema.views?.length && (
        <section>
          <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Views</h3>
          <p>{schema.views.map((v) => v.name).join(", ")}</p>
        </section>
      )}
      {!!schema.forms?.length && (
        <section>
          <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Forms</h3>
          <p>{schema.forms.map((f) => f.name).join(", ")}</p>
        </section>
      )}
    </div>
  )
}
