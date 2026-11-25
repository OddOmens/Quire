import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"
import { History, Loader2, RotateCcw } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { PageEditor } from "@/editor/page-editor"
import { errorMessage, useResolver } from "@/hooks/use-vault"
import { api, fileUrl, type Note } from "@/lib/api"
import { splitFrontmatter } from "@/lib/markdown"
import { titleOf } from "@/lib/notes"

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : "numeric" })
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
const sourceLabel: Record<string, string> = {
  edit: "Edited",
  restore: "Restored",
  earlier: "Earlier version",
  disk: "Changed outside Quire",
  conflict: "Kept after a conflict",
  import: "Imported",
}

/** Earlier versions of a page, with a preview and restore. */
export function HistoryDialog({ path, open, onOpenChange, onRestored }: { path: string; open: boolean; onOpenChange: (o: boolean) => void; onRestored: (n: Note) => void }) {
  const { data: revisions, isLoading } = useQuery({ queryKey: ["history", path], queryFn: () => api.history(path), enabled: open })
  const [selected, setSelected] = useState<number | null>(null)
  const { data: rev, isFetching } = useQuery({ queryKey: ["revision", selected], queryFn: () => api.revision(selected!), enabled: open && selected !== null })
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const resolver = useResolver()

  useEffect(() => {
    if (open && revisions?.length && (selected === null || !revisions.some((r) => r.id === selected))) setSelected(revisions[0].id)
  }, [open, revisions, selected])

  const groups = useMemo(() => {
    const out: [string, NonNullable<typeof revisions>][] = []
    for (const r of revisions ?? []) {
      const d = day(r.updated)
      if (out.at(-1)?.[0] === d) out.at(-1)![1].push(r)
      else out.push([d, [r]])
    }
    return out
  }, [revisions])

  const restore = async () => {
    if (selected === null) return
    setBusy(true)
    try {
      const note = await api.restoreRevision(selected)
      qc.setQueryData(["note", path], note)
      qc.invalidateQueries({ queryKey: ["history", path] })
      onRestored(note)
      onOpenChange(false)
      toast.success("Version restored")
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(44rem,88vh)] flex-col gap-0 p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Page history</DialogTitle>
          <DialogDescription>Versions of “{titleOf(path)}”. Saves within a few minutes of each other are grouped.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="grid flex-1 place-items-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : !revisions?.length ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <History />
              </EmptyMedia>
              <EmptyTitle>No history yet</EmptyTitle>
              <EmptyDescription>Versions appear here once you edit this page.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex min-h-0 flex-1 max-sm:flex-col">
            <div className="shrink-0 overflow-y-auto border-r bg-surface p-2 max-sm:max-h-40 max-sm:border-r-0 max-sm:border-b sm:w-64">
              {groups.map(([d, list]) => (
                <div key={d} className="mb-2">
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{d}</div>
                  {list.map((r, i) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelected(r.id)}
                      className={cn(
                        "flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                        r.id === selected && "bg-accent",
                      )}
                    >
                      <span className="font-medium">
                        {time(r.updated)}
                        {groups[0][1] === list && i === 0 && <span className="ml-2 text-xs font-normal text-brand">Current</span>}
                      </span>
                      <span className="text-xs text-muted-foreground">{sourceLabel[r.source] ?? r.source}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
                {rev && rev.id === selected ? (
                  <PageEditor
                    key={rev.id}
                    markdown={splitFrontmatter(rev.content ?? "")[1]}
                    editable={false}
                    compact
                    env={{ path, resolver, pages: [], linkMode: "plain", fileUrl, openLink: () => {}, openTag: () => {}, upload: async () => undefined }}
                  />
                ) : (
                  isFetching && <Loader2 className="mx-auto mt-10 size-5 animate-spin text-muted-foreground" />
                )}
              </div>
              <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
                <Button onClick={() => void restore()} disabled={busy || selected === revisions[0]?.id}>
                  <RotateCcw /> Restore this version
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
