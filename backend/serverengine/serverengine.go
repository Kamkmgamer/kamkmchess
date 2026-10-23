// Package serverengine plays the server's own Stockfish seat in online
// matches.
//
// The seat is an ordinary engine seat owned by a guest participant whose
// identifier starts with "server-engine:". The server holds the seat's guest
// credential in memory and plays through the same path a browser runner uses:
// it takes the seat's runner lease for the current turn and submits the move
// as a fenced command. The online writer still decides legality, clocks and
// results, so the server engine has no authority a browser engine lacks.
//
// The credential lives only in memory. After a restart the next turn rotates
// it, which supersedes the lost secret.
package serverengine

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/engine"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/jackc/pgx/v5"
)

// Label is the public label of the server engine seat. Migration 0026
// resolves every server engine seat to it.
const Label = "Stockfish (server)"

// ParticipantPrefix starts the guest identifier of every server engine seat.
const ParticipantPrefix = "server-engine:"

// RunnerID names the server in the runner leases it takes.
const RunnerID = "server-engine"

// credentialOrigin scopes the in-memory seat credential. No browser presents
// it, so it is never an allowed browser origin.
const credentialOrigin = "server-engine"

// credentialTTL bounds one credential. A longer game rotates it.
const credentialTTL = 26 * time.Hour

// Matches is the part of the online service the driver uses.
type Matches interface {
	GetMatch(ctx context.Context, matchID string) (online.Match, error)
	AcquireRunnerLease(ctx context.Context, actor online.ParticipantRef, req online.RunnerLeaseRequest) (online.RunnerLease, error)
	Execute(ctx context.Context, actor online.ParticipantRef, cmd online.Command) (online.CommandResult, error)
	CreateAllocatedMatch(ctx context.Context, actor online.ParticipantRef, setup online.CreateMatchSetup, operationID string) (online.CommandResult, error)
}

// Credentials issues the seat credential of an engine seat.
type Credentials interface {
	IssueEngineSeatCredential(ctx context.Context, request onlineauth.EngineSeatRequest) (onlineauth.EngineSeatCredentialOutcome, error)
}

// Mover chooses a move for a position.
type Mover interface {
	BestMove(ctx context.Context, fen string, think time.Duration) (string, error)
}

// SeatRef names one server engine seat of an active match.
type SeatRef struct {
	MatchID string
	Seat    online.Seat
	OwnerID string
}

// ActiveSeats lists the server engine seats of the active matches.
type ActiveSeats func(ctx context.Context, limit int) ([]SeatRef, error)

// Options configures the driver.
type Options struct {
	Matches     Matches
	Credentials Credentials
	Mover       Mover
	ActiveSeats ActiveSeats
	// MaxInFlight bounds the turns played at once. Zero means 8.
	MaxInFlight int
	// RetryAfter is how long a seat whose turn failed is left alone. Zero
	// means five seconds.
	RetryAfter time.Duration
	Now        func() time.Time
	Logger     *slog.Logger
}

// Service drives the server engine seats.
type Service struct {
	options Options

	mu         sync.Mutex
	principals map[string]onlineauth.Principal
	inFlight   map[string]bool
	retryAt    map[string]time.Time
	wg         sync.WaitGroup
}

// New returns a driver. Every dependency is required.
func New(options Options) (*Service, error) {
	if options.Matches == nil || options.Credentials == nil || options.Mover == nil || options.ActiveSeats == nil {
		return nil, errors.New("serverengine: incomplete options")
	}
	if options.MaxInFlight <= 0 {
		options.MaxInFlight = 8
	}
	if options.RetryAfter <= 0 {
		options.RetryAfter = 5 * time.Second
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	return &Service{
		options:    options,
		principals: map[string]onlineauth.Principal{},
		inFlight:   map[string]bool{},
		retryAt:    map[string]time.Time{},
	}, nil
}

// ParticipantID returns a fresh guest identifier for a server engine seat.
// The think time is part of the identifier, so a restarted server plays the
// seat at the same strength without another table.
func ParticipantID(think time.Duration) (string, error) {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s%d:%s", ParticipantPrefix, engine.ClampThink(think).Milliseconds(), hex.EncodeToString(raw[:])), nil
}

// ThinkOf reads the think time back from a server engine identifier.
func ThinkOf(ownerID string) (time.Duration, bool) {
	rest, ok := strings.CutPrefix(ownerID, ParticipantPrefix)
	if !ok {
		return 0, false
	}
	ms, _, ok := strings.Cut(rest, ":")
	if !ok {
		return 0, false
	}
	value, err := strconv.ParseInt(ms, 10, 64)
	if err != nil {
		return 0, false
	}
	return engine.ClampThink(time.Duration(value) * time.Millisecond), true
}

// Seat returns the create seat of a new server engine seat.
func Seat(think time.Duration) (online.CreateSeat, error) {
	id, err := ParticipantID(think)
	if err != nil {
		return online.CreateSeat{}, err
	}
	label := Label
	return online.CreateSeat{
		Participant: online.ParticipantRef{Kind: online.ParticipantGuest, ID: id},
		PublicLabel: Label,
		Control:     online.SeatControl{Kind: online.ControlEngine, ModelLabel: &label},
	}, nil
}

// MatchRequest describes a match against the server engine.
type MatchRequest struct {
	// Actor is the participant the allocation is recorded for.
	Actor online.ParticipantRef
	// Opponent is the seat the server engine plays against.
	Opponent online.CreateSeat
	// EngineSeat is the color the server engine plays.
	EngineSeat  online.Seat
	TimeControl online.TimeControl
	Think       time.Duration
	// StartingFEN defaults to the standard position.
	StartingFEN string
	OperationID string
}

// StandardStartingPosition is the default starting position.
const StandardStartingPosition = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

// CreateMatch allocates a match against the server engine and takes the
// engine seat. A white engine seat moves on the next sweep.
func (s *Service) CreateMatch(ctx context.Context, request MatchRequest) (online.Match, error) {
	if request.EngineSeat != online.SeatWhite && request.EngineSeat != online.SeatBlack {
		return online.Match{}, fmt.Errorf("%w: engine seat", online.ErrInvalidArgument)
	}
	engineSeat, err := Seat(request.Think)
	if err != nil {
		return online.Match{}, err
	}
	fen := request.StartingFEN
	if fen == "" {
		fen = StandardStartingPosition
	}
	setup := online.CreateMatchSetup{Variant: "orthodox", StartingFEN: fen, TimeControl: request.TimeControl}
	if request.EngineSeat == online.SeatWhite {
		setup.Seats = online.CreateMatchSeats{White: engineSeat, Black: request.Opponent}
	} else {
		setup.Seats = online.CreateMatchSeats{White: request.Opponent, Black: engineSeat}
	}
	result, err := s.options.Matches.CreateAllocatedMatch(ctx, request.Actor, setup, request.OperationID)
	if err != nil {
		return online.Match{}, err
	}
	match, err := s.options.Matches.GetMatch(ctx, result.Receipt.MatchID)
	if err != nil {
		return online.Match{}, err
	}
	// The credential is issued now, so a failure surfaces to the creator
	// instead of on the engine's first turn.
	if _, err = s.principal(ctx, SeatRef{MatchID: match.MatchID, Seat: request.EngineSeat, OwnerID: engineSeat.Participant.ID}, false); err != nil {
		return online.Match{}, err
	}
	return match, nil
}

func seatKey(ref SeatRef) string { return ref.MatchID + "/" + string(ref.Seat) }

// principal returns the in-memory principal of a seat, issuing a credential
// when there is none. A rotation supersedes a credential that was lost with
// a restart or that expired.
func (s *Service) principal(ctx context.Context, ref SeatRef, rotate bool) (onlineauth.Principal, error) {
	key := seatKey(ref)
	s.mu.Lock()
	principal, ok := s.principals[key]
	s.mu.Unlock()
	if ok && !rotate && s.options.Now().Before(principal.ExpiresAt.Add(-time.Minute)) {
		return principal, nil
	}
	outcome, err := s.options.Credentials.IssueEngineSeatCredential(ctx, onlineauth.EngineSeatRequest{
		MatchID: ref.MatchID, Seat: ref.Seat, GuestID: ref.OwnerID, Origin: credentialOrigin, TTL: credentialTTL, Rotate: true,
	})
	if err != nil {
		return onlineauth.Principal{}, err
	}
	if !outcome.Issued {
		return onlineauth.Principal{}, errors.New("serverengine: no credential was issued")
	}
	principal = onlineauth.NewGuestPrincipal(outcome.Credential)
	s.mu.Lock()
	s.principals[key] = principal
	s.mu.Unlock()
	return principal, nil
}

// Sweep starts a turn for every server engine seat that is to move. It
// returns at once; Wait waits for the turns it started.
func (s *Service) Sweep(ctx context.Context, batch int) error {
	seats, err := s.options.ActiveSeats(ctx, batch)
	if err != nil {
		return err
	}
	now := s.options.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	live := map[string]bool{}
	for _, ref := range seats {
		key := seatKey(ref)
		live[key] = true
		if s.inFlight[key] || now.Before(s.retryAt[key]) || len(s.inFlight) >= s.options.MaxInFlight {
			continue
		}
		s.inFlight[key] = true
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			err := s.Play(ctx, ref)
			s.mu.Lock()
			delete(s.inFlight, key)
			if err != nil {
				s.retryAt[key] = s.options.Now().Add(s.options.RetryAfter)
			} else {
				delete(s.retryAt, key)
			}
			s.mu.Unlock()
			if err != nil && !errors.Is(err, context.Canceled) {
				s.options.Logger.Warn("the server engine could not play", "match", ref.MatchID, "seat", ref.Seat, "error", err)
			}
		}()
	}
	// A seat of a finished match no longer needs its credential.
	for key := range s.principals {
		if !live[key] && !s.inFlight[key] && len(seats) < batch {
			delete(s.principals, key)
			delete(s.retryAt, key)
		}
	}
	return nil
}

// Wait waits for the turns that are being played.
func (s *Service) Wait() { s.wg.Wait() }

// Play plays the seat's move when it is the seat's turn. It does nothing
// when the seat is not to move or the match ended.
func (s *Service) Play(ctx context.Context, ref SeatRef) error {
	match, err := s.options.Matches.GetMatch(ctx, ref.MatchID)
	if err != nil {
		return err
	}
	seat, ok := match.Seat(ref.Seat)
	if !ok || seat.Participant.ID != ref.OwnerID || seat.Control.Kind != online.ControlEngine {
		return nil
	}
	if match.Status != online.MatchActive || sideToMove(match.PositionFEN) != ref.Seat {
		return nil
	}
	think, ok := ThinkOf(ref.OwnerID)
	if !ok {
		return errors.New("serverengine: malformed engine identity")
	}
	// The engine never spends more than a thirtieth of its bank on a move.
	think = min(think, max(engine.MinThink, time.Duration(match.Clock.Bank(ref.Seat)/30)*time.Millisecond))
	principal, err := s.principal(ctx, ref, false)
	if err != nil {
		return err
	}
	lease, err := s.acquire(ctx, ref, match, principal)
	if errors.Is(err, onlineauth.ErrUnauthenticated) {
		// The credential was lost or superseded. A rotation replaces it.
		if principal, err = s.principal(ctx, ref, true); err == nil {
			lease, err = s.acquire(ctx, ref, match, principal)
		}
	}
	if err != nil {
		return err
	}
	move, err := s.options.Mover.BestMove(ctx, match.PositionFEN, think)
	if err != nil {
		return err
	}
	cmd := online.Command{
		SchemaVersion:   online.ContractsSchemaVersion,
		MatchID:         match.MatchID,
		OperationID:     operationID(match.MatchID, ref.Seat, match.Version),
		ExpectedVersion: match.Version,
		Seat:            ref.Seat,
		ControlEpoch:    match.ControlEpoch,
		LeaseID:         lease.LeaseID,
		Action:          online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: move}},
	}
	_, err = s.options.Matches.Execute(onlineauth.WithPrincipal(ctx, principal), principal.Participant, cmd)
	if errors.Is(err, online.ErrConflict) || errors.Is(err, online.ErrMatchEnded) {
		// The opponent resigned, a takeback landed or the clock ran out
		// while the engine thought. The next sweep reads the new state.
		return nil
	}
	return err
}

func (s *Service) acquire(ctx context.Context, ref SeatRef, match online.Match, principal onlineauth.Principal) (online.RunnerLease, error) {
	return s.options.Matches.AcquireRunnerLease(onlineauth.WithPrincipal(ctx, principal), principal.Participant, online.RunnerLeaseRequest{
		SchemaVersion: online.ContractsSchemaVersion,
		MatchID:       match.MatchID,
		Seat:          ref.Seat,
		RunnerID:      RunnerID,
		TurnVersion:   match.Version,
		ControlEpoch:  match.ControlEpoch,
	})
}

// operationID is stable per turn, so a retried submission of one turn is a
// duplicate instead of a second move.
func operationID(matchID string, seat online.Seat, version int64) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("kamkmchess/server-engine/%s/%s/%d", matchID, seat, version)))
	return "srveng-" + hex.EncodeToString(sum[:])[:32]
}

func sideToMove(fen string) online.Seat {
	fields := strings.Fields(fen)
	if len(fields) > 1 && fields[1] == "b" {
		return online.SeatBlack
	}
	return online.SeatWhite
}

// Querier runs the read of the active seats.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// PostgresSeats lists the server engine seats of the active matches whose
// side is to move, oldest first.
func PostgresSeats(db Querier) ActiveSeats {
	return func(ctx context.Context, limit int) ([]SeatRef, error) {
		rows, err := db.Query(ctx, `SELECT s.match_id, s.seat, s.owner_id
			FROM online_seats s JOIN online_matches m ON m.match_id = s.match_id
			WHERE m.status = 'active' AND s.owner_kind = 'guest' AND s.control_kind = 'engine'
			  AND s.owner_id LIKE 'server-engine:%'
			  AND split_part(m.position_fen, ' ', 2) = CASE s.seat WHEN 'white' THEN 'w' ELSE 'b' END
			ORDER BY m.updated_at, s.match_id LIMIT $1`, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var seats []SeatRef
		for rows.Next() {
			var ref SeatRef
			var seat string
			if err = rows.Scan(&ref.MatchID, &seat, &ref.OwnerID); err != nil {
				return nil, err
			}
			ref.Seat = online.Seat(seat)
			seats = append(seats, ref)
		}
		return seats, rows.Err()
	}
}

// Start sweeps until ctx ends and returns a stop function that waits for the
// turns in flight.
func (s *Service) Start(ctx context.Context, interval time.Duration, batch int) func() {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			if err := s.Sweep(ctx, batch); err != nil && ctx.Err() == nil {
				s.options.Logger.Warn("the server engine sweep failed", "error", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() {
		cancel()
		<-done
		s.Wait()
	}
}
