package server

import (
	"crypto/subtle"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/oddomens/quire/internal/auth"
	"github.com/oddomens/quire/internal/store"
)

const cookieName = "quire_session"

func (s *Server) token(r *http.Request) (string, bool) {
	if h := r.Header.Get("Authorization"); h != "" {
		if t, ok := strings.CutPrefix(h, "Bearer "); ok {
			return strings.TrimSpace(t), false
		}
	}
	if c, err := r.Cookie(cookieName); err == nil {
		return c.Value, true
	}
	return "", false
}

// requireAuth admits requests with a live session. Cookie-authenticated
// writes must also carry X-Client-Id: a cross-site form or image can't add
// that header, which closes off CSRF even where SameSite isn't honoured.
func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, cookie := s.token(r)
		id, err := s.store.CheckSession(token, s.clientIP(r))
		if err != nil {
			s.log.Error("session check", "err", err)
		}
		if id == "" {
			writeErr(w, http.StatusUnauthorized, "sign in required")
			return
		}
		if cookie && r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("X-Client-Id") == "" {
			writeErr(w, http.StatusForbidden, "missing X-Client-Id header")
			return
		}
		next.ServeHTTP(w, withAuth(r, authInfo{sessionID: id, cookie: cookie}))
	})
}

// SetupCode returns the one-time code that lets the first visitor create the
// account, or "" once an account exists.
func (s *Server) SetupCode() (string, error) {
	acct, err := s.store.Account()
	if err != nil || acct != nil {
		return "", err
	}
	s.setupMu.Lock()
	defer s.setupMu.Unlock()
	if s.setupCode == "" {
		c := auth.RandomString(8)
		s.setupCode = c[:4] + "-" + c[4:]
	}
	return s.setupCode, nil
}

// Bootstrap creates the account from a password given in the environment,
// for unattended installs. It does nothing once an account exists.
func (s *Server) Bootstrap(name, password string) (bool, error) {
	acct, err := s.store.Account()
	if err != nil || acct != nil || password == "" {
		return false, err
	}
	if msg := validPassword(password); msg != "" {
		return false, errors.New("QUIRE_PASSWORD: " + msg)
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return false, err
	}
	return true, s.store.CreateAccount(name, hash)
}

func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	acct, err := s.store.Account()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	token, _ := s.token(r)
	id, _ := s.store.CheckSession(token, s.clientIP(r))
	out := map[string]any{"authenticated": id != "", "setupRequired": acct == nil, "version": s.cfg.Version}
	if id != "" && acct != nil {
		out["name"] = acct.Name
		out["warnings"] = s.warnings(r)
	}
	writeJSON(w, http.StatusOK, out)
}

func validPassword(p string) string {
	if utf8.RuneCountInString(p) < auth.MinPasswordLen {
		return "use at least 10 characters"
	}
	if len(p) > 512 {
		return "that password is too long"
	}
	return ""
}

func cleanName(n string) string {
	n = strings.Join(strings.Fields(n), " ")
	if r := []rune(n); len(r) > 60 {
		n = string(r[:60])
	}
	return n
}

func (s *Server) setup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code     string `json:"code"`
		Name     string `json:"name"`
		Password string `json:"password"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	ip := s.clientIP(r)
	stamp, ok := s.attempt(w, ip)
	if !ok {
		return
	}
	code, err := s.SetupCode()
	if err != nil {
		s.limiter.forgive(ip, stamp)
		s.fail(w, r, err)
		return
	}
	if code == "" {
		s.limiter.forgive(ip, stamp)
		writeErr(w, http.StatusConflict, "Quire is already set up")
		return
	}
	norm := func(c string) string { return strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(c), "-", "")) }
	if subtle.ConstantTimeCompare([]byte(norm(req.Code)), []byte(norm(code))) != 1 {
		writeErr(w, http.StatusUnauthorized, "that setup code isn't right; it's in the server log")
		return
	}
	s.limiter.forgive(ip, stamp)
	name := cleanName(req.Name)
	if name == "" {
		writeErr(w, http.StatusBadRequest, "enter your name")
		return
	}
	if msg := validPassword(req.Password); msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.store.CreateAccount(name, hash); err != nil {
		writeErr(w, http.StatusConflict, "Quire is already set up")
		return
	}
	s.setupMu.Lock()
	s.setupCode = ""
	s.setupMu.Unlock()
	s.log.Info("account created", "ip", ip)
	s.startSession(w, r, "")
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
		// Code is a TOTP code or a recovery code, when two-factor is on.
		Code string `json:"code"`
		// Device names the session, e.g. "iPhone"; the web UI leaves it empty.
		Device string `json:"device"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	ip := s.clientIP(r)
	stamp, ok := s.attempt(w, ip)
	if !ok {
		return
	}
	acct, err := s.store.Account()
	if err != nil || acct == nil {
		s.limiter.forgive(ip, stamp)
		if err != nil {
			s.fail(w, r, err)
		} else {
			writeErr(w, http.StatusConflict, "Quire isn't set up yet")
		}
		return
	}
	ok, busy := s.verifyPassword(req.Password, acct.PasswordHash)
	if busy {
		s.limiter.forgive(ip, stamp)
		writeErr(w, http.StatusTooManyRequests, "Quire is busy with other sign-ins; try again in a moment")
		return
	}
	if !ok {
		s.log.Warn("sign-in failed", "ip", ip, "reason", "password")
		time.Sleep(300 * time.Millisecond)
		writeErr(w, http.StatusUnauthorized, "wrong password")
		return
	}
	if acct.TwoFactor() {
		if strings.TrimSpace(req.Code) == "" {
			// Asking for the code is a step of signing in, not a failure.
			s.limiter.forgive(ip, stamp)
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "enter the code from your authenticator app", "twoFactor": true})
			return
		}
		// Wrong codes are counted for the account as well as the address: a
		// correct password from many addresses mustn't allow endless guesses.
		if !s.limiter.codeAllowed() {
			writeErr(w, http.StatusTooManyRequests, "too many wrong codes, try again in a few minutes")
			return
		}
		if !s.checkSecondFactor(acct, req.Code) {
			s.limiter.codeFailed()
			s.log.Warn("sign-in failed", "ip", ip, "reason", "two-factor code")
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "that code didn't work", "twoFactor": true})
			return
		}
	}
	s.limiter.forgive(ip, stamp)
	s.limiter.reset(ip)
	s.limiter.codeReset()
	s.log.Info("signed in", "ip", ip, "device", req.Device)
	s.startSession(w, r, req.Device)
}

// checkSecondFactor accepts a fresh TOTP code or an unused recovery code,
// which is then spent. The store checks and spends in one step, so two
// sign-ins racing with the same code can't both get in.
func (s *Server) checkSecondFactor(acct *store.Account, code string) bool {
	if step, ok := auth.CheckTOTP(acct.TOTPSecret, code, time.Now()); ok {
		used, err := s.store.UseTOTPStep(step)
		return err == nil && used
	}
	used, err := s.store.UseRecoveryCode(auth.HashCode(code))
	return err == nil && used
}

// attempt starts a password (or setup code) attempt from ip under the
// sign-in limits, answering the request itself if it can't go ahead. The
// attempt counts as a failure from the start; s.limiter.forgive takes it
// back once it succeeds.
func (s *Server) attempt(w http.ResponseWriter, ip string) (time.Time, bool) {
	stamp, delay, ok := s.limiter.begin(ip)
	if !ok {
		writeErr(w, http.StatusTooManyRequests, "too many attempts, try again in a few minutes")
		return time.Time{}, false
	}
	time.Sleep(delay)
	return stamp, true
}

// maxVerifies is how many Argon2 password checks run at once. Each takes
// 64 MiB and a core for a moment; more at once would let a burst of
// sign-ins starve the server.
const maxVerifies = 2

// verifyWait is how long a password check waits for a free slot.
const verifyWait = 5 * time.Second

// maxQueue is the longest an attempt waits for its turn in a slowdown
// before it's refused instead.
const maxQueue = 30 * time.Second

// limitKey is the key an address is limited under: the address itself, or
// its /64 for IPv6, since one network usually holds a whole /64.
func limitKey(ip string) string {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return ip
	}
	a = a.Unmap()
	if a.Is4() {
		return a.String()
	}
	p, err := a.Prefix(64)
	if err != nil {
		return ip
	}
	return p.String()
}

// verifyPassword checks a password against its hash. busy means there was
// no room to check it right now.
//
// A check waits a few seconds for its turn rather than being turned away at
// once, so a flood of sign-ins can't keep the owner out by holding the slots:
// the flood's attempts are counted against its addresses while they wait.
func (s *Server) verifyPassword(password, hash string) (ok, busy bool) {
	select {
	case s.verifies <- struct{}{}:
	case <-time.After(verifyWait):
		return false, true
	}
	defer func() { <-s.verifies }()
	ok, _ = auth.VerifyPassword(password, hash)
	return ok, false
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, device string) {
	device = cleanName(device)
	if device == "" {
		device = "Browser"
	}
	token, exp, err := s.store.CreateSession(device, s.clientIP(r), r.UserAgent())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: token, Path: "/", Expires: exp,
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: isHTTPS(r),
	})
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "expires": exp.Unix()})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if t, _ := s.token(r); t != "" {
		_ = s.store.DeleteSessionToken(t)
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: isHTTPS(r)})
	w.WriteHeader(http.StatusNoContent)
}

func isHTTPS(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// clientIP is the connecting address, or the X-Forwarded-For hop just before
// our trusted proxies when the request came through one.
func (s *Server) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil || !s.trusted(addr) {
		return host
	}
	hops := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(hops) - 1; i >= 0; i-- {
		hop, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			break
		}
		if !s.trusted(hop) {
			return hop.String()
		}
	}
	return host
}

func (s *Server) trusted(a netip.Addr) bool {
	a = a.Unmap()
	if a.IsLoopback() {
		return true
	}
	for _, p := range s.cfg.TrustedProxies {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// limiter locks an address out for a while after repeated failures, and
// slows everyone down if failures pile up from many addresses at once. It
// never locks everyone out: then anyone could keep the owner from signing in.
type limiter struct {
	mu     sync.Mutex
	fails  map[string][]time.Time
	global []time.Time
	// codes are the wrong two-factor codes for the account, from any address.
	codes []time.Time
	// slow is the wait added to each attempt while there are maxGlobalFails.
	slow time.Duration
	// next is when the next attempt may start during a slowdown.
	next time.Time
}

const (
	maxFails       = 8
	maxGlobalFails = 60
	failWindow     = 15 * time.Minute
)

func newLimiter() *limiter { return &limiter{fails: map[string][]time.Time{}, slow: 3 * time.Second} }

func prune(ts []time.Time) []time.Time {
	cut := time.Now().Add(-failWindow)
	i := 0
	for i < len(ts) && ts[i].Before(cut) {
		i++
	}
	return ts[i:]
}

// maxCodeFails is how many wrong two-factor codes the account takes within
// failWindow, from every address together, before codes are refused.
const maxCodeFails = 10

func (l *limiter) codeAllowed() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.codes = prune(l.codes)
	return len(l.codes) < maxCodeFails
}

func (l *limiter) codeFailed() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.codes = append(prune(l.codes), time.Now())
}

func (l *limiter) codeReset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.codes = nil
}

// begin starts an attempt from ip, refusing it while ip is locked out. The
// check and the count happen together, so parallel requests can't all slip
// in under the limit while their passwords are being checked. delay is how
// long to wait first, while failures are piling up everywhere.
func (l *limiter) begin(ip string) (stamp time.Time, delay time.Duration, ok bool) {
	ip = limitKey(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	l.global = prune(l.global)
	ts := prune(l.fails[ip])
	if len(ts) >= maxFails {
		l.fails[ip] = ts
		return time.Time{}, 0, false
	}
	if len(l.global) >= maxGlobalFails {
		// Attempts take turns, one every l.slow, so the slowdown caps how
		// many guesses get through however many arrive at once.
		now := time.Now()
		slot := now
		if l.next.After(now) {
			slot = l.next
		}
		if slot.Sub(now) > maxQueue {
			return time.Time{}, 0, false
		}
		l.next = slot.Add(l.slow)
		delay = slot.Sub(now)
	}
	stamp = time.Now()
	l.fails[ip] = append(ts, stamp)
	l.global = append(l.global, stamp)
	return stamp, delay, true
}

// forgive takes back an attempt begin counted, once it succeeded.
func (l *limiter) forgive(ip string, stamp time.Time) {
	ip = limitKey(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	drop := func(ts []time.Time) []time.Time {
		if i := slices.IndexFunc(ts, stamp.Equal); i >= 0 {
			return slices.Delete(ts, i, i+1)
		}
		return ts
	}
	l.global = drop(l.global)
	if ts := drop(l.fails[ip]); len(ts) == 0 {
		delete(l.fails, ip)
	} else {
		l.fails[ip] = ts
	}
}

// sweep forgets addresses whose failures have all aged out, so addresses
// that fail once and never return don't pile up.
func (l *limiter) sweep() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for ip, ts := range l.fails {
		if ts = prune(ts); len(ts) == 0 {
			delete(l.fails, ip)
		} else {
			l.fails[ip] = ts
		}
	}
	l.global = prune(l.global)
}

func (l *limiter) reset(ip string) {
	ip = limitKey(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.fails, ip)
}
