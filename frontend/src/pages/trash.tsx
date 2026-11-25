import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { FileX, FileText, History, LayoutGrid, Paperclip, RotateCcw, Trash2 } from "lucide-react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { useDialogs } from "@/components/dialogs"
import { HistoryDialog } from "@/components/history-dialog"
import { Page } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/hooks/use-vault"
import { api, type DeletedPage, type TrashItem } from "@/lib/api"
import { folderOf, pageUrl, relativeTime, spaceUrl, titleOf } from "@/lib/notes"

export default function TrashPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { confirm } = useDialogs()
  const { data, isLoading } = useQuery({ queryKey: ["trash"], queryFn: api.trash })
  const items = data?.items ?? []

  const refresh = () => {
    for (const key of ["trash", "tree", "spaces", "graph", "tags", "note", "attachments", "deleted-pages"]) qc.invalidateQueries({ queryKey: [key] })
  }

  const restore = async (it: TrashItem) => {
    try {
      const res = await api.restoreTrash(it.id)
      refresh()
      const to = res.space ? spaceUrl(res.space) : res.page ? pageUrl(res.page) : null
      toast.success(`Restored “${res.path.split("/").pop()}”`, to ? { action: { label: "Open", onClick: () => navigate(to) } } : undefined)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const purge = async (it?: TrashItem) => {
    const ok = await confirm({
      title: it ? `Delete “${it.path.split("/").pop()}” forever?` : "Empty the trash?",
      description: "This can't be undone. The files are removed from your vault.",
      confirm: it ? "Delete forever" : "Empty trash",
      destructive: true,
    })
    if (!ok) return
    try {
      await (it ? api.purgeTrash(it.id) : api.emptyTrash())
      refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <Page>
      <div className="mx-auto w-full max-w-4xl px-6 py-10 sm:px-10 md:py-14">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-[-0.02em]">Trash</h1>
            <p className="mt-1 text-sm text-muted-foreground">Deleted pages, spaces and attachments stay here for {data?.retentionDays ?? 30} days, then they're removed for good.</p>
          </div>
          {items.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => void purge()}>
              <Trash2 /> Empty trash
            </Button>
          )}
        </div>
        <div className="mt-8">
          {isLoading ? (
            <Skeleton className="h-40 rounded-lg" />
          ) : !items.length ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Trash2 />
                </EmptyMedia>
                <EmptyTitle>The trash is empty</EmptyTitle>
                <EmptyDescription>Deleted pages show up here, ready to restore.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="divide-y rounded-lg border">
              {items.map((it) => {
                const parts = it.path.split("/")
                const Icon = it.kind === "space" ? LayoutGrid : it.kind === "attachment" ? Paperclip : FileText
                return (
                  <div key={it.id} className="flex items-center gap-3 px-4 py-3">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{parts.at(-1)}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {it.kind === "space" ? "Space" : it.kind === "attachment" ? "Attachment" : `In ${parts.slice(0, -1).join(" / ")}`}
                        {it.pages > 1 ? ` · ${it.pages} pages` : ""} · deleted {relativeTime(it.deletedAt)}
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => void restore(it)}>
                      <RotateCcw /> Restore
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label="Delete forever" onClick={() => void purge(it)}>
                      <Trash2 />
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <DeletedOutside />
      </div>
    </Page>
  )
}

/**
 * Pages removed from the notes folder by something other than Quire. Their
 * history stays, so the last version (or any other) can come back.
 */
function DeletedOutside() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data } = useQuery({ queryKey: ["deleted-pages"], queryFn: api.deletedPages })
  const [viewing, setViewing] = useState("")
  if (!data?.length) return null

  const opened = (path: string) => {
    for (const key of ["deleted-pages", "tree", "spaces", "graph", "tags", "note", "attachments"]) qc.invalidateQueries({ queryKey: [key] })
    toast.success(`Restored “${titleOf(path)}”`, { action: { label: "Open", onClick: () => navigate(pageUrl(path)) } })
  }
  const restore = async (d: DeletedPage) => {
    try {
      await api.restoreRevision(d.latest)
      opened(d.path)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <section className="mt-12">
      <h2 className="text-sm font-semibold">Deleted outside Quire</h2>
      <p className="mt-1 mb-3 text-[0.8125rem] text-muted-foreground">
        These pages left the notes folder without going through Quire: deleted, or moved or renamed by another app. Their history is kept until you restore them.
      </p>
      <div className="divide-y rounded-lg border">
        {data.map((d) => (
          <div key={d.path} className="flex items-center gap-3 px-4 py-3">
            <FileX className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{titleOf(d.path)}</div>
              <div className="truncate text-xs text-muted-foreground">
                In {folderOf(d.path).split("/").join(" / ")} · last version {relativeTime(d.updated)} · {d.versions === 1 ? "1 version" : `${d.versions} versions`}
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setViewing(d.path)}>
              <History /> History
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void restore(d)}>
              <RotateCcw /> Restore
            </Button>
          </div>
        ))}
      </div>
      <HistoryDialog path={viewing} open={!!viewing} onOpenChange={(o) => !o && setViewing("")} onRestored={() => opened(viewing)} />
    </section>
  )
}
