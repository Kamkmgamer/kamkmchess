package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineswitch"
)

type memorySwitches struct {
	state, defaults onlineswitch.State
	by              string
}

func (m *memorySwitches) State(context.Context) onlineswitch.State { return m.state }
func (m *memorySwitches) Defaults() onlineswitch.State             { return m.defaults }
func (m *memorySwitches) Set(_ context.Context, next onlineswitch.State, by string) (onlineswitch.State, error) {
	m.state, m.by = next, by
	return next, nil
}

func TestOnlySiteOwnersSwitchTheOnlineSurfaces(t *testing.T) {
	switches := &memorySwitches{}
	authenticator := &stubAuthenticator{account: map[string]onlineauth.Principal{
		"owner-token": accountParticipant("user_owner"),
		"other-token": accountParticipant("user_other"),
	}}
	handler := NewOwnerSwitches(switches, authenticator, OnlineOptions{AllowedOrigins: []string{testOrigin}}, []string{" user_owner "})
	as := func(token string) map[string]string { return map[string]string{"Authorization": "Bearer " + token} }

	if response := onlineRequest(t, handler, http.MethodGet, "/v1/account/online-switches", testOrigin, nil, ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("an anonymous read answered %d", response.Code)
	}
	other := onlineRequest(t, handler, http.MethodPut, "/v1/account/online-switches", testOrigin, as("other-token"), `{"friends":true,"queue":true}`)
	if other.Code != http.StatusForbidden || switches.state.Friends {
		t.Fatalf("another account switched the surfaces: %d %s", other.Code, other.Body.String())
	}
	if response := onlineRequest(t, handler, http.MethodPut, "/v1/account/online-switches", testOrigin, as("owner-token"), `{"friends":true}`); response.Code != http.StatusBadRequest {
		t.Fatalf("a partial switch answered %d", response.Code)
	}
	set := onlineRequest(t, handler, http.MethodPut, "/v1/account/online-switches", testOrigin, as("owner-token"), `{"friends":true,"queue":false}`)
	if set.Code != http.StatusOK || !switches.state.Friends || switches.by != "user_owner" {
		t.Fatalf("the owner could not switch: %d %s", set.Code, set.Body.String())
	}
	read := onlineRequest(t, handler, http.MethodGet, "/v1/account/online-switches", testOrigin, as("owner-token"), "")
	var answer map[string]any
	if err := json.Unmarshal(read.Body.Bytes(), &answer); err != nil || answer["friends"] != true || answer["queue"] != false {
		t.Fatalf("the owner read %d %s", read.Code, read.Body.String())
	}
	if defaults, ok := answer["defaults"].(map[string]any); !ok || defaults["friends"] != false {
		t.Fatalf("the answer has no configured defaults: %s", read.Body.String())
	}
}
