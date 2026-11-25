import { useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { CircleCheck, FileArchive, Loader2, Upload } from "lucide-react"
import { Link } from "react-router"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { errorMessage, useSpaces } from "@/hooks/use-vault"
import { api, type ImportSummary } from "@/lib/api"
import { formatBytes, pageUrl, spaceUrl } from "@/lib/notes"

const MAX_UPLOAD = 500 * 1024 * 1024

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`

/** Settings → Import: a zip or Markdown files into a new or existing space. */
export function ImportSection() {
  const { data: spaces } = useSpaces()
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [into, setInto] = useState<"new" | "existing">("new")
  const [newName, setNewName] = useState("")
  const [space, setSpace] = useState("")
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<ImportSummary | null>(null)

  const target = space || spaces?.[0]?.name || ""
  const size = files.reduce((n, f) => n + f.size, 0)
  const zips = files.filter((f) => /\.zip$/i.test(f.name)).length
  const problem =
    size > MAX_UPLOAD ? "That's over 500 MB." : zips && files.length > 1 ? "Choose one .zip, or Markdown files without a zip." : ""
  const ready = files.length > 0 && !problem && (into === "new" ? newName.trim() : target) && progress === null

  const run = async () => {
    setProgress(0)
    setResult(null)
    try {
      const res = await api.importFiles(into === "new" ? { newSpace: newName.trim() } : { space: target }, files, setProgress)
      setResult(res)
      setFiles([])
      setNewName("")
      if (input.current) input.current.value = ""
      for (const key of ["tree", "spaces", "tags", "graph", "missing-links", "attachments"]) qc.invalidateQueries({ queryKey: [key] })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setProgress(null)
    }
  }

  return (
    <div className="grid gap-5 py-7">
      <div className="grid gap-1.5 text-[0.8125rem] leading-relaxed text-muted-foreground">
        <p>
          Zip a folder of Markdown and upload it: plain folders, an Obsidian vault, or a Markdown export from Notion or Docmost. Or choose a few .md files and
          the pictures they use.
        </p>
        <p>
          Folders become sub-pages, and a folder's <code className="text-foreground">index.md</code> or <code className="text-foreground">README.md</code> becomes its
          page. Pictures and files the pages use go to attachments, and links between pages become [[links]]. Nothing is overwritten: a page whose name is taken
          gets a number. Up to 500 MB.
        </p>
      </div>

      <div className="grid max-w-lg gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="import-files">Files</Label>
          <input
            ref={input}
            id="import-files"
            type="file"
            multiple
            accept=".zip,.md,.markdown,image/*,video/*,.pdf"
            className="sr-only"
            onChange={(e) => {
              setFiles([...(e.target.files ?? [])])
              setResult(null)
            }}
          />
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()} disabled={progress !== null}>
              <FileArchive /> Choose files
            </Button>
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {files.length === 0 ? "No files chosen" : files.length === 1 ? `${files[0].name} · ${formatBytes(size)}` : `${plural(files.length, "file")} · ${formatBytes(size)}`}
            </span>
          </div>
          {problem && <p className="text-xs text-destructive">{problem}</p>}
        </div>

        <div className="grid gap-1.5">
          <Label>Import into</Label>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant={into === "new" ? "default" : "outline"} onClick={() => setInto("new")}>
              A new space
            </Button>
            <Button type="button" size="sm" variant={into === "existing" ? "default" : "outline"} onClick={() => setInto("existing")} disabled={!spaces?.length}>
              An existing space
            </Button>
          </div>
        </div>

        {into === "new" ? (
          <div className="grid gap-1.5">
            <Label htmlFor="import-name">Space name</Label>
            <Input id="import-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Imported notes" maxLength={120} />
          </div>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor="import-space">Space</Label>
            <select
              id="import-space"
              value={target}
              onChange={(e) => setSpace(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {spaces?.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button onClick={() => void run()} disabled={!ready}>
            {progress !== null ? <Loader2 className="animate-spin" /> : <Upload />} Import
          </Button>
          {progress !== null && (
            <span className="text-sm text-muted-foreground tabular-nums">{progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : "Importing…"}</span>
          )}
        </div>
      </div>

      {result && <ImportResult result={result} />}
    </div>
  )
}

function ImportResult({ result }: { result: ImportSummary }) {
  return (
    <div className="rounded-lg border">
      <div className="flex items-start gap-3 p-4">
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-green-600 dark:text-green-400" />
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-medium">
            Imported {plural(result.pages, "page")} and {plural(result.attachments, "attachment")} into {result.space}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {result.renamed.length ? `${plural(result.renamed.length, "page")} renamed` : "No pages renamed"} ·{" "}
            {result.skipped.length ? `${plural(result.skipped.length, "file")} skipped` : "nothing skipped"}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {result.firstPage && (
            <Button size="sm" variant="ghost" asChild>
              <Link to={pageUrl(result.firstPage)}>Open first page</Link>
            </Button>
          )}
          <Button size="sm" variant="outline" asChild>
            <Link to={spaceUrl(result.space)}>Open space</Link>
          </Button>
        </div>
      </div>
      {result.renamed.length > 0 && (
        <ResultList title="Renamed, because the name was taken">
          {result.renamed.map((r, i) => (
            <li key={i} className="truncate">
              {r.from} <span className="text-muted-foreground">→</span> {r.to}
            </li>
          ))}
        </ResultList>
      )}
      {result.skipped.length > 0 && (
        <ResultList title="Skipped">
          {result.skipped.map((s, i) => (
            <li key={i} className="truncate">
              {s.path} <span className="text-muted-foreground">· {s.reason}</span>
            </li>
          ))}
        </ResultList>
      )}
    </div>
  )
}

function ResultList({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t px-4 py-3">
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">{title}</div>
      <ul className="grid max-h-48 gap-0.5 overflow-y-auto font-mono text-xs">{children}</ul>
    </div>
  )
}
