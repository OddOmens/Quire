import { useEffect, useMemo, useState } from "react"
import { CornerDownRight, FileText } from "lucide-react"

import { SpaceAvatar } from "@/components/space-avatar"
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { usePageTree, useSpaces, useVaultActions } from "@/hooks/use-vault"
import { baseOf, folderOf, titleOf, type PageNode } from "@/lib/notes"
import { onUiEvent } from "@/lib/ui-events"

/** Picks a new home for a page: the top of any space, or under another page. */
export function MoveDialog() {
  const [path, setPath] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const { data: spaces } = useSpaces()
  const { roots } = usePageTree()
  const actions = useVaultActions()

  useEffect(
    () =>
      onUiEvent<string>("quire:move", (p) => {
        setQuery("")
        setPath(p)
      }),
    [],
  )

  const targets = useMemo(() => {
    if (!path) return []
    const self = baseOf(path)
    const out: { key: string; space: string; label: string; depth: number; target: string; current: boolean }[] = []
    for (const sp of spaces ?? []) {
      out.push({ key: sp.name, space: sp.name, label: sp.name, depth: -1, target: sp.name, current: folderOf(self) === sp.name })
      const walk = (nodes: PageNode[], depth: number) => {
        for (const n of nodes) {
          const b = baseOf(n.path)
          if (b === self || b.startsWith(self + "/")) continue
          out.push({ key: n.path, space: sp.name, label: n.title, depth, target: n.path, current: folderOf(self) === b })
          walk(n.children, depth + 1)
        }
      }
      walk(roots.get(sp.name) ?? [], 0)
    }
    const q = query.trim().toLowerCase()
    if (!q) return out
    // Titles that match come first, then pages whose location matches.
    const byTitle = out.filter((t) => t.label.toLowerCase().includes(q))
    const byPath = out.filter((t) => !byTitle.includes(t) && t.key.toLowerCase().includes(q))
    return [...byTitle, ...byPath]
  }, [path, spaces, roots, query])

  return (
    <CommandDialog open={!!path} onOpenChange={(o) => !o && setPath(null)} title="Move page" description="Choose where this page goes" className="sm:max-w-lg">
      <Command loop shouldFilter={false}>
        <CommandInput placeholder={path ? `Move “${titleOf(path)}” to…` : ""} value={query} onValueChange={setQuery} />
        <CommandList className="max-h-[min(26rem,60vh)]">
          <CommandEmpty>No matching pages.</CommandEmpty>
          {(spaces ?? []).filter((sp) => targets.some((t) => t.space === sp.name)).map((sp) => (
            <CommandGroup key={sp.name} heading={sp.name}>
              {targets
                .filter((t) => t.space === sp.name)
                .map((t) => (
                  <CommandItem
                    key={t.key}
                    value={t.key}
                    disabled={t.current}
                    onSelect={() => {
                      if (path) void actions.moveUnder(path, t.target)
                      setPath(null)
                    }}
                  >
                    <span style={{ paddingLeft: `${Math.max(0, t.depth) * 1}rem` }} className="flex min-w-0 items-center gap-2">
                      {t.depth < 0 ? (
                        <SpaceAvatar name={sp.name} color={sp.color} icon={sp.icon} className="size-5 text-[0.55rem]" />
                      ) : t.depth > 0 ? (
                        <CornerDownRight className="text-muted-foreground" />
                      ) : (
                        <FileText className="text-muted-foreground" />
                      )}
                      <span className="truncate">{t.depth < 0 ? "Top of space" : t.label}</span>
                    </span>
                    {t.current && <span className="ml-auto text-xs text-muted-foreground">Current</span>}
                  </CommandItem>
                ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
