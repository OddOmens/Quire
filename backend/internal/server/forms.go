package server

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/oddomens/quire/internal/table"
	"github.com/oddomens/quire/internal/vault"
)

// Forms add rows to a database. Inside Quire a form is filled in through
// the API; a public link serves a plain HTML form (no script, no access to
// anything else) at /f/{token}, on the main address and, if
// QUIRE_PUBLIC_LISTEN is set, on a second address that serves nothing else.

// submission checks a form's answers and builds the row they make. Select
// answers must be one of the column's options; nothing outside the form's
// fields (and its fixed defaults) is written. problems maps column ids to
// what's wrong.
//
// public is for answers from a form link: they can't set file cells, which
// the public page never shows, and text that a spreadsheet would run as a
// formula gets a leading ' since the rows are kept as a CSV file people open.
func submission(t *table.Table, f *table.Form, answers map[string]string, now time.Time, public bool) (table.Row, map[string]string) {
	row := table.Row{ID: table.NewID("r"), Created: time.Now().UTC().Format(time.RFC3339), Cells: map[string]string{}}
	problems := map[string]string{}
	for id, v := range f.Defaults {
		if c := t.Column(id); c != nil && table.Stored(c.Type) {
			if nv, err := t.Normalize(c, v, now); err == nil && nv != "" {
				row.Cells[id] = nv
			}
		}
	}
	for _, ff := range f.Fields {
		c := t.Column(ff.Column)
		if c == nil || !table.Stored(c.Type) || c.Type == table.Relation || public && c.Type == table.File {
			continue
		}
		raw := strings.TrimSpace(answers[c.ID])
		if raw == "" {
			if ff.Required {
				problems[c.ID] = "this is required"
			}
			continue
		}
		if c.Type == table.Select || c.Type == table.Multi {
			parts := []string{raw}
			if c.Type == table.Multi {
				parts = strings.Split(raw, ",")
			}
			for _, part := range parts {
				part = strings.TrimSpace(part)
				known := false
				for _, o := range c.Options {
					if strings.EqualFold(o.Name, part) {
						known = true
					}
				}
				if part != "" && !known {
					problems[c.ID] = "choose one of the options"
				}
			}
			if problems[c.ID] != "" {
				continue
			}
		}
		v, err := t.Normalize(c, raw, now)
		if err != nil {
			problems[c.ID] = err.Error()
			continue
		}
		if public && c.Type == table.Text {
			v = safeCell(v)
		}
		if v != "" {
			row.Cells[c.ID] = v
		}
	}
	return row, problems
}

// submitForm takes a form's answers from inside Quire.
func (s *Server) submitForm(w http.ResponseWriter, r *http.Request) {
	p, ok := s.tablePage(w, r)
	if !ok {
		return
	}
	var req struct {
		Answers map[string]string `json:"answers"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	now := wallNow(loc(r))
	var problems map[string]string
	err := func() error {
		s.writeMu.Lock()
		defer s.writeMu.Unlock()
		t, rows, schema, err := s.readTable(p)
		if err != nil {
			return err
		}
		f := t.Form(r.PathValue("form"))
		if f == nil {
			return vault.ErrNotFound
		}
		var row table.Row
		if row, problems = submission(t, f, req.Answers, now, false); len(problems) > 0 {
			return nil
		}
		if len(t.Rows) >= table.MaxRows {
			return table.ErrTooLarge
		}
		t.Rows = append(t.Rows, row)
		_, _, err = s.writeTable(r, p, t, rows, schema, "form")
		return err
	}()
	if err != nil {
		s.tableFail(w, r, err)
		return
	}
	if len(problems) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "some answers need a look", "problems": problems})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listFormLinks(w http.ResponseWriter, r *http.Request) {
	links, err := s.store.FormLinks(r.URL.Query().Get("path"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, links)
}

func (s *Server) createFormLink(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
		Form string `json:"form"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	p, err := vault.CleanPage(req.Path)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	t, _, _, err := s.readTable(p)
	if err != nil {
		s.tableFail(w, r, err)
		return
	}
	if t.Form(req.Form) == nil {
		s.fail(w, r, vault.ErrNotFound)
		return
	}
	l, err := s.store.CreateFormLink(p, req.Form)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, l)
}

func (s *Server) deleteFormLink(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteFormLink(r.PathValue("token")); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── The public form ──

//go:embed form.html
var formHTML string

var formPage = template.Must(template.New("form").Funcs(template.FuncMap{
	"has": func(list []string, v string) bool {
		for _, x := range list {
			if strings.EqualFold(x, v) {
				return true
			}
		}
		return false
	},
}).Parse(formHTML))

type formField struct {
	ID, Label, Help, Type, Format, Value, Problem string
	Required                                      bool
	Options                                       []string
	Values                                        []string
	Long                                          bool
}

type formView struct {
	Title, Description, Submit, Thanks, Stamp, Error string
	Fields                                           []formField
	Done, Closed                                     bool
}

// PublicHandler serves only public forms, for QUIRE_PUBLIC_LISTEN: an
// address you can expose to the internet without exposing Quire.
func (s *Server) PublicHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /f/{token}", s.publicForm)
	mux.HandleFunc("POST /f/{token}", s.publicForm)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "Not found", http.StatusNotFound)
	})
	return s.secure(s.logRequests(mux))
}

// stamp signs the time a form was shown. A submission needs a stamp that's
// at least a couple of seconds old (bots post at once) and under a day old.
// answerLimiter caps public form answers: maxAnswers per address and
// maxAllAnswers from everyone within answerWindow, so a bot can't fill a
// database faster than someone could notice.
type answerLimiter struct {
	mu  sync.Mutex
	per map[string][]time.Time
	all []time.Time
}

const (
	maxAnswers    = 8
	maxAllAnswers = 60
	answerWindow  = 15 * time.Minute
)

func newAnswerLimiter() *answerLimiter { return &answerLimiter{per: map[string][]time.Time{}} }

func (l *answerLimiter) prune(ts []time.Time) []time.Time {
	cut := time.Now().Add(-answerWindow)
	i := 0
	for i < len(ts) && ts[i].Before(cut) {
		i++
	}
	return ts[i:]
}

// allow reports whether ip may send another answer.
func (l *answerLimiter) allow(ip string) bool {
	ip = limitKey(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	l.all = l.prune(l.all)
	ts := l.prune(l.per[ip])
	if len(ts) == 0 {
		delete(l.per, ip)
	} else {
		l.per[ip] = ts
	}
	return len(ts) < maxAnswers && len(l.all) < maxAllAnswers
}

// count records an answer saved from ip.
func (l *answerLimiter) count(ip string) {
	ip = limitKey(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	l.per[ip] = append(l.prune(l.per[ip]), now)
	l.all = append(l.prune(l.all), now)
}

// sweep forgets addresses whose answers have all aged out.
func (l *answerLimiter) sweep() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for ip, ts := range l.per {
		if ts = l.prune(ts); len(ts) == 0 {
			delete(l.per, ip)
		} else {
			l.per[ip] = ts
		}
	}
	l.all = l.prune(l.all)
}

func (s *Server) stamp(token string, t time.Time) string {
	ts := strconv.FormatInt(t.Unix(), 10)
	mac := hmac.New(sha256.New, s.formKey())
	mac.Write([]byte(token + "|" + ts))
	return ts + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:16])
}

func (s *Server) checkStamp(token, st string) error {
	ts, _, ok := strings.Cut(st, ".")
	n, err := strconv.ParseInt(ts, 10, 64)
	if !ok || err != nil || !hmac.Equal([]byte(s.stamp(token, time.Unix(n, 0))), []byte(st)) {
		return errors.New("this form expired; reload the page and try again")
	}
	age := time.Since(time.Unix(n, 0))
	switch {
	case age < 2*time.Second:
		return errors.New("that was quick; please try again")
	case age > 24*time.Hour:
		return errors.New("this form expired; reload the page and try again")
	}
	return nil
}

func (s *Server) formKey() []byte {
	s.formKeyOnce.Do(func() {
		s.formSecret = make([]byte, 32)
		_, _ = rand.Read(s.formSecret)
	})
	return s.formSecret
}

func (s *Server) publicForm(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	w.Header().Set("Cache-Control", "no-store")
	gone := func() {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_ = formPage.Execute(w, formView{Title: "This form isn't available", Closed: true})
	}
	token := r.PathValue("token")
	if !validToken.MatchString(token) {
		gone()
		return
	}
	link, err := s.store.FormLink(token)
	if err != nil {
		gone()
		return
	}
	if rev, err := s.store.IndexedRev(link.Path); err != nil || rev == "" {
		gone()
		return
	}
	// Showing the form needs only the columns, not the rows: a visitor
	// reloading it shouldn't make the server read a large database.
	var t *table.Table
	if r.Method == http.MethodPost {
		t, _, _, err = s.readTable(link.Path)
	} else {
		t, err = s.readSchema(link.Path)
	}
	if err != nil {
		gone()
		return
	}
	f := t.Form(link.Form)
	if f == nil {
		gone()
		return
	}
	view := formView{Title: f.Title, Description: f.Description, Submit: f.Submit, Thanks: f.Thanks}
	if view.Title == "" {
		view.Title = f.Name
	}
	if view.Submit == "" {
		view.Submit = "Submit"
	}
	if view.Thanks == "" {
		view.Thanks = "Thanks, your answers were sent."
	}
	closed := f.Closed || (f.Limit > 0 && link.Responses >= f.Limit)
	answers := map[string]string{}
	problems := map[string]string{}
	status := http.StatusOK

	if r.Method == http.MethodPost && !closed {
		r.Body = http.MaxBytesReader(w, r.Body, 256<<10)
		ip := s.clientIP(r)
		switch {
		case r.ParseForm() != nil:
			view.Error, status = "the answers couldn't be read", http.StatusBadRequest
		case r.PostForm.Get("website") != "":
			// The honeypot field is hidden from people; only bots fill it.
			view.Done = true
		case !s.formLimiter.allow(ip):
			view.Error, status = "too many answers from your network; try again in a few minutes", http.StatusTooManyRequests
		default:
			if err := s.checkStamp(token, r.PostForm.Get("stamp")); err != nil {
				view.Error, status = err.Error(), http.StatusBadRequest
				break
			}
			for _, ff := range f.Fields {
				if vals := r.PostForm[ff.Column]; len(vals) > 0 {
					answers[ff.Column] = strings.Join(vals, ",")
				}
			}
			now := wallNow(time.Local)
			// The limits are checked again and counted under the write lock,
			// so answers sent at the same moment can't all slip in under them.
			var limited, full bool
			err := func() error {
				s.writeMu.Lock()
				defer s.writeMu.Unlock()
				if !s.formLimiter.allow(ip) {
					limited = true
					return nil
				}
				t2, rows, schema, err := s.readTable(link.Path)
				if err != nil {
					return err
				}
				f2 := t2.Form(link.Form)
				if f2 == nil {
					return vault.ErrNotFound
				}
				if cur, err := s.store.FormLink(token); err != nil {
					return err
				} else if f2.Closed || (f2.Limit > 0 && cur.Responses >= f2.Limit) {
					full = true
					return nil
				}
				var row table.Row
				if row, problems = submission(t2, f2, answers, now, true); len(problems) > 0 {
					return nil
				}
				if len(t2.Rows) >= table.MaxRows {
					return table.ErrTooLarge
				}
				t2.Rows = append(t2.Rows, row)
				if _, _, err = s.writeTable(nil, link.Path, t2, rows, schema, "form"); err != nil {
					return err
				}
				s.formLimiter.count(ip)
				if err := s.store.CountFormResponse(token); err != nil {
					s.log.Warn("count form response", "err", err)
				}
				return nil
			}()
			switch {
			case err != nil:
				s.log.Error("public form", "path", link.Path, "err", err)
				view.Error, status = "your answers couldn't be saved; try again later", http.StatusInternalServerError
			case limited:
				view.Error, status = "too many answers from your network; try again in a few minutes", http.StatusTooManyRequests
			case full:
				closed = true
			case len(problems) > 0:
				view.Error, status = "some answers need a look", http.StatusBadRequest
			default:
				s.log.Info("form answered", "path", link.Path, "form", f.Name)
				view.Done = true
			}
		}
	}
	view.Closed = closed && !view.Done
	view.Stamp = s.stamp(token, time.Now())
	for _, ff := range f.Fields {
		c := t.Column(ff.Column)
		if c == nil || !table.Stored(c.Type) || c.Type == table.Relation || c.Type == table.File {
			continue
		}
		field := formField{
			ID: c.ID, Label: ff.Label, Help: ff.Help, Type: c.Type, Format: c.Format,
			Required: ff.Required, Value: answers[c.ID], Problem: problems[c.ID],
			Long: c.Type == table.Text && c.ID != t.Primary().ID,
		}
		if field.Label == "" {
			field.Label = c.Name
		}
		for _, o := range c.Options {
			field.Options = append(field.Options, o.Name)
		}
		if c.Type == table.Multi {
			field.Values = strings.Split(answers[c.ID], ",")
		}
		view.Fields = append(view.Fields, field)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	if err := formPage.Execute(w, view); err != nil {
		s.log.Warn("render form", "err", fmt.Sprint(err))
	}
}
