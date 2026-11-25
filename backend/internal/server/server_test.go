package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/oddomens/quire/internal/auth"
	"github.com/oddomens/quire/internal/backup"
	"github.com/oddomens/quire/internal/store"
	"github.com/oddomens/quire/internal/vault"
)

const testPassword = "correct horse battery"

type harness struct {
	t      *testing.T
	srv    *Server
	ts     *httptest.Server
	dir    string
	token  string
	header http.Header
}

func newServer(t *testing.T) *harness {
	t.Helper()
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
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	bk, err := backup.New(dir, "test", v, st, log)
	if err != nil {
		t.Fatal(err)
	}
	srv := New(Config{ScanInterval: time.Second}, v, st, bk, fstest.MapFS{}, log)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	if err := v.Mkdir("Work"); err != nil {
		t.Fatal(err)
	}
	return &harness{t: t, srv: srv, ts: ts, dir: filepath.Join(dir, "notes"), header: http.Header{}}
}

// newHarness is a server with an account, signed in with a bearer token.
func newHarness(t *testing.T) *harness {
	h := newServer(t)
	if _, err := h.srv.Bootstrap("Tester", testPassword); err != nil {
		t.Fatal(err)
	}
	var login struct{ Token string }
	if code := h.do("POST", "/api/auth/login", map[string]string{"password": testPassword}, &login); code != 200 {
		t.Fatalf("login: %d", code)
	}
	h.token = login.Token
	return h
}

func (h *harness) do(method, path string, body, out any) int {
	h.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, h.ts.URL+path, rd)
	for k, v := range h.header {
		req.Header[k] = v
	}
	if h.token != "" {
		req.Header.Set("Authorization", "Bearer "+h.token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	if out != nil {
		_ = json.NewDecoder(res.Body).Decode(out)
	}
	return res.StatusCode
}

func (h *harness) put(p, content string) noteDetail {
	h.t.Helper()
	var d noteDetail
	if code := h.do("PUT", "/api/notes/"+p, map[string]string{"content": content}, &d); code != 200 {
		h.t.Fatalf("put %s: %d", p, code)
	}
	return d
}

func (h *harness) read(p string) string {
	b, err := os.ReadFile(filepath.Join(h.dir, p))
	if err != nil {
		h.t.Fatal(err)
	}
	return string(b)
}

func (h *harness) exists(p string) bool {
	_, err := os.Stat(filepath.Join(h.dir, p))
	return err == nil
}

func TestSetupNeedsTheCode(t *testing.T) {
	h := newServer(t)
	code, _ := h.srv.SetupCode()
	if code == "" {
		t.Fatal("no setup code before setup")
	}
	if c := h.do("POST", "/api/auth/setup", map[string]string{"code": "WRONG-CODE", "name": "Me", "password": testPassword}, nil); c != 401 {
		t.Fatalf("wrong setup code: %d", c)
	}
	if c := h.do("POST", "/api/auth/setup", map[string]string{"code": code, "name": "Me", "password": "short"}, nil); c != 400 {
		t.Fatalf("short password: %d", c)
	}
	var res struct{ Token string }
	if c := h.do("POST", "/api/auth/setup", map[string]string{"code": strings.ToLower(code), "name": "Me", "password": testPassword}, &res); c != 200 || res.Token == "" {
		t.Fatalf("setup: %d", c)
	}
	if c := h.do("POST", "/api/auth/setup", map[string]string{"code": code, "name": "Again", "password": testPassword}, nil); c != 409 {
		t.Fatalf("second setup: %d", c)
	}
}

func TestAuthRequired(t *testing.T) {
	h := newHarness(t)
	token := h.token
	h.token = ""
	if code := h.do("GET", "/api/tree", nil, nil); code != 401 {
		t.Fatalf("tree without session: %d", code)
	}
	if code := h.do("POST", "/api/auth/login", map[string]string{"password": "nope"}, nil); code != 401 {
		t.Fatalf("wrong password: %d", code)
	}
	// A cookie session must send X-Client-Id on writes (CSRF).
	h.header.Set("Cookie", cookieName+"="+token)
	if code := h.do("POST", "/api/spaces", map[string]string{"name": "X"}, nil); code != 403 {
		t.Fatalf("cookie write without X-Client-Id: %d", code)
	}
	h.header.Set("X-Client-Id", "test")
	if code := h.do("POST", "/api/spaces", map[string]string{"name": "X"}, nil); code != 201 {
		t.Fatalf("cookie write with X-Client-Id: %d", code)
	}
	h.header.Set("Origin", "https://evil.example")
	if code := h.do("POST", "/api/spaces", map[string]string{"name": "Y"}, nil); code != 403 {
		t.Fatalf("cross-origin write: %d", code)
	}
}

func TestTwoFactor(t *testing.T) {
	h := newHarness(t)
	var setup struct{ Secret string }
	if c := h.do("POST", "/api/account/2fa/setup", map[string]string{"password": testPassword}, &setup); c != 200 {
		t.Fatalf("2fa setup: %d", c)
	}
	var enabled struct{ RecoveryCodes []string }
	if c := h.do("POST", "/api/account/2fa/enable", map[string]string{"code": auth.TOTPCode(setup.Secret, time.Now())}, &enabled); c != 200 || len(enabled.RecoveryCodes) != 10 {
		t.Fatalf("2fa enable: %d", c)
	}
	h.token = ""
	var res map[string]any
	if c := h.do("POST", "/api/auth/login", map[string]string{"password": testPassword}, &res); c != 401 || res["twoFactor"] != true {
		t.Fatalf("login without code: %d %v", c, res)
	}
	// The code that enabled 2FA was used already; replaying it fails.
	if c := h.do("POST", "/api/auth/login", map[string]string{"password": testPassword, "code": auth.TOTPCode(setup.Secret, time.Now())}, nil); c != 401 {
		t.Fatalf("replayed code: %d", c)
	}
	rc := enabled.RecoveryCodes[0]
	if c := h.do("POST", "/api/auth/login", map[string]string{"password": testPassword, "code": rc}, nil); c != 200 {
		t.Fatalf("recovery code: %d", c)
	}
	if c := h.do("POST", "/api/auth/login", map[string]string{"password": testPassword, "code": rc}, nil); c != 401 {
		t.Fatalf("spent recovery code: %d", c)
	}
}

func TestPagesLinksAndMoves(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Alpha.md", "# Alpha\nSee [[Beta]] and [[Work/Alpha/Gamma|g]]. #work")
	h.put("Work/Beta.md", "Back to [[alpha#Intro]].\n```\n[[Not a link]]\n```")
	h.put("Work/Alpha/Gamma.md", "Gamma is a sub-page")

	var beta noteDetail
	h.do("GET", "/api/notes/Work/Beta.md", nil, &beta)
	if len(beta.Backlinks) != 1 || beta.Backlinks[0].Path != "Work/Alpha.md" {
		t.Fatalf("Beta backlinks: %+v", beta.Backlinks)
	}
	if len(beta.Outgoing) != 1 {
		t.Fatalf("Beta outgoing (code block link should be ignored): %+v", beta.Outgoing)
	}

	// Moving a page takes its sub-pages along and rewrites links to both.
	h.do("POST", "/api/spaces", map[string]string{"name": "Archive"}, nil)
	if code := h.do("POST", "/api/move", map[string]string{"from": "Work/Alpha.md", "to": "Archive/Alpha Prime.md"}, nil); code != 200 {
		t.Fatalf("move page: %d", code)
	}
	if !h.exists("Archive/Alpha Prime/Gamma.md") || h.exists("Work/Alpha") {
		t.Fatal("sub-page didn't move with its parent")
	}
	if got := h.read("Work/Beta.md"); !strings.Contains(got, "[[Alpha Prime#Intro]]") {
		t.Fatalf("Beta after rename: %q", got)
	}
	if got := h.read("Archive/Alpha Prime.md"); !strings.Contains(got, "[[Archive/Alpha Prime/Gamma|g]]") {
		t.Fatalf("path link after move: %q", got)
	}

	// A page can't move inside itself, or out of a space.
	if code := h.do("POST", "/api/move", map[string]string{"from": "Archive/Alpha Prime", "to": "Archive/Alpha Prime/Gamma/X"}, nil); code != 400 {
		t.Fatalf("move into itself: %d", code)
	}
	if code := h.do("POST", "/api/move", map[string]string{"from": "Work/Beta.md", "to": "Beta.md"}, nil); code != 400 {
		t.Fatalf("move to vault root: %d", code)
	}

	var hits []store.Hit
	h.do("GET", "/api/search?q=gam", nil, &hits)
	if len(hits) == 0 || hits[0].Path != "Archive/Alpha Prime/Gamma.md" {
		t.Fatalf("search: %+v", hits)
	}
}

func TestSpaces(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Plan.md", "plan")
	h.put("Work/Other.md", "see [[Work/Plan]]")
	if code := h.do("PATCH", "/api/spaces/Work", map[string]string{"name": "Office", "color": "#12b886"}, nil); code != 200 {
		t.Fatalf("rename space: %d", code)
	}
	if got := h.read("Office/Other.md"); !strings.Contains(got, "[[Office/Plan]]") {
		t.Fatalf("link after space rename: %q", got)
	}
	var spaces []space
	h.do("GET", "/api/spaces", nil, &spaces)
	if len(spaces) != 1 || spaces[0].Name != "Office" || spaces[0].Pages != 2 || spaces[0].Color != "#12b886" {
		t.Fatalf("spaces: %+v", spaces)
	}
	if code := h.do("POST", "/api/spaces", map[string]string{"name": "office"}, nil); code != 409 {
		t.Fatalf("case-clashing space: %d", code)
	}
	if code := h.do("DELETE", "/api/spaces/Office", nil, nil); code != 204 {
		t.Fatalf("delete space: %d", code)
	}
	var tree struct{ Notes []store.Note }
	h.do("GET", "/api/tree", nil, &tree)
	if len(tree.Notes) != 0 {
		t.Fatalf("pages left after deleting the space: %+v", tree.Notes)
	}
}

func TestGraphKeepsToItsSpace(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Plan.md", "see [[Work/Notes]] and [[Home/List]]")
	h.put("Work/Notes.md", "notes")
	h.do("POST", "/api/spaces", map[string]string{"name": "Home"}, nil)
	h.put("Home/List.md", "back to [[Work/Plan]]")

	var all, work store.Graph
	h.do("GET", "/api/graph", nil, &all)
	if len(all.Nodes) != 3 || len(all.Edges) != 2 {
		t.Fatalf("whole graph: %+v", all)
	}
	h.do("GET", "/api/graph?space=Work", nil, &work)
	if len(work.Nodes) != 2 || len(work.Edges) != 1 {
		t.Fatalf("Work graph: %+v", work)
	}
	for _, n := range work.Nodes {
		if !strings.HasPrefix(n.Path, "Work/") {
			t.Fatalf("node from another space: %+v", n)
		}
		if n.Path == "Work/Plan.md" && n.Links != 1 {
			t.Fatalf("cross-space link counted: %+v", n)
		}
	}
	if code := h.do("GET", "/api/graph?space=..", nil, nil); code != 400 {
		t.Fatalf("bad space name: %d", code)
	}
}

func TestSpaceIcons(t *testing.T) {
	h := newHarness(t)
	get := func(name string) space {
		t.Helper()
		var spaces []space
		h.do("GET", "/api/spaces", nil, &spaces)
		for _, s := range spaces {
			if s.Name == name {
				return s
			}
		}
		t.Fatalf("no space %q in %+v", name, spaces)
		return space{}
	}

	// Older .space.json files have no icon, and the API leaves the key out.
	os.WriteFile(filepath.Join(h.dir, "Work/.space.json"), []byte(`{"description":"old","color":"#12b886"}`), 0o644)
	if s := get("Work"); s.Icon != "" || s.Color != "#12b886" || s.Description != "old" {
		t.Fatalf("old meta: %+v", s)
	}
	res, err := http.NewRequest("GET", h.ts.URL+"/api/spaces", nil)
	if err != nil {
		t.Fatal(err)
	}
	res.Header.Set("Authorization", "Bearer "+h.token)
	raw, err := http.DefaultClient.Do(res)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(raw.Body)
	raw.Body.Close()
	if strings.Contains(string(body), `"icon"`) {
		t.Fatalf("icon key without an icon: %s", body)
	}

	var created space
	if code := h.do("POST", "/api/spaces", map[string]string{"name": "Games", "icon": "gamepad-2"}, &created); code != 201 || created.Icon != "gamepad-2" {
		t.Fatalf("create with icon: %d %+v", code, created)
	}
	if !strings.Contains(h.read("Games/.space.json"), `"icon": "gamepad-2"`) {
		t.Fatalf("icon not saved: %s", h.read("Games/.space.json"))
	}
	for _, bad := range []string{"Book", "book_open", "-book", "book-", "book--open", "../x", "book open", "<svg>", strings.Repeat("a", 49)} {
		if code := h.do("POST", "/api/spaces", map[string]string{"name": "Bad", "icon": bad}, nil); code != 400 {
			t.Fatalf("create with icon %q: %d", bad, code)
		}
		if code := h.do("PATCH", "/api/spaces/Games", map[string]string{"name": "Renamed", "icon": bad}, nil); code != 400 {
			t.Fatalf("update with icon %q: %d", bad, code)
		}
	}
	if h.exists("Bad") || h.exists("Renamed") {
		t.Fatal("a rejected icon still created or renamed a space")
	}

	// Updates without an icon keep it; an empty icon clears it.
	var updated space
	if code := h.do("PATCH", "/api/spaces/Games", map[string]string{"description": "play"}, &updated); code != 200 || updated.Icon != "gamepad-2" {
		t.Fatalf("update keeps icon: %d %+v", code, updated)
	}
	if code := h.do("PATCH", "/api/spaces/Games", map[string]string{"name": "Play", "icon": "book-open"}, &updated); code != 200 || updated.Icon != "book-open" || updated.Name != "Play" {
		t.Fatalf("rename and change icon: %d %+v", code, updated)
	}
	var d spaceStats
	if code := h.do("GET", "/api/spaces/Play", nil, &d); code != 200 || d.Icon != "book-open" || d.Description != "play" {
		t.Fatalf("details: %d %+v", code, d)
	}
	var cleared space
	if code := h.do("PATCH", "/api/spaces/Play", map[string]string{"icon": ""}, &cleared); code != 200 || cleared.Icon != "" {
		t.Fatalf("clear icon: %d %+v", code, cleared)
	}
	if strings.Contains(h.read("Play/.space.json"), "icon") {
		t.Fatalf("cleared icon still saved: %s", h.read("Play/.space.json"))
	}

	// A hand-edited bad icon is ignored rather than passed on.
	os.WriteFile(filepath.Join(h.dir, "Play/.space.json"), []byte(`{"color":"#12b886","icon":"<script>"}`), 0o644)
	if s := get("Play"); s.Icon != "" {
		t.Fatalf("bad stored icon: %+v", s)
	}
}

func TestTrashAndRestore(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Parent.md", "parent")
	h.put("Work/Parent/Child.md", "child")
	if code := h.do("DELETE", "/api/notes/Work/Parent.md", nil, nil); code != 204 {
		t.Fatalf("delete: %d", code)
	}
	if h.exists("Work/Parent.md") || h.exists("Work/Parent") {
		t.Fatal("page still on disk")
	}
	var trash struct{ Items []vault.TrashItem }
	h.do("GET", "/api/trash", nil, &trash)
	if len(trash.Items) != 1 || trash.Items[0].Pages != 2 || trash.Items[0].Path != "Work/Parent" {
		t.Fatalf("trash: %+v", trash.Items)
	}
	// Something new took the name meanwhile; the restore comes back numbered.
	h.put("Work/Parent.md", "new parent")
	var res struct{ Page string }
	if code := h.do("POST", "/api/trash/"+trash.Items[0].ID+"/restore", nil, &res); code != 200 {
		t.Fatalf("restore: %d", code)
	}
	if res.Page != "Work/Parent 2.md" || h.read("Work/Parent 2/Child.md") != "child" {
		t.Fatalf("restored to %q", res.Page)
	}
}

func TestMaintenanceForgetsOnlyWhatWasDeleted(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Keep.md", "keep")
	h.put("Work/Parent.md", "parent")
	h.put("Work/Parent/Child.md", "child")
	h.put("Work/Gone.md", "gone")
	h.do("DELETE", "/api/notes/Work/Parent.md", nil, nil)
	h.do("DELETE", "/api/notes/Work/Gone.md", nil, nil)
	var trash struct{ Items []vault.TrashItem }
	h.do("GET", "/api/trash", nil, &trash)
	for _, it := range trash.Items {
		if it.Path == "Work/Gone" {
			if code := h.do("DELETE", "/api/trash/"+it.ID, nil, nil); code != 204 {
				t.Fatalf("purge: %d", code)
			}
		}
	}
	h.srv.limiter.begin("192.0.2.1")
	h.srv.limiter.fails["192.0.2.1"][0] = time.Now().Add(-time.Hour)

	// A page whose file vanishes from disk (an unmounted drive, say) keeps its history.
	h.put("Work/Away.md", "away")
	if err := os.Remove(filepath.Join(h.dir, "Work/Away.md")); err != nil {
		t.Fatal(err)
	}
	if _, err := h.srv.Scan(); err != nil {
		t.Fatal(err)
	}

	h.srv.maintain()

	count := func(p string) int {
		revs, err := h.srv.store.Revisions(p)
		if err != nil {
			t.Fatal(err)
		}
		return len(revs)
	}
	var parent vault.TrashItem
	for _, it := range trash.Items {
		if it.Path == "Work/Parent" {
			parent = it
		}
	}
	// Live pages, pages waiting in the trash (their history waits with them,
	// sub-pages too) and missing files keep their history.
	if count("Work/Keep.md") != 1 || count(parent.TrashedPath("Work/Parent.md")) != 1 ||
		count(parent.TrashedPath("Work/Parent/Child.md")) != 1 || count("Work/Away.md") != 1 {
		t.Fatal("history of a live, trashed or missing page was removed")
	}
	if count("Work/Gone.md") != 0 {
		t.Fatal("history of a purged page was kept")
	}

	// Emptying the trash takes the rest of the history with it, sub-pages too.
	h.do("DELETE", "/api/trash", nil, nil)
	if count(parent.TrashedPath("Work/Parent.md")) != 0 || count(parent.TrashedPath("Work/Parent/Child.md")) != 0 {
		t.Fatal("history kept after emptying the trash")
	}
	if len(h.srv.limiter.fails) != 0 {
		t.Fatalf("stale login failures kept: %v", h.srv.limiter.fails)
	}
	// Signing in still works afterwards: live sessions aren't touched.
	if code := h.do("GET", "/api/account", nil, nil); code != 200 {
		t.Fatalf("session after tidy: %d", code)
	}
}

func TestHistory(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Doc.md", "one")
	// An edit made outside Quire is kept as its own version.
	if err := os.WriteFile(filepath.Join(h.dir, "Work/Doc.md"), []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.put("Work/Doc.md", "two")
	var revs []store.Revision
	h.do("GET", "/api/history/Work/Doc.md", nil, &revs)
	if len(revs) != 3 {
		t.Fatalf("revisions: %+v", revs)
	}
	var old store.Revision
	for _, r := range revs {
		h.do("GET", "/api/revisions/"+itoa(r.ID), nil, &old)
		if old.Content == "one" {
			break
		}
	}
	if code := h.do("POST", "/api/revisions/"+itoa(old.ID)+"/restore", nil, nil); code != 200 || h.read("Work/Doc.md") != "one" {
		t.Fatalf("restore revision: %d", code)
	}
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

func TestConflict(t *testing.T) {
	h := newHarness(t)
	d := h.put("Work/Doc.md", "one")
	h.do("PUT", "/api/notes/Work/Doc.md", map[string]string{"content": "two", "baseRev": d.Rev}, nil)
	if code := h.do("PUT", "/api/notes/Work/Doc.md", map[string]string{"content": "three", "baseRev": d.Rev}, nil); code != 409 {
		t.Fatalf("stale save: %d", code)
	}
}

// A save against a page that was deleted or moved meanwhile doesn't bring
// it back.
func TestSaveToAMissingPage(t *testing.T) {
	h := newHarness(t)
	d := h.put("Work/Doc.md", "one")
	if code := h.do("DELETE", "/api/notes/Work/Doc.md", nil, nil); code != 204 {
		t.Fatalf("delete: %d", code)
	}
	var res struct {
		Error   string
		Missing bool
	}
	if code := h.do("PUT", "/api/notes/Work/Doc.md", map[string]string{"content": "two", "baseRev": d.Rev}, &res); code != 409 || !res.Missing {
		t.Fatalf("save to a deleted page: %d %+v", code, res)
	}
	if h.exists("Work/Doc.md") {
		t.Fatal("deleted page recreated")
	}
	// Without a base version it's a new page, as before.
	h.put("Work/Doc.md", "fresh")
}

// A rename that only changes case still refuses to land on another page
// whose name differs only in case.
func TestCaseOnlyRename(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Plan.md", "upper")
	h.put("Work/plan.md", "lower")
	if code := h.do("POST", "/api/move", map[string]string{"from": "Work/Plan.md", "to": "Work/plan.md"}, nil); code != 409 {
		t.Fatalf("rename onto another page: %d", code)
	}
	if h.read("Work/Plan.md") != "upper" || h.read("Work/plan.md") != "lower" {
		t.Fatal("pages changed by a refused rename")
	}
	h.put("Work/Notes.md", "notes")
	if code := h.do("POST", "/api/move", map[string]string{"from": "Work/Notes.md", "to": "Work/NOTES.md"}, nil); code != 200 {
		t.Fatalf("case-only rename: %d", code)
	}
	if h.read("Work/NOTES.md") != "notes" {
		t.Fatal("case-only rename lost the page")
	}
}

func TestSpaceDetailsAndExport(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Plan.md", "plan ![chart](attachments/chart.png) #roadmap")
	h.put("Work/Plan/Q1.md", "q1 [[Plan]] #roadmap")
	os.MkdirAll(filepath.Join(h.dir, "attachments"), 0o755)
	os.WriteFile(filepath.Join(h.dir, "attachments/chart.png"), []byte("png"), 0o644)
	os.WriteFile(filepath.Join(h.dir, "attachments/unrelated.png"), []byte("png"), 0o644)

	var d spaceStats
	if code := h.do("GET", "/api/spaces/Work", nil, &d); code != 200 || d.Pages != 2 || d.TopLevel != 1 || d.Nested != 1 || d.Links != 1 || len(d.Tags) != 1 {
		t.Fatalf("details: %d %+v", code, d)
	}
	req, _ := http.NewRequest("GET", h.ts.URL+"/api/spaces/Work/export", nil)
	req.Header.Set("Authorization", "Bearer "+h.token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, f := range zr.File {
		names[f.Name] = true
	}
	if !names["Work/Plan.md"] || !names["Work/Plan/Q1.md"] || !names["attachments/chart.png"] || names["attachments/unrelated.png"] {
		t.Fatalf("export: %v", names)
	}
}

func TestBackupSettingsNeedPassword(t *testing.T) {
	h := newHarness(t)
	body := map[string]any{"url": "https://coffer.example", "username": "a", "password": "p", "folder": "Place/Quire", "hours": 24, "current": "wrong"}
	if code := h.do("PUT", "/api/backup", body, nil); code != 403 {
		t.Fatalf("backup settings without the password: %d", code)
	}
	body["current"] = testPassword
	if code := h.do("PUT", "/api/backup", body, nil); code != 200 {
		t.Fatalf("backup settings: %d", code)
	}
	var got map[string]any
	h.do("GET", "/api/backup", nil, &got)
	if got["configured"] != true || got["password"] != nil {
		t.Fatalf("backup settings leak or missing: %v", got)
	}
}

func TestSharing(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Public.md", "Hello ![chart](attachments/chart.png)")
	h.put("Work/Private.md", "secret")
	os.MkdirAll(filepath.Join(h.dir, "attachments"), 0o755)
	os.WriteFile(filepath.Join(h.dir, "attachments/chart.png"), []byte("png"), 0o644)
	os.WriteFile(filepath.Join(h.dir, "attachments/other.png"), []byte("png"), 0o644)

	var sh store.Share
	if code := h.do("POST", "/api/shares", map[string]string{"path": "Work/Public.md"}, &sh); code != 201 {
		t.Fatalf("share: %d", code)
	}
	h.token = ""
	var page struct{ Title, Content string }
	if code := h.do("GET", "/api/public/"+sh.Token, nil, &page); code != 200 || page.Title != "Public" {
		t.Fatalf("public page: %d %+v", code, page)
	}
	if code := h.do("GET", "/api/public/"+sh.Token+"/files/attachments/chart.png", nil, nil); code != 200 {
		t.Fatalf("embedded file: %d", code)
	}
	if code := h.do("GET", "/api/public/"+sh.Token+"/files/attachments/other.png", nil, nil); code != 404 {
		t.Fatalf("file the page doesn't embed: %d", code)
	}
	if code := h.do("GET", "/api/public/"+sh.Token+"/files/Work/Private.md", nil, nil); code != 404 {
		t.Fatalf("another page through the share: %d", code)
	}
	if code := h.do("GET", "/api/public/AAAAAAAAAAAAAAAAAAAAAAAA", nil, nil); code != 404 {
		t.Fatalf("unknown token: %d", code)
	}
}

// A share serves the page without its front matter (bar the width), and
// only attachments the page itself refers to, by exact path.
func TestSharedPageAndFiles(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Public.md", "---\ntags: [plans]\nwidth: full\nreviewer: only me\n---\nHello ![chart](attachments/chart.png) ![[photo 1.jpg]]")
	os.MkdirAll(filepath.Join(h.dir, "attachments"), 0o755)
	for _, f := range []string{"chart.png", "chart", "photo 1.jpg", "photo"} {
		os.WriteFile(filepath.Join(h.dir, "attachments", f), []byte("x"), 0o644)
	}
	var sh store.Share
	if code := h.do("POST", "/api/shares", map[string]string{"path": "Work/Public.md"}, &sh); code != 201 {
		t.Fatalf("share: %d", code)
	}
	h.token = ""
	var page struct{ Content, Width string }
	h.do("GET", "/api/public/"+sh.Token, nil, &page)
	if strings.Contains(page.Content, "reviewer") || strings.Contains(page.Content, "plans") || !strings.Contains(page.Content, "Hello") {
		t.Fatalf("front matter shared: %q", page.Content)
	}
	if page.Width != "full" || !strings.HasPrefix(page.Content, "---\nwidth: full\n---\n") {
		t.Fatalf("width lost: %+v", page)
	}
	for f, want := range map[string]int{
		"attachments/chart.png":     200,
		"attachments/photo%201.jpg": 200,
		"attachments/chart":         404, // a prefix of a real reference
		"attachments/photo":         404,
	} {
		if code := h.do("GET", "/api/public/"+sh.Token+"/files/"+f, nil, nil); code != want {
			t.Errorf("%s: %d, want %d", f, code, want)
		}
	}
}

// Only the attachment routes skip the app's CSP, and requests may carry
// fields this version doesn't know.
func TestCSPAndUnknownFields(t *testing.T) {
	h := newHarness(t)
	for p, own := range map[string]bool{
		"/api/files/attachments/x.png":        true,
		"/api/public/tok/files/attachments/x": true,
		"/api/spaces/files/x":                 false,
		"/s/files/x":                          false,
		"/api/public/files/x":                 false,
	} {
		req, _ := http.NewRequest("GET", h.ts.URL+p, nil)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if csp := res.Header.Get("Content-Security-Policy"); (csp == "") != own {
			t.Errorf("%s: CSP %q", p, csp)
		}
	}
	if code := h.do("POST", "/api/spaces", map[string]any{"name": "Later", "fromAFutureApp": true}, nil); code != 201 {
		t.Fatalf("request with an unknown field: %d", code)
	}
}

func TestPathsStayInVault(t *testing.T) {
	h := newHarness(t)
	for _, p := range []string{"../escape.md", "Work/.trash/x.md", "Work/a/../../../b.md", "Root.md", "attachments/x.md"} {
		if code := h.do("PUT", "/api/notes/"+p, map[string]string{"content": "x"}, nil); code == 200 {
			t.Fatalf("%s was accepted", p)
		}
	}
}

func TestScanPicksUpOutsideEdits(t *testing.T) {
	h := newHarness(t)
	os.MkdirAll(filepath.Join(h.dir, "Work", "Inbox"), 0o755)
	os.WriteFile(filepath.Join(h.dir, "Work", "Inbox", "From disk.md"), []byte("hello #inbox"), 0o644)
	os.WriteFile(filepath.Join(h.dir, "Loose.md"), []byte("dropped at the root"), 0o644)
	changed, err := h.srv.Scan()
	if err != nil || len(changed) != 2 {
		t.Fatalf("scan: %v %v", changed, err)
	}
	if !h.exists(LooseSpace + "/Loose.md") {
		t.Fatal("root-level page wasn't moved into a space")
	}
	var tags []store.Tag
	h.do("GET", "/api/tags", nil, &tags)
	if len(tags) != 1 || tags[0].Tag != "inbox" {
		t.Fatalf("tags: %+v", tags)
	}
}

func TestSecretWarnings(t *testing.T) {
	h := newHarness(t)
	// Assembled so this file doesn't look like it holds a token.
	token := "ghp" + "_" + "R8xk2LmQ9vTz4NcW7pYb1HsJ6dFa3GeU0iKo"

	// Saving still works, and the response says what looks like a secret.
	d := h.put("Work/Server.md", "# Server\n\nDeploy token: "+token+"\n")
	if len(d.Warnings) != 1 || d.Warnings[0].Kind != "github-token" || d.Warnings[0].Line != 3 || d.Warnings[0].Preview != "ghp_•••" {
		t.Fatalf("save warnings: %+v", d.Warnings)
	}
	if !strings.Contains(h.read("Work/Server.md"), token) {
		t.Fatal("the page wasn't saved as written")
	}

	// A page written straight to disk is flagged when it's opened.
	os.WriteFile(filepath.Join(h.dir, "Work", "Disk.md"), []byte("PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=\n"), 0o644)
	var disk noteDetail
	h.do("GET", "/api/notes/Work/Disk.md", nil, &disk)
	if len(disk.Warnings) != 1 || disk.Warnings[0].Kind != "wireguard-key" {
		t.Fatalf("open warnings: %+v", disk.Warnings)
	}

	// "secrets: ok" turns the warning off, and clean pages leave the field out.
	if d := h.put("Work/Server.md", "---\nsecrets: ok\n---\nDeploy token: "+token+"\n"); len(d.Warnings) != 0 {
		t.Fatalf("opted-out page warned: %+v", d.Warnings)
	}
	var raw map[string]any
	h.do("PUT", "/api/notes/Work/Clean.md", map[string]string{"content": "Names only: `DEPLOY_TOKEN` lives in Coffer."}, &raw)
	if _, ok := raw["warnings"]; ok {
		t.Fatalf("clean page has warnings: %v", raw["warnings"])
	}
}

// A "verified:" date in the front matter is no longer read; it's kept as
// written like any other key Quire doesn't use.
func TestVerifiedIsPlainFrontmatter(t *testing.T) {
	h := newHarness(t)
	page := "---\ntags: [infra]\nverified: 2026-08-01\n---\n# Router"
	h.put("Work/Router.md", page)
	var raw map[string]any
	h.do("GET", "/api/notes/Work/Router.md", nil, &raw)
	if _, ok := raw["verified"]; ok || raw["content"] != page {
		t.Fatalf("note: %v", raw)
	}
	var tree struct{ Notes []map[string]any }
	h.do("GET", "/api/tree", nil, &tree)
	for _, n := range tree.Notes {
		if _, ok := n["verified"]; ok {
			t.Fatalf("tree lists verified: %v", n)
		}
	}
	if data, _ := os.ReadFile(filepath.Join(h.dir, "Work", "Router.md")); string(data) != page {
		t.Fatalf("file = %q", data)
	}
}

type treeResponse struct {
	Notes   []store.Note
	Folders []string
	Order   map[string][]string
}

func (h *harness) tree() treeResponse {
	h.t.Helper()
	var tr treeResponse
	if code := h.do("GET", "/api/tree", nil, &tr); code != 200 {
		h.t.Fatalf("tree: %d", code)
	}
	return tr
}

func (h *harness) reorder(p, parent, before string) map[string]any {
	h.t.Helper()
	var res map[string]any
	if code := h.do("POST", "/api/reorder", map[string]string{"path": p, "parent": parent, "before": before}, &res); code != 200 {
		h.t.Fatalf("reorder %s into %s before %q: %d %v", p, parent, before, code, res)
	}
	return res
}

func (h *harness) orderFile(folder string) []string {
	h.t.Helper()
	var names []string
	if err := json.Unmarshal([]byte(h.read(folder+"/"+vault.OrderFile)), &names); err != nil {
		h.t.Fatal(err)
	}
	return names
}

func sameNames(a, b []string) bool { return strings.Join(a, "|") == strings.Join(b, "|") }

func TestReorderWithinAFolder(t *testing.T) {
	h := newHarness(t)
	for _, p := range []string{"Work/Page 10.md", "Work/Page 2.md", "Work/beta.md", "Work/Alpha.md"} {
		h.put(p, p)
	}
	if tr := h.tree(); tr.Order == nil || len(tr.Order) != 0 {
		t.Fatalf("order before any reordering: %v", tr.Order)
	}
	// Unlisted pages start out alphabetical, numbers by value.
	h.reorder("Work/beta.md", "Work", "Work/Alpha.md")
	if got := h.orderFile("Work"); !sameNames(got, []string{"beta", "Alpha", "Page 2", "Page 10"}) {
		t.Fatalf("order file: %v", got)
	}
	h.reorder("Work/Alpha.md", "Work", "")
	if got := h.tree().Order["Work"]; !sameNames(got, []string{"beta", "Page 2", "Page 10", "Alpha"}) {
		t.Fatalf("tree order after moving to the end: %v", got)
	}
	h.reorder("Work/Page 10.md", "Work", "Work/Page 2.md")
	if got := h.tree().Order["Work"]; !sameNames(got, []string{"beta", "Page 10", "Page 2", "Alpha"}) {
		t.Fatalf("tree order after moving up: %v", got)
	}

	// New pages and pages added on disk aren't listed; they come after.
	h.put("Work/Gamma.md", "new")
	if got := h.tree().Order["Work"]; !sameNames(got, []string{"beta", "Page 10", "Page 2", "Alpha"}) {
		t.Fatalf("tree order with an unlisted page: %v", got)
	}

	// A page can't go inside itself or its own sub-pages.
	h.put("Work/Alpha/Sub.md", "sub")
	for _, parent := range []string{"Work/Alpha.md", "Work/Alpha/Sub.md"} {
		if code := h.do("POST", "/api/reorder", map[string]string{"path": "Work/Alpha.md", "parent": parent}, nil); code != 400 {
			t.Fatalf("reorder into %s: %d", parent, code)
		}
	}
	if code := h.do("POST", "/api/reorder", map[string]string{"path": "Work/Nope.md", "parent": "Work"}, nil); code != 404 {
		t.Fatalf("reorder a missing page: %d", code)
	}
	if code := h.do("POST", "/api/reorder", map[string]string{"path": "Work/Alpha.md", "parent": "Nowhere"}, nil); code != 404 {
		t.Fatalf("reorder into a missing space: %d", code)
	}

	// A corrupt order file means alphabetical, and the next write fixes it.
	os.WriteFile(filepath.Join(h.dir, "Work", vault.OrderFile), []byte("{not json"), 0o644)
	if got := h.tree().Order["Work"]; got != nil {
		t.Fatalf("corrupt order: %v", got)
	}
	h.reorder("Work/Gamma.md", "Work", "Work/Alpha.md")
	if got := h.orderFile("Work"); !sameNames(got, []string{"Gamma", "Alpha", "beta", "Page 2", "Page 10"}) {
		t.Fatalf("order after a corrupt file: %v", got)
	}
	// Entries for pages that aren't there are ignored, and pruned on write.
	os.WriteFile(filepath.Join(h.dir, "Work", vault.OrderFile), []byte(`["Ghost", "beta", "beta", "../x"]`), 0o644)
	if got := h.tree().Order["Work"]; !sameNames(got, []string{"beta"}) {
		t.Fatalf("order with stale entries: %v", got)
	}
	h.reorder("Work/Alpha.md", "Work", "")
	if got := h.orderFile("Work"); !sameNames(got, []string{"beta", "Gamma", "Page 2", "Page 10", "Alpha"}) {
		t.Fatalf("order after pruning: %v", got)
	}
}

func TestReorderIntoAnotherParent(t *testing.T) {
	h := newHarness(t)
	h.do("POST", "/api/spaces", map[string]string{"name": "Home"}, nil)
	h.put("Work/Index.md", "see [[Work/Plans/Trip]] and [[Trip]]")
	h.put("Work/Plans.md", "plans")
	h.put("Work/Plans/Trip.md", "trip")
	h.put("Work/Plans/Budget.md", "budget")
	h.put("Home/X.md", "x")
	h.put("Home/Y.md", "y")
	h.reorder("Work/Plans/Trip.md", "Work/Plans.md", "Work/Plans/Budget.md")
	if got := h.orderFile("Work/Plans"); !sameNames(got, []string{"Trip", "Budget"}) {
		t.Fatalf("sub-page order: %v", got)
	}

	// Moving to another space: the page lands where it was dropped, leaves
	// the old folder's order, and links to it are rewritten.
	res := h.reorder("Work/Plans/Trip.md", "Home", "Home/Y.md")
	if res["path"] != "Home/Trip.md" || !h.exists("Home/Trip.md") || h.exists("Work/Plans/Trip.md") {
		t.Fatalf("move: %v", res)
	}
	if got := h.orderFile("Home"); !sameNames(got, []string{"X", "Trip", "Y"}) {
		t.Fatalf("Home order: %v", got)
	}
	if got := h.orderFile("Work/Plans"); !sameNames(got, []string{"Budget"}) {
		t.Fatalf("old folder order: %v", got)
	}
	if got := h.read("Work/Index.md"); !strings.Contains(got, "[[Home/Trip]]") {
		t.Fatalf("link after move: %q", got)
	}

	// Nesting under a page with no sub-pages yet makes its folder. The old
	// folder, left with only its order file, is tidied away.
	h.reorder("Work/Plans/Budget.md", "Work/Index.md", "")
	if !h.exists("Work/Index/Budget.md") || h.exists("Work/Plans") {
		t.Fatal("old sub-page folder wasn't tidied with its order file")
	}
	if got := h.orderFile("Work/Index"); !sameNames(got, []string{"Budget"}) {
		t.Fatalf("new folder order: %v", got)
	}
	for _, f := range h.tree().Folders {
		if f == "Work/Plans" {
			t.Fatal("tidied folder still in the tree")
		}
	}

	// Back to the top of the space, first.
	h.reorder("Work/Index/Budget.md", "Work", "Work/Index.md")
	if got := h.tree().Order["Work"]; !sameNames(got, []string{"Budget", "Index", "Plans"}) {
		t.Fatalf("top-level order: %v", got)
	}
	// A name already taken in the new place is refused, and nothing moves.
	h.put("Home/Plans.md", "other plans")
	if code := h.do("POST", "/api/reorder", map[string]string{"path": "Work/Plans.md", "parent": "Home"}, nil); code != 409 {
		t.Fatalf("clashing name: %d", code)
	}
	if !h.exists("Work/Plans.md") {
		t.Fatal("page moved despite the clash")
	}
}

func TestOrderFollowsRenamesMovesAndTrash(t *testing.T) {
	h := newHarness(t)
	for _, p := range []string{"Work/A.md", "Work/B.md", "Work/C.md"} {
		h.put(p, p)
	}
	h.reorder("Work/C.md", "Work", "Work/A.md")
	h.do("POST", "/api/move", map[string]string{"from": "Work/A.md", "to": "Work/Alpha.md"}, nil)
	if got := h.orderFile("Work"); !sameNames(got, []string{"C", "Alpha", "B"}) {
		t.Fatalf("after rename: %v", got)
	}
	h.do("POST", "/api/move", map[string]string{"from": "Work/C.md", "to": "Work/B/C.md"}, nil)
	if got := h.orderFile("Work"); !sameNames(got, []string{"Alpha", "B"}) {
		t.Fatalf("after moving a page out: %v", got)
	}
	if code := h.do("PATCH", "/api/spaces/Work", map[string]string{"name": "Office"}, nil); code != 200 {
		t.Fatalf("rename space: %d", code)
	}
	if got := h.tree().Order["Office"]; !sameNames(got, []string{"Alpha", "B"}) {
		t.Fatalf("after renaming the space: %v", got)
	}
	// A trashed page drops out of the order and comes back to its place.
	h.reorder("Office/Alpha.md", "Office", "")
	if code := h.do("DELETE", "/api/notes/Office/B.md", nil, nil); code != 204 {
		t.Fatalf("delete: %d", code)
	}
	if got := h.tree().Order["Office"]; !sameNames(got, []string{"Alpha"}) {
		t.Fatalf("after trashing: %v", got)
	}
	if got := h.orderFile("Office"); !sameNames(got, []string{"Alpha"}) {
		t.Fatalf("order file keeps a trashed page: %v", got)
	}
	var trash struct{ Items []vault.TrashItem }
	h.do("GET", "/api/trash", nil, &trash)
	h.do("POST", "/api/trash/"+trash.Items[0].ID+"/restore", nil, nil)
	if got := h.tree().Order["Office"]; !sameNames(got, []string{"B", "Alpha"}) {
		t.Fatalf("after restoring: %v", got)
	}
}

func TestOrderFilesAreNotPages(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Plan.md", "plan")
	h.put("Work/Plan/Q1.md", "q1")
	h.put("Work/Plan/Q2.md", "q2")
	h.put("Work/Notes.md", "notes")
	h.reorder("Work/Plan/Q2.md", "Work/Plan.md", "Work/Plan/Q1.md")
	h.reorder("Work/Plan.md", "Work", "Work/Notes.md")

	if changed, err := h.srv.Scan(); err != nil || len(changed) != 0 {
		t.Fatalf("scan: %v %v", changed, err)
	}
	tr := h.tree()
	if len(tr.Notes) != 4 {
		t.Fatalf("tree notes: %+v", tr.Notes)
	}
	for _, f := range tr.Folders {
		if strings.Contains(f, ".order") {
			t.Fatalf("order file listed as a folder: %v", tr.Folders)
		}
	}
	var sp []space
	h.do("GET", "/api/spaces", nil, &sp)
	if len(sp) != 1 || sp[0].Pages != 4 {
		t.Fatalf("spaces: %+v", sp)
	}

	// Backups and exports carry the order along with the pages.
	files, err := h.srv.vault.BackupFiles()
	if err != nil {
		t.Fatal(err)
	}
	backed := map[string]bool{}
	for _, f := range files {
		backed[f.Path] = true
	}
	if !backed["Work/"+vault.OrderFile] || !backed["Work/Plan/"+vault.OrderFile] || !backed["Work/Plan/Q1.md"] {
		t.Fatalf("backup files: %v", backed)
	}
	req, _ := http.NewRequest("GET", h.ts.URL+"/api/spaces/Work/export", nil)
	req.Header.Set("Authorization", "Bearer "+h.token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, f := range zr.File {
		names[f.Name] = true
	}
	if len(names) != 6 || !names["Work/"+vault.OrderFile] || !names["Work/Plan/Q2.md"] {
		t.Fatalf("export: %v", names)
	}

	// Deleting the last sub-pages removes their folder, order file and all,
	// so the parent loses its expand arrow.
	h.do("DELETE", "/api/notes/Work/Plan/Q1.md", nil, nil)
	h.do("DELETE", "/api/notes/Work/Plan/Q2.md", nil, nil)
	if h.exists("Work/Plan") {
		t.Fatal("folder with only an order file left behind")
	}
	for _, f := range h.tree().Folders {
		if f == "Work/Plan" {
			t.Fatal("tidied folder still in the tree")
		}
	}
}

// Shared pages with no width of their own follow the owner's full-width
// setting, which is on until turned off.
func TestSharedPageDefaultWidth(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Plain.md", "Hello")
	h.put("Work/Narrow.md", "---\nwidth: narrow\n---\nHello")
	share := func(p string) string {
		var sh store.Share
		if code := h.do("POST", "/api/shares", map[string]string{"path": p}, &sh); code != 201 {
			t.Fatalf("share %s: %d", p, code)
		}
		return sh.Token
	}
	plain, narrow := share("Work/Plain.md"), share("Work/Narrow.md")
	width := func(token string) string {
		var page struct{ Width string }
		h.do("GET", "/api/public/"+token, nil, &page)
		return page.Width
	}
	var acct struct{ FullWidth bool }
	h.do("GET", "/api/account", nil, &acct)
	if !acct.FullWidth || width(plain) != "full" || width(narrow) != "" {
		t.Fatalf("default: account %v, plain %q, narrow %q", acct.FullWidth, width(plain), width(narrow))
	}
	if code := h.do("PATCH", "/api/account", map[string]any{"fullWidth": false}, &acct); code != 200 || acct.FullWidth {
		t.Fatalf("turn off: %d %v", code, acct.FullWidth)
	}
	if width(plain) != "" {
		t.Fatalf("plain page still full width with the setting off")
	}
}
