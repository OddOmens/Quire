import { lazy, Suspense, useContext } from "react"
import { useQuery } from "@tanstack/react-query"
import { NodeViewWrapper, useEditorState, type ReactNodeViewProps } from "@tiptap/react"
import { cn } from "cn"
import { ArrowUpRight, FileQuestion, FileText, Repeat2, Table2 } from "lucide-react"

import { Skeleton } from "@/components/ui/skeleton"
import { embedHost } from "@/editor/embed-host"
import type { EditorEnv } from "@/editor/extensions"
import { EditorEnvContext } from "@/editor/views"
import { api } from "@/lib/api"
import { splitFrontmatter } from "@/lib/markdown"
import { headings, slugify, titleOf } from "@/lib/notes"

// Databases bring their grid, board, calendar and chart; only pages that embed one load them.
const DatabaseView = lazy(() => import("@/components/database/database-view").then((m) => ({ default: m.DatabaseView })))

/** How many pages deep embeds go: a page in a page in a page. */
const MAX_DEPTH = 3

/** The part of a page under one heading, up to the next heading of the same or a higher level. */
export function sectionOf(markdown: string, heading: string) {
  const lines = markdown.split("\n")
  const all = headings(markdown)
  const want = slugify(heading)
  const i = all.findIndex((h) => slugify(h.text) === want)
  if (i < 0) return null
  const h = all[i]
  if (h.toggle) {
    // A toggle heading: everything inside its <details>.
    let depth = 0
    for (let l = h.line - 1; l < lines.length; l++) {
      if (/^\s*<details\b/i.test(lines[l])) depth++
      if (/^\s*<\/details>/i.test(lines[l]) && --depth === 0) return lines.slice(h.line - 1, l + 1).join("\n")
    }
    return lines.slice(Math.max(0, h.line - 1)).join("\n")
  }
  const next = all.slice(i + 1).find((n) => n.level <= h.level)
  // A toggle heading's line is its <summary>; its <details> opens the line before.
  return lines.slice(h.line, next ? next.line - (next.toggle ? 1 : 0) : undefined).join("\n")
}

function EmbedBody({ path, heading, env, stack, editable }: { path: string; heading: string; env: EditorEnv; stack: string[]; editable: boolean }) {
  const { data: note, error, isLoading } = useQuery({ queryKey: ["note", path], queryFn: () => api.note(path) })
  if (isLoading) {
    return (
      <div className="grid gap-2 py-1">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    )
  }
  if (error || !note) return <p className="embed-note">This page couldn't be loaded.</p>
  if (note.kind === "database" && !heading) {
    return (
      <Suspense fallback={<Skeleton className="h-40 w-full" />}>
        <DatabaseView path={path} editable={editable} embedded />
      </Suspense>
    )
  }
  const body = splitFrontmatter(note.content)[1]
  const part = heading ? sectionOf(body, heading) : body
  if (part === null) return <p className="embed-note">“{heading}” isn't a heading on that page any more.</p>
  if (!part.trim()) return <p className="embed-note">This page is empty.</p>
  const Editor = embedHost.Editor
  if (!Editor) return null
  return <Editor markdown={part} editable={false} compact env={{ ...env, path, embedStack: [...stack, path] }} />
}

/** ![[Page]]: the page, a section of it, or its database, shown in place and kept in step with the original. */
export function EmbedView({ node, editor, selected }: ReactNodeViewProps) {
  const env = useContext(EditorEnvContext)
  const editable = useEditorState({ editor, selector: ({ editor: e }) => e.isEditable })
  const { target, heading, alias } = node.attrs as { target: string; heading: string; alias: string }
  const label = alias || (heading ? `${target.split("/").pop()} › ${heading}` : target.split("/").pop())

  // Shared pages show the name only: the link doesn't cover other pages.
  if (!env || env.linkMode === "plain") {
    return (
      <NodeViewWrapper className="embed is-plain" contentEditable={false}>
        <div className="embed-head">
          <FileText className="size-4" />
          <span className="embed-title">{label}</span>
        </div>
      </NodeViewWrapper>
    )
  }

  const path = env.resolver.resolve(target, env.path)
  const stack = env.embedStack ?? [env.path]
  const why = !path
    ? `“${target}” doesn't exist yet.`
    : stack.includes(path)
      ? "This page is already shown above, so it isn't repeated here."
      : stack.length >= MAX_DEPTH
        ? "Open the page to see what it embeds."
        : ""
  const database = env.pages.find((p) => p.path === path)?.kind === "database"
  const Icon = !path ? FileQuestion : database ? Table2 : why ? Repeat2 : FileText

  return (
    <NodeViewWrapper className={cn("embed", database && "is-database", selected && editable && "is-selected")} contentEditable={false}>
      <div className="embed-head">
        <Icon className="size-4" />
        <button
          type="button"
          className="embed-title"
          title={path ? `Open ${titleOf(path)}` : undefined}
          onClick={() => env.openLink(target, heading || undefined)}
        >
          {label}
        </button>
        <button type="button" className="embed-open" aria-label="Open the page" onClick={() => env.openLink(target, heading || undefined)}>
          <ArrowUpRight className="size-4" />
        </button>
      </div>
      {why ? (
        <p className="embed-note">{why}</p>
      ) : (
        <div className="embed-body">
          <EmbedBody path={path!} heading={heading} env={env} stack={stack} editable={editable && database} />
        </div>
      )}
    </NodeViewWrapper>
  )
}
