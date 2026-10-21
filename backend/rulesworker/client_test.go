package rulesworker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const fakeWorkerScript = `
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

// The boot delay simulates a host that starts the worker slowly. It is read
// from a file beside the script, so only the fixture that needs a slow boot
// pays for it.
function bootDelayMs() {
  try {
    const raw = readFileSync(join(dirname(process.argv[1]), 'boot-delay-ms'), 'utf8');
    const value = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

const bootDelay = bootDelayMs();

function facts(timeoutWinner = null) {
  return {
    inCheck: false,
    hasLegalMoves: true,
    checkmate: false,
    stalemate: false,
    insufficientMaterial: false,
    repetitionCount: '1',
    thirdRepetition: false,
    hundredHalfmoves: false,
    deadness: 'not-assessed',
    ending: 'none',
    material: {
      white: { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 },
      black: { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 },
      total: 32,
    },
    timeoutWinner,
  };
}

// Mirrors inputFingerprint() in src/online-rules-worker/protocol.ts so the Go
// client's recomputation is checked against real JSON.stringify bytes.
function fingerprint(req, override = {}) {
  const intent = 'intent' in override ? override.intent : req.intent;
  const history = 'history' in override ? override.history : req.history;
  const canonicalIntent = intent == null ? null : intent.kind === 'move'
    ? { kind: 'move', from: intent.from, to: intent.to, promotion: intent.promotion ?? null }
    : { kind: 'timeout', expiredColor: intent.expiredColor };
  const canonical = JSON.stringify({
    protocolVersion: 1,
    rulesPolicyVersion: req.rulesPolicyVersion,
    matchVersion: req.matchVersion,
    fen: req.fen,
    history,
    intent: canonicalIntent,
  });
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function responseFor(req) {
  const isMove = req.intent && req.intent.kind === 'move';
  let candidate = null;
  if (isMove) {
    const move = { from: req.intent.from, to: req.intent.to };
    if (req.intent.promotion) move.promotion = req.intent.promotion;
    candidate = {
      move,
      san: 'e4',
      resultingFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      ending: facts(),
      repetition: { version: 1, entries: [{ identity: 'candidate', occurrences: '1' }] },
      material: facts().material,
    };
  }
  const isTimeout = req.intent && req.intent.kind === 'timeout';
  return {
    protocolVersion: 1,
    status: 'ok',
    requestId: req.requestId,
    matchVersion: req.matchVersion,
    rulesPolicyVersion: req.rulesPolicyVersion,
    inputFingerprint: fingerprint(req),
    engine: { name: 'chessops', version: '0.15.1' },
    input: { fen: req.fen, identity: (Array.isArray(req.history) && req.repetition === undefined) ? 'history-shape' : 'wrong-shape', repetitionCount: '1' },
    facts: facts(isTimeout ? 'white' : null),
    candidate,
  };
}

for await (const line of rl) {
  const req = JSON.parse(line);
  // The readiness probe is the first request of a cold worker, so it carries
  // the boot delay of the simulated host.
  if (req.requestId === '__READINESS_REQUEST_ID__') {
    if (bootDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, bootDelay));
    }
    // A fixture can ask the worker to stop answering the readiness probe,
    // so the start of the worker fails.
    if (existsSync(join(dirname(process.argv[1]), 'hang-probe'))) {
      await new Promise(() => {});
    }
    // A fixture can ask the worker to answer the first readiness probe and
    // to stop answering the later ones, so the start of a replacement worker
    // fails while the first request still reaches the worker.
    const replacement = join(dirname(process.argv[1]), 'hang-replacement-probe');
    if (existsSync(replacement)) {
      const counter = join(dirname(process.argv[1]), 'probe-counter');
      let seen = 0;
      try { seen = Number.parseInt(readFileSync(counter, 'utf8').trim(), 10) || 0; } catch { seen = 0; }
      writeFileSync(counter, String(seen + 1));
      if (seen > 0) {
        await new Promise(() => {});
      }
    }
  }
  switch (req.requestId) {
    case 'crash':
      process.exit(9);
    case 'malformed':
      process.stdout.write('this is not json\n');
      continue;
    case 'slow':
      await new Promise((resolve) => setTimeout(resolve, 5000));
      break;
    case 'late':
      await new Promise((resolve) => setTimeout(resolve, 60));
      break;
    case 'late-reject':
      await new Promise((resolve) => setTimeout(resolve, 60));
      process.stdout.write(JSON.stringify({
        protocolVersion: 1,
        status: 'rejected',
        requestId: req.requestId,
        code: 'illegal-move',
        message: 'The requested move is not legal in this position.',
      }) + '\n');
      continue;
    case 'crash-then-hang': {
      const counter = join(dirname(process.argv[1]), 'counter');
      let n = 0;
      try { n = Number.parseInt(readFileSync(counter, 'utf8').trim(), 10) || 0; } catch { n = 0; }
      writeFileSync(counter, String(n + 1));
      if (n === 0) { process.exit(9); }
      await new Promise(() => {});
      continue;
    }
    case 'crash-late':
      await new Promise((resolve) => setTimeout(resolve, 50));
      process.exit(9);
      break;
    case 'delay':
      await new Promise((resolve) => setTimeout(resolve, 700));
      break;
    case 'oversized':
      process.stdout.write('x'.repeat(16384) + '\n');
      continue;
    case 'reject':
      process.stdout.write(JSON.stringify({
        protocolVersion: 1,
        status: 'rejected',
        requestId: req.requestId,
        code: 'illegal-move',
        message: 'The requested move is not legal in this position.',
      }) + '\n');
      continue;
  }

  const response = responseFor(req);
  switch (req.requestId) {
    case 'stale-request': response.requestId = 'different'; break;
    case 'stale-match': response.matchVersion += 1; break;
    case 'stale-policy': response.rulesPolicyVersion = 'older-policy'; break;
    case 'stale-fingerprint': {
      // Well-shaped digest, one hex digit off.
      const digest = response.inputFingerprint.slice('sha256:'.length);
      response.inputFingerprint = 'sha256:' + (digest[0] === 'a' ? 'b' : 'a') + digest.slice(1);
      break;
    }
    case 'history-drift': response.inputFingerprint = fingerprint(req, { history: [req.fen] }); break;
    case 'timeout-side-drift': response.inputFingerprint = fingerprint(req, { intent: { kind: 'timeout', expiredColor: 'b' } }); break;
    case 'stale-engine': response.engine = { name: 'chessops', version: '0.14.0' }; break;
    case 'stale-fen': response.input.fen = 'different'; break;
    case 'missing-candidate': response.candidate = null; break;
    case 'candidate-on-evaluate':
      if (!req.intent) response.candidate = responseFor({ ...req, intent: { kind: 'move', from: 'e2', to: 'e4' } }).candidate;
      break;
    case 'timeout-no-winner': response.facts.timeoutWinner = null; break;
    case 'malformed-facts': response.facts.ending = 'resigned'; break;
    case 'bad-candidate-fen': response.candidate.resultingFen = ''; break;
    case 'extra-field': response.extra = true; break;
  }
  process.stdout.write(JSON.stringify(response) + '\n');
}
`

const initialFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

// fakeWorkerSource renders the fake worker with the correlation token of the
// readiness probe, so the fixture and the client cannot drift apart.
func fakeWorkerSource() string {
	return strings.ReplaceAll(fakeWorkerScript, "__READINESS_REQUEST_ID__", ReadinessRequestID)
}

func testEntry(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "worker.mjs")
	if err := os.WriteFile(path, []byte(fakeWorkerSource()), 0o600); err != nil {
		t.Fatalf("write fake worker: %v", err)
	}
	return path
}

// testEntryWithBootDelay writes a fake worker whose readiness probe answers
// only after the given delay. It simulates a host that starts the worker
// slowly.
func testEntryWithBootDelay(t *testing.T, delay time.Duration) string {
	t.Helper()
	directory := t.TempDir()
	path := filepath.Join(directory, "worker.mjs")
	if err := os.WriteFile(path, []byte(fakeWorkerSource()), 0o600); err != nil {
		t.Fatalf("write fake worker: %v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, "boot-delay-ms"), []byte(strconv.Itoa(int(delay.Milliseconds()))), 0o600); err != nil {
		t.Fatalf("write the boot delay: %v", err)
	}
	return path
}

// testEntryWithHangingProbe writes a fake worker that never answers the
// readiness probe. It simulates a replacement worker that never becomes ready.
func testEntryWithHangingProbe(t *testing.T, marker string) string {
	t.Helper()
	directory := t.TempDir()
	path := filepath.Join(directory, "worker.mjs")
	if err := os.WriteFile(path, []byte(fakeWorkerSource()), 0o600); err != nil {
		t.Fatalf("write fake worker: %v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, marker), []byte("1"), 0o600); err != nil {
		t.Fatalf("write the probe marker: %v", err)
	}
	return path
}

// The budgets of the fixtures.
//
// The exchange budget must cover the bounded work a fixture performs. The
// other fixtures perform one bounded exchange and use the production budget
// of the client.
//
// The cold start of the worker is not part of any of these budgets. The
// client budgets the start of the worker separately, and the regressions
// below cover it.
const (
	exchangeBudget = 1 * time.Second
	// warmBudget bounds the warm-up of a fixture client. A warm-up that
	// cannot finish is a failure of the fixture, not a stall of the
	// package.
	warmBudget = 30 * time.Second
)

func testClient(t *testing.T, timeout time.Duration) *Client {
	t.Helper()
	client, err := New(Config{Entry: testEntry(t), RequestTimeout: timeout})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	// The worker is warmed before the fixture returns. The cold start has
	// its own budget now, and the dedicated regression below covers it, so
	// the other fixtures measure the protocol instead of the host's
	// process start latency.
	warm, cancel := context.WithTimeout(context.Background(), warmBudget)
	defer cancel()
	if err := client.Warm(warm); err != nil {
		t.Fatalf("warm the worker: %v", err)
	}
	return client
}

func request(id string) Request {
	return Request{
		RequestID:    id,
		MatchVersion: 41,
		FEN:          initialFEN,
		History:      []string{initialFEN},
	}
}

func moveRequest(id string) Request {
	req := request(id)
	req.Intent = &Intent{Kind: "move", From: "e2", To: "e4"}
	return req
}

// The cold start of a worker is a one-time cost of the host, and the
// exchange budget of a request must not carry it.
//
// The fixture simulates a host that boots the worker slowly: the readiness
// probe answers only after the boot delay. The exchange budget is far shorter
// than that delay, so the request can only succeed when the start has its
// own budget. The exchange budget still leaves room for the fake worker to
// answer on a loaded host.
const (
	bootDelayFixture = 2 * time.Second
	exchangeFixture  = 1 * time.Second
	startFixture     = 10 * time.Second
)

// TestTheColdStartDoesNotConsumeTheExchangeBudget proves that the boot of
// the worker is not charged to the exchange budget of the request.
func TestTheColdStartDoesNotConsumeTheExchangeBudget(t *testing.T) {
	entry := testEntryWithBootDelay(t, bootDelayFixture)
	client, err := New(Config{Entry: entry, RequestTimeout: exchangeFixture, StartTimeout: startFixture})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	response, err := client.Evaluate(context.Background(), moveRequest("ok"))
	if err != nil {
		t.Fatalf("the cold start consumed the exchange budget: %v", err)
	}
	if response.Candidate == nil || response.Candidate.Move.From != "e2" {
		t.Fatalf("candidate = %+v", response.Candidate)
	}
}

// TestTheRestartAfterATimeoutKeepsItsOwnStartBudget proves that a worker
// that was stopped by a timeout restarts without spending the exchange
// budget of the next request on the start.
func TestTheRestartAfterATimeoutKeepsItsOwnStartBudget(t *testing.T) {
	entry := testEntryWithBootDelay(t, bootDelayFixture)
	client, err := New(Config{Entry: entry, RequestTimeout: exchangeFixture, StartTimeout: startFixture})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	// The first request pays the boot and then times out on the stalled
	// worker.
	if _, err = client.Evaluate(context.Background(), request("slow")); !errors.Is(err, ErrTimeout) {
		t.Fatalf("error = %v, want timeout", err)
	}
	// The next request restarts the worker. The restart has its own start
	// budget, so the request only spends its exchange budget on the
	// exchange.
	response, err := client.Evaluate(context.Background(), request("ok"))
	if err != nil {
		t.Fatalf("the restart consumed the exchange budget: %v", err)
	}
	if response.RequestID != "ok" {
		t.Fatalf("correlation lost: %+v", response)
	}
}

// TestTheCrashOfTheFirstExchangeIsNotReplacedByTheTimeoutOfTheRetry proves
// that a specific failure survives the retry.
//
// The worker dies on the first request and hangs on the second. The retry
// runs out of budget, and the answer of the call is still the crash: a caller
// must be able to tell "the worker died" from "the worker was slow".
func TestTheCrashOfTheFirstExchangeIsNotReplacedByTheTimeoutOfTheRetry(t *testing.T) {
	client, err := New(Config{Entry: testEntry(t), RequestTimeout: 1500 * time.Millisecond, StartTimeout: 10 * time.Second})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	_, err = client.Evaluate(context.Background(), request("crash-then-hang"))
	if !errors.Is(err, ErrCrashed) {
		t.Fatalf("the crash of the first exchange was replaced by %v", err)
	}
}

// TestACanceledCallerKeepsItsCancellation proves that the caller's own
// cancellation keeps its class.
//
// A worker that answers after the cancellation must not turn the
// cancellation into a timeout: the caller knows that it went away.
func TestACanceledCallerKeepsItsCancellation(t *testing.T) {
	client, err := New(Config{Entry: testEntry(t), RequestTimeout: 5 * time.Second, StartTimeout: 10 * time.Second})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	warm, cancelWarm := context.WithTimeout(context.Background(), warmBudget)
	defer cancelWarm()
	if err = client.Warm(warm); err != nil {
		t.Fatalf("warm: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()
	_, err = client.Evaluate(ctx, request("late"))
	if !errors.Is(err, ErrCanceled) {
		t.Fatalf("a canceled caller got %v instead of a cancellation", err)
	}
	if errors.Is(err, ErrTimeout) {
		t.Fatal("a canceled caller was reported as a timeout")
	}
}

// TestALateRejectionIsNotAContractOutcome proves that a request that ran out
// of its deadline is never answered with a contract outcome.
//
// A rejection is a valid answer of the worker, but a rejection that arrives
// after the deadline belongs to a request that already failed. Answering the
// participant with "illegal move" would blame the participant for a slow
// worker.
func TestALateRejectionIsNotAContractOutcome(t *testing.T) {
	client, err := New(Config{Entry: testEntry(t), RequestTimeout: 20 * time.Millisecond, StartTimeout: 10 * time.Second})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	warm, cancelWarm := context.WithTimeout(context.Background(), warmBudget)
	defer cancelWarm()
	if err = client.Warm(warm); err != nil {
		t.Fatalf("warm: %v", err)
	}
	_, err = client.Evaluate(context.Background(), request("late-reject"))
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("a late rejection was answered as %v", err)
	}
	var rejection *RejectionError
	if errors.As(err, &rejection) {
		t.Fatal("a late rejection escaped as a contract outcome")
	}
}

// TestTheRealBundleAnswersAColdRequest is the smoke test of the pinned worker
// bundle.
//
// It proves that the real process accepts the readiness probe and answers a
// cold request. It does not prove that the cold start is outside the
// exchange budget: the length of the real boot depends on the host, and a
// budget below it would be a wall-clock assumption. The regression that
// proves the add-back is `TestTheColdStartDoesNotConsumeTheExchangeBudget`,
// which simulates a boot instead of measuring one.
func TestTheRealBundleAnswersAColdRequest(t *testing.T) {
	entry := os.Getenv("KHA66_WORKER_ENTRY")
	if entry == "" {
		t.Skip("set KHA66_WORKER_ENTRY to a built build/rules-worker/worker.mjs")
	}
	client, err := New(Config{Entry: entry, RequestTimeout: 3 * time.Second, StartTimeout: 30 * time.Second})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	response, err := client.Evaluate(context.Background(), moveRequest("real-cold"))
	if err != nil {
		t.Fatalf("the real bundle did not answer a cold request: %v", err)
	}
	if response.Candidate == nil || response.Candidate.Move.From != "e2" {
		t.Fatalf("candidate = %+v", response.Candidate)
	}
}

// TestTheCallerDeadlineIsCarriedDuringTheReadiness proves that the deadline
// of the caller is carried when it ends the call before the internal budget.
//
// The worker never answers the readiness probe, and the deadline of the
// caller is the earlier one. The derived context of the exchange clamps its
// own deadline to the deadline of the caller, so the class must not be read
// from that clamped value.
func TestTheCallerDeadlineIsCarriedDuringTheReadiness(t *testing.T) {
	client, err := New(Config{Entry: testEntryWithHangingProbe(t, "hang-probe"), RequestTimeout: 30 * time.Second, StartTimeout: 30 * time.Second})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	caller, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_, err = client.Evaluate(caller, request("ok"))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the deadline of the caller was not carried: %v", err)
	}
	if errors.Is(err, ErrTimeout) && !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the call was reported as an internal timeout: %v", err)
	}
}

// TestTheCallerDeadlineIsCarriedInAWarmedExchange proves the same for a
// worker that is already ready.
func TestTheCallerDeadlineIsCarriedInAWarmedExchange(t *testing.T) {
	client, err := New(Config{Entry: testEntry(t), RequestTimeout: 30 * time.Second, StartTimeout: 30 * time.Second})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	warm, cancelWarm := context.WithTimeout(context.Background(), warmBudget)
	defer cancelWarm()
	if err = client.Warm(warm); err != nil {
		t.Fatalf("warm: %v", err)
	}
	caller, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_, err = client.Evaluate(caller, request("slow"))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the deadline of the caller was not carried: %v", err)
	}
}

// TestAnInternalTimeoutCarriesNoCause proves that a worker that does not
// answer inside its own budget is an outage of the worker and not the
// deadline of a caller, even when the caller has a later deadline.
func TestAnInternalTimeoutCarriesNoCause(t *testing.T) {
	client, err := New(Config{Entry: testEntry(t), RequestTimeout: 200 * time.Millisecond, StartTimeout: 30 * time.Second})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	warm, cancelWarm := context.WithTimeout(context.Background(), warmBudget)
	defer cancelWarm()
	if err = client.Warm(warm); err != nil {
		t.Fatalf("warm: %v", err)
	}
	caller, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err = client.Evaluate(caller, request("slow"))
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("the internal timeout is not a timeout: %v", err)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("an internal timeout was reported as the deadline of the caller: %v", err)
	}
}

// TestTheEqualBoundaryBelongsToTheInternalBudget proves the rule of the
// boundary: when the two deadlines are equal, the internal budget wins.
func TestTheEqualBoundaryBelongsToTheInternalBudget(t *testing.T) {
	boundary := time.Now().Add(time.Second)
	caller, cancel := context.WithDeadline(context.Background(), boundary)
	defer cancel()
	if err := exchangeError(boundary, caller); errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the boundary was reported as the deadline of the caller: %v", err)
	}
	if err := exchangeError(boundary, caller); !errors.Is(err, ErrTimeout) {
		t.Fatalf("the boundary is not a timeout: %v", err)
	}
}

// TestACanceledCallReapsTheWorker proves that a canceled call leaves no dead
// worker behind.
//
// The exchange kills the worker when the deadline passes. A canceled call
// must still reap it, so the client does not keep a dead worker as its ready
// one, and the next request starts a fresh worker.
func TestACanceledCallReapsTheWorker(t *testing.T) {
	client, err := New(Config{Entry: testEntry(t), RequestTimeout: 5 * time.Second, StartTimeout: 10 * time.Second})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	warm, cancelWarm := context.WithTimeout(context.Background(), warmBudget)
	defer cancelWarm()
	if err = client.Warm(warm); err != nil {
		t.Fatalf("warm: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	_, err = client.Evaluate(ctx, request("slow"))
	if !errors.Is(err, ErrCanceled) {
		t.Fatalf("a canceled caller got %v instead of a cancellation", err)
	}
	if client.proc != nil {
		t.Fatal("the killed worker was not reaped")
	}
	if client.ready {
		t.Fatal("the client still holds the dead worker as its ready one")
	}
	// The next request starts a fresh worker and succeeds.
	if _, err = client.Evaluate(context.Background(), request("ok")); err != nil {
		t.Fatalf("the next request: %v", err)
	}
}

// TestTheCancellationCarriesTheCauseOfTheCaller proves that the class of a
// cancellation can be told apart from a failure of the worker.
//
// The health probe of the service skips the downgrade of the rules
// dependency when the error is a cancellation of its own context, and that
// guard needs the cause. An internal timeout of the request or of the start
// carries no cause, so a genuine outage of the worker is never recorded as
// the deadline of a caller.
func TestTheCancellationCarriesTheCauseOfTheCaller(t *testing.T) {
	if !errors.Is(ErrCanceled, context.Canceled) {
		t.Fatal("the cancellation does not carry the cause of the context")
	}
	if errors.Is(ErrTimeout, context.DeadlineExceeded) {
		t.Fatal("an internal timeout is reported as the deadline of a caller")
	}
	if errors.Is(ErrTimeout, context.Canceled) {
		t.Fatal("an internal timeout is reported as a cancellation")
	}
}

// TestTheCrashSurvivesAFailedStartOfTheReplacement proves that a failure of
// the start does not replace the specific failure of an earlier attempt.
//
// The worker dies on the first exchange and the replacement never answers
// the readiness probe. The call reports the crash: an operator must be able
// to tell "the worker died" from "the replacement never became ready".
func TestTheCrashSurvivesAFailedStartOfTheReplacement(t *testing.T) {
	client, err := New(Config{Entry: testEntryWithHangingProbe(t, "hang-replacement-probe"), RequestTimeout: 2 * time.Second, StartTimeout: time.Second})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	_, err = client.Evaluate(context.Background(), request("crash"))
	if !errors.Is(err, ErrCrashed) {
		t.Fatalf("the crash was replaced by the failed start of the replacement: %v", err)
	}
}

// TestTheCancellationWinsOverAnEarlierCrash proves that the cancellation of
// the caller keeps its class, whatever happened before it.
//
// The first exchange crashes and the retry is in flight when the caller
// goes away. The call reports the cancellation, because the caller knows
// that it left.
func TestTheCancellationWinsOverAnEarlierCrash(t *testing.T) {
	client, err := New(Config{Entry: testEntry(t), RequestTimeout: 5 * time.Second, StartTimeout: 10 * time.Second})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(300 * time.Millisecond)
		cancel()
	}()
	_, err = client.Evaluate(ctx, request("crash-then-hang"))
	if !errors.Is(err, ErrCanceled) {
		t.Fatalf("a canceled caller got %v instead of a cancellation", err)
	}
	if errors.Is(err, ErrCrashed) {
		t.Fatal("the crash of the first exchange replaced the cancellation of the caller")
	}
}

// TestTheProbeReportsABusyWorkerWithoutWaiting proves that a probe of a
// worker that is busy with a request returns at once.
//
// A busy worker is not an outage. The probe must not queue behind the
// participant request, and it must not spend the budget of that request.
func TestTheProbeReportsABusyWorkerWithoutWaiting(t *testing.T) {
	client, err := New(Config{Entry: testEntry(t), RequestTimeout: time.Second, StartTimeout: 10 * time.Second})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	warm, cancelWarm := context.WithTimeout(context.Background(), warmBudget)
	defer cancelWarm()
	if err = client.Warm(warm); err != nil {
		t.Fatalf("warm: %v", err)
	}
	// A request holds the worker.
	release := make(chan struct{})
	held := make(chan error, 1)
	go func() {
		_, requestErr := client.Evaluate(context.Background(), request("slow"))
		held <- requestErr
	}()
	// Wait until the request owns the slot: the permit is in the channel.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if len(client.slot) == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	started := time.Now()
	probeErr := client.Probe(context.Background())
	elapsed := time.Since(started)
	if !errors.Is(probeErr, ErrBusy) {
		t.Fatalf("the probe of a busy worker = %v, want ErrBusy", probeErr)
	}
	if elapsed > time.Second {
		t.Fatalf("the probe of a busy worker waited %s", elapsed)
	}
	close(release)
	// The held request ends with the timeout of its own budget; the probe is
	// what this fixture is about.
	<-held
}

// TestTheProbeOfAReadyWorkerSucceeds proves that a probe of a warm worker
// reports the worker as ready.
func TestTheProbeOfAReadyWorkerSucceeds(t *testing.T) {
	client, err := New(Config{Entry: testEntry(t), RequestTimeout: 5 * time.Second, StartTimeout: 10 * time.Second})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	if err = client.Probe(context.Background()); err != nil {
		t.Fatalf("the probe of a cold worker: %v", err)
	}
	if err = client.Probe(context.Background()); err != nil {
		t.Fatalf("the probe of a ready worker: %v", err)
	}
}

// TestTheEvaluatorReportsTheBusySignal proves that the busy signal of the
// client reaches the shared contract of the service.
//
// The monitor of the service leaves the durable health alone for a busy
// process, so the signal has to be the one of the shared contract.
func TestTheEvaluatorReportsTheBusySignal(t *testing.T) {
	client, err := New(Config{Entry: testEntry(t), RequestTimeout: time.Second, StartTimeout: 10 * time.Second})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	evaluator, err := NewOnlineEvaluator(client)
	if err != nil {
		t.Fatalf("new evaluator: %v", err)
	}
	held := make(chan error, 1)
	go func() {
		_, requestErr := client.Evaluate(context.Background(), request("slow"))
		held <- requestErr
	}()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if len(client.slot) == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	probeErr := evaluator.Probe(context.Background())
	if !errors.Is(probeErr, online.ErrRulesBusy) {
		t.Fatalf("the probe of a busy worker = %v, want online.ErrRulesBusy", probeErr)
	}
	client.Close()
	<-held
}

func TestEvaluateReturnsValidatedMoveCandidate(t *testing.T) {
	client := testClient(t, exchangeBudget)
	response, err := client.Evaluate(context.Background(), moveRequest("ok"))
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if response.RequestID != "ok" || response.MatchVersion != 41 {
		t.Fatalf("correlation lost: %+v", response)
	}
	if response.RulesPolicyVersion != RulesPolicyVersion || response.Engine.Name != EngineName || response.Engine.Version != EngineVersion {
		t.Fatalf("version pins lost: %+v", response)
	}
	if !fingerprintShape.MatchString(response.InputFingerprint) {
		t.Fatalf("fingerprint = %q", response.InputFingerprint)
	}
	if response.Input.Identity != "history-shape" {
		t.Fatalf("request did not send FEN history: %q", response.Input.Identity)
	}
	if response.Candidate == nil || response.Candidate.Move.From != "e2" || response.Candidate.Move.To != "e4" {
		t.Fatalf("candidate = %+v", response.Candidate)
	}
	if response.Candidate.Repetition.Version != 1 || len(response.Candidate.Repetition.Entries) != 1 {
		t.Fatalf("candidate repetition = %+v", response.Candidate.Repetition)
	}
}

func TestEvaluateReturnsTimeoutWinnerWithoutCandidate(t *testing.T) {
	client := testClient(t, exchangeBudget)
	req := request("timeout")
	req.Intent = &Intent{Kind: "timeout", ExpiredColor: "w"}
	response, err := client.Evaluate(context.Background(), req)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if response.Facts.TimeoutWinner == nil || *response.Facts.TimeoutWinner != "white" {
		t.Fatalf("timeout winner = %+v", response.Facts.TimeoutWinner)
	}
	if response.Candidate != nil {
		t.Fatalf("timeout candidate = %+v", response.Candidate)
	}
}

func TestEvaluateSurfacesRejectionWithoutKillingTheWorker(t *testing.T) {
	client := testClient(t, exchangeBudget)
	_, err := client.Evaluate(context.Background(), moveRequest("reject"))
	var rejection *RejectionError
	if !errors.As(err, &rejection) || rejection.Code != "illegal-move" {
		t.Fatalf("rejection = %v", err)
	}
	if _, err := client.Evaluate(context.Background(), request("ok")); err != nil {
		t.Fatalf("worker did not continue after rejection: %v", err)
	}
}

func TestRejectedOrMismatchedOutputCannotReturnACandidate(t *testing.T) {
	cases := map[string]error{
		"stale-request":         ErrCorrelation,
		"stale-match":           ErrCorrelation,
		"stale-policy":          ErrCorrelation,
		"stale-fingerprint":     ErrCorrelation,
		"history-drift":         ErrCorrelation,
		"timeout-side-drift":    ErrCorrelation,
		"stale-engine":          ErrCorrelation,
		"stale-fen":             ErrCorrelation,
		"missing-candidate":     ErrMalformed,
		"candidate-on-evaluate": ErrMalformed,
		"timeout-no-winner":     ErrMalformed,
		"malformed-facts":       ErrMalformed,
		"bad-candidate-fen":     ErrMalformed,
		"extra-field":           ErrMalformed,
	}
	for id, want := range cases {
		t.Run(id, func(t *testing.T) {
			client := testClient(t, exchangeBudget)
			req := moveRequest(id)
			switch id {
			case "candidate-on-evaluate":
				req = request(id)
			case "timeout-no-winner", "timeout-side-drift":
				req.Intent = &Intent{Kind: "timeout", ExpiredColor: "w"}
			case "history-drift":
				// Same evaluated FEN, one extra entry in the ordered history.
				req.History = []string{initialFEN, initialFEN}
			}
			response, err := client.Evaluate(context.Background(), req)
			if !errors.Is(err, want) {
				t.Fatalf("error = %v, want %v", err, want)
			}
			if response.RequestID != "" || response.Candidate != nil || response.Facts.Ending != "" || response.InputFingerprint != "" {
				t.Fatalf("error returned a usable response: %+v", response)
			}
		})
	}
}

func TestTimeoutKillsTheWorkerAndTheNextRequestRestartsIt(t *testing.T) {
	// The worker is warm, so the measured timeout is the timeout of the
	// exchange and not the cold start of the worker. The restart after the
	// timeout is bounded by the start budget of the client, because the
	// restart pays the cold start of a fresh worker.
	client := testClient(t, 500*time.Millisecond)
	started := time.Now()
	response, err := client.Evaluate(context.Background(), request("slow"))
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("error = %v, want timeout", err)
	}
	if response.RequestID != "" || response.Candidate != nil {
		t.Fatalf("timeout returned a usable response: %+v", response)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("timeout took %s", elapsed)
	}
	restarted := time.Now()
	if _, err := client.Evaluate(context.Background(), request("ok")); err != nil {
		t.Fatalf("restart after timeout: %v", err)
	}
	// The restart pays the cold start of the worker, so it is bounded by
	// the start budget of the client and not by the exchange budget.
	if elapsed := time.Since(restarted); elapsed > client.config.StartTimeout+exchangeBudget {
		t.Fatalf("the restart took %s, more than the start budget and one exchange", elapsed)
	}
}

func TestCancellationKillsTheWorker(t *testing.T) {
	client := testClient(t, 5*time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	response, err := client.Evaluate(ctx, request("slow"))
	if !errors.Is(err, ErrCanceled) {
		t.Fatalf("error = %v, want canceled", err)
	}
	if response.RequestID != "" || response.Candidate != nil {
		t.Fatalf("cancellation returned a usable response: %+v", response)
	}
}

func TestCanceledRequestDoesNotAttemptToStartWorker(t *testing.T) {
	entry := filepath.Join(t.TempDir(), "unused.mjs")
	if err := os.WriteFile(entry, []byte("process.exit(0)"), 0600); err != nil {
		t.Fatal(err)
	}
	client, err := New(Config{Entry: entry, Node: "kha66-worker-must-not-start"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := client.Evaluate(ctx, request("ok")); !errors.Is(err, ErrCanceled) {
		t.Fatalf("already-canceled request attempted to start a process: %v", err)
	}
}

func TestCrashAndMalformedOutputAreBoundedAndRecoverable(t *testing.T) {
	// The size limit of the fixture is small, so the oversized line is
	// detected after a modest transfer instead of after a megabyte of pipe
	// traffic. The assertion stays exact: an oversized answer is malformed.
	client, err := New(Config{
		Entry:            testEntry(t),
		RequestTimeout:   exchangeBudget,
		MaxResponseBytes: 8 << 10,
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	warm, cancel := context.WithTimeout(context.Background(), warmBudget)
	defer cancel()
	if err = client.Warm(warm); err != nil {
		t.Fatalf("warm the worker: %v", err)
	}
	if _, err = client.Evaluate(context.Background(), request("crash")); !errors.Is(err, ErrCrashed) {
		t.Fatalf("crash error = %v", err)
	}
	if _, err = client.Evaluate(context.Background(), request("ok")); err != nil {
		t.Fatalf("restart after crash: %v", err)
	}
	if _, err = client.Evaluate(context.Background(), request("malformed")); !errors.Is(err, ErrMalformed) {
		t.Fatalf("malformed error = %v", err)
	}
	if _, err = client.Evaluate(context.Background(), request("ok")); err != nil {
		t.Fatalf("restart after malformed output: %v", err)
	}
	if _, err = client.Evaluate(context.Background(), request("oversized")); !errors.Is(err, ErrMalformed) {
		t.Fatalf("oversized error = %v", err)
	}
}

func TestInvalidRequestsNeverStartTheWorker(t *testing.T) {
	entry := testEntry(t)
	client, err := New(Config{Entry: entry, RequestTimeout: time.Second})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	cases := map[string]func(*Request){
		"empty id":        func(req *Request) { req.RequestID = "" },
		"space id":        func(req *Request) { req.RequestID = "two words" },
		"zero version":    func(req *Request) { req.MatchVersion = 0 },
		"unsafe version":  func(req *Request) { req.MatchVersion = MaxMatchVersion + 1 },
		"long fen":        func(req *Request) { req.FEN = strings.Repeat("x", MaxFENLength+1) },
		"newline fen":     func(req *Request) { req.FEN = initialFEN + "\n" },
		"empty history":   func(req *Request) { req.History = nil },
		"long history":    func(req *Request) { req.History = []string{strings.Repeat("x", MaxFENLength+1)} },
		"newline history": func(req *Request) { req.History = []string{initialFEN + "\n"} },
		"stale history":   func(req *Request) { req.History = []string{"4k3/8/8/8/8/8/8/4K3 w - - 0 1"} },
		"large history": func(req *Request) {
			req.History = make([]string, MaxHistoryFENs+1)
			for index := range req.History {
				req.History[index] = initialFEN
			}
		},
		"bad intent": func(req *Request) { req.Intent = &Intent{Kind: "resign"} },
		"bad squares": func(req *Request) {
			req.Intent = &Intent{Kind: "move", From: "e2", To: "e9"}
		},
		"bad promotion": func(req *Request) {
			req.Intent = &Intent{Kind: "move", From: "a7", To: "a8", Promotion: "k"}
		},
		"mixed timeout": func(req *Request) {
			req.Intent = &Intent{Kind: "timeout", ExpiredColor: "w", From: "e2"}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			req := request("ok")
			mutate(&req)
			response, err := client.Evaluate(context.Background(), req)
			if !errors.Is(err, ErrInvalidRequest) {
				t.Fatalf("error = %v", err)
			}
			if response.RequestID != "" || response.Candidate != nil {
				t.Fatalf("invalid request returned a candidate: %+v", response)
			}
		})
	}
}

func TestConcurrentEvaluationsAreSerialized(t *testing.T) {
	client := testClient(t, 2*time.Second)
	var wait sync.WaitGroup
	errorsSeen := make(chan error, 6)
	for index := 0; index < 6; index += 1 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			if _, err := client.Evaluate(context.Background(), moveRequest("ok")); err != nil {
				errorsSeen <- err
			}
		}()
	}
	wait.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		t.Fatalf("concurrent evaluate: %v", err)
	}
}

// TestSemanticInputFingerprintMatchesTheWorkerCanonicalJSON pins the exact
// canonical bytes the Go client hashes, so the recomputation cannot drift from
// inputFingerprint() in the JavaScript worker. The fake worker below hashes the
// same canonical form with JSON.stringify as an end-to-end parity check.
func TestSemanticInputFingerprintMatchesTheWorkerCanonicalJSON(t *testing.T) {
	movedFEN := "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
	prefix := `{"protocolVersion":1,"rulesPolicyVersion":"online-rules/1","matchVersion":`
	cases := []struct {
		name    string
		request Request
		payload string
	}{
		{
			name:    "evaluate only",
			request: request("fingerprint"),
			payload: prefix + `41,"fen":"` + initialFEN + `","history":["` + initialFEN + `"],"intent":null}`,
		},
		{
			name:    "move intent without promotion",
			request: moveRequest("fingerprint"),
			payload: prefix + `41,"fen":"` + initialFEN + `","history":["` + initialFEN + `"],"intent":{"kind":"move","from":"e2","to":"e4","promotion":null}}`,
		},
		{
			name: "move intent with promotion over an ordered history",
			request: Request{
				RequestID:    "fingerprint",
				MatchVersion: 9,
				FEN:          movedFEN,
				History:      []string{initialFEN, movedFEN},
				Intent:       &Intent{Kind: "move", From: "a7", To: "a8", Promotion: "q"},
			},
			payload: `{"protocolVersion":1,"rulesPolicyVersion":"online-rules/1","matchVersion":9,"fen":"` + movedFEN +
				`","history":["` + initialFEN + `","` + movedFEN + `"],"intent":{"kind":"move","from":"a7","to":"a8","promotion":"q"}}`,
		},
		{
			name: "timeout intent names the expired side",
			request: Request{
				RequestID:    "fingerprint",
				MatchVersion: 41,
				FEN:          initialFEN,
				History:      []string{initialFEN},
				Intent:       &Intent{Kind: "timeout", ExpiredColor: "b"},
			},
			payload: prefix + `41,"fen":"` + initialFEN + `","history":["` + initialFEN + `"],"intent":{"kind":"timeout","expiredColor":"b"}}`,
		},
		{
			name: "policy override",
			request: Request{
				RequestID:          "fingerprint",
				MatchVersion:       41,
				FEN:                initialFEN,
				History:            []string{initialFEN},
				RulesPolicyVersion: "online-rules/2",
			},
			payload: `{"protocolVersion":1,"rulesPolicyVersion":"online-rules/2","matchVersion":41,"fen":"` + initialFEN +
				`","history":["` + initialFEN + `"],"intent":null}`,
		},
	}

	seen := make(map[string]string, len(cases))
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			digest := sha256.Sum256([]byte(testCase.payload))
			want := "sha256:" + hex.EncodeToString(digest[:])
			got, err := semanticInputFingerprint(testCase.request)
			if err != nil {
				t.Fatalf("fingerprint: %v", err)
			}
			if got != want {
				t.Fatalf("fingerprint = %s, want %s for canonical %s", got, want, testCase.payload)
			}
			if previous, duplicate := seen[got]; duplicate {
				t.Fatalf("%s shares a fingerprint with %s", testCase.name, previous)
			}
			seen[got] = testCase.name
		})
	}
}

// TestQueuedRequestHonoursItsOwnDeadline covers the regression where a request
// waited on the client mutex outside its timeout budget. The queued request must
// give up on schedule and leave the in-flight exchange running.
func TestQueuedRequestHonoursItsOwnDeadline(t *testing.T) {
	client := testClient(t, 3*time.Second)
	type outcome struct {
		response Response
		err      error
	}
	active := make(chan outcome, 1)
	go func() {
		response, err := client.Evaluate(context.Background(), request("delay"))
		active <- outcome{response: response, err: err}
	}()
	// Let the first request take the worker slot before queueing behind it.
	time.Sleep(150 * time.Millisecond)

	queuedCtx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	queued, err := client.Evaluate(queuedCtx, request("ok"))
	elapsed := time.Since(started)
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("queued error = %v, want timeout", err)
	}
	if queued.RequestID != "" || queued.Candidate != nil || queued.Facts.Ending != "" {
		t.Fatalf("queued timeout returned a usable response: %+v", queued)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("queued request waited %s for the worker instead of its own deadline", elapsed)
	}

	result := <-active
	if result.err != nil {
		t.Fatalf("active request was interrupted by the queued timeout: %v", result.err)
	}
	if result.response.RequestID != "delay" || result.response.Facts.Ending != "none" {
		t.Fatalf("active response = %+v", result.response)
	}
}

func TestCancelingAQueuedRequestLeavesTheActiveRequestAlone(t *testing.T) {
	client := testClient(t, 3*time.Second)
	active := make(chan error, 1)
	go func() {
		_, err := client.Evaluate(context.Background(), request("delay"))
		active <- err
	}()
	time.Sleep(150 * time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(80 * time.Millisecond)
		cancel()
	}()
	started := time.Now()
	if _, err := client.Evaluate(ctx, request("ok")); !errors.Is(err, ErrCanceled) {
		t.Fatalf("queued error = %v, want canceled", err)
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("canceled queued request waited %s", elapsed)
	}
	if err := <-active; err != nil {
		t.Fatalf("active request was interrupted by the queued cancellation: %v", err)
	}
}

func TestCloseRejectsFurtherRequests(t *testing.T) {
	client := testClient(t, exchangeBudget)
	if err := client.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
	if _, err := client.Evaluate(context.Background(), request("ok")); !errors.Is(err, ErrClosed) {
		t.Fatalf("error = %v", err)
	}
}

func TestWorkerEnvironmentIsNarrow(t *testing.T) {
	environment := workerEnvironment([]string{
		"PATH=C:\\node",
		"SystemRoot=C:\\Windows",
		"DATABASE_URL=postgres://private",
		"CLERK_SECRET_KEY=clerk",
		"OPENAI_API_KEY=provider",
		"HTTPS_PROXY=http://proxy",
	})
	joined := strings.Join(environment, "\n")
	for _, forbidden := range []string{"DATABASE_URL", "CLERK_SECRET_KEY", "OPENAI_API_KEY", "HTTPS_PROXY"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("worker environment leaked %s", forbidden)
		}
	}
	if !strings.Contains(joined, "PATH=C:\\node") || !strings.Contains(joined, "SystemRoot=C:\\Windows") {
		t.Fatalf("worker environment lost required entries: %v", environment)
	}
	if !strings.Contains(joined, "NODE_ENV=production") {
		t.Fatalf("worker environment has no fixed Node environment: %v", environment)
	}
}

// TestBuiltWorkerIntegration exercises the real pinned bundle when it has been
// built. It is skipped in the normal suite so the parent does not depend on a
// build artifact; set KHA66_WORKER_ENTRY to build/rules-worker/worker.mjs to run
// the packaging check.
func TestBuiltWorkerIntegration(t *testing.T) {
	entry := os.Getenv("KHA66_WORKER_ENTRY")
	if entry == "" {
		t.Skip("set KHA66_WORKER_ENTRY to a built build/rules-worker/worker.mjs")
	}
	client, err := New(Config{Entry: entry, RequestTimeout: 3 * time.Second})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	defer client.Close()

	response, err := client.Evaluate(context.Background(), moveRequest("built-worker"))
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if response.Engine.Version != EngineVersion || response.RulesPolicyVersion != RulesPolicyVersion {
		t.Fatalf("versions = %+v", response)
	}
	if response.Candidate == nil || response.Candidate.SAN != "e4" {
		t.Fatalf("candidate = %+v", response.Candidate)
	}
	if response.Candidate.ResultingFEN != "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1" {
		t.Fatalf("resulting fen = %q", response.Candidate.ResultingFEN)
	}
}
