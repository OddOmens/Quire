import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { FilePlus2, LayoutGrid, Link2Off, Settings2 } from "lucide-react"
import { Link, useParams } from "react-router"

import { Page } from "@/components/page-header"
import { RecentList } from "@/components/recent-list"
import { SpaceAvatar } from "@/components/space-avatar"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { useSpaces, useTree, useVaultActions } from "@/hooks/use-vault"
import { api } from "@/lib/api"
import { pageUrl, spaceOf, spaceSettingsUrl } from "@/lib/notes"

export default function SpacePage() {
  const { space: name = "" } = useParams()
  const { data: spaces, isLoading } = useSpaces()
  const { data: tree } = useTree()
  const actions = useVaultActions()
  const space = spaces?.find((s) => s.name === name)
  const recent = useMemo(
    () => (tree?.notes ?? []).filter((n) => spaceOf(n.path) === name).sort((a, b) => b.mtime - a.mtime).slice(0, 15),
    [tree, name],
  )

  if (!isLoading && !space) {
    return (
      <Page>
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutGrid />
            </EmptyMedia>
            <EmptyTitle>No space called “{name}”</EmptyTitle>
            <EmptyDescription>It may have been renamed or deleted.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild variant="outline">
              <Link to="/">All spaces</Link>
            </Button>
          </EmptyContent>
        </Empty>
      </Page>
    )
  }

  return (
    <Page>
      <div className="mx-auto w-full max-w-4xl px-6 py-10 sm:px-10 md:py-14">
        {space ? (
          <div className="flex flex-wrap items-start gap-4">
            <SpaceAvatar name={space.name} color={space.color} icon={space.icon} className="size-12 rounded-xl text-base" />
            {/* On a phone the name gets the row to itself and the buttons go under it. */}
            <div className="min-w-0 flex-1 max-sm:basis-[calc(100%-4rem)]">
              <h1 className="truncate text-2xl font-bold tracking-[-0.02em]">{space.name}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {space.description || `${space.pages} ${space.pages === 1 ? "page" : "pages"}`}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link to={spaceSettingsUrl(space.name)}>
                  <Settings2 /> Settings
                </Link>
              </Button>
              <Button size="sm" onClick={() => void actions.createPage(space.name)}>
                <FilePlus2 /> New page
              </Button>
            </div>
          </div>
        ) : (
          <Skeleton className="h-12 w-72" />
        )}

        <h2 className="mt-12 mb-3 text-sm font-semibold">Recently updated</h2>
        {tree && recent.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>This space is empty</EmptyTitle>
              <EmptyDescription>Create the first page to get started.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="sm" onClick={() => void actions.createPage(name)}>
                <FilePlus2 /> New page
              </Button>
            </EmptyContent>
          </Empty>
        ) : tree ? (
          <RecentList notes={recent} showSpace={false} />
        ) : (
          <Skeleton className="h-64 rounded-lg" />
        )}

        {space && <MissingLinks space={space.name} />}
      </div>
    </Page>
  )
}

/** [[Links]] in this space to pages that don't exist yet, each with a way to create it. */
function MissingLinks({ space }: { space: string }) {
  const { data } = useQuery({ queryKey: ["missing-links", space], queryFn: () => api.missingLinks(space) })
  const actions = useVaultActions()
  if (!data?.length) return null
  return (
    <section>
      <h2 className="mt-12 mb-3 flex items-baseline gap-1.5 text-sm font-semibold">
        Links to missing pages <span className="text-xs font-normal text-muted-foreground tabular-nums">{data.length}</span>
      </h2>
      <div className="divide-y rounded-lg border">
        {data.map((m) => (
          <div key={m.target} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <Link2Off className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium underline decoration-muted-foreground decoration-dashed underline-offset-4">{m.target}</div>
              <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                From{" "}
                {m.pages.map((p, i) => (
                  <span key={p.path}>
                    {i > 0 && ", "}
                    <Link to={pageUrl(p.path)} className="hover:text-foreground hover:underline">
                      {p.title}
                    </Link>
                  </span>
                ))}
              </div>
            </div>
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => void actions.openLink(m.target, m.pages[0].path)}>
              <FilePlus2 /> Create page
            </Button>
          </div>
        ))}
      </div>
    </section>
  )
}
