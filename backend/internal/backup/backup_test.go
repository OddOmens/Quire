package backup

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/webdav"

	"github.com/oddomens/quire/internal/store"
	"github.com/oddomens/quire/internal/vault"
)

// fakeCoffer is a WebDAV server like Coffer's: places are top-level folders,
// and only the right app password gets in. Methods in refuse fail.
func fakeCoffer(t *testing.T, refuse ...string) (string, string) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "Vault R2"), 0o755); err != nil {
		t.Fatal(err)
	}
	h := &webdav.Handler{Prefix: "/dav", FileSystem: webdav.Dir(root), LockSystem: webdav.NewMemLS()}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, p, ok := r.BasicAuth(); !ok || u != "alex" || p != "app-password" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if slices.Contains(refuse, r.Method) {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		// Coffer refuses writes at the top level: only places live there.
		if r.Method == "MKCOL" && strings.Count(strings.Trim(r.URL.Path, "/"), "/") < 2 {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		h.ServeHTTP(w, r)
	}))
	t.Cleanup(ts.Close)
	return ts.URL, root
}

func setup(t *testing.T) (*Manager, *vault.Vault, *store.Store, string) {
	dir := t.TempDir()
	v, err := vault.Open(filepath.Join(dir, "notes"))
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(dir, "quire.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close(); v.Close() })
	for p, c := range map[string]string{
		"Work/Plan.md":         "plan",
		"Work/Plan/Q1.md":      "q1",
		"Work/.space.json":     `{"color":"#123456"}`,
		"attachments/logo.png": "png",
	} {
		if _, err := v.Write(p, []byte(c)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := v.Trash("Work/Old", "page", "Work/Plan/Q1.md"); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Write("Work/Plan/Q1.md", []byte("q1 again")); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateAccount("Alex", "hash"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.CreateSession("Browser", "127.0.0.1", "test"); err != nil {
		t.Fatal(err)
	}
	m, err := New(dir, "test", v, st, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return m, v, st, dir
}

func read(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestBackupToCoffer(t *testing.T) {
	url, root := fakeCoffer(t)
	m, v, _, dataDir := setup(t)
	ctx := context.Background()

	bad := Config{URL: url, Username: "alex", Password: "wrong", Folder: "Vault R2/Backups/Quire"}
	if err := m.Test(ctx, bad); err == nil || !strings.Contains(err.Error(), "app password") {
		t.Fatalf("wrong password: %v", err)
	}
	cfg := Config{URL: url, Username: "alex", Password: "app-password", Folder: "Vault R2/Backups/Quire", Hours: 24}
	if err := m.Test(ctx, cfg); err != nil {
		t.Fatalf("test: %v", err)
	}
	if err := m.Save(cfg); err != nil {
		t.Fatal(err)
	}
	// The app password is sealed on disk, never stored in the clear.
	if strings.Contains(read(t, filepath.Join(dataDir, "backup.json")), "app-password") {
		t.Fatal("app password stored in the clear")
	}
	if err := m.RunNow(ctx); err != nil {
		t.Fatalf("run: %v", err)
	}
	out := filepath.Join(root, "Vault R2", "Backups", "Quire")
	if read(t, filepath.Join(out, "notes/Work/Plan/Q1.md")) != "q1 again" || read(t, filepath.Join(out, "notes/Work/.space.json")) == "" {
		t.Fatal("vault not copied")
	}
	if _, err := os.Stat(filepath.Join(out, "notes/.trash")); err == nil {
		t.Fatal("trash was backed up")
	}
	if !strings.Contains(read(t, filepath.Join(out, "backup.json")), `"app": "Quire"`) {
		t.Fatal("no manifest")
	}
	// The database copy is usable and carries no sessions.
	db, err := sql.Open("sqlite", filepath.Join(out, "quire.db"))
	if err != nil {
		t.Fatal(err)
	}
	var sessions, accounts int
	db.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&sessions)
	db.QueryRow(`SELECT COUNT(*) FROM account`).Scan(&accounts)
	db.Close()
	if sessions != 0 || accounts != 1 {
		t.Fatalf("snapshot: %d sessions, %d accounts", sessions, accounts)
	}

	// Next run sends only changes, and removes what was deleted.
	if _, err := v.Write("Work/New.md", []byte("new")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dataDir, "notes/attachments/logo.png")); err != nil {
		t.Fatal(err)
	}
	if err := m.RunNow(ctx); err != nil {
		t.Fatal(err)
	}
	st := m.Status()
	if st.Uploaded != 1 || st.Deleted != 1 || st.LastError != "" {
		t.Fatalf("second run: %+v", st)
	}
	if _, err := os.Stat(filepath.Join(out, "notes/attachments/logo.png")); err == nil {
		t.Fatal("deleted file still in the backup")
	}
	// It's moved aside, not deleted.
	if read(t, filepath.Join(out, "deleted", time.Now().Format(time.DateOnly), "attachments/logo.png")) != "png" {
		t.Fatal("deleted file not kept in deleted/")
	}

	// Settings survive a restart, password included.
	m2, err := New(dataDir, "test", v, m.store, m.log)
	if err != nil || m2.Config() == nil || m2.Config().Password != "app-password" {
		t.Fatalf("reload: %v", err)
	}

	// A notes folder with no pages (a drive that didn't mount) leaves the backup alone.
	entries, _ := os.ReadDir(filepath.Join(dataDir, "notes"))
	for _, e := range entries {
		if e.Name() != "attachments" {
			os.RemoveAll(filepath.Join(dataDir, "notes", e.Name()))
		}
	}
	if err := m.RunNow(ctx); err == nil || !strings.Contains(err.Error(), "no pages") {
		t.Fatalf("empty vault: %v", err)
	}
	if read(t, filepath.Join(out, "notes/Work/Plan/Q1.md")) != "q1 again" {
		t.Fatal("backup emptied along with the vault")
	}
}

func TestValidate(t *testing.T) {
	for _, c := range []struct {
		url string
		ok  bool
	}{
		{"https://coffer.example.com", true},
		{"http://192.168.1.20:8180", true},
		{"http://100.101.1.2:8180", true},
		{"http://localhost:8180", true},
		{"http://coffer.example.com", false},
		{"ftp://coffer", false},
		{"https://user:pw@coffer.example.com", false},
	} {
		err := Validate(&Config{URL: c.url, Username: "a", Folder: "Place/Quire"})
		if (err == nil) != c.ok {
			t.Errorf("%s: %v", c.url, err)
		}
	}
	if Validate(&Config{URL: "https://c.example", Username: "a", Folder: "Place/../x"}) == nil {
		t.Error("dot-dot folder accepted")
	}
}

// A sealed app password that can't be opened (secret.key lost or replaced)
// pauses backups instead of stopping Quire, and the settings stay.
func TestLostKeyPausesBackups(t *testing.T) {
	url, _ := fakeCoffer(t)
	m, v, st, dataDir := setup(t)
	ctx := context.Background()
	cfg := Config{URL: url, Username: "alex", Password: "app-password", Folder: "Vault R2/Backups/Quire", Hours: 24}
	if err := m.Save(cfg); err != nil {
		t.Fatal(err)
	}
	saved := read(t, filepath.Join(dataDir, "backup.json"))
	if err := os.WriteFile(filepath.Join(dataDir, "secret.key"), []byte(strings.Repeat("k", 32)), 0o600); err != nil {
		t.Fatal(err)
	}

	m2, err := New(dataDir, "test", v, st, m.log)
	if err != nil {
		t.Fatalf("startup refused: %v", err)
	}
	c := m2.Config()
	if c == nil || c.URL != url || c.Folder != cfg.Folder || c.Password != "" {
		t.Fatalf("settings after a lost key: %+v", c)
	}
	if !m2.Status().NeedsPassword {
		t.Fatal("status doesn't ask for the app password")
	}
	if err := m2.Run(); err == nil || !strings.Contains(err.Error(), "Settings → Backups") {
		t.Fatalf("run while locked: %v", err)
	}
	if err := m2.RunNow(ctx); err == nil {
		t.Fatal("RunNow ran while locked")
	}
	if err := m2.Test(ctx, Config{URL: url, Username: "alex", Folder: cfg.Folder}); err == nil {
		t.Fatal("test ran without a password")
	}
	// Saving without the password is refused; the file on disk is untouched.
	if err := m2.Save(Config{URL: url, Username: "alex", Folder: cfg.Folder, Hours: 24}); err == nil {
		t.Fatal("saved without an app password")
	}
	if read(t, filepath.Join(dataDir, "backup.json")) != saved {
		t.Fatal("backup.json changed")
	}

	// Entering the password again seals it with the new key and resumes.
	if err := m2.Save(cfg); err != nil {
		t.Fatal(err)
	}
	if m2.Status().NeedsPassword {
		t.Fatal("still locked after saving the password")
	}
	if err := m2.RunNow(ctx); err != nil {
		t.Fatalf("run after unlocking: %v", err)
	}
	m3, err := New(dataDir, "test", v, st, m.log)
	if err != nil || m3.Status().NeedsPassword || m3.Config().Password != "app-password" {
		t.Fatalf("reload after unlocking: %v", err)
	}
}

func TestBackupHoldsBackLargeDeletions(t *testing.T) {
	url, root := fakeCoffer(t)
	m, v, _, dataDir := setup(t)
	ctx := context.Background()
	for i := range 20 {
		if _, err := v.Write(fmt.Sprintf("Work/Page %d.md", i), []byte("page")); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.Save(Config{URL: url, Username: "alex", Password: "app-password", Folder: "Vault R2/Quire"}); err != nil {
		t.Fatal(err)
	}
	if err := m.RunNow(ctx); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(root, "Vault R2", "Quire")

	// Most of the vault going at once (a folder that went missing) is held back.
	for i := range 15 {
		if err := os.Remove(filepath.Join(dataDir, "notes", fmt.Sprintf("Work/Page %d.md", i))); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.RunNow(ctx); err == nil || !strings.Contains(err.Error(), "would remove 15") {
		t.Fatalf("large deletion: %v", err)
	}
	if st := m.Status(); st.HeldDeletes != 15 || st.Deleted != 0 {
		t.Fatalf("status after holding back: %+v", st)
	}
	if read(t, filepath.Join(out, "notes/Work/Page 3.md")) != "page" {
		t.Fatal("held-back file removed from the backup")
	}

	// Allowed once, the files move to deleted/ and the next run is checked again.
	m.AllowLargeDelete()
	if err := m.RunNow(ctx); err != nil {
		t.Fatalf("allowed: %v", err)
	}
	day := time.Now().Format(time.DateOnly)
	if _, err := os.Stat(filepath.Join(out, "notes/Work/Page 3.md")); err == nil {
		t.Fatal("removed file still in notes/")
	}
	if read(t, filepath.Join(out, "deleted", day, "Work/Page 3.md")) != "page" {
		t.Fatal("removed file not in deleted/")
	}
	if st := m.Status(); st.Deleted != 15 || st.HeldDeletes != 0 {
		t.Fatalf("status after allowing: %+v", st)
	}
	m.mu.Lock()
	allowed := m.allowLoss
	m.mu.Unlock()
	if allowed {
		t.Fatal("permission to delete wasn't used up")
	}

	// Renaming a space removes and adds as many files: not a loss.
	if err := os.Rename(filepath.Join(dataDir, "notes/Work"), filepath.Join(dataDir, "notes/Job")); err != nil {
		t.Fatal(err)
	}
	if err := m.RunNow(ctx); err != nil {
		t.Fatalf("renamed space: %v", err)
	}

	// Day folders in deleted/ go after 30 days.
	old := filepath.Join(out, "deleted", time.Now().AddDate(0, 0, -31).Format(time.DateOnly))
	if err := os.MkdirAll(filepath.Join(old, "Work"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Write("Job/Another.md", []byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := m.RunNow(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(old); err == nil {
		t.Fatal("old deleted/ folder kept")
	}
	if _, err := os.Stat(filepath.Join(out, "deleted", day)); err != nil {
		t.Fatal("today's deleted/ folder pruned")
	}
}

// A server that won't move files aside keeps them: nothing is deleted
// instead, and the run reports it.
func TestBackupNeverDeletesWhenMoveFails(t *testing.T) {
	url, root := fakeCoffer(t, "MOVE")
	m, _, _, dataDir := setup(t)
	ctx := context.Background()
	if err := m.Save(Config{URL: url, Username: "alex", Password: "app-password", Folder: "Vault R2/Quire"}); err != nil {
		t.Fatal(err)
	}
	if err := m.RunNow(ctx); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dataDir, "notes/attachments/logo.png")); err != nil {
		t.Fatal(err)
	}
	if err := m.RunNow(ctx); err == nil || !strings.Contains(err.Error(), "left in the backup") {
		t.Fatalf("failed move: %v", err)
	}
	if read(t, filepath.Join(root, "Vault R2/Quire/notes/attachments/logo.png")) != "png" {
		t.Fatal("file deleted when it couldn't be moved")
	}
	if _, ok := m.st.Files["attachments/logo.png"]; !ok {
		t.Fatal("unmoved file forgotten; it wouldn't be tried again")
	}
}

// Testing other settings never sends the saved app password along.
func TestSavedPasswordStaysWithItsServer(t *testing.T) {
	url, _ := fakeCoffer(t)
	other, _ := fakeCoffer(t)
	m, _, _, _ := setup(t)
	ctx := context.Background()
	if err := m.Save(Config{URL: url, Username: "alex", Password: "app-password", Folder: "Vault R2/Quire"}); err != nil {
		t.Fatal(err)
	}
	if err := m.Test(ctx, Config{URL: url + "/", Username: "alex", Folder: "Vault R2/Elsewhere"}); err != nil {
		t.Fatalf("same server and account: %v", err)
	}
	for _, c := range []Config{
		{URL: other, Username: "alex", Folder: "Vault R2/Quire"},
		{URL: url, Username: "sam", Folder: "Vault R2/Quire"},
	} {
		if err := m.Test(ctx, c); err == nil || !strings.Contains(err.Error(), "enter the Coffer app password") {
			t.Errorf("%s as %s: %v", c.URL, c.Username, err)
		}
	}
}
