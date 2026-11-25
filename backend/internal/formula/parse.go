package formula

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// Node is a parsed formula.
type Node interface{ node() }

type (
	numLit  struct{ v float64 }
	strLit  struct{ v string }
	boolLit struct{ v bool }
	// field is {Name}: this row's value of a column.
	field struct{ name string }
	// column is [Name], or [Table/Name] for another database: every row's
	// value of a column, as a list.
	column  struct{ table, name string }
	unary   struct{ x Node }
	percent struct{ x Node }
	binary  struct {
		op   string
		l, r Node
	}
	call struct {
		name string
		args []Node
	}
)

func (numLit) node()  {}
func (strLit) node()  {}
func (boolLit) node() {}
func (field) node()   {}
func (column) node()  {}
func (unary) node()   {}
func (percent) node() {}
func (binary) node()  {}
func (call) node()    {}

// SyntaxError says what's wrong with a formula and where.
type SyntaxError struct {
	Pos int
	Msg string
}

func (e *SyntaxError) Error() string { return e.Msg }

type token struct {
	kind string // num, str, field, column, ident, op, (, ), ",", eof
	text string
	pos  int
}

// MaxLength caps a formula's source, which also caps its parse depth.
const MaxLength = 4000

func lex(src string) ([]token, error) {
	var out []token
	rs := []rune(src)
	for i := 0; i < len(rs); {
		r := rs[i]
		switch {
		case unicode.IsSpace(r):
			i++
		case unicode.IsDigit(r) || (r == '.' && i+1 < len(rs) && unicode.IsDigit(rs[i+1])):
			j := i
			for j < len(rs) && (unicode.IsDigit(rs[j]) || rs[j] == '.') {
				j++
			}
			if j < len(rs) && (rs[j] == 'e' || rs[j] == 'E') {
				k := j + 1
				if k < len(rs) && (rs[k] == '+' || rs[k] == '-') {
					k++
				}
				if k < len(rs) && unicode.IsDigit(rs[k]) {
					for k < len(rs) && unicode.IsDigit(rs[k]) {
						k++
					}
					j = k
				}
			}
			out = append(out, token{"num", string(rs[i:j]), i})
			i = j
		case r == '"' || r == '\'' || r == '“' || r == '”':
			closeQ := r
			if r == '“' {
				closeQ = '”'
			}
			var b strings.Builder
			j := i + 1
			for {
				if j >= len(rs) {
					return nil, &SyntaxError{i, "a piece of text is missing its closing quote"}
				}
				if rs[j] == closeQ || (closeQ == '”' && rs[j] == '"') {
					// A doubled quote is a quote inside the text.
					if j+1 < len(rs) && rs[j+1] == rs[j] {
						b.WriteRune(rs[j])
						j += 2
						continue
					}
					break
				}
				b.WriteRune(rs[j])
				j++
			}
			out = append(out, token{"str", b.String(), i})
			i = j + 1
		case r == '{' || r == '[':
			closeB := '}'
			kind := "field"
			if r == '[' {
				closeB, kind = ']', "column"
			}
			j := i + 1
			for j < len(rs) && rs[j] != closeB {
				j++
			}
			if j >= len(rs) {
				return nil, &SyntaxError{i, fmt.Sprintf("%c is missing its closing %c", r, closeB)}
			}
			name := strings.TrimSpace(string(rs[i+1 : j]))
			if name == "" {
				return nil, &SyntaxError{i, fmt.Sprintf("%c%c needs a column name inside", r, closeB)}
			}
			out = append(out, token{kind, name, i})
			i = j + 1
		case unicode.IsLetter(r) || r == '_':
			j := i
			for j < len(rs) && (unicode.IsLetter(rs[j]) || unicode.IsDigit(rs[j]) || rs[j] == '_' || rs[j] == '.') {
				j++
			}
			out = append(out, token{"ident", string(rs[i:j]), i})
			i = j
		case r == '(' || r == ')' || r == ',' || r == ';':
			t := string(r)
			if r == ';' {
				t = "," // Some locales separate arguments with semicolons.
			}
			out = append(out, token{t, t, i})
			i++
		default:
			two := ""
			if i+1 < len(rs) {
				two = string(rs[i : i+2])
			}
			switch two {
			case "<=", ">=", "<>", "!=", "==", "&&", "||":
				out = append(out, token{"op", two, i})
				i += 2
				continue
			}
			if strings.ContainsRune("+-*/^&=<>%≤≥≠×÷", r) {
				t := string(r)
				switch r {
				case '≤':
					t = "<="
				case '≥':
					t = ">="
				case '≠':
					t = "<>"
				case '×':
					t = "*"
				case '÷':
					t = "/"
				}
				out = append(out, token{"op", t, i})
				i++
				continue
			}
			return nil, &SyntaxError{i, fmt.Sprintf("%q isn't something a formula can use", string(r))}
		}
	}
	return append(out, token{"eof", "", len(rs)}), nil
}

type parser struct {
	toks  []token
	i     int
	depth int
}

// Parse reads a formula. A leading "=" is optional.
func Parse(src string) (Node, error) {
	if len(src) > MaxLength {
		return nil, &SyntaxError{0, "this formula is too long"}
	}
	src = strings.TrimSpace(src)
	src = strings.TrimPrefix(src, "=")
	if strings.TrimSpace(src) == "" {
		return nil, &SyntaxError{0, "the formula is empty"}
	}
	toks, err := lex(src)
	if err != nil {
		return nil, err
	}
	p := &parser{toks: toks}
	n, err := p.expr(0)
	if err != nil {
		return nil, err
	}
	if t := p.peek(); t.kind != "eof" {
		return nil, &SyntaxError{t.pos, fmt.Sprintf("didn't expect %q here", t.text)}
	}
	return n, nil
}

func (p *parser) peek() token { return p.toks[p.i] }
func (p *parser) next() token {
	t := p.toks[p.i]
	if p.i < len(p.toks)-1 {
		p.i++
	}
	return t
}

// Binding powers, lowest first, as in Sheets: comparison, &, + -, * /, ^.
func infix(op string) (int, bool) {
	switch op {
	case "||":
		return 1, true
	case "&&":
		return 2, true
	case "=", "==", "<>", "!=", "<", ">", "<=", ">=":
		return 3, true
	case "&":
		return 4, true
	case "+", "-":
		return 5, true
	case "*", "/":
		return 6, true
	case "^":
		return 7, true
	}
	return 0, false
}

func (p *parser) expr(minBP int) (Node, error) {
	p.depth++
	defer func() { p.depth-- }()
	if p.depth > 200 {
		return nil, &SyntaxError{p.peek().pos, "this formula nests too deeply"}
	}
	left, err := p.prefix()
	if err != nil {
		return nil, err
	}
	for {
		t := p.peek()
		if t.kind == "op" && t.text == "%" {
			p.next()
			left = percent{left}
			continue
		}
		if t.kind != "op" {
			return left, nil
		}
		bp, ok := infix(t.text)
		if !ok || bp <= minBP {
			return left, nil
		}
		p.next()
		next := bp
		if t.text == "^" {
			next = bp - 1 // right-associative
		}
		right, err := p.expr(next)
		if err != nil {
			return nil, err
		}
		op := t.text
		switch op {
		case "==":
			op = "="
		case "!=":
			op = "<>"
		}
		left = binary{op, left, right}
	}
}

func (p *parser) prefix() (Node, error) {
	t := p.next()
	switch t.kind {
	case "num":
		n, err := strconv.ParseFloat(t.text, 64)
		if err != nil {
			return nil, &SyntaxError{t.pos, fmt.Sprintf("%q isn't a number", t.text)}
		}
		return numLit{n}, nil
	case "str":
		return strLit{t.text}, nil
	case "field":
		return field{t.text}, nil
	case "column":
		name := t.text
		table := ""
		if i := strings.LastIndex(name, "/"); i >= 0 {
			table, name = strings.TrimSpace(name[:i]), strings.TrimSpace(name[i+1:])
			if table == "" || name == "" {
				return nil, &SyntaxError{t.pos, "write another database's column as [Database/Column]"}
			}
		}
		return column{table, name}, nil
	case "op":
		switch t.text {
		case "-":
			// Tighter than ^, as in Sheets: -2^2 is 4.
			x, err := p.expr(7)
			if err != nil {
				return nil, err
			}
			return unary{x}, nil
		case "+":
			return p.expr(7)
		}
	case "(":
		n, err := p.expr(0)
		if err != nil {
			return nil, err
		}
		if c := p.next(); c.kind != ")" {
			return nil, &SyntaxError{c.pos, "a ( is missing its )"}
		}
		return n, nil
	case "ident":
		up := strings.ToUpper(t.text)
		if p.peek().kind == "(" {
			p.next()
			var args []Node
			if p.peek().kind == ")" {
				p.next()
				return call{up, args}, nil
			}
			for {
				a, err := p.expr(0)
				if err != nil {
					return nil, err
				}
				args = append(args, a)
				c := p.next()
				if c.kind == ")" {
					break
				}
				if c.kind != "," {
					return nil, &SyntaxError{c.pos, fmt.Sprintf("%s( is missing a comma or its )", up)}
				}
			}
			return call{up, args}, nil
		}
		switch up {
		case "TRUE":
			return boolLit{true}, nil
		case "FALSE":
			return boolLit{false}, nil
		}
		return nil, &SyntaxError{t.pos, fmt.Sprintf("%q isn't known; put column names in {braces}, like {%s}, and text in \"quotes\"", t.text, t.text)}
	case "eof":
		return nil, &SyntaxError{t.pos, "the formula ends too soon"}
	}
	return nil, &SyntaxError{t.pos, fmt.Sprintf("didn't expect %q here", t.text)}
}

// Refs lists the columns a formula reads: fields ({Name}) and columns
// ([Name] or [Table/Name]).
type Refs struct {
	Fields  []string
	Columns [][2]string // table, name
}

func RefsOf(n Node) Refs {
	var r Refs
	var walk func(Node)
	walk = func(n Node) {
		switch x := n.(type) {
		case field:
			r.Fields = append(r.Fields, x.name)
		case column:
			r.Columns = append(r.Columns, [2]string{x.table, x.name})
		case unary:
			walk(x.x)
		case percent:
			walk(x.x)
		case binary:
			walk(x.l)
			walk(x.r)
		case call:
			for _, a := range x.args {
				walk(a)
			}
		}
	}
	walk(n)
	return r
}

// Rename rewrites references to a column in a formula's source, keeping
// everything else as written. table is "" for this database.
func Rename(src, table, from, to string) string {
	toks, err := lex(strings.TrimPrefix(strings.TrimSpace(src), "="))
	if err != nil {
		return src
	}
	// lex positions are relative to the trimmed source; find where it starts.
	lead := len([]rune(src)) - len([]rune(strings.TrimLeftFunc(src, unicode.IsSpace)))
	if strings.HasPrefix(strings.TrimSpace(src), "=") {
		lead++
	}
	rs := []rune(src)
	var b strings.Builder
	last := 0
	for _, t := range toks {
		start := lead + t.pos
		switch t.kind {
		case "field":
			if table == "" && strings.EqualFold(t.text, from) {
				end := indexRune(rs, start, '}')
				b.WriteString(string(rs[last:start]))
				b.WriteString("{" + to + "}")
				last = end + 1
			}
		case "column":
			name, tbl := t.text, ""
			if i := strings.LastIndex(name, "/"); i >= 0 {
				tbl, name = strings.TrimSpace(name[:i]), strings.TrimSpace(name[i+1:])
			}
			if strings.EqualFold(tbl, table) && strings.EqualFold(name, from) {
				end := indexRune(rs, start, ']')
				b.WriteString(string(rs[last:start]))
				if tbl != "" {
					b.WriteString("[" + tbl + "/" + to + "]")
				} else {
					b.WriteString("[" + to + "]")
				}
				last = end + 1
			}
		}
	}
	b.WriteString(string(rs[last:]))
	return b.String()
}

func indexRune(rs []rune, from int, r rune) int {
	for i := from; i < len(rs); i++ {
		if rs[i] == r {
			return i
		}
	}
	return len(rs) - 1
}
