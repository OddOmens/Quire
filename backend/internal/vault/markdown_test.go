package vault

import (
	"slices"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	p := Parse(`---
tags: [Draft, "work"]
---
# Plan

#journal entry about [[Sync design|sync]] and ` + "`[[not a link]]`" + `.
- [x] Done with [[Roadmap#Q1]] #work/q1
` + "```" + `
#not-a-tag [[Nope]]
` + "```" + `
Issue #42 stays a number.`)

	var targets []string
	for _, l := range p.Links {
		targets = append(targets, l.Target)
	}
	if !slices.Equal(targets, []string{"Sync design", "Roadmap"}) {
		t.Errorf("links = %v", targets)
	}
	if want := []string{"draft", "journal", "work", "work/q1"}; !slices.Equal(p.Tags, want) {
		t.Errorf("tags = %v, want %v", p.Tags, want)
	}
	if want := "Plan #journal entry about sync and not a link. Done with Roadmap #work/q1 Issue #42 stays a number."; p.Excerpt != want {
		t.Errorf("excerpt = %q", p.Excerpt)
	}
}

func TestFrontmatter(t *testing.T) {
	for in, want := range map[string]Frontmatter{
		"---\nverified: 2026-10-18\nsecrets: ok\n---\nBody":         {SecretsOK: true},
		"---\r\nVerified: \"2026-01-05\"\r\ntags: a\r\n---\r\nBody": {Tags: []string{"a"}},
		"---\nwidth: full\nsecrets: no\n---\n":                      {Width: "full"},
		"secrets: ok\n":                                             {},
		// A page that starts with a divider has no front matter.
		"---\n\nsecrets: ok\n\n---\nMore":     {},
		"---\nIntro text\nsecrets: ok\n---\n": {},
	} {
		got := ReadFrontmatter(in)
		if got.Width != want.Width || got.SecretsOK != want.SecretsOK || !slices.Equal(got.Tags, want.Tags) {
			t.Errorf("ReadFrontmatter(%q) = %+v, want %+v", in, got, want)
		}
	}
	for _, in := range []string{"---\n\nFirst part\n\n---\n\nSecond part\n", "---\nJust text\n---\n", "---\n"} {
		if _, body := splitFrontmatter(in); body != in {
			t.Errorf("divider read as front matter: %q -> body %q", in, body)
		}
	}
	for in, body := range map[string]string{
		"---\ntags: [a]\n---\nText":                 "Text",
		"---\ntags:\n  - a\n# note\n\nx: 1\n---\nT": "T",
		"---\n---\nT":                 "T",
		"---\r\nkey: v\r\n---  \r\nT": "T",
	} {
		if _, got := splitFrontmatter(in); got != body {
			t.Errorf("splitFrontmatter(%q) body = %q, want %q", in, got, body)
		}
	}
}

func TestRewrite(t *testing.T) {
	out, ok := Rewrite("See [[Old]], [[old#Top|alias]] and ![[Other]].", func(target string) (string, bool) {
		if LinkKey(target) == "old" {
			return "New", true
		}
		return "", false
	})
	if !ok || out != "See [[New]], [[New#Top|alias]] and ![[Other]]." {
		t.Errorf("rewrite = %q", out)
	}
}

// Links shown as code, as in documentation about links, stay as written.
func TestRewriteSkipsCode(t *testing.T) {
	in := "[[Old]] and `[[Old]]`\n```\n[[Old]]\n```\n~~~md\n``` [[Old]]\n~~~\nThen [[Old|x]].\r\n"
	want := "[[New]] and `[[Old]]`\n```\n[[Old]]\n```\n~~~md\n``` [[Old]]\n~~~\nThen [[New|x]].\r\n"
	out, ok := Rewrite(in, func(string) (string, bool) { return "New", true })
	if !ok || out != want {
		t.Errorf("rewrite = %q", out)
	}
	if _, ok := Rewrite("`[[Old]]`", func(string) (string, bool) { return "New", true }); ok {
		t.Error("a link in code counted as changed")
	}
}

func TestClean(t *testing.T) {
	for in, want := range map[string]string{"a/b.md": "a/b.md", "/a//b.md/": "a/b.md", `a\b.md`: "a/b.md"} {
		if got, err := Clean(in); err != nil || got != want {
			t.Errorf("Clean(%q) = %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "..", "../x", "a/../../x", ".trash/x", "a/.git/x", "a:b"} {
		if _, err := Clean(bad); err == nil {
			t.Errorf("Clean(%q) accepted", bad)
		}
	}
}

func TestExcerptDropsHTML(t *testing.T) {
	p := Parse("<details>\n<summary>More **detail**</summary>\n\nInside the toggle.\n\n</details>\n\n1 < 2 and 3 > 2.")
	if want := "More detail Inside the toggle. 1 < 2 and 3 > 2."; p.Excerpt != want {
		t.Errorf("excerpt = %q", p.Excerpt)
	}
}

func TestParseNewBlocks(t *testing.T) {
	p := Parse("[TOC]\n\n:::: columns\n::: column\nLeft with <u>underline</u> and <span data-color=\"red\">colour</span>.\n:::\n::: column\n![[Budget]]\n:::\n::::\n\n" +
		"<details>\n<summary><h2>Folded and more</h2></summary>\n\nSee ![[Notes#Part|shown]] on @2026-11-11.\n\n</details>\n")
	if want := "Left with underline and colour. Budget Folded and more See shown on @2026-11-11."; p.Excerpt != want {
		t.Errorf("excerpt = %q", p.Excerpt)
	}
	var targets []string
	for _, l := range p.Links {
		targets = append(targets, l.Target)
	}
	if !slices.Equal(targets, []string{"Budget", "Notes"}) {
		t.Errorf("links = %q", targets)
	}
}

func TestRewriteKeepsEmbeds(t *testing.T) {
	got, changed := Rewrite("![[Budget]]\n\n:::: columns\n::: column\n![[Budget#Totals|sums]] and [[Budget]]\n:::\n::::\n", func(target string) (string, bool) {
		return "Money", target == "Budget"
	})
	if want := "![[Money]]\n\n:::: columns\n::: column\n![[Money#Totals|sums]] and [[Money]]\n:::\n::::\n"; !changed || got != want {
		t.Errorf("rewrite = %q", got)
	}
}

func TestTableLinks(t *testing.T) {
	// In a table the alias bar is escaped so it doesn't split the cell.
	p := Parse("| Page | About |\n| --- | --- |\n| [[Plants/Wild edibles\\|Wild edibles]] | Food |\n| [[Notes#Part\\|part]] | x |\n")
	if len(p.Links) != 2 || p.Links[0].Target != "Plants/Wild edibles" || p.Links[1].Target != "Notes" {
		t.Fatalf("links = %+v", p.Links)
	}
	if strings.Contains(p.Excerpt, "\\") || !strings.Contains(p.Excerpt, "Wild edibles") {
		t.Fatalf("excerpt = %q", p.Excerpt)
	}
	out, ok := Rewrite("| [[Plants/Wild edibles\\|Wild edibles]] | [[Old]] |", func(target string) (string, bool) {
		return "Plants/Foraging", target == "Plants/Wild edibles"
	})
	if !ok || out != "| [[Plants/Foraging\\|Wild edibles]] | [[Old]] |" {
		t.Fatalf("rewrite = %q", out)
	}
	// A backslash inside a target that isn't before the bar stays part of it.
	if p := Parse("[[a\\b]] and [[c|d]]"); len(p.Links) != 2 || p.Links[0].Target != "a\\b" || p.Links[1].Target != "c" {
		t.Fatalf("plain links = %+v", p.Links)
	}
}
