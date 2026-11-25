import { lazy, Suspense, useState } from "react"
import { ChevronDown } from "lucide-react"

import { SpaceAvatar } from "@/components/space-avatar"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"

const loadPanel = () => import("@/components/icon-picker-panel")
const IconPickerPanel = lazy(loadPanel)

/** Picks a space's Lucide icon, or none for its initials. */
export function IconPicker({ value, onChange, name, color, id }: { value: string; onChange: (icon: string) => void; name: string; color: string; id?: string }) {
  const [open, setOpen] = useState(false)
  const [touch, setTouch] = useState(false)
  const pick = (icon: string) => {
    onChange(icon)
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          aria-label={`Icon: ${value || "initials"}`}
          className="w-fit min-w-36 justify-start gap-2 pr-2 pl-1.5 font-normal"
          // Fetch the picker while the pointer is on its way.
          onPointerEnter={() => void loadPanel()}
          onPointerDown={(e) => setTouch(e.pointerType === "touch")}
          onFocus={() => void loadPanel()}
        >
          <SpaceAvatar name={name || "?"} color={color} icon={value} className="size-5.5 rounded text-[0.55rem]" />
          <span className="max-w-40 truncate">{value || "Initials"}</span>
          <ChevronDown className="ml-auto text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] gap-0 overflow-hidden p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        <Suspense fallback={<Skeleton className="m-2 h-[23rem] rounded-md" />}>
          <IconPickerPanel value={value} color={color} onPick={pick} focusList={touch} />
        </Suspense>
      </PopoverContent>
    </Popover>
  )
}
