package serverapp

import (
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// serverTestValues are the settings of a valid server configuration.
func serverTestValues() map[string]string {
	return map[string]string{
		"DATABASE_URL":              "postgres://local/fixture",
		"CLERK_ISSUER":              "https://fixture.clerk.accounts.dev",
		"CLERK_JWKS_URL":            "https://fixture.clerk.accounts.dev/.well-known/jwks.json",
		"CLERK_AUTHORIZED_PARTIES":  "https://chess.example",
		"APP_ALLOWED_ORIGINS":       "https://chess.example",
		"ONLINE_RESTORE_FENCE_PATH": "/var/lib/kamkmchess/restore-fence",
	}
}

// The two cohort settings are read by the server.
//
// An unset cohort is the empty cohort, and the empty cohort admits every
// signed-in account, so the default of the configuration is unchanged.
func TestTheCohortSettingsAreLoadedAndDefaultToEveryAccount(t *testing.T) {
	values := serverTestValues()
	cfg, err := Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Online.FriendCohort.Empty() || !cfg.Online.QueueCohort.Empty() {
		t.Fatalf("an unset cohort is not empty: %+v", cfg.Online)
	}
	account := online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_anybody"}
	if !cfg.Online.FriendCohort.Allows(account) || !cfg.Online.QueueCohort.Allows(account) {
		t.Fatal("the empty cohort refused an account")
	}
}

// The cohort settings are parsed the way the contract names them.
//
// Every token is trimmed, an empty token is ignored, and a repeated
// identifier is kept once. The two settings are independent of each other.
func TestTheCohortSettingsAreParsedAndIndependent(t *testing.T) {
	values := serverTestValues()
	values["ONLINE_FRIEND_COHORT"] = " user_a , ,user_b,user_a "
	values["ONLINE_QUEUE_COHORT"] = "user_queue"
	cfg, err := Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	accounts := cfg.Online.FriendCohort.Accounts()
	if len(accounts) != 2 || accounts[0] != "user_a" || accounts[1] != "user_b" {
		t.Fatalf("the friend cohort = %v, want [user_a user_b]", accounts)
	}
	if cfg.Online.FriendCohort.Allows(online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_c"}) {
		t.Fatal("an account outside the friend cohort was admitted")
	}
	if !cfg.Online.QueueCohort.Allows(online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_queue"}) {
		t.Fatal("the queue cohort refused its account")
	}
	if cfg.Online.QueueCohort.Allows(online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_a"}) {
		t.Fatal("the friend cohort widened the queue cohort")
	}
	// A guest is never excluded by either of them.
	guest := online.ParticipantRef{Kind: online.ParticipantGuest, ID: "guest_0123456789"}
	if !cfg.Online.FriendCohort.Allows(guest) || !cfg.Online.QueueCohort.Allows(guest) {
		t.Fatal("a cohort excluded a guest")
	}
}
