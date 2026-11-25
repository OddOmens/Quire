package server

import (
	"net/http"
	"regexp"

	"github.com/oddomens/quire/internal/vault"
)

// Share links publish one page, read-only, to anyone with the link. The
// public endpoints return only that page and the attachments it embeds.

func (s *Server) listShares(w http.ResponseWriter, r *http.Request) {
	shares, err := s.store.Shares()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if p := r.URL.Query().Get("path"); p != "" {
		out := shares[:0]
		for _, sh := range shares {
			if sh.Path == p {
				out = append(out, sh)
			}
		}
		shares = out
	}
	writeJSON(w, http.StatusOK, shares)
}

func (s *Server) createShare(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	p, err := vault.CleanPage(req.Path)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if !s.vault.IsFile(p) {
		writeErr(w, http.StatusBadRequest, "write something on this page before sharing it")
		return
	}
	sh, err := s.store.CreateShare(p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, sh)
}

func (s *Server) deleteShare(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteShare(r.PathValue("token")); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

var validToken = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

func (s *Server) sharedContent(w http.ResponseWriter, r *http.Request) (string, []byte, int64, bool) {
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	token := r.PathValue("token")
	if !validToken.MatchString(token) {
		writeErr(w, http.StatusNotFound, "this link doesn't work anymore")
		return "", nil, 0, false
	}
	sh, err := s.store.Share(token)
	if err != nil {
		writeErr(w, http.StatusNotFound, "this link doesn't work anymore")
		return "", nil, 0, false
	}
	// A page missing from the index (changed outside Quire and not scanned
	// yet) isn't served: it may not be the page that was shared.
	if rev, err := s.store.IndexedRev(sh.Path); err != nil || rev == "" {
		writeErr(w, http.StatusNotFound, "this link doesn't work anymore")
		return "", nil, 0, false
	}
	content, e, err := s.vault.Read(sh.Path)
	if err != nil {
		writeErr(w, http.StatusNotFound, "this link doesn't work anymore")
		return "", nil, 0, false
	}
	return sh.Path, content, e.ModTime.UnixMilli(), true
}

// publicPage serves a shared page without its front matter, which can hold
// notes meant for the owner (tags and the like). Only the page width is
// kept: as its own field, and as a one-line front matter block for viewers
// that read it from the content. A page with no width of its own follows
// the owner's full-width setting.
func (s *Server) publicPage(w http.ResponseWriter, r *http.Request) {
	p, content, mtime, ok := s.sharedContent(w, r)
	if !ok {
		return
	}
	acct, err := s.store.Account()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	body := vault.StripFrontmatter(string(content))
	width := ""
	if pw := vault.ReadFrontmatter(string(content)).Width; pw == "full" || pw == "" && acct != nil && acct.FullWidth {
		width = "full"
		body = "---\nwidth: full\n---\n" + body
	}
	writeJSON(w, http.StatusOK, map[string]any{"title": vault.Title(p), "content": body, "width": width, "updated": mtime})
}

// publicFile serves an attachment only if the shared page links or embeds
// it, matched by exact path.
func (s *Server) publicFile(w http.ResponseWriter, r *http.Request) {
	_, content, _, ok := s.sharedContent(w, r)
	if !ok {
		return
	}
	p, err := vault.Clean(r.PathValue("path"))
	if err != nil || !attachmentRefs(vault.StripFrontmatter(string(content)))[p] {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	s.serveFile(w, r, p)
}
