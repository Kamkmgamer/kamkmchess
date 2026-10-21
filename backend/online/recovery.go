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

// SuspensionKind names how an interruption was detected.
type SuspensionKind string

const (
	// SuspensionPlanned is a suspension that was persisted before the
	// service stopped. Its interval is known exactly.
	SuspensionPlanned SuspensionKind = "planned"
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
func (s *Service) PendingSuspension(ctx context.Context) (*RecoveryBoundary, error) {
	boundaryID, err := s.pendingPlannedBoundary(ctx, s.db)
	if err != nil {
		return nil, err
	}
	if boundaryID == "" {
		return nil, nil
	}
	boundary, err := s.loadRecoveryBoundary(ctx, s.db, boundaryID)
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
	pending, err := s.PendingSuspension(ctx)
	if err != nil {
		return err
	}
	if pending != nil {
		return nil
	}
	started, err := s.now(ctx, s.db)
	if err != nil {
		return err
	}
	_, err = s.PlanSuspension(ctx, started, started)
	return err
}

// PlanSuspension persists a planned interruption boundary.
//
// The boundary is written before the service stops, so the interval of the
// interruption is known exactly when the service comes back.
func (s *Service) PlanSuspension(ctx context.Context, startedAt, endedAt time.Time) (RecoveryBoundary, error) {
	if startedAt.IsZero() {
		return RecoveryBoundary{}, ErrInvalidArgument
	}
	if !endedAt.IsZero() && endedAt.Before(startedAt) {
		return RecoveryBoundary{}, ErrInvalidArgument
	}
	boundaryID := suspensionBoundaryID(SuspensionPlanned, startedAt)
	epoch, err := currentServiceEpoch(ctx, s.db)
	if err != nil {
		return RecoveryBoundary{}, err
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
	if _, err = tx.Exec(ctx, `INSERT INTO online_suspension_boundaries(boundary_id,kind,started_at,ended_at,service_epoch,interruption_ms) VALUES($1,$2,$3,$4,$5,0)
ON CONFLICT (boundary_id) DO NOTHING`, boundaryID, string(SuspensionPlanned), startedAt.UTC(), ended, epoch); err != nil {
		return RecoveryBoundary{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return RecoveryBoundary{}, err
	}
	return s.loadRecoveryBoundary(ctx, s.db, boundaryID)
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
	// A planned boundary that was persisted before the stop is the exact
	// interruption. It wins over a derived one.
	planned, err := s.pendingPlannedBoundary(ctx, conn)
	if err != nil {
		return RecoveryPlan{}, err
	}
	if planned != "" {
		boundary, err := s.loadRecoveryBoundary(ctx, conn, planned)
		if err != nil {
			return RecoveryPlan{}, err
		}
		if boundary.AdjustedAt != nil {
			// A replay of an applied interruption never opens a new epoch.
			return s.applyBoundary(ctx, conn, planned)
		}
		// A planned interruption opens a new epoch like any other
		// interruption. The work of the interrupted epoch is fenced,
		// including the runner leases that may still hold a provider
		// request.
		epoch, err := s.openServiceEpoch(ctx, conn, "planned interruption")
		if err != nil {
			return RecoveryPlan{}, err
		}
		if _, err = conn.Exec(ctx, `UPDATE online_suspension_boundaries SET service_epoch=$1 WHERE boundary_id=$2 AND adjusted_at IS NULL`, epoch, planned); err != nil {
			return RecoveryPlan{}, err
		}
		return s.applyBoundary(ctx, conn, planned)
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
	if _, err = s.loadRecoveryBoundary(ctx, conn, boundaryID); err == nil {
		return s.applyBoundary(ctx, conn, boundaryID)
	} else if !errors.Is(err, ErrNotFound) {
		return RecoveryPlan{}, err
	}
	epoch, err := s.openServiceEpoch(ctx, conn, "unexpected interruption")
	if err != nil {
		return RecoveryPlan{}, err
	}
	if _, err = conn.Exec(ctx, `INSERT INTO online_suspension_boundaries(boundary_id,kind,started_at,ended_at,service_epoch,interruption_ms) VALUES($1,$2,$3,$4,$5,$6)
ON CONFLICT (boundary_id) DO NOTHING`, boundaryID, string(SuspensionUnexpected), start, end, epoch, end.Sub(start).Milliseconds()); err != nil {
		return RecoveryPlan{}, err
	}
	return s.applyBoundary(ctx, conn, boundaryID)
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
		end = resumed
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
	if _, err = tx.Exec(ctx, `UPDATE online_suspension_boundaries SET ended_at=$1,resumed_at=$1,adjusted_at=$1,interruption_ms=$2 WHERE boundary_id=$3`, resumed, shift.Milliseconds(), boundary.BoundaryID); err != nil {
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
	// The recovery is a durable health observation. The next restart derives
	// its interval from this checkpoint, so a restart never re-adjusts the
	// same interruption.
	if s.health != nil {
		if err = s.health.ReportDependency(ctx, DependencyRules, HealthHealthy, "the rules process answered"); err != nil {
			return RecoveryPlan{}, err
		}
	}
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

// pendingPlannedBoundary returns the oldest planned boundary that was not
// applied yet.
func (s *Service) pendingPlannedBoundary(ctx context.Context, q queryer) (string, error) {
	var boundaryID string
	err := q.QueryRow(ctx, `SELECT boundary_id FROM online_suspension_boundaries WHERE kind='planned' AND adjusted_at IS NULL ORDER BY created_at LIMIT 1`).Scan(&boundaryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return boundaryID, nil
}

// openServiceEpoch opens a new service epoch.
//
// The epoch advances once per detected interruption, under the recovery
// leadership lock, so a second API instance never invalidates the work of
// its peers.
func (s *Service) openServiceEpoch(ctx context.Context, conn *pgxpool.Conn, note string) (int64, error) {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var epoch int64
	// The implicit epoch of a service that never opened one is 1, so the
	// first interruption opens epoch 2 and fences the work of epoch 1.
	if err = tx.QueryRow(ctx, `SELECT COALESCE(MAX(epoch),1)+1 FROM online_service_epochs`).Scan(&epoch); err != nil {
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
	if err = tx.Commit(ctx); err != nil {
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
	err := q.QueryRow(ctx, `SELECT boundary_id,kind,started_at,ended_at,resumed_at,adjusted_at,service_epoch,interruption_ms FROM online_suspension_boundaries WHERE boundary_id=$1`, boundaryID).
		Scan(&boundary.BoundaryID, &kind, &boundary.StartedAt, &boundary.EndedAt, &boundary.ResumedAt, &boundary.AdjustedAt, &boundary.ServiceEpoch, &boundary.InterruptionMs)
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
	return boundary, nil
}

// loadRecoveryBoundary reads one persisted interruption from the pool.
func (s *Service) loadRecoveryBoundary(ctx context.Context, q queryer, boundaryID string) (RecoveryBoundary, error) {
	return loadRecoveryBoundary(ctx, q, boundaryID)
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
