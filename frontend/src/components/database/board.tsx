import { useMemo } from "react"
import { cn } from "cn"
import { Kanban, Plus } from "lucide-react"

import { opener, RowCard, usePointerDrag } from "@/components/database/card"
import { TypeIcon } from "@/components/database/cells"
import type { ViewProps } from "@/components/database/types"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DragGhost } from "@/hooks/use-list-drag"
import type { Column, Row } from "@/lib/api"
import { colorOf, freshName, newId } from "@/lib/table"

type Lane = { key: string; label: string; color?: string; rows: Row[] }

/** Cards in lanes, one per option of a select column. */
export function BoardView({ data, table, view, rows, editable, openRow }: ViewProps) {
  const selects = data.schema.columns.filter((c) => c.type === "select")
  const group = selects.find((c) => c.id === view.groupBy)

  const lanes = useMemo<Lane[]>(() => {
    if (!group) return []
    const byName = new Map<string, Lane>()
    const out: Lane[] = (group.options ?? []).map((o) => {
      const lane = { key: o.name, label: o.name, color: o.color, rows: [] }
      byName.set(o.name.toLowerCase(), lane)
      return lane
    })
    const none: Lane = { key: "", label: `No ${group.name}`, rows: [] }
    for (const r of rows) {
      const v = r.cells[group.id] ?? ""
      if (!v) {
        none.rows.push(r)
        continue
      }
      let lane = byName.get(v.toLowerCase())
      if (!lane) {
        // A value that isn't an option (edited by hand) still gets a lane.
        lane = { key: v, label: v, rows: [] }
        byName.set(v.toLowerCase(), lane)
        out.push(lane)
      }
      lane.rows.push(r)
    }
    return [none, ...out]
  }, [group, rows])

  const sorted = (view.sorts ?? []).length > 0
  const { drag, ghostRef, start } = usePointerDrag<Row>((row, target) => {
    if (!group) return
    const from = row.cells[group.id] ?? ""
    if (target.zone.toLowerCase() !== from.toLowerCase()) void table.setCell(row.id, group.id, target.zone)
    // Order within a lane is the rows' own order, which sorting overrides.
    if (!sorted && target.before !== row.id) void table.moveRows([row.id], target.before)
  })

  if (!group) return <PickGroup selects={selects} {...{ data, table, view, editable }} />

  const add = async (lane: string) => {
    const ids = await table.addRows([{ cells: lane ? { [group.id]: lane } : {} }])
    if (ids[0]) openRow(data.path, ids[0])
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span>Group by</span>
        <GroupPicker selects={selects} value={group.id} disabled={!editable} onChange={(id) => void table.updateView(view.id, { groupBy: id })} />
      </div>
      <div data-hscroll className="-mx-1 flex items-start gap-3 overflow-x-auto px-1 pb-4">
        {lanes.map((lane) => {
          const over = drag?.target?.zone === lane.key
          return (
            <section
              key={lane.key || "\u0000none"}
              aria-label={lane.label}
              data-drop={lane.key}
              className={cn("flex w-72 shrink-0 flex-col rounded-lg bg-surface p-1.5 transition-colors", over && "bg-brand-soft")}
            >
              <header className="flex h-8 items-center gap-2 px-1.5">
                {lane.key ? (
                  <span className={cn("truncate rounded px-1.5 py-px text-[0.8125rem] font-medium", colorOf(lane.color).chip)}>{lane.label}</span>
                ) : (
                  <span className="truncate text-[0.8125rem] font-medium text-muted-foreground">{lane.label}</span>
                )}
                <span className="text-xs text-muted-foreground tabular-nums">{lane.rows.length}</span>
              </header>
              <div className="grid min-h-10 gap-1.5">
                {lane.rows.map((r) => {
                  const lifted = drag?.item.id === r.id
                  const lineHere = over && !sorted && drag?.target?.before === r.id && !lifted
                  return (
                    <div key={r.id} data-card={r.id} className="relative">
                      {lineHere && <span aria-hidden className="absolute inset-x-1 -top-1 h-0.5 rounded-full bg-brand" />}
                      <div
                        {...opener(() => openRow(data.path, r.id))}
                        onPointerDown={editable ? (e) => start(e, r) : undefined}
                        className={cn("block w-full cursor-pointer touch-manipulation rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring", lifted && "opacity-40")}
                      >
                        <RowCard data={data} view={view} row={r} skip={[group.id]} openRow={openRow} />
                      </div>
                    </div>
                  )
                })}
                {over && !sorted && drag?.target?.before === "" && <span aria-hidden className="mx-1 h-0.5 rounded-full bg-brand" />}
              </div>
              {editable && (
                <Button variant="ghost" size="sm" className="mt-1 justify-start text-muted-foreground" onClick={() => void add(lane.key)}>
                  <Plus /> New
                </Button>
              )}
            </section>
          )
        })}
      </div>
      {drag && (
        <DragGhost ghostRef={ghostRef}>
          <span className="truncate">{drag.item.cells[data.schema.columns[0].id] || "Untitled"}</span>
        </DragGhost>
      )}
    </div>
  )
}

function GroupPicker({ selects, value, onChange, disabled }: { selects: Column[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger size="sm" className="h-7 w-auto min-w-32 text-xs">
        <SelectValue placeholder="Choose a column" />
      </SelectTrigger>
      <SelectContent>
        {selects.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            <TypeIcon type={c.type} /> {c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Shown until the board knows which select column makes its lanes. */
function PickGroup({ selects, data, table, view, editable }: Pick<ViewProps, "data" | "table" | "view" | "editable"> & { selects: Column[] }) {
  const addStatus = () => {
    const col: Column = {
      id: newId("c"),
      name: freshName(data.schema.columns, "Status"),
      type: "select",
      options: [
        { name: "To do", color: "gray" },
        { name: "Doing", color: "blue" },
        { name: "Done", color: "green" },
      ],
    }
    void table.saveSchema({
      ...data.schema,
      columns: [...data.schema.columns, col],
      views: data.schema.views.map((v) => (v.id === view.id ? { ...v, groupBy: col.id } : v)),
    })
  }
  return (
    <div className="grid place-items-center rounded-lg border border-dashed px-6 py-12 text-center">
      <Kanban className="mb-3 size-6 text-muted-foreground" />
      <p className="text-sm font-medium">A board sorts cards into lanes by a select column</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {selects.length ? "Choose the column whose options become the lanes." : "This database has no select column yet. Add one, like a Status with To do, Doing and Done."}
      </p>
      {editable && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {selects.length > 0 && <GroupPicker selects={selects} value="" onChange={(id) => void table.updateView(view.id, { groupBy: id })} />}
          <Button size="sm" variant={selects.length ? "outline" : "default"} onClick={addStatus}>
            <Plus /> Add a Status column
          </Button>
        </div>
      )}
    </div>
  )
}
