package store

import (
	"context"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oddomens/quire/internal/ask"
	"github.com/oddomens/quire/internal/vault"
)

func askStore(t *testing.T, pages map[string]string) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "q.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	for p, c := range pages {
		if err := s.Put(vault.Entry{Path: p, Size: int64(len(c)), ModTime: time.Now()}, []byte(c)); err != nil {
			t.Fatal(err)
		}
	}
	return s
}

var askPages = map[string]string{
	"Medical/Insect bites and stings.md": `Most bites and stings settle in a few days.

> [!danger] Call 911 or go to the ER if
> - Trouble breathing or a tight throat.

## Bees and wasps

1. Scrape the stinger out sideways with a card.
2. Wash with soap and water and use a cold pack.

## See a doctor or urgent care if

- Swelling spreads to the whole limb.

## Children

Children react more strongly to many stings.
`,
	"Animals/Bee.md": `---
source: https://example.org/Bee
---

Bees are flying insects closely related to wasps and ants, known for pollination and honey.

## Stings

Only female bees sting. The sting of a honeybee is barbed.
`,
	"Home/Water shutoff.md": `Know where your main water shutoff valve is before a pipe bursts.

## Finding the valve

It is usually where the main line enters the house, near the meter.
`,
	"Home/Water storage.md": `Store at least one gallon of water per person per day.

## How much to store

Keep a two-week supply for everyone in the house.
`,
	"Animals/Agkistrodon piscivorus.md": `---
source: https://example.org/Cottonmouth
---

Agkistrodon piscivorus, the cottonmouth or water moccasin, is a venomous pit viper of the southeastern United States.
`,
	"Survival/Snakes.md": `Leave a [[Animals/Agkistrodon piscivorus|cottonmouth]] alone and back away slowly.
`,
	"Vehicles/2012 Honda Accord.md": `The family car.

## Quick fixes

- Flat tire: see the how-to. Oil change every 5,000 miles.
`,
	"Vehicles/2012 Honda Accord/Changing a flat tire.md": `Swap a flat for the compact spare.

## Steps

### Lower the spare

1. Turn the winch counterclockwise.

### Change the wheel

2. Loosen the nuts, jack it up, swap the wheel.

### Stow the flat

3. Put the flat back under the car.
`,
	"Vehicles/2012 Honda Accord/Oil change.md": `Change the oil and filter.

## Steps

1. Drain the oil. Fix the drain plug washer.
`,
	"Vehicles/2014 Chevy Malibu/Changing a flat tire.md": `This car may have a sealant kit instead of a spare.

## Steps

1. Use the sealant kit on the flat.
`,
}

func askQ(t *testing.T, s *Store, q, prev, prevPage string) *ask.Answer {
	t.Helper()
	idx, err := s.AskIndex()
	if err != nil {
		t.Fatal(err)
	}
	a, err := ask.Ask(idx, ask.Analyze(q, prev), ask.Options{PrevPage: prevPage})
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func TestAskFindsTheSection(t *testing.T) {
	s := askStore(t, askPages)
	a := askQ(t, s, "How do I treat a bee sting?", "", "")
	if a.Main == nil || a.Main.Title != "Insect bites and stings" || a.Main.Heading != "Bees and wasps" {
		t.Fatalf("main = %+v", a.Main)
	}
	if !strings.Contains(a.Main.Markdown, "Scrape the stinger") {
		t.Errorf("markdown = %q", a.Main.Markdown)
	}
	if a.Warning == nil || !strings.Contains(a.Warning.Markdown, "Call 911") {
		t.Errorf("the page's danger box should come first: %+v", a.Warning)
	}
	if len(a.Chips) == 0 || a.Chips[0].Label != "See a doctor or urgent care if" {
		t.Errorf("chips = %+v", a.Chips)
	}
}

func TestAskJoinedWords(t *testing.T) {
	s := askStore(t, askPages)
	if a := askQ(t, s, "How do I shut off the water?", "", ""); a.Main == nil || a.Main.Title != "Water shutoff" {
		t.Fatalf("main = %+v", a.Main)
	}
}

func TestAskByLinkLabel(t *testing.T) {
	s := askStore(t, askPages)
	if a := askQ(t, s, "What is a cottonmouth?", "", ""); a.Main == nil || a.Main.Title != "Agkistrodon piscivorus" {
		t.Fatalf("main = %+v", a.Main)
	}
}

func TestAskFollowUpStaysOnPage(t *testing.T) {
	s := askStore(t, askPages)
	a := askQ(t, s, "what about children?", "How do I treat a bee sting?", "Medical/Insect bites and stings.md")
	if a.Main == nil || a.Main.Title != "Insect bites and stings" || a.Main.Heading != "Children" {
		t.Fatalf("main = %+v", a.Main)
	}
}

func TestAskSpelling(t *testing.T) {
	s := askStore(t, askPages)
	a := askQ(t, s, "how much watter to store", "", "")
	if a.Corrected["watter"] != "water" {
		t.Errorf("corrected = %v", a.Corrected)
	}
	if a.Main == nil || a.Main.Title != "Water storage" {
		t.Errorf("main = %+v", a.Main)
	}
}

func TestAskSection(t *testing.T) {
	s := askStore(t, askPages)
	idx, _ := s.AskIndex()
	a, err := ask.Ask(idx, ask.Query{}, ask.Options{Page: "Medical/Insect bites and stings.md", Section: 3})
	if err != nil {
		t.Fatal(err)
	}
	if a.Main == nil || a.Main.Heading != "Children" {
		t.Fatalf("main = %+v", a.Main)
	}
}

func TestPassagesFollowEdits(t *testing.T) {
	s := askStore(t, askPages)
	p := "Home/Water storage.md"
	if err := s.Put(vault.Entry{Path: p, ModTime: time.Now()}, []byte("Rotate stored water every six months.\n")); err != nil {
		t.Fatal(err)
	}
	var n int
	s.db.QueryRow(`SELECT count(*) FROM passages WHERE path = ?`, p).Scan(&n)
	if n != 1 {
		t.Fatalf("%d passages after an edit, want 1", n)
	}
	if err := s.Delete(p); err != nil {
		t.Fatal(err)
	}
	s.db.QueryRow(`SELECT count(*) FROM passages WHERE path = ?`, p).Scan(&n)
	if n != 0 {
		t.Fatalf("%d passages after delete", n)
	}
	idx, _ := s.AskIndex()
	if c, _ := idx.Count(`"rotate"`); c != 0 {
		t.Errorf("deleted page still searchable (%d)", c)
	}
	s.db.QueryRow(`SELECT count(*) FROM aliases WHERE src = 'Survival/Snakes.md'`).Scan(&n)
	if n != 1 {
		t.Errorf("%d aliases, want 1", n)
	}
}

func TestFillPassages(t *testing.T) {
	s := askStore(t, askPages)
	// As if the pages were indexed before Ask existed.
	for _, q := range []string{`DELETE FROM passage_fts`, `DELETE FROM passages`, `DELETE FROM passage_pages`, `DELETE FROM aliases`} {
		if _, err := s.db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if done, total, _ := s.PassageProgress(); done != 0 || total != len(askPages) {
		t.Fatalf("progress %d/%d", done, total)
	}
	s.FillPassages(context.Background(), slog.New(slog.DiscardHandler))
	if done, total, _ := s.PassageProgress(); done != total {
		t.Fatalf("progress %d/%d after filling", done, total)
	}
	if a := askQ(t, s, "How do I treat a bee sting?", "", ""); a.Main == nil || a.Main.Heading != "Bees and wasps" {
		t.Fatalf("main = %+v", a.Main)
	}
	// A second run finds nothing to do and doesn't duplicate anything.
	var before, after int
	s.db.QueryRow(`SELECT count(*) FROM passages`).Scan(&before)
	s.FillPassages(context.Background(), slog.New(slog.DiscardHandler))
	s.db.QueryRow(`SELECT count(*) FROM passages`).Scan(&after)
	if before != after {
		t.Errorf("passages %d -> %d on a second fill", before, after)
	}
}

func TestAskFolderNamesTheThing(t *testing.T) {
	s := askStore(t, askPages)
	a := askQ(t, s, "how do I fix a flat on my honda", "", "")
	if a.Main == nil || a.Main.Path != "Vehicles/2012 Honda Accord/Changing a flat tire.md" {
		t.Fatalf("main = %+v", a.Main)
	}
	// The page's steps, from the top, not the step that says "flat".
	if a.Main.Heading != "Steps" || !strings.Contains(a.Main.Markdown, "counterclockwise") || !strings.Contains(a.Main.Markdown, "### Change the wheel") {
		t.Errorf("main = %+v", a.Main)
	}
	if a := askQ(t, s, "flat tire on the chevy", "", ""); a.Main == nil || a.Main.Path != "Vehicles/2014 Chevy Malibu/Changing a flat tire.md" {
		t.Errorf("chevy: main = %+v", a.Main)
	}
}

var searchPages = map[string]string{
	"Vehicles/2015 Honda CR-V.md": `Service guide for the family car.

## At a glance

Oil change every 5,000 miles.
`,
	"Vehicles/2015 Honda CR-V/Bulbs.md": `Bulb sizes.

## Headlights

Low beam H11. Most SUV owners carry a spare.
`,
	"Vehicles/2014 Chevy Malibu.md": `The commuter.
`,
	"Vehicles/2014 Chevy Malibu/Oil change.md": `Change the oil and filter.

## Steps

1. Drain the oil.
`,
	"Devices/MacBook Pro/Heat and fan noise.md": `The fans get loud when something is using the processor.

## Steps

1. Open Activity Monitor and sort by CPU.
`,
	"Devices/MacBook Pro/Back up with Time Machine.md": `Time Machine keeps hourly copies on an external drive.

## Set up

1. Plug in the drive and choose it as the backup disk.
`,
	"Devices/iPhone 15/Gets hot.md": `A phone that gets hot usually has an app stuck in the background.

## Steps

1. Take it out of the sun and close the camera.
`,
	"Medical/Animal and human bites.md": `Any bite that breaks the skin can get infected.

## Home care

Wash a dog or cat bite with soap and running water for five minutes.

## Children

Bites to a child's face or hand need a doctor the same day.
`,
	"Medical/Spider bites.md": `Most spider bites are harmless.

## Children

Watch a small child closely after a spider bite.
`,
	"Home/Kitchen conversions.md": `Common kitchen measures.

## Volume

4 cups make 1 quart. 4 quarts make 1 gallon.
`,
	"Geography/Springfield.md": `---
source: https://example.org/Springfield
---

Springfield is a city.

## World Cup

The city hosted three quarterfinal matches of the cup, and the cups are on show at the museum.
`,
	"Medical/Fungal skin infections.md": `Fungal infections like athlete's foot and ringworm itch and peel.

## Medicines that help

An antifungal cream twice a day clears most athlete's foot in two weeks.
`,
	"Human body/Foot.md": `---
source: https://example.org/Foot
---

The foot is the end of the leg, which athletes train for balance.

## Clinical significance

Athlete's foot is a common infection of the foot.
`,
}

func TestSearchKnowsKindsOfThings(t *testing.T) {
	s := askStore(t, searchPages)
	// "My SUV" is the CR-V: its own page, not a page that says "SUV".
	a := askQ(t, s, "tell me about my SUV", "", "")
	if a.Main == nil || a.Main.Path != "Vehicles/2015 Honda CR-V.md" {
		t.Fatalf("suv: main = %+v", a.Main)
	}
	if a := askQ(t, s, "my laptop is running hot", "", ""); a.Main == nil || a.Main.Path != "Devices/MacBook Pro/Heat and fan noise.md" {
		t.Errorf("laptop: main = %+v", a.Main)
	}
	if a := askQ(t, s, "how do I back up my mac", "", ""); a.Main == nil || a.Main.Path != "Devices/MacBook Pro/Back up with Time Machine.md" {
		t.Errorf("mac: main = %+v", a.Main)
	}
	// A model name that's also an everyday word names only a vehicle's folder.
	if got := askQ(t, s, "oil change on the sedan", "", ""); got.Main == nil || got.Main.Path != "Vehicles/2014 Chevy Malibu/Oil change.md" {
		t.Errorf("sedan: main = %+v", got.Main)
	}
}

func TestSearchWordForms(t *testing.T) {
	s := askStore(t, searchPages)
	// "bit" is "bite"; the page about dog bites, not the one about spiders.
	a := askQ(t, s, "dog bit my kid on the hand", "", "")
	if a.Main == nil || a.Main.Path != "Medical/Animal and human bites.md" {
		t.Fatalf("main = %+v", a.Main)
	}
	// A polite start is not part of the question.
	if a := askQ(t, s, "can you help me back up my mac", "", ""); a.Main == nil || a.Main.Title != "Back up with Time Machine" {
		t.Errorf("polite: %+v", a.Main)
	}
	if q := ask.Analyze("Can you help me fix a flat tire?", ""); q.Intent != ask.IntentHowTo {
		t.Errorf("polite: intent %q, want howto", q.Intent)
	}
}

func TestSearchPrefersTheWordItself(t *testing.T) {
	s := askStore(t, searchPages)
	// "quart" is not "quarterfinal", and a guide beats the encyclopedia.
	a := askQ(t, s, "cups in a quart", "", "")
	if a.Main == nil || a.Main.Path != "Home/Kitchen conversions.md" {
		t.Fatalf("main = %+v", a.Main)
	}
	// Typed without the apostrophe, and the guide still comes first.
	if a := askQ(t, s, "athletes foot", "", ""); a.Main == nil || a.Main.Path != "Medical/Fungal skin infections.md" {
		t.Errorf("athletes foot: main = %+v", a.Main)
	}
}

func TestSearchSaysWhatIsMissing(t *testing.T) {
	s := askStore(t, searchPages)
	a := askQ(t, s, "how do I file my taxes on the mac", "", "")
	if a.Confidence != "low" && a.Confidence != "none" {
		t.Errorf("confidence = %q for something the notes don't have", a.Confidence)
	}
	if a.Main != nil && !strings.Contains(strings.Join(a.Missing, " "), "taxes") {
		t.Errorf("missing = %v, want taxes", a.Missing)
	}
	if a := askQ(t, s, "cups in a quart", "", ""); len(a.Missing) != 0 || a.Confidence != "high" {
		t.Errorf("a full match: missing %v, confidence %q", a.Missing, a.Confidence)
	}
}
