package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

func TestPublicAddr(t *testing.T) {
	for addr, want := range map[string]bool{
		"93.184.216.34":      true,
		"2606:2800:220:1::1": true,
		"127.0.0.1":          false,
		"::1":                false,
		"0.0.0.0":            false,
		"10.1.2.3":           false,
		"172.16.5.4":         false,
		"192.168.1.1":        false,
		"169.254.169.254":    false, // cloud metadata
		"100.100.100.100":    false, // Tailscale
		"100.64.0.1":         false,
		"::ffff:127.0.0.1":   false, // IPv4 written as IPv6
		"::ffff:10.0.0.1":    false,
		"64:ff9b::7f00:1":    false,
		"fd7a:115c:a1e0::1":  false, // Tailscale
		"fe80::1":            false,
		"224.0.0.1":          false,
		"255.255.255.255":    false,
		"2002:7f00:1::":      false,
		"198.18.0.1":         false,
		"2001:db8::1":        false,
	} {
		if got := publicAddr(netip.MustParseAddr(addr)); got != want {
			t.Errorf("publicAddr(%s) = %v, want %v", addr, got, want)
		}
	}
}

func TestParsePreview(t *testing.T) {
	base, _ := url.Parse("https://example.com/blog/post?x=1")
	pv := parsePreview(`<!doctype html><html><head>
		<title> Plain   title </title>
		<meta property="og:title" content="A &amp; B">
		<meta name="description" content="Fallback description">
		<meta property="og:description" content="  The real
		description  ">
		<meta property="og:site_name" content="Example">
		<meta property="og:image" content="/img/cover.png">
		<link rel="shortcut icon" href="../favicon.svg">
		<link rel="apple-touch-icon" href="/touch.png">
		</head><body><svg><title>Not this</title></svg></body></html>`, base)
	want := linkPreview{
		Title: "A & B", Description: "The real description", Site: "Example",
		Image: "https://example.com/img/cover.png", Icon: "https://example.com/favicon.svg",
	}
	if pv != want {
		t.Errorf("got %+v\nwant %+v", pv, want)
	}

	// Without Open Graph tags: the <title>, and the site's default icon.
	pv = parsePreview(`<title>Just a title</title><p>Body`, base)
	if pv.Title != "Just a title" || pv.Icon != "https://example.com/favicon.ico" || pv.Image != "" {
		t.Errorf("plain page: %+v", pv)
	}

	// Pictures that the app's pages couldn't load, or that aren't web addresses, are dropped.
	plain, _ := url.Parse("http://example.com/")
	pv = parsePreview(`<meta property="og:image" content="http://example.com/a.png"><link rel="icon" href="javascript:alert(1)">
		<meta name="twitter:image" content="data:image/png;base64,AAAA">`, plain)
	if pv.Image != "" || pv.Icon != "" {
		t.Errorf("insecure picture kept: %+v", pv)
	}

	long := parsePreview("<title>"+strings.Repeat("word ", 200)+"</title>", base)
	if n := len([]rune(long.Title)); n > previewMaxTitle || !strings.HasSuffix(long.Title, "…") {
		t.Errorf("title not shortened: %d runes", n)
	}
}

func TestDecodeHTML(t *testing.T) {
	if got := decodeHTML([]byte("caf\xe9"), "iso-8859-1"); got != "café" {
		t.Errorf("latin-1: %q", got)
	}
	if got := decodeHTML([]byte("caf\xe9"), ""); got != "café" {
		t.Errorf("undeclared latin-1: %q", got)
	}
	if got := decodeHTML([]byte("café"), "utf-8"); got != "café" {
		t.Errorf("utf-8: %q", got)
	}
}

// previewerFor returns a previewer that may reach the test server.
func previewerFor() *previewer {
	p := newPreviewer(func(netip.Addr) bool { return true })
	p.anyPort = true
	return p
}

func TestPreviewReadsAndKeeps(t *testing.T) {
	var hits atomic.Int32
	var agent atomic.Value
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		agent.Store(r.Header.Get("User-Agent") + "|" + r.Header.Get("Cookie") + "|" + r.Header.Get("Referer"))
		switch r.URL.Path {
		case "/moved":
			http.Redirect(w, r, "/page", http.StatusFound)
		case "/page":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			fmt.Fprint(w, `<title>Hello</title><meta name="description" content="A page">`)
		case "/file.pdf":
			w.Header().Set("Content-Type", "application/pdf")
			fmt.Fprint(w, "%PDF-1.7 <title>Nope</title>")
		case "/huge":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, "<title>Start</title>", strings.Repeat("<p>filler</p>", 200_000), `<meta property="og:title" content="Too late">`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer site.Close()
	p := previewerFor()
	ctx := context.Background()

	pv, err := p.preview(ctx, site.URL+"/moved#section")
	if err != nil || pv.Title != "Hello" || pv.Description != "A page" {
		t.Fatalf("preview: %+v, %v", pv, err)
	}
	if got := agent.Load().(string); got != previewAgent+"||" {
		t.Errorf("sent %q", got)
	}
	before := hits.Load()
	if again, _ := p.preview(ctx, site.URL+"/moved"); again != pv || hits.Load() != before {
		t.Errorf("second ask wasn't answered from memory: %+v, %d → %d requests", again, before, hits.Load())
	}

	// Not a web page: nothing to show, and no error.
	if pv, err := p.preview(ctx, site.URL+"/file.pdf"); err != nil || pv != (linkPreview{}) {
		t.Errorf("pdf: %+v, %v", pv, err)
	}
	if pv, err := p.preview(ctx, site.URL+"/missing"); err != nil || pv != (linkPreview{}) {
		t.Errorf("404: %+v, %v", pv, err)
	}
	// Only the first megabyte is read.
	if pv, _ := p.preview(ctx, site.URL+"/huge"); pv.Title != "Start" {
		t.Errorf("huge: %+v", pv)
	}
}

func TestPreviewRefusesInwardAddresses(t *testing.T) {
	var hits atomic.Int32
	inside := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		fmt.Fprint(w, "<title>Router admin</title>")
	}))
	defer inside.Close()

	// The real guard: the test server is on loopback, so it must not be reached.
	guarded := newPreviewer(publicAddr)
	guarded.anyPort = true
	if pv, err := guarded.preview(context.Background(), inside.URL); err != nil || pv != (linkPreview{}) || hits.Load() != 0 {
		t.Errorf("loopback: %+v, %v, %d requests", pv, err, hits.Load())
	}
	// By name, too: the check is on the address dialled, not the text of the link.
	byName := strings.Replace(inside.URL, "127.0.0.1", "localhost", 1)
	if pv, _ := guarded.preview(context.Background(), byName); pv != (linkPreview{}) || hits.Load() != 0 {
		t.Errorf("localhost: %+v, %d requests", pv, hits.Load())
	}

	// A public-looking page that redirects inward is stopped at the redirect.
	outside := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "ftp://example.com/", http.StatusFound)
	}))
	defer outside.Close()
	if pv, _ := previewerFor().preview(context.Background(), outside.URL); pv != (linkPreview{}) {
		t.Errorf("redirect to ftp: %+v", pv)
	}

	p := newPreviewer(publicAddr)
	for _, bad := range []string{
		"", "example.com", "ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)",
		"http://user:pw@example.com/", "http://example.com:8080/", "https://example.com:22/", "http:///path",
		"https://example.com/" + strings.Repeat("a", previewMaxURL),
	} {
		if _, err := p.preview(context.Background(), bad); err == nil {
			t.Errorf("%q was accepted", bad)
		}
	}
}

func TestLinkPreviewRoute(t *testing.T) {
	h := newHarness(t)
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<title>From the site</title>`)
	}))
	defer site.Close()
	h.srv.previews = previewerFor()

	var pv linkPreview
	if code := h.do("GET", "/api/link-preview?url="+url.QueryEscape(site.URL+"/"), nil, &pv); code != 200 || pv.Title != "From the site" {
		t.Fatalf("preview: %d %+v", code, pv)
	}
	if code := h.do("GET", "/api/link-preview?url="+url.QueryEscape("file:///etc/passwd"), nil, nil); code != 400 {
		t.Errorf("file address: %d", code)
	}
	// Signed out, the server fetches nothing for anyone.
	res, err := http.Get(h.ts.URL + "/api/link-preview?url=" + url.QueryEscape(site.URL+"/"))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Errorf("signed out: %d", res.StatusCode)
	}
}

// A real PDF may be framed by Quire's own pages; everything else keeps the sandbox.
func TestFileHeaders(t *testing.T) {
	h := newHarness(t)
	h.attachment("doc.pdf", "%PDF-1.7\n…")
	h.attachment("fake.pdf", "<html><script>alert(1)</script>")
	h.attachment("pic.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>")
	h.attachment("page.html", "<script>alert(1)</script>")

	for name, want := range map[string]struct {
		frame, sandbox, download bool
	}{
		"doc.pdf":   {frame: true},
		"fake.pdf":  {sandbox: true, download: true},
		"pic.svg":   {sandbox: true},
		"page.html": {sandbox: true, download: true},
	} {
		res, body := h.raw("GET", "/api/files/attachments/"+name, nil)
		if res.StatusCode != 200 || len(body) == 0 {
			t.Fatalf("%s: %d, %d bytes", name, res.StatusCode, len(body))
		}
		csp := res.Header.Get("Content-Security-Policy")
		if got := res.Header.Get("X-Frame-Options"); (got == "SAMEORIGIN") != want.frame || (got == "DENY") == want.frame {
			t.Errorf("%s: X-Frame-Options %q", name, got)
		}
		if strings.Contains(csp, "frame-ancestors 'self'") != want.frame {
			t.Errorf("%s: CSP %q", name, csp)
		}
		if strings.Contains(csp, "sandbox") != want.sandbox || !strings.Contains(csp, "default-src 'none'") {
			t.Errorf("%s: CSP %q", name, csp)
		}
		if (res.Header.Get("Content-Disposition") != "") != want.download {
			t.Errorf("%s: Content-Disposition %q", name, res.Header.Get("Content-Disposition"))
		}
		if res.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: no nosniff", name)
		}
	}
	// The whole file still arrives after the look at its first bytes.
	if _, body := h.raw("GET", "/api/files/attachments/doc.pdf", nil); string(body) != "%PDF-1.7\n…" {
		t.Errorf("pdf body: %q", body)
	}
}

// Pages may frame Quire's own files and the listed players, and nothing else.
func TestPageFramePolicy(t *testing.T) {
	h := newHarness(t)
	res, _ := h.raw("GET", "/api/health", nil)
	csp := res.Header.Get("Content-Security-Policy")
	var frames string
	for _, part := range strings.Split(csp, ";") {
		if part = strings.TrimSpace(part); strings.HasPrefix(part, "frame-src ") {
			frames = part
		}
	}
	if !strings.HasPrefix(frames, "frame-src 'self' https://") || !strings.Contains(frames, "https://www.youtube-nocookie.com") {
		t.Fatalf("frame-src: %q", frames)
	}
	for _, src := range strings.Fields(frames)[2:] {
		if !strings.HasPrefix(src, "https://") || strings.Contains(src, "*") {
			t.Errorf("frame source %q isn't one exact https site", src)
		}
	}
	if !strings.Contains(csp, "frame-ancestors 'none'") || res.Header.Get("X-Frame-Options") != "DENY" {
		t.Errorf("the app may be framed: %q, %q", csp, res.Header.Get("X-Frame-Options"))
	}
}
