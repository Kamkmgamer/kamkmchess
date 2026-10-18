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
	SQL       []byte      `json:"-"`
}

// EncodeExport renders the payload as its documented one-line header followed
// by the raw SQL export, so the SQL that follows is byte-identical to the
// pg_dump output.
func EncodeExport(payload ExportPayload) ([]byte, error) {
	ledger, err := EncodeLedger(payload.Tombstone)
	if err != nil {
		return nil, err
	}
	header, err := json.Marshal(struct {
		Format   int    `json:"format"`
		Tool     string `json:"tool"`
		Ledger   string `json:"ledger"`
		SQLBytes int    `json:"sqlBytes"`
	}{ExportFormat, payload.Tool, base64.StdEncoding.EncodeToString(ledger), len(payload.SQL)})
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
	plaintext, err := EncodeExport(ExportPayload{Tool: tool, Tombstone: ledger, SQL: limited.buffer.Bytes()})
	if err != nil {
		return Manifest{}, err
	}
	ledgerJSON, err := EncodeLedger(ledger)
	if err != nil {
		return Manifest{}, err
	}
	sealed := Manifest{
		Label:              request.Label,
		CreatedAt:          request.CreatedAt.UTC(),
		DumpTool:           tool,
		TombstoneCount:     len(ledger),
		TombstoneLedgerSHA: digestHex(ledgerJSON),
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
}

// RestoreResult reports what a completed restore actually did.
type RestoreResult struct {
	RestorePlan
	TombstonesApplied int `json:"tombstonesApplied"`
	// TombstonesKept counts ledger entries the restored database already
	// honoured, which is the expected outcome for a fresh restore.
	TombstonesKept int `json:"tombstonesKept"`
}

// Restore authenticates the bundle, loads the logical export in one
// transaction, then reapplies the merged deletion ledger. A failure before the
// sink write leaves the target database unchanged.
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
	if err = request.Restorer.Restore(ctx, bytes.NewReader(verified.Payload.SQL)); err != nil {
		return RestoreResult{}, err
	}
	// The restored database is the union target: reapply every ledger entry so
	// deletions newer than this bundle stay deleted.
	if err = request.Tombstones.ApplyTombstones(ctx, ledger); err != nil {
		return RestoreResult{}, err
	}
	return RestoreResult{
		RestorePlan: RestorePlan{
			Manifest:       verified.Manifest,
			SQLBytes:       verified.SQLBytes,
			Recovery:       actions,
			RecoveryCounts: SummarizeRecovery(actions),
		},
		TombstonesApplied: len(ledger),
		TombstonesKept:    SummarizeRecovery(actions)[RecoveryKeep],
	}, nil
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
