package integration

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The planned restart of the online service.
//
// A planned restart is an interruption that an operator announced before the
// service stopped. The announcement is a durable boundary, and the operator
// reaches it through the khasuspend command, never through a public route.
//
// The proofs below cover the three steps of the path: the plan is idempotent
// and closes the durable gate, the recovery applies the boundary and opens the
// gate again, and the abort cancels a plan that will not happen and opens the
// gate again without refunding a clock.

// TestOnlineOperatorPlanIsIdempotentAndClosesTheGate covers the plan.
//
// The plan is the announcement of the operator, so it is written before the
// service stops. A second plan of the same announcement finds the pending
// boundary and changes nothing: one planned restart is one boundary, and the
// clock of the unfinished matches is refunded once.
//
// The plan closes the durable gate, so the service refuses every mutation
// while the interruption is pending.
func TestOnlineOperatorPlanIsIdempotentAndClosesTheGate(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-operator-plan"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)

	first, err := fixture.service.PlanSuspendingNow(ctx)
	if err != nil {
		t.Fatalf("plan the interruption: %v", err)
	}
	if first.Kind != online.SuspensionPlanned {
		t.Fatalf("the planned boundary has the kind %q, want %q", first.Kind, online.SuspensionPlanned)
	}
	second, err := fixture.service.PlanSuspendingNow(ctx)
	if err != nil {
		t.Fatalf("plan the interruption again: %v", err)
	}
	if second.BoundaryID != first.BoundaryID {
		t.Fatalf("the second plan wrote the boundary %q, want the boundary %q of the first plan", second.BoundaryID, first.BoundaryID)
	}
	var boundaries int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_suspension_boundaries`).Scan(&boundaries); err != nil {
		t.Fatal(err)
	}
	if boundaries != 1 {
		t.Fatalf("planned boundaries = %d for one planned restart, want exactly 1", boundaries)
	}
	// The gate of the service is closed, and the reason names the pending
	// interruption.
	state, err := online.ServiceGate(ctx, fixture.pool)
	if err != nil {
		t.Fatal(err)
	}
	if state.Open || state.Reason != online.GateReasonSuspensionPending {
		t.Fatalf("the durable gate = %+v after the plan, want a closed gate with the reason %q", state, online.GateReasonSuspensionPending)
	}
	// The pending interruption is the one of the plan.
	pending, err := fixture.service.PendingSuspension(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if pending == nil || pending.BoundaryID != first.BoundaryID {
		t.Fatalf("the pending interruption = %+v, want the boundary %q of the plan", pending, first.BoundaryID)
	}
	// The service refuses a mutation while the interruption is pending: a
	// planned restart is not a moment in which a move is accepted.
	move := moveOnlineCommand(matchID, "op-move-operator-plan", online.SeatWhite, 3, "g1f3")
	if _, err = fixture.service.Execute(ctx, presenceAlice().ref, move); !errors.Is(err, online.ErrUnavailable) {
		t.Fatalf("the move after the plan = %v, want ErrUnavailable", err)
	}
}

// TestOnlineOperatorRecoveryAppliesTheBoundaryAndOpensTheGate covers the
// recovery.
//
// The recovery of a planned interruption is the canonical one: it opens a new
// service epoch, refunds the announced interval to the unfinished matches,
// publishes the adjusted state and completes the epoch, so the durable gate
// opens again and the resumed actions meet the canonical clock.
func TestOnlineOperatorRecoveryAppliesTheBoundaryAndOpensTheGate(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-operator-recovery"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)
	before, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if before.Clock.DeadlineAt == nil {
		t.Fatal("the match has no armed clock")
	}
	beforeDeadline := *before.Clock.DeadlineAt

	boundary, err := fixture.service.PlanSuspendingNow(ctx)
	if err != nil {
		t.Fatalf("plan the interruption: %v", err)
	}
	// The planned restart lasts two minutes.
	fixture.clock.Advance(2 * time.Minute)
	plan, err := fixture.service.RecoverPlannedSuspension(ctx, boundary.BoundaryID)
	if err != nil {
		t.Fatalf("recover the planned interruption: %v", err)
	}
	if plan.Kind != online.SuspensionPlanned {
		t.Fatalf("the recovery reports the kind %q, want %q", plan.Kind, online.SuspensionPlanned)
	}
	if plan.InterruptionMs != int64(2*time.Minute/time.Millisecond) {
		t.Fatalf("the interruption = %d ms, want the planned two minutes", plan.InterruptionMs)
	}
	if plan.AdjustedMatches != 1 {
		t.Fatalf("the recovery adjusted %d matches, want the one unfinished match", plan.AdjustedMatches)
	}
	// The gate of the service is open again, and the reason is empty.
	state, err := online.ServiceGate(ctx, fixture.pool)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Open {
		t.Fatalf("the durable gate = %+v after the recovery, want an open gate", state)
	}
	// The canonical state is published: the clock of the unfinished match
	// moved by the announced interval and the adjustment is in the event
	// stream.
	after, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Clock.DeadlineAt == nil {
		t.Fatal("the recovered match has no deadline")
	}
	if moved := after.Clock.DeadlineAt.Sub(beforeDeadline); moved != 2*time.Minute {
		t.Fatalf("the clock of the unfinished match moved by %v, want the planned interruption of two minutes", moved)
	}
	var events int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_events WHERE match_id=$1 AND event_kind='recovery_adjustment'`, matchID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 1 {
		t.Fatalf("the recovery published %d adjustment events, want exactly 1", events)
	}
	// The interruption opened a new epoch and completed it, so the durable
	// gate of that epoch is open as well.
	var epochs int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_service_epochs WHERE recovered_at IS NOT NULL`).Scan(&epochs); err != nil {
		t.Fatal(err)
	}
	if epochs != 1 {
		t.Fatalf("completed epochs = %d after the recovery of one planned interruption, want exactly 1", epochs)
	}
	// The service accepts a resumed action again. The recovery published the
	// adjusted state, so the version of the match moved with it.
	resumed, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	move := moveOnlineCommand(matchID, "op-move-operator-recovery", online.SeatWhite, resumed.Version, "g1f3")
	if _, err = fixture.service.Execute(ctx, presenceAlice().ref, move); err != nil {
		t.Fatalf("the move after the recovery: %v", err)
	}
	// The replay of the recovery changes nothing: the clock of the match is
	// never shifted twice for one interruption.
	replay, err := fixture.service.RecoverPlannedSuspension(ctx, boundary.BoundaryID)
	if err != nil {
		t.Fatalf("the replay of the recovery: %v", err)
	}
	if replay.AdjustedMatches != 0 || !replay.AlreadyAdjusted {
		t.Fatalf("the replay of the recovery = %+v, want no adjustment at all", replay)
	}
	replayed, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if replayed.Clock.DeadlineAt == nil || !replayed.Clock.DeadlineAt.Equal(*after.Clock.DeadlineAt) {
		t.Fatalf("the replay moved the clock from %v to %v", after.Clock.DeadlineAt, replayed.Clock.DeadlineAt)
	}
}

// TestOnlineOperatorAbortOpensTheGateWithoutARefund covers the abort.
//
// The abort is the way back from a plan that will not happen: the restart was
// called off, so no interruption took place, no clock is refunded and the
// durable gate opens again. The row of the plan stays the evidence that the
// plan existed, and a later plan of the same epoch writes a boundary of its
// own, so the gate closes again.
func TestOnlineOperatorAbortOpensTheGateWithoutARefund(t *testing.T) {
	fixture := newPresenceFixture(t)
	ctx := context.Background()
	const matchID = "match-operator-abort"
	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)
	before, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if before.Clock.DeadlineAt == nil {
		t.Fatal("the match has no armed clock")
	}
	beforeDeadline := *before.Clock.DeadlineAt

	planned, err := fixture.service.PlanSuspendingNow(ctx)
	if err != nil {
		t.Fatalf("plan the interruption: %v", err)
	}
	aborted, err := fixture.service.AbortPlannedSuspension(ctx, planned.BoundaryID)
	if err != nil {
		t.Fatalf("abort the planned interruption: %v", err)
	}
	if aborted.AbortedAt == nil {
		t.Fatal("the aborted boundary carries no abort time")
	}
	if aborted.AdjustedAt != nil {
		t.Fatal("the aborted boundary claims an applied adjustment")
	}
	// The gate of the service is open again.
	state, err := online.ServiceGate(ctx, fixture.pool)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Open {
		t.Fatalf("the durable gate = %+v after the abort, want an open gate", state)
	}
	// No clock was refunded: the interruption never happened.
	after, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Clock.DeadlineAt == nil || !after.Clock.DeadlineAt.Equal(beforeDeadline) {
		t.Fatalf("the clock of the unfinished match moved from %v to %v by the abort", beforeDeadline, after.Clock.DeadlineAt)
	}
	var adjustments int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_recovery_adjustments WHERE match_id=$1`, matchID).Scan(&adjustments); err != nil {
		t.Fatal(err)
	}
	if adjustments != 0 {
		t.Fatalf("the abort wrote %d adjustments, want none", adjustments)
	}
	// The aborted plan is not pending any more.
	pending, err := fixture.service.PendingSuspension(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if pending != nil {
		t.Fatalf("the pending interruption = %+v after the abort, want none", pending)
	}
	// A later plan of the same epoch writes a boundary of its own, so the
	// gate closes again and the plan is not answered by the aborted row.
	again, err := fixture.service.PlanSuspendingNow(ctx)
	if err != nil {
		t.Fatalf("plan the interruption after the abort: %v", err)
	}
	if again.BoundaryID == planned.BoundaryID {
		t.Fatalf("the plan after the abort reused the aborted boundary %q", planned.BoundaryID)
	}
	state, err = online.ServiceGate(ctx, fixture.pool)
	if err != nil {
		t.Fatal(err)
	}
	if state.Open || state.Reason != online.GateReasonSuspensionPending {
		t.Fatalf("the durable gate = %+v after the second plan, want a closed gate", state)
	}
	// An applied interruption is never aborted.
	if _, err = fixture.service.AbortPlannedSuspension(ctx, planned.BoundaryID); !errors.Is(err, online.ErrConflict) {
		t.Fatalf("the abort of an aborted boundary = %v, want ErrConflict", err)
	}
}

// TestOnlineOperatorCommandPlansRecoversAndAborts covers the operator
// command itself.
//
// The command is the way an operator reaches the path: the database url comes
// from the named environment variable, the plan closes the durable gate, the
// recovery applies the boundary and opens the gate again, and the abort opens
// the gate again without refunding a clock.
func TestOnlineOperatorCommandPlansRecoversAndAborts(t *testing.T) {
	dsn, pool := operatorDatabase(t)
	ctx := context.Background()
	const matchID = "match-operator-command"
	createOperatorMatch(t, pool, matchID)
	binary := operatorCommand(t)

	// The plan closes the durable gate.
	planned := runOperatorCommand(t, binary, dsn, "plan")
	if planned.code != 0 {
		t.Fatalf("the plan exited with %d: %s", planned.code, planned.output)
	}
	if !strings.Contains(planned.output, "the durable gate is closed") {
		t.Fatalf("the plan did not report a closed gate: %s", planned.output)
	}
	var boundaries int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM online_suspension_boundaries WHERE kind='planned' AND aborted_at IS NULL`).Scan(&boundaries); err != nil {
		t.Fatal(err)
	}
	if boundaries != 1 {
		t.Fatalf("planned boundaries = %d after one plan, want exactly 1", boundaries)
	}
	// The plan is idempotent: a second plan writes no second boundary.
	repeated := runOperatorCommand(t, binary, dsn, "plan")
	if repeated.code != 0 {
		t.Fatalf("the repeated plan exited with %d: %s", repeated.code, repeated.output)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM online_suspension_boundaries WHERE kind='planned' AND aborted_at IS NULL`).Scan(&boundaries); err != nil {
		t.Fatal(err)
	}
	if boundaries != 1 {
		t.Fatalf("planned boundaries = %d after two plans, want exactly 1", boundaries)
	}
	// The status reports the closed gate and the pending interruption.
	status := runOperatorCommand(t, binary, dsn, "status", "--json")
	if status.code != 0 {
		t.Fatalf("the status exited with %d: %s", status.code, status.output)
	}
	if !strings.Contains(status.output, "\"gateOpen\": false") {
		t.Fatalf("the status did not report the closed gate: %s", status.output)
	}
	// The recovery applies the boundary and opens the gate again.
	recovered := runOperatorCommand(t, binary, dsn, "recover")
	if recovered.code != 0 {
		t.Fatalf("the recovery exited with %d: %s", recovered.code, recovered.output)
	}
	if !strings.Contains(recovered.output, "the durable gate is open") {
		t.Fatalf("the recovery did not report an open gate: %s", recovered.output)
	}
	var applied int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM online_suspension_boundaries WHERE kind='planned' AND adjusted_at IS NOT NULL`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if applied != 1 {
		t.Fatalf("applied boundaries = %d after the recovery, want exactly 1", applied)
	}
	// A recovery without a pending interruption is refused, and it never
	// derives an interruption of its own.
	refused := runOperatorCommand(t, binary, dsn, "recover")
	if refused.code == 0 {
		t.Fatalf("the recovery without a pending interruption succeeded: %s", refused.output)
	}
	if !strings.Contains(refused.output, "no planned interruption is pending") {
		t.Fatalf("the refusal of the recovery does not name the reason: %s", refused.output)
	}
	// The abort of a plan that will not happen opens the gate again.
	runOperatorCommand(t, binary, dsn, "plan")
	aborted := runOperatorCommand(t, binary, dsn, "abort")
	if aborted.code != 0 {
		t.Fatalf("the abort exited with %d: %s", aborted.code, aborted.output)
	}
	if !strings.Contains(aborted.output, "the durable gate is open") {
		t.Fatalf("the abort did not report an open gate: %s", aborted.output)
	}
	var abortedCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM online_suspension_boundaries WHERE aborted_at IS NOT NULL`).Scan(&abortedCount); err != nil {
		t.Fatal(err)
	}
	if abortedCount != 1 {
		t.Fatalf("aborted boundaries = %d after the abort, want exactly 1", abortedCount)
	}
	// The command never accepts the database url as an argument.
	positional := runOperatorCommand(t, binary, dsn, "plan", "postgres://user:secret@127.0.0.1:5432/kamkmchess")
	if positional.code == 0 {
		t.Fatalf("the command accepted a database url as an argument: %s", positional.output)
	}
	if strings.Contains(positional.output, "secret") {
		t.Fatalf("the refusal of the command printed the credential: %s", positional.output)
	}
}

// operatorURLEnv is the environment variable that carries the database url
// of the operator command in the proofs.
const operatorURLEnv = "KHA_OPERATOR_DATABASE_URL"

// operatorDatabase opens an isolated schema for the operator command and
// returns the url of that schema.
//
// The schema is the resource of this test alone: it is created here and
// dropped when the test ends.
func operatorDatabase(t *testing.T) (string, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv(databaseEnv)
	if dsn == "" {
		if os.Getenv("KHA41_REQUIRE_POSTGRES") == "1" {
			t.Fatalf("%s is required", databaseEnv)
		}
		t.Skipf("PostgreSQL integration unavailable: set %s", databaseEnv)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect isolated PostgreSQL: %v", err)
	}
	if err = admin.Ping(ctx); err != nil {
		admin.Close()
		t.Fatalf("ping isolated PostgreSQL: %v", err)
	}
	schema := fmt.Sprintf("kha71_operator_%d_%s", time.Now().UnixNano(), randomSchemaSuffix())
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatalf("create test schema: %v", err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE"); admin.Close() })
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err = migrations.Apply(context.Background(), pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	return schemaURL(t, dsn, schema), pool
}

// schemaURL returns the url of the database with the search path of the
// isolated schema.
func schemaURL(t *testing.T, dsn, schema string) string {
	t.Helper()
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse the database url: %v", err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

// operatorCommand builds the operator command of the repository.
//
// The command is the program the operator runs, so the proof uses the real
// binary and not a copy of its logic.
func operatorCommand(t *testing.T) string {
	t.Helper()
	name := "khasuspend"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	binary := filepath.Join(t.TempDir(), name)
	root := filepath.Clean(filepath.Join("..", ".."))
	build := exec.Command("go", "build", "-o", binary, "./backend/online/cmd/khasuspend")
	build.Dir = root
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build the operator command: %v: %s", err, output)
	}
	return binary
}

// operatorResult is the outcome of one run of the operator command.
type operatorResult struct {
	code   int
	output string
}

// runOperatorCommand runs the operator command against the isolated schema.
//
// The database url is handed over through the named environment variable, so
// it never appears in the arguments of the command.
func runOperatorCommand(t *testing.T, binary, dsn string, arguments ...string) operatorResult {
	t.Helper()
	if len(arguments) == 0 {
		t.Fatal("the operator command needs a command")
	}
	// The url is handed over through the named environment variable, so it
	// never appears in the arguments of the command.
	command := exec.Command(binary, append([]string{arguments[0], "--database-url-env", operatorURLEnv}, arguments[1:]...)...)
	command.Env = append(os.Environ(), operatorURLEnv+"="+dsn)
	output, err := command.CombinedOutput()
	code := 0
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		} else {
			t.Fatalf("run the operator command: %v", err)
		}
	}
	return operatorResult{code: code, output: string(output)}
}

// createOperatorMatch writes one unfinished match for the operator command.
//
// The command never evaluates a move, so the match is written directly and
// the clock of the match is the one of the production table.
func createOperatorMatch(t *testing.T, pool *pgxpool.Pool, matchID string) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO online_matches(match_id,schema_version,variant,starting_fen,position_fen,starting_time_ms,increment_ms,version,control_epoch,input_hash,rules_policy_version,status,created_at,updated_at)
VALUES($1,1,'orthodox','rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1','rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',1200000,0,1,1,decode(repeat('00',32),'hex'),'online/1','active',clock_timestamp(),clock_timestamp())`, matchID); err != nil {
		t.Fatalf("create the match of the operator command: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO online_clocks(match_id,white_ms,black_ms,active_seat,active_since,deadline_at,white_moved,black_moved,turn_number,reply_seat,reply_deadline_at,updated_at)
VALUES($1,1200000,1200000,'white',clock_timestamp(),clock_timestamp()+interval '20 minutes',false,false,1,NULL,NULL,clock_timestamp())`, matchID); err != nil {
		t.Fatalf("create the clock of the operator command: %v", err)
	}
}
