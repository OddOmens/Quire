package server

import (
	"net/http"
	"time"

	"github.com/oddomens/quire/internal/formula"
	"github.com/oddomens/quire/internal/table"
)

// calendarEvent is something on a day: a database row placed there by a
// calendar view, or a line of a page with a date chip ("@2026-11-20").
type calendarEvent struct {
	Path string `json:"path"`
	// Table is the title of the database the row is in, or of the page the
	// line is on.
	Table string `json:"table"`
	// Row is the row's id; a line of a page has none.
	Row   string `json:"row"`
	Title string `json:"title"`
	// Start and End are YYYY-MM-DD, or YYYY-MM-DDTHH:MM with a time.
	Start string `json:"start"`
	End   string `json:"end,omitempty"`
	// Color is the colour of the row's first select option, if any.
	Color string `json:"color,omitempty"`
	// Label is that option's name.
	Label string `json:"label,omitempty"`
	Done  bool   `json:"done,omitempty"`
	// Kind is "" for a database row, "task" for a to-do with a date chip on
	// a page and "date" for any other line with one.
	Kind string `json:"kind,omitempty"`
	// Line and Heading say where on the page a task or date is: its 1-based
	// line in the file and the nearest heading above it.
	Line    int    `json:"line,omitempty"`
	Heading string `json:"heading,omitempty"`
}

// calendar gathers the rows of every database's calendar views, and the
// lines of every page with a date chip, that fall between from and to
// (YYYY-MM-DD, both included).
func (s *Server) calendar(w http.ResponseWriter, r *http.Request) {
	from, err1 := time.Parse(time.DateOnly, r.URL.Query().Get("from"))
	to, err2 := time.Parse(time.DateOnly, r.URL.Query().Get("to"))
	if err1 != nil || err2 != nil || to.Before(from) || to.Sub(from) > 400*24*time.Hour {
		writeErr(w, http.StatusBadRequest, "give from and to as YYYY-MM-DD, at most a year or so apart")
		return
	}
	end := to.AddDate(0, 0, 1)
	notes, err := s.store.Notes()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	c := s.computer(r)
	events := []calendarEvent{}
	for _, n := range notes {
		if n.Kind != "database" {
			continue
		}
		t, _, _, err := s.readTable(n.Path)
		if err != nil {
			continue
		}
		var res *table.Result
		seen := map[string]bool{}
		for _, v := range t.Schema.Views {
			if v.Type != "calendar" || v.DateColumn == "" || seen[v.DateColumn+"|"+v.EndColumn] {
				continue
			}
			seen[v.DateColumn+"|"+v.EndColumn] = true
			if res == nil {
				res = c.Compute(n.Path, t)
			}
			events = append(events, rowEvents(n.Path, n.Title, t, res, v, from, end)...)
		}
	}
	dated, err := s.store.Dated(from.Format(time.DateOnly), to.Format(time.DateOnly))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	for _, d := range dated {
		e := calendarEvent{Path: d.Path, Table: d.Title, Title: d.Text, Start: d.Date, Kind: "date", Line: d.Line, Heading: d.Heading, Done: d.Done}
		if d.Task {
			e.Kind = "task"
		}
		// A chip on a line of its own speaks for the whole page.
		if e.Title == "" {
			e.Title = d.Title
		}
		events = append(events, e)
	}
	writeJSON(w, http.StatusOK, events)
}

func rowEvents(page, title string, t *table.Table, res *table.Result, v table.View, from, end time.Time) []calendarEvent {
	dateOf := func(colID string, row table.Row) (formula.Value, bool) {
		c := t.Column(colID)
		if c == nil {
			return formula.Value{}, false
		}
		var val formula.Value
		if table.Stored(c.Type) {
			val = table.Typed(c, row.Cells[c.ID])
		} else {
			val = res.Values[row.ID][c.ID]
		}
		if val.K == formula.List && len(val.L) > 0 {
			val = val.L[0]
		}
		if val.K == formula.Text {
			if d, ok := formula.ParseDate(val.S); ok {
				val = d
			}
		}
		return val, val.K == formula.Date
	}
	var label *table.Column
	var done *table.Column
	for i := range t.Schema.Columns {
		c := &t.Schema.Columns[i]
		if label == nil && c.Type == table.Select {
			label = c
		}
		if done == nil && c.Type == table.Checkbox {
			done = c
		}
	}
	format := func(d formula.Value) string {
		if d.HasTime {
			return d.T.Format("2006-01-02T15:04")
		}
		return d.T.Format(time.DateOnly)
	}
	var out []calendarEvent
	for _, row := range t.Rows {
		start, ok := dateOf(v.DateColumn, row)
		if !ok {
			continue
		}
		last := start
		e := calendarEvent{Path: page, Table: title, Row: row.ID, Title: t.Title(row), Start: format(start)}
		if v.EndColumn != "" {
			if fin, ok := dateOf(v.EndColumn, row); ok && !fin.T.Before(start.T) {
				last = fin
				e.End = format(fin)
			}
		}
		// Keep rows that overlap the range.
		if !start.T.Before(end) || last.T.Before(from) {
			continue
		}
		if label != nil {
			name := row.Cells[label.ID]
			for _, o := range label.Options {
				if o.Name == name {
					e.Label, e.Color = o.Name, o.Color
				}
			}
		}
		if done != nil {
			e.Done = row.Cells[done.ID] == "true"
		}
		out = append(out, e)
	}
	return out
}
