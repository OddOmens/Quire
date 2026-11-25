package ask

import (
	"strings"
	"testing"
)

const page = `---
tags: [medical]
---

Most stings settle in a day or two.

> [!danger] Call 911 if
> - Trouble breathing.
> - Swelling of the face or throat.

[TOC]

## Bees and wasps

1. Scrape the stinger out sideways.
2. Wash with soap and water.

<details>
<summary><h2>Children</h2></summary>

Children react more strongly to many stings.

### Babies

Ask a doctor before giving any medicine.

</details>

## Sources

- [[Some source]]
`

func TestSplit(t *testing.T) {
	ps := Split(page)
	var heads []string
	for _, p := range ps {
		heads = append(heads, p.Heading)
	}
	if got := strings.Join(heads, ","); got != ",,Bees and wasps,Children,Babies" {
		t.Fatalf("headings = %q", got)
	}
	if ps[0].Flags&FlagLead == 0 || ps[0].Flags&FlagWarn != 0 {
		t.Errorf("opening paragraph flags = %b", ps[0].Flags)
	}
	if ps[1].Flags&FlagWarn == 0 || !strings.HasPrefix(ps[1].Text, "Call 911 if") {
		t.Errorf("the danger box should be its own passage: %+v", ps[1])
	}
	if ps[2].Flags&FlagSteps == 0 {
		t.Errorf("numbered steps not flagged")
	}
	if ps[4].Trail != "Children › Babies" {
		t.Errorf("trail = %q", ps[4].Trail)
	}
	for _, p := range ps {
		if strings.Contains(p.Text, "Some source") {
			t.Errorf("sources section was indexed")
		}
		if strings.Contains(page[p.Start:p.End], "tags:") {
			t.Errorf("front matter in a passage")
		}
	}
	md := Markdown(page, ps[3].Start, ps[3].End)
	if strings.Contains(md, "details") || strings.Contains(md, "summary") {
		t.Errorf("toggle wrapper left in: %q", md)
	}
	if md != "Children react more strongly to many stings." {
		t.Errorf("markdown = %q", md)
	}
}

func TestSplitNoFrontmatterOrHeadings(t *testing.T) {
	ps := Split("Just one paragraph that says something useful.\n")
	if len(ps) != 1 || ps[0].Section != 0 || ps[0].Heading != "" {
		t.Fatalf("got %+v", ps)
	}
}

func TestSplitLongSectionIntoParts(t *testing.T) {
	var b strings.Builder
	b.WriteString("## Long\n\n")
	for i := 0; i < 12; i++ {
		b.WriteString(strings.Repeat("word ", 40) + "\n\n")
	}
	ps := Split(b.String())
	if len(ps) < 3 {
		t.Fatalf("a long section should be split, got %d parts", len(ps))
	}
	for _, p := range ps {
		if p.Section != 1 || p.Heading != "Long" {
			t.Errorf("part %+v", p)
		}
	}
}

func TestPlain(t *testing.T) {
	cases := map[string]string{
		"See [[Medical/First aid|first aid]] now": "See first aid now",
		"A [[Plants/Dandelion]] leaf":             "A Dandelion leaf",
		"> [!tip] **Bold** tip":                   "Bold tip",
		"1. Step ==one==":                         "Step one",
		"![pic|480](a.webp)":                      "",
		":::: columns":                            "",
		"Pipe \\| inside":                         "Pipe | inside",
	}
	for in, want := range cases {
		if got := Plain(in); got != want {
			t.Errorf("Plain(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIntent(t *testing.T) {
	cases := map[string]Intent{
		"How do I treat a bee sting?":                  IntentHowTo,
		"What is a black widow?":                       IntentDefine,
		"black widow":                                  IntentAny, // bare: Ask decides
		"When should I go to the ER for a burn?":       IntentWhenHelp,
		"What are the signs of a stroke?":              IntentSigns,
		"How much water should we store?":              IntentAmount,
		"Can I eat dandelions?":                        IntentSafe,
		"Where do moose live?":                         IntentWhere,
		"Why do my tomatoes crack?":                    IntentWhy,
		"How does the heart work?":                     IntentWhy,
		"How do I avoid ticks?":                        IntentPrevent,
		"Difference between a hurricane and a tornado": IntentCompare,
		"alligator vs crocodile":                       IntentCompare,
		"Someone is choking":                           IntentHowTo, // an emergency wants what to do
		"my honda wont start":                          IntentHowTo, // trouble wants what to do
	}
	for q, want := range cases {
		if got := Analyze(q, "").Intent; got != want {
			t.Errorf("%q: intent %q, want %q", q, got, want)
		}
	}
}

func TestAnalyze(t *testing.T) {
	q := Analyze("How do I treat a bee sting?", "")
	var asked []string
	for _, term := range q.Terms {
		if term.Of < 0 {
			asked = append(asked, term.Word)
		}
	}
	if got := strings.Join(asked, " "); got != "treat bee sting" {
		t.Errorf("terms = %q", got)
	}
	if !Analyze("my kid swallowed a battery", "").Urgent {
		t.Error("swallowed a battery should be urgent")
	}
	if Analyze("how do I store potatoes", "").Urgent {
		t.Error("not urgent")
	}
	if c := Analyze("difference between a hurricane and a tornado?", "").Compare; len(c) != 2 || c[0] != "hurricane" || c[1] != "tornado" {
		t.Errorf("compare = %q", c)
	}
	can := Analyze("How do I can tomatoes?", "")
	found := false
	for _, term := range can.Terms {
		found = found || term.Word == "canning"
	}
	if !found {
		t.Error(`"can tomatoes" should look for canning`)
	}
	// "how long" asks a question; "long" isn't the topic.
	for _, term := range Analyze("how long do eggs keep", "").Terms {
		if term.Word == "long" && term.Of < 0 {
			t.Error(`"long" kept as a topic word`)
		}
	}
}

func TestFollowUp(t *testing.T) {
	q := Analyze("what about kids?", "How do I treat a bee sting?")
	if !q.FollowUp {
		t.Fatal("not taken as a follow-up")
	}
	has := map[string]bool{}
	for _, term := range q.Terms {
		has[term.Word] = true
	}
	if !has["bee"] || !has["sting"] || !has["kids"] {
		t.Errorf("terms = %+v", q.Terms)
	}
	if Analyze("How do I make sourdough bread at home?", "How do I treat a bee sting?").FollowUp {
		t.Error("a new question taken as a follow-up")
	}
}

func TestPhrases(t *testing.T) {
	ps := Analyze("xbox won't turn on", "").Phrases
	if !contains(ps, "won't turn on") || !contains(ps, "xbox") || contains(ps, "on") {
		t.Errorf("phrases = %q", ps)
	}
}

func TestSnippetMarksWords(t *testing.T) {
	s := snippet("Scrape the stinger out. Bee stings hurt.", Analyze("bee sting", ""))
	if !strings.Contains(s, "\x02stinger\x03") || !strings.Contains(s, "\x02Bee\x03") {
		t.Errorf("snippet = %q", s)
	}
}

func TestMatch(t *testing.T) {
	if got := match("purification"); !strings.Contains(got, `"purif"*`) {
		t.Errorf("match = %q", got)
	}
	if got := match("fast"); !strings.Contains(got, `"fastest"`) {
		t.Errorf("match = %q", got)
	}
	if got := match(`say "hi"`); strings.Count(got, `"`) != 2 {
		t.Errorf("quotes not removed: %q", got)
	}
}

func TestQuestionWordsOnly(t *testing.T) {
	a, err := Ask(nil, Analyze("what is it?", ""), Options{})
	if err != nil || a.Confidence != "none" || a.Main != nil {
		t.Fatalf("got %+v, %v", a, err)
	}
}

func TestEverydayWords(t *testing.T) {
	q := Analyze("my iphone wont turn on", "")
	for _, term := range q.Terms {
		if term.Word == "wont" {
			t.Errorf("wont should read as won't: %+v", q.Terms)
		}
	}
	w := map[string]float64{}
	for _, term := range Analyze("charley horse in my leg", "").Terms {
		w[term.Word] = term.Weight
	}
	if w["cramp"] < 1 || w["horse"] >= 1 {
		t.Errorf("charley horse is a muscle cramp, not a horse: %v", w)
	}
	if !Analyze("burned my hand on the stove", "").Personal {
		t.Error("not taken as about the asker")
	}
	if got := Analyze("burned my hand on the stove", "").Intent; got != IntentHowTo {
		t.Errorf("something that happened wants what to do, got %q", got)
	}
	if got := Analyze("what oil does my honda take", "").Intent; got != IntentAmount {
		t.Errorf("what oil: intent %q", got)
	}
}

func TestPlainAsk(t *testing.T) {
	for in, want := range map[string]string{
		"can you help me fix a flat tire":            "fix a flat tire",
		"hi, could you tell me how to tie a bowline": "tie a bowline",
		"help me with a bee sting":                   "a bee sting",
		"how do i fix a flat":                        "how do i fix a flat",
		"can you help me":                            "can you help me",
		"i saw a bear on the trail":                  "i a bear on the trail",
		"how do i sharpen a saw":                     "how do i sharpen a saw",
	} {
		if got := plainAsk(in); got != want {
			t.Errorf("%q -> %q, want %q", in, got, want)
		}
	}
}

func TestFormsAndKinds(t *testing.T) {
	if !sameWord("bit", "bites") || !sameWord("froze", "frozen") || sameWord("bit", "bat") {
		t.Error("sameWord: forms of a word")
	}
	if m := match("bit"); !strings.Contains(m, `"bite"`) || !strings.Contains(m, `"bitten"`) {
		t.Errorf("match(bit) = %s", m)
	}
	if m := phraseMatch("athletes foot"); !strings.Contains(m, `"athlete s foot"`) {
		t.Errorf("phraseMatch = %s", m)
	}
	folders := []string{"Devices", "Devices/MacBook Air", "Devices/MacBook Air/Troubleshooting", "Outdoors/Terrain and weather", "Space/Pilot training", "Vehicles", "Vehicles/2015 Honda CR-V", "Vehicles/2014 Chevy Malibu"}
	if got := kindOf("laptop", folders); len(got) != 1 || got[0] != "Devices/MacBook Air" {
		t.Errorf("laptop -> %v", got)
	}
	// "Terrain" and "Pilot" are SUVs only in a folder with a make or a year.
	if got := kindOf("suv", folders); len(got) != 1 || got[0] != "Vehicles/2015 Honda CR-V" {
		t.Errorf("suv -> %v", got)
	}
	if got := kindOf("sedans", folders); len(got) != 1 || got[0] != "Vehicles/2014 Chevy Malibu" {
		t.Errorf("sedans -> %v", got)
	}
	if got := kindOf("car", folders); got != nil {
		t.Errorf("car -> %v, want none (left to the synonyms)", got)
	}
}

func TestSnippetReadsTables(t *testing.T) {
	got := snippet("| Symptom | Start here |\n| --- | --- |\n| Wrench light | Maintenance schedule |\n", Analyze("wrench light", ""))
	if strings.Contains(got, "---") || strings.Contains(got, "|") || !strings.Contains(got, "\x02Wrench\x03") {
		t.Errorf("snippet = %q", got)
	}
}
