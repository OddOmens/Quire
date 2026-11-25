package server

import (
	"net/http"
	"strconv"

	"github.com/oddomens/quire/internal/store"
	"github.com/oddomens/quire/internal/vault"
)

func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	p, err := vault.CleanPage(r.PathValue("path"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	revs, err := s.store.Revisions(p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, revs)
}

func (s *Server) revision(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.fail(w, r, vault.ErrNotFound)
		return
	}
	rev, err := s.store.Revision(id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, rev)
}

// restoreRevision writes an old version back as the page's current content;
// the version it replaces stays in history.
func (s *Server) restoreRevision(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.fail(w, r, vault.ErrNotFound)
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	rev, err := s.store.Revision(id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// Only pages come back this way; database files have their own restore.
	if _, err := vault.CleanPage(rev.Path); err != nil {
		s.fail(w, r, vault.ErrNotFound)
		return
	}
	if !s.vault.IsDir(vault.SpaceOf(rev.Path)) {
		writeErr(w, http.StatusConflict, "this page's space no longer exists")
		return
	}
	d, _, err := s.save(r, rev.Path, []byte(rev.Content), "", "restore")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.publish(r, "changed", rev.Path)
	writeJSON(w, http.StatusOK, d)
}

// deletedPages lists pages that have history but no file: deleted or moved
// outside Quire. Each can be restored from its newest version with
// restoreRevision, or looked through with history.
func (s *Server) deletedPages(w http.ResponseWriter, r *http.Request) {
	paths, err := s.store.HistoryPaths()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out := []store.HistoryPath{}
	for _, h := range paths {
		if _, err := vault.CleanPage(h.Path); err == nil && !s.vault.Exists(h.Path) {
			out = append(out, h)
		}
	}
	writeJSON(w, http.StatusOK, out)
}
