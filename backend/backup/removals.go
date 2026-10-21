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
// content.
//
// The subject of the record is the one-way reference of the removed subject,
// not the subject identifier. A restore finds the rows of that subject by the
// reference, so neither the ledger nor the encrypted bundle retains the
// identifier of a removed person.
type RemovalRecord struct {
	// RemovalID identifies the removal request.
	RemovalID string `json:"removalId"`
	// SubjectKind is account or guest.
	SubjectKind string `json:"subjectKind"`
	// SubjectID is the one-way reference of the removed subject.
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

// SubjectRemovalRecord is the removal of one subject, whatever it played.
//
// The record answers a different question than the match bound record: the
// subject itself was removed. An account that only had private games never
// appears in a match bound record, so without this record a restore of an
// older backup would lose the removal: the private data would come back and
// the account would be able to use its old session again.
//
// The record carries the one-way reference of the subject, never the subject
// identifier, and it never names a match.
type SubjectRemovalRecord struct {
	// RecordID identifies the record.
	RecordID string `json:"recordId"`
	// SubjectKind is account or guest.
	SubjectKind string `json:"subjectKind"`
	// SubjectRef is the one-way reference of the removed subject.
	SubjectRef string `json:"subjectRef"`
	// Scope is account_deletion or explicit_removal.
	Scope string `json:"scope"`
	// RemovedAt is when the removal was applied.
	RemovedAt time.Time `json:"removedAt"`
}

// validate checks the shape of a subject removal record.
func (r SubjectRemovalRecord) validate() error {
	if r.RecordID == "" || r.SubjectRef == "" {
		return fmt.Errorf("%w: incomplete subject removal record", ErrLedgerConflict)
	}
	if r.SubjectKind != "account" && r.SubjectKind != "guest" {
		return fmt.Errorf("%w: invalid removal subject kind %q", ErrLedgerConflict, r.SubjectKind)
	}
	if r.Scope != "account_deletion" && r.Scope != "explicit_removal" {
		return fmt.Errorf("%w: invalid removal scope %q", ErrLedgerConflict, r.Scope)
	}
	if r.RemovedAt.IsZero() {
		return fmt.Errorf("%w: incomplete subject removal record", ErrLedgerConflict)
	}
	return nil
}

// MergeSubjectRemovalLedgers unions two subject removal ledgers, keeping the
// later removal of every subject and scope.
func MergeSubjectRemovalLedgers(older, newer []SubjectRemovalRecord) ([]SubjectRemovalRecord, error) {
	bySubject := map[string]SubjectRemovalRecord{}
	for _, set := range [][]SubjectRemovalRecord{older, newer} {
		for _, entry := range set {
			if err := entry.validate(); err != nil {
				return nil, err
			}
			key := entry.SubjectKind + "\x00" + entry.SubjectRef + "\x00" + entry.Scope
			current, exists := bySubject[key]
			if !exists || entry.RemovedAt.After(current.RemovedAt) {
				bySubject[key] = entry
			}
		}
	}
	merged := make([]SubjectRemovalRecord, 0, len(bySubject))
	for _, entry := range bySubject {
		merged = append(merged, entry)
	}
	sort.Slice(merged, func(i, j int) bool { return merged[i].RecordID < merged[j].RecordID })
	return merged, nil
}

// RemovalLedgerSource reads the removal ledger of the live database.
type RemovalLedgerSource interface {
	// ListRemovalRecords returns every match bound removal of the live
	// database.
	ListRemovalRecords(ctx context.Context) ([]RemovalRecord, error)
	// ListSubjectRemovalRecords returns every subject removal of the live
	// database.
	ListSubjectRemovalRecords(ctx context.Context) ([]SubjectRemovalRecord, error)
}

// RemovalLedgerSink reads and reapplies the removal ledger during a restore.
type RemovalLedgerSink interface {
	RemovalLedgerSource
	// ApplyRemovalRecords must be idempotent: applying the same records twice
	// leaves the database in the same state.
	ApplyRemovalRecords(ctx context.Context, records []RemovalRecord) error
	// ApplySubjectRemovalRecords must be idempotent as well.
	ApplySubjectRemovalRecords(ctx context.Context, records []SubjectRemovalRecord) error
}
