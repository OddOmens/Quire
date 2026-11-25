import { inflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"

import { launchScreens, solidPng } from "../../launch-screens"
import { measure } from "./keyboard"

describe("measure", () => {
  it("is what the keyboard covers at the bottom of the page", () => {
    expect(measure(844, { height: 508, offsetTop: 0, scale: 1 })).toBe(336)
  })
  it("allows for the page having been slid up under the keyboard", () => {
    expect(measure(844, { height: 508, offsetTop: 120, scale: 1 })).toBe(216)
  })
  it("is nothing with the keyboard away, a browser bar moving, or the page zoomed", () => {
    expect(measure(844, { height: 844, offsetTop: 0, scale: 1 })).toBe(0)
    expect(measure(844, { height: 790, offsetTop: 0, scale: 1 })).toBe(0)
    expect(measure(844, { height: 422, offsetTop: 0, scale: 2 })).toBe(0)
  })
})

describe("launch screens", () => {
  it("draws a PNG of one colour at the size asked for", () => {
    const png = solidPng(4, 3, "#18181a")
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png.readUInt32BE(16)).toBe(4)
    expect(png.readUInt32BE(20)).toBe(3)
    const length = png.readUInt32BE(33)
    const raw = inflateSync(png.subarray(41, 41 + length))
    // Row one spelt out, the rows after it "as above".
    expect([...raw.subarray(0, 13)]).toEqual([0, 0x18, 0x18, 0x1a, 0x18, 0x18, 0x1a, 0x18, 0x18, 0x1a, 0x18, 0x18, 0x1a])
    expect([...raw.subarray(13)]).toEqual([2, ...Array(12).fill(0), 2, ...Array(12).fill(0)])
  })
  it("has one picture per screen, way up and theme, each named once", () => {
    const screens = launchScreens()
    expect(new Set(screens.map((s) => s.media)).size).toBe(screens.length)
    expect(screens.find((s) => s.media.includes("(device-width: 390px)") && s.media.includes("dark"))).toMatchObject({ width: 1170, height: 2532, colour: "#18181a" })
    expect(screens.find((s) => s.media.includes("(device-width: 820px)") && s.media.includes("landscape") && s.media.includes("light"))).toMatchObject({ width: 2360, height: 1640, colour: "#f4f4f5" })
  })
})
