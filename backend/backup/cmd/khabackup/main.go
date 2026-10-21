// Command khabackup seals, verifies, rotates and restores encrypted logical
// exports of the owner-only PostgreSQL storage schema.
//
// Everything it needs is local and free: a PostgreSQL client install
// (pg_dump/pg_restore), a private directory for the encrypted bundles and one
// operator passphrase. It never provisions anything, never contacts a hosted
// provider, never prints a connection string or a passphrase, and never applies
// a restore or a rotation without an explicit --apply.
//
// Usage:
//
//	khabackup create  --out FILE (--class daily|weekly) --database-url-env NAME --passphrase-env NAME [--pg-dump PATH]
//	khabackup verify  --file FILE --passphrase-env NAME
//	khabackup inspect --file FILE
//	khabackup plan    --file FILE --database-url-env NAME --passphrase-env NAME [--newer-ledger FILE ...]
//	khabackup restore --file FILE --database-url-env NAME --passphrase-env NAME [--newer-ledger FILE ...] [--takeover] --apply
//	khabackup recover --file FILE --restore-id ID --database-url-env NAME --passphrase-env NAME [--newer-ledger FILE ...]
//	khabackup recover --evidence FILE --restore-id ID --database-url-env NAME
//	khabackup rotate  --dir DIR [--daily N] [--weekly N] [--protect LABEL ...] [--apply]
//	khabackup ledger  --file FILE [--file FILE ...] --passphrase-env NAME
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintf(os.Stderr, "khabackup: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, arguments []string) error {
	if len(arguments) == 0 {
		return errors.New("a command is required: create, verify, inspect, plan, restore, rotate or ledger")
	}
	switch arguments[0] {
	case "create":
		return createCommand(ctx, arguments[1:])
	case "verify":
		return verifyCommand(arguments[1:])
	case "inspect":
		return inspectCommand(arguments[1:])
	case "plan":
		return planCommand(ctx, arguments[1:])
	case "restore":
		return restoreCommand(ctx, arguments[1:])
	case "recover":
		return recoverCommand(ctx, arguments[1:])
	case "rotate":
		return rotateCommand(arguments[1:])
	case "ledger":
		return ledgerCommand(arguments[1:])
	case "help", "-h", "--help":
		fmt.Println(strings.TrimSpace(`
khabackup seals, verifies, rotates and restores encrypted PostgreSQL exports.

  create  --out FILE (--class daily|weekly) --database-url-env NAME --passphrase-env NAME
  verify  --file FILE --passphrase-env NAME
  inspect --file FILE
  plan    --file FILE --database-url-env NAME --passphrase-env NAME [--newer-ledger FILE ...]
  restore --file FILE --database-url-env NAME --passphrase-env NAME [--newer-ledger FILE ...] [--takeover] --apply
  recover --file FILE --restore-id ID --database-url-env NAME --passphrase-env NAME [--newer-ledger FILE ...]
  recover --evidence FILE --restore-id ID --database-url-env NAME
  rotate  --dir DIR [--daily N] [--weekly N] [--protect LABEL ...] [--apply]
  ledger  --file FILE [--file FILE ...] --passphrase-env NAME

The --fence path is the parent directory of the durable restore fence. The
operator prepares that directory; the restore creates the lock directory
inside it, and the service reads it.

The --evidence path is the durable evidence of a restore: the file the restore
wrote next to the fence, restored from the protected backup of the evidence
directory. A recovery that is given the evidence of a restore does not need the
bundle of the restore, and the bundle is only read when there is no evidence
at all.

Secrets are read only from the environment variable named by --passphrase-env
and --database-url-env. Nothing is provisioned and no network service is used.`))
		return nil
	default:
		return fmt.Errorf("unknown command %q", arguments[0])
	}
}

type commonFlags struct {
	file           string
	directory      string
	out            string
	class          string
	databaseURLEnv string
	passphraseEnv  string
	pgDump         string
	psql           string
	newerLedgers   stringList
	protect        stringList
	daily          int
	weekly         int
	apply          bool
	// restoreID names the restore a recovery acts on.
	restoreID string
	// takeover continues the lifecycle of a restore that crashed.
	takeover bool
	// fence is the path of the durable restore fence.
	fence string
	// evidence is the durable evidence of a restore that the operator
	// restored from the protected backup of the evidence directory.
	evidence string
	asJSON   bool
}

type stringList []string

func (l *stringList) String() string { return strings.Join(*l, ",") }
func (l *stringList) Set(value string) error {
	*l = append(*l, value)
	return nil
}

func parseFlags(name string, arguments []string, configure func(*flag.FlagSet, *commonFlags)) (commonFlags, error) {
	var options commonFlags
	set := flag.NewFlagSet(name, flag.ContinueOnError)
	set.StringVar(&options.file, "file", "", "encrypted bundle to read")
	set.StringVar(&options.directory, "dir", "", "directory holding bundles")
	set.StringVar(&options.out, "out", "", "bundle path to create")
	set.StringVar(&options.class, "class", "daily", "rotation class: daily or weekly")
	set.StringVar(&options.databaseURLEnv, "database-url-env", "DATABASE_URL", "environment variable holding the PostgreSQL URL")
	set.StringVar(&options.passphraseEnv, "passphrase-env", "KHA_BACKUP_PASSPHRASE", "environment variable holding the operator passphrase")
	set.StringVar(&options.pgDump, "pg-dump", defaultBinary("pg_dump"), "path to pg_dump")
	set.StringVar(&options.psql, "psql", defaultBinary("psql"), "path to psql, which loads the plain-text export in one transaction")
	set.Var(&options.newerLedgers, "newer-ledger", "newer bundle whose deletion ledger is reapplied (repeatable)")
	set.Var(&options.protect, "protect", "rotation label that is never pruned (repeatable)")
	set.IntVar(&options.daily, "daily", backup.DefaultDailyCopies, "daily copies to keep")
	set.IntVar(&options.weekly, "weekly", backup.DefaultWeeklyCopies, "weekly copies to keep")
	set.BoolVar(&options.apply, "apply", false, "actually apply the plan; without it nothing is written or deleted")
	set.StringVar(&options.restoreID, "restore-id", "", "identifier of the restore a recovery acts on")
	set.BoolVar(&options.takeover, "takeover", false, "continue the lifecycle of a restore that crashed: the marker of the crashed restore is replaced, the bundle is imported again and the removal ledger is applied again")
	set.StringVar(&options.fence, "fence", os.Getenv("ONLINE_RESTORE_FENCE_PATH"), "parent directory of the durable restore fence; the restore creates the lock directory inside it and the service refuses to serve while it is open (defaults to ONLINE_RESTORE_FENCE_PATH)")
	set.StringVar(&options.evidence, "evidence", "", "durable evidence of a restore (the file the restore wrote next to the fence); it proves the removal ledger a gate waits for when the evidence directory was lost")
	set.BoolVar(&options.asJSON, "json", false, "print a machine-readable report")
	if configure != nil {
		configure(set, &options)
	}
	if err := set.Parse(arguments); err != nil {
		return options, err
	}
	return options, nil
}

// passphrase reads the operator passphrase from the named environment variable.
// The value is never logged, never included in an error and never persisted.
func passphrase(name string) ([]byte, error) {
	if name == "" {
		return nil, errors.New("--passphrase-env is required")
	}
	value, present := os.LookupEnv(name)
	if !present || value == "" {
		return nil, fmt.Errorf("environment variable %s is not set; the passphrase is never read from a file or an argument", name)
	}
	return []byte(value), nil
}

// databaseURL reads the PostgreSQL URL from the named environment variable.
func databaseURL(name string) (string, map[string]string, error) {
	if name == "" {
		return "", nil, errors.New("--database-url-env is required")
	}
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", nil, fmt.Errorf("environment variable %s is not set", name)
	}
	connections, err := dsnEnv(value)
	if err != nil {
		return "", nil, err
	}
	return value, connections, nil
}

func openPool(ctx context.Context, url string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, errors.New("database pool could not be created")
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, errors.New("database is unavailable")
	}
	return pool, nil
}

// recoverCommand releases the gate of a restore that crashed after its
// removal ledger was applied.
//
// The recovery is identity bound: the restore is named, the removal ledger
// that is applied in the database has to be the ledger of the bundle and of
// the newer rotation copies, and a wrong clear is refused.
//
// The ledger of the restore is the durable evidence of the restore, and the
// evidence is what the recovery uses. The bundle and the rotation copies are
// the fallback for a restore that left no evidence: they are the ledger of the
// bundle, and the recovery refuses them when the fence of the restore names
// another ledger.
func recoverCommand(ctx context.Context, arguments []string) error {
	options, err := parseFlags("recover", arguments, nil)
	if err != nil {
		return err
	}
	if options.restoreID == "" {
		return errors.New("--restore-id is required")
	}
	if options.fence == "" {
		return errors.New("a recovery needs the durable restore fence; set --fence or ONLINE_RESTORE_FENCE_PATH")
	}
	if options.file == "" && options.evidence == "" {
		return errors.New("a recovery needs the durable evidence of the restore (--evidence) or the bundle of the restore (--file)")
	}

	url, connections, err := databaseURL(options.databaseURLEnv)
	if err != nil {
		return err
	}
	pool, err := openPool(ctx, url)
	if err != nil {
		return err
	}
	defer pool.Close()
	_ = connections
	removals, err := openRemovalLedger(ctx, pool, options.fence)
	if err != nil {
		return err
	}
	// The removal ledger the restore had to apply is the durable evidence of
	// the restore. It survives the crash of the restore and the import of its
	// bundle, so the recovery can name the ledger even when the removals it
	// covers are not in the database any more.
	//
	// The recovery is identity bound: the ledger it is given has to be the
	// ledger the fence of the restore names, and the recovery refuses every
	// other one. The proof of a gate whose evidence is gone is the same
	// ledger, and the recovery applies it under the ownership of the
	// lifecycle, never outside it.
	required, found, err := removals.RestoreRequirement(options.restoreID)
	if err != nil {
		return err
	}
	if options.evidence != "" {
		// The operator handed a file to the recovery, so the file is opened
		// and validated, even when the evidence directory still holds a record
		// of the restore: a file that names another restore, that does not
		// match its own digest or that conflicts with the record of the
		// directory is refused instead of being ignored.
		record, err := privacy.ReadRemovalRequirement(options.evidence)
		if err != nil {
			return fmt.Errorf("the durable evidence of the restore cannot be read: %w", err)
		}
		if record.RestoreID != options.restoreID {
			return fmt.Errorf("the durable evidence names the restore %q, not %q", record.RestoreID, options.restoreID)
		}
		if found {
			directory := fmt.Sprintf("%x", backup.RemovalLedgerDigest(required.Matches, required.Subjects))
			supplied := fmt.Sprintf("%x", backup.RemovalLedgerDigest(record.Matches, record.Subjects))
			if directory != supplied {
				return errors.New("the durable evidence of the restore conflicts with the record of the evidence directory")
			}
		}
		required = record.Ledger()
		found = true
	}
	if !found {
		// The restore left no evidence, so the ledger of the bundle and of the
		// newer rotation copies is the only description of what it owed. The
		// recovery refuses them when the fence of the restore names another
		// ledger.
		//
		// The bundle is only read here, so the passphrase is only needed here:
		// a recovery that is given the evidence of a restore needs neither
		// the bundle nor the passphrase.
		secret, err := passphrase(options.passphraseEnv)
		if err != nil {
			return err
		}
		defer clear(secret)
		verified, err := backup.Verify(options.file, secret)
		if err != nil {
			return err
		}
		merged, err := backup.MergeRemovalLedgers(verified.Payload.Removals, nil)
		if err != nil {
			return err
		}
		newerRemovals, newerSubjects, err := backup.CollectRemovalLedgers(options.newerLedgers, secret)
		if err != nil {
			return err
		}
		if merged, err = backup.MergeRemovalLedgers(merged, newerRemovals); err != nil {
			return err
		}
		mergedSubjects, err := backup.MergeSubjectRemovalLedgers(verified.Payload.SubjectRemovals, newerSubjects)
		if err != nil {
			return err
		}
		required = backup.AppliedRemovalLedger{Matches: merged, Subjects: mergedSubjects}
	}
	if err = removals.RecoverRestore(ctx, options.restoreID, required); err != nil {
		if errors.Is(err, privacy.ErrLedgerNotApplied) {
			// The removals of the restore are not applied in the database: the
			// gate of the crashed restore stays closed, so the service does not
			// serve, and the restore has to be run again.
			return fmt.Errorf("the removal ledger of the restore is not applied in the database; the service stays closed and the restore has to be run again: %w", err)
		}
		if errors.Is(err, privacy.ErrFenceLive) {
			return fmt.Errorf("a restore holds the restore fence; the recovery never touches the fence of a running restore: %w", err)
		}
		if errors.Is(err, privacy.ErrFenceConflict) {
			return fmt.Errorf("the restore fence belongs to another restore; the recovery never touches it: %w", err)
		}
		return err
	}
	// The truth of the recovery: whether the service may serve and how many
	// gates still wait for their removal ledger. A gate that waits keeps the
	// service closed, so the recovery never claims that the service serves
	// while one of them waits.
	allowed, err := removals.ServingAllowed(ctx)
	if err != nil {
		return err
	}
	pending, err := removals.PendingRestoreGates(ctx)
	if err != nil {
		return err
	}
	report := map[string]any{
		"command":        "recover",
		"recovered":      true,
		"restoreId":      options.restoreID,
		"servingAllowed": allowed,
		"pendingGates":   pending,
	}
	return emit(options.asJSON, report, func() {
		if allowed {
			fmt.Printf("recovered the restore %s; the service may serve traffic again\n", options.restoreID)
			return
		}
		fmt.Printf("recovered the restore %s; the service stays closed: %d restore gate(s) still wait for their removal ledger\n", options.restoreID, pending)
	})
}

func createCommand(ctx context.Context, arguments []string) error {
	options, err := parseFlags("create", arguments, nil)
	if err != nil {
		return err
	}
	if options.out == "" {
		return errors.New("--out is required")
	}
	secret, err := passphrase(options.passphraseEnv)
	if err != nil {
		return err
	}
	defer clear(secret)
	url, connections, err := databaseURL(options.databaseURLEnv)
	if err != nil {
		return err
	}
	pool, err := openPool(ctx, url)
	if err != nil {
		return err
	}
	defer pool.Close()

	now := time.Now().UTC()
	label := backup.DailyLabel(now)
	if options.class == "weekly" {
		label = backup.WeeklyLabel(now)
	} else if options.class != "daily" {
		return fmt.Errorf("--class must be daily or weekly, not %q", options.class)
	}
	tools := pgTools{dumpBinary: options.pgDump, loaderBinary: options.psql, environment: childEnvironment(connections)}
	removals, err := openRemovalLedger(ctx, pool, options.fence)
	if err != nil {
		return err
	}
	manifest, err := backup.Create(ctx, backup.CreateRequest{
		Path:       options.out,
		Label:      label,
		Passphrase: secret,
		CreatedAt:  now,
		Dumper:     tools,
		Tombstones: postgresLedger{pool: pool},
		Removals:   removals,
	})
	if err != nil {
		return err
	}
	return emit(options.asJSON, manifestReport(manifest), func() {
		fmt.Printf("sealed %s\n  label %s (%s)\n  created %s\n  tool %s\n  tombstones %d\n  removals %d\n  plaintext sha256 %s\n  bytes %d\n",
			options.out, manifest.Label, options.class, manifest.CreatedAt.Format(time.RFC3339), manifest.DumpTool,
			manifest.TombstoneCount, manifest.RemovalCount, manifest.PlaintextSHA256, manifest.PlaintextBytes)
	})
}

// openRemovalLedger opens the online removal ledger of a database.
//
// The ledger is optional: a database without the online tables has no
// removals, and the private single-owner backup tooling keeps working.
func openRemovalLedger(ctx context.Context, pool *pgxpool.Pool, fencePath string) (postgresRemovalLedger, error) {
	removals, err := privacy.Open(ctx, pool, nil, privacy.Options{FencePath: fencePath})
	if err != nil {
		return postgresRemovalLedger{}, err
	}
	return postgresRemovalLedger{pool: pool, removals: removals}, nil
}

func verifyCommand(arguments []string) error {
	options, err := parseFlags("verify", arguments, nil)
	if err != nil {
		return err
	}
	if options.file == "" {
		return errors.New("--file is required")
	}
	secret, err := passphrase(options.passphraseEnv)
	if err != nil {
		return err
	}
	defer clear(secret)
	verified, err := backup.Verify(options.file, secret)
	if err != nil {
		return err
	}
	report := manifestReport(verified.Manifest)
	report["verified"] = true
	report["sqlBytes"] = verified.SQLBytes
	return emit(options.asJSON, report, func() {
		fmt.Printf("verified %s\n  label %s\n  created %s\n  tool %s\n  tombstones %d\n  plaintext sha256 %s\n  export bytes %d\n",
			options.file, verified.Manifest.Label, verified.Manifest.CreatedAt.Format(time.RFC3339), verified.Manifest.DumpTool,
			verified.Manifest.TombstoneCount, verified.Manifest.PlaintextSHA256, verified.SQLBytes)
	})
}

func inspectCommand(arguments []string) error {
	options, err := parseFlags("inspect", arguments, nil)
	if err != nil {
		return err
	}
	if options.file == "" {
		return errors.New("--file is required")
	}
	manifest, err := backup.ReadManifest(options.file)
	if err != nil {
		return err
	}
	return emit(options.asJSON, manifestReport(manifest), func() {
		fmt.Printf("%s\n  label %s\n  created %s\n  tool %s\n  cipher %s/%s (%d iterations)\n  tombstones %d\n  plaintext sha256 %s\n",
			options.file, manifest.Label, manifest.CreatedAt.Format(time.RFC3339), manifest.DumpTool,
			manifest.Cipher.Algorithm, manifest.Cipher.KDF, manifest.Cipher.Iterations, manifest.TombstoneCount, manifest.PlaintextSHA256)
	})
}

func planCommand(ctx context.Context, arguments []string) error {
	options, err := parseFlags("plan", arguments, nil)
	if err != nil {
		return err
	}
	if options.file == "" {
		return errors.New("--file is required")
	}
	secret, err := passphrase(options.passphraseEnv)
	if err != nil {
		return err
	}
	defer clear(secret)
	url, _, err := databaseURL(options.databaseURLEnv)
	if err != nil {
		return err
	}
	pool, err := openPool(ctx, url)
	if err != nil {
		return err
	}
	defer pool.Close()
	newer, err := backup.CollectLedgers(options.newerLedgers, secret)
	if err != nil {
		return err
	}
	ledgers := [][]backup.Tombstone(nil)
	if len(options.newerLedgers) > 0 {
		ledgers = append(ledgers, newer)
	}
	plan, err := backup.PlanRestore(ctx, options.file, secret, postgresLedger{pool: pool}, ledgers)
	if err != nil {
		return err
	}
	report := map[string]any{
		"command":        "plan",
		"applied":        false,
		"manifest":       manifestReport(plan.Manifest),
		"sqlBytes":       plan.SQLBytes,
		"recovery":       plan.Recovery,
		"recoveryCounts": plan.RecoveryCounts,
	}
	return emit(options.asJSON, report, func() {
		printPlan(plan)
		fmt.Println("plan only: nothing was written. Re-run restore with --apply to execute it.")
	})
}

func restoreCommand(ctx context.Context, arguments []string) error {
	options, err := parseFlags("restore", arguments, nil)
	if err != nil {
		return err
	}
	if options.file == "" {
		return errors.New("--file is required")
	}
	secret, err := passphrase(options.passphraseEnv)
	if err != nil {
		return err
	}
	defer clear(secret)
	url, connections, err := databaseURL(options.databaseURLEnv)
	if err != nil {
		return err
	}
	newer, err := backup.CollectLedgers(options.newerLedgers, secret)
	if err != nil {
		return err
	}
	// The newer rotation copies carry the online removal ledgers as well. The
	// deletion tombstones and the online removals are two different ledgers,
	// and a restore has to replay both of them.
	newerRemovals, newerSubjectRemovals, err := backup.CollectRemovalLedgers(options.newerLedgers, secret)
	if err != nil {
		return err
	}
	pool, err := openPool(ctx, url)
	if err != nil {
		return err
	}
	defer pool.Close()
	tools := pgTools{dumpBinary: options.pgDump, loaderBinary: options.psql, environment: childEnvironment(connections)}
	removals, err := openRemovalLedger(ctx, pool, options.fence)
	if err != nil {
		return err
	}
	request := backup.RestoreRequest{Path: options.file, Passphrase: secret, Restorer: tools, Tombstones: postgresLedger{pool: pool}, Removals: removals, AdmissionFence: removals, Takeover: options.takeover}
	if len(options.newerLedgers) > 0 {
		request.NewerLedgers = append(request.NewerLedgers, newer)
		request.NewerRemovalLedgers = append(request.NewerRemovalLedgers, newerRemovals)
		request.NewerSubjectRemovalLedgers = append(request.NewerSubjectRemovalLedgers, newerSubjectRemovals)
	}
	if !options.apply {
		plan, planErr := backup.PlanRestore(ctx, options.file, secret, postgresLedger{pool: pool}, request.NewerLedgers)
		if planErr != nil {
			return planErr
		}
		printPlan(plan)
		return errors.New("restore refused without --apply; no database change was made")
	}
	// The durable fence is written before the import touches the database.
	//
	// The fence lives outside the restored database, so it survives the schema
	// replacement and a crash of this process. A restore that dies between the
	// import and the replay of the removal ledger therefore leaves the service
	// closed, instead of a restored database that lost the newest removals.
	//
	// A restore without a configured fence is refused: the fence is the only
	// control that survives the schema replacement, and a restore without it
	// could leave a served database with a lost removal.
	if options.fence == "" {
		return errors.New("a restore needs a durable restore fence; set --fence or ONLINE_RESTORE_FENCE_PATH")
	}
	verified, err := backup.Verify(options.file, secret)
	if err != nil {
		return err
	}
	merged, err := backup.MergeRemovalLedgers(verified.Payload.Removals, nil)
	if err != nil {
		return err
	}
	for _, set := range request.NewerRemovalLedgers {
		if merged, err = backup.MergeRemovalLedgers(merged, set); err != nil {
			return err
		}
	}
	mergedSubjects, err := backup.MergeSubjectRemovalLedgers(verified.Payload.SubjectRemovals, nil)
	if err != nil {
		return err
	}
	for _, set := range request.NewerSubjectRemovalLedgers {
		if mergedSubjects, err = backup.MergeSubjectRemovalLedgers(mergedSubjects, set); err != nil {
			return err
		}
	}
	restoreID := "restore-" + time.Now().UTC().Format("20060102T150405Z") + "-" + randomSuffix()
	// The restore owns the fence: it opens it before the import and closes it
	// after the removal ledger was replayed and verified.
	request.RestoreID = restoreID
	result, err := backup.Restore(ctx, request)
	if err != nil {
		// The fence stays open: the restored data must not serve traffic
		// before the removal ledger was replayed.
		return err
	}
	if len(result.RemovalsPending) > 0 {
		// The removals were not applied, so the restored database must not
		// serve traffic. The fence stays open and the service refuses to
		// start while the removal ledger is not applied.
		return fmt.Errorf("the online removal ledger has %d records that were not applied; the restored database must not serve traffic", len(result.RemovalsPending))
	}
	// The restore is recorded and the gate is released only after the removal
	// ledger was replayed and the replay was verified.
	//
	// The verification is the required union of the bundle and the newer
	// rotation copies: the applied ledger has to hold every one of them. The
	// restore itself performs the check before it closes the fence, so a
	// ledger that was not applied keeps the fence open and the service
	// closed.
	applied, err := removals.AppliedRemovalLedger(ctx)
	if err != nil {
		return err
	}
	required := backup.AppliedRemovalLedger{Matches: merged, Subjects: mergedSubjects}
	if !backup.RemovalLedgerContains(applied, required) {
		return fmt.Errorf("the applied removal ledger is not the ledger of the restore")
	}
	report := map[string]any{
		"command":                "restore",
		"applied":                true,
		"manifest":               manifestReport(result.Manifest),
		"sqlBytes":               result.SQLBytes,
		"recovery":               result.Recovery,
		"recoveryCounts":         result.RecoveryCounts,
		"tombstonesApplied":      result.TombstonesApplied,
		"tombstonesKept":         result.TombstonesKept,
		"removalsApplied":        result.RemovalsApplied,
		"subjectRemovalsApplied": result.SubjectRemovalsApplied,
		"restoreId":              restoreID,
	}
	return emit(options.asJSON, report, func() {
		printPlan(result.RestorePlan)
		fmt.Printf("restored; deletion ledger reapplied for %d games (%d already honoured)\n", result.TombstonesApplied, result.TombstonesKept)
		fmt.Printf("restored; online removal ledger replayed for %d shared games\n", result.RemovalsApplied)
		fmt.Printf("restored; subject removal ledger replayed for %d removed subjects\n", result.SubjectRemovalsApplied)
	})
}

func rotateCommand(arguments []string) error {
	options, err := parseFlags("rotate", arguments, nil)
	if err != nil {
		return err
	}
	if options.directory == "" {
		return errors.New("--dir is required")
	}
	entries, err := os.ReadDir(options.directory)
	if err != nil {
		return err
	}
	protected := map[string]bool{}
	for _, label := range options.protect {
		protected[label] = true
	}
	var candidates []backup.Candidate
	var unreadable []string
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".kha") {
			continue
		}
		path := filepath.Join(options.directory, entry.Name())
		manifest, manifestErr := backup.ReadManifest(path)
		if manifestErr != nil {
			unreadable = append(unreadable, entry.Name())
			continue
		}
		info, statErr := entry.Info()
		var size int64
		if statErr == nil {
			size = info.Size()
		}
		candidates = append(candidates, backup.Candidate{
			Path:      path,
			Label:     manifest.Label,
			CreatedAt: manifest.CreatedAt,
			Bytes:     size,
			Protected: protected[manifest.Label],
		})
	}
	policy := backup.RetentionPolicy{Daily: options.daily, Weekly: options.weekly}
	plan, err := backup.PlanRotation(candidates, time.Now().UTC(), policy)
	if err != nil {
		return err
	}
	deleted := []string{}
	if options.apply {
		for _, item := range plan.Prune {
			if removeErr := os.Remove(item.Path); removeErr != nil {
				return fmt.Errorf("prune %s: %w", item.Path, removeErr)
			}
			deleted = append(deleted, item.Path)
		}
	}
	sort.Strings(deleted)
	report := map[string]any{
		"command":       "rotate",
		"applied":       options.apply,
		"policy":        plan.Policy,
		"keep":          plan.Keep,
		"prune":         plan.Prune,
		"prunableBytes": plan.PrunableBytes,
		"deleted":       deleted,
		"unreadable":    unreadable,
	}
	return emit(options.asJSON, report, func() {
		fmt.Printf("retention: %d daily, %d weekly\n", plan.Policy.Daily, plan.Policy.Weekly)
		for _, item := range plan.Keep {
			fmt.Printf("  keep  %-18s %s\n", item.Label, item.Reason)
		}
		for _, item := range plan.Prune {
			fmt.Printf("  prune %-18s %s\n", item.Label, item.Reason)
		}
		for _, name := range unreadable {
			fmt.Printf("  unreadable %s (not planned, not deleted)\n", name)
		}
		if options.apply {
			fmt.Printf("deleted %d bundle(s)\n", len(deleted))
		} else {
			fmt.Println("plan only: nothing was deleted. Re-run with --apply to prune.")
		}
	})
}

func ledgerCommand(arguments []string) error {
	options, err := parseFlags("ledger", arguments, nil)
	if err != nil {
		return err
	}
	if options.file == "" {
		return errors.New("--file is required at least once")
	}
	secret, err := passphrase(options.passphraseEnv)
	if err != nil {
		return err
	}
	defer clear(secret)
	paths := options.newerLedgers
	if options.file != "" {
		paths = append([]string{options.file}, paths...)
	}
	merged, err := backup.CollectLedgers(paths, secret)
	if err != nil {
		return err
	}
	report := map[string]any{"command": "ledger", "bundles": paths, "tombstones": merged, "count": len(merged)}
	return emit(options.asJSON, report, func() {
		for _, entry := range merged {
			fmt.Printf("%s deleted %s revision %d epoch %d\n", entry.GameID, entry.DeletedAt.Format(time.RFC3339), entry.LastRevision, entry.LastEpoch)
		}
		fmt.Printf("%d deletion(s) across %d bundle(s)\n", len(merged), len(paths))
	})
}

func printPlan(plan backup.RestorePlan) {
	fmt.Printf("restore candidate\n  label %s\n  created %s\n  export bytes %d\n  tombstones %d (apply %d, refresh %d, keep %d)\n",
		plan.Manifest.Label, plan.Manifest.CreatedAt.Format(time.RFC3339), plan.SQLBytes,
		plan.Manifest.TombstoneCount, plan.RecoveryCounts[backup.RecoveryApply], plan.RecoveryCounts[backup.RecoveryRefresh], plan.RecoveryCounts[backup.RecoveryKeep])
}

func manifestReport(manifest backup.Manifest) map[string]any {
	return map[string]any{
		"label":                 manifest.Label,
		"createdAt":             manifest.CreatedAt.Format(time.RFC3339),
		"dumpTool":              manifest.DumpTool,
		"schemaVersion":         manifest.SchemaVersion,
		"algorithm":             manifest.Cipher.Algorithm,
		"kdf":                   manifest.Cipher.KDF,
		"iterations":            manifest.Cipher.Iterations,
		"plaintextBytes":        manifest.PlaintextBytes,
		"plaintextSha256":       manifest.PlaintextSHA256,
		"tombstoneCount":        manifest.TombstoneCount,
		"tombstoneLedgerSha256": manifest.TombstoneLedgerSHA,
		"restoredFromLabel":     manifest.RestoredFrom,
	}
}

func emit(asJSON bool, report map[string]any, text func()) error {
	if asJSON {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(report)
	}
	text()
	return nil
}

// randomSuffix returns a short random suffix for a restore identifier.
//
// The suffix keeps two restores of the same second apart, so the restore
// identifiers are unique and the fence of one restore is never the fence of
// another.
func randomSuffix() string {
	raw := make([]byte, 6)
	if _, err := rand.Read(raw); err != nil {
		return "unknown"
	}
	return hex.EncodeToString(raw)
}

func defaultBinary(name string) string {
	if path, err := exec.LookPath(name); err == nil {
		return path
	}
	return name
}
