package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// upload posts files (name → content) to /api/import with query q.
func (h *harness) upload(q string, files map[string][]byte, out any) int {
	h.t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for name, data := range files {
		w, _ := mw.CreateFormFile("file", name)
		w.Write(data)
	}
	mw.Close()
	req, _ := http.NewRequest("POST", h.ts.URL+"/api/import?"+q, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+h.token)
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

func zipOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(content))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestImportZip(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Plan.md", "mine")
	os.MkdirAll(filepath.Join(h.dir, "attachments"), 0o755)
	os.WriteFile(filepath.Join(h.dir, "attachments", "logo.png"), []byte("old logo"), 0o644)

	zipped := zipOf(t, map[string]string{
		"vault/Plan.md":       "![](img/logo.png) [[Notes]]",
		"vault/Plan/Notes.md": "[Up](../Plan.md)",
		"vault/img/logo.png":  "new logo",
		"vault/extra.bin":     "unused",
	})
	var sum importSummary
	if code := h.upload("space=Work", map[string][]byte{"vault.zip": zipped}, &sum); code != 200 {
		t.Fatalf("import: %d %+v", code, sum)
	}
	if sum.Pages != 2 || sum.Attachments != 1 || len(sum.Renamed) != 1 || len(sum.Skipped) != 1 || sum.FirstPage != "Work/Plan 2.md" {
		t.Fatalf("summary: %+v", sum)
	}
	if got := h.read("Work/Plan.md"); got != "mine" {
		t.Fatalf("existing page changed: %q", got)
	}
	if got := h.read("attachments/logo.png"); got != "old logo" {
		t.Fatalf("existing attachment changed: %q", got)
	}
	if got := h.read("attachments/logo 2.png"); got != "new logo" {
		t.Fatalf("imported attachment: %q", got)
	}
	if got := h.read("Work/Plan 2.md"); got != "![](attachments/logo%202.png) [[Notes]]" {
		t.Fatalf("imported page: %q", got)
	}
	if got := h.read("Work/Plan 2/Notes.md"); got != "[[Plan 2|Up]]" {
		t.Fatalf("imported sub-page: %q", got)
	}

	// In the index and in history, marked as imported.
	var revs []struct{ Source string }
	h.do("GET", "/api/history/Work/Plan%202/Notes.md", nil, &revs)
	if len(revs) != 1 || revs[0].Source != "import" {
		t.Fatalf("history: %+v", revs)
	}
	var d noteDetail
	if code := h.do("GET", "/api/notes/Work/Plan%202.md", nil, &d); code != 200 || len(d.Outgoing) != 1 || d.Outgoing[0].Path != "Work/Plan 2/Notes.md" {
		t.Fatalf("note: %d %+v", code, d.Outgoing)
	}
}

func TestImportNewSpaceAndLooseFiles(t *testing.T) {
	h := newHarness(t)
	var sum importSummary
	files := map[string][]byte{"One.md": []byte("See [[Two]] ![](pic.png)"), "Two.md": []byte("two"), "pic.png": []byte("PNG")}
	if code := h.upload("newSpace=Imported", files, &sum); code != 200 || sum.Space != "Imported" || sum.Pages != 2 || sum.Attachments != 1 {
		t.Fatalf("import: %d %+v", code, sum)
	}
	if got := h.read("Imported/One.md"); got != "See [[Two]] ![](attachments/pic.png)" {
		t.Fatalf("page: %q", got)
	}
	var spaces []space
	h.do("GET", "/api/spaces", nil, &spaces)
	if len(spaces) != 2 {
		t.Fatalf("spaces: %+v", spaces)
	}

	// A new space can't take an existing name, and nothing is written.
	if code := h.upload("newSpace=imported", files, nil); code != 409 {
		t.Fatalf("existing space name: %d", code)
	}
	if code := h.upload("space=Nowhere", files, nil); code != 404 {
		t.Fatalf("missing space: %d", code)
	}
}

func TestImportRefused(t *testing.T) {
	h := newHarness(t)
	var e apiError
	if code := h.upload("space=Work", map[string][]byte{"evil.zip": zipOf(t, map[string]string{"a.md": "a", "../evil.md": "x"})}, &e); code != 400 || e.Error == "" {
		t.Fatalf("path outside the zip: %d %q", code, e.Error)
	}
	if _, err := os.Stat(filepath.Join(h.dir, "Work", "a.md")); !os.IsNotExist(err) {
		t.Fatal("a refused zip was partly imported")
	}
	if code := h.upload("space=Work", map[string][]byte{"x.zip": []byte("not a zip")}, nil); code != 400 {
		t.Fatalf("not a zip: %d", code)
	}
	if code := h.upload("space=Work", map[string][]byte{"pic.png": []byte("PNG")}, nil); code != 400 {
		t.Fatalf("no pages: %d", code)
	}
	if code := h.upload("newSpace=Empty", map[string][]byte{"pic.png": []byte("PNG")}, nil); code != 400 || h.srv.vault.Exists("Empty") {
		t.Fatalf("no pages, new space: %d", code)
	}
}
