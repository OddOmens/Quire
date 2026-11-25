// Package importer turns a folder of Markdown from elsewhere (a zip of
// plain folders, an Obsidian vault, a Notion or Docmost export, or a few
// loose .md files) into Quire pages and attachments.
//
// Build only plans: it decides where each page and file goes and rewrites
// links to match, without touching the vault. Folders become sub-pages, a
// folder's index.md or README.md becomes its page, Notion's id suffixes come
// off names, files the pages use go to attachments/ and relative links to
// other pages become [[wikilinks]]. Nothing in the vault is overwritten:
// names that are taken get a number.
package importer

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/oddomens/quire/internal/vault"
)

// Limits on what one import may hold.
const (
	MaxZipSize  = 500 << 20
	MaxEntries  = 20_000
	MaxTotal    = 2 << 30
	MaxPageSize = 16 << 20
	// MaxPagesTotal caps the Markdown held in memory while planning.
	MaxPagesTotal = 512 << 20
)

// ErrRefused is an upload that can't be imported at all; the message says why.
type ErrRefused struct{ Reason string }

func (e ErrRefused) Error() string { return e.Reason }

// File is one file of an import: a zip entry or an uploaded file.
type File struct {
	// Name is its path inside the import, with forward slashes.
	Name string
	Size int64
	Mode fs.FileMode
	Open func() (io.ReadCloser, error)
}

// FromZip lists a zip's files, refusing one over the entry or size limits.
func FromZip(zr *zip.Reader) ([]File, error) {
	if len(zr.File) > MaxEntries {
		return nil, ErrRefused{fmt.Sprintf("the zip holds more than %d files", MaxEntries)}
	}
	var total uint64
	files := make([]File, 0, len(zr.File))
	for _, zf := range zr.File {
		total += zf.UncompressedSize64
		if total > MaxTotal {
			return nil, ErrRefused{"the zip unpacks to more than 2 GB"}
		}
		zf := zf
		files = append(files, File{
			Name: zf.Name,
			Size: int64(zf.UncompressedSize64),
			Mode: zf.Mode(),
			Open: func() (io.ReadCloser, error) {
				rc, err := zf.Open()
				if err != nil {
					return nil, err
				}
				// archive/zip also checks this; a lying header can't unpack more.
				return struct {
					io.Reader
					io.Closer
				}{io.LimitReader(rc, int64(zf.UncompressedSize64)), rc}, nil
			},
		})
	}
	return files, nil
}

// Target is the vault the import goes into.
type Target interface {
	// Exists reports whether a file or folder is at the vault path p.
	Exists(p string) bool
	// HasTitle reports whether a page already in the vault has this title,
	// in any case.
	HasTitle(title string) bool
}

type Page struct {
	// Path is the new page's vault path.
	Path    string
	Content []byte
}

type Attachment struct {
	// Path is the new file's vault path, in attachments/.
	Path string
	From File
}

// Renamed is a page that got a numbered name because its own was taken.
type Renamed struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type Skipped struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

type Plan struct {
	Pages       []Page
	Attachments []Attachment
	Renamed     []Renamed
	Skipped     []Skipped
}

var (
	notionID = regexp.MustCompile(`^(.*?)\s*\b[0-9a-fA-F]{32}$`)
	wikiLink = regexp.MustCompile(`(!?)\[\[([^\[\]\n|#^]+)(#[^\[\]\n|]*)?(\|[^\[\]\n]*)?\]\]`)
	// mdLink is [text](dest "title"), the destination in <angle brackets> or
	// bare with at most one level of parentheses, as Notion leaves them.
	mdLink   = regexp.MustCompile(`(!?)\[((?:[^\[\]\n]|\[[^\[\]\n]*\])*)\]\(\s*(<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)`)
	anyLink  = regexp.MustCompile(wikiLink.String() + "|" + mdLink.String())
	external = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9+.-]*:|/|#)`)
	mediaExt = regexp.MustCompile(`(?i)\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|m4v)$`)
	pageExt  = regexp.MustCompile(`(?i)\.(md|markdown)$`)
	size     = regexp.MustCompile(`^\d+(x\d+)?$`)
)

// node is a page to be: a Markdown file, a folder of them, or both.
type node struct {
	src      string // source path without extension, as first seen
	name     string // the name it wants
	file     *File
	children map[string]*node
	target   string // its vault path without .md, once placed
}

// Build plans an import of files into space.
func Build(files []File, space string, t Target) (*Plan, error) {
	b := &builder{
		plan:    &Plan{Renamed: []Renamed{}, Skipped: []Skipped{}},
		t:       t,
		root:    &node{children: map[string]*node{}, target: space},
		nodes:   map[string]*node{},
		names:   map[string][]*node{},
		assets:  map[string]*File{},
		byName:  map[string][]string{},
		placed:  map[string]string{},
		planned: map[string]bool{},
		titles:  map[string]int{},
	}
	if err := b.collect(files); err != nil {
		return nil, err
	}
	b.place(b.root)
	if err := b.render(); err != nil {
		return nil, err
	}
	for _, p := range sortedKeys(b.assets) {
		if _, ok := b.placed[p]; !ok {
			b.skip(b.assets[p].Name, "not linked from any page")
		}
	}
	return b.plan, nil
}

type builder struct {
	plan  *Plan
	t     Target
	root  *node
	nodes map[string]*node // by lower-case source path without extension
	// names lists pages by lower-case file name and wanted name.
	names map[string][]*node
	// assets are the files that aren't pages, by lower-case source path.
	assets map[string]*File
	// byName lists assets' lower-case source paths by lower-case base name.
	byName map[string][]string
	// placed maps an asset's lower-case source path to its attachment path.
	placed map[string]string
	// planned holds lower-case vault paths this import will take.
	planned map[string]bool
	// titles counts the pages this import makes, by lower-case title.
	titles map[string]int
}

func (b *builder) skip(p, reason string) {
	b.plan.Skipped = append(b.plan.Skipped, Skipped{Path: p, Reason: reason})
}

// collect checks every name, sets aside what isn't imported and builds the
// page tree.
func (b *builder) collect(files []File) error {
	var keep []*File
	for i := range files {
		f := &files[i]
		name := strings.ReplaceAll(f.Name, `\`, "/")
		if strings.HasPrefix(name, "/") || (len(name) > 1 && name[1] == ':') {
			return ErrRefused{fmt.Sprintf("%q has an absolute path; nothing was imported", f.Name)}
		}
		segs := strings.Split(strings.Trim(name, "/"), "/")
		ignored := false
		for _, s := range segs {
			if s == ".." {
				return ErrRefused{fmt.Sprintf("%q points outside the zip; nothing was imported", f.Name)}
			}
			if strings.HasPrefix(s, ".") || s == "__MACOSX" || strings.EqualFold(s, "Thumbs.db") || strings.EqualFold(s, "desktop.ini") {
				ignored = true
			}
		}
		if ignored || strings.HasSuffix(name, "/") || f.Mode.IsDir() {
			continue
		}
		if f.Mode&fs.ModeSymlink != 0 {
			b.skip(name, "symbolic link")
			continue
		}
		if !f.Mode.IsRegular() {
			b.skip(name, "not a regular file")
			continue
		}
		f.Name = path.Clean(strings.Join(segs, "/"))
		keep = append(keep, f)
	}
	stripRoot(keep)

	seen := map[string]bool{}
	var pages []*File
	for _, f := range keep {
		key := strings.ToLower(f.Name)
		if seen[key] {
			b.skip(f.Name, "another file has the same name")
			continue
		}
		seen[key] = true
		if pageExt.MatchString(f.Name) {
			if f.Size > MaxPageSize {
				b.skip(f.Name, "too large for a page")
				continue
			}
			pages = append(pages, f)
			continue
		}
		b.assets[key] = f
		base := strings.ToLower(path.Base(f.Name))
		b.byName[base] = append(b.byName[base], key)
	}

	// A folder's index.md or README.md is its page, unless the folder has
	// a page beside it already.
	bases := map[string]bool{}
	for _, f := range pages {
		bases[strings.ToLower(trimExt(f.Name))] = true
	}
	claimed := map[string]bool{}
	sort.SliceStable(pages, func(i, j int) bool { return indexRank(pages[i].Name) < indexRank(pages[j].Name) })
	for _, f := range pages {
		src := trimExt(f.Name)
		if dir := vault.Folder(f.Name); dir != "" && indexRank(f.Name) < 2 {
			if key := strings.ToLower(dir); !bases[key] && !claimed[key] {
				claimed[key] = true
				src = dir
			}
		}
		n := b.node(src)
		if n.file != nil {
			b.skip(f.Name, "another file has the same name")
			continue
		}
		n.file = f
		// A link may name the index file itself.
		b.nodes[strings.ToLower(trimExt(f.Name))] = n
		names := []string{strings.ToLower(path.Base(src)), strings.ToLower(n.name)}
		if names[1] == names[0] {
			names = names[:1]
		}
		for _, name := range names {
			b.names[name] = append(b.names[name], n)
		}
	}
	return nil
}

// indexRank orders a folder's index.md before its README.md before the rest.
func indexRank(p string) int {
	switch strings.ToLower(trimExt(path.Base(p))) {
	case "index":
		return 0
	case "readme":
		return 1
	}
	return 2
}

// stripRoot drops a folder that holds everything, as zipping a folder
// leaves, so its pages land at the top of the space. A Quire space export
// has attachments/ beside the space's folder; that doesn't count.
func stripRoot(files []*File) {
	top := ""
	for _, f := range files {
		first, _, ok := strings.Cut(f.Name, "/")
		if !ok {
			return
		}
		if strings.EqualFold(first, vault.AttachmentsDir) {
			continue
		}
		if top != "" && first != top {
			return
		}
		top = first
	}
	if top == "" {
		return
	}
	for _, f := range files {
		f.Name = strings.TrimPrefix(f.Name, top+"/")
	}
}

// node finds or makes the node for a source path, with its parents.
func (b *builder) node(src string) *node {
	key := strings.ToLower(src)
	if n, ok := b.nodes[key]; ok {
		return n
	}
	parent := b.root
	if dir := vault.Folder(src); dir != "" {
		parent = b.node(dir)
	}
	n := &node{src: src, name: cleanName(path.Base(src)), children: map[string]*node{}}
	parent.children[key] = n
	b.nodes[key] = n
	return n
}

// cleanName is the page name for a file or folder: Notion's id suffix
// removed, and characters file systems refuse replaced.
func cleanName(name string) string {
	if m := notionID.FindStringSubmatch(name); m != nil {
		name = m[1]
	}
	name = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`/\:*?"<>|`, r) || r < 32 || r == 0x7f {
			return '-'
		}
		return r
	}, strings.Join(strings.Fields(name), " "))
	name = strings.TrimLeft(name, ".")
	// Room for " 2" and ".md" in a file system's 255 bytes.
	r := []rune(name)
	for len(r) > 120 || len(string(r)) > 200 {
		r = r[:len(r)-1]
	}
	name = strings.TrimSpace(string(r))
	if name == "" {
		name = "Untitled"
	}
	return name
}

func trimExt(p string) string { return strings.TrimSuffix(p, path.Ext(p)) }

// place gives each page its vault path under its parent, numbering it when
// the name is taken in the vault or by another imported page.
func (b *builder) place(parent *node) {
	for _, key := range sortedKeys(parent.children) {
		n := parent.children[key]
		want := parent.target + "/" + n.name + ".md"
		got := vault.UniqueName(want, func(c string) bool {
			base := vault.Base(c)
			return b.planned[strings.ToLower(c)] || b.planned[strings.ToLower(base)] || b.t.Exists(c) || b.t.Exists(base)
		})
		n.target = vault.Base(got)
		b.planned[strings.ToLower(got)] = true
		b.planned[strings.ToLower(n.target)] = true
		if n.file != nil {
			b.titles[strings.ToLower(vault.Title(got))]++
			if got != want {
				b.plan.Renamed = append(b.plan.Renamed, Renamed{From: n.file.Name, To: got})
			}
		}
		b.place(n)
	}
}

// render reads each page and rewrites its links.
func (b *builder) render() error {
	var total int64
	var walk func(n *node) error
	walk = func(n *node) error {
		for _, key := range sortedKeys(n.children) {
			c := n.children[key]
			if c.file != nil {
				data, err := read(c.file)
				data = []byte(strings.TrimPrefix(string(data), "\ufeff"))
				total += int64(len(data))
				switch {
				case err != nil:
					// A damaged or encrypted entry, say.
					b.skip(c.file.Name, "couldn't be read")
				case total > MaxPagesTotal:
					return ErrRefused{"the pages add up to more than 512 MB of Markdown"}
				case !utf8.Valid(data):
					b.skip(c.file.Name, "not UTF-8 text")
				default:
					b.plan.Pages = append(b.plan.Pages, Page{Path: c.target + ".md", Content: []byte(b.rewrite(string(data), c.file.Name))})
				}
			}
			if err := walk(c); err != nil {
				return err
			}
		}
		return nil
	}
	return walk(b.root)
}

func read(f *File) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(io.LimitReader(rc, MaxPageSize+1))
}

// rewrite points a page's links at where things land: other pages as
// [[wikilinks]], files at their attachments. Each link is looked at once,
// and code is left as written.
func (b *builder) rewrite(content, from string) string {
	dir := vault.Folder(from)
	return vault.OutsideCode(content, func(s string) string {
		return anyLink.ReplaceAllStringFunc(s, func(m string) string {
			if g := wikiLink.FindStringSubmatch(m); g != nil && g[0] == m {
				return b.rewriteWiki(m, g, dir)
			}
			if g := mdLink.FindStringSubmatch(m); g != nil && g[0] == m {
				return b.rewriteMarkdown(m, g, dir)
			}
			return m
		})
	})
}

// rewriteWiki handles [[Page]], [[Page#Heading|alias]], ![[image.png|300]]
// and the like.
func (b *builder) rewriteWiki(m string, g []string, dir string) string {
	embed, target, heading, alias := g[1] == "!", strings.TrimSpace(g[2]), g[3], g[4]
	if n := b.findPage(target, dir); n != nil {
		return g[1] + "[[" + b.linkTarget(n, target) + heading + alias + "]]"
	}
	if pageExt.MatchString(target) {
		return m
	}
	if f := b.findAsset(target, dir); f != nil {
		label := strings.TrimPrefix(alias, "|")
		if label == "" || size.MatchString(label) {
			label = trimExt(path.Base(target))
		}
		return b.fileLink(embed && mediaExt.MatchString(target), label, f, "")
	}
	return m
}

// rewriteMarkdown handles [text](relative/path) links and images.
func (b *builder) rewriteMarkdown(m string, g []string, dir string) string {
	bang, text, dest, title := g[1], g[2], g[3], g[4]
	dest = strings.TrimSuffix(strings.TrimPrefix(dest, "<"), ">")
	if dest == "" || external.MatchString(dest) {
		return m
	}
	p := cut(dest)
	if u, err := url.PathUnescape(p); err == nil {
		p = u
	}
	if pageExt.MatchString(p) {
		n := b.findPage(p, dir)
		if n == nil {
			return m
		}
		target := b.linkTarget(n, "")
		label := strings.NewReplacer("[", "", "]", "", "|", "-").Replace(strings.TrimSpace(text))
		if label == "" || strings.EqualFold(label, vault.Title(n.target)) || strings.EqualFold(label, target) {
			return "[[" + target + "]]"
		}
		return "[[" + target + "|" + label + "]]"
	}
	if f := b.findAsset(p, dir); f != nil {
		return b.fileLink(bang == "!", text, f, title)
	}
	return m
}

// cut drops a link's #fragment and ?query.
func cut(dest string) string {
	if i := strings.IndexAny(dest, "#?"); i >= 0 {
		return dest[:i]
	}
	return dest
}

// fileLink is the Markdown the editor writes for an attachment: an image
// or video embed, or a link to the file.
func (b *builder) fileLink(embed bool, label string, f *File, title string) string {
	p := strings.ReplaceAll(b.attach(f), " ", "%20")
	md := "[" + label + "](" + p + title + ")"
	if embed {
		md = "!" + md
	}
	return md
}

// attach plans a file's copy in attachments/, once however often it's used.
func (b *builder) attach(f *File) string {
	key := strings.ToLower(f.Name)
	if p, ok := b.placed[key]; ok {
		return p
	}
	p := vault.UniqueName(vault.AttachmentsDir+"/"+vault.AttachmentName(f.Name), func(c string) bool {
		return b.planned[strings.ToLower(c)] || b.t.Exists(c)
	})
	b.planned[strings.ToLower(p)] = true
	b.placed[key] = p
	b.plan.Attachments = append(b.plan.Attachments, Attachment{Path: p, From: *f})
	return p
}

// linkTarget is what a [[link]] to n says: its title, or its full path
// when the title alone could lead to another page. A link already written
// in a way that still leads to n is kept as it is.
func (b *builder) linkTarget(n *node, written string) string {
	title := vault.Title(n.target)
	if b.titles[strings.ToLower(title)] > 1 || b.t.HasTitle(title) {
		return n.target
	}
	key := vault.LinkKey(written)
	if key == strings.ToLower(title) || strings.Contains(key, "/") && strings.HasSuffix(vault.LinkKey(n.target), "/"+key) {
		return written
	}
	return title
}

// findPage resolves a link to an imported page: a relative path from the
// linking page's folder, a path from the top, the end of a path, or a bare
// name (in the linking page's folder first, then the shortest path), the
// way Obsidian resolves them.
func (b *builder) findPage(target, dir string) *node {
	key := strings.ToLower(strings.Trim(target, "/"))
	if pageExt.MatchString(key) {
		key = trimExt(key)
	}
	if key == "" {
		return nil
	}
	for _, c := range []string{path.Join(strings.ToLower(dir), key), key} {
		if strings.HasPrefix(c, "../") || c == ".." {
			continue
		}
		if n := b.nodes[c]; n != nil && n.file != nil {
			return n
		}
	}
	var best *node
	for _, n := range b.names[path.Base(key)] {
		k := strings.ToLower(n.src)
		if strings.Contains(key, "/") && !strings.HasSuffix(k, "/"+key) {
			continue
		}
		if vault.Folder(k) == strings.ToLower(dir) {
			return n
		}
		if best == nil || len(n.src) < len(best.src) || len(n.src) == len(best.src) && n.src < best.src {
			best = n
		}
	}
	return best
}

// findAsset resolves a link to a file in the import the same way.
func (b *builder) findAsset(target, dir string) *File {
	key := strings.ToLower(strings.Trim(target, "/"))
	for _, c := range []string{path.Join(strings.ToLower(dir), key), key} {
		if strings.HasPrefix(c, "../") || c == ".." {
			continue
		}
		if f := b.assets[c]; f != nil {
			return f
		}
	}
	cands := b.byName[path.Base(key)]
	var best string
	for _, c := range cands {
		if !strings.HasSuffix(c, "/"+key) && c != key && strings.Contains(key, "/") {
			continue
		}
		if vault.Folder(c) == strings.ToLower(dir) {
			return b.assets[c]
		}
		if best == "" || len(c) < len(best) || len(c) == len(best) && c < best {
			best = c
		}
	}
	if best == "" {
		return nil
	}
	return b.assets[best]
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// IsRefused reports whether err is an import refused outright.
func IsRefused(err error) bool {
	var r ErrRefused
	return errors.As(err, &r)
}
