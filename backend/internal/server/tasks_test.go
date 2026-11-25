package server

import (
	"strings"
	"testing"

	"github.com/oddomens/quire/internal/store"
)

func TestSpaceTasks(t *testing.T) {
	h := newHarness(t)
	plan := h.put("Work/Plan.md", "# Plan\n\n## Known issues\n- [ ] Fix **sync**\n- [x] Done\n```\n- [ ] not a task\n```\n")
	h.put("Work/Plan/Sub.md", "- [ ] Write [[Plan|the plan]] up\n")
	h.put("Work/Notes.md", "No tasks here.")
	h.do("POST", "/api/spaces", map[string]string{"name": "Home"}, nil)
	h.put("Home/List.md", "- [ ] Not in Work")

	var tasks []store.Task
	if code := h.do("GET", "/api/spaces/Work/tasks", nil, &tasks); code != 200 {
		t.Fatalf("tasks: %d", code)
	}
	want := []store.Task{
		{Path: "Work/Plan.md", Title: "Plan", Rev: plan.Rev, Line: 4, Text: "Fix sync", Heading: "Known issues"},
		{Path: "Work/Plan/Sub.md", Title: "Sub", Line: 1, Text: "Write the plan up"},
	}
	if len(tasks) != len(want) {
		t.Fatalf("tasks = %+v", tasks)
	}
	want[1].Rev = tasks[1].Rev
	for i := range want {
		if tasks[i] != want[i] {
			t.Errorf("task %d = %+v, want %+v", i, tasks[i], want[i])
		}
	}

	// Ticking the line off with the listed rev removes it; a stale rev is refused.
	lines := strings.Split(h.read("Work/Plan.md"), "\n")
	lines[3] = strings.Replace(lines[3], "[ ]", "[x]", 1)
	if code := h.do("PUT", "/api/notes/Work/Plan.md", map[string]string{"content": strings.Join(lines, "\n"), "baseRev": tasks[0].Rev}, nil); code != 200 {
		t.Fatalf("tick: %d", code)
	}
	if code := h.do("PUT", "/api/notes/Work/Plan.md", map[string]string{"content": "x", "baseRev": tasks[0].Rev}, nil); code != 409 {
		t.Fatalf("stale tick: %d", code)
	}
	h.do("GET", "/api/spaces/Work/tasks", nil, &tasks)
	if len(tasks) != 1 || tasks[0].Path != "Work/Plan/Sub.md" {
		t.Fatalf("after tick: %+v", tasks)
	}

	var empty []store.Task
	if code := h.do("GET", "/api/spaces/Home/tasks", nil, &empty); code != 200 || len(empty) != 1 {
		t.Fatalf("Home tasks: %d %+v", code, empty)
	}
	for _, bad := range []string{"Nope", "..", "attachments"} {
		if code := h.do("GET", "/api/spaces/"+bad+"/tasks", nil, nil); code != 404 {
			t.Errorf("tasks in %q: %d", bad, code)
		}
	}
}

func TestMissingLinks(t *testing.T) {
	h := newHarness(t)
	h.do("POST", "/api/spaces", map[string]string{"name": "Home"}, nil)
	h.put("Home/List.md", "[[Elsewhere]] is missing too, but in Home")
	h.put("Work/Notes.md", "notes")
	h.put("Work/Plan.md", "See [[Notes]], [[Home/List]], [[Ghost#Intro|a ghost]], [[Deep/Missing]] and ![[photo.png]].")
	h.put("Work/Other.md", "Also [[ghost]].")

	var links []store.MissingLink
	if code := h.do("GET", "/api/spaces/Work/missing-links", nil, &links); code != 200 {
		t.Fatalf("missing links: %d", code)
	}
	if len(links) != 2 || links[0].Target != "Deep/Missing" || !strings.EqualFold(links[1].Target, "Ghost") {
		t.Fatalf("missing links = %+v", links)
	}
	ghost := links[1].Pages
	if len(ghost) != 2 || ghost[0].Path != "Work/Other.md" || ghost[1].Path != "Work/Plan.md" || ghost[1].Title != "Plan" || !strings.Contains(ghost[1].Context, "a ghost") {
		t.Fatalf("pages linking to Ghost = %+v", ghost)
	}

	// Creating the page fixes the link.
	h.put("Work/Ghost.md", "boo")
	h.do("GET", "/api/spaces/Work/missing-links", nil, &links)
	if len(links) != 1 || links[0].Target != "Deep/Missing" {
		t.Fatalf("after creating Ghost: %+v", links)
	}
	if code := h.do("GET", "/api/spaces/Nope/missing-links", nil, nil); code != 404 {
		t.Fatalf("unknown space: %d", code)
	}
}

func TestDateChipsFeedTasksAndCalendar(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Plan.md", "---\ntags: [a]\n---\n# Plan\n\nKick-off @2026-11-03\n\n## Chores\n- [ ] Call the bank @2026-11-20\n- [x] Find the card @2026-11-19\n- [ ] No date\n```\n- [ ] fenced @2026-11-21\n```\n")
	h.put("Work/Trip.md", "@2026-11-20\n\nBack `@2026-11-22` on @2026-12-02\n")
	h.do("POST", "/api/spaces", map[string]string{"name": "Home"}, nil)
	h.put("Home/List.md", "- [ ] Bins out @2026-11-05\n")
	// A database's page isn't read for chips; its dates are in its columns.
	db := h.newTable("Log", "")
	h.write(db, h.read(db)+"\nSee @2026-11-10\n")
	h.scan()

	var tasks []store.Task
	h.do("GET", "/api/spaces/Work/tasks", nil, &tasks)
	if len(tasks) != 2 || tasks[0].Text != "Call the bank" || tasks[0].Due != "2026-11-20" || tasks[0].Line != 9 || tasks[1].Due != "" {
		t.Fatalf("tasks = %+v", tasks)
	}

	var events []calendarEvent
	if code := h.do("GET", "/api/calendar?from=2026-11-01&to=2026-11-30", nil, &events); code != 200 {
		t.Fatalf("calendar: %d", code)
	}
	want := []calendarEvent{
		{Path: "Work/Plan.md", Table: "Plan", Title: "Kick-off", Start: "2026-11-03", Kind: "date", Line: 6, Heading: "Plan"},
		{Path: "Home/List.md", Table: "List", Title: "Bins out", Start: "2026-11-05", Kind: "task", Line: 1},
		{Path: "Work/Plan.md", Table: "Plan", Title: "Find the card", Start: "2026-11-19", Kind: "task", Line: 10, Heading: "Chores", Done: true},
		{Path: "Work/Plan.md", Table: "Plan", Title: "Call the bank", Start: "2026-11-20", Kind: "task", Line: 9, Heading: "Chores"},
		{Path: "Work/Trip.md", Table: "Trip", Title: "Trip", Start: "2026-11-20", Kind: "date", Line: 1},
	}
	if len(events) != len(want) {
		t.Fatalf("calendar = %+v", events)
	}
	for i := range want {
		if events[i] != want[i] {
			t.Errorf("event %d = %+v, want %+v", i, events[i], want[i])
		}
	}

	// The range's last day counts, and a page in the trash drops out.
	h.do("GET", "/api/calendar?from=2026-12-01&to=2026-12-02", nil, &events)
	if len(events) != 1 || events[0].Title != "Back @2026-11-22 on" || events[0].Start != "2026-12-02" {
		t.Errorf("december = %+v", events)
	}
	h.do("DELETE", "/api/notes/Work/Trip.md", nil, nil)
	h.do("GET", "/api/calendar?from=2026-12-01&to=2026-12-02", nil, &events)
	if len(events) != 0 {
		t.Errorf("after deleting the page: %+v", events)
	}
}
