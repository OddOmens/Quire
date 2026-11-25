package table

import (
	"fmt"
	"net/mail"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/oddomens/quire/internal/formula"
)

// optionColors are the colours new select options take in turn.
var optionColors = []string{"gray", "blue", "green", "amber", "red", "purple", "pink", "teal", "orange", "brown"}

// InputError says why a value doesn't fit its column.
type InputError struct{ Msg string }

func (e *InputError) Error() string { return e.Msg }

func inputErr(format string, a ...any) error { return &InputError{fmt.Sprintf(format, a...)} }

// Normalize turns what someone typed (or pasted, or sent from a form) into
// the stored form of a column's value: numbers without formatting, dates as
// YYYY-MM-DD or YYYY-MM-DDTHH:MM, checkboxes as "true" or "". A select
// value that isn't an option yet becomes one. now is the user's wall-clock
// time, for "today" and "tomorrow".
func (t *Table) Normalize(c *Column, raw string, now time.Time) (string, error) {
	if len(raw) > MaxCell {
		return "", inputErr("that's too long for one cell")
	}
	raw = strings.TrimRight(raw, "\r\n")
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", nil
	}
	switch c.Type {
	case Text, Page:
		return raw, nil
	case Number:
		n, ok := formula.ParseNumber(trimmed)
		if !ok {
			return "", inputErr("%q isn't a number", trimmed)
		}
		// In a percent column, 15 means 15%, as in a spreadsheet.
		if c.Format == "percent" && !strings.HasSuffix(trimmed, "%") {
			n /= 100
		}
		return formula.FormatNumber(n), nil
	case Date:
		v, ok := relativeDate(trimmed, now)
		if !ok {
			if v, ok = formula.ParseDate(trimmed); !ok {
				return "", inputErr("%q isn't a date", trimmed)
			}
		}
		if v.HasTime {
			return v.T.Format("2006-01-02T15:04"), nil
		}
		return v.T.Format("2006-01-02"), nil
	case Checkbox:
		switch strings.ToLower(trimmed) {
		case "true", "yes", "y", "1", "x", "on", "checked", "done", "✓", "✔", "[x]":
			return "true", nil
		case "false", "no", "n", "0", "off", "unchecked", "[ ]":
			return "", nil
		}
		return "", inputErr("%q isn't yes or no", trimmed)
	case Select:
		return t.option(c, trimmed)
	case Multi:
		var out []string
		for _, p := range strings.Split(trimmed, ",") {
			if p = strings.TrimSpace(p); p == "" {
				continue
			}
			o, err := t.option(c, p)
			if err != nil {
				return "", err
			}
			if !slices.Contains(out, o) {
				out = append(out, o)
			}
		}
		return strings.Join(out, ", "), nil
	case URL:
		u := trimmed
		if !strings.Contains(u, "://") && !strings.HasPrefix(u, "mailto:") {
			u = "https://" + u
		}
		p, err := url.Parse(u)
		if err != nil || p.Host == "" && p.Scheme != "mailto" || (p.Scheme != "http" && p.Scheme != "https" && p.Scheme != "mailto") {
			return "", inputErr("%q isn't a web address", trimmed)
		}
		return u, nil
	case Email:
		a, err := mail.ParseAddress(trimmed)
		if err != nil || a.Name != "" || !strings.Contains(a.Address, ".") {
			return "", inputErr("%q isn't an email address", trimmed)
		}
		return a.Address, nil
	case Phone:
		digits := 0
		for _, r := range trimmed {
			switch {
			case r >= '0' && r <= '9':
				digits++
			case strings.ContainsRune(" +-().ext", r):
			default:
				return "", inputErr("%q isn't a phone number", trimmed)
			}
		}
		if digits < 3 {
			return "", inputErr("%q isn't a phone number", trimmed)
		}
		return trimmed, nil
	case Relation:
		var ids []string
		for _, id := range strings.FieldsFunc(trimmed, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' }) {
			if !validID(id) {
				return "", inputErr("that link to another row isn't valid")
			}
			if !slices.Contains(ids, id) {
				ids = append(ids, id)
			}
		}
		return strings.Join(ids, ","), nil
	case File:
		var paths []string
		for _, p := range strings.Split(trimmed, "\n") {
			if p = strings.TrimSpace(p); p != "" && !slices.Contains(paths, p) {
				paths = append(paths, p)
			}
		}
		return strings.Join(paths, "\n"), nil
	}
	return "", inputErr("the %s column is worked out, not typed in", c.Name)
}

// relativeDate reads "today", "tomorrow" and "yesterday".
func relativeDate(s string, now time.Time) (formula.Value, bool) {
	switch strings.ToLower(s) {
	case "today":
		return formula.Day(now), true
	case "tomorrow":
		return formula.Day(now.AddDate(0, 0, 1)), true
	case "yesterday":
		return formula.Day(now.AddDate(0, 0, -1)), true
	case "now":
		return formula.Moment(now), true
	}
	return formula.Value{}, false
}

// option finds a select option by name, ignoring case, or adds it.
func (t *Table) option(c *Column, name string) (string, error) {
	name = strings.Join(strings.Fields(strings.ReplaceAll(name, ",", " ")), " ")
	if len(name) > 200 {
		return "", inputErr("that option is too long")
	}
	for _, o := range c.Options {
		if strings.EqualFold(o.Name, name) {
			return o.Name, nil
		}
	}
	if len(c.Options) >= 500 {
		return "", inputErr("the %s column has too many options", c.Name)
	}
	c.Options = append(c.Options, Option{Name: name, Color: optionColors[len(c.Options)%len(optionColors)]})
	t.Changed = true
	return name, nil
}

// Typed reads a stored value for a formula: a number column gives numbers,
// a date column dates, a multi-select a list, and so on. Relations and
// computed columns are handled by the Computer.
func Typed(c *Column, raw string) formula.Value {
	if raw == "" {
		if c.Type == Checkbox {
			return formula.Boolean(false)
		}
		if c.Type == Multi || c.Type == File {
			return formula.Items([]formula.Value{})
		}
		return formula.Value{}
	}
	switch c.Type {
	case Number:
		if n, ok := formula.ParseNumber(raw); ok {
			return formula.Num(n)
		}
	case Date:
		if d, ok := formula.ParseDate(raw); ok {
			return d
		}
	case Checkbox:
		return formula.Boolean(raw == "true")
	case Multi:
		var out []formula.Value
		for _, p := range strings.Split(raw, ",") {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, formula.Str(p))
			}
		}
		return formula.Items(out)
	case File:
		var out []formula.Value
		for _, p := range strings.Split(raw, "\n") {
			out = append(out, formula.Str(p))
		}
		return formula.Items(out)
	}
	return formula.Str(raw)
}

// RelationIDs splits a relation cell into row ids.
func RelationIDs(raw string) []string {
	if raw == "" {
		return nil
	}
	return strings.Split(raw, ",")
}

// ApplySchema replaces the columns, views and forms with next, keeping the
// rows in step: a renamed column keeps its values and formulas follow the
// new name, a column that changes type has its values converted where they
// fit, and a removed column's values go (they stay in the history).
func (t *Table) ApplySchema(next Schema, now time.Time) error {
	if len(next.Columns) == 0 {
		return inputErr("a database needs at least one column")
	}
	if len(next.Columns) > MaxColumns {
		return inputErr("a database can have at most %d columns", MaxColumns)
	}
	old := map[string]Column{}
	for _, c := range t.Schema.Columns {
		old[c.ID] = c
	}
	ids := map[string]bool{}
	names := map[string]bool{}
	for i := range next.Columns {
		c := &next.Columns[i]
		if c.ID == "" {
			c.ID = NewID("c")
		}
		if !validID(c.ID) || ids[c.ID] {
			return inputErr("two columns have the same id")
		}
		ids[c.ID] = true
		c.Name = cleanName(c.Name, "")
		if c.Name == "" {
			return inputErr("every column needs a name")
		}
		if names[strings.ToLower(c.Name)] {
			return inputErr("there are two columns called %q", c.Name)
		}
		names[strings.ToLower(c.Name)] = true
		if !knownType(c.Type) {
			return inputErr("%q isn't a column type", c.Type)
		}
		if i == 0 && c.Type != Text {
			return inputErr("the first column names each row, so it holds text")
		}
		if c.Width < 0 || c.Width > 2000 {
			c.Width = 0
		}
		if len(c.Formula) > formula.MaxLength {
			return inputErr("the formula in %q is too long", c.Name)
		}
		if c.Type != Formula {
			c.Formula = ""
		}
		if c.Type != Select && c.Type != Multi {
			c.Options = nil
		}
		seen := map[string]bool{}
		opts := c.Options[:0]
		for _, o := range c.Options {
			o.Name = strings.Join(strings.Fields(strings.ReplaceAll(o.Name, ",", " ")), " ")
			if o.Name == "" || seen[strings.ToLower(o.Name)] {
				continue
			}
			seen[strings.ToLower(o.Name)] = true
			opts = append(opts, o)
		}
		c.Options = opts
	}

	// Renames: formulas that name the old column follow it.
	for _, c := range next.Columns {
		if o, ok := old[c.ID]; ok && o.Name != c.Name {
			for i := range next.Columns {
				if next.Columns[i].Formula != "" {
					next.Columns[i].Formula = formula.Rename(next.Columns[i].Formula, "", o.Name, c.Name)
				}
			}
		}
	}

	// Convert the values of columns whose type changed. Values that don't
	// fit the new type are kept as they were, so nothing is lost by trying
	// a type and going back.
	nt := &Table{Schema: next, Rows: t.Rows}
	for i := range next.Columns {
		c := &nt.Schema.Columns[i]
		o, ok := old[c.ID]
		if !ok {
			continue
		}
		switch {
		case !Stored(c.Type):
			for _, r := range t.Rows {
				delete(r.Cells, c.ID)
			}
		case o.Type != c.Type || (c.Type == Number && o.Format != c.Format):
			for _, r := range t.Rows {
				raw, has := r.Cells[c.ID]
				if !has {
					continue
				}
				if o.Type == Number && o.Format == "percent" && c.Type == Number {
					// Keep the stored fraction; only its display changes.
					continue
				}
				// Text can't become links to rows, and links mean nothing as text.
				if (o.Type == Relation) != (c.Type == Relation) {
					delete(r.Cells, c.ID)
					continue
				}
				if o.Type == Number && c.Type == Number {
					continue
				}
				if v, err := nt.Normalize(c, raw, now); err == nil {
					if v == "" {
						delete(r.Cells, c.ID)
					} else {
						r.Cells[c.ID] = v
					}
				}
			}
		}
	}
	// Removed columns.
	for id := range old {
		if !ids[id] {
			for _, r := range t.Rows {
				delete(r.Cells, id)
			}
		}
	}
	nt.cleanReferences()
	t.Schema = nt.Schema
	t.Schema.Version = max(t.Schema.Version, 1)
	return nil
}

// cleanReferences drops view and form settings that name columns that no
// longer exist, and gives views and forms ids and names.
func (t *Table) cleanReferences() {
	has := func(id string) bool { return id != "" && t.Column(id) != nil }
	keep := func(ids []string) []string {
		return slices.DeleteFunc(slices.Clone(ids), func(id string) bool { return !has(id) })
	}
	if len(t.Schema.Views) == 0 {
		t.Schema.Views = []View{{ID: NewID("v"), Name: "Table", Type: "table"}}
	}
	viewIDs := map[string]bool{}
	for i := range t.Schema.Views {
		v := &t.Schema.Views[i]
		if !validID(v.ID) || viewIDs[v.ID] {
			v.ID = NewID("v")
		}
		viewIDs[v.ID] = true
		if !slices.Contains([]string{"table", "board", "calendar", "chart", "gallery"}, v.Type) {
			v.Type = "table"
		}
		if v.Name = strings.TrimSpace(v.Name); v.Name == "" {
			v.Name = strings.ToUpper(v.Type[:1]) + v.Type[1:]
		}
		v.Filters = slices.DeleteFunc(v.Filters, func(f Filter) bool { return !has(f.Column) })
		v.Sorts = slices.DeleteFunc(v.Sorts, func(s Sort) bool { return !has(s.Column) })
		v.Hidden = keep(v.Hidden)
		if !has(v.GroupBy) {
			v.GroupBy = ""
		}
		if !has(v.DateColumn) {
			v.DateColumn = ""
		}
		if !has(v.EndColumn) {
			v.EndColumn = ""
		}
		for id := range v.Summaries {
			if !has(id) {
				delete(v.Summaries, id)
			}
		}
		if v.Chart != nil && !has(v.Chart.X) {
			v.Chart = nil
		}
		if v.Chart != nil && v.Chart.Y != "" && !has(v.Chart.Y) {
			v.Chart.Y = ""
		}
	}
	formIDs := map[string]bool{}
	for i := range t.Schema.Forms {
		f := &t.Schema.Forms[i]
		if !validID(f.ID) || formIDs[f.ID] {
			f.ID = NewID("f")
		}
		formIDs[f.ID] = true
		if f.Name = strings.TrimSpace(f.Name); f.Name == "" {
			f.Name = "Form"
		}
		seen := map[string]bool{}
		f.Fields = slices.DeleteFunc(f.Fields, func(ff FormField) bool {
			c := t.Column(ff.Column)
			drop := c == nil || !Stored(c.Type) || c.Type == Relation || seen[ff.Column]
			seen[ff.Column] = true
			return drop
		})
		for id := range f.Defaults {
			if c := t.Column(id); c == nil || !Stored(c.Type) {
				delete(f.Defaults, id)
			}
		}
		f.Limit = max(f.Limit, 0)
	}
}

// Form finds a form by id.
func (t *Table) Form(id string) *Form {
	for i := range t.Schema.Forms {
		if t.Schema.Forms[i].ID == id {
			return &t.Schema.Forms[i]
		}
	}
	return nil
}
