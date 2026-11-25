// Package secrets spots what looks like a credential pasted into a page:
// API tokens, private keys and passwords. Pages are plain
// text that ends up in backups, so Quire warns about them. It's a nudge, not
// a gate: rules favour missing a secret over flagging a placeholder.
//
// Findings never carry the matched value, only a masked preview.
package secrets

import (
	"math"
	"regexp"
	"strings"
	"unicode"
)

// Finding is one likely secret.
type Finding struct {
	// Kind is a stable identifier, such as "tailscale-key".
	Kind string `json:"kind"`
	// Label names it for people: "Tailscale key".
	Label string `json:"label"`
	// Line is 1-based, counted in the whole file.
	Line int `json:"line"`
	// Preview is the first few characters and a mask, never the value.
	Preview string `json:"preview"`
}

// MaxFindings caps what Scan returns; one warning is enough to act on.
const MaxFindings = 20

type rule struct {
	kind, label string
	re          *regexp.Regexp
}

// tokens are formats with a recognisable prefix. The last submatch, or the
// whole match without one, is the value.
var tokens = []rule{
	{"tailscale-key", "Tailscale key", regexp.MustCompile(`\btskey-[A-Za-z0-9-]{16,}`)},
	{"github-token", "GitHub token", regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})`)},
	{"aws-key", "AWS access key", regexp.MustCompile(`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`)},
	{"slack-token", "Slack token", regexp.MustCompile(`\bxox[abposr]-[A-Za-z0-9-]{10,}`)},
	{"stripe-key", "Stripe key", regexp.MustCompile(`\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}`)},
	{"wireguard-key", "WireGuard private key", regexp.MustCompile(`(?i)^\s*(?:PrivateKey|PresharedKey)\s*=\s*([A-Za-z0-9+/]{43}=)\s*$`)},
}

var (
	privateKey = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----`)

	// assignment is NAME=value, name: value, "name": "value" and the like,
	// where the name says it holds a credential. Markdown emphasis and
	// backticks around either side are allowed.
	assignment = regexp.MustCompile(`(?i)([a-z0-9_.-]*(?:password|passwd|passphrase|secret|token|api[ _-]?key|auth[ _-]?key|private[ _-]?key|credentials?)[a-z0-9_.-]*)[*"'` + "`" + `]*\s*[:=][\s*"'` + "`" + `]*([^\s"'` + "`" + `,;*]+)`)
	// Names that hold a reference to a credential rather than one.
	referenceName = regexp.MustCompile(`(?i)[_.-](?:file|path|dir|url|name|id|env|ttl|expiry|expires|length|type)$`)
)

// placeholderWords mark example values in documentation.
var placeholderWords = []string{
	"xxxx", "****", "...", "…", "<", ">", "${", "{{", "%(",
	"changeme", "change-me", "change_me", "example", "your", "redacted", "placeholder", "dummy", "replace", "secret-here",
}

// Scan returns likely secrets in a page, at most one per line.
func Scan(content string) []Finding {
	var out []Finding
	lines := strings.Split(content, "\n")
	for i, line := range lines {
		if len(out) >= MaxFindings {
			break
		}
		line = strings.TrimRight(line, "\r")
		if f, ok := scanLine(line, lines[i+1:]); ok {
			f.Line = i + 1
			out = append(out, f)
		}
	}
	return out
}

func scanLine(line string, rest []string) (Finding, bool) {
	for _, r := range tokens {
		for _, m := range r.re.FindAllStringSubmatch(line, -1) {
			v := m[len(m)-1]
			if !placeholder(v) {
				return Finding{Kind: r.kind, Label: r.label, Preview: mask(v)}, true
			}
		}
	}
	if m := privateKey.FindString(line); m != "" && keyFollows(rest) {
		return Finding{Kind: "private-key", Label: "private key", Preview: mask(m)}, true
	}
	for _, m := range assignment.FindAllStringSubmatch(line, -1) {
		name, v := m[1], m[2]
		if referenceName.MatchString(name) || reference(v) || placeholder(v) || !random(v) {
			continue
		}
		return Finding{Kind: "credential", Label: "value of " + name, Preview: mask(v)}, true
	}
	return Finding{}, false
}

// keyFollows reports whether a BEGIN … PRIVATE KEY line is followed by key
// material, not "..." or a note to fetch it elsewhere.
func keyFollows(rest []string) bool {
	for _, l := range rest {
		l = strings.TrimSpace(l)
		// Blank lines, and PEM headers such as "Proc-Type: 4,ENCRYPTED".
		if l == "" || strings.Contains(l, ": ") {
			continue
		}
		// Real keys have runs like "AAAAA", so only marker words count.
		return len(l) >= 40 && !placeholderWord(l) && !strings.ContainsAny(l, " \t")
	}
	return false
}

// reference is a value that points at a credential instead of holding it:
// a variable, a path or a URL.
func reference(v string) bool {
	return strings.HasPrefix(v, "$") || strings.HasPrefix(v, "/") || strings.HasPrefix(v, "~") ||
		strings.HasPrefix(v, "./") || strings.Contains(v, "://")
}

// placeholder spots example values: marker words, and runs of one
// character such as "aaaaa" or "00000".
func placeholder(v string) bool {
	if placeholderWord(v) {
		return true
	}
	low := strings.ToLower(v)
	run := 1
	for i := 1; i < len(low); i++ {
		if low[i] == low[i-1] {
			if run++; run >= 5 {
				return true
			}
		} else {
			run = 1
		}
	}
	return false
}

func placeholderWord(v string) bool {
	low := strings.ToLower(v)
	for _, w := range placeholderWords {
		if strings.Contains(low, w) {
			return true
		}
	}
	return false
}

// random is the test for a value after a credential-like name: long enough,
// with letters and digits, and not too repetitive.
func random(v string) bool {
	if len(v) < 12 {
		return false
	}
	var letter, digit bool
	for _, r := range v {
		letter = letter || unicode.IsLetter(r)
		digit = digit || unicode.IsDigit(r)
	}
	return letter && digit && entropy(v) >= 3.0
}

// entropy is the Shannon entropy of s in bits per character.
func entropy(s string) float64 {
	counts := map[rune]int{}
	n := 0
	for _, r := range s {
		counts[r]++
		n++
	}
	var h float64
	for _, c := range counts {
		p := float64(c) / float64(n)
		h -= p * math.Log2(p)
	}
	return h
}

func mask(v string) string {
	r := []rune(v)
	if len(r) > 4 {
		r = r[:4]
	}
	return string(r) + "•••"
}
