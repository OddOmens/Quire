import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force"
import { Maximize2, Network } from "lucide-react"
import { useTheme } from "next-themes"
import { Navigate, useNavigate, useParams } from "react-router"

import { Page } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { useCurrentSpace } from "@/hooks/use-vault"
import { pageUrl, spaceGraphUrl } from "@/lib/notes"

type Node = SimulationNodeDatum & { id: string; title: string; group: string; links: number; r: number }
type Edge = SimulationLinkDatum<Node>

const PALETTE = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"]

/** /graph from older links: the graph of the space you were last in. */
export function GraphRedirect() {
  const space = useCurrentSpace()
  return <Navigate to={space ? spaceGraphUrl(space) : "/"} replace />
}

// The graph keeps to one space; pages are coloured by the top-level page
// they sit under.
export default function GraphPage() {
  const { space = "" } = useParams()
  const { data } = useQuery({ queryKey: ["graph", space], queryFn: () => api.graph(space), enabled: !!space })
  const navigate = useNavigate()
  const { resolvedTheme } = useTheme()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<() => void>(() => {})
  const [colors, setColors] = useState<Record<string, string>>({})

  const groups = useMemo(() => {
    const g = new Map<string, number>()
    for (const n of data?.nodes ?? []) {
      const top = n.folder.split("/")[1]
      if (top) g.set(top, (g.get(top) ?? 0) + 1)
    }
    return [...g.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
  }, [data])

  useEffect(() => {
    if (!data || !canvasRef.current || !wrapRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext("2d")!
    const css = getComputedStyle(document.documentElement)
    const v = (name: string) => css.getPropertyValue(name).trim()
    const groupColor = new Map(groups.map((g, i) => [g, v(PALETTE[i % PALETTE.length])]))
    const muted = v("--muted-foreground")
    setColors(Object.fromEntries(groupColor))
    const fg = v("--foreground")
    const bg = v("--background")
    const brand = v("--brand")
    const line = v("--border")

    const nodes: Node[] = data.nodes.map((n) => ({
      id: n.path,
      title: n.title,
      group: n.folder.split("/")[1] ?? "",
      links: n.links,
      r: 3.5 + Math.sqrt(n.links) * 2.2,
    }))
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const edges: Edge[] = data.edges.map((e) => ({ source: byId.get(e.source)!, target: byId.get(e.target)! }))
    const neighbors = new Map<string, Set<string>>()
    for (const e of data.edges) {
      if (!neighbors.has(e.source)) neighbors.set(e.source, new Set())
      if (!neighbors.has(e.target)) neighbors.set(e.target, new Set())
      neighbors.get(e.source)!.add(e.target)
      neighbors.get(e.target)!.add(e.source)
    }

    let width = 0
    let height = 0
    const view = { x: 0, y: 0, k: 1 }
    let hover: Node | null = null
    let drag: { node: Node | null; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null = null

    const sim = forceSimulation(nodes)
      .force("link", forceLink<Node, Edge>(edges).id((d) => d.id).distance(70).strength(0.5))
      .force("charge", forceManyBody().strength(-220))
      .force("center", forceCenter(0, 0))
      .force("collide", forceCollide<Node>().radius((d) => d.r + 6))
      .force("x", forceX(0).strength(0.06))
      .force("y", forceY(0).strength(0.06))

    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, width, height)
      ctx.translate(width / 2 + view.x, height / 2 + view.y)
      ctx.scale(view.k, view.k)

      const near = hover ? neighbors.get(hover.id) ?? new Set<string>() : null
      const lit = (n: Node) => !hover || n === hover || near!.has(n.id)

      for (const e of edges) {
        const s = e.source as Node
        const t = e.target as Node
        const on = hover && (s === hover || t === hover)
        ctx.globalAlpha = hover ? (on ? 0.9 : 0.12) : 0.7
        ctx.strokeStyle = on ? brand : line
        ctx.lineWidth = (on ? 1.6 : 1) / Math.sqrt(view.k)
        ctx.beginPath()
        ctx.moveTo(s.x!, s.y!)
        ctx.lineTo(t.x!, t.y!)
        ctx.stroke()
      }

      for (const n of nodes) {
        ctx.globalAlpha = lit(n) ? 1 : 0.18
        const c = groupColor.get(n.group) ?? muted
        if (n === hover) {
          ctx.beginPath()
          ctx.arc(n.x!, n.y!, n.r + 5, 0, Math.PI * 2)
          ctx.fillStyle = c
          ctx.globalAlpha = 0.18
          ctx.fill()
          ctx.globalAlpha = 1
        }
        ctx.beginPath()
        ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2)
        ctx.fillStyle = c
        ctx.fill()
        ctx.lineWidth = 1.5 / view.k
        ctx.strokeStyle = bg
        ctx.stroke()
      }

      ctx.textAlign = "center"
      ctx.textBaseline = "top"
      for (const n of nodes) {
        const show = hover ? lit(n) : nodes.length <= 60 || view.k > 1.15 || n.links >= 4
        if (!show) continue
        const size = Math.round(((n === hover ? 13 : 11.5) / Math.max(view.k, 0.8)) * 2) / 2
        ctx.font = `${n === hover ? 600 : 500} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`
        ctx.globalAlpha = hover && !lit(n) ? 0.2 : n === hover ? 1 : 0.78
        ctx.lineWidth = 3 / view.k
        ctx.strokeStyle = bg
        ctx.strokeText(n.title, n.x!, n.y! + n.r + 4 / view.k)
        ctx.fillStyle = fg
        ctx.fillText(n.title, n.x!, n.y! + n.r + 4 / view.k)
      }
      ctx.globalAlpha = 1
    }

    const resize = () => {
      const rect = wrapRef.current!.getBoundingClientRect()
      width = rect.width
      height = rect.height
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      draw()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(wrapRef.current)
    sim.on("tick", draw)

    const fit = () => {
      if (!nodes.length) return
      const xs = nodes.map((n) => n.x!)
      const ys = nodes.map((n) => n.y!)
      const w = Math.max(...xs) - Math.min(...xs) + 120
      const h = Math.max(...ys) - Math.min(...ys) + 120
      view.k = Math.min(2, Math.max(0.2, Math.min(width / w, height / h)))
      view.x = -((Math.max(...xs) + Math.min(...xs)) / 2) * view.k
      view.y = -((Math.max(...ys) + Math.min(...ys)) / 2) * view.k
      draw()
    }
    fitRef.current = fit
    // Settle the layout before the first frame, so it opens framed rather
    // than exploding out of the centre.
    sim.stop()
    sim.tick(Math.min(300, 60 + nodes.length))
    resize()
    fit()
    sim.alpha(0.08).restart()

    const toWorld = (ex: number, ey: number) => {
      const rect = canvas.getBoundingClientRect()
      return { x: (ex - rect.left - width / 2 - view.x) / view.k, y: (ey - rect.top - height / 2 - view.y) / view.k }
    }
    const hit = (ex: number, ey: number) => {
      const p = toWorld(ex, ey)
      let best: Node | null = null
      let bestD = Infinity
      for (const n of nodes) {
        const d = Math.hypot(n.x! - p.x, n.y! - p.y)
        if (d < n.r + 6 / view.k && d < bestD) {
          best = n
          bestD = d
        }
      }
      return best
    }

    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId)
      const node = hit(e.clientX, e.clientY)
      drag = { node, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false }
      if (node) {
        node.fx = node.x
        node.fy = node.y
      }
    }
    const onMove = (e: PointerEvent) => {
      if (!drag) {
        const h = hit(e.clientX, e.clientY)
        if (h !== hover) {
          hover = h
          canvas.style.cursor = h ? "pointer" : "grab"
          draw()
        }
        return
      }
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 3) drag.moved = true
      if (drag.node) {
        const p = toWorld(e.clientX, e.clientY)
        drag.node.fx = p.x
        drag.node.fy = p.y
        sim.alphaTarget(0.25).restart()
      } else {
        view.x = drag.vx + e.clientX - drag.sx
        view.y = drag.vy + e.clientY - drag.sy
        canvas.style.cursor = "grabbing"
        draw()
      }
    }
    const onUp = () => {
      if (!drag) return
      const { node, moved } = drag
      drag = null
      canvas.style.cursor = hover ? "pointer" : "grab"
      if (node) {
        node.fx = null
        node.fy = null
        sim.alphaTarget(0)
        if (!moved) navigate(pageUrl(node.id))
      }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left - width / 2
      const my = e.clientY - rect.top - height / 2
      const k = Math.min(4, Math.max(0.15, view.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))))
      view.x = mx - ((mx - view.x) * k) / view.k
      view.y = my - ((my - view.y) * k) / view.k
      view.k = k
      draw()
    }
    const onLeave = () => {
      if (hover && !drag) {
        hover = null
        draw()
      }
    }

    canvas.addEventListener("pointerdown", onDown)
    canvas.addEventListener("pointermove", onMove)
    canvas.addEventListener("pointerup", onUp)
    canvas.addEventListener("pointerleave", onLeave)
    canvas.addEventListener("wheel", onWheel, { passive: false })
    canvas.style.cursor = "grab"
    return () => {
      sim.stop()
      ro.disconnect()
      canvas.removeEventListener("pointerdown", onDown)
      canvas.removeEventListener("pointermove", onMove)
      canvas.removeEventListener("pointerup", onUp)
      canvas.removeEventListener("pointerleave", onLeave)
      canvas.removeEventListener("wheel", onWheel)
    }
  }, [data, groups, navigate, resolvedTheme])

  return (
    <Page
      header={
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Network className="size-4 text-muted-foreground" /> Graph
          <span className="text-muted-foreground">· {space}</span>
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {data ? `${data.nodes.length} notes · ${data.edges.length} links` : ""}
          </span>
        </span>
      }
      className="overflow-hidden"
    >
      <div ref={wrapRef} className="relative h-full w-full touch-none">
        <canvas ref={canvasRef} className="absolute inset-0" />
        <div className="pointer-events-none absolute inset-x-4 bottom-4 flex items-end justify-between gap-4">
          <div className="pointer-events-auto flex max-w-[70%] flex-wrap gap-x-3 gap-y-1.5 rounded-xl border bg-background/80 px-3 py-2 text-xs backdrop-blur">
            {groups.length ? (
              groups.map((g) => (
                <span key={g} className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: colors[g] }} /> {g}
                </span>
              ))
            ) : (
              <span className="text-muted-foreground">Link notes with [[ ]] to see them connect.</span>
            )}
            {groups.length > 0 && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-full bg-muted-foreground" /> top level
              </span>
            )}
          </div>
          <Button size="icon-sm" variant="outline" className="pointer-events-auto bg-background/80 backdrop-blur" onClick={() => fitRef.current()} aria-label="Fit to screen">
            <Maximize2 />
          </Button>
        </div>
      </div>
    </Page>
  )
}
