package integration

import (
	"context"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// TestPostgresTheQueueAllocationGuardAcceptsOnlyTheSanitizedColumns covers
// the redaction path of the queue allocation.
//
// The redaction changes the label of the removed participant and the declared
// model label with it. Everything else stays immutable: the operation key, the
// entries the allocation refers to, the control kinds and the labels of the
// other participant.
func TestPostgresTheQueueAllocationGuardAcceptsOnlyTheSanitizedColumns(t *testing.T) {
	fixture, removals, _ := privacyFixture(t)
	ctx := context.Background()
	matchID := "privacy-guard-allocation-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})
	// The removed account is the initiator of the allocation.
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("remove account: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_queue_entries(entry_id,owner_kind,owner_id,seat_control_kind,seat_control_model_label,starting_time_ms,increment_ms,status,version,internal_state,created_at,updated_at,client_request_id,creation_hash,assigned_match_id,ready_at)
		VALUES('queue_guard_entry_of_account_01','account','user_a','agent','gpt-4o',300000,0,'assigned',2,'assigned',clock_timestamp(),clock_timestamp(),'queue_guard_entry_of_account_01',sha256(convert_to('queue_guard_entry_of_account_01','UTF8')),$1,clock_timestamp())`, matchID); err != nil {
		t.Fatalf("seed the queue entry: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_queue_entries(entry_id,owner_kind,owner_id,seat_control_kind,seat_control_model_label,starting_time_ms,increment_ms,status,version,internal_state,created_at,updated_at,client_request_id,creation_hash)
		VALUES('queue_guard_entry_of_opponent_01','account','user_b','human',NULL,300000,0,'waiting',1,'waiting',clock_timestamp(),clock_timestamp(),'queue_guard_entry_of_opponent_01',sha256(convert_to('queue_guard_entry_of_opponent_01','UTF8')))`); err != nil {
		t.Fatalf("seed the opponent queue entry: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_queue_allocations(allocation_id,kind,initiator_entry_id,initiator_seat,opponent_entry_id,opponent_seat,operation_id,match_id,status,initiator_label,initiator_control_kind,initiator_control_model_label,opponent_label,opponent_control_kind,opponent_control_model_label,created_at,committed_at)
		VALUES('allocation_guard_of_account_001','candidate','queue_guard_entry_of_account_01','white','queue_guard_entry_of_opponent_01','black','op_allocation_guard_of_account_0001',$1,'committed','Alice','agent','GPT-4o','Bob','human',NULL,clock_timestamp(),clock_timestamp())`, matchID); err != nil {
		t.Fatalf("seed the allocation: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_queue_allocation_entries(allocation_id,entry_id,role) VALUES
		('allocation_guard_of_account_001','queue_guard_entry_of_account_01','initiator'),
		('allocation_guard_of_account_001','queue_guard_entry_of_opponent_01','opponent')`); err != nil {
		t.Fatalf("seed the allocation entries: %v", err)
	}
	// The operation key of the allocation is immutable.
	if _, err := fixture.pool.Exec(ctx, `
		UPDATE online_queue_allocations
		SET initiator_label='Deleted player', operation_id='op_rewritten_operation_key_0001'
		WHERE allocation_id='allocation_guard_of_account_001'`); err == nil {
		t.Fatal("the allocation accepted a rewritten operation key")
	}
	// The control kind of a participant is immutable.
	if _, err := fixture.pool.Exec(ctx, `
		UPDATE online_queue_allocations
		SET initiator_label='Deleted player', opponent_control_kind='agent'
		WHERE allocation_id='allocation_guard_of_account_001'`); err == nil {
		t.Fatal("the allocation accepted a rewritten control kind")
	}
	// The model label of the other participant is immutable.
	if _, err := fixture.pool.Exec(ctx, `
		UPDATE online_queue_allocations
		SET initiator_label='Deleted player', opponent_control_model_label='Custom model'
		WHERE allocation_id='allocation_guard_of_account_001'`); err == nil {
		t.Fatal("the allocation accepted a rewritten model label of the other participant")
	}
	// A label is only sanitized to the canonical value.
	if _, err := fixture.pool.Exec(ctx, `
		UPDATE online_queue_allocations
		SET initiator_label='Alice the Second'
		WHERE allocation_id='allocation_guard_of_account_001'`); err == nil {
		t.Fatal("the allocation accepted an arbitrary label")
	}
	// A model label is only the canonical neutral label.
	if _, err := fixture.pool.Exec(ctx, `
		UPDATE online_queue_allocations
		SET initiator_label='Deleted player', initiator_control_model_label='Some other model'
		WHERE allocation_id='allocation_guard_of_account_001'`); err == nil {
		t.Fatal("the allocation accepted an arbitrary model label")
	}
	// Both sides at once are refused: the opponent is not a removed subject.
	if _, err := fixture.pool.Exec(ctx, `
		UPDATE online_queue_allocations
		SET initiator_label='Deleted player', initiator_control_model_label='Custom model',
			opponent_label='Deleted player', opponent_control_model_label=NULL
		WHERE allocation_id='allocation_guard_of_account_001'`); err == nil {
		t.Fatal("the allocation accepted a redaction of both sides")
	}
	// The authorized redaction of the removed participant is accepted.
	if _, err := fixture.pool.Exec(ctx, `
		UPDATE online_queue_allocations
		SET initiator_label='Deleted player', initiator_control_model_label='Custom model'
		WHERE allocation_id='allocation_guard_of_account_001'`); err != nil {
		t.Fatalf("the authorized redaction was refused: %v", err)
	}
	var label, model, opponentLabel string
	if err := fixture.pool.QueryRow(ctx, `SELECT initiator_label,coalesce(initiator_control_model_label,''),opponent_label FROM online_queue_allocations WHERE allocation_id='allocation_guard_of_account_001'`).Scan(&label, &model, &opponentLabel); err != nil {
		t.Fatal(err)
	}
	if label != "Deleted player" || model != "Custom model" {
		t.Fatalf("the redacted allocation = %q / %q", label, model)
	}
	if opponentLabel != "Bob" {
		t.Fatalf("the allocation lost the label of the other participant: %q", opponentLabel)
	}
}

// TestPostgresTheFriendAgentRecordsAreSanitized covers the friend records of
// an agent inviter and an agent acceptor.
//
// The declared model label of an agent is not null, so the redaction replaces
// it with the neutral label instead of clearing it, and the deletion of the
// account is not aborted by the shape of the row.
func TestPostgresTheFriendAgentRecordsAreSanitized(t *testing.T) {
	fixture, removals, _ := privacyFixture(t)
	ctx := context.Background()
	matchID := "privacy-agent-friend-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})
	// The agent inviter of a consumed invitation.
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_friend_invitations(invitation_id,kind,status,version,inviter_kind,inviter_id,inviter_public_label,inviter_control_kind,inviter_model_label,inviter_seat,starting_time_ms,increment_ms,created_at,expires_at,consumed_at,match_id,acceptance_id)
		VALUES('inv_agent_inviter_of_the_account_0001','link','consumed',2,'account','user_a','Alice','agent','GPT-4o','white',300000,0,clock_timestamp(),clock_timestamp()+interval '1 hour',clock_timestamp(),$1,'acc_agent_acceptance_00001')`, matchID); err != nil {
		t.Fatalf("seed the agent invitation: %v", err)
	}
	// The agent acceptor of the acceptance.
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_invitation_acceptances(acceptance_id,invitation_id,acceptance_key_hash,acceptor_kind,acceptor_id,acceptor_public_label,seat,control_kind,model_label,status,created_at,updated_at,match_id)
		VALUES('acc_agent_acceptance_00001','inv_agent_inviter_of_the_account_0001',sha256('agent-key'::bytea),'account','user_a','Alice','black','agent','GPT-4o','matched',clock_timestamp(),clock_timestamp(),$1)`, matchID); err != nil {
		t.Fatalf("seed the agent acceptance: %v", err)
	}
	// The removal of the account succeeds and sanitizes the agent records.
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("remove account: %v", err)
	}
	var inviterLabel, inviterModel, acceptorLabel, acceptorModel string
	if err := fixture.pool.QueryRow(ctx, `SELECT inviter_public_label,coalesce(inviter_model_label,'') FROM online_friend_invitations WHERE invitation_id='inv_agent_inviter_of_the_account_0001'`).Scan(&inviterLabel, &inviterModel); err != nil {
		t.Fatal(err)
	}
	if inviterLabel != "Deleted player" {
		t.Fatalf("the agent invitation still names the removed account: %q", inviterLabel)
	}
	if inviterModel == "GPT-4o" {
		t.Fatalf("the agent invitation keeps the declared model of the removed account: %q", inviterModel)
	}
	if err := fixture.pool.QueryRow(ctx, `SELECT acceptor_public_label,coalesce(model_label,'') FROM online_invitation_acceptances WHERE acceptance_id='acc_agent_acceptance_00001'`).Scan(&acceptorLabel, &acceptorModel); err != nil {
		t.Fatal(err)
	}
	if acceptorLabel != "Deleted player" {
		t.Fatalf("the agent acceptance still names the removed account: %q", acceptorLabel)
	}
	if acceptorModel == "GPT-4o" {
		t.Fatalf("the agent acceptance keeps the declared model of the removed account: %q", acceptorModel)
	}
}
