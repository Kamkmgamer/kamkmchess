package backup

import (
	"context"
	"crypto/sha256"
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
// of every subject of every match.
//
// The key is the match, the kind and the subject: two participants of the same
// match can both be removed, and their removals are two different removals.
//
// The stronger removal of a subject wins: an explicit removal erases the
// shared replay, and an ordinary deletion only anonymizes it. The later
// removal of the same strength wins as well, so the merge is deterministic
// whatever order the ledgers arrive in.
func MergeRemovalLedgers(older, newer []RemovalRecord) ([]RemovalRecord, error) {
	bySubject := map[string]RemovalRecord{}
	for _, set := range [][]RemovalRecord{older, newer} {
		for _, entry := range set {
			if err := entry.validate(); err != nil {
				return nil, err
			}
			key := removalKey(entry.MatchID, entry.SubjectKind, entry.SubjectID)
			current, exists := bySubject[key]
			if !exists {
				bySubject[key] = entry
				continue
			}
			if entry.RemovedAt.Equal(current.RemovedAt) && entry.Scope == current.Scope && entry.RemovalID != current.RemovalID {
				// Two different removals of the same subject, with the same
				// strength and the same time, are an inconsistency. The merge
				// refuses them instead of picking one by the order of the
				// input.
				return nil, fmt.Errorf("%w: the removal of %q has two identifiers", ErrLedgerConflict, entry.SubjectID)
			}
			if strongerRemoval(entry, current) {
				bySubject[key] = entry
			}
		}
	}
	merged := make([]RemovalRecord, 0, len(bySubject))
	for _, entry := range bySubject {
		merged = append(merged, entry)
	}
	sort.Slice(merged, func(i, j int) bool {
		return removalKey(merged[i].MatchID, merged[i].SubjectKind, merged[i].SubjectID) <
			removalKey(merged[j].MatchID, merged[j].SubjectKind, merged[j].SubjectID)
	})
	return merged, nil
}

// removalKey is the complete key of a removal record.
func removalKey(matchID, subjectKind, subjectID string) string {
	return matchID + "\x00" + subjectKind + "\x00" + subjectID
}

// strongerSubjectRemoval reports whether the first subject removal is the
// stronger one.
func strongerSubjectRemoval(candidate, current SubjectRemovalRecord) bool {
	if candidate.Scope != current.Scope {
		return candidate.Scope == "explicit_removal"
	}
	return candidate.RemovedAt.After(current.RemovedAt)
}

// strongerRemoval reports whether the first removal is the stronger one.
//
// An explicit removal erases the shared replay and an ordinary deletion only
// anonymizes it, so the explicit removal always wins. Two removals of the same
// strength are ordered by their time, and the later one wins.
func strongerRemoval(candidate, current RemovalRecord) bool {
	if candidate.Scope != current.Scope {
		return candidate.Scope == "explicit_removal"
	}
	return candidate.RemovedAt.After(current.RemovedAt)
}

// RemovalLedgerContains reports whether the applied ledger holds every record
// of the required ledger.
//
// The applied ledger of a restored database can hold more than the required
// one: the restored database brings its own older records back. The check is
// therefore a containment, not an equality, so a restore that lost a removal
// is still visible.
//
// The strength of a removal counts. An explicit removal erases the shared
// replay, and an ordinary deletion only anonymizes it, so an applied
// anonymization does not satisfy a required explicit removal.
//
// The applied ledger can hold two rows for the same match, kind and subject:
// the restored database brings its own row back and the replay writes the row
// of the removal it applied. The strongest of those rows is the one that
// counts, exactly like the subject level half of the check, so the answer does
// not depend on the order of the rows and never on the random identifier of a
// removal.
func RemovalLedgerContains(applied, required AppliedRemovalLedger) bool {
	haveMatches := map[string]RemovalRecord{}
	for _, record := range applied.Matches {
		key := removalKey(record.MatchID, record.SubjectKind, record.SubjectID)
		// The strongest applied removal of the match, kind and subject is the
		// one that counts.
		if existing, ok := haveMatches[key]; !ok || strongerRemoval(record, existing) {
			haveMatches[key] = record
		}
	}
	for _, record := range required.Matches {
		existing, ok := haveMatches[removalKey(record.MatchID, record.SubjectKind, record.SubjectID)]
		if !ok {
			return false
		}
		if existing.Scope != record.Scope && existing.Scope != "explicit_removal" {
			// The applied removal is weaker than the required one.
			return false
		}
	}
	haveSubjects := map[string]SubjectRemovalRecord{}
	for _, record := range applied.Subjects {
		key := subjectKey(record.SubjectKind, record.SubjectRef)
		// The strongest applied removal of the subject is the one that counts.
		if existing, ok := haveSubjects[key]; !ok || strongerSubjectRemoval(record, existing) {
			haveSubjects[key] = record
		}
	}
	for _, record := range required.Subjects {
		existing, ok := haveSubjects[subjectKey(record.SubjectKind, record.SubjectRef)]
		if !ok {
			return false
		}
		if existing.Scope != record.Scope && existing.Scope != "explicit_removal" {
			return false
		}
	}
	return true
}

// subjectKey is the key of a subject removal record without its scope.
//
// The scope is not part of the key, because a stronger removal of the same
// subject satisfies a weaker requirement: an explicit removal erases the
// shared replay, and an ordinary deletion only anonymizes it.
func subjectKey(subjectKind, subjectRef string) string {
	return subjectKind + "\x00" + subjectRef
}

// subjectRecordKey is the complete key of a subject removal record.
func subjectRecordKey(subjectKind, subjectRef, scope, recordID string) string {
	return subjectKind + "\x00" + subjectRef + "\x00" + scope + "\x00" + recordID
}

// recordKey is the complete key of a match bound removal record.
func recordKey(matchID, subjectKind, subjectID, scope, removalID string) string {
	return matchID + "\x00" + subjectKind + "\x00" + subjectID + "\x00" + scope + "\x00" + removalID
}

// RemovalLedgerDigest is the digest of a removal ledger.
//
// The digest covers the complete key of every record, so two ledgers that hold
// the same removals in a different order have the same digest, and two ledgers
// that hold different removals have different digests.
func RemovalLedgerDigest(matches []RemovalRecord, subjects []SubjectRemovalRecord) []byte {
	// The digest is order independent: the records are sorted by their
	// complete key, so two ledgers that hold the same removals have the same
	// digest.
	// The sort is over the complete key of a record: the match, the kind, the
	// subject, the scope and the identifier. Two records that differ in the
	// scope or in the identifier therefore have a defined order, and the
	// digest does not depend on the order of the input.
	ordered := append([]RemovalRecord(nil), matches...)
	sort.Slice(ordered, func(i, j int) bool {
		return recordKey(ordered[i].MatchID, ordered[i].SubjectKind, ordered[i].SubjectID, ordered[i].Scope, ordered[i].RemovalID) <
			recordKey(ordered[j].MatchID, ordered[j].SubjectKind, ordered[j].SubjectID, ordered[j].Scope, ordered[j].RemovalID)
	})
	orderedSubjects := append([]SubjectRemovalRecord(nil), subjects...)
	sort.Slice(orderedSubjects, func(i, j int) bool {
		return subjectRecordKey(orderedSubjects[i].SubjectKind, orderedSubjects[i].SubjectRef, orderedSubjects[i].Scope, orderedSubjects[i].RecordID) <
			subjectRecordKey(orderedSubjects[j].SubjectKind, orderedSubjects[j].SubjectRef, orderedSubjects[j].Scope, orderedSubjects[j].RecordID)
	})
	digest := sha256.New()
	for _, record := range ordered {
		digest.Write([]byte("match:"))
		digest.Write([]byte(removalKey(record.MatchID, record.SubjectKind, record.SubjectID)))
		digest.Write([]byte{0})
		digest.Write([]byte(record.Scope))
		digest.Write([]byte{0})
		digest.Write([]byte(record.RemovalID))
		digest.Write([]byte{0})
	}
	for _, record := range orderedSubjects {
		digest.Write([]byte("subject:"))
		digest.Write([]byte(record.SubjectKind))
		digest.Write([]byte{0})
		digest.Write([]byte(record.SubjectRef))
		digest.Write([]byte{0})
		digest.Write([]byte(record.Scope))
		digest.Write([]byte{0})
		digest.Write([]byte(record.RecordID))
		digest.Write([]byte{0})
	}
	return digest.Sum(nil)
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
	// AppliedRemovalLedger returns the removal ledger that is applied in the
	// database. The restore compares it with the ledger it had to apply, so a
	// restore that applied a different ledger keeps the fence open.
	AppliedRemovalLedger(ctx context.Context) (AppliedRemovalLedger, error)
	// PendingRemovalRequirements returns the removal ledger that the
	// restores which did not finish still owe.
	//
	// The removals that only the live database carried are destroyed by the
	// import of a restore, so they are kept as durable evidence outside the
	// database. The restore merges that evidence into the removal ledger it
	// has to apply, so a removal that a crashed restore owed is replayed by
	// the next restore and cannot be forgotten.
	PendingRemovalRequirements(ctx context.Context) (AppliedRemovalLedger, error)
	// RecordRestore records the restore in the durable restore gate. The gate
	// is recorded while the fence is still open, so a crash between the
	// replay and the release leaves a recorded gate that the operator can
	// recover.
	RecordRestore(ctx context.Context, restoreID string) (string, error)
	// ReleaseRestoreGate releases the gate of the restore. It is called only
	// after the removal ledger was applied and verified, and it is called
	// before the fence is closed.
	ReleaseRestoreGate(ctx context.Context, restoreID string) error
}

// AppliedRemovalLedger is the removal ledger of a database.
type AppliedRemovalLedger struct {
	Matches  []RemovalRecord
	Subjects []SubjectRemovalRecord
}

// AdmissionFence is the durable admission control of a restore.
//
// The fence lives outside the restored database, so it survives the schema
// replacement of the restore and a crash of the restore process.
//
// The admission is taken before the restore reads anything from the database.
// The service is closed while the fence is open, so a removal that is
// committed after the admission is refused by the service and cannot be lost
// by the import, and the service never serves a database whose import is half
// done.
//
// The scope of that guarantee is exact: a removal that was admitted *before*
// the fence was taken can still commit after the ledgers were read, and the
// import can lose it. The operator therefore stops and drains the API before
// a restore.
type AdmissionFence interface {
	// BeginFence takes the ownership of the restore lifecycle and returns the
	// handle of the ownership. The handle holds the cross process ownership
	// for the whole lifecycle of the restore.
	//
	// A take-over continues the lifecycle of a restore that crashed: the
	// marker of the crashed restore is replaced inside the marker directory,
	// so the marker never disappears and the service stays closed.
	BeginFence(restoreID string, takeover bool) (FenceHandle, error)
}

// FenceHandle is the ownership of the restore lifecycle.
//
// The handle is the only thing that may finish or release the lifecycle. The
// close of the fence uses the handle and not a lock that is taken again, so
// the ownership cannot be lost or displaced while the restore runs.
type FenceHandle interface {
	// Bind records the removal ledger the restore has to apply in the marker
	// of the lifecycle. It is called after the ledgers were read and before
	// the import.
	//
	// The ledger itself is kept as durable evidence outside the restored
	// database, because the import destroys the removals that only the live
	// database carried. The marker names the digest of that evidence.
	Bind(required AppliedRemovalLedger) error
	// Finish closes the fence of the restore. It is called only after the
	// removal ledger was applied and verified, and it refuses a restore that
	// applied a different ledger.
	Finish(applied AppliedRemovalLedger) error
	// Release gives the ownership back without closing the fence. The marker
	// of the lifecycle survives, so the service stays closed.
	Release()
}
