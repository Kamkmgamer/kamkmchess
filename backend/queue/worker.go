package queue

import (
	"context"
	"errors"

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
		// The decision records the pending engine fallback in its own
		// transaction, under the bucket lock. A kept search that won the
		// interval is never overwritten by a stale pass of the loop.
		_, err = s.decide(ctx, actor, entryID, allocationRequest{RecordFallbackPending: true})
		switch {
		case errors.Is(err, errFallbackPending):
			// The cutoff was reached and no candidate was eligible. The
			// entry waits for the browser engine fallback.
			result.Pending++
			continue
		case errors.Is(err, ErrNoCandidate):
			// The entry keeps searching. Nothing is pending and nothing
			// failed.
			continue
		case err != nil:
			if errors.Is(err, ErrAccountRemoved) {
				// The owner of the entry was removed. The removal flow
				// cleans its queue rows, so the sweep has nothing to do.
				continue
			}
			result.Failed++
			continue
		}
		result.Matched++
	}
	return result, nil
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
//
// The sweep counts only the entries it really expired. An entry whose lease
// was renewed while the sweep waited for the bucket lock of its time control
// stays eligible, and the sweep never reports an expiry it did not perform.
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
		expired, err := s.expireEntry(ctx, entryID)
		if err != nil {
			result.Failed++
			continue
		}
		if expired {
			result.Expired++
		}
	}
	return result, nil
}

// expireEntry expires one waiting entry.
//
// It reports whether the entry was expired. The row of the entry is read
// again under the bucket lock and the decision time is sampled after that
// lock, so a lease that a heartbeat renewed while the sweep waited is a
// live lease: the sweep never expires an entry that is still eligible.
//
// The lock order of the queue is the bucket lock and then the row lock, and
// every other queue write takes the same order, so the sweep never waits for
// a row in the opposite order of another writer.
func (s *Service) expireEntry(ctx context.Context, entryID string) (bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	record, err := s.loadEntry(ctx, s.db, entryID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			// The entry is gone: the removal of its owner deleted it. There
			// is nothing to expire.
			return false, nil
		}
		return false, err
	}
	if err = lockBucket(ctx, tx, record.StartingTimeMs, record.IncrementMs); err != nil {
		return false, err
	}
	// The entry is locked and read again under the bucket lock. Every queue
	// write takes the bucket lock before it writes the row, so the row that
	// is read here is the authoritative one.
	current, err := s.lockEntry(ctx, tx, entryID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	if current.InternalState != internalWaiting && current.InternalState != internalFallback {
		// The entry left the eligibility: it was assigned, cancelled or
		// expired already. The sweep has nothing to do.
		return false, nil
	}
	// The decision time is sampled after the lock the sweep waited for, so a
	// lease that died during the wait is a dead lease and a lease that was
	// renewed during the wait is a live one.
	now := s.now().UTC()
	if current.ExpiresAt == nil || current.ExpiresAt.After(now) {
		// The lease is alive. The entry stays eligible.
		return false, nil
	}
	tag, err := tx.Exec(ctx, `UPDATE online_queue_entries SET internal_state='expired',version=version+1,updated_at=$2 WHERE entry_id=$1 AND internal_state IN ('waiting', 'fallback')`, entryID, now)
	if err != nil {
		return false, err
	}
	expired := tag.RowsAffected() > 0
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	return expired, nil
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
