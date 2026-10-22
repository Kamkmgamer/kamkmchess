// Package queue implements the public matchmaking queue for casual online
// chess (KHA-76).
//
// The queue is account-only and explicit. One entry is one person's request
// for one game: an entry is consumed once, it produces exactly one game, and
// completing a game never queues another one.
//
// The allocation is a single authoritative decision. Candidate selection,
// reservation, cancellation and the browser engine fallback are serialized
// per time-control bucket, so a delayed timer, a competing matchmaker and a
// cancellation observe the same order and one entry can never produce two
// games.
//
// The rules the queue owns:
//
//   - Only an account enters the queue. A guest is refused.
//   - Two entries match when they have the same starting time and increment,
//     different owners and at least one agent seat.
//   - The oldest eligible entry is preferred, colors are random and the
//     starting position is the standard one. A custom position never enters
//     the queue.
//   - The ready acceptance of an entry starts its ten-second window. The
//     original cutoff never moves, so a delayed timer resolves the deadline
//     the owner was promised.
//   - A candidate that is ready exactly at the cutoff wins over the engine
//     fallback. A candidate that becomes ready after the cutoff never
//     replaces a committed opponent.
//   - A candidate that is dropped after it was selected is never consumed,
//     and it never hands the seat to the engine. The scan runs again at the
//     decision time, so a candidate that is still eligible wins over the
//     engine.
//   - An entry whose owner stops responding expires and needs an explicit
//     rejoin.
//   - There is no owner concurrency cap. An owner may hold any number of
//     entries and games.
//   - The credential of the engine seat is issued once. The check for a live
//     credential and the write of a credential are one decision of the
//     issuer, so a routine retry never rotates a secret the browser holds,
//     and two tabs of one entry never revoke each other's secret. Only an
//     explicit recovery rotates the credential on purpose.
package queue

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/locks"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/subject"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// StandardStartingPosition is the only starting position a queue game
	// uses. A custom position stays in friend play.
	StandardStartingPosition = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

	// DefaultSearchWindow is the window that starts at the authoritative
	// ready acceptance of an entry.
	DefaultSearchWindow = 10 * time.Second

	// DefaultReadinessTTL is how long one heartbeat keeps a waiting entry
	// eligible. It matches the participant liveness lease.
	DefaultReadinessTTL = 15 * time.Second

	// DefaultEngineLabel is the public label of the browser fallback
	// engine. The fallback is always identified as the engine and never as
	// another person's agent.
	DefaultEngineLabel = "Stockfish 19 Lite"

	// DefaultOwnerLabel is the public label of an owner who has not chosen
	// a public name yet.
	DefaultOwnerLabel = "Player"
)

var (
	// ErrNotFound means the entry does not exist or does not belong to the
	// caller. Both answers are the same, so a caller cannot learn whether
	// an entry of somebody else exists.
	ErrNotFound = errors.New("queue: entry not found")

	// ErrConflict means the entry is not in a state that allows the
	// operation.
	ErrConflict = errors.New("queue: entry state does not allow the operation")

	// ErrInvalidRequest means the request itself is not valid.
	ErrInvalidRequest = errors.New("queue: invalid request")

	// ErrNoCandidate means no compatible candidate is available right now.
	// It is not an error of the entry.
	ErrNoCandidate = errors.New("queue: no compatible candidate")

	// ErrOperationReuse means an operation identifier was reused for a
	// different request.
	ErrOperationReuse = errors.New("queue: operation identifier reused")

	// ErrUnavailable means the queue cannot serve the request right now.
	ErrUnavailable = errors.New("queue: unavailable")

	// ErrAccountRemoved means the account of the caller was removed. The
	// removal is durable, so the account can never write queue state again.
	ErrAccountRemoved = errors.New("queue: the account was removed")
)

// errFallbackPending means the search window of an entry ended without a
// compatible candidate and the entry now waits for the browser engine
// fallback.
//
// It wraps ErrNoCandidate, because no candidate was available, and it is
// only reported by the reconciliation loop: the loop records the pending
// fallback under the bucket lock, so a kept search that won the interval is
// never overwritten.
var errFallbackPending = errors.New("queue: the cutoff was reached without a candidate")

// errCandidateRetry means the decision has to be repeated.
//
// A candidate was eligible when the decision ran, but the decision could not
// pair it: the account scope of its owner is not held by the decision, and a
// scope lock that is taken after a row lock would break the lock order of
// the queue. The decision refuses itself instead of consuming a candidate it
// may not lock, and the caller repeats it with the scope set of the
// candidate.
//
// The refusal is never a missing candidate: a candidate exists, and the
// caller has to ask again instead of believing that the queue is empty.
var errCandidateRetry = errors.New("queue: the allocation has to be repeated")

// MatchAllocator is the trusted seam to the canonical match writer.
//
// The queue never writes match rows itself. It asks the shared writer to
// write the match **inside the transaction that consumes the entries**, so
// the game and the consumption of its entries commit together or not at all.
//
// The seam is not an authorization bypass: the setup is validated against the
// pinned rules policy, and the match, its seats, its clock, its first event
// and its operation receipt are written exactly like an ordinary creation.
//
// Because the writer runs inside the queue transaction, the bucket lock
// covers the whole decision: two owners of one pair, or the reconciliation
// loop and an owner, can never write the same match twice.
type MatchAllocator interface {
	// CreateMatchInTx writes the canonical match of a trusted allocation
	// inside the caller's transaction. The command names the idempotency
	// key of the allocation, so a retry names the same match.
	CreateMatchInTx(ctx context.Context, tx pgx.Tx, cmd online.Command) (online.CommandResult, error)
	// ValidateSetup checks a match setup against the pinned rules policy
	// without writing anything.
	ValidateSetup(ctx context.Context, setup online.CreateMatchSetup) error
}

// DeclaredControlResolver resolves the publishable label of a declared
// control.
//
// The resolution is the canonical one of the shared schema: a private
// routing identity, a secret-bearing alias or a connection nickname is
// replaced by a neutral label before it is accepted, and it never reaches a
// durable row or a response body. The queue is not a second, laxer place
// where a model label is accepted: a label that the shared match path would
// refuse is refused here too.
type DeclaredControlResolver interface {
	// ResolveDeclaredControl returns the control with its publishable
	// label.
	ResolveDeclaredControl(ctx context.Context, ownerKind, ownerID string, control online.SeatControl) (online.SeatControl, error)
}

// LabelResolver returns the public label of an account participant.
//
// A label is a chosen public name. It is never an account identifier, an
// address, or an endpoint. A resolver that cannot name an owner returns the
// default label instead of failing the allocation.
type LabelResolver interface {
	PublicLabel(ctx context.Context, accountID string) (string, error)
}

// CredentialIssuer issues the seat-scoped credential of a browser engine
// seat.
//
// The engine runs in the owner's browser, so the owner needs a credential
// that is scoped to that one seat of that one match. The credential is
// revocable, it is bound to the seat it was issued for, and it never widens
// the participant checks of the match.
//
// The issuance is one atomic decision of the issuer: it reads the live
// credential of the seat inside the seat lock and it mints a credential only
// when the seat has none. A routine retry therefore never rotates a secret
// the browser already holds, and two concurrent routine fallbacks of the same
// entry can never revoke the secret the first one already delivered.
type CredentialIssuer interface {
	// IssueEngineSeatCredential issues the credential of an engine seat.
	//
	// The outcome reports whether a credential was minted. An ordinary
	// request for a seat with a live credential mints nothing and revokes
	// nothing. An explicit rotation supersedes the live credential of the
	// seat on purpose.
	IssueEngineSeatCredential(ctx context.Context, request onlineauth.EngineSeatRequest) (onlineauth.EngineSeatCredentialOutcome, error)
}

// Options configures the queue.
type Options struct {
	// Now is the authoritative clock of the queue. It is injected so a
	// test can drive the cutoff, the expiry and the delayed timer
	// deterministically.
	Now func() time.Time
	// SearchWindow is the window that starts at the ready acceptance.
	SearchWindow time.Duration
	// ReadinessTTL is how long one heartbeat keeps an entry eligible.
	ReadinessTTL time.Duration
	// EngineLabel is the public label of the browser fallback engine.
	EngineLabel string
	// Allocator writes the canonical match of an allocation.
	Allocator MatchAllocator
	// Controls resolves the publishable label of a declared control.
	Controls DeclaredControlResolver
	// Labels names the public label of an owner.
	Labels LabelResolver
	// Credentials issues the seat credential of a browser engine seat.
	Credentials CredentialIssuer
	// Random picks the colors of a match. It returns a value in [0,1).
	Random func() float64
}

// Service is the queue writer.
//
// It is the only writer of the queue tables. Every allocation, cancellation
// and fallback runs inside one transaction that holds the time-control
// bucket lock, so the order of two competing decisions is the same for every
// participant.
type Service struct {
	db           *pgxpool.Pool
	now          func() time.Time
	searchWindow time.Duration
	readinessTTL time.Duration
	engineLabel  string
	allocator    MatchAllocator
	controls     DeclaredControlResolver
	labels       LabelResolver
	credentials  CredentialIssuer
	random       func() float64
}

// Open binds the queue to a database pool. It does not mutate the schema.
func Open(_ context.Context, db *pgxpool.Pool, options Options) (*Service, error) {
	if db == nil {
		return nil, ErrInvalidRequest
	}
	if options.Allocator == nil {
		return nil, fmt.Errorf("%w: the queue needs a match allocator", ErrInvalidRequest)
	}
	service := &Service{
		db:           db,
		now:          options.Now,
		searchWindow: options.SearchWindow,
		readinessTTL: options.ReadinessTTL,
		engineLabel:  options.EngineLabel,
		allocator:    options.Allocator,
		controls:     options.Controls,
		labels:       options.Labels,
		credentials:  options.Credentials,
		random:       options.Random,
	}
	if service.now == nil {
		service.now = func() time.Time { return time.Now().UTC() }
	}
	if service.searchWindow <= 0 {
		service.searchWindow = DefaultSearchWindow
	}
	if service.readinessTTL <= 0 {
		service.readinessTTL = DefaultReadinessTTL
	}
	if service.engineLabel == "" {
		service.engineLabel = DefaultEngineLabel
	}
	if service.labels == nil {
		service.labels = staticLabels{}
	}
	if service.controls == nil {
		service.controls = canonicalControls{db: db}
	}
	if service.random == nil {
		service.random = cryptoRandom
	}
	return service, nil
}

// canonicalControls resolves a declared control through the canonical
// resolution of the shared schema.
//
// The resolution is the database function the shared match path applies on
// write, so the label the queue stores and the label the canonical seat
// stores are the same value. An unknown label becomes the neutral label and
// a private routing identity never reaches a durable row.
type canonicalControls struct {
	db *pgxpool.Pool
}

func (c canonicalControls) ResolveDeclaredControl(ctx context.Context, ownerKind, ownerID string, control online.SeatControl) (online.SeatControl, error) {
	if control.Kind == online.ControlHuman {
		return control, nil
	}
	if control.ModelLabel == nil {
		return online.SeatControl{}, fmt.Errorf("%w: the declared model label", ErrInvalidRequest)
	}
	if c.db == nil {
		return online.SeatControl{}, fmt.Errorf("%w: the queue cannot resolve a declared control", ErrUnavailable)
	}
	var resolved *string
	if err := c.db.QueryRow(ctx, `SELECT online_resolve_public_model_label($1,$2,$3,$4)`, ownerKind, ownerID, string(control.Kind), *control.ModelLabel).Scan(&resolved); err != nil {
		return online.SeatControl{}, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if resolved == nil || *resolved == "" {
		return online.SeatControl{}, fmt.Errorf("%w: the declared model label", ErrInvalidRequest)
	}
	control.ModelLabel = resolved
	return control, nil
}

// staticLabels is the fallback resolver. It names every owner with the
// default public label, so a queue without a profile service still never
// publishes an identifier.
type staticLabels struct{}

func (staticLabels) PublicLabel(context.Context, string) (string, error) {
	return DefaultOwnerLabel, nil
}

// cryptoRandom returns a value in [0,1) from the system random source.
func cryptoRandom() float64 {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		// The colors are a fairness detail, not a security decision. A
		// failing random source must not stop a queue.
		return 0.5
	}
	value := uint64(0)
	for _, b := range raw {
		value = value<<8 | uint64(b)
	}
	return float64(value%1_000_000_000_000) / 1_000_000_000_000
}

// CreateEntryRequest describes one explicit queue entry.
type CreateEntryRequest struct {
	// Control is the seat the owner asks for: a human seat or a selected
	// agent seat. An engine seat never enters the queue.
	Control online.SeatControl
	// TimeControl is the clock of the entry. Only entries with an
	// identical clock are compatible.
	TimeControl online.TimeControl
	// ClientRequestID makes the creation idempotent per owner. A second
	// tab that replays the same identifier receives the same entry and
	// creates no second game.
	ClientRequestID string
}

// Operation identifies one mutating queue operation.
//
// The identifier is optional. When it is present the answer is stored with
// the operation, so a repeated call returns the same answer and never
// performs the operation twice.
type Operation struct {
	ID string
}

// Assignment is the result of a committed allocation.
//
// It names the match, the seat of the caller, the public label and the
// declared control of the opponent, and for a browser engine fallback the
// seat-scoped credential that lets the owner's browser move the engine.
// It never carries an owner identifier, a session identifier, or a private
// route.
type Assignment struct {
	SchemaVersion   int                `json:"schemaVersion"`
	MatchID         string             `json:"matchId"`
	Seat            online.Seat        `json:"seat"`
	OpponentLabel   string             `json:"opponentLabel"`
	Control         online.SeatControl `json:"control"`
	GuestCredential *GuestCredential   `json:"guestCredential,omitempty"`
}

// GuestCredential is the one-time secret of an engine seat.
//
// The credential is scoped to one match and one seat. It is the only secret
// the queue ever returns, and it exists exactly once in the answer that
// issued it.
type GuestCredential struct {
	GuestID   string      `json:"guestId"`
	MatchID   string      `json:"matchId"`
	Seat      online.Seat `json:"seat"`
	Token     string      `json:"token"`
	ExpiresAt time.Time   `json:"expiresAt"`
}

// The internal states of an entry.
const (
	internalPreparing = "preparing"
	internalWaiting   = "waiting"
	internalFallback  = "fallback"
	internalExpired   = "expired"
	internalCancelled = "cancelled"
	internalAssigned  = "assigned"
)

// entryRecord is the stored state of one queue entry.
type entryRecord struct {
	EntryID           string
	OwnerKind         string
	OwnerID           string
	ControlKind       string
	ControlModelLabel *string
	StartingTimeMs    int64
	IncrementMs       int64
	Status            string
	InternalState     string
	Version           int64
	ReadyAt           *time.Time
	CutoffAt          *time.Time
	OriginalCutoffAt  *time.Time
	ExpiresAt         *time.Time
	LastHeartbeatAt   *time.Time
	KeepSearching     bool
	ClientRequestID   *string
	AssignedMatchID   *string
	CreatedAt         time.Time
	UpdatedAt         time.Time
	creationHash      []byte
}

// entry converts the stored state into the wire entry.
//
// The wire status is one of waiting, cancelled or assigned. An expired entry
// is reported as waiting with no ready time, because the owner has to rejoin
// explicitly before the entry is eligible again.
func (r entryRecord) entry() online.QueueEntry {
	entry := online.QueueEntry{
		SchemaVersion:   online.ContractsSchemaVersion,
		EntryID:         r.EntryID,
		Owner:           online.ParticipantRef{Kind: online.ParticipantAccount, ID: r.OwnerID},
		Control:         online.SeatControl{Kind: online.ControlKind(r.ControlKind), ModelLabel: r.ControlModelLabel},
		TimeControl:     online.TimeControl{StartingTimeMs: r.StartingTimeMs, IncrementMs: r.IncrementMs},
		Status:          online.QueueStatus(r.Status),
		Version:         r.Version,
		ReadyAt:         r.ReadyAt,
		CutoffAt:        r.CutoffAt,
		AssignedMatchID: r.AssignedMatchID,
		CreatedAt:       r.CreatedAt.UTC(),
		UpdatedAt:       r.UpdatedAt.UTC(),
	}
	if r.InternalState == internalExpired {
		entry.ReadyAt = nil
		entry.CutoffAt = nil
	}
	return entry
}

// bound is the instant a candidate has to be ready by.
//
// Before the cutoff the bound is the current time, so only a candidate that
// is ready now can match. At or after the cutoff the bound is the original
// cutoff, so the decision stays the decision the owner was promised even
// when the timer is late. An entry that keeps searching has no cutoff and
// waits for a candidate that is ready now.
func (r entryRecord) bound(now time.Time) time.Time {
	if r.KeepSearching {
		return now
	}
	if r.OriginalCutoffAt != nil && now.After(*r.OriginalCutoffAt) {
		return *r.OriginalCutoffAt
	}
	return now
}

// windowEnded reports whether the search window of the entry has ended.
//
// The window ends at the original cutoff of the entry, and only there: the
// cutoff is the deadline the ready acceptance armed, and it never moves. An
// entry that keeps searching removed its cutoff, so it has no window that
// ends and the browser engine is never committed for it.
func (r entryRecord) windowEnded(now time.Time) bool {
	if r.KeepSearching {
		return false
	}
	if r.OriginalCutoffAt == nil {
		return false
	}
	return !now.Before(*r.OriginalCutoffAt)
}

const entryColumns = `entry_id,owner_kind,owner_id,seat_control_kind,seat_control_model_label,starting_time_ms,increment_ms,status,internal_state,version,ready_at,cutoff_at,original_cutoff_at,expires_at,last_heartbeat_at,keep_searching,client_request_id,assigned_match_id,created_at,updated_at`

type queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func scanEntry(row pgx.Row) (entryRecord, error) {
	var record entryRecord
	err := row.Scan(&record.EntryID, &record.OwnerKind, &record.OwnerID, &record.ControlKind, &record.ControlModelLabel,
		&record.StartingTimeMs, &record.IncrementMs, &record.Status, &record.InternalState, &record.Version,
		&record.ReadyAt, &record.CutoffAt, &record.OriginalCutoffAt, &record.ExpiresAt, &record.LastHeartbeatAt,
		&record.KeepSearching, &record.ClientRequestID, &record.AssignedMatchID, &record.CreatedAt, &record.UpdatedAt)
	return record, err
}

// loadEntry reads one entry without a lock.
func (s *Service) loadEntry(ctx context.Context, q queryer, entryID string) (entryRecord, error) {
	record, err := scanEntry(q.QueryRow(ctx, `SELECT `+entryColumns+` FROM online_queue_entries WHERE entry_id=$1`, entryID))
	if errors.Is(err, pgx.ErrNoRows) {
		return entryRecord{}, ErrNotFound
	}
	if err != nil {
		return entryRecord{}, err
	}
	return record, nil
}

// lockEntry reads one entry under a row lock.
func (s *Service) lockEntry(ctx context.Context, tx pgx.Tx, entryID string) (entryRecord, error) {
	record, err := scanEntry(tx.QueryRow(ctx, `SELECT `+entryColumns+` FROM online_queue_entries WHERE entry_id=$1 FOR UPDATE`, entryID))
	if errors.Is(err, pgx.ErrNoRows) {
		return entryRecord{}, ErrNotFound
	}
	if err != nil {
		return entryRecord{}, err
	}
	return record, nil
}

// CreateEntry creates one explicit queue entry.
//
// The creation is the authoritative ready acceptance: the entry records its
// ready time and starts its search window there. No search time elapses
// during the browser's own readiness checks, because those checks happen
// before this call.
//
// The ready time is the instant the creation commits, not the instant the
// call started. The creation samples its time after the bucket lock and the
// account scope lock it waits for, so an entry that waited for the lock of
// its time control receives the full search window and the full readiness
// lease instead of a shortened one.
//
// The second return value reports whether a new entry was created. A replay
// of the same client request identifier returns the existing entry and
// creates no second game.
func (s *Service) CreateEntry(ctx context.Context, actor online.ParticipantRef, request CreateEntryRequest) (online.QueueEntry, bool, error) {
	if err := validateActor(actor); err != nil {
		return online.QueueEntry{}, false, err
	}
	if err := validateControl(request.Control); err != nil {
		return online.QueueEntry{}, false, err
	}
	if err := validateTimeControl(request.TimeControl); err != nil {
		return online.QueueEntry{}, false, err
	}
	if request.ClientRequestID != "" && !clientRequestIDShape(request.ClientRequestID) {
		return online.QueueEntry{}, false, fmt.Errorf("%w: client request id", ErrInvalidRequest)
	}
	// The declared control is resolved through the canonical resolution
	// before it is accepted. A private routing identity, a secret-bearing
	// alias or a connection nickname is replaced by a neutral label here, so
	// it never reaches a durable row and never crosses an owner boundary.
	resolved, err := s.controls.ResolveDeclaredControl(ctx, string(online.ParticipantAccount), actor.ID, request.Control)
	if err != nil {
		return online.QueueEntry{}, false, err
	}
	request.Control = resolved
	entryID, err := newIdentifier("qe_")
	if err != nil {
		return online.QueueEntry{}, false, err
	}
	creationHash := creationHashOf(request)
	var clientRequestID *string
	if request.ClientRequestID != "" {
		value := request.ClientRequestID
		clientRequestID = &value
	}
	var modelLabel *string
	if request.Control.ModelLabel != nil {
		value := *request.Control.ModelLabel
		modelLabel = &value
	}
	// The entry is written inside a transaction that holds the time-control
	// bucket lock and the account scope lock of the owner, and that re-reads
	// the durable removal. An account that was removed cannot create an
	// entry afterwards, even when it was authenticated before the removal.
	//
	// The lock order of the queue is fixed: the bucket lock, then the
	// account scope locks in ascending order, then the row locks. Every
	// queue write takes them in that order, so two writes never wait for
	// each other in the opposite order.
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return online.QueueEntry{}, false, err
	}
	defer tx.Rollback(ctx)
	if err = lockBucket(ctx, tx, request.TimeControl.StartingTimeMs, request.TimeControl.IncrementMs); err != nil {
		return online.QueueEntry{}, false, err
	}
	if err = lockAccount(ctx, tx, actor.ID); err != nil {
		return online.QueueEntry{}, false, err
	}
	// The authoritative creation time is sampled after the locks the
	// creation waited for and after the durable removal of the owner was
	// re-read. An entry that waited for the bucket lock of its time control
	// starts its search window and its readiness lease at the instant it
	// commits, so it never begins with a shortened window and it is never
	// already expired when it is created.
	//
	// Every timestamp of the entry comes from that one instant, so the
	// ready time, the cutoff, the lease, the creation time and the update
	// time of the row agree with each other.
	now := s.now().UTC()
	cutoff := now.Add(s.searchWindow)
	expiresAt := now.Add(s.readinessTTL)
	row := tx.QueryRow(ctx, `INSERT INTO online_queue_entries(entry_id,owner_kind,owner_id,seat_control_kind,seat_control_model_label,starting_time_ms,increment_ms,status,internal_state,version,ready_at,cutoff_at,original_cutoff_at,expires_at,last_heartbeat_at,keep_searching,client_request_id,creation_hash,created_at,updated_at)
		VALUES($1,'account',$2,$3,$4,$5,$6,'waiting','waiting',1,$7,$8,$8,$9,$7,false,$10,$11,$7,$7)
		ON CONFLICT (owner_kind, owner_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
		RETURNING `+entryColumns,
		entryID, actor.ID, string(request.Control.Kind), modelLabel, request.TimeControl.StartingTimeMs, request.TimeControl.IncrementMs,
		now, cutoff, expiresAt, clientRequestID, creationHash)
	record, err := scanEntry(row)
	if err == nil {
		if err = tx.Commit(ctx); err != nil {
			return online.QueueEntry{}, false, err
		}
		return record.entry(), true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return online.QueueEntry{}, false, err
	}
	// The entry intent already exists for this owner. The same identifier
	// returns the same entry; a different request under the same identifier
	// is a conflict, because the settings of an entry are fixed.
	existing, err := s.loadEntryByRequest(ctx, actor.ID, request.ClientRequestID)
	if err != nil {
		return online.QueueEntry{}, false, err
	}
	if !equalBytes(existing.creationHash, creationHash) {
		return online.QueueEntry{}, false, fmt.Errorf("%w: the client request id is already used for another entry", ErrConflict)
	}
	if err = tx.Commit(ctx); err != nil {
		return online.QueueEntry{}, false, err
	}
	return existing.entry(), false, nil
}

// loadEntryByRequest reads the entry of one client request intent.
func (s *Service) loadEntryByRequest(ctx context.Context, ownerID, clientRequestID string) (entryRecord, error) {
	row := s.db.QueryRow(ctx, `SELECT `+entryColumns+`,creation_hash FROM online_queue_entries WHERE owner_kind='account' AND owner_id=$1 AND client_request_id=$2`, ownerID, clientRequestID)
	var record entryRecord
	var creationHash []byte
	err := row.Scan(&record.EntryID, &record.OwnerKind, &record.OwnerID, &record.ControlKind, &record.ControlModelLabel,
		&record.StartingTimeMs, &record.IncrementMs, &record.Status, &record.InternalState, &record.Version,
		&record.ReadyAt, &record.CutoffAt, &record.OriginalCutoffAt, &record.ExpiresAt, &record.LastHeartbeatAt,
		&record.KeepSearching, &record.ClientRequestID, &record.AssignedMatchID, &record.CreatedAt, &record.UpdatedAt, &creationHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return entryRecord{}, ErrNotFound
	}
	if err != nil {
		return entryRecord{}, err
	}
	record.creationHash = creationHash
	return record, nil
}

// Entry returns the entry of the caller.
//
// An entry of another owner is not found. The answer never carries the owner
// identifier of anybody else.
func (s *Service) Entry(ctx context.Context, actor online.ParticipantRef, entryID string) (online.QueueEntry, error) {
	if err := validateActor(actor); err != nil {
		return online.QueueEntry{}, err
	}
	record, err := s.loadEntry(ctx, s.db, entryID)
	if err != nil {
		return online.QueueEntry{}, err
	}
	if record.OwnerID != actor.ID {
		return online.QueueEntry{}, ErrNotFound
	}
	return record.entry(), nil
}

// Ready re-arms an entry that is not ready.
//
// It is the explicit rejoin of an expired entry and it starts a fresh
// window. A ready entry keeps its window: the call is idempotent and never
// extends a deadline that already runs.
func (s *Service) Ready(ctx context.Context, actor online.ParticipantRef, entryID string, operation Operation) (online.QueueEntry, error) {
	if err := validateActor(actor); err != nil {
		return online.QueueEntry{}, err
	}
	result, err := s.mutateEntry(ctx, actor, entryID, operation, func(ctx context.Context, tx pgx.Tx, now time.Time, record entryRecord) (bool, error) {
		switch record.InternalState {
		case internalAssigned, internalCancelled:
			return false, fmt.Errorf("%w: the entry is %s", ErrConflict, record.InternalState)
		case internalExpired:
			cutoff := now.Add(s.searchWindow)
			if _, err := tx.Exec(ctx, `UPDATE online_queue_entries SET status='waiting',internal_state='waiting',ready_at=$2,cutoff_at=$3,original_cutoff_at=$3,expires_at=$4,last_heartbeat_at=$2,keep_searching=false,version=version+1,updated_at=$2 WHERE entry_id=$1`, record.EntryID, now, cutoff, now.Add(s.readinessTTL)); err != nil {
				return false, err
			}
			return true, nil
		default:
			// The entry is already waiting. The call is idempotent and the
			// running window is not extended.
			return false, nil
		}
	})
	if err != nil {
		return online.QueueEntry{}, err
	}
	return result.entry(), nil
}

// Cancel removes a waiting entry without creating a game.
//
// A cancellation that loses the race against an assignment sees the assigned
// entry instead: the game exists, and the game is cancelled through the
// participant command route, not through the queue.
//
// An expired entry is refused with a conflict. The entry already left the
// eligibility, so there is no search left to cancel, and the database
// refuses to move an expired entry out of the expiry: only the explicit
// rejoin clears it. The refusal is the same one the heartbeat and the kept
// search of an expired entry answer, so the browser reads one rule for an
// expired entry instead of a database failure.
func (s *Service) Cancel(ctx context.Context, actor online.ParticipantRef, entryID string, operation Operation) (online.QueueEntry, error) {
	if err := validateActor(actor); err != nil {
		return online.QueueEntry{}, err
	}
	result, err := s.mutateEntry(ctx, actor, entryID, operation, func(ctx context.Context, tx pgx.Tx, now time.Time, record entryRecord) (bool, error) {
		switch record.InternalState {
		case internalAssigned:
			return false, fmt.Errorf("%w: the entry is %s", ErrConflict, record.InternalState)
		case internalCancelled:
			return false, nil
		case internalExpired:
			// The entry left the eligibility when its owner stopped
			// responding. There is no search to cancel, and the expiry is
			// cleared only by an explicit rejoin, so the cancellation is
			// refused instead of writing a state the database forbids.
			return false, fmt.Errorf("%w: the entry expired", ErrConflict)
		default:
			if _, err := tx.Exec(ctx, `UPDATE online_queue_entries SET status='cancelled',internal_state='cancelled',cutoff_at=NULL,version=version+1,updated_at=$2 WHERE entry_id=$1`, record.EntryID, now); err != nil {
				return false, err
			}
			return true, nil
		}
	})
	if err != nil {
		return online.QueueEntry{}, err
	}
	return result.entry(), nil
}

// KeepSearching removes the automatic cutoff of a waiting entry.
//
// The entry then waits until it is matched, cancelled or expired. It never
// falls back to the browser engine on its own again.
//
// A kept search is a live search. An entry whose cutoff was already reached
// and that waits for the engine fallback returns to the eligibility, so a
// candidate that arrives later matches it again. The cutoff stays removed
// and the original cutoff never moves.
//
// The readiness lease of the owner has to be live. A dead lease is not
// revived by a kept search: only the explicit rejoin arms a fresh window.
func (s *Service) KeepSearching(ctx context.Context, actor online.ParticipantRef, entryID string, operation Operation) (online.QueueEntry, error) {
	if err := validateActor(actor); err != nil {
		return online.QueueEntry{}, err
	}
	result, err := s.mutateEntry(ctx, actor, entryID, operation, func(ctx context.Context, tx pgx.Tx, now time.Time, record entryRecord) (bool, error) {
		switch record.InternalState {
		case internalAssigned, internalCancelled:
			return false, fmt.Errorf("%w: the entry is %s", ErrConflict, record.InternalState)
		case internalExpired:
			return false, fmt.Errorf("%w: the entry expired", ErrConflict)
		default:
			if record.ExpiresAt != nil && !record.ExpiresAt.After(now) {
				// The lease is dead. A kept search never revives a dead
				// lease, only the explicit rejoin arms a fresh window.
				return false, fmt.Errorf("%w: the entry expired", ErrConflict)
			}
			if record.KeepSearching {
				return false, nil
			}
			// The kept search removes the cutoff and returns an entry that
			// waits for the engine fallback to the eligibility. The
			// reconciliation loop and this update are serialized by the
			// bucket lock, so a pending fallback that is recorded after
			// this update never overwrites the kept search.
			if _, err := tx.Exec(ctx, `UPDATE online_queue_entries SET keep_searching=true,cutoff_at=NULL,internal_state=CASE WHEN internal_state='fallback' THEN 'waiting' ELSE internal_state END,version=version+1,updated_at=$2 WHERE entry_id=$1`, record.EntryID, now); err != nil {
				return false, err
			}
			return true, nil
		}
	})
	if err != nil {
		return online.QueueEntry{}, err
	}
	return result.entry(), nil
}

// Heartbeat reports that the owner of a waiting entry is still responsive.
//
// One heartbeat keeps the entry eligible for the readiness lease. A frozen
// or disconnected entry loses the lease, expires, and needs an explicit
// rejoin.
//
// A heartbeat never revives a dead lease. The lease is the readiness signal
// of the owner, and a heartbeat that arrives after the lease died would say
// nothing about the time in between. Only the explicit rejoin arms a fresh
// window.
func (s *Service) Heartbeat(ctx context.Context, actor online.ParticipantRef, entryID string, operation Operation) (online.QueueEntry, error) {
	if err := validateActor(actor); err != nil {
		return online.QueueEntry{}, err
	}
	result, err := s.mutateEntry(ctx, actor, entryID, operation, func(ctx context.Context, tx pgx.Tx, now time.Time, record entryRecord) (bool, error) {
		switch record.InternalState {
		case internalAssigned, internalCancelled:
			return false, fmt.Errorf("%w: the entry is %s", ErrConflict, record.InternalState)
		case internalExpired:
			return false, fmt.Errorf("%w: the entry expired", ErrConflict)
		default:
			if record.ExpiresAt != nil && !record.ExpiresAt.After(now) {
				// The lease is dead. The entry leaves the eligibility and
				// only an explicit rejoin revives it.
				return false, fmt.Errorf("%w: the entry expired", ErrConflict)
			}
			if _, err := tx.Exec(ctx, `UPDATE online_queue_entries SET last_heartbeat_at=$2,expires_at=$3,version=version+1,updated_at=$2 WHERE entry_id=$1`, record.EntryID, now, now.Add(s.readinessTTL)); err != nil {
				return false, err
			}
			return true, nil
		}
	})
	if err != nil {
		return online.QueueEntry{}, err
	}
	return result.entry(), nil
}

// mutateEntry runs one entry mutation inside the bucket lock.
//
// The bucket lock serializes the mutation against the allocation, the
// cancellation and the fallback of every entry of the same time control. The
// entry is locked after the bucket, so two transactions never wait for each
// other in the opposite order.
//
// A repeated operation returns the stored answer, and the answer is written
// in the same transaction as the state change, so an accepted operation has
// exactly one stored answer.
func (s *Service) mutateEntry(ctx context.Context, actor online.ParticipantRef, entryID string, operation Operation, apply func(context.Context, pgx.Tx, time.Time, entryRecord) (bool, error)) (entryRecord, error) {
	if operation.ID != "" && !operationIDShape(operation.ID) {
		return entryRecord{}, fmt.Errorf("%w: operation id", ErrInvalidRequest)
	}
	if operation.ID != "" {
		stored, found, err := s.loadOperationReceipt(ctx, entryID, operation.ID, operationHash(actor, entryID, operation.ID))
		if err != nil {
			return entryRecord{}, err
		}
		if found {
			return stored, nil
		}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return entryRecord{}, err
	}
	defer tx.Rollback(ctx)
	record, err := s.loadEntry(ctx, s.db, entryID)
	if err != nil {
		return entryRecord{}, err
	}
	if record.OwnerID != actor.ID {
		return entryRecord{}, ErrNotFound
	}
	// The lock order of the queue is fixed: the bucket lock, then the
	// account scope lock, then the row lock.
	if err = lockBucket(ctx, tx, record.StartingTimeMs, record.IncrementMs); err != nil {
		return entryRecord{}, err
	}
	// The account scope lock comes before the row lock, and the durable
	// removal of the owner is re-read inside the transaction.
	if err = lockAccount(ctx, tx, actor.ID); err != nil {
		return entryRecord{}, err
	}
	record, err = s.lockEntry(ctx, tx, entryID)
	if err != nil {
		return entryRecord{}, err
	}
	if record.OwnerID != actor.ID {
		return entryRecord{}, ErrNotFound
	}
	now := s.now().UTC()
	changed, err := apply(ctx, tx, now, record)
	if err != nil {
		return entryRecord{}, err
	}
	if changed {
		record, err = s.loadEntry(ctx, tx, entryID)
		if err != nil {
			return entryRecord{}, err
		}
	}
	if operation.ID != "" {
		if err = s.storeOperationReceipt(ctx, tx, entryID, operation.ID, operationHash(actor, entryID, operation.ID), record.entry()); err != nil {
			return entryRecord{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return entryRecord{}, err
	}
	return record, nil
}

// lockBucket serializes the queue decisions of one time-control bucket.
//
// The lock is taken before any entry row is locked, so candidate selection,
// reservation, cancellation and the engine fallback of the same bucket
// always observe one order. A candidate is never skipped because another
// transaction held its row: the waiting transaction reads the committed
// state of the bucket after the lock is free.
func lockBucket(ctx context.Context, tx pgx.Tx, startingTimeMs, incrementMs int64) error {
	key := fmt.Sprintf("kamkmchess:queue:%d:%d", startingTimeMs, incrementMs)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, key); err != nil {
		return err
	}
	return nil
}

// ValidateEntryRequest checks one entry request without writing anything.
//
// The HTTP layer uses it to refuse an impossible request before the service
// is called, and the service checks it again before it writes.
func ValidateEntryRequest(request CreateEntryRequest) error {
	if err := validateControl(request.Control); err != nil {
		return err
	}
	if err := validateTimeControl(request.TimeControl); err != nil {
		return err
	}
	if request.ClientRequestID != "" && !clientRequestIDShape(request.ClientRequestID) {
		return fmt.Errorf("%w: client request id", ErrInvalidRequest)
	}
	return nil
}

// lockAccount takes the account scope lock of one owner and refuses a
// removed account.
//
// The scope lock is the shared lock of the online service: the removal of a
// participant takes the same lock, so a removal and a queue write of one
// account are ordered instead of racing. The durable removal is re-read
// inside the transaction, so an account that was authenticated before its
// removal cannot write queue state afterwards.
//
// Queue writes take the bucket lock, then the account scope locks, then
// the entry row locks. Participant removal does not take a bucket lock.
func lockAccount(ctx context.Context, tx pgx.Tx, accountID string) error {
	if err := locks.LockAccountScope(ctx, tx, locks.AccountScope("account", accountID)); err != nil {
		return err
	}
	return assertAccountPresent(ctx, tx, accountID)
}

// assertAccountPresent refuses an account that was removed.
//
// The comparison uses the one-way reference of the subject, so the removal
// tables never see an account identifier and the service never sends one to
// the database.
func assertAccountPresent(ctx context.Context, q queryer, accountID string) error {
	var removed bool
	if err := q.QueryRow(ctx, subject.AccountRemovedSQL, subject.Reference(accountID)).Scan(&removed); err != nil {
		return err
	}
	if removed {
		return ErrAccountRemoved
	}
	return nil
}

// validateActor refuses everything but an account participant.
func validateActor(actor online.ParticipantRef) error {
	if actor.Kind != online.ParticipantAccount || actor.ID == "" {
		return fmt.Errorf("%w: the public queue needs a signed-in account", ErrInvalidRequest)
	}
	return nil
}

// validateControl refuses an engine seat and an undeclared agent.
func validateControl(control online.SeatControl) error {
	if control.Kind != online.ControlHuman && control.Kind != online.ControlAgent {
		return fmt.Errorf("%w: queue entries use a human or an agent seat", ErrInvalidRequest)
	}
	if err := control.Validate(); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidRequest, err)
	}
	return nil
}

// validateTimeControl applies the shared clock bounds.
func validateTimeControl(timeControl online.TimeControl) error {
	if timeControl.StartingTimeMs < 1 || timeControl.StartingTimeMs > 86_400_000 {
		return fmt.Errorf("%w: starting time", ErrInvalidRequest)
	}
	if timeControl.IncrementMs < 0 || timeControl.IncrementMs > 60_000 {
		return fmt.Errorf("%w: increment", ErrInvalidRequest)
	}
	return nil
}

// clientRequestIDShape is the shape of an entry intent identifier.
func clientRequestIDShape(value string) bool {
	return identifierShape(value, 8, 64)
}

// operationIDShape is the shape of an operation identifier.
func operationIDShape(value string) bool {
	return identifierShape(value, 8, 64)
}

// identifierShape is the shape of an opaque, non-secret identifier.
func identifierShape(value string, min, max int) bool {
	if len(value) < min || len(value) > max {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '_' || r == '-':
		default:
			return false
		}
	}
	return true
}

// creationHashOf is the fingerprint of one entry intent.
func creationHashOf(request CreateEntryRequest) []byte {
	label := ""
	if request.Control.ModelLabel != nil {
		label = *request.Control.ModelLabel
	}
	raw := fmt.Sprintf("%s|%s|%d|%d", request.Control.Kind, label, request.TimeControl.StartingTimeMs, request.TimeControl.IncrementMs)
	sum := sha256.Sum256([]byte(raw))
	return sum[:]
}

// operationHash is the fingerprint of one mutating operation.
func operationHash(actor online.ParticipantRef, entryID, operationID string) []byte {
	sum := sha256.Sum256([]byte(string(actor.Kind) + "|" + actor.ID + "|" + entryID + "|" + operationID))
	return sum[:]
}

// newIdentifier returns a random, non-secret identifier.
func newIdentifier(prefix string) (string, error) {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "", ErrUnavailable
	}
	return prefix + base64.RawURLEncoding.EncodeToString(raw), nil
}

// loadReceiptRaw reads the stored answer of one operation.
//
// The receipt is keyed by the entry and the operation identifier, so a
// repeated operation returns the same answer. An identifier that is reused
// for a different request is refused instead of answered.
func (s *Service) loadReceiptRaw(ctx context.Context, entryID, operationID string, hash []byte) ([]byte, bool, error) {
	var storedHash, raw []byte
	err := s.db.QueryRow(ctx, `SELECT request_hash,result_json FROM online_operation_receipts WHERE scope_kind='queue' AND scope_id=$1 AND operation_id=$2`, entryID, operationID).Scan(&storedHash, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if !equalBytes(storedHash, hash) {
		return nil, false, ErrOperationReuse
	}
	return raw, true, nil
}

// loadOperationReceipt reads the stored answer of one operation.
func (s *Service) loadOperationReceipt(ctx context.Context, entryID, operationID string, hash []byte) (entryRecord, bool, error) {
	raw, found, err := s.loadReceiptRaw(ctx, entryID, operationID, hash)
	if err != nil || !found {
		return entryRecord{}, found, err
	}
	var entry online.QueueEntry
	if err = json.Unmarshal(raw, &entry); err != nil {
		return entryRecord{}, false, ErrUnavailable
	}
	return entryRecord{
		EntryID:           entry.EntryID,
		OwnerKind:         string(entry.Owner.Kind),
		OwnerID:           entry.Owner.ID,
		ControlKind:       string(entry.Control.Kind),
		ControlModelLabel: entry.Control.ModelLabel,
		StartingTimeMs:    entry.TimeControl.StartingTimeMs,
		IncrementMs:       entry.TimeControl.IncrementMs,
		Status:            string(entry.Status),
		InternalState:     internalWaiting,
		Version:           entry.Version,
		ReadyAt:           entry.ReadyAt,
		CutoffAt:          entry.CutoffAt,
		AssignedMatchID:   entry.AssignedMatchID,
		CreatedAt:         entry.CreatedAt,
		UpdatedAt:         entry.UpdatedAt,
	}, true, nil
}

// storeOperationReceipt writes the answer of one operation.
//
// The receipt is written in the same transaction as the state change, so an
// accepted operation always has exactly one stored answer.
func (s *Service) storeOperationReceipt(ctx context.Context, tx pgx.Tx, entryID, operationID string, hash []byte, entry online.QueueEntry) error {
	raw, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO online_operation_receipts(scope_kind,scope_id,operation_id,request_hash,result_json,version,control_epoch,accepted_at) VALUES('queue',$1,$2,$3,$4,$5,1,clock_timestamp())
		ON CONFLICT (scope_kind,scope_id,operation_id) DO NOTHING`,
		entryID, operationID, hash, raw, entry.Version)
	return err
}

// equalBytes compares two byte slices.
func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}

// labelFor returns the public label of an owner.
//
// A resolver failure never fails an allocation: the default label is used
// instead, because a missing name must not block a game.
func (s *Service) labelFor(ctx context.Context, accountID string) string {
	label, err := s.labels.PublicLabel(ctx, accountID)
	if err != nil || strings.TrimSpace(label) == "" {
		return DefaultOwnerLabel
	}
	return label
}
