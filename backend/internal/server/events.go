package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/oddomens/quire/internal/vault"
)

// Events tell open clients the vault changed, so the tree and open notes stay
// current across devices. A client sends X-Client-Id with its writes and
// ignores events carrying its own id.

type event struct {
	// Type is "changed" (note contents) or "tree" (notes or folders added,
	// moved or removed).
	Type   string   `json:"type"`
	Paths  []string `json:"paths"`
	Origin string   `json:"origin,omitempty"`
}

type hub struct {
	mu   sync.Mutex
	subs map[chan event]struct{}
}

func newHub() *hub { return &hub{subs: map[chan event]struct{}{}} }

func (h *hub) subscribe() chan event {
	ch := make(chan event, 32)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *hub) unsubscribe(ch chan event) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
}

func (h *hub) send(e event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- e:
		default: // A stalled client misses an event; it refetches on reconnect.
		}
	}
}

func (s *Server) publish(r *http.Request, typ string, paths ...string) {
	origin := ""
	if r != nil {
		origin = r.Header.Get("X-Client-Id")
	}
	s.events.send(event{Type: typ, Paths: paths, Origin: origin})
}

func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	rc := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, "retry: 3000\n\n")
	if err := rc.Flush(); err != nil {
		return
	}
	ch := s.events.subscribe()
	defer s.events.unsubscribe(ch)
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case e := <-ch:
			b, _ := json.Marshal(e)
			fmt.Fprintf(w, "data: %s\n\n", b)
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
		}
		if err := rc.Flush(); err != nil {
			return
		}
	}
}

// Watch rescans the vault on an interval, so edits made outside Quire (a
// synced folder, another editor) show up in the index and in open clients.
// Every hour it also empties old trash and tidies the database.
func (s *Server) Watch(ctx context.Context) {
	t := time.NewTicker(s.cfg.ScanInterval)
	defer t.Stop()
	purge := time.NewTicker(time.Hour)
	defer purge.Stop()
	s.maintain()
	for {
		select {
		case <-ctx.Done():
			return
		case <-purge.C:
			s.maintain()
		case <-t.C:
			changed, err := s.Scan()
			if err != nil {
				s.log.Error("scan", "err", err)
				continue
			}
			if len(changed) > 0 {
				s.log.Info("picked up changes from disk", "pages", len(changed))
				s.events.send(event{Type: "tree", Paths: changed})
			}
		}
	}
}

// maintain is the hourly housekeeping that keeps a long-running server
// from slowly growing: old trash and its history, expired sessions, and
// stale login-failure records.
func (s *Server) maintain() {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if gone := s.vault.PurgeOlder(s.cfg.TrashRetention); len(gone) > 0 {
		s.log.Info("emptied old trash", "items", len(gone))
		s.forgetHistory(gone...)
	}
	if err := s.store.Tidy(); err != nil {
		s.log.Warn("tidy database", "err", err)
	}
	s.limiter.sweep()
	s.formLimiter.sweep()
}

// trashHistory moves the history of the paths a trash item took into the
// item, so a new page or space with the same name starts with none.
func (s *Server) trashHistory(item vault.TrashItem, paths []string) {
	moves := map[string]string{}
	for _, p := range paths {
		moves[p] = item.TrashedPath(p)
	}
	if _, err := s.store.MoveHistory(moves, 0); err != nil {
		s.log.Warn("move history to the trash", "err", err)
	}
}

// restoreHistory brings a restored item's history back with it, to its
// numbered name if it came back under one.
func (s *Server) restoreHistory(item vault.TrashItem, base string) {
	moves := map[string]string{}
	for _, p := range item.Paths {
		moves[item.TrashedPath(p)] = item.RestoredPath(p, base)
	}
	n, err := s.store.MoveHistory(moves, 0)
	if err == nil && n == 0 && base != item.Path {
		// Trashed before history went along: it's still at the old paths,
		// and only revisions from before the item was deleted are its.
		moves = map[string]string{}
		for _, p := range item.Paths {
			moves[p] = item.RestoredPath(p, base)
		}
		_, err = s.store.MoveHistory(moves, item.DeletedAt)
	}
	if err != nil {
		s.log.Warn("restore history", "err", err)
	}
}

// forgetHistory drops the history of trash items deleted for good: every
// path each one held, and nothing a newer page at the same path recorded.
func (s *Server) forgetHistory(items ...vault.TrashItem) {
	for _, it := range items {
		held := make([]string, len(it.Paths))
		for i, p := range it.Paths {
			held[i] = it.TrashedPath(p)
		}
		n, err := s.store.ForgetHistory(held...)
		if err == nil && n == 0 {
			// Trashed before history went along with the item.
			_, err = s.store.ForgetHistoryBefore(it.DeletedAt, it.Paths...)
		}
		if err != nil {
			s.log.Warn("remove history of deleted pages", "err", err)
		}
	}
}

// LooseSpace receives Markdown files dropped at the vault root, which
// belong to no space.
const LooseSpace = "General"

func (s *Server) Scan() ([]string, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.scan()
}

// scan brings the index in line with the files on disk and returns the
// paths that changed. Callers hold writeMu.
func (s *Server) scan() ([]string, error) {
	moved, err := s.vault.AdoptLoose(LooseSpace)
	if err != nil {
		s.log.Warn("move loose pages", "err", err)
	}
	for from, to := range moved {
		s.log.Info("moved a page at the vault root into a space", "from", from, "to", to)
	}
	entries, _, err := s.vault.Walk()
	if err != nil {
		return nil, err
	}
	stamps, err := s.store.Stamps()
	if err != nil {
		return nil, err
	}
	var changed []string
	for _, e := range entries {
		if !strings.Contains(e.Path, "/") || vault.SpaceOf(e.Path) == vault.AttachmentsDir {
			continue
		}
		st, ok := stamps[e.Path]
		delete(stamps, e.Path)
		if ok && st[0] == e.ModTime.UnixMilli() && st[1] == e.Size {
			continue
		}
		if err := s.reindexFromDisk(e.Path, ok); err != nil {
			s.log.Warn("index page", "path", e.Path, "err", err)
			continue
		}
		changed = append(changed, e.Path)
	}
	// Pages missing from disk leave the index but keep their history: the
	// folder may only be unavailable for now.
	gone := make([]string, 0, len(stamps))
	for p := range stamps {
		gone = append(gone, p)
	}
	if len(gone) > 0 {
		if err := s.store.Delete(gone...); err != nil {
			return changed, err
		}
		// Their public links end, unless the whole folder is missing (then
		// it's likely only unmounted): a different page saved at the same
		// path later must not be published by an old link.
		if len(entries) > 0 {
			if err := s.store.ForgetLinks(gone...); err != nil {
				return changed, err
			}
		}
	}
	return append(changed, gone...), nil
}

// reindexFromDisk indexes a page a scan found new or changed, and keeps the
// change in its history the way a save through Quire would. indexed says
// whether the index already knew the page. Callers hold writeMu.
func (s *Server) reindexFromDisk(p string, indexed bool) error {
	content, e, err := s.vault.Read(p)
	if err != nil {
		return err
	}
	// The old text comes from the index, read before it's replaced. A file
	// that was only touched, or re-read after a migration, has the same
	// content hash and adds nothing to history.
	var prev []byte
	record := true
	if indexed {
		rev, err := s.store.IndexedRev(p)
		if err != nil {
			return err
		}
		if record = rev != vault.Rev(content); record {
			if prev, err = s.store.IndexedText(p); err != nil {
				return err
			}
		}
	}
	if err := s.store.Put(e, content); err != nil {
		return err
	}
	if record {
		if err := s.store.RecordDisk(p, prev, content); err != nil {
			s.log.Warn("record history", "path", p, "err", err)
		}
	}
	return nil
}
