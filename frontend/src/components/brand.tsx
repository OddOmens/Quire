import { cn } from "cn"

/** Quire's mark: Lucide's scroll-text (ISC licence), as on the app icon. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-6", className)} aria-hidden>
      {/* Black with a white glyph in both themes; the hairline keeps the plate's edge visible on dark surfaces. */}
      <rect x=".5" y=".5" width="31" height="31" rx="6.5" fill="#000" className="stroke-black dark:stroke-white/15" />
      <g transform="translate(6 6) scale(.8333)" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 12h-5M15 8h-5" />
        <path d="M19 17V5a2 2 0 0 0-2-2H4" />
        <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />
      </g>
    </svg>
  )
}

export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <Logo />
      <span className="text-[0.95rem] font-semibold tracking-[-0.01em]">Quire</span>
    </span>
  )
}
