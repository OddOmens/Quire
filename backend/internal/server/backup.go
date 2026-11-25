package server

import (
	"context"
	"net/http"
	"time"

	"github.com/oddomens/quire/internal/backup"
)

func (s *Server) backupSettings(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"configured": false, "status": s.backup.Status()}
	if c := s.backup.Config(); c != nil {
		out["configured"] = true
		out["url"], out["username"], out["folder"], out["hours"] = c.URL, c.Username, c.Folder, c.Hours
	}
	writeJSON(w, http.StatusOK, out)
}

type backupRequest struct {
	URL      string `json:"url"`
	Username string `json:"username"`
	// Password is the Coffer app password; empty keeps the saved one.
	Password string `json:"password"`
	Folder   string `json:"folder"`
	Hours    int    `json:"hours"`
	// Current is the Quire password. Sending a copy of everything somewhere
	// new is as sensitive as changing the password, so it asks again.
	Current string `json:"current"`
}

func (r backupRequest) config() backup.Config {
	return backup.Config{URL: r.URL, Username: r.Username, Password: r.Password, Folder: r.Folder, Hours: r.Hours}
}

func (s *Server) saveBackup(w http.ResponseWriter, r *http.Request) {
	var req backupRequest
	if !readJSON(w, r, &req) {
		return
	}
	acct := s.loadAccount(w, r)
	if acct == nil || !s.confirmPassword(w, r, acct, req.Current) {
		return
	}
	if err := s.backup.Save(req.config()); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.log.Info("backup settings changed", "ip", s.clientIP(r))
	s.backupSettings(w, r)
}

func (s *Server) testBackup(w http.ResponseWriter, r *http.Request) {
	var req backupRequest
	if !readJSON(w, r, &req) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := s.backup.Test(ctx, req.config()); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// runBackup starts a backup. With ?allowLargeDelete=1 it goes ahead even if
// it would remove a large share of the copy in Coffer, which a run otherwise
// holds back (see backup.Status.HeldDeletes).
func (s *Server) runBackup(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("allowLargeDelete") == "1" {
		s.backup.AllowLargeDelete()
		s.log.Info("large backup deletion allowed for the next run", "ip", s.clientIP(r))
	}
	if err := s.backup.Run(); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, s.backup.Status())
}

func (s *Server) removeBackup(w http.ResponseWriter, r *http.Request) {
	if err := s.backup.Remove(); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
