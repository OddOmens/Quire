import type { Column, ColumnType, FormulaValue, Row, TableData, View, ViewFilter, ViewSort } from "@/lib/api"

/** Column types in the order the type menu lists them. */
export const columnTypes: { type: ColumnType; label: string; hint: string }[] = [
  { type: "text", label: "Text", hint: "Words, notes, anything" },
  { type: "number", label: "Number", hint: "Amounts, counts, money, percentages" },
  { type: "select", label: "Select", hint: "One choice from a list" },
  { type: "multi", label: "Multi-select", hint: "Several choices, like tags" },
  { type: "date", label: "Date", hint: "A day, or a day and time" },
  { type: "checkbox", label: "Checkbox", hint: "Yes or no" },
  { type: "url", label: "Link", hint: "A web address" },
  { type: "email", label: "Email", hint: "An email address" },
  { type: "phone", label: "Phone", hint: "A phone number" },
  { type: "page", label: "Page", hint: "A [[link]] to a page" },
  { type: "file", label: "Files", hint: "Uploaded files and pictures" },
  { type: "relation", label: "Relation", hint: "Rows of another database" },
  { type: "formula", label: "Formula", hint: "Worked out from other columns" },
  { type: "rollup", label: "Rollup", hint: "Totals from related rows" },
  { type: "created", label: "Created time", hint: "When each row was added" },
]

export const typeLabel = (t: ColumnType) => columnTypes.find((c) => c.type === t)?.label ?? t

/** Types whose values are typed in and stored, as opposed to worked out. */
export const isStored = (t: ColumnType) => t !== "formula" && t !== "rollup" && t !== "created"

/** Colours for select options, in Tailwind classes that work in both themes. */
export const optionColors: Record<string, { chip: string; dot: string; bar: string }> = {
  gray: { chip: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300", dot: "bg-zinc-400", bar: "#a1a1aa" },
  blue: { chip: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300", dot: "bg-blue-500", bar: "#3b82f6" },
  green: { chip: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300", dot: "bg-emerald-500", bar: "#10b981" },
  amber: { chip: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300", dot: "bg-amber-500", bar: "#f59e0b" },
  red: { chip: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300", dot: "bg-red-500", bar: "#ef4444" },
  purple: { chip: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300", dot: "bg-violet-500", bar: "#8b5cf6" },
  pink: { chip: "bg-pink-100 text-pink-800 dark:bg-pink-950 dark:text-pink-300", dot: "bg-pink-500", bar: "#ec4899" },
  teal: { chip: "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300", dot: "bg-teal-500", bar: "#14b8a6" },
  orange: { chip: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300", dot: "bg-orange-500", bar: "#f97316" },
  brown: { chip: "bg-stone-200 text-stone-800 dark:bg-stone-800 dark:text-stone-300", dot: "bg-stone-500", bar: "#a8a29e" },
}
export const colorNames = Object.keys(optionColors)
export const colorOf = (c?: string) => optionColors[c ?? "gray"] ?? optionColors.gray

export function optionColor(col: Column, name: string) {
  return colorOf(col.options?.find((o) => o.name.toLowerCase() === name.toLowerCase())?.color)
}

// ── Values ──

/** A cell's value, typed: what sorting, filtering, totals and display use. */
export type Cell =
  | { kind: "empty" }
  | { kind: "number"; n: number }
  | { kind: "text"; s: string }
  | { kind: "bool"; b: boolean }
  | { kind: "date"; d: string; time: boolean }
  | { kind: "list"; items: Cell[] }
  | { kind: "error"; code: string; message: string }

const EMPTY: Cell = { kind: "empty" }

export function fromFormula(v: FormulaValue | undefined): Cell {
  if (v === null || v === undefined) return EMPTY
  if (typeof v === "number") return { kind: "number", n: v }
  if (typeof v === "string") return v === "" ? EMPTY : { kind: "text", s: v }
  if (typeof v === "boolean") return { kind: "bool", b: v }
  if (Array.isArray(v)) return { kind: "list", items: v.map(fromFormula) }
  if ("date" in v) return { kind: "date", d: v.date, time: v.date.includes("T") }
  return { kind: "error", code: v.error, message: v.message }
}

/** Reads a row's value of a column. */
export function cellOf(data: TableData, row: Row, col: Column): Cell {
  if (!isStored(col.type)) return fromFormula(data.values[row.id]?.[col.id])
  const raw = row.cells[col.id] ?? ""
  if (raw === "") return col.type === "checkbox" ? { kind: "bool", b: false } : EMPTY
  switch (col.type) {
    case "number": {
      const n = Number(raw)
      return Number.isFinite(n) ? { kind: "number", n } : { kind: "text", s: raw }
    }
    case "checkbox":
      return { kind: "bool", b: raw === "true" }
    case "date":
      return /^\d{4}-\d{2}-\d{2}/.test(raw) ? { kind: "date", d: raw, time: raw.includes("T") } : { kind: "text", s: raw }
    case "multi":
      return { kind: "list", items: splitMulti(raw).map((s) => ({ kind: "text", s })) }
    case "relation": {
      const titles = data.related[col.id] ?? {}
      return { kind: "list", items: relationIds(raw).map((id) => ({ kind: "text", s: titles[id] ?? "Missing row" })) }
    }
    case "file":
      return { kind: "list", items: raw.split("\n").map((s) => ({ kind: "text", s })) }
  }
  return { kind: "text", s: raw }
}

export const splitMulti = (raw: string) => (raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [])
export const relationIds = (raw: string) => (raw ? raw.split(",").filter(Boolean) : [])
export const fileList = (raw: string) => (raw ? raw.split("\n").filter(Boolean) : [])

const isEmpty = (c: Cell) => c.kind === "empty" || (c.kind === "list" && c.items.length === 0) || (c.kind === "text" && c.s.trim() === "")

// ── Display ──

const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })

/** "2026-11-03" or "2026-11-03T14:30" as a local Date. */
export function parseDay(d: string) {
  const [day, time] = d.split("T")
  const [y, m, dd] = day.split("-").map(Number)
  const [h, min] = (time ?? "0:0").split(":").map(Number)
  return new Date(y, (m || 1) - 1, dd || 1, h || 0, min || 0)
}

export function formatDate(d: string, withTime = d.includes("T")) {
  const date = parseDay(d)
  if (Number.isNaN(date.getTime())) return d
  const day = monthDay.format(date)
  return withTime && d.includes("T") ? `${day}, ${timeFmt.format(date)}` : day
}

export function formatNumber(n: number, col?: Pick<Column, "format" | "decimals" | "currency">) {
  const format = col?.format
  const decimals = col?.decimals
  const opts: Intl.NumberFormatOptions = {}
  if (decimals !== undefined && decimals !== null) {
    opts.minimumFractionDigits = decimals
    opts.maximumFractionDigits = decimals
  } else {
    opts.maximumFractionDigits = format === "currency" ? 2 : 10
    if (format === "currency") opts.minimumFractionDigits = Number.isInteger(n) ? 0 : 2
  }
  try {
    if (format === "currency") return new Intl.NumberFormat(undefined, { ...opts, style: "currency", currency: col?.currency || "USD" }).format(n)
    if (format === "percent") {
      if (decimals === undefined) opts.maximumFractionDigits = 2
      return new Intl.NumberFormat(undefined, { ...opts, style: "percent" }).format(n)
    }
    return new Intl.NumberFormat(undefined, opts).format(n)
  } catch {
    return String(n)
  }
}

/** A value as text, formatted for its column. */
export function display(c: Cell, col?: Column): string {
  switch (c.kind) {
    case "empty":
      return ""
    case "number":
      return formatNumber(c.n, col)
    case "text":
      return c.s
    case "bool":
      return c.b ? "Yes" : "No"
    case "date":
      return formatDate(c.d, col?.format === "datetime" || c.time)
    case "list":
      return c.items.map((i) => display(i, col)).filter(Boolean).join(", ")
    case "error":
      return c.code
  }
}

/** Plain text for copying and search: numbers unformatted, dates as stored. */
export function plain(c: Cell): string {
  switch (c.kind) {
    case "number":
      return String(c.n)
    case "date":
      return c.d
    case "bool":
      return c.b ? "true" : "false"
    case "list":
      return c.items.map(plain).join(", ")
    case "error":
      return c.code
    case "text":
      return c.s
  }
  return ""
}

/** What a computed column's values look like, for alignment and editors. */
export function resultKind(col: Column): "number" | "date" | "bool" | "text" {
  switch (col.type) {
    case "number":
      return "number"
    case "date":
    case "created":
      return "date"
    case "checkbox":
      return "bool"
    case "formula":
    case "rollup":
      if (col.format === "number" || col.format === "currency" || col.format === "percent") return "number"
      if (col.format === "date") return "date"
      if (col.format === "checkbox") return "bool"
      if (col.type === "rollup" && col.aggregate && col.aggregate !== "show") return "number"
  }
  return "text"
}

// ── Sorting ──

function compareCells(a: Cell, b: Cell): number {
  const ea = isEmpty(a)
  const eb = isEmpty(b)
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1 // blanks last either way
  if (a.kind === "number" && b.kind === "number") return a.n - b.n
  if (a.kind === "date" && b.kind === "date") return a.d < b.d ? -1 : a.d > b.d ? 1 : 0
  if (a.kind === "bool" && b.kind === "bool") return Number(a.b) - Number(b.b)
  return plain(a).localeCompare(plain(b), undefined, { numeric: true, sensitivity: "base" })
}

function optionRank(col: Column, c: Cell) {
  if (col.type !== "select" || c.kind !== "text") return -1
  return col.options?.findIndex((o) => o.name === c.s) ?? -1
}

export function sortRows(data: TableData, rows: Row[], sorts: ViewSort[]) {
  const cols = sorts.map((s) => ({ s, col: data.schema.columns.find((c) => c.id === s.column) })).filter((x) => x.col)
  if (!cols.length) return rows
  return [...rows].sort((ra, rb) => {
    for (const { s, col } of cols) {
      const a = cellOf(data, ra, col!)
      const b = cellOf(data, rb, col!)
      let c: number
      const oa = optionRank(col!, a)
      const ob = optionRank(col!, b)
      if (oa >= 0 && ob >= 0) c = oa - ob
      else c = compareCells(a, b)
      if (isEmpty(a) !== isEmpty(b)) return c // blanks stay last when descending too
      if (c !== 0) return s.desc ? -c : c
    }
    return 0
  })
}

// ── Filtering ──

export type FilterOp = { op: string; label: string; needsValue: boolean }

const emptyOps: FilterOp[] = [
  { op: "empty", label: "is empty", needsValue: false },
  { op: "filled", label: "is not empty", needsValue: false },
]

export function filterOps(col: Column): FilterOp[] {
  const kind = col.type === "select" ? "select" : col.type === "multi" || col.type === "relation" || col.type === "file" ? "list" : resultKind(col)
  switch (kind) {
    case "number":
      return [
        { op: "=", label: "=", needsValue: true },
        { op: "!=", label: "≠", needsValue: true },
        { op: ">", label: ">", needsValue: true },
        { op: ">=", label: "≥", needsValue: true },
        { op: "<", label: "<", needsValue: true },
        { op: "<=", label: "≤", needsValue: true },
        ...emptyOps,
      ]
    case "date":
      return [
        { op: "on", label: "is", needsValue: true },
        { op: "before", label: "is before", needsValue: true },
        { op: "after", label: "is after", needsValue: true },
        { op: "today", label: "is today", needsValue: false },
        { op: "week", label: "is within the next 7 days", needsValue: false },
        { op: "past", label: "is in the past", needsValue: false },
        { op: "future", label: "is today or later", needsValue: false },
        ...emptyOps,
      ]
    case "bool":
      return [
        { op: "checked", label: "is checked", needsValue: false },
        { op: "unchecked", label: "is not checked", needsValue: false },
      ]
    case "select":
      return [
        { op: "is", label: "is", needsValue: true },
        { op: "not", label: "is not", needsValue: true },
        ...emptyOps,
      ]
    case "list":
      return [
        { op: "has", label: "has", needsValue: true },
        { op: "lacks", label: "doesn't have", needsValue: true },
        ...emptyOps,
      ]
  }
  return [
    { op: "contains", label: "contains", needsValue: true },
    { op: "lacks", label: "doesn't contain", needsValue: true },
    { op: "is", label: "is", needsValue: true },
    { op: "not", label: "is not", needsValue: true },
    { op: "starts", label: "starts with", needsValue: true },
    ...emptyOps,
  ]
}

const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

function matches(c: Cell, f: ViewFilter): boolean {
  const v = (f.value ?? "").trim()
  const lower = v.toLowerCase()
  const text = plain(c).toLowerCase()
  switch (f.op) {
    case "empty":
      return isEmpty(c)
    case "filled":
      return !isEmpty(c)
    case "checked":
      return c.kind === "bool" ? c.b : !isEmpty(c)
    case "unchecked":
      return c.kind === "bool" ? !c.b : isEmpty(c)
    case "contains":
      return text.includes(lower)
    case "lacks":
      if (c.kind === "list") return !c.items.some((i) => plain(i).toLowerCase() === lower)
      return !text.includes(lower)
    case "is":
      return text === lower
    case "not":
      return text !== lower
    case "starts":
      return text.startsWith(lower)
    case "has":
      return c.kind === "list" ? c.items.some((i) => plain(i).toLowerCase() === lower) : text === lower
  }
  if (c.kind === "date") {
    const day = c.d.slice(0, 10)
    const today = todayIso()
    switch (f.op) {
      case "on":
        return day === v
      case "before":
        return day < v
      case "after":
        return day > v
      case "today":
        return day === today
      case "past":
        return day < today
      case "future":
        return day >= today
      case "week": {
        const end = new Date()
        end.setDate(end.getDate() + 7)
        return day >= today && day <= isoDay(end)
      }
    }
    return false
  }
  const n = c.kind === "number" ? c.n : Number.NaN
  const want = Number(v.replace(/[$,%\s]/g, ""))
  if (Number.isNaN(n) || v === "" || Number.isNaN(want)) return false
  switch (f.op) {
    case "=":
      return n === want
    case "!=":
      return n !== want
    case ">":
      return n > want
    case ">=":
      return n >= want
    case "<":
      return n < want
    case "<=":
      return n <= want
  }
  return true
}

/** The rows a view shows, in its order. search narrows by any visible text. */
export function viewRows(data: TableData, view: View | undefined, search = ""): Row[] {
  let rows = data.rows
  const filters = (view?.filters ?? []).filter((f) => {
    const col = data.schema.columns.find((c) => c.id === f.column)
    const op = col && filterOps(col).find((o) => o.op === f.op)
    return col && op && (!op.needsValue || (f.value ?? "").trim() !== "")
  })
  if (filters.length) {
    const any = view?.match === "any"
    rows = rows.filter((r) => {
      const test = (f: ViewFilter) => matches(cellOf(data, r, data.schema.columns.find((c) => c.id === f.column)!), f)
      return any ? filters.some(test) : filters.every(test)
    })
  }
  const q = search.trim().toLowerCase()
  if (q) {
    rows = rows.filter((r) => data.schema.columns.some((c) => display(cellOf(data, r, c), c).toLowerCase().includes(q)))
  }
  return sortRows(data, rows, view?.sorts ?? [])
}

// ── Totals ──

export const summaryKinds: { kind: string; label: string; numeric?: boolean }[] = [
  { kind: "count", label: "Count all" },
  { kind: "filled", label: "Count filled" },
  { kind: "empty", label: "Count empty" },
  { kind: "unique", label: "Count unique" },
  { kind: "sum", label: "Sum", numeric: true },
  { kind: "avg", label: "Average", numeric: true },
  { kind: "median", label: "Median", numeric: true },
  { kind: "min", label: "Min", numeric: true },
  { kind: "max", label: "Max", numeric: true },
  { kind: "range", label: "Range", numeric: true },
  { kind: "checked", label: "Checked" },
  { kind: "percent", label: "Percent checked" },
]

/** Works out a column's total over rows, as text for the footer. */
export function summarize(data: TableData, rows: Row[], col: Column, kind: string): string {
  const cells = rows.map((r) => cellOf(data, r, col))
  const nums = cells.flatMap((c) => (c.kind === "number" ? [c.n] : c.kind === "list" ? c.items.flatMap((i) => (i.kind === "number" ? [i.n] : [])) : []))
  const count = (n: number) => new Intl.NumberFormat().format(n)
  switch (kind) {
    case "count":
      return count(rows.length)
    case "filled":
      return count(cells.filter((c) => !isEmpty(c) && !(c.kind === "bool" && !c.b)).length)
    case "empty":
      return count(cells.filter((c) => isEmpty(c) || (c.kind === "bool" && !c.b)).length)
    case "unique":
      return count(new Set(cells.filter((c) => !isEmpty(c)).map((c) => plain(c).toLowerCase())).size)
    case "checked":
      return count(cells.filter((c) => c.kind === "bool" && c.b).length)
    case "percent": {
      if (!rows.length) return "–"
      const n = cells.filter((c) => c.kind === "bool" && c.b).length
      return `${Math.round((n / rows.length) * 100)}%`
    }
  }
  if (!nums.length) return "–"
  const fmt = (n: number) => formatNumber(n, col.type === "number" || resultKind(col) === "number" ? col : undefined)
  const sorted = [...nums].sort((a, b) => a - b)
  switch (kind) {
    case "sum":
      return fmt(nums.reduce((a, b) => a + b, 0))
    case "avg":
      return fmt(nums.reduce((a, b) => a + b, 0) / nums.length)
    case "median": {
      const m = Math.floor(sorted.length / 2)
      return fmt(sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2)
    }
    case "min":
      return fmt(sorted[0])
    case "max":
      return fmt(sorted[sorted.length - 1])
    case "range":
      return fmt(sorted[sorted.length - 1] - sorted[0])
  }
  return ""
}

/** The label a summary shows in front of its value. */
export const summaryLabel = (kind: string) =>
  ({ count: "Count", filled: "Filled", empty: "Empty", unique: "Unique", sum: "Sum", avg: "Average", median: "Median", min: "Min", max: "Max", range: "Range", checked: "Checked", percent: "Checked" })[kind] ?? ""

// ── Schema helpers ──

export function newId(prefix: string) {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789"
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return prefix + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")
}

/** A name not yet used by a column: "Column", "Column 2"… */
export function freshName(columns: Column[], base: string) {
  const taken = new Set(columns.map((c) => c.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`
}
