package integration

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/locks"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// The regressions of the third backend review.
//
// They are deterministic: they park the rules process, they hold the locks
// by hand, and they never wait for a wall-clock race.

// TestOnlineSweepDoesNotSettleATerminalResultWhileTheGateIsClosed covers
// the deadline gate of the trusted sweep.
//
// The sweep reads the gate before it evaluates the timeout, and the rules
// process is parked while the suspension commits. The settlement must be
// refused inside its own transaction, so a match whose clock is about to be
// refunded never ends while the service is suspended.
func TestOnlineSweepDoesNotSettleATerminalResultWhileTheGateIsClosed(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	evaluator := timeoutEvaluator{
		winnerFor: timeoutWinForOpponent,
		observe: func(online.RulesInput, online.Seat) {
			once.Do(func() { close(entered) })
			<-release
		},
	}
	fixture := newPresenceFixtureWith(t, evaluator)
	ctx := context.Background()
	const matchID = "match-sweep-gate"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)

	// The clock of the side to move runs out.
	fixture.clock.Advance(21 * time.Minute)

	swept := make(chan error, 1)
	go func() {
		_, err := fixture.service.ReconcileDeadline(ctx, matchID)
		swept <- err
	}()
	// The rules process is working on the timeout.
	<-entered
	// The service is suspended while the rules process works.
	planSuspension(t, fixture)
	close(release)

	if err := <-swept; err == nil {
		t.Fatal("the sweep settled the match while the gate was closed")
	} else if !errors.Is(err, online.ErrUnavailable) {
		t.Fatalf("the sweep while the gate is closed = %v, want %v", err, online.ErrUnavailable)
	}
	match, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if match.Result != nil {
		t.Fatalf("the sweep settled a terminal result while the gate was closed: %+v", match.Result)
	}
	if match.Status != online.MatchActive {
		t.Fatalf("the match status = %q, want %q", match.Status, online.MatchActive)
	}
}

// TestOnlineCommandAndRemovalShareTheLockOrder covers the lock order of the
// participant command and the removal of the same participant.
//
// The removal takes the account scope of the participant and then the row of
// the match. The command must take them in the same order, or the two
// transactions wait for each other and PostgreSQL reports a deadlock.
func TestOnlineCommandAndRemovalShareTheLockOrder(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-command-removal-order"
	if _, err := fixture.service.Execute(accountContext("user_a", "session-alice"), presenceAlice().ref, createOnlineCommand(matchID, "op-create-"+matchID)); err != nil {
		t.Fatalf("create the match: %v", err)
	}
	// The command of the participant that the removal acts on.
	command := moveOnlineCommand(matchID, "op-move-order", online.SeatWhite, 1, "e2e4")
	commandResult := make(chan error, 1)
	go func() {
		_, err := fixture.service.Execute(ctx, presenceAlice().ref, command)
		commandResult <- err
	}()
	// The removal holds the account scope of the participant and then the row
	// of the match, exactly like the privacy flow does.
	removal, err := fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = locks.LockAccountScope(ctx, removal, locks.AccountScope(string(online.ParticipantAccount), "user_a")); err != nil {
		t.Fatal(err)
	}
	if _, err = removal.Exec(ctx, `SELECT match_id FROM online_matches WHERE match_id=$1 FOR UPDATE`, matchID); err != nil {
		t.Fatal(err)
	}
	// The command waits for the scope, and the removal finishes.
	time.Sleep(200 * time.Millisecond)
	if err = removal.Commit(ctx); err != nil {
		t.Fatalf("the removal transaction: %v", err)
	}
	select {
	case err = <-commandResult:
		if err != nil {
			t.Fatalf("the command of the removed participant = %v, want an accepted move", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the command never finished")
	}
	// The two transactions never deadlocked.
	match, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if len(match.Moves) != 1 {
		t.Fatalf("the accepted moves = %d, want 1", len(match.Moves))
	}
}

// TestOnlineTerminalTransitionRevokesTheLeaseOfTheMatch covers the terminal
// lease lifecycle.
//
// A finished match carries no live lease, and the pending request of the
// lease stays, because it is the record of a provider request that may still
// be running.
func TestOnlineTerminalTransitionRevokesTheLeaseOfTheMatch(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-terminal-lease"
	createRunnerMatch(t, fixture.service, matchID, 20*60*1000)
	version := acceptMovesWithLeases(t, fixture.service, matchID)
	lease, err := fixture.service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-terminal", "", version, 1))
	if err != nil {
		t.Fatalf("acquire the lease: %v", err)
	}
	request := online.RunnerRequestRequest{
		SchemaVersion: online.ContractsSchemaVersion,
		MatchID:       matchID,
		Seat:          online.SeatBlack,
		RunnerID:      "runner-terminal",
		LeaseID:       lease.LeaseID,
		RequestID:     "request-terminal-02",
		ControlEpoch:  1,
		TurnVersion:   version,
	}
	if _, err = fixture.service.BeginRunnerRequest(ctx, presenceBob().ref, request); err != nil {
		t.Fatalf("begin the provider request: %v", err)
	}
	// The match ends.
	// The agent seat resigns through its lease: a resignation of an agent
	// seat is the agent's own action.
	resign := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     "op-terminal-resign",
		ExpectedVersion: version,
		Seat:            online.SeatBlack,
		ControlEpoch:    1,
		LeaseID:         lease.LeaseID,
		Action:          online.Action{Kind: online.ActionResign},
	}
	if _, err = fixture.service.Execute(ctx, presenceBob().ref, resign); err != nil {
		t.Fatalf("resign: %v", err)
	}
	after, err := fixture.service.GetSeatRunnerLease(ctx, presenceBob().ref, matchID, online.SeatBlack)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != online.LeaseRevoked {
		t.Fatalf("the lease of the finished match = %+v, want a revoked lease", after.Status)
	}
	if after.RevokedReason == nil || *after.RevokedReason != online.LeaseRevokeMatchEnded {
		t.Fatalf("the revocation reason = %v, want %q", after.RevokedReason, online.LeaseRevokeMatchEnded)
	}
	if after.PendingRequestID == nil || *after.PendingRequestID != "request-terminal-02" {
		t.Fatalf("the pending request of the finished match = %v, want the recorded request", after.PendingRequestID)
	}
}

// TestOnlineGateRefusesTheCommandOfARemovedParticipantKeepsItsScope covers
// the scope of a guest participant.
//
// The removal of a guest takes the scope of the guest, so the command path
// takes the same scope for a guest as for an account. The command waits for
// the scope, which is what keeps the two orders equal.
func TestOnlineGateRefusesTheCommandOfARemovedParticipantKeepsItsScope(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	ctx := context.Background()
	const matchID = "match-guest-scope"
	issued := createGuestMatch(t, fixture, matchID)
	if issued.Credential.GuestID == "" {
		t.Fatal("the guest identity is empty")
	}
	scope := locks.AccountScope(string(online.ParticipantGuest), issued.Credential.GuestID)
	removal, err := fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = locks.LockAccountScope(ctx, removal, scope); err != nil {
		t.Fatal(err)
	}
	if _, err = removal.Exec(ctx, `SELECT match_id FROM online_matches WHERE match_id=$1 FOR UPDATE`, matchID); err != nil {
		t.Fatal(err)
	}
	// The command of the guest goes through the real HTTP route, so the
	// guest credential is the one that authorizes it.
	handler := onlineHTTPFixture(t, fixture)
	body := `{"schemaVersion":2,"matchId":"` + matchID + `","operationId":"op-move-guest-scope","expectedVersion":1,"seat":"` + string(issued.Credential.Seat) + `","controlEpoch":1,"action":{"kind":"submit_move","move":"e2e4"}}`
	finished := make(chan int, 1)
	go func() {
		response := onlineHTTPRequest(handler, "POST", "/v1/online/matches/"+matchID+"/commands", authTestOrigin, "", map[string]string{"X-Guest-Seat-Token": issued.Credential.Secret}, body)
		finished <- response.Code
	}()
	// The command waits for the scope of the guest.
	select {
	case code := <-finished:
		t.Fatalf("the command of the guest did not wait for its scope: status %d", code)
	case <-time.After(300 * time.Millisecond):
	}
	if err = removal.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-finished:
		if code != 200 {
			t.Fatalf("the command of the guest = %d, want 200", code)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the command of the guest never finished")
	}
}
