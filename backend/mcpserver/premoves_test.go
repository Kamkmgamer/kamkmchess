package mcpserver

import (
	"context"
	"errors"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/serverengine"
)

func TestParsePremovePlan(t *testing.T) {
	if plan, err := parsePremovePlan(nil); err != nil || plan != nil {
		t.Fatalf("absent premoves = %v, %v; want nil, nil", plan, err)
	}
	plan, err := parsePremovePlan([]any{
		map[string]any{"on": []any{"e7e5", " b8C6 "}, "then": "g1f3"},
		map[string]any{"on": []any{"c7c5"}, "then": map[string]any{
			"move": "c2c3", "premoves": []any{map[string]any{"on": []any{"g8f6"}, "then": "d2d4"}},
		}},
	})
	if err != nil {
		t.Fatalf("valid plan rejected: %v", err)
	}
	if len(plan) != 3 {
		t.Fatalf("plan expanded to %d nodes, want 3 (one per trigger)", len(plan))
	}
	if plan[0].Trigger != "e7e5" || plan[1].Trigger != "b8c6" || plan[0].Reply != "g1f3" {
		t.Fatalf("triggers or reply not normalized: %+v", plan[:2])
	}
	if len(plan[2].Premoves) != 1 || plan[2].Premoves[0].Reply != "d2d4" {
		t.Fatalf("nested plan lost: %+v", plan[2])
	}

	for name, raw := range map[string]any{
		"not-an-array":   "yes",
		"empty":          []any{},
		"over-branches":  make([]any, 9),
		"branch-object":  []any{"e2e4"},
		"on-not-array":   []any{map[string]any{"on": "e7e5", "then": "g1f3"}},
		"bad-trigger":    []any{map[string]any{"on": []any{"e9e5"}, "then": "g1f3"}},
		"bad-reply":      []any{map[string]any{"on": []any{"e7e5"}, "then": "g1f9"}},
		"missing-then":   []any{map[string]any{"on": []any{"e7e5"}}},
		"then-not-move":  []any{map[string]any{"on": []any{"e7e5"}, "then": 7}},
		"nested-overcap": []any{map[string]any{"on": []any{"e7e5"}, "then": map[string]any{"move": "g1f3", "premoves": make([]any, 9)}}},
	} {
		if plan, err := parsePremovePlan(raw); err == nil {
			t.Fatalf("%s: plan accepted: %+v", name, plan)
		}
	}

	// The depth budget allows exactly three pre-moved replies.
	deep := []any{map[string]any{"on": []any{"a7a6"}, "then": map[string]any{"move": "a2a3", "premoves": []any{
		map[string]any{"on": []any{"a6a5"}, "then": map[string]any{"move": "a3a4", "premoves": []any{
			map[string]any{"on": []any{"a5a4"}, "then": map[string]any{"move": "b2b3", "premoves": []any{
				map[string]any{"on": []any{"a4a3"}, "then": "c2c3"},
			}}},
		}}},
	}}}}
	if plan, err := parsePremovePlan(deep); err == nil {
		t.Fatalf("fourth reply accepted: %+v", plan)
	}
}

func TestArmedTriggerMatchesBothCastleSquareForms(t *testing.T) {
	for trigger, played := range map[string]string{
		"e1g1": "e1h1", "e1h1": "e1g1", "e8g8": "e8h8", "e1c1": "e1a1", "e8c8": "e8a8",
		"g1f3": "g1f3", " E7E5 ": "e7e5",
	} {
		if !armedTriggerMatches(trigger, played) {
			t.Fatalf("trigger %s did not match played %s", trigger, played)
		}
	}
	if armedTriggerMatches("e1g1", "e1a1") {
		t.Fatal("kingside trigger matched a queenside move")
	}
	if armedTriggerMatches("g1f3", "g8f6") {
		t.Fatal("distinct plain moves matched")
	}
}

func TestPremoveRegistryCopiesAndClears(t *testing.T) {
	registry := newPremoveRegistry()
	if nodes := registry.armed("m1", online.SeatWhite); nodes != nil {
		t.Fatalf("empty registry returned %+v", nodes)
	}
	plan := []armedPremoveNode{{Trigger: "e7e5", Reply: "g1f3"}}
	registry.arm("m1", online.SeatWhite, plan)
	plan[0].Reply = "mutated"
	nodes := registry.armed("m1", online.SeatWhite)
	if len(nodes) != 1 || nodes[0].Reply != "g1f3" {
		t.Fatalf("armed plan aliased its caller: %+v", nodes)
	}
	if registry.armed("m1", online.SeatBlack) != nil {
		t.Fatal("the other seat saw a foreign plan")
	}
	registry.clear("m1", online.SeatWhite)
	if nodes := registry.armed("m1", online.SeatWhite); nodes != nil {
		t.Fatalf("cleared plan survived: %+v", nodes)
	}
}

// fakeMatches replays a scripted position for one seat and records submissions.
type fakeMatches struct {
	match    online.Match
	submits  []string
	refuse   error
	fenByUCI map[string]string
}

func (f *fakeMatches) GetMatch(context.Context, string) (online.Match, error) { return f.match, nil }

func (f *fakeMatches) AcquireRunnerLease(context.Context, online.ParticipantRef, online.RunnerLeaseRequest) (online.RunnerLease, error) {
	return online.RunnerLease{LeaseID: "lease-1"}, nil
}

func (f *fakeMatches) Execute(_ context.Context, _ online.ParticipantRef, cmd online.Command) (online.CommandResult, error) {
	if cmd.Action.SubmitMove == nil {
		return online.CommandResult{}, nil
	}
	uci := cmd.Action.SubmitMove.UCI
	if f.refuse != nil {
		err := f.refuse
		f.refuse = nil
		return online.CommandResult{}, err
	}
	f.submits = append(f.submits, uci)
	if fen, ok := f.fenByUCI[uci]; ok {
		f.match.PositionFEN = fen
	}
	f.match.Moves = append(f.match.Moves, online.Move{Version: f.match.Version, Seat: cmd.Seat, UCI: uci, SAN: uci, ResultingFEN: f.match.PositionFEN})
	f.match.Version++
	return online.CommandResult{}, nil
}

func fireFixture(t *testing.T) (*Server, *fakeMatches, *session) {
	t.Helper()
	matches := &fakeMatches{match: online.Match{
		MatchID: "m1", Status: online.MatchActive,
		PositionFEN: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
		Version:     2, ControlEpoch: 1,
		Moves: []online.Move{
			{Version: 1, Seat: online.SeatWhite, UCI: "e2e4", SAN: "e4"},
			{Version: 2, Seat: online.SeatBlack, UCI: "e7e5", SAN: "e5"},
		},
	}, fenByUCI: map[string]string{
		"g1f3": "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
	}}
	server, err := New(Options{Matches: matches, Engine: fakeEngine{}, Credentials: fakeCredentials{},
		Authenticator: fakeAuthenticator{}, ActiveGames: func(context.Context) (int, error) { return 0, nil }})
	if err != nil {
		t.Fatalf("server did not start: %v", err)
	}
	sess := &session{id: "session-1234567890", matchID: "m1", seat: online.SeatWhite,
		principal: onlineauth.Principal{Participant: online.ParticipantRef{ID: "mcp-agent:test"}}}
	return server, matches, sess
}

type fakeEngine struct{}

func (fakeEngine) CreateMatch(context.Context, serverengine.MatchRequest) (online.Match, error) {
	return online.Match{}, errors.New("not used")
}

type fakeCredentials struct{}

func (fakeCredentials) IssueEngineSeatCredential(context.Context, onlineauth.EngineSeatRequest) (onlineauth.EngineSeatCredentialOutcome, error) {
	return onlineauth.EngineSeatCredentialOutcome{}, errors.New("not used")
}

type fakeAuthenticator struct{}

func (fakeAuthenticator) AuthenticateGuest(context.Context, string, string) (onlineauth.Principal, error) {
	return onlineauth.Principal{}, errors.New("not used")
}

func TestMaybeFireArmedPremovesKeepsThePlanWhileTheReplyIsPending(t *testing.T) {
	server, matches, sess := fireFixture(t)
	// The fixture match has White to move; the pending state is White's own move on
	// the board with Black's reply outstanding, so the plan must keep waiting.
	matches.match.PositionFEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
	matches.match.Moves = matches.match.Moves[:1]
	server.premoves.arm("m1", sess.seat, []armedPremoveNode{{Trigger: "g1f3", Reply: "g8f6"}})
	fired := server.maybeFireArmedPremoves(context.Background(), sess, matches.match)
	if len(matches.submits) != 0 {
		t.Fatalf("the premove fired while it was still the opponent's turn: %v", matches.submits)
	}
	if nodes := server.premoves.armed("m1", sess.seat); len(nodes) != 1 {
		t.Fatalf("the pending plan was consumed: %+v", nodes)
	}
	if fired.PositionFEN != matches.match.PositionFEN {
		t.Fatalf("the match moved without a submission")
	}
}

func TestMaybeFireArmedPremovesFiresAndConsumesOnMatch(t *testing.T) {
	server, matches, sess := fireFixture(t)
	server.premoves.arm("m1", sess.seat, []armedPremoveNode{{Trigger: "e7e5", Reply: "g1f3"}})
	fired := server.maybeFireArmedPremoves(context.Background(), sess, matches.match)
	if len(matches.submits) != 1 || matches.submits[0] != "g1f3" {
		t.Fatalf("submissions = %v, want [g1f3]", matches.submits)
	}
	if nodes := server.premoves.armed("m1", sess.seat); nodes != nil {
		t.Fatalf("a fired plan with no nested branches stayed armed: %+v", nodes)
	}
	if len(fired.Moves) != 3 || fired.Moves[2].UCI != "g1f3" {
		t.Fatalf("the fired move is missing from the fresh match: %+v", fired.Moves)
	}
}

func TestMaybeFireArmedPremovesDiscardsOnNonMatchAndReArmsNested(t *testing.T) {
	server, matches, sess := fireFixture(t)
	server.premoves.arm("m1", sess.seat, []armedPremoveNode{
		{Trigger: "b1c3", Reply: "g8f6"},
		{Trigger: "e7e5", Reply: "g1f3", Premoves: []armedPremoveNode{{Trigger: "d7d5", Reply: "f1c4"}}},
	})
	fired := server.maybeFireArmedPremoves(context.Background(), sess, matches.match)
	if len(matches.submits) != 1 || matches.submits[0] != "g1f3" {
		t.Fatalf("submissions = %v, want [g1f3]", matches.submits)
	}
	if len(fired.Moves) != 3 {
		t.Fatalf("the fired move is missing from the fresh match")
	}
	nodes := server.premoves.armed("m1", sess.seat)
	if len(nodes) != 1 || nodes[0].Trigger != "d7d5" || nodes[0].Reply != "f1c4" {
		t.Fatalf("the nested plan did not re-arm: %+v", nodes)
	}
	// The next reply matches nothing, so the plan is discarded without a submission.
	matches.match.PositionFEN = "rnbqkbnr/pppp1ppp/8/3pp2/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3"
	matches.match.Moves = append(matches.match.Moves, online.Move{Version: 3, Seat: online.SeatBlack, UCI: "d7d6", SAN: "d6"})
	server.maybeFireArmedPremoves(context.Background(), sess, matches.match)
	if len(matches.submits) != 1 {
		t.Fatalf("a discarded plan submitted %v", matches.submits[1:])
	}
	if nodes := server.premoves.armed("m1", sess.seat); nodes != nil {
		t.Fatalf("a discarded plan survived: %+v", nodes)
	}
}

func TestMaybeFireArmedPremovesDropsARefusedReply(t *testing.T) {
	server, matches, sess := fireFixture(t)
	server.premoves.arm("m1", sess.seat, []armedPremoveNode{{Trigger: "e7e5", Reply: "e4e5"}})
	matches.refuse = online.ErrActionNotAllowed
	server.maybeFireArmedPremoves(context.Background(), sess, matches.match)
	if len(matches.submits) != 0 {
		t.Fatalf("a refused premove was recorded as submitted: %v", matches.submits)
	}
	if nodes := server.premoves.armed("m1", sess.seat); nodes != nil {
		t.Fatalf("a dropped plan stayed armed: %+v", nodes)
	}
}

func TestMaybeFireArmedPremovesClearsAFinishedGame(t *testing.T) {
	server, matches, sess := fireFixture(t)
	server.premoves.arm("m1", sess.seat, []armedPremoveNode{{Trigger: "e7e5", Reply: "g1f3"}})
	matches.match.Status = online.MatchCompleted
	server.maybeFireArmedPremoves(context.Background(), sess, matches.match)
	if nodes := server.premoves.armed("m1", sess.seat); nodes != nil {
		t.Fatalf("a finished game kept an armed plan: %+v", nodes)
	}
	if len(matches.submits) != 0 {
		t.Fatalf("a finished game submitted %v", matches.submits)
	}
}
