import { useEffect, useState, type ComponentType } from "react"
import { useQuery } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { Navigate, Route, Routes, useNavigate } from "react-router"

import { AppShell } from "@/components/app-shell"
import { api } from "@/lib/api"
import { loadedScreen, loadScreen, type Screen, type ScreenModule } from "@/routes"

/**
 * A screen whose code loads when it's first shown. One that has already
 * arrived (the app starts fetching the first screen straight away, in
 * lib/boot.ts) renders at once. No React.lazy: see lib/deferred.tsx.
 */
function screen<K extends Screen>(name: K, pick: (m: ScreenModule<K>) => ComponentType = (m) => m.default) {
  return function ScreenRoute() {
    const [, update] = useState(0)
    const m = loadedScreen(name)
    useEffect(() => {
      if (m) return
      let live = true
      // A file that's gone after an update reloads the app (main.tsx).
      loadScreen(name).then(() => live && update((n) => n + 1), () => {})
      return () => {
        live = false
      }
    }, [m])
    if (!m) return <Spinner />
    const Ready = pick(m)
    return <Ready />
  }
}

const HomePage = screen("home")
const SpacePage = screen("space")
const SpaceSettingsPage = screen("spaceSettings")
const PageRoute = screen("page")
const GraphPage = screen("graph")
const GraphRedirect = screen("graph", (m) => m.GraphRedirect)
const TasksPage = screen("tasks")
const TagsPage = screen("tags")
const TrashPage = screen("trash")
const SettingsPage = screen("settings")
const SharePage = screen("share")
const CalendarPage = screen("calendar")
const FormPage = screen("form")
const LoginPage = screen("login")
const SetupPage = screen("setup")

function Spinner() {
  return (
    <div className="grid h-full min-h-40 place-items-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useQuery({ queryKey: ["session"], queryFn: api.session, staleTime: Infinity })
  const navigate = useNavigate()

  // Any API call that comes back 401 means the session ended.
  useEffect(() => {
    const out = () => navigate("/login", { replace: true })
    window.addEventListener("quire:signed-out", out)
    return () => window.removeEventListener("quire:signed-out", out)
  }, [navigate])

  if (isLoading) return <div className="h-svh"><Spinner /></div>
  if (data?.setupRequired) return <Navigate to="/setup" replace />
  if (data && !data.authenticated) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/share/:token" element={<SharePage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<HomePage />} />
        <Route path="/s/:space" element={<SpacePage />} />
        <Route path="/s/:space/settings" element={<SpaceSettingsPage />} />
        <Route path="/p/*" element={<PageRoute />} />
        <Route path="/s/:space/graph" element={<GraphPage />} />
        <Route path="/s/:space/tasks" element={<TasksPage />} />
        <Route path="/graph" element={<GraphRedirect />} />
        <Route path="/tags" element={<TagsPage />} />
        <Route path="/tags/:tag" element={<TagsPage />} />
        <Route path="/trash" element={<TrashPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/form/*" element={<FormPage />} />
        <Route path="/settings/:section?" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
