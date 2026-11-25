// Package formula evaluates spreadsheet-style formulas for database columns
// and for {{ … }} on pages. The syntax follows Google Sheets: functions like
// SUM and IF, & to join text, = and <> to compare. Instead of cell addresses
// a formula names columns: {Price} is this row's Price, [Price] is the whole
// column, and [Expenses/Amount] is a column of another database.
//
// Evaluation can't reach anything but the values the caller hands it, and a
// step budget stops runaway formulas.
package formula

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
)

type Kind uint8

const (
	Empty Kind = iota
	Number
	Text
	Bool
	Date
	List
	Error
)

// Value is the result of evaluating a formula, or one of its inputs.
type Value struct {
	K Kind
	N float64
	S string // text, or an error code like "#DIV/0!"
	B bool
	T time.Time
	// HasTime marks a date that carries a time of day.
	HasTime bool
	L       []Value
	// Msg explains an error in words.
	Msg string
}

func Num(n float64) Value   { return Value{K: Number, N: n} }
func Str(s string) Value    { return Value{K: Text, S: s} }
func Boolean(b bool) Value  { return Value{K: Bool, B: b} }
func Items(l []Value) Value { return Value{K: List, L: l} }

// Day is a date without a time of day.
func Day(t time.Time) Value {
	return Value{K: Date, T: time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)}
}

// Moment is a date with a time of day. Times are wall-clock times with no
// zone, the way the user typed them.
func Moment(t time.Time) Value {
	return Value{K: Date, T: time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), 0, 0, time.UTC), HasTime: true}
}

// Fail is an error value: code is shown in the cell, msg on hover.
func Fail(code, msg string) Value { return Value{K: Error, S: code, Msg: msg} }

func (v Value) IsError() bool { return v.K == Error }

// Truthy is how IF and friends read a value.
func (v Value) Truthy() bool {
	switch v.K {
	case Bool:
		return v.B
	case Number:
		return v.N != 0
	case Text:
		return v.S != "" && !strings.EqualFold(v.S, "false")
	case Date:
		return true
	case List:
		return len(v.L) > 0
	}
	return false
}

// AsNumber reads a value as a number: empty is 0, a date is days since
// 1899-12-30 like a spreadsheet, and text must look like a number.
func (v Value) AsNumber() (float64, bool) {
	switch v.K {
	case Number:
		return v.N, true
	case Empty:
		return 0, true
	case Bool:
		if v.B {
			return 1, true
		}
		return 0, true
	case Date:
		return serial(v.T), true
	case Text:
		return ParseNumber(v.S)
	case List:
		if len(v.L) == 1 {
			return v.L[0].AsNumber()
		}
	}
	return 0, false
}

var epoch = time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC)

func serial(t time.Time) float64 { return t.Sub(epoch).Hours() / 24 }

func fromSerial(n float64) time.Time {
	return epoch.Add(time.Duration(math.Round(n*24*3600)) * time.Second)
}

// String is a value as text: what & joins and what TEXT-like functions see.
func (v Value) String() string {
	switch v.K {
	case Number:
		return FormatNumber(v.N)
	case Text:
		return v.S
	case Bool:
		if v.B {
			return "TRUE"
		}
		return "FALSE"
	case Date:
		if v.HasTime {
			return v.T.Format("2006-01-02 15:04")
		}
		return v.T.Format("2006-01-02")
	case List:
		parts := make([]string, len(v.L))
		for i, x := range v.L {
			parts[i] = x.String()
		}
		return strings.Join(parts, ", ")
	case Error:
		return v.S
	}
	return ""
}

// FormatNumber writes a number without float noise: 0.1+0.2 shows as 0.3.
func FormatNumber(n float64) string {
	if math.IsInf(n, 0) || math.IsNaN(n) {
		return "#NUM!"
	}
	r := strings.TrimRight(strconv.FormatFloat(n, 'f', 10, 64), "0")
	r = strings.TrimSuffix(r, ".")
	if r == "-0" {
		r = "0"
	}
	return r
}

// ParseNumber reads a number as people type it: "1,234.50", "$12", "-4",
// "(4)", "15%" (as 0.15) and "1e3".
func ParseNumber(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	neg := false
	if strings.HasPrefix(s, "(") && strings.HasSuffix(s, ")") {
		neg, s = true, strings.TrimSpace(s[1:len(s)-1])
	}
	pct := false
	if strings.HasSuffix(s, "%") {
		pct, s = true, strings.TrimSpace(strings.TrimSuffix(s, "%"))
	}
	if strings.HasPrefix(s, "-") {
		neg, s = !neg, strings.TrimSpace(s[1:])
	} else if strings.HasPrefix(s, "+") {
		s = strings.TrimSpace(s[1:])
	}
	s = strings.TrimLeft(s, "$€£¥₹")
	if strings.HasPrefix(s, "-") {
		neg, s = !neg, s[1:]
	}
	s = strings.ReplaceAll(s, ",", "")
	s = strings.ReplaceAll(s, "_", "")
	if s == "" || strings.ContainsAny(s, " \t") {
		return 0, false
	}
	n, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsInf(n, 0) || math.IsNaN(n) {
		return 0, false
	}
	if pct {
		n /= 100
	}
	if neg {
		n = -n
	}
	return n, true
}

// dateLayouts are the ways a date may be written in a cell or a formula.
var dateLayouts = []struct {
	layout string
	time   bool
}{
	{"2006-01-02T15:04", true}, {"2006-01-02T15:04:05", true}, {"2006-01-02 15:04", true}, {"2006-01-02 15:04:05", true},
	{"2006-01-02", false}, {"2006/01/02", false}, {"1/2/2006", false}, {"01/02/2006", false},
	{"1/2/2006 15:04", true}, {"1/2/2006 3:04 PM", true}, {"1/2/2006 3:04PM", true},
	{"Jan 2, 2006", false}, {"Jan 2 2006", false}, {"January 2, 2006", false}, {"January 2 2006", false},
	{"2 Jan 2006", false}, {"2 January 2006", false}, {"Mon, Jan 2, 2006", false},
	{"2006-01-02T15:04:05Z07:00", true},
}

// ParseDate reads a date (and maybe a time) as people write it. Dates are
// month-first when ambiguous, as in the US.
func ParseDate(s string) (Value, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return Value{}, false
	}
	for _, l := range dateLayouts {
		if t, err := time.Parse(l.layout, s); err == nil {
			if l.time {
				return Moment(t), true
			}
			return Day(t), true
		}
	}
	return Value{}, false
}

// MarshalJSON gives the API a plain value: number, string, bool, a date as
// "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM", a list as an array, empty as null and
// an error as {"error": code, "message": msg}.
func (v Value) MarshalJSON() ([]byte, error) {
	switch v.K {
	case Number:
		if math.IsInf(v.N, 0) || math.IsNaN(v.N) {
			return json.Marshal(map[string]string{"error": "#NUM!", "message": "the result is too large"})
		}
		return json.Marshal(v.N)
	case Text:
		return json.Marshal(v.S)
	case Bool:
		return json.Marshal(v.B)
	case Date:
		if v.HasTime {
			return json.Marshal(map[string]string{"date": v.T.Format("2006-01-02T15:04")})
		}
		return json.Marshal(map[string]string{"date": v.T.Format("2006-01-02")})
	case List:
		if v.L == nil {
			return []byte("[]"), nil
		}
		return json.Marshal(v.L)
	case Error:
		return json.Marshal(map[string]string{"error": v.S, "message": v.Msg})
	}
	return []byte("null"), nil
}
