package integration

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/engine"
	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/rulesworker"
	"github.com/Kamkmgamer/kamkmchess/backend/serverengine"
)

type serverEngineFixture struct {
	service *online.Service
	driver  *serverengine.Service
	options serverengine.Options
}

// newServerEngineFixture composes the online service with the real rules
// worker, the seat authorizer and a native engine. It skips without any of
// them.
func newServerEngineFixture(t *testing.T) serverEngineFixture {
	t.Helper()
	entry := os.Getenv("KHA66_WORKER_ENTRY")
	if entry == "" {
		t.Skip("set KHA66_WORKER_ENTRY to the built private worker")
	}
	enginePath := os.Getenv("KAMKM_ENGINE_PATH")
	if enginePath == "" {
		t.Skip("set KAMKM_ENGINE_PATH to a native UCI engine")
	}
	ctx := context.Background()
	pool := testPool(t)
	if err := migrations.Apply(ctx, pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	client, err := rulesworker.New(rulesworker.Config{Entry: entry, RequestTimeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	evaluator, err := rulesworker.NewOnlineEvaluator(client)
	if err != nil {
		t.Fatal(err)
	}
	authorizer, err := onlineauth.Open(ctx, pool, nil, onlineauth.Options{GuestCredentialTTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	service, err := online.Open(ctx, pool, evaluator, online.WithSeatAuthorizer(authorizer))
	if err != nil {
		t.Fatal(err)
	}
	engines, err := engine.Open(ctx, engine.Config{Path: enginePath, Size: 2})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(engines.Close)
	options := serverengine.Options{
		Matches:     service,
		Credentials: onlineauth.NewAllocator(authorizer),
		Mover:       engines,
		ActiveSeats: serverengine.PostgresSeats(pool),
		RetryAfter:  10 * time.Millisecond,
	}
	driver, err := serverengine.New(options)
	if err != nil {
		t.Fatal(err)
	}
	return serverEngineFixture{service: service, driver: driver, options: options}
}

// sweepUntil sweeps until the match reaches the wanted number of moves or
// ends.
func (f serverEngineFixture) sweepUntil(t *testing.T, matchID string, moves int) online.Match {
	t.Helper()
	ctx := context.Background()
	deadline := time.Now().Add(20 * time.Second)
	for {
		if err := f.driver.Sweep(ctx, 16); err != nil {
			t.Fatal(err)
		}
		f.driver.Wait()
		match, err := f.service.GetMatch(ctx, matchID)
		if err != nil {
			t.Fatal(err)
		}
		if len(match.Moves) >= moves || match.Status != online.MatchActive {
			return match
		}
		if time.Now().After(deadline) {
			t.Fatalf("the server engine stalled at %d moves", len(match.Moves))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// The server engine plays both sides of a match through the fenced command
// path: the runner lease, the seat credential and the rules worker.
func TestServerEnginePlaysBothSides(t *testing.T) {
	f := newServerEngineFixture(t)
	ctx := context.Background()
	black, err := serverengine.Seat(engine.MinThink)
	if err != nil {
		t.Fatal(err)
	}
	match, err := f.driver.CreateMatch(ctx, serverengine.MatchRequest{
		Actor:       black.Participant,
		Opponent:    black,
		EngineSeat:  online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 10 * 60 * 1000, IncrementMs: 0},
		Think:       engine.MinThink,
		OperationID: "op-server-engine-both",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, seat := range match.Seats {
		if seat.Control.Kind != online.ControlEngine || seat.Control.ModelLabel == nil || *seat.Control.ModelLabel != serverengine.Label {
			t.Fatalf("seat %s control = %+v, want the server engine label", seat.Seat, seat.Control)
		}
	}
	played := f.sweepUntil(t, match.MatchID, 6)
	if len(played.Moves) < 6 {
		t.Fatalf("the match ended after %d moves: %+v", len(played.Moves), played.Result)
	}
	for index, move := range played.Moves {
		want := online.SeatWhite
		if index%2 == 1 {
			want = online.SeatBlack
		}
		if move.Seat != want {
			t.Fatalf("move %d was played by %s, want %s", index, move.Seat, want)
		}
	}
}

// The engine answers a person's move, and it never moves for the person's
// seat.
func TestServerEngineAnswersAPerson(t *testing.T) {
	f := newServerEngineFixture(t)
	ctx := context.Background()
	alice := onlineauth.NewAccountPrincipal("user_alice", "sess_alice", "https://app.example", time.Now().Add(time.Hour))
	match, err := f.driver.CreateMatch(ctx, serverengine.MatchRequest{
		Actor:       alice.Participant,
		Opponent:    online.CreateSeat{Participant: alice.Participant, PublicLabel: "Alice", Control: online.SeatControl{Kind: online.ControlHuman}},
		EngineSeat:  online.SeatBlack,
		TimeControl: online.TimeControl{StartingTimeMs: 10 * 60 * 1000, IncrementMs: 0},
		Think:       engine.MinThink,
		OperationID: "op-server-engine-person",
	})
	if err != nil {
		t.Fatal(err)
	}
	// The engine plays black, so a sweep before the person moves does
	// nothing.
	if err = f.driver.Sweep(ctx, 16); err != nil {
		t.Fatal(err)
	}
	f.driver.Wait()
	if current, _ := f.service.GetMatch(ctx, match.MatchID); len(current.Moves) != 0 {
		t.Fatalf("the engine moved for the person: %+v", current.Moves)
	}
	move := online.Command{
		SchemaVersion: online.ContractsSchemaVersion, MatchID: match.MatchID, OperationID: "op-alice-e4",
		ExpectedVersion: match.Version, Seat: online.SeatWhite, ControlEpoch: match.ControlEpoch,
		Action: online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}},
	}
	if _, err = f.service.Execute(onlineauth.WithPrincipal(ctx, alice), alice.Participant, move); err != nil {
		t.Fatalf("the person's move: %v", err)
	}
	answered := f.sweepUntil(t, match.MatchID, 2)
	if len(answered.Moves) != 2 || answered.Moves[1].Seat != online.SeatBlack {
		t.Fatalf("the engine did not answer: %+v", answered.Moves)
	}
	// One more sweep leaves the person's turn alone.
	if err = f.driver.Sweep(ctx, 16); err != nil {
		t.Fatal(err)
	}
	f.driver.Wait()
	if current, _ := f.service.GetMatch(ctx, match.MatchID); len(current.Moves) != 2 {
		t.Fatalf("the engine moved twice: %d moves", len(current.Moves))
	}
}

// A restarted server lost the seat credential. The next turn rotates it and
// the engine keeps playing.
func TestServerEngineRecoversItsCredentialAfterARestart(t *testing.T) {
	f := newServerEngineFixture(t)
	ctx := context.Background()
	black, err := serverengine.Seat(engine.MinThink)
	if err != nil {
		t.Fatal(err)
	}
	match, err := f.driver.CreateMatch(ctx, serverengine.MatchRequest{
		Actor: black.Participant, Opponent: black, EngineSeat: online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 10 * 60 * 1000}, Think: engine.MinThink, OperationID: "op-server-engine-restart",
	})
	if err != nil {
		t.Fatal(err)
	}
	f.sweepUntil(t, match.MatchID, 2)
	// A fresh driver has no credentials in memory, like a restarted server.
	// Its first turn rotates the seat credential the old driver held.
	if f.driver, err = serverengine.New(f.options); err != nil {
		t.Fatal(err)
	}
	if played := f.sweepUntil(t, match.MatchID, 4); len(played.Moves) < 4 {
		t.Fatalf("the restarted engine stopped at %d moves", len(played.Moves))
	}
}
