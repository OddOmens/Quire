import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Copy, Globe, Link2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { errorMessage } from "@/hooks/use-vault"
import { api, shareUrl } from "@/lib/api"
import { pageUrl } from "@/lib/notes"

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-8 shrink-0"
      onClick={() => {
        void navigator.clipboard?.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <Check /> : <Copy />} {copied ? "Copied" : label}
    </Button>
  )
}

/** Publishing a page to the web, and copying its link. */
export function SharePopover({ path, disabled }: { path: string; disabled?: boolean }) {
  const qc = useQueryClient()
  const { data: shares } = useQuery({ queryKey: ["shares", path], queryFn: () => api.shares(path) })
  const share = shares?.[0]
  const [busy, setBusy] = useState(false)

  const toggle = async (on: boolean) => {
    setBusy(true)
    try {
      if (on) await api.share(path)
      else if (share) await api.unshare(share.token)
      await qc.invalidateQueries({ queryKey: ["shares"] })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 rounded-lg px-2.5 max-md:border-transparent max-md:bg-transparent max-sm:w-8 max-sm:px-0" disabled={disabled}>
          {share ? <Globe className="text-brand" /> : <Link2 />}
          {/* On a phone the icon alone, so the page's name has room beside it. */}
          <span className="max-sm:sr-only">Share</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] p-0">
        <div className="flex items-start gap-3 p-4">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
            <Globe className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Share to web</div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              Anyone with the link can read this page. Sub-pages and links to other pages stay private.
            </p>
          </div>
          <Switch checked={!!share} disabled={busy} onCheckedChange={(on) => void toggle(on)} aria-label="Share to web" />
        </div>
        {share && (
          <div className="flex gap-2 px-4 pb-4">
            <Input readOnly value={shareUrl(share.token)} className="h-8 text-xs" onFocus={(e) => e.currentTarget.select()} />
            <CopyButton text={shareUrl(share.token)} label="Copy" />
          </div>
        )}
        <div className="flex items-center justify-between border-t px-4 py-3">
          <span className="text-xs text-muted-foreground">Link for you, signed in</span>
          <CopyButton text={`${location.origin}${pageUrl(path)}`} label="Copy link" />
        </div>
      </PopoverContent>
    </Popover>
  )
}
