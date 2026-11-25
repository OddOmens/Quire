import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, Loader2 } from "lucide-react"
import { Navigate, useNavigate } from "react-router"

import { Logo } from "@/components/brand"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Label } from "@/components/ui/label"
import { api, ApiError } from "@/lib/api"

export function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-canvas px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo className="size-10" />
          <h1 className="mt-5 text-xl font-semibold tracking-[-0.01em]">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="rounded-xl border bg-card p-6 shadow-xs">{children}</div>
      </div>
    </div>
  )
}

export default function LoginPage() {
  const { data: session } = useQuery({ queryKey: ["session"], queryFn: api.session })
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [needCode, setNeedCode] = useState(false)
  const [recovery, setRecovery] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const navigate = useNavigate()

  if (session?.setupRequired) return <Navigate to="/setup" replace />
  if (session?.authenticated) return <Navigate to="/" replace />

  const submit = async (e?: React.FormEvent, otp = code) => {
    e?.preventDefault()
    setBusy(true)
    setError("")
    try {
      await api.login(password, needCode ? otp : undefined)
      qc.removeQueries({ queryKey: ["session"] })
      navigate("/", { replace: true })
    } catch (err) {
      if (err instanceof ApiError && err.body.twoFactor) {
        if (needCode) setError(err.message)
        setNeedCode(true)
        setCode("")
      } else {
        setError(err instanceof Error ? err.message : "Couldn't sign in")
        if (!needCode) setPassword("")
      }
    } finally {
      setBusy(false)
    }
  }

  if (needCode) {
    return (
      <AuthCard title="Two-factor sign-in" subtitle={recovery ? "Enter one of your recovery codes." : "Enter the 6-digit code from your authenticator app."}>
        <form onSubmit={submit} className="grid gap-4">
          {recovery ? (
            <Input autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX" className="h-10 font-mono tracking-wider" autoComplete="one-time-code" />
          ) : (
            <InputOTP
              autoFocus
              maxLength={6}
              value={code}
              onChange={(v) => {
                setCode(v)
                if (v.length === 6) void submit(undefined, v)
              }}
              containerClassName="justify-center"
            >
              <InputOTPGroup>
                {Array.from({ length: 6 }, (_, i) => (
                  <InputOTPSlot key={i} index={i} className="size-11 text-base" />
                ))}
              </InputOTPGroup>
            </InputOTP>
          )}
          {error && <p className="text-center text-sm text-destructive">{error}</p>}
          <Button type="submit" className="h-10" disabled={busy || !code}>
            {busy ? <Loader2 className="animate-spin" /> : "Verify"}
          </Button>
          <div className="flex items-center justify-between text-sm">
            <button type="button" className="flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => (setNeedCode(false), setCode(""), setError(""))}>
              <ArrowLeft className="size-3.5" /> Back
            </button>
            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => (setRecovery((r) => !r), setCode(""), setError(""))}>
              {recovery ? "Use authenticator code" : "Use a recovery code"}
            </button>
          </div>
        </form>
      </AuthCard>
    )
  }

  return (
    <AuthCard title="Sign in to Quire" subtitle={session?.name ? `Welcome back, ${session.name}.` : "Welcome back."}>
      <form onSubmit={submit} className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-10"
            aria-invalid={!!error}
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="h-10" disabled={!password || busy}>
          {busy ? <Loader2 className="animate-spin" /> : "Sign in"}
        </Button>
      </form>
    </AuthCard>
  )
}
