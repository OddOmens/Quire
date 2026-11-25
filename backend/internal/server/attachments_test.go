package server

import (
	"os"
	"path/filepath"
	"testing"
)

type attachmentList struct {
	Items []attachmentInfo
	Total int64
}

func (h *harness) attachment(name, content string) {
	h.t.Helper()
	os.MkdirAll(filepath.Join(h.dir, "attachments"), 0o755)
	if err := os.WriteFile(filepath.Join(h.dir, "attachments", name), []byte(content), 0o644); err != nil {
		h.t.Fatal(err)
	}
}

func TestAttachmentsList(t *testing.T) {
	h := newHarness(t)
	h.attachment("used.png", "12345")
	h.attachment("old.png", "1")
	h.attachment("trashed.pdf", "12")
	h.attachment("never.txt", "123")
	h.put("Work/A.md", "![](attachments/used.png)")
	h.put("Work/B.md", "![](attachments/old.png)")
	// Only history mentions old.png now.
	h.do("PUT", "/api/notes/Work/B.md", map[string]any{"content": "no longer", "conflict": true}, nil)
	h.put("Work/C.md", "[spec](attachments/trashed.pdf)")
	if code := h.do("DELETE", "/api/notes/Work/C.md", nil, nil); code != 204 {
		t.Fatalf("delete: %d", code)
	}

	var list attachmentList
	h.do("GET", "/api/attachments", nil, &list)
	got := map[string]attachmentInfo{}
	for _, it := range list.Items {
		got[it.Path] = it
	}
	if list.Total != 11 || len(got) != 4 {
		t.Fatalf("list: %+v", list)
	}
	if u := got["attachments/used.png"]; len(u.Pages) != 1 || u.Pages[0] != "Work/A.md" || u.History {
		t.Errorf("used: %+v", u)
	}
	if o := got["attachments/old.png"]; len(o.Pages) != 0 || !o.History {
		t.Errorf("old: %+v", o)
	}
	if tr := got["attachments/trashed.pdf"]; len(tr.Trashed) != 1 || tr.Trashed[0] != "Work/C.md" {
		t.Errorf("trashed: %+v", tr)
	}
	if n := got["attachments/never.txt"]; len(n.Pages)+len(n.Trashed) != 0 || n.History {
		t.Errorf("never: %+v", n)
	}
}

func TestTrashAttachments(t *testing.T) {
	h := newHarness(t)
	h.attachment("used.png", "u")
	h.attachment("spare.png", "s")
	h.put("Work/A.md", "![](attachments/used.png)")

	var res struct {
		Trashed []string
		Kept    []struct{ Path, Reason string }
	}
	h.do("POST", "/api/attachments/trash", map[string]any{"paths": []string{"attachments/used.png", "attachments/spare.png", "Work/A.md", "../x"}}, &res)
	if len(res.Trashed) != 1 || res.Trashed[0] != "attachments/spare.png" || len(res.Kept) != 3 {
		t.Fatalf("trash: %+v", res)
	}
	if _, err := os.Stat(filepath.Join(h.dir, "attachments", "spare.png")); !os.IsNotExist(err) {
		t.Fatal("spare.png still there")
	}
	h.read("attachments/used.png")
	h.read("Work/A.md")

	// It waits in the trash, and comes back under a number if its name was
	// taken meanwhile.
	h.attachment("spare.png", "new")
	var trash struct {
		Items []struct{ ID, Path, Kind string }
	}
	h.do("GET", "/api/trash", nil, &trash)
	if len(trash.Items) != 1 || trash.Items[0].Kind != "attachment" || trash.Items[0].Path != "attachments/spare.png" {
		t.Fatalf("trash: %+v", trash)
	}
	var restored struct{ Path string }
	if code := h.do("POST", "/api/trash/"+trash.Items[0].ID+"/restore", nil, &restored); code != 200 || restored.Path != "attachments/spare 2.png" {
		t.Fatalf("restore: %d %+v", code, restored)
	}
	if h.read("attachments/spare 2.png") != "s" || h.read("attachments/spare.png") != "new" {
		t.Fatal("restored the wrong file")
	}
}

func TestRenameAttachment(t *testing.T) {
	h := newHarness(t)
	h.attachment("photo 1.jpg", "p")
	h.attachment("photo 1.jpg.bak", "b")
	h.put("Work/A.md", "![a](attachments/photo%201.jpg) ![[photo 1.jpg|small]] [b](attachments/photo 1.jpg.bak)\n`attachments/photo%201.jpg`")
	h.put("Work/Gone.md", "![](attachments/photo%201.jpg)")
	h.do("DELETE", "/api/notes/Work/Gone.md", nil, nil)
	h.put("Work/Other.md", "Nothing here")

	var res struct {
		Path    string
		Updated []string
	}
	if code := h.do("POST", "/api/attachments/rename", map[string]string{"path": "attachments/photo 1.jpg", "name": "Beach day"}, &res); code != 200 {
		t.Fatalf("rename: %d", code)
	}
	if res.Path != "attachments/Beach-day.jpg" || len(res.Updated) != 1 || res.Updated[0] != "Work/A.md" {
		t.Fatalf("rename: %+v", res)
	}
	if got := h.read("Work/A.md"); got != "![a](attachments/Beach-day.jpg) ![[Beach-day.jpg|small]] [b](attachments/photo 1.jpg.bak)\n`attachments/photo%201.jpg`" {
		t.Fatalf("page: %q", got)
	}
	if h.read("attachments/Beach-day.jpg") != "p" {
		t.Fatal("file not moved")
	}

	// The trashed page follows, so it still works once restored.
	var trash struct{ Items []struct{ ID string } }
	h.do("GET", "/api/trash", nil, &trash)
	h.do("POST", "/api/trash/"+trash.Items[0].ID+"/restore", nil, nil)
	if got := h.read("Work/Gone.md"); got != "![](attachments/Beach-day.jpg)" {
		t.Fatalf("restored page: %q", got)
	}

	// A name that's taken is refused, not overwritten.
	h.attachment("taken.jpg", "t")
	if code := h.do("POST", "/api/attachments/rename", map[string]string{"path": "attachments/Beach-day.jpg", "name": "taken"}, nil); code != 409 || h.read("attachments/taken.jpg") != "t" {
		t.Fatalf("taken name: %d", code)
	}
}
