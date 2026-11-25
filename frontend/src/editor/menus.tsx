import { useEffect, useRef, useState } from "react"
import type { Editor } from "@tiptap/core"
import { useEditorState } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import { cn } from "cn"
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Ban,
  BetweenVerticalEnd,
  Bold,
  Check,
  ChevronDown,
  Code,
  Highlighter,
  Italic,
  Link2,
  Link2Off,
  Rows3,
  Strikethrough,
  Trash2,
  Underline,
  X,
} from "lucide-react"
import { selectedRect } from "@tiptap/pm/tables"
import { NodeSelection } from "@tiptap/pm/state"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { columnAround, MAX_COLUMNS } from "@/editor/columns"
import { colorNames } from "@/editor/marks"
import { mediaKind } from "@/lib/markdown"
import { COLORS, type Color } from "@/lib/markdown"
import { coarsePointer } from "@/lib/pointer"

function ToolButton({
  label,
  shortcut,
  active,
  onClick,
  children,
}: {
  label: string
  shortcut?: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClick}
          className={cn(
            "grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4",
            active && "bg-accent text-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {label}
        {shortcut && <span className="ml-1.5 opacity-60">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

export const blockTypes = [
  { label: "Text", is: (e: Editor) => e.isActive("paragraph") && !e.isActive("taskList") && !e.isActive("bulletList") && !e.isActive("orderedList"), run: (e: Editor) => e.chain().focus().setParagraph().run() },
  { label: "Heading 1", is: (e: Editor) => e.isActive("heading", { level: 1 }), run: (e: Editor) => e.chain().focus().setHeading({ level: 1 }).run() },
  { label: "Heading 2", is: (e: Editor) => e.isActive("heading", { level: 2 }), run: (e: Editor) => e.chain().focus().setHeading({ level: 2 }).run() },
  { label: "Heading 3", is: (e: Editor) => e.isActive("heading", { level: 3 }), run: (e: Editor) => e.chain().focus().setHeading({ level: 3 }).run() },
  { label: "Heading 4", is: (e: Editor) => e.isActive("heading", { level: 4 }), run: (e: Editor) => e.chain().focus().setHeading({ level: 4 }).run() },
  { label: "Bulleted list", is: (e: Editor) => e.isActive("bulletList"), run: (e: Editor) => e.chain().focus().toggleBulletList().run() },
  { label: "Numbered list", is: (e: Editor) => e.isActive("orderedList"), run: (e: Editor) => e.chain().focus().toggleOrderedList().run() },
  { label: "To-do list", is: (e: Editor) => e.isActive("taskList"), run: (e: Editor) => e.chain().focus().toggleTaskList().run() },
  { label: "Quote", is: (e: Editor) => e.isActive("blockquote"), run: (e: Editor) => e.chain().focus().toggleBlockquote().run() },
  { label: "Callout", is: (e: Editor) => e.isActive("callout"), run: (e: Editor) => e.chain().focus().toggleCallout().run() },
]

const swatch = "grid size-7 place-items-center rounded-md border p-0 text-[0.8125rem] font-semibold outline-none hover:ring-2 hover:ring-ring/40 focus-visible:ring-2 focus-visible:ring-ring/60 data-[on=true]:ring-2 data-[on=true]:ring-brand"

type SwatchProps = { className: string; title: string; "aria-label": string; "data-on": boolean; style?: React.CSSProperties; onPick: () => void; children: React.ReactNode }

/** A swatch inside a dropdown menu. */
const MenuSwatch = ({ onPick, ...props }: SwatchProps) => <DropdownMenuItem {...props} onSelect={onPick} />
/** A swatch in the bar over the selection: it never takes focus, so the selection stays. */
const ButtonSwatch = ({ onPick, ...props }: SwatchProps) => <button type="button" {...props} onMouseDown={(e) => e.preventDefault()} onClick={onPick} />

/**
 * Text and background colours as two rows of swatches. onText and
 * onBackground get a colour, or null for none.
 */
export function ColorSwatches({
  text,
  background,
  onText,
  onBackground,
  menu,
}: {
  text?: Color | null
  background?: Color | "default" | null
  onText: (c: Color | null) => void
  onBackground: (c: Color | null) => void
  /** Inside a dropdown menu, where the swatches are menu items. */
  menu?: boolean
}) {
  const Swatch = menu ? MenuSwatch : ButtonSwatch
  const label = "px-0.5 pb-1 text-xs font-medium text-muted-foreground"
  return (
    <div className="grid gap-2 p-1.5">
      <div>
        <div className={label}>Text</div>
        <div className="grid grid-cols-5 gap-1">
          <Swatch className={swatch} data-on={!text} title="Default" aria-label="Default text colour" onPick={() => onText(null)}>
            A
          </Swatch>
          {COLORS.map((c) => (
            <Swatch key={c} className={swatch} data-on={text === c} title={colorNames[c]} aria-label={`${colorNames[c]} text`} style={{ color: `var(--text-${c})` }} onPick={() => onText(c)}>
              A
            </Swatch>
          ))}
        </div>
      </div>
      <div>
        <div className={label}>Background</div>
        <div className="grid grid-cols-5 gap-1">
          <Swatch className={swatch + " text-muted-foreground"} data-on={!background} title="None" aria-label="No background" onPick={() => onBackground(null)}>
            <Ban className="size-3.5" />
          </Swatch>
          {COLORS.map((c) => (
            <Swatch
              key={c}
              className={swatch}
              data-on={background === c}
              title={colorNames[c]}
              aria-label={`${colorNames[c]} background`}
              style={{ background: `var(--bg-${c})` }}
              onPick={() => onBackground(c)}
            >
              A
            </Swatch>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * A button in the bar with a panel under it. The panel sits inside the bar
 * and nothing in it takes focus, so the editor keeps its selection and the
 * bar stays where it is (a menu in a portal would blur the editor and hide it).
 */
function BarPanel({ label, trigger, className, children }: { label: string; trigger: React.ReactNode; className?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
    document.addEventListener("mousedown", down)
    document.addEventListener("keydown", key)
    return () => {
      document.removeEventListener("mousedown", down)
      document.removeEventListener("keydown", key)
    }
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        className={cn("flex h-8 items-center gap-1 rounded-md px-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground", open && "bg-accent text-foreground")}
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen(false)}
          className={cn("absolute top-full left-0 z-50 mt-2 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg", className)}
        >
          {children}
        </div>
      )}
    </div>
  )
}

/** What someone typed as a link, as an address: "example.com" means the website. */
export function linkHref(url: string) {
  return /^[a-z][a-z0-9+.-]*:|^\/|^#|^attachments\//i.test(url) ? url : `https://${url}`
}

/** The formatting bar over selected text. */
export function TextBubble({ editor }: { editor: Editor }) {
  const [linking, setLinking] = useState(false)
  const [href, setHref] = useState("")
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      underline: e.isActive("underline"),
      color: (e.getAttributes("textColor").color as Color | undefined) ?? null,
      background: (e.isActive("highlight") ? ((e.getAttributes("highlight").color as Color | null) ?? "default") : null) as Color | "default" | null,
      code: e.isActive("code"),
      highlight: e.isActive("highlight"),
      link: e.isActive("link"),
      href: (e.getAttributes("link").href as string | undefined) ?? "",
      block: blockTypes.find((b) => b.is(e))?.label ?? "Text",
    }),
  })

  const applyLink = () => {
    const url = href.trim()
    if (!url) editor.chain().focus().extendMarkRange("link").unsetLink().run()
    else editor.chain().focus().extendMarkRange("link").setLink({ href: linkHref(url) }).run()
    setLinking(false)
  }

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top", offset: 8 }}
      shouldShow={({ editor: e, state: s }) => {
        const { empty } = s.selection
        // Fingers get these tools in the bar above the keyboard (touch-bar.tsx); here they'd sit under the system's own Copy and Paste bubble.
        if (coarsePointer()) return false
        if (empty || !e.isEditable || e.isActive("codeBlock") || e.isActive("image") || e.isActive("pageLink")) return false
        return !("node" in s.selection)
      }}
      className="z-40 flex items-center gap-0.5 rounded-lg border bg-popover p-1 shadow-lg"
    >
      {linking ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            applyLink()
          }}
        >
          <input
            autoFocus
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setLinking(false)}
            placeholder="Paste or type a link"
            className="h-8 w-60 rounded-md bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
          />
          <ToolButton label="Apply" onClick={applyLink}>
            <Check />
          </ToolButton>
          <ToolButton label="Cancel" onClick={() => setLinking(false)}>
            <X />
          </ToolButton>
        </form>
      ) : (
        <>
          <BarPanel
            label="Turn into"
            className="w-44"
            trigger={
              <>
                {state.block} <ChevronDown className="size-3.5" />
              </>
            }
          >
            {blockTypes.map((b) => (
              <button
                key={b.label}
                type="button"
                role="menuitem"
                onClick={() => b.run(editor)}
                className="flex w-full items-center rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              >
                {b.label}
                {b.label === state.block && <Check className="ml-auto size-4" />}
              </button>
            ))}
          </BarPanel>
          <span className="mx-0.5 h-5 w-px bg-border" />
          <ToolButton label="Bold" shortcut="⌘B" active={state.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
            <Bold />
          </ToolButton>
          <ToolButton label="Italic" shortcut="⌘I" active={state.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <Italic />
          </ToolButton>
          <ToolButton label="Underline" shortcut="⌘U" active={state.underline} onClick={() => editor.chain().focus().toggleUnderline().run()}>
            <Underline />
          </ToolButton>
          <ToolButton label="Strikethrough" shortcut="⌘⇧S" active={state.strike} onClick={() => editor.chain().focus().toggleStrike().run()}>
            <Strikethrough />
          </ToolButton>
          <ToolButton label="Inline code" shortcut="⌘E" active={state.code} onClick={() => editor.chain().focus().toggleCode().run()}>
            <Code />
          </ToolButton>
          <ToolButton label="Highlight" shortcut="⌘⇧H" active={state.highlight} onClick={() => editor.chain().focus().toggleHighlight().run()}>
            <Highlighter />
          </ToolButton>
          <BarPanel
            label="Colour"
            className="right-0 left-auto w-[11.5rem] p-0"
            trigger={
              <>
                <span
                  className="grid size-5 place-items-center rounded text-[0.8125rem] font-semibold"
                  style={{
                    color: state.color ? `var(--text-${state.color})` : undefined,
                    background: state.background && state.background !== "default" ? `var(--bg-${state.background})` : undefined,
                  }}
                >
                  A
                </span>
                <ChevronDown className="size-3.5" />
              </>
            }
          >
            <ColorSwatches
              text={state.color}
              background={state.background}
              onText={(c) => editor.chain().focus().setTextColor(c).run()}
              onBackground={(c) => editor.chain().focus().setBackground(c).run()}
            />
          </BarPanel>
          <span className="mx-0.5 h-5 w-px bg-border" />
          <ToolButton
            label={state.link ? "Edit link" : "Link"}
            shortcut="⌘K"
            active={state.link}
            onClick={() => {
              setHref(state.href)
              setLinking(true)
            }}
          >
            <Link2 />
          </ToolButton>
          {state.link && (
            <ToolButton label="Remove link" onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}>
              <Link2Off />
            </ToolButton>
          )}
        </>
      )}
    </BubbleMenu>
  )
}

/** Aligns every cell of the cursor's column, which is what GFM tables can store; the same alignment again clears it. */
function alignColumn(editor: Editor, align: "left" | "center" | "right") {
  const { state } = editor
  let rect: ReturnType<typeof selectedRect>
  try {
    rect = selectedRect(state)
  } catch {
    return
  }
  const cells: number[] = []
  for (let col = rect.left; col < rect.right; col++) {
    for (let row = 0; row < rect.map.height; row++) cells.push(rect.map.map[row * rect.map.width + col])
  }
  const same = cells.every((pos) => rect.table.nodeAt(pos)?.attrs.align === align)
  const tr = state.tr
  for (const pos of new Set(cells)) {
    const cell = rect.table.nodeAt(pos)
    if (cell) tr.setNodeMarkup(rect.tableStart + pos, undefined, { ...cell.attrs, align: same ? null : align })
  }
  editor.view.dispatch(tr)
  editor.view.focus()
}

/** Add or remove a column while the cursor is in a set of columns. */
export function ColumnsBubble({ editor }: { editor: Editor }) {
  const count = useEditorState({ editor, selector: ({ editor: e }) => columnAround(e.state)?.columns.childCount ?? 0 })
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="columnsBubble"
      options={{ placement: "top-end", offset: 8 }}
      // Only once the editor has focus: a page that opens with the cursor
      // in columns would otherwise show the bar before it's on the page.
      shouldShow={({ editor: e, state: s }) => e.isEditable && e.isFocused && s.selection.empty && !e.isActive("table") && columnAround(s) !== null}
      getReferencedVirtualElement={() => {
        const at = columnAround(editor.state)
        const dom = at ? (editor.view.nodeDOM(at.pos) as HTMLElement | null)?.parentElement : null
        return dom ? { getBoundingClientRect: () => dom.getBoundingClientRect(), getClientRects: () => dom.getClientRects() } : null
      }}
      className="z-40 flex items-center gap-0.5 rounded-lg border bg-popover p-1 shadow-lg"
    >
      <ToolButton label={count >= MAX_COLUMNS ? `${MAX_COLUMNS} columns at most` : "Add a column"} onClick={() => editor.chain().focus().addColumn().run()}>
        <BetweenVerticalEnd className={cn(count >= MAX_COLUMNS && "opacity-40")} />
      </ToolButton>
      <ToolButton label="Remove this column" onClick={() => editor.chain().focus().removeColumn().run()}>
        <Trash2 />
      </ToolButton>
    </BubbleMenu>
  )
}

/** The picture that's selected, if one is (not a video, audio or PDF). */
function selectedPicture(editor: Editor) {
  const sel = editor.state.selection
  if (!(sel instanceof NodeSelection) || sel.node.type.name !== "image") return null
  return mediaKind(String(sel.node.attrs.src ?? "")) === "image" ? sel : null
}

type Side = "left" | "center" | "right"

/** Put the selected picture on the left, in the centre or on the right. */
export function ImageBubble({ editor }: { editor: Editor }) {
  const side = useEditorState({ editor, selector: ({ editor: e }) => (selectedPicture(e)?.node.attrs.align ?? "center") as Side })
  const set = (align: Side) => {
    const sel = selectedPicture(editor)
    if (!sel) return
    const tr = editor.state.tr.setNodeMarkup(sel.from, undefined, { ...sel.node.attrs, align: align === "center" ? null : align })
    editor.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, sel.from)))
    editor.view.focus()
  }
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="imageBubble"
      options={{ placement: "top", offset: 8 }}
      shouldShow={({ editor: e }) => e.isEditable && e.isFocused && selectedPicture(e) !== null}
      getReferencedVirtualElement={() => {
        const sel = selectedPicture(editor)
        const dom = sel ? ((editor.view.nodeDOM(sel.from) as HTMLElement | null)?.querySelector("img") ?? null) : null
        return dom ? { getBoundingClientRect: () => dom.getBoundingClientRect(), getClientRects: () => dom.getClientRects() } : null
      }}
      className="z-40 flex items-center gap-0.5 rounded-lg border bg-popover p-1 shadow-lg"
    >
      <ToolButton label="Left" active={side === "left"} onClick={() => set("left")}>
        <AlignLeft />
      </ToolButton>
      <ToolButton label="Centre" active={side === "center"} onClick={() => set("center")}>
        <AlignCenter />
      </ToolButton>
      <ToolButton label="Right" active={side === "right"} onClick={() => set("right")}>
        <AlignRight />
      </ToolButton>
    </BubbleMenu>
  )
}

/** Row and column controls while the cursor is in a table. */
export function TableBubble({ editor }: { editor: Editor }) {
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableBubble"
      options={{ placement: "top", offset: 8 }}
      shouldShow={({ editor: e }) => e.isEditable && e.isFocused && e.isActive("table") && e.state.selection.empty}
      getReferencedVirtualElement={() => {
        const { $from } = editor.state.selection
        for (let d = $from.depth; d > 0; d--) {
          if ($from.node(d).type.name === "table") {
            const dom = editor.view.nodeDOM($from.before(d)) as HTMLElement | null
            if (dom) return { getBoundingClientRect: () => dom.getBoundingClientRect(), getClientRects: () => dom.getClientRects() }
          }
        }
        return null
      }}
      className="z-40 flex items-center gap-0.5 rounded-lg border bg-popover p-1 shadow-lg"
    >
      <ToolButton label="Add row above" onClick={() => editor.chain().focus().addRowBefore().run()}>
        <ArrowUpToLine />
      </ToolButton>
      <ToolButton label="Add row below" onClick={() => editor.chain().focus().addRowAfter().run()}>
        <ArrowDownToLine />
      </ToolButton>
      <ToolButton label="Add column left" onClick={() => editor.chain().focus().addColumnBefore().run()}>
        <ArrowLeftToLine />
      </ToolButton>
      <ToolButton label="Add column right" onClick={() => editor.chain().focus().addColumnAfter().run()}>
        <ArrowRightToLine />
      </ToolButton>
      <span className="mx-0.5 h-5 w-px bg-border" />
      <ToolButton label="Align column left" onClick={() => alignColumn(editor, "left")}>
        <AlignLeft />
      </ToolButton>
      <ToolButton label="Align column centre" onClick={() => alignColumn(editor, "center")}>
        <AlignCenter />
      </ToolButton>
      <ToolButton label="Align column right" onClick={() => alignColumn(editor, "right")}>
        <AlignRight />
      </ToolButton>
      <ToolButton label="Header row" active={editor.isActive("tableHeader")} onClick={() => editor.chain().focus().toggleHeaderRow().run()}>
        <Rows3 />
      </ToolButton>
      <span className="mx-0.5 h-5 w-px bg-border" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            className="flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Trash2 className="size-4" /> <ChevronDown className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44" onCloseAutoFocus={(e) => e.preventDefault()}>
          <DropdownMenuItem onSelect={() => editor.chain().focus().deleteRow().run()}>Delete row</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => editor.chain().focus().deleteColumn().run()}>Delete column</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => editor.chain().focus().deleteTable().run()}>
            Delete table
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </BubbleMenu>
  )
}
