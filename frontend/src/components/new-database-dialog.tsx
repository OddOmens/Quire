import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"
import { CalendarDays, FileSpreadsheet, Kanban, Table2, Wallet } from "lucide-react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { errorMessage } from "@/hooks/use-vault"
import { api, type Note, type TableTemplate } from "@/lib/api"
import { pageUrl, titleOf } from "@/lib/notes"
import { onUiEvent } from "@/lib/ui-events"

const templates: { id: TableTemplate; label: string; hint: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "", label: "Blank", hint: "A Name column to start from", icon: Table2 },
  { id: "tracker", label: "Tracker", hint: "Status, due date and a board", icon: Kanban },
  { id: "calendar", label: "Calendar", hint: "Dates and times on a calendar", icon: CalendarDays },
  { id: "budget", label: "Budget", hint: "Amounts by category, with a total", icon: Wallet },
]

/**
 * Creates a database page under a space or page, from a template or from a
 * CSV, TSV or Excel file. Opened with openNewDatabase().
 */
export function NewDatabaseDialog() {
  const [state, setState] = useState<{ parent: string; mode: "new" | "import" } | null>(null)
  const [title, setTitle] = useState("")
  const [template, setTemplate] = useState<TableTemplate>("")
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const qc = useQueryClient()
  const navigate = useNavigate()

  useEffect(
    () =>
      onUiEvent<{ parent: string; mode: "new" | "import" }>("quire:new-database", (d) => {
        setTitle("")
        setTemplate("")
        setFile(null)
        setState(d)
      }),
    [],
  )

  const importing = state?.mode === "import"

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!state || (importing && !file)) return
    const name = title.trim() || (importing && file ? file.name.replace(/\.[^.]+$/, "") : "Untitled database")
    setBusy(true)
    try {
      let note: Note
      if (importing && file) note = await api.importTable(state.parent, name, file)
      else note = await api.createTable(state.parent, name, template)
      qc.setQueryData(["note", note.path], note)
      for (const key of ["tree", "tables", "spaces"]) qc.invalidateQueries({ queryKey: [key] })
      navigate(pageUrl(note.path))
      setState(null)
      if (importing) toast.success(`Imported “${titleOf(note.path)}”`)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && !busy && setState(null)}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={save} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{importing ? "Import a database" : "New database"}</DialogTitle>
            <DialogDescription>
              {importing
                ? "Each row of the file becomes a row. Column types are guessed from the values; you can change them later."
                : "A page with rows and columns. You can add columns, views and forms after."}
            </DialogDescription>
          </DialogHeader>

          {importing && (
            <div className="grid gap-2">
              <Label>File</Label>
              <input
                ref={fileInput}
                type="file"
                hidden
                accept=".csv,.tsv,.txt,.xlsx,text/csv"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null
                  setFile(f)
                  if (f && !title.trim()) setTitle(f.name.replace(/\.[^.]+$/, ""))
                }}
              />
              <Button type="button" variant="outline" className="justify-start font-normal" onClick={() => fileInput.current?.click()}>
                <FileSpreadsheet className="text-muted-foreground" />
                <span className="truncate">{file ? file.name : "Choose a CSV, TSV or Excel file…"}</span>
              </Button>
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="db-title">Name</Label>
            <Input
              id="db-title"
              autoFocus={!importing}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={importing ? "Named after the file" : "Untitled database"}
            />
          </div>

          {!importing && (
            <div className="grid gap-2">
              <Label>Start with</Label>
              <div role="radiogroup" aria-label="Template" className="grid grid-cols-2 gap-2">
                {templates.map((t) => (
                  <button
                    key={t.id || "blank"}
                    type="button"
                    role="radio"
                    aria-checked={template === t.id}
                    onClick={() => setTemplate(t.id)}
                    className={cn(
                      "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors hover:bg-accent",
                      template === t.id && "border-foreground bg-accent",
                    )}
                  >
                    <t.icon className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{t.label}</span>
                    <span className="text-xs text-muted-foreground">{t.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setState(null)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || (importing && !file)}>
              {importing ? "Import" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
