import { useState } from "react"
import { ShieldAlert, X } from "lucide-react"

import type { SecretWarning } from "@/lib/api"

/** "This page may contain a secret (Tailscale key, line 12)." */
export function secretWarningText(warnings: SecretWarning[]) {
  const [first] = warnings
  const more = warnings.length > 1 ? `, and ${warnings.length - 1} more` : ""
  return `This page may contain a secret (${first.label}, line ${first.line}${more}).`
}

/**
 * A quiet, dismissible note that the page looks like it holds a secret.
 * Dismissing lasts until something else is flagged; editing other lines
 * doesn't bring it back.
 */
export function SecretWarningBanner({ warnings }: { warnings?: SecretWarning[] }) {
  const key = (warnings ?? []).map((w) => `${w.kind}:${w.preview}`).join(",")
  const [dismissed, setDismissed] = useState("")
  if (!warnings?.length || dismissed === key) return null
  return (
    <div role="status" className="mb-5 flex items-start gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[0.8125rem]">
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
      <div className="min-w-0 flex-1">
        <p>{secretWarningText(warnings)} Quire pages are stored as plain text and copied into backups.</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Keep the secret's name here and its value in a password manager. If it's meant to be here, add <code>secrets: ok</code> to the
          page's front matter.
        </p>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(key)}
        className="-mr-1 rounded p-0.5 text-muted-foreground transition-colors hover:bg-amber-500/15 hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
