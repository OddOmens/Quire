package vault

import (
	"reflect"
	"testing"
)

func TestTasks(t *testing.T) {
	got := Tasks("---\ntags: [x]\n---\n" + `- [ ] Before any heading
# Known **issues**

- [ ] Fix the [[Sync design|sync]] race in ` + "`save()`" + `
- [x] Already done
  - [ ] Child of a done item
    * [ ] Grandchild, *emphasised*
- [ ] Back at the top, see [docs](https://example.com) \#1
-  [ ]
Not a list: [ ] here

## Follow-ups #2 ##
` + "```md" + `
- [ ] inside a code block
` + "```" + `
1. [ ] Numbered
	- [ ] Tab-indented
> - [ ] Quoted, with snake_case_name and _stress_
- [] not a task
- [X] done too
`)
	want := []Task{
		{Line: 4, Text: "Before any heading"},
		{Line: 7, Text: "Fix the sync race in save()", Heading: "Known issues"},
		{Line: 9, Text: "Child of a done item", Heading: "Known issues", Depth: 1},
		{Line: 10, Text: "Grandchild, emphasised", Heading: "Known issues", Depth: 2},
		{Line: 11, Text: "Back at the top, see docs #1", Heading: "Known issues"},
		{Line: 19, Text: "Numbered", Heading: "Follow-ups #2"},
		{Line: 20, Text: "Tab-indented", Heading: "Follow-ups #2", Depth: 1},
		{Line: 21, Text: "Quoted, with snake_case_name and stress", Heading: "Follow-ups #2"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("tasks:\n got %+v\nwant %+v", got, want)
	}
}

func TestTasksCRLF(t *testing.T) {
	got := Tasks("# Todo\r\n- [ ] One\r\n- [ ] Two\r\n")
	want := []Task{{Line: 2, Text: "One", Heading: "Todo"}, {Line: 3, Text: "Two", Heading: "Todo"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("tasks = %+v", got)
	}
}

func TestTasksInNewBlocks(t *testing.T) {
	got := Tasks(`# Top

:::: columns
::: column
- [ ] In a column, <u>underlined</u> @2026-11-11
:::
::: column
- [x] Done
:::
::::

<details>
<summary><h2>Folded &amp; more</h2></summary>

- [ ] Under a toggle heading

</details>

> [!question]+ Title
> - [ ] In a callout
`)
	want := []Task{
		{Line: 5, Text: "In a column, underlined", Heading: "Top", Due: "2026-11-11"},
		{Line: 15, Text: "Under a toggle heading", Heading: "Folded & more"},
		{Line: 20, Text: "In a callout", Heading: "Folded & more"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("tasks:\n got %+v\nwant %+v", got, want)
	}
}

func TestTaskDueDates(t *testing.T) {
	got := Tasks("---\ntags: [a]\n---\n" + `# Plan
- [ ] Call the bank @2026-11-20
- [ ] Two days: @2026-11-22 then @2026-11-21
- [ ] **Renew** the [cert](https://example.com/@2026-01-01) (@2026-12-01).
- [ ] Dentist - @2026-11-25
- [ ] No such day @2026-13-40
- [ ] Not a chip: me@2026-11-20, @2026-11-20x, @2026-11-20-1, \@2026-11-20
- [ ] In code ` + "`@2026-11-20`" + ` only
- [ ] @2026-11-20
- [x] Done @2026-11-20
`)
	want := []Task{
		{Line: 5, Text: "Call the bank", Heading: "Plan", Due: "2026-11-20"},
		{Line: 6, Text: "Two days: then", Heading: "Plan", Due: "2026-11-22"},
		{Line: 7, Text: "Renew the cert.", Heading: "Plan", Due: "2026-12-01"},
		{Line: 8, Text: "Dentist", Heading: "Plan", Due: "2026-11-25"},
		{Line: 9, Text: "No such day @2026-13-40", Heading: "Plan"},
		{Line: 10, Text: "Not a chip: me@2026-11-20, @2026-11-20x, @2026-11-20-1, @2026-11-20", Heading: "Plan"},
		{Line: 11, Text: "In code @2026-11-20 only", Heading: "Plan"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("tasks:\n got %+v\nwant %+v", got, want)
	}
}

func TestDates(t *testing.T) {
	got := Dates("---\ntags: [a]\n---\n" + `# Trip @2026-11-01

Flights booked for @2026-11-20, back @2026-11-27.

## Chores
- [ ] Call the bank @2026-11-20
  - [x] Find the **card** @2026-11-19
- Plain item (@2026-11-21)
1. Numbered @2026-11-22

> [!note] Renewal @2026-12-01
> Quoted line @2026-12-02

| Thing | When |
| --- | --- |
| Cert | @2026-12-03 |

<details>
<summary><h2>Later @2027-01-05</h2></summary>

@2027-01-06

</details>
` + "```\n- [ ] in a fence @2026-11-20\n```\n" + "Inline `@2026-11-20` and @2026-02-30 and a@2026-11-20 and twice @2026-11-28 @2026-11-28\n")
	want := []Dated{
		{Line: 4, Date: "2026-11-01", Text: "Trip", Heading: "Trip @2026-11-01"},
		{Line: 6, Date: "2026-11-20", Text: "Flights booked for, back.", Heading: "Trip @2026-11-01"},
		{Line: 6, Date: "2026-11-27", Text: "Flights booked for, back.", Heading: "Trip @2026-11-01"},
		{Line: 9, Date: "2026-11-20", Text: "Call the bank", Heading: "Chores", Task: true},
		{Line: 10, Date: "2026-11-19", Text: "Find the card", Heading: "Chores", Task: true, Done: true},
		{Line: 11, Date: "2026-11-21", Text: "Plain item", Heading: "Chores"},
		{Line: 12, Date: "2026-11-22", Text: "Numbered", Heading: "Chores"},
		{Line: 14, Date: "2026-12-01", Text: "Renewal", Heading: "Chores"},
		{Line: 15, Date: "2026-12-02", Text: "Quoted line", Heading: "Chores"},
		{Line: 19, Date: "2026-12-03", Text: "Cert", Heading: "Chores"},
		{Line: 22, Date: "2027-01-05", Text: "Later", Heading: "Later @2027-01-05"},
		{Line: 24, Date: "2027-01-06", Text: "", Heading: "Later @2027-01-05"},
		{Line: 30, Date: "2026-11-28", Text: "Inline @2026-11-20 and @2026-02-30 and a@2026-11-20 and twice", Heading: "Later @2027-01-05"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("dates:\n got %+v\nwant %+v", got, want)
	}
	if Dates("No chips here, just mail@example.com\n") != nil {
		t.Error("a page without chips has dates")
	}
}
