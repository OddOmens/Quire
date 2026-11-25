package ask

import (
	"fmt"
	"math"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode"
)

// Hit is a passage from the index.
type Hit struct {
	ID      int64
	Path    string
	Section int
	Part    int
	Heading string
	Trail   string // the headings above it and its own
	Level   int
	Start   int
	End     int
	Flags   int
	Words   int
	BM25    float64 // from the full-text search; 0 if the passage came another way
}

// Index is what answering needs from the database.
type Index interface {
	// Search finds passages matching an FTS5 expression, best first, in the
	// given spaces ("" or none for all).
	Search(match string, spaces []string, limit int) ([]Hit, error)
	// Count is how many passages match an FTS5 expression.
	Count(match string) (int, error)
	// Total is how many passages there are.
	Total() (int, error)
	// Within reports which of ids match an FTS5 expression, optionally in
	// one column ("title" or "heading").
	Within(match string, ids []int64, column string) (map[int64]bool, error)
	// Page lists a page's passages in order.
	Page(path string) ([]Hit, error)
	// Content is a page's text as indexed.
	Content(path string) (string, error)
	// Folders lists every folder that holds pages ("Vehicles/2012 Honda Accord EX").
	Folders() ([]string, error)
	// Named maps the pages that phrases name, by title, to how strongly (1
	// for a whole title, less for part of one); labels may also name pages
	// by the label links to them use.
	Named(phrases, labels []string) (map[string]float64, error)
	// Suggest lists words in the notes close to a misspelled one, closest first.
	Suggest(word string) []string
}

// Trace, if set, is told how the top pages scored (for tuning).
var Trace func(string)

// Options narrow or steer a question.
type Options struct {
	Spaces   []string // only these spaces; none for all
	PrevPage string   // the page the last answer came from
	Page     string   // answer from this page…
	Section  int      // …this section of it (with Page)

	spelled bool // spelling already corrected
}

// Section is a piece of a page to show.
type Section struct {
	Path     string `json:"path"`
	Title    string `json:"title"`
	Heading  string `json:"heading"`
	Markdown string `json:"markdown"`
	Snippet  string `json:"snippet,omitempty"`
	Section  int    `json:"section"`
	Partial  bool   `json:"partial,omitempty"` // only part of a long section
	Ref      bool   `json:"ref,omitempty"`
}

// Chip is a follow-up: another section of the answer's page.
type Chip struct {
	Label   string `json:"label"`
	Path    string `json:"path"`
	Section int    `json:"section"`
}

// Answer is what a question gets back.
type Answer struct {
	Query      string            `json:"query"`
	Intent     Intent            `json:"intent"`
	Urgent     bool              `json:"urgent"`
	FollowUp   bool              `json:"followUp,omitempty"`
	Corrected  map[string]string `json:"corrected,omitempty"` // misspelled → used instead
	Confidence string            `json:"confidence"`          // high, medium, low or none
	Warning    *Section          `json:"warning,omitempty"`
	Main       *Section          `json:"main,omitempty"`
	Compare    []Section         `json:"compare,omitempty"`
	More       []Section         `json:"more"`
	Chips      []Chip            `json:"chips"`
	Related    []Section         `json:"related"`
	Terms      []string          `json:"terms"`
	// Missing are words asked that the answer's page doesn't have.
	Missing []string `json:"missing,omitempty"`
	// Building is how much of the notes can be searched yet (0 to 1), while
	// pages from before Ask existed are still being read; absent when done.
	Building float64 `json:"building,omitempty"`
}

const (
	maxShow    = 2600 // bytes of Markdown to show for the main answer
	maxMore    = 1800
	maxRelated = 1400
)

type scored struct {
	Hit
	score, cover float64
	why          string // for Trace
}

// Ask answers a question.
func Ask(idx Index, q Query, opt Options) (*Answer, error) {
	a := &Answer{Query: q.Text, Intent: q.Intent, Urgent: q.Urgent, FollowUp: q.FollowUp, More: []Section{}, Chips: []Chip{}, Related: []Section{}, Terms: []string{}}

	if opt.Page != "" {
		return a, showSection(idx, a, q, opt.Page, opt.Section)
	}

	if q.Intent == IntentCompare && len(q.Compare) == 2 {
		for _, side := range q.Compare {
			sub := Analyze(side, "")
			sub.Intent = IntentDefine
			r, err := Ask(idx, sub, Options{Spaces: opt.Spaces})
			if err != nil {
				return nil, err
			}
			if r.Main != nil {
				a.Compare = append(a.Compare, *r.Main)
			}
			a.Terms = append(a.Terms, r.Terms...)
		}
		if len(a.Compare) == 2 {
			a.Confidence = "medium"
			return a, nil
		}
		a.Compare = nil
		q.Intent = IntentAny
		a.Intent = IntentAny
	}

	if len(q.Terms) == 0 {
		a.Confidence = "none"
		return a, nil
	}

	// Words nothing contains are probably misspelled.
	for i, t := range q.Terms {
		if opt.spelled || t.Of >= 0 || t.Weight < 1 || strings.Contains(t.Word, " ") {
			continue
		}
		n, err := idx.Count(match(t.Word))
		if err != nil {
			return nil, err
		}
		if n == 0 {
			if s := pickSpelling(idx, q, i, idx.Suggest(t.Word)); s != "" && s != t.Word {
				if a.Corrected == nil {
					a.Corrected = map[string]string{}
				}
				a.Corrected[t.Word] = s
				q.Terms[i].Word = s
				for _, alt := range synonyms[s] {
					q.add(alt, 0.35, i)
				}
			}
		}
	}

	// Read the corrected question again, so its intent and any emergency
	// words count ("snaek bite" is a snake bite).
	if a.Corrected != nil {
		fixed := q.Text
		for wrong, right := range a.Corrected {
			fixed = regexp.MustCompile(`(?i)\b`+regexp.QuoteMeta(wrong)+`\b`).ReplaceAllString(fixed, right)
		}
		q2 := Analyze(fixed, q.Prev)
		q2.Text = q.Text
		opt.spelled = true
		r, err := Ask(idx, q2, opt)
		if err != nil {
			return nil, err
		}
		if r.Corrected == nil {
			r.Corrected = map[string]string{}
		}
		for k, v := range a.Corrected {
			r.Corrected[k] = v
		}
		return r, nil
	}

	// Two words written as one in the notes ("shut off" -> "shutoff").
	raw := words(plainAsk(strings.ToLower(apostropheRe.Replace(q.Text))))
	for i := 0; i+1 < len(raw); i++ {
		joined := raw[i] + raw[i+1]
		if len(joined) < 6 || stopWords[raw[i]] && stopWords[raw[i+1]] {
			continue
		}
		of := -1
		for j, t := range q.Terms {
			if t.Of < 0 && (t.Word == raw[i] || t.Word == raw[i+1]) {
				of = j
				break
			}
		}
		if of < 0 {
			continue
		}
		if n, err := idx.Count(match(joined)); err == nil && n > 0 {
			q.add(joined, 0.9, of)
		}
	}

	total, err := idx.Total()
	if err != nil {
		return nil, err
	}
	idf := make([]float64, len(q.Terms))
	var exprs []string
	for i, t := range q.Terms {
		n, err := idx.Count(match(t.Word))
		if err != nil {
			return nil, err
		}
		idf[i] = math.Log(float64(total+1)/float64(n+1)) + 0.1
		if n > 0 {
			exprs = append(exprs, match(t.Word))
		}
		if t.Of < 0 && t.Weight >= 1 {
			a.Terms = append(a.Terms, t.Word)
		}
	}
	if len(exprs) == 0 {
		a.Confidence = "none"
		return a, nil
	}

	// Words that name a folder ("honda" -> Vehicles/2012 Honda Accord
	// EX) say where to look more than what about: every page in the
	// folder has them, whether or not its text repeats them.
	scope, named2, byKind, err := scopes(idx, q)
	if err != nil {
		return nil, err
	}
	// A folder word most of whose mentions are in that folder names a thing
	// ("honda", "malibu"), not a topic ("shelter"): every page there is about
	// it, the folder's overview page no more than the others.
	entity := map[int]bool{}
	for i, fs := range scope {
		if named2[i] || byKind[i] || isNumber(q.Terms[i].Word) {
			entity[i] = true
			continue
		}
		all, err := idx.Count(match(q.Terms[i].Word))
		if err != nil {
			return nil, err
		}
		if all == 0 {
			entity[i] = true
			continue
		}
		in, err := idx.Search(match(q.Terms[i].Word), fs, all+1)
		if err != nil {
			return nil, err
		}
		// The user's own things, not a topic of the encyclopedia
		// ("mushroom" -> Plants/Fungi is a subject, not a thing they own).
		refs := 0
		for _, h := range in {
			if h.Flags&FlagRef != 0 {
				refs++
			}
		}
		entity[i] = (float64(len(in)) >= 0.4*float64(all) || all <= 10) && refs*2 < len(in)+1
		if Trace != nil {
			Trace(fmt.Sprintf("scope %q: %v in=%d all=%d entity=%v", q.Terms[i].Word, fs, len(in), all, entity[i]))
		}
	}
	// A word whose folder was found through a related word ("suv" ->
	// Vehicles, by "vehicle") still counts for more where it's written: of
	// two cars, the one whose page says SUV.
	related := map[int]bool{}
	for i, fs := range scope {
		related[i] = true
		for _, f := range fs {
			if nameHas(path.Base(f), q.Terms[i].Word) {
				related[i] = false
			}
		}
	}
	// Pages whose own text has a related-folder word: their sub-pages are
	// about the same thing (the CR-V's oil change, when its page says SUV).
	saidIn := map[int]map[string]bool{}
	for i := range related {
		if !related[i] {
			continue
		}
		saidIn[i] = map[string]bool{}
		hits, err := idx.Search(match(q.Terms[i].Word), scope[i], 200)
		if err != nil {
			return nil, err
		}
		for _, h := range hits {
			saidIn[i][strings.TrimSuffix(h.Path, ".md")] = true
		}
	}
	underHas := func(i int, p string) bool {
		for d := path.Dir(p); d != "." && d != "/"; d = path.Dir(d) {
			if saidIn[i][d] {
				return true
			}
		}
		return false
	}
	inScope := func(i int, p string) bool {
		for _, f := range scope[i] {
			if strings.HasPrefix(p, f+"/") || p == f+".md" {
				return true
			}
		}
		return false
	}

	// Phrases specific enough to name something: two or more words, or one
	// word few passages use ("cottonmouth", not "chicken").
	var specific []string
	for _, ph := range q.Phrases {
		if strings.Contains(ph, " ") {
			specific = append(specific, ph)
		} else if !stopWords[ph] && !lightWords[ph] {
			// In a few passages, or under 1 in 500 of them.
			if n, err := idx.Count(match(ph)); err == nil && n > 0 && (n <= 2 || n*500 <= total) {
				specific = append(specific, ph)
			}
		}
	}

	// "15 pro" in "my 15 pro gets hot" says which phone, not that the
	// iPhone 15 Pro overview is the answer: names made only of such words
	// count when nothing else was asked.
	other := false
	for i, t := range q.Terms {
		if t.Of < 0 && t.Weight >= 1 && !entity[i] {
			other = true
		}
	}
	if other {
		isEntity := map[string]bool{}
		for i := range entity {
			if entity[i] {
				isEntity[q.Terms[i].Word] = true
			}
		}
		keep := func(phs []string) []string {
			var out []string
			for _, ph := range phs {
				for _, w := range strings.Fields(ph) {
					if !isEntity[w] && !stopWords[w] {
						out = append(out, ph)
						break
					}
				}
			}
			return out
		}
		q.Phrases, specific = keep(q.Phrases), keep(specific)
	}
	named, err := idx.Named(q.Phrases, specific)
	if err != nil {
		return nil, err
	}

	// "Tell me about my SUV": only the thing was asked, so its own page (the
	// one its folder is named for) is the answer.
	if !other && !q.FollowUp {
		for i, fs := range scope {
			if !entity[i] {
				continue
			}
			for _, f := range fs {
				if named[f+".md"] < 0.9 {
					named[f+".md"] = 0.9
				}
			}
		}
	}

	// Phrases the notes use as they were asked ("northern lights", "slurred
	// speech"): a passage that says the very words is likely about them.
	type said struct {
		expr  string
		words int
	}
	var says []said
	for _, ph := range q.Phrases {
		w := strings.Fields(ph)
		if len(w) < 2 || stopWords[w[0]] || stopWords[w[len(w)-1]] {
			continue
		}
		content := 0
		for _, x := range w {
			if !stopWords[x] {
				content++
			}
		}
		if content < 2 {
			continue
		}
		e := phraseMatch(ph)
		if n, err := idx.Count(e); err == nil && n > 0 && n*40 <= total {
			says = append(says, said{e, len(w)})
		}
	}
	// Related words can name a page too ("shivering" -> Hypothermia), less strongly.
	var rel []string
	for _, t := range q.Terms {
		if t.Of >= 0 {
			rel = append(rel, t.Word)
		}
	}
	if len(rel) > 0 {
		more, err := idx.Named(rel, nil)
		if err != nil {
			return nil, err
		}
		for p, s := range more {
			if s*0.6 > named[p] {
				named[p] = s * 0.6
			}
		}
	}

	// Candidates: the best full-text matches, every passage of a page the
	// question names, and the page the conversation is on.
	hits, err := idx.Search(strings.Join(exprs, " OR "), opt.Spaces, 160)
	if err != nil {
		return nil, err
	}
	byID := map[int64]*scored{}
	for _, h := range hits {
		byID[h.ID] = &scored{Hit: h}
	}
	for _, ph := range says {
		more, err := idx.Search(ph.expr, opt.Spaces, 40)
		if err != nil {
			return nil, err
		}
		for _, h := range more {
			if byID[h.ID] == nil {
				byID[h.ID] = &scored{Hit: h}
			}
		}
	}
	// Pages whose title has an asked word, however many other passages
	// mention it ("mushroom" -> Wild plants, berries and mushrooms).
	var titled []string
	for _, t := range q.Terms {
		if t.Weight >= 1 && !stopWords[t.Word] {
			if n, err := idx.Count(match(t.Word)); err == nil && n > 0 {
				titled = append(titled, match(t.Word))
			}
		}
	}
	if len(titled) > 0 {
		more, err := idx.Search("title : ("+strings.Join(titled, " OR ")+")", opt.Spaces, 120)
		if err != nil {
			return nil, err
		}
		for _, h := range more {
			if byID[h.ID] == nil {
				byID[h.ID] = &scored{Hit: h}
			}
		}
	}
	// And the best matches for the rest of the question inside those folders.
	if len(scope) > 0 {
		var rest []string
		var where []string
		for i, t := range q.Terms {
			if scope[i] != nil || (t.Of >= 0 && scope[t.Of] != nil) {
				where = append(where, scope[i]...)
				continue
			}
			if n, err := idx.Count(match(t.Word)); err == nil && n > 0 {
				rest = append(rest, match(t.Word))
			}
		}
		var narrowed []string
		for _, f := range where {
			if inSpaces(f+"/x", opt.Spaces) {
				narrowed = append(narrowed, f)
			}
		}
		if len(rest) > 0 && len(narrowed) > 0 {
			more, err := idx.Search(strings.Join(rest, " OR "), narrowed, 120)
			if err != nil {
				return nil, err
			}
			for _, h := range more {
				if byID[h.ID] == nil {
					byID[h.ID] = &scored{Hit: h}
				}
			}
		}
	}
	extra := []string{}
	for p := range named {
		extra = append(extra, p)
	}
	if q.FollowUp && opt.PrevPage != "" {
		extra = append(extra, opt.PrevPage)
	}
	for _, p := range extra {
		if !inSpaces(p, opt.Spaces) {
			continue
		}
		ph, err := idx.Page(p)
		if err != nil {
			return nil, err
		}
		for _, h := range ph {
			if byID[h.ID] == nil {
				byID[h.ID] = &scored{Hit: h}
			}
		}
	}
	if len(byID) == 0 {
		a.Confidence = "none"
		return a, nil
	}
	ids := make([]int64, 0, len(byID))
	for id := range byID {
		ids = append(ids, id)
	}

	// Which terms each passage has, anywhere, in its page title and in its heading.
	pres := make([]presence, len(q.Terms))
	for i, t := range q.Terms {
		m := match(t.Word)
		if pres[i].any, err = idx.Within(m, ids, ""); err != nil {
			return nil, err
		}
		if pres[i].title, err = idx.Within(m, ids, "title"); err != nil {
			return nil, err
		}
		if pres[i].heading, err = idx.Within(m, ids, "heading"); err != nil {
			return nil, err
		}
		// The word itself, not one that only starts the same ("quart", not
		// "quarterfinal").
		if pres[i].exact, err = idx.Within(exactMatch(t.Word), ids, ""); err != nil {
			return nil, err
		}
		pres[i].placed = map[int64]bool{}
		for id := range pres[i].title {
			pres[i].placed[id] = true
		}
		for id := range pres[i].heading {
			pres[i].placed[id] = true
		}
	}

	saysIn := make([]map[int64]bool, len(says))
	for i, ph := range says {
		if saysIn[i], err = idx.Within(ph.expr, ids, ""); err != nil {
			return nil, err
		}
	}

	var askedIdf float64
	for i, t := range q.Terms {
		if t.Of < 0 {
			askedIdf += idf[i] * t.Weight
		}
	}
	if askedIdf == 0 {
		askedIdf = 1
	}
	// A word that names the page's folder counts nearly as if the passage
	// had it, but not as part of its title: in "how do I build a shelter",
	// Shelter and fire/Building a fire isn't about shelters.
	credit := func(id int64, col func(presence) map[int64]bool, folders bool) float64 {
		var got float64
		p := byID[id].Path
		for i, t := range q.Terms {
			if t.Of >= 0 {
				continue
			}
			c := 0.0
			switch {
			case entity[i] && !folders:
				// Not part of any title: see entity.
			case entity[i] && inScope(i, p):
				c = 1
				if related[i] && !col(pres[i])[id] {
					c = 0.85
					if underHas(i, p) {
						c = 0.9
					}
				}
			case col(pres[i])[id]:
				c = 1
				if !pres[i].exact[id] {
					c = loose
				}
			case folders && inScope(i, p):
				c = 0.8
			default:
				for j, s := range q.Terms {
					if s.Of == i && col(pres[j])[id] {
						// A joined form ("shutoff") is as good as the words.
						if v := math.Min(0.95, s.Weight/0.35*0.6); v > c {
							c = v
						}
					}
				}
			}
			got += c * idf[i] * t.Weight
		}
		return got / askedIdf
	}

	folderList, err := idx.Folders()
	if err != nil {
		return nil, err
	}
	hubs := map[string]bool{}
	for _, f := range folderList {
		hubs[f+".md"] = true
	}
	hasEntity := false
	for i := range entity {
		hasEntity = hasEntity || entity[i]
	}
	practical := map[Intent]bool{IntentHowTo: true, IntentWhenHelp: true, IntentSigns: true, IntentPrevent: true, IntentSafe: true, IntentAmount: true}
	for _, s := range byID {
		cover := credit(s.ID, func(p presence) map[int64]bool { return p.any }, true)
		titleC := credit(s.ID, func(p presence) map[int64]bool { return p.title }, false)
		headC := credit(s.ID, func(p presence) map[int64]bool { return p.heading }, false)
		// Where the passage is, by its page title, headings and folder: a
		// section placed exactly where the question points (Insect bites and
		// stings › Bees and wasps, for a bee sting) beats one that only
		// mentions the words.
		placed := credit(s.ID, func(p presence) map[int64]bool { return p.placed }, true)
		s.cover = cover
		sc := 7*math.Pow(cover, 1.4) + 4.5*titleC + 2.5*headC + 0.35*math.Log1p(math.Max(0, -s.BM25))
		sc += 5 * named[s.Path]
		sc += 3 * math.Pow(placed, 1.5)
		// A title the question explains all of ("Gets hot" for "my 15 pro
		// gets really hot", "Burns" for "burned my hand") is likely the page.
		f := titleFit(s.Path, q)
		sc += 2.5 * f * f
		sc += 1.5 * folderCredit(s.Path, q)
		// A heading that is exactly what was asked about ("Bowline").
		if s.Heading != "" {
			hl := strings.ToLower(s.Heading)
			for _, ph := range specific {
				if hl == ph || strings.TrimSuffix(hl, "s") == ph || hl == ph+"s" {
					sc += 3
					break
				}
			}
		}
		phraseB := 0.0
		for i, ph := range says {
			if saysIn[i][s.ID] {
				phraseB = math.Max(phraseB, math.Min(4, 1.5+float64(ph.words-1)))
			}
		}
		sc += phraseB
		if q.FollowUp && s.Path == opt.PrevPage {
			sc += 2.5
		}
		sc += intentBonus(q, s.Hit)
		ref := s.Flags&FlagRef != 0
		switch {
		case ref && (practical[q.Intent] || q.Urgent || q.Personal && q.Intent != IntentDefine && q.Intent != IntentWhy && q.Intent != IntentWhere):
			sc *= 0.6
		case ref && q.Intent == IntentAny && !(q.Bare && named[s.Path] >= 0.8):
			// The user's own guides answer everyday questions; the
			// encyclopedia is for what things are.
			sc *= 0.7
		case !ref && q.Intent == IntentDefine && named[s.Path] == 0:
			sc *= 0.92
		}
		// "my 15 pro gets hot": a page about something else that gets hot
		// is the wrong answer, however well it matches.
		if hasEntity {
			in := false
			for i := range entity {
				if entity[i] && inScope(i, s.Path) {
					in = true
				}
			}
			if !in {
				sc *= 0.6
			}
		}
		// A hub page (iPhone 15 Pro, with a page for each problem under it)
		// answers less well than the page under it about what was asked.
		if hubs[s.Path] && other {
			sc *= 0.82
		}
		if s.Words < 12 && s.Flags&FlagWarn == 0 {
			sc *= 0.75
		}
		if cover == 0 && named[s.Path] == 0 && !(q.FollowUp && s.Path == opt.PrevPage) {
			sc *= 0.3
		}
		s.score = sc
		if Trace != nil {
			s.why = fmt.Sprintf("t=%.2f h=%.2f fit=%.2f placed=%.2f", titleC, headC, f, placed)
		}
	}

	// Pages: their best passage, plus a little for each other good section.
	pages := map[string][]*scored{}
	for _, s := range byID {
		pages[s.Path] = append(pages[s.Path], s)
	}
	type page struct {
		path  string
		score float64
		best  []*scored
	}
	var ranked []page
	for p, ss := range pages {
		sort.Slice(ss, func(i, j int) bool { return ss[i].score > ss[j].score })
		sc := ss[0].score
		seen := map[int]bool{ss[0].Section: true}
		bonus := 0.25
		for _, s := range ss[1:] {
			if !seen[s.Section] && s.cover > 0 {
				seen[s.Section] = true
				sc += bonus * s.score
				bonus /= 2.5
			}
		}
		ranked = append(ranked, page{p, sc, ss})
	}
	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].score != ranked[j].score {
			return ranked[i].score > ranked[j].score
		}
		return ranked[i].path < ranked[j].path
	})

	// How much of what was asked a page has anywhere, and which words it
	// doesn't. A page that has all of it, in whatever sections, is more
	// likely the one than a page where one section has most of it; and a
	// page missing the word that matters isn't a sure answer.
	pageHas := func(p string) (float64, []string, error) {
		all, err := idx.Page(p)
		if err != nil {
			return 0, nil, err
		}
		ids := make([]int64, len(all))
		for i, h := range all {
			ids[i] = h.ID
		}
		var got float64
		var missing []string
		for i, t := range q.Terms {
			if t.Of >= 0 {
				continue
			}
			has, err := idx.Within(match(t.Word), ids, "")
			if err != nil {
				return 0, nil, err
			}
			c := 0.0
			switch {
			case len(has) > 0 || inScope(i, p):
				c = 1
			default:
				for _, s := range q.Terms {
					if s.Of != i {
						continue
					}
					if rel, err := idx.Within(match(s.Word), ids, ""); err == nil && len(rel) > 0 {
						c = 0.6
						break
					}
				}
			}
			got += c * idf[i] * t.Weight
			if c == 0 && t.Weight >= 1 {
				missing = append(missing, t.Word)
			}
		}
		return got / askedIdf, missing, nil
	}
	for i := range ranked {
		if i == 15 {
			break
		}
		c, _, err := pageHas(ranked[i].path)
		if err != nil {
			return nil, err
		}
		ranked[i].score += 2.5 * c * c
	}
	sort.SliceStable(ranked[:min(15, len(ranked))], func(i, j int) bool { return ranked[i].score > ranked[j].score })

	if Trace != nil {
		for i, p := range ranked {
			if i == 30 {
				break
			}
			b := p.best[0]
			Trace(fmt.Sprintf("%6.2f %-60s › %-30s cover=%.2f named=%.2f %s", p.score, p.path, b.Heading, b.cover, named[p.path], b.why))
		}
	}

	// Your own guides before the encyclopedia: unless the question asks what
	// something is (or names the page), a guide that has everything asked
	// beats a reference page that scored a little higher on its title.
	if r0 := ranked[0]; r0.best[0].Flags&FlagRef != 0 && named[r0.path] < 0.6 && !(q.FollowUp && r0.path == opt.PrevPage) && q.Intent != IntentDefine && q.Intent != IntentWhy && q.Intent != IntentWhere {
		for i := 1; i < len(ranked) && i < 6; i++ {
			p := ranked[i]
			if p.best[0].Flags&FlagRef == 0 && p.score >= 0.65*r0.score && p.best[0].cover >= 0.9 {
				copy(ranked[1:i+1], ranked[:i])
				ranked[0] = p
				break
			}
		}
	}

	top := ranked[0]
	best := top.best[0]
	// "What is X" about a page named X starts with its opening.
	if (q.Intent == IntentDefine || q.Bare) && named[top.path] >= 0.8 && best.Section != 0 {
		for _, s := range top.best {
			if s.Section == 0 {
				best = s
				break
			}
		}
	}
	content, err := idx.Content(top.path)
	if err != nil {
		return nil, err
	}
	all, err := idx.Page(top.path)
	if err != nil {
		return nil, err
	}

	onPage, missing, err := pageHas(top.path)
	if err != nil {
		return nil, err
	}
	if !(q.FollowUp && top.path == opt.PrevPage) {
		a.Missing = missing
	}
	switch {
	case (best.cover >= 0.75 || named[top.path] >= 0.8) && onPage >= 0.7:
		a.Confidence = "high"
	case (best.cover >= 0.45 || named[top.path] >= 0.8) && onPage >= 0.6:
		a.Confidence = "medium"
	default:
		a.Confidence = "low"
	}
	main := sectionFor(content, all, best.Hit, maxShow, q)
	shown := map[int]bool{best.Section: true}
	from, to := offsetOf(all, best.Hit, true), offsetOf(all, best.Hit, false)
	// A question about what the page as a whole is about ("fix a flat on my
	// honda" -> Changing a flat tire) is answered with the page's steps, not
	// whichever step happened to repeat a word.
	// ("What oil does my honda take" wants a fact, not the oil change.)
	if (q.Intent == IntentHowTo || q.Intent == IntentAny) && !q.FollowUp && !factRe.MatchString(strings.ToLower(q.Text)) && aboutPage(q, best.ID, top.path, pres, inScope) {
		if m, secs, f, t, ok := coreSteps(content, all, maxShow*2, q); ok {
			main, from, to = m, f, t
			for _, n := range secs {
				shown[n] = true
			}
		}
	}
	a.Main = &main

	// The page's warning: in an emergency, for practical questions, or when
	// it opens the page, it comes first.
	// (A follow-up on the same page already showed it, unless it's urgent now.)
	repeat := q.FollowUp && top.path == opt.PrevPage && !q.Urgent
	for _, h := range all {
		if repeat {
			break
		}
		if h.Flags&FlagWarn == 0 || h.Flags&FlagRef != 0 {
			continue
		}
		if h.Start >= from && h.End <= to && !main.Partial {
			break // already in what's shown
		}
		if q.Urgent || practical[q.Intent] || h.Section == 0 || h.Section == best.Section || q.Intent == IntentAny {
			w := Section{Path: top.path, Title: Title(top.path), Heading: h.Heading, Section: h.Section, Markdown: Markdown(content, h.Start, h.End)}
			if w.Markdown != "" && !strings.Contains(main.Markdown, strings.TrimSpace(w.Markdown)) {
				a.Warning = &w
			}
		}
		break
	}

	// More from the same page: other sections that match, best first.
	for _, s := range top.best[1:] {
		if len(a.More) >= 4 {
			break
		}
		if shown[s.Section] || s.cover < 0.3 || s.score < best.score*0.35 {
			continue
		}
		shown[s.Section] = true
		m := sectionFor(content, all, s.Hit, maxMore, q)
		a.More = append(a.More, m)
	}

	// Follow-up chips: the page's other headings, the useful ones first.
	a.Chips = chips(all, shown, top.path)

	// Other pages.
	for _, p := range ranked[1:] {
		if len(a.Related) >= 6 {
			break
		}
		if p.score < top.score*0.3 || p.best[0].cover < 0.3 {
			continue
		}
		c, err := idx.Content(p.path)
		if err != nil {
			return nil, err
		}
		ph, err := idx.Page(p.path)
		if err != nil {
			return nil, err
		}
		a.Related = append(a.Related, sectionFor(c, ph, p.best[0].Hit, maxRelated, q))
	}
	return a, nil
}

// pickSpelling chooses among corrections for term i the one that appears
// most often with the question's other words ("poision ivy" -> poison, not
// Poisson), or the closest if the others don't help.
func pickSpelling(idx Index, q Query, i int, cands []string) string {
	if len(cands) == 0 {
		return ""
	}
	var others []string
	for j, t := range q.Terms {
		if j != i && t.Of < 0 && !strings.Contains(t.Word, " ") {
			others = append(others, match(t.Word))
		}
	}
	if len(others) == 0 || len(cands) == 1 {
		return cands[0]
	}
	// How often a candidate comes with the other words, for how common it
	// is: "purify" is usually near "water", "pursue" seldom is.
	best, bestP := cands[0], 0.0
	for rank, c := range cands {
		all, err := idx.Count(match(c))
		if err != nil || all == 0 {
			continue
		}
		with, err := idx.Count(match(c) + " AND (" + strings.Join(others, " OR ") + ")")
		if err != nil {
			continue
		}
		p := (float64(with) + 0.2) / (float64(all) + 60) / (1 + 0.15*float64(rank)) * math.Log10(float64(all)+10)
		if p > bestP {
			best, bestP = c, p
		}
	}
	return best
}

// showSection answers with a section the user picked.
func showSection(idx Index, a *Answer, q Query, p string, section int) error {
	all, err := idx.Page(p)
	if err != nil {
		return err
	}
	content, err := idx.Content(p)
	if err != nil {
		return err
	}
	for _, h := range all {
		if h.Section == section {
			s := sectionFor(content, all, h, 6000, q)
			a.Main = &s
			a.Confidence = "high"
			a.Chips = chips(all, map[int]bool{section: true}, p)
			return nil
		}
	}
	a.Confidence = "none"
	return nil
}

func intentBonus(q Query, h Hit) float64 {
	b := 0.0
	head := strings.ToLower(h.Trail)
	for _, hint := range headingHints[q.Intent] {
		if head != "" && strings.Contains(head, hint) {
			switch q.Intent {
			case IntentWhenHelp, IntentSigns, IntentPrevent:
				b += 3
			default:
				b += 2
			}
			break
		}
	}
	switch q.Intent {
	case IntentHowTo:
		if h.Flags&FlagSteps != 0 {
			b += 1.2
		}
	case IntentAmount:
		if h.Flags&(FlagNumber|FlagTable) != 0 {
			b += 1.5
		}
		if h.Flags&FlagLead != 0 {
			b += 1
		}
	case IntentDefine:
		if h.Flags&FlagLead != 0 {
			b += 2.5
		}
	case IntentWhenHelp:
		if h.Flags&FlagWarn != 0 {
			b += 2.5
		}
	case IntentSafe:
		if h.Flags&FlagWarn != 0 {
			b += 1.2
		}
	}
	if q.Urgent && h.Flags&FlagWarn != 0 {
		b += 3
	}
	return b
}

// sectionFor is the section a passage is in, shown whole if it's short
// enough, or else the passage and what follows it, up to max bytes.
func sectionFor(content string, all []Hit, h Hit, max int, q Query) Section {
	var parts []Hit
	for _, p := range all {
		if p.Section == h.Section {
			parts = append(parts, p)
		}
	}
	s := Section{Path: h.Path, Title: Title(h.Path), Heading: h.Heading, Section: h.Section, Ref: h.Flags&FlagRef != 0}
	if len(parts) == 0 {
		parts = []Hit{h}
	}
	start, end := parts[0].Start, parts[len(parts)-1].End
	if end-start > max {
		s.Partial = true
		start, end = h.Start, h.End
		// Keep going while it fits; start earlier if the passage is the end.
		for _, p := range parts {
			if p.Start >= end && p.End-start <= max {
				end = p.End
			}
		}
		for i := len(parts) - 1; i >= 0; i-- {
			if p := parts[i]; p.End <= start && end-p.Start <= max {
				start = p.Start
			}
		}
		if start == parts[0].Start && end == parts[len(parts)-1].End {
			s.Partial = false
		}
	}
	s.Markdown = Markdown(content, start, end)
	s.Snippet = snippet(content[min(start, len(content)):min(end, len(content))], q)
	return s
}

func offsetOf(all []Hit, h Hit, first bool) int {
	at := -1
	for _, p := range all {
		if p.Section != h.Section {
			continue
		}
		if first && (at < 0 || p.Start < at) {
			at = p.Start
		}
		if !first && p.End > at {
			at = p.End
		}
	}
	return at
}

var usefulHeads = []string{"see a doctor", "call 911", "emergency", "get help", "what to do", "children", "kids", "babies", "prevention", "prevent", "far from help", "home care", "signs", "symptoms", "treatment", "safety", "warning", "edible", "identification", "how to"}

func chips(all []Hit, shown map[int]bool, p string) []Chip {
	type cand struct {
		c    Chip
		rank int
	}
	var cs []cand
	seen := map[int]bool{}
	for _, h := range all {
		if seen[h.Section] || shown[h.Section] || h.Heading == "" || h.Level > 3 {
			continue
		}
		seen[h.Section] = true
		r := len(usefulHeads)
		low := strings.ToLower(h.Heading)
		for i, u := range usefulHeads {
			if strings.Contains(low, u) {
				r = i
				break
			}
		}
		cs = append(cs, cand{Chip{Label: h.Heading, Path: p, Section: h.Section}, r})
	}
	sort.SliceStable(cs, func(i, j int) bool { return cs[i].rank < cs[j].rank })
	out := []Chip{}
	for i := 0; i < len(cs) && i < 8; i++ {
		out = append(out, cs[i].c)
	}
	return out
}

// snippet is a line or two of plain text around the words asked, with them
// marked \x02…\x03.
func snippet(md string, q Query) string {
	var b strings.Builder
	for _, l := range strings.Split(md, "\n") {
		// A table reads as its cells, without the rule under its header.
		if tableRow.MatchString(l) {
			if isDivider(l) {
				continue
			}
			l = strings.ReplaceAll(strings.Trim(strings.TrimSpace(l), "|"), "|", " · ")
		}
		if t := Plain(l); t != "" {
			b.WriteString(t)
			b.WriteByte(' ')
		}
	}
	text := strings.Join(strings.Fields(b.String()), " ")
	if text == "" {
		return ""
	}
	stems := []string{}
	for _, t := range q.Terms {
		if !strings.Contains(t.Word, " ") {
			stems = append(stems, stemOf(t.Word))
		}
	}
	tokens := splitKeep(text)
	isHit := make([]bool, len(tokens))
	for i, tok := range tokens {
		lw := strings.ToLower(tok)
		for _, s := range stems {
			if len(s) >= 2 && strings.HasPrefix(lw, s) && (len(s) >= 4 || len(lw) <= len(s)+3) {
				isHit[i] = true
				break
			}
		}
	}
	// The window of about 40 words with the most hits.
	const win = 40
	bestAt, bestN := 0, -1
	for i := 0; i < len(tokens); i++ {
		if !isWord(tokens[i]) {
			continue
		}
		n, words := 0, 0
		for j := i; j < len(tokens) && words < win; j++ {
			if isWord(tokens[j]) {
				words++
				if isHit[j] {
					n++
				}
			}
		}
		if n > bestN {
			bestAt, bestN = i, n
		}
		if words < win {
			break
		}
	}
	var out strings.Builder
	if bestAt > 0 {
		out.WriteString("…")
	}
	words := 0
	end := bestAt
	for j := bestAt; j < len(tokens) && words < win; j++ {
		if isWord(tokens[j]) {
			words++
		}
		if isHit[j] {
			out.WriteString("\x02" + tokens[j] + "\x03")
		} else {
			out.WriteString(tokens[j])
		}
		end = j
	}
	if end < len(tokens)-1 {
		out.WriteString("…")
	}
	return out.String()
}

// stemOf trims common endings so "stings" and "stinging" match "sting".
func stemOf(w string) string {
	for _, suf := range []string{"ication", "ation", "ing", "ies", "ied", "es", "ed", "ly", "s", "y", "e"} {
		if strings.HasSuffix(w, suf) && len(w)-len(suf) >= 3 {
			return w[:len(w)-len(suf)]
		}
	}
	return w
}

func splitKeep(s string) []string {
	var out []string
	start := 0
	inWord := false
	for i, r := range s {
		w := unicode.IsLetter(r) || unicode.IsDigit(r) || r == '\''
		if i == 0 {
			inWord = w
			continue
		}
		if w != inWord {
			out = append(out, s[start:i])
			start, inWord = i, w
		}
	}
	return append(out, s[start:])
}

func isWord(t string) bool {
	for _, r := range t {
		return unicode.IsLetter(r) || unicode.IsDigit(r)
	}
	return false
}

// match is the FTS5 expression for a word or phrase: the word itself (the
// index stems it), or for longer words also its first letters, so
// "purify" finds "purification".
func match(w string) string {
	w = strings.ReplaceAll(w, `"`, "")
	q := `"` + w + `"`
	if !strings.Contains(w, " ") {
		// The index stems words its own way ("purification" -> "purif"); a
		// prefix of our rougher stem catches the forms it misses.
		alts := []string{q}
		for _, f := range forms[w] {
			if f != w {
				alts = append(alts, `"`+f+`"`)
			}
		}
		if s := stemOf(w); len([]rune(s)) >= 5 {
			alts = append(alts, `"`+s+`"*`)
		}
		// Forms the index's stemmer keeps apart: fast/fastest, form/formation.
		if n := len([]rune(w)); n >= 3 && n <= 6 && !strings.HasSuffix(w, "e") && !strings.HasSuffix(w, "y") && !strings.HasSuffix(w, "s") {
			alts = append(alts, `"`+w+`er"`, `"`+w+`est"`)
			if n >= 4 {
				alts = append(alts, `"`+w+`ation"`)
			}
		}
		if len(alts) > 1 {
			q = "(" + strings.Join(alts, " OR ") + ")"
		}
	}
	return q
}

// exactMatch is the FTS5 expression for a word in its own forms only.
func exactMatch(w string) string {
	w = strings.ReplaceAll(w, `"`, "")
	if g := forms[w]; g != nil {
		return `("` + strings.Join(g, `" OR "`) + `")`
	}
	return `"` + w + `"`
}

// phraseMatch is the FTS5 expression for a phrase as asked, and as the notes
// would write it with an apostrophe ("athletes foot" for "athlete's foot").
func phraseMatch(ph string) string {
	ph = strings.ReplaceAll(ph, `"`, "")
	alts := []string{`"` + ph + `"`}
	ws := strings.Fields(ph)
	for i, w := range ws {
		if i == len(ws)-1 || len(w) < 4 || !strings.HasSuffix(w, "s") || strings.HasSuffix(w, "ss") {
			continue
		}
		v := append([]string{}, ws...)
		v[i] = strings.TrimSuffix(w, "s") + " s"
		alts = append(alts, `"`+strings.Join(v, " ")+`"`)
	}
	if len(alts) == 1 {
		return alts[0]
	}
	return "(" + strings.Join(alts, " OR ") + ")"
}

// folderCredit is how much of what was asked names the folders a page is in
// ("Accord" for Vehicles/2012 Honda Accord EX/…), from 0 to 1.
func folderCredit(p string, q Query) float64 {
	dir := strings.ToLower(path.Dir(p))
	if dir == "." {
		return 0
	}
	folder := " " + strings.Join(words(dir), " ") + " "
	var got, all float64
	for _, t := range q.Terms {
		if t.Of >= 0 || t.Weight < 1 || strings.Contains(t.Word, " ") {
			continue
		}
		all++
		if strings.Contains(folder, " "+t.Word+" ") || strings.Contains(folder, " "+stemOf(t.Word)) && len(stemOf(t.Word)) >= 4 {
			got++
		}
	}
	if all == 0 {
		return 0
	}
	return got / all
}

// titleFit is how much of a page's title (its words that say something) the
// question has, from 0 to 1.
func titleFit(p string, q Query) float64 {
	switch strings.ToLower(Title(p)) {
	case "start here", "overview", "index", "readme", "faq", "contents", "home":
		return 0 // signposts, not topics
	}
	var n, got float64
	for _, w := range words(strings.ToLower(Title(p))) {
		if stopWords[w] || lightWords[w] || len(w) < 2 {
			continue
		}
		n++
		best := 0.0
		for _, t := range q.Terms {
			if !strings.Contains(t.Word, " ") && nameHas(w, t.Word) {
				// A related word ("outage" for "power") counts for less.
				best = math.Max(best, math.Min(1, t.Weight*1.7))
			}
		}
		got += best
	}
	if n == 0 {
		return 0
	}
	return got / n
}

// presence is which passages have a term: anywhere, in the page title, in the headings.
type presence struct{ any, title, heading, placed, exact map[int64]bool }

// loose is what a word counts for where only a longer word starting the
// same was found.
const loose = 0.75

// aboutPage reports whether everything asked, but for words like "fix", is
// in the page's title or names the folder it's in.
func aboutPage(q Query, id int64, p string, pres []presence, inScope func(int, string) bool) bool {
	n := 0
	for i, t := range q.Terms {
		if t.Of >= 0 || t.Weight < 1 {
			continue
		}
		n++
		if !pres[i].title[id] && !inScope(i, p) {
			return false
		}
	}
	return n > 0
}

var factRe = regexp.MustCompile(`^(what|which|where|when|who|whats|what's|is|are|does|do) `)

var stepHeads = []string{"steps", "step by step", "how to", "instructions", "procedure", "what to do", "method", "directions"}

// coreSteps is a how-to page's steps: the first section headed like steps
// (or numbered), with the sections under it, up to max bytes.
func coreSteps(content string, all []Hit, max int, q Query) (Section, []int, int, int, bool) {
	top := ""
	for _, h := range all {
		first, _, _ := strings.Cut(h.Trail, " › ")
		low := strings.ToLower(first)
		hinted := false
		for _, s := range stepHeads {
			if strings.Contains(low, s) {
				hinted = true
				break
			}
		}
		if first != "" && (hinted || h.Flags&FlagSteps != 0 && h.Flags&FlagRef == 0) {
			top = first
			if hinted {
				break
			}
			// A numbered list under some other heading; keep looking for a
			// "Steps" heading, but use this if there is none.
			for _, g := range all {
				f, _, _ := strings.Cut(g.Trail, " › ")
				for _, s := range stepHeads {
					if f != "" && strings.Contains(strings.ToLower(f), s) {
						top = f
					}
				}
				if top != first {
					break
				}
			}
			break
		}
	}
	if top == "" {
		return Section{}, nil, 0, 0, false
	}
	var in []Hit
	for _, h := range all {
		if h.Trail == top || strings.HasPrefix(h.Trail, top+" › ") {
			in = append(in, h)
		}
	}
	if len(in) == 0 {
		return Section{}, nil, 0, 0, false
	}
	start, end := in[0].Start, in[0].End
	partial := false
	var secs []int
	for _, h := range in {
		if h.End-start > max {
			partial = true
			break
		}
		end = h.End
		if len(secs) == 0 || secs[len(secs)-1] != h.Section {
			secs = append(secs, h.Section)
		}
	}
	// Start at the first sub-heading's line, so its title shows.
	if in[0].Trail != top {
		if i := strings.LastIndex(content[:start], "\n#"); i >= 0 && !strings.Contains(strings.TrimSpace(content[i+1:start]), "\n") {
			start = i + 1
		}
	}
	s := Section{Path: in[0].Path, Title: Title(in[0].Path), Heading: top, Section: in[0].Section, Partial: partial}
	s.Markdown = Markdown(content, start, end)
	s.Snippet = snippet(content[start:end], q)
	return s, secs, start, end, true
}

// scopes maps each asked word that names a few folders to them: "honda"
// names Vehicles/2012 Honda Accord EX, "iphone" both iPhone folders.
// A word in many folders' names ("guides") narrows nothing.
func scopes(idx Index, q Query) (map[int][]string, map[int]bool, map[int]bool, error) {
	out := map[int][]string{}
	byName := map[int]bool{}
	byKind := map[int]bool{}
	folders, err := idx.Folders()
	if err != nil {
		return nil, nil, nil, err
	}
	term := map[string]int{}
	for i, t := range q.Terms {
		if t.Of < 0 && (t.Weight >= 1 || isNumber(t.Word)) {
			term[t.Word] = i
		}
	}
	// Several words that together name a folder ("15 pro", "iphone 15")
	// name that thing, even if each alone is common. A folder named exactly
	// that beats one whose name only has it ("iPhone 15" over "iPhone 15 Pro").
	for _, ph := range q.Phrases {
		ws := strings.Fields(ph)
		if len(ws) < 2 {
			continue
		}
		ok := true
		for _, w := range ws {
			if _, in := term[w]; !in || out[term[w]] != nil {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		var exact, part []string
		for _, f := range folders {
			name := " " + strings.Join(words(strings.ToLower(path.Base(f))), " ") + " "
			switch {
			case name == " "+ph+" ":
				exact = append(exact, f)
			case strings.Contains(name, " "+ph+" "):
				part = append(part, f)
			}
		}
		hit := exact
		if len(hit) == 0 {
			hit = part
		}
		if len(hit) > 0 && len(hit) <= 3 {
			for _, w := range ws {
				out[term[w]] = hit
				byName[term[w]] = true
			}
		}
	}
	for i, t := range q.Terms {
		if out[i] != nil {
			continue
		}
		// A related word may name the folder for the asked one ("car" -> Vehicles).
		at := i
		if t.Of >= 0 {
			at = t.Of
			if q.Terms[at].Weight < 1 || out[at] != nil {
				continue
			}
		} else if t.Weight < 1 && !isNumber(t.Word) {
			continue
		}
		short := len([]rune(t.Word)) < 3 && !(len(t.Word) == 2 && unicode.IsDigit(rune(t.Word[0])))
		if strings.Contains(t.Word, " ") || lightWords[t.Word] || short {
			continue
		}
		var hit []string
		for _, f := range folders {
			// Only the outermost folder named; its sub-folders are in it.
			if len(hit) > 0 && strings.HasPrefix(f, hit[len(hit)-1]+"/") {
				continue
			}
			if nameHas(path.Base(f), t.Word) {
				hit = append(hit, f)
			}
		}
		// No folder has the word, but one is named for a thing of that kind
		// ("laptop" -> MacBook Air, "suv" -> 2015 Honda CR-V).
		if len(hit) == 0 && t.Of < 0 {
			if hit = kindOf(t.Word, folders); len(hit) > 0 && len(hit) <= 3 {
				byKind[at] = true
			}
		}
		if len(hit) > 0 && len(hit) <= 3 {
			out[at] = hit
		}
	}
	return out, byName, byKind, nil
}

// nameHas reports whether a folder or page name has a word, in any form.
func nameHas(name, w string) bool {
	for _, n := range words(strings.ToLower(name)) {
		if sameWord(n, w) {
			return true
		}
	}
	return false
}

func inSpaces(p string, spaces []string) bool {
	if len(spaces) == 0 {
		return true
	}
	for _, s := range spaces {
		if strings.HasPrefix(p, s+"/") {
			return true
		}
	}
	return false
}

// Title is a page's name from its path.
func Title(p string) string {
	return strings.TrimSuffix(path.Base(p), ".md")
}
