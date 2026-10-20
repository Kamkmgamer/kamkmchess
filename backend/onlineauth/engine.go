package onlineauth

import (
	"context"
	"errors"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// EngineSeatRequest describes the browser engine seat a credential is
// issued for.
//
// The engine seat is its own participant. It is never the requesting
// account: the owner of a fallback game receives a credential that acts for
// the engine seat and for nothing else.
type EngineSeatRequest struct {
	// MatchID is the match the engine seat belongs to.
	MatchID string
	// Seat is the seat the engine plays.
	Seat online.Seat
	// GuestID is the opaque identity recorded for the engine participant.
	GuestID string
	// Origin is the browser origin the credential is scoped to.
	Origin string
	// TTL bounds the credential lifetime. Zero uses the configured default.
	TTL time.Duration
}

// IssueEngineSeatCredential issues a seat-scoped credential for a browser
// engine seat.
//
// The credential is bound to one match and one seat and it is scoped to one
// origin. It authorizes the engine seat and nothing else: it never acts for
// the owner, for another match, or for another seat.
//
// No ownership proof is minted. The engine is not a person, so an account
// link must never be possible for its seat.
//
// The issuance takes the same advisory lock the participant command path and
// the revocation path take, so a rotation is ordered against an accepted
// write and against a seat revocation. A rotation supersedes every earlier
// credential of that seat, so a seat never carries two usable secrets at
// once.
//
// The credential is minted in its own transaction, so the seat row is read
// from committed state. A caller that creates the match and the seat has to
// commit them before it issues the credential. A lost answer is recoverable:
// the owner asks again and receives a fresh credential for the same seat.
func (a *Allocator) IssueEngineSeatCredential(ctx context.Context, request EngineSeatRequest) (IssuedSeatCredential, error) {
	if a == nil || a.service == nil {
		return IssuedSeatCredential{}, errors.New("onlineauth: no allocator is configured")
	}
	if !matchIDShape(request.MatchID) {
		return IssuedSeatCredential{}, errors.New("onlineauth: invalid match id")
	}
	if request.Seat != online.SeatWhite && request.Seat != online.SeatBlack {
		return IssuedSeatCredential{}, errors.New("onlineauth: invalid seat")
	}
	if !participantIDShape(request.GuestID) {
		return IssuedSeatCredential{}, errors.New("onlineauth: invalid engine identity")
	}
	if !originShape(request.Origin) {
		return IssuedSeatCredential{}, errors.New("onlineauth: invalid origin")
	}
	ttl := request.TTL
	if ttl <= 0 {
		ttl = a.service.options.GuestCredentialTTL
	}
	secret, err := newSecret(credentialPrefix)
	if err != nil {
		return IssuedSeatCredential{}, err
	}
	credentialID, err := newIdentifier("kg")
	if err != nil {
		return IssuedSeatCredential{}, err
	}
	issuedAt := a.service.now()
	expiresAt := issuedAt.Add(ttl)
	credential := IssuedSeatCredential{
		CredentialID: credentialID,
		GuestID:      request.GuestID,
		MatchID:      request.MatchID,
		Seat:         request.Seat,
		Origin:       request.Origin,
		Secret:       secret,
		IssuedAt:     issuedAt,
		ExpiresAt:    expiresAt,
	}
	tx, err := a.service.db.Begin(ctx)
	if err != nil {
		return IssuedSeatCredential{}, err
	}
	defer tx.Rollback(ctx)
	if err = lockScope(ctx, tx, seatLockKey(request.MatchID, request.Seat)); err != nil {
		return IssuedSeatCredential{}, err
	}
	// The seat must exist and must still belong to the engine participant.
	// The seat owner is immutable, so a credential never moves a seat.
	owned, err := seatOwnedByGuest(ctx, tx, request.MatchID, request.Seat, request.GuestID)
	if err != nil {
		return IssuedSeatCredential{}, err
	}
	if !owned {
		return IssuedSeatCredential{}, errors.New("onlineauth: the seat does not belong to the engine")
	}
	// A seat has at most one live credential.
	if _, err = tx.Exec(ctx, `UPDATE online_guest_seat_credentials SET superseded_at=clock_timestamp() WHERE match_id=$1 AND seat=$2 AND revoked_at IS NULL AND superseded_at IS NULL`,
		request.MatchID, string(request.Seat)); err != nil {
		return IssuedSeatCredential{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_guest_seat_credentials(credential_id,guest_id,match_id,seat,secret_hash,origin,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		credential.CredentialID, credential.GuestID, credential.MatchID, string(credential.Seat), hashSecret("seat-control", credential.Secret), credential.Origin, credential.IssuedAt, credential.ExpiresAt); err != nil {
		return IssuedSeatCredential{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return IssuedSeatCredential{}, err
	}
	return credential, nil
}
