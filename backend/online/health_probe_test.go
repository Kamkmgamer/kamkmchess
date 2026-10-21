package online

import (
	"context"
	"errors"
	"sync"
	"testing"
)

// The health boundary of the rules dependency.
//
// A departing client is not a broken dependency, and a probe that can boot
// on its own process never recovers an outage of the primary one.

// cancellingEvaluator fails every evaluation with the given error.
type cancellingEvaluator struct {
	err error
}

func (e cancellingEvaluator) ValidateSetup(context.Context, RulesInput) error { return e.err }

func (e cancellingEvaluator) Evaluate(context.Context, RulesInput) (Candidate, error) {
	return Candidate{}, e.err
}

// failingEvaluator fails every evaluation with a broken dependency.
type failingEvaluator struct{}

func (failingEvaluator) ValidateSetup(context.Context, RulesInput) error {
	return errors.New("the rules process is down")
}

func (failingEvaluator) Evaluate(context.Context, RulesInput) (Candidate, error) {
	return Candidate{}, errors.New("the rules process is down")
}

// TestHealthIgnoresACancelledEvaluation covers the cancellation of a caller.
//
// A client that goes away is not a broken dependency, so the durable health
// of the rules dependency stays healthy and no interruption is recorded.
func TestHealthIgnoresACancelledEvaluation(t *testing.T) {
	reporter := NewHealthReporter(nil)
	service := &Service{health: reporter}
	service.noteEvaluatorSuccess()
	if err := reporter.ReportDependency(context.Background(), DependencyRules, HealthHealthy, "the rules process answered"); err != nil {
		t.Fatal(err)
	}
	// The evaluation of a departing client is cancelled.
	service.noteEvaluatorFailure(context.Canceled)
	if state := reporter.Current().Rules.State; state != HealthHealthy {
		t.Fatalf("the rules dependency = %q after a cancelled evaluation, want %q", state, HealthHealthy)
	}
	// The custom cancellation of the rules client is a cancellation as well.
	service.cancellation = func(err error) bool { return errors.Is(err, errCanceledForTest) }
	service.noteEvaluatorFailure(errCanceledForTest)
	if state := reporter.Current().Rules.State; state != HealthHealthy {
		t.Fatalf("the rules dependency = %q after a cancelled evaluation, want %q", state, HealthHealthy)
	}
}

// errCanceledForTest is the custom cancellation of a rules client.
var errCanceledForTest = errors.New("rules worker request was canceled")

// TestProbeNeverRecoversARealOutage covers the recovery contract of the
// probe.
//
// The probe evaluates the primary rules process, so its answer is evidence
// about the process that serves the traffic. A probe that answers recovers an
// interruption of that process, and a probe that fails never does.
func TestProbeNeverRecoversARealOutage(t *testing.T) {
	reporter := NewHealthReporter(nil)
	service := &Service{health: reporter, evaluator: failingEvaluator{}}
	// The primary process fails.
	service.noteEvaluatorFailure(errors.New("the rules process is down"))
	if state := reporter.Current().Rules.State; state != HealthDegraded {
		t.Fatalf("the rules dependency = %q, want %q", state, HealthDegraded)
	}
	// The probe fails with the primary, so the dependency stays degraded.
	if err := service.ProbeRules(context.Background()); err == nil {
		t.Fatal("the probe of a broken primary answered")
	}
	if state := reporter.Current().Rules.State; state != HealthDegraded {
		t.Fatalf("the rules dependency = %q after a failed probe, want %q", state, HealthDegraded)
	}
	// A real evaluation of the primary process clears the dependency.
	service.noteEvaluatorSuccess()
	if state := reporter.Current().Rules.State; state != HealthHealthy {
		t.Fatalf("the rules dependency = %q after a real evaluation, want %q", state, HealthHealthy)
	}
}

// TestProbeDoesNotMistakeABusyPrimaryForAnOutage covers the busy primary.
//
// A primary that is occupied by a running request reports itself busy. A busy
// primary is not a broken dependency, so the durable health stays and no
// interruption is recorded.
func TestProbeDoesNotMistakeABusyPrimaryForAnOutage(t *testing.T) {
	reporter := NewHealthReporter(nil)
	busy := &busyEvaluator{release: make(chan struct{}), entered: make(chan struct{})}
	service := &Service{health: reporter, evaluator: busy}
	if err := reporter.ReportDependency(context.Background(), DependencyRules, HealthHealthy, "the rules process answered"); err != nil {
		t.Fatal(err)
	}
	// A request occupies the shared client.
	go func() {
		_, _ = busy.Evaluate(context.Background(), RulesInput{})
	}()
	<-busy.entered
	// The probe finds the process occupied.
	if err := service.ProbeRules(context.Background()); err == nil {
		t.Fatal("the probe of a busy primary answered")
	} else if !errors.Is(err, ErrRulesBusy) {
		t.Fatalf("the probe of a busy primary = %v, want %v", err, ErrRulesBusy)
	}
	close(busy.release)
	if state := reporter.Current().Rules.State; state != HealthHealthy {
		t.Fatalf("the rules dependency = %q after a busy primary, want %q", state, HealthHealthy)
	}
}

// TestProbeTreatsAHungPrimaryAsAnOutage covers the hung primary.
//
// A process that never answers ends in the internal timeout of the worker,
// and that timeout is an outage of the dependency.
func TestProbeTreatsAHungPrimaryAsAnOutage(t *testing.T) {
	reporter := NewHealthReporter(nil)
	service := &Service{health: reporter, evaluator: hungEvaluator{}}
	if err := reporter.ReportDependency(context.Background(), DependencyRules, HealthHealthy, "the rules process answered"); err != nil {
		t.Fatal(err)
	}
	if err := service.ProbeRules(context.Background()); err == nil {
		t.Fatal("the probe of a hung primary answered")
	}
	if state := reporter.Current().Rules.State; state != HealthDegraded {
		t.Fatalf("the rules dependency = %q after a hung primary, want %q", state, HealthDegraded)
	}
}

// busyEvaluator reports that the rules process is occupied by a running
// request.
//
// The busy report is the evidence of the occupancy, so it is told apart from
// a hung process, which ends in the internal timeout of the worker.
type busyEvaluator struct {
	release chan struct{}
	entered chan struct{}
	once    sync.Once
}

func (e *busyEvaluator) ValidateSetup(context.Context, RulesInput) error {
	// The client knows that the slot is occupied, so it reports the
	// occupancy without waiting for the running request.
	return ErrRulesBusy
}

func (e *busyEvaluator) Evaluate(ctx context.Context, _ RulesInput) (Candidate, error) {
	e.once.Do(func() { close(e.entered) })
	select {
	case <-e.release:
		return Candidate{}, nil
	case <-ctx.Done():
		return Candidate{}, ErrRulesBusy
	}
}

// hungEvaluator never answers. The internal bound of the worker ends it, and
// that timeout is an outage of the dependency.
type hungEvaluator struct{}

func (hungEvaluator) ValidateSetup(context.Context, RulesInput) error {
	return errors.New("rules worker timed out")
}

func (hungEvaluator) Evaluate(context.Context, RulesInput) (Candidate, error) {
	return Candidate{}, errors.New("rules worker timed out")
}
