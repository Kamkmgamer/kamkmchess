package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/Kamkmgamer/kamkmchess/backend/onlineswitch"
)

// OnlineSwitches is the runtime switch state the owner route reads and sets.
type OnlineSwitches interface {
	State(ctx context.Context) onlineswitch.State
	Defaults() onlineswitch.State
	Set(ctx context.Context, next onlineswitch.State, by string) (onlineswitch.State, error)
}

type ownerSwitchesAPI struct {
	switches OnlineSwitches
	auth     participantAuthenticator
	owners   map[string]struct{}
}

type ownerSwitchesAnswer struct {
	onlineswitch.State
	// Defaults is what the deployment configures, so the owner can see
	// which surfaces are overridden.
	Defaults onlineswitch.State `json:"defaults"`
}

// NewOwnerSwitches returns the site owner's switch route.
//
//	GET /v1/account/online-switches   the current and the configured state
//	PUT /v1/account/online-switches   {"friends": bool, "queue": bool}
//
// Only a signed-in account named in owners may use it; any other account is
// refused with 403 not_owner, which is also how the site learns to hide the
// controls.
func NewOwnerSwitches(switches OnlineSwitches, authenticator OnlineAuthenticator, options OnlineOptions, owners []string) http.Handler {
	api := &ownerSwitchesAPI{switches: switches, auth: newParticipantAuthenticator(authenticator, options), owners: map[string]struct{}{}}
	for _, owner := range owners {
		if owner = strings.TrimSpace(owner); owner != "" {
			api.owners[owner] = struct{}{}
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/account/online-switches", api.read)
	mux.HandleFunc("PUT /v1/account/online-switches", api.write)
	return mux
}

func (api *ownerSwitchesAPI) owner(w http.ResponseWriter, r *http.Request, mutation bool) (string, bool) {
	principal, ok := api.auth.account(w, r, mutation)
	if !ok {
		return "", false
	}
	if _, owner := api.owners[principal.Subject]; !owner {
		writeError(w, http.StatusForbidden, "not_owner")
		return "", false
	}
	return principal.Subject, true
}

func (api *ownerSwitchesAPI) read(w http.ResponseWriter, r *http.Request) {
	if _, ok := api.owner(w, r, false); !ok {
		return
	}
	writeJSON(w, http.StatusOK, ownerSwitchesAnswer{State: api.switches.State(r.Context()), Defaults: api.switches.Defaults()})
}

func (api *ownerSwitchesAPI) write(w http.ResponseWriter, r *http.Request) {
	owner, ok := api.owner(w, r, true)
	if !ok {
		return
	}
	// Both switches are required, so a short body never closes a surface.
	var body struct {
		Friends *bool `json:"friends"`
		Queue   *bool `json:"queue"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if body.Friends == nil || body.Queue == nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	state, err := api.switches.Set(r.Context(), onlineswitch.State{Friends: *body.Friends, Queue: *body.Queue}, owner)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, ownerSwitchesAnswer{State: state, Defaults: api.switches.Defaults()})
}
