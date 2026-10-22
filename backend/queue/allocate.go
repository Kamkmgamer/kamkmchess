package queue

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/locks"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/subject"
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
// A candidate that is dropped after it was selected is never consumed, and
// the engine never takes the seat of an entry whose later candidate is still
// eligible. The decision refuses itself with a conflict in that case, so the
// caller repeats the fallback and the waiting candidate wins over the
// engine.
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
	// RecordFallbackPending asks the decision to record the pending engine
	// fallback when the window ended without a candidate.
	//
	// Only the reconciliation loop asks for it. The record is written in
	// the transaction of the decision, under the bucket lock, so a kept
	// search that won the interval is never overwritten.
	RecordFallbackPending bool
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
	plan, err := s.decide(ctx, actor, entryID, request)
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
//
// The entry row is read again under the bucket lock, so a transition of the
// entry that committed while the decision waited for the lock is part of the
// decision and not a later poll: a kept search and a re-armed window move the
// bound of the entry, and the first scan of the decision uses the bound of
// the row that the decision observes under the lock.
//
// The decision time is sampled after the locks of the decision, not before
// them. A decision that waited for the bucket lock, for an account scope
// lock or for its own row observes the instant it actually runs at: a
// readiness lease that died during the wait is a dead lease, and a cutoff
// that passed during the wait is a passed cutoff.
func (s *Service) decide(ctx context.Context, actor online.ParticipantRef, entryID string, request allocationRequest) (reservationPlan, error) {
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
	// An entry that already produced a game keeps its opponent. The check
	// runs before the rules policy is asked, so a repeated request costs no
	// rules evaluation. The transaction checks it again under the lock.
	if existing, role, found, err := s.loadAllocationForEntry(ctx, s.db, entryID); err != nil {
		return reservationPlan{}, err
	} else if found {
		if existing.MatchID == nil {
			return reservationPlan{}, fmt.Errorf("%w: the allocation names no match", ErrUnavailable)
		}
		return planFromAllocation(existing, role), nil
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
	// The lock order of the queue is fixed: the bucket lock, then the
	// account scope locks of the participants in ascending order, then the
	// row locks. Every queue write takes them in that order, so two
	// allocations never wait for each other in the opposite order.
	if err = lockBucket(ctx, tx, record.StartingTimeMs, record.IncrementMs); err != nil {
		return reservationPlan{}, err
	}
	// The initiator row is read again under the bucket lock. Every queue
	// write of an entry takes the bucket lock before it writes the row, so
	// the row that is read here is the authoritative one: a kept search or a
	// re-armed window that committed while the decision waited for the
	// bucket lock is observed, and the first scan of the decision uses its
	// bound.
	//
	// The read takes no row lock. The lock order of the queue is the bucket
	// lock, then the account scope locks, then the row locks, and the row of
	// the entry is locked further down, after the account scopes.
	//
	// The transaction reads in read committed, so this statement observes
	// every write that committed before it started. The write it has to
	// observe committed before the bucket lock was free, so the read is
	// never stale.
	authoritative, err := s.loadEntry(ctx, tx, entryID)
	if err != nil {
		return reservationPlan{}, err
	}
	if authoritative.OwnerID != actor.ID {
		return reservationPlan{}, ErrNotFound
	}
	record = authoritative
	// The scan runs under the bucket lock, so it observes the committed
	// state of the bucket and the bound of the authoritative row: the
	// current time before the cutoff and the original cutoff at or after
	// it, and the current time for an entry that keeps searching.
	scanNow := s.now().UTC()
	bound := record.bound(scanNow)
	// The candidate is selected before the row locks, because the account
	// scope locks of both participants are taken together and in ascending
	// order.
	candidate, found, err := s.findCandidate(ctx, tx, record, bound, scanNow)
	if err != nil {
		return reservationPlan{}, err
	}
	scopes := []string{locks.AccountScope("account", actor.ID)}
	if found {
		scopes = append(scopes, locks.AccountScope("account", candidate.OwnerID))
	}
	if err = locks.LockAccountScopes(ctx, tx, scopes); err != nil {
		return reservationPlan{}, err
	}
	// The durable removal of every participant is re-read inside the
	// transaction. A removed account never writes queue state and is never
	// paired.
	if err = assertAccountPresent(ctx, tx, actor.ID); err != nil {
		return reservationPlan{}, err
	}
	// dropped marks a candidate that was selected and then lost. A dropped
	// candidate is never consumed, and it never hands the seat of the entry
	// to the engine: the scan runs again at the decision time.
	dropped := false
	if found {
		if err = assertAccountPresent(ctx, tx, candidate.OwnerID); err != nil {
			if !errors.Is(err, ErrAccountRemoved) {
				return reservationPlan{}, err
			}
			// The account of the candidate was removed while the decision
			// waited for the account scope lock of its owner. The candidate
			// is dropped, exactly like a candidate whose readiness lease
			// died during that wait: it is never consumed, and it never hands
			// the seat of the entry to the engine. The scan runs again at the
			// decision time, so a later candidate that is still eligible
			// wins over the engine.
			dropped = true
			found = false
		}
	}
	record, err = s.lockEntry(ctx, tx, entryID)
	if err != nil {
		return reservationPlan{}, err
	}
	if record.OwnerID != actor.ID {
		return reservationPlan{}, ErrNotFound
	}
	existing, role, allocated, err := s.loadAllocationForEntry(ctx, tx, entryID)
	if err != nil {
		return reservationPlan{}, err
	}
	if allocated {
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
	// The authoritative decision time is sampled after every lock of the
	// decision: the bucket lock, the account scope locks and the row lock.
	// A decision that waited observes the instant it runs at, so a lease
	// that died during the wait is a dead lease and a cutoff that passed
	// during the wait is a passed cutoff.
	now := s.now().UTC()
	// The readiness lease of the initiator is enforced inside the decision.
	// An entry whose owner stopped responding never consumes a live
	// candidate and never produces a game nobody will play.
	if record.ExpiresAt != nil && !record.ExpiresAt.After(now) {
		return reservationPlan{}, fmt.Errorf("%w: the entry expired", ErrConflict)
	}
	if found {
		// The final candidate check uses the decision time and the bound of
		// the locked entry. A candidate that is no longer eligible at the
		// decision time is not consumed, and a candidate that was ready by
		// the original cutoff still wins over the engine.
		candidate, found, err = s.lockCandidate(ctx, tx, record, candidate, record.bound(now), now)
		if err != nil {
			return reservationPlan{}, err
		}
		if !found {
			// The selected candidate was dropped: its readiness lease died
			// while the decision waited for the account scope lock of its
			// owner. The scan runs again at the decision time, so a later
			// candidate that is still eligible is never lost to the engine.
			dropped = true
		}
	}
	if dropped {
		// A dropped candidate never hands the seat of the entry to the
		// engine. The scan runs again at the decision time, so a later
		// candidate that is still eligible is never lost to the engine.
		candidate, found, err = s.rescanCandidate(ctx, tx, record, scopes, record.bound(now), now)
		if err != nil {
			if !errors.Is(err, errCandidateRetry) {
				return reservationPlan{}, err
			}
			if mode == modeFallback {
				// The browser engine may not take the seat while a candidate
				// is still eligible. The refusal is a retryable conflict: the
				// caller repeats the fallback and the candidate wins over
				// the engine.
				return reservationPlan{}, fmt.Errorf("%w: %w", ErrConflict, err)
			}
			// The pairing of two owners has no deadline. The answer is "no
			// candidate right now", and the caller asks again.
			return reservationPlan{}, ErrNoCandidate
		}
	}
	// The window guard is the same for the pending engine fallback and for
	// the browser engine itself. The engine may only take the seat of an
	// entry whose original cutoff the service has reached, and the pending
	// record says the same thing about the deadline.
	windowEnded := record.windowEnded(now)
	if !found {
		if mode == modeCandidate {
			if request.RecordFallbackPending && windowEnded {
				// The window ended without a candidate. The entry waits for
				// the browser engine fallback. The record is written in the
				// transaction of the decision, under the bucket lock, so a
				// kept search that won the interval is never overwritten.
				recorded, err := s.recordFallbackPending(ctx, tx, record, now)
				if err != nil {
					return reservationPlan{}, err
				}
				if recorded {
					if err = tx.Commit(ctx); err != nil {
						return reservationPlan{}, err
					}
					return reservationPlan{}, fmt.Errorf("%w: %w", errFallbackPending, ErrNoCandidate)
				}
			}
			return reservationPlan{}, ErrNoCandidate
		}
		// The browser engine may only be committed when the search window of
		// the entry has ended. The cutoff is the deadline the ready
		// acceptance armed and it never moves, so an engine that is
		// committed before it would take the seat of an opponent the owner
		// was still promised a chance to find.
		if !windowEnded {
			return reservationPlan{}, fmt.Errorf("%w: the search window of the entry has not ended", ErrConflict)
		}
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
// before the cutoff and the original cutoff at or after it.
//
// A removed account is never a candidate. The removal of an account deletes
// its waiting entries, and a restored copy may carry an entry of a removed
// account without that sanitation: a removed account is never paired, so its
// entry never answers the scan.
//
// The scan does not lock the row. The bucket lock orders the whole decision,
// so a candidate that another transaction reserved is already committed as
// consumed when this transaction reads the bucket. The row itself is locked
// after the account scope of the candidate, in the order of the shared seams.
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
		  AND NOT EXISTS (SELECT 1 FROM online_account_deletions d WHERE d.account_id=`+subject.SQLReference("e.owner_id")+`)
		  AND NOT EXISTS (SELECT 1 FROM online_removal_requests r WHERE r.subject_kind='account' AND r.subject_id=`+subject.SQLReference("e.owner_id")+`)
		ORDER BY e.ready_at, e.created_at, e.entry_id
		LIMIT 1`,
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

// maxCandidateRescans bounds the rescan of one decision.
//
// Every round of the rescan drops one candidate, and a dropped candidate is
// never eligible again, so the bound is a safety net and never the normal
// path of a decision.
const maxCandidateRescans = 4

// rescanCandidate selects a candidate again at the decision time.
//
// The candidate of the first scan can be dropped after it was selected: its
// readiness lease may die while the decision waits for the account scope
// lock of its owner, or its account may be removed during that wait. A
// dropped candidate is never consumed, and the browser engine must not take
// the seat while another candidate is still eligible.
//
// The scan therefore runs again at the decision time, with the bound the
// first scan used: a candidate that was ready by the original cutoff still
// wins over the engine.
//
// A candidate is only paired when the account scope of its owner is already
// held by the decision. The scope locks are taken before the row locks, and
// a scope that is taken after a row lock would break the lock order of the
// queue. A candidate whose scope is not held is therefore refused with
// errCandidateRetry: the caller repeats the decision, and the repeat starts
// it with the scope set of that candidate.
func (s *Service) rescanCandidate(ctx context.Context, tx pgx.Tx, record entryRecord, scopes []string, bound, now time.Time) (candidateRecord, bool, error) {
	for round := 0; round < maxCandidateRescans; round++ {
		candidate, found, err := s.findCandidate(ctx, tx, record, bound, now)
		if err != nil {
			return candidateRecord{}, false, err
		}
		if !found {
			return candidateRecord{}, false, nil
		}
		if !scopeHeld(scopes, locks.AccountScope("account", candidate.OwnerID)) {
			return candidateRecord{}, false, fmt.Errorf("%w: the account scope of the candidate is not held by the decision", errCandidateRetry)
		}
		locked, ok, err := s.lockCandidate(ctx, tx, record, candidate, bound, now)
		if err != nil {
			return candidateRecord{}, false, err
		}
		if ok {
			return locked, true, nil
		}
	}
	// The scan keeps finding candidates that this decision cannot consume.
	// The engine is not committed while a candidate is still eligible, so the
	// decision is refused and the caller repeats it.
	return candidateRecord{}, false, fmt.Errorf("%w: the candidates of the bucket are not consumed", errCandidateRetry)
}

// scopeHeld reports whether the decision holds the account scope of one
// owner.
func scopeHeld(scopes []string, scope string) bool {
	for _, held := range scopes {
		if held == scope {
			return true
		}
	}
	return false
}

// recordFallbackPending records that the window of an entry ended without a
// compatible candidate.
//
// The row of the entry is locked by the decision, so the record is written
// under the bucket lock and in the same transaction as the decision that
// found no candidate. A kept search that won the interval is never
// overwritten: the condition of the update refuses an entry that keeps
// searching.
func (s *Service) recordFallbackPending(ctx context.Context, tx pgx.Tx, record entryRecord, now time.Time) (bool, error) {
	tag, err := tx.Exec(ctx, `UPDATE online_queue_entries SET internal_state='fallback',version=version+1,updated_at=$2 WHERE entry_id=$1 AND internal_state='waiting' AND keep_searching=false`, record.EntryID, now)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// lockCandidate locks the row of the selected candidate and re-checks its
// eligibility.
//
// This is the final candidate check of the decision. It runs with the
// decision time and the bound of the locked entry, so a candidate whose
// readiness lease died while the decision waited is not consumed, and a
// candidate that was ready by the original cutoff still wins over the
// engine.
//
// The candidate is locked after the account scope of its owner, so the row
// lock never precedes a scope lock.
func (s *Service) lockCandidate(ctx context.Context, tx pgx.Tx, record entryRecord, candidate candidateRecord, bound, now time.Time) (candidateRecord, bool, error) {
	row := tx.QueryRow(ctx, `SELECT e.entry_id,e.owner_id,e.seat_control_kind,e.seat_control_model_label,e.ready_at
		FROM online_queue_entries e
		WHERE e.entry_id=$1
		  AND e.internal_state='waiting' AND e.status='waiting'
		  AND e.ready_at IS NOT NULL AND e.ready_at<=$2
		  AND (e.expires_at IS NULL OR e.expires_at>$3)
		  AND NOT EXISTS (SELECT 1 FROM online_queue_allocation_entries x WHERE x.entry_id=e.entry_id)
		FOR UPDATE OF e`, candidate.EntryID, bound, now)
	var locked candidateRecord
	err := row.Scan(&locked.EntryID, &locked.OwnerID, &locked.ControlKind, &locked.ControlModelLabel, &locked.ReadyAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return candidateRecord{}, false, nil
	}
	if err != nil {
		return candidateRecord{}, false, err
	}
	return locked, true, nil
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
//
// The issuance is one atomic decision of the issuer. The issuer reads the
// live credential of the seat inside the seat lock and it mints a credential
// only when the seat has none, so the check and the write cannot be split.
// A separate read before the issuance would race with a concurrent issuance:
// two tabs of one entry would both observe that the seat has no credential,
// and the second issuance would revoke the secret the first tab already
// holds. The outcome of the issuance reports whether a credential was minted
// at all, so a routine retry that found a live credential answers with the
// assignment and without a secret.
func (s *Service) engineCredential(ctx context.Context, plan reservationPlan, request allocationRequest) (GuestCredential, bool, error) {
	if s.credentials == nil {
		return GuestCredential{}, false, fmt.Errorf("%w: the queue cannot issue an engine credential", ErrUnavailable)
	}
	engineID := plan.engineID
	if engineID == "" {
		engineID = engineParticipantID(plan.allocation.OperationID)
	}
	outcome, err := s.credentials.IssueEngineSeatCredential(ctx, onlineauth.EngineSeatRequest{
		MatchID: plan.matchID,
		Seat:    plan.engineSeat,
		GuestID: engineID,
		Origin:  request.Origin,
		// Only an explicit recovery rotates the credential of the seat.
		Rotate: request.CredentialRecovery,
	})
	if err != nil {
		return GuestCredential{}, false, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if !outcome.Issued {
		// The seat already had a live credential. The browser holds it, so
		// the answer names the assignment and carries no secret.
		return GuestCredential{}, false, nil
	}
	issued := outcome.Credential
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
