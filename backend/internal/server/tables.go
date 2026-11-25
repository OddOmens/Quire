package server

import (
	"bytes"
	"cmp"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/oddomens/quire/internal/formula"
	"github.com/oddomens/quire/internal/store"
	"github.com/oddomens/quire/internal/table"
	"github.com/oddomens/quire/internal/vault"
)

// Databases are pages with rows and columns. The page (Budget.md) carries
// "database: true" in its front matter and whatever text goes above the
// rows; Budget.csv holds the rows and Budget.schema.json the columns, views
// and forms. Computed columns (formulas, rollups) are worked out on every
// read, in the reader's time zone, and never stored.

// tableData is what the API sends for a database.
type tableData struct {
	Path   string                              `json:"path"`
	Rev    string                              `json:"rev"`
	Schema table.Schema                        `json:"schema"`
	Rows   []table.Row                         `json:"rows"`
	Values map[string]map[string]formula.Value `json:"values"`
	// Errors explains computed columns that can't be worked out.
	Errors map[string]string `json:"errors"`
	// Related gives the titles of linked rows: column id, row id, title.
	Related map[string]map[string]string `json:"related"`
	// Targets is the database page each relation column links to.
	Targets map[string]string `json:"targets"`
}

// loc is the reader's time zone, from X-Timezone (an IANA name the web app
// sends), for TODAY(), NOW() and creation times.
func loc(r *http.Request) *time.Location {
	if r == nil {
		return time.Local
	}
	name := r.Header.Get("X-Timezone")
	if name == "" || len(name) > 64 {
		return time.Local
	}
	l, err := time.LoadLocation(name)
	if err != nil {
		return time.Local
	}
	return l
}

// wallNow is the current time as a wall clock in loc, stored as UTC, the
// way formula dates are.
func wallNow(l *time.Location) time.Time {
	n := time.Now().In(l)
	return time.Date(n.Year(), n.Month(), n.Day(), n.Hour(), n.Minute(), n.Second(), 0, time.UTC)
}

// readTable loads a database page's rows and schema. It answers ErrNotFound
// for a page that isn't a database.
func (s *Server) readTable(page string) (*table.Table, []byte, []byte, error) {
	rowsPath, schemaPath := vault.TableFiles(page)
	schema, _, err := s.vault.Read(schemaPath)
	if err != nil {
		return nil, nil, nil, err
	}
	rows, _, err := s.vault.Read(rowsPath)
	if err != nil && !errors.Is(err, vault.ErrNotFound) {
		return nil, nil, nil, err
	}
	t, err := table.Read(rows, schema)
	if err != nil {
		return nil, nil, nil, err
	}
	return t, rows, schema, nil
}

// readSchema reads a database's columns, views and forms without its rows.
func (s *Server) readSchema(page string) (*table.Table, error) {
	_, schemaPath := vault.TableFiles(page)
	schema, _, err := s.vault.Read(schemaPath)
	if err != nil {
		return nil, err
	}
	return table.Read(nil, schema)
}

func tableRev(rows, schema []byte) string {
	return vault.Rev(append(append(append([]byte{}, schema...), 0), rows...))
}

// tableSource opens the databases formulas and relations name, resolving
// names like [[links]] from the page that asks.
type tableSource struct {
	s   *Server
	res *store.Resolver
}

func (ts *tableSource) Open(from, target string) (*table.Table, string, error) {
	p := ""
	if t, err := vault.CleanPage(target); err == nil && ts.s.vault.IsFile(t) {
		p = t
	} else {
		if ts.res == nil {
			r, err := ts.s.store.Resolver()
			if err != nil {
				return nil, "", err
			}
			ts.res = r
		}
		p = ts.res.Resolve(target, from)
	}
	if p == "" {
		return nil, "", vault.ErrNotFound
	}
	t, _, _, err := ts.s.readTable(p)
	return t, p, err
}

func (s *Server) computer(r *http.Request) *table.Computer {
	l := loc(r)
	return table.NewComputer(&tableSource{s: s}, wallNow(l), l)
}

func (s *Server) tableData(r *http.Request, page string, t *table.Table, rows, schema []byte) tableData {
	res := s.computer(r).Compute(page, t)
	return tableData{
		Path: page, Rev: tableRev(rows, schema), Schema: t.Schema, Rows: emptyRows(t.Rows),
		Values: res.Values, Errors: res.Errors, Related: res.Related, Targets: res.Targets,
	}
}

func emptyRows(r []table.Row) []table.Row {
	if r == nil {
		return []table.Row{}
	}
	return r
}

// tablePage reads the {path} of a database page, or answers 404.
func (s *Server) tablePage(w http.ResponseWriter, r *http.Request) (string, bool) {
	p, err := vault.CleanPage(r.PathValue("path"))
	if err != nil {
		s.fail(w, r, err)
		return "", false
	}
	return p, true
}

func (s *Server) getTable(w http.ResponseWriter, r *http.Request) {
	p, ok := s.tablePage(w, r)
	if !ok {
		return
	}
	t, rows, schema, err := s.readTable(p)
	if err != nil {
		s.tableFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, s.tableData(r, p, t, rows, schema))
}

func (s *Server) tableFail(w http.ResponseWriter, r *http.Request, err error) {
	var ie *table.InputError
	switch {
	case errors.As(err, &ie):
		writeErr(w, http.StatusBadRequest, ie.Msg)
	case errors.Is(err, table.ErrTooLarge):
		writeErr(w, http.StatusRequestEntityTooLarge, err.Error())
	case errors.Is(err, vault.ErrNotFound):
		writeErr(w, http.StatusNotFound, "this database's files are missing")
	default:
		s.fail(w, r, err)
	}
}

// writeTable saves what changed, records it in history and tells open
// clients. Callers hold writeMu. prevRows and prevSchema are what was read.
func (s *Server) writeTable(r *http.Request, page string, t *table.Table, prevRows, prevSchema []byte, source string) ([]byte, []byte, error) {
	rowsPath, schemaPath := vault.TableFiles(page)
	rows, err := t.EncodeCSV()
	if err != nil {
		return nil, nil, err
	}
	schema, err := t.EncodeSchema()
	if err != nil {
		return nil, nil, err
	}
	if len(rows) > table.MaxFileSize {
		return nil, nil, table.ErrTooLarge
	}
	changed := false
	for _, f := range []struct {
		path       string
		prev, next []byte
	}{{schemaPath, prevSchema, schema}, {rowsPath, prevRows, rows}} {
		if prev := f.prev; prev != nil && bytes.Equal(prev, f.next) {
			continue
		}
		if _, err := s.vault.Write(f.path, f.next); err != nil {
			return nil, nil, err
		}
		if err := s.store.Record(f.path, f.prev, f.next, source); err != nil {
			s.log.Warn("record history", "path", f.path, "err", err)
		}
		changed = true
	}
	if changed {
		s.publish(r, "table", page)
	}
	return rows, schema, nil
}

// mutateTable runs change on a database under the write lock, saves it and
// answers with the new data.
func (s *Server) mutateTable(w http.ResponseWriter, r *http.Request, page string, change func(t *table.Table) error) {
	var t *table.Table
	var rows, schema []byte
	var err error
	func() {
		s.writeMu.Lock()
		defer s.writeMu.Unlock()
		if t, rows, schema, err = s.readTable(page); err == nil {
			err = change(t)
		}
		if err == nil {
			rows, schema, err = s.writeTable(r, page, t, rows, schema, "edit")
		}
	}()
	if err != nil {
		s.tableFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, s.tableData(r, page, t, rows, schema))
}

// databaseFrontmatter marks a page as a database, keeping its other text.
func databaseFrontmatter(content string) string {
	if vault.ReadFrontmatter(content).Database {
		return content
	}
	if vault.HasFrontmatter(content) {
		_, rest, _ := strings.Cut(content, "\n")
		return "---\ndatabase: true\n" + rest
	}
	return "---\ndatabase: true\n---\n" + content
}

// createTable adds a database page under a space or page. A template sets
// up its first columns and views.
func (s *Server) createTable(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Parent   string `json:"parent"`
		Title    string `json:"title"`
		Template string `json:"template"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	t := templateTable(req.Template)
	s.createDatabasePage(w, r, req.Parent, req.Title, t)
}

func (s *Server) createDatabasePage(w http.ResponseWriter, r *http.Request, parentIn, title string, t *table.Table) {
	parent, err := vault.Clean(parentIn)
	if err != nil || vault.SpaceOf(parent) == vault.AttachmentsDir {
		s.fail(w, r, vault.ErrInvalid)
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if !s.vault.IsDir(vault.SpaceOf(parent)) {
		writeErr(w, http.StatusNotFound, "that space doesn't exist")
		return
	}
	p, err := vault.CleanPage(path.Join(vault.Base(parent), pageName(title)+".md"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	p = s.vault.Unique(p)
	if _, _, err := s.writeTable(r, p, t, nil, nil, "edit"); err != nil {
		s.tableFail(w, r, err)
		return
	}
	content := []byte(databaseFrontmatter(""))
	e, err := s.vault.Create(p, content)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.store.Put(e, content); err != nil {
		s.fail(w, r, err)
		return
	}
	s.publish(r, "tree", p)
	d, err := s.detail(p, content)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, d)
}

// templateTable is a new database's starting columns and views.
func templateTable(name string) *table.Table {
	t := table.New()
	add := func(c table.Column) string {
		c.ID = table.NewID("c")
		t.Schema.Columns = append(t.Schema.Columns, c)
		return c.ID
	}
	switch name {
	case "calendar":
		date := add(table.Column{Name: "Date", Type: table.Date, Format: "datetime"})
		add(table.Column{Name: "Ends", Type: table.Date, Format: "datetime"})
		add(table.Column{Name: "Type", Type: table.Select, Options: []table.Option{{Name: "Maintenance", Color: "amber"}, {Name: "Reminder", Color: "blue"}, {Name: "Event", Color: "green"}}})
		add(table.Column{Name: "Done", Type: table.Checkbox})
		add(table.Column{Name: "Notes", Type: table.Text, Width: 280})
		t.Schema.Views = []table.View{
			{ID: table.NewID("v"), Name: "Calendar", Type: "calendar", DateColumn: date},
			{ID: table.NewID("v"), Name: "List", Type: "table", Sorts: []table.Sort{{Column: date}}},
		}
	case "tracker":
		status := add(table.Column{Name: "Status", Type: table.Select, Options: []table.Option{{Name: "To do", Color: "gray"}, {Name: "Doing", Color: "blue"}, {Name: "Done", Color: "green"}}})
		add(table.Column{Name: "Due", Type: table.Date})
		add(table.Column{Name: "Notes", Type: table.Text, Width: 280})
		t.Schema.Views = append(t.Schema.Views, table.View{ID: table.NewID("v"), Name: "Board", Type: "board", GroupBy: status})
	case "budget":
		amount := add(table.Column{Name: "Amount", Type: table.Number, Format: "currency", Currency: "USD"})
		add(table.Column{Name: "Category", Type: table.Select})
		add(table.Column{Name: "Date", Type: table.Date})
		t.Schema.Views[0].Summaries = map[string]string{amount: "sum"}
	}
	return t
}

// convertTable turns an existing page into a database, keeping its text.
func (s *Server) convertTable(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	p, err := vault.CleanPage(req.Path)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	cur, _, err := s.vault.Read(p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if _, schemaPath := vault.TableFiles(p); !s.vault.IsFile(schemaPath) {
		if _, _, err := s.writeTable(r, p, table.New(), nil, nil, "edit"); err != nil {
			s.tableFail(w, r, err)
			return
		}
	}
	d, _, err := s.save(r, p, []byte(databaseFrontmatter(string(cur))), "", "edit")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.publish(r, "tree", p)
	writeJSON(w, http.StatusOK, d)
}

func (s *Server) putSchema(w http.ResponseWriter, r *http.Request) {
	p, ok := s.tablePage(w, r)
	if !ok {
		return
	}
	var req struct {
		Schema  table.Schema `json:"schema"`
		BaseRev string       `json:"baseRev"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	now := wallNow(loc(r))
	var t *table.Table
	var rows, schema []byte
	var err error
	stale := false
	func() {
		s.writeMu.Lock()
		defer s.writeMu.Unlock()
		t, rows, schema, err = s.readTable(p)
		if err == nil && req.BaseRev != "" && req.BaseRev != tableRev(rows, schema) {
			stale = true
			return
		}
		if err == nil {
			err = t.ApplySchema(req.Schema, now)
		}
		if err == nil {
			err = s.checkRelations(p, t)
		}
		if err == nil {
			rows, schema, err = s.writeTable(r, p, t, rows, schema, "edit")
		}
	}()
	if stale {
		d := s.tableData(r, p, t, rows, schema)
		writeJSON(w, http.StatusConflict, map[string]any{"error": "this database changed somewhere else", "table": d})
		return
	}
	if err != nil {
		s.tableFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, s.tableData(r, p, t, rows, schema))
}

// checkRelations makes sure every relation links to a database page, stored
// by its path.
func (s *Server) checkRelations(page string, t *table.Table) error {
	for i := range t.Schema.Columns {
		c := &t.Schema.Columns[i]
		if c.Type != table.Relation || c.Target == "" {
			continue
		}
		target, err := vault.CleanPage(c.Target)
		if err != nil {
			return &table.InputError{Msg: fmt.Sprintf("%q links to a page that isn't a database", c.Name)}
		}
		if target == page {
			continue
		}
		if _, schemaPath := vault.TableFiles(target); !s.vault.IsFile(schemaPath) {
			return &table.InputError{Msg: fmt.Sprintf("%q links to a page that isn't a database", c.Name)}
		}
		c.Target = target
	}
	return nil
}

type cellInput struct {
	ID    string            `json:"id"`
	Cells map[string]string `json:"cells"`
}

// applyCells stores typed-in values on a row. It returns the problems with
// cells it couldn't take, keyed by column id.
func applyCells(t *table.Table, row *table.Row, cells map[string]string, now time.Time) map[string]string {
	var bad map[string]string
	for id, raw := range cells {
		c := t.Column(id)
		if c == nil || !table.Stored(c.Type) {
			continue
		}
		v, err := t.Normalize(c, raw, now)
		if err != nil {
			if bad == nil {
				bad = map[string]string{}
			}
			bad[id] = err.Error()
			continue
		}
		if v == "" {
			delete(row.Cells, id)
		} else {
			row.Cells[id] = v
		}
	}
	return bad
}

// addRows inserts new rows, before the row "before" or at the end.
func (s *Server) addRows(w http.ResponseWriter, r *http.Request) {
	p, ok := s.tablePage(w, r)
	if !ok {
		return
	}
	var req struct {
		Rows   []cellInput `json:"rows"`
		Before string      `json:"before"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if len(req.Rows) == 0 {
		req.Rows = []cellInput{{}}
	}
	now := wallNow(loc(r))
	s.mutateTable(w, r, p, func(t *table.Table) error {
		if len(t.Rows)+len(req.Rows) > table.MaxRows {
			return table.ErrTooLarge
		}
		var added []table.Row
		for _, in := range req.Rows {
			row := table.Row{ID: table.NewID("r"), Created: time.Now().UTC().Format(time.RFC3339), Cells: map[string]string{}}
			if len(req.Rows) == 1 {
				if bad := applyCells(t, &row, in.Cells, now); bad != nil {
					return &table.InputError{Msg: firstProblem(t, bad)}
				}
			} else {
				applyCells(t, &row, in.Cells, now) // a paste keeps what fits
			}
			added = append(added, row)
		}
		at := t.RowIndex(req.Before)
		if at < 0 {
			at = len(t.Rows)
		}
		t.Rows = slices.Insert(t.Rows, at, added...)
		return nil
	})
}

func firstProblem(t *table.Table, bad map[string]string) string {
	for _, c := range t.Schema.Columns {
		if msg, ok := bad[c.ID]; ok {
			return c.Name + ": " + msg
		}
	}
	return "a value doesn't fit its column"
}

// updateRows changes cells. One cell that doesn't fit refuses the change; in
// a larger paste the cells that fit are kept and the rest reported.
func (s *Server) updateRows(w http.ResponseWriter, r *http.Request) {
	p, ok := s.tablePage(w, r)
	if !ok {
		return
	}
	var req struct {
		Rows []cellInput `json:"rows"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	now := wallNow(loc(r))
	skipped := 0
	s.mutateTable(w, r, p, func(t *table.Table) error {
		single := len(req.Rows) == 1 && len(req.Rows[0].Cells) == 1
		for _, in := range req.Rows {
			i := t.RowIndex(in.ID)
			if i < 0 {
				continue // deleted elsewhere
			}
			bad := applyCells(t, &t.Rows[i], in.Cells, now)
			if bad != nil && single {
				return &table.InputError{Msg: firstProblem(t, bad)}
			}
			skipped += len(bad)
		}
		if skipped > 0 {
			w.Header().Set("X-Skipped-Cells", fmt.Sprint(skipped))
		}
		return nil
	})
}

func (s *Server) deleteRows(w http.ResponseWriter, r *http.Request) {
	p, ok := s.tablePage(w, r)
	if !ok {
		return
	}
	var req struct {
		IDs []string `json:"ids"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	s.mutateTable(w, r, p, func(t *table.Table) error {
		t.Rows = slices.DeleteFunc(t.Rows, func(row table.Row) bool { return slices.Contains(req.IDs, row.ID) })
		return nil
	})
}

// moveRows puts rows, in the order given, before the row "before" or last.
func (s *Server) moveRows(w http.ResponseWriter, r *http.Request) {
	p, ok := s.tablePage(w, r)
	if !ok {
		return
	}
	var req struct {
		IDs    []string `json:"ids"`
		Before string   `json:"before"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	s.mutateTable(w, r, p, func(t *table.Table) error {
		var moving []table.Row
		for _, id := range req.IDs {
			if i := t.RowIndex(id); i >= 0 && !slices.ContainsFunc(moving, func(x table.Row) bool { return x.ID == id }) {
				moving = append(moving, t.Rows[i])
			}
		}
		t.Rows = slices.DeleteFunc(t.Rows, func(row table.Row) bool { return slices.Contains(req.IDs, row.ID) })
		at := t.RowIndex(req.Before)
		if at < 0 {
			at = len(t.Rows)
		}
		t.Rows = slices.Insert(t.Rows, at, moving...)
		return nil
	})
}

// listTables lists every database, for relation pickers and the calendar.
func (s *Server) listTables(w http.ResponseWriter, r *http.Request) {
	notes, err := s.store.Notes()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	type column struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Type string `json:"type"`
	}
	type info struct {
		Path    string   `json:"path"`
		Title   string   `json:"title"`
		Columns []column `json:"columns"`
		Rows    int      `json:"rows"`
	}
	out := []info{}
	for _, n := range notes {
		if n.Kind != "database" {
			continue
		}
		t, _, _, err := s.readTable(n.Path)
		if err != nil {
			continue
		}
		in := info{Path: n.Path, Title: n.Title, Rows: len(t.Rows)}
		for _, c := range t.Schema.Columns {
			in.Columns = append(in.Columns, column{c.ID, c.Name, c.Type})
		}
		out = append(out, in)
	}
	writeJSON(w, http.StatusOK, out)
}

// previewFormula checks a formula for a column and works it out for the
// first rows, for the formula editor.
func (s *Server) previewFormula(w http.ResponseWriter, r *http.Request) {
	p, ok := s.tablePage(w, r)
	if !ok {
		return
	}
	var req struct {
		Formula string `json:"formula"`
		Column  string `json:"column"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if _, err := formula.Parse(req.Formula); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"error": err.Error(), "values": []any{}})
		return
	}
	t, _, _, err := s.readTable(p)
	if err != nil {
		s.tableFail(w, r, err)
		return
	}
	// Work it out as if it were the column being edited.
	if c := t.Column(req.Column); c != nil && c.Type == table.Formula {
		c.Formula = req.Formula
	} else {
		t.Schema.Columns = append(t.Schema.Columns, table.Column{ID: "preview", Name: "\x00preview", Type: table.Formula, Formula: req.Formula})
		req.Column = "preview"
	}
	res := s.computer(r).Compute(p, t)
	if msg, bad := res.Errors[req.Column]; bad {
		writeJSON(w, http.StatusOK, map[string]any{"error": msg, "values": []any{}})
		return
	}
	type sample struct {
		Row   string        `json:"row"`
		Title string        `json:"title"`
		Value formula.Value `json:"value"`
	}
	out := []sample{}
	for _, row := range t.Rows[:min(len(t.Rows), 5)] {
		out = append(out, sample{row.ID, t.Title(row), res.Values[row.ID][req.Column]})
	}
	writeJSON(w, http.StatusOK, map[string]any{"values": out})
}

// evalFormulas works out the {{ … }} formulas on a page.
func (s *Server) evalFormulas(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path     string   `json:"path"`
		Formulas []string `json:"formulas"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	p, err := vault.CleanPage(req.Path)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if len(req.Formulas) > 200 {
		writeErr(w, http.StatusBadRequest, "too many formulas on one page")
		return
	}
	c := s.computer(r)
	ctx := table.PageContext{C: c, Path: p}
	if t, _, _, err := s.readTable(p); err == nil {
		ctx.Res = c.Compute(p, t)
	}
	type result struct {
		Value formula.Value `json:"value"`
		Error string        `json:"error,omitempty"`
	}
	out := make([]result, len(req.Formulas))
	for i, src := range req.Formulas {
		n, err := formula.Parse(src)
		if err != nil {
			out[i] = result{Error: err.Error()}
			continue
		}
		v := c.Eval(n, ctx)
		out[i] = result{Value: v}
		if v.K == formula.Error {
			out[i].Error = v.Msg
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) formulaFunctions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, formula.Functions())
}

// exportTable downloads a database as CSV with computed columns worked out.
// Text that a spreadsheet would run as a formula is prefixed with ' so
// opening the file can't execute anything.
func (s *Server) exportTable(w http.ResponseWriter, r *http.Request) {
	p, ok := s.tablePage(w, r)
	if !ok {
		return
	}
	t, _, _, err := s.readTable(p)
	if err != nil {
		s.tableFail(w, r, err)
		return
	}
	res := s.computer(r).Compute(p, t)
	var buf bytes.Buffer
	cw := csv.NewWriter(&buf)
	header := make([]string, len(t.Schema.Columns))
	for i, c := range t.Schema.Columns {
		header[i] = safeCell(c.Name)
	}
	_ = cw.Write(header)
	rec := make([]string, len(header))
	for _, row := range t.Rows {
		for i, c := range t.Schema.Columns {
			var v string
			switch c.Type {
			case table.Formula, table.Rollup, table.Created:
				v = res.Values[row.ID][c.ID].String()
			case table.Relation:
				var titles []string
				for _, id := range table.RelationIDs(row.Cells[c.ID]) {
					if title, ok := res.Related[c.ID][id]; ok {
						titles = append(titles, title)
					}
				}
				v = strings.Join(titles, ", ")
			default:
				v = row.Cells[c.ID]
			}
			rec[i] = safeCell(v)
		}
		_ = cw.Write(rec)
	}
	cw.Flush()
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": vault.Title(p) + ".csv"}))
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(buf.Bytes())
}

func safeCell(v string) string {
	if v != "" && strings.ContainsRune("=+-@\t\r", rune(v[0])) {
		if _, isNum := formula.ParseNumber(v); !isNum {
			return "'" + v
		}
	}
	return v
}

// importTable adds the rows of an uploaded CSV to a database. Columns are
// matched by name; new ones are added as text.
func (s *Server) importTable(w http.ResponseWriter, r *http.Request) {
	p, ok := s.tablePage(w, r)
	if !ok {
		return
	}
	header, records, ok := s.readUpload(w, r)
	if !ok {
		return
	}
	now := wallNow(loc(r))
	s.mutateTable(w, r, p, func(t *table.Table) error {
		return appendRecords(t, header, records, now)
	})
}

// importNewTable makes a new database page from an uploaded CSV or Excel file.
func (s *Server) importNewTable(w http.ResponseWriter, r *http.Request) {
	header, records, ok := s.readUpload(w, r)
	if !ok {
		return
	}
	t := table.New()
	t.Schema.Columns = nil
	now := wallNow(loc(r))
	for _, h := range header {
		name := table.CleanName(h)
		if name == "" {
			name = "Column"
		}
		for i := 2; t.ColumnNamed(name) != nil; i++ {
			name = fmt.Sprintf("%s %d", table.CleanName(h), i)
		}
		t.Schema.Columns = append(t.Schema.Columns, table.Column{ID: table.NewID("c"), Name: name, Type: table.Text})
	}
	if len(t.Schema.Columns) == 0 {
		writeErr(w, http.StatusBadRequest, "the file has no columns")
		return
	}
	if err := appendRecords(t, header, records, now); err != nil {
		s.tableFail(w, r, err)
		return
	}
	guessTypes(t, now)
	title := r.FormValue("title")
	if title == "" {
		title = "Imported"
	}
	s.createDatabasePage(w, r, r.FormValue("parent"), title, t)
}

const maxImport = 20 << 20

// readUpload reads the "file" of a multipart upload as a header row and
// records: CSV, TSV, or the first sheet of an .xlsx workbook.
func (s *Server) readUpload(w http.ResponseWriter, r *http.Request) ([]string, [][]string, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxImport+1<<20)
	f, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "no file, or it's over 20 MB")
		return nil, nil, false
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "upload failed")
		return nil, nil, false
	}
	var records [][]string
	switch strings.ToLower(path.Ext(hdr.Filename)) {
	case ".xlsx":
		records, err = table.ReadXLSX(data)
	case ".tsv", ".tab":
		records, err = readDelimited(data, '\t')
	default:
		records, err = readDelimited(data, 0)
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, "that file can't be read: "+err.Error())
		return nil, nil, false
	}
	if len(records) == 0 {
		writeErr(w, http.StatusBadRequest, "the file is empty")
		return nil, nil, false
	}
	return records[0], records[1:], true
}

func readDelimited(data []byte, sep rune) ([][]string, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	if sep == 0 {
		// Guess: tabs in the first line mean a TSV (a paste from a sheet).
		first, _, _ := bytes.Cut(data, []byte("\n"))
		sep = ','
		if bytes.Count(first, []byte("\t")) > bytes.Count(first, []byte(",")) {
			sep = '\t'
		} else if bytes.Count(first, []byte(";")) > bytes.Count(first, []byte(",")) {
			sep = ';'
		}
	}
	rd := csv.NewReader(bytes.NewReader(data))
	rd.Comma = sep
	rd.FieldsPerRecord = -1
	rd.LazyQuotes = true
	return rd.ReadAll()
}

// appendRecords adds imported rows, matching the header to columns by name.
// Values that don't fit a typed column are left out of that cell.
func appendRecords(t *table.Table, header []string, records [][]string, now time.Time) error {
	if len(t.Rows)+len(records) > table.MaxRows {
		return table.ErrTooLarge
	}
	cols := make([]*table.Column, len(header))
	for i, h := range header {
		if c := t.ColumnNamed(table.CleanName(h)); c != nil && table.Stored(c.Type) {
			cols[i] = c
			continue
		}
		if strings.TrimSpace(h) == table.IDHeader || strings.TrimSpace(h) == table.CreatedHeader || table.CleanName(h) == "" {
			continue
		}
		if len(t.Schema.Columns) >= table.MaxColumns {
			continue
		}
		t.Schema.Columns = append(t.Schema.Columns, table.Column{ID: table.NewID("c"), Name: table.CleanName(h), Type: table.Text})
		cols[i] = &t.Schema.Columns[len(t.Schema.Columns)-1]
	}
	created := time.Now().UTC().Format(time.RFC3339)
	for _, rec := range records {
		row := table.Row{ID: table.NewID("r"), Created: created, Cells: map[string]string{}}
		empty := true
		for i, v := range rec {
			if i >= len(cols) || cols[i] == nil || strings.TrimSpace(v) == "" {
				continue
			}
			// Re-find the column: appending may have moved the slice.
			c := t.Column(cols[i].ID)
			if nv, err := t.Normalize(c, v, now); err == nil && nv != "" {
				row.Cells[c.ID] = nv
				empty = false
			}
		}
		if !empty {
			t.Rows = append(t.Rows, row)
		}
	}
	return nil
}

// guessTypes gives the columns of a freshly imported table a type that fits
// every value: number, date, checkbox, or a select for few repeated values.
func guessTypes(t *table.Table, now time.Time) {
	for i := range t.Schema.Columns {
		if i == 0 {
			continue
		}
		c := &t.Schema.Columns[i]
		var vals []string
		for _, r := range t.Rows {
			if v := r.Cells[c.ID]; v != "" {
				vals = append(vals, v)
			}
		}
		if len(vals) == 0 {
			continue
		}
		fits := func(typ, format string) bool {
			probe := &table.Column{Type: typ, Format: format}
			tmp := &table.Table{}
			for _, v := range vals {
				if _, err := tmp.Normalize(probe, v, now); err != nil {
					return false
				}
			}
			return true
		}
		distinct := map[string]bool{}
		for _, v := range vals {
			distinct[strings.ToLower(strings.TrimSpace(v))] = true
		}
		next := *c
		switch {
		case fits(table.Checkbox, "") && len(distinct) <= 2:
			next.Type = table.Checkbox
		case fits(table.Number, ""):
			next.Type = table.Number
			if strings.ContainsAny(vals[0], "$€£") {
				next.Format = "currency"
			}
		case fits(table.Date, ""):
			next.Type = table.Date
		case len(vals) >= 4 && len(distinct) <= 12 && len(distinct) < len(vals):
			next.Type = table.Select
		default:
			continue
		}
		schema := t.Schema
		schema.Columns = slices.Clone(t.Schema.Columns)
		schema.Columns[i] = next
		_ = t.ApplySchema(schema, now)
	}
}

// restoreTableRevision puts an earlier version of a database's rows or
// schema back. The version it replaces stays in history.
func (s *Server) restoreTableRevision(w http.ResponseWriter, r *http.Request) {
	p, ok := s.tablePage(w, r)
	if !ok {
		return
	}
	var req struct {
		Revision int64 `json:"revision"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	rowsPath, schemaPath := vault.TableFiles(p)
	var t *table.Table
	var rows, schema []byte
	var err error
	func() {
		s.writeMu.Lock()
		defer s.writeMu.Unlock()
		rev, rerr := s.store.Revision(req.Revision)
		if err = rerr; err == nil && rev.Path != rowsPath && rev.Path != schemaPath {
			err = vault.ErrNotFound
		}
		if err == nil {
			t, rows, schema, err = s.readTable(p)
		}
		if err == nil {
			nextRows, nextSchema := rows, schema
			if rev.Path == rowsPath {
				nextRows = []byte(rev.Content)
			} else {
				nextSchema = []byte(rev.Content)
			}
			var nt *table.Table
			if nt, err = table.Read(nextRows, nextSchema); err == nil {
				t = nt
				rows, schema, err = s.writeTable(r, p, t, rows, schema, "restore")
			}
		}
	}()
	if err != nil {
		s.tableFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, s.tableData(r, p, t, rows, schema))
}

// tableHistory lists the saved versions of a database's rows and schema.
func (s *Server) tableHistory(w http.ResponseWriter, r *http.Request) {
	p, ok := s.tablePage(w, r)
	if !ok {
		return
	}
	rowsPath, schemaPath := vault.TableFiles(p)
	out := []store.Revision{}
	for _, f := range []string{rowsPath, schemaPath} {
		revs, err := s.store.Revisions(f)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		out = append(out, revs...)
	}
	slices.SortFunc(out, func(a, b store.Revision) int { return cmp.Compare(b.Updated, a.Updated) })
	writeJSON(w, http.StatusOK, out)
}

// tableRoute dispatches /api/tables/{page path}/{action}. Page paths contain
// slashes, so the action is the last segment after the .md file.
func (s *Server) tableRoute(w http.ResponseWriter, r *http.Request) {
	full := r.PathValue("path")
	lower, i := strings.ToLower(full), -1
	for from := 0; ; {
		k := strings.Index(lower[from:], ".md")
		if k < 0 {
			break
		}
		if k += from; k+3 == len(full) || full[k+3] == '/' {
			i = k
			break
		}
		from = k + 1
	}
	if i < 0 {
		s.fail(w, r, vault.ErrNotFound)
		return
	}
	page, action := full[:i+3], strings.Trim(full[i+3:], "/")
	r.SetPathValue("path", page)
	route := r.Method + " " + action
	if form, ok := strings.CutPrefix(action, "forms/"); ok && strings.HasSuffix(form, "/submit") && r.Method == http.MethodPost {
		r.SetPathValue("form", strings.TrimSuffix(form, "/submit"))
		route = "POST forms/submit"
	}
	switch route {
	case "GET ":
		s.getTable(w, r)
	case "PUT schema":
		s.putSchema(w, r)
	case "POST rows":
		s.addRows(w, r)
	case "PATCH rows":
		s.updateRows(w, r)
	case "POST rows/delete":
		s.deleteRows(w, r)
	case "POST rows/move":
		s.moveRows(w, r)
	case "POST preview":
		s.previewFormula(w, r)
	case "GET export":
		s.exportTable(w, r)
	case "POST import":
		s.importTable(w, r)
	case "GET history":
		s.tableHistory(w, r)
	case "POST restore":
		s.restoreTableRevision(w, r)
	case "POST forms/submit":
		s.submitForm(w, r)
	default:
		writeErr(w, http.StatusNotFound, "not found")
	}
}
