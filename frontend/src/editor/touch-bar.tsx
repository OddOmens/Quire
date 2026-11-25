import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { Editor } from "@tiptap/core"
import { redoDepth, undoDepth } from "@tiptap/pm/history"
import { TextSelection } from "@tiptap/pm/state"
import { useEditorState } from "@tiptap/react"
import { cn } from "cn"
import {
  Bold,
  Check,
  Code,
  GripVertical,
  Highlighter,
  IndentDecrease,
  IndentIncrease,
  Italic,
  KeyboardOff,
  Link2,
  Link2Off,
  List,
  ListOrdered,
  ListTodo,
  Plus,
  Redo2,
  Strikethrough,
  Type,
  Underline,
  Undo2,
  X,
} from "lucide-react"

import { BLOCK_MENU_EVENT } from "@/editor/block-handle"
import { blockTypes, ColorSwatches, linkHref } from "@/editor/menus"
import { onKeyboard } from "@/lib/keyboard"
import type { Color } from "@/lib/markdown"
import { useCoarsePointer } from "@/lib/pointer"

type Panel = null | "turn" | "colour" | "link"

function Tool({
  label,
  active,
  disabled,
  onPress,
  className,
  children,
}: {
  label: string
  active?: boolean
  disabled?: boolean
  onPress: () => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      // Keeps the caret in the page, and so the keyboard up.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPress}
      className={cn(
        "grid h-11 w-11 flex-none place-items-center rounded-lg text-foreground/80 outline-none active:bg-accent disabled:opacity-35 [&_svg]:size-5",
        active && "bg-accent text-foreground",
        className,
      )}
    >
      {children}
    </button>
  )
}

const Gap = () => <span aria-hidden className="mx-1 h-5 w-px flex-none bg-border" />

/**
 * The editor's tools on a touch screen: a bar along the top of the on-screen
 * keyboard (or the bottom of the screen with a hardware keyboard) while a
 * page is being edited. It stands in for the bubble over selected text, which
 * the system's own Copy and Paste bubble covers, for the block handle, which
 * needs a pointer to hover with, and for Tab, which the keyboard hasn't got.
 */
export function TouchBar({ editor, container }: { editor: Editor; container: React.RefObject<HTMLDivElement | null> }) {
  const coarse = useCoarsePointer()
  const [panel, setPanel] = useState<Panel>(null)
  const [href, setHref] = useState("")
  const [shown, setShown] = useState(false)
  const bar = useRef<HTMLDivElement>(null)
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      focused: e.isFocused,
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      highlight: e.isActive("highlight"),
      color: (e.getAttributes("textColor").color as Color | undefined) ?? null,
      background: (e.isActive("highlight") ? ((e.getAttributes("highlight").color as Color | null) ?? "default") : null) as Color | "default" | null,
      link: e.isActive("link"),
      href: (e.getAttributes("link").href as string | undefined) ?? "",
      block: blockTypes.find((b) => b.is(e))?.label ?? "Text",
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      todo: e.isActive("taskList"),
      item: e.isActive("taskItem") ? "taskItem" : e.isActive("listItem") ? "listItem" : "",
      canUndo: undoDepth(e.state) > 0,
      canRedo: redoDepth(e.state) > 0,
    }),
  })

  // An editor in a dialog has the dialog's own bottom sheet to live in.
  const inDialog = !!container.current?.closest('[role="dialog"]')
  const wanted = coarse && !inDialog && editor.isEditable && (state.focused || panel !== null)

  // A tap elsewhere in the page takes the caret away for a moment (a menu
  // opening, the title being tapped): don't flicker over it.
  useEffect(() => {
    if (wanted) return setShown(true)
    const t = setTimeout(() => setShown(false), 120)
    return () => clearTimeout(t)
  }, [wanted])

  // The page's frame ends above the bar (components/app-shell.tsx), and the
  // caret is brought back into what's left of it.
  useEffect(() => {
    if (!shown) return
    const root = document.documentElement
    const el = bar.current
    let frame = 0
    const reveal = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => !editor.isDestroyed && editor.isFocused && editor.commands.scrollIntoView())
    }
    const size = () => {
      if (el) root.style.setProperty("--touchbar-h", `${el.offsetHeight}px`)
      reveal()
    }
    size()
    const observer = el ? new ResizeObserver(size) : null
    // Its padding changes with the keyboard (the home bar's space comes and goes), not what's inside.
    if (el) observer?.observe(el, { box: "border-box" })
    const off = onKeyboard(size)
    return () => {
      observer?.disconnect()
      off()
      cancelAnimationFrame(frame)
      root.style.setProperty("--touchbar-h", "0px")
    }
  }, [shown, editor])

  if (!shown) return null

  const chain = () => editor.chain().focus()
  const toggle = (next: Panel) => setPanel((p) => (p === next ? null : next))

  /** Starts the "/" menu: on this line if it's empty, on a new one below otherwise. */
  const insert = () => {
    setPanel(null)
    const { state: s, view } = editor
    const { $from } = s.selection
    if ($from.parent.isTextblock && $from.parent.content.size === 0) {
      chain().insertContent("/").run()
      return
    }
    const at = $from.depth > 0 ? $from.after() : s.doc.content.size
    const tr = s.tr.insert(at, s.schema.nodes.paragraph.create(null, s.schema.text("/")))
    tr.setSelection(TextSelection.create(tr.doc, at + 2))
    view.dispatch(tr.scrollIntoView())
    view.focus()
  }

  const applyLink = () => {
    const url = href.trim()
    if (!url) chain().extendMarkRange("link").unsetLink().run()
    else chain().extendMarkRange("link").setLink({ href: linkHref(url) }).run()
    setPanel(null)
  }

  return createPortal(
    <div
      ref={bar}
      role="toolbar"
      aria-label="Formatting"
      data-touch-bar
      className="fixed inset-x-0 bottom-(--kb) z-40 border-t bg-background/95 pr-(--sar) pb-(--sab) pl-(--sal) backdrop-blur-xl select-none in-data-keyboard:pb-0"
    >
      {panel === "turn" && (
        <div role="menu" aria-label="Turn into" className="grid grid-cols-2 gap-1 border-b p-2">
          {blockTypes.map((b) => (
            <button
              key={b.label}
              type="button"
              role="menuitem"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                b.run(editor)
                setPanel(null)
              }}
              className={cn("flex h-10 items-center justify-between rounded-lg px-3 text-left text-sm active:bg-accent", b.label === state.block && "bg-accent font-medium")}
            >
              {b.label}
              {b.label === state.block && <Check className="size-4" />}
            </button>
          ))}
        </div>
      )}
      {panel === "colour" && (
        <div className="border-b p-1 [&_.grid-cols-5]:grid-cols-10 [&_.grid-cols-5]:gap-1.5 [&_.grid-cols-5>button]:h-9 [&_.grid-cols-5>button]:w-full">
          <ColorSwatches
            text={state.color}
            background={state.background}
            onText={(c) => chain().setTextColor(c).run()}
            onBackground={(c) => chain().setBackground(c).run()}
          />
        </div>
      )}
      {panel === "link" && (
        <form
          className="flex items-center gap-1 border-b p-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            applyLink()
          }}
        >
          <input
            autoFocus
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            enterKeyHint="done"
            value={href}
            onChange={(e) => setHref(e.target.value)}
            placeholder="Paste or type a link"
            aria-label="Link address"
            className="h-10 min-w-0 flex-1 rounded-lg bg-muted px-3 outline-none placeholder:text-muted-foreground"
          />
          {state.link && (
            <Tool
              label="Remove link"
              onPress={() => {
                chain().extendMarkRange("link").unsetLink().run()
                setPanel(null)
              }}
            >
              <Link2Off />
            </Tool>
          )}
          <Tool label="Apply" onPress={applyLink}>
            <Check />
          </Tool>
          <Tool
            label="Cancel"
            onPress={() => {
              setPanel(null)
              editor.commands.focus()
            }}
          >
            <X />
          </Tool>
        </form>
      )}
      <div className="flex items-center">
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto overscroll-x-contain px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Tool label="Add a block" onPress={insert}>
            <Plus />
          </Tool>
          <Tool label={`Turn into (now ${state.block})`} active={panel === "turn"} onPress={() => toggle("turn")}>
            <Type />
          </Tool>
          <Tool
            label="Block options"
            onPress={() => {
              setPanel(null)
              editor.view.dom.dispatchEvent(new CustomEvent(BLOCK_MENU_EVENT))
            }}
          >
            <GripVertical />
          </Tool>
          <Gap />
          <Tool label="Bold" active={state.bold} onPress={() => chain().toggleBold().run()}>
            <Bold />
          </Tool>
          <Tool label="Italic" active={state.italic} onPress={() => chain().toggleItalic().run()}>
            <Italic />
          </Tool>
          <Tool label="Underline" active={state.underline} onPress={() => chain().toggleUnderline().run()}>
            <Underline />
          </Tool>
          <Tool label="Strikethrough" active={state.strike} onPress={() => chain().toggleStrike().run()}>
            <Strikethrough />
          </Tool>
          <Tool label="Inline code" active={state.code} onPress={() => chain().toggleCode().run()}>
            <Code />
          </Tool>
          <Tool label="Highlight" active={state.highlight} onPress={() => chain().toggleHighlight().run()}>
            <Highlighter />
          </Tool>
          <Tool label="Colour" active={panel === "colour"} onPress={() => toggle("colour")}>
            <span
              className="grid size-6 place-items-center rounded text-[0.9375rem] font-semibold"
              style={{
                color: state.color ? `var(--text-${state.color})` : undefined,
                background: state.background && state.background !== "default" ? `var(--bg-${state.background})` : undefined,
              }}
            >
              A
            </span>
          </Tool>
          <Tool
            label={state.link ? "Edit link" : "Link"}
            active={state.link || panel === "link"}
            onPress={() => {
              setHref(state.href)
              toggle("link")
            }}
          >
            <Link2 />
          </Tool>
          <Gap />
          <Tool label="To-do list" active={state.todo} onPress={() => chain().toggleTaskList().run()}>
            <ListTodo />
          </Tool>
          <Tool label="Bulleted list" active={state.bullet} onPress={() => chain().toggleBulletList().run()}>
            <List />
          </Tool>
          <Tool label="Numbered list" active={state.ordered} onPress={() => chain().toggleOrderedList().run()}>
            <ListOrdered />
          </Tool>
          <Tool label="Move out a level" disabled={!state.item} onPress={() => state.item && chain().liftListItem(state.item).run()}>
            <IndentDecrease />
          </Tool>
          <Tool label="Move in a level" disabled={!state.item} onPress={() => state.item && chain().sinkListItem(state.item).run()}>
            <IndentIncrease />
          </Tool>
          <Gap />
          <Tool label="Undo" disabled={!state.canUndo} onPress={() => chain().undo().run()}>
            <Undo2 />
          </Tool>
          <Tool label="Redo" disabled={!state.canRedo} onPress={() => chain().redo().run()}>
            <Redo2 />
          </Tool>
        </div>
        <Tool
          label="Hide the keyboard"
          className="mr-1 border-l border-transparent shadow-[-8px_0_8px_-8px_rgb(0_0_0/0.18)]"
          onPress={() => {
            setPanel(null)
            editor.commands.blur()
          }}
        >
          <KeyboardOff />
        </Tool>
      </div>
    </div>,
    document.body,
  )
}
