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
	return s.allocate(ctx, actor, entryID, allocationRequest{Operation: operation})
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
//
// The credential of the engine seat is issued once. A routine retry of the
// same fallback never rotates it, so the secret the browser already holds
// stays usable. An owner that lost the answer and holds no credential asks
// for an explicit recovery, and that recovery is the only rotation.
func (s *Service) Fallback(ctx context.Context, actor online.ParticipantRef, entryID string, request FallbackRequest) (Assignment, error) {
	return s.allocate(ctx, actor, entryID, allocationRequest{
		Operation:          request.Operation,
		CredentialRecovery: request.CredentialRecovery,
		Origin:             request.Origin,
		Fallback:           true,
	})
}

// FallbackRequest describes one browser engine fallback.
type FallbackRequest struct {
	// Operation identifies the operation. When it is present the answer is
	// stored with the operation, so a repeated call returns the same
	// answer.
	Operation Operation
	// CredentialRecovery asks for a fresh credential of the engine seat.
	//
	// It is the explicit rotation of an owner that lost the answer of the
	// fallback and holds no usable credential. A routine retry never sets
	// it: it would rotate a secret the browser still has.
	CredentialRecovery bool
	// Origin is the browser origin the credential is scoped to.
	Origin string
}

// allocationRequest is one allocation request.
type allocationRequest struct {
	Operation Operation
	// CredentialRecovery asks for a fresh credential of the engine seat.
	CredentialRecovery bool
	// Origin is the browser origin the credential is scoped to.
	Origin string
	// Fallback asks for the browser engine when no candidate is available.
	Fallback bool
}

// allocate runs the single authoritative allocation decision.
//
// The decision is one transaction that holds the time-control bucket lock:
// the entries are consumed, the canonical match is written by the shared
// writer and the assignment is published together. Two owners of one pair, or
// the reconciliation loop and an owner, therefore observe one order and
// never write the same match twice.
func (s *Service) allocate(ctx context.Context, actor online.ParticipantRef, entryID string, request allocationRequest) (Assignment, error) {
	if err := validateActor(actor); err != nil {
		return Assignment{}, err
	}
	if request.Operation.ID != "" {
		if !operationIDShape(request.Operation.ID) {
			return Assignment{}, fmt.Errorf("%w: operation id", ErrInvalidRequest)
		}
		// An explicit recovery never answers from the stored receipt: the
		// owner asked for a fresh credential.
		if !request.CredentialRecovery {
			stored, found, err := s.loadAssignmentReceipt(ctx, entryID, request.Operation.ID, operationHash(actor, entryID, request.Operation.ID))
			if err != nil {
				return Assignment{}, err
			}
			if found {
				return stored, nil
			}
		}
	}
	now := s.now().UTC()
	plan, err := s.decide(ctx, actor, entryID, request, now)
	if err != nil {
		return Assignment{}, err
	}
	assignment := assignmentFor(plan)
	if plan.allocation.Kind == "fallback" {
		credential, issued, err := s.engineCredential(ctx, plan, request)
		if err != nil {
			return Assignment{}, err
		}
		if issued {
			assignment.GuestCredential = &credential
		}
	}
	if request.Operation.ID != "" {
		// The stored answer never carries the secret. The plaintext of a
		// credential exists only in the answer that delivered it.
		if err = s.storeAssignmentReceipt(ctx, entryID, request.Operation.ID, operationHash(actor, entryID, request.Operation.ID), assignment); err != nil {
			return Assignment{}, err
		}
	}
	return assignment, nil
}

// reservationPlan is the decision of one allocation.
type reservationPlan struct {
	allocation allocationRecord
	// role is the role of the requesting entry in the allocation.
	role string
	// actor is the participant that caused the allocation. It is the
	// creator of the canonical match.
	actor online.ParticipantRef
	// matchID is the canonical match of the allocation.
	matchID string
	// engineSeat is the seat the browser engine plays, if the allocation is
	// a fallback.
	engineSeat online.Seat
	// engineID is the participant identity of the browser engine.
	engineID string
}

// decide writes the decision of one allocation in one transaction.
//
// The bucket lock is held from the first read of the entry until the commit,
// so the candidate selection, the consumption of the entries and the write of
// the canonical match are one ordered decision.
func (s *Service) decide(ctx context.Context, actor online.ParticipantRef, entryID string, request allocationRequest, now time.Time) (reservationPlan, error) {
	mode := modeCandidate
	if request.Fallback {
		mode = modeFallback
	}
	record, err := s.loadEntry(ctx, s.db, entryID)
	if err != nil {
		return reservationPlan{}, err
	}
	if record.OwnerID != actor.ID {
		return reservationPlan{}, ErrNotFound
	}
	// The rules policy is asked before the transaction opens. The queue only
	// ever produces the standard position, so the probe covers the only
	// position a queue game can use.
	if err = s.validateSetup(ctx, record); err != nil {
		return reservationPlan{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return reservationPlan{}, err
	}
	defer tx.Rollback(ctx)
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
		// The entry already produced a game. Its opponent is fixed and the
		// answer names the committed allocation.
		if existing.MatchID == nil {
			return reservationPlan{}, fmt.Errorf("%w: the allocation names no match", ErrUnavailable)
		}
		plan := planFromAllocation(existing, role)
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
	// The readiness lease of the initiator is enforced inside the decision.
	// An entry whose owner stopped responding never consumes a live
	// candidate and never produces a game nobody will play.
	if record.ExpiresAt != nil && !record.ExpiresAt.After(now) {
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
	plan, setup, err := s.buildPlan(ctx, record, candidate, found, operationID)
	if err != nil {
		return reservationPlan{}, err
	}
	// The canonical match is written by the shared writer inside this
	// transaction, so the game and the consumption of the entries commit
	// together.
	command, err := online.NewAllocationCommand(plan.actor, setup, operationID)
	if err != nil {
		return reservationPlan{}, err
	}
	result, err := s.allocator.CreateMatchInTx(ctx, tx, command)
	if err != nil {
		return reservationPlan{}, err
	}
	matchID := result.Receipt.MatchID
	if matchID == "" {
		return reservationPlan{}, fmt.Errorf("%w: the allocator returned no match", ErrUnavailable)
	}
	plan.matchID = matchID
	if err = s.writeAllocation(ctx, tx, record, plan, matchID, now); err != nil {
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

// validateSetup asks the rules policy about the starting position of a queue
// game.
//
// The probe uses the standard position and the clock of the entry, so it
// covers the only position a queue game can use. It runs before the
// transaction opens, so no lock is held while the rules process works.
func (s *Service) validateSetup(ctx context.Context, record entryRecord) error {
	engineLabel := s.engineLabel
	probe := online.CreateMatchSetup{
		Variant:     "orthodox",
		StartingFEN: StandardStartingPosition,
		TimeControl: online.TimeControl{StartingTimeMs: record.StartingTimeMs, IncrementMs: record.IncrementMs},
		Seats: online.CreateMatchSeats{
			White: online.CreateSeat{
				Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: record.OwnerID},
				PublicLabel: "Player",
				Control:     online.SeatControl{Kind: online.ControlHuman},
			},
			Black: online.CreateSeat{
				Participant: online.ParticipantRef{Kind: online.ParticipantGuest, ID: "queue-setup-probe"},
				PublicLabel: engineLabel,
				Control:     online.SeatControl{Kind: online.ControlEngine, ModelLabel: &engineLabel},
			},
		},
	}
	if err := s.allocator.ValidateSetup(ctx, probe); err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return nil
}

// buildPlan builds the setup and the stored decision of one allocation.
//
// The colors are random and the starting position is the standard one. A
// custom position never enters the queue. The declared controls carry the
// canonical publishable labels, so the queue never stores or returns a raw
// requested label.
func (s *Service) buildPlan(ctx context.Context, record entryRecord, candidate candidateRecord, found bool, operationID string) (reservationPlan, online.CreateMatchSetup, error) {
	initiatorLabel := s.labelFor(ctx, record.OwnerID)
	initiatorControl, err := s.controls.ResolveDeclaredControl(ctx, string(online.ParticipantAccount), record.OwnerID, online.SeatControl{Kind: online.ControlKind(record.ControlKind), ModelLabel: record.ControlModelLabel})
	if err != nil {
		return reservationPlan{}, online.CreateMatchSetup{}, err
	}
	initiator := online.CreateSeat{
		Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: record.OwnerID},
		PublicLabel: initiatorLabel,
		Control:     initiatorControl,
	}
	plan := reservationPlan{
		role:     roleInitiator,
		actor:    online.ParticipantRef{Kind: online.ParticipantAccount, ID: record.OwnerID},
		engineID: "",
	}
	var opponent online.CreateSeat
	var opponentEntryID *string
	if found {
		opponentControl, err := s.controls.ResolveDeclaredControl(ctx, string(online.ParticipantAccount), candidate.OwnerID, online.SeatControl{Kind: online.ControlKind(candidate.ControlKind), ModelLabel: candidate.ControlModelLabel})
		if err != nil {
			return reservationPlan{}, online.CreateMatchSetup{}, err
		}
		opponent = online.CreateSeat{
			Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: candidate.OwnerID},
			PublicLabel: s.labelFor(ctx, candidate.OwnerID),
			Control:     opponentControl,
		}
		value := candidate.EntryID
		opponentEntryID = &value
	} else {
		// The browser engine is its own participant. It is never the
		// requesting account: the owner receives a credential that is scoped
		// to the engine seat, not authority over the opponent seat.
		engineID := engineParticipantID(operationID)
		engineLabel := s.engineLabel
		engineControl, err := s.controls.ResolveDeclaredControl(ctx, string(online.ParticipantGuest), engineID, online.SeatControl{Kind: online.ControlEngine, ModelLabel: &engineLabel})
		if err != nil {
			return reservationPlan{}, online.CreateMatchSetup{}, err
		}
		opponent = online.CreateSeat{
			Participant: online.ParticipantRef{Kind: online.ParticipantGuest, ID: engineID},
			PublicLabel: engineLabel,
			Control:     engineControl,
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
	allocationID, err := newIdentifier("qal_")
	if err != nil {
		return reservationPlan{}, online.CreateMatchSetup{}, err
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
		Status:                     "committed",
		InitiatorLabel:             initiatorLabel,
		InitiatorControlKind:       string(initiatorControl.Kind),
		InitiatorControlModelLabel: initiatorControl.ModelLabel,
		OpponentLabel:              opponent.PublicLabel,
		OpponentControlKind:        string(opponent.Control.Kind),
		OpponentControlModelLabel:  opponent.Control.ModelLabel,
	}
	plan.engineSeat = opponentSeat
	return plan, setup, nil
}

// planFromAllocation reads the plan of an existing allocation.
func planFromAllocation(allocation allocationRecord, role string) reservationPlan {
	plan := reservationPlan{
		allocation: allocation,
		role:       role,
		engineSeat: online.Seat(allocation.OpponentSeat),
	}
	if allocation.MatchID != nil {
		plan.matchID = *allocation.MatchID
	}
	if allocation.Kind == "fallback" {
		plan.engineID = engineParticipantID(allocation.OperationID)
	}
	return plan
}

// writeAllocation stores the decision and publishes the entries.
//
// The rows are written in one transaction, so the entries are consumed
// together with the decision that fixed the opponent. The unique index on
// the consumed entry is what makes "one entry, one game" a database fact.
func (s *Service) writeAllocation(ctx context.Context, tx pgx.Tx, record entryRecord, plan reservationPlan, matchID string, now time.Time) error {
	if _, err := tx.Exec(ctx, `INSERT INTO online_queue_allocations(allocation_id,kind,initiator_entry_id,initiator_seat,opponent_entry_id,opponent_seat,operation_id,match_id,status,initiator_label,initiator_control_kind,initiator_control_model_label,opponent_label,opponent_control_kind,opponent_control_model_label,created_at,committed_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,'committed',$9,$10,$11,$12,$13,$14,$15,$15)`,
		plan.allocation.AllocationID, plan.allocation.Kind, plan.allocation.InitiatorEntryID, plan.allocation.InitiatorSeat,
		plan.allocation.OpponentEntryID, plan.allocation.OpponentSeat, plan.allocation.OperationID, matchID,
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
	if _, err := tx.Exec(ctx, `UPDATE online_queue_entries SET status='assigned',internal_state='assigned',assigned_match_id=$2,cutoff_at=NULL,version=version+1,updated_at=$3 WHERE entry_id=$1`, plan.allocation.InitiatorEntryID, matchID, now); err != nil {
		return err
	}
	if plan.allocation.OpponentEntryID != nil {
		if _, err := tx.Exec(ctx, `UPDATE online_queue_entries SET status='assigned',internal_state='assigned',assigned_match_id=$2,cutoff_at=NULL,version=version+1,updated_at=$3 WHERE entry_id=$1`, *plan.allocation.OpponentEntryID, matchID, now); err != nil {
			return err
		}
	}
	return nil
}

// assignmentFor answers with the seat and the opponent of the caller.
//
// The caller of the queue may be the initiator of the allocation or its
// opponent. Both receive the same game and their own seat.
func assignmentFor(plan reservationPlan) Assignment {
	assignment := Assignment{SchemaVersion: online.ContractsSchemaVersion, MatchID: plan.matchID}
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

// engineCredential returns the credential of the engine seat.
//
// A live credential is never rotated by a routine retry: the browser already
// holds it, and a rotation would break the engine seat of a running game. The
// credential is issued when the seat has none, and an explicit recovery of an
// owner that lost the answer rotates it on purpose.
func (s *Service) engineCredential(ctx context.Context, plan reservationPlan, request allocationRequest) (GuestCredential, bool, error) {
	if s.credentials == nil {
		return GuestCredential{}, false, fmt.Errorf("%w: the queue cannot issue an engine credential", ErrUnavailable)
	}
	engineID := plan.engineID
	if engineID == "" {
		engineID = engineParticipantID(plan.allocation.OperationID)
	}
	if !request.CredentialRecovery {
		live, err := s.credentials.HasEngineSeatCredential(ctx, plan.matchID, plan.engineSeat)
		if err != nil {
			return GuestCredential{}, false, fmt.Errorf("%w: %v", ErrUnavailable, err)
		}
		if live {
			// The browser holds a usable credential. The answer names the
			// assignment and carries no secret.
			return GuestCredential{}, false, nil
		}
	}
	issued, err := s.credentials.IssueEngineSeatCredential(ctx, onlineauth.EngineSeatRequest{
		MatchID: plan.matchID,
		Seat:    plan.engineSeat,
		GuestID: engineID,
		Origin:  request.Origin,
	})
	if err != nil {
		return GuestCredential{}, false, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return GuestCredential{
		GuestID:   issued.GuestID,
		MatchID:   issued.MatchID,
		Seat:      issued.Seat,
		Token:     issued.Secret,
		ExpiresAt: issued.ExpiresAt.UTC(),
	}, true, nil
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
//
// The stored answer never carries a secret. The plaintext of a credential
// exists only in the answer that delivered it.
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
// committed, so a stored answer always names a committed game. The secret of
// an engine credential is never part of it.
func (s *Service) storeAssignmentReceipt(ctx context.Context, entryID, operationID string, hash []byte, assignment Assignment) error {
	stored := assignment
	stored.GuestCredential = nil
	raw, err := json.Marshal(stored)
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
