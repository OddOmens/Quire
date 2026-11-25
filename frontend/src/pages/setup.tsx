import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { Navigate, useNavigate } from "react-router"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api } from "@/lib/api"
import { AuthCard } from "@/pages/login"

export default function SetupPage() {
  const { data: session } = useQuery({ queryKey: ["session"], queryFn: api.session })
  const [code, setCode] = useState("")
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const navigate = useNavigate()

  if (session && !session.setupRequired) return <Navigate to={session.authenticated ? "/" : "/login"} replace />

  const mismatch = confirm.length > 0 && confirm !== password
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError("")
    try {
      await api.setup(code, name, password)
      qc.removeQueries({ queryKey: ["session"] })
      navigate("/", { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard title="Set up Quire" subtitle="Create the account that owns this Quire.">
      <form onSubmit={submit} className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="code">Setup code</Label>
          <Input id="code" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX" className="h-10 font-mono tracking-wider" autoComplete="off" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            It's in the server log, for example <code className="rounded bg-muted px-1 font-mono">docker compose logs quire</code>. It proves you run this server.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="name">Your name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className="h-10" maxLength={60} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="new-password">Password</Label>
          <Input id="new-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className="h-10" />
          <p className="text-xs text-muted-foreground">At least 10 characters.</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="confirm">Confirm password</Label>
          <Input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" className="h-10" aria-invalid={mismatch} />
          {mismatch && <p className="text-xs text-destructive">The passwords don't match.</p>}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="h-10" disabled={busy || !code || !name.trim() || password.length < 10 || password !== confirm}>
          {busy ? <Loader2 className="animate-spin" /> : "Create account"}
        </Button>
      </form>
    </AuthCard>
  )
}
