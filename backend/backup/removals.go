package backup

import (
	"context"
	"fmt"
	"sort"
	"time"
)

// RemovalRecord is one removal that a restore has to replay.
//
// A record states that a shared replay, an identifying snapshot or a private
// owner record of one match was removed. The record never carries the removed
// content. It carries the subject of the removal, because the replay of a
// restored database has to find the rows of that subject.
//
// The private single-owner deletion ledger and the online removal ledger are
// two different things: the first one deletes a private game, the second one
// erases a shared online game or an identity. A restore replays both.
type RemovalRecord struct {
	// RemovalID identifies the removal request.
	RemovalID string `json:"removalId"`
	// SubjectKind is account or guest.
	SubjectKind string `json:"subjectKind"`
	// SubjectID is the removed subject.
	SubjectID string `json:"subjectId"`
	// MatchID is the shared match the removal touched.
	MatchID string `json:"matchId"`
	// Scope is account_deletion or explicit_removal.
	Scope string `json:"scope"`
	// RemovedAt is when the removal was applied.
	RemovedAt time.Time `json:"removedAt"`
}

// validate checks the shape of a removal record.
func (r RemovalRecord) validate() error {
	if r.RemovalID == "" || r.MatchID == "" || r.SubjectID == "" {
		return fmt.Errorf("%w: incomplete removal record for match %q", ErrLedgerConflict, r.MatchID)
	}
	if r.SubjectKind != "account" && r.SubjectKind != "guest" {
		return fmt.Errorf("%w: invalid removal subject kind %q", ErrLedgerConflict, r.SubjectKind)
	}
	if r.Scope != "account_deletion" && r.Scope != "explicit_removal" {
		return fmt.Errorf("%w: invalid removal scope %q", ErrLedgerConflict, r.Scope)
	}
	if r.RemovedAt.IsZero() {
		return fmt.Errorf("%w: incomplete removal record for match %q", ErrLedgerConflict, r.MatchID)
	}
	return nil
}

// MergeRemovalLedgers unions two removal ledgers, keeping the later removal
// of every match.
//
// Restoring an older rotation copy and replaying every newer removal is what
// keeps an erased shared game from resurrecting.
func MergeRemovalLedgers(older, newer []RemovalRecord) ([]RemovalRecord, error) {
	byMatch := map[string]RemovalRecord{}
	for _, set := range [][]RemovalRecord{older, newer} {
		for _, entry := range set {
			if err := entry.validate(); err != nil {
				return nil, err
			}
			current, exists := byMatch[entry.MatchID]
			if !exists {
				byMatch[entry.MatchID] = entry
				continue
			}
			if current.SubjectID != entry.SubjectID {
				return nil, fmt.Errorf("%w: match %q has two removal subjects", ErrLedgerConflict, entry.MatchID)
			}
			if entry.RemovedAt.After(current.RemovedAt) {
				byMatch[entry.MatchID] = entry
			}
		}
	}
	merged := make([]RemovalRecord, 0, len(byMatch))
	for _, entry := range byMatch {
		merged = append(merged, entry)
	}
	sort.Slice(merged, func(i, j int) bool { return merged[i].MatchID < merged[j].MatchID })
	return merged, nil
}

// RemovalLedgerSource reads the removal ledger of the live database.
type RemovalLedgerSource interface {
	// ListRemovalRecords returns every removal of the live database.
	ListRemovalRecords(ctx context.Context) ([]RemovalRecord, error)
}

// RemovalLedgerSink reads and reapplies the removal ledger during a restore.
type RemovalLedgerSink interface {
	RemovalLedgerSource
	// ApplyRemovalRecords must be idempotent: applying the same records twice
	// leaves the database in the same state.
	ApplyRemovalRecords(ctx context.Context, records []RemovalRecord) error
}
