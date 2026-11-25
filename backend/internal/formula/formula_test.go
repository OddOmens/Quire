package formula

import (
	"strings"
	"testing"
	"time"
)

type testCtx struct {
	row  map[string]Value
	cols map[string]Value
}

func (c testCtx) Field(name string) Value {
	if v, ok := c.row[strings.ToLower(name)]; ok {
		return v
	}
	return Fail("#REF!", "no column "+name)
}

func (c testCtx) Column(table, name string) Value {
	key := strings.ToLower(name)
	if table != "" {
		key = strings.ToLower(table) + "/" + key
	}
	if v, ok := c.cols[key]; ok {
		return v
	}
	return Fail("#REF!", "no column "+name)
}

func nums(ns ...float64) Value {
	out := make([]Value, len(ns))
	for i, n := range ns {
		out[i] = Num(n)
	}
	return Items(out)
}

func strs(ss ...string) Value {
	out := make([]Value, len(ss))
	for i, s := range ss {
		if s == "" {
			out[i] = Value{}
		} else {
			out[i] = Str(s)
		}
	}
	return Items(out)
}

func run(t *testing.T, src string) Value {
	t.Helper()
	n, err := Parse(src)
	if err != nil {
		t.Fatalf("%s: parse: %v", src, err)
	}
	d, _ := ParseDate("2026-01-31")
	ctx := testCtx{
		row: map[string]Value{
			"price": Num(2.5), "qty": Num(4), "paid": Boolean(false), "name": Str("Ada Lovelace"),
			"due": d, "blank": {}, "tags": strs("a", "b"),
		},
		cols: map[string]Value{
			"amount":          nums(10, 20, 30, 40),
			"category":        strs("Food", "Rent", "Food", ""),
			"done":            Items([]Value{Boolean(true), Boolean(false), Boolean(true), Boolean(false)}),
			"rates/code":      strs("USD", "EUR"),
			"rates/rate":      nums(1, 1.1),
			"my table/amount": nums(5, 5),
		},
	}
	return Eval(n, NewEnv(ctx, time.Date(2026, 11, 3, 15, 30, 0, 0, time.UTC)))
}

func TestFormulas(t *testing.T) {
	cases := map[string]string{
		"=1+2*3":                              "7",
		"(1+2)*3":                             "9",
		"-2^2":                                "4",
		"2^3^2":                               "512",
		"0.1+0.2":                             "0.3",
		"10/4":                                "2.5",
		"50%":                                 "0.5",
		"{Price} * {Qty}":                     "10",
		"{price}*{QTY}":                       "10",
		`IF({Paid}, 0, {Price})`:              "2.5",
		`{Name} & "!"`:                        "Ada Lovelace!",
		`LEFT({Name}, 3)`:                     "Ada",
		`UPPER(RIGHT({Name}, 8))`:             "LOVELACE",
		"SUM([Amount])":                       "100",
		"AVERAGE([Amount])":                   "25",
		"MAX([Amount]) - MIN([Amount])":       "30",
		`SUMIF([Category], "Food", [Amount])`: "40",
		`SUMIF([Amount], ">15")`:              "90",
		`COUNTIF([Category], "food")`:         "2",
		`COUNTIF([Category], "<>Food")`:       "2",
		`COUNTIF([Category], "")`:             "1",
		`COUNTIF([Category], "F*")`:           "2",
		`COUNTIFS([Category], "Food", [Amount], ">10")`: "1",
		`SUMIFS([Amount], [Done], TRUE)`:                "40",
		`SUM(FILTER([Amount], [Category] = "Food"))`:    "40",
		`SUM([Amount] * 2)`:                             "200",
		`SUMPRODUCT([Amount], [Amount])`:                "3000",
		`COUNTA([Category])`:                            "3",
		`COUNTUNIQUE([Category])`:                       "2",
		`XLOOKUP("EUR", [Rates/Code], [Rates/Rate])`:    "1.1",
		`XLOOKUP("GBP", [Rates/Code], [Rates/Rate], 0)`: "0",
		`SUM([My Table/Amount])`:                        "10",
		`ROUND(2.675, 2)`:                               "2.68",
		`ROUNDUP(1.1)`:                                  "2",
		`ROUNDDOWN(-1.9)`:                               "-1",
		`MOD(-3, 5)`:                                    "2",
		`{Due} + 1`:                                     "2026-02-01",
		`EDATE({Due}, 1)`:                               "2026-02-28",
		`EOMONTH({Due}, 1)`:                             "2026-02-28",
		`DAYS(TODAY(), {Due})`:                          "276",
		`DATEDIF({Due}, TODAY(), "M")`:                  "9",
		`TODAY() - {Due}`:                               "276",
		`YEAR({Due})`:                                   "2026",
		`TEXT({Due}, "mmm d, yyyy")`:                    "Jan 31, 2026",
		`TEXT(NOW(), "h:mm AM/PM")`:                     "3:30 PM",
		`TEXT(1234.5, "$#,##0.00")`:                     "$1,234.50",
		`TEXT(0.256, "0.0%")`:                           "25.6%",
		`NETWORKDAYS(DATE(2026,11,2), DATE(2026,11,8))`: "5",
		`WORKDAY(DATE(2026,11,6), 1)`:                   "2026-11-09",
		`IFERROR(1/0, "none")`:                          "none",
		`ISBLANK({Blank})`:                              "TRUE",
		`{Blank} + 1`:                                   "1",
		`AND({Price} > 1, {Qty} < 5)`:                   "TRUE",
		`OR({Paid}, FALSE)`:                             "FALSE",
		`NOT({Paid})`:                                   "TRUE",
		`{Price} = 2.5`:                                 "TRUE",
		`"5" = 5`:                                       "TRUE",
		`"abc" <> "ABC"`:                                "FALSE",
		`SWITCH({Qty}, 1, "one", 4, "four", "many")`:    "four",
		`IFS({Qty} > 10, "big", {Qty} > 2, "mid", TRUE, "small")`: "mid",
		`TEXTJOIN(", ", TRUE, [Category])`:                        "Food, Rent, Food",
		`JOIN("-", UNIQUE([Category]))`:                           "Food-Rent",
		`INDEX(SORT([Amount], FALSE), 1)`:                         "40",
		`INDEX([Amount], -1)`:                                     "40",
		`MATCH(30, [Amount])`:                                     "3",
		`COUNTA({Tags})`:                                          "2",
		`REGEXEXTRACT("Order #1234", "#(\d+)")`:                   "1234",
		`SUBSTITUTE("a-b-c", "-", "/")`:                           "a/b/c",
		`'it''s'`:                                                 "it's",
		`ROUND([Amount] / 3, 1)`:                                  "3.3, 6.7, 10, 13.3",
		`MEDIAN(1, 3, 2, 4)`:                                      "2.5",
	}
	for src, want := range cases {
		if got := run(t, src); got.String() != want {
			t.Errorf("%s = %s (%s), want %s", src, got.String(), got.Msg, want)
		}
	}
}

func TestErrors(t *testing.T) {
	cases := map[string]string{
		"1/0":                "#DIV/0!",
		"{Missing}":          "#REF!",
		"NOPE(1)":            "#NAME?",
		`"a" * 2`:            "#VALUE!",
		"SUM(1/0, 2)":        "#DIV/0!",
		"ROUND()":            "#N/A",
		`REPT("a", 1e19)`:    "#VALUE!",
		`INDEX([Amount], 9)`: "#REF!",
		`XLOOKUP("x", [Rates/Code], [Rates/Rate])`: "#N/A",
	}
	for src, want := range cases {
		if got := run(t, src); got.K != Error || got.S != want {
			t.Errorf("%s = %s, want error %s", src, got.String(), want)
		}
	}
}

func TestSyntaxErrors(t *testing.T) {
	for _, src := range []string{"", "=", "1 +", "(1", "SUM(1", "{Price", `"open`, "Price * 2", "[/x]", "1 $ 2"} {
		if _, err := Parse(src); err == nil {
			t.Errorf("%q parsed, want an error", src)
		}
	}
	if _, err := Parse(strings.Repeat("(", 300) + "1" + strings.Repeat(")", 300)); err == nil {
		t.Error("deep nesting parsed")
	}
}

func TestBudget(t *testing.T) {
	n, _ := Parse("SUMIF([Amount], \">1\")")
	ctx := testCtx{cols: map[string]Value{"amount": nums(make([]float64, 1000)...)}}
	steps := 5000
	e := Env{Ctx: ctx, Now: time.Now(), Steps: &steps}
	var last Value
	for range 100 {
		last = Eval(n, e)
	}
	if last.S != "#SLOW!" {
		t.Errorf("budget not enforced: %s", last.String())
	}
}

func TestRename(t *testing.T) {
	cases := [][5]string{
		{"{Price} * {Qty}", "", "price", "Cost", "{Cost} * {Qty}"},
		{"= SUM([Price]) + {Price}", "", "Price", "Unit price", "= SUM([Unit price]) + {Unit price}"},
		{`SUM([Rates/Rate]) & "{Rate}"`, "Rates", "Rate", "FX", `SUM([Rates/FX]) & "{Rate}"`},
		{"{Rate}", "Rates", "Rate", "FX", "{Rate}"},
		{"\r\n{A}+{A}", "", "A", "B", "\r\n{B}+{B}"},
	}
	for _, c := range cases {
		if got := Rename(c[0], c[1], c[2], c[3]); got != c[4] {
			t.Errorf("Rename(%q) = %q, want %q", c[0], got, c[4])
		}
	}
}

func TestParseNumberAndDate(t *testing.T) {
	for in, want := range map[string]float64{"1,234.50": 1234.5, "$12": 12, "-$3": -3, "(4)": -4, "15%": 0.15, "1e3": 1000, " 7 ": 7} {
		if got, ok := ParseNumber(in); !ok || got != want {
			t.Errorf("ParseNumber(%q) = %v, %v", in, got, ok)
		}
	}
	for _, bad := range []string{"", "abc", "1 2", "1.2.3"} {
		if _, ok := ParseNumber(bad); ok {
			t.Errorf("ParseNumber(%q) ok", bad)
		}
	}
	for in, want := range map[string]string{"2026-11-03": "2026-11-03", "11/3/2026": "2026-11-03", "Nov 3, 2026": "2026-11-03", "2026-11-03T14:05": "2026-11-03 14:05"} {
		if d, ok := ParseDate(in); !ok || d.String() != want {
			t.Errorf("ParseDate(%q) = %s, %v", in, d.String(), ok)
		}
	}
}
