package main

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/oddomens/quire/internal/store"
)

func TestResetAccount(t *testing.T) {
	dir := t.TempDir()
	var out strings.Builder
	if err := resetAccount(dir, &out); err == nil || !strings.Contains(err.Error(), "no database") {
		t.Fatalf("missing database: %v", err)
	}

	st, err := store.Open(filepath.Join(dir, "quire.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.CreateAccount("Alex", "secret-hash"); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{"Laptop", "Phone"} {
		if _, _, err := st.CreateSession(d, "127.0.0.1", "test"); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.Record("Work/Doc.md", nil, []byte("kept"), "edit"); err != nil {
		t.Fatal(err)
	}
	st.Close()

	// While a server holds the data folder, it refuses and changes nothing.
	release, err := lockDataDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := resetAccount(dir, &out); err == nil || !strings.Contains(err.Error(), "Stop it first") {
		t.Fatalf("reset while in use: %v", err)
	}
	release()

	out.Reset()
	if err := resetAccount(dir, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"Alex"`) || !strings.Contains(out.String(), "2 devices") || strings.Contains(out.String(), "secret-hash") {
		t.Fatalf("output: %s", out.String())
	}

	st, err = store.Open(filepath.Join(dir, "quire.db"))
	if err != nil {
		t.Fatal(err)
	}
	acct, err := st.Account()
	if err != nil || acct != nil {
		t.Fatalf("account after reset: %+v %v", acct, err)
	}
	if sessions, _ := st.Sessions(""); len(sessions) != 0 {
		t.Fatalf("sessions after reset: %+v", sessions)
	}
	if revs, _ := st.Revisions("Work/Doc.md"); len(revs) != 1 {
		t.Fatal("history was touched")
	}
	// A fresh account can be made, as on a first run.
	if err := st.CreateAccount("Alex", "new-hash"); err != nil {
		t.Fatal(err)
	}

	st.Close()
	if err := resetAccount(dir, &out); err != nil {
		t.Fatal(err)
	}
	// Running it again with no account is harmless.
	out.Reset()
	if err := resetAccount(dir, &out); err != nil || !strings.Contains(out.String(), "no account") {
		t.Fatalf("second reset: %v %s", err, out.String())
	}
}
