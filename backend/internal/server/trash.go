package server

import (
	"net/http"

	"github.com/oddomens/quire/internal/vault"
)

func (s *Server) trash(w http.ResponseWriter, r *http.Request) {
	items, err := s.vault.TrashItems()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "retentionDays": int(s.cfg.TrashRetention.Hours() / 24)})
}

func (s *Server) restoreTrash(w http.ResponseWriter, r *http.Request) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	item, base, err := s.vault.Restore(r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// Before the scan, which would otherwise see the pages as new.
	s.restoreHistory(item, base)
	if _, err := s.scan(); err != nil {
		s.fail(w, r, err)
		return
	}
	s.publish(r, "tree", base)
	out := map[string]string{"path": base}
	if s.vault.IsFile(base + ".md") {
		out["page"] = base + ".md"
	}
	if vault.SpaceOf(base) == base {
		out["space"] = base
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) purgeTrash(w http.ResponseWriter, r *http.Request) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	item, err := s.vault.Purge(r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.forgetHistory(item)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) emptyTrash(w http.ResponseWriter, r *http.Request) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	items, err := s.vault.TrashItems()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	for _, it := range items {
		if _, err := s.vault.Purge(it.ID); err != nil {
			s.fail(w, r, err)
			return
		}
		s.forgetHistory(it)
	}
	w.WriteHeader(http.StatusNoContent)
}
