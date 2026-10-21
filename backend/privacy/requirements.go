package privacy

// The durable evidence of the removals a restore owes.
//
// The import of a restore replaces the schema of the target database, so the
// part of the removal ledger that only the live database carried is destroyed
// by the restore itself. A digest of that ledger is not enough: nobody can
// rebuild it afterwards, because the data it covers is gone.
//
// The evidence therefore lives outside the restored database, next to the
// marker of the lifecycle:
//
//	<parent>/restore-requirements/<restore>.json
//
// The record is the complete removal ledger that the restore had to apply: the
// match bound records and the subject level records. It is written before the
// import, it is flushed to the disk before the import starts, and it names the
// digest of the ledger it holds, so the digest the fence binds and the
// evidence on the disk always name the same ledger.
//
// The record holds the one-way references of the removed subjects, never the
// identifiers of a removed person, and it is written with restrictive
// permissions: the directory is private to the restore account and the file is
// readable by its owner only. The service of the API never reads the evidence;
// it only refuses to serve while the marker directory of the lifecycle exists.
//
// A record is pending until the removal ledger it names is demonstrably
// applied in the database. A pending record is merged into the removal ledger
// that the next restore has to apply, so a removal that a crashed restore owed
// cannot be forgotten by the next restore, and it is discharged when the
// database holds it.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
)

const (
	// requirementDirectoryName is the name of the directory that holds the
	// durable evidence of the removals a restore owes. It is a sibling of the
	// marker directory of the lifecycle, so it survives the close of the
	// fence.
	requirementDirectoryName = "restore-requirements"
	// requirementDigestLength is the length of the hexadecimal digest that
	// names an evidence record.
	requirementDigestLength = 64
)

// requirementRecord is the durable evidence of one restore.
//
// The record names the restore that wrote it and the removal ledger the
// restore had to apply. The digest is the digest of the ledger, so a record
// whose content does not hash to its digest is refused instead of being
// trusted.
type requirementRecord struct {
	// RestoreID identifies the restore that wrote the record.
	RestoreID string `json:"restoreId"`
	// Digest is the digest of the removal ledger the record names.
	Digest string `json:"digest"`
	// Matches are the match bound removal records the restore had to apply.
	Matches []backup.RemovalRecord `json:"matches"`
	// Subjects are the subject level removal records the restore had to
	// apply.
	Subjects []backup.SubjectRemovalRecord `json:"subjects"`
	// RecordedAt is when the record was written.
	RecordedAt time.Time `json:"recordedAt"`
}

// Ledger returns the removal ledger the record names.
func (r requirementRecord) Ledger() backup.AppliedRemovalLedger {
	return backup.AppliedRemovalLedger{Matches: r.Matches, Subjects: r.Subjects}
}

// requirementDirectory is the directory that holds the durable evidence.
//
// The directory is empty when no fence path is configured: a service without a
// durable fence has no evidence to keep, and it never looks at a relative
// path.
func (s *Service) requirementDirectory() string {
	if s.fenceParent() == "" {
		return ""
	}
	return filepath.Join(s.fenceParent(), requirementDirectoryName)
}

// requirementPath is the name of the evidence of a restore.
//
// The name is the identifier of the restore, so two restores that owe the
// same removal ledger keep two records and neither of them loses its
// evidence.
func requirementPath(restoreID string) string {
	return restoreID + ".json"
}

// writeRequirement writes the durable evidence of a restore.
//
// The record is written to a temporary file in the directory, flushed, and
// then renamed over its name. The rename is atomic, so the evidence of a
// restore is never half written: a crash of the host leaves either the old
// record or the new one.
func (s *Service) writeRequirement(record requirementRecord) error {
	directory := s.requirementDirectory()
	if directory == "" {
		return errors.New("privacy: no restore fence path is configured")
	}
	created := false
	if _, err := os.Stat(directory); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		created = true
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	if created {
		// The name of the directory has to be persistent in the parent that
		// holds it, or a crash of the host could lose the evidence of a
		// restore that is about to import a bundle.
		if err := syncDirectory(s.fenceParent()); err != nil {
			return err
		}
	}
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".requirement-*.partial")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if _, err = temporary.Write(raw); err != nil {
		_ = temporary.Close()
		return err
	}
	if err = temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err = temporary.Close(); err != nil {
		return err
	}
	if err = os.Chmod(name, 0o600); err != nil {
		return err
	}
	if err = os.Rename(name, filepath.Join(directory, requirementPath(record.RestoreID))); err != nil {
		return err
	}
	// The name of the record has to be persistent in its directory.
	return syncDirectory(directory)
}

// readRequirementFile reads the durable evidence of a restore.
//
// The digest of the content has to be the digest the record names: a record
// whose content was changed is refused instead of being trusted.
func (s *Service) readRequirementFile(restoreID string) (requirementRecord, bool, error) {
	directory := s.requirementDirectory()
	if directory == "" {
		return requirementRecord{}, false, nil
	}
	if !restoreIDPattern.MatchString(restoreID) {
		// The name of the record is the identifier of the restore, so the
		// identifier has to be a name and not a path.
		return requirementRecord{}, false, nil
	}
	raw, err := os.ReadFile(filepath.Join(directory, requirementPath(restoreID)))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return requirementRecord{}, false, nil
		}
		return requirementRecord{}, false, err
	}
	var record requirementRecord
	if err = json.Unmarshal(raw, &record); err != nil {
		return requirementRecord{}, false, fmt.Errorf("privacy: the durable evidence of the removal ledger is unreadable")
	}
	if record.RestoreID != restoreID {
		return requirementRecord{}, false, fmt.Errorf("privacy: the durable evidence of the removal ledger names another restore")
	}
	computed := backup.RemovalLedgerDigest(record.Matches, record.Subjects)
	if hex.EncodeToString(computed) != record.Digest {
		return requirementRecord{}, false, fmt.Errorf("privacy: the durable evidence of the removal ledger does not match its digest")
	}
	return record, true, nil
}

// readRequirement reads the durable evidence of a removal ledger.
//
// The digest names the evidence, so the fence of a restore finds the ledger it
// bound and the gate of a restore finds the ledger it waits for.
func (s *Service) readRequirement(digest string) (requirementRecord, bool, error) {
	digest = strings.TrimSpace(digest)
	if len(digest) != requirementDigestLength {
		return requirementRecord{}, false, nil
	}
	records, err := s.listRequirements()
	if err != nil {
		return requirementRecord{}, false, err
	}
	for _, record := range records {
		if record.Digest == digest {
			return record, true, nil
		}
	}
	return requirementRecord{}, false, nil
}

// listRequirements lists the durable evidence that is still pending.
func (s *Service) listRequirements() ([]requirementRecord, error) {
	directory := s.requirementDirectory()
	if directory == "" {
		return nil, nil
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	records := make([]requirementRecord, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, ".") {
			continue
		}
		record, found, err := s.readRequirementFile(strings.TrimSuffix(name, ".json"))
		if err != nil {
			return nil, err
		}
		if !found {
			continue
		}
		records = append(records, record)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].RestoreID < records[j].RestoreID })
	return records, nil
}

// requirementForRestore returns the durable evidence of a restore.
//
// The evidence of a restore is the record that names it. A restore that has
// no evidence never bound a removal ledger, so it has nothing to owe.
func (s *Service) requirementForRestore(restoreID string) (requirementRecord, bool, error) {
	return s.readRequirementFile(restoreID)
}

// requirementForGate returns the durable evidence a gate waits for.
//
// The gate names the digest of the removal ledger it waits for, and that
// digest names the durable evidence of the ledger.
func (s *Service) requirementForGate(digest []byte) (requirementRecord, bool, error) {
	records, err := s.listRequirements()
	if err != nil {
		return requirementRecord{}, false, err
	}
	for _, record := range records {
		if bytes.Equal(gateDigest(record.Digest), digest) {
			return record, true, nil
		}
	}
	return requirementRecord{}, false, nil
}

// PendingRemovalRequirements returns the removal ledger that the restores
// which did not finish still owe.
//
// The ledger is the union of the durable evidence of every pending restore. A
// restore merges it into the removal ledger it has to apply, so the removals
// that a crashed restore owed are replayed by the next restore and cannot be
// forgotten.
func (s *Service) PendingRemovalRequirements(_ context.Context) (backup.AppliedRemovalLedger, error) {
	records, err := s.listRequirements()
	if err != nil {
		return backup.AppliedRemovalLedger{}, err
	}
	merged := backup.AppliedRemovalLedger{}
	for _, record := range records {
		if merged.Matches, err = backup.MergeRemovalLedgers(merged.Matches, record.Matches); err != nil {
			return backup.AppliedRemovalLedger{}, err
		}
		if merged.Subjects, err = backup.MergeSubjectRemovalLedgers(merged.Subjects, record.Subjects); err != nil {
			return backup.AppliedRemovalLedger{}, err
		}
	}
	return merged, nil
}

// dischargeRequirements removes the durable evidence that the database holds.
//
// A record is discharged when the applied removal ledger contains the ledger
// it names. The record of the restore that holds the fence is kept, so a
// crash between the release of the gate and the close of the fence still finds
// the evidence it needs.
func (s *Service) dischargeRequirements(applied backup.AppliedRemovalLedger, keep string) error {
	records, err := s.listRequirements()
	if err != nil {
		return err
	}
	discharged := false
	for _, record := range records {
		if record.RestoreID == keep {
			continue
		}
		if !backup.RemovalLedgerContains(applied, record.Ledger()) {
			// The database does not hold the ledger of the record yet, so the
			// removals are still owed.
			continue
		}
		if err = os.Remove(filepath.Join(s.requirementDirectory(), requirementPath(record.RestoreID))); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		discharged = true
	}
	if !discharged {
		// Nothing was removed, so the directory is not flushed: it may not
		// exist at all.
		return nil
	}
	return syncDirectory(s.requirementDirectory())
}

// RestoreRequirement returns the removal ledger that a restore had to apply.
//
// The ledger is the durable evidence of the restore, so the operator does not
// have to rebuild it from the bundle and the rotation copies: the evidence is
// the exact ledger the restore bound, and it survives the crash of the
// restore and the import of its bundle.
func (s *Service) RestoreRequirement(restoreID string) (backup.AppliedRemovalLedger, bool, error) {
	restoreID = strings.TrimSpace(restoreID)
	if restoreID == "" {
		return backup.AppliedRemovalLedger{}, false, ErrInvalidArgument
	}
	if !restoreIDPattern.MatchString(restoreID) {
		// The identifier of a restore is a name and not a path, exactly like
		// the name of the marker of the lifecycle.
		return backup.AppliedRemovalLedger{}, false, ErrInvalidArgument
	}
	record, found, err := s.requirementForRestore(restoreID)
	if err != nil {
		return backup.AppliedRemovalLedger{}, false, err
	}
	if !found {
		return backup.AppliedRemovalLedger{}, false, nil
	}
	return record.Ledger(), true, nil
}

// requirementDigest is the digest of a removal ledger, as the name of the
// durable evidence and the value of the fence are written.
func requirementDigest(ledger backup.AppliedRemovalLedger) string {
	return hex.EncodeToString(backup.RemovalLedgerDigest(ledger.Matches, ledger.Subjects))
}

// The digest of a restore gate.
//
// A gate of the current version waits for a removal ledger that has durable
// evidence, and its digest says so: the digest of a gate of the current
// version starts with the marker, and the digest of a gate that was recorded
// before the evidence store existed does not.
//
// The marker is what tells the two apart. A gate of the current version whose
// evidence is missing waits for removals that are still owed, so it is
// retained and the service stays closed. A gate of an older version has no
// evidence to look for, and it keeps the release it always had.
const gateDigestMarker = "kha7"

// gateDigest is the digest of a gate that waits for a removal ledger with
// durable evidence.
func gateDigest(evidence string) []byte {
	sum := sha256.Sum256([]byte("kha79.restore.gate.v1:" + evidence))
	digest := make([]byte, 0, 32)
	digest = append(digest, gateDigestMarker...)
	digest = append(digest, sum[:32-len(gateDigestMarker)]...)
	return digest
}

// gateWaitsForEvidence reports whether a gate waits for a removal ledger that
// has durable evidence.
func gateWaitsForEvidence(digest []byte) bool {
	return len(digest) == 32 && string(digest[:len(gateDigestMarker)]) == gateDigestMarker
}
