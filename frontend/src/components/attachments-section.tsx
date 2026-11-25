import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { File as FileIcon, Pencil, Trash2 } from "lucide-react"
import { Link, useNavigate } from "react-router"
import { toast } from "sonner"

import { useDialogs } from "@/components/dialogs"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { errorMessage } from "@/hooks/use-vault"
import { api, fileUrl, type Attachment } from "@/lib/api"
import { formatBytes, pageUrl, relativeTime, titleOf } from "@/lib/notes"

const imageExt = /\.(png|jpe?g|gif|webp|avif|svg)$/i

const unused = (a: Attachment) => !a.pages.length && !a.trashed.length
const nameOf = (p: string) => p.split("/").pop()!

/** Settings → Attachments: every file in attachments/, where it's used, and tidying up the unused ones. */
export function AttachmentsSection() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { confirm, prompt } = useDialogs()
  const { data } = useQuery({ queryKey: ["attachments"], queryFn: api.attachments })
  const [onlyUnused, setOnlyUnused] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const items = useMemo(() => data?.items ?? [], [data])
  const spare = items.filter(unused)
  const shown = onlyUnused ? spare : items
  // Only files still listed as unused can be picked.
  const picked = spare.filter((a) => selected.has(a.path))

  const refresh = () => {
    for (const key of ["attachments", "trash", "note", "tree"]) qc.invalidateQueries({ queryKey: [key] })
  }

  const toggle = (path: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s)
      if (on) next.add(path)
      else next.delete(path)
      return next
    })

  const trash = async () => {
    const ok = await confirm({
      title: picked.length === 1 ? `Move “${nameOf(picked[0].path)}” to the trash?` : `Move ${picked.length} attachments to the trash?`,
      description: "No page uses them. You can restore them from the trash until it's emptied.",
      confirm: "Move to trash",
      destructive: true,
    })
    if (!ok) return
    try {
      const res = await api.trashAttachments(picked.map((a) => a.path))
      setSelected(new Set())
      refresh()
      if (res.trashed.length)
        toast.success(`Moved ${res.trashed.length === 1 ? "1 attachment" : `${res.trashed.length} attachments`} to the trash`, {
          action: { label: "Open trash", onClick: () => navigate("/trash") },
        })
      if (res.kept.length) toast.warning(`Kept ${res.kept.length}: ${res.kept[0].reason}`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const rename = async (a: Attachment) => {
    const name = await prompt({
      title: "Rename attachment",
      description: a.pages.length + a.trashed.length ? "Links to it on your pages are updated." : undefined,
      defaultValue: nameOf(a.path),
      selectUntil: nameOf(a.path).lastIndexOf(".") > 0 ? nameOf(a.path).lastIndexOf(".") : undefined,
      confirm: "Rename",
    })
    if (!name || name === nameOf(a.path)) return
    try {
      const res = await api.renameAttachment(a.path, name)
      setSelected(new Set())
      refresh()
      toast.success(`Renamed to “${nameOf(res.path)}”`, {
        description: res.updated.length ? `Updated ${res.updated.length === 1 ? "1 page" : `${res.updated.length} pages`}.` : undefined,
      })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  if (!data) return <Skeleton className="my-7 h-40 rounded-lg" />

  return (
    <div className="grid gap-4 py-7">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-sm">
          {items.length === 1 ? "1 attachment" : `${items.length} attachments`}
          <span className="text-muted-foreground"> · {formatBytes(data.total)}</span>
        </p>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch size="sm" checked={onlyUnused} onCheckedChange={setOnlyUnused} />
          Unused only <span className="tabular-nums">({spare.length})</span>
        </label>
        <Button variant="outline" size="sm" className="ml-auto" disabled={!picked.length} onClick={() => void trash()}>
          <Trash2 /> Move {picked.length || ""} to trash
        </Button>
      </div>

      {!shown.length ? (
        <p className="text-sm text-muted-foreground">{onlyUnused ? "Every attachment is used by a page." : "No attachments yet. Paste or drop a file on a page to add one."}</p>
      ) : (
        <div className="divide-y rounded-lg border">
          {shown.map((a) => (
            <div key={a.path} className="flex items-center gap-3 px-4 py-2.5">
              <input
                type="checkbox"
                aria-label={`Select ${nameOf(a.path)}`}
                className="size-4 shrink-0 accent-primary disabled:opacity-30"
                disabled={!unused(a)}
                checked={unused(a) && selected.has(a.path)}
                onChange={(e) => toggle(a.path, e.target.checked)}
              />
              <a href={fileUrl(a.path)} target="_blank" rel="noreferrer" className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-md border bg-muted">
                {imageExt.test(a.path) ? <img src={fileUrl(a.path)} alt="" loading="lazy" className="size-full object-cover" /> : <FileIcon className="size-4 text-muted-foreground" />}
              </a>
              <div className="min-w-0 flex-1">
                <a href={fileUrl(a.path)} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium hover:underline">
                  {a.path.replace(/^attachments\//, "")}
                </a>
                <div className="truncate text-xs text-muted-foreground">
                  {formatBytes(a.size)} · {relativeTime(a.mtime)} · <Uses a={a} />
                </div>
              </div>
              <Button variant="ghost" size="icon-sm" aria-label={`Rename ${nameOf(a.path)}`} onClick={() => void rename(a)}>
                <Pencil />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Where an attachment is used: page links, then pages in the trash. */
function Uses({ a }: { a: Attachment }) {
  if (unused(a)) return <span>Not used{a.history && " · may appear in old versions of a page"}</span>
  return (
    <>
      {a.pages.length > 0 && (
        <span>
          Used on{" "}
          {a.pages.map((p, i) => (
            <span key={p}>
              {i > 0 && ", "}
              <Link to={pageUrl(p)} className="hover:text-foreground hover:underline">
                {titleOf(p)}
              </Link>
            </span>
          ))}
        </span>
      )}
      {a.pages.length > 0 && a.trashed.length > 0 && " · "}
      {a.trashed.length > 0 && <span>In the trash on {a.trashed.map(titleOf).join(", ")}</span>}
    </>
  )
}
