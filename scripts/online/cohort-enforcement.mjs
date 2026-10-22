// The enforcement audit of the account cohorts.
//
// A cohort narrows the accounts that may use a surface. The narrowing is a
// property of the running server, so the release gate may not report it as
// enforced because a JSON file names accounts: an owner who follows such a
// gate would believe that the access is restricted while every signed-in
// account is still admitted.
//
// The audit has two parts, and both of them have to hold.
//
// The executable part runs the named enforcement tests of the tree and
// requires every one of them to pass. A tree without those tests, a
// toolchain that cannot run them and a test that fails are all blockers, so
// the gate never reports an enforcement it did not observe.
//
// The proof of the wiring is part of that run. The composition test of the
// tree reads the source of the composition with the parser of Go and prints
// a marker for every surface it proved. The audit requires the marker of
// every surface of the gate, so a composition that lost the wiring, a
// composition whose wiring is only a comment, and a tree without the proof
// are all blockers.
//
// The audit never claims the wiring from a string of the source: a text of
// the composition can name an assignment that no longer runs, and the
// marker is printed by the proof itself.
//
// Usage:
//   node scripts/online/cohort-enforcement.mjs [--root DIR] [--gate friend|queue] [--json]

import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

/**
 * @typedef {'blocker'|'warning'|'info'} Severity
 * @typedef {{ severity: Severity, code: string, message: string, remediation: string|null }} Finding
 */

/** The server setting of the cohort of each gate. */
export const COHORT_SETTINGS = {
  friend: 'ONLINE_FRIEND_COHORT',
  queue: 'ONLINE_QUEUE_COHORT',
};

/** The surfaces every gate depends on. */
export const COHORT_SURFACES = {
  friend: ['friend'],
  // The queue gate needs the friend cohort to have run, so the enforcement
  // of the friend surface is part of it as well.
  queue: ['queue', 'friend'],
};

/** The marker that the proof of the wiring prints for every surface. */
export const COHORT_WIRING_MARKER = 'COHORT-WIRING';

/** The pattern of the enforcement tests of the tree. */
export const COHORT_TEST_PATTERN = '^TestTheCohort';

/** The packages that carry the enforcement tests. */
export const COHORT_TEST_PACKAGES = ['./backend/cohort/', './backend/httpapi/', './backend/serverapp/'];

/** The budget of the run of the enforcement tests, in milliseconds. */
export const COHORT_TEST_TIMEOUT_MS = 600_000;

/** The composition that reads the settings and serves the surfaces. */
const COMPOSITION_FILE = 'backend/serverapp/server.go';

/**
 * @param {Severity} severity
 * @param {string} code
 * @param {string} message
 * @param {string|null} [remediation]
 * @returns {Finding}
 */
function finding(severity, code, message, remediation = null) {
  return { severity, code, message, remediation };
}

/**
 * Lists the enforcement tests of the tree.
 *
 * The tests are read from the tree, so the audit cannot claim an enforcement
 * that the tree does not carry. A tree without a test has no enforcement to
 * observe.
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export async function cohortEnforcementTests(root) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const pkg of COHORT_TEST_PACKAGES) {
    const directory = join(root, ...pkg.replace(/^\.\//, '').replace(/\/$/, '').split('/'));
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('_test.go')) continue;
      const text = await readFile(join(directory, entry.name), 'utf8');
      for (const match of text.matchAll(/^func (TestTheCohort[A-Za-z0-9_]*)\(/gm)) names.add(match[1]);
    }
  }
  return [...names].sort();
}

/**
 * Runs the enforcement tests of the tree.
 *
 * The run is verbose, because the audit has to know which of the named tests
 * actually ran. A package without a matching test answers "no tests to run",
 * which is not a proof of anything.
 * @param {string} root
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, failed: boolean, missing: boolean}>}
 */
export function runCohortEnforcementTests(root, timeoutMs = COHORT_TEST_TIMEOUT_MS) {
  const args = ['test', '-count=1', '-v', '-run', COHORT_TEST_PATTERN, ...COHORT_TEST_PACKAGES];
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn('go', args, { cwd: root, windowsHide: true });
    // A run that hangs must not hang the gate. The audit reports the budget
    // as a blocker instead of waiting forever.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${error instanceof Error ? error.message : String(error)}`, failed: true, missing: true });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ code: null, stdout, stderr: `${stderr}\nthe run exceeded its budget of ${timeoutMs} ms`, failed: true, missing: false });
        return;
      }
      resolve({ code, stdout, stderr, failed: code !== 0, missing: false });
    });
  });
}

/**
 * Reads the names of the tests that passed in a verbose run.
 * @param {string} output
 * @returns {Set<string>}
 */
export function passedTests(output) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const match of output.matchAll(/^--- PASS: (TestTheCohort[A-Za-z0-9_]*)/gm)) names.add(match[1]);
  return names;
}

/**
 * Reads the surfaces whose wiring the run proved.
 *
 * The marker is printed by the proof of the wiring of the tree, so a run
 * without the marker did not prove anything about the composition.
 * @param {string} output
 * @returns {Set<string>}
 */
export function provedWiring(output) {
  /** @type {Set<string>} */
  const surfaces = new Set();
  const pattern = new RegExp(`${COHORT_WIRING_MARKER}\\s+([a-z]+)=proven`, 'g');
  for (const match of output.matchAll(pattern)) surfaces.add(match[1]);
  return surfaces;
}

/**
 * Audits the enforcement of the cohort of a gate.
 *
 * @param {{root: string, gate?: string, runTests?: boolean, runner?: (root: string) => Promise<any>}} input
 * @returns {Promise<{findings: Finding[], tests: string[], ran: boolean}>}
 */
export async function auditCohortEnforcement(input) {
  const gate = input.gate ?? 'friend';
  const root = input.root;
  /** @type {Finding[]} */
  const findings = [];
  const surfaces = COHORT_SURFACES[gate] ?? [gate];
  const settings = surfaces.map((surface) => COHORT_SETTINGS[surface]);
  if (!COHORT_SETTINGS[gate]) throw new Error(`unknown gate ${gate}`);

  // The composition has to exist. The proof of the wiring reads it, and the
  // proof is part of the run of the enforcement tests.
  const composition = await readFile(join(root, ...COMPOSITION_FILE.split('/')), 'utf8').catch(() => '');
  if (!composition) {
    findings.push(finding(
      'blocker',
      'cohort-composition-missing',
      `The composition ${COMPOSITION_FILE} is missing, so nothing proves that the server reads ${settings.join(' and ')}.`,
      `Restore the composition and wire ${settings.join(' and ')} into the request path of the ${gate} surface.`,
    ));
  }

  // The executable proof. The named tests of the tree have to run and pass.
  const tests = await cohortEnforcementTests(root);
  if (tests.length === 0) {
    findings.push(finding(
      'blocker',
      'cohort-enforcement-tests-missing',
      'The tree carries no test of the cohort enforcement, so nothing proves that the server narrows the account access.',
      `Add the enforcement tests of the ${gate} surface to the tree. Their names start with TestTheCohort.`,
    ));
    return { findings, tests, ran: false, settings };
  }

  if (input.runTests === false) {
    findings.push(finding(
      'blocker',
      'cohort-enforcement-tests-not-run',
      `The enforcement tests were not run, so the enforcement of ${settings.join(' and ')} is unproven.`,
      'Run the audit without --no-tests.',
    ));
    return { findings, tests, ran: false, settings };
  }

  const run = await (input.runner ?? runCohortEnforcementTests)(root);
  if (run.missing) {
    findings.push(finding(
      'blocker',
      'cohort-enforcement-toolchain-missing',
      `The enforcement tests could not be run: ${String(run.stderr ?? '').trim() || 'the Go toolchain is missing'}.`,
      'Install the Go toolchain of go.mod and run the audit again.',
    ));
    return { findings, tests, ran: false, settings };
  }
  if (run.failed) {
    const detail = String(run.stderr ?? '').trim().split('\n').slice(-3).join(' ');
    findings.push(finding(
      'blocker',
      'cohort-enforcement-tests-failed',
      `The enforcement tests of the tree failed, so the enforcement of ${settings.join(' and ')} is unproven.${detail ? ` ${detail}` : ''}`,
      `Run "go test -count=1 -v -run ${COHORT_TEST_PATTERN} ${COHORT_TEST_PACKAGES.join(' ')}" and fix the failure.`,
    ));
    return { findings, tests, ran: true, settings };
  }

  const passed = passedTests(run.stdout);
  const notPassed = tests.filter((name) => !passed.has(name));
  if (notPassed.length > 0) {
    findings.push(finding(
      'blocker',
      'cohort-enforcement-test-not-passed',
      `These enforcement tests did not report a pass: ${notPassed.join(', ')}.`,
      'Run the enforcement tests and fix the failure. A test that did not run proves nothing.',
    ));
    return { findings, tests, ran: true, settings };
  }

  // The proof of the wiring. The marker is printed by the proof of the tree
  // itself, so a composition that lost the wiring, a composition whose
  // wiring is only a comment, and a tree without the proof are all blockers.
  const proved = provedWiring(run.stdout);
  const unproved = surfaces.filter((surface) => !proved.has(surface));
  if (unproved.length > 0) {
    findings.push(finding(
      'blocker',
      'cohort-wiring-unproven',
      `The run did not prove the wiring of the cohort into the request path of the ${unproved.join(' and ')} surface. A composition that reads ${COHORT_SETTINGS[unproved[0]]} and then ignores it admits every signed-in account, and the gate may not report that as enforced.`,
      `Pass the cohort of the configuration into the request path of the ${unproved.join(' and ')} surface, and let the proof of the composition print the marker "${COHORT_WIRING_MARKER} ${unproved.join(`=proven, ${COHORT_WIRING_MARKER} `)}=proven" for every surface it proved.`,
    ));
    return { findings, tests, ran: true, settings };
  }

  findings.push(finding(
    'info',
    'cohort-enforcement-proven',
    `The proof of the tree proved the wiring of the ${surfaces.join(' and ')} surface and ${tests.length} enforcement test(s) of the tree passed.`,
    null,
  ));
  return { findings, tests, ran: true, settings };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const rootIndex = arguments_.indexOf('--root');
  const root = rootIndex >= 0 ? arguments_[rootIndex + 1] : process.cwd();
  const gateIndex = arguments_.indexOf('--gate');
  const gate = gateIndex >= 0 ? arguments_[gateIndex + 1] : 'friend';
  const report = await auditCohortEnforcement({ root, gate, runTests: !arguments_.includes('--no-tests') });
  if (arguments_.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      tool: 'scripts/online/cohort-enforcement.mjs',
      gate,
      setting: COHORT_SETTINGS[gate],
      disclaimer: 'This audit reads the repository and runs the enforcement tests of the tree. It proves nothing about a deployed host.',
      ...report,
    }, null, 2)}\n`);
  } else {
    const blockers = report.findings.filter((item) => item.severity === 'blocker');
    process.stdout.write(`cohort enforcement: ${blockers.length === 0 ? 'proven' : 'unproven'} (${report.tests.length} enforcement test(s))\n`);
    for (const item of report.findings) {
      process.stdout.write(`  ${item.severity.toUpperCase().padEnd(8)} ${item.code}\n           ${item.message}\n`);
      if (item.remediation) process.stdout.write(`           fix: ${item.remediation}\n`);
    }
  }
  if (report.findings.some((item) => item.severity === 'blocker')) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/online/cohort-enforcement.mjs')) {
  await main();
}
