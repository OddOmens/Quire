import { createContext, useContext, useEffect, useRef, useState } from "react"
import type { Editor } from "@tiptap/core"
import { NodeViewContent, NodeViewWrapper, useEditorState, type ReactNodeViewProps } from "@tiptap/react"
import { cn } from "cn"
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleQuestionMark,
  Copy,
  FileText,
  Info,
  Lightbulb,
  List,
  OctagonAlert,
  Quote,
  Sigma,
  TableOfContents,
  TriangleAlert,
} from "lucide-react"
import { useTheme } from "next-themes"

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { EditorEnv } from "@/editor/extensions"
import { lowlight } from "@/editor/lowlight"
import { renderMath, renderMermaid } from "@/editor/render"

/** Whether the editor is in Edit mode; node views re-render when it changes. */
function useEditable(editor: Editor) {
  return useEditorState({ editor, selector: ({ editor: e }) => e.isEditable })
}

/** The page around the editor, for node views (links resolve against it). */
export const EditorEnvContext = createContext<EditorEnv | null>(null)

const calloutKinds = [
  { type: "note", label: "Note", icon: Info },
  { type: "tip", label: "Tip", icon: Lightbulb },
  { type: "success", label: "Success", icon: CircleCheck },
  { type: "question", label: "Question", icon: CircleQuestionMark },
  { type: "warning", label: "Warning", icon: TriangleAlert },
  { type: "danger", label: "Danger", icon: OctagonAlert },
  { type: "example", label: "Example", icon: List },
  { type: "quote", label: "Plain", icon: Quote },
] as const

export function CalloutView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const editable = useEditable(editor)
  const kind = calloutKinds.find((k) => k.type === node.attrs.type) ?? calloutKinds[0]
  const title = node.attrs.title as string
  const fold = node.attrs.fold as string
  // "> [!note]- Title" starts folded; "+" can fold but starts open.
  const [open, setOpen] = useState(fold !== "-")
  const [titling, setTitling] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const Icon = kind.icon
  const showTitle = !!title || titling || !!fold
  return (
    <NodeViewWrapper className="callout" data-callout={kind.type} data-open={open || !fold ? "true" : "false"}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!editable}>
          <button type="button" contentEditable={false} className="callout-icon rounded-sm outline-none disabled:cursor-default" aria-label="Callout options">
            <Icon className="size-[1.15rem]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44" onCloseAutoFocus={(e) => e.preventDefault()}>
          {calloutKinds.map((k) => (
            <DropdownMenuItem key={k.type} onSelect={() => updateAttributes({ type: k.type })}>
              <k.icon /> {k.label}
              {k.type === kind.type && <Check className="ml-auto" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={!!title || titling}
            onCheckedChange={(on) => {
              if (on) {
                setTitling(true)
                setTimeout(() => titleRef.current?.focus(), 50)
              } else {
                setTitling(false)
                updateAttributes({ title: "" })
              }
            }}
          >
            Title
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={!!fold}
            onCheckedChange={(on) => {
              updateAttributes({ fold: on ? "+" : "" })
              setOpen(true)
            }}
          >
            Can fold
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="min-w-0 flex-1">
        {/* A title from "> [!note] Title" stays a line of its own, as written. */}
        {showTitle && (
          <div className="callout-head" contentEditable={false}>
            {/* Reading, the title is plain text, so a long one wraps; a field can't. */}
            {!editable ? (
              <div className={cn("callout-title min-w-0 flex-1 font-semibold", !title && "opacity-60")}>{title || (fold ? kind.label : "")}</div>
            ) : (
              <input
                ref={titleRef}
                value={title}
                placeholder={fold && !titling ? kind.label : "Title"}
                onChange={(e) => updateAttributes({ title: e.target.value })}
                onBlur={() => setTitling(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    setOpen(true)
                    editor.commands.focus()
                  }
                }}
                aria-label="Callout title"
                className="callout-title block min-w-0 flex-1 bg-transparent font-semibold outline-none"
              />
            )}
            {fold && (
              <button type="button" aria-label={open ? "Fold" : "Unfold"} aria-expanded={open} onClick={() => setOpen((o) => !o)} className="callout-fold">
                <ChevronRight className="size-4" />
              </button>
            )}
          </div>
        )}
        <NodeViewContent className="callout-body" />
      </div>
    </NodeViewWrapper>
  )
}

const languages = ["plaintext", "mermaid", ...lowlight.listLanguages().filter((l) => l !== "plaintext").sort()]
const languageNames: Record<string, string> = {
  plaintext: "Plain text", javascript: "JavaScript", typescript: "TypeScript", cpp: "C++", csharp: "C#", objectivec: "Objective-C",
  graphql: "GraphQL", php: "PHP", sql: "SQL", xml: "HTML / XML", css: "CSS", scss: "SCSS", json: "JSON", yaml: "YAML", vbnet: "VB.NET",
  wasm: "WebAssembly", makefile: "Makefile", bash: "Bash", shell: "Shell", go: "Go", r: "R", c: "C", mermaid: "Mermaid diagram",
}
const languageName = (l: string) => languageNames[l] ?? l.charAt(0).toUpperCase() + l.slice(1)
/** The short, lower-case name over a code block, like "bash". */
const languageLabel = (l: string) => (l === "plaintext" ? "text" : l === "mermaid" ? "diagram" : l)

function MermaidPreview({ code }: { code: string }) {
  const { resolvedTheme } = useTheme()
  const [svg, setSvg] = useState("")
  const [error, setError] = useState("")
  useEffect(() => {
    if (!code.trim()) {
      setSvg("")
      setError("")
      return
    }
    let live = true
    const t = setTimeout(() => {
      renderMermaid(code, resolvedTheme === "dark")
        .then((out) => live && (setSvg(out), setError("")))
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message.split("\n")[0] : "This diagram has an error"))
    }, 350)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [code, resolvedTheme])
  if (error) return <div className="diagram-error">{error}</div>
  if (!svg) return <div className="diagram-empty">Write Mermaid code to draw a diagram.</div>
  return <div className="diagram" dangerouslySetInnerHTML={{ __html: svg }} />
}

export function CodeBlockView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const [copied, setCopied] = useState(false)
  const editable = useEditable(editor)
  const lang = (node.attrs.language as string | null) || "plaintext"
  const diagram = lang === "mermaid"
  return (
    <NodeViewWrapper className={cn("code-block", diagram && "is-diagram", diagram && !editable && "diagram-only")}>
      {/* The language on the left, as a menu while editing, and copy on the right. */}
      <div className="code-head" contentEditable={false}>
        {editable ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="code-lang -ml-1.5 flex h-6 items-center gap-1 rounded-md px-1.5 hover:bg-accent hover:text-foreground">
                {languageLabel(lang)} <ChevronDown className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 w-44 overflow-y-auto">
              {languages.map((l) => (
                <DropdownMenuItem key={l} onSelect={() => updateAttributes({ language: l === "plaintext" ? null : l })}>
                  {languageName(l)}
                  {l === lang && <Check className="ml-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="code-lang">{languageLabel(lang)}</span>
        )}
        <button
          type="button"
          aria-label="Copy code"
          onClick={() => {
            void navigator.clipboard?.writeText(node.textContent)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
          className="ml-auto grid size-7 place-items-center rounded-lg border bg-background text-muted-foreground hover:text-foreground"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      {diagram && (
        <div contentEditable={false}>
          <MermaidPreview code={node.textContent} />
        </div>
      )}
      <pre spellCheck={false}>
        <NodeViewContent<"code"> as="code" className={lang !== "plaintext" ? `language-${lang}` : undefined} />
      </pre>
    </NodeViewWrapper>
  )
}

export function PageLinkView({ node, selected }: ReactNodeViewProps) {
  const env = useContext(EditorEnvContext)
  const { target, heading, alias } = node.attrs as { target: string; heading: string; alias: string }
  const label = alias || (heading ? `${target} › ${heading}` : target)
  if (!env || env.linkMode === "plain") {
    return (
      <NodeViewWrapper as="span" className="page-link plain">
        {label}
      </NodeViewWrapper>
    )
  }
  const path = env.resolver.resolve(target, env.path)
  return (
    <NodeViewWrapper
      as="span"
      className={cn("page-link", !path && "missing", selected && "ProseMirror-selectednode")}
      title={path ? `Open ${path.replace(/\.md$/, "").replace(/\//g, " / ")}` : `“${target}” doesn't exist yet. Open to create it.`}
      onClick={(e: React.MouseEvent) => {
        e.preventDefault()
        env.openLink(target, heading || undefined)
      }}
    >
      <FileText className="size-[0.9em]" />
      {label}
    </NodeViewWrapper>
  )
}

export function ToggleView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const editable = useEditable(editor)
  const [open, setOpen] = useState(true)
  const summary = node.attrs.summary as string
  const level = (node.attrs.level as number) || 0
  const input = useRef<HTMLInputElement>(null)
  // A toggle just made from an empty line: the title comes first.
  useEffect(() => {
    const storage = (editor.storage as unknown as { toggle: { focusTitle: boolean } }).toggle
    if (!storage.focusTitle) return
    storage.focusTitle = false
    setTimeout(() => input.current?.focus())
  }, [editor])
  // A real heading element, so the outline and #heading links find it.
  const Title = (level ? `h${level}` : "div") as "div"
  return (
    <NodeViewWrapper className="toggle" data-open={open ? "true" : "false"} data-level={level || undefined}>
      <div className="toggle-head" contentEditable={false}>
        <button type="button" aria-label={open ? "Collapse" : "Expand"} aria-expanded={open} onClick={() => setOpen((o) => !o)} className="toggle-chevron">
          <ChevronRight className="size-4" />
        </button>
        <Title className="toggle-title" data-toggle-heading={level ? summary : undefined}>
          {editable ? (
            <input
              ref={input}
              value={summary}
              onChange={(e) => updateAttributes({ summary: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  setOpen(true)
                  editor.commands.focus()
                }
              }}
              placeholder={level ? `Toggle heading ${level}` : "Toggle title"}
              aria-label="Toggle title"
              className="toggle-summary"
            />
          ) : (
            <button type="button" className="toggle-summary text-left" onClick={() => setOpen((o) => !o)}>
              {summary || "Toggle"}
            </button>
          )}
        </Title>
      </div>
      <NodeViewContent className="toggle-body" />
    </NodeViewWrapper>
  )
}

type TocItem = { level: number; text: string; pos: number }

/** Headings and toggle headings, in page order. */
export function docHeadings(editor: Editor): TocItem[] {
  const out: TocItem[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") out.push({ level: node.attrs.level as number, text: node.textContent, pos })
    else if (node.type.name === "toggle" && node.attrs.level) out.push({ level: node.attrs.level as number, text: node.attrs.summary as string, pos })
    return !node.isTextblock
  })
  return out
}

export function TocView({ editor, selected }: ReactNodeViewProps) {
  const editable = useEditable(editor)
  const json = useEditorState({ editor, selector: ({ editor: e }) => JSON.stringify(docHeadings(e)) })
  const items = JSON.parse(json) as TocItem[]
  const top = Math.min(...items.map((i) => i.level))
  return (
    <NodeViewWrapper className={cn("toc", selected && editable && "is-selected")} contentEditable={false}>
      {items.length === 0 ? (
        <p className="toc-empty">
          <TableOfContents className="size-4" /> Headings on this page will be listed here.
        </p>
      ) : (
        <nav aria-label="Table of contents">
          {items.map((h, i) => (
            <button
              key={i}
              type="button"
              className="toc-item"
              style={{ paddingLeft: `${(h.level - top) * 1}rem` }}
              onClick={() => {
                const el = editor.view.nodeDOM(h.pos)
                if (el instanceof HTMLElement) el.scrollIntoView({ block: "start", behavior: "smooth" })
              }}
            >
              {h.text || "Untitled"}
            </button>
          ))}
        </nav>
      )}
    </NodeViewWrapper>
  )
}

function useMath(latex: string, display: boolean) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (ref.current) void renderMath(ref.current, latex, display)
  }, [latex, display])
  return ref
}

export function MathBlockView({ node, updateAttributes, editor, selected }: ReactNodeViewProps) {
  const editable = useEditable(editor)
  const latex = node.attrs.latex as string
  const [editing, setEditing] = useState(!latex && editor.isEditable)
  const ref = useMath(latex, true)
  const show = editing && editable
  return (
    <NodeViewWrapper className={cn("math-block", selected && editable && "is-selected")}>
      <div contentEditable={false} onClick={() => editable && setEditing(true)} className={cn("math-render", !latex && "is-empty")}>
        {latex ? <span ref={ref} /> : <span className="flex items-center gap-2 text-sm text-muted-foreground"><Sigma className="size-4" /> Add an equation</span>}
      </div>
      {show && (
        <div contentEditable={false} className="math-editor">
          <textarea
            autoFocus
            value={latex}
            rows={Math.max(2, latex.split("\n").length)}
            spellCheck={false}
            placeholder="E = mc^2"
            onChange={(e) => updateAttributes({ latex: e.target.value })}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if ((e.key === "Enter" && (e.metaKey || e.ctrlKey)) || e.key === "Escape") {
                e.preventDefault()
                setEditing(false)
                editor.commands.focus()
              }
            }}
          />
          <span className="math-hint">LaTeX · ⌘↵ to finish</span>
        </div>
      )}
    </NodeViewWrapper>
  )
}

export function MathInlineView({ node, updateAttributes, editor, selected }: ReactNodeViewProps) {
  const editable = useEditable(editor)
  const latex = node.attrs.latex as string
  const ref = useMath(latex, false)
  const [draft, setDraft] = useState(latex)
  useEffect(() => setDraft(latex), [latex])
  const editing = selected && editable
  return (
    <NodeViewWrapper as="span" className={cn("math-inline", selected && "is-selected")}>
      <span ref={ref} contentEditable={false} />
      {editing && (
        <span contentEditable={false} className="math-inline-editor">
          <input
            autoFocus
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => draft !== latex && updateAttributes({ latex: draft })}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                e.preventDefault()
                if (draft !== latex) updateAttributes({ latex: draft })
                editor.commands.focus()
              }
            }}
          />
        </span>
      )}
    </NodeViewWrapper>
  )
}
