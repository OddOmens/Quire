package server

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/oddomens/quire/internal/table"
)

type tableResp struct {
	Path    string                                `json:"path"`
	Rev     string                                `json:"rev"`
	Schema  table.Schema                          `json:"schema"`
	Rows    []table.Row                           `json:"rows"`
	Values  map[string]map[string]json.RawMessage `json:"values"`
	Errors  map[string]string                     `json:"errors"`
	Related map[string]map[string]string          `json:"related"`
}

func (h *harness) table(p string) tableResp {
	h.t.Helper()
	var d tableResp
	if code := h.do("GET", "/api/tables/"+p, nil, &d); code != 200 {
		h.t.Fatalf("get table %s: %d", p, code)
	}
	return d
}

func (h *harness) newTable(title, template string) string {
	h.t.Helper()
	var d noteDetail
	if code := h.do("POST", "/api/tables", map[string]string{"parent": "Work", "title": title, "template": template}, &d); code != 201 {
		h.t.Fatalf("create table: %d", code)
	}
	return d.Path
}

func colID(t tableResp, name string) string {
	for _, c := range t.Schema.Columns {
		if c.Name == name {
			return c.ID
		}
	}
	return ""
}

func TestDatabaseLifecycle(t *testing.T) {
	h := newHarness(t)
	p := h.newTable("Budget", "budget")
	if p != "Work/Budget.md" || !h.exists("Work/Budget.csv") || !h.exists("Work/Budget.schema.json") {
		t.Fatalf("files not created: %s", p)
	}
	if !strings.Contains(h.read("Work/Budget.md"), "database: true") {
		t.Fatal("page not marked as a database")
	}
	tb := h.table(p)
	name, amount, cat := colID(tb, "Name"), colID(tb, "Amount"), colID(tb, "Category")

	// Add rows: one typed in, a paste of three.
	var d tableResp
	if code := h.do("POST", "/api/tables/"+p+"/rows", map[string]any{"rows": []map[string]any{{"cells": map[string]string{name: "Rent", amount: "$1,200", cat: "Home"}}}}, &d); code != 200 {
		t.Fatalf("add row: %d", code)
	}
	if code := h.do("POST", "/api/tables/"+p+"/rows", map[string]any{"rows": []map[string]any{
		{"cells": map[string]string{name: "Food", amount: "45.50", cat: "food"}},
		{"cells": map[string]string{name: "Bad", amount: "lots"}},
		{"cells": map[string]string{name: "Gas", amount: "60", cat: "Car"}},
	}}, &d); code != 200 {
		t.Fatalf("paste rows: %d", code)
	}
	if len(d.Rows) != 4 || d.Rows[0].Cells[amount] != "1200" || d.Rows[2].Cells[amount] != "" {
		t.Fatalf("rows: %+v", d.Rows)
	}
	// One bad cell is refused with a reason.
	var e apiError
	if code := h.do("PATCH", "/api/tables/"+p+"/rows", map[string]any{"rows": []map[string]any{{"id": d.Rows[0].ID, "cells": map[string]string{amount: "nope"}}}}, &e); code != 400 || !strings.Contains(e.Error, "Amount") {
		t.Fatalf("bad cell: %d %+v", code, e)
	}

	// Add a formula column and a rollup-ready schema change.
	schema := d.Schema
	schema.Columns = append(schema.Columns, table.Column{Name: "Share", Type: table.Formula, Formula: "ROUND({Amount} / SUM([Amount]) * 100)"})
	if code := h.do("PUT", "/api/tables/"+p+"/schema", map[string]any{"schema": schema, "baseRev": d.Rev}, &d); code != 200 {
		t.Fatalf("schema: %d", code)
	}
	share := colID(d, "Share")
	if v := string(d.Values[d.Rows[0].ID][share]); v != "92" {
		t.Errorf("formula value: %s (errors %v)", v, d.Errors)
	}
	// A stale baseRev is refused.
	if code := h.do("PUT", "/api/tables/"+p+"/schema", map[string]any{"schema": schema, "baseRev": "stale"}, nil); code != 409 {
		t.Errorf("stale schema: %d", code)
	}
	// Rename Amount: the formula follows.
	schema = d.Schema
	for i := range schema.Columns {
		if schema.Columns[i].ID == amount {
			schema.Columns[i].Name = "Cost"
		}
	}
	h.do("PUT", "/api/tables/"+p+"/schema", map[string]any{"schema": schema}, &d)
	for _, c := range d.Schema.Columns {
		if c.ID == share && !strings.Contains(c.Formula, "{Cost}") {
			t.Errorf("formula not renamed: %s", c.Formula)
		}
	}
	if !strings.HasPrefix(h.read("Work/Budget.csv"), "_id,_created,Name,Cost,") {
		t.Errorf("csv header: %s", h.read("Work/Budget.csv"))
	}

	// Formulas on a page.
	var vals []struct {
		Value json.RawMessage `json:"value"`
		Error string          `json:"error"`
	}
	h.do("POST", "/api/formulas", map[string]any{"path": "Work/Notes.md", "formulas": []string{"SUM([Budget/Cost])", "{Cost}", "1+"}}, &vals)
	if len(vals) != 3 || string(vals[0].Value) != "1305.5" || vals[1].Error == "" || vals[2].Error == "" {
		t.Errorf("page formulas: %+v", vals)
	}

	// Move, delete, restore: the data files go along.
	var moved struct{ Path string }
	if code := h.do("POST", "/api/move", map[string]string{"from": p, "to": "Work/Money"}, &moved); code != 200 {
		t.Fatalf("move: %d", code)
	}
	if !h.exists("Work/Money.csv") || h.exists("Work/Budget.csv") || len(h.table("Work/Money.md").Rows) != 4 {
		t.Fatal("data didn't move with the page")
	}
	var hist []map[string]any
	h.do("GET", "/api/tables/Work/Money.md/history", nil, &hist)
	if len(hist) == 0 {
		t.Error("history didn't follow the move")
	}
	if code := h.do("DELETE", "/api/notes/Work/Money.md", nil, nil); code != 204 {
		t.Fatalf("delete: %d", code)
	}
	if h.exists("Work/Money.csv") {
		t.Fatal("data left behind on delete")
	}
	var trash struct {
		Items []struct{ ID string } `json:"items"`
	}
	h.do("GET", "/api/trash", nil, &trash)
	h.do("POST", "/api/trash/"+trash.Items[0].ID+"/restore", nil, nil)
	if len(h.table("Work/Money.md").Rows) != 4 {
		t.Fatal("restore lost the rows")
	}

	// Export: computed values included, formula-looking text defused.
	h.do("PATCH", "/api/tables/Work/Money.md/rows", map[string]any{"rows": []map[string]any{{"id": d.Rows[1].ID, "cells": map[string]string{name: "=HYPERLINK(\"x\")"}}}}, nil)
	req, _ := http.NewRequest("GET", h.ts.URL+"/api/tables/Work/Money.md/export", nil)
	req.Header.Set("Authorization", "Bearer "+h.token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !strings.Contains(string(body), "Name,Cost,Category,Date,Share") || !strings.Contains(string(body), `'=HYPERLINK`) {
		t.Errorf("export:\n%s", body)
	}
}

func TestRelationsAndCalendar(t *testing.T) {
	h := newHarness(t)
	items := h.newTable("Items", "")
	orders := h.newTable("Orders", "")
	it := h.table(items)
	sch := it.Schema
	sch.Columns = append(sch.Columns, table.Column{Name: "Price", Type: table.Number})
	h.do("PUT", "/api/tables/"+items+"/schema", map[string]any{"schema": sch}, &it)
	price := colID(it, "Price")
	h.do("POST", "/api/tables/"+items+"/rows", map[string]any{"rows": []map[string]any{
		{"cells": map[string]string{colID(it, "Name"): "Pen", price: "2"}},
		{"cells": map[string]string{colID(it, "Name"): "Ink", price: "5"}},
	}}, &it)

	or := h.table(orders)
	sch = or.Schema
	sch.Columns = append(sch.Columns,
		table.Column{ID: "crel", Name: "Items", Type: table.Relation, Target: items},
		table.Column{Name: "Total", Type: table.Rollup, Relation: "crel", Field: price, Aggregate: "sum"},
		table.Column{ID: "cdate", Name: "When", Type: table.Date},
	)
	sch.Views = append(sch.Views, table.View{Name: "Calendar", Type: "calendar", DateColumn: "cdate"})
	if code := h.do("PUT", "/api/tables/"+orders+"/schema", map[string]any{"schema": sch}, &or); code != 200 {
		t.Fatalf("schema: %d", code)
	}
	// A relation must point at a database.
	bad := or.Schema
	bad.Columns = append(bad.Columns, table.Column{Name: "Bad", Type: table.Relation, Target: "Work/Nope.md"})
	if code := h.do("PUT", "/api/tables/"+orders+"/schema", map[string]any{"schema": bad}, nil); code != 400 {
		t.Errorf("relation to a non-database: %d", code)
	}
	h.do("POST", "/api/tables/"+orders+"/rows", map[string]any{"rows": []map[string]any{{"cells": map[string]string{
		colID(or, "Name"): "First", "crel": it.Rows[0].ID + "," + it.Rows[1].ID, "cdate": "2026-11-05",
	}}}}, &or)
	if v := string(or.Values[or.Rows[0].ID][colID(or, "Total")]); v != "7" {
		t.Errorf("rollup: %s %v", v, or.Errors)
	}
	if or.Related["crel"][it.Rows[1].ID] != "Ink" {
		t.Errorf("related titles: %+v", or.Related)
	}

	var events []calendarEvent
	h.do("GET", "/api/calendar?from=2026-11-01&to=2026-11-30", nil, &events)
	if len(events) != 1 || events[0].Title != "First" || events[0].Start != "2026-11-05" {
		t.Errorf("calendar: %+v", events)
	}
	h.do("GET", "/api/calendar?from=2026-12-01&to=2026-12-31", nil, &events)
	if len(events) != 0 {
		t.Errorf("calendar outside the range: %+v", events)
	}
}

func TestImport(t *testing.T) {
	h := newHarness(t)
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	mw.WriteField("parent", "Work")
	mw.WriteField("title", "Expenses")
	fw, _ := mw.CreateFormFile("file", "expenses.csv")
	fw.Write([]byte("Item,Amount,Paid,When,Kind\nRent,1200,yes,2026-11-01,Home\nFood,45.5,no,2026-11-02,Food\nGas,60,yes,2026-11-03,Car\nTea,4,no,2026-11-04,Food\nSnacks,6,no,2026-11-05,Food\n"))
	mw.Close()
	req, _ := http.NewRequest("POST", h.ts.URL+"/api/tables/import", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+h.token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 201 {
		t.Fatalf("import: %d", res.StatusCode)
	}
	tb := h.table("Work/Expenses.md")
	types := map[string]string{}
	for _, c := range tb.Schema.Columns {
		types[c.Name] = c.Type
	}
	if types["Amount"] != "number" || types["Paid"] != "checkbox" || types["When"] != "date" || types["Kind"] != "select" || len(tb.Rows) != 5 {
		t.Errorf("guessed types: %v, rows %d", types, len(tb.Rows))
	}
}

func TestForms(t *testing.T) {
	h := newHarness(t)
	p := h.newTable("Requests", "")
	tb := h.table(p)
	sch := tb.Schema
	sch.Columns = append(sch.Columns,
		table.Column{ID: "cemail", Name: "Email", Type: table.Email},
		table.Column{ID: "ckind", Name: "Kind", Type: table.Select, Options: []table.Option{{Name: "Bug"}, {Name: "Idea"}}},
		table.Column{ID: "csrc", Name: "Source", Type: table.Text},
	)
	sch.Forms = []table.Form{{ID: "fpub", Name: "Feedback", Fields: []table.FormField{
		{Column: sch.Columns[0].ID, Label: "Subject", Required: true},
		{Column: "cemail", Required: true},
		{Column: "ckind"},
	}, Defaults: map[string]string{"csrc": "Website"}, Limit: 2}}
	if code := h.do("PUT", "/api/tables/"+p+"/schema", map[string]any{"schema": sch}, &tb); code != 200 {
		t.Fatalf("schema: %d", code)
	}
	name := tb.Schema.Columns[0].ID

	// Inside Quire.
	var e struct {
		Problems map[string]string `json:"problems"`
	}
	if code := h.do("POST", "/api/tables/"+p+"/forms/fpub/submit", map[string]any{"answers": map[string]string{"cemail": "nope", "ckind": "Spam"}}, &e); code != 400 || len(e.Problems) != 3 {
		t.Fatalf("invalid answers: %d %+v", code, e)
	}
	if code := h.do("POST", "/api/tables/"+p+"/forms/fpub/submit", map[string]any{"answers": map[string]string{name: "Hi", "cemail": "a@example.com", "ckind": "idea"}}, nil); code != 204 {
		t.Fatalf("submit: %d", code)
	}
	tb = h.table(p)
	if len(tb.Rows) != 1 || tb.Rows[0].Cells["ckind"] != "Idea" || tb.Rows[0].Cells["csrc"] != "Website" {
		t.Fatalf("row: %+v", tb.Rows)
	}

	// The public link.
	var link struct{ Token string }
	if code := h.do("POST", "/api/form-links", map[string]string{"path": p, "form": "fpub"}, &link); code != 201 {
		t.Fatalf("link: %d", code)
	}
	pub := httpTestServer(t, h.srv.PublicHandler())
	get := func() (int, string) {
		res, err := http.Get(pub + "/f/" + link.Token)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		return res.StatusCode, string(b)
	}
	code, page := get()
	if code != 200 || !strings.Contains(page, "Subject") || strings.Contains(page, "<script") {
		t.Fatalf("form page: %d", code)
	}
	stamp := regexp.MustCompile(`name="stamp" value="([^"]+)"`).FindStringSubmatch(page)[1]
	post := func(v url.Values) (int, string) {
		// Browsers post forms with "Origin: null" under no-referrer.
		req, _ := http.NewRequest("POST", pub+"/f/"+link.Token, strings.NewReader(v.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Origin", "null")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		return res.StatusCode, string(b)
	}
	answer := url.Values{"stamp": {stamp}, name: {"Public"}, "cemail": {"b@example.com"}, "ckind": {"Bug"}, "csrc": {"Hacked"}}
	// Too quick.
	if code, _ := post(answer); code != 400 {
		t.Errorf("instant submission: %d", code)
	}
	// Forged stamp.
	forged := url.Values{"stamp": {"1." + strings.Repeat("A", 22)}, name: {"x"}, "cemail": {"c@example.com"}}
	if code, _ := post(forged); code != 400 {
		t.Errorf("forged stamp: %d", code)
	}
	old := h.srv.stamp(link.Token, time.Now().Add(-time.Minute))
	answer.Set("stamp", old)
	if code, body := post(answer); code != 200 || !strings.Contains(body, "Thanks") {
		t.Fatalf("submit: %d", code)
	}
	tb = h.table(p)
	last := tb.Rows[len(tb.Rows)-1]
	if len(tb.Rows) != 2 || last.Cells[name] != "Public" || last.Cells["csrc"] != "Website" {
		t.Fatalf("public row: %+v", tb.Rows)
	}
	// The honeypot drops a bot's answer quietly.
	bot := url.Values{"stamp": {old}, name: {"Bot"}, "cemail": {"d@example.com"}, "website": {"http://spam"}}
	if code, _ := post(bot); code != 200 || len(h.table(p).Rows) != 2 {
		t.Errorf("honeypot: %d", code)
	}
	// The limit of 2 public answers: one more, then closed.
	answer.Set(name, "Second")
	post(answer)
	if code, body := post(answer); !strings.Contains(body, "isn't taking answers") {
		t.Errorf("limit not enforced: %d", code)
	}
	if code, _ := get(); code != 200 {
		t.Errorf("closed form page: %d", code)
	}
	// The public handler serves nothing else.
	res, _ := http.Get(pub + "/api/tree")
	if res.StatusCode != 404 {
		t.Errorf("public handler served the API: %d", res.StatusCode)
	}
	res.Body.Close()
	// Unknown links.
	res, _ = http.Get(pub + "/f/" + strings.Repeat("x", 24))
	if res.StatusCode != 404 {
		t.Errorf("unknown link: %d", res.StatusCode)
	}
	res.Body.Close()
}

func httpTestServer(t *testing.T, h http.Handler) string {
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	return ts.URL
}
