package online

import (
	"testing"
	"time"
)

// The presence unit fixtures.
//
// The claim decision is a pure function of the match state, the presence of
// the opponent, the authoritative time and the health of the service. The
// fixtures exercise it without a database.

func offlineOpponent(offlineSince time.Time) SeatPresence {
	lease := offlineSince.Add(PresenceLeaseTTL)
	return SeatPresence{
		Seat:           SeatBlack,
		State:          PresenceOffline,
		LeaseExpiresAt: &lease,
		OfflineSince:   &offlineSince,
	}
}

// TestEvaluateClaimConnectedOpponentIsNeverClaimable covers MAT-05.
//
// A connected opponent may use the whole clock, so the claim never appears.
func TestEvaluateClaimConnectedOpponentIsNeverClaimable(t *testing.T) {
	now := time.Now().UTC()
	availability := EvaluateClaim(ClaimInputs{
		MatchStatus:     MatchActive,
		WhiteMoved:      true,
		BlackMoved:      true,
		Opponent:        SeatPresence{Seat: SeatBlack, State: PresenceConnected},
		Now:             now,
		ServiceState:    HealthHealthy,
		ServiceGateOpen: true,
	})
	if availability.Eligible {
		t.Fatal("a connected opponent must never be claimable")
	}
	if availability.Reason != ClaimReasonOpponentConnected {
		t.Fatalf("reason = %q, want %q", availability.Reason, ClaimReasonOpponentConnected)
	}
}

// TestEvaluateClaimBoundaries covers MAT-06.
//
// One second short of the continuous offline minute the claim is refused, and
// at the minute it is available.
func TestEvaluateClaimBoundaries(t *testing.T) {
	now := time.Now().UTC()
	// The offline minute starts when the liveness lease expired, so the
	// offline interval is the grace period itself.
	offlineSince := now.Add(-AbandonmentGracePeriod)
	short := EvaluateClaim(ClaimInputs{
		MatchStatus:     MatchActive,
		WhiteMoved:      true,
		BlackMoved:      true,
		Opponent:        offlineOpponent(offlineSince),
		Now:             now.Add(-time.Second),
		ServiceState:    HealthHealthy,
		ServiceGateOpen: true,
	})
	if short.Eligible {
		t.Fatal("the claim must not be available one second early")
	}
	if short.Reason != ClaimReasonGracePeriod {
		t.Fatalf("reason = %q, want %q", short.Reason, ClaimReasonGracePeriod)
	}
	if short.GraceSecondsLeft != 1 {
		t.Fatalf("grace seconds left = %d, want 1", short.GraceSecondsLeft)
	}
	exact := EvaluateClaim(ClaimInputs{
		MatchStatus:     MatchActive,
		WhiteMoved:      true,
		BlackMoved:      true,
		Opponent:        offlineOpponent(offlineSince),
		Now:             now,
		ServiceState:    HealthHealthy,
		ServiceGateOpen: true,
	})
	if !exact.Eligible {
		t.Fatalf("the claim must be available at the minute, reason %q", exact.Reason)
	}
	if exact.GraceSecondsLeft != 0 {
		t.Fatalf("grace seconds left = %d, want 0", exact.GraceSecondsLeft)
	}
}

// TestEvaluateClaimRefusals covers the reasons the claim is not available.
func TestEvaluateClaimRefusals(t *testing.T) {
	now := time.Now().UTC()
	offlineSince := now.Add(-PresenceLeaseTTL - AbandonmentGracePeriod)
	cases := []struct {
		name  string
		input ClaimInputs
		want  string
	}{
		{
			name: "a finished match stays final",
			input: ClaimInputs{
				MatchStatus: MatchCompleted, WhiteMoved: true, BlackMoved: true,
				Opponent: offlineOpponent(offlineSince), Now: now, ServiceState: HealthHealthy, ServiceGateOpen: true,
			},
			want: ClaimReasonMatchEnded,
		},
		{
			name: "a service outage is not an absent opponent",
			input: ClaimInputs{
				MatchStatus: MatchActive, WhiteMoved: true, BlackMoved: true,
				Opponent: offlineOpponent(offlineSince), Now: now, ServiceState: HealthUnavailable, ServiceGateOpen: true,
			},
			want: ClaimReasonServiceUnavailable,
		},
		{
			name: "a degraded service is not an absent opponent",
			input: ClaimInputs{
				MatchStatus: MatchActive, WhiteMoved: true, BlackMoved: true,
				Opponent: offlineOpponent(offlineSince), Now: now, ServiceState: HealthDegraded, ServiceGateOpen: true,
			},
			want: ClaimReasonServiceUnavailable,
		},
		{
			name: "a recovering service is not an absent opponent",
			input: ClaimInputs{
				MatchStatus: MatchActive, WhiteMoved: true, BlackMoved: true,
				Opponent: offlineOpponent(offlineSince), Now: now, ServiceState: HealthHealthy, ServiceGateOpen: false,
			},
			want: ClaimReasonServiceUnavailable,
		},
		{
			name: "the claim never bypasses the opening reply",
			input: ClaimInputs{
				MatchStatus: MatchActive, WhiteMoved: true, BlackMoved: true, ReplyOutstanding: true,
				Opponent: offlineOpponent(offlineSince), Now: now, ServiceState: HealthHealthy, ServiceGateOpen: true,
			},
			want: ClaimReasonOpeningReply,
		},
		{
			name: "the claim needs both sides to have moved",
			input: ClaimInputs{
				MatchStatus: MatchActive, WhiteMoved: true, BlackMoved: false,
				Opponent: offlineOpponent(offlineSince), Now: now, ServiceState: HealthHealthy, ServiceGateOpen: true,
			},
			want: ClaimReasonAwaitingMoves,
		},
		{
			name: "an opponent that never reported in is not claimable",
			input: ClaimInputs{
				MatchStatus: MatchActive, WhiteMoved: true, BlackMoved: true,
				Opponent: SeatPresence{Seat: SeatBlack, State: PresenceUnknown}, Now: now, ServiceState: HealthHealthy, ServiceGateOpen: true,
			},
			want: ClaimReasonOpponentUnknown,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			availability := EvaluateClaim(testCase.input)
			if availability.Eligible {
				t.Fatal("the claim must not be available")
			}
			if availability.Reason != testCase.want {
				t.Fatalf("reason = %q, want %q", availability.Reason, testCase.want)
			}
		})
	}
}

// TestParseClaimCommandRejectsUnknownFields covers the strict envelope.
func TestParseClaimCommandRejectsUnknownFields(t *testing.T) {
	valid := `{"schemaVersion":2,"matchId":"match-0001","operationId":"operation-0001","expectedVersion":7,"seat":"white","controlEpoch":3}`
	command, err := ParseClaimCommand([]byte(valid))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if command.Seat != SeatWhite || command.ExpectedVersion != 7 {
		t.Fatalf("parsed command = %+v", command)
	}
	refused := []string{
		`{"schemaVersion":2,"matchId":"match-0001","operationId":"operation-0001","expectedVersion":7,"seat":"white","controlEpoch":3,"extra":1}`,
		`{"schemaVersion":1,"matchId":"match-0001","operationId":"operation-0001","expectedVersion":7,"seat":"white","controlEpoch":3}`,
		`{"schemaVersion":2,"matchId":"short","operationId":"operation-0001","expectedVersion":7,"seat":"white","controlEpoch":3}`,
		`{"schemaVersion":2,"matchId":"match-0001","operationId":"operation-0001","expectedVersion":0,"seat":"white","controlEpoch":3}`,
		`{"schemaVersion":2,"matchId":"match-0001","operationId":"operation-0001","expectedVersion":7,"seat":"green","controlEpoch":3}`,
		`{"schemaVersion":2,"matchId":"match-0001","operationId":"operation-0001","expectedVersion":7,"seat":"white","controlEpoch":0}`,
		valid + `{}`,
	}
	for _, body := range refused {
		if _, err := ParseClaimCommand([]byte(body)); err == nil {
			t.Fatalf("the envelope %q was accepted", body)
		}
	}
}

// TestRunnerLeaseRequestValidation covers the lease request envelope.
func TestRunnerLeaseRequestValidation(t *testing.T) {
	valid := RunnerLeaseRequest{
		SchemaVersion: ContractsSchemaVersion,
		MatchID:       "match-0001",
		Seat:          SeatBlack,
		RunnerID:      "runner-0001",
		TurnVersion:   7,
		ControlEpoch:  3,
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("the valid request was refused: %v", err)
	}
	refused := []RunnerLeaseRequest{
		{SchemaVersion: 1, MatchID: valid.MatchID, Seat: valid.Seat, RunnerID: valid.RunnerID, ControlEpoch: 1},
		{SchemaVersion: ContractsSchemaVersion, MatchID: "short", Seat: valid.Seat, RunnerID: valid.RunnerID, ControlEpoch: 1},
		{SchemaVersion: ContractsSchemaVersion, MatchID: valid.MatchID, Seat: "green", RunnerID: valid.RunnerID, ControlEpoch: 1},
		{SchemaVersion: ContractsSchemaVersion, MatchID: valid.MatchID, Seat: valid.Seat, RunnerID: "", ControlEpoch: 1},
		{SchemaVersion: ContractsSchemaVersion, MatchID: valid.MatchID, Seat: valid.Seat, RunnerID: "runner\n0001", ControlEpoch: 1},
		{SchemaVersion: ContractsSchemaVersion, MatchID: valid.MatchID, Seat: valid.Seat, RunnerID: valid.RunnerID, LeaseID: "short", ControlEpoch: 1},
		{SchemaVersion: ContractsSchemaVersion, MatchID: valid.MatchID, Seat: valid.Seat, RunnerID: valid.RunnerID, ControlEpoch: 0},
	}
	for _, request := range refused {
		if err := request.Validate(); err == nil {
			t.Fatalf("the request %+v was accepted", request)
		}
	}
}

// TestRecoveryOverlapRefundsTheWholeInterruption covers the recovery
// arithmetic.
//
// A service interruption is never charged to a player. When the clock was
// running when the service went down, the whole interruption is refunded,
// even when the deadline passed while the service was down.
func TestRecoveryOverlapRefundsTheWholeInterruption(t *testing.T) {
	start := time.Now().UTC()
	activeSince := start.Add(-10 * time.Minute)
	deadline := start.Add(10 * time.Minute)
	// The clock survived the interruption.
	overlap, ok := recoveryOverlap(&deadline, &activeSince, nil, nil, start.Add(-time.Hour), start, start.Add(2*time.Minute))
	if !ok {
		t.Fatal("the charged window was not found")
	}
	if overlap != 2*time.Minute {
		t.Fatalf("refund = %v, want 2m", overlap)
	}
	// The deadline passed while the service was down. The player keeps the
	// time they had left when the service went down, so the refund is the
	// whole interruption and not the part of it that fitted in the clock.
	shortDeadline := start.Add(5 * time.Second)
	overlap, ok = recoveryOverlap(&shortDeadline, &activeSince, nil, nil, start.Add(-time.Hour), start, start.Add(100*time.Second))
	if !ok {
		t.Fatal("the charged window was not found")
	}
	if overlap != 100*time.Second {
		t.Fatalf("refund = %v, want 100s", overlap)
	}
	// A deadline that expired before the interruption is preserved.
	past := start.Add(-time.Minute)
	overlap, ok = recoveryOverlap(&past, &activeSince, nil, nil, start.Add(-time.Hour), start, start.Add(2*time.Minute))
	if !ok {
		t.Fatal("the charged window was not found")
	}
	if overlap != 0 {
		t.Fatalf("refund = %v, want 0", overlap)
	}
	// A clock that started inside the interruption is refunded only for the
	// part of its charge that fell inside it.
	later := start.Add(3 * time.Minute)
	overlap, ok = recoveryOverlap(&deadline, &later, nil, nil, start.Add(-time.Hour), start, start.Add(2*time.Minute))
	if !ok {
		t.Fatal("the charged window was not found")
	}
	if overlap != 0 {
		t.Fatalf("refund = %v, want 0", overlap)
	}
	// The opening reply window follows the same rule.
	replyDeadline := start.Add(5 * time.Second)
	firstMove := start.Add(-time.Minute)
	overlap, ok = recoveryOverlap(nil, nil, &replyDeadline, &firstMove, start.Add(-time.Hour), start, start.Add(100*time.Second))
	if !ok {
		t.Fatal("the reply window was not found")
	}
	if overlap != 100*time.Second {
		t.Fatalf("reply refund = %v, want 100s", overlap)
	}
}

// TestSuspensionBoundaryIdentityIsStable covers the exactly-once rule.
//
// The identity of an interruption is derived from its kind and its start, so
// a replay of the same interruption finds the same boundary.
func TestSuspensionBoundaryIdentityIsStable(t *testing.T) {
	start := time.Now().UTC()
	first := suspensionBoundaryID(SuspensionUnexpected, start)
	second := suspensionBoundaryID(SuspensionUnexpected, start)
	if first != second {
		t.Fatalf("the boundary identity changed from %q to %q", first, second)
	}
	other := suspensionBoundaryID(SuspensionUnexpected, start.Add(time.Second))
	if other == first {
		t.Fatal("two interruptions must have two identities")
	}
	planned := suspensionBoundaryID(SuspensionPlanned, start)
	if planned == first {
		t.Fatal("a planned and an unexpected interruption must have two identities")
	}
}
