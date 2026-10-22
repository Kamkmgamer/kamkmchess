package integration

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
	"github.com/Kamkmgamer/kamkmchess/backend/locks"
	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
	"github.com/Kamkmgamer/kamkmchess/backend/serverapp"
	"github.com/Kamkmgamer/kamkmchess/backend/storage"
)

// TestPostgresPrivateWriteWaitsForTheAccountScopeLock covers the ordering of
// a private write and the removal of the account.
//
// The private store takes the account scope lock before it consults the
// account gate, and the removal takes the same lock. A write of the account
// and the removal of its private data are therefore ordered: a write can
// never insert a new game after the removal committed.
func TestPostgresPrivateWriteWaitsForTheAccountScopeLock(t *testing.T) {
	fixture, removals, _ := privacyFixture(t)
	ctx := context.Background()
	store, err := storage.Open(ctx, fixture.pool, storage.WithAccountGate(removals))
	if err != nil {
		t.Fatal(err)
	}
	// A write of the account holds the account scope lock.
	held, err := fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Rollback(ctx)
	if err = locks.LockAccountScope(ctx, held, locks.AccountScope("account", "user_a")); err != nil {
		t.Fatal(err)
	}
	// The removal of the same account waits for the lock.
	removalDone := make(chan error, 1)
	go func() {
		_, err := removals.DeleteAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin)
		removalDone <- err
	}()
	select {
	case err = <-removalDone:
		t.Fatalf("the removal did not wait for the account scope lock: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	// A private write of the same account waits for the lock as well.
	writeDone := make(chan error, 1)
	go func() {
		_, err := store.Create(ctx, "user_a", storage.CreateGame{GameID: "private-race-game", CheckpointJSON: checkpoint("private-race-game", "user_a", 1, 1, map[string]any{"kind": "unresolved"})})
		writeDone <- err
	}()
	select {
	case err = <-writeDone:
		t.Fatalf("the private write did not wait for the account scope lock: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	// The lock is released and both flows continue, in order.
	if err = held.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-removalDone; err != nil {
		t.Fatalf("the removal failed: %v", err)
	}
	writeErr := <-writeDone
	if writeErr == nil {
		t.Fatal("the private write of a removed account was accepted")
	}
	var games int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM games WHERE game_id='private-race-game'`).Scan(&games); err != nil {
		t.Fatal(err)
	}
	if games != 0 {
		t.Fatal("the private game of a removed account was created after the removal")
	}
}

// TestPostgresOlderBackupKeepsTheRemovedSubjectRemoved covers the restore of
// an older backup.
//
// The older backup has no deletion record of the account: the account was
// removed after that backup was taken. The subject level removal record is
// the only carrier of the removal, so the restore of the older state has to
// remove the private data again and fence the account again.
func TestPostgresOlderBackupKeepsTheRemovedSubjectRemoved(t *testing.T) {
	fixture, removals, _ := privacyFixture(t)
	ctx := context.Background()
	store, err := storage.Open(ctx, fixture.pool, storage.WithAccountGate(removals))
	if err != nil {
		t.Fatal(err)
	}
	gameID := "private-older-backup-game"
	keptID := "private-older-backup-kept"
	for _, game := range []struct{ id, owner string }{{gameID, "user_a"}, {keptID, "user_b"}} {
		if _, err = store.Create(ctx, game.owner, storage.CreateGame{GameID: game.id, CheckpointJSON: checkpoint(game.id, game.owner, 1, 1, map[string]any{"kind": "unresolved"})}); err != nil {
			t.Fatalf("create private game: %v", err)
		}
	}
	if _, err = fixture.pool.Exec(ctx, `INSERT INTO archive_chunks(game_id,sequence,item_id,raw_json,sha256) VALUES($1,0,'chunk-0',$2::bytea,'sha') ON CONFLICT (game_id,sequence) DO NOTHING`, gameID, `{"payload":"private"}`); err != nil {
		t.Fatal(err)
	}
	// The account is removed in the live database.
	if _, err = removals.DeleteAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("delete account: %v", err)
	}
	subjectRecords, err := removals.ListSubjectRemovalRecords(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(subjectRecords) != 1 {
		t.Fatalf("the subject removal ledger holds %d records", len(subjectRecords))
	}
	if subjectRecords[0].SubjectRef == "user_a" {
		t.Fatalf("the subject removal record keeps the raw identifier: %+v", subjectRecords[0])
	}

	// The restored database is the older state: the private game is live again
	// and the deletion records of the account are absent.
	restored := testPool(t)
	if err = migrations.Apply(ctx, restored); err != nil {
		t.Fatalf("apply migrations to the restored database: %v", err)
	}
	if _, err = restored.Exec(ctx, `INSERT INTO games(game_id,owner_id,revision,ownership_epoch,checkpoint_json) VALUES($1,'user_a',1,1,$2::bytea)`, gameID, string(checkpoint(gameID, "user_a", 1, 1, map[string]any{"kind": "unresolved"}))); err != nil {
		t.Fatal(err)
	}
	if _, err = restored.Exec(ctx, `INSERT INTO archive_chunks(game_id,sequence,item_id,raw_json,sha256) VALUES($1,0,'chunk-0',$2::bytea,'sha')`, gameID, `{"payload":"private"}`); err != nil {
		t.Fatal(err)
	}
	if _, err = restored.Exec(ctx, `INSERT INTO games(game_id,owner_id,revision,ownership_epoch,checkpoint_json) VALUES($1,'user_b',1,1,$2::bytea)`, keptID, string(checkpoint(keptID, "user_b", 1, 1, map[string]any{"kind": "unresolved"}))); err != nil {
		t.Fatal(err)
	}
	var deletions int
	if err = restored.QueryRow(ctx, `SELECT count(*) FROM online_account_deletions`).Scan(&deletions); err != nil {
		t.Fatal(err)
	}
	if deletions != 0 {
		t.Fatal("the older backup state carries a deletion record")
	}
	// The restored database serves the private data of the removed account
	// before the ledger is replayed.
	restoredStore, err := storage.Open(ctx, restored)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = restoredStore.Get(ctx, "user_a", gameID); err != nil {
		t.Fatalf("the restored private game is not readable: %v", err)
	}
	// The subject removal record is replayed on the restored database.
	restoredRemovals, err := privacy.Open(ctx, restored, fixture.authorizer, privacy.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err = restoredRemovals.ApplySubjectRemovalRecords(ctx, subjectRecords); err != nil {
		t.Fatalf("apply subject removal records: %v", err)
	}
	// The private data of the removed account is gone again.
	var chunks int
	if err = restored.QueryRow(ctx, `SELECT count(*) FROM archive_chunks WHERE game_id=$1`, gameID).Scan(&chunks); err != nil {
		t.Fatal(err)
	}
	if chunks != 0 {
		t.Fatalf("the restored private archive survived the replay: %d chunks", chunks)
	}
	var deletedAt *string
	if err = restored.QueryRow(ctx, `SELECT deleted_at::text FROM games WHERE game_id=$1`, gameID).Scan(&deletedAt); err != nil {
		t.Fatal(err)
	}
	if deletedAt == nil {
		t.Fatal("the restored private game of the removed account is live again")
	}
	// The unrelated owner is untouched.
	var keptAt *string
	if err = restored.QueryRow(ctx, `SELECT deleted_at::text FROM games WHERE game_id=$1`, keptID).Scan(&keptAt); err != nil {
		t.Fatal(err)
	}
	if keptAt != nil {
		t.Fatal("the private game of an unrelated owner was removed")
	}
	// The account is fenced again: its old session cannot write any more.
	var revoked int
	if err = restored.QueryRow(ctx, `SELECT count(*) FROM online_session_revocations WHERE subject_id='user_a' AND session_id='*'`).Scan(&revoked); err != nil {
		t.Fatal(err)
	}
	if revoked == 0 {
		t.Fatal("the restored account is not fenced")
	}
	fencedStore, err := storage.Open(ctx, restored, storage.WithAccountGate(restoredRemovals))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = fencedStore.Create(ctx, "user_a", storage.CreateGame{GameID: "private-after-restore", CheckpointJSON: checkpoint("private-after-restore", "user_a", 1, 1, map[string]any{"kind": "unresolved"})}); err == nil {
		t.Fatal("the restored account wrote into the private store")
	}
}

// TestPostgresTheServiceAndTheRestoreShareTheRestoreFence covers the
// configuration of the durable restore fence.
//
// The service and the restore tool have to use the same fence, so a restore
// that crashed is visible to the service. The configuration is read by the
// service configuration, and the fence path has to be a shared persistent
// location.
func TestPostgresTheServiceAndTheRestoreShareTheRestoreFence(t *testing.T) {
	fencePath := filepath.Join(t.TempDir(), "restore.fence")
	environment := map[string]string{
		"DATABASE_URL":              "postgres://example.invalid/db",
		"APP_ALLOWED_ORIGINS":       "https://app.example",
		"CLERK_ISSUER":              "https://clerk.example",
		"CLERK_JWKS_URL":            "https://clerk.example/.well-known/jwks.json",
		"CLERK_AUTHORIZED_PARTIES":  "https://app.example",
		"ONLINE_RESTORE_FENCE_PATH": fencePath,
	}
	config, err := serverapp.Load(func(key string) string { return environment[key] })
	if err != nil {
		t.Fatalf("load configuration: %v", err)
	}
	if config.Online.RestoreFencePath != fencePath {
		t.Fatalf("the configured restore fence path = %q", config.Online.RestoreFencePath)
	}
	// The service admission reads exactly the configured fence.
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	removals, err := privacy.Open(context.Background(), fixture.pool, fixture.authorizer, privacy.Options{FencePath: config.Online.RestoreFencePath})
	if err != nil {
		t.Fatal(err)
	}
	allowed, err := removals.ServingAllowed(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("a fresh database must serve traffic")
	}
	// The restore writes the fence at the configured path.
	crashed, err := removals.BeginFence("restore-crash", false)
	if err != nil {
		t.Fatalf("write fence: %v", err)
	}
	crashed.Release()
	// The service sees the fence of the crashed restore and refuses to serve.
	allowed, err = removals.ServingAllowed(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("the service serves a restored database whose restore crashed")
	}
	fence, open, err := removals.ReadFence("restore-crash")
	if err != nil {
		t.Fatal(err)
	}
	if !open || fence.RestoreID != "restore-crash" {
		t.Fatalf("the fence of the crashed restore = %+v (open %v)", fence, open)
	}
	var subjectRecords []backup.SubjectRemovalRecord
	if subjectRecords, err = removals.ListSubjectRemovalRecords(context.Background()); err != nil {
		t.Fatal(err)
	}
	merged, err := backup.MergeSubjectRemovalLedgers(subjectRecords, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(merged) != len(subjectRecords) {
		t.Fatalf("the merged subject ledger = %d records", len(merged))
	}
}

// ctxBackground returns a background context.
func ctxBackground() context.Context { return context.Background() }
