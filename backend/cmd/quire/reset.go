package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/oddomens/quire/internal/store"
)

var errDataDirInUse = errors.New("the data folder is in use by a running Quire")

// resetAccount deletes the account and every sign-in session, for an owner
// who has lost their password (or two-factor device). Pages, history, share
// links and backup settings stay. On the next start Quire prints a new setup
// code, as on a first run.
//
// It refuses while a Quire server is using the data folder: the server
// holds quire.lock for as long as it runs. The change itself is one SQLite
// transaction, so even where the lock can't be checked (a file system
// without locks), the database stays consistent; a running server would
// just need a restart to show its setup code.
func resetAccount(dataDir string, out io.Writer) error {
	file := filepath.Join(dataDir, "quire.db")
	if _, err := os.Stat(file); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("there's no database at %s, so no account to reset; is QUIRE_DATA_DIR right?", file)
		}
		return err
	}
	release, err := lockDataDir(dataDir)
	switch {
	case errors.Is(err, errDataDirInUse):
		return fmt.Errorf("Quire is running and using %s. Stop it first (docker compose stop quire), then run reset-account again", dataDir)
	case err != nil:
		fmt.Fprintf(out, "Couldn't check whether Quire is running (%v); if it is, restart it afterwards.\n", err)
	default:
		defer release()
	}

	st, err := store.Open(file)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer st.Close()
	name, sessions, err := st.ResetAccount()
	if err != nil {
		return fmt.Errorf("reset account: %w", err)
	}
	if name == "" {
		fmt.Fprintf(out, "There was no account to remove. Signed out %d %s.\n", sessions, plural(sessions, "device", "devices"))
	} else {
		fmt.Fprintf(out, "Removed the account %q and signed out %d %s.\n", name, sessions, plural(sessions, "device", "devices"))
	}
	fmt.Fprintln(out, "Pages, page history, share links and backup settings are unchanged.")
	if os.Getenv("QUIRE_PASSWORD") != "" {
		fmt.Fprintln(out, "QUIRE_PASSWORD is set, so the next start creates the account from it.")
	} else {
		fmt.Fprintln(out, "Start Quire and open it in a browser; its log shows a new setup code (docker compose logs quire).")
	}
	return nil
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}
