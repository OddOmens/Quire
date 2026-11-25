package vault

import (
	"os"
	"path/filepath"
	"slices"
	"sort"
	"testing"
)

func TestNaturalLess(t *testing.T) {
	got := []string{"Page 10", "page 2", "Beta", "alpha", "Page 1", "Éclair", "Page 02b"}
	sort.Slice(got, func(i, j int) bool { return NaturalLess(got[i], got[j]) })
	want := []string{"alpha", "Beta", "Page 1", "page 2", "Page 02b", "Page 10", "Éclair"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestOrderedAndEmptyFolders(t *testing.T) {
	dir := t.TempDir()
	v, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer v.Close()
	for _, p := range []string{"S/B.md", "S/A.md", "S/C/D.md", "S/.hidden.md", "S/notes.txt"} {
		if _, err := v.Write(p, []byte("x")); err != nil {
			t.Fatal(err)
		}
	}
	// C is a folder of sub-pages without a page file; it still has a place.
	if got := v.Ordered("S"); !slices.Equal(got, []string{"A", "B", "C"}) {
		t.Fatalf("alphabetical: %q", got)
	}
	if err := v.SetOrder("S", []string{"C", "Gone", "B"}); err != nil {
		t.Fatal(err)
	}
	if got := v.Ordered("S"); !slices.Equal(got, []string{"C", "B", "A"}) {
		t.Fatalf("ordered: %q", got)
	}
	if err := v.SetOrder("S/C", []string{"D"}); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "S/C/D.md")); err != nil {
		t.Fatal(err)
	}
	v.RemoveEmptyDir("S/C")
	if v.Exists("S/C") {
		t.Fatal("folder holding only its order file wasn't removed")
	}
	v.RemoveEmptyDir("S")
	if !v.Exists("S") {
		t.Fatal("folder with pages was removed")
	}
	if err := v.SetOrder("S", nil); err != nil || v.Exists("S/"+OrderFile) {
		t.Fatalf("empty order should remove the file: %v", err)
	}
}

func TestUniqueKeepsTheExtension(t *testing.T) {
	v, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer v.Close()
	for _, p := range []string{"attachments/image.png", "attachments/.env", "S/Plan.md", "S/Notes"} {
		if _, err := v.Write(p, []byte("x")); err != nil {
			t.Fatal(err)
		}
	}
	for in, want := range map[string]string{
		"attachments/image.png": "attachments/image 2.png",
		"attachments/.env":      "attachments/.env 2",
		"attachments/new.png":   "attachments/new.png",
		"S/Plan.md":             "S/Plan 2.md",
		"S/Notes.md":            "S/Notes 2.md", // clear of the folder S/Notes
	} {
		if got := v.Unique(in); got != want {
			t.Errorf("Unique(%q) = %q, want %q", in, got, want)
		}
	}
}

// A trashed page leaves its folder's order, and a restore puts it back in
// its place.
func TestTrashKeepsOrderPlace(t *testing.T) {
	v, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer v.Close()
	for _, p := range []string{"S/A.md", "S/B.md", "S/C.md"} {
		if _, err := v.Write(p, []byte("x")); err != nil {
			t.Fatal(err)
		}
	}
	if err := v.SetOrder("S", []string{"C", "B", "A"}); err != nil {
		t.Fatal(err)
	}
	id, err := v.Trash("S/B", "page", "S/B.md")
	if err != nil {
		t.Fatal(err)
	}
	if got := v.rawOrder("S"); !slices.Equal(got, []string{"C", "A"}) {
		t.Fatalf("order file after trashing: %q", got)
	}
	if _, _, err := v.Restore(id); err != nil {
		t.Fatal(err)
	}
	if got := v.rawOrder("S"); !slices.Equal(got, []string{"C", "B", "A"}) {
		t.Fatalf("order file after restoring: %q", got)
	}
}
