import { useEffect } from "react"
import { useTheme } from "next-themes"

/** From this width up the app is a frame on a canvas (components/app-shell.tsx), and the canvas is what meets the top of the screen. */
const WIDE = "(min-width: 768px)"

/**
 * Tints the browser's bars, and an installed app's status bar where the
 * system colours it from the page, to match the chosen theme (not just the
 * system one) and whatever is at the top of the screen at this width.
 */
export function ThemeColor() {
  const { resolvedTheme } = useTheme()
  useEffect(() => {
    const wide = window.matchMedia(WIDE)
    let raf = 0
    const apply = () => {
      const color = getComputedStyle(document.documentElement).getPropertyValue(wide.matches ? "--canvas" : "--background").trim()
      if (!color) return
      document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
        m.content = color
        m.removeAttribute("media")
      })
    }
    // After next-themes has swapped the class on <html>, which happens in its own effect.
    raf = requestAnimationFrame(apply)
    // An iPad turning, or sharing its screen with another app.
    wide.addEventListener("change", apply)
    return () => {
      cancelAnimationFrame(raf)
      wide.removeEventListener("change", apply)
    }
  }, [resolvedTheme])
  return null
}
