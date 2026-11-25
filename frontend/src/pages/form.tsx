import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"
import { CircleCheck, ClipboardList, Loader2 } from "lucide-react"
import { Link, useLocation, useSearchParams } from "react-router"
import { toast } from "sonner"

import { FilePicker } from "@/components/database/cells"
import { Page } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/hooks/use-vault"
import { api, ApiError, type Column, type Form } from "@/lib/api"
import { pageUrl, titleOf } from "@/lib/notes"
import { splitMulti } from "@/lib/table"

/** The database page a /form/… pathname points at. */
function pathFrom(pathname: string) {
  const rest = pathname.replace(/^\/form\//, "")
  if (!rest || rest === pathname) return ""
  try {
    const p = rest.split("/").map(decodeURIComponent).join("/")
    return /\.md$/i.test(p) ? p : `${p}.md`
  } catch {
    return ""
  }
}

/** Fills in a database's form inside Quire: /form/<page path>?id=<form id>. */
export default function FormPage() {
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const path = pathFrom(pathname)
  const id = params.get("id") ?? ""
  const { data, error, isLoading } = useQuery({ queryKey: ["table", path], queryFn: () => api.table(path), enabled: !!path })
  const form = data?.schema.forms?.find((f) => f.id === id)

  return (
    <Page
      header={
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <ClipboardList className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{form?.name ?? "Form"}</span>
          {path && (
            <Link to={pageUrl(path)} className="truncate text-muted-foreground hover:text-foreground">
              · {titleOf(path)}
            </Link>
          )}
        </span>
      }
    >
      <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 md:py-14">
        {isLoading ? (
          <div className="grid gap-4">
            <Skeleton className="h-9 w-2/3" />
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : error || !data ? (
          <Missing
            title={error instanceof ApiError && error.status === 404 ? "This database isn't there" : "The form can't be loaded"}
            text={error instanceof ApiError && error.status === 404 ? "It may have been renamed, moved or deleted." : errorMessage(error)}
          />
        ) : !form ? (
          <Missing title="This form isn't there" text="It may have been deleted." path={path} />
        ) : (
          <Filler key={form.id} path={path} form={form} columns={data.schema.columns} />
        )}
      </div>
    </Page>
  )
}

function Missing({ title, text, path }: { title: string; text: string; path?: string }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ClipboardList />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline" size="sm">
          <Link to={path ? pageUrl(path) : "/"}>{path ? "Open the database" : "Home"}</Link>
        </Button>
      </EmptyContent>
    </Empty>
  )
}

function Filler({ path, form, columns }: { path: string; form: Form; columns: Column[] }) {
  const qc = useQueryClient()
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const fields = useMemo(
    () => form.fields.flatMap((f) => {
      const col = columns.find((c) => c.id === f.column)
      return col ? [{ ...f, col }] : []
    }),
    [form, columns],
  )
  const set = (id: string, v: string) => {
    setAnswers((a) => ({ ...a, [id]: v }))
    if (problems[id])
      setProblems((p) => {
        const next = { ...p }
        delete next[id]
        return next
      })
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    // Check what the browser can before asking the server.
    const missing: Record<string, string> = {}
    for (const f of fields) if (f.required && !(answers[f.column] ?? "").trim()) missing[f.column] = "This is required"
    setProblems(missing)
    if (Object.keys(missing).length) return
    setBusy(true)
    try {
      await api.submitForm(path, form.id, answers)
      void qc.invalidateQueries({ queryKey: ["table", path] })
      setDone(true)
      window.scrollTo({ top: 0 })
    } catch (err) {
      const found = err instanceof ApiError ? (err.body.problems as Record<string, string> | undefined) : undefined
      if (found && Object.keys(found).length) {
        setProblems(Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.charAt(0).toUpperCase() + v.slice(1)])))
      } else {
        toast.error(errorMessage(err))
      }
    } finally {
      setBusy(false)
    }
  }

  const title = form.title || form.name

  if (done) {
    return (
      <div className="rounded-xl border px-6 py-12 text-center">
        <CircleCheck className="mx-auto mb-3 size-8 text-muted-foreground" />
        <h1 className="text-xl font-bold tracking-[-0.02em]">{title}</h1>
        <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">{form.thanks || "Thanks, your answers were sent."}</p>
        <div className="mt-6 flex justify-center gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setAnswers({})
              setDone(false)
            }}
          >
            Submit another
          </Button>
          <Button asChild>
            <Link to={pageUrl(path)}>Open database</Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="rounded-xl border px-5 py-7 sm:px-8 sm:py-9">
      <h1 className="text-2xl font-bold tracking-[-0.02em]">{title}</h1>
      {form.description && <p className="mt-1.5 whitespace-pre-line text-sm text-muted-foreground">{form.description}</p>}
      {form.closed && <p className="mt-4 rounded-md border px-3 py-2 text-sm text-muted-foreground">This form is closed to its public link. You can still add answers here.</p>}
      <div className="mt-7 grid gap-6">
        {fields.map(({ col, label, help, required }) => {
          const err = problems[col.id]
          const id = `field-${col.id}`
          return (
            <div key={col.id} className="grid gap-1.5">
              <label htmlFor={id} className="text-sm font-medium">
                {label || col.name}
                {required && (
                  <span className="ml-0.5 text-destructive" aria-hidden>
                    *
                  </span>
                )}
              </label>
              {help && <p className="-mt-0.5 text-[0.8125rem] text-muted-foreground">{help}</p>}
              <Answer id={id} col={col} primary={col.id === columns[0]?.id} value={answers[col.id] ?? ""} invalid={!!err} onChange={(v) => set(col.id, v)} />
              {err && <p className="text-[0.8125rem] text-destructive">{err}</p>}
            </div>
          )
        })}
      </div>
      <Button type="submit" className="mt-8" disabled={busy}>
        {busy && <Loader2 className="animate-spin" />} {form.submit || "Submit"}
      </Button>
    </form>
  )
}

/** The input for one question, by column type. Values are sent as typed. */
function Answer({ id, col, primary, value, invalid, onChange }: { id: string; col: Column; primary: boolean; value: string; invalid: boolean; onChange: (v: string) => void }) {
  const options = col.options ?? []
  const box = "size-4 shrink-0 accent-primary"
  switch (col.type) {
    case "checkbox":
      return (
        <label className="flex items-center gap-2 text-sm">
          <input id={id} type="checkbox" className={box} checked={value === "true"} onChange={(e) => onChange(e.target.checked ? "true" : "")} />
          Yes
        </label>
      )
    case "select":
      if (options.length <= 6) {
        return (
          <RadioGroup id={id} value={value} onValueChange={onChange} aria-invalid={invalid} className="gap-1">
            {options.map((o) => (
              <label key={o.name} className="flex items-center gap-2 py-1 text-sm">
                <RadioGroupItem value={o.name} /> {o.name}
              </label>
            ))}
          </RadioGroup>
        )
      }
      return (
        <Select value={value || undefined} onValueChange={onChange}>
          <SelectTrigger id={id} aria-invalid={invalid} className="w-full">
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.name} value={o.name}>
                {o.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    case "multi": {
      const chosen = splitMulti(value)
      return (
        <div id={id} role="group" className="grid gap-1">
          {options.map((o) => (
            <label key={o.name} className="flex items-center gap-2 py-1 text-sm">
              <input
                type="checkbox"
                className={box}
                checked={chosen.includes(o.name)}
                onChange={(e) => onChange((e.target.checked ? [...chosen, o.name] : chosen.filter((c) => c !== o.name)).join(", "))}
              />
              {o.name}
            </label>
          ))}
          {options.length === 0 && <p className="text-sm text-muted-foreground">This column has no options yet.</p>}
        </div>
      )
    }
    case "file":
      return (
        <div className={cn("w-fit rounded-md border", invalid && "border-destructive")}>
          <FilePicker value={value} onChange={onChange} />
        </div>
      )
    case "date": {
      const time = col.format === "datetime"
      return <Input id={id} type={time ? "datetime-local" : "date"} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} className="w-fit" />
    }
    case "text":
      if (!primary) return <Textarea id={id} rows={4} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} />
  }
  const input: Partial<Record<Column["type"], { type: string; inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"]; autoComplete?: string }>> = {
    number: { type: "text", inputMode: "decimal" },
    email: { type: "email", inputMode: "email", autoComplete: "email" },
    url: { type: "url", inputMode: "url" },
    phone: { type: "tel", inputMode: "tel", autoComplete: "tel" },
  }
  const attrs = input[col.type] ?? { type: "text" }
  return <Input id={id} {...attrs} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} className={cn(col.type === "number" && "tabular-nums")} />
}
