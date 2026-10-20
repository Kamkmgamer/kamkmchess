package invite

import (
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// TestTheAcceptanceKeyShape covers the capability that resumes an
// acceptance.
func TestTheAcceptanceKeyShape(t *testing.T) {
	if err := validateAcceptanceKey("0123456789abcdef"); err != nil {
		t.Fatalf("a valid acceptance key was refused: %v", err)
	}
	for _, invalid := range []string{"", "short", "with space 1234567890", "with/slash/1234567890"} {
		if err := validateAcceptanceKey(invalid); err == nil {
			t.Fatalf("the malformed acceptance key %q was accepted", invalid)
		}
	}
}

// TestTheFriendSeatControlHasNoEngineSeat covers the friend setup rule.
//
// There is no built-in engine seat in friend play, and a human seat never
// declares a model.
func TestTheFriendSeatControlHasNoEngineSeat(t *testing.T) {
	if err := validateSeatControl(online.SeatControl{Kind: online.ControlHuman}); err != nil {
		t.Fatalf("a human seat was refused: %v", err)
	}
	if err := validateSeatControl(online.SeatControl{Kind: online.ControlHuman, ModelLabel: stringPointer("Model")}); err == nil {
		t.Fatal("a human seat with a model was accepted")
	}
	label := "Declared Model"
	if err := validateSeatControl(online.SeatControl{Kind: online.ControlAgent, ModelLabel: &label}); err != nil {
		t.Fatalf("an agent seat was refused: %v", err)
	}
	if err := validateSeatControl(online.SeatControl{Kind: online.ControlAgent}); err == nil {
		t.Fatal("an agent seat without a public model label was accepted")
	}
	if err := validateSeatControl(online.SeatControl{Kind: online.ControlEngine, ModelLabel: &label}); err == nil {
		t.Fatal("an engine seat was accepted in friend setup")
	}
}

// TestThePublicLabelRejectsAnEmailOrAnEndpoint covers the published label
// rules.
func TestThePublicLabelRejectsAnEmailOrAnEndpoint(t *testing.T) {
	for _, valid := range []string{"Alice", "player_1", "Guest"} {
		if err := validatePublicLabel(valid); err != nil {
			t.Fatalf("the label %q was refused: %v", valid, err)
		}
	}
	for _, invalid := range []string{"", " alice", "alice@example.com", "https://example.com", "line\nbreak"} {
		if err := validatePublicLabel(invalid); err == nil {
			t.Fatalf("the label %q was accepted", invalid)
		}
	}
}

// TestTheAcceptanceKeyIsStoredOnlyAsAHash covers the stored capability.
func TestTheAcceptanceKeyIsStoredOnlyAsAHash(t *testing.T) {
	key := "0123456789abcdef"
	hash := hashAcceptanceKey(key)
	if len(hash) != 32 {
		t.Fatalf("the acceptance key hash is %d bytes", len(hash))
	}
	if subtleEqual(hash, []byte(key)) {
		t.Fatal("the stored hash is the key itself")
	}
	if !subtleEqual(hash, hashAcceptanceKey(key)) {
		t.Fatal("the hash is not stable")
	}
	if subtleEqual(hash, hashAcceptanceKey("0123456789abcdeg")) {
		t.Fatal("two different keys share a hash")
	}
	if subtleEqual(hashOwnerToken("owner"), hashAcceptanceKey("owner")) {
		t.Fatal("the owner token and the acceptance key share a stored value")
	}
}

// stringPointer returns a pointer to a copy of the value.
func stringPointer(value string) *string {
	return &value
}
