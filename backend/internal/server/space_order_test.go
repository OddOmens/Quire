package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/oddomens/quire/internal/vault"
)

func (h *harness) spaceNames() []string {
	h.t.Helper()
	var sp []space
	if code := h.do("GET", "/api/spaces", nil, &sp); code != 200 {
		h.t.Fatalf("spaces: %d", code)
	}
	names := []string{}
	for _, s := range sp {
		names = append(names, s.Name)
	}
	return names
}

func (h *harness) rootOrder() []string {
	h.t.Helper()
	var names []string
	if err := json.Unmarshal([]byte(h.read(vault.OrderFile)), &names); err != nil {
		h.t.Fatal(err)
	}
	return names
}

func TestSpaceOrder(t *testing.T) {
	h := newHarness(t)
	for _, n := range []string{"Zeta", "Alpha", "Space 10", "Space 2"} {
		if code := h.do("POST", "/api/spaces", map[string]string{"name": n}, nil); code != 201 {
			t.Fatalf("create %s: %d", n, code)
		}
	}
	// Without an order, spaces are alphabetical, numbers by value, and
	// creating one doesn't write an order file.
	if got := h.spaceNames(); !sameNames(got, []string{"Alpha", "Space 2", "Space 10", "Work", "Zeta"}) {
		t.Fatalf("alphabetical: %v", got)
	}
	if h.exists(vault.OrderFile) {
		t.Fatal("order file written before any arranging")
	}

	events := h.srv.events.subscribe()
	defer h.srv.events.unsubscribe(events)
	var res []space
	if code := h.do("POST", "/api/spaces/order", map[string]any{"names": []string{"Zeta", "Work", "Alpha"}}, &res); code != 200 {
		t.Fatalf("arrange: %d", code)
	}
	// Spaces left out follow the listed ones in their current order.
	want := []string{"Zeta", "Work", "Alpha", "Space 2", "Space 10"}
	if len(res) != 5 || res[0].Name != "Zeta" || res[4].Name != "Space 10" {
		t.Fatalf("arrange response: %+v", res)
	}
	if got := h.rootOrder(); !sameNames(got, want) {
		t.Fatalf("order file: %v", got)
	}
	if got := h.spaceNames(); !sameNames(got, want) {
		t.Fatalf("spaces: %v", got)
	}
	select {
	case e := <-events:
		if e.Type != "tree" {
			t.Fatalf("event: %+v", e)
		}
	default:
		t.Fatal("no live update for the new order")
	}

	for _, body := range []map[string]any{
		{"names": []string{"Zeta", "Nope"}},
		{"names": []string{"Zeta", "Work", "Zeta"}},
		{"names": []string{"zeta"}},
	} {
		if code := h.do("POST", "/api/spaces/order", body, nil); code != 400 {
			t.Fatalf("arrange %v: %d", body, code)
		}
	}
	if got := h.rootOrder(); !sameNames(got, want) {
		t.Fatalf("order changed by a refused request: %v", got)
	}

	// A new space goes last; a renamed one keeps its place.
	h.do("POST", "/api/spaces", map[string]string{"name": "Beta"}, nil)
	if got := h.spaceNames(); !sameNames(got, []string{"Zeta", "Work", "Alpha", "Space 2", "Space 10", "Beta"}) {
		t.Fatalf("after creating: %v", got)
	}
	if code := h.do("PATCH", "/api/spaces/Alpha", map[string]string{"name": "Apple"}, nil); code != 200 {
		t.Fatalf("rename: %d", code)
	}
	if got := h.rootOrder(); !sameNames(got, []string{"Zeta", "Work", "Apple", "Space 2", "Space 10", "Beta"}) {
		t.Fatalf("after renaming: %v", got)
	}

	// A trashed space leaves the list and comes back to its place.
	if code := h.do("DELETE", "/api/spaces/Work", nil, nil); code != 204 {
		t.Fatalf("delete: %d", code)
	}
	if got := h.spaceNames(); !sameNames(got, []string{"Zeta", "Apple", "Space 2", "Space 10", "Beta"}) {
		t.Fatalf("after trashing: %v", got)
	}
	var trash struct{ Items []vault.TrashItem }
	h.do("GET", "/api/trash", nil, &trash)
	if code := h.do("POST", "/api/trash/"+trash.Items[0].ID+"/restore", nil, nil); code != 200 {
		t.Fatalf("restore: %d", code)
	}
	if got := h.spaceNames(); !sameNames(got, []string{"Zeta", "Work", "Apple", "Space 2", "Space 10", "Beta"}) {
		t.Fatalf("after restoring: %v", got)
	}

	// The order file drops a trashed space; if the order changes meanwhile,
	// a restored one comes back before the space it used to precede, or
	// last once that one is gone too.
	h.do("DELETE", "/api/spaces/Zeta", nil, nil)
	if got := h.rootOrder(); slices.Contains(got, "Zeta") {
		t.Fatalf("order file keeps a trashed space: %v", got)
	}
	h.do("POST", "/api/spaces/order", map[string]any{"names": []string{"Beta"}}, nil)
	h.do("GET", "/api/trash", nil, &trash)
	h.do("POST", "/api/trash/"+trash.Items[0].ID+"/restore", nil, nil)
	if got := h.spaceNames(); !sameNames(got, []string{"Beta", "Zeta", "Work", "Apple", "Space 2", "Space 10"}) {
		t.Fatalf("after restoring into a new order: %v", got)
	}
	h.do("DELETE", "/api/spaces/Zeta", nil, nil)
	h.do("DELETE", "/api/spaces/Work", nil, nil)
	h.do("GET", "/api/trash", nil, &trash)
	for _, it := range trash.Items {
		if it.Path == "Zeta" {
			h.do("POST", "/api/trash/"+it.ID+"/restore", nil, nil)
		}
	}
	if got := h.spaceNames(); !sameNames(got, []string{"Beta", "Apple", "Space 2", "Space 10", "Zeta"}) {
		t.Fatalf("after restoring with its neighbour gone: %v", got)
	}
	for _, it := range trash.Items {
		if it.Path == "Work" {
			h.do("POST", "/api/trash/"+it.ID+"/restore", nil, nil)
		}
	}

	// A corrupt order file means alphabetical again.
	if err := os.WriteFile(filepath.Join(h.dir, vault.OrderFile), []byte("{nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := h.spaceNames(); !sameNames(got, []string{"Apple", "Beta", "Space 2", "Space 10", "Work", "Zeta"}) {
		t.Fatalf("with a corrupt order: %v", got)
	}
}

func TestSpaceOrderFileIsNotAPage(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Plan.md", "plan")
	h.do("POST", "/api/spaces", map[string]string{"name": "Home"}, nil)
	h.do("POST", "/api/spaces/order", map[string]any{"names": []string{"Work", "Home"}}, nil)
	order := h.read(vault.OrderFile)

	// A page dropped at the root moves into a space; the order file stays.
	if err := os.WriteFile(filepath.Join(h.dir, "Loose.md"), []byte("loose"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := h.srv.Scan(); err != nil {
		t.Fatal(err)
	}
	if !h.exists(LooseSpace+"/Loose.md") || h.read(vault.OrderFile) != order {
		t.Fatal("loose page not adopted, or the order file was touched")
	}
	if changed, err := h.srv.Scan(); err != nil || len(changed) != 0 {
		t.Fatalf("second scan: %v %v", changed, err)
	}
	if got := h.spaceNames(); !sameNames(got, []string{"Work", "Home", LooseSpace}) {
		t.Fatalf("spaces: %v", got)
	}
	tr := h.tree()
	if len(tr.Notes) != 2 {
		t.Fatalf("tree notes: %+v", tr.Notes)
	}
	for _, f := range tr.Folders {
		if strings.Contains(f, ".order") {
			t.Fatalf("order file listed as a folder: %v", tr.Folders)
		}
	}
	if _, ok := tr.Order[""]; ok {
		t.Fatalf("space order among the page orders: %v", tr.Order)
	}

	// Backups carry it; a space's export doesn't.
	files, err := h.srv.vault.BackupFiles()
	if err != nil {
		t.Fatal(err)
	}
	backed := false
	for _, f := range files {
		backed = backed || f.Path == vault.OrderFile
	}
	if !backed {
		t.Fatalf("root order file not backed up: %v", files)
	}
	under, err := h.srv.vault.FilesUnder("Work")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range under {
		if f.Path == vault.OrderFile {
			t.Fatal("root order file in a space's export")
		}
	}
}

func TestSpaceSections(t *testing.T) {
	h := newHarness(t)
	for _, n := range []string{"Animals", "Plants", "Medical", "Home"} {
		if code := h.do("POST", "/api/spaces", map[string]string{"name": n}, nil); code != 201 {
			t.Fatalf("create %s: %d", n, code)
		}
	}
	sections := func() []vault.Section {
		var out []vault.Section
		if code := h.do("GET", "/api/sections", nil, &out); code != 200 {
			t.Fatalf("sections: %d", code)
		}
		return out
	}
	if got := sections(); len(got) != 0 {
		t.Fatalf("sections before any: %+v", got)
	}

	// Headings group spaces; the ones under none come first, and an empty
	// heading is kept.
	body := map[string]any{
		"names": []string{"Work", "Medical", "Home", "Plants", "Animals"},
		"sections": []map[string]any{
			{"name": "  Knowledge  ", "spaces": []string{"Plants", "Animals"}},
			{"name": "Guides", "spaces": []string{"Medical"}},
			{"name": "Later", "spaces": []string{}},
		},
	}
	var res []space
	if code := h.do("POST", "/api/spaces/order", body, &res); code != 200 {
		t.Fatalf("arrange with sections: %d", code)
	}
	want := []string{"Work", "Home", "Plants", "Animals", "Medical"}
	if got := h.spaceNames(); !sameNames(got, want) {
		t.Fatalf("spaces: %v", got)
	}
	if got := h.rootOrder(); !sameNames(got, want) {
		t.Fatalf("order file: %v", got)
	}
	if res[2].Section != "Knowledge" || res[4].Section != "Guides" || res[0].Section != "" {
		t.Fatalf("section fields: %+v", res)
	}
	got := sections()
	if len(got) != 3 || got[0].Name != "Knowledge" || !sameNames(got[0].Spaces, []string{"Plants", "Animals"}) || got[2].Name != "Later" || len(got[2].Spaces) != 0 {
		t.Fatalf("sections: %+v", got)
	}

	// Arranging without sections keeps each space under its heading.
	if code := h.do("POST", "/api/spaces/order", map[string]any{"names": []string{"Animals", "Home", "Work", "Plants", "Medical"}}, nil); code != 200 {
		t.Fatalf("arrange: %d", code)
	}
	if got := h.spaceNames(); !sameNames(got, []string{"Home", "Work", "Animals", "Plants", "Medical"}) {
		t.Fatalf("after plain arrange: %v", got)
	}

	// A renamed space stays under its heading; a trashed one leaves it.
	if code := h.do("PATCH", "/api/spaces/Plants", map[string]string{"name": "Botany"}, nil); code != 200 {
		t.Fatalf("rename: %d", code)
	}
	if got := sections(); !sameNames(got[0].Spaces, []string{"Animals", "Botany"}) {
		t.Fatalf("after rename: %+v", got)
	}
	if code := h.do("DELETE", "/api/spaces/Medical", nil, nil); code != 204 {
		t.Fatalf("delete: %d", code)
	}
	if got := sections(); len(got[1].Spaces) != 0 {
		t.Fatalf("after delete: %+v", got)
	}

	// Bad requests change nothing.
	before := h.read(vault.SectionsFile)
	for _, bad := range [][]map[string]any{
		{{"name": "", "spaces": []string{}}},
		{{"name": "A", "spaces": []string{}}, {"name": "a", "spaces": []string{}}},
		{{"name": "A", "spaces": []string{"Nope"}}},
		{{"name": "A", "spaces": []string{"Home"}}, {"name": "B", "spaces": []string{"Home"}}},
		{{"name": strings.Repeat("x", 61), "spaces": []string{}}},
	} {
		if code := h.do("POST", "/api/spaces/order", map[string]any{"names": []string{}, "sections": bad}, nil); code != 400 {
			t.Fatalf("arrange %v: %d", bad, code)
		}
	}
	if h.read(vault.SectionsFile) != before {
		t.Fatal("sections changed by a refused request")
	}

	// No sections removes the file.
	if code := h.do("POST", "/api/spaces/order", map[string]any{"names": []string{}, "sections": []any{}}, nil); code != 200 {
		t.Fatalf("clear: %d", code)
	}
	if h.exists(vault.SectionsFile) {
		t.Fatal("sections file left behind")
	}
}
