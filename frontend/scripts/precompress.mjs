// Runs after `vite build`: leaves a Brotli (.br) and a gzip (.gz) copy beside
// every text file in dist/ that's worth compressing. The server sends the
// smallest one a browser accepts (backend/internal/server/spa.go), so nothing
// is compressed while a page loads.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { brotliCompressSync, constants, gzipSync } from "node:zlib"

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist")
const TEXT = /\.(js|mjs|css|html|svg|json|webmanifest|txt|xml|map)$/
// Smaller files fit in one packet either way.
const MIN_BYTES = 1024

let files = 0
let before = 0
let brotli = 0
let gzip = 0
for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !TEXT.test(entry.name)) continue
  const file = path.join(entry.parentPath ?? entry.path, entry.name)
  if (statSync(file).size < MIN_BYTES) continue
  const data = readFileSync(file)
  const br = brotliCompressSync(data, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  })
  const gz = gzipSync(data, { level: 9 })
  // Not worth a second copy unless it saves a tenth.
  if (br.length < data.length * 0.9) writeFileSync(file + ".br", br)
  if (gz.length < data.length * 0.9) writeFileSync(file + ".gz", gz)
  files++
  before += data.length
  brotli += br.length
  gzip += gz.length
}
const kb = (n) => `${(n / 1024).toFixed(0)} kB`
console.log(`precompressed ${files} files: ${kb(before)} → ${kb(brotli)} brotli, ${kb(gzip)} gzip`)
