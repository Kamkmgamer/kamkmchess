package integration

// The composed rules proof.
//
// The service boundary of the online play is only worth something when it is
// proved against a real process. Every test below runs the real private
// rules bundle in a real worker process, breaks exactly one exchange of that
// process and observes what the service does with it:
//
//   - an occupied worker is not an outage: the durable health stays, no
//     interruption is planned, the gate stays open and the clock of the
//     unfinished match does not move;
//   - a worker that became ready and then stopped answering is an outage:
//     the probe ends in the internal bound of the rules client, the
//     dependency is degraded, the gate closes and the recovery refunds the
//     clock of the unfinished match exactly once;
//   - a cold worker that is busy with a participant request is not an
//     outage either, before a reset and after a failed boot warm.
//
// The proof fails causally. The probe seam, the busy classifier, the
// replacement of a failed worker and the exactly-once refund are each
// removed in turn by the assertions below.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/rulesworker"
	"github.com/Kamkmgamer/kamkmchess/backend/serverapp"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The environment of the real worker bundle.
const (
	// composedBundleEnv names the built private worker bundle.
	//
	// The proof needs the real protocol and the real engine, so the bundle
	// is the one the service runs. The environment wins over the portable
	// default, so a host with its own build can prove the same contract.
	composedBundleEnv = "KHA66_WORKER_ENTRY"
	// composedBundlePath is the portable default of the bundle.
	//
	// It is relative to the root of the repository, so the proof runs in
	// every checkout of the repository and not only on one host.
	composedBundlePath = "build/rules-worker/worker.mjs"
)

// The budgets of the composed proof.
const (
	// composedRequestTimeout is the internal bound of the rules client.
	//
	// A worker that does not answer ends here, so the bound of the client
	// is the deadline of the outage.
	composedRequestTimeout = 2 * time.Second
	// composedStartTimeout is the budget of the cold start of a worker.
	//
	// The real bundle loads the pinned engine, so the start gets a budget
	// of its own and never fails a loaded host.
	composedStartTimeout = 30 * time.Second
	// composedWait bounds every wait of the proof.
	//
	// A wait ends on a marker of a real process, so the bound is a failure
	// of the proof and never a hang of the suite.
	composedWait = 60 * time.Second
)

// realWorkerBundle returns the built private worker bundle.
//
// The proof needs the real protocol, so a missing bundle fails the test
// instead of skipping it: a silently skipped proof is not a proof.
func realWorkerBundle(t *testing.T) string {
	t.Helper()
	path := strings.TrimSpace(os.Getenv(composedBundleEnv))
	if path == "" {
		path = filepath.Join(composedRepositoryRoot(t), filepath.FromSlash(composedBundlePath))
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the private worker bundle is missing at %s: set %s", path, composedBundleEnv)
	}
	return path
}

// composedRepositoryRoot returns the root of the repository of the proof.
//
// The path of the test file is the only portable anchor of the checkout, so
// the default bundle is found in every clone of the repository.
func composedRepositoryRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("the path of the composed proof is unknown")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

// composedFixture is one online service with a real rules client.
//
// The client runs the real bundle through the proxy, so the service can be
// shown a busy worker, a hung worker and the healthy replacement of both.
type composedFixture struct {
	service   *online.Service
	pool      *pgxpool.Pool
	health    *online.HealthReporter
	client    *rulesworker.Client
	evaluator *rulesworker.OnlineEvaluator
	proxy     *composedProxy
}

// newComposedFixture opens an online service against the real schema.
//
// The service keeps the authoritative clock of the database, so the length
// of an interruption is the real time that passed and not a fixture value.
func newComposedFixture(t *testing.T, bundle string) composedFixture {
	t.Helper()
	pool := testPool(t)
	if err := migrations.Apply(context.Background(), pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	proxy := newComposedProxy(t, bundle)
	client, err := rulesworker.New(rulesworker.Config{
		Entry:          proxy.entry,
		RequestTimeout: composedRequestTimeout,
		StartTimeout:   composedStartTimeout,
	})
	if err != nil {
		t.Fatalf("the rules client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	evaluator, err := rulesworker.NewOnlineEvaluator(client)
	if err != nil {
		t.Fatalf("the rules evaluator: %v", err)
	}
	health := online.NewHealthReporter(pool)
	service, err := online.Open(context.Background(), pool, evaluator,
		online.WithHealthReporter(health),
		online.WithBusyClassifier(composedBusy),
		online.WithCancellationClassifier(composedCancelled),
	)
	if err != nil {
		t.Fatalf("open the online service: %v", err)
	}
	return composedFixture{service: service, pool: pool, health: health, client: client, evaluator: evaluator, proxy: proxy}
}

// composedBusy reports the busy answers of the rules client.
//
// The busy error of the client is its own, so the composition installs the
// classifier that knows it. An occupied worker is not a broken dependency.
func composedBusy(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, rulesworker.ErrBusy) || errors.Is(err, online.ErrRulesBusy)
}

// composedCancelled reports the cancelled answers of the rules client.
//
// A caller that goes away is not a broken dependency, so the durable health
// of the rules dependency is not downgraded by a departing client.
func composedCancelled(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	return errors.Is(err, rulesworker.ErrCanceled)
}

// composedMove is one participant request that runs in the background.
//
// The request holds the worker of the client while it waits for the answer
// of the real engine, so the test can observe the service while the worker
// is occupied.
type composedMove struct {
	done chan error
}

// wait waits for the request and returns its failure.
func (m *composedMove) wait(t *testing.T, timeout time.Duration) error {
	t.Helper()
	select {
	case err := <-m.done:
		return err
	case <-time.After(timeout):
		t.Fatalf("the participant request did not finish within %s", timeout)
		return nil
	}
}

// finished reports whether the request already returned.
func (m *composedMove) finished() bool {
	select {
	case <-m.done:
		return true
	default:
		return false
	}
}

// startComposedMove submits one move of one seat.
//
// The request runs in the background, so the test holds the worker while it
// observes the service.
func startComposedMove(t *testing.T, fixture composedFixture, ctx context.Context, matchID, operationID string, seat online.Seat, version int64, uci string) *composedMove {
	t.Helper()
	actor := presenceAlice().ref
	if seat == online.SeatBlack {
		actor = presenceBob().ref
	}
	move := &composedMove{done: make(chan error, 1)}
	command := moveOnlineCommand(matchID, operationID, seat, version, uci)
	go func() {
		_, err := fixture.service.Execute(ctx, actor, command)
		move.done <- err
	}()
	return move
}

// composedVersion returns the current version of the match.
func composedVersion(t *testing.T, service *online.Service, matchID string) int64 {
	t.Helper()
	match, err := service.GetMatch(context.Background(), matchID)
	if err != nil {
		t.Fatalf("read the match %s: %v", matchID, err)
	}
	return match.Version
}

// assertBusyProbe proves that the probe of an occupied worker reported the
// busy worker exactly.
//
// The exact answer matters: an occupied worker that is reported as a broken
// dependency would close the gate and refund the clock of every unfinished
// match.
func assertBusyProbe(t *testing.T, service *online.Service, ctx context.Context) {
	t.Helper()
	err := service.ProbeRules(ctx)
	if err == nil {
		t.Fatal("the probe of an occupied worker answered")
	}
	if !errors.Is(err, online.ErrRulesBusy) {
		t.Fatalf("the probe of an occupied worker = %v, want the busy answer of the rules client", err)
	}
	if errors.Is(err, rulesworker.ErrTimeout) || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the occupied worker was reported as an outage: %v", err)
	}
}

// assertHungProbe proves that the probe of a worker that stopped answering
// ended in the internal bound of the rules client.
//
// A hung worker that is reported as busy would hide a real outage, so the
// answer must carry the timeout of the client and not the busy answer.
func assertHungProbe(t *testing.T, service *online.Service, ctx context.Context) {
	t.Helper()
	err := service.ProbeRules(ctx)
	if err == nil {
		t.Fatal("the probe of a hung worker answered")
	}
	if errors.Is(err, online.ErrRulesBusy) {
		t.Fatalf("the hung worker was reported as busy: %v", err)
	}
	if !errors.Is(err, rulesworker.ErrTimeout) {
		t.Fatalf("the probe of a hung worker = %v, want the internal bound of the rules client", err)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the internal bound of the rules client was reported as the deadline of the caller: %v", err)
	}
}

// assertNoOutage proves that the service recorded no outage at all.
//
// No degraded checkpoint, no planned interruption, no refund of a clock and
// an open gate: an occupied worker changes nothing of the durable state.
func assertNoOutage(t *testing.T, fixture composedFixture, matchID string) {
	t.Helper()
	ctx := context.Background()
	var degraded int
	if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_service_health WHERE dependency=$1 AND state=$2`,
		online.DependencyRules, string(online.HealthDegraded)).Scan(&degraded); err != nil {
		t.Fatalf("count the degraded checkpoints: %v", err)
	}
	if degraded != 0 {
		t.Fatalf("the service recorded %d degraded checkpoints of the rules dependency", degraded)
	}
	var suspensions int
	if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_suspension_boundaries`).Scan(&suspensions); err != nil {
		t.Fatalf("count the interruptions: %v", err)
	}
	if suspensions != 0 {
		t.Fatalf("the service planned %d interruptions", suspensions)
	}
	var refunds int
	if err := fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_recovery_adjustments WHERE match_id=$1`, matchID).Scan(&refunds); err != nil {
		t.Fatalf("count the refunds: %v", err)
	}
	if refunds != 0 {
		t.Fatalf("the service refunded the clock of the match %d times", refunds)
	}
	gate, err := online.ServiceGate(ctx, fixture.pool)
	if err != nil {
		t.Fatalf("read the gate: %v", err)
	}
	if !gate.Open {
		t.Fatalf("the gate = %+v, want an open gate", gate)
	}
	state := fixture.health.Current().Rules.State
	if state == online.HealthDegraded || state == online.HealthUnavailable {
		t.Fatalf("the rules dependency = %q, want a dependency that can serve", state)
	}
	shared, err := fixture.health.SharedState(ctx)
	if err != nil {
		t.Fatalf("read the shared health: %v", err)
	}
	if shared == online.HealthDegraded || shared == online.HealthUnavailable {
		t.Fatalf("the shared health = %q, want a service that can serve", shared)
	}
}

// TestOnlineComposedRulesBusyWorkerIsNotAnOutage proves that an occupied
// worker is not an outage.
//
// The participant request holds the worker while the real bundle answers it,
// and the marker of the proxy is the barrier that proves the slot of the
// client is occupied. The probe of the same service must then report the
// busy worker exactly, so the durable health stays, no interruption is
// planned, the gate stays open and the clock of the unfinished match does
// not move.
func TestOnlineComposedRulesBusyWorkerIsNotAnOutage(t *testing.T) {
	bundle := realWorkerBundle(t)
	fixture := newComposedFixture(t, bundle)
	ctx := context.Background()
	const matchID = "match-composed-busy"

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

	// The next exchange of the worker is held, so the participant request
	// keeps the slot of the client.
	fixture.proxy.selectExchange(t, "busy", 0, composedHold)
	moveCtx, cancelMove := context.WithCancel(ctx)
	defer cancelMove()
	move := startComposedMove(t, fixture, moveCtx, matchID, "op-move-white-busy", online.SeatWhite, before.Version, "g1f3")

	// The barrier: the real bundle answered and the answer is withheld, so
	// the worker of the client is occupied.
	fixture.proxy.waitForHeld(t, composedWait)

	assertBusyProbe(t, fixture.service, ctx)
	if move.finished() {
		t.Fatal("the participant request finished before the probe of the occupied worker")
	}
	assertNoOutage(t, fixture, matchID)

	// The clock of the unfinished match did not move.
	during, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if during.Clock.DeadlineAt == nil || !during.Clock.DeadlineAt.Equal(beforeDeadline) {
		t.Fatalf("the clock of the unfinished match moved from %v to %v", beforeDeadline, during.Clock.DeadlineAt)
	}

	// The participant request leaves. A cancelled evaluation is a departing
	// caller, not a broken dependency.
	cancelMove()
	if err := move.wait(t, composedWait); err == nil {
		t.Fatal("the cancelled participant request was accepted")
	}
	assertNoOutage(t, fixture, matchID)
	if state := fixture.health.Current().Rules.State; state != online.HealthHealthy {
		t.Fatalf("the rules dependency = %q after a cancelled request, want %q", state, online.HealthHealthy)
	}
}

// composedRawProbe reports the answer of the rules client unchanged.
//
// The production adapter translates the busy error of the client into the
// shared busy error of the online contract. The classifier of the service
// has to know the raw error as well, because a caller that reports the
// answer of the client unchanged must never look like a broken dependency.
//
// The evaluator is the real adapter of the real client, so the worker that
// the probe finds occupied is a real process.
type composedRawProbe struct {
	*rulesworker.OnlineEvaluator
	client *rulesworker.Client
}

// Probe reports the answer of the rules client unchanged.
func (e composedRawProbe) Probe(ctx context.Context) error {
	return e.client.Probe(ctx)
}

// TestOnlineComposedRulesRawBusyAnswerIsNotAnOutage proves that the busy
// classifier of the service knows the busy error of the rules client.
//
// The probe of a caller that reports the answer of the client unchanged
// carries the raw busy error. The service must read it as an occupied
// worker, so the dependency is not downgraded and no interruption is
// planned.
func TestOnlineComposedRulesRawBusyAnswerIsNotAnOutage(t *testing.T) {
	bundle := realWorkerBundle(t)
	fixture := newComposedFixture(t, bundle)
	ctx := context.Background()
	const matchID = "match-composed-raw-busy"

	createAgentMatch(t, fixture.service, matchID, 20*60*1000)
	acceptMoves(t, fixture.service, matchID)
	before, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	beforeDeadline := *before.Clock.DeadlineAt

	// A second instance of the service reports the answer of the client
	// unchanged.
	raw := composedRawProbe{OnlineEvaluator: fixture.evaluator, client: fixture.client}
	rawService, err := online.Open(ctx, fixture.pool, raw,
		online.WithHealthReporter(fixture.health),
		online.WithBusyClassifier(composedBusy),
		online.WithCancellationClassifier(composedCancelled),
	)
	if err != nil {
		t.Fatalf("open the online service: %v", err)
	}

	// The next exchange of the worker is held, so the participant request
	// keeps the slot of the client.
	fixture.proxy.selectExchange(t, "raw-busy", 0, composedHold)
	moveCtx, cancelMove := context.WithCancel(ctx)
	defer cancelMove()
	move := startComposedMove(t, fixture, moveCtx, matchID, "op-move-white-raw-busy", online.SeatWhite, before.Version, "g1f3")
	fixture.proxy.waitForHeld(t, composedWait)

	probeErr := rawService.ProbeRules(ctx)
	if probeErr == nil {
		t.Fatal("the probe of an occupied worker answered")
	}
	if !errors.Is(probeErr, rulesworker.ErrBusy) {
		t.Fatalf("the probe of an occupied worker = %v, want the busy error of the rules client", probeErr)
	}
	if move.finished() {
		t.Fatal("the participant request finished before the probe of the occupied worker")
	}
	assertNoOutage(t, fixture, matchID)
	during, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if during.Clock.DeadlineAt == nil || !during.Clock.DeadlineAt.Equal(beforeDeadline) {
		t.Fatalf("the clock of the unfinished match moved from %v to %v", beforeDeadline, during.Clock.DeadlineAt)
	}
	cancelMove()
	if err := move.wait(t, composedWait); err == nil {
		t.Fatal("the cancelled participant request was accepted")
	}
	assertNoOutage(t, fixture, matchID)
}

// TestOnlineComposedRulesClosedGateRecoversWithTheSameClient proves that a
// closed gate recovers with the same client.
//
// A worker that became ready and then stopped answering is an outage: the
// probe ends in the internal bound of the rules client, the dependency is
// degraded and the planned interruption closes the gate for every instance.
// The primary traffic is refused while the gate is closed. The durable
// health monitor then restarts the worker of the same client, recovers the
// interruption, reopens the gate and refunds the clock of the unfinished
// match exactly once.
//
// The monitor is the production recovery path, so the proof cannot pass with
// a fresh client that happens to be healthy: the same client has to come
// back, and the gate has to open again.
func TestOnlineComposedRulesClosedGateRecoversWithTheSameClient(t *testing.T) {
	bundle := realWorkerBundle(t)
	fixture := newComposedFixture(t, bundle)
	ctx := context.Background()
	const matchID = "match-composed-hung"

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

	// The worker is ready and idle, and the next exchange never answers.
	fixture.proxy.selectExchange(t, "hung", 0, composedHold)
	assertHungProbe(t, fixture.service, ctx)
	fixture.proxy.waitForHeld(t, composedWait)
	if state := fixture.health.Current().Rules.State; state != online.HealthDegraded {
		t.Fatalf("the rules dependency = %q after a hung worker, want %q", state, online.HealthDegraded)
	}

	// The interruption is planned, so the gate closes for every instance.
	if err = fixture.service.SuspendForDependency(ctx, online.DependencyRules); err != nil {
		t.Fatalf("suspend the dependency: %v", err)
	}
	gate, err := online.ServiceGate(ctx, fixture.pool)
	if err != nil {
		t.Fatal(err)
	}
	if gate.Open {
		t.Fatalf("the gate = %+v after the interruption, want a closed gate", gate)
	}
	// Nothing was refunded before the recovery.
	during, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if during.Clock.DeadlineAt == nil || !during.Clock.DeadlineAt.Equal(beforeDeadline) {
		t.Fatalf("the clock moved before the recovery: %v instead of %v", during.Clock.DeadlineAt, beforeDeadline)
	}

	// The primary traffic is refused while the gate is closed.
	//
	// The cancel never reaches the rules worker, so the refusal is the
	// closed gate and not a broken dependency.
	if _, err = fixture.service.Execute(ctx, presenceAlice().ref,
		cancelOnlineCommand(matchID, "op-cancel-closed-gate", online.SeatWhite, before.Version)); !errors.Is(err, online.ErrUnavailable) {
		t.Fatalf("the primary traffic during the closed gate = %v, want the refusal of the closed gate", err)
	}

	// The monitor of the durable health is the production recovery path.
	// It has to bring the same client back and recover the interruption.
	started := fixture.proxy.startedProcesses(t)
	monitor := startComposedMonitor(t, fixture)
	defer monitor.stop()
	waitForGate(t, fixture.pool, true, composedWait, monitor)
	replacements := fixture.proxy.startedProcesses(t)
	if replacements <= started {
		t.Fatalf("the client did not start a replacement: %d workers before, %d after", started, replacements)
	}
	if state := fixture.health.Current().Rules.State; state != online.HealthHealthy {
		t.Fatalf("the rules dependency = %q after the replacement answered, want %q", state, online.HealthHealthy)
	}

	// The recovery refunded the clock of the unfinished match by exactly
	// the length of the interruption.
	recovered, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Clock.DeadlineAt == nil {
		t.Fatal("the recovered match has no deadline")
	}
	refund := recovered.Clock.DeadlineAt.Sub(beforeDeadline)
	var interruption int64
	if err = fixture.pool.QueryRow(ctx, `SELECT interruption_ms FROM online_suspension_boundaries WHERE kind='planned' ORDER BY created_at LIMIT 1`).Scan(&interruption); err != nil {
		t.Fatalf("read the interruption: %v", err)
	}
	// The clock was refunded by exactly the interval of the interruption that
	// the service recorded, so the refund is the outage itself and not a guess
	// about the clock of the host. The interval may be shorter than a
	// millisecond, so the refund is compared in milliseconds.
	if refund.Milliseconds() != interruption {
		t.Fatalf("the clock of the unfinished match moved by %v, want the recorded interruption of %d ms", refund, interruption)
	}

	// The refund happened once: a replay of the recovery changes nothing.
	//
	// The service is alive, so the replay finds no new interruption, and
	// the explicit replay of the applied boundary reports it as applied.
	replay, err := fixture.service.RecoverFromInterruption(ctx)
	if err != nil {
		t.Fatalf("the replay of the recovery: %v", err)
	}
	if replay.InterruptionMs != 0 {
		t.Fatalf("the replay of the recovery reported a new interruption of %d ms", replay.InterruptionMs)
	}
	again, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if again.Clock.DeadlineAt == nil || !again.Clock.DeadlineAt.Equal(*recovered.Clock.DeadlineAt) {
		t.Fatalf("the replay moved the deadline from %v to %v", recovered.Clock.DeadlineAt, again.Clock.DeadlineAt)
	}
	var refunds int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_recovery_adjustments WHERE match_id=$1`, matchID).Scan(&refunds); err != nil {
		t.Fatalf("count the refunds: %v", err)
	}
	if refunds != 1 {
		t.Fatalf("the recovery refunded the clock %d times, want exactly one", refunds)
	}

	// The primary traffic is served again after the recovery.
	version := composedVersion(t, fixture.service, matchID)
	move := startComposedMove(t, fixture, ctx, matchID, "op-move-white-after-recovery", online.SeatWhite, version, "g1f3")
	if err = move.wait(t, composedWait); err != nil {
		t.Fatalf("the participant request after the recovery: %v", err)
	}
}

// composedMonitor is the durable health monitor of the service.
//
// The monitor is the production recovery path: it probes the dependency and
// it recovers a pending interruption. The answers it reports are kept, so a
// failure of the proof can name what the monitor saw.
type composedMonitor struct {
	stop   func()
	mu     sync.Mutex
	errors []error
}

// startComposedMonitor starts the durable health monitor of the fixture.
func startComposedMonitor(t *testing.T, fixture composedFixture) *composedMonitor {
	t.Helper()
	monitor := &composedMonitor{}
	monitor.stop = serverapp.StartHealthMonitor(context.Background(), fixture.pool, fixture.health, fixture.service,
		serverapp.HealthMonitorConfig{
			Interval: 100 * time.Millisecond,
			OnError:  monitor.record,
		})
	return monitor
}

// record keeps one answer of the monitor.
func (m *composedMonitor) record(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.errors = append(m.errors, err)
}

// answers returns the distinct answers the monitor reported, with the count
// of each.
//
// The monitor answers on every tick, so the summary names the class of the
// failure instead of repeating it.
func (m *composedMonitor) answers() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	counts := map[string]int{}
	order := []string{}
	for _, err := range m.errors {
		message := err.Error()
		if _, known := counts[message]; !known {
			order = append(order, message)
		}
		counts[message]++
	}
	summary := make([]string, 0, len(order))
	for _, message := range order {
		summary = append(summary, fmt.Sprintf("%s (x%d)", message, counts[message]))
	}
	return summary
}

// waitForGate waits until the durable gate reaches the wanted state.
//
// A gate that stays closed is a deadlock of the service, so the wait names
// the answers the monitor reported.
func waitForGate(t *testing.T, pool *pgxpool.Pool, wantOpen bool, timeout time.Duration, monitor *composedMonitor) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		gate, err := online.ServiceGate(context.Background(), pool)
		if err != nil {
			t.Fatalf("read the gate: %v", err)
		}
		if gate.Open == wantOpen {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the gate = %+v after %s, want open=%v: the service did not recover, the monitor reported %v",
				gate, timeout, wantOpen, monitor.answers())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestOnlineComposedRulesColdStartContentionIsNotAnOutage proves that a cold
// worker that is busy with a participant request is not an outage.
//
// The worker is cold, the participant request starts it and keeps it busy,
// and the probe of the same service finds the worker occupied. The healthy
// cold start then completes, so nothing was broken and nothing was
// refunded. The same holds after the client reset itself and after a boot
// warm that failed.
func TestOnlineComposedRulesColdStartContentionIsNotAnOutage(t *testing.T) {
	bundle := realWorkerBundle(t)
	fixture := newComposedFixture(t, bundle)
	factory := newComposedFactory(t, bundle, fixture.pool)
	ctx := context.Background()
	const matchID = "match-composed-cold"

	// The ordinary traffic of the match is played by another instance of the
	// service, so the worker of the service under test is still cold.
	createAgentMatch(t, factory.service, matchID, 20*60*1000)
	acceptMoves(t, factory.service, matchID)
	before, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if before.Clock.DeadlineAt == nil {
		t.Fatal("the match has no armed clock")
	}
	beforeDeadline := *before.Clock.DeadlineAt

	// The dependency is healthy before the contention, so the proof can
	// tell a false outage from an untouched observation.
	if err = fixture.health.ReportDependency(ctx, online.DependencyRules, online.HealthHealthy, "the rules process answered"); err != nil {
		t.Fatalf("report the healthy dependency: %v", err)
	}

	// The cold start of the worker is held by the participant request: the
	// readiness of the worker is answered and the answer of the move is
	// withheld.
	fixture.proxy.selectExchange(t, "cold", 1, composedHold)
	moveCtx, cancelMove := context.WithCancel(ctx)
	defer cancelMove()
	move := startComposedMove(t, fixture, moveCtx, matchID, "op-move-white-cold", online.SeatWhite, before.Version, "g1f3")
	fixture.proxy.waitForHeld(t, composedWait)

	// The probe of the same service finds the cold worker occupied.
	assertBusyProbe(t, fixture.service, ctx)
	if move.finished() {
		t.Fatal("the participant request finished before the probe of the cold worker")
	}
	assertNoOutage(t, fixture, matchID)
	during, err := fixture.service.GetMatch(ctx, matchID)
	if err != nil {
		t.Fatal(err)
	}
	if during.Clock.DeadlineAt == nil || !during.Clock.DeadlineAt.Equal(beforeDeadline) {
		t.Fatalf("the clock of the unfinished match moved from %v to %v", beforeDeadline, during.Clock.DeadlineAt)
	}

	// The healthy cold start completes: the answer of the real engine is
	// delivered and the move is accepted.
	fixture.proxy.releaseExchange(t)
	fixture.proxy.waitForReleased(t, composedWait)
	if err = move.wait(t, composedWait); err != nil {
		t.Fatalf("the participant request of the cold start: %v", err)
	}
	version := composedVersion(t, fixture.service, matchID)
	if version <= before.Version {
		t.Fatalf("the version of the match = %d after the cold start, want a version above %d", version, before.Version)
	}
	assertNoOutage(t, fixture, matchID)

	// The client resets itself: the participant request leaves, so the
	// worker is killed and reaped and the next request starts a fresh one.
	fixture.proxy.selectExchange(t, "reset", 0, composedHold)
	resetCtx, cancelReset := context.WithCancel(ctx)
	defer cancelReset()
	reset := startComposedMove(t, fixture, resetCtx, matchID, "op-move-black-reset", online.SeatBlack, version, "b8c6")
	fixture.proxy.waitForHeld(t, composedWait)
	cancelReset()
	if err = reset.wait(t, composedWait); err == nil {
		t.Fatal("the cancelled participant request was accepted")
	}
	assertNoOutage(t, fixture, matchID)

	// The cold worker after the reset is busy with the next participant
	// request, and the probe is still not an outage.
	fixture.proxy.selectExchange(t, "after-reset", 1, composedHold)
	afterResetCtx, cancelAfterReset := context.WithCancel(ctx)
	defer cancelAfterReset()
	afterReset := startComposedMove(t, fixture, afterResetCtx, matchID, "op-move-black-after-reset", online.SeatBlack, version, "b8c6")
	fixture.proxy.waitForHeld(t, composedWait)
	assertBusyProbe(t, fixture.service, ctx)
	assertNoOutage(t, fixture, matchID)
	// The request leaves, so the client is cold for the boot warm.
	cancelAfterReset()
	if err = afterReset.wait(t, composedWait); err == nil {
		t.Fatal("the cancelled participant request was accepted")
	}
	assertNoOutage(t, fixture, matchID)

	// A boot warm of a cold client fails when the worker dies, and the cold
	// worker is still not an outage.
	fixture.proxy.selectExchange(t, "boot-warm", 0, composedExit)
	if err = fixture.client.Warm(ctx); err == nil {
		t.Fatal("the boot warm of a worker that died answered")
	}
	fixture.proxy.waitForHeld(t, composedWait)
	assertNoOutage(t, fixture, matchID)
	fixture.proxy.selectExchange(t, "after-warm", 1, composedHold)
	afterWarm := startComposedMove(t, fixture, ctx, matchID, "op-move-black-after-warm", online.SeatBlack, version, "b8c6")
	fixture.proxy.waitForHeld(t, composedWait)
	assertBusyProbe(t, fixture.service, ctx)
	assertNoOutage(t, fixture, matchID)
	fixture.proxy.releaseExchange(t)
	fixture.proxy.waitForReleased(t, composedWait)
	if err = afterWarm.wait(t, composedWait); err != nil {
		t.Fatalf("the participant request after the failed boot warm: %v", err)
	}
	assertNoOutage(t, fixture, matchID)
}

// composedFactory is a second instance of the online service.
//
// It plays the ordinary traffic of the fixture, so the worker of the
// service under test keeps its cold state for the contention it has to
// prove.
type composedFactory struct {
	service *online.Service
	client  *rulesworker.Client
}

// newComposedFactory opens a second instance against the real bundle.
//
// The instance shares the state of the fixture and owns no proxy, so it is
// an ordinary worker of the pinned bundle.
func newComposedFactory(t *testing.T, bundle string, pool *pgxpool.Pool) composedFactory {
	t.Helper()
	client, err := rulesworker.New(rulesworker.Config{
		Entry:          bundle,
		RequestTimeout: composedRequestTimeout,
		StartTimeout:   composedStartTimeout,
	})
	if err != nil {
		t.Fatalf("the rules client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	evaluator, err := rulesworker.NewOnlineEvaluator(client)
	if err != nil {
		t.Fatalf("the rules evaluator: %v", err)
	}
	service, err := online.Open(context.Background(), pool, evaluator)
	if err != nil {
		t.Fatalf("open the online service: %v", err)
	}
	return composedFactory{service: service, client: client}
}
