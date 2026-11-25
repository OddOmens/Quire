import { Fragment } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"
import {
  ArrowUpDown,
  CalendarDays,
  Check,
  ChevronsUpDown,
  FilePlus2,
  FileSpreadsheet,
  House,
  LayoutGrid,
  ListTodo,
  LogOut,
  Monitor,
  Moon,
  Network,
  Plus,
  Search,
  Settings,
  Sun,
  Table2,
  Trash2,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Link, Outlet, useLocation, useNavigate } from "react-router"

import { Brand } from "@/components/brand"
import { ArrangeSpacesDialog, CommandPalette, MoveDialog, NewDatabaseDialog, SpaceDialog } from "@/components/deferred-dialogs"
import { useHealthNotice } from "@/components/health"
import { PageTree } from "@/components/page-tree"
import { SpaceAvatar } from "@/components/space-avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Kbd } from "@/components/ui/kbd"
import {
  Sidebar,
  SidebarContent,
  SidebarFold,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarTrigger,
  sidebarFade,
  sidebarLabel,
  useSidebar,
  useSidebarRail,
} from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DragGhost, DropLine, moveItem, useListDrag } from "@/hooks/use-list-drag"
import { OfflineBadge, OfflineWatcher } from "@/components/offline"
import { useArrangeSpaces, useCurrentSpace, useLiveUpdates, usePageTree, useSpaces, useSpaceSections, useTree, useVaultActions } from "@/hooks/use-vault"
import { api } from "@/lib/api"
import { initials, spaceGraphUrl, spaceTasksUrl, spaceUrl } from "@/lib/notes"
import { openArrangeSpaces, openNewDatabase, openPalette, openSpaceDialog } from "@/lib/ui-events"

export function AppShell() {
  useLiveUpdates()
  useHealthNotice()
  return (
    // The frame keeps clear of the notch, the status bar and the home bar
    // (--sat and friends are 0 in a browser tab), and ends where the on-screen
    // keyboard and the editor's bar above it begin, so what's being typed is
    // never under them.
    <SidebarProvider
      style={{ "--sidebar-width": "16.5rem", "--frame-top": "max(0.5rem, var(--sat))", "--frame-bottom": "max(0.5rem, var(--sab), calc(var(--kb) + var(--touchbar-h)))" } as React.CSSProperties}
      className="bg-background pr-(--sar) pl-(--sal) md:bg-canvas"
    >
      <OfflineWatcher />
      <TopBar />
      <SpaceSidebar />
      {/* Desktop: the page is a rounded panel on the canvas, beside the floating sidebar. */}
      <SidebarInset className="mt-[calc(var(--topbar-h)+var(--sat))] h-[calc(100svh-var(--topbar-h)-var(--sat)-var(--kb)-var(--touchbar-h))] min-w-0 overflow-hidden md:m-2 md:mt-(--frame-top) md:mb-0 md:ml-0 md:h-[calc(100svh-var(--frame-top)-var(--frame-bottom))] md:rounded-2xl md:border">
        <Outlet />
      </SidebarInset>
      <CommandPalette />
      <SpaceDialog />
      <ArrangeSpacesDialog />
      <MoveDialog />
      <NewDatabaseDialog />
    </SidebarProvider>
  )
}

export function useSignOut() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  return async () => {
    await api.logout().catch(() => {})
    qc.clear()
    navigate("/login", { replace: true })
  }
}

/** Phones only: on a desktop the brand and toggle sit at the top of the sidebar. */
function TopBar() {
  return (
    <header className="fixed inset-x-0 top-0 z-30 box-content flex h-(--topbar-h) items-center gap-2 border-b bg-background pt-(--sat) pr-[calc(0.75rem+var(--sar))] pl-[calc(0.75rem+var(--sal))] md:hidden">
      <SidebarTrigger className="text-muted-foreground" />
      <Link to="/" className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Brand />
      </Link>
      <OfflineBadge className="ml-auto" />
    </header>
  )
}

function UserMenu({ onNavigate, side }: { onNavigate: () => void; side: "top" | "right" }) {
  const { data: account } = useQuery({ queryKey: ["account"], queryFn: api.account })
  const { theme, setTheme } = useTheme()
  const signOut = useSignOut()
  const name = account?.name ?? ""
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account"
          className="flex h-10 w-[calc(100cqw-2.5rem)] flex-none items-center gap-2.5 overflow-hidden rounded-md px-1.5 text-left outline-none transition-[width] duration-(--sidebar-duration) ease-(--sidebar-ease) hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent group-data-[collapsible=icon]:w-10"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-foreground text-[0.65rem] font-semibold text-background">{name ? initials(name) : ""}</span>
          <span className={cn(sidebarLabel, "max-w-[calc(100cqw-5.625rem)] text-sm font-medium")}>{name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={side === "top" ? "start" : "end"} className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="text-sm font-medium text-foreground">{name}</div>
          <div className="text-xs text-muted-foreground">Owner</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings" onClick={onNavigate}>
            <Settings /> Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/trash" onClick={onNavigate}>
            <Trash2 /> Trash
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {theme === "dark" ? <Moon /> : theme === "light" ? <Sun /> : <Monitor />} Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Switches space. Spaces sit under their section headings. Drag a space in
 * the menu to move it (on a phone, press and hold first): it joins the
 * section of the space it lands next to. "Arrange spaces…" does the same
 * from the keyboard, and adds and renames sections.
 */
function SpaceSwitcher({ current }: { current: string }) {
  const rail = useSidebarRail()
  const { data: spaces } = useSpaces()
  const { data: sections } = useSpaceSections()
  const arrange = useArrangeSpaces()
  const navigate = useNavigate()
  const space = spaces?.find((s) => s.name === current)
  const { boxRef, ghostRef, drag, start } = useListDrag((from, to) => {
    if (!spaces) return
    const names = moveItem(spaces.map((s) => s.name), from, to)
    const headings = sections ?? []
    if (headings.length === 0) return void arrange(names)
    // The space that was where it landed is beside it now: it joins that one's section.
    const moved = spaces[from].name
    const sectionOf = (n: string) => (n === moved ? spaces[to].section : spaces.find((s) => s.name === n)?.section)
    void arrange(
      names,
      headings.map((sec) => ({ name: sec.name, spaces: names.filter((n) => sectionOf(n) === sec.name) })),
    )
  })
  const dragged = drag ? spaces?.[drag.from] : undefined
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={space ? `Space: ${space.name}` : "Spaces"}
          className="relative flex h-10 w-full items-center gap-2.5 overflow-hidden rounded-md px-2 text-left outline-none transition-[width] duration-(--sidebar-duration) ease-(--sidebar-ease) hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:w-10"
        >
          {space ? <SpaceAvatar name={space.name} color={space.color} icon={space.icon} className="shrink-0" /> : <span className="size-6 shrink-0 rounded-md bg-muted" />}
          <span className={cn(sidebarLabel, "w-[calc(100cqw-4.75rem)] text-[0.9375rem] font-semibold")}>{space?.name ?? (spaces?.length === 0 ? "No spaces" : "")}</span>
          <ChevronsUpDown className={cn("size-4 shrink-0 text-muted-foreground", sidebarFade)} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={rail ? "right" : "bottom"} align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-60">
        {!spaces?.[0]?.section && <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Spaces</DropdownMenuLabel>}
        <div ref={boxRef} className="relative">
          {spaces?.map((s, i) => (
            <Fragment key={s.name}>
            {s.section && s.section !== spaces[i - 1]?.section && (
              <DropdownMenuLabel className={cn("text-xs font-medium text-muted-foreground", i > 0 && "mt-1.5")}>{s.section}</DropdownMenuLabel>
            )}
            <DropdownMenuItem
              data-index={i}
              onPointerDown={(e) => start(e, i)}
              onSelect={() => navigate(spaceUrl(s.name))}
              className={cn("[-webkit-touch-callout:none]", drag && "focus:bg-transparent", drag?.from === i && "opacity-40")}
            >
              <SpaceAvatar name={s.name} color={s.color} icon={s.icon} className="size-5 text-[0.55rem]" />
              <span className="truncate">{s.name}</span>
              {s.name === current && <Check className="ml-auto" />}
            </DropdownMenuItem>
            </Fragment>
          ))}
          {drag?.line != null && <DropLine top={drag.line} />}
        </div>
        {dragged && (
          <DragGhost ghostRef={ghostRef}>
            <SpaceAvatar name={dragged.name} color={dragged.color} icon={dragged.icon} className="size-5 text-[0.55rem]" />
            <span className="truncate">{dragged.name}</span>
          </DragGhost>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openSpaceDialog()}>
          <Plus /> New space
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/">
            <LayoutGrid /> All spaces
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={(spaces?.length ?? 0) < 2} onSelect={() => openArrangeSpaces()}>
          <ArrowUpDown /> Arrange spaces…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SpaceSidebar() {
  const space = useCurrentSpace()
  const { data: spaces, isLoading: loadingSpaces } = useSpaces()
  const { isLoading } = useTree()
  const { roots } = usePageTree()
  const actions = useVaultActions()
  const { pathname } = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()
  const rail = useSidebarRail()
  const close = () => isMobile && setOpenMobile(false)
  const overview = spaceUrl(space)

  // Every icon sits in one column, 1.75rem from the card's edge, open or
  // collapsed to icons; labels truncate against their row (cqw), which never
  // changes width, so nothing moves or re-truncates while it animates.
  const item = "h-8 gap-2.5 text-[0.875rem] [&>svg]:size-4 [&>svg]:text-muted-foreground data-[active=true]:[&>svg]:text-foreground"
  const label = cn(sidebarLabel, "max-w-[calc(100cqw-2.625rem)]")
  const nav = [
    { to: overview, label: "Overview", icon: House },
    { to: spaceGraphUrl(space), label: "Graph", icon: Network },
    { to: spaceTasksUrl(space), label: "Tasks", icon: ListTodo },
    { to: "/calendar", label: "Calendar", icon: CalendarDays },
  ]
  const search = (side: "top" | "right") => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Search" className="size-9 shrink-0 text-muted-foreground" onClick={() => (close(), openPalette())}>
          <Search className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>
        Search <Kbd className="ml-1">⌘K</Kbd>
      </TooltipContent>
    </Tooltip>
  )

  return (
    <Sidebar variant="floating" collapsible="icon" className="top-[calc(var(--frame-top)-0.5rem)] bottom-[calc(max(0.5rem,var(--sab))-0.5rem)] h-auto data-[side=left]:left-(--sal)">
      <SidebarHeader className="gap-2 px-2 pt-3 pb-1">
        {/*
          The collapse toggle is pinned to the card's right edge: as the card
          narrows it rides in with the edge and comes to rest in the icon
          column, where the brand (fading out) was.
        */}
        <div className="flex h-8 items-center justify-between pr-0.5 pl-2">
          <Link to="/" onClick={close} inert={rail} className={cn("rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring", sidebarFade)}>
            <Brand />
          </Link>
          <SidebarTrigger className="top-3.5 right-3.5 z-10 bg-sidebar text-muted-foreground md:absolute" />
        </div>
        <div className="@container">{loadingSpaces ? <SidebarMenuSkeleton showIcon /> : <SpaceSwitcher current={space} />}</div>
      </SidebarHeader>
      <SidebarContent className="gap-0 px-1">
        {spaces?.length === 0 ? (
          <div inert={rail} className={cn("mx-2 mt-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground", sidebarFade)}>
            Spaces hold your pages, like folders for different parts of your life.
            <Button size="sm" className="mt-3 w-full" onClick={() => openSpaceDialog()}>
              <Plus /> Create a space
            </Button>
          </div>
        ) : (
          <>
            <SidebarGroup className="py-1">
              <SidebarMenu className="gap-px">
                {nav.map(({ to, label: text, icon: Icon }) => (
                  <SidebarMenuItem key={to}>
                    <SidebarMenuButton asChild isActive={pathname === to} tooltip={text} className={item}>
                      <Link to={to} onClick={close}>
                        <Icon />
                        <span className={label}>{text}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>

            {/* The page tree has no icons to leave behind: collapsed, it fades out in place. */}
            <SidebarGroup inert={rail} className={cn("pt-2", sidebarFade)}>
              <SidebarGroupLabel className="text-xs font-medium text-muted-foreground">Pages</SidebarGroupLabel>
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <SidebarGroupAction aria-label="New page or database">
                        <Plus />
                      </SidebarGroupAction>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="right">New page or database</TooltipContent>
                </Tooltip>
                <DropdownMenuContent side="right" align="start" className="w-56">
                  <DropdownMenuItem onSelect={() => (close(), void actions.createPage(space))}>
                    <FilePlus2 /> New page
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => (close(), openNewDatabase(space))}>
                    <Table2 /> New database…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => (close(), openNewDatabase(space, "import"))}>
                    <FileSpreadsheet /> Import CSV or Excel…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <SidebarGroupContent>
                {isLoading ? (
                  Array.from({ length: 5 }, (_, i) => <SidebarMenuSkeleton key={i} />)
                ) : (
                  <PageTree space={space} pages={roots.get(space) ?? []} />
                )}
              </SidebarGroupContent>
            </SidebarGroup>
          </>
        )}
      </SidebarContent>
      <SidebarFooter className="gap-0 border-t px-2 py-2">
        <SidebarFold>
          <div className="pb-1.5 pl-1 empty:hidden">
            <OfflineBadge onNavigate={close} />
          </div>
        </SidebarFold>
        {/* Collapsed to icons, search sits above the account. */}
        <SidebarFold when="rail">
          <div className="flex flex-col pb-1 pl-0.5">{search("right")}</div>
        </SidebarFold>
        <div className="@container flex items-center gap-1">
          <UserMenu onNavigate={close} side={rail ? "right" : "top"} />
          <div inert={rail} className={cn("flex", sidebarFade)}>
            {search("top")}
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
