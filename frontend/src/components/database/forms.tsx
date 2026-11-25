import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"
import { ArrowDown, ArrowUp, ClipboardList, Copy, ExternalLink, Globe, Link2Off, Loader2, Plus, Trash2, X } from "lucide-react"
import { Link } from "react-router"
import { toast } from "sonner"

import { TypeIcon } from "@/components/database/cells"
import { useDialogs } from "@/components/dialogs"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type { TableActions } from "@/hooks/use-table"
import { errorMessage } from "@/hooks/use-vault"
import { api, publicFormUrl, type Column, type Form, type FormField, type TableData } from "@/lib/api"
import { formUrl, titleOf } from "@/lib/notes"
import { isStored, newId } from "@/lib/table"

/** Columns a form can ask about: typed-in ones, but not links to other rows. */
const askable = (c: Column) => isStored(c.type) && c.type !== "relation"

/** Lists a database's forms, builds and edits them, and manages their public links. */
export function FormsDialog({ data, table, open, onOpenChange }: { data: TableData; table: TableActions; open: boolean; onOpenChange: (open: boolean) => void }) {
  const forms = useMemo(() => data.schema.forms ?? [], [data.schema.forms])
  const [selected, setSelected] = useState(forms[0]?.id ?? "")
  const form = forms.find((f) => f.id === selected) ?? forms[0]
  const { confirm } = useDialogs()

  const save = (next: Form[]) => table.saveSchema({ ...data.schema, forms: next })

  const create = async () => {
    const [primary] = data.schema.columns
    const taken = new Set(forms.map((f) => f.name))
    let name = "Form"
    for (let i = 2; taken.has(name); i++) name = `Form ${i}`
    const f: Form = {
      id: newId("f"),
      name,
      title: titleOf(data.path),
      fields: data.schema.columns.filter(askable).map((c) => ({ column: c.id, required: c.id === primary.id || undefined })),
    }
    setSelected(f.id)
    await save([...forms, f])
  }

  const remove = async (f: Form) => {
    const ok = await confirm({
      title: `Delete the “${f.name}” form?`,
      description: "Rows it already added stay. Its public link stops working.",
      confirm: "Delete",
      destructive: true,
    })
    if (!ok) return
    setSelected(forms.find((x) => x.id !== f.id)?.id ?? "")
    await save(forms.filter((x) => x.id !== f.id))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(46rem,90vh)] flex-col gap-0 p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Forms</DialogTitle>
          <DialogDescription>Each answer to a form becomes a row in “{titleOf(data.path)}”.</DialogDescription>
        </DialogHeader>
        {!form ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ClipboardList />
              </EmptyMedia>
              <EmptyTitle>No forms yet</EmptyTitle>
              <EmptyDescription>A form asks for some of this database's columns and adds a row for every answer. Fill it in here, or share a link.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => void create()}>
                <Plus /> New form
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="flex min-h-0 flex-1 max-sm:flex-col">
            <div className="flex shrink-0 flex-col gap-px overflow-y-auto border-r bg-surface p-2 max-sm:max-h-36 max-sm:border-r-0 max-sm:border-b sm:w-56">
              {forms.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setSelected(f.id)}
                  className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent", f.id === form.id && "bg-accent font-medium")}
                >
                  <ClipboardList className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  {f.closed && <span className="text-xs font-normal text-muted-foreground">Closed</span>}
                </button>
              ))}
              <Button variant="ghost" size="sm" className="mt-1 justify-start text-muted-foreground" onClick={() => void create()}>
                <Plus /> New form
              </Button>
            </div>
            <FormBuilder
              key={form.id}
              data={data}
              form={form}
              onSave={(f) => save(forms.map((x) => (x.id === f.id ? f : x)))}
              onDelete={() => void remove(form)}
              onClose={() => onOpenChange(false)}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function FormBuilder({
  data,
  form,
  onSave,
  onDelete,
  onClose,
}: {
  data: TableData
  form: Form
  onSave: (f: Form) => Promise<unknown>
  onDelete: () => void
  onClose: () => void
}) {
  // Edits stay here until saved, so typing a title doesn't save on every key.
  const [draft, setDraft] = useState(form)
  const [busy, setBusy] = useState(false)
  // A save (or an edit elsewhere) replaces the form; follow it.
  const saved = JSON.stringify(form)
  useEffect(() => setDraft(JSON.parse(saved) as Form), [saved])
  const dirty = JSON.stringify(draft) !== saved
  const set = (patch: Partial<Form>) => setDraft((d) => ({ ...d, ...patch }))
  const columns = data.schema.columns
  const colOf = (id: string) => columns.find((c) => c.id === id)
  const unused = columns.filter((c) => askable(c) && !draft.fields.some((f) => f.column === c.id))
  const defaults = draft.defaults ?? {}
  const defaultable = columns.filter((c) => askable(c) && c.type !== "file" && !draft.fields.some((f) => f.column === c.id) && !(c.id in defaults))

  const setField = (i: number, patch: Partial<FormField>) => set({ fields: draft.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) })
  const moveField = (i: number, by: number) => {
    const next = [...draft.fields]
    const [f] = next.splice(i, 1)
    next.splice(i + by, 0, f)
    set({ fields: next })
  }
  const setDefault = (id: string, value: string | null) => {
    const next = { ...defaults }
    if (value === null) delete next[id]
    else next[id] = value
    set({ defaults: Object.keys(next).length ? next : undefined })
  }

  const submit = async () => {
    if (!draft.name.trim()) return toast.error("Give the form a name")
    setBusy(true)
    const res = await onSave({ ...draft, name: draft.name.trim() })
    setBusy(false)
    if (res) toast.success("Form saved")
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">
        <div className="grid gap-6">
          <section className="grid gap-3 sm:grid-cols-2">
            <Labeled label="Name" hint="Only you see this.">
              <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} />
            </Labeled>
            <Labeled label="Title" hint="The heading people see.">
              <Input value={draft.title ?? ""} placeholder={draft.name} onChange={(e) => set({ title: e.target.value || undefined })} />
            </Labeled>
            <Labeled label="Description" className="sm:col-span-2">
              <Textarea rows={2} value={draft.description ?? ""} placeholder="What this form is for (optional)" onChange={(e) => set({ description: e.target.value || undefined })} />
            </Labeled>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium">Questions</h3>
            <div className="grid gap-2">
              {draft.fields.map((f, i) => {
                const col = colOf(f.column)
                if (!col) return null
                return (
                  <div key={f.column} className="rounded-lg border p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <TypeIcon type={col.type} />
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {col.name}
                        {col.type === "file" && " · skipped on public links"}
                      </span>
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Switch size="sm" checked={!!f.required} onCheckedChange={(v) => setField(i, { required: v || undefined })} />
                        Required
                      </label>
                      <Button variant="ghost" size="icon-xs" aria-label="Move up" disabled={i === 0} onClick={() => moveField(i, -1)}>
                        <ArrowUp />
                      </Button>
                      <Button variant="ghost" size="icon-xs" aria-label="Move down" disabled={i === draft.fields.length - 1} onClick={() => moveField(i, 1)}>
                        <ArrowDown />
                      </Button>
                      <Button variant="ghost" size="icon-xs" aria-label={`Remove ${col.name}`} onClick={() => set({ fields: draft.fields.filter((_, j) => j !== i) })}>
                        <X />
                      </Button>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input aria-label="Question" value={f.label ?? ""} placeholder={col.name} onChange={(e) => setField(i, { label: e.target.value || undefined })} className="h-8" />
                      <Input aria-label="Help text" value={f.help ?? ""} placeholder="Help text (optional)" onChange={(e) => setField(i, { help: e.target.value || undefined })} className="h-8" />
                    </div>
                  </div>
                )
              })}
              {draft.fields.length === 0 && <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">Add a question to start.</p>}
            </div>
            {unused.length > 0 && (
              <Select value="" onValueChange={(id) => set({ fields: [...draft.fields, { column: id }] })}>
                <SelectTrigger size="sm" className="mt-2 h-8 text-[0.8125rem] text-muted-foreground">
                  <Plus className="size-3.5" /> <SelectValue placeholder="Add a question" />
                </SelectTrigger>
                <SelectContent>
                  {unused.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <TypeIcon type={c.type} /> {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </section>

          <section>
            <h3 className="text-sm font-medium">Fixed values</h3>
            <p className="mb-2 text-xs text-muted-foreground">Filled in on every row the form adds, without asking. Handy for a Source or Status column.</p>
            <div className="grid gap-2">
              {Object.entries(defaults).map(([id, value]) => {
                const col = colOf(id)
                if (!col) return null
                return (
                  <div key={id} className="flex items-center gap-2">
                    <span className="flex w-40 shrink-0 items-center gap-1.5 truncate text-sm">
                      <TypeIcon type={col.type} /> {col.name}
                    </span>
                    {col.type === "select" ? (
                      <Select value={value || undefined} onValueChange={(v) => setDefault(id, v)}>
                        <SelectTrigger size="sm" className="h-8 min-w-0 flex-1">
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
                    ) : (
                      <Input value={value} onChange={(e) => setDefault(id, e.target.value)} className="h-8 min-w-0 flex-1" placeholder={col.type === "checkbox" ? "yes or no" : "Value"} />
                    )}
                    <Button variant="ghost" size="icon-xs" aria-label={`Remove ${col.name}`} onClick={() => setDefault(id, null)}>
                      <X />
                    </Button>
                  </div>
                )
              })}
            </div>
            {defaultable.length > 0 && (
              <Select value="" onValueChange={(id) => setDefault(id, "")}>
                <SelectTrigger size="sm" className="mt-2 h-8 text-[0.8125rem] text-muted-foreground">
                  <Plus className="size-3.5" /> <SelectValue placeholder="Add a fixed value" />
                </SelectTrigger>
                <SelectContent>
                  {defaultable.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <TypeIcon type={c.type} /> {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <Labeled label="Button text">
              <Input value={draft.submit ?? ""} placeholder="Submit" onChange={(e) => set({ submit: e.target.value || undefined })} />
            </Labeled>
            <Labeled label="Thank-you message">
              <Input value={draft.thanks ?? ""} placeholder="Thanks, your answers were sent." onChange={(e) => set({ thanks: e.target.value || undefined })} />
            </Labeled>
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
              <div>
                <div className="text-sm font-medium">Taking answers</div>
                <div className="text-xs text-muted-foreground">Turn off to close the form.</div>
              </div>
              <Switch checked={!draft.closed} onCheckedChange={(v) => set({ closed: v ? undefined : true })} />
            </div>
            <Labeled label="Close after" hint="Answers through the public link. 0 means no limit.">
              <Input
                type="number"
                min={0}
                inputMode="numeric"
                value={draft.limit ?? 0}
                onChange={(e) => {
                  const n = Math.max(0, Math.floor(Number(e.target.value) || 0))
                  set({ limit: n || undefined })
                }}
              />
            </Labeled>
          </section>

          <PublicLink path={data.path} form={form} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
        <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={onDelete}>
          <Trash2 /> Delete
        </Button>
        <Button variant="ghost" asChild>
          <Link to={formUrl(data.path, form.id)} onClick={onClose}>
            <ExternalLink /> Open form
          </Link>
        </Button>
        <span className="ml-auto" />
        {dirty && (
          <Button variant="ghost" onClick={() => setDraft(form)}>
            Discard
          </Button>
        )}
        <Button onClick={() => void submit()} disabled={!dirty || busy}>
          {busy && <Loader2 className="animate-spin" />} Save
        </Button>
      </div>
    </div>
  )
}

function Labeled({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("grid content-start gap-1.5", className)}>
      <Label className="text-[0.8125rem]">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** The form's link for people outside Quire: make it, copy it, remove it. */
function PublicLink({ path, form }: { path: string; form: Form }) {
  const qc = useQueryClient()
  const { confirm } = useDialogs()
  const { data: links, isLoading } = useQuery({ queryKey: ["form-links", path], queryFn: () => api.formLinks(path) })
  const link = links?.find((l) => l.form === form.id)
  const [busy, setBusy] = useState(false)

  const make = async () => {
    setBusy(true)
    try {
      await api.createFormLink(path, form.id)
      await qc.invalidateQueries({ queryKey: ["form-links", path] })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!link) return
    const ok = await confirm({ title: "Turn off the public link?", description: "The link stops working. A new link would have a different address.", confirm: "Turn off", destructive: true })
    if (!ok) return
    try {
      await api.deleteFormLink(link.token)
      await qc.invalidateQueries({ queryKey: ["form-links", path] })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <section className="rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <Globe className="size-4 text-muted-foreground" />
        <h3 className="flex-1 text-sm font-medium">Public link</h3>
        {link && (
          <span className="text-xs text-muted-foreground">
            {link.responses} {link.responses === 1 ? "answer" : "answers"}
            {form.limit ? ` of ${form.limit}` : ""}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Anyone with this link can add rows. The link works where Quire is reachable; to accept answers from the internet you need to expose Quire's public form address (QUIRE_PUBLIC_LISTEN) yourself.
      </p>
      {isLoading ? (
        <Loader2 className="mt-3 size-4 animate-spin text-muted-foreground" />
      ) : link ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input readOnly value={publicFormUrl(link.token)} onFocus={(e) => e.currentTarget.select()} className="h-8 min-w-0 flex-1 font-mono text-xs" aria-label="Public link" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(publicFormUrl(link.token))
              toast.success("Link copied")
            }}
          >
            <Copy /> Copy
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void remove()}>
            <Link2Off /> Turn off
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" className="mt-3" disabled={busy} onClick={() => void make()}>
          {busy ? <Loader2 className="animate-spin" /> : <Globe />} Create a public link
        </Button>
      )}
    </section>
  )
}
