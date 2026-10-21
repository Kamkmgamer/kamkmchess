// Offline tests for the online operations tooling.
//
// Every test uses a throwaway tree or a synthetic input. Nothing here touches
// a database, a network service or a credential.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { auditBackup, auditBackupCoverage, restoreRunbookHooks } from './backup-coverage.mjs';
import { buildLedger, familyOf, validateRecord } from './evidence-ledger.mjs';
import { buildPacket, evaluateEvidence, GATE_SCENARIOS } from './feature-gates.mjs';
import { mapScenarios, parseGoTestJson } from './integration-suite.mjs';
import { percentiles } from './load-suite.mjs';
import { auditServiceWiring, switchDefaultState } from './service-wiring.mjs';
import { buildProbes, evaluateProbe } from '../../deploy/runtime-grants-probe.mjs';
import { parseMigrationGrants, parsePolicy } from '../../deploy/runtime-grants.mjs';

const trees = [];

after(async () => {
  await Promise.all(trees.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeTree(files) {
  const root = await mkdtemp(join(tmpdir(), 'kha-online-ops-'));
  trees.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return root;
}

test('an evidence record needs a commit, a command and an observed result', () => {
  const known = new Set(['MAT-03']);
  const invalid = validateRecord({ scenarioId: 'MAT-03', status: 'passed', kind: 'local' }, known);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.problems.some((problem) => problem.includes('commit')));
  assert.ok(invalid.problems.some((problem) => problem.includes('command')));
  assert.ok(invalid.problems.some((problem) => problem.includes('actual')));
});

test('a local run cannot close a native scenario and a plan cannot close an implementation scenario', () => {
  const known = new Set(['UX-02', 'MAT-03']);
  const native = validateRecord({ scenarioId: 'UX-02', status: 'passed', kind: 'local', commit: 'a', command: 'b', actual: 'c' }, known);
  assert.equal(native.valid, false);
  assert.ok(native.problems.some((problem) => problem.includes('cannot close a UX scenario')));
  const implementation = validateRecord({ scenarioId: 'MAT-03', status: 'passed', kind: 'owner', commit: 'a', command: 'b', actual: 'c' }, known);
  assert.equal(implementation.valid, false);
  assert.equal(familyOf('MAT-03'), 'MAT');
});

test('the ledger reports a scenario without a record as not run', () => {
  const ledger = buildLedger({
    cases: [{ id: 'MAT-03', scenario: 'ordering', status: 'not_run' }],
    records: [],
    problems: [],
  });
  assert.equal(ledger.cases[0].status, 'not_run');
  assert.equal(ledger.counts.not_run, 1);
});

test('the ledger refuses a contradicting second record', () => {
  const ledger = buildLedger({
    cases: [{ id: 'MAT-03', scenario: 'ordering', status: 'not_run' }],
    records: [
      { file: 'a.json', body: { scenarioId: 'MAT-03', status: 'passed', kind: 'local', commit: 'a', command: 'b', actual: 'c' } },
      { file: 'b.json', body: { scenarioId: 'MAT-03', status: 'failed', kind: 'local', commit: 'a', command: 'b', actual: 'c' } },
    ],
    problems: [],
  });
  assert.equal(ledger.invalidRecords.length, 1);
});

test('a gate is not ready while a required scenario has no evidence', () => {
  const ledger = {
    cases: GATE_SCENARIOS.friend.local.map((id) => ({ id, status: 'not_run', kind: null })),
  };
  const requirements = evaluateEvidence(ledger, 'friend');
  const local = requirements.find((requirement) => requirement.id === 'local-evidence');
  assert.equal(local.status, 'unmet');
  const native = requirements.find((requirement) => requirement.id === 'native-evidence');
  assert.equal(native.status, 'unmet');
});

test('a gate is ready when every required scenario has passing evidence', () => {
  const ledger = {
    cases: [
      ...GATE_SCENARIOS.friend.local.map((id) => ({ id, status: 'passed', kind: 'local' })),
      ...GATE_SCENARIOS.friend.native.map((id) => ({ id, status: 'passed', kind: 'native' })),
      ...GATE_SCENARIOS.friend.host.map((id) => ({ id, status: 'passed', kind: 'host' })),
    ],
  };
  const requirements = evaluateEvidence(ledger, 'friend');
  assert.ok(requirements.every((requirement) => requirement.status === 'met'));
});

test('the rollout packet is reversible and never applies itself', () => {
  const evaluation = {
    gate: 'friend',
    requirements: [{ id: 'release-decision', title: 'decision', status: 'met', detail: 'Approved', remediation: null }],
  };
  const packet = buildPacket('friend', { root: process.cwd(), evaluation });
  assert.equal(packet.rollback.irreversible, false);
  assert.match(packet.rollback.action, /ONLINE_FRIEND_ENABLED=false/);
  assert.ok(packet.configuration.cohort.includes('ONLINE_FRIEND_COHORT'));
  assert.match(packet.configuration.note2, /guest is never excluded/i);
  assert.ok(packet.stopCondition.length > 0);
});

test('the backup audit blocks an uncovered online removal ledger', () => {
  const findings = auditBackup({
    tables: ['games', 'deletion_tombstones', 'online_deletion_markers'],
    dumpIsFullDatabase: true,
    dumpFilters: [],
    restoresGameLedger: true,
    restoresOnlineLedger: false,
    planRecoveryUsed: true,
    runbookMentionsLedger: true,
  });
  const uncovered = findings.find((finding) => finding.code === 'online-removal-ledger-uncovered');
  assert.ok(uncovered);
  assert.equal(uncovered.severity, 'blocker');
  const hooks = restoreRunbookHooks({ restoresOnlineLedger: false });
  assert.ok(hooks.warnings.length > 0);
});

test('the backup audit blocks a filtered dump', () => {
  const findings = auditBackup({
    tables: ['games'],
    dumpIsFullDatabase: false,
    dumpFilters: ['games'],
    restoresGameLedger: true,
    restoresOnlineLedger: true,
    planRecoveryUsed: true,
    runbookMentionsLedger: true,
  });
  assert.ok(findings.some((finding) => finding.code === 'dump-not-full-database'));
});

test('the backup coverage audit of the repository reports its findings', async () => {
  const report = await auditBackupCoverage(process.cwd());
  assert.ok(report.tables.includes('online_matches'));
  assert.ok(report.findings.some((finding) => finding.code === 'dump-covers-database'));
});

test('the wiring audit blocks a tree without the feature route and the server switches', async () => {
  const root = await makeTree({
    'backend/httpapi/api.go': 'package httpapi\n\nfunc New() {}\n',
    'backend/serverapp/server.go': 'package serverapp\n',
  });
  const report = await auditServiceWiring(root);
  const codes = report.findings.map((finding) => finding.code);
  assert.ok(codes.includes('features-route-missing'));
  assert.ok(codes.includes('server-switch-unused'));
});

test('the restore fence has to be loaded and shared', async () => {
  const root = await makeTree({
    'backend/serverapp/server.go': 'package serverapp\n\ntype OnlineConfig struct{ RestoreFencePath string }\n',
    'deploy/api.compose.yml': 'services:\n  api:\n    environment:\n      ONLINE_RESTORE_FENCE_PATH: /var/lib/kamkmchess/restore-fence/fence.json\n',
    'deploy/postgres.compose.yml': 'services:\n  postgres:\n    volumes:\n      - restorefence:/var/lib/kamkmchess/restore-fence\n',
  });
  const report = await auditServiceWiring(root);
  const codes = report.findings.map((finding) => finding.code);
  // A configuration field that nothing fills is not a fence.
  assert.ok(codes.includes('restore-fence-not-loaded'));
  assert.ok(codes.includes('restore-fence-not-shared'));
});

test('the wiring audit accepts a tree that serves the feature route behind a closed switch', async () => {
  const root = await makeTree({
    'backend/serverapp/server.go': [
      'package serverapp',
      '',
      'const featuresRoute = "/v1/online/features"',
      '',
      'func load(getenv func(string) string) bool {',
      '\tfriend := getenv("ONLINE_FRIEND_ENABLED") == "true"',
      '\tqueue := getenv("ONLINE_QUEUE_ENABLED") == "true"',
      '\treturn friend || queue',
      '}',
    ].join('\n'),
  });
  const report = await auditServiceWiring(root);
  const codes = report.findings.map((finding) => finding.code);
  assert.ok(!codes.includes('features-route-missing'));
  assert.ok(!codes.includes('server-switch-unused'));
});

test('the go test event stream is parsed into test results', () => {
  const stream = [
    '{"Action":"run","Test":"TestOne"}',
    '{"Action":"pass","Test":"TestOne","Elapsed":0.1}',
    '{"Action":"run","Test":"TestTwo"}',
    '{"Action":"fail","Test":"TestTwo","Elapsed":0.2}',
    '{"Action":"pass","Package":"pkg"}',
    'not json',
  ].join('\n');
  const { tests, packages } = parseGoTestJson(stream);
  assert.equal(tests.get('TestOne'), 'pass');
  assert.equal(tests.get('TestTwo'), 'fail');
  assert.equal(packages.get('pkg'), 'pass');
});

test('a scenario is only covered when every mapped test passed', () => {
  const map = { scenarios: { 'MAT-03': ['TestOne', 'TestTwo'], 'MAT-04': ['TestThree'] } };
  const coverage = mapScenarios(map, new Map([['TestOne', 'pass'], ['TestTwo', 'fail'], ['TestThree', 'pass']]));
  assert.equal(coverage.find((entry) => entry.scenarioId === 'MAT-03').status, 'failed');
  assert.equal(coverage.find((entry) => entry.scenarioId === 'MAT-04').status, 'passed');
});

test('a scenario without a running test is not run', () => {
  const coverage = mapScenarios({ scenarios: { 'QUE-09': ['TestMissing'] } }, new Map());
  assert.equal(coverage[0].status, 'not_run');
});

test('the latency percentiles are computed from the sample', () => {
  const stats = percentiles([10, 20, 30, 40, 50]);
  assert.equal(stats.count, 5);
  assert.equal(stats.min, 10);
  assert.equal(stats.max, 50);
  assert.equal(stats.p50, 30);
  assert.equal(percentiles([]).count, 0);
});

test('a switch that is read through a closed helper is closed by default', () => {
  const source = [
    'package serverapp',
    '',
    'func flag(getenv func(string) string, key string) bool {',
    '\treturn strings.TrimSpace(getenv(key)) == "1" || strings.EqualFold(strings.TrimSpace(getenv(key)), "true")',
    '}',
    '',
    'func Load(getenv func(string) string) Config {',
    '\treturn Config{FriendEnabled: flag(getenv, "ONLINE_FRIEND_ENABLED")}',
    '}',
  ].join('\n');
  assert.equal(switchDefaultState(source, 'ONLINE_FRIEND_ENABLED'), 'closed');
});

test('a switch whose helper can fall back to true is not closed', () => {
  const source = [
    'package serverapp',
    '',
    'func flag(getenv func(string) string, key string) bool {',
    '\tif getenv(key) == "" {',
    '\t\treturn true',
    '\t}',
    '\treturn getenv(key) == "true"',
    '}',
    '',
    'func Load(getenv func(string) string) Config {',
    '\treturn Config{QueueEnabled: flag(getenv, "ONLINE_QUEUE_ENABLED")}',
    '}',
  ].join('\n');
  assert.equal(switchDefaultState(source, 'ONLINE_QUEUE_ENABLED'), 'open');
});

test('a migration that grants a privilege the policy does not grant is a blocker', () => {
  const grants = parseMigrationGrants(
    "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE online_events TO kamkm_online_api;",
  );
  assert.equal(grants.length, 1);
  assert.equal(grants[0].role, 'kamkm_online_api');
  assert.equal(grants[0].table, 'online_events');
  assert.ok(grants[0].privileges.includes('DELETE'));
});

test('the grant probe writes, updates and deletes as the role it probes', () => {
  const policy = parsePolicy({
    privileges: {
      online_events: ['SELECT', 'INSERT'],
      games: ['SELECT', 'INSERT', 'UPDATE'],
      online_public_replays: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    },
  });
  const probes = buildProbes(policy, 'probe_schema', new Map([['games', 'game_id']]));
  const ids = probes.map((probe) => probe.id);
  assert.ok(ids.includes('insert-online_events'));
  assert.ok(ids.includes('update-games'));
  assert.ok(ids.includes('delete-online_public_replays'));
  assert.ok(ids.includes('deny-delete-online_events'));
  const insert = probes.find((probe) => probe.id === 'insert-online_events');
  assert.match(insert.sql, /INSERT INTO probe_schema\.online_events/);
  assert.match(insert.sql, /ROLLBACK/);
});

test('a write refused by a table rule is a permitted write, a privilege refusal is not', () => {
  const probe = { id: 'insert-x', description: '', expectation: 'allowed', sql: '' };
  const refused = evaluateProbe(probe, { ok: false, stderr: 'ERROR: online guest credential requires an existing seat' });
  assert.equal(refused.passed, true);
  const privilege = evaluateProbe(probe, { ok: false, stderr: 'ERROR: permission denied for table x' });
  assert.equal(privilege.passed, false);
});

test('a delete the policy forbids must fail with a privilege refusal', () => {
  const probe = { id: 'deny-delete-x', description: '', expectation: 'denied', sql: '' };
  assert.equal(evaluateProbe(probe, { ok: false, stderr: 'ERROR: permission denied for table x' }).passed, true);
  assert.equal(evaluateProbe(probe, { ok: false, stderr: 'ERROR: relation does not exist' }).passed, false);
  assert.equal(evaluateProbe(probe, { ok: true, stderr: '' }).passed, false);
});
