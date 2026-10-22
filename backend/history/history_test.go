package history

import (
	"errors"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// TestNormalizePublicLabelRefusesSecretBearingLabels covers the label screen.
//
// A public label is published to anybody who reads a replay, so a label that
// could carry a credential is refused.
func TestNormalizePublicLabelRefusesSecretBearingLabels(t *testing.T) {
	accepted := []string{"My chess model", "GPT-4o", "House bot", "Kimi K2"}
	for _, label := range accepted {
		if _, err := NormalizePublicLabel(label); err != nil {
			t.Fatalf("the label %q was refused: %v", label, err)
		}
	}
	refused := []string{
		"",
		"   ",
		"sk-live-9f8a7b6c5d4e3f2a1b0c",
		"sk_live_9f8a7b6c5d4e3f2a1b0c",
		"ghp_0123456789abcdefghijklmnopqrstuvwx",
		"xoxb-1234567890-abcdefghijkl",
		"my-api-key",
		"password123",
		"the secret model",
		"https://models.example/v1",
		"owner@example.com",
		"9f8a7b6c5d4e3f2a1b0c9d8e7f",
	}
	for _, label := range refused {
		if _, err := NormalizePublicLabel(label); !errors.Is(err, ErrInvalidLabel) {
			t.Fatalf("the label %q was accepted", label)
		}
	}
}

// TestReplayValidateRefusesAVerifiedAttribution covers the declared
// attribution rule.
//
// The service never confirms that a provider produced a move or that a
// browser engine produced a result.
func TestReplayValidateRefusesAVerifiedAttribution(t *testing.T) {
	replay := Replay{
		SchemaVersion:      ReplaySchemaVersion,
		MatchID:            "match-0001",
		Variant:            "orthodox",
		StartingFEN:        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
		TimeControl:        online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 2_000},
		GameKind:           GameFriend,
		Scored:             true,
		Attribution:        Attribution{Source: DeclarationDeclared, ProviderVerified: true},
		Participants:       []ReplayParticipant{},
		Result:             online.Result{Kind: online.ResultWin, Winner: seatPointer(online.SeatWhite), Reason: online.ReasonCheckmate},
		RulesPolicyVersion: "online-rules/1",
		CompletedAt:        time.Unix(1_900_000_000, 0).UTC(),
	}
	if err := replay.Validate(); err == nil {
		t.Fatal("a provider verified attribution was accepted")
	}
	replay.Attribution = Attribution{Source: DeclarationDeclared, ProviderVerified: false}
	replay.Participants = []ReplayParticipant{
		{Seat: online.SeatWhite, PublicLabel: "Alice", Control: DeclaredControl{Kind: online.ControlHuman, Declaration: DeclarationDeclared}},
		{Seat: online.SeatBlack, PublicLabel: "Bob", Control: DeclaredControl{Kind: online.ControlAgent, ModelLabel: stringPointer("GPT-4o"), Declaration: DeclarationDeclared}},
	}
	if err := replay.Validate(); err != nil {
		t.Fatalf("the allowlisted replay was refused: %v", err)
	}
}

// TestControlAtDoesNotRelabelEarlierMoves covers the attribution of an
// accepted move.
//
// A control change never relabels the moves that were accepted before it.
func TestControlAtDoesNotRelabelEarlierMoves(t *testing.T) {
	timeline := map[online.Seat][]timelineRow{
		online.SeatBlack: {
			{Version: 1, ControlKind: string(online.ControlHuman)},
			{Version: 5, ControlKind: string(online.ControlAgent), ModelLabel: stringPointer("GPT-4o")},
		},
	}
	before := controlAt(timeline, online.SeatBlack, 4)
	if before.Kind != online.ControlHuman || before.ModelLabel != nil {
		t.Fatalf("the control before the change = %+v", before)
	}
	after := controlAt(timeline, online.SeatBlack, 5)
	if after.Kind != online.ControlAgent || after.ModelLabel == nil || *after.ModelLabel != "GPT-4o" {
		t.Fatalf("the control after the change = %+v", after)
	}
	later := controlAt(timeline, online.SeatBlack, 9)
	if later.Kind != online.ControlAgent {
		t.Fatalf("the control of a later move = %+v", later)
	}
	// A seat without a timeline is a human seat.
	unknown := controlAt(timeline, online.SeatWhite, 3)
	if unknown.Kind != online.ControlHuman {
		t.Fatalf("the control of a seat without a timeline = %+v", unknown)
	}
}

// TestDeclaredControlNeverPublishesAnUnverifiedLabel covers the fallback of a
// declared control.
func TestDeclaredControlNeverPublishesAnUnverifiedLabel(t *testing.T) {
	human := declaredControl(string(online.ControlHuman), nil)
	if human.ModelLabel != nil || human.Declaration != DeclarationDeclared {
		t.Fatalf("the human control = %+v", human)
	}
	engine := declaredControl(string(online.ControlEngine), stringPointer("stockfish-19-lite"))
	if engine.ModelLabel == nil || *engine.ModelLabel != EngineLabel {
		t.Fatalf("the engine control = %+v", engine)
	}
	agent := declaredControl(string(online.ControlAgent), stringPointer("GPT-4o"))
	if agent.ModelLabel == nil || *agent.ModelLabel != "GPT-4o" {
		t.Fatalf("the agent control = %+v", agent)
	}
	empty := declaredControl(string(online.ControlAgent), nil)
	if empty.ModelLabel == nil || *empty.ModelLabel != NeutralModelLabel {
		t.Fatalf("the agent control without a label = %+v", empty)
	}
}

// TestTerminalKindNamesTheAction covers the terminal action of a replay.
func TestTerminalKindNamesTheAction(t *testing.T) {
	cases := []struct {
		result   online.Result
		expected string
	}{
		{online.Result{Kind: online.ResultWin, Winner: seatPointer(online.SeatWhite), Reason: online.ReasonCheckmate}, "checkmate"},
		{online.Result{Kind: online.ResultWin, Winner: seatPointer(online.SeatWhite), Reason: online.ReasonResignation}, "resign"},
		{online.Result{Kind: online.ResultWin, Winner: seatPointer(online.SeatWhite), Reason: online.ReasonTimeout}, "timeout"},
		{online.Result{Kind: online.ResultWin, Winner: seatPointer(online.SeatWhite), Reason: online.ReasonIllegalMove}, "illegal_move"},
		{online.Result{Kind: online.ResultDraw, Reason: online.ReasonAgreement}, "draw"},
		{online.Result{Kind: online.ResultAbort, Reason: online.ReasonAbort}, "abort"},
	}
	for _, testCase := range cases {
		if got := terminalKind(testCase.result, ""); got != testCase.expected {
			t.Fatalf("the terminal kind of %+v = %q, want %q", testCase.result, got, testCase.expected)
		}
	}
}

// TestParticipantOutcomeLabelsAnAbortAsUnscored covers the scored outcome of
// one participant.
func TestParticipantOutcomeLabelsAnAbortAsUnscored(t *testing.T) {
	win := online.Result{Kind: online.ResultWin, Winner: seatPointer(online.SeatWhite), Reason: online.ReasonCheckmate}
	if outcome, scored := participantOutcome(win, online.SeatWhite); outcome != OutcomeWin || !scored {
		t.Fatalf("the outcome of the winner = %q scored=%v", outcome, scored)
	}
	if outcome, scored := participantOutcome(win, online.SeatBlack); outcome != OutcomeLoss || !scored {
		t.Fatalf("the outcome of the loser = %q scored=%v", outcome, scored)
	}
	abort := online.Result{Kind: online.ResultAbort, Reason: online.ReasonAbort}
	if outcome, scored := participantOutcome(abort, online.SeatWhite); outcome != OutcomeAbort || scored {
		t.Fatalf("the outcome of an abort = %q scored=%v", outcome, scored)
	}
}

// seatPointer returns a pointer to a seat.
func seatPointer(seat online.Seat) *online.Seat { return &seat }

// stringPointer returns a pointer to a string.
func stringPointer(value string) *string { return &value }
