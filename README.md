# Quire

A self-hosted knowledge base. You organise pages into spaces and nest sub-pages, and you edit them visually with a block editor. Every page is still a plain Markdown file on your server.

Quire is one of three self-hosted apps from Odd Omens that are made to work together: **Quire** for notes and documents, [Coffer](https://github.com/OddOmens/Coffer) for files, and [Docket](https://github.com/OddOmens/Docket) for tracking work. Quire backs itself up into Coffer.

**Writing**

- **Spaces and nested pages.** Each space is a folder, each page is a `.md` file, and sub-pages live in a folder named after their parent.
- **Visual editor.** Press `/` for blocks: headings, lists, to-dos, quotes, callouts, toggles, code with syntax highlighting, tables, math (KaTeX), Mermaid diagrams, images, video, audio, PDF previews, file attachments, web bookmarks, embeds (YouTube, Figma, Google Docs and more) and dividers. Select text for the formatting toolbar.
- **Links and backlinks.** Type `[[` to link a page. Each page's side panel lists the pages that link to it. Renames and moves rewrite links for you.
- **Databases, formulas and forms.** Turn any page into a database with typed columns, table, board, calendar, gallery and chart views, spreadsheet-style formulas, and forms that collect rows. The rows are a plain `.csv` file beside the page. See [Databases](#databases).

**Finding things**

- **Search, tags, graph.** `⌘K` searches page titles and full text. `#tags` work anywhere on a page. Each space has a graph of how its pages link together.
- **Open tasks.** Each space's **Tasks** view gathers every unchecked `- [ ]` item from its pages. Ticking one checks it off on its page.
- **Missing links.** A space's overview lists `[[links]]` to pages that don't exist yet, with a button to create each one.
- **Calendar.** One calendar of every dated row across your databases.

**Keeping it safe**

- **History and trash.** Page versions you can restore, including changes made to the files outside Quire. Deleted pages and spaces stay in the trash for 30 days. A page deleted or moved by something other than Quire keeps its history, and the trash lists it under **Deleted outside Quire**.
- **Backups to [Coffer](https://github.com/OddOmens/Coffer)**, encrypted by Coffer, on a schedule. See [Backups with Coffer](#backups-with-coffer).
- **Secret warnings.** If a page looks like it holds a password, token or private key, Quire warns you, since pages are plain text and copied into backups.
- **Sign-in** with a password and optional two-factor codes. See [Security](#security).

**Everything else**

- **Sharing.** Publish a single page read-only to anyone with the link.
- **Import** Markdown folders, an Obsidian vault, or a Notion or Docmost export. See [Import](#import).
- **Attachments manager** to find and clear out files no page uses. See [Attachments](#attachments).
- **Live sync.** Open tabs update when you edit on another device, or when the files change on disk.
- **Works on phones** as an installable web app.

**You need** Docker with Compose on any Linux machine (x86-64 or ARM64). Quire is for one person: a single account, with share links and public forms for anyone else.

## Contents

- [Run it](#run-it)
- [Using the editor](#using-the-editor)
- [Databases](#databases), [Formulas](#formulas), [Forms](#forms), [Calendar](#calendar)
- [Import](#import) and [Attachments](#attachments)
- [Backups with Coffer](#backups-with-coffer)
- [Leaving it running](#leaving-it-running)
- [Security](#security)
- [Configuration](#configuration)
- [How pages are stored](#how-pages-are-stored)
- [API](#api)
- [Development](#development)

## Run it

```sh
cp .env.example .env            # optional
docker compose up -d --build
docker compose logs quire       # look for the setup code
```

Open `http://127.0.0.1:8196` on the server. Docker publishes the port on this machine only; reach it from other devices through Tailscale Serve or a reverse proxy, or set `QUIRE_BIND` in `.env` to the address to listen on (your LAN or Tailscale address, or `0.0.0.0` for every network). Enter the setup code from the log, your name and a password. The code means only someone who can read the server's logs can claim the account. For unattended installs, set `QUIRE_PASSWORD` (and optionally `QUIRE_NAME`) on the first start instead; it's only read while there's no account yet.

To use Quire on iPhone, serve it over HTTPS (for example `tailscale serve --bg --https=443 http://127.0.0.1:8196`), open it in Safari, then **Share → Add to Home Screen**. Behind a proxy like that, set `QUIRE_TRUSTED_PROXIES` so Quire sees real addresses; Settings → About warns you when it notices an untrusted proxy.

Installed that way, Quire runs full screen like an app on iPhone and iPad:

- It keeps clear of the notch and the home bar, upright or on its side, and starts on a screen of its own colour instead of a white flash. The status bar is the system's own, so the clock and battery can be read in light and dark.
- While you edit a page, a bar sits above the keyboard (or along the bottom with a hardware keyboard) with what a touch screen has no other way to reach: add a block, turn a block into another kind, the block's menu (move, duplicate, colour, delete), bold and the other text styles, colours, links, lists, moving a list item in or out a level, undo and redo. The page ends above the keyboard, so the line you're typing is never under it.
- Tap into a block and a grip (⋮⋮) shows in the margin beside it. Drag the grip to move the block: a line shows where it will land, and the page scrolls when you get near the top or bottom. Tap the grip for the block's menu. List items move within lists, and a toggle is picked up by its title. Dropping a block beside another to make columns needs a wider screen than a phone's.
- Wide things scroll inside their own box rather than the page: a table with more columns than fit, a database's grid and board, a long formula. A database's views get a row of their own above its search, filter and sort.
- The app's own files are kept on the device by a service worker, so it starts without waiting on the network. Nothing you've written is kept there unless you ask for it.
- **Offline.** Settings → Offline → *Available offline* downloads every page, database and attached file to that browser, so Quire opens, reads and searches with no connection (or away from the network your server is on). Pages you edit or create offline are sent the next time Quire reaches the server; if a page changed on another device meanwhile, you choose which version to keep and both stay in its history. Editing databases, renaming, moving or deleting pages, uploads and sharing still need a connection. The copy isn't encrypted, each device has its own switch, and signing out removes it. A web app can only sync while it's open.

### Forgot your password

Stop Quire, reset the account, and start it again:

```sh
docker compose stop quire
docker compose run --rm quire reset-account
docker compose start quire
docker compose logs quire       # look for the new setup code
```

`reset-account` deletes the account (password, two-factor and recovery codes) and signs out every device. Pages, page history, share links and backup settings stay. Then set up the account again with the new setup code, as on the first run. It refuses to run while Quire is using the data folder, so stop Quire first. Outside Docker, run `quire reset-account` with the same `QUIRE_DATA_DIR`.

## Using the editor

- **Arrange the sidebar.** Drag a page between others to reorder it, or onto a page to nest it there (on a phone, press and hold first). The page's `⋯` menu also has **Move up**, **Move down** and **Move to…**.
- **Arrange your spaces.** Drag a space up or down in the space menu, or choose **Arrange spaces…** there to reorder them with the arrow buttons. Home, search and **Move to…** list spaces in the same order.
- **Reorder blocks.** Drag the ⋮⋮ handle beside any block or list item, or press ⌘⇧↑ / ⌘⇧↓ (or ⌥↑ / ⌥↓). Click the handle to turn a block into another kind, duplicate it or delete it.
- **Lists.** Tab nests an item under the one above it, to any depth, and ⇧Tab moves it back out.
- **Undo and redo** with ⌘Z / ⌘⇧Z (or Ctrl+Y), or the arrows in the page header.
- **Narrow or full width.** Pages use a comfortable reading width. Turn on **Full width** in a page's `⋯` menu to use the whole window; it sets `width: full` in the front matter, and shared pages follow it.

## Databases

Choose **New database…** from the `+` beside **Pages** (or **Add database** in a page's `⋯` menu in the sidebar), start blank or from a template (Tracker, Calendar, Budget), and add columns from the grid. **Import CSV or Excel…** makes a database from a `.csv`, `.tsv` or `.xlsx` file and guesses each column's type from its values. Any existing page can become one with **Turn into database** in its `⋯` menu; its text stays above the rows.

A database is still a page. It's marked with `database: true` in its front matter, and two files sit beside it:

```
Product/
  Budget.md                ← the page: front matter and any text above the rows
  Budget.csv               ← the rows: _id, _created, then a column per field, by name
  Budget.schema.json       ← column types, formulas, views and forms
```

Both move, go to the trash and come back with the page, and are backed up with it. The CSV opens in any spreadsheet; columns you add there show up as text columns.

- **Column types:** text, number (plain, currency or percent), select, multi-select, date (with or without a time), checkbox, link, email, phone, page (`[[link]]`), files, relation (rows of another database), formula, rollup (sum, count, average… of a column in the related rows) and created time. Values are checked as you type: `$1,200` becomes the number 1200, `tomorrow` a date, and a new select value becomes an option.
- **Views:** a table like a sheet, a board with a lane per select option, a calendar, a gallery of cards and a chart (bar, line or pie). Each view has its own filters (all or any of them), sorting, hidden columns and column totals (sum, average, median, min, max, count, unique, percent checked…).
- **Export** with **Download as CSV**, formulas worked out. Text that a spreadsheet would run as a formula (starting with `=`, `+`, `-` or `@`) gets a leading `'`, so opening the file can't execute anything.
- **Data history:** earlier versions of the rows and of the columns are kept like page history (edits within ten minutes count as one version) and can be restored from the database's `⋯` menu.

Limits: 50,000 rows and 200 columns per database, 100 KB per cell.

## Formulas

Formulas read like Google Sheets, with column names instead of cell addresses:

- `{Price}` is this row's Price; `[Price]` is the whole column, as a list; `[Expenses/Amount]` is a column of another database, found like a `[[link]]`.
- `+ - * / ^ %`, `&` joins text, and `= <> < > <= >=` compare (text without regard to case). An operator between lists works row by row: `SUM([Price] * [Qty])`.
- Examples: `{Price} * {Qty}`, `IF({Paid}, 0, {Amount})`, `ROUND({Amount} / SUM([Amount]) * 100)`, `SUMIF([Category], "Food", [Amount])`, `COUNTIFS([Status], "Done", [Due], "<" & TODAY())`, `SUM(FILTER([Amount], [Category] = "Rent"))`, `XLOOKUP({Code}, [Rates/Code], [Rates/Rate])`, `DATEDIF({Start}, TODAY(), "M")`.
- Functions: numbers (`SUM`, `AVERAGE`, `MIN`, `MAX`, `MEDIAN`, `ROUND`, `MOD`, `SUMPRODUCT`…), logic (`IF`, `IFS`, `SWITCH`, `IFERROR`, `AND`, `OR`, `NOT`, `ISBLANK`…), conditional totals (`SUMIF(S)`, `COUNTIF(S)`, `AVERAGEIF(S)`, `MAXIFS`, `MINIFS`), lists and lookups (`FILTER`, `UNIQUE`, `SORT`, `INDEX`, `MATCH`, `XLOOKUP`, `TEXTJOIN`, `SPLIT`), text (`CONCAT`, `LEFT`, `MID`, `UPPER`, `TRIM`, `SUBSTITUTE`, `TEXT`, `REGEXMATCH`…) and dates (`TODAY`, `NOW`, `DATE`, `YEAR`, `DAYS`, `DATEDIF`, `EDATE`, `EOMONTH`, `NETWORKDAYS`, `WORKDAY`…). The formula editor lists them all.
- Errors show in the cell (`#DIV/0!`, `#REF!` for a column that isn't there, `#CYCLE!` for formulas that depend on each other); hover for the reason.

Formulas are worked out on the server each time a database is read, never stored, in your browser's time zone, so `TODAY()` is your today. A request's formulas share a budget of steps; one that runs out shows `#SLOW!` instead of tying up the server.

**On any page**, write a formula between double braces, or choose **Formula** from the `/` menu: `We've spent {{ SUM([Budget/Amount]) }} so far.` It shows as a live value and is saved as written. Shared pages show the formula itself, since they can't read your databases.

## Forms

Open **Forms…** from a database's `⋯` menu to build a form from its columns: labels, help text, required fields, fixed values for columns the form doesn't ask about (a `Source` of `Website`, say), and a thank-you message. Each answer becomes a row.

- **Inside Quire** a form is a quick way to add rows, from a phone too.
- **A public link** (`/f/<token>`) serves the form to anyone with the link as a plain HTML page: no script, no sign-in, and nothing else of Quire. A select answer must be one of the options. Answers need a signed timestamp from when the form was shown (at least two seconds old, at most a day), a hidden field catches bots, each address can send a handful of answers per 15 minutes (with a cap for everyone together), and a form can close itself after a number of answers. Text answers that a spreadsheet would run as a formula (starting with `=`, `+`, `-` or `@`) are saved with a leading `'`. Remove the link and it stops working at once.

By default the public link works on Quire's own address, so only people who can already reach Quire (your network, your Tailscale) can use it. To take answers from the internet without exposing Quire, set `QUIRE_PUBLIC_LISTEN` (say `:8081`): Quire then also listens there and serves **only** public forms. Point a tunnel or reverse proxy at that address. That's a deliberate choice: it puts the form endpoint on the internet, and nothing else. It's off unless you set it.

## Calendar

**Calendar** in the sidebar shows, month by month, every row placed on a date by a calendar view in any database, coloured by the row's first select column. Click a row to open it. The **Calendar** template makes a database for this: a date and time, an optional end, a type (maintenance, reminder, event), a done checkbox and notes.

## Import

**Settings → Import** takes a zip of Markdown (plain folders, an Obsidian vault, or a Notion or Docmost Markdown export) or a few `.md` files, into a new space or an existing one.

- Folders become sub-pages, and a folder's `index.md` or `README.md` becomes its page.
- Notion's ids come off the names.
- Pictures and files the pages use move to `attachments/`, and relative links to pages become `[[links]]`.
- Nothing is overwritten: a page whose name is taken gets a number.
- Imported pages start their history as "Imported", and a summary lists what was renamed or skipped.

Uploads are limited to 500 MB, 20,000 files and 2 GB unpacked. A zip with paths outside itself is refused.

## Attachments

**Settings → Attachments** lists every file in `attachments/` with its size, date and the pages that use it (including pages in the trash), and the total size.

- Filter to the unused ones and move them to the trash, where they wait 30 days like deleted pages.
- A file that only an old version of a page mentions counts as unused, and says it may appear in old versions.
- Renaming a file updates the links to it.
- Quire never deletes an attachment by itself.

## Backups with Coffer

Quire backs up to [Coffer](https://github.com/OddOmens/Coffer) over WebDAV, and Coffer encrypts what it stores. Each run sends only what changed: the vault file for file, plus a consistent snapshot of the database. The snapshot holds your account, page history and share links; sign-in sessions are left out.

1. **In Coffer, make the destination encrypted.** Add an R2, S3 or Backblaze B2 drive with **Encrypt files** turned on, and save its recovery key. Alternatively, use a local folder that a Coffer **backup** sends to such a drive; that also gives you dated snapshots.
2. **In Coffer, create an app password** under **Settings → Connect**.
3. **In Quire, go to Settings → Backups.** Enter Coffer's address, your Coffer username, the app password and a folder starting with the drive's name, such as `Encrypted R2/Backups/Quire`. Pick how often to back up, then **Test connection** and **Save**. Saving asks for your Quire password, since backups receive a copy of everything.

The app password is stored sealed with a key in Quire's data folder (`secret.key`), never in the database. If that key is lost or replaced, Quire still starts and keeps your backup settings, but pauses backups until you enter the app password again under Settings → Backups. Plain `http://` is only accepted for Coffer on this machine or your private network (LAN or Tailscale); anything else needs `https://`.

In the bucket, the provider sees only ciphertext. Through Coffer you get the original files back. The backup folder looks like this:

```
notes/        the vault: copy it into QUIRE_NOTES_DIR
deleted/      files that left the vault, by day, kept for 30 days
quire.db      the database: copy it into QUIRE_DATA_DIR
backup.json   when and what
```

A file you delete in Quire is moved into `deleted/<date>/` in the backup rather than deleted. A run that would remove a large share of the backup at once (more than 50 files, or at least 10 that are over a fifth of it) is skipped with a warning, since that looks more like a folder that went missing; `POST /api/backup/run?allowLargeDelete=1` lets the next run go ahead.

**To restore:** stop Quire, download the folder from Coffer (as a zip, or with WebDAV or rclone), put `notes/` in place as your notes folder and `quire.db` in your data folder, then start Quire and sign in.

## Leaving it running

Quire is built to run for years without attention:

- **Nothing grows unchecked.** Every hour it empties trash older than `QUIRE_TRASH_DAYS` (and the history of those pages), deletes expired sessions, forgets old failed sign-ins, and runs SQLite's `PRAGMA optimize`. Each page keeps a limited number of versions, and the database's write-ahead log is capped at 64 MB.
- **A missing notes folder loses nothing.** If the folder is briefly empty (a network drive that mounts late, say), page history is kept, no starter pages are written into it, and backups refuse to run rather than empty the copy in Coffer.
- **It tells you when something's wrong.** Settings → About lists anything that needs attention: backups that aren't set up, failing, more than a few days old or waiting for the Coffer app password, and a proxy Quire doesn't trust. You also get one quiet notice when you open Quire.
- **Docker logs** are capped at three 10 MB files.
- **It restarts itself** after a crash or a reboot (`restart: unless-stopped`), and Docker's health check watches it.
- **Your pages are plain Markdown files.** If the database is ever damaged, Quire logs that at startup. Your pages are unaffected; restore `quire.db` from a backup, or delete it to start a fresh account and let Quire re-index the files.
- **No outside dependencies at runtime.** The image is one static binary with the web app, fonts, math and diagram libraries built in. It doesn't call any service except the Coffer you point backups at.

## Security

- **Passwords** are hashed with Argon2id. There's a minimum length, and changing the password signs out every other device.
- **Two-factor sign-in** uses TOTP from any authenticator app, with ten single-use recovery codes. A code can't be reused.
- **Sessions** are random 256-bit tokens stored only as hashes. You can see and revoke each device under Settings → Devices. They expire after 60 days without use.
- **Brute force:** sign-in, setup and password checks lock out an address after repeated failures (IPv6 by its /64), and when failures arrive from many addresses, attempts take turns, one every few seconds. Wrong two-factor codes are also counted for the account as a whole, so guessing from many addresses doesn't help.
- **CSRF:** cookies are `HttpOnly` and `SameSite=Lax`. Writes must also carry the app's `X-Client-Id` header and pass an Origin check.
- **Browser hardening:** strict Content Security Policy, `X-Frame-Options: DENY`, `nosniff`, no referrers, and HSTS over HTTPS. Pages may show a frame only for an attached PDF or for a fixed list of players and viewers behind the Embed block (YouTube, Vimeo, Loom, Spotify, SoundCloud, Apple Music and Podcasts, Figma, CodePen, CodeSandbox, Google Docs, Drive and Maps, Miro, Airtable). Those frames are sandboxed and can't navigate the page. A YouTube frame is told Quire's address (not the page); YouTube won't play otherwise.
- **Files:** every file operation goes through `os.Root`, so no path can leave the vault. Uploads are served with a sandboxing CSP, and anything that isn't media downloads as plain bytes instead of opening, so an uploaded script or stylesheet can never run. A real PDF is served without the sandbox, so browsers can show it in a frame on Quire's own pages; a `.pdf` that isn't one downloads.
- **Bookmarks:** when you add a web bookmark, the server reads that page once for its title, description and picture, and remembers the answer for a week (in memory only). It asks only while you're signed in, connects only to public internet addresses on ports 80 and 443 (never this machine, your home network or a tailnet, including through redirects or DNS tricks), sends no cookies or referrer, and reads at most 1 MB. The picture and icon then load in your browser from the other site, as any remote image in a page does.
- **Share links** expose one page and only the attachments that page embeds. Links to other pages show as plain text. Shared pages aren't indexed by search engines. A page deleted or renamed outside Quire loses its share and form links, so a different page saved later at the same path is never published by an old link.
- **Public forms** are server-rendered HTML with no script. They write only the form's own fields, need a signed timestamp, catch bots with a hidden field, and are rate-limited per address and overall. `QUIRE_PUBLIC_LISTEN` serves them alone on a separate address, off by default.
- **Formulas** can only read database values; they can't reach files, the network or the system, and a step budget stops runaway ones.
- **Container:** distroless, non-root, read-only root filesystem, no capabilities.

**What isn't encrypted.** Pages are plain Markdown files, and Quire doesn't encrypt them or its database on the server's disk; the database also holds your two-factor secret and share-link tokens. Anyone who can read the notes and data folders can read them, so keep both private to the user Quire runs as, on an encrypted disk if the machine could be lost or stolen. Backups are encrypted by Coffer when they go to an encrypted drive.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `QUIRE_NOTES_DIR` | `/notes` | The vault: one folder per space |
| `QUIRE_DATA_DIR` | `/data` | Account, devices, page history, share links, search index |
| `QUIRE_TRASH_DAYS` | `30` | How long deleted pages stay restorable |
| `QUIRE_TRUSTED_PROXIES` | (none) | CIDRs allowed to set `X-Forwarded-For`; loopback is always trusted |
| `QUIRE_SCAN_INTERVAL` | `10s` | How often to pick up edits made outside Quire |
| `QUIRE_PASSWORD`, `QUIRE_NAME` | (none) | Create the account on first start, skipping the setup screen |
| `QUIRE_LISTEN` | `:8080` | Listen address inside the container |
| `QUIRE_PUBLIC_LISTEN` | (none) | A second address that serves only public forms; off unless set (see [Forms](#forms)) |

Back up both folders. The notes folder is your content. The data folder holds history and your account; its search index rebuilds itself if lost.

## How pages are stored

```
notes/
  .order.json              ← the order of the spaces, if you've rearranged them
  Product/                 ← a space
    .space.json            ← its description, colour and icon
    .order.json            ← the sidebar order of its pages, if you've rearranged them
    Roadmap.md             ← a page
    Roadmap/
      Q1.md                ← a sub-page of Roadmap
    Budget.md              ← a database page (database: true)
    Budget.csv             ← its rows
    Budget.schema.json     ← its columns, views and forms
  attachments/             ← pasted images and files
  .trash/                  ← deleted pages, spaces and attachments, restorable
```

An `.order.json` is a list of page names, such as `["Roadmap", "Ideas"]`; the one at the top of the notes folder lists space names the same way. Pages or spaces it doesn't list, like ones you add on disk, come after the listed ones in alphabetical order. Without the file, they're alphabetical.

The editor reads and writes standard Markdown with a few widely used extensions:

- front matter, of which Quire reads `tags`, `secrets: ok`, `width: full` (or `narrow` on a database) and `database: true`; other keys are kept as written
- formulas as `{{ … }}`
- `[[wikilinks]]`, with `#heading` and `|alias`
- `==highlights==`
- GitHub/Obsidian callouts: `> [!note]`, `tip`, `warning`, `danger`
- toggles as `<details><summary>`
- math as `$…$` and `$$…$$`
- Mermaid diagrams as ` ```mermaid ` code blocks
- videos, audio and PDF previews as `![](attachments/clip.mp4)`
- web bookmarks as `[Title](https://example.com "bookmark")` and embeds as `[Title](https://youtu.be/… "embed")`
- dates as `@2026-11-20`; on a to-do it's the due date, and dated lines show on the calendar
- task lists and tables

A page that uses Markdown the visual editor can't represent (other raw HTML, footnotes, reference-style links) opens in a source editor, so saving never drops anything. You can switch any page to source editing from its `⋯` menu.

You can edit the files with anything else; Quire picks up the changes and keeps them in the page's history, the same way it keeps its own edits (changes within ten minutes of each other count as one version). A file that goes missing for a while, such as on a network drive that mounts late, keeps its history. Markdown files dropped at the vault root are moved into a space called `General`.

## API

The web UI uses a JSON API that a native app can use as-is. Sign in with `POST /api/auth/login {"password", "code", "device"}`. `code` is the TOTP or recovery code when two-factor is on; if it's missing, the response is `401` with `"twoFactor": true`. Sign-in returns a `token`; send it as `Authorization: Bearer <token>`. `GET /api/auth/session` says whether you're signed in; when you are, it also lists `warnings` (`{id, message, section}`) that need your attention.

| | |
| --- | --- |
| `GET /api/spaces`, `POST /api/spaces`, `PATCH`/`DELETE /api/spaces/{name}` | Spaces, in your order: `name`, `description`, `color` (`#rrggbb`) and `icon` (a Lucide icon name like `book-open`; `""` clears it, left out on spaces without one). Once you've arranged them, a new space goes last |
| `POST /api/spaces/order` | Reorder spaces `{names}`: the spaces in their new order; ones left out follow in their current order. Returns the spaces like `GET /api/spaces` |
| `GET /api/tree` | All pages (metadata), sub-page folders, and `order`: each folder's custom page order |
| `GET /api/notes/{path}` | A page with content, `rev`, backlinks, outgoing links, and `warnings` when there are any |
| `PUT /api/notes/{path}` | Save `{content, baseRev}`; `409` with the current version if `baseRev` is stale |
| `POST /api/notes` | Create `{parent, title, content}`; parent is a space or a page path |
| `DELETE /api/notes/{path}` | Move a page and its sub-pages to the trash |
| `POST /api/move` | Move or rename `{from, to}`, with sub-pages, rewriting links |
| `POST /api/reorder` | Place a page `{path, parent, before}`: under `parent` (a space or page), before the sibling page `before` or last; moves it first if the parent changed |
| `GET /api/search?q=` | Full-text search (`q=#tag` for a tag) |
| `GET /api/history/{path}`, `GET /api/revisions/{id}`, `POST /api/revisions/{id}/restore` | Page history |
| `GET /api/deleted-pages` | Pages with history but no file (deleted or moved outside Quire): `path`, `updated`, `versions` and `latest`, the revision to restore |
| `GET /api/trash`, `POST /api/trash/{id}/restore`, `DELETE /api/trash/{id}` | Trash |
| `GET`/`POST /api/shares`, `DELETE /api/shares/{token}` | Share links |
| `GET /api/spaces/{name}`, `GET /api/spaces/{name}/export` | Space details; the space as a zip |
| `GET /api/spaces/{name}/tasks` | Open to-dos: `path`, `title`, `rev`, `line` (1-based), `text`, `heading`, `depth`. Tick one by saving that line with `[x]` and `baseRev: rev` |
| `GET /api/spaces/{name}/missing-links` | Links that lead nowhere: `target` and the `pages` that link to it |
| `GET`/`PUT`/`DELETE /api/backup`, `POST /api/backup/test`, `POST /api/backup/run` | Backups to Coffer |
| `POST /api/attachments`, `GET /api/files/{path}` | Upload and download files |
| `GET /api/attachments` | Every attachment: `path`, `size`, `mtime`, `pages` and `trashed` (pages, and pages in the trash, that use it), and `history` when only old versions mention it; plus the `total` size |
| `POST /api/attachments/trash`, `POST /api/attachments/rename` | Move unused attachments to the trash `{paths}` (ones a page uses are kept, with the reason); rename one `{path, name}` in its folder, updating links |
| `POST /api/import?space=` or `?newSpace=` | Import a multipart upload of `file` parts (one `.zip`, or `.md` files and what they use). Returns `space`, `pages`, `attachments`, `firstPage`, `renamed` (`{from, to}`) and `skipped` (`{path, reason}`) |
| `GET /api/events` | Server-sent events when pages change |
| `GET /api/tables`, `POST /api/tables`, `POST /api/tables/convert`, `POST /api/tables/import` | List databases; create one `{parent, title, template}`; turn a page into one `{path}`; create one from an uploaded file (`parent`, `title`, `file`) |
| `GET /api/tables/{path}` | A database: `schema`, `rows` (`id`, `created`, `cells` by column id), computed `values`, formula `errors`, `related` row titles and relation `targets`, and `rev` |
| `PUT /api/tables/{path}/schema` | Save `{schema, baseRev}`; `409` if `baseRev` is stale |
| `POST`/`PATCH /api/tables/{path}/rows`, `POST …/rows/delete`, `POST …/rows/move` | Add `{rows, before}`, change `{rows: [{id, cells}]}`, delete `{ids}`, reorder `{ids, before}`. Cells are text as typed; they're checked and stored in their column's form |
| `POST /api/tables/{path}/preview`, `POST /api/formulas`, `GET /api/formulas/functions` | Try a column formula; work out page formulas `{path, formulas}`; the function list |
| `GET /api/tables/{path}/export`, `POST …/import`, `GET …/history`, `POST …/restore` | CSV out and in, data history and restoring a version `{revision}` |
| `POST /api/tables/{path}/forms/{id}/submit` | Answer a form `{answers}`; `400` with `problems` by column id |
| `GET`/`POST /api/form-links`, `DELETE /api/form-links/{token}` | Public form links |
| `GET /api/calendar?from=&to=` | Rows on every database's calendar views between two dates |

Send `X-Timezone` (an IANA name like `America/Chicago`) so `TODAY()` and creation times use your zone.

A page's `warnings` are possible secrets, each `{kind, label, line, preview}`. `preview` is the first four characters and a mask; the value itself is never returned or logged.

## Development

Go runs in Docker, so you only need Docker and Node.

```sh
cd frontend && npm install && cd ..
make test     # Go tests
make run      # build everything and serve on 127.0.0.1:8196 with ./notes (password: quire-local-dev)
make dev      # in another terminal: Vite with hot reload on :5173
```

- `backend/`: Go server
  - `internal/vault`: files, spaces, trash
  - `internal/store`: SQLite (index, account, history, shares)
  - `internal/auth`: Argon2id, TOTP
  - `internal/backup`: backups to Coffer over WebDAV
  - `internal/secrets`: the possible-secret check
  - `internal/table`: database files, column types, relations and rollups
  - `internal/formula`: the formula language
  - `internal/importer`: turns a zip of Markdown from elsewhere into pages
  - `internal/server`: HTTP
- `frontend/`: React, Vite, Tailwind and shadcn/ui
  - `src/editor`: Tiptap block editor
  - `src/components/database`: database views, cells and forms
  - `src/lib/markdown.ts` and `serialize.ts`: Markdown ↔ editor conversion

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to send changes and [SECURITY.md](SECURITY.md) for reporting a security problem.

[AGPL-3.0-only](LICENSE) © Odd Omens LLC
