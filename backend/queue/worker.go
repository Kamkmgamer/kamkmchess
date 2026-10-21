package queue

import (
	"context"
	"errors"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// SweepResult reports what one sweep of the queue did.
//
// The counters are observations, not promises: a sweep that fails on one
// entry continues with the next one, so one broken entry never blocks the
// queue.
type SweepResult struct {
	// Expired is the number of entries that lost their readiness lease.
	Expired int
	// Matched is the number of entries that produced a candidate game.
	Matched int
	// Pending is the number of entries whose cutoff was reached without a
	// candidate. The browser engine fallback may be committed for them.
	Pending int
	// Failed is the number of entries the sweep could not resolve.
	Failed int
}

// ResolveDueCutoffs resolves the entries whose original cutoff has passed.
//
// The sweep resolves the deadline the owner was promised, not the current
// time: a candidate that became ready after the original cutoff is never
// matched by this decision, and a candidate that was ready at the cutoff is
// matched even when the timer is late.
//
// The sweep never commits the browser engine fallback. The fallback needs a
// ready engine in the owner's browser, so the sweep only records that the
// cutoff was reached and no candidate was available.
func (s *Service) ResolveDueCutoffs(ctx context.Context, limit int) (SweepResult, error) {
	result := SweepResult{}
	if limit <= 0 {
		return result, nil
	}
	now := s.now().UTC()
	rows, err := s.db.Query(ctx, `SELECT entry_id FROM online_queue_entries
		WHERE internal_state='waiting' AND keep_searching=false AND original_cutoff_at IS NOT NULL AND original_cutoff_at<=$1
		ORDER BY original_cutoff_at, entry_id
		LIMIT $2`, now, limit)
	if err != nil {
		return result, err
	}
	entryIDs := make([]string, 0, limit)
	for rows.Next() {
		var entryID string
		if err = rows.Scan(&entryID); err != nil {
			rows.Close()
			return result, err
		}
		entryIDs = append(entryIDs, entryID)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return result, err
	}
	for _, entryID := range entryIDs {
		record, err := s.loadEntry(ctx, s.db, entryID)
		if err != nil {
			result.Failed++
			continue
		}
		actor := online.ParticipantRef{Kind: online.ParticipantAccount, ID: record.OwnerID}
		_, err = s.decide(ctx, actor, entryID, allocationRequest{}, now)
		if errors.Is(err, ErrNoCandidate) {
			// The cutoff was reached and no candidate was eligible. The
			// entry waits for the browser engine fallback.
			if err = s.markFallbackPending(ctx, entryID, now); err != nil {
				result.Failed++
				continue
			}
			result.Pending++
			continue
		}
		if err != nil {
			result.Failed++
			continue
		}
		result.Matched++
	}
	return result, nil
}

// markFallbackPending records that the cutoff was reached without a
// candidate.
//
// The entry stays eligible for the engine fallback and for a candidate that
// was eligible at the original cutoff. It is not assigned yet, so no route
// publishes a game that does not exist.
func (s *Service) markFallbackPending(ctx context.Context, entryID string, now time.Time) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	record, err := s.loadEntry(ctx, s.db, entryID)
	if err != nil {
		return err
	}
	if err = lockBucket(ctx, tx, record.StartingTimeMs, record.IncrementMs); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE online_queue_entries SET internal_state='fallback',version=version+1,updated_at=$2 WHERE entry_id=$1 AND internal_state='waiting'`, entryID, now); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}

// ExpireWaiting expires the entries whose owner stopped responding.
//
// A responsive background tab keeps its entry eligible because it heartbeats.
// A frozen or disconnected entry loses the readiness lease, leaves the
// eligibility and needs an explicit rejoin. The entry is never revived by
// the sweep.
//
// An entry whose cutoff passed and whose browser never reported a ready
// engine expires as well. It is a waiting entry on the wire, so a silent
// owner must not keep it in the queue forever.
func (s *Service) ExpireWaiting(ctx context.Context, limit int) (SweepResult, error) {
	result := SweepResult{}
	if limit <= 0 {
		return result, nil
	}
	now := s.now().UTC()
	rows, err := s.db.Query(ctx, `SELECT entry_id FROM online_queue_entries
		WHERE internal_state IN ('waiting', 'fallback') AND expires_at IS NOT NULL AND expires_at<=$1
		ORDER BY expires_at, entry_id
		LIMIT $2`, now, limit)
	if err != nil {
		return result, err
	}
	entryIDs := make([]string, 0, limit)
	for rows.Next() {
		var entryID string
		if err = rows.Scan(&entryID); err != nil {
			rows.Close()
			return result, err
		}
		entryIDs = append(entryIDs, entryID)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return result, err
	}
	for _, entryID := range entryIDs {
		if err = s.expireEntry(ctx, entryID, now); err != nil {
			result.Failed++
			continue
		}
		result.Expired++
	}
	return result, nil
}

// expireEntry expires one waiting entry.
func (s *Service) expireEntry(ctx context.Context, entryID string, now time.Time) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	record, err := s.loadEntry(ctx, s.db, entryID)
	if err != nil {
		return err
	}
	if err = lockBucket(ctx, tx, record.StartingTimeMs, record.IncrementMs); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE online_queue_entries SET internal_state='expired',version=version+1,updated_at=$2 WHERE entry_id=$1 AND internal_state IN ('waiting', 'fallback')`, entryID, now); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}

// Sweep runs one full pass of the queue background work.
//
// It expires the entries whose owner stopped responding and resolves the
// cutoffs that passed against their original deadline.
func (s *Service) Sweep(ctx context.Context, limit int) (SweepResult, error) {
	expired, err := s.ExpireWaiting(ctx, limit)
	if err != nil {
		return SweepResult{}, err
	}
	due, err := s.ResolveDueCutoffs(ctx, limit)
	if err != nil {
		return expired, err
	}
	return SweepResult{
		Expired: expired.Expired,
		Matched: due.Matched,
		Pending: due.Pending,
		Failed:  expired.Failed + due.Failed,
	}, nil
}
