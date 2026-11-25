package server

import (
	"fmt"
	"testing"
	"time"

	"github.com/oddomens/quire/internal/auth"
)

// While both password-check slots are busy, a sign-in is turned away at
// once, and that isn't held against the address.
func TestSignInWaitsForPasswordChecks(t *testing.T) {
	h := newHarness(t)
	h.token = ""
	for range maxVerifies {
		h.srv.verifies <- struct{}{}
	}
	if code := h.do("POST", "/api/auth/login", map[string]string{"password": testPassword}, nil); code != 429 {
		t.Fatalf("sign-in while busy: %d", code)
	}
	if n := len(h.srv.limiter.fails); n != 0 {
		t.Fatalf("a busy refusal counted as a failure: %v", h.srv.limiter.fails)
	}
	for range maxVerifies {
		<-h.srv.verifies
	}
	if code := h.do("POST", "/api/auth/login", map[string]string{"password": testPassword}, nil); code != 200 {
		t.Fatalf("sign-in after: %d", code)
	}
}

// Attempts count as they start, so ones in flight can't pass the limit.
func TestLimiterCountsAttemptsAsTheyStart(t *testing.T) {
	l := newLimiter()
	var stamps []time.Time
	for range maxFails {
		stamp, _, ok := l.begin("192.0.2.1")
		if !ok {
			t.Fatal("refused under the limit")
		}
		stamps = append(stamps, stamp)
	}
	if _, _, ok := l.begin("192.0.2.1"); ok {
		t.Fatal("attempt past the limit while others were in flight")
	}
	l.forgive("192.0.2.1", stamps[0])
	if _, _, ok := l.begin("192.0.2.1"); !ok {
		t.Fatal("a forgiven attempt still counted")
	}
	if _, _, ok := l.begin("192.0.2.2"); !ok {
		t.Fatal("another address was locked out")
	}
}

// Failures from many addresses slow sign-in down but don't lock the owner out.
func TestGlobalFailuresSlowSignInDown(t *testing.T) {
	h := newHarness(t)
	h.token = ""
	h.srv.limiter.slow = 200 * time.Millisecond
	for i := range maxGlobalFails {
		h.srv.limiter.begin(fmt.Sprintf("198.51.100.%d", i))
	}
	// Attempts take turns, one per l.slow: the first goes straight in, the
	// next waits for its turn.
	if code := h.do("POST", "/api/auth/login", map[string]string{"password": testPassword}, nil); code != 200 {
		t.Fatalf("owner locked out by others' failures: %d", code)
	}
	start := time.Now()
	if code := h.do("POST", "/api/auth/login", map[string]string{"password": testPassword}, nil); code != 200 {
		t.Fatalf("owner locked out by others' failures: %d", code)
	}
	if time.Since(start) < h.srv.limiter.slow/2 {
		t.Fatal("sign-in wasn't slowed down")
	}
}

// Turning on two-factor sign-in ends every other session.
func TestTwoFactorEndsOtherSessions(t *testing.T) {
	h := newHarness(t)
	var other struct{ Token string }
	if code := h.do("POST", "/api/auth/login", map[string]string{"password": testPassword}, &other); code != 200 {
		t.Fatalf("second sign-in: %d", code)
	}
	var setup struct{ Secret string }
	h.do("POST", "/api/account/2fa/setup", map[string]string{"password": testPassword}, &setup)
	if c := h.do("POST", "/api/account/2fa/enable", map[string]string{"code": auth.TOTPCode(setup.Secret, time.Now())}, nil); c != 200 {
		t.Fatalf("2fa enable: %d", c)
	}
	if code := h.do("GET", "/api/account", nil, nil); code != 200 {
		t.Fatalf("session that turned it on: %d", code)
	}
	h.token = other.Token
	if code := h.do("GET", "/api/account", nil, nil); code != 401 {
		t.Fatalf("other session after enabling 2FA: %d", code)
	}
}

func TestLimitKeyIPv6Prefix(t *testing.T) {
	if limitKey("2001:db8:1:2:aaaa::1") != limitKey("2001:db8:1:2:bbbb::9") {
		t.Error("addresses in one /64 should share a limit")
	}
	if limitKey("203.0.113.5") != "203.0.113.5" || limitKey("::ffff:203.0.113.5") != "203.0.113.5" {
		t.Error("IPv4 keyed by address")
	}
}
