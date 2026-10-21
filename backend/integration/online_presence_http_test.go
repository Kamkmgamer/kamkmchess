package integration

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// The presence, claim and runner lease routes over real HTTP.
//
// The routes authenticate the participant and then call the service with the
// authorized context. Without that context the service cannot find the
// principal of the request, so the credential is refused even though it is
// valid. These regressions drive the real routes with a real account
// credential and a real guest seat credential.

// presenceHTTPFixture is the production composition of the participant API.
func presenceHTTPFixture(t *testing.T, fixture *onlineAuthFixture) http.Handler {
	t.Helper()
	return onlineHTTPFixture(t, fixture)
}

// presenceBody encodes a request body.
func presenceBody(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// TestOnlinePresenceHTTPAuthorizesTheAccountParticipant covers the account
// participant of the presence, claim and runner lease routes.
//
// Every route answers with the authorized context, so a valid account
// credential is accepted and the service sees the participant.
func TestOnlinePresenceHTTPAuthorizesTheAccountParticipant(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	handler := presenceHTTPFixture(t, fixture)
	const matchID = "match-presence-http-account"
	if _, err := fixture.service.Execute(accountContext("user_a", "session-alice"), alice, createOnlineCommand(matchID, "op-create-"+matchID)); err != nil {
		t.Fatalf("create the match: %v", err)
	}
	token := signSession(t, fixture.key, "user_a", "session-alice", time.Now().Add(time.Hour))
	otherToken := signSession(t, fixture.key, "user_b", "session-bob", time.Now().Add(time.Hour))
	headers := map[string]string{"Authorization": "Bearer " + token}
	otherHeaders := map[string]string{"Authorization": "Bearer " + otherToken}

	// The presence view.
	response := onlineHTTPRequest(handler, http.MethodGet, "/v1/online/matches/"+matchID+"/presence", authTestOrigin, "", headers, "")
	if response.Code != http.StatusOK {
		t.Fatalf("the presence view status=%d body=%s", response.Code, response.Body.String())
	}
	var view struct {
		MatchID string `json:"matchId"`
		Seats   []struct {
			Seat  string `json:"seat"`
			State string `json:"state"`
		} `json:"seats"`
		ServiceState string `json:"serviceState"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if view.MatchID != matchID {
		t.Fatalf("the presence view = %+v", view)
	}
	if len(view.Seats) != 2 {
		t.Fatalf("the presence view has %d seats, want 2", len(view.Seats))
	}

	// The heartbeat of the own seat and of the opponent seat.
	body := presenceBody(t, map[string]any{"seat": "white"})
	response = onlineHTTPRequest(handler, http.MethodPost, "/v1/online/matches/"+matchID+"/presence", authTestOrigin, "", headers, body)
	if response.Code != http.StatusOK {
		t.Fatalf("the heartbeat status=%d body=%s", response.Code, response.Body.String())
	}
	var presence struct {
		Seat  string `json:"seat"`
		State string `json:"state"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &presence); err != nil {
		t.Fatal(err)
	}
	if presence.Seat != "white" || presence.State != "connected" {
		t.Fatalf("the heartbeat answer = %+v", presence)
	}
	otherBody := presenceBody(t, map[string]any{"seat": "black"})
	response = onlineHTTPRequest(handler, http.MethodPost, "/v1/online/matches/"+matchID+"/presence", authTestOrigin, "", otherHeaders, otherBody)
	if response.Code != http.StatusOK {
		t.Fatalf("the heartbeat of the opponent status=%d body=%s", response.Code, response.Body.String())
	}

	// The keep waiting choice.
	response = onlineHTTPRequest(handler, http.MethodPost, "/v1/online/matches/"+matchID+"/presence/keep-waiting", authTestOrigin, "", headers, body)
	if response.Code != http.StatusOK {
		t.Fatalf("the keep waiting status=%d body=%s", response.Code, response.Body.String())
	}

	// The runner lease of a human seat is refused, because a human seat has
	// no browser runner. The refusal is the contract, not a failure.
	leaseBody := presenceBody(t, map[string]any{
		"schemaVersion": online.ContractsSchemaVersion,
		"action":        "acquire",
		"seat":          "white",
		"runnerId":      "runner-http-01",
		"turnVersion":   1,
		"controlEpoch":  1,
	})
	response = onlineHTTPRequest(handler, http.MethodPost, "/v1/online/matches/"+matchID+"/runner/lease", authTestOrigin, "", headers, leaseBody)
	if response.Code != http.StatusConflict {
		t.Fatalf("the lease of a human seat status=%d body=%s", response.Code, response.Body.String())
	}
	// A participant may never take the lease of the seat of the other
	// participant.
	otherSeatLease := presenceBody(t, map[string]any{
		"schemaVersion": online.ContractsSchemaVersion,
		"action":        "acquire",
		"seat":          "black",
		"runnerId":      "runner-http-02",
		"turnVersion":   1,
		"controlEpoch":  1,
	})
	response = onlineHTTPRequest(handler, http.MethodPost, "/v1/online/matches/"+matchID+"/runner/lease", authTestOrigin, "", headers, otherSeatLease)
	if response.Code != http.StatusNotFound {
		t.Fatalf("the lease of the other seat status=%d body=%s", response.Code, response.Body.String())
	}

	// The claim of a match that never moved is refused, because the claim
	// needs both sides to have moved.
	claimBody := presenceBody(t, map[string]any{
		"schemaVersion":   online.ContractsSchemaVersion,
		"matchId":         matchID,
		"operationId":     "op-presence-http-claim",
		"expectedVersion": 1,
		"seat":            "white",
		"controlEpoch":    1,
	})
	response = onlineHTTPRequest(handler, http.MethodPost, "/v1/online/matches/"+matchID+"/claim", authTestOrigin, "", headers, claimBody)
	if response.Code != http.StatusConflict {
		t.Fatalf("the claim of an unfinished match status=%d body=%s", response.Code, response.Body.String())
	}
}

// TestOnlinePresenceHTTPAuthorizesTheGuestParticipant covers the guest seat
// credential of the presence routes.
//
// A guest may act for its own seat and never for the seat of the other
// participant.
func TestOnlinePresenceHTTPAuthorizesTheGuestParticipant(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	handler := presenceHTTPFixture(t, fixture)
	const matchID = "match-presence-http-guest"
	issued := createGuestMatch(t, fixture, matchID)
	guestHeaders := map[string]string{"X-Guest-Seat-Token": issued.Credential.Secret}

	// The guest reads the presence view of its own match.
	response := onlineHTTPRequest(handler, http.MethodGet, "/v1/online/matches/"+matchID+"/presence", authTestOrigin, "", guestHeaders, "")
	if response.Code != http.StatusOK {
		t.Fatalf("the guest presence view status=%d body=%s", response.Code, response.Body.String())
	}
	// The guest reports in for its own seat.
	body := presenceBody(t, map[string]any{"seat": "white"})
	response = onlineHTTPRequest(handler, http.MethodPost, "/v1/online/matches/"+matchID+"/presence", authTestOrigin, "", guestHeaders, body)
	if response.Code != http.StatusOK {
		t.Fatalf("the guest heartbeat status=%d body=%s", response.Code, response.Body.String())
	}
	// The guest may never act for the seat of the other participant.
	response = onlineHTTPRequest(handler, http.MethodPost, "/v1/online/matches/"+matchID+"/presence", authTestOrigin, "", guestHeaders, presenceBody(t, map[string]any{"seat": "black"}))
	if response.Code != http.StatusNotFound {
		t.Fatalf("the guest heartbeat for the other seat status=%d body=%s", response.Code, response.Body.String())
	}
	// The guest may not claim a win for the other participant either.
	claimBody := presenceBody(t, map[string]any{
		"schemaVersion":   online.ContractsSchemaVersion,
		"matchId":         matchID,
		"operationId":     "op-presence-http-guest-claim",
		"expectedVersion": 1,
		"seat":            "black",
		"controlEpoch":    1,
	})
	response = onlineHTTPRequest(handler, http.MethodPost, "/v1/online/matches/"+matchID+"/claim", authTestOrigin, "", guestHeaders, claimBody)
	if response.Code != http.StatusNotFound {
		t.Fatalf("the guest claim for the other seat status=%d body=%s", response.Code, response.Body.String())
	}
	// The guest may claim for its own seat, and the claim is refused because
	// the match never moved.
	ownClaim := presenceBody(t, map[string]any{
		"schemaVersion":   online.ContractsSchemaVersion,
		"matchId":         matchID,
		"operationId":     "op-presence-http-guest-own-claim",
		"expectedVersion": 1,
		"seat":            "white",
		"controlEpoch":    1,
	})
	response = onlineHTTPRequest(handler, http.MethodPost, "/v1/online/matches/"+matchID+"/claim", authTestOrigin, "", guestHeaders, ownClaim)
	if response.Code != http.StatusConflict {
		t.Fatalf("the guest claim for its own seat status=%d body=%s", response.Code, response.Body.String())
	}
}

// TestOnlinePresenceHTTPRefusesAnInvalidCredential covers the negative cases
// of the routes.
//
// A missing credential, a foreign origin and a credential of a participant
// that is not in the match are all refused, and a refusal never reaches the
// state of the match.
func TestOnlinePresenceHTTPRefusesAnInvalidCredential(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	handler := presenceHTTPFixture(t, fixture)
	ctx := accountContext("user_a", "session-alice")
	const matchID = "match-presence-http-refused"
	if _, err := fixture.service.Execute(ctx, online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_a"}, guestMatchCommand(matchID, "op-create-"+matchID)); err != nil {
		t.Fatalf("create the match: %v", err)
	}
	body := presenceBody(t, map[string]any{"seat": "black"})

	// No credential at all.
	response := onlineHTTPRequest(handler, http.MethodPost, "/v1/online/matches/"+matchID+"/presence", authTestOrigin, "", nil, body)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("the heartbeat without a credential status=%d body=%s", response.Code, response.Body.String())
	}
	// A foreign origin.
	token := signSession(t, fixture.key, "user_a", "session-alice", time.Now().Add(time.Hour))
	response = onlineHTTPRequest(handler, http.MethodPost, "/v1/online/matches/"+matchID+"/presence", "https://foreign.example", "", map[string]string{"Authorization": "Bearer " + token}, body)
	if response.Code != http.StatusForbidden {
		t.Fatalf("the heartbeat from a foreign origin status=%d body=%s", response.Code, response.Body.String())
	}
	// A credential of a participant that is not in the match.
	foreign := signSession(t, fixture.key, "user_outsider", "session-outsider", time.Now().Add(time.Hour))
	response = onlineHTTPRequest(handler, http.MethodPost, "/v1/online/matches/"+matchID+"/presence", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + foreign}, body)
	if response.Code != http.StatusNotFound {
		t.Fatalf("the heartbeat of an outsider status=%d body=%s", response.Code, response.Body.String())
	}
	// The presence of a match that does not exist.
	response = onlineHTTPRequest(handler, http.MethodGet, "/v1/online/matches/match-presence-http-absent/presence", authTestOrigin, "", map[string]string{"Authorization": "Bearer " + token}, "")
	if response.Code != http.StatusNotFound {
		t.Fatalf("the presence view of an absent match status=%d body=%s", response.Code, response.Body.String())
	}
}
