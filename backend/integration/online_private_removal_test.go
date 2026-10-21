package integration

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/storage"
)

// TestPostgresAccountDeletionRemovesThePrivateOwnerData covers the private
// single-owner data of a deleted account.
//
// The approved handoff removes the service-held private owner data with the
// public identity: the owner's own games, their archive chunks, their archive
// events and their operation receipts. Only the payload free tombstones
// remain, the unrelated owners are untouched, and the account is fenced, so
// an old verified session can neither read nor write the private archive.
func TestPostgresAccountDeletionRemovesThePrivateOwnerData(t *testing.T) {
	fixture, removals, _ := privacyFixture(t)
	ctx := context.Background()
	store, err := storage.Open(ctx, fixture.pool, storage.WithAccountGate(removals))
	if err != nil {
		t.Fatal(err)
	}
	// The private games of the deleted account and of an unrelated owner.
	deletedID := "private-deleted-game"
	keptID := "private-kept-game"
	for _, game := range []struct{ id, owner string }{{deletedID, "user_a"}, {keptID, "user_b"}} {
		if _, err = store.Create(ctx, game.owner, storage.CreateGame{GameID: game.id, CheckpointJSON: checkpoint(game.id, game.owner, 1, 1, map[string]any{"kind": "unresolved"})}); err != nil {
			t.Fatalf("create private game: %v", err)
		}
	}
	// The private archive of the account.
	if _, err = fixture.pool.Exec(ctx, `INSERT INTO archive_chunks(game_id,sequence,item_id,raw_json,sha256) VALUES($1,0,'chunk-0',$2::bytea,'sha') ON CONFLICT (game_id,sequence) DO NOTHING`, deletedID, `{"payload":"private"}`); err != nil {
		t.Fatal(err)
	}
	if _, err = fixture.pool.Exec(ctx, `INSERT INTO archive_events(game_id,sequence,item_id,raw_json) VALUES($1,0,'event-0',$2::bytea) ON CONFLICT (game_id,sequence) DO NOTHING`, deletedID, `{"payload":"private"}`); err != nil {
		t.Fatal(err)
	}
	if _, err = fixture.pool.Exec(ctx, `INSERT INTO operations(owner_id,game_id,operation_id,request_hash,revision,ownership_epoch,result_json) VALUES('user_a',$1,'op-private-1',decode(repeat('11',32),'hex'),1,1,$2::bytea) ON CONFLICT (owner_id,game_id,operation_id) DO NOTHING`, deletedID, `{"result":"private"}`); err != nil {
		t.Fatal(err)
	}

	// The deletion removes the private data of the account.
	if _, err = removals.DeleteAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("delete account: %v", err)
	}
	var deletedAt *string
	if err = fixture.pool.QueryRow(ctx, `SELECT deleted_at::text FROM games WHERE game_id=$1`, deletedID).Scan(&deletedAt); err != nil {
		t.Fatal(err)
	}
	if deletedAt == nil {
		t.Fatal("the private game of the deleted account is still live")
	}
	var chunks, events int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM archive_chunks WHERE game_id=$1`, deletedID).Scan(&chunks); err != nil {
		t.Fatal(err)
	}
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM archive_events WHERE game_id=$1`, deletedID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if chunks != 0 || events != 0 {
		t.Fatalf("the private archive of the deleted account survived: %d chunks, %d events", chunks, events)
	}
	var payload int
	if err = fixture.pool.QueryRow(ctx, `SELECT length(checkpoint_json) FROM games WHERE game_id=$1`, deletedID).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if payload != 2 {
		t.Fatalf("the private checkpoint of the deleted account survived: %d bytes", payload)
	}
	var tombstones int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM deletion_tombstones WHERE game_id=$1 AND owner_id='user_a'`, deletedID).Scan(&tombstones); err != nil {
		t.Fatal(err)
	}
	if tombstones != 1 {
		t.Fatalf("the deletion tombstone of the private game is missing: %d", tombstones)
	}
	// The unrelated owner is untouched.
	var keptAt *string
	if err = fixture.pool.QueryRow(ctx, `SELECT deleted_at::text FROM games WHERE game_id=$1`, keptID).Scan(&keptAt); err != nil {
		t.Fatal(err)
	}
	if keptAt != nil {
		t.Fatal("the private game of an unrelated owner was removed")
	}

	// The private API refuses the deleted account and serves the other one.
	handler := httpapi.NewAuthenticatedWithFence(store, fixture.verifier, removals)
	refused := requestAPI(t, handler, http.MethodGet, "/v1/games", sign(t, fixture.key, "user_a"), "")
	if refused.Code != http.StatusUnauthorized {
		t.Fatalf("the private read of the deleted account status=%d body=%s", refused.Code, refused.Body.String())
	}
	refusedWrite := requestAPI(t, handler, http.MethodPost, "/v1/games", sign(t, fixture.key, "user_a"),
		fmt.Sprintf(`{"gameId":"private-recreated-game","checkpoint":%s}`, string(checkpoint("private-recreated-game", "user_a", 1, 1, map[string]any{"kind": "unresolved"}))))
	if refusedWrite.Code != http.StatusUnauthorized {
		t.Fatalf("the private write of the deleted account status=%d body=%s", refusedWrite.Code, refusedWrite.Body.String())
	}
	allowed := requestAPI(t, handler, http.MethodGet, "/v1/games", sign(t, fixture.key, "user_b"), "")
	if allowed.Code != http.StatusOK {
		t.Fatalf("the private read of an unrelated owner status=%d body=%s", allowed.Code, allowed.Body.String())
	}
}

// TestPostgresRemovalLedgerReplaysThePrivateOwnerData covers the restore of
// the private data.
//
// A restored database holds the private rows of a removed account again, and
// the removal ledger removes them a second time.
func TestPostgresRemovalLedgerReplaysThePrivateOwnerData(t *testing.T) {
	fixture, removals, _ := privacyFixture(t)
	ctx := context.Background()
	store, err := storage.Open(ctx, fixture.pool, storage.WithAccountGate(removals))
	if err != nil {
		t.Fatal(err)
	}
	gameID := "private-restore-game"
	if _, err = store.Create(ctx, "user_a", storage.CreateGame{GameID: gameID, CheckpointJSON: checkpoint(gameID, "user_a", 1, 1, map[string]any{"kind": "unresolved"})}); err != nil {
		t.Fatalf("create private game: %v", err)
	}
	if _, err = removals.DeleteAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("delete account: %v", err)
	}
	records, err := removals.ListRemovalRecords(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// The restored database holds the private row again.
	if _, err = fixture.pool.Exec(ctx, `UPDATE games SET deleted_at=NULL, checkpoint_json=$2::bytea, ownership_epoch=1 WHERE game_id=$1`, gameID, string(checkpoint(gameID, "user_a", 1, 1, map[string]any{"kind": "unresolved"}))); err != nil {
		t.Fatal(err)
	}
	if _, err = fixture.pool.Exec(ctx, `INSERT INTO archive_chunks(game_id,sequence,item_id,raw_json,sha256) VALUES($1,0,'chunk-0',$2::bytea,'sha') ON CONFLICT (game_id,sequence) DO NOTHING`, gameID, `{"a":1}`); err != nil {
		t.Fatal(err)
	}
	// The replay removes the restored private data again.
	if err = removals.ApplyRemovalRecords(ctx, records); err != nil {
		t.Fatalf("apply removal records: %v", err)
	}
	var chunks int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM archive_chunks WHERE game_id=$1`, gameID).Scan(&chunks); err != nil {
		t.Fatal(err)
	}
	if chunks != 0 {
		t.Fatalf("the restored private archive survived the ledger replay: %d chunks", chunks)
	}
	var deletedAt *string
	if err = fixture.pool.QueryRow(ctx, `SELECT deleted_at::text FROM games WHERE game_id=$1`, gameID).Scan(&deletedAt); err != nil {
		t.Fatal(err)
	}
	if deletedAt == nil {
		t.Fatal("the restored private game is live again")
	}
}

// The account of a guest never reaches the private store.
var _ = online.ParticipantGuest
