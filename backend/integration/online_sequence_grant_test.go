package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// The grant of the sequence of the checkpoints.
//
// The order of the checkpoints comes from the default of the column, so the
// role that writes the health of the service needs the usage of the sequence
// and nothing else. The rules process holds no SQL privilege at all, so it
// can neither take the order nor write a checkpoint.
//
// The regression executes the **generated** grant SQL of the deployment, so it
// proves the grants the deployment really applies and not a hand-written
// approximation of them.
func TestOnlineTheRuntimeRoleCanWriteACheckpointWithTheOrderOfTheSequence(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	var schema string
	if err := fixture.pool.QueryRow(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	// The roles of this test are unique, so a run beside another one cannot
	// collide with them.
	suffix := randomSchemaSuffix()
	runtimeRole := "kha_test_runtime_" + suffix
	rulesRole := "kha_test_rules_" + suffix
	for _, role := range []string{runtimeRole, rulesRole} {
		if _, err := fixture.pool.Exec(ctx, `DROP ROLE IF EXISTS `+role); err != nil {
			t.Fatalf("drop the role %s: %v", role, err)
		}
		if _, err := fixture.pool.Exec(ctx, `CREATE ROLE `+role); err != nil {
			t.Fatalf("create the role %s: %v", role, err)
		}
		t.Cleanup(func() {
			_, _ = fixture.pool.Exec(context.Background(), `DROP ROLE IF EXISTS `+role)
		})
	}

	// The generated grant SQL of the deployment, with the schema of the test
	// in place of the schema of the policy.
	generated := generatedGrantSQL(t)
	var statements []string
	for _, line := range strings.Split(generated, "\n") {
		line = strings.TrimSpace(line)
		if !strings.Contains(line, "SEQUENCE") {
			continue
		}
		statements = append(statements, strings.ReplaceAll(line, "public.", schema+"."))
	}
	if len(statements) == 0 {
		t.Fatalf("the generated grant SQL carries no statement for the sequence of the checkpoints: %s", generated[:min(len(generated), 600)])
	}
	// The role of the deployment holds the privileges of the policy: the usage
	// of the sequence and the insert into the health table.
	if _, err := fixture.pool.Exec(ctx, `GRANT USAGE ON SCHEMA `+schema+` TO `+runtimeRole); err != nil {
		t.Fatalf("grant the schema: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `GRANT SELECT, INSERT ON TABLE `+schema+`.online_service_health TO `+runtimeRole); err != nil {
		t.Fatalf("grant the health table: %v", err)
	}
	for _, statement := range statements {
		// The statements of the deployment name the role of the policy; the
		// role of this test takes its place.
		statement = strings.ReplaceAll(statement, "kamkmchess_runtime", runtimeRole)
		if _, err := fixture.pool.Exec(ctx, statement); err != nil {
			t.Fatalf("the generated grant failed: %v (%s)", err, statement)
		}
	}

	runtime, err := fixture.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Release()
	if _, err = runtime.Exec(ctx, `SET ROLE `+runtimeRole); err != nil {
		t.Fatalf("become the runtime role: %v", err)
	}
	// The checkpoint takes its order from the default of the column.
	if _, err = runtime.Exec(ctx, `INSERT INTO online_service_health(checkpoint_id,dependency,state,detail,recorded_at) VALUES('chk-runtime-0001',$1,'healthy','the rules process answered',clock_timestamp())`, online.DependencyRules); err != nil {
		t.Fatalf("the runtime role cannot write a checkpoint: %v", err)
	}
	var order int64
	if err = runtime.QueryRow(ctx, `SELECT observation_order FROM online_service_health WHERE checkpoint_id='chk-runtime-0001'`).Scan(&order); err != nil {
		t.Fatal(err)
	}
	if order <= 0 {
		t.Fatalf("the order of the checkpoint = %d, want the order of the sequence", order)
	}
	// The policy grants the usage and nothing else, so the other privileges
	// of the sequence are absent.
	for _, privilege := range []string{"SELECT", "UPDATE"} {
		var held bool
		if err = runtime.QueryRow(ctx, `SELECT has_sequence_privilege($1,'online_service_health_order',$2)`, runtimeRole, privilege).Scan(&held); err != nil {
			t.Fatal(err)
		}
		if held {
			t.Fatalf("the runtime role holds %s on the sequence of the checkpoints, which the policy does not grant", privilege)
		}
	}
	if _, err = runtime.Exec(ctx, `RESET ROLE`); err != nil {
		t.Fatal(err)
	}

	// The rules process holds no SQL privilege: it can neither take the order
	// of the sequence nor write a checkpoint. It sees the schema, so its
	// refusal is the permission of the sequence and not the visibility of it.
	if _, err = fixture.pool.Exec(ctx, `GRANT USAGE ON SCHEMA `+schema+` TO `+rulesRole); err != nil {
		t.Fatalf("grant the schema to the rules role: %v", err)
	}
	rules, err := fixture.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rules.Release()
	if _, err = rules.Exec(ctx, `SET ROLE `+rulesRole); err != nil {
		t.Fatalf("become the rules role: %v", err)
	}
	if _, err = rules.Exec(ctx, `SELECT nextval('online_service_health_order')`); err == nil {
		t.Fatal("the rules role took the order of the sequence")
	} else {
		var denied *pgconn.PgError
		if !errors.As(err, &denied) || denied.Code != "42501" {
			t.Fatalf("the rules role failed to take the order with %v, want a permission refusal (42501)", err)
		}
	}
	if _, err = rules.Exec(ctx, `INSERT INTO online_service_health(checkpoint_id,dependency,state,detail,recorded_at) VALUES('chk-rules-0001',$1,'healthy','the rules process answered',clock_timestamp())`, online.DependencyRules); err == nil {
		t.Fatal("the rules role wrote a checkpoint")
	} else {
		var denied *pgconn.PgError
		if !errors.As(err, &denied) || denied.Code != "42501" {
			t.Fatalf("the rules role failed to write a checkpoint with %v, want a permission refusal (42501)", err)
		}
	}
}

// TestOnlineTheLiveAuditOfTheSequenceReadsTheEffectiveRights drives the live
// reading of the sequences of the deployment.
//
// The reading uses the catalogue of the database and the effective rights of
// the role, so it sees the privileges the role holds through PUBLIC and the
// privileges the policy does not grant. The baseline of the policy is clear,
// a drift of the sequence is a blocker, and a missing usage is a blocker.
func TestOnlineTheLiveAuditOfTheSequenceReadsTheEffectiveRights(t *testing.T) {
	// The live reading of the deployment uses the psql adapter, so the test
	// needs the client of the database.
	if _, err := exec.LookPath("psql"); err != nil {
		t.Skip("the live reading of the sequences needs the psql client of the database")
	}
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	var schema string
	if err := fixture.pool.QueryRow(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	suffix := randomSchemaSuffix()
	runtimeRole := "kha_test_runtime_" + suffix
	if _, err := fixture.pool.Exec(ctx, `CREATE ROLE `+runtimeRole); err != nil {
		t.Fatalf("create the role: %v", err)
	}
	t.Cleanup(func() {
		_, _ = fixture.pool.Exec(context.Background(), `DROP ROLE IF EXISTS `+runtimeRole)
	})
	if _, err := fixture.pool.Exec(ctx, `GRANT USAGE ON SCHEMA `+schema+` TO `+runtimeRole); err != nil {
		t.Fatalf("grant the schema: %v", err)
	}
	// The baseline of the policy: the usage of the sequence and nothing else.
	if _, err := fixture.pool.Exec(ctx, `GRANT USAGE ON SEQUENCE `+schema+`.online_service_health_order TO `+runtimeRole); err != nil {
		t.Fatalf("grant the sequence: %v", err)
	}
	read := func() (map[string][]string, []string) {
		output := runLiveSequenceAudit(t, fixture.pool.Config().ConnConfig, runtimeRole, schema)
		var result struct {
			Sequences map[string][]string `json:"sequences"`
			Blockers  []string            `json:"blockers"`
		}
		if err := json.Unmarshal(output, &result); err != nil {
			t.Fatalf("read the live audit: %v (%s)", err, output)
		}
		return result.Sequences, result.Blockers
	}
	sequences, blockers := read()
	if granted, ok := sequences["online_service_health_order"]; !ok || len(granted) != 1 || granted[0] != "USAGE" {
		t.Fatalf("the live rights of the sequence = %v, want the usage of the policy", sequences["online_service_health_order"])
	}
	if len(blockers) != 0 {
		t.Fatalf("the live audit of the baseline reports %v", blockers)
	}
	// A drift of the sequence is a blocker.
	if _, err := fixture.pool.Exec(ctx, `GRANT SELECT, UPDATE ON SEQUENCE `+schema+`.online_service_health_order TO `+runtimeRole); err != nil {
		t.Fatalf("grant the extra privileges: %v", err)
	}
	_, blockers = read()
	if !containsCode(blockers, "live-sequence-extra") {
		t.Fatalf("the live audit of the drift reports %v, want the extra privileges of the sequence", blockers)
	}
	// A missing usage is a blocker.
	if _, err := fixture.pool.Exec(ctx, `REVOKE ALL ON SEQUENCE `+schema+`.online_service_health_order FROM `+runtimeRole); err != nil {
		t.Fatalf("revoke the sequence: %v", err)
	}
	_, blockers = read()
	if !containsCode(blockers, "live-sequence-missing-privilege") {
		t.Fatalf("the live audit of the missing usage reports %v, want the missing usage of the sequence", blockers)
	}
}

// containsCode reports whether the findings carry a code.
func containsCode(codes []string, wanted string) bool {
	for _, code := range codes {
		if code == wanted {
			return true
		}
	}
	return false
}

// runLiveSequenceAudit reads the live rights of the sequences and audits them
// with the policy of the deployment.
func runLiveSequenceAudit(t *testing.T, config *pgx.ConnConfig, role, schema string) []byte {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(t.TempDir(), "live-sequence-audit.mjs")
	module := "file:///" + filepath.ToSlash(filepath.Join(root, "deploy", "runtime-grants.mjs"))
	body := "import { readFileSync } from 'node:fs';\n" +
		"import { auditLiveGrants, parsePolicy, readLiveSequenceGrants } from '" + module + "';\n" +
		"const [databaseUrl, psqlPath, role, schema, policyPath] = process.argv.slice(2);\n" +
		"const policy = parsePolicy(JSON.parse(readFileSync(policyPath, 'utf8')));\n" +
		"const sequences = await readLiveSequenceGrants(databaseUrl, psqlPath, role, schema);\n" +
		"const findings = auditLiveGrants(policy, new Map(), sequences);\n" +
		"const plain = Object.fromEntries([...sequences].map(([name, verbs]) => [name, [...verbs].sort()]));\n" +
		"process.stdout.write(JSON.stringify({ sequences: plain, blockers: findings.filter((finding) => finding.severity === 'blocker').map((finding) => finding.code) }));\n"
	if err := os.WriteFile(script, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	databaseURL := fmt.Sprintf("postgres://%s@%s:%d/%s?sslmode=disable", config.User, config.Host, config.Port, config.Database)
	command := exec.Command("node", script, databaseURL, "psql", role, schema, filepath.Join(root, "deploy", "runtime-grants.policy.json"))
	command.Dir = root
	var stderr bytes.Buffer
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		t.Fatalf("read the live rights of the sequences: %v (%s)", err, stderr.String())
	}
	return output
}

// generatedGrantSQL renders the grant SQL of the deployment.
func generatedGrantSQL(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command("node", filepath.Join(root, "deploy", "runtime-grants.mjs"), "--emit")
	command.Dir = root
	command.Env = append(os.Environ(), "NODE_NO_WARNINGS=1")
	// The renderer has to succeed, and the SQL and the warnings of the audit
	// are separate streams: the SQL is the standard output and a failure is
	// never read as a grant.
	var stderr bytes.Buffer
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		t.Fatalf("render the grant SQL of the deployment: %v (%s)", err, stderr.String())
	}
	if len(output) == 0 {
		t.Fatal("the deployment rendered no grant SQL")
	}
	return string(output)
}
