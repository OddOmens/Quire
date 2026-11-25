package vault

import (
	"regexp"
	"slices"
	"strings"
	"unicode"
)

// wikiLink matches [[Target]], [[Target#Heading]], [[Target|Alias]] and the
// embed form ![[Target]]. Inside a table the alias bar is escaped, as in
// [[Target\|Alias]]; the backslash goes with the alias (group 4), so the
// target stays clean and a rewrite writes the escape back.
var wikiLink = regexp.MustCompile(`(!?)\[\[([^\[\]\n|#^]+?)(#[^\[\]\n|]*?)?(\\?\|[^\[\]\n]*)?\]\]`)

// aliasText is a link's label from its alias group: "|Label" or "\|Label".
func aliasText(alias string) string {
	return strings.TrimPrefix(strings.TrimPrefix(alias, "\\"), "|")
}

var (
	inlineTag  = regexp.MustCompile(`(?:^|[\s(\[,])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)`)
	inlineCode = regexp.MustCompile("`[^`\n]*`")
	mdLink     = regexp.MustCompile(`!?\[([^\]\n]*)\]\([^)\n]*\)`)
	// HTML tags, such as the <details> and <summary> a toggle is saved as.
	htmlTag = regexp.MustCompile(`</?[a-zA-Z][a-zA-Z0-9-]*(\s[^<>\n]*)?/?>`)
	// Lines that lay a page out and say nothing themselves: the fences of
	// columns (":::: columns", "::: column", ":::") and a table of contents.
	layoutLine = regexp.MustCompile(`^[\s>]*(:{3,}([ \t]*[\w-]+)?|\[TOC\])[ \t]*$`)
	// Heading, quote, list and task markers at the start of a line.
	blockMarker = regexp.MustCompile(`^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)*(\[[ xX]\]\s+)?`)
)

type Link struct {
	// Target is the link as written, without heading or alias.
	Target string
	// Context is the line it appears on, for the backlinks panel.
	Context string
}

type Parsed struct {
	Links   []Link
	Tags    []string
	Words   int
	Excerpt string
	// Kind is "database" for a page with "database: true".
	Kind string
}

// Frontmatter is what Quire reads from a page's leading YAML block.
type Frontmatter struct {
	Tags []string
	// SecretsOK is "secrets: ok", which turns off the possible-secret
	// warning for the page.
	SecretsOK bool
	// Width is "full" for a page set to use the full window width.
	Width string
	// Database is "database: true": the page has rows and columns, kept
	// beside it in a .csv and a .schema.json file.
	Database bool
}

// ReadFrontmatter reads a page's frontmatter without parsing the rest.
func ReadFrontmatter(content string) Frontmatter {
	fm, _ := splitFrontmatter(content)
	return fm
}

// StripFrontmatter returns a page without its leading YAML block.
func StripFrontmatter(content string) string {
	_, body, _ := frontmatterBlock(content)
	return body
}

// LinkKey is the form links are matched on: lower case, no extension, no
// surrounding slashes.
func LinkKey(target string) string {
	t := strings.Trim(strings.TrimSpace(target), "/")
	if IsNote(t) {
		t = t[:len(t)-3]
	}
	return strings.ToLower(t)
}

// Parse pulls links, tags, a word count and a plain-text excerpt out of a
// note. Code blocks and inline code are ignored.
func Parse(content string) Parsed {
	fm, body := splitFrontmatter(content)
	out := Parsed{}
	if fm.Database {
		out.Kind = "database"
	}
	seenLink := map[string]bool{}
	tags := map[string]bool{}
	for _, t := range fm.Tags {
		tags[strings.ToLower(t)] = true
	}

	var plain strings.Builder
	inFence := false
	fence := ""
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if f := fenceMarker(trimmed); f != "" && (!inFence || strings.HasPrefix(trimmed, fence)) {
			if inFence {
				inFence = false
			} else {
				inFence, fence = true, f
			}
			continue
		}
		if inFence {
			continue
		}
		code := inlineCode.ReplaceAllStringFunc(line, func(s string) string { return strings.Repeat(" ", len(s)) })

		for _, m := range wikiLink.FindAllStringSubmatch(code, -1) {
			target := strings.TrimSpace(m[2])
			key := LinkKey(target)
			if key == "" || seenLink[key] {
				continue
			}
			seenLink[key] = true
			out.Links = append(out.Links, Link{Target: target, Context: context(trimmed)})
		}
		for _, m := range inlineTag.FindAllStringSubmatch(code, -1) {
			t := strings.Trim(m[1], "/-")
			if strings.IndexFunc(t, unicode.IsLetter) >= 0 {
				tags[strings.ToLower(t)] = true
			}
		}
		if layoutLine.MatchString(line) {
			continue
		}
		plain.WriteString(stripMarkup(line))
		plain.WriteByte('\n')
	}

	text := plain.String()
	out.Words = len(strings.Fields(text))
	out.Excerpt = excerpt(text, 220)
	for t := range tags {
		out.Tags = append(out.Tags, t)
	}
	slices.Sort(out.Tags)
	return out
}

// Rewrite replaces link targets. replace gets each target as written and
// returns the new target, or false to leave it. Headings and aliases are kept.
// Like Parse, it leaves code blocks and inline code alone.
func Rewrite(content string, replace func(target string) (string, bool)) (string, bool) {
	changed := false
	links := func(s string) string {
		return wikiLink.ReplaceAllStringFunc(s, func(s string) string {
			m := wikiLink.FindStringSubmatch(s)
			next, ok := replace(strings.TrimSpace(m[2]))
			if !ok {
				return s
			}
			changed = true
			return m[1] + "[[" + next + m[3] + m[4] + "]]"
		})
	}
	return OutsideCode(content, links), changed
}

// OutsideCode applies fn to each stretch of a page outside fenced code
// blocks and inline code, one line at a time, and leaves the code as it is.
func OutsideCode(content string, fn func(string) string) string {
	lines := strings.Split(content, "\n")
	inFence := false
	fence := ""
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if f := fenceMarker(trimmed); f != "" && (!inFence || strings.HasPrefix(trimmed, fence)) {
			inFence, fence = !inFence, f
			continue
		}
		if inFence {
			continue
		}
		var b strings.Builder
		last := 0
		for _, c := range inlineCode.FindAllStringIndex(line, -1) {
			b.WriteString(fn(line[last:c[0]]))
			b.WriteString(line[c[0]:c[1]])
			last = c[1]
		}
		b.WriteString(fn(line[last:]))
		lines[i] = b.String()
	}
	return strings.Join(lines, "\n")
}

func fenceMarker(line string) string {
	for _, f := range []string{"```", "~~~"} {
		if strings.HasPrefix(line, f) {
			return f
		}
	}
	return ""
}

// splitFrontmatter separates a leading YAML block and reads its tags, in
// either "tags: [a, b]", "tags: a, b" or list form, plus "secrets" and
// "width". Other keys are left alone.
func splitFrontmatter(content string) (out Frontmatter, body string) {
	fm, body, ok := frontmatterBlock(content)
	if !ok {
		return out, content
	}

	lines := strings.Split(fm, "\n")
	for i := 0; i < len(lines); i++ {
		key, val, ok := strings.Cut(lines[i], ":")
		if !ok {
			continue
		}
		switch strings.TrimSpace(strings.ToLower(key)) {
		case "secrets":
			out.SecretsOK = strings.EqualFold(strings.Trim(strings.TrimSpace(val), `"'`), "ok")
			continue
		case "width":
			out.Width = strings.Trim(strings.TrimSpace(val), `"'`)
			continue
		case "database":
			v := strings.ToLower(strings.Trim(strings.TrimSpace(val), `"'`))
			out.Database = v == "true" || v == "yes"
			continue
		}
		if !slices.Contains([]string{"tags", "tag"}, strings.TrimSpace(strings.ToLower(key))) {
			continue
		}
		val = strings.Trim(strings.TrimSpace(val), "[]")
		if val != "" {
			for _, t := range strings.Split(val, ",") {
				if t = strings.Trim(strings.TrimSpace(t), `"'#`); t != "" {
					out.Tags = append(out.Tags, t)
				}
			}
			continue
		}
		for i+1 < len(lines) && strings.HasPrefix(strings.TrimSpace(lines[i+1]), "- ") {
			i++
			if t := strings.Trim(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(lines[i]), "- ")), `"'#`); t != "" {
				out.Tags = append(out.Tags, t)
			}
		}
	}
	return out, body
}

// fmKey is a YAML key at the start of a front matter line.
var fmKey = regexp.MustCompile(`^[A-Za-z_][\w-]*[ \t]*:([ \t]|$)`)

// frontmatterBlock finds a leading YAML block: "---" on the first line, a key
// (or the closing "---") on the next, and only YAML-looking lines until the
// closing "---". A page that merely starts with a divider, followed by a
// blank line or text, has none. The editor's splitFrontmatter in
// frontend/src/lib/markdown.ts follows the same rules.
func frontmatterBlock(content string) (fm, body string, ok bool) {
	lines := strings.SplitAfter(content, "\n")
	if len(lines) < 2 || strings.TrimRight(lines[0], " \t\r\n") != "---" {
		return "", content, false
	}
	for i := 1; i < len(lines); i++ {
		line := strings.TrimRight(lines[i], "\r\n")
		if strings.TrimRight(line, " \t") == "---" {
			return strings.Join(lines[1:i], ""), strings.Join(lines[i+1:], ""), true
		}
		yaml := fmKey.MatchString(line)
		if i > 1 {
			yaml = yaml || strings.TrimSpace(line) == "" || strings.HasPrefix(line, "- ") || strings.ContainsRune(" \t#", rune(line[0]))
		}
		if !yaml {
			break
		}
	}
	return "", content, false
}

func stripMarkup(line string) string {
	line = wikiLink.ReplaceAllStringFunc(line, func(s string) string {
		m := wikiLink.FindStringSubmatch(s)
		if m[4] != "" {
			return aliasText(m[4])
		}
		return m[2]
	})
	line = mdLink.ReplaceAllString(line, "$1")
	line = htmlTag.ReplaceAllString(line, "")
	line = blockMarker.ReplaceAllString(line, "")
	return strings.NewReplacer("**", "", "__", "", "~~", "", "`", "", "==", "").Replace(line)
}

func context(line string) string {
	line = strings.TrimLeft(line, "#>-*+ ")
	if r := []rune(line); len(r) > 200 {
		return string(r[:200]) + "…"
	}
	return line
}

func excerpt(text string, n int) string {
	s := strings.Join(strings.Fields(text), " ")
	if r := []rune(s); len(r) > n {
		s = strings.TrimRightFunc(string(r[:n]), unicode.IsSpace) + "…"
	}
	return s
}

// HasFrontmatter reports whether a page starts with a YAML block.
func HasFrontmatter(content string) bool {
	_, _, ok := frontmatterBlock(content)
	return ok
}
