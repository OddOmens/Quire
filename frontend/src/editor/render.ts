/** KaTeX and Mermaid load on first use, so pages without them stay light. */

let katexLoad: Promise<typeof import("katex")> | null = null

export async function renderMath(el: HTMLElement, latex: string, displayMode: boolean) {
  katexLoad ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([k]) => k)
  const katex = (await katexLoad).default
  katex.render(latex || "\\square", el, { throwOnError: false, displayMode, trust: false, strict: "ignore" })
}

let mermaidLoad: Promise<typeof import("mermaid")["default"]> | null = null
let mermaidTheme = ""
let seq = 0

/** Renders a Mermaid diagram to SVG. Strict mode keeps diagrams from running script or loading links. */
export async function renderMermaid(code: string, dark: boolean): Promise<string> {
  mermaidLoad ??= import("mermaid").then((m) => m.default)
  const mermaid = await mermaidLoad
  const theme = dark ? "dark" : "neutral"
  if (theme !== mermaidTheme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme, fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif" })
    mermaidTheme = theme
  }
  const { svg } = await mermaid.render(`quire-mermaid-${++seq}`, code)
  return svg
}
