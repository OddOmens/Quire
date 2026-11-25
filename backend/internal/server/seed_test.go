package server

import (
	"os"
	"path/filepath"
	"testing"
)

func emptyVault(t *testing.T, h *harness) {
	t.Helper()
	entries, _ := os.ReadDir(h.dir)
	for _, e := range entries {
		if err := os.RemoveAll(filepath.Join(h.dir, e.Name())); err != nil {
			t.Fatal(err)
		}
	}
}

// Starter pages go into a new install only. An empty notes folder on a
// database that has been used is a drive that didn't mount, not a new start.
func TestSeedOnlyOnFirstInstall(t *testing.T) {
	h := newServer(t)
	emptyVault(t, h)
	if err := h.srv.Seed(); err != nil {
		t.Fatal(err)
	}
	if !h.exists("Personal/Welcome to Quire.md") {
		t.Fatal("new install wasn't seeded")
	}

	h = newHarness(t)
	emptyVault(t, h)
	if err := h.srv.Seed(); err != nil {
		t.Fatal(err)
	}
	if h.exists("Personal") {
		t.Fatal("seeded an empty notes folder on an install with an account")
	}

	// History alone (an account reset, say) also marks a used install.
	h = newServer(t)
	emptyVault(t, h)
	if err := h.srv.store.Record("Work/Plan.md", nil, []byte("plan"), "edit"); err != nil {
		t.Fatal(err)
	}
	if err := h.srv.Seed(); err != nil {
		t.Fatal(err)
	}
	if h.exists("Personal") {
		t.Fatal("seeded an empty notes folder on an install with history")
	}
}
