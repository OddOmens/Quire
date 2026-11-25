import { Extension, InputRule, Node, type Editor } from "@tiptap/core"
import type { ResolvedPos } from "@tiptap/pm/model"
import Link from "@tiptap/extension-link"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state"
import { ReactNodeViewRenderer } from "@tiptap/react"

import type { EnvRef } from "@/editor/extensions"
import { EmbedView } from "@/editor/embed"
import { MathBlockView, MathInlineView, TocView, ToggleView } from "@/editor/views"
import { dateLabel, isoDate } from "@/lib/dates"
import { DATE_MENTION, isVaultPath } from "@/lib/markdown"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    blocks: {
      /** Turns the current line into a toggle, or a toggle heading with a level of 1 to 3. */
      setToggle: (level?: number) => ReturnType
      insertToc: () => ReturnType
      /** Shows another page, or one of its sections, in place. */
      insertEmbed: (target: string, heading?: string) => ReturnType
      /** A date chip, stored as @2026-11-11. */
      insertDate: (date: string) => ReturnType
      insertMathBlock: (latex?: string) => ReturnType
      insertMathInline: (latex?: string) => ReturnType
      moveBlock: (dir: "up" | "down") => ReturnType
    }
  }
}

/** A collapsible section, stored as <details><summary>…</summary>…</details>. */
export const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      summary: { default: "", parseHTML: (el) => el.getAttribute("data-summary") ?? "" },
      open: { default: false, parseHTML: (el) => el.hasAttribute("data-open") },
      // 1 to 3 for a toggle heading, stored as <summary><h2>…</h2></summary>.
      level: { default: 0, parseHTML: (el) => Math.min(3, Math.max(0, Number(el.getAttribute("data-level")) || 0)) },
    }
  },
  parseHTML: () => [{ tag: "div[data-toggle]" }],
  renderHTML: ({ node }) => ["div", { "data-toggle": "", "data-summary": node.attrs.summary, ...(node.attrs.level ? { "data-level": node.attrs.level } : {}) }, 0],
  addNodeView() {
    return ReactNodeViewRenderer(ToggleView)
  },
  // Set by setToggle so the new toggle's title takes the cursor.
  addStorage: () => ({ focusTitle: false }),
})

/** The page's table of contents, stored as a line reading [TOC]. */
export const Toc = Node.create({
  name: "toc",
  group: "block",
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: "div[data-toc]" }],
  renderHTML: () => ["div", { "data-toc": "" }],
  renderText: () => "[TOC]",
  addNodeView() {
    return ReactNodeViewRenderer(TocView)
  },
  addInputRules() {
    return [
      new InputRule({
        find: /^\[(?:toc|TOC)\]\s$/,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)
          if ($from.parent.type.name !== "paragraph" || $from.parent.textContent.length > 5) return null
          state.tr.replaceRangeWith($from.before(), $from.after(), this.type.create())
        },
      }),
    ]
  },
})

/** Another page shown in place, stored as ![[Page]] or ![[Page#Heading]] on a line of its own. */
export const Embed = Node.create({
  name: "embed",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      target: { default: "", parseHTML: (el) => el.getAttribute("data-target") ?? "" },
      heading: { default: "", parseHTML: (el) => el.getAttribute("data-heading") ?? "" },
      alias: { default: "", parseHTML: (el) => el.getAttribute("data-alias") ?? "" },
    }
  },
  parseHTML: () => [{ tag: "div[data-embed]" }],
  renderHTML: ({ node }) => ["div", { "data-embed": "", "data-target": node.attrs.target, "data-heading": node.attrs.heading, "data-alias": node.attrs.alias }],
  renderText: ({ node }) => `![[${node.attrs.target}${node.attrs.heading ? "#" + node.attrs.heading : ""}]]`,
  addNodeView() {
    // The embedded page handles its own clicks and keys.
    return ReactNodeViewRenderer(EmbedView, { stopEvent: () => true })
  },
})

// The date helpers live apart so pages that only show dates don't load the editor.
export { dateLabel, isoDate }

/** A date in a sentence, stored as @2026-11-11. Click it while editing to change the day. */
export const DateMention = Node.create({
  name: "dateMention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { date: { default: "", parseHTML: (el) => el.getAttribute("data-date") ?? "" } }
  },
  parseHTML: () => [{ tag: "span[data-date]" }],
  renderHTML: ({ node }) => ["span", { "data-date": node.attrs.date }, `@${node.attrs.date}`],
  renderText: ({ node }) => `@${node.attrs.date}`,
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node
      const dom = document.createElement("span")
      dom.className = "date-chip"
      const label = document.createElement("span")
      const input = document.createElement("input")
      input.type = "date"
      input.tabIndex = -1
      input.setAttribute("aria-label", "Change the date")
      dom.append(label, input)
      const show = () => {
        const iso = current.attrs.date as string
        label.textContent = dateLabel(iso)
        dom.title = new Date(`${iso}T00:00`).toLocaleDateString(undefined, { dateStyle: "full" })
        dom.dataset.date = iso
        dom.classList.toggle("is-past", iso < isoDate(new Date()))
      }
      show()
      dom.addEventListener("click", () => {
        if (!editor.isEditable) return
        input.value = current.attrs.date
        try {
          input.showPicker()
        } catch {
          input.focus()
        }
      })
      input.addEventListener("change", () => {
        const pos = getPos()
        if (pos === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(input.value)) return
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { date: input.value }))
      })
      return {
        dom,
        update(next) {
          if (next.type !== current.type) return false
          current = next
          show()
          return true
        },
        stopEvent: (e) => e.target === input,
        ignoreMutation: () => true,
      }
    }
  },
  addInputRules() {
    return [
      new InputRule({
        find: /(?:^|[\s(])(@\d{4}-\d{2}-\d{2})\s$/,
        handler: ({ state, range, match }) => {
          const m = DATE_MENTION.exec(match[1])
          if (!m) return null
          const from = range.to - match[1].length
          state.tr.replaceWith(from, range.to, [this.type.create({ date: m[1] }), state.schema.text(" ")])
        },
      }),
    ]
  },
})

/** A display equation, stored as $$…$$. */
export const MathBlock = Node.create({
  name: "mathBlock",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return { latex: { default: "", parseHTML: (el) => el.getAttribute("data-latex") ?? "" } }
  },
  parseHTML: () => [{ tag: "div[data-math-block]" }],
  renderHTML: ({ node }) => ["div", { "data-math-block": "", "data-latex": node.attrs.latex }],
  renderText: ({ node }) => `$$${node.attrs.latex}$$`,
  addNodeView() {
    return ReactNodeViewRenderer(MathBlockView)
  },
  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$\s$/,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)
          state.tr.replaceRangeWith($from.before(), $from.after(), this.type.create({ latex: "" }))
        },
      }),
    ]
  },
})

/** An equation inside a sentence, stored as $…$. */
export const MathInline = Node.create({
  name: "mathInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { latex: { default: "", parseHTML: (el) => el.getAttribute("data-latex") ?? "" } }
  },
  parseHTML: () => [{ tag: "span[data-math-inline]" }],
  renderHTML: ({ node }) => ["span", { "data-math-inline": "", "data-latex": node.attrs.latex }],
  renderText: ({ node }) => `$${node.attrs.latex}$`,
  addNodeView() {
    return ReactNodeViewRenderer(MathInlineView, { as: "span" })
  },
  addInputRules() {
    return [
      new InputRule({
        find: /(?<![$\\\w])\$([^$\s](?:[^$]*[^$\s])?)\$$/,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create({ latex: match[1] }))
        },
      }),
    ]
  },
})

/** Links keep their vault path (attachments/x.pdf) and open through the API. */
export const VaultLink = (env: EnvRef) =>
  Link.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        href: {
          default: null,
          parseHTML: (el) => el.getAttribute("data-href") ?? el.getAttribute("href"),
          renderHTML: (a) => {
            const href = String(a.href ?? "")
            return { href: isVaultPath(href) ? env.current.fileUrl(href) : href, "data-href": href }
          },
        },
        // "bare" or "angle" for a link read from a bare URL or <url>, so it saves back that way.
        autolink: {
          default: null,
          parseHTML: (el) => el.getAttribute("data-autolink"),
          renderHTML: (a) => (a.autolink ? { "data-autolink": a.autolink } : {}),
        },
      }
    },
    addProseMirrorPlugins() {
      return [
        ...(this.parent?.() ?? []),
        new Plugin({
          key: new PluginKey("linkClicks"),
          props: {
            // Reading: links open. Editing: ⌘/Ctrl-click opens, a plain click places the cursor.
            handleClick(view, _pos, event) {
              const a = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]")
              if (!a || a.closest("[data-wikilink]") || (view.editable && !(event.metaKey || event.ctrlKey))) return false
              const href = a.getAttribute("href")!
              if (href.startsWith("#")) return false
              window.open(href, "_blank", "noopener,noreferrer")
              return true
            },
          },
        }),
      ]
    },
  }).configure({
    openOnClick: false,
    autolink: true,
    linkOnPaste: true,
    defaultProtocol: "https",
    HTMLAttributes: { rel: "noopener noreferrer nofollow", target: null },
  })

// ── Moving blocks ──

const listItems = new Set(["listItem", "taskItem"])
/** Nodes whose children are blocks of their own: each gets a handle and moves by itself. */
export const containers = new Set(["doc", "column", "callout", "toggle", "blockquote"])

/**
 * The block a position is in: the innermost list item, or the nearest node
 * that sits directly in the page, a column, a callout, a toggle or a quote.
 */
export function blockAt(state: EditorState, pos: number) {
  const $pos = state.doc.resolve(pos)
  for (let d = $pos.depth; d > 0; d--) {
    if (listItems.has($pos.node(d).type.name) || containers.has($pos.node(d - 1).type.name)) return { pos: $pos.before(d), node: $pos.node(d), depth: d }
  }
  const node = state.doc.nodeAt(pos)
  return node ? { pos, node, depth: $pos.depth + 1 } : null
}

/**
 * The range to remove when the block at pos leaves: the block, plus any
 * column, callout, toggle, quote or list it was the only thing in.
 */
function leaving($pos: ResolvedPos, node: PMNode) {
  let from = $pos.pos
  let to = from + node.nodeSize
  for (let d = $pos.depth; d > 0 && $pos.node(d).childCount === 1; d--) {
    from = $pos.before(d)
    to = $pos.after(d)
  }
  return { from, to }
}

/** Moves the block starting at pos past its neighbour, or out of its container at either end. */
export function moveBlockAt(state: EditorState, pos: number, dir: "up" | "down"): Transaction | null {
  const node = state.doc.nodeAt(pos)
  if (!node) return null
  const $pos = state.doc.resolve(pos)
  const parent = $pos.parent
  const index = $pos.index()
  const end = pos + node.nodeSize
  const sel = state.selection
  const keep = (tr: Transaction, target: number) => {
    if (sel.from >= pos && sel.to <= end) {
      const shift = target - pos
      tr.setSelection(sel instanceof NodeSelection ? NodeSelection.create(tr.doc, target) : TextSelection.create(tr.doc, sel.from + shift, sel.to + shift))
    }
    return tr.scrollIntoView()
  }
  if (dir === "up" ? index === 0 : index >= parent.childCount - 1) {
    // First or last in a callout, toggle, quote or column: step outside it.
    // A block leaving a column lands beside the whole set of columns.
    if (!containers.has(parent.type.name) || parent.type.name === "doc") return null
    const out = parent.type.name === "column" ? $pos.depth - 1 : $pos.depth
    if (out < 1) return null
    const host = $pos.node(out - 1)
    const hostIndex = $pos.index(out - 1)
    if (!host.canReplaceWith(hostIndex, hostIndex, node.type)) return null
    const to = dir === "up" ? $pos.before(out) : $pos.after(out)
    const gone = leaving($pos, node)
    const tr = state.tr.delete(gone.from, gone.to)
    const target = tr.mapping.map(to, dir === "up" ? -1 : 1)
    tr.insert(target, node)
    return keep(tr, target)
  }
  const tr = state.tr.delete(pos, end)
  const target = dir === "up" ? pos - parent.child(index - 1).nodeSize : pos + parent.child(index + 1).nodeSize
  tr.insert(target, node)
  return keep(tr, target)
}

/** Moves the block starting at pos to `to`, a gap between blocks anywhere on the page (a position before the move). */
export function moveBlockTo(state: EditorState, pos: number, to: number): Transaction | null {
  const node = state.doc.nodeAt(pos)
  if (!node) return null
  const gone = leaving(state.doc.resolve(pos), node)
  if (to >= gone.from && to <= gone.to) return null
  const tr = state.tr.delete(gone.from, gone.to)
  const at = tr.mapping.map(to)
  tr.insert(at, node)
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at + 1, tr.doc.content.size))))
  return tr
}

/**
 * Puts the block at pos beside the block at `beside`, in columns: a new pair
 * of columns, or one more column when `beside` is already a column.
 */
export function moveBlockBeside(state: EditorState, pos: number, beside: number, side: "left" | "right"): Transaction | null {
  const { column, columns } = state.schema.nodes
  const node = state.doc.nodeAt(pos)
  const target = state.doc.nodeAt(beside)
  if (!node || !target || !column || !columns) return null
  if (listItems.has(node.type.name) || listItems.has(target.type.name) || node.type === columns) return null
  const gone = leaving(state.doc.resolve(pos), node)
  if (beside >= gone.from && beside < gone.to) return null
  const $beside = state.doc.resolve(beside)
  const tr = state.tr
  if (target.type === column) {
    if ($beside.parent.childCount >= 5) return null
    tr.insert(side === "left" ? beside : beside + target.nodeSize, column.create(null, node))
  } else {
    if (!$beside.parent.canReplaceWith($beside.index(), $beside.index() + 1, columns)) return null
    // No columns inside columns.
    for (let d = $beside.depth; d > 0; d--) if ($beside.node(d).type === column) return null
    const pair = side === "left" ? [column.create(null, node), column.create(null, target)] : [column.create(null, target), column.create(null, node)]
    tr.replaceWith(beside, beside + target.nodeSize, columns.create(null, pair))
  }
  // The original goes last, mapped through the insertion.
  tr.delete(tr.mapping.map(gone.from, 1), tr.mapping.map(gone.to, -1))
  return tr
}

export function duplicateBlockAt(state: EditorState, pos: number) {
  const node = state.doc.nodeAt(pos)
  return node ? state.tr.insert(pos + node.nodeSize, node.copy(node.content)) : null
}

export function deleteBlockAt(state: EditorState, pos: number) {
  const node: PMNode | null = state.doc.nodeAt(pos)
  if (!node) return null
  const gone = leaving(state.doc.resolve(pos), node)
  return state.tr.delete(gone.from, gone.to)
}

/**
 * Puts a block that holds no cursor (an embed, a table of contents) in place
 * of the empty line the cursor is on, or after the current block, and leaves
 * the cursor on the line below it, adding one if there isn't any.
 */
function insertBlock(state: EditorState, tr: Transaction, node: PMNode, dispatch: unknown) {
  const { $from } = state.selection
  const d = $from.depth
  if (d < 1) return false
  const empty = $from.parent.isTextblock && !$from.parent.content.size
  const parent = $from.node(d - 1)
  const index = $from.index(d - 1)
  if (!parent.canReplaceWith(empty ? index : index + 1, index + 1, node.type)) return false
  if (!dispatch) return true
  const at = empty ? $from.before(d) : $from.after(d)
  if (empty) tr.replaceWith(at, $from.after(d), node)
  else tr.insert(at, node)
  const after = at + node.nodeSize
  if (!tr.doc.resolve(after).nodeAfter?.isTextblock) tr.insert(after, state.schema.nodes.paragraph.create())
  tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView()
  return true
}

/** The innermost list item around the selection, unless a code block or table cell is closer. */
function listItemAround(state: EditorState) {
  const { $from } = state.selection
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    if (listItems.has(node.type.name)) return node.type.name
    if (node.type.spec.code || node.type.spec.tableRole) return null
  }
  return null
}

/**
 * Tab nests the current list item (or every selected one) under the item
 * above, as deep as you like; Shift+Tab moves it back out. It acts on the
 * innermost list, so a to-do inside a bulleted list (or the other way round)
 * moves itself rather than its parent. In a list, Tab never leaves the
 * editor: with nothing above to nest under it does nothing, like Notion.
 */
export const ListIndent = Extension.create({
  name: "listIndent",
  addKeyboardShortcuts() {
    const indent =
      (dir: "in" | "out") =>
      ({ editor }: { editor: Editor }) => {
        const item = listItemAround(editor.state)
        if (!item) return false
        if (dir === "in") editor.commands.sinkListItem(item)
        else editor.commands.liftListItem(item)
        return true
      }
    return { Tab: indent("in"), "Shift-Tab": indent("out") }
  },
})

/** ⌘⇧↑ / ⌘⇧↓ move the current block; the "/" menu and block menu use these commands too. */
export const BlockCommands = Extension.create({
  name: "blockCommands",
  addCommands() {
    return {
      setToggle:
        (level = 0) =>
        ({ state, tr, dispatch, commands, editor }) => {
          const { $from } = state.selection
          const block = $from.parent
          const { toggle, paragraph } = state.schema.nodes
          const d = $from.depth
          if (!block.isTextblock || block.type.spec.code || d < 1 || !$from.node(d - 1).canReplaceWith($from.index(d - 1), $from.index(d - 1) + 1, toggle)) {
            return commands.wrapIn("toggle", { level })
          }
          if (dispatch) {
            // The line becomes the toggle's title, with an empty body to fill in.
            const summary = block.textContent
            const heading = block.type.name === "heading" ? Math.min(3, block.attrs.level as number) : 0
            const pos = $from.before(d)
            tr.replaceWith(pos, pos + block.nodeSize, toggle.create({ summary, level: level || heading, open: true }, paragraph.create()))
            tr.setSelection(TextSelection.create(tr.doc, pos + 2))
            if (!summary) (editor.storage as unknown as { toggle: { focusTitle: boolean } }).toggle.focusTitle = true
          }
          return true
        },
      insertToc:
        () =>
        ({ state, tr, dispatch }) =>
          insertBlock(state, tr, state.schema.nodes.toc.create(), dispatch),
      insertEmbed:
        (target, heading = "") =>
        ({ state, tr, dispatch }) =>
          insertBlock(state, tr, state.schema.nodes.embed.create({ target, heading }), dispatch),
      insertDate:
        (date) =>
        ({ commands }) =>
          commands.insertContent([{ type: "dateMention", attrs: { date } }, { type: "text", text: " " }]),
      insertMathBlock:
        (latex = "") =>
        ({ commands }) =>
          commands.insertContent({ type: "mathBlock", attrs: { latex } }),
      insertMathInline:
        (latex = "") =>
        ({ commands }) =>
          commands.insertContent({ type: "mathInline", attrs: { latex } }),
      moveBlock:
        (dir) =>
        ({ state, dispatch }) => {
          const block = blockAt(state, state.selection.from)
          const tr = block && moveBlockAt(state, block.pos, dir)
          if (!tr) return false
          dispatch?.(tr)
          return true
        },
    }
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-ArrowUp": ({ editor }: { editor: Editor }) => editor.commands.moveBlock("up"),
      "Mod-Shift-ArrowDown": ({ editor }: { editor: Editor }) => editor.commands.moveBlock("down"),
      "Alt-ArrowUp": ({ editor }: { editor: Editor }) => editor.commands.moveBlock("up"),
      "Alt-ArrowDown": ({ editor }: { editor: Editor }) => editor.commands.moveBlock("down"),
    }
  },
})
