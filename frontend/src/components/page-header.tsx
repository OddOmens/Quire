import { cn } from "cn"

/** The bar across the top of a page's content. */
export function PageHeader({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <header className={cn("flex h-12 shrink-0 items-center gap-1.5 px-3 md:h-14 md:px-5", className)}>{children}</header>
}

/** A scrolling page with an optional header. */
export function Page({ header, children, className }: { header?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {header && <PageHeader>{header}</PageHeader>}
      <div className={cn("min-h-0 flex-1 overflow-y-auto max-md:pb-(--sab)", className)}>{children}</div>
    </div>
  )
}
