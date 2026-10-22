package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/invite"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// The friend rematch carries the setup of the finished match, and a friend
// game has no built-in engine seat. A queue fallback match plays its owner
// against the browser Stockfish, so its engine seat has no friend consent
// path and no engine seat client. These tests cover the guard that keeps
// such a match out of the friend rematch surface.

// fallbackEngineMatch creates the match a queue fallback plays: the owner
// against the browser Stockfish.
//
// The match is finished, so it is a match a rematch could name.
func fallbackEngineMatch(t *testing.T, fixture *friendFixture, ctx context.Context) (string, online.ParticipantRef) {
	t.Helper()
	owner := online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_owner"}
	engine := online.ParticipantRef{Kind: online.ParticipantGuest, ID: "guest_engine_stockfish"}
	engineModelLabel := "Stockfish 19 Lite (browser)"
	setup := online.CreateMatchSetup{
		Variant:     "orthodox",
		StartingFEN: invite.StandardStartingFEN,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000},
		Seats: online.CreateMatchSeats{
			White: online.CreateSeat{Participant: owner, PublicLabel: "Owner", Control: online.SeatControl{Kind: online.ControlHuman}},
			Black: online.CreateSeat{Participant: engine, PublicLabel: "Stockfish 19 Lite", Control: online.SeatControl{Kind: online.ControlEngine, ModelLabel: &engineModelLabel}},
		},
	}
	result, err := fixture.service.CreateAllocatedMatch(ctx, owner, setup, "queue-fallback-rematch-operation-0123456789")
	if err != nil {
		t.Fatalf("create the queue fallback match: %v", err)
	}
	matchID := result.Receipt.MatchID
	// The match ends, so the finished match is one a rematch could name.
	resign := resignOnlineCommand(matchID, "fallback-resign-op", online.SeatWhite, 1)
	if _, err = fixture.service.Execute(accountContext("user_owner", "session_fallback"), owner, resign); err != nil {
		t.Fatalf("resign the queue fallback match: %v", err)
	}
	return matchID, engine
}

// TestPostgresFriendRematchRefusesAQueueFallbackEngineSeat covers the
// proposal of a rematch of a match that carries an engine seat.
//
// The friend surface has no built-in engine seat, so the owner of a queue
// fallback match cannot propose a friend rematch of it. The refusal happens
// before any offer is written, so the opponent is never asked to accept an
// offer it cannot complete.
func TestPostgresFriendRematchRefusesAQueueFallbackEngineSeat(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()
	matchID, _ := fallbackEngineMatch(t, fixture, ctx)

	_, err := fixture.friends.ProposeRematch(ctx, invite.RematchRequest{
		MatchID:       matchID,
		Proposer:      online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_owner"},
		ProposerLabel: "Owner",
	})
	if !errors.Is(err, invite.ErrInvalidContract) {
		t.Fatalf("the rematch of a queue fallback match = %v, want ErrInvalidContract", err)
	}
	// No offer is persisted, so no pending offer names the engine seat.
	var offers int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_rematch_offers WHERE match_id=$1`, matchID).Scan(&offers); err != nil {
		t.Fatal(err)
	}
	if offers != 0 {
		t.Fatalf("the refused proposal persisted %d offers", offers)
	}
}

// TestPostgresFriendAcceptRefusesALegacyEngineSeatOffer covers the
// acceptance of an offer that an earlier build already persisted.
//
// The legacy offer names a match that carries an engine seat. The guard runs
// before the new match is created, so the acceptance creates no match and
// the offer stays pending.
func TestPostgresFriendAcceptRefusesALegacyEngineSeatOffer(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()
	matchID, engine := fallbackEngineMatch(t, fixture, ctx)

	// The legacy offer is written directly, because the proposal of it is
	// refused now.
	now := time.Now().UTC()
	rematchID := "rmt_legacyengineoffer0001"
	if _, err := fixture.pool.Exec(ctx, `INSERT INTO online_rematch_offers(rematch_id,match_id,proposer_kind,proposer_id,proposer_public_label,proposer_seat,starting_time_ms,increment_ms,starting_fen,status,version,created_at,updated_at,expires_at) VALUES($1,$2,'account','user_owner','Owner','black',300000,2000,NULL,'pending',1,$3,$3,$4)`,
		rematchID, matchID, now, now.Add(time.Hour)); err != nil {
		t.Fatalf("write the legacy offer: %v", err)
	}
	var before int
	if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_matches`).Scan(&before); err != nil {
		t.Fatal(err)
	}

	// The acceptance of the legacy offer creates no match.
	if _, err := fixture.friends.AcceptRematch(ctx, invite.AcceptRematchRequest{
		RematchID: rematchID,
		Acceptor:  engine,
		Origin:    friendOrigin,
	}); !errors.Is(err, invite.ErrInvalidContract) {
		t.Fatalf("the acceptance of a legacy engine offer = %v, want ErrInvalidContract", err)
	}
	var after int
	if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_matches`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("the refused acceptance created %d matches", after-before)
	}
	// The offer is untouched, so it names no match and it is still open.
	var (
		status     string
		newMatchID *string
		acceptedBy *string
	)
	if err := fixture.pool.QueryRow(ctx, `SELECT status,new_match_id,accepted_by_id FROM online_rematch_offers WHERE rematch_id=$1`, rematchID).Scan(&status, &newMatchID, &acceptedBy); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || newMatchID != nil || acceptedBy != nil {
		t.Fatalf("the refused offer = status %q, match %v, accepter %v", status, newMatchID, acceptedBy)
	}
}

// TestPostgresFriendRematchKeepsTheSetupOfAnAgentSeat covers the friend
// rematch that is allowed.
//
// A friend game seats a human or the owner of its own agent. The rematch of
// such a match reverses the colors and retains the setup of both seats.
func TestPostgresFriendRematchKeepsTheSetupOfAnAgentSeat(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()

	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     friendIdentity("user_inviter", "Alice"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("agent-rematch"),
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlAgent, ModelLabel: stringPointer("Declared Model")},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	// The match ends. The result of the old match stays final.
	resign := resignOnlineCommand(accepted.MatchID, "agent-rematch-resign-op", online.SeatWhite, 1)
	if _, err = fixture.service.Execute(accountContext("user_inviter", "session_agent_rematch"), online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"}, resign); err != nil {
		t.Fatalf("resign: %v", err)
	}

	proposal, err := fixture.friends.ProposeRematch(ctx, invite.RematchRequest{
		MatchID:       accepted.MatchID,
		Proposer:      online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"},
		ProposerLabel: "Alice",
	})
	if err != nil {
		t.Fatalf("propose: %v", err)
	}
	if proposal.Status != invite.RematchPending || proposal.ProposerSeat != online.SeatBlack {
		t.Fatalf("proposal = %+v", proposal)
	}
	if proposal.TimeControl != (online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000}) {
		t.Fatalf("the proposal did not retain the setup: %+v", proposal.TimeControl)
	}
	result, err := fixture.friends.AcceptRematch(ctx, invite.AcceptRematchRequest{
		RematchID: proposal.RematchID,
		Acceptor:  online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_invitee"},
	})
	if err != nil {
		t.Fatalf("accept the rematch: %v", err)
	}
	if result.MatchID == accepted.MatchID {
		t.Fatal("the rematch reused the finished match")
	}
	rematch, err := fixture.service.GetMatch(ctx, result.MatchID)
	if err != nil {
		t.Fatal(err)
	}
	// The colors are reversed and the setup is retained.
	white, _ := rematch.Seat(online.SeatWhite)
	black, _ := rematch.Seat(online.SeatBlack)
	if white.Participant.ID != "user_invitee" || black.Participant.ID != "user_inviter" {
		t.Fatalf("the colors were not reversed: white=%q black=%q", white.Participant.ID, black.Participant.ID)
	}
	if white.Control.Kind != online.ControlAgent || black.Control.Kind != online.ControlHuman {
		t.Fatalf("the rematch did not retain the seat controls: %q/%q", white.Control.Kind, black.Control.Kind)
	}
	if white.Control.ModelLabel == nil || *white.Control.ModelLabel == "" {
		t.Fatal("the agent seat of the rematch lost its public model label")
	}
	if rematch.TimeControl != (online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000}) {
		t.Fatalf("the rematch did not retain the clock: %+v", rematch.TimeControl)
	}
	if rematch.Status != online.MatchActive {
		t.Fatalf("the rematch status = %q", rematch.Status)
	}
}
