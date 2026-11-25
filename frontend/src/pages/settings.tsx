import { useEffect, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"
import { Check, CircleAlert, CircleCheck, CloudDownload, Copy, DatabaseBackup, Globe, Info, Laptop, Loader2, Paperclip, RefreshCw, ShieldCheck, Smartphone, Upload, UserRound } from "lucide-react"
import { useTheme } from "next-themes"
import QRCode from "qrcode"
import { Link, Navigate, NavLink, useParams } from "react-router"
import { toast } from "sonner"

import { useDialogs } from "@/components/dialogs"
import { AttachmentsSection } from "@/components/attachments-section"
import { HealthList, useWarnings } from "@/components/health"
import { stuckReason, useOffline } from "@/components/offline"
import { ImportSection } from "@/components/import-section"
import { Page } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { errorMessage } from "@/hooks/use-vault"
import { api, shareUrl, type BackupInput, type Device } from "@/lib/api"
import { formatBytes, pageUrl, relativeTime, titleOf } from "@/lib/notes"
import { enableOffline, flush, removeCopy, settle, storageUsed, sync } from "@/lib/offline"

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4 border-b py-7 last:border-b-0">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

const SECTIONS = [
  { id: "account", label: "Account", icon: UserRound, description: "Your name and how Quire looks." },
  { id: "security", label: "Security", icon: ShieldCheck, description: "How you sign in, and where you're signed in." },
  { id: "offline", label: "Offline", icon: CloudDownload, description: "A copy of your pages on this device, for when there's no connection." },
  { id: "backups", label: "Backups", icon: DatabaseBackup, description: "Copies of your pages and database, sent to Coffer on a schedule." },
  { id: "attachments", label: "Attachments", icon: Paperclip, description: "Pictures and files your pages use. Files no page uses can go to the trash." },
  { id: "import", label: "Import", icon: Upload, description: "Bring in pages from other apps, or Markdown files from anywhere." },
  { id: "sharing", label: "Sharing", icon: Globe, description: "Pages anyone with the link can read. Stopping a share turns its link off; the page itself isn't changed." },
  { id: "about", label: "About", icon: Info, description: "This server and where your data lives." },
] as const

type SectionId = (typeof SECTIONS)[number]["id"]

export default function SettingsPage() {
  const { section = "account" } = useParams()
  const current = SECTIONS.find((x) => x.id === section)
  if (!current) return <Navigate to="/settings" replace />
  return (
    <Page>
      <div className="mx-auto w-full max-w-5xl px-6 py-10 sm:px-10 md:py-14">
        <h1 className="text-2xl font-bold tracking-[-0.02em]">Settings</h1>
        <div className="mt-6 md:mt-8 md:grid md:grid-cols-[12rem_1fr] md:gap-12">
          <nav aria-label="Settings" className="flex flex-wrap gap-1 border-b pb-3 md:sticky md:top-0 md:flex-col md:flex-nowrap md:self-start md:border-b-0 md:pb-0">
            {SECTIONS.map((x) => (
              <NavLink
                key={x.id}
                to={x.id === "account" ? "/settings" : `/settings/${x.id}`}
                end
                className={({ isActive }) =>
                  cn(
                    "flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&>svg]:size-4",
                    (isActive || x.id === section) && "bg-accent font-medium text-foreground",
                  )
                }
              >
                <x.icon /> {x.label}
              </NavLink>
            ))}
          </nav>
          <div className="min-w-0 pt-6 md:pt-0">
            <header className="border-b pb-5">
              <h2 className="text-lg font-semibold tracking-tight">{current.label}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{current.description}</p>
            </header>
            <SettingsSection id={current.id} />
          </div>
        </div>
      </div>
    </Page>
  )
}

function SettingsSection({ id }: { id: SectionId }) {
  const { data: account } = useQuery({ queryKey: ["account"], queryFn: api.account })
  const { data: session } = useQuery({ queryKey: ["session"], queryFn: api.session, staleTime: Infinity })
  switch (id) {
    case "account":
      return (
        <>
          <Section title="Profile" description="Your name appears in greetings and on your devices.">
            {account && <ProfileForm name={account.name} />}
          </Section>
          <Section title="Appearance">
            <ThemePicker />
          </Section>
          <Section title="Page width" description="Let pages in every space use the whole window. Any page can still be set otherwise from its menu.">
            {account && <FullWidthSwitch checked={account.fullWidth} />}
          </Section>
        </>
      )
    case "security":
      return (
        <>
          <Section title="Password" description="Changing it signs out your other devices.">
            <PasswordForm />
          </Section>
          <Section title="Two-factor sign-in" description="Ask for a code from an authenticator app as well as your password.">
            {account && <TwoFactor enabled={account.twoFactor} recoveryLeft={account.recoveryCodes} />}
          </Section>
          <Section title="Devices" description="Browsers and apps signed in to Quire. Sign out any you don't recognise.">
            <Devices />
          </Section>
        </>
      )
    case "offline":
      return <OfflineSection />
    case "backups":
      return (
        <div className="grid gap-4 py-7">
          <BackupWarnings />
          <BackupSettings />
        </div>
      )
    case "attachments":
      return <AttachmentsSection />
    case "import":
      return <ImportSection />
    case "sharing":
      return (
        <div className="py-7">
          <SharedPages />
        </div>
      )
    case "about":
      return (
        <>
          <Section title="Health" description="Things that keep your pages safe, checked each time you open this page.">
            <Health />
          </Section>
          <Section title="Version">
            <p className="text-sm">Quire {session?.version ?? ""}</p>
          </Section>
          <Section title="Your data">
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[9rem_1fr]">
              <dt className="text-muted-foreground">Pages</dt>
              <dd>Plain Markdown files in the vault folder. You can open, edit and copy them with any editor.</dd>
              <dt className="text-muted-foreground">Database</dt>
              <dd>Your account, signed-in devices, page history and share links, in the data folder.</dd>
              <dt className="text-muted-foreground">Backups</dt>
              <dd>
                Backups to Coffer include both. <Link to="/settings/backups" className="font-medium underline-offset-4 hover:underline">Set them up</Link>.
              </dd>
            </dl>
          </Section>
        </>
      )
  }
}

function Health() {
  const warnings = useWarnings()
  if (!warnings) return <Skeleton className="h-10 rounded-lg" />
  return <HealthList warnings={warnings} empty="Nothing needs your attention." />
}

// Backup warnings the card below doesn't already show: not set up shows the
// form, and a failure or a locked password shows in the card's status line.
function BackupWarnings() {
  const warnings = useWarnings()?.filter((w) => w.section === "backups" && !["backup-off", "backup-failed", "backup-password"].includes(w.id))
  return warnings?.length ? <HealthList warnings={warnings} links={false} /> : null
}

function ProfileForm({ name }: { name: string }) {
  const [value, setValue] = useState(name)
  const qc = useQueryClient()
  useEffect(() => setValue(name), [name])
  return (
    <form
      className="flex max-w-sm gap-2"
      onSubmit={async (e) => {
        e.preventDefault()
        try {
          await api.updateAccount({ name: value })
          qc.invalidateQueries({ queryKey: ["account"] })
          toast.success("Saved")
        } catch (err) {
          toast.error(errorMessage(err))
        }
      }}
    >
      <Input value={value} onChange={(e) => setValue(e.target.value)} aria-label="Name" maxLength={60} />
      <Button type="submit" variant="outline" disabled={!value.trim() || value.trim() === name}>
        Save
      </Button>
    </form>
  )
}

function ThemePicker() {
  const { theme, setTheme } = useTheme()
  return (
    <div className="flex gap-2">
      {[
        { v: "light", label: "Light" },
        { v: "dark", label: "Dark" },
        { v: "system", label: "System" },
      ].map((o) => (
        <Button key={o.v} variant={theme === o.v ? "default" : "outline"} size="sm" onClick={() => setTheme(o.v)}>
          {o.label}
        </Button>
      ))}
    </div>
  )
}

/** The copy of the vault kept in this browser (lib/offline.ts). */
function OfflineSection() {
  const { enabled, reachable, pending, syncing, progress, lastSync, pages, files, syncError } = useOffline()
  const { confirm } = useDialogs()
  const [busy, setBusy] = useState(false)
  const [used, setUsed] = useState(0)
  const supported = typeof indexedDB !== "undefined"

  useEffect(() => {
    if (!syncing) void storageUsed().then(setUsed)
  }, [enabled, syncing])

  const turn = async (on: boolean) => {
    setBusy(true)
    try {
      if (on) {
        await enableOffline()
        toast.success("Your pages are on this device now")
      } else {
        const waiting = pending.length
        const ok = await confirm({
          title: "Remove the copy from this device?",
          description: waiting
            ? `Quire will need a connection to open here. ${waiting} ${waiting === 1 ? "change is" : "changes are"} still waiting to be sent; ${waiting === 1 ? "it stays" : "they stay"} until Quire can send ${waiting === 1 ? "it" : "them"}.`
            : "Quire will need a connection to open here. Nothing on the server changes.",
          confirm: "Remove",
          destructive: true,
        })
        if (ok) await removeCopy()
      }
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const update = async () => {
    try {
      await flush()
      await sync()
    } catch (err) {
      toast.error(reachable ? errorMessage(err) : "Quire can't reach the server right now")
    }
  }

  const act = (path: string, choice: Parameters<typeof settle>[1]) => () => void settle(path, choice).catch((err) => toast.error(errorMessage(err)))

  return (
    <>
      <Section
        title="Keep a copy on this device"
        description="Downloads every page, database and attached file into this browser, so Quire opens and you can read, search and write without a connection. What you write offline is sent the next time Quire reaches the server. Each device has its own switch."
      >
        <div className="grid gap-3">
          <div className="flex items-center gap-3">
            <Switch id="offline-copy" checked={enabled} disabled={busy || !supported} onCheckedChange={(v) => void turn(v)} />
            <Label htmlFor="offline-copy">Available offline</Label>
            {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          </div>
          {!supported && <p className="text-[0.8125rem] text-muted-foreground">This browser doesn't let Quire store anything, so it can't keep a copy.</p>}
          <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
            The copy isn't encrypted: anyone who can unlock this device and open Quire can read it. Signing out removes it. On an iPhone or iPad, add Quire to the Home Screen first; Safari clears what a tab keeps after about a week without a visit.
          </p>
        </div>
      </Section>
      {enabled && (
        <Section title="On this device">
          <div className="grid gap-3 text-sm">
            <p>
              {syncing && progress
                ? progress.total
                  ? `Downloading… ${progress.done} of ${progress.total}`
                  : "Checking what's new…"
                : lastSync
                  ? `${pages} ${pages === 1 ? "page" : "pages"}${files ? ` and ${files} ${files === 1 ? "file" : "files"}` : ""}, up to date as of ${relativeTime(lastSync)}${used ? ` · ${formatBytes(used)} used` : ""}`
                  : "Nothing downloaded yet."}
            </p>
            {syncing && progress && progress.total > 0 && (
              <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
                <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
              </div>
            )}
            {!reachable && <p className="text-muted-foreground">Quire can't reach the server right now, so it's showing the copy.</p>}
            {syncError && <p className="text-destructive">The last download stopped: {syncError}</p>}
            <div>
              <Button variant="outline" size="sm" disabled={syncing} onClick={() => void update()}>
                <RefreshCw className={cn("size-4", syncing && "animate-spin")} />
                Update now
              </Button>
            </div>
            <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
              The copy updates by itself while Quire is open. Editing databases, renaming, moving or deleting pages, uploads, sharing and page history still need a connection.
            </p>
          </div>
        </Section>
      )}
      {pending.length > 0 && (
        <Section title="Waiting to be sent" description="Written on this device with no connection. They go out by themselves when the server answers.">
          <ul className="grid gap-2">
            {pending.map((p) => (
              <li key={p.path} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2 text-sm">
                <div className="min-w-0 flex-1 basis-48">
                  <Link to={pageUrl(p.path)} className="block truncate font-medium underline-offset-4 hover:underline">
                    {titleOf(p.path)}
                  </Link>
                  <p className="truncate text-[0.8125rem] text-muted-foreground">
                    {stuckReason(p) || (p.create ? "New page" : "Edited")} · {relativeTime(p.at)}
                  </p>
                </div>
                {p.clash && (
                  <>
                    <Button size="sm" variant="outline" onClick={act(p.path, "mine")}>Keep mine</Button>
                    <Button size="sm" variant="outline" onClick={act(p.path, "theirs")}>Keep theirs</Button>
                  </>
                )}
                {p.gone && <Button size="sm" variant="outline" onClick={act(p.path, "mine")}>Bring it back</Button>}
                {p.error && <Button size="sm" variant="outline" onClick={act(p.path, "retry")}>Try again</Button>}
                {(p.gone || p.error) && <Button size="sm" variant="ghost" onClick={act(p.path, "discard")}>Discard</Button>}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  )
}

function FullWidthSwitch({ checked }: { checked: boolean }) {
  const qc = useQueryClient()
  return (
    <div className="flex items-center gap-3">
      <Switch
        id="full-width"
        checked={checked}
        onCheckedChange={async (v) => {
          try {
            qc.setQueryData(["account"], await api.updateAccount({ fullWidth: v }))
          } catch (err) {
            toast.error(errorMessage(err))
          }
        }}
      />
      <Label htmlFor="full-width">Full width by default</Label>
    </div>
  )
}

function PasswordForm() {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const mismatch = confirm.length > 0 && next !== confirm
  return (
    <form
      className="grid max-w-sm gap-3"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        try {
          await api.changePassword(current, next)
          setCurrent("")
          setNext("")
          setConfirm("")
          qc.invalidateQueries({ queryKey: ["sessions"] })
          toast.success("Password changed. Other devices were signed out.")
        } catch (err) {
          toast.error(errorMessage(err))
        } finally {
          setBusy(false)
        }
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="pw-current">Current password</Label>
        <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="pw-next">New password</Label>
        <Input id="pw-next" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={10} />
        <p className="text-xs text-muted-foreground">At least 10 characters. A passphrase of a few words works well.</p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="pw-confirm">Confirm new password</Label>
        <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch} />
        {mismatch && <p className="text-xs text-destructive">The passwords don't match.</p>}
      </div>
      <Button type="submit" className="justify-self-start" disabled={busy || !current || next.length < 10 || next !== confirm}>
        Change password
      </Button>
    </form>
  )
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border bg-surface p-4 font-mono text-sm">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="justify-self-start"
        onClick={() => {
          void navigator.clipboard?.writeText(codes.join("\n"))
          setCopied(true)
        }}
      >
        {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy codes"}
      </Button>
    </div>
  )
}

function TwoFactor({ enabled, recoveryLeft }: { enabled: boolean; recoveryLeft: number }) {
  const qc = useQueryClient()
  const [step, setStep] = useState<"idle" | "password" | "scan" | "codes" | "disable" | "regen">("idle")
  const [password, setPassword] = useState("")
  const [secret, setSecret] = useState<{ secret: string; uri: string } | null>(null)
  const [qr, setQr] = useState("")
  const [code, setCode] = useState("")
  const [codes, setCodes] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (secret) void QRCode.toDataURL(secret.uri, { margin: 1, width: 200 }).then(setQr)
  }, [secret])

  const close = () => {
    setStep("idle")
    setPassword("")
    setCode("")
    setSecret(null)
    setQr("")
    qc.invalidateQueries({ queryKey: ["account"] })
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2 text-sm">
        {enabled ? (
          <>
            <ShieldCheck className="size-4 text-green-600 dark:text-green-400" /> On.{" "}
            <span className="text-muted-foreground">
              {recoveryLeft} recovery {recoveryLeft === 1 ? "code" : "codes"} left.
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">Off.</span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {enabled ? (
          <>
            <Button variant="outline" size="sm" onClick={() => setStep("regen")}>
              New recovery codes
            </Button>
            <Button variant="outline" size="sm" onClick={() => setStep("disable")}>
              Turn off
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => setStep("password")}>
            Set up
          </Button>
        )}
      </div>

      <Dialog open={step !== "idle"} onOpenChange={(o) => !o && close()}>
        <DialogContent className="sm:max-w-md">
          {(step === "password" || step === "disable" || step === "regen") && (
            <form
              className="grid gap-5"
              onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                  if (step === "password") {
                    setSecret(await api.startTwoFactor(password))
                    setStep("scan")
                  } else if (step === "disable") {
                    await api.disableTwoFactor(password)
                    toast.success("Two-factor sign-in is off")
                    close()
                  } else {
                    setCodes((await api.newRecoveryCodes(password)).recoveryCodes)
                    setStep("codes")
                  }
                })
              }}
            >
              <DialogHeader>
                <DialogTitle>{step === "disable" ? "Turn off two-factor sign-in" : step === "regen" ? "New recovery codes" : "Set up two-factor sign-in"}</DialogTitle>
                <DialogDescription>Enter your password to continue.</DialogDescription>
              </DialogHeader>
              <Input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" variant={step === "disable" ? "destructive" : "default"} disabled={!password || busy}>
                  Continue
                </Button>
              </DialogFooter>
            </form>
          )}
          {step === "scan" && secret && (
            <form
              className="grid gap-5"
              onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                  setCodes((await api.enableTwoFactor(code)).recoveryCodes)
                  setStep("codes")
                })
              }}
            >
              <DialogHeader>
                <DialogTitle>Scan with your authenticator app</DialogTitle>
                <DialogDescription>Use 1Password, Google Authenticator, Authy or similar, then enter the 6-digit code it shows.</DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-4">
                <div className="grid size-[200px] shrink-0 place-items-center rounded-lg border bg-white p-1">
                  {qr ? <img src={qr} alt="QR code for your authenticator app" className="size-full" /> : <Loader2 className="size-5 animate-spin text-muted-foreground" />}
                </div>
                <div className="min-w-0 text-xs text-muted-foreground">
                  Can't scan? Enter this key:
                  <code className="mt-1 block font-mono text-[0.7rem] break-all text-foreground">{secret.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
                </div>
              </div>
              <InputOTP maxLength={6} value={code} onChange={setCode} autoFocus>
                <InputOTPGroup>
                  {Array.from({ length: 6 }, (_, i) => (
                    <InputOTPSlot key={i} index={i} />
                  ))}
                </InputOTPGroup>
              </InputOTP>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" disabled={code.length !== 6 || busy}>
                  Turn on
                </Button>
              </DialogFooter>
            </form>
          )}
          {step === "codes" && (
            <div className="grid gap-5">
              <DialogHeader>
                <DialogTitle>Save your recovery codes</DialogTitle>
                <DialogDescription>
                  If you lose your authenticator, each code signs you in once. Keep them somewhere safe; they won't be shown again.
                </DialogDescription>
              </DialogHeader>
              <RecoveryCodes codes={codes} />
              <DialogFooter>
                <Button onClick={close}>I've saved them</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function describe(d: Device) {
  const ua = d.userAgent
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : ""
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : ""
  const mobile = /iPhone|Android|Mobile/.test(ua)
  const name = d.device !== "Browser" ? d.device : [browser, os].filter(Boolean).join(" on ") || "Browser"
  return { name, mobile }
}

function Devices() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ["sessions"], queryFn: api.sessions })
  const others = (data ?? []).filter((d) => !d.current).length
  const revoke = async (id?: string) => {
    try {
      await (id ? api.revokeSession(id) : api.revokeOtherSessions())
      qc.invalidateQueries({ queryKey: ["sessions"] })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <div className="grid gap-3">
      <div className="divide-y rounded-lg border">
        {data?.map((d) => {
          const { name, mobile } = describe(d)
          const Icon = mobile ? Smartphone : Laptop
          return (
            <div key={d.id} className="flex items-center gap-3 px-4 py-3">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span className="truncate">{name}</span>
                  {d.current && <Badge variant="secondary">This device</Badge>}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {d.ip} · active {relativeTime(d.lastSeen * 1000)} · signed in {new Date(d.created * 1000).toLocaleDateString()}
                </div>
              </div>
              {!d.current && (
                <Button variant="ghost" size="sm" onClick={() => void revoke(d.id)}>
                  Sign out
                </Button>
              )}
            </div>
          )
        })}
      </div>
      {others > 0 && (
        <Button variant="outline" size="sm" className="justify-self-start" onClick={() => void revoke()}>
          Sign out all other devices
        </Button>
      )}
    </div>
  )
}

function SharedPages() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ["shares"], queryFn: () => api.shares() })
  if (!data?.length) return <p className="text-sm text-muted-foreground">No pages are shared. Use Share on a page to publish it.</p>
  return (
    <div className="divide-y rounded-lg border">
      {data.map((s) => (
        <div key={s.token} className="flex items-center gap-3 px-4 py-3">
          <Globe className="size-4 shrink-0 text-brand" />
          <div className="min-w-0 flex-1">
            <Link to={pageUrl(s.path)} className="block truncate text-sm font-medium hover:underline">
              {titleOf(s.path)}
            </Link>
            <div className="truncate text-xs text-muted-foreground">{shareUrl(s.token)}</div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await api.unshare(s.token).catch((e) => toast.error(errorMessage(e)))
              qc.invalidateQueries({ queryKey: ["shares"] })
            }}
          >
            Stop sharing
          </Button>
        </div>
      ))}
    </div>
  )
}

const schedules = [
  { hours: 1, label: "Every hour" },
  { hours: 6, label: "Every 6 hours" },
  { hours: 24, label: "Every day" },
  { hours: 168, label: "Every week" },
  { hours: 0, label: "Only when I ask" },
]

function BackupSettings() {
  const qc = useQueryClient()
  const { prompt, confirm } = useDialogs()
  const { data } = useQuery({
    queryKey: ["backup"],
    queryFn: api.backup,
    refetchInterval: (q) => (q.state.data?.status.running ? 2000 : false),
  })
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<BackupInput>({ url: "", username: "", password: "", folder: "", hours: 24 })
  const [busy, setBusy] = useState<"" | "test" | "save" | "run">("")
  const [tested, setTested] = useState(false)

  useEffect(() => {
    if (!data) return
    setForm({ url: data.url ?? "", username: data.username ?? "", password: "", folder: data.folder ?? "", hours: data.hours ?? 24 })
  }, [data])

  const set = (k: keyof BackupInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setTested(false)
    setForm((f) => ({ ...f, [k]: k === "hours" ? Number(e.target.value) : e.target.value }))
  }
  const run = async (what: typeof busy, fn: () => Promise<void>) => {
    setBusy(what)
    try {
      await fn()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy("")
    }
  }

  if (!data) return <Skeleton className="h-40 rounded-lg" />

  const st = data.status
  if (data.configured && !editing) {
    return (
      <div className="grid gap-4">
        <div className="rounded-lg border">
          <div className="flex items-start gap-3 p-4">
            <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
              <DatabaseBackup className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">Coffer · {data.folder}</div>
              <div className="truncate text-xs text-muted-foreground">
                {data.username} at {data.url} · {schedules.find((s) => s.hours === data.hours)?.label.toLowerCase() ?? `every ${data.hours} hours`}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 border-t px-4 py-3 text-sm">
            {st.needsPassword ? (
              <>
                <CircleAlert className="size-4 shrink-0 text-destructive" />
                <span className="min-w-0 text-destructive">
                  Backups are paused: Quire can't unlock the saved app password (was secret.key replaced?). Enter it again under Change settings.
                </span>
              </>
            ) : st.running ? (
              <>
                <Loader2 className="size-4 animate-spin text-muted-foreground" /> Backing up…
              </>
            ) : st.lastError ? (
              <>
                <CircleAlert className="size-4 shrink-0 text-destructive" />
                <span className="min-w-0 text-destructive">
                  Last backup failed {relativeTime(st.lastRun)}: {st.lastError}
                </span>
              </>
            ) : st.lastSuccess ? (
              <>
                <CircleCheck className="size-4 shrink-0 text-green-600 dark:text-green-400" />
                <span>
                  Backed up {relativeTime(st.lastSuccess)} · {st.files} files
                  {st.uploaded ? `, ${st.uploaded} sent (${formatBytes(st.bytes)})` : ", nothing new to send"}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">Not backed up yet.</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={st.running || st.needsPassword || busy === "run"}
            onClick={() =>
              run("run", async () => {
                await api.runBackup()
                await qc.invalidateQueries({ queryKey: ["backup"] })
              })
            }
          >
            <RefreshCw /> Back up now
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Change settings
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const ok = await confirm({
                title: "Stop backing up to Coffer?",
                description: "Quire stops sending backups. What's already in Coffer stays there.",
                confirm: "Stop backups",
                destructive: true,
              })
              if (ok)
                await run("save", async () => {
                  await api.removeBackup()
                  void qc.invalidateQueries({ queryKey: ["backup"] })
                  void qc.invalidateQueries({ queryKey: ["session"] })
                })
            }}
          >
            Turn off
          </Button>
        </div>
      </div>
    )
  }

  // A saved password that can't be unlocked has to be typed again.
  const keepsPassword = data.configured && !st.needsPassword
  const ready = form.url.trim() && form.username.trim() && form.folder.trim() && (form.password || keepsPassword)
  return (
    <form
      className="grid max-w-lg gap-4"
      onSubmit={async (e) => {
        e.preventDefault()
        const current = await prompt({ title: "Confirm with your password", description: "Backups get a copy of everything in Quire, so changing where they go needs your password.", secret: true, confirm: "Save" })
        if (!current) return
        await run("save", async () => {
          await api.saveBackup(form, current)
          await qc.invalidateQueries({ queryKey: ["backup"] })
          void qc.invalidateQueries({ queryKey: ["session"] })
          setEditing(false)
          toast.success("Backups set up", { description: "Use “Back up now” to send the first one." })
        })
      }}
    >
      <div className="rounded-lg border bg-surface p-3 text-[0.8125rem] leading-relaxed text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">Keep it encrypted.</span> In Coffer, choose a folder on a drive with <span className="text-foreground">Encrypt files</span> turned on,
          or a folder that a Coffer backup sends to one. Quire sends plain files; Coffer encrypts them before they reach the bucket.
        </p>
        <p className="mt-2">
          Create an app password in Coffer under <span className="text-foreground">Settings → Connect</span>. It's stored sealed on this server and only used for backups.
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="bk-url">Coffer address</Label>
        <Input id="bk-url" value={form.url} onChange={set("url")} placeholder="https://coffer.example.com" autoComplete="off" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="bk-user">Coffer username</Label>
          <Input id="bk-user" value={form.username} onChange={set("username")} autoComplete="off" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="bk-pass">App password</Label>
          <Input id="bk-pass" type="password" value={form.password} onChange={set("password")} placeholder={keepsPassword ? "Saved; type to replace" : st.needsPassword ? "Enter it again" : ""} autoComplete="new-password" />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="bk-folder">Folder in Coffer</Label>
        <Input id="bk-folder" value={form.folder} onChange={set("folder")} placeholder="Encrypted R2/Backups/Quire" autoComplete="off" />
        <p className="text-xs text-muted-foreground">Start with the drive or place name as Coffer shows it in the sidebar. Missing folders are created.</p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="bk-hours">How often</Label>
        <select
          id="bk-hours"
          value={form.hours}
          onChange={set("hours")}
          className="h-9 rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {schedules.map((s) => (
            <option key={s.hours} value={s.hours}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={!ready || !!busy}
          onClick={() =>
            run("test", async () => {
              await api.testBackup(form)
              setTested(true)
              toast.success("Connected to Coffer", { description: "Quire can write to that folder." })
            })
          }
        >
          {busy === "test" ? <Loader2 className="animate-spin" /> : tested ? <Check /> : null} Test connection
        </Button>
        <Button type="submit" disabled={!ready || !!busy}>
          Save
        </Button>
        {data.configured && (
          <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}
