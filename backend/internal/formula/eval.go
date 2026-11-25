package formula

import (
	"math"
	"strings"
	"time"
)

// Context supplies the values a formula refers to.
type Context interface {
	// Field is this row's value of a column ({Name}).
	Field(name string) Value
	// Column is every row's value of a column ([Name] or [Table/Name]).
	Column(table, name string) Value
}

// Env is one evaluation: where references come from, what time it is, and a
// budget of steps shared by every formula evaluated with it.
type Env struct {
	Ctx Context
	// Now is the current wall-clock time in the user's zone.
	Now   time.Time
	Steps *int
}

// Budget is how many steps one request's formulas may take together. A
// per-row SUMIF over a large table is the expensive case.
const Budget = 30_000_000

// NewEnv returns an Env with a fresh budget.
func NewEnv(ctx Context, now time.Time) Env {
	n := Budget
	return Env{Ctx: ctx, Now: now, Steps: &n}
}

var errBudget = Fail("#SLOW!", "these formulas take too long to work out; simplify them or split the table")

func (e Env) spend(n int) bool {
	if e.Steps == nil {
		return true
	}
	*e.Steps -= n
	return *e.Steps >= 0
}

// Eval works out a parsed formula.
func Eval(n Node, e Env) Value {
	if !e.spend(1) {
		return errBudget
	}
	switch x := n.(type) {
	case numLit:
		return Num(x.v)
	case strLit:
		return Str(x.v)
	case boolLit:
		return Boolean(x.v)
	case field:
		if e.Ctx == nil {
			return Fail("#REF!", "{"+x.name+"} only works in a database column; use ["+x.name+"] for the whole column")
		}
		return e.Ctx.Field(x.name)
	case column:
		if e.Ctx == nil {
			return Fail("#REF!", "column not found")
		}
		v := e.Ctx.Column(x.table, x.name)
		if v.K == List && !e.spend(len(v.L)) {
			return errBudget
		}
		return v
	case unary:
		return mapValue(Eval(x.x, e), func(v Value) Value {
			n, ok := v.AsNumber()
			if !ok {
				return Fail("#VALUE!", "can't make "+quote(v)+" negative")
			}
			return Num(-n)
		})
	case percent:
		return mapValue(Eval(x.x, e), func(v Value) Value {
			n, ok := v.AsNumber()
			if !ok {
				return Fail("#VALUE!", quote(v)+" isn't a number")
			}
			return Num(n / 100)
		})
	case binary:
		switch x.op {
		case "&&":
			l := Eval(x.l, e)
			if l.IsError() || !l.Truthy() {
				return orBool(l)
			}
			return orBool(Eval(x.r, e))
		case "||":
			l := Eval(x.l, e)
			if l.IsError() || l.Truthy() {
				return orBool(l)
			}
			return orBool(Eval(x.r, e))
		}
		l, r := Eval(x.l, e), Eval(x.r, e)
		return broadcast(l, r, e, func(a, b Value) Value { return apply(x.op, a, b) })
	case call:
		return callFunc(x, e)
	}
	return Fail("#ERROR!", "unknown formula part")
}

func orBool(v Value) Value {
	if v.IsError() {
		return v
	}
	return Boolean(v.Truthy())
}

// mapValue applies f to a value, or to each item of a list.
func mapValue(v Value, f func(Value) Value) Value {
	if v.K == Error {
		return v
	}
	if v.K == List {
		out := make([]Value, len(v.L))
		for i, x := range v.L {
			out[i] = mapValue(x, f)
		}
		return Items(out)
	}
	return f(v)
}

// broadcast applies an operator item by item when either side is a list,
// so [Price] * [Qty] multiplies row by row and [Amount] > 100 compares each.
func broadcast(l, r Value, e Env, f func(a, b Value) Value) Value {
	if l.K == Error {
		return l
	}
	if r.K == Error {
		return r
	}
	switch {
	case l.K == List && r.K == List:
		if len(l.L) != len(r.L) {
			return Fail("#VALUE!", "the two lists have different lengths")
		}
		if !e.spend(len(l.L)) {
			return errBudget
		}
		out := make([]Value, len(l.L))
		for i := range l.L {
			out[i] = broadcast(l.L[i], r.L[i], e, f)
		}
		return Items(out)
	case l.K == List:
		if !e.spend(len(l.L)) {
			return errBudget
		}
		out := make([]Value, len(l.L))
		for i := range l.L {
			out[i] = broadcast(l.L[i], r, e, f)
		}
		return Items(out)
	case r.K == List:
		if !e.spend(len(r.L)) {
			return errBudget
		}
		out := make([]Value, len(r.L))
		for i := range r.L {
			out[i] = broadcast(l, r.L[i], e, f)
		}
		return Items(out)
	}
	return f(l, r)
}

func quote(v Value) string {
	if v.K == Text {
		return `"` + v.S + `"`
	}
	if v.K == Empty {
		return "an empty value"
	}
	return v.String()
}

func apply(op string, a, b Value) Value {
	switch op {
	case "&":
		return Str(a.String() + b.String())
	case "=", "<>", "<", ">", "<=", ">=":
		c := Compare(a, b)
		switch op {
		case "=":
			return Boolean(c == 0)
		case "<>":
			return Boolean(c != 0)
		case "<":
			return Boolean(c < 0)
		case ">":
			return Boolean(c > 0)
		case "<=":
			return Boolean(c <= 0)
		default:
			return Boolean(c >= 0)
		}
	}
	// Date arithmetic: date + days, date - days, date - date (in days).
	if a.K == Date || b.K == Date {
		switch {
		case op == "-" && a.K == Date && b.K == Date:
			return Num(roundDays(serial(a.T) - serial(b.T)))
		case (op == "+" || op == "-") && a.K == Date:
			n, ok := b.AsNumber()
			if !ok {
				return Fail("#VALUE!", "add a number of days to a date")
			}
			if op == "-" {
				n = -n
			}
			return dateLike(a, fromSerial(serial(a.T)+n))
		case op == "+" && b.K == Date:
			n, ok := a.AsNumber()
			if !ok {
				return Fail("#VALUE!", "add a number of days to a date")
			}
			return dateLike(b, fromSerial(serial(b.T)+n))
		}
	}
	x, ok := a.AsNumber()
	if !ok {
		return Fail("#VALUE!", quote(a)+" isn't a number")
	}
	y, ok := b.AsNumber()
	if !ok {
		return Fail("#VALUE!", quote(b)+" isn't a number")
	}
	switch op {
	case "+":
		return Num(x + y)
	case "-":
		return Num(x - y)
	case "*":
		return Num(x * y)
	case "/":
		if y == 0 {
			return Fail("#DIV/0!", "division by zero")
		}
		return Num(x / y)
	case "^":
		r := math.Pow(x, y)
		if math.IsNaN(r) || math.IsInf(r, 0) {
			return Fail("#NUM!", "the result isn't a real number")
		}
		return Num(r)
	}
	return Fail("#ERROR!", "unknown operator "+op)
}

// roundDays drops the float noise from subtracting two dates.
func roundDays(d float64) float64 { return math.Round(d*1e6) / 1e6 }

func dateLike(like Value, t time.Time) Value {
	if like.HasTime {
		return Moment(t)
	}
	return Day(t)
}

// Compare orders two values: numbers by size, text without regard to case,
// dates by time, empty as 0 or "". Numbers sort before text, text before
// true/false, as in Sheets.
func Compare(a, b Value) int {
	if a.K == Empty && b.K == Empty {
		return 0
	}
	if a.K == Empty {
		a = zeroLike(b)
	}
	if b.K == Empty {
		b = zeroLike(a)
	}
	if a.K == Date || b.K == Date {
		x, okx := a.AsNumber()
		y, oky := b.AsNumber()
		if !okx && a.K == Text {
			if d, ok := ParseDate(a.S); ok {
				x, okx = serial(d.T), true
			}
		}
		if !oky && b.K == Text {
			if d, ok := ParseDate(b.S); ok {
				y, oky = serial(d.T), true
			}
		}
		if okx && oky {
			return cmpFloat(x, y)
		}
	}
	rank := func(v Value) int {
		switch v.K {
		case Number, Date:
			return 0
		case Text:
			return 1
		case Bool:
			return 2
		}
		return 3
	}
	if a.K == Text && b.K == Number || a.K == Number && b.K == Text {
		// "5" = 5 is true in Quire, since cells often hold numbers as text.
		x, okx := a.AsNumber()
		y, oky := b.AsNumber()
		if okx && oky {
			return cmpFloat(x, y)
		}
	}
	if ra, rb := rank(a), rank(b); ra != rb {
		return ra - rb
	}
	switch a.K {
	case Number, Date:
		x, _ := a.AsNumber()
		y, _ := b.AsNumber()
		return cmpFloat(x, y)
	case Text:
		return strings.Compare(strings.ToLower(a.S), strings.ToLower(b.S))
	case Bool:
		switch {
		case a.B == b.B:
			return 0
		case !a.B:
			return -1
		}
		return 1
	}
	return strings.Compare(a.String(), b.String())
}

func zeroLike(v Value) Value {
	switch v.K {
	case Text:
		return Str("")
	case Bool:
		return Boolean(false)
	}
	return Num(0)
}

func cmpFloat(x, y float64) int {
	switch {
	case x < y:
		return -1
	case x > y:
		return 1
	}
	return 0
}
