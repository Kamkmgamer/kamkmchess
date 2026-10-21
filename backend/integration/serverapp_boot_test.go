package integration

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/auth"
	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/serverapp"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The composition owns the private rules process.
//
// The proof is the process itself, not a counter of the closers. The worker
// writes its own process identifier when it starts, and the test watches that
// identifier leave the process table when the composition is released and
// when a boot fails after the worker was already started.
//
// The worker is a real process that speaks the protocol of the worker, so the
// boot really warms it and the health monitor really probes it.

// fixtureRulesWorker is the private rules process of the composition proof.
type fixtureRulesWorker struct {
	// entry is the bundle the composition starts.
	entry string
	// pidFile carries the process identifier of the running worker.
	pidFile string
}

// workerBehaviour is what the fixture worker does with a request.
type workerBehaviour int

const (
	// workerAnswers speaks the protocol of the worker.
	workerAnswers workerBehaviour = iota
	// workerLeaves leaves the process without answering a request.
	workerLeaves
)

// The bundle of the fixture worker.
//
// The worker answers the facts requests of the protocol, and it refuses a
// request with a move intent, because the composition proof never evaluates a
// move. The digest of the answer is the digest the service computes, so the
// service accepts the answer of the worker.
//
// The path of the process identifier file is a literal, because the worker
// starts with a filtered environment.
const fixtureRulesWorkerBundle = `
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

writeFileSync(%s, String(process.pid));

function canonicalIntent(intent) {
  if (!intent) return 'null';
  if (intent.kind === 'move') {
    return '{"kind":"move","from":' + JSON.stringify(intent.from) +
      ',"to":' + JSON.stringify(intent.to) +
      ',"promotion":' + (intent.promotion ? JSON.stringify(intent.promotion) : 'null') + '}';
  }
  return '{"kind":"timeout","expiredColor":' + JSON.stringify(intent.expiredColor) + '}';
}

function fingerprint(request) {
  const canonical =
    '{"protocolVersion":' + request.protocolVersion +
    ',"rulesPolicyVersion":' + JSON.stringify(request.rulesPolicyVersion) +
    ',"matchVersion":' + request.matchVersion +
    ',"fen":' + JSON.stringify(request.fen) +
    ',"history":[' + request.history.map((fen) => JSON.stringify(fen)).join(',') +
    '],"intent":' + canonicalIntent(request.intent) + '}';
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function answer(request) {
  if (request.intent) {
    return {
      protocolVersion: 1,
      status: 'rejected',
      requestId: request.requestId,
      matchVersion: request.matchVersion,
      rulesPolicyVersion: request.rulesPolicyVersion,
      inputFingerprint: fingerprint(request),
      code: 'fixture-no-move',
      message: 'the fixture worker answers facts requests only',
    };
  }
  return {
    protocolVersion: 1,
    status: 'ok',
    requestId: request.requestId,
    matchVersion: request.matchVersion,
    rulesPolicyVersion: request.rulesPolicyVersion,
    inputFingerprint: fingerprint(request),
    engine: { name: 'chessops', version: '0.15.1' },
    input: { fen: request.fen, identity: 'fixture-position', repetitionCount: '1' },
    facts: {
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
        white: { p: 16, n: 2, b: 2, r: 2, q: 1, k: 1 },
        black: { p: 16, n: 2, b: 2, r: 2, q: 1, k: 1 },
        total: 64,
      },
      timeoutWinner: null,
    },
    candidate: null,
    code: '',
    message: '',
  };
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    try {
      process.stdout.write(JSON.stringify(answer(JSON.parse(line))) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({
        protocolVersion: 1,
        status: 'rejected',
        requestId: null,
        matchVersion: 1,
        rulesPolicyVersion: 'online-rules/1',
        inputFingerprint: 'sha256:' + '0'.repeat(64),
        code: 'fixture-bad-request',
        message: String(error),
      }) + '\n');
    }
    index = buffer.indexOf('\n');
  }
});
`

// The bundle of the fixture worker that leaves without answering.
//
// The worker starts, records its process identifier and leaves. The readiness
// probe of the composition therefore never gets an answer, so the boot has to
// fail instead of starting a service with a dependency it could not prove.
const fixtureRulesWorkerLeavingBundle = `
import { writeFileSync } from 'node:fs';

writeFileSync(%s, String(process.pid));
process.exit(0);
`

// newFixtureRulesWorker writes the bundle of the fixture worker.
func newFixtureRulesWorker(t *testing.T, behaviour workerBehaviour) *fixtureRulesWorker {
	t.Helper()
	directory := t.TempDir()
	entry := filepath.Join(directory, "fixture-worker.mjs")
	pidFile := filepath.Join(directory, "worker.pid")
	// The path is a literal of the bundle, so the worker finds it without an
	// environment variable.
	template := fixtureRulesWorkerBundle
	if behaviour == workerLeaves {
		template = fixtureRulesWorkerLeavingBundle
	}
	bundle := fmt.Sprintf(template, strconv.Quote(filepath.ToSlash(pidFile)))
	if err := os.WriteFile(entry, []byte(bundle), 0o600); err != nil {
		t.Fatalf("write the fixture worker bundle: %v", err)
	}
	return &fixtureRulesWorker{entry: entry, pidFile: pidFile}
}

// pid reads the process identifier of the running worker.
func (w *fixtureRulesWorker) pid(t *testing.T) int {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		raw, err := os.ReadFile(w.pidFile)
		if err == nil {
			text := strings.TrimSpace(string(raw))
			if text != "" {
				pid, convErr := strconv.Atoi(text)
				if convErr != nil {
					t.Fatalf("the worker wrote %q as its process identifier", text)
				}
				return pid
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the worker never wrote its process identifier")
	return 0
}

// fixtureClerk serves the identity document of the composition.
//
// The document is served over a local TLS server, so the verifier of the
// service checks a signed session exactly like it checks a hosted one. No
// hosted identity provider is contacted.
func fixtureClerk(t *testing.T) auth.Config {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate the fixture signing key: %v", err)
	}
	document := fmt.Sprintf(`{"keys":[{"kty":"RSA","kid":"fixture-key","use":"sig","alg":"RS256","n":"%s","e":"AQAB"}]}`,
		base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes()))
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/jwks.json" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(document))
	}))
	t.Cleanup(server.Close)
	config := auth.Config{
		Issuer:            server.URL,
		JWKSURL:           server.URL + "/.well-known/jwks.json",
		AuthorizedParties: []string{"https://app.example"},
		AllowedOrigins:    []string{"https://app.example"},
		HTTPClient:        server.Client(),
	}
	return config
}

// scopedDatabaseURL returns the database URL of the isolated schema of the
// fixture.
func scopedDatabaseURL(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var schema string
	if err := pool.QueryRow(context.Background(), `SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatalf("read the isolated schema: %v", err)
	}
	dsn := os.Getenv(databaseEnv)
	separator := "?"
	if strings.Contains(dsn, "?") {
		separator = "&"
	}
	return dsn + separator + "search_path=" + schema
}

// waitForProcessExit waits until the process identifier leaves the process
// table.
func waitForProcessExit(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("the rules worker process %d is still running", pid)
}

// The composition starts the private rules process and closes it when it is
// released.
//
// The process is the evidence: the worker writes its own process identifier,
// and the identifier leaves the process table when the release runs. A counter
// of the closers would not prove that the process is gone.
func TestServerAppBootOwnsAndClosesTheRulesWorkerProcess(t *testing.T) {
	pool := testPool(t)
	if err := migrations.Apply(context.Background(), pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	databaseURL := scopedDatabaseURL(t, pool)
	worker := newFixtureRulesWorker(t, workerAnswers)
	clerk := fixtureClerk(t)
	handler, release, err := serverapp.Open(context.Background(), serverapp.Config{
		DatabaseURL: databaseURL,
		Clerk:       clerk,
		Online: serverapp.OnlineConfig{
			GuestCredentialTTL:     5 * time.Minute,
			OwnershipProofTTL:      5 * time.Minute,
			StreamMaxDuration:      5 * time.Minute,
			RulesWorkerEntry:       worker.entry,
			DeadlineSweepInterval:  time.Hour,
			DeadlineSweepBatch:     10,
			HealthCheckInterval:    time.Hour,
			HistoryPublishInterval: time.Hour,
		},
	})
	if err != nil {
		t.Fatalf("compose the service: %v", err)
	}
	t.Cleanup(release)
	// The boot warmed the worker, so the process is running.
	pid := worker.pid(t)
	if !processAlive(pid) {
		t.Fatalf("the rules worker process %d is not running after the boot", pid)
	}
	// The composed service answers.
	request := httptest.NewRequest(http.MethodGet, "/v1/online/features", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("the composed service answered %d: %s", recorder.Code, recorder.Body.String())
	}

	release()
	// The process is gone, not only unregistered.
	waitForProcessExit(t, pid)
}

// A boot that fails after the worker started closes the worker too.
//
// The failures are real ones, not simulated ones: the durable health of the
// composition cannot be written, and the removal ledger cannot be verified.
// Both happen after the worker was started, and a failed start must never
// leave a process behind.
func TestServerAppFailedBootClosesTheRulesWorkerProcess(t *testing.T) {
	cases := []struct {
		name   string
		break_ func(t *testing.T, pool *pgxpool.Pool)
	}{
		{
			// The schema of the fixture has no online tables, so the
			// durable health of the composition cannot be written.
			name:   "the durable health cannot be written",
			break_: func(t *testing.T, pool *pgxpool.Pool) {},
		},
		{
			// The restore gates are gone, so the removal ledger cannot be
			// verified and the composition refuses to serve.
			name: "the removal ledger cannot be verified",
			break_: func(t *testing.T, pool *pgxpool.Pool) {
				t.Helper()
				if err := migrations.Apply(context.Background(), pool); err != nil {
					t.Fatalf("apply migrations: %v", err)
				}
				if _, err := pool.Exec(context.Background(), `DROP TABLE IF EXISTS online_restore_gates CASCADE`); err != nil {
					t.Fatalf("drop the restore gates: %v", err)
				}
			},
		},
		{
			// The restored database is closed, so the composition refuses
			// to serve and the boot fails closed.
			name: "the restored database has an unreplayed removal ledger",
			break_: func(t *testing.T, pool *pgxpool.Pool) {
				t.Helper()
				if err := migrations.Apply(context.Background(), pool); err != nil {
					t.Fatalf("apply migrations: %v", err)
				}
				if _, err := pool.Exec(context.Background(), `INSERT INTO online_restore_gates(gate_id,restore_id,ledger_digest,serving_allowed,recorded_at) VALUES('rg_fixture_gate_01','restore-fixture-01',decode(repeat('00',32),'hex'),false,clock_timestamp())`); err != nil {
					t.Fatalf("close the restore gate: %v", err)
				}
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			pool := testPool(t)
			testCase.break_(t, pool)
			databaseURL := scopedDatabaseURL(t, pool)
			worker := newFixtureRulesWorker(t, workerAnswers)
			clerk := fixtureClerk(t)
			handler, release, err := serverapp.Open(context.Background(), serverapp.Config{
				DatabaseURL: databaseURL,
				Clerk:       clerk,
				Online: serverapp.OnlineConfig{
					GuestCredentialTTL:     5 * time.Minute,
					OwnershipProofTTL:      5 * time.Minute,
					StreamMaxDuration:      5 * time.Minute,
					RulesWorkerEntry:       worker.entry,
					DeadlineSweepInterval:  time.Hour,
					DeadlineSweepBatch:     10,
					HealthCheckInterval:    time.Hour,
					HistoryPublishInterval: time.Hour,
				},
			})
			if err == nil {
				if release != nil {
					release()
				}
				t.Fatal("the composition started although it could not serve")
			}
			if handler != nil {
				t.Fatal("the failed composition returned a handler")
			}
			// The worker was started before the failure, so it has to be
			// closed by it.
			pid := worker.pid(t)
			waitForProcessExit(t, pid)
		})
	}
}

// A worker that never answers the readiness probe stops the boot.
//
// The service must not start with a dependency it could not prove. The probe
// cannot repair the failure afterwards either: a probe of a cold worker
// cannot tell a busy worker from a broken one, so an ignored failure could
// neither degrade the dependency nor recover it. The boot fails, and the
// worker of the failed boot leaves the process table.
func TestServerAppWarmFailureFailsTheBoot(t *testing.T) {
	pool := testPool(t)
	if err := migrations.Apply(context.Background(), pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	databaseURL := scopedDatabaseURL(t, pool)
	worker := newFixtureRulesWorker(t, workerLeaves)
	clerk := fixtureClerk(t)
	handler, release, err := serverapp.Open(context.Background(), serverapp.Config{
		DatabaseURL: databaseURL,
		Clerk:       clerk,
		Online: serverapp.OnlineConfig{
			GuestCredentialTTL:     5 * time.Minute,
			OwnershipProofTTL:      5 * time.Minute,
			StreamMaxDuration:      5 * time.Minute,
			RulesWorkerEntry:       worker.entry,
			DeadlineSweepInterval:  time.Hour,
			DeadlineSweepBatch:     10,
			HealthCheckInterval:    time.Hour,
			HistoryPublishInterval: time.Hour,
		},
	})
	if err == nil {
		if release != nil {
			release()
		}
		t.Fatal("the composition started with a worker that never answered the readiness probe")
	}
	if handler != nil {
		t.Fatal("the failed composition returned a handler")
	}
	// The worker was started before the failure, and the failed boot left no
	// process behind.
	pid := worker.pid(t)
	waitForProcessExit(t, pid)
}
