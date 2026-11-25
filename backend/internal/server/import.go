package server

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/oddomens/quire/internal/importer"
	"github.com/oddomens/quire/internal/vault"
)

// importPrefix names the temporary files an upload is kept in while it's
// imported; any left by a crash are removed at startup.
const importPrefix = "quire-import-"

func (s *Server) tempDir() string {
	if s.cfg.TempDir != "" {
		return s.cfg.TempDir
	}
	return os.TempDir()
}

// removeImportLeftovers deletes uploads a crash left in the temp folder.
func (s *Server) removeImportLeftovers() {
	if s.cfg.TempDir == "" {
		return
	}
	old, _ := filepath.Glob(filepath.Join(s.cfg.TempDir, importPrefix+"*"))
	for _, p := range old {
		_ = os.RemoveAll(p)
	}
}

type importSummary struct {
	Space       string             `json:"space"`
	Pages       int                `json:"pages"`
	Attachments int                `json:"attachments"`
	FirstPage   string             `json:"firstPage,omitempty"`
	Renamed     []importer.Renamed `json:"renamed"`
	Skipped     []importer.Skipped `json:"skipped"`
}

// importNotes brings in a zip of Markdown (or a few loose files) as pages
// of a space: an existing one (?space=) or a new one (?newSpace=). The body
// is multipart with one or more "file" parts. Nothing in the vault is
// overwritten; see package importer.
func (s *Server) importNotes(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	space, create := q.Get("space"), false
	if n := q.Get("newSpace"); n != "" {
		space, create = pageName(n), true
	}
	space, err := vault.CleanSpace(space)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "choose a space, or name a new one")
		return
	}

	// A large zip over a slow link takes longer than the server's usual
	// read timeout.
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(30 * time.Minute))
	dir, err := os.MkdirTemp(s.tempDir(), importPrefix)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	defer os.RemoveAll(dir)
	files, closeFiles, err := s.receiveImport(w, r, dir)
	if closeFiles != nil {
		defer closeFiles()
	}
	if err != nil {
		var refused importer.ErrRefused
		if errors.As(err, &refused) {
			writeErr(w, http.StatusBadRequest, refused.Reason)
		} else {
			writeErr(w, http.StatusBadRequest, "the upload didn't arrive whole; try again")
		}
		return
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	switch {
	case create && s.spaceExists(space):
		writeErr(w, http.StatusConflict, "there's already a space with that name")
		return
	case !create && !s.vault.IsDir(space):
		writeErr(w, http.StatusNotFound, "that space doesn't exist")
		return
	}
	res, err := s.store.Resolver()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	plan, err := importer.Build(files, space, importTarget{s.vault, res})
	if err != nil {
		var refused importer.ErrRefused
		if errors.As(err, &refused) {
			writeErr(w, http.StatusBadRequest, refused.Reason)
			return
		}
		s.fail(w, r, err)
		return
	}
	if len(plan.Pages) == 0 {
		writeErr(w, http.StatusBadRequest, "there are no Markdown pages in the upload")
		return
	}
	if create {
		if err := s.vault.Mkdir(space); err != nil {
			s.fail(w, r, err)
			return
		}
		if err := s.vault.SetSpaceMeta(space, vault.SpaceMeta{Color: defaultColor(space)}); err != nil {
			s.fail(w, r, err)
			return
		}
		s.appendSpace(space)
	}

	out := importSummary{Space: space, Renamed: plan.Renamed, Skipped: plan.Skipped}
	changed := []string{space}
	defer func() { s.publish(r, "tree", changed...) }()
	for _, a := range plan.Attachments {
		if err := s.importFile(a); err != nil {
			s.log.Error("import attachment", "path", a.Path, "err", err)
			writeErr(w, http.StatusInternalServerError, fmt.Sprintf("the import stopped at %s; what came before it was kept", a.From.Name))
			return
		}
		out.Attachments++
	}
	for _, p := range plan.Pages {
		e, err := s.vault.Create(p.Path, p.Content)
		if err == nil {
			err = s.store.Put(e, p.Content)
		}
		if err != nil {
			s.log.Error("import page", "path", p.Path, "err", err)
			writeErr(w, http.StatusInternalServerError, fmt.Sprintf("the import stopped at %s; what came before it was kept", p.Path))
			return
		}
		if err := s.store.Record(p.Path, nil, p.Content, "import"); err != nil {
			s.log.Warn("record history", "path", p.Path, "err", err)
		}
		changed = append(changed, p.Path)
		if out.FirstPage == "" {
			out.FirstPage = p.Path
		}
		out.Pages++
	}
	s.log.Info("imported pages", "space", space, "pages", out.Pages, "attachments", out.Attachments, "skipped", len(out.Skipped))
	writeJSON(w, http.StatusOK, out)
}

// importFile copies one file into attachments/, never over an existing one.
func (s *Server) importFile(a importer.Attachment) error {
	if s.vault.Exists(a.Path) {
		return vault.ErrExists
	}
	rc, err := a.From.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	_, err = s.vault.WriteFrom(a.Path, rc)
	return err
}

// receiveImport saves the uploaded parts in dir and lists them as import
// files: a zip's entries, or the loose files themselves. The upload is
// capped at importer.MaxZipSize.
func (s *Server) receiveImport(w http.ResponseWriter, r *http.Request, dir string) ([]importer.File, func(), error) {
	r.Body = http.MaxBytesReader(w, r.Body, importer.MaxZipSize+1<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, nil, err
	}
	type saved struct {
		name, file string
		size       int64
	}
	var parts []saved
	var total int64
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, err
		}
		if part.FormName() != "file" {
			part.Close()
			continue
		}
		if len(parts) >= importer.MaxEntries {
			return nil, nil, importer.ErrRefused{Reason: fmt.Sprintf("that's more than %d files", importer.MaxEntries)}
		}
		file := filepath.Join(dir, fmt.Sprint(len(parts)))
		f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return nil, nil, err
		}
		n, err := io.Copy(f, io.LimitReader(part, importer.MaxZipSize-total+1))
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		part.Close()
		if err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				return nil, nil, importer.ErrRefused{Reason: "the upload is over 500 MB"}
			}
			return nil, nil, err
		}
		if total += n; total > importer.MaxZipSize {
			return nil, nil, importer.ErrRefused{Reason: "the upload is over 500 MB"}
		}
		name := strings.ReplaceAll(part.FileName(), `\`, "/")
		if name == "" {
			name = "file"
		}
		parts = append(parts, saved{name: name, file: file, size: n})
	}
	if len(parts) == 0 {
		return nil, nil, importer.ErrRefused{Reason: "choose a .zip or some Markdown files to import"}
	}

	zips := 0
	for _, p := range parts {
		if strings.EqualFold(path.Ext(p.name), ".zip") {
			zips++
		}
	}
	if zips > 0 {
		if len(parts) > 1 {
			return nil, nil, importer.ErrRefused{Reason: "import one .zip at a time, or Markdown files without a zip"}
		}
		zr, err := zip.OpenReader(parts[0].file)
		if err != nil {
			return nil, nil, importer.ErrRefused{Reason: "that file isn't a zip Quire can read"}
		}
		files, err := importer.FromZip(&zr.Reader)
		closeZip := func() { zr.Close() }
		return files, closeZip, err
	}

	files := make([]importer.File, 0, len(parts))
	for _, p := range parts {
		file := p.file
		files = append(files, importer.File{
			// Browsers send the name alone; a path that came along is kept.
			Name: strings.TrimLeft(p.name, "/"),
			Size: p.size,
			Mode: 0o600,
			Open: func() (io.ReadCloser, error) { return os.Open(file) },
		})
	}
	return files, nil, nil
}

// importTarget answers the importer's questions about the vault.
type importTarget struct {
	v   *vault.Vault
	res interface{ HasTitle(string) bool }
}

func (t importTarget) Exists(p string) bool { return t.v.Exists(p) }

func (t importTarget) HasTitle(title string) bool { return t.res.HasTitle(title) }
