package queue

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/jackc/pgx/v5"
)

// allocationMode selects what an allocation does when no candidate is
// available.
type allocationMode int

const (
	// modeCandidate only pairs two entries. It never uses the engine.
	modeCandidate allocationMode = iota
	// modeFallback prefers a candidate and commits the browser engine when
	// no candidate is available.
	modeFallback
)

// The roles an entry can play in an allocation.
const (
	roleInitiator = "initiator"
	roleOpponent  = "opponent"
)

// allocationRecord is the stored decision of one allocation.
type allocationRecord struct {
	AllocationID               string
	Kind                       string
	InitiatorEntryID           string
	InitiatorSeat              string
	OpponentEntryID            *string
	OpponentSeat               string
	OperationID                string
	MatchID                    *string
	Status                     string
	InitiatorLabel             string
	InitiatorControlKind       string
	InitiatorControlModelLabel *string
	OpponentLabel              string
	OpponentControlKind        string
	OpponentControlModelLabel  *string
	CreatedAt                  time.Time
	CommittedAt                *time.Time
}

const allocationColumns = `a.allocation_id,a.kind,a.initiator_entry_id,a.initiator_seat,a.opponent_entry_id,a.opponent_seat,a.operation_id,a.match_id,a.status,a.initiator_label,a.initiator_control_kind,a.initiator_control_model_label,a.opponent_label,a.opponent_control_kind,a.opponent_control_model_label,a.created_at,a.committed_at`

func scanAllocation(row pgx.Row) (allocationRecord, error) {
	var record allocationRecord
	err := row.Scan(&record.AllocationID, &record.Kind, &record.InitiatorEntryID, &record.InitiatorSeat,
		&record.OpponentEntryID, &record.OpponentSeat, &record.OperationID, &record.MatchID, &record.Status,
		&record.InitiatorLabel, &record.InitiatorControlKind, &record.InitiatorControlModelLabel,
		&record.OpponentLabel, &record.OpponentControlKind, &record.OpponentControlModelLabel,
		&record.CreatedAt, &record.CommittedAt)
	return record, err
}

// loadAllocationForEntry reads the allocation that consumed one entry.
//
// The role of the entry in the allocation is returned with it: the caller of
// the queue may be the initiator of the allocation or its opponent, and the
// answer names the seat and the opponent of the caller.
func (s *Service) loadAllocationForEntry(ctx context.Context, q queryer, entryID string) (allocationRecord, string, bool, error) {
	row := q.QueryRow(ctx, `SELECT `+allocationColumns+`
		FROM online_queue_allocation_entries e
		JOIN online_queue_allocations a ON a.allocation_id=e.allocation_id
		WHERE e.entry_id=$1`, entryID)
	record, err := scanAllocation(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return allocationRecord{}, "", false, nil
	}
	if err != nil {
		return allocationRecord{}, "", false, err
	}
	var role string
	if err = q.QueryRow(ctx, `SELECT role FROM online_queue_allocation_entries WHERE entry_id=$1`, entryID).Scan(&role); err != nil {
		return allocationRecord{}, "", false, err
	}
	return record, role, true, nil
}

// loadAllocationByID reads one allocation by its identity.
func (s *Service) loadAllocationByID(ctx context.Context, q queryer, allocationID string) (allocationRecord, bool, error) {
	row := q.QueryRow(ctx, `SELECT `+allocationColumns+` FROM online_queue_allocations a WHERE a.allocation_id=$1`, allocationID)
	record, err := scanAllocation(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return allocationRecord{}, false, nil
	}
	if err != nil {
		return allocationRecord{}, false, err
	}
	return record, true, nil
}

// candidateRecord is the stored state of a compatible candidate.
type candidateRecord struct {
	EntryID           string
	OwnerID           string
	ControlKind       string
	ControlModelLabel *string
	ReadyAt           *time.Time
}

// Match pairs the entry with a compatible ready entry.
//
// The service owns the compatibility rule: identical clock, different
// owners and at least one agent seat. The oldest eligible candidate answers
// the entry. When no candidate is available the call answers that no
// candidate exists, which is not an error of the entry.
//
// The pairing is automatic. There is no approval step and the entry is never
// queued again.
func (s *Service) Match(ctx context.Context, actor online.ParticipantRef, entryID string, operation Operation) (Assignment, error) {
	return s.allocate(ctx, actor, entryID, operation, modeCandidate, "")
}

// Fallback commits the browser engine fallback.
//
// The service checks once more for a compatible candidate before it commits,
// so a candidate that was eligible at the original cutoff still wins over the
// engine. The engine seat is created in the match and the answer carries the
// seat-scoped credential that lets the owner's browser move it.
//
// The fallback is committed only after the browser reported a ready engine:
// the call itself is that report.
func (s *Service) Fallback(ctx context.Context, actor online.ParticipantRef, entryID string, operation Operation, origin string) (Assignment, error) {
	return s.allocate(ctx, actor, entryID, operation, modeFallback, origin)
}

// allocate runs the single authoritative allocation decision.
//
// The decision has three durable steps:
//
//  1. the reservation is written inside the bucket lock, so the entries are
//     consumed once and the opponent is fixed;
//  2. the shared allocator writes the canonical match outside the queue
//     transaction, with the idempotency key of the reservation;
//  3. the reservation is completed and the entries are published as
//     assigned.
//
// A failure between the steps leaves a pending reservation. The reservation
// names the idempotency key, so the recovery completes the same match instead
// of creating a second one.
func (s *Service) allocate(ctx context.Context, actor online.ParticipantRef, entryID string, operation Operation, mode allocationMode, origin string) (Assignment, error) {
	if err := validateActor(actor); err != nil {
		return Assignment{}, err
	}
	if operation.ID != "" {
		if !operationIDShape(operation.ID) {
			return Assignment{}, fmt.Errorf("%w: operation id", ErrInvalidRequest)
		}
		stored, found, err := s.loadAssignmentReceipt(ctx, entryID, operation.ID, operationHash(actor, entryID, operation.ID))
		if err != nil {
			return Assignment{}, err
		}
		if found {
			return stored, nil
		}
	}
	now := s.now().UTC()
	plan, err := s.reserve(ctx, actor, entryID, mode, now)
	if err != nil {
		return Assignment{}, err
	}
	assignment, err := s.complete(ctx, plan, origin)
	if err != nil {
		return Assignment{}, err
	}
	if operation.ID != "" {
		if err = s.storeAssignmentReceipt(ctx, entryID, operation.ID, operationHash(actor, entryID, operation.ID), assignment); err != nil {
			return Assignment{}, err
		}
	}
	return assignment, nil
}

// reservationPlan is the durable decision of one allocation, before the
// match exists.
type reservationPlan struct {
	allocation allocationRecord
	// role is the role of the requesting entry in the allocation.
	role string
	// initiator is the entry that asked for the allocation.
	initiator  entryRecord
	setup      online.CreateMatchSetup
	actor      online.ParticipantRef
	engineSeat online.Seat
	engineID   string
}

// reserve writes the durable decision of one allocation.
//
// The bucket lock serializes the decision against every other decision of the
// same time control. The entries are reserved inside the same transaction,
// so two competing matchmakers can never reserve the same entry.
//
// An entry that already produced an allocation keeps its opponent: the plan
// of that allocation is rebuilt and completed instead of choosing a new one.
func (s *Service) reserve(ctx context.Context, actor online.ParticipantRef, entryID string, mode allocationMode, now time.Time) (reservationPlan, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return reservationPlan{}, err
	}
	defer tx.Rollback(ctx)
	record, err := s.loadEntry(ctx, s.db, entryID)
	if err != nil {
		return reservationPlan{}, err
	}
	if record.OwnerID != actor.ID {
		return reservationPlan{}, ErrNotFound
	}
	if err = lockBucket(ctx, tx, record.StartingTimeMs, record.IncrementMs); err != nil {
		return reservationPlan{}, err
	}
	record, err = s.lockEntry(ctx, tx, entryID)
	if err != nil {
		return reservationPlan{}, err
	}
	if record.OwnerID != actor.ID {
		return reservationPlan{}, ErrNotFound
	}
	existing, role, found, err := s.loadAllocationForEntry(ctx, tx, entryID)
	if err != nil {
		return reservationPlan{}, err
	}
	if found {
		// The entry already produced an allocation. Its opponent is fixed.
		plan, err := s.planFromAllocation(ctx, existing, role)
		if err != nil {
			return reservationPlan{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return reservationPlan{}, err
		}
		return plan, nil
	}
	switch record.InternalState {
	case internalAssigned:
		return reservationPlan{}, fmt.Errorf("%w: the entry is assigned", ErrConflict)
	case internalCancelled:
		return reservationPlan{}, fmt.Errorf("%w: the entry is cancelled", ErrConflict)
	case internalExpired:
		return reservationPlan{}, fmt.Errorf("%w: the entry expired", ErrConflict)
	}
	bound := record.bound(now)
	candidate, found, err := s.findCandidate(ctx, tx, record, bound, now)
	if err != nil {
		return reservationPlan{}, err
	}
	if !found && mode == modeCandidate {
		return reservationPlan{}, ErrNoCandidate
	}
	operationID, err := newIdentifier("qa_")
	if err != nil {
		return reservationPlan{}, err
	}
	plan, err := s.buildPlan(ctx, record, candidate, found, operationID)
	if err != nil {
		return reservationPlan{}, err
	}
	if err = s.writeReservation(ctx, tx, record, plan); err != nil {
		return reservationPlan{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return reservationPlan{}, err
	}
	return plan, nil
}

// findCandidate selects the oldest eligible candidate of one entry.
//
// The candidate has to be ready by the bound, which is the current time
// before the cutoff and the original cutoff at or after it. The candidate is
// locked, so a concurrent decision cannot consume it as well.
//
// The scan never skips a busy candidate: the bucket lock orders the whole
// decision, so a candidate that another transaction reserved is already
// committed as consumed when this transaction reads the bucket.
func (s *Service) findCandidate(ctx context.Context, tx pgx.Tx, record entryRecord, bound, now time.Time) (candidateRecord, bool, error) {
	row := tx.QueryRow(ctx, `SELECT e.entry_id,e.owner_id,e.seat_control_kind,e.seat_control_model_label,e.ready_at
		FROM online_queue_entries e
		WHERE e.starting_time_ms=$1 AND e.increment_ms=$2
		  AND e.internal_state='waiting' AND e.status='waiting'
		  AND e.entry_id<>$3
		  AND e.owner_id<>$4
		  AND e.ready_at IS NOT NULL AND e.ready_at<=$5
		  AND (e.expires_at IS NULL OR e.expires_at>$6)
		  AND NOT (e.seat_control_kind='human' AND $7='human')
		  AND NOT EXISTS (SELECT 1 FROM online_queue_allocation_entries x WHERE x.entry_id=e.entry_id)
		ORDER BY e.ready_at, e.created_at, e.entry_id
		LIMIT 1
		FOR UPDATE OF e`,
		record.StartingTimeMs, record.IncrementMs, record.EntryID, record.OwnerID, bound, now, record.ControlKind)
	var candidate candidateRecord
	err := row.Scan(&candidate.EntryID, &candidate.OwnerID, &candidate.ControlKind, &candidate.ControlModelLabel, &candidate.ReadyAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return candidateRecord{}, false, nil
	}
	if err != nil {
		return candidateRecord{}, false, err
	}
	return candidate, true, nil
}

// buildPlan builds the setup and the stored decision of one allocation.
//
// The colors are random and the starting position is the standard one. A
// custom position never enters the queue.
func (s *Service) buildPlan(ctx context.Context, record entryRecord, candidate candidateRecord, found bool, operationID string) (reservationPlan, error) {
	initiatorLabel := s.labelFor(ctx, record.OwnerID)
	initiatorControl := online.SeatControl{Kind: online.ControlKind(record.ControlKind), ModelLabel: record.ControlModelLabel}
	initiator := online.CreateSeat{
		Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: record.OwnerID},
		PublicLabel: initiatorLabel,
		Control:     initiatorControl,
	}
	plan := reservationPlan{
		role:      roleInitiator,
		initiator: record,
		actor:     online.ParticipantRef{Kind: online.ParticipantAccount, ID: record.OwnerID},
	}
	var opponent online.CreateSeat
	var opponentEntryID *string
	if found {
		opponent = online.CreateSeat{
			Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: candidate.OwnerID},
			PublicLabel: s.labelFor(ctx, candidate.OwnerID),
			Control:     online.SeatControl{Kind: online.ControlKind(candidate.ControlKind), ModelLabel: candidate.ControlModelLabel},
		}
		value := candidate.EntryID
		opponentEntryID = &value
	} else {
		// The browser engine is its own participant. It is never the
		// requesting account: the owner receives a credential that is scoped
		// to the engine seat, not authority over the opponent seat.
		engineID := engineParticipantID(operationID)
		engineLabel := s.engineLabel
		opponent = online.CreateSeat{
			Participant: online.ParticipantRef{Kind: online.ParticipantGuest, ID: engineID},
			PublicLabel: engineLabel,
			Control:     online.SeatControl{Kind: online.ControlEngine, ModelLabel: &engineLabel},
		}
		plan.engineID = engineID
	}
	// The colors are random. There is no color preference and no partition
	// of the queue by color.
	initiatorSeat := online.SeatWhite
	opponentSeat := online.SeatBlack
	if s.random() >= 0.5 {
		initiatorSeat = online.SeatBlack
		opponentSeat = online.SeatWhite
	}
	seats := online.CreateMatchSeats{White: initiator, Black: opponent}
	if initiatorSeat == online.SeatBlack {
		seats = online.CreateMatchSeats{White: opponent, Black: initiator}
	}
	setup := online.CreateMatchSetup{
		Variant:     "orthodox",
		StartingFEN: StandardStartingPosition,
		TimeControl: online.TimeControl{StartingTimeMs: record.StartingTimeMs, IncrementMs: record.IncrementMs},
		Seats:       seats,
	}
	// The rules policy is asked before the reservation is written. The queue
	// only ever produces the standard position, so this check covers the
	// only position a queue game can use.
	if err := s.allocator.ValidateSetup(ctx, setup); err != nil {
		return reservationPlan{}, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	allocationID, err := newIdentifier("qal_")
	if err != nil {
		return reservationPlan{}, err
	}
	kind := "fallback"
	if found {
		kind = "candidate"
	}
	plan.allocation = allocationRecord{
		AllocationID:               allocationID,
		Kind:                       kind,
		InitiatorEntryID:           record.EntryID,
		InitiatorSeat:              string(initiatorSeat),
		OpponentEntryID:            opponentEntryID,
		OpponentSeat:               string(opponentSeat),
		OperationID:                operationID,
		Status:                     "pending",
		InitiatorLabel:             initiatorLabel,
		InitiatorControlKind:       string(initiatorControl.Kind),
		InitiatorControlModelLabel: initiatorControl.ModelLabel,
		OpponentLabel:              opponent.PublicLabel,
		OpponentControlKind:        string(opponent.Control.Kind),
		OpponentControlModelLabel:  opponent.Control.ModelLabel,
	}
	plan.setup = setup
	plan.engineSeat = opponentSeat
	return plan, nil
}

// planFromAllocation rebuilds the plan of an existing allocation.
//
// The stored decision names the participants' public labels and controls, so
// a recovered allocation produces exactly the same match as the first
// attempt.
func (s *Service) planFromAllocation(ctx context.Context, allocation allocationRecord, role string) (reservationPlan, error) {
	initiatorEntry, err := s.loadEntry(ctx, s.db, allocation.InitiatorEntryID)
	if err != nil {
		return reservationPlan{}, err
	}
	initiator := online.CreateSeat{
		Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: initiatorEntry.OwnerID},
		PublicLabel: allocation.InitiatorLabel,
		Control:     online.SeatControl{Kind: online.ControlKind(allocation.InitiatorControlKind), ModelLabel: allocation.InitiatorControlModelLabel},
	}
	opponent := online.CreateSeat{
		PublicLabel: allocation.OpponentLabel,
		Control:     online.SeatControl{Kind: online.ControlKind(allocation.OpponentControlKind), ModelLabel: allocation.OpponentControlModelLabel},
	}
	plan := reservationPlan{
		allocation: allocation,
		role:       role,
		initiator:  initiatorEntry,
		actor:      online.ParticipantRef{Kind: online.ParticipantAccount, ID: initiatorEntry.OwnerID},
	}
	if allocation.Kind == "fallback" {
		engineID := engineParticipantID(allocation.OperationID)
		opponent.Participant = online.ParticipantRef{Kind: online.ParticipantGuest, ID: engineID}
		plan.engineID = engineID
	} else {
		if allocation.OpponentEntryID == nil {
			return reservationPlan{}, fmt.Errorf("%w: the allocation names no opponent entry", ErrUnavailable)
		}
		opponentEntry, err := s.loadEntry(ctx, s.db, *allocation.OpponentEntryID)
		if err != nil {
			return reservationPlan{}, err
		}
		opponent.Participant = online.ParticipantRef{Kind: online.ParticipantAccount, ID: opponentEntry.OwnerID}
	}
	seats := online.CreateMatchSeats{White: initiator, Black: opponent}
	if allocation.InitiatorSeat == string(online.SeatBlack) {
		seats = online.CreateMatchSeats{White: opponent, Black: initiator}
	}
	plan.setup = online.CreateMatchSetup{
		Variant:     "orthodox",
		StartingFEN: StandardStartingPosition,
		TimeControl: online.TimeControl{StartingTimeMs: initiatorEntry.StartingTimeMs, IncrementMs: initiatorEntry.IncrementMs},
		Seats:       seats,
	}
	plan.engineSeat = online.Seat(allocation.OpponentSeat)
	return plan, nil
}

// writeReservation stores the decision and reserves the entries.
//
// The rows are written in one transaction, so the entries are reserved
// together with the decision that fixed the opponent. The unique index on
// the consumed entry is what makes "one entry, one game" a database fact.
func (s *Service) writeReservation(ctx context.Context, tx pgx.Tx, record entryRecord, plan reservationPlan) error {
	now := s.now().UTC()
	if _, err := tx.Exec(ctx, `INSERT INTO online_queue_allocations(allocation_id,kind,initiator_entry_id,initiator_seat,opponent_entry_id,opponent_seat,operation_id,match_id,status,initiator_label,initiator_control_kind,initiator_control_model_label,opponent_label,opponent_control_kind,opponent_control_model_label,created_at,committed_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,NULL,'pending',$8,$9,$10,$11,$12,$13,$14,NULL)`,
		plan.allocation.AllocationID, plan.allocation.Kind, plan.allocation.InitiatorEntryID, plan.allocation.InitiatorSeat,
		plan.allocation.OpponentEntryID, plan.allocation.OpponentSeat, plan.allocation.OperationID,
		plan.allocation.InitiatorLabel, plan.allocation.InitiatorControlKind, plan.allocation.InitiatorControlModelLabel,
		plan.allocation.OpponentLabel, plan.allocation.OpponentControlKind, plan.allocation.OpponentControlModelLabel, now); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO online_queue_allocation_entries(allocation_id,entry_id,role) VALUES($1,$2,'initiator')`, plan.allocation.AllocationID, plan.allocation.InitiatorEntryID); err != nil {
		return err
	}
	if plan.allocation.OpponentEntryID != nil {
		if _, err := tx.Exec(ctx, `INSERT INTO online_queue_allocation_entries(allocation_id,entry_id,role) VALUES($1,$2,'opponent')`, plan.allocation.AllocationID, *plan.allocation.OpponentEntryID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE online_queue_entries SET internal_state='reserved',version=version+1,updated_at=$2 WHERE entry_id=$1`, record.EntryID, now); err != nil {
		return err
	}
	if plan.allocation.OpponentEntryID != nil {
		if _, err := tx.Exec(ctx, `UPDATE online_queue_entries SET internal_state='reserved',version=version+1,updated_at=$2 WHERE entry_id=$1`, *plan.allocation.OpponentEntryID, now); err != nil {
			return err
		}
	}
	return nil
}

// complete writes the canonical match of a reservation and publishes it.
//
// The shared allocator writes the match outside the queue transaction. The
// reservation names the idempotency key, so a retry produces the same match
// and finds the stored receipt instead of creating a second game.
func (s *Service) complete(ctx context.Context, plan reservationPlan, origin string) (Assignment, error) {
	result, err := s.allocator.CreateAllocatedMatch(ctx, plan.actor, plan.setup, plan.allocation.OperationID)
	if err != nil {
		return Assignment{}, err
	}
	matchID := result.Receipt.MatchID
	if matchID == "" {
		return Assignment{}, fmt.Errorf("%w: the allocator returned no match", ErrUnavailable)
	}
	if err = s.commitAllocation(ctx, plan, matchID); err != nil {
		return Assignment{}, err
	}
	assignment := assignmentFor(plan, matchID)
	if plan.allocation.Kind == "fallback" {
		credential, err := s.issueEngineCredential(ctx, matchID, plan, origin)
		if err != nil {
			return Assignment{}, err
		}
		assignment.GuestCredential = &credential
	}
	return assignment, nil
}

// assignmentFor answers with the seat and the opponent of the caller.
//
// The caller of the queue may be the initiator of the allocation or its
// opponent. Both receive the same game and their own seat.
func assignmentFor(plan reservationPlan, matchID string) Assignment {
	assignment := Assignment{SchemaVersion: online.ContractsSchemaVersion, MatchID: matchID}
	if plan.role == roleOpponent {
		assignment.Seat = online.Seat(plan.allocation.OpponentSeat)
		assignment.OpponentLabel = plan.allocation.InitiatorLabel
		assignment.Control = online.SeatControl{
			Kind:       online.ControlKind(plan.allocation.InitiatorControlKind),
			ModelLabel: plan.allocation.InitiatorControlModelLabel,
		}
		return assignment
	}
	assignment.Seat = online.Seat(plan.allocation.InitiatorSeat)
	assignment.OpponentLabel = plan.allocation.OpponentLabel
	assignment.Control = online.SeatControl{
		Kind:       online.ControlKind(plan.allocation.OpponentControlKind),
		ModelLabel: plan.allocation.OpponentControlModelLabel,
	}
	return assignment
}

// issueEngineCredential mints the seat-scoped credential of the engine seat.
//
// The credential is scoped to one match and one seat, so it cannot act for
// the owner, for another match, or for another seat.
func (s *Service) issueEngineCredential(ctx context.Context, matchID string, plan reservationPlan, origin string) (GuestCredential, error) {
	if s.credentials == nil {
		return GuestCredential{}, fmt.Errorf("%w: the queue cannot issue an engine credential", ErrUnavailable)
	}
	engineID := plan.engineID
	if engineID == "" {
		engineID = engineParticipantID(plan.allocation.OperationID)
	}
	issued, err := s.credentials.IssueEngineSeatCredential(ctx, onlineauth.EngineSeatRequest{
		MatchID: matchID,
		Seat:    plan.engineSeat,
		GuestID: engineID,
		Origin:  origin,
	})
	if err != nil {
		return GuestCredential{}, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return GuestCredential{
		GuestID:   issued.GuestID,
		MatchID:   issued.MatchID,
		Seat:      issued.Seat,
		Token:     issued.Secret,
		ExpiresAt: issued.ExpiresAt.UTC(),
	}, nil
}

// commitAllocation publishes a reservation.
//
// The allocation is completed first, so the guard of the entry table always
// finds a committed allocation that names the match and the consumed entry.
func (s *Service) commitAllocation(ctx context.Context, plan reservationPlan, matchID string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	now := s.now().UTC()
	if err = lockBucket(ctx, tx, plan.initiator.StartingTimeMs, plan.initiator.IncrementMs); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE online_queue_allocations SET status='committed',match_id=$2,committed_at=$3 WHERE allocation_id=$1 AND status='pending'`, plan.allocation.AllocationID, matchID, now)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// The reservation was already committed. A repeated call finds the
		// same match and publishes nothing new.
		committed, found, err := s.loadAllocationByID(ctx, tx, plan.allocation.AllocationID)
		if err != nil {
			return err
		}
		if !found || committed.Status != "committed" || committed.MatchID == nil || *committed.MatchID != matchID {
			return fmt.Errorf("%w: the reservation is missing", ErrUnavailable)
		}
		if err = tx.Commit(ctx); err != nil {
			return err
		}
		return nil
	}
	if _, err = tx.Exec(ctx, `UPDATE online_queue_entries SET status='assigned',internal_state='assigned',assigned_match_id=$2,cutoff_at=NULL,version=version+1,updated_at=$3 WHERE entry_id=$1`, plan.allocation.InitiatorEntryID, matchID, now); err != nil {
		return err
	}
	if plan.allocation.OpponentEntryID != nil {
		if _, err = tx.Exec(ctx, `UPDATE online_queue_entries SET status='assigned',internal_state='assigned',assigned_match_id=$2,cutoff_at=NULL,version=version+1,updated_at=$3 WHERE entry_id=$1`, *plan.allocation.OpponentEntryID, matchID, now); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}

// engineParticipantID derives the participant identity of a browser engine
// seat from the idempotency key of its allocation.
//
// The derivation is deterministic, so a recovered reservation knows the
// identity of its engine seat without storing it twice. The identity is not
// derived from an owner identifier, so the engine seat is never the
// requesting account.
func engineParticipantID(operationID string) string {
	sum := sha256.Sum256([]byte("kamkmchess/queue-engine/" + operationID))
	return "engine_" + hex.EncodeToString(sum[:])[:24]
}

// loadAssignmentReceipt reads the stored answer of one allocation operation.
func (s *Service) loadAssignmentReceipt(ctx context.Context, entryID, operationID string, hash []byte) (Assignment, bool, error) {
	raw, found, err := s.loadReceiptRaw(ctx, entryID, operationID, hash)
	if err != nil || !found {
		return Assignment{}, found, err
	}
	var assignment Assignment
	if err = json.Unmarshal(raw, &assignment); err != nil {
		return Assignment{}, false, ErrUnavailable
	}
	return assignment, true, nil
}

// storeAssignmentReceipt writes the answer of one allocation operation.
//
// The receipt is written in its own transaction, after the allocation is
// committed, so a stored answer always names a committed game.
func (s *Service) storeAssignmentReceipt(ctx context.Context, entryID, operationID string, hash []byte, assignment Assignment) error {
	raw, err := json.Marshal(assignment)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO online_operation_receipts(scope_kind,scope_id,operation_id,request_hash,result_json,version,control_epoch,accepted_at) VALUES('queue',$1,$2,$3,$4,1,1,clock_timestamp())
		ON CONFLICT (scope_kind,scope_id,operation_id) DO NOTHING`, entryID, operationID, hash, raw); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}
