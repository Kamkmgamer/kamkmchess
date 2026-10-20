package online

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The trusted allocation writer.
//
// A friend invitation and a queue allocation both bind two participants that
// no participant request can create: a guest has no credential for a match
// that does not exist yet, and a guest credential is bound to exactly one
// match and one seat.
//
// The seam below is the single canonical way to write such a match. It is not
// an authorization bypass: the setup is validated, the pinned rules policy
// accepts the starting position, and the match, its seats, its clock, its
// first event and its operation receipt are written exactly like an ordinary
// creation. The only difference is that the actor is not re-checked against a
// presented credential, because the caller is the service that bound the two
// participants itself.
//
// No HTTP route reaches this seam. The participant command route refuses
// `create_match` before the writer ever sees it.

// MatchAllocator is the trusted seam that creates a match for participants
// the service bound together.
type MatchAllocator interface {
	// CreateMatchInTx writes the canonical match of a trusted allocation
	// inside the caller's transaction.
	CreateMatchInTx(ctx context.Context, tx pgx.Tx, cmd Command) (CommandResult, error)
	// ValidateSetup checks a match setup against the pinned rules policy
	// without writing anything.
	ValidateSetup(ctx context.Context, setup CreateMatchSetup) error
}

// AllocatedMatchID derives the match identifier of an allocation from its
// idempotency key and the participant that caused it.
//
// The derivation makes an allocation retry-safe without any extra state: a
// retry with the same operation ID names the same match, so the stored
// receipt is found and no second match is created.
//
// The participant is part of the derivation on purpose. An operation key can
// be client supplied, so two different owners may use the same key. Mixing
// the participant in keeps their match identifiers apart, while a retry of the
// same owner keeps its own identifier stable.
func AllocatedMatchID(actor ParticipantRef, operationID string) string {
	sum := sha256.Sum256([]byte("kamkmchess/allocated-match/" + string(actor.Kind) + "/" + actor.ID + "/" + operationID))
	return "m" + hex.EncodeToString(sum[:])[:31]
}

// NewAllocationCommand builds the creation command of a trusted allocation.
//
// The actor must own one of the two seats, and that seat is the creator of
// the match. The command names the creator seat, so the stored receipt is
// bound to the participant that caused the allocation.
//
// The match identifier is derived from the operation identifier and the
// actor, so the command is idempotent: a retry with the same operation
// identifier names the same match and finds the stored receipt.
func NewAllocationCommand(actor ParticipantRef, setup CreateMatchSetup, operationID string) (Command, error) {
	if err := setup.Validate(); err != nil {
		return Command{}, err
	}
	if !idPattern.MatchString(operationID) {
		return Command{}, fmt.Errorf("%w: operation id", ErrInvalidArgument)
	}
	creator := setup.Seats.White.Participant
	seat := SeatWhite
	if setup.Seats.Black.Participant == actor {
		creator = setup.Seats.Black.Participant
		seat = SeatBlack
	}
	if creator != actor {
		return Command{}, ErrNotAuthorized
	}
	return Command{
		SchemaVersion:   ContractsSchemaVersion,
		MatchID:         AllocatedMatchID(actor, operationID),
		OperationID:     operationID,
		ExpectedVersion: 0,
		Seat:            seat,
		ControlEpoch:    1,
		Action:          Action{Kind: ActionCreateMatch, CreateMatch: &setup},
	}, nil
}

// CreateMatchInTx writes the canonical match of a trusted allocation inside
// the caller's transaction.
//
// The trusted allocator is the only caller. The writer takes the transaction
// instead of opening one, so an allocation can commit the match and the
// consumption of its invitation or its queue entries in one transaction. A
// committed match without a consumed entry, or a consumed entry without a
// match, would both break the rule that one request produces exactly one
// game.
//
// The operation ID is the caller's idempotency key. A retry with the same
// operation ID returns the stored receipt and writes no second match.
func (s *Service) CreateMatchInTx(ctx context.Context, tx pgx.Tx, cmd Command) (CommandResult, error) {
	if cmd.Action.Kind != ActionCreateMatch {
		return CommandResult{}, ErrInvalidContract
	}
	setup := cmd.Action.CreateMatch
	if err := setup.Validate(); err != nil {
		return CommandResult{}, err
	}
	// The command names the seat of the participant that caused the
	// allocation. The receipt fingerprint is bound to that participant, so a
	// reused operation identifier of another participant is refused.
	creator := setup.Seats.White.Participant
	if cmd.Seat == SeatBlack {
		creator = setup.Seats.Black.Participant
	}
	return s.createMatchInTx(ctx, tx, cmd, setup, creator)
}

// createMatchInTx performs the write of a trusted allocation.
func (s *Service) createMatchInTx(ctx context.Context, tx pgx.Tx, cmd Command, setup *CreateMatchSetup, creator ParticipantRef) (CommandResult, error) {
	fingerprint, err := CommandFingerprint(creator, cmd)
	if err != nil {
		return CommandResult{}, err
	}
	// An already accepted operation is resolved inside the caller's
	// transaction, so a retry never writes a second match.
	if duplicate, err := loadReceipt(ctx, tx, cmd.MatchID, cmd.OperationID, fingerprint[:]); err == nil {
		return duplicate, nil
	} else if !errors.Is(err, ErrNotFound) {
		return CommandResult{}, err
	}
	var decision time.Time
	if err = tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&decision); err != nil {
		return CommandResult{}, err
	}
	decision = decision.UTC()
	match := Match{
		SchemaVersion:      ContractsSchemaVersion,
		MatchID:            cmd.MatchID,
		Variant:            setup.Variant,
		StartingFEN:        setup.StartingFEN,
		PositionFEN:        setup.StartingFEN,
		TimeControl:        setup.TimeControl,
		Version:            1,
		ControlEpoch:       1,
		RulesPolicyVersion: s.rulesPolicyVersion,
		Status:             MatchActive,
		Seats: []MatchSeat{
			{Seat: SeatWhite, Participant: setup.Seats.White.Participant, PublicLabel: setup.Seats.White.PublicLabel, Control: setup.Seats.White.Control, ControlEpoch: 1},
			{Seat: SeatBlack, Participant: setup.Seats.Black.Participant, PublicLabel: setup.Seats.Black.PublicLabel, Control: setup.Seats.Black.Control, ControlEpoch: 1},
		},
		Clock:  InitialClock(setup.TimeControl),
		Moves:  []Move{},
		Offers: []Offer{},
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_matches(match_id,schema_version,variant,starting_fen,position_fen,starting_time_ms,increment_ms,version,control_epoch,input_hash,rules_policy_version,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
		match.MatchID, match.SchemaVersion, match.Variant, match.StartingFEN, match.PositionFEN, match.TimeControl.StartingTimeMs, match.TimeControl.IncrementMs, match.Version, match.ControlEpoch, mustHashBytes(RulesInputHash(BuildRulesInput(match, match.Moves, ""))), match.RulesPolicyVersion, string(match.Status), decision, decision); err != nil {
		return CommandResult{}, err
	}
	for _, seat := range match.Seats {
		if _, err = tx.Exec(ctx, `INSERT INTO online_seats(match_id,seat,owner_kind,owner_id,public_label,control_kind,model_label,control_epoch,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
			match.MatchID, string(seat.Seat), string(seat.Participant.Kind), seat.Participant.ID, seat.PublicLabel, string(seat.Control.Kind), seat.Control.ModelLabel, seat.ControlEpoch, decision); err != nil {
			return CommandResult{}, err
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_clocks(match_id,white_ms,black_ms,active_seat,active_since,deadline_at,white_moved,black_moved,turn_number,reply_seat,reply_deadline_at,updated_at) VALUES($1,$2,$3,NULL,NULL,NULL,false,false,0,NULL,NULL,$4)`,
		match.MatchID, match.Clock.WhiteMs, match.Clock.BlackMs, decision); err != nil {
		return CommandResult{}, err
	}
	event := &Event{SchemaVersion: ContractsSchemaVersion, MatchID: match.MatchID, Version: 1, Kind: EventMatchCreated, ControlEpoch: 1, DecisionAt: decision, AcceptedAt: decision}
	if err = insertEvent(ctx, tx, *event); err != nil {
		return CommandResult{}, err
	}
	receipt := Receipt{SchemaVersion: ContractsSchemaVersion, MatchID: match.MatchID, OperationID: cmd.OperationID, Outcome: OutcomeAccepted, Version: 1, ControlEpoch: 1, DecidedAt: decision, Event: event}
	raw, err := marshalReceipt(receipt)
	if err != nil {
		return CommandResult{}, err
	}
	if err = insertReceipt(ctx, tx, cmd, fingerprint[:], raw, 1, 1, decision); err != nil {
		return CommandResult{}, err
	}
	return CommandResult{Receipt: receipt, Raw: raw}, nil
}

// CreateAllocatedMatch creates the canonical match of a trusted allocation in
// its own transaction.
//
// It is the simple path for an allocation that owns one row, such as a
// friend invitation. An allocation that must commit the match together with
// other state uses CreateMatchInTx with its own transaction.
func (s *Service) CreateAllocatedMatch(ctx context.Context, actor ParticipantRef, setup CreateMatchSetup, operationID string) (CommandResult, error) {
	cmd, err := NewAllocationCommand(actor, setup, operationID)
	if err != nil {
		return CommandResult{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return CommandResult{}, err
	}
	defer tx.Rollback(ctx)
	result, err := s.createMatchInTx(ctx, tx, cmd, &setup, actor)
	if err != nil {
		return CommandResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return CommandResult{}, err
	}
	return result, nil
}

// ValidateSetup checks a match setup against the pinned rules policy.
//
// It never writes a row and never takes a lock, so a trusted allocator can
// validate a setup before it opens the transaction that consumes an
// invitation or a queue entry. An invalid starting position is refused
// before anything is consumed.
func (s *Service) ValidateSetup(ctx context.Context, setup CreateMatchSetup) error {
	if err := setup.Validate(); err != nil {
		return err
	}
	if s.evaluator == nil {
		return ErrUnavailable
	}
	match := Match{
		SchemaVersion:      ContractsSchemaVersion,
		MatchID:            "setup-validation",
		Variant:            setup.Variant,
		StartingFEN:        setup.StartingFEN,
		PositionFEN:        setup.StartingFEN,
		TimeControl:        setup.TimeControl,
		Version:            1,
		ControlEpoch:       1,
		RulesPolicyVersion: s.rulesPolicyVersion,
		Status:             MatchActive,
		Seats: []MatchSeat{
			{Seat: SeatWhite, Participant: setup.Seats.White.Participant, PublicLabel: setup.Seats.White.PublicLabel, Control: setup.Seats.White.Control, ControlEpoch: 1},
			{Seat: SeatBlack, Participant: setup.Seats.Black.Participant, PublicLabel: setup.Seats.Black.PublicLabel, Control: setup.Seats.Black.Control, ControlEpoch: 1},
		},
		Clock:  InitialClock(setup.TimeControl),
		Moves:  []Move{},
		Offers: []Offer{},
	}
	if err := s.evaluator.ValidateSetup(ctx, BuildRulesInput(match, match.Moves, "")); err != nil {
		return ErrInvalidContract
	}
	return nil
}

// ValidateQueueSetup checks a queue match setup against the pinned rules
// policy.
//
// It is the canonical setup check of the allocation seam. The alias exists
// for the queue caller, which names its own surface.
func (s *Service) ValidateQueueSetup(ctx context.Context, setup CreateMatchSetup) error {
	return s.ValidateSetup(ctx, setup)
}

// compile time proof that the service satisfies the trusted seam.
var _ MatchAllocator = (*Service)(nil)

// the pool type is referenced by the allocation seam documentation.
var _ = pgxpool.Pool{}
