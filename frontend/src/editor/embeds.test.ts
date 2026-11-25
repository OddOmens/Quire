import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { EMBED_HOSTS, embedFor } from "@/editor/embeds"

const src = (url: string) => embedFor(url)?.src ?? null

describe("embedFor", () => {
  it("turns the links people copy into player addresses", () => {
    const cases: Record<string, string> = {
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ": "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ?t=1m30s": "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42&feature=share": "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42",
      "https://www.youtube.com/shorts/abcdefghijk": "https://www.youtube-nocookie.com/embed/abcdefghijk",
      "https://www.youtube.com/live/abcdefghijk?si=x": "https://www.youtube-nocookie.com/embed/abcdefghijk",
      "https://www.youtube.com/playlist?list=PLabcdefghijklmnop": "https://www.youtube-nocookie.com/embed/videoseries?list=PLabcdefghijklmnop",
      "https://vimeo.com/123456789": "https://player.vimeo.com/video/123456789?dnt=1",
      "https://vimeo.com/123456789/abcdef0123": "https://player.vimeo.com/video/123456789?dnt=1&h=abcdef0123",
      "https://www.loom.com/share/0123456789abcdef0123456789abcdef?sid=x": "https://www.loom.com/embed/0123456789abcdef0123456789abcdef",
      "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc": "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC",
      "https://open.spotify.com/intl-de/album/4uLU6hMCjMI75M1A2tKUQC": "https://open.spotify.com/embed/album/4uLU6hMCjMI75M1A2tKUQC",
      "https://soundcloud.com/some-artist/some-track": "https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fsome-artist%2Fsome-track&auto_play=false&hide_related=true&show_comments=false&show_reposts=false&visual=false",
      "https://music.apple.com/us/album/some-album/1440857781?i=1440857786": "https://embed.music.apple.com/us/album/some-album/1440857781?i=1440857786",
      "https://podcasts.apple.com/us/podcast/some-show/id1200361736": "https://embed.podcasts.apple.com/us/podcast/some-show/id1200361736",
      "https://www.figma.com/design/AbC123/My-file?node-id=1-2": "https://www.figma.com/embed?embed_host=quire&url=https%3A%2F%2Fwww.figma.com%2Fdesign%2FAbC123%2FMy-file%3Fnode-id%3D1-2",
      "https://codepen.io/someone/pen/abcDEF": "https://codepen.io/someone/embed/abcDEF?default-tab=result",
      "https://codesandbox.io/s/new-sandbox-abc12": "https://codesandbox.io/embed/new-sandbox-abc12",
      "https://docs.google.com/document/d/1AbC_dEf-123/edit?usp=sharing": "https://docs.google.com/document/d/1AbC_dEf-123/preview",
      "https://docs.google.com/spreadsheets/d/1AbC_dEf-123/edit#gid=0": "https://docs.google.com/spreadsheets/d/1AbC_dEf-123/preview",
      "https://docs.google.com/presentation/d/1AbC_dEf-123/edit": "https://docs.google.com/presentation/d/1AbC_dEf-123/embed",
      "https://docs.google.com/forms/d/e/1FAIpQLSabc/viewform": "https://docs.google.com/forms/d/e/1FAIpQLSabc/viewform?embedded=true",
      "https://drive.google.com/file/d/1AbC_dEf-123/view?usp=sharing": "https://drive.google.com/file/d/1AbC_dEf-123/preview",
      "https://www.google.com/maps/embed?pb=!1m18!1m12": "https://www.google.com/maps/embed?pb=!1m18!1m12",
      "https://miro.com/app/board/uXjVabc123=/": "https://miro.com/app/live-embed/uXjVabc123=/?embedMode=view_only_without_ui",
      "https://airtable.com/appAbc123/shrXyz789": "https://airtable.com/embed/appAbc123/shrXyz789",
    }
    for (const [url, want] of Object.entries(cases)) expect(src(url), url).toBe(want)
  })

  it("leaves everything else alone", () => {
    for (const url of [
      "",
      "not a link",
      "https://example.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/",
      "https://www.youtube.com/@somechannel",
      "https://www.youtube.com/watch?v=<script>",
      "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
      "https://evil.example/https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://user:pw@www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ",
      "javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ",
      "https://vimeo.com/about",
      "https://soundcloud.com/discover/sets",
      "https://www.google.com/maps/place/Somewhere",
      "https://www.google.com/search?q=x",
      "https://open.spotify.com/user/someone",
      "https://docs.google.com/",
    ]) {
      expect(src(url), url).toBeNull()
    }
  })

  it("only ever frames the hosts the server allows", () => {
    const hosts = new Set<string>(EMBED_HOSTS)
    // The same list, as the server sends it in its Content-Security-Policy.
    const go = readFileSync(new URL("../../../backend/internal/server/server.go", import.meta.url), "utf8")
    const allowed = [...go.slice(go.indexOf("var embedHosts"), go.indexOf("// pageCSP")).matchAll(/"https:\/\/([^"/]+)(\/[^"]*)?"/g)].map((m) => m[1])
    expect(allowed.sort()).toEqual([...hosts].sort())
    for (const url of [
      "https://youtu.be/dQw4w9WgXcQ",
      "https://vimeo.com/123456789",
      "https://www.loom.com/share/0123456789abcdef",
      "https://open.spotify.com/show/abc",
      "https://soundcloud.com/a/sets/b",
      "https://music.apple.com/gb/playlist/x/pl.abc",
      "https://podcasts.apple.com/us/podcast/x/id1?i=2",
      "https://figma.com/board/abc/Name",
      "https://codepen.io/a/full/b",
      "https://codesandbox.io/embed/abc",
      "https://docs.google.com/document/d/e/2PACX-abc/pub",
      "https://drive.google.com/file/d/abc/preview",
      "https://maps.google.com/maps/embed?pb=x",
      "https://miro.com/app/board/abc=/",
      "https://airtable.com/shrabc",
    ]) {
      const e = embedFor(url)
      expect(e, url).not.toBeNull()
      const u = new URL(e!.src)
      expect(u.protocol).toBe("https:")
      expect(hosts.has(u.host), `${url} → ${u.host}`).toBe(true)
      expect(e!.ratio || e!.height, url).toBeTruthy()
    }
  })
})
