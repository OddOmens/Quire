package server

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"time"
)

// A warning is something the owner should look at: backups that aren't
// running, or a setup detail that weakens a protection. Warnings are only
// shown to the signed-in owner.
type warning struct {
	// ID is stable, so a client can remember which ones it has shown.
	ID      string `json:"id"`
	Message string `json:"message"`
	// Section is the settings section where it's fixed.
	Section string `json:"section,omitempty"`
}

// staleBackup is how old the last good backup may get before it's flagged:
// two missed runs, and never less than three days, so a server that was off
// for a weekend doesn't nag.
func staleBackup(hours int) time.Duration {
	d := 2 * time.Duration(hours) * time.Hour
	return max(d, 3*24*time.Hour)
}

// warnings lists what needs the owner's attention. It's cheap: it reads
// in-memory backup state and the request itself.
func (s *Server) warnings(r *http.Request) []warning {
	out := []warning{}
	cfg, st := s.backup.Config(), s.backup.Status()
	switch {
	case cfg == nil:
		out = append(out, warning{ID: "backup-off", Section: "backups",
			Message: "Backups aren't set up. Set up backups to Coffer, or make sure the notes and data folders are backed up some other way."})
	case st.NeedsPassword:
		out = append(out, warning{ID: "backup-password", Section: "backups",
			Message: "Backups are paused: Quire can't unlock the saved Coffer app password (was secret.key replaced?). Enter it again in Backups."})
	case st.Running:
	case st.LastError != "":
		out = append(out, warning{ID: "backup-failed", Section: "backups",
			Message: "The last backup failed: " + st.LastError})
	case st.LastSuccess == 0:
		if cfg.Hours > 0 {
			break // The first scheduled run starts within a minute.
		}
		out = append(out, warning{ID: "backup-never", Section: "backups",
			Message: "Backups are set up, but none has run yet. Use “Back up now”."})
	default:
		limit := staleBackup(cfg.Hours)
		if cfg.Hours == 0 {
			limit = 30 * 24 * time.Hour // Manual backups only: remind monthly.
		}
		if age := time.Since(time.UnixMilli(st.LastSuccess)); age > limit {
			out = append(out, warning{ID: "backup-stale", Section: "backups",
				Message: fmt.Sprintf("The last backup is %d days old.", int(age.Hours()/24))})
		}
	}
	if addr, ok := s.untrustedProxy(r); ok {
		out = append(out, warning{ID: "untrusted-proxy", Section: "about",
			Message: fmt.Sprintf("Quire is reached through a proxy at %s that it doesn't trust, so every sign-in appears to come from that address (on Docker, usually the bridge network). If that proxy is yours, set QUIRE_TRUSTED_PROXIES, for example to %s, so sign-in limits and your device list see real addresses.", addr, netip.PrefixFrom(addr, addr.BitLen()))})
	}
	return out
}

// untrustedProxy reports a request that came from a private address that
// isn't a trusted proxy but still carries X-Forwarded-For: a reverse proxy
// (Tailscale Serve, nginx, Caddy) whose forwarded address Quire ignores. A
// public address with the header is left alone; that's more likely a
// proxy on the visitor's side.
func (s *Server) untrustedProxy(r *http.Request) (netip.Addr, bool) {
	if r.Header.Get("X-Forwarded-For") == "" {
		return netip.Addr{}, false
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, false
	}
	addr = addr.Unmap()
	if s.trusted(addr) || !addr.IsPrivate() {
		return netip.Addr{}, false
	}
	return addr, true
}
