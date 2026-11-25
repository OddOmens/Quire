import { useMemo, useState } from "react"
import { cn } from "cn"
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Square, SquareCheck } from "lucide-react"

import { usePointerDrag } from "@/components/database/card"
import { TypeIcon } from "@/components/database/cells"
import type { ViewProps } from "@/components/database/types"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DragGhost } from "@/hooks/use-list-drag"
import type { Column, Row, TableData } from "@/lib/api"
import { cellOf, colorOf, freshName, isoDay, newId, parseDay } from "@/lib/table"

/** Something on a day: a database row, or an event from the server. */
export type CalEvent = {
  id: string
  title: string
  /** YYYY-MM-DD, or YYYY-MM-DDTHH:MM with a time. */
  start: string
  end?: string
  color?: string
  done?: boolean
  /** A second line of context, like the database it comes from. */
  sub?: string
  /** Whether it can be dragged to another day. */
  movable?: boolean
  /** A to-do from a page, drawn with a checkbox that's ticked when done. */
  task?: boolean
}

const BAR = 1.375 // rem per event line in a week row
const MAX_LINES = 3

/** The first day of the week where the user lives: 0 is Sunday. */
function weekStart() {
  try {
    const loc = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } }
    const info = loc.getWeekInfo?.() ?? loc.weekInfo
    if (info) return info.firstDay % 7
  } catch {
    // Older browsers: Sunday, as in the US.
  }
  return 0
}

export const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1)
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

/** The days a month grid shows: whole weeks from before the 1st to after the last. */
export function gridDays(month: Date) {
  const first = monthStart(month)
  const start = addDays(first, -((first.getDay() - weekStart() + 7) % 7))
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0)
  const weeks = Math.ceil(((last.getTime() - start.getTime()) / 86_400_000 + 1) / 7)
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i))
}

/** The first and last day a month grid shows, as YYYY-MM-DD. */
export function gridRange(month: Date) {
  const days = gridDays(month)
  return { from: isoDay(days[0]), to: isoDay(days[days.length - 1]) }
}

const dayOf = (s: string) => s.slice(0, 10)
const endOf = (e: CalEvent) => dayOf(e.end || e.start)
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const timeOf = (s: string) => (s.includes("T") ? timeFmt.format(parseDay(s)).replace(/\s?([AP])M$/i, (_, m: string) => m.toLowerCase()) : "")
const daysBetween = (a: string, b: string) => Math.round((parseDay(dayOf(a)).getTime() - parseDay(dayOf(b)).getTime()) / 86_400_000)

/** The month title with previous, next and today. */
export function MonthNav({ month, onChange, children }: { month: Date; onChange: (m: Date) => void; children?: React.ReactNode }) {
  const title = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(month)
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <h3 className="mr-auto text-base font-semibold tracking-tight">{title}</h3>
      {children}
      <div className="flex items-center gap-0.5">
        <Button variant="outline" size="sm" onClick={() => onChange(monthStart(new Date()))}>
          Today
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => onChange(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
          <ChevronLeft />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => onChange(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
          <ChevronRight />
        </Button>
      </div>
    </div>
  )
}

type Segment = { ev: CalEvent; col: number; span: number; line: number; first: boolean; last: boolean }

/** Lays a week's events out in lines, longest first, so spans don't overlap. */
function layoutWeek(days: string[], events: CalEvent[]) {
  const from = days[0]
  const to = days[6]
  const segs: Segment[] = []
  const inWeek = events
    .filter((e) => dayOf(e.start) <= to && endOf(e) >= from)
    .sort((a, b) => dayOf(a.start).localeCompare(dayOf(b.start)) || daysBetween(endOf(b), b.start) - daysBetween(endOf(a), a.start) || a.start.localeCompare(b.start))
  const used: boolean[][] = []
  for (const ev of inWeek) {
    const s = dayOf(ev.start) < from ? 0 : days.indexOf(dayOf(ev.start))
    const e = endOf(ev) > to ? 6 : days.indexOf(endOf(ev))
    let line = 0
    while (used[line]?.slice(s, e + 1).some(Boolean)) line++
    used[line] ??= Array(7).fill(false)
    for (let i = s; i <= e; i++) used[line][i] = true
    segs.push({ ev, col: s, span: e - s + 1, line, first: dayOf(ev.start) >= from, last: endOf(ev) <= to })
  }
  return segs
}

/**
 * A month of weeks with events on their days. onAdd makes a day clickable,
 * onMove lets movable events be dragged to another day.
 */
export function MonthGrid({
  month,
  events,
  onOpen,
  onAdd,
  onMove,
}: {
  month: Date
  events: CalEvent[]
  onOpen: (ev: CalEvent) => void
  onAdd?: (day: string) => void
  onMove?: (ev: CalEvent, day: string) => void
}) {
  const days = useMemo(() => gridDays(month), [month])
  const today = isoDay(new Date())
  const weekdays = days.slice(0, 7).map((d) => new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(d))
  const { drag, ghostRef, start } = usePointerDrag<CalEvent>((ev, target) => {
    if (target.zone && target.zone !== dayOf(ev.start)) onMove?.(ev, target.zone)
  })
  const weeks = Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7).map(isoDay))

  return (
    <div className="overflow-hidden rounded-lg border max-sm:hidden">
      <div className="grid grid-cols-7 border-b bg-surface">
        {weekdays.map((w, i) => (
          <div key={i} className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            {w}
          </div>
        ))}
      </div>
      {weeks.map((week) => {
        const segs = layoutWeek(week, events)
        return (
          <div key={week[0]} className="relative grid grid-cols-7 border-b last:border-b-0" style={{ minHeight: `${1.75 + MAX_LINES * BAR + 1.375}rem` }}>
            {week.map((day, i) => {
              const date = parseDay(day)
              const inMonth = date.getMonth() === month.getMonth()
              const hidden = segs.filter((s) => s.line >= MAX_LINES && s.col <= i && s.col + s.span > i)
              const all = segs.filter((s) => s.col <= i && s.col + s.span > i).map((s) => s.ev)
              return (
                <div
                  key={day}
                  data-drop={day}
                  onClick={onAdd ? () => onAdd(day) : undefined}
                  className={cn(
                    "group relative border-r last:border-r-0",
                    !inMonth && "bg-surface/60",
                    onAdd && "cursor-pointer hover:bg-accent/30",
                    drag?.target?.zone === day && "bg-brand-soft",
                  )}
                >
                  <div className="flex h-7 items-center justify-between px-1.5">
                    <span
                      className={cn(
                        "grid h-5 min-w-5 place-items-center rounded-full px-1 text-xs tabular-nums",
                        !inMonth && "text-muted-foreground/60",
                        day === today && "bg-brand font-semibold text-brand-foreground",
                      )}
                    >
                      {date.getDate() === 1 ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date) : date.getDate()}
                    </span>
                    {onAdd && (
                      <span aria-hidden className="grid size-5 place-items-center rounded text-muted-foreground opacity-0 group-hover:opacity-100">
                        <Plus className="size-3.5" />
                      </span>
                    )}
                  </div>
                  {hidden.length > 0 && (
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => e.stopPropagation()}
                          className="absolute bottom-1 left-1.5 rounded px-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          +{hidden.length} more
                        </button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-64 gap-1 p-2" onClick={(e) => e.stopPropagation()}>
                        <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">
                          {new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(date)}
                        </p>
                        {all.map((ev) => (
                          <EventChip key={ev.id} ev={ev} onClick={() => onOpen(ev)} />
                        ))}
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
              )
            })}
            {/* Events sit over the days; only the bars themselves take clicks. */}
            <div className="pointer-events-none absolute inset-x-0 top-7">
              {segs
                .filter((s) => s.line < MAX_LINES)
                .map((s) => (
                  <button
                    key={`${s.ev.id}-${week[0]}`}
                    type="button"
                    title={s.ev.sub ? `${s.ev.title} · ${s.ev.sub}` : s.ev.title}
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpen(s.ev)
                    }}
                    onPointerDown={onMove && s.ev.movable ? (e) => start(e, s.ev) : undefined}
                    className={cn(
                      // While dragging, bars let the pointer through to the day below.
                      drag ? "pointer-events-none" : "pointer-events-auto",
                      "absolute flex h-5 items-center gap-1 overflow-hidden px-1.5 text-left text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      s.span > 1 || !s.ev.start.includes("T") ? cn("rounded", colorOf(s.ev.color).chip) : "rounded hover:bg-accent",
                      !s.first && "rounded-l-none",
                      !s.last && "rounded-r-none",
                      s.ev.done && "line-through opacity-60",
                      drag?.item.id === s.ev.id && "opacity-40",
                    )}
                    style={{ top: `${s.line * BAR}rem`, left: `calc(${(s.col / 7) * 100}% + 3px)`, width: `calc(${(s.span / 7) * 100}% - 6px)` }}
                  >
                    {s.span === 1 && s.ev.start.includes("T") && <span className={cn("size-1.5 shrink-0 rounded-full", colorOf(s.ev.color).dot)} />}
                    {s.first && timeOf(s.ev.start) && <span className="shrink-0 text-muted-foreground tabular-nums">{timeOf(s.ev.start)}</span>}
                    {s.ev.task && <TaskMark done={s.ev.done} />}
                    <span className="truncate">{s.ev.title}</span>
                    {s.ev.sub && <span className="truncate text-muted-foreground/80">· {s.ev.sub}</span>}
                  </button>
                ))}
            </div>
          </div>
        )
      })}
      {drag && (
        <DragGhost ghostRef={ghostRef}>
          <span className="truncate">{drag.item.title}</span>
        </DragGhost>
      )}
    </div>
  )
}

/** The checkbox in front of a to-do. */
function TaskMark({ done }: { done?: boolean }) {
  const Icon = done ? SquareCheck : Square
  return <Icon className="size-3 shrink-0 opacity-70" aria-label={done ? "Done" : "To do"} />
}

function EventChip({ ev, onClick }: { ev: CalEvent; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-accent", ev.done && "line-through opacity-60")}
    >
      {ev.task ? <TaskMark done={ev.done} /> : <span className={cn("size-2 shrink-0 rounded-full", colorOf(ev.color).dot)} />}
      {timeOf(ev.start) && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{timeOf(ev.start)}</span>}
      <span className="truncate">{ev.title}</span>
      {ev.sub && <span className="ml-auto max-w-[40%] shrink-0 truncate pl-2 text-xs text-muted-foreground">{ev.sub}</span>}
    </button>
  )
}

/** The month's events as a list by day, for narrow screens. */
export function Agenda({ month, events, onOpen }: { month: Date; events: CalEvent[]; onOpen: (ev: CalEvent) => void }) {
  const first = isoDay(monthStart(month))
  const last = isoDay(new Date(month.getFullYear(), month.getMonth() + 1, 0))
  const byDay = new Map<string, CalEvent[]>()
  for (const ev of [...events].sort((a, b) => a.start.localeCompare(b.start))) {
    if (endOf(ev) < first || dayOf(ev.start) > last) continue
    // Events that began last month show on the 1st.
    const day = dayOf(ev.start) < first ? first : dayOf(ev.start)
    byDay.set(day, [...(byDay.get(day) ?? []), ev])
  }
  const today = isoDay(new Date())
  return (
    <div className="sm:hidden">
      {byDay.size === 0 && <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">Nothing this month.</p>}
      {/* One column no wider than the screen: a long title is cut short, not the cause of sideways scrolling. */}
      <div className="grid grid-cols-1 gap-3">
        {[...byDay].map(([day, evs]) => (
          <section key={day}>
            <h4 className={cn("mb-1 px-1.5 text-xs font-medium text-muted-foreground", day === today && "text-brand")}>
              {new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(parseDay(day))}
              {day === today && " · Today"}
            </h4>
            <div className="grid grid-cols-1 gap-px">
              {evs.map((ev) => (
                <EventChip key={ev.id} ev={ev} onClick={() => onOpen(ev)} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

/** A database's rows on their dates, a month at a time. */
export function CalendarView({ data, table, view, rows, editable, openRow }: ViewProps) {
  const [month, setMonth] = useState(() => monthStart(new Date()))
  const columns = data.schema.columns
  const candidates = columns.filter((c) => c.type === "date" || c.type === "created" || c.type === "formula")
  const dateCol = candidates.find((c) => c.id === view.dateColumn)
  const endCol = candidates.find((c) => c.id === view.endColumn && c.id !== view.dateColumn)
  const label = columns.find((c) => c.type === "select")
  const check = columns.find((c) => c.type === "checkbox")

  const events = useMemo<CalEvent[]>(() => {
    if (!dateCol) return []
    const out: CalEvent[] = []
    for (const r of rows) {
      const start = dateValue(data, r, dateCol)
      if (!start) continue
      const end = endCol ? dateValue(data, r, endCol) : ""
      const name = label ? (r.cells[label.id] ?? "") : ""
      out.push({
        id: r.id,
        title: r.cells[columns[0].id] || "Untitled",
        start,
        end: end && dayOf(end) >= dayOf(start) ? end : undefined,
        color: label?.options?.find((o) => o.name === name)?.color,
        done: check ? r.cells[check.id] === "true" : false,
        movable: editable && dateCol.type === "date",
      })
    }
    return out
  }, [data, rows, dateCol, endCol, label, check, columns, editable])

  if (!dateCol) return <PickDate candidates={candidates} {...{ data, table, view, editable }} />

  const canAdd = editable && dateCol.type === "date"
  const add = async (day: string) => {
    const value = dateCol.format === "datetime" ? `${day}T09:00` : day
    const ids = await table.addRows([{ cells: { [dateCol.id]: value } }])
    if (ids[0]) openRow(data.path, ids[0])
  }
  const move = (ev: CalEvent, day: string) => {
    const r = data.rows.find((x) => x.id === ev.id)
    if (!r) return
    const time = ev.start.includes("T") ? ev.start.slice(10) : ""
    const cells: Record<string, string> = { [dateCol.id]: day + time }
    // The end moves by as many days, so the event keeps its length.
    const end = endCol?.type === "date" ? r.cells[endCol.id] : ""
    if (end && endCol) {
      const shifted = addDays(parseDay(dayOf(end)), daysBetween(day, ev.start))
      cells[endCol.id] = isoDay(shifted) + (end.includes("T") ? end.slice(10) : "")
    }
    void table.setCells([{ id: r.id, cells }])
  }

  return (
    <div className="pb-4">
      <MonthNav month={month} onChange={setMonth}>
        <DatePickers candidates={candidates} dateCol={dateCol} endCol={endCol} disabled={!editable} onChange={(patch) => void table.updateView(view.id, patch)} />
        {canAdd && (
          <Button variant="outline" size="sm" className="sm:hidden" onClick={() => void add(isoDay(new Date()))}>
            <Plus /> New
          </Button>
        )}
      </MonthNav>
      <MonthGrid month={month} events={events} onOpen={(ev) => openRow(data.path, ev.id)} onAdd={canAdd ? (d) => void add(d) : undefined} onMove={editable ? move : undefined} />
      <Agenda month={month} events={events} onOpen={(ev) => openRow(data.path, ev.id)} />
    </div>
  )
}

/** A row's date in a column, stored or worked out, as YYYY-MM-DD[THH:MM]. */
function dateValue(data: TableData, row: Row, col: Column) {
  let c = cellOf(data, row, col)
  if (c.kind === "list") c = c.items.find((i) => i.kind === "date") ?? { kind: "empty" }
  if (c.kind === "text" && /^\d{4}-\d{2}-\d{2}/.test(c.s)) return c.s.slice(0, 16)
  return c.kind === "date" ? c.d : ""
}

function DatePickers({
  candidates,
  dateCol,
  endCol,
  disabled,
  onChange,
}: {
  candidates: Column[]
  dateCol: Column
  endCol?: Column
  disabled?: boolean
  onChange: (patch: { dateColumn?: string; endColumn?: string }) => void
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Select value={dateCol.id} onValueChange={(id) => onChange({ dateColumn: id, endColumn: endCol?.id === id ? "" : endCol?.id })} disabled={disabled}>
        <SelectTrigger size="sm" className="h-7 w-auto text-xs" aria-label="Date column">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {candidates.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              <TypeIcon type={c.type} /> {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="max-md:hidden">to</span>
      <Select value={endCol?.id ?? "none"} onValueChange={(id) => onChange({ endColumn: id === "none" ? "" : id })} disabled={disabled}>
        <SelectTrigger size="sm" className="h-7 w-auto text-xs max-md:hidden" aria-label="End date column">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No end date</SelectItem>
          {candidates
            .filter((c) => c.id !== dateCol.id)
            .map((c) => (
              <SelectItem key={c.id} value={c.id}>
                <TypeIcon type={c.type} /> {c.name}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/** Shown until the calendar knows which column holds the dates. */
function PickDate({ candidates, data, table, view, editable }: Pick<ViewProps, "data" | "table" | "view" | "editable"> & { candidates: Column[] }) {
  const addDate = () => {
    const col: Column = { id: newId("c"), name: freshName(data.schema.columns, "Date"), type: "date" }
    void table.saveSchema({
      ...data.schema,
      columns: [...data.schema.columns, col],
      views: data.schema.views.map((v) => (v.id === view.id ? { ...v, dateColumn: col.id } : v)),
    })
  }
  return (
    <div className="grid place-items-center rounded-lg border border-dashed px-6 py-12 text-center">
      <CalendarDays className="mb-3 size-6 text-muted-foreground" />
      <p className="text-sm font-medium">A calendar places each row on a date</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {candidates.length ? "Choose the column that holds the dates." : "This database has no date column yet."}
      </p>
      {editable && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {candidates.length > 0 && (
            <Select value="" onValueChange={(id) => void table.updateView(view.id, { dateColumn: id })}>
              <SelectTrigger size="sm" className="h-8 w-auto min-w-36 text-xs">
                <SelectValue placeholder="Choose a column" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <TypeIcon type={c.type} /> {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button size="sm" variant={candidates.length ? "outline" : "default"} onClick={addDate}>
            <Plus /> Add a Date column
          </Button>
        </div>
      )}
    </div>
  )
}
