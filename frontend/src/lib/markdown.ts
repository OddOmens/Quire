import DOMPurify from "dompurify"
import { Marked, Renderer, type RendererThis, type TokenizerThis, type Tokens } from "marked"

/**
 * Markdown → HTML shaped for the editor's schema. Pages are stored as
 * Markdown; the editor loads this HTML and lib/serialize.ts writes Markdown
 * back. Besides GFM it understands [[wikilinks]], ==highlights==, callouts
 * (> [!note]) and ![[embedded images]].
 */

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

export const CALLOUTS = ["note", "tip", "success", "question", "warning", "danger", "example", "quote"] as const
export type CalloutType = (typeof CALLOUTS)[number]

// Obsidian's and GitHub's type names, each shown as one of Quire's kinds.
const calloutAliases: Record<string, CalloutType> = {
  note: "note", info: "note", important: "note", abstract: "note", summary: "note", tldr: "note", todo: "note",
  tip: "tip", hint: "tip",
  success: "success", check: "success", done: "success",
  question: "question", help: "question", faq: "question",
  warning: "warning", caution: "warning", attention: "warning",
  danger: "danger", error: "danger", bug: "danger", failure: "danger", fail: "danger", missing: "danger",
  example: "example",
  quote: "quote", cite: "quote",
}

export const calloutType = (t: string): CalloutType => calloutAliases[t.toLowerCase()] ?? "note"

/** The colours text and its background can take, as in Notion. */
export const COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const
export type Color = (typeof COLORS)[number]
export const isColor = (c: unknown): c is Color => (COLORS as readonly string[]).includes(c as string)

const videoExt = /\.(mp4|webm|mov|m4v)$/i
const audioExt = /\.(mp3|m4a|wav|ogg|oga|opus|flac|aac)$/i
const imageExt = /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|m4v|mp3|m4a|wav|ogg|oga|opus|flac|aac)$/i

/** What plays or shows inline: files stored as ![name](attachments/x.ext). */
export const mediaKind = (src: string): "video" | "audio" | "pdf" | "image" =>
  videoExt.test(src) ? "video" : audioExt.test(src) ? "audio" : /\.pdf$/i.test(src) ? "pdf" : "image"
/** Whether an uploaded file embeds (picture, video, audio) rather than links. */
export const isMedia = (name: string) => imageExt.test(name)

/** A date written as @2026-11-11. */
export const DATE_MENTION = /^@(\d{4}-\d{2}-\d{2})(?![\w-])/

type Options = {
  /** Turns a vault path like attachments/x.png into a URL. */
  fileUrl: (path: string) => string
}

/** Vault-relative paths (not URLs, not absolute) are attachments. */
export const isVaultPath = (src: string) => !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(src)

function decodePath(s: string) {
  try {
    return decodeURI(s)
  } catch {
    return s
  }
}

function build({ fileUrl }: Options) {
  const marked = new Marked({ gfm: true, breaks: false })
  const img = (src: string, alt: string, title?: string | null) => {
    const vault = isVaultPath(src)
    const path = vault ? decodePath(src) : src
    // ![alt|400](src): a width in pixels after the alt text, as Obsidian writes it,
    // and ![alt|right|400](src) or ![alt|left](src) to put the picture to one side.
    const m = /^(.*?)(?:\|(left|center|right))?(?:\|(\d{2,4}))?$/.exec(alt)
    const text = m?.[1] ?? alt
    const width = m?.[3] ? ` width="${m[3]}"` : ""
    const align = m?.[2] && m[2] !== "center" ? ` data-align="${m[2]}"` : ""
    return `<img src="${escape(vault ? fileUrl(path) : src)}" data-src="${escape(path)}" alt="${escape(text)}"${width}${align}${title ? ` title="${escape(title)}"` : ""}>`
  }
  /** <tag>…</tag> kept as formatting; any other HTML in a line shows as text. */
  const inlineTag = (name: string, tag: string, open: RegExp, html: (m: RegExpExecArray, inner: string) => string | undefined) => ({
    name,
    level: "inline" as const,
    start: (src: string) => {
      const i = src.search(open)
      return i < 0 ? undefined : i
    },
    tokenizer(this: TokenizerThis, src: string) {
      const m = new RegExp(`^${open.source}([\\s\\S]+?)</${tag}>`).exec(src)
      if (!m || html(m, "") === undefined) return undefined
      return { type: name, raw: m[0], m, tokens: this.lexer.inlineTokens(m[m.length - 1]) }
    },
    renderer(this: RendererThis, t: Tokens.Generic) {
      return html(t.m as RegExpExecArray, this.parser.parseInline(t.tokens ?? [])) ?? ""
    },
  })

  marked.use({
    extensions: [
      {
        // <details><summary>…</summary> … </details>: a toggle. GitHub renders it too.
        name: "toggle",
        level: "block",
        start: (src) => src.match(/^<details[\s>]/im)?.index,
        tokenizer(src) {
          const open = /^<details(\s+open)?\s*>/i.exec(src)
          if (!open) return undefined
          const re = /<\/?details\b[^>]*>/gi
          let depth = 0
          let end = -1
          for (let m = re.exec(src); m; m = re.exec(src)) {
            depth += m[0][1] === "/" ? -1 : 1
            if (depth === 0) {
              end = m.index
              break
            }
          }
          if (end < 0) return undefined
          const close = src.slice(end).match(/^<\/details>[ \t]*\n?/i)![0]
          let inner = src.slice(open[0].length, end)
          const sum = /^\s*<summary>([\s\S]*?)<\/summary>/i.exec(inner)
          if (sum) inner = inner.slice(sum[0].length)
          // <summary><h2>…</h2></summary>: a toggle heading.
          const head = sum && /^\s*<h([1-3])>([\s\S]*)<\/h\1>\s*$/i.exec(sum[1])
          return {
            type: "toggle",
            raw: src.slice(0, end + close.length),
            summary: head ? head[2].trim() : sum ? sum[1].trim() : "",
            level: head ? Number(head[1]) : 0,
            open: !!open[1],
            tokens: this.lexer.blockTokens(inner.trim(), []),
          }
        },
        renderer(t) {
          const { summary, level, open, tokens } = t as unknown as { summary: string; level: number; open: boolean; tokens: Tokens.Generic[] }
          const attrs = `data-summary="${escape(decodeEntities(summary))}"${level ? ` data-level="${level}"` : ""}${open ? ' data-open=""' : ""}`
          return `<div data-toggle="" ${attrs}>${this.parser.parse(tokens) || "<p></p>"}</div>`
        },
      },
      {
        // :::: columns / ::: column / ::: / ::::, Pandoc's fenced divs. Fences
        // pair up by nesting, whatever their length.
        name: "columns",
        level: "block",
        start: (src) => src.match(/^:{3,}[ \t]*columns[ \t]*$/m)?.index,
        tokenizer(src) {
          if (!/^:{3,}[ \t]*columns[ \t]*(?:\n|$)/.test(src)) return undefined
          const lines = src.split("\n")
          const cols: string[][] = []
          let cur: string[] | null = null
          let depth = 0
          let column = false
          let fence = ""
          let end = -1
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            const t = line.trim()
            const f = /^(`{3,}|~{3,})/.exec(t)
            if (fence) {
              if (f && t.startsWith(fence) && !t.replace(/^(`+|~+)/, "").trim()) fence = ""
            } else if (f) {
              fence = f[1]
            } else if (/^:{3,}[ \t]*[\w-]+$/.test(t)) {
              depth++
              if (depth === 1) continue
              if (depth === 2 && /^:+[ \t]*column$/.test(t)) {
                cols.push((cur = []))
                column = true
                continue
              }
            } else if (/^:{3,}$/.test(t)) {
              depth--
              if (depth === 0) {
                end = i
                break
              }
              if (depth === 1 && column) {
                cur = null
                column = false
                continue
              }
            }
            // Anything outside a column gets one of its own.
            if (!cur && t) cols.push((cur = []))
            cur?.push(line)
          }
          if (end < 0 || !cols.length) return undefined
          let length = lines.slice(0, end + 1).join("\n").length
          if (src[length] === "\n") length++
          return { type: "columns", raw: src.slice(0, length), cols: cols.map((c) => this.lexer.blockTokens(c.join("\n"), [])) }
        },
        renderer(t) {
          const { cols } = t as unknown as { cols: Tokens.Generic[][] }
          return `<div data-columns="">${cols.map((c) => `<div data-column="">${this.parser.parse(c) || "<p></p>"}</div>`).join("")}</div>`
        },
      },
      {
        // [TOC] on a line of its own: the page's table of contents.
        name: "toc",
        level: "block",
        start: (src) => src.match(/^\[TOC\][ \t]*$/m)?.index,
        tokenizer(src, tokens) {
          const m = /^\[TOC\][ \t]*(?:\n|$)/.exec(src)
          // A list item starts with text, so there it stays a line of text.
          if (!m || (!this.lexer.state.top && !tokens.length)) return undefined
          return { type: "toc", raw: m[0] }
        },
        renderer: () => `<div data-toc=""></div>`,
      },
      {
        // ![[Page]] or ![[Page#Heading]] on a line of its own shows that page here.
        name: "embed",
        level: "block",
        start: (src) => src.match(/^!\[\[[^[\]\n]+\]\][ \t]*$/m)?.index,
        tokenizer(src, tokens) {
          const m = /^!\[\[([^[\]\n|#^]+)(#[^[\]\n|]*)?(\|[^[\]\n]*)?\]\][ \t]*(?:\n|$)/.exec(src)
          // In a list item's first line it's a link in the text, not a block.
          if (!m || imageExt.test(m[1].trim()) || (!this.lexer.state.top && !tokens.length)) return undefined
          return { type: "embed", raw: m[0], target: m[1].trim(), heading: m[2]?.slice(1) ?? "", alias: m[3]?.slice(1) ?? "" }
        },
        renderer(t) {
          const { target, heading, alias } = t as unknown as { target: string; heading: string; alias: string }
          return `<div data-embed="" data-target="${escape(target)}" data-heading="${escape(heading)}" data-alias="${escape(alias)}"></div>`
        },
      },
      inlineTag("underline", "u", /<u>/, (_m, inner) => `<u>${inner}</u>`),
      inlineTag("textColor", "span", /<span data-color="([a-z]+)">/, (m, inner) => (isColor(m[1]) ? `<span data-color="${m[1]}">${inner}</span>` : undefined)),
      inlineTag("background", "mark", /<mark data-color="([a-z]+)">/, (m, inner) => (isColor(m[1]) ? `<mark data-color="${m[1]}">${inner}</mark>` : undefined)),
      {
        // @2026-11-11: a date, shown as a chip.
        name: "dateMention",
        level: "inline",
        start: (src) => {
          const i = src.search(/@\d{4}-\d{2}-\d{2}/)
          return i < 0 ? undefined : i
        },
        tokenizer(src, tokens) {
          const m = DATE_MENTION.exec(src)
          if (!m || /[\w@]$/.test((tokens as Tokens.Generic[]).at(-1)?.raw ?? "")) return undefined
          return { type: "dateMention", raw: m[0], date: m[1] }
        },
        renderer: (t) => `<span data-date="${(t as unknown as { date: string }).date}"></span>`,
      },
      {
        name: "mathBlock",
        level: "block",
        start: (src) => src.match(/^\$\$/m)?.index,
        tokenizer(src) {
          const m = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src)
          if (!m) return undefined
          return { type: "mathBlock", raw: m[0], latex: m[1].trim() }
        },
        renderer(t) {
          return `<div data-math-block="" data-latex="${escape((t as unknown as { latex: string }).latex)}"></div>`
        },
      },
      {
        name: "mathInline",
        level: "inline",
        start: (src) => {
          const i = src.indexOf("$")
          return i < 0 ? undefined : i
        },
        tokenizer(src) {
          const m = /^\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?!\d)/.exec(src)
          if (!m) return undefined
          return { type: "mathInline", raw: m[0], latex: m[1] }
        },
        renderer(t) {
          return `<span data-math-inline="" data-latex="${escape((t as unknown as { latex: string }).latex)}"></span>`
        },
      },
      {
        // {{ … }}: a formula worked out from databases (editor/formula.tsx).
        name: "formula",
        level: "inline",
        start: (src) => {
          const i = src.indexOf("{{")
          return i < 0 ? undefined : i
        },
        tokenizer(src) {
          const m = /^\{\{((?:[^{}\n]|\{[^{}\n]*\})+?)\}\}/.exec(src)
          if (!m) return undefined
          return { type: "formula", raw: m[0], expr: m[1] }
        },
        renderer(t) {
          return `<span data-formula="" data-expr="${escape((t as unknown as { expr: string }).expr)}"></span>`
        },
      },
      {
        // > [!type]± Title: the type as written (any case or alias), the
        // fold marker and the title are kept so the line saves back as it was.
        name: "callout",
        level: "block",
        start: (src) => src.match(/^> ?\[!/m)?.index,
        tokenizer(src) {
          const m = /^> ?\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*)\n?((?:>[^\n]*(?:\n|$))*)/.exec(src)
          if (!m) return undefined
          const inner = m[4].replace(/^> ?/gm, "")
          return { type: "callout", raw: m[0], kind: calloutType(m[1]), name: m[1], fold: m[2], title: m[3].trim(), tokens: this.lexer.blockTokens(inner, []) }
        },
        renderer(t) {
          const { kind, name, fold, title, tokens } = t as unknown as { kind: string; name: string; fold: string; title: string; tokens: Tokens.Generic[] }
          const attrs = `data-callout="${kind}" data-name="${escape(name)}" data-fold="${fold}" data-title="${escape(title)}"`
          return `<div ${attrs}>${this.parser.parse(tokens) || "<p></p>"}</div>`
        },
      },
      {
        name: "wikilink",
        level: "inline",
        start: (src) => {
          const i = src.indexOf("[[")
          return i < 0 ? undefined : src[i - 1] === "!" ? i - 1 : i
        },
        tokenizer(src) {
          const m = /^(!?)\[\[([^[\]\n|#^]+)(#[^[\]\n|]*)?(\|[^[\]\n]*)?\]\]/.exec(src)
          if (!m) return undefined
          return { type: "wikilink", raw: m[0], embed: !!m[1], target: m[2].trim(), heading: m[3]?.slice(1) ?? "", alias: m[4]?.slice(1) ?? "" }
        },
        renderer(t) {
          const { embed, target, heading, alias } = t as unknown as { embed: boolean; target: string; heading: string; alias: string }
          if (embed && imageExt.test(target)) return img(target.includes("/") ? target : `attachments/${target}`, alias || target)
          return `<a data-wikilink=""${embed ? ' data-embed=""' : ""} data-target="${escape(target)}" data-heading="${escape(heading)}" data-alias="${escape(alias)}">${escape(alias || target)}</a>`
        },
      },
      {
        name: "highlight",
        level: "inline",
        start: (src) => {
          const i = src.indexOf("==")
          return i < 0 ? undefined : i
        },
        tokenizer(src) {
          const m = /^==(?=\S)([^\n]*?\S)==/.exec(src)
          if (!m) return undefined
          return { type: "highlight", raw: m[0], tokens: this.lexer.inlineTokens(m[1]) }
        },
        renderer(t) {
          return `<mark>${this.parser.parseInline((t as Tokens.Generic).tokens ?? [])}</mark>`
        },
      },
    ],
    renderer: {
      // Without the trailing newline marked adds, which would show as a blank last line.
      code({ text, lang }) {
        const language = (lang ?? "").trim().split(/\s+/)[0]
        return `<pre><code${language ? ` class="language-${escape(language)}"` : ""}>${escape(text.replace(/\n$/, ""))}</code></pre>`
      },
      checkbox: () => "",
      // Pictures, video and audio are blocks in the editor, so one on a line
      // of its own (or in the middle of a sentence) stands outside the <p>;
      // inside it, the editor would leave an empty paragraph behind.
      paragraph({ tokens }) {
        const media = (t: Tokens.Generic) => t.type === "image" || (t.type === "wikilink" && t.embed && imageExt.test(t.target))
        if (!tokens.some(media)) return false
        let html = ""
        let run: Tokens.Generic[] = []
        const flush = () => {
          if (run.some((t) => t.raw.trim())) html += `<p>${this.parser.parseInline(run)}</p>\n`
          run = []
        }
        for (const t of tokens as Tokens.Generic[]) {
          if (!media(t)) run.push(t)
          else {
            flush()
            html += this.parser.parseInline([t]) + "\n"
          }
        }
        flush()
        return html
      },
      // A list can mix to-dos and plain items. Each run of one kind becomes a
      // list of its own, and lib/serialize.ts writes the runs back as one
      // list. Numbered lists with to-dos stay one to-do list.
      list(token) {
        if (!token.items.some((i) => i.task)) return false
        const runs: Tokens.ListItem[][] = []
        for (const item of token.items) {
          const run = runs.at(-1)
          if (run && (token.ordered || run[0].task === item.task)) run.push(item)
          else runs.push([item])
        }
        const task = (item: Tokens.ListItem) =>
          `<li data-type="taskItem" data-checked="${item.checked ? "true" : "false"}">${this.parser.parse(item.tokens.filter((t) => t.type !== "checkbox"))}</li>`
        return runs
          .map((run) =>
            token.ordered || run[0].task
              ? `<ul data-type="taskList">${run.map(task).join("")}</ul>`
              : `<ul>${run.map((item) => this.listitem(item)).join("")}</ul>`,
          )
          .join("")
      },
      // Links written as a bare URL or <url> are marked, so they save back
      // that way rather than as [url](url).
      link(token) {
        const html = Renderer.prototype.link.call(this, token)
        const form = token.raw.startsWith("<") ? "angle" : token.raw.startsWith("[") ? "" : "bare"
        return form ? html.replace(/^<a /, `<a data-autolink="${form}" `) : html
      },
      image({ href, title, text }) {
        return img(href, text, title)
      },
      // Raw HTML shows as text; pages that rely on it open in the source editor.
      html({ text }) {
        return escape(text)
      },
    },
  })
  return marked
}

function decodeEntities(s: string) {
  return new DOMParser().parseFromString(`<p>${s}</p>`, "text/html").body.textContent ?? ""
}

export function markdownToHtml(markdown: string, opts: Options) {
  const html = build(opts).parse(markdown, { async: false })
  return DOMPurify.sanitize(html, {
    ADD_ATTR: [
      "data-wikilink", "data-target", "data-heading", "data-alias", "data-callout", "data-type", "data-checked", "data-src",
      "data-toggle", "data-summary", "data-open", "data-math-block", "data-math-inline", "data-latex", "data-name", "data-fold",
      "data-title", "data-autolink", "data-formula", "data-expr", "data-level", "data-columns", "data-column", "data-toc", "data-embed",
      "data-color", "data-date",
    ],
  })
}

const FM_KEY = /^[A-Za-z_][\w-]*[ \t]*:([ \t]|$)/

/**
 * Splits leading YAML front matter off, so it survives visual editing. It's
 * only front matter when "---" is followed by a key (or the closing "---")
 * and every line up to the closing "---" looks like YAML; a page that merely
 * starts with a divider has none. Same rules as frontmatterBlock in the
 * backend's vault/markdown.go.
 */
export function splitFrontmatter(s: string): [string, string] {
  const lines = s.split(/(?<=\n)/)
  if (lines.length < 2 || lines[0].replace(/[ \t\r\n]+$/, "") !== "---") return ["", s]
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r?\n$/, "")
    if (line.replace(/[ \t]+$/, "") === "---") {
      const fm = lines.slice(0, i + 1).join("")
      return [fm.endsWith("\n") ? fm : fm + "\n", lines.slice(i + 1).join("")]
    }
    const yaml = FM_KEY.test(line) || (i > 1 && (line.trim() === "" || line.startsWith("- ") || /^[ \t#]/.test(line)))
    if (!yaml) break
  }
  return ["", s]
}

/** A top-level front matter key's value, without quotes; "" if it isn't set. */
export function frontmatterField(s: string, key: string) {
  const [fm] = splitFrontmatter(s)
  const m = new RegExp(`^${key}[ \\t]*:[ \\t]*(.*?)[ \\t]*\\r?$`, "im").exec(fm)
  return m ? m[1].replace(/^(["'])(.*)\1$/, "$2") : ""
}

/**
 * Sets a top-level front matter key, adding the block if the page has none,
 * or removes it when value is null (and the block with it, if it's left empty).
 * Other keys and everything after the block stay exactly as they were.
 */
export function setFrontmatterField(s: string, key: string, value: string | null) {
  const [fm, body] = splitFrontmatter(s)
  const existing = new RegExp(`^${key}[ \\t]*:.*$`, "im")
  if (value === null) {
    if (!existing.test(fm)) return s
    const rest = fm.replace(new RegExp(`^${key}[ \\t]*:.*(\\r?\\n|$)`, "im"), "")
    return (/^---[ \t]*\r?\n\s*---[ \t]*(\r?\n)?$/.test(rest) ? "" : rest) + body
  }
  const line = `${key}: ${value}`
  if (!fm) return `---\n${line}\n---\n${s}`
  if (existing.test(fm)) return fm.replace(existing, line) + body
  const eol = fm.includes("\r\n") ? "\r\n" : "\n"
  const close = /\r?\n---[ \t]*(\r?\n)?$/.exec(fm)!
  return fm.slice(0, close.index) + eol + line + fm.slice(close.index) + body
}

let lexer: Marked | undefined
let lastSource: { markdown: string; result: boolean } | undefined

/**
 * Markdown the visual editor can't keep: blocks of raw HTML (other than
 * <details> toggles), footnotes and reference-style links. Pages using it
 * open in the source editor so saving never drops anything. HTML inside a
 * line (Promise<void>, <kbd>) is shown and saved as the text it is.
 */
export function needsSource(markdown: string) {
  if (lastSource?.markdown === markdown) return lastSource.result
  lexer ??= build({ fileUrl: (p) => p })
  let html = false
  lexer.walkTokens(lexer.lexer(markdown), (t) => {
    if (t.type === "html" && (t as Tokens.HTML).block) html = true
  })
  const prose = markdown
    .replace(/^(```|~~~)[\s\S]*?^\1[ \t]*$/gm, "")
    .replace(/`[^`\n]*`/g, "")
  const result = html || /\[\^[^\]]+\]/.test(prose) || /^\s{0,3}\[[^\]]+\]:\s+\S/m.test(prose)
  lastSource = { markdown, result }
  return result
}
