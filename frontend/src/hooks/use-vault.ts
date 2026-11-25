import { useCallback, useEffect, useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useLocation, useNavigate } from "react-router"
import { toast } from "sonner"

import { useDialogs } from "@/components/dialogs"
import { api, ApiError, clientId, type Space, type SpaceSection, type Tree } from "@/lib/api"
import { syncSoon } from "@/lib/offline"
import { baseOf, buildTree, folderOf, joinPath, pageUrl, pathFromUrl, reorderTree, Resolver, spaceOf, spaceUrl, titleOf } from "@/lib/notes"

export function useTree() {
  return useQuery({ queryKey: ["tree"], queryFn: api.tree })
}

/** The spaces, in the order you arranged them. */
export function useSpaces() {
  return useQuery({ queryKey: ["spaces"], queryFn: api.spaces })
}

/** The space menu's headings, empty ones included. */
export function useSpaceSections() {
  return useQuery({ queryKey: ["sections"], queryFn: api.sections })
}

/**
 * Puts the spaces in a new order. Everything that lists spaces shows it at
 * once, and goes back if the server refuses.
 */
export function useArrangeSpaces() {
  const qc = useQueryClient()
  return useCallback(
    async (names: string[], sections?: SpaceSection[]) => {
      await qc.cancelQueries({ queryKey: ["spaces"] })
      const prev = qc.getQueryData<Space[]>(["spaces"])
      if (prev) {
        const sectionOf = sections ? new Map(sections.flatMap((sec) => sec.spaces.map((n) => [n, sec.name] as const))) : null
        const next = prev.map((s) => (sectionOf ? { ...s, section: sectionOf.get(s.name) } : s))
        // Spaces under no heading first, then each section's, as the server lists them.
        const order = sections ? [...names.filter((n) => !sectionOf!.has(n)), ...sections.flatMap((sec) => sec.spaces)] : names
        const rank = new Map(order.map((n, i) => [n, i]))
        const at = (s: Space) => rank.get(s.name) ?? order.length + prev.findIndex((p) => p.name === s.name)
        qc.setQueryData<Space[]>(["spaces"], next.sort((a, b) => at(a) - at(b)))
      }
      try {
        qc.setQueryData(["spaces"], await api.arrangeSpaces(names, sections))
        if (sections) qc.setQueryData(["sections"], sections)
        return true
      } catch (e) {
        if (prev) qc.setQueryData(["spaces"], prev)
        qc.invalidateQueries({ queryKey: ["spaces"] })
        toast.error(errorMessage(e))
        return false
      }
    },
    [qc],
  )
}

export function usePageTree() {
  const { data } = useTree()
  return useMemo(() => buildTree(data?.notes ?? [], data?.folders ?? [], data?.order), [data])
}

export function useResolver() {
  const { data } = useTree()
  return useMemo(() => new Resolver(data?.notes ?? []), [data])
}

/** The page open in the current route, "" elsewhere. */
export function useCurrentPath() {
  const { pathname } = useLocation()
  return pathname.startsWith("/p/") ? pathFromUrl(pathname) : ""
}

const LAST_SPACE = "quire.space"

/** The space in view: from the URL, else the last one used, else the first. */
export function useCurrentSpace() {
  const { pathname } = useLocation()
  const { data: spaces } = useSpaces()
  let fromUrl = ""
  if (pathname.startsWith("/p/")) fromUrl = spaceOf(pathFromUrl(pathname))
  else if (pathname.startsWith("/s/")) {
    try {
      fromUrl = decodeURIComponent(pathname.split("/")[2] ?? "")
    } catch {
      fromUrl = ""
    }
  }
  useEffect(() => {
    if (!fromUrl) return
    try {
      localStorage.setItem(LAST_SPACE, fromUrl)
    } catch {
      // Not remembered in private mode.
    }
  }, [fromUrl])
  if (fromUrl) return spaces?.find((s) => s.name === fromUrl)?.name ?? fromUrl
  let last = ""
  try {
    last = localStorage.getItem(LAST_SPACE) ?? ""
  } catch {
    last = ""
  }
  return spaces?.find((s) => s.name === last)?.name ?? spaces?.[0]?.name ?? ""
}

export const errorMessage = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong")

/** Everything that creates, renames, moves or deletes pages. */
export function useVaultActions() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const current = useCurrentPath()
  const resolver = useResolver()
  const { confirm } = useDialogs()

  const refresh = useCallback(() => {
    for (const key of ["tree", "spaces", "tags", "graph", "note", "trash", "tasks", "missing-links", "tables", "calendar"]) qc.invalidateQueries({ queryKey: [key] })
  }, [qc])

  /** parent is a space name or a page path. */
  const createPage = useCallback(
    async (parent: string, title = "Untitled", content = "") => {
      if (!parent) {
        toast.error("Create a space first")
        return
      }
      try {
        const note = await api.create(parent, title, content)
        qc.setQueryData(["note", note.path], note)
        refresh()
        navigate(pageUrl(note.path), { state: { fresh: title === "Untitled" } })
        return note
      } catch (e) {
        toast.error(errorMessage(e))
      }
    },
    [qc, navigate, refresh],
  )

  /** Follows the open page to where it moved, and says which links changed. */
  const followMove = useCallback(
    (from: string, res: { path: string; updated: string[] }) => {
      const fromBase = baseOf(from)
      const cur = baseOf(current)
      if (cur === fromBase) navigate(pageUrl(res.path), { replace: true })
      else if (cur.startsWith(fromBase + "/")) navigate(pageUrl(baseOf(res.path) + cur.slice(fromBase.length)), { replace: true })
      qc.removeQueries({ queryKey: ["note", from] })
      if (res.updated.length) {
        toast.success(`Updated links in ${res.updated.length} ${res.updated.length === 1 ? "page" : "pages"}`)
      }
    },
    [current, navigate, qc],
  )

  /** Moves a page (and its sub-pages); to is its new path. */
  const move = useCallback(
    async (from: string, to: string) => {
      if (baseOf(from) === baseOf(to)) return
      try {
        const res = await api.move(from, to)
        followMove(from, res)
        refresh()
        return res.path
      } catch (e) {
        toast.error(errorMessage(e))
      }
    },
    [followMove, refresh],
  )

  /**
   * Puts a page under parent (a space or page path), before the sibling page
   * `before` or last. The sidebar shows the result at once and goes back if
   * the server refuses.
   */
  const reorder = useCallback(
    async (path: string, parent: string, before = "") => {
      const from = baseOf(path)
      const folder = parent.includes("/") ? baseOf(parent) : parent
      if (folder === from || folder.startsWith(from + "/")) return
      const moving = folderOf(from) !== folder
      const prev = qc.getQueryData<Tree>(["tree"])
      const to = `${folder}/${titleOf(path)}`.toLowerCase()
      if (moving && prev && [...prev.notes.map((n) => baseOf(n.path)), ...prev.folders].some((b) => b.toLowerCase() === to)) {
        toast.error(`There's already a page called “${titleOf(path)}” there`)
        return
      }
      await qc.cancelQueries({ queryKey: ["tree"] })
      if (prev) qc.setQueryData<Tree>(["tree"], reorderTree(prev, path, parent, before))
      try {
        const res = await api.reorder(path, parent, before)
        if (moving) {
          followMove(path, res)
          refresh()
        } else {
          qc.invalidateQueries({ queryKey: ["tree"] })
        }
        return res.path
      } catch (e) {
        if (prev) qc.setQueryData<Tree>(["tree"], prev)
        qc.invalidateQueries({ queryKey: ["tree"] })
        toast.error(errorMessage(e))
      }
    },
    [qc, followMove, refresh],
  )

  const rename = useCallback(
    (path: string, title: string) => {
      const name = title.trim().replace(/\//g, "-")
      if (!name || name === titleOf(path)) return Promise.resolve(undefined)
      return move(path, joinPath(folderOf(path), `${name}.md`))
    },
    [move],
  )

  /** Moves a page under another page, or to the top of a space. */
  const moveUnder = useCallback(
    (path: string, parent: string) => {
      const target = parent.includes("/") ? baseOf(parent) : parent
      const base = baseOf(path)
      if (folderOf(base) === target || target === base || target.startsWith(base + "/")) return
      return move(path, `${target}/${titleOf(path)}.md`)
    },
    [move],
  )

  const remove = useCallback(
    async (path: string, children = 0) => {
      const ok = await confirm({
        title: `Delete “${titleOf(path)}”?`,
        description:
          children > 0
            ? `It and its ${children} ${children === 1 ? "sub-page" : "sub-pages"} move to the trash. You can restore them from there.`
            : "It moves to the trash. You can restore it from there.",
        confirm: "Delete",
        destructive: true,
      })
      if (!ok) return
      try {
        await api.remove(path)
        const base = baseOf(path)
        if (current === path || baseOf(current).startsWith(base + "/")) {
          navigate(spaceUrl(spaceOf(path)), { replace: true })
        }
        qc.removeQueries({ queryKey: ["note", path] })
        refresh()
        toast(`Moved “${titleOf(path)}” to the trash`, {
          action: { label: "View trash", onClick: () => navigate("/trash") },
        })
      } catch (e) {
        toast.error(errorMessage(e))
      }
    },
    [confirm, current, navigate, qc, refresh],
  )

  /** Follows a [[link]], creating the page if it doesn't exist yet. */
  const openLink = useCallback(
    async (target: string, from: string, heading?: string) => {
      const path = resolver.resolve(target, from)
      if (path) {
        navigate(pageUrl(path, heading))
        return
      }
      const name = target.split("/").pop()!
      const parent = target.includes("/") ? folderOf(target) : folderOf(from)
      await createPage(parent || spaceOf(from), name, "")
    },
    [resolver, navigate, createPage],
  )

  return { createPage, rename, move, moveUnder, reorder, remove, openLink, refresh }
}

/**
 * Keeps this tab in step with changes from other devices and from edits on
 * disk, via the server's event stream.
 */
export function useLiveUpdates() {
  const qc = useQueryClient()
  useEffect(() => {
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout>
    let lost = false
    const connect = () => {
      es = new EventSource("/api/events")
      es.onopen = () => {
        if (lost) qc.invalidateQueries()
        lost = false
      }
      es.onmessage = (msg) => {
        const ev = JSON.parse(msg.data) as { type: string; paths: string[]; origin?: string }
        if (ev.origin === clientId) return
        // Changed on another device: the copy on this one follows (lib/offline.ts).
        syncSoon()
        if (ev.type === "table") {
          // Rows changed; databases that relate to them may show new totals.
          for (const key of ["table", "tables", "calendar", "table-history"]) qc.invalidateQueries({ queryKey: [key] })
          return
        }
        for (const key of ["tree", "spaces", "sections", "tags", "graph", "note", "tasks", "missing-links", "table", "tables", "calendar"]) qc.invalidateQueries({ queryKey: [key] })
      }
      es.onerror = () => {
        lost = true
        if (es?.readyState === EventSource.CLOSED) retry = setTimeout(connect, 5000)
      }
    }
    connect()
    return () => {
      clearTimeout(retry)
      es?.close()
    }
  }, [qc])
}
