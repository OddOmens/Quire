package ask

import (
	"regexp"
	"strings"
)

// stopWords carry no topic: question words, pronouns, helpers and filler.
var stopWords = setOf(`hi hello hey hiya howdy greetings a about above actually after again against all almost also am among an and any anyone
anything are aren't around as at away back be because been before being below best better between both
but by can can't cannot could couldn't did didn't do does doesn't doing don't done down during each
either else enough even ever every everything few for from further get gets getting give go goes going
gone good got gotten had hadn't has hasn't have haven't having he he'd he's her here hers herself him
himself his how how's however i i'd i'll i'm i've if in instead into is isn't it it'd it'll it's its
itself just keep kind know let let's like lot lots make many may maybe me might mine more most much must
my myself need needs neither never no nor not now of off often ok okay on once one only onto or other
ought our ours ourselves out over own please pretty probably put quite rather really right said same
say says see seem seems shall she she'd she's should shouldn't show so some somebody someone something
sometimes somewhat soon sort still such sure take tell than thank thanks that that's the their theirs
them themselves then there there's these they they'd they'll they're they've thing things think this
those though through thus to together too toward tried tries try trying under until up upon us use used
uses using usually very via want wanted wants was wasn't way ways we we'd we'll we're we've well went
were weren't what what's whatever when when's where where's whether which while who who's whom whose
why why's will with within without won't would wouldn't yeah yes yet you you'd you'll you're you've
your yours yourself yourselves explain info information mean means ever via etc`)

// lightWords say what to do with a thing more than what it is: "fix" a
// flat, "change" the oil. They count for less than the thing itself.
var lightWords = setOf(`fix fixing fixed repair repairing replace replacing change changing problem problems
issue issues deal dealing handle handling guide guides tip tips step steps instructions method basics quick
easy help do-it-yourself diy`)

// synonyms are words people use for the same thing. A question with one also
// looks for the others, at a lower weight than the words actually asked.
var synonymGroups = [][]string{
	{"hospital", "er", "emergency", "911", "ambulance", "urgent"},
	{"doctor", "physician", "clinic", "urgent care"},
	{"kid", "kids", "child", "children", "baby", "babies", "toddler", "infant", "son", "daughter"},
	{"dog", "dogs", "puppy", "pet", "pets"},
	{"cat", "cats", "kitten"},
	{"eat", "eating", "edible", "food", "foods", "forage", "foraging"},
	{"poison", "poisonous", "poisoning", "toxic", "toxin", "venom", "venomous"},
	{"sting", "stung", "stinger"},
	{"bite", "bitten", "bit"},
	{"burn", "burned", "burnt", "scald", "scalded"},
	{"cut", "wound", "laceration", "gash", "bleeding", "bleed"},
	{"broken", "break", "fracture", "fractured"},
	{"sprain", "sprained", "twisted", "strain"},
	{"hypothermia", "freezing", "shivering"},
	{"frostbite", "frostnip", "frozen"},
	{"heatstroke", "overheating", "heat exhaustion"},
	{"fever", "temperature"},
	{"throw up", "vomit", "vomiting", "puke", "nausea", "nauseous"},
	{"diarrhea", "loose stool"},
	{"headache", "migraine"},
	{"stomach", "belly", "tummy", "abdominal", "abdomen"},
	{"rash", "hives", "itchy", "itch"},
	{"allergy", "allergic", "anaphylaxis"},
	{"choke", "choking"},
	{"faint", "fainted", "fainting", "passed out", "unconscious"},
	{"purify", "purification", "purifier", "filter", "boil", "disinfect"},
	{"water", "drinking"},
	{"fire", "campfire", "firewood", "kindling", "tinder"},
	{"lost", "stranded", "navigation"},
	{"power", "outage", "blackout", "electricity"},
	{"generator", "generators"},
	{"storm", "storms", "hurricane", "tornado", "thunderstorm"},
	{"flood", "flooding"},
	{"earthquake", "quake"},
	{"wildfire", "forest fire"},
	{"shelter", "tent", "tarp"},
	{"hike", "hiking", "trail", "backpacking"},
	{"boots", "shoes", "footwear"},
	{"blister", "blisters", "hot spot"},
	{"pack", "backpack", "bag"},
	{"go bag", "bug out bag", "bugout", "72 hour kit", "emergency kit"},
	{"can", "canning", "preserve", "preserving", "jar", "jars"},
	{"garden", "gardening", "vegetables", "grow", "growing", "plant", "planting"},
	{"chicken", "chickens", "hens", "hen", "coop", "poultry"},
	{"goat", "goats"},
	{"bees", "bee", "beekeeping", "hive", "honeybee"},
	{"pipe", "pipes", "plumbing"},
	{"leak", "leaking", "drip", "dripping"},
	{"furnace", "heater", "heating", "heat"},
	{"hot", "heat", "overheat", "overheats", "overheating"},
	{"car", "vehicle", "truck", "automobile"},
	// Kinds of car: each is a car, not the others.
	{"suv", "suvs", "car", "vehicle"},
	{"minivan", "van", "car", "vehicle"},
	{"sedan", "car", "vehicle"},
	{"battery", "batteries"},
	{"snake", "snakes", "rattlesnake", "serpent"},
	{"spider", "spiders"},
	{"tick", "ticks"},
	{"mosquito", "mosquitoes", "mosquitos"},
	{"mushroom", "mushrooms", "fungus", "fungi"},
	{"berry", "berries"},
	{"fish", "fishing"},
	{"knot", "knots", "rope"},
	{"knife", "knives", "blade"},
	{"map", "compass", "navigate"},
	{"medicine", "medication", "meds", "pills", "drug"},
	{"pain", "hurts", "ache", "sore"},
	{"cough", "coughing"},
	{"cold", "flu", "sick"},
	{"breathe", "breathing", "breath"},
	{"heart attack", "chest pain"},
	{"stroke", "brain attack"},
	{"seizure", "seizures", "convulsion", "convulsions"},
	{"overdose", "od"},
	{"store", "storage", "stockpile", "keep"},
	{"rid", "remove", "removing", "removal"},
	{"avoid", "prevent", "prevention", "repel", "repellent"},
	{"live", "lives", "habitat", "range", "distribution", "native"},
	{"work", "works", "function", "functions"},
	{"form", "forms", "formation", "develop", "develops"},
	{"cause", "causes", "caused"},
	{"tie", "knot", "hitch"},
	{"symptom", "symptoms", "signs"},
	{"warm", "warmth", "insulate", "insulation"},
	{"shut", "shutoff", "turn off"},
	{"fix", "repair", "replace"},
	{"flat", "flat tire", "puncture"},
	{"tire", "tires", "tyre", "tyres"},
	{"jump", "jump start", "jump starting", "jumper cables"},
	{"phone", "iphone", "smartphone", "cellphone"},
	{"picture", "pictures", "photo", "photos", "camera"},
	{"long", "last", "shelf life", "expire", "expiration"},
}

var synonyms = func() map[string][]string {
	m := map[string][]string{}
	for _, g := range synonymGroups {
		for _, w := range g {
			for _, o := range g {
				if o != w && !contains(m[w], o) {
					m[w] = append(m[w], o)
				}
			}
		}
	}
	return m
}()

// urgentPhrases are signs of an emergency: the answer leads with the page's
// danger box and the app shows how to call for help.
var urgentPhrases = []string{
	"not breathing", "can't breathe", "cant breathe", "cannot breathe", "trouble breathing", "stopped breathing",
	"unconscious", "unresponsive", "passed out", "won't wake", "wont wake", "not waking",
	"choking", "chest pain", "heart attack", "stroke", "seizure", "convulsing",
	"bleeding a lot", "won't stop bleeding", "wont stop bleeding", "severe bleeding", "spurting", "heavy bleeding",
	"swallowed", "ate a", "drank", "overdose", "poisoned", "poisoning", "anaphyla", "throat swelling", "swollen throat",
	"lips swelling", "face swelling", "bitten by a snake", "snake bit", "snakebite", "rattlesnake bite",
	"black widow bite", "brown recluse bite", "drowning", "drowned", "hypothermia", "heatstroke", "heat stroke",
	"suicid", "kill myself", "carbon monoxide", "gas leak", "smell gas", "house fire", "on fire", "electrocut",
	"head injury", "hit their head", "hit his head", "hit her head", "broken neck", "neck injury", "can't move",
	"severe allergic", "epipen", "blue lips", "turning blue", "911",
}

// Intent is what kind of answer a question wants.
type Intent string

const (
	IntentAny      Intent = ""
	IntentHowTo    Intent = "howto"    // how do I…, steps
	IntentDefine   Intent = "define"   // what is…, tell me about…
	IntentWhenHelp Intent = "whenhelp" // when should I see a doctor / go to the ER
	IntentSigns    Intent = "signs"    // signs, symptoms, how do I know
	IntentAmount   Intent = "amount"   // how much, how many, how long, how far, how often
	IntentSafe     Intent = "safe"     // can I eat, is it safe, poisonous
	IntentWhere    Intent = "where"    // where does it live / grow / where to find
	IntentWhy      Intent = "why"      // why…
	IntentPrevent  Intent = "prevent"  // how to avoid / prevent
	IntentCompare  Intent = "compare"  // difference between A and B, A vs B
)

// headingHints are headings that fit an intent; a passage under one of them
// gets a bonus.
var headingHints = map[Intent][]string{
	IntentHowTo:    {"what to do", "how to", "steps", "step by step", "home care", "treatment", "treat", "first aid", "do this", "method", "making", "building", "instructions", "basics", "getting started", "use", "using"},
	IntentDefine:   {"overview", "description", "about", "what is", "summary", "introduction", "characteristics", "identification"},
	IntentWhenHelp: {"see a doctor", "urgent care", "call 911", "go to the er", "get help", "when to", "emergency", "danger", "warning signs", "red flags", "seek", "medical help", "call poison control"},
	IntentSigns:    {"signs", "symptoms", "how to tell", "recognize", "recognizing", "identify", "identification", "what it looks like", "looks like", "spotting", "diagnosis"},
	IntentAmount:   {"how much", "how many", "how long", "times", "amounts", "quantities", "dosing", "dose", "doses", "chart", "table", "at a glance", "schedule", "storage times", "processing times"},
	IntentSafe:     {"edible", "eat", "safety", "toxicity", "toxic", "poison", "dangerous", "look-alikes", "lookalikes", "don't eat", "avoid", "culinary", "uses", "food"},
	IntentWhere:    {"distribution", "habitat", "range", "where", "found", "location", "geography", "where to find", "finding"},
	IntentWhy:      {"why", "cause", "causes", "reason", "how it works", "function", "physiology", "mechanism", "formation", "structure", "process"},
	IntentPrevent:  {"prevention", "prevent", "avoid", "avoiding", "before", "prepare", "preparing", "protect", "protection"},
}

// IsStopWord reports whether a word carries no topic.
func IsStopWord(w string) bool { return stopWords[w] }

func setOf(s string) map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.Fields(s) {
		m[w] = true
	}
	return m
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// everyday are ways people say things that the notes say differently. The
// question is searched as if it used the notes' words ("charley horse" ->
// muscle cramp); the words asked still count for phrases and spelling.
var everyday = []struct {
	re   *regexp.Regexp
	with string
}{
	{regexp.MustCompile(`\bcharley ?horses?\b`), "muscle cramp"},
	{regexp.MustCompile(`\bback(ing|ed)? up\b`), "backup back up"},
	{regexp.MustCompile(`\b(threw|throw|thrown|hurt|pulled|tweaked) (out )?(my|his|her|their|your) back\b`), "back pain"},
	{regexp.MustCompile(`\b(burns?|burning|hurts?|stings?) when (i|you|he|she|they|we) (pee|urinate)s?\b`), "urinary tract infection"},
	{regexp.MustCompile(`\btext(ing)? 911\b`), "emergency sos satellite text 911"},
	{regexp.MustCompile(`\bwell (water|pump|head|cap|casing|test(ing)?)\b|\b(test|testing) (the |my |our )?well\b`), "wells well water"},
	{regexp.MustCompile(`\bwhat temp(erature)?\b|\btemp\b`), "temperature"},
	{regexp.MustCompile(`\b(is|are) (it|the \w+|\w+) (done|cooked)\b|\bdone cooking\b|\bcooked (through|enough)\b`), "safe cooking temperature"},
	{regexp.MustCompile(`\b(power|electricity|lights) (goes|went|is|are|go|has gone) (out|off)\b|\blost power\b|\bno power\b`), "power outage"},
	{regexp.MustCompile(`\b(can't|cannot|can not) keep (anything|food|water|it|liquids?) down\b`), "vomiting"},
	{regexp.MustCompile(`\b(throwing|threw) up\b|\bpuking\b`), "vomiting"},
	{regexp.MustCompile(`\b(rolled|twisted|turned) (my |his |her |their |an? |the )?ankle\b`), "ankle sprain"},
	{regexp.MustCompile(`\bbug bites?\b`), "insect bite"},
	{regexp.MustCompile(`\bnits\b`), "lice"},
	{regexp.MustCompile(`\bsmoke detectors?\b`), "smoke alarm"},
	{regexp.MustCompile(`\bco detectors?\b|\bcarbon monoxide detectors?\b`), "co alarm"},
	{regexp.MustCompile(`\bno hot water\b|\bhot water (is )?(out|gone|cold)\b`), "water heater no hot water"},
	{regexp.MustCompile(`\bnorthern lights\b|\bsouthern lights\b`), "aurora"},
	{regexp.MustCompile(`\bred planet\b`), "mars"},
	{regexp.MustCompile(`\b(face|mouth|smile) (is )?droop(ing|y|s)?\b|\bdrooping face\b`), "stroke face drooping"},
	{regexp.MustCompile(`\b(dropped|fell) (my |the )?(phone|iphone)( \w+)? (in|into) (the )?(water|pool|toilet|lake|sink|tub)\b|\b(phone|iphone)( \w+)? (got|is|was) wet\b`), "phone water liquid exposure"},
	{regexp.MustCompile(`\b(storage|disk|drive) (is )?full\b|\bout of (storage|space)\b|\bno (storage|space) left\b`), "free up storage full"},
	{regexp.MustCompile(`\b(freezing|cold|can't get warm) (at night )?(in (the|my) (tent|sleeping bag|hammock))\b|\b(freezing|cold) at night (camping|in the tent)\b`), "sleeping warm cold night"},
	{regexp.MustCompile(`\b(thunder|lightning|thunderstorm)( \w+)? (while|when) (i'm |im |we're |you're )?(hiking|camping|outside|on a hike|on the trail)\b`), "thunderstorms lightning safety hiking"},
	{regexp.MustCompile(`\b(something|animal|predator|fox|coyote|raccoon|hawk|owl)s? (keeps? |is )?(getting|killing|eating|taking|attacking) (my |the )?(chickens|hens|ducks|birds|flock)\b`), "predator protection chickens"},
	{regexp.MustCompile(`\bjump(-| )?start(ing)?\b|\bjump (my|the|a) (car|truck|van|suv|battery|honda|toyota|ford|chevy|jeep|civic|accord|pilot|camry|corolla|silverado|cruze|malibu)\b`), "jump starting"},
	{regexp.MustCompile(`\b(won't|doesn't|will not) start\b|\bjust clicks\b`), "won't start"},
	{regexp.MustCompile(`\bcheck engine light\b|\bcel\b`), "check engine codes"},
	{regexp.MustCompile(`\bbleeding (won't|will not|doesn't|does not) stop\b|\b(won't|will not) stop bleeding\b`), "heavy bleeding"},
	{regexp.MustCompile(`\bhit (my|his|her|their|the) head\b|\bbumped (my|his|her|their) head\b`), "head bump concussion"},
	{regexp.MustCompile(`\b(eyes?) (is |are )?(red|pink) and (crusty|goopy|gunky)\b|\bcrusty eyes?\b|\bgoopy eyes?\b`), "pink eye"},
	{regexp.MustCompile(`\b(fingers|toes|hands|feet|nose|ears) (are |is |went |go )?(numb|white|waxy)\b`), "frostbite cold exposure"},
	{regexp.MustCompile(`\b(chickens|hens) (stopped|quit|aren't|not) laying\b`), "chickens egg laying"},
	{regexp.MustCompile(`\bbathroom\b|\btoilet\b( when| with no| without)`), "sanitation toilet"},
	{regexp.MustCompile(`\bwhich way is north\b|\bfind north\b`), "finding direction north"},
	{regexp.MustCompile(`\b(tylenol|acetaminophen|paracetamol)\b`), "acetaminophen tylenol"},
	{regexp.MustCompile(`\b(advil|motrin)\b`), "ibuprofen"},
	{regexp.MustCompile(`\b(aleve)\b`), "naproxen"},
	{regexp.MustCompile(`\bpee\b|\bpeeing\b`), "urine urinary"},
	{regexp.MustCompile(`\b(poop|pee|go to the bathroom|go potty)( \w+)? (in the woods|outside|outdoors|camping|on the trail|in the backcountry)\b`), "human waste cathole"},
	{regexp.MustCompile(`\bcan't sleep\b|\binsomnia\b`), "trouble sleeping"},
	{regexp.MustCompile(`\b(gets?|getting|runs?|running|feels?) (really |very |super |too |so )?(hot|warm)\b|\boverheat(s|ing)?\b`), "hot overheating"},
	{regexp.MustCompile(`\bwon't (turn|power) on\b|\bdead and won't\b`), "won't turn on"},
	{regexp.MustCompile(`\bwon't charge\b|\bnot charging\b`), "won't charge"},
	{regexp.MustCompile(`\btwo monitors\b|\bsecond (monitor|screen|display)\b|\bexternal (monitor|screen)s?\b`), "external displays monitor"},
	{regexp.MustCompile(`\b(keeps )?restarting by itself\b|\brandom(ly)? restarts?\b|\bkernel panic\b`), "restarts kernel panics"},
	{regexp.MustCompile(`\bno (cell )?(service|signal|bars)\b`), "no service"},
	{regexp.MustCompile(`\b(sos|satellite)\b`), "emergency sos satellite"},
	{regexp.MustCompile(`\bwhich (iphone|model|mac|macbook)\b`), "identification model"},
	{regexp.MustCompile(`\bads?\b( are)? (not )?(getting |being )?block`), "ad blocking adguard"},
	{regexp.MustCompile(`\bbears?\b.*\b(food|hang|bag|canister)\b|\b(hang|store) (my |the )?food\b`), "storing food bears"},
}

// troubleWords are things that happen to people and things: a question with
// one wants what to do about it.
var troubleWords = setOf(`sting stings stung bite bites bitten burn burns burned burnt cut cuts sliced rash
fever pain hurts hurting ache aching sore swollen swelling bleeding bleed broke broken sprained sprain
twisted cough coughing vomiting diarrhea dizzy fainted choking leak leaking leaks clogged stuck jammed
squeak squeaky squealing grinding rattling noise smell smells flat dead overheating overheated frozen
froze cracked chirping beeping won't can't isn't doesn't stopped losing dying drains draining
crashing crashes freezes restarting itchy itching numb infected infection lice nits poisoned`)

// forms are words whose other forms the index's stemmer keeps apart ("bit"
// and "bite", "froze" and "freeze"). Any of them finds all of them, as the
// same word rather than a related one.
var formGroups = [][]string{
	{"bite", "bit", "bitten", "bites", "biting"},
	{"sting", "stung", "stings", "stinging"},
	{"burn", "burnt", "burned", "burns", "burning"},
	{"break", "broke", "broken", "breaks"},
	{"freeze", "froze", "frozen", "freezes", "freezing"},
	{"bleed", "bled", "bleeds", "bleeding"},
	{"swell", "swollen", "swelled", "swelling"},
	{"fall", "fell", "fallen", "falls"},
	{"eat", "ate", "eaten", "eats", "eating"},
	{"drink", "drank", "drunk", "drinks", "drinking"},
	{"throw", "threw", "thrown", "throws"},
	{"tear", "tore", "torn", "tears"},
	{"grow", "grew", "grown", "grows", "growing"},
	{"feed", "fed", "feeds", "feeding"},
	{"hang", "hung", "hangs", "hanging"},
	{"sleep", "slept", "sleeps", "sleeping"},
	{"wear", "wore", "worn", "wears"},
	{"drive", "drove", "driven", "drives", "driving"},
	{"catch", "caught", "catches", "catching"},
	{"build", "built", "builds", "building"},
	{"shake", "shook", "shaken", "shaking"},
	{"spill", "spilt", "spilled", "spills"},
	{"choke", "choked", "chokes", "choking"},
	{"leak", "leaked", "leaks", "leaking", "leaky"},
	{"die", "died", "dies", "dying", "dead"},
	{"tooth", "teeth"},
	{"foot", "feet"},
	{"child", "children"},
	{"mouse", "mice"},
	{"goose", "geese"},
	{"knife", "knives"},
	{"leaf", "leaves"},
	{"wolf", "wolves"},
	{"louse", "lice"},
}

var forms = func() map[string][]string {
	m := map[string][]string{}
	for _, g := range formGroups {
		for _, w := range g {
			m[w] = g
		}
	}
	return m
}()

// sameWord reports whether two words are the same word in different forms.
func sameWord(a, b string) bool {
	if a == b {
		return true
	}
	if g := forms[a]; g != nil && contains(g, b) {
		return true
	}
	sa, sb := stemOf(a), stemOf(b)
	return len(sa) >= 3 && sa == sb
}

// kinds are what people call a thing by its kind: "my SUV", "the laptop".
// A kind word names the folder of a thing of that kind ("suv" -> Vehicles/
// 2015 Honda CR-V), the way the thing's own name would. One way
// only: asking about a CR-V isn't asking about every SUV. Words for all of
// them ("car", "phone") are left to the synonyms: "stuck in my car in a
// snowstorm" isn't about the car's own pages.
var kinds = map[string][]string{
	"suv": {"pilot", "cr-v", "crv", "hr-v", "passport", "rav4", "highlander", "4runner", "sequoia", "explorer", "escape", "expedition", "bronco", "edge",
		"tahoe", "suburban", "equinox", "traverse", "blazer", "trailblazer", "trax", "yukon", "acadia", "terrain", "rogue", "pathfinder", "murano", "armada",
		"wrangler", "cherokee", "compass", "renegade", "durango", "forester", "outback", "crosstrek", "ascent", "cx-5", "cx-9", "cx-30", "cx-50", "santa fe",
		"tucson", "palisade", "kona", "sorento", "telluride", "sportage", "tiguan", "atlas", "model y", "model x", "rdx", "mdx", "rx350", "x3", "x5", "q5", "q7"},
	"truck": {"f-150", "f150", "f-250", "f250", "silverado", "sierra", "ram", "tacoma", "tundra", "colorado", "canyon", "ranger", "frontier", "titan", "ridgeline",
		"maverick", "gladiator", "cybertruck"},
	"minivan": {"odyssey", "sienna", "pacifica", "caravan", "grand caravan", "carnival", "sedona", "town and country"},
	"sedan": {"civic", "accord", "camry", "corolla", "avalon", "cruze", "malibu", "impala", "sonic", "altima", "sentra", "maxima", "versa", "fusion", "focus",
		"taurus", "elantra", "sonata", "optima", "forte", "k5", "jetta", "passat", "mazda3", "mazda6", "impreza", "legacy", "charger", "model 3", "model s",
		"prius", "insight"},
	"laptop":   {"macbook", "thinkpad", "chromebook", "xps", "zenbook", "ideapad", "inspiron"},
	"computer": {"macbook", "imac", "mac mini", "mac studio", "mac pro", "thinkpad", "chromebook", "xps"},
	"mac":      {"macbook", "imac", "mac mini", "mac studio", "mac pro"},
	"tablet":   {"ipad", "kindle fire", "galaxy tab"},
	"console":  {"xbox", "playstation", "ps4", "ps5", "nintendo", "steam deck", "wii"},
	"watch":    {"apple watch", "garmin", "fitbit"},
	"tv":       {"apple tv", "roku", "fire tv", "chromecast", "google tv"},
}

// vehicleKinds are the kinds whose names are everyday words too ("Pilot",
// "Escape", "Ram"): they name a folder only if it also has a make or a year.
var vehicleKinds = setOf(`suv truck pickup minivan van sedan`)

var makeOrYear = regexp.MustCompile(`\b((19|20)\d\d|honda|toyota|ford|chevy|chevrolet|gmc|nissan|jeep|dodge|ram|subaru|mazda|hyundai|kia|volkswagen|vw|tesla|bmw|audi|lexus|acura|buick|cadillac|chrysler|mercedes|volvo|lincoln|infiniti|mitsubishi)\b`)

func init() {
	kinds["pickup"] = kinds["truck"]
	kinds["van"] = kinds["minivan"]
	kinds["notebook"] = kinds["laptop"]
	kinds["macos"] = kinds["mac"]
	kinds["game console"] = kinds["console"]
}

// kindOf lists the folders, of those given, named for a thing of the kind a
// word says ("laptop" -> Devices/MacBook Air). Folders inside one
// already found are left out.
func kindOf(word string, folders []string) []string {
	names := kinds[word]
	if names == nil && strings.HasSuffix(word, "s") {
		names = kinds[strings.TrimSuffix(word, "s")]
	}
	if names == nil {
		return nil
	}
	vehicle := vehicleKinds[word] || vehicleKinds[strings.TrimSuffix(word, "s")]
	var out []string
	for _, f := range folders {
		if len(out) > 0 && strings.HasPrefix(f, out[len(out)-1]+"/") {
			continue
		}
		base := f
		if i := strings.LastIndexByte(f, '/'); i >= 0 {
			base = f[i+1:]
		}
		name := " " + strings.Join(words(strings.ToLower(base)), " ") + " "
		if vehicle && !makeOrYear.MatchString(name) {
			continue
		}
		for _, n := range names {
			if strings.Contains(name, " "+n+" ") {
				out = append(out, f)
				break
			}
		}
	}
	return out
}
