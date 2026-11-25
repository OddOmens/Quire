import { useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import { CircleAlert, CircleCheck } from "lucide-react"
import { Link, useLocation, useNavigate } from "react-router"
import { toast } from "sonner"

import { api, type HealthWarning } from "@/lib/api"

const NOTICED = "quire.noticed-warnings"

const settingsUrl = (w: HealthWarning) => (w.section ? `/settings/${w.section}` : "/settings/about")

function noticed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(NOTICED) ?? "[]")
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/**
 * Tells the owner once about anything that needs attention, as a quiet toast
 * when the app opens. A warning that clears and later comes back is shown
 * again; one the owner has already seen isn't repeated on every load.
 */
export function useHealthNotice() {
  const { data } = useQuery({ queryKey: ["session"], queryFn: api.session, staleTime: Infinity })
  const navigate = useNavigate()
  // Settings lists the warnings itself, so changes made there don't pop up.
  const onSettings = useLocation().pathname.startsWith("/settings")
  const warnings = data?.warnings
  useEffect(() => {
    if (!warnings) return
    const seen = noticed()
    const fresh = warnings.filter((w) => !seen.includes(w.id))
    try {
      localStorage.setItem(NOTICED, JSON.stringify(warnings.map((w) => w.id)))
    } catch {
      // Private mode: shown again next time.
    }
    if (fresh.length === 0 || onSettings) return
    const first = fresh[0]
    toast.warning(fresh.length === 1 ? "Quire needs attention" : `Quire needs attention (${fresh.length})`, {
      id: "health",
      description: first.message,
      duration: 12000,
      action: { label: "Review", onClick: () => navigate(fresh.length === 1 ? settingsUrl(first) : "/settings/about") },
    })
  }, [warnings, navigate, onSettings])
}

/** The warnings, refreshed whenever a settings section showing them opens. */
export function useWarnings() {
  const { data } = useQuery({ queryKey: ["session"], queryFn: api.session, staleTime: 0, refetchOnMount: "always" })
  return data?.warnings
}

/** A list of warnings for the settings pages; `empty` is shown when there are none. */
export function HealthList({ warnings, empty, links = true }: { warnings: HealthWarning[]; empty?: string; links?: boolean }) {
  if (warnings.length === 0) {
    return empty ? (
      <p className="flex items-center gap-2 text-sm">
        <CircleCheck className="size-4 shrink-0 text-green-600 dark:text-green-400" /> {empty}
      </p>
    ) : null
  }
  return (
    <ul className="grid gap-2">
      {warnings.map((w) => (
        <li key={w.id} className="flex items-start gap-2.5 rounded-lg bg-(--callout-warning-bg) px-3 py-2.5 text-[0.8125rem] leading-relaxed">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-(--callout-warning-fg)" />
          <span className="min-w-0 flex-1 break-words">
            {w.message}
            {links && w.section && w.section !== "about" && (
              <>
                {" "}
                <Link to={settingsUrl(w)} className="font-medium whitespace-nowrap underline-offset-4 hover:underline">
                  Open {w.section === "backups" ? "Backups" : "settings"}
                </Link>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}
