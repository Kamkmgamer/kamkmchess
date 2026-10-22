package integration

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/history"
	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
)

// The labels of the regression.
//
// The deleted owner registered the alias of their own model, so the alias is
// published in the shared snapshots of the game. The opponent plays a known
// public model, whose label is on the allowlist and stays published.
const (
	aliasOwnerModelLabel   = "My Bot"
	publicOwnerModelLabel  = "GPT-4o"
	neutralOwnerModelLabel = "Custom model"
)

// aliasPayload is the published shape of a replay or of the older projection.
//
// The declared control of a participant, of an accepted move and of the
// terminal action carries the model label of that seat.
type aliasPayload struct {
	Participants []struct {
		Seat        string `json:"seat"`
		PublicLabel string `json:"publicLabel"`
		Control     struct {
			Kind       string `json:"kind"`
			ModelLabel string `json:"modelLabel"`
		} `json:"control"`
	} `json:"participants"`
	Moves []struct {
		Seat    string `json:"seat"`
		Control struct {
			Kind       string `json:"kind"`
			ModelLabel string `json:"modelLabel"`
		} `json:"control"`
	} `json:"moves"`
	Terminal *struct {
		Seat    string `json:"seat"`
		Control struct {
			Kind       string `json:"kind"`
			ModelLabel string `json:"modelLabel"`
		} `json:"control"`
	} `json:"terminal"`
}

// aliasMatch plays one completed game and publishes it.
//
// The white seat belongs to the account that registers the alias of their own
// model, and the black seat belongs to the opponent, whose model is a known
// public model. The white seat plays the only move through its runner lease
// and resigns, so the accepted move and the terminal action both belong to
// the seat of the deleted owner.
func aliasMatch(t *testing.T, fixture *onlineAuthFixture, historyService *history.Service, matchID string) {
	t.Helper()
	ctx := context.Background()
	// The owner registers the public label of their own model, so the alias is
	// publishable and reaches the shared snapshots of the game.
	if _, err := fixture.pool.Exec(ctx, `INSERT INTO online_account_public_labels(label_id,account_id,public_label) VALUES('kl_aliasowner01',$1,$2)`,
		"user_a", aliasOwnerModelLabel); err != nil {
		t.Fatalf("register the public label of the owner: %v", err)
	}
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black,
		online.SeatControl{Kind: online.ControlAgent, ModelLabel: modelLabel(aliasOwnerModelLabel)},
		online.SeatControl{Kind: online.ControlAgent, ModelLabel: modelLabel(publicOwnerModelLabel)})
	// The white seat acts through its runner lease, so the accepted move of
	// the deleted owner carries the declared control of that seat.
	owner := accountContext("user_a", "session-user_a")
	lease, err := fixture.service.AcquireRunnerLease(owner, presenceAlice().ref, leaseRequest(matchID, online.SeatWhite, "runner-alias", "", 1, 1))
	if err != nil {
		t.Fatalf("acquire the white seat: %v", err)
	}
	move := moveOnlineCommandAt(matchID, "op-move-"+matchID, online.SeatWhite, 1, 1, "e2e4")
	move.LeaseID = lease.LeaseID
	if _, err = fixture.service.Execute(owner, presenceAlice().ref, move); err != nil {
		t.Fatalf("move of the white seat: %v", err)
	}
	if _, err = fixture.service.ReleaseRunnerLease(owner, presenceAlice().ref, leaseRequest(matchID, online.SeatWhite, "runner-alias", lease.LeaseID, 1, 1)); err != nil {
		t.Fatalf("release the white seat: %v", err)
	}
	// The white seat resigns, so the terminal action belongs to the seat of
	// the deleted owner too.
	historyExecute(t, fixture, matchID, "op-resign-"+matchID, white, 2, 1, online.Action{Kind: online.ActionResign})
	if _, err := historyService.ProjectMatch(ctx, matchID); err != nil {
		t.Fatalf("project %s: %v", matchID, err)
	}
}

// aliasStoredPayload reads a stored snapshot of a match.
func aliasStoredPayload(t *testing.T, fixture *onlineAuthFixture, table, column, matchID string) string {
	t.Helper()
	var raw string
	if err := fixture.pool.QueryRow(context.Background(), `SELECT `+column+`::text FROM `+table+` WHERE match_id=$1`, matchID).Scan(&raw); err != nil {
		t.Fatalf("read the %s of %s: %v", column, matchID, err)
	}
	return raw
}

// aliasTimelineLabels reads the declared control timeline of a match.
func aliasTimelineLabels(t *testing.T, fixture *onlineAuthFixture, matchID string) map[string][]string {
	t.Helper()
	rows, err := fixture.pool.Query(context.Background(), `SELECT seat,model_label FROM online_seat_control_timeline WHERE match_id=$1 ORDER BY seat,version`, matchID)
	if err != nil {
		t.Fatalf("read the control timeline of %s: %v", matchID, err)
	}
	defer rows.Close()
	labels := map[string][]string{}
	for rows.Next() {
		var (
			seat  string
			label *string
		)
		if err = rows.Scan(&seat, &label); err != nil {
			t.Fatalf("read the control timeline of %s: %v", matchID, err)
		}
		value := ""
		if label != nil {
			value = *label
		}
		labels[seat] = append(labels[seat], value)
	}
	if err = rows.Err(); err != nil {
		t.Fatalf("read the control timeline of %s: %v", matchID, err)
	}
	return labels
}

// assertAliasRedacted proves that a snapshot of the removed seat carries the
// neutral label and that the known public model of the opponent is kept.
//
// The older projection of the match writer carries no control for an accepted
// move, so a move without a declared control is not a failure of the
// redaction.
func assertAliasRedacted(t *testing.T, name, raw string) aliasPayload {
	t.Helper()
	if strings.Contains(raw, aliasOwnerModelLabel) {
		t.Fatalf("the %s still carries the alias of the deleted owner: %s", name, raw)
	}
	var payload aliasPayload
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatalf("the %s is not a published payload: %v", name, err)
	}
	found := false
	for _, participant := range payload.Participants {
		switch participant.Seat {
		case "white":
			found = true
			if participant.PublicLabel != "Deleted player" {
				t.Fatalf("the %s does not name the deleted owner as the deleted player: %+v", name, participant)
			}
			if participant.Control.ModelLabel != neutralOwnerModelLabel {
				t.Fatalf("the %s keeps the model label of the deleted owner: %+v", name, participant)
			}
		case "black":
			if participant.Control.ModelLabel != publicOwnerModelLabel {
				t.Fatalf("the %s lost the allowlisted model label of the opponent: %+v", name, participant)
			}
		}
	}
	if !found {
		t.Fatalf("the %s has no white participant: %s", name, raw)
	}
	for _, move := range payload.Moves {
		if move.Seat != "white" || move.Control.ModelLabel == "" {
			continue
		}
		if move.Control.ModelLabel != neutralOwnerModelLabel {
			t.Fatalf("the %s keeps the model label of a move of the deleted owner: %+v", name, move)
		}
	}
	if payload.Terminal != nil && payload.Terminal.Seat == "white" && payload.Terminal.Control.ModelLabel != neutralOwnerModelLabel {
		t.Fatalf("the %s keeps the model label of the terminal action of the deleted owner: %+v", name, payload.Terminal)
	}
	return payload
}

// TestPostgresSeatAliasRedactionKeepsTheAllowlistedLabels covers the policy of
// the redaction itself.
//
// The redaction replaces the label of the removed seat and nothing else: an
// allowlisted public model name keeps its label, the label of the opponent is
// untouched, and the rest of the payload keeps its shape.
func TestPostgresSeatAliasRedactionKeepsTheAllowlistedLabels(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	payload := `{"schemaVersion":2,"matchId":"alias-policy-match","participants":[{"seat":"white","publicLabel":"Alice","control":{"kind":"agent","modelLabel":"My Bot","declaration":"declared"}},{"seat":"black","publicLabel":"Bob","control":{"kind":"agent","modelLabel":"GPT-4o","declaration":"declared"}}],"moves":[{"version":2,"seat":"white","uci":"e2e4","san":"e4","control":{"kind":"agent","modelLabel":"My Bot","declaration":"declared"}},{"version":3,"seat":"black","uci":"e7e5","san":"e5","control":{"kind":"agent","modelLabel":"GPT-4o","declaration":"declared"}}],"terminal":{"kind":"resign","seat":"white","control":{"kind":"agent","modelLabel":"My Bot","declaration":"declared"}}}`
	var raw string
	if err := fixture.pool.QueryRow(context.Background(), `SELECT online_redact_seat_model_aliases($1::jsonb,'white')::text`, payload).Scan(&raw); err != nil {
		t.Fatalf("redact the payload: %v", err)
	}
	if strings.Contains(raw, aliasOwnerModelLabel) {
		t.Fatalf("the redacted payload still carries the alias of the owner: %s", raw)
	}
	var redacted aliasPayload
	if err := json.Unmarshal([]byte(raw), &redacted); err != nil {
		t.Fatalf("the redacted payload is not a published payload: %v", err)
	}
	for _, participant := range redacted.Participants {
		switch participant.Seat {
		case "white":
			if participant.Control.ModelLabel != neutralOwnerModelLabel {
				t.Fatalf("the redacted payload keeps the label of the removed seat: %+v", participant)
			}
			if participant.PublicLabel != "Alice" {
				t.Fatalf("the redaction changed the public label of the removed seat: %+v", participant)
			}
		case "black":
			if participant.Control.ModelLabel != publicOwnerModelLabel {
				t.Fatalf("the redaction changed the label of the opponent: %+v", participant)
			}
		}
	}
	for _, move := range redacted.Moves {
		switch move.Seat {
		case "white":
			if move.Control.ModelLabel != neutralOwnerModelLabel {
				t.Fatalf("the redacted payload keeps the label of a move of the removed seat: %+v", move)
			}
		case "black":
			if move.Control.ModelLabel != publicOwnerModelLabel {
				t.Fatalf("the redaction changed the label of a move of the opponent: %+v", move)
			}
		}
	}
	if redacted.Terminal == nil || redacted.Terminal.Control.ModelLabel != neutralOwnerModelLabel {
		t.Fatalf("the redacted payload keeps the label of the terminal action of the removed seat: %+v", redacted.Terminal)
	}
	// The redaction is idempotent: a payload that carries the neutral label
	// already is not rewritten.
	var again string
	if err := fixture.pool.QueryRow(context.Background(), `SELECT online_redact_seat_model_aliases($1::jsonb,'white')::text`, raw).Scan(&again); err != nil {
		t.Fatalf("redact the payload again: %v", err)
	}
	if again != raw {
		t.Fatalf("the redaction is not idempotent: %s and %s", raw, again)
	}
}

// TestPostgresSeatControlTimelineRefusesARewriteOfALiveSeat covers the guard
// of the declared control timeline.
//
// The timeline of a seat whose owner is still there is append-only: the
// redaction of an alias is the only rewrite the guard accepts, and it needs
// an anonymized seat and a recorded anonymization marker.
func TestPostgresSeatControlTimelineRefusesARewriteOfALiveSeat(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	matchID := "privacy-alias-timeline-guard"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black,
		online.SeatControl{Kind: online.ControlAgent, ModelLabel: modelLabel(publicOwnerModelLabel)},
		online.SeatControl{Kind: online.ControlAgent, ModelLabel: modelLabel(publicOwnerModelLabel)})
	// The rewrite of the label of a live seat is refused.
	if _, err := fixture.pool.Exec(context.Background(), `
		UPDATE online_seat_control_timeline SET model_label='Something else' WHERE match_id=$1 AND seat='white'`, matchID); err == nil {
		t.Fatal("the label of a live seat was rewritten")
	}
	// The identity of a row is never rewritten.
	if _, err := fixture.pool.Exec(context.Background(), `
		UPDATE online_seat_control_timeline SET version=version+1 WHERE match_id=$1 AND seat='white'`, matchID); err == nil {
		t.Fatal("the identity of a control timeline row was rewritten")
	}
	// The row of the live seat keeps its label.
	var label string
	if err := fixture.pool.QueryRow(context.Background(), `SELECT model_label FROM online_seat_control_timeline WHERE match_id=$1 AND seat='white'`, matchID).Scan(&label); err != nil {
		t.Fatalf("read the control timeline: %v", err)
	}
	if label != publicOwnerModelLabel {
		t.Fatalf("the control timeline of a live seat = %q", label)
	}
}

// TestPostgresAccountDeletionRedactsThePersonalModelAliasOfTheDeletedSeat
// covers the alias leak of an ordinary account deletion.
//
// The shared snapshots of the game and the declared control timeline of the
// seat keep the alias the deleted owner registered for their own model. The
// deletion replaces it with the neutral label, so a signed-out reader of the
// public replay never sees the alias of a removed owner. The known public
// model of the opponent keeps its label.
func TestPostgresAccountDeletionRedactsThePersonalModelAliasOfTheDeletedSeat(t *testing.T) {
	fixture, removals, historyService := privacyFixture(t)
	matchID := "privacy-alias-match"
	aliasMatch(t, fixture, historyService, matchID)

	// The alias is published before the deletion, so the fixture is causal.
	replayBefore := aliasStoredPayload(t, fixture, "online_public_replays", "replay_json", matchID)
	if !strings.Contains(replayBefore, aliasOwnerModelLabel) {
		t.Fatalf("the published replay does not carry the alias of the owner: %s", replayBefore)
	}
	timelineBefore := aliasTimelineLabels(t, fixture, matchID)
	if len(timelineBefore["white"]) == 0 {
		t.Fatalf("the control timeline of the seat is empty: %+v", timelineBefore)
	}
	for _, label := range timelineBefore["white"] {
		if label != aliasOwnerModelLabel {
			t.Fatalf("the control timeline of the seat does not carry the alias of the owner: %+v", timelineBefore)
		}
	}

	if _, err := removals.DeleteAccount(context.Background(), accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("delete account: %v", err)
	}

	// The published replay of the match carries no alias of the deleted owner.
	replayPayload := assertAliasRedacted(t, "public replay", aliasStoredPayload(t, fixture, "online_public_replays", "replay_json", matchID))
	// The accepted move of the deleted owner carries the neutral label in the
	// published replay.
	whiteMoves := 0
	for _, move := range replayPayload.Moves {
		if move.Seat != "white" {
			continue
		}
		whiteMoves++
		if move.Control.ModelLabel != neutralOwnerModelLabel {
			t.Fatalf("the public replay keeps the model label of a move of the deleted owner: %+v", move)
		}
	}
	if whiteMoves == 0 {
		t.Fatal("the public replay has no accepted move of the deleted owner")
	}
	// The older projection of the match writer carries no alias either.
	assertAliasRedacted(t, "public projection", aliasStoredPayload(t, fixture, "online_public_projections", "projection_json", matchID))
	// The declared control timeline of the removed seat carries no alias.
	timeline := aliasTimelineLabels(t, fixture, matchID)
	for _, label := range timeline["white"] {
		if label != neutralOwnerModelLabel {
			t.Fatalf("the control timeline of the removed seat keeps the alias of the owner: %+v", timeline)
		}
	}
	for _, label := range timeline["black"] {
		if label != publicOwnerModelLabel {
			t.Fatalf("the control timeline of the opponent lost the allowlisted label: %+v", timeline)
		}
	}
	// The signed-out public replay of the match serves the neutral label.
	served, err := historyService.PublicReplay(context.Background(), matchID)
	if err != nil {
		t.Fatalf("public replay: %v", err)
	}
	for _, participant := range served.Participants {
		if participant.Seat != online.SeatWhite {
			continue
		}
		if participant.Control.ModelLabel == nil || *participant.Control.ModelLabel != neutralOwnerModelLabel {
			t.Fatalf("the served replay keeps the model label of the deleted owner: %+v", participant)
		}
	}
	for _, move := range served.Moves {
		if move.Seat != online.SeatWhite {
			continue
		}
		if move.Control.ModelLabel == nil || *move.Control.ModelLabel != neutralOwnerModelLabel {
			t.Fatalf("the served replay keeps the model label of a move of the deleted owner: %+v", move)
		}
	}
	if served.Terminal != nil && served.Terminal.Seat == online.SeatWhite {
		if served.Terminal.Control.ModelLabel == nil || *served.Terminal.Control.ModelLabel != neutralOwnerModelLabel {
			t.Fatalf("the served replay keeps the model label of the terminal action of the deleted owner: %+v", served.Terminal)
		}
	}
}

// TestPostgresRemovalLedgerReplayRedactsThePersonalModelAliasOfTheDeletedSeat
// covers the restore path.
//
// A restore of an older bundle replays the removal ledger before the restored
// database serves traffic. The restored snapshots carry the alias of the
// removed owner, and the replay of the ledger redacts them as well.
func TestPostgresRemovalLedgerReplayRedactsThePersonalModelAliasOfTheDeletedSeat(t *testing.T) {
	fixture, removals, historyService := privacyFixture(t)
	matchID := "privacy-alias-restore-match"
	aliasMatch(t, fixture, historyService, matchID)
	if _, err := removals.DeleteAccount(context.Background(), accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("delete account: %v", err)
	}
	records, err := removals.ListRemovalRecords(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(records) == 0 {
		t.Fatal("the removal ledger is empty")
	}

	// The restored database: the state before the removal, with the alias of
	// the owner in the snapshots and in the control timeline.
	restored := testPool(t)
	if err = migrations.Apply(context.Background(), restored); err != nil {
		t.Fatalf("apply migrations to the restored database: %v", err)
	}
	if _, err = restored.Exec(context.Background(), `
		INSERT INTO online_account_public_labels(label_id,account_id,public_label) VALUES('kl_restoredalias1','user_a',$1)`, aliasOwnerModelLabel); err != nil {
		t.Fatalf("restore the public label of the owner: %v", err)
	}
	if _, err = restored.Exec(context.Background(), `
		INSERT INTO online_matches(match_id,schema_version,variant,starting_fen,position_fen,starting_time_ms,increment_ms,version,control_epoch,input_hash,rules_policy_version,status,result,result_version,completed_at)
		VALUES($1,2,'orthodox','rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1','rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',300000,2000,3,1,sha256('restored'),'online-rules/1','completed','{"kind":"win","winner":"black","reason":"resignation"}',3,clock_timestamp())`, matchID); err != nil {
		t.Fatalf("restore the match: %v", err)
	}
	if _, err = restored.Exec(context.Background(), `
		INSERT INTO online_seats(match_id,seat,owner_kind,owner_id,public_label,control_kind,model_label,control_epoch)
		VALUES($1,'white','account','user_a','Alice','agent',$2,1),($1,'black','account','user_b','Bob','agent',$3,1)`,
		matchID, aliasOwnerModelLabel, publicOwnerModelLabel); err != nil {
		t.Fatalf("restore the seats: %v", err)
	}
	restoredReplay := `{"schemaVersion":2,"matchId":"privacy-alias-restore-match","participants":[{"seat":"white","publicLabel":"Alice","control":{"kind":"agent","modelLabel":"My Bot","declaration":"declared"}},{"seat":"black","publicLabel":"Bob","control":{"kind":"agent","modelLabel":"GPT-4o","declaration":"declared"}}],"moves":[{"version":2,"seat":"white","uci":"e2e4","san":"e4","control":{"kind":"agent","modelLabel":"My Bot","declaration":"declared"}}],"terminal":{"kind":"resign","seat":"white","control":{"kind":"agent","modelLabel":"My Bot","declaration":"declared"}}}`
	if _, err = restored.Exec(context.Background(), `
		INSERT INTO online_public_replays(match_id,schema_version,replay_json,result_hash,game_kind,scored)
		VALUES($1,2,$2::jsonb,sha256('restored'),'friend',true)`, matchID, restoredReplay); err != nil {
		t.Fatalf("restore the replay: %v", err)
	}
	if _, err = restored.Exec(context.Background(), `
		INSERT INTO online_public_projections(match_id,schema_version,projection_json,result_hash,published_at)
		VALUES($1,1,$2::jsonb,sha256('restored'),clock_timestamp())`, matchID, restoredReplay); err != nil {
		t.Fatalf("restore the projection: %v", err)
	}

	// The removal ledger is replayed on the restored database.
	restoredRemovals, err := privacy.Open(context.Background(), restored, fixture.authorizer, privacy.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err = restoredRemovals.ApplyRemovalRecords(context.Background(), records); err != nil {
		t.Fatalf("apply removal records: %v", err)
	}

	var replay string
	if err = restored.QueryRow(context.Background(), `SELECT replay_json::text FROM online_public_replays WHERE match_id=$1`, matchID).Scan(&replay); err != nil {
		t.Fatalf("read the restored replay: %v", err)
	}
	assertAliasRedacted(t, "restored public replay", replay)
	var projection string
	if err = restored.QueryRow(context.Background(), `SELECT projection_json::text FROM online_public_projections WHERE match_id=$1`, matchID).Scan(&projection); err != nil {
		t.Fatalf("read the restored projection: %v", err)
	}
	assertAliasRedacted(t, "restored public projection", projection)
	rows, err := restored.Query(context.Background(), `SELECT seat,model_label FROM online_seat_control_timeline WHERE match_id=$1 ORDER BY seat,version`, matchID)
	if err != nil {
		t.Fatalf("read the restored control timeline: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			seat  string
			label *string
		)
		if err = rows.Scan(&seat, &label); err != nil {
			t.Fatalf("read the restored control timeline: %v", err)
		}
		value := ""
		if label != nil {
			value = *label
		}
		switch seat {
		case "white":
			if value != neutralOwnerModelLabel {
				t.Fatalf("the restored control timeline of the removed seat keeps the alias of the owner: %q", value)
			}
		case "black":
			if value != publicOwnerModelLabel {
				t.Fatalf("the restored control timeline of the opponent lost the allowlisted label: %q", value)
			}
		}
	}
	if err = rows.Err(); err != nil {
		t.Fatalf("read the restored control timeline: %v", err)
	}
}
