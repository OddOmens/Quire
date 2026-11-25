/**
 * The sums behind picking a block up and putting it down
 * (editor/block-handle.tsx), kept apart from the page so they can be tested.
 * Everything is in viewport pixels.
 */

type Span = { top: number; bottom: number }
type Width = { left: number; right: number }

/**
 * How far to scroll this frame with the pointer at y in a scroller that
 * shows top to bottom: nothing in the middle, faster the nearer an edge,
 * never more than max. Negative scrolls up.
 */
export function edgeScroll(y: number, scroller: Span, edge = 64, max = 24) {
  // A short scroller (a phone with its keyboard up) keeps a middle third that holds still.
  const e = Math.min(edge, (scroller.bottom - scroller.top) / 3)
  const d = y < scroller.top + e ? y - scroller.top - e : y > scroller.bottom - e ? y - scroller.bottom + e : 0
  return Math.max(-max, Math.min(max, d / 4)) || 0
}

/** Whether the pointer is in the top half of a block: a drop then goes in the gap above it, else below. */
export const inTopHalf = (y: number, block: Span) => y < (block.top + block.bottom) / 2

/**
 * The edge of a block the pointer is near enough to mean "beside it, in
 * columns": its outer fifth, at most 56px. Only a column takes one on its
 * left; anything else would hide the gap above and below a block's start.
 */
export function sideZone(x: number, block: Width, column: boolean): "left" | "right" | null {
  const zone = Math.min(56, (block.right - block.left) / 5)
  if (x > block.right - zone) return "right"
  return column && x >= block.left && x < block.left + zone ? "left" : null
}

/** How far a pointer travels before a press on the grip counts as a drag: fingers wobble more than mice. */
export const dragSlop = (pointerType: string) => (pointerType === "touch" ? 8 : 4)

/** The grip a finger presses: as wide as the page's margin allows. */
export const TOUCH_GRIP = { narrow: 24, wide: 32, height: 40 }

/**
 * Where the handle sits for a block, relative to the editor's box: beside
 * the block's first line. With a mouse it's the + and the grip, left of the
 * text. For a finger it's the grip alone, taller, and never further left
 * than `limit` (the edge of the page's scroller), where a phone's narrow
 * margin would put it off the screen.
 */
export function handlePlace(
  block: { top: number; left: number },
  box: { top: number; left: number },
  o: { firstLine: number; indent: number; touch: boolean; limit: number },
) {
  if (!o.touch) return { top: block.top - box.top + o.firstLine / 2 - 12, left: block.left - box.left - o.indent - 52, width: 24 }
  const room = block.left - o.indent - o.limit
  const width = room >= TOUCH_GRIP.wide + 8 ? TOUCH_GRIP.wide : TOUCH_GRIP.narrow
  const left = Math.max(o.limit, block.left - o.indent - width - 2)
  return { top: block.top - box.top + o.firstLine / 2 - TOUCH_GRIP.height / 2, left: left - box.left, width }
}
