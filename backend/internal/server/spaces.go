package server

import (
	"archive/zip"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/oddomens/quire/internal/vault"
)

type space struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Color       string `json:"color"`
	Icon        string `json:"icon,omitempty"`
	// Section is the heading the space is under in the space menu, if any.
	Section string `json:"section,omitempty"`
	Pages   int    `json:"pages"`
	Updated     int64  `json:"updated"`
}

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// iconName is a Lucide icon name, like "book-open" or "gamepad-2". The server
// doesn't know the icon set itself; clients show the initials for names they
// don't have.
var iconName = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

const maxIconLen = 48

func validIcon(name string) bool {
	return len(name) <= maxIconLen && iconName.MatchString(name)
}

// spaceOut is a space's settings as the API shows them, with a hand-edited
// bad colour or icon in .space.json replaced or dropped.
func spaceOut(name string, m vault.SpaceMeta) space {
	sp := space{Name: name, Description: m.Description, Color: m.Color, Icon: m.Icon}
	if !hexColor.MatchString(sp.Color) {
		sp.Color = defaultColor(name)
	}
	if !validIcon(sp.Icon) {
		sp.Icon = ""
	}
	return sp
}

// spaceColors are offered in the UI; a space gets one by default.
var spaceColors = []string{"#4c6ef5", "#12b886", "#fa5252", "#f59f00", "#7950f2", "#15aabf", "#e64980", "#82c91e"}

func defaultColor(name string) string {
	h := 0
	for _, r := range name {
		h = h*31 + int(r)
	}
	if h < 0 {
		h = -h
	}
	return spaceColors[h%len(spaceColors)]
}

func cleanDescription(d string) string {
	d = strings.Join(strings.Fields(d), " ")
	if r := []rune(d); len(r) > 280 {
		d = string(r[:280])
	}
	return d
}

// spaces lists the spaces in the order you arranged them: those under no
// heading first, then each section's (see vault.SectionsFile).
func (s *Server) spaces(w http.ResponseWriter, r *http.Request) {
	out, err := s.spaceList()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) spaceList() ([]space, error) {
	names, err := s.vault.Spaces()
	if err != nil {
		return nil, err
	}
	notes, err := s.store.Notes()
	if err != nil {
		return nil, err
	}
	sectionOf := map[string]string{}
	var sectioned []string
	for _, sec := range s.vault.Sections() {
		for _, n := range sec.Spaces {
			sectionOf[n] = sec.Name
			sectioned = append(sectioned, n)
		}
	}
	names = append(slices.DeleteFunc(names, func(n string) bool { return sectionOf[n] != "" }), sectioned...)
	out := make([]space, 0, len(names))
	for _, n := range names {
		sp := spaceOut(n, s.vault.SpaceMeta(n))
		sp.Section = sectionOf[n]
		for _, note := range notes {
			if vault.SpaceOf(note.Path) == n {
				sp.Pages++
				sp.Updated = max(sp.Updated, note.Mtime)
			}
		}
		out = append(out, sp)
	}
	return out, nil
}

// spaceSections is the space menu's headings, empty ones included, each with
// its spaces in order.
func (s *Server) spaceSections(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.vault.Sections())
}

// arrangeSpaces sets the order spaces are listed in. names is every space
// in its new place; any it leaves out follow in their current order. With
// sections, it also sets the headings and which spaces go under each; names
// then orders the spaces under no heading. Without, each space stays under
// its heading, in the new order.
func (s *Server) arrangeSpaces(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Names    []string         `json:"names"`
		Sections *[]vault.Section `json:"sections"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	current, err := s.vault.Spaces()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	order := make([]string, 0, len(current))
	for _, n := range req.Names {
		switch {
		case !slices.Contains(current, n):
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("there's no space called %q", n))
			return
		case slices.Contains(order, n):
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("%q is listed twice", n))
			return
		}
		order = append(order, n)
	}
	for _, n := range current {
		if !slices.Contains(order, n) {
			order = append(order, n)
		}
	}
	var sections []vault.Section
	if req.Sections != nil {
		if sections, err = checkSections(*req.Sections, current); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	} else {
		// Same headings, each one's spaces in the new order.
		sections = s.vault.Sections()
		for i := range sections {
			slices.SortStableFunc(sections[i].Spaces, func(a, b string) int {
				return slices.Index(order, a) - slices.Index(order, b)
			})
		}
	}
	// The order file lists the spaces as the menu shows them, so tools that
	// only read it (and Obsidian plugins) see the same order.
	var sectioned []string
	for _, sec := range sections {
		sectioned = append(sectioned, sec.Spaces...)
	}
	order = append(slices.DeleteFunc(order, func(n string) bool { return slices.Contains(sectioned, n) }), sectioned...)
	if err := s.vault.SetSections(sections); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.vault.SetOrder("", order); err != nil {
		s.fail(w, r, err)
		return
	}
	s.publish(r, "tree", order...)
	s.spaces(w, r)
}

// appendSpace puts a new space last, when the spaces have a custom order.
// Without one they stay alphabetical. Callers hold writeMu.
func (s *Server) appendSpace(name string) {
	if s.vault.Order("") == nil {
		return
	}
	names := slices.DeleteFunc(s.vault.Ordered(""), func(n string) bool { return n == name })
	if err := s.vault.SetOrder("", append(names, name)); err != nil {
		s.log.Warn("update space order", "space", name, "err", err)
	}
}

// checkSections cleans the headings sent to arrangeSpaces: each has a name,
// no two share one, and a space is under one at most.
func checkSections(in []vault.Section, spaces []string) ([]vault.Section, error) {
	if len(in) > vault.MaxSections {
		return nil, fmt.Errorf("%d sections at most", vault.MaxSections)
	}
	out := make([]vault.Section, 0, len(in))
	names, used := map[string]bool{}, map[string]bool{}
	for _, sec := range in {
		name := vault.CleanSectionName(sec.Name)
		switch {
		case name == "":
			return nil, fmt.Errorf("a section needs a name of up to %d characters", vault.MaxSectionNameLn)
		case names[strings.ToLower(name)]:
			return nil, fmt.Errorf("there are two sections called %q", name)
		}
		names[strings.ToLower(name)] = true
		clean := vault.Section{Name: name, Spaces: []string{}}
		for _, n := range sec.Spaces {
			switch {
			case !slices.Contains(spaces, n):
				return nil, fmt.Errorf("there's no space called %q", n)
			case used[n]:
				return nil, fmt.Errorf("%q is in two sections", n)
			}
			used[n] = true
			clean.Spaces = append(clean.Spaces, n)
		}
		out = append(out, clean)
	}
	return out, nil
}

type spaceRequest struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
	Color       *string `json:"color"`
	Icon        *string `json:"icon"`
}

// icon reads the requested icon: set is false when the request leaves it
// alone, and an empty icon clears it back to the initials.
func (req spaceRequest) icon(w http.ResponseWriter) (icon string, set, ok bool) {
	if req.Icon == nil {
		return "", false, true
	}
	icon = strings.TrimSpace(*req.Icon)
	if icon != "" && !validIcon(icon) {
		writeErr(w, http.StatusBadRequest, `icon must be a Lucide icon name like "book-open"`)
		return "", false, false
	}
	return icon, true, true
}

func (s *Server) createSpace(w http.ResponseWriter, r *http.Request) {
	var req spaceRequest
	if !readJSON(w, r, &req) {
		return
	}
	if req.Name == nil {
		writeErr(w, http.StatusBadRequest, "name the space")
		return
	}
	icon, _, ok := req.icon(w)
	if !ok {
		return
	}
	name, err := vault.CleanSpace(pageName(*req.Name))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	meta := vault.SpaceMeta{Color: defaultColor(name), Icon: icon}
	if req.Description != nil {
		meta.Description = cleanDescription(*req.Description)
	}
	if req.Color != nil && hexColor.MatchString(*req.Color) {
		meta.Color = strings.ToLower(*req.Color)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.spaceExists(name) {
		s.fail(w, r, vault.ErrExists)
		return
	}
	if err := s.vault.Mkdir(name); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.vault.SetSpaceMeta(name, meta); err != nil {
		s.fail(w, r, err)
		return
	}
	s.appendSpace(name)
	s.publish(r, "tree", name)
	writeJSON(w, http.StatusCreated, spaceOut(name, meta))
}

// spaceExists also catches names differing only in case, which would clash
// on macOS and Windows file systems.
func (s *Server) spaceExists(name string) bool {
	names, _ := s.vault.Spaces()
	for _, n := range names {
		if strings.EqualFold(n, name) {
			return true
		}
	}
	return s.vault.Exists(name)
}

func (s *Server) updateSpace(w http.ResponseWriter, r *http.Request) {
	old, err := vault.CleanSpace(r.PathValue("name"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var req spaceRequest
	if !readJSON(w, r, &req) {
		return
	}
	icon, setIcon, ok := req.icon(w)
	if !ok {
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if !s.vault.IsDir(old) {
		s.fail(w, r, vault.ErrNotFound)
		return
	}
	name := old
	if req.Name != nil {
		if name, err = vault.CleanSpace(pageName(*req.Name)); err != nil {
			s.fail(w, r, err)
			return
		}
		if name != old {
			if !strings.EqualFold(name, old) && s.spaceExists(name) {
				s.fail(w, r, vault.ErrExists)
				return
			}
			if _, err := s.relocate(r, old, name); err != nil {
				s.fail(w, r, err)
				return
			}
		}
	}
	meta := s.vault.SpaceMeta(name)
	if req.Description != nil {
		meta.Description = cleanDescription(*req.Description)
	}
	if req.Color != nil && hexColor.MatchString(*req.Color) {
		meta.Color = strings.ToLower(*req.Color)
	}
	if setIcon {
		meta.Icon = icon
	}
	if err := s.vault.SetSpaceMeta(name, meta); err != nil {
		s.fail(w, r, err)
		return
	}
	s.publish(r, "tree", name)
	writeJSON(w, http.StatusOK, spaceOut(name, meta))
}

func (s *Server) deleteSpace(w http.ResponseWriter, r *http.Request) {
	name, err := vault.CleanSpace(r.PathValue("name"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if !s.vault.IsDir(name) {
		s.fail(w, r, vault.ErrNotFound)
		return
	}
	if err := s.trashBase(r, name, "space"); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type spaceStats struct {
	space
	Folder   string     `json:"folder"`
	TopLevel int        `json:"topLevel"`
	Nested   int        `json:"nested"`
	Words    int        `json:"words"`
	Size     int64      `json:"size"`
	Files    int        `json:"files"`
	Created  int64      `json:"created"`
	Shared   int        `json:"shared"`
	Links    int        `json:"links"`
	Tags     []tagCount `json:"tags"`
}

type tagCount struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

// spaceDetails is the space settings page: its settings plus numbers about it.
func (s *Server) spaceDetails(w http.ResponseWriter, r *http.Request) {
	name, err := vault.CleanSpace(r.PathValue("name"))
	if err != nil || !s.vault.IsDir(name) {
		s.fail(w, r, vault.ErrNotFound)
		return
	}
	out := spaceStats{space: spaceOut(name, s.vault.SpaceMeta(name)), Folder: name + "/", Tags: []tagCount{}}
	notes, err := s.store.Notes()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	tags := map[string]int{}
	for _, n := range notes {
		if vault.SpaceOf(n.Path) != name {
			continue
		}
		out.Pages++
		if strings.Count(n.Path, "/") == 1 {
			out.TopLevel++
		} else {
			out.Nested++
		}
		out.Words += n.Words
		out.Updated = max(out.Updated, n.Mtime)
		if out.Created == 0 || n.Mtime < out.Created {
			out.Created = n.Mtime
		}
		for _, t := range n.Tags {
			tags[t]++
		}
	}
	files, err := s.vault.FilesUnder(name)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	for _, f := range files {
		out.Size += f.Size
	}
	out.Files = len(files)
	if shares, err := s.store.Shares(); err == nil {
		for _, sh := range shares {
			if vault.SpaceOf(sh.Path) == name {
				out.Shared++
			}
		}
	}
	if g, err := s.store.Graph(""); err == nil {
		for _, e := range g.Edges {
			if vault.SpaceOf(e.Source) == name || vault.SpaceOf(e.Target) == name {
				out.Links++
			}
		}
	}
	for t, c := range tags {
		out.Tags = append(out.Tags, tagCount{t, c})
	}
	sort.Slice(out.Tags, func(i, j int) bool {
		return out.Tags[i].Count > out.Tags[j].Count || out.Tags[i].Count == out.Tags[j].Count && out.Tags[i].Tag < out.Tags[j].Tag
	})
	if len(out.Tags) > 12 {
		out.Tags = out.Tags[:12]
	}
	writeJSON(w, http.StatusOK, out)
}

var attachmentRef = regexp.MustCompile(`attachments/[^\s)\]"'|#]+|!\[\[([^\]|#]+)`)

// attachmentRefs is the set of attachments a page links or embeds, as
// cleaned vault paths.
func attachmentRefs(content string) map[string]bool {
	out := map[string]bool{}
	for _, m := range attachmentRef.FindAllStringSubmatch(content, -1) {
		p := m[0]
		if m[1] != "" {
			p = vault.AttachmentsDir + "/" + strings.TrimSpace(m[1])
		}
		if u, err := url.PathUnescape(p); err == nil {
			p = u
		}
		if c, err := vault.Clean(p); err == nil && vault.SpaceOf(c) == vault.AttachmentsDir {
			out[c] = true
		}
	}
	return out
}

// exportSpace downloads a space as a zip: its pages, its settings, and the
// attachments its pages use.
func (s *Server) exportSpace(w http.ResponseWriter, r *http.Request) {
	name, err := vault.CleanSpace(r.PathValue("name"))
	if err != nil || !s.vault.IsDir(name) {
		s.fail(w, r, vault.ErrNotFound)
		return
	}
	files, err := s.vault.FilesUnder(name)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	paths := []string{}
	used := map[string]bool{}
	for _, f := range files {
		paths = append(paths, f.Path)
		if !vault.IsNote(f.Path) {
			continue
		}
		content, _, err := s.vault.Read(f.Path)
		if err != nil {
			continue
		}
		for c := range attachmentRefs(string(content)) {
			if !used[c] && s.vault.IsFile(c) {
				used[c] = true
				paths = append(paths, c)
			}
		}
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name + ".zip"}))
	w.Header().Set("Cache-Control", "no-store")
	zw := zip.NewWriter(w)
	for _, p := range paths {
		f, err := s.vault.Open(p)
		if err != nil {
			continue
		}
		info, _ := f.Stat()
		hdr := &zip.FileHeader{Name: p, Method: zip.Deflate}
		if info != nil {
			hdr.Modified = info.ModTime()
		}
		if zf, err := zw.CreateHeader(hdr); err == nil {
			_, _ = io.Copy(zf, f)
		}
		f.Close()
	}
	if err := zw.Close(); err != nil {
		s.log.Warn("export space", "space", name, "err", err)
	}
}
