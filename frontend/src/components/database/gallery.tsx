import { Plus } from "lucide-react"

import { coverOf, opener, RowCard } from "@/components/database/card"
import type { ViewProps } from "@/components/database/types"

/** Rows as cards in a grid, with the first picture as a cover. */
export function GalleryView({ data, view, rows, editable, openRow, table }: ViewProps) {
  // Covers only when some row has a picture, so text-only galleries stay compact.
  const covers = rows.map((r) => coverOf(data, view, r))
  const withCovers = covers.some(Boolean)
  const add = async () => {
    const ids = await table.addRows()
    if (ids[0]) openRow(data.path, ids[0])
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-3 pb-4">
      {rows.map((r, i) => (
        <div key={r.id} {...opener(() => openRow(data.path, r.id))} className="block cursor-pointer rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <RowCard data={data} view={view} row={r} cover={withCovers ? covers[i] : undefined} openRow={openRow} className="h-full" />
        </div>
      ))}
      {editable && (
        <button
          type="button"
          onClick={() => void add()}
          className="flex min-h-24 items-center justify-center gap-1.5 rounded-lg border border-dashed text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-4" /> New
        </button>
      )}
      {!editable && rows.length === 0 && <p className="col-span-full py-8 text-center text-sm text-muted-foreground">No rows to show.</p>}
    </div>
  )
}
