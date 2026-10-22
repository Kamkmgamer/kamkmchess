package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/invite"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

// The friend routes.
//
// They are mounted under the online surface and are independent of the
// participant command routes: an invitation is created, previewed, accepted,
// cancelled and rematched through their own routes, and the canonical match
// is created by the trusted allocation seam of backend/online.
//
// A friend route accepts an account session, a guest seat credential, or no
// credential at all. A guest may create an invitation and a guest may join one
// by link, so the surface never requires a signed-in account for the guest
// path. The public queue is a different surface and does require an account.
//
// The owner token of an invitation travels in the dedicated private header of
// the surface. It never travels in a URL, a query string or a request body,
// and it is never logged.

// OwnerTokenHeader carries the revocable owner secret of an invitation.
//
// It is a dedicated private header, so the owner token can never be mistaken
// for an account session or for a guest seat credential, and so the private
// single-owner sync API keeps its narrower header set.
const OwnerTokenHeader = "X-Online-Owner-Token"

// FriendsService is the invitation and rematch service the routes call.
type FriendsService interface {
	Create(ctx context.Context, request invite.CreateRequest) (invite.Created, error)
	Get(ctx context.Context, request invite.ViewRequest) (invite.Invitation, error)
	Accept(ctx context.Context, request invite.AcceptRequest) (invite.Accepted, error)
	Cancel(ctx context.Context, request invite.CancelRequest) (invite.Invitation, error)
	SeatCredential(ctx context.Context, request invite.SeatCredentialRequest) (invite.SeatCredentialResult, error)
	RematchSeatCredential(ctx context.Context, request invite.RematchSeatCredentialRequest) (invite.SeatCredentialResult, error)
	ProposeRematch(ctx context.Context, request invite.RematchRequest) (invite.Rematch, error)
	AcceptRematch(ctx context.Context, request invite.AcceptRematchRequest) (invite.RematchResult, error)
	PendingRematch(ctx context.Context, matchID string, participant online.ParticipantRef) (invite.Rematch, bool, error)
}

// FriendsOptions configures the friend routes.
type FriendsOptions struct {
	// AllowedOrigins are the browser origins allowed to use the friend
	// surface.
	AllowedOrigins []string
	// LabelResolver returns the public label of an account. A nil resolver
	// labels every account as a guest.
	LabelResolver PublicLabelResolver
	// Cohort narrows the accounts that may use the friend surface. A nil
	// authorizer admits every account.
	//
	// The cohort is an allowlist of accounts. It never excludes a guest: a
	// guest has to be able to create a friend link and to accept an
	// invitation that was issued while friend play was enabled.
	Cohort AccountAuthorizer
}

// PublicLabelResolver returns the public label of an account.
type PublicLabelResolver interface {
	PublicLabel(ctx context.Context, accountID string) (string, error)
}

// invitationOwnership is the optional capability of a friends service that can
// prove the ownership of an invitation without changing it.
//
// The capability is optional, and a service without it fails closed: an
// account that the cohort excludes never reaches an owner-scoped route, so a
// composition without the proof cannot widen the surface.
type invitationOwnership interface {
	// OwnsInvitation reports whether the caller owns the invitation.
	OwnsInvitation(ctx context.Context, invitationID, ownerToken string, owner *invite.Identity) bool
}

// The invitation service of the composition proves the ownership of an
// invitation, so the owner recovery of a narrowed cohort works with the
// service of the tree and not only with a double.
var _ invitationOwnership = (*invite.Service)(nil)

type friendsAPI struct {
	friends FriendsService
	online  OnlineService
	auth    participantAuthenticator
	options FriendsOptions
}

// NewFriends returns the friend invitation and rematch routes.
//
// The routes are:
//
//	POST /v1/online/invitations                                  create an invitation
//	GET  /v1/online/invitations/{invitationID}                    the link preview
//	POST /v1/online/invitations/{invitationID}/accept             accept an invitation
//	POST /v1/online/invitations/{invitationID}/cancel             cancel an invitation
//	POST /v1/online/invitations/{invitationID}/seat-credential    the inviter's guest seat credential
//	POST /v1/online/rematches                                    propose a rematch
//	POST /v1/online/rematches/{rematchID}/accept                 accept a rematch
//	GET  /v1/online/matches/{matchID}/rematch                    the pending rematch offer
//
// The invitation identifier is the shareable secret of the link. It is a
// bearer secret for one acceptance and never a credential.
func NewFriends(friends FriendsService, onlineService OnlineService, authenticator OnlineAuthenticator, options FriendsOptions) http.Handler {
	api := &friendsAPI{
		friends: friends,
		online:  onlineService,
		auth:    newParticipantAuthenticator(authenticator, OnlineOptions{AllowedOrigins: options.AllowedOrigins}),
		options: options,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/online/invitations", api.createInvitation)
	mux.HandleFunc("GET /v1/online/invitations/{invitationID}", api.previewInvitation)
	mux.HandleFunc("POST /v1/online/invitations/{invitationID}/accept", api.acceptInvitation)
	mux.HandleFunc("POST /v1/online/invitations/{invitationID}/cancel", api.cancelInvitation)
	mux.HandleFunc("POST /v1/online/invitations/{invitationID}/seat-credential", api.seatCredential)
	mux.HandleFunc("POST /v1/online/rematches", api.proposeRematch)
	mux.HandleFunc("POST /v1/online/rematches/{rematchID}/accept", api.acceptRematch)
	mux.HandleFunc("POST /v1/online/rematches/{rematchID}/seat-credential", api.rematchSeatCredential)
	mux.HandleFunc("GET /v1/online/matches/{matchID}/rematch", api.pendingRematch)
	return mux
}

// invitationResponse is the allowlisted public view of an invitation.
//
// It carries the inviter's public name or Guest, the inviter's seat, the
// clock and the custom position. It carries no participant reference, no
// owner token, no credential and no pairing.
type invitationResponse struct {
	SchemaVersion  int                `json:"schemaVersion"`
	InvitationID   string             `json:"invitationId"`
	Kind           string             `json:"kind"`
	Status         string             `json:"status"`
	InviterLabel   string             `json:"inviterLabel"`
	InviterSeat    online.Seat        `json:"inviterSeat"`
	InviterControl online.SeatControl `json:"inviterControl"`
	TimeControl    online.TimeControl `json:"timeControl"`
	StartingFEN    *string            `json:"startingFen"`
	ExpiresAt      time.Time          `json:"expiresAt"`
	CreatedAt      time.Time          `json:"createdAt"`
	ConsumedAt     *time.Time         `json:"consumedAt"`
	CancelledAt    *time.Time         `json:"cancelledAt"`
	MatchID        *string            `json:"matchId"`
}

// guestCredentialResponse is the private credential of a guest seat.
//
// The plaintext token exists only in this answer. It is never stored, logged
// or published.
type guestCredentialResponse struct {
	GuestID   string      `json:"guestId"`
	MatchID   string      `json:"matchId"`
	Seat      online.Seat `json:"seat"`
	Token     string      `json:"token"`
	ExpiresAt time.Time   `json:"expiresAt"`
}

type createInvitationRequest struct {
	SchemaVersion int    `json:"schemaVersion"`
	Kind          string `json:"kind"`
	// RecipientUsername names the account of a challenge by its public name.
	//
	// A public name is a public identity, so it may travel in a request. The
	// account subject of the recipient never does: the service resolves the
	// name itself and keeps the subject private.
	RecipientUsername string             `json:"recipientUsername"`
	Seat              online.Seat        `json:"seat"`
	TimeControl       online.TimeControl `json:"timeControl"`
	StartingFEN       string             `json:"startingFen"`
	Control           online.SeatControl `json:"control"`
}

type createInvitationResponse struct {
	SchemaVersion int                `json:"schemaVersion"`
	Invitation    invitationResponse `json:"invitation"`
	OwnerToken    string             `json:"ownerToken"`
}

type acceptInvitationRequest struct {
	SchemaVersion int                `json:"schemaVersion"`
	AcceptanceKey string             `json:"acceptanceKey"`
	Control       online.SeatControl `json:"control"`
	// RotateCredential replaces a live guest seat credential of the seat.
	// The browser asks for the rotation when it holds no working
	// credential, for example after a lost answer.
	RotateCredential bool `json:"rotateCredential"`
}

type acceptInvitationResponse struct {
	SchemaVersion   int                      `json:"schemaVersion"`
	Match           onlineMatchResponse      `json:"match"`
	Seat            online.Seat              `json:"seat"`
	AcceptanceID    string                   `json:"acceptanceId"`
	GuestCredential *guestCredentialResponse `json:"guestCredential"`
}

type cancelInvitationRequest struct {
	SchemaVersion int `json:"schemaVersion"`
}

type seatCredentialRequest struct {
	SchemaVersion int `json:"schemaVersion"`
}

type seatCredentialResponse struct {
	SchemaVersion   int                      `json:"schemaVersion"`
	MatchID         string                   `json:"matchId"`
	Seat            online.Seat              `json:"seat"`
	GuestCredential *guestCredentialResponse `json:"guestCredential"`
}

type proposeRematchRequest struct {
	SchemaVersion int                 `json:"schemaVersion"`
	MatchID       string              `json:"matchId"`
	TimeControl   *online.TimeControl `json:"timeControl"`
	StartingFEN   *string             `json:"startingFen"`
}

type rematchResponse struct {
	SchemaVersion int         `json:"schemaVersion"`
	Rematch       rematchView `json:"rematch"`
}

type acceptRematchResponse struct {
	SchemaVersion   int                      `json:"schemaVersion"`
	Rematch         rematchView              `json:"rematch"`
	Match           onlineMatchResponse      `json:"match"`
	Seat            online.Seat              `json:"seat"`
	GuestCredential *guestCredentialResponse `json:"guestCredential"`
}

// rematchView is the allowlisted public view of one rematch offer.
type rematchView struct {
	RematchID     string             `json:"rematchId"`
	MatchID       string             `json:"matchId"`
	Status        string             `json:"status"`
	ProposerLabel string             `json:"proposerLabel"`
	ProposerSeat  online.Seat        `json:"proposerSeat"`
	TimeControl   online.TimeControl `json:"timeControl"`
	StartingFEN   *string            `json:"startingFen"`
	ExpiresAt     time.Time          `json:"expiresAt"`
	NewMatchID    *string            `json:"newMatchId"`
	// ProposedByViewer tells the caller whether the caller proposed the
	// offer.
	//
	// It is a fact about the caller alone: the stored identity of the
	// proposer is never published, and the opponent of the proposer learns
	// nothing about it beyond the fact that the offer is not its own. The
	// proposal is already the consent of the proposer, so only the opponent
	// may accept the offer.
	ProposedByViewer bool `json:"proposedByViewer"`
}

// createInvitation creates one shareable link or one named challenge.
//
// The inviter may be a signed-in account, a guest that owns a seat, or an
// anonymous guest. An anonymous inviter receives an owner token that is its
// only recoverable ownership of the invitation.
func (a *friendsAPI) createInvitation(w http.ResponseWriter, r *http.Request) {
	principal, authenticated, ok := a.caller(w, r, true)
	if !ok {
		return
	}
	var body createInvitationRequest
	if !decodeBody(w, r, &body) {
		return
	}
	if body.SchemaVersion != online.ContractsSchemaVersion {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	inviter, err := a.identity(r.Context(), principal, authenticated)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	created, err := a.friends.Create(r.Context(), invite.CreateRequest{
		Kind:              invite.Kind(body.Kind),
		Inviter:           inviter,
		RecipientUsername: body.RecipientUsername,
		Seat:              body.Seat,
		TimeControl:       body.TimeControl,
		StartingFEN:       body.StartingFEN,
		Control:           body.Control,
	})
	if err != nil {
		writeInviteError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, createInvitationResponse{
		SchemaVersion: online.ContractsSchemaVersion,
		Invitation:    toInvitationResponse(created.Invitation),
		OwnerToken:    created.OwnerToken,
	})
}

// previewInvitation answers the link preview.
//
// The preview shows the inviter's public name or Guest, the inviter's seat,
// the clock and the custom position. It never invents a pairing.
//
// A named challenge is private. Its named recipient may read it, and its
// inviter may read it with the owner token of the invitation. Every other
// caller is answered exactly like an unknown invitation, so the status of a
// challenge is never public.
func (a *friendsAPI) previewInvitation(w http.ResponseWriter, r *http.Request) {
	principal, authenticated, ok := a.auth.maybe(w, r, false)
	if !ok {
		return
	}
	ownerToken, ok := a.ownerToken(w, r)
	if !ok {
		return
	}
	// The preview is owner-scoped: the inviter reads its own invitation
	// with the owner token, and that proof keeps the inviter able to see
	// the invitation it owns after a cohort narrowed the surface.
	if !a.ownerScoped(w, r, principal, ownerToken, nil) {
		return
	}
	viewer := ""
	if authenticated && principal.Kind == online.ParticipantAccount {
		viewer = principal.Participant.ID
	}
	invitation, err := a.friends.Get(r.Context(), invite.ViewRequest{
		InvitationID:    r.PathValue("invitationID"),
		ViewerAccountID: viewer,
		OwnerToken:      ownerToken,
	})
	if err != nil {
		writeInviteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, invitationResponse{
		SchemaVersion:  online.ContractsSchemaVersion,
		InvitationID:   invitation.InvitationID,
		Kind:           string(invitation.Kind),
		Status:         string(invitation.Status),
		InviterLabel:   invitation.InviterLabel,
		InviterSeat:    invitation.InviterSeat,
		InviterControl: invitation.InviterControl,
		TimeControl:    invitation.TimeControl,
		StartingFEN:    optionalString(invitation.StartingFEN),
		ExpiresAt:      invitation.ExpiresAt,
		CreatedAt:      invitation.CreatedAt,
		ConsumedAt:     invitation.ConsumedAt,
		CancelledAt:    invitation.CancelledAt,
		MatchID:        invitation.MatchID,
	})
}

// acceptInvitation consumes an invitation and answers the live match view.
//
// The answer is an envelope: the match view is the `match` field and it is
// byte-compatible with the participant live view of the online surface.
func (a *friendsAPI) acceptInvitation(w http.ResponseWriter, r *http.Request) {
	principal, authenticated, ok := a.caller(w, r, true)
	if !ok {
		return
	}
	var body acceptInvitationRequest
	if !decodeBody(w, r, &body) {
		return
	}
	if body.SchemaVersion != online.ContractsSchemaVersion {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	acceptor, err := a.identity(r.Context(), principal, authenticated)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	accepted, err := a.friends.Accept(r.Context(), invite.AcceptRequest{
		InvitationID:     r.PathValue("invitationID"),
		AcceptanceKey:    body.AcceptanceKey,
		Acceptor:         acceptor,
		Control:          body.Control,
		Origin:           a.origin(r),
		RotateCredential: body.RotateCredential,
	})
	if err != nil {
		writeInviteError(w, err)
		return
	}
	view, err := a.matchView(r.Context(), principal, authenticated, accepted, a.origin(r))
	if err != nil {
		writeInviteError(w, err)
		return
	}
	response := acceptInvitationResponse{
		SchemaVersion: online.ContractsSchemaVersion,
		Match:         view,
		Seat:          accepted.Seat,
		AcceptanceID:  accepted.AcceptanceID,
	}
	if accepted.GuestCredential != nil {
		response.GuestCredential = toGuestCredentialResponse(*accepted.GuestCredential)
	}
	writeJSON(w, http.StatusOK, response)
}

// cancelInvitation cancels an open invitation.
//
// The owner token travels in the private header of the surface, so it never
// reaches a body, a URL or a log line.
//
// The cancellation is owner-scoped: the inviter withdraws its own
// invitation with the owner token, and that proof keeps the inviter able to
// withdraw an outstanding invitation after a cohort narrowed the surface. A
// closed surface and a narrowed cohort both keep the inviter able to cancel
// the invitation it owns.
func (a *friendsAPI) cancelInvitation(w http.ResponseWriter, r *http.Request) {
	principal, authenticated, ok := a.auth.maybe(w, r, true)
	if !ok {
		return
	}
	ownerToken, ok := a.ownerToken(w, r)
	if !ok {
		return
	}
	// The proof of the ownership names the participant of the caller. The
	// public label is not part of the proof, so the label is not resolved
	// before the cohort answered.
	var owner *invite.Identity
	if authenticated && principal.Kind == online.ParticipantAccount {
		owner = &invite.Identity{Participant: principal.Participant}
	}
	if !a.ownerScoped(w, r, principal, ownerToken, owner) {
		return
	}
	var body cancelInvitationRequest
	if !decodeBody(w, r, &body) {
		return
	}
	if body.SchemaVersion != online.ContractsSchemaVersion {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	var canceller *invite.Identity
	if authenticated {
		identity, err := a.identity(r.Context(), principal, true)
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
			return
		}
		canceller = identity
	}
	invitation, err := a.friends.Cancel(r.Context(), invite.CancelRequest{
		InvitationID: r.PathValue("invitationID"),
		OwnerToken:   ownerToken,
		Canceller:    canceller,
	})
	if err != nil {
		writeInviteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, invitationResponse{
		SchemaVersion:  online.ContractsSchemaVersion,
		InvitationID:   invitation.InvitationID,
		Kind:           string(invitation.Kind),
		Status:         string(invitation.Status),
		InviterLabel:   invitation.InviterLabel,
		InviterSeat:    invitation.InviterSeat,
		InviterControl: invitation.InviterControl,
		TimeControl:    invitation.TimeControl,
		StartingFEN:    optionalString(invitation.StartingFEN),
		ExpiresAt:      invitation.ExpiresAt,
		CreatedAt:      invitation.CreatedAt,
		ConsumedAt:     invitation.ConsumedAt,
		CancelledAt:    invitation.CancelledAt,
		MatchID:        invitation.MatchID,
	})
}

// seatCredential mints the guest seat credential of a guest inviter.
//
// The credential is bound to the created match seat, so it cannot exist
// before the invitee accepted. The mint supersedes an earlier credential of
// the same seat.
//
// The owner token travels in the private header of the surface, so it never
// reaches a body, a URL or a log line.
func (a *friendsAPI) seatCredential(w http.ResponseWriter, r *http.Request) {
	principal, authenticated, ok := a.caller(w, r, true)
	if !ok {
		return
	}
	var body seatCredentialRequest
	if !decodeBody(w, r, &body) {
		return
	}
	if body.SchemaVersion != online.ContractsSchemaVersion {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	ownerToken, ok := a.ownerToken(w, r)
	if !ok {
		return
	}
	// The identity of the caller proves that it may see the invitation. It
	// never authorizes the mint of the credential: the owner token and the
	// inviter alone do that.
	var viewer *invite.Identity
	if authenticated {
		viewer = &invite.Identity{Participant: principal.Participant}
	}
	result, err := a.friends.SeatCredential(r.Context(), invite.SeatCredentialRequest{
		InvitationID: r.PathValue("invitationID"),
		OwnerToken:   ownerToken,
		Origin:       a.origin(r),
		Viewer:       viewer,
	})
	if err != nil {
		writeInviteError(w, err)
		return
	}
	response := seatCredentialResponse{
		SchemaVersion: online.ContractsSchemaVersion,
		MatchID:       result.MatchID,
		Seat:          result.Seat,
	}
	if result.GuestCredential != nil {
		response.GuestCredential = toGuestCredentialResponse(*result.GuestCredential)
	}
	writeJSON(w, http.StatusOK, response)
}

// proposeRematch proposes a new game after a finished match.
func (a *friendsAPI) proposeRematch(w http.ResponseWriter, r *http.Request) {
	principal, authenticated, ok := a.caller(w, r, true)
	if !ok {
		return
	}
	if !authenticated {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body proposeRematchRequest
	if !decodeBody(w, r, &body) {
		return
	}
	if body.SchemaVersion != online.ContractsSchemaVersion {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	label, err := a.label(r.Context(), principal)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	rematch, err := a.friends.ProposeRematch(r.Context(), invite.RematchRequest{
		MatchID:       body.MatchID,
		Proposer:      principal.Participant,
		ProposerLabel: label,
		TimeControl:   body.TimeControl,
		StartingFEN:   body.StartingFEN,
	})
	if err != nil {
		writeInviteError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, rematchResponse{
		SchemaVersion: online.ContractsSchemaVersion,
		Rematch:       toRematchView(rematch, principal.Participant),
	})
}

// acceptRematch accepts a rematch offer and creates the new match.
func (a *friendsAPI) acceptRematch(w http.ResponseWriter, r *http.Request) {
	principal, authenticated, ok := a.caller(w, r, true)
	if !ok {
		return
	}
	if !authenticated {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body struct {
		SchemaVersion int `json:"schemaVersion"`
		// RotateCredential replaces a live guest seat credential of the seat.
		RotateCredential bool `json:"rotateCredential"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if body.SchemaVersion != online.ContractsSchemaVersion {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	result, err := a.friends.AcceptRematch(r.Context(), invite.AcceptRematchRequest{
		RematchID:         r.PathValue("rematchID"),
		Acceptor:          principal.Participant,
		Origin:            a.origin(r),
		RotateCredential:  body.RotateCredential,
		CredentialMatchID: principal.MatchID,
	})
	if err != nil {
		writeInviteError(w, err)
		return
	}
	view, err := a.matchView(r.Context(), principal, authenticated, invite.Accepted{MatchID: result.MatchID, Seat: result.Seat, GuestCredential: result.GuestCredential}, a.origin(r))
	if err != nil {
		writeInviteError(w, err)
		return
	}
	response := acceptRematchResponse{
		SchemaVersion: online.ContractsSchemaVersion,
		Rematch:       toRematchView(result.Rematch, principal.Participant),
		Match:         view,
		Seat:          result.Seat,
	}
	if result.GuestCredential != nil {
		response.GuestCredential = toGuestCredentialResponse(*result.GuestCredential)
	}
	writeJSON(w, http.StatusOK, response)
}

// rematchSeatCredential mints the guest seat credential of the proposer of an
// accepted rematch.
//
// A rematch is a new match, so the credential of the finished match cannot
// authorize the new seat.
func (a *friendsAPI) rematchSeatCredential(w http.ResponseWriter, r *http.Request) {
	principal, authenticated, ok := a.caller(w, r, true)
	if !ok {
		return
	}
	if !authenticated {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if body.SchemaVersion != online.ContractsSchemaVersion {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	result, err := a.friends.RematchSeatCredential(r.Context(), invite.RematchSeatCredentialRequest{
		RematchID: r.PathValue("rematchID"),
		Proposer:  principal.Participant,
		Origin:    a.origin(r),
	})
	if err != nil {
		writeInviteError(w, err)
		return
	}
	response := seatCredentialResponse{
		SchemaVersion: online.ContractsSchemaVersion,
		MatchID:       result.MatchID,
		Seat:          result.Seat,
	}
	if result.GuestCredential != nil {
		response.GuestCredential = toGuestCredentialResponse(*result.GuestCredential)
	}
	writeJSON(w, http.StatusOK, response)
}

// pendingRematch answers the pending rematch offer of a finished match.
func (a *friendsAPI) pendingRematch(w http.ResponseWriter, r *http.Request) {
	principal, authenticated, ok := a.caller(w, r, false)
	if !ok {
		return
	}
	if !authenticated {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	rematch, found, err := a.friends.PendingRematch(r.Context(), r.PathValue("matchID"), principal.Participant)
	if err != nil {
		writeInviteError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	writeJSON(w, http.StatusOK, rematchResponse{
		SchemaVersion: online.ContractsSchemaVersion,
		Rematch:       toRematchView(rematch, principal.Participant),
	})
}

// caller authenticates the request and checks the account cohort.
//
// The cohort is checked before the request reaches the service, so an account
// that is not allowed never learns whether an invitation exists. A guest is
// never refused by the cohort.
func (a *friendsAPI) caller(w http.ResponseWriter, r *http.Request, mutation bool) (onlineauth.Principal, bool, bool) {
	principal, authenticated, ok := a.auth.maybe(w, r, mutation)
	if !ok {
		return onlineauth.Principal{}, false, false
	}
	if !allowParticipant(w, r, a.options.Cohort, principal) {
		return onlineauth.Principal{}, false, false
	}
	return principal, authenticated, true
}

// ownerScoped reports whether a request of an owner-scoped route may use the
// surface.
//
// The cohort narrows the account access of the surface. An account that the
// cohort excludes may not create an invitation, may not accept one, and may
// not read the state of one.
//
// The owner of an invitation is the one narrow exception, and the exception
// exists because a closed surface still has to let the inviter withdraw an
// outstanding invitation. The owner token of the invitation is the proof of
// the ownership, so the inviter keeps the preview and the cancellation of
// the invitation it owns after a cohort narrowed the surface.
//
// The exception is narrow in three ways:
//
//   - without the proof the answer is the ordinary refusal of the cohort, and
//     the service is never consulted, so the refusal cannot reveal whether an
//     invitation exists,
//   - a proof that fails is answered exactly like an unknown invitation, so a
//     wrong owner token is indistinguishable from an invitation that was
//     never issued,
//   - the proof covers the invitation of the request and nothing else, so it
//     never widens the access to another invitation, to a challenge of
//     somebody else, or to the creation of an invitation.
func (a *friendsAPI) ownerScoped(w http.ResponseWriter, r *http.Request, principal onlineauth.Principal, ownerToken string, owner *invite.Identity) bool {
	allowed, err := participantAllowed(r.Context(), a.options.Cohort, principal)
	if err != nil {
		// An authorizer that cannot answer fails closed.
		writeError(w, http.StatusForbidden, "not_authorized")
		return false
	}
	if allowed {
		return true
	}
	if ownerToken == "" && owner == nil {
		writeError(w, http.StatusForbidden, "not_authorized")
		return false
	}
	prover, ok := a.friends.(invitationOwnership)
	if !ok {
		// A service that cannot prove the ownership fails closed.
		writeError(w, http.StatusForbidden, "not_authorized")
		return false
	}
	if !prover.OwnsInvitation(r.Context(), r.PathValue("invitationID"), ownerToken, owner) {
		writeError(w, http.StatusNotFound, "not_found")
		return false
	}
	return true
}

// identity returns the participant identity of a request.
//
// An unauthenticated request is an anonymous guest. The inviter and the
// invitee may both be guests, so the surface never demands an account.
func (a *friendsAPI) identity(ctx context.Context, principal onlineauth.Principal, authenticated bool) (*invite.Identity, error) {
	if !authenticated {
		return nil, nil
	}
	label := invite.GuestLabel
	if principal.Kind == online.ParticipantAccount {
		resolved, err := a.label(ctx, principal)
		if err != nil {
			return nil, err
		}
		label = resolved
	}
	return &invite.Identity{Participant: principal.Participant, PublicLabel: label}, nil
}

// label returns the public label of an authenticated principal.
//
// An account without a resolved public name keeps the neutral Player label.
// A guest keeps the Guest label. The service never publishes an email
// address, a legal name or an authentication identifier as a label.
func (a *friendsAPI) label(ctx context.Context, principal onlineauth.Principal) (string, error) {
	if principal.Kind != online.ParticipantAccount {
		return invite.GuestLabel, nil
	}
	if a.options.LabelResolver == nil {
		return "Player", nil
	}
	label, err := a.options.LabelResolver.PublicLabel(ctx, principal.Participant.ID)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(label) == "" {
		return "Player", nil
	}
	return label, nil
}

// matchView reads the participant live view of the created match.
//
// A guest acceptor has no session yet, so the view is read with the guest
// identity of the freshly minted seat credential.
func (a *friendsAPI) matchView(ctx context.Context, principal onlineauth.Principal, authenticated bool, accepted invite.Accepted, origin string) (onlineMatchResponse, error) {
	actor := principal
	if accepted.GuestCredential != nil {
		actor = guestPrincipal(accepted.GuestCredential, origin)
	}
	if !authenticated && actor.Participant.ID == "" {
		return onlineMatchResponse{}, invite.ErrNotAuthorized
	}
	// The reader re-checks the credential of the participant, so the
	// verified identity travels with the request.
	readCtx := onlineauth.WithPrincipal(ctx, actor)
	match, err := a.online.GetMatchForParticipant(readCtx, accepted.MatchID, actor.Participant)
	if err != nil {
		return onlineMatchResponse{}, err
	}
	return toOnlineMatch(match, actor), nil
}

// guestPrincipal builds the participant identity of a freshly minted guest
// seat credential.
//
// The identity is scoped to the match and the seat of the credential, exactly
// like the credential itself.
func guestPrincipal(credential *invite.GuestCredential, origin string) onlineauth.Principal {
	return onlineauth.Principal{
		Kind:         online.ParticipantGuest,
		Subject:      credential.GuestID,
		Participant:  online.ParticipantRef{Kind: online.ParticipantGuest, ID: credential.GuestID},
		CredentialID: credential.CredentialID,
		MatchID:      credential.MatchID,
		Seat:         credential.Seat,
		Origin:       origin,
		ExpiresAt:    credential.ExpiresAt,
	}
}

// origin returns the origin of a request.
//
// The origin scopes a guest seat credential. A request without an explicit
// origin never reaches a mutation, so the value is empty only for a read.
func (a *friendsAPI) origin(r *http.Request) string {
	origins := r.Header.Values("Origin")
	if len(origins) == 1 {
		return strings.TrimSpace(origins[0])
	}
	return ""
}

// ownerToken returns the owner token of a request.
//
// The token travels in the dedicated private header of the surface. A request
// that carries the header twice is refused, so the server never has to
// choose which of two tokens wins.
func (a *friendsAPI) ownerToken(w http.ResponseWriter, r *http.Request) (string, bool) {
	values := r.Header.Values(OwnerTokenHeader)
	if len(values) > 1 {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return "", false
	}
	if len(values) == 0 {
		return "", true
	}
	return strings.TrimSpace(values[0]), true
}

// toInvitationResponse maps an invitation to its public view.
func toInvitationResponse(invitation invite.Invitation) invitationResponse {
	return invitationResponse{
		SchemaVersion:  online.ContractsSchemaVersion,
		InvitationID:   invitation.InvitationID,
		Kind:           string(invitation.Kind),
		Status:         string(invitation.Status),
		InviterLabel:   invitation.InviterLabel,
		InviterSeat:    invitation.InviterSeat,
		InviterControl: invitation.InviterControl,
		TimeControl:    invitation.TimeControl,
		StartingFEN:    optionalString(invitation.StartingFEN),
		ExpiresAt:      invitation.ExpiresAt,
		CreatedAt:      invitation.CreatedAt,
		ConsumedAt:     invitation.ConsumedAt,
		CancelledAt:    invitation.CancelledAt,
		MatchID:        invitation.MatchID,
	}
}

// toRematchView maps a rematch offer to its public view.
//
// The viewer is the caller of the request. The view tells the caller whether
// the caller proposed the offer, and it publishes no identity of the proposer.
func toRematchView(rematch invite.Rematch, viewer online.ParticipantRef) rematchView {
	return rematchView{
		RematchID:         rematch.RematchID,
		MatchID:           rematch.MatchID,
		Status:            string(rematch.Status),
		ProposerLabel:     rematch.ProposerLabel,
		ProposerSeat:      rematch.ProposerSeat,
		TimeControl:       rematch.TimeControl,
		StartingFEN:       optionalString(rematch.StartingFEN),
		ExpiresAt:         rematch.ExpiresAt,
		NewMatchID:        rematch.NewMatchID,
		ProposedByViewer:  rematch.ProposedBy(viewer),
	}
}

// toGuestCredentialResponse maps a guest credential to its private answer.
func toGuestCredentialResponse(credential invite.GuestCredential) *guestCredentialResponse {
	return &guestCredentialResponse{
		GuestID:   credential.GuestID,
		MatchID:   credential.MatchID,
		Seat:      credential.Seat,
		Token:     credential.Token,
		ExpiresAt: credential.ExpiresAt,
	}
}

// optionalString maps an empty value to a null pointer.
func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// writeInviteError maps an invitation failure onto a status.
//
// An unknown invitation, a cancelled invitation and an invitation that is not
// visible to the caller share one status, so a caller cannot learn whether a
// named challenge exists.
//
// An expired invitation has its own status and its own code, so the browser
// can tell the invitee that the link expired instead of reporting a generic
// conflict.
func writeInviteError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, invite.ErrNotFound), errors.Is(err, invite.ErrRecipientNotFound):
		writeError(w, http.StatusNotFound, "not_found")
	case errors.Is(err, invite.ErrNotAuthorized):
		writeError(w, http.StatusForbidden, "not_authorized")
	case errors.Is(err, invite.ErrRemoved):
		// A removed participant may not name a new personal row. The
		// browser sees the same refusal as an unauthorized caller, so the
		// error vocabulary of the surface does not change.
		writeError(w, http.StatusForbidden, "not_authorized")
	case errors.Is(err, invite.ErrDisabled):
		// The friend surface is closed. The refusal is the rollback
		// behaviour of the switch: it stops new creations and it never
		// invalidates an invitation that was issued while the surface was
		// open.
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
	case errors.Is(err, invite.ErrInvalidContract), errors.Is(err, invite.ErrInvalidArgument):
		writeError(w, http.StatusBadRequest, "invalid_request")
	case errors.Is(err, invite.ErrExpired):
		writeError(w, http.StatusGone, "expired")
	case errors.Is(err, invite.ErrConflict),
		errors.Is(err, invite.ErrAlreadyConsumed):
		writeError(w, http.StatusConflict, "conflict")
	case errors.Is(err, invite.ErrUnavailable):
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
	case errors.Is(err, online.ErrNotAuthorized), errors.Is(err, online.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found")
	case errors.Is(err, online.ErrInvalidContract), errors.Is(err, online.ErrInvalidArgument):
		writeError(w, http.StatusBadRequest, "invalid_request")
	case errors.Is(err, online.ErrConflict), errors.Is(err, online.ErrAlreadyExists):
		writeError(w, http.StatusConflict, "conflict")
	default:
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
	}
}

// jsonRaw is a helper for answers that carry an already encoded body.
func jsonRaw(value any) json.RawMessage {
	raw, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return raw
}
