import { answer, connect, createNote, heard, keepNote, keeps, keepTable, removeCopy, removeLocal, renameLocal, saveNote, Unreachable } from "@/lib/offline"
import { forgetShell } from "@/lib/shell-cache"

export type NoteMeta = {
  path: string
  title: string
  folder: string
  mtime: number
  size: number
  rev: string
  words: number
  excerpt: string
  tags: string[]
  /** "database" for a page with rows and columns. */
  kind?: "database"
}

export type Backlink = { path: string; title: string; context: string }
export type Outgoing = { target: string; path?: string }
/** Something on a page that looks like a secret. Never includes the value. */
export type SecretWarning = { kind: string; label: string; line: number; preview: string }

export type Note = NoteMeta & {
  content: string
  backlinks: Backlink[]
  outgoing: Outgoing[]
  virtual?: boolean
  warnings?: SecretWarning[]
}

export type Space = {
  name: string
  description: string
  color: string
  /** A Lucide icon name; absent shows the initials. */
  icon?: string
  /** The heading it's under in the space menu, if any. */
  section?: string
  pages: number
  updated: number
}
/** A heading in the space menu and the spaces under it, in order. */
export type SpaceSection = { name: string; spaces: string[] }
export type SpaceDetails = Space & {
  folder: string
  topLevel: number
  nested: number
  words: number
  size: number
  files: number
  created: number
  shared: number
  links: number
  tags: { tag: string; count: number }[]
}
export type BackupStatus = {
  running: boolean
  lastRun: number
  lastSuccess: number
  lastError: string
  files: number
  uploaded: number
  deleted: number
  bytes: number
  /** The saved Coffer app password couldn't be unlocked; backups wait until it's entered again. */
  needsPassword?: boolean
}
export type BackupSettings = { configured: boolean; url?: string; username?: string; folder?: string; hours?: number; status: BackupStatus }
export type BackupInput = { url: string; username: string; password: string; folder: string; hours: number }
/** order: each folder's custom page order (page names); others follow alphabetically. */
export type Tree = { notes: NoteMeta[]; folders: string[]; order?: Record<string, string[]> }
export type Hit = { path: string; title: string; folder: string; snippet: string }
export type Tag = { tag: string; count: number }
export type Graph = {
  nodes: { path: string; title: string; folder: string; links: number }[]
  edges: { source: string; target: string }[]
}
/** An open to-do ("- [ ] …"); line is 1-based in the page as of rev. */
export type Task = {
  path: string
  title: string
  rev: string
  line: number
  text: string
  heading: string
  depth: number
  /** The day of the task's date chip (@2026-11-20), as 2026-11-20. */
  due?: string
}
/** A [[link]] target no page answers to, and the pages that use it. */
export type MissingLink = { target: string; pages: Backlink[] }
/** Something the owner should look at, like backups that aren't running. `section` is the settings section that fixes it. */
export type HealthWarning = { id: string; message: string; section?: string }
export type Session = { authenticated: boolean; setupRequired: boolean; name?: string; version: string; warnings?: HealthWarning[] }
export type Account = { name: string; twoFactor: boolean; recoveryCodes: number; created: number; passwordSet: number; fullWidth: boolean }
export type Device = { id: string; device: string; ip: string; userAgent: string; created: number; lastSeen: number; current: boolean }
export type Revision = { id: number; path: string; created: number; updated: number; source: string; size: number; content?: string }
export type TrashItem = { id: string; path: string; kind: "page" | "space" | "attachment"; deletedAt: number; pages: number }
/** A file in attachments/: the pages that use it, and pages in the trash that do. history: unused, but an old version of a page mentions it. */
export type Attachment = { path: string; size: number; mtime: number; pages: string[]; trashed: string[]; history?: boolean }
/** A page with history but no file: deleted or moved outside Quire. latest: its newest version's revision id. */
export type DeletedPage = { path: string; updated: number; versions: number; latest: number }
export type Share = { token: string; path: string; created: number }
export type PublicPage = { title: string; content: string; updated: number }
/** What an import brought in. renamed: pages that got a number because their name was taken. */
export type ImportSummary = {
  space: string
  pages: number
  attachments: number
  firstPage?: string
  renamed: { from: string; to: string }[]
  skipped: { path: string; reason: string }[]
}

// ── Databases ──

export type ColumnType =
  | "text"
  | "number"
  | "select"
  | "multi"
  | "date"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "page"
  | "relation"
  | "file"
  | "formula"
  | "rollup"
  | "created"
export type SelectOption = { name: string; color?: string }
export type NumberFormat = "number" | "currency" | "percent"
export type Column = {
  id: string
  name: string
  type: ColumnType
  width?: number
  description?: string
  /** Numbers: number, currency, percent. Dates: "datetime" shows the time. Formulas and rollups also: date, text, checkbox. */
  format?: string
  decimals?: number
  currency?: string
  options?: SelectOption[]
  formula?: string
  /** Relation: the page path of the database it links to. */
  target?: string
  /** Rollup: the relation column, the column to read in the linked rows, and how to combine them. */
  relation?: string
  field?: string
  aggregate?: string
}
export type ViewFilter = { column: string; op: string; value?: string }
export type ViewSort = { column: string; desc?: boolean }
export type ChartConfig = { kind: "bar" | "line" | "pie"; x: string; y?: string; aggregate?: string }
export type ViewType = "table" | "board" | "calendar" | "chart" | "gallery"
export type View = {
  id: string
  name: string
  type: ViewType
  filters?: ViewFilter[]
  match?: "any" | "all"
  sorts?: ViewSort[]
  hidden?: string[]
  groupBy?: string
  dateColumn?: string
  endColumn?: string
  /** Column id to the total shown under it: sum, avg, min, max, count, filled, empty, unique, checked, percent. */
  summaries?: Record<string, string>
  chart?: ChartConfig
  wrap?: boolean
}
export type FormField = { column: string; label?: string; help?: string; required?: boolean }
export type Form = {
  id: string
  name: string
  title?: string
  description?: string
  fields: FormField[]
  submit?: string
  thanks?: string
  defaults?: Record<string, string>
  closed?: boolean
  limit?: number
}
export type Schema = { version: number; columns: Column[]; views: View[]; forms?: Form[] }
export type Row = { id: string; created: string; cells: Record<string, string> }
/** A worked-out value: dates come as {date}, errors as {error, message}. */
export type FormulaValue = null | number | string | boolean | { date: string } | { error: string; message: string } | FormulaValue[]
export type TableData = {
  path: string
  rev: string
  schema: Schema
  rows: Row[]
  /** Computed columns: row id, then column id. */
  values: Record<string, Record<string, FormulaValue>>
  errors: Record<string, string>
  /** Titles of linked rows: relation column id, then row id. */
  related: Record<string, Record<string, string>>
  targets: Record<string, string>
}
export type TableInfo = { path: string; title: string; columns: { id: string; name: string; type: ColumnType }[]; rows: number }
export type CalendarEvent = {
  path: string
  /** The title of the database a row is in, or of the page a dated line is on. */
  table: string
  /** Empty for a line of a page. */
  row: string
  title: string
  start: string
  end?: string
  color?: string
  label?: string
  done?: boolean
  /** Unset for a database row; "task" for a dated to-do on a page, "date" for another dated line. */
  kind?: "task" | "date"
  /** Where on its page a task or date is: its line in the file and the heading above it. */
  line?: number
  heading?: string
}
export type FormLink = { token: string; path: string; form: string; created: number; responses: number }
export type FormulaFunction = { name: string; help: string }
export type FormulaResult = { value: FormulaValue; error?: string }
export type FormulaPreview = { error?: string; values: { row: string; title: string; value: FormulaValue }[] }
export type TableTemplate = "" | "tracker" | "calendar" | "budget"

export class ApiError extends Error {
  status: number
  body: Record<string, unknown>
  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.body = body
  }
}

/** Identifies this tab, so it can ignore change events from its own saves. Also the server's CSRF check. */
export const clientId = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)

/** The browser's time zone, so TODAY() and creation times read as here. */
const timeZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""
  } catch {
    return ""
  }
})()

/** Encodes each segment of a vault path for use in a URL. */
export const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/")

/** A web page's title, description, picture and icon, where it has them. */
export type LinkPreview = { title?: string; description?: string; site?: string; image?: string; icon?: string }

/** Asks the server, or for an answer the device keeps a copy of (lib/offline.ts), the copy when the server can't be reached. */
function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  if (method === "GET" && (keeps(url) || url.startsWith("/api/search?"))) return answer(url, () => send<T>(method, url))
  return send<T>(method, url, body)
}

/** timeout: how long to wait for an answer before taking the server as unreachable, in ms. */
async function send<T>(method: string, url: string, body?: unknown, timeout?: number): Promise<T> {
  const headers: Record<string, string> = { "X-Client-Id": clientId }
  if (timeZone) headers["X-Timezone"] = timeZone
  const init: RequestInit = { method, headers, credentials: "same-origin" }
  if (body instanceof FormData) {
    init.body = body
  } else if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)["Content-Type"] = "application/json"
  }
  let res: Response
  const abort = timeout ? new AbortController() : undefined
  const timer = abort && setTimeout(() => abort.abort(), timeout)
  try {
    res = await fetch(url, abort ? { ...init, signal: abort.signal } : init)
  } catch {
    heard(false)
    throw new Unreachable()
  } finally {
    clearTimeout(timer)
  }
  // A proxy in front saying it can't reach Quire is no answer from Quire.
  if (res.status === 502 || res.status === 504) {
    heard(false)
    throw new Unreachable()
  }
  heard(true)
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith("/api/auth/") && !url.startsWith("/api/public/")) {
      forgetShell()
      void removeCopy({ stayOn: true })
      window.dispatchEvent(new Event("quire:signed-out"))
    }
    const msg = (data as { error?: string }).error ?? res.statusText
    throw new ApiError(res.status, msg.charAt(0).toUpperCase() + msg.slice(1), data)
  }
  return data as T
}

/** What the copy on this device sends itself, past the copy. */
const wire = {
  // A phone between networks can leave a request hanging for a minute: past
  // these, the change is kept on the device and sent later instead.
  get: <T>(url: string) => send<T>("GET", url, undefined, 30_000),
  save: (path: string, content: string, baseRev: string, keep: boolean) =>
    send<Note>("PUT", `/api/notes/${encodePath(path)}`, { content, baseRev, ...(keep && { conflict: true }) }, 20_000),
  create: (parent: string, title: string, content: string) => send<Note>("POST", "/api/notes", { parent, title, content }, 20_000),
}
connect(wire)

export const api = {
  session: () => request<Session>("GET", "/api/auth/session"),
  setup: (code: string, name: string, password: string) => request<{ token: string }>("POST", "/api/auth/setup", { code, name, password }),
  login: (password: string, code?: string) => request<{ token: string }>("POST", "/api/auth/login", { password, code: code ?? "" }),
  logout: () =>
    request<void>("POST", "/api/auth/logout").finally(() => {
      forgetShell()
      return removeCopy()
    }),

  account: () => request<Account>("GET", "/api/account"),
  updateAccount: (changes: { name?: string; fullWidth?: boolean }) => request<Account>("PATCH", "/api/account", changes),
  changePassword: (current: string, next: string) => request<void>("POST", "/api/account/password", { current, next }),
  startTwoFactor: (password: string) => request<{ secret: string; uri: string }>("POST", "/api/account/2fa/setup", { password }),
  enableTwoFactor: (code: string) => request<{ recoveryCodes: string[] }>("POST", "/api/account/2fa/enable", { code }),
  disableTwoFactor: (password: string) => request<void>("POST", "/api/account/2fa/disable", { password }),
  newRecoveryCodes: (password: string) => request<{ recoveryCodes: string[] }>("POST", "/api/account/recovery-codes", { password }),
  sessions: () => request<Device[]>("GET", "/api/sessions"),
  revokeSession: (id: string) => request<void>("DELETE", `/api/sessions/${encodeURIComponent(id)}`),
  revokeOtherSessions: () => request<void>("POST", "/api/sessions/revoke-others"),

  spaces: () => request<Space[]>("GET", "/api/spaces"),
  createSpace: (name: string, description: string, color: string, icon: string) => request<Space>("POST", "/api/spaces", { name, description, color, icon }),
  updateSpace: (name: string, patch: Partial<Pick<Space, "name" | "description" | "color" | "icon">>) =>
    request<Space>("PATCH", `/api/spaces/${encodeURIComponent(name)}`, patch),
  deleteSpace: (name: string) => request<void>("DELETE", `/api/spaces/${encodeURIComponent(name)}`),
  /** Sets the order spaces are listed in; spaces left out follow in their current order. */
  arrangeSpaces: (names: string[], sections?: SpaceSection[]) => request<Space[]>("POST", "/api/spaces/order", sections ? { names, sections } : { names }),
  sections: () => request<SpaceSection[]>("GET", "/api/sections"),
  spaceDetails: (name: string) => request<SpaceDetails>("GET", `/api/spaces/${encodeURIComponent(name)}`),
  tasks: (space: string) => request<Task[]>("GET", `/api/spaces/${encodeURIComponent(space)}/tasks`),
  missingLinks: (space: string) => request<MissingLink[]>("GET", `/api/spaces/${encodeURIComponent(space)}/missing-links`),

  backup: () => request<BackupSettings>("GET", "/api/backup"),
  saveBackup: (input: BackupInput, current: string) => request<BackupSettings>("PUT", "/api/backup", { ...input, current }),
  testBackup: (input: BackupInput) => request<void>("POST", "/api/backup/test", input),
  runBackup: () => request<BackupStatus>("POST", "/api/backup/run"),
  removeBackup: () => request<void>("DELETE", "/api/backup"),

  tree: () => request<Tree>("GET", "/api/tree"),
  note: (path: string) => request<Note>("GET", `/api/notes/${encodePath(path)}`),
  /** conflict: this is the version kept after a conflicting edit; history keeps it beside the other. */
  save: (path: string, content: string, baseRev?: string, conflict = false) => saveNote(path, content, baseRev, conflict, wire.save),
  create: (parent: string, title: string, content = "") => createNote(parent, title, content, wire.create),
  remove: async (path: string) => {
    // A page made with no connection only exists here so far.
    if (await removeLocal(path)) return
    return request<void>("DELETE", `/api/notes/${encodePath(path)}`)
  },
  move: async (from: string, to: string) => {
    const local = await renameLocal(from, to)
    if (local) return local
    try {
      return await request<{ path: string; updated: string[] }>("POST", "/api/move", { from, to })
    } catch (e) {
      if (e instanceof Unreachable) throw new Unreachable("Renaming or moving this page needs a connection")
      throw e
    }
  },
  /** Places a page under parent (a space or page path), before the sibling page `before` or last. */
  reorder: (path: string, parent: string, before = "") =>
    request<{ path: string; updated: string[] }>("POST", "/api/reorder", { path, parent, before }),
  search: (q: string, limit = 20) => request<Hit[]>("GET", `/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  tags: () => request<Tag[]>("GET", "/api/tags"),
  graph: (space: string) => request<Graph>("GET", `/api/graph?space=${encodeURIComponent(space)}`),
  upload: (file: File) => {
    const fd = new FormData()
    fd.append("file", file)
    return request<{ path: string; markdown: string; kind: "image" | "video" | "file"; name: string }>("POST", "/api/attachments", fd)
  },

  attachments: () => request<{ items: Attachment[]; total: number }>("GET", "/api/attachments"),
  /** Moves unused attachments to the trash; ones a page uses are kept, with the reason. */
  trashAttachments: (paths: string[]) =>
    request<{ trashed: string[]; kept: { path: string; reason: string }[] }>("POST", "/api/attachments/trash", { paths }),
  /** Renames an attachment in its folder and updates the pages that use it. */
  renameAttachment: (path: string, name: string) =>
    request<{ path: string; updated: string[] }>("POST", "/api/attachments/rename", { path, name }),
  /** Imports a .zip or Markdown files into a space, or a new one. onProgress gets 0–1 as the upload goes. */
  importFiles: (target: { space: string } | { newSpace: string }, files: File[], onProgress?: (done: number) => void) =>
    new Promise<ImportSummary>((resolve, reject) => {
      const fd = new FormData()
      for (const f of files) fd.append("file", f)
      // XMLHttpRequest rather than fetch, for upload progress.
      const xhr = new XMLHttpRequest()
      xhr.open("POST", `/api/import?${new URLSearchParams(target)}`)
      xhr.setRequestHeader("X-Client-Id", clientId)
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
      xhr.onload = () => {
        let data: Record<string, unknown> = {}
        try {
          data = JSON.parse(xhr.responseText)
        } catch {
          // An empty or non-JSON body; the status says enough.
        }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data as ImportSummary)
        if (xhr.status === 401) window.dispatchEvent(new Event("quire:signed-out"))
        const msg = (data.error as string | undefined) ?? xhr.statusText
        reject(new ApiError(xhr.status, msg.charAt(0).toUpperCase() + msg.slice(1), data))
      }
      xhr.onerror = () => reject(new ApiError(0, "The upload didn't get through. Check the connection and try again."))
      xhr.send(fd)
    }),

  history: (path: string) => request<Revision[]>("GET", `/api/history/${encodePath(path)}`),
  revision: (id: number) => request<Revision>("GET", `/api/revisions/${id}`),
  restoreRevision: (id: number) => request<Note>("POST", `/api/revisions/${id}/restore`).then(keepNote),
  deletedPages: () => request<DeletedPage[]>("GET", "/api/deleted-pages"),

  trash: () => request<{ items: TrashItem[]; retentionDays: number }>("GET", "/api/trash"),
  restoreTrash: (id: string) => request<{ path: string; page?: string; space?: string }>("POST", `/api/trash/${encodeURIComponent(id)}/restore`),
  purgeTrash: (id: string) => request<void>("DELETE", `/api/trash/${encodeURIComponent(id)}`),
  emptyTrash: () => request<void>("DELETE", "/api/trash"),

  shares: (path?: string) => request<Share[]>("GET", `/api/shares${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  share: (path: string) => request<Share>("POST", "/api/shares", { path }),
  unshare: (token: string) => request<void>("DELETE", `/api/shares/${encodeURIComponent(token)}`),
  publicPage: (token: string) => request<PublicPage>("GET", `/api/public/${encodeURIComponent(token)}`),

  tables: () => request<TableInfo[]>("GET", "/api/tables"),
  table: (path: string) => request<TableData>("GET", tableUrl(path)),
  createTable: (parent: string, title: string, template: TableTemplate = "") => request<Note>("POST", "/api/tables", { parent, title, template }),
  /** Turns a page into a database, keeping its text. */
  convertTable: (path: string) => request<Note>("POST", "/api/tables/convert", { path }),
  saveSchema: (path: string, schema: Schema, baseRev?: string) => request<TableData>("PUT", tableUrl(path, "schema"), { schema, baseRev: baseRev ?? "" }).then(keepTable),
  /** Adds rows before the row `before`, or last. Cells are keyed by column id, as typed. */
  addRows: (path: string, rows: { cells: Record<string, string> }[], before = "") => request<TableData>("POST", tableUrl(path, "rows"), { rows, before }).then(keepTable),
  updateRows: (path: string, rows: { id: string; cells: Record<string, string> }[]) => request<TableData>("PATCH", tableUrl(path, "rows"), { rows }).then(keepTable),
  deleteRows: (path: string, ids: string[]) => request<TableData>("POST", tableUrl(path, "rows/delete"), { ids }).then(keepTable),
  moveRows: (path: string, ids: string[], before = "") => request<TableData>("POST", tableUrl(path, "rows/move"), { ids, before }).then(keepTable),
  previewFormula: (path: string, formula: string, column = "") => request<FormulaPreview>("POST", tableUrl(path, "preview"), { formula, column }),
  importRows: (path: string, file: File) => {
    const fd = new FormData()
    fd.append("file", file)
    return request<TableData>("POST", tableUrl(path, "import"), fd)
  },
  /** Makes a new database page from a CSV, TSV or .xlsx file. */
  importTable: (parent: string, title: string, file: File) => {
    const fd = new FormData()
    fd.append("parent", parent)
    fd.append("title", title)
    fd.append("file", file)
    return request<Note>("POST", "/api/tables/import", fd)
  },
  tableHistory: (path: string) => request<Revision[]>("GET", tableUrl(path, "history")),
  restoreTable: (path: string, revision: number) => request<TableData>("POST", tableUrl(path, "restore"), { revision }),
  submitForm: (path: string, form: string, answers: Record<string, string>) =>
    request<void>("POST", tableUrl(path, `forms/${encodeURIComponent(form)}/submit`), { answers }),
  /** Works out {{ … }} formulas on a page. */
  evalFormulas: (path: string, formulas: string[]) => request<FormulaResult[]>("POST", "/api/formulas", { path, formulas }),
  functions: () => request<FormulaFunction[]>("GET", "/api/formulas/functions"),
  /** What the web page at url says about itself, for a bookmark card. The server reads the page. */
  linkPreview: (url: string) => request<LinkPreview>("GET", `/api/link-preview?url=${encodeURIComponent(url)}`),
  /** Rows on every database's calendar views between from and to (YYYY-MM-DD). */
  calendar: (from: string, to: string) => request<CalendarEvent[]>("GET", `/api/calendar?from=${from}&to=${to}`),
  formLinks: (path?: string) => request<FormLink[]>("GET", `/api/form-links${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  createFormLink: (path: string, form: string) => request<FormLink>("POST", "/api/form-links", { path, form }),
  deleteFormLink: (token: string) => request<void>("DELETE", `/api/form-links/${encodeURIComponent(token)}`),
}

export const tableUrl = (path: string, action = "") => `/api/tables/${encodePath(path)}${action ? `/${action}` : ""}`
export const tableExportUrl = (path: string) => tableUrl(path, "export")
export const publicFormUrl = (token: string) => `${location.origin}/f/${token}`

export const fileUrl = (p: string) => `/api/files/${encodePath(p)}`
export const spaceExportUrl = (name: string) => `/api/spaces/${encodeURIComponent(name)}/export`
export const publicFileUrl = (token: string) => (p: string) => `/api/public/${encodeURIComponent(token)}/files/${encodePath(p)}`
export const shareUrl = (token: string) => `${location.origin}/share/${token}`
