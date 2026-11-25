package server

import (
	"net/http"
	"net/url"
	"path"
	"strings"

	"github.com/oddomens/quire/internal/vault"
)

type attachmentInfo struct {
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
	// Pages are the pages that use it; Trashed, pages in the trash that do.
	Pages   []string `json:"pages"`
	Trashed []string `json:"trashed"`
	// History is set on an unused file that an older version of a page
	// mentions.
	History bool `json:"history,omitempty"`
}

// attachmentUses maps each attachment to the pages that use it, and to the
// pages in the trash that do (by the paths they had).
func (s *Server) attachmentUses() (pages, trashed map[string][]string, err error) {
	pages, trashed = map[string][]string{}, map[string][]string{}
	err = s.store.PageTexts(func(p, text string) {
		for a := range attachmentRefs(text) {
			pages[a] = append(pages[a], p)
		}
	})
	if err != nil {
		return nil, nil, err
	}
	for _, tp := range s.vault.TrashedPages() {
		content, _, err := s.vault.Read(tp.File)
		if err != nil {
			continue
		}
		for a := range attachmentRefs(string(content)) {
			trashed[a] = append(trashed[a], tp.Path)
		}
	}
	return pages, trashed, nil
}

// attachments lists the files in attachments/ and where each is used.
func (s *Server) attachments(w http.ResponseWriter, r *http.Request) {
	files, err := s.vault.Attachments()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	pages, trashed, err := s.attachmentUses()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	items := make([]attachmentInfo, 0, len(files))
	var total int64
	unused := false
	for _, f := range files {
		it := attachmentInfo{Path: f.Path, Size: f.Size, Mtime: f.ModTime.UnixMilli(), Pages: pages[f.Path], Trashed: trashed[f.Path]}
		if it.Pages == nil {
			it.Pages = []string{}
			unused = unused || it.Trashed == nil
		}
		if it.Trashed == nil {
			it.Trashed = []string{}
		}
		items = append(items, it)
		total += f.Size
	}
	// Old versions only matter for files nothing else uses, so history is
	// only read when there are some.
	if unused {
		inHistory := map[string]bool{}
		err := s.store.HistoryTexts(func(text string) {
			for a := range attachmentRefs(text) {
				inHistory[a] = true
			}
		})
		if err != nil {
			s.fail(w, r, err)
			return
		}
		for i := range items {
			items[i].History = len(items[i].Pages) == 0 && len(items[i].Trashed) == 0 && inHistory[items[i].Path]
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": total})
}

// trashAttachments moves unused attachments to the trash, one trash item
// each, so each can be restored on its own until the trash is emptied.
// Files a page or a page in the trash still uses are kept.
func (s *Server) trashAttachments(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Paths []string `json:"paths"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	pages, trashed, err := s.attachmentUses()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	type kept struct {
		Path   string `json:"path"`
		Reason string `json:"reason"`
	}
	out := struct {
		Trashed []string `json:"trashed"`
		Kept    []kept   `json:"kept"`
	}{[]string{}, []kept{}}
	for _, raw := range req.Paths {
		p, err := vault.Clean(raw)
		switch {
		case err != nil || vault.SpaceOf(p) != vault.AttachmentsDir || !s.vault.IsFile(p):
			out.Kept = append(out.Kept, kept{raw, "not an attachment"})
		case len(pages[p]) > 0:
			out.Kept = append(out.Kept, kept{p, "a page uses it"})
		case len(trashed[p]) > 0:
			out.Kept = append(out.Kept, kept{p, "a page in the trash uses it"})
		default:
			if _, err := s.vault.Trash(p, "attachment", p); err != nil {
				s.fail(w, r, err)
				return
			}
			out.Trashed = append(out.Trashed, p)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// renameAttachment gives an attachment a new name in the same folder and
// rewrites the links to it, on pages and on pages in the trash.
func (s *Server) renameAttachment(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	from, err := vault.Clean(req.Path)
	if err != nil || vault.SpaceOf(from) != vault.AttachmentsDir {
		s.fail(w, r, vault.ErrInvalid)
		return
	}
	name := vault.AttachmentName(strings.TrimSpace(req.Name))
	if path.Ext(name) == "" {
		name += path.Ext(from)
	}
	to, err := vault.Clean(path.Join(vault.Folder(from), name))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if !s.vault.IsFile(from) {
		s.fail(w, r, vault.ErrNotFound)
		return
	}
	if to == from {
		writeJSON(w, http.StatusOK, map[string]any{"path": to, "updated": []string{}})
		return
	}
	pages, trashed, err := s.attachmentUses()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.vault.Move(from, to); err != nil {
		s.fail(w, r, err)
		return
	}
	updated := []string{}
	for _, p := range pages[from] {
		content, _, err := s.vault.Read(p)
		if err != nil {
			continue
		}
		next, ok := renameAttachmentRefs(string(content), from, to)
		if !ok {
			continue
		}
		if _, _, err := s.save(r, p, []byte(next), "", "edit"); err != nil {
			s.fail(w, r, err)
			return
		}
		updated = append(updated, p)
	}
	// Pages in the trash keep working if they're restored.
	for _, tp := range s.vault.TrashedPages() {
		if len(trashed[from]) == 0 {
			break
		}
		content, _, err := s.vault.Read(tp.File)
		if err != nil {
			continue
		}
		if next, ok := renameAttachmentRefs(string(content), from, to); ok {
			if _, err := s.vault.Write(tp.File, []byte(next)); err != nil {
				s.log.Warn("update a trashed page's link", "path", tp.File, "err", err)
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": to, "updated": updated})
}

// renameAttachmentRefs points a page's links to the attachment at from at
// to instead: Markdown links and images by path (as written or with %20
// for spaces) and ![[embeds]] by path or, for a file at the top of
// attachments/, by name. Code is left as written.
func renameAttachmentRefs(content, from, to string) (string, bool) {
	topLevel := vault.Folder(from) == vault.AttachmentsDir
	next, changed := vault.Rewrite(content, func(target string) (string, bool) {
		switch {
		case target == from:
			return to, true
		case topLevel && target == path.Base(from):
			return path.Base(to), true
		}
		return "", false
	})
	pairs := [][2]string{{from, to}}
	for _, esc := range []func(string) string{
		func(p string) string { return strings.ReplaceAll(p, " ", "%20") },
		func(p string) string { return (&url.URL{Path: p}).EscapedPath() },
	} {
		if e := esc(from); e != from {
			pairs = append(pairs, [2]string{e, esc(to)})
		}
	}
	next = vault.OutsideCode(next, func(s string) string {
		for _, pr := range pairs {
			s = replacePathRef(s, pr[0], pr[1], &changed)
		}
		return s
	})
	return next, changed
}

// replacePathRef replaces old with new wherever it stands as a whole path:
// not inside a longer name, and ending where a link's path would.
func replacePathRef(s, old, new string, changed *bool) string {
	var b strings.Builder
	for {
		i := strings.Index(s, old)
		if i < 0 {
			b.WriteString(s)
			return b.String()
		}
		j := i + len(old)
		before := i == 0 || !strings.ContainsRune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-/%", rune(s[i-1]))
		after := j == len(s) || strings.ContainsRune(" \t)]\"'|#?>", rune(s[j]))
		b.WriteString(s[:i])
		if before && after {
			b.WriteString(new)
			*changed = true
		} else {
			b.WriteString(old)
		}
		s = s[j:]
	}
}
