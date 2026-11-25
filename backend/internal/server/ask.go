package server

import (
	"errors"
	"math/rand/v2"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/oddomens/quire/internal/ask"
	"github.com/oddomens/quire/internal/store"
)

// ask answers a question from the notes: GET /api/ask?q=…
//
//	prev, prevPage  the question before and the page its answer came from,
//	                so a follow-up keeps the topic
//	page, section   show this section of this page (a follow-up chip)
//	spaces          comma-separated spaces to keep to
func (s *Server) ask(w http.ResponseWriter, r *http.Request) {
	a, _, err := s.answerFor(r)
	if errors.Is(err, errNoQuestion) {
		writeErr(w, http.StatusBadRequest, "ask a question")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if done, total, err := s.store.PassageProgress(); err == nil && done < total {
		a.Building = float64(done) / float64(total)
	}
	writeJSON(w, http.StatusOK, a)
}

var errNoQuestion = errors.New("ask a question")

// answerFor finds the answer to the question in r's query string, and
// returns the question too.
func (s *Server) answerFor(r *http.Request) (*ask.Answer, string, error) {
	v := r.URL.Query()
	q := strings.TrimSpace(v.Get("q"))
	if len(q) > 500 {
		q = q[:500]
	}
	opt := ask.Options{PrevPage: v.Get("prevPage"), Page: v.Get("page")}
	opt.Spaces = splitSpaces(v.Get("spaces"))
	if opt.Page != "" {
		opt.Section, _ = strconv.Atoi(v.Get("section"))
	} else if q == "" {
		return nil, "", errNoQuestion
	}
	idx, err := s.store.AskIndex()
	if err != nil {
		return nil, q, err
	}
	prev := v.Get("prev")
	if len(prev) > 500 {
		prev = prev[:500]
	}
	a, err := ask.Ask(idx, ask.Analyze(q, prev), opt)
	return a, q, err
}

// bestFirst adds the sections Ask would answer a search with to its exact
// matches. They lead when they fit well; a search that only works with a
// spelling changed waits behind exact matches, since a word still being
// typed looks misspelled.
func (s *Server) bestFirst(q string, exact []store.Hit, limit int) ([]store.Hit, error) {
	q = strings.TrimSpace(q)
	if len(q) > 200 {
		q = q[:200]
	}
	if len([]rune(q)) < 3 || strings.HasPrefix(q, "#") {
		return exact, nil
	}
	idx, err := s.store.AskIndex()
	if err != nil {
		return nil, err
	}
	a, err := ask.Ask(idx, ask.Analyze(q, ""), ask.Options{})
	if err != nil {
		return nil, err
	}
	if a.Main == nil || a.Confidence == "none" || (len(a.Corrected) > 0 && len(exact) > 0) {
		return exact, nil
	}
	var best []store.Hit
	seen := map[string]bool{}
	add := func(sec ask.Section) {
		if seen[sec.Path+"\x00"+sec.Heading] || sec.Snippet == "" {
			return
		}
		seen[sec.Path+"\x00"+sec.Heading] = true
		folder := ""
		if i := strings.LastIndexByte(sec.Path, '/'); i >= 0 {
			folder = sec.Path[:i]
		}
		best = append(best, store.Hit{Path: sec.Path, Title: sec.Title, Folder: folder, Snippet: sec.Snippet, Heading: sec.Heading})
	}
	add(*a.Main)
	for _, sec := range a.Related {
		add(sec)
	}
	for _, sec := range a.More {
		add(sec)
	}
	pages := map[string]bool{}
	for _, h := range best {
		pages[h.Path] = true
	}
	var rest []store.Hit
	for _, h := range exact {
		if !pages[h.Path] {
			rest = append(rest, h)
		}
	}
	out := append(best, rest...)
	if a.Confidence == "low" {
		out = append(rest, best...)
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

type askSuggestion struct {
	Question string `json:"question"`
}

var (
	questionHeading = regexp.MustCompile(`(?i)^(how|what|when|why|where|which|is|are|can|should|do|does)\b.*`)
	signsHeading    = regexp.MustCompile(`(?i)^(signs|symptoms) (of|and symptoms of) (.+)$`)
	howToHeading    = regexp.MustCompile(`(?i)^how to (.+)$`)
	whenToHeading   = regexp.MustCompile(`(?i)^when to (.+)$`)
	ifHeading       = regexp.MustCompile(`(?i)^if (you|a|the|your|someone) (.+)$`)
)

// askSuggestions are a few questions the notes can answer, made from their
// headings, for the empty Ask screen: GET /api/ask/suggestions?spaces=…
func (s *Server) askSuggestions(w http.ResponseWriter, r *http.Request) {
	heads, err := s.store.AskHeadings(splitSpaces(r.URL.Query().Get("spaces")))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	seen := map[string]bool{}
	kinds := map[string]int{} // at most two of each kind, for variety
	var out []askSuggestion
	rand.Shuffle(len(heads), func(i, j int) { heads[i], heads[j] = heads[j], heads[i] })
	for _, h := range heads {
		q := questionFrom(h.Heading, h.Title)
		if q == "" || seen[strings.ToLower(q)] {
			continue
		}
		kind := strings.Join(strings.Fields(q)[:3], " ")
		if kinds[kind] >= 2 {
			continue
		}
		kinds[kind]++
		seen[strings.ToLower(q)] = true
		out = append(out, askSuggestion{q})
		if len(out) == 6 {
			break
		}
	}
	if out == nil {
		out = []askSuggestion{}
	}
	writeJSON(w, http.StatusOK, out)
}

func splitSpaces(sp string) []string {
	var out []string
	for _, name := range strings.Split(sp, ",") {
		if name = strings.TrimSpace(name); name != "" {
			out = append(out, name)
		}
	}
	return out
}

// questionFrom turns a heading into a question that stands on its own, or
// "" if it doesn't make one ("When to do it" names nothing).
func questionFrom(heading, title string) string {
	h := strings.TrimSpace(strings.TrimRight(heading, ":.?!"))
	lowTitle := strings.ToLower(title)
	if len(h) < 8 || len(h) > 70 || strings.ContainsAny(h, ":;()/") {
		return ""
	}
	low := strings.ToLower(h)
	var q string
	switch {
	case signsHeading.MatchString(h):
		q = "What are the signs of " + signsHeading.FindStringSubmatch(h)[3] + "?"
	case low == "signs and symptoms" && !strings.ContainsAny(title, "'’"):
		q = "What are the signs of " + lowTitle + "?"
	case low == "see a doctor or urgent care if" || low == "when to see a doctor":
		q = "When should I see a doctor for " + lowTitle + "?"
	case low == "prevention" && conditionTitle(title):
		q = "How do I prevent " + lowTitle + "?"
	case howToHeading.MatchString(h):
		q = "How do I " + lowerFirst(howToHeading.FindStringSubmatch(h)[1]) + "?"
	case whenToHeading.MatchString(h):
		q = "When should I " + lowerFirst(whenToHeading.FindStringSubmatch(h)[1]) + "?"
	case ifHeading.MatchString(h):
		q = "What do I do if " + lowerFirst(h[3:]) + "?"
	case strings.HasSuffix(strings.TrimSpace(heading), "?") && questionHeading.MatchString(h):
		q = h + "?"
	default:
		return ""
	}
	// It must say what it's about: enough words, and not just "it" or "this".
	words := strings.Fields(strings.TrimSuffix(q, "?"))
	if len(words) < 5 || vague.MatchString(q) {
		return ""
	}
	return q
}

var vague = regexp.MustCompile(`(?i)\b(it|this|that|these|those|them|one|here|there|below|above)\?$|\b(it|this|that)\b`)

// conditionTitle is a page title that names a thing ("Frostbite", "Heat
// exhaustion and heat stroke") rather than a situation ("Swallowed
// something harmful"), so "How do I prevent …" reads right.
func conditionTitle(t string) bool {
	w := strings.Fields(strings.ToLower(t))
	return len(w) > 0 && len(w) <= 5 && !strings.HasSuffix(w[0], "ed") && !strings.ContainsAny(t, "'’?")
}

func lowerFirst(s string) string {
	if len(s) > 1 && s[1] >= 'a' && s[1] <= 'z' {
		return strings.ToLower(s[:1]) + s[1:]
	}
	return s
}
