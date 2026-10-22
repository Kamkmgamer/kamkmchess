package online

// The operator path of a planned interruption.
//
// A planned restart is an interruption that an operator announced before the
// service stopped. The announcement is a durable boundary: the gate of the
// service closes when the boundary is written, the clock of the unfinished
// matches is refunded for the announced interval, and the canonical state is
// published before the service accepts a resumed action.
//
// The path is private on purpose. A public route that plans an interruption
// would let an unauthenticated caller close the gate of the whole service, so
// the operator reaches it through a maintenance command that reads the
// database url from a named environment variable and never from an argument.
//
// The three steps of the path are:
//
//   - plan: persist the planned boundary. The boundary is written before the
//     service stops, so the interval of the interruption is known exactly
//     when the service comes back.
//   - recover: apply the planned boundary. The recovery is the canonical one:
//     it opens a new service epoch, refunds the announced interval to the
//     unfinished matches, publishes the adjusted state and completes the
//     epoch, so the durable gate opens again.
//   - abort: cancel a planned boundary that will not happen. The restart was
//     called off, so no interruption took place, no clock is refunded and the
//     durable gate opens again. The row of the plan stays the evidence that
//     the plan existed.
//
// A plan is idempotent: the pending boundary of the service is reused, so a
// second plan never plans a second interruption and the clock of the
// unfinished matches is refunded once.

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// PlanSuspendingNow announces a planned restart of the service.
//
// The start of the interruption is the authoritative clock of the writer, so
// the boundary is placed exactly where the operator announced it. The end of
// the interruption is unknown: the service closes the interval when it
// resumes, so the refund is exactly the time the service was down.
//
// The announcement is idempotent. A pending announcement is reused, so the
// operator may run the command twice without planning two interruptions.
func (s *Service) PlanSuspendingNow(ctx context.Context) (RecoveryBoundary, error) {
	started, err := s.now(ctx, s.db)
	if err != nil {
		return RecoveryBoundary{}, err
	}
	return s.PlanSuspension(ctx, started, time.Time{})
}

// PendingRestart returns the announcement of an operator that waits for its
// recovery.
//
// The boundary is nil when no announcement is pending.
//
// The announcement is not the interruption of a dependency: a running service
// never recovers it, because the service is about to stop.
func (s *Service) PendingRestart(ctx context.Context) (*RecoveryBoundary, error) {
	boundaryID, err := s.pendingSuspension(ctx, s.db, SuspensionRestart)
	if err != nil {
		return nil, err
	}
	if boundaryID == "" {
		return nil, nil
	}
	boundary, err := loadRecoveryBoundary(ctx, s.db, boundaryID)
	if err != nil {
		return nil, err
	}
	return &boundary, nil
}

// AbortPlannedSuspension cancels an announcement of an operator that was not
// applied.
//
// The abort is the way back from a plan that will not happen. The boundary is
// marked as aborted under the exclusive gate lock, so every mutation that was
// already running commits first and every later mutation sees the open gate.
//
// An applied interruption is never aborted: the refund of an applied boundary
// is the published canonical state of the matches, and an operator command
// does not undo it. The interruption of a dependency is never aborted
// either: the service owns it, and the gate of a broken dependency may never
// be opened by an operator.
func (s *Service) AbortPlannedSuspension(ctx context.Context, boundaryID string) (RecoveryBoundary, error) {
	if boundaryID != "" && !idPattern.MatchString(boundaryID) {
		return RecoveryBoundary{}, ErrInvalidArgument
	}
	conn, err := s.db.Acquire(ctx)
	if err != nil {
		return RecoveryBoundary{}, err
	}
	defer conn.Release()
	// The leadership lock of the recovery orders the abort against the
	// recovery of the same boundary: an applied interruption is never
	// aborted, and an abort and a recovery never change one boundary
	// together.
	if _, err = conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, recoveryLeadershipLockKey); err != nil {
		return RecoveryBoundary{}, err
	}
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, recoveryLeadershipLockKey)
	}()
	tx, err := conn.Begin(ctx)
	if err != nil {
		return RecoveryBoundary{}, err
	}
	defer tx.Rollback(ctx)
	// The exclusive gate lock orders the abort against the mutations that
	// are already running: the gate opens after them, and no mutation
	// commits after the abort.
	if err = LockGate(ctx, tx); err != nil {
		return RecoveryBoundary{}, err
	}
	target := boundaryID
	if target == "" {
		pending, err := s.pendingSuspension(ctx, tx, SuspensionRestart)
		if err != nil {
			return RecoveryBoundary{}, err
		}
		if pending == "" {
			return RecoveryBoundary{}, ErrNotFound
		}
		target = pending
	}
	boundary, err := loadRecoveryBoundary(ctx, tx, target)
	if err != nil {
		return RecoveryBoundary{}, err
	}
	if boundary.Kind != SuspensionRestart {
		return RecoveryBoundary{}, ErrInvalidArgument
	}
	if boundary.AbortedAt != nil {
		return RecoveryBoundary{}, ErrConflict
	}
	if boundary.AdjustedAt != nil {
		return RecoveryBoundary{}, ErrConflict
	}
	aborted, err := s.now(ctx, tx)
	if err != nil {
		return RecoveryBoundary{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE online_suspension_boundaries SET aborted_at=$1 WHERE boundary_id=$2 AND adjusted_at IS NULL AND aborted_at IS NULL`, aborted.UTC(), target); err != nil {
		return RecoveryBoundary{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return RecoveryBoundary{}, err
	}
	return loadRecoveryBoundary(ctx, s.db, target)
}

// RecoverPlannedSuspension applies a planned interruption.
//
// The recovery is the canonical one: it opens a new service epoch, refunds the
// announced interval to the unfinished matches, publishes the adjusted state
// and completes the epoch, so the durable gate opens again and the resumed
// actions meet the canonical clock.
//
// The liveness of the service is refreshed before the canonical state is
// published. The liveness is the evidence that the service was alive, so a
// boot that follows this recovery finds a fresh record and derives no second
// interruption out of the downtime that was already refunded. Without the
// refresh the boot of the API would infer an unexpected interruption over the
// same interval and refund the clock of the unfinished matches twice.
//
// The command refuses an interruption that is not planned and one that was
// applied already: the recovery of an unexpected interruption belongs to the
// service itself.
func (s *Service) RecoverPlannedSuspension(ctx context.Context, boundaryID string) (RecoveryPlan, error) {
	if !idPattern.MatchString(boundaryID) {
		return RecoveryPlan{}, ErrInvalidArgument
	}
	conn, err := s.db.Acquire(ctx)
	if err != nil {
		return RecoveryPlan{}, err
	}
	defer conn.Release()
	if _, err = conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, recoveryLeadershipLockKey); err != nil {
		return RecoveryPlan{}, err
	}
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, recoveryLeadershipLockKey)
	}()
	boundary, err := loadRecoveryBoundary(ctx, conn, boundaryID)
	if err != nil {
		return RecoveryPlan{}, err
	}
	if boundary.Kind != SuspensionPlanned {
		return RecoveryPlan{}, ErrInvalidArgument
	}
	if boundary.AbortedAt != nil {
		return RecoveryPlan{}, ErrConflict
	}
	if err = s.refreshLiveness(ctx, conn); err != nil {
		return RecoveryPlan{}, err
	}
	return s.applyPendingBoundary(ctx, conn, boundaryID)
}

// refreshLiveness writes the liveness of the service.
//
// The record is the evidence that the service was alive. It never moves
// backwards, because it is shared by every instance of the service and the
// clock of one host may neither future-date it nor regress it.
//
// The write runs on the connection of the caller, so a bounded pool never
// waits for a second connection while it holds one.
func (s *Service) refreshLiveness(ctx context.Context, q WriteQuerier) error {
	reading, err := s.now(ctx, q)
	if err != nil {
		return err
	}
	_, err = q.Exec(ctx, `INSERT INTO online_service_liveness(singleton,last_seen_at,updated_at) VALUES(true,$1,$1)
ON CONFLICT (singleton) DO UPDATE SET last_seen_at=GREATEST(online_service_liveness.last_seen_at,EXCLUDED.last_seen_at),updated_at=GREATEST(online_service_liveness.updated_at,EXCLUDED.updated_at)`, reading.UTC())
	return err
}

// uniqueBoundaryID returns an identity that no boundary carries yet.
//
// The identity of a planned boundary is derived from the epoch of the outage,
// so two plans of the same outage find the same boundary and the clock of the
// unfinished matches is refunded once.
//
// The identity of an administrator is derived from the epoch of the current
// service, and an earlier plan of the same epoch already carries it: an
// applied or an aborted boundary keeps the identity it was written with. The
// plan of an administrator that follows such a plan therefore needs an
// identity of its own, or the earlier boundary would answer the new plan and
// the gate would never close again.
func uniqueBoundaryID(ctx context.Context, q queryer, base string) (string, error) {
	candidate := base
	for attempt := 2; attempt <= 64; attempt++ {
		var taken bool
		if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM online_suspension_boundaries WHERE boundary_id=$1)`, candidate).Scan(&taken); err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
		candidate = fmt.Sprintf("%s-%d", base, attempt)
	}
	return "", errors.New("the identity of the planned boundary is exhausted")
}
