import { describe, expect, it } from "vitest"

import { dragSlop, edgeScroll, handlePlace, inTopHalf, sideZone, TOUCH_GRIP } from "@/editor/drag"

describe("edgeScroll", () => {
  const scroller = { top: 100, bottom: 700 }
  it("holds still in the middle", () => {
    expect(edgeScroll(400, scroller)).toBe(0)
    expect(edgeScroll(164, scroller)).toBe(0)
    expect(edgeScroll(636, scroller)).toBe(0)
  })
  it("scrolls up near the top and down near the bottom, faster nearer the edge", () => {
    expect(edgeScroll(150, scroller)).toBeLessThan(0)
    expect(edgeScroll(650, scroller)).toBeGreaterThan(0)
    expect(Math.abs(edgeScroll(110, scroller))).toBeGreaterThan(Math.abs(edgeScroll(150, scroller)))
    expect(edgeScroll(690, scroller)).toBeGreaterThan(edgeScroll(650, scroller))
  })
  it("never goes faster than the limit, even past the edge", () => {
    expect(edgeScroll(-500, scroller)).toBe(-24)
    expect(edgeScroll(5000, scroller)).toBe(24)
  })
  it("keeps a still middle in a short scroller", () => {
    // A phone with its keyboard up: 150px of page showing.
    const short = { top: 50, bottom: 200 }
    expect(edgeScroll(125, short)).toBe(0)
    expect(edgeScroll(60, short)).toBeLessThan(0)
    expect(edgeScroll(190, short)).toBeGreaterThan(0)
  })
})

describe("inTopHalf", () => {
  it("splits a block at its middle", () => {
    expect(inTopHalf(109, { top: 100, bottom: 120 })).toBe(true)
    expect(inTopHalf(110, { top: 100, bottom: 120 })).toBe(false)
  })
})

describe("sideZone", () => {
  const block = { left: 100, right: 500 }
  it("takes the outer fifth on the right, at most 56px", () => {
    expect(sideZone(450, block, false)).toBe("right")
    expect(sideZone(440, block, false)).toBe(null)
    expect(sideZone(190, { left: 100, right: 200 }, false)).toBe("right")
    expect(sideZone(175, { left: 100, right: 200 }, false)).toBe(null)
  })
  it("takes the left only of a column", () => {
    expect(sideZone(110, block, false)).toBe(null)
    expect(sideZone(110, block, true)).toBe("left")
    expect(sideZone(99, block, true)).toBe(null)
    expect(sideZone(300, block, true)).toBe(null)
  })
})

describe("dragSlop", () => {
  it("gives a finger more room than a mouse", () => {
    expect(dragSlop("touch")).toBeGreaterThan(dragSlop("mouse"))
    expect(dragSlop("pen")).toBe(dragSlop("mouse"))
  })
})

describe("handlePlace", () => {
  const box = { top: 200, left: 24 }
  it("puts the mouse handle left of the text, centred on the first line", () => {
    expect(handlePlace({ top: 300, left: 24 }, box, { firstLine: 26, indent: 0, touch: false, limit: 0 })).toEqual({ top: 101, left: -52, width: 24 })
    expect(handlePlace({ top: 300, left: 50 }, box, { firstLine: 26, indent: 26, touch: false, limit: 0 }).left).toBe(-52)
  })
  it("keeps the touch grip on the screen in a phone's narrow margin", () => {
    const p = handlePlace({ top: 300, left: 24 }, box, { firstLine: 26, indent: 0, touch: true, limit: 0 })
    expect(p.width).toBe(TOUCH_GRIP.narrow)
    expect(p.left + box.left).toBe(0)
    expect(p.top).toBe(300 - 200 + 13 - TOUCH_GRIP.height / 2)
    // A list item's marker would push it off the left edge.
    const item = handlePlace({ top: 300, left: 46 }, box, { firstLine: 26, indent: 26, touch: true, limit: 0 })
    expect(item.left + box.left).toBe(0)
  })
  it("uses the wider grip where the margin has room, and stays right of the scroller's edge", () => {
    // An iPad: a sidebar 256px wide, then a 56px margin.
    const ipad = { top: 200, left: 312 }
    const p = handlePlace({ top: 300, left: 312 }, ipad, { firstLine: 26, indent: 0, touch: true, limit: 256 })
    expect(p.width).toBe(TOUCH_GRIP.wide)
    expect(p.left + ipad.left).toBe(312 - 32 - 2)
    const nested = handlePlace({ top: 300, left: 340 }, ipad, { firstLine: 26, indent: 26, touch: true, limit: 256 })
    expect(nested.left + ipad.left).toBeGreaterThanOrEqual(256)
    expect(nested.left + ipad.left + nested.width).toBeLessThanOrEqual(340 - 26)
  })
})
