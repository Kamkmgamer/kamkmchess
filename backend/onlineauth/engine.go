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
	// Rotate asks for an explicit rotation of the credential of the seat.
	//
	// It is the recovery of an owner that lost the answer of the fallback and
	// holds no usable credential. A rotation supersedes the live credential
	// of the seat, so it is never set by a routine retry: a routine retry
	// would revoke the secret the browser still holds.
	Rotate bool
}

// EngineSeatCredentialOutcome is the result of one engine seat credential
// request.
//
// The outcome reports whether a credential was minted at all. An ordinary
// request for a seat that already has a live credential mints nothing and
// supersedes nothing: the secret the browser already holds keeps working, and
// the seat never carries a second live secret.
type EngineSeatCredentialOutcome struct {
	// Issued reports whether this call minted a credential.
	Issued bool
	// Credential is the minted credential. It carries the plaintext secret,
	// and it is the zero value when nothing was minted. A request that minted
	// nothing never carries a secret, so a lost answer is never answered with
	// a secret that was already handed out.
	Credential IssuedSeatCredential
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
// write and against a seat revocation.
//
// The live credential of the seat is read inside that lock, so the decision
// to mint and the write of the credential are one ordered decision. An
// ordinary request never supersedes a live credential: it mints nothing, it
// revokes nothing, and the outcome reports that nothing was minted. The
// secret a browser already holds therefore keeps working, and a second
// routine fallback of the same entry can never revoke the secret the first
// one already delivered.
//
// An explicit rotation supersedes every earlier credential of that seat, so a
// seat never carries two usable secrets at once. The rotation is the recovery
// of an owner that lost the answer of the fallback, and it is the only path
// that revokes a live credential.
//
// The credential is minted in its own transaction, so the seat row is read
// from committed state. A caller that creates the match and the seat has to
// commit them before it issues the credential. A lost answer is recoverable:
// the owner asks again and receives a fresh credential for the same seat.
func (a *Allocator) IssueEngineSeatCredential(ctx context.Context, request EngineSeatRequest) (EngineSeatCredentialOutcome, error) {
	if a == nil || a.service == nil {
		return EngineSeatCredentialOutcome{}, errors.New("onlineauth: no allocator is configured")
	}
	if !matchIDShape(request.MatchID) {
		return EngineSeatCredentialOutcome{}, errors.New("onlineauth: invalid match id")
	}
	if request.Seat != online.SeatWhite && request.Seat != online.SeatBlack {
		return EngineSeatCredentialOutcome{}, errors.New("onlineauth: invalid seat")
	}
	if !participantIDShape(request.GuestID) {
		return EngineSeatCredentialOutcome{}, errors.New("onlineauth: invalid engine identity")
	}
	if !originShape(request.Origin) {
		return EngineSeatCredentialOutcome{}, errors.New("onlineauth: invalid origin")
	}
	tx, err := a.service.db.Begin(ctx)
	if err != nil {
		return EngineSeatCredentialOutcome{}, err
	}
	defer tx.Rollback(ctx)
	if err = lockScope(ctx, tx, seatLockKey(request.MatchID, request.Seat)); err != nil {
		return EngineSeatCredentialOutcome{}, err
	}
	// The seat must exist and must still belong to the engine participant.
	// The seat owner is immutable, so a credential never moves a seat.
	owned, err := seatOwnedByGuest(ctx, tx, request.MatchID, request.Seat, request.GuestID)
	if err != nil {
		return EngineSeatCredentialOutcome{}, err
	}
	if !owned {
		return EngineSeatCredentialOutcome{}, errors.New("onlineauth: the seat does not belong to the engine")
	}
	// The live credential of the seat is read under the seat lock. A caller
	// that read it before it came here would race with a concurrent
	// issuance: two routine fallbacks of one entry would both observe that
	// the seat has no credential, and the second issuance would revoke the
	// secret the first one already handed to a browser.
	live, err := a.service.HasLiveSeatCredential(ctx, tx, request.MatchID, request.Seat)
	if err != nil {
		return EngineSeatCredentialOutcome{}, err
	}
	if live && !request.Rotate {
		// An ordinary issue keeps the live credential. The browser holds a
		// usable secret, so the answer of the caller names the assignment
		// and carries no secret.
		return EngineSeatCredentialOutcome{Issued: false}, nil
	}
	// The secret is minted after the decision to mint it. A request that
	// mints nothing never creates a secret, so no secret is ever generated
	// for a credential that is not stored.
	ttl := request.TTL
	if ttl <= 0 {
		ttl = a.service.options.GuestCredentialTTL
	}
	secret, err := newSecret(credentialPrefix)
	if err != nil {
		return EngineSeatCredentialOutcome{}, err
	}
	credentialID, err := newIdentifier("kg")
	if err != nil {
		return EngineSeatCredentialOutcome{}, err
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
	// A seat has at most one live credential. The rotation supersedes every
	// earlier credential of the seat, so two usable secrets never coexist.
	if _, err = tx.Exec(ctx, `UPDATE online_guest_seat_credentials SET superseded_at=clock_timestamp() WHERE match_id=$1 AND seat=$2 AND revoked_at IS NULL AND superseded_at IS NULL`,
		request.MatchID, string(request.Seat)); err != nil {
		return EngineSeatCredentialOutcome{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_guest_seat_credentials(credential_id,guest_id,match_id,seat,secret_hash,origin,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		credential.CredentialID, credential.GuestID, credential.MatchID, string(credential.Seat), hashSecret("seat-control", credential.Secret), credential.Origin, credential.IssuedAt, credential.ExpiresAt); err != nil {
		return EngineSeatCredentialOutcome{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return EngineSeatCredentialOutcome{}, err
	}
	return EngineSeatCredentialOutcome{Issued: true, Credential: credential}, nil
}
