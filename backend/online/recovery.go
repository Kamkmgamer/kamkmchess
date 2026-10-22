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

// The canonical recovery of an interrupted online service.
//
// A service outage is not opponent abandonment, and it never rewrites a
// result. The recovery therefore:
//
//   - derives a conservative interruption interval from durable state: the
//     health checkpoints and the accepted match activity, or the planned
//     boundary that was persisted before the service stopped;
//   - adjusts the armed deadline of every unfinished match once for that
//     interruption, so the players are not charged for the outage;
//   - publishes the adjusted state as a versioned event, so the canonical
//     deadline reaches both clients before resumed actions are accepted;
//   - fences the old service epoch and the runner leases of the old epoch;
//   - leaves an already final result final.
//
// Several API instances share one service. The recovery therefore runs under
// a shared leadership lock, and the service epoch advances once per detected
// interruption, never on every process start. An instance that merely joins
// never invalidates the leases of its peers.
//
// The recovery is retryable. Every step of it is idempotent, and the durable
// evidence of an interruption is written before anything else, so a recovery
// that fails leaves a boundary that a retry applies:
//
//   - the boundary of the interruption is persisted first, so the interval of
//     the interruption is durable before the epoch of the interruption is
//     opened, and the durable gate closes as soon as the evidence exists;
//   - the epoch of the interruption and the binding of the boundary to it are
//     written in one transaction, so an epoch never exists without the
//     boundary that explains it;
//   - a retry applies the pending boundary of the interruption, whether it
//     was planned or derived, and never opens a second epoch for it.
//
// The liveness record is not the evidence of an interruption. A healthy
// process refreshes it, so a retry after a failed recovery would find a fresh
// record and would derive no interruption at all. The pending boundary is
// what a retry reads, and the epoch of the failed recovery stays unresolved
// until that boundary is applied.

// SuspensionKind names how an interruption was detected.
type SuspensionKind string

const (
	// SuspensionPlanned is a suspension that was persisted before the
	// service stopped. Its interval is known exactly.
	SuspensionPlanned SuspensionKind = "planned"
	// SuspensionRestart is a suspension that an operator announced before a
	// planned restart of the service. Its interval is known exactly as well,
	// and the running service never recovers it: the service is about to
	// stop, and the recovery belongs to the instance that comes back.
	SuspensionRestart SuspensionKind = "restart"
	// SuspensionUnexpected is a suspension that was detected when the
	// service came back. Its interval is derived from durable state.
	SuspensionUnexpected SuspensionKind = "unexpected"
)

// recoveryLeadershipLockKey is the advisory lock that elects the instance
// that performs the recovery.
const recoveryLeadershipLockKey int64 = 0x4b484d4b4f4e4c49

// RecoveryBoundary is one persisted interruption.
type RecoveryBoundary struct {
	// SchemaVersion is the contract version of the boundary.
	SchemaVersion int `json:"schemaVersion"`
	// BoundaryID identifies the interruption.
	BoundaryID string `json:"boundaryId"`
	// Kind is how the interruption was detected.
	Kind SuspensionKind `json:"kind"`
	// StartedAt is the beginning of the interruption.
	StartedAt time.Time `json:"startedAt"`
	// EndedAt is the planned end of the interruption, when it is known.
	EndedAt *time.Time `json:"endedAt"`
	// ResumedAt is when the service resumed.
	ResumedAt *time.Time `json:"resumedAt"`
	// AdjustedAt is when the canonical adjustment was committed.
	AdjustedAt *time.Time `json:"adjustedAt"`
	// AbortedAt is when the planned interruption was cancelled.
	//
	// An aborted boundary is a plan that will not happen: the restart was
	// called off, so no interruption took place and no clock was refunded.
	// The row stays the evidence that the plan existed.
	AbortedAt *time.Time `json:"abortedAt"`
	// ServiceEpoch is the epoch the recovery opened.
	ServiceEpoch int64 `json:"serviceEpoch"`
	// InterruptionMs is the length of the interruption.
	InterruptionMs int64 `json:"interruptionMs"`
}

// RecoveryPlan reports what one recovery did.
type RecoveryPlan struct {
	// SchemaVersion is the contract version of the plan.
	SchemaVersion int `json:"schemaVersion"`
	// BoundaryID identifies the interruption this plan belongs to.
	BoundaryID string `json:"boundaryId"`
	// Kind is how the interruption was detected.
	Kind SuspensionKind `json:"kind"`
	// ServiceEpoch is the epoch the recovery opened.
	ServiceEpoch int64 `json:"serviceEpoch"`
	// InterruptionStart and InterruptionEnd bound the interruption.
	InterruptionStart time.Time `json:"interruptionStart"`
	InterruptionEnd   time.Time `json:"interruptionEnd"`
	// InterruptionMs is the length of the interruption.
	InterruptionMs int64 `json:"interruptionMs"`
	// AdjustedMatches is the number of unfinished matches whose deadline
	// was shifted.
	AdjustedMatches int `json:"adjustedMatches"`
	// PreservedResults is the number of finished matches that were left
	// untouched.
	PreservedResults int `json:"preservedResults"`
	// RevokedLeases is the number of runner leases the recovery fenced.
	RevokedLeases int `json:"revokedLeases"`
	// AlreadyAdjusted reports that this boundary was already applied, so
	// the recovery was a replay and changed nothing.
	AlreadyAdjusted bool `json:"alreadyAdjusted"`
}

// WithRecoveryGate closes the mutation path until the canonical recovery has
// published the adjusted state.
//
// The gate is the "publish canonical state before accepting resumed actions"
// rule: a service that has not recovered yet refuses every mutation with
// ErrUnavailable, and the reads keep working.
func WithRecoveryGate() Option {
	return func(s *Service) { s.recoveryRequired.Store(true) }
}

// Recovered reports whether the canonical recovery has completed.
//
// A service without the recovery gate is always recovered, because it never
// waits for one.
func (s *Service) Recovered() bool { return !s.recoveryRequired.Load() || s.recovered.Load() }

// PendingSuspension returns the interruption that waits for its recovery.
//
// The boundary is nil when no interruption is pending.
//
// The interruption of a dependency is the one that waits here. The
// announcement of an operator waits for the restart of the service and is
// never recovered by a running service, so it is not one of them.
func (s *Service) PendingSuspension(ctx context.Context) (*RecoveryBoundary, error) {
	boundaryID, err := s.pendingSuspension(ctx, s.db, SuspensionPlanned)
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

// SuspendForDependency records the interruption of a dependency.
//
// The interruption is persisted as a planned boundary, so the durable gate
// closes and the clock of the unfinished matches is refunded when the
// dependency comes back. The service does not have to restart for the
// interruption to be recovered.
//
// One interruption is one boundary. A pending boundary is reused, so a
// dependency that keeps failing does not plan a second interruption and the
// clock is refunded once.
func (s *Service) SuspendForDependency(ctx context.Context, dependency string) error {
	// The interruption is only planned for the rules dependency.
	//
	// The durable boundary carries no dependency, so a plan for another
	// dependency would be an interruption of the rules under another name.
	// The caller learns that the name is not supported.
	if dependency != DependencyRules {
		return ErrInvalidArgument
	}
	// The interruption of the open failure episode of this instance is
	// identified by the boundary of its first plan.
	//
	// Every failure of the same outage therefore plans the same boundary,
	// even when a peer recovered it in between: the plan finds the boundary
	// of the outage and changes nothing. Without it, one broken worker would
	// plan one interruption for every recovery of the outage, and the clock
	// of the unfinished matches would be refunded again and again.
	//
	// The identity does not declare the dependency healthy. The worker of
	// this instance may really be broken: the next check of the monitor
	// proves the current state, and a failure after an answer is a new
	// outage with a new interruption.
	// The episode guard is held across the whole decision: the open check,
	// the plan of the interruption and the binding of its identity. A
	// success that completes in between may not leave a plan of a closed
	// episode behind, and a plan that belongs to a closed episode may not
	// write a boundary of an outage that never happened.
	//
	// The lock order is the episode guard and then the gate lock of the
	// plan. The evaluation path takes the episode guard before it opens
	// its transaction, so no flow takes the two the other way round.
	s.episodeMu.Lock()
	defer s.episodeMu.Unlock()
	if !s.episodeOpen {
		// A stale failure whose episode was closed already may not plan a
		// new interruption.
		return nil
	}
	started, err := s.now(ctx, s.db)
	if err != nil {
		return err
	}
	boundary, err := s.planSuspension(ctx, s.episodeBoundary, s.episodeEpoch, SuspensionPlanned, started, started)
	if err != nil {
		return err
	}
	// The identity of the episode is the boundary of the outage, so the
	// next plan of the same outage finds it and changes nothing.
	if s.episodeBoundary == "" {
		s.episodeBoundary = boundary.BoundaryID
	}
	if s.episodeEpoch == 0 {
		s.episodeEpoch = boundary.ServiceEpoch
	}
	s.episodePlanned = true
	return nil
}

// PlanSuspension announces a planned restart of the service.
//
// The boundary is written before the service stops, so the interval of the
// interruption is known exactly when the service comes back.
//
// The announcement is the plan of an operator, and it is not the interruption
// of a dependency: a running service never recovers it, because the service
// is about to stop. The recovery of the announcement belongs to the instance
// that comes back, and it is the operator command that reaches it.
func (s *Service) PlanSuspension(ctx context.Context, startedAt, endedAt time.Time) (RecoveryBoundary, error) {
	// The explicit planning of an administrator is not identified by an
	// episode: it plans the interruption of the current epoch.
	return s.planSuspension(ctx, "", 0, SuspensionRestart, startedAt, endedAt)
}

// planSuspension persists a planned interruption boundary.
//
// The identity is a previously bound boundary. Until one is bound, the
// earliest observed epoch identifies the outage. With neither, the plan
// belongs to the current epoch.
func (s *Service) planSuspension(ctx context.Context, identity string, epoch int64, kind SuspensionKind, startedAt, endedAt time.Time) (RecoveryBoundary, error) {
	if startedAt.IsZero() {
		return RecoveryBoundary{}, ErrInvalidArgument
	}
	if !endedAt.IsZero() && endedAt.Before(startedAt) {
		return RecoveryBoundary{}, ErrInvalidArgument
	}
	var ended any
	if !endedAt.IsZero() {
		ended = endedAt.UTC()
	}
	// The exclusive gate lock orders the planned suspension against the
	// mutations that are already running. The suspension is committed after
	// them, and every later mutation sees the closed gate.
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return RecoveryBoundary{}, err
	}
	defer tx.Rollback(ctx)
	if err = LockGate(ctx, tx); err != nil {
		return RecoveryBoundary{}, err
	}
	// The pending interruption is read inside the transaction, under the
	// gate lock.
	//
	// A recovery opens the new epoch before it applies the boundary, so
	// there is a window in which the epoch moved and the boundary of the
	// outage is still pending. Two instances that detect the same outage
	// and a plan in that window therefore find the boundary of the outage
	// and change nothing: one outage is one pending boundary.
	pending, err := s.pendingSuspension(ctx, tx, kind)
	if err != nil {
		return RecoveryBoundary{}, err
	}
	if pending != "" {
		// The interruption is already planned. The interval of the first
		// plan is the timeline of the interruption.
		//
		// The boundary is read with the transaction that holds the gate
		// lock. A second connection would wait for a free one, and a pool
		// without one would block the plan that holds the only connection.
		return loadRecoveryBoundary(ctx, tx, pending)
	}
	// The epoch is read under the gate lock, so the interruption of an
	// outage that was not observed before belongs to the current epoch.
	current, err := currentServiceEpoch(ctx, tx)
	if err != nil {
		return RecoveryBoundary{}, err
	}
	boundaryID := identity
	if boundaryID == "" {
		if epoch != 0 {
			// The identity of the episode is the epoch of its earliest
			// observation, so the plan of the same outage finds the
			// boundary of the first plan.
			boundaryID = plannedSuspensionBoundaryID(epoch)
		} else {
			// The identity of an administrator is the epoch of the current
			// service, and an earlier plan of the same epoch already carries
			// it: an applied or an aborted boundary keeps the identity. The
			// plan therefore needs an identity of its own, or the earlier
			// boundary would answer the new plan and the gate would never
			// close again.
			boundaryID, err = uniqueBoundaryID(ctx, tx, plannedSuspensionBoundaryID(current))
			if err != nil {
				return RecoveryBoundary{}, err
			}
		}
	}
	epoch = current
	if _, err = tx.Exec(ctx, `INSERT INTO online_suspension_boundaries(boundary_id,kind,started_at,ended_at,service_epoch,interruption_ms) VALUES($1,$2,$3,$4,$5,0)
ON CONFLICT (boundary_id) DO NOTHING`, boundaryID, string(kind), startedAt.UTC(), ended, epoch); err != nil {
		return RecoveryBoundary{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return RecoveryBoundary{}, err
	}
	return loadRecoveryBoundary(ctx, s.db, boundaryID)
}

// RecoverFromInterruption runs the canonical recovery.
//
// The recovery is idempotent per interruption. A repeated recovery of the
// same boundary finds the boundary already adjusted and changes nothing, and
// two distinct interruptions are two distinct boundaries, each of which may
// adjust an unfinished deadline once.
func (s *Service) RecoverFromInterruption(ctx context.Context) (RecoveryPlan, error) {
	conn, err := s.db.Acquire(ctx)
	if err != nil {
		return RecoveryPlan{}, err
	}
	defer conn.Release()
	// The leadership lock elects the instance that performs the recovery.
	// The others wait and then observe the completed boundary.
	if _, err = conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, recoveryLeadershipLockKey); err != nil {
		return RecoveryPlan{}, err
	}
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, recoveryLeadershipLockKey)
	}()
	return s.recoverUnderLeadership(ctx, conn)
}

// ApplyRecoveryBoundary applies one persisted interruption.
//
// The call is the explicit replay seam: applying the same boundary twice
// adjusts an unfinished deadline once, because the adjustment is keyed by the
// match and the boundary.
func (s *Service) ApplyRecoveryBoundary(ctx context.Context, boundaryID string) (RecoveryPlan, error) {
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
	return s.applyBoundary(ctx, conn, boundaryID)
}

// recoverUnderLeadership performs the recovery while the leadership lock is
// held.
func (s *Service) recoverUnderLeadership(ctx context.Context, conn *pgxpool.Conn) (RecoveryPlan, error) {
	// A pending interruption is applied before anything new is derived.
	//
	// The boundary of a pending interruption is the durable evidence of the
	// interruption, and a recovery that began and failed before it applied
	// its boundary leaves that boundary pending. The retry therefore
	// finishes the interrupted recovery instead of looking for a new
	// interruption.
	//
	// The liveness record is not that evidence. A healthy process refreshes
	// it, so a retry after a failed recovery finds a fresh record, derives
	// no interruption and marks only the memory of this instance recovered,
	// while the epoch of the failed recovery stays unresolved and the
	// durable gate stays closed for good. The pending boundary is what the
	// retry reads, and it is read for every kind of interruption, not only
	// for the planned ones.
	pending, err := s.pendingBoundary(ctx, conn)
	if err != nil {
		return RecoveryPlan{}, err
	}
	if pending != "" {
		return s.applyPendingBoundary(ctx, conn, pending)
	}
	// An epoch whose recovery never completed is finished before anything
	// else is derived.
	//
	// The epoch is opened by a recovery, so an unresolved epoch means that
	// a recovery began and did not publish the canonical state. The gate
	// closes on that epoch, so the recovery is finished here instead of
	// joining the service as if it had never been interrupted.
	epoch, unresolved, err := latestServiceEpoch(ctx, conn)
	if err != nil {
		return RecoveryPlan{}, err
	}
	if unresolved {
		return s.resolveUnresolvedEpoch(ctx, conn, epoch)
	}
	boundaryID, start, end, ok, err := s.deriveUnexpectedBoundary(ctx, conn)
	if err != nil {
		return RecoveryPlan{}, err
	}
	if !ok {
		// There is no known interruption. The service joins the current
		// epoch without invalidating the work of its peers.
		epoch, epochErr := currentServiceEpoch(ctx, conn)
		if epochErr != nil {
			return RecoveryPlan{}, epochErr
		}
		s.recovered.Store(true)
		return RecoveryPlan{SchemaVersion: ContractsSchemaVersion, ServiceEpoch: epoch, InterruptionMs: 0}, nil
	}
	// An already known boundary is a replay of an interruption that was
	// applied before. It never opens a new epoch.
	if _, err = loadRecoveryBoundary(ctx, conn, boundaryID); err == nil {
		return s.applyBoundary(ctx, conn, boundaryID)
	} else if !errors.Is(err, ErrNotFound) {
		return RecoveryPlan{}, err
	}
	// The evidence of the interruption is durable before the epoch of the
	// interruption is opened, so the gate closes as soon as the evidence
	// exists and a failure after this point leaves a boundary that a retry
	// applies.
	if err = s.persistBoundary(ctx, conn, boundaryID, SuspensionUnexpected, start, end); err != nil {
		return RecoveryPlan{}, err
	}
	return s.applyPendingBoundary(ctx, conn, boundaryID)
}

// applyPendingBoundary applies one pending interruption.
//
// The epoch of the interruption is opened when the boundary is not bound to
// an unresolved epoch yet. A recovery that opened its epoch and failed
// before it applied the boundary therefore resumes that recovery: it opens
// no second epoch and it adjusts no deadline twice.
func (s *Service) applyPendingBoundary(ctx context.Context, conn *pgxpool.Conn, boundaryID string) (RecoveryPlan, error) {
	boundary, err := loadRecoveryBoundary(ctx, conn, boundaryID)
	if err != nil {
		return RecoveryPlan{}, err
	}
	if boundary.AdjustedAt != nil {
		// The boundary was applied before. A replay changes nothing and
		// never opens a new epoch.
		return s.applyBoundary(ctx, conn, boundaryID)
	}
	resumed, err := unresolvedEpoch(ctx, conn, boundary.ServiceEpoch)
	if err != nil {
		return RecoveryPlan{}, err
	}
	if !resumed {
		// The epoch of the interruption is opened, and the boundary is bound
		// to it, in one transaction. An epoch therefore never exists
		// without the boundary that explains it, and a failure after this
		// transaction leaves a boundary that a retry applies.
		if _, err = s.openEpochForBoundary(ctx, conn, boundaryID); err != nil {
			return RecoveryPlan{}, err
		}
	}
	return s.applyBoundary(ctx, conn, boundaryID)
}

// resolveUnresolvedEpoch finishes an epoch whose recovery did not complete.
//
// The epoch was opened by a recovery that failed before it published the
// canonical state, so the service must not accept a resumed action before
// this recovery finished. The boundary of the epoch is the evidence of the
// interruption:
//
//   - a boundary that was not applied yet is applied now;
//   - a boundary that was applied already only leaves the completion of the
//     epoch behind, and the epoch is completed;
//   - an epoch without a boundary is the shape that a failed recovery of an
//     earlier version left behind, and its epoch is completed without a
//     refund.
func (s *Service) resolveUnresolvedEpoch(ctx context.Context, conn *pgxpool.Conn, epoch int64) (RecoveryPlan, error) {
	boundary, err := epochBoundary(ctx, conn, epoch)
	if errors.Is(err, ErrNotFound) {
		return s.completeEpochWithoutBoundary(ctx, conn, epoch)
	}
	if err != nil {
		return RecoveryPlan{}, err
	}
	return s.applyBoundary(ctx, conn, boundary.BoundaryID)
}

// completeEpochWithoutBoundary completes an epoch that has no boundary.
//
// An epoch without a boundary is the shape that a failed recovery of an
// earlier version left behind: the epoch was committed and the boundary was
// not. The epoch is then the only evidence of that interruption, and the
// length of that interruption is unknown.
//
// The conservative interval of an interruption of an unknown length is
// empty, so the recovery completes the epoch without refunding a clock. The
// epoch is completed and not ignored, so the durable gate opens again
// instead of refusing every mutation for good.
func (s *Service) completeEpochWithoutBoundary(ctx context.Context, conn *pgxpool.Conn, epoch int64) (RecoveryPlan, error) {
	resumed, err := s.now(ctx, conn)
	if err != nil {
		return RecoveryPlan{}, err
	}
	if _, err = conn.Exec(ctx, `UPDATE online_service_epochs SET recovered_at=$1 WHERE epoch=$2 AND recovered_at IS NULL`, resumed.UTC(), epoch); err != nil {
		return RecoveryPlan{}, err
	}
	s.recovered.Store(true)
	return RecoveryPlan{SchemaVersion: ContractsSchemaVersion, ServiceEpoch: epoch, InterruptionMs: 0}, nil
}

// applyBoundary applies one interruption to the unfinished matches.
func (s *Service) applyBoundary(ctx context.Context, conn *pgxpool.Conn, boundaryID string) (RecoveryPlan, error) {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return RecoveryPlan{}, err
	}
	defer tx.Rollback(ctx)
	boundary, err := loadRecoveryBoundary(ctx, tx, boundaryID)
	if err != nil {
		return RecoveryPlan{}, err
	}
	reading, err := s.now(ctx, tx)
	if err != nil {
		return RecoveryPlan{}, err
	}
	now := reading
	plan := RecoveryPlan{
		SchemaVersion: ContractsSchemaVersion,
		BoundaryID:    boundary.BoundaryID,
		Kind:          boundary.Kind,
		ServiceEpoch:  boundary.ServiceEpoch,
	}
	if boundary.AdjustedAt != nil {
		// The boundary was already applied. A replay changes nothing.
		plan.AlreadyAdjusted = true
		plan.InterruptionStart = boundary.StartedAt
		plan.InterruptionEnd = boundary.StartedAt.Add(time.Duration(boundary.InterruptionMs) * time.Millisecond)
		plan.InterruptionMs = boundary.InterruptionMs
		revoked, err := countRevokedLeases(ctx, tx, boundary.ServiceEpoch)
		if err != nil {
			return RecoveryPlan{}, err
		}
		plan.RevokedLeases = revoked
		// The completion of the epoch may still be missing, for example
		// when the recovery that applied the boundary failed before it
		// completed the epoch. The epoch is completed here, so the durable
		// gate does not wait for a recovery that never comes.
		if _, err = tx.Exec(ctx, `UPDATE online_service_epochs SET recovered_at=$1 WHERE epoch=$2 AND recovered_at IS NULL`, boundary.AdjustedAt.UTC(), boundary.ServiceEpoch); err != nil {
			return RecoveryPlan{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return RecoveryPlan{}, err
		}
		s.recovered.Store(true)
		return plan, nil
	}
	// The interruption window ends when the service resumes. A planned
	// boundary knows its start, and the resume time closes it.
	resumed := now
	end := resumed
	if boundary.EndedAt != nil {
		end = boundary.EndedAt.UTC()
	}
	if !end.After(boundary.StartedAt) {
		// The interruption window ends when the service resumes. A planned
		// boundary knows its start, and the resume time closes it.
		end = resumed
	}
	if end.Before(boundary.StartedAt) {
		// The boundary starts after the resume, so the interruption is
		// empty. The clock of the database may have moved backwards, and
		// the interval of an interruption is never negative.
		end = boundary.StartedAt
	}
	shift := end.Sub(boundary.StartedAt)
	plan.InterruptionStart = boundary.StartedAt
	plan.InterruptionEnd = end
	plan.InterruptionMs = shift.Milliseconds()
	adjusted, preserved, err := s.adjustUnfinishedMatches(ctx, tx, boundary, end, shift)
	if err != nil {
		return RecoveryPlan{}, err
	}
	plan.AdjustedMatches = adjusted
	plan.PreservedResults = preserved
	revoked, err := fenceRunnerLeases(ctx, tx, boundary.ServiceEpoch, resumed)
	if err != nil {
		return RecoveryPlan{}, err
	}
	plan.RevokedLeases = revoked
	// The interval of the interruption is written with its clamped end, so
	// the row never carries an end that lies before its start. An end that
	// lies before the resume is left unknown, because the row may not claim
	// a resume before the interruption ended.
	if _, err = tx.Exec(ctx, `UPDATE online_suspension_boundaries SET ended_at=CASE WHEN $1::timestamptz <= $2::timestamptz THEN $1::timestamptz ELSE NULL::timestamptz END,resumed_at=$2::timestamptz,adjusted_at=$2::timestamptz,interruption_ms=$3::bigint WHERE boundary_id=$4`, end.UTC(), resumed.UTC(), shift.Milliseconds(), boundary.BoundaryID); err != nil {
		return RecoveryPlan{}, err
	}
	// The epoch of this recovery is completed, so the durable gate opens
	// again for every instance of the service.
	if _, err = tx.Exec(ctx, `UPDATE online_service_epochs SET recovered_at=$1 WHERE epoch=$2 AND recovered_at IS NULL`, resumed.UTC(), boundary.ServiceEpoch); err != nil {
		return RecoveryPlan{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return RecoveryPlan{}, err
	}
	s.recovered.Store(true)
	// The recovery does not report the health of the rules dependency. The
	// dependency is healthy when the rules process answered, and the answer
	// is the evidence of the probe or of a real evaluation, never of the
	// recovery itself.
	return plan, nil
}

// adjustUnfinishedMatches refunds the interruption to every unfinished match
// whose clock was running during it.
//
// Every clock that was running during the interruption is refunded, even when
// its deadline survived past the resume: a short outage must not be charged
// to a player just because the clock survived it. The refund is the overlap
// of the charged window with the interruption, so a deadline that already
// expired before the interruption is preserved and a clock that started after
// the interruption is untouched.
//
// The shift moves the deadline and the start of the active clock by the same
// amount, so the side that was thinking is not charged for the outage. The
// adjustment is keyed by the match and the boundary, so the same
// interruption can never shift a deadline twice.
func (s *Service) adjustUnfinishedMatches(ctx context.Context, tx pgx.Tx, boundary RecoveryBoundary, end time.Time, shift time.Duration) (int, int, error) {
	rows, err := tx.Query(ctx, `SELECT m.match_id FROM online_matches m JOIN online_clocks c ON c.match_id=m.match_id
WHERE m.status='active' AND m.created_at <= $1
  AND ((c.active_seat IS NOT NULL AND c.deadline_at IS NOT NULL AND c.active_since IS NOT NULL AND c.deadline_at > $2)
    OR (c.reply_seat IS NOT NULL AND c.reply_deadline_at IS NOT NULL AND c.reply_deadline_at > $2))
ORDER BY m.match_id`, end, boundary.StartedAt.UTC())
	if err != nil {
		return 0, 0, err
	}
	matchIDs := make([]string, 0)
	for rows.Next() {
		var matchID string
		if err = rows.Scan(&matchID); err != nil {
			rows.Close()
			return 0, 0, err
		}
		matchIDs = append(matchIDs, matchID)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return 0, 0, err
	}
	adjusted := 0
	for _, matchID := range matchIDs {
		// The match row is locked exactly like the writer locks it, and the
		// version and the clock are read again under that lock. A move that
		// was accepted while the recovery was running is therefore never
		// overwritten, and the version of the adjustment is the version the
		// lock actually holds.
		applied, err := s.adjustOneMatch(ctx, tx, boundary, end, matchID)
		if err != nil {
			return adjusted, 0, err
		}
		if applied {
			adjusted++
		}
	}
	// The finished matches are counted so the plan can report that they were
	// preserved. They are never written.
	var preserved int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM online_matches WHERE status <> 'active'`).Scan(&preserved); err != nil {
		return adjusted, 0, err
	}
	return adjusted, preserved, nil
}

// adjustOneMatch locks one match and refunds the interruption to it.
//
// The lock is the match row lock, the same lock the writer takes before every
// transition, so the recovery and an accepted move are ordered instead of
// racing. The version, the control epoch and the clock are read again under
// the lock, and the adjustment is computed from the locked clock.
func (s *Service) adjustOneMatch(ctx context.Context, tx pgx.Tx, boundary RecoveryBoundary, end time.Time, matchID string) (bool, error) {
	match, err := scanMatch(tx.QueryRow(ctx, `SELECT `+matchColumns+` FROM online_matches WHERE match_id=$1 FOR UPDATE`, matchID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	if match.Status != MatchActive {
		return false, nil
	}
	clock, err := loadClock(ctx, tx, matchID)
	if err != nil {
		return false, err
	}
	var firstMoveAt *time.Time
	if err = tx.QueryRow(ctx, `SELECT min(decision_at) FROM online_moves WHERE match_id=$1`, matchID).Scan(&firstMoveAt); err != nil {
		return false, err
	}
	overlap, ok := recoveryOverlap(clock.DeadlineAt, clock.ActiveSince, clock.ReplyDeadlineAt, firstMoveAt, match.CreatedAt, boundary.StartedAt.UTC(), end)
	if !ok || overlap <= 0 {
		return false, nil
	}
	return s.applyRecoveryAdjustment(ctx, tx, boundary, end, match.MatchID, match.Version, match.ControlEpoch, clock.DeadlineAt, clock.ActiveSince, clock.ReplyDeadlineAt, overlap)
}

// recoveryOverlap returns the time of the charged window that the service
// interruption must not charge to the player.
//
// The charged window of the main clock runs from the start of the active
// clock to its deadline. The charged window of the opening reply window runs
// from the first accepted move to the reply deadline.
func recoveryOverlap(deadlineAt, activeSince, replyDeadline, firstMoveAt *time.Time, createdAt, start, end time.Time) (time.Duration, bool) {
	switch {
	case deadlineAt != nil && activeSince != nil:
		return recoveryRefund(activeSince.UTC(), deadlineAt.UTC(), start, end), true
	case replyDeadline != nil:
		windowStart := createdAt.UTC()
		if firstMoveAt != nil {
			windowStart = firstMoveAt.UTC()
		}
		return recoveryRefund(windowStart, replyDeadline.UTC(), start, end), true
	default:
		return 0, false
	}
}

// recoveryRefund returns the time of a charged window that the interruption
// must not charge to the player.
//
// The rule is the approved one: a service interruption is never charged to a
// player. When the clock was still running when the service went down, the
// whole interruption is refunded, even when the deadline passed while the
// service was down. The player keeps the time they had left when the
// service went down, and the deadline moves by the length of the
// interruption.
//
// A deadline that expired before the interruption is preserved, because the
// match was already over. A clock that started inside the interruption is
// refunded only for the part of its charge that fell inside it, because the
// clock was never running before that.
func recoveryRefund(windowStart, windowEnd, start, end time.Time) time.Duration {
	if !windowEnd.After(start) {
		// The charge ended before the interruption started. The deadline is
		// preserved.
		return 0
	}
	if windowStart.After(start) {
		// The clock started inside the interruption. Only the part of the
		// charge that fell inside it is refunded.
		to := windowEnd
		if end.Before(to) {
			to = end
		}
		if !to.After(windowStart) {
			return 0
		}
		return to.Sub(windowStart)
	}
	// The clock was running when the service went down, so the whole
	// interruption is refunded.
	if !end.After(start) {
		return 0
	}
	return end.Sub(start)
}

// applyRecoveryAdjustment shifts one match and publishes the adjusted state.
func (s *Service) applyRecoveryAdjustment(ctx context.Context, tx pgx.Tx, boundary RecoveryBoundary, resumed time.Time, matchID string, version, controlEpoch int64, deadlineAt, activeSince, replyDeadline *time.Time, shift time.Duration) (bool, error) {
	// The adjustment row is the exactly-once guard. A repeated application
	// of the same boundary finds the row and changes nothing.
	var existing int
	err := tx.QueryRow(ctx, `SELECT count(*) FROM online_recovery_adjustments WHERE match_id=$1 AND boundary_id=$2`, matchID, boundary.BoundaryID).Scan(&existing)
	if err != nil {
		return false, err
	}
	if existing > 0 {
		return false, nil
	}
	newDeadline := deadlineAt
	if deadlineAt != nil {
		value := deadlineAt.Add(shift)
		newDeadline = &value
	}
	newActiveSince := activeSince
	if activeSince != nil {
		value := activeSince.Add(shift)
		newActiveSince = &value
	}
	newReply := replyDeadline
	if replyDeadline != nil {
		value := replyDeadline.Add(shift)
		newReply = &value
	}
	resumed = resumed.UTC()
	if _, err = tx.Exec(ctx, `UPDATE online_clocks SET deadline_at=$1,active_since=$2,reply_deadline_at=$3,recovery_adjusted_at=$4,recovery_shift_ms=recovery_shift_ms+$5,updated_at=$4 WHERE match_id=$6`,
		newDeadline, newActiveSince, newReply, resumed, shift.Milliseconds(), matchID); err != nil {
		return false, err
	}
	// The presence lease of a connected seat is refunded by the same
	// interruption. A seat whose lease covered the start of the interruption
	// was connected when the service went down, so the interruption must
	// not make it look absent afterwards.
	if _, err = tx.Exec(ctx, `UPDATE online_presence
SET last_heartbeat_at=last_heartbeat_at+$2::interval,lease_expires_at=lease_expires_at+$2::interval,keep_waiting_at=keep_waiting_at+$2::interval,updated_at=$3
WHERE match_id=$1 AND lease_expires_at > $4`, matchID, shift, resumed, boundary.StartedAt.UTC()); err != nil {
		return false, err
	}
	if _, err = tx.Exec(ctx, `UPDATE online_matches SET version=version+1,updated_at=$1 WHERE match_id=$2`, resumed, matchID); err != nil {
		return false, err
	}
	if err = withdrawStaleOffers(ctx, tx, matchID, version+1, resumed); err != nil {
		return false, err
	}
	shiftMs := shift.Milliseconds()
	event := Event{
		SchemaVersion:   ContractsSchemaVersion,
		MatchID:         matchID,
		Version:         version + 1,
		Kind:            EventRecoveryAdjustment,
		ControlEpoch:    controlEpoch,
		DecisionAt:      resumed,
		AcceptedAt:      resumed,
		RecoveryShiftMs: &shiftMs,
	}
	if err = insertEvent(ctx, tx, event); err != nil {
		return false, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_recovery_adjustments(match_id,boundary_id,shift_ms,previous_deadline_at,new_deadline_at,adjusted_at) VALUES($1,$2,$3,$4,$5,$6)`,
		matchID, boundary.BoundaryID, shiftMs, deadlineAt, newDeadline, resumed); err != nil {
		return false, err
	}
	return true, nil
}

// deriveUnexpectedBoundary derives the interruption of an unexpected failure.
//
// The service was demonstrably alive at the later of two durable signals: the
// liveness record and the last accepted match activity. The interruption
// starts there, because the service was alive at that moment and an
// interruption cannot include it.
//
// A liveness record that is still fresh means the service never stopped, so
// there is no interruption and no epoch is opened. A missing liveness record
// means the service never reported itself, so there is nothing to derive.
//
// The interval is derived from durable state and never from a guess, so a
// restart that joins a running service changes nothing.
func (s *Service) deriveUnexpectedBoundary(ctx context.Context, conn *pgxpool.Conn) (string, time.Time, time.Time, bool, error) {
	var livenessAt *time.Time
	if err := conn.QueryRow(ctx, `SELECT last_seen_at FROM online_service_liveness WHERE singleton`).Scan(&livenessAt); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", time.Time{}, time.Time{}, false, err
	}
	if livenessAt == nil {
		// The service never reported itself. There is no interruption to
		// derive, and no epoch to open.
		return "", time.Time{}, time.Time{}, false, nil
	}
	var activityAt *time.Time
	if err := conn.QueryRow(ctx, `SELECT max(updated_at) FROM online_matches`).Scan(&activityAt); err != nil {
		return "", time.Time{}, time.Time{}, false, err
	}
	alive := livenessAt.UTC()
	if activityAt != nil && activityAt.UTC().After(alive) {
		alive = activityAt.UTC()
	}
	reading, err := s.now(ctx, conn)
	if err != nil {
		return "", time.Time{}, time.Time{}, false, err
	}
	end := reading
	if end.Sub(alive) <= ServiceLivenessTTL {
		// The service was alive recently. It did not stop.
		return "", time.Time{}, time.Time{}, false, nil
	}
	return suspensionBoundaryID(SuspensionUnexpected, alive), alive, end, true, nil
}

// pendingSuspension returns the oldest boundary of one kind that was not
// applied yet.
//
// The kind separates two different plans. The interruption of a dependency is
// recovered by the service while it runs, and the announcement of an operator
// waits for the restart of the service: the running service never recovers
// the announcement, because the service is about to stop. One plan of one kind
// is one boundary.
//
// An aborted boundary is not pending: the plan it carries was cancelled, so
// it never blocks the gate and the recovery never applies it.
func (s *Service) pendingSuspension(ctx context.Context, q queryer, kind SuspensionKind) (string, error) {
	var boundaryID string
	err := q.QueryRow(ctx, `SELECT boundary_id FROM online_suspension_boundaries WHERE kind=$1 AND adjusted_at IS NULL AND aborted_at IS NULL ORDER BY created_at LIMIT 1`, string(kind)).Scan(&boundaryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return boundaryID, nil
}

// pendingBoundary returns the oldest interruption that was not applied yet.
//
// Every kind of interruption counts. A planned interruption and a derived
// one are both owed to the players, and a recovery that failed before it
// applied its boundary leaves that boundary pending whatever its kind is.
//
// An aborted boundary is not pending: the plan it carries was cancelled, so
// it is never applied and it never blocks the gate.
func (s *Service) pendingBoundary(ctx context.Context, q queryer) (string, error) {
	var boundaryID string
	err := q.QueryRow(ctx, `SELECT boundary_id FROM online_suspension_boundaries WHERE adjusted_at IS NULL AND aborted_at IS NULL ORDER BY created_at LIMIT 1`).Scan(&boundaryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return boundaryID, nil
}

// latestServiceEpoch returns the newest service epoch and whether its
// recovery did not complete.
//
// An epoch without a completion time is the durable evidence of a recovery
// that began. The gate closes on it, so the recovery that owns it has to
// finish it before the service accepts a resumed action.
func latestServiceEpoch(ctx context.Context, q queryer) (int64, bool, error) {
	var epoch int64
	var recoveredAt *time.Time
	err := q.QueryRow(ctx, `SELECT epoch,recovered_at FROM online_service_epochs ORDER BY epoch DESC LIMIT 1`).Scan(&epoch, &recoveredAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return epoch, recoveredAt == nil, nil
}

// unresolvedEpoch reports whether one service epoch was opened and its
// recovery did not complete.
//
// The epoch that does not exist is not an unresolved epoch: it is the epoch
// of a service that never interrupted, and an interruption that belongs to
// it has to open its own epoch.
func unresolvedEpoch(ctx context.Context, q queryer, epoch int64) (bool, error) {
	var recoveredAt *time.Time
	err := q.QueryRow(ctx, `SELECT recovered_at FROM online_service_epochs WHERE epoch=$1`, epoch).Scan(&recoveredAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return recoveredAt == nil, nil
}

// epochBoundary returns the boundary that belongs to one service epoch.
//
// The newest boundary of the epoch wins, so a boundary that was rebuilt for
// an epoch replaces the one it was rebuilt from. An aborted boundary is never
// the boundary of an epoch: the plan it carries was cancelled, so it is never
// applied.
func epochBoundary(ctx context.Context, q queryer, epoch int64) (RecoveryBoundary, error) {
	var boundaryID string
	err := q.QueryRow(ctx, `SELECT boundary_id FROM online_suspension_boundaries WHERE service_epoch=$1 AND aborted_at IS NULL ORDER BY created_at DESC LIMIT 1`, epoch).Scan(&boundaryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return RecoveryBoundary{}, ErrNotFound
	}
	if err != nil {
		return RecoveryBoundary{}, err
	}
	return loadRecoveryBoundary(ctx, q, boundaryID)
}

// persistBoundary writes the evidence of one interruption.
//
// The boundary is written before the epoch of the interruption is opened, so
// the durable gate closes as soon as the evidence of the interruption
// exists. A recovery that fails after this point leaves a pending boundary
// behind, and a retry applies that boundary with the interval that was
// derived here.
//
// The boundary of a planned interruption is written by the plan, so this
// writes the boundary of a derived one. The identity of the boundary is
// derived from the kind and the start of the interruption, so a repeated
// write of the same interruption changes nothing.
func (s *Service) persistBoundary(ctx context.Context, conn *pgxpool.Conn, boundaryID string, kind SuspensionKind, start, end time.Time) error {
	// The boundary belongs to the epoch of the service until the recovery
	// opens the epoch of the interruption and binds the boundary to it.
	epoch, err := currentServiceEpoch(ctx, conn)
	if err != nil {
		return err
	}
	_, err = conn.Exec(ctx, `INSERT INTO online_suspension_boundaries(boundary_id,kind,started_at,ended_at,service_epoch,interruption_ms) VALUES($1,$2,$3,$4,$5,$6)
ON CONFLICT (boundary_id) DO NOTHING`, boundaryID, string(kind), start.UTC(), end.UTC(), epoch, end.Sub(start).Milliseconds())
	return err
}

// openEpochForBoundary opens a new service epoch and binds the pending
// boundary of the interruption to it.
//
// The epoch and the binding are written in one transaction, so an epoch
// never exists without the boundary that explains it. A recovery that fails
// after this transaction leaves a boundary that a retry applies, instead of
// an epoch that no boundary can complete.
//
// The epoch advances once per detected interruption, under the recovery
// leadership lock, so a second API instance never invalidates the work of
// its peers.
func (s *Service) openEpochForBoundary(ctx context.Context, conn *pgxpool.Conn, boundaryID string) (int64, error) {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var kind string
	if err = tx.QueryRow(ctx, `SELECT kind FROM online_suspension_boundaries WHERE boundary_id=$1`, boundaryID).Scan(&kind); err != nil {
		return 0, err
	}
	epoch, err := s.insertServiceEpoch(ctx, tx, kind+" interruption")
	if err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `UPDATE online_suspension_boundaries SET service_epoch=$1 WHERE boundary_id=$2 AND adjusted_at IS NULL`, epoch, boundaryID); err != nil {
		return 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	return epoch, nil
}

// insertServiceEpoch writes the next service epoch inside a transaction.
//
// The epoch advances once per detected interruption, under the recovery
// leadership lock, so a second API instance never invalidates the work of
// its peers.
func (s *Service) insertServiceEpoch(ctx context.Context, tx pgx.Tx, note string) (int64, error) {
	var epoch int64
	// The implicit epoch of a service that never opened one is 1, so the
	// first interruption opens epoch 2 and fences the work of epoch 1.
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(epoch),1)+1 FROM online_service_epochs`).Scan(&epoch); err != nil {
		return 0, err
	}
	// The epoch starts on the authoritative clock of the writer, so the
	// completion of the recovery is never before its start.
	started, err := s.now(ctx, tx)
	if err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_service_epochs(epoch,started_at,note) VALUES($1,$2,$3)`, epoch, started, note); err != nil {
		return 0, err
	}
	return epoch, nil
}

// fenceRunnerLeases revokes the runner leases of the older service epochs.
func fenceRunnerLeases(ctx context.Context, tx pgx.Tx, epoch int64, at time.Time) (int, error) {
	tag, err := tx.Exec(ctx, `UPDATE online_runner_leases SET status='revoked',revoked_at=$1,revoked_reason=$2 WHERE status='active' AND runner_epoch < $3`, at.UTC(), LeaseRevokeRecovery, epoch)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// countRevokedLeases reports how many leases the recovery fenced.
func countRevokedLeases(ctx context.Context, tx pgx.Tx, epoch int64) (int, error) {
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM online_runner_leases WHERE status='revoked' AND revoked_reason=$1 AND runner_epoch < $2`, LeaseRevokeRecovery, epoch).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

// loadRecoveryBoundary reads one persisted interruption.
func loadRecoveryBoundary(ctx context.Context, q queryer, boundaryID string) (RecoveryBoundary, error) {
	var boundary RecoveryBoundary
	var kind string
	err := q.QueryRow(ctx, `SELECT boundary_id,kind,started_at,ended_at,resumed_at,adjusted_at,aborted_at,service_epoch,interruption_ms FROM online_suspension_boundaries WHERE boundary_id=$1`, boundaryID).
		Scan(&boundary.BoundaryID, &kind, &boundary.StartedAt, &boundary.EndedAt, &boundary.ResumedAt, &boundary.AdjustedAt, &boundary.AbortedAt, &boundary.ServiceEpoch, &boundary.InterruptionMs)
	if errors.Is(err, pgx.ErrNoRows) {
		return RecoveryBoundary{}, ErrNotFound
	}
	if err != nil {
		return RecoveryBoundary{}, err
	}
	boundary.SchemaVersion = ContractsSchemaVersion
	boundary.Kind = SuspensionKind(kind)
	boundary.StartedAt = boundary.StartedAt.UTC()
	if boundary.EndedAt != nil {
		value := boundary.EndedAt.UTC()
		boundary.EndedAt = &value
	}
	if boundary.ResumedAt != nil {
		value := boundary.ResumedAt.UTC()
		boundary.ResumedAt = &value
	}
	if boundary.AdjustedAt != nil {
		value := boundary.AdjustedAt.UTC()
		boundary.AdjustedAt = &value
	}
	if boundary.AbortedAt != nil {
		value := boundary.AbortedAt.UTC()
		boundary.AbortedAt = &value
	}
	return boundary, nil
}

// suspensionBoundaryID derives the stable identity of an interruption.
//
// The identity is derived from the kind and the start of the interruption, so
// a replay of the same interruption finds the same boundary and never
// adjusts a deadline twice.
func suspensionBoundaryID(kind SuspensionKind, startedAt time.Time) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%d", kind, startedAt.UTC().UnixNano())))
	return "boundary-" + hex.EncodeToString(sum[:8])
}

// plannedSuspensionBoundaryID is the identity of a planned boundary.
//
// The identity is the epoch of the outage the interruption belongs to. Two
// instances that detect the same outage would otherwise plan two boundaries,
// and the service would recover twice: two epochs, two adjustments and two
// refunds for one outage.
//
// The identity is not the current epoch of the service. Every applied
// interruption opens a new epoch, so the current epoch moves with the
// recovery of the outage and cannot identify the outage that is still open.
// The caller passes the epoch of the outage it observed.
//
// The identity of an unexpected boundary stays derived from its interval: it
// is not planned, and it is derived when the service comes back.
func plannedSuspensionBoundaryID(epoch int64) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%d", SuspensionPlanned, epoch)))
	return "boundary-" + hex.EncodeToString(sum[:8])
}
