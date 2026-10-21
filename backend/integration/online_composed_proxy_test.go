package integration

// The composed rules proxy.
//
// The process proof of the online service needs a real rules worker and a
// real failure of a real process. The proxy below is a real Node process that
// the rules client starts exactly like the worker bundle: it speaks the
// pinned protocol on stdin and stdout. The proxy never answers on its own.
// It runs the real bundle as its own child process and forwards every
// request to it, so every answer the caller sees is an answer of the real
// engine.
//
// The proxy only decides what happens to one answer. It can keep the answer
// (the caller waits for a worker that never answers) or it can die with the
// answer in its hand (the caller sees a worker that crashed). Both are
// failures of a real process, and both are announced by a marker file, so
// the test never has to guess whether the slot of the client is occupied.
//
// The absolute paths of the bundle and of the markers are written into the
// proxy as literals. The environment of a worker is filtered by the rules
// client, so an environment variable would never reach the proxy.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The failure modes of the proxy.
const (
	// composedHold keeps the answer of the worker. The caller waits for an
	// answer that never comes, so the worker looks hung.
	composedHold = "hold"
	// composedExit kills the proxy with the answer in its hand. The caller
	// sees a worker that died.
	composedExit = "exit"
)

// composedProxySource is the proxy of the real bundle.
//
// The proxy forwards the requests to the real bundle and holds or drops the
// selected answer. The selection is read from the plan file before every
// answer, so the test can choose the exchange it wants to break without
// restarting the worker.
const composedProxySource = `
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const BUNDLE = __BUNDLE__;
const PLAN = __PLAN__;
const MARKER = __MARKER__;
const RELEASE = __RELEASE__;
const RELEASED = __RELEASED__;
const USED = __USED__;
const STARTS = __STARTS__;

// The real bundle is the child of the proxy. The proxy is a transport, never
// an evaluator: every answer of the caller comes from the real engine.
const child = spawn(process.execPath, [BUNDLE], { stdio: ['pipe', 'pipe', 'inherit'] });
appendFileSync(STARTS, process.pid + '\n');

const requests = createInterface({ input: process.stdin, crlfDelay: Infinity });
const answers = createInterface({ input: child.stdout, crlfDelay: Infinity });

requests.on('line', (line) => { child.stdin.write(line + '\n'); });
requests.on('close', () => { child.stdin.end(); });

let generation = null;
let forwarded = 0;
let holding = false;
const held = [];

// The plan names the exchange that is broken: the answers of the generation
// are counted, the selected one is held or dropped, and the rest is
// forwarded.
function plan() {
  let raw = '';
  try {
    raw = readFileSync(PLAN, 'utf8').trim();
  } catch {
    return null;
  }
  if (raw === '') return null;
  const parts = raw.split(' ');
  const count = Number.parseInt(parts[0], 10);
  return {
    count: Number.isFinite(count) ? count : 0,
    generation: parts[1] || '',
    mode: parts[2] || 'hold',
  };
}

function release() {
  holding = false;
  for (const line of held.splice(0)) process.stdout.write(line + '\n');
  writeFileSync(RELEASED, 'released\n');
}

answers.on('line', (line) => {
  if (holding) {
    held.push(line);
    return;
  }
  const current = plan();
  if (current === null) {
    generation = null;
    forwarded = 0;
    process.stdout.write(line + '\n');
    return;
  }
  if (current.generation !== generation) {
    generation = current.generation;
    forwarded = 0;
  }
  // The break of an earlier generation is used once, so the replacement of a
  // broken worker behaves like a healthy worker.
  if (existsSync(USED)) {
    process.stdout.write(line + '\n');
    return;
  }
  if (forwarded < current.count) {
    forwarded += 1;
    process.stdout.write(line + '\n');
    return;
  }
  // The real bundle already answered, so the failure below is a real
  // failure of a real process.
  held.push(line);
  writeFileSync(MARKER, 'held\n');
  if (!existsSync(USED)) writeFileSync(USED, 'used\n');
  if (current.mode === 'exit') {
    // The worker dies with the answer in its hand.
    process.exit(9);
  }
  holding = true;
  const timer = setInterval(() => {
    if (!existsSync(RELEASE)) return;
    clearInterval(timer);
    try {
      unlinkSync(RELEASE);
    } catch {
      // The release is consumed once.
    }
    release();
  }, 20);
});
`

// composedProxy is a real worker process in front of the real bundle.
//
// The proxy owns the files that describe the selected exchange, so the test
// can hold an exchange, release it and count the processes that the client
// started.
type composedProxy struct {
	entry    string
	plan     string
	marker   string
	release  string
	released string
	used     string
	starts   string
}

// newComposedProxy writes the proxy of the real bundle.
//
// The proxy is written into a temporary directory, so the worker the client
// starts is a private process of this test.
func newComposedProxy(t *testing.T, bundle string) *composedProxy {
	t.Helper()
	directory := t.TempDir()
	proxy := &composedProxy{
		entry:    filepath.Join(directory, "composed-proxy-worker.mjs"),
		plan:     filepath.Join(directory, "plan"),
		marker:   filepath.Join(directory, "held"),
		release:  filepath.Join(directory, "release"),
		released: filepath.Join(directory, "released"),
		used:     filepath.Join(directory, "used"),
		starts:   filepath.Join(directory, "starts"),
	}
	source := composedProxySource
	for token, value := range map[string]string{
		"__BUNDLE__":   bundle,
		"__PLAN__":     proxy.plan,
		"__MARKER__":   proxy.marker,
		"__RELEASE__":  proxy.release,
		"__RELEASED__": proxy.released,
		"__USED__":     proxy.used,
		"__STARTS__":   proxy.starts,
	} {
		literal, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("encode %s: %v", token, err)
		}
		source = strings.ReplaceAll(source, token, string(literal))
	}
	if err := os.WriteFile(proxy.entry, []byte(source), 0o600); err != nil {
		t.Fatalf("write the composed proxy: %v", err)
	}
	return proxy
}

// selectExchange breaks the exchange of the generation.
//
// The answers of the generation are counted, and the one after the given
// number of forwarded answers is held or dropped. The break of an earlier
// generation is cleared, so every generation may break once.
func (p *composedProxy) selectExchange(t *testing.T, generation string, forward int, mode string) {
	t.Helper()
	for _, path := range []string{p.used, p.marker, p.released} {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatalf("clear the proxy state: %v", err)
		}
	}
	content := fmt.Sprintf("%d %s %s\n", forward, generation, mode)
	if err := os.WriteFile(p.plan, []byte(content), 0o600); err != nil {
		t.Fatalf("write the plan of the proxy: %v", err)
	}
}

// releaseExchange answers the held exchange.
//
// The answer of the real bundle is delivered after the release, so the
// participant request completes and the cold start proves to be healthy.
func (p *composedProxy) releaseExchange(t *testing.T) {
	t.Helper()
	if err := os.WriteFile(p.release, []byte("release\n"), 0o600); err != nil {
		t.Fatalf("write the release of the proxy: %v", err)
	}
}

// waitForHeld waits until the proxy holds an exchange.
//
// The marker is written when the real bundle answered and the answer is
// withheld, so the wait is a barrier and not a guess: when it returns, the
// slot of the rules client is occupied.
func (p *composedProxy) waitForHeld(t *testing.T, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		_, err := os.Stat(p.marker)
		if err == nil {
			return
		}
		if !os.IsNotExist(err) {
			t.Fatalf("the marker of the worker is unreadable: %v", err)
		}
		if time.Now().After(deadline) {
			t.Fatalf("the worker never held an exchange within %s", timeout)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// waitForReleased waits until the held answer was delivered.
func (p *composedProxy) waitForReleased(t *testing.T, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if _, err := os.Stat(p.released); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the worker never released the exchange within %s", timeout)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// startedProcesses counts the worker processes the client started.
//
// Every process of the proxy appends its own identity, so the count is the
// evidence that the client killed a worker and started a replacement.
func (p *composedProxy) startedProcesses(t *testing.T) int {
	t.Helper()
	raw, err := os.ReadFile(p.starts)
	if err != nil {
		if os.IsNotExist(err) {
			return 0
		}
		t.Fatalf("read the started workers: %v", err)
	}
	started := 0
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) != "" {
			started++
		}
	}
	return started
}
