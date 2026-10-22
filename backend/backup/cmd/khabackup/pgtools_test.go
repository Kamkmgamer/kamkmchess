package main

import (
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPendingRestoreEvidenceDoesNotRequireTheImportedDatabase(t *testing.T) {
	// Opening the service only binds the pool. The fence and evidence are
	// filesystem operations and must not query it, including during recovery.
	service, err := privacy.Open(t.Context(), &pgxpool.Pool{}, nil, privacy.Options{FencePath: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	handle, err := service.BeginFence("restore-pending-evidence", false)
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Release()
	required := backup.AppliedRemovalLedger{Subjects: []backup.SubjectRemovalRecord{{
		RecordID: "rs_pending", SubjectKind: "account", SubjectRef: "subject-reference",
		Scope: "explicit_removal", RemovedAt: time.Now().UTC(),
	}}}
	if err = handle.Bind(required); err != nil {
		t.Fatal(err)
	}
	// No SQL pool is available to the adapter. The owed ledger must still
	// survive and be returned to the next restore.
	ledger := postgresRemovalLedger{removals: service}
	got, err := ledger.PendingRemovalRequirements(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !backup.RemovalLedgerContains(got, required) {
		t.Fatal("the next restore lost the removals recorded outside the database")
	}
}

func TestDsnEnvKeepsTheConnectionStringOutOfArguments(t *testing.T) {
	connections, err := dsnEnv("postgres://kamkmchess:hunter2@db.example.internal:6543/kamkmchess?sslmode=require")
	if err != nil {
		t.Fatalf("dsnEnv: %v", err)
	}
	expected := map[string]string{
		"PGHOST":            "db.example.internal",
		"PGPORT":            "6543",
		"PGUSER":            "kamkmchess",
		"PGPASSWORD":        "hunter2",
		"PGDATABASE":        "kamkmchess",
		"PGSSLMODE":         "require",
		"PGCONNECT_TIMEOUT": "10",
		"PGAPPNAME":         "khabackup",
	}
	for key, want := range expected {
		if connections[key] != want {
			t.Fatalf("%s = %q, want %q", key, connections[key], want)
		}
	}
	environment := strings.Join(childEnvironment(connections), " ")
	if strings.Contains(environment, "postgres://") {
		t.Fatal("the child environment still carries the full connection string")
	}
	if !strings.Contains(environment, "PGPASSWORD=hunter2") {
		t.Fatal("the child environment is missing the parsed password")
	}
}

func TestDsnEnvRefusesAmbiguousConfiguration(t *testing.T) {
	for _, raw := range []string{
		"",
		"https://db.example.internal/kamkmchess",
		"postgres:///kamkmchess",
		"postgres://db.example.internal/",
		"postgres://db.example.internal/kamkmchess?options=-c%20search_path%3Dpublic",
		"postgres://db.example.internal/kamkmchess?sslmode=require&sslmode=disable",
	} {
		if _, err := dsnEnv(raw); err == nil {
			t.Fatalf("%q was accepted as a connection URL", raw)
		}
	}
}

func TestDsnEnvSupportsASearchPath(t *testing.T) {
	connections, err := dsnEnv("postgres://user:pw@localhost:5432/kamkmchess?search_path=kha_rehearsal&sslmode=disable")
	if err != nil {
		t.Fatalf("dsnEnv: %v", err)
	}
	if connections["PGOPTIONS"] != "-c search_path=kha_rehearsal" || connections["PGSSLMODE"] != "disable" {
		t.Fatalf("unexpected connection environment: %+v", connections)
	}
	if connections["PGPASSWORD"] != "pw" {
		t.Fatal("password was not parsed")
	}
}

func TestChildEnvironmentIsMinimalAndSorted(t *testing.T) {
	environment := childEnvironment(map[string]string{"PGHOST": "localhost"})
	joined := strings.Join(environment, "\n")
	if strings.Contains(joined, "PGPASSWORD") || strings.Contains(joined, "PGPASSFILE") {
		t.Fatalf("the child environment inherited a credential: %s", joined)
	}
	if len(environment) == 0 {
		t.Fatal("the child environment is empty; pg_dump could not run")
	}
	for index := 1; index < len(environment); index++ {
		if environment[index-1] > environment[index] {
			t.Fatalf("environment entries are not sorted: %v", environment)
		}
	}
}

func TestRunToolReportsMissingBinaryWithoutLeakingConfiguration(t *testing.T) {
	err := runTool(t.Context(), "", nil, nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "no PostgreSQL client binary") {
		t.Fatalf("unexpected error for a missing binary: %v", err)
	}
}
