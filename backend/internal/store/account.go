package store

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"time"
)

// Quire has one account: the owner. It's created on first run.

type Account struct {
	Name         string
	PasswordHash string
	TOTPSecret   string // set once two-factor sign-in is on
	TOTPPending  string // secret shown during setup, not yet confirmed
	TOTPLast     int64  // last accepted TOTP step, so a code can't be reused
	Recovery     []string
	FullWidth    bool // pages without a "width" key use the whole window
	Created      int64
	Updated      int64
}

func (a *Account) TwoFactor() bool { return a.TOTPSecret != "" }

// Account returns the owner's account, or nil before setup.
func (s *Store) Account() (*Account, error) {
	var a Account
	var rec string
	err := s.db.QueryRow(`SELECT name, password_hash, totp_secret, totp_pending, totp_last, recovery, full_width, created, updated FROM account WHERE id = 1`).
		Scan(&a.Name, &a.PasswordHash, &a.TOTPSecret, &a.TOTPPending, &a.TOTPLast, &rec, &a.FullWidth, &a.Created, &a.Updated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal([]byte(rec), &a.Recovery)
	return &a, nil
}

// Fresh reports a database that has never been used: no account, sessions,
// page history, share links or indexed pages. ResetAccount keeps history,
// so a reset install isn't fresh either.
func (s *Store) Fresh() (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT (SELECT COUNT(*) FROM account) + (SELECT COUNT(*) FROM sessions) +
		(SELECT COUNT(*) FROM revisions) + (SELECT COUNT(*) FROM shares) + (SELECT COUNT(*) FROM notes)`).Scan(&n)
	return n == 0, err
}

// CreateAccount fails if an account already exists.
func (s *Store) CreateAccount(name, hash string) error {
	now := time.Now().Unix()
	_, err := s.db.Exec(`INSERT INTO account (id, name, password_hash, created, updated) VALUES (1, ?, ?, ?, ?)`, name, hash, now, now)
	return err
}

func (s *Store) SaveAccount(a *Account) error {
	rec, _ := json.Marshal(a.Recovery)
	if a.Recovery == nil {
		rec = []byte("[]")
	}
	_, err := s.db.Exec(`UPDATE account SET name = ?, password_hash = ?, totp_secret = ?, totp_pending = ?, totp_last = ?, recovery = ?, full_width = ?, updated = ? WHERE id = 1`,
		a.Name, a.PasswordHash, a.TOTPSecret, a.TOTPPending, a.TOTPLast, string(rec), a.FullWidth, time.Now().Unix())
	return err
}

// UseTOTPStep records step as the last TOTP code accepted, if it's newer
// than the last one. It reports whether it was, checking and saving in one
// statement so a code can't be used twice by requests that race.
func (s *Store) UseTOTPStep(step int64) (bool, error) {
	res, err := s.db.Exec(`UPDATE account SET totp_last = ? WHERE id = 1 AND totp_last < ?`, step, step)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// UseRecoveryCode spends the recovery code with this hash, reporting
// whether it was there to spend. The read and the write share a
// transaction, and the store's one connection keeps others out meanwhile.
func (s *Store) UseRecoveryCode(hash string) (bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var rec string
	if err := tx.QueryRow(`SELECT recovery FROM account WHERE id = 1`).Scan(&rec); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	var codes []string
	_ = json.Unmarshal([]byte(rec), &codes)
	i := slices.Index(codes, hash)
	if i < 0 {
		return false, nil
	}
	out, _ := json.Marshal(slices.Delete(codes, i, i+1))
	if _, err := tx.Exec(`UPDATE account SET recovery = ? WHERE id = 1`, string(out)); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// ResetAccount deletes the account and every session, for an owner who
// can't sign in. Pages, history and share links stay; the next start offers
// the setup screen again. It returns the old account's name ("" if there
// was none) and how many sessions it ended.
func (s *Store) ResetAccount() (name string, sessions int, err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return "", 0, err
	}
	defer tx.Rollback()
	if err := tx.QueryRow(`SELECT name FROM account WHERE id = 1`).Scan(&name); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", 0, err
	}
	res, err := tx.Exec(`DELETE FROM sessions`)
	if err != nil {
		return "", 0, err
	}
	n, _ := res.RowsAffected()
	if _, err := tx.Exec(`DELETE FROM account`); err != nil {
		return "", 0, err
	}
	return name, int(n), tx.Commit()
}

// ── Sessions ──
//
// Sessions are random tokens; only their hashes are stored. The web UI keeps
// one in a cookie, apps send it as a bearer token. ID is a public handle for
// listing and revoking.

const sessionTTL = 60 * 24 * time.Hour

// sessionMaxAge ends a session however recently it was used, so a token
// that leaked doesn't stay good forever.
const sessionMaxAge = 180 * 24 * time.Hour

type Session struct {
	ID        string `json:"id"`
	Device    string `json:"device"`
	IP        string `json:"ip"`
	UserAgent string `json:"userAgent"`
	Created   int64  `json:"created"`
	LastSeen  int64  `json:"lastSeen"`
	Current   bool   `json:"current"`
}

func hashToken(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

func (s *Store) CreateSession(device, ip, ua string) (string, time.Time, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", time.Time{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(buf)
	h := hashToken(token)
	now := time.Now()
	exp := now.Add(sessionTTL)
	if len(ua) > 300 {
		ua = ua[:300]
	}
	_, err := s.db.Exec(`INSERT INTO sessions (id, token_hash, device, ip, user_agent, created, last_seen, expires) VALUES (?,?,?,?,?,?,?,?)`,
		h[:16], h, device, ip, ua, now.Unix(), now.Unix(), exp.Unix())
	return token, exp, err
}

// CheckSession returns the session's ID if token is live, sliding its expiry
// forward at most once a minute, but never past sessionMaxAge.
func (s *Store) CheckSession(token, ip string) (string, error) {
	if token == "" {
		return "", nil
	}
	h := hashToken(token)
	var id string
	var created, lastSeen, expires int64
	err := s.db.QueryRow(`SELECT id, created, last_seen, expires FROM sessions WHERE token_hash = ?`, h).Scan(&id, &created, &lastSeen, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	now := time.Now()
	end := time.Unix(created, 0).Add(sessionMaxAge)
	if now.Unix() > expires || !now.Before(end) {
		_, err := s.db.Exec(`DELETE FROM sessions WHERE token_hash = ?`, h)
		return "", err
	}
	if now.Unix()-lastSeen > 60 {
		exp := now.Add(sessionTTL)
		if exp.After(end) {
			exp = end
		}
		_, err = s.db.Exec(`UPDATE sessions SET last_seen = ?, expires = ?, ip = ? WHERE token_hash = ?`,
			now.Unix(), exp.Unix(), ip, h)
	}
	return id, err
}

func (s *Store) Sessions(current string) ([]Session, error) {
	now := time.Now()
	rows, err := s.db.Query(`SELECT id, device, ip, user_agent, created, last_seen FROM sessions WHERE expires > ? AND created > ? ORDER BY last_seen DESC`,
		now.Unix(), now.Add(-sessionMaxAge).Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Session{}
	for rows.Next() {
		var x Session
		if err := rows.Scan(&x.ID, &x.Device, &x.IP, &x.UserAgent, &x.Created, &x.LastSeen); err != nil {
			return nil, err
		}
		x.Current = x.ID == current
		out = append(out, x)
	}
	return out, rows.Err()
}

func (s *Store) DeleteSession(id string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE id = ?`, id)
	return err
}

func (s *Store) DeleteSessionToken(token string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE token_hash = ?`, hashToken(token))
	return err
}

// DeleteOtherSessions signs out everywhere but keep.
func (s *Store) DeleteOtherSessions(keep string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE id <> ?`, keep)
	return err
}
