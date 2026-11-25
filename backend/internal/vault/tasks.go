package vault

import (
	"html"
	"regexp"
	"strings"
	"time"
)

// Task is an unchecked to-do item on a page: "- [ ] Do the thing".
type Task struct {
	// Line is 1-based, counted from the top of the file (front matter
	// included), so a client can tick off exactly that line.
	Line int
	// Text is the item's first line as plain text.
	Text string
	// Heading is the nearest heading above the task, as plain text.
	Heading string
	// Depth is how many list items it's nested in: 0 at the top level.
	Depth int
	// Due is the day of the first date chip on the line ("@2026-11-20"), as
	// 2026-11-20, or "" without one. The chip isn't part of Text.
	Due string
}

// Dated is a line that names a day with a date chip ("@2026-11-20"). A line
// with several chips comes back once for each day.
type Dated struct {
	// Line is 1-based from the top of the file, like Task.Line.
	Line int
	// Date is the day, as 2026-11-20.
	Date string
	// Text is the line as plain text without its chips; it may be empty.
	Text string
	// Heading is the nearest heading above the line, as plain text.
	Heading string
	// Task says the line is a to-do item, and Done that it's ticked.
	Task, Done bool
}

var (
	// A list item, possibly inside block quotes: quote markers, indent, then
	// whatever follows the bullet or number.
	listItem = regexp.MustCompile(`^((?:[ \t]*>)*)([ \t]*)(?:[-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$`)
	openBox  = regexp.MustCompile(`^\[ \](?:[ \t]+(.*))?$`)
	anyBox   = regexp.MustCompile(`^\[([ xX])\](?:[ \t]+(.*))?$`)
	// The "[!note]" that opens a callout, and what a pulled-out date leaves behind.
	calloutMark = regexp.MustCompile(`^\[![A-Za-z]+\][+-]?[ \t]*`)
	emptyParens = regexp.MustCompile(`\([ \t]*\)`)
	spaceBefore = regexp.MustCompile(`[ \t]+([.,;:!?)])`)
	atxHeading  = regexp.MustCompile(`^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$`)
	// A toggle heading, which the editor saves as <summary><h2>Title</h2></summary>.
	toggleHeading = regexp.MustCompile(`^<summary><h[1-3]>(.*)</h[1-3]></summary>[ \t]*$`)
	starEm        = regexp.MustCompile(`\*([^*\s](?:[^*]*[^*\s])?)\*`)
	underEm       = regexp.MustCompile(`(^|[^\p{L}\p{N}_])_([^_\s](?:[^_]*[^_\s])?)_($|[^\p{L}\p{N}_])`)
	escaped       = regexp.MustCompile("\\\\([!-/:-@\\[-`{-~])")
)

// Tasks lists a page's open to-dos in order. Code blocks are skipped, and
// checked items ("[x]") are left out.
func Tasks(content string) []Task {
	_, body := splitFrontmatter(content)
	line := strings.Count(content[:len(content)-len(body)], "\n")
	// Nothing after the last "[ ]" matters.
	last := strings.LastIndex(body, "[ ]")
	if last < 0 {
		return nil
	}
	if i := strings.IndexByte(body[last:], '\n'); i >= 0 {
		body = body[:last+i]
	}
	var out []Task
	heading := ""
	var stack []int // indents of the list items the current line sits in
	quotes := 0
	inFence, fence := false, ""
	for raw := range strings.Lines(body) {
		line++
		raw = strings.TrimRight(raw, "\r\n")
		bare := strings.TrimLeft(raw, "> \t")
		if f := fenceMarker(bare); f != "" && (!inFence || strings.HasPrefix(bare, fence)) {
			inFence = !inFence
			if inFence {
				fence = f
			}
			continue
		}
		if inFence || bare == "" {
			continue
		}
		// The first character rules out most lines before any regexp runs.
		var m, h []string
		switch c := bare[0]; {
		case c == '-' || c == '*' || c == '+' || c >= '0' && c <= '9':
			m = listItem.FindStringSubmatch(raw)
		case c == '#':
			h = atxHeading.FindStringSubmatch(raw)
		case c == '<':
			if h = toggleHeading.FindStringSubmatch(bare); h != nil {
				h[1] = html.UnescapeString(h[1])
			}
		}
		if m == nil {
			if h != nil {
				heading = stripInline(h[1])
				stack = stack[:0]
			} else if raw[0] != ' ' && raw[0] != '\t' && raw[0] != '>' {
				// An unindented paragraph ends the list.
				stack = stack[:0]
			}
			continue
		}
		if q := strings.Count(m[1], ">"); q != quotes {
			stack, quotes = stack[:0], q
		}
		ind := indentWidth(m[2])
		for len(stack) > 0 && stack[len(stack)-1] >= ind {
			stack = stack[:len(stack)-1]
		}
		depth := len(stack)
		stack = append(stack, ind)
		if b := openBox.FindStringSubmatch(m[3]); b != nil {
			text, dates := plainDated(b[1])
			if text != "" {
				t := Task{Line: line, Text: text, Heading: heading, Depth: depth}
				if len(dates) > 0 {
					t.Due = dates[0]
				}
				out = append(out, t)
			}
		}
	}
	return out
}

// Dates lists the lines of a page that carry a date chip, in order. Code
// blocks and inline code are skipped.
func Dates(content string) []Dated {
	_, body := splitFrontmatter(content)
	line := strings.Count(content[:len(content)-len(body)], "\n")
	// Nothing after the last "@" matters.
	last := strings.LastIndexByte(body, '@')
	if last < 0 {
		return nil
	}
	if i := strings.IndexByte(body[last:], '\n'); i >= 0 {
		body = body[:last+i]
	}
	var out []Dated
	heading := ""
	inFence, fence := false, ""
	for raw := range strings.Lines(body) {
		line++
		raw = strings.TrimRight(raw, "\r\n")
		bare := strings.TrimLeft(raw, "> \t")
		if f := fenceMarker(bare); f != "" && (!inFence || strings.HasPrefix(bare, fence)) {
			inFence = !inFence
			if inFence {
				fence = f
			}
			continue
		}
		if inFence || bare == "" {
			continue
		}
		// The part of the line that's text, past its list, heading or table marks.
		rest := bare
		d := Dated{Line: line}
		switch c := bare[0]; {
		case c == '-' || c == '*' || c == '+' || c >= '0' && c <= '9':
			if m := listItem.FindStringSubmatch(raw); m != nil {
				rest = m[3]
				if b := anyBox.FindStringSubmatch(rest); b != nil {
					d.Task, d.Done, rest = true, b[1] != " ", b[2]
				}
			}
		case c == '#':
			if h := atxHeading.FindStringSubmatch(raw); h != nil {
				rest = h[1]
				heading = stripInline(rest)
			}
		case c == '<':
			if h := toggleHeading.FindStringSubmatch(bare); h != nil {
				rest = html.UnescapeString(h[1])
				heading = stripInline(rest)
			}
		case c == '|':
			rest = strings.ReplaceAll(bare, "|", " ")
		case c == '[':
			rest = calloutMark.ReplaceAllString(bare, "")
		}
		if !strings.Contains(rest, "@") {
			continue
		}
		text, dates := plainDated(rest)
		d.Text, d.Heading = text, heading
		for i, date := range dates {
			if !contains(dates[:i], date) {
				d.Date = date
				out = append(out, d)
			}
		}
	}
	return out
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func indentWidth(s string) int {
	n := 0
	for _, r := range s {
		if r == '\t' {
			n += 4 - n%4
		} else {
			n++
		}
	}
	return n
}

// stripInline turns a line of inline Markdown into plain text: links become
// their labels, and emphasis, code marks, HTML tags and escapes go.
func stripInline(line string) string {
	return stripMarks(stripLinks(line))
}

// plainDated is stripInline for a line that may carry date chips: they come
// out of the text and back as days, in order.
func plainDated(line string) (string, []string) {
	if !strings.Contains(line, "@") {
		return stripInline(line), nil
	}
	line, dates := pullDates(stripLinks(line))
	if dates == nil {
		return stripMarks(line), nil
	}
	// Tidy what the chip leaves: "Renew (@…)" and "Dentist - @…".
	line = emptyParens.ReplaceAllString(stripMarks(line), "")
	line = spaceBefore.ReplaceAllString(line, "$1")
	line = strings.Trim(line, " \t-–—:,;·|")
	return strings.Join(strings.Fields(line), " "), dates
}

// pullDates takes the date chips ("@2026-11-20") out of a line, leaving
// inline code alone. Like the editor, it wants a real day that isn't glued
// to a word on either side, so an address like me@2026-11-20.example stays.
func pullDates(s string) (string, []string) {
	const size = len("@2006-01-02")
	var dates []string
	var b strings.Builder
	code := inlineCode.FindAllStringIndex(s, -1)
	last := 0
	for i := 0; i+size <= len(s); i++ {
		for len(code) > 0 && code[0][1] <= i {
			code = code[1:]
		}
		if len(code) > 0 && i >= code[0][0] {
			i = code[0][1] - 1
			continue
		}
		if s[i] != '@' {
			continue
		}
		if i > 0 && (wordByte(s[i-1]) || s[i-1] == '@' || s[i-1] == '\\') {
			continue
		}
		if i+size < len(s) && (wordByte(s[i+size]) || s[i+size] == '-') {
			continue
		}
		day := s[i+1 : i+size]
		if _, err := time.Parse(time.DateOnly, day); err != nil {
			continue
		}
		dates = append(dates, day)
		b.WriteString(s[last:i])
		last = i + size
		i = last - 1
	}
	if dates == nil {
		return s, nil
	}
	b.WriteString(s[last:])
	return b.String(), dates
}

func wordByte(c byte) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

// stripLinks turns links into their labels and drops HTML tags.
func stripLinks(line string) string {
	// Most lines are plain already; each step runs only if it could apply.
	if strings.Contains(line, "[[") {
		line = wikiLink.ReplaceAllStringFunc(line, func(s string) string {
			m := wikiLink.FindStringSubmatch(s)
			if m[4] != "" {
				return aliasText(m[4])
			}
			return m[2]
		})
	}
	if strings.Contains(line, "](") {
		line = mdLink.ReplaceAllString(line, "$1")
	}
	if strings.Contains(line, "<") {
		line = htmlTag.ReplaceAllString(line, "")
	}
	return line
}

// stripMarks drops emphasis, code marks and escapes, and tidies the spaces.
func stripMarks(line string) string {
	line = inlineMarks.Replace(line)
	if strings.Contains(line, "*") {
		line = starEm.ReplaceAllString(line, "$1")
	}
	if strings.Contains(line, "_") {
		line = underEm.ReplaceAllString(line, "$1$2$3")
	}
	if strings.Contains(line, `\`) {
		line = escaped.ReplaceAllString(line, "$1")
	}
	return strings.Join(strings.Fields(line), " ")
}

var inlineMarks = strings.NewReplacer("**", "", "__", "", "~~", "", "`", "", "==", "")
