// Package auth holds password hashing, TOTP and recovery codes.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters, after OWASP's recommendation for a server login.
const (
	argonTime    = 3
	argonMemory  = 64 * 1024
	argonThreads = 2
	argonKeyLen  = 32
)

// MinPasswordLen is enforced for new passwords.
const MinPasswordLen = 10

var ErrMalformed = errors.New("malformed hash")

func HashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	b64 := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, argonMemory, argonTime, argonThreads, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

func VerifyPassword(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, ErrMalformed
	}
	var m uint32
	var t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false, ErrMalformed
	}
	b64 := base64.RawStdEncoding
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return false, ErrMalformed
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil {
		return false, ErrMalformed
	}
	got := argon2.IDKey([]byte(password), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// RandomString returns n random characters from an unambiguous alphabet.
func RandomString(n int) string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	for i, b := range buf {
		buf[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(buf)
}

// ── TOTP (RFC 6238: SHA-1, 6 digits, 30 s) ──

func NewTOTPSecret() string {
	buf := make([]byte, 20)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf)
}

func totpAt(secret string, step int64) (string, error) {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(secret))
	if err != nil {
		return "", err
	}
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(step))
	mac := hmac.New(sha1.New, key)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	code := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", code%1_000_000), nil
}

// TOTPCode is the code for a moment in time, as an authenticator app shows it.
func TOTPCode(secret string, t time.Time) string {
	c, _ := totpAt(secret, t.Unix()/30)
	return c
}

// CheckTOTP accepts the code for the current 30-second step or the one either
// side of it, and returns the step it matched so callers can refuse a replay.
func CheckTOTP(secret, code string, now time.Time) (int64, bool) {
	code = strings.ReplaceAll(strings.TrimSpace(code), " ", "")
	if len(code) != 6 {
		return 0, false
	}
	step := now.Unix() / 30
	for _, s := range []int64{step, step - 1, step + 1} {
		want, err := totpAt(secret, s)
		if err == nil && subtle.ConstantTimeCompare([]byte(want), []byte(code)) == 1 {
			return s, true
		}
	}
	return 0, false
}

func TOTPURI(secret, account string) string {
	label := strings.NewReplacer(" ", "%20", ":", "").Replace(account)
	return fmt.Sprintf("otpauth://totp/Quire:%s?secret=%s&issuer=Quire&algorithm=SHA1&digits=6&period=30", label, secret)
}

// ── Recovery codes ──

// RecoveryCodes returns n codes like "K7F2-9QXD" and their hashes.
func RecoveryCodes(n int) (codes, hashes []string) {
	for range n {
		c := RandomString(8)
		c = c[:4] + "-" + c[4:]
		codes = append(codes, c)
		hashes = append(hashes, HashCode(c))
	}
	return codes, hashes
}

func HashCode(code string) string {
	norm := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(code), "-", ""))
	sum := sha256.Sum256([]byte(norm))
	return hex.EncodeToString(sum[:])
}
