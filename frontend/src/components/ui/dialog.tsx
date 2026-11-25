import * as React from "react"
import { cn } from "cn"
import { Dialog as DialogPrimitive } from "radix-ui"

import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 max-sm:bg-black/40 max-sm:duration-300",
        className
      )}
      {...props}
    />
  )
}

/** How a dialog shows on phones: a sheet from the bottom, the whole screen, or a centred card. */
type MobileStyle = "sheet" | "full" | "center"

const mobileStyles: Record<MobileStyle, string> = {
  sheet:
    "max-sm:inset-x-0 max-sm:bottom-(--kb) max-sm:max-h-[calc(100dvh-var(--kb)-env(safe-area-inset-top)-0.5rem)] max-sm:overflow-y-auto max-sm:overscroll-contain max-sm:rounded-t-2xl max-sm:pt-7 max-sm:pb-[calc(1rem+env(safe-area-inset-bottom))] max-sm:duration-300 max-sm:ease-(--ease-ios) max-sm:data-open:slide-in-from-bottom max-sm:data-closed:slide-out-to-bottom",
  full:
    "max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:rounded-none max-sm:pt-[calc(0.75rem+env(safe-area-inset-top))] max-sm:pb-[calc(0.75rem+env(safe-area-inset-bottom))] max-sm:ring-0 max-sm:duration-300 max-sm:ease-(--ease-ios) max-sm:data-open:slide-in-from-bottom max-sm:data-closed:slide-out-to-bottom",
  center:
    "max-sm:top-1/2 max-sm:left-1/2 max-sm:max-w-[calc(100%-2rem)] max-sm:-translate-x-1/2 max-sm:-translate-y-1/2 max-sm:rounded-xl max-sm:data-open:zoom-in-95 max-sm:data-closed:zoom-out-95",
}

/** Drag a sheet down by its top edge to dismiss it, as on iOS. */
function useSwipeToClose(enabled: boolean, close: () => void) {
  const drag = React.useRef<{ y: number; dy: number } | null>(null)
  if (!enabled) return {}
  const el = (e: React.TouchEvent) => e.currentTarget as HTMLElement
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const node = el(e)
      if (window.innerWidth >= 640 || node.scrollTop > 0) return
      // Only from the grabber and title area, so inner scrolling and inputs still work.
      if (e.touches[0].clientY - node.getBoundingClientRect().top > 64) return
      drag.current = { y: e.touches[0].clientY, dy: 0 }
    },
    onTouchMove: (e: React.TouchEvent) => {
      const d = drag.current
      if (!d) return
      d.dy = Math.max(0, e.touches[0].clientY - d.y)
      const node = el(e)
      node.style.transition = "none"
      node.style.transform = `translateY(${d.dy}px)`
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const d = drag.current
      drag.current = null
      if (!d) return
      const node = el(e)
      node.style.transition = "transform 0.25s var(--ease-ios)"
      if (d.dy > 80) close()
      else node.style.transform = ""
    },
  }
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  mobile = "sheet",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  mobile?: MobileStyle
}) {
  const closeRef = React.useRef<HTMLButtonElement>(null)
  const swipe = useSwipeToClose(mobile === "sheet", () => closeRef.current?.click())
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-mobile={mobile}
        className={cn(
          "fixed z-50 grid w-full gap-4 bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          "sm:top-1/2 sm:left-1/2 sm:max-w-sm sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:data-open:zoom-in-95 sm:data-closed:zoom-out-95",
          mobileStyles[mobile],
          className
        )}
        {...swipe}
        {...props}
      >
        {mobile === "sheet" && (
          <div aria-hidden className="absolute top-2 left-1/2 h-1.5 w-9 -translate-x-1/2 rounded-full bg-muted-foreground/30 sm:hidden" />
        )}
        {children}
        <DialogPrimitive.Close ref={closeRef} tabIndex={-1} aria-hidden className="sr-only" />
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className={cn(
                "absolute top-2 right-2",
                mobile === "sheet" && "max-sm:top-3 max-sm:right-3 max-sm:rounded-full max-sm:bg-muted",
                mobile === "full" && "max-sm:top-[calc(0.5rem+env(safe-area-inset-top))]"
              )}
              size="icon-sm"
            >
              <XIcon
              />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        // Phone sheets: reach the bottom edge, with big full-width buttons.
        "max-sm:in-data-[mobile=sheet]:-mb-[calc(1rem+env(safe-area-inset-bottom))] max-sm:in-data-[mobile=sheet]:rounded-none max-sm:in-data-[mobile=sheet]:pb-[calc(1rem+env(safe-area-inset-bottom))] max-sm:[&_[data-slot=button]]:h-11 max-sm:[&_[data-slot=button]]:text-[0.9375rem]",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
