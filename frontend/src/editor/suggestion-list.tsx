import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react"
import type { Editor, Range } from "@tiptap/core"
import type { SuggestionProps } from "@tiptap/suggestion"
import { cn } from "cn"
import { CalendarDays, FilePlus2, FileText, Table2, type LucideIcon } from "lucide-react"

export type SuggestionItem = {
  title: string
  description?: string
  icon: LucideIcon | "page" | "new" | "database" | "date"
  /** A colour swatch instead of an icon: the CSS colour for the letter and its background. */
  swatch?: { color?: string; background?: string }
  keywords?: string[]
  group?: string
  run: (editor: Editor, range: Range) => void
}

export type SuggestionListHandle = { onKeyDown: (e: KeyboardEvent) => boolean }

/** The popup list behind "/", "[[" and "@". */
export const SuggestionList = forwardRef<SuggestionListHandle, SuggestionProps<SuggestionItem>>(function SuggestionList(props, ref) {
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const { items } = props

  useEffect(() => setIndex(0), [items])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" })
  }, [index])

  const pick = (i: number) => {
    const item = items[i]
    if (item) props.command(item)
  }

  useImperativeHandle(ref, () => ({
    onKeyDown: (e) => {
      if (!items.length) return false
      if (e.key === "ArrowDown") {
        setIndex((i) => (i + 1) % items.length)
        return true
      }
      if (e.key === "ArrowUp") {
        setIndex((i) => (i + items.length - 1) % items.length)
        return true
      }
      if (e.key === "Enter" || e.key === "Tab") {
        pick(index)
        return true
      }
      return false
    },
  }))

  if (!items.length) {
    // A sentence after a "/" or "@" isn't a search: stay out of the way.
    if (!props.text.startsWith("[[") && (/\s/.test(props.query) || props.query.length > 16)) return null
    return (
      <div className="z-50 w-72 rounded-lg border bg-popover px-3 py-2.5 text-sm text-muted-foreground shadow-lg">
        {props.text.startsWith("[[") ? "No pages yet" : props.text.startsWith("@") ? "No matching dates or pages" : "No matching blocks"}
      </div>
    )
  }

  let lastGroup: string | undefined
  return (
    <div
      ref={listRef}
      className="z-50 max-h-[min(20rem,var(--room,20rem))] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg animate-in fade-in zoom-in-95 duration-100"
      role="listbox"
    >
      {items.map((item, i) => {
        const Icon = item.icon === "page" ? FileText : item.icon === "new" ? FilePlus2 : item.icon === "database" ? Table2 : item.icon === "date" ? CalendarDays : item.icon
        const header = item.group && item.group !== lastGroup ? item.group : null
        lastGroup = item.group
        return (
          <div key={`${item.title}-${i}`}>
            {header && <div className="px-2 pt-2 pb-1 text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">{header}</div>}
            <button
              type="button"
              data-index={i}
              role="option"
              aria-selected={i === index}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(i)
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm",
                i === index && "bg-accent text-accent-foreground",
              )}
            >
              {item.swatch ? (
                <span className="grid size-8 shrink-0 place-items-center rounded-md border text-sm font-semibold" style={item.swatch}>
                  A
                </span>
              ) : (
                <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-background">
                  <Icon className={cn("size-4", item.icon === "new" ? "text-brand" : "text-muted-foreground")} />
                </span>
              )}
              <span className="min-w-0">
                <span className="block truncate font-medium">{item.title}</span>
                {item.description && <span className="block truncate text-xs text-muted-foreground">{item.description}</span>}
              </span>
            </button>
          </div>
        )
      })}
    </div>
  )
})
