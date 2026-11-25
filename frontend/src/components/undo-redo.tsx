import { Redo2, Undo2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/** Undo and redo for whichever editor a page shows: the visual one or the Markdown source. */
export type HistoryControls = {
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}

/** Is this key press undo (⌘Z) or redo (⌘⇧Z, Ctrl+Y)? */
export function historyKey(e: KeyboardEvent): "undo" | "redo" | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null
  const k = e.key.toLowerCase()
  if (k === "z") return e.shiftKey ? "redo" : "undo"
  if (k === "y" && e.ctrlKey && !e.shiftKey) return "redo"
  return null
}

/** Fields that keep their own undo history: text inputs, other editors, dialogs and menus. */
export function hasOwnHistory(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target.closest("textarea, select, .cm-editor, [role=dialog], [role=menu]")) return true
  return target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "reset"].includes(target.type)
}

export function UndoRedoButtons({ controls }: { controls: HistoryControls | null }) {
  const items = [
    { label: "Undo", shortcut: "⌘Z", icon: Undo2, enabled: !!controls?.canUndo, run: () => controls?.undo() },
    { label: "Redo", shortcut: "⌘⇧Z", icon: Redo2, enabled: !!controls?.canRedo, run: () => controls?.redo() },
  ]
  return (
    // The narrowest phones have no room for these beside the page's name; the bar above the keyboard has them too.
    <div className="flex items-center max-[359px]:hidden">
      {items.map((i) => (
        <Tooltip key={i.label}>
          <TooltipTrigger asChild>
            {/* The span keeps the tooltip working while the button is disabled. */}
            <span tabIndex={-1}>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={i.label}
                disabled={!i.enabled}
                // Keep focus and the selection in the editor.
                onMouseDown={(e) => e.preventDefault()}
                onClick={i.run}
              >
                <i.icon />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {i.label} <span className="ml-1 opacity-60">{i.shortcut}</span>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
