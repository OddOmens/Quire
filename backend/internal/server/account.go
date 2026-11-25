package server

import (
	"net/http"
	"time"

	"github.com/oddomens/quire/internal/auth"
	"github.com/oddomens/quire/internal/store"
)

func (s *Server) loadAccount(w http.ResponseWriter, r *http.Request) *store.Account {
	acct, err := s.store.Account()
	if err != nil {
		s.fail(w, r, err)
		return nil
	}
	if acct == nil {
		writeErr(w, http.StatusConflict, "Quire isn't set up yet")
	}
	return acct
}

// confirmPassword re-checks the password before sensitive changes, with the
// same lockout as sign-in.
func (s *Server) confirmPassword(w http.ResponseWriter, r *http.Request, acct *store.Account, password string) bool {
	ip := s.clientIP(r)
	stamp, ok := s.attempt(w, ip)
	if !ok {
		return false
	}
	ok, busy := s.verifyPassword(password, acct.PasswordHash)
	switch {
	case busy:
		s.limiter.forgive(ip, stamp)
		writeErr(w, http.StatusTooManyRequests, "Quire is busy checking passwords; try again in a moment")
		return false
	case !ok:
		writeErr(w, http.StatusForbidden, "your current password isn't right")
		return false
	}
	s.limiter.forgive(ip, stamp)
	return true
}

func (s *Server) account(w http.ResponseWriter, r *http.Request) {
	acct := s.loadAccount(w, r)
	if acct == nil {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"name":          acct.Name,
		"twoFactor":     acct.TwoFactor(),
		"recoveryCodes": len(acct.Recovery),
		"fullWidth":     acct.FullWidth,
		"created":       acct.Created * 1000,
		"passwordSet":   acct.Updated * 1000,
	})
}

func (s *Server) updateAccount(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name      string `json:"name"`
		FullWidth *bool  `json:"fullWidth"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	acct := s.loadAccount(w, r)
	if acct == nil {
		return
	}
	if name := cleanName(req.Name); name != "" {
		acct.Name = name
	}
	if req.FullWidth != nil {
		acct.FullWidth = *req.FullWidth
	}
	if err := s.store.SaveAccount(acct); err != nil {
		s.fail(w, r, err)
		return
	}
	s.account(w, r)
}

// changePassword also signs out every other session.
func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Current string `json:"current"`
		Next    string `json:"next"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	acct := s.loadAccount(w, r)
	if acct == nil || !s.confirmPassword(w, r, acct, req.Current) {
		return
	}
	if msg := validPassword(req.Next); msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	hash, err := auth.HashPassword(req.Next)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	acct.PasswordHash = hash
	if err := s.store.SaveAccount(acct); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.store.DeleteOtherSessions(sessionID(r)); err != nil {
		s.fail(w, r, err)
		return
	}
	s.log.Info("password changed", "ip", s.clientIP(r))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) startTwoFactor(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	acct := s.loadAccount(w, r)
	if acct == nil || !s.confirmPassword(w, r, acct, req.Password) {
		return
	}
	acct.TOTPPending = auth.NewTOTPSecret()
	if err := s.store.SaveAccount(acct); err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"secret": acct.TOTPPending, "uri": auth.TOTPURI(acct.TOTPPending, acct.Name)})
}

func (s *Server) enableTwoFactor(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	acct := s.loadAccount(w, r)
	if acct == nil {
		return
	}
	if acct.TOTPPending == "" {
		writeErr(w, http.StatusBadRequest, "start two-factor setup first")
		return
	}
	step, ok := auth.CheckTOTP(acct.TOTPPending, req.Code, time.Now())
	if !ok {
		writeErr(w, http.StatusBadRequest, "that code didn't match; check your device's clock and try the next one")
		return
	}
	codes, hashes := auth.RecoveryCodes(10)
	acct.TOTPSecret, acct.TOTPPending, acct.TOTPLast, acct.Recovery = acct.TOTPPending, "", step, hashes
	if err := s.store.SaveAccount(acct); err != nil {
		s.fail(w, r, err)
		return
	}
	// Sessions from before may have been opened by whoever 2FA is meant
	// to keep out; only this one is known to be the owner's.
	if err := s.store.DeleteOtherSessions(sessionID(r)); err != nil {
		s.fail(w, r, err)
		return
	}
	s.log.Info("two-factor sign-in turned on", "ip", s.clientIP(r))
	writeJSON(w, http.StatusOK, map[string]any{"recoveryCodes": codes})
}

func (s *Server) disableTwoFactor(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	acct := s.loadAccount(w, r)
	if acct == nil || !s.confirmPassword(w, r, acct, req.Password) {
		return
	}
	acct.TOTPSecret, acct.TOTPPending, acct.Recovery = "", "", nil
	if err := s.store.SaveAccount(acct); err != nil {
		s.fail(w, r, err)
		return
	}
	s.log.Info("two-factor sign-in turned off", "ip", s.clientIP(r))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) newRecoveryCodes(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	acct := s.loadAccount(w, r)
	if acct == nil || !s.confirmPassword(w, r, acct, req.Password) {
		return
	}
	if !acct.TwoFactor() {
		writeErr(w, http.StatusBadRequest, "two-factor sign-in is off")
		return
	}
	codes, hashes := auth.RecoveryCodes(10)
	acct.Recovery = hashes
	if err := s.store.SaveAccount(acct); err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"recoveryCodes": codes})
}

func (s *Server) sessions(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.Sessions(sessionID(r))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) revokeSession(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteSession(r.PathValue("id")); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) revokeOtherSessions(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteOtherSessions(sessionID(r)); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
