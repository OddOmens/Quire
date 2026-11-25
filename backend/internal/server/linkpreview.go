package server

import (
	"context"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"golang.org/x/net/html"
)

// linkPreview is what a web bookmark shows about the page it points at.
type linkPreview struct {
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	// Site is the name the page gives its site ("The Verge").
	Site string `json:"site,omitempty"`
	// Image and Icon are https addresses on the other site; the browser loads
	// them itself, as it does any picture in a page.
	Image string `json:"image,omitempty"`
	Icon  string `json:"icon,omitempty"`
}

const (
	previewTimeout  = 8 * time.Second
	previewMaxBytes = 1 << 20
	previewKeep     = 7 * 24 * time.Hour
	// A page that couldn't be read is tried again sooner.
	previewRetry    = 15 * time.Minute
	previewMaxKept  = 2000
	previewAtOnce   = 4
	previewMaxURL   = 2000
	previewMaxTitle = 300
	previewMaxText  = 500
	// Sites answer plain clients with a consent wall or nothing at all; this
	// says what's asking without naming anyone.
	previewAgent = "Mozilla/5.0 (compatible; Quire link preview)"
)

// previewer reads the title, description and picture of web pages for
// bookmarks. It only ever talks to public addresses: a link in a note must
// not be a way to reach this machine, the home network or a tailnet.
type previewer struct {
	client *http.Client
	// anyPort lets tests reach a server on a random port.
	anyPort bool
	slots   chan struct{}

	mu     sync.Mutex
	kept   map[string]keptPreview
	flying map[string]chan struct{}
}

type keptPreview struct {
	preview linkPreview
	until   time.Time
}

// newPreviewer makes a previewer that connects only where allow says it may.
func newPreviewer(allow func(netip.Addr) bool) *previewer {
	dialer := &net.Dialer{
		Timeout: 5 * time.Second,
		// Runs after the name is looked up, on the address actually dialled,
		// so a name that points inward (or changes between checks) is refused.
		Control: func(_, address string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(address)
			if err != nil || !allow(ap.Addr()) {
				return errors.New("address not allowed")
			}
			return nil
		},
	}
	p := &previewer{slots: make(chan struct{}, previewAtOnce), kept: map[string]keptPreview{}, flying: map[string]chan struct{}{}}
	p.client = &http.Client{
		Timeout: previewTimeout,
		Transport: &http.Transport{
			// No proxy: the address check above must see the real target.
			Proxy:                  nil,
			DialContext:            dialer.DialContext,
			TLSHandshakeTimeout:    5 * time.Second,
			ResponseHeaderTimeout:  previewTimeout,
			MaxIdleConns:           4,
			IdleConnTimeout:        30 * time.Second,
			MaxResponseHeaderBytes: 64 << 10,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			// The next site needn't know which link led to it.
			req.Header.Del("Referer")
			return p.check(req.URL)
		},
	}
	return p
}

// inward lists the address ranges IsPrivate and friends don't cover.
var inward = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), // carrier NAT, and Tailscale
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b::/96"), // NAT64: an IPv4 address in disguise
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("2002::/16"), // 6to4, likewise
	netip.MustParsePrefix("2001::/32"), // Teredo
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("::/96"),     // IPv4-compatible, long retired
	netip.MustParsePrefix("100::/64"),  // discard-only
	netip.MustParsePrefix("fec0::/10"), // site-local, long retired
}

// publicAddr reports whether ip is an ordinary address on the internet.
func publicAddr(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || ip.IsUnspecified() || ip.IsLoopback() || ip.IsPrivate() || ip.IsMulticast() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() {
		return false
	}
	for _, p := range inward {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

// check refuses addresses that aren't plain web pages.
func (p *previewer) check(u *url.URL) error {
	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New("not a web address")
	}
	if u.User != nil || u.Hostname() == "" {
		return errors.New("not a plain web address")
	}
	if port := u.Port(); !p.anyPort && port != "" && port != "80" && port != "443" {
		return errors.New("unusual port")
	}
	return nil
}

// preview returns what's known about the page at raw, reading it if needed.
// A page that can't be read gives an empty preview, not an error.
func (p *previewer) preview(ctx context.Context, raw string) (linkPreview, error) {
	if len(raw) > previewMaxURL {
		return linkPreview{}, errors.New("address too long")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return linkPreview{}, err
	}
	if err := p.check(u); err != nil {
		return linkPreview{}, err
	}
	u.Fragment = ""
	key := u.String()

	for {
		p.mu.Lock()
		if k, ok := p.kept[key]; ok && time.Now().Before(k.until) {
			p.mu.Unlock()
			return k.preview, nil
		}
		wait, busy := p.flying[key]
		if !busy {
			wait = make(chan struct{})
			p.flying[key] = wait
			p.mu.Unlock()
			break
		}
		p.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
			return linkPreview{}, nil
		}
	}

	// The read isn't tied to this request: a second tab asking for the same
	// page waits for it, and its answer is kept either way.
	pv, ok := p.read(key)
	keep := previewKeep
	if !ok {
		keep = previewRetry
	}
	p.mu.Lock()
	if len(p.kept) >= previewMaxKept {
		p.forget()
	}
	p.kept[key] = keptPreview{preview: pv, until: time.Now().Add(keep)}
	close(p.flying[key])
	delete(p.flying, key)
	p.mu.Unlock()
	return pv, nil
}

// forget drops what has expired and, if that isn't enough, the oldest half.
func (p *previewer) forget() {
	now := time.Now()
	for k, v := range p.kept {
		if now.After(v.until) {
			delete(p.kept, k)
		}
	}
	for k := range p.kept {
		if len(p.kept) <= previewMaxKept/2 {
			break
		}
		delete(p.kept, k)
	}
}

func (p *previewer) read(address string) (linkPreview, bool) {
	p.slots <- struct{}{}
	defer func() { <-p.slots }()
	req, err := http.NewRequest(http.MethodGet, address, nil)
	if err != nil {
		return linkPreview{}, false
	}
	req.Header.Set("User-Agent", previewAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1")
	res, err := p.client.Do(req)
	if err != nil {
		return linkPreview{}, false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return linkPreview{}, false
	}
	kind, params, _ := mime.ParseMediaType(res.Header.Get("Content-Type"))
	if kind != "text/html" && kind != "application/xhtml+xml" {
		return linkPreview{}, true
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, previewMaxBytes))
	if err != nil && len(body) == 0 {
		return linkPreview{}, false
	}
	return parsePreview(decodeHTML(body, params["charset"]), res.Request.URL), true
}

// decodeHTML returns body as UTF-8. Pages in anything else are almost always
// a Western single-byte encoding, which is read as Latin-1.
func decodeHTML(body []byte, charset string) string {
	charset = strings.ToLower(charset)
	if (charset == "" || charset == "utf-8" || charset == "utf8") && utf8.Valid(body) {
		return string(body)
	}
	if utf8.Valid(body) && charset != "iso-8859-1" && charset != "windows-1252" && charset != "latin1" {
		return string(body)
	}
	var b strings.Builder
	b.Grow(len(body) + len(body)/8)
	for _, c := range body {
		b.WriteRune(rune(c))
	}
	return b.String()
}

// parsePreview picks the title, description, picture and icon out of a page.
func parsePreview(doc string, base *url.URL) linkPreview {
	meta := map[string]string{}
	var title, icon, touchIcon string
	z := html.NewTokenizer(strings.NewReader(doc))
	inTitle := false
	for {
		tt := z.Next()
		if tt == html.ErrorToken {
			break
		}
		switch tt {
		case html.StartTagToken, html.SelfClosingTagToken:
			t := z.Token()
			switch t.Data {
			case "title":
				// Only the page's own title, not one inside an inline SVG.
				inTitle = title == "" && tt == html.StartTagToken
			case "meta":
				name := strings.ToLower(attr(t, "property"))
				if name == "" {
					name = strings.ToLower(attr(t, "name"))
				}
				if c := attr(t, "content"); name != "" && c != "" && meta[name] == "" {
					meta[name] = c
				}
			case "link":
				rel := " " + strings.ToLower(attr(t, "rel")) + " "
				href := attr(t, "href")
				switch {
				case href == "":
				case strings.Contains(rel, " icon ") && icon == "":
					icon = href
				case strings.Contains(rel, " apple-touch-icon ") && touchIcon == "":
					touchIcon = href
				}
			}
		case html.TextToken:
			if inTitle {
				title += string(z.Text())
			}
		case html.EndTagToken:
			if name, _ := z.TagName(); string(name) == "title" {
				inTitle = false
			}
		}
	}
	first := func(keys ...string) string {
		for _, k := range keys {
			if v := clean(meta[k], previewMaxText); v != "" {
				return v
			}
		}
		return ""
	}
	pv := linkPreview{
		Title:       clean(first("og:title", "twitter:title"), previewMaxTitle),
		Description: first("og:description", "twitter:description", "description"),
		Site:        clean(first("og:site_name", "application-name"), 80),
		Image:       secureURL(base, first("og:image:secure_url", "og:image", "twitter:image", "twitter:image:src")),
	}
	if pv.Title == "" {
		pv.Title = clean(title, previewMaxTitle)
	}
	if icon == "" {
		icon = touchIcon
	}
	if icon == "" {
		icon = "/favicon.ico"
	}
	pv.Icon = secureURL(base, icon)
	return pv
}

func attr(t html.Token, key string) string {
	for _, a := range t.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

// clean makes s one line of at most max characters.
func clean(s string, max int) string {
	s = strings.Join(strings.Fields(strings.ToValidUTF8(s, "")), " ")
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:max-1])) + "…"
}

// secureURL resolves ref against base and keeps it only if it's an https
// address, the one kind the app's pages may load pictures from.
func secureURL(base *url.URL, ref string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" || len(ref) > previewMaxURL {
		return ""
	}
	u, err := base.Parse(ref)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return ""
	}
	return u.String()
}

// linkPreview answers GET /api/link-preview?url=… for a bookmark card.
func (s *Server) linkPreview(w http.ResponseWriter, r *http.Request) {
	pv, err := s.previews.preview(r.Context(), r.URL.Query().Get("url"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "give url as a web address")
		return
	}
	// An empty answer may only mean the site was down a moment ago.
	if pv == (linkPreview{}) {
		w.Header().Set("Cache-Control", "private, max-age=300")
	} else {
		w.Header().Set("Cache-Control", "private, max-age=3600")
	}
	writeJSON(w, http.StatusOK, pv)
}
