package vault

import (
	"io/fs"
	"path"
	"sort"
	"strings"
)

// Attachments lists the files in the attachments folder, sub-folders
// included and hidden files left out.
func (v *Vault) Attachments() ([]Entry, error) {
	var out []Entry
	err := fs.WalkDir(v.root.FS(), AttachmentsDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == AttachmentsDir {
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		out = append(out, Entry{Path: p, Size: info.Size(), ModTime: info.ModTime()})
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, err
}

// TrashedPage is a page inside a trash item.
type TrashedPage struct {
	// Path is where the page was before it was deleted.
	Path string
	// File is where it is now, in the trash.
	File string
}

// TrashedPages lists the pages held in the trash.
func (v *Vault) TrashedPages() []TrashedPage {
	items, _ := v.TrashItems()
	var out []TrashedPage
	for _, it := range items {
		dir := path.Join(TrashDir, it.ID)
		_ = fs.WalkDir(v.root.FS(), dir, func(p string, d fs.DirEntry, err error) error {
			if err == nil && d.Type().IsRegular() && IsNote(p) {
				out = append(out, TrashedPage{Path: strings.TrimPrefix(p, dir+"/"), File: p})
			}
			return nil
		})
	}
	return out
}
