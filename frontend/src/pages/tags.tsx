import { useQuery } from "@tanstack/react-query"
import { ArrowRight, Folder, Hash } from "lucide-react"
import { Link, useParams } from "react-router"

import { Page } from "@/components/page-header"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import { pageUrl } from "@/lib/notes"

export default function TagsPage() {
  const { tag } = useParams()
  const { data: tags, isLoading } = useQuery({ queryKey: ["tags"], queryFn: api.tags })
  const { data: notes } = useQuery({ queryKey: ["search", `#${tag}`], queryFn: () => api.search(`#${tag}`, 100), enabled: !!tag })
  const max = Math.max(1, ...(tags ?? []).map((t) => t.count))

  return (
    <Page
      header={
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Hash className="size-4 text-muted-foreground" /> {tag ? <>Tags <span className="text-muted-foreground">/</span> {tag}</> : "Tags"}
        </span>
      }
    >
      <div className="mx-auto w-full max-w-4xl px-6 py-10 sm:px-10 md:py-14">
        <h1 className="text-2xl font-bold tracking-[-0.02em]">{tag ? `#${tag}` : "Tags"}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {tag ? `${notes?.length ?? "…"} pages tagged #${tag}, including nested tags.` : "Add a tag anywhere on a page by typing # and a word."}
        </p>

        <div className="mt-8 flex flex-wrap gap-2">
          {isLoading && Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-8 w-20 rounded-full" />)}
          {tags?.map((t) => (
            <Link
              key={t.tag}
              to={`/tags/${encodeURIComponent(t.tag)}`}
              data-active={t.tag === tag}
              className="rounded-full border bg-card px-3 py-1.5 text-sm transition-all hover:border-tag/40 data-[active=true]:border-transparent data-[active=true]:bg-tag data-[active=true]:text-background"
              style={{ fontSize: `${0.8 + (t.count / max) * 0.25}rem` }}
            >
              <span className="opacity-60">#</span>
              {t.tag}
              <span className="ml-1.5 text-xs opacity-60 tabular-nums">{t.count}</span>
            </Link>
          ))}
        </div>

        {tags && !tags.length && (
          <Empty className="mt-10 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Hash />
              </EmptyMedia>
              <EmptyTitle>No tags yet</EmptyTitle>
              <EmptyDescription>Write #ideas or #work on any page and it shows up here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {tag && (
          <div className="mt-10 grid gap-2">
            {notes?.map((n) => (
              <Link
                key={n.path}
                to={pageUrl(n.path)}
                className="group flex items-center gap-4 rounded-lg border px-4 py-3 transition-colors hover:bg-accent/60"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium tracking-tight">{n.title}</div>
                  <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{n.snippet}</p>
                </div>
                {n.folder && (
                  <span className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground sm:flex">
                    <Folder className="size-3" /> {n.folder}
                  </span>
                )}
                <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
          </div>
        )}
      </div>
    </Page>
  )
}
