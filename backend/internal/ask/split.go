// Package ask answers plain-language questions from the notes without a
// language model: it finds the section of a page that answers a question
// and the page's warnings, related sections and related pages.
//
// Pages are split into passages (a few paragraphs under one heading) when
// they're indexed; a question is turned into weighted search terms, an intent
// ("how do I", "what is", "when should I see a doctor"…) and the pages it
// names, and the passages are ranked on all of those. The same ranking puts
// the best sections first in the search box (GET /api/search?best=1).
package ask

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// Flags describe what a passage holds.
const (
	FlagWarn   = 1 << iota // a danger or warning callout
	FlagSteps              // a numbered list or checklist
	FlagTable              // a table
	FlagLead               // before the page's first heading
	FlagNumber             // amounts, times or sizes ("2 cups", "10 minutes", "40°F")
	FlagRef                // the page is reference material (it has a source: URL)
)

// Passage is one stretch of a page. Start and End are byte offsets into the
// page's full content (front matter included).
type Passage struct {
	Section int    // which section of the page, in order; 0 is the opening
	Part    int    // which part of that section
	Heading string // the section's heading as plain text; "" for the opening
	Trail   string // the headings above it and its own, joined with " › "
	Level   int    // heading level, 0 for the opening
	Start   int
	End     int
	Flags   int
	Text    string // plain text, for the search index
}

var (
	atxHeading    = regexp.MustCompile(`^(#{1,6})\s+(.+?)\s*#*\s*$`)
	toggleHeading = regexp.MustCompile(`^\s*<summary>\s*<h([1-6])>(.*?)</h[1-6]>\s*</summary>\s*$`)
	calloutStart  = regexp.MustCompile(`^\s*>\s*\[!(\w+)\][+-]?\s*(.*)$`)
	orderedItem   = regexp.MustCompile(`^\s*(\d+[.)]|[-*+]\s+\[[ xX]\])\s+`)
	tableRow      = regexp.MustCompile(`^\s*\|.*\|\s*$`)
	numberUnit    = regexp.MustCompile(`(?i)\b\d+([.,]\d+)?\s*(-|to|–)?\s*\d*\s*(%|°|degrees?|f\b|c\b|mg|ml|g\b|kg|lbs?|pounds?|oz|ounces?|cups?|tbsp|tsp|tablespoons?|teaspoons?|quarts?|gallons?|liters?|litres?|inch(es)?|in\b|feet|foot|ft|yards?|miles?|mi\b|km|meters?|m\b|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|seconds?|psi|calories|kcal|mph|times)`)
	wikiLinkRe    = regexp.MustCompile(`!?\[\[([^\[\]\n|#]+?)(#[^\[\]\n|]*?)?(\\?\|([^\[\]\n]*))?\]\]`)
	mdLinkRe      = regexp.MustCompile(`!?\[([^\]\n]*)\]\([^)\n]*\)`)
	htmlTagRe     = regexp.MustCompile(`</?[a-zA-Z][a-zA-Z0-9-]*(\s[^<>\n]*)?/?>`)
	markerRe      = regexp.MustCompile(`^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)*(\[[ xX]\]\s+)?`)
	layoutRe      = regexp.MustCompile(`^[\s>]*(:{3,}([ \t]*[\w-]+)?|\[TOC\])[ \t]*$`)
	detailsRe     = regexp.MustCompile(`^\s*</?details[^>]*>\s*$`)
	readTimeRe    = regexp.MustCompile(`^\*?About \d+ min read\b`)
)

// skipHeadings are sections that list sources or links rather than say
// anything: they're never answers.
var skipHeadings = map[string]bool{
	"sources": true, "source": true, "references": true, "see also": true, "external links": true,
	"further reading": true, "linked from": true, "bibliography": true, "notes": true, "citations": true,
	"footnotes": true, "works cited": true,
}

const partSize = 900 // aim for parts of about this many bytes of Markdown

type line struct {
	text       string
	start, end int // end includes the newline
}

// Split breaks a page into passages. Front matter, code-free layout lines and
// sections that only list sources are left out.
func Split(content string) []Passage {
	bodyAt := frontmatterEnd(content)
	ref := hasSourceKey(content[:bodyAt])

	var lines []line
	for at := bodyAt; at < len(content); {
		nl := strings.IndexByte(content[at:], '\n')
		end := len(content)
		if nl >= 0 {
			end = at + nl + 1
		}
		lines = append(lines, line{strings.TrimRight(content[at:end], "\r\n"), at, end})
		at = end
	}

	type section struct {
		heading, trail string
		level          int
		lines          []line
		skip           bool
	}
	secs := []*section{{}}
	var stack []*section // open headings, outermost first
	inFence, fence := false, ""
	for _, l := range lines {
		t := strings.TrimSpace(l.text)
		if f := fenceOf(t); f != "" && (!inFence || strings.HasPrefix(t, fence)) {
			inFence = !inFence
			fence = f
			secs[len(secs)-1].lines = append(secs[len(secs)-1].lines, l)
			continue
		}
		if !inFence {
			var level int
			var head string
			if m := atxHeading.FindStringSubmatch(l.text); m != nil {
				level, head = len(m[1]), m[2]
			} else if m := toggleHeading.FindStringSubmatch(l.text); m != nil {
				level, head = int(m[1][0]-'0'), m[2]
			}
			if level > 0 {
				head = Plain(head)
				for len(stack) > 0 && stack[len(stack)-1].level >= level {
					stack = stack[:len(stack)-1]
				}
				trail := head
				if len(stack) > 0 {
					trail = stack[len(stack)-1].trail + " › " + head
				}
				sec := &section{heading: head, trail: trail, level: level, skip: skipHeadings[strings.ToLower(head)]}
				secs = append(secs, sec)
				stack = append(stack, sec)
				continue
			}
		}
		secs[len(secs)-1].lines = append(secs[len(secs)-1].lines, l)
	}

	var out []Passage
	for si, s := range secs {
		if s.skip {
			continue
		}
		for pi, blk := range parts(s.lines) {
			p := Passage{Section: si, Part: pi, Heading: s.heading, Trail: s.trail, Level: s.level, Start: blk[0].start, End: blk[len(blk)-1].end}
			var b strings.Builder
			for _, l := range blk {
				t := l.text
				switch {
				case calloutStart.MatchString(t):
					m := calloutStart.FindStringSubmatch(t)
					if k := strings.ToLower(m[1]); k == "danger" || k == "warning" || k == "caution" {
						p.Flags |= FlagWarn
					}
					t = m[2]
				case orderedItem.MatchString(t):
					p.Flags |= FlagSteps
				case tableRow.MatchString(t):
					if isDivider(t) {
						continue
					}
					p.Flags |= FlagTable
					t = strings.ReplaceAll(strings.Trim(strings.TrimSpace(t), "|"), "|", " · ")
				}
				if pt := Plain(t); pt != "" {
					b.WriteString(pt)
					b.WriteByte('\n')
				}
			}
			p.Text = strings.TrimSpace(b.String())
			if utf8.RuneCountInString(p.Text) < 12 && p.Flags&FlagWarn == 0 {
				continue // a picture, a divider or a stray line
			}
			if numberUnit.MatchString(p.Text) {
				p.Flags |= FlagNumber
			}
			if si == 0 {
				p.Flags |= FlagLead
			}
			if ref {
				p.Flags |= FlagRef
			}
			out = append(out, p)
		}
	}
	return out
}

// parts groups a section's lines into blocks: paragraphs (and the lists,
// tables and callouts they hold) gathered up to partSize, with danger and
// warning callouts always on their own so they can be shown first.
func parts(lines []line) [][]line {
	// Blocks are runs of lines between blank lines, except that fenced code
	// and callouts are never cut.
	var blocks [][]line
	var cur []line
	inFence, fence := false, ""
	flush := func() {
		if len(cur) > 0 {
			blocks = append(blocks, cur)
			cur = nil
		}
	}
	for i, l := range lines {
		t := strings.TrimSpace(l.text)
		if f := fenceOf(t); f != "" && (!inFence || strings.HasPrefix(t, fence)) {
			inFence = !inFence
			fence = f
		}
		if !inFence && t == "" {
			// A blank line inside a callout ("> " lines either side) doesn't end it.
			if len(cur) > 0 && strings.HasPrefix(strings.TrimSpace(cur[len(cur)-1].text), ">") &&
				i+1 < len(lines) && strings.HasPrefix(strings.TrimSpace(lines[i+1].text), ">") {
				cur = append(cur, l)
				continue
			}
			flush()
			continue
		}
		if !inFence && (layoutRe.MatchString(l.text) || detailsRe.MatchString(l.text)) {
			continue
		}
		// A callout that starts right after text is its own block.
		if !inFence && calloutStart.MatchString(l.text) && len(cur) > 0 {
			flush()
		}
		cur = append(cur, l)
	}
	flush()

	var out [][]line
	var group []line
	size := 0
	for _, b := range blocks {
		warn := isWarnCallout(b[0].text)
		n := b[len(b)-1].end - b[0].start
		if warn || (len(group) > 0 && size+n > partSize) {
			if len(group) > 0 {
				out = append(out, group)
			}
			group, size = nil, 0
		}
		group = append(group, b...)
		size += n
		if warn {
			out = append(out, group)
			group, size = nil, 0
		}
	}
	if len(group) > 0 {
		out = append(out, group)
	}
	return out
}

func isWarnCallout(s string) bool {
	m := calloutStart.FindStringSubmatch(s)
	if m == nil {
		return false
	}
	k := strings.ToLower(m[1])
	return k == "danger" || k == "warning" || k == "caution"
}

// Plain is a line of Markdown as text: links become their labels and
// formatting marks go.
func Plain(s string) string {
	if layoutRe.MatchString(s) || detailsRe.MatchString(s) || readTimeRe.MatchString(strings.TrimSpace(strings.TrimLeft(s, "> "))) {
		return ""
	}
	s = wikiLinkRe.ReplaceAllStringFunc(s, func(m string) string {
		if strings.HasPrefix(m, "!") {
			return ""
		}
		g := wikiLinkRe.FindStringSubmatch(m)
		if g[4] != "" {
			return g[4]
		}
		t := g[1]
		if i := strings.LastIndexByte(t, '/'); i >= 0 {
			t = t[i+1:]
		}
		return strings.TrimSuffix(t, ".md")
	})
	s = mdLinkRe.ReplaceAllStringFunc(s, func(m string) string {
		if strings.HasPrefix(m, "!") {
			return ""
		}
		return mdLinkRe.FindStringSubmatch(m)[1]
	})
	s = htmlTagRe.ReplaceAllString(s, "")
	s = calloutMarker.ReplaceAllString(s, "")
	s = markerRe.ReplaceAllString(s, "")
	s = strings.NewReplacer("**", "", "__", "", "~~", "", "`", "", "==", "", `\|`, "|").Replace(s)
	return strings.TrimSpace(s)
}

var calloutMarker = regexp.MustCompile(`^\s*>?\s*\[!\w+\][+-]?\s*`)

func isDivider(row string) bool {
	return strings.Trim(row, "|:- \t") == ""
}

func fenceOf(t string) string {
	for _, f := range []string{"```", "~~~"} {
		if strings.HasPrefix(t, f) {
			return f
		}
	}
	return ""
}

// frontmatterEnd is where a page's body starts: after a leading "---" block
// whose second line is a YAML key, or 0.
func frontmatterEnd(content string) int {
	if !strings.HasPrefix(content, "---\n") && !strings.HasPrefix(content, "---\r\n") {
		return 0
	}
	at := strings.IndexByte(content, '\n') + 1
	first := true
	for at < len(content) {
		nl := strings.IndexByte(content[at:], '\n')
		end := len(content)
		if nl >= 0 {
			end = at + nl + 1
		}
		l := strings.TrimRight(content[at:end], "\r\n")
		if strings.TrimRight(l, " \t") == "---" {
			return end
		}
		if first && !strings.Contains(l, ":") {
			return 0
		}
		first = false
		at = end
	}
	return 0
}

func hasSourceKey(fm string) bool {
	for _, l := range strings.Split(fm, "\n") {
		k, v, ok := strings.Cut(l, ":")
		if ok && strings.EqualFold(strings.TrimSpace(k), "source") && strings.TrimSpace(v) != "" {
			return true
		}
	}
	return false
}

// Markdown is the part of a page between two offsets, tidied for showing on
// its own: toggle wrappers, column fences, the table of contents and
// read-time lines go, and a heading line, if any, is dropped.
func Markdown(content string, start, end int) string {
	if start < 0 || end > len(content) || start >= end {
		return ""
	}
	var out []string
	inFence, fence := false, ""
	for _, l := range strings.Split(strings.TrimRight(content[start:end], "\n"), "\n") {
		t := strings.TrimSpace(l)
		if f := fenceOf(t); f != "" && (!inFence || strings.HasPrefix(t, fence)) {
			inFence = !inFence
			fence = f
		}
		if !inFence {
			if layoutRe.MatchString(l) || detailsRe.MatchString(l) || toggleHeading.MatchString(l) || readTimeRe.MatchString(strings.TrimLeft(t, "> ")) {
				continue
			}
			// A callout line left empty by removing its read time.
			if t == ">" && len(out) > 0 && strings.TrimSpace(out[len(out)-1]) == ">" {
				continue
			}
		}
		out = append(out, l)
	}
	// Trim blank and empty-quote lines left at the ends.
	for len(out) > 0 && (strings.TrimSpace(out[len(out)-1]) == "" || strings.TrimSpace(out[len(out)-1]) == ">") {
		out = out[:len(out)-1]
	}
	for len(out) > 0 && strings.TrimSpace(out[0]) == "" {
		out = out[1:]
	}
	return strings.Join(out, "\n")
}
