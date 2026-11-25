import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarDays, Loader2, Plus } from "lucide-react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { Agenda, type CalEvent, gridRange, MonthGrid, MonthNav, monthStart } from "@/components/database/calendar-view"
import { Page } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { errorMessage, useCurrentSpace } from "@/hooks/use-vault"
import { api, type CalendarEvent } from "@/lib/api"
import { pageUrl } from "@/lib/notes"

// One month of every database's calendar views (maintenance windows,
// reminders, due dates) and of every line on a page with a date chip
// (@2026-11-20). Clicking an event opens its row on its database page, or the
// page the line is on.
export default function CalendarPage() {
  const [month, setMonth] = useState(() => monthStart(new Date()))
  const { from, to } = gridRange(month)
  const { data, isLoading, error } = useQuery({ queryKey: ["calendar", from, to], queryFn: () => api.calendar(from, to), placeholderData: (prev) => prev })
  const navigate = useNavigate()
  const qc = useQueryClient()
  const space = useCurrentSpace()
  const [creating, setCreating] = useState(false)

  const { events, sources } = useMemo(() => {
    const events: CalEvent[] = []
    const sources = new Map<string, CalendarEvent>()
    for (const e of data ?? []) {
      // A line can name several days, so its id carries the day too.
      const id = e.kind ? `${e.path}:${e.line}@${e.start}` : `${e.path}#${e.row}`
      sources.set(id, e)
      // A date on a line of its own is titled after its page; don't say it twice.
      const sub = e.kind && e.title === e.table ? undefined : e.table
      events.push({ id, title: e.title, start: e.start, end: e.end, color: e.color, done: e.done, sub, task: e.kind === "task" })
    }
    return { events, sources }
  }, [data])
  const open = (ev: CalEvent) => {
    const e = sources.get(ev.id)
    if (!e) return
    // A dated line opens its page at the heading it sits under.
    if (e.kind) navigate(pageUrl(e.path, e.heading || undefined))
    else navigate(`${pageUrl(e.path)}?row=${encodeURIComponent(e.row)}`)
  }

  const create = async () => {
    if (!space) {
      toast.error("Create a space first")
      return
    }
    setCreating(true)
    try {
      const note = await api.createTable(space, "Calendar", "calendar")
      void qc.invalidateQueries({ queryKey: ["tree"] })
      void qc.invalidateQueries({ queryKey: ["tables"] })
      navigate(pageUrl(note.path))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Page
      header={
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <CalendarDays className="size-4 text-muted-foreground" /> Calendar
        </span>
      }
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 md:py-10">
        <h1 className="text-2xl font-bold tracking-[-0.02em]">Calendar</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Rows from every database with a Calendar view, and lines with a date on your pages, across all your spaces.
        </p>

        <MonthNav month={month} onChange={setMonth}>
          {isLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          <Button variant="outline" size="sm" onClick={() => void create()} disabled={creating}>
            <Plus /> New calendar
          </Button>
        </MonthNav>
        {error ? (
          <p className="text-sm text-destructive">{errorMessage(error)}</p>
        ) : (
          <>
            <MonthGrid month={month} events={events} onOpen={open} />
            <Agenda month={month} events={events} onOpen={open} />
            {data && data.length === 0 && (
              <div className="mt-4 rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">
                Nothing on these dates. Any database with a Calendar view shows its rows here, such as a schedule of server maintenance, renewals or reminders, and so
                does any line of a page with a date in it: type @ and pick a day.{" "}
                <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => void create()} disabled={creating}>
                  Make a new calendar
                </button>{" "}
                to start one{space ? ` in ${space}` : ""}.
              </div>
            )}
          </>
        )}
      </div>
    </Page>
  )
}
