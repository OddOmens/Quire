import type { NoteMeta, Tree } from "@/lib/api"

/** /p/Space/Parent/Page for Space/Parent/Page.md */
export function pageUrl(path: string, heading?: string) {
  const url = "/p/" + baseOf(path).split("/").map(encodeURIComponent).join("/")
  return heading ? `${url}#${slugify(heading)}` : url
}

export const spaceUrl = (space: string) => `/s/${encodeURIComponent(space)}`
export const spaceSettingsUrl = (space: string) => `${spaceUrl(space)}/settings`
export const spaceGraphUrl = (space: string) => `${spaceUrl(space)}/graph`
export const spaceTasksUrl = (space: string) => `${spaceUrl(space)}/tasks`

/** The page path a /p/… pathname points at. */
export function pathFromUrl(pathname: string) {
  const rest = pathname.replace(/^\/p\//, "")
  if (!rest || rest === pathname) return ""
  try {
    return rest.split("/").map(decodeURIComponent).join("/") + ".md"
  } catch {
    return ""
  }
}

export const baseOf = (path: string) => path.replace(/\.md$/i, "")
export const titleOf = (path: string) => baseOf(path).split("/").pop()!
export const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")
export const spaceOf = (path: string) => path.split("/")[0]
export const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

/** The page that contains this one, "" at the top of a space. */
export function parentOf(path: string) {
  const f = folderOf(baseOf(path))
  return f.includes("/") ? `${f}.md` : ""
}

/** Ancestor pages, outermost first. */
export function ancestorsOf(path: string) {
  const out: string[] = []
  for (let p = parentOf(path); p; p = parentOf(p)) out.unshift(p)
  return out
}

export function slugify(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
}

export const linkKey = (target: string) => target.trim().replace(/^\/+|\/+$/g, "").replace(/\.md$/i, "").toLowerCase()

/**
 * Resolves [[link]] targets to page paths, matching the server: a target
 * with a slash matches a path or the end of one; a bare name matches a title,
 * preferring the linking page's folder, then the shortest path.
 */
export class Resolver {
  private byPath = new Map<string, string>()
  private byTitle = new Map<string, string[]>()

  constructor(notes: NoteMeta[]) {
    for (const n of notes) {
      this.byPath.set(linkKey(n.path), n.path)
      const t = n.title.toLowerCase()
      this.byTitle.set(t, [...(this.byTitle.get(t) ?? []), n.path])
    }
  }

  resolve(target: string, from = ""): string | undefined {
    const key = linkKey(target)
    if (!key) return undefined
    if (key.includes("/")) {
      const exact = this.byPath.get(key)
      if (exact) return exact
      let best: string | undefined
      for (const [k, p] of this.byPath) {
        if (k.endsWith("/" + key) && (!best || p.length < best.length)) best = p
      }
      return best
    }
    const cands = this.byTitle.get(key) ?? []
    if (cands.length <= 1) return cands[0]
    const dir = folderOf(from)
    return cands.find((c) => folderOf(c) === dir) ?? [...cands].sort((a, b) => a.length - b.length || a.localeCompare(b))[0]
  }

  /** How many pages share this title; links to ambiguous titles use a path. */
  count(title: string) {
    return this.byTitle.get(title.toLowerCase())?.length ?? 0
  }
}

/** A page in the sidebar tree. Virtual pages are folders without a file. */
export type PageNode = {
  path: string
  title: string
  virtual: boolean
  mtime: number
  children: PageNode[]
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/**
 * Builds each space's page tree from the flat list of files and folders.
 * Pages follow their folder's custom order; those it doesn't list come after,
 * alphabetically.
 */
export function buildTree(notes: NoteMeta[], folders: string[], order: Record<string, string[]> = {}) {
  const byBase = new Map<string, PageNode>()
  const ensure = (base: string): PageNode => {
    let node = byBase.get(base)
    if (!node) {
      node = { path: `${base}.md`, title: base.split("/").pop()!, virtual: true, mtime: 0, children: [] }
      byBase.set(base, node)
    }
    return node
  }
  for (const n of notes) {
    const node = ensure(baseOf(n.path))
    node.virtual = false
    node.mtime = n.mtime
  }
  for (const f of folders) ensure(f)

  const roots = new Map<string, PageNode[]>()
  for (const [base, node] of byBase) {
    const parent = folderOf(base)
    if (!parent.includes("/")) {
      roots.set(parent, [...(roots.get(parent) ?? []), node])
    } else {
      ensure(parent).children.push(node)
    }
  }
  const sort = (list: PageNode[], folder: string) => {
    const rank = new Map((order[folder] ?? []).map((name, i) => [name, i]))
    const at = (n: PageNode) => rank.get(n.title) ?? rank.size
    list.sort((a, b) => at(a) - at(b) || collator.compare(a.title, b.title))
    list.forEach((n) => sort(n.children, baseOf(n.path)))
  }
  roots.forEach(sort)
  return { roots, byBase }
}

/**
 * The tree after moving a page under parent (a space or page path), before
 * the sibling page `before` or last. It mirrors POST /api/reorder, so the
 * sidebar can show the result before the server answers.
 */
export function reorderTree(tree: Tree, path: string, parent: string, before: string): Tree {
  const from = baseOf(path)
  const folder = parent.includes("/") ? baseOf(parent) : parent
  const name = titleOf(path)
  const to = `${folder}/${name}`
  let { notes, folders } = tree
  const order = { ...tree.order }
  if (to !== from) {
    const moved = (p: string) => (p === from || p.startsWith(from + "/") ? to + p.slice(from.length) : p)
    notes = notes.map((n) => {
      const b = moved(baseOf(n.path))
      return b === baseOf(n.path) ? n : { ...n, path: `${b}.md`, folder: folderOf(b) }
    })
    folders = folders.map(moved)
    for (const key of Object.keys(order)) {
      if (moved(key) !== key) {
        order[moved(key)] = order[key]
        delete order[key]
      }
    }
    const old = folderOf(from)
    if (order[old]) order[old] = order[old].filter((n) => n !== name)
  }
  const { roots, byBase } = buildTree(notes, folders, order)
  const names = ((folder.includes("/") ? byBase.get(folder)?.children : roots.get(folder)) ?? []).map((n) => n.title).filter((n) => n !== name)
  const at = before && folderOf(baseOf(before)) === folder ? names.indexOf(titleOf(before)) : -1
  names.splice(at < 0 ? names.length : at, 0, name)
  order[folder] = names
  return { notes, folders, order }
}

/** A page's headings, including toggle headings (<summary><h2>…</h2></summary>). */
export function headings(markdown: string) {
  const out: { level: number; text: string; line: number; toggle?: boolean }[] = []
  let fence = false
  markdown.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) return
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) return out.push({ level: m[1].length, text: m[2].replace(/[*_`=]|\[\[|\]\]/g, ""), line: i })
    const t = /^\s*<summary><h([1-3])>(.*)<\/h\1><\/summary>\s*$/i.exec(line)
    if (t) out.push({ level: Number(t[1]), text: t[2].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"), line: i, toggle: true })
  })
  return out
}

export function relativeTime(ms: number) {
  if (!ms) return ""
  const diff = (Date.now() - ms) / 1000
  if (diff < 45) return "just now"
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)} d ago`
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: diff > 86400 * 300 ? "numeric" : undefined })
}

export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return "?"
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** Where a database's form is filled in inside Quire. */
export const formUrl = (path: string, form: string) => `/form/${path.split("/").map(encodeURIComponent).join("/")}?id=${encodeURIComponent(form)}`
