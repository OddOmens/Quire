package store

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/oddomens/quire/internal/ask"
	"github.com/oddomens/quire/internal/vault"
)

// Passages are pages cut into sections and parts for answering questions
// (package ask). The text isn't stored twice: passage_fts is contentless and
// the passages table keeps byte offsets into the page as indexed in fts.

var wikiAlias = vault.WikiLinkPattern()

// putPassages indexes a page's passages and the labels its links use.
func putPassages(tx *sql.Tx, doc int64, path, title, content string) error {
	if _, err := tx.Exec(`INSERT OR REPLACE INTO passage_pages (path, doc) VALUES (?,?)`, path, doc); err != nil {
		return err
	}
	for _, p := range ask.Split(content) {
		res, err := tx.Exec(`INSERT INTO passages (path, section, part, heading, trail, level, start, stop, flags, words) VALUES (?,?,?,?,?,?,?,?,?,?)`,
			path, p.Section, p.Part, p.Heading, p.Trail, p.Level, p.Start, p.End, p.Flags, len(strings.Fields(p.Text)))
		if err != nil {
			return err
		}
		id, err := res.LastInsertId()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO passage_fts (rowid, title, heading, body) VALUES (?,?,?,?)`, id, title, p.Trail, p.Text); err != nil {
			return err
		}
	}
	seen := map[string]bool{}
	for _, m := range wikiAlias.FindAllStringSubmatch(vault.StripFrontmatter(content), -1) {
		if m[1] == "!" || m[4] == "" {
			continue
		}
		label := normLabel(strings.TrimPrefix(strings.TrimPrefix(m[4], `\`), "|"))
		target := strings.TrimSpace(m[2])
		if label == "" || utf8.RuneCountInString(label) > 60 || seen[label+"\x00"+target] {
			continue
		}
		seen[label+"\x00"+target] = true
		if _, err := tx.Exec(`INSERT INTO aliases (src, label, target) VALUES (?,?,?)`, path, label, target); err != nil {
			return err
		}
	}
	return nil
}

func deletePassages(tx *sql.Tx, path string) error {
	for _, q := range []string{
		`DELETE FROM passage_fts WHERE rowid IN (SELECT id FROM passages WHERE path = ?)`,
		`DELETE FROM passages WHERE path = ?`,
		`DELETE FROM aliases WHERE src = ?`,
		`DELETE FROM passage_pages WHERE path = ?`,
	} {
		if _, err := tx.Exec(q, path); err != nil {
			return err
		}
	}
	return nil
}

func normLabel(s string) string {
	return strings.Join(strings.Fields(strings.ToLower(s)), " ")
}

// AskIndex is the passage index for package ask.
func (s *Store) AskIndex() (ask.Index, error) {
	r, err := s.Resolver()
	if err != nil {
		return nil, err
	}
	return &askIndex{s: s, r: r, matches: map[string]map[int64]bool{}}, nil
}

// askIndex serves one question; it remembers what each search expression
// matched, since a question asks about the same words several times.
type askIndex struct {
	s       *Store
	r       *Resolver
	matches map[string]map[int64]bool
}

// matching is every passage an FTS5 expression matches.
func (x *askIndex) matching(match string) (map[int64]bool, error) {
	if m, ok := x.matches[match]; ok {
		return m, nil
	}
	rows, err := x.s.db.Query(`SELECT rowid FROM passage_fts WHERE passage_fts MATCH ?`, match)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := map[int64]bool{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		m[id] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	x.matches[match] = m
	return m, nil
}

const hitCols = `p.id, p.path, p.section, p.part, p.heading, p.trail, p.level, p.start, p.stop, p.flags, p.words`

func scanHits(rows *sql.Rows, withRank bool) ([]ask.Hit, error) {
	defer rows.Close()
	var out []ask.Hit
	for rows.Next() {
		var h ask.Hit
		dest := []any{&h.ID, &h.Path, &h.Section, &h.Part, &h.Heading, &h.Trail, &h.Level, &h.Start, &h.End, &h.Flags, &h.Words}
		if withRank {
			dest = append(dest, &h.BM25)
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

func (x *askIndex) Search(match string, spaces []string, limit int) ([]ask.Hit, error) {
	q := `SELECT ` + hitCols + `, bm25(passage_fts, 6.0, 3.0, 1.0) AS rank
		FROM passage_fts JOIN passages p ON p.id = passage_fts.rowid WHERE passage_fts MATCH ?`
	args := []any{match}
	if len(spaces) > 0 {
		var ors []string
		for _, sp := range spaces {
			ors = append(ors, `p.path LIKE ? ESCAPE '\'`)
			args = append(args, escapeLike(sp)+"/%")
		}
		q += ` AND (` + strings.Join(ors, " OR ") + `)`
	}
	q += ` ORDER BY rank LIMIT ?`
	args = append(args, limit)
	rows, err := x.s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	return scanHits(rows, true)
}

func (x *askIndex) Count(match string) (int, error) {
	m, err := x.matching(match)
	return len(m), err
}

func (x *askIndex) Total() (int, error) {
	var n int
	err := x.s.db.QueryRow(`SELECT count(*) FROM passages`).Scan(&n)
	return n, err
}

func (x *askIndex) Within(match string, ids []int64, column string) (map[int64]bool, error) {
	if column == "title" || column == "heading" {
		match = column + " : (" + match + ")"
	}
	all, err := x.matching(match)
	if err != nil {
		return nil, err
	}
	out := map[int64]bool{}
	for _, id := range ids {
		if all[id] {
			out[id] = true
		}
	}
	return out, nil
}

func (x *askIndex) Page(path string) ([]ask.Hit, error) {
	rows, err := x.s.db.Query(`SELECT `+hitCols+` FROM passages p WHERE p.path = ? ORDER BY p.section, p.part`, path)
	if err != nil {
		return nil, err
	}
	return scanHits(rows, false)
}

func (x *askIndex) Folders() ([]string, error) {
	rows, err := x.s.db.Query(`SELECT path FROM passage_pages`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seen := map[string]bool{}
	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		for d := pathDir(p); d != "" && !seen[d]; d = pathDir(d) {
			seen[d] = true
			out = append(out, d)
		}
	}
	sort.Strings(out)
	return out, rows.Err()
}

func pathDir(p string) string {
	if i := strings.LastIndexByte(p, '/'); i > 0 {
		return p[:i]
	}
	return ""
}

func (x *askIndex) Content(path string) (string, error) {
	var body string
	err := x.s.db.QueryRow(`SELECT body FROM fts WHERE rowid = (SELECT doc FROM passage_pages WHERE path = ?)`, path).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return body, err
}

// Named finds the pages a question names: by title (strongest), or by a label
// links to the page use ("cottonmouth" for Agkistrodon piscivorus). Single
// common words count for less than names of two or more words.
func (x *askIndex) Named(phrases, labels []string) (map[string]float64, error) {
	out := map[string]float64{}
	if len(phrases) == 0 {
		return out, nil
	}
	want := map[string]int{} // variant -> words in the phrase
	for _, p := range phrases {
		n := len(strings.Fields(p))
		for _, v := range variants(p) {
			if _, ok := want[v]; !ok {
				want[v] = n
			}
		}
	}
	strength := func(base float64, words int) float64 {
		switch {
		case words >= 3:
			return base
		case words == 2:
			return base * 0.9
		}
		return base * 0.4
	}
	for v, n := range want {
		for _, p := range x.r.byTitle[v] {
			if s := strength(1, n); s > out[p] {
				out[p] = s
			}
		}
	}
	// A name of two or more words inside a longer title ("tire pressure" in
	// "Tire pressure and TPMS", "first aid kit" in "Home first-aid kit").
	var inner []string
	thin := map[string]bool{}
	for _, p := range phrases {
		w := strings.Fields(p)
		content := 0
		for _, x := range w {
			if !ask.IsStopWord(x) {
				content++
			}
		}
		// "first aid kit", or "won't turn on": stop words at the ends only
		// in a longer name with something else in it.
		if len(w) >= 2 && (!ask.IsStopWord(w[0]) && !ask.IsStopWord(w[len(w)-1]) || len(w) >= 3 && content >= 1) {
			inner = append(inner, " "+p+" ")
			if content < 2 {
				thin[" "+p+" "] = true
			}
		}
	}
	if len(inner) > 0 {
		for t, paths := range x.r.byTitle {
			norm := " " + strings.Join(strings.Fields(strings.NewReplacer("-", " ", ",", " ", ":", " ", "(", " ", ")", " ").Replace(t)), " ") + " "
			says := 0 // the title's words that say something
			for _, w := range strings.Fields(norm) {
				if !ask.IsStopWord(w) {
					says++
				}
			}
			for _, ph := range inner {
				// One real word among small ones ("on the trail") names a
				// title only if it's half of what the title says ("Won't turn
				// on or charge", not "Foot care on the trail").
				if thin[ph] && says > 2 {
					continue
				}
				if strings.Contains(norm, ph) && norm != ph {
					// More for longer names, and for covering more of the title.
					n := len(strings.Fields(ph))
					s := min(0.95, 0.45+0.15*float64(n)+0.15*float64(n)/float64(len(strings.Fields(norm))))
					for _, p := range paths {
						if s > out[p] {
							out[p] = s
						}
					}
				}
			}
		}
	}
	byLabel := map[string]int{}
	for _, l := range labels {
		for _, v := range variants(l) {
			byLabel[v] = len(strings.Fields(l))
		}
	}
	if len(byLabel) == 0 {
		return out, nil
	}
	keys := make([]any, 0, len(byLabel))
	marks := make([]string, 0, len(byLabel))
	for v := range byLabel {
		keys = append(keys, v)
		marks = append(marks, "?")
	}
	rows, err := x.s.db.Query(`SELECT label, target, src FROM aliases WHERE label IN (`+strings.Join(marks, ",")+`)`, keys...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var label, target, src string
		if err := rows.Scan(&label, &target, &src); err != nil {
			return nil, err
		}
		if p := x.r.Resolve(target, src); p != "" {
			if s := strength(0.8, byLabel[label]); s > out[p] {
				out[p] = s
			}
		}
	}
	return out, rows.Err()
}

// variants of a phrase: as asked, and with its last word made singular.
func variants(p string) []string {
	out := []string{p}
	words := strings.Fields(p)
	last := words[len(words)-1]
	stem := func(w string) string {
		return strings.Join(append(append([]string{}, words[:len(words)-1]...), w), " ")
	}
	switch {
	case strings.HasSuffix(last, "ies") && len(last) > 4:
		out = append(out, stem(last[:len(last)-3]+"y"))
	case strings.HasSuffix(last, "es") && len(last) > 4:
		out = append(out, stem(last[:len(last)-2]), stem(last[:len(last)-1]))
	case strings.HasSuffix(last, "s") && !strings.HasSuffix(last, "ss") && len(last) > 3:
		out = append(out, stem(last[:len(last)-1]))
	}
	return out
}

// spelling is the vocabulary for spelling suggestions.
type spelling struct {
	sync.Mutex
	loaded  time.Time
	reading bool
	terms   map[byte][]vocabTerm // by first letter
}

type vocabTerm struct {
	term string
	docs int
}

// spellingWords is the vocabulary by first letter. The first use reads it;
// after that an old copy is used while a new one is read in the background,
// so no search waits for it again.
func (s *Store) spellingWords() map[byte][]vocabTerm {
	read := func() map[byte][]vocabTerm {
		terms := map[byte][]vocabTerm{}
		rows, err := s.db.Query(`SELECT term, doc FROM passage_vocab WHERE doc >= 2`)
		if err != nil {
			return nil
		}
		defer rows.Close()
		for rows.Next() {
			var t vocabTerm
			if rows.Scan(&t.term, &t.docs) == nil && t.term != "" {
				terms[t.term[0]] = append(terms[t.term[0]], t)
			}
		}
		return terms
	}
	v := &s.spell
	v.Lock()
	defer v.Unlock()
	switch {
	case v.terms == nil:
		v.terms, v.loaded = read(), time.Now()
	case time.Since(v.loaded) > time.Hour && !v.reading:
		v.reading = true
		go func() {
			terms := read()
			v.Lock()
			if terms != nil {
				v.terms, v.loaded = terms, time.Now()
			}
			v.reading = false
			v.Unlock()
		}()
	}
	return v.terms
}

// WarmSpelling reads the spelling vocabulary ahead of the first misspelled
// search, which would otherwise wait a second or two for it.
func (s *Store) WarmSpelling() { s.spellingWords() }

// Suggest lists indexed words close to a misspelled one, closest first, as
// words found in the pages (not the index's stems).
func (x *askIndex) Suggest(word string) []string {
	if utf8.RuneCountInString(word) < 4 {
		return nil
	}
	cands := x.s.spellingWords()[word[0]]

	limit := 1
	if utf8.RuneCountInString(word) >= 5 {
		limit = 2
	}
	type cand struct {
		term         string
		d, off, docs int
	}
	var found []cand
	for _, t := range cands {
		if d := len(t.term) - len(word); d > limit+2 || d < -limit-2 {
			continue
		}
		// The index keeps stems ("hypotherm…"): compare the word with the
		// stem and with the stem's length of the word.
		d := osa(word, t.term, limit)
		if len(t.term) >= 5 && len(t.term) < len(word) && len(word)-len(t.term) <= 2 {
			if d2 := osa(word[:len(t.term)], t.term, limit); d2+1 < d {
				d = d2 + 1
			}
		}
		if d > limit {
			continue
		}
		// A dropped letter is the commonest slip: prefer words one longer.
		off := len(t.term) - len(word) - 1
		if off < 0 {
			off = -off
		}
		found = append(found, cand{t.term, d, off, t.docs})
	}
	sort.Slice(found, func(i, j int) bool {
		a, b := found[i], found[j]
		if a.d != b.d {
			return a.d < b.d
		}
		if a.off != b.off {
			return a.off < b.off
		}
		return a.docs > b.docs
	})
	var out []string
	seen := map[string]bool{}
	for _, c := range found {
		if len(out) == 6 {
			break
		}
		if w := x.surface(c.term); w != "" && !seen[w] {
			seen[w] = true
			out = append(out, w)
		}
	}
	return out
}

// surface is the shortest word in the pages the index stems to term.
func (x *askIndex) surface(term string) string {
	rows, err := x.s.db.Query(`SELECT snippet(fts, 2, char(2), char(3), '', 1) FROM fts WHERE fts MATCH ? LIMIT 8`, `"`+term+`"`)
	if err != nil {
		return ""
	}
	defer rows.Close()
	best := ""
	for rows.Next() {
		var snip string
		if rows.Scan(&snip) != nil {
			continue
		}
		if i := strings.IndexByte(snip, 2); i >= 0 {
			if j := strings.IndexByte(snip[i:], 3); j > 0 {
				w := strings.ToLower(snip[i+1 : i+j])
				if best == "" || len(w) < len(best) {
					best = w
				}
			}
		}
	}
	return best
}

// osa is the optimal string alignment distance (edits, with swapped
// neighbours counting once), giving up past max.
func osa(a, b string, max int) int {
	ra, rb := []rune(a), []rune(b)
	if d := len(ra) - len(rb); d > max || -d > max {
		return max + 1
	}
	prev2 := make([]int, len(rb)+1)
	prev := make([]int, len(rb)+1)
	cur := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur[0] = i
		rowMin := cur[0]
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
			if i > 1 && j > 1 && ra[i-1] == rb[j-2] && ra[i-2] == rb[j-1] {
				cur[j] = min(cur[j], prev2[j-2]+1)
			}
			rowMin = min(rowMin, cur[j])
		}
		if rowMin > max {
			return max + 1
		}
		prev2, prev, cur = prev, cur, prev2
	}
	return prev[len(rb)]
}

// AskHeading is a section heading and its page's title.
type AskHeading struct {
	Heading string
	Title   string
}

// AskHeadings lists the headings of pages that aren't reference material
// (no source: URL), for suggesting questions. spaces narrows them.
func (s *Store) AskHeadings(spaces []string) ([]AskHeading, error) {
	q := `SELECT DISTINCT heading, path FROM passages WHERE part = 0 AND heading <> '' AND flags & ? = 0`
	args := []any{ask.FlagRef}
	if len(spaces) > 0 {
		var ors []string
		for _, sp := range spaces {
			ors = append(ors, `path LIKE ? ESCAPE '\'`)
			args = append(args, escapeLike(sp)+"/%")
		}
		q += ` AND (` + strings.Join(ors, " OR ") + `)`
	}
	rows, err := s.db.Query(q+` LIMIT 20000`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AskHeading
	for rows.Next() {
		var h, p string
		if err := rows.Scan(&h, &p); err != nil {
			return nil, err
		}
		out = append(out, AskHeading{Heading: h, Title: vault.Title(p)})
	}
	return out, rows.Err()
}

// PassageProgress is how many pages have passages, out of all pages.
func (s *Store) PassageProgress() (done, total int, err error) {
	err = s.db.QueryRow(`SELECT (SELECT count(*) FROM passage_pages), (SELECT count(*) FROM notes)`).Scan(&done, &total)
	return done, total, err
}

// FillPassages adds passages for pages indexed before they existed, a few
// pages at a time with pauses between, so the server stays responsive. It
// returns when every page has them or ctx ends.
func (s *Store) FillPassages(ctx context.Context, log *slog.Logger) {
	start := time.Now()
	filled := 0
	for _, refs := range []bool{false, true} {
		var after int64
		for ctx.Err() == nil {
			n, last, err := s.fillBatch(after, 25, refs)
			if err != nil {
				log.Warn("ask index: fill passages", "err", err)
				return
			}
			if last == 0 {
				break
			}
			filled += n
			after = last
			select {
			case <-ctx.Done():
			case <-time.After(15 * time.Millisecond):
			}
		}
	}
	if filled > 0 {
		log.Info("ask index: read every page", "pages", filled, "took", time.Since(start).Round(time.Second))
	}
}

// fillBatch gives passages to up to limit pages after fts rowid after that
// don't have them, returning how many it did and the last rowid looked at
// (0 when there are no more).
func (s *Store) fillBatch(after int64, limit int, refs bool) (int, int64, error) {
	type doc struct {
		id                int64
		path, title, body string
	}
	// Pages without a source: line (people's own notes) go first; reference
	// pages copied from elsewhere follow.
	rows, err := s.db.Query(`SELECT f.rowid, f.path, f.title, f.body FROM fts f
		WHERE f.rowid > ? AND f.path NOT IN (SELECT path FROM passage_pages)
		AND (? OR f.body NOT LIKE '---%source:%')
		ORDER BY f.rowid LIMIT ?`, after, refs, limit)
	if err != nil {
		return 0, 0, err
	}
	var docs []doc
	for rows.Next() {
		var d doc
		if err := rows.Scan(&d.id, &d.path, &d.title, &d.body); err != nil {
			rows.Close()
			return 0, 0, err
		}
		docs = append(docs, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}
	if len(docs) == 0 {
		return 0, 0, nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()
	n := 0
	for _, d := range docs {
		// The page may have been saved since: then it has passages already,
		// or this text is gone.
		var current int
		if err := tx.QueryRow(`SELECT (SELECT count(*) FROM fts WHERE rowid = ? AND path = ?) - (SELECT count(*) FROM passage_pages WHERE path = ?)`, d.id, d.path, d.path).Scan(&current); err != nil {
			return 0, 0, err
		}
		if current != 1 {
			continue
		}
		if err := putPassages(tx, d.id, d.path, d.title, d.body); err != nil {
			return 0, 0, err
		}
		n++
	}
	return n, docs[len(docs)-1].id, tx.Commit()
}
