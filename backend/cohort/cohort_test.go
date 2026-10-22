package cohort

import (
	"context"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// account builds the participant reference of a signed-in account.
func account(id string) online.ParticipantRef {
	return online.ParticipantRef{Kind: online.ParticipantAccount, ID: id}
}

// guest builds the participant reference of a guest.
//
// A guest identity is an opaque identifier that never names an account, and
// the cohort must never compare it with one.
func guest(id string) online.ParticipantRef {
	return online.ParticipantRef{Kind: online.ParticipantGuest, ID: id}
}

// The parser is well defined: it trims the tokens, ignores the empty ones
// and keeps one copy of a repeated identifier.
func TestTheCohortParserTrimsIgnoresEmptyTokensAndKeepsOneCopy(t *testing.T) {
	parsed := Parse(" user_a , ,user_b,user_a,, user_c ")
	if got := parsed.Accounts(); len(got) != 3 || got[0] != "user_a" || got[1] != "user_b" || got[2] != "user_c" {
		t.Fatalf("the parsed accounts = %v, want [user_a user_b user_c]", got)
	}
	if parsed.Empty() {
		t.Fatal("a cohort with accounts is empty")
	}
	// An empty setting is the empty cohort, and it is the default of the
	// server configuration.
	empty := Parse("")
	if !empty.Empty() {
		t.Fatal("an empty setting is not the empty cohort")
	}
	if got := empty.Accounts(); len(got) != 0 {
		t.Fatalf("the empty cohort names %v", got)
	}
	// A setting of separators alone is the empty cohort as well.
	if !Parse(" , , ").Empty() {
		t.Fatal("a setting of separators alone is not the empty cohort")
	}
}

// The empty cohort admits every signed-in account.
func TestTheCohortAdmitsEveryAccountWhenItIsEmpty(t *testing.T) {
	empty := Parse("")
	if !empty.Allows(account("user_anybody")) {
		t.Fatal("the empty cohort refused an account")
	}
	allowed, err := empty.AccountAllowed(context.Background(), account("user_anybody"))
	if err != nil || !allowed {
		t.Fatalf("the empty cohort refused an account: %v %v", allowed, err)
	}
}

// A cohort admits exactly the accounts it names.
func TestTheCohortAdmitsOnlyTheAccountsItNames(t *testing.T) {
	parsed := Parse("user_a,user_b")
	if !parsed.Allows(account("user_a")) || !parsed.Allows(account("user_b")) {
		t.Fatal("a named account was refused")
	}
	if parsed.Allows(account("user_c")) {
		t.Fatal("an account outside the cohort was admitted")
	}
}

// A cohort never excludes a guest.
//
// The guest rule of the friend surface requires a guest to be able to create
// a friend link and to accept an invitation that was issued while friend play
// was enabled, so no cohort may refuse a guest, whatever it names.
func TestTheCohortNeverExcludesAGuest(t *testing.T) {
	parsed := Parse("user_a")
	if !parsed.Allows(guest("guest_0123456789")) {
		t.Fatal("the cohort refused a guest")
	}
	if !parsed.Allows(guest("user_a")) {
		t.Fatal("the cohort refused a guest that shares the identifier of an account")
	}
	// A guest without an identity is admitted as well.
	if !parsed.Allows(online.ParticipantRef{}) {
		t.Fatal("the cohort refused a participant without an identity")
	}
	allowed, err := parsed.AccountAllowed(context.Background(), guest("guest_0123456789"))
	if err != nil || !allowed {
		t.Fatalf("the cohort refused a guest: %v %v", allowed, err)
	}
}

// The accounts of a cohort are a copy, so a caller cannot change the cohort
// of the process.
func TestTheCohortAccountsAreACopy(t *testing.T) {
	parsed := Parse("user_a,user_b")
	accounts := parsed.Accounts()
	accounts[0] = "user_changed"
	if parsed.Accounts()[0] != "user_a" {
		t.Fatal("the cohort was changed through the returned slice")
	}
}
