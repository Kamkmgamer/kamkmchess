package integration

import (
	"context"
	"net/http"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/history"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
)

// TestPostgresPerMatchReplayRemovalRemovesThePublicReplay covers the per match
// removal of a public replay.
//
// The participant asks for the replay of one match to leave the public URL. The
// publisher must not publish it again, and the participant itself stays: a
// per match removal is not a removal of the participant.
func TestPostgresPerMatchReplayRemovalRemovesThePublicReplay(t *testing.T) {
	fixture, historyService, _ := historyFixture(t)
	matchID := "privacy-per-match-removal"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})
	if _, err := historyService.ProjectMatch(context.Background(), matchID); err != nil {
		t.Fatalf("project match: %v", err)
	}
	handler := historyHTTPFixture(t, fixture, historyService)
	published := onlineHTTPRequest(handler, http.MethodGet, "/v1/online/matches/"+matchID+"/replay", authTestOrigin, "", nil, "")
	if published.Code != http.StatusOK {
		t.Fatalf("the public replay status=%d body=%s", published.Code, published.Body.String())
	}
	// The participant removes the public replay of this match.
	historyExecute(t, fixture, matchID, "op-remove-replay", white, 3, 1, online.Action{
		Kind:         online.ActionRemovePublicReplay,
		RemoveReplay: &online.RemovePublicReplayAction{Reason: "owner_request"},
	})
	// The public URL is gone.
	removed := onlineHTTPRequest(handler, http.MethodGet, "/v1/online/matches/"+matchID+"/replay", authTestOrigin, "", nil, "")
	if removed.Code != http.StatusNotFound {
		t.Fatalf("the removed public replay status=%d body=%s", removed.Code, removed.Body.String())
	}
	// The publisher does not publish it again.
	if _, err := historyService.ProjectMatch(context.Background(), matchID); err != history.ErrNotFound {
		t.Fatalf("the publisher republished the removed replay: %v", err)
	}
	after := onlineHTTPRequest(handler, http.MethodGet, "/v1/online/matches/"+matchID+"/replay", authTestOrigin, "", nil, "")
	if after.Code != http.StatusNotFound {
		t.Fatalf("the removed public replay came back: status=%d body=%s", after.Code, after.Body.String())
	}
	// The participant itself stays: the match is still live for its
	// participants.
	live := onlineHTTPRequest(handler, http.MethodGet, "/v1/online/matches/"+matchID, authTestOrigin, "", map[string]string{"Authorization": "Bearer " + profileToken(t, fixture, "user_a", "session-user_a")}, "")
	if live.Code != http.StatusOK {
		t.Fatalf("the live state status=%d body=%s", live.Code, live.Body.String())
	}
}

// TestPostgresTwoRemovalsInOneMatchAreSealed covers the backup of a match whose
// two participants were both removed.
//
// The removal ledger is keyed by the match, the kind and the subject, so two
// removals of one match are two removals and the bundle seals them both.
func TestPostgresTwoRemovalsInOneMatchAreSealed(t *testing.T) {
	fixture, removals, _ := privacyFixture(t)
	ctx := context.Background()
	matchID := "privacy-two-removals-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("remove the first account: %v", err)
	}
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_b", "session-user_b"), authTestOrigin); err != nil {
		t.Fatalf("remove the second account: %v", err)
	}
	records, err := removals.ListRemovalRecords(ctx)
	if err != nil {
		t.Fatal(err)
	}
	subjects := map[string]bool{}
	for _, record := range records {
		if record.MatchID != matchID {
			continue
		}
		subjects[record.SubjectID] = true
	}
	if len(subjects) != 2 {
		t.Fatalf("the removal ledger holds %d subjects of the match: %+v", len(subjects), records)
	}
}

// TestPostgresTheRestoreFenceIsBoundToItsRestore covers the fence of a
// restore.
//
// The fence names the restore and the ledger it has to apply. A second restore
// does not overwrite it, and a fence is closed only by its own restore with the
// ledger it names.
func TestPostgresTheRestoreFenceIsBoundToItsRestore(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	fencePath := t.TempDir() + "/restore.fence"
	removals, err := privacy.Open(context.Background(), fixture.pool, fixture.authorizer, privacy.Options{FencePath: fencePath})
	if err != nil {
		t.Fatal(err)
	}
	digest := []byte("digest-of-the-ledger")
	fence, err := removals.BeginFence("restore-one", false)
	if err != nil {
		t.Fatalf("open fence: %v", err)
	}
	defer fence.Release()
	if err = fence.Bind(digest); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	// A second restore does not overwrite the fence of the first.
	if _, err = removals.BeginFence("restore-two", false); err == nil {
		t.Fatal("a second restore overwrote the fence of the first")
	}
	// The wrong ledger does not close the fence.
	if err = fence.Finish([]byte("another-digest")); err == nil {
		t.Fatal("the fence was closed with a ledger the restore did not apply")
	}
	// The fence of the restore that applied the ledger closes it.
	if err = fence.Finish(digest); err != nil {
		t.Fatalf("close fence: %v", err)
	}
	open, err := removals.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if open {
		t.Fatal("the fence is still open")
	}
	// The service serves traffic again.
	allowed, err := removals.ServingAllowed(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("a repaired database does not serve traffic")
	}
}

// TestPostgresTheRemovalRequestCannotBeWithdrawn covers the durability of the
// authority of the redaction.
//
// The removal request is the authority of the redaction paths, so it may not be
// deleted.
func TestPostgresTheRemovalRequestCannotBeWithdrawn(t *testing.T) {
	fixture, removals, _ := privacyFixture(t)
	ctx := context.Background()
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("remove account: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `DELETE FROM online_removal_requests`); err == nil {
		t.Fatal("the removal request was deleted")
	}
}

// TestPostgresTheAssignedAgentEntryOfARemovedAccountIsRedacted covers the
// assigned queue entry of a removed account.
//
// The declared model label of an agent seat is not null, so the redaction
// replaces it with the neutral label instead of clearing it, and the shape of
// the row stays valid. The allocation of the entry loses the same label, and
// the other participant keeps its own.
func TestPostgresTheAssignedAgentEntryOfARemovedAccountIsRedacted(t *testing.T) {
	fixture, removals, _ := privacyFixture(t)
	ctx := context.Background()
	matchID := "privacy-agent-entry-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_queue_entries(entry_id,owner_kind,owner_id,seat_control_kind,seat_control_model_label,starting_time_ms,increment_ms,status,version,internal_state,created_at,updated_at,client_request_id,creation_hash,assigned_match_id,ready_at)
		VALUES('queue_agent_entry_of_account_01','account','user_a','agent','GPT-4o',300000,0,'assigned',2,'assigned',clock_timestamp(),clock_timestamp(),'queue_agent_entry_of_account_01',sha256(convert_to('queue_agent_entry_of_account_01','UTF8')),$1,clock_timestamp())`, matchID); err != nil {
		t.Fatalf("seed the agent queue entry: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_queue_entries(entry_id,owner_kind,owner_id,seat_control_kind,starting_time_ms,increment_ms,status,version,internal_state,created_at,updated_at,client_request_id,creation_hash)
		VALUES('queue_agent_entry_of_opponent_01','account','user_b','human',300000,0,'waiting',1,'waiting',clock_timestamp(),clock_timestamp(),'queue_agent_entry_of_opponent_01',sha256(convert_to('queue_agent_entry_of_opponent_01','UTF8')))`); err != nil {
		t.Fatalf("seed the opponent queue entry: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_queue_allocations(allocation_id,kind,initiator_entry_id,initiator_seat,opponent_entry_id,opponent_seat,operation_id,match_id,status,initiator_label,initiator_control_kind,initiator_control_model_label,opponent_label,opponent_control_kind,opponent_control_model_label,created_at,committed_at)
		VALUES('allocation_agent_of_account_001','candidate','queue_agent_entry_of_account_01','white','queue_agent_entry_of_opponent_01','black','op_allocation_agent_of_account_0001',$1,'committed','Alice','agent','GPT-4o','Bob','human',NULL,clock_timestamp(),clock_timestamp())`, matchID); err != nil {
		t.Fatalf("seed the allocation: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_queue_allocation_entries(allocation_id,entry_id,role) VALUES
		('allocation_agent_of_account_001','queue_agent_entry_of_account_01','initiator'),
		('allocation_agent_of_account_001','queue_agent_entry_of_opponent_01','opponent')`); err != nil {
		t.Fatalf("seed the allocation entries: %v", err)
	}
	// The removal of the account succeeds: the agent entry does not abort it.
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("remove account: %v", err)
	}
	var entryOwner, entryModel string
	if err := fixture.pool.QueryRow(ctx, `SELECT owner_id,coalesce(seat_control_model_label,'') FROM online_queue_entries WHERE entry_id='queue_agent_entry_of_account_01'`).Scan(&entryOwner, &entryModel); err != nil {
		t.Fatal(err)
	}
	if entryOwner != "anonymized" {
		t.Fatalf("the agent queue entry still names the removed account: %q", entryOwner)
	}
	if entryModel == "GPT-4o" {
		t.Fatalf("the agent queue entry keeps the declared model of the removed account: %q", entryModel)
	}
	var allocationModel, opponentLabel string
	if err := fixture.pool.QueryRow(ctx, `SELECT coalesce(initiator_control_model_label,''),opponent_label FROM online_queue_allocations WHERE allocation_id='allocation_agent_of_account_001'`).Scan(&allocationModel, &opponentLabel); err != nil {
		t.Fatal(err)
	}
	if allocationModel == "GPT-4o" {
		t.Fatalf("the allocation keeps the declared model of the removed account: %q", allocationModel)
	}
	if opponentLabel != "Bob" {
		t.Fatalf("the allocation lost the label of the other participant: %q", opponentLabel)
	}
	// The other participant keeps its entry.
	var kept int
	if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_queue_entries WHERE entry_id='queue_agent_entry_of_opponent_01' AND owner_id='user_b'`).Scan(&kept); err != nil {
		t.Fatal(err)
	}
	if kept != 1 {
		t.Fatal("the queue entry of the other participant was removed")
	}
}

// TestPostgresTheAllocationLosesTheModelLabelOfTheRemovedParticipant covers
// the declared model label of a removed participant in the queue allocation.
func TestPostgresTheAllocationLosesTheModelLabelOfTheRemovedParticipant(t *testing.T) {
	fixture, removals, _ := privacyFixture(t)
	ctx := context.Background()
	matchID := "privacy-allocation-label-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_queue_entries(entry_id,owner_kind,owner_id,seat_control_kind,seat_control_model_label,starting_time_ms,increment_ms,status,version,internal_state,created_at,updated_at,client_request_id,creation_hash,assigned_match_id,ready_at)
		VALUES('queue_label_entry_of_account_01','account','user_a','agent','GPT-4o',300000,0,'assigned',2,'assigned',clock_timestamp(),clock_timestamp(),'queue_label_entry_of_account_01',sha256(convert_to('queue_label_entry_of_account_01','UTF8')),$1,clock_timestamp())`, matchID); err != nil {
		t.Fatalf("seed the queue entry: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_queue_entries(entry_id,owner_kind,owner_id,seat_control_kind,starting_time_ms,increment_ms,status,version,internal_state,created_at,updated_at,client_request_id,creation_hash)
		VALUES('queue_label_entry_of_opponent_01','account','user_b','human',300000,0,'waiting',1,'waiting',clock_timestamp(),clock_timestamp(),'queue_label_entry_of_opponent_01',sha256(convert_to('queue_label_entry_of_opponent_01','UTF8')))`); err != nil {
		t.Fatalf("seed the opponent queue entry: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_queue_allocations(allocation_id,kind,initiator_entry_id,initiator_seat,opponent_entry_id,opponent_seat,operation_id,match_id,status,initiator_label,initiator_control_kind,initiator_control_model_label,opponent_label,opponent_control_kind,opponent_control_model_label,created_at,committed_at)
		VALUES('allocation_label_of_account_0001','candidate','queue_label_entry_of_account_01','white','queue_label_entry_of_opponent_01','black','op_allocation_label_of_account_0001',$1,'committed','Alice','agent','GPT-4o','Bob','human',NULL,clock_timestamp(),clock_timestamp())`, matchID); err != nil {
		t.Fatalf("seed the allocation: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO online_queue_allocation_entries(allocation_id,entry_id,role) VALUES
		('allocation_label_of_account_0001','queue_label_entry_of_account_01','initiator'),
		('allocation_label_of_account_0001','queue_label_entry_of_opponent_01','opponent')`); err != nil {
		t.Fatalf("seed the allocation entries: %v", err)
	}
	if _, err := removals.RemoveAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("remove account: %v", err)
	}
	var label, opponentLabel, opponentModel string
	if err := fixture.pool.QueryRow(ctx, `SELECT initiator_control_model_label,opponent_label,coalesce(opponent_control_model_label,'') FROM online_queue_allocations WHERE allocation_id='allocation_label_of_account_0001'`).Scan(&label, &opponentLabel, &opponentModel); err != nil {
		t.Fatal(err)
	}
	if label == "GPT-4o" {
		t.Fatalf("the allocation still declares the model of the removed participant: %q", label)
	}
	if opponentLabel != "Bob" {
		t.Fatalf("the allocation lost the label of the other participant: %q", opponentLabel)
	}
	var clientRequest *string
	if err := fixture.pool.QueryRow(ctx, `SELECT client_request_id::text FROM online_queue_entries WHERE entry_id='queue_label_entry_of_account_01'`).Scan(&clientRequest); err != nil {
		t.Fatal(err)
	}
	if clientRequest != nil {
		t.Fatalf("the queue entry keeps the client supplied idempotency key: %q", *clientRequest)
	}
}
