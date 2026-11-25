import { useEffect, useRef } from "react"
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, redoDepth, undo, undoDepth } from "@codemirror/commands"
import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { languages } from "@codemirror/language-data"
import { searchKeymap } from "@codemirror/search"
import { Compartment, EditorState, Transaction } from "@codemirror/state"
import { drawSelection, EditorView, keymap, placeholder } from "@codemirror/view"
import { tags as t } from "@lezer/highlight"

import type { HistoryControls } from "@/components/undo-redo"

const style = HighlightStyle.define([
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], class: "cm-md-heading" },
  { tag: t.processingInstruction, class: "cm-md-mark" },
  { tag: t.strong, class: "cm-md-strong" },
  { tag: t.emphasis, class: "cm-md-em" },
  { tag: [t.link, t.url], class: "cm-md-link" },
  { tag: [t.keyword, t.controlKeyword], color: "var(--hl-keyword)" },
  { tag: [t.string, t.regexp], color: "var(--hl-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--hl-number)" },
  { tag: t.comment, color: "var(--hl-comment)", fontStyle: "italic" },
])

type Props = {
  value: string
  onChange: (v: string) => void
  editable: boolean
  /** Called when undo or redo becomes possible or impossible. */
  onHistory?: (controls: HistoryControls) => void
}

/** Plain Markdown editing, for pages the visual editor can't represent. */
export function SourceEditor({ value, onChange, editable, onHistory }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const editing = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onHistoryRef = useRef(onHistory)
  onHistoryRef.current = onHistory

  useEffect(() => {
    let last = ""
    const report = (v: EditorView) => {
      const canUndo = v.state.facet(EditorView.editable) && undoDepth(v.state) > 0
      const canRedo = v.state.facet(EditorView.editable) && redoDepth(v.state) > 0
      if (`${canUndo}${canRedo}` === last) return
      last = `${canUndo}${canRedo}`
      onHistoryRef.current?.({ canUndo, canRedo, undo: () => undo(v), redo: () => redo(v) })
    }
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          closeBrackets(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          syntaxHighlighting(style),
          placeholder("Write Markdown…"),
          keymap.of([...closeBracketsKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(Transaction.remote))) onChangeRef.current(u.state.doc.toString())
            report(u.view)
          }),
          editing.current.of(EditorView.editable.of(editable)),
        ],
      }),
    })
    view.current = v
    report(v)
    return () => v.destroy()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Switching between editing and reading keeps the undo history.
  useEffect(() => {
    view.current?.dispatch({ effects: editing.current.reconfigure(EditorView.editable.of(editable)) })
  }, [editable])

  // Changed from outside (front matter set from the ⋯ menu, a save from
  // another device): replace only the part that differs, outside the undo
  // history, so undo keeps working on your own edits.
  useEffect(() => {
    const v = view.current
    const now = v?.state.doc.toString()
    if (!v || now === undefined || now === value) return
    let from = 0
    while (from < now.length && from < value.length && now[from] === value[from]) from++
    let end = 0
    while (end < now.length - from && end < value.length - from && now[now.length - 1 - end] === value[value.length - 1 - end]) end++
    v.dispatch({
      changes: { from, to: now.length - end, insert: value.slice(from, value.length - end) },
      annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
    })
  }, [value])

  return <div ref={host} className="min-h-[50vh]" />
}
