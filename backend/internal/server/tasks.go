package server

import (
	"net/http"

	"github.com/oddomens/quire/internal/vault"
)

// spaceName reads the {name} of a space that exists, or answers 404.
func (s *Server) spaceName(w http.ResponseWriter, r *http.Request) (string, bool) {
	name, err := vault.CleanSpace(r.PathValue("name"))
	if err != nil || !s.vault.IsDir(name) {
		s.fail(w, r, vault.ErrNotFound)
		return "", false
	}
	return name, true
}

// spaceTasks lists the open to-dos ("- [ ] …") on a space's pages.
func (s *Server) spaceTasks(w http.ResponseWriter, r *http.Request) {
	name, ok := s.spaceName(w, r)
	if !ok {
		return
	}
	tasks, err := s.store.Tasks(name)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, tasks)
}

// missingLinks lists [[links]] on a space's pages to pages that don't exist.
func (s *Server) missingLinks(w http.ResponseWriter, r *http.Request) {
	name, ok := s.spaceName(w, r)
	if !ok {
		return
	}
	links, err := s.store.MissingLinks(name)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, links)
}
