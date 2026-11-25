/**
 * Stands in for markdown-it (see vite.config.ts). prosemirror-markdown
 * constructs a default Markdown parser around it on import; nothing in Quire
 * ever asks that parser to parse.
 */
export default function MarkdownIt() {
  return {}
}
