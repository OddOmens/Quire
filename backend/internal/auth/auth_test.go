package auth

import (
	"testing"
	"time"
)

func TestPassword(t *testing.T) {
	h, err := HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if ok, _ := VerifyPassword("correct horse battery", h); !ok {
		t.Fatal("right password rejected")
	}
	if ok, _ := VerifyPassword("wrong", h); ok {
		t.Fatal("wrong password accepted")
	}
}

func TestTOTP(t *testing.T) {
	// RFC 6238 test vector: secret "12345678901234567890", T=59 → 287082.
	secret := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	if _, ok := CheckTOTP(secret, "287082", time.Unix(59, 0)); !ok {
		t.Fatal("RFC vector rejected")
	}
	if _, ok := CheckTOTP(secret, "287082", time.Unix(59+300, 0)); ok {
		t.Fatal("stale code accepted")
	}
}

func TestRecovery(t *testing.T) {
	codes, hashes := RecoveryCodes(3)
	if HashCode(codes[1]) != hashes[1] || HashCode(" "+codes[1][:4]+codes[1][5:]+" ") != hashes[1] {
		t.Fatal("recovery code hash mismatch")
	}
}
