package importer

import (
	"archive/zip"
	"bytes"
	"io/fs"
	"strconv"
	"strings"
	"testing"
)

// fixture is a zip built in memory: name → content. A name ending in "@"
// is stored as a symbolic link.
func fixture(t *testing.T, files map[string]string) []File {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		hdr := &zip.FileHeader{Name: name, Method: zip.Deflate}
		if n, ok := strings.CutSuffix(name, "@"); ok {
			hdr.Name = n
			hdr.SetMode(fs.ModeSymlink | 0o777)
		}
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(content))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	out, err := FromZip(zr)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

type fakeVault struct {
	paths  map[string]bool
	titles map[string]bool
}

func (f fakeVault) Exists(p string) bool   { return f.paths[p] }
func (f fakeVault) HasTitle(t string) bool { return f.titles[strings.ToLower(t)] }
func empty() fakeVault                     { return fakeVault{map[string]bool{}, map[string]bool{}} }
func pages(p *Plan) map[string]string {
	out := map[string]string{}
	for _, pg := range p.Pages {
		out[pg.Path] = string(pg.Content)
	}
	return out
}

func attachments(p *Plan) map[string]string {
	out := map[string]string{}
	for _, a := range p.Attachments {
		out[a.Path] = a.From.Name
	}
	return out
}

func skipped(p *Plan) map[string]string {
	out := map[string]string{}
	for _, s := range p.Skipped {
		out[s.Path] = s.Reason
	}
	return out
}

func build(t *testing.T, files []File, v fakeVault) *Plan {
	t.Helper()
	p, err := Build(files, "Docs", v)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestPlainFolders(t *testing.T) {
	p := build(t, fixture(t, map[string]string{
		"Handbook/Guide.md":            "![logo](img/logo.png) See [Setup](Guide/Setup.md) and [the API](Ref/API.md#auth).\n`[x](Ref/API.md)`",
		"Handbook/Guide/Setup.md":      "Up: [Guide](../Guide.md), [file](<../img/a b.pdf> \"Spec\")",
		"Handbook/Ref/index.md":        "# Reference",
		"Handbook/Ref/README.md":       "Also here",
		"Handbook/Ref/API.md":          "[Home](https://example.com) [top](#top) [gone](Missing.md)",
		"Handbook/img/logo.png":        "PNG",
		"Handbook/img/a b.pdf":         "PDF",
		"Handbook/data.csv":            "a,b",
		"Handbook/.DS_Store":           "junk",
		"__MACOSX/Handbook/._Guide.md": "junk",
		"Handbook/.obsidian/app.json":  "{}",
	}), empty())

	got := pages(p)
	want := map[string]string{
		"Docs/Guide.md":       "![logo](attachments/logo.png) See [[Setup]] and [[API|the API]].\n`[x](Ref/API.md)`",
		"Docs/Guide/Setup.md": "Up: [[Guide]], [file](attachments/a-b.pdf \"Spec\")",
		"Docs/Ref.md":         "# Reference",
		"Docs/Ref/README.md":  "Also here",
		"Docs/Ref/API.md":     "[Home](https://example.com) [top](#top) [gone](Missing.md)",
	}
	if len(got) != len(want) {
		t.Fatalf("pages = %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	if a := attachments(p); len(a) != 2 || a["attachments/logo.png"] != "img/logo.png" || a["attachments/a-b.pdf"] != "img/a b.pdf" {
		t.Errorf("attachments = %v", a)
	}
	if s := skipped(p); len(s) != 1 || s["data.csv"] != "not linked from any page" {
		t.Errorf("skipped = %v", s)
	}
}

func TestObsidianVault(t *testing.T) {
	p := build(t, fixture(t, map[string]string{
		"Note.md":                  "![[pic 1.png]] ![[pic 1.png|300]] [[Other|alias]] [[Sub/Deep#Head]] [[Nowhere]] [[spec.pdf]]\n```\n![[pic 1.png]]\n```",
		"folder/Other.md":          "[[Note]]",
		"Sub/Deep.md":              "",
		"assets/pic 1.png":         "PNG",
		"assets/spec.pdf":          "PDF",
		".obsidian/workspace.json": "{}",
		".trash/Old.md":            "old",
	}), empty())
	got := pages(p)
	if want := "![pic 1](attachments/pic-1.png) ![pic 1](attachments/pic-1.png) [[Other|alias]] [[Sub/Deep#Head]] [[Nowhere]] [spec](attachments/spec.pdf)\n```\n![[pic 1.png]]\n```"; got["Docs/Note.md"] != want {
		t.Errorf("note = %q", got["Docs/Note.md"])
	}
	if got["Docs/folder/Other.md"] != "[[Note]]" || len(got) != 3 {
		t.Errorf("pages = %v", got)
	}
	if a := attachments(p); len(a) != 2 {
		t.Errorf("attachments = %v", a)
	}
	if len(p.Skipped) != 0 {
		t.Errorf("skipped = %v", p.Skipped)
	}
}

func TestNotionExport(t *testing.T) {
	const a, b, c = "0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210", "ffffeeeeddddccccbbbbaaaa99998888"
	p := build(t, fixture(t, map[string]string{
		"Export-x/Projects " + a + ".md":                   "# Projects\n[Roadmap](Projects%20" + a + "/Roadmap%20" + b + ".md) ![diagram.png](Projects%20" + a + "/diagram.png)",
		"Export-x/Projects " + a + "/Roadmap " + b + ".md": "Back to [Projects](../Projects%20" + a + ".md)",
		"Export-x/Projects " + a + "/Roadmap " + c + ".md": "A second page with the same title",
		"Export-x/Projects " + a + "/diagram.png":          "PNG",
	}), empty())
	got := pages(p)
	if got["Docs/Projects.md"] != "# Projects\n[[Roadmap]] ![diagram.png](attachments/diagram.png)" {
		t.Errorf("projects = %q", got["Docs/Projects.md"])
	}
	if got["Docs/Projects/Roadmap.md"] != "Back to [[Projects]]" || got["Docs/Projects/Roadmap 2.md"] == "" {
		t.Errorf("pages = %v", got)
	}
	if len(p.Renamed) != 1 || p.Renamed[0].To != "Docs/Projects/Roadmap 2.md" {
		t.Errorf("renamed = %v", p.Renamed)
	}
}

func TestNeverOverwrites(t *testing.T) {
	v := fakeVault{
		paths:  map[string]bool{"Docs/Plan.md": true, "Docs/Plan": true, "attachments/logo.png": true},
		titles: map[string]bool{"plan": true},
	}
	p := build(t, fixture(t, map[string]string{
		"Plan.md":     "![](logo.png)",
		"Plan/Sub.md": "sub",
		"Other.md":    "[[Plan]] and [plan](Plan.md)",
		"logo.png":    "PNG",
	}), v)
	got := pages(p)
	want := map[string]string{
		"Docs/Plan 2.md":     "![](attachments/logo%202.png)",
		"Docs/Plan 2/Sub.md": "sub",
		"Docs/Other.md":      "[[Plan 2]] and [[Plan 2|plan]]",
	}
	for k, w := range want {
		if got[k] != w {
			t.Errorf("%s = %q, want %q", k, got[k], w)
		}
	}
	if len(p.Renamed) != 1 || p.Renamed[0] != (Renamed{From: "Plan.md", To: "Docs/Plan 2.md"}) {
		t.Errorf("renamed = %v", p.Renamed)
	}

	// A title that's also in the vault links by path.
	v.titles["sub"] = true
	p = build(t, fixture(t, map[string]string{"Plan.md": "[[Sub]]", "Plan/Sub.md": ""}), v)
	if got := pages(p)["Docs/Plan 2.md"]; got != "[[Docs/Plan 2/Sub]]" {
		t.Errorf("ambiguous link = %q", got)
	}
}

func TestRefused(t *testing.T) {
	for _, name := range []string{"../evil.md", "a/../../evil.md", "/etc/evil.md", `C:\evil.md`} {
		files := []File{{Name: name, Mode: 0o644}}
		if _, err := Build(files, "Docs", empty()); !IsRefused(err) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	p := build(t, fixture(t, map[string]string{"a.md": "x", "link.md@": "/etc/passwd", "bad.md": "\xff\xfe"}), empty())
	s := skipped(p)
	if s["link.md"] != "symbolic link" || s["bad.md"] != "not UTF-8 text" || len(p.Pages) != 1 {
		t.Errorf("skipped = %v, pages %v", s, pages(p))
	}

	many := map[string]string{}
	for i := range MaxEntries + 1 {
		many[strings.Repeat("x", 1+i%7)+"/"+string(rune('a'+i%26))+"-"+strconv.Itoa(i)] = ""
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for n := range many {
		zw.Create(n)
	}
	zw.Close()
	zr, _ := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if _, err := FromZip(zr); !IsRefused(err) {
		t.Errorf("too many entries: %v", err)
	}
}

func TestQuireExport(t *testing.T) {
	// A space downloaded from Quire: its folder, with attachments/ beside it.
	p := build(t, fixture(t, map[string]string{
		"Work/Page.md":          "![chart](attachments/chart.png)",
		"Work/Page/Child.md":    "child",
		"attachments/chart.png": "PNG",
	}), empty())
	got := pages(p)
	if got["Docs/Page.md"] != "![chart](attachments/chart.png)" || got["Docs/Page/Child.md"] != "child" {
		t.Errorf("pages = %v", got)
	}
	if a := attachments(p); a["attachments/chart.png"] != "attachments/chart.png" {
		t.Errorf("attachments = %v", a)
	}
}
