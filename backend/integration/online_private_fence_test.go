package integration

// The account gate of the private store.
//
// A deleted account is fenced: its private data was removed, so a write of that
// account is refused even when its session token still verifies. The delete of
// a private game is a write of the account, so it consults the gate like every
// other write of the store.

import (
	"context"
	"errors"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/storage"
)

// TestPostgresAFencedAccountCannotDeleteItsGame covers the account gate of
// the delete of a private game.
//
// The delete of a game writes the game, its archive and its receipts, so it is
// a write of the account. A deleted account is fenced, so the delete is
// refused instead of being answered as an idempotent success, and it changes
// nothing.
func TestPostgresAFencedAccountCannotDeleteItsGame(t *testing.T) {
	fixture, removals, _ := privacyFixture(t)
	ctx := context.Background()
	store, err := storage.Open(ctx, fixture.pool, storage.WithAccountGate(removals))
	if err != nil {
		t.Fatal(err)
	}
	gameID := "private-fenced-delete"
	if _, err = store.Create(ctx, "user_a", storage.CreateGame{GameID: gameID, CheckpointJSON: checkpoint(gameID, "user_a", 1, 1, map[string]any{"kind": "unresolved"})}); err != nil {
		t.Fatalf("create the private game: %v", err)
	}
	// The account is deleted: it is fenced and its private data is gone.
	if _, err = removals.DeleteAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("delete the account: %v", err)
	}
	var epochBefore int64
	if err = fixture.pool.QueryRow(ctx, `SELECT ownership_epoch FROM games WHERE game_id=$1`, gameID).Scan(&epochBefore); err != nil {
		t.Fatal(err)
	}
	// The delete of the game is refused: a deleted account may not mutate its
	// own data any more.
	err = store.Delete(ctx, "user_a", storage.CASRequest{GameID: gameID, ExpectedRevision: 1, ExpectedEpoch: 1})
	if !errors.Is(err, storage.ErrAccountFenced) {
		t.Fatalf("the delete of a fenced account returned %v, want ErrAccountFenced", err)
	}
	// The refused write changed nothing.
	var epochAfter int64
	if err = fixture.pool.QueryRow(ctx, `SELECT ownership_epoch FROM games WHERE game_id=$1`, gameID).Scan(&epochAfter); err != nil {
		t.Fatal(err)
	}
	if epochAfter != epochBefore {
		t.Fatalf("the refused delete moved the epoch of the game from %d to %d", epochBefore, epochAfter)
	}
}
