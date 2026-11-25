package table

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/oddomens/quire/internal/formula"
)

var now = time.Date(2026, 11, 3, 9, 0, 0, 0, time.UTC)

func mustRead(t *testing.T, csv, schema string) *Table {
	t.Helper()
	tb, err := Read([]byte(csv), []byte(schema))
	if err != nil {
		t.Fatal(err)
	}
	return tb
}

func TestReadWriteRoundTrip(t *testing.T) {
	schema := `{"version":1,"columns":[{"id":"cname","name":"Name","type":"text"},{"id":"camt","name":"Amount","type":"number"},{"id":"ctot","name":"Double","type":"formula","formula":"{Amount}*2"}],"views":[{"id":"v1","name":"All","type":"table"}]}`
	csv := "_id,_created,Name,Amount\nr1,2026-11-01T10:00:00Z,\"Rent, flat\",1200\nr2,,Food,45.5\n"
	tb := mustRead(t, csv, schema)
	if tb.Changed || len(tb.Rows) != 2 || tb.Rows[0].Cells["cname"] != "Rent, flat" || tb.Rows[1].Cells["camt"] != "45.5" {
		t.Fatalf("read: changed=%v rows=%+v", tb.Changed, tb.Rows)
	}
	out, err := tb.EncodeCSV()
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != csv {
		t.Errorf("round trip:\n%s\nwant\n%s", out, csv)
	}
}

func TestReadRepairs(t *testing.T) {
	// A CSV made elsewhere: no ids, an extra column, a BOM.
	tb := mustRead(t, "\xef\xbb\xbfName,Notes\nA,first\nB,\n", `{"columns":[{"id":"cname","name":"Name","type":"text"}],"views":[]}`)
	if !tb.Changed || len(tb.Schema.Columns) != 2 || tb.Schema.Columns[1].Name != "Notes" || len(tb.Schema.Views) != 1 {
		t.Fatalf("schema not repaired: %+v", tb.Schema)
	}
	if tb.Rows[0].ID == "" || tb.Rows[0].ID == tb.Rows[1].ID || tb.Rows[0].Cells[tb.Schema.Columns[1].ID] != "first" {
		t.Fatalf("rows: %+v", tb.Rows)
	}
	// No schema at all.
	tb = mustRead(t, "", "")
	if tb.Primary() == nil || tb.Primary().Name != "Name" {
		t.Fatalf("default schema: %+v", tb.Schema)
	}
}

func TestNormalize(t *testing.T) {
	tb := New()
	num := Column{ID: "n", Name: "N", Type: Number}
	pct := Column{ID: "p", Name: "P", Type: Number, Format: "percent"}
	date := Column{ID: "d", Name: "D", Type: Date}
	sel := Column{ID: "s", Name: "S", Type: Select, Options: []Option{{Name: "Done"}}}
	multi := Column{ID: "m", Name: "M", Type: Multi}
	check := Column{ID: "c", Name: "C", Type: Checkbox}
	email := Column{ID: "e", Name: "E", Type: Email}
	link := Column{ID: "u", Name: "U", Type: URL}
	cases := []struct {
		col  *Column
		in   string
		want string
		bad  bool
	}{
		{&num, "$1,200.50", "1200.5", false},
		{&num, "abc", "", true},
		{&pct, "15", "0.15", false},
		{&pct, "15%", "0.15", false},
		{&date, "11/3/2026", "2026-11-03", false},
		{&date, "tomorrow", "2026-11-04", false},
		{&date, "2026-11-03 14:30", "2026-11-03T14:30", false},
		{&date, "someday", "", true},
		{&sel, "done", "Done", false},
		{&sel, "In progress", "In progress", false},
		{&multi, "a, b, A", "a, b", false},
		{&check, "yes", "true", false},
		{&check, "no", "", false},
		{&email, "Someone@Example.com", "Someone@Example.com", false},
		{&email, "nope", "", true},
		{&link, "example.com/x", "https://example.com/x", false},
		{&link, "javascript:alert(1)", "", true},
		{&num, "  ", "", false},
	}
	for _, c := range cases {
		got, err := tb.Normalize(c.col, c.in, now)
		if (err != nil) != c.bad || got != c.want {
			t.Errorf("%s %q = %q, %v; want %q (bad=%v)", c.col.Type, c.in, got, err, c.want, c.bad)
		}
	}
	if len(sel.Options) != 2 || len(multi.Options) != 2 {
		t.Errorf("options not added: %+v %+v", sel.Options, multi.Options)
	}
}

func TestApplySchema(t *testing.T) {
	tb := mustRead(t, "_id,_created,Name,Amount,Status\nr1,,A,12,done\nr2,,B,x,\n",
		`{"columns":[{"id":"cn","name":"Name","type":"text"},{"id":"ca","name":"Amount","type":"text"},{"id":"cs","name":"Status","type":"text"},{"id":"cf","name":"Twice","type":"formula","formula":"{Amount}*2"}],"views":[{"id":"v1","name":"T","type":"table","sorts":[{"column":"cs"}],"hidden":["ca","gone"]}],"forms":[{"id":"f1","name":"F","fields":[{"column":"ca"},{"column":"cs"},{"column":"cf"}]}]}`)
	next := tb.Schema
	next.Columns = append([]Column(nil), tb.Schema.Columns...)
	next.Columns[1] = Column{ID: "ca", Name: "Cost", Type: Number}
	next.Columns[2] = Column{ID: "cs", Name: "Status", Type: Select}
	next.Columns = append(next.Columns[:2], next.Columns[3:]...) // drop Status
	next.Columns = append(next.Columns, Column{Name: "Done", Type: Checkbox})
	if err := tb.ApplySchema(next, now); err != nil {
		t.Fatal(err)
	}
	if f := tb.Column("cf").Formula; f != "{Cost}*2" {
		t.Errorf("formula not renamed: %s", f)
	}
	if tb.Rows[0].Cells["ca"] != "12" || tb.Rows[1].Cells["ca"] != "x" {
		t.Errorf("conversion: %+v", tb.Rows)
	}
	if _, ok := tb.Rows[0].Cells["cs"]; ok {
		t.Error("removed column kept its values")
	}
	v := tb.Schema.Views[0]
	if len(v.Sorts) != 0 || len(v.Hidden) != 1 {
		t.Errorf("view references not cleaned: %+v", v)
	}
	if f := tb.Schema.Forms[0]; len(f.Fields) != 1 || f.Fields[0].Column != "ca" {
		t.Errorf("form fields not cleaned: %+v", f.Fields)
	}
	if tb.Schema.Columns[3].ID == "" {
		t.Error("new column has no id")
	}
	bad := tb.Schema
	bad.Columns = []Column{{ID: "x", Name: "Total", Type: Formula}}
	if err := tb.ApplySchema(bad, now); err == nil {
		t.Error("a formula primary column was accepted")
	}
}

type fakeSource map[string]*Table

func (f fakeSource) Open(from, target string) (*Table, string, error) {
	for p, t := range f {
		if strings.EqualFold(strings.TrimSuffix(p, ".md"), "S/"+target) || p == target {
			return t, p, nil
		}
	}
	return nil, "", ErrInvalid
}

func TestCompute(t *testing.T) {
	items := mustRead(t, "_id,_created,Item,Price,Qty\ni1,,Pen,2,3\ni2,,Ink,5,1\ni3,,Pad,4,2\n",
		`{"columns":[{"id":"n","name":"Item","type":"text"},{"id":"p","name":"Price","type":"number"},{"id":"q","name":"Qty","type":"number"},{"id":"t","name":"Total","type":"formula","formula":"{Price}*{Qty}"},{"id":"s","name":"Share","type":"formula","formula":"ROUND({Total}/SUM([Total]), 2)"}],"views":[]}`)
	orders := mustRead(t, "_id,_created,Order,Items\no1,2026-11-01T10:00:00Z,First,\"i1,i2\"\no2,,Second,i3\n",
		`{"columns":[{"id":"n","name":"Order","type":"text"},{"id":"r","name":"Items","type":"relation","target":"S/Items.md"},{"id":"sum","name":"Sum","type":"rollup","relation":"r","field":"t","aggregate":"sum"},{"id":"names","name":"Names","type":"formula","formula":"JOIN(\" + \", {Items})"},{"id":"c","name":"Made","type":"created"},{"id":"g","name":"Grand","type":"formula","formula":"SUM([Items/Total])"},{"id":"loop1","name":"L1","type":"formula","formula":"{L2}"},{"id":"loop2","name":"L2","type":"formula","formula":"{L1}+1"},{"id":"typo","name":"Typo","type":"formula","formula":"SUM([Sum]"}],"views":[]}`)
	src := fakeSource{"S/Items.md": items, "S/Orders.md": orders}
	c := NewComputer(src, now, time.UTC)
	res := c.Compute("S/Orders.md", orders)
	get := func(row, col string) string { return res.Values[row][col].String() }
	if get("o1", "sum") != "11" || get("o2", "sum") != "8" {
		t.Errorf("rollup: %s %s", get("o1", "sum"), get("o2", "sum"))
	}
	if get("o1", "names") != "Pen + Ink" {
		t.Errorf("relation titles: %s", get("o1", "names"))
	}
	if get("o1", "c") != "2026-11-01 10:00" || get("o2", "c") != "" {
		t.Errorf("created: %q %q", get("o1", "c"), get("o2", "c"))
	}
	if get("o1", "g") != "19" {
		t.Errorf("cross-table column: %s", get("o1", "g"))
	}
	if _, ok := res.Errors["loop1"]; !ok {
		t.Error("cycle not reported")
	}
	if _, ok := res.Errors["typo"]; !ok {
		t.Error("syntax error not reported")
	}
	if res.Related["r"]["i3"] != "Pad" {
		t.Errorf("related titles: %+v", res.Related)
	}
	ir := c.Compute("S/Items.md", items)
	if ir.Values["i1"]["s"].String() != "0.32" {
		t.Errorf("share of total: %s", ir.Values["i1"]["s"].String())
	}
	b, _ := json.Marshal(res.Values["o1"]["c"])
	if string(b) != `{"date":"2026-11-01T10:00"}` {
		t.Errorf("date JSON: %s", b)
	}

	// Page formulas name their database.
	n, _ := formula.Parse("SUM([Items/Total]) * 2")
	if v := c.Eval(n, PageContext{C: c, Path: "S/Notes.md"}); v.String() != "38" {
		t.Errorf("page formula: %s", v.String())
	}
}
