import { useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ListTodo } from "lucide-react"
import { Link, useParams } from "react-router"
import { toast } from "sonner"
import { cn } from "cn"

import { Page } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/hooks/use-vault"
import { api, ApiError, type Task } from "@/lib/api"
import { dateLabel, isoDate } from "@/lib/dates"
import { baseOf, pageUrl } from "@/lib/notes"

/** The start of an open task line, up to and including its "[ ]". Matches the server's parser. */
const OPEN_TASK = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[ \](?=[ \t\r]|$)/

const taskKey = (t: Pick<Task, "path" | "line">) => `${t.path}:${t.line}`

type Group = { path: string; title: string; where: string; sections: { heading: string; tasks: Task[] }[] }

function groupTasks(tasks: Task[]) {
  const groups: Group[] = []
  for (const t of tasks) {
    let g = groups.at(-1)
    if (g?.path !== t.path) {
      g = { path: t.path, title: t.title, where: baseOf(t.path).split("/").slice(1, -1).join(" / "), sections: [] }
      groups.push(g)
    }
    const s = g.sections.at(-1)
    if (s && s.heading === t.heading) s.tasks.push(t)
    else g.sections.push({ heading: t.heading, tasks: [t] })
  }
  return groups
}

/** How the list is laid out: under each page, or by the day a task's date chip names. */
type View = "page" | "date"
const VIEW_KEY = "quire.tasks.view"

function storedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "date" ? "date" : "page"
  } catch {
    return "page"
  }
}

type DateGroup = { id: string; label: string; tasks: Task[] }

/** Tasks by due day: late ones first, then today's, what's coming, and the undated. */
function groupByDate(tasks: Task[], today: string): DateGroup[] {
  const overdue: Task[] = []
  const now: Task[] = []
  const upcoming: Task[] = []
  const undated: Task[] = []
  for (const t of tasks) (!t.due ? undated : t.due < today ? overdue : t.due === today ? now : upcoming).push(t)
  // The sort is stable, so tasks due the same day stay in page order.
  const byDay = (a: Task, b: Task) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : 0)
  return [
    { id: "overdue", label: "Overdue", tasks: overdue.sort(byDay) },
    { id: "today", label: "Today", tasks: now },
    { id: "upcoming", label: "Upcoming", tasks: upcoming.sort(byDay) },
    { id: "none", label: "No date", tasks: undated },
  ].filter((g) => g.tasks.length > 0)
}

// Every open to-do in a space, by page or by due date. A task is due on the
// day of its date chip (@2026-11-20). Ticking one rewrites that line of the
// page through the normal save, guarded by the page's revision.
export default function TasksPage() {
  const { space = "" } = useParams()
  const qc = useQueryClient()
  const queryKey = useMemo(() => ["tasks", space], [space])
  const { data: tasks, error, isLoading } = useQuery({ queryKey, queryFn: () => api.tasks(space), enabled: !!space })
  const [ticking, setTicking] = useState<Set<string>>(new Set())
  // Ticks run one at a time, so two on the same page don't race each other's revision.
  const queue = useRef(Promise.resolve())

  const [chosen, setChosen] = useState(storedView)
  const today = isoDate(new Date())

  const groups = useMemo(() => groupTasks(tasks ?? []), [tasks])
  const pages = groups.length
  const dated = useMemo(() => (tasks ?? []).some((t) => t.due), [tasks])
  const overdue = useMemo(() => (tasks ?? []).filter((t) => t.due && t.due < today).length, [tasks, today])
  // Without a dated task there's nothing to order by.
  const view: View = dated ? chosen : "page"
  const dateGroups = useMemo(() => (view === "date" ? groupByDate(tasks ?? [], today) : []), [view, tasks, today])

  const choose = (v: View) => {
    setChosen(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      // The choice just lasts for this visit.
    }
  }

  const mark = (key: string, on: boolean) =>
    setTicking((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })

  const changed = (title: string) => {
    void qc.invalidateQueries({ queryKey })
    toast.error(`“${title}” changed since this list loaded, so nothing was ticked. The list is up to date now.`)
  }

  const tick = async (task: Task) => {
    const key = taskKey(task)
    // Earlier ticks may have saved this page since; use its latest revision.
    const current = qc.getQueryData<Task[]>(queryKey)?.find((t) => taskKey(t) === key)
    if (!current) return mark(key, false)
    try {
      const note = await api.note(current.path)
      const lines = note.content.split("\n")
      const line = lines[current.line - 1]
      if (note.rev !== current.rev || line === undefined || !OPEN_TASK.test(line)) {
        mark(key, false)
        return changed(current.title)
      }
      lines[current.line - 1] = line.replace(OPEN_TASK, "$1[x]")
      const saved = await api.save(current.path, lines.join("\n"), current.rev)
      qc.setQueryData(["note", saved.path], saved)
      // Ticking changes no line numbers, so the page's other tasks stay valid at the new revision.
      qc.setQueryData<Task[]>(queryKey, (old) =>
        old?.filter((t) => taskKey(t) !== key).map((t) => (t.path === saved.path ? { ...t, rev: saved.rev } : t)),
      )
      mark(key, false)
      void qc.invalidateQueries({ queryKey: ["tree"] })
    } catch (e) {
      mark(key, false)
      if (e instanceof ApiError && e.status === 409) changed(current.title)
      else toast.error(errorMessage(e))
    }
  }

  const onTick = (task: Task) => {
    const key = taskKey(task)
    if (ticking.has(key)) return
    mark(key, true)
    queue.current = queue.current.then(() => tick(task))
  }

  const total = tasks?.length ?? 0

  return (
    <Page
      header={
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <ListTodo className="size-4 text-muted-foreground" /> Tasks
          <span className="text-muted-foreground">· {space}</span>
        </span>
      }
    >
      <div className="mx-auto w-full max-w-4xl px-6 py-10 sm:px-10 md:py-14">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h1 className="text-2xl font-bold tracking-[-0.02em]">Open tasks</h1>
          {dated && (
            <div role="group" aria-label="Order tasks" className="inline-flex rounded-lg border p-0.5">
              {(["page", "date"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => choose(v)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    view === v ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {v === "page" ? "By page" : "By date"}
                </button>
              ))}
            </div>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {tasks
            ? total
              ? `${total} ${total === 1 ? "task" : "tasks"} on ${pages} ${pages === 1 ? "page" : "pages"}${overdue ? `, ${overdue} overdue` : ""}. Tick one off to check it on its page.`
              : "Unchecked to-dos from every page in this space."
            : " "}
        </p>

        {error instanceof ApiError && error.status === 404 ? (
          <Empty className="mt-8 border">
            <EmptyHeader>
              <EmptyTitle>No space called “{space}”</EmptyTitle>
              <EmptyDescription>It may have been renamed or deleted.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button asChild variant="outline" size="sm">
                <Link to="/">All spaces</Link>
              </Button>
            </EmptyContent>
          </Empty>
        ) : error ? (
          <p className="mt-8 text-sm text-destructive">{errorMessage(error)}</p>
        ) : isLoading ? (
          <div className="mt-8 grid gap-4">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-28 rounded-lg" />
            ))}
          </div>
        ) : total === 0 ? (
          <Empty className="mt-8 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ListTodo />
              </EmptyMedia>
              <EmptyTitle>No open tasks in this space.</EmptyTitle>
              <EmptyDescription>To-dos you add to its pages show up here until they're ticked off.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : view === "date" ? (
          <div className="mt-8 grid gap-4">
            {dateGroups.map((g) => (
              <section key={g.id} className="rounded-lg border">
                <header className="flex items-baseline gap-2 border-b px-4 py-2.5">
                  <h2 className={cn("font-medium", g.id === "overdue" && "text-destructive")}>{g.label}</h2>
                  <span className="text-xs text-muted-foreground tabular-nums">{g.tasks.length}</span>
                </header>
                <ul className="grid px-2 py-2">
                  {g.tasks.map((t) => (
                    <TaskRow key={taskKey(t)} task={t} today={today} done={ticking.has(taskKey(t))} onTick={() => onTick(t)} flat />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <div className="mt-8 grid gap-4">
            {groups.map((g) => (
              <section key={g.path} className="rounded-lg border">
                <header className="flex items-baseline gap-2 border-b px-4 py-2.5">
                  <Link to={pageUrl(g.path)} className="truncate font-medium hover:underline">
                    {g.title}
                  </Link>
                  {g.where && <span className="truncate text-xs text-muted-foreground">In {g.where}</span>}
                </header>
                <div className="grid gap-2 px-2 py-2">
                  {g.sections.map((s, i) => (
                    <div key={i}>
                      {s.heading && (
                        <Link to={pageUrl(g.path, s.heading)} className="block truncate px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground hover:text-foreground">
                          {s.heading}
                        </Link>
                      )}
                      <ul className="grid">
                        {s.tasks.map((t) => (
                          <TaskRow key={taskKey(t)} task={t} today={today} done={ticking.has(taskKey(t))} onTick={() => onTick(t)} />
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </Page>
  )
}

/** A task in the list. Flat rows stand outside their page, so they name it. */
function TaskRow({ task, today, done, onTick, flat }: { task: Task; today: string; done: boolean; onTick: () => void; flat?: boolean }) {
  return (
    <li
      className="flex items-start gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
      style={{ paddingLeft: `${0.5 + (flat ? 0 : Math.min(task.depth, 6)) * 1.25}rem` }}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={`Tick off “${task.text}”`}
        disabled={done}
        onClick={onTick}
        className={cn(
          "mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border-[1.5px] border-input bg-background outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          done ? "border-brand bg-brand text-brand-foreground" : "hover:border-brand",
        )}
      >
        {done && <Check className="size-3" strokeWidth={3} />}
      </button>
      <span className="min-w-0 flex-1">
        <span className={cn("break-words", done && "text-muted-foreground line-through")}>{task.text}</span>
        {flat && (
          <Link to={pageUrl(task.path, task.heading)} className="ml-2 text-xs text-muted-foreground hover:text-foreground hover:underline">
            {task.title}
          </Link>
        )}
      </span>
      {task.due && <DueChip date={task.due} today={today} />}
    </li>
  )
}

/** The day a task is due, from its date chip: red once it has passed. */
function DueChip({ date, today }: { date: string; today: string }) {
  const late = date < today
  const full = new Date(`${date}T00:00`).toLocaleDateString(undefined, { dateStyle: "full" })
  return (
    <span
      title={late ? `Overdue · ${full}` : full}
      className={cn(
        "mt-px shrink-0 rounded px-1.5 py-px text-xs whitespace-nowrap",
        late ? "bg-destructive/10 font-medium text-destructive" : date === today ? "bg-brand-soft font-medium text-foreground" : "bg-muted text-muted-foreground",
      )}
    >
      {late && <span className="sr-only">Overdue: </span>}
      {dateLabel(date)}
    </span>
  )
}
