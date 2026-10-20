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
	SQL      []byte          `json:"-"`
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
	header, err := json.Marshal(struct {
		Format   int    `json:"format"`
		Tool     string `json:"tool"`
		Ledger   string `json:"ledger"`
		Removals string `json:"removals"`
		SQLBytes int    `json:"sqlBytes"`
	}{ExportFormat, payload.Tool, base64.StdEncoding.EncodeToString(ledger), base64.StdEncoding.EncodeToString(removals), len(payload.SQL)})
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
		Format   int    `json:"format"`
		Tool     string `json:"tool"`
		Ledger   string `json:"ledger"`
		Removals string `json:"removals"`
		SQLBytes int    `json:"sqlBytes"`
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
	if request.Removals != nil {
		removals, err = request.Removals.ListRemovalRecords(ctx)
		if err != nil {
			return Manifest{}, err
		}
		if _, err = MergeRemovalLedgers(removals, nil); err != nil {
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
	plaintext, err := EncodeExport(ExportPayload{Tool: tool, Tombstone: ledger, Removals: removals, SQL: limited.buffer.Bytes()})
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
	sealed := Manifest{
		Label:              request.Label,
		CreatedAt:          request.CreatedAt.UTC(),
		DumpTool:           tool,
		TombstoneCount:     len(ledger),
		TombstoneLedgerSHA: digestHex(ledgerJSON),
		RemovalCount:       len(removals),
		RemovalLedgerSHA:   digestHex(removalsJSON),
		RestoredFrom:       request.RestoredFrom,
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
	if len(removals) == 0 {
		return result, nil
	}
	if request.Removals == nil {
		// The removals are reported, not applied. The restored database must
		// not serve traffic before they are applied.
		result.RemovalsPending = removals
		return result, nil
	}
	if err = request.Removals.ApplyRemovalRecords(ctx, removals); err != nil {
		return RestoreResult{}, err
	}
	result.RemovalsApplied = len(removals)
	return result, nil
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
