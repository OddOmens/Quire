import { cn } from "cn"
import { Icon } from "lucide-react"

import { useLucideIcon } from "@/lib/lucide"
import { initials } from "@/lib/notes"

/** A space's coloured square with its Lucide icon, or its initials when it has none. */
export function SpaceAvatar({ name, color, icon, className }: { name: string; color?: string; icon?: string; className?: string }) {
  const glyph = useLucideIcon(icon || undefined)
  return (
    <span
      aria-hidden
      className={cn("grid size-6 shrink-0 place-items-center rounded-md text-[0.65rem] font-semibold tracking-wide text-white select-none", className)}
      style={{ background: color || "var(--muted-foreground)" }}
    >
      {glyph ? <Icon icon={glyph} className="size-[62%]" strokeWidth={2.25} /> : glyph === undefined ? null : initials(name)}
    </span>
  )
}
