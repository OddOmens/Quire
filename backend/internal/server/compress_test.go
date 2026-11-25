package server

import (
	"bufio"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

// rawClient doesn't ask for or undo compression on its own.
var rawClient = &http.Client{Transport: &http.Transport{DisableCompression: true}}

func testSPA() http.Handler {
	return newSPA(fstest.MapFS{
		"index.html":              {Data: []byte("<!doctype html>index")},
		"index.html.br":           {Data: []byte("BR-index")},
		"index.html.gz":           {Data: []byte("GZ-index")},
		"assets/app-abc123.js":    {Data: []byte("console.log('app')")},
		"assets/app-abc123.js.br": {Data: []byte("BR-app")},
		"assets/app-abc123.js.gz": {Data: []byte("GZ-app")},
		"assets/tiny-def456.js":   {Data: []byte("1")},
		"favicon.svg":             {Data: []byte("<svg/>")},
		"notes.gz":                {Data: []byte("a real .gz file")},
	})
}

func spaGet(t *testing.T, method, path string, header map[string]string) (*http.Response, string) {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	testSPA().ServeHTTP(rec, req)
	res := rec.Result()
	body, _ := io.ReadAll(res.Body)
	return res, string(body)
}

func TestSPAPicksTheSmallestEncoding(t *testing.T) {
	cases := []struct{ accept, encoding, body string }{
		{"gzip, deflate, br, zstd", "br", "BR-app"},
		{"gzip, deflate", "gzip", "GZ-app"},
		{"br;q=0, gzip;q=0.5", "gzip", "GZ-app"},
		{"gzip;q=0, *", "br", "BR-app"},
		{"", "", "console.log('app')"},
		{"identity", "", "console.log('app')"},
		{"br;q=0, gzip;q=0", "", "console.log('app')"},
	}
	for _, c := range cases {
		res, body := spaGet(t, "GET", "/assets/app-abc123.js", map[string]string{"Accept-Encoding": c.accept})
		if res.StatusCode != 200 || res.Header.Get("Content-Encoding") != c.encoding || body != c.body {
			t.Errorf("Accept-Encoding %q: %d, encoding %q, body %q", c.accept, res.StatusCode, res.Header.Get("Content-Encoding"), body)
		}
		if res.Header.Get("Vary") != "Accept-Encoding" {
			t.Errorf("Accept-Encoding %q: Vary = %q", c.accept, res.Header.Get("Vary"))
		}
		if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "javascript") {
			t.Errorf("Accept-Encoding %q: Content-Type = %q", c.accept, ct)
		}
		if cc := res.Header.Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
			t.Errorf("Cache-Control = %q", cc)
		}
		if cl := res.Header.Get("Content-Length"); cl != fmt.Sprint(len(c.body)) {
			t.Errorf("Accept-Encoding %q: Content-Length = %q, want %d", c.accept, cl, len(c.body))
		}
	}
}

func TestSPAHeadAndNotModified(t *testing.T) {
	for _, accept := range []string{"br", "gzip", ""} {
		get, _ := spaGet(t, "GET", "/assets/app-abc123.js", map[string]string{"Accept-Encoding": accept})
		etag := get.Header.Get("ETag")
		if etag == "" {
			t.Fatalf("%q: no ETag", accept)
		}
		head, body := spaGet(t, "HEAD", "/assets/app-abc123.js", map[string]string{"Accept-Encoding": accept})
		if head.StatusCode != 200 || body != "" || head.Header.Get("Content-Length") != get.Header.Get("Content-Length") ||
			head.Header.Get("Content-Encoding") != get.Header.Get("Content-Encoding") || head.Header.Get("ETag") != etag {
			t.Errorf("%q: HEAD %d body %q headers %v", accept, head.StatusCode, body, head.Header)
		}
		same, body := spaGet(t, "GET", "/assets/app-abc123.js", map[string]string{"Accept-Encoding": accept, "If-None-Match": etag})
		if same.StatusCode != 304 || body != "" || same.Header.Get("Vary") != "Accept-Encoding" {
			t.Errorf("%q: If-None-Match gave %d, body %q", accept, same.StatusCode, body)
		}
		other, _ := spaGet(t, "GET", "/assets/app-abc123.js", map[string]string{"Accept-Encoding": accept, "If-None-Match": `"something-else"`})
		if other.StatusCode != 200 {
			t.Errorf("%q: stale If-None-Match gave %d", accept, other.StatusCode)
		}
	}
	// Each encoding is its own representation.
	br, _ := spaGet(t, "GET", "/assets/app-abc123.js", map[string]string{"Accept-Encoding": "br"})
	gz, _ := spaGet(t, "GET", "/assets/app-abc123.js", map[string]string{"Accept-Encoding": "gzip"})
	if br.Header.Get("ETag") == gz.Header.Get("ETag") {
		t.Error("br and gzip share an ETag")
	}
}

func TestSPAIndexAndFallback(t *testing.T) {
	for _, p := range []string{"/", "/index.html", "/p/Some/Page", "/favicon.svg.br"} {
		res, body := spaGet(t, "GET", p, map[string]string{"Accept-Encoding": "gzip, br"})
		if res.StatusCode != 200 || body != "BR-index" || res.Header.Get("Content-Encoding") != "br" ||
			res.Header.Get("Cache-Control") != "no-cache" || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/html") {
			t.Errorf("%s: %d %q %v", p, res.StatusCode, body, res.Header)
		}
		res, body = spaGet(t, "GET", p, nil)
		if body != "<!doctype html>index" || res.Header.Get("Content-Encoding") != "" || res.Header.Get("Vary") != "Accept-Encoding" {
			t.Errorf("%s uncompressed: %q %v", p, body, res.Header)
		}
	}
	index, _ := spaGet(t, "GET", "/", map[string]string{"Accept-Encoding": "br"})
	again, _ := spaGet(t, "GET", "/p/x", map[string]string{"Accept-Encoding": "br", "If-None-Match": index.Header.Get("ETag")})
	if again.StatusCode != 304 {
		t.Errorf("index revalidation: %d", again.StatusCode)
	}
}

func TestSPAOtherFiles(t *testing.T) {
	// The compressed copies aren't files of their own.
	for _, p := range []string{"/assets/app-abc123.js.br", "/assets/app-abc123.js.gz", "/assets/missing.js"} {
		if res, _ := spaGet(t, "GET", p, nil); res.StatusCode != 404 {
			t.Errorf("%s: %d", p, res.StatusCode)
		}
	}
	// A file with no compressed copy goes out as it is, with ranges.
	res, body := spaGet(t, "GET", "/assets/tiny-def456.js", map[string]string{"Accept-Encoding": "gzip, br"})
	if body != "1" || res.Header.Get("Content-Encoding") != "" || res.Header.Get("Vary") != "" {
		t.Errorf("tiny: %q %v", body, res.Header)
	}
	res, body = spaGet(t, "GET", "/favicon.svg", map[string]string{"Range": "bytes=1-3"})
	if res.StatusCode != 206 || body != "svg" || res.Header.Get("Cache-Control") != "public, max-age=3600" {
		t.Errorf("range: %d %q", res.StatusCode, body)
	}
	// Something that merely ends in .gz is still served.
	if res, body := spaGet(t, "GET", "/notes.gz", nil); res.StatusCode != 200 || body != "a real .gz file" {
		t.Errorf("notes.gz: %d %q", res.StatusCode, body)
	}
	if res, _ := spaGet(t, "POST", "/", nil); res.StatusCode != 405 {
		t.Errorf("POST: %d", res.StatusCode)
	}
}

func (h *harness) raw(method, path string, header map[string]string) (*http.Response, []byte) {
	h.t.Helper()
	req, _ := http.NewRequest(method, h.ts.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+h.token)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	res, err := rawClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res, body
}

func TestAPIResponsesAreGzipped(t *testing.T) {
	h := newHarness(t)
	for i := range 40 {
		h.put(fmt.Sprintf("Work/Page %d.md", i), "Some text for the excerpt, to make the listing a decent size.\n")
	}
	res, body := h.raw("GET", "/api/tree", map[string]string{"Accept-Encoding": "gzip, br"})
	if res.Header.Get("Content-Encoding") != "gzip" || res.Header.Get("Vary") != "Accept-Encoding" || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("tree: %v", res.Header)
	}
	zr, err := gzip.NewReader(strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	var tree struct{ Notes []json.RawMessage }
	if err := json.NewDecoder(zr).Decode(&tree); err != nil || len(tree.Notes) != 40 {
		t.Fatalf("gzipped tree: %v, %d notes", err, len(tree.Notes))
	}
	plain, plainBody := h.raw("GET", "/api/tree", nil)
	if plain.Header.Get("Content-Encoding") != "" || !json.Valid(plainBody) || len(body) >= len(plainBody)/2 {
		t.Fatalf("plain tree: encoding %q, %d bytes plain, %d gzipped", plain.Header.Get("Content-Encoding"), len(plainBody), len(body))
	}
	// Small answers, errors and anything but GET go out as they are.
	for _, c := range []struct{ method, path string }{{"GET", "/api/health"}, {"GET", "/api/notes/Work/Nope.md"}, {"POST", "/api/auth/logout"}} {
		res, body := h.raw(c.method, c.path, map[string]string{"Accept-Encoding": "gzip"})
		if res.Header.Get("Content-Encoding") != "" || (len(body) > 0 && !json.Valid(body)) {
			t.Errorf("%s %s: encoding %q body %q", c.method, c.path, res.Header.Get("Content-Encoding"), body)
		}
	}
}

func TestFilesAndStreamsAreNotGzipped(t *testing.T) {
	h := newHarness(t)
	big := `{"k":"` + strings.Repeat("0123456789", 400) + `"}`
	if err := os.MkdirAll(filepath.Join(h.dir, "attachments"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.dir, "attachments", "data.json"), []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}
	res, body := h.raw("GET", "/api/files/attachments/data.json", map[string]string{"Accept-Encoding": "gzip"})
	if res.StatusCode != 200 || res.Header.Get("Content-Encoding") != "" || string(body) != big {
		t.Fatalf("file: %d, encoding %q, %d bytes", res.StatusCode, res.Header.Get("Content-Encoding"), len(body))
	}
	res, body = h.raw("GET", "/api/files/attachments/data.json", map[string]string{"Accept-Encoding": "gzip", "Range": "bytes=6-15"})
	if res.StatusCode != 206 || res.Header.Get("Content-Encoding") != "" || string(body) != "0123456789" {
		t.Fatalf("range: %d, encoding %q, body %q", res.StatusCode, res.Header.Get("Content-Encoding"), body)
	}

	// The event stream arrives as it's written.
	req, _ := http.NewRequest("GET", h.ts.URL+"/api/events", nil)
	req.Header.Set("Authorization", "Bearer "+h.token)
	req.Header.Set("Accept-Encoding", "gzip")
	stream, err := rawClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	if stream.Header.Get("Content-Encoding") != "" || stream.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("events: %v", stream.Header)
	}
	line, err := bufio.NewReader(stream.Body).ReadString('\n')
	if err != nil || line != "retry: 3000\n" {
		t.Fatalf("events first line: %q, %v", line, err)
	}
}

func TestGzipWriterLeavesOtherResponsesAlone(t *testing.T) {
	big := strings.Repeat("x", 4000)
	serve := func(fn http.HandlerFunc) *http.Response {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/api/thing", nil)
		req.Header.Set("Accept-Encoding", "gzip")
		gzipJSON(fn, nil).ServeHTTP(rec, req)
		return rec.Result()
	}
	cases := map[string]http.HandlerFunc{
		"not json": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/csv")
			io.WriteString(w, big)
		},
		"a download": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Content-Disposition", `attachment; filename="x.json"`)
			io.WriteString(w, big)
		},
		"already encoded": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Content-Encoding", "br")
			io.WriteString(w, big)
		},
		"an error": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(500)
			io.WriteString(w, big)
		},
		"flushed early": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, "{")
			w.(http.Flusher).Flush()
			io.WriteString(w, big)
		},
		"served content": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			http.ServeContent(w, r, "", noTime, strings.NewReader(big))
		},
	}
	for name, fn := range cases {
		res := serve(fn)
		body, _ := io.ReadAll(res.Body)
		if res.Header.Get("Content-Encoding") == "gzip" || !strings.HasSuffix(string(body), big) {
			t.Errorf("%s: encoding %q, %d bytes", name, res.Header.Get("Content-Encoding"), len(body))
		}
	}
	// Big JSON written in pieces, with a flush once it's under way.
	res := serve(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Content-Length", "4002")
		io.WriteString(w, `"`)
		io.WriteString(w, big)
		w.(http.Flusher).Flush()
		io.WriteString(w, `"`)
	})
	zr, err := gzip.NewReader(res.Body)
	if err != nil || res.Header.Get("Content-Encoding") != "gzip" || res.Header.Get("Content-Length") != "" {
		t.Fatalf("big json: %v, headers %v", err, res.Header)
	}
	if body, _ := io.ReadAll(zr); string(body) != `"`+big+`"` {
		t.Errorf("big json body: %d bytes", len(body))
	}
	// Clients that don't take gzip, other methods and ranges get the handler's own writer.
	for _, mod := range []func(*http.Request){
		func(r *http.Request) { r.Header.Del("Accept-Encoding") },
		func(r *http.Request) { r.Method = "POST" },
		func(r *http.Request) { r.Header.Set("Range", "bytes=0-1") },
		func(r *http.Request) { r.URL.Path = "/dav/x" },
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/api/thing", nil)
		req.Header.Set("Accept-Encoding", "gzip")
		mod(req)
		gzipJSON(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if _, wrapped := w.(*gzipWriter); wrapped {
				t.Errorf("%s %s wrapped", r.Method, r.URL.Path)
			}
		}), nil).ServeHTTP(rec, req)
	}
}
