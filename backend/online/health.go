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
}

// NewHealthReporter binds a reporter to a pool.
func NewHealthReporter(db *pgxpool.Pool) *HealthReporter {
	return &HealthReporter{db: db, dependencies: map[string]DependencyHealth{}}
}

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
	recordedAt := time.Now().UTC()
	h.mu.Lock()
	if _, known := h.dependencies[dependency]; !known {
		h.order = append(h.order, dependency)
	}
	previous, had := h.dependencies[dependency]
	h.dependencies[dependency] = DependencyHealth{State: state, Detail: detail, RecordedAt: recordedAt}
	h.mu.Unlock()
	changed := !had || previous.State != state
	if h.db == nil {
		return nil
	}
	var now time.Time
	if err := h.db.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return err
	}
	if changed {
		if _, err := h.db.Exec(ctx, `INSERT INTO online_service_health(checkpoint_id,dependency,state,detail,recorded_at) VALUES($1,$2,$3,$4,$5)`,
			healthCheckpointID(dependency, state, now.UTC()), dependency, string(state), detail, now.UTC()); err != nil {
			return err
		}
	}
	if !h.OverallHealthy() {
		// The service is not healthy, so it is not alive. The liveness
		// record keeps its last value, and the recovery locates the
		// interruption from it.
		return nil
	}
	return h.refreshLiveness(ctx, now.UTC())
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
	rows, err := h.db.Query(ctx, `SELECT DISTINCT ON (dependency) dependency,state FROM online_service_health ORDER BY dependency,recorded_at DESC,checkpoint_id DESC`)
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

// refreshLiveness upserts the bounded liveness singleton.
//
// The row never grows, so the liveness of a long-running service costs one
// row and one update per check.
func (h *HealthReporter) refreshLiveness(ctx context.Context, at time.Time) error {
	_, err := h.db.Exec(ctx, `INSERT INTO online_service_liveness(singleton,last_seen_at,updated_at) VALUES(true,$1,$1)
ON CONFLICT (singleton) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at,updated_at=EXCLUDED.updated_at`, at.UTC())
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

// LastCheckpoint returns the newest durable checkpoint.
//
// A service that never recorded a checkpoint has ErrNotFound, which the
// recovery path reads as "no known interruption".
func (h *HealthReporter) LastCheckpoint(ctx context.Context) (HealthReport, error) {
	if h == nil || h.db == nil {
		return HealthReport{}, ErrNotFound
	}
	var report HealthReport
	var state string
	err := h.db.QueryRow(ctx, `SELECT state,detail,recorded_at FROM online_service_health ORDER BY recorded_at DESC, checkpoint_id DESC LIMIT 1`).
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
		s.noteEvaluatorFailure(err)
		return err
	}
	s.noteEvaluatorSuccess()
	return nil
}

// busy reports whether an evaluation found the rules process occupied.
func (s *Service) busy(err error) bool {
	return err != nil && errors.Is(err, ErrRulesBusy)
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
func (s *Service) noteEvaluatorFailure(err error) {
	if s.health == nil {
		return
	}
	// A cancelled evaluation is a departing caller, not a broken
	// dependency. The durable health of the rules dependency stays.
	if s.cancelled(err) {
		return
	}
	_ = s.health.ReportDependency(context.Background(), DependencyRules, HealthDegraded, "the rules process did not answer")
}

// noteEvaluatorSuccess records that the rules process answered again.
//
// Only a real evaluation clears a degraded rules state. A healthy database
// never does.
func (s *Service) noteEvaluatorSuccess() {
	if s.health == nil {
		return
	}
	if s.health.Current().Rules.State == HealthHealthy {
		return
	}
	_ = s.health.ReportDependency(context.Background(), DependencyRules, HealthHealthy, "the rules process answered")
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
