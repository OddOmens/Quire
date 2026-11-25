package server

import (
	"compress/gzip"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

var noTime time.Time

// acceptedEncodings reads an Accept-Encoding header: whether the client
// takes Brotli and gzip. "br;q=0" refuses one; "*" covers what isn't named.
func acceptedEncodings(header string) (br, gz bool) {
	star, brSet, gzSet := false, false, false
	for _, part := range strings.Split(header, ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		ok := true
		for _, p := range strings.Split(params, ";") {
			if k, v, found := strings.Cut(strings.TrimSpace(p), "="); found && strings.EqualFold(strings.TrimSpace(k), "q") {
				if q, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil && q <= 0 {
					ok = false
				}
			}
		}
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "br":
			br, brSet = ok, true
		case "gzip", "x-gzip":
			gz, gzSet = ok, true
		case "*":
			star = ok
		}
	}
	if star {
		if !brSet {
			br = true
		}
		if !gzSet {
			gz = true
		}
	}
	return br, gz
}

// etagMatches reports whether an If-None-Match header names etag (given
// without quotes). Weak and strong forms both count, as for any GET.
func etagMatches(header, etag string) bool {
	if etag == "" {
		return false
	}
	for _, part := range strings.Split(header, ",") {
		part = strings.TrimPrefix(strings.TrimSpace(part), "W/")
		if part == "*" || strings.Trim(part, `"`) == etag {
			return true
		}
	}
	return false
}

// gzipMinSize is the smallest JSON body worth compressing; below it the
// gzip framing and CPU cost more than they save.
const gzipMinSize = 1024

var gzipPool = sync.Pool{New: func() any {
	zw, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed+2)
	return zw
}}

// gzipJSON compresses the JSON answers to GET requests under /api/ for
// clients that take gzip. Everything else goes through untouched: other
// methods (sign-in and setup answers carry secrets), event streams, files,
// byte ranges, and anything a handler has already encoded. skip names
// requests to leave alone whatever they answer with.
func gzipJSON(next http.Handler, skip func(*http.Request) bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || !strings.HasPrefix(r.URL.Path, "/api/") || r.Header.Get("Range") != "" || (skip != nil && skip(r)) {
			next.ServeHTTP(w, r)
			return
		}
		if _, gz := acceptedEncodings(r.Header.Get("Accept-Encoding")); !gz {
			next.ServeHTTP(w, r)
			return
		}
		gw := &gzipWriter{ResponseWriter: w}
		next.ServeHTTP(gw, r)
		gw.finish()
	})
}

// gzipWriter holds a response back until it knows what it is: JSON of at
// least gzipMinSize bytes is compressed, anything else is passed on as is.
type gzipWriter struct {
	http.ResponseWriter
	status int
	wrote  bool         // the handler has set a status
	plain  bool         // passing through uncompressed
	zw     *gzip.Writer // compressing
	held   []byte       // body so far, while still undecided
}

func (w *gzipWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *gzipWriter) WriteHeader(code int) {
	if w.wrote {
		return
	}
	w.wrote, w.status = true, code
	if !w.compressible() {
		w.passThrough()
	}
}

// compressible reports whether the response, as its headers stand, is a
// plain JSON document.
func (w *gzipWriter) compressible() bool {
	h := w.Header()
	if w.status != http.StatusOK || h.Get("Content-Encoding") != "" || h.Get("Content-Range") != "" ||
		h.Get("Accept-Ranges") != "" || h.Get("Content-Disposition") != "" {
		return false
	}
	ctype, _, err := mime.ParseMediaType(h.Get("Content-Type"))
	return err == nil && ctype == "application/json"
}

func (w *gzipWriter) passThrough() {
	w.plain = true
	w.ResponseWriter.WriteHeader(w.status)
	if len(w.held) > 0 {
		_, _ = w.ResponseWriter.Write(w.held)
		w.held = nil
	}
}

func (w *gzipWriter) Write(p []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	switch {
	case w.plain:
		return w.ResponseWriter.Write(p)
	case w.zw != nil:
		return w.zw.Write(p)
	}
	w.held = append(w.held, p...)
	if len(w.held) >= gzipMinSize {
		h := w.Header()
		h.Set("Content-Encoding", "gzip")
		h.Add("Vary", "Accept-Encoding")
		h.Del("Content-Length")
		w.ResponseWriter.WriteHeader(w.status)
		w.zw = gzipPool.Get().(*gzip.Writer)
		w.zw.Reset(w.ResponseWriter)
		held := w.held
		w.held = nil
		if _, err := w.zw.Write(held); err != nil {
			return 0, err
		}
	}
	return len(p), nil
}

// Flush sends what there is. A handler that flushes is streaming, so a
// response still undecided goes out as it is.
func (w *gzipWriter) Flush() {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	if w.zw != nil {
		_ = w.zw.Flush()
	} else if !w.plain {
		w.passThrough()
	}
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

// finish ends the response once the handler has returned.
func (w *gzipWriter) finish() {
	switch {
	case w.zw != nil:
		_ = w.zw.Close()
		w.zw.Reset(io.Discard)
		gzipPool.Put(w.zw)
		w.zw = nil
	case w.wrote && !w.plain:
		w.passThrough()
	}
}
