import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { cn } from "cn"
import { ChartBar, ChartColumn, ChartLine, ChartPie } from "lucide-react"

import { TypeIcon } from "@/components/database/cells"
import type { ViewProps } from "@/components/database/types"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ChartConfig, Column, Row, TableData } from "@/lib/api"
import { type Cell, cellOf, colorOf, display, formatNumber, parseDay, plain, resultKind } from "@/lib/table"

const themeColors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"]
const kinds = [
  { kind: "bar", label: "Bar", icon: ChartColumn },
  { kind: "line", label: "Line", icon: ChartLine },
  { kind: "pie", label: "Pie", icon: ChartPie },
] as const
const aggregates = [
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
]
const MAX_GROUPS = 30
const NONE = "\u0000none"
const OTHER = "\u0000other"

type Group = { key: string; label: string; values: number[]; color: string; sort: number | string }
type Point = { key: string; label: string; value: number; color: string }

/** Bars, a line or a pie of a view's rows, grouped by one column. */
export function ChartView({ data, table, view, rows, editable }: ViewProps) {
  const columns = data.schema.columns
  const cfg: ChartConfig = view.chart ?? { kind: "bar", x: columns[0].id, aggregate: "count" }
  const x = columns.find((c) => c.id === cfg.x) ?? columns[0]
  const y = cfg.y ? columns.find((c) => c.id === cfg.y && resultKind(c) === "number") : undefined
  const agg = y ? (cfg.aggregate && cfg.aggregate !== "count" ? cfg.aggregate : "sum") : "count"
  const set = (patch: Partial<ChartConfig>) => void table.updateView(view.id, { chart: { ...cfg, ...patch } })
  const numeric = columns.filter((c) => resultKind(c) === "number")

  const { points, byMonth } = useMemo(() => chartPoints(data, rows, x, y, agg), [data, rows, x, y, agg])
  const fmt = (n: number) => (y ? formatNumber(n, y) : new Intl.NumberFormat().format(n))
  const measure = y ? `${aggregates.find((a) => a.value === agg)?.label} of ${y.name}` : "Rows"

  return (
    <div className="grid gap-3">
      {editable && (
        <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
          <div role="radiogroup" aria-label="Chart type" className="flex h-8 items-center rounded-md bg-muted p-0.5">
            {kinds.map((k) => (
              <button
                key={k.kind}
                type="button"
                role="radio"
                aria-checked={cfg.kind === k.kind}
                aria-label={k.label}
                onClick={() => set({ kind: k.kind })}
                className={cn("flex h-7 items-center gap-1.5 rounded px-2 text-muted-foreground transition-colors", cfg.kind === k.kind && "bg-background text-foreground shadow-xs")}
              >
                <k.icon className="size-3.5" />
                <span className="max-sm:sr-only">{k.label}</span>
              </button>
            ))}
          </div>
          <span className="text-muted-foreground">by</span>
          <Select value={x.id} onValueChange={(id) => set({ x: id })}>
            <SelectTrigger size="sm" className="h-8 text-[0.8125rem]" aria-label="Group by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {columns.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  <TypeIcon type={c.type} /> {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground">showing</span>
          <Select value={y?.id ?? "count"} onValueChange={(id) => set(id === "count" ? { y: undefined, aggregate: "count" } : { y: id, aggregate: agg === "count" ? "sum" : agg })}>
            <SelectTrigger size="sm" className="h-8 text-[0.8125rem]" aria-label="Value">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="count">Number of rows</SelectItem>
              {numeric.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  <TypeIcon type={c.type} /> {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {y && (
            <Select value={agg} onValueChange={(a) => set({ aggregate: a })}>
              <SelectTrigger size="sm" className="h-8 text-[0.8125rem]" aria-label="Combine with">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {aggregates.map((a) => (
                  <SelectItem key={a.value} value={a.value}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {byMonth && <span className="text-xs text-muted-foreground">Grouped by month</span>}
        </div>
      )}
      {points.length === 0 ? (
        <Empty className="min-h-64 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ChartBar />
            </EmptyMedia>
            <EmptyTitle>Nothing to chart</EmptyTitle>
            <EmptyDescription>{rows.length ? `None of these rows have a value for ${y?.name ?? x.name}.` : "Add rows, or loosen the view's filters."}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="rounded-lg border p-3 sm:p-4">
          <p className="mb-2 text-xs text-muted-foreground">
            {measure} by {x.name}
          </p>
          {cfg.kind === "pie" ? <Pie points={points} fmt={fmt} /> : <Axes points={points} fmt={fmt} line={cfg.kind === "line"} />}
        </div>
      )}
    </div>
  )
}

/** Groups rows by the X column and combines the Y values of each group. */
function chartPoints(data: TableData, rows: Row[], x: Column, y: Column | undefined, agg: string): { points: Point[]; byMonth: boolean } {
  const xKind = x.type === "select" ? "select" : resultKind(x)
  const cells = rows.map((r) => cellOf(data, r, x))

  // Dates spanning more than two months group by month, else by day.
  let byMonth = false
  if (xKind === "date") {
    const days = cells.flatMap((c) => (c.kind === "date" ? [c.d.slice(0, 10)] : [])).sort()
    if (days.length > 1) byMonth = (parseDay(days[days.length - 1]).getTime() - parseDay(days[0]).getTime()) / 86_400_000 > 62
  }
  const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" })
  const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })

  const keysOf = (c: Cell): { key: string; label: string; sort: number | string }[] => {
    if (c.kind === "empty" || (c.kind === "text" && !c.s.trim())) return [{ key: NONE, label: "None", sort: "" }]
    if (c.kind === "list") return c.items.length ? c.items.flatMap(keysOf) : [{ key: NONE, label: "None", sort: "" }]
    if (c.kind === "bool") return [{ key: c.b ? "true" : "false", label: c.b ? "Checked" : "Unchecked", sort: c.b ? 0 : 1 }]
    if (c.kind === "date") {
      const k = byMonth ? c.d.slice(0, 7) : c.d.slice(0, 10)
      const d = parseDay(byMonth ? `${k}-01` : k)
      return [{ key: k, label: byMonth ? monthFmt.format(d) : dayFmt.format(d), sort: k }]
    }
    if (c.kind === "error") return [{ key: NONE, label: "None", sort: "" }]
    const k = plain(c)
    return [{ key: k.toLowerCase(), label: display(c, x), sort: c.kind === "number" ? c.n : k }]
  }

  const groups = new Map<string, Group>()
  rows.forEach((r, i) => {
    let v = 1
    if (y) {
      const yc = cellOf(data, r, y)
      if (yc.kind !== "number") return
      v = yc.n
    }
    for (const k of keysOf(cells[i])) {
      let g = groups.get(k.key)
      if (!g) {
        const color = x.type === "select" || x.type === "multi" ? colorOf(x.options?.find((o) => o.name.toLowerCase() === k.key)?.color).bar : ""
        g = { key: k.key, label: k.label, values: [], color, sort: k.sort }
        groups.set(k.key, g)
      }
      g.values.push(v)
    }
  })

  const combine = (vs: number[]) => {
    if (!y) return vs.length
    switch (agg) {
      case "avg":
        return vs.reduce((a, b) => a + b, 0) / vs.length
      case "min":
        return Math.min(...vs)
      case "max":
        return Math.max(...vs)
    }
    return vs.reduce((a, b) => a + b, 0)
  }

  let list = [...groups.values()]
  const noneLast = (a: Group, b: Group) => Number(a.key === NONE) - Number(b.key === NONE)
  if (x.type === "select" || x.type === "multi") {
    const rank = (k: string) => {
      const i = x.options?.findIndex((o) => o.name.toLowerCase() === k) ?? -1
      return i < 0 ? Number.MAX_SAFE_INTEGER : i
    }
    list.sort((a, b) => noneLast(a, b) || rank(a.key) - rank(b.key))
  } else if (xKind === "date" || x.type === "checkbox") {
    list.sort((a, b) => noneLast(a, b) || (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0))
  } else {
    list.sort((a, b) => noneLast(a, b) || combine(b.values) - combine(a.values))
  }

  // Keep the biggest groups; the rest share one "Other" bar. Dates keep their order.
  if (list.length > MAX_GROUPS && xKind !== "date") {
    const ranked = [...list].sort((a, b) => combine(b.values) - combine(a.values))
    const keep = new Set(ranked.slice(0, MAX_GROUPS - 1).map((g) => g.key))
    const rest = list.filter((g) => !keep.has(g.key))
    list = [...list.filter((g) => keep.has(g.key)), { key: OTHER, label: `Other (${rest.length})`, values: rest.flatMap((g) => g.values), color: "", sort: "" }]
  }

  let ci = 0
  const points = list.map((g) => ({
    key: g.key,
    label: g.label,
    value: combine(g.values),
    color: g.key === OTHER || g.key === NONE ? "var(--muted-foreground)" : g.color || themeColors[ci++ % themeColors.length],
  }))
  return { points, byMonth }
}

/** Tracks an element's width, so the SVG draws at real pixels and text stays crisp. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)))
    ro.observe(el)
    setWidth(Math.floor(el.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

/** Round numbers for the value axis: 0 and up to about five steps. */
function ticks(min: number, max: number) {
  if (max === min) max = min + 1
  const span = max - min
  const step0 = Math.pow(10, Math.floor(Math.log10(span / 4)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * step0).find((s) => span / s <= 5) ?? step0 * 10
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  const out: number[] = []
  for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10))
  return out
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })

function Axes({ points, fmt, line }: { points: Point[]; fmt: (n: number) => string; line: boolean }) {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const height = 300
  const vals = points.map((p) => p.value)
  const t = ticks(Math.min(0, ...vals), Math.max(0, ...vals))
  const lo = t[0]
  const hi = t[t.length - 1]
  const left = Math.max(32, ...t.map((v) => compact.format(v).length * 7 + 10))
  const slot = Math.max(1, (width - left - 8) / points.length)
  // Long or many labels turn sideways.
  const longest = Math.max(...points.map((p) => p.label.length))
  const tilt = slot < longest * 6.5 + 8
  const every = Math.max(1, Math.ceil(14 / slot))
  const bottom = tilt ? Math.min(90, longest * 5 + 20) : 28
  const plotH = height - bottom - 8
  const yAt = (v: number) => 8 + plotH - ((v - lo) / (hi - lo)) * plotH
  const xAt = (i: number) => left + slot * i + slot / 2
  const barW = Math.max(2, Math.min(56, slot * 0.7))
  const clip = (s: string) => (s.length > 18 ? `${s.slice(0, 17)}…` : s)

  return (
    <div ref={ref} className="relative w-full select-none" onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Chart" className="block overflow-visible">
          {t.map((v) => (
            <g key={v}>
              <line x1={left} x2={width - 4} y1={yAt(v)} y2={yAt(v)} stroke="var(--border)" strokeDasharray={v === 0 ? undefined : "3 3"} />
              <text x={left - 8} y={yAt(v)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted-foreground)" className="tabular-nums">
                {compact.format(v)}
              </text>
            </g>
          ))}
          {line ? (
            <>
              <polyline
                points={points.map((p, i) => `${xAt(i)},${yAt(p.value)}`).join(" ")}
                fill="none"
                stroke="var(--chart-1)"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {points.map((p, i) => (
                <circle key={p.key} cx={xAt(i)} cy={yAt(p.value)} r={hover === i ? 5 : 3} fill="var(--background)" stroke="var(--chart-1)" strokeWidth={2} />
              ))}
            </>
          ) : (
            points.map((p, i) => {
              const top = yAt(Math.max(0, p.value))
              const h = Math.max(1, Math.abs(yAt(p.value) - yAt(0)))
              return <rect key={p.key} x={xAt(i) - barW / 2} y={top} width={barW} height={h} rx={Math.min(3, barW / 4)} fill={p.color} opacity={hover === null || hover === i ? 1 : 0.55} />
            })
          )}
          {points.map((p, i) =>
            i % every === 0 ? (
              <text
                key={p.key}
                x={xAt(i)}
                y={height - bottom + 16}
                fontSize={11}
                fill="var(--muted-foreground)"
                textAnchor={tilt ? "end" : "middle"}
                transform={tilt ? `rotate(-40 ${xAt(i)} ${height - bottom + 16})` : undefined}
              >
                {clip(p.label)}
              </text>
            ) : null,
          )}
          {points.map((p, i) => (
            <rect key={p.key} x={left + slot * i} y={0} width={slot} height={height - bottom} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
              <title>{`${p.label}: ${fmt(p.value)}`}</title>
            </rect>
          ))}
        </svg>
      )}
      {hover !== null && points[hover] && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
          style={{ left: Math.min(Math.max(xAt(hover), 60), width - 60), top: Math.max(0, yAt(Math.max(0, points[hover].value)) - 44), transform: "translateX(-50%)" }}
        >
          <div className="font-medium">{points[hover].label}</div>
          <div className="tabular-nums text-muted-foreground">{fmt(points[hover].value)}</div>
        </div>
      )}
    </div>
  )
}

function Pie({ points, fmt }: { points: Point[]; fmt: (n: number) => string }) {
  const [hover, setHover] = useState<string | null>(null)
  // A pie can only show parts of a whole.
  const parts = points.filter((p) => p.value > 0)
  const total = parts.reduce((a, p) => a + p.value, 0)
  const size = 220
  const r = size / 2
  const inner = r * 0.58
  let angle = -Math.PI / 2
  const arcs = parts.map((p) => {
    const sweep = (p.value / total) * Math.PI * 2
    const a0 = angle
    const a1 = angle + sweep
    angle = a1
    return { p, a0, a1 }
  })
  const pt = (rad: number, a: number) => `${r + rad * Math.cos(a)},${r + rad * Math.sin(a)}`
  const path = (a0: number, a1: number) => {
    // A full circle needs two halves; one arc from a point to itself draws nothing.
    if (a1 - a0 >= Math.PI * 2 - 1e-6) a1 = a0 + Math.PI * 2 - 1e-4
    const large = a1 - a0 > Math.PI ? 1 : 0
    return `M${pt(r, a0)} A${r},${r} 0 ${large} 1 ${pt(r, a1)} L${pt(inner, a1)} A${inner},${inner} 0 ${large} 0 ${pt(inner, a0)} Z`
  }
  const shown = hover ? parts.find((p) => p.key === hover) : undefined
  const pct = (v: number) => `${((v / total) * 100).toFixed(v / total < 0.1 ? 1 : 0)}%`

  if (!parts.length) return <p className="py-10 text-center text-sm text-muted-foreground">A pie needs values above zero.</p>
  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start sm:justify-center sm:gap-10">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} role="img" aria-label="Pie chart">
          {arcs.map(({ p, a0, a1 }) => (
            <path
              key={p.key}
              d={path(a0, a1)}
              fill={p.color}
              stroke="var(--background)"
              strokeWidth={1.5}
              opacity={hover === null || hover === p.key ? 1 : 0.5}
              onMouseEnter={() => setHover(p.key)}
              onMouseLeave={() => setHover(null)}
            >
              <title>{`${p.label}: ${fmt(p.value)} (${pct(p.value)})`}</title>
            </path>
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <div className="text-lg font-semibold tabular-nums">{fmt(shown?.value ?? total)}</div>
            <div className="max-w-28 truncate text-xs text-muted-foreground">{shown ? shown.label : "Total"}</div>
          </div>
        </div>
      </div>
      <ul className="grid w-full max-w-xs gap-0.5 text-sm">
        {parts.map((p) => (
          <li
            key={p.key}
            onMouseEnter={() => setHover(p.key)}
            onMouseLeave={() => setHover(null)}
            className={cn("flex items-center gap-2 rounded-md px-2 py-1", hover === p.key && "bg-accent")}
          >
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: p.color }} />
            <span className="min-w-0 flex-1 truncate">{p.label}</span>
            <span className="tabular-nums text-muted-foreground">{fmt(p.value)}</span>
            <span className="w-12 text-right tabular-nums text-xs text-muted-foreground">{pct(p.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
