package integration

import (
	"context"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
)

// TestPostgresTheGuestAuxiliaryRecordsAreSanitized covers the friend records
// of a removed guest.
//
// A guest inviter and a guest acceptor leave the same identifying columns as
// an account does: the guest identifier, the public label and the declared
// model label. The removal of a guest sanitizes them as well, and the replay
// of the subject ledger sanitizes them again.
func TestPostgresTheGuestAuxiliaryRecordsAreSanitized(t *testing.T) {
	fixture, removals, _ := privacyFixture(t)
	ctx := context.Background()
	matchID := "privacy-guest-auxiliary-match"
	issued := createGuestMatch(t, fixture, matchID)
	// The account resigns, so the match ends.
	resign := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     "op-guest-auxiliary-resign",
		ExpectedVersion: 1,
		Seat:            online.SeatBlack,
		ControlEpoch:    1,
		Action:          online.Action{Kind: online.ActionResign},
	}
	aliceCtx := accountContext("user_a", "session-alice")
	if _, err := fixture.service.Execute(aliceCtx, online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_a"}, resign); err != nil {
		t.Fatalf("resign: %v", err)
	}
	// The unused invitation of the guest, with an agent inviter and a declared
	// model label.
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_friend_invitations(invitation_id,kind,status,version,inviter_kind,inviter_id,inviter_public_label,inviter_control_kind,inviter_model_label,inviter_seat,starting_time_ms,increment_ms,created_at,expires_at)
		VALUES('inv_guest_invitation_of_the_guest_01','link','open',1,'guest','guest_alpha','Guest','agent','GPT-4o','white',300000,0,clock_timestamp(),clock_timestamp()+interval '1 hour')`); err != nil {
		t.Fatalf("seed the guest invitation: %v", err)
	}
	// The acceptance of the guest, with an agent acceptor and a declared model
	// label.
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_invitation_acceptances(acceptance_id,invitation_id,acceptance_key_hash,acceptor_kind,acceptor_id,guest_id,acceptor_public_label,seat,control_kind,model_label,status,created_at,updated_at)
		VALUES('acc_guest_acceptance_00000001','inv_guest_invitation_of_the_guest_01',sha256('guest-key'::bytea),'guest','guest_alpha','guest_alpha','Guest','black','agent','GPT-4o','pending',clock_timestamp(),clock_timestamp())`); err != nil {
		t.Fatalf("seed the guest acceptance: %v", err)
	}
	// The removal of the guest sanitizes them.
	guest, err := fixture.authorizer.AuthenticateGuest(ctx, issued.Credential.Secret, authTestOrigin)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = removals.RemoveGuest(ctx, guest, authTestOrigin); err != nil {
		t.Fatalf("remove the guest: %v", err)
	}
	var invitations int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_friend_invitations WHERE inviter_kind='guest' AND inviter_id='guest_alpha'`).Scan(&invitations); err != nil {
		t.Fatal(err)
	}
	if invitations != 0 {
		t.Fatalf("the invitation of the removed guest survived: %d rows", invitations)
	}
	// The acceptance of the guest never produced a match, so it is deleted
	// with the guest identifier in it.
	var acceptances int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_invitation_acceptances WHERE acceptor_id='guest_alpha'`).Scan(&acceptances); err != nil {
		t.Fatal(err)
	}
	if acceptances != 0 {
		t.Fatalf("the acceptance of the removed guest survived: %d rows", acceptances)
	}
	// The subject ledger replays the sanitation on an older restored state.
	subjectRecords, err := removals.ListSubjectRemovalRecords(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(subjectRecords) != 1 {
		t.Fatalf("the subject removal ledger holds %d records", len(subjectRecords))
	}
	restored := testPool(t)
	if err = migrations.Apply(ctx, restored); err != nil {
		t.Fatal(err)
	}
	if _, err = restored.Exec(ctx, `
		INSERT INTO online_friend_invitations(invitation_id,kind,status,version,inviter_kind,inviter_id,inviter_public_label,inviter_control_kind,inviter_model_label,inviter_seat,starting_time_ms,increment_ms,created_at,expires_at)
		VALUES('inv_restored_guest_invitation_of_the_guest_0001','link','open',1,'guest','guest_alpha','Guest','agent','GPT-4o','white',300000,0,clock_timestamp(),clock_timestamp()+interval '1 hour')`); err != nil {
		t.Fatal(err)
	}
	restoredRemovals, err := privacy.Open(ctx, restored, fixture.authorizer, privacy.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err = restoredRemovals.ApplySubjectRemovalRecords(ctx, subjectRecords); err != nil {
		t.Fatalf("apply the subject removal records: %v", err)
	}
	var restoredInvitations int
	if err = restored.QueryRow(ctx, `SELECT count(*) FROM online_friend_invitations WHERE inviter_id='guest_alpha'`).Scan(&restoredInvitations); err != nil {
		t.Fatal(err)
	}
	if restoredInvitations != 0 {
		t.Fatalf("the restored invitation of the removed guest survived: %d rows", restoredInvitations)
	}
}
