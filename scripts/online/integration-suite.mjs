// Local integration suite for the online service.
//
// It runs the real Go tests against a real PostgreSQL database with the
// pinned private rules worker, maps the results onto the approved acceptance
// scenarios, and records the evidence.
//
// It never fabricates a result: a scenario is only recorded as passed when
// every mapped test ran and passed in the same run. Native assistive
// technology, live host measurements and owner release decisions are never
// produced here.
//
// Usage:
//   node scripts/online/integration-suite.mjs [--root DIR] [--json] [--no-record]
//   node scripts/online/integration-suite.mjs --browser   # also run the browser clients

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { redactDatabaseUrl, resolveDatabaseUrl } from './fixture-client.mjs';
import { applyRouteCoverage, auditRouteManifest, routeDependencies } from './route-manifest.mjs';
import { buildEvidenceRecords } from './evidence-provenance.mjs';

/** The exact command of the database run. The report and the records name it. */
export const INTEGRATION_COMMAND = 'go test ./backend/integration -count=1 -timeout 60m -json (KHA41_TEST_DATABASE_URL=<local fixture>, KHA66_WORKER_ENTRY=build/rules-worker/worker.mjs)';

/** The exact command of the browser run. The report and the records name it. */
export const BROWSER_COMMAND = 'pnpm exec playwright test tests/e2e/online-clients.spec.ts (ONLINE_FIXTURE_DESCRIPTOR, ONLINE_FIXTURE_STRICT=1)';

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string, string>}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
      windowsHide: true,
      // A Windows package-manager shim is a batch file, which Node can only
      // start through the shell.
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolvePromise({ code: -1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Parses the JSON event stream of `go test -json`.
 * @param {string} output
 * @returns {{tests: Map<string, string>, packages: Map<string, string>}}
 */
export function parseGoTestJson(output) {
  /** @type {Map<string, string>} */
  const tests = new Map();
  /** @type {Map<string, string>} */
  const packages = new Map();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    if (event.Test && (event.Action === 'pass' || event.Action === 'fail' || event.Action === 'skip')) {
      tests.set(String(event.Test), String(event.Action));
    }
    if (!event.Test && (event.Action === 'pass' || event.Action === 'fail') && event.Package) {
      packages.set(String(event.Package), String(event.Action));
    }
  }
  return { tests, packages };
}

/**
 * Maps the test results onto the acceptance scenarios.
 * @param {{scenarios: Record<string, string[]>}} map
 * @param {Map<string, string>} tests
 * @returns {{scenarioId: string, status: 'passed'|'failed'|'not_run'|'not_implemented', tests: string[], detail: string}[]}
 */
export function mapScenarios(map, tests) {
  return Object.entries(map.scenarios).map(([scenarioId, names]) => {
    const failed = names.filter((name) => tests.get(name) === 'fail');
    const passed = names.filter((name) => tests.get(name) === 'pass');
    if (failed.length > 0) {
      return { scenarioId, status: 'failed', tests: names, detail: `${failed.join(', ')} failed` };
    }
    if (passed.length === names.length) {
      return { scenarioId, status: 'passed', tests: names, detail: `${passed.join(', ')} passed` };
    }
    const missing = names.filter((name) => !tests.has(name));
    return { scenarioId, status: 'not_run', tests: names, detail: `${missing.join(', ')} did not run` };
  });
}

/**
 * Runs the suite.
 * @param {{root: string, record: boolean, browser: boolean}} options
 * @returns {Promise<object>}
 */
export async function runIntegrationSuite(options) {
  const { root } = options;
  const databaseUrl = await resolveDatabaseUrl();
  const workerBundle = join(root, 'build', 'rules-worker', 'worker.mjs');

  const built = await runCommand(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', 'build:rules-worker'], { cwd: root });
  if (built.code !== 0) {
    throw new Error(`the rules worker bundle could not be built: ${built.stderr.trim().split('\n').slice(-1)[0] ?? ''}`);
  }

  const head = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: root });
  const commit = head.stdout.trim();
  const goVersion = (await runCommand('go', ['version'], { cwd: root })).stdout.trim();
  const nodeVersion = (await runCommand('node', ['--version'], { cwd: root })).stdout.trim();

  // The suite runs the real tests against a real database, so it needs more
  // than the default budget of the test runner of Go. The budget is explicit
  // and generous, so a slow machine does not cut the suite short.
  const testRun = await runCommand('go', ['test', './backend/integration', '-count=1', '-timeout', '60m', '-json'], {
    cwd: root,
    env: {
      KHA41_TEST_DATABASE_URL: databaseUrl,
      KHA41_REQUIRE_POSTGRES: '1',
      KHA66_WORKER_ENTRY: workerBundle,
    },
  });
  const { tests, packages } = parseGoTestJson(testRun.stdout);
  const map = JSON.parse(await readFile(join(root, 'scripts', 'online', 'acceptance-map.json'), 'utf8'));

  // The route manifest is the route contract of the tooling. A route the
  // production code does not register is reported as not_implemented, and a
  // scenario that depends on such a route is never counted as passed.
  const routes = await auditRouteManifest(root);
  const dependencies = await routeDependencies(root, map, routes.routes);
  const coverage = applyRouteCoverage(mapScenarios(map, tests), dependencies, routes.routes);
  const missingRoutes = routes.routes.filter((route) => route.status === 'not_implemented');

  let browser = null;
  if (options.browser) {
    browser = await runBrowserClients(root, databaseUrl);
    // The browser run happened in the tree of this commit, so the browser
    // evidence names the same commit as the database run.
    browser = { ...browser, commit, command: BROWSER_COMMAND };
  }

  const report = {
    tool: 'scripts/online/integration-suite.mjs',
    generatedAt: new Date().toISOString(),
    commit,
    command: INTEGRATION_COMMAND,
    versions: { go: goVersion, node: nodeVersion, rulesWorkerBundle: workerBundle },
    database: redactDatabaseUrl(databaseUrl),
    goTestExitCode: testRun.code,
    packages: [...packages.entries()].map(([name, action]) => ({ package: name, action })),
    tests: [...tests.entries()].map(([name, action]) => ({ test: name, action })),
    routes: {
      manifestVersion: routes.manifest?.manifestVersion ?? null,
      provisional: routes.manifest?.provisional ?? null,
      routes: routes.routes.map((route) => ({ id: route.id, method: route.method, path: route.path, family: route.family, status: route.status })),
      notImplemented: missingRoutes.map((route) => `${route.method} ${route.path}`),
      problems: routes.problems,
    },
    coverage,
    browser,
    limits: [
      'This run proves local behaviour against a real database and the pinned rules worker.',
      'It proves nothing about native assistive technology, a live host or a released cohort.',
      'A scenario without a mapped test is reported as not_run and stays not_run in the ledger.',
      'The route manifest is compared with the repository. A route the production code does not register is reported as not_implemented and never as a passed scenario.',
    ],
  };

  if (options.record) {
    // The records are built from the same run sources the ledger reads, so a
    // run never writes a claim that the ledger refuses.
    await writeRecords(root, report);
  }
  return report;
}

/**
 * Runs the browser clients against the local fixture.
 * @param {string} root
 * @param {string} databaseUrl
 * @returns {Promise<object|null>}
 */
async function runBrowserClients(root, databaseUrl) {
  const descriptorPath = join(root, '.scratch', 'onlinefixture', 'descriptor.json');
  // The browser build points at a fixed loopback origin, so the fixture uses
  // the same fixed port. The application and the suite then talk to one
  // service instead of two.
  const apiPort = process.env.ONLINE_FIXTURE_API_PORT ?? '18099';
  const fixture = spawn('node', [join(root, 'scripts', 'online', 'fixture-server.mjs'), '--descriptor', descriptorPath, '--api-port', apiPort], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, ONLINE_FIXTURE_DATABASE_URL: databaseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let fixtureOutput = '';
  fixture.stdout.on('data', (chunk) => { fixtureOutput += chunk.toString(); });
  fixture.stderr.on('data', (chunk) => { fixtureOutput += chunk.toString(); });

  const ready = await new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(null), 120_000);
    const check = setInterval(() => {
      if (fixtureOutput.includes('fixture ready at')) {
        clearInterval(check);
        clearTimeout(timer);
        resolvePromise(true);
      }
    }, 250);
    fixture.on('exit', () => {
      clearInterval(check);
      clearTimeout(timer);
      resolvePromise(null);
    });
  });
  if (!ready) {
    fixture.kill('SIGTERM');
    return { status: 'unavailable', detail: 'the local fixture did not become ready' };
  }

  const playwright = await runCommand(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'playwright', 'test', 'tests/e2e/online-clients.spec.ts', '--reporter=line'], {
    cwd: root,
    // The browser run is strict: a missing route or a missing field fails
    // instead of being reported as a skip.
    env: { ONLINE_FIXTURE_DESCRIPTOR: descriptorPath, ONLINE_FIXTURE_STRICT: '1' },
  });
  fixture.kill('SIGTERM');
  return {
    status: playwright.code === 0 ? 'passed' : 'failed',
    exitCode: playwright.code,
    output: playwright.stdout.trim().split('\n').slice(-30).join('\n'),
  };
}

/**
 * Writes one evidence record per covered scenario.
 *
 * The records are built from the same run sources the ledger reads, so a run
 * never writes a claim that the ledger refuses. There is one record per
 * scenario: the database run observes a scenario first and the browser run
 * confirms it or fails it, so a stale pass cannot survive a later failure.
 * @param {string} root
 * @param {any} report
 */
async function writeRecords(root, report) {
  const contract = JSON.parse(await readFile(join(root, 'docs', 'spec', 'online-play-acceptance.json'), 'utf8'));
  const browserMap = JSON.parse(await readFile(join(root, 'scripts', 'online', 'browser-map.json'), 'utf8'));
  const directory = join(root, 'docs', 'evidence', 'online', 'records');
  await mkdir(directory, { recursive: true });
  for (const record of buildEvidenceRecords({ report, contract, browserMap })) {
    await writeFile(join(directory, `${record.scenarioId}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const rootIndex = arguments_.indexOf('--root');
  const root = rootIndex >= 0 ? arguments_[rootIndex + 1] : process.cwd();
  const report = await runIntegrationSuite({
    root,
    record: !arguments_.includes('--no-record'),
    browser: arguments_.includes('--browser'),
  });

  const target = join(root, 'docs', 'evidence', 'online', 'KHA-80-integration.json');
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  if (arguments_.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`integration suite: commit ${report.commit}\n`);
    for (const entry of report.coverage) {
      process.stdout.write(`  ${entry.status.toUpperCase().padEnd(8)} ${entry.scenarioId}: ${entry.detail}\n`);
    }
    const missing = report.routes?.notImplemented ?? [];
    if (missing.length > 0) {
      process.stdout.write(`\nnot implemented routes: ${missing.join(', ')}\n`);
    }
    process.stdout.write(`report written to ${target}\n`);
  }
  if (report.goTestExitCode !== 0) process.exitCode = 1;
  // A route the production code does not register is a broken route contract,
  // so the run is never green while one is missing.
  if ((report.routes?.notImplemented ?? []).length > 0) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/online/integration-suite.mjs')) {
  await main();
}
