package vault

import (
	"encoding/json"
	"io/fs"
	"path"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"
)

// OrderFile sits in a space or a page's folder of sub-pages and lists the
// names of the pages there in the order the sidebar shows them. The one at
// the vault root (folder "") lists the spaces, in the order the app shows
// them:
//
//	.order.json              ["Product", "Home"]
//	Product/.order.json      ["Roadmap", "Ideas"]
//	Product/Roadmap/.order.json
//
// Names it doesn't list come after the listed ones, alphabetically; names
// it lists that aren't there are ignored and dropped on the next write. A
// missing or unreadable file just means alphabetical.
const OrderFile = ".order.json"

// Order is the custom order of a folder's pages, limited to those still
// there. It's nil when the folder has no order.
func (v *Vault) Order(folder string) []string {
	names := v.rawOrder(folder)
	if len(names) == 0 {
		return nil
	}
	kids := v.children(folder)
	var out []string
	seen := map[string]bool{}
	for _, n := range names {
		if kids[n] && !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	return out
}

// Orders is every folder's custom page order, keyed by folder path. The
// spaces' order isn't included; Spaces lists them in it.
func (v *Vault) Orders() map[string][]string {
	out := map[string][]string{}
	_ = fs.WalkDir(v.root.FS(), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == "." {
			return nil
		}
		if d.IsDir() {
			if strings.HasPrefix(d.Name(), ".") || p == AttachmentsDir {
				return fs.SkipDir
			}
			return nil
		}
		if d.Name() == OrderFile && strings.Contains(p, "/") {
			dir := Folder(p)
			if names := v.Order(dir); len(names) > 0 {
				out[dir] = names
			}
		}
		return nil
	})
	return out
}

// SetOrder saves a folder's order, keeping only names of pages that are
// there. An empty order removes the file.
func (v *Vault) SetOrder(folder string, names []string) error {
	kids := v.children(folder)
	clean := []string{}
	seen := map[string]bool{}
	for _, n := range names {
		if kids[n] && !seen[n] {
			seen[n] = true
			clean = append(clean, n)
		}
	}
	file := path.Join(folder, OrderFile)
	if len(clean) == 0 {
		if v.Exists(file) {
			return v.root.Remove(file)
		}
		return nil
	}
	data, err := json.MarshalIndent(clean, "", "  ")
	if err != nil {
		return err
	}
	_, err = v.Write(file, append(data, '\n'))
	return err
}

// Ordered is a folder's pages (the spaces, for "") in sidebar order: the
// listed ones first, then the rest alphabetically.
func (v *Vault) Ordered(folder string) []string {
	return v.arrange(folder, v.children(folder))
}

// arrange puts the names in a folder in that folder's order.
func (v *Vault) arrange(folder string, names map[string]bool) []string {
	var out []string
	listed := map[string]bool{}
	for _, n := range v.rawOrder(folder) {
		if names[n] && !listed[n] {
			listed[n] = true
			out = append(out, n)
		}
	}
	var rest []string
	for n := range names {
		if !listed[n] {
			rest = append(rest, n)
		}
	}
	sort.Slice(rest, func(i, j int) bool { return NaturalLess(rest[i], rest[j]) })
	return append(out, rest...)
}

// RenameInOrder changes a page's (or, for "", a space's) name in its
// folder's order, keeping its place.
func (v *Vault) RenameInOrder(folder, from, to string) error {
	names := v.rawOrder(folder)
	i := slices.Index(names, from)
	if i < 0 {
		return nil
	}
	names[i] = to
	return v.SetOrder(folder, names)
}

// RemoveFromOrder drops a page that left a folder from its order.
func (v *Vault) RemoveFromOrder(folder, name string) error {
	names := v.rawOrder(folder)
	i := slices.Index(names, name)
	if i < 0 {
		return nil
	}
	return v.SetOrder(folder, slices.Delete(names, i, i+1))
}

// leaveOrder takes a page (or space) that's going to the trash out of its
// folder's order, so the file doesn't keep names that are gone, and says
// where it was for rejoinOrder.
func (v *Vault) leaveOrder(folder, name string) orderPlace {
	names := v.rawOrder(folder)
	i := slices.Index(names, name)
	if i < 0 {
		return orderPlace{}
	}
	place := orderPlace{Listed: true}
	kids := v.children(folder)
	for _, n := range names[i+1:] {
		if kids[n] {
			place.Before = n
			break
		}
	}
	_ = v.SetOrder(folder, slices.Delete(names, i, i+1))
	return place
}

// rejoinOrder puts a restored page back where leaveOrder found it: before
// the same page if that's still listed, otherwise last.
func (v *Vault) rejoinOrder(folder, name string, place orderPlace) error {
	if !place.Listed {
		return nil
	}
	names := slices.DeleteFunc(v.Order(folder), func(n string) bool { return n == name })
	at := len(names)
	if i := slices.Index(names, place.Before); i >= 0 && place.Before != "" {
		at = i
	}
	return v.SetOrder(folder, slices.Insert(names, at, name))
}

// rawOrder is the order file as written, names that are gone included.
func (v *Vault) rawOrder(folder string) []string {
	data, err := v.root.ReadFile(path.Join(folder, OrderFile))
	if err != nil {
		return nil
	}
	var names []string
	if json.Unmarshal(data, &names) != nil {
		return nil
	}
	return names
}

// children is the set of page names in a folder: Markdown files without
// their extension, and folders of sub-pages. At the root it's the spaces;
// a Markdown file there isn't in one yet (see AdoptLoose).
func (v *Vault) children(folder string) map[string]bool {
	if folder == "" || folder == "." {
		names, _ := v.spaceNames()
		return names
	}
	out := map[string]bool{}
	entries, err := fs.ReadDir(v.root.FS(), folder)
	if err != nil {
		return out
	}
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		switch {
		case e.IsDir():
			out[name] = true
		case e.Type().IsRegular() && IsNote(name):
			out[strings.TrimSuffix(name, path.Ext(name))] = true
		}
	}
	return out
}

// NaturalLess sorts names case-insensitively with numbers by value, so
// "Page 2" comes before "Page 10", close to how the web app sorts them.
func NaturalLess(a, b string) bool {
	a, b = strings.ToLower(a), strings.ToLower(b)
	for a != "" && b != "" {
		da, db := digits(a), digits(b)
		if da > 0 && db > 0 {
			na, nb := strings.TrimLeft(a[:da], "0"), strings.TrimLeft(b[:db], "0")
			if len(na) != len(nb) {
				return len(na) < len(nb)
			}
			if na != nb {
				return na < nb
			}
			a, b = a[da:], b[db:]
			continue
		}
		ra, sa := utf8.DecodeRuneInString(a)
		rb, sb := utf8.DecodeRuneInString(b)
		if ra != rb {
			return ra < rb
		}
		a, b = a[sa:], b[sb:]
	}
	return len(a) < len(b)
}

func digits(s string) int {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	return i
}
