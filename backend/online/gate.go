package online

import (
	"context"

	"github.com/Kamkmgamer/kamkmchess/backend/locks"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// The shared transaction gate.
//
// Every mutation of the online service passes this gate inside the
// transaction that writes it. The gate is durable, so a second instance and
// a restarted process refuse the same mutations, and it is ordered, so a
// suspension that is opened while a command runs is committed after that
// command and never before it.
//
// The gate is derived from three durable sources:
//
//   - a restore gate that was not released yet: the database was restored
//     from a backup and the removal ledger was not replayed;
//   - a suspension boundary that was not applied yet: a planned suspension,
//     or an interruption that is still being recovered;
//   - the latest service epoch, when its recovery has not completed.
//
// Only the latest epoch counts. An epoch that an earlier instance opened and
// never completed is history, not a pending recovery, so a stale row never
// closes the gate of a healthy service.
//
// The reads never change. The live clocks, the live views and the update
// stream keep working while the gate is closed, so a client still sees the
// state of its match and the recovering state of the service.
//
// The lock order of the shared seams is fixed:
//
//	account scope locks (ascending) -> gate lock -> match row locks
//
// A flow that takes more than one of them takes them in that order, so the
// online writer, the trusted allocator and the privacy flow never deadlock
// against each other.

// GateAdvisoryKey is the advisory lock that orders the mutations against the
// suspensions.
//
// A mutation takes the shared lock and a suspension takes the exclusive one,
// so a suspension waits for the mutations that are already running and every
// later mutation sees the closed gate.
const GateAdvisoryKey int64 = 0x4b484d4b47415445

// The stable reasons of a closed gate.
const (
	// GateReasonRestorePending means the database was restored and the
	// removal ledger was not replayed yet.
	GateReasonRestorePending = "restore-pending"
	// GateReasonSuspensionPending means a suspension was planned or an
	// interruption was not applied yet.
	GateReasonSuspensionPending = "suspension-pending"
	// GateReasonRecoveryPending means the latest service epoch is still
	// recovering.
	GateReasonRecoveryPending = "recovery-pending"
	// GateReasonParticipantRemoved means a participant of the trusted
	// allocation was removed.
	GateReasonParticipantRemoved = "participant-removed"
)

// GateState is the durable admission state of the online service.
type GateState struct {
	// Open reports whether the service may accept a mutation.
	Open bool
	// Reason is the stable reason code of a closed gate.
	Reason string
}

// gateQuerier is the read and write surface the gate needs. A transaction
// and the connection pool both satisfy it.
type gateQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

// ServiceGate reads the durable admission state of the service.
//
// The read is a single statement over the three durable sources, so every
// instance of the service sees the same state. A read that fails is an
// error, never an open gate: the caller fails closed.
func ServiceGate(ctx context.Context, q Querier) (GateState, error) {
	var restore, suspension, recovery bool
	err := q.QueryRow(ctx, `SELECT
  EXISTS (SELECT 1 FROM online_restore_gates WHERE serving_allowed = false),
  EXISTS (SELECT 1 FROM online_suspension_boundaries WHERE adjusted_at IS NULL),
  EXISTS (SELECT 1 FROM online_service_epochs
          WHERE recovered_at IS NULL
            AND epoch = (SELECT COALESCE(MAX(epoch),0) FROM online_service_epochs))`).
		Scan(&restore, &suspension, &recovery)
	if err != nil {
		return GateState{}, err
	}
	switch {
	case restore:
		return GateState{Open: false, Reason: GateReasonRestorePending}, nil
	case suspension:
		return GateState{Open: false, Reason: GateReasonSuspensionPending}, nil
	case recovery:
		return GateState{Open: false, Reason: GateReasonRecoveryPending}, nil
	default:
		return GateState{Open: true}, nil
	}
}

// requireGate takes the shared gate lock and refuses a closed gate.
//
// The lock is what orders the mutation against a suspension: the closing
// transaction waits for the exclusive lock, so a command that is already
// running commits before the suspension and a command that starts after the
// suspension is refused.
//
// The check belongs inside the transaction that writes the mutation, so a
// command that started before a suspension and finished after it cannot
// commit.
func (s *Service) requireGate(ctx context.Context, q gateQuerier) error {
	if _, err := q.Exec(ctx, `SELECT pg_advisory_xact_lock_shared($1)`, GateAdvisoryKey); err != nil {
		return err
	}
	state, err := ServiceGate(ctx, q)
	if err != nil {
		// A gate that cannot be read is a closed gate. The mutation fails
		// closed instead of writing into a service whose state is unknown.
		return ErrUnavailable
	}
	if !state.Open {
		return ErrUnavailable
	}
	return nil
}

// LockGate takes the exclusive gate lock.
//
// The caller holds it until its transaction commits, so every mutation that
// is already running commits first and every later mutation sees the closed
// gate. It is the ordering half of the "no post-suspension work can commit"
// rule, and it is exported so the restore flow takes the same lock.
func LockGate(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, GateAdvisoryKey)
	return err
}

// LockAccountScope takes the account scope lock of one participant.
//
// The scope lock orders a trusted allocation against the removal of the same
// participant. The privacy flow and the profile flow take the same lock
// through the shared locks package, so an allocation and a removal of one
// account are ordered instead of racing.
//
// The lock is taken before the gate lock and before the match row locks, and
// the scopes of one transaction are taken in ascending order, so two
// allocations of the same two participants cannot deadlock.
func LockAccountScope(ctx context.Context, tx pgx.Tx, participant ParticipantRef) error {
	return locks.LockAccountScope(ctx, tx, locks.AccountScope(string(participant.Kind), participant.ID))
}

// LockAccountScopes takes the account scope locks of several participants in
// ascending order.
//
// The order is the deadlock rule: two transactions that lock the same scopes
// take them in the same order, so they never wait for each other.
func LockAccountScopes(ctx context.Context, tx pgx.Tx, participants []ParticipantRef) error {
	scopes := make([]string, 0, len(participants))
	for _, participant := range participants {
		scopes = append(scopes, locks.AccountScope(string(participant.Kind), participant.ID))
	}
	return locks.LockAccountScopes(ctx, tx, scopes)
}

// gateState reads the durable admission state of the service.
//
// A read that fails is reported as a closed gate, so a client never sees an
// open service that could not be checked.
func (s *Service) gateState(ctx context.Context, q Querier) (GateState, error) {
	state, err := ServiceGate(ctx, q)
	if err != nil {
		return GateState{Open: false, Reason: GateReasonRecoveryPending}, err
	}
	return state, nil
}
