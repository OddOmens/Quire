import type { Mark, Node as PMNode } from "@tiptap/pm/model"
import { defaultMarkdownSerializer as d, MarkdownSerializer, type MarkdownSerializerState } from "prosemirror-markdown"

import { calloutType } from "@/lib/markdown"

/**
 * The editor's document → Markdown. The inverse of lib/markdown.ts: GFM
 * plus [[wikilinks]], ==highlights== and > [!callouts].
 */

function codeFence(text: string) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  return "`".repeat(longest + 1)
}

/** Serializer state the typings leave out. */
type State = MarkdownSerializerState & { closed: PMNode | null; inAutolink?: boolean; flushClose(size?: number): void }

/** One table cell's content as a single line of inline Markdown. */
function cellText(cell: PMNode) {
  const md = serializer.serialize(cell, { tightLists: true }).trim()
  return md.replace(/\n+/g, " ").replace(/\|/g, "\\|") || " "
}

function table(state: MarkdownSerializerState, node: PMNode) {
  const rows: string[][] = []
  node.forEach((row) => {
    const cells: string[] = []
    row.forEach((cell) => cells.push(cellText(cell)))
    rows.push(cells)
  })
  if (!rows.length) return
  const width = Math.max(...rows.map((r) => r.length))
  const line = (cells: string[]) => "| " + Array.from({ length: width }, (_, i) => cells[i] ?? " ").join(" | ") + " |"
  // Each column's alignment is kept on its cells; the header row's counts.
  const align = Array.from({ length: width }, (_, i) => {
    const a = node.firstChild!.maybeChild(i)?.attrs.align
    return a === "left" ? ":---" : a === "center" ? ":---:" : a === "right" ? "---:" : "---"
  })
  const out = [line(rows[0]), "| " + align.join(" | ") + " |", ...rows.slice(1).map(line)]
  out.forEach((l, i) => {
    state.write(l)
    if (i < out.length - 1) state.ensureNewLine()
  })
  state.closeBlock(node)
}

/**
 * Bullet and to-do lists. A to-do list right after a bullet list (or the
 * other way round) is one Markdown list with some items ticked, so they're
 * written without a blank line between them, the way they were read.
 */
function list(state: MarkdownSerializerState, node: PMNode) {
  const s = state as State
  const other = node.type.name === "taskList" ? "bulletList" : "taskList"
  if (s.closed?.type.name === other) s.flushClose(1)
  state.renderList(node, "  ", () => "- ")
}

/**
 * How a link whose text is its address goes back: "" for a bare URL, "<"
 * for <url>, or null for [text](url). Bare is used for links read that way
 * or typed, unless what follows would run into the address.
 */
function autolink(mark: Mark, parent: PMNode, index: number): "" | "<" | null {
  const { href, title, autolink: form } = mark.attrs as { href: string; title?: string; autolink?: string }
  const node = parent.child(index)
  if (title || !node.isText || node.marks.at(-1) !== mark) return null
  if (index + 1 < parent.childCount && mark.isInSet(parent.child(index + 1).marks)) return null
  const text = node.text!
  const same = text === href && /^[a-z][a-z0-9+.-]*:/i.test(href)
  if (form === "angle" && (same || href === "mailto:" + text)) return "<"
  const bare = (same && /^(https?|ftp):\/\//i.test(href)) || (form === "bare" && (href === "http://" + text || href === "mailto:" + text))
  if (!bare) return same ? "<" : null
  const next = parent.maybeChild(index + 1)
  const clear = !next || (next.isText ? /^(\s|[.,:;!?'")\]*_~]+(\s|$))/.test(next.text!) : next.type.name === "hardBreak")
  return clear ? "" : same ? "<" : null
}

/**
 * How many colons fence a columns block or one of its columns: a block's
 * fence is longer than any inside it, so each closes the right one.
 */
function fenceLength(node: PMNode): number {
  let inner = node.type.name === "columns" ? 0 : 2
  node.forEach(function walk(child: PMNode) {
    if (child.type.name === "columns" || child.type.name === "column") inner = Math.max(inner, fenceLength(child))
    else child.forEach(walk)
  })
  return inner + 1
}

/** What the link being written opened with; links don't nest. */
let autolinkOpen: "" | "<" | null = null

/** Escapes a link destination. */
const destination = (s: string) => s.replace(/[()\s]/g, (c) => (c === " " ? "%20" : "\\" + c))

const serializer: MarkdownSerializer = new MarkdownSerializer(
  {
    doc: (state, node) => state.renderContent(node),
    paragraph: d.nodes.paragraph,
    heading: d.nodes.heading,
    blockquote: d.nodes.blockquote,
    horizontalRule: (state, node) => {
      state.write("---")
      state.closeBlock(node)
    },
    hardBreak: d.nodes.hard_break,
    text: d.nodes.text,
    codeBlock(state, node) {
      const fence = codeFence(node.textContent)
      state.write(fence + (node.attrs.language ?? "") + "\n")
      state.text(node.textContent, false)
      state.ensureNewLine()
      state.write(fence)
      state.closeBlock(node)
    },
    bulletList: list,
    taskList: list,
    orderedList(state, node) {
      const start = (node.attrs.start as number) ?? 1
      const width = String(start + node.childCount - 1).length
      const indent = state.repeat(" ", width + 2)
      state.renderList(node, indent, (i) => {
        const n = String(start + i)
        return state.repeat(" ", width - n.length) + n + ". "
      })
    },
    listItem: (state, node) => state.renderContent(node),
    taskItem(state, node) {
      state.write(node.attrs.checked ? "[x] " : "[ ] ")
      state.renderContent(node)
    },
    image(state, node) {
      const src = String(node.attrs.src ?? "").replace(/[()\s]/g, (c) => (c === " " ? "%20" : "\\" + c))
      const title = node.attrs.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : ""
      // ![alt|right|400](x.png): the side before the width, so Obsidian still reads the width.
      const align = node.attrs.align === "left" || node.attrs.align === "right" ? `|${node.attrs.align}` : ""
      const width = node.attrs.width ? `|${node.attrs.width}` : ""
      state.write(`![${state.esc(node.attrs.alt ?? "")}${align}${width}](${src}${title})`)
      // Pictures are blocks of their own, with a blank line either side.
      state.closeBlock(node)
    },
    callout(state, node) {
      // The type as it was written while it still matches; a changed type
      // keeps the old one's case (GitHub writes [!NOTE]).
      const { type, name, fold, title } = node.attrs as { type: string; name: string; fold: string; title: string }
      const kind = name && calloutType(name) === type ? name : name && name === name.toUpperCase() ? type.toUpperCase() : type
      const empty = node.childCount === 1 && node.firstChild!.isTextblock && !node.firstChild!.content.size
      state.wrapBlock("> ", null, node, () => {
        state.write(`[!${kind}]${fold ?? ""}${title ? " " + title : ""}`)
        if (empty) return state.closeBlock(node)
        state.ensureNewLine()
        state.renderContent(node)
      })
    },
    toggle(state, node) {
      const summary = String(node.attrs.summary ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)
      const level = Number(node.attrs.level) || 0
      state.write(`<details${node.attrs.open ? " open" : ""}>`)
      state.ensureNewLine()
      state.write(level ? `<summary><h${level}>${summary}</h${level}></summary>` : `<summary>${summary}</summary>`)
      state.closeBlock(node)
      state.renderContent(node)
      state.write("</details>")
      state.closeBlock(node)
    },
    mathBlock(state, node) {
      state.write("$$")
      state.ensureNewLine()
      state.text(String(node.attrs.latex ?? ""), false)
      state.ensureNewLine()
      state.write("$$")
      state.closeBlock(node)
    },
    mathInline(state, node) {
      state.write(`$${node.attrs.latex}$`)
    },
    formula(state, node) {
      state.write(`{{${node.attrs.raw}}}`)
    },
    pageLink(state, node) {
      const { target, heading, alias, embed } = node.attrs as { target: string; heading: string; alias: string; embed?: boolean }
      state.write(`${embed ? "!" : ""}[[${target}${heading ? "#" + heading : ""}${alias ? "|" + alias : ""}]]`)
    },
    embed(state, node) {
      const { target, heading, alias } = node.attrs as { target: string; heading: string; alias: string }
      state.write(`![[${target}${heading ? "#" + heading : ""}${alias ? "|" + alias : ""}]]`)
      state.closeBlock(node)
    },
    toc(state, node) {
      state.write("[TOC]")
      state.closeBlock(node)
    },
    dateMention(state, node) {
      state.write(`@${node.attrs.date}`)
    },
    columns(state, node) {
      const s = state as State
      const fence = ":".repeat(fenceLength(node))
      state.write(`${fence} columns`)
      state.ensureNewLine()
      const inner = fence.slice(1)
      node.forEach((column) => {
        state.write(`${inner} column`)
        state.ensureNewLine()
        state.renderContent(column)
        s.flushClose(1)
        state.write(inner)
        state.ensureNewLine()
      })
      state.write(fence)
      state.closeBlock(node)
    },
    column: () => {},
    table,
    tableRow: () => {},
    tableHeader: (state, node) => state.renderInline(node),
    tableCell: (state, node) => state.renderInline(node),
  },
  {
    bold: d.marks.strong,
    italic: d.marks.em,
    code: d.marks.code,
    link: {
      open(state, mark, parent, index) {
        const form = autolink(mark, parent, index)
        ;(state as State).inAutolink = form !== null
        autolinkOpen = form
        return form ?? "["
      },
      close(state, mark) {
        ;(state as State).inAutolink = undefined
        if (autolinkOpen !== null) return autolinkOpen === "<" ? ">" : ""
        return `](${destination(String(mark.attrs.href))}${mark.attrs.title ? ` "${String(mark.attrs.title).replace(/"/g, '\\"')}"` : ""})`
      },
      mixable: true,
    },
    strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
    highlight: {
      open: (_state, mark) => (mark.attrs.color ? `<mark data-color="${mark.attrs.color}">` : "=="),
      close: (_state, mark) => (mark.attrs.color ? "</mark>" : "=="),
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    textColor: { open: (_state, mark) => `<span data-color="${mark.attrs.color}">`, close: "</span>", mixable: true, expelEnclosingWhitespace: true },
    underline: { open: "<u>", close: "</u>", mixable: true, expelEnclosingWhitespace: true },
  },
)

export function docToMarkdown(doc: PMNode) {
  const md = serializer.serialize(doc, { tightLists: true })
  return md.trim() ? md.replace(/\s+$/, "") + "\n" : ""
}
