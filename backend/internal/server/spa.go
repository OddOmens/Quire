package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
)

const placeholderIndex = `<!doctype html><meta charset="utf-8"><title>Quire</title>
<p>The web UI has not been built. Run <code>npm run build</code> in frontend/ or build the Docker image.</p>`

// webFile is one file of the built frontend. The build leaves a Brotli
// (.br) and a gzip (.gz) copy beside every file worth compressing, and the
// smallest one the browser accepts is what gets sent.
type webFile struct {
	name   string
	ctype  string
	etag   string // validator of the uncompressed form, without quotes
	br, gz bool
}

type spa struct {
	dist  fs.FS
	files map[string]*webFile
}

// newSPA serves the built frontend. Hashed assets are cached forever; any
// other path gets index.html so client-side routes work.
func newSPA(dist fs.FS) http.Handler {
	s := &spa{dist: dist, files: map[string]*webFile{}}
	var names []string
	_ = fs.WalkDir(dist, ".", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			names = append(names, p)
		}
		return nil
	})
	have := make(map[string]bool, len(names))
	for _, n := range names {
		have[n] = true
	}
	for _, n := range names {
		// A compressed copy is never a page of its own.
		if base, ok := compressedCopyOf(n); ok && have[base] {
			continue
		}
		f := &webFile{name: n, br: have[n+".br"], gz: have[n+".gz"]}
		if f.ctype = mime.TypeByExtension(path.Ext(n)); f.ctype == "" {
			f.ctype = "application/octet-stream"
		}
		if strings.HasPrefix(n, "assets/") {
			// The build names these after their content.
			f.etag = path.Base(n)
		} else if data, err := fs.ReadFile(dist, n); err == nil {
			sum := sha256.Sum256(data)
			f.etag = hex.EncodeToString(sum[:8])
		}
		s.files[n] = f
	}
	return s
}

func compressedCopyOf(name string) (string, bool) {
	for _, ext := range []string{".br", ".gz"} {
		if base, ok := strings.CutSuffix(name, ext); ok {
			return base, true
		}
	}
	return "", false
}

func (s *spa) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if p != "" && p != "index.html" {
		if f := s.files[p]; f != nil {
			switch {
			case strings.HasPrefix(p, "assets/"):
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			case p == "sw.js" || p == "manifest.webmanifest":
				w.Header().Set("Cache-Control", "no-cache")
			default:
				w.Header().Set("Cache-Control", "public, max-age=3600")
			}
			s.serve(w, r, f)
			return
		}
		if strings.HasPrefix(p, "assets/") {
			http.NotFound(w, r)
			return
		}
	}
	w.Header().Set("Cache-Control", "no-cache")
	index := s.files["index.html"]
	if index == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, placeholderIndex)
		return
	}
	s.serve(w, r, index)
}

// serve sends one file, compressed when the browser takes it. The caller
// has set Cache-Control.
func (s *spa) serve(w http.ResponseWriter, r *http.Request, f *webFile) {
	h := w.Header()
	name, etag, enc := f.name, f.etag, ""
	if f.br || f.gz {
		h.Add("Vary", "Accept-Encoding")
		br, gz := acceptedEncodings(r.Header.Get("Accept-Encoding"))
		switch {
		case br && f.br:
			name, etag, enc = name+".br", etag+"-br", "br"
		case gz && f.gz:
			name, etag, enc = name+".gz", etag+"-gz", "gzip"
		}
	}
	file, err := s.dist.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	h.Set("Content-Type", f.ctype)
	if etag != "" {
		h.Set("ETag", `"`+etag+`"`)
	}
	if enc == "" {
		// As it is, with byte ranges and conditional requests.
		rs, ok := file.(io.ReadSeeker)
		if !ok {
			data, err := io.ReadAll(file)
			if err != nil {
				http.Error(w, "read failed", http.StatusInternalServerError)
				return
			}
			rs = bytes.NewReader(data)
		}
		http.ServeContent(w, r, "", noTime, rs)
		return
	}
	h.Set("Content-Encoding", enc)
	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	if info, err := file.Stat(); err == nil {
		h.Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	}
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = io.Copy(w, file)
	}
}
