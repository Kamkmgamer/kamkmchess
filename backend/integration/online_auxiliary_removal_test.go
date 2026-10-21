package integration

import (
	"context"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
)

// seedAuxiliaryRows inserts the friend and queue records of one account.
//
// The records are the ones a removed subject must not stay identifiable in: an
// unused invitation, an invitation that already produced a match, its
// acceptance, a rematch offer, a waiting queue entry and an assigned queue
// entry with its allocation.
func seedAuxiliaryRows(t *testing.T, fixture *onlineAuthFixture, account, opponent, matchID string) {
	t.Helper()
	ctx := context.Background()
	// The unused link invitation of the account.
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_friend_invitations(invitation_id,kind,status,version,inviter_kind,inviter_id,inviter_public_label,inviter_control_kind,inviter_seat,starting_time_ms,increment_ms,recipient_account_id,created_at,expires_at)
		VALUES('inv_unused_invitation_of_the_account_000001','link','open',1,'account',$1,'Alice','human','white',300000,0,NULL,clock_timestamp(),clock_timestamp()+interval '1 hour')`, account); err != nil {
		t.Fatalf("seed the unused invitation: %v", err)
	}
	// The challenge that was addressed to the account.
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_friend_invitations(invitation_id,kind,status,version,inviter_kind,inviter_id,inviter_public_label,inviter_control_kind,inviter_seat,starting_time_ms,increment_ms,recipient_account_id,created_at,expires_at)
		VALUES('inv_challenge_to_the_account_0000001','challenge','open',1,'account',$1,'Bob','human','black',300000,0,$2,clock_timestamp(),clock_timestamp()+interval '1 hour')`, opponent, account); err != nil {
		t.Fatalf("seed the challenge: %v", err)
	}
	// The consumed invitation of the account, with its match and its
	// acceptance.
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_friend_invitations(invitation_id,kind,status,version,inviter_kind,inviter_id,inviter_public_label,inviter_control_kind,inviter_seat,starting_time_ms,increment_ms,created_at,expires_at,consumed_at,match_id,acceptance_id)
		VALUES('inv_consumed_invitation_of_the_acc_000001','link','consumed',2,'account',$1,'Alice','human','white',300000,0,clock_timestamp(),clock_timestamp()+interval '1 hour',clock_timestamp(),$2,'acc_consumed_acceptance_00000001')`, account, matchID); err != nil {
		t.Fatalf("seed the consumed invitation: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_invitation_acceptances(acceptance_id,invitation_id,acceptance_key_hash,acceptor_kind,acceptor_id,acceptor_public_label,seat,control_kind,status,created_at,updated_at,match_id)
		VALUES('acc_consumed_acceptance_00000001','inv_consumed_invitation_of_the_acc_000001',sha256('key'::bytea),'account',$1,'Alice','black','human','matched',clock_timestamp(),clock_timestamp(),$2)`, account, matchID); err != nil {
		t.Fatalf("seed the acceptance: %v", err)
	}
	// The rematch offer of the account.
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_rematch_offers(rematch_id,match_id,proposer_kind,proposer_id,proposer_public_label,proposer_seat,starting_time_ms,increment_ms,status,version,created_at,updated_at,expires_at)
		VALUES('rmt_rematch_of_the_account_000001',$1,'account',$2,'Alice','white',300000,0,'pending',1,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour')`, matchID, account); err != nil {
		t.Fatalf("seed the rematch offer: %v", err)
	}
	// The waiting queue entry of the account and of the opponent.
	for _, entry := range []struct{ id, owner string }{{"queue_waiting_entry_of_account_001", account}, {"queue_waiting_entry_of_opponent_01", opponent}} {
		if _, err := fixture.pool.Exec(ctx, `
			INSERT INTO online_queue_entries(entry_id,owner_kind,owner_id,seat_control_kind,starting_time_ms,increment_ms,status,version,internal_state,created_at,updated_at,client_request_id,creation_hash)
			VALUES($1,'account',$2,'human',300000,0,'waiting',1,'waiting',clock_timestamp(),clock_timestamp(),$3,sha256(convert_to($3,'UTF8')))`, entry.id, entry.owner, entry.id); err != nil {
			t.Fatalf("seed the waiting queue entry: %v", err)
		}
	}
	// The assigned queue entry of the account, with its committed allocation.
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_queue_entries(entry_id,owner_kind,owner_id,seat_control_kind,starting_time_ms,increment_ms,status,version,internal_state,created_at,updated_at,client_request_id,creation_hash,assigned_match_id,ready_at)
		VALUES('queue_assigned_entry_of_account_01','account',$1,'human',300000,0,'assigned',2,'assigned',clock_timestamp(),clock_timestamp(),'queue_assigned_entry_of_account_01',sha256('queue_assigned_entry_of_account_01'::bytea),$2,clock_timestamp())`, account, matchID); err != nil {
		t.Fatalf("seed the assigned queue entry: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_queue_allocations(allocation_id,kind,initiator_entry_id,initiator_seat,opponent_entry_id,opponent_seat,operation_id,match_id,status,initiator_label,initiator_control_kind,opponent_label,opponent_control_kind,created_at,committed_at)
		VALUES('allocation_of_the_account_00001','candidate','queue_assigned_entry_of_account_01','white','queue_waiting_entry_of_opponent_01','black','op_allocation_of_the_account_00001',$1,'committed','Alice','human','Bob','human',clock_timestamp(),clock_timestamp())`, matchID); err != nil {
		t.Fatalf("seed the allocation: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_queue_allocation_entries(allocation_id,entry_id,role) VALUES
		('allocation_of_the_account_00001','queue_assigned_entry_of_account_01','initiator'),
		('allocation_of_the_account_00001','queue_waiting_entry_of_opponent_01','opponent')`); err != nil {
		t.Fatalf("seed the allocation entries: %v", err)
	}
}

// TestPostgresAccountDeletionSanitizesTheFriendAndQueueRecords covers the
// auxiliary personal data of a removed account.
//
// The unused invitation is gone, so its preview cannot name the removed owner.
// The records that belong to a match keep their row and lose the identity of
// the removed participant. The records of the other participant are untouched.
func TestPostgresAccountDeletionSanitizesTheFriendAndQueueRecords(t *testing.T) {
	fixture, removals, _ := privacyFixture(t)
	ctx := context.Background()
	matchID := "privacy-auxiliary-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})
	seedAuxiliaryRows(t, fixture, "user_a", "user_b", matchID)

	if _, err := removals.DeleteAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("delete account: %v", err)
	}
	// The unused invitation of the removed account is gone, so its preview
	// cannot identify the owner.
	var unused int
	if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_friend_invitations WHERE invitation_id='inv_unused_invitation_of_the_account_000001'`).Scan(&unused); err != nil {
		t.Fatal(err)
	}
	if unused != 0 {
		t.Fatal("the unused invitation of the removed account survived")
	}
	// The consumed invitation keeps its row and loses the identity of the
	// inviter.
	var inviterID, inviterLabel string
	if err := fixture.pool.QueryRow(ctx, `SELECT inviter_id,inviter_public_label FROM online_friend_invitations WHERE invitation_id='inv_consumed_invitation_of_the_acc_000001'`).Scan(&inviterID, &inviterLabel); err != nil {
		t.Fatal(err)
	}
	if inviterID != "anonymized" || inviterLabel != "Deleted player" {
		t.Fatalf("the consumed invitation still names the removed owner: %q / %q", inviterID, inviterLabel)
	}
	// The acceptance loses the identity of the acceptor.
	var acceptorID, acceptorLabel string
	if err := fixture.pool.QueryRow(ctx, `SELECT acceptor_id,acceptor_public_label FROM online_invitation_acceptances WHERE acceptance_id='acc_consumed_acceptance_00000001'`).Scan(&acceptorID, &acceptorLabel); err != nil {
		t.Fatal(err)
	}
	if acceptorID != "anonymized" || acceptorLabel != "Deleted player" {
		t.Fatalf("the acceptance still names the removed owner: %q / %q", acceptorID, acceptorLabel)
	}
	// The rematch offer loses the identity of the proposer.
	var proposerID, proposerLabel string
	if err := fixture.pool.QueryRow(ctx, `SELECT proposer_id,proposer_public_label FROM online_rematch_offers WHERE rematch_id='rmt_rematch_of_the_account_000001'`).Scan(&proposerID, &proposerLabel); err != nil {
		t.Fatal(err)
	}
	if proposerID != "anonymized" || proposerLabel != "Deleted player" {
		t.Fatalf("the rematch offer still names the removed owner: %q / %q", proposerID, proposerLabel)
	}
	// The challenge addressed to the removed account loses its recipient.
	var recipients int
	if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_friend_invitations WHERE recipient_account_id='user_a'`).Scan(&recipients); err != nil {
		t.Fatal(err)
	}
	if recipients != 0 {
		t.Fatal("the challenge still names the removed account")
	}
	// The waiting queue entry of the removed account is gone, and the entry of
	// the other participant is untouched.
	var waiting int
	if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_queue_entries WHERE entry_id='queue_waiting_entry_of_account_001'`).Scan(&waiting); err != nil {
		t.Fatal(err)
	}
	if waiting != 0 {
		t.Fatal("the waiting queue entry of the removed account survived")
	}
	var kept int
	if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_queue_entries WHERE entry_id='queue_waiting_entry_of_opponent_01' AND owner_id='user_b'`).Scan(&kept); err != nil {
		t.Fatal(err)
	}
	if kept != 1 {
		t.Fatal("the queue entry of the other participant was removed")
	}
	// The assigned entry of the removed account loses the owner identifier, and
	// the allocation loses the public label of the participant.
	var entryOwner, entryLabel string
	if err := fixture.pool.QueryRow(ctx, `SELECT owner_id,coalesce(seat_control_model_label,'') FROM online_queue_entries WHERE entry_id='queue_assigned_entry_of_account_01'`).Scan(&entryOwner, &entryLabel); err != nil {
		t.Fatal(err)
	}
	if entryOwner != "anonymized" {
		t.Fatalf("the assigned queue entry still names the removed account: %q", entryOwner)
	}
	var initiatorLabel, opponentLabel string
	if err := fixture.pool.QueryRow(ctx, `SELECT initiator_label,opponent_label FROM online_queue_allocations WHERE allocation_id='allocation_of_the_account_00001'`).Scan(&initiatorLabel, &opponentLabel); err != nil {
		t.Fatal(err)
	}
	if initiatorLabel != "Deleted player" {
		t.Fatalf("the allocation still names the removed participant: %q / %q", initiatorLabel, opponentLabel)
	}
	if opponentLabel != "Bob" {
		t.Fatalf("the allocation lost the label of the other participant: %q", opponentLabel)
	}
}

// TestPostgresTheSubjectLedgerReplaysTheAuxiliarySanitation covers the
// restore of an older backup.
//
// The older state still holds the friend and the queue records of the removed
// account, and the subject level removal record is the only carrier of the
// removal. The replay has to sanitize them again.
func TestPostgresTheSubjectLedgerReplaysTheAuxiliarySanitation(t *testing.T) {
	fixture, removals, _ := privacyFixture(t)
	ctx := context.Background()
	matchID := "privacy-auxiliary-restore-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})
	seedAuxiliaryRows(t, fixture, "user_a", "user_b", matchID)
	if _, err := removals.DeleteAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("delete account: %v", err)
	}
	subjectRecords, err := removals.ListSubjectRemovalRecords(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(subjectRecords) != 1 {
		t.Fatalf("the subject removal ledger holds %d records", len(subjectRecords))
	}

	// The restored database is the older state: the invitation and the queue
	// records of the removed account are live again.
	restored := testPool(t)
	if err = migrations.Apply(ctx, restored); err != nil {
		t.Fatalf("apply migrations to the restored database: %v", err)
	}
	if _, err = restored.Exec(ctx, `
		INSERT INTO online_friend_invitations(invitation_id,kind,status,version,inviter_kind,inviter_id,inviter_public_label,inviter_control_kind,inviter_seat,starting_time_ms,increment_ms,created_at,expires_at)
		VALUES('inv_restored_invitation_of_account_001','link','open',1,'account','user_a','Alice','human','white',300000,0,clock_timestamp(),clock_timestamp()+interval '1 hour')`); err != nil {
		t.Fatal(err)
	}
	if _, err = restored.Exec(ctx, `
		INSERT INTO online_queue_entries(entry_id,owner_kind,owner_id,seat_control_kind,starting_time_ms,increment_ms,status,version,internal_state,created_at,updated_at,client_request_id,creation_hash)
		VALUES('queue_restored_entry_of_account_01','account','user_a','human',300000,0,'waiting',1,'waiting',clock_timestamp(),clock_timestamp(),'queue_restored_entry_of_account_01',sha256('queue_restored_entry_of_account_01'::bytea))`); err != nil {
		t.Fatal(err)
	}
	// The subject removal record is replayed on the restored database.
	restoredRemovals, err := privacy.Open(ctx, restored, fixture.authorizer, privacy.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err = restoredRemovals.ApplySubjectRemovalRecords(ctx, subjectRecords); err != nil {
		t.Fatalf("apply subject removal records: %v", err)
	}
	var invitations int
	if err = restored.QueryRow(ctx, `SELECT count(*) FROM online_friend_invitations WHERE inviter_id='user_a'`).Scan(&invitations); err != nil {
		t.Fatal(err)
	}
	if invitations != 0 {
		t.Fatalf("the restored invitation of the removed account survived: %d rows", invitations)
	}
	var entries int
	if err = restored.QueryRow(ctx, `SELECT count(*) FROM online_queue_entries WHERE owner_id='user_a'`).Scan(&entries); err != nil {
		t.Fatal(err)
	}
	if entries != 0 {
		t.Fatalf("the restored queue entry of the removed account survived: %d rows", entries)
	}
}
