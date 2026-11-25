import { Mark, type Editor } from "@tiptap/core"
import Highlight from "@tiptap/extension-highlight"

import { isColor, type Color } from "@/lib/markdown"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    colors: {
      /** Colours the selected text, or what's typed next; null goes back to the default. */
      setTextColor: (color: Color | null) => ReturnType
      /** The background behind the selected text; "default" is the plain yellow highlight. */
      setBackground: (color: Color | "default" | null) => ReturnType
    }
  }
}

/** Coloured text, stored as <span data-color="red">…</span>. */
export const TextColor = Mark.create({
  name: "textColor",
  addAttributes() {
    return {
      color: {
        default: "gray",
        parseHTML: (el) => el.getAttribute("data-color"),
        renderHTML: (a) => ({ "data-color": a.color }),
      },
    }
  },
  parseHTML: () => [{ tag: "span[data-color]", getAttrs: (el) => (isColor(el.getAttribute("data-color")) ? null : false) }],
  renderHTML: ({ HTMLAttributes }) => ["span", HTMLAttributes, 0],
  addCommands() {
    return {
      setTextColor:
        (color) =>
        ({ commands }) =>
          color ? commands.setMark(this.name, { color }) : commands.unsetMark(this.name),
    }
  },
})

/** ==highlight==, or with a colour <mark data-color="blue">…</mark>. */
export const Background = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => (isColor(el.getAttribute("data-color")) ? el.getAttribute("data-color") : null),
        renderHTML: (a) => (a.color ? { "data-color": a.color } : {}),
      },
    }
  },
  addCommands() {
    return {
      ...this.parent?.(),
      setBackground:
        (color) =>
        ({ commands }) =>
          color ? commands.setMark(this.name, { color: color === "default" ? null : color }) : commands.unsetMark(this.name),
    }
  },
})

/** Colours every line of text in the block at pos; null clears the colour. */
export function colorBlock(editor: Editor, pos: number, kind: "text" | "background", color: Color | "default" | null) {
  const { state } = editor
  const node = state.doc.nodeAt(pos)
  if (!node) return false
  const type = kind === "text" ? state.schema.marks.textColor : state.schema.marks.highlight
  const from = pos + 1
  const to = pos + node.nodeSize - 1
  const tr = state.tr.removeMark(from, to, type)
  if (color) tr.addMark(from, to, type.create({ color: color === "default" ? null : color }))
  editor.view.dispatch(tr)
  return true
}

export const colorNames: Record<Color, string> = {
  gray: "Grey",
  brown: "Brown",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
  red: "Red",
}
