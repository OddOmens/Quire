import { Extension } from "@tiptap/core"
import Image from "@tiptap/extension-image"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

import { containers } from "@/editor/blocks"
import { EMBED_SITES, embedFor, type Embed } from "@/editor/embeds"
import type { EnvRef } from "@/editor/extensions"
import { isMedia, isVaultPath, mediaKind } from "@/lib/markdown"

/** How a line that is only a web link shows: as text, a bookmark card, or the site's player. */
export type LinkCard = "link" | "bookmark" | "embed"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    media: {
      /** Turns the current line into a spot for a web bookmark: paste or type a link, then Enter. */
      startBookmark: () => ReturnType
      /** The same, for a video, song, design or document shown in place. */
      startEmbed: () => ReturnType
      /** Shows a line that is only a web link as a plain link, a bookmark card or an embed. */
      setLinkCard: (kind: LinkCard, pos?: number) => ReturnType
      /** Switches an attached PDF between a file card and a preview of its pages. */
      togglePdfPreview: (pos: number) => ReturnType
    }
  }
}

const MIN_WIDTH = 80

const fileName = (src: string) => decodeURIComponent(src.split(/[?#]/)[0].split("/").pop() ?? "")

/**
 * An attached PDF with its pages showing: ![name](attachments/x.pdf). The
 * browser's own viewer draws it, in a frame; a PDF somewhere else on the web
 * can't be framed, so it gets the name and the link only.
 */
function pdfPreview(src: string, url: string, alt: string) {
  const dom = document.createElement("figure")
  dom.className = "media-pdf"
  const bar = document.createElement("figcaption")
  const name = document.createElement("span")
  name.className = "media-pdf-name"
  name.textContent = alt || fileName(src) || "PDF"
  const open = document.createElement("a")
  open.href = url
  open.target = "_blank"
  open.rel = "noopener noreferrer"
  open.textContent = "Open"
  open.draggable = false
  bar.append(name, open)
  dom.append(bar)
  if (isVaultPath(src)) {
    const frame = document.createElement("iframe")
    // Fit the page to the frame's width, without the thumbnail strip.
    frame.src = `${url}#navpanes=0&view=FitH`
    frame.loading = "lazy"
    frame.title = name.textContent
    dom.append(frame)
  }
  return dom
}

/**
 * Pictures, video, audio and PDF previews keep their vault path
 * (attachments/x.png) in the document and load through the API. A picture
 * can be resized by its right edge (the width is saved after the alt text:
 * ![alt|400](x.png)), set to the left, centre or right (![alt|left|400]),
 * and its Markdown title shows as a caption under it.
 */
export const VaultImage = (env: EnvRef) =>
  Image.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        src: {
          default: null,
          parseHTML: (el) => el.getAttribute("data-src") ?? el.getAttribute("src"),
          renderHTML: (a) => {
            const src = String(a.src ?? "")
            return { src: isVaultPath(src) ? env.current.fileUrl(src) : src, "data-src": src }
          },
        },
        width: {
          default: null,
          parseHTML: (el) => Number(el.getAttribute("width")) || null,
          renderHTML: (a) => (a.width ? { width: a.width } : {}),
        },
        height: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
        // left or right; centred when unset.
        align: {
          default: null,
          parseHTML: (el) => (/^(left|right)$/.test(el.getAttribute("data-align") ?? "") ? el.getAttribute("data-align") : null),
          renderHTML: (a) => (a.align ? { "data-align": a.align } : {}),
        },
      }
    },
    addNodeView() {
      return ({ node, editor, getPos }) => {
        const src = String(node.attrs.src ?? "")
        const url = isVaultPath(src) ? env.current.fileUrl(src) : src
        const kind = mediaKind(src)
        if (kind === "pdf") return { dom: pdfPreview(src, url, String(node.attrs.alt ?? "")), ignoreMutation: () => true }
        if (kind !== "image") {
          // Stored like pictures (![](attachments/clip.mp4)), played in place.
          const player = document.createElement(kind)
          player.src = url
          player.controls = true
          player.preload = "metadata"
          player.className = `media-${kind}`
          return { dom: player }
        }

        let current = node
        const dom = document.createElement("figure")
        dom.className = "media-image"
        const img = document.createElement("img")
        img.src = url
        img.loading = "lazy"
        img.draggable = false
        const grip = document.createElement("span")
        grip.className = "media-resize"
        grip.setAttribute("aria-hidden", "true")
        // A textarea, so a long caption wraps instead of running off the edge.
        const caption = document.createElement("textarea")
        caption.rows = 1
        caption.className = "media-caption"
        caption.placeholder = "Add a caption"
        caption.setAttribute("aria-label", "Caption")
        dom.append(img, grip, caption)

        const show = () => {
          img.alt = current.attrs.alt ?? ""
          const width = Number(current.attrs.width) || 0
          img.style.width = width ? `${width}px` : ""
          const title = String(current.attrs.title ?? "")
          if (caption.value !== title) caption.value = title
          dom.classList.toggle("has-caption", !!title)
          dom.dataset.align = current.attrs.align ?? "center"
          fit()
        }
        const fit = () => {
          caption.style.height = "auto"
          if (caption.scrollHeight) caption.style.height = `${caption.scrollHeight}px`
        }
        // The caption's width is the picture's, known once it has loaded.
        img.addEventListener("load", fit)
        show()

        const setAttrs = (attrs: Record<string, unknown>) => {
          const pos = getPos()
          if (pos === undefined) return
          editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...attrs }))
        }

        // A click or tap on the picture selects it, which shows its toolbar.
        // The editor doesn't see this press (stopEvent), so it can't put the
        // cursor beside the picture instead.
        img.addEventListener("mousedown", (e) => {
          const pos = getPos()
          if (e.button !== 0 || pos === undefined || !editor.isEditable) return
          e.preventDefault()
          editor.chain().focus().setNodeSelection(pos).run()
        })
        caption.addEventListener("focus", () => (caption.readOnly = !editor.isEditable))
        caption.addEventListener("input", () => {
          fit()
          // A caption is one line in Markdown: pasted line breaks become spaces.
          if (editor.isEditable) setAttrs({ title: caption.value.replace(/\s*\n\s*/g, " ") || null })
        })
        caption.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" && e.key !== "Escape") return
          e.preventDefault()
          const pos = getPos()
          if (pos !== undefined) editor.chain().focus().setTextSelection(pos + current.nodeSize).run()
        })

        // Drag the right edge to resize; double-click it for the natural size.
        grip.addEventListener("pointerdown", (e) => {
          if (e.button !== 0 || !editor.isEditable) return
          e.preventDefault()
          const startX = e.clientX
          const startW = img.getBoundingClientRect().width
          const max = dom.parentElement?.getBoundingClientRect().width ?? startW
          let width = startW
          const move = (ev: PointerEvent) => {
            width = Math.round(Math.max(MIN_WIDTH, Math.min(max, startW + (ev.clientX - startX))))
            img.style.width = `${width}px`
          }
          const up = () => {
            window.removeEventListener("pointermove", move)
            window.removeEventListener("pointerup", up)
            window.removeEventListener("pointercancel", up)
            dom.classList.remove("is-resizing")
            if (Math.abs(width - startW) >= 1) setAttrs({ width })
          }
          dom.classList.add("is-resizing")
          window.addEventListener("pointermove", move)
          window.addEventListener("pointerup", up)
          window.addEventListener("pointercancel", up)
        })
        grip.addEventListener("dblclick", () => editor.isEditable && setAttrs({ width: null }))

        return {
          dom,
          update(next: PMNode) {
            if (next.type !== current.type || next.attrs.src !== current.attrs.src) return false
            current = next
            show()
            return true
          },
          stopEvent: (e: Event) => e.target === caption || e.target === grip || (e.type === "mousedown" && e.target === img && editor.isEditable),
          ignoreMutation: () => true,
        }
      }
    },
  }).configure({ inline: false, allowBase64: false })

/** example.com/some/page for https://example.com/some/page/ */
const pretty = (url: string) => url.replace(/^[a-z][a-z0-9+.-]*:\/\/(www\.)?/i, "").replace(/[/?#]+$/, "")

const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "")
  } catch {
    return ""
  }
}

/** A web address someone would paste: one word, http(s) or a bare domain. */
function asUrl(text: string) {
  const t = text.trim()
  if (!t || /\s/.test(t)) return ""
  if (/^https?:\/\/\S+\.\S+/i.test(t)) return t
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(t) ? `https://${t}` : ""
}

/** The link a paragraph consists of, if it's nothing but one link. */
function onlyLink(node: PMNode) {
  if (node.type.name !== "paragraph" || node.childCount !== 1 || !node.firstChild!.isText) return null
  const marks = node.firstChild!.marks
  return marks.length === 1 && marks[0].type.name === "link" ? marks[0] : null
}

/** How a line that is only a web link is showing, and whether its site can be embedded. */
export function linkCardOf(node: PMNode): { kind: LinkCard; href: string; embeddable: boolean } | null {
  const link = onlyLink(node)
  const href = String(link?.attrs.href ?? "")
  if (!link || !/^https?:/i.test(href)) return null
  const embeddable = !!embedFor(href)
  const title = link.attrs.title
  return { kind: title === "embed" && embeddable ? "embed" : title === "bookmark" || title === "embed" ? "bookmark" : "link", href, embeddable }
}

/** Whether a block is an attached PDF, as a file card or as a preview. */
export function pdfBlockOf(node: PMNode): "card" | "preview" | null {
  if (node.type.name === "image") return isVaultPath(String(node.attrs.src ?? "")) && mediaKind(String(node.attrs.src)) === "pdf" ? "preview" : null
  const href = String(onlyLink(node)?.attrs.href ?? "")
  return isVaultPath(href) && /\.pdf$/i.test(href) ? "card" : null
}

type Preview = { title?: string; description?: string; site?: string; image?: string; icon?: string }

/**
 * What the server has said about bookmarked pages, shared by every editor on
 * the page. undefined: not asked; null: asked, no answer yet.
 */
const previews = new Map<string, Preview | null>()
const previewWatchers = new Set<(url: string) => void>()

function askPreview(url: string, ask: (url: string) => Promise<Preview | undefined>) {
  if (previews.has(url)) return
  previews.set(url, null)
  ask(url)
    .catch(() => undefined)
    .then((pv) => {
      previews.set(url, pv ?? {})
      for (const w of previewWatchers) w(url)
    })
}

type Pending = { pos: number; kind: "bookmark" | "embed" }
const pendingKey = new PluginKey<Pending | null>("bookmarkPending")
const cardsKey = new PluginKey("blockCards")

function cardTr(state: EditorState, pending: Pending, url: string): Transaction {
  const { schema } = state
  const { pos } = pending
  const para = state.doc.nodeAt(pos)!
  const kind = pending.kind === "embed" && embedFor(url) ? "embed" : "bookmark"
  const link = schema.marks.link.create({ href: url, title: kind })
  const tr = state.tr.replaceWith(pos + 1, pos + para.nodeSize - 1, schema.text(pretty(url), [link]))
  const end = tr.mapping.map(pos + para.nodeSize)
  tr.insert(end, schema.nodes.paragraph.create())
  tr.setSelection(TextSelection.create(tr.doc, end + 1))
  return tr.setMeta(pendingKey, null).setMeta(cardsKey, { name: url }).scrollIntoView()
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
  const e = document.createElement(tag)
  e.className = className
  if (text) e.textContent = text
  return e
}

/** A picture from another site: no referrer, and gone if it doesn't load. */
function remoteImage(className: string, src: string) {
  const img = el("img", className)
  img.referrerPolicy = "no-referrer"
  img.loading = "lazy"
  img.decoding = "async"
  img.alt = ""
  img.draggable = false
  img.addEventListener("error", () => {
    if (className === "bookmark-image") img.closest("p")?.classList.remove("has-image")
    img.remove()
  })
  img.src = src
  return img
}

/** The rest of a bookmark card, under its title: description, site and picture. */
function bookmarkDetails(href: string, pv: Preview) {
  const box = el("span", "bookmark-details")
  if (pv.description) box.append(el("span", "bookmark-desc", pv.description))
  const site = el("span", "bookmark-site")
  if (pv.icon) site.append(remoteImage("bookmark-icon", pv.icon))
  site.append(el("span", "", pv.site ? `${pv.site} · ${pretty(href)}` : pretty(href)))
  box.append(site)
  if (pv.image) box.append(remoteImage("bookmark-image", pv.image))
  return box
}

/** The player or viewer of an embed, above its caption. */
function embedFrame(e: Embed) {
  const box = el("span", "embed-frame")
  if (e.ratio) box.style.aspectRatio = String(e.ratio)
  if (e.height) box.style.height = `${e.height}px`
  if (e.maxWidth) box.style.maxWidth = `${e.maxWidth}px`
  const frame = document.createElement("iframe")
  frame.loading = "lazy"
  frame.title = e.provider
  frame.allow = "fullscreen; picture-in-picture; encrypted-media"
  frame.allowFullscreen = true
  // The frame can run its player and open links in new tabs, but can't take over this tab.
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-presentation")
  frame.referrerPolicy = e.needsOrigin ? "strict-origin" : "no-referrer"
  frame.src = e.src
  box.append(frame)
  return box
}

/**
 * Lines that are a single link, shown as cards:
 *  - [[Page]] alone: a page row, like a sub-page;
 *  - a link to an attached file: a file card;
 *  - [Title](https://… "bookmark"): a web bookmark. The server reads the page
 *    once for its title, description and picture (env.linkPreview);
 *  - [Title](https://… "embed"): the site's player or viewer in a frame, for
 *    the sites in embeds.ts.
 * They stay ordinary Markdown links.
 */
export const BlockCards = (env: EnvRef) =>
  Extension.create({
    name: "blockCards",
    priority: 200,
    addCommands() {
      const start =
        (kind: Pending["kind"]) =>
        () =>
        ({ state, tr, dispatch }: { state: EditorState; tr: Transaction; dispatch?: (tr: Transaction) => void }) => {
          const { $from } = state.selection
          if ($from.parent.type.name !== "paragraph" || $from.parent.content.size) return false
          if (dispatch) tr.setMeta(pendingKey, { pos: $from.before(), kind })
          return true
        }
      return {
        startBookmark: start("bookmark"),
        startEmbed: start("embed"),
        setLinkCard:
          (kind, at) =>
          ({ state, tr, dispatch }) => {
            const pos = at ?? (state.selection.$from.depth ? state.selection.$from.before() : -1)
            const node = pos >= 0 ? state.doc.nodeAt(pos) : null
            const link = node && onlyLink(node)
            const card = node && linkCardOf(node)
            if (!node || !link || !card || (kind === "embed" && !card.embeddable)) return false
            if (dispatch) {
              const mark = link.type.create({ ...link.attrs, title: kind === "link" ? null : kind, autolink: null })
              const text = node.textContent
              const bare = text === card.href
              tr.replaceWith(pos + 1, pos + node.nodeSize - 1, state.schema.text(kind !== "link" && bare ? pretty(text) : text, [mark]))
              if (kind !== "link" && (bare || text === pretty(card.href))) tr.setMeta(cardsKey, { name: card.href })
            }
            return true
          },
        togglePdfPreview:
          (pos) =>
          ({ state, tr, dispatch }) => {
            const node = state.doc.nodeAt(pos)
            const now = node && pdfBlockOf(node)
            if (!node || !now) return false
            if (dispatch) {
              const { schema } = state
              if (now === "card") {
                const href = String(onlyLink(node)!.attrs.href)
                tr.replaceWith(pos, pos + node.nodeSize, schema.nodes.image.create({ src: href, alt: node.textContent.replace(/\.pdf$/i, "") }))
              } else {
                const src = String(node.attrs.src)
                const name = fileName(src)
                const alt = String(node.attrs.alt ?? "")
                const text = !alt ? name : /\.pdf$/i.test(alt) ? alt : `${alt}.pdf`
                tr.replaceWith(pos, pos + node.nodeSize, schema.nodes.paragraph.create(null, schema.text(text || "PDF", [schema.marks.link.create({ href: src })])))
              }
            }
            return true
          },
      }
    },
    addProseMirrorPlugins() {
      let last: { doc: PMNode; seen: number; set: DecorationSet } | null = null
      // Bumped when a preview arrives, so the cards are drawn again.
      let seen = 0
      // Cards made in this editor whose text is still their address: they take the page's title when it's known.
      const unnamed = new Set<string>()
      return [
        new Plugin({
          key: cardsKey,
          state: {
            init: () => 0,
            apply(tr, n) {
              const meta = tr.getMeta(cardsKey) as { name?: string; loaded?: boolean } | undefined
              if (meta?.name) unnamed.add(meta.name)
              return meta?.loaded ? n + 1 : n
            },
          },
          view(view) {
            const wanted = () => {
              const ask = env.current.linkPreview
              if (!ask) return
              view.state.doc.descendants((node) => {
                if (node.type.name !== "paragraph") return !node.isTextblock && !node.isAtom
                const card = linkCardOf(node)
                if (card && (card.kind === "bookmark" || (card.kind === "embed" && unnamed.has(card.href)))) askPreview(card.href, ask)
                return false
              })
            }
            // Gives a card made a moment ago the title of its page, unless its text was changed meanwhile.
            const name = (url: string) => {
              const title = previews.get(url)?.title
              if (!unnamed.delete(url) || !title || !view.editable) return
              const { state } = view
              const tr = state.tr
              state.doc.descendants((node, pos) => {
                if (node.type.name !== "paragraph") return !node.isTextblock && !node.isAtom
                const card = linkCardOf(node)
                if (card && card.kind !== "link" && card.href === url && node.textContent === pretty(url)) {
                  const at = tr.mapping.map(pos)
                  tr.replaceWith(at + 1, at + node.nodeSize - 1, state.schema.text(title, node.firstChild!.marks))
                }
                return false
              })
              if (tr.docChanged) view.dispatch(tr.setMeta("addToHistory", false))
            }
            const onPreview = (url: string) => {
              if (view.isDestroyed) return
              seen++
              view.dispatch(view.state.tr.setMeta(cardsKey, { loaded: true }).setMeta("addToHistory", false))
              name(url)
            }
            previewWatchers.add(onPreview)
            wanted()
            return {
              update(v, prev) {
                if (prev.doc === v.state.doc) return
                wanted()
                // A page already read (bookmarked elsewhere) names a new card at once.
                for (const url of unnamed) if (previews.get(url)) queueMicrotask(() => view.isDestroyed || name(url))
              },
              destroy: () => void previewWatchers.delete(onPreview),
            }
          },
          props: {
            decorations(state) {
              if (last?.doc === state.doc && last.seen === seen) return last.set
              const decos: Decoration[] = []
              state.doc.descendants((node, pos, parent) => {
                if (node.type.name !== "paragraph") return !node.isTextblock && !node.isAtom
                if (node.childCount !== 1 || !parent || !containers.has(parent.type.name)) return false
                const child = node.firstChild!
                const link = onlyLink(node)
                const href = String(link?.attrs.href ?? "")
                const card = link ? linkCardOf(node) : null
                const end = pos + node.nodeSize
                if (child.type.name === "pageLink" && !child.attrs.embed) {
                  decos.push(Decoration.node(pos, end, { class: "page-row" }))
                } else if (link && isVaultPath(href) && !isMedia(href)) {
                  const ext = /\.([a-z0-9]{1,5})$/i.exec(href)?.[1] ?? ""
                  decos.push(Decoration.node(pos, end, { class: "file-card", "data-ext": ext.toUpperCase() || "FILE", "data-kind": ext.toLowerCase() === "pdf" ? "pdf" : "file" }))
                } else if (card?.kind === "embed") {
                  const e = embedFor(href)!
                  decos.push(Decoration.node(pos, end, { class: "embed-card", "data-provider": e.provider }))
                  decos.push(Decoration.widget(pos + 1, () => embedFrame(e), { side: -1, key: `embed:${e.src}`, ignoreSelection: true }))
                } else if (card?.kind === "bookmark") {
                  const pv = previews.get(href)
                  const rich = !!pv && !!(pv.title || pv.description || pv.image)
                  decos.push(Decoration.node(pos, end, { class: rich ? `bookmark has-details${pv.image ? " has-image" : ""}` : "bookmark", "data-host": hostOf(href), "data-url": pretty(href) }))
                  if (rich) decos.push(Decoration.widget(end - 1, () => bookmarkDetails(href, pv), { side: 1, key: `bookmark:${href}:${JSON.stringify(pv)}`, ignoreSelection: true }))
                }
                return false
              })
              last = { doc: state.doc, seen, set: DecorationSet.create(state.doc, decos) }
              return last.set
            },
            // A click on a card's icon, details or edge opens it; on its text, it places the cursor as usual.
            handleClick(_view, _pos, event) {
              const target = event.target as HTMLElement
              const card = target.closest?.<HTMLElement>("p.file-card, p.bookmark")
              if (!card || target.closest("a") || !(target === card || target.closest(".bookmark-details"))) return false
              const href = card.querySelector("a[href]")?.getAttribute("href")
              if (!href) return false
              window.open(href, "_blank", "noopener,noreferrer")
              return true
            },
          },
        }),
        new Plugin<Pending | null>({
          key: pendingKey,
          state: {
            init: () => null,
            apply(tr, value) {
              const meta = tr.getMeta(pendingKey) as Pending | null | undefined
              if (meta !== undefined) return meta
              if (value === null) return null
              const pos = tr.mapping.map(value.pos)
              const $from = tr.selection.$from
              return $from.depth && $from.before() === pos && $from.parent.type.name === "paragraph" ? { ...value, pos } : null
            },
          },
          props: {
            decorations(state) {
              const pending = pendingKey.getState(state)
              const node = pending ? state.doc.nodeAt(pending.pos) : null
              if (!pending || !node) return null
              const hint = pending.kind === "embed" ? `Paste a link from ${EMBED_SITES}, then press Enter` : "Paste or type a link, then press Enter"
              return DecorationSet.create(state.doc, [Decoration.node(pending.pos, pending.pos + node.nodeSize, { class: `bookmark-pending is-${pending.kind}`, "data-hint": hint })])
            },
            handleKeyDown(view, event) {
              const pending = pendingKey.getState(view.state)
              if (!pending || event.key !== "Enter" || event.shiftKey) return false
              const url = asUrl(view.state.doc.nodeAt(pending.pos)?.textContent ?? "")
              if (!url) return false
              view.dispatch(cardTr(view.state, pending, url))
              return true
            },
            handlePaste(view, event) {
              const pending = pendingKey.getState(view.state)
              if (!pending) return false
              const url = asUrl(event.clipboardData?.getData("text/plain") ?? "")
              if (!url) return false
              view.dispatch(cardTr(view.state, pending, url))
              return true
            },
          },
        }),
      ]
    },
  })
