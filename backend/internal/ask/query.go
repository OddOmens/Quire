package ask

import (
	"regexp"
	"strings"
	"unicode"
)

// Term is one thing to look for.
type Term struct {
	Word   string  // as asked (or as corrected), lower case; may be two words for a related phrase
	Weight float64 // 1 for words asked, less for related words and earlier questions
	Of     int     // for a related word, the index of the asked term it stands in for; -1 otherwise
}

// Query is a question taken apart.
type Query struct {
	Text     string
	Prev     string // the question before, for follow-ups
	Terms    []Term
	Phrases  []string // runs of 1-5 words, to spot page names and link labels
	Intent   Intent
	Urgent   bool
	FollowUp bool
	Compare  []string // the two things compared, for IntentCompare
	Bare     bool     // just a few words, no question ("bee sting")
	Personal bool     // about the asker's own situation ("my", "I")
}

var (
	wordRe       = regexp.MustCompile(`[\p{L}\p{N}][\p{L}\p{N}'’-]*`)
	compareRe    = []*regexp.Regexp{regexp.MustCompile(`difference(?:s)? between (?:an? |the )?(.+?) and (?:an? |the )?(.+?)[?.!]*$`), regexp.MustCompile(`^(?:compare )?(?:an? |the )?(.+?) (?:vs\.?|versus|compared to|compared with) (?:an? |the )?(.+?)[?.!]*$`), regexp.MustCompile(`^compare (?:an? |the )?(.+?) (?:and|with|to) (?:an? |the )?(.+?)[?.!]*$`), regexp.MustCompile(`^is (?:an? |the )?(.+?) the same as (?:an? |the )?(.+?)[?.!]*$`)}
	whenHelpRe   = regexp.MustCompile(`\bwhen (should|do|to|must|would|is it time to|does) .*\b(doctor|er|hospital|911|urgent care|help|worry|seek|emergency|vet|call)\b|\b(should|do|must) (i|we|they|he|she) (go to|see|call|visit|take (him|her|them|it) to) (a |the )?(doctor|er|hospital|911|urgent care|vet|emergency)|\bis (it|this|that) (an? )?(emergency|serious)\b|\bwhen to worry\b|\bhow serious\b|\bneed (a |to see a )?(doctor|stitches|er)\b`)
	signsRe      = regexp.MustCompile(`\b(signs?|symptoms?|warning signs)\b|\bhow (do|can|would|will) (i|you|we) (know|tell|recognize|spot|identify)\b|\bwhat does .* look like\b|\bidentify\b|\bis (this|it) (a |an )?\w+ (bite|rash|sting)\b`)
	safeRe       = regexp.MustCompile(`\b(can|could|should|may) (i|you|we|my \w+|people|dogs?|kids?|children) (eat|drink|touch|forage|cook)\b|\bis (it|this|that|\w+( \w+)?) (safe|edible|poisonous|toxic|dangerous|deadly)\b|\b(edible|poisonous|toxic)\b|\bsafe to (eat|drink|touch)\b|\bokay to eat\b`)
	amountRe     = regexp.MustCompile(`^how (much|many|long|far|often|big|tall|deep|old|hot|cold|fast|heavy|large|small|warm|soon)\b|\bhow (much|many|long|often|soon)\b|\b(what temp|what temperature|what size|what amount|dose|dosage)\b|^(what|which) (size|type|kind|brand|grade|weight|oil|bulb|tires?|battery|fuse|filter|wipers?|plugs?|coolant|fluid|part)\b\b`)
	preventRe    = regexp.MustCompile(`\b(prevent|prevention|avoid|avoiding|keep .+ (away|out|off)|protect|protection|repel|deter)\b`)
	howToRe      = regexp.MustCompile(`^how (do|can|should|to|would|does one)\b|\bhow (do|can|should) (i|we|you)\b|\bhow to\b|\bsteps?\b|\bwhat (should|do|can) (i|we) do\b|\bget rid of\b|\bwhat now\b|^(make|build|start|fix|treat|stop|clean|cook|store|plant|grow|tie|light|purify|filter|repair|replace|remove|install)\b|\bbest way to\b|\bway to\b|\bwhat to do\b`)
	whereRe      = regexp.MustCompile(`^where\b|\bwhere (do|does|can|is|are|to)\b`)
	whyRe        = regexp.MustCompile(`^why\b|\bwhy (do|does|is|are|did)\b|\bwhat causes\b|\bhow (does|do|did) .+ (work|form|happen|grow|evolve)\b`)
	defineRe     = regexp.MustCompile(`^(what|who) (is|are|was|were)( an?| the)? \b|\btell me about\b|^define\b|\bwhat does .+ mean\b|^(describe|explain)\b|\bwhat kind of\b`)
	canVerbRe    = regexp.MustCompile(`\b(how (do|to|should|can) (i|we|you) |how to |to |i want to |want to |i'd like to )can\b|\bcan(ned|ning)? (tomatoes|beans|peaches|pickles|jam|vegetables|fruit|salsa|soup|meat|chicken|corn|applesauce|green beans)\b`)
	followUpRe   = regexp.MustCompile(`^(and|also|but|so|then|ok|okay|what about|how about|what if|and if|what else|anything else|is it|is that|are they|does it|do they|can it|can they|should i|how long does it|how often|why is that|what happens if|more)\b`)
	pronounRe    = regexp.MustCompile(`\b(it|its|it's|they|them|their|this|that|those|these|he|she|him|her)\b`)
	howWordRe    = regexp.MustCompile(`\bhow (much|many|long|far|often|big|tall|deep|old|soon)\b`)
	personalRe   = regexp.MustCompile(`\b(i|i'm|i've|my|me|we|we're|our|us|mine)\b`)
	apostropheRe = strings.NewReplacer("’", "'", "‘", "'", "“", `"`, "”", `"`)
)

// Analyze takes a question apart. prev is the question before it, if any, so
// a short follow-up ("what about kids?") keeps the earlier topic.
func Analyze(text, prev string) Query {
	q := Query{Text: strings.TrimSpace(text), Prev: prev}
	low := plainAsk(unshortened(strings.ToLower(apostropheRe.Replace(q.Text))))

	q.Intent = intentOf(low)
	q.Personal = personalRe.MatchString(low)
	// A bare name may be asking what it is ("dandelion") or about what
	// happened ("bee sting"): Ask decides once it knows what the words name.
	if q.Intent == IntentDefine && !defineRe.MatchString(low) {
		q.Bare = true
		q.Intent = IntentAny
	}
	for _, p := range urgentPhrases {
		if strings.Contains(low, p) {
			q.Urgent = true
			break
		}
	}
	// "Someone is choking": an emergency stated, not a question, wants what to do.
	if q.Urgent && (q.Intent == IntentDefine || q.Intent == IntentAny) {
		q.Intent = IntentHowTo
	}
	if q.Intent == IntentCompare {
		for _, re := range compareRe {
			if m := re.FindStringSubmatch(low); m != nil {
				q.Compare = []string{strings.TrimSpace(m[1]), strings.TrimSpace(m[2])}
				break
			}
		}
	}

	// Search with the notes' words for everyday ones.
	said := low
	demoted := map[string]bool{} // words asked that the notes' words stand in for
	for _, e := range everyday {
		low = e.re.ReplaceAllStringFunc(low, func(m string) string {
			for _, w := range words(m) {
				if !strings.Contains(" "+e.with+" ", " "+w+" ") {
					demoted[w] = true
				}
			}
			return m + " " + e.with
		})
	}
	tokens := words(low)
	// "how long", "how much": the second word is part of the question.
	skip := map[int]bool{}
	for _, m := range howWordRe.FindAllStringIndex(low, -1) {
		before := len(words(low[:m[0]]))
		skip[before+1] = true
	}
	for i, w := range tokens {
		if skip[i] || stopWords[w] || (len([]rune(w)) < 2 && !unicode.IsDigit([]rune(w)[0])) {
			continue
		}
		if lightWords[w] || demoted[w] {
			q.add(w, 0.4, -1)
		} else if isNumber(w) {
			// "a fever of 102": the number is a detail, the fever the topic.
			q.add(w, 0.6, -1)
		} else if isTrouble(w) {
			// What happened is what the question is about ("burned my hand
			// on the stove" is about the burn), more than where or to what.
			q.add(w, 1.5, -1)
		} else {
			q.add(w, 1, -1)
		}
	}
	if canVerbRe.MatchString(low) {
		q.add("canning", 1, -1)
	}
	// Something that happened ("bee sting", "burned my hand") wants what
	// to do, as much as "how do I" would.
	if q.Intent == IntentAny {
		for _, w := range tokens {
			if isTrouble(w) {
				q.Intent = IntentHowTo
				break
			}
		}
	}
	q.Phrases = phrases(words(said))
	for _, w := range words(low) {
		if !strings.Contains(" "+said+" ", " "+w+" ") && !stopWords[w] {
			q.Phrases = append(q.Phrases, w)
		}
	}
	q.addSynonyms(low)

	if prev != "" {
		asked := 0
		for _, t := range q.Terms {
			if t.Of < 0 {
				asked++
			}
		}
		short := asked <= 1 || (asked <= 3 && pronounRe.MatchString(low))
		if followUpRe.MatchString(low) || short {
			q.FollowUp = true
			p := Analyze(prev, "")
			for _, t := range p.Terms {
				if t.Of < 0 {
					q.add(t.Word, 0.6, -1)
				}
			}
			if q.Intent == IntentAny {
				q.Intent = p.Intent
			}
		}
	}
	return q
}

var (
	politeStart = regexp.MustCompile(`^\s*((hi|hello|hey)[,!.]?\s+)?((can|could|would|will) you (please )?(help me|tell me|show me|explain)( how)?( to| with| about)?|please (help me|tell me|show me)( how)?( to| with| about)?|help me( to| with)?|i need help( with)?|i want to know( how to)?|i need to know( how to)?|do you know( how to)?)\s+`)
	sawRe       = regexp.MustCompile(`\b(i|we|he|she|they|just|kids?) saw\b|\bsaw (an?|the|some|two|three|several|what)\b`)
)

// plainAsk drops what isn't part of the question: a polite start ("can you
// help me fix a flat" is "fix a flat") and "saw" where it means seen, not
// the tool ("saw a bear").
func plainAsk(low string) string {
	if p := strings.TrimSpace(politeStart.ReplaceAllString(low, "")); p != "" {
		low = p
	}
	return sawRe.ReplaceAllStringFunc(low, func(m string) string {
		return strings.TrimSpace(strings.Replace(" "+m+" ", " saw ", " ", 1))
	})
}

// isTrouble reports whether a word, in any of its forms, is something that
// happens to people and things.
func isTrouble(w string) bool {
	if troubleWords[w] {
		return true
	}
	for _, f := range forms[w] {
		if troubleWords[f] {
			return true
		}
	}
	return false
}

func intentOf(low string) Intent {
	for _, re := range compareRe {
		if re.MatchString(low) {
			return IntentCompare
		}
	}
	switch {
	case whenHelpRe.MatchString(low):
		return IntentWhenHelp
	case safeRe.MatchString(low):
		return IntentSafe
	case signsRe.MatchString(low):
		return IntentSigns
	case preventRe.MatchString(low):
		return IntentPrevent
	case amountRe.MatchString(low):
		return IntentAmount
	case whyRe.MatchString(low):
		return IntentWhy
	case whereRe.MatchString(low):
		return IntentWhere
	case howToRe.MatchString(low):
		return IntentHowTo
	case defineRe.MatchString(low):
		return IntentDefine
	}
	// A bare name ("black widow", "dandelion") is asking what it is.
	content := 0
	for _, w := range words(low) {
		if !stopWords[w] {
			content++
		}
	}
	if content > 0 && content <= 3 && !strings.ContainsAny(low, "?") {
		return IntentDefine
	}
	return IntentAny
}

func (q *Query) add(w string, weight float64, of int) {
	w = strings.Trim(w, "'-")
	if w == "" {
		return
	}
	for i, t := range q.Terms {
		if t.Word == w {
			if weight > t.Weight {
				q.Terms[i].Weight, q.Terms[i].Of = weight, of
			}
			return
		}
	}
	q.Terms = append(q.Terms, Term{Word: w, Weight: weight, Of: of})
}

// addSynonyms adds related words for the words and two-word phrases asked.
func (q *Query) addSynonyms(low string) {
	n := len(q.Terms)
	for i := 0; i < n; i++ {
		for _, s := range synonyms[q.Terms[i].Word] {
			q.add(s, 0.35, i)
		}
	}
	for phrase, alts := range synonyms {
		if strings.Contains(phrase, " ") && strings.Contains(" "+low+" ", " "+phrase+" ") {
			q.add(phrase, 1, -1)
			at := len(q.Terms) - 1
			for _, s := range alts {
				q.add(s, 0.35, at)
			}
		}
	}
}

func words(s string) []string {
	var out []string
	for _, w := range wordRe.FindAllString(s, -1) {
		w = strings.TrimSuffix(strings.TrimSuffix(w, "'s"), "'")
		if w != "" {
			out = append(out, w)
		}
	}
	return out
}

// phrases are the runs of 1 to 5 words that could name a page, longest first.
// A single word counts only when it isn't a stop word.
func phrases(tokens []string) []string {
	seen := map[string]bool{}
	var out []string
	for n := 5; n >= 1; n-- {
		for i := 0; i+n <= len(tokens); i++ {
			run := tokens[i : i+n]
			// Single stop words name nothing; longer runs may ("won't turn on").
			if n == 1 && stopWords[run[0]] {
				continue
			}
			p := strings.Join(run, " ")
			if !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
	}
	return out
}

// shortened are contractions typed without the apostrophe.
var shortened = func() map[string]string {
	m := map[string]string{}
	for _, w := range strings.Fields(`won't can't don't didn't doesn't isn't wasn't aren't weren't shouldn't couldn't wouldn't hasn't haven't hadn't i'm i've i'll i'd you're they're we're what's how's where's that's there's who's let's it's ain't`) {
		m[strings.ReplaceAll(w, "'", "")] = w
	}
	delete(m, "its") // a word as it is
	delete(m, "well")
	delete(m, "ill")
	delete(m, "wed")
	delete(m, "id")
	delete(m, "lets")
	return m
}()

var plainWordRe = regexp.MustCompile(`[a-z]+`)

// unshortened puts the apostrophe back: "wont" is "won't", not a misspelling.
func unshortened(s string) string {
	return plainWordRe.ReplaceAllStringFunc(s, func(w string) string {
		if r, ok := shortened[w]; ok {
			return r
		}
		return w
	})
}

func isNumber(w string) bool {
	for _, r := range w {
		if !unicode.IsDigit(r) && r != '.' {
			return false
		}
	}
	return w != ""
}
