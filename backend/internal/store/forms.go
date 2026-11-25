package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"time"
)

// ── Public form links ──

// FormLink publishes one form of a database page to anyone with the link.
// Responses counts the answers that came in through it.
type FormLink struct {
	Token     string `json:"token"`
	Path      string `json:"path"`
	Form      string `json:"form"`
	Created   int64  `json:"created"`
	Responses int    `json:"responses"`
}

const formLinkCols = `token, path, form, created, responses`

func scanFormLink(row interface{ Scan(...any) error }) (*FormLink, error) {
	var l FormLink
	if err := row.Scan(&l.Token, &l.Path, &l.Form, &l.Created, &l.Responses); err != nil {
		return nil, err
	}
	return &l, nil
}

func (s *Store) FormLink(token string) (*FormLink, error) {
	l, err := scanFormLink(s.db.QueryRow(`SELECT `+formLinkCols+` FROM form_links WHERE token = ?`, token))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return l, err
}

// FormLinks lists the links for a page, or every link when path is "".
func (s *Store) FormLinks(path string) ([]FormLink, error) {
	q, args := `SELECT `+formLinkCols+` FROM form_links ORDER BY created DESC`, []any{}
	if path != "" {
		q, args = `SELECT `+formLinkCols+` FROM form_links WHERE path = ? ORDER BY created DESC`, []any{path}
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FormLink{}
	for rows.Next() {
		l, err := scanFormLink(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *l)
	}
	return out, rows.Err()
}

// CreateFormLink returns the form's link, making one if it has none.
func (s *Store) CreateFormLink(path, form string) (*FormLink, error) {
	l, err := scanFormLink(s.db.QueryRow(`SELECT `+formLinkCols+` FROM form_links WHERE path = ? AND form = ?`, path, form))
	if err == nil {
		return l, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	buf := make([]byte, 18)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	l = &FormLink{Token: base64.RawURLEncoding.EncodeToString(buf), Path: path, Form: form, Created: time.Now().UnixMilli()}
	_, err = s.db.Exec(`INSERT INTO form_links (token, path, form, created) VALUES (?,?,?,?)`, l.Token, l.Path, l.Form, l.Created)
	return l, err
}

func (s *Store) DeleteFormLink(token string) error {
	_, err := s.db.Exec(`DELETE FROM form_links WHERE token = ?`, token)
	return err
}

// CountFormResponse adds one to a link's answer count.
func (s *Store) CountFormResponse(token string) error {
	_, err := s.db.Exec(`UPDATE form_links SET responses = responses + 1 WHERE token = ?`, token)
	return err
}
