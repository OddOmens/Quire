package server

import "github.com/oddomens/quire/internal/vault"

// Seed gives an empty vault one space with a few pages, so a first run shows
// sub-pages, links, backlinks and the editor's blocks working. Only a new
// install gets them: on a database that has been used, an empty notes
// folder is far more likely a drive that didn't mount, and pages written
// into it would be backed up over the real ones.
func (s *Server) Seed() error {
	notes, folders, err := s.vault.Walk()
	if err != nil || len(notes) > 0 || len(folders) > 0 {
		return err
	}
	fresh, err := s.store.Fresh()
	if err != nil {
		return err
	}
	if !fresh {
		s.log.Warn("the notes folder is empty, but Quire has been used before, so no starter pages were added; check that the notes folder is mounted")
		return nil
	}
	if err := s.vault.Mkdir("Personal"); err != nil {
		return err
	}
	if err := s.vault.SetSpaceMeta("Personal", vault.SpaceMeta{Description: "Notes, plans and everything in between.", Color: "#4c6ef5"}); err != nil {
		return err
	}
	for p, body := range starterPages {
		if _, err := s.vault.Create(p, []byte(body)); err != nil {
			return err
		}
	}
	return nil
}

var starterPages = map[string]string{
	"Personal/Welcome to Quire.md": `Quire keeps every page as a plain **Markdown file** on your server. Spaces are folders, pages are ` + "`.md`" + ` files, and sub-pages live in a folder named after their parent.

> [!tip]
> Press **/** on an empty line to add headings, lists, tables, code, callouts and more. Select text to format it.

## Linking pages

Type **[[** to link another page, like [[Editing basics]]. The panel on the right of each page lists the pages that link to it under **Linked from**, so connections work both ways. Open it with the contents button at the top of the page if it's hidden.

## Getting around

- [x] Create a page with **New page** in the sidebar
- [ ] Press **⌘K** to search every space
- [ ] Add sub-pages with the **+** beside a page in the sidebar
- [ ] Share a page publicly with **Share**

| Shortcut | Action |
| --- | --- |
| ⌘K | Search and jump |
| ⌘⇧N | New page |
| ⌘S | Save now (Quire also saves as you type) |
| ⌘⇧↑ / ⌘⇧↓ | Move a block up or down |

Switch between editing and reading with **Edit** and **Read** at the top of a page.

Tag pages anywhere with a hash, like #getting-started.
`,
	"Personal/Welcome to Quire/Editing basics.md": `This is a sub-page of [[Welcome to Quire]].

## Text

**Bold**, *italic*, ~~strikethrough~~, ` + "`inline code`" + ` and ==highlights==. Select text for the formatting toolbar.

> [!note]
> Callouts come in four kinds: note, tip, warning and danger.

> [!warning]
> Deleted pages go to the trash, where you can restore them for 30 days.

## Code

` + "```go" + `
func main() {
	fmt.Println("Hello from Quire")
}
` + "```" + `

## Your files

Edit these files with anything else and Quire picks up the changes on its own. #getting-started
`,
}
