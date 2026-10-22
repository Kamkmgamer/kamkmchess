package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The regressions of this file cover the public model label of a friend
// invitation.
//
// A declared model label is a private routing identity until its owner
// chooses a public label for it. The preview of a link is unauthenticated, so
// the label that may be published is resolved before the invitation is
// stored and before any answer carries it.

// friendAccountRequest sends one request with an account session.
func friendAccountRequest(t *testing.T, handler http.Handler, method, path, accountToken, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Origin", friendOrigin)
	if accountToken != "" {
		request.Header.Set("Authorization", "Bearer "+accountToken)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// friendControlLabel reads the model label of a control of an answer.
func friendControlLabel(t *testing.T, body []byte, path string) string {
	t.Helper()
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		t.Fatal(err)
	}
	current := value
	for _, part := range strings.Split(path, ".") {
		object, ok := current.(map[string]any)
		if !ok {
			t.Fatalf("the answer has no %q", path)
		}
		current, ok = object[part]
		if !ok {
			t.Fatalf("the answer has no %q", path)
		}
	}
	label, ok := current.(string)
	if !ok {
		return ""
	}
	return label
}

// friendSeatLabels reads the model labels of the seats of a match view.
func friendSeatLabels(t *testing.T, body []byte) map[string]string {
	t.Helper()
	var value struct {
		Match struct {
			Seats []struct {
				Seat    string `json:"seat"`
				Control struct {
					ModelLabel *string `json:"modelLabel"`
				} `json:"control"`
			} `json:"seats"`
		} `json:"match"`
	}
	if err := json.Unmarshal(body, &value); err != nil {
		t.Fatal(err)
	}
	labels := map[string]string{}
	for _, seat := range value.Match.Seats {
		label := ""
		if seat.Control.ModelLabel != nil {
			label = *seat.Control.ModelLabel
		}
		labels[seat.Seat] = label
	}
	return labels
}

// TestPostgresFriendNeverPublishesAPrivateRoutingIdentity covers the public
// model label of the friend surface.
//
// The resolution is the canonical one of the service: a known public model
// name and a public label the owner registered for their own account are
// kept, and every other declared label becomes the neutral label. The
// private routing identity never reaches a durable row, the public preview
// or an answer.
func TestPostgresFriendNeverPublishesAPrivateRoutingIdentity(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()
	handler, _ := friendGuestHandler(t, fixture)

	const privateLabel = "my-private-route-9f3a2b"
	const neutralLabel = "Custom model"

	// An anonymous guest inviter declares a private routing identity.
	created := friendGuestRequest(t, handler, http.MethodPost, "/v1/online/invitations", "",
		fmt.Sprintf(`{"schemaVersion":2,"kind":"link","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"agent","modelLabel":%q}}`, privateLabel))
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	if strings.Contains(created.Body.String(), privateLabel) {
		t.Fatalf("the creation answer published the private routing identity: %s", created.Body.String())
	}
	invitationID := friendControlLabel(t, created.Body.Bytes(), "invitation.invitationId")
	if label := friendControlLabel(t, created.Body.Bytes(), "invitation.inviterControl.modelLabel"); label != neutralLabel {
		t.Fatalf("the inviter control of the creation answer = %q, want %q", label, neutralLabel)
	}
	// The stored invitation carries the publishable label.
	var stored *string
	if err := fixture.pool.QueryRow(ctx, `SELECT inviter_model_label FROM online_friend_invitations WHERE invitation_id=$1`, invitationID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == nil || *stored != neutralLabel {
		t.Fatalf("the stored inviter model label = %v, want %q", stored, neutralLabel)
	}
	// The unauthenticated preview carries the publishable label.
	preview := friendGuestRequest(t, handler, http.MethodGet, "/v1/online/invitations/"+invitationID, "", "")
	if preview.Code != http.StatusOK {
		t.Fatalf("preview status=%d body=%s", preview.Code, preview.Body.String())
	}
	if strings.Contains(preview.Body.String(), privateLabel) {
		t.Fatalf("the preview published the private routing identity: %s", preview.Body.String())
	}
	if label := friendControlLabel(t, preview.Body.Bytes(), "inviterControl.modelLabel"); label != neutralLabel {
		t.Fatalf("the inviter control of the preview = %q, want %q", label, neutralLabel)
	}
	// The acceptance carries the publishable label of both seats, and the
	// private label of the acceptor is not published either.
	accepted := friendGuestRequest(t, handler, http.MethodPost, "/v1/online/invitations/"+invitationID+"/accept", "",
		fmt.Sprintf(`{"schemaVersion":2,"acceptanceKey":"label-acceptance-key-0123456789","control":{"kind":"agent","modelLabel":%q}}`, privateLabel))
	if accepted.Code != http.StatusOK {
		t.Fatalf("accept status=%d body=%s", accepted.Code, accepted.Body.String())
	}
	if strings.Contains(accepted.Body.String(), privateLabel) {
		t.Fatalf("the acceptance published the private routing identity: %s", accepted.Body.String())
	}
	for seat, label := range friendSeatLabels(t, accepted.Body.Bytes()) {
		if label != neutralLabel {
			t.Fatalf("the %s seat of the acceptance = %q, want %q", seat, label, neutralLabel)
		}
	}
	if seats := friendSeatLabels(t, accepted.Body.Bytes()); len(seats) != 2 {
		t.Fatalf("the acceptance carries %d seats", len(seats))
	}
	matchID := friendControlLabel(t, accepted.Body.Bytes(), "match.matchId")
	// The stored acceptance carries the publishable label.
	var acceptanceLabel *string
	if err := fixture.pool.QueryRow(ctx, `SELECT model_label FROM online_invitation_acceptances WHERE invitation_id=$1`, invitationID).Scan(&acceptanceLabel); err != nil {
		t.Fatal(err)
	}
	if acceptanceLabel == nil || *acceptanceLabel != neutralLabel {
		t.Fatalf("the stored acceptance model label = %v, want %q", acceptanceLabel, neutralLabel)
	}
	// The seats of the created match carry the publishable label.
	rows, err := fixture.pool.Query(ctx, `SELECT seat,model_label FROM online_seats WHERE match_id=$1 ORDER BY seat`, matchID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	seats := 0
	for rows.Next() {
		var (
			seat  string
			label *string
		)
		if err = rows.Scan(&seat, &label); err != nil {
			t.Fatal(err)
		}
		if label == nil || *label != neutralLabel {
			t.Fatalf("the %s seat of the match = %v, want %q", seat, label, neutralLabel)
		}
		seats++
	}
	if seats != 2 {
		t.Fatalf("the created match has %d seats", seats)
	}
}

// TestPostgresFriendKeepsARegisteredPublicModelLabel covers the labels that
// the canonical resolution keeps.
//
// A public model name and a public label the owner registered for their own
// account are publishable, so they survive the resolution of the friend
// surface.
func TestPostgresFriendKeepsARegisteredPublicModelLabel(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()
	handler, _ := friendGuestHandler(t, fixture)

	// The owner registers a public label for their own model opponent.
	if _, err := fixture.pool.Exec(ctx, `INSERT INTO online_account_public_labels(label_id,account_id,public_label) VALUES('kl_registeredlabel1','user_inviter','My Bot')`); err != nil {
		t.Fatal(err)
	}
	registered := friendAccountRequest(t, handler, http.MethodPost, "/v1/online/invitations", "user_inviter",
		`{"schemaVersion":2,"kind":"link","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"agent","modelLabel":"My Bot"}}`)
	if registered.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", registered.Code, registered.Body.String())
	}
	if label := friendControlLabel(t, registered.Body.Bytes(), "invitation.inviterControl.modelLabel"); label != "My Bot" {
		t.Fatalf("the registered public label = %q, want My Bot", label)
	}
	registeredID := friendControlLabel(t, registered.Body.Bytes(), "invitation.invitationId")
	preview := friendGuestRequest(t, handler, http.MethodGet, "/v1/online/invitations/"+registeredID, "", "")
	if label := friendControlLabel(t, preview.Body.Bytes(), "inviterControl.modelLabel"); label != "My Bot" {
		t.Fatalf("the registered public label of the preview = %q, want My Bot", label)
	}
	// A known public model name is publishable as well.
	known := friendAccountRequest(t, handler, http.MethodPost, "/v1/online/invitations", "user_inviter",
		`{"schemaVersion":2,"kind":"link","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"agent","modelLabel":"gpt-4o"}}`)
	if known.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", known.Code, known.Body.String())
	}
	if label := friendControlLabel(t, known.Body.Bytes(), "invitation.inviterControl.modelLabel"); label != "GPT-4o" {
		t.Fatalf("the known public model name = %q, want GPT-4o", label)
	}
	// The label of another account is not publishable by this owner.
	foreign := friendAccountRequest(t, handler, http.MethodPost, "/v1/online/invitations", "user_recipient",
		`{"schemaVersion":2,"kind":"link","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"agent","modelLabel":"My Bot"}}`)
	if foreign.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", foreign.Code, foreign.Body.String())
	}
	if label := friendControlLabel(t, foreign.Body.Bytes(), "invitation.inviterControl.modelLabel"); label != "Custom model" {
		t.Fatalf("the label of another owner = %q, want Custom model", label)
	}
	// The browser engine is named by the product, and the friend surface
	// offers no built-in engine seat.
	var engine string
	if err := fixture.pool.QueryRow(ctx, `SELECT online_resolve_public_model_label('account','user_inviter','engine','anything')`).Scan(&engine); err != nil {
		t.Fatal(err)
	}
	if engine != "Stockfish 19 Lite (browser)" {
		t.Fatalf("the engine constant = %q, want Stockfish 19 Lite (browser)", engine)
	}
	engineSeat := friendAccountRequest(t, handler, http.MethodPost, "/v1/online/invitations", "user_inviter",
		`{"schemaVersion":2,"kind":"link","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"engine","modelLabel":"Stockfish"}}`)
	if engineSeat.Code != http.StatusBadRequest {
		t.Fatalf("an engine seat status=%d body=%s", engineSeat.Code, engineSeat.Body.String())
	}
}
