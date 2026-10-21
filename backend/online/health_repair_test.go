package online

import (
	"context"
	"errors"
	"testing"
)

// The recovery seam of the rules dependency.
//
// A check never starts a worker, so a worker that is gone cannot be brought
// back by a check. The recovery of a closed gate is a repair: it starts the
// replacement of the same client and proves that it answers.

// repairableEvaluator records the calls of the service.
type repairableEvaluator struct {
	probeErr  error
	repairErr error
	probes    int
	repairs   int
}

func (e *repairableEvaluator) ValidateSetup(context.Context, RulesInput) error { return nil }

func (e *repairableEvaluator) Evaluate(context.Context, RulesInput) (Candidate, error) {
	return Candidate{}, nil
}

func (e *repairableEvaluator) Probe(context.Context) error {
	e.probes++
	return e.probeErr
}

func (e *repairableEvaluator) Repair(context.Context) error {
	e.repairs++
	return e.repairErr
}

// probeOnlyEvaluator cannot replace the process.
type probeOnlyEvaluator struct {
	probes int
}

func (e *probeOnlyEvaluator) ValidateSetup(context.Context, RulesInput) error { return nil }

func (e *probeOnlyEvaluator) Evaluate(context.Context, RulesInput) (Candidate, error) {
	return Candidate{}, nil
}

func (e *probeOnlyEvaluator) Probe(context.Context) error {
	e.probes++
	return nil
}

// A repair replaces the worker instead of checking it.
//
// The check of a worker that is not running answers the busy class, because a
// check never starts a worker. The recovery of a closed gate therefore needs
// the other call, and the service has to use it.
func TestRepairRulesReplacesTheWorkerInsteadOfProbingIt(t *testing.T) {
	evaluator := &repairableEvaluator{}
	service := &Service{evaluator: evaluator, health: NewHealthReporter(nil)}
	if err := service.RepairRules(context.Background()); err != nil {
		t.Fatalf("the repair: %v", err)
	}
	if evaluator.repairs != 1 {
		t.Fatalf("the repairs = %d, want 1", evaluator.repairs)
	}
	if evaluator.probes != 0 {
		t.Fatalf("the checks = %d, want none beside the repair", evaluator.probes)
	}
}

// A failed repair is a failure.
//
// The caller keeps the gate closed and retries the repair, so the dependency
// has to be downgraded: a repair that never proved a worker may not leave the
// dependency healthy.
func TestRepairRulesFailsOnAFailedRepair(t *testing.T) {
	evaluator := &repairableEvaluator{repairErr: errors.New("the rules process did not answer")}
	reporter := NewHealthReporter(nil)
	service := &Service{evaluator: evaluator, health: reporter}
	if err := service.RepairRules(context.Background()); err == nil {
		t.Fatal("the repair of a broken worker answered")
	}
	if state := reporter.Current().Rules.State; state != HealthDegraded {
		t.Fatalf("the rules dependency = %q after a failed repair, want %q", state, HealthDegraded)
	}
}

// A busy worker is not a broken dependency.
//
// The replacement of a worker that is busy with a request leaves the durable
// health alone, exactly like a busy check does.
func TestRepairRulesLeavesTheHealthAloneOnABusyRepair(t *testing.T) {
	evaluator := &repairableEvaluator{repairErr: ErrRulesBusy}
	reporter := NewHealthReporter(nil)
	service := &Service{evaluator: evaluator, health: reporter}
	service.noteEvaluatorSuccess()
	if err := service.RepairRules(context.Background()); err == nil {
		t.Fatal("the repair of a busy worker answered")
	}
	if state := reporter.Current().Rules.State; state != HealthHealthy {
		t.Fatalf("the rules dependency = %q after a busy repair, want %q", state, HealthHealthy)
	}
}

// An evaluator without the repair seam falls back to the check.
//
// The check never starts a worker, so the gate of a missing worker stays
// closed until the traffic brings it back. The fallback keeps the service
// honest instead of pretending that a replacement was proven.
func TestRepairRulesFallsBackToTheCheckWithoutTheRepairSeam(t *testing.T) {
	evaluator := &probeOnlyEvaluator{}
	service := &Service{evaluator: evaluator, health: NewHealthReporter(nil)}
	if err := service.RepairRules(context.Background()); err != nil {
		t.Fatalf("the repair: %v", err)
	}
	if evaluator.probes != 1 {
		t.Fatalf("the checks = %d, want 1", evaluator.probes)
	}
}
