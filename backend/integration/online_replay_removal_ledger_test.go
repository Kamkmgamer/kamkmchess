package integration

// The regressions of the per match removal of a public replay.
//
// The removal of a public replay is a fact that has to survive a restore, and
// a match whose shared replay was erased must not publish again. The tests
// below drive the real writer, the real privacy service, the real history
// publisher, the real backup restore lifecycle and a real PostgreSQL database.

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
	"github.com/Kamkmgamer/kamkmchess/backend/history"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
	"github.com/jackc/pgx/v5/pgxpool"
)

// replayRemovalState is the state of a published match before the removal of
// its public replay.
//
// The import of a bundle replaces the state of the database with the state of
// the bundle, and the bundle was sealed before the removal. The import brings
// the published projection and the published replay of the match back, so the
// replay of the removal ledger is observable.
type replayRemovalState struct {
	matchID             string
	projectionJSON      []byte
	projectionHash      []byte
	projectionPublished time.Time
	replayJSON          []byte
	replayHash          []byte
	replayGameKind      string
	replayScored        bool
	replayPublished     time.Time
}

// captureReplayRemovalState reads the published state of a match.
func captureReplayRemovalState(t *testing.T, pool *pgxpool.Pool, matchID string) replayRemovalState {
	t.Helper()
	state := replayRemovalState{matchID: matchID}
	if err := pool.QueryRow(context.Background(), `
		SELECT projection_json,result_hash,published_at
		FROM online_public_projections WHERE match_id=$1`, matchID).
		Scan(&state.projectionJSON, &state.projectionHash, &state.projectionPublished); err != nil {
		t.Fatalf("read the projection of %s: %v", matchID, err)
	}
	if err := pool.QueryRow(context.Background(), `
		SELECT replay_json,result_hash,game_kind,scored,published_at
		FROM online_public_replays WHERE match_id=$1`, matchID).
		Scan(&state.replayJSON, &state.replayHash, &state.replayGameKind, &state.replayScored, &state.replayPublished); err != nil {
		t.Fatalf("read the public replay of %s: %v", matchID, err)
	}
	return state
}

// replayRemovalRestorer is the import of a bundle.
//
// The import replaces the state of the live database with the state of the
// bundle: the published projection and the published replay of the match come
// back, and the removal ledger of the live database is replaced by the ledger
// of the bundle, which was sealed before the removal.
type replayRemovalRestorer struct {
	pool  *pgxpool.Pool
	state replayRemovalState
}

func (r replayRemovalRestorer) Restore(ctx context.Context, sql io.Reader) error {
	_, _ = io.Copy(io.Discard, sql)
	if r.pool == nil {
		return nil
	}
	// The import replaces the state of the tables it restores. The deletion
	// markers and the removal ledger of the live database are gone with it,
	// because the bundle was sealed before the removal.
	if _, err := r.pool.Exec(ctx, `
		TRUNCATE online_public_replays,online_public_projections,online_deletion_markers,
			online_removal_ledger,online_replay_removal_ledger,online_removal_requests,
			online_removal_subjects,online_account_deletions`); err != nil {
		return err
	}
	if _, err := r.pool.Exec(ctx, `
		INSERT INTO online_public_projections(match_id,schema_version,projection_json,result_hash,published_at)
		VALUES($1,1,$2::jsonb,$3,$4)`,
		r.state.matchID, r.state.projectionJSON, r.state.projectionHash, r.state.projectionPublished); err != nil {
		return err
	}
	if _, err := r.pool.Exec(ctx, `
		INSERT INTO online_public_replays(match_id,schema_version,replay_json,result_hash,game_kind,scored,published_at)
		VALUES($1,2,$2::jsonb,$3,$4,$5,$6)`,
		r.state.matchID, r.state.replayJSON, r.state.replayHash, r.state.replayGameKind, r.state.replayScored, r.state.replayPublished); err != nil {
		return err
	}
	return nil
}

// TestPostgresThePerMatchReplayRemovalIsReplayedOnAnOlderBundle covers the
// per match removal of a public replay and the restore of an older bundle.
//
// The removal of a public replay is recorded in the durable removal ledger, so
// the bundle that is sealed after the removal carries it. A restore of an older
// bundle replays that ledger before the restored database serves traffic, so
// the public replay of the match does not come back with the older state.
func TestPostgresThePerMatchReplayRemovalIsReplayedOnAnOlderBundle(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	matchID := "evidence-replay-removal-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)

	// The older bundle is sealed before the removal: the public replay of the
	// match is live in it.
	state := captureReplayRemovalState(t, fixture.pool, matchID)
	older := evidenceBundle(t, t.TempDir(), nil, nil)

	// The participant asks for the public replay of the match to leave the
	// public URL.
	historyExecute(t, fixture, matchID, "op-remove-replay", accountSeat{Subject: "user_a", Seat: online.SeatWhite}, 3, 1, online.Action{
		Kind:         online.ActionRemovePublicReplay,
		RemoveReplay: &online.RemovePublicReplayAction{Reason: "owner_request"},
	})

	// The removal is recorded in the durable removal ledger. The record names
	// no subject: a per match removal keeps its participants.
	live, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	removal, found := backup.RemovalRecord{}, false
	for _, record := range live.Matches {
		if record.MatchID != matchID {
			continue
		}
		if record.Scope != backup.ScopeReplayRemoval {
			t.Fatalf("the ledger record of the match = %+v", record)
		}
		if record.SubjectKind != backup.SubjectKindMatch || record.SubjectID != "" {
			t.Fatalf("the ledger record of the per match removal names a subject: %+v", record)
		}
		removal, found = record, true
	}
	if !found {
		t.Fatalf("the removal of the public replay is not in the durable ledger: %+v", live.Matches)
	}

	// The bundle that is sealed after the removal carries the removal.
	newer := evidenceBundle(t, t.TempDir(), live.Matches, live.Subjects)
	verified, err := backup.Verify(newer, []byte("evidence-passphrase-0001"))
	if err != nil {
		t.Fatalf("verify the newer bundle: %v", err)
	}
	carried := false
	for _, record := range verified.Payload.Removals {
		if record.MatchID == matchID && record.Scope == backup.ScopeReplayRemoval {
			carried = true
		}
	}
	if !carried {
		t.Fatalf("the bundle does not carry the removal of the public replay: %+v", verified.Payload.Removals)
	}

	// The restore of the older bundle replays the newer removal ledger before
	// the restored database serves traffic.
	result, err := backup.Restore(ctx, backup.RestoreRequest{
		Path:                older,
		Passphrase:          []byte("evidence-passphrase-0001"),
		Restorer:            replayRemovalRestorer{pool: fixture.pool, state: state},
		Tombstones:          evidenceTombstones{},
		Removals:            evidenceLedger{service: removals},
		AdmissionFence:      evidenceLedger{service: removals},
		RestoreID:           "evidence-replay-removal-restore",
		NewerRemovalLedgers: [][]backup.RemovalRecord{verified.Payload.Removals},
	})
	if err != nil {
		t.Fatalf("restore the older bundle: %v", err)
	}
	if result.RemovalsApplied != 1 {
		t.Fatalf("the restore replayed %d removals", result.RemovalsApplied)
	}

	// The public replay of the match is erased again: the older state does not
	// survive the replay of the removal ledger.
	var replayJSON []byte
	var revokedAt *time.Time
	if err = fixture.pool.QueryRow(ctx, `SELECT replay_json,revoked_at FROM online_public_replays WHERE match_id=$1`, matchID).Scan(&replayJSON, &revokedAt); err != nil {
		t.Fatal(err)
	}
	if revokedAt == nil {
		t.Fatal("the restored public replay of the match is live again")
	}
	if !bytes.Equal(replayJSON, []byte("{}")) {
		t.Fatalf("the restored public replay still carries its payload: %s", replayJSON)
	}
	// The projection of the match is erased again too.
	var projectionRevoked *time.Time
	if err = fixture.pool.QueryRow(ctx, `SELECT revoked_at FROM online_public_projections WHERE match_id=$1`, matchID).Scan(&projectionRevoked); err != nil {
		t.Fatal(err)
	}
	if projectionRevoked == nil {
		t.Fatal("the restored projection of the match is live again")
	}
	// The applied ledger holds the removal, so the restore may release the
	// gate and the service serves again.
	applied, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !backup.RemovalLedgerContains(applied, backup.AppliedRemovalLedger{Matches: []backup.RemovalRecord{removal}}) {
		t.Fatalf("the applied ledger does not hold the removal: %+v", applied)
	}
	allowed, err := removals.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("the service does not serve after a restore that applied the removal")
	}
	// The publisher refuses to publish the removed replay.
	if _, err = historyService.ProjectMatch(ctx, matchID); !errors.Is(err, history.ErrNotFound) {
		t.Fatalf("the publisher published the removed replay again: %v", err)
	}
	// The per match removal keeps its participants: the seat of the
	// participant is not anonymized by it.
	var ownerID string
	if err = fixture.pool.QueryRow(ctx, `SELECT owner_id FROM online_seats WHERE match_id=$1 AND seat='white'`, matchID).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	if ownerID == "anonymized" {
		t.Fatal("the per match removal of a public replay removed its participant")
	}
}

// TestPostgresTheRemovedMatchDoesNotPublishWhenItFinishes covers the explicit
// removal of a participant while the match is still running.
//
// The removal takes the match lock, so it is ordered against the publication
// of the match. A match whose shared replay was erased must not publish a
// projection when it finishes.
func TestPostgresTheRemovedMatchDoesNotPublishWhenItFinishes(t *testing.T) {
	fixture, removals, historyService := privacyFixture(t)
	ctx := context.Background()
	matchID := "privacy-running-removal-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})

	// The white seat asks for an explicit removal while the match is running.
	report, err := removals.RemoveAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin)
	if err != nil {
		t.Fatalf("remove the account: %v", err)
	}
	if report.Scope != privacy.ScopeExplicitRemoval || report.RemovedMatches != 1 {
		t.Fatalf("the removal report = %+v", report)
	}

	// The match finishes after the removal.
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})

	// The projection of the removed match was never published.
	var projections int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_public_projections WHERE match_id=$1`, matchID).Scan(&projections); err != nil {
		t.Fatal(err)
	}
	if projections != 0 {
		t.Fatalf("the removed match published %d projections", projections)
	}
	// The public projection of the removed match is not served.
	if _, err = fixture.service.GetPublicProjection(ctx, matchID); !errors.Is(err, online.ErrNotFound) {
		t.Fatalf("the public projection of the removed match is served: %v", err)
	}
	// The publisher refuses to publish the public replay of the removed match
	// either.
	if _, err = historyService.ProjectMatch(ctx, matchID); !errors.Is(err, history.ErrNotFound) {
		t.Fatalf("the publisher published the public replay of the removed match: %v", err)
	}
}

// TestPostgresTheDeletedMatchStillPublishesWhenItFinishes covers the ordinary
// account deletion of a participant while the match is still running.
//
// An ordinary deletion anonymizes the shared game and keeps it, so the match
// still publishes its projection when it finishes.
func TestPostgresTheDeletedMatchStillPublishesWhenItFinishes(t *testing.T) {
	fixture, removals, _ := privacyFixture(t)
	ctx := context.Background()
	matchID := "privacy-running-deletion-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})

	// The white seat asks for an ordinary account deletion while the match is
	// running.
	report, err := removals.DeleteAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin)
	if err != nil {
		t.Fatalf("delete the account: %v", err)
	}
	if report.Scope != privacy.ScopeAccountDeletion || report.AnonymizedMatches != 1 {
		t.Fatalf("the deletion report = %+v", report)
	}

	// The match finishes after the deletion.
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})

	// The projection of the shared game is published, with the deleted player
	// as "Deleted player".
	projection, err := fixture.service.GetPublicProjection(ctx, matchID)
	if err != nil {
		t.Fatalf("the public projection of the shared game is not served: %v", err)
	}
	found := false
	for _, participant := range projection.Participants {
		if participant.Seat != online.SeatWhite {
			continue
		}
		found = true
		if participant.PublicLabel != "Deleted player" {
			t.Fatalf("the public projection still names the deleted player: %+v", participant)
		}
	}
	if !found {
		t.Fatalf("the public projection has no white participant: %+v", projection)
	}
}

// TestPostgresTheRemovedSubjectKeepsNoAggregateOfItsOwn covers the aggregate
// result totals of a removed subject.
//
// The explicit removal erases the shared games of the subject from both
// histories. The subject keeps no aggregate of its own either, and only the
// anonymous aggregate of the opponent survives.
func TestPostgresTheRemovedSubjectKeepsNoAggregateOfItsOwn(t *testing.T) {
	fixture, removals, historyService := privacyFixture(t)
	ctx := context.Background()
	matchID := "privacy-removed-totals-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	removedProfile := privacyProfileID(t, fixture, "user_a")
	keptProfile := privacyProfileID(t, fixture, "user_b")

	// The subject has its own aggregate before the removal.
	before, err := historyService.ProfileHistory(ctx, removedProfile)
	if err != nil {
		t.Fatal(err)
	}
	if before.Totals.Wins != 1 {
		t.Fatalf("the aggregate of the subject before the removal = %+v", before.Totals)
	}

	if _, err = removals.RemoveAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("remove the account: %v", err)
	}

	// The subject keeps no aggregate of its own.
	var totals int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_profile_result_totals WHERE profile_id=$1`, removedProfile).Scan(&totals); err != nil {
		t.Fatal(err)
	}
	if totals != 0 {
		t.Fatal("the removed subject keeps its own aggregate")
	}
	after, err := historyService.ProfileHistory(ctx, removedProfile)
	if err != nil {
		t.Fatal(err)
	}
	if after.Totals.Wins != 0 || after.Totals.Losses != 0 || after.Totals.Draws != 0 {
		t.Fatalf("the aggregate of the removed subject = %+v", after.Totals)
	}
	// The opponent keeps the anonymous aggregate of the erased game.
	var opponentTotals int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_profile_result_totals WHERE profile_id=$1`, keptProfile).Scan(&opponentTotals); err != nil {
		t.Fatal(err)
	}
	if opponentTotals != 1 {
		t.Fatal("the opponent lost the anonymous aggregate of the erased game")
	}
	kept, err := historyService.ProfileHistory(ctx, keptProfile)
	if err != nil {
		t.Fatal(err)
	}
	if kept.Totals.Losses != 1 {
		t.Fatalf("the aggregate totals of the opponent = %+v", kept.Totals)
	}
}
