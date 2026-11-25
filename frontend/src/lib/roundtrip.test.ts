// @vitest-environment happy-dom
import { createDocument, getSchema } from "@tiptap/core"
import { describe, expect, it, vi } from "vitest"

import { createExtensions, type EnvRef } from "@/editor/extensions"
import { markdownToHtml, needsSource } from "@/lib/markdown"
import { headings } from "@/lib/notes"
import { docToMarkdown } from "@/lib/serialize"

// DOMPurify can't read element names under happy-dom and would unwrap the
// first element of every page. The browser runs the real one; data-*
// attributes, which carry the editor's extras, pass it by default.
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }))

const env = {
  current: {
    path: "Work/Page.md",
    pages: [],
    linkMode: "app",
    fileUrl: (p: string) => `/api/files/${p}`,
    openLink: () => {},
    openTag: () => {},
    upload: async () => undefined,
    slashItems: () => [],
  },
} as unknown as EnvRef
const schema = getSchema(createExtensions(env))

const load = (md: string) => createDocument(markdownToHtml(md, { fileUrl: env.current.fileUrl }), schema)

/** Markdown → editor document → Markdown, as opening and saving a page does. */
const roundTrip = (md: string) => docToMarkdown(load(md))

const same = (cases: string[]) => {
  for (const md of cases) it(JSON.stringify(md), () => expect(roundTrip(md)).toBe(md))
}

describe("headings", () => {
  same(["# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n"])
})

describe("lists mixing to-dos and plain items", () => {
  same([
    "- [ ] task\n- plain\n- [x] done\n",
    "- plain first\n- [ ] then a task\n",
    "- [ ] all\n- [x] tasks\n",
    "- outer\n  - [ ] nested task\n  - nested plain\n- [ ] outer task\n",
    "Before\n\n- [ ] a\n- b\n\nAfter\n",
  ])
  it("keeps each item's kind", () => {
    const list = load("- [ ] task\n- plain\n").toJSON().content
    expect(list.map((n: { type: string }) => n.type)).toEqual(["taskList", "bulletList"])
  })
})

describe("table alignment", () => {
  same([
    "| a | b | c | d |\n| :--- | :---: | ---: | --- |\n| 1 | 2 | 3 | 4 |\n",
    "| plain |\n| --- |\n| row |\n",
  ])
})

describe("links", () => {
  same([
    "See https://example.com here.\n",
    "See https://example.com.\n",
    "(https://example.com/a_b)\n",
    "Angle <https://example.org> form.\n",
    "Mail <me@example.com> or you@example.com\n",
    "Bare www.example.net too.\n",
    "[label](https://example.com)\n",
    "[https://example.com](https://example.com/other)\n",
    "[link](https://example.com \"Title\")\n",
  ])
  it("writes a typed address bare, unless text runs into it", () => {
    const link = schema.marks.link.create({ href: "https://example.com" })
    const para = (after: string) =>
      schema.node("doc", null, [schema.node("paragraph", null, [schema.text("https://example.com", [link]), schema.text(after)])])
    expect(docToMarkdown(para(" next"))).toBe("https://example.com next\n")
    expect(docToMarkdown(para("/more"))).toBe("<https://example.com>/more\n")
  })
})

describe("angle brackets in text", () => {
  same(["Returns Promise<void> here.\n", "Press <kbd>Ctrl</kbd> and a < b > c.\n", "A `Map<string, T>` in code.\n"])
  it("stays in the visual editor", () => {
    expect(needsSource("Returns Promise<void> here.\n")).toBe(false)
    expect(needsSource("Inline <span>html</span> too.\n")).toBe(false)
  })
  it("sends real HTML blocks and comments to the source editor", () => {
    expect(needsSource("<div align=\"center\">\n\nHi\n\n</div>\n")).toBe(true)
    expect(needsSource("<!-- hidden -->\n\nText\n")).toBe(true)
    expect(needsSource("- item\n\n  <table><tr><td>x</td></tr></table>\n")).toBe(true)
    expect(needsSource("<details>\n<summary>More</summary>\n\nInside\n</details>\n")).toBe(false)
    expect(needsSource("```html\n<div>\n```\n")).toBe(false)
  })
})

describe("callouts", () => {
  same([
    "> [!NOTE]\n> Useful information.\n",
    "> [!TIP]\n> Helpful advice.\n",
    "> [!IMPORTANT]\n> Key information.\n",
    "> [!WARNING]\n> Urgent info.\n",
    "> [!CAUTION]\n> Risks ahead.\n",
    "> [!note] Custom title\n> Body\n",
    "> [!faq]- Folded shut\n> Answer\n",
    "> [!example]+ Open by default\n> Body\n",
    "> [!bug] Title only\n",
    "> [!info]\n> One\n>\n> Two\n",
  ])
  it("keeps the case style when the type changes", () => {
    const doc = load("> [!CAUTION] Heads up\n> Body\n")
    const callout = doc.firstChild!
    expect(callout.attrs).toMatchObject({ type: "warning", name: "CAUTION", fold: "", title: "Heads up" })
    const changed = doc.type.create(null, callout.type.create({ ...callout.attrs, type: "tip" }, callout.content))
    expect(docToMarkdown(changed)).toBe("> [!TIP] Heads up\n> Body\n")
  })
})

describe("page formulas", () => {
  same([
    "Spent {{ SUM([Expenses/Amount]) }} so far\n",
    "{{ ROUND(SUMIF([Budget/Kind], \"Food\", [Budget/Amount]) / 4, 2) }}\n",
    "Two {{ 1 + 1 }} and {{ TODAY() }} on a line\n",
    "Code stays code: `{{ x }}`\n",
    "An open {{ with no end\n",
  ])
  it("makes a formula node", () => {
    const para = load("a {{ 1 + 2 }} b\n").toJSON().content[0]
    expect(para.content.map((n: { type: string }) => n.type)).toContain("formula")
  })
})

describe("underline and colours", () => {
  same([
    "Some <u>underlined</u> words.\n",
    "<u>Starts</u> the line.\n",
    "A <span data-color=\"red\">red</span> word and a <mark data-color=\"blue\">blue</mark> one.\n",
    "<span data-color=\"purple\">A whole coloured line</span>\n",
    "<mark data-color=\"yellow\">A whole highlighted line</mark>\n",
    "Plain ==highlight== stays as it was.\n",
    "**<span data-color=\"green\">bold and green</span>**\n",
    "- <span data-color=\"orange\">in a list</span>\n- [ ] <u>in a to-do</u>\n",
    "| a | b |\n| --- | --- |\n| <span data-color=\"pink\">x</span> | <u>y</u> |\n",
    "> [!note]\n> <mark data-color=\"gray\">in a callout</mark>\n",
  ])
  it("makes marks, not text", () => {
    const para = load("a <u>b</u> <span data-color=\"red\">c</span> <mark data-color=\"blue\">d</mark> ==e==\n").firstChild!
    const marks = (i: number) => para.child(i).marks.map((m) => [m.type.name, m.attrs.color ?? null])
    expect(marks(1)).toEqual([["underline", null]])
    expect(marks(3)).toEqual([["textColor", "red"]])
    expect(marks(5)).toEqual([["highlight", "blue"]])
    expect(marks(7)).toEqual([["highlight", null]])
  })
  it("leaves unknown colours and other tags as text, in the visual editor", () => {
    const cases = ["A <span data-color=\"teal\">odd</span> colour.\n", "A <span>plain span</span> and <b>bold tag</b>.\n", "An unclosed <u>underline\n"]
    for (const md of cases) {
      expect(roundTrip(md)).toBe(md)
      expect(needsSource(md)).toBe(false)
    }
    expect(load(cases[0]).firstChild!.childCount).toBe(1)
  })
  it("doesn't send coloured pages to the source editor", () => {
    expect(needsSource("<u>a</u>\n\n<span data-color=\"red\">b</span>\n\n<mark data-color=\"blue\">c</mark>\n")).toBe(false)
  })
})

describe("columns", () => {
  const two = ":::: columns\n::: column\nLeft\n\nMore left\n:::\n::: column\nRight\n:::\n::::\n"
  same([
    two,
    "Before\n\n" + two + "\nAfter\n",
    ":::: columns\n::: column\n# Heading\n\n- a\n- [ ] b\n:::\n::: column\n```js\n:::\n```\n:::\n::: column\n> [!tip]\n> Third\n:::\n::::\n",
    ":::: columns\n::: column\n:::\n::: column\n:::\n::::\n",
    // Columns inside a column take longer fences, so each closes its own.
    ":::::: columns\n::::: column\n:::: columns\n::: column\na\n:::\n::: column\nb\n:::\n::::\n:::::\n::::: column\nc\n:::::\n::::::\n",
    "> [!note]\n> :::: columns\n> ::: column\n> a\n> :::\n> ::: column\n> b\n> :::\n> ::::\n",
  ])
  it("makes columns", () => {
    const cols = load(two).firstChild!
    expect(cols.type.name).toBe("columns")
    expect(cols.childCount).toBe(2)
    expect(cols.firstChild!.childCount).toBe(2)
  })
  it("reads fences of any length, and writes its own", () => {
    expect(roundTrip("::: columns\n::: column\na\n:::\n::: column\nb\n:::\n:::\n")).toBe(":::: columns\n::: column\na\n:::\n::: column\nb\n:::\n::::\n")
  })
  it("leaves an unclosed fence as text, in the visual editor", () => {
    const md = ":::: columns\n::: column\na\n"
    expect(load(md).firstChild!.type.name).toBe("paragraph")
    expect(needsSource(two)).toBe(false)
    expect(needsSource(md)).toBe(false)
  })
})

describe("toggle headings", () => {
  same([
    "<details>\n<summary><h2>Section</h2></summary>\n\nInside\n\n</details>\n",
    "<details open>\n<summary><h1>Top &amp; more</h1></summary>\n\n- a\n- b\n\n</details>\n",
    "<details>\n<summary>Plain toggle</summary>\n\nInside\n\n</details>\n",
    "<details>\n<summary><h3>Outer</h3></summary>\n\n<details>\n<summary><h3>Inner</h3></summary>\n\nDeep\n\n</details>\n\n</details>\n",
  ])
  it("keeps the level", () => {
    expect(load("<details>\n<summary><h2>Section</h2></summary>\n\nInside\n\n</details>\n").firstChild!.attrs).toMatchObject({ summary: "Section", level: 2 })
    expect(needsSource("<details>\n<summary><h2>Section</h2></summary>\n\nInside\n\n</details>\n")).toBe(false)
  })
  it("shows in the outline", () => {
    expect(headings("# A\n\n<details>\n<summary><h2>B &amp; C</h2></summary>\n\n### D\n\n</details>\n").map((h) => [h.level, h.text])).toEqual([
      [1, "A"],
      [2, "B & C"],
      [3, "D"],
    ])
  })
})

describe("table of contents", () => {
  same(["[TOC]\n", "# Title\n\n[TOC]\n\n## One\n", "\\[TOC\\]\n", "- \\[TOC\\]\n"])
  it("makes a block only on a line of its own", () => {
    expect(load("[TOC]\n").firstChild!.type.name).toBe("toc")
    expect(load("Text with [TOC] inside.\n").firstChild!.type.name).toBe("paragraph")
  })
})

describe("embedded pages", () => {
  same([
    "![[Other page]]\n",
    "![[Folder/Page#Section]]\n",
    "![[Page|Shown as]]\n",
    "Before\n\n![[Budget]]\n\nAfter\n",
    "See ![[Page]] in a sentence.\n",
    "- ![[Page]]\n",
    "[[Page]]\n",
  ])
  it("is a block alone on a line, a link inside one", () => {
    expect(load("![[Other page]]\n").firstChild!.type.name).toBe("embed")
    expect(load("![[Folder/Page#Section]]\n").firstChild!.attrs).toMatchObject({ target: "Folder/Page", heading: "Section" })
    const inline = load("See ![[Page]] here.\n").firstChild!.child(1)
    expect([inline.type.name, inline.attrs.embed]).toEqual(["pageLink", true])
  })
  it("still embeds pictures and media as before", () => {
    expect(load("![[photo.png]]\n").firstChild!.type.name).toBe("image")
    expect(load("![[clip.mp3]]\n").firstChild!.attrs.src).toBe("attachments/clip.mp3")
  })
})

describe("pictures, audio and files", () => {
  same([
    "![A cat|400](attachments/cat.png)\n",
    "![A cat|320](attachments/cat.png \"Asleep on the sofa\")\n",
    "![A cat](attachments/cat.png \"Caption only\")\n",
    "![Voice memo](attachments/memo.mp3)\n",
    "[report.pdf](attachments/report.pdf)\n",
    "![a|b](attachments/x.png)\n",
    "Text\n\n![A cat](attachments/cat.png)\n\nMore\n",
    "![one](attachments/1.png)\n\n![two](attachments/2.png)\n",
    "- item\n\n  ![in a list](attachments/x.png)\n",
    "![A cat|right|400](attachments/cat.png)\n",
    "![A cat|left](attachments/cat.png \"To one side\")\n",
  ])
  it("leaves no empty paragraph around a picture", () => {
    expect(load("![A cat](attachments/cat.png)\n").toJSON().content.map((n: { type: string }) => n.type)).toEqual(["image"])
    expect(load("Before ![A cat](attachments/cat.png) after\n").toJSON().content.map((n: { type: string }) => n.type)).toEqual(["paragraph", "image", "paragraph"])
    expect(roundTrip("Before ![A cat](attachments/cat.png) after\n")).toBe("Before\n\n![A cat](attachments/cat.png)\n\nafter\n")
  })
  it("reads the width from the alt text", () => {
    expect(load("![A cat|400](attachments/cat.png)\n").firstChild!.attrs).toMatchObject({ alt: "A cat", width: 400, src: "attachments/cat.png" })
    expect(load("![a|b](attachments/x.png)\n").firstChild!.attrs).toMatchObject({ alt: "a|b", width: null })
  })
  it("reads the side from the alt text", () => {
    expect(load("![A cat|right|400](attachments/cat.png)\n").firstChild!.attrs).toMatchObject({ alt: "A cat", width: 400, align: "right" })
    expect(load("![A cat|left](attachments/cat.png)\n").firstChild!.attrs).toMatchObject({ alt: "A cat", width: null, align: "left" })
    // Centre is the default, so it isn't written.
    expect(roundTrip("![A cat|center|400](attachments/cat.png)\n")).toBe("![A cat|400](attachments/cat.png)\n")
  })
})

describe("bookmarks", () => {
  same(["[Example](https://example.com/page \"bookmark\")\n", "Text\n\n[example.com](https://example.com \"bookmark\")\n\nMore\n"])
  // An embed is the same kind of line; a PDF preview is stored the way a picture is.
  same([
    "[Me at the zoo](https://www.youtube.com/watch?v=jNQXAC9IVRw \"embed\")\n",
    "Before\n\n[vimeo.com/76979871](https://vimeo.com/76979871 \"embed\")\n\nAfter\n",
    "![Spec sheet](attachments/Spec-sheet.pdf)\n",
    "Before\n\n![Spec sheet](attachments/Spec-sheet.pdf)\n\n[Spec-sheet.pdf](attachments/Spec-sheet.pdf)\n",
  ])
})

describe("dates", () => {
  same([
    "Due @2026-11-11 at the latest.\n",
    "@2026-11-11\n",
    "- [ ] Send the report @2026-12-01\n",
    "(@2027-01-05)\n",
    "An address like me@2026-11-11 is not a date.\n",
    "Nor is @2026-11-111 or @2026-11-11-x.\n",
    "Code: `@2026-11-11`\n",
  ])
  it("makes a date node", () => {
    const para = load("Due @2026-11-11 at the latest.\n").firstChild!
    expect(para.child(1).type.name).toBe("dateMention")
    expect(para.child(1).attrs.date).toBe("2026-11-11")
    expect(load("An address like me@2026-11-11 is not a date.\n").firstChild!.childCount).toBe(1)
  })
})

describe("more callout kinds", () => {
  same(["> [!question] Why?\n> Because.\n", "> [!quote]\n> Said someone.\n", "> [!success]- Done\n> All good.\n", "> [!example]\n> Like this.\n"])
  it("has kinds of their own", () => {
    expect(load("> [!question]\n> x\n").firstChild!.attrs.type).toBe("question")
    expect(load("> [!cite]\n> x\n").firstChild!.attrs.type).toBe("quote")
    expect(load("> [!done]\n> x\n").firstChild!.attrs.type).toBe("success")
    expect(load("> [!faq]\n> x\n").firstChild!.attrs.type).toBe("question")
  })
})
