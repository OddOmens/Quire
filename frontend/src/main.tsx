import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { ThemeProvider } from "next-themes"
import { BrowserRouter } from "react-router"

import App from "@/App"
import { DialogsProvider } from "@/components/dialogs"
import { ThemeColor } from "@/components/theme-color"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { queryClient } from "@/lib/boot"
import { watchKeyboard } from "@/lib/keyboard"
import "./index.css"

// After an update the server only has the new build's files, so a tab opened
// before it can't load lazy parts (diagrams, pages). Reload once to pick up
// the new build; the timestamp stops a loop if the file is really missing.
window.addEventListener("vite:preloadError", (event) => {
  let last = 0
  try {
    last = Number(sessionStorage.getItem("quire:reloaded-at")) || 0
    if (Date.now() - last < 60_000) return
    sessionStorage.setItem("quire:reloaded-at", String(Date.now()))
  } catch {
    // No session storage: still reload, but only this once per tab.
    if ((window as { quireReloaded?: boolean }).quireReloaded) return
    ;(window as { quireReloaded?: boolean }).quireReloaded = true
  }
  event.preventDefault()
  window.location.reload()
})

watchKeyboard()

// The service worker (public/sw.js) keeps the app's own files on the device,
// so an installed Quire starts at once. Browsers only allow one over HTTPS or
// on localhost.
if ("serviceWorker" in navigator && import.meta.env.PROD && window.isSecureContext) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}))
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <ThemeColor />
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <TooltipProvider delayDuration={400}>
            <DialogsProvider>
              <App />
              <Toaster position="bottom-right" />
            </DialogsProvider>
          </TooltipProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
