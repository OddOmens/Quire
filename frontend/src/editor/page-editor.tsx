import { useEffect, useMemo, useRef } from "react"
import { createDocument, type Editor } from "@tiptap/core"
import { redoDepth, undoDepth } from "@tiptap/pm/history"
import { NodeSelection, Selection } from "@tiptap/pm/state"
import { EditorContent, useEditor } from "@tiptap/react"
import { cn } from "cn"

import type { HistoryControls } from "@/components/undo-redo"
import { createExtensions, type EditorEnv } from "@/editor/extensions"
import { BlockHandle } from "@/editor/block-handle"
import { embedHost } from "@/editor/embed-host"
import { ColumnsBubble, ImageBubble, TableBubble, TextBubble } from "@/editor/menus"
import { slashItems } from "@/editor/slash-items"
import { TouchBar } from "@/editor/touch-bar"
import { EditorEnvContext } from "@/editor/views"
import { isMedia, markdownToHtml } from "@/lib/markdown"
import { docToMarkdown } from "@/lib/serialize"
import "@/editor/blocks.css"

type Props = {
  /** The page body (without front matter). New values from outside replace the content. */
  markdown: string
  editable: boolean
  env: Omit<EditorEnv, "slashItems">
  onChange?: (markdown: string) => void
  onReady?: (editor: Editor) => void
  /** Called when undo or redo becomes possible or impossible. */
  onHistory?: (controls: HistoryControls) => void
  autofocus?: boolean
  placeholder?: string
  /** Less space below the content, for previews. */
  compact?: boolean
  className?: string
}

/** The visual editor. Content goes in and comes out as Markdown. */
export function PageEditor({ markdown, editable, env, onChange, onReady, onHistory, autofocus, placeholder, compact, className }: Props) {
  // preview: an uploaded PDF goes in showing its pages rather than as a file card.
  const pick = (editor: Editor, accept: string, preview = false) => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = accept
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const res = await envRef.current.upload(file)
      if (!res) return
      const name = res.name.replace(/\.[^.]+$/, "")
      if (res.kind === "file" && !isMedia(res.path) && !(preview && /\.pdf$/i.test(res.path))) {
        editor.chain().focus().insertContent({ type: "paragraph", content: [{ type: "text", text: res.name, marks: [{ type: "link", attrs: { href: res.path } }] }] }).run()
      } else {
        editor.chain().focus().setImage({ src: res.path, alt: name }).run()
      }
    }
    input.click()
  }
  const fullEnv: EditorEnv = { ...env, slashItems: (editor) => slashItems(editor, pick, envRef.current) }
  const box = useRef<HTMLDivElement>(null)
  const envRef = useRef(fullEnv)
  envRef.current = fullEnv
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onHistoryRef = useRef(onHistory)
  onHistoryRef.current = onHistory
  // The Markdown this editor last produced or loaded; anything else coming in is an outside change.
  const current = useRef(markdown)

  const extensions = useMemo(() => createExtensions(envRef, { placeholder }), []) // eslint-disable-line react-hooks/exhaustive-deps

  const editor = useEditor({
    extensions,
    content: markdownToHtml(markdown, { fileUrl: env.fileUrl }),
    editable,
    autofocus: autofocus ? "start" : false,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: "ProseMirror", spellcheck: "true" },
    },
    // A page that starts with a picture would open with the picture
    // selected (outlined, with its toolbar): start in the first text instead.
    onCreate: ({ editor: e }) => {
      const sel = e.state.selection
      if (!(sel instanceof NodeSelection) || sel.from !== 0) return
      const text = Selection.findFrom(e.state.doc.resolve(sel.to), 1, true)
      if (text) e.view.dispatch(e.state.tr.setSelection(text).setMeta("addToHistory", false))
    },
    onUpdate: ({ editor: e }) => {
      const md = docToMarkdown(e.state.doc)
      if (md === current.current) return
      current.current = md
      onChangeRef.current?.(md)
    },
  })

  useEffect(() => {
    if (editor) onReady?.(editor)
  }, [editor]) // eslint-disable-line react-hooks/exhaustive-deps

  // Tell the page when the undo and redo buttons should change.
  useEffect(() => {
    if (!editor) return
    let last = ""
    const report = () => {
      const canUndo = editor.isEditable && undoDepth(editor.state) > 0
      const canRedo = editor.isEditable && redoDepth(editor.state) > 0
      if (`${canUndo}${canRedo}` === last) return
      last = `${canUndo}${canRedo}`
      onHistoryRef.current?.({
        canUndo,
        canRedo,
        undo: () => editor.commands.undo(),
        redo: () => editor.commands.redo(),
      })
    }
    report()
    editor.on("transaction", report)
    return () => {
      editor.off("transaction", report)
    }
  }, [editor])

  useEffect(() => {
    if (!editor || editor.isEditable === editable) return
    editor.setEditable(editable, false)
    // An empty transaction tells node views to re-render for the new mode.
    editor.view.dispatch(editor.state.tr.setMeta("quire:editable", editable))
  }, [editor, editable])

  // Replaced from outside: saved on another device, edited on disk, restored
  // from history. The page's own saves come back as the Markdown this editor
  // produced, so they never get here. Only the part that differs is replaced,
  // and not as an undoable step, so undo keeps working on your own edits
  // elsewhere and never quietly reverts someone else's.
  useEffect(() => {
    if (!editor || markdown === current.current) return
    current.current = markdown
    const { state } = editor
    const next = createDocument(markdownToHtml(markdown, { fileUrl: envRef.current.fileUrl }), editor.schema)
    const start = next.content.findDiffStart(state.doc.content)
    if (start == null) return
    let { a: endNext, b: endNow } = next.content.findDiffEnd(state.doc.content)!
    const overlap = start - Math.min(endNext, endNow)
    if (overlap > 0) {
      endNext += overlap
      endNow += overlap
    }
    const tr = state.tr.replace(start, endNow, next.slice(start, endNext))
    editor.view.dispatch(tr.setMeta("addToHistory", false).setMeta("preventUpdate", true))
  }, [editor, markdown])

  return (
    <EditorEnvContext.Provider value={fullEnv}>
      <div ref={box} className={cn("page-content relative", compact && "compact", className)}>
        <EditorContent editor={editor} />
        {editor && editable && (
          <>
            <TextBubble editor={editor} />
            <TableBubble editor={editor} />
            <ColumnsBubble editor={editor} />
            <ImageBubble editor={editor} />
            <BlockHandle editor={editor} container={box} />
            <TouchBar editor={editor} container={box} />
          </>
        )}
      </div>
    </EditorEnvContext.Provider>
  )
}

// Embedded pages are shown with this same editor, read-only.
embedHost.Editor = PageEditor
