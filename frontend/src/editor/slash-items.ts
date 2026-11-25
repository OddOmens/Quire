import type { Editor, Range } from "@tiptap/core"
import {
  AtSign,
  Bookmark,
  CalendarDays,
  CheckSquare,
  ChevronRight,
  Code2,
  Columns2,
  Columns3,
  Columns4,
  FilePlus2,
  FileSearch,
  FileSymlink,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  ImageIcon,
  Info,
  List,
  ListCollapse,
  ListOrdered,
  Minus,
  MonitorPlay,
  Music,
  Palette,
  Paperclip,
  Pilcrow,
  Quote,
  Sigma,
  SquareFunction,
  Table2,
  TableOfContents,
  Video,
  Workflow,
} from "lucide-react"

import { isoDate } from "@/editor/blocks"
import { inColumns } from "@/editor/columns"
import type { EditorEnv } from "@/editor/extensions"
import { colorNames } from "@/editor/marks"
import type { SuggestionItem } from "@/editor/suggestion-list"
import { COLORS } from "@/lib/markdown"

type Run = (e: Editor, r: Range) => void

/** Colours the line the cursor is on, as Notion's colour commands do; on an empty line, what's typed next. */
const color =
  (kind: "text" | "background", value: (typeof COLORS)[number] | null): Run =>
  (e, r) => {
    if (r.to > r.from) e.chain().focus().deleteRange(r).run()
    const { $from } = e.state.selection
    const type = kind === "text" ? e.schema.marks.textColor : e.schema.marks.highlight
    const from = $from.start()
    const to = $from.end()
    const tr = e.state.tr
    if (to > from) {
      tr.removeMark(from, to, type)
      if (value) tr.addMark(from, to, type.create({ color: value }))
    } else if (value) {
      tr.addStoredMark(type.create({ color: value }))
    } else {
      tr.removeStoredMark(type)
    }
    e.view.dispatch(tr)
  }

/**
 * The "/" menu. pick opens a file picker and inserts the upload; child makes
 * a page or database under this one, where that's possible.
 */
export function slashItems(editor: Editor, pick: (editor: Editor, accept: string, preview?: boolean) => void, env: Pick<EditorEnv, "createChild">): SuggestionItem[] {
  const child = env.createChild
  const columns = (n: number, icon: SuggestionItem["icon"]): SuggestionItem => ({
    group: "Advanced",
    title: `${n} columns`,
    description: `Blocks side by side in ${n} columns`,
    icon,
    keywords: ["column", "columns", "side", "layout", "split", String(n)],
    run: (e, r) => e.chain().focus().deleteRange(r).insertColumns(n).run(),
  })
  const items: (SuggestionItem | false | undefined)[] = [
    { group: "Basic blocks", title: "Text", description: "Plain paragraph", icon: Pilcrow, keywords: ["paragraph", "p"], run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
    { group: "Basic blocks", title: "Heading 1", description: "Large section heading", icon: Heading1, keywords: ["h1", "title"], run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run() },
    { group: "Basic blocks", title: "Heading 2", description: "Medium section heading", icon: Heading2, keywords: ["h2", "subtitle"], run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
    { group: "Basic blocks", title: "Heading 3", description: "Small section heading", icon: Heading3, keywords: ["h3"], run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
    { group: "Basic blocks", title: "Heading 4", description: "Smallest section heading", icon: Heading4, keywords: ["h4"], run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 4 }).run() },
    child && {
      group: "Basic blocks",
      title: "Page",
      description: "A new page inside this one",
      icon: FilePlus2,
      keywords: ["subpage", "sub-page", "child", "new", "nested"],
      run: (e, r) => {
        e.chain().focus().deleteRange(r).run()
        void child("page").then((made) => {
          if (!made || e.isDestroyed) return
          e.chain().focus().insertContent({ type: "paragraph", content: [{ type: "pageLink", attrs: { target: made.target } }] }).run()
          made.open()
        })
      },
    },
    { group: "Basic blocks", title: "Quote", description: "Capture a quotation", icon: Quote, keywords: ["blockquote", "citation"], run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
    { group: "Basic blocks", title: "Callout", description: "Make a note stand out", icon: Info, keywords: ["note", "tip", "warning", "info", "alert", "question", "success"], run: (e, r) => e.chain().focus().deleteRange(r).setCallout("note").run() },
    { group: "Basic blocks", title: "Divider", description: "A horizontal line", icon: Minus, keywords: ["hr", "line", "separator"], run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
    { group: "Basic blocks", title: "Table", description: "Rows and columns", icon: Table2, keywords: ["grid", "table"], run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { group: "Basic blocks", title: "Code block", description: "Code with syntax highlighting", icon: Code2, keywords: ["code", "pre", "snippet"], run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },

    { group: "Lists", title: "Bulleted list", description: "A simple list", icon: List, keywords: ["ul", "bullet", "unordered"], run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
    { group: "Lists", title: "Numbered list", description: "A list with numbers", icon: ListOrdered, keywords: ["ol", "ordered", "number"], run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
    { group: "Lists", title: "To-do list", description: "Track tasks with checkboxes", icon: CheckSquare, keywords: ["todo", "task", "checkbox", "check"], run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
    { group: "Lists", title: "Toggle", description: "Hide details until clicked", icon: ChevronRight, keywords: ["collapse", "details", "expand", "fold", "accordion"], run: (e, r) => e.chain().focus().deleteRange(r).setToggle().run() },
    ...[1, 2, 3].map<SuggestionItem>((level) => ({
      group: "Lists",
      title: `Toggle heading ${level}`,
      description: "A heading that folds what's under it",
      icon: ListCollapse,
      keywords: ["collapse", "fold", "toggle", `h${level}`, "heading"],
      run: (e, r) => e.chain().focus().deleteRange(r).setToggle(level).run(),
    })),

    { group: "Media", title: "Image", description: "Upload a picture", icon: ImageIcon, keywords: ["photo", "picture", "upload"], run: (e, r) => (e.chain().focus().deleteRange(r).run(), pick(e, "image/*")) },
    { group: "Media", title: "Video", description: "Upload a video to play inline", icon: Video, keywords: ["movie", "clip", "mp4"], run: (e, r) => (e.chain().focus().deleteRange(r).run(), pick(e, "video/mp4,video/webm,video/quicktime")) },
    { group: "Media", title: "Audio", description: "Upload a recording to play inline", icon: Music, keywords: ["sound", "music", "mp3", "recording", "voice"], run: (e, r) => (e.chain().focus().deleteRange(r).run(), pick(e, "audio/*")) },
    { group: "Media", title: "File", description: "Attach any file, such as a PDF", icon: Paperclip, keywords: ["attachment", "pdf", "upload", "document"], run: (e, r) => (e.chain().focus().deleteRange(r).run(), pick(e, "")) },
    { group: "Media", title: "PDF", description: "Upload a PDF and show its pages", icon: FileSearch, keywords: ["pdf", "document", "preview", "paper", "upload"], run: (e, r) => (e.chain().focus().deleteRange(r).run(), pick(e, "application/pdf,.pdf", true)) },
    { group: "Media", title: "Bookmark", description: "A card for a web link, with its title and picture", icon: Bookmark, keywords: ["link", "url", "web", "site", "card", "preview"], run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().startBookmark().run() },
    { group: "Embeds", title: "Embed", description: "A video, song, design or doc from another site", icon: MonitorPlay, keywords: ["youtube", "vimeo", "loom", "video", "spotify", "soundcloud", "music", "figma", "codepen", "codesandbox", "google", "docs", "sheets", "slides", "maps", "miro", "airtable", "iframe", "player"], run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().startEmbed().run() },

    { group: "Embeds", title: "Embed page", description: "Show another page here, kept in step", icon: FileSymlink, keywords: ["synced", "sync", "transclude", "include", "mirror"], run: (e, r) => e.chain().focus().deleteRange(r).insertContent("![[").run() },
    child && {
      group: "Embeds",
      title: "Inline database",
      description: "A new table, board or calendar on this page",
      icon: Table2,
      keywords: ["database", "table", "board", "kanban", "calendar", "gallery", "sheet", "rows"],
      run: (e, r) => {
        e.chain().focus().deleteRange(r).run()
        void child("database").then((made) => {
          if (made && !e.isDestroyed) e.chain().focus().insertEmbed(made.target).run()
        })
      },
    },
    { group: "Embeds", title: "Linked database", description: "Show a database you already have", icon: Table2, keywords: ["database", "linked", "view", "existing"], run: (e, r) => e.chain().focus().deleteRange(r).insertContent("![[").run() },

    !inColumns(editor.state) && columns(2, Columns2),
    !inColumns(editor.state) && columns(3, Columns3),
    !inColumns(editor.state) && columns(4, Columns4),
    !inColumns(editor.state) && columns(5, Columns4),
    { group: "Advanced", title: "Table of contents", description: "The page's headings, as links", icon: TableOfContents, keywords: ["toc", "outline", "contents", "headings"], run: (e, r) => e.chain().focus().deleteRange(r).insertToc().run() },
    { group: "Advanced", title: "Math equation", description: "A LaTeX formula on its own line", icon: Sigma, keywords: ["latex", "katex", "formula", "tex", "equation"], run: (e, r) => e.chain().focus().deleteRange(r).insertMathBlock().run() },
    {
      group: "Advanced",
      title: "Diagram",
      description: "Flowcharts and more with Mermaid",
      icon: Workflow,
      keywords: ["mermaid", "flowchart", "chart", "graph", "sequence"],
      run: (e, r) =>
        e.chain().focus().deleteRange(r).insertContent({ type: "codeBlock", attrs: { language: "mermaid" }, content: [{ type: "text", text: "flowchart LR\n  Idea --> Draft --> Done" }] }).run(),
    },

    { group: "Inline", title: "Link to page", description: "Mention another page", icon: FileText, keywords: ["link", "page", "mention", "wiki"], run: (e, r) => e.chain().focus().deleteRange(r).insertContent("[[").run() },
    { group: "Inline", title: "Date", description: "Today's date; click it to change the day", icon: CalendarDays, keywords: ["today", "day", "calendar", "due", "when"], run: (e, r) => e.chain().focus().deleteRange(r).insertDate(isoDate(new Date())).run() },
    { group: "Inline", title: "Mention", description: "A date or a page, with @", icon: AtSign, keywords: ["at", "mention", "date", "page"], run: (e, r) => e.chain().focus().deleteRange(r).insertContent("@").run() },
    { group: "Inline", title: "Inline math", description: "A formula inside a sentence ($…$)", icon: Sigma, keywords: ["latex", "katex", "formula", "inline"], run: (e, r) => e.chain().focus().deleteRange(r).insertMathInline("x^2").run() },
    { group: "Inline", title: "Formula", description: "A live value from your databases ({{ … }})", icon: SquareFunction, keywords: ["sum", "total", "calculate", "database", "sheet", "count"], run: (e, r) => e.chain().focus().deleteRange(r).insertFormula().run() },

    { group: "Colour", title: "Default colour", description: "Back to the usual text colour", icon: Palette, keywords: ["color", "colour", "reset", "black", "plain"], run: (e, r) => (color("text", null)(e, r), color("background", null)(e, { from: 0, to: 0 })) },
    ...COLORS.map<SuggestionItem>((c) => ({
      group: "Colour",
      title: `${colorNames[c]} text`,
      icon: Palette,
      swatch: { color: `var(--text-${c})` },
      keywords: ["color", "colour", c, colorNames[c].toLowerCase()],
      run: color("text", c),
    })),
    ...COLORS.map<SuggestionItem>((c) => ({
      group: "Colour",
      title: `${colorNames[c]} background`,
      icon: Palette,
      swatch: { background: `var(--bg-${c})` },
      keywords: ["color", "colour", "highlight", "background", c, colorNames[c].toLowerCase()],
      run: color("background", c),
    })),
  ]
  return items.filter((i): i is SuggestionItem => !!i)
}
