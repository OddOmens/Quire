package vault

import (
	"encoding/json"
	"slices"
	"strings"
	"unicode/utf8"
)

// SectionsFile sits at the vault root and groups the spaces under headings
// in the space menu, in order. Spaces it doesn't list come first, with no
// heading, in the root OrderFile's order:
//
//	.sections.json   [{"name": "Knowledge", "spaces": ["Animals", "Plants"]},
//	                  {"name": "Work", "spaces": []}]
//
// A section can be empty. Spaces that are gone are ignored and dropped on
// the next write. A missing or unreadable file means no sections.
const SectionsFile = ".sections.json"

// Section is a heading in the space menu and the spaces under it.
type Section struct {
	Name   string   `json:"name"`
	Spaces []string `json:"spaces"`
}

const (
	MaxSections      = 50
	MaxSectionNameLn = 60
)

// CleanSectionName trims a heading and collapses its spaces; "" when it
// can't be a heading.
func CleanSectionName(name string) string {
	name = strings.Join(strings.Fields(name), " ")
	if name == "" || utf8.RuneCountInString(name) > MaxSectionNameLn {
		return ""
	}
	return name
}

// Sections is the space menu's headings, each with the spaces under it that
// are still there, in order. A space is under one heading at most.
func (v *Vault) Sections() []Section {
	data, err := v.root.ReadFile(SectionsFile)
	if err != nil {
		return nil
	}
	var raw []Section
	if json.Unmarshal(data, &raw) != nil {
		return nil
	}
	names, _ := v.spaceNames()
	out := []Section{}
	usedSpace, usedName := map[string]bool{}, map[string]bool{}
	for _, s := range raw {
		name := CleanSectionName(s.Name)
		if name == "" || usedName[strings.ToLower(name)] || len(out) == MaxSections {
			continue
		}
		usedName[strings.ToLower(name)] = true
		sec := Section{Name: name, Spaces: []string{}}
		for _, sp := range s.Spaces {
			if names[sp] && !usedSpace[sp] {
				usedSpace[sp] = true
				sec.Spaces = append(sec.Spaces, sp)
			}
		}
		out = append(out, sec)
	}
	return out
}

// SetSections saves the headings. No headings removes the file.
func (v *Vault) SetSections(sections []Section) error {
	if len(sections) == 0 {
		if v.Exists(SectionsFile) {
			return v.root.Remove(SectionsFile)
		}
		return nil
	}
	data, err := json.MarshalIndent(sections, "", "  ")
	if err != nil {
		return err
	}
	_, err = v.Write(SectionsFile, append(data, '\n'))
	return err
}

// RenameInSections keeps a renamed space under its heading, in its place.
func (v *Vault) RenameInSections(from, to string) error {
	secs := v.rawSections()
	changed := false
	for i := range secs {
		if j := slices.Index(secs[i].Spaces, from); j >= 0 {
			secs[i].Spaces[j] = to
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return v.SetSections(secs)
}

// rawSections is the file as written, spaces that are gone included.
func (v *Vault) rawSections() []Section {
	data, err := v.root.ReadFile(SectionsFile)
	if err != nil {
		return nil
	}
	var secs []Section
	if json.Unmarshal(data, &secs) != nil {
		return nil
	}
	return secs
}
