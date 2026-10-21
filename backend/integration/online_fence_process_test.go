package integration

import (
	"context"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"

	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The fence of the restore lifecycle is a cross process lock.
//
// The regressions below run the fence in a second process, because the
// ownership of the lifecycle is a property of the operating system and not of
// one process: a restore that is alive holds the lock, and the operating
// system releases it when the process dies. A test that only used one process
// could not tell a live restore from a crashed one.

const (
	fenceHelperMode    = "KHA_FENCE_HELPER_MODE"
	fenceHelperPath    = "KHA_FENCE_HELPER_PATH"
	fenceHelperRestore = "KHA_FENCE_HELPER_RESTORE"
	fenceHelperReady   = "KHA_FENCE_HELPER_READY"
	fenceHelperDigest  = "KHA_FENCE_HELPER_DIGEST"
)

// fenceHelper is a second process that owns the fence of the lifecycle.
type fenceHelper struct {
	command *exec.Cmd
	ready   string
}

// startFenceHelper starts a process that opens the fence of the lifecycle and
// holds it until it is killed.
//
// The digest is the hexadecimal digest of the removal ledger the helper binds
// in the marker of the lifecycle.
func startFenceHelper(t *testing.T, parent, restoreID string, digest []byte) *fenceHelper {
	t.Helper()
	ready := filepath.Join(t.TempDir(), "ready")
	command := exec.Command(os.Args[0], "-test.run=TestFenceHelperProcess", "-test.timeout=120s")
	command.Env = append(os.Environ(),
		fenceHelperMode+"=open",
		fenceHelperPath+"="+parent,
		fenceHelperRestore+"="+restoreID,
		fenceHelperReady+"="+ready,
		fenceHelperDigest+"="+hex.EncodeToString(digest),
	)
	if err := command.Start(); err != nil {
		t.Fatalf("start the helper process: %v", err)
	}
	helper := &fenceHelper{command: command, ready: ready}
	t.Cleanup(helper.stop)
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(ready); err == nil {
			return helper
		}
		time.Sleep(20 * time.Millisecond)
	}
	helper.stop()
	t.Fatal("the helper process did not open the fence")
	return nil
}

// stop kills the helper process.
func (h *fenceHelper) stop() {
	if h == nil || h.command == nil || h.command.Process == nil {
		return
	}
	_ = h.command.Process.Kill()
	_, _ = h.command.Process.Wait()
	h.command = nil
}

// crash kills the helper process without giving it the chance to clean up.
func (h *fenceHelper) crash() {
	if h == nil || h.command == nil || h.command.Process == nil {
		return
	}
	_ = h.command.Process.Kill()
	_, _ = h.command.Process.Wait()
	h.command = nil
	// The operating system releases the lock of a dead process. The marker of
	// the lifecycle survives, so the service stays closed.
	time.Sleep(200 * time.Millisecond)
}

// TestFenceHelperProcess is the helper process of the fence regressions. It
// opens the fence of the lifecycle and waits, so the parent can observe the
// state of the fence and kill it.
//
// The test returns without a verdict when it is not a helper run, so a full
// suite reports no skip for it: the helper is the child of the regressions
// below, and it is not a test of its own.
func TestFenceHelperProcess(t *testing.T) {
	if os.Getenv(fenceHelperMode) != "open" {
		return
	}
	url := os.Getenv(databaseEnv)
	if url == "" {
		t.Fatal("the helper needs the database url")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	service, err := privacy.Open(context.Background(), pool, nil, privacy.Options{FencePath: os.Getenv(fenceHelperPath)})
	if err != nil {
		t.Fatal(err)
	}
	handle, err := service.BeginFence(os.Getenv(fenceHelperRestore), false)
	if err != nil {
		t.Fatalf("the helper could not open the fence: %v", err)
	}
	// The restore bound the removal ledger it had to apply.
	digest, err := hex.DecodeString(os.Getenv(fenceHelperDigest))
	if err != nil {
		t.Fatalf("the helper got no digest: %v", err)
	}
	if err = handle.Bind(digest); err != nil {
		t.Fatalf("the helper could not bind the fence: %v", err)
	}
	// The handle holds the ownership of the lifecycle until the helper dies.
	defer handle.Release()
	if err = os.WriteFile(os.Getenv(fenceHelperReady), []byte("open"), 0o600); err != nil {
		t.Fatal(err)
	}
	// The helper holds the lifecycle until it is killed.
	time.Sleep(5 * time.Minute)
}

// TestPostgresALiveRestoreHoldsTheFenceAgainstEveryOtherProcess covers the
// live ownership of the lifecycle.
//
// A restore that is alive holds the operating system lock of the lifecycle.
// No other process can open the fence, no other process can close it, and the
// recovery of a crashed restore refuses it: the identifier of a restore is
// not evidence that the restore crashed.
func TestPostgresALiveRestoreHoldsTheFenceAgainstEveryOtherProcess(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	ctx := context.Background()
	parent := t.TempDir()
	restoreID := "restore-live"
	helper := startFenceHelper(t, parent, restoreID, backup.RemovalLedgerDigest(nil, nil))
	defer helper.stop()

	service, err := privacy.Open(ctx, fixture.pool, fixture.authorizer, privacy.Options{FencePath: parent})
	if err != nil {
		t.Fatal(err)
	}

	// A second restore is refused, even with the same identifier.
	if _, err = service.BeginFence(restoreID, false); !errors.Is(err, privacy.ErrFenceLive) {
		t.Fatalf("a second restore was admitted while a restore was alive: %v", err)
	}
	// A take-over of a live restore is refused as well: the ownership of the
	// lifecycle is held by the restore that is alive.
	if _, err = service.BeginFence(restoreID, true); !errors.Is(err, privacy.ErrFenceLive) {
		t.Fatalf("a take-over displaced a live restore: %v", err)
	}
	// The recovery of the live restore is refused.
	required := backup.AppliedRemovalLedger{}
	if err = service.RecoverRestore(ctx, restoreID, required); !errors.Is(err, privacy.ErrFenceLive) {
		t.Fatalf("the recovery cleared the fence of a live restore: %v", err)
	}
	// The service is closed while the restore is alive.
	open, err := service.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if !open {
		t.Fatal("the fence of a live restore is not open")
	}
	allowed, err := service.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("the service serves traffic while a restore is alive")
	}
	// The fence of the live restore is still there after the refusals.
	marker, present, err := service.ReadFence(restoreID)
	if err != nil {
		t.Fatal(err)
	}
	if !present || marker.RestoreID != restoreID {
		t.Fatalf("the fence of the live restore = %+v (present %v)", marker, present)
	}
}

// TestPostgresACrashedRestoreIsRecoveredAfterItsProcessDied covers the
// recovery of a restore whose process died.
//
// The marker of the lifecycle survives the crash, so the service stays closed.
// The operating system released the lock of the dead process, so the recovery
// may take it: the recovery is the supported path, and it closes the fence of
// the crashed restore.
func TestPostgresACrashedRestoreIsRecoveredAfterItsProcessDied(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	ctx := context.Background()
	parent := t.TempDir()
	restoreID := "restore-crashed"
	helper := startFenceHelper(t, parent, restoreID, backup.RemovalLedgerDigest(nil, nil))
	helper.crash()

	service, err := privacy.Open(ctx, fixture.pool, fixture.authorizer, privacy.Options{FencePath: parent})
	if err != nil {
		t.Fatal(err)
	}
	// The marker of the crashed restore survives.
	open, err := service.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if !open {
		t.Fatal("the fence of the crashed restore is gone")
	}
	allowed, err := service.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("the service serves traffic after a crashed restore")
	}
	// The recovery of the crashed restore closes its fence.
	if err = service.RecoverRestore(ctx, restoreID, backup.AppliedRemovalLedger{}); err != nil {
		t.Fatalf("the recovery of the crashed restore failed: %v", err)
	}
	open, err = service.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if open {
		t.Fatal("the fence of the recovered restore is still open")
	}
}

// TestPostgresTheRecoveryOfACrashedRestoreNeverReleasesADatabaseThatLostItsRemovals
// covers the crash boundary in which the import of the restore committed and
// the replay of the removal ledger did not.
//
// The database may have lost the newest removals, so the recovery may not
// release it. It records a blocking gate instead: the fence is closed so that
// the restore can be run again, and the service stays closed because of the
// gate.
func TestPostgresTheRecoveryOfACrashedRestoreNeverReleasesADatabaseThatLostItsRemovals(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	ctx := context.Background()
	parent := t.TempDir()
	restoreID := "restore-crashed-with-lost-removals"
	helper := startFenceHelper(t, parent, restoreID, backup.RemovalLedgerDigest(nil, nil))
	helper.crash()

	service, err := privacy.Open(ctx, fixture.pool, fixture.authorizer, privacy.Options{FencePath: parent})
	if err != nil {
		t.Fatal(err)
	}
	// A removal that the database does not hold: the restore lost it.
	required := backup.AppliedRemovalLedger{Matches: []backup.RemovalRecord{{
		RemovalID: "rm_lost", SubjectKind: "account", SubjectID: "ref-lost", MatchID: "match-lost", Scope: "explicit_removal", RemovedAt: time.Now().UTC(),
	}}}
	// The crashed restore bound that ledger, so the recovery is identity
	// bound to it.
	lost, err := service.BeginFence("restore-crashed-with-lost-removals", true)
	if err != nil {
		t.Fatalf("the take-over failed: %v", err)
	}
	if err = lost.Bind(backup.RemovalLedgerDigest(required.Matches, required.Subjects)); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	lost.Release()
	err = service.RecoverRestore(ctx, restoreID, required)
	if !errors.Is(err, privacy.ErrLedgerNotApplied) {
		t.Fatalf("the recovery released a database that lost its removals: %v", err)
	}
	// The fence is closed, so the restore can be run again.
	open, err := service.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if open {
		t.Fatal("the fence of the crashed restore is still open")
	}
	// The service stays closed, because the blocking gate of the crashed
	// restore waits for its release.
	allowed, err := service.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("the service serves a database that lost its removals")
	}
	// The next restore takes the lock and releases the gate of the crashed
	// restore when it applied the removals.
	restoring, err := privacy.Open(ctx, fixture.pool, fixture.authorizer, privacy.Options{FencePath: parent})
	if err != nil {
		t.Fatal(err)
	}
	handle, err := restoring.BeginFence("restore-next", true)
	if err != nil {
		t.Fatalf("the next restore cannot take the lock: %v", err)
	}
	defer handle.Release()
	if err = handle.Bind([]byte("digest")); err != nil {
		t.Fatalf("the bind of the fence failed: %v", err)
	}
	if _, err = restoring.RecordRestore(ctx, "restore-next"); err != nil {
		t.Fatal(err)
	}
	if err = restoring.ReleaseRestoreGate(ctx, "restore-next"); err != nil {
		t.Fatalf("the release of the gate failed: %v", err)
	}
	if err = handle.Finish([]byte("digest")); err != nil {
		t.Fatalf("the close of the fence failed: %v", err)
	}
	allowed, err = restoring.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("the service does not serve after a restore that released every pending gate")
	}
}

// TestPostgresTheRecoveryOfARestoreWithAReleasedGateStillBlocksTheService
// covers the retry of a restore whose gate was already released.
//
// The gate of a restore is released once and never taken back, so a recovery
// that has to block the service cannot use the gate of that restore: it would
// keep the released state, and the service would serve a database that lost
// its removals. The recovery records a gate of its own, so the service stays
// closed.
func TestPostgresTheRecoveryOfARestoreWithAReleasedGateStillBlocksTheService(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	ctx := context.Background()
	parent := t.TempDir()
	restoreID := "restore-retried-with-released-gate"
	service, err := privacy.Open(ctx, fixture.pool, fixture.authorizer, privacy.Options{FencePath: parent})
	if err != nil {
		t.Fatal(err)
	}
	// The first attempt of the restore recorded its gate and released it.
	if _, err = service.RecordRestore(ctx, restoreID); err != nil {
		t.Fatalf("record the restore: %v", err)
	}
	if err = service.ReleaseRestoreGate(ctx, restoreID); err != nil {
		t.Fatalf("release the gate: %v", err)
	}
	var released bool
	if err = fixture.pool.QueryRow(ctx, `SELECT serving_allowed FROM online_restore_gates WHERE restore_id=$1`, restoreID).Scan(&released); err != nil {
		t.Fatal(err)
	}
	if !released {
		t.Fatal("the gate of the first attempt was not released")
	}
	// The restore runs again and crashes. Its marker names a removal ledger
	// that the database does not hold.
	handle, err := service.BeginFence(restoreID, false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	required := backup.AppliedRemovalLedger{Matches: []backup.RemovalRecord{{
		RemovalID: "rm_lost", SubjectKind: "account", SubjectID: "ref-lost", MatchID: "match-lost", Scope: "explicit_removal", RemovedAt: time.Now().UTC(),
	}}}
	if err = handle.Bind(backup.RemovalLedgerDigest(required.Matches, required.Subjects)); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	handle.Release()
	// The recovery finds the removals lost, so it must not release the
	// database.
	err = service.RecoverRestore(ctx, restoreID, required)
	if !errors.Is(err, privacy.ErrLedgerNotApplied) {
		t.Fatalf("the recovery released a database that lost its removals: %v", err)
	}
	// The service stays closed: the blocking gate of the recovery waits for
	// its release, and the released gate of the first attempt does not open
	// the service again.
	allowed, err := service.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("the service serves a database that lost its removals after a retry of the restore")
	}
	// The gate of the first attempt is still released, so the recovery did not
	// take a release back.
	if err = fixture.pool.QueryRow(ctx, `SELECT serving_allowed FROM online_restore_gates WHERE restore_id=$1`, restoreID).Scan(&released); err != nil {
		t.Fatal(err)
	}
	if !released {
		t.Fatal("the recovery took the release of the gate of the first attempt back")
	}
}

// TestPostgresTheFenceFailsClosedForEveryUnexpectedState covers the fail
// closed rule of the fence.
//
// A fence file of the older layout, a lock directory without an owner marker
// and an unreadable marker are all open fences: the service refuses to serve
// instead of serving a database whose removals were never replayed.
func TestPostgresTheFenceFailsClosedForEveryUnexpectedState(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	ctx := context.Background()
	parent := t.TempDir()
	service, err := privacy.Open(ctx, fixture.pool, fixture.authorizer, privacy.Options{FencePath: parent})
	if err != nil {
		t.Fatal(err)
	}
	// A lock directory without an owner marker: a crash between the creation
	// of the directory and the marker.
	if err = os.Mkdir(filepath.Join(parent, "restore-fence"), 0o700); err != nil {
		t.Fatal(err)
	}
	open, err := service.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if !open {
		t.Fatal("a lock directory without an owner marker is not an open fence")
	}
	allowed, err := service.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("the service serves traffic with an ownerless lock directory")
	}
	// The recovery of an ownerless lock directory is refused. The state is
	// unknown: the marker names no restore and no removal ledger, so the
	// recovery cannot prove what the lifecycle owed and it may not clear an
	// unknown marker.
	if err = service.RecoverRestore(ctx, "restore-ownerless", backup.AppliedRemovalLedger{}); err == nil {
		t.Fatal("the recovery cleared an ownerless lock directory")
	}
	// The refused recovery mutated nothing: the marker is still there and the
	// service is still closed.
	open, err = service.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if !open {
		t.Fatal("the refused recovery removed the ownerless lock directory")
	}
	allowed, err = service.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("the service serves traffic after a refused recovery of an ownerless marker")
	}
	// The supported path for an ownerless marker is the restore with the
	// take-over: it re-imports the bundle, re-applies the removal ledger and
	// closes the fence.
	takeover, err := service.BeginFence("restore-ownerless", true)
	if err != nil {
		t.Fatalf("the take-over of the ownerless marker was refused: %v", err)
	}
	if err = takeover.Bind([]byte("digest-of-the-merged-ledger")); err != nil {
		t.Fatalf("bind the take-over: %v", err)
	}
	if err = takeover.Finish([]byte("digest-of-the-merged-ledger")); err != nil {
		t.Fatalf("close the fence of the take-over: %v", err)
	}
	open, err = service.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if open {
		t.Fatal("the fence of the take-over is still open")
	}
	// A fence file of the older layout is an open fence as well.
	legacy := t.TempDir()
	legacyService, err := privacy.Open(ctx, fixture.pool, fixture.authorizer, privacy.Options{FencePath: filepath.Join(legacy, "restore.fence")})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(legacy, "restore.fence"), []byte(`{"restoreId":"restore-legacy"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	open, err = legacyService.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if !open {
		t.Fatal("a fence file of the older layout is not an open fence")
	}
	allowed, err = legacyService.ServingAllowed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("the service serves traffic with a fence file of the older layout")
	}
}

// TestPostgresTheFenceOfAnotherRestoreIsAConflict covers the distinction
// between a fence that is not there and a fence of another restore.
//
// The fence is owned by a process that died, so the recovery may take the
// lock of the lifecycle. It still never touches the fence of another restore.
func TestPostgresTheFenceOfAnotherRestoreIsAConflict(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	ctx := context.Background()
	parent := t.TempDir()
	service, err := privacy.Open(ctx, fixture.pool, fixture.authorizer, privacy.Options{FencePath: parent})
	if err != nil {
		t.Fatal(err)
	}
	// The fence of that restore is absent: the fence is not there.
	if _, _, err = service.ReadFence("restore-two"); err != nil {
		t.Fatalf("the read of an absent fence failed: %v", err)
	}
	helper := startFenceHelper(t, parent, "restore-one", backup.RemovalLedgerDigest(nil, nil))
	helper.crash()
	// The fence of another restore is a conflict, not an absent fence.
	_, _, err = service.ReadFence("restore-two")
	if !errors.Is(err, privacy.ErrFenceConflict) {
		t.Fatalf("the fence of another restore was reported as absent: %v", err)
	}
	// The recovery never touches the fence of another restore.
	err = service.RecoverRestore(ctx, "restore-two", backup.AppliedRemovalLedger{})
	if !errors.Is(err, privacy.ErrFenceConflict) {
		t.Fatalf("the recovery touched the fence of another restore: %v", err)
	}
	// The fence of its owner is still there.
	marker, present, err := service.ReadFence("restore-one")
	if err != nil {
		t.Fatal(err)
	}
	if !present || marker.RestoreID != "restore-one" {
		t.Fatalf("the fence of the owner = %+v (present %v)", marker, present)
	}
	// The recovery of the owner closes it.
	if err = service.RecoverRestore(ctx, "restore-one", backup.AppliedRemovalLedger{}); err != nil {
		t.Fatalf("the recovery of the owner failed: %v", err)
	}
	open, err := service.FenceOpen()
	if err != nil {
		t.Fatal(err)
	}
	if open {
		t.Fatal("the fence of the recovered restore is still open")
	}
}

// TestPostgresTheServiceRefusesEveryRequestWhileTheRestoreFenceIsOpen covers
// the admission barrier of the restore.
//
// The restore takes the admission before it reads the ledgers of the
// database, so the ledgers it reads have to be complete. The service refuses
// every request while the fence of the restore is open, so a removal cannot
// be committed while the restore runs: the request never reaches the code
// that would commit it.
//
// The test is deterministic: the same request is admitted before the restore,
// refused while the fence is open and admitted again after it is closed.
// TestPostgresTheServiceRefusesEveryRequestWhileTheRestoreFenceIsOpen covers
// the admission of the fence.
//
// The service refuses every request while the fence of a restore is open, so
// no removal is admitted after the restore took the fence.
func TestPostgresTheServiceRefusesEveryRequestWhileTheRestoreFenceIsOpen(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	ctx := context.Background()
	directory := t.TempDir() + "/restore"
	removals, err := privacy.Open(ctx, fixture.pool, fixture.authorizer, privacy.Options{FencePath: directory})
	if err != nil {
		t.Fatal(err)
	}
	reached := false
	handler := httpapi.WithServingGate(removals, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	}))
	serve := func() *httptest.ResponseRecorder {
		reached = false
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/v1/privacy/account/removal", nil))
		return recorder
	}
	// Before the restore the request is admitted.
	if recorder := serve(); !reached || recorder.Code != http.StatusOK {
		t.Fatalf("the request before the restore = %d (reached %v)", recorder.Code, reached)
	}
	// While the fence of the restore is open, every request is refused.
	handle, err := removals.BeginFence("restore-one", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	defer handle.Release()
	if err = handle.Bind([]byte("digest-of-the-ledger")); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	recorder := serve()
	if reached {
		t.Fatal("the request reached the removal while the fence of the restore was open")
	}
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("the request while the fence is open = %d", recorder.Code)
	}
	// The fence is closed and the request is admitted again.
	if err = handle.Finish([]byte("digest-of-the-ledger")); err != nil {
		t.Fatalf("close the fence: %v", err)
	}
	if recorder = serve(); !reached || recorder.Code != http.StatusOK {
		t.Fatalf("the request after the restore = %d (reached %v)", recorder.Code, reached)
	}
}

// TestPostgresTheScopeOfTheFenceIsTheAdmissionAndNotTheDatabase covers the
// exact scope of the fence.
//
// The fence is the admission of the service: while it is open, the service
// refuses every request. A removal that was **admitted before** the fence was
// taken is not refused, because the fence is not a lock of the database: the
// import of a restore replaces the schema, so it cannot run inside the
// transaction of a removal.
//
// The scope is stated in the contract and in the runbook, and the runbook
// completes the guarantee by draining the API before a restore. This
// regression states the scope, so a change that widens or narrows it is
// visible.
func TestPostgresTheScopeOfTheFenceIsTheAdmissionAndNotTheDatabase(t *testing.T) {
	fixture := newOnlineAuthFixture(t, moveEvaluator{})
	ctx := context.Background()
	parent := t.TempDir()
	service, err := privacy.Open(ctx, fixture.pool, fixture.authorizer, privacy.Options{FencePath: parent})
	if err != nil {
		t.Fatal(err)
	}
	// A removal that is already running when the fence is taken keeps running:
	// the fence refuses the requests that arrive later, not the ones that are
	// already inside the service.
	removal := make(chan error, 1)
	started := make(chan struct{})
	go func() {
		close(started)
		_, removeErr := service.RemoveAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin)
		removal <- removeErr
	}()
	<-started
	handle, err := service.BeginFence("restore-scope", false)
	if err != nil {
		t.Fatalf("open the fence: %v", err)
	}
	defer handle.Release()
	if err = handle.Bind([]byte("digest-of-the-ledger")); err != nil {
		t.Fatalf("bind the fence: %v", err)
	}
	// The request that arrives after the fence was taken is refused.
	refused := httpapi.WithServingGate(service, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	recorder := httptest.NewRecorder()
	refused.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/v1/privacy/account/removal", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("the request while the fence is open = %d", recorder.Code)
	}
	// The removal that was admitted before the fence was taken commits: the
	// fence does not lock the database.
	select {
	case removeErr := <-removal:
		if removeErr != nil {
			t.Fatalf("the removal that was admitted before the fence was taken failed: %v", removeErr)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the removal that was admitted before the fence was taken did not finish")
	}
}
