package serverapp

import (
	"strings"
	"testing"
)

func TestLoadFailsClosedAndDoesNotEchoValues(t *testing.T) {
	_, err := Load(func(string) string { return "secret-canary" })
	if err == nil || strings.Contains(err.Error(), "secret-canary") {
		t.Fatal("invalid configuration was accepted or disclosed")
	}
}

func TestLoadNormalizesOriginLists(t *testing.T) {
	values := map[string]string{
		"DATABASE_URL":             "postgres://local/fixture",
		"CLERK_ISSUER":             "https://fixture.clerk.accounts.dev",
		"CLERK_JWKS_URL":           "https://fixture.clerk.accounts.dev/.well-known/jwks.json",
		"CLERK_AUTHORIZED_PARTIES": " https://chess.example,https://chess.example ",
		"APP_ALLOWED_ORIGINS":      "https://chess.example,,https://staging.example",
	}
	cfg, err := Load(func(key string) string { return values[key] })
	if err != nil || len(cfg.Clerk.AuthorizedParties) != 1 || len(cfg.Clerk.AllowedOrigins) != 2 {
		t.Fatalf("normalization failed: %v", err)
	}
}
