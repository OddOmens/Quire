package store

import (
	"path/filepath"
	"testing"
	"time"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "quire.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// Saves merge into one version per editing session, but a long session
// still leaves a version every half hour.
func TestRecordSessions(t *testing.T) {
	s := testStore(t)
	clock := time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC).UnixMilli()
	old := now
	now = func() int64 { return clock }
	t.Cleanup(func() { now = old })

	text := ""
	save := func(at time.Duration, source string) {
		t.Helper()
		clock = time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC).Add(at).UnixMilli()
		var prev []byte
		if text != "" {
			prev = []byte(text)
		}
		text = "saved at " + at.String()
		if err := s.Record("Work/Doc.md", prev, []byte(text), source); err != nil {
			t.Fatal(err)
		}
	}
	count := func() int {
		t.Helper()
		revs, err := s.Revisions("Work/Doc.md")
		if err != nil {
			t.Fatal(err)
		}
		return len(revs)
	}

	// An hour of saves every five minutes: versions start at 0, 30 and 60.
	for at := time.Duration(0); at <= time.Hour; at += 5 * time.Minute {
		save(at, "edit")
	}
	if n := count(); n != 3 {
		t.Fatalf("an hour of editing kept %d versions, want 3", n)
	}
	// Rapid saves still merge.
	save(time.Hour+10*time.Second, "edit")
	save(time.Hour+20*time.Second, "edit")
	if n := count(); n != 3 {
		t.Fatalf("rapid saves added versions: %d", n)
	}
	// A pause longer than the gap starts a new one.
	save(time.Hour+15*time.Minute, "edit")
	if n := count(); n != 4 {
		t.Fatalf("after a pause: %d versions, want 4", n)
	}
	// Other sources never merge.
	save(time.Hour+16*time.Minute, "restore")
	save(time.Hour+17*time.Minute, "restore")
	if n := count(); n != 6 {
		t.Fatalf("restores merged: %d versions, want 6", n)
	}
}

// A page created where an older page's history remains starts its own.
func TestRecordNewPageStartsFresh(t *testing.T) {
	s := testStore(t)
	if err := s.Record("Work/Doc.md", nil, []byte("first page"), "edit"); err != nil {
		t.Fatal(err)
	}
	if err := s.Record("Work/Doc.md", nil, []byte("second page"), "edit"); err != nil {
		t.Fatal(err)
	}
	if revs, _ := s.Revisions("Work/Doc.md"); len(revs) != 2 {
		t.Fatalf("new page merged into the old one's history: %+v", revs)
	}
}
