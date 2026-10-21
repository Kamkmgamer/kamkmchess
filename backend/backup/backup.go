package backup

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const (
	// ExportMagic is the first line of the encrypted plaintext payload. It lets
	// one bundle carry both the logical SQL export and the deletion ledger that
	// a restore has to reapply.
	ExportMagic = "kamkmchess-logical-export"
	// ExportFormat is the payload format version.
	ExportFormat = 1
)

var (
	ErrDumpTooLarge = errors.New("backup: logical export exceeds the supported size")
	ErrLedgerDigest = errors.New("backup: deletion ledger digest mismatch")
)

// ExportPayload is the plaintext content of a bundle: the pg_dump plain-text
// logical export plus the deletion ledger read at seal time.
type ExportPayload struct {
	Tool      string      `json:"tool"`
	Tombstone []Tombstone `json:"tombstones"`
	// Removals is the online removal ledger read at seal time. It is the
	// record that an erased shared game or a removed identity must not come
	// back when an older backup is restored.
	Removals []RemovalRecord `json:"removals"`
	// SubjectRemovals is the subject level removal ledger read at seal time.
	// It is the record that a removed subject stays removed, whatever it
	// played and whatever private data it held.
	SubjectRemovals []SubjectRemovalRecord `json:"subjectRemovals"`
	SQL             []byte                 `json:"-"`
}

// EncodeExport renders the payload as its documented one-line header followed
// by the raw SQL export, so the SQL that follows is byte-identical to the
// pg_dump output.
func EncodeExport(payload ExportPayload) ([]byte, error) {
	ledger, err := EncodeLedger(payload.Tombstone)
	if err != nil {
		return nil, err
	}
	removals, err := json.Marshal(payload.Removals)
	if err != nil {
		return nil, err
	}
	subjectRemovals, err := json.Marshal(payload.SubjectRemovals)
	if err != nil {
		return nil, err
	}
	header, err := json.Marshal(struct {
		Format          int    `json:"format"`
		Tool            string `json:"tool"`
		Ledger          string `json:"ledger"`
		Removals        string `json:"removals"`
		SubjectRemovals string `json:"subjectRemovals"`
		SQLBytes        int    `json:"sqlBytes"`
	}{ExportFormat, payload.Tool, base64.StdEncoding.EncodeToString(ledger), base64.StdEncoding.EncodeToString(removals), base64.StdEncoding.EncodeToString(subjectRemovals), len(payload.SQL)})
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(ExportMagic)+len(header)+len(payload.SQL)+2)
	out = append(out, ExportMagic...)
	out = append(out, ' ')
	out = append(out, header...)
	out = append(out, '\n')
	return append(out, payload.SQL...), nil
}

// DecodeExport parses a verified plaintext payload.
func DecodeExport(plaintext []byte) (ExportPayload, error) {
	var payload ExportPayload
	end := bytes.IndexByte(plaintext, '\n')
	if end <= len(ExportMagic) || string(plaintext[:len(ExportMagic)]) != ExportMagic || plaintext[len(ExportMagic)] != ' ' {
		return ExportPayload{}, ErrMalformedContainer
	}
	var header struct {
		Format          int    `json:"format"`
		Tool            string `json:"tool"`
		Ledger          string `json:"ledger"`
		Removals        string `json:"removals"`
		SubjectRemovals string `json:"subjectRemovals"`
		SQLBytes        int    `json:"sqlBytes"`
	}
	if json.Unmarshal(plaintext[len(ExportMagic)+1:end], &header) != nil || header.Format != ExportFormat {
		return ExportPayload{}, ErrMalformedContainer
	}
	ledgerJSON, err := base64.StdEncoding.DecodeString(header.Ledger)
	if err != nil {
		return ExportPayload{}, ErrMalformedContainer
	}
	if json.Unmarshal(ledgerJSON, &payload.Tombstone) != nil {
		return ExportPayload{}, ErrMalformedContainer
	}
	// A bundle sealed before the removal ledger existed carries no removals.
	if header.Removals != "" {
		removalsJSON, err := base64.StdEncoding.DecodeString(header.Removals)
		if err != nil {
			return ExportPayload{}, ErrMalformedContainer
		}
		if len(removalsJSON) > 0 && json.Unmarshal(removalsJSON, &payload.Removals) != nil {
			return ExportPayload{}, ErrMalformedContainer
		}
	}
	// The subject level ledger is newer than the match bound one, so a bundle
	// without it simply carries none.
	if header.SubjectRemovals != "" {
		subjectJSON, err := base64.StdEncoding.DecodeString(header.SubjectRemovals)
		if err != nil {
			return ExportPayload{}, ErrMalformedContainer
		}
		if len(subjectJSON) > 0 && json.Unmarshal(subjectJSON, &payload.SubjectRemovals) != nil {
			return ExportPayload{}, ErrMalformedContainer
		}
	}
	payload.Tool = header.Tool
	payload.SQL = plaintext[end+1:]
	if header.SQLBytes != len(payload.SQL) {
		return ExportPayload{}, fmt.Errorf("%w: export header claims %d SQL bytes, found %d", ErrMalformedContainer, header.SQLBytes, len(payload.SQL))
	}
	return payload, nil
}

// Dumper produces a logical export. It is an interface so no test, plan or
// offline rehearsal needs a PostgreSQL server.
type Dumper interface {
	// Describe returns a tool identity recorded in the manifest, for example
	// "pg_dump (PostgreSQL) 17.4".
	Describe(ctx context.Context) (string, error)
	Dump(ctx context.Context, w io.Writer) error
}

// TombstoneSource reads the durable deletion ledger of the live database.
type TombstoneSource interface {
	ListTombstones(ctx context.Context) ([]Tombstone, error)
}

// TombstoneSink reads and reapplies the deletion ledger during a restore.
type TombstoneSink interface {
	TombstoneSource
	// ApplyTombstones must be idempotent: applying the same ledger twice leaves
	// the database in the same state.
	ApplyTombstones(ctx context.Context, tombstones []Tombstone) error
}

// Restorer loads a logical export into a target database. Implementations must
// run the restore in one transaction, so a failed restore leaves no partial
// schema and no partially deleted game behind.
type Restorer interface {
	Restore(ctx context.Context, sql io.Reader) error
}

// CreateRequest describes one sealed backup. Passphrase bytes are used for this
// call only and are never stored, logged or written to disk.
type CreateRequest struct {
	Path         string
	Label        string
	Passphrase   []byte
	CreatedAt    time.Time
	RestoredFrom string
	// MaxBytes bounds the logical export. Zero uses MaxPlaintextBytes.
	MaxBytes   int
	Dumper     Dumper
	Tombstones TombstoneSource
	// Removals is the optional online removal ledger. When it is present, the
	// bundle carries the removals, so a restore of an older bundle can
	// replay them before the restored database serves traffic.
	Removals RemovalLedgerSource
}

// Create seals one encrypted logical export at Path. The file is written
// through a temporary file in the same directory and renamed, so a partial
// backup never appears under a rotation label.
func Create(ctx context.Context, request CreateRequest) (Manifest, error) {
	if request.Path == "" || request.Dumper == nil || request.Tombstones == nil {
		return Manifest{}, fmt.Errorf("%w: path, dumper and tombstone source are required", ErrMalformedContainer)
	}
	if _, err := ParseLabel(request.Label); err != nil {
		return Manifest{}, err
	}
	if request.CreatedAt.IsZero() {
		request.CreatedAt = time.Now().UTC()
	}
	tool, err := request.Dumper.Describe(ctx)
	if err != nil {
		return Manifest{}, err
	}
	ledger, err := request.Tombstones.ListTombstones(ctx)
	if err != nil {
		return Manifest{}, err
	}
	if _, err = MergeLedgers(ledger, nil); err != nil {
		return Manifest{}, err
	}
	var removals []RemovalRecord
	var subjectRemovals []SubjectRemovalRecord
	if request.Removals != nil {
		removals, err = request.Removals.ListRemovalRecords(ctx)
		if err != nil {
			return Manifest{}, err
		}
		if _, err = MergeRemovalLedgers(removals, nil); err != nil {
			return Manifest{}, err
		}
		subjectRemovals, err = request.Removals.ListSubjectRemovalRecords(ctx)
		if err != nil {
			return Manifest{}, err
		}
		if _, err = MergeSubjectRemovalLedgers(subjectRemovals, nil); err != nil {
			return Manifest{}, err
		}
	}
	maxBytes := request.MaxBytes
	if maxBytes == 0 {
		maxBytes = MaxPlaintextBytes
	}
	if maxBytes < 1 || maxBytes > MaxPlaintextBytes {
		return Manifest{}, fmt.Errorf("%w: unsupported export bound %d", ErrTooLarge, maxBytes)
	}
	limited := &limitWriter{limit: maxBytes}
	if err = request.Dumper.Dump(ctx, limited); err != nil {
		if errors.Is(err, ErrDumpTooLarge) {
			return Manifest{}, ErrDumpTooLarge
		}
		return Manifest{}, err
	}
	plaintext, err := EncodeExport(ExportPayload{Tool: tool, Tombstone: ledger, Removals: removals, SubjectRemovals: subjectRemovals, SQL: limited.buffer.Bytes()})
	if err != nil {
		return Manifest{}, err
	}
	ledgerJSON, err := EncodeLedger(ledger)
	if err != nil {
		return Manifest{}, err
	}
	removalsJSON, err := json.Marshal(removals)
	if err != nil {
		return Manifest{}, err
	}
	subjectRemovalsJSON, err := json.Marshal(subjectRemovals)
	if err != nil {
		return Manifest{}, err
	}
	sealed := Manifest{
		Label:                   request.Label,
		CreatedAt:               request.CreatedAt.UTC(),
		DumpTool:                tool,
		TombstoneCount:          len(ledger),
		TombstoneLedgerSHA:      digestHex(ledgerJSON),
		RemovalCount:            len(removals),
		RemovalLedgerSHA:        digestHex(removalsJSON),
		SubjectRemovalCount:     len(subjectRemovals),
		SubjectRemovalLedgerSHA: digestHex(subjectRemovalsJSON),
		RestoredFrom:            request.RestoredFrom,
	}
	container, sealedManifest, err := Seal(sealed, plaintext, request.Passphrase)
	if err != nil {
		return Manifest{}, err
	}
	if err = writeFileAtomic(request.Path, container); err != nil {
		return Manifest{}, err
	}
	return sealedManifest, nil
}

// Verified is the result of authenticating a bundle without touching a
// database. Every restore starts here.
type Verified struct {
	Manifest   Manifest
	Payload    ExportPayload
	SQLBytes   int64
	PlainBytes int64
}

// Verify authenticates one bundle and cross-checks the manifest against the
// decrypted payload. It performs no database access and no writes.
func Verify(path string, passphrase []byte) (Verified, error) {
	container, err := ReadContainer(path)
	if err != nil {
		return Verified{}, err
	}
	manifest, plaintext, err := Open(container, passphrase)
	if err != nil {
		return Verified{}, err
	}
	payload, err := DecodeExport(plaintext)
	if err != nil {
		return Verified{}, err
	}
	ledgerJSON, err := EncodeLedger(payload.Tombstone)
	if err != nil {
		return Verified{}, err
	}
	if manifest.TombstoneCount != len(payload.Tombstone) || manifest.TombstoneLedgerSHA != digestHex(ledgerJSON) {
		return Verified{}, ErrLedgerDigest
	}
	removalsJSON, err := json.Marshal(payload.Removals)
	if err != nil {
		return Verified{}, err
	}
	if manifest.RemovalCount != len(payload.Removals) {
		return Verified{}, ErrLedgerDigest
	}
	if len(payload.Removals) > 0 && manifest.RemovalLedgerSHA != digestHex(removalsJSON) {
		return Verified{}, ErrLedgerDigest
	}
	subjectRemovalsJSON, err := json.Marshal(payload.SubjectRemovals)
	if err != nil {
		return Verified{}, err
	}
	if manifest.SubjectRemovalCount != len(payload.SubjectRemovals) {
		return Verified{}, ErrLedgerDigest
	}
	if len(payload.SubjectRemovals) > 0 && manifest.SubjectRemovalLedgerSHA != digestHex(subjectRemovalsJSON) {
		return Verified{}, ErrLedgerDigest
	}
	return Verified{Manifest: manifest, Payload: payload, SQLBytes: int64(len(payload.SQL)), PlainBytes: manifest.PlaintextBytes}, nil
}

// RestorePlan is the reviewable result of a restore rehearsal.
type RestorePlan struct {
	Manifest       Manifest             `json:"manifest"`
	SQLBytes       int64                `json:"sqlBytes"`
	Recovery       []RecoveryAction     `json:"recovery"`
	RecoveryCounts map[RecoveryKind]int `json:"recoveryCounts"`
}

// PlanRestore authenticates a bundle, merges every supplied newer deletion
// ledger and reports the deletion recovery it would perform. It writes nothing
// and is safe to run against production configuration during a rehearsal.
func PlanRestore(ctx context.Context, path string, passphrase []byte, sink TombstoneSink, newerLedgers [][]Tombstone) (RestorePlan, error) {
	verified, ledger, err := inspect(ctx, path, passphrase, sink, newerLedgers)
	if err != nil {
		return RestorePlan{}, err
	}
	live, err := sink.ListTombstones(ctx)
	if err != nil {
		return RestorePlan{}, err
	}
	actions, err := PlanDeletionRecovery(live, ledger)
	if err != nil {
		return RestorePlan{}, err
	}
	return RestorePlan{
		Manifest:       verified.Manifest,
		SQLBytes:       verified.SQLBytes,
		Recovery:       actions,
		RecoveryCounts: SummarizeRecovery(actions),
	}, nil
}

func inspect(ctx context.Context, path string, passphrase []byte, sink TombstoneSink, newerLedgers [][]Tombstone) (Verified, []Tombstone, error) {
	if sink == nil {
		return Verified{}, nil, fmt.Errorf("%w: a tombstone sink is required", ErrMalformedContainer)
	}
	verified, err := Verify(path, passphrase)
	if err != nil {
		return Verified{}, nil, err
	}
	ledger, err := MergeLedgers(verified.Payload.Tombstone, nil)
	if err != nil {
		return Verified{}, nil, err
	}
	for _, newer := range newerLedgers {
		if ledger, err = MergeLedgers(ledger, newer); err != nil {
			return Verified{}, nil, err
		}
	}
	return verified, ledger, nil
}

// RestoreRequest describes one restore. NewerLedgers carries the deletion
// ledgers of the newer rotation copies, so restoring an older bundle cannot
// resurrect a game that was deleted afterwards.
type RestoreRequest struct {
	Path         string
	Passphrase   []byte
	Restorer     Restorer
	Tombstones   TombstoneSink
	NewerLedgers [][]Tombstone
	// Removals is the optional online removal ledger sink. When it is
	// present, the merged removal ledger is replayed after the restore, so an
	// erased shared game or a removed identity cannot come back.
	Removals RemovalLedgerSink
	// NewerRemovalLedgers carries the removal ledgers of the newer rotation
	// copies.
	NewerRemovalLedgers [][]RemovalRecord
	// NewerSubjectRemovalLedgers carries the subject level removal ledgers of
	// the newer rotation copies.
	NewerSubjectRemovalLedgers [][]SubjectRemovalRecord
	// AdmissionFence is the durable admission control of the restore.
	//
	// A restore that carries removals is refused without it. The fence lives
	// outside the restored database, so it survives the schema replacement and
	// a crash of the restore process, and it is the only control that keeps a
	// restored database from serving a removal that was not replayed.
	AdmissionFence AdmissionFence
	// RestoreID identifies the restore. It is bound to the fence.
	RestoreID string
	// Takeover continues the lifecycle of a restore that crashed.
	//
	// The marker of the crashed restore is replaced inside the marker
	// directory, so the marker never disappears and the service stays closed
	// while the take-over runs.
	Takeover bool
}

// RestoreResult reports what a completed restore actually did.
type RestoreResult struct {
	RestorePlan
	TombstonesApplied int `json:"tombstonesApplied"`
	// TombstonesKept counts ledger entries the restored database already
	// honoured, which is the expected outcome for a fresh restore.
	TombstonesKept int `json:"tombstonesKept"`
	// RemovalsApplied counts the online removals that were replayed after the
	// restore.
	RemovalsApplied int `json:"removalsApplied"`
	// RemovalsPending lists the online removals that still have to be applied
	// before the restored database serves traffic. It is only filled when no
	// removal sink was supplied.
	RemovalsPending []RemovalRecord `json:"removalsPending,omitempty"`
	// SubjectRemovalsApplied counts the subject level removals that were
	// replayed after the restore.
	SubjectRemovalsApplied int `json:"subjectRemovalsApplied"`
	// SubjectRemovalsPending lists the subject level removals that still have
	// to be applied before the restored database serves traffic.
	SubjectRemovalsPending []SubjectRemovalRecord `json:"subjectRemovalsPending,omitempty"`
}

// Restore authenticates the bundle, loads the logical export in one
// transaction, then reapplies the merged deletion ledger. A failure before the
// sink write leaves the target database unchanged.
//
// The online removal ledger is replayed after the restore, in the same call.
// A restore that cannot replay the removals must not serve traffic, so the
// removal sink is a required part of a restore that carries removals.
func Restore(ctx context.Context, request RestoreRequest) (RestoreResult, error) {
	if request.Restorer == nil {
		return RestoreResult{}, fmt.Errorf("%w: a restorer is required", ErrMalformedContainer)
	}
	verified, ledger, err := inspect(ctx, request.Path, request.Passphrase, request.Tombstones, request.NewerLedgers)
	if err != nil {
		return RestoreResult{}, err
	}
	// The admission of the restore is taken before anything is read from the
	// database.
	//
	// The fence is the control that keeps the service closed while the import
	// replaces the schema of the database: the service refuses every request
	// that arrives while the fence is open, so no removal is admitted after
	// the ledgers below were read.
	//
	// The scope of that guarantee is exact, and it is stated here rather than
	// claimed wider:
	//
	//   - a removal that is admitted *after* the fence was taken is refused by
	//     the service, so it cannot be lost by the import;
	//   - a removal that was already admitted *before* the fence was taken can
	//     still commit after the ledgers were read, and the import can lose it.
	//     The operator therefore stops and drains the API before a restore.
	//
	// A restore without removals is fenced as well: its import replaces the
	// schema too, and a service that serves a half imported database is a
	// service that serves a database whose removals are gone.
	if request.AdmissionFence == nil {
		return RestoreResult{}, fmt.Errorf("%w: a restore needs an admission fence", ErrLedgerConflict)
	}
	if request.RestoreID == "" {
		return RestoreResult{}, fmt.Errorf("%w: a restore needs a restore identifier", ErrLedgerConflict)
	}
	handle, err := request.AdmissionFence.BeginFence(request.RestoreID, request.Takeover)
	if err != nil {
		return RestoreResult{}, err
	}
	// The handle owns the lifecycle until the fence is closed. A restore that
	// fails or that is killed leaves the marker of the lifecycle behind, so
	// the service stays closed until an operator resolves the restore.
	//
	// The release is deferred on every path that does not close the fence. A
	// restore that closed the fence sets the handle to nil, so the closed
	// fence is never released a second time.
	defer func() {
		if handle != nil {
			handle.Release()
		}
	}()
	if request.Removals == nil {
		// A restore without the removal ledger sink cannot replay the
		// removals that the restores which did not finish still owe, and the
		// import of the restore destroys the removals that only the live
		// database carried. Such a restore would import the bundle and close
		// the fence with those removals unapplied, and the service would serve
		// them again.
		//
		// The fence owns the durable evidence of the removals, so the fence
		// itself says whether any are owed. The check runs under the
		// ownership of the lifecycle, so no other restore can create an
		// obligation in the middle of it, and it runs before the import, so
		// the database is not touched.
		owed, err := request.AdmissionFence.PendingRemovalRequirements(ctx)
		if err != nil {
			return RestoreResult{}, err
		}
		if len(owed.Matches) > 0 || len(owed.Subjects) > 0 {
			return RestoreResult{}, fmt.Errorf("%w: a restore without a removal ledger sink cannot run while removals are owed", ErrLedgerConflict)
		}
	}
	live, err := request.Tombstones.ListTombstones(ctx)
	if err != nil {
		return RestoreResult{}, err
	}
	actions, err := PlanDeletionRecovery(live, ledger)
	if err != nil {
		return RestoreResult{}, err
	}
	removals, err := mergeRemovals(ctx, verified.Payload.Removals, request.Removals, request.NewerRemovalLedgers)
	if err != nil {
		return RestoreResult{}, err
	}
	subjectRemovals, err := mergeSubjectRemovals(ctx, verified.Payload.SubjectRemovals, request.Removals, request.NewerSubjectRemovalLedgers)
	if err != nil {
		return RestoreResult{}, err
	}
	// The removals that the restores which did not finish still owe are
	// merged into the ledger this restore has to apply.
	//
	// The import of a restore replaces the schema of the target database, so
	// a removal that only the live database carried is destroyed by the
	// import itself. The durable evidence of that removal lives outside the
	// database, and it is merged here, so the next restore replays it and the
	// removal cannot be forgotten.
	owed := AppliedRemovalLedger{}
	if request.Removals != nil {
		if owed, err = request.Removals.PendingRemovalRequirements(ctx); err != nil {
			return RestoreResult{}, err
		}
	}
	if len(owed.Matches) > 0 {
		if removals, err = MergeRemovalLedgers(removals, owed.Matches); err != nil {
			return RestoreResult{}, err
		}
	}
	if len(owed.Subjects) > 0 {
		if subjectRemovals, err = MergeSubjectRemovalLedgers(subjectRemovals, owed.Subjects); err != nil {
			return RestoreResult{}, err
		}
	}
	carriesRemovals := len(removals) > 0 || len(subjectRemovals) > 0
	if carriesRemovals && request.Removals == nil {
		// A restore that carries removals needs the removal sink, because the
		// removals have to be replayed before the restored database serves
		// traffic. The check happens before the import, so a restore that
		// cannot replay its removals never touches the database.
		return RestoreResult{}, fmt.Errorf("%w: a restore with removals needs a removal sink", ErrLedgerConflict)
	}
	// The marker of the lifecycle names the removal ledger the restore has to
	// apply. It is bound after the ledgers were read and before the import,
	// and the ledger itself is kept as durable evidence next to the marker, so
	// the recovery of a crashed restore can name it.
	required := AppliedRemovalLedger{Matches: removals, Subjects: subjectRemovals}
	if err = handle.Bind(required); err != nil {
		return RestoreResult{}, err
	}
	if err = request.Restorer.Restore(ctx, bytes.NewReader(verified.Payload.SQL)); err != nil {
		return RestoreResult{}, err
	}
	// The restored database is the union target: reapply every ledger entry so
	// deletions newer than this bundle stay deleted.
	if err = request.Tombstones.ApplyTombstones(ctx, ledger); err != nil {
		return RestoreResult{}, err
	}
	result := RestoreResult{
		RestorePlan: RestorePlan{
			Manifest:       verified.Manifest,
			SQLBytes:       verified.SQLBytes,
			Recovery:       actions,
			RecoveryCounts: SummarizeRecovery(actions),
		},
		TombstonesApplied: len(ledger),
		TombstonesKept:    SummarizeRecovery(actions)[RecoveryKeep],
	}
	if !carriesRemovals {
		// A restore without removals still replaced the schema, so its fence
		// has to be closed: a marker that stayed behind would keep the service
		// closed forever. There is no removal ledger to replay and no gate to
		// release, so the empty ledger is the one the fence names.
		if err = handle.Finish(AppliedRemovalLedger{}); err != nil {
			return RestoreResult{}, err
		}
		// The fence is closed, so the deferred release is not needed.
		handle = nil
		return result, nil
	}
	if len(removals) > 0 {
		if err = request.Removals.ApplyRemovalRecords(ctx, removals); err != nil {
			return RestoreResult{}, err
		}
		result.RemovalsApplied = len(removals)
	}
	if len(subjectRemovals) > 0 {
		if err = request.Removals.ApplySubjectRemovalRecords(ctx, subjectRemovals); err != nil {
			return RestoreResult{}, err
		}
		result.SubjectRemovalsApplied = len(subjectRemovals)
	}
	// The fence is closed only when the applied ledger holds every removal the
	// restore had to apply. A restore that lost one keeps the fence open and
	// the service closed.
	applied, err := request.Removals.AppliedRemovalLedger(ctx)
	if err != nil {
		return RestoreResult{}, err
	}
	if !RemovalLedgerContains(applied, required) {
		return RestoreResult{}, fmt.Errorf("%w: the applied removal ledger is not the ledger of the restore", ErrLedgerConflict)
	}
	// The restore is recorded and its gate is released while the fence is
	// still open. A crash between the release and the close of the fence
	// leaves a fence that the operator can close, and a crash before the
	// release leaves a recorded gate that the operator can recover.
	if _, err = request.Removals.RecordRestore(ctx, request.RestoreID); err != nil {
		return RestoreResult{}, err
	}
	if err = request.Removals.ReleaseRestoreGate(ctx, request.RestoreID); err != nil {
		return RestoreResult{}, err
	}
	if err = handle.Finish(applied); err != nil {
		return RestoreResult{}, err
	}
	// The fence is closed, so the deferred release is not needed.
	handle = nil
	return result, nil
}

// mergeSubjectRemovals merges the subject level removal ledger of a bundle
// with the newer rotation ledgers and the live ledger.
func mergeSubjectRemovals(ctx context.Context, bundle []SubjectRemovalRecord, sink RemovalLedgerSource, newer [][]SubjectRemovalRecord) ([]SubjectRemovalRecord, error) {
	merged, err := MergeSubjectRemovalLedgers(bundle, nil)
	if err != nil {
		return nil, err
	}
	for _, set := range newer {
		if merged, err = MergeSubjectRemovalLedgers(merged, set); err != nil {
			return nil, err
		}
	}
	if sink != nil {
		live, err := sink.ListSubjectRemovalRecords(ctx)
		if err != nil {
			return nil, err
		}
		if merged, err = MergeSubjectRemovalLedgers(merged, live); err != nil {
			return nil, err
		}
	}
	return merged, nil
}

// mergeRemovals merges the removal ledger of a bundle with the newer removal
// ledgers of the rotation copies.
func mergeRemovals(ctx context.Context, bundle []RemovalRecord, sink RemovalLedgerSource, newer [][]RemovalRecord) ([]RemovalRecord, error) {
	merged, err := MergeRemovalLedgers(bundle, nil)
	if err != nil {
		return nil, err
	}
	for _, set := range newer {
		if merged, err = MergeRemovalLedgers(merged, set); err != nil {
			return nil, err
		}
	}
	if sink != nil {
		live, err := sink.ListRemovalRecords(ctx)
		if err != nil {
			return nil, err
		}
		if merged, err = MergeRemovalLedgers(merged, live); err != nil {
			return nil, err
		}
	}
	return merged, nil
}

// CollectLedgers verifies several bundles and merges their deletion ledgers. It
// is how an operator reapplies tombstones across the whole rotation after
// restoring one older copy, and it needs the passphrase of those bundles.
func CollectLedgers(paths []string, passphrase []byte) ([]Tombstone, error) {
	merged := []Tombstone(nil)
	for _, path := range paths {
		verified, err := Verify(path, passphrase)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		if merged, err = MergeLedgers(merged, verified.Payload.Tombstone); err != nil {
			return nil, err
		}
	}
	return merged, nil
}

// CollectRemovalLedgers verifies several bundles and merges their online
// removal ledgers.
//
// The deletion tombstones and the online removals are two different ledgers: a
// restore has to replay both, so the operator flow needs both of them.
func CollectRemovalLedgers(paths []string, passphrase []byte) ([]RemovalRecord, []SubjectRemovalRecord, error) {
	var (
		removals []RemovalRecord
		subjects []SubjectRemovalRecord
	)
	for _, path := range paths {
		verified, err := Verify(path, passphrase)
		if err != nil {
			return nil, nil, fmt.Errorf("%s: %w", path, err)
		}
		if removals, err = MergeRemovalLedgers(removals, verified.Payload.Removals); err != nil {
			return nil, nil, err
		}
		if subjects, err = MergeSubjectRemovalLedgers(subjects, verified.Payload.SubjectRemovals); err != nil {
			return nil, nil, err
		}
	}
	return removals, subjects, nil
}

type limitWriter struct {
	limit  int
	buffer bytes.Buffer
	err    error
}

func (w *limitWriter) Write(p []byte) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	if w.buffer.Len()+len(p) > w.limit {
		w.err = ErrDumpTooLarge
		return 0, ErrDumpTooLarge
	}
	return w.buffer.Write(p)
}

// writeFileAtomic writes owner-only bytes through a temporary file in the same
// directory, so a reader never observes a half-written bundle.
func writeFileAtomic(path string, content []byte) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".khabackup-*.partial")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if _, err = temporary.Write(content); err != nil {
		temporary.Close()
		return err
	}
	if err = temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err = temporary.Close(); err != nil {
		return err
	}
	if err = os.Chmod(name, 0o600); err != nil {
		return err
	}
	return os.Rename(name, path)
}
