import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { cn } from "cn"
import { Icon, Search } from "lucide-react"
import icons from "virtual:lucide-icons"

import { Button } from "@/components/ui/button"
import { useLucideIcon } from "@/lib/lucide"

// The icon picker's popover body, loaded on first open: the list of ~2,000
// Lucide names lives in this chunk, and only the icons scrolled into view load.

type Entry = { name: string; aliases: string[] }

const entries: Entry[] = icons.map((line) => {
  const [name, ...aliases] = line.split(" ")
  return { name, aliases }
})

/** Any Lucide name or alias → the icon's own name ("home" → "house"). */
const canonical = new Map<string, string>()
for (const e of entries) {
  canonical.set(e.name, e.name)
  for (const a of e.aliases) canonical.set(a, e.name)
}

const SUGGESTED = [
  ...new Set(
    [
      "server", "book", "notebook", "folder", "home", "briefcase", "code", "database", "cloud", "shield", "film", "music",
      "camera", "gamepad-2", "map", "globe", "rocket", "heart", "star", "wrench", "terminal", "layers", "archive", "calendar",
    ]
      .map((n) => canonical.get(n))
      .filter((n): n is string => !!n),
  ),
]
const ALL = entries.map((e) => e.name)

/** Names matching every word of the query, best first: exact, then prefix, then anywhere; aliases count as names. */
function search(query: string): string[] {
  const words = query
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean)
  if (!words.length) return []
  const q = words.join("-")
  const hits: { name: string; score: number }[] = []
  for (const e of entries) {
    const terms = [e.name, ...e.aliases]
    if (!words.every((w) => terms.some((t) => t.includes(w)))) continue
    const score = e.name === q ? 0 : e.aliases.includes(q) ? 1 : e.name.startsWith(q) ? 2 : terms.some((t) => t.startsWith(q)) ? 3 : e.name.includes(q) ? 4 : 5
    hits.push({ name: e.name, score })
  }
  return hits.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)).map((h) => h.name)
}

const COLS = 8
const ROW = 40 // px, an icon row
const LABEL = 28 // px, a section heading
const VIEW = 288 // px, the scroll area's height (max-h-72)
const OVERSCAN = 3 * ROW

type Row = { top: number; label?: string; items?: number[] }

/** Lays the sections out as fixed-height rows so only the visible ones render. */
function layout(sections: { label?: string; names: string[] }[]) {
  const options: string[] = []
  const rows: Row[] = []
  const where: { row: number; col: number }[] = []
  let top = 0
  for (const s of sections) {
    if (!s.names.length) continue
    if (s.label) {
      rows.push({ top, label: s.label })
      top += LABEL
    }
    for (let i = 0; i < s.names.length; i += COLS) {
      const items: number[] = []
      for (const name of s.names.slice(i, i + COLS)) {
        where.push({ row: rows.length, col: items.length })
        items.push(options.length)
        options.push(name)
      }
      rows.push({ top, items })
      top += ROW
    }
  }
  return { options, rows, where, height: top, iconRows: rows.flatMap((r, i) => (r.items ? [i] : [])) }
}

export default function IconPickerPanel({
  value,
  color,
  onPick,
  focusList,
}: {
  value: string
  color: string
  onPick: (icon: string) => void
  /** Focus the grid instead of the search box (touch screens, so the keyboard doesn't cover it). */
  focusList?: boolean
}) {
  const [query, setQuery] = useState("")
  const selected = value ? (canonical.get(value) ?? value) : ""
  const results = useMemo(() => (query.trim() ? search(query) : null), [query])
  const grid = useMemo(
    () => layout(results ? [{ names: results }] : [{ label: "Suggested", names: SUGGESTED }, { label: "All icons", names: ALL }]),
    [results],
  )
  const [active, setActive] = useState(() => grid.options.indexOf(selected))
  const [scrollTop, setScrollTop] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const optionId = (i: number) => `${id}-icon-${i}`

  useEffect(() => {
    if (focusList) scroller.current?.focus()
    else input.current?.focus()
  }, [focusList])

  /** Scrolls an option's row into view; centred when opening on the current icon. */
  const reveal = (i: number, centre = false) => {
    const el = scroller.current
    if (!el || i < 0) return
    const row = grid.where[i].row
    // Show a section's heading along with its first row.
    const top = grid.rows[row - 1]?.label !== undefined ? grid.rows[row - 1].top : grid.rows[row].top
    const bottom = grid.rows[row].top + ROW
    if (centre) el.scrollTop = Math.max(0, top - (VIEW - ROW) / 2)
    else if (top < el.scrollTop) el.scrollTop = top
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
  }

  // Opens scrolled to the current icon.
  const opened = useRef(false)
  useLayoutEffect(() => {
    if (opened.current) return
    opened.current = true
    reveal(grid.options.indexOf(selected), true)
  })

  const setQueryAndReset = (q: string) => {
    setQuery(q)
    setActive(q.trim() ? 0 : -1)
    if (scroller.current) scroller.current.scrollTop = 0
  }

  const move = (key: string): number | undefined => {
    const n = grid.options.length
    if (!n) return undefined
    if (active < 0) return key === "End" ? n - 1 : 0
    const { row, col } = grid.where[active]
    switch (key) {
      case "ArrowRight":
        return Math.min(active + 1, n - 1)
      case "ArrowLeft":
        return Math.max(active - 1, 0)
      case "Home":
        return 0
      case "End":
        return n - 1
      case "ArrowDown":
      case "ArrowUp":
      case "PageDown":
      case "PageUp": {
        const step = (key.startsWith("Page") ? Math.floor(VIEW / ROW) - 1 : 1) * (key === "ArrowDown" || key === "PageDown" ? 1 : -1)
        const at = grid.iconRows.indexOf(row)
        const to = grid.rows[grid.iconRows[Math.max(0, Math.min(grid.iconRows.length - 1, at + step))]].items!
        return to[Math.min(col, to.length - 1)]
      }
    }
    return undefined
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // In the search box, Left/Right/Home/End keep moving the caret.
    const inInput = e.target === input.current
    if (inInput && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return
    if (e.key === "Enter") {
      if (active >= 0 && active < grid.options.length) {
        e.preventDefault()
        onPick(grid.options[active])
      }
      return
    }
    if (!inInput && e.key === " " && active >= 0) {
      e.preventDefault()
      onPick(grid.options[active])
      return
    }
    const next = move(e.key)
    if (next === undefined) return
    e.preventDefault()
    setActive(next)
    reveal(next)
  }

  const visible = grid.rows.filter((r) => r.top + (r.label !== undefined ? LABEL : ROW) > scrollTop - OVERSCAN && r.top < scrollTop + VIEW + OVERSCAN)
  const activeName = active >= 0 ? grid.options[active] : undefined

  return (
    <div className="flex flex-col" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 border-b px-3">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={input}
          value={query}
          onChange={(e) => setQueryAndReset(e.target.value)}
          placeholder="Search icons…"
          aria-label="Search icons"
          role="combobox"
          aria-expanded
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={activeName ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          className="h-10 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div
        ref={scroller}
        id={`${id}-list`}
        role="listbox"
        aria-label={results ? "Matching icons" : "Icons"}
        aria-activedescendant={activeName ? optionId(active) : undefined}
        tabIndex={0}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="relative max-h-72 overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
        style={{ height: grid.options.length ? Math.min(grid.height + 8, VIEW) : undefined }}
      >
        {grid.options.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">No icons match “{query.trim()}”.</p>
        ) : (
          <div className="relative mx-1.5" style={{ height: grid.height + 8 }}>
            {visible.map((r) =>
              r.label !== undefined ? (
                <div key={r.top} role="presentation" className="absolute inset-x-0 flex items-end px-1 pb-1 text-xs font-medium text-muted-foreground" style={{ top: r.top, height: LABEL }}>
                  {r.label}
                </div>
              ) : (
                <div key={r.top} role="presentation" className="absolute inset-x-0 grid grid-cols-8 items-center pt-1" style={{ top: r.top, height: ROW }}>
                  {r.items!.map((i) => (
                    <Cell
                      key={i}
                      id={optionId(i)}
                      name={grid.options[i]}
                      color={color}
                      active={i === active}
                      selected={grid.options[i] === selected}
                      onHover={() => setActive(i)}
                      onPick={() => onPick(grid.options[i])}
                    />
                  ))}
                </div>
              ),
            )}
          </div>
        )}
      </div>
      <div className="flex min-h-11 items-center gap-2 border-t py-1.5 pr-1.5 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" aria-live="polite">
          {activeName ?? (results ? `${results.length.toLocaleString()} ${results.length === 1 ? "icon" : "icons"}` : `${ALL.length.toLocaleString()} icons`)}
        </span>
        <Button type="button" variant="ghost" size="sm" disabled={!value} onClick={() => onPick("")}>
          Use initials
        </Button>
      </div>
    </div>
  )
}

function Cell({
  id,
  name,
  color,
  active,
  selected,
  onHover,
  onPick,
}: {
  id: string
  name: string
  color: string
  active: boolean
  selected: boolean
  onHover: () => void
  onPick: () => void
}) {
  const glyph = useLucideIcon(name)
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-label={name}
      title={name}
      onPointerMove={onHover}
      onClick={onPick}
      className={cn(
        "mx-auto grid size-9 cursor-pointer place-items-center rounded-md text-foreground transition-colors",
        selected ? "text-white" : active && "bg-accent",
        active && "ring-2 ring-ring/60",
      )}
      style={selected ? { background: color } : undefined}
    >
      {glyph ? <Icon icon={glyph} className="size-[1.125rem]" /> : <span className="size-[1.125rem]" />}
    </div>
  )
}
