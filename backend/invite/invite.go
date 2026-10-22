// Package invite owns friend invitations, one-use link joins, named account
// challenges and mutual rematches for casual online chess.
//
// The package is a trusted server component. It never exposes a participant
// command: an invitation is created, previewed, accepted or cancelled through
// its own routes, and the canonical match is created through the trusted
// allocation seam of backend/online.
//
// Two rules shape the whole package.
//
// An invitation is consumed exactly once. The consumption and the acceptance
// record are written in one transaction, so two concurrent acceptances can
// never both win.
//
// An acceptance is recoverable. The acceptance row owns the seat, the
// declared control, the allocated guest identity and the created match, so a
// retry after a lost answer resumes the same acceptance, returns the same
// match and re-mints the guest seat credential instead of consuming a second
// invitation.
//
// The resume capability is the high entropy acceptance key. It is a bearer
// secret of one accept intent, it is stored only as a hash, and the public
// acceptance identifier is never enough to resume an acceptance. An account
// acceptor is bound to its own acceptance as well, because an account has an
// identity the service can check. A guest acceptor has no other identity to
// bind to, so the key is the whole capability: whoever holds the key can
// resume that acceptance. The key therefore stays secret, it is never
// logged, and the service never returns it.
//
// The consumption of the invitation, the acceptance row, the canonical match
// and the guest seat credential commit in one transaction. A crash can never
// leave a spent invitation without a game, and no sweeper has to look for an
// orphaned acceptance.
//
// A write that names a participant is ordered against the removal of that
// participant. The account scope lock of the online service is taken before
// the row lock of the invitation or of the rematch offer, and the durable
// removal of every participant is rechecked after the lock, so a request
// that was authenticated before the removal never creates a personal row
// after it and never revives a credential of a removed participant.
//
// A participant that the privacy sanitation has replaced with the anonymized
// sentinel is a removed participant as well, and so is a participant of a
// match that carries a row in the removal ledger. The recheck therefore
// never seats a subject that no longer exists.
package invite

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/locks"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/subject"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// InvitationTTL is how long an invitation stays usable. An invitation
	// that was not accepted within twelve hours expires and can never be
	// consumed.
	InvitationTTL = 12 * time.Hour
	// StandardStartingFEN is the standard starting position. A friend game
	// uses it unless the inviter chose a custom position.
	StandardStartingFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
	// GuestLabel is the public label of a participant without a public name.
	GuestLabel = "Guest"
	// anonymizedParticipant is the shared sentinel for a removed subject.
	anonymizedParticipant = subject.AnonymizedID
)

var (
	// ErrInvalidArgument reports a malformed caller value before database
	// work.
	ErrInvalidArgument = errors.New("invite: invalid argument")
	// ErrInvalidContract reports a value that violates the invitation
	// contract.
	ErrInvalidContract = errors.New("invite: invalid contract")
	// ErrNotFound reports an unknown invitation, acceptance or rematch offer.
	ErrNotFound = errors.New("invite: not found")
	// ErrConflict reports a state change the invitation does not allow.
	ErrConflict = errors.New("invite: conflict")
	// ErrNotAuthorized reports a caller that does not own the invitation, and
	// a caller that asks for a named challenge without the account authority
	// that a named challenge requires.
	ErrNotAuthorized = errors.New("invite: not authorized")
	// ErrExpired reports an invitation whose lifetime has passed.
	ErrExpired = errors.New("invite: expired")
	// ErrAlreadyConsumed reports an invitation that somebody else already
	// consumed.
	ErrAlreadyConsumed = errors.New("invite: already consumed")
	// ErrUnavailable reports a missing dependency, such as the private
	// rules process.
	ErrUnavailable = errors.New("invite: unavailable")
	// ErrRemoved reports a participant whose account was removed.
	//
	// A removed participant may not name a new personal row, so the write
	// that would name it is refused. The refusal is ordered against the
	// removal itself, so a request that was authenticated before the
	// removal never creates a row after it.
	ErrRemoved = errors.New("invite: the participant was removed")
	// ErrDisabled reports that the friend surface is closed.
	//
	// The switch is a rollback switch: it stops new creations immediately
	// and it never invalidates an invitation that was issued while the
	// switch was open. A request of a closed surface is therefore only
	// refused when the invitation it names was not issued while the switch
	// was open.
	ErrDisabled = errors.New("invite: the friend surface is closed")
	// ErrRecipientNotFound reports a public name that no account owns.
	//
	// The name of a recipient is a public identity, so an unknown name is
	// refused without revealing whether the account exists.
	ErrRecipientNotFound = errors.New("invite: the recipient was not found")
)

// Kind names the two invitation paths.
type Kind string

const (
	// KindLink is a one-use shareable link. A guest may join it.
	KindLink Kind = "link"
	// KindChallenge is a named challenge for one account. Only the named
	// account may accept it, and only an account may create it.
	KindChallenge Kind = "challenge"
)

// Status is the durable state of an invitation.
type Status string

const (
	// StatusOpen is an invitation that may still be accepted.
	StatusOpen Status = "open"
	// StatusConsumed is an invitation that was accepted.
	StatusConsumed Status = "consumed"
	// StatusCancelled is an invitation the inviter cancelled.
	StatusCancelled Status = "cancelled"
	// StatusExpired is an invitation whose lifetime passed.
	StatusExpired Status = "expired"
)

// RematchStatus is the durable state of a rematch offer.
type RematchStatus string

const (
	// RematchPending is an offer waiting for the opponent.
	RematchPending RematchStatus = "pending"
	// RematchAccepting is an offer the opponent is accepting right now.
	RematchAccepting RematchStatus = "accepting"
	// RematchAccepted is an offer both participants accepted.
	RematchAccepted RematchStatus = "accepted"
	// RematchSuperseded is an offer a newer proposal replaced.
	RematchSuperseded RematchStatus = "superseded"
	// RematchDeclined is an offer the opponent declined.
	RematchDeclined RematchStatus = "declined"
	// RematchExpired is an offer whose lifetime passed.
	RematchExpired RematchStatus = "expired"
)

// Identity is the authenticated identity of one participant.
//
// The participant reference is an authorization identity. It never appears in
// a public preview. The public label is what other participants see.
type Identity struct {
	Participant online.ParticipantRef
	PublicLabel string
}

// Invitation is the public view of one invitation.
//
// It carries the inviter's public name or Guest, the inviter's seat, the
// clock and the custom position. It never carries a pairing, a seat of the
// invitee, a credential, an owner token or a participant reference.
type Invitation struct {
	InvitationID   string
	Kind           Kind
	Status         Status
	InviterLabel   string
	InviterSeat    online.Seat
	InviterControl online.SeatControl
	TimeControl    online.TimeControl
	StartingFEN    string
	ExpiresAt      time.Time
	CreatedAt      time.Time
	ConsumedAt     *time.Time
	CancelledAt    *time.Time
	MatchID        *string
	// AcceptanceID is the acceptance that consumed the invitation.
	AcceptanceID string
	// inviterKind and inviterID are the stored inviter identity. They are
	// never published; the created match needs them.
	inviterKind string
	inviterID   string
}

// GuestCredential is a freshly minted guest seat credential.
//
// The plaintext token exists only in the answer that delivered it. It is
// never stored, logged or published.
type GuestCredential struct {
	GuestID   string
	MatchID   string
	Seat      online.Seat
	Token     string
	ExpiresAt time.Time
	// CredentialID is the stored identifier of the credential. It is not
	// secret and it is not published.
	CredentialID string
}

// CreateRequest describes one new invitation.
type CreateRequest struct {
	// Kind is the invitation path. An empty value is a shareable link.
	Kind Kind
	// Inviter is the authenticated inviter. A nil value creates an anonymous
	// guest invitation whose owner token is the only recoverable ownership.
	Inviter *Identity
	// RecipientUsername names the account of a challenge by its public
	// name. It is required for a challenge and forbidden for a link.
	//
	// The public name is the only recipient the public request may carry.
	// The service resolves it to the account subject itself, and the
	// subject never reaches an answer.
	RecipientUsername string
	// RecipientAccountID names the account of a challenge by its subject.
	//
	// It is the resolved form of the public name and it is used by the
	// trusted callers of the service. The public request never carries it,
	// because a subject is an authorization identity and it is never
	// published.
	RecipientAccountID string
	// Seat is the color the inviter chose.
	Seat online.Seat
	// TimeControl is the clock of the friend game.
	TimeControl online.TimeControl
	// StartingFEN is an optional custom position. An empty value means the
	// standard position.
	StartingFEN string
	// Control is the inviter's own seat control: the inviter plays or the
	// inviter's own agent plays.
	Control online.SeatControl
}

// Created is the answer of one invitation creation.
type Created struct {
	Invitation Invitation
	// OwnerToken is the inviter's revocable ownership secret. It is returned
	// once and only its hash is stored.
	OwnerToken string
}

// AcceptRequest describes one acceptance of an invitation.
type AcceptRequest struct {
	// InvitationID is the shareable link secret.
	InvitationID string
	// AcceptanceKey is the client-supplied idempotency key. It is the only
	// capability that resumes an acceptance. It is required for a guest
	// acceptor, because a guest has no other identity to resume with.
	AcceptanceKey string
	// Acceptor is the authenticated acceptor. A nil value creates an
	// anonymous guest acceptor.
	Acceptor *Identity
	// Control is the acceptor's own seat control.
	Control online.SeatControl
	// Origin scopes the guest seat credential of a guest acceptor.
	Origin string
	// RotateCredential replaces a live guest seat credential of the seat. A
	// caller that holds no working credential asks for the rotation; a
	// routine retry never supersedes a credential another request already
	// delivered.
	RotateCredential bool
}

// Accepted is the answer of one accepted invitation.
type Accepted struct {
	AcceptanceID string
	MatchID      string
	Seat         online.Seat
	// GuestCredential is present only when this request minted the guest
	// seat credential of the seat.
	GuestCredential *GuestCredential
}

// CancelRequest describes one cancellation of an invitation.
type CancelRequest struct {
	InvitationID string
	// OwnerToken authorizes the cancellation of the inviter.
	OwnerToken string
	// Canceller is the authenticated inviter. It authorizes the
	// cancellation on its own.
	Canceller *Identity
}

// SeatCredentialRequest describes one request for the inviter's guest seat
// credential of the created match.
type SeatCredentialRequest struct {
	InvitationID string
	OwnerToken   string
	Origin       string
	// Viewer is the authenticated caller of the request.
	//
	// The viewer never authorizes the mint of the credential: the owner
	// token and the inviter alone do that. The viewer only proves that the
	// caller may see the invitation, so the named recipient of a challenge
	// is not answered like a stranger.
	Viewer *Identity
}

// SeatCredentialResult is the answer of one seat credential request.
type SeatCredentialResult struct {
	MatchID string
	Seat    online.Seat
	// GuestCredential is nil for an account inviter.
	GuestCredential *GuestCredential
}

// RematchRequest describes one proposed rematch.
type RematchRequest struct {
	MatchID       string
	Proposer      online.ParticipantRef
	ProposerLabel string
	// TimeControl overrides the clock of the finished match when it is set.
	TimeControl *online.TimeControl
	// StartingFEN overrides the starting position of the finished match when
	// it is set.
	StartingFEN *string
}

// Rematch is the public view of one rematch offer.
type Rematch struct {
	RematchID     string
	MatchID       string
	Status        RematchStatus
	ProposerLabel string
	ProposerSeat  online.Seat
	TimeControl   online.TimeControl
	StartingFEN   string
	ExpiresAt     time.Time
	NewMatchID    *string
	CreatedAt     time.Time
	// proposerKind and proposerID are the stored proposer identity. They are
	// never published; the acceptance rules need them.
	proposerKind string
	proposerID   string
	// acceptedByKind and acceptedByID name the accepter of a reserved or an
	// accepted offer. They are never published.
	acceptedByKind string
	acceptedByID   string
}

// ProposedBy reports whether the participant proposed the offer.
//
// The stored proposer identity decides, so the answer never depends on the
// seat of a participant and never on the name of one. The identity itself is
// never published: the answer is a fact about the caller, and it tells the
// proposer apart from the opponent that may accept the offer.
//
// The kind of the participant is part of the comparison, because an account
// and a guest that share an identifier are two different participants.
func (r Rematch) ProposedBy(participant online.ParticipantRef) bool {
	if r.proposerID == "" || participant.ID == "" {
		return false
	}
	return r.proposerKind == string(participant.Kind) && r.proposerID == participant.ID
}

// AcceptRematchRequest describes one acceptance of a rematch offer.
type AcceptRematchRequest struct {
	RematchID string
	Acceptor  online.ParticipantRef
	// Origin scopes a guest seat credential of the new match.
	Origin string
	// RotateCredential replaces a live guest seat credential of the seat.
	RotateCredential bool
	// CredentialMatchID is the match the presented credential of the caller
	// is bound to. It is empty when the caller presented no credential.
	//
	// The service uses it to tell a caller that already holds a working
	// credential of the new match from one that lost its answer. A rematch
	// is a new match, so the credential of the finished match cannot
	// authorize the new seat.
	CredentialMatchID string
}

// RematchResult is the answer of one accepted rematch.
type RematchResult struct {
	Rematch Rematch
	// MatchID is the created match.
	MatchID string
	// Seat is the seat the acceptor plays in the new match.
	Seat online.Seat
	// GuestCredential is present only when this request minted the guest
	// seat credential of the acceptor.
	GuestCredential *GuestCredential
}

// RematchSeatCredentialRequest describes one request for the guest seat
// credential of the proposer of an accepted rematch.
//
// A rematch is a new match, so the credential of the finished match cannot
// authorize it. A guest participant needs a fresh credential for the new
// seat.
type RematchSeatCredentialRequest struct {
	RematchID string
	Proposer  online.ParticipantRef
	Origin    string
}

// MatchAllocator is the trusted seam that creates the canonical match of an
// accepted invitation.
//
// It is the single canonical allocation seam of backend/online. The queue
// worker uses the same seam, so an invitation and a queue pair never keep two
// copies of the acceptance SQL.
type MatchAllocator interface {
	CreateMatchInTx(ctx context.Context, tx pgx.Tx, cmd online.Command) (online.CommandResult, error)
	ValidateSetup(ctx context.Context, setup online.CreateMatchSetup) error
}

// MatchReader reads a canonical match for the rematch rules.
type MatchReader interface {
	GetMatch(ctx context.Context, matchID string) (online.Match, error)
}

// CredentialIssuer mints the guest seat credential of an accepted seat.
type CredentialIssuer interface {
	AcceptInvitation(ctx context.Context, request onlineauth.AcceptInvitationRequest) (onlineauth.IssuedSeatCredentials, error)
	AcceptInvitationTx(ctx context.Context, tx pgx.Tx, request onlineauth.AcceptInvitationRequest) (onlineauth.IssuedSeatCredentials, error)
	// HasLiveSeatCredential reports whether the seat still has a live
	// credential.
	HasLiveSeatCredential(ctx context.Context, q online.Querier, matchID string, seat online.Seat) (bool, error)
}

// Options configures the invitation service.
type Options struct {
	// Now overrides the clock. The tests use it to place an acceptance
	// before or after the expiry of an invitation.
	Now func() time.Time
	// InvitationTTL bounds the lifetime of an invitation.
	InvitationTTL time.Duration
	// GuestCredentialTTL bounds the lifetime of an issued guest seat
	// credential.
	GuestCredentialTTL time.Duration
	// Identifier mints a stored identifier. It is replaced in the tests to
	// make the fixtures deterministic.
	Identifier func(prefix string, length int) (string, error)
	// Secret mints a bearer secret.
	Secret func(prefix string, length int) (string, error)
	// Gate reports whether the friend surface is currently open.
	//
	// A nil gate opens the surface. The gate is the rollback switch of the
	// friend surface: it stops new creations immediately and it never
	// invalidates an invitation that was issued while it was open.
	Gate FeatureGate
	// Recipients resolves the public name of an account to its subject.
	//
	// A nil resolver reads the public profiles of the pool, because the
	// service is the only component that may resolve a public name into an
	// authorization identity.
	Recipients RecipientResolver
}

// FeatureGate reports whether the friend surface is currently open.
type FeatureGate interface {
	FriendsEnabled() bool
}

// StaticGate is the feature gate of a fixed configuration.
//
// The server reads the switch once, when it boots, so the gate of a process
// never changes under a request.
type StaticGate bool

// FriendsEnabled reports the configured state of the surface.
func (g StaticGate) FriendsEnabled() bool { return bool(g) }

// RecipientResolver resolves the public name of an account to its subject.
//
// The resolution happens inside the service, so the public request of a named
// challenge carries a public name and never an authentication identifier.
type RecipientResolver interface {
	AccountIDByUsername(ctx context.Context, username string) (string, error)
}

// Service owns friend invitations and rematches.
type Service struct {
	db          *pgxpool.Pool
	matches     MatchAllocator
	reader      MatchReader
	credentials CredentialIssuer
	options     Options
	gate        FeatureGate
	recipients  RecipientResolver
}

// Open binds the invitation service to a pool. It does not mutate schema.
func Open(_ context.Context, db *pgxpool.Pool, matches MatchAllocator, reader MatchReader, credentials CredentialIssuer, options Options) (*Service, error) {
	if db == nil || matches == nil || reader == nil || credentials == nil {
		return nil, ErrInvalidArgument
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.InvitationTTL <= 0 {
		options.InvitationTTL = InvitationTTL
	}
	if options.GuestCredentialTTL <= 0 {
		options.GuestCredentialTTL = onlineauth.DefaultGuestCredentialTTL
	}
	if options.Identifier == nil {
		options.Identifier = randomIdentifier
	}
	if options.Secret == nil {
		options.Secret = randomSecret
	}
	if options.Recipients == nil {
		// The service resolves a public name itself, so a subject never
		// crosses the boundary of the public request.
		options.Recipients = NewAccountLabelResolver(db)
	}
	return &Service{
		db:          db,
		matches:     matches,
		reader:      reader,
		credentials: credentials,
		options:     options,
		gate:        options.Gate,
		recipients:  options.Recipients,
	}, nil
}

func (s *Service) now() time.Time { return s.options.Now().UTC() }

// friendsEnabled reports whether the friend surface is currently open.
func (s *Service) friendsEnabled() bool {
	if s.gate == nil {
		return true
	}
	return s.gate.FriendsEnabled()
}

// servesIssued reports whether a request of an issued invitation may be
// served.
//
// A closed surface still finishes the invitations it issued while it was
// open: a guest may accept one, and the inviter may cancel it and claim its
// seat credential. The invitation records that it was issued while the
// surface was open, so the closed path never widens into an arbitrary
// invitation.
func (s *Service) servesIssued(issued bool) error {
	if s.friendsEnabled() {
		return nil
	}
	if issued {
		return nil
	}
	return ErrDisabled
}

// Create creates one invitation.
//
// The custom position is validated against the pinned rules policy before the
// invitation exists, so an invalid position can never be offered and later
// consume an invitation.
//
// A named challenge needs an account inviter. A shareable link does not, so
// a guest may still create one.
//
// A closed surface refuses the creation. The refusal is the rollback
// behaviour of the switch: it stops new creations immediately, and it never
// invalidates an invitation that was issued while the surface was open.
func (s *Service) Create(ctx context.Context, request CreateRequest) (Created, error) {
	if !s.friendsEnabled() {
		return Created{}, ErrDisabled
	}
	kind := request.Kind
	if kind == "" {
		kind = KindLink
	}
	if kind != KindLink && kind != KindChallenge {
		return Created{}, fmt.Errorf("%w: invitation kind", ErrInvalidContract)
	}
	// A named challenge names an account, so it needs an account inviter.
	// The check runs before the recipient is resolved, so a caller without
	// account authority learns nothing about the accounts of the surface: the
	// refusal is the same refusal whatever the named recipient is.
	if err := validateChallengeInviter(kind, request.Inviter); err != nil {
		return Created{}, err
	}
	recipient, err := s.resolveRecipient(ctx, kind, request)
	if err != nil {
		return Created{}, err
	}
	if request.Seat != online.SeatWhite && request.Seat != online.SeatBlack {
		return Created{}, fmt.Errorf("%w: inviter seat", ErrInvalidContract)
	}
	if err := validateTimeControl(request.TimeControl); err != nil {
		return Created{}, err
	}
	if err := validateSeatControl(request.Control); err != nil {
		return Created{}, err
	}
	inviterParticipant, inviterLabel, err := s.resolveInviter(request.Inviter)
	if err != nil {
		return Created{}, err
	}
	// The declared model control of the inviter is resolved before it is
	// stored and before it is published, so a private routing identity never
	// reaches the durable row or the public preview of the link.
	inviterControl, err := resolvePublicModelLabel(ctx, s.db, inviterParticipant, request.Control)
	if err != nil {
		return Created{}, err
	}
	startingFEN := strings.TrimSpace(request.StartingFEN)
	if err := s.validatePosition(ctx, startingFEN, request.TimeControl, inviterParticipant, inviterLabel, inviterControl); err != nil {
		return Created{}, err
	}
	invitationID, err := s.options.Identifier("inv_", 40)
	if err != nil {
		return Created{}, err
	}
	ownerToken, err := s.options.Secret("kmoi1_", 40)
	if err != nil {
		return Created{}, err
	}
	now := s.now()
	expiresAt := now.Add(s.options.InvitationTTL)
	var modelLabel any
	if inviterControl.ModelLabel != nil {
		modelLabel = *inviterControl.ModelLabel
	}
	// The account scope lock orders the creation against the removal of the
	// inviter and of the named recipient. The removal of a participant takes
	// the same lock and then the row locks of the rows it sanitizes, so the
	// two flows are ordered instead of racing and never deadlock.
	participants := []online.ParticipantRef{inviterParticipant}
	if recipient != "" {
		participants = append(participants, online.ParticipantRef{Kind: online.ParticipantAccount, ID: recipient})
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Created{}, err
	}
	closed := false
	defer func() {
		if !closed {
			_ = tx.Rollback(ctx)
		}
	}()
	if err = lockParticipants(ctx, tx, participants...); err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return Created{}, err
	}
	// The removal of a participant is rechecked after the lock, so a request
	// that was authenticated before the removal cannot create a personal row
	// after it.
	if err = recheckParticipants(ctx, tx, "", participants...); err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return Created{}, err
	}
	// The row records that the invitation was issued while the surface was
	// open. The closed surface reads that fact before it serves a request of
	// the invitation, so a rollback never widens into an arbitrary
	// invitation.
	_, err = tx.Exec(ctx, `INSERT INTO online_friend_invitations(invitation_id,kind,status,version,inviter_kind,inviter_id,inviter_public_label,inviter_control_kind,inviter_model_label,inviter_seat,starting_time_ms,increment_ms,starting_fen,recipient_account_id,owner_token_hash,created_at,expires_at,issued_while_enabled) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true)`,
		invitationID, string(kind), string(StatusOpen), string(inviterParticipant.Kind), inviterParticipant.ID, inviterLabel, string(inviterControl.Kind), modelLabel, string(request.Seat),
		request.TimeControl.StartingTimeMs, request.TimeControl.IncrementMs, nullableString(startingFEN), nullableString(recipient), hashOwnerToken(ownerToken), now, expiresAt)
	if err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return Created{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Created{}, err
	}
	closed = true
	invitation := Invitation{
		InvitationID:   invitationID,
		Kind:           kind,
		Status:         StatusOpen,
		InviterLabel:   inviterLabel,
		InviterSeat:    request.Seat,
		InviterControl: inviterControl,
		TimeControl:    request.TimeControl,
		StartingFEN:    startingFEN,
		ExpiresAt:      expiresAt,
		CreatedAt:      now,
		inviterKind:    string(inviterParticipant.Kind),
		inviterID:      inviterParticipant.ID,
	}
	return Created{Invitation: invitation, OwnerToken: ownerToken}, nil
}

// lockParticipants takes the account scope locks of the participants that a
// write names.
//
// The account scope lock is the shared lock of the online service. The
// removal of a participant takes the same lock and then the row locks of the
// rows it sanitizes, so a write that names a participant and the removal of
// that participant are ordered instead of racing, and the two flows never
// deadlock against each other.
//
// The scopes of one write are taken in ascending order, so two writes that
// name the same participants take them in the same order.
//
// The lock is always taken before the row lock of the invitation or of the
// rematch offer, because the removal takes the row locks of the rows it
// sanitizes after its own scope lock.
func lockParticipants(ctx context.Context, tx pgx.Tx, participants ...online.ParticipantRef) error {
	scopes := make([]string, 0, len(participants))
	for _, participant := range participants {
		if participant.ID == "" {
			continue
		}
		// The anonymized sentinel is not a participant. Every removed
		// subject of the same kind carries the same sentinel, so a scope
		// lock of it would be one global lock for all of them. The sentinel
		// is refused by value, so it needs no lock at all.
		if participant.ID == anonymizedParticipant {
			continue
		}
		scopes = append(scopes, locks.AccountScope(string(participant.Kind), participant.ID))
	}
	return locks.LockAccountScopes(ctx, tx, scopes)
}

// recheckParticipants reports whether one of the participants was removed.
//
// The check runs inside the transaction of the write, after the locks and
// before the row is written. A request that was authenticated before the
// removal therefore cannot create a personal row after the removal, and it
// cannot reintroduce one.
//
// The match identifier is the match the write is about, when it is known. The
// removal ledger is the match scoped record of a removal, so a participant of
// that match is refused even when the seat row of an older backup still names
// the removed subject.
//
// The removal tables name a subject by its one-way reference, so the check
// never handles the raw identifier of a removed subject.
func recheckParticipants(ctx context.Context, q online.Querier, matchID string, participants ...online.ParticipantRef) error {
	removed, err := removedParticipants(ctx, q, matchID, participants...)
	if err != nil {
		return err
	}
	if removed {
		return fmt.Errorf("%w: the participant was removed", ErrRemoved)
	}
	return nil
}

// removedParticipants reports whether one of the participants was removed.
//
// Three facts decide it.
//
// A participant that carries the anonymized sentinel is a removed
// participant. The privacy sanitation replaces the identifier of a removed
// subject with that constant, so a row that carries it names nobody any
// more, and a write that would seat it would seat a subject that no longer
// exists.
//
// A participant whose account or of whose guest seat a removal was recorded
// is named by the durable removal records, compared through the one-way
// reference of the subject.
//
// A participant of a match whose removal ledger names **that** participant
// was removed from that match. The ledger is the match scoped record of a
// removal, so it answers the question even when the seat row of an older
// backup still names the removed subject.
//
// The ledger row names the removed subject, so the check is participant
// scoped. A surviving participant of a match whose other participant was
// removed keeps its own seat, its own credential and its own writes: the
// removal of the opponent does not remove the survivor.
func removedParticipants(ctx context.Context, q online.Querier, matchID string, participants ...online.ParticipantRef) (bool, error) {
	type subjectRef struct {
		kind string
		ref  string
	}
	refs := make([]subjectRef, 0, len(participants))
	for _, participant := range participants {
		if participant.ID == "" {
			continue
		}
		if participant.ID == anonymizedParticipant {
			return true, nil
		}
		reference := subject.Reference(participant.ID)
		query := subject.GuestRemovedSQL
		kind := string(online.ParticipantGuest)
		if participant.Kind == online.ParticipantAccount {
			query = subject.AccountRemovedSQL
			kind = string(online.ParticipantAccount)
		}
		var removed bool
		if err := q.QueryRow(ctx, query, reference).Scan(&removed); err != nil {
			return false, err
		}
		if removed {
			return true, nil
		}
		refs = append(refs, subjectRef{kind: kind, ref: reference})
	}
	if matchID == "" || len(refs) == 0 {
		return false, nil
	}
	// The ledger row names the removed subject **and** its kind. The kind
	// tells an account and a guest with the same identifier apart, because
	// their one-way reference is the same value: without the kind the row of
	// a removed account would refuse the guest of the same identifier.
	conditions := make([]string, 0, len(refs))
	args := []any{matchID}
	for _, reference := range refs {
		args = append(args, reference.kind, reference.ref)
		conditions = append(conditions, fmt.Sprintf("(subject_kind=$%d AND subject_id=$%d)", len(args)-1, len(args)))
	}
	var removed bool
	if err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM online_removal_ledger WHERE match_id=$1 AND (`+strings.Join(conditions, " OR ")+`))`, args...).Scan(&removed); err != nil {
		return false, err
	}
	return removed, nil
}

// seatParticipants returns the participants of the seats of a match.
//
// The participants are the ones a rematch names, so their scopes are locked
// and their removal is rechecked before a new game is created for them.
func seatParticipants(match online.Match) []online.ParticipantRef {
	participants := make([]online.ParticipantRef, 0, len(match.Seats))
	for _, seat := range match.Seats {
		participants = append(participants, seat.Participant)
	}
	return participants
}

// containsParticipant reports whether a participant is in a set of
// participants.
//
// The identity is compared exactly, so the kind is part of it: an account and
// a guest that share an identifier are two different participants.
func containsParticipant(participants []online.ParticipantRef, participant online.ParticipantRef) bool {
	for _, candidate := range participants {
		if candidate == participant {
			return true
		}
	}
	return false
}

// rematchAccepterMatches reports whether a participant is the accepter of a
// rematch offer.
//
// The identity is compared exactly when the offer names the kind of its
// accepter: an account and a guest that share an identifier are two
// different participants. An offer of an older build can name the identifier
// only, and the identifier is compared then.
func rematchAccepterMatches(offer Rematch, participant online.ParticipantRef) bool {
	if offer.acceptedByID != participant.ID {
		return false
	}
	if offer.acceptedByKind == "" {
		return true
	}
	return offer.acceptedByKind == string(participant.Kind)
}

// resolvePublicModelLabel resolves a declared model control to the control
// that may be published.
//
// The resolution is the canonical one of the service. The database function
// `online_resolve_public_model_label` is the single source of that policy,
// so a private routing identity, a secret bearing alias or a connection
// nickname never reaches a durable row or a public answer. A known public
// model name and a public label the owner registered for their own account
// are kept, and everything else becomes the neutral label.
//
// The resolution is idempotent for one owner, so a value that was resolved
// once stays the same value.
//
// A human control keeps no model label and is returned unchanged.
func resolvePublicModelLabel(ctx context.Context, q online.Querier, owner online.ParticipantRef, control online.SeatControl) (online.SeatControl, error) {
	if control.Kind == online.ControlHuman {
		return control, nil
	}
	if control.ModelLabel == nil {
		return online.SeatControl{}, fmt.Errorf("%w: the declared model label", online.ErrInvalidContract)
	}
	var resolved *string
	if err := q.QueryRow(ctx, `SELECT online_resolve_public_model_label($1,$2,$3,$4)`, string(owner.Kind), owner.ID, string(control.Kind), *control.ModelLabel).Scan(&resolved); err != nil {
		return online.SeatControl{}, err
	}
	if resolved == nil || *resolved == "" {
		return online.SeatControl{}, fmt.Errorf("%w: the declared model label", online.ErrInvalidContract)
	}
	control.ModelLabel = resolved
	return control, nil
}

// validatePosition checks the starting position of a friend game.
//
// The check runs outside every transaction, so an invalid position is refused
// before an invitation exists or before an invitation is consumed.
func (s *Service) validatePosition(ctx context.Context, startingFEN string, timeControl online.TimeControl, participant online.ParticipantRef, label string, control online.SeatControl) error {
	if startingFEN == "" {
		return nil
	}
	other := online.ParticipantRef{Kind: online.ParticipantGuest, ID: "invitation-position-check"}
	setup := online.CreateMatchSetup{
		Variant:     "orthodox",
		StartingFEN: startingFEN,
		TimeControl: timeControl,
		Seats: online.CreateMatchSeats{
			White: online.CreateSeat{Participant: participant, PublicLabel: label, Control: control},
			Black: online.CreateSeat{Participant: other, PublicLabel: GuestLabel, Control: control},
		},
	}
	if err := setup.Validate(); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidContract, err)
	}
	if err := s.matches.ValidateSetup(ctx, setup); err != nil {
		return fmt.Errorf("%w: the starting position is not playable", ErrInvalidContract)
	}
	return nil
}

// validateChallengeInviter refuses a named challenge of an inviter that is
// not an account.
//
// A shareable link is a bearer secret, and a guest may create one. A named
// challenge names an account of the surface, so only an account may create
// one: an anonymous caller and a guest that holds a seat credential are both
// refused. The service decides that, not the browser that asked for the
// invitation, so the rule holds for every caller of the service.
//
// The refusal is an authorization refusal, and it is the same refusal for
// every caller without account authority, so it never reveals whether the
// named recipient exists.
func validateChallengeInviter(kind Kind, inviter *Identity) error {
	if kind != KindChallenge {
		return nil
	}
	if inviter == nil || inviter.Participant.Kind != online.ParticipantAccount {
		return fmt.Errorf("%w: a named challenge needs an account inviter", ErrNotAuthorized)
	}
	return nil
}

// resolveRecipient returns the account subject of the named recipient.
//
// A named challenge names an account by its public name. The public request
// carries the name and the service resolves it, so the authentication
// identifier of the recipient never crosses the boundary of the public
// request and never reaches an answer.
//
// A link has no recipient at all: a guest may join it.
func (s *Service) resolveRecipient(ctx context.Context, kind Kind, request CreateRequest) (string, error) {
	accountID := strings.TrimSpace(request.RecipientAccountID)
	username := strings.TrimSpace(request.RecipientUsername)
	if kind != KindChallenge {
		if accountID != "" || username != "" {
			return "", fmt.Errorf("%w: a shareable link has no named recipient", ErrInvalidContract)
		}
		return "", nil
	}
	if accountID != "" && username != "" {
		return "", fmt.Errorf("%w: a named challenge names its recipient once", ErrInvalidContract)
	}
	if accountID != "" {
		if len(accountID) > 128 {
			return "", fmt.Errorf("%w: a named challenge needs a recipient account", ErrInvalidContract)
		}
		return accountID, nil
	}
	if username == "" {
		return "", fmt.Errorf("%w: a named challenge needs a recipient name", ErrInvalidContract)
	}
	if len(username) > 64 {
		return "", fmt.Errorf("%w: the recipient name is too long", ErrInvalidContract)
	}
	if s.recipients == nil {
		return "", fmt.Errorf("%w: the service cannot resolve a public name", ErrUnavailable)
	}
	resolved, err := s.recipients.AccountIDByUsername(ctx, username)
	if err != nil {
		return "", err
	}
	resolved = strings.TrimSpace(resolved)
	if resolved == "" {
		return "", ErrRecipientNotFound
	}
	return resolved, nil
}

// resolveInviter returns the inviter identity of a new invitation.
//
// An anonymous inviter is a guest with a fresh opaque identity and the public
// label Guest. It owns the invitation through the owner token only.
func (s *Service) resolveInviter(inviter *Identity) (online.ParticipantRef, string, error) {
	if inviter == nil {
		guestID, err := s.options.Identifier("guest_", 24)
		if err != nil {
			return online.ParticipantRef{}, "", err
		}
		return online.ParticipantRef{Kind: online.ParticipantGuest, ID: guestID}, GuestLabel, nil
	}
	if err := inviter.Participant.Validate(); err != nil {
		return online.ParticipantRef{}, "", fmt.Errorf("%w: inviter identity", ErrInvalidArgument)
	}
	label := strings.TrimSpace(inviter.PublicLabel)
	if label == "" {
		label = GuestLabel
	}
	if err := validatePublicLabel(label); err != nil {
		return online.ParticipantRef{}, "", err
	}
	return inviter.Participant, label, nil
}

// ViewRequest describes one read of an invitation.
type ViewRequest struct {
	// InvitationID is the shareable link secret.
	InvitationID string
	// ViewerAccountID is the account that reads the invitation. It is empty
	// for a guest and for an anonymous reader.
	ViewerAccountID string
	// OwnerToken authorizes the read for the inviter of the invitation.
	//
	// The owner token is a private secret. It authorizes the read of the
	// inviter alone and it never widens the visibility of a challenge.
	OwnerToken string
}

// Get returns the public view of one invitation.
//
// A shareable link is public: everybody who holds the link may read its
// preview.
//
// A named challenge is private. Only its named recipient may read it, and
// only the inviter may read it with the owner token of the invitation. Every
// other caller learns nothing about the challenge, so the status of a
// challenge is never public.
func (s *Service) Get(ctx context.Context, request ViewRequest) (Invitation, error) {
	invitation, access, err := s.readInvitation(ctx, request.InvitationID)
	if err != nil {
		return Invitation{}, err
	}
	if err = s.servesIssued(access.issuedWhileEnabled); err != nil {
		return Invitation{}, err
	}
	if access.recipient == "" {
		return invitation, nil
	}
	if request.ViewerAccountID != "" && request.ViewerAccountID == access.recipient {
		return invitation, nil
	}
	// The inviter reads its own challenge with the owner token. The token is
	// the proof of the ownership, so the inviter never has to publish the
	// challenge to learn that it was consumed.
	if request.OwnerToken != "" && s.ownsInvitation(ctx, request.InvitationID, request.OwnerToken, nil) {
		return invitation, nil
	}
	return Invitation{}, ErrNotFound
}

// Accept consumes an invitation and creates the canonical match.
//
// The acceptance is idempotent for one acceptance key. A retry after a lost
// answer returns the same match and the same seat. The guest seat credential
// is minted again only when the caller asks for the rotation, so a routine
// retry never supersedes a credential that another request already
// delivered.
//
// The consumption of the invitation, the acceptance record, the canonical
// match and the guest seat credential commit together. An invitation is
// therefore never spent without a game, and a crash between two writes
// cannot orphan an acceptance.
func (s *Service) Accept(ctx context.Context, request AcceptRequest) (Accepted, error) {
	if err := validateAcceptanceKey(request.AcceptanceKey); err != nil {
		return Accepted{}, err
	}
	if err := validateSeatControl(request.Control); err != nil {
		return Accepted{}, err
	}
	invitation, access, err := s.readInvitation(ctx, request.InvitationID)
	if err != nil {
		return Accepted{}, err
	}
	// A closed surface still finishes the invitations it issued while it
	// was open, so a guest may accept one after the switch was turned off.
	if err = s.servesIssued(access.issuedWhileEnabled); err != nil {
		return Accepted{}, err
	}
	if request.Acceptor != nil {
		if err := request.Acceptor.Participant.Validate(); err != nil {
			return Accepted{}, fmt.Errorf("%w: acceptor identity", ErrInvalidArgument)
		}
		// The inviter cannot accept their own invitation. The check runs
		// before the consumption, so a self acceptance never consumes an
		// invitation.
		if request.Acceptor.Participant.Kind == online.ParticipantKind(invitation.inviterKind) && request.Acceptor.Participant.ID == invitation.inviterID {
			return Accepted{}, fmt.Errorf("%w: the inviter cannot accept their own invitation", ErrInvalidContract)
		}
	}
	if access.recipient != "" {
		// A named challenge is isolated: only the named account may accept
		// it, and a guest never may. An invitation that is not visible to
		// the caller is reported exactly like an unknown invitation, so a
		// caller cannot learn that a named challenge exists.
		if request.Acceptor == nil || request.Acceptor.Participant.Kind != online.ParticipantAccount || request.Acceptor.Participant.ID != access.recipient {
			return Accepted{}, ErrNotFound
		}
	}
	// The position is checked before the consumption, so an invalid
	// position never consumes an invitation.
	if err := s.validatePosition(ctx, invitation.StartingFEN, invitation.TimeControl,
		online.ParticipantRef{Kind: online.ParticipantKind(invitation.inviterKind), ID: invitation.inviterID},
		invitation.InviterLabel, invitation.InviterControl); err != nil {
		return Accepted{}, err
	}
	return s.accept(ctx, request, invitation)
}

// accept consumes the invitation, records the acceptance, creates the
// canonical match and mints the guest seat credential in one transaction.
//
// The invitation row is locked before its state is read, so two concurrent
// acceptances serialize and only one of them sees the open status. The loser
// of the race observes the consumed state after the winner committed and
// releases the lock with its rollback.
//
// Every read of the transaction runs on the transaction itself. A loser never
// holds a row lock while it waits for a connection of the pool, so a
// contended acceptance can never exhaust the pool and block the winner of
// the race.
//
// The consumption, the acceptance row, the match and the credential commit
// together. A crash can never leave a spent invitation without a game, so no
// reconciler has to look for an orphaned acceptance.
//
// Every step is idempotent: the match identifier is derived from the
// acceptance, so a retry creates no second match.
//
// The acceptance can have to start again. A retry of a lost answer can meet
// the acceptance that another request is writing right now: the acceptance of
// the key is read before the locks, and the row of the other request is not
// committed yet, so the read misses it. The retry waits for the row of the
// invitation, the first request commits, and the authoritative lookup finds
// the acceptance whose acceptor was never locked. The write is rolled back
// and started again in that case, so the scope of the stored acceptor is
// always taken before the row lock and never after it.
func (s *Service) accept(ctx context.Context, request AcceptRequest, invitation Invitation) (Accepted, error) {
	for attempt := 0; attempt < acceptAttempts; attempt++ {
		accepted, restart, err := s.acceptAttempt(ctx, request, invitation)
		if err != nil {
			return Accepted{}, err
		}
		if !restart {
			return accepted, nil
		}
	}
	return Accepted{}, ErrConflict
}

// acceptAttempts bounds the restarts of one acceptance.
//
// Two attempts are enough: the acceptance that was missing is committed by the
// time the second one starts.
const acceptAttempts = 3

// errAcceptRestart asks the acceptance to start again.
//
// The authoritative lookup found an acceptance whose acceptor was not in the
// locked scope set, so the write has to be rolled back and started again
// with the scope of that acceptor.
var errAcceptRestart = errors.New("invite: the acceptance has to start again")

// acceptAttempt runs one attempt of an acceptance.
//
// It answers whether the acceptance has to start again.
func (s *Service) acceptAttempt(ctx context.Context, request AcceptRequest, invitation Invitation) (Accepted, bool, error) {
	keyHash := hashAcceptanceKey(request.AcceptanceKey)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Accepted{}, false, err
	}
	closed := false
	defer func() {
		if !closed {
			_ = tx.Rollback(ctx)
		}
	}()
	// The acceptance of the key is read before the locks, so the scope of
	// the acceptor of a resumed acceptance is known. An anonymous resume
	// presents no identity of its own, so the stored acceptor is the only
	// subject the write names, and its scope has to be locked. The read
	// takes no row lock, so the order of the locks is unchanged, and the
	// acceptor of an acceptance never changes, so the read is exact.
	resumed, lookupErr := s.acceptanceByKey(ctx, tx, request.InvitationID, keyHash)
	if lookupErr != nil && !errors.Is(lookupErr, ErrNotFound) {
		closed = true
		_ = tx.Rollback(ctx)
		return Accepted{}, false, lookupErr
	}
	// The account scope locks come first. The removal of a participant takes
	// the same lock and then the row locks of the rows it sanitizes, so the
	// scope locks have to be taken before the row lock of the invitation.
	participants := []online.ParticipantRef{{Kind: online.ParticipantKind(invitation.inviterKind), ID: invitation.inviterID}}
	if request.Acceptor != nil {
		participants = append(participants, request.Acceptor.Participant)
	}
	if lookupErr == nil {
		participants = append(participants, online.ParticipantRef{Kind: online.ParticipantKind(resumed.AcceptorKind), ID: resumed.AcceptorID})
	}
	if err = lockParticipants(ctx, tx, participants...); err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return Accepted{}, false, err
	}
	// The invitation row is locked for the acceptance. The lock is taken
	// before the state is read, so a concurrent acceptance is observed
	// after it committed.
	var (
		status    string
		expiresAt time.Time
	)
	err = tx.QueryRow(ctx, `SELECT status,expires_at FROM online_friend_invitations WHERE invitation_id=$1 FOR UPDATE`, request.InvitationID).Scan(&status, &expiresAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			closed = true
			_ = tx.Rollback(ctx)
			return Accepted{}, false, ErrNotFound
		}
		return Accepted{}, false, err
	}
	// The removal of a participant is rechecked in the claim, where the
	// participants of the write are known: a fresh acceptance names the
	// inviter and the acceptor, because it creates the match of both, and a
	// resumed acceptance names the acceptor alone, because it only mints
	// the credential of the seat the acceptor already holds.
	acceptance, err := s.claim(ctx, tx, request, invitation, keyHash, status, expiresAt, participants)
	if err != nil {
		if errors.Is(err, errAcceptRestart) {
			closed = true
			_ = tx.Rollback(ctx)
			return Accepted{}, true, nil
		}
		closed = true
		_ = tx.Rollback(ctx)
		return Accepted{}, false, err
	}
	accepted, err := s.complete(ctx, tx, acceptance, invitation, request)
	if err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return Accepted{}, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Accepted{}, false, err
	}
	closed = true
	return accepted, false, nil
}

// claim consumes the invitation and records the acceptance inside the
// acceptance transaction.
//
// The acceptance row is written in the same transaction as the match, so an
// invitation is never consumed without a recoverable acceptance.
//
// The identity of an anonymous guest acceptor is allocated inside that
// transaction and stored as the seat owner of the created match, so the
// identity and the minted credential always agree.
func (s *Service) claim(ctx context.Context, tx pgx.Tx, request AcceptRequest, invitation Invitation, keyHash []byte, status string, expiresAt time.Time, locked []online.ParticipantRef) (acceptance, error) {
	// An acceptance with the same key resumes the same acceptance.
	existing, lookupErr := s.acceptanceByKey(ctx, tx, request.InvitationID, keyHash)
	if lookupErr == nil {
		// An account acceptor is bound to its own acceptance. A guest has
		// no other identity, so the acceptance key is the whole resume
		// capability of a guest acceptance.
		//
		// The identity is compared exactly: the kind is part of it, so an
		// account and a guest that share an identifier never resume each
		// other's acceptance. A request without an identity presents the
		// key alone, and the key is the capability of that acceptance.
		acceptor := online.ParticipantRef{Kind: online.ParticipantKind(existing.AcceptorKind), ID: existing.AcceptorID}
		if request.Acceptor != nil && request.Acceptor.Participant != acceptor {
			return acceptance{}, ErrConflict
		}
		// The stored acceptor has to be in the locked scope set. The
		// acceptance of the key was read before the locks, so an
		// acceptance that was committed after that read is not in the set:
		// the write is rolled back and started again with its scope.
		if !containsParticipant(locked, acceptor) {
			return acceptance{}, errAcceptRestart
		}
		// A resumed acceptance names the acceptor alone. It creates no
		// match and it writes no row of another participant, so only the
		// acceptor is rechecked: the removal of the inviter does not take
		// the seat of the acceptor away, and the acceptance that already
		// happened is not undone by it.
		if err := recheckParticipants(ctx, tx, matchIDOf(invitation.MatchID), acceptor); err != nil {
			return acceptance{}, err
		}
		return existing, nil
	}
	if !errors.Is(lookupErr, ErrNotFound) {
		return acceptance{}, lookupErr
	}
	now := s.now()
	switch Status(status) {
	case StatusConsumed:
		return acceptance{}, ErrAlreadyConsumed
	case StatusCancelled:
		return acceptance{}, ErrConflict
	case StatusExpired:
		return acceptance{}, ErrExpired
	}
	if !now.Before(expiresAt) {
		return acceptance{}, ErrExpired
	}
	acceptanceID, err := s.options.Identifier("acc_", 24)
	if err != nil {
		return acceptance{}, err
	}
	acceptorID := ""
	acceptorKind := string(online.ParticipantGuest)
	acceptorLabel := GuestLabel
	if request.Acceptor != nil {
		acceptorKind = string(request.Acceptor.Participant.Kind)
		acceptorID = request.Acceptor.Participant.ID
		acceptorLabel = strings.TrimSpace(request.Acceptor.PublicLabel)
		if acceptorLabel == "" {
			acceptorLabel = GuestLabel
		}
	}
	// The identity of an anonymous guest acceptor is allocated once, inside
	// the transaction that consumes the invitation.
	if acceptorID == "" {
		guestID, idErr := s.options.Identifier("guest_", 24)
		if idErr != nil {
			return acceptance{}, idErr
		}
		acceptorID = guestID
	}
	// A fresh acceptance names the inviter and the acceptor, because it
	// creates the match of both. The removal of either of them is refused
	// before the invitation is consumed.
	inviter := online.ParticipantRef{Kind: online.ParticipantKind(invitation.inviterKind), ID: invitation.inviterID}
	acceptor := online.ParticipantRef{Kind: online.ParticipantKind(acceptorKind), ID: acceptorID}
	if err := recheckParticipants(ctx, tx, "", inviter, acceptor); err != nil {
		return acceptance{}, err
	}
	tag, err := tx.Exec(ctx, `UPDATE online_friend_invitations SET status='consumed',consumed_at=$2,acceptance_id=$3,version=version+1 WHERE invitation_id=$1 AND status='open' AND expires_at > $2`,
		request.InvitationID, now, acceptanceID)
	if err != nil {
		return acceptance{}, err
	}
	if tag.RowsAffected() == 0 {
		return acceptance{}, ErrAlreadyConsumed
	}
	seat := invitation.InviterSeat
	if other, ok := seat.Other(); ok {
		seat = other
	}
	guestID := ""
	if acceptorKind == string(online.ParticipantGuest) {
		guestID = acceptorID
	}
	// The declared model control of the acceptor is resolved before it is
	// stored, so the acceptance record and the seat of the created match
	// carry the publishable label and never a private routing identity.
	acceptorControl, err := resolvePublicModelLabel(ctx, tx, online.ParticipantRef{Kind: online.ParticipantKind(acceptorKind), ID: acceptorID}, request.Control)
	if err != nil {
		return acceptance{}, err
	}
	var modelLabel any
	if acceptorControl.ModelLabel != nil {
		modelLabel = *acceptorControl.ModelLabel
	}
	_, err = tx.Exec(ctx, `INSERT INTO online_invitation_acceptances(acceptance_id,invitation_id,acceptance_key_hash,acceptor_kind,acceptor_id,acceptor_public_label,seat,control_kind,model_label,guest_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$11)`,
		acceptanceID, request.InvitationID, keyHash, acceptorKind, acceptorID, acceptorLabel, string(seat), string(acceptorControl.Kind), modelLabel, nullableString(guestID), now)
	if err != nil {
		return acceptance{}, err
	}
	return acceptance{
		AcceptanceID:  acceptanceID,
		InvitationID:  request.InvitationID,
		AcceptorKind:  acceptorKind,
		AcceptorID:    acceptorID,
		AcceptorLabel: acceptorLabel,
		GuestID:       guestID,
		Seat:          seat,
		ControlKind:   string(acceptorControl.Kind),
		ModelLabel:    acceptorControl.ModelLabel,
		Status:        "pending",
	}, nil
}

// complete creates the canonical match of an acceptance and mints the guest
// seat credential of a guest acceptor, inside the acceptance transaction.
//
// The match, the acceptance state and the credential commit together with the
// consumption of the invitation.
//
// A fresh acceptance creates the canonical match here. A **resumed**
// acceptance does not: the match of the acceptance exists, and it is named by
// the stored acceptance. The seat of a participant that was removed in the
// meantime is redacted in the invitation row, so the match is not created
// again from it, and the resume never writes the row of a removed subject.
func (s *Service) complete(ctx context.Context, tx pgx.Tx, acceptance acceptance, invitation Invitation, request AcceptRequest) (Accepted, error) {
	matchID := matchIDOf(acceptance.MatchID)
	if matchID == "" {
		created, err := s.createMatch(ctx, tx, acceptance, invitation)
		if err != nil {
			return Accepted{}, err
		}
		matchID = created
	}
	accepted := Accepted{AcceptanceID: acceptance.AcceptanceID, MatchID: matchID, Seat: acceptance.Seat}
	if acceptance.AcceptorKind == string(online.ParticipantGuest) {
		credential, mintErr := s.mintAcceptanceCredential(ctx, tx, acceptance, matchID, request.Origin, request.RotateCredential)
		if mintErr != nil {
			return Accepted{}, mintErr
		}
		accepted.GuestCredential = credential
	}
	return accepted, nil
}

// createMatch writes the canonical match of a fresh acceptance.
//
// The match, the acceptance state and the consumption of the invitation
// commit together, so a crash can never leave a spent invitation without a
// game.
func (s *Service) createMatch(ctx context.Context, tx pgx.Tx, acceptance acceptance, invitation Invitation) (string, error) {
	inviterParticipant := online.ParticipantRef{Kind: online.ParticipantKind(invitation.inviterKind), ID: invitation.inviterID}
	acceptorParticipant := online.ParticipantRef{Kind: online.ParticipantKind(acceptance.AcceptorKind), ID: acceptance.AcceptorID}
	if inviterParticipant == acceptorParticipant {
		return "", fmt.Errorf("%w: the inviter cannot accept their own invitation", ErrInvalidContract)
	}
	inviterControl := invitation.InviterControl
	acceptorControl := online.SeatControl{Kind: online.ControlKind(acceptance.ControlKind), ModelLabel: acceptance.ModelLabel}
	startingFEN := invitation.StartingFEN
	if startingFEN == "" {
		startingFEN = StandardStartingFEN
	}
	white := online.CreateSeat{Participant: inviterParticipant, PublicLabel: invitation.InviterLabel, Control: inviterControl}
	black := online.CreateSeat{Participant: acceptorParticipant, PublicLabel: acceptance.AcceptorLabel, Control: acceptorControl}
	if invitation.InviterSeat == online.SeatBlack {
		white, black = black, white
	}
	setup := online.CreateMatchSetup{
		Variant:     "orthodox",
		StartingFEN: startingFEN,
		TimeControl: invitation.TimeControl,
		Seats:       online.CreateMatchSeats{White: white, Black: black},
	}
	cmd, err := online.NewAllocationCommand(inviterParticipant, setup, acceptance.AcceptanceID)
	if err != nil {
		return "", err
	}
	result, err := s.matches.CreateMatchInTx(ctx, tx, cmd)
	if err != nil {
		return "", err
	}
	matchID := result.Receipt.MatchID
	// The acceptance state only moves forward. A retry of an acceptance
	// that is already credentialed keeps its state.
	if _, err = tx.Exec(ctx, `UPDATE online_invitation_acceptances SET status='matched',match_id=$2,updated_at=$3 WHERE acceptance_id=$1 AND status='pending'`,
		acceptance.AcceptanceID, matchID, s.now()); err != nil {
		return "", err
	}
	if _, err = tx.Exec(ctx, `UPDATE online_friend_invitations SET match_id=$2 WHERE invitation_id=$1 AND status='consumed'`,
		acceptance.InvitationID, matchID); err != nil {
		return "", err
	}
	return matchID, nil
}

// mintAcceptanceCredential mints the guest seat credential of an accepted
// seat inside the caller's transaction.
//
// The acceptance row is locked first, so two concurrent accepts of the same
// acceptance serialize. A credential that is already live is never superseded
// by a routine retry: the rotation happens only when the caller asks for it,
// because the caller holds no working credential.
func (s *Service) mintAcceptanceCredential(ctx context.Context, tx pgx.Tx, acceptance acceptance, matchID, origin string, rotate bool) (*GuestCredential, error) {
	if acceptance.GuestID == "" {
		return nil, ErrInvalidArgument
	}
	var status string
	var storedMatch *string
	if err := tx.QueryRow(ctx, `SELECT status,match_id FROM online_invitation_acceptances WHERE acceptance_id=$1 FOR UPDATE`, acceptance.AcceptanceID).Scan(&status, &storedMatch); err != nil {
		return nil, err
	}
	live, err := s.credentials.HasLiveSeatCredential(ctx, tx, matchID, acceptance.Seat)
	if err != nil {
		return nil, err
	}
	if live && !rotate {
		return nil, nil
	}
	issued, err := s.credentials.AcceptInvitationTx(ctx, tx, onlineauth.AcceptInvitationRequest{
		MatchID: matchID,
		Seat:    acceptance.Seat,
		GuestID: acceptance.GuestID,
		Origin:  origin,
		TTL:     s.options.GuestCredentialTTL,
	})
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE online_invitation_acceptances SET status='credentialed',credential_id=$2,updated_at=$3 WHERE acceptance_id=$1`,
		acceptance.AcceptanceID, issued.Credential.CredentialID, s.now()); err != nil {
		return nil, err
	}
	return &GuestCredential{
		GuestID:      issued.Credential.GuestID,
		MatchID:      issued.Credential.MatchID,
		Seat:         issued.Credential.Seat,
		Token:        issued.Credential.Secret,
		ExpiresAt:    issued.Credential.ExpiresAt,
		CredentialID: issued.Credential.CredentialID,
	}, nil
}

// Cancel cancels an open invitation.
//
// The inviter owns the invitation through the owner token or through its
// authenticated account identity. A consumed invitation can never be
// cancelled and a cancelled invitation can never be consumed.
//
// A named challenge is private. The visibility of the caller is checked
// before the state of the invitation, so a challenge that the caller may not
// see answers exactly like an invitation that was never issued: it never
// answers with the public view of the invitation, with its status, with an
// expiry or with a conflict.
//
// The cancellation is a write that names the inviter, so it is fenced like
// every other write of the surface: the account scope lock of the inviter is
// taken before the row lock of the invitation, and the durable removal of
// the inviter is rechecked after the lock. A removed participant therefore
// never writes its own personal row again.
func (s *Service) Cancel(ctx context.Context, request CancelRequest) (Invitation, error) {
	invitation, access, err := s.readInvitation(ctx, request.InvitationID)
	if err != nil {
		return Invitation{}, err
	}
	// A closed surface still cancels the invitations it issued while it
	// was open, so the inviter can always withdraw an outstanding link.
	if err = s.servesIssued(access.issuedWhileEnabled); err != nil {
		return Invitation{}, err
	}
	// The visibility of the caller is checked before the state of the
	// invitation. A caller that may not see a named challenge learns
	// nothing about it, so the status of a challenge is never public.
	if !s.visibleTo(ctx, request.InvitationID, access, request.OwnerToken, request.Canceller) {
		return Invitation{}, ErrNotFound
	}
	if invitation.Status == StatusCancelled {
		return invitation, nil
	}
	if invitation.Status == StatusExpired {
		return Invitation{}, ErrExpired
	}
	if invitation.Status != StatusOpen {
		return Invitation{}, ErrConflict
	}
	if !s.ownsInvitation(ctx, request.InvitationID, request.OwnerToken, request.Canceller) {
		return Invitation{}, ErrNotAuthorized
	}
	inviter := online.ParticipantRef{Kind: online.ParticipantKind(invitation.inviterKind), ID: invitation.inviterID}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Invitation{}, err
	}
	closed := false
	defer func() {
		if !closed {
			_ = tx.Rollback(ctx)
		}
	}()
	if err = lockParticipants(ctx, tx, inviter); err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return Invitation{}, err
	}
	// The row is locked before the state is read, so a concurrent
	// acceptance is observed after it committed.
	var status string
	if err = tx.QueryRow(ctx, `SELECT status FROM online_friend_invitations WHERE invitation_id=$1 FOR UPDATE`, request.InvitationID).Scan(&status); err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		if errors.Is(err, pgx.ErrNoRows) {
			return Invitation{}, ErrNotFound
		}
		return Invitation{}, err
	}
	// The removal of the inviter is rechecked after the locks.
	if err = recheckParticipants(ctx, tx, "", inviter); err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return Invitation{}, err
	}
	now := s.now()
	tag, err := tx.Exec(ctx, `UPDATE online_friend_invitations SET status='cancelled',cancelled_at=$2,version=version+1 WHERE invitation_id=$1 AND status='open'`, request.InvitationID, now)
	if err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return Invitation{}, err
	}
	// A concurrent acceptance may have consumed the invitation between the
	// read and the update. The cancellation only wins when it changed the
	// row.
	if tag.RowsAffected() == 0 {
		closed = true
		_ = tx.Rollback(ctx)
		current, _, readErr := s.readInvitation(ctx, request.InvitationID)
		if readErr != nil {
			return Invitation{}, readErr
		}
		if current.Status == StatusCancelled {
			return current, nil
		}
		return Invitation{}, ErrConflict
	}
	if err = tx.Commit(ctx); err != nil {
		return Invitation{}, err
	}
	closed = true
	invitation.Status = StatusCancelled
	invitation.CancelledAt = &now
	return invitation, nil
}

// SeatCredential mints the guest seat credential of the inviter of a created
// match.
//
// A guest seat credential is bound to a match seat, so it cannot exist before
// the match exists. The owner token authorizes the request and the mint
// supersedes an earlier credential of the same seat.
//
// A named challenge is private. The visibility of the caller is checked
// before the state of the invitation, so a challenge that the caller may not
// see answers exactly like an invitation that was never issued: it never
// answers with a match, with a seat, with an expiry or with a conflict.
func (s *Service) SeatCredential(ctx context.Context, request SeatCredentialRequest) (SeatCredentialResult, error) {
	invitation, access, err := s.readInvitation(ctx, request.InvitationID)
	if err != nil {
		return SeatCredentialResult{}, err
	}
	// A closed surface still recovers the seat of a match it created, so a
	// guest inviter never loses the seat of its own invitation.
	if err = s.servesIssued(access.issuedWhileEnabled); err != nil {
		return SeatCredentialResult{}, err
	}
	// The visibility of the caller is checked before the state of the
	// invitation. A caller that may not see a named challenge learns
	// nothing about it, so the status of a challenge is never public.
	if !s.visibleTo(ctx, request.InvitationID, access, request.OwnerToken, request.Viewer) {
		return SeatCredentialResult{}, ErrNotFound
	}
	if invitation.Status != StatusConsumed || invitation.MatchID == nil {
		return SeatCredentialResult{}, ErrConflict
	}
	if !s.ownsInvitation(ctx, request.InvitationID, request.OwnerToken, nil) {
		return SeatCredentialResult{}, ErrNotAuthorized
	}
	result := SeatCredentialResult{MatchID: *invitation.MatchID, Seat: invitation.InviterSeat}
	if invitation.inviterKind != string(online.ParticipantGuest) {
		return result, nil
	}
	credential, err := s.mintSeatCredential(ctx, *invitation.MatchID, invitation.InviterSeat, online.ParticipantRef{Kind: online.ParticipantGuest, ID: invitation.inviterID}, request.Origin)
	if err != nil {
		return SeatCredentialResult{}, err
	}
	result.GuestCredential = credential
	return result, nil
}

// mintSeatCredential mints a guest seat credential in its own transaction.
//
// The account scope lock of the owner of the seat orders the mint against
// the removal of that participant, and the removal is rechecked after the
// lock. A removed participant therefore never receives a fresh credential,
// and a request that was authenticated before the removal cannot revive one
// after it.
func (s *Service) mintSeatCredential(ctx context.Context, matchID string, seat online.Seat, participant online.ParticipantRef, origin string) (*GuestCredential, error) {
	if participant.ID == "" {
		return nil, ErrInvalidArgument
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	closed := false
	defer func() {
		if !closed {
			_ = tx.Rollback(ctx)
		}
	}()
	if err = lockParticipants(ctx, tx, participant); err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return nil, err
	}
	if err = recheckParticipants(ctx, tx, matchID, participant); err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return nil, err
	}
	credential, err := s.mintSeatCredentialInTx(ctx, tx, matchID, seat, participant.ID, origin)
	if err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	closed = true
	return credential, nil
}

// mintSeatCredentialInTx mints a guest seat credential inside the caller's
// transaction.
//
// The credential and the state that records it commit together, so a
// credential is never minted without the acceptance that owns it.
func (s *Service) mintSeatCredentialInTx(ctx context.Context, tx pgx.Tx, matchID string, seat online.Seat, guestID, origin string) (*GuestCredential, error) {
	if guestID == "" {
		return nil, ErrInvalidArgument
	}
	issued, err := s.credentials.AcceptInvitationTx(ctx, tx, onlineauth.AcceptInvitationRequest{
		MatchID: matchID,
		Seat:    seat,
		GuestID: guestID,
		Origin:  origin,
		TTL:     s.options.GuestCredentialTTL,
	})
	if err != nil {
		return nil, err
	}
	return &GuestCredential{
		GuestID:      issued.Credential.GuestID,
		MatchID:      issued.Credential.MatchID,
		Seat:         issued.Credential.Seat,
		Token:        issued.Credential.Secret,
		ExpiresAt:    issued.Credential.ExpiresAt,
		CredentialID: issued.Credential.CredentialID,
	}, nil
}

// ProposeRematch proposes a new game after a finished match.
//
// The proposal is the proposer's consent. The opponent accepts the exact
// offer, and only then a new match exists. The colors are reversed and the
// setup is retained unless the proposal changes it.
func (s *Service) ProposeRematch(ctx context.Context, request RematchRequest) (Rematch, error) {
	// A rematch creates a new game, so a closed surface refuses it. The
	// refusal stops new creations and it never invalidates a finished match.
	if !s.friendsEnabled() {
		return Rematch{}, ErrDisabled
	}
	match, err := s.reader.GetMatch(ctx, request.MatchID)
	if err != nil {
		return Rematch{}, err
	}
	if match.Status == online.MatchActive {
		return Rematch{}, fmt.Errorf("%w: the match is still running", ErrConflict)
	}
	if !match.HasParticipant(request.Proposer) {
		return Rematch{}, ErrNotAuthorized
	}
	// A rematch carries the setup of the finished match, and a friend game
	// has no built-in engine seat. The guard runs before any offer is
	// written, so an offer that names an engine participant is never
	// persisted.
	if err := validateRematchSetup(match); err != nil {
		return Rematch{}, err
	}
	label := strings.TrimSpace(request.ProposerLabel)
	if label == "" {
		label = GuestLabel
	}
	if err := validatePublicLabel(label); err != nil {
		return Rematch{}, err
	}
	timeControl := match.TimeControl
	if request.TimeControl != nil {
		timeControl = *request.TimeControl
	}
	if err := validateTimeControl(timeControl); err != nil {
		return Rematch{}, err
	}
	startingFEN := match.StartingFEN
	if request.StartingFEN != nil {
		startingFEN = strings.TrimSpace(*request.StartingFEN)
	}
	proposerSeat, err := seatOf(match, request.Proposer)
	if err != nil {
		return Rematch{}, err
	}
	// A rematch reverses the colors: the proposer plays the seat the
	// opponent held in the finished match.
	proposerSeat = reversedSeat(proposerSeat)
	if startingFEN != "" {
		if err := s.validatePosition(ctx, startingFEN, timeControl, request.Proposer, label, online.SeatControl{Kind: online.ControlHuman}); err != nil {
			return Rematch{}, err
		}
	}
	rematchID, err := s.options.Identifier("rmt_", 24)
	if err != nil {
		return Rematch{}, err
	}
	now := s.now()
	expiresAt := now.Add(s.options.InvitationTTL)
	// The account scope locks of the participants of the finished match come
	// first. The removal of a participant takes the same lock and then the
	// row locks of the rows it sanitizes, so the scope locks have to be
	// taken before the row lock of the superseded offer.
	participants := seatParticipants(match)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Rematch{}, err
	}
	closed := false
	defer func() {
		if !closed {
			_ = tx.Rollback(ctx)
		}
	}()
	if err = lockParticipants(ctx, tx, participants...); err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return Rematch{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE online_rematch_offers SET status='superseded',version=version+1,updated_at=$2 WHERE match_id=$1 AND status IN ('pending','accepting')`, request.MatchID, now); err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return Rematch{}, err
	}
	// The removal of a participant is rechecked after the locks, so a
	// request that was authenticated before the removal cannot create a
	// personal row after it. The finished match is the match the new game
	// is about, so the removal ledger of that match refuses the proposal
	// when a participant of it was removed.
	if err = recheckParticipants(ctx, tx, request.MatchID, participants...); err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return Rematch{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_rematch_offers(rematch_id,match_id,proposer_kind,proposer_id,proposer_public_label,proposer_seat,starting_time_ms,increment_ms,starting_fen,status,version,created_at,updated_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',1,$10,$10,$11)`,
		rematchID, request.MatchID, string(request.Proposer.Kind), request.Proposer.ID, label, string(proposerSeat),
		timeControl.StartingTimeMs, timeControl.IncrementMs, nullableString(startingFEN), now, expiresAt); err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return Rematch{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Rematch{}, err
	}
	closed = true
	return Rematch{
		RematchID:     rematchID,
		MatchID:       request.MatchID,
		Status:        RematchPending,
		ProposerLabel: label,
		ProposerSeat:  proposerSeat,
		TimeControl:   timeControl,
		StartingFEN:   startingFEN,
		ExpiresAt:     expiresAt,
		CreatedAt:     now,
		proposerKind:  string(request.Proposer.Kind),
		proposerID:    request.Proposer.ID,
	}, nil
}

// AcceptRematch accepts a rematch offer and creates the new match.
//
// The offer, the new match and the guest seat credential of the accepter
// commit in one transaction. A crash can never leave a durable reservation
// without a game, and a concurrent supersede, an expiry or a second
// acceptance can never produce a second match.
//
// A duplicate acceptance returns the same new match. A guest accepter that
// lost the answer receives a fresh credential of the new match, because the
// credential of the finished match cannot authorize the new seat.
//
// The new match is a new game, so a guest participant needs a fresh seat
// credential for it: the credential of the finished match cannot authorize
// the new seat.
func (s *Service) AcceptRematch(ctx context.Context, request AcceptRematchRequest) (RematchResult, error) {
	// A rematch creates a new game, so a closed surface refuses it. The
	// offer stays pending, so the rollback is reversible.
	if !s.friendsEnabled() {
		return RematchResult{}, ErrDisabled
	}
	offer, err := s.readRematch(ctx, request.RematchID)
	if err != nil {
		return RematchResult{}, err
	}
	match, err := s.reader.GetMatch(ctx, offer.MatchID)
	if err != nil {
		return RematchResult{}, err
	}
	if !match.HasParticipant(request.Acceptor) {
		return RematchResult{}, ErrNotAuthorized
	}
	if offer.proposerID == request.Acceptor.ID && offer.proposerKind == string(request.Acceptor.Kind) {
		return RematchResult{}, fmt.Errorf("%w: the proposer is already consenting", ErrConflict)
	}
	oldSeat, err := seatOf(match, request.Acceptor)
	if err != nil {
		return RematchResult{}, err
	}
	newSeat := reversedSeat(oldSeat)
	// The proposer of the offer is a participant of the finished match, and
	// the privacy sanitation replaces its identifier with the anonymized
	// sentinel, so it is checked as well.
	proposer := online.ParticipantRef{Kind: online.ParticipantKind(offer.proposerKind), ID: offer.proposerID}
	// The account scope locks of the participants of the finished match come
	// first. The removal of a participant takes the same lock and then the
	// row locks of the rows it sanitizes, so the scope locks have to be
	// taken before the row lock of the offer.
	participants := seatParticipants(match)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return RematchResult{}, err
	}
	closed := false
	defer func() {
		if !closed {
			_ = tx.Rollback(ctx)
		}
	}()
	if err = lockParticipants(ctx, tx, append(participants, proposer)...); err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return RematchResult{}, err
	}
	// The offer is locked before its state is read, so a concurrent
	// supersede or a second acceptance is observed after it committed.
	locked, err := s.lockRematch(ctx, tx, request.RematchID)
	if err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return RematchResult{}, err
	}
	switch locked.Status {
	case RematchAccepted:
		// The offer is already accepted. The duplicate acceptance returns
		// the same new match and creates no second one.
		if locked.NewMatchID == nil {
			closed = true
			_ = tx.Rollback(ctx)
			return RematchResult{}, ErrConflict
		}
		// The duplicate acceptance is the recovery of a lost answer: it
		// creates no match and it writes the credential of the seat of the
		// accepter in the new match. It therefore names the accepter alone,
		// exactly like the resumed acceptance of an invitation. The removal
		// of the opponent does not take the seat of the survivor away.
		if err = recheckParticipants(ctx, tx, *locked.NewMatchID, request.Acceptor); err != nil {
			closed = true
			_ = tx.Rollback(ctx)
			return RematchResult{}, err
		}
		accepted := RematchResult{Rematch: locked, MatchID: *locked.NewMatchID, Seat: newSeat}
		if request.Acceptor.Kind == online.ParticipantGuest {
			credential, mintErr := s.mintRematchCredential(ctx, tx, *locked.NewMatchID, newSeat, request.Acceptor.ID, request.Origin, request.RotateCredential, request.CredentialMatchID)
			if mintErr != nil {
				closed = true
				_ = tx.Rollback(ctx)
				return RematchResult{}, mintErr
			}
			accepted.GuestCredential = credential
		}
		if err = tx.Commit(ctx); err != nil {
			return RematchResult{}, err
		}
		closed = true
		return accepted, nil
	case RematchPending, RematchAccepting:
		// The offer may still be accepted. The acceptance creates the new
		// match of both participants, so both of them have to consent: the
		// removal of either of them is refused before the match is created.
		//
		// The removal of a participant is rechecked after the locks, so a
		// request that was authenticated before the removal cannot accept
		// an offer or create a personal row after it. The finished match is
		// the match the new game is about, so the removal ledger of that
		// match refuses the acceptance when a participant of it was
		// removed, and the proposer of the offer is checked as well,
		// because the sanitation replaced its identifier with the
		// anonymized sentinel.
		if err = recheckParticipants(ctx, tx, offer.MatchID, append(participants, proposer)...); err != nil {
			closed = true
			_ = tx.Rollback(ctx)
			return RematchResult{}, err
		}
	default:
		closed = true
		_ = tx.Rollback(ctx)
		return RematchResult{}, ErrConflict
	}
	now := s.now()
	if !now.Before(locked.ExpiresAt) {
		closed = true
		_ = tx.Rollback(ctx)
		return RematchResult{}, ErrExpired
	}
	// A reservation of an earlier build names its accepter. Only that
	// accepter may complete the offer, because the consent of the opponent
	// was already given.
	if locked.Status == RematchAccepting && locked.acceptedByID != "" && !rematchAccepterMatches(locked, request.Acceptor) {
		closed = true
		_ = tx.Rollback(ctx)
		return RematchResult{}, ErrConflict
	}
	// An offer of an earlier build may name a match that carries an engine
	// seat, for example a queue fallback match against the browser
	// Stockfish. The guard runs before the new match is created, so such an
	// offer creates no match at all and it stays pending.
	if err = validateRematchSetup(match); err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return RematchResult{}, err
	}
	white, black, err := rematchSeats(match, locked)
	if err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return RematchResult{}, err
	}
	startingFEN := locked.StartingFEN
	if startingFEN == "" {
		startingFEN = StandardStartingFEN
	}
	setup := online.CreateMatchSetup{
		Variant:     "orthodox",
		StartingFEN: startingFEN,
		TimeControl: locked.TimeControl,
		Seats:       online.CreateMatchSeats{White: white, Black: black},
	}
	// The actor of the allocation is fixed by the offer, not by the
	// accepter. The match identifier is derived from the actor and the
	// offer, so a retry of the acceptance always names the same match.
	actor := white.Participant
	cmd, err := online.NewAllocationCommand(actor, setup, "rmt"+locked.RematchID)
	if err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return RematchResult{}, err
	}
	result, err := s.matches.CreateMatchInTx(ctx, tx, cmd)
	if err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return RematchResult{}, err
	}
	matchID := result.Receipt.MatchID
	// The offer is consumed by the acceptance in the same transaction as
	// the new match, so a crash leaves the offer open for the opponent
	// instead of stranding it.
	tag, err := tx.Exec(ctx, `UPDATE online_rematch_offers SET status='accepted',accepted_by_kind=$2,accepted_by_id=$3,new_match_id=$4,version=version+1,updated_at=$5 WHERE rematch_id=$1 AND status IN ('pending','accepting')`,
		request.RematchID, string(request.Acceptor.Kind), request.Acceptor.ID, matchID, s.now())
	if err != nil {
		closed = true
		_ = tx.Rollback(ctx)
		return RematchResult{}, err
	}
	if tag.RowsAffected() == 0 {
		closed = true
		_ = tx.Rollback(ctx)
		return RematchResult{}, ErrConflict
	}
	accepted := RematchResult{Rematch: locked, MatchID: matchID, Seat: newSeat}
	if request.Acceptor.Kind == online.ParticipantGuest {
		credential, mintErr := s.mintRematchCredential(ctx, tx, matchID, newSeat, request.Acceptor.ID, request.Origin, request.RotateCredential, request.CredentialMatchID)
		if mintErr != nil {
			closed = true
			_ = tx.Rollback(ctx)
			return RematchResult{}, mintErr
		}
		accepted.GuestCredential = credential
	}
	if err = tx.Commit(ctx); err != nil {
		return RematchResult{}, err
	}
	closed = true
	accepted.Rematch.Status = RematchAccepted
	accepted.Rematch.NewMatchID = &matchID
	return accepted, nil
}

// mintRematchCredential mints the guest seat credential of a rematch seat
// inside the caller's transaction.
//
// The credential of the finished match cannot authorize the new match, so a
// guest participant needs a fresh credential for the new seat.
//
// A routine retry never supersedes a credential another request already
// delivered. The credential is minted when the seat has no live credential,
// when the caller asks for the rotation, or when the credential the caller
// presented belongs to another match, so the caller cannot use what it holds
// to play the new game.
func (s *Service) mintRematchCredential(ctx context.Context, tx pgx.Tx, matchID string, seat online.Seat, guestID, origin string, rotate bool, presentedMatchID string) (*GuestCredential, error) {
	if guestID == "" {
		return nil, ErrInvalidArgument
	}
	live, err := s.credentials.HasLiveSeatCredential(ctx, tx, matchID, seat)
	if err != nil {
		return nil, err
	}
	if live && !rotate && presentedMatchID == matchID {
		return nil, nil
	}
	return s.mintSeatCredentialInTx(ctx, tx, matchID, seat, guestID, origin)
}

// RematchSeatCredential mints the guest seat credential of the proposer of an
// accepted rematch.
//
// The new match is a new game, so the credential of the finished match cannot
// authorize it.
//
// The mint is a recovery of a seat of a match that already exists, so a
// closed surface still serves it: the rollback never removes an issued guest
// credential and never strands a guest on a seat it owns.
func (s *Service) RematchSeatCredential(ctx context.Context, request RematchSeatCredentialRequest) (SeatCredentialResult, error) {
	offer, err := s.readRematch(ctx, request.RematchID)
	if err != nil {
		return SeatCredentialResult{}, err
	}
	if offer.Status != RematchAccepted || offer.NewMatchID == nil {
		return SeatCredentialResult{}, ErrConflict
	}
	if offer.proposerKind != string(request.Proposer.Kind) || offer.proposerID != request.Proposer.ID {
		return SeatCredentialResult{}, ErrNotAuthorized
	}
	match, err := s.reader.GetMatch(ctx, offer.MatchID)
	if err != nil {
		return SeatCredentialResult{}, err
	}
	oldSeat, err := seatOf(match, request.Proposer)
	if err != nil {
		return SeatCredentialResult{}, err
	}
	newSeat := reversedSeat(oldSeat)
	result := SeatCredentialResult{MatchID: *offer.NewMatchID, Seat: newSeat}
	if request.Proposer.Kind != online.ParticipantGuest {
		return result, nil
	}
	credential, err := s.mintSeatCredential(ctx, *offer.NewMatchID, newSeat, request.Proposer, request.Origin)
	if err != nil {
		return SeatCredentialResult{}, err
	}
	result.GuestCredential = credential
	return result, nil
}

// PendingRematch returns the pending rematch offer of a finished match.
//
// The read is a projection: it never writes. An offer that can never be
// accepted any more is filtered out of the answer, so a dead offer is never
// published as the live offer of the match.
//
// A dead offer is an offer whose deadline passed and an offer of a removed
// participant. Neither of them can be accepted, so neither of them is
// published. A published offer is therefore an offer the opponent can still
// accept, and the proposer of it still reads it to observe its acceptance.
//
// A read that retired the offer instead would write the personal row of a
// removed subject from a `GET` route, without the account scope lock that
// orders every other write of the surface against the removal. The offer
// keeps its row until the privacy sanitation of its proposer rewrites it, and
// the acceptance of it is refused anyway.
//
// The read is served while the surface is closed. It creates nothing, and an
// offer that exists was proposed while the surface was open.
func (s *Service) PendingRematch(ctx context.Context, matchID string, participant online.ParticipantRef) (Rematch, bool, error) {
	match, err := s.reader.GetMatch(ctx, matchID)
	if err != nil {
		return Rematch{}, false, err
	}
	if !match.HasParticipant(participant) {
		return Rematch{}, false, ErrNotAuthorized
	}
	// A pending offer whose deadline passed is dead: the acceptance of it is
	// refused with the expiry of its deadline, and no sweep ever writes that
	// state. The deadline is a property of the offer, exactly like the
	// deadline of an invitation, so the read filters it the way it filters
	// the offer of a removed participant. The row of the offer stays, and the
	// read never writes it.
	//
	// An accepted offer stays published. Its acceptance already happened, and
	// the proposer reads it to claim the seat of the new match.
	row := s.db.QueryRow(ctx, `SELECT `+rematchColumns+` FROM online_rematch_offers WHERE match_id=$1 AND status IN ('pending','accepting','accepted') AND (status='accepted' OR expires_at > $2) ORDER BY created_at DESC LIMIT 1`, matchID, s.now())
	offer, err := scanRematch(row)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return Rematch{}, false, nil
		}
		return Rematch{}, false, err
	}
	retired, err := s.offerRetired(ctx, s.db, offer, match)
	if err != nil {
		return Rematch{}, false, err
	}
	if retired {
		return Rematch{}, false, nil
	}
	return offer, true, nil
}

// offerRetired reports whether an offer can never be accepted any more.
//
// An offer is retired when one of the participants of its match was removed.
// The removed participant cannot consent, and a new match would seat a
// subject that no longer exists.
func (s *Service) offerRetired(ctx context.Context, q online.Querier, offer Rematch, match online.Match) (bool, error) {
	participants := seatParticipants(match)
	proposer := online.ParticipantRef{Kind: online.ParticipantKind(offer.proposerKind), ID: offer.proposerID}
	return removedParticipants(ctx, q, offer.MatchID, append(participants, proposer)...)
}

// acceptance is the stored acceptance of one invitation.
type acceptance struct {
	AcceptanceID  string
	InvitationID  string
	AcceptorKind  string
	AcceptorID    string
	AcceptorLabel string
	GuestID       string
	Seat          online.Seat
	ControlKind   string
	ModelLabel    *string
	Status        string
	MatchID       *string
}

// acceptanceByKey loads the acceptance of one idempotency key.
//
// The key is compared as a hash. The stored row never holds the capability.
//
// The lookup runs against the caller's querier. The claim passes its own
// transaction, so a contended acceptance never reaches for a second
// connection while it holds the lock of the invitation row.
func (s *Service) acceptanceByKey(ctx context.Context, q online.Querier, invitationID string, keyHash []byte) (acceptance, error) {
	row := q.QueryRow(ctx, `SELECT acceptance_id,invitation_id,acceptor_kind,acceptor_id,acceptor_public_label,COALESCE(guest_id,''),seat,control_kind,model_label,status,match_id FROM online_invitation_acceptances WHERE invitation_id=$1 AND acceptance_key_hash=$2`, invitationID, keyHash)
	var (
		record      acceptance
		modelLabel  *string
		matchID     *string
		seat        string
		controlKind string
	)
	err := row.Scan(&record.AcceptanceID, &record.InvitationID, &record.AcceptorKind, &record.AcceptorID, &record.AcceptorLabel, &record.GuestID, &seat, &controlKind, &modelLabel, &record.Status, &matchID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return acceptance{}, ErrNotFound
		}
		return acceptance{}, err
	}
	record.Seat = online.Seat(seat)
	record.ControlKind = controlKind
	record.ModelLabel = modelLabel
	record.MatchID = matchID
	return record, nil
}

// invitationAccess is the private access data of one invitation.
//
// It is never published: it names the recipient of a challenge and it records
// that the invitation was issued while the friend surface was open.
type invitationAccess struct {
	// recipient is the named recipient of a challenge. It is empty for a
	// shareable link.
	recipient string
	// issuedWhileEnabled records that the invitation was issued while the
	// friend surface was open, so a closed surface still finishes it.
	issuedWhileEnabled bool
}

// readInvitation loads one invitation and its private access data.
//
// The status of the invitation is the effective status: an open invitation
// whose deadline passed is expired, even though no sweep ever wrote that
// state. The expiry is a property of the deadline, not of a stored row, so a
// link nobody touched still reports that it expired.
func (s *Service) readInvitation(ctx context.Context, invitationID string) (Invitation, invitationAccess, error) {
	if strings.TrimSpace(invitationID) == "" {
		return Invitation{}, invitationAccess{}, ErrInvalidArgument
	}
	row := s.db.QueryRow(ctx, `SELECT invitation_id,kind,status,inviter_public_label,inviter_seat,inviter_control_kind,inviter_model_label,starting_time_ms,increment_ms,starting_fen,recipient_account_id,expires_at,created_at,consumed_at,cancelled_at,match_id,inviter_kind,inviter_id,acceptance_id,issued_while_enabled FROM online_friend_invitations WHERE invitation_id=$1`, invitationID)
	invitation, recipient, issued, err := scanInvitation(row)
	if err != nil {
		return Invitation{}, invitationAccess{}, err
	}
	invitation.Status = s.effectiveStatus(invitation.Status, invitation.ExpiresAt)
	return invitation, invitationAccess{recipient: recipient, issuedWhileEnabled: issued}, nil
}

// effectiveStatus returns the status an invitation has right now.
//
// Only an open invitation can expire. A consumed, a cancelled and an already
// expired invitation keep the state they have.
func (s *Service) effectiveStatus(status Status, expiresAt time.Time) Status {
	if status != StatusOpen {
		return status
	}
	if !s.now().Before(expiresAt) {
		return StatusExpired
	}
	return status
}

// scanInvitation reads one invitation row.
//
// The named recipient and the issued enablement of the invitation are
// returned beside the public view: they are private access data and they
// never reach an answer.
func scanInvitation(row pgx.Row) (Invitation, string, bool, error) {
	var (
		invitation  Invitation
		kind        string
		status      string
		seat        string
		controlKind string
		modelLabel  *string
		startingFEN *string
		recipient   *string
		matchID     *string
		acceptance  *string
		issued      bool
	)
	err := row.Scan(&invitation.InvitationID, &kind, &status, &invitation.InviterLabel, &seat, &controlKind, &modelLabel,
		&invitation.TimeControl.StartingTimeMs, &invitation.TimeControl.IncrementMs, &startingFEN, &recipient,
		&invitation.ExpiresAt, &invitation.CreatedAt, &invitation.ConsumedAt, &invitation.CancelledAt, &matchID,
		&invitation.inviterKind, &invitation.inviterID, &acceptance, &issued)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Invitation{}, "", false, ErrNotFound
		}
		return Invitation{}, "", false, err
	}
	invitation.Kind = Kind(kind)
	invitation.Status = Status(status)
	invitation.InviterSeat = online.Seat(seat)
	invitation.InviterControl = online.SeatControl{Kind: online.ControlKind(controlKind), ModelLabel: modelLabel}
	if startingFEN != nil {
		invitation.StartingFEN = *startingFEN
	}
	invitation.MatchID = matchID
	if acceptance != nil {
		invitation.AcceptanceID = *acceptance
	}
	name := ""
	if recipient != nil {
		name = *recipient
	}
	return invitation, name, issued, nil
}

// scanRematch reads one rematch offer row.
func scanRematch(row pgx.Row) (Rematch, error) {
	var (
		offer          Rematch
		status         string
		seat           string
		startingFEN    *string
		acceptedByKind *string
		acceptedByID   *string
	)
	err := row.Scan(&offer.RematchID, &offer.MatchID, &status, &offer.ProposerLabel, &seat, &offer.TimeControl.StartingTimeMs, &offer.TimeControl.IncrementMs, &startingFEN, &offer.ExpiresAt, &offer.NewMatchID, &offer.CreatedAt, &offer.proposerKind, &offer.proposerID, &acceptedByKind, &acceptedByID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Rematch{}, ErrNotFound
		}
		return Rematch{}, err
	}
	offer.Status = RematchStatus(status)
	offer.ProposerSeat = online.Seat(seat)
	if startingFEN != nil {
		offer.StartingFEN = *startingFEN
	}
	if acceptedByKind != nil {
		offer.acceptedByKind = *acceptedByKind
	}
	if acceptedByID != nil {
		offer.acceptedByID = *acceptedByID
	}
	return offer, nil
}

// rematchColumns are the columns of one rematch offer row.
//
// Every reader of an offer selects the same columns, so one scanner reads
// every offer.
const rematchColumns = `rematch_id,match_id,status,proposer_public_label,proposer_seat,starting_time_ms,increment_ms,starting_fen,expires_at,new_match_id,created_at,proposer_kind,proposer_id,accepted_by_kind,accepted_by_id`

// readRematch loads one rematch offer.
func (s *Service) readRematch(ctx context.Context, rematchID string) (Rematch, error) {
	row := s.db.QueryRow(ctx, `SELECT `+rematchColumns+` FROM online_rematch_offers WHERE rematch_id=$1`, rematchID)
	return scanRematch(row)
}

// lockRematch locks one rematch offer and reads its durable state.
//
// The lock serializes the acceptance of an offer, the supersede of a newer
// proposal and a second acceptance of the same offer. Every read runs on the
// caller's transaction, so a contention never reaches for a second
// connection of the pool while it holds the lock.
func (s *Service) lockRematch(ctx context.Context, tx pgx.Tx, rematchID string) (Rematch, error) {
	row := tx.QueryRow(ctx, `SELECT `+rematchColumns+` FROM online_rematch_offers WHERE rematch_id=$1 FOR UPDATE`, rematchID)
	return scanRematch(row)
}

// OwnsInvitation reports whether the caller owns the invitation.
//
// It is a read-only proof of the ownership. It changes nothing, it opens no
// transaction and it answers no state of the invitation: the caller learns
// whether it owns the invitation and nothing else.
//
// The owner token authorizes the owner alone, and the authenticated inviter
// authorizes itself. The proof never fails open: a lookup that cannot answer
// is answered false, so a caller that cannot prove the ownership is refused
// like a caller that owns nothing.
func (s *Service) OwnsInvitation(ctx context.Context, invitationID, ownerToken string, owner *Identity) bool {
	if strings.TrimSpace(invitationID) == "" {
		return false
	}
	return s.ownsInvitation(ctx, invitationID, ownerToken, owner)
}

// ownsInvitation reports whether the caller owns the invitation.
func (s *Service) ownsInvitation(ctx context.Context, invitationID, ownerToken string, canceller *Identity) bool {
	if ownerToken != "" {
		var stored []byte
		err := s.db.QueryRow(ctx, `SELECT owner_token_hash FROM online_friend_invitations WHERE invitation_id=$1`, invitationID).Scan(&stored)
		if err == nil && len(stored) == 32 {
			if subtleEqual(hashOwnerToken(ownerToken), stored) {
				return true
			}
		}
	}
	if canceller != nil {
		var (
			kind string
			id   string
		)
		err := s.db.QueryRow(ctx, `SELECT inviter_kind,inviter_id FROM online_friend_invitations WHERE invitation_id=$1`, invitationID).Scan(&kind, &id)
		if err == nil && kind == string(canceller.Participant.Kind) && id == canceller.Participant.ID {
			return true
		}
	}
	return false
}

// visibleTo reports whether the caller may learn that the invitation exists.
//
// A shareable link is public: everybody who holds the link may read it, so
// the visibility of a link is always granted.
//
// A named challenge is private. Only its named recipient and its inviter may
// learn that it exists. The named recipient is the account the challenge
// names, and the inviter proves the ownership with the owner token of the
// invitation or with its own authenticated identity.
//
// The proof never fails open. A caller that cannot prove the visibility of a
// challenge is refused exactly like a caller that named an invitation that
// was never issued, so the existence and the status of a challenge stay
// private.
func (s *Service) visibleTo(ctx context.Context, invitationID string, access invitationAccess, ownerToken string, viewer *Identity) bool {
	if access.recipient == "" {
		return true
	}
	if viewer != nil && viewer.Participant.Kind == online.ParticipantAccount && viewer.Participant.ID == access.recipient {
		return true
	}
	return s.ownsInvitation(ctx, invitationID, ownerToken, viewer)
}

// seatOf returns the seat a participant holds in a match.
func seatOf(match online.Match, participant online.ParticipantRef) (online.Seat, error) {
	for _, seat := range match.Seats {
		if seat.Participant == participant {
			return seat.Seat, nil
		}
	}
	return "", ErrNotAuthorized
}

// reversedSeat returns the other seat. A rematch reverses the colors.
func reversedSeat(seat online.Seat) online.Seat {
	other, ok := seat.Other()
	if !ok {
		return seat
	}
	return other
}

// rematchSeats builds the seats of the new match of a rematch.
//
// The colors are reversed and the setup of both participants is retained.
func rematchSeats(match online.Match, offer Rematch) (online.CreateSeat, online.CreateSeat, error) {
	white, ok := match.Seat(online.SeatWhite)
	if !ok {
		return online.CreateSeat{}, online.CreateSeat{}, ErrNotFound
	}
	black, ok := match.Seat(online.SeatBlack)
	if !ok {
		return online.CreateSeat{}, online.CreateSeat{}, ErrNotFound
	}
	newWhite := online.CreateSeat{Participant: black.Participant, PublicLabel: black.PublicLabel, Control: black.Control}
	newBlack := online.CreateSeat{Participant: white.Participant, PublicLabel: white.PublicLabel, Control: white.Control}
	return newWhite, newBlack, nil
}

// validateRematchSetup checks that the setup of a finished match can be
// carried into a friend rematch.
//
// A friend game seats a human or the owner of its own agent. There is no
// built-in engine seat in friend play, so a match that holds one (a queue
// fallback match plays its owner against the browser Stockfish) cannot be
// rematched as a friend game: the engine participant has no friend consent
// path and no engine seat client, so an offer that named it could never be
// completed by a second consent.
//
// The refusal is the contract error of the friend surface, so the browser
// reads it as a request it cannot make.
func validateRematchSetup(match online.Match) error {
	for _, seat := range match.Seats {
		if err := validateSeatControl(seat.Control); err != nil {
			return fmt.Errorf("%w: the finished match carries a seat that a friend game cannot seat", err)
		}
	}
	return nil
}

// validateTimeControl checks the clock of a friend game.
func validateTimeControl(timeControl online.TimeControl) error {
	if timeControl.StartingTimeMs < 1 || timeControl.StartingTimeMs > 86_400_000 {
		return fmt.Errorf("%w: time control", ErrInvalidContract)
	}
	if timeControl.IncrementMs < 0 || timeControl.IncrementMs > 60_000 {
		return fmt.Errorf("%w: time control", ErrInvalidContract)
	}
	return nil
}

// validateSeatControl checks the declared control of a friend seat.
//
// A friend seat is a human seat or the seat of the owner's own agent. There
// is no built-in engine seat in friend setup.
func validateSeatControl(control online.SeatControl) error {
	switch control.Kind {
	case online.ControlHuman:
		if control.ModelLabel != nil {
			return fmt.Errorf("%w: a human seat declares no model", ErrInvalidContract)
		}
		return nil
	case online.ControlAgent:
		if control.ModelLabel == nil || !publicLabelShape(*control.ModelLabel) {
			return fmt.Errorf("%w: the agent seat needs a public model label", ErrInvalidContract)
		}
		return nil
	default:
		return fmt.Errorf("%w: a friend seat is a human seat or an agent seat", ErrInvalidContract)
	}
}

// validatePublicLabel checks a public label.
func validatePublicLabel(label string) error {
	if !publicLabelShape(label) {
		return fmt.Errorf("%w: public label", ErrInvalidContract)
	}
	return nil
}

// publicLabelShape rejects a label that could publish an email address or a
// private endpoint.
func publicLabelShape(label string) bool {
	if label == "" || len(label) > 64 || strings.TrimSpace(label) != label {
		return false
	}
	for _, r := range label {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return !strings.Contains(label, "@") && !strings.Contains(label, "://")
}

// acceptanceKeyShape is the shape of a client-supplied idempotency key.
var acceptanceKeyShape = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// validateAcceptanceKey checks the idempotency key of an acceptance.
func validateAcceptanceKey(key string) error {
	if !acceptanceKeyShape.MatchString(key) {
		return fmt.Errorf("%w: the acceptance key must be 16 to 128 characters of letters, digits, dash or underscore", ErrInvalidContract)
	}
	return nil
}

// hashDomain separates the stored hash of one secret kind from another.
const hashDomain = "kamkm.online.invite.v1:"

// hashOwnerToken derives the stored hash of an owner token.
func hashOwnerToken(secret string) []byte {
	sum := sha256.Sum256([]byte(hashDomain + "owner-token:" + secret))
	return sum[:]
}

// hashAcceptanceKey derives the stored hash of an acceptance key.
//
// The key is the only capability that resumes an acceptance, so only its hash
// is stored. A leaked database row can never resume an acceptance.
func hashAcceptanceKey(key string) []byte {
	sum := sha256.Sum256([]byte(hashDomain + "acceptance-key:" + key))
	return sum[:]
}

// subtleEqual compares two hashes without an early exit.
func subtleEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := range a {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}

// nullableString maps an empty value to SQL NULL.
func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// matchIDOf returns the identifier of an optional match reference.
func matchIDOf(matchID *string) string {
	if matchID == nil {
		return ""
	}
	return *matchID
}

// randomIdentifier mints a stored identifier.
func randomIdentifier(prefix string, length int) (string, error) {
	raw := make([]byte, length)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("invite: secure random source unavailable")
	}
	return prefix + base64.RawURLEncoding.EncodeToString(raw), nil
}

// randomSecret mints a bearer secret.
func randomSecret(prefix string, length int) (string, error) {
	raw := make([]byte, length)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("invite: secure random source unavailable")
	}
	return prefix + base64.RawURLEncoding.EncodeToString(raw), nil
}
