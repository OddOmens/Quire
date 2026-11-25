// Package server is Quire's HTTP API and web UI.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/oddomens/quire/internal/backup"
	"github.com/oddomens/quire/internal/store"
	"github.com/oddomens/quire/internal/vault"
)

type Config struct {
	ScanInterval time.Duration
	Version      string
	// TrustedProxies may set X-Forwarded-For. Loopback is always trusted, so
	// Tailscale Serve and a local reverse proxy work out of the box.
	TrustedProxies []netip.Prefix
	// TrashRetention is how long deleted pages stay restorable.
	TrashRetention time.Duration
	// TempDir holds uploads while they're imported; the system's temp
	// folder if empty.
	TempDir string
}

type Server struct {
	cfg    Config
	vault  *vault.Vault
	store  *store.Store
	backup *backup.Manager
	events *hub
	log    *slog.Logger
	web    fs.FS

	// writeMu serialises changes to the vault, so a move that rewrites links
	// can't interleave with a save or a scan.
	writeMu sync.Mutex
	limiter *limiter
	// verifies holds a slot for each password check running (maxVerifies).
	verifies chan struct{}
	// formLimiter counts public form answers per address.
	formLimiter *answerLimiter
	// previews reads web pages for bookmark cards.
	previews    *previewer
	formKeyOnce sync.Once
	formSecret  []byte

	// setupCode guards first-run account creation; it's printed to the log.
	setupMu   sync.Mutex
	setupCode string
}

func New(cfg Config, v *vault.Vault, st *store.Store, bk *backup.Manager, web fs.FS, log *slog.Logger) *Server {
	if cfg.TrashRetention == 0 {
		cfg.TrashRetention = 30 * 24 * time.Hour
	}
	s := &Server{cfg: cfg, vault: v, store: st, backup: bk, web: web, log: log, events: newHub(), limiter: newLimiter(),
		formLimiter: newAnswerLimiter(), verifies: make(chan struct{}, maxVerifies), previews: newPreviewer(publicAddr)}
	s.removeImportLeftovers()
	return s
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	api := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, s.requireAuth(h)) }

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": s.cfg.Version})
	})
	mux.HandleFunc("GET /api/auth/session", s.session)
	mux.HandleFunc("POST /api/auth/setup", s.setup)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.HandleFunc("POST /api/auth/logout", s.logout)
	mux.HandleFunc("GET /api/public/{token}", s.publicPage)
	mux.HandleFunc("GET /api/public/{token}/files/{path...}", s.publicFile)
	mux.HandleFunc("GET /f/{token}", s.publicForm)
	mux.HandleFunc("POST /f/{token}", s.publicForm)

	api("GET /api/account", s.account)
	api("PATCH /api/account", s.updateAccount)
	api("POST /api/account/password", s.changePassword)
	api("POST /api/account/2fa/setup", s.startTwoFactor)
	api("POST /api/account/2fa/enable", s.enableTwoFactor)
	api("POST /api/account/2fa/disable", s.disableTwoFactor)
	api("POST /api/account/recovery-codes", s.newRecoveryCodes)
	api("GET /api/sessions", s.sessions)
	api("DELETE /api/sessions/{id}", s.revokeSession)
	api("POST /api/sessions/revoke-others", s.revokeOtherSessions)

	api("GET /api/spaces", s.spaces)
	api("GET /api/spaces/{name}", s.spaceDetails)
	api("GET /api/spaces/{name}/export", s.exportSpace)
	api("GET /api/spaces/{name}/tasks", s.spaceTasks)
	api("GET /api/spaces/{name}/missing-links", s.missingLinks)
	api("POST /api/spaces", s.createSpace)
	api("POST /api/spaces/order", s.arrangeSpaces)
	api("GET /api/sections", s.spaceSections)
	api("PATCH /api/spaces/{name}", s.updateSpace)
	api("DELETE /api/spaces/{name}", s.deleteSpace)

	api("GET /api/tree", s.tree)
	api("GET /api/notes/{path...}", s.getNote)
	api("PUT /api/notes/{path...}", s.putNote)
	api("DELETE /api/notes/{path...}", s.deleteNote)
	api("POST /api/notes", s.createNote)
	api("POST /api/move", s.move)
	api("POST /api/reorder", s.reorder)
	api("GET /api/search", s.search)
	api("GET /api/tags", s.tags)
	api("GET /api/graph", s.graph)
	api("POST /api/attachments", s.upload)
	api("GET /api/attachments", s.attachments)
	api("POST /api/attachments/trash", s.trashAttachments)
	api("POST /api/attachments/rename", s.renameAttachment)
	api("GET /api/files/{path...}", s.file)
	api("POST /api/import", s.importNotes)
	api("GET /api/events", s.stream)

	api("GET /api/history/{path...}", s.history)
	api("GET /api/revisions/{id}", s.revision)
	api("POST /api/revisions/{id}/restore", s.restoreRevision)
	api("GET /api/deleted-pages", s.deletedPages)

	api("GET /api/trash", s.trash)
	api("POST /api/trash/{id}/restore", s.restoreTrash)
	api("DELETE /api/trash/{id}", s.purgeTrash)
	api("DELETE /api/trash", s.emptyTrash)

	api("GET /api/backup", s.backupSettings)
	api("PUT /api/backup", s.saveBackup)
	api("DELETE /api/backup", s.removeBackup)
	api("POST /api/backup/test", s.testBackup)
	api("POST /api/backup/run", s.runBackup)

	api("GET /api/tables", s.listTables)
	api("POST /api/tables", s.createTable)
	api("POST /api/tables/convert", s.convertTable)
	api("POST /api/tables/import", s.importNewTable)
	api("GET /api/tables/{path...}", s.tableRoute)
	api("POST /api/tables/{path...}", s.tableRoute)
	api("PUT /api/tables/{path...}", s.tableRoute)
	api("PATCH /api/tables/{path...}", s.tableRoute)
	api("POST /api/formulas", s.evalFormulas)
	api("GET /api/formulas/functions", s.formulaFunctions)
	api("GET /api/calendar", s.calendar)
	api("GET /api/link-preview", s.linkPreview)
	api("GET /api/form-links", s.listFormLinks)
	api("POST /api/form-links", s.createFormLink)
	api("DELETE /api/form-links/{token}", s.deleteFormLink)

	api("GET /api/shares", s.listShares)
	api("POST /api/shares", s.createShare)
	api("DELETE /api/shares/{token}", s.deleteShare)

	mux.Handle("/api/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeErr(w, http.StatusNotFound, "not found")
	}))
	mux.Handle("/", newSPA(s.web))

	return s.secure(s.logRequests(gzipJSON(mux, func(r *http.Request) bool {
		p := r.URL.Path
		return p == "/api/events" || strings.HasPrefix(p, "/api/auth/") || isFileRoute(p)
	})))
}

type ctxKey struct{}

type authInfo struct {
	sessionID string
	cookie    bool
}

func sessionID(r *http.Request) string {
	if a, ok := r.Context().Value(ctxKey{}).(authInfo); ok {
		return a.sessionID
	}
	return ""
}

func withAuth(r *http.Request, a authInfo) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), ctxKey{}, a))
}

type apiError struct {
	Error string `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, apiError{Error: msg})
}

// readJSON decodes a request body of up to 16 MiB. Fields it doesn't know
// are ignored, so a newer app can talk to an older server.
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	return true
}

// fail maps vault and store errors to responses.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, vault.ErrNotFound), errors.Is(err, store.ErrNotFound), errors.Is(err, fs.ErrNotExist):
		writeErr(w, http.StatusNotFound, "not found")
	case errors.Is(err, vault.ErrExists), errors.Is(err, fs.ErrExist):
		writeErr(w, http.StatusConflict, "something with that name is already there")
	case errors.Is(err, vault.ErrInvalid):
		writeErr(w, http.StatusBadRequest, "that name or location isn't allowed")
	default:
		s.log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		writeErr(w, http.StatusInternalServerError, "something went wrong")
	}
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		if strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/api/events" {
			s.log.Debug("request", "method", r.Method, "path", r.URL.Path, "status", sw.status, "dur", time.Since(start).Round(time.Millisecond))
		}
	})
}

// embedHosts are the only other sites a page may show in a frame: the
// players and viewers behind the editor's Embed block (frontend
// src/editor/embeds.ts makes addresses on exactly these).
var embedHosts = []string{
	"https://www.youtube-nocookie.com",
	"https://player.vimeo.com",
	"https://www.loom.com",
	"https://open.spotify.com",
	"https://w.soundcloud.com",
	"https://embed.music.apple.com",
	"https://embed.podcasts.apple.com",
	"https://www.figma.com",
	"https://codepen.io",
	"https://codesandbox.io",
	"https://docs.google.com",
	"https://drive.google.com",
	"https://www.google.com/maps/",
	"https://miro.com",
	"https://airtable.com",
}

// pageCSP is the policy for the app's own pages. Frames may hold Quire's own
// files (an attached PDF) or one of embedHosts; nothing may frame Quire.
var pageCSP = "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; " +
	"frame-src 'self' " + strings.Join(embedHosts, " ") + "; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

// secure sets browser hardening headers and refuses cross-site writes.
func (s *Server) secure(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
		if isHTTPS(r) {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		if !isFileRoute(r.URL.Path) {
			h.Set("Content-Security-Policy", pageCSP)
		}
		// Public forms carry no session, and with no-referrer browsers post
		// them with "Origin: null"; their signed stamp guards them instead.
		publicForm := strings.HasPrefix(r.URL.Path, "/f/")
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions && !publicForm {
			if origin := r.Header.Get("Origin"); origin != "" && !sameOrigin(origin, r) {
				writeErr(w, http.StatusForbidden, "cross-origin request refused")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// isFileRoute matches the attachment routes, /api/files/… and
// /api/public/{token}/files/…, which set their own sandboxing CSP.
func isFileRoute(p string) bool {
	if strings.HasPrefix(p, "/api/files/") {
		return true
	}
	rest, ok := strings.CutPrefix(p, "/api/public/")
	if !ok {
		return false
	}
	token, rest, ok := strings.Cut(rest, "/")
	return ok && token != "" && strings.HasPrefix(rest, "files/")
}

func sameOrigin(origin string, r *http.Request) bool {
	_, after, ok := strings.Cut(origin, "://")
	if !ok {
		return false
	}
	if strings.EqualFold(after, r.Host) {
		return true
	}
	// Behind a proxy that rewrites Host (Tailscale Serve, nginx).
	fwd := r.Header.Get("X-Forwarded-Host")
	return fwd != "" && strings.EqualFold(after, fwd)
}
