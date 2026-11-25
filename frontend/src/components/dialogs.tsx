import { createContext, useCallback, useContext, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

type PromptOptions = {
  title: string
  description?: string
  defaultValue?: string
  placeholder?: string
  confirm?: string
  /** Select only the part before this suffix (".md", say) when opening. */
  selectUntil?: number
  /** A password field. */
  secret?: boolean
}

type ConfirmOptions = {
  title: string
  description?: string
  confirm?: string
  destructive?: boolean
}

type State =
  | { kind: "prompt"; opts: PromptOptions; resolve: (v: string | null) => void }
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean) => void }

const Ctx = createContext<{
  prompt: (o: PromptOptions) => Promise<string | null>
  confirm: (o: ConfirmOptions) => Promise<boolean>
} | null>(null)

/** Promise-based prompt and confirm dialogs, so actions read top to bottom. */
export function DialogsProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State | null>(null)
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const prompt = useCallback(
    (opts: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setValue(opts.defaultValue ?? "")
        setState({ kind: "prompt", opts, resolve })
        setOpen(true)
      }),
    [],
  )
  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setState({ kind: "confirm", opts, resolve })
        setOpen(true)
      }),
    [],
  )

  const finish = (ok: boolean) => {
    if (!state) return
    if (state.kind === "prompt") state.resolve(ok && value.trim() ? value.trim() : null)
    else state.resolve(ok)
    setOpen(false)
  }

  return (
    <Ctx.Provider value={{ prompt, confirm }}>
      {children}
      <Dialog open={open} onOpenChange={(o) => !o && finish(false)}>
        <DialogContent
          className="sm:max-w-md"
          showCloseButton={false}
          onOpenAutoFocus={(e) => {
            if (state?.kind !== "prompt") return
            e.preventDefault()
            const el = inputRef.current
            if (!el) return
            el.focus()
            el.setSelectionRange(0, state.opts.selectUntil ?? el.value.length)
          }}
        >
          {state && (
            <form
              className="grid gap-5"
              onSubmit={(e) => {
                e.preventDefault()
                finish(true)
              }}
            >
              <DialogHeader>
                <DialogTitle>{state.opts.title}</DialogTitle>
                {state.opts.description && <DialogDescription>{state.opts.description}</DialogDescription>}
              </DialogHeader>
              {state.kind === "prompt" && (
                <Input
                  ref={inputRef}
                  type={state.opts.secret ? "password" : "text"}
                  value={value}
                  placeholder={state.opts.placeholder}
                  onChange={(e) => setValue(e.target.value)}
                  autoComplete={state.opts.secret ? "current-password" : "off"}
                  spellCheck={false}
                />
              )}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => finish(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant={state.kind === "confirm" && state.opts.destructive ? "destructive" : "default"}
                  disabled={state.kind === "prompt" && !value.trim()}
                  autoFocus={state.kind === "confirm"}
                >
                  {state.opts.confirm ?? "OK"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </Ctx.Provider>
  )
}

export function useDialogs() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("useDialogs outside DialogsProvider")
  return ctx
}
