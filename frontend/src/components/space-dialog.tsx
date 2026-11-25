import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"
import { Check } from "lucide-react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { IconPicker } from "@/components/icon-picker"
import { SpaceAvatar } from "@/components/space-avatar"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage, useSpaces } from "@/hooks/use-vault"
import { api } from "@/lib/api"
import { spaceUrl } from "@/lib/notes"
import { onUiEvent } from "@/lib/ui-events"

export const SPACE_COLORS = ["#4c6ef5", "#12b886", "#fa5252", "#f59f00", "#7950f2", "#15aabf", "#e64980", "#82c91e", "#495057"]

/** Creates a space. Opened with openSpaceDialog(); editing happens on the space's settings page. */
export function SpaceDialog() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [color, setColor] = useState(SPACE_COLORS[0])
  const [icon, setIcon] = useState("")
  const [busy, setBusy] = useState(false)
  const { data: spaces } = useSpaces()
  const qc = useQueryClient()
  const navigate = useNavigate()

  useEffect(
    () =>
      onUiEvent("quire:space-dialog", () => {
        setName("")
        setDescription("")
        setIcon("")
        setColor(SPACE_COLORS[(spaces?.length ?? 0) % SPACE_COLORS.length])
        setOpen(true)
      }),
    [spaces],
  )

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    try {
      const sp = await api.createSpace(name.trim(), description, color, icon)
      for (const key of ["spaces", "tree"]) qc.invalidateQueries({ queryKey: [key] })
      navigate(spaceUrl(sp.name))
      setOpen(false)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={save} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>New space</DialogTitle>
            <DialogDescription>A space groups related pages. It's a folder in your vault.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3">
            <SpaceAvatar name={name || "?"} color={color} icon={icon} className="size-11 rounded-lg text-sm" />
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor="space-name">Name</Label>
              <Input id="space-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Product" autoFocus maxLength={80} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="space-desc">Description</Label>
            <Textarea id="space-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's this space for? (optional)" rows={2} maxLength={280} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="space-icon">Icon</Label>
            <IconPicker id="space-icon" value={icon} onChange={setIcon} name={name} color={color} />
          </div>
          <div className="grid gap-2">
            <Label>Colour</Label>
            <div className="flex flex-wrap gap-2">
              {SPACE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Colour ${c}`}
                  aria-pressed={c === color}
                  onClick={() => setColor(c)}
                  className={cn("grid size-7 place-items-center rounded-full ring-offset-2 ring-offset-background transition", c === color && "ring-2 ring-foreground/70")}
                  style={{ background: c }}
                >
                  {c === color && <Check className="size-3.5 text-white" />}
                </button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || busy}>
              Create space
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
