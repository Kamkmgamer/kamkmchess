package online

import "testing"

// TestTheAllocatedMatchIdentifierSeparatesTheOwners covers the identifier
// namespace of a trusted allocation.
//
// An operation key can be client supplied, so two different owners may use
// the same key. Their allocations must never name the same match, while a
// retry of one owner must always name the same match.
func TestTheAllocatedMatchIdentifierSeparatesTheOwners(t *testing.T) {
	first := ParticipantRef{Kind: ParticipantAccount, ID: "user_first"}
	second := ParticipantRef{Kind: ParticipantAccount, ID: "user_second"}
	key := "client-request-key-0123456789"

	firstID := AllocatedMatchID(first, key)
	secondID := AllocatedMatchID(second, key)
	if firstID == secondID {
		t.Fatalf("two owners with the same key derived the same match id %q", firstID)
	}
	if again := AllocatedMatchID(first, key); again != firstID {
		t.Fatalf("the retry of one owner derived %q, want %q", again, firstID)
	}
	if !idPattern.MatchString(firstID) {
		t.Fatalf("the derived match id %q does not match the stored shape", firstID)
	}
	// A guest owner is separated from an account owner as well.
	guest := ParticipantRef{Kind: ParticipantGuest, ID: "user_first"}
	if AllocatedMatchID(guest, key) == firstID {
		t.Fatal("a guest owner derived the match id of an account owner")
	}
}

// TestTheAllocationCommandBindsTheCreatorSeat covers the command of a
// trusted allocation.
func TestTheAllocationCommandBindsTheCreatorSeat(t *testing.T) {
	white := ParticipantRef{Kind: ParticipantAccount, ID: "user_white"}
	black := ParticipantRef{Kind: ParticipantAccount, ID: "user_black"}
	setup := CreateMatchSetup{
		Variant:     "orthodox",
		StartingFEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
		TimeControl: TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000},
		Seats: CreateMatchSeats{
			White: CreateSeat{Participant: white, PublicLabel: "Alice", Control: SeatControl{Kind: ControlHuman}},
			Black: CreateSeat{Participant: black, PublicLabel: "Bob", Control: SeatControl{Kind: ControlHuman}},
		},
	}
	command, err := NewAllocationCommand(black, setup, "allocation-operation-0123456789")
	if err != nil {
		t.Fatalf("build the allocation command: %v", err)
	}
	if command.Seat != SeatBlack {
		t.Fatalf("the command names the seat %q, want black", command.Seat)
	}
	if command.MatchID != AllocatedMatchID(black, command.OperationID) {
		t.Fatalf("the command match id %q does not match the derivation", command.MatchID)
	}
	if command.ExpectedVersion != 0 || command.ControlEpoch != 1 {
		t.Fatalf("the command carries %d/%d, want 0/1", command.ExpectedVersion, command.ControlEpoch)
	}
	// A participant that owns no seat cannot create the match.
	stranger := ParticipantRef{Kind: ParticipantAccount, ID: "user_stranger"}
	if _, err = NewAllocationCommand(stranger, setup, "allocation-operation-0123456789"); err != ErrNotAuthorized {
		t.Fatalf("a stranger allocation error = %v, want ErrNotAuthorized", err)
	}
	// An operation identifier that cannot be stored is refused.
	if _, err = NewAllocationCommand(black, setup, "short"); err == nil {
		t.Fatal("a malformed operation identifier was accepted")
	}
}
