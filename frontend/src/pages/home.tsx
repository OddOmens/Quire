import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { Link } from "react-router"

import { Page } from "@/components/page-header"
import { RecentList } from "@/components/recent-list"
import { SpaceAvatar } from "@/components/space-avatar"
import { Skeleton } from "@/components/ui/skeleton"
import { useSpaces, useTree } from "@/hooks/use-vault"
import { api, type Space } from "@/lib/api"
import { relativeTime, spaceUrl } from "@/lib/notes"
import { openSpaceDialog } from "@/lib/ui-events"

function greeting() {
  const h = new Date().getHours()
  if (h < 5) return "Good evening"
  if (h < 12) return "Good morning"
  if (h < 18) return "Good afternoon"
  return "Good evening"
}

function SpaceCard({ space: s }: { space: Space }) {
  return (
    <Link to={spaceUrl(s.name)} className="group flex flex-col rounded-lg border p-4 transition-colors hover:bg-accent/50">
      <div className="flex items-center gap-3">
        <SpaceAvatar name={s.name} color={s.color} icon={s.icon} className="size-9 rounded-lg text-xs" />
        <div className="min-w-0">
          <div className="truncate font-semibold">{s.name}</div>
          <div className="text-xs text-muted-foreground">
            {s.pages} {s.pages === 1 ? "page" : "pages"}
            {s.updated ? ` · updated ${relativeTime(s.updated)}` : ""}
          </div>
        </div>
      </div>
      {s.description && <p className="mt-3 line-clamp-2 text-[0.8125rem] text-muted-foreground">{s.description}</p>}
    </Link>
  )
}

export default function HomePage() {
  const { data: spaces, isLoading } = useSpaces()
  const { data: tree } = useTree()
  const { data: account } = useQuery({ queryKey: ["account"], queryFn: api.account })
  const recent = useMemo(() => [...(tree?.notes ?? [])].sort((a, b) => b.mtime - a.mtime).slice(0, 12), [tree])
  const first = account?.name.split(" ")[0]
  // Spaces under no heading first, then each section's, in the menu's order.
  const loose = (spaces ?? []).filter((s) => !s.section)
  const groups = useMemo(() => {
    const out: [string, Space[]][] = []
    for (const s of spaces ?? []) {
      if (!s.section) continue
      if (out.at(-1)?.[0] === s.section) out.at(-1)![1].push(s)
      else out.push([s.section, [s]])
    }
    return out
  }, [spaces])

  return (
    <Page>
      <div className="mx-auto w-full max-w-5xl px-6 py-10 sm:px-10 md:py-14">
        <h1 className="text-2xl font-bold tracking-[-0.02em]">
          {greeting()}
          {first ? `, ${first}` : ""}
        </h1>

        <div className="mt-10 mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Spaces</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {isLoading ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-28 rounded-lg" />) : loose.map((s) => <SpaceCard key={s.name} space={s} />)}
          <button
            type="button"
            onClick={() => openSpaceDialog()}
            className="flex min-h-[5.5rem] items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            <Plus className="size-4" /> New space
          </button>
        </div>
        {groups.map(([section, list]) => (
          <section key={section} aria-label={section}>
            <h2 className="mt-8 mb-3 text-sm font-semibold">{section}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((s) => (
                <SpaceCard key={s.name} space={s} />
              ))}
            </div>
          </section>
        ))}

        <h2 className="mt-12 mb-3 text-sm font-semibold">Recently updated</h2>
        {tree ? <RecentList notes={recent} spaces={spaces} /> : <Skeleton className="h-64 rounded-lg" />}
      </div>
    </Page>
  )
}
