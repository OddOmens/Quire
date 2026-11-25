package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

// ── Page history ──

// A save within revisionGap of the newest revision updates it rather than
// adding another, so history holds editing sessions, not keystrokes. Once
// that revision is revisionSpan old the next save starts a new one, so a
// long session still leaves a version every half hour or so. The same goes
// for changes picked up from disk, so a script that rewrites a page every
// few seconds doesn't fill its history.
const (
	revisionGap  = 10 * time.Minute
	revisionSpan = 30 * time.Minute
	maxRevisions = 200
)

// sessionSources are the kinds of save that merge into a session as above.
// Others (a restore, say) always make a revision of their own.
var sessionSources = map[string]bool{"edit": true, "disk": true, "form": true}

// now is the clock history runs on; tests move it.
var now = func() int64 { return time.Now().UnixMilli() }

type Revision struct {
	ID      int64  `json:"id"`
	Path    string `json:"path"`
	Created int64  `json:"created"`
	Updated int64  `json:"updated"`
	Source  string `json:"source"`
	Size    int    `json:"size"`
	Content string `json:"content,omitempty"`
}

// Record notes a save: prev is what was on disk before it (nil for a new
// page), next what was written. If prev isn't the newest revision (an edit
// made outside Quire, or the page's first save), it's kept as its own
// revision first.
func (s *Store) Record(path string, prev, next []byte, source string) error {
	now := now()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var id, created, updated int64
	var content, src string
	err = tx.QueryRow(`SELECT id, created, updated, content, source FROM revisions WHERE path = ? ORDER BY updated DESC, id DESC LIMIT 1`, path).
		Scan(&id, &created, &updated, &content, &src)
	hasLast := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if prev != nil && (!hasLast || content != string(prev)) {
		if _, err := tx.Exec(`INSERT INTO revisions (path, created, updated, source, content) VALUES (?,?,?,?,?)`,
			path, now-1, now-1, "earlier", string(prev)); err != nil {
			return err
		}
		hasLast = false
	}
	// A save that creates the page starts its own history, even if an
	// older page at the same path left some.
	session := hasLast && prev != nil && src == source && sessionSources[source] &&
		now-updated < revisionGap.Milliseconds() && now-created < revisionSpan.Milliseconds()
	if session {
		_, err = tx.Exec(`UPDATE revisions SET content = ?, updated = ? WHERE id = ?`, string(next), now, id)
	} else {
		_, err = tx.Exec(`INSERT INTO revisions (path, created, updated, source, content) VALUES (?,?,?,?,?)`, path, now, now, source, string(next))
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM revisions WHERE path = ? AND id NOT IN (SELECT id FROM revisions WHERE path = ? ORDER BY updated DESC LIMIT ?)`,
		path, path, maxRevisions); err != nil {
		return err
	}
	return tx.Commit()
}

// RecordDisk notes a change a scan found on disk: a page written by
// something other than Quire (a script, a synced folder, another editor).
// prev is the content the index last held (nil if the page is new to the
// index). Nothing is recorded if the content matches the newest revision, so
// a page that reappears (a folder that was briefly missing, a restore from
// the trash, a rebuilt index) doesn't add a duplicate.
func (s *Store) RecordDisk(path string, prev, next []byte) error {
	if prev != nil && string(prev) == string(next) {
		return nil
	}
	var content string
	err := s.db.QueryRow(`SELECT content FROM revisions WHERE path = ? ORDER BY updated DESC, id DESC LIMIT 1`, path).Scan(&content)
	switch {
	case err == nil && content == string(next):
		return nil
	case err != nil && !errors.Is(err, sql.ErrNoRows):
		return err
	}
	return s.Record(path, prev, next, "disk")
}

func (s *Store) Revisions(path string) ([]Revision, error) {
	rows, err := s.db.Query(`SELECT id, path, created, updated, source, length(content) FROM revisions WHERE path = ? ORDER BY updated DESC, id DESC`, path)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Revision{}
	for rows.Next() {
		var r Revision
		if err := rows.Scan(&r.ID, &r.Path, &r.Created, &r.Updated, &r.Source, &r.Size); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) Revision(id int64) (Revision, error) {
	var r Revision
	err := s.db.QueryRow(`SELECT id, path, created, updated, source, content FROM revisions WHERE id = ?`, id).
		Scan(&r.ID, &r.Path, &r.Created, &r.Updated, &r.Source, &r.Content)
	if errors.Is(err, sql.ErrNoRows) {
		return r, ErrNotFound
	}
	r.Size = len(r.Content)
	return r, err
}

// ── Share links ──

type Share struct {
	Token   string `json:"token"`
	Path    string `json:"path"`
	Created int64  `json:"created"`
}

func (s *Store) ShareFor(path string) (*Share, error) {
	var sh Share
	err := s.db.QueryRow(`SELECT token, path, created FROM shares WHERE path = ?`, path).Scan(&sh.Token, &sh.Path, &sh.Created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &sh, err
}

func (s *Store) Share(token string) (*Share, error) {
	var sh Share
	err := s.db.QueryRow(`SELECT token, path, created FROM shares WHERE token = ?`, token).Scan(&sh.Token, &sh.Path, &sh.Created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &sh, err
}

func (s *Store) Shares() ([]Share, error) {
	rows, err := s.db.Query(`SELECT token, path, created FROM shares ORDER BY created DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Share{}
	for rows.Next() {
		var sh Share
		if err := rows.Scan(&sh.Token, &sh.Path, &sh.Created); err != nil {
			return nil, err
		}
		out = append(out, sh)
	}
	return out, rows.Err()
}

func (s *Store) CreateShare(path string) (*Share, error) {
	if sh, err := s.ShareFor(path); err != nil || sh != nil {
		return sh, err
	}
	buf := make([]byte, 18)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	sh := &Share{Token: base64.RawURLEncoding.EncodeToString(buf), Path: path, Created: time.Now().UnixMilli()}
	_, err := s.db.Exec(`INSERT INTO shares (token, path, created) VALUES (?,?,?)`, sh.Token, sh.Path, sh.Created)
	return sh, err
}

func (s *Store) DeleteShare(token string) error {
	_, err := s.db.Exec(`DELETE FROM shares WHERE token = ?`, token)
	return err
}

// Forget drops shares and form links for deleted pages (and everything under a deleted
// folder). History stays, so a restored page keeps it.
func (s *Store) Forget(paths ...string) error {
	for _, p := range paths {
		base := strings.TrimSuffix(p, ".md")
		if _, err := s.db.Exec(`DELETE FROM shares WHERE path = ? OR path LIKE ? ESCAPE '\'`, p, escapeLike(base)+"/%"); err != nil {
			return err
		}
		if _, err := s.db.Exec(`DELETE FROM form_links WHERE path = ? OR path LIKE ? ESCAPE '\'`, p, escapeLike(base)+"/%"); err != nil {
			return err
		}
	}
	return nil
}

// ForgetLinks drops the shares and form links of exactly these pages, for
// pages that went missing from disk: a page saved later at the same path is
// a different page and mustn't inherit their public links.
func (s *Store) ForgetLinks(paths ...string) error {
	for _, p := range paths {
		if _, err := s.db.Exec(`DELETE FROM shares WHERE path = ?`, p); err != nil {
			return err
		}
		if _, err := s.db.Exec(`DELETE FROM form_links WHERE path = ?`, p); err != nil {
			return err
		}
	}
	return nil
}

// ForgetHistory deletes the history of pages deleted for good: each path
// and, for a page or folder, everything under it. It returns how many
// revisions it removed. History is only ever dropped here, never because a
// file is missing from disk, so a folder that is briefly unavailable (a
// network drive mounting late, say) can't take the history with it.
func (s *Store) ForgetHistory(paths ...string) (int, error) {
	return s.forgetHistory(0, paths)
}

// ForgetHistoryBefore is ForgetHistory for revisions last updated at or
// before the given time (Unix ms) only, so a newer page at the same path
// keeps its own.
func (s *Store) ForgetHistoryBefore(before int64, paths ...string) (int, error) {
	return s.forgetHistory(before, paths)
}

func (s *Store) forgetHistory(before int64, paths []string) (int, error) {
	n := 0
	for _, p := range paths {
		base := strings.TrimSuffix(p, ".md")
		res, err := s.db.Exec(`DELETE FROM revisions WHERE (path = ? OR path LIKE ? ESCAPE '\') AND (? = 0 OR updated <= ?)`,
			p, escapeLike(base)+"/%", before, before)
		if err != nil {
			return n, err
		}
		c, _ := res.RowsAffected()
		n += int(c)
	}
	return n, nil
}

// MoveHistory moves the history of each path in moves, and of everything
// under it if it's a folder, to the new path. A page going to the trash
// takes its history along this way, so a new page at its old path starts
// fresh, and it comes back with it wherever it's restored to. With before
// set (Unix ms), only revisions last updated by then move. It returns how
// many revisions moved.
func (s *Store) MoveHistory(moves map[string]string, before int64) (int, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	n := 0
	for from, to := range moves {
		res, err := tx.Exec(`UPDATE revisions SET path = ? || substr(path, ?) WHERE (path = ? OR path LIKE ? ESCAPE '\') AND (? = 0 OR updated <= ?)`,
			to, utf8.RuneCountInString(from)+1, from, escapeLike(from)+"/%", before, before)
		if err != nil {
			return n, err
		}
		c, _ := res.RowsAffected()
		n += int(c)
	}
	return n, tx.Commit()
}

// Tidy deletes expired sessions and refreshes the query planner's
// statistics as the tables grow.
func (s *Store) Tidy() error {
	if _, err := s.db.Exec(`DELETE FROM sessions WHERE expires < ?`, time.Now().Unix()); err != nil {
		return err
	}
	_, err := s.db.Exec(`PRAGMA optimize`)
	return err
}

// Check runs SQLite's quick integrity check.
func (s *Store) Check() error {
	var res string
	if err := s.db.QueryRow(`PRAGMA quick_check`).Scan(&res); err != nil {
		return err
	}
	if res != "ok" {
		return errors.New(res)
	}
	return nil
}
