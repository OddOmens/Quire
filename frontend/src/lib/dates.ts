// Days written as 2026-11-11, the way a date chip (@2026-11-11) stores them.

const pad = (n: number) => String(n).padStart(2, "0")

/** A local date as 2026-11-11. */
export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** "Today", "Tomorrow", "Fri 14 Nov" or "14 Nov 2027" for a date written as 2026-11-11. */
export function dateLabel(iso: string, now = new Date()) {
  const [y, m, d] = iso.split("-").map(Number)
  const date = new Date(y, m - 1, d)
  if (Number.isNaN(date.getTime())) return iso
  const days = Math.round((date.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000)
  if (days === 0) return "Today"
  if (days === 1) return "Tomorrow"
  if (days === -1) return "Yesterday"
  return date.toLocaleDateString(undefined, {
    weekday: days > 0 && days < 7 ? "short" : undefined,
    day: "numeric",
    month: "short",
    year: y === now.getFullYear() ? undefined : "numeric",
  })
}
