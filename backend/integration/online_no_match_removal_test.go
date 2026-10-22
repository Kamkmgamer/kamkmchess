package integration

import (
	"context"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
	"github.com/Kamkmgamer/kamkmchess/backend/profile"
)

// TestPostgresTheRemovalOfAnAccountWithoutAMatchSurvivesARestore covers the
// subject that never played an online match.
//
// The subject level record is the only carrier of the removal, so the replay
// has to remove the public name, record the deletion and fence the sessions
// of an account that has no shared game.
func TestPostgresTheRemovalOfAnAccountWithoutAMatchSurvivesARestore(t *testing.T) {
	fixture, removals, _ := privacyFixture(t)
	ctx := context.Background()
	// The account has a public profile and a public name, and it never played
	// an online match.
	resolver, err := profileServiceFor(t, fixture)
	if err != nil {
		t.Fatal(err)
	}
	profileID, err := resolver.EnsureProfileForAccount(ctx, "user_a")
	if err != nil {
		t.Fatal(err)
	}
	name := "namedplayer"
	if _, err = resolver.UpdateProfile(ctx, accountPrincipal("user_a", "session-user_a"), profile.Update{Username: &name}, authTestOrigin); err != nil {
		t.Fatalf("update the profile: %v", err)
	}
	if _, err = removals.RemoveAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("remove the account: %v", err)
	}
	subjectRecords, err := removals.ListSubjectRemovalRecords(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(subjectRecords) != 1 {
		t.Fatalf("the subject removal ledger holds %d records", len(subjectRecords))
	}
	// The restored database is the older state: the public name is back and the
	// deletion record is gone.
	restored := testPool(t)
	if err = migrations.Apply(ctx, restored); err != nil {
		t.Fatal(err)
	}
	if _, err = restored.Exec(ctx, `INSERT INTO online_public_profiles(profile_id,account_id,username,username_key) VALUES($1,'user_a',$2,$2)`, profileID, name); err != nil {
		t.Fatal(err)
	}
	restoredRemovals, err := privacy.Open(ctx, restored, fixture.authorizer, privacy.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err = restoredRemovals.ApplySubjectRemovalRecords(ctx, subjectRecords); err != nil {
		t.Fatalf("apply the subject removal records: %v", err)
	}
	var username string
	if err = restored.QueryRow(ctx, `SELECT coalesce(username,'') FROM online_public_profiles WHERE profile_id=$1`, profileID).Scan(&username); err != nil {
		t.Fatal(err)
	}
	if username != "" {
		t.Fatalf("the restored public name of the removed account is back: %q", username)
	}
	var deletions int
	if err = restored.QueryRow(ctx, `SELECT count(*) FROM online_account_deletions`).Scan(&deletions); err != nil {
		t.Fatal(err)
	}
	if deletions != 1 {
		t.Fatalf("the restored database holds %d deletion records", deletions)
	}
	var revoked int
	if err = restored.QueryRow(ctx, `SELECT count(*) FROM online_session_revocations WHERE subject_id='user_a' AND session_id='*'`).Scan(&revoked); err != nil {
		t.Fatal(err)
	}
	if revoked == 0 {
		t.Fatal("the restored account is not fenced")
	}
}

// TestPostgresTheRecoveryOfACrashedRestoreIsIdentityBound covers the
// supported recovery of a restore that crashed after its removal ledger was
// applied.
//
// The recovery names the restore and the ledger it applied, refuses a wrong
// clear and refuses an overlapping owner.
func TestPostgresTheRecoveryOfACrashedRestoreIsIdentityBound(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	directory := t.TempDir() + "/restore"
	removals, err := privacy.Open(context.Background(), fixture.pool, fixture.authorizer, privacy.Options{FencePath: directory})
	if err != nil {
		t.Fatal(err)
	}
	// The restore crashed after it recorded its gate.
	// The applied removal ledger is the ledger of a real removal, so the
	// recovery can verify it.
	removals, err = privacy.Open(context.Background(), fixture.pool, fixture.authorizer, privacy.Options{FencePath: directory})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = removals.RemoveAccount(context.Background(), accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("remove the account: %v", err)
	}
	applied, err := removals.AppliedRemovalLedger(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	required := backup.AppliedRemovalLedger{Matches: applied.Matches, Subjects: applied.Subjects}

	crashed, err := removals.BeginFence("restore-crashed", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	// The restore bound the removal ledger it had to apply and then crashed:
	// the ownership is released, the marker survives.
	if err = crashed.Bind(required); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	crashed.Release()
	if _, err = removals.RecordRestore(context.Background(), "restore-crashed"); err != nil {
		t.Fatalf("record the restore: %v", err)
	}
	// The service is closed while the gate waits.
	allowed, err := removals.ServingAllowed(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("the service serves traffic while the gate of a crashed restore waits")
	}
	// A wrong clear is refused: the applied ledger does not hold the removals
	// of the restore.
	weaker := backup.AppliedRemovalLedger{Matches: required.Matches[:0]}
	if err = removals.RecoverRestore(context.Background(), "restore-crashed", weaker); err == nil {
		t.Fatal("the recovery accepted a restore without its removals")
	}
	// An unknown restore is refused.
	if err = removals.RecoverRestore(context.Background(), "restore-unknown", required); err == nil {
		t.Fatal("the recovery accepted an unknown restore")
	}
	// The recovery of the restore that applied the ledger releases the gate.
	if err = removals.RecoverRestore(context.Background(), "restore-crashed", required); err != nil {
		t.Fatalf("recover the restore: %v", err)
	}
	allowed, err = removals.ServingAllowed(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("the recovered database does not serve traffic")
	}
	// The fence of the crashed restore is closed, so a new restore can take
	// over.
	next, err := removals.BeginFence("restore-next", true)
	if err != nil {
		t.Fatalf("the fence of the crashed restore was not closed: %v", err)
	}
	defer next.Release()
}

// TestPostgresTheRemovalOfAnAcceptedRematchOfferKeepsTheShape covers the
// rematch offer of a removed participant in the **live** state.
//
// The `accepted` state is the state every current rematch acceptance writes:
// the offer names its accepter and the match the acceptance created. The shape
// of the offer requires that record to be there, so the raw identifier of the
// removed accepter is replaced by the reserved anonymized value instead of
// being cleared: clearing it would raise the check constraint of the offer
// and abort the whole removal, and the account could never be deleted.
func TestPostgresTheRemovalOfAnAcceptedRematchOfferKeepsTheShape(t *testing.T) {
	fixture, removals, historyService := privacyFixture(t)
	ctx := context.Background()
	matchID := "privacy-rematch-accepted-match"
	rematchMatchID := "privacy-rematch-accepted-new-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})
	// The acceptance of the rematch created the new match, and the offer names
	// its accepter and that match: the live state of an accepted offer.
	historyCreate(t, fixture, rematchMatchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_rematch_offers(rematch_id,match_id,proposer_kind,proposer_id,proposer_public_label,proposer_seat,starting_time_ms,increment_ms,status,version,accepted_by_kind,accepted_by_id,new_match_id,created_at,updated_at,expires_at)
		VALUES('rmt_accepted_offer_of_account_01',$1,'account','user_b','Bob','black',300000,0,'accepted',2,'account','user_a',$2,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour')`, matchID, rematchMatchID); err != nil {
		t.Fatalf("seed the accepted rematch offer: %v", err)
	}
	// The removal of the accepter succeeds: the offer keeps its shape, so the
	// check constraint of the offer is not violated and the removal is not
	// aborted.
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("remove the accepter of the accepted offer: %v", err)
	}
	var (
		status     string
		acceptedBy string
		newMatch   string
	)
	if err := fixture.pool.QueryRow(ctx, `SELECT status,coalesce(accepted_by_id,''),coalesce(new_match_id,'') FROM online_rematch_offers WHERE rematch_id='rmt_accepted_offer_of_account_01'`).Scan(&status, &acceptedBy, &newMatch); err != nil {
		t.Fatal(err)
	}
	if acceptedBy == "user_a" {
		t.Fatalf("the accepted rematch offer still names the removed account: %q", acceptedBy)
	}
	if status != "accepted" {
		t.Fatalf("the accepted rematch offer changed its state: %q", status)
	}
	if newMatch != rematchMatchID {
		t.Fatalf("the accepted rematch offer lost its match: %q", newMatch)
	}
	// The removal of the accepter is recorded, so the account is really gone.
	var removed int
	if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_removal_subjects WHERE subject_ref=$1`, privacy.SubjectReference("user_a")).Scan(&removed); err != nil {
		t.Fatal(err)
	}
	if removed == 0 {
		t.Fatal("the removal of the accepter of the accepted offer was not recorded")
	}
	_ = historyService
}

// TestPostgresTheRemovalOfAnAcceptingRematchOfferKeepsTheShape covers the
// rematch offer of a removed participant.
//
// The offer records the accepter while it is accepting or accepted, so the
// raw identifier is replaced by the reserved anonymized value instead of
// being cleared: clearing it would break the offer and abort the removal.
func TestPostgresTheRemovalOfAnAcceptingRematchOfferKeepsTheShape(t *testing.T) {
	fixture, removals, _ := privacyFixture(t)
	ctx := context.Background()
	matchID := "privacy-rematch-accepting-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})
	// The offer is accepting the acceptance of the removed account.
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_rematch_offers(rematch_id,match_id,proposer_kind,proposer_id,proposer_public_label,proposer_seat,starting_time_ms,increment_ms,status,version,accepted_by_kind,accepted_by_id,created_at,updated_at,expires_at)
		VALUES('rmt_accepting_offer_of_account_01',$1,'account','user_b','Bob','black',300000,0,'accepting',1,'account','user_a',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour')`, matchID); err != nil {
		t.Fatalf("seed the accepting rematch offer: %v", err)
	}
	// The removal of the account succeeds.
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("remove the account: %v", err)
	}
	var status, acceptedBy string
	if err := fixture.pool.QueryRow(ctx, `SELECT status,coalesce(accepted_by_id,'') FROM online_rematch_offers WHERE rematch_id='rmt_accepting_offer_of_account_01'`).Scan(&status, &acceptedBy); err != nil {
		t.Fatal(err)
	}
	if acceptedBy == "user_a" {
		t.Fatalf("the rematch offer still names the removed account: %q", acceptedBy)
	}
	if status != "accepting" {
		t.Fatalf("the rematch offer changed its state: %q", status)
	}
}
