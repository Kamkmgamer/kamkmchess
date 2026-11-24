package serverengine

import (
	"context"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

type fakeMatches struct {
	match    online.Match
	executed []online.Command
}

func (f *fakeMatches) GetMatch(context.Context, string) (online.Match, error) { return f.match, nil }

func (f *fakeMatches) AcquireRunnerLease(context.Context, online.ParticipantRef, online.RunnerLeaseRequest) (online.RunnerLease, error) {
	return online.RunnerLease{LeaseID: "lease-0001"}, nil
}

func (f *fakeMatches) Execute(_ context.Context, _ online.ParticipantRef, cmd online.Command) (online.CommandResult, error) {
	f.executed = append(f.executed, cmd)
	return online.CommandResult{}, nil
}

func (f *fakeMatches) CreateAllocatedMatch(context.Context, online.ParticipantRef, online.CreateMatchSetup, string) (online.CommandResult, error) {
	return online.CommandResult{}, nil
}

type fakeCredentials struct{ now time.Time }

func (f fakeCredentials) IssueEngineSeatCredential(_ context.Context, r onlineauth.EngineSeatRequest) (onlineauth.EngineSeatCredentialOutcome, error) {
	return onlineauth.EngineSeatCredentialOutcome{Issued: true, Credential: onlineauth.IssuedSeatCredential{
		CredentialID: "cred", GuestID: r.GuestID, MatchID: r.MatchID, Seat: r.Seat, Origin: r.Origin, ExpiresAt: f.now.Add(time.Hour),
	}}, nil
}

type fakeMover struct{ calls int }

func (f *fakeMover) BestMove(context.Context, string, time.Duration) (string, error) {
	f.calls++
	return "e2e4", nil
}

// An engine-white invitation nobody joined is left alone while it is fresh
// and cancelled by the engine seat once it is stale.
func TestPlayCancelsAStaleUnjoinedInvitation(t *testing.T) {
	created := time.Date(2026, 11, 24, 9, 0, 0, 0, time.UTC)
	owner := ParticipantPrefix + "1000:abcd"
	matches := &fakeMatches{match: online.Match{
		MatchID: "match-0001", Status: online.MatchActive, Version: 3, ControlEpoch: 1,
		PositionFEN: StandardStartingPosition, UpdatedAt: created,
		Seats: []online.MatchSeat{{Seat: online.SeatWhite, Participant: online.ParticipantRef{Kind: online.ParticipantGuest, ID: owner}, Control: online.SeatControl{Kind: online.ControlEngine}}},
	}}
	now := created.Add(30 * time.Minute)
	mover := &fakeMover{}
	s, err := New(Options{Matches: matches, Credentials: fakeCredentials{now: now}, Mover: mover, ActiveSeats: func(context.Context, int) ([]SeatRef, error) { return nil, nil }, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	s.SetReadiness(func(online.Match) bool { return false })
	ref := SeatRef{MatchID: "match-0001", Seat: online.SeatWhite, OwnerID: owner}

	if err = s.Play(context.Background(), ref); err != nil {
		t.Fatal(err)
	}
	if len(matches.executed) != 0 || mover.calls != 0 {
		t.Fatalf("a fresh invitation was touched: %+v", matches.executed)
	}

	now = created.Add(DefaultUnjoinedTimeout)
	if err = s.Play(context.Background(), ref); err != nil {
		t.Fatal(err)
	}
	if len(matches.executed) != 1 || matches.executed[0].Action.Kind != online.ActionCancel || mover.calls != 0 {
		t.Fatalf("the stale invitation was not cancelled: %+v", matches.executed)
	}
	if err = matches.executed[0].Validate(); err != nil {
		t.Fatalf("the cancel command is invalid: %v", err)
	}
}

// A started game is never cancelled, however long the gate stays closed.
func TestPlayNeverCancelsAStartedGame(t *testing.T) {
	created := time.Date(2026, 11, 24, 9, 0, 0, 0, time.UTC)
	owner := ParticipantPrefix + "1000:abcd"
	matches := &fakeMatches{match: online.Match{
		MatchID: "match-0002", Status: online.MatchActive, Version: 3, ControlEpoch: 1,
		PositionFEN: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", UpdatedAt: created,
		Moves: []online.Move{{Seat: online.SeatWhite}},
		Seats: []online.MatchSeat{{Seat: online.SeatBlack, Participant: online.ParticipantRef{Kind: online.ParticipantGuest, ID: owner}, Control: online.SeatControl{Kind: online.ControlEngine}}},
	}}
	now := created.Add(2 * DefaultUnjoinedTimeout)
	s, _ := New(Options{Matches: matches, Credentials: fakeCredentials{now: now}, Mover: &fakeMover{}, ActiveSeats: func(context.Context, int) ([]SeatRef, error) { return nil, nil }, Now: func() time.Time { return now }})
	s.SetReadiness(func(online.Match) bool { return false })
	if err := s.Play(context.Background(), SeatRef{MatchID: "match-0002", Seat: online.SeatBlack, OwnerID: owner}); err != nil {
		t.Fatal(err)
	}
	if len(matches.executed) != 0 {
		t.Fatalf("a started game was cancelled: %+v", matches.executed)
	}
}
