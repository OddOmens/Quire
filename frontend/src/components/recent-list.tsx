import { FileText } from "lucide-react"
import { Link } from "react-router"

import { SpaceAvatar } from "@/components/space-avatar"
import type { NoteMeta, Space } from "@/lib/api"
import { baseOf, pageUrl, relativeTime } from "@/lib/notes"

/** Recently updated pages, as a quiet table. */
export function RecentList({ notes, spaces, showSpace = true }: { notes: NoteMeta[]; spaces?: Space[]; showSpace?: boolean }) {
  if (!notes.length) return <p className="py-6 text-sm text-muted-foreground">Nothing here yet.</p>
  return (
    <div className="divide-y rounded-lg border">
      {notes.map((n) => {
        const parts = baseOf(n.path).split("/")
        const sp = spaces?.find((s) => s.name === parts[0])
        const parent = parts.slice(1, -1).join(" / ")
        return (
          <Link key={n.path} to={pageUrl(n.path)} className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-accent/60">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{n.title}</div>
              {(parent || n.excerpt) && <div className="truncate text-xs text-muted-foreground">{parent ? `In ${parent}` : n.excerpt}</div>}
            </div>
            {showSpace && sp && (
              <span className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                <SpaceAvatar name={sp.name} color={sp.color} icon={sp.icon} className="size-4 rounded text-[0.45rem]" />
                {sp.name}
              </span>
            )}
            <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{relativeTime(n.mtime)}</span>
          </Link>
        )
      })}
    </div>
  )
}
