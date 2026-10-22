package serverapp

import (
	"context"
	"errors"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/rulesworker"
)

// The health monitor of the rules dependency.
//
// The gate decides which call belongs to the moment. A closed gate is
// repaired, because a check never starts a worker and the worker is gone
// after the outage that closed the gate. An open gate is only checked.

// fakeRulesHealth records the calls of the monitor.
type fakeRulesHealth struct {
	pending    *online.RecoveryBoundary
	pendingErr error
	probeErr   error
	repairErr  error
	probes     int
	repairs    int
	suspension int
	recoveries int
}

func (f *fakeRulesHealth) ProbeRules(context.Context) error {
	f.probes++
	return f.probeErr
}

func (f *fakeRulesHealth) RepairRules(context.Context) error {
	f.repairs++
	return f.repairErr
}

func (f *fakeRulesHealth) PendingSuspension(context.Context) (*online.RecoveryBoundary, error) {
	return f.pending, f.pendingErr
}

func (f *fakeRulesHealth) SuspendForDependency(context.Context, string) error {
	f.suspension++
	return nil
}

func (f *fakeRulesHealth) RecoverFromInterruption(context.Context) (online.RecoveryPlan, error) {
	f.recoveries++
	return online.RecoveryPlan{}, nil
}

// A closed gate is repaired instead of probed.
//
// The check of a worker that is not running answers the busy class, so the
// monitor would read a closed gate as a healthy dependency and the service
// would never come back. The repair starts the replacement of the same client
// and proves that it answers.
func TestHealthMonitorRepairsAClosedGateInsteadOfProbingIt(t *testing.T) {
	prober := &fakeRulesHealth{pending: &online.RecoveryBoundary{}}
	var reported []error
	checkRulesHealth(context.Background(), prober, func(err error) { reported = append(reported, err) })
	if prober.repairs != 1 {
		t.Fatalf("the repairs = %d, want 1", prober.repairs)
	}
	if prober.probes != 0 {
		t.Fatalf("the checks = %d, want none beside the repair", prober.probes)
	}
	if prober.recoveries != 1 {
		t.Fatalf("the recoveries = %d, want 1", prober.recoveries)
	}
	if len(reported) != 0 {
		t.Fatalf("the monitor reported %v", reported)
	}
}

// A failed repair is never a recovery.
//
// The gate stays closed, the failure is reported, and the next tick repairs
// again. Recovering on a failure would publish a dependency that was never
// proven.
func TestHealthMonitorNeverRecoversOnAFailedRepair(t *testing.T) {
	prober := &fakeRulesHealth{pending: &online.RecoveryBoundary{}, repairErr: errors.New("the rules process did not answer")}
	var reported []error
	checkRulesHealth(context.Background(), prober, func(err error) { reported = append(reported, err) })
	if prober.repairs != 1 {
		t.Fatalf("the repairs = %d, want 1", prober.repairs)
	}
	if prober.recoveries != 0 {
		t.Fatalf("the recoveries = %d after a failed repair, want none", prober.recoveries)
	}
	if len(reported) != 1 {
		t.Fatalf("the reported failures = %d, want 1", len(reported))
	}
	// The next tick repairs again, and it still recovers nothing.
	checkRulesHealth(context.Background(), prober, func(err error) { reported = append(reported, err) })
	if prober.repairs != 2 {
		t.Fatalf("the repairs = %d after the retry, want 2", prober.repairs)
	}
	if prober.recoveries != 0 {
		t.Fatalf("the recoveries = %d after the retry, want none", prober.recoveries)
	}
}

// An open gate is only checked.
//
// The check never starts a worker either, so the cold start of the worker
// stays with the traffic that needs it.
func TestHealthMonitorChecksAnOpenGate(t *testing.T) {
	prober := &fakeRulesHealth{}
	var reported []error
	checkRulesHealth(context.Background(), prober, func(err error) { reported = append(reported, err) })
	if prober.probes != 1 {
		t.Fatalf("the checks = %d, want 1", prober.probes)
	}
	if prober.repairs != 0 {
		t.Fatalf("the repairs = %d, want none", prober.repairs)
	}
	if prober.recoveries != 0 {
		t.Fatalf("the recoveries = %d, want none", prober.recoveries)
	}
	if len(reported) != 0 {
		t.Fatalf("the monitor reported %v", reported)
	}
}

// A broken worker closes the gate.
//
// The interruption is recorded as a durable boundary, so the clock of the
// unfinished matches is refunded when the dependency comes back, and the
// repair of the next tick brings it back.
func TestHealthMonitorSuspendsTheDependencyWhenTheCheckFails(t *testing.T) {
	prober := &fakeRulesHealth{probeErr: errors.New("the rules process did not answer")}
	var reported []error
	checkRulesHealth(context.Background(), prober, func(err error) { reported = append(reported, err) })
	if prober.probes != 1 {
		t.Fatalf("the checks = %d, want 1", prober.probes)
	}
	if prober.suspension != 1 {
		t.Fatalf("the interruptions = %d, want 1", prober.suspension)
	}
	if prober.repairs != 0 {
		t.Fatalf("the repairs = %d, want none", prober.repairs)
	}
	if len(reported) != 1 {
		t.Fatalf("the reported failures = %d, want 1", len(reported))
	}
}

// A busy worker is not an outage.
//
// The worker is occupied by a running request, so the service keeps serving
// and no interruption is recorded. The gate stays open, so the cold start
// stays with the traffic.
func TestHealthMonitorDoesNotSuspendOnABusyCheck(t *testing.T) {
	for name, failure := range map[string]error{
		"the translated busy class": online.ErrRulesBusy,
		"the raw busy class":        rulesworker.ErrBusy,
	} {
		t.Run(name, func(t *testing.T) {
			prober := &fakeRulesHealth{probeErr: failure}
			var reported []error
			checkRulesHealth(context.Background(), prober, func(err error) { reported = append(reported, err) })
			if prober.probes != 1 {
				t.Fatalf("the checks = %d, want 1", prober.probes)
			}
			if prober.suspension != 0 {
				t.Fatalf("the interruptions = %d, want none", prober.suspension)
			}
			if prober.repairs != 0 {
				t.Fatalf("the repairs = %d, want none", prober.repairs)
			}
			if len(reported) != 1 {
				t.Fatalf("the reported failures = %d, want 1", len(reported))
			}
		})
	}
}

// A cancelled check is not an outage either.
//
// The caller went away, so the dependency is untouched and the gate stays
// open.
func TestHealthMonitorDoesNotSuspendOnACancelledCheck(t *testing.T) {
	prober := &fakeRulesHealth{probeErr: context.Canceled}
	checkRulesHealth(context.Background(), prober, func(error) {})
	if prober.suspension != 0 {
		t.Fatalf("the interruptions = %d, want none", prober.suspension)
	}
	if prober.repairs != 0 {
		t.Fatalf("the repairs = %d, want none", prober.repairs)
	}
}
