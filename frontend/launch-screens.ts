import { deflateSync } from 'node:zlib'
import type { Plugin } from 'vite'

// What an iPhone or iPad shows from the tap on Quire's Home Screen icon until
// the app has drawn. Without one it's a white screen, which flashes in dark
// mode. iOS only uses a picture that is exactly the screen's size in pixels,
// so there is one per screen size, lying down as well as upright for iPads,
// in each of the two themes: plain pictures of the app's background colour,
// so the app appears to simply fill in. They're drawn here during the build
// (a one-colour PNG is a few kilobytes) rather than kept in the repository,
// and index.html gets the <link> for each.

// [width, height, pixels per point] of the screen held upright, in points.
const PHONES: [number, number, number][] = [
  [320, 568, 2], // SE (1st)
  [375, 667, 2], // SE (2nd, 3rd), 8
  [414, 736, 3], // 8 Plus
  [375, 812, 3], // X, XS, 11 Pro, 12 mini, 13 mini
  [414, 896, 2], // XR, 11
  [414, 896, 3], // XS Max, 11 Pro Max
  [390, 844, 3], // 12, 13, 14, 16e
  [428, 926, 3], // 12 and 13 Pro Max, 14 Plus
  [393, 852, 3], // 14 Pro, 15, 15 Pro, 16
  [430, 932, 3], // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  [402, 874, 3], // 16 Pro, 17, 17 Pro
  [420, 912, 3], // Air
  [440, 956, 3], // 16 Pro Max, 17 Pro Max
]
const TABLETS: [number, number, number][] = [
  [744, 1133, 2], // mini (6th, 7th)
  [768, 1024, 2], // 9.7", mini (to 5th)
  [810, 1080, 2], // 10.2"
  [820, 1180, 2], // 10.9" and 11" iPad and Air
  [834, 1112, 2], // 10.5"
  [834, 1194, 2], // Pro 11"
  [834, 1210, 2], // Pro 11" (M4)
  [1024, 1366, 2], // Pro 12.9", Air 13"
  [1032, 1376, 2], // Pro 13" (M4)
]

// The app's background (--background) on a phone, where the page fills the
// screen, and the canvas behind the panels (--canvas) on an iPad: index.css.
const COLOURS = {
  phone: { light: '#ffffff', dark: '#18181a' },
  tablet: { light: '#f4f4f5', dark: '#0e0e0f' },
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(data: Uint8Array) {
  let c = 0xffffffff
  for (const byte of data) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Uint8Array) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

/** A PNG of one colour ("#rrggbb"), in plain 8-bit RGB. */
export function solidPng(width: number, height: number, colour: string) {
  const rgb = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16))
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8) // 8 bits a channel, RGB, no interlacing
  // The first row is spelt out; every row after it is "the same as the row above" (filter 2, all zeros).
  const row = 1 + width * 3
  const raw = Buffer.alloc(row * height)
  for (let x = 0; x < width; x++) raw.set(rgb, 1 + x * 3)
  for (let y = 1; y < height; y++) raw[y * row] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ])
}

type Screen = { file: string; media: string; width: number; height: number; colour: string }

export function launchScreens(): Screen[] {
  const out: Screen[] = []
  const add = (kind: 'phone' | 'tablet', [w, h, ratio]: [number, number, number], orientation: 'portrait' | 'landscape') => {
    for (const theme of ['light', 'dark'] as const) {
      const [pw, ph] = orientation === 'portrait' ? [w * ratio, h * ratio] : [h * ratio, w * ratio]
      out.push({
        file: `launch/${pw}x${ph}-${theme}.png`,
        // device-width is the upright width whichever way the device is held.
        media: `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: ${orientation}) and (prefers-color-scheme: ${theme})`,
        width: pw,
        height: ph,
        colour: COLOURS[kind][theme],
      })
    }
  }
  for (const phone of PHONES) add('phone', phone, 'portrait')
  for (const tablet of TABLETS) {
    add('tablet', tablet, 'portrait')
    add('tablet', tablet, 'landscape')
  }
  return out
}

/** Draws the launch pictures into the build and lists them in index.html. */
export function launchScreensPlugin(): Plugin {
  const screens = launchScreens()
  return {
    name: 'quire:launch-screens',
    apply: 'build',
    generateBundle() {
      const drawn = new Map<string, Buffer>()
      for (const s of screens) {
        const key = `${s.width}x${s.height}${s.colour}`
        if (!drawn.has(key)) drawn.set(key, solidPng(s.width, s.height, s.colour))
        this.emitFile({ type: 'asset', fileName: s.file, source: drawn.get(key)! })
      }
    },
    transformIndexHtml() {
      return screens.map((s) => ({ tag: 'link', attrs: { rel: 'apple-touch-startup-image', media: s.media, href: `/${s.file}` }, injectTo: 'head' as const }))
    },
  }
}
