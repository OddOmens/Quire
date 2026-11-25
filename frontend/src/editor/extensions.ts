import { Extension, InputRule, mergeAttributes, Node, type Editor, type Range } from "@tiptap/core"
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight"
import { TaskItem, TaskList } from "@tiptap/extension-list"
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table"
import { Placeholder } from "@tiptap/extensions"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { flip, shift, size } from "@floating-ui/dom"
import { ReactNodeViewRenderer, ReactRenderer } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Suggestion, { type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion"

import { BlockCommands, DateMention, Embed, isoDate, ListIndent, MathBlock, MathInline, Toc, Toggle, VaultLink } from "@/editor/blocks"
import { ColumnsKit } from "@/editor/columns"
import { Formula } from "@/editor/formula"
import { lowlight } from "@/editor/lowlight"
import { Background, TextColor } from "@/editor/marks"
import { BlockCards, VaultImage } from "@/editor/media"
import { CalloutView, CodeBlockView, PageLinkView } from "@/editor/views"
import { SuggestionList, type SuggestionItem, type SuggestionListHandle } from "@/editor/suggestion-list"
import type { NoteMeta } from "@/lib/api"
import { coveredBottom } from "@/lib/keyboard"
import { calloutType, isMedia, markdownToHtml } from "@/lib/markdown"
import type { Resolver } from "@/lib/notes"


/** What the editor needs from the page around it. Kept in a ref so extensions see the latest. */
export type EditorEnv = {
  path: string
  resolver: Resolver
  pages: NoteMeta[]
  /** "app" follows links; "plain" (public pages) shows them as text. */
  linkMode: "app" | "plain"
  fileUrl: (path: string) => string
  openLink: (target: string, heading?: string) => void
  openTag: (tag: string) => void
  upload: (file: File) => Promise<{ path: string; kind: "image" | "video" | "file"; name: string } | undefined>
  slashItems: (editor: Editor) => SuggestionItem[]
  /**
   * Creates a page or database under this one. Returns the [[target]] to
   * link or embed it by, and how to open it. Absent where pages can't be made.
   */
  createChild?: (kind: "page" | "database") => Promise<{ target: string; open: () => void } | undefined>
  /** Asks the server what a web page says about itself, for bookmark cards. Absent on public pages. */
  linkPreview?: (url: string) => Promise<{ title?: string; description?: string; site?: string; image?: string; icon?: string } | undefined>
  /** The pages this editor is shown inside, outermost first, when it's an embed. */
  embedStack?: string[]
}

export type EnvRef = { current: EditorEnv }

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (type?: string) => ReturnType
      toggleCallout: (type?: string) => ReturnType
    }
  }
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      type: {
        default: "note",
        parseHTML: (el) => calloutType(el.getAttribute("data-callout") ?? "note"),
        renderHTML: (a) => ({ "data-callout": a.type }),
      },
      // As written in the Markdown: the type's own name ("WARNING", "caution"),
      // the fold marker ("+", "-" or "") and the title after it.
      name: { default: "", parseHTML: (el) => el.getAttribute("data-name") ?? "", renderHTML: (a) => (a.name ? { "data-name": a.name } : {}) },
      fold: { default: "", parseHTML: (el) => el.getAttribute("data-fold") ?? "", renderHTML: (a) => (a.fold ? { "data-fold": a.fold } : {}) },
      title: { default: "", parseHTML: (el) => el.getAttribute("data-title") ?? "", renderHTML: (a) => (a.title ? { "data-title": a.title } : {}) },
    }
  },
  parseHTML: () => [{ tag: "div[data-callout]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { class: "callout" }), 0],
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView)
  },
  addCommands() {
    return {
      setCallout:
        (type = "note") =>
        ({ commands }) =>
          commands.wrapIn(this.name, { type }),
      toggleCallout:
        (type = "note") =>
        ({ commands, editor }) =>
          editor.isActive(this.name) ? commands.lift(this.name) : commands.wrapIn(this.name, { type }),
    }
  },
  addKeyboardShortcuts() {
    return {
      // Backspace in an empty first line lifts it out of the callout.
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection
        if (!empty || $from.parentOffset !== 0) return false
        const callout = $from.node(-1)
        if (callout?.type.name !== this.name || $from.index(-1) !== 0 || $from.parent.content.size) return false
        return editor.commands.lift(this.name)
      },
    }
  },
})

const wikiInput = /\[\[([^[\]|#\n]+)(#[^[\]|\n]*)?(\|[^[\]\n]*)?\]\]$/

/** An inline [[link]] to another page. */
export const PageLink = (env: EnvRef) =>
  Node.create({
    name: "pageLink",
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    addAttributes() {
      return {
        target: { default: "", parseHTML: (el) => el.getAttribute("data-target") ?? "" },
        heading: { default: "", parseHTML: (el) => el.getAttribute("data-heading") ?? "" },
        alias: { default: "", parseHTML: (el) => el.getAttribute("data-alias") ?? "" },
        // Written ![[Page]] in the middle of a line; on a line of its own that's an embed block.
        embed: { default: false, parseHTML: (el) => el.hasAttribute("data-embed") },
      }
    },
    parseHTML: () => [{ tag: "a[data-wikilink]" }],
    renderHTML: ({ node }) => [
      "a",
      {
        "data-wikilink": "",
        "data-target": node.attrs.target,
        "data-heading": node.attrs.heading,
        "data-alias": node.attrs.alias,
        ...(node.attrs.embed ? { "data-embed": "" } : {}),
      },
      node.attrs.alias || node.attrs.target,
    ],
    renderText: ({ node }) => `${node.attrs.embed ? "!" : ""}[[${node.attrs.target}${node.attrs.alias ? "|" + node.attrs.alias : ""}]]`,
    addNodeView() {
      return ReactNodeViewRenderer(PageLinkView, { as: "span" })
    },
    addStorage: () => ({ env }),
    addInputRules() {
      return [
        new InputRule({
          find: wikiInput,
          handler: ({ state, range, match }) => {
            const node = this.type.create({ target: match[1].trim(), heading: match[2]?.slice(1) ?? "", alias: match[3]?.slice(1) ?? "" })
            state.tr.replaceWith(range.from, range.to, node)
          },
        }),
      ]
    },
  })

/** Colours #tags and makes them clickable. */
const Hashtags = (env: EnvRef) =>
  Extension.create({
    name: "hashtags",
    addProseMirrorPlugins() {
      const re = /(^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu
      return [
        new Plugin({
          key: new PluginKey("hashtags"),
          props: {
            decorations(state) {
              const decos: Decoration[] = []
              state.doc.descendants((node, pos, parent) => {
                if (!node.isText || parent?.type.spec.code || node.marks.some((m) => m.type.spec.code)) return
                for (const m of node.text!.matchAll(re)) {
                  if (!/\p{L}/u.test(m[2])) continue
                  const from = pos + m.index! + m[1].length
                  decos.push(Decoration.inline(from, from + 1 + m[2].length, { class: "hashtag", "data-tag": m[2].replace(/[/-]+$/, "") }))
                }
              })
              return DecorationSet.create(state.doc, decos)
            },
            handleClick(view, _pos, event) {
              const el = (event.target as HTMLElement).closest<HTMLElement>(".hashtag")
              if (!el || (view.editable && !(event.metaKey || event.ctrlKey))) return false
              env.current.openTag(el.dataset.tag!.toLowerCase())
              return true
            },
          },
        }),
      ]
    },
  })

function suggestionRender() {
  return () => {
    let r: ReactRenderer<SuggestionListHandle, SuggestionProps<SuggestionItem>> | null = null
    let unmount: (() => void) | undefined
    return {
      onStart: (props: SuggestionProps<SuggestionItem>) => {
        r = new ReactRenderer(SuggestionList, { props, editor: props.editor })
        unmount = props.mount(r.element as HTMLElement)
      },
      onUpdate: (props: SuggestionProps<SuggestionItem>) => r?.updateProps(props),
      onKeyDown: ({ event }: { event: KeyboardEvent }) => r?.ref?.onKeyDown(event) ?? false,
      onExit: () => {
        unmount?.()
        r?.destroy()
        r = null
      },
    }
  }
}

function suggestionExtension(name: string, options: Partial<SuggestionOptions<SuggestionItem>>) {
  return Extension.create({
    name,
    addProseMirrorPlugins() {
      return [
        Suggestion<SuggestionItem>({
          editor: this.editor,
          pluginKey: new PluginKey(name),
          render: suggestionRender(),
          command: ({ editor, range, props }) => props.run(editor, range),
          // The list keeps clear of the on-screen keyboard and the bar above
          // it: it opens above the caret when there's more room there, and is
          // only as tall as the room it has (--room, read by suggestion-list.tsx).
          flip: false,
          floatingUi: {
            middleware: [
              flip(() => ({ padding: { top: 8, bottom: coveredBottom() + 8 } })),
              shift({ padding: 8 }),
              size(() => ({
                padding: { top: 8, bottom: coveredBottom() + 8 },
                apply: ({ availableHeight, elements }) => elements.floating.style.setProperty("--room", `${Math.max(140, Math.floor(availableHeight))}px`),
              })),
            ],
          },
          ...options,
        }),
      ]
    },
  })
}

const fuzzy = (text: string, q: string) => text.toLowerCase().includes(q.toLowerCase())

/** "/" opens the block menu. */
const SlashCommand = (env: EnvRef) =>
  suggestionExtension("slashCommand", {
    char: "/",
    // "/toggle heading 2": names have spaces in them.
    allowSpaces: true,
    allow: ({ state, range }) => {
      const $from = state.doc.resolve(range.from)
      return !$from.parent.type.spec.code
    },
    items: ({ editor, query }) => {
      const all = env.current.slashItems(editor)
      const q = query.toLowerCase()
      if (!q) return all
      // Names before keywords, starts before middles; no group headings while searching.
      const rank = (i: SuggestionItem) => {
        const title = i.title.toLowerCase()
        if (title.startsWith(q)) return 0
        if (title.split(/\s+/).some((w) => w.startsWith(q))) return 1
        if (title.includes(q)) return 2
        if (i.keywords?.some((k) => k.startsWith(q))) return 3
        return i.keywords?.some((k) => k.includes(q)) ? 4 : -1
      }
      return all
        .map((item, index) => ({ item, index, rank: rank(item) }))
        .filter((r) => r.rank >= 0)
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map((r) => ({ ...r.item, group: undefined }))
    },
  })

/** "[[" opens the page picker. */
const PageLinkSuggest = (env: EnvRef) =>
  suggestionExtension("pageLinkSuggest", {
    char: "[[",
    allowSpaces: true,
    allowedPrefixes: null,
    items: ({ query }) => {
      const { pages, path, resolver } = env.current
      const q = query.replace(/\]+$/, "").trim()
      const list = pages
        .filter((p) => p.path !== path && (!q || fuzzy(p.title, q) || fuzzy(p.path, q)))
        .sort((a, b) => {
          const sa = a.title.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1
          const sb = b.title.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1
          return sa - sb || b.mtime - a.mtime
        })
        .slice(0, 8)
      // "![[" on a line of its own embeds the page; anywhere else it links to it.
      const insert = (editor: Editor, range: Range, target: string) => {
        const $from = editor.state.doc.resolve(range.from)
        const alone = $from.parent.type.name === "paragraph" && $from.parent.textContent.slice(0, $from.parentOffset) === "!" && $from.parentOffset === 1
        if (alone && range.to >= $from.end()) {
          editor.chain().focus().deleteRange({ from: $from.start(), to: range.to }).insertEmbed(target).run()
        } else {
          editor.chain().focus().deleteRange(range).insertContent([{ type: "pageLink", attrs: { target } }, { type: "text", text: " " }]).run()
        }
      }
      const items: SuggestionItem[] = list.map((p) => ({
        title: p.title,
        description: p.folder.replace(/\//g, " / "),
        icon: p.kind === "database" ? "database" : "page",
        run: (editor: Editor, range: Range) => insert(editor, range, resolver.count(p.title) > 1 ? p.path.replace(/\.md$/i, "") : p.title),
      }))
      if (q && !pages.some((p) => p.title.toLowerCase() === q.toLowerCase())) {
        items.push({
          title: `New page “${q}”`,
          description: "Created when you open the link",
          icon: "new",
          run: (editor: Editor, range: Range) => insert(editor, range, q),
        })
      }
      return items
    },
  })

const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

/** Dates a query after "@" could mean: "tom" → tomorrow, "fri" → next Friday, "2026-12-25", "25 dec". */
export function datesFor(query: string, now = new Date()): { title: string; date: string }[] {
  const q = query.trim().toLowerCase()
  const day = (offset: number) => isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset))
  const named = [
    { title: "Today", date: day(0) },
    { title: "Tomorrow", date: day(1) },
    { title: "Yesterday", date: day(-1) },
    { title: "Next week", date: day(7) },
  ]
  if (!q) return named.filter((n) => n.title !== "Yesterday")
  const out = named.filter((n) => n.title.toLowerCase().startsWith(q))
  if (q.length >= 2) {
    weekdays.forEach((name, i) => {
      if (!name.startsWith(q)) return
      const ahead = (i - now.getDay() + 7) % 7 || 7
      out.push({ title: name[0].toUpperCase() + name.slice(1), date: day(ahead) })
    })
  }
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(q)
  const parsed = iso ? new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) : /[a-z]/.test(q) && /\d/.test(q) ? new Date(`${q} ${/\d{4}/.test(q) ? "" : now.getFullYear()}`) : null
  if (parsed && !Number.isNaN(parsed.getTime())) {
    out.push({ title: parsed.toLocaleDateString(undefined, { dateStyle: "long" }), date: isoDate(parsed) })
  }
  return out
}

/** "@" mentions a date or a page. */
const Mention = (env: EnvRef) =>
  suggestionExtension("mention", {
    char: "@",
    allowSpaces: true,
    allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
    items: ({ query }) => {
      // "@" then a space is just an at sign.
      if (/^\s/.test(query) || query.length > 30) return []
      const { pages, path, resolver } = env.current
      const q = query.trim()
      const dates: SuggestionItem[] = datesFor(q).map((d) => ({
        group: "Date",
        title: d.title,
        description: d.date,
        icon: "date",
        run: (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range).insertDate(d.date).run(),
      }))
      const found = pages
        .filter((p) => p.path !== path && (!q || fuzzy(p.title, q)))
        .sort((a, b) => Number(!a.title.toLowerCase().startsWith(q.toLowerCase())) - Number(!b.title.toLowerCase().startsWith(q.toLowerCase())) || b.mtime - a.mtime)
        .slice(0, 6)
        .map<SuggestionItem>((p) => ({
          group: "Link to page",
          title: p.title,
          description: p.folder.replace(/\//g, " / "),
          icon: p.kind === "database" ? "database" : "page",
          run: (editor: Editor, range: Range) => {
            const target = resolver.count(p.title) > 1 ? p.path.replace(/\.md$/i, "") : p.title
            editor.chain().focus().deleteRange(range).insertContent([{ type: "pageLink", attrs: { target } }, { type: "text", text: " " }]).run()
          },
        }))
      return [...dates, ...found]
    },
  })

/** Pasted plain-text Markdown becomes formatted content; pasted or dropped files upload. */
const PasteAndDrop = (env: EnvRef) =>
  Extension.create({
    name: "pasteAndDrop",
    addProseMirrorPlugins() {
      const editor = this.editor
      const insertFiles = async (files: File[], pos?: number) => {
        for (const file of files) {
          const res = await env.current.upload(file)
          if (!res) continue
          const node = res.kind !== "file" || isMedia(res.path)
            ? { type: "image", attrs: { src: res.path, alt: res.name.replace(/\.[^.]+$/, "") } }
            : { type: "paragraph", content: [{ type: "text", text: res.name, marks: [{ type: "link", attrs: { href: res.path } }] }] }
          if (pos !== undefined) editor.chain().insertContentAt(pos, node).run()
          else editor.chain().focus().insertContent(node).run()
        }
      }
      return [
        new Plugin({
          key: new PluginKey("pasteAndDrop"),
          props: {
            handlePaste(view, event) {
              const files = [...(event.clipboardData?.files ?? [])]
              if (files.length) {
                void insertFiles(files)
                return true
              }
              const html = event.clipboardData?.getData("text/html")
              const text = event.clipboardData?.getData("text/plain")
              if (html || !text || view.state.selection.$from.parent.type.spec.code) return false
              if (!/(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|.*\|)|\[\[|\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)/.test(text)) return false
              editor.commands.insertContent(markdownToHtml(text, { fileUrl: env.current.fileUrl }))
              return true
            },
            handleDrop(view, event, _slice, moved) {
              const files = [...(event.dataTransfer?.files ?? [])]
              if (moved || !files.length) return false
              const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
              void insertFiles(files, pos)
              return true
            },
          },
        }),
      ]
    },
  })

/**
 * ⌘Z / ⌘⇧Z / Ctrl+Y with nothing left to undo or redo. Without this the
 * browser runs its own undo on the editable text, behind the editor's back.
 */
const HistoryKeys = Extension.create({
  name: "historyKeys",
  // Below the undo/redo extension, so this only sees what it didn't handle.
  priority: 50,
  addKeyboardShortcuts() {
    return { "Mod-z": () => true, "Shift-Mod-z": () => true, "Mod-y": () => true }
  },
})

export function createExtensions(env: EnvRef, opts: { placeholder?: string } = {}) {
  return [
    StarterKit.configure({
      codeBlock: false,
      link: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      dropcursor: { color: "var(--brand)", width: 2 },
    }),
    VaultLink(env),
    Toggle,
    MathBlock,
    MathInline,
    Formula,
    BlockCommands,
    CodeBlockLowlight.extend({
      addNodeView: () => ReactNodeViewRenderer(CodeBlockView),
    }).configure({ lowlight, defaultLanguage: null, enableTabIndentation: true }),
    Background,
    TextColor,
    TaskList,
    // Ticking works while reading too, except on shared pages and inside an embedded page.
    TaskItem.configure({ nested: true, onReadOnlyChecked: () => env.current.linkMode === "app" && !env.current.embedStack }),
    // After the list items so its Tab runs before theirs; before the "/" and
    // "[[" menus so Tab still picks an item while one is open.
    ListIndent,
    HistoryKeys,
    // A column never gets thinner than this: a table with more columns than
    // fit (four or more on a phone) scrolls sideways in its own box instead of
    // breaking every word into single letters.
    Table.configure({ resizable: false, cellMinWidth: 88 }),
    TableRow,
    TableHeader,
    TableCell,
    Callout,
    ColumnsKit,
    Toc,
    Embed,
    DateMention,
    PageLink(env),
    VaultImage(env),
    BlockCards(env),
    Hashtags(env),
    SlashCommand(env),
    PageLinkSuggest(env),
    Mention(env),
    PasteAndDrop(env),
    Placeholder.configure({
      includeChildren: false,
      placeholder: ({ node, editor }) => {
        if (node.type.name === "heading") return `Heading ${node.attrs.level}`
        return editor.isEmpty ? (opts.placeholder ?? "Start writing, or press / for blocks") : "Press / for blocks"
      },
      showOnlyCurrent: true,
    }),
  ]
}
