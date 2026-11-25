package server

import (
	"errors"
	"io"
	"maps"
	"mime"
	"net/http"
	"path"
	"slices"
	"strconv"
	"strings"

	"github.com/oddomens/quire/internal/secrets"
	"github.com/oddomens/quire/internal/store"
	"github.com/oddomens/quire/internal/vault"
)

type noteDetail struct {
	store.Note
	Content   string           `json:"content"`
	Backlinks []store.Backlink `json:"backlinks"`
	Outgoing  []store.Outgoing `json:"outgoing"`
	// Virtual is set for a folder of sub-pages that has no page file of its
	// own yet; saving creates one.
	Virtual bool `json:"virtual,omitempty"`
	// Warnings lists what looks like a secret on the page. Saving still
	// works; the client only points it out.
	Warnings []secrets.Finding `json:"warnings,omitempty"`
}

// secretWarnings scans a page for likely secrets, unless its frontmatter
// says "secrets: ok".
func secretWarnings(content string) []secrets.Finding {
	if vault.ReadFrontmatter(content).SecretsOK {
		return nil
	}
	return secrets.Scan(content)
}

func (s *Server) detail(p string, content []byte) (noteDetail, error) {
	n, err := s.store.Note(p)
	if err != nil {
		return noteDetail{}, err
	}
	r, err := s.store.Resolver()
	if err != nil {
		return noteDetail{}, err
	}
	d := noteDetail{Note: n, Content: string(content), Warnings: secretWarnings(string(content))}
	if d.Backlinks, err = s.store.Backlinks(p, r); err != nil {
		return d, err
	}
	d.Outgoing, err = s.store.Outgoing(p, r)
	return d, err
}

func (s *Server) tree(w http.ResponseWriter, r *http.Request) {
	notes, err := s.store.Notes()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	_, all, err := s.vault.Walk()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// Space roots and attachments aren't pages.
	folders := []string{}
	for _, f := range all {
		if strings.Contains(f, "/") && vault.SpaceOf(f) != vault.AttachmentsDir {
			folders = append(folders, f)
		}
	}
	if notes == nil {
		notes = []store.Note{}
	}
	// order is each folder's custom page order (see vault.OrderFile); pages
	// it leaves out sort alphabetically after the listed ones.
	writeJSON(w, http.StatusOK, map[string]any{"notes": notes, "folders": folders, "order": s.vault.Orders()})
}

func (s *Server) getNote(w http.ResponseWriter, r *http.Request) {
	p, err := vault.CleanPage(r.PathValue("path"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	content, e, err := s.vault.Read(p)
	if errors.Is(err, vault.ErrNotFound) && s.vault.IsDir(vault.Base(p)) {
		writeJSON(w, http.StatusOK, noteDetail{
			Note:      store.Note{Path: p, Title: vault.Title(p), Folder: vault.Folder(p), Tags: []string{}},
			Backlinks: []store.Backlink{}, Outgoing: []store.Outgoing{}, Virtual: true,
		})
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// The file may have changed since the last scan.
	if n, err := s.store.Note(p); err != nil || n.Rev != vault.Rev(content) {
		if err := s.store.Put(e, content); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	d, err := s.detail(p, content)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// putNote saves a page, creating it if needed. With baseRev set, the save is
// refused (409) if the page changed since the client loaded that version, or
// is no longer there ("missing": deleted or moved elsewhere).
func (s *Server) putNote(w http.ResponseWriter, r *http.Request) {
	p, err := vault.CleanPage(r.PathValue("path"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var req struct {
		Content string `json:"content"`
		BaseRev string `json:"baseRev"`
		// Conflict marks the version someone kept after a conflicting edit.
		// It gets a history entry of its own, so the other one stays too.
		Conflict bool `json:"conflict"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if !s.vault.IsDir(vault.SpaceOf(p)) {
		writeErr(w, http.StatusNotFound, "that space doesn't exist")
		return
	}
	source := "edit"
	if req.Conflict {
		source = "conflict"
	}
	d, status, err := s.save(r, p, []byte(req.Content), req.BaseRev, source)
	if errors.Is(err, errPageGone) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "this page was deleted or moved", "missing": true})
		return
	}
	if status == http.StatusConflict {
		writeJSON(w, status, map[string]string{"error": "this page changed somewhere else", "rev": d.Rev, "content": d.Content})
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// errPageGone is a save against a version of a page that's no longer there.
var errPageGone = errors.New("page deleted or moved")

// save writes a page and records it in history. Callers hold writeMu.
func (s *Server) save(r *http.Request, p string, content []byte, baseRev, source string) (noteDetail, int, error) {
	cur, _, err := s.vault.Read(p)
	switch {
	case errors.Is(err, vault.ErrNotFound) && baseRev != "":
		// The client had it open; writing it back would undo a delete or
		// leave a stray copy behind after a move.
		return noteDetail{}, http.StatusConflict, errPageGone
	case errors.Is(err, vault.ErrNotFound):
		cur = nil
	case err != nil:
		return noteDetail{}, 0, err
	case baseRev != "" && vault.Rev(cur) != baseRev:
		return noteDetail{Note: store.Note{Rev: vault.Rev(cur)}, Content: string(cur)}, http.StatusConflict, nil
	}
	if cur == nil || string(cur) != string(content) {
		e, err := s.vault.Write(p, content)
		if err != nil {
			return noteDetail{}, 0, err
		}
		if err := s.store.Put(e, content); err != nil {
			return noteDetail{}, 0, err
		}
		if err := s.store.Record(p, cur, content, source); err != nil {
			s.log.Warn("record history", "path", p, "err", err)
		}
		s.publish(r, "changed", p)
	}
	d, err := s.detail(p, content)
	return d, http.StatusOK, err
}

// pageName turns a title into a file name: no slashes or characters that
// file systems refuse.
func pageName(title string) string {
	title = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`/\:*?"<>|`, r) || r < 32 {
			return '-'
		}
		return r
	}, strings.Join(strings.Fields(title), " "))
	title = strings.TrimLeft(title, ".")
	if r := []rune(title); len(r) > 120 {
		title = strings.TrimSpace(string(r[:120]))
	}
	if title == "" {
		title = "Untitled"
	}
	return title
}

// createNote adds a page at the top of a space, or under another page.
func (s *Server) createNote(w http.ResponseWriter, r *http.Request) {
	var req struct {
		// Parent is a space name or a page path.
		Parent  string `json:"parent"`
		Title   string `json:"title"`
		Content string `json:"content"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	parent, err := vault.Clean(req.Parent)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if vault.SpaceOf(parent) == vault.AttachmentsDir {
		s.fail(w, r, vault.ErrInvalid)
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if !s.vault.IsDir(vault.SpaceOf(parent)) {
		writeErr(w, http.StatusNotFound, "that space doesn't exist")
		return
	}
	p, err := vault.CleanPage(path.Join(vault.Base(parent), pageName(req.Title)+".md"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	p = s.vault.Unique(p)
	content := []byte(req.Content)
	e, err := s.vault.Create(p, content)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.store.Put(e, content); err != nil {
		s.fail(w, r, err)
		return
	}
	s.publish(r, "tree", p)
	d, err := s.detail(p, content)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, d)
}

// pageParts lists what makes up the page at base: its file, a database's
// rows and schema, and its folder of sub-pages, whichever exist.
func (s *Server) pageParts(base string) (parts []string, notes []string, err error) {
	if strings.Contains(base, "/") && s.vault.IsFile(base+".md") {
		parts = append(parts, base+".md")
		notes = append(notes, base+".md")
	}
	if strings.Contains(base, "/") {
		rows, schema := vault.TableFiles(base + ".md")
		for _, f := range []string{rows, schema} {
			if s.vault.IsFile(f) {
				parts = append(parts, f)
			}
		}
	}
	if s.vault.IsDir(base) {
		parts = append(parts, base)
		under, err := s.notesUnder(base)
		if err != nil {
			return nil, nil, err
		}
		notes = append(notes, under...)
	}
	if len(parts) == 0 {
		return nil, nil, vault.ErrNotFound
	}
	return parts, notes, nil
}

// deleteNote moves a page and its sub-pages to the trash.
func (s *Server) deleteNote(w http.ResponseWriter, r *http.Request) {
	p, err := vault.CleanPage(r.PathValue("path"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	base := vault.Base(p)
	if err := s.trashBase(r, base, "page"); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) trashBase(r *http.Request, base, kind string) error {
	parts, notes, err := s.pageParts(base)
	if err != nil {
		return err
	}
	id, err := s.vault.Trash(base, kind, parts...)
	if err != nil {
		return err
	}
	s.trashHistory(vault.TrashItem{ID: id}, parts)
	if err := s.store.Delete(notes...); err != nil {
		return err
	}
	if err := s.store.Forget(append(notes, base)...); err != nil {
		return err
	}
	s.tidy(vault.Folder(base))
	s.publish(r, "tree", append(notes, base)...)
	return nil
}

// tidy removes a sub-page folder left empty, so its page stops showing an
// expand arrow. Space roots stay.
func (s *Server) tidy(folder string) {
	if strings.Contains(folder, "/") {
		s.vault.RemoveEmptyDir(folder)
	}
}

func (s *Server) notesUnder(folder string) ([]string, error) {
	notes, err := s.store.Notes()
	if err != nil {
		return nil, err
	}
	var out []string
	for _, n := range notes {
		if strings.HasPrefix(n.Path, folder+"/") {
			out = append(out, n.Path)
		}
	}
	return out, nil
}

// move renames or moves a page (with its sub-pages). from and to are page
// paths, with or without .md.
func (s *Server) move(w http.ResponseWriter, r *http.Request) {
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	from, err := vault.Clean(req.From)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	to, err := vault.Clean(req.To)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	from, to = vault.Base(from), vault.Base(to)
	if !strings.Contains(from, "/") || !strings.Contains(to, "/") || vault.SpaceOf(to) == vault.AttachmentsDir {
		s.fail(w, r, vault.ErrInvalid)
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if !s.vault.IsDir(vault.SpaceOf(to)) {
		writeErr(w, http.StatusNotFound, "that space doesn't exist")
		return
	}
	updated, err := s.relocate(r, from, to)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": to + ".md", "updated": updated})
}

// relocate moves the page or space at fromBase to toBase, then rewrites
// [[links]] elsewhere so they still point at what moved. Callers hold writeMu.
func (s *Server) relocate(r *http.Request, fromBase, toBase string) ([]string, error) {
	if fromBase == toBase {
		return []string{}, nil
	}
	if strings.HasPrefix(toBase+"/", fromBase+"/") {
		return nil, vault.ErrInvalid
	}
	parts, notes, err := s.pageParts(fromBase)
	if err != nil {
		return nil, err
	}
	// A rename that only changes case finds itself on a case-insensitive
	// file system; anything else already at the new name is in the way.
	caseOnly := strings.EqualFold(fromBase, toBase)
	taken := func(from, to string) bool { return s.vault.Exists(to) && !(caseOnly && s.vault.SameFile(from, to)) }
	if taken(fromBase, toBase) || taken(fromBase+".md", toBase+".md") {
		return nil, vault.ErrExists
	}

	// Work out what moves where, and who links to it, before touching disk.
	moved := map[string]string{}
	for _, p := range notes {
		moved[p] = toBase + strings.TrimPrefix(p, fromBase)
	}
	res, err := s.store.Resolver()
	if err != nil {
		return nil, err
	}
	sources, err := s.store.LinkSources(notes, res)
	if err != nil {
		return nil, err
	}

	var done [][2]string
	for _, p := range parts {
		dst := toBase + strings.TrimPrefix(p, fromBase)
		if err := s.vault.Move(p, dst); err != nil {
			for _, d := range done {
				_ = s.vault.Move(d[1], d[0])
			}
			return nil, err
		}
		done = append(done, [2]string{p, dst})
	}
	s.tidy(vault.Folder(fromBase))
	s.keepOrder(fromBase, toBase)

	if err := s.store.Delete(notes...); err != nil {
		return nil, err
	}
	for _, np := range moved {
		if err := s.reindex(np); err != nil {
			return nil, err
		}
	}
	// History follows the moved files, a database's rows and schema too.
	hist := maps.Clone(moved)
	for _, d := range done {
		if !vault.IsNote(d[0]) && s.vault.IsFile(d[1]) {
			hist[d[0]] = d[1]
		}
	}
	if err := s.store.Moved(hist); err != nil {
		return nil, err
	}
	changed := []string{fromBase, toBase}

	updated := []string{}
	for src := range sources {
		cur := src
		if np, ok := moved[src]; ok {
			cur = np
		}
		content, _, err := s.vault.Read(cur)
		if err != nil {
			continue
		}
		next, ok := vault.Rewrite(string(content), func(target string) (string, bool) {
			old := res.Resolve(target, src)
			np, ok := moved[old]
			if !ok {
				return "", false
			}
			if strings.Contains(vault.LinkKey(target), "/") {
				return vault.Base(np), true
			}
			if t := vault.Title(np); t != vault.Title(old) {
				return t, true
			}
			return "", false
		})
		if !ok {
			continue
		}
		e, err := s.vault.Write(cur, []byte(next))
		if err != nil {
			return nil, err
		}
		if err := s.store.Put(e, []byte(next)); err != nil {
			return nil, err
		}
		updated = append(updated, cur)
		changed = append(changed, cur)
	}
	s.publish(r, "tree", changed...)
	return updated, nil
}

// keepOrder updates page orders after a page moved: a renamed page keeps its
// place, and a page that left a folder leaves that folder's order. A renamed
// space keeps its place among the spaces the same way.
func (s *Server) keepOrder(fromBase, toBase string) {
	from, to := vault.Folder(fromBase), vault.Folder(toBase)
	var err error
	if from == to {
		err = s.vault.RenameInOrder(from, path.Base(fromBase), path.Base(toBase))
		if err == nil && from == "" {
			err = s.vault.RenameInSections(fromBase, toBase)
		}
	} else {
		err = s.vault.RemoveFromOrder(from, path.Base(fromBase))
	}
	if err != nil {
		s.log.Warn("update page order", "folder", from, "err", err)
	}
}

// reorder puts a page in its place among its siblings, first moving it (with
// its sub-pages, rewriting links) when the parent changes. parent is a space
// or a page path. The page lands before the sibling page before, or last.
func (s *Server) reorder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path   string `json:"path"`
		Parent string `json:"parent"`
		Before string `json:"before"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	p, err := vault.Clean(req.Path)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	parent, err := vault.Clean(req.Parent)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	fromBase, folder := vault.Base(p), vault.Base(parent)
	if !strings.Contains(fromBase, "/") || vault.SpaceOf(fromBase) == vault.AttachmentsDir || vault.SpaceOf(folder) == vault.AttachmentsDir ||
		folder == fromBase || strings.HasPrefix(folder, fromBase+"/") {
		s.fail(w, r, vault.ErrInvalid)
		return
	}
	before := ""
	if req.Before != "" {
		b, err := vault.Clean(req.Before)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		if vault.Folder(vault.Base(b)) == folder {
			before = path.Base(vault.Base(b))
		}
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if !s.vault.IsDir(vault.SpaceOf(folder)) {
		writeErr(w, http.StatusNotFound, "that space doesn't exist")
		return
	}
	if strings.Contains(folder, "/") && !s.vault.IsFile(folder+".md") && !s.vault.IsDir(folder) {
		s.fail(w, r, vault.ErrNotFound)
		return
	}
	name := path.Base(fromBase)
	toBase := folder + "/" + name
	updated := []string{}
	if toBase != fromBase {
		if updated, err = s.relocate(r, fromBase, toBase); err != nil {
			s.fail(w, r, err)
			return
		}
	} else if _, _, err := s.pageParts(fromBase); err != nil {
		s.fail(w, r, err)
		return
	}
	names := slices.DeleteFunc(s.vault.Ordered(folder), func(n string) bool { return n == name })
	at := len(names)
	if i := slices.Index(names, before); i >= 0 && before != "" {
		at = i
	}
	if err := s.vault.SetOrder(folder, slices.Insert(names, at, name)); err != nil {
		s.fail(w, r, err)
		return
	}
	s.publish(r, "tree", toBase)
	writeJSON(w, http.StatusOK, map[string]any{"path": toBase + ".md", "updated": updated})
}

func (s *Server) reindex(p string) error {
	content, e, err := s.vault.Read(p)
	if err != nil {
		return err
	}
	return s.store.Put(e, content)
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 30
	}
	q := r.URL.Query().Get("q")
	hits, err := s.store.Search(q, limit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// best=1 puts the sections that fit the words best first: found the way
	// Ask finds them, so word forms, other words for the same thing and
	// misspellings still match.
	if r.URL.Query().Get("best") == "1" {
		if hits, err = s.bestFirst(q, hits, limit); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, hits)
}

func (s *Server) tags(w http.ResponseWriter, r *http.Request) {
	tags, err := s.store.Tags()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, tags)
}

func (s *Server) graph(w http.ResponseWriter, r *http.Request) {
	space := r.URL.Query().Get("space")
	if space != "" {
		var err error
		if space, err = vault.CleanSpace(space); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	g, err := s.store.Graph(space)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
}

const maxUpload = 50 << 20

var (
	imageExt = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".avif": true, ".svg": true}
	videoExt = map[string]bool{".mp4": true, ".webm": true, ".mov": true, ".m4v": true}
)

// upload stores a pasted or dropped file under attachments/ and returns the
// Markdown that embeds it.
func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload+1<<20)
	f, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "no file, or it's over 50 MB")
		return
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "upload failed")
		return
	}
	p, err := vault.Clean(path.Join(vault.AttachmentsDir, vault.AttachmentName(hdr.Filename)))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.writeMu.Lock()
	p = s.vault.Unique(p)
	_, err = s.vault.Write(p, data)
	s.writeMu.Unlock()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	label := strings.TrimSuffix(path.Base(p), path.Ext(p))
	md := "[" + label + "](" + p + ")"
	kind := "file"
	switch ext := strings.ToLower(path.Ext(p)); {
	case imageExt[ext]:
		kind = "image"
	case videoExt[ext]:
		kind = "video"
	}
	if kind != "file" {
		md = "!" + md
	}
	writeJSON(w, http.StatusCreated, map[string]any{"path": p, "markdown": md, "kind": kind, "name": hdr.Filename})
}

func (s *Server) file(w http.ResponseWriter, r *http.Request) {
	p, err := vault.Clean(r.PathValue("path"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.serveFile(w, r, p)
}

// serveFile streams an attachment. The sandbox CSP keeps an uploaded SVG or
// HTML file from running script in Quire's origin, and anything that isn't a
// picture, video, audio or PDF downloads instead of opening.
//
// A PDF is the one file Quire's own pages may show in a frame, and browsers'
// PDF viewers refuse to run in a sandbox, so a real PDF goes out without
// one. It's still sent as application/pdf with nosniff, which no browser
// reads as a web page, and a ".pdf" that isn't a PDF downloads.
func (s *Server) serveFile(w http.ResponseWriter, r *http.Request, p string) {
	f, err := s.vault.Open(p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		s.fail(w, r, vault.ErrNotFound)
		return
	}
	ctype := mime.TypeByExtension(strings.ToLower(path.Ext(p)))
	pdf := ctype == "application/pdf" && startsAsPDF(f)
	inline := pdf || strings.HasPrefix(ctype, "image/") || strings.HasPrefix(ctype, "video/") || strings.HasPrefix(ctype, "audio/")
	if !inline {
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": info.Name()}))
		// As plain bytes, so with nosniff a browser never runs a .js or
		// applies a .css attachment, even if some page tried to load one.
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	if pdf {
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'self'")
	} else {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox")
	}
	w.Header().Set("Cache-Control", "private, max-age=300")
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}

// startsAsPDF reports whether f begins the way every PDF does, and rewinds it.
func startsAsPDF(f io.ReadSeeker) bool {
	var head [5]byte
	_, err := io.ReadFull(f, head[:])
	if _, serr := f.Seek(0, io.SeekStart); serr != nil {
		return false
	}
	return err == nil && string(head[:]) == "%PDF-"
}
