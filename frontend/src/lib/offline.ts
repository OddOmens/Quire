/**
 * A copy of the vault on this device, so Quire opens, reads and writes with
 * no connection (or away from the network the server is on).
 *
 * It's off until someone turns it on in Settings, per browser. Then:
 *
 *   - Every answer the app reads pages from (the page list, each page, each
 *     database, tasks, tags) is kept in IndexedDB under the address it was
 *     asked at, and stands in when the server can't be reached. sync()
 *     fetches the ones that haven't been looked at, so the whole vault is
 *     there, and attached files go into a cache the service worker serves
 *     from (public/sw.js).
 *   - Saving a page or making a new one with no connection goes into an
 *     outbox instead, and is sent when the server answers again. A page that
 *     changed elsewhere meanwhile is never overwritten quietly: the owner
 *     picks a version, and both stay in page history.
 *
 * The copy isn't encrypted. Signing out removes it; only changes still
 * waiting to be sent are kept, since they exist nowhere else.
 */

import type { Attachment, Hit, Note, NoteMeta, Space, TableInfo, Tree } from "@/lib/api"

const FLAG = "quire.offline"
const DB = "quire-offline"
/** The cache attached files are kept in; the service worker serves from it. */
export const FILES_CACHE = "quire-files-v1"
/** The cache the app's own files are in (public/sw.js). */
const SHELL_CACHE = "quire-shell-v1"
/** A page's rev while changes to it wait in the outbox. */
const LOCAL = "local:"

export const isLocalRev = (rev: string | undefined) => !!rev && rev.startsWith(LOCAL)

/** The server couldn't be reached at all (as opposed to it refusing). */
export class Unreachable extends Error {
  status = 0
  body: Record<string, unknown> = {}
  constructor(message = "Quire can't reach the server") {
    super(message)
  }
}

export const isUnreachable = (e: unknown) => e instanceof Unreachable

/** A change made with no connection, waiting to be sent. */
export type Pending = {
  path: string
  content: string
  /** The server's version this text was based on; "" for a page made offline. */
  baseRev: string
  at: number
  /** Send as the version kept after a conflict. */
  keep?: boolean
  /** A page made offline: where it goes and what it's called. */
  create?: { parent: string; title: string }
  /** The page changed elsewhere meanwhile: their version, until one is picked. */
  clash?: { rev: string; content: string }
  /** The page was deleted or moved elsewhere meanwhile. */
  gone?: boolean
  /** The server refused it for another reason. */
  error?: string
  /** Counts local saves, for the local rev. */
  n: number
}

export type OfflineState = {
  enabled: boolean
  /** Whether the last request got an answer. */
  reachable: boolean
  pending: Pending[]
  syncing: boolean
  progress: { done: number; total: number } | null
  /** When the whole vault was last brought up to date, in ms. */
  lastSync: number
  /** What the copy holds. */
  pages: number
  files: number
  syncError: string
}

export type OfflineEvent =
  | { type: "saved"; note: Note }
  | { type: "moved"; from: string; to: string; note: Note }
  | { type: "changed" }
  | { type: "back" }

// ── What's kept ──

/** GET addresses whose answers are kept. */
const KEPT = [/^\/api\/auth\/session$/, /^\/api\/account$/, /^\/api\/tree$/, /^\/api\/tags$/, /^\/api\/spaces(\/[^/]+(\/(tasks|missing-links))?)?$/, /^\/api\/notes\//, /^\/api\/graph\?/, /^\/api\/calendar\?/, /^\/api\/tables$/, /^\/api\/formulas\/functions$/, /^\/api\/link-preview\?/]
/** A database itself, not its history, export or the like (which follow the page's .md). */
const TABLE = /^\/api\/tables\/.+\.md$/i

export const keeps = (url: string) => KEPT.some((re) => re.test(url)) || TABLE.test(url)

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/")
export const noteAddress = (path: string) => `/api/notes/${encodePath(path)}`
const tableAddress = (path: string) => `/api/tables/${encodePath(path)}`
const fileAddress = (path: string) => `/api/files/${encodePath(path)}`

// ── Storage ──

let db: Promise<IDBDatabase> | undefined

function open() {
  return (db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore("answers")
      req.result.createObjectStore("outbox")
      req.result.createObjectStore("meta")
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("No storage"))
    req.onblocked = () => reject(new Error("Storage is busy"))
  }).catch((e) => {
    db = undefined
    throw e
  }))
}

type StoreName = "answers" | "outbox" | "meta"

async function tx<T>(store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const d = await open()
  return new Promise<T>((resolve, reject) => {
    const t = d.transaction(store, mode)
    const req = run(t.objectStore(store))
    t.oncomplete = () => resolve((req ? req.result : undefined) as T)
    t.onerror = t.onabort = () => reject(t.error ?? new Error("Storage failed"))
  })
}

const get = <T>(store: StoreName, key: string) => tx<T | undefined>(store, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>)
const put = (store: StoreName, key: string, value: unknown) => tx<IDBValidKey>(store, "readwrite", (s) => s.put(value, key))
const del = (store: StoreName, key: string) => tx<undefined>(store, "readwrite", (s) => s.delete(key))
const keysOf = (store: StoreName) => tx<IDBValidKey[]>(store, "readonly", (s) => s.getAllKeys())
const all = <T>(store: StoreName) => tx<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>)
const clear = (store: StoreName) => tx<undefined>(store, "readwrite", (s) => s.clear())

type Answer = { data: unknown; at: number }

async function read<T>(url: string): Promise<T | undefined> {
  try {
    return (await get<Answer>("answers", url))?.data as T | undefined
  } catch {
    return undefined
  }
}

async function write(url: string, data: unknown) {
  try {
    await put("answers", url, { data, at: Date.now() } satisfies Answer)
  } catch {
    // A full disk or private mode: the copy is just less complete.
  }
}

// ── State ──

function flag() {
  try {
    return localStorage.getItem(FLAG) === "1"
  } catch {
    return false
  }
}

let state: OfflineState = {
  enabled: typeof indexedDB !== "undefined" && flag(),
  reachable: true,
  pending: [],
  syncing: false,
  progress: null,
  lastSync: 0,
  pages: 0,
  files: 0,
  syncError: "",
}

const watchers = new Set<() => void>()

function set(patch: Partial<OfflineState>) {
  state = { ...state, ...patch }
  for (const w of watchers) w()
}

export const offlineState = () => state
export function watchOffline(fn: () => void) {
  watchers.add(fn)
  return () => {
    watchers.delete(fn)
  }
}

const emit = (detail: OfflineEvent) => window.dispatchEvent(new CustomEvent<OfflineEvent>("quire:offline", { detail }))

async function refreshPending() {
  try {
    const pending = (await all<Pending>("outbox")).sort((a, b) => a.at - b.at)
    set({ pending })
    return pending
  } catch {
    return state.pending
  }
}

/** Done once the outbox has been read: until then nobody knows which pages have changes waiting. */
const ready: Promise<unknown> = state.enabled ? refreshPending() : Promise.resolve()

/** One thing at a time touches the outbox. */
let chain: Promise<unknown> = Promise.resolve()
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => {})
  return next
}

// ── Reaching the server ──

let probe: ReturnType<typeof setTimeout> | undefined
/** Set by lib/api.ts: asks the server who's signed in, bypassing the copy. */
let ping: () => Promise<unknown> = () => Promise.reject(new Unreachable())
/** Set by lib/api.ts: the calls the outbox and sync make. */
export type Wire = {
  get: <T>(url: string) => Promise<T>
  save: (path: string, content: string, baseRev: string, keep: boolean) => Promise<Note>
  create: (parent: string, title: string, content: string) => Promise<Note>
}
let wire: Wire | undefined

export function connect(w: Wire) {
  wire = w
  ping = () => w.get("/api/auth/session")
}

/** Called for every request: whether the server answered (any answer counts). */
export function heard(ok: boolean) {
  if (ok === state.reachable) return
  set({ reachable: ok })
  clearTimeout(probe)
  if (!state.enabled) return
  if (ok) {
    emit({ type: "back" })
    void flush().then(() => syncSoon(2000))
  } else {
    scheduleProbe()
  }
}

function scheduleProbe(wait = 20_000) {
  clearTimeout(probe)
  probe = setTimeout(() => void check(), wait)
}

/** Asks the server whether it's there, when the copy is standing in for it. */
export async function check() {
  if (!state.enabled || state.reachable) return
  try {
    await ping()
  } catch (e) {
    if (isUnreachable(e)) return scheduleProbe()
  }
  heard(true)
}

/** How long a request may take before a kept answer is shown instead. */
const PATIENCE = 5000

/**
 * A GET whose answer is kept: the server's answer when it comes, the kept one
 * when it doesn't. `send` asks the server.
 */
export async function answer<T>(url: string, send: () => Promise<T>): Promise<T> {
  if (!state.enabled) return send()

  // A page with changes waiting to be sent is read from here, where they are.
  if (url.startsWith("/api/notes/")) {
    await ready
    const mine = state.pending.find((p) => noteAddress(p.path) === url)
    const kept = mine && (await read<T>(url))
    if (kept) return kept
  }

  const fresh = send().then((data) => {
    if (keeps(url)) void keep(url, data)
    return data
  })
  // It may fail while the kept answer is still being read; that's dealt with below.
  fresh.catch(() => {})

  if (!state.reachable) {
    const kept = await read<T>(url)
    if (kept !== undefined) {
      fresh.catch(() => {})
      return kept
    }
    if (url.startsWith("/api/search?")) {
      fresh.catch(() => {})
      return (await searchCopy(url)) as T
    }
  }

  // Slow is as good as gone: show the kept answer rather than a spinner.
  let timer: ReturnType<typeof setTimeout> | undefined
  const slow = new Promise<{ kept: T } | undefined>((resolve) => {
    timer = setTimeout(async () => {
      const kept = await read<T>(url)
      resolve(kept === undefined ? undefined : { kept })
    }, PATIENCE)
  })
  try {
    const first = await Promise.race([fresh.then((data) => ({ data })), slow])
    if (first && "data" in first) return first.data
    if (first && "kept" in first) {
      // When the server does answer, have the screens ask again.
      fresh.then(() => emit({ type: "changed" }), () => {})
      return first.kept
    }
    return await fresh
  } catch (e) {
    if (!isUnreachable(e)) {
      // The server says it's not there any more: neither is the copy.
      if ((e as { status?: number }).status === 404) void del("answers", url).catch(() => {})
      throw e
    }
    const kept = await read<T>(url)
    if (kept !== undefined) return kept
    if (url.startsWith("/api/search?")) return (await searchCopy(url)) as T
    throw e
  } finally {
    clearTimeout(timer)
  }
}

async function keep(url: string, data: unknown) {
  // Never over a page whose changes are still here.
  if (url.startsWith("/api/notes/")) {
    await ready
    if (state.pending.some((p) => noteAddress(p.path) === url)) return
  }
  await write(url, data)
}

/** Keeps what a save or another change sent back, so the copy has it too. */
export function keepNote(note: Note) {
  if (state.enabled && note?.path && !isLocalRev(note.rev)) void keep(noteAddress(note.path), note)
  return note
}

export function keepTable<T extends { path: string }>(table: T) {
  if (state.enabled && table?.path) void write(tableAddress(table.path), table)
  return table
}

// ── Search without the server ──

async function searchCopy(url: string): Promise<Hit[]> {
  const params = new URL(url, location.origin).searchParams
  const q = (params.get("q") ?? "").trim().toLowerCase()
  const limit = Number(params.get("limit")) || 20
  if (!q) return []
  const tree = await read<Tree>("/api/tree")
  const hits: (Hit & { rank: number })[] = []
  for (const meta of tree?.notes ?? []) {
    const note = await read<Note>(noteAddress(meta.path))
    const text = note?.content ?? ""
    const lower = text.toLowerCase()
    const inTitle = meta.title.toLowerCase().includes(q)
    const tagged = q.startsWith("#") && (note?.tags ?? meta.tags ?? []).some((t) => `#${t}`.toLowerCase() === q)
    const at = lower.indexOf(q)
    if (!inTitle && !tagged && at < 0) continue
    hits.push({ path: meta.path, title: meta.title, folder: meta.folder, snippet: snippetAt(text, at, q.length), rank: inTitle ? 0 : 1 })
  }
  return hits.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title)).slice(0, limit).map(({ rank: _rank, ...hit }) => hit)
}

/** The text around a match, on one line. */
export function snippetAt(text: string, at: number, length: number) {
  if (at < 0) return text.slice(0, 140).replace(/\s+/g, " ").trim()
  const from = Math.max(0, at - 50)
  const to = Math.min(text.length, at + length + 90)
  return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ").trim()}${to < text.length ? "…" : ""}`
}

// ── Writing without the server ──

/** What the server turns a title into for a file name (pageName in notes.go). */
export function pageName(title: string) {
  // eslint-disable-next-line no-control-regex
  let name = title.trim().split(/\s+/).join(" ").replace(/[/\\:*?"<>|\u0000-\u001f]/g, "-").replace(/^\.+/, "")
  if ([...name].length > 120) name = [...name].slice(0, 120).join("").trim()
  return name || "Untitled"
}

/** The first of "name", "name 2", "name 3"… that taken doesn't have (vault.UniqueName). */
export function uniquePath(path: string, taken: (p: string) => boolean) {
  if (!taken(path)) return path
  const base = path.replace(/\.md$/i, "")
  for (let i = 2; ; i++) {
    const c = `${base} ${i}.md`
    if (!taken(c)) return c
  }
}

const baseOf = (p: string) => p.replace(/\.md$/i, "")
const titleOf = (p: string) => baseOf(p).split("/").pop()!
const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "")

function metaOf(path: string, content: string, rev: string): NoteMeta {
  return { path, title: titleOf(path), folder: folderOf(path), mtime: Date.now(), size: content.length, rev, words: content.split(/\s+/).filter(Boolean).length, excerpt: "", tags: [] }
}

/** The page with this text at this rev, keeping what the last answer said about its links. */
async function noteWith(path: string, content: string, rev: string): Promise<Note> {
  const kept = await read<Note>(noteAddress(path))
  const note: Note = {
    ...metaOf(path, content, rev),
    tags: kept?.tags ?? [],
    kind: kept?.kind,
    content,
    backlinks: kept?.backlinks ?? [],
    outgoing: kept?.outgoing ?? [],
    warnings: kept?.warnings,
  }
  await write(noteAddress(path), note)
  return note
}

/** The page as this device has it, with its changes. */
const localNote = (p: Pending) => noteWith(p.path, p.content, `${LOCAL}${p.n}`)

async function patchTree(change: (tree: Tree) => void) {
  const tree = await read<Tree>("/api/tree")
  if (!tree) return
  change(tree)
  await write("/api/tree", tree)
}

async function queue(p: Pending) {
  await put("outbox", p.path, p)
  await refreshPending()
  return localNote(p)
}

/** The server's version a local rev stands for, once its changes were sent. */
const sent = new Map<string, string>()
/** Pages made offline that the server gave another name: old path to new. */
const renamed = new Map<string, string>()

/**
 * Saves a page. With no connection the text goes to the outbox and the
 * caller gets the page back as if it were saved, with a local rev.
 */
export function saveNote(path: string, content: string, baseRev: string | undefined, keepMine: boolean, send: Wire["save"]): Promise<Note> {
  if (!state.enabled) return send(path, content, baseRev ?? "", keepMine)
  return locked(async () => {
    const local = isLocalRev(baseRev)
    // A screen still open on a page's offline name saves to its real one.
    if (local && renamed.has(path)) path = renamed.get(path)!
    const entry = await get<Pending>("outbox", path)
    if (!entry) {
      const base = local ? (sent.get(path) ?? "") : (baseRev ?? "")
      try {
        return keepNote(await send(path, content, base, keepMine))
      } catch (e) {
        if (!isUnreachable(e)) throw e
        return queue({ path, content, baseRev: base, keep: keepMine || undefined, at: Date.now(), n: 1 })
      }
    }
    entry.content = content
    entry.n++
    // A real rev from the caller means it settled a conflict itself.
    if (!local && baseRev) {
      entry.baseRev = baseRev
      entry.keep = keepMine || undefined
      entry.clash = undefined
    }
    await put("outbox", path, entry)
    if (entry.clash || entry.gone || entry.error) {
      await refreshPending()
      return localNote(entry)
    }
    return (await push(entry)) ?? (await refreshPending(), localNote(entry))
  })
}

/** Makes a page. With no connection it's made here and sent later. */
export function createNote(parent: string, title: string, content: string, send: Wire["create"]): Promise<Note> {
  if (!state.enabled) return send(parent, title, content)
  return locked(async () => {
    try {
      return keepNote(await send(parent, title, content))
    } catch (e) {
      if (!isUnreachable(e)) throw e
      const tree = await read<Tree>("/api/tree")
      if (!tree) throw e
      const taken = new Set([...tree.notes.map((n) => baseOf(n.path).toLowerCase()), ...tree.folders.map((f) => f.toLowerCase())])
      const path = uniquePath(`${baseOf(parent)}/${pageName(title)}.md`, (p) => taken.has(baseOf(p).toLowerCase()))
      const entry: Pending = { path, content, baseRev: "", create: { parent, title: titleOf(path) }, at: Date.now(), n: 1 }
      await patchTree((t) => void t.notes.push(metaOf(path, content, `${LOCAL}1`)))
      return queue(entry)
    }
  })
}

/**
 * Renames a page that so far only exists here. Anything else that moves a
 * page needs the server: returns undefined.
 */
export function renameLocal(from: string, to: string): Promise<{ path: string; updated: string[] } | undefined> {
  return locked(async () => {
    const entry = state.enabled ? await get<Pending>("outbox", from) : undefined
    if (!entry?.create || folderOf(from) !== folderOf(to)) return undefined
    const tree = await read<Tree>("/api/tree")
    const taken = new Set([...(tree?.notes ?? []).map((n) => baseOf(n.path).toLowerCase()), ...(tree?.folders ?? []).map((f) => f.toLowerCase())])
    taken.delete(baseOf(from).toLowerCase())
    const path = uniquePath(`${folderOf(to)}/${pageName(titleOf(to))}.md`, (p) => taken.has(baseOf(p).toLowerCase()))
    await del("outbox", from)
    await del("answers", noteAddress(from))
    const moved: Pending = { ...entry, path, create: { ...entry.create, title: titleOf(path) } }
    await patchTree((t) => {
      t.notes = t.notes.filter((n) => n.path !== from)
      t.notes.push(metaOf(path, moved.content, `${LOCAL}${moved.n}`))
    })
    await queue(moved)
    return { path, updated: [] }
  })
}

/** Drops a page that so far only exists here. Returns false for any other page. */
export function removeLocal(path: string): Promise<boolean> {
  return locked(async () => {
    const entry = state.enabled ? await get<Pending>("outbox", path) : undefined
    if (!entry?.create) return false
    await del("outbox", path)
    await del("answers", noteAddress(path))
    await patchTree((t) => void (t.notes = t.notes.filter((n) => n.path !== path)))
    await refreshPending()
    return true
  })
}

/**
 * Sends one waiting change. Returns the saved page, or undefined when it's
 * still waiting (no connection, or it needs the owner to decide something).
 */
async function push(entry: Pending): Promise<Note | undefined> {
  if (!wire) return undefined
  try {
    const res = entry.create ? await wire.create(entry.create.parent, entry.create.title, entry.content) : await wire.save(entry.path, entry.content, entry.baseRev, !!entry.keep)
    await del("outbox", entry.path)
    sent.set(entry.path, res.rev)
    if (res.path !== entry.path) {
      // Its name was taken meanwhile: the server numbered it.
      await del("answers", noteAddress(entry.path))
      await write(noteAddress(res.path), res)
      sent.set(res.path, res.rev)
      renamed.set(entry.path, res.path)
      await rebase(entry.path, res.path)
      await refreshPending()
      emit({ type: "moved", from: entry.path, to: res.path, note: res })
    } else {
      await write(noteAddress(res.path), res)
      await refreshPending()
      emit({ type: "saved", note: res })
    }
    return res
  } catch (e) {
    if (isUnreachable(e)) return undefined
    const err = e as { status?: number; body?: Record<string, unknown>; message?: string }
    if (err.status === 401) return undefined
    if (err.status === 409 && err.body?.rev && String(err.body.content ?? "") === entry.content) {
      // The server already has exactly this: an earlier try got through
      // without its answer arriving, or another tab sent it.
      await del("outbox", entry.path)
      sent.set(entry.path, String(err.body.rev))
      const note = await noteWith(entry.path, entry.content, String(err.body.rev))
      await refreshPending()
      emit({ type: "saved", note })
      return note
    }
    if (err.status === 409 && err.body?.rev) entry.clash = { rev: String(err.body.rev), content: String(err.body.content ?? "") }
    else if (!entry.create && (err.status === 404 || err.status === 409)) entry.gone = true
    else entry.error = err.message || "The server refused it"
    await put("outbox", entry.path, entry)
    await refreshPending()
    emit({ type: "changed" })
    return undefined
  }
}

/** Pages made offline under a page that just got its real name follow it. */
async function rebase(from: string, to: string) {
  const prefix = `${baseOf(from)}/`
  for (const p of await all<Pending>("outbox")) {
    if (!p.create) continue
    if (p.create.parent === from) p.create.parent = to
    else if (p.create.parent.startsWith(prefix)) p.create.parent = `${baseOf(to)}/${p.create.parent.slice(prefix.length)}`
    else continue
    await put("outbox", p.path, p)
  }
}

/** Sends everything that's waiting and can go. */
export function flush(): Promise<void> {
  if (!state.enabled && !state.pending.length) return Promise.resolve()
  return locked(async () => {
    for (const entry of await refreshPending()) {
      if (entry.clash || entry.gone || entry.error) continue
      // An earlier one in this round may have renamed or replaced it.
      const now = await get<Pending>("outbox", entry.path)
      if (now && !(await push(now)) && !state.reachable) break
    }
  })
}

/**
 * Settles a change the server wouldn't take as it was.
 *   mine:    this device's version becomes the page (theirs stays in history).
 *   theirs:  the other version stays the page (this one goes into history).
 *   discard: this device's version is dropped.
 *   retry:   try sending it again as it is.
 * For a page deleted or moved elsewhere, "mine" brings it back with this text.
 */
export function settle(path: string, choice: "mine" | "theirs" | "discard" | "retry"): Promise<void> {
  return locked(async () => {
    const entry = await get<Pending>("outbox", path)
    if (!entry || !wire) return
    if (choice === "discard") {
      await del("outbox", path)
      await del("answers", noteAddress(path))
      if (entry.create) await patchTree((t) => void (t.notes = t.notes.filter((n) => n.path !== path)))
      await refreshPending()
      emit({ type: "changed" })
      return
    }
    const theirs = entry.clash
    if (theirs) {
      entry.baseRev = theirs.rev
      entry.keep = true
    } else if (entry.gone) {
      entry.baseRev = ""
    }
    entry.clash = undefined
    entry.error = undefined
    entry.gone = undefined
    await put("outbox", path, entry)
    const mine = await push(entry)
    if (theirs && choice === "theirs") {
      if (mine) {
        // Mine went into history first; now theirs is the page again.
        const res = await wire.save(path, theirs.content, mine.rev, false)
        sent.set(path, res.rev)
        await write(noteAddress(path), res)
        emit({ type: "saved", note: res })
      } else {
        // Couldn't be sent just now: the question stays open.
        const waiting = await get<Pending>("outbox", path)
        if (waiting && !waiting.clash) await put("outbox", path, { ...waiting, clash: theirs })
      }
    }
    await refreshPending()
  })
}

// ── Downloading everything ──

let syncTimer: ReturnType<typeof setTimeout> | undefined
let syncing: Promise<void> | undefined

/** Brings the copy up to date soon; calls close together become one. */
export function syncSoon(wait = 5000) {
  if (!state.enabled) return
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => void sync().catch(() => {}), wait)
}

async function each<T>(items: T[], workers: number, run: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(workers, items.length) }, async () => {
      while (next < items.length) await run(items[next++])
    }),
  )
}

/** Fetches whatever the copy doesn't have yet or has an old version of. */
export function sync(): Promise<void> {
  if (!state.enabled || !wire) return Promise.resolve()
  return (syncing ??= run().finally(() => (syncing = undefined)))
}

async function run() {
  const w = wire!
  clearTimeout(syncTimer)
  set({ syncing: true, syncError: "", progress: { done: 0, total: 0 } })
  try {
    // Kept by answer() as they arrive.
    const fetchKept = async <T>(url: string) => {
      const data = await w.get<T>(url)
      await keep(url, data)
      return data
    }
    const [tree, spaces] = await Promise.all([fetchKept<Tree>("/api/tree"), fetchKept<Space[]>("/api/spaces"), fetchKept("/api/auth/session"), fetchKept("/api/account"), fetchKept("/api/tags"), fetchKept("/api/formulas/functions").catch(() => {})])
    const tables = await fetchKept<TableInfo[]>("/api/tables").catch(() => [] as TableInfo[])
    const pending = new Set((await refreshPending()).map((p) => p.path))

    // Pages whose kept version isn't the server's.
    const have = new Map<string, string>()
    for (const key of await keysOf("answers")) {
      if (typeof key === "string" && key.startsWith("/api/notes/")) have.set(key, "")
    }
    const stale: string[] = []
    for (const n of tree.notes) {
      const address = noteAddress(n.path)
      if (pending.has(n.path)) {
        have.delete(address)
        continue
      }
      const kept = have.has(address) ? await read<Note>(address) : undefined
      have.delete(address)
      if (kept?.rev !== n.rev) stale.push(n.path)
    }
    // Folders of sub-pages with no page of their own still open as a page.
    const pages = new Set(tree.notes.map((n) => baseOf(n.path)))
    for (const f of tree.folders) {
      if (pages.has(f)) continue
      have.delete(noteAddress(`${f}.md`))
      stale.push(`${f}.md`)
    }
    // Pages that are gone from the server go from here too.
    for (const address of have.keys()) {
      if (![...pending].some((p) => noteAddress(p) === address)) await del("answers", address)
    }

    let files: Attachment[] = []
    try {
      files = (await w.get<{ items: Attachment[] }>("/api/attachments")).items
    } catch (e) {
      if (isUnreachable(e)) throw e
    }
    const staleFiles = await staleAttachments(files)
    const own = await missingAppFiles()
    const perSpace = spaces.flatMap((s) => {
      const name = encodeURIComponent(s.name)
      return [`/api/spaces/${name}`, `/api/spaces/${name}/tasks`, `/api/spaces/${name}/missing-links`, `/api/graph?space=${name}`]
    })
    // The calendar asks by the month on screen: last month to three months on.
    try {
      const { gridRange, monthStart } = await import("@/components/database/calendar-view")
      const now = new Date()
      for (let m = -1; m <= 3; m++) {
        const { from, to } = gridRange(monthStart(new Date(now.getFullYear(), now.getMonth() + m, 1)))
        perSpace.push(`/api/calendar?from=${from}&to=${to}`)
      }
    } catch {
      // Its code couldn't be loaded: the months already looked at are kept.
    }

    let done = 0
    const total = stale.length + tables.length + perSpace.length + staleFiles.length + own.length
    const step = () => set({ progress: { done: ++done, total } })
    set({ progress: { done, total } })

    await each(stale, 4, async (path) => {
      await fetchKept(noteAddress(path)).catch(skipMissing)
      step()
    })
    await each(tables, 3, async (t) => {
      await fetchKept(tableAddress(t.path)).catch(skipMissing)
      step()
    })
    await each(perSpace, 3, async (url) => {
      await fetchKept(url).catch(skipMissing)
      step()
    })
    await each(own, 6, async (url) => {
      await keepAppFile(url)
      step()
    })
    await each(staleFiles, 2, async (f) => {
      await keepAttachment(f)
      step()
    })

    const lastSync = Date.now()
    await put("meta", "lastSync", lastSync)
    await put("meta", "counts", { pages: tree.notes.length, files: files.length })
    set({ lastSync, pages: tree.notes.length, files: files.length })
    // Ask the browser not to clear this when the device runs low on space.
    void navigator.storage?.persist?.().catch(() => {})
  } catch (e) {
    set({ syncError: isUnreachable(e) ? "" : e instanceof Error ? e.message : "The download stopped" })
    throw e
  } finally {
    set({ syncing: false, progress: null })
  }
}

/** A page or database that went away while the list was being worked through. */
function skipMissing(e: unknown) {
  if (isUnreachable(e)) throw e
}

async function staleAttachments(files: Attachment[]) {
  if (typeof caches === "undefined") return []
  const seen = (await get<Record<string, number>>("meta", "files").catch(() => undefined)) ?? {}
  const cache = await caches.open(FILES_CACHE)
  const kept = new Set((await cache.keys()).map((r) => new URL(r.url).pathname))
  const wanted = new Set(files.map((f) => fileAddress(f.path)))
  for (const address of kept) {
    if (!wanted.has(address)) await cache.delete(address)
  }
  return files.filter((f) => !kept.has(fileAddress(f.path)) || seen[f.path] !== f.mtime)
}

async function keepAttachment(f: Attachment) {
  const address = fileAddress(f.path)
  try {
    const res = await fetch(address, { credentials: "same-origin" })
    if (!res.ok) return
    await (await caches.open(FILES_CACHE)).put(address, res)
    const seen = (await get<Record<string, number>>("meta", "files")) ?? {}
    seen[f.path] = f.mtime
    await put("meta", "files", seen)
  } catch {
    // The next sync tries again.
  }
}

/** The build's own files (code for every screen, fonts) that aren't on the device yet. */
async function missingAppFiles() {
  if (typeof caches === "undefined" || !import.meta.env.PROD) return []
  try {
    const res = await fetch("/offline-files.json", { cache: "no-cache" })
    if (!res.ok) return []
    const list = (await res.json()) as string[]
    const cache = await caches.open(SHELL_CACHE)
    const kept = new Set((await cache.keys()).map((r) => new URL(r.url).pathname))
    return list.filter((f) => !kept.has(f))
  } catch {
    return []
  }
}

async function keepAppFile(url: string) {
  try {
    await (await caches.open(SHELL_CACHE)).add(url)
  } catch {
    // The next sync tries again.
  }
}

// ── Turning it on and off ──

let listening = false

/** Reads what's waiting and when the copy was last updated. Called at start, and when the copy is turned on. */
export async function startOffline() {
  if (typeof indexedDB === "undefined") return
  // Changes kept from before a sign-out still go out, copy or no copy.
  await refreshPending()
  if (!state.enabled) return
  const [lastSync, counts] = await Promise.all([get<number>("meta", "lastSync").catch(() => 0), get<{ pages: number; files: number }>("meta", "counts").catch(() => undefined)])
  set({ lastSync: lastSync ?? 0, pages: counts?.pages ?? 0, files: counts?.files ?? 0 })
  if (!listening) {
    listening = true
    window.addEventListener("online", () => void check())
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return
      void check()
      if (state.reachable && Date.now() - state.lastSync > 10 * 60_000) syncSoon(3000)
    })
  }
  syncSoon(6000)
}

export async function enableOffline() {
  try {
    localStorage.setItem(FLAG, "1")
  } catch {
    throw new Error("This browser doesn't let Quire keep anything (private browsing?)")
  }
  await open()
  if (typeof caches !== "undefined") await caches.open(FILES_CACHE)
  set({ enabled: true })
  await startOffline()
  await sync()
}

/**
 * Removes the copy. Changes still waiting to be sent stay unless `everything`.
 * stayOn: the session ended on its own; the copy is fetched again after
 * signing in.
 */
export async function removeCopy({ everything = false, stayOn = false } = {}) {
  clearTimeout(syncTimer)
  clearTimeout(probe)
  const was = state.enabled
  if (!stayOn) {
    try {
      localStorage.removeItem(FLAG)
    } catch {
      // Nothing was kept without storage.
    }
  }
  set({ enabled: was && stayOn, lastSync: 0, pages: 0, files: 0, reachable: true })
  if (!was && !state.pending.length) return
  try {
    if (typeof caches !== "undefined") await caches.delete(FILES_CACHE)
    const waiting = everything ? [] : await all<Pending>("outbox")
    await clear("answers")
    await clear("meta")
    if (everything) await clear("outbox")
    // The text of pages still waiting stays readable to the outbox only.
    set({ pending: waiting })
  } catch {
    // No storage, nothing to remove.
  }
}

/** How much this browser is storing for Quire, where it says. */
export async function storageUsed() {
  try {
    return (await navigator.storage?.estimate?.())?.usage ?? 0
  } catch {
    return 0
  }
}
