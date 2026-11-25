import { Extension, mergeAttributes, Node } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Slice } from "@tiptap/pm/model"
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state"
import { ReplaceAroundStep } from "@tiptap/pm/transform"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    columns: {
      /** Replaces an empty line with n columns, or adds them below. */
      insertColumns: (n: number) => ReturnType
      /** Adds a column after the one the cursor is in. */
      addColumn: () => ReturnType
      /** Removes the cursor's column; its blocks go, and one column left becomes plain blocks. */
      removeColumn: () => ReturnType
    }
  }
}

export const MAX_COLUMNS = 5

/**
 * Blocks side by side, stored as fenced divs:
 *
 *   :::: columns
 *   ::: column
 *   Left
 *   :::
 *   ::: column
 *   Right
 *   :::
 *   ::::
 */
export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column+",
  defining: true,
  isolating: true,
  parseHTML: () => [{ tag: "div[data-columns]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-columns": "", class: "columns", "data-count": node.childCount }), 0],
  addCommands() {
    return {
      insertColumns:
        (n) =>
        ({ state, tr, dispatch }) => {
          const { schema } = state
          const { $from } = state.selection
          const count = Math.max(2, Math.min(MAX_COLUMNS, n))
          const node = this.type.create(
            null,
            Array.from({ length: count }, () => schema.nodes.column.create(null, schema.nodes.paragraph.create())),
          )
          // The innermost place columns may go, never inside other columns:
          // here in place of an empty line, or after a block further out.
          for (let d = $from.depth; d > 0; d--) {
            let nested = false
            for (let a = d - 1; a > 0; a--) nested ||= $from.node(a).type === schema.nodes.column
            if (nested) continue
            const parent = $from.node(d - 1)
            const index = $from.index(d - 1)
            const here = $from.node(d)
            const empty = d === $from.depth && here.isTextblock && !here.content.size
            if (!parent.canReplaceWith(empty ? index : index + 1, index + 1, this.type)) continue
            if (!dispatch) return true
            const at = empty ? $from.before(d) : $from.after(d)
            if (empty) tr.replaceWith(at, $from.after(d), node)
            else tr.insert(at, node)
            tr.setSelection(TextSelection.create(tr.doc, at + 3)).scrollIntoView()
            return true
          }
          return false
        },
      addColumn:
        () =>
        ({ state, tr, dispatch }) => {
          const at = columnAround(state)
          if (!at || at.columns.childCount >= MAX_COLUMNS) return false
          if (dispatch) {
            const after = at.pos + at.column.nodeSize
            tr.insert(after, state.schema.nodes.column.create(null, state.schema.nodes.paragraph.create()))
            tr.setSelection(TextSelection.create(tr.doc, after + 2)).scrollIntoView()
          }
          return true
        },
      removeColumn:
        () =>
        ({ state, tr, dispatch }) => {
          const at = columnAround(state)
          if (!at) return false
          if (dispatch) {
            tr.delete(at.pos, at.pos + at.column.nodeSize)
            // The cursor goes to the end of the column before, or the start of the one after.
            const $at = tr.doc.resolve(at.pos)
            tr.setSelection($at.nodeBefore ? Selection.near($at, -1) : Selection.near($at, 1)).scrollIntoView()
          }
          return true
        },
    }
  },
  addKeyboardShortcuts() {
    return {
      // Backspace at the start of an empty column removes it, so the cursor
      // is never stuck in one.
      Backspace: ({ editor }) => {
        const { state } = editor
        const { $from, empty } = state.selection
        if (!empty || $from.parentOffset !== 0) return false
        const at = columnAround(state)
        if (!at || $from.depth !== at.depth + 1) return false
        const only = at.column.childCount === 1 && at.column.firstChild!.isTextblock && !at.column.firstChild!.content.size
        return only ? editor.commands.removeColumn() : false
      },
    }
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("columnsTidy"),
        // One column on its own is just its blocks.
        appendTransaction(trs, _old, state) {
          if (!trs.some((t) => t.docChanged)) return null
          let tr: Transaction | null = null
          state.doc.descendants((node, pos) => {
            if (node.type.name !== "columns") return true
            if (node.childCount !== 1) return true
            tr ??= state.tr
            const at = tr.mapping.map(pos)
            // Lift the blocks out of both wrappers, so the cursor stays where it is.
            tr.step(new ReplaceAroundStep(at, at + node.nodeSize, at + 2, at + node.nodeSize - 2, Slice.empty, 0, true))
            return false
          })
          return tr
        },
      }),
    ]
  },
})

export const Column = Node.create({
  name: "column",
  content: "block+",
  defining: true,
  isolating: true,
  parseHTML: () => [{ tag: "div[data-column]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-column": "", class: "column" }), 0],
})

/** The innermost column around the selection. */
export function columnAround(state: EditorState): { pos: number; depth: number; column: PMNode; columns: PMNode } | null {
  const { $from } = state.selection
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "column") return { pos: $from.before(d), depth: d, column: $from.node(d), columns: $from.node(d - 1) }
  }
  return null
}

/** Whether the selection is inside columns (the "/" menu doesn't nest them). */
export const inColumns = (state: EditorState) => columnAround(state) !== null

export const ColumnsKit = Extension.create({
  name: "columnsKit",
  addExtensions: () => [Columns, Column],
})
