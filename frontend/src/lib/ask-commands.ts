/** Slash commands typed into the Ask box, like /help or /clear. */

export type AskCommandName = "help" | "clear" | "in" | "fresh" | "again" | "open" | "copy" | "search"

export type AskCommand = {
  name: AskCommandName
  /** Other names that run the same command. */
  aliases: string[]
  /** What goes after the name, shown in help and the menu. */
  arg?: string
  /** Whether the command needs that argument. */
  needsArg?: boolean
  summary: string
}

export const ASK_COMMANDS: AskCommand[] = [
  { name: "help", aliases: ["commands", "?"], summary: "Show these commands" },
  {
    name: "clear",
    aliases: ["new", "reset"],
    summary: "Start a new conversation",
  },
  {
    name: "in",
    aliases: ["scope", "space"],
    arg: "space",
    summary: "Look only in one space or section (/in all to look everywhere)",
  },
  {
    name: "fresh",
    aliases: ["f"],
    arg: "question",
    needsArg: true,
    summary: "Ask without following on from the last answer",
  },
  {
    name: "again",
    aliases: ["retry"],
    summary: "Ask the last question again, as a new question",
  },
  {
    name: "open",
    aliases: ["go"],
    summary: "Open the page of the last answer",
  },
  { name: "copy", aliases: [], summary: "Copy the last answer's text" },
  {
    name: "search",
    aliases: ["s", "find"],
    arg: "words",
    needsArg: true,
    summary: "Search every page for words",
  },
]

export type ParsedCommand = { kind: "command"; command: AskCommand; arg: string } | { kind: "unknown"; name: string }

/** Reads "/name rest". Text that doesn't start with a slash isn't a command. */
export function parseAskCommand(text: string): ParsedCommand | null {
  const m = /^\/(\S*)\s*([\s\S]*)$/.exec(text.trim())
  if (!m) return null
  const name = m[1].toLowerCase()
  const command = ASK_COMMANDS.find((c) => c.name === name || c.aliases.includes(name))
  if (!command) return { kind: "unknown", name }
  return { kind: "command", command, arg: m[2].trim() }
}

/** Commands for the menu while the name is still being typed ("/c" → clear, copy). */
export function matchAskCommands(text: string): AskCommand[] {
  const m = /^\/(\S*)$/.exec(text)
  if (!m) return []
  const typed = m[1].toLowerCase()
  return ASK_COMMANDS.filter((c) => c.name.startsWith(typed) || c.aliases.includes(typed))
}

export type ScopeChoice = {
  value: string
  label: string
  kind: "all" | "section" | "space"
}

/** Everything /in can take: all, then sections, then spaces. */
export function scopeChoices(spaces: string[], sections: { name: string; spaces: string[] }[]): ScopeChoice[] {
  return [
    { value: "", label: "All spaces", kind: "all" },
    ...sections
      .filter((s) => s.spaces.length > 0)
      .map((s) => ({
        value: `section:${s.name}`,
        label: s.name,
        kind: "section" as const,
      })),
    ...spaces.map((s) => ({
      value: `space:${s}`,
      label: s,
      kind: "space" as const,
    })),
  ]
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()

/**
 * Finds what "/in vehicles" means: an exact name first (sections before spaces),
 * then the only name that starts with it, then the only one that contains it.
 * Several matches come back as a list so the user can pick.
 */
export function resolveScope(arg: string, choices: ScopeChoice[]): { match?: ScopeChoice; options: ScopeChoice[] } {
  const a = norm(arg)
  if (["all", "everything", "everywhere", "all spaces", "*"].includes(a)) return { match: choices[0], options: [] }
  const named = choices.filter((c) => c.kind !== "all")
  const exact = named.filter((c) => norm(c.label) === a)
  if (exact.length) return { match: exact[0], options: [] }
  for (const test of [(l: string) => l.startsWith(a), (l: string) => l.includes(a)]) {
    const hits = named.filter((c) => test(norm(c.label)))
    if (hits.length === 1) return { match: hits[0], options: [] }
    if (hits.length > 1) return { options: hits }
  }
  return { options: [] }
}

/** Scope choices for the menu while typing "/in veh". */
export function matchScopeArg(text: string, choices: ScopeChoice[]): ScopeChoice[] {
  const m = /^\/(in|scope|space)\s+(.*)$/i.exec(text)
  if (!m) return []
  const a = norm(m[2])
  if (!a) return choices
  return choices.filter((c) => norm(c.label).includes(a) || (c.kind === "all" && "all".startsWith(a)))
}

/** Chat that isn't a question for the notes: a greeting, thanks, or asking what this is. */
export type SmallTalk = "hello" | "help" | "thanks" | "bye"

const HELLO = String.raw`(hi|hello|hey|hiya|howdy|yo|greetings|good (morning|afternoon|evening|day))( (there|quire|friend|buddy|all))?`
const SMALL_TALK: [SmallTalk, RegExp][] = [
  ["hello", new RegExp(`^(${HELLO})( how are you( doing)?| how's it going| what's up)?$|^(how are you( doing)?|how's it going|what's up|sup)$`)],
  [
    "help",
    new RegExp(
      `^((${HELLO}) )?(` +
        [
          String.raw`(can|could|will|would) you (please )?help( me)?( out)?`,
          String.raw`(please )?help( me)?( out)?`,
          String.raw`i need (some )?help`,
          String.raw`what (can|do|should) (you|i) (do|ask)( here)?`,
          String.raw`what (are|is) (you|this)( for)?`,
          String.raw`who are you`,
          String.raw`how (does|do) (this|you|it) work`,
          String.raw`how do i use (this|you|it)`,
          String.raw`are you (there|working|awake|an? (ai|bot|robot|person|human))`,
          String.raw`what do you know( about)?`,
        ].join("|") +
        ")( please)?$",
    ),
  ],
  ["thanks", /^(ok(ay)? )?(thanks|thank you|thx|ty|cheers|much appreciated|appreciate it)( (so much|a lot|very much))?( (that helps|that helped))?$|^(great|awesome|cool|perfect|nice|got it|ok|okay|that helps|that helped)( (thanks|thank you))?$/],
  ["bye", /^(bye|goodbye|bye bye|see (you|ya)( later)?|later|good night|night|cya)$/],
]

/** Whether the whole message is small talk; a question with a topic ("can you help me fix a flat") isn't. */
export function smallTalk(text: string): SmallTalk | null {
  const t = text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!t || t.length > 60) return null
  for (const [kind, re] of SMALL_TALK) if (re.test(t)) return kind
  return null
}
