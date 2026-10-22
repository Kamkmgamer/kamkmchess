package integration

// The replay of a subject level removal.
//
// The live path gives the subject record an identifier of its own, so the
// identifier of the removal request cannot be derived from it. The replay
// uses the request the database holds for the subject and allocates a fresh
// identifier when the restored database has none. The regressions below cover
// the shape that proved the guess wrong and the shape the live path really
// produces.

import (
	"context"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
	"github.com/Kamkmgamer/kamkmchess/backend/profile"
)

// TestPostgresTheSubjectReplayNeverGuessesTheRequestIdentifier covers the
// replay of a subject level removal whose record identifier collides with the
// request identifier of another removal.
//
// The replay used to derive the identifier of the request from the identifier
// of the subject record, and the guess was wrong twice over: it was never the
// identifier the request has, and it could be the identifier of the request of
// another subject. The conflict on the primary key of the request table is not
// the conflict the insert absorbs, so the replay failed with a unique
// violation and the restore of the removal ledger never finished.
//
// The ledger is data that is collected from outside the database, so the
// replay may not assume a relation between the two identifiers that the data
// does not guarantee.
func TestPostgresTheSubjectReplayNeverGuessesTheRequestIdentifier(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	historyService := historyServiceFor(t, fixture)
	privacyCompletedMatch(t, fixture, historyService, "evidence-replay-match")
	// The subject of the match removal, and the subject of the subject level
	// removal, which played no match at all.
	matchSubject := privacy.SubjectReference("user_b")
	privateSubject := privacy.SubjectReference("user_c")
	// The public name of the subject of the subject level removal, so the
	// sanitation of the replay is observable.
	resolver, err := profileServiceFor(t, fixture)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = resolver.EnsureProfileForAccount(ctx, "user_c"); err != nil {
		t.Fatal(err)
	}
	name := "privateplayer"
	if _, err = resolver.UpdateProfile(ctx, accountPrincipal("user_c", "session-user_c"), profile.Update{Username: &name}, authTestOrigin); err != nil {
		t.Fatalf("update the profile: %v", err)
	}
	// The match bound removal of the opponent of the match.
	if _, err = fixture.pool.Exec(ctx, `
		INSERT INTO online_removal_requests(removal_id,subject_kind,subject_id,scope,status,requested_at,verified_at,live_delete_due_at,recovery_sanitize_due_at)
		VALUES('rm_replay_collision','account',$1,'explicit_removal','verified',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 day',clock_timestamp()+interval '30 days')`, matchSubject); err != nil {
		t.Fatal(err)
	}
	if _, err = fixture.pool.Exec(ctx, `
		INSERT INTO online_removal_ledger(ledger_id,removal_id,subject_kind,subject_id,match_id,scope,removed_at)
		VALUES('rl_replay_collision','rm_replay_collision','account',$1,'evidence-replay-match','explicit_removal',clock_timestamp())`, matchSubject); err != nil {
		t.Fatal(err)
	}
	// The subject level removal of the other subject, with a subject record
	// whose identifier suffix is the identifier of the request of the match
	// removal.
	if _, err = fixture.pool.Exec(ctx, `
		INSERT INTO online_removal_requests(removal_id,subject_kind,subject_id,scope,status,requested_at,verified_at,live_delete_due_at,recovery_sanitize_due_at)
		VALUES('rm_replay_private','account',$1,'explicit_removal','verified',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 day',clock_timestamp()+interval '30 days')`, privateSubject); err != nil {
		t.Fatal(err)
	}
	if _, err = fixture.pool.Exec(ctx, `
		INSERT INTO online_removal_subjects(subject_id,removal_id,subject_kind,subject_ref,scope,removed_at)
		VALUES('rs_replay_collision','rm_replay_private','account',$1,'explicit_removal',clock_timestamp())`, privateSubject); err != nil {
		t.Fatal(err)
	}
	matches, err := removals.ListRemovalRecords(ctx)
	if err != nil {
		t.Fatal(err)
	}
	subjects, err := removals.ListSubjectRemovalRecords(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 || len(subjects) != 1 {
		t.Fatalf("the live ledger holds %d match records and %d subject records", len(matches), len(subjects))
	}
	// The import of a bundle replaces the schema: the removal rows of the live
	// database are gone and the replay has to recreate them.
	if _, err = fixture.pool.Exec(ctx, `TRUNCATE online_removal_ledger,online_removal_subjects,online_removal_requests,online_account_deletions CASCADE`); err != nil {
		t.Fatal(err)
	}
	// The replay of the very same ledger succeeds: the identifier of the
	// request of the subject level removal is not the identifier of the
	// request of the match removal any more.
	if err = removals.ApplyRemovalRecords(ctx, matches); err != nil {
		t.Fatalf("the replay of the match records failed: %v", err)
	}
	if err = removals.ApplySubjectRemovalRecords(ctx, subjects); err != nil {
		t.Fatalf("the replay of the subject records failed: %v", err)
	}
	// The request of the match removal is the one the ledger named, and the
	// subject record names a request of its own subject: the request of
	// another subject is never attached to this one.
	var (
		matchRequest string
		matchOwner   string
		subjectRow   string
		subjectOwner string
	)
	if err = fixture.pool.QueryRow(ctx, `SELECT r.removal_id,r.subject_id FROM online_removal_requests r WHERE r.removal_id='rm_replay_collision'`).Scan(&matchRequest, &matchOwner); err != nil {
		t.Fatal(err)
	}
	if matchRequest != "rm_replay_collision" || matchOwner != matchSubject {
		t.Fatalf("the request of the match removal = %q for the subject %q", matchRequest, matchOwner)
	}
	if err = fixture.pool.QueryRow(ctx, `SELECT s.removal_id,r.subject_id FROM online_removal_subjects s JOIN online_removal_requests r ON r.removal_id=s.removal_id WHERE s.subject_id='rs_replay_collision'`).Scan(&subjectRow, &subjectOwner); err != nil {
		t.Fatal(err)
	}
	if subjectOwner != privateSubject {
		t.Fatalf("the subject record names the request %q of the subject %q", subjectRow, subjectOwner)
	}
	if subjectRow == "rm_replay_collision" {
		t.Fatal("the subject record names the request of the match removal")
	}
	// The sanitation of the subject level removal ran: the public name of the
	// removed subject is gone.
	var username string
	if err = fixture.pool.QueryRow(ctx, `SELECT coalesce(username,'') FROM online_public_profiles WHERE account_id='user_c'`).Scan(&username); err != nil {
		t.Fatal(err)
	}
	if username != "" {
		t.Fatalf("the public name of the removed subject is back: %q", username)
	}
	// The control: the very same ledger applied twice leaves the database in
	// the same state.
	before, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var requestsBefore int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_removal_requests`).Scan(&requestsBefore); err != nil {
		t.Fatal(err)
	}
	if err = removals.ApplyRemovalRecords(ctx, matches); err != nil {
		t.Fatalf("the second replay of the match records failed: %v", err)
	}
	if err = removals.ApplySubjectRemovalRecords(ctx, subjects); err != nil {
		t.Fatalf("the second replay of the subject records failed: %v", err)
	}
	after, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var requestsAfter int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_removal_requests`).Scan(&requestsAfter); err != nil {
		t.Fatal(err)
	}
	if requestsAfter != requestsBefore {
		t.Fatalf("the replay of the same ledger changed the request table from %d rows to %d rows", requestsBefore, requestsAfter)
	}
	if len(after.Matches) != len(before.Matches) || len(after.Subjects) != len(before.Subjects) {
		t.Fatalf("the replay of the same ledger changed the removal ledger: %d and %d rows, want %d and %d",
			len(after.Matches), len(after.Subjects), len(before.Matches), len(before.Subjects))
	}
}

// TestPostgresTheSubjectReplayOfAProductionRemovalIsIdempotent covers the
// records the live path really produces.
//
// The live path gives the subject record an identifier of its own and the
// request another one, so the identifier of the request is never the
// identifier the subject record carries. The replay of such a record leaves
// the database in the same state, however often it runs.
func TestPostgresTheSubjectReplayOfAProductionRemovalIsIdempotent(t *testing.T) {
	fixture, removals, _ := evidenceFixture(t)
	ctx := context.Background()
	// The account owns a public name and it never played an online match.
	resolver, err := profileServiceFor(t, fixture)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = resolver.EnsureProfileForAccount(ctx, "user_a"); err != nil {
		t.Fatal(err)
	}
	name := "namedplayer"
	if _, err = resolver.UpdateProfile(ctx, accountPrincipal("user_a", "session-user_a"), profile.Update{Username: &name}, authTestOrigin); err != nil {
		t.Fatalf("update the profile: %v", err)
	}
	if _, err = removals.RemoveAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("remove the account: %v", err)
	}
	subjects, err := removals.ListSubjectRemovalRecords(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(subjects) != 1 {
		t.Fatalf("the subject ledger holds %d records", len(subjects))
	}
	// The identifier of the request is the one the live path allocated, and it
	// is not the identifier of the subject record.
	var requestID string
	if err = fixture.pool.QueryRow(ctx, `SELECT removal_id FROM online_removal_subjects WHERE subject_id=$1`, subjects[0].RecordID).Scan(&requestID); err != nil {
		t.Fatal(err)
	}
	if requestID == subjects[0].RecordID {
		t.Fatal("the live path uses the same identifier for the request and for the subject record")
	}
	// The replay of the record, twice, leaves the database in the same state.
	for attempt := 0; attempt < 2; attempt++ {
		if err = removals.ApplySubjectRemovalRecords(ctx, subjects); err != nil {
			t.Fatalf("the replay of the production record failed (attempt %d): %v", attempt, err)
		}
	}
	var requests int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_removal_requests`).Scan(&requests); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("the request table holds %d rows after the replays, want 1", requests)
	}
	var replayed string
	if err = fixture.pool.QueryRow(ctx, `SELECT removal_id FROM online_removal_subjects WHERE subject_id=$1`, subjects[0].RecordID).Scan(&replayed); err != nil {
		t.Fatal(err)
	}
	if replayed != requestID {
		t.Fatalf("the replay changed the request of the subject to %q, want %q", replayed, requestID)
	}
	// The public name of the removed account is gone and its session is
	// fenced.
	var username string
	if err = fixture.pool.QueryRow(ctx, `SELECT coalesce(username,'') FROM online_public_profiles WHERE account_id='user_a'`).Scan(&username); err != nil {
		t.Fatal(err)
	}
	if username != "" {
		t.Fatalf("the public name of the removed account is back: %q", username)
	}
	var revoked int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_session_revocations WHERE subject_id='user_a'`).Scan(&revoked); err != nil {
		t.Fatal(err)
	}
	if revoked == 0 {
		t.Fatal("the removed account is not fenced")
	}
	var _ = time.Now
}
