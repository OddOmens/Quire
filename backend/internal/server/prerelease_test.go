package server

import (
	"os"
	"path/filepath"
	"testing"
)

// A page deleted outside Quire loses its public link, so a different page
// saved later at the same path isn't published by it.
func TestShareEndsWhenPageGoesMissing(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Plan.md", "# Plan\n\nPublic plan.")
	h.put("Work/Other.md", "# Other\n\nStays.")
	var sh struct{ Token string }
	if code := h.do("POST", "/api/shares", map[string]string{"path": "Work/Plan.md"}, &sh); code != 201 {
		t.Fatalf("share: %d", code)
	}
	if err := os.Remove(filepath.Join(h.dir, "Work/Plan.md")); err != nil {
		t.Fatal(err)
	}
	if _, err := h.srv.Scan(); err != nil {
		t.Fatal(err)
	}
	if code := h.do("GET", "/api/public/"+sh.Token, nil, nil); code != 404 {
		t.Fatalf("link to a missing page: %d", code)
	}
	if err := os.WriteFile(filepath.Join(h.dir, "Work/Plan.md"), []byte("# Plan\n\nPrivate now."), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := h.srv.Scan(); err != nil {
		t.Fatal(err)
	}
	if code := h.do("GET", "/api/public/"+sh.Token, nil, nil); code != 404 {
		t.Fatalf("old link serves the new page: %d", code)
	}
}

func TestDownloadsAreOctetStream(t *testing.T) {
	h := newHarness(t)
	if err := os.MkdirAll(filepath.Join(h.dir, "attachments"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.dir, "attachments/x.js"), []byte("alert(1)"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, _ := h.raw("GET", "/api/files/attachments/x.js", map[string]string{"Authorization": "Bearer " + h.token})
	if ct := res.Header.Get("Content-Type"); res.StatusCode != 200 || ct != "application/octet-stream" {
		t.Fatalf("status %d, type %q", res.StatusCode, ct)
	}
}
