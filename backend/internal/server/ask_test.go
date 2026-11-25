package server

import "testing"

func TestQuestionFrom(t *testing.T) {
	cases := map[[2]string]string{
		{"Signs and symptoms", "Hypothermia"}:            "What are the signs of hypothermia?",
		{"See a doctor or urgent care if", "Cold sores"}: "When should I see a doctor for cold sores?",
		{"How to tie a bowline", "Knots"}:                "How do I tie a bowline?",
		{"If a pipe is frozen", "Frozen pipes"}:          "What do I do if a pipe is frozen?",
		{"When to do it", "Pruning"}:                     "",
		{"How to cross", "River crossings"}:              "",
		{"What to do: the rule of 15", "Low sugar"}:      "",
		{"Sources", "Anything"}:                          "",
		{"Symptoms", "Face ID"}:                          "",
		{"Prevention", "Swallowed something harmful"}:    "",
		{"Prevention", "Frostbite"}:                      "How do I prevent frostbite?",
		{"Signs and symptoms", "Won't turn on"}:          "",
	}
	for in, want := range cases {
		if got := questionFrom(in[0], in[1]); got != want {
			t.Errorf("questionFrom(%q, %q) = %q, want %q", in[0], in[1], got, want)
		}
	}
}

func TestSearchBestFirst(t *testing.T) {
	h := newHarness(t)
	h.put("Work/Water heater.md", "Flush the tank once a year.\n\n## No hot water\n\nCheck the pilot light, then the breaker.\n")
	h.put("Work/Gutters.md", "Clean the gutters in fall. A water heater is unrelated.\n")
	type hit struct {
		Path, Heading, Snippet string
	}
	// Plain search wants every word as typed: a misspelled one finds nothing.
	var plain []hit
	h.do("GET", "/api/search?q=watr+heater", nil, &plain)
	if len(plain) != 0 {
		t.Fatalf("plain search matched a misspelling: %+v", plain)
	}
	var best []hit
	if code := h.do("GET", "/api/search?q=watr+heater&best=1", nil, &best); code != 200 || len(best) == 0 || best[0].Path != "Work/Water heater.md" {
		t.Fatalf("best=1: %d %+v", code, best)
	}
	// The section that fits comes first, with where it is.
	best = nil
	h.do("GET", "/api/search?q=no+hot+water&best=1", nil, &best)
	if len(best) == 0 || best[0].Path != "Work/Water heater.md" || best[0].Heading != "No hot water" || best[0].Snippet == "" {
		t.Fatalf("section first: %+v", best)
	}
	// A word still being typed keeps its exact matches.
	best = nil
	h.do("GET", "/api/search?q=gutt&best=1", nil, &best)
	if len(best) == 0 || best[0].Path != "Work/Gutters.md" {
		t.Fatalf("prefix while typing: %+v", best)
	}
}
