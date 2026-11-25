// Quire's service worker: an installed Quire starts from files kept on the
// device rather than waiting on the network, and still opens (to say it's
// offline) with no connection at all.
//
// The app itself is always kept: the page that loads it and the build's
// files, which are the same for everyone.
//
// Attached files (/api/files/) are kept only on a device whose owner turned
// on "Available offline" in Settings (src/lib/offline.ts), which is what
// creates the FILES cache; signing out deletes it. Nothing else under /api/
// passes through here, and neither do public forms (/f/).
const CACHE = "quire-shell-v1"
const FILES = "quire-files-v1"

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.add("/")).then(() => self.skipWaiting()))
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE && k !== FILES).map((k) => caches.delete(k)))
      // Lets the browser ask for a page while this worker is still starting
      // up, instead of waiting for it.
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable()
      await self.clients.claim()
    })(),
  )
})

// Keeps the newest copy of the app's page for starts without a connection. A
// copy that differs from the stored one is a new build, whose files have new
// names: the old build's are dropped so the cache doesn't grow with every update.
async function keepShell(res) {
  const cache = await caches.open(CACHE)
  const old = await cache.match("/", { ignoreVary: true })
  if (old) {
    const [next, prev] = await Promise.all([res.clone().text(), old.text()])
    if (next !== prev) {
      const keys = await cache.keys()
      await Promise.all(keys.filter((k) => new URL(k.url).pathname.startsWith("/assets/")).map((k) => cache.delete(k)))
    }
  }
  await cache.put("/", res)
}

// The part of a kept file a video or audio player asked for: Safari won't
// play from an answer that isn't the range it requested.
async function slice(req, hit) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("Range") || "")
  if (!m || (!m[1] && !m[2])) return hit
  const blob = await hit.blob()
  const start = m[1] ? Number(m[1]) : Math.max(0, blob.size - Number(m[2]))
  const end = m[1] && m[2] ? Math.min(Number(m[2]), blob.size - 1) : blob.size - 1
  if (start > end || start >= blob.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${blob.size}` } })
  const headers = new Headers(hit.headers)
  headers.set("Content-Range", `bytes ${start}-${end}/${blob.size}`)
  headers.set("Content-Length", String(end - start + 1))
  headers.set("Accept-Ranges", "bytes")
  return new Response(blob.slice(start, end + 1, hit.headers.get("Content-Type") || ""), { status: 206, headers })
}

// An attached file: the kept copy when this device keeps one, else the
// server's, which is kept for next time.
async function file(event) {
  const req = event.request
  if (!(await caches.has(FILES))) return fetch(req)
  const cache = await caches.open(FILES)
  const key = new URL(req.url).pathname
  const hit = await cache.match(key, { ignoreVary: true })
  if (hit) return slice(req, hit)
  const res = await fetch(req)
  // Whole files only: a 206 is a part of one.
  if (res.status === 200 && !req.headers.has("Range")) {
    const copy = res.clone()
    event.waitUntil(cache.put(key, copy).catch(() => {}))
  }
  return res
}

self.addEventListener("fetch", (event) => {
  const req = event.request
  if (req.method !== "GET") return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith("/api/files/")) {
    event.respondWith(file(event))
    return
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/f/")) return

  // The build names these files after their content, so one never changes: kept copy first.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      // ignoreVary: the server's "Vary: Accept-Encoding" would otherwise hide
      // a copy fetched ahead of time from the request that needs it.
      caches.match(req, { ignoreVary: true }).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone()
              event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)))
            }
            return res
          }),
      ),
    )
    return
  }

  // Pages: the server's copy when it answers, so an update is picked up on
  // the next start; the kept copy without a connection, or when the server
  // takes too long (a phone away from the server's network can wait a minute
  // to be told so).
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const fresh = (async () => {
          const res = (await event.preloadResponse) || (await fetch(req))
          if (res.ok && (res.headers.get("Content-Type") || "").startsWith("text/html")) event.waitUntil(keepShell(res.clone()).catch(() => {}))
          return res
        })()
        const kept = await caches.match("/", { ignoreVary: true })
        if (!kept) return fresh
        event.waitUntil(fresh.catch(() => {}))
        return Promise.race([fresh.catch(() => kept), new Promise((resolve) => setTimeout(() => resolve(kept), 4000))])
      })(),
    )
  }
})
