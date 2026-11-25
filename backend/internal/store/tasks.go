package store

import (
	"path"
	"sort"
	"strings"

	"github.com/oddomens/quire/internal/vault"
)

// Task is an open to-do on a page, with where to find it.
type Task struct {
	Path  string `json:"path"`
	Title string `json:"title"`
	// Rev is the page version the line number belongs to; save with it as
	// baseRev so a page that changed since is refused rather than mangled.
	Rev     string `json:"rev"`
	Line    int    `json:"line"`
	Text    string `json:"text"`
	Heading string `json:"heading"`
	Depth   int    `json:"depth"`
	// Due is the day of the task's date chip, as 2026-11-20, if it has one.
	Due string `json:"due,omitempty"`
}

// Tasks lists the unchecked to-dos on a space's pages, page by page in path
// order. It reads the indexed text, so it costs no file reads.
func (s *Store) Tasks(space string) ([]Task, error) {
	prefix := escapeLike(space) + "/%"
	revs := map[string]string{}
	rows, err := s.db.Query(`SELECT path, rev FROM notes WHERE path LIKE ? ESCAPE '\'`, prefix)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var p, rev string
		if err := rows.Scan(&p, &rev); err != nil {
			rows.Close()
			return nil, err
		}
		revs[p] = rev
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Only pages with a "[ ]" somewhere come back, so most cost nothing.
	rows, err = s.db.Query(`SELECT path, body FROM fts WHERE path LIKE ? ESCAPE '\' AND instr(body, '[ ]') > 0`, prefix)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Task{}
	for rows.Next() {
		var p, body string
		if err := rows.Scan(&p, &body); err != nil {
			return nil, err
		}
		rev, ok := revs[p]
		// LIKE ignores case; spaces don't.
		if !ok || vault.SpaceOf(p) != space {
			continue
		}
		for _, t := range vault.Tasks(body) {
			out = append(out, Task{Path: p, Title: vault.Title(p), Rev: rev, Line: t.Line, Text: t.Text, Heading: t.Heading, Depth: t.Depth, Due: t.Due})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Sorted here rather than in SQL, which would shuffle every page's text.
	sort.SliceStable(out, func(a, b int) bool { return lessPath(out[a].Path, out[b].Path) })
	return out, nil
}

// DatedLine is a line on a page that names a day with a date chip
// ("@2026-11-20"), with where to find it.
type DatedLine struct {
	Path  string
	Title string
	vault.Dated
}

// Dated lists the date chips on every page, in any space, whose day falls
// between from and to (2026-11-20, both included), in order of day. Databases
// keep their dates in columns and are left out. Like Tasks it reads the
// indexed text, and only of pages that hold a chip.
func (s *Store) Dated(from, to string) ([]DatedLine, error) {
	rows, err := s.db.Query(`SELECT f.path, f.body FROM fts f JOIN notes n ON n.path = f.path
		WHERE n.kind <> 'database' AND f.body GLOB '*@[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DatedLine{}
	for rows.Next() {
		var p, body string
		if err := rows.Scan(&p, &body); err != nil {
			return nil, err
		}
		for _, d := range vault.Dates(body) {
			if d.Date >= from && d.Date <= to {
				out = append(out, DatedLine{Path: p, Title: vault.Title(p), Dated: d})
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(a, b int) bool {
		if out[a].Date != out[b].Date {
			return out[a].Date < out[b].Date
		}
		if out[a].Path != out[b].Path {
			return lessPath(out[a].Path, out[b].Path)
		}
		return out[a].Line < out[b].Line
	})
	return out, nil
}

// lessPath orders paths the way the page list does: ignoring case.
func lessPath(a, b string) bool {
	if la, lb := strings.ToLower(a), strings.ToLower(b); la != lb {
		return la < lb
	}
	return a < b
}

// MissingLink is a link target that no page answers to, and the pages that
// link to it.
type MissingLink struct {
	Target string     `json:"target"`
	Pages  []Backlink `json:"pages"`
}

// fileExt marks embeds of attachments (![[photo.png]]), which aren't links to
// pages.
var fileExt = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".avif": true, ".svg": true,
	".mp4": true, ".webm": true, ".mov": true, ".m4v": true, ".mp3": true, ".m4a": true, ".wav": true, ".ogg": true,
	".pdf": true, ".zip": true, ".csv": true, ".docx": true, ".xlsx": true, ".pptx": true,
}

// MissingLinks lists the links on a space's pages that don't resolve to any
// page, grouped by target, in order of target.
func (s *Store) MissingLinks(space string) ([]MissingLink, error) {
	r, err := s.Resolver()
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(`SELECT src, target, context FROM links WHERE src LIKE ? ESCAPE '\' ORDER BY src COLLATE NOCASE, rowid`,
		escapeLike(space)+"/%")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MissingLink{}
	byKey := map[string]int{}
	for rows.Next() {
		var src, target, context string
		if err := rows.Scan(&src, &target, &context); err != nil {
			return nil, err
		}
		if vault.SpaceOf(src) != space || fileExt[strings.ToLower(path.Ext(target))] || r.Resolve(target, src) != "" {
			continue
		}
		key := vault.LinkKey(target)
		i, ok := byKey[key]
		if !ok {
			i = len(out)
			byKey[key] = i
			out = append(out, MissingLink{Target: target, Pages: []Backlink{}})
		}
		out[i].Pages = append(out[i].Pages, Backlink{Path: src, Title: vault.Title(src), Context: context})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(a, b int) bool { return strings.ToLower(out[a].Target) < strings.ToLower(out[b].Target) })
	return out, nil
}
