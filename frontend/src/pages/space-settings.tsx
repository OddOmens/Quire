import { useEffect, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"
import { ArrowLeft, Check, Download, FileText, FolderTree, Globe, HardDrive, Hash, Link2, Type } from "lucide-react"
import { Link, useNavigate, useParams } from "react-router"
import { toast } from "sonner"

import { Page } from "@/components/page-header"
import { IconPicker } from "@/components/icon-picker"
import { SPACE_COLORS } from "@/components/space-dialog"
import { SpaceAvatar } from "@/components/space-avatar"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/hooks/use-vault"
import { api, spaceExportUrl, type SpaceDetails } from "@/lib/api"
import { formatBytes, relativeTime, spaceSettingsUrl, spaceUrl } from "@/lib/notes"

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4 border-b py-8 last:border-b-0 md:grid-cols-[14rem_1fr] md:gap-10">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

export default function SpaceSettingsPage() {
  const { space: name = "" } = useParams()
  const { data, isLoading, error } = useQuery({ queryKey: ["space", name], queryFn: () => api.spaceDetails(name) })

  if (error) {
    return (
      <Page>
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyTitle>No space called “{name}”</EmptyTitle>
            <EmptyDescription>It may have been renamed or deleted.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild variant="outline">
              <Link to="/">All spaces</Link>
            </Button>
          </EmptyContent>
        </Empty>
      </Page>
    )
  }

  return (
    <Page>
      <div className="mx-auto w-full max-w-4xl px-6 py-10 sm:px-10 md:py-14">
        <Link to={spaceUrl(name)} className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> {name}
        </Link>
        <h1 className="text-2xl font-bold tracking-[-0.02em]">Space settings</h1>
        {isLoading || !data ? (
          <Skeleton className="mt-8 h-96 rounded-lg" />
        ) : (
          <div className="mt-4">
            <Section title="General" description="How the space appears in the sidebar and on Home.">
              <GeneralForm space={data} />
            </Section>
            <Section title="Details" description="What's in this space right now.">
              <Stats space={data} />
            </Section>
            <Section title="Export" description="Download every page in this space, with its sub-pages and the attachments they use, as Markdown files in a zip.">
              <Button variant="outline" asChild>
                <a href={spaceExportUrl(data.name)} download>
                  <Download /> Download {data.name}.zip
                </a>
              </Button>
            </Section>
            <Section title="Delete space" description="Moves the space and all its pages to the trash, where you can restore them for 30 days.">
              <DeleteSpace name={data.name} />
            </Section>
          </div>
        )}
      </div>
    </Page>
  )
}

function GeneralForm({ space }: { space: SpaceDetails }) {
  const [name, setName] = useState(space.name)
  const [description, setDescription] = useState(space.description)
  const [color, setColor] = useState(space.color)
  const [icon, setIcon] = useState(space.icon ?? "")
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const navigate = useNavigate()
  useEffect(() => {
    setName(space.name)
    setDescription(space.description)
    setColor(space.color)
    setIcon(space.icon ?? "")
  }, [space])
  const changed = name.trim() !== space.name || description !== space.description || color !== space.color || icon !== (space.icon ?? "")

  return (
    <form
      className="grid max-w-md gap-5"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        try {
          const sp = await api.updateSpace(space.name, { name: name.trim(), description, color, icon })
          for (const key of ["spaces", "tree", "note", "graph", "space"]) qc.invalidateQueries({ queryKey: [key] })
          if (sp.name !== space.name) navigate(spaceSettingsUrl(sp.name), { replace: true })
          toast.success("Space saved")
        } catch (err) {
          toast.error(errorMessage(err))
        } finally {
          setBusy(false)
        }
      }}
    >
      <div className="flex items-end gap-3">
        <SpaceAvatar name={name || "?"} color={color} icon={icon} className="size-10 rounded-lg text-sm" />
        <div className="grid flex-1 gap-1.5">
          <Label htmlFor="sp-name">Name</Label>
          <Input id="sp-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </div>
      </div>
      <p className="-mt-3 text-xs text-muted-foreground">Renaming moves the folder on disk and updates links to its pages.</p>
      <div className="grid gap-1.5">
        <Label htmlFor="sp-desc">Description</Label>
        <Textarea id="sp-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={280} placeholder="What's this space for?" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="sp-icon">Icon</Label>
        <IconPicker id="sp-icon" value={icon} onChange={setIcon} name={name} color={color} />
      </div>
      <div className="grid gap-2">
        <Label>Colour</Label>
        <div className="flex flex-wrap gap-2">
          {SPACE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Colour ${c}`}
              aria-pressed={c === color}
              onClick={() => setColor(c)}
              className={cn("grid size-7 place-items-center rounded-full ring-offset-2 ring-offset-background transition", c === color && "ring-2 ring-foreground/70")}
              style={{ background: c }}
            >
              {c === color && <Check className="size-3.5 text-white" />}
            </button>
          ))}
        </div>
      </div>
      <Button type="submit" className="justify-self-start" disabled={!changed || !name.trim() || busy}>
        Save changes
      </Button>
    </form>
  )
}

function Stats({ space }: { space: SpaceDetails }) {
  const items = [
    { icon: FileText, label: "Pages", value: space.pages.toLocaleString(), hint: space.nested ? `${space.topLevel} top-level · ${space.nested} sub-pages` : undefined },
    { icon: Type, label: "Words", value: space.words.toLocaleString() },
    { icon: Link2, label: "Links", value: space.links.toLocaleString(), hint: "Between pages" },
    { icon: Globe, label: "Shared", value: space.shared.toLocaleString(), hint: space.shared === 1 ? "Page on the web" : "Pages on the web" },
    { icon: HardDrive, label: "Size", value: formatBytes(space.size), hint: `${space.files} ${space.files === 1 ? "file" : "files"}` },
    { icon: FolderTree, label: "Folder", value: space.folder, hint: "In your vault", mono: true },
  ]
  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
        {items.map((i) => (
          <div key={i.label} className="bg-background p-4">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <i.icon className="size-3.5" /> {i.label}
            </div>
            <div className={cn("mt-1 text-lg font-semibold tracking-tight", i.mono ? "font-mono text-sm leading-6 break-all" : "truncate")}>{i.value}</div>
            {i.hint && <div className="truncate text-xs text-muted-foreground">{i.hint}</div>}
          </div>
        ))}
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-[8rem_1fr]">
        <dt className="text-muted-foreground">Last edited</dt>
        <dd>{space.updated ? `${new Date(space.updated).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} (${relativeTime(space.updated)})` : "Never"}</dd>
        <dt className="text-muted-foreground">Oldest page</dt>
        <dd>{space.created ? new Date(space.created).toLocaleDateString(undefined, { dateStyle: "medium" }) : "None yet"}</dd>
        <dt className="text-muted-foreground">Tags</dt>
        <dd className="flex flex-wrap gap-1.5">
          {space.tags.length ? (
            space.tags.map((t) => (
              <Link key={t.tag} to={`/tags/${encodeURIComponent(t.tag)}`} className="inline-flex items-center gap-0.5 rounded bg-tag-soft px-1.5 py-0.5 text-xs text-tag hover:underline">
                <Hash className="size-3" />
                {t.tag}
                <span className="ml-0.5 opacity-60">{t.count}</span>
              </Link>
            ))
          ) : (
            <span className="text-muted-foreground">None yet</span>
          )}
        </dd>
      </dl>
    </div>
  )
}

function DeleteSpace({ name }: { name: string }) {
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const navigate = useNavigate()
  return (
    <div className="grid max-w-md gap-2">
      <Label htmlFor="sp-confirm" className="font-normal text-muted-foreground">
        Type <span className="font-medium text-foreground">{name}</span> to confirm.
      </Label>
      <div className="flex gap-2">
        <Input id="sp-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={name} autoComplete="off" />
        <Button
          variant="destructive"
          disabled={confirm !== name || busy}
          onClick={async () => {
            setBusy(true)
            try {
              await api.deleteSpace(name)
              for (const key of ["spaces", "tree", "note", "graph", "trash"]) qc.invalidateQueries({ queryKey: [key] })
              navigate("/", { replace: true })
              toast(`Moved “${name}” to the trash`, { action: { label: "View trash", onClick: () => navigate("/trash") } })
            } catch (e) {
              toast.error(errorMessage(e))
            } finally {
              setBusy(false)
            }
          }}
        >
          Delete space
        </Button>
      </div>
    </div>
  )
}
