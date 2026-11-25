import { useCallback, useEffect, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { Editor } from "@tiptap/core"
import { cn } from "cn"
import {
  Code2,
  Copy,
  Download,
  FilePlus2,
  FileQuestion,
  FileText,
  FolderInput,
  History,
  ListTree,
  MoreHorizontal,
  MoveHorizontal,
  Table2,
  Trash2,
} from "lucide-react"
import { Link, useLocation, useNavigate } from "react-router"
import { toast } from "sonner"

import { HistoryDialog } from "@/components/history-dialog"
import { PageHeader } from "@/components/page-header"
import { SecretWarningBanner, secretWarningText } from "@/components/secret-warning"
import { SharePopover } from "@/components/share-popover"
import { SpaceAvatar } from "@/components/space-avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { hasOwnHistory, historyKey, UndoRedoButtons, type HistoryControls } from "@/components/undo-redo"
import { PageEditor } from "@/editor/page-editor"
import { errorMessage, useCurrentPath, usePageTree, useResolver, useSpaces, useTree, useVaultActions } from "@/hooks/use-vault"
import { api, ApiError, fileUrl, type Note, type Outgoing } from "@/lib/api"
import { deferred } from "@/lib/deferred"
import { frontmatterField, needsSource, setFrontmatterField, splitFrontmatter } from "@/lib/markdown"
import { ancestorsOf, baseOf, headings, pageUrl, relativeTime, spaceOf, spaceUrl, titleOf } from "@/lib/notes"
import { openMoveDialog } from "@/lib/ui-events"

// Most pages need neither: the Markdown source editor (CodeMirror) and the
// database views load when a page first uses them.
const SourceEditor = deferred(() => import("@/components/source-editor").then((m) => m.SourceEditor), <Skeleton className="h-40 w-full" />)
const DatabaseView = deferred(() => import("@/components/database/database-view").then((m) => m.DatabaseView), <Skeleton className="h-40 w-full" />)

type Mode = "edit" | "read"
type Status = "saved" | "dirty" | "saving" | "error" | "conflict"

/**
 * Unsaved text kept on this device, one per page, so a closed tab or an app
 * the phone shut down doesn't lose it. Cleared once the server has it.
 */
const drafts = {
  key: (path: string) => `quire.draft:${path}`,
  get(path: string): { text: string; at: number } | null {
    try {
      const d = JSON.parse(localStorage.getItem(drafts.key(path)) ?? "null")
      return typeof d?.text === "string" && typeof d.at === "number" ? d : null
    } catch {
      return null
    }
  },
  set(path: string, text: string) {
    try {
      localStorage.setItem(drafts.key(path), JSON.stringify({ text, at: Date.now() }))
    } catch {
      // Private mode or a full quota: the server copy is all there is.
    }
  },
  clear(path: string) {
    try {
      localStorage.removeItem(drafts.key(path))
    } catch {
      // Nothing was stored.
    }
  },
}

const pref = {
  get: (key: string, def: string) => {
    try {
      return localStorage.getItem(key) ?? def
    } catch {
      return def
    }
  },
  set: (key: string, v: string) => {
    try {
      localStorage.setItem(key, v)
    } catch {
      // Not remembered in private mode.
    }
  },
}

function useMedia(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setMatch(mq.matches)
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [query])
  return match
}

export default function PageRoute() {
  const path = useCurrentPath()
  return <PageView key={path} path={path} />
}

function PageView({ path }: { path: string }) {
  const qc = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()
  const actions = useVaultActions()
  const resolver = useResolver()
  const { data: tree } = useTree()
  const { byBase } = usePageTree()
  const { data: spaces } = useSpaces()
  const { data: note, error, isLoading } = useQuery({ queryKey: ["note", path], queryFn: () => api.note(path), enabled: !!path })
  const { data: account } = useQuery({ queryKey: ["account"], queryFn: api.account })

  const [content, setContent] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>("saved")
  const [mode, setMode] = useState<Mode>(() => (pref.get("quire.mode", "edit") === "read" ? "read" : "edit"))
  const [sourcePref, setSourcePref] = useState(false)
  const [outline, setOutline] = useState(() => pref.get("quire.outline", "open") === "open")
  const [historyOpen, setHistoryOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [history, setHistory] = useState<HistoryControls | null>(null)
  const wide = useMedia("(min-width: 1280px)")
  const fresh = (location.state as { fresh?: boolean } | null)?.fresh === true

  const rev = useRef("")
  // Typed here and not yet confirmed saved. While there is some, versions
  // from elsewhere never replace it.
  const dirty = useRef(false)
  const latest = useRef("")
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const saving = useRef<Promise<void> | null>(null)
  // Saved elsewhere since this text was loaded: saving waits for a choice.
  const conflict = useRef(false)
  // "Keep mine" was chosen: the next save is that version.
  const keepMine = useRef(false)
  // Asks again how to settle the conflict.
  const askConflict = useRef<() => void>(() => {})
  // Deleted or moved elsewhere: nothing more is saved to this path.
  const gone = useRef(false)
  const failures = useRef(0)
  const mounted = useRef(true)
  const editorRef = useRef<Editor | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLTextAreaElement>(null)

  // First load, and later versions saved elsewhere while nothing here is unsaved.
  useEffect(() => {
    if (!note) return
    const first = content === null
    if (first || (note.rev !== rev.current && !dirty.current && !conflict.current)) {
      rev.current = note.rev
      latest.current = note.content
      setContent(note.content)
    }
    // Text left unsaved here last time (the tab closed, or the phone ended
    // the app) and newer than the saved page.
    const draft = first ? drafts.get(path) : null
    if (draft && draft.text !== note.content && draft.at > note.mtime) {
      toast.info("This page has unsaved changes", {
        id: `draft:${path}`,
        description: `Made on this device ${relativeTime(draft.at)} and never saved.`,
        duration: Infinity,
        // Saved as a version of its own, so the one it replaces stays in history.
        action: { label: "Restore", onClick: () => ((keepMine.current = true), change(draft.text)) },
        cancel: { label: "Discard", onClick: () => drafts.clear(path) },
      })
    } else if (draft) {
      drafts.clear(path)
    }
  }, [note]) // eslint-disable-line react-hooks/exhaustive-deps

  const markGone = useCallback(() => {
    gone.current = true
    clearTimeout(timer.current)
    toast.dismiss("save-error")
    toast.dismiss("save-conflict")
  }, [])

  const save = useCallback(async (): Promise<void> => {
    clearTimeout(timer.current)
    if (saving.current) await saving.current
    if (!dirty.current || gone.current || conflict.current) return
    const text = latest.current
    const keep = keepMine.current
    setStatus("saving")

    const fail = (e: unknown) => {
      if (e instanceof ApiError && (e.status === 404 || (e.status === 409 && !e.body.rev))) {
        // Deleted or moved on another device; saving here would bring it
        // back. Reloading it shows the page is missing.
        markGone()
        void qc.invalidateQueries({ queryKey: ["note", path], exact: true })
      } else if (e instanceof ApiError && e.status === 409) {
        conflict.current = true
        setStatus("conflict")
        const theirs = String(e.body.content ?? "")
        const theirRev = String(e.body.rev)
        // Load theirs saves this version first, so history has both.
        const loadTheirs = async () => {
          try {
            const mine = await api.save(path, latest.current, theirRev, true)
            const res = await api.save(path, theirs, mine.rev)
            rev.current = res.rev
            latest.current = theirs
            dirty.current = conflict.current = keepMine.current = false
            drafts.clear(path)
            qc.setQueryData<Note>(["note", path], res)
            qc.invalidateQueries({ queryKey: ["history", path] })
            setContent(theirs)
            setStatus("saved")
          } catch (e) {
            if (e instanceof ApiError && (e.status === 404 || e.status === 409)) return fail(e)
            toast.error(errorMessage(e))
            askConflict.current()
          }
        }
        askConflict.current = () =>
          toast.warning("This page changed on another device", {
            id: "save-conflict",
            description: "Keep your version, or load the one saved elsewhere. Both stay in page history.",
            duration: Infinity,
            action: {
              label: "Keep mine",
              onClick: () => {
                rev.current = theirRev
                conflict.current = false
                keepMine.current = true
                void save()
              },
            },
            cancel: { label: "Load theirs", onClick: () => void loadTheirs() },
          })
        askConflict.current()
      } else {
        // Offline, most likely. One notice, kept up until a save works.
        failures.current++
        setStatus("error")
        toast.error("Changes not saved yet", {
          id: "save-error",
          description: `${errorMessage(e)}. They're kept on this device, and saving is retried while the page is open.`,
          duration: Infinity,
        })
      }
    }

    const run = (async () => {
      try {
        const flagged = qc.getQueryData<Note>(["note", path])?.warnings?.length ?? 0
        const res = await api.save(path, text, rev.current || undefined, keep)
        rev.current = res.rev
        keepMine.current = false
        failures.current = 0
        toast.dismiss("save-error")
        if (latest.current === text) {
          dirty.current = false
          drafts.clear(path)
        }
        // A refetch still in flight would bring back the version before this
        // save and replace the text with it, so drop it.
        await qc.cancelQueries({ queryKey: ["note", path], exact: true })
        qc.setQueryData<Note>(["note", path], res)
        // The banner sits above the text; say so where the typing is too.
        if (res.warnings && res.warnings.length > flagged) {
          toast.warning(secretWarningText(res.warnings), { id: "secret-warning", description: "Saved anyway. Pages are plain text and copied into backups." })
        }
        for (const key of ["tree", "tags", "graph", "spaces"]) qc.invalidateQueries({ queryKey: [key] })
        qc.invalidateQueries({ queryKey: ["note"], predicate: (q) => q.queryKey[1] !== path })
        qc.invalidateQueries({ queryKey: ["history", path] })
        setStatus(dirty.current ? "dirty" : "saved")
      } catch (e) {
        fail(e)
      }
    })()
    saving.current = run
    await run
    saving.current = null
    // Typing that came in meanwhile goes next. After a failure, wait longer
    // each time, up to half a minute.
    if (dirty.current && mounted.current && !gone.current && !conflict.current) {
      const wait = failures.current ? Math.min(30_000, 1000 * 2 ** (failures.current - 1)) : 800
      timer.current = setTimeout(() => void save(), wait)
    }
  }, [path, qc, markGone])

  const change = useCallback(
    (v: string) => {
      latest.current = v
      setContent(v)
      dirty.current = true
      drafts.set(path, v)
      if (conflict.current) return
      setStatus("dirty")
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void save(), 800)
    },
    [path, save],
  )

  // A page that disappears elsewhere stops saving here, until it's back.
  const missing = error instanceof ApiError && error.status === 404
  useEffect(() => {
    if (missing) markGone()
    else gone.current = false
  }, [missing, markGone])

  // Back online or back in the app: try a failed save again now.
  useEffect(() => {
    const retry = () => {
      if (failures.current && dirty.current) void save()
    }
    window.addEventListener("online", retry)
    window.addEventListener("focus", retry)
    return () => {
      window.removeEventListener("online", retry)
      window.removeEventListener("focus", retry)
    }
  }, [save])

  // Save on the way out, and warn before closing the tab with unsaved text.
  useEffect(() => {
    mounted.current = true
    const before = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault()
    }
    window.addEventListener("beforeunload", before)
    return () => {
      window.removeEventListener("beforeunload", before)
      mounted.current = false
      void save()
    }
  }, [save])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [save])

  // ⌘Z and ⌘⇧Z work on the page even when the cursor isn't in the text, after
  // using the block menu or clicking beside the page, say. Fields with their
  // own undo (the title, the Markdown source, dialogs) keep it.
  const historyRef = useRef(history)
  historyRef.current = history
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = historyKey(e)
      if (!action || e.defaultPrevented || hasOwnHistory(e.target)) return
      const h = historyRef.current
      if (!h) return
      e.preventDefault()
      if (action === "undo" ? h.canUndo : h.canRedo) h[action]()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  useEffect(() => {
    if (fresh && content !== null && mode === "edit") {
      titleRef.current?.focus()
      titleRef.current?.select()
    }
  }, [fresh, content !== null]) // eslint-disable-line react-hooks/exhaustive-deps

  // Jump to #heading from links like [[Page#Heading]].
  useEffect(() => {
    if (content === null || !location.hash) return
    const id = decodeURIComponent(location.hash.slice(1))
    requestAnimationFrame(() => {
      // Toggle headings keep their text in an attribute; headings of embedded pages aren't this page's.
      const target = [...(bodyRef.current?.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6") ?? [])].find(
        (h) => !h.closest(".embed") && (h.dataset.toggleHeading ?? h.textContent ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-") === id,
      )
      target?.scrollIntoView({ block: "start" })
    })
  }, [content !== null, location.hash]) // eslint-disable-line react-hooks/exhaustive-deps

  const env = {
    path,
    resolver,
    pages: tree?.notes ?? [],
    linkMode: "app" as const,
    fileUrl,
    openLink: (target: string, heading?: string) => void actions.openLink(target, path, heading),
    openTag: (tag: string) => navigate(`/tags/${encodeURIComponent(tag)}`),
    upload: async (file: File) => {
      const id = toast.loading(`Uploading ${file.name || "file"}…`)
      try {
        const res = await api.upload(file)
        toast.dismiss(id)
        return res
      } catch (e) {
        toast.error(errorMessage(e), { id })
      }
    },
    linkPreview: (url: string) => api.linkPreview(url).catch(() => undefined),
    // The "/" menu's Page and Inline database: made under this page, linked by path.
    createChild: async (kind: "page" | "database") => {
      try {
        const made = kind === "database" ? await api.createTable(path, "Untitled database") : await api.create(path, "Untitled")
        qc.setQueryData(["note", made.path], made)
        actions.refresh()
        return { target: baseOf(made.path), open: () => navigate(pageUrl(made.path), { state: { fresh: true } }) }
      } catch (e) {
        toast.error(errorMessage(e))
      }
    },
  }

  if (missing) {
    if (!dirty.current) return <Missing path={path} />
    const saveAsNew = async () => {
      const parent = ancestorsOf(path).at(-1)
      const where = parent && tree?.notes.some((n) => n.path === parent) ? parent : spaceOf(path)
      const created = await actions.createPage(where, titleOf(path), latest.current)
      if (created) {
        // It may land at this same path, and this view carries on there.
        rev.current = created.rev
        dirty.current = false
        drafts.clear(path)
      }
    }
    const discard = () => {
      dirty.current = false
      drafts.clear(path)
      setStatus("saved")
    }
    return <Gone path={path} onSaveAsNew={() => void saveAsNew()} onDiscard={discard} />
  }

  const space = spaces?.find((s) => s.name === spaceOf(path))
  const [frontmatter, body] = splitFrontmatter(content ?? "")
  const isDatabase = frontmatterField(frontmatter, "database") === "true"
  // Databases, and every page when the full-width setting is on, use the
  // whole window unless set to "width: narrow".
  const widthField = frontmatterField(frontmatter, "width")
  const wideByDefault = isDatabase || (account?.fullWidth ?? true)
  const fullWidth = widthField === "full" || (wideByDefault && widthField !== "narrow")
  const forcedSource = content !== null && needsSource(body)
  const source = forcedSource || sourcePref
  const editable = mode === "edit"
  const children = byBase.get(baseOf(path))?.children ?? []
  const outlineItems = headings(body)
  const outgoing = uniqueLinks(note?.outgoing ?? [])
  const hasPanel = outlineItems.length > 0 || children.length > 0 || outgoing.length > 0 || (note?.backlinks.length ?? 0) > 0
  const showOutline = wide && outline && hasPanel

  const jump = (index: number) => {
    const hs = [...(bodyRef.current?.querySelectorAll(source ? ".cm-line" : "h1,h2,h3,h4,h5,h6") ?? [])].filter((h) => !h.closest(".embed"))
    if (source) {
      const line = outlineItems[index]?.line ?? 0
      hs?.[line]?.scrollIntoView({ block: "start", behavior: "smooth" })
    } else {
      hs?.[index]?.scrollIntoView({ block: "start", behavior: "smooth" })
    }
  }

  const panel = (
    <div className="grid gap-7">
      {outlineItems.length > 0 && (
        <PanelSection title="On this page">
          <nav className="grid border-l">
            {outlineItems.map((h, i) => (
              <button
                key={i}
                type="button"
                onClick={() => jump(i)}
                className="-ml-px truncate border-l border-transparent py-1 pr-2 text-left text-[0.8125rem] text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
                style={{ paddingLeft: `${0.75 + (h.level - Math.min(...outlineItems.map((x) => x.level))) * 0.75}rem` }}
              >
                {h.text}
              </button>
            ))}
          </nav>
        </PanelSection>
      )}
      {children.length > 0 && (
        <PanelSection title="Sub-pages" count={children.length}>
          {children.map((c) => (
            <PanelLink key={c.path} to={pageUrl(c.path)} title={c.title} />
          ))}
        </PanelSection>
      )}
      {outgoing.length > 0 && (
        <PanelSection title="Links to" count={outgoing.length}>
          {outgoing.map((o) => (
            <PanelLink
              key={o.target}
              title={o.path ? titleOf(o.path) : o.target}
              hint={o.path ? undefined : "Click to create it"}
              missing={!o.path}
              onClick={() => void actions.openLink(o.target, path)}
            />
          ))}
        </PanelSection>
      )}
      {note && note.backlinks.length > 0 && (
        <PanelSection title="Linked from" count={note.backlinks.length}>
          {note.backlinks.map((b) => (
            <PanelLink key={b.path} to={pageUrl(b.path)} title={b.title} hint={b.context && plainContext(b.context)} />
          ))}
        </PanelSection>
      )}
    </div>
  )

  const exportMarkdown = () => {
    const blob = new Blob([latest.current], { type: "text/markdown;charset=utf-8" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `${titleOf(path)}.md`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  // Stored in the front matter only when it differs from the default:
  // "width: narrow" where pages are wide by default, "width: full" otherwise.
  const setFullWidth = (full: boolean) => {
    const value = wideByDefault ? (full ? null : "narrow") : full ? "full" : null
    const next = setFrontmatterField(latest.current, "width", value)
    if (next !== latest.current) change(next)
  }

  // Keeps the page's text and adds rows and columns below it.
  const turnIntoDatabase = async () => {
    await save()
    try {
      const n = await api.convertTable(path)
      rev.current = n.rev
      latest.current = n.content
      dirty.current = false
      setContent(n.content)
      qc.setQueryData<Note>(["note", path], n)
      for (const key of ["tree", "tables"]) qc.invalidateQueries({ queryKey: [key] })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader>
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 text-sm">
          <Link to={spaceUrl(spaceOf(path))} className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground max-sm:hidden">
            {space && <SpaceAvatar name={space.name} color={space.color} icon={space.icon} className="size-4.5 rounded text-[0.5rem]" />}
            {spaceOf(path)}
          </Link>
          {ancestorsOf(path).map((a) => (
            <span key={a} className="flex min-w-0 items-center gap-1 max-md:hidden">
              <span className="text-muted-foreground/60">/</span>
              <Link to={pageUrl(a)} className="truncate rounded-md px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                {titleOf(a)}
              </Link>
            </span>
          ))}
          <span className="text-muted-foreground/60 max-sm:hidden">/</span>
          <span className="truncate px-1.5 font-medium">{titleOf(path)}</span>
        </nav>

        <SaveStatus status={status} mtime={note?.mtime} onRetry={() => (status === "conflict" ? askConflict.current() : void save())} />

        {editable && content !== null && <UndoRedoButtons controls={history} />}

        <div role="radiogroup" aria-label="Mode" className="flex h-8 items-center rounded-lg bg-muted p-0.5 text-[0.8125rem]">
          {(["edit", "read"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => {
                setMode(m)
                pref.set("quire.mode", m)
              }}
              className={cn(
                "h-7 rounded-md px-2.5 font-medium text-muted-foreground transition-colors",
                mode === m && "bg-background text-foreground shadow-xs",
              )}
            >
              {m === "edit" ? "Edit" : "Read"}
            </button>
          ))}
        </div>

        <SharePopover path={path} disabled={!note || note.virtual} />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="outline"
              aria-label="Table of contents"
              aria-pressed={wide ? showOutline : sheetOpen}
              disabled={!hasPanel}
              className="aria-pressed:bg-accent max-md:size-7 max-md:border-transparent max-md:bg-transparent"
              onClick={() => (wide ? setOutline((o) => (pref.set("quire.outline", o ? "closed" : "open"), !o)) : setSheetOpen(true))}
            >
              <ListTree />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Table of contents</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="outline" aria-label="Page actions" className="max-md:size-7 max-md:border-transparent max-md:bg-transparent">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={() => void actions.createPage(path)}>
              <FilePlus2 /> Add sub-page
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openMoveDialog(path)}>
              <FolderInput /> Move to…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setHistoryOpen(true)} disabled={note?.virtual}>
              <History /> Page history
            </DropdownMenuItem>
            {!isDatabase && (
              <DropdownMenuItem onSelect={() => void turnIntoDatabase()} disabled={content === null || note?.virtual}>
                <Table2 /> Turn into database
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={content === null}
              // Stays open, like a settings row.
              onSelect={(e) => {
                e.preventDefault()
                setFullWidth(!fullWidth)
              }}
            >
              <MoveHorizontal /> Full width
              <Switch size="sm" checked={fullWidth} tabIndex={-1} aria-hidden className="pointer-events-none ml-auto" />
            </DropdownMenuItem>
            <DropdownMenuCheckboxItem checked={source} disabled={forcedSource} onCheckedChange={(v) => setSourcePref(!!v)}>
              <Code2 /> Edit as Markdown
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem
              onSelect={() => {
                void navigator.clipboard?.writeText(`[[${titleOf(path)}]]`)
                toast.success("Copied [[link]]")
              }}
            >
              <Copy /> Copy [[link]]
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={exportMarkdown} disabled={!content}>
              <Download /> Download .md
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void actions.remove(path, children.length)}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto max-md:pb-(--sab)">
          <article
            ref={bodyRef}
            className={cn("mx-auto w-full px-6 pt-10 pb-16 sm:px-14 md:pt-14", fullWidth ? "max-w-none" : "max-w-[52rem]")}
          >
            {isLoading || content === null ? (
              <PageSkeleton />
            ) : (
              <>
                <TitleField
                  key={path}
                  inputRef={titleRef}
                  title={titleOf(path)}
                  editable={editable}
                  onCommit={async (name) => {
                    await save()
                    return !!(await actions.rename(path, name))
                  }}
                  onEnter={() => editorRef.current?.commands.focus("start")}
                />
                <SecretWarningBanner warnings={note?.warnings} />
                {forcedSource && (
                  <p className="mb-5 rounded-md border bg-surface px-3 py-2 text-[0.8125rem] text-muted-foreground">
                    This page uses Markdown the visual editor can't keep (HTML, footnotes, math or reference links), so you're editing its source.
                  </p>
                )}
                {source ? (
                  <SourceEditor value={content} onChange={change} editable={editable} onHistory={setHistory} />
                ) : (
                  <PageEditor
                    markdown={body}
                    editable={editable}
                    env={env}
                    autofocus={!fresh && editable && !body.trim() && !note?.virtual}
                    compact={isDatabase}
                    placeholder={isDatabase ? "Add a description, or press / for blocks" : undefined}
                    onReady={(e) => (editorRef.current = e)}
                    onHistory={setHistory}
                    onChange={(md) => change(frontmatter + md)}
                  />
                )}
                {isDatabase && (
                  <div className="mt-8">
                    <DatabaseView path={path} editable={editable} />
                  </div>
                )}
              </>
            )}
          </article>
        </div>

        {showOutline && (
          <aside aria-label="Table of contents" className="w-64 shrink-0 overflow-y-auto py-14 pr-4 pl-2">
            {panel}
          </aside>
        )}
      </div>

      {!wide && (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="right" className="gap-0 overflow-y-auto data-[side=right]:w-72">
            <SheetTitle className="sr-only">Table of contents</SheetTitle>
            {/* Close once a heading or page is picked. */}
            <div className="px-3 pt-14 pb-6" onClick={(e) => (e.target as HTMLElement).closest("a,button") && setSheetOpen(false)}>
              {panel}
            </div>
          </SheetContent>
        </Sheet>
      )}

      {note && !note.virtual && (
        <HistoryDialog
          path={path}
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          onRestored={(n) => {
            rev.current = n.rev
            latest.current = n.content
            dirty.current = conflict.current = false
            drafts.clear(path)
            setContent(n.content)
            setStatus("saved")
          }}
        />
      )}
    </div>
  )
}

/** One link per target, in the order the page first uses them. */
function uniqueLinks(links: Outgoing[]) {
  const seen = new Set<string>()
  return links.filter((l) => {
    const key = (l.path ?? l.target).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** A backlink's surrounding text without Markdown marks. */
const plainContext = (s: string) =>
  s
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/\[\[|\]\]|\*\*|__|==|`/g, "")
    .replace(/\s+/g, " ")
    .trim()

function PanelSection({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground">
        {title}
        {count !== undefined && <span className="tabular-nums opacity-70">{count}</span>}
      </h2>
      <div className="grid gap-px">{children}</div>
    </section>
  )
}

function PanelLink({ to, onClick, title, hint, missing }: { to?: string; onClick?: () => void; title: string; hint?: string; missing?: boolean }) {
  const body = (
    <>
      <span className="flex items-center gap-2">
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className={cn("truncate", missing && "text-muted-foreground underline decoration-dashed underline-offset-4")}>{title}</span>
      </span>
      {hint && <span className="mt-0.5 line-clamp-2 pl-5.5 text-xs text-muted-foreground">{hint}</span>}
    </>
  )
  const cls = "block w-full rounded-md px-2 py-1 text-left text-[0.8125rem] transition-colors hover:bg-accent"
  return to ? (
    <Link to={to} className={cls}>
      {body}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  )
}

function TitleField({
  title,
  editable,
  onCommit,
  onEnter,
  inputRef,
}: {
  title: string
  editable: boolean
  onCommit: (v: string) => Promise<boolean>
  onEnter: () => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  const [value, setValue] = useState(title)
  const commit = async () => {
    const v = value.replace(/\s+/g, " ").trim()
    if (!v || v === title) return setValue(title)
    if (!(await onCommit(v))) setValue(title)
  }
  // Grow with the text.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = "0px"
    el.style.height = `${el.scrollHeight}px`
  }, [value, inputRef])

  if (!editable) return <h1 className="mb-6 text-[2.25rem] leading-tight font-bold tracking-[-0.025em] break-words">{title}</h1>
  return (
    <textarea
      ref={inputRef}
      rows={1}
      value={value}
      onChange={(e) => setValue(e.target.value.replace(/\n/g, ""))}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || (e.key === "ArrowDown" && e.currentTarget.selectionStart === value.length)) {
          e.preventDefault()
          e.currentTarget.blur()
          onEnter()
        }
        if (e.key === "Escape") {
          setValue(title)
          e.currentTarget.blur()
        }
      }}
      aria-label="Page title"
      placeholder="Untitled"
      spellCheck={false}
      className="mb-6 block w-full resize-none overflow-hidden bg-transparent text-[2.25rem] leading-tight font-bold tracking-[-0.025em] outline-none placeholder:text-muted-foreground/40"
    />
  )
}

function SaveStatus({ status, mtime, onRetry }: { status: Status; mtime?: number; onRetry: () => void }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  const text = {
    saved: mtime ? `Edited ${relativeTime(mtime)}` : "",
    dirty: "Editing…",
    saving: "Saving…",
    error: "Not saved · Retry",
    conflict: "Conflict · Choose",
  }[status]
  const clickable = status === "error" || status === "conflict"
  return (
    <button
      type="button"
      onClick={clickable ? onRetry : undefined}
      aria-live="polite"
      className={cn(
        "mr-1 shrink-0 text-xs whitespace-nowrap text-muted-foreground max-lg:hidden",
        status === "error" && "text-destructive",
        status === "conflict" && "text-amber-600 dark:text-amber-400",
        clickable ? "hover:underline" : "cursor-default",
      )}
    >
      {text}
    </button>
  )
}

function PageSkeleton() {
  return (
    <div className="grid gap-4">
      <Skeleton className="mb-4 h-10 w-2/3" />
      {[92, 100, 85, 96, 60].map((w, i) => (
        <Skeleton key={i} className="h-4" style={{ width: `${w}%` }} />
      ))}
    </div>
  )
}

/** The page went away elsewhere while this tab had unsaved changes to it. */
function Gone({ path, onSaveAsNew, onDiscard }: { path: string; onSaveAsNew: () => void; onDiscard: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <PageHeader />
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileQuestion />
          </EmptyMedia>
          <EmptyTitle>This page was deleted or moved</EmptyTitle>
          <EmptyDescription>
            “{titleOf(path)}” went away on another device before your latest changes were saved. Save them as a new page, or discard them.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button variant="outline" onClick={onDiscard}>
            Discard changes
          </Button>
          <Button onClick={onSaveAsNew}>
            <FilePlus2 /> Save as new page
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  )
}

function Missing({ path }: { path: string }) {
  const actions = useVaultActions()
  const parent = ancestorsOf(path).at(-1) ?? spaceOf(path)
  return (
    <div className="flex h-full flex-col">
      <PageHeader />
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileQuestion />
          </EmptyMedia>
          <EmptyTitle>“{titleOf(path)}” doesn't exist</EmptyTitle>
          <EmptyDescription>It may have been renamed, moved or deleted on another device.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button variant="outline" asChild>
            <Link to={spaceUrl(spaceOf(path))}>Go to {spaceOf(path)}</Link>
          </Button>
          <Button onClick={() => void actions.createPage(parent, titleOf(path))}>
            <FilePlus2 /> Create it
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  )
}
