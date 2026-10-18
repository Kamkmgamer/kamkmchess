package backup

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const testPassphrase = "correct horse battery staple"

type fakeDumper struct {
	tool     string
	sql      []byte
	err      error
	describe error
	calls    int
}

func (d *fakeDumper) Describe(context.Context) (string, error) {
	if d.describe != nil {
		return "", d.describe
	}
	if d.tool == "" {
		return "pg_dump (PostgreSQL) 17.4", nil
	}
	return d.tool, nil
}

func (d *fakeDumper) Dump(_ context.Context, w io.Writer) error {
	d.calls++
	if d.err != nil {
		return d.err
	}
	_, err := w.Write(d.sql)
	return err
}

type fakeLedger struct {
	entries      []Tombstone
	applied      []Tombstone
	appliedCalls int
	listErr      error
	applyErr     error
}

func (l *fakeLedger) ListTombstones(context.Context) ([]Tombstone, error) {
	if l.listErr != nil {
		return nil, l.listErr
	}
	return append([]Tombstone(nil), l.entries...), nil
}

func (l *fakeLedger) ApplyTombstones(_ context.Context, tombstones []Tombstone) error {
	l.appliedCalls++
	if l.applyErr != nil {
		return l.applyErr
	}
	l.applied = append([]Tombstone(nil), tombstones...)
	return nil
}

type fakeRestorer struct {
	sql   []byte
	calls int
	err   error
}

func (r *fakeRestorer) Restore(_ context.Context, sql io.Reader) error {
	r.calls++
	if r.err != nil {
		return r.err
	}
	raw, err := io.ReadAll(sql)
	if err != nil {
		return err
	}
	r.sql = raw
	return nil
}

func tombstone(gameID string, deletedAt time.Time, revision, epoch int64) Tombstone {
	return Tombstone{GameID: gameID, OwnerID: "user_" + gameID, DeletedAt: deletedAt, LastRevision: revision, LastEpoch: epoch}
}

func mustCreate(t *testing.T, path, label string, ledger []Tombstone, sql string) Manifest {
	t.Helper()
	manifest, err := Create(context.Background(), CreateRequest{
		Path:       path,
		Label:      label,
		Passphrase: []byte(testPassphrase),
		CreatedAt:  time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC),
		Dumper:     &fakeDumper{sql: []byte(sql)},
		Tombstones: &fakeLedger{entries: ledger},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	return manifest
}

func TestSealOpenRoundTrip(t *testing.T) {
	plaintext := []byte("CREATE TABLE games (game_id text PRIMARY KEY);\n")
	manifest := Manifest{Label: "daily-2026-10-18", CreatedAt: time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC), DumpTool: "pg_dump (PostgreSQL) 17.4"}
	container, sealed, err := Seal(manifest, plaintext, []byte(testPassphrase))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if sealed.PlaintextSHA256 == "" || sealed.PlaintextBytes != int64(len(plaintext)) || sealed.SchemaVersion != SchemaVersion {
		t.Fatalf("sealed manifest is incomplete: %+v", sealed)
	}
	if !bytes.HasPrefix(container, []byte(ContainerMagic)) {
		t.Fatalf("container does not start with the magic prefix")
	}
	if bytes.Contains(container, plaintext) {
		t.Fatalf("plaintext leaked into the container")
	}
	opened, decrypted, err := Open(container, []byte(testPassphrase))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if !bytes.Equal(decrypted, plaintext) {
		t.Fatalf("plaintext mismatch: %q", decrypted)
	}
	if opened.SchemaVersion != SchemaVersion || opened.Label != manifest.Label || !opened.CreatedAt.Equal(manifest.CreatedAt) {
		t.Fatalf("manifest mismatch: %+v", opened)
	}
	if opened.Cipher.Algorithm != algorithmKDF || opened.Cipher.KDF != kdfName || opened.Cipher.Iterations < 1000 {
		t.Fatalf("unexpected cipher description: %+v", opened.Cipher)
	}
}

func TestSealRejectsWeakPassphraseAndEmptyPayload(t *testing.T) {
	if _, _, err := Seal(Manifest{Label: "daily-2026-10-18"}, []byte("sql"), []byte("short")); !errors.Is(err, ErrPassphrase) {
		t.Fatalf("weak passphrase accepted: %v", err)
	}
	if _, _, err := Seal(Manifest{Label: "daily-2026-10-18"}, nil, []byte(testPassphrase)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("empty payload accepted: %v", err)
	}
	if _, _, err := Seal(Manifest{Label: "not-a-rotation-label"}, []byte("sql"), []byte(testPassphrase)); !errors.Is(err, ErrLabelInvalid) {
		t.Fatalf("invalid label accepted: %v", err)
	}
}

func TestOpenRejectsWrongPassphraseAndTampering(t *testing.T) {
	container, _, err := Seal(Manifest{Label: "daily-2026-10-18"}, []byte("SELECT 1;"), []byte(testPassphrase))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if _, _, err = Open(container, []byte("definitely not the passphrase")); !errors.Is(err, ErrPassphrase) {
		t.Fatalf("wrong passphrase accepted: %v", err)
	}

	flipped := append([]byte(nil), container...)
	flipped[len(flipped)-trailerSize-1] ^= 0x01
	if _, _, err = Open(flipped, []byte(testPassphrase)); err == nil {
		t.Fatal("tampered ciphertext was accepted")
	}

	// Rewriting the authenticated manifest (here: the rotation label) must fail
	// even though the ciphertext digest still matches.
	tamperedHeader := append([]byte(nil), container...)
	original := string(tamperedHeader)
	tamperedHeader = bytes.Replace(tamperedHeader, []byte(`"daily-2026-10-18"`), []byte(`"daily-2026-10-17"`), 1)
	if string(tamperedHeader) == original {
		t.Fatal("test fixture did not rewrite the label")
	}
	if _, _, err = Open(tamperedHeader, []byte(testPassphrase)); err == nil {
		t.Fatal("rewritten manifest was accepted")
	}

	truncated := container[:len(container)-1]
	if _, _, err = Open(truncated, []byte(testPassphrase)); err == nil {
		t.Fatal("truncated container was accepted")
	}
	if _, _, err = Open([]byte("not a container at all"), []byte(testPassphrase)); !errors.Is(err, ErrMalformedContainer) {
		t.Fatalf("garbage accepted: %v", err)
	}
}

func TestCreateVerifyAndExportRoundTrip(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "daily-2026-10-18.kha")
	sql := "-- export\nCREATE TABLE games (game_id text PRIMARY KEY);\n"
	ledger := []Tombstone{
		tombstone("game-b", time.Date(2026, 10, 17, 8, 0, 0, 0, time.UTC), 4, 2),
		tombstone("game-a", time.Date(2026, 10, 16, 8, 0, 0, 0, time.UTC), 2, 1),
	}
	manifest := mustCreate(t, path, "daily-2026-10-18", ledger, sql)
	if manifest.TombstoneCount != 2 || manifest.PlaintextSHA256 == "" {
		t.Fatalf("unexpected manifest: %+v", manifest)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("bundle permissions are %v, want owner-only", info.Mode().Perm())
		}
	}
	if leftovers := leftoverPartials(t, directory); len(leftovers) != 0 {
		t.Fatalf("partial bundle files were left behind: %v", leftovers)
	}

	verified, err := Verify(path, []byte(testPassphrase))
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if string(verified.Payload.SQL) != sql {
		t.Fatalf("export SQL was not preserved byte for byte: %q", verified.Payload.SQL)
	}
	if len(verified.Payload.Tombstone) != 2 || verified.Payload.Tombstone[0].GameID != "game-a" {
		t.Fatalf("ledger was not canonicalised: %+v", verified.Payload.Tombstone)
	}
	if verified.Manifest.PlaintextSHA256 != manifest.PlaintextSHA256 {
		t.Fatal("plaintext digest is not stable across verify")
	}
	if _, err = Verify(path, []byte("wrong passphrase here")); !errors.Is(err, ErrPassphrase) {
		t.Fatalf("verify accepted the wrong passphrase: %v", err)
	}
}

func leftoverPartials(t *testing.T, directory string) []string {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	var leftovers []string
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".khabackup-") {
			leftovers = append(leftovers, entry.Name())
		}
	}
	return leftovers
}

func TestCreateRejectsOversizedExport(t *testing.T) {
	_, err := Create(context.Background(), CreateRequest{
		Path:       filepath.Join(t.TempDir(), "daily-2026-10-18.kha"),
		Label:      "daily-2026-10-18",
		Passphrase: []byte(testPassphrase),
		MaxBytes:   64,
		Dumper:     &fakeDumper{sql: bytes.Repeat([]byte("x"), 128)},
		Tombstones: &fakeLedger{},
	})
	if !errors.Is(err, ErrDumpTooLarge) {
		t.Fatalf("oversized export accepted: %v", err)
	}
}

func TestCreatePropagatesDumperFailureWithoutWriting(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "daily-2026-10-18.kha")
	sentinel := errors.New("pg_dump refused the connection")
	_, err := Create(context.Background(), CreateRequest{
		Path:       path,
		Label:      "daily-2026-10-18",
		Passphrase: []byte(testPassphrase),
		Dumper:     &fakeDumper{err: sentinel},
		Tombstones: &fakeLedger{},
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("dumper failure not propagated: %v", err)
	}
	if _, statErr := os.Stat(path); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("a failed backup still wrote %s", path)
	}
}

func TestEncodeExportRejectsTamperedSQLLength(t *testing.T) {
	payload := ExportPayload{Tool: "pg_dump (PostgreSQL) 17.4", Tombstone: nil, SQL: []byte("SELECT 1;\n")}
	encoded, err := EncodeExport(payload)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeExport(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded.SQL) != string(payload.SQL) || decoded.Tool != payload.Tool {
		t.Fatalf("round trip changed the payload: %+v", decoded)
	}
	if _, err = DecodeExport(encoded[:len(encoded)-3]); err == nil {
		t.Fatal("a short payload was accepted")
	}
	if _, err = DecodeExport([]byte("{\"format\":1}\nSELECT 1;")); err == nil {
		t.Fatal("a payload without the export magic was accepted")
	}
}

func TestVerifyRejectsRewrittenLedgerDigest(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "daily-2026-10-18.kha")
	mustCreate(t, path, "daily-2026-10-18", []Tombstone{tombstone("game-a", time.Now().UTC(), 1, 1)}, "SELECT 1;")
	container, err := ReadContainer(path)
	if err != nil {
		t.Fatal(err)
	}
	// An operator who rebuilds a header with a different ledger digest must not
	// be able to pass verification; the digest is authenticated by AES-GCM.
	rewritten := bytes.Replace(container, []byte(`"tombstoneCount":1`), []byte(`"tombstoneCount":0`), 1)
	if _, _, err = Open(rewritten, []byte(testPassphrase)); err == nil {
		t.Fatal("a rewritten manifest authenticated")
	}
}
