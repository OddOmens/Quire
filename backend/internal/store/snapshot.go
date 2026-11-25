package store

import (
	"database/sql"
	"os"
	"strings"
)

// Snapshot writes a consistent copy of the database to file, for backups.
// Sign-in sessions are dropped from the copy: a restored server signs
// everyone in again, and a stolen backup holds no live session.
func (s *Store) Snapshot(file string) error {
	_ = os.Remove(file)
	if _, err := s.db.Exec(`VACUUM INTO ?`, file); err != nil {
		return err
	}
	// The container's file system is read-only with no /tmp, so VACUUM keeps
	// its scratch space in memory.
	cp, err := sql.Open("sqlite", "file:"+strings.ReplaceAll(file, "?", "%3F")+"?_pragma=temp_store(memory)")
	if err != nil {
		return err
	}
	defer cp.Close()
	for _, q := range []string{`DELETE FROM sessions`, `UPDATE account SET totp_pending = ''`, `VACUUM`} {
		if _, err := cp.Exec(q); err != nil {
			return err
		}
	}
	return os.Chmod(file, 0o600)
}
