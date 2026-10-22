// Tests of the provenance of the evidence records.
//
// The ledger may only count a record as a passed acceptance scenario when a
// run source recorded the behaviour of the scenario. Every test here uses a
// synthetic run source; nothing here touches a database, a network service
// or a credential.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { browserChannel, buildEvidenceRecords, integrationChannel, readRunSources } from './evidence-provenance.mjs';
import { buildEvidenceLedger, buildLedger, validateRecord } from './evidence-ledger.mjs';
import { evaluateEvidence } from './feature-gates.mjs';

const DATABASE_RUN = '1111111111111111111111111111111111111111';
const BROWSER_RUN = '2222222222222222222222222222222222222222';
const NEWER_COMMIT = '3333333333333333333333333333333333333333';

const DATABASE_COMMAND = 'go test ./backend/integration -count=1 -timeout 60m -json';
const BROWSER_COMMAND = 'pnpm exec playwright test tests/e2e/online-clients.spec.ts';

/** A synthetic run source: one database run and one browser run. */
const REPORT = {
  tool: 'scripts/online/integration-suite.mjs',
  commit: DATABASE_RUN,
  command: DATABASE_COMMAND,
  goTestExitCode: 0,
  coverage: [
    { scenarioId: 'MAT-03', status: 'passed', detail: 'the mapped test passed' },
    { scenarioId: 'QUE-01', status: 'failed', detail: 'the mapped test failed' },
  ],
  browser: {
    status: 'passed',
    commit: BROWSER_RUN,
    command: BROWSER_COMMAND,
    tests: [{ title: 'a guest accepts a friend invitation', status: 'expected', outcomes: ['passed'] }],
  },
};

/** The synthetic browser map. It carries no statement of a complete coverage. */
const BROWSER_MAP = {
  scenarios: { 'FRI-01': ['a guest accepts a friend invitation'] },
};

const trees = [];

after(async () => {
  await Promise.all(trees.map((directory) => rm(directory, { recursive: true, force: true })));
});

/**
 * Builds the run sources of a synthetic run.
 * @param {any} [report]
 * @param {any} [map]
 * @returns {any}
 */
function sourcesOf(report = REPORT, map = BROWSER_MAP) {
  return {
    channels: [integrationChannel(report), browserChannel(report, map)].filter(Boolean),
    problems: [],
  };
}

/**
 * Builds a record.
 * @param {any} overrides
 * @returns {any}
 */
function recordOf(overrides) {
  return {
    scenarioId: 'MAT-03',
    status: 'passed',
    kind: 'local',
    commit: DATABASE_RUN,
    command: DATABASE_COMMAND,
    expected: 'the approved scenario',
    actual: 'the run observed the scenario',
    ...overrides,
  };
}

/**
 * Builds a ledger of one scenario.
 * @param {any} record
 * @param {any} [sources]
 * @param {string[]} [cases]
 * @returns {any}
 */
function ledgerOf(record, sources = sourcesOf(), cases = ['MAT-03']) {
  return buildLedger({
    cases: cases.map((id) => ({ id, scenario: `the scenario ${id}`, status: 'not_run' })),
    records: [{ file: `${record.scenarioId}.json`, body: record }],
    problems: [],
    sources,
  });
}

test('a record that no run backs never closes a scenario', () => {
  const known = new Set(['FRI-02']);
  const forged = recordOf({ scenarioId: 'FRI-02', status: 'passed' });
  const validation = validateRecord(forged, known, sourcesOf());
  assert.equal(validation.valid, false);
  assert.ok(validation.problems.some((problem) => problem.includes('no run source recorded FRI-02')));
});

test('a forged record that names the newest commit is still refused', () => {
  const known = new Set(['MAT-03']);
  const forged = recordOf({ commit: NEWER_COMMIT });
  const validation = validateRecord(forged, known, sourcesOf());
  assert.equal(validation.valid, false);
  assert.ok(validation.problems.some((problem) => problem.includes('no run source recorded MAT-03 at commit')));
  const ledger = ledgerOf(forged);
  assert.equal(ledger.counts.passed, 0);
  assert.equal(ledger.cases[0].status, 'not_run');
  assert.equal(ledger.invalidRecords.length, 1);
});

test('a record that overstates the run is refused', () => {
  const known = new Set(['QUE-01']);
  const forged = recordOf({ scenarioId: 'QUE-01', status: 'passed' });
  const validation = validateRecord(forged, known, sourcesOf());
  assert.equal(validation.valid, false);
  assert.ok(validation.problems.some((problem) => problem.includes('the record claims passed, but the run source')));
  assert.ok(validation.problems.some((problem) => problem.includes('recorded failed')));
});

test('a record that names another commit than the run is refused', () => {
  const known = new Set(['MAT-03']);
  const forged = recordOf({ commit: BROWSER_RUN });
  const validation = validateRecord(forged, known, sourcesOf());
  assert.equal(validation.valid, false);
  assert.ok(validation.problems.some((problem) => problem.includes('no run source recorded MAT-03 at commit')));
});

test('a record that names another command than the run is refused', () => {
  const known = new Set(['MAT-03']);
  const forged = recordOf({ command: 'echo the scenario was passed' });
  const validation = validateRecord(forged, known, sourcesOf());
  assert.equal(validation.valid, false);
  assert.ok(validation.problems.some((problem) => problem.includes('names another command')));
});

test('the record of a run that observed the scenario is accepted', () => {
  const known = new Set(['MAT-03']);
  const generated = recordOf();
  const validation = validateRecord(generated, known, sourcesOf());
  assert.deepEqual(validation.problems, []);
  assert.equal(validation.valid, true);
  const ledger = ledgerOf(generated);
  assert.equal(ledger.counts.passed, 1);
  assert.equal(ledger.cases[0].status, 'passed');
  assert.equal(ledger.cases[0].source, 'docs/evidence/online/KHA-80-integration.json');
  assert.equal(ledger.cases[0].outcome, 'passed');
});

test('a record of a kind without a run source fails closed', () => {
  const known = new Set(['UX-02', 'ARC-05', 'REL-01']);
  for (const [scenarioId, kind] of [['UX-02', 'native'], ['ARC-05', 'host'], ['REL-01', 'owner']]) {
    const forged = recordOf({ scenarioId, kind, status: 'passed', commit: DATABASE_RUN });
    const validation = validateRecord(forged, known, sourcesOf());
    assert.equal(validation.valid, false);
    assert.ok(validation.problems.some((problem) => problem.includes(`no verifiable run source is registered for a ${kind} run`)));
  }
});

test('a native record never opens the native requirement of a gate', () => {
  const forged = recordOf({ scenarioId: 'UX-02', kind: 'native', status: 'passed' });
  const ledger = ledgerOf(forged, sourcesOf(), ['UX-02', 'UX-03', 'UX-04', 'UX-05', 'UX-06']);
  assert.equal(ledger.counts.passed, 0);
  const requirements = evaluateEvidence(ledger, 'friend');
  const native = requirements.find((requirement) => requirement.id === 'native-evidence');
  assert.equal(native.status, 'unmet');
  assert.ok(native.detail.includes('UX-02'));
});

test('the browser evidence closes a scenario only when the map states a complete coverage', () => {
  const known = new Set(['FRI-01']);
  const forged = recordOf({ scenarioId: 'FRI-01', status: 'passed', commit: BROWSER_RUN, command: BROWSER_COMMAND });
  const validation = validateRecord(forged, known, sourcesOf());
  assert.equal(validation.valid, false);
  assert.ok(validation.problems.some((problem) => problem.includes('recorded partial')));

  const partial = recordOf({ scenarioId: 'FRI-01', status: 'partial', commit: BROWSER_RUN, command: BROWSER_COMMAND });
  assert.equal(validateRecord(partial, known, sourcesOf()).valid, true);

  const complete = sourcesOf(REPORT, { scenarios: BROWSER_MAP.scenarios, coverage: { 'FRI-01': 'complete' } });
  const closed = recordOf({ scenarioId: 'FRI-01', status: 'passed', commit: BROWSER_RUN, command: BROWSER_COMMAND });
  assert.equal(validateRecord(closed, known, complete).valid, true);
});

test('a partial record never becomes a pass', () => {
  const known = new Set(['MAT-03']);
  const partial = recordOf({ status: 'partial' });
  const validation = validateRecord(partial, known, sourcesOf());
  assert.equal(validation.valid, true);
  const ledger = ledgerOf(partial);
  assert.equal(ledger.counts.passed, 0);
  assert.equal(ledger.cases[0].status, 'partial');
});

test('the run sources of a tree are read from the recorded run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kha-evidence-provenance-'));
  trees.push(root);
  await mkdir(join(root, 'docs', 'evidence', 'online'), { recursive: true });
  await mkdir(join(root, 'scripts', 'online'), { recursive: true });
  await writeFile(join(root, 'docs', 'evidence', 'online', 'KHA-80-integration.json'), JSON.stringify(REPORT), 'utf8');
  await writeFile(join(root, 'scripts', 'online', 'browser-map.json'), JSON.stringify(BROWSER_MAP), 'utf8');

  const sources = await readRunSources(root);
  assert.deepEqual(sources.problems, []);
  assert.equal(sources.channels.length, 2);
  const database = sources.channels.find((channel) => channel.id === 'local-integration');
  const browser = sources.channels.find((channel) => channel.id === 'local-browser');
  assert.equal(database.commit, DATABASE_RUN);
  assert.equal(database.command, DATABASE_COMMAND);
  assert.equal(database.outcomes.get('MAT-03').outcome, 'passed');
  assert.equal(browser.commit, BROWSER_RUN);
  assert.equal(browser.outcomes.get('FRI-01').outcome, 'partial');
});

test('the records of a run are accepted by the ledger', () => {
  const contract = {
    cases: [
      { id: 'MAT-03', scenario: 'the approved scenario' },
      { id: 'QUE-01', scenario: 'the failed scenario' },
      { id: 'FRI-01', scenario: 'the browser scenario' },
    ],
  };
  const records = buildEvidenceRecords({ report: REPORT, contract, browserMap: BROWSER_MAP });
  const known = new Set(contract.cases.map((entry) => entry.id));
  const sources = sourcesOf();
  for (const record of records) {
    const validation = validateRecord(record, known, sources);
    assert.deepEqual(validation.problems, [], `${record.scenarioId}: ${validation.problems.join('; ')}`);
  }
  const database = records.find((entry) => entry.scenarioId === 'MAT-03');
  const browser = records.find((entry) => entry.scenarioId === 'FRI-01');
  assert.equal(database.status, 'passed');
  assert.equal(database.commit, DATABASE_RUN);
  assert.equal(database.command, DATABASE_COMMAND);
  assert.equal(browser.status, 'partial');
  assert.equal(browser.commit, BROWSER_RUN);
  assert.equal(browser.command, BROWSER_COMMAND);
});

test('a failed browser run lowers the scenario it observes', () => {
  const contract = { cases: [{ id: 'MAT-03', scenario: 'the approved scenario' }] };
  const browserMap = { scenarios: { 'MAT-03': ['a guest accepts a friend invitation'] } };
  const report = { ...REPORT, browser: { ...REPORT.browser, status: 'failed' } };
  const records = buildEvidenceRecords({ report, contract, browserMap });
  const database = records.find((entry) => entry.scenarioId === 'MAT-03');
  assert.equal(database.status, 'failed');
  assert.match(database.actual, /browser run did not pass/);
});

test('every recorded scenario of the tree is backed by the run source', async () => {
  const ledger = await buildEvidenceLedger(process.cwd());
  assert.deepEqual(ledger.invalidRecords, []);
  for (const entry of ledger.cases) {
    if (entry.status === 'not_run') continue;
    assert.ok(entry.source, `${entry.id} has no run source`);
    assert.ok(entry.outcome, `${entry.id} has no recorded outcome`);
  }
});

test('a forged record in the tree never closes its scenario', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kha-evidence-forged-'));
  trees.push(root);
  await mkdir(join(root, 'docs', 'spec'), { recursive: true });
  await mkdir(join(root, 'docs', 'evidence', 'online', 'records'), { recursive: true });
  await mkdir(join(root, 'scripts', 'online'), { recursive: true });
  await writeFile(join(root, 'docs', 'spec', 'online-play-acceptance.json'), JSON.stringify({
    title: 'the approved contract',
    cases: [
      { id: 'QUE-01', scenario: 'the observed scenario', status: 'not_run' },
      { id: 'QUE-02', scenario: 'the approved scenario', status: 'not_run' },
    ],
  }), 'utf8');
  await writeFile(join(root, 'docs', 'evidence', 'online', 'KHA-80-integration.json'), JSON.stringify(REPORT), 'utf8');
  await writeFile(join(root, 'scripts', 'online', 'browser-map.json'), JSON.stringify(BROWSER_MAP), 'utf8');
  await writeFile(join(root, 'docs', 'evidence', 'online', 'records', 'QUE-02.json'), JSON.stringify({
    scenarioId: 'QUE-02',
    status: 'passed',
    kind: 'local',
    commit: DATABASE_RUN,
    command: DATABASE_COMMAND,
    expected: 'the approved scenario',
    actual: 'the scenario passed',
  }), 'utf8');

  const ledger = await buildEvidenceLedger(root);
  assert.equal(ledger.counts.passed, 0);
  assert.equal(ledger.cases.find((entry) => entry.id === 'QUE-02').status, 'not_run');
  assert.equal(ledger.invalidRecords.length, 1);
  assert.ok(ledger.invalidRecords[0].problems.some((problem) => problem.includes('no run source recorded QUE-02')));
});
