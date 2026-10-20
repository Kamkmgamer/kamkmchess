package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/history"
	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/profile"
	"github.com/Kamkmgamer/kamkmchess/backend/storage"
)

// historyFixture wires the real history publisher to the real writer, the real
// authorization service, the real profile service and the real database.
func historyFixture(t *testing.T) (*onlineAuthFixture, *history.Service, *profile.Service) {
	t.Helper()
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	profileService, err := profile.Open(context.Background(), fixture.pool, fixture.authorizer, profile.Options{})
	if err != nil {
		t.Fatal(err)
	}
	historyService, err := history.Open(context.Background(), fixture.pool, profileService, history.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return fixture, historyService, profileService
}

// historyServiceFor opens the history publisher of an existing fixture.
func historyServiceFor(t *testing.T, fixture *onlineAuthFixture) *history.Service {
	t.Helper()
	profileService, err := profile.Open(context.Background(), fixture.pool, fixture.authorizer, profile.Options{})
	if err != nil {
		t.Fatal(err)
	}
	historyService, err := history.Open(context.Background(), fixture.pool, profileService, history.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return historyService
}

// historyHTTPFixture is the production composition of the online API with the
// public replay provider of the history service.
func historyHTTPFixture(t *testing.T, fixture *onlineAuthFixture, historyService *history.Service) http.Handler {
	t.Helper()
	return httpapi.CORSWithHeaders(
		[]string{authTestOrigin},
		httpapi.OnlineRequestHeaders,
		httpapi.NewOnlineWithPublicReplay(fixture.service, fixture.authorizer, httpapi.OnlineOptions{AllowedOrigins: []string{authTestOrigin}}, historyService),
	)
}

// historyPublicFixture is the production composition of the public history API.
func historyPublicFixture(t *testing.T, historyService *history.Service) http.Handler {
	t.Helper()
	return httpapi.CORS([]string{authTestOrigin}, httpapi.NewPublicHistory(historyService))
}

// accountSeat is one participant reference of a test match.
type accountSeat struct {
	Subject string
	Seat    online.Seat
}

// historyCommand builds a command for one account seat.
func historyCommand(matchID, operationID string, seat accountSeat, version int64, action online.Action) online.Command {
	return online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         matchID,
		OperationID:     operationID,
		ExpectedVersion: version,
		Seat:            seat.Seat,
		ControlEpoch:    1,
		Action:          action,
	}
}

// historyExecute runs one command as its account.
func historyExecute(t *testing.T, fixture *onlineAuthFixture, matchID, operationID string, seat accountSeat, version int64, controlEpoch int64, action online.Action) {
	t.Helper()
	command := historyCommand(matchID, operationID, seat, version, action)
	command.ControlEpoch = controlEpoch
	ctx := accountContext(seat.Subject, "session-"+seat.Subject)
	if _, err := fixture.service.Execute(ctx, online.ParticipantRef{Kind: online.ParticipantAccount, ID: seat.Subject}, command); err != nil {
		t.Fatalf("execute %s: %v", operationID, err)
	}
}

// historyMatchCommand creates a match with the given seats.
func historyMatchCommand(matchID, operationID string, white, black accountSeat, whiteControl, blackControl online.SeatControl) online.Command {
	command := createOnlineCommand(matchID, operationID)
	command.Action.CreateMatch.Seats.White = online.CreateSeat{
		Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: white.Subject},
		PublicLabel: "Alice",
		Control:     whiteControl,
	}
	command.Action.CreateMatch.Seats.Black = online.CreateSeat{
		Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: black.Subject},
		PublicLabel: "Bob",
		Control:     blackControl,
	}
	command.Seat = white.Seat
	return command
}

// historyCreate creates a match as its white seat.
func historyCreate(t *testing.T, fixture *onlineAuthFixture, matchID string, white, black accountSeat, whiteControl, blackControl online.SeatControl) {
	t.Helper()
	command := historyMatchCommand(matchID, "op-create-"+matchID, white, black, whiteControl, blackControl)
	ctx := accountContext(white.Subject, "session-"+white.Subject)
	if _, err := fixture.service.Execute(ctx, online.ParticipantRef{Kind: online.ParticipantAccount, ID: white.Subject}, command); err != nil {
		t.Fatalf("create %s: %v", matchID, err)
	}
}

// historyReplay reads a public replay through the canonical public URL without
// any credential.
func historyReplay(t *testing.T, handler http.Handler, matchID string) map[string]any {
	t.Helper()
	response := onlineHTTPRequest(handler, http.MethodGet, "/v1/online/matches/"+matchID+"/replay", authTestOrigin, "", nil, "")
	if response.Code != http.StatusOK {
		t.Fatalf("replay status=%d body=%s", response.Code, response.Body.String())
	}
	return decodeProfile(t, response.Body.Bytes())
}

// historyPayload reads the public history of one profile.
func historyPayload(t *testing.T, handler http.Handler, profileID string) map[string]any {
	t.Helper()
	response := onlineHTTPRequest(handler, http.MethodGet, "/v1/public/profiles/"+profileID+"/history", authTestOrigin, "", nil, "")
	if response.Code != http.StatusOK {
		t.Fatalf("history status=%d body=%s", response.Code, response.Body.String())
	}
	return decodeProfile(t, response.Body.Bytes())
}

// TestPostgresPublicReplayIsAllowlistedAndReadableWithoutSigningIn covers the
// signed-out public replay of a completed online match.
func TestPostgresPublicReplayIsAllowlistedAndReadableWithoutSigningIn(t *testing.T) {
	fixture, historyService, profileService := historyFixture(t)
	matchID := "history-replay-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})

	replay, err := historyService.ProjectMatch(context.Background(), matchID)
	if err != nil {
		t.Fatalf("project match: %v", err)
	}
	if replay.SchemaVersion != history.ReplaySchemaVersion {
		t.Fatalf("replay schema version = %d", replay.SchemaVersion)
	}
	if replay.GameKind != history.GameFriend {
		t.Fatalf("game kind = %q", replay.GameKind)
	}
	if !replay.Scored || replay.Result.Kind != online.ResultWin {
		t.Fatalf("result = %+v scored=%v", replay.Result, replay.Scored)
	}
	if replay.Attribution.Source != "declared" || replay.Attribution.ProviderVerified {
		t.Fatalf("attribution = %+v", replay.Attribution)
	}
	if replay.Terminal == nil || replay.Terminal.Seat != online.SeatBlack || replay.Terminal.Kind != "resign" {
		t.Fatalf("terminal action = %+v", replay.Terminal)
	}
	if len(replay.Moves) != 1 || replay.Moves[0].Control.Kind != online.ControlHuman {
		t.Fatalf("replay moves = %+v", replay.Moves)
	}

	handler := historyHTTPFixture(t, fixture, historyService)
	payload := historyReplay(t, handler, matchID)
	if payload["schemaVersion"].(float64) != float64(history.ReplaySchemaVersion) {
		t.Fatalf("public replay schema version = %v", payload["schemaVersion"])
	}
	body, _ := json.Marshal(payload)
	for _, forbidden := range []string{"user_a", "user_b", "session-user_a"} {
		if strings.Contains(string(body), forbidden) {
			t.Fatalf("the public replay carries %q: %s", forbidden, string(body))
		}
	}

	// The public profile history of the winner lists the game once.
	profileID, err := profileService.EnsureProfileForAccount(context.Background(), "user_a")
	if err != nil {
		t.Fatal(err)
	}
	publicHandler := historyPublicFixture(t, historyService)
	record := historyPayload(t, publicHandler, profileID)
	games, _ := record["games"].([]any)
	if len(games) != 1 {
		t.Fatalf("public history games = %v", record["games"])
	}
	totals, _ := record["totals"].(map[string]any)
	if totals["wins"].(float64) != 1 || totals["losses"].(float64) != 0 {
		t.Fatalf("public history totals = %v", totals)
	}
}

// TestPostgresProjectionIsIdempotentAndCountsEachResultOnce covers the
// repeated publication of one completed game.
func TestPostgresProjectionIsIdempotentAndCountsEachResultOnce(t *testing.T) {
	fixture, historyService, profileService := historyFixture(t)
	matchID := "history-idempotent-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})

	for attempt := 0; attempt < 3; attempt++ {
		if _, err := historyService.ProjectMatch(context.Background(), matchID); err != nil {
			t.Fatalf("project attempt %d: %v", attempt, err)
		}
	}
	profileID, err := profileService.EnsureProfileForAccount(context.Background(), "user_a")
	if err != nil {
		t.Fatal(err)
	}
	record, err := historyService.ProfileHistory(context.Background(), profileID)
	if err != nil {
		t.Fatal(err)
	}
	if len(record.Games) != 1 {
		t.Fatalf("history games = %d", len(record.Games))
	}
	if record.Totals.Wins != 1 || record.Totals.Losses != 0 || record.Totals.Draws != 0 {
		t.Fatalf("history totals = %+v", record.Totals)
	}
	// The published replay is stored once.
	var stored int
	if err = fixture.pool.QueryRow(context.Background(), `SELECT count(*) FROM online_public_replays WHERE match_id=$1`, matchID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 1 {
		t.Fatalf("stored replays = %d", stored)
	}
}

// TestPostgresAbortIsPublishedAsUnscored covers the unscored abort.
func TestPostgresAbortIsPublishedAsUnscored(t *testing.T) {
	fixture, historyService, profileService := historyFixture(t)
	matchID := "history-abort-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	// The white seat cancels before it ever moved, so the match aborts.
	historyExecute(t, fixture, matchID, "op-cancel-1", white, 1, 1, online.Action{Kind: online.ActionCancel})

	replay, err := historyService.ProjectMatch(context.Background(), matchID)
	if err != nil {
		t.Fatalf("project match: %v", err)
	}
	if replay.Scored {
		t.Fatal("an abort must not be scored")
	}
	if replay.Result.Kind != online.ResultAbort {
		t.Fatalf("result = %+v", replay.Result)
	}
	profileID, err := profileService.EnsureProfileForAccount(context.Background(), "user_a")
	if err != nil {
		t.Fatal(err)
	}
	record, err := historyService.ProfileHistory(context.Background(), profileID)
	if err != nil {
		t.Fatal(err)
	}
	if len(record.Games) != 1 {
		t.Fatalf("history games = %d", len(record.Games))
	}
	if record.Games[0].Outcome != history.OutcomeAbort || record.Games[0].Scored {
		t.Fatalf("history entry = %+v", record.Games[0])
	}
	if record.Totals.Aborts != 1 || record.Totals.Scored != 0 || record.Totals.Wins != 0 {
		t.Fatalf("history totals = %+v", record.Totals)
	}
}

// TestPostgresPrivateModelLabelNeverReachesTheSharedTables covers the
// secret-bearing routing fixture.
func TestPostgresPrivateModelLabelNeverReachesTheSharedTables(t *testing.T) {
	fixture, historyService, _ := historyFixture(t)
	matchID := "history-private-label-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	secret := "sk-live-9f8a7b6c5d4e3f2a1b0c"
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlAgent, ModelLabel: &secret})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})

	replay, err := historyService.ProjectMatch(context.Background(), matchID)
	if err != nil {
		t.Fatalf("project match: %v", err)
	}
	raw, _ := json.Marshal(replay)
	if strings.Contains(string(raw), secret) || strings.Contains(string(raw), "sk-live") {
		t.Fatalf("the public replay carries the private label: %s", string(raw))
	}
	blackControl := replay.Participants[1].Control
	if blackControl.Kind != online.ControlAgent {
		t.Fatalf("the black control = %+v", blackControl)
	}
	if blackControl.ModelLabel == nil || *blackControl.ModelLabel != history.NeutralModelLabel {
		t.Fatalf("the black model label = %v", blackControl.ModelLabel)
	}
	// The private label never reaches a shared table either.
	for _, column := range []struct{ table, column string }{
		{"online_seats", "model_label"},
		{"online_events", "control_model_label"},
		{"online_seat_control_timeline", "model_label"},
	} {
		var found int
		if err = fixture.pool.QueryRow(context.Background(), fmt.Sprintf(`SELECT count(*) FROM %s WHERE %s LIKE '%%sk-live%%'`, column.table, column.column)).Scan(&found); err != nil {
			t.Fatal(err)
		}
		if found != 0 {
			t.Fatalf("%s carries the private label in %d rows", column.table, found)
		}
	}
	var receipts int
	if err = fixture.pool.QueryRow(context.Background(), `SELECT count(*) FROM online_operation_receipts WHERE convert_from(result_json,'UTF8') LIKE '%sk-live%'`).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if receipts != 0 {
		t.Fatalf("a stored receipt carries the private label in %d rows", receipts)
	}
}

// TestPostgresOwnerChosenPublicLabelIsPublished covers the public label an
// owner chose for their own model opponent.
func TestPostgresOwnerChosenPublicLabelIsPublished(t *testing.T) {
	fixture, historyService, _ := historyFixture(t)
	if _, err := historyService.RegisterPublicLabel(context.Background(), "user_b", "My chess model"); err != nil {
		t.Fatalf("register public label: %v", err)
	}
	matchID := "history-chosen-label-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	label := "My chess model"
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlAgent, ModelLabel: &label})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})

	replay, err := historyService.ProjectMatch(context.Background(), matchID)
	if err != nil {
		t.Fatalf("project match: %v", err)
	}
	blackControl := replay.Participants[1].Control
	if blackControl.ModelLabel == nil || *blackControl.ModelLabel != "My chess model" {
		t.Fatalf("the black model label = %v", blackControl.ModelLabel)
	}
}

// TestPostgresMixedControlAttributesEveryMoveAndTheTerminalAction covers the
// control change in the middle of a game.
func TestPostgresMixedControlAttributesEveryMoveAndTheTerminalAction(t *testing.T) {
	fixture, historyService, _ := historyFixture(t)
	matchID := "history-mixed-control-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	public := "gpt-4o"
	historyExecute(t, fixture, matchID, "op-control-1", black, 2, 1, online.Action{Kind: online.ActionSetControl, SetControl: &online.SetControlAction{Control: online.SeatControl{Kind: online.ControlAgent, ModelLabel: &public}}})
	historyExecute(t, fixture, matchID, "op-move-2", black, 3, 2, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e7e5"}})
	historyExecute(t, fixture, matchID, "op-resign-1", black, 4, 2, online.Action{Kind: online.ActionResign})

	replay, err := historyService.ProjectMatch(context.Background(), matchID)
	if err != nil {
		t.Fatalf("project match: %v", err)
	}
	if len(replay.Moves) != 2 {
		t.Fatalf("replay moves = %+v", replay.Moves)
	}
	if replay.Moves[0].Control.Kind != online.ControlHuman {
		t.Fatalf("the first move control = %+v", replay.Moves[0].Control)
	}
	second := replay.Moves[1].Control
	if second.Kind != online.ControlAgent || second.ModelLabel == nil || *second.ModelLabel != "GPT-4o" {
		t.Fatalf("the second move control = %+v", second)
	}
	if replay.Terminal == nil || replay.Terminal.Seat != online.SeatBlack {
		t.Fatalf("terminal action = %+v", replay.Terminal)
	}
	if replay.Terminal.Control.Kind != online.ControlAgent || replay.Terminal.Control.ModelLabel == nil || *replay.Terminal.Control.ModelLabel != "GPT-4o" {
		t.Fatalf("the terminal action control = %+v", replay.Terminal.Control)
	}
	if replay.Participants[0].Control.Kind != online.ControlHuman {
		t.Fatalf("the white final control = %+v", replay.Participants[0].Control)
	}
}

// TestPostgresPublicHistoryExcludesPrivateLocalSaves covers the excluded game
// types: a private single-owner save never reaches the public history.
func TestPostgresPublicHistoryExcludesPrivateLocalSaves(t *testing.T) {
	fixture, historyService, profileService := historyFixture(t)
	store, err := storage.Open(context.Background(), fixture.pool)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.Create(context.Background(), "user_a", storage.CreateGame{GameID: "private-local-game", CheckpointJSON: checkpoint("private-local-game", "user_a", 1, 1, map[string]any{"kind": "unresolved"})}); err != nil {
		t.Fatalf("create private game: %v", err)
	}
	matchID := "history-online-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})
	if _, err = historyService.ProjectMatch(context.Background(), matchID); err != nil {
		t.Fatalf("project match: %v", err)
	}
	profileID, err := profileService.EnsureProfileForAccount(context.Background(), "user_a")
	if err != nil {
		t.Fatal(err)
	}
	record, err := historyService.ProfileHistory(context.Background(), profileID)
	if err != nil {
		t.Fatal(err)
	}
	if len(record.Games) != 1 || record.Games[0].MatchID != matchID {
		t.Fatalf("the public history carries a private save: %+v", record.Games)
	}
}

// TestPostgresFallbackGameIsNamedAfterTheBrowserEngine covers the fallback
// game kind.
func TestPostgresFallbackGameIsNamedAfterTheBrowserEngine(t *testing.T) {
	fixture, historyService, _ := historyFixture(t)
	matchID := "history-fallback-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	engine := "stockfish-19-lite"
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlEngine, ModelLabel: &engine})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})

	replay, err := historyService.ProjectMatch(context.Background(), matchID)
	if err != nil {
		t.Fatalf("project match: %v", err)
	}
	if replay.GameKind != history.GameFallback {
		t.Fatalf("game kind = %q", replay.GameKind)
	}
	engineControl := replay.Participants[1].Control
	if engineControl.Kind != online.ControlEngine || engineControl.ModelLabel == nil || *engineControl.ModelLabel != history.EngineLabel {
		t.Fatalf("the engine control = %+v", engineControl)
	}
}

// TestPostgresLegacyReplayRouteServesTheAllowlistedReplay covers the
// canonical replay URL of the participant API.
func TestPostgresLegacyReplayRouteServesTheAllowlistedReplay(t *testing.T) {
	fixture, historyService, _ := historyFixture(t)
	matchID := "history-legacy-route-match"
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-1", white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-1", black, 2, 1, online.Action{Kind: online.ActionResign})

	handler := historyHTTPFixture(t, fixture, historyService)
	payload := historyReplay(t, handler, matchID)
	if payload["schemaVersion"].(float64) != float64(history.ReplaySchemaVersion) {
		t.Fatalf("the canonical replay route served schema %v", payload["schemaVersion"])
	}
	if _, ok := payload["attribution"]; !ok {
		t.Fatalf("the canonical replay route served no attribution: %v", payload)
	}
	// The route is readable without a credential, and it never serves the
	// older projection of the match writer.
	response := onlineHTTPRequest(handler, http.MethodGet, "/v1/online/matches/"+matchID+"/replay", authTestOrigin, "", nil, "")
	body := response.Body.String()
	if strings.Contains(body, "\"schemaVersion\":1") {
		t.Fatalf("the canonical replay route served the older projection: %s", body)
	}
}
