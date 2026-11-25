import { useQuery } from "@tanstack/react-query"
import { Loader2, Unlink } from "lucide-react"
import { cn } from "cn"
import { useParams } from "react-router"

import { Logo } from "@/components/brand"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { PageEditor } from "@/editor/page-editor"
import { api, publicFileUrl } from "@/lib/api"
import { frontmatterField, splitFrontmatter } from "@/lib/markdown"
import { Resolver } from "@/lib/notes"

const noResolver = new Resolver([])

/** A page someone shared: read-only, no account needed. */
export default function SharePage() {
  const { token = "" } = useParams()
  const { data, isLoading, error } = useQuery({ queryKey: ["public", token], queryFn: () => api.publicPage(token), retry: false })

  return (
    <div className="min-h-svh bg-background">
      <header className="flex h-12 items-center gap-2 border-b px-4">
        <Logo className="size-5" />
        <span className="truncate text-sm font-medium">{data?.title ?? "Shared page"}</span>
      </header>
      {isLoading ? (
        <div className="grid h-[60vh] place-items-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : error || !data ? (
        <Empty className="h-[70vh]">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Unlink />
            </EmptyMedia>
            <EmptyTitle>This link doesn't work</EmptyTitle>
            <EmptyDescription>The page may have been unshared or deleted.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <article
          className={cn(
            "mx-auto w-full px-6 pt-12 pb-20 sm:px-10",
            frontmatterField(data.content, "width") === "full" ? "max-w-none sm:px-14" : "max-w-[48rem]",
          )}
        >
          <h1 className="mb-2 text-[2.25rem] leading-tight font-bold tracking-[-0.025em] break-words">{data.title}</h1>
          <p className="mb-8 text-sm text-muted-foreground">Updated {new Date(data.updated).toLocaleDateString(undefined, { dateStyle: "long" })}</p>
          <PageEditor
            markdown={splitFrontmatter(data.content)[1]}
            editable={false}
            compact
            env={{
              path: "",
              resolver: noResolver,
              pages: [],
              linkMode: "plain",
              fileUrl: publicFileUrl(token),
              openLink: () => {},
              openTag: () => {},
              upload: async () => undefined,
            }}
          />
        </article>
      )}
    </div>
  )
}
