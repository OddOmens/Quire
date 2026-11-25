import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { cn } from "cn"
import {
  AlignLeft,
  ArrowUpRight,
  AtSign,
  Calendar,
  Check,
  CircleChevronDown,
  Clock,
  FileText,
  Hash,
  Link as LinkIcon,
  Loader2,
  Paperclip,
  Phone,
  Plus,
  Sigma,
  SquareCheck,
  SquareFunction,
  Tags,
  Upload,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { errorMessage, useResolver, useVaultActions } from "@/hooks/use-vault"
import { api, fileUrl, type Column, type ColumnType, type Row, type TableData } from "@/lib/api"
import { titleOf } from "@/lib/notes"
import {
  type Cell,
  cellOf,
  colorNames,
  display,
  fileList,
  optionColor,
  relationIds,
  resultKind,
  splitMulti,
} from "@/lib/table"

const icons: Record<ColumnType, React.ComponentType<{ className?: string }>> = {
  text: AlignLeft,
  number: Hash,
  select: CircleChevronDown,
  multi: Tags,
  date: Calendar,
  checkbox: SquareCheck,
  url: LinkIcon,
  email: AtSign,
  phone: Phone,
  page: FileText,
  relation: ArrowUpRight,
  file: Paperclip,
  formula: SquareFunction,
  rollup: Sigma,
  created: Clock,
}

export function TypeIcon({ type, className }: { type: ColumnType; className?: string }) {
  const Icon = icons[type] ?? AlignLeft
  return <Icon className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />
}

/** Whether a column's values sit on the right, like numbers in a sheet. */
export const alignRight = (col: Column) => resultKind(col) === "number"

export function Chip({ col, name, className }: { col: Column; name: string; className?: string }) {
  return <span className={cn("inline-flex max-w-full items-center truncate rounded px-1.5 py-px text-[0.8125rem] leading-5", optionColor(col, name).chip, className)}>{name}</span>
}

/** A checkbox drawn to match the app, for display; the grid toggles it. */
export function CheckMark({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-[4px] border transition-colors",
        checked ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background",
        className,
      )}
    >
      {checked && <Check className="size-3" strokeWidth={3} />}
    </span>
  )
}

/**
 * A cell's value as it shows in the grid, on cards and in the row panel.
 * Links work; editing is up to the caller.
 */
export function CellView({ data, row, col, wrap, onOpenRow }: { data: TableData; row: Row; col: Column; wrap?: boolean; onOpenRow?: (path: string, id: string) => void }) {
  const raw = row.cells[col.id] ?? ""
  const value = cellOf(data, row, col)
  const truncate = wrap ? "whitespace-pre-wrap break-words" : "truncate"
  switch (col.type) {
    case "select":
      return raw ? <Chip col={col} name={raw} /> : null
    case "multi":
      return (
        <span className={cn("flex min-w-0 gap-1", wrap ? "flex-wrap" : "overflow-hidden")}>
          {splitMulti(raw).map((v) => (
            <Chip key={v} col={col} name={v} className="shrink-0" />
          ))}
        </span>
      )
    case "checkbox":
      return <CheckMark checked={raw === "true"} />
    case "url":
      return raw ? (
        <a href={raw} target="_blank" rel="noopener noreferrer nofollow" onClick={(e) => e.stopPropagation()} className={cn("text-link underline-offset-2 hover:underline", truncate)}>
          {raw.replace(/^https?:\/\/(www\.)?/, "")}
        </a>
      ) : null
    case "email":
      return raw ? (
        <a href={`mailto:${raw}`} onClick={(e) => e.stopPropagation()} className={cn("text-link underline-offset-2 hover:underline", truncate)}>
          {raw}
        </a>
      ) : null
    case "phone":
      return raw ? (
        <a href={`tel:${raw.replace(/[^\d+]/g, "")}`} onClick={(e) => e.stopPropagation()} className={cn("underline-offset-2 hover:underline", truncate)}>
          {raw}
        </a>
      ) : null
    case "page":
      return raw ? <PageLink target={raw} from={data.path} /> : null
    case "relation": {
      const titles = data.related[col.id] ?? {}
      const target = data.targets[col.id]
      return (
        <span className={cn("flex min-w-0 gap-1", wrap ? "flex-wrap" : "overflow-hidden")}>
          {relationIds(raw).map((id) => (
            <button
              key={id}
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                if (target) onOpenRow?.(target, id)
              }}
              className="inline-flex max-w-full shrink-0 items-center gap-1 truncate rounded bg-muted px-1.5 py-px text-[0.8125rem] leading-5 hover:bg-accent"
            >
              <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{titles[id] ?? "Missing row"}</span>
            </button>
          ))}
        </span>
      )
    }
    case "file":
      return (
        <span className={cn("flex min-w-0 gap-1", wrap ? "flex-wrap" : "overflow-hidden")}>
          {fileList(raw).map((p) => (
            <a
              key={p}
              href={fileUrl(p)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex max-w-40 shrink-0 items-center gap-1 truncate rounded bg-muted px-1.5 py-px text-[0.8125rem] leading-5 hover:bg-accent"
            >
              <Paperclip className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{p.split("/").pop()}</span>
            </a>
          ))}
        </span>
      )
  }
  return <ValueText value={value} col={col} wrap={wrap} />
}

/** A plain or worked-out value: numbers formatted, errors marked. */
export function ValueText({ value, col, wrap }: { value: Cell; col: Column; wrap?: boolean }) {
  if (value.kind === "error") {
    return (
      <span title={value.message} className="truncate font-mono text-xs text-destructive">
        {value.code}
      </span>
    )
  }
  if (value.kind === "bool") return <CheckMark checked={value.b} />
  if (value.kind === "list" && value.items.some((i) => i.kind === "error")) {
    const e = value.items.find((i) => i.kind === "error") as Extract<Cell, { kind: "error" }>
    return (
      <span title={e.message} className="truncate font-mono text-xs text-destructive">
        {e.code}
      </span>
    )
  }
  const text = display(value, col)
  return (
    <span className={cn(wrap ? "whitespace-pre-wrap break-words" : "truncate", resultKind(col) === "number" && "tabular-nums", col.type !== "text" && !wrap && "whitespace-nowrap")}>
      {text}
    </span>
  )
}

function PageLink({ target, from }: { target: string; from: string }) {
  const resolver = useResolver()
  const actions = useVaultActions()
  const name = target.replace(/^\[\[|\]\]$/g, "")
  const found = resolver.resolve(name, from)
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        void actions.openLink(name, from)
      }}
      className={cn("inline-flex max-w-full items-center gap-1 truncate underline-offset-2 hover:underline", found ? "text-link" : "text-muted-foreground decoration-dashed")}
    >
      <FileText className="size-3.5 shrink-0" />
      <span className="truncate">{found ? titleOf(found) : name}</span>
    </button>
  )
}

// ── Editors ──

/** Editors that open as a list rather than a text box. */
export const listEditor = (t: ColumnType) => t === "select" || t === "multi" || t === "relation" || t === "file"

/**
 * A text box for typed values: text, numbers, dates, links. Enter saves,
 * Escape cancels, Tab saves and moves on (the grid handles the moving).
 */
export function TextEditor({
  col,
  initial,
  onCommit,
  onCancel,
  className,
  autoFocus = true,
}: {
  col: Column
  initial: string
  onCommit: (value: string, move?: "down" | "right" | "left" | "up") => void
  onCancel: () => void
  className?: string
  autoFocus?: boolean
}) {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !autoFocus) return
    el.focus()
    if (el.type !== "date" && el.type !== "datetime-local") {
      const n = el.value.length
      el.setSelectionRange?.(n, n)
    }
  }, [autoFocus])
  const commit = (move?: "down" | "right" | "left" | "up") => {
    if (done.current) return
    done.current = true
    onCommit(value, move)
  }
  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === "Escape") {
      e.preventDefault()
      done.current = true
      onCancel()
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      commit("down")
    } else if (e.key === "Tab") {
      e.preventDefault()
      commit(e.shiftKey ? "left" : "right")
    }
  }
  const base = cn("w-full bg-transparent text-sm outline-none", className)
  if (col.type === "date") {
    const time = col.format === "datetime" || initial.includes("T")
    return (
      <input
        ref={ref}
        type={time ? "datetime-local" : "date"}
        value={time ? value.slice(0, 16) : value.slice(0, 10)}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => commit()}
        className={base}
      />
    )
  }
  if (col.type === "text") {
    return (
      <textarea
        ref={ref}
        value={value}
        rows={Math.min(8, Math.max(1, value.split("\n").length))}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => commit()}
        className={cn(base, "resize-none leading-5")}
      />
    )
  }
  return (
    <input
      ref={ref}
      type="text"
      inputMode={col.type === "number" ? "decimal" : col.type === "email" ? "email" : col.type === "url" ? "url" : col.type === "phone" ? "tel" : "text"}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKey}
      onBlur={() => commit()}
      className={cn(base, col.type === "number" && "text-right tabular-nums")}
    />
  )
}

/**
 * Picks select or multi-select options, with search and "Create" for a new
 * one. onChange gets the new stored value.
 */
export function OptionPicker({ col, value, onChange, onDone }: { col: Column; value: string; onChange: (v: string) => void; onDone?: () => void }) {
  const multi = col.type === "multi"
  const [chosen, setChosen] = useState(() => (multi ? splitMulti(value) : value ? [value] : []))
  const [search, setSearch] = useState("")
  const options = col.options ?? []
  const q = search.trim().replace(/,/g, " ")
  const exact = options.some((o) => o.name.toLowerCase() === q.toLowerCase())
  const pick = (name: string) => {
    if (multi) {
      const next = chosen.some((c) => c.toLowerCase() === name.toLowerCase()) ? chosen.filter((c) => c.toLowerCase() !== name.toLowerCase()) : [...chosen, name]
      setChosen(next)
      onChange(next.join(", "))
      setSearch("")
    } else {
      const next = chosen[0]?.toLowerCase() === name.toLowerCase() ? "" : name
      onChange(next)
      onDone?.()
    }
  }
  return (
    <Command className="w-64" shouldFilter>
      <CommandInput
        placeholder={options.length ? "Search or create…" : "Type an option…"}
        value={search}
        onValueChange={setSearch}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone?.()
          if (e.key === "Backspace" && !search && multi && chosen.length) pick(chosen[chosen.length - 1])
        }}
      />
      {multi && chosen.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b px-2 py-1.5">
          {chosen.map((c) => (
            <button key={c} type="button" onClick={() => pick(c)} aria-label={`Remove ${c}`} className={cn("inline-flex max-w-full items-center gap-1 rounded py-px pr-1 pl-1.5 text-[0.8125rem] leading-5", optionColor(col, c).chip)}>
              <span className="truncate">{c}</span>
              <X className="size-3 shrink-0 opacity-60" />
            </button>
          ))}
        </div>
      )}
      <CommandList className="max-h-64">
        <CommandEmpty className="py-3 text-center text-xs text-muted-foreground">{q ? "" : "No options yet"}</CommandEmpty>
        <CommandGroup>
          {options.map((o) => (
            <CommandItem key={o.name} value={o.name} onSelect={() => pick(o.name)} className="gap-2">
              <Chip col={col} name={o.name} />
              {chosen.some((c) => c.toLowerCase() === o.name.toLowerCase()) && <Check className="ml-auto size-4" />}
            </CommandItem>
          ))}
          {q && !exact && (
            <CommandItem value={`\u0000create ${q}`} onSelect={() => pick(q)} className="gap-2">
              <Plus className="size-4" /> Create <span className={cn("rounded px-1.5 py-px text-[0.8125rem]", colorClassFor(options.length))}>{q}</span>
            </CommandItem>
          )}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

const colorClassFor = (i: number) => optionColorChip(colorNames[i % colorNames.length])
function optionColorChip(name: string) {
  return optionColor({ id: "", name: "", type: "select", options: [{ name: "x", color: name }] }, "x").chip
}

/** Picks rows of the database a relation links to. */
export function RelationPicker({ col, data, value, onChange, onDone }: { col: Column; data: TableData; value: string; onChange: (v: string) => void; onDone?: () => void }) {
  const target = data.targets[col.id] || col.target || ""
  const { data: other, isLoading } = useQuery({ queryKey: ["table", target], queryFn: () => api.table(target), enabled: !!target })
  const [chosen, setChosen] = useState(() => relationIds(value))
  const primary = other?.schema.columns[0]
  const rows = useMemo(() => other?.rows ?? [], [other])
  if (!target) return <p className="w-64 p-3 text-sm text-muted-foreground">Choose which database this column links to in its settings.</p>
  const toggle = (id: string) => {
    const next = chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id]
    setChosen(next)
    onChange(next.join(","))
  }
  return (
    <Command className="w-72">
      <CommandInput placeholder={`Search ${titleOf(target)}…`} onKeyDown={(e) => e.key === "Escape" && onDone?.()} />
      <CommandList className="max-h-72">
        {isLoading ? (
          <div className="grid place-items-center py-4">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <CommandEmpty className="py-3 text-center text-xs text-muted-foreground">No rows</CommandEmpty>
        )}
        <CommandGroup>
          {rows.map((r) => {
            const title = (primary && r.cells[primary.id]) || "Untitled"
            return (
              <CommandItem key={r.id} value={`${title} ${r.id}`} onSelect={() => toggle(r.id)} className="gap-2">
                <ArrowUpRight className="size-3.5 text-muted-foreground" />
                <span className="truncate">{title}</span>
                {chosen.includes(r.id) && <Check className="ml-auto size-4" />}
              </CommandItem>
            )
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

/** Lists a cell's files with upload and remove. */
export function FilePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [files, setFiles] = useState(() => fileList(value))
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const set = (next: string[]) => {
    setFiles(next)
    onChange(next.join("\n"))
  }
  const upload = async (list: FileList | null) => {
    if (!list?.length) return
    setBusy(true)
    const added: string[] = []
    for (const f of Array.from(list)) {
      try {
        added.push((await api.upload(f)).path)
      } catch (e) {
        toast.error(errorMessage(e))
      }
    }
    setBusy(false)
    if (added.length) set([...files, ...added])
  }
  return (
    <div className="grid w-72 gap-1 p-1.5">
      {files.map((p) => (
        <div key={p} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent">
          <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
          <a href={fileUrl(p)} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate hover:underline">
            {p.split("/").pop()}
          </a>
          <button type="button" aria-label="Remove file" onClick={() => set(files.filter((f) => f !== p))} className="text-muted-foreground hover:text-foreground">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <input ref={input} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
      <Button variant="ghost" size="sm" className="justify-start" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? <Loader2 className="animate-spin" /> : <Upload />} Upload a file
      </Button>
    </div>
  )
}

/** The raw text a cell starts editing with: dates as the input wants them. */
export function editText(col: Column, raw: string) {
  if (col.type === "number" && raw && col.format === "percent") {
    const n = Number(raw)
    return Number.isFinite(n) ? `${+(n * 100).toFixed(10)}%` : raw
  }
  return raw
}
