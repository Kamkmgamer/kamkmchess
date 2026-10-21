package integration

import (
	"context"
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
func TestOnlineTheRuntimeRoleCanWriteACheckpointWithTheOrderOfTheSequence(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	var schema string
	if err := fixture.pool.QueryRow(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	const runtimeRole = "kha_test_runtime_role"
	const rulesRole = "kha_test_rules_role"
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
	// The role of the deployment holds the privileges of the policy: the
	// usage of the sequence and the insert into the health table.
	if _, err := fixture.pool.Exec(ctx, `GRANT USAGE ON SCHEMA `+schema+` TO `+runtimeRole); err != nil {
		t.Fatalf("grant the schema: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `GRANT USAGE ON SEQUENCE `+schema+`.online_service_health_order TO `+runtimeRole); err != nil {
		t.Fatalf("grant the sequence: %v", err)
	}
	if _, err := fixture.pool.Exec(ctx, `GRANT SELECT, INSERT ON TABLE `+schema+`.online_service_health TO `+runtimeRole); err != nil {
		t.Fatalf("grant the health table: %v", err)
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
	} else if !strings.Contains(err.Error(), "permission denied") && !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("the rules role failed to take the order with %v, want a permission error", err)
	}
	if _, err = rules.Exec(ctx, `INSERT INTO online_service_health(checkpoint_id,dependency,state,detail,recorded_at) VALUES('chk-rules-0001',$1,'healthy','the rules process answered',clock_timestamp())`, online.DependencyRules); err == nil {
		t.Fatal("the rules role wrote a checkpoint")
	} else if !strings.Contains(err.Error(), "permission denied") && !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("the rules role failed to write a checkpoint with %v, want a permission error", err)
	}
}
