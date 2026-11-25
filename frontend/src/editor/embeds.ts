/**
 * Turns a link someone would copy from their browser's address bar into the
 * address of that site's player or viewer, for the Embed block. Only the
 * sites here can be shown in a frame: the server's Content-Security-Policy
 * (embedHosts in backend/internal/server/server.go) lists the same hosts.
 */

export type Embed = {
  /** The site's name, as shown on the card. */
  provider: string
  /** The address the frame loads. */
  src: string
  /** Width over height, for pictures that scale (video, boards, slides). */
  ratio?: number
  /** A fixed height in pixels, for players and documents. */
  height?: number
  /** The widest the frame should get, in pixels (upright video). */
  maxWidth?: number
  /** Whether the player needs to be told which site it's on (YouTube refuses to play otherwise). */
  needsOrigin?: boolean
}

/** Every host a frame may point at. Kept in step with the server by embeds.test.ts. */
export const EMBED_HOSTS = [
  "www.youtube-nocookie.com",
  "player.vimeo.com",
  "www.loom.com",
  "open.spotify.com",
  "w.soundcloud.com",
  "embed.music.apple.com",
  "embed.podcasts.apple.com",
  "www.figma.com",
  "codepen.io",
  "codesandbox.io",
  "docs.google.com",
  "drive.google.com",
  "www.google.com",
  "miro.com",
  "airtable.com",
] as const

const ID = "[\\w-]+"
const path = (re: string) => new RegExp(`^/${re}/?$`)

/** "1h2m3s", "90s" or "90" as seconds. */
function seconds(t: string | null) {
  if (!t) return 0
  if (/^\d+$/.test(t)) return Number(t)
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t)
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0
}

function youtube(u: URL, host: string): Embed | null {
  if (!/^(youtube\.com|m\.youtube\.com|music\.youtube\.com|youtube-nocookie\.com|youtu\.be)$/.test(host)) return null
  const q = u.searchParams
  let id = ""
  let upright = false
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0]
  else if (u.pathname === "/watch") id = q.get("v") ?? ""
  else {
    const m = /^\/(embed|shorts|live|v)\/([^/]+)/.exec(u.pathname)
    if (m && m[2] !== "videoseries") id = m[2]
    upright = m?.[1] === "shorts"
  }
  const list = q.get("list") ?? ""
  if (!/^[\w-]{6,20}$/.test(id)) id = ""
  if (!id && !/^[\w-]{10,64}$/.test(list)) return null
  const out = new URLSearchParams()
  if (!id || (list && u.pathname === "/playlist")) out.set("list", list)
  const start = seconds(q.get("t") ?? q.get("start"))
  if (start) out.set("start", String(start))
  const query = out.toString()
  return {
    provider: "YouTube",
    src: `https://www.youtube-nocookie.com/embed/${id || "videoseries"}${query ? `?${query}` : ""}`,
    ratio: upright ? 9 / 16 : 16 / 9,
    maxWidth: upright ? 340 : undefined,
    needsOrigin: true,
  }
}

function vimeo(u: URL, host: string): Embed | null {
  if (host !== "vimeo.com" && host !== "player.vimeo.com") return null
  const m = host === "player.vimeo.com" ? /^\/video\/(\d+)\/?$/.exec(u.pathname) : /^\/(?:channels\/[\w-]+\/|groups\/[\w-]+\/videos\/)?(\d+)(?:\/([0-9a-f]+))?\/?$/.exec(u.pathname)
  if (!m) return null
  const hash = m[2] ?? u.searchParams.get("h") ?? ""
  const q = new URLSearchParams({ dnt: "1" })
  if (/^[0-9a-f]+$/.test(hash)) q.set("h", hash)
  return { provider: "Vimeo", src: `https://player.vimeo.com/video/${m[1]}?${q}`, ratio: 16 / 9 }
}

function loom(u: URL, host: string): Embed | null {
  const m = host === "loom.com" ? path(`(?:share|embed)/(${ID})`).exec(u.pathname) : null
  return m ? { provider: "Loom", src: `https://www.loom.com/embed/${m[1]}`, ratio: 16 / 10 } : null
}

function spotify(u: URL, host: string): Embed | null {
  const m = host === "open.spotify.com" ? /^\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|album|playlist|episode|show|artist)\/(\w+)\/?$/.exec(u.pathname) : null
  if (!m) return null
  const height = m[1] === "track" ? 152 : m[1] === "episode" || m[1] === "show" ? 232 : 352
  return { provider: "Spotify", src: `https://open.spotify.com/embed/${m[1]}/${m[2]}`, height }
}

function soundcloud(u: URL, host: string): Embed | null {
  if (host !== "soundcloud.com" && host !== "m.soundcloud.com") return null
  const m = /^\/([\w-]+)\/(sets\/)?([\w-]+)\/?$/.exec(u.pathname)
  if (!m || /^(discover|you|search|upload|settings|pages|charts|stations|tags)$/.test(m[1])) return null
  const q = new URLSearchParams({ url: `https://soundcloud.com${u.pathname}`, auto_play: "false", hide_related: "true", show_comments: "false", show_reposts: "false", visual: "false" })
  return { provider: "SoundCloud", src: `https://w.soundcloud.com/player/?${q}`, height: m[2] ? 300 : 166 }
}

function apple(u: URL, host: string): Embed | null {
  const music = host === "music.apple.com" || host === "embed.music.apple.com"
  const podcasts = host === "podcasts.apple.com" || host === "embed.podcasts.apple.com"
  if (!music && !podcasts) return null
  const m = /^\/[a-z]{2}\/(album|playlist|song|station|music-video|podcast)\/[^/]+(?:\/[\w.-]+)?\/?$/.exec(u.pathname)
  if (!m || (podcasts !== (m[1] === "podcast"))) return null
  const one = m[1] === "song" || u.searchParams.has("i")
  const i = u.searchParams.get("i")
  return {
    provider: music ? "Apple Music" : "Apple Podcasts",
    src: `https://embed.${music ? "music" : "podcasts"}.apple.com${u.pathname}${i && /^\d+$/.test(i) ? `?i=${i}` : ""}`,
    height: one ? 175 : 450,
  }
}

function figma(u: URL, host: string): Embed | null {
  if (host !== "figma.com" || !/^\/(file|design|proto|board|slides|deck)\/\w+/.test(u.pathname)) return null
  return { provider: "Figma", src: `https://www.figma.com/embed?embed_host=quire&url=${encodeURIComponent(`https://www.figma.com${u.pathname}${u.search}`)}`, ratio: 16 / 10 }
}

function codepen(u: URL, host: string): Embed | null {
  const m = host === "codepen.io" ? path(`([\\w-]+)/(?:pen|full|details|embed|pres)/(\\w+)`).exec(u.pathname) : null
  return m ? { provider: "CodePen", src: `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result`, height: 420 } : null
}

function codesandbox(u: URL, host: string): Embed | null {
  const m = host === "codesandbox.io" ? path(`(?:s|embed)/(${ID})`).exec(u.pathname) : null
  return m ? { provider: "CodeSandbox", src: `https://codesandbox.io/embed/${m[1]}`, height: 500 } : null
}

function google(u: URL, host: string): Embed | null {
  if (host === "docs.google.com") {
    // Published to the web: /document/d/e/<id>/pub
    const pub = /^\/(document|spreadsheets|presentation|forms)\/d\/e\/([\w-]+)\/(pub|pubhtml|embed|viewform)\/?$/.exec(u.pathname)
    if (pub) {
      const [, kind, id, page] = pub
      const src =
        kind === "presentation" ? `https://docs.google.com/presentation/d/e/${id}/embed`
        : kind === "forms" ? `https://docs.google.com/forms/d/e/${id}/viewform?embedded=true`
        : kind === "spreadsheets" ? `https://docs.google.com/spreadsheets/d/e/${id}/pubhtml?widget=true&headers=false`
        : `https://docs.google.com/document/d/e/${id}/${page === "pubhtml" ? "pub" : page}?embedded=true`
      return { provider: kind === "forms" ? "Google Forms" : "Google Docs", src, ...(kind === "presentation" ? { ratio: 16 / 10 } : { height: 560 }) }
    }
    const m = /^\/(document|spreadsheets|presentation)\/d\/([\w-]+)(?:\/.*)?$/.exec(u.pathname)
    if (!m) return null
    const name = m[1] === "document" ? "Google Docs" : m[1] === "spreadsheets" ? "Google Sheets" : "Google Slides"
    return m[1] === "presentation"
      ? { provider: name, src: `https://docs.google.com/presentation/d/${m[2]}/embed`, ratio: 16 / 10 }
      : { provider: name, src: `https://docs.google.com/${m[1]}/d/${m[2]}/preview`, height: 560 }
  }
  if (host === "drive.google.com") {
    const m = /^\/file\/d\/([\w-]+)(?:\/.*)?$/.exec(u.pathname)
    return m ? { provider: "Google Drive", src: `https://drive.google.com/file/d/${m[1]}/preview`, height: 480 } : null
  }
  // Maps: only the address its "Embed a map" dialog gives works in a frame.
  if ((host === "google.com" || host === "maps.google.com") && u.pathname === "/maps/embed" && u.searchParams.has("pb")) {
    return { provider: "Google Maps", src: `https://www.google.com/maps/embed?pb=${encodeURIComponent(u.searchParams.get("pb")!)}`, height: 420 }
  }
  return null
}

function miro(u: URL, host: string): Embed | null {
  const m = host === "miro.com" ? /^\/app\/(?:board|live-embed|embed)\/([\w-]+=?)\/?$/.exec(u.pathname) : null
  return m ? { provider: "Miro", src: `https://miro.com/app/live-embed/${m[1]}/?embedMode=view_only_without_ui`, ratio: 16 / 10 } : null
}

function airtable(u: URL, host: string): Embed | null {
  const m = host === "airtable.com" ? /^\/(?:embed\/)?((?:app\w+\/)?shr\w+)(?:\/.*)?$/.exec(u.pathname) : null
  return m ? { provider: "Airtable", src: `https://airtable.com/embed/${m[1]}`, height: 533 } : null
}

const providers = [youtube, vimeo, loom, spotify, soundcloud, apple, figma, codepen, codesandbox, google, miro, airtable]

/** The names of the sites that can be embedded, for hints. */
export const EMBED_SITES = "YouTube, Vimeo, Loom, Spotify, SoundCloud, Apple Music, Figma, CodePen, CodeSandbox, Google Docs, Maps, Miro or Airtable"

/** How to show the page at url in a frame, or null if it isn't from a site that can be. */
export function embedFor(url: string): Embed | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null
  if (u.username || u.password || u.port) return null
  const host = u.hostname.toLowerCase().replace(/^www\./, "")
  for (const p of providers) {
    const e = p(u, host)
    if (e) return e
  }
  return null
}
