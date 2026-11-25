package store

import (
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "quire.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	if err := s.CreateAccount("Alex", "hash"); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestTOTPStepIsUsedOnce(t *testing.T) {
	s := open(t)
	if ok, err := s.UseTOTPStep(100); !ok || err != nil {
		t.Fatalf("fresh step: %v %v", ok, err)
	}
	for _, step := range []int64{100, 99} {
		if ok, _ := s.UseTOTPStep(step); ok {
			t.Fatalf("step %d accepted after 100", step)
		}
	}
	if ok, _ := s.UseTOTPStep(101); !ok {
		t.Fatal("next step refused")
	}
}

// Requests racing with one recovery code: exactly one spends it.
func TestRecoveryCodeIsSpentOnce(t *testing.T) {
	s := open(t)
	a, err := s.Account()
	if err != nil {
		t.Fatal(err)
	}
	a.Recovery = []string{"h1", "h2"}
	if err := s.SaveAccount(a); err != nil {
		t.Fatal(err)
	}
	var wins atomic.Int32
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			if ok, err := s.UseRecoveryCode("h1"); err == nil && ok {
				wins.Add(1)
			}
		})
	}
	wg.Wait()
	if wins.Load() != 1 {
		t.Fatalf("code spent %d times", wins.Load())
	}
	if a, _ = s.Account(); len(a.Recovery) != 1 || a.Recovery[0] != "h2" {
		t.Fatalf("codes left: %v", a.Recovery)
	}
	if ok, _ := s.UseRecoveryCode("nope"); ok {
		t.Fatal("unknown code accepted")
	}
}

// Sliding renewal never keeps a session past sessionMaxAge.
func TestSessionMaxAge(t *testing.T) {
	s := open(t)
	token, _, err := s.CreateSession("Browser", "127.0.0.1", "test")
	if err != nil {
		t.Fatal(err)
	}
	// Created long ago but used a moment ago: the renewal stops at the cap.
	created := time.Now().Add(-sessionMaxAge + time.Hour)
	if _, err := s.db.Exec(`UPDATE sessions SET created = ?, last_seen = 0`, created.Unix()); err != nil {
		t.Fatal(err)
	}
	if id, err := s.CheckSession(token, "127.0.0.1"); id == "" || err != nil {
		t.Fatalf("session within its lifetime: %q %v", id, err)
	}
	var expires int64
	s.db.QueryRow(`SELECT expires FROM sessions`).Scan(&expires)
	if want := created.Add(sessionMaxAge).Unix(); expires != want {
		t.Fatalf("expiry slid to %d, past the cap %d", expires, want)
	}

	// Past the cap, even a session with time left on its expiry ends.
	if _, err := s.db.Exec(`UPDATE sessions SET created = ?, expires = ?`, time.Now().Add(-sessionMaxAge-time.Hour).Unix(), time.Now().Add(sessionTTL).Unix()); err != nil {
		t.Fatal(err)
	}
	if list, _ := s.Sessions(""); len(list) != 0 {
		t.Fatalf("listed an expired session: %v", list)
	}
	if id, _ := s.CheckSession(token, "127.0.0.1"); id != "" {
		t.Fatal("session outlived its maximum age")
	}
	var n int
	s.db.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&n)
	if n != 0 {
		t.Fatal("expired session kept")
	}
}
