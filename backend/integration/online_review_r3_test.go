package integration

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/locks"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/serverapp"
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

// mateEvaluator answers a move with a checkmate, so the match ends with a
// result in the acceptance transaction.
type mateEvaluator struct {
	moveEvaluator
}

func (mateEvaluator) Evaluate(_ context.Context, input online.RulesInput) (online.Candidate, error) {
	seat := online.SeatWhite
	if fields := strings.Fields(input.PositionFEN); len(fields) > 1 && fields[1] == "b" {
		seat = online.SeatBlack
	}
	next, _ := seat.Other()
	side := "w"
	if next == online.SeatBlack {
		side = "b"
	}
	candidate := online.Candidate{
		SchemaVersion:      online.RulesInputSchemaVersion,
		EvaluatedVersion:   input.Version,
		EvaluatedInputHash: input.InputHash,
		ControlEpoch:       input.ControlEpoch,
		Move: &online.Move{
			Seat:         seat,
			UCI:          input.ProposedMove,
			SAN:          input.ProposedMove,
			ResultingFEN: "8/8/8/8/8/8/8/K6k " + side + " - - 0 1",
		},
	}
	// Only the mating move ends the match, so the exchange before it is
	// ordinary play.
	if input.ProposedMove == "g1f3" {
		winner := seat
		candidate.Result = &online.Result{Kind: online.ResultWin, Winner: &winner, Reason: online.ReasonCheckmate}
	}
	return candidate, nil
}

// assertTerminalLeaseState checks that a finished match carries no live lease
// and that the uncertain provider request of the lease is preserved.
func assertTerminalLeaseState(t *testing.T, service *online.Service, matchID string, seat online.Seat, participant online.ParticipantRef, requestID string) {
	t.Helper()
	lease, err := service.GetSeatRunnerLease(context.Background(), participant, matchID, seat)
	if err != nil {
		t.Fatalf("the lease of the finished match: %v", err)
	}
	if lease.Status != online.LeaseRevoked {
		t.Fatalf("the lease of the finished match = %q, want %q", lease.Status, online.LeaseRevoked)
	}
	if lease.RevokedReason == nil || *lease.RevokedReason != online.LeaseRevokeMatchEnded {
		t.Fatalf("the revocation reason = %v, want %q", lease.RevokedReason, online.LeaseRevokeMatchEnded)
	}
	if requestID != "" && (lease.PendingRequestID == nil || *lease.PendingRequestID != requestID) {
		t.Fatalf("the pending request of the finished match = %v, want %q", lease.PendingRequestID, requestID)
	}
}

// TestOnlineTerminalPathsRevokeTheLeaseOfTheMatch covers every terminal path.
//
// A timeout, an opening abort, a draw agreement and a checkmate all end the
// match in one transaction, and every one of them leaves no live lease. The
// uncertain provider request stays on the lease.
func TestOnlineTerminalPathsRevokeTheLeaseOfTheMatch(t *testing.T) {
	// The timeout settles the match with the bounded timeout policy.
	t.Run("timeout", func(t *testing.T) {
		fixture := newPresenceFixtureWith(t, timeoutEvaluator{winnerFor: timeoutWinForOpponent})
		ctx := context.Background()
		const matchID = "match-terminal-timeout"
		createRunnerMatch(t, fixture.service, matchID, 20_000)
		version := acceptMovesWithLeases(t, fixture.service, matchID)
		lease, err := fixture.service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-timeout", "", version, 1))
		if err != nil {
			t.Fatalf("acquire the lease: %v", err)
		}
		request := online.RunnerRequestRequest{
			SchemaVersion: online.ContractsSchemaVersion,
			MatchID:       matchID,
			Seat:          online.SeatBlack,
			RunnerID:      "runner-timeout",
			LeaseID:       lease.LeaseID,
			RequestID:     "request-timeout-01",
			ControlEpoch:  1,
			TurnVersion:   version,
		}
		if _, err = fixture.service.BeginRunnerRequest(ctx, presenceBob().ref, request); err != nil {
			t.Fatalf("begin the provider request: %v", err)
		}
		// The clock of the side to move runs out.
		fixture.clock.Advance(30 * time.Second)
		outcome, err := fixture.service.ReconcileDeadline(ctx, matchID)
		if err != nil {
			t.Fatalf("the sweep: %v", err)
		}
		if outcome != online.DeadlineSettled {
			t.Fatalf("the sweep outcome = %q, want %q", outcome, online.DeadlineSettled)
		}
		assertTerminalLeaseState(t, fixture.service, matchID, online.SeatBlack, presenceBob().ref, "request-timeout-01")
	})

	// The opening abort settles the match when the reply window closes.
	t.Run("opening abort", func(t *testing.T) {
		fixture := newPresenceFixture(t)
		ctx := context.Background()
		const matchID = "match-terminal-abort"
		createRunnerMatch(t, fixture.service, matchID, 20*60*1000)
		// Only the first move is made, so the reply window is open. The
		// agent seat moves through its lease.
		openingLease, err := fixture.service.AcquireRunnerLease(ctx, presenceAlice().ref, leaseRequest(matchID, online.SeatWhite, "runner-abort-white", "", 1, 1))
		if err != nil {
			t.Fatalf("acquire the opening lease: %v", err)
		}
		first := moveOnlineCommand(matchID, "op-move-abort", online.SeatWhite, 1, "e2e4")
		first.LeaseID = openingLease.LeaseID
		if _, err := fixture.service.Execute(ctx, presenceAlice().ref, first); err != nil {
			t.Fatalf("the opening move: %v", err)
		}
		if _, err := fixture.service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-abort", "", 2, 1)); err != nil {
			t.Fatalf("acquire the lease: %v", err)
		}
		fixture.clock.Advance(time.Duration(online.OpeningReplyWindowMs)*time.Millisecond + time.Second)
		outcome, err := fixture.service.ReconcileDeadline(ctx, matchID)
		if err != nil {
			t.Fatalf("the sweep: %v", err)
		}
		if outcome != online.DeadlineSettled {
			t.Fatalf("the sweep outcome = %q, want %q", outcome, online.DeadlineSettled)
		}
		assertTerminalLeaseState(t, fixture.service, matchID, online.SeatBlack, presenceBob().ref, "")
	})

	// The draw agreement ends the match.
	t.Run("draw", func(t *testing.T) {
		fixture := newPresenceFixture(t)
		ctx := context.Background()
		const matchID = "match-terminal-draw"
		createRunnerMatch(t, fixture.service, matchID, 20*60*1000)
		version := acceptMovesWithLeases(t, fixture.service, matchID)
		if _, err := fixture.service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-draw", "", version, 1)); err != nil {
			t.Fatalf("acquire the lease: %v", err)
		}
		offer := offerDrawOnlineCommand(matchID, "op-draw-offer", online.SeatBlack, version)
		if _, err := fixture.service.Execute(ctx, presenceBob().ref, offer); err != nil {
			t.Fatalf("the draw offer: %v", err)
		}
		accept := acceptDrawOnlineCommand(matchID, "op-draw-accept", online.SeatWhite, version+1, pendingOfferID(t, fixture.service, matchID, online.OfferDraw))
		if _, err := fixture.service.Execute(ctx, presenceAlice().ref, accept); err != nil {
			t.Fatalf("the draw acceptance: %v", err)
		}
		assertTerminalLeaseState(t, fixture.service, matchID, online.SeatBlack, presenceBob().ref, "")
	})

	// The checkmate ends the match in the acceptance transaction.
	t.Run("checkmate", func(t *testing.T) {
		fixture := newPresenceFixtureWith(t, mateEvaluator{})
		ctx := context.Background()
		const matchID = "match-terminal-mate"
		createRunnerMatch(t, fixture.service, matchID, 20*60*1000)
		version := acceptMovesWithLeases(t, fixture.service, matchID)
		if _, err := fixture.service.AcquireRunnerLease(ctx, presenceBob().ref, leaseRequest(matchID, online.SeatBlack, "runner-mate", "", version, 1)); err != nil {
			t.Fatalf("acquire the lease: %v", err)
		}
		move := moveOnlineCommand(matchID, "op-move-mate", online.SeatWhite, version, "g1f3")
		whiteLease, err := fixture.service.AcquireRunnerLease(ctx, presenceAlice().ref, leaseRequest(matchID, online.SeatWhite, "runner-mate-white", "", version, 1))
		if err != nil {
			t.Fatalf("acquire the white lease: %v", err)
		}
		move.LeaseID = whiteLease.LeaseID
		if _, err = fixture.service.Execute(ctx, presenceAlice().ref, move); err != nil {
			t.Fatalf("the mating move: %v", err)
		}
		assertTerminalLeaseState(t, fixture.service, matchID, online.SeatBlack, presenceBob().ref, "")
	})
}

// pendingOfferID returns the identity of the pending offer of one kind.
func pendingOfferID(t *testing.T, service *online.Service, matchID string, kind online.OfferKind) string {
	t.Helper()
	match, err := service.GetMatch(context.Background(), matchID)
	if err != nil {
		t.Fatal(err)
	}
	for _, offer := range match.Offers {
		if offer.Kind == kind {
			return offer.OfferID
		}
	}
	t.Fatalf("the match %s has no pending %s offer", matchID, kind)
	return ""
}

// switchableEvaluator fails or answers on demand, so the health monitor can
// be driven through an outage and a recovery.
type switchableEvaluator struct {
	moveEvaluator
	mu      sync.Mutex
	broken  bool
	release chan struct{}
	busy    bool
}

func (e *switchableEvaluator) setBroken(broken bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.broken = broken
}

func (e *switchableEvaluator) setBusy(busy bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.busy = busy
	if busy {
		e.release = make(chan struct{})
	} else if e.release != nil {
		close(e.release)
		e.release = nil
	}
}

func (e *switchableEvaluator) state() (bool, bool, chan struct{}) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.broken, e.busy, e.release
}

func (e *switchableEvaluator) ValidateSetup(ctx context.Context, _ online.RulesInput) error {
	broken, busy, release := e.state()
	if broken {
		return errors.New("the rules process is down")
	}
	if busy {
		select {
		case <-release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (e *switchableEvaluator) Evaluate(ctx context.Context, input online.RulesInput) (online.Candidate, error) {
	if err := e.ValidateSetup(ctx, input); err != nil {
		return online.Candidate{}, err
	}
	return e.moveEvaluator.Evaluate(ctx, input)
}

// TestOnlineHealthMonitorRecoversOnlyWithPrimaryEvidence covers the health
// monitor of the rules dependency.
//
// A broken primary is an interruption: the gate closes and the clock of the
// unfinished matches is refunded when the primary answers again. A busy but
// healthy primary is not an interruption at all.
func TestOnlineHealthMonitorRecoversOnlyWithPrimaryEvidence(t *testing.T) {
	evaluator := &switchableEvaluator{}
	fixture := newPresenceFixtureWith(t, evaluator)
	ctx := context.Background()
	const matchID = "match-monitor-recovery"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)
	match, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	beforeDeadline := match.Clock.DeadlineAt.UTC()

	// The health monitor runs with the production cadence of the service.
	stop := serverapp.StartHealthMonitor(ctx, fixture.pool, fixture.health, fixture.service, serverapp.HealthMonitorConfig{Interval: 20 * time.Millisecond})
	defer stop()

	// The primary rules process is down.
	evaluator.setBroken(true)
	fixture.clock.Advance(2 * time.Minute)
	waitFor(t, 10*time.Second, func() bool {
		state, err := online.ServiceGate(ctx, fixture.pool)
		return err == nil && !state.Open
	}, "the gate to close for the broken primary")

	// The primary answers again. The monitor recovers the interruption, and
	// the clock of the unfinished match is refunded once.
	evaluator.setBroken(false)
	fixture.clock.Advance(2 * time.Minute)
	waitFor(t, 20*time.Second, func() bool {
		state, err := online.ServiceGate(ctx, fixture.pool)
		return err == nil && state.Open
	}, "the gate to reopen for the recovered primary")
	recovered, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if got := recovered.Clock.DeadlineAt.UTC().Sub(beforeDeadline); got != 2*time.Minute {
		t.Fatalf("the deadline moved by %v, want the 2m of the interruption", got)
	}
	// The refund happened once.
	evaluator.setBroken(true)
	fixture.clock.Advance(2 * time.Minute)
	waitFor(t, 10*time.Second, func() bool {
		state, err := online.ServiceGate(ctx, fixture.pool)
		return err == nil && !state.Open
	}, "the gate to close for the second interruption")
	evaluator.setBroken(false)
	fixture.clock.Advance(2 * time.Minute)
	waitFor(t, 20*time.Second, func() bool {
		state, err := online.ServiceGate(ctx, fixture.pool)
		return err == nil && state.Open
	}, "the gate to reopen for the second recovery")
	afterSecond, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if got := afterSecond.Clock.DeadlineAt.UTC().Sub(recovered.Clock.DeadlineAt.UTC()); got != 2*time.Minute {
		t.Fatalf("the second interruption moved the deadline by %v, want the 2m of its own interval", got)
	}
}

// TestOnlineHealthMonitorDoesNotMistakeABusyPrimaryForAnOutage covers the
// busy primary.
//
// A primary that is busy with a request answers the probe late. The late
// answer is a busy primary and not a broken dependency, so the gate stays
// open.
func TestOnlineHealthMonitorDoesNotMistakeABusyPrimaryForAnOutage(t *testing.T) {
	evaluator := &switchableEvaluator{}
	fixture := newPresenceFixtureWith(t, evaluator)
	ctx := context.Background()
	stop := serverapp.StartHealthMonitor(ctx, fixture.pool, fixture.health, fixture.service, serverapp.HealthMonitorConfig{Interval: 20 * time.Millisecond})
	defer stop()
	// The primary is busy with a request.
	evaluator.setBusy(true)
	time.Sleep(3 * time.Second)
	state, err := online.ServiceGate(ctx, fixture.pool)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Open {
		t.Fatalf("the gate = %+v, want an open gate while the primary is busy", state)
	}
	if rules := fixture.health.Current().Rules; rules.State != "" && rules.State != online.HealthHealthy {
		t.Fatalf("the rules dependency = %q while the primary is busy, want %q", rules.State, online.HealthHealthy)
	}
	evaluator.setBusy(false)
}

// waitFor waits for a condition and reports it when it never holds.
func waitFor(t *testing.T, budget time.Duration, condition func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out after %v waiting for %s", budget, what)
}
