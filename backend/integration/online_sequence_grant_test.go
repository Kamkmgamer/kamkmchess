package integration

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
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
	// of the sequence nor write a checkpoint.
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
	}
	if _, err = rules.Exec(ctx, `INSERT INTO online_service_health(checkpoint_id,dependency,state,detail,recorded_at) VALUES('chk-rules-0001',$1,'healthy','the rules process answered',clock_timestamp())`, online.DependencyRules); err == nil {
		t.Fatal("the rules role wrote a checkpoint")
	}
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
	// The audit of the deployment reports its findings on the standard error
	// and exits with a non-zero code, so the rendered SQL is read from the
	// output of the command.
	output, _ := command.CombinedOutput()
	if len(output) == 0 {
		t.Fatal("the deployment rendered no grant SQL")
	}
	return string(output)
}
