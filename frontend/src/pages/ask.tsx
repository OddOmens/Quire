import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  ArrowRight,
  ArrowUp,
  ChevronRight,
  CircleAlert,
  FileText,
  Layers,
  Loader2,
  MessageCircleQuestionMark,
  Phone,
  RotateCcw,
  Search,
  SearchX,
  Slash,
  Sparkle,
} from "lucide-react"
import { cn } from "cn"
import { Link, useNavigate, useSearchParams } from "react-router"
import { toast } from "sonner"

import { Page } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { PageEditor } from "@/editor/page-editor"
import { errorMessage, useResolver, useSpaces, useSpaceSections, useTree, useVaultActions } from "@/hooks/use-vault"
import { api, fileUrl, type AskAnswer, type AskParams, type AskSection } from "@/lib/api"
import { ASK_COMMANDS, matchAskCommands, matchScopeArg, parseAskCommand, resolveScope, scopeChoices, smallTalk, type AskCommand, type ScopeChoice, type SmallTalk } from "@/lib/ask-commands"
import { baseOf, pageUrl } from "@/lib/notes"
import { openPalette } from "@/lib/ui-events"

/** A reply to a slash command, shown in the thread instead of an answer. */
type Note = { kind: "help" } | { kind: "info"; text: string; options?: ScopeChoice[]; tone?: "error" } | { kind: "chat"; talk: SmallTalk; where: string }

/** One question (or command) and what came back. */
type Turn = {
  id: number
  question: string
  params: AskParams
  answer?: AskAnswer
  error?: string
  note?: Note
}

const kept = (t: Turn) => Boolean(t.answer || t.note)

/** What the menu above the box offers: commands while typing a name, places after /in. */
type MenuItem = { kind: "command"; command: AskCommand } | { kind: "scope"; choice: ScopeChoice }

const THREAD_KEY = "quire:ask-thread"
const SCOPE_KEY = "quire:ask-scope"

function load<T>(storage: () => Storage, key: string, fallback: T): T {
  try {
    const v = storage().getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
function save(storage: () => Storage, key: string, v: unknown) {
  try {
    storage().setItem(key, JSON.stringify(v))
  } catch {
    // private mode or full: the thread just won't survive a reload
  }
}

/** Ask the notes a question in plain words; answers are sections of pages. */
export default function AskPage() {
  const [params, setParams] = useSearchParams()
  // The conversation lasts for this tab, so opening a page and coming back keeps it.
  const [turns, setTurns] = useState<Turn[]>(() => load<Turn[]>(() => sessionStorage, THREAD_KEY, []).filter(kept))
  const [scope, setScope] = useState<string>(() => load(() => localStorage, SCOPE_KEY, ""))
  const [text, setText] = useState("")
  const busy = turns.some((t) => !t.answer && !t.error && !t.note)
  const input = useRef<HTMLTextAreaElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const { data: spaces } = useSpaces()
  const { data: sections } = useSpaceSections()
  const navigate = useNavigate()
  const [menuPick, setMenuPick] = useState(0)
  const [menuClosed, setMenuClosed] = useState(false)

  const choices = useMemo(() => scopeChoices(spaces?.map((s) => s.name) ?? [], sections ?? []), [spaces, sections])
  const scopeLabel = choices.find((c) => c.value === scope)?.label ?? "All spaces"
  const menu: MenuItem[] = useMemo(() => {
    if (menuClosed || !text.startsWith("/")) return []
    const cmds = matchAskCommands(text)
    if (cmds.length) return cmds.map((command) => ({ kind: "command" as const, command }))
    return matchScopeArg(text, choices)
      .slice(0, 12)
      .map((choice) => ({ kind: "scope" as const, choice }))
  }, [text, choices, menuClosed])
  const pick = Math.min(menuPick, Math.max(0, menu.length - 1))

  const scopeSpaces = useMemo(() => {
    if (scope.startsWith("section:")) return sections?.find((s) => s.name === scope.slice(8))?.spaces ?? []
    if (scope.startsWith("space:")) return [scope.slice(6)]
    return []
  }, [scope, sections])

  useEffect(() => save(() => sessionStorage, THREAD_KEY, turns.filter(kept).slice(-20)), [turns])
  useEffect(() => save(() => localStorage, SCOPE_KEY, scope), [scope])

  const run = (question: string, extra: Partial<AskParams> = {}, followUp = true) => {
    const q = question.trim()
    if (!q && extra.page === undefined) return
    const last = [...turns].reverse().find((t) => t.answer?.main)
    const p: AskParams = { q, spaces: scopeSpaces, ...extra }
    if (followUp && last && extra.page === undefined) {
      p.prev = last.question
      p.prevPage = last.answer?.main?.path
    }
    const id = Date.now() + Math.random()
    setTurns((ts) => [...ts, { id, question: q, params: p }])
    api.ask(p).then(
      (answer) => setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, answer } : t))),
      (e) => setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, error: errorMessage(e) } : t))),
    )
  }

  // /ask?q=… (from the search box) asks straight away.
  useEffect(() => {
    const q = params.get("q")
    if (q) {
      setParams({}, { replace: true })
      run(q, {}, false)
    }
  }, [params]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" })
  }, [turns.length])

  const note = (question: string, n: Note) => setTurns((ts) => [...ts, { id: Date.now() + Math.random(), question, params: { q: "" }, note: n }])
  const lastAnswer = () => [...turns].reverse().find((t) => t.answer?.main)

  const chooseScope = (typed: string, c: ScopeChoice) => {
    setScope(c.value)
    note(typed, {
      kind: "info",
      text: c.kind === "all" ? "Now looking in all spaces." : `Now looking only in ${c.label}. Type /in all to look everywhere again.`,
    })
  }

  /** Runs a slash command. Returns false when the text isn't one. */
  const command = (typed: string): boolean => {
    const parsed = parseAskCommand(typed)
    if (!parsed) return false
    if (parsed.kind === "unknown") {
      note(typed, {
        kind: "info",
        tone: "error",
        text: `/${parsed.name} isn't a command. Type /help to see what you can do.`,
      })
      return true
    }
    const { command: c, arg } = parsed
    switch (c.name) {
      case "help":
        note(typed, { kind: "help" })
        break
      case "clear":
        setTurns([])
        break
      case "in": {
        if (!arg) {
          note(typed, {
            kind: "info",
            text: `Looking in ${scopeLabel}. Pick where to look:`,
            options: choices,
          })
          break
        }
        const { match, options } = resolveScope(arg, choices)
        if (match) chooseScope(typed, match)
        else if (options.length)
          note(typed, {
            kind: "info",
            text: `More than one place matches “${arg}”. Which one?`,
            options,
          })
        else
          note(typed, {
            kind: "info",
            tone: "error",
            text: `No space or section is called “${arg}”. Pick one:`,
            options: choices,
          })
        break
      }
      case "fresh":
        if (arg) run(arg, {}, false)
        else
          note(typed, {
            kind: "info",
            tone: "error",
            text: "Type a question after /fresh, like “/fresh how do I jump start a car”.",
          })
        break
      case "again": {
        const t = [...turns].reverse().find((x) => x.answer)
        if (!t) {
          note(typed, {
            kind: "info",
            tone: "error",
            text: "There's no question to ask again yet.",
          })
          break
        }
        // A chip's answer is asked again for the same section; anything else is asked fresh.
        run(t.question, t.params.page === undefined ? {} : { page: t.params.page, section: t.params.section }, false)
        break
      }
      case "open": {
        const m = lastAnswer()?.answer?.main
        if (m) navigate(pageUrl(m.path, m.heading || undefined))
        else
          note(typed, {
            kind: "info",
            tone: "error",
            text: "There's no answer to open yet.",
          })
        break
      }
      case "copy": {
        const m = lastAnswer()?.answer?.main
        if (!m) {
          note(typed, {
            kind: "info",
            tone: "error",
            text: "There's no answer to copy yet.",
          })
          break
        }
        const body = `${m.title}${m.heading ? ` › ${m.heading}` : ""}\n\n${m.markdown.trim()}\n`
        const blocked = () => toast.error("Couldn't copy. The browser blocked it.")
        if (!navigator.clipboard) blocked()
        else navigator.clipboard.writeText(body).then(() => toast.success(`Copied ${m.heading || m.title}`), blocked)
        break
      }
      case "search":
        openPalette(arg || undefined)
        break
    }
    return true
  }

  const submit = () => {
    if (!text.trim()) return
    if (text.trim().startsWith("/")) {
      command(text.trim())
      setText("")
      return
    }
    if (busy) return
    // "Hi" or "can you help me" isn't a question for the notes.
    const talk = smallTalk(text)
    if (talk) note(text.trim(), { kind: "chat", talk, where: scopeLabel })
    else run(text)
    setText("")
  }

  /** Enter or Tab on a menu row. Commands that need words get typed in; the rest run. */
  const choose = (item: MenuItem, run: boolean) => {
    setMenuPick(0)
    if (item.kind === "scope") {
      setText("")
      chooseScope(`/in ${item.choice.kind === "all" ? "all" : item.choice.label}`, item.choice)
      return
    }
    const c = item.command
    if (c.arg || !run) {
      setText(`/${c.name} `)
      return
    }
    setText("")
    command(`/${c.name}`)
  }

  return (
    <Page
      header={
        <div className="flex w-full items-center gap-2">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <MessageCircleQuestionMark className="size-4 text-muted-foreground" /> Ask
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <ScopePicker value={scope} onChange={setScope} spaces={spaces?.map((s) => s.name) ?? []} sections={sections ?? []} />
            {turns.length > 0 && (
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setTurns([])}>
                <RotateCcw /> <span className="max-sm:hidden">New conversation</span>
              </Button>
            )}
          </div>
        </div>
      }
      className="flex flex-col"
    >
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 pt-6 pb-4 sm:px-8 md:pt-10">
        {turns.length === 0 ? (
          <Welcome spaces={scopeSpaces} onAsk={(q) => run(q, {}, false)} />
        ) : (
          <div className="grid gap-10">
            {turns.map((t, i) => (
              <TurnView
                key={t.id}
                turn={t}
                latest={i === turns.length - 1}
                onScope={(c) => chooseScope(`/in ${c.kind === "all" ? "all" : c.label}`, c)}
                onRetry={() => {
                  setTurns((ts) => ts.filter((x) => x.id !== t.id))
                  run(t.question, t.params, false)
                }}
                onChip={(label, path, section) => run(label, { page: path, section }, false)}
                onAsk={(q) => run(q, {}, false)}
                spaces={scopeSpaces}
              />
            ))}
          </div>
        )}
        <div ref={end} className="scroll-mb-36" />
      </div>

      <div className="sticky bottom-0 bg-gradient-to-t from-background from-70% to-transparent px-4 pt-6 pb-4 sm:px-8">
        <div className="relative mx-auto max-w-3xl">
          {menu.length > 0 && (
            <div
              id="ask-commands"
              role="listbox"
              aria-label={menu[0].kind === "command" ? "Commands" : "Where to look"}
              className="absolute inset-x-0 bottom-full mb-2 max-h-72 overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-md"
            >
              {menu.map((item, i) => {
                const key = item.kind === "command" ? item.command.name : item.choice.value || "all"
                return (
                  <button
                    key={key}
                    id={`ask-cmd-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === pick}
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setMenuPick(i)}
                    onClick={() => {
                      choose(item, true)
                      input.current?.focus()
                    }}
                    className={cn("flex w-full items-baseline gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm", i === pick && "bg-accent")}
                  >
                    {item.kind === "command" ? (
                      <>
                        <span className="shrink-0 font-mono text-[13px] font-medium">
                          /{item.command.name}
                          {item.command.arg && <span className="text-muted-foreground"> {item.command.arg}</span>}
                        </span>
                        <span className="min-w-0 truncate text-xs text-muted-foreground">{item.command.summary}</span>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 truncate font-medium">{item.choice.label}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {item.choice.value === scope ? "Looking here now" : item.choice.kind === "section" ? "Section" : item.choice.kind === "space" ? "Space" : ""}
                        </span>
                      </>
                    )}
                  </button>
                )
              })}
            </div>
          )}
          <form
            className="flex items-end gap-2 rounded-2xl border bg-card p-2 shadow-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <textarea
              ref={input}
              autoFocus
              rows={1}
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                setMenuClosed(false)
                setMenuPick(0)
              }}
              onKeyDown={(e) => {
                if (menu.length > 0 && !e.nativeEvent.isComposing) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault()
                    setMenuPick((pick + (e.key === "ArrowDown" ? 1 : menu.length - 1)) % menu.length)
                    return
                  }
                  if (e.key === "Escape") {
                    e.preventDefault()
                    setMenuClosed(true)
                    return
                  }
                  if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                    e.preventDefault()
                    choose(menu[pick], e.key === "Enter")
                    return
                  }
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder={turns.length ? "Ask a follow-up, or something new… (/ for commands)" : "Ask a question, like “how do I treat a bee sting?”"}
              aria-label="Your question"
              role="combobox"
              aria-expanded={menu.length > 0}
              aria-controls="ask-commands"
              aria-autocomplete="list"
              aria-activedescendant={menu.length > 0 ? `ask-cmd-${pick}` : undefined}
              className="field-sizing-content max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-muted-foreground md:text-sm"
            />
            <Button type="submit" size="icon" className="shrink-0 rounded-xl" disabled={(busy && !text.trim().startsWith("/")) || !text.trim()} aria-label="Ask">
              {busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}
            </Button>
          </form>
        </div>
        <p className="mx-auto mt-2 max-w-3xl text-center text-xs text-muted-foreground">
          Answers are sections of your own pages, found by search. Nothing leaves Quire.
        </p>
      </div>
    </Page>
  )
}

function ScopePicker({ value, onChange, spaces, sections }: { value: string; onChange: (v: string) => void; spaces: string[]; sections: { name: string; spaces: string[] }[] }) {
  const filled = sections.filter((s) => s.spaces.length > 0)
  return (
    <Select value={value || "all"} onValueChange={(v) => onChange(v === "all" ? "" : v)}>
      <SelectTrigger size="sm" className="h-7 max-w-44 gap-1.5 border-none bg-transparent text-xs shadow-none hover:bg-accent" aria-label="Where to look">
        <Layers className="size-3.5 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="all">All spaces</SelectItem>
        {filled.length > 0 && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Sections</SelectLabel>
              {filled.map((s) => (
                <SelectItem key={s.name} value={`section:${s.name}`}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        )}
        {spaces.length > 0 && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Spaces</SelectLabel>
              {spaces.map((s) => (
                <SelectItem key={s} value={`space:${s}`}>
                  {s}
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  )
}

/** A few questions the notes can answer, as buttons. */
function Suggestions({ spaces, onAsk, small }: { spaces: string[]; onAsk: (q: string) => void; small?: boolean }) {
  const { data: suggestions } = useQuery({
    queryKey: ["ask-suggestions", spaces.join(",")],
    queryFn: () => api.askSuggestions(spaces),
    staleTime: Infinity,
  })
  if (!suggestions?.length) return null
  return (
    <div className={cn("grid w-full gap-2 sm:grid-cols-2", small ? "mt-3" : "mt-8 max-w-xl")}>
      {suggestions.slice(0, small ? 4 : undefined).map((s) => (
        <button
          key={s.question}
          type="button"
          onClick={() => onAsk(s.question)}
          className="group flex items-center gap-2 rounded-xl border bg-card px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-accent/60"
        >
          <Sparkle className="size-3.5 shrink-0 text-brand" />
          <span className="min-w-0 flex-1">{s.question}</span>
          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      ))}
    </div>
  )
}

function Welcome({ spaces, onAsk }: { spaces: string[]; onAsk: (q: string) => void }) {
  return (
    <div className="flex flex-col items-center pt-6 text-center md:pt-14">
      <div className="grid size-12 place-items-center rounded-2xl bg-brand/10 text-brand">
        <MessageCircleQuestionMark className="size-6" />
      </div>
      <h1 className="mt-4 text-2xl font-bold tracking-[-0.02em]">Ask your notes</h1>
      <p className="mt-2 max-w-md text-sm text-balance text-muted-foreground">
        Ask in plain words. You'll get the part of a page that answers it, with any warnings first, and links to read more.
      </p>
      <Suggestions spaces={spaces} onAsk={onAsk} />
      <ul className="mt-10 grid max-w-md gap-1.5 text-left text-xs text-muted-foreground">
        <li>• Follow up with short questions like “what about kids?” and it stays on the same topic.</li>
        <li>• Misspellings are fine. So are “X vs Y” comparisons.</li>
        <li>• Pick where to look from the menu at the top right, or type “/in vehicles”.</li>
        <li>• Type / for commands, like /fresh to start a new topic or /clear to start over.</li>
      </ul>
    </div>
  )
}

function TurnView({
  turn,
  latest,
  onRetry,
  onChip,
  onScope,
  onAsk,
  spaces,
}: {
  turn: Turn
  latest: boolean
  onRetry: () => void
  onChip: (label: string, path: string, section: number) => void
  onScope: (c: ScopeChoice) => void
  onAsk: (q: string) => void
  spaces: string[]
}) {
  const a = turn.answer
  if (turn.note) return <NoteView turn={turn} note={turn.note} latest={latest} onScope={onScope} onAsk={onAsk} spaces={spaces} />
  return (
    <section aria-label={turn.question} className={cn("grid gap-4", latest && "scroll-mt-4")}>
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand px-4 py-2.5 text-sm text-brand-foreground">{turn.question}</div>
      </div>

      {turn.error ? (
        <div className="flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          <CircleAlert className="size-4 shrink-0 text-destructive" />
          <span className="flex-1">{turn.error}</span>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : !a ? (
        <div className="grid gap-2.5 rounded-xl border p-5" aria-busy="true">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-4/5" />
        </div>
      ) : (
        <AnswerView answer={a} onChip={onChip} />
      )}
    </section>
  )
}

/** The command as typed, then its reply. */
/** What to say back to small talk. */
const CHAT: Record<SmallTalk, (where: string) => { text: string; suggest: boolean }> = {
  hello: (where) => ({ text: `Hi! Ask me anything your notes cover (${where.toLowerCase() === "all spaces" ? "all spaces" : where}): how to do something, what something is, or what to do when something goes wrong. A few to try:`, suggest: true }),
  help: (where) => ({
    text: `Yes. Ask a question in plain words and I'll find the part of your notes that answers it, with any warnings first. Right now I'm looking in ${where.toLowerCase() === "all spaces" ? "all spaces" : where}. Type /help for commands. For example:`,
    suggest: true,
  }),
  thanks: () => ({ text: "You're welcome. Ask another question any time.", suggest: false }),
  bye: () => ({ text: "Bye! This conversation stays here until you close the tab.", suggest: false }),
}

function NoteView({ turn, note, latest, onScope, onAsk, spaces }: { turn: Turn; note: Note; latest: boolean; onScope: (c: ScopeChoice) => void; onAsk: (q: string) => void; spaces: string[] }) {
  if (note.kind === "chat") {
    const reply = CHAT[note.talk](note.where)
    return (
      <section aria-label={turn.question} className={cn("grid gap-3", latest && "scroll-mt-4")}>
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand px-4 py-2.5 text-sm text-brand-foreground">{turn.question}</div>
        </div>
        <div className="rounded-xl border bg-card px-4 py-3 text-sm sm:px-5">
          <p>{reply.text}</p>
          {reply.suggest && <Suggestions spaces={spaces} onAsk={onAsk} small />}
        </div>
      </section>
    )
  }
  return (
    <section aria-label={turn.question} className={cn("grid gap-3", latest && "scroll-mt-4")}>
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-4 py-2 font-mono text-[13px]">{turn.question}</div>
      </div>
      {note.kind === "help" ? (
        <div className="rounded-xl border bg-card px-4 py-3 sm:px-5">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Slash className="size-3.5 text-muted-foreground" /> Commands
          </p>
          <dl className="mt-2.5 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
            {ASK_COMMANDS.map((c) => (
              <div key={c.name} className="contents">
                <dt className="font-mono text-[13px] font-medium">
                  /{c.name}
                  {c.arg && <span className="text-muted-foreground"> {c.arg}</span>}
                </dt>
                <dd className="text-muted-foreground max-sm:mb-1.5">
                  {c.summary}
                  {c.aliases.length > 0 && <span className="text-xs"> · also {c.aliases.map((x) => `/${x}`).join(", ")}</span>}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">Type / to pick from a list. ↑ ↓ move, Tab fills in, Enter runs, Esc closes.</p>
        </div>
      ) : (
        <div className={cn("rounded-xl border bg-card px-4 py-3 text-sm sm:px-5", note.tone === "error" && "border-destructive/30 bg-destructive/5")}>
          <p>{note.text}</p>
          {note.options && note.options.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {note.options.map((c) => (
                <button
                  key={c.value || "all"}
                  type="button"
                  onClick={() => onScope(c)}
                  className="rounded-full border bg-background px-3 py-1 text-xs transition-colors hover:border-brand/40 hover:bg-brand/5"
                >
                  {c.label}
                  {c.kind === "section" && <span className="text-muted-foreground"> · section</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

const EMERGENCY = "If someone may be in danger, call 911 now. For a poisoning or a swallowed medicine or chemical, call Poison Control at 1-800-222-1222."

function AnswerView({ answer: a, onChip }: { answer: AskAnswer; onChip: (label: string, path: string, section: number) => void }) {
  const corrected = a.corrected && Object.keys(a.corrected).length > 0 ? a.corrected : undefined
  return (
    <div className="grid gap-4">
      {a.urgent && (
        <div role="alert" className="flex gap-3 rounded-xl border border-[var(--callout-danger-fg)]/30 bg-[var(--callout-danger-bg)] px-4 py-3 text-sm text-[var(--callout-danger-fg)]">
          <Phone className="mt-0.5 size-4 shrink-0" />
          <p>
            <span className="font-semibold">Emergency? </span>
            {EMERGENCY}
          </p>
        </div>
      )}

      {a.building !== undefined && a.building < 1 && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Still reading your pages for Ask ({Math.floor(a.building * 100)}%). Some answers may be missing for a few minutes.
        </p>
      )}

      {corrected && (
        <p className="text-sm text-muted-foreground">
          Showing results for{" "}
          {Object.entries(corrected).map(([from, to], i) => (
            <span key={from}>
              {i > 0 && ", "}
              <span className="font-medium text-foreground">{to}</span>
              <span className="line-through decoration-muted-foreground/60"> {from}</span>
            </span>
          ))}
        </p>
      )}

      {a.confidence === "none" || (!a.main && !a.compare?.length) ? (
        <NoAnswer query={a.query} />
      ) : (
        <>
          {a.compare && a.compare.length === 2 ? (
            <div className="grid gap-3 md:grid-cols-2">
              {a.compare.map((s) => (
                <SectionCard key={s.path + s.section} section={s} compact />
              ))}
            </div>
          ) : (
            a.main && (
              <>
                {a.confidence === "low" ? (
                  <p className="text-sm text-muted-foreground">
                    {a.missing?.length ? (
                      <>
                        Your notes don't seem to cover this: the nearest page doesn't mention <Words words={a.missing} />. Here it is anyway, in case it helps.
                      </>
                    ) : (
                      "I couldn't find a close match. This is the nearest; the related pages below may help."
                    )}
                  </p>
                ) : (
                  a.missing &&
                  a.missing.length > 0 && (
                    <p className="text-sm text-muted-foreground">
                      This page doesn't mention <Words words={a.missing} />.
                    </p>
                  )
                )}
                <SectionCard section={a.main} warning={a.warning} />
              </>
            )
          )}

          {a.chips.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs text-muted-foreground">Also on this page</span>
              {a.chips.map((c) => (
                <button
                  key={c.section}
                  type="button"
                  onClick={() => onChip(c.label, c.path, c.section)}
                  className="rounded-full border bg-card px-3 py-1 text-xs transition-colors hover:border-brand/40 hover:bg-brand/5"
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}

          {a.more.length > 0 && (
            <div className="grid gap-1.5">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">More from {a.main?.title}</h3>
              {a.more.map((s) => (
                <Expandable key={s.section} section={s} label={s.heading || "Overview"} />
              ))}
            </div>
          )}

          {a.related.length > 0 && (
            <div className="grid gap-1.5">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Related pages</h3>
              {a.related.map((s) => (
                <Expandable key={s.path} section={s} label={s.title} sub={s.heading} where={baseOf(s.path).split("/").slice(0, -1).join(" / ")} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Words in a sentence: “a”, “a” or “b”, “a”, “b” or “c”. */
function Words({ words }: { words: string[] }) {
  return (
    <>
      {words.map((w, i) => (
        <span key={w}>
          {i > 0 && (i === words.length - 1 ? " or " : ", ")}
          <span className="font-medium text-foreground">“{w}”</span>
        </span>
      ))}
    </>
  )
}

function NoAnswer({ query }: { query: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-8 text-center">
      <SearchX className="size-6 text-muted-foreground" />
      <div>
        <p className="font-medium">Nothing in your notes answers that</p>
        <p className="mt-1 text-sm text-muted-foreground">Try other words, ask about one thing at a time, or search every page.</p>
      </div>
      <Button variant="outline" size="sm" onClick={() => openPalette(query)}>
        <Search /> Search for “{query.length > 40 ? query.slice(0, 40) + "…" : query}”
      </Button>
    </div>
  )
}

/** Space › Folder › Page as small links-to-be. */
function Crumbs({ path }: { path: string }) {
  const parts = baseOf(path).split("/")
  return (
    <span className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
      {parts.slice(0, -1).map((p, i) => (
        <span key={i} className="flex shrink-0 items-center gap-1 max-sm:[&:not(:first-child)]:hidden">
          {p}
          <ChevronRight className="size-3 opacity-60" />
        </span>
      ))}
    </span>
  )
}

function SectionCard({ section: s, warning, compact }: { section: AskSection; warning?: AskSection; compact?: boolean }) {
  const href = pageUrl(s.path, s.heading || undefined)
  return (
    <article className="overflow-hidden rounded-xl border bg-card">
      <header className="flex items-center gap-3 border-b px-4 py-2.5 sm:px-5">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <div className="grid min-w-0 flex-1">
          <Crumbs path={s.path} />
          <Link to={href} className="truncate font-medium hover:underline">
            {s.title}
            {s.heading && <span className="font-normal text-muted-foreground"> › {s.heading}</span>}
          </Link>
        </div>
        <Button asChild variant="ghost" size="sm" className="shrink-0 text-muted-foreground">
          <Link to={href}>
            Open <ArrowRight />
          </Link>
        </Button>
      </header>
      <div className={cn("px-4 py-3 sm:px-5", compact && "max-h-[28rem] overflow-y-auto")}>
        {warning && <Rendered section={warning} />}
        <Rendered section={s} />
        {s.partial && (
          <Link to={href} className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
            Read the rest of this section <ArrowRight className="size-3.5" />
          </Link>
        )}
      </div>
    </article>
  )
}

/** A heading that opens to show its section. */
function Expandable({ section: s, label, sub, where }: { section: AskSection; label: string; sub?: string; where?: string }) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-accent/50">
        <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-sm font-medium">
            {label}
            {sub && <span className="font-normal text-muted-foreground"> › {sub}</span>}
            {where && <span className="ml-2 text-xs font-normal text-muted-foreground">{where}</span>}
          </span>
          {!open && s.snippet && <Snippet text={s.snippet} />}
        </span>
      </button>
      {open && (
        <div className="border-t px-4 py-2 sm:px-5">
          <Rendered section={s} />
          <button type="button" onClick={() => navigate(pageUrl(s.path, s.heading || undefined))} className="mb-1 inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
            Open {s.title} <ArrowRight className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

/** Snippets mark the words asked with \x02…\x03. */
function Snippet({ text }: { text: string }) {
  // oxlint-disable-next-line no-control-regex
  const parts = text.split(/(\x02[^\x03]*\x03)/g)
  return (
    <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
      {parts.map((p, i) =>
        p.startsWith("\x02") ? (
          <mark key={i} className="rounded-[3px] bg-mark px-0.5 text-foreground">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  )
}

/** A section's Markdown, shown the way its page shows it, links and all. */
function Rendered({ section: s }: { section: AskSection }) {
  const resolver = useResolver()
  const { data: tree } = useTree()
  const actions = useVaultActions()
  const navigate = useNavigate()
  return (
    <div className="ask-answer">
      <PageEditor
        markdown={s.markdown}
        editable={false}
        compact
        env={{
          path: s.path,
          resolver,
          pages: tree?.notes ?? [],
          linkMode: "app",
          fileUrl,
          openLink: (target, heading) => void actions.openLink(target, s.path, heading),
          openTag: (tag) => navigate(`/tags/${encodeURIComponent(tag)}`),
          upload: async () => undefined,
        }}
      />
    </div>
  )
}
