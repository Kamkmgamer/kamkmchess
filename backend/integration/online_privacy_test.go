package integration

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/history"
	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
)

// privacyFixture wires the real removal service to the real writer, the real
// authorization service, the real history publisher and the real database.
func privacyFixture(t *testing.T) (*onlineAuthFixture, *privacy.Service, *history.Service) {
	t.Helper()
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	removals, err := privacy.Open(context.Background(), fixture.pool, fixture.authorizer, privacy.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return fixture, removals, historyServiceFor(t, fixture)
}

// privacyCompletedMatch plays one completed online game between two accounts
// and publishes it.
func privacyCompletedMatch(t *testing.T, fixture *onlineAuthFixture, historyService *history.Service, matchID string) {
	t.Helper()
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-"+matchID, white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-"+matchID, black, 2, 1, online.Action{Kind: online.ActionResign})
	if _, err := historyService.ProjectMatch(context.Background(), matchID); err != nil {
		t.Fatalf("project %s: %v", matchID, err)
	}
}

// privacyProfileID returns the public profile of an account.
func privacyProfileID(t *testing.T, fixture *onlineAuthFixture, account string) string {
	t.Helper()
	var profileID string
	if err := fixture.pool.QueryRow(context.Background(), `SELECT profile_id FROM online_public_profiles WHERE account_id=$1`, account).Scan(&profileID); err != nil {
		t.Fatal(err)
	}
	return profileID
}

// TestPostgresAccountDeletionAnonymizesTheSharedGameInBothHistories covers the
// ordinary account deletion.
func TestPostgresAccountDeletionAnonymizesTheSharedGameInBothHistories(t *testing.T) {
	fixture, removals, historyService := privacyFixture(t)
	matchID := "privacy-deletion-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	deletedProfile := privacyProfileID(t, fixture, "user_a")
	keptProfile := privacyProfileID(t, fixture, "user_b")

	before, err := historyService.ProfileHistory(context.Background(), keptProfile)
	if err != nil {
		t.Fatal(err)
	}
	if len(before.Games) != 1 || before.Games[0].OpponentLabel != "Alice" {
		t.Fatalf("the opponent history before the deletion = %+v", before.Games)
	}

	report, err := removals.DeleteAccount(context.Background(), accountPrincipal("user_a", "session-user_a"), authTestOrigin)
	if err != nil {
		t.Fatalf("delete account: %v", err)
	}
	if report.Scope != privacy.ScopeAccountDeletion || report.AnonymizedMatches != 1 || report.RemovedMatches != 0 {
		t.Fatalf("the deletion report = %+v", report)
	}
	if report.LiveDeletedAt.IsZero() || report.LiveDeleteDueAt.IsZero() || report.RecoverySanitizeDueAt.IsZero() {
		t.Fatalf("the deletion report has no retention schedule: %+v", report)
	}

	// The seat of the deleted participant keeps the game and loses the
	// identity.
	var ownerID, publicLabel string
	if err = fixture.pool.QueryRow(context.Background(), `SELECT owner_id,public_label FROM online_seats WHERE match_id=$1 AND seat='white'`, matchID).Scan(&ownerID, &publicLabel); err != nil {
		t.Fatal(err)
	}
	if ownerID != "anonymized" || publicLabel != "Deleted player" {
		t.Fatalf("the seat after the deletion = %q / %q", ownerID, publicLabel)
	}
	// The opponent's history entry loses the deleted name.
	after, err := historyService.ProfileHistory(context.Background(), keptProfile)
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Games) != 1 || after.Games[0].OpponentLabel != "Deleted player" {
		t.Fatalf("the opponent history after the deletion = %+v", after.Games)
	}
	// The aggregate result of the shared game is kept.
	if after.Totals.Wins != before.Totals.Wins || after.Totals.Losses != before.Totals.Losses {
		t.Fatalf("the aggregate totals changed: %+v -> %+v", before.Totals, after.Totals)
	}
	// The public replay keeps the shared game and names the deleted player as
	// "Deleted player".
	replay, err := historyService.PublicReplay(context.Background(), matchID)
	if err != nil {
		t.Fatalf("public replay: %v", err)
	}
	found := false
	for _, participant := range replay.Participants {
		if participant.Seat == online.SeatWhite {
			found = true
			if participant.PublicLabel != "Deleted player" {
				t.Fatalf("the public replay still names the deleted player: %+v", participant)
			}
		}
	}
	if !found {
		t.Fatalf("the public replay has no white participant: %+v", replay.Participants)
	}
	// The deleted account keeps no public identity and no public history.
	var username, avatarKey string
	if err = fixture.pool.QueryRow(context.Background(), `SELECT coalesce(username,''),avatar_key FROM online_public_profiles WHERE profile_id=$1`, deletedProfile).Scan(&username, &avatarKey); err != nil {
		t.Fatal(err)
	}
	if username != "" || avatarKey != "" {
		t.Fatalf("the deleted account keeps a public identity: %q / %q", username, avatarKey)
	}
	var deletedGames int
	if err = fixture.pool.QueryRow(context.Background(), `SELECT count(*) FROM online_profile_results WHERE profile_id=$1`, deletedProfile).Scan(&deletedGames); err != nil {
		t.Fatal(err)
	}
	if deletedGames != 0 {
		t.Fatalf("the deleted account keeps %d public history rows", deletedGames)
	}
	// The account is fenced: its sessions are revoked.
	var revoked int
	if err = fixture.pool.QueryRow(context.Background(), `SELECT count(*) FROM online_session_revocations WHERE subject_id='user_a'`).Scan(&revoked); err != nil {
		t.Fatal(err)
	}
	if revoked == 0 {
		t.Fatal("the deleted account was not fenced")
	}
	// The deletion marker carries the one-way reference of the subject, not
	// the subject identifier.
	var markerSubject string
	if err = fixture.pool.QueryRow(context.Background(), `SELECT subject_id FROM online_deletion_markers WHERE match_id=$1 AND marker_kind='account_anonymization'`, matchID).Scan(&markerSubject); err != nil {
		t.Fatal(err)
	}
	if markerSubject == "user_a" {
		t.Fatalf("the deletion marker retains the subject identifier: %q", markerSubject)
	}
	if markerSubject != privacy.SubjectReference("user_a") {
		t.Fatalf("the deletion marker subject = %q", markerSubject)
	}
}

// TestPostgresExplicitRemovalErasesTheReplayFromBothHistories covers the
// explicit removal.
func TestPostgresExplicitRemovalErasesTheReplayFromBothHistories(t *testing.T) {
	fixture, removals, historyService := privacyFixture(t)
	matchID := "privacy-removal-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	removedProfile := privacyProfileID(t, fixture, "user_a")
	keptProfile := privacyProfileID(t, fixture, "user_b")

	report, err := removals.RemoveAccount(context.Background(), accountPrincipal("user_a", "session-user_a"), authTestOrigin)
	if err != nil {
		t.Fatalf("remove account: %v", err)
	}
	if report.Scope != privacy.ScopeExplicitRemoval || report.RemovedMatches != 1 {
		t.Fatalf("the removal report = %+v", report)
	}

	// The public replay is gone.
	if _, err = historyService.PublicReplay(context.Background(), matchID); err == nil {
		t.Fatal("the erased replay is still public")
	}
	// The older projection of the match writer is gone too.
	var revokedAt *string
	if err = fixture.pool.QueryRow(context.Background(), `SELECT revoked_at::text FROM online_public_projections WHERE match_id=$1`, matchID).Scan(&revokedAt); err != nil {
		t.Fatal(err)
	}
	if revokedAt == nil {
		t.Fatal("the older projection is still public")
	}
	// The shared game left both histories.
	for _, profileID := range []string{removedProfile, keptProfile} {
		record, err := historyService.ProfileHistory(context.Background(), profileID)
		if err != nil {
			t.Fatal(err)
		}
		for _, game := range record.Games {
			if game.MatchID == matchID {
				t.Fatalf("the erased game is still in the history of %s", profileID)
			}
		}
	}
	// The opponent keeps the anonymous result aggregate.
	kept, err := historyService.ProfileHistory(context.Background(), keptProfile)
	if err != nil {
		t.Fatal(err)
	}
	if kept.Totals.Wins != 0 || kept.Totals.Losses != 1 {
		t.Fatalf("the aggregate totals of the opponent = %+v", kept.Totals)
	}
	// The removal is recorded in the durable ledger.
	records, err := removals.ListRemovalRecords(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, record := range records {
		if record.MatchID == matchID {
			found = true
			if record.Scope != privacy.ScopeExplicitRemoval {
				t.Fatalf("the ledger record = %+v", record)
			}
			// The ledger names the subject by its one-way reference, so the
			// identifier of the removed account is never retained.
			if record.SubjectID == "user_a" {
				t.Fatalf("the ledger record keeps the raw subject identifier: %+v", record)
			}
			if record.SubjectID != privacy.SubjectReference("user_a") {
				t.Fatalf("the ledger record subject = %q", record.SubjectID)
			}
		}
	}
	if !found {
		t.Fatalf("the removal is not in the ledger: %+v", records)
	}
	// A repeated request does not remove anything twice. The removed account
	// is fenced, so the retry is refused, and the ledger and the aggregate
	// totals are unchanged.
	again, err := removals.RemoveAccount(context.Background(), accountPrincipal("user_a", "session-user_a"), authTestOrigin)
	if err == nil {
		t.Fatalf("the repeated request of a removed account was accepted: %+v", again)
	}
	if !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("the repeated request error = %v", err)
	}
	after, err := removals.ListRemovalRecords(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(records) {
		t.Fatalf("the repeated request changed the ledger: %d and %d", len(records), len(after))
	}
	kept, err = historyService.ProfileHistory(context.Background(), keptProfile)
	if err != nil {
		t.Fatal(err)
	}
	if kept.Totals.Losses != 1 {
		t.Fatalf("the repeated request changed the aggregate totals: %+v", kept.Totals)
	}
	var requests int
	if err = fixture.pool.QueryRow(context.Background(), `SELECT count(*) FROM online_removal_requests WHERE subject_kind='account' AND subject_id=$1 AND scope=$2`, privacy.SubjectReference("user_a"), privacy.ScopeExplicitRemoval).Scan(&requests); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("the subject has %d removal requests", requests)
	}
}

// TestPostgresGuestRemovalUsesTheRetainedSeatCredential covers the guest path.
func TestPostgresGuestRemovalUsesTheRetainedSeatCredential(t *testing.T) {
	fixture, removals, historyService := privacyFixture(t)
	matchID := "privacy-guest-match"
	issued := createGuestMatch(t, fixture, matchID)
	// The guest seat is white; the account seat resigns, so the match ends.
	aliceCtx := accountContext("user_a", "session-alice")
	resign := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     "op-privacy-guest-resign",
		ExpectedVersion: 1,
		Seat:            online.SeatBlack,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionResign},
	}
	if _, err := fixture.service.Execute(aliceCtx, online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_a"}, resign); err != nil {
		t.Fatalf("resign: %v", err)
	}
	if _, err := historyService.ProjectMatch(context.Background(), matchID); err != nil {
		t.Fatalf("project: %v", err)
	}
	guestPrincipal, err := fixture.authorizer.AuthenticateGuest(context.Background(), issued.Credential.Secret, authTestOrigin)
	if err != nil {
		t.Fatal(err)
	}
	report, err := removals.RemoveGuest(context.Background(), guestPrincipal, authTestOrigin)
	if err != nil {
		t.Fatalf("remove guest: %v", err)
	}
	if report.RemovedMatches != 1 {
		t.Fatalf("the guest removal report = %+v", report)
	}
	if _, err = historyService.PublicReplay(context.Background(), matchID); err == nil {
		t.Fatal("the erased replay of the guest match is still public")
	}
	// The seat credential of the removed guest is revoked.
	var live int
	if err = fixture.pool.QueryRow(context.Background(), `SELECT count(*) FROM online_guest_seat_credentials WHERE guest_id=$1 AND revoked_at IS NULL`, authGuestID).Scan(&live); err != nil {
		t.Fatal(err)
	}
	if live != 0 {
		t.Fatalf("the removed guest keeps %d live seat credentials", live)
	}
	// A retry with the revoked credential cannot authenticate, and the ledger
	// still holds exactly one record for the match.
	if _, err = fixture.authorizer.AuthenticateGuest(context.Background(), issued.Credential.Secret, authTestOrigin); err == nil {
		t.Fatal("the revoked seat credential still authenticates")
	}
	records, err := removals.ListRemovalRecords(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, record := range records {
		if record.MatchID == matchID {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("the guest removal ledger holds %d records for the match", count)
	}
}

// TestPostgresRemovalLedgerReplaysAfterAnOlderRestore covers the restore
// safety of the ledger.
//
// The restored database is a second isolated schema that holds the state
// before the removal. The removal ledger of the live database is replayed
// there, and the erased game must not come back.
func TestPostgresRemovalLedgerReplaysAfterAnOlderRestore(t *testing.T) {
	fixture, removals, historyService := privacyFixture(t)
	matchID := "privacy-restore-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	if _, err := removals.RemoveAccount(context.Background(), accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("remove account: %v", err)
	}
	records, err := removals.ListRemovalRecords(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(records) == 0 {
		t.Fatal("the removal ledger is empty")
	}

	// The restored database: the state before the removal.
	restored := testPool(t)
	if err = migrations.Apply(context.Background(), restored); err != nil {
		t.Fatalf("apply migrations to the restored database: %v", err)
	}
	if _, err = restored.Exec(context.Background(), `
		INSERT INTO online_matches(match_id,schema_version,variant,starting_fen,position_fen,starting_time_ms,increment_ms,version,control_epoch,input_hash,rules_policy_version,status,result,result_version,completed_at)
		VALUES($1,2,'orthodox','rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1','rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',300000,2000,2,1,sha256('restored'),'online-rules/1','completed','{"kind":"win","winner":"white","reason":"resignation"}',2,clock_timestamp())`, matchID); err != nil {
		t.Fatalf("restore the match: %v", err)
	}
	if _, err = restored.Exec(context.Background(), `
		INSERT INTO online_seats(match_id,seat,owner_kind,owner_id,public_label,control_kind,control_epoch)
		VALUES($1,'white','account','user_a','Alice','human',1),($1,'black','account','user_b','Bob','human',1)`, matchID); err != nil {
		t.Fatalf("restore the seats: %v", err)
	}
	if _, err = restored.Exec(context.Background(), `
		INSERT INTO online_public_profiles(profile_id,account_id) VALUES('kp_restored_b','user_b')`); err != nil {
		t.Fatalf("restore the profile: %v", err)
	}
	if _, err = restored.Exec(context.Background(), `
		INSERT INTO online_public_replays(match_id,schema_version,replay_json,result_hash,game_kind,scored)
		VALUES($1,2,'{"schemaVersion":2,"matchId":"privacy-restore-match"}',sha256('restored'),'friend',true)`, matchID); err != nil {
		t.Fatalf("restore the replay: %v", err)
	}
	if _, err = restored.Exec(context.Background(), `
		INSERT INTO online_profile_results(profile_id,match_id,seat,outcome,scored,game_kind,opponent_label,completed_at)
		VALUES('kp_restored_b',$1,'black','loss',true,'friend','Alice',clock_timestamp())`, matchID); err != nil {
		t.Fatalf("restore the history row: %v", err)
	}

	// The removal ledger is replayed on the restored database.
	restoredRemovals, err := privacy.Open(context.Background(), restored, fixture.authorizer, privacy.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err = restoredRemovals.ApplyRemovalRecords(context.Background(), records); err != nil {
		t.Fatalf("apply removal records: %v", err)
	}
	var revoked int
	if err = restored.QueryRow(context.Background(), `SELECT count(*) FROM online_public_replays WHERE match_id=$1 AND revoked_at IS NOT NULL`, matchID).Scan(&revoked); err != nil {
		t.Fatal(err)
	}
	if revoked != 1 {
		t.Fatal("the replay of the restored database is public again")
	}
	var rows int
	if err = restored.QueryRow(context.Background(), `SELECT count(*) FROM online_profile_results WHERE match_id=$1`, matchID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("the restored history row survived the ledger replay: %d rows", rows)
	}
	var ownerID string
	if err = restored.QueryRow(context.Background(), `SELECT owner_id FROM online_seats WHERE match_id=$1 AND seat='white'`, matchID).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	if ownerID != "anonymized" {
		t.Fatalf("the restored seat still names the removed subject: %q", ownerID)
	}
	// The replay is idempotent.
	if err = restoredRemovals.ApplyRemovalRecords(context.Background(), records); err != nil {
		t.Fatalf("repeat apply removal records: %v", err)
	}
}

// TestPostgresPrivacyRoutesSeparateDeletionFromRemoval covers the two
// separate flows of the HTTP surface.
func TestPostgresPrivacyRoutesSeparateDeletionFromRemoval(t *testing.T) {
	fixture, removals, historyService := privacyFixture(t)
	handler := httpapi.CORSWithMethods([]string{authTestOrigin}, httpapi.PrivacyRequestHeaders, "GET, POST, OPTIONS",
		httpapi.NewPrivacy(removals, historyService, fixture.authorizer, httpapi.OnlineOptions{AllowedOrigins: []string{authTestOrigin}}))
	token := profileToken(t, fixture, "user_a", "session-user_a")
	headers := map[string]string{"Authorization": "Bearer " + token}

	// A removal without the confirmation is refused.
	unconfirmed := onlineHTTPRequest(handler, http.MethodPost, "/v1/privacy/account/removal", authTestOrigin, "", headers, `{"confirm":"something-else"}`)
	if unconfirmed.Code != http.StatusBadRequest {
		t.Fatalf("the unconfirmed removal status=%d body=%s", unconfirmed.Code, unconfirmed.Body.String())
	}
	// An anonymous removal is refused.
	anonymous := onlineHTTPRequest(handler, http.MethodPost, "/v1/privacy/account/deletion", authTestOrigin, "", nil, `{"confirm":"delete-account"}`)
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("the anonymous removal status=%d body=%s", anonymous.Code, anonymous.Body.String())
	}
	// A public label that looks like a credential is refused.
	label := onlineHTTPRequest(handler, http.MethodPost, "/v1/privacy/account/model-labels", authTestOrigin, "", headers, `{"publicLabel":"sk-live-9f8a7b6c5d4e3f2a1b0c"}`)
	if label.Code != http.StatusBadRequest {
		t.Fatalf("the secret label status=%d body=%s", label.Code, label.Body.String())
	}
	// A public label of the owner is registered.
	accepted := onlineHTTPRequest(handler, http.MethodPost, "/v1/privacy/account/model-labels", authTestOrigin, "", headers, `{"publicLabel":"My chess model"}`)
	if accepted.Code != http.StatusOK {
		t.Fatalf("the public label status=%d body=%s", accepted.Code, accepted.Body.String())
	}
	labelPayload := decodeProfile(t, accepted.Body.Bytes())
	if labelPayload["publicLabel"] != "My chess model" {
		t.Fatalf("the public label answer = %v", labelPayload)
	}
	// The ordinary deletion is applied.
	deleted := onlineHTTPRequest(handler, http.MethodPost, "/v1/privacy/account/deletion", authTestOrigin, "", headers, `{"confirm":"delete-account"}`)
	if deleted.Code != http.StatusOK {
		t.Fatalf("the deletion status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	payload := decodeProfile(t, deleted.Body.Bytes())
	if payload["scope"] != privacy.ScopeAccountDeletion {
		t.Fatalf("the deletion answer = %v", payload)
	}
	// The deleted account is fenced: its session no longer authorizes anything.
	fenced := onlineHTTPRequest(handler, http.MethodPost, "/v1/privacy/account/model-labels", authTestOrigin, "", headers, `{"publicLabel":"Another model"}`)
	if fenced.Code != http.StatusUnauthorized {
		t.Fatalf("the fenced account status=%d body=%s", fenced.Code, fenced.Body.String())
	}
	// The explicit removal of a guest without a credential is refused.
	guestRemoval := onlineHTTPRequest(handler, http.MethodPost, "/v1/privacy/guest/removal", authTestOrigin, "", nil, `{"confirm":"erase-shared-replays"}`)
	if guestRemoval.Code != http.StatusUnauthorized {
		t.Fatalf("the anonymous guest removal status=%d body=%s", guestRemoval.Code, guestRemoval.Body.String())
	}
}

// TestPostgresPublicReadsAreRefusedWhileTheRestoreGateIsClosed covers the
// serving gate of a restored database.
//
// A restore that has not replayed the removal ledger keeps the service
// closed: the public replay and the public history answer with a retryable
// failure instead of serving a game that was removed.
func TestPostgresPublicReadsAreRefusedWhileTheRestoreGateIsClosed(t *testing.T) {
	fixture, removals, historyService := privacyFixture(t)
	matchID := "privacy-gate-match"
	privacyCompletedMatch(t, fixture, historyService, matchID)
	profileID := privacyProfileID(t, fixture, "user_b")
	historyService2 := historyService
	_ = historyService2

	// The composition serves the public routes behind the serving gate.
	handler := httpapi.WithServingGate(removals, httpapi.NewPublicHistory(historyService))
	// Before the restore the public reads work.
	read := onlineHTTPRequest(handler, http.MethodGet, "/v1/public/profiles/"+profileID+"/history", authTestOrigin, "", nil, "")
	if read.Code != http.StatusOK {
		t.Fatalf("the public history status=%d body=%s", read.Code, read.Body.String())
	}
	// A restore that has not replayed the removal ledger closes the service.
	if _, err := removals.RecordRestore(context.Background(), "restore-gate-test"); err != nil {
		t.Fatalf("record restore: %v", err)
	}
	allowed, err := removals.ServingAllowed(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("a restored database serves traffic before the removal ledger is replayed")
	}
	closed := onlineHTTPRequest(handler, http.MethodGet, "/v1/public/profiles/"+profileID+"/history", authTestOrigin, "", nil, "")
	if closed.Code != http.StatusServiceUnavailable {
		t.Fatalf("the closed public history status=%d body=%s", closed.Code, closed.Body.String())
	}
	replay := onlineHTTPRequest(handler, http.MethodGet, "/v1/public/matches/"+matchID+"/replay", authTestOrigin, "", nil, "")
	if replay.Code != http.StatusServiceUnavailable {
		t.Fatalf("the closed public replay status=%d body=%s", replay.Code, replay.Body.String())
	}
	// The gate is released only after the removal ledger was replayed.
	if err = removals.ReleaseRestoreGate(context.Background(), "restore-gate-test"); err != nil {
		t.Fatalf("release restore gate: %v", err)
	}
	allowed, err = removals.ServingAllowed(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("a released restore does not serve traffic")
	}
	open := onlineHTTPRequest(handler, http.MethodGet, "/v1/public/profiles/"+profileID+"/history", authTestOrigin, "", nil, "")
	if open.Code != http.StatusOK {
		t.Fatalf("the public history after the release status=%d body=%s", open.Code, open.Body.String())
	}
}

// TestPostgresServingIsBlockedUntilTheRemovalLedgerIsReplayed covers the
// restore gate.
func TestPostgresServingIsBlockedUntilTheRemovalLedgerIsReplayed(t *testing.T) {
	_, removals, _ := privacyFixture(t)
	allowed, err := removals.ServingAllowed(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("a fresh database must serve traffic")
	}
	if _, err = removals.RecordRestore(context.Background(), "restore-one"); err != nil {
		t.Fatalf("record restore: %v", err)
	}
	allowed, err = removals.ServingAllowed(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("a restored database must not serve traffic before the ledger is replayed")
	}
	if err = removals.ReleaseRestoreGate(context.Background(), "restore-one"); err != nil {
		t.Fatalf("release restore gate: %v", err)
	}
	allowed, err = removals.ServingAllowed(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("a released restore must serve traffic")
	}
}

// The removal service keeps the account and the guest apart.
var _ = onlineauth.Principal{}
