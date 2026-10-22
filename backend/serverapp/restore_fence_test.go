package serverapp

import (
	"context"
	"strings"
	"testing"
)

// fenceTestValues are the settings of a valid server configuration.
//
// The durable restore fence is part of a valid configuration, so it is here.
func fenceTestValues() map[string]string {
	return map[string]string{
		"DATABASE_URL":              "postgres://local/fixture",
		"CLERK_ISSUER":              "https://fixture.clerk.accounts.dev",
		"CLERK_JWKS_URL":            "https://fixture.clerk.accounts.dev/.well-known/jwks.json",
		"CLERK_AUTHORIZED_PARTIES":  "https://chess.example",
		"APP_ALLOWED_ORIGINS":       "https://chess.example",
		"ONLINE_RESTORE_FENCE_PATH": "/var/lib/kamkmchess/restore-fence",
	}
}

// The durable restore fence is not an optional setting.
//
// The fence lives outside the restored database, so the service can observe a
// restore that is running. A service without the setting never observes the
// fence at all, so it would serve a restored database whose removal ledger
// was never replayed. The absence of the setting fails closed.
//
// The error never discloses a configured value: the path is operator
// material.
func TestLoadRefusesAMissingRestoreFencePath(t *testing.T) {
	values := fenceTestValues()
	values["DATABASE_URL"] = "postgres://secret-canary/fixture"
	// The setting is absent, blank and whitespace only. None of them is a
	// fence.
	for _, blank := range []string{"", " ", "   ", "\t\n"} {
		values["ONLINE_RESTORE_FENCE_PATH"] = blank
		_, err := Load(func(key string) string { return values[key] })
		if err == nil {
			t.Fatalf("a configuration with the fence path %q was accepted", blank)
		}
		if strings.Contains(err.Error(), "secret-canary") {
			t.Fatalf("the error disclosed a configured value: %v", err)
		}
	}
	// The setting is absent altogether.
	delete(values, "ONLINE_RESTORE_FENCE_PATH")
	_, err := Load(func(key string) string { return values[key] })
	if err == nil {
		t.Fatal("a configuration without the fence path was accepted")
	}
	if strings.Contains(err.Error(), "secret-canary") {
		t.Fatalf("the error disclosed a configured value: %v", err)
	}
}

// The configured fence path is loaded into the online configuration.
//
// The value is trimmed, and it is the path the service and the restore tool
// have to share.
func TestLoadReadsTheRestoreFencePath(t *testing.T) {
	values := fenceTestValues()
	values["ONLINE_RESTORE_FENCE_PATH"] = "  /var/lib/kamkmchess/restore-fence  "
	cfg, err := Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Online.RestoreFencePath != "/var/lib/kamkmchess/restore-fence" {
		t.Fatalf("the restore fence path = %q", cfg.Online.RestoreFencePath)
	}
}

// The composition refuses a configuration without the durable restore fence.
//
// The configuration loader refuses the setting already, and the composition
// keeps the guarantee for a configuration that was assembled by hand. The
// refusal happens before the service owns anything, so no resource is
// returned and no configured value is disclosed.
func TestOpenRefusesACompositionWithoutTheRestoreFencePath(t *testing.T) {
	handler, release, err := Open(context.Background(), Config{
		DatabaseURL: "postgres://secret-canary/fixture",
	})
	if err == nil {
		if release != nil {
			release()
		}
		t.Fatal("a composition without the restore fence path was accepted")
	}
	if handler != nil || release != nil {
		t.Fatal("a refused composition returned its resources")
	}
	if strings.Contains(err.Error(), "secret-canary") {
		t.Fatalf("the error disclosed a configured value: %v", err)
	}
}
