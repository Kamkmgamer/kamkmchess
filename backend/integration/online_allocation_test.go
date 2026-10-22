package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

// TestPostgresTheAllocatedEngineSeatTakesOneScopedGuestCredential covers the
// shape of a browser engine seat.
//
// The queue fallback plays the owner against the browser Stockfish 19 Lite.
// The engine runs in the owner's browser, so the owner's browser needs a
// credential that authorizes the engine seat.
//
// The canonical match contract refuses two seats of the same participant, so
// the engine seat is a separate participant and the credential is a guest seat
// credential of that seat. The credential authorizes exactly one seat of one
// match: it never authorizes the owner's own seat, and it never authorizes
// another match.
func TestPostgresTheAllocatedEngineSeatTakesOneScopedGuestCredential(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	ctx := context.Background()

	owner := online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_owner"}
	engineGuest := online.ParticipantRef{Kind: online.ParticipantGuest, ID: "guest_engine_stockfish"}
	// The declared model label of the browser engine is canonical: the
	// service names the browser Stockfish seat itself, and the published
	// label of the seat stays the product text. The value is the one of
	// backend/history.EngineLabel.
	engineModelLabel := "Stockfish 19 Lite (browser)"
	enginePublicLabel := "Stockfish 19 Lite"
	setup := online.CreateMatchSetup{
		Variant:     "orthodox",
		StartingFEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000},
		Seats: online.CreateMatchSeats{
			White: online.CreateSeat{Participant: owner, PublicLabel: "Owner", Control: online.SeatControl{Kind: online.ControlHuman}},
			Black: online.CreateSeat{Participant: engineGuest, PublicLabel: enginePublicLabel, Control: online.SeatControl{Kind: online.ControlEngine, ModelLabel: &engineModelLabel}},
		},
	}
	command, err := online.NewAllocationCommand(owner, setup, "queue-fallback-operation-0123456789")
	if err != nil {
		t.Fatalf("build the allocation command: %v", err)
	}
	result, err := fixture.service.CreateAllocatedMatch(ctx, owner, setup, command.OperationID)
	if err != nil {
		t.Fatalf("create the allocated match: %v", err)
	}
	matchID := result.Receipt.MatchID
	match, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	black, ok := match.Seat(online.SeatBlack)
	if !ok {
		t.Fatal("the allocated match has no black seat")
	}
	if black.Control.Kind != online.ControlEngine || black.Control.ModelLabel == nil || *black.Control.ModelLabel != engineModelLabel {
		t.Fatalf("the engine seat control = %+v", black.Control)
	}
	if black.PublicLabel != enginePublicLabel {
		t.Fatalf("the engine seat label = %q, want %q", black.PublicLabel, enginePublicLabel)
	}

	// The owner's browser receives a guest seat credential of the engine
	// seat.
	issued, err := fixture.allocator.AcceptInvitation(ctx, onlineauth.AcceptInvitationRequest{
		MatchID: matchID,
		Seat:    online.SeatBlack,
		GuestID: engineGuest.ID,
		Origin:  authTestOrigin,
		TTL:     time.Hour,
	})
	if err != nil {
		t.Fatalf("mint the engine seat credential: %v", err)
	}
	principal, err := fixture.authorizer.AuthenticateGuest(ctx, issued.Credential.Secret, authTestOrigin)
	if err != nil {
		t.Fatalf("authenticate the engine credential: %v", err)
	}
	if principal.MatchID != matchID || principal.Seat != online.SeatBlack {
		t.Fatalf("the engine principal = %+v", principal)
	}
	// The credential authorizes the engine seat only. It never authorizes
	// the owner's own seat.
	engineContext := onlineauth.WithPrincipal(ctx, principal)
	if err = fixture.authorizer.AuthorizeSeat(engineContext, fixture.pool, matchID, principal.Participant, online.SeatWhite); !errors.Is(err, online.ErrNotAuthorized) {
		t.Fatalf("the engine credential on the owner seat error = %v, want ErrNotAuthorized", err)
	}
	// It never authorizes another match either.
	other, err := fixture.service.CreateAllocatedMatch(ctx, owner, setup, "queue-fallback-other-operation-0123456789")
	if err != nil {
		t.Fatal(err)
	}
	if err = fixture.authorizer.AuthorizeSeat(engineContext, fixture.pool, other.Receipt.MatchID, principal.Participant, online.SeatBlack); !errors.Is(err, online.ErrNotAuthorized) {
		t.Fatalf("the engine credential on another match error = %v, want ErrNotAuthorized", err)
	}
}
