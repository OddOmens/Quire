package formula

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type fn struct {
	min, max int // max -1 is any number
	// lazy functions evaluate their own arguments (IF, IFERROR, AND…).
	lazy  func(e Env, args []Node) Value
	eager func(e Env, a []Value) Value
	// Help is shown in the formula editor.
	Help string
}

var funcs map[string]fn

// Function describes one function for the formula editor's suggestions.
type Function struct {
	Name string `json:"name"`
	Help string `json:"help"`
}

// Functions lists every function, alphabetically.
func Functions() []Function {
	out := make([]Function, 0, len(funcs))
	for name, f := range funcs {
		if f.Help != "" {
			out = append(out, Function{name, f.Help})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func callFunc(c call, e Env) Value {
	f, ok := funcs[c.name]
	if !ok {
		return Fail("#NAME?", "there's no function called "+c.name)
	}
	if len(c.args) < f.min || (f.max >= 0 && len(c.args) > f.max) {
		return Fail("#N/A", arity(c.name, f))
	}
	if f.lazy != nil {
		return f.lazy(e, c.args)
	}
	vals := make([]Value, len(c.args))
	for i, a := range c.args {
		vals[i] = Eval(a, e)
	}
	return f.eager(e, vals)
}

func arity(name string, f fn) string {
	switch {
	case f.min == f.max && f.min == 0:
		return name + " takes no values"
	case f.min == f.max:
		return fmt.Sprintf("%s takes %d %s", name, f.min, plural(f.min, "value"))
	case f.max < 0:
		return fmt.Sprintf("%s takes at least %d %s", name, f.min, plural(f.min, "value"))
	}
	return fmt.Sprintf("%s takes %d to %d values", name, f.min, f.max)
}

func plural(n int, s string) string {
	if n == 1 {
		return s
	}
	return s + "s"
}

// flat spreads lists into one run of values.
func flat(vals []Value) []Value {
	var out []Value
	for _, v := range vals {
		if v.K == List {
			out = append(out, flat(v.L)...)
		} else {
			out = append(out, v)
		}
	}
	return out
}

func firstError(vals []Value) (Value, bool) {
	for _, v := range vals {
		if v.K == Error {
			return v, true
		}
	}
	return Value{}, false
}

// numbers picks the numbers out of values, skipping blanks, text that isn't
// a number and true/false, as spreadsheet ranges do.
func numbers(vals []Value) ([]float64, Value, bool) {
	vals = flat(vals)
	if err, bad := firstError(vals); bad {
		return nil, err, false
	}
	out := make([]float64, 0, len(vals))
	for _, v := range vals {
		switch v.K {
		case Number:
			out = append(out, v.N)
		case Date:
			out = append(out, serial(v.T))
		case Text:
			if n, ok := ParseNumber(v.S); ok {
				out = append(out, n)
			}
		}
	}
	return out, Value{}, true
}

func numArg(v Value, name string) (float64, Value, bool) {
	if v.K == Error {
		return 0, v, false
	}
	n, ok := v.AsNumber()
	if !ok {
		return 0, Fail("#VALUE!", name+" needs a number, not "+quote(v)), false
	}
	return n, Value{}, true
}

func aggregate(f func([]float64) Value) func(Env, []Value) Value {
	return func(_ Env, a []Value) Value {
		ns, err, ok := numbers(a)
		if !ok {
			return err
		}
		return f(ns)
	}
}

func sum(ns []float64) float64 {
	t := 0.0
	for _, n := range ns {
		t += n
	}
	return t
}

func dateArg(v Value, name string) (Value, Value, bool) {
	switch v.K {
	case Date:
		return v, Value{}, true
	case Text:
		if d, ok := ParseDate(v.S); ok {
			return d, Value{}, true
		}
	case Number:
		return Day(fromSerial(v.N)), Value{}, true
	case Error:
		return Value{}, v, false
	}
	return Value{}, Fail("#VALUE!", name+" needs a date, not "+quote(v)), false
}

func textArg(v Value) string { return v.String() }

// matcher turns a criterion like ">100", "<>Done", "Food" or "Jan*" into a
// test, the way SUMIF and COUNTIF read them.
func matcher(c Value) func(Value) bool {
	if c.K != Text {
		return func(v Value) bool { return v.K != Empty && Compare(v, c) == 0 }
	}
	s := c.S
	op := "="
	for _, o := range []string{"<=", ">=", "<>", "!=", "<", ">", "="} {
		if strings.HasPrefix(s, o) {
			op, s = o, s[len(o):]
			break
		}
	}
	if op == "!=" {
		op = "<>"
	}
	var target Value
	if n, ok := ParseNumber(s); ok {
		target = Num(n)
	} else if d, ok := ParseDate(s); ok {
		target = d
	} else {
		target = Str(s)
	}
	var wild *regexp.Regexp
	if target.K == Text && strings.ContainsAny(s, "*?") {
		var b strings.Builder
		b.WriteString("(?is)^")
		for _, r := range s {
			switch r {
			case '*':
				b.WriteString(".*")
			case '?':
				b.WriteString(".")
			default:
				b.WriteString(regexp.QuoteMeta(string(r)))
			}
		}
		b.WriteString("$")
		wild, _ = regexp.Compile(b.String())
	}
	return func(v Value) bool {
		if s == "" {
			blank := v.K == Empty || (v.K == Text && v.S == "")
			if op == "<>" {
				return !blank
			}
			return op == "=" && blank
		}
		if wild != nil && (op == "=" || op == "<>") {
			return wild.MatchString(v.String()) == (op == "=")
		}
		if v.K == Empty && op != "<>" {
			return false
		}
		// A number or date criterion only matches numbers and dates.
		if target.K != Text && !(v.K == Number || v.K == Date || (v.K == Text && isNum(v.S))) {
			return op == "<>"
		}
		c := Compare(v, target)
		switch op {
		case "=":
			return c == 0
		case "<>":
			return c != 0
		case "<":
			return c < 0
		case ">":
			return c > 0
		case "<=":
			return c <= 0
		}
		return c >= 0
	}
}

func isNum(s string) bool { _, ok := ParseNumber(s); return ok }

func asList(v Value) []Value {
	if v.K == List {
		return v.L
	}
	return []Value{v}
}

// ifs runs the *IFS family: pairs of (range, criterion) pick the rows.
func ifsRows(a []Value, from int, name string) ([]bool, Value, bool) {
	if (len(a)-from)%2 != 0 || len(a)-from < 2 {
		return nil, Fail("#N/A", name+" takes pairs of a column and a criterion"), false
	}
	var keep []bool
	for i := from; i < len(a); i += 2 {
		if a[i].K == Error {
			return nil, a[i], false
		}
		rng, test := asList(a[i]), matcher(a[i+1])
		if keep == nil {
			keep = make([]bool, len(rng))
			for j := range keep {
				keep[j] = true
			}
		}
		if len(rng) != len(keep) {
			return nil, Fail("#VALUE!", name+": the columns have different lengths"), false
		}
		for j, v := range rng {
			keep[j] = keep[j] && test(v)
		}
	}
	return keep, Value{}, true
}

func pick(vals []Value, keep []bool) []Value {
	var out []Value
	for i, v := range vals {
		if i < len(keep) && keep[i] {
			out = append(out, v)
		}
	}
	return out
}

func roundTo(n float64, digits int, mode func(float64) float64) float64 {
	p := math.Pow(10, float64(digits))
	// Settle float error first, so 2.675 rounds to 2.68 and 1.1 doesn't
	// round up to 1.2, as in a spreadsheet.
	return mode(math.Round(n*p*1e6)/1e6) / p
}

func roundHalfAway(x float64) float64 { return math.Round(x) }
func roundUp(x float64) float64 {
	if x < 0 {
		return math.Floor(x)
	}
	return math.Ceil(x)
}
func roundDown(x float64) float64 { return math.Trunc(x) }

func roundFn(mode func(float64) float64, name string) func(Env, []Value) Value {
	return func(_ Env, a []Value) Value {
		return broadcastArgs(a, func(a []Value) Value {
			n, err, ok := numArg(a[0], name)
			if !ok {
				return err
			}
			d := 0.0
			if len(a) > 1 {
				if d, err, ok = numArg(a[1], name); !ok {
					return err
				}
			}
			return Num(roundTo(n, int(d), mode))
		})
	}
}

// broadcastArgs runs a scalar function on each item when the first value
// is a list, so ROUND([Amount], 2) rounds every row.
func broadcastArgs(a []Value, f func([]Value) Value) Value {
	if len(a) > 0 && a[0].K == List {
		out := make([]Value, len(a[0].L))
		for i, x := range a[0].L {
			args := slices.Clone(a)
			args[0] = x
			out[i] = broadcastArgs(args, f)
		}
		return Items(out)
	}
	return f(a)
}

func math1(name string, f func(float64) (float64, string)) fn {
	return fn{min: 1, max: 1, eager: func(_ Env, a []Value) Value {
		return broadcastArgs(a, func(a []Value) Value {
			n, err, ok := numArg(a[0], name)
			if !ok {
				return err
			}
			r, bad := f(n)
			if bad != "" {
				return Fail("#NUM!", bad)
			}
			return Num(r)
		})
	}}
}

func text1(f func(string) Value) func(Env, []Value) Value {
	return func(_ Env, a []Value) Value {
		return broadcastArgs(a, func(a []Value) Value {
			if a[0].K == Error {
				return a[0]
			}
			return f(textArg(a[0]))
		})
	}
}

func date1(name string, f func(Value) Value) func(Env, []Value) Value {
	return func(_ Env, a []Value) Value {
		return broadcastArgs(a, func(a []Value) Value {
			if a[0].K == Empty {
				return Value{}
			}
			d, err, ok := dateArg(a[0], name)
			if !ok {
				return err
			}
			return f(d)
		})
	}
}

func addMonths(t time.Time, months int) time.Time {
	y, m, d := t.Date()
	first := time.Date(y, m+time.Month(months), 1, t.Hour(), t.Minute(), 0, 0, time.UTC)
	last := first.AddDate(0, 1, -1).Day()
	if d > last {
		d = last
	}
	return time.Date(first.Year(), first.Month(), d, t.Hour(), t.Minute(), 0, 0, time.UTC)
}

func isWeekend(t time.Time) bool { return t.Weekday() == time.Saturday || t.Weekday() == time.Sunday }

// regexArg compiles a pattern for the REGEX functions. Go's regexp runs in
// linear time, so a pattern can't hang the server.
func regexArg(v Value) (*regexp.Regexp, Value, bool) {
	if v.K == Error {
		return nil, v, false
	}
	s := textArg(v)
	if len(s) > 500 {
		return nil, Fail("#VALUE!", "the pattern is too long"), false
	}
	re, err := regexp.Compile(s)
	if err != nil {
		return nil, Fail("#VALUE!", "the pattern isn't valid: "+err.Error()), false
	}
	return re, Value{}, true
}

func init() {
	funcs = map[string]fn{
		// ── Numbers ──
		"SUM": {min: 1, max: -1, eager: aggregate(func(ns []float64) Value { return Num(sum(ns)) }), Help: "SUM(values…) adds numbers: SUM([Amount])"},
		"AVERAGE": {min: 1, max: -1, eager: aggregate(func(ns []float64) Value {
			if len(ns) == 0 {
				return Fail("#DIV/0!", "there are no numbers to average")
			}
			return Num(sum(ns) / float64(len(ns)))
		}), Help: "AVERAGE(values…) is the mean: AVERAGE([Score])"},
		"MIN": {min: 1, max: -1, eager: aggregate(func(ns []float64) Value {
			if len(ns) == 0 {
				return Num(0)
			}
			return Num(slices.Min(ns))
		}), Help: "MIN(values…) is the smallest number"},
		"MAX": {min: 1, max: -1, eager: aggregate(func(ns []float64) Value {
			if len(ns) == 0 {
				return Num(0)
			}
			return Num(slices.Max(ns))
		}), Help: "MAX(values…) is the largest number"},
		"MEDIAN": {min: 1, max: -1, eager: aggregate(func(ns []float64) Value {
			if len(ns) == 0 {
				return Fail("#NUM!", "there are no numbers")
			}
			s := slices.Clone(ns)
			slices.Sort(s)
			if len(s)%2 == 1 {
				return Num(s[len(s)/2])
			}
			return Num((s[len(s)/2-1] + s[len(s)/2]) / 2)
		}), Help: "MEDIAN(values…) is the middle number"},
		"PRODUCT": {min: 1, max: -1, eager: aggregate(func(ns []float64) Value {
			p := 1.0
			for _, n := range ns {
				p *= n
			}
			return Num(p)
		}), Help: "PRODUCT(values…) multiplies numbers"},
		"STDEV": {min: 1, max: -1, eager: aggregate(func(ns []float64) Value {
			if len(ns) < 2 {
				return Fail("#DIV/0!", "STDEV needs at least two numbers")
			}
			m := sum(ns) / float64(len(ns))
			v := 0.0
			for _, n := range ns {
				v += (n - m) * (n - m)
			}
			return Num(math.Sqrt(v / float64(len(ns)-1)))
		}), Help: "STDEV(values…) is the sample standard deviation"},
		"COUNT": {min: 1, max: -1, eager: func(_ Env, a []Value) Value {
			n := 0
			for _, v := range flat(a) {
				if v.K == Number || v.K == Date {
					n++
				}
			}
			return Num(float64(n))
		}, Help: "COUNT(values…) counts the numbers"},
		"COUNTA": {min: 1, max: -1, eager: func(_ Env, a []Value) Value {
			n := 0
			for _, v := range flat(a) {
				if v.K != Empty && !(v.K == Text && v.S == "") {
					n++
				}
			}
			return Num(float64(n))
		}, Help: "COUNTA(values…) counts everything that isn't blank"},
		"COUNTBLANK": {min: 1, max: -1, eager: func(_ Env, a []Value) Value {
			n := 0
			for _, v := range flat(a) {
				if v.K == Empty || (v.K == Text && v.S == "") {
					n++
				}
			}
			return Num(float64(n))
		}, Help: "COUNTBLANK(values…) counts the blanks"},
		"COUNTUNIQUE": {min: 1, max: -1, eager: func(_ Env, a []Value) Value {
			seen := map[string]bool{}
			for _, v := range flat(a) {
				if v.K != Empty && !(v.K == Text && v.S == "") {
					seen[strings.ToLower(v.String())] = true
				}
			}
			return Num(float64(len(seen)))
		}, Help: "COUNTUNIQUE(values…) counts the different values"},
		"SUMPRODUCT": {min: 1, max: -1, eager: func(_ Env, a []Value) Value {
			if err, bad := firstError(a); bad {
				return err
			}
			n := len(asList(a[0]))
			t := 0.0
			for i := 0; i < n; i++ {
				p := 1.0
				for _, l := range a {
					items := asList(l)
					if len(items) != n {
						return Fail("#VALUE!", "SUMPRODUCT: the columns have different lengths")
					}
					x, _ := items[i].AsNumber()
					p *= x
				}
				t += p
			}
			return Num(t)
		}, Help: "SUMPRODUCT(column, column…) multiplies row by row, then adds: SUMPRODUCT([Price], [Qty])"},
		"ROUND":     {min: 1, max: 2, eager: roundFn(roundHalfAway, "ROUND"), Help: "ROUND(number, [places]) rounds to a number of decimal places"},
		"ROUNDUP":   {min: 1, max: 2, eager: roundFn(roundUp, "ROUNDUP"), Help: "ROUNDUP(number, [places]) rounds away from zero"},
		"ROUNDDOWN": {min: 1, max: 2, eager: roundFn(roundDown, "ROUNDDOWN"), Help: "ROUNDDOWN(number, [places]) rounds toward zero"},
		"INT":       math1("INT", func(n float64) (float64, string) { return math.Floor(n), "" }),
		"ABS":       math1("ABS", func(n float64) (float64, string) { return math.Abs(n), "" }),
		"SIGN": math1("SIGN", func(n float64) (float64, string) {
			return float64(cmpFloat(n, 0)), ""
		}),
		"SQRT": math1("SQRT", func(n float64) (float64, string) {
			if n < 0 {
				return 0, "SQRT of a negative number"
			}
			return math.Sqrt(n), ""
		}),
		"LN": math1("LN", func(n float64) (float64, string) {
			if n <= 0 {
				return 0, "LN needs a positive number"
			}
			return math.Log(n), ""
		}),
		"EXP": math1("EXP", func(n float64) (float64, string) { return math.Exp(n), "" }),
		"PI":  {min: 0, max: 0, eager: func(Env, []Value) Value { return Num(math.Pi) }},
		"POWER": {min: 2, max: 2, eager: func(_ Env, a []Value) Value {
			return apply("^", a[0], a[1])
		}, Help: "POWER(number, power)"},
		"MOD": {min: 2, max: 2, eager: func(_ Env, a []Value) Value {
			return broadcastArgs(a, func(a []Value) Value {
				x, err, ok := numArg(a[0], "MOD")
				if !ok {
					return err
				}
				y, err, ok := numArg(a[1], "MOD")
				if !ok {
					return err
				}
				if y == 0 {
					return Fail("#DIV/0!", "MOD by zero")
				}
				return Num(x - y*math.Floor(x/y))
			})
		}, Help: "MOD(number, divisor) is the remainder"},
		"CEILING": {min: 1, max: 2, eager: func(_ Env, a []Value) Value {
			return broadcastArgs(a, func(a []Value) Value {
				x, err, ok := numArg(a[0], "CEILING")
				if !ok {
					return err
				}
				f := 1.0
				if len(a) > 1 {
					if f, err, ok = numArg(a[1], "CEILING"); !ok {
						return err
					}
				}
				if f == 0 {
					return Num(0)
				}
				return Num(math.Ceil(x/f-1e-9) * f)
			})
		}, Help: "CEILING(number, [step]) rounds up to a multiple of step"},
		"FLOOR": {min: 1, max: 2, eager: func(_ Env, a []Value) Value {
			return broadcastArgs(a, func(a []Value) Value {
				x, err, ok := numArg(a[0], "FLOOR")
				if !ok {
					return err
				}
				f := 1.0
				if len(a) > 1 {
					if f, err, ok = numArg(a[1], "FLOOR"); !ok {
						return err
					}
				}
				if f == 0 {
					return Num(0)
				}
				return Num(math.Floor(x/f+1e-9) * f)
			})
		}, Help: "FLOOR(number, [step]) rounds down to a multiple of step"},

		// ── Logic ──
		"IF": {min: 2, max: 3, lazy: func(e Env, args []Node) Value {
			c := Eval(args[0], e)
			if c.K == Error {
				return c
			}
			if c.K == List {
				// IF([Done], 1, 0) works row by row.
				out := make([]Value, len(c.L))
				for i, x := range c.L {
					if x.K == Error {
						out[i] = x
						continue
					}
					var v Value
					if x.Truthy() {
						v = Eval(args[1], e)
					} else if len(args) > 2 {
						v = Eval(args[2], e)
					} else {
						v = Boolean(false)
					}
					if v.K == List && len(v.L) == len(c.L) {
						v = v.L[i]
					}
					out[i] = v
				}
				return Items(out)
			}
			if c.Truthy() {
				return Eval(args[1], e)
			}
			if len(args) > 2 {
				return Eval(args[2], e)
			}
			return Boolean(false)
		}, Help: `IF(test, then, [else]): IF({Paid}, 0, {Amount})`},
		"IFS": {min: 2, max: -1, lazy: func(e Env, args []Node) Value {
			if len(args)%2 != 0 {
				return Fail("#N/A", "IFS takes pairs of a test and a result")
			}
			for i := 0; i < len(args); i += 2 {
				c := Eval(args[i], e)
				if c.K == Error {
					return c
				}
				if c.Truthy() {
					return Eval(args[i+1], e)
				}
			}
			return Fail("#N/A", "none of the IFS tests matched; end with TRUE, \"…\" for a fallback")
		}, Help: `IFS(test, result, test, result…): the result of the first test that's true`},
		"SWITCH": {min: 3, max: -1, lazy: func(e Env, args []Node) Value {
			v := Eval(args[0], e)
			if v.K == Error {
				return v
			}
			rest := args[1:]
			for i := 0; i+1 < len(rest); i += 2 {
				c := Eval(rest[i], e)
				if c.K == Error {
					return c
				}
				if Compare(v, c) == 0 {
					return Eval(rest[i+1], e)
				}
			}
			if len(rest)%2 == 1 {
				return Eval(rest[len(rest)-1], e)
			}
			return Fail("#N/A", "SWITCH found no match and has no default")
		}, Help: `SWITCH(value, case, result…, [default]): SWITCH({Size}, "S", 1, "M", 2, 3)`},
		"IFERROR": {min: 1, max: 2, lazy: func(e Env, args []Node) Value {
			v := Eval(args[0], e)
			if v.K == Error {
				if len(args) > 1 {
					return Eval(args[1], e)
				}
				return Value{}
			}
			return v
		}, Help: "IFERROR(value, fallback) uses the fallback when value is an error"},
		"AND": {min: 1, max: -1, lazy: func(e Env, args []Node) Value {
			for _, a := range args {
				v := Eval(a, e)
				if v.K == Error {
					return v
				}
				for _, x := range asList(v) {
					if !x.Truthy() {
						return Boolean(false)
					}
				}
			}
			return Boolean(true)
		}, Help: "AND(tests…) is true when all are true"},
		"OR": {min: 1, max: -1, lazy: func(e Env, args []Node) Value {
			for _, a := range args {
				v := Eval(a, e)
				if v.K == Error {
					return v
				}
				for _, x := range asList(v) {
					if x.Truthy() {
						return Boolean(true)
					}
				}
			}
			return Boolean(false)
		}, Help: "OR(tests…) is true when any is true"},
		"NOT": {min: 1, max: 1, eager: func(_ Env, a []Value) Value {
			return mapValue(a[0], func(v Value) Value { return Boolean(!v.Truthy()) })
		}, Help: "NOT(test) flips true and false"},
		"ISBLANK": {min: 1, max: 1, eager: func(_ Env, a []Value) Value {
			return Boolean(a[0].K == Empty || (a[0].K == Text && a[0].S == "") || (a[0].K == List && len(a[0].L) == 0))
		}, Help: "ISBLANK(value) is true when it's empty"},
		"ISNUMBER": {min: 1, max: 1, eager: func(_ Env, a []Value) Value { return Boolean(a[0].K == Number) }, Help: "ISNUMBER(value)"},
		"ISTEXT":   {min: 1, max: 1, eager: func(_ Env, a []Value) Value { return Boolean(a[0].K == Text) }, Help: "ISTEXT(value)"},
		"ISDATE":   {min: 1, max: 1, eager: func(_ Env, a []Value) Value { return Boolean(a[0].K == Date) }, Help: "ISDATE(value)"},
		"ISERROR": {min: 1, max: 1, lazy: func(e Env, args []Node) Value {
			return Boolean(Eval(args[0], e).K == Error)
		}, Help: "ISERROR(value) is true when value is an error"},

		// ── Conditional totals ──
		"SUMIF": {min: 2, max: 3, eager: func(_ Env, a []Value) Value {
			if err, bad := firstError(a); bad {
				return err
			}
			rng, test := asList(a[0]), matcher(a[1])
			vals := rng
			if len(a) > 2 {
				vals = asList(a[2])
				if len(vals) != len(rng) {
					return Fail("#VALUE!", "SUMIF: the columns have different lengths")
				}
			}
			keep := make([]bool, len(rng))
			for i, v := range rng {
				keep[i] = test(v)
			}
			ns, err, ok := numbers(pick(vals, keep))
			if !ok {
				return err
			}
			return Num(sum(ns))
		}, Help: `SUMIF(column, criterion, [sum column]): SUMIF([Category], "Food", [Amount])`},
		"COUNTIF": {min: 2, max: 2, eager: func(_ Env, a []Value) Value {
			if err, bad := firstError(a); bad {
				return err
			}
			n, test := 0, matcher(a[1])
			for _, v := range asList(a[0]) {
				if test(v) {
					n++
				}
			}
			return Num(float64(n))
		}, Help: `COUNTIF(column, criterion): COUNTIF([Status], "Done") or COUNTIF([Amount], ">100")`},
		"AVERAGEIF": {min: 2, max: 3, eager: func(_ Env, a []Value) Value {
			if err, bad := firstError(a); bad {
				return err
			}
			rng, test := asList(a[0]), matcher(a[1])
			vals := rng
			if len(a) > 2 {
				vals = asList(a[2])
			}
			if len(vals) != len(rng) {
				return Fail("#VALUE!", "AVERAGEIF: the columns have different lengths")
			}
			keep := make([]bool, len(rng))
			for i, v := range rng {
				keep[i] = test(v)
			}
			ns, err, ok := numbers(pick(vals, keep))
			if !ok {
				return err
			}
			if len(ns) == 0 {
				return Fail("#DIV/0!", "no rows match")
			}
			return Num(sum(ns) / float64(len(ns)))
		}, Help: "AVERAGEIF(column, criterion, [average column])"},
		"SUMIFS": {min: 3, max: -1, eager: func(_ Env, a []Value) Value {
			keep, err, ok := ifsRows(a, 1, "SUMIFS")
			if !ok {
				return err
			}
			vals := asList(a[0])
			if len(vals) != len(keep) {
				return Fail("#VALUE!", "SUMIFS: the columns have different lengths")
			}
			ns, err, ok := numbers(pick(vals, keep))
			if !ok {
				return err
			}
			return Num(sum(ns))
		}, Help: `SUMIFS(sum column, column, criterion, …): SUMIFS([Amount], [Category], "Food", [Month], "Jan")`},
		"COUNTIFS": {min: 2, max: -1, eager: func(_ Env, a []Value) Value {
			keep, err, ok := ifsRows(a, 0, "COUNTIFS")
			if !ok {
				return err
			}
			n := 0
			for _, k := range keep {
				if k {
					n++
				}
			}
			return Num(float64(n))
		}, Help: "COUNTIFS(column, criterion, column, criterion…)"},
		"AVERAGEIFS": {min: 3, max: -1, eager: func(_ Env, a []Value) Value {
			keep, err, ok := ifsRows(a, 1, "AVERAGEIFS")
			if !ok {
				return err
			}
			ns, err, ok := numbers(pick(asList(a[0]), keep))
			if !ok {
				return err
			}
			if len(ns) == 0 {
				return Fail("#DIV/0!", "no rows match")
			}
			return Num(sum(ns) / float64(len(ns)))
		}, Help: "AVERAGEIFS(average column, column, criterion…)"},
		"MAXIFS": {min: 3, max: -1, eager: func(_ Env, a []Value) Value {
			keep, err, ok := ifsRows(a, 1, "MAXIFS")
			if !ok {
				return err
			}
			ns, err, ok := numbers(pick(asList(a[0]), keep))
			if !ok {
				return err
			}
			if len(ns) == 0 {
				return Num(0)
			}
			return Num(slices.Max(ns))
		}, Help: "MAXIFS(column, column, criterion…)"},
		"MINIFS": {min: 3, max: -1, eager: func(_ Env, a []Value) Value {
			keep, err, ok := ifsRows(a, 1, "MINIFS")
			if !ok {
				return err
			}
			ns, err, ok := numbers(pick(asList(a[0]), keep))
			if !ok {
				return err
			}
			if len(ns) == 0 {
				return Num(0)
			}
			return Num(slices.Min(ns))
		}, Help: "MINIFS(column, column, criterion…)"},

		// ── Lists and lookups ──
		"FILTER": {min: 2, max: -1, eager: func(_ Env, a []Value) Value {
			if err, bad := firstError(a); bad {
				return err
			}
			vals := asList(a[0])
			keep := make([]bool, len(vals))
			for i := range keep {
				keep[i] = true
			}
			for _, c := range a[1:] {
				conds := asList(c)
				if len(conds) != len(vals) {
					return Fail("#VALUE!", "FILTER: the condition has a different length than the column")
				}
				for i, x := range conds {
					keep[i] = keep[i] && x.Truthy()
				}
			}
			out := pick(vals, keep)
			if out == nil {
				out = []Value{}
			}
			return Items(out)
		}, Help: `FILTER(column, condition…): SUM(FILTER([Amount], [Category] = "Food"))`},
		"UNIQUE": {min: 1, max: 1, eager: func(_ Env, a []Value) Value {
			if a[0].K == Error {
				return a[0]
			}
			seen := map[string]bool{}
			out := []Value{}
			for _, v := range flat(a) {
				k := strings.ToLower(v.String())
				if v.K == Empty || seen[k] {
					continue
				}
				seen[k] = true
				out = append(out, v)
			}
			return Items(out)
		}, Help: "UNIQUE(column) drops repeats"},
		"SORT": {min: 1, max: 2, eager: func(_ Env, a []Value) Value {
			if err, bad := firstError(a); bad {
				return err
			}
			out := slices.Clone(flat(a[:1]))
			asc := len(a) < 2 || a[1].Truthy()
			sort.SliceStable(out, func(i, j int) bool {
				c := Compare(out[i], out[j])
				if asc {
					return c < 0
				}
				return c > 0
			})
			return Items(out)
		}, Help: "SORT(column, [ascending]) sorts a list"},
		"INDEX": {min: 2, max: 2, eager: func(_ Env, a []Value) Value {
			if err, bad := firstError(a); bad {
				return err
			}
			n, err, ok := numArg(a[1], "INDEX")
			if !ok {
				return err
			}
			l := asList(a[0])
			i := int(n)
			if i < 0 {
				i = len(l) + i + 1 // INDEX(list, -1) is the last item.
			}
			if i < 1 || i > len(l) {
				return Fail("#REF!", fmt.Sprintf("INDEX: there's no item %d", int(n)))
			}
			return l[i-1]
		}, Help: "INDEX(list, n) is the nth item; -1 is the last"},
		"MATCH": {min: 2, max: 2, eager: func(_ Env, a []Value) Value {
			if err, bad := firstError(a); bad {
				return err
			}
			for i, v := range asList(a[1]) {
				if Compare(v, a[0]) == 0 {
					return Num(float64(i + 1))
				}
			}
			return Fail("#N/A", "MATCH didn't find "+quote(a[0]))
		}, Help: "MATCH(value, column) is the position of value in the column"},
		"XLOOKUP": {min: 3, max: 4, eager: func(_ Env, a []Value) Value {
			if err, bad := firstError(a[:3]); bad {
				return err
			}
			keys, vals := asList(a[1]), asList(a[2])
			if len(keys) != len(vals) {
				return Fail("#VALUE!", "XLOOKUP: the columns have different lengths")
			}
			return broadcastArgs(a[:1], func(k []Value) Value {
				for i, v := range keys {
					if Compare(v, k[0]) == 0 {
						return vals[i]
					}
				}
				if len(a) > 3 {
					return a[3]
				}
				return Fail("#N/A", "XLOOKUP didn't find "+quote(k[0]))
			})
		}, Help: `XLOOKUP(value, look in, return, [if missing]): XLOOKUP({Code}, [Rates/Code], [Rates/Rate])`},
		"FIRST": {min: 1, max: 1, eager: func(_ Env, a []Value) Value {
			l := flat(a)
			if len(l) == 0 {
				return Value{}
			}
			return l[0]
		}, Help: "FIRST(list) is the first item"},
		"LAST": {min: 1, max: 1, eager: func(_ Env, a []Value) Value {
			l := flat(a)
			if len(l) == 0 {
				return Value{}
			}
			return l[len(l)-1]
		}, Help: "LAST(list) is the last item"},
		"TEXTJOIN": {min: 3, max: -1, eager: func(e Env, a []Value) Value {
			if err, bad := firstError(a); bad {
				return err
			}
			skip := a[1].Truthy()
			var parts []string
			for _, v := range flat(a[2:]) {
				if skip && (v.K == Empty || v.String() == "") {
					continue
				}
				parts = append(parts, v.String())
			}
			return joined(e, parts, textArg(a[0]))
		}, Help: `TEXTJOIN(separator, skip blanks, values…): TEXTJOIN(", ", TRUE, [Name])`},
		"JOIN": {min: 2, max: -1, eager: func(e Env, a []Value) Value {
			if err, bad := firstError(a); bad {
				return err
			}
			var parts []string
			for _, v := range flat(a[1:]) {
				parts = append(parts, v.String())
			}
			return joined(e, parts, textArg(a[0]))
		}, Help: `JOIN(separator, values…)`},
		"SPLIT": {min: 2, max: 2, eager: func(_ Env, a []Value) Value {
			if err, bad := firstError(a); bad {
				return err
			}
			sep := textArg(a[1])
			if sep == "" {
				return Fail("#VALUE!", "SPLIT needs a separator")
			}
			out := []Value{}
			for _, p := range strings.Split(textArg(a[0]), sep) {
				if p = strings.TrimSpace(p); p != "" {
					out = append(out, Str(p))
				}
			}
			return Items(out)
		}, Help: `SPLIT(text, separator) makes a list`},

		// ── Text ──
		"CONCAT": {min: 1, max: -1, eager: func(e Env, a []Value) Value {
			if err, bad := firstError(a); bad {
				return err
			}
			var parts []string
			for _, v := range flat(a) {
				parts = append(parts, v.String())
			}
			return joined(e, parts, "")
		}, Help: "CONCAT(values…) joins text; & does the same: {First} & \" \" & {Last}"},
		"LEN":   {min: 1, max: 1, eager: text1(func(s string) Value { return Num(float64(utf8.RuneCountInString(s))) }), Help: "LEN(text) counts characters"},
		"UPPER": {min: 1, max: 1, eager: text1(func(s string) Value { return Str(strings.ToUpper(s)) }), Help: "UPPER(text)"},
		"LOWER": {min: 1, max: 1, eager: text1(func(s string) Value { return Str(strings.ToLower(s)) }), Help: "LOWER(text)"},
		"PROPER": {min: 1, max: 1, eager: text1(func(s string) Value {
			rs := []rune(strings.ToLower(s))
			for i := range rs {
				if i == 0 || !unicode.IsLetter(rs[i-1]) {
					rs[i] = unicode.ToUpper(rs[i])
				}
			}
			return Str(string(rs))
		}), Help: "PROPER(text) capitalises each word"},
		"TRIM": {min: 1, max: 1, eager: text1(func(s string) Value { return Str(strings.Join(strings.Fields(s), " ")) }), Help: "TRIM(text) removes extra spaces"},
		"LEFT": {min: 1, max: 2, eager: func(_ Env, a []Value) Value {
			return broadcastArgs(a, func(a []Value) Value {
				n := 1.0
				if len(a) > 1 {
					var err Value
					var ok bool
					if n, err, ok = numArg(a[1], "LEFT"); !ok {
						return err
					}
				}
				rs := []rune(textArg(a[0]))
				return Str(string(rs[:clamp(int(n), 0, len(rs))]))
			})
		}, Help: "LEFT(text, [count]) is the first characters"},
		"RIGHT": {min: 1, max: 2, eager: func(_ Env, a []Value) Value {
			return broadcastArgs(a, func(a []Value) Value {
				n := 1.0
				if len(a) > 1 {
					var err Value
					var ok bool
					if n, err, ok = numArg(a[1], "RIGHT"); !ok {
						return err
					}
				}
				rs := []rune(textArg(a[0]))
				return Str(string(rs[len(rs)-clamp(int(n), 0, len(rs)):]))
			})
		}, Help: "RIGHT(text, [count]) is the last characters"},
		"MID": {min: 3, max: 3, eager: func(_ Env, a []Value) Value {
			return broadcastArgs(a, func(a []Value) Value {
				start, err, ok := numArg(a[1], "MID")
				if !ok {
					return err
				}
				n, err, ok := numArg(a[2], "MID")
				if !ok {
					return err
				}
				rs := []rune(textArg(a[0]))
				from := clamp(int(start)-1, 0, len(rs))
				return Str(string(rs[from:clamp(from+int(n), from, len(rs))]))
			})
		}, Help: "MID(text, start, count)"},
		"SUBSTITUTE": {min: 3, max: 3, eager: func(_ Env, a []Value) Value {
			return broadcastArgs(a, func(a []Value) Value {
				if err, bad := firstError(a); bad {
					return err
				}
				if textArg(a[1]) == "" {
					return Str(textArg(a[0]))
				}
				return Str(strings.ReplaceAll(textArg(a[0]), textArg(a[1]), textArg(a[2])))
			})
		}, Help: "SUBSTITUTE(text, find, replace)"},
		"REPT": {min: 2, max: 2, eager: func(_ Env, a []Value) Value {
			n, err, ok := numArg(a[1], "REPT")
			if !ok {
				return err
			}
			s := textArg(a[0])
			if n < 0 || n > 10000 || int(n)*len(s) > 10000 {
				return Fail("#VALUE!", "REPT: too many repeats")
			}
			return Str(strings.Repeat(s, int(n)))
		}, Help: "REPT(text, times)"},
		"FIND": {min: 2, max: 2, eager: func(_ Env, a []Value) Value {
			i := strings.Index(textArg(a[1]), textArg(a[0]))
			if i < 0 {
				return Fail("#VALUE!", "FIND didn't find "+quote(a[0]))
			}
			return Num(float64(utf8.RuneCountInString(textArg(a[1])[:i]) + 1))
		}, Help: "FIND(find, text) is the position, matching case"},
		"SEARCH": {min: 2, max: 2, eager: func(_ Env, a []Value) Value {
			hay := strings.ToLower(textArg(a[1]))
			i := strings.Index(hay, strings.ToLower(textArg(a[0])))
			if i < 0 {
				return Fail("#VALUE!", "SEARCH didn't find "+quote(a[0]))
			}
			return Num(float64(utf8.RuneCountInString(hay[:i]) + 1))
		}, Help: "SEARCH(find, text) is the position, ignoring case"},
		"CONTAINS": {min: 2, max: 2, eager: func(_ Env, a []Value) Value {
			return broadcastArgs(a, func(a []Value) Value {
				return Boolean(strings.Contains(strings.ToLower(textArg(a[0])), strings.ToLower(textArg(a[1]))))
			})
		}, Help: `CONTAINS(text, find) is true when text includes find, ignoring case`},
		"EXACT": {min: 2, max: 2, eager: func(_ Env, a []Value) Value { return Boolean(textArg(a[0]) == textArg(a[1])) }, Help: "EXACT(a, b) compares text, matching case"},
		"VALUE": {min: 1, max: 1, eager: text1(func(s string) Value {
			if n, ok := ParseNumber(s); ok {
				return Num(n)
			}
			return Fail("#VALUE!", `"`+s+`" isn't a number`)
		}), Help: "VALUE(text) reads a number from text"},
		"TEXT": {min: 2, max: 2, eager: func(_ Env, a []Value) Value {
			return broadcastArgs(a, func(a []Value) Value {
				if err, bad := firstError(a); bad {
					return err
				}
				return Str(formatText(a[0], textArg(a[1])))
			})
		}, Help: `TEXT(value, format): TEXT({Amount}, "$#,##0.00"), TEXT({Date}, "mmm d, yyyy")`},
		"REGEXMATCH": {min: 2, max: 2, eager: func(_ Env, a []Value) Value {
			re, err, ok := regexArg(a[1])
			if !ok {
				return err
			}
			return broadcastArgs(a[:1], func(x []Value) Value { return Boolean(re.MatchString(textArg(x[0]))) })
		}, Help: `REGEXMATCH(text, pattern)`},
		"REGEXEXTRACT": {min: 2, max: 2, eager: func(_ Env, a []Value) Value {
			re, err, ok := regexArg(a[1])
			if !ok {
				return err
			}
			return broadcastArgs(a[:1], func(x []Value) Value {
				m := re.FindStringSubmatch(textArg(x[0]))
				switch {
				case m == nil:
					return Fail("#N/A", "REGEXEXTRACT found no match")
				case len(m) > 1:
					return Str(m[1])
				}
				return Str(m[0])
			})
		}, Help: `REGEXEXTRACT(text, pattern)`},
		"REGEXREPLACE": {min: 3, max: 3, eager: func(_ Env, a []Value) Value {
			re, err, ok := regexArg(a[1])
			if !ok {
				return err
			}
			return broadcastArgs(a[:1], func(x []Value) Value { return Str(re.ReplaceAllString(textArg(x[0]), textArg(a[2]))) })
		}, Help: `REGEXREPLACE(text, pattern, replacement)`},

		// ── Dates ──
		"TODAY": {min: 0, max: 0, eager: func(e Env, _ []Value) Value { return Day(e.Now) }, Help: "TODAY() is today's date"},
		"NOW":   {min: 0, max: 0, eager: func(e Env, _ []Value) Value { return Moment(e.Now) }, Help: "NOW() is the date and time"},
		"DATE": {min: 3, max: 3, eager: func(_ Env, a []Value) Value {
			var n [3]float64
			for i := range n {
				x, err, ok := numArg(a[i], "DATE")
				if !ok {
					return err
				}
				n[i] = x
			}
			return Day(time.Date(int(n[0]), time.Month(int(n[1])), int(n[2]), 0, 0, 0, 0, time.UTC))
		}, Help: "DATE(year, month, day)"},
		"DATEVALUE": {min: 1, max: 1, eager: text1(func(s string) Value {
			if d, ok := ParseDate(s); ok {
				return d
			}
			return Fail("#VALUE!", `"`+s+`" isn't a date`)
		}), Help: "DATEVALUE(text) reads a date"},
		"YEAR":    {min: 1, max: 1, eager: date1("YEAR", func(d Value) Value { return Num(float64(d.T.Year())) }), Help: "YEAR(date)"},
		"MONTH":   {min: 1, max: 1, eager: date1("MONTH", func(d Value) Value { return Num(float64(d.T.Month())) }), Help: "MONTH(date) is 1 to 12"},
		"DAY":     {min: 1, max: 1, eager: date1("DAY", func(d Value) Value { return Num(float64(d.T.Day())) }), Help: "DAY(date) is the day of the month"},
		"HOUR":    {min: 1, max: 1, eager: date1("HOUR", func(d Value) Value { return Num(float64(d.T.Hour())) }), Help: "HOUR(date)"},
		"MINUTE":  {min: 1, max: 1, eager: date1("MINUTE", func(d Value) Value { return Num(float64(d.T.Minute())) }), Help: "MINUTE(date)"},
		"WEEKDAY": {min: 1, max: 1, eager: date1("WEEKDAY", func(d Value) Value { return Num(float64(d.T.Weekday()) + 1) }), Help: "WEEKDAY(date) is 1 (Sunday) to 7 (Saturday)"},
		"ISOWEEKNUM": {min: 1, max: 1, eager: date1("ISOWEEKNUM", func(d Value) Value {
			_, w := d.T.ISOWeek()
			return Num(float64(w))
		}), Help: "ISOWEEKNUM(date) is the ISO week of the year"},
		"DAYS": {min: 2, max: 2, eager: func(_ Env, a []Value) Value {
			end, err, ok := dateArg(a[0], "DAYS")
			if !ok {
				return err
			}
			start, err, ok := dateArg(a[1], "DAYS")
			if !ok {
				return err
			}
			return Num(math.Round(serial(Day(end.T).T) - serial(Day(start.T).T)))
		}, Help: "DAYS(end, start) is the number of days between"},
		"DATEDIF": {min: 3, max: 3, eager: func(_ Env, a []Value) Value {
			start, err, ok := dateArg(a[0], "DATEDIF")
			if !ok {
				return err
			}
			end, err, ok := dateArg(a[1], "DATEDIF")
			if !ok {
				return err
			}
			if end.T.Before(start.T) {
				return Fail("#NUM!", "DATEDIF: the end is before the start")
			}
			months := (end.T.Year()-start.T.Year())*12 + int(end.T.Month()-start.T.Month())
			if end.T.Day() < start.T.Day() {
				months--
			}
			switch strings.ToUpper(textArg(a[2])) {
			case "D":
				return Num(math.Floor(serial(end.T) - serial(start.T)))
			case "M":
				return Num(float64(months))
			case "Y":
				return Num(float64(months / 12))
			}
			return Fail("#NUM!", `DATEDIF's unit is "D", "M" or "Y"`)
		}, Help: `DATEDIF(start, end, unit): whole "D"ays, "M"onths or "Y"ears between`},
		"EDATE": {min: 2, max: 2, eager: func(_ Env, a []Value) Value {
			d, err, ok := dateArg(a[0], "EDATE")
			if !ok {
				return err
			}
			n, err, ok := numArg(a[1], "EDATE")
			if !ok {
				return err
			}
			return dateLike(d, addMonths(d.T, int(n)))
		}, Help: "EDATE(date, months) moves a date by whole months"},
		"EOMONTH": {min: 2, max: 2, eager: func(_ Env, a []Value) Value {
			d, err, ok := dateArg(a[0], "EOMONTH")
			if !ok {
				return err
			}
			n, err, ok := numArg(a[1], "EOMONTH")
			if !ok {
				return err
			}
			first := time.Date(d.T.Year(), d.T.Month()+time.Month(int(n))+1, 1, 0, 0, 0, 0, time.UTC)
			return Day(first.AddDate(0, 0, -1))
		}, Help: "EOMONTH(date, months) is the last day of the month, months away"},
		"NETWORKDAYS": {min: 2, max: 2, eager: func(_ Env, a []Value) Value {
			start, err, ok := dateArg(a[0], "NETWORKDAYS")
			if !ok {
				return err
			}
			end, err, ok := dateArg(a[1], "NETWORKDAYS")
			if !ok {
				return err
			}
			sign := 1.0
			s, t := Day(start.T).T, Day(end.T).T
			if t.Before(s) {
				s, t, sign = t, s, -1
			}
			if serial(t)-serial(s) > 100*366 {
				return Fail("#NUM!", "NETWORKDAYS: the range is too long")
			}
			n := 0
			for d := s; !d.After(t); d = d.AddDate(0, 0, 1) {
				if !isWeekend(d) {
					n++
				}
			}
			return Num(sign * float64(n))
		}, Help: "NETWORKDAYS(start, end) counts weekdays, both ends included"},
		"WORKDAY": {min: 2, max: 2, eager: func(_ Env, a []Value) Value {
			d, err, ok := dateArg(a[0], "WORKDAY")
			if !ok {
				return err
			}
			n, err, ok := numArg(a[1], "WORKDAY")
			if !ok {
				return err
			}
			if math.Abs(n) > 100000 {
				return Fail("#NUM!", "WORKDAY: too many days")
			}
			t, step := Day(d.T).T, 1
			if n < 0 {
				step = -1
			}
			for left := int(math.Abs(n)); left > 0; {
				t = t.AddDate(0, 0, step)
				if !isWeekend(t) {
					left--
				}
			}
			return Day(t)
		}, Help: "WORKDAY(date, days) moves a date by weekdays"},
	}
	funcs["AVG"] = withHelp(funcs["AVERAGE"], "")
	funcs["CONCATENATE"] = withHelp(funcs["CONCAT"], "")
	for _, name := range []string{"INT", "ABS", "SQRT", "SIGN", "LN", "EXP", "PI"} {
		f := funcs[name]
		f.Help = name + "(number)"
		if name == "PI" {
			f.Help = "PI() is 3.14159…"
		}
		funcs[name] = f
	}
}

// maxJoined caps the text a joining function may build, and joined charges
// the step budget for it, so a join over a whole column in every row can't
// use up the server's memory.
const maxJoined = 1 << 20

func joined(e Env, parts []string, sep string) Value {
	n := len(sep) * max(len(parts)-1, 0)
	for _, p := range parts {
		n += len(p)
	}
	if n > maxJoined {
		return Fail("#VALUE!", "the joined text is too long")
	}
	if !e.spend(len(parts) + n/64) {
		return errBudget
	}
	return Str(strings.Join(parts, sep))
}

func withHelp(f fn, help string) fn {
	f.Help = help
	return f
}

func clamp(n, lo, hi int) int { return max(lo, min(n, hi)) }

// formatText is a small subset of spreadsheet number and date formats:
// 0, 0.00, #,##0.00, 0%, $ and other literal text around them; and for
// dates yyyy, yy, mmmm, mmm, mm, m, dddd, ddd, dd, d, hh, h, mm (minutes
// after an hour) and AM/PM.
func formatText(v Value, f string) string {
	if v.K == Text {
		if d, ok := ParseDate(v.S); ok {
			v = d
		} else if n, ok := ParseNumber(v.S); ok {
			v = Num(n)
		} else {
			return v.S
		}
	}
	if v.K == Date {
		return formatDate(v.T, f)
	}
	n, ok := v.AsNumber()
	if !ok {
		return v.String()
	}
	start := strings.IndexAny(f, "0#")
	if start < 0 {
		return f
	}
	end := strings.LastIndexAny(f, "0#.,") + 1
	prefix, pattern, suffix := f[:start], f[start:end], f[end:]
	if strings.Contains(suffix, "%") {
		n *= 100
	}
	decimals := 0
	if i := strings.Index(pattern, "."); i >= 0 {
		decimals = strings.Count(pattern[i:], "0") + strings.Count(pattern[i:], "#")
	}
	neg := n < 0
	s := strconv.FormatFloat(math.Abs(roundTo(n, decimals, roundHalfAway)), 'f', decimals, 64)
	if strings.Contains(pattern, ",") {
		whole, frac, _ := strings.Cut(s, ".")
		var b strings.Builder
		for i, r := range whole {
			if i > 0 && (len(whole)-i)%3 == 0 {
				b.WriteByte(',')
			}
			b.WriteRune(r)
		}
		s = b.String()
		if frac != "" {
			s += "." + frac
		}
	}
	if neg {
		s = "-" + s
	}
	return prefix + s + suffix
}

func formatDate(t time.Time, f string) string {
	var b strings.Builder
	afterHour := false
	ampm := strings.Contains(strings.ToUpper(f), "AM/PM")
	for i := 0; i < len(f); {
		rest := f[i:]
		low := strings.ToLower(rest)
		take := func(tok, out string) bool {
			if strings.HasPrefix(low, tok) {
				b.WriteString(out)
				i += len(tok)
				return true
			}
			return false
		}
		hour := t.Hour()
		if ampm {
			hour = hour % 12
			if hour == 0 {
				hour = 12
			}
		}
		switch {
		case strings.HasPrefix(strings.ToUpper(rest), "AM/PM"):
			if t.Hour() < 12 {
				b.WriteString("AM")
			} else {
				b.WriteString("PM")
			}
			i += 5
		case take("yyyy", t.Format("2006")), take("yy", t.Format("06")):
		case take("hh", fmt.Sprintf("%02d", hour)):
			afterHour = true
		case take("h", strconv.Itoa(hour)):
			afterHour = true
		case afterHour && take("mm", t.Format("04")):
			afterHour = false
		case take("ss", t.Format("05")):
		case take("mmmm", t.Format("January")), take("mmm", t.Format("Jan")), take("mm", t.Format("01")), take("m", strconv.Itoa(int(t.Month()))):
		case take("dddd", t.Format("Monday")), take("ddd", t.Format("Mon")), take("dd", t.Format("02")), take("d", strconv.Itoa(t.Day())):
		default:
			r, size := utf8.DecodeRuneInString(rest)
			b.WriteRune(r)
			if r != ':' && r != ' ' {
				afterHour = false
			}
			i += size
		}
	}
	return b.String()
}

// Call runs a function on values that are already worked out, for callers
// like rollups that combine values without a formula.
func Call(name string, args ...Value) Value {
	f, ok := funcs[name]
	if !ok || f.eager == nil {
		return Fail("#NAME?", "there's no function called "+name)
	}
	return f.eager(Env{}, args)
}
