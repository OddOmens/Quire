package server

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/oddomens/quire/internal/store"
)

// A page deleted outside Quire keeps its history, which the trash view
// lists so it can be restored.
func TestDeletedOutsideQuire(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Gone.md", "first")
	h.do("PUT", "/api/notes/Work/Gone.md", map[string]any{"content": "last", "conflict": true}, nil)
	h.put("Work/Kept.md", "here")
	h.put("Work/Trashed.md", "binned")
	h.do("DELETE", "/api/notes/Work/Trashed.md", nil, nil)
	os.Remove(filepath.Join(h.dir, "Work", "Gone.md"))
	if _, err := h.srv.Scan(); err != nil {
		t.Fatal(err)
	}

	var list []store.HistoryPath
	h.do("GET", "/api/deleted-pages", nil, &list)
	if len(list) != 1 || list[0].Path != "Work/Gone.md" || list[0].Versions != 2 {
		t.Fatalf("deleted pages: %+v", list)
	}
	if code := h.do("POST", fmt.Sprintf("/api/revisions/%d/restore", list[0].Latest), nil, nil); code != 200 {
		t.Fatalf("restore: %d", code)
	}
	if got := h.read("Work/Gone.md"); got != "last" {
		t.Fatalf("restored: %q", got)
	}
	h.do("GET", "/api/deleted-pages", nil, &list)
	if len(list) != 0 {
		t.Fatalf("after restore: %+v", list)
	}
}
