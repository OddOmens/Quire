import { useEffect, useRef, useState } from "react"
import { cn } from "cn"
import { ArrowDown, ArrowUp, GripVertical, Heading, Plus, X } from "lucide-react"

import { SpaceAvatar } from "@/components/space-avatar"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DragGhost, DropLine, moveItem, useListDrag } from "@/hooks/use-list-drag"
import { useArrangeSpaces, useSpaces, useSpaceSections } from "@/hooks/use-vault"
import type { Space, SpaceSection } from "@/lib/api"
import { onUiEvent } from "@/lib/ui-events"

/** A row: a space, or a section heading that the spaces below it belong to. */
type Row = { kind: "space"; name: string } | { kind: "section"; id: number; name: string }

const MAX_NAME = 60
let nextId = 1

/** The rows for the spaces and headings as they are now. */
function rowsFor(spaces: Space[], sections: SpaceSection[]): Row[] {
  const rows: Row[] = spaces.filter((s) => !s.section).map((s) => ({ kind: "space", name: s.name }))
  for (const sec of sections) {
    rows.push({ kind: "section", id: nextId++, name: sec.name })
    for (const n of sec.spaces) if (spaces.some((s) => s.name === n)) rows.push({ kind: "space", name: n })
  }
  return rows
}

/** The order and the sections the rows say, as the server takes them. */
function layoutOf(rows: Row[]) {
  const names: string[] = []
  const sections: SpaceSection[] = []
  for (const r of rows) {
    if (r.kind === "section") sections.push({ name: r.name.trim(), spaces: [] })
    else {
      names.push(r.name)
      sections.at(-1)?.spaces.push(r.name)
    }
  }
  return { names, sections }
}

const sameLayout = (a: Row[], b: Row[]) => JSON.stringify(layoutOf(a)) === JSON.stringify(layoutOf(b))

/**
 * Puts the spaces in order and under section headings: drag the rows, or use
 * the arrows from the keyboard. A space belongs to the heading above it.
 * Opened with openArrangeSpaces().
 */
export function ArrangeSpacesDialog() {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Row[]>([])
  const [start, setStart] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)
  const [focusId, setFocusId] = useState<number | null>(null)
  const { data: spaces } = useSpaces()
  const { data: sections, refetch } = useSpaceSections()
  const arrange = useArrangeSpaces()
  const latest = useRef({ spaces, sections })
  latest.current = { spaces, sections }

  useEffect(
    () =>
      onUiEvent("quire:arrange-spaces", () => {
        void refetch().then(({ data }) => {
          const r = rowsFor(latest.current.spaces ?? [], data ?? latest.current.sections ?? [])
          setRows(r)
          setStart(r)
          setOpen(true)
        })
      }),
    [refetch],
  )

  // Spaces created or deleted elsewhere while this is open join or leave the list.
  const byName = new Map((spaces ?? []).map((s) => [s.name, s]))
  const list: Row[] = [
    ...(spaces ?? []).filter((s) => !rows.some((r) => r.kind === "space" && r.name === s.name)).map((s) => ({ kind: "space" as const, name: s.name })),
    ...rows.filter((r) => r.kind === "section" || byName.has(r.name)),
  ]
  const headings = list.filter((r) => r.kind === "section")
  const badName = headings.find(
    (r) => !r.name.trim() || r.name.trim().length > MAX_NAME || headings.some((o) => o !== r && o.name.trim().toLowerCase() === r.name.trim().toLowerCase()),
  )
  const changed = !sameLayout(list, start)
  const { boxRef, ghostRef, drag, start: startDrag } = useListDrag((from, to) => setRows(moveItem(list, from, to)))
  const dragged = drag ? list[drag.from] : undefined

  const addSection = () => {
    const id = nextId++
    let name = "New section"
    for (let n = 2; headings.some((h) => h.name.trim().toLowerCase() === name.toLowerCase()); n++) name = `New section ${n}`
    setRows([...list, { kind: "section", id, name }])
    setFocusId(id)
  }
  const rename = (id: number, name: string) => setRows(list.map((r) => (r.kind === "section" && r.id === id ? { ...r, name } : r)))
  const removeSection = (id: number) => setRows(list.filter((r) => !(r.kind === "section" && r.id === id)))

  const save = async () => {
    const { names, sections: secs } = layoutOf(list)
    setBusy(true)
    const ok = await arrange(names, secs)
    setBusy(false)
    if (ok) setOpen(false)
  }

  const label = (r: Row) => (r.kind === "space" ? r.name : `section ${r.name || "(no name)"}`)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Arrange spaces</DialogTitle>
          <DialogDescription>
            Drag a space to its place, or use the arrows. A space belongs to the section heading above it. The space menu and Home list them this way.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 max-h-[min(28rem,60dvh)] overflow-y-auto px-1">
          <div ref={boxRef} role="list" aria-label="Spaces and sections" className="relative flex flex-col gap-px">
            {list.map((r, i) => {
              const sp = r.kind === "space" ? byName.get(r.name) : undefined
              return (
                <div
                  key={r.kind === "space" ? `s:${r.name}` : `h:${r.id}`}
                  role="listitem"
                  data-index={i}
                  onPointerDown={(e) => startDrag(e, i)}
                  className={cn(
                    "flex h-10 items-center gap-2.5 rounded-md pr-1 pl-1 select-none [-webkit-touch-callout:none]",
                    !drag && "hover:bg-accent/60",
                    drag?.from === i && "opacity-40",
                    r.kind === "section" && i > 0 && "mt-2",
                  )}
                >
                  <span data-grip className="grid h-8 w-5 shrink-0 cursor-grab touch-none place-items-center text-muted-foreground">
                    <GripVertical className="size-4" />
                  </span>
                  {r.kind === "space" ? (
                    <>
                      <SpaceAvatar name={r.name} color={sp?.color} icon={sp?.icon} />
                      <span className={cn("min-w-0 flex-1 truncate text-sm", headings.length > 0 && list.findIndex((x) => x.kind === "section") < i && "pl-1")}>{r.name}</span>
                    </>
                  ) : (
                    <>
                      <Heading className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <input
                        data-nodrag
                        value={r.name}
                        maxLength={MAX_NAME}
                        aria-label="Section name"
                        aria-invalid={badName === r || undefined}
                        ref={(el) => {
                          if (el && focusId === r.id) {
                            el.focus()
                            el.select()
                            setFocusId(null)
                          }
                        }}
                        onChange={(e) => rename(r.id, e.target.value)}
                        className="min-w-0 flex-1 rounded-sm border-0 bg-transparent px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:ring-2 aria-invalid:ring-destructive"
                      />
                    </>
                  )}
                  <span data-nodrag className="flex shrink-0 items-center">
                    {r.kind === "section" && (
                      <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`Remove ${label(r)}`} onClick={() => removeSection(r.id)}>
                        <X />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      aria-label={`Move ${label(r)} up`}
                      disabled={i === 0}
                      onClick={() => setRows(moveItem(list, i, i - 1))}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      aria-label={`Move ${label(r)} down`}
                      disabled={i === list.length - 1}
                      onClick={() => setRows(moveItem(list, i, i + 1))}
                    >
                      <ArrowDown />
                    </Button>
                  </span>
                </div>
              )
            })}
            {drag?.line != null && <DropLine top={drag.line} />}
          </div>
        </div>
        {dragged && (
          <DragGhost ghostRef={ghostRef}>
            {dragged.kind === "space" ? (
              <SpaceAvatar name={dragged.name} color={byName.get(dragged.name)?.color} icon={byName.get(dragged.name)?.icon} className="size-5 text-[0.55rem]" />
            ) : (
              <Heading className="size-4" />
            )}
            <span className="truncate">{dragged.name}</span>
          </DragGhost>
        )}
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={addSection} disabled={headings.length >= 50}>
          <Plus /> Add section
        </Button>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!changed || busy || !!badName} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
