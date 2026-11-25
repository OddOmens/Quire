package table

import (
	"strings"
	"time"

	"github.com/oddomens/quire/internal/formula"
)

// Source opens other databases for relations, rollups and formulas that
// name them. target is a page link as written ([Expenses/Amount]) or a
// relation's stored page path; from is the page asking. It returns the
// table and its page path.
type Source interface {
	Open(from, target string) (*Table, string, error)
}

// Result is a table with its computed columns worked out.
type Result struct {
	Path  string
	Table *Table
	// Values holds formula, rollup and created-time values by row id, then
	// column id.
	Values map[string]map[string]formula.Value
	// Errors explains columns that can't be worked out at all, such as a
	// formula with a typo.
	Errors map[string]string
	// Related names the rows each relation column links to: column id, then
	// row id, then that row's title.
	Related map[string]map[string]string
	// Targets is the page path each relation column links to, as found.
	Targets map[string]string

	lists map[string]formula.Value
	done  map[string]bool
}

// Computer works out computed columns, opening related databases at most
// once and sharing one step budget across them all.
type Computer struct {
	src   Source
	env   formula.Env
	loc   *time.Location
	done  map[string]*Result
	busy  map[string]bool
	plain map[string]*Table
}

// NewComputer prepares a computation for a user whose clock reads now in
// loc. src may be nil when no other database will be needed.
func NewComputer(src Source, now time.Time, loc *time.Location) *Computer {
	if loc == nil {
		loc = time.UTC
	}
	return &Computer{
		src:   src,
		env:   formula.NewEnv(nil, now.In(loc)),
		loc:   loc,
		done:  map[string]*Result{},
		busy:  map[string]bool{},
		plain: map[string]*Table{},
	}
}

func (c *Computer) open(from, target string) (*Table, string, bool) {
	if c.src == nil {
		return nil, "", false
	}
	t, p, err := c.src.Open(from, target)
	if err != nil || t == nil {
		return nil, "", false
	}
	if cached, ok := c.plain[p]; ok {
		return cached, p, true
	}
	c.plain[p] = t
	return t, p, true
}

// Compute works out a table's computed columns. path is its page path.
func (c *Computer) Compute(path string, t *Table) *Result {
	if r, ok := c.done[path]; ok {
		return r
	}
	c.plain[path] = t
	c.busy[path] = true
	defer delete(c.busy, path)
	res := &Result{
		Path:    path,
		Table:   t,
		Values:  make(map[string]map[string]formula.Value, len(t.Rows)),
		Errors:  map[string]string{},
		Related: map[string]map[string]string{},
		Targets: map[string]string{},
		lists:   map[string]formula.Value{},
		done:    map[string]bool{},
	}
	for _, r := range t.Rows {
		res.Values[r.ID] = map[string]formula.Value{}
	}

	// Relations: the titles of linked rows, for chips and for formulas.
	for _, col := range t.Schema.Columns {
		if col.Type != Relation || col.Target == "" {
			continue
		}
		other, p, ok := c.open(path, col.Target)
		if !ok {
			res.Errors[col.ID] = "the database this links to is gone"
			continue
		}
		res.Targets[col.ID] = p
		titles := map[string]string{}
		byID := make(map[string]Row, len(other.Rows))
		for _, r := range other.Rows {
			byID[r.ID] = r
		}
		for _, r := range t.Rows {
			for _, id := range RelationIDs(r.Cells[col.ID]) {
				if or, ok := byID[id]; ok {
					titles[id] = other.Title(or)
				}
			}
		}
		res.Related[col.ID] = titles
	}

	// Parse formulas and order computed columns so each comes after the
	// columns it reads.
	nodes := map[string]formula.Node{}
	deps := map[string][]string{}
	var computed []string
	for _, col := range t.Schema.Columns {
		switch col.Type {
		case Formula:
			computed = append(computed, col.ID)
			if strings.TrimSpace(col.Formula) == "" {
				continue
			}
			n, err := formula.Parse(col.Formula)
			if err != nil {
				res.Errors[col.ID] = err.Error()
				continue
			}
			nodes[col.ID] = n
			refs := formula.RefsOf(n)
			names := refs.Fields
			for _, cr := range refs.Columns {
				if cr[0] == "" {
					names = append(names, cr[1])
				}
			}
			for _, name := range names {
				if d := t.ColumnNamed(name); d != nil && !Stored(d.Type) {
					deps[col.ID] = append(deps[col.ID], d.ID)
				}
			}
		case Rollup, Created:
			computed = append(computed, col.ID)
		}
	}
	order, cyclic := topo(computed, deps)
	for _, id := range cyclic {
		res.Errors[id] = "this formula depends on itself, through the columns it names"
	}

	for _, id := range order {
		col := t.Column(id)
		switch col.Type {
		case Created:
			for _, r := range t.Rows {
				if ts, err := time.Parse(time.RFC3339, r.Created); err == nil {
					res.Values[r.ID][id] = formula.Moment(ts.In(c.loc))
				}
			}
		case Rollup:
			c.rollup(res, col)
		case Formula:
			n, ok := nodes[id]
			if !ok {
				continue
			}
			for _, r := range t.Rows {
				env := c.env
				env.Ctx = rowCtx{c: c, res: res, row: r}
				v := formula.Eval(n, env)
				if v.K == formula.List && col.Format != "" && col.Format != "text" && len(v.L) == 1 {
					v = v.L[0]
				}
				res.Values[r.ID][id] = v
			}
		}
		res.done[id] = true
	}
	c.done[path] = res
	return res
}

// topo orders ids so each follows its dependencies; ids caught in a cycle
// come back separately.
func topo(ids []string, deps map[string][]string) (order, cyclic []string) {
	state := map[string]int{} // 1 visiting, 2 done, 3 cyclic
	var visit func(id string) bool
	visit = func(id string) bool {
		switch state[id] {
		case 1, 3:
			return false
		case 2:
			return true
		}
		state[id] = 1
		ok := true
		for _, d := range deps[id] {
			if !visit(d) {
				ok = false
			}
		}
		if !ok {
			state[id] = 3
			cyclic = append(cyclic, id)
			return false
		}
		state[id] = 2
		order = append(order, id)
		return true
	}
	for _, id := range ids {
		visit(id)
	}
	return order, cyclic
}

// value is one row's value of a column, typed for formulas.
func (c *Computer) value(res *Result, col *Column, r Row) formula.Value {
	switch col.Type {
	case Formula, Rollup, Created:
		if !res.done[col.ID] {
			if msg, ok := res.Errors[col.ID]; ok {
				return formula.Fail("#REF!", col.Name+": "+msg)
			}
			return formula.Fail("#CYCLE!", "{"+col.Name+"} depends on this column")
		}
		return res.Values[r.ID][col.ID]
	case Relation:
		titles := res.Related[col.ID]
		out := []formula.Value{}
		for _, id := range RelationIDs(r.Cells[col.ID]) {
			if t, ok := titles[id]; ok {
				out = append(out, formula.Str(t))
			}
		}
		return formula.Items(out)
	}
	return Typed(col, r.Cells[col.ID])
}

// list is every row's value of a column, built once.
func (c *Computer) list(res *Result, col *Column) formula.Value {
	if v, ok := res.lists[col.ID]; ok && (Stored(col.Type) || res.done[col.ID]) {
		return v
	}
	out := make([]formula.Value, len(res.Table.Rows))
	for i, r := range res.Table.Rows {
		out[i] = c.value(res, col, r)
	}
	v := formula.Items(out)
	if Stored(col.Type) || res.done[col.ID] {
		res.lists[col.ID] = v
	}
	return v
}

func (c *Computer) rollup(res *Result, col *Column) {
	t := res.Table
	rel := t.Column(col.Relation)
	if rel == nil || rel.Type != Relation {
		res.Errors[col.ID] = "choose a relation column to roll up"
		return
	}
	if rel.Target == "" {
		res.Errors[col.ID] = "the relation column doesn't link to a database yet"
		return
	}
	other, p, ok := c.open(res.Path, rel.Target)
	if !ok {
		res.Errors[col.ID] = "the database this links to is gone"
		return
	}
	if c.busy[p] && p != res.Path {
		res.Errors[col.ID] = "these databases roll up from each other in a loop"
		return
	}
	var ores *Result
	if p == res.Path {
		ores = res // a table related to itself
	} else {
		ores = c.Compute(p, other)
	}
	field := other.Column(col.Field)
	if field == nil {
		field = other.Primary()
	}
	if field.ID == col.ID && p == res.Path {
		res.Errors[col.ID] = "a rollup can't read itself"
		return
	}
	byID := make(map[string]Row, len(other.Rows))
	for _, r := range other.Rows {
		byID[r.ID] = r
	}
	for _, r := range t.Rows {
		var items []formula.Value
		for _, id := range RelationIDs(r.Cells[rel.ID]) {
			if or, ok := byID[id]; ok {
				v := c.value(ores, field, or)
				if v.K == formula.List {
					items = append(items, v.L...)
				} else {
					items = append(items, v)
				}
			}
		}
		res.Values[r.ID][col.ID] = Aggregate(col.Aggregate, items)
	}
}

// Aggregate combines a rollup's values: "show" (the default) lists them,
// the rest count, total or summarise them.
func Aggregate(how string, items []formula.Value) formula.Value {
	if items == nil {
		items = []formula.Value{}
	}
	l := formula.Items(items)
	switch how {
	case "count":
		return formula.Num(float64(len(items)))
	case "filled":
		return formula.Call("COUNTA", l)
	case "unique":
		return formula.Call("COUNTUNIQUE", l)
	case "sum":
		return formula.Call("SUM", l)
	case "avg":
		if len(items) == 0 {
			return formula.Value{}
		}
		return formula.Call("AVERAGE", l)
	case "min", "max":
		var best formula.Value
		for _, v := range items {
			if v.K == formula.Empty {
				continue
			}
			c := formula.Compare(v, best)
			if best.K == formula.Empty || (how == "min" && c < 0) || (how == "max" && c > 0) {
				best = v
			}
		}
		return best
	case "checked":
		n := 0
		for _, v := range items {
			if v.Truthy() {
				n++
			}
		}
		return formula.Num(float64(n))
	case "percent":
		if len(items) == 0 {
			return formula.Value{}
		}
		n := 0
		for _, v := range items {
			if v.Truthy() {
				n++
			}
		}
		return formula.Num(float64(n) / float64(len(items)))
	}
	return l
}

type rowCtx struct {
	c   *Computer
	res *Result
	row Row
}

func (x rowCtx) Field(name string) formula.Value {
	col := x.res.Table.ColumnNamed(name)
	if col == nil {
		return formula.Fail("#REF!", "there's no column called "+name)
	}
	return x.c.value(x.res, col, x.row)
}

func (x rowCtx) Column(table, name string) formula.Value {
	return x.c.Column(x.res, table, name)
}

// Column is [Name] or [Table/Name] as seen from res.
func (c *Computer) Column(res *Result, table, name string) formula.Value {
	if table == "" {
		if res == nil {
			return formula.Fail("#REF!", "write ["+name+"] as [Database/"+name+"] on a page")
		}
		col := res.Table.ColumnNamed(name)
		if col == nil {
			return formula.Fail("#REF!", "there's no column called "+name)
		}
		return c.list(res, col)
	}
	from := ""
	if res != nil {
		from = res.Path
	}
	other, p, ok := c.open(from, table)
	if !ok {
		return formula.Fail("#REF!", "there's no database called "+table)
	}
	if c.busy[p] && (res == nil || p != res.Path) {
		return formula.Fail("#CYCLE!", table+" reads this database too")
	}
	ores := res
	if res == nil || p != res.Path {
		ores = c.Compute(p, other)
	}
	col := other.ColumnNamed(name)
	if col == nil {
		return formula.Fail("#REF!", table+" has no column called "+name)
	}
	return c.list(ores, col)
}

// PageContext evaluates {{ … }} formulas on an ordinary page, where [Name]
// must name its database: [Expenses/Amount]. If the page is itself a
// database, res is its result and [Amount] works too.
type PageContext struct {
	C    *Computer
	Res  *Result
	Path string
}

func (x PageContext) Field(name string) formula.Value {
	return formula.Fail("#REF!", "{"+name+"} only works inside a database; use [Database/"+name+"] for a column")
}

func (x PageContext) Column(table, name string) formula.Value {
	if x.Res == nil && table != "" {
		// Resolve links from the page itself.
		other, p, ok := x.C.open(x.Path, table)
		if !ok {
			return formula.Fail("#REF!", "there's no database called "+table)
		}
		ores := x.C.Compute(p, other)
		col := other.ColumnNamed(name)
		if col == nil {
			return formula.Fail("#REF!", table+" has no column called "+name)
		}
		return x.C.list(ores, col)
	}
	return x.C.Column(x.Res, table, name)
}

// Eval evaluates a formula with this computer's clock and budget.
func (c *Computer) Eval(n formula.Node, ctx formula.Context) formula.Value {
	env := c.env
	env.Ctx = ctx
	return formula.Eval(n, env)
}
