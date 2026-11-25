// @vitest-environment happy-dom
import { createDocument, getSchema } from "@tiptap/core"
import { EditorState, TextSelection } from "@tiptap/pm/state"
import { describe, expect, it, vi } from "vitest"

import { blockAt, deleteBlockAt, moveBlockAt, moveBlockBeside, moveBlockTo } from "@/editor/blocks"
import { createExtensions, datesFor, type EnvRef } from "@/editor/extensions"
import { sectionOf } from "@/editor/embed"
import { linkCardOf, pdfBlockOf } from "@/editor/media"
import { markdownToHtml } from "@/lib/markdown"
import { docToMarkdown } from "@/lib/serialize"

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }))

const env = { current: { path: "Work/Page.md", pages: [], linkMode: "app", fileUrl: (p: string) => p, openLink: () => {}, openTag: () => {}, upload: async () => undefined, slashItems: () => [] } } as unknown as EnvRef
const schema = getSchema(createExtensions(env))
const state = (md: string) => EditorState.create({ doc: createDocument(markdownToHtml(md, { fileUrl: (p) => p }), schema) })

/** Where the first block with this text starts. */
function find(s: EditorState, text: string) {
  let at = -1
  s.doc.descendants((node, pos) => {
    if (at < 0 && node.isTextblock && node.textContent === text) at = pos
    return at < 0
  })
  if (at < 0) throw new Error(`no block "${text}"`)
  return at
}
const md = (s: EditorState, tr: ReturnType<typeof moveBlockTo>) => docToMarkdown(s.apply(tr!).doc)

const columns = ":::: columns\n::: column\nA1\n\nA2\n:::\n::: column\nB1\n:::\n::::\n"

describe("blockAt", () => {
  const at = (source: string, text: string) => {
    const s = state(source)
    return blockAt(s, find(s, text) + 1)!.node.type.name
  }
  it("gives the block itself inside columns, callouts, toggles and quotes", () => {
    expect(at(columns, "A2")).toBe("paragraph")
    expect(at("> [!note]\n> One\n>\n> Two\n", "Two")).toBe("paragraph")
    expect(at("> One\n>\n> ## Two\n", "Two")).toBe("heading")
    expect(at("<details>\n<summary>T</summary>\n\nIn\n\n</details>\n", "In")).toBe("paragraph")
  })
  it("gives the list item in a list, and the table for a cell", () => {
    expect(at("> [!note]\n> - item\n", "item")).toBe("listItem")
    expect(at(":::: columns\n::: column\n| a |\n| --- |\n| cell |\n:::\n::: column\nx\n:::\n::::\n", "cell")).toBe("table")
    expect(at("Plain\n", "Plain")).toBe("paragraph")
  })
})

describe("moving blocks", () => {
  it("moves a block out of the end of a callout", () => {
    const s = state("> [!note]\n> One\n>\n> Two\n\nAfter\n")
    expect(md(s, moveBlockAt(s, find(s, "Two"), "down"))).toBe("> [!note]\n> One\n\nTwo\n\nAfter\n")
    expect(md(s, moveBlockAt(s, find(s, "One"), "up"))).toBe("One\n\n> [!note]\n> Two\n\nAfter\n")
  })
  it("takes the cursor along", () => {
    const base = state("> [!note]\n> One\n>\n> Two\n")
    const s = base.apply(base.tr.setSelection(TextSelection.create(base.doc, find(base, "Two") + 2)))
    const next = s.apply(moveBlockAt(s, find(s, "Two"), "down")!)
    expect(next.selection.$from.parent.textContent).toBe("Two")
    expect(next.selection.$from.parentOffset).toBe(1)
  })
  it("removes a container the block was alone in", () => {
    const s = state("> [!note]\n> Only\n\nAfter\n")
    expect(md(s, moveBlockAt(s, find(s, "Only"), "down"))).toBe("Only\n\nAfter\n")
    const t = state("Before\n\n- one\n")
    expect(md(t, deleteBlockAt(t, find(t, "one") - 1))).toBe("Before\n")
  })
  it("moves a block out of a column to the page, leaving the other column", () => {
    const s = state(columns + "\nEnd\n")
    expect(md(s, moveBlockAt(s, find(s, "A2"), "down"))).toBe(":::: columns\n::: column\nA1\n:::\n::: column\nB1\n:::\n::::\n\nA2\n\nEnd\n")
    const out = md(s, moveBlockTo(s, find(s, "B1"), s.doc.content.size))
    expect(out).toBe(":::: columns\n::: column\nA1\n\nA2\n:::\n::::\n\nEnd\n\nB1\n")
  })
  it("doesn't move a block into itself", () => {
    const s = state("> [!note]\n> One\n\nEnd\n")
    expect(moveBlockTo(s, 0, find(s, "One"))).toBeNull()
    expect(moveBlockAt(s, find(s, "End"), "down")).toBeNull()
  })
  it("moves across containers", () => {
    const s = state("Loose\n\n> [!note]\n> One\n")
    expect(md(s, moveBlockTo(s, find(s, "Loose"), find(s, "One")))).toBe("> [!note]\n> Loose\n>\n> One\n")
  })
})

describe("dropping beside a block", () => {
  it("makes two columns", () => {
    const s = state("One\n\nTwo\n\nThree\n")
    expect(md(s, moveBlockBeside(s, find(s, "Three"), find(s, "One"), "right"))).toBe(":::: columns\n::: column\nOne\n:::\n::: column\nThree\n:::\n::::\n\nTwo\n")
    expect(md(s, moveBlockBeside(s, find(s, "One"), find(s, "Two"), "left"))).toBe(":::: columns\n::: column\nOne\n:::\n::: column\nTwo\n:::\n::::\n\nThree\n")
    expect(md(s, moveBlockBeside(s, find(s, "Two"), find(s, "One"), "right"))).toBe(":::: columns\n::: column\nOne\n:::\n::: column\nTwo\n:::\n::::\n\nThree\n")
  })
  it("adds a column to existing ones", () => {
    const s = state(columns + "\nNew\n")
    const second = find(s, "B1") - 1
    expect(md(s, moveBlockBeside(s, find(s, "New"), second, "right"))).toBe(":::: columns\n::: column\nA1\n\nA2\n:::\n::: column\nB1\n:::\n::: column\nNew\n:::\n::::\n")
    expect(md(s, moveBlockBeside(s, find(s, "A2"), second, "left"))).toBe(":::: columns\n::: column\nA1\n:::\n::: column\nA2\n:::\n::: column\nB1\n:::\n::::\n\nNew\n")
  })
  it("refuses list items, a block beside itself and a sixth column", () => {
    const s = state("- item\n\nText\n")
    expect(moveBlockBeside(s, find(s, "item") - 1, find(s, "Text"), "right")).toBeNull()
    expect(moveBlockBeside(s, find(s, "Text"), find(s, "Text"), "right")).toBeNull()
    const five = state(":::: columns\n" + "::: column\nx\n:::\n".repeat(5) + "::::\n\nNew\n")
    expect(moveBlockBeside(five, find(five, "New"), 1, "right")).toBeNull()
  })
})

describe("sections of an embedded page", () => {
  const page = "Intro\n\n## One\n\nText one\n\n### Deeper\n\nMore\n\n## Two\n\nText two\n\n<details>\n<summary><h2>Folded</h2></summary>\n\nInside\n\n</details>\n\n## Last\n"
  it("runs to the next heading of the same level", () => {
    expect(sectionOf(page, "One")).toBe("## One\n\nText one\n\n### Deeper\n\nMore\n")
    expect(sectionOf(page, "deeper")).toBe("### Deeper\n\nMore\n")
    expect(sectionOf(page, "Two")).toBe("## Two\n\nText two\n")
  })
  it("takes a toggle heading with what's inside it", () => {
    expect(sectionOf(page, "Folded")).toBe("<details>\n<summary><h2>Folded</h2></summary>\n\nInside\n\n</details>")
    expect(sectionOf(page, "Missing")).toBeNull()
  })
})

describe("dates after @", () => {
  const now = new Date(2026, 10, 11) // Wednesday 11 November 2026
  const first = (q: string) => datesFor(q, now)[0]?.date
  it("understands words, weekdays and written dates", () => {
    expect(datesFor("", now).map((d) => d.title)).toEqual(["Today", "Tomorrow", "Next week"])
    expect(first("tom")).toBe("2026-11-12")
    expect(first("yes")).toBe("2026-11-10")
    expect(first("fri")).toBe("2026-11-13")
    expect(first("wed")).toBe("2026-11-18")
    expect(first("2026-12-25")).toBe("2026-12-25")
    expect(first("25 dec")).toBe("2026-12-25")
    expect(datesFor("project", now)).toEqual([])
  })
})

describe("link cards and PDFs", () => {
  const first = (md: string) => state(md).doc.firstChild!

  it("tells how a line that is only a web link shows", () => {
    expect(linkCardOf(first("[x](https://example.com)\n"))).toEqual({ kind: "link", href: "https://example.com", embeddable: false })
    expect(linkCardOf(first('[x](https://example.com "bookmark")\n'))?.kind).toBe("bookmark")
    expect(linkCardOf(first('[x](https://youtu.be/jNQXAC9IVRw "embed")\n'))).toEqual({ kind: "embed", href: "https://youtu.be/jNQXAC9IVRw", embeddable: true })
    expect(linkCardOf(first("https://vimeo.com/76979871\n"))).toMatchObject({ kind: "link", embeddable: true })
    // "embed" on a site that can't be framed falls back to a bookmark card.
    expect(linkCardOf(first('[x](https://example.com "embed")\n'))).toMatchObject({ kind: "bookmark", embeddable: false })
    // Not a line of its own, not the web, or more than a link: no card.
    expect(linkCardOf(first('See [x](https://example.com "bookmark") here\n'))).toBeNull()
    expect(linkCardOf(first("[x](attachments/a.pdf)\n"))).toBeNull()
    expect(linkCardOf(first("# Heading\n"))).toBeNull()
  })

  it("tells an attached PDF's card from its preview", () => {
    expect(pdfBlockOf(first("[a.pdf](attachments/a.pdf)\n"))).toBe("card")
    expect(pdfBlockOf(first("![a](attachments/a.PDF)\n"))).toBe("preview")
    expect(pdfBlockOf(first("[a.zip](attachments/a.zip)\n"))).toBeNull()
    expect(pdfBlockOf(first("![a](attachments/a.png)\n"))).toBeNull()
    // A PDF elsewhere on the web can't be framed, so it has no preview to switch to.
    expect(pdfBlockOf(first("[a.pdf](https://example.com/a.pdf)\n"))).toBeNull()
    expect(pdfBlockOf(first("![a](https://example.com/a.pdf)\n"))).toBeNull()
  })
})
