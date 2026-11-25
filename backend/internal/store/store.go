// Package store is Quire's SQLite database: a rebuildable index of the notes
// (metadata, links, tags, full-text search) plus sign-in sessions. The
// Markdown files stay the source of truth; deleting the index loses nothing.
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode"

	"github.com/oddomens/quire/internal/vault"
	_ "modernc.org/sqlite"
)

var ErrNotFound = errors.New("not found")

// migrations run in order; PRAGMA user_version records how many have run.
// The notes, links, tags and fts tables are an index of the files and can be
// rebuilt; account, sessions, revisions and shares are not.
var migrations = []string{`
CREATE TABLE notes (
	path    TEXT PRIMARY KEY,
	title   TEXT NOT NULL,
	folder  TEXT NOT NULL,
	mtime   INTEGER NOT NULL,
	size    INTEGER NOT NULL,
	rev     TEXT NOT NULL,
	words   INTEGER NOT NULL,
	excerpt TEXT NOT NULL
);
CREATE TABLE links (
	src     TEXT NOT NULL,
	key     TEXT NOT NULL,
	target  TEXT NOT NULL,
	context TEXT NOT NULL,
	PRIMARY KEY (src, key)
);
CREATE INDEX links_key ON links(key);
CREATE TABLE tags (
	path TEXT NOT NULL,
	tag  TEXT NOT NULL,
	PRIMARY KEY (path, tag)
);
CREATE INDEX tags_tag ON tags(tag);
CREATE VIRTUAL TABLE fts USING fts5(path UNINDEXED, title, body, tokenize = 'porter unicode61');

CREATE TABLE account (
	id            INTEGER PRIMARY KEY CHECK (id = 1),
	name          TEXT NOT NULL,
	password_hash TEXT NOT NULL,
	totp_secret   TEXT NOT NULL DEFAULT '',
	totp_pending  TEXT NOT NULL DEFAULT '',
	totp_last     INTEGER NOT NULL DEFAULT 0,
	recovery      TEXT NOT NULL DEFAULT '[]',
	created       INTEGER NOT NULL,
	updated       INTEGER NOT NULL
);
CREATE TABLE sessions (
	id         TEXT NOT NULL UNIQUE,
	token_hash TEXT PRIMARY KEY,
	device     TEXT NOT NULL,
	ip         TEXT NOT NULL,
	user_agent TEXT NOT NULL,
	created    INTEGER NOT NULL,
	last_seen  INTEGER NOT NULL,
	expires    INTEGER NOT NULL
);
CREATE TABLE revisions (
	id      INTEGER PRIMARY KEY AUTOINCREMENT,
	path    TEXT NOT NULL,
	created INTEGER NOT NULL,
	updated INTEGER NOT NULL,
	source  TEXT NOT NULL,
	content TEXT NOT NULL
);
CREATE INDEX revisions_path ON revisions(path, updated);
CREATE TABLE shares (
	token   TEXT PRIMARY KEY,
	path    TEXT NOT NULL UNIQUE,
	created INTEGER NOT NULL
);
`, `
-- Re-read every page on the next scan, so previews drop HTML tags.
UPDATE notes SET size = -1;
`, `
-- The frontmatter's "verified: YYYY-MM-DD"; re-read pages to fill it in.
ALTER TABLE notes ADD COLUMN verified TEXT NOT NULL DEFAULT '';
UPDATE notes SET size = -1;
`, `
-- "database" for a page with rows (database: true in its front matter),
-- and public links to database forms.
ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT '';
UPDATE notes SET size = -1;
CREATE TABLE form_links (
	token     TEXT PRIMARY KEY,
	path      TEXT NOT NULL,
	form      TEXT NOT NULL,
	created   INTEGER NOT NULL,
	responses INTEGER NOT NULL DEFAULT 0,
	UNIQUE (path, form)
);
`, `
-- Pages use the whole window unless set to "width: narrow".
ALTER TABLE account ADD COLUMN full_width INTEGER NOT NULL DEFAULT 1;
`, `
-- Links in tables, written [[Page\|Label]], were indexed with the escaping
-- backslash in their target, so backlinks missed them. Mark those pages
-- stale; the next scan reads them again (same content: no history added).
UPDATE notes SET mtime = 0 WHERE path IN (SELECT src FROM links WHERE target LIKE '%\');
`, `
-- Sections of pages for answering questions (package ask): offsets into
-- the page, a contentless search index over their text, and the labels
-- links use for pages. Pages saved from now on get them at once; the rest
-- are filled in the background after start (FillPassages).
CREATE TABLE passage_pages (
	path TEXT PRIMARY KEY,
	doc  INTEGER NOT NULL -- the page's rowid in fts, to read its text
);
CREATE TABLE passages (
	id      INTEGER PRIMARY KEY,
	path    TEXT NOT NULL,
	section INTEGER NOT NULL,
	part    INTEGER NOT NULL,
	heading TEXT NOT NULL,
	trail   TEXT NOT NULL, -- the headings above it and its own
	level   INTEGER NOT NULL,
	start   INTEGER NOT NULL,
	stop    INTEGER NOT NULL,
	flags   INTEGER NOT NULL,
	words   INTEGER NOT NULL
);
CREATE INDEX passages_path ON passages(path, section, part);
CREATE VIRTUAL TABLE passage_fts USING fts5(title, heading, body, content='', contentless_delete=1, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE passage_vocab USING fts5vocab(passage_fts, 'row');
CREATE TABLE aliases (
	src    TEXT NOT NULL,
	label  TEXT NOT NULL,
	target TEXT NOT NULL
);
CREATE INDEX aliases_label ON aliases(label);
CREATE INDEX aliases_src ON aliases(src);
`}

type Store struct {
	db    *sql.DB
	spell spelling
}

func Open(file string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+file+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)&_pragma=journal_size_limit(67108864)&_pragma=temp_store(memory)")
	if err != nil {
		return nil, err
	}
	// One connection: writes are tiny, and it rules out SQLITE_BUSY.
	db.SetMaxOpenConns(1)
	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return &Store{db: db}, nil
}

func migrate(db *sql.DB) error {
	var version int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}
	for i := version; i < len(migrations); i++ {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[i]); err != nil {
			tx.Rollback()
			return err
		}
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// Moved updates history, share links and form links after pages move. moves maps old
// page paths to new ones.
func (s *Store) Moved(moves map[string]string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for from, to := range moves {
		if _, err := tx.Exec(`UPDATE revisions SET path = ? WHERE path = ?`, to, from); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE shares SET path = ? WHERE path = ?`, to, from); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE form_links SET path = ? WHERE path = ?`, to, from); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) Close() error { return s.db.Close() }

type Note struct {
	Path    string   `json:"path"`
	Title   string   `json:"title"`
	Folder  string   `json:"folder"`
	Mtime   int64    `json:"mtime"`
	Size    int64    `json:"size"`
	Rev     string   `json:"rev"`
	Words   int      `json:"words"`
	Excerpt string   `json:"excerpt"`
	Tags    []string `json:"tags"`
	// Kind is "database" for a page with rows and columns, "" otherwise.
	Kind string `json:"kind,omitempty"`
}

// Put indexes a note's current content, replacing what was there.
func (s *Store) Put(e vault.Entry, content []byte) error {
	text := string(content)
	p := vault.Parse(text)
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := deleteNote(tx, e.Path); err != nil {
		return err
	}
	title := vault.Title(e.Path)
	// Most notes open with their title as a heading; the excerpt is for what follows.
	if rest, ok := strings.CutPrefix(p.Excerpt, title); ok && (rest == "" || rest[0] == ' ') {
		p.Excerpt = strings.TrimSpace(rest)
	}
	if _, err := tx.Exec(`INSERT INTO notes (path, title, folder, mtime, size, rev, words, excerpt, kind) VALUES (?,?,?,?,?,?,?,?,?)`,
		e.Path, title, vault.Folder(e.Path), e.ModTime.UnixMilli(), e.Size, vault.Rev(content), p.Words, p.Excerpt, p.Kind); err != nil {
		return err
	}
	for _, l := range p.Links {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO links (src, key, target, context) VALUES (?,?,?,?)`,
			e.Path, vault.LinkKey(l.Target), l.Target, l.Context); err != nil {
			return err
		}
	}
	for _, t := range p.Tags {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO tags (path, tag) VALUES (?,?)`, e.Path, t); err != nil {
			return err
		}
	}
	res, err := tx.Exec(`INSERT INTO fts (path, title, body) VALUES (?,?,?)`, e.Path, title, text)
	if err != nil {
		return err
	}
	doc, err := res.LastInsertId()
	if err != nil {
		return err
	}
	if err := putPassages(tx, doc, e.Path, title, text); err != nil {
		return err
	}
	return tx.Commit()
}

func deleteNote(tx *sql.Tx, p string) error {
	for _, q := range []string{
		`DELETE FROM notes WHERE path = ?`,
		`DELETE FROM links WHERE src = ?`,
		`DELETE FROM tags WHERE path = ?`,
		`DELETE FROM fts WHERE path = ?`,
	} {
		if _, err := tx.Exec(q, p); err != nil {
			return err
		}
	}
	return deletePassages(tx, p)
}

func (s *Store) Delete(paths ...string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, p := range paths {
		if err := deleteNote(tx, p); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Stamps maps each indexed path to its mtime and size, so a scan can tell
// which files changed on disk.
func (s *Store) Stamps() (map[string][2]int64, error) {
	rows, err := s.db.Query(`SELECT path, mtime, size FROM notes`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][2]int64{}
	for rows.Next() {
		var p string
		var m, sz int64
		if err := rows.Scan(&p, &m, &sz); err != nil {
			return nil, err
		}
		out[p] = [2]int64{m, sz}
	}
	return out, rows.Err()
}

// IndexedRev is the content hash the index holds for path, or "" if the
// page isn't indexed.
func (s *Store) IndexedRev(path string) (string, error) {
	var rev string
	err := s.db.QueryRow(`SELECT rev FROM notes WHERE path = ?`, path).Scan(&rev)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return rev, err
}

// IndexedText is the page text the full-text index holds for path, or nil
// if it has none: what the page said when it was last indexed.
func (s *Store) IndexedText(path string) ([]byte, error) {
	var body string
	err := s.db.QueryRow(`SELECT body FROM fts WHERE path = ?`, path).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return []byte(body), nil
}

func (s *Store) Notes() ([]Note, error) {
	rows, err := s.db.Query(`SELECT path, title, folder, mtime, size, rev, words, excerpt, kind FROM notes ORDER BY path COLLATE NOCASE`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Note
	idx := map[string]int{}
	for rows.Next() {
		var n Note
		if err := rows.Scan(&n.Path, &n.Title, &n.Folder, &n.Mtime, &n.Size, &n.Rev, &n.Words, &n.Excerpt, &n.Kind); err != nil {
			return nil, err
		}
		n.Tags = []string{}
		idx[n.Path] = len(out)
		out = append(out, n)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	trows, err := s.db.Query(`SELECT path, tag FROM tags ORDER BY tag`)
	if err != nil {
		return nil, err
	}
	defer trows.Close()
	for trows.Next() {
		var p, t string
		if err := trows.Scan(&p, &t); err != nil {
			return nil, err
		}
		if i, ok := idx[p]; ok {
			out[i].Tags = append(out[i].Tags, t)
		}
	}
	return out, trows.Err()
}

func (s *Store) Note(p string) (Note, error) {
	var n Note
	err := s.db.QueryRow(`SELECT path, title, folder, mtime, size, rev, words, excerpt, kind FROM notes WHERE path = ?`, p).
		Scan(&n.Path, &n.Title, &n.Folder, &n.Mtime, &n.Size, &n.Rev, &n.Words, &n.Excerpt, &n.Kind)
	if errors.Is(err, sql.ErrNoRows) {
		return n, ErrNotFound
	}
	if err != nil {
		return n, err
	}
	n.Tags = []string{}
	rows, err := s.db.Query(`SELECT tag FROM tags WHERE path = ? ORDER BY tag`, p)
	if err != nil {
		return n, err
	}
	defer rows.Close()
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return n, err
		}
		n.Tags = append(n.Tags, t)
	}
	return n, rows.Err()
}

// Resolver turns link targets into note paths, the same way the web UI does:
// a target with a slash matches a path (or the end of one); a bare name
// matches a title, preferring the linking note's folder, then the shortest
// path.
type Resolver struct {
	byPath  map[string]string
	byTitle map[string][]string
}

func (s *Store) Resolver() (*Resolver, error) {
	rows, err := s.db.Query(`SELECT path FROM notes`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	r := &Resolver{byPath: map[string]string{}, byTitle: map[string][]string{}}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		r.byPath[vault.LinkKey(p)] = p
		t := strings.ToLower(vault.Title(p))
		r.byTitle[t] = append(r.byTitle[t], p)
	}
	return r, rows.Err()
}

func (r *Resolver) Resolve(target, from string) string {
	key := vault.LinkKey(target)
	if key == "" {
		return ""
	}
	if strings.Contains(key, "/") {
		if p, ok := r.byPath[key]; ok {
			return p
		}
		var best string
		for k, p := range r.byPath {
			if strings.HasSuffix(k, "/"+key) && (best == "" || len(p) < len(best)) {
				best = p
			}
		}
		return best
	}
	cands := r.byTitle[key]
	switch len(cands) {
	case 0:
		return ""
	case 1:
		return cands[0]
	}
	dir := vault.Folder(from)
	best := ""
	for _, c := range cands {
		if vault.Folder(c) == dir {
			return c
		}
		if best == "" || len(c) < len(best) || len(c) == len(best) && c < best {
			best = c
		}
	}
	return best
}

// HasTitle reports whether some page has this title, in any case.
func (r *Resolver) HasTitle(title string) bool {
	return len(r.byTitle[strings.ToLower(title)]) > 0
}

// keysFor lists every link key that could point at p: its title and each
// trailing run of its path.
func keysFor(p string) []string {
	k := vault.LinkKey(p)
	keys := []string{strings.ToLower(vault.Title(p))}
	parts := strings.Split(k, "/")
	for i := range parts[:len(parts)-1] {
		keys = append(keys, strings.Join(parts[i:], "/"))
	}
	return keys
}

type Backlink struct {
	Path    string `json:"path"`
	Title   string `json:"title"`
	Context string `json:"context"`
}

// Backlinks lists notes whose links resolve to p.
func (s *Store) Backlinks(p string, r *Resolver) ([]Backlink, error) {
	keys := keysFor(p)
	q := `SELECT src, target, context FROM links WHERE key IN (?` + strings.Repeat(",?", len(keys)-1) + `) ORDER BY src COLLATE NOCASE`
	args := make([]any, len(keys))
	for i, k := range keys {
		args[i] = k
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Backlink{}
	seen := map[string]bool{}
	for rows.Next() {
		var b Backlink
		var target string
		if err := rows.Scan(&b.Path, &target, &b.Context); err != nil {
			return nil, err
		}
		if seen[b.Path] || b.Path == p || r.Resolve(target, b.Path) != p {
			continue
		}
		seen[b.Path] = true
		b.Title = vault.Title(b.Path)
		out = append(out, b)
	}
	return out, rows.Err()
}

type Outgoing struct {
	Target string `json:"target"`
	Path   string `json:"path,omitempty"`
}

func (s *Store) Outgoing(p string, r *Resolver) ([]Outgoing, error) {
	rows, err := s.db.Query(`SELECT target FROM links WHERE src = ? ORDER BY rowid`, p)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Outgoing{}
	for rows.Next() {
		var o Outgoing
		if err := rows.Scan(&o.Target); err != nil {
			return nil, err
		}
		o.Path = r.Resolve(o.Target, p)
		out = append(out, o)
	}
	return out, rows.Err()
}

type Hit struct {
	Path    string `json:"path"`
	Title   string `json:"title"`
	Folder  string `json:"folder"`
	Snippet string `json:"snippet"`
	// Heading is the section the match is in, when the search knows it.
	Heading string `json:"heading,omitempty"`
}

// Search runs a full-text query. Every word must match; the last one may be
// a prefix, so results keep up with typing. Matches in the snippet are
// wrapped in \x02…\x03 for the client to highlight.
func (s *Store) Search(query string, limit int) ([]Hit, error) {
	if tag, ok := strings.CutPrefix(strings.TrimSpace(query), "#"); ok && tag != "" && !strings.Contains(tag, " ") {
		return s.byTag(strings.ToLower(tag), limit)
	}
	words := strings.FieldsFunc(query, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsNumber(r) })
	if len(words) == 0 {
		return []Hit{}, nil
	}
	for i, w := range words {
		words[i] = `"` + w + `"`
	}
	words[len(words)-1] += "*"
	rows, err := s.db.Query(`
		SELECT f.path, n.folder, snippet(fts, 2, char(2), char(3), '…', 14)
		FROM fts f JOIN notes n ON n.path = f.path
		WHERE fts MATCH ? ORDER BY bm25(fts, 0, 8.0, 1.0) LIMIT ?`, strings.Join(words, " "), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Hit{}
	for rows.Next() {
		var h Hit
		if err := rows.Scan(&h.Path, &h.Folder, &h.Snippet); err != nil {
			return nil, err
		}
		h.Title = vault.Title(h.Path)
		out = append(out, h)
	}
	return out, rows.Err()
}

func (s *Store) byTag(tag string, limit int) ([]Hit, error) {
	rows, err := s.db.Query(`
		SELECT n.path, n.folder, n.excerpt FROM tags t JOIN notes n ON n.path = t.path
		WHERE t.tag = ? OR t.tag LIKE ? ESCAPE '\' ORDER BY n.mtime DESC LIMIT ?`,
		tag, escapeLike(tag)+"/%", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Hit{}
	for rows.Next() {
		var h Hit
		if err := rows.Scan(&h.Path, &h.Folder, &h.Snippet); err != nil {
			return nil, err
		}
		h.Title = vault.Title(h.Path)
		out = append(out, h)
	}
	return out, rows.Err()
}

func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

type Tag struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

func (s *Store) Tags() ([]Tag, error) {
	rows, err := s.db.Query(`SELECT tag, COUNT(*) FROM tags GROUP BY tag ORDER BY tag`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Tag{}
	for rows.Next() {
		var t Tag
		if err := rows.Scan(&t.Tag, &t.Count); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

type GraphNode struct {
	Path   string `json:"path"`
	Title  string `json:"title"`
	Folder string `json:"folder"`
	Links  int    `json:"links"`
}

type GraphEdge struct {
	Source string `json:"source"`
	Target string `json:"target"`
}

type Graph struct {
	Nodes []GraphNode `json:"nodes"`
	Edges []GraphEdge `json:"edges"`
}

// Graph returns the notes and the resolved links between them. With a space
// it keeps to that space's notes and the links among them; "" means all.
func (s *Store) Graph(space string) (Graph, error) {
	r, err := s.Resolver()
	if err != nil {
		return Graph{}, err
	}
	g := Graph{Nodes: []GraphNode{}, Edges: []GraphEdge{}}
	degree := map[string]int{}
	rows, err := s.db.Query(`SELECT src, target FROM links`)
	if err != nil {
		return g, err
	}
	seen := map[[2]string]bool{}
	for rows.Next() {
		var src, target string
		if err := rows.Scan(&src, &target); err != nil {
			rows.Close()
			return g, err
		}
		dst := r.Resolve(target, src)
		if dst == "" || dst == src {
			continue
		}
		if space != "" && (vault.SpaceOf(src) != space || vault.SpaceOf(dst) != space) {
			continue
		}
		e := [2]string{src, dst}
		if seen[e] || seen[[2]string{dst, src}] {
			continue
		}
		seen[e] = true
		degree[src]++
		degree[dst]++
		g.Edges = append(g.Edges, GraphEdge{Source: src, Target: dst})
	}
	rows.Close()
	paths := make([]string, 0, len(r.byPath))
	for _, p := range r.byPath {
		if space == "" || vault.SpaceOf(p) == space {
			paths = append(paths, p)
		}
	}
	sort.Strings(paths)
	for _, p := range paths {
		g.Nodes = append(g.Nodes, GraphNode{Path: p, Title: vault.Title(p), Folder: vault.Folder(p), Links: degree[p]})
	}
	return g, nil
}

// LinkSources lists the notes that link to any of paths, as resolved now.
func (s *Store) LinkSources(paths []string, r *Resolver) (map[string]bool, error) {
	out := map[string]bool{}
	for _, p := range paths {
		bl, err := s.Backlinks(p, r)
		if err != nil {
			return nil, err
		}
		for _, b := range bl {
			out[b.Path] = true
		}
		// A note's links to itself count too.
		out[p] = true
	}
	return out, nil
}
