// Package table stores a database page's rows and columns as plain files
// beside the page: Budget.md holds the page text, Budget.csv the rows and
// Budget.schema.json the column types, views and forms. The CSV opens in any
// spreadsheet; its first two columns are each row's id and creation time.
package table

import (
	"bytes"
	"crypto/rand"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"
	"unicode"
)

const (
	// IDHeader and CreatedHeader are the CSV's bookkeeping columns.
	IDHeader      = "_id"
	CreatedHeader = "_created"

	// Limits that keep one database from swamping the server.
	MaxRows     = 50_000
	MaxColumns  = 200
	MaxCell     = 100_000
	MaxFileSize = 32 << 20
)

var (
	ErrInvalid  = errors.New("invalid")
	ErrTooLarge = errors.New("this database is too large")
)

// Column types. Stored types are kept in the CSV; computed ones are worked
// out when the table is read.
const (
	Text     = "text"
	Number   = "number"
	Select   = "select"
	Multi    = "multi"
	Date     = "date"
	Checkbox = "checkbox"
	URL      = "url"
	Email    = "email"
	Phone    = "phone"
	Page     = "page"
	Relation = "relation"
	File     = "file"
	Formula  = "formula"
	Rollup   = "rollup"
	Created  = "created"
)

var storedTypes = []string{Text, Number, Select, Multi, Date, Checkbox, URL, Email, Phone, Page, Relation, File}

// Stored reports whether a column type keeps its values in the CSV.
func Stored(typ string) bool { return slices.Contains(storedTypes, typ) }

func knownType(typ string) bool {
	return Stored(typ) || typ == Formula || typ == Rollup || typ == Created
}

type Option struct {
	Name  string `json:"name"`
	Color string `json:"color,omitempty"`
}

type Column struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
	// Width is the column's width in the grid, in pixels.
	Width       int    `json:"width,omitempty"`
	Description string `json:"description,omitempty"`
	// Format is how numbers show ("number", "currency", "percent") or, for
	// a date, "datetime" to include the time. Formulas and rollups also take
	// "date", "text" and "checkbox".
	Format   string   `json:"format,omitempty"`
	Decimals *int     `json:"decimals,omitempty"`
	Currency string   `json:"currency,omitempty"`
	Options  []Option `json:"options,omitempty"`
	Formula  string   `json:"formula,omitempty"`
	// Target is the page path of the database a relation links to.
	Target string `json:"target,omitempty"`
	// A rollup reads Field of the rows linked through Relation (a relation
	// column's id) and combines them with Aggregate.
	Relation  string `json:"relation,omitempty"`
	Field     string `json:"field,omitempty"`
	Aggregate string `json:"aggregate,omitempty"`
}

type Filter struct {
	Column string `json:"column"`
	Op     string `json:"op"`
	Value  string `json:"value,omitempty"`
}

type Sort struct {
	Column string `json:"column"`
	Desc   bool   `json:"desc,omitempty"`
}

type Chart struct {
	Kind      string `json:"kind"` // bar, line, pie
	X         string `json:"x"`
	Y         string `json:"y,omitempty"`
	Aggregate string `json:"aggregate,omitempty"` // count, sum, avg, min, max
}

// View is a saved way of looking at the rows: a table, board, calendar or
// chart with its own filters, sorting and hidden columns.
type View struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	Filters []Filter `json:"filters,omitempty"`
	// Match is "any" to keep rows matching any filter; all by default.
	Match  string   `json:"match,omitempty"`
	Sorts  []Sort   `json:"sorts,omitempty"`
	Hidden []string `json:"hidden,omitempty"`
	// GroupBy is the select column a board's lanes come from.
	GroupBy string `json:"groupBy,omitempty"`
	// DateColumn (and optionally EndColumn) place rows on a calendar.
	DateColumn string `json:"dateColumn,omitempty"`
	EndColumn  string `json:"endColumn,omitempty"`
	// Summaries maps column ids to the total shown under them.
	Summaries map[string]string `json:"summaries,omitempty"`
	Chart     *Chart            `json:"chart,omitempty"`
	// Wrap shows long text on several lines instead of cutting it off.
	Wrap bool `json:"wrap,omitempty"`
}

type FormField struct {
	Column   string `json:"column"`
	Label    string `json:"label,omitempty"`
	Help     string `json:"help,omitempty"`
	Required bool   `json:"required,omitempty"`
}

// Form collects rows: each submission becomes a row.
type Form struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Title       string      `json:"title,omitempty"`
	Description string      `json:"description,omitempty"`
	Fields      []FormField `json:"fields"`
	Submit      string      `json:"submit,omitempty"`
	Thanks      string      `json:"thanks,omitempty"`
	// Defaults fill columns the form doesn't ask about, such as a Source.
	Defaults map[string]string `json:"defaults,omitempty"`
	// Closed stops a form taking answers; Limit closes it after that many
	// public answers (0 is no limit).
	Closed bool `json:"closed,omitempty"`
	Limit  int  `json:"limit,omitempty"`
}

type Schema struct {
	Version int      `json:"version"`
	Columns []Column `json:"columns"`
	Views   []View   `json:"views"`
	Forms   []Form   `json:"forms,omitempty"`
}

type Row struct {
	ID      string            `json:"id"`
	Created string            `json:"created"`
	Cells   map[string]string `json:"cells"`
}

type Table struct {
	Schema Schema
	Rows   []Row
	// Changed is set when reading had to repair something (rows without
	// ids, columns only the CSV knew about), so the files should be saved.
	Changed bool
}

// NewID returns a short random id for a row, column, view or form.
func NewID(prefix string) string {
	const alphabet = "abcdefghijkmnopqrstuvwxyz23456789"
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return prefix + string(b)
}

// New is an empty database with a Name column and one table view.
func New() *Table {
	name := Column{ID: NewID("c"), Name: "Name", Type: Text, Width: 240}
	return &Table{Schema: Schema{
		Version: 1,
		Columns: []Column{name},
		Views:   []View{{ID: NewID("v"), Name: "Table", Type: "table"}},
	}}
}

// Primary is the first column: what a row is called in links and cards.
func (t *Table) Primary() *Column {
	if len(t.Schema.Columns) == 0 {
		return nil
	}
	return &t.Schema.Columns[0]
}

func (t *Table) Column(id string) *Column {
	for i := range t.Schema.Columns {
		if t.Schema.Columns[i].ID == id {
			return &t.Schema.Columns[i]
		}
	}
	return nil
}

// ColumnNamed finds a column by name, ignoring case.
func (t *Table) ColumnNamed(name string) *Column {
	name = strings.TrimSpace(name)
	for i := range t.Schema.Columns {
		if strings.EqualFold(t.Schema.Columns[i].Name, name) {
			return &t.Schema.Columns[i]
		}
	}
	return nil
}

func (t *Table) RowIndex(id string) int {
	for i, r := range t.Rows {
		if r.ID == id {
			return i
		}
	}
	return -1
}

// Title is a row's display name: its primary column, or "Untitled".
func (t *Table) Title(r Row) string {
	if p := t.Primary(); p != nil {
		if v := strings.TrimSpace(r.Cells[p.ID]); v != "" {
			return v
		}
	}
	return "Untitled"
}

// Read loads a table from its files. A missing schema gets a default one; a
// missing CSV is an empty table. Columns the CSV has but the schema doesn't
// become text columns.
func Read(csvData, schemaData []byte) (*Table, error) {
	if len(csvData) > MaxFileSize {
		return nil, ErrTooLarge
	}
	t := &Table{}
	if len(bytes.TrimSpace(schemaData)) == 0 {
		t = New()
		t.Changed = true
	} else if err := json.Unmarshal(schemaData, &t.Schema); err != nil {
		return nil, fmt.Errorf("the schema file isn't valid JSON: %w", err)
	}
	t.Schema.Version = max(t.Schema.Version, 1)
	if t.repairSchema() {
		t.Changed = true
	}

	csvData = bytes.TrimPrefix(csvData, []byte("\xef\xbb\xbf")) // a BOM from Excel
	if len(bytes.TrimSpace(csvData)) == 0 {
		return t, nil
	}
	rd := csv.NewReader(bytes.NewReader(csvData))
	rd.FieldsPerRecord = -1
	rd.LazyQuotes = true
	header, err := rd.Read()
	if err != nil {
		return nil, fmt.Errorf("the CSV file can't be read: %w", err)
	}
	// Match the header to columns by name.
	idCol, createdCol := -1, -1
	cols := make([]string, len(header))
	used := map[string]bool{}
	for i, h := range header {
		h = strings.TrimSpace(h)
		switch {
		case h == IDHeader && idCol < 0:
			idCol = i
			continue
		case h == CreatedHeader && createdCol < 0:
			createdCol = i
			continue
		}
		c := t.ColumnNamed(h)
		if c != nil && Stored(c.Type) && !used[c.ID] {
			cols[i] = c.ID
			used[c.ID] = true
			continue
		}
		if len(t.Schema.Columns) >= MaxColumns {
			continue
		}
		name := t.uniqueName(cleanName(h, "Column"))
		nc := Column{ID: NewID("c"), Name: name, Type: Text}
		t.Schema.Columns = append(t.Schema.Columns, nc)
		cols[i] = nc.ID
		used[nc.ID] = true
		t.Changed = true
	}
	seen := map[string]bool{}
	for {
		rec, err := rd.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("the CSV file can't be read: %w", err)
		}
		if len(t.Rows) >= MaxRows {
			return nil, ErrTooLarge
		}
		r := Row{Cells: map[string]string{}}
		for i, v := range rec {
			switch {
			case i == idCol:
				r.ID = strings.TrimSpace(v)
			case i == createdCol:
				r.Created = strings.TrimSpace(v)
			case i < len(cols) && cols[i] != "" && v != "":
				r.Cells[cols[i]] = v
			}
		}
		if !validID(r.ID) || seen[r.ID] {
			r.ID = NewID("r")
			t.Changed = true
		}
		seen[r.ID] = true
		if _, err := time.Parse(time.RFC3339, r.Created); err != nil {
			r.Created = ""
		}
		t.Rows = append(t.Rows, r)
	}
	return t, nil
}

func validID(id string) bool {
	if id == "" || len(id) > 40 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

// repairSchema fills in what a hand-edited schema may lack: ids, names,
// known types, a view. It reports whether it changed anything.
func (t *Table) repairSchema() bool {
	changed := false
	seen := map[string]bool{}
	names := map[string]bool{}
	cols := t.Schema.Columns[:0]
	for _, c := range t.Schema.Columns {
		if !validID(c.ID) || seen[c.ID] {
			c.ID = NewID("c")
			changed = true
		}
		if !knownType(c.Type) {
			c.Type = Text
			changed = true
		}
		n := cleanName(c.Name, "Column")
		for names[strings.ToLower(n)] {
			n += " 2"
		}
		if n != c.Name {
			c.Name = n
			changed = true
		}
		seen[c.ID] = true
		names[strings.ToLower(c.Name)] = true
		cols = append(cols, c)
	}
	t.Schema.Columns = cols
	if len(t.Schema.Columns) == 0 {
		t.Schema.Columns = []Column{{ID: NewID("c"), Name: "Name", Type: Text, Width: 240}}
		changed = true
	}
	if p := &t.Schema.Columns[0]; !Stored(p.Type) {
		// The primary column names rows, so it holds text.
		p.Type, p.Formula = Text, ""
		changed = true
	}
	if len(t.Schema.Views) == 0 {
		t.Schema.Views = []View{{ID: NewID("v"), Name: "Table", Type: "table"}}
		changed = true
	}
	return changed
}

// cleanName tidies a column name: no brackets, braces or slashes (formulas
// use them), no control characters, single spaces, at most 100 characters.
func cleanName(s, fallback string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune("{}[]/", r) {
			return ' '
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > 100 {
		s = strings.TrimSpace(string(r[:100]))
	}
	if s == "" || s == IDHeader || s == CreatedHeader {
		return fallback
	}
	return s
}

// CleanName is cleanName for callers outside the package.
func CleanName(s string) string { return cleanName(s, "") }

func (t *Table) uniqueName(name string) string {
	if t.ColumnNamed(name) == nil {
		return name
	}
	for i := 2; ; i++ {
		c := fmt.Sprintf("%s %d", name, i)
		if t.ColumnNamed(c) == nil {
			return c
		}
	}
}

// EncodeCSV writes the rows: id, created, then every stored column by name.
func (t *Table) EncodeCSV() ([]byte, error) {
	var stored []Column
	for _, c := range t.Schema.Columns {
		if Stored(c.Type) {
			stored = append(stored, c)
		}
	}
	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	header := []string{IDHeader, CreatedHeader}
	for _, c := range stored {
		header = append(header, c.Name)
	}
	if err := w.Write(header); err != nil {
		return nil, err
	}
	rec := make([]string, len(header))
	for _, r := range t.Rows {
		rec[0], rec[1] = r.ID, r.Created
		for i, c := range stored {
			rec[i+2] = r.Cells[c.ID]
		}
		if err := w.Write(rec); err != nil {
			return nil, err
		}
	}
	w.Flush()
	return buf.Bytes(), w.Error()
}

func (t *Table) EncodeSchema() ([]byte, error) {
	b, err := json.MarshalIndent(t.Schema, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}
