package server

import (
	"encoding/json"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/oddomens/quire/internal/backup"
	"github.com/oddomens/quire/internal/store"
	"github.com/oddomens/quire/internal/vault"
)

func (h *harness) history(p string) []store.Revision {
	h.t.Helper()
	var revs []store.Revision
	if code := h.do("GET", "/api/history/"+p, nil, &revs); code != 200 {
		h.t.Fatalf("history %s: %d", p, code)
	}
	return revs
}

func (h *harness) revisionText(id int64) string {
	h.t.Helper()
	var rev store.Revision
	h.do("GET", "/api/revisions/"+itoa(id), nil, &rev)
	return rev.Content
}

func (h *harness) write(p, content string) {
	h.t.Helper()
	full := filepath.Join(h.dir, p)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) scan() []string {
	h.t.Helper()
	changed, err := h.srv.Scan()
	if err != nil {
		h.t.Fatal(err)
	}
	return changed
}

// Pages written straight to disk get history, like saves through Quire.
func TestScanRecordsOutsideEdits(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Doc.md", "written in Quire")

	// A script rewrites the page: the change becomes a version.
	h.write("Work/Doc.md", "rewritten by a script")
	h.scan()
	revs := h.history("Work/Doc.md")
	if len(revs) != 2 || revs[0].Source != "disk" || h.revisionText(revs[0].ID) != "rewritten by a script" {
		t.Fatalf("after an outside edit: %+v", revs)
	}
	// Further rewrites soon after update that version rather than piling up.
	h.write("Work/Doc.md", "rewritten by a script, twice")
	h.scan()
	if revs := h.history("Work/Doc.md"); len(revs) != 2 || h.revisionText(revs[0].ID) != "rewritten by a script, twice" {
		t.Fatalf("after a second outside edit: %+v", revs)
	}
	// A page the index had before history was kept from disk: its old text
	// comes from the index, so the outside edit doesn't lose it.
	h.write("Work/Old.md", "from before")
	h.scan()
	if _, err := h.srv.store.ForgetHistory("Work/Old.md"); err != nil {
		t.Fatal(err)
	}
	h.write("Work/Old.md", "changed outside")
	h.scan()
	revs = h.history("Work/Old.md")
	if len(revs) != 2 || h.revisionText(revs[0].ID) != "changed outside" || h.revisionText(revs[1].ID) != "from before" {
		t.Fatalf("old text lost: %+v", revs)
	}

	// A new page from disk gets its first version.
	h.write("Work/Inbox/Script.md", "made by a script")
	h.scan()
	if revs := h.history("Work/Inbox/Script.md"); len(revs) != 1 || revs[0].Source != "disk" {
		t.Fatalf("new page from disk: %+v", revs)
	}

	// Touching a file without changing it adds nothing.
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(filepath.Join(h.dir, "Work/Inbox/Script.md"), later, later); err != nil {
		t.Fatal(err)
	}
	if changed := h.scan(); len(changed) != 1 {
		t.Fatalf("touched file not re-read: %v", changed)
	}
	if revs := h.history("Work/Inbox/Script.md"); len(revs) != 1 {
		t.Fatalf("touch added a version: %+v", revs)
	}

	// A folder that goes missing and comes back neither adds versions nor
	// loses them.
	tmp := filepath.Join(t.TempDir(), "Work")
	if err := os.Rename(filepath.Join(h.dir, "Work"), tmp); err != nil {
		t.Fatal(err)
	}
	h.scan()
	if err := os.Rename(tmp, filepath.Join(h.dir, "Work")); err != nil {
		t.Fatal(err)
	}
	h.scan()
	for p, n := range map[string]int{"Work/Doc.md": 2, "Work/Old.md": 2, "Work/Inbox/Script.md": 1} {
		if revs := h.history(p); len(revs) != n {
			t.Fatalf("%s after its folder went away and came back: %+v", p, revs)
		}
	}
	// So does a folder that's briefly empty.
	if err := os.Rename(filepath.Join(h.dir, "Work/Inbox/Script.md"), filepath.Join(t.TempDir(), "Script.md")); err != nil {
		t.Fatal(err)
	}
	h.scan()
	if revs := h.history("Work/Inbox/Script.md"); len(revs) != 1 {
		t.Fatalf("history of a missing page: %+v", revs)
	}

	// A save through Quire afterwards doesn't add a duplicate "earlier" copy.
	h.put("Work/Doc.md", "back in Quire")
	if revs := h.history("Work/Doc.md"); len(revs) != 3 || revs[0].Source != "edit" {
		t.Fatalf("save after an outside edit: %+v", revs)
	}
}

// History from disk is pruned like any other.
func TestDiskHistoryIsCapped(t *testing.T) {
	h := newHarness(t)
	st := h.srv.store
	for i := range 450 {
		var err error
		if i%2 == 0 {
			err = st.Record("Work/Busy.md", nil, []byte("edit "+itoa(int64(i))), "edit")
		} else {
			err = st.RecordDisk("Work/Busy.md", nil, []byte("disk "+itoa(int64(i))))
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	revs, err := st.Revisions("Work/Busy.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(revs) > 200 {
		t.Fatalf("%d revisions kept", len(revs))
	}
}

type sessionReply struct {
	Authenticated bool
	Warnings      []warning
}

func warningIDs(ws []warning) []string {
	ids := []string{}
	for _, w := range ws {
		ids = append(ids, w.ID)
	}
	return ids
}

func TestHealthWarnings(t *testing.T) {
	h := newHarness(t)
	var s sessionReply
	h.do("GET", "/api/auth/session", nil, &s)
	if !s.Authenticated || !slices.Equal(warningIDs(s.Warnings), []string{"backup-off"}) {
		t.Fatalf("no backups: %+v", s)
	}
	// Signed out, the session reply carries no warnings.
	token := h.token
	h.token = ""
	var raw map[string]any
	h.do("GET", "/api/auth/session", nil, &raw)
	if _, ok := raw["warnings"]; ok {
		t.Fatalf("warnings shown signed out: %v", raw)
	}
	h.token = token

	dataDir := filepath.Dir(h.dir)
	cfg := backup.Config{URL: "http://127.0.0.1:1", Username: "alex", Password: "app-password", Folder: "Vault/Quire", Hours: 24}
	if err := h.srv.backup.Save(cfg); err != nil {
		t.Fatal(err)
	}
	reload := func() {
		t.Helper()
		bk, err := backup.New(dataDir, "test", h.srv.vault, h.srv.store, h.srv.log)
		if err != nil {
			t.Fatal(err)
		}
		h.srv.backup = bk
	}
	setStatus := func(st backup.Status) {
		t.Helper()
		b, _ := json.Marshal(map[string]any{"status": st})
		if err := os.WriteFile(filepath.Join(dataDir, "backup-state.json"), b, 0o600); err != nil {
			t.Fatal(err)
		}
		reload()
	}
	check := func(want ...string) {
		t.Helper()
		var s sessionReply
		h.do("GET", "/api/auth/session", nil, &s)
		if got := warningIDs(s.Warnings); !slices.Equal(got, append([]string{}, want...)) {
			t.Fatalf("warnings %v, want %v", got, want)
		}
	}

	// Scheduled and about to run for the first time: nothing to say.
	check()
	now := time.Now().UnixMilli()
	setStatus(backup.Status{LastRun: now, LastSuccess: now})
	check()
	setStatus(backup.Status{LastRun: now, LastSuccess: now - 10*24*3_600_000})
	check("backup-stale")
	setStatus(backup.Status{LastRun: now, LastSuccess: now - 3_600_000, LastError: "Coffer refused the username or app password"})
	check("backup-failed")

	// secret.key replaced: backups pause and ask for the app password.
	if err := os.WriteFile(filepath.Join(dataDir, "secret.key"), []byte(strings.Repeat("x", 32)), 0o600); err != nil {
		t.Fatal(err)
	}
	reload()
	check("backup-password")
	var settings struct {
		Configured bool
		Status     backup.Status
	}
	h.do("GET", "/api/backup", nil, &settings)
	if !settings.Configured || !settings.Status.NeedsPassword {
		t.Fatalf("backup settings while locked: %+v", settings)
	}
	if code := h.do("POST", "/api/backup/run", nil, nil); code != 400 {
		t.Fatalf("run while locked: %d", code)
	}
}

func TestUntrustedProxyWarning(t *testing.T) {
	h := newServer(t)
	has := func(remote, xff string) bool {
		r := httptest.NewRequest("GET", "/api/auth/session", nil)
		r.RemoteAddr = remote
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		return slices.Contains(warningIDs(h.srv.warnings(r)), "untrusted-proxy")
	}
	if !has("172.18.0.1:40000", "100.101.1.2") {
		t.Fatal("Docker bridge with X-Forwarded-For not flagged")
	}
	if has("172.18.0.1:40000", "") {
		t.Fatal("flagged without a forwarded address")
	}
	if has("127.0.0.1:40000", "100.101.1.2") {
		t.Fatal("loopback is trusted, but was flagged")
	}
	if has("203.0.113.9:40000", "10.0.0.2") {
		t.Fatal("a public address was flagged")
	}
	h.srv.cfg.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("172.16.0.0/12")}
	if has("172.18.0.1:40000", "100.101.1.2") {
		t.Fatal("flagged a trusted proxy")
	}
}

// A page's history goes to the trash with it: a page made later with the
// same name starts with none and keeps its own when the old one is purged,
// and the old one gets its history back when restored, under a numbered
// name too.
func TestTrashedHistoryStaysWithItsPage(t *testing.T) {
	h := newHarness(t)
	text := func(p string) []string {
		var out []string
		for _, r := range h.history(p) {
			out = append(out, h.revisionText(r.ID))
		}
		return out
	}
	trashed := func() vault.TrashItem {
		var trash struct{ Items []vault.TrashItem }
		h.do("GET", "/api/trash", nil, &trash)
		return trash.Items[0]
	}

	h.put("Work/Plan.md", "old plan")
	h.put("Work/Plan/Step.md", "old step")
	h.do("DELETE", "/api/notes/Work/Plan.md", nil, nil)
	h.put("Work/Plan.md", "new plan")
	if got := text("Work/Plan.md"); len(got) != 1 || got[0] != "new plan" {
		t.Fatalf("new page has the old one's history: %q", got)
	}
	var res struct{ Page string }
	h.do("POST", "/api/trash/"+trashed().ID+"/restore", nil, &res)
	if res.Page != "Work/Plan 2.md" {
		t.Fatalf("restored to %q", res.Page)
	}
	if got := text("Work/Plan 2.md"); len(got) != 1 || got[0] != "old plan" {
		t.Fatalf("restored page's history: %q", got)
	}
	if got := text("Work/Plan 2/Step.md"); len(got) != 1 || got[0] != "old step" {
		t.Fatalf("restored sub-page's history: %q", got)
	}

	h.do("DELETE", "/api/notes/Work/Plan%202.md", nil, nil)
	h.do("DELETE", "/api/trash", nil, nil)
	if got := text("Work/Plan.md"); len(got) != 1 || got[0] != "new plan" {
		t.Fatalf("purging the old page took the new one's history: %q", got)
	}

	// The same for a space.
	h.do("POST", "/api/spaces", map[string]string{"name": "Side"}, nil)
	h.put("Side/Note.md", "old note")
	h.do("DELETE", "/api/spaces/Side", nil, nil)
	h.do("POST", "/api/spaces", map[string]string{"name": "Side"}, nil)
	h.put("Side/Note.md", "new note")
	h.do("DELETE", "/api/trash/"+trashed().ID, nil, nil)
	if got := text("Side/Note.md"); len(got) != 1 || got[0] != "new note" {
		t.Fatalf("purging the old space took the new one's history: %q", got)
	}
}

// Items trashed before history went along with them still have it at
// their old paths: purging takes only what was there when they were deleted.
func TestPurgeOfOlderTrashKeepsNewerHistory(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Plan.md", "old plan")
	if _, err := h.srv.vault.Trash("Work/Plan", "page", "Work/Plan.md"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	h.scan()
	h.put("Work/Plan.md", "new plan")
	var trash struct{ Items []vault.TrashItem }
	h.do("GET", "/api/trash", nil, &trash)
	h.do("DELETE", "/api/trash/"+trash.Items[0].ID, nil, nil)
	if revs := h.history("Work/Plan.md"); len(revs) != 1 || h.revisionText(revs[0].ID) != "new plan" {
		t.Fatalf("history after purging an older item: %+v", revs)
	}
}

// Keeping one's own version after a conflict doesn't write over the other
// one in history, though both were saves made minutes apart.
func TestConflictKeepsBothVersions(t *testing.T) {
	h := newHarness(t)
	d := h.put("Work/Doc.md", "one")
	var theirs noteDetail
	h.do("PUT", "/api/notes/Work/Doc.md", map[string]string{"content": "theirs", "baseRev": d.Rev}, &theirs)
	if code := h.do("PUT", "/api/notes/Work/Doc.md", map[string]any{"content": "mine", "baseRev": theirs.Rev, "conflict": true}, nil); code != 200 {
		t.Fatalf("keep mine: %d", code)
	}
	var got []string
	for _, r := range h.history("Work/Doc.md") {
		got = append(got, r.Source+":"+h.revisionText(r.ID))
	}
	if !slices.Equal(got, []string{"conflict:mine", "edit:theirs"}) {
		t.Fatalf("history: %q", got)
	}
}
