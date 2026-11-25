import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { FilePlus2, FileText, Hash, House, LayoutGrid, ListTodo, Moon, Network, Plus, Search, Settings, Settings2, Sun, TextSearch, Trash2 } from "lucide-react"
import { useTheme } from "next-themes"
import { useNavigate } from "react-router"

import { SpaceAvatar } from "@/components/space-avatar"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { useCurrentPath, useCurrentSpace, useSpaces, useTree, useVaultActions } from "@/hooks/use-vault"
import { api, type NoteMeta } from "@/lib/api"
import { baseOf, pageUrl, spaceGraphUrl, spaceSettingsUrl, spaceTasksUrl, spaceUrl } from "@/lib/notes"
import { onUiEvent, openSpaceDialog } from "@/lib/ui-events"

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Ranks titles: exact, then prefix, then word start, then anywhere. */
function rank(notes: NoteMeta[], q: string) {
  const query = q.trim().toLowerCase()
  if (!query) return [...notes].sort((a, b) => b.mtime - a.mtime).slice(0, 7)
  const scored: [number, NoteMeta][] = []
  for (const n of notes) {
    const t = n.title.toLowerCase()
    let s = -1
    if (t === query) s = 0
    else if (t.startsWith(query)) s = 1
    else if (t.split(/[\s\-_]+/).some((w) => w.startsWith(query))) s = 2
    else if (t.includes(query)) s = 3
    else if (n.path.toLowerCase().includes(query)) s = 4
    if (s >= 0) scored.push([s, n])
  }
  return scored.sort((a, b) => a[0] - b[0] || b[1].mtime - a[1].mtime).slice(0, 10).map(([, n]) => n)
}

/** Snippet text without Markdown syntax. */
const plain = (s: string) =>
  s
    .replace(/\[\[([^\]|]*\|)?|\]\]/g, "")
    .replace(/\[![a-z]+\]|```\w*|==|\*\*|__|`|\|/gi, " ")
    .replace(/(^|\s)(#{1,6}|>|-{3,}|- \[[ x]\])(?=\s)/g, " ")
    .replace(/\s+/g, " ")

/** Snippets mark matches with \x02…\x03. */
function Snippet({ text }: { text: string }) {
  // oxlint-disable-next-line no-control-regex
  const parts = text.split(/(\x02[^\x03]*\x03)/g)
  return (
    <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
      {parts.map((p, i) =>
        p.startsWith("\x02") ? (
          <mark key={i} className="rounded-[3px] bg-mark px-0.5 text-foreground">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{plain(p)}</span>
        ),
      )}
    </span>
  )
}

const where = (path: string) => baseOf(path).split("/").slice(0, -1).join(" / ")

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const navigate = useNavigate()
  const { data: tree } = useTree()
  const { data: spaces } = useSpaces()
  const actions = useVaultActions()
  const space = useCurrentSpace()
  const current = useCurrentPath()
  const { resolvedTheme, setTheme } = useTheme()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey) {
        e.preventDefault()
        setOpen((o) => !o)
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault()
        void actions.createPage(space)
      }
    }
    window.addEventListener("keydown", onKey)
    const off = onUiEvent("quire:palette", () => setOpen(true))
    return () => {
      window.removeEventListener("keydown", onKey)
      off()
    }
  }, [actions, space])

  useEffect(() => {
    if (!open) setQuery("")
  }, [open])

  const titles = useMemo(() => rank(tree?.notes ?? [], query), [tree, query])
  const q = useDebounced(query.trim(), 150)
  const { data: hits } = useQuery({
    queryKey: ["search", q],
    queryFn: () => api.search(q, 12),
    enabled: open && q.length >= 2,
    placeholderData: (prev) => prev,
  })
  const fullText = q.length >= 2 ? (hits ?? []).filter((h) => !titles.some((t) => t.path === h.path)) : []
  const exact = tree?.notes.some((n) => n.title.toLowerCase() === query.trim().toLowerCase())
  const matchingSpaces = (spaces ?? []).filter((s) => query.trim() && s.name.toLowerCase().includes(query.trim().toLowerCase()))

  const dark = resolvedTheme === "dark"
  const commands = [
    { id: "new-page", label: "New page", icon: FilePlus2, shortcut: "⌘⇧N", run: () => void actions.createPage(space) },
    ...(current ? [{ id: "new-sub", label: "New sub-page here", icon: Plus, shortcut: "", run: () => void actions.createPage(current) }] : []),
    { id: "new-space", label: "New space", icon: LayoutGrid, shortcut: "", run: () => openSpaceDialog() },
    ...(space ? [{ id: "space-settings", label: `${space} settings`, icon: Settings2, shortcut: "", run: () => navigate(spaceSettingsUrl(space)) }] : []),
    { id: "home", label: "Home", icon: House, shortcut: "", run: () => navigate("/") },
    { id: "graph", label: "Graph", icon: Network, shortcut: "", run: () => navigate(space ? spaceGraphUrl(space) : "/graph") },
    ...(space ? [{ id: "tasks", label: "Tasks", icon: ListTodo, shortcut: "", run: () => navigate(spaceTasksUrl(space)) }] : []),
    { id: "tags", label: "Tags", icon: Hash, shortcut: "", run: () => navigate("/tags") },
    { id: "trash", label: "Trash", icon: Trash2, shortcut: "", run: () => navigate("/trash") },
    { id: "settings", label: "Settings", icon: Settings, shortcut: "", run: () => navigate("/settings") },
    { id: "theme", label: dark ? "Light theme" : "Dark theme", icon: dark ? Sun : Moon, shortcut: "", run: () => setTheme(dark ? "light" : "dark") },
  ].filter((c) => !query.trim() || c.label.toLowerCase().includes(query.trim().toLowerCase()))

  const run = (fn: () => void) => {
    setOpen(false)
    fn()
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Search" description="Find a page, search inside pages, or run a command" className="sm:max-w-xl">
      <Command shouldFilter={false} loop>
        <CommandInput placeholder="Search pages and commands…" value={query} onValueChange={setQuery} />
        <CommandList className="max-h-[min(28rem,60vh)]">
          <CommandEmpty>
            <div className="flex flex-col items-center gap-2 py-4 text-muted-foreground">
              <Search className="size-5 opacity-60" />
              Nothing matches “{query}”
            </div>
          </CommandEmpty>

          {titles.length > 0 && (
            <CommandGroup heading={query.trim() ? "Pages" : "Recently edited"}>
              {titles.map((n) => (
                <CommandItem key={n.path} value={`page:${n.path}`} onSelect={() => run(() => navigate(pageUrl(n.path)))}>
                  <FileText className="text-muted-foreground" />
                  <span className="truncate">{n.title}</span>
                  <CommandShortcut className="max-w-[50%] truncate pl-3 tracking-normal">{where(n.path)}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {fullText.length > 0 && (
            <CommandGroup heading="Mentioned in">
              {fullText.map((h) => (
                <CommandItem key={h.path} value={`hit:${h.path}`} onSelect={() => run(() => navigate(pageUrl(h.path)))} className="items-start">
                  <TextSearch className="mt-0.5 text-muted-foreground" />
                  <div className="grid min-w-0 gap-0.5">
                    <span className="truncate font-medium">
                      {h.title}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">{where(h.path)}</span>
                    </span>
                    <Snippet text={h.snippet} />
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {matchingSpaces.length > 0 && (
            <CommandGroup heading="Spaces">
              {matchingSpaces.map((s) => (
                <CommandItem key={s.name} value={`space:${s.name}`} onSelect={() => run(() => navigate(spaceUrl(s.name)))}>
                  <SpaceAvatar name={s.name} color={s.color} icon={s.icon} className="size-5 text-[0.55rem]" />
                  {s.name}
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {query.trim() && !exact && !query.trim().startsWith("#") && space && (
            <CommandGroup heading="Create">
              <CommandItem value="create-from-query" onSelect={() => run(() => void actions.createPage(space, query.trim()))}>
                <FilePlus2 className="text-brand" />
                <span className="truncate">
                  New page <span className="font-medium">“{query.trim()}”</span> in {space}
                </span>
              </CommandItem>
            </CommandGroup>
          )}

          {commands.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Commands">
                {commands.map((c) => (
                  <CommandItem key={c.id} value={`cmd:${c.id}`} onSelect={() => run(c.run)}>
                    <c.icon /> {c.label}
                    {c.shortcut && <CommandShortcut>{c.shortcut}</CommandShortcut>}
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
