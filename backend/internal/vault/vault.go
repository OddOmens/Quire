// Package vault reads and writes the Markdown pages on disk. Paths are
// relative to the vault root with forward slashes, and every file operation
// goes through os.Root so nothing can reach outside the folder.
//
// Layout: each top-level folder is a space. A page is a .md file; its
// sub-pages live in a folder of the same name beside it:
//
//	Product/Roadmap.md
//	Product/Roadmap/Q1.md
package vault

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/oddomens/quire/internal/auth"
)

var (
	ErrInvalid  = errors.New("invalid path")
	ErrNotFound = errors.New("not found")
	ErrExists   = errors.New("already exists")
)

const (
	// TrashDir holds deleted pages and spaces until they're restored or purged.
	TrashDir = ".trash"
	// AttachmentsDir holds pasted and uploaded files. It isn't a space.
	AttachmentsDir = "attachments"
	spaceMetaFile  = ".space.json"
	trashMetaFile  = ".item.json"
)

type Vault struct {
	dir  string
	root *os.Root
}

type Entry struct {
	Path    string
	Size    int64
	ModTime time.Time
}

func Open(dir string) (*Vault, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	return &Vault{dir: dir, root: root}, nil
}

func (v *Vault) Close() error { return v.root.Close() }

// Clean normalises a client-supplied path and rejects anything that isn't a
// plain relative path of visible segments.
func Clean(p string) (string, error) {
	p = strings.TrimSpace(strings.ReplaceAll(p, `\`, "/"))
	p = strings.Trim(p, "/")
	if p == "" {
		return "", ErrInvalid
	}
	p = path.Clean(p)
	for _, seg := range strings.Split(p, "/") {
		if err := checkName(seg); err != nil {
			return "", err
		}
	}
	return p, nil
}

func checkName(seg string) error {
	if seg == "" || seg == "." || seg == ".." || strings.HasPrefix(seg, ".") || len(seg) > 255 || strings.TrimSpace(seg) != seg {
		return ErrInvalid
	}
	for _, r := range seg {
		if unicode.IsControl(r) || strings.ContainsRune(`:*?"<>|`, r) {
			return ErrInvalid
		}
	}
	return nil
}

// CleanPage is Clean for page paths: a .md file inside a space.
func CleanPage(p string) (string, error) {
	p, err := Clean(p)
	if err != nil {
		return "", err
	}
	if !IsNote(p) || !strings.Contains(p, "/") || SpaceOf(p) == AttachmentsDir {
		return "", ErrInvalid
	}
	return p, nil
}

// CleanSpace validates a space (top-level folder) name.
func CleanSpace(name string) (string, error) {
	name = strings.TrimSpace(name)
	if err := checkName(name); err != nil || strings.Contains(name, "/") || strings.EqualFold(name, AttachmentsDir) {
		return "", ErrInvalid
	}
	return name, nil
}

func IsNote(p string) bool { return strings.EqualFold(path.Ext(p), ".md") }

// Title is a page's display name: its file name without the extension.
func Title(p string) string { return strings.TrimSuffix(path.Base(p), path.Ext(p)) }

// Folder is the folder a path sits in, "" for the root.
func Folder(p string) string {
	if d := path.Dir(p); d != "." {
		return d
	}
	return ""
}

// SpaceOf is the space (first segment) a path belongs to.
func SpaceOf(p string) string {
	s, _, _ := strings.Cut(p, "/")
	return s
}

// Base is a page path without its extension: the page's folder of sub-pages.
func Base(p string) string {
	if IsNote(p) {
		return strings.TrimSuffix(p, path.Ext(p))
	}
	return p
}

// TableFiles are the files beside a database page that hold its rows and
// its columns, views and forms.
func TableFiles(page string) (rows, schema string) {
	b := Base(page)
	return b + ".csv", b + ".schema.json"
}

// Rev identifies a version of a page's content, for conflict checks.
func Rev(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:8])
}

// Walk lists every visible note and folder. Hidden entries (".trash", ".git",
// ".obsidian" and the like) are skipped.
func (v *Vault) Walk() (notes []Entry, folders []string, err error) {
	err = fs.WalkDir(v.root.FS(), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == "." {
				return err
			}
			return nil
		}
		if p == "." {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			folders = append(folders, p)
			return nil
		}
		if !d.Type().IsRegular() || !IsNote(p) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		notes = append(notes, Entry{Path: p, Size: info.Size(), ModTime: info.ModTime()})
		return nil
	})
	sort.Strings(folders)
	return notes, folders, err
}

func (v *Vault) Stat(p string) (fs.FileInfo, error) {
	info, err := v.root.Stat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	return info, err
}

func (v *Vault) Exists(p string) bool {
	_, err := v.root.Lstat(p)
	return err == nil
}

func (v *Vault) IsDir(p string) bool {
	info, err := v.root.Stat(p)
	return err == nil && info.IsDir()
}

func (v *Vault) IsFile(p string) bool {
	info, err := v.root.Stat(p)
	return err == nil && info.Mode().IsRegular()
}

func (v *Vault) Read(p string) ([]byte, Entry, error) {
	data, err := v.root.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, Entry{}, ErrNotFound
	}
	if err != nil {
		return nil, Entry{}, err
	}
	info, err := v.root.Stat(p)
	if err != nil {
		return nil, Entry{}, err
	}
	return data, Entry{Path: p, Size: info.Size(), ModTime: info.ModTime()}, nil
}

// Open opens a file for streaming (attachments).
func (v *Vault) Open(p string) (*os.File, error) {
	f, err := v.root.Open(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	return f, err
}

// Write replaces a file atomically: a temp file next to it, then a rename, so
// a crash never leaves half a page behind.
func (v *Vault) Write(p string, data []byte) (Entry, error) {
	return v.WriteFrom(p, bytes.NewReader(data))
}

// WriteFrom is Write for content streamed from r, such as a large imported
// file.
func (v *Vault) WriteFrom(p string, r io.Reader) (Entry, error) {
	if dir := Folder(p); dir != "" {
		if err := v.root.MkdirAll(dir, 0o755); err != nil {
			return Entry{}, err
		}
	}
	tmp := path.Join(Folder(p), fmt.Sprintf(".%s.%d.tmp", path.Base(p), time.Now().UnixNano()))
	f, err := v.root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return Entry{}, err
	}
	_, werr := io.Copy(f, r)
	if werr == nil {
		werr = f.Sync()
	}
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = v.root.Rename(tmp, p)
	}
	if werr != nil {
		_ = v.root.Remove(tmp)
		return Entry{}, werr
	}
	info, err := v.root.Stat(p)
	if err != nil {
		return Entry{}, err
	}
	return Entry{Path: p, Size: info.Size(), ModTime: info.ModTime()}, nil
}

// Create writes a new file and fails if one is already there.
func (v *Vault) Create(p string, data []byte) (Entry, error) {
	if v.Exists(p) {
		return Entry{}, ErrExists
	}
	return v.Write(p, data)
}

// Unique returns p, or p with " 2", " 3"… before the extension, whichever
// doesn't exist yet: "Plan 2.md", "image 2.png". For a page it also keeps
// clear of a same-named folder.
func (v *Vault) Unique(p string) string {
	return UniqueName(p, func(c string) bool {
		return v.Exists(c) || (IsNote(c) && (v.Exists(Base(c)) || v.Exists(Base(c)+".schema.json")))
	})
}

// UniqueName numbers p the way Unique does, until taken says the name is
// free.
func UniqueName(p string, taken func(string) bool) string {
	if !taken(p) {
		return p
	}
	ext := path.Ext(p)
	if ext == path.Base(p) {
		ext = "" // A dot file, like ".env": all name, no extension.
	}
	base := strings.TrimSuffix(p, ext)
	for i := 2; ; i++ {
		c := fmt.Sprintf("%s %d%s", base, i, ext)
		if !taken(c) {
			return c
		}
	}
}

// SameFile reports whether a and b are the same file or folder, as two
// spellings of one name are on a case-insensitive file system.
func (v *Vault) SameFile(a, b string) bool {
	ia, err := v.root.Lstat(a)
	if err != nil {
		return false
	}
	ib, err := v.root.Lstat(b)
	return err == nil && os.SameFile(ia, ib)
}

func (v *Vault) Mkdir(p string) error { return v.root.MkdirAll(p, 0o755) }

// Move renames one file or folder. The destination must not exist.
func (v *Vault) Move(from, to string) error {
	if !v.Exists(from) {
		return ErrNotFound
	}
	if from == to || strings.HasPrefix(to, from+"/") {
		return ErrInvalid
	}
	if v.Exists(to) && !(strings.EqualFold(from, to) && v.SameFile(from, to)) {
		return ErrExists
	}
	if dir := Folder(to); dir != "" {
		if err := v.root.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return v.root.Rename(from, to)
}

// RemoveEmptyDir deletes a folder if nothing is left in it but its page
// order, which goes with it.
func (v *Vault) RemoveEmptyDir(p string) {
	entries, err := fs.ReadDir(v.root.FS(), p)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.Name() != OrderFile || !e.Type().IsRegular() {
			return
		}
	}
	if len(entries) > 0 {
		_ = v.root.Remove(path.Join(p, OrderFile))
	}
	_ = v.root.Remove(p)
}

// ── Spaces ──

type SpaceMeta struct {
	Description string `json:"description"`
	Color       string `json:"color"`
	// Icon is a Lucide icon name in kebab-case; empty shows the initials.
	Icon string `json:"icon,omitempty"`
}

// Spaces lists the top-level folders in the order you arranged them (the
// OrderFile at the vault root), with the rest alphabetically after those.
func (v *Vault) Spaces() ([]string, error) {
	names, err := v.spaceNames()
	if err != nil {
		return nil, err
	}
	return v.arrange("", names), nil
}

// spaceNames is the set of top-level folders.
func (v *Vault) spaceNames() (map[string]bool, error) {
	entries, err := fs.ReadDir(v.root.FS(), ".")
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") && e.Name() != AttachmentsDir {
			out[e.Name()] = true
		}
	}
	return out, nil
}

func (v *Vault) SpaceMeta(space string) SpaceMeta {
	var m SpaceMeta
	if data, err := v.root.ReadFile(path.Join(space, spaceMetaFile)); err == nil {
		_ = json.Unmarshal(data, &m)
	}
	return m
}

func (v *Vault) SetSpaceMeta(space string, m SpaceMeta) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	_, err = v.Write(path.Join(space, spaceMetaFile), append(data, '\n'))
	return err
}

// AdoptLoose moves Markdown files sitting at the vault root, which belong to
// no space, into the given space.
func (v *Vault) AdoptLoose(space string) (map[string]string, error) {
	entries, err := fs.ReadDir(v.root.FS(), ".")
	if err != nil {
		return nil, err
	}
	moved := map[string]string{}
	for _, e := range entries {
		if e.Type().IsRegular() && IsNote(e.Name()) && !strings.HasPrefix(e.Name(), ".") {
			to := v.Unique(path.Join(space, e.Name()))
			if err := v.Move(e.Name(), to); err != nil {
				return moved, err
			}
			moved[e.Name()] = to
		}
	}
	return moved, nil
}

// ── Trash ──

// TrashItem is one deleted page (with its sub-pages) or space.
type TrashItem struct {
	ID        string   `json:"id"`
	Path      string   `json:"path"`
	Kind      string   `json:"kind"` // "page", "space" or "attachment"
	DeletedAt int64    `json:"deletedAt"`
	Pages     int      `json:"pages"`
	Paths     []string `json:"-"`
	place     orderPlace
}

type trashMeta struct {
	Path      string     `json:"path"`
	Kind      string     `json:"kind"`
	DeletedAt int64      `json:"deletedAt"`
	Paths     []string   `json:"paths"`
	Place     orderPlace `json:"place,omitzero"`
}

// orderPlace is where a trashed page or space sat in its folder's order:
// before the page named Before, or last if that's empty.
type orderPlace struct {
	Listed bool   `json:"listed,omitempty"`
	Before string `json:"before,omitempty"`
}

// Trash moves paths into one trash item, keeping their relative layout so
// they can go back where they came from. label is the page base or space.
// It also leaves its folder's order, which keeps its place for a restore.
func (v *Vault) Trash(label, kind string, paths ...string) (string, error) {
	id := time.Now().UTC().Format("20060102-150405") + "-" + strings.ToLower(auth.RandomString(6))
	var done []string
	for _, p := range paths {
		dst := path.Join(TrashDir, id, p)
		if err := v.root.MkdirAll(path.Dir(dst), 0o755); err != nil {
			return "", err
		}
		if err := v.root.Rename(p, dst); err != nil {
			// Put back what already moved so nothing is half-deleted.
			for _, d := range done {
				_ = v.root.Rename(path.Join(TrashDir, id, d), d)
			}
			_ = v.root.RemoveAll(path.Join(TrashDir, id))
			return "", err
		}
		done = append(done, p)
	}
	place := v.leaveOrder(Folder(label), path.Base(label))
	meta, _ := json.Marshal(trashMeta{Path: label, Kind: kind, DeletedAt: time.Now().UnixMilli(), Paths: paths, Place: place})
	_, err := v.Write(path.Join(TrashDir, id, trashMetaFile), meta)
	return id, err
}

func (v *Vault) TrashItems() ([]TrashItem, error) {
	entries, err := fs.ReadDir(v.root.FS(), TrashDir)
	if errors.Is(err, fs.ErrNotExist) {
		return []TrashItem{}, nil
	}
	if err != nil {
		return nil, err
	}
	items := []TrashItem{}
	for _, e := range entries {
		item, err := v.trashItem(e.Name())
		if err != nil {
			continue
		}
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].DeletedAt > items[j].DeletedAt })
	return items, nil
}

func (v *Vault) trashItem(id string) (TrashItem, error) {
	if checkName(id) != nil {
		return TrashItem{}, ErrNotFound
	}
	data, err := v.root.ReadFile(path.Join(TrashDir, id, trashMetaFile))
	if err != nil {
		return TrashItem{}, ErrNotFound
	}
	var m trashMeta
	if err := json.Unmarshal(data, &m); err != nil {
		return TrashItem{}, ErrNotFound
	}
	pages := 0
	_ = fs.WalkDir(v.root.FS(), path.Join(TrashDir, id), func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && IsNote(p) {
			pages++
		}
		return nil
	})
	return TrashItem{ID: id, Path: m.Path, Kind: m.Kind, DeletedAt: m.DeletedAt, Pages: pages, Paths: m.Paths, place: m.Place}, nil
}

// Restore puts a trash item back. If its old place is taken, the page or
// space comes back under a numbered name. It returns the item and the
// restored base path.
func (v *Vault) Restore(id string) (TrashItem, string, error) {
	item, err := v.trashItem(id)
	if err != nil {
		return item, "", err
	}
	base := item.Path
	switch {
	case item.Kind == "attachment":
		base = v.Unique(base)
	case v.Exists(base) || v.Exists(base+".md"):
		base = strings.TrimSuffix(v.Unique(base+".md"), ".md")
	}
	for _, p := range item.Paths {
		dst := item.RestoredPath(p, base)
		if dir := Folder(dst); dir != "" {
			if err := v.root.MkdirAll(dir, 0o755); err != nil {
				return item, "", err
			}
		}
		if err := v.root.Rename(path.Join(TrashDir, id, p), dst); err != nil {
			return item, "", err
		}
	}
	// The order is only how the sidebar sorts; a failure here loses nothing.
	_ = v.rejoinOrder(Folder(base), path.Base(base), item.place)
	return item, base, v.root.RemoveAll(path.Join(TrashDir, id))
}

// RestoredPath is where the item's path p goes back to when the item is
// restored at base.
func (it TrashItem) RestoredPath(p, base string) string {
	return base + strings.TrimPrefix(p, it.Path)
}

// TrashedPath is where the item keeps its path p while in the trash.
func (it TrashItem) TrashedPath(p string) string {
	return path.Join(TrashDir, it.ID, p)
}

// Purge deletes a trash item for good and returns it.
func (v *Vault) Purge(id string) (TrashItem, error) {
	item, err := v.trashItem(id)
	if err != nil {
		return item, err
	}
	return item, v.root.RemoveAll(path.Join(TrashDir, id))
}

// PurgeOlder deletes trash items older than age and returns them.
func (v *Vault) PurgeOlder(age time.Duration) []TrashItem {
	items, _ := v.TrashItems()
	var gone []TrashItem
	cut := time.Now().Add(-age).UnixMilli()
	for _, it := range items {
		if it.DeletedAt >= cut {
			continue
		}
		if _, err := v.Purge(it.ID); err == nil {
			gone = append(gone, it)
		}
	}
	return gone
}

// ── Backups ──

// BackupFiles lists every file worth backing up: pages, attachments, space
// settings and page orders. The trash and temporary files are left out.
func (v *Vault) BackupFiles() ([]Entry, error) {
	var out []Entry
	err := fs.WalkDir(v.root.FS(), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == "." {
				return err
			}
			return nil
		}
		if p == "." {
			return nil
		}
		hidden := strings.HasPrefix(d.Name(), ".")
		if d.IsDir() {
			if hidden {
				return fs.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || (hidden && d.Name() != spaceMetaFile && d.Name() != OrderFile && p != SectionsFile) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		out = append(out, Entry{Path: p, Size: info.Size(), ModTime: info.ModTime()})
		return nil
	})
	return out, err
}

// FilesUnder lists the files in a folder (a space), hidden ones included,
// for exports.
func (v *Vault) FilesUnder(dir string) ([]Entry, error) {
	all, err := v.BackupFiles()
	if err != nil {
		return nil, err
	}
	var out []Entry
	for _, e := range all {
		if strings.HasPrefix(e.Path, dir+"/") {
			out = append(out, e)
		}
	}
	return out, nil
}
