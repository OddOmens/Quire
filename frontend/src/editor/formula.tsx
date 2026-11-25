import { useContext, useEffect, useRef, useState } from "react"
import { InputRule, Node, type Editor } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type ReactNodeViewProps } from "@tiptap/react"
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { cn } from "cn"
import { SquareFunction } from "lucide-react"

import { EditorEnvContext } from "@/editor/views"
import { api, type FormulaResult } from "@/lib/api"
import { display, fromFormula } from "@/lib/table"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    formula: {
      /** Inserts a formula and selects it, which opens it for editing. */
      insertFormula: (expr?: string) => ReturnType
    }
  }
}

// Single braces may appear inside ({Column} errors helpfully on a page), so
// only a doubled brace closes the formula.
const inner = String.raw`(?:[^{}\n]|\{[^{}\n]*\})+?`
const formulaInput = new RegExp(String.raw`(?<!\{)\{\{(${inner})\}\}$`)

/**
 * A formula inside a sentence, stored as {{ … }}: "Spent {{ SUM([Budget/Amount]) }}".
 * The text between the braces is kept as written, spaces included, so the
 * Markdown comes back byte for byte.
 */
export const Formula = Node.create({
  name: "formula",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { raw: { default: "", parseHTML: (el) => el.getAttribute("data-expr") ?? "" } }
  },
  parseHTML: () => [{ tag: "span[data-formula]" }],
  renderHTML: ({ node }) => ["span", { "data-formula": "", "data-expr": node.attrs.raw }],
  renderText: ({ node }) => `{{${node.attrs.raw}}}`,
  addNodeView() {
    return ReactNodeViewRenderer(FormulaView, { as: "span" })
  },
  addCommands() {
    return {
      insertFormula:
        (expr = "") =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            const pos = tr.selection.from
            tr.replaceSelectionWith(this.type.create({ raw: expr ? ` ${expr} ` : "" }), false)
            tr.setSelection(NodeSelection.create(tr.doc, pos))
          }
          return true
        },
    }
  },
  addInputRules() {
    return [
      new InputRule({
        find: formulaInput,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create({ raw: match[1] }))
        },
      }),
    ]
  },
})

// ── Working formulas out ──

/**
 * Collects the formulas a page asks for in the same tick and sends them in
 * one request, so a page with twenty formulas makes one call, not twenty.
 */
const batches = new Map<string, { exprs: string[]; waiters: ((r: FormulaResult[]) => void)[]; fail: ((e: unknown) => void)[] }>()

function evaluate(path: string, expr: string): Promise<FormulaResult> {
  let batch = batches.get(path)
  if (!batch) {
    const b = { exprs: [] as string[], waiters: [] as ((r: FormulaResult[]) => void)[], fail: [] as ((e: unknown) => void)[] }
    batches.set(path, b)
    batch = b
    setTimeout(() => {
      batches.delete(path)
      api.evalFormulas(path, b.exprs).then(
        (res) => b.waiters.forEach((w) => w(res)),
        (e) => b.fail.forEach((f) => f(e)),
      )
    }, 0)
  }
  const i = batch.exprs.length
  batch.exprs.push(expr)
  return new Promise((resolve, reject) => {
    batch.waiters.push((res) => resolve(res[i] ?? { value: null }))
    batch.fail.push(reject)
  })
}

// Formulas read databases, so they follow any database's data changing.
const watched = new WeakSet<QueryClient>()
function watchTables(qc: QueryClient) {
  if (watched.has(qc)) return
  watched.add(qc)
  let timer: ReturnType<typeof setTimeout> | undefined
  qc.getQueryCache().subscribe((e) => {
    if (e.type !== "updated" || e.query.queryKey[0] !== "table" || e.action.type !== "success") return
    clearTimeout(timer)
    timer = setTimeout(() => void qc.invalidateQueries({ queryKey: ["formulas"] }), 300)
  })
}

export function useFormula(path: string, expr: string, enabled = true) {
  const qc = useQueryClient()
  useEffect(() => watchTables(qc), [qc])
  const text = expr.trim()
  return useQuery({
    queryKey: ["formulas", path, text],
    queryFn: () => evaluate(path, text),
    enabled: enabled && !!path && !!text,
    staleTime: 10_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })
}

/** A result as the pill shows it, plus its error message if it is one. */
export function formatResult(r: FormulaResult | undefined): { text: string; error?: string } {
  if (!r) return { text: "" }
  const cell = fromFormula(r.value)
  if (cell.kind === "error") return { text: cell.code, error: cell.message || r.error }
  if (r.error) return { text: "#ERROR!", error: r.error }
  const text = display(cell)
  return { text: text === "" ? "–" : text }
}

function useEditable(editor: Editor) {
  return useEditorState({ editor, selector: ({ editor: e }) => e.isEditable })
}

export function FormulaView({ node, updateAttributes, editor, selected, getPos }: ReactNodeViewProps) {
  const env = useContext(EditorEnvContext)
  const editable = useEditable(editor)
  const raw = node.attrs.raw as string
  const expr = raw.trim()
  const plain = !env || env.linkMode === "plain"
  const editing = selected && editable && !plain
  const [draft, setDraft] = useState(expr)
  const cancelled = useRef(false)
  useEffect(() => setDraft(expr), [expr])
  // While editing, preview what's typed after a pause.
  const [preview, setPreview] = useState(expr)
  useEffect(() => {
    const t = setTimeout(() => setPreview(draft.trim()), 350)
    return () => clearTimeout(t)
  }, [draft])

  const { data, isLoading } = useFormula(env?.path ?? "", expr, !plain)
  const live = useFormula(env?.path ?? "", preview, editing && preview !== expr)

  if (plain) {
    // Public pages can't read databases, so they show the formula itself.
    return (
      <NodeViewWrapper as="span" className="rounded bg-muted px-1 py-px font-mono text-[0.85em] text-muted-foreground">
        {`{{${raw}}}`}
      </NodeViewWrapper>
    )
  }

  const shown = formatResult(data)
  const after = () => {
    const pos = typeof getPos === "function" ? getPos() : undefined
    if (typeof pos === "number") editor.chain().focus().setTextSelection(pos + node.nodeSize).run()
    else editor.commands.focus()
  }
  const save = () => {
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    const next = draft.trim()
    if (next !== expr) updateAttributes({ raw: next ? ` ${next} ` : "" })
  }
  const previewResult = formatResult(preview === expr ? data : live.data)

  return (
    <NodeViewWrapper as="span" className="relative">
      <span
        contentEditable={false}
        title={shown.error ?? (expr ? `= ${expr}` : undefined)}
        className={cn(
          "inline-flex items-baseline gap-1 rounded-md border px-1.5 py-px align-baseline text-[0.95em] tabular-nums transition-colors",
          shown.error ? "border-destructive/40 text-destructive" : "border-border bg-surface",
          !expr && "text-muted-foreground",
          selected && "border-brand bg-brand-soft",
          editable && "cursor-pointer",
        )}
      >
        <SquareFunction className="size-[0.85em] shrink-0 self-center text-muted-foreground" />
        {!expr ? "Formula" : isLoading ? "…" : shown.text}
      </span>
      {editing && (
        <span contentEditable={false} className="absolute top-[calc(100%+4px)] left-0 z-30 grid w-80 gap-1.5 rounded-md border bg-popover p-2 text-sm shadow-lg">
          <input
            autoFocus
            value={draft}
            spellCheck={false}
            placeholder="SUM([Budget/Amount])"
            aria-label="Formula"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === "Enter") {
                e.preventDefault()
                save()
                after()
              } else if (e.key === "Escape") {
                e.preventDefault()
                cancelled.current = true
                setDraft(expr)
                after()
              }
            }}
            className="w-full rounded border bg-background px-2 py-1 font-mono text-[0.8rem] outline-none focus:ring-2 focus:ring-ring/40"
          />
          <span className={cn("truncate text-xs", previewResult.error ? "text-destructive" : "text-muted-foreground")}>
            {!draft.trim()
              ? "Name a database column like [Budget/Amount]. Enter saves, Escape cancels."
              : previewResult.error
                ? previewResult.error
                : `= ${previewResult.text || "…"}`}
          </span>
        </span>
      )}
    </NodeViewWrapper>
  )
}
