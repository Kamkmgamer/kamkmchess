package online

import (
	"context"
	"errors"
	"sync"
	"testing"
)

// The failure episode of an instance.
//
// The monitor is one goroutine, but a participant request evaluates the rules
// process on another one, so a success and a failure of the dependency can
// complete at the same time. The transitions of the episode are serialized,
// and the observations are numbered, so the order of a success and of a
// failure is the order of the moments they were made in.
//
// The identity of the episode is the epoch of its earliest observation, and
// the two watermarks — the newest failure and the newest success — decide
// which observation is the current one.

// episodeEvaluator is the rules process of the fixture. It fails until it is
// armed healthy.
type episodeEvaluator struct {
	broken bool
}

func (e *episodeEvaluator) ValidateSetup(context.Context, RulesInput) error {
	if e.broken {
		return errors.New("the rules process is down")
	}
	return nil
}

func (e *episodeEvaluator) Evaluate(context.Context, RulesInput) (Candidate, error) {
	if e.broken {
		return Candidate{}, errors.New("the rules process is down")
	}
	return Candidate{}, nil
}

// errBrokenWorker is the failure of a broken rules process.
var errBrokenWorker = errors.New("the rules process is down")

// TestEpisodeKeepsTheIdentityOfItsEarliestObservation covers the concurrent
// failures.
//
// Two failures that observe the same episode at the same time must not
// overwrite its identity: the interruption of the outage is identified by the
// epoch of the earliest observation, and a second writer would move it.
func TestEpisodeKeepsTheIdentityOfItsEarliestObservation(t *testing.T) {
	service := &Service{}
	var group sync.WaitGroup
	for index := 0; index < 16; index++ {
		group.Add(1)
		go func(observation int64) {
			defer group.Done()
			service.observeFailure(context.Background(), observation, observation, errBrokenWorker, true)
		}(int64(index + 1))
	}
	group.Wait()
	if got := service.episodeEpoch; got != 1 {
		t.Fatalf("the identity of the episode = %d after sixteen concurrent failures, want the epoch of the earliest observation (1)", got)
	}
	// A later failure does not move the identity of the episode.
	service.observeFailure(context.Background(), 99, 99, errBrokenWorker, true)
	if got := service.episodeEpoch; got != 1 {
		t.Fatalf("the identity of the episode = %d after a later failure, want 1", got)
	}
	// An observation that is older is the earliest one, so it owns the
	// identity while no interruption was planned with it.
	service.observeFailure(context.Background(), 42, 0, errBrokenWorker, true)
	if got := service.episodeEpoch; got != 42 {
		t.Fatalf("the identity of the episode = %d after an older observation, want 42", got)
	}
	// A planned interruption is immutable: the identity may not move again.
	service.episodeMu.Lock()
	service.episodePlanned = true
	service.episodeMu.Unlock()
	service.observeFailure(context.Background(), 7, 0, errBrokenWorker, true)
	if got := service.episodeEpoch; got != 42 {
		t.Fatalf("the identity of the episode = %d after a planned interruption, want 42", got)
	}
}

// TestEpisodeSurvivesAStaleSuccess covers the racing success.
//
// A success that is older than the newest failure answered before that
// failure, so it does not close the episode and it does not report the
// dependency as healthy: the healthy report would hide the dependency that
// is still broken.
func TestEpisodeSurvivesAStaleSuccess(t *testing.T) {
	evaluator := &episodeEvaluator{broken: true}
	reporter := NewHealthReporter(nil)
	service := &Service{evaluator: evaluator, health: reporter}

	// The actual probe of a broken worker degrades the dependency and opens
	// the episode.
	service.observationSeq.Store(0)
	if err := service.ProbeRules(context.Background()); err == nil {
		t.Fatal("the probe of a broken worker answered")
	}
	if state := reporter.Current().Rules.State; state != HealthDegraded {
		t.Fatalf("the rules dependency = %q after the failure, want %q", state, HealthDegraded)
	}
	// A newer failure does not move the identity of the episode.
	service.observeFailure(context.Background(), 6, 7, errBrokenWorker, true)
	if got := service.episodeEpoch; got != 0 {
		t.Fatalf("the identity of the episode = %d, want the unknown identity of the probe", got)
	}

	// A success that is older than that failure is stale: the episode stays
	// open and the dependency stays degraded.
	service.observeSuccess(context.Background(), 3, true)
	if !service.episodeOpen {
		t.Fatal("a stale success closed the episode of the newest failure")
	}
	if state := reporter.Current().Rules.State; state != HealthDegraded {
		t.Fatalf("the rules dependency = %q after a stale success, want %q", state, HealthDegraded)
	}

	// A success that is newer closes the episode and reports the
	// dependency as healthy.
	service.observeSuccess(context.Background(), 9, true)
	if service.episodeOpen {
		t.Fatal("the success did not close the episode")
	}
	if state := reporter.Current().Rules.State; state != HealthHealthy {
		t.Fatalf("the rules dependency = %q after the success, want %q", state, HealthHealthy)
	}
}

// TestEpisodeIsNotReopenedByADeferredFailure covers the deferred failure.
//
// A failure that was made before the newest success is stale: the dependency
// answered after that failure, so the failure may not reopen an episode that
// the success already closed.
func TestEpisodeIsNotReopenedByADeferredFailure(t *testing.T) {
	service := &Service{}
	service.observeFailure(context.Background(), 5, 1, errBrokenWorker, true)
	service.observeSuccess(context.Background(), 9, true)
	if service.episodeOpen {
		t.Fatal("the success did not close the episode")
	}
	// The deferred failure of the observation that was made before the
	// success.
	service.observeFailure(context.Background(), 3, 3, errBrokenWorker, true)
	if service.episodeOpen {
		t.Fatal("a deferred failure reopened the episode that a success closed")
	}
	// A failure that is newer opens a new episode.
	service.observeFailure(context.Background(), 7, 11, errBrokenWorker, true)
	if !service.episodeOpen {
		t.Fatal("a new failure did not open an episode")
	}
	if got := service.episodeEpoch; got != 7 {
		t.Fatalf("the identity of the episode = %d after a new failure, want 7", got)
	}
}

// TestEpisodeOrdersADeferredFailureAgainstASuccess covers the deferred
// failure.
//
// The failure was made before the success and completed after it. The
// dependency answered in between, so the failure is stale: it may neither
// open an episode nor degrade the dependency.
func TestEpisodeOrdersADeferredFailureAgainstASuccess(t *testing.T) {
	reporter := NewHealthReporter(nil)
	service := &Service{health: reporter}
	release := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		<-release
		service.observeFailure(context.Background(), 5, 3, errBrokenWorker, true)
	}()
	// The success completes while the failure waits.
	service.observeSuccess(context.Background(), 9, true)
	close(release)
	<-done
	// The deferred failure must not degrade the dependency.
	if state := reporter.Current().Rules.State; state == HealthDegraded {
		t.Fatalf("the rules dependency = %q after a deferred failure, want the state of the success", state)
	}
	if service.episodeOpen {
		t.Fatal("a deferred failure opened an episode after the success")
	}
}

// TestEpisodeOrdersADeferredSuccessAgainstAFailure covers the deferred
// success.
//
// The success was made before the failure and completed after it. The
// dependency is broken, so the success is stale: it may neither close the
// episode nor report the dependency as healthy.
func TestEpisodeOrdersADeferredSuccessAgainstAFailure(t *testing.T) {
	reporter := NewHealthReporter(nil)
	service := &Service{health: reporter}
	service.observeFailure(context.Background(), 5, 7, errBrokenWorker, true)
	release := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		<-release
		service.observeSuccess(context.Background(), 3, true)
	}()
	close(release)
	<-done
	if state := reporter.Current().Rules.State; state != HealthDegraded {
		t.Fatalf("the rules dependency = %q after a deferred success, want %q", state, HealthDegraded)
	}
	if !service.episodeOpen {
		t.Fatal("a deferred success closed the episode of the failure")
	}
}

// TestEpisodeIgnoresABusyOrCancelledObservation covers the taxonomy.
//
// A busy process and a departing caller are not broken dependencies, so they
// open no episode and they leave the durable health alone.
func TestEpisodeIgnoresABusyOrCancelledObservation(t *testing.T) {
	reporter := NewHealthReporter(nil)
	service := &Service{health: reporter}
	service.observeFailure(context.Background(), 5, 1, ErrRulesBusy, true)
	if service.episodeOpen {
		t.Fatal("a busy observation opened an episode")
	}
	if state := reporter.Current().Rules.State; state == HealthDegraded {
		t.Fatalf("the rules dependency = %q after a busy observation, want the state of the service", state)
	}
	service.observeFailure(context.Background(), 5, 1, context.Canceled, true)
	if service.episodeOpen {
		t.Fatal("a cancelled observation opened an episode")
	}
}

// TestFlushKeepsTheNewestObservation covers the pending observation of a
// dependency.
//
// The observation of the instance replaces the pending one, so a newer
// observation is never lost behind an older one. The flush writes the
// newest observation and acknowledges it by its revision, so a write that
// completes after a newer observation never replaces it.
func TestFlushKeepsTheNewestObservation(t *testing.T) {
	reporter := NewHealthReporter(nil)
	reporter.Record(DependencyRules, HealthHealthy, "the rules process answered")
	reporter.Flush(context.Background())
	reporter.Record(DependencyRules, HealthDegraded, "the rules process did not answer")
	reporter.Record(DependencyRules, HealthHealthy, "the rules process answered")
	reporter.Flush(context.Background())
	if state := reporter.Current().Rules.State; state != HealthHealthy {
		t.Fatalf("the flush replaced the newest healthy observation with %q", state)
	}
}

// TestHealthReporterServesConcurrentReportsOfOneDependency covers the
// concurrent reports of one dependency.
//
// The reporter keeps the durable state of every dependency, and the reports
// of the same dependency may come from the episode of the instance, from the
// monitor and from another dependency. Every access to that state is guarded,
// so the reports never read the map while another report writes it.
func TestHealthReporterServesConcurrentReportsOfOneDependency(t *testing.T) {
	reporter := NewHealthReporter(nil)
	var group sync.WaitGroup
	for index := 0; index < 32; index++ {
		group.Add(1)
		go func(observation int) {
			defer group.Done()
			state := HealthHealthy
			if observation%2 == 0 {
				state = HealthDegraded
			}
			if err := reporter.ReportDependency(context.Background(), DependencyRules, state, "the observation of the instance"); err != nil {
				t.Errorf("the report of the dependency: %v", err)
			}
		}(index)
	}
	group.Wait()
	if state := reporter.Current().Rules.State; state != HealthHealthy && state != HealthDegraded {
		t.Fatalf("the state of the dependency = %q after the concurrent reports", state)
	}
}

// TestEpisodeKeepsAKnownIdentityWhenTheEpochIsUnreadable covers the
// unreadable epoch.
//
// A causal epoch that cannot be read leaves the identity of the episode
// unknown. The episode keeps the identity it had, so an unreadable epoch
// never destroys the identity that dedupes the outage.
func TestEpisodeKeepsAKnownIdentityWhenTheEpochIsUnreadable(t *testing.T) {
	service := &Service{}
	service.observeFailure(context.Background(), 5, 1, errBrokenWorker, true)
	service.observeFailure(context.Background(), 0, 2, errBrokenWorker, true)
	if got := service.episodeEpoch; got != 5 {
		t.Fatalf("the identity of the episode = %d after an unreadable epoch, want 5", got)
	}
	empty := &Service{}
	empty.observeFailure(context.Background(), 0, 1, errBrokenWorker, true)
	if got := empty.episodeEpoch; got != 0 {
		t.Fatalf("the identity of the episode = %d, want the unknown identity", got)
	}
}
