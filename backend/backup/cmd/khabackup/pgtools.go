package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"sort"
	"strings"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
	"github.com/jackc/pgx/v5/pgxpool"
)

// dsnEnv converts a PostgreSQL URL into libpq environment variables for a
// child process. The connection string therefore never appears in a command
// line, in a process listing or in an error message this tool prints.
func dsnEnv(raw string) (map[string]string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, errors.New("database URL is not a valid URL")
	}
	if parsed.Scheme != "postgres" && parsed.Scheme != "postgresql" {
		return nil, errors.New("database URL must use the postgres:// scheme")
	}
	host := parsed.Hostname()
	if host == "" {
		return nil, errors.New("database URL has no host")
	}
	database := strings.TrimPrefix(parsed.Path, "/")
	if database == "" {
		return nil, errors.New("database URL has no database name")
	}
	connections := map[string]string{
		"PGHOST":            host,
		"PGDATABASE":        database,
		"PGUSER":            parsed.User.Username(),
		"PGSSLMODE":         "prefer",
		"PGCONNECT_TIMEOUT": "10",
		"PGAPPNAME":         "khabackup",
	}
	if password, set := parsed.User.Password(); set {
		connections["PGPASSWORD"] = password
	}
	if port := parsed.Port(); port != "" {
		connections["PGPORT"] = port
	}
	for key, values := range parsed.Query() {
		if len(values) != 1 || values[0] == "" {
			return nil, fmt.Errorf("database URL parameter %q must have exactly one value", key)
		}
		switch key {
		case "sslmode", "connect_timeout", "application_name":
			connections["PG"+strings.ToUpper(key)] = values[0]
		case "search_path":
			connections["PGOPTIONS"] = "-c search_path=" + values[0]
		default:
			// Unknown connection parameters are refused rather than guessed, so a
			// typo cannot silently change what an operator backs up.
			return nil, fmt.Errorf("unsupported database URL parameter %q", key)
		}
	}
	return connections, nil
}

// childEnvironment starts from an explicit minimal environment, so a local
// pgpass file or a stray PGPASSWORD in the operator shell cannot change what
// the dump or the restore connects to.
func childEnvironment(connections map[string]string) []string {
	environment := map[string]string{"PATH": os.Getenv("PATH")}
	if systemRoot := os.Getenv("SystemRoot"); systemRoot != "" {
		environment["SYSTEMROOT"] = systemRoot
	}
	if home := os.Getenv("HOME"); home != "" {
		environment["HOME"] = home
	}
	for key, value := range connections {
		environment[key] = value
	}
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, key+"="+environment[key])
	}
	return result
}

// pgTools runs local PostgreSQL client binaries. Nothing is downloaded and no
// provider is contacted; an operator supplies binaries from a local install.
type pgTools struct {
	dumpBinary   string
	loaderBinary string
	environment  []string
}

func (t pgTools) Describe(ctx context.Context) (string, error) {
	var output strings.Builder
	if err := runTool(ctx, t.dumpBinary, []string{"--version"}, nil, &output, t.environment); err != nil {
		return "", err
	}
	return strings.TrimSpace(output.String()), nil
}

func (t pgTools) Dump(ctx context.Context, w io.Writer) error {
	arguments := []string{"--format=plain", "--no-owner", "--no-privileges", "--clean", "--if-exists"}
	return runTool(ctx, t.dumpBinary, arguments, nil, w, t.environment)
}

// Restore loads the plain-text export with psql. A plain SQL export is not a
// pg_restore archive, and psql gives the single-transaction, fail-closed
// behaviour a restore needs: ON_ERROR_STOP aborts on the first error and
// --single-transaction rolls the whole load back, so a failed restore leaves no
// partial schema and no partially deleted game behind.
func (t pgTools) Restore(ctx context.Context, sql io.Reader) error {
	arguments := []string{"-v", "ON_ERROR_STOP=1", "--single-transaction", "-q", "-f", "-"}
	var output strings.Builder
	return runTool(ctx, t.loaderBinary, arguments, sql, &output, t.environment)
}

// runTool runs one client binary. Output is captured but never returned for a
// failing run, because a failing client can echo a connection string.
func runTool(ctx context.Context, binary string, arguments []string, stdin io.Reader, stdout io.Writer, environment []string) error {
	if binary == "" {
		return errors.New("no PostgreSQL client binary configured")
	}
	command := exec.CommandContext(ctx, binary, arguments...)
	command.Env = environment
	command.Stdin = stdin
	command.Stdout = stdout
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		return fmt.Errorf("%s failed: %w", binary, err)
	}
	return nil
}

// postgresRemovalLedger reads and reapplies the online removal ledger.
//
// The online removal ledger is the record that an erased shared game or a
// removed identity must not come back. A backup carries it, and a restore
// replays it before the restored database serves traffic.
//
// A database without the online tables simply has no removals, so the private
// single-owner backup tooling keeps working against a database that never had
// the online schema.
type postgresRemovalLedger struct {
	pool     *pgxpool.Pool
	removals *privacy.Service
}

// available reports whether the online removal ledger exists in the database.
//
// A read that fails is not an absent ledger. The caller fails closed: an
// unreadable ledger is not an empty ledger.
func (l postgresRemovalLedger) available(ctx context.Context) (bool, error) {
	var exists bool
	err := l.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='online_removal_ledger')`).Scan(&exists)
	if err != nil {
		return false, err
	}
	return exists, nil
}

// RecoverRestore releases the gate of a restore that crashed after its
// removal ledger was applied.
//
// The recovery is identity bound: the restore is named, the applied removal
// ledger has to be the ledger of the restore, and a wrong clear is refused.
func (l postgresRemovalLedger) RecoverRestore(ctx context.Context, restoreID string, required backup.AppliedRemovalLedger) error {
	available, err := l.available(ctx)
	if err != nil {
		return err
	}
	if !available {
		return errors.New("the online removal ledger is missing; the restored database must not serve traffic")
	}
	return l.removals.RecoverRestore(ctx, restoreID, required)
}

// BeginFence takes the ownership of the restore lifecycle.
//
// The ownership is held for the whole lifecycle of the restore, from the
// admission until the fence is closed. A restore that finds the ownership
// held is a live restore, and it is never displaced.
func (l postgresRemovalLedger) BeginFence(restoreID string, takeover bool) (backup.FenceHandle, error) {
	return l.removals.BeginFence(restoreID, takeover)
}

// AppliedLedgerDigest is the digest of the removal ledger that is applied in the
// database.
func (l postgresRemovalLedger) AppliedLedgerDigest(ctx context.Context) (string, error) {
	available, err := l.available(ctx)
	if err != nil {
		return "", err
	}
	if !available {
		return "", nil
	}
	return l.removals.AppliedLedgerDigest(ctx)
}

// PendingRemovalRequirements returns the removal ledger that the restores
// which did not finish still owe.
//
// The removals that only the live database carried are destroyed by the import
// of a restore, so they are kept as durable evidence outside the database. The
// restore merges that evidence into the removal ledger it has to apply.
func (l postgresRemovalLedger) PendingRemovalRequirements(ctx context.Context) (backup.AppliedRemovalLedger, error) {
	// This evidence lives outside the imported schema. Its existence cannot
	// depend on which tables the restored database currently contains.
	return l.removals.PendingRemovalRequirements(ctx)
}

// PendingRestoreGates counts the restore gates that wait for their release.
func (l postgresRemovalLedger) PendingRestoreGates(ctx context.Context) (int, error) {
	available, err := l.available(ctx)
	if err != nil {
		return 0, err
	}
	if !available {
		return 0, nil
	}
	return l.removals.PendingRestoreGates(ctx)
}

// ServingAllowed reports whether the service may serve traffic.
func (l postgresRemovalLedger) ServingAllowed(ctx context.Context) (bool, error) {
	available, err := l.available(ctx)
	if err != nil {
		return false, err
	}
	if !available {
		return true, nil
	}
	return l.removals.ServingAllowed(ctx)
}

// RestoreRequirement returns the removal ledger that a restore had to apply.
//
// The ledger is the durable evidence of the restore, so the operator does not
// have to rebuild it from the bundle and the rotation copies.
func (l postgresRemovalLedger) RestoreRequirement(restoreID string) (backup.AppliedRemovalLedger, bool, error) {
	return l.removals.RestoreRequirement(restoreID)
}

// RecordRestore records that the database was restored from a backup.
func (l postgresRemovalLedger) RecordRestore(ctx context.Context, restoreID string) (string, error) {
	available, err := l.available(ctx)
	if err != nil {
		return "", err
	}
	if !available {
		return "", nil
	}
	return l.removals.RecordRestore(ctx, restoreID)
}

// ReleaseRestoreGate releases the restore gate after the removal ledger was
// replayed.
//
// The release is refused while the ledger is not applied, so a restored
// database never serves traffic with the rows of a removed game.
func (l postgresRemovalLedger) ReleaseRestoreGate(ctx context.Context, restoreID string) error {
	available, err := l.available(ctx)
	if err != nil {
		return err
	}
	if !available {
		return nil
	}
	return l.removals.ReleaseRestoreGate(ctx, restoreID)
}

// ListRemovalRecords reads the online removal ledger of the live database.
func (l postgresRemovalLedger) ListRemovalRecords(ctx context.Context) ([]backup.RemovalRecord, error) {
	available, err := l.available(ctx)
	if err != nil {
		return nil, err
	}
	if !available {
		return nil, nil
	}
	return l.removals.ListRemovalRecords(ctx)
}

// ListSubjectRemovalRecords reads the subject level removal ledger.
func (l postgresRemovalLedger) ListSubjectRemovalRecords(ctx context.Context) ([]backup.SubjectRemovalRecord, error) {
	available, err := l.available(ctx)
	if err != nil {
		return nil, err
	}
	if !available {
		return nil, nil
	}
	return l.removals.ListSubjectRemovalRecords(ctx)
}

// ApplySubjectRemovalRecords replays the subject level removal ledger.
//
// The subject stays removed after a restore, even when the restored database
// has no deletion record of its own.
func (l postgresRemovalLedger) ApplySubjectRemovalRecords(ctx context.Context, records []backup.SubjectRemovalRecord) error {
	if len(records) == 0 {
		return nil
	}
	available, err := l.available(ctx)
	if err != nil {
		return err
	}
	if !available {
		return errors.New("the online removal ledger is missing; the restored database must not serve traffic")
	}
	return l.removals.ApplySubjectRemovalRecords(ctx, records)
}

// AppliedRemovalLedger returns the removal ledger that is applied in the
// database.
func (l postgresRemovalLedger) AppliedRemovalLedger(ctx context.Context) (backup.AppliedRemovalLedger, error) {
	available, err := l.available(ctx)
	if err != nil {
		return backup.AppliedRemovalLedger{}, err
	}
	if !available {
		return backup.AppliedRemovalLedger{}, nil
	}
	return l.removals.AppliedRemovalLedger(ctx)
}

// ApplyRemovalRecords replays the online removal ledger after a restore.
//
// The replay is the privacy service, so the restored rows are removed exactly
// as the original removal removed them.
//
// A ledger that cannot be read is an error, never an empty ledger: a restore
// that cannot apply its removals must not report that it applied them.
func (l postgresRemovalLedger) ApplyRemovalRecords(ctx context.Context, records []backup.RemovalRecord) error {
	if len(records) == 0 {
		return nil
	}
	available, err := l.available(ctx)
	if err != nil {
		return err
	}
	if !available {
		return errors.New("the online removal ledger is missing; the restored database must not serve traffic")
	}
	return l.removals.ApplyRemovalRecords(ctx, records)
}

// postgresLedger reads and reapplies the durable deletion ledger.
type postgresLedger struct {
	pool *pgxpool.Pool
}

func (l postgresLedger) ListTombstones(ctx context.Context) ([]backup.Tombstone, error) {
	rows, err := l.pool.Query(ctx, `SELECT game_id,owner_id,deleted_at,last_revision,last_epoch FROM deletion_tombstones ORDER BY game_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var entries []backup.Tombstone
	for rows.Next() {
		var entry backup.Tombstone
		if err = rows.Scan(&entry.GameID, &entry.OwnerID, &entry.DeletedAt, &entry.LastRevision, &entry.LastEpoch); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

// ApplyTombstones writes each ledger entry first, then removes live payload,
// so restoring an older export cannot resurrect a deleted game. The whole
// ledger is applied in one transaction and is idempotent.
func (l postgresLedger) ApplyTombstones(ctx context.Context, entries []backup.Tombstone) error {
	if len(entries) == 0 {
		return nil
	}
	tx, err := l.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, entry := range entries {
		if _, err = tx.Exec(ctx, `INSERT INTO deletion_tombstones(game_id,owner_id,deleted_at,last_revision,last_epoch) VALUES($1,$2,$3,$4,$5)
ON CONFLICT (game_id) DO UPDATE SET deleted_at=GREATEST(deletion_tombstones.deleted_at,EXCLUDED.deleted_at),last_revision=GREATEST(deletion_tombstones.last_revision,EXCLUDED.last_revision),last_epoch=GREATEST(deletion_tombstones.last_epoch,EXCLUDED.last_epoch)`, entry.GameID, entry.OwnerID, entry.DeletedAt, entry.LastRevision, entry.LastEpoch); err != nil {
			return err
		}
		statements := []struct {
			query string
			epoch bool
		}{
			{`DELETE FROM archive_chunks WHERE game_id=$1`, false},
			{`DELETE FROM archive_events WHERE game_id=$1`, false},
			{`UPDATE operations SET result_json='{}'::bytea,request_hash=decode(repeat('00',32),'hex') WHERE game_id=$1`, false},
			{`UPDATE games SET deleted_at=COALESCE(deleted_at,$2),ownership_epoch=GREATEST(ownership_epoch,$3),checkpoint_json='{}'::bytea,updated_at=now() WHERE game_id=$1`, true},
		}
		for _, statement := range statements {
			if statement.epoch {
				_, err = tx.Exec(ctx, statement.query, entry.GameID, entry.DeletedAt, entry.LastEpoch)
			} else {
				_, err = tx.Exec(ctx, statement.query, entry.GameID)
			}
			if err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}
