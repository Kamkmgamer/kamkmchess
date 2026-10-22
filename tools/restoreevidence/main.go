//go:build restoreevidence

// Command restoreevidence exercises the durable evidence of a restore and the
// refusal of a restore without a removal ledger sink.
//
// It is a helper of the operations proofs, and it uses the production code of
// the privacy service and of the backup library: it never restates the
// semantics of the fence, of the evidence or of the refusal. The build tag
// keeps it out of every production binary.
//
// The three modes are:
//
//	restoreevidence verify --evidence FILE --restore-id ID --digest HEX
//	restoreevidence stage  --fence PARENT --database-url-env NAME --restore-id ID
//	restoreevidence nosink --fence PARENT --database-url-env NAME --restore-id ID
//	                       --file BUNDLE --passphrase-env NAME [--takeover]
//
// The verify mode opens an evidence file with the production reader and
// reports whether it names the restore and the ledger of the marker. It never
// prints the content of the record: the record holds the one-way references of
// the removed subjects.
//
// The stage mode opens the fence of a restore that crashed after its removal
// ledger was replayed: it binds the removal ledger the database really holds
// to the lifecycle, writes the durable evidence of it and ends without closing
// the fence. The lifecycle is left exactly as a crash leaves it.
//
// The nosink mode calls the restore of the backup library without a removal
// ledger sink, against a real database and a real encrypted bundle, and
// reports how many times the importer ran. A restore that is refused before
// its import must not import anything.

package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
)

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, arguments []string) error {
	if len(arguments) == 0 {
		return errors.New("usage: restoreevidence verify|stage|nosink [options]")
	}
	switch arguments[0] {
	case "verify":
		return verifyCommand(ctx, arguments[1:])
	case "stage":
		return stageCommand(ctx, arguments[1:])
	case "nosink":
		return nosinkCommand(ctx, arguments[1:])
	default:
		return fmt.Errorf("unknown mode %q", arguments[0])
	}
}

// report prints the machine readable answer of the helper.
//
// The answer never holds the content of an evidence record and never holds a
// secret: it holds counts, names and verdicts.
func report(fields map[string]any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(fields)
}

// verifyCommand validates an evidence file with the production reader.
func verifyCommand(_ context.Context, arguments []string) error {
	set := flag.NewFlagSet("verify", flag.ContinueOnError)
	evidence := set.String("evidence", "", "the evidence file to open")
	restoreID := set.String("restore-id", "", "the restore the evidence has to name")
	digest := set.String("digest", "", "the digest of the removal ledger the marker names")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	if *evidence == "" || *restoreID == "" || *digest == "" {
		return errors.New("verify needs --evidence, --restore-id and --digest")
	}
	record, err := privacy.ReadRemovalRequirement(*evidence)
	if err != nil {
		return report(map[string]any{"valid": false, "reason": "the evidence cannot be read"})
	}
	if record.RestoreID != *restoreID {
		return report(map[string]any{"valid": false, "reason": "the evidence names another restore"})
	}
	if !strings.EqualFold(record.Digest, *digest) {
		return report(map[string]any{"valid": false, "reason": "the evidence names another removal ledger"})
	}
	return report(map[string]any{"valid": true, "reason": "the evidence names the restore and the removal ledger of the marker"})
}

// stageCommand opens the fence of a restore that crashed after the replay.
//
// The removal ledger the lifecycle binds is the one the database really
// holds, read with the production reader of the privacy service. The fence is
// left open: the helper ends without closing it, which is the state a crash
// leaves behind.
func stageCommand(ctx context.Context, arguments []string) error {
	set := flag.NewFlagSet("stage", flag.ContinueOnError)
	fence := set.String("fence", "", "the parent directory of the durable restore fence")
	databaseURLEnv := set.String("database-url-env", "DATABASE_URL", "environment variable holding the PostgreSQL URL")
	restoreID := set.String("restore-id", "", "the identifier of the restore that crashed")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	if *fence == "" || *restoreID == "" {
		return errors.New("stage needs --fence and --restore-id")
	}
	service, pool, err := openService(ctx, *databaseURLEnv, *fence)
	if err != nil {
		return err
	}
	defer pool.Close()
	applied, err := service.AppliedRemovalLedger(ctx)
	if err != nil {
		return fmt.Errorf("the applied removal ledger could not be read: %w", err)
	}
	digest := backup.RemovalLedgerDigest(applied.Matches, applied.Subjects)
	handle, err := service.BeginFence(*restoreID, false)
	if err != nil {
		return fmt.Errorf("the fence could not be opened: %w", err)
	}
	if err = handle.Bind(applied); err != nil {
		return fmt.Errorf("the removal ledger could not be bound to the fence: %w", err)
	}
	// The lifecycle is not closed: the helper ends here and the operating
	// system releases the lock of the lifecycle, which is exactly the state a
	// restore that crashed after its replay leaves behind.
	return report(map[string]any{
		"staged":    true,
		"restoreId": *restoreID,
		"digest":    hex.EncodeToString(digest),
		"matches":   len(applied.Matches),
		"subjects":  len(applied.Subjects),
		"boundary":  "the replay is applied and the fence of the lifecycle is open: the close of the restore never ran",
	})
}

// nosinkCommand calls the restore of the backup library without a removal
// ledger sink.
//
// The bundle is real, the database is real and the importer is the real psql,
// so the count of the imports is a measurement and not a claim. A restore that
// is refused before its import must not import anything, and the refusal has
// to be the refusal of the owed removals.
func nosinkCommand(ctx context.Context, arguments []string) error {
	set := flag.NewFlagSet("nosink", flag.ContinueOnError)
	fence := set.String("fence", "", "the parent directory of the durable restore fence")
	databaseURLEnv := set.String("database-url-env", "DATABASE_URL", "environment variable holding the PostgreSQL URL")
	passphraseEnv := set.String("passphrase-env", "KHA_BACKUP_PASSPHRASE", "environment variable holding the operator passphrase")
	restoreID := set.String("restore-id", "", "the identifier of the restore that is refused")
	bundle := set.String("file", "", "the encrypted bundle the restore reads")
	takeover := set.Bool("takeover", false, "continue the lifecycle of a restore that crashed")
	if err := set.Parse(arguments); err != nil {
		return err
	}
	if *fence == "" || *restoreID == "" || *bundle == "" {
		return errors.New("nosink needs --fence, --restore-id and --file")
	}
	secret, present := os.LookupEnv(*passphraseEnv)
	if !present || secret == "" {
		return fmt.Errorf("the environment variable %s is not set", *passphraseEnv)
	}
	password := []byte(secret)
	defer clear(password)
	url, err := databaseURL(*databaseURLEnv)
	if err != nil {
		return err
	}
	connections, err := libpqEnvironment(url)
	if err != nil {
		return err
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return errors.New("the database pool could not be created")
	}
	defer pool.Close()
	service, err := privacy.Open(ctx, pool, nil, privacy.Options{FencePath: *fence})
	if err != nil {
		return errors.New("the privacy service could not be opened")
	}
	importer := &countingRestorer{environment: childEnvironment(connections)}
	_, restoreErr := backup.Restore(ctx, backup.RestoreRequest{
		Path:           *bundle,
		Passphrase:     password,
		Restorer:       importer,
		Tombstones:     &postgresTombstones{pool: pool},
		Removals:       nil,
		AdmissionFence: &fenceAdapter{service: service},
		RestoreID:      *restoreID,
		Takeover:       *takeover,
	})
	answer := map[string]any{
		"imports": importer.imports,
		"refused": restoreErr != nil,
	}
	if restoreErr != nil {
		answer["error"] = restoreErr.Error()
		answer["ledgerConflict"] = errors.Is(restoreErr, backup.ErrLedgerConflict)
	}
	return report(answer)
}

// fenceAdapter is the admission control of the restore.
//
// The privacy service returns its own handle, and the library names its own
// interface, so the two are told apart here.
type fenceAdapter struct {
	service *privacy.Service
}

func (f *fenceAdapter) BeginFence(restoreID string, takeover bool) (backup.FenceHandle, error) {
	return f.service.BeginFence(restoreID, takeover)
}

func (f *fenceAdapter) PendingRemovalRequirements(ctx context.Context) (backup.AppliedRemovalLedger, error) {
	return f.service.PendingRemovalRequirements(ctx)
}

// countingRestorer is the real loader, with a counter.
//
// The loader is the real psql with the arguments of the production code, so
// the count of the imports is the count of the imports that really ran.
type countingRestorer struct {
	environment []string
	imports     int
}

func (r *countingRestorer) Restore(ctx context.Context, sql io.Reader) error {
	r.imports++
	arguments := []string{"-v", "ON_ERROR_STOP=1", "--single-transaction", "-q", "-f", "-"}
	command := exec.CommandContext(ctx, "psql", arguments...)
	command.Env = r.environment
	command.Stdin = sql
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		return fmt.Errorf("psql failed: %w", err)
	}
	return nil
}

// postgresTombstones is the durable deletion ledger of the database.
type postgresTombstones struct {
	pool *pgxpool.Pool
}

func (t *postgresTombstones) ListTombstones(ctx context.Context) ([]backup.Tombstone, error) {
	rows, err := t.pool.Query(ctx, `SELECT game_id,owner_id,deleted_at,last_revision,last_epoch FROM deletion_tombstones ORDER BY game_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []backup.Tombstone{}
	for rows.Next() {
		var entry backup.Tombstone
		if err = rows.Scan(&entry.GameID, &entry.OwnerID, &entry.DeletedAt, &entry.LastRevision, &entry.LastEpoch); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

func (t *postgresTombstones) ApplyTombstones(ctx context.Context, entries []backup.Tombstone) error {
	if len(entries) == 0 {
		return nil
	}
	tx, err := t.pool.Begin(ctx)
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

// openService opens the privacy service on the database of the environment
// variable.
func openService(ctx context.Context, databaseURLEnv, fence string) (*privacy.Service, *pgxpool.Pool, error) {
	url, err := databaseURL(databaseURLEnv)
	if err != nil {
		return nil, nil, err
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, nil, errors.New("the database pool could not be created")
	}
	service, err := privacy.Open(ctx, pool, nil, privacy.Options{FencePath: fence})
	if err != nil {
		pool.Close()
		return nil, nil, errors.New("the privacy service could not be opened")
	}
	return service, pool, nil
}

// databaseURL reads the PostgreSQL URL from the named environment variable.
func databaseURL(name string) (string, error) {
	if name == "" {
		return "", errors.New("--database-url-env is required")
	}
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", fmt.Errorf("the environment variable %s is not set", name)
	}
	return value, nil
}

// libpqEnvironment converts the PostgreSQL URL into libpq environment
// variables, so the connection string never appears in a command line, in a
// process listing or in an error message.
func libpqEnvironment(raw string) (map[string]string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, errors.New("the database URL is not a valid URL")
	}
	host := parsed.Hostname()
	if host == "" {
		return nil, errors.New("the database URL has no host")
	}
	database := strings.TrimPrefix(parsed.Path, "/")
	if database == "" {
		return nil, errors.New("the database URL has no database name")
	}
	connections := map[string]string{
		"PGHOST":            host,
		"PGDATABASE":        database,
		"PGUSER":            parsed.User.Username(),
		"PGSSLMODE":         "prefer",
		"PGCONNECT_TIMEOUT": "10",
		"PGAPPNAME":         "restoreevidence",
	}
	if password, set := parsed.User.Password(); set {
		connections["PGPASSWORD"] = password
	}
	if port := parsed.Port(); port != "" {
		connections["PGPORT"] = port
	}
	return connections, nil
}

// childEnvironment starts from an explicit minimal environment, so a stray
// PGPASSWORD in the shell of the operator cannot change what the loader
// connects to.
func childEnvironment(connections map[string]string) []string {
	environment := map[string]string{"PATH": os.Getenv("PATH")}
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
