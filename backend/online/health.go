package online

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The service health boundary.
//
// A service outage is not opponent abandonment. The online writer therefore
// consumes a durable health state before it offers or accepts an abandonment
// claim, so a failing rules service can never be read as an absent opponent.
//
// The health is dependency specific. The database and the private rules
// process fail independently, and the overall state is the worst of them. A
// healthy database never proves that the rules process is healthy: only a
// real evaluation proves that, and only a real evaluation may clear a
// degraded rules state.
//
// The liveness record is a bounded singleton. It is refreshed on every check,
// so an unexpected failure can be located after hours of healthy service
// without a growing checkpoint table.

// The health dependencies of the online service.
const (
	// DependencyDatabase is the shared PostgreSQL state.
	DependencyDatabase = "database"
	// DependencyRules is the private pinned rules process.
	DependencyRules = "rules"
)

// ServiceLivenessTTL is how long the liveness record stays valid.
//
// A restart that finds a liveness record older than this knows that the
// service was not seen for at least that long, and derives an interruption
// from it. A restart that finds a fresh record joins the running service
// without touching the epoch of its peers.
const ServiceLivenessTTL = 30 * time.Second

// HealthState is the durable health of one dependency or of the service.
type HealthState string

const (
	// HealthHealthy means the dependency can serve.
	HealthHealthy HealthState = "healthy"
	// HealthDegraded means the dependency still answers, but something it
	// needs is failing.
	HealthDegraded HealthState = "degraded"
	// HealthUnavailable means the dependency cannot serve.
	HealthUnavailable HealthState = "unavailable"
)

// Valid reports whether the state is one of the three durable states.
func (s HealthState) Valid() bool {
	switch s {
	case HealthHealthy, HealthDegraded, HealthUnavailable:
		return true
	default:
		return false
	}
}

// ClaimsAllowed reports whether an abandonment claim may be offered or
// accepted while the service is in this state.
//
// Only a healthy service may offer the claim. The rule is deliberately
// conservative: a degraded service still knows whether an opponent is
// connected, but it cannot be sure that its own view of the match is
// current, so it never hands out a win.
func (s HealthState) ClaimsAllowed() bool { return s == HealthHealthy }

// severity orders the states, so the overall state is the worst dependency.
func (s HealthState) severity() int {
	switch s {
	case HealthHealthy:
		return 0
	case HealthDegraded:
		return 1
	case HealthUnavailable:
		return 2
	default:
		return 2
	}
}

// DependencyHealth is the health of one dependency.
type DependencyHealth struct {
	// State is the observed health.
	State HealthState `json:"state"`
	// Detail is a short, secret-free explanation. It never carries a
	// credential, a route, a connection string, or a raw error.
	Detail string `json:"detail"`
	// RecordedAt is when the observation was made.
	RecordedAt time.Time `json:"recordedAt"`
}

// HealthReport is the health of the online service.
type HealthReport struct {
	// State is the overall state, which is the worst dependency.
	State HealthState `json:"state"`
	// Detail is a short, secret-free explanation of the overall state.
	Detail string `json:"detail"`
	// RecordedAt is when the overall state was last observed.
	RecordedAt time.Time `json:"recordedAt"`
	// Database is the health of the shared state.
	Database DependencyHealth `json:"database"`
	// Rules is the health of the private rules process.
	Rules DependencyHealth `json:"rules"`
}

// HealthReporter records and reads the durable service health.
//
// It is safe for concurrent use. The in-memory copy answers the claim path
// without a database round trip; the checkpoint table keeps the durable
// history, and the liveness singleton locates an unexpected failure.
type HealthReporter struct {
	db *pgxpool.Pool

	mu           sync.RWMutex
	dependencies map[string]DependencyHealth
	order        []string
	// pending is the observation of every dependency that is not durable
	// yet.
	//
	// The observations of the request paths are remembered and not
	// written: a request never waits for the write of a checkpoint.
	pending map[string]pendingReport
	// revision numbers the observations of every dependency.
	//
	// A durable write carries the revision of the observation it writes, so
	// a write that completes after a newer observation never replaces it.
	revision map[string]uint64
}

// pendingReport is one observation that is not durable yet.
type pendingReport struct {
	state    HealthState
	detail   string
	revision uint64
}

// observationSnapshot is one observation with the revision it was made in.
//
// The state and the revision belong together: a writer that publishes a
// snapshot publishes the revision of that observation, never the revision of a
// newer one.
type observationSnapshot struct {
	dependency string
	state      HealthState
	detail     string
	revision   uint64
}

// NewHealthReporter binds a reporter to a pool.
func NewHealthReporter(db *pgxpool.Pool) *HealthReporter {
	return &HealthReporter{
		db:           db,
		dependencies: map[string]DependencyHealth{},
		pending:      map[string]pendingReport{},
		revision:     map[string]uint64{},
	}
}

// Record remembers an observation of a dependency without writing it.
//
// The observation is the local state of the instance, which the claim path
// reads at once, and it is the durable state that the next flush writes. A
// request never waits for the write of a checkpoint.
func (h *HealthReporter) Record(dependency string, state HealthState, detail string) uint64 {
	if h == nil || dependency == "" || !state.Valid() {
		return 0
	}
	if len(detail) > 200 {
		detail = detail[:200]
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, known := h.dependencies[dependency]; !known {
		h.order = append(h.order, dependency)
	}
	h.dependencies[dependency] = DependencyHealth{State: state, Detail: detail, RecordedAt: time.Now().UTC()}
	// The observation replaces the pending one, so a newer observation is
	// never lost behind an older one.
	h.revision[dependency]++
	h.pending[dependency] = pendingReport{state: state, detail: detail, revision: h.revision[dependency]}
	return h.revision[dependency]
}

// Flush writes the observations that are not durable yet.
//
// The flush is the writer of the durable state: the observations of the
// request paths are remembered and written here, with the context of the
// monitor and a short budget. A write that failed leaves the observation
// pending, so the next flush writes it again.
//
// The flush also restores the shared state of a dependency that is worse than
// the local answer: the shared state is the newest checkpoint of every
// dependency, and a healthy instance that answers again restores it.
func (h *HealthReporter) Flush(ctx context.Context) {
	if h == nil {
		return
	}
	h.mu.Lock()
	pending := make(map[string]pendingReport, len(h.pending))
	for dependency, report := range h.pending {
		pending[dependency] = report
	}
	h.mu.Unlock()
	for dependency, report := range pending {
		_, err := h.writeCheckpointIfChanged(ctx, dependency, report.state, report.detail, report.revision)
		if err != nil {
			// The observation stays pending, so the next flush writes it
			// again.
			continue
		}
		h.mu.Lock()
		current, known := h.pending[dependency]
		if known && current.revision == report.revision {
			// The observation was not replaced while the write ran, so
			// it is acknowledged.
			delete(h.pending, dependency)
		}
		h.mu.Unlock()
	}
	// The healthy observations of the instance are captured with the revision
	// they were made in, after the pending observations were written. A
	// snapshot that is published later carries its own revision, so it never
	// borrows the revision of a newer observation.
	h.mu.RLock()
	healthy := make([]observationSnapshot, 0, len(h.order))
	for _, dependency := range h.order {
		observation := h.dependencies[dependency]
		if observation.State != HealthHealthy {
			continue
		}
		healthy = append(healthy, observationSnapshot{
			dependency: dependency,
			state:      observation.State,
			detail:     observation.Detail,
			revision:   h.revision[dependency],
		})
	}
	h.mu.RUnlock()
	for _, snapshot := range healthy {
		_, _ = h.writeCheckpointIfChanged(ctx, snapshot.dependency, snapshot.state, snapshot.detail, snapshot.revision)
	}
}

// ReportBudget bounds the durable report of a dependency.
//
// The report is a database write, so a write that waits for a connection must
// not wait for ever: the observation returns and the next observation writes
// the checkpoint again. The write happens after the guard of the episode is
// released, so the budget of a request is never spent on it.
const ReportBudget = 5 * time.Second

// ReportDependency records one observation of one dependency.
//
// The checkpoint is written only when the state of that dependency changed,
// so a healthy service does not grow a checkpoint row on every pass. The
// liveness record is refreshed only while the service is healthy, so an
// interruption of a dependency is located by the recovery instead of being
// hidden by a fresh liveness record.
func (h *HealthReporter) ReportDependency(ctx context.Context, dependency string, state HealthState, detail string) error {
	if h == nil {
		return ErrInvalidArgument
	}
	if dependency == "" || !state.Valid() {
		return ErrInvalidArgument
	}
	if len(detail) > 200 {
		detail = detail[:200]
	}
	revision := h.Record(dependency, state, detail)
	_, err := h.writeCheckpointIfChanged(ctx, dependency, state, detail, revision)
	return err
}

// writeCheckpointIfChanged writes the checkpoint of a dependency when the
// shared state of the dependency differs from the observation.
//
// The shared state is the newest persisted observation of the dependency, so
// the write is symmetric: a healthy observation and a degraded one are
// written when they are the newest. A stable state writes nothing, so a
// healthy service does not grow a checkpoint row.
//
// The decision, the order and the write are one transaction, and the advisory
// lock of the dependency serializes them with the other instances: two
// writers cannot both read an old shared state and write their answers in
// the wrong order.
//
// The revision of the observation forbids a stale write: an observation that
// was replaced while the writer waited for the lock is not written.
func (h *HealthReporter) writeCheckpointIfChanged(ctx context.Context, dependency string, state HealthState, detail string, revision uint64) (bool, error) {
	if h == nil {
		return false, ErrInvalidArgument
	}
	if dependency == "" || !state.Valid() {
		return false, ErrInvalidArgument
	}
	if len(detail) > 200 {
		detail = detail[:200]
	}
	if h.db == nil {
		// Without a database there is no durable state, so the observation
		// is the state.
		return true, nil
	}
	ctx, cancel := context.WithTimeout(ctx, ReportBudget)
	defer cancel()
	tx, err := h.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('online_service_health'), hashtext($1))`, dependency); err != nil {
		return false, err
	}
	// The observation must still be the newest one of the instance: a newer
	// observation replaced it while the writer waited for the lock.
	//
	// The revision is the lifetime of the observations and it is never
	// removed, so an observation that was acknowledged in the meantime is
	// not overwritten either.
	if h.latestRevision(dependency) > revision {
		// A newer observation exists, so this one is stale.
		return false, nil
	}
	// The shared state is the newest persisted observation of the dependency.
	var shared string
	err = tx.QueryRow(ctx, `SELECT state FROM online_service_health WHERE dependency=$1 ORDER BY observation_order DESC LIMIT 1`, dependency).Scan(&shared)
	switch {
	case err == nil && HealthState(shared) == state:
		// The newest persisted observation is this one already.
		if err = tx.Commit(ctx); err != nil {
			return false, err
		}
		return true, nil
	case err != nil && !errors.Is(err, pgx.ErrNoRows):
		return false, err
	}
	var now time.Time
	if err = tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return false, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_service_health(checkpoint_id,dependency,state,detail,recorded_at) VALUES($1,$2,$3,$4,$5)`,
		healthCheckpointID(dependency, state, now.UTC()), dependency, string(state), detail, now.UTC()); err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	if !h.OverallHealthy() {
		// The service is not healthy, so it is not alive. The liveness
		// record keeps its last value, and the recovery locates the
		// interruption from it.
		return true, nil
	}
	return true, h.refreshLiveness(ctx, now.UTC())
}

// latestRevision returns the revision of the newest observation of a
// dependency.
//
// The revision is the lifetime of the observations: it is never removed, so a
// writer that waited for the durable lock compares against the newest
// observation even when the pending one was acknowledged in the meantime.
func (h *HealthReporter) latestRevision(dependency string) uint64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.revision[dependency]
}

// RefreshDependency writes a checkpoint of a dependency when the shared state
// differs from the current local observation supplied by the caller.
//
// The shared state is the newest persisted observation of every dependency, so
// a healthy instance that answers again restores it and the claim path of the
// healthy instances opens again. The write is the ordinary write of the
// observation, so it is serialized with the other writers of the dependency.
//
// The refresh is not a claim that every instance is healthy. The instance
// whose worker is broken keeps its own state and its own claim path closed;
// the refresh only says that this instance answered.
//
// The revision is captured with the state: a caller that holds an old state
// may not be labelled with the revision of a newer observation, so the
// refresh is only published when the local observation of the dependency is
// still that state.
func (h *HealthReporter) RefreshDependency(ctx context.Context, dependency string, state HealthState, detail string) error {
	if h == nil || h.db == nil {
		return nil
	}
	revision, current := h.revisionOfState(dependency, state)
	if !current {
		// The local observation of the dependency is another state, so the
		// caller's state is stale and it is not published.
		return nil
	}
	_, err := h.writeCheckpointIfChanged(ctx, dependency, state, detail, revision)
	return err
}

// revisionOfState returns the revision of the local observation of a
// dependency when that observation is the given state.
func (h *HealthReporter) revisionOfState(dependency string, state HealthState) (uint64, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	observation, known := h.dependencies[dependency]
	if !known || observation.State != state {
		return 0, false
	}
	return h.revision[dependency], true
}

// OverallHealthy reports whether every observed dependency is healthy.
func (h *HealthReporter) OverallHealthy() bool {
	if h == nil {
		return true
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, name := range h.order {
		if h.dependencies[name].State != HealthHealthy {
			return false
		}
	}
	return true
}

// SharedState returns the health state that every instance of the service
// agrees on.
//
// The state is read from the durable checkpoints, so an instance that never
// saw a failure still refuses to offer a claim while another instance
// recorded one. The in-memory state of the caller is combined with it by the
// caller, and the worse of the two wins.
func (h *HealthReporter) SharedState(ctx context.Context) (HealthState, error) {
	if h == nil || h.db == nil {
		return HealthHealthy, nil
	}
	rows, err := h.db.Query(ctx, `SELECT DISTINCT ON (dependency) dependency,state FROM online_service_health ORDER BY dependency,observation_order DESC`)
	if err != nil {
		return HealthHealthy, err
	}
	defer rows.Close()
	state := HealthHealthy
	for rows.Next() {
		var dependency, value string
		if err = rows.Scan(&dependency, &value); err != nil {
			return HealthHealthy, err
		}
		candidate := HealthState(value)
		if candidate.severity() > state.severity() {
			state = candidate
		}
	}
	if err = rows.Err(); err != nil {
		return HealthHealthy, err
	}
	return state, nil
}

// RefreshLiveness refreshes the durable liveness of the service.
//
// The liveness record is the evidence that the service was alive, so a
// restart of a healthy service is not read as an interruption: the recovery
// derives an unexpected interruption out of a liveness that is older than the
// TTL.
//
// The refresh happens only while every dependency is healthy. A service that
// cannot serve keeps the stale liveness, because that stale record is how the
// recovery locates the interruption.
//
// The refresh writes the one liveness row, so a healthy service does not grow
// a checkpoint row.
func (h *HealthReporter) RefreshLiveness(ctx context.Context) error {
	if h == nil || h.db == nil {
		return nil
	}
	if !h.OverallHealthy() {
		return nil
	}
	// The database clock is authoritative. The liveness row is shared by
	// every instance of the service, so the clock of one host may neither
	// future-date it nor regress it.
	var at time.Time
	if err := h.db.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&at); err != nil {
		return err
	}
	return h.refreshLiveness(ctx, at.UTC())
}

// refreshLiveness upserts the bounded liveness singleton.
//
// The row never grows, so the liveness of a long-running service costs one
// row and one update per check.
func (h *HealthReporter) refreshLiveness(ctx context.Context, at time.Time) error {
	// The liveness never moves backwards. The record is read by the recovery
	// of every instance, so a reader with a skewed clock may not regress it.
	_, err := h.db.Exec(ctx, `INSERT INTO online_service_liveness(singleton,last_seen_at,updated_at) VALUES(true,$1,$1)
ON CONFLICT (singleton) DO UPDATE SET last_seen_at=GREATEST(online_service_liveness.last_seen_at,EXCLUDED.last_seen_at),updated_at=GREATEST(online_service_liveness.updated_at,EXCLUDED.updated_at)`, at.UTC())
	return err
}

// LastLiveness returns the last moment the service was known to be alive.
func (h *HealthReporter) LastLiveness(ctx context.Context) (time.Time, error) {
	if h == nil || h.db == nil {
		return time.Time{}, ErrNotFound
	}
	var at time.Time
	err := h.db.QueryRow(ctx, `SELECT last_seen_at FROM online_service_liveness WHERE singleton`).Scan(&at)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, ErrNotFound
	}
	if err != nil {
		return time.Time{}, err
	}
	return at.UTC(), nil
}

// Current returns the health of the service without touching the database.
//
// The overall state is the worst dependency, so a healthy database never
// hides a broken rules process.
func (h *HealthReporter) Current() HealthReport {
	if h == nil {
		return HealthReport{State: HealthHealthy}
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	report := HealthReport{State: HealthHealthy}
	for _, name := range h.order {
		dependency := h.dependencies[name]
		switch name {
		case DependencyDatabase:
			report.Database = dependency
		case DependencyRules:
			report.Rules = dependency
		}
		if dependency.State.severity() > report.State.severity() {
			report.State = dependency.State
			report.Detail = dependency.Detail
			report.RecordedAt = dependency.RecordedAt
		}
	}
	if report.RecordedAt.IsZero() {
		report.RecordedAt = time.Now().UTC()
	}
	return report
}

// LastCheckpoint returns the durable checkpoint with the greatest observation
// order across all dependencies. RecordedAt is its write time, not its order.
//
// A service that never recorded a checkpoint has ErrNotFound.
func (h *HealthReporter) LastCheckpoint(ctx context.Context) (HealthReport, error) {
	if h == nil || h.db == nil {
		return HealthReport{}, ErrNotFound
	}
	var report HealthReport
	var state string
	err := h.db.QueryRow(ctx, `SELECT state,detail,recorded_at FROM online_service_health ORDER BY observation_order DESC LIMIT 1`).
		Scan(&state, &report.Detail, &report.RecordedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return HealthReport{}, ErrNotFound
	}
	if err != nil {
		return HealthReport{}, err
	}
	report.State = HealthState(state)
	report.RecordedAt = report.RecordedAt.UTC()
	return report, nil
}

// WithHealthReporter installs the durable health boundary.
//
// Without one the writer assumes a healthy service, because a writer that is
// running and answering requests is by definition available.
func WithHealthReporter(reporter *HealthReporter) Option {
	return func(s *Service) { s.health = reporter }
}

// WithBusyClassifier installs the classifier of an occupied rules process.
//
// A busy process is not a broken dependency, so the probe leaves the
// durable health alone and records no interruption.
func WithBusyClassifier(classify func(error) bool) Option {
	return func(s *Service) { s.busyClassifier = classify }
}

// WithCancellationClassifier installs the classifier of a cancelled
// evaluation.
//
// A caller that goes away is not a broken dependency. The classifier tells
// the writer that an evaluation was cancelled by its caller, so the durable
// health of the rules dependency is not downgraded by a departing client.
func WithCancellationClassifier(classify func(error) bool) Option {
	return func(s *Service) { s.cancellation = classify }
}

// cancelled reports whether an evaluation was cancelled by its caller.
func (s *Service) cancelled(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	if s.cancellation != nil {
		return s.cancellation(err)
	}
	return false
}

// Health returns the current health of the online service.
func (s *Service) Health(ctx context.Context) (HealthReport, error) {
	if s.health == nil {
		return HealthReport{State: HealthHealthy}, nil
	}
	return s.health.Current(), nil
}

// healthState returns the health state the claim path consumes.
//
// The state is the worse of the local observation and the durable shared
// state, so an instance that never saw a failure still refuses to offer a
// claim while another instance recorded one.
func (s *Service) healthState(ctx context.Context) HealthState {
	if s.health == nil {
		return HealthHealthy
	}
	local := s.health.Current().State
	if !local.Valid() {
		return HealthUnavailable
	}
	shared, err := s.health.SharedState(ctx)
	if err != nil || !shared.Valid() {
		// A shared health state that cannot be read is an unavailable
		// service, never a healthy one. The claim path fails closed, so a
		// service that cannot confirm its own health never hands out a win.
		return HealthUnavailable
	}
	if shared.severity() > local.severity() {
		return shared
	}
	return local
}

// ProbeBudget is the time the rules health probe may take.
//
// The probe has no budget of its own: it uses the bound of the rules client
// itself, so the probe never cancels an exchange that the client would have
// answered. A caller that goes away still cancels the probe, and a client
// that reports itself busy is not a broken dependency.
const ProbeBudget = 0

// ErrRulesBusy reports that the rules process is occupied by a running
// request.
//
// A busy process is not a broken dependency, so a probe that finds the
// process occupied leaves the durable health alone and records no
// interruption.
//
// The rules client reports its taxonomy in three classes:
//
//   - the caller cancelled or the caller deadline passed: the context error.
//     The caller went away, so the dependency is untouched.
//   - the slot was occupied: ErrRulesBusy. The process is healthy and busy.
//   - the exchange exceeded the internal bound of the worker: the error of
//     the worker. That is an outage of the dependency.
var ErrRulesBusy = errors.New("online: the rules process is busy")

// ReadyEvaluator reports the readiness of the rules process.
//
// The seam exists so the client can tell a busy process from a hung one: a
// busy process answers with ErrRulesBusy, a hung one answers with the failure
// of the process, and a caller that went away answers with the context error.
//
// The probe uses the seam when the evaluator has one, and falls back to a real
// setup exchange otherwise. The exchange is a real request, so an idle hung
// process is an outage in both cases.
type ReadyEvaluator interface {
	// Probe reports whether the rules process can serve a request.
	Probe(ctx context.Context) error
}

// RepairableEvaluator replaces the rules process and proves that the
// replacement answers.
//
// The seam is the recovery of a closed gate. A check never starts a worker,
// so a worker that is gone cannot be brought back by a check: the recovery
// needs a call that starts the replacement and proves that it answers.
//
// The service serves no traffic while its gate is closed, so the cold start
// of the replacement belongs to the recovery and not to a participant
// request.
type RepairableEvaluator interface {
	// Repair starts the rules process when it is not running and proves
	// that it answers.
	Repair(ctx context.Context) error
}

// ProbeRules checks that the private rules process answers.
//
// The probe evaluates the primary rules process, so its answer is evidence
// about the process that serves the traffic. A probe that answers can recover
// an interruption of that process, and a probe that fails never does.
//
// The probe uses the bound of the rules client, so a hung process ends in the
// client's own timeout and stays an outage. A process that is busy with a
// request reports ErrRulesBusy, and a caller that goes away cancels the
// probe. Neither of them is a broken dependency.
func (s *Service) ProbeRules(ctx context.Context) error {
	if s.evaluator == nil {
		s.noteEvaluatorFailure(nil)
		return ErrUnavailable
	}
	// The epoch of the outage is read before the check, so the failure of
	// this check is identified with the epoch it happened in. The number of
	// the observation is taken first, so the order of a success and of a
	// failure is the order of the moments they were made in.
	seq := s.observationSeq.Add(1)
	causal, _ := s.causalEpoch(ctx)
	if ready, ok := s.evaluator.(ReadyEvaluator); ok {
		if err := ready.Probe(ctx); err != nil {
			// The caller of the probe left, so the failure says nothing
			// about the dependency. The client may report its own error
			// for the cause, so the context of the caller decides.
			if ctx.Err() != nil {
				return err
			}
			if s.busy(err) || s.cancelled(err) {
				return err
			}
			s.observeFailure(ctx, causal, seq, err, true)
			return err
		}
		s.observeSuccess(ctx, seq, true)
		return nil
	}
	probeCtx := ctx
	if ProbeBudget > 0 {
		var cancel context.CancelFunc
		probeCtx, cancel = context.WithTimeout(ctx, ProbeBudget)
		defer cancel()
	}
	input := probeRulesInput()
	if err := s.evaluator.ValidateSetup(probeCtx, input); err != nil {
		if s.busy(err) {
			// The process is occupied by a running request. That is not a
			// broken dependency.
			return err
		}
		if s.cancelled(err) {
			// The caller went away. That is not a broken dependency
			// either.
			return err
		}
		s.observeFailure(ctx, causal, seq, err, true)
		return err
	}
	s.observeSuccess(ctx, seq, true)
	return nil
}

// causalEpoch reads the service epoch before a check of the rules dependency.
//
// The epoch identifies the outage. The interruption of an outage is planned
// once, and the plan of the same outage finds the boundary of the first plan
// even when a peer recovered it in between.
//
// A read that fails returns zero. The identity of the episode is then
// unknown, and the episode keeps the identity it had. The interruption is
// still planned, so an unreadable epoch never hides an outage: the plan
// falls back to the epoch of the plan itself.
func (s *Service) causalEpoch(ctx context.Context) (int64, error) {
	if s.db == nil {
		return 0, nil
	}
	return currentServiceEpoch(ctx, s.db)
}

// observeFailure records a failed observation of the rules dependency.
//
// The ordered decision, the update of the episode and the report of the
// dependency happen in one critical section, so a success that completes in
// between can neither hide the failure nor be hidden by it.
//
// A busy or a cancelled observation is not a broken dependency, so it opens no
// episode and it leaves the durable health alone.
//
// A failure that is older than the newest success is stale: the dependency
// answered after that failure was made, so it neither opens an episode nor
// degrades the dependency.
func (s *Service) observeFailure(ctx context.Context, causal int64, seq int64, err error, durable bool) {
	s.episodeMu.Lock()
	if s.busy(err) || s.cancelled(err) {
		s.episodeMu.Unlock()
		return
	}
	if seq < s.latestSuccessSeq {
		s.episodeMu.Unlock()
		return
	}
	if !s.episodeOpen {
		s.episodeOpen = true
		s.episodeEpoch = causal
		s.episodeFirstSeq = seq
		s.latestFailureSeq = seq
		s.episodePlanned = false
		s.episodeBoundary = ""
		revision := s.recordRulesDegraded()
		s.episodeMu.Unlock()
		s.writeRulesDegraded(ctx, durable, revision)
		return
	}
	if seq < s.episodeFirstSeq {
		// This observation is older than the first one of the episode, so
		// it is the earliest observation. The identity of the episode
		// belongs to it, but only while no interruption was planned with
		// the identity: a planned interruption is immutable.
		if !s.episodePlanned {
			s.episodeFirstSeq = seq
			s.episodeEpoch = causal
		}
		revision := s.recordRulesDegraded()
		s.episodeMu.Unlock()
		s.writeRulesDegraded(ctx, durable, revision)
		return
	}
	if seq > s.latestFailureSeq {
		s.latestFailureSeq = seq
	}
	revision := s.recordRulesDegraded()
	s.episodeMu.Unlock()
	s.writeRulesDegraded(ctx, durable, revision)
}

// observeSuccess records a successful observation of the rules dependency.
//
// The ordered decision, the update of the episode and the report of the
// dependency happen in one critical section. A success that is not newer
// than the newest failure answered before that failure, so it neither closes
// the episode nor reports the dependency as healthy: the healthy report would
// hide the dependency that is still broken.
func (s *Service) observeSuccess(ctx context.Context, seq int64, durable bool) {
	s.episodeMu.Lock()
	if seq > s.latestSuccessSeq {
		s.latestSuccessSeq = seq
	}
	if s.episodeOpen {
		if seq <= s.latestFailureSeq {
			s.episodeMu.Unlock()
			return
		}
		s.episodeOpen = false
		s.episodeEpoch = 0
		s.episodeFirstSeq = 0
		s.episodePlanned = false
		s.episodeBoundary = ""
	}
	revision := s.recordRulesHealthy()
	s.episodeMu.Unlock()
	s.writeRulesHealthy(ctx, durable, revision)
}

// recordRulesDegraded records the local observation of a broken dependency.
//
// The observation is recorded under the guard of the episode, so the ordered
// decision and the local state that the claim path reads are one step.
func (s *Service) recordRulesDegraded() uint64 {
	if s.health == nil {
		return 0
	}
	return s.health.Record(DependencyRules, HealthDegraded, "the rules process did not answer")
}

// recordRulesHealthy records the local observation of a healthy dependency.
//
// The observation is recorded under the guard of the episode, so the ordered
// decision and the local state that the claim path reads are one step.
func (s *Service) recordRulesHealthy() uint64 {
	if s.health == nil {
		return 0
	}
	return s.health.Record(DependencyRules, HealthHealthy, "the rules process answered")
}

// writeRulesDegraded writes the checkpoint of a broken dependency.
//
// The write happens after the guard of the episode is released, so a request
// never waits for the write of the monitor. The write of a request path is
// left to the next flush of the monitor.
func (s *Service) writeRulesDegraded(ctx context.Context, durable bool, revision uint64) {
	if s.health == nil || !durable {
		return
	}
	_, _ = s.health.writeCheckpointIfChanged(ctx, DependencyRules, HealthDegraded, "the rules process did not answer", revision)
}

// writeRulesHealthy writes the checkpoint of a healthy dependency.
//
// The write happens after the guard of the episode is released, so a request
// never waits for the write of the monitor. The write of a request path is
// left to the next flush of the monitor.
//
// The shared state is the newest checkpoint of every dependency, so a healthy
// instance that answers again restores it and the claim path of the healthy
// instances opens again. The refresh is not a claim that every instance is
// healthy: the instance whose worker is broken keeps its own state and its
// own claim path closed.
func (s *Service) writeRulesHealthy(ctx context.Context, durable bool, revision uint64) {
	if s.health == nil || !durable {
		return
	}
	_, _ = s.health.writeCheckpointIfChanged(ctx, DependencyRules, HealthHealthy, "the rules process answered", revision)
}

// RepairRules replaces the rules process and proves that the replacement
// answers.
//
// It is the recovery of a closed gate. A check never starts a worker, so a
// worker that is gone cannot be brought back by a check: the recovery needs
// a call that starts the replacement and proves that it answers. The
// service serves no traffic while its gate is closed, so the cold start of
// the replacement belongs here and not to a participant request.
//
// A failed repair is a failure: the caller keeps the gate closed, retries
// the repair, and never recovers the interruption on a failure. A process
// that is busy is not a broken dependency, so it leaves the durable health
// alone, exactly like a busy check does.
func (s *Service) RepairRules(ctx context.Context) error {
	if s.evaluator == nil {
		s.noteEvaluatorFailure(nil)
		return ErrUnavailable
	}
	// The epoch of the outage is read before the repair, so the failure of
	// this repair is identified with the epoch it happened in.
	seq := s.observationSeq.Add(1)
	causal, _ := s.causalEpoch(ctx)
	repairer, ok := s.evaluator.(RepairableEvaluator)
	if !ok {
		// The evaluator cannot replace the process, so the recovery falls
		// back to the check. A check never starts a worker, so the gate of
		// a missing worker stays closed until the traffic brings it back.
		return s.ProbeRules(ctx)
	}
	if err := repairer.Repair(ctx); err != nil {
		// The caller of the repair left, so the failure says nothing about
		// the dependency. The client may report its own error for the
		// cause, so the context of the caller decides.
		if ctx.Err() != nil {
			return err
		}
		if s.busy(err) || s.cancelled(err) {
			return err
		}
		s.observeFailure(ctx, causal, seq, err, true)
		return err
	}
	s.observeSuccess(ctx, seq, true)
	return nil
}

// busy reports whether an evaluation found the rules process occupied.
//
// The busy error of the rules client is its own, so the composition
// installs the classifier that knows it.
func (s *Service) busy(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, ErrRulesBusy) {
		return true
	}
	if s.busyClassifier != nil {
		return s.busyClassifier(err)
	}
	return false
}

// probeRulesInput is the fixed, versioned input of the rules probe.
//
// It is the standard starting position with the standard time control, so the
// probe exercises the same pinned policy as a real evaluation.
func probeRulesInput() RulesInput {
	match := Match{
		SchemaVersion:      ContractsSchemaVersion,
		MatchID:            "rules-probe-0001",
		Variant:            "orthodox",
		StartingFEN:        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
		PositionFEN:        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
		TimeControl:        TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Version:            1,
		ControlEpoch:       1,
		RulesPolicyVersion: DefaultRulesPolicyVersion,
		Status:             MatchActive,
		Clock:              InitialClock(TimeControl{StartingTimeMs: 300_000, IncrementMs: 0}),
	}
	return BuildRulesInput(match, nil, "")
}

// noteEvaluatorFailure records that the rules process failed.
//
// A failing rules service is a service outage, not an absent opponent, so
// the failure downgrades the rules dependency and the claim option disappears
// until a real evaluation succeeds again.
//
// The observation is numbered, so the failure follows the same order as the
// successes: a failure that is older than the newest success is stale and it
// does not degrade the dependency.
func (s *Service) noteEvaluatorFailure(err error) {
	s.observeFailure(context.Background(), 0, s.observationSeq.Add(1), err, true)
}

// healthCheckpointID mints the identity of one durable checkpoint.
//
// The identity carries the dependency, the state, the observation time and a
// random suffix, so two observations of the same dependency never collide and
// the newest checkpoint of a dependency is the one with the newest identity.
func healthCheckpointID(dependency string, state HealthState, at time.Time) string {
	raw := make([]byte, 6)
	if _, err := rand.Read(raw); err != nil {
		return "chk-" + dependency + "-" + string(state) + "-" + at.UTC().Format("20060102T150405000000000")
	}
	return "chk-" + dependency + "-" + string(state) + "-" + at.UTC().Format("20060102T150405000000000") + "-" + hex.EncodeToString(raw)
}
