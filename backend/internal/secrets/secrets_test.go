package secrets

import (
	"strings"
	"testing"
)

// Test values are assembled from pieces so the source file itself doesn't
// trip secret scanners.
var (
	ghToken = "ghp" + "_" + "R8xk2LmQ9vTz4NcW7pYb1HsJ6dFa3GeU0iKo"
	wgKey   = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk="
)

func TestScan(t *testing.T) {
	for _, tc := range []struct {
		name    string
		line    string
		kind    string // "" means nothing should be found
		preview string
	}{
		{"tailscale", "TS key: tskey-auth-kQ3bXy7CNTRL-9fJ2mVhW4pLr8sTzD1nE6", "tailscale-key", "tske•••"},
		{"tailscale placeholder", "tskey-auth-xxxxxxxxxxxxxxxxxxxxxxxx", "", ""},
		{"github classic", "token " + ghToken, "github-token", "ghp_•••"},
		{"github fine-grained", "github_pat_11ABCDEFG0aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9fG1hJ3", "github-token", "gith•••"},
		{"aws", "aws_access_key_id = AKIAQ7XZ4MPL2VB8RT6N", "aws-key", "AKIA•••"},
		{"aws example word", "AKIAIOSFODNN7EXAMPLE", "", ""},
		{"slack", "xoxb-2048-1234567890-Rk3mVz8QpLw2", "slack-token", "xoxb•••"},
		{"stripe", "sk_live_51Hq8ZkLmN2pQ4rS6tU8vW0x", "stripe-key", "sk_l•••"},
		{"stripe publishable", "pk_live_51Hq8ZkLmN2pQ4rS6tU8vW0x", "", ""},
		{"wireguard", "PrivateKey = " + wgKey, "wireguard-key", "yAnz•••"},
		{"wireguard placeholder", "PrivateKey = <server private key>", "", ""},
		{"wireguard public key", "PublicKey = " + wgKey, "", ""},
		// Phone numbers aren't secrets.
		{"phone", "Call +14155552671 after hours", "", ""},
		{"env password", "DB_PASSWORD=Xk9mP2vL7qR4wT8z", "credential", "Xk9m•••"},
		{"yaml secret", "  client_secret: \"3f9a1c7e5b2d8046af13ce97b5d2e8f0\"", "credential", "3f9a•••"},
		{"bold label in prose", "**API key:** `sk-proj-8Hn2Kq5Vx1Zt7Lm3`", "credential", "sk-p•••"},
		{"export", "export TS_AUTHKEY=k8Jd93hFq2LmZx7Pw4", "credential", "k8Jd•••"},
		{"env var reference", "DB_PASSWORD=${DB_PASSWORD}", "", ""},
		{"shell reference", "API_TOKEN=$API_TOKEN", "", ""},
		{"angle placeholder", "SECRET_KEY=<generate with openssl rand>", "", ""},
		{"changeme", "ADMIN_PASSWORD=changeme123456", "", ""},
		{"redacted", "token: <redacted>", "", ""},
		{"dots", "password: ...", "", ""},
		{"empty", "PASSWORD=", "", ""},
		{"short", "password: hunter2", "", ""},
		{"no digits", "password: correcthorsebatterystaple", "", ""},
		{"name only", "The backup uses `COFFER_TOKEN` from the env file.", "", ""},
		{"file reference", "TOKEN_FILE=/run/secrets/quire_token_2026", "", ""},
		{"path value", "secret: /etc/quire/secret.key", "", ""},
		{"url value", "credentials: op://Servers/Quire/password1", "", ""},
		{"prose", "Rotate the token every 90 days.", "", ""},
		{"opt-out key", "secrets: ok", "", ""},
	} {
		got := Scan(tc.line)
		if tc.kind == "" {
			if len(got) != 0 {
				t.Errorf("%s: found %+v in %q", tc.name, got, tc.line)
			}
			continue
		}
		if len(got) != 1 || got[0].Kind != tc.kind || got[0].Preview != tc.preview || got[0].Line != 1 {
			t.Errorf("%s: got %+v, want %s %q", tc.name, got, tc.kind, tc.preview)
		}
	}
}

func TestPrivateKey(t *testing.T) {
	real := "Notes\n\n```\n-----BEGIN OPENSSH PRIVATE KEY-----\n" +
		"b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n" +
		"-----END OPENSSH PRIVATE KEY-----\n```\n"
	got := Scan(real)
	if len(got) != 1 || got[0].Kind != "private-key" || got[0].Line != 4 {
		t.Errorf("real key: %+v", got)
	}
	for _, doc := range []string{
		"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----",
		"-----BEGIN RSA PRIVATE KEY-----\n(kept in Coffer, not here)\n-----END RSA PRIVATE KEY-----",
		"The file starts with -----BEGIN PRIVATE KEY----- and that's all.",
	} {
		if got := Scan(doc); len(got) != 0 {
			t.Errorf("placeholder key flagged: %+v", got)
		}
	}
}

func TestScanNeverReturnsTheValue(t *testing.T) {
	page := "# Server\n\nDB_PASSWORD=Xk9mP2vL7qR4wT8z\n" + ghToken + "\n"
	got := Scan(page)
	if len(got) != 2 || got[0].Line != 3 || got[1].Line != 4 {
		t.Fatalf("findings: %+v", got)
	}
	for _, f := range got {
		if strings.Contains(f.Preview, "Xk9mP2vL") || strings.Contains(f.Preview, ghToken[:8]) || strings.Contains(f.Label, "Xk9m") {
			t.Errorf("finding leaks the value: %+v", f)
		}
	}
}

func TestScanCaps(t *testing.T) {
	page := strings.Repeat(ghToken+"\n", MaxFindings+5)
	if got := Scan(page); len(got) != MaxFindings {
		t.Errorf("findings = %d, want %d", len(got), MaxFindings)
	}
}
