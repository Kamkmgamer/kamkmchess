// Offline tests for the online operations tooling.
//
// Every test uses a throwaway tree or a synthetic input. Nothing here touches
// a database, a network service or a credential.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { auditBackup, auditBackupCoverage, restoreRunbookHooks } from './backup-coverage.mjs';
import { buildLedger, familyOf, validateRecord } from './evidence-ledger.mjs';
import { buildPacket, evaluateEvidence, GATE_SCENARIOS } from './feature-gates.mjs';
import { mapScenarios, parseGoTestJson } from './integration-suite.mjs';
import { percentiles } from './load-suite.mjs';
import { auditServiceWiring, switchDefaultState } from './service-wiring.mjs';
import { composeFencePaths, completeReport as fenceCompleteReport, documentedFencePath, fencePathAgreement, fenceVolumeAgreement, fenceVolumeControl, holderDatabaseUrl, ownedSchemaName, planCleanup as planFenceCleanup, proofExitCode as fenceExitCode, readmeFencePath, REQUIRED_STEPS as FENCE_REQUIRED_STEPS, resolveTarget, RUN_SCHEMA, targetFromEnvironment, verifyFenceAccess } from '../../deploy/verify-fence-access.mjs';
import { completeReport, createAndMigrate, insideDatabaseUrl, planCleanup as planRestoreCleanup, redactReport, reportFailure, REQUIRED_STEPS, RUN_SCHEMA as RESTORE_RUN_SCHEMA } from './restore-proof.mjs';
import { barrierScript, injectionScript, proofCases, REQUIRED_STEPS as INTERRUPTION_REQUIRED_STEPS, RESTORE_ID_PATTERN, restoreIdIsUsable } from './restore-interruption-proof.mjs';
import { buildProbes, evaluateProbe } from '../../deploy/runtime-grants-probe.mjs';
import { auditGrants, parseMigrationFunctions, parseMigrationGrants, parseMigrationReads, parseMigrationTables, parseMigrationWrites, parsePolicy, scanGoUsage } from '../../deploy/runtime-grants.mjs';

/**
 * Runs the grant audit against a throwaway tree.
 * @param {string} root
 */
async function auditGrantsFor(root) {
  const policy = parsePolicy({ privileges: {}, functions: {} });
  const tables = await parseMigrationTablesOf(root);
  return { findings: auditGrants({ policy, tables, usage: new Map(), functions: await functionsOf(root) }) };
}

/**
 * @param {string} root
 * @returns {string[]}
 */
async function parseMigrationTablesOf(root) {
  const directory = join(root, 'backend', 'migrations');
  const tables = [];
  for (const name of ['0001.sql']) {
    const text = await readFile(join(directory, name), 'utf8');
    tables.push(...parseMigrationTables(text));
  }
  return tables;
}

/**
 * @param {string} root
 */
async function functionsOf(root) {
  const text = await readFile(join(root, 'backend', 'migrations', '0001.sql'), 'utf8');
  return parseMigrationFunctions(text);
}

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

test('a plain function that nobody reviewed is a blocker, a trigger function is not', async () => {
  const root = await makeTree({
    'backend/migrations/0001.sql': [
      'CREATE TABLE IF NOT EXISTS games (id text primary key);',
      'CREATE OR REPLACE FUNCTION online_guard_games_update() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$;',
      'CREATE OR REPLACE FUNCTION online_removed_account_request(p_owner_id text) RETURNS boolean AS $$ BEGIN RETURN true; END $$;',
    ].join('\n'),
    'backend/service.go': 'package service\n',
  });
  const report = await auditGrantsFor(root);
  const codes = report.findings.map((finding) => finding.code);
  // The trigger function cannot be called directly, so it is only a note.
  assert.ok(codes.includes('trigger-functions-need-no-grant'));
  // The plain function can be called directly and is not covered.
  assert.ok(codes.includes('function-public-execute'));
});

test('an update with a table alias is still a table update', () => {
  const usage = scanGoUsage('UPDATE online_queue_allocations a SET status = $1 WHERE id = $2');
  assert.ok(usage.has('online_queue_allocations'));
  assert.ok(usage.get('online_queue_allocations').has('UPDATE'));
});

test('a migration grant is compared table by table, never as a union', () => {
  // The policy allows only a read on both tables. The migration grants a
  // write on the second one. A union would report the write on the first
  // table as well, which would be a privilege that no migration grants.
  const policy = parsePolicy({ role: 'kamkmchess_runtime', privileges: { alpha: ['SELECT'], beta: ['SELECT'] } });
  const findings = auditGrants({
    policy,
    tables: ['alpha', 'beta'],
    usage: new Map(),
    migrationGrants: [
      { role: 'kamkmchess_runtime', table: 'alpha', privileges: ['SELECT'] },
      { role: 'kamkmchess_runtime', table: 'beta', privileges: ['SELECT', 'UPDATE'] },
    ],
  });
  const blockers = findings.filter((finding) => finding.code === 'migration-grant-exceeds-policy');
  assert.equal(blockers.length, 1);
  assert.match(blockers[0].message, /UPDATE on beta/);
  assert.ok(!blockers[0].message.includes('alpha'));
});

test('the grants of a role the deployment does not use are reported once', () => {
  const policy = parsePolicy({
    role: 'kamkmchess_runtime',
    unusedRoles: ['kamkm_online_api'],
    privileges: { alpha: ['SELECT'] },
  });
  const findings = auditGrants({
    policy,
    tables: ['alpha', 'beta'],
    usage: new Map(),
    migrationGrants: [
      { role: 'kamkm_online_api', table: 'alpha', privileges: ['SELECT', 'UPDATE'] },
      { role: 'kamkm_online_api', table: 'beta', privileges: ['SELECT', 'UPDATE'] },
    ],
  });
  const reported = findings.filter((finding) => finding.code === 'migration-grant-stripped-role');
  assert.equal(reported.length, 1);
  assert.match(reported[0].message, /2 table\(s\)/);
});

test('a role the deployment does not use and does not strip is a blocker', () => {
  const policy = parsePolicy({ role: 'kamkmchess_runtime', privileges: { alpha: ['SELECT'] } });
  const findings = auditGrants({
    policy,
    tables: ['alpha'],
    usage: new Map(),
    migrationGrants: [{ role: 'kamkm_online_api', table: 'alpha', privileges: ['SELECT', 'UPDATE'] }],
  });
  const blockers = findings.filter((finding) => finding.code === 'migration-grants-unreviewed-role');
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].severity, 'blocker');
});

test('a statement outside a function does not justify a runtime grant', () => {
  // A one-time seed runs as the owner of the migration, so it says nothing
  // about the runtime role.
  const seed = 'INSERT INTO online_seed_rows(id) VALUES (1);';
  assert.deepEqual(parseMigrationWrites(seed), []);
  assert.deepEqual(parseMigrationReads(seed), []);
});

test('an insert only trigger justifies the insert and nothing else', () => {
  const migration = [
    'CREATE OR REPLACE FUNCTION online_record_initial_control() RETURNS trigger',
    'LANGUAGE plpgsql AS $$',
    'BEGIN',
    '  INSERT INTO online_seat_control_timeline(match_id, seat) VALUES (NEW.match_id, NEW.seat);',
    '  RETURN NEW;',
    'END',
    '$$;',
  ].join('\n');
  const writes = parseMigrationWrites(migration);
  assert.deepEqual(writes, ['online_seat_control_timeline:INSERT']);
  assert.ok(!writes.some((entry) => entry.endsWith(':UPDATE')));
  assert.ok(!writes.some((entry) => entry.endsWith(':DELETE')));
});

test('a schema qualified write inside a function is recognised', () => {
  const migration = [
    'CREATE OR REPLACE FUNCTION online_guard() RETURNS trigger',
    'LANGUAGE plpgsql AS $$',
    'BEGIN',
    '  UPDATE public.online_queue_entries SET owner_id = $1;',
    '  RETURN NEW;',
    'END',
    '$$;',
  ].join('\n');
  assert.deepEqual(parseMigrationWrites(migration), ['online_queue_entries:UPDATE']);
});

test('a table that a function only reads does not bless a write', () => {
  const policy = parsePolicy({
    role: 'kamkmchess_runtime',
    privileges: { online_public_model_allowlist: ['SELECT', 'UPDATE'] },
  });
  const findings = auditGrants({
    policy,
    tables: ['online_public_model_allowlist'],
    usage: new Map(),
    migrationReads: ['online_public_model_allowlist'],
    migrationWrites: [],
  });
  const unused = findings.filter((finding) => finding.code === 'grant-unused-privilege');
  assert.equal(unused.length, 1);
  assert.match(unused[0].message, /UPDATE/);
  // The read stays justified.
  assert.ok(findings.some((finding) => finding.code === 'grant-used-by-migration-function'));
});

test('the verb of a migration write matches the verb of the policy', () => {
  const policy = parsePolicy({
    role: 'kamkmchess_runtime',
    privileges: { online_seat_control_timeline: ['SELECT', 'INSERT'] },
  });
  const findings = auditGrants({
    policy,
    tables: ['online_seat_control_timeline'],
    usage: new Map([['online_seat_control_timeline', new Set(['SELECT'])]]),
    migrationWrites: ['online_seat_control_timeline:INSERT'],
  });
  assert.ok(!findings.some((finding) => finding.code === 'grant-unused-privilege'));
});

test('a one-time block is not a function body', () => {
  // A DO block runs once, as the owner of the migration.
  const once = [
    'DO $$',
    'BEGIN',
    '  INSERT INTO online_seed_rows(id) VALUES (1);',
    'END',
    '$$;',
  ].join('\n');
  assert.deepEqual(parseMigrationWrites(once), []);
});

test('a declaration inside a comment and a statement inside a string justify nothing', () => {
  const commented = [
    '-- CREATE FUNCTION online_x() RETURNS trigger AS $$ BEGIN INSERT INTO online_seed_rows VALUES (1); END $$;',
  ].join('\n');
  assert.deepEqual(parseMigrationWrites(commented), []);
  const quoted = [
    'CREATE FUNCTION online_x() RETURNS trigger AS $$',
    "  RAISE NOTICE 'INSERT INTO online_seed_rows VALUES (1)';",
    '  RETURN NEW;',
    'END $$;',
  ].join('\n');
  assert.deepEqual(parseMigrationWrites(quoted), []);
});

test('a function with a tagged delimiter is a function body', () => {
  const tagged = [
    'CREATE OR REPLACE FUNCTION online_guard() RETURNS trigger',
    'LANGUAGE plpgsql AS $body$',
    'BEGIN',
    '  INSERT INTO online_seat_control_timeline(match_id) VALUES (NEW.match_id);',
    '  RETURN NEW;',
    'END',
    '$body$;',
  ].join('\n');
  assert.deepEqual(parseMigrationWrites(tagged), ['online_seat_control_timeline:INSERT']);
});

test('a function body is read with its own delimiter', () => {
  const tagged = [
    'CREATE OR REPLACE FUNCTION online_guard() RETURNS trigger',
    'LANGUAGE plpgsql AS $body$',
    'BEGIN',
    '  UPDATE online_queue_entries SET owner_id = $1;',
    '  RETURN NEW;',
    'END',
    '$body$;',
  ].join('\n');
  assert.deepEqual(parseMigrationWrites(tagged), ['online_queue_entries:UPDATE']);
});


test('the access proof refuses a target it cannot serve before it changes anything', () => {
  // A remote target is refused, so the proof never migrates or drops a
  // database that is not the local fixture.
  const remote = resolveTarget({ databaseUrl: 'postgres://user@db.example.internal:5432/production' });
  assert.equal(remote.ok, false);
  assert.match(remote.detail, /not a local database/);

  const unparsable = resolveTarget({ databaseUrl: 'not a url' });
  assert.equal(unparsable.ok, false);

  const notPostgres = resolveTarget({ databaseUrl: 'https://db.example.internal:5432/x' });
  assert.equal(notPostgres.ok, false);

  const noPort = resolveTarget({ databaseUrl: 'postgres://postgres@127.0.0.1/kamkmchess_online_test' });
  assert.equal(noPort.ok, false);
  assert.match(noPort.detail, /no port/);

  const local = resolveTarget({ databaseUrl: 'postgres://postgres@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable' });
  assert.equal(local.ok, true);
  assert.equal(local.database, 'kamkmchess_online_test');
  assert.equal(local.url.port, '55467');
});

test('the keep option preserves the resources of the run and names them', () => {
  const kept = planFenceCleanup({
    keep: true,
    containers: ['container-1'],
    databases: ['database-1'],
    volumes: ['volume-1'],
    directory: '/tmp/run',
    logs: ['holder: serving'],
  });
  assert.equal(kept.keep, true);
  assert.deepEqual(kept.removeContainers, []);
  assert.deepEqual(kept.removeVolumes, []);
  assert.equal(kept.removeDirectory, false);
  assert.deepEqual(kept.manifest.containers, ['container-1']);
  assert.deepEqual(kept.manifest.volumes, ['volume-1']);
  assert.deepEqual(kept.manifest.logs, ['holder: serving']);

  const removed = planFenceCleanup({
    keep: false,
    containers: ['container-1'],
    databases: ['database-1'],
    volumes: ['volume-1'],
    directory: '/tmp/run',
    logs: [],
  });
  assert.deepEqual(removed.removeContainers, ['container-1']);
  assert.deepEqual(removed.removeVolumes, ['volume-1']);
  assert.equal(removed.removeDirectory, true);
});

test('the native proof keeps its resources on request and names them', () => {
  const kept = planRestoreCleanup({
    keep: true,
    containers: ['holder-1'],
    databases: ['source-1', 'target-1'],
    volumes: ['volume-1'],
    directory: '/tmp/run',
    logs: ['holder: serving'],
  });
  assert.equal(kept.keep, true);
  assert.deepEqual(kept.removeDatabases, []);
  assert.deepEqual(kept.manifest.databases, ['source-1', 'target-1']);
  assert.deepEqual(kept.manifest.containers, ['holder-1']);
});

test('a run that stopped early is never green', () => {
  const empty = completeReport([], [], ['the run stopped early']);
  const missing = empty.steps.filter((step) => step.id.endsWith('-ran'));
  assert.equal(missing.length, REQUIRED_STEPS.length);
  assert.ok(missing.every((step) => step.passed === false));

  const complete = completeReport(
    REQUIRED_STEPS.map((id) => ({ id, passed: true, detail: '' })),
    [],
    [],
  );
  assert.equal(complete.steps.filter((step) => step.id.endsWith('-ran')).length, 0);
});


/**
 * A stand-in for the container port of the proof.
 *
 * It records every call, so the tests can observe the order of the
 * orchestration and the outcome of every step, instead of a plan that only
 * mirrors the implementation.
 */
function fakeIo(options = {}) {
  const calls = [];
  const image = options.image ?? 'postgres:17';
  const network = options.network ?? 'bridge';
  const publishedPort = options.publishedPort ?? '55467';
  const volumeCreateFails = options.volumeCreateFails === true;
  const volumeRemoveFails = options.volumeRemoveFails === true;
  const schemaName = options.schemaName ?? 'fence_probe_testrun';
  // The schema of the run exists until the proof drops it.
  const state = { schemaExists: options.schemaExists !== false };
  const io = async (command, args) => {
    calls.push({ command, args: [...args] });
    const text = args.join(' ');
    if (command === 'docker' && text.includes('{{.Config.Image}}')) {
      return { code: 0, stdout: image + '\n', stderr: '' };
    }
    if (command === 'docker' && text.includes('NetworkSettings.Networks')) {
      return { code: 0, stdout: JSON.stringify({ [network]: { IPAddress: '172.20.0.2' } }) + '\n', stderr: '' };
    }
    if (command === 'docker' && args[0] === 'port' && text.includes('5432/tcp')) {
      return { code: 0, stdout: '127.0.0.1:' + publishedPort + '\n', stderr: '' };
    }
    if (command === 'docker' && args[0] === 'port' && text.includes('8099/tcp')) {
      return { code: 0, stdout: '127.0.0.1:32768\n', stderr: '' };
    }
    if (command === 'docker' && args[0] === 'volume' && args[1] === 'create') {
      return volumeCreateFails
        ? { code: 1, stdout: '', stderr: 'the volume could not be created\n' }
        : { code: 0, stdout: 'volume\n', stderr: '' };
    }
    if (command === 'docker' && args[0] === 'volume' && args[1] === 'rm') {
      return volumeRemoveFails
        ? { code: 1, stdout: '', stderr: 'the volume could not be removed\n' }
        : { code: 0, stdout: '', stderr: '' };
    }
    if (command === 'docker' && text.includes('/fixtures/fenceprobe') && args.includes('fence-only')) {
      return { code: 1, stdout: '', stderr: 'open /backups/fence-test/restore-fence.lock: permission denied\n' };
    }
    if (command === 'docker' && text.includes('/fixtures/fenceprobe') && args.includes('serve')) {
      return { code: 0, stdout: 'holder-container\n', stderr: '' };
    }
    if (command === 'docker' && args[0] === 'logs') {
      return { code: 0, stdout: 'serving\n', stderr: '' };
    }
    if (command === 'docker' && text.includes('schema-name')) {
      return { code: 0, stdout: schemaName + '\n', stderr: '' };
    }
    if (command === 'docker' && text.includes('restore-fence/owner')) {
      return { code: 0, stdout: 'open\n', stderr: '' };
    }
    if (command === 'docker' && text.includes('DROP SCHEMA IF EXISTS')) {
      state.schemaExists = false;
      return { code: 0, stdout: 'DROP SCHEMA\n', stderr: '' };
    }
    if (command === 'docker' && text.includes("pg_namespace WHERE nspname")) {
      return { code: 0, stdout: (state.schemaExists ? '1' : '0') + '\n', stderr: '' };
    }
    if (command === 'go') {
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  io.calls = calls;
  io.state = state;
  return io;
}

/**
 * The gate of the service, as the proof sees it: the traffic is refused
 * while the fence is held, the close answers, and the traffic is served
 * again.
 */
function fakeGate() {
  let healthChecks = 0;
  return async (url) => {
    const target = String(url);
    if (target.includes('/finish')) return { status: 200 };
    healthChecks += 1;
    return { status: healthChecks === 1 ? 503 : 200 };
  };
}

/**
 * Runs the access proof with a stand-in for the container port and for the
 * gate, so the orchestration of the proof can be observed without a
 * container.
 */
async function runAccessProof(options) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeGate();
  try {
    return await verifyFenceAccess(options);
  } finally {
    globalThis.fetch = original;
  }
}

test('the access proof validates the port before it creates anything', async () => {
  const io = fakeIo({ publishedPort: '6000' });
  const report = await runAccessProof({ io, databaseUrl: 'postgres://postgres@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable' });
  assert.ok(report.steps.some((step) => step.id === 'the-target-addresses-the-published-port' && !step.passed));
  // Nothing was created before the port was checked.
  assert.equal(io.calls.some((call) => call.args.includes('volume') && call.args.includes('create')), false);
  assert.equal(fenceExitCode(report.steps), 1);
});

test('the access proof refuses a target it cannot serve and touches nothing', async () => {
  const io = fakeIo();
  const report = await runAccessProof({ io, databaseUrl: 'postgres://user@db.example.internal:5432/production' });
  assert.ok(report.steps.some((step) => step.id === 'the-target-of-the-proof-is-accepted' && !step.passed));
  assert.equal(io.calls.length, 0);
  assert.equal(fenceExitCode(report.steps), 1);
});

test('the access proof drops only the schema of its own run, in the selected target', async () => {
  const io = fakeIo({ schemaName: 'fence_probe_abc123' });
  const report = await runAccessProof({ io, databaseUrl: 'postgres://postgres@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable' });
  const drops = io.calls.filter((call) => call.args.some((argument) => String(argument).includes('DROP SCHEMA IF EXISTS fence_probe_')));
  assert.equal(drops.length, 1);
  // The drop names the database of the selected target.
  assert.ok(drops[0].args.includes('kamkmchess_online_test'));
  assert.ok(report.steps.some((step) => step.id === 'the-schema-of-the-run-is-dropped' && step.passed));
  // The schema is gone after the run.
  assert.equal(io.state.schemaExists, false);
});

test('a removal that fails is a failure of the proof', async () => {
  const io = fakeIo({ volumeRemoveFails: true });
  const report = await runAccessProof({ io, databaseUrl: 'postgres://postgres@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable' });
  assert.ok(report.steps.some((step) => step.id === 'the-probe-volume-is-removed' && !step.passed));
  assert.equal(fenceExitCode(report.steps), 1);
});

test('the holder keeps the credentials and the options of the selected target', () => {
  const url = new URL('postgres://probe:secret@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable');
  const holder = holderDatabaseUrl(url);
  assert.match(holder, /probe:secret@host\.docker\.internal:55467/);
  assert.match(holder, /sslmode=disable/);
  assert.match(holder, /kamkmchess_online_test/);
});

test('a refusal with the keep option touches nothing and writes no manifest', async () => {
  const base = join('.scratch', 'fence-access');
  const before = await readdir(base).catch(() => []);
  const io = fakeIo();
  const report = await runAccessProof({
    io,
    keep: true,
    databaseUrl: 'postgres://user@db.example.internal:5432/production',
  });
  const after = await readdir(base).catch(() => []);
  assert.deepEqual(after, before);
  assert.equal(io.calls.length, 0);
  assert.ok(report.steps.some((step) => !step.passed));
});

test('the report never names the secret of the target', async () => {
  const io = fakeIo();
  const report = await runAccessProof({
    io,
    databaseUrl: 'postgres://probe:s3cr3t@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable',
  });
  assert.equal(JSON.stringify(report).includes('s3cr3t'), false);
});
test('the command line takes the target of the proof from the environment', () => {
  const fromEnvironment = targetFromEnvironment({
    ONLINE_FIXTURE_CONTAINER: 'other-container',
    ONLINE_FIXTURE_DATABASE_URL: 'postgres://postgres@127.0.0.1:1234/other?sslmode=disable',
  }, {});
  assert.equal(fromEnvironment.container, 'other-container');
  assert.match(String(fromEnvironment.databaseUrl), /127\.0\.0\.1:1234\/other/);

  // An explicit option wins over the environment.
  const explicit = targetFromEnvironment({ ONLINE_FIXTURE_CONTAINER: 'other-container' }, { container: 'chosen' });
  assert.equal(explicit.container, 'chosen');
  assert.equal(explicit.databaseUrl, undefined);

  assert.deepEqual(targetFromEnvironment({}, {}), {});
});

test('the runbook, the deployment note and the configuration name the same fence', async () => {
  const runbook = await readFile(join('docs', 'implementation', 'MVP-operations.md'), 'utf8');
  const note = await readFile(join('deploy', 'README.md'), 'utf8');
  const database = await readFile(join('deploy', 'postgres.compose.yml'), 'utf8');
  const api = await readFile(join('deploy', 'api.compose.yml'), 'utf8');
  const documented = documentedFencePath(runbook);
  const readme = readmeFencePath(note);
  const configured = /ONLINE_RESTORE_FENCE_PATH:\s*(\S+)/.exec(database)?.[1] ?? '';
  const configuredApi = /ONLINE_RESTORE_FENCE_PATH:\s*(\S+)/.exec(api)?.[1] ?? '';
  assert.notEqual(documented, '');
  assert.equal(documented, readme);
  assert.equal(documented, configured);
  assert.equal(configured, configuredApi);
  const agreement = fencePathAgreement({ documented, compose: configured, readme });
  assert.equal(agreement.ok, true);
  assert.deepEqual(agreement.distinct, [documented]);
});

test('the rendered configuration of the services names the fence', () => {
  const rendered = JSON.stringify({
    services: {
      postgres: { environment: { ONLINE_RESTORE_FENCE_PATH: '/var/lib/kamkmchess/restore-fence' } },
      api: { environment: { ONLINE_RESTORE_FENCE_PATH: '/var/lib/kamkmchess/restore-fence' } },
    },
  });
  const paths = composeFencePaths(rendered);
  assert.equal(paths.postgres, '/var/lib/kamkmchess/restore-fence');
  assert.equal(paths.api, '/var/lib/kamkmchess/restore-fence');
  // A configuration that cannot be parsed names no fence at all.
  const empty = composeFencePaths('not json');
  assert.equal(empty.postgres, '');
  assert.equal(empty.api, '');
  assert.equal(empty.volumes.postgres, null);
  assert.equal(empty.volumes.api, null);
});

test('the proof owns the schema of its run and never the schema of another run', () => {
  assert.equal(ownedSchemaName(RUN_SCHEMA), RUN_SCHEMA);
  assert.equal(ownedSchemaName('fence_probe_somethingelse'), null);
  assert.equal(ownedSchemaName(''), null);
  assert.notEqual(RUN_SCHEMA, RESTORE_RUN_SCHEMA);
});

test('the keep option keeps the schema of the run and says so', async () => {
  const io = fakeIo();
  const report = await runAccessProof({
    io,
    keep: true,
    databaseUrl: 'postgres://postgres@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable',
  });
  const drops = io.calls.filter((call) => call.args.some((argument) => String(argument).includes('DROP SCHEMA IF EXISTS')));
  assert.equal(drops.length, 0);
  const step = report.steps.find((entry) => entry.id === 'the-schema-of-the-run-is-kept');
  assert.ok(step);
  assert.match(step.detail, /kept/i);
  assert.equal(io.state.schemaExists, true);

  const plan = planFenceCleanup({
    keep: true,
    containers: [],
    databases: [],
    volumes: ['volume-1'],
    directory: '/tmp/run',
    logs: [],
    schema: RUN_SCHEMA,
    schemaKept: true,
  });
  assert.equal(plan.manifest.schema, RUN_SCHEMA);
  assert.equal(plan.manifest.schemaKept, true);
});

test('the native proof owns a database as soon as it exists', async () => {
  const order = [];
  const registered = [];
  await assert.rejects(async () => {
    await createAndMigrate('kamkmchess_proof_source_x', {
      create: async () => { order.push('create'); },
      register: (name) => { order.push('register'); registered.push(name); },
      migrate: async () => { order.push('migrate'); throw new Error('the migrations could not be applied'); },
    });
  }, /the migrations could not be applied/);
  // The database is owned before the migration runs, so a failed migration
  // still leaves a database the cleanup drops.
  assert.deepEqual(order, ['create', 'register', 'migrate']);
  assert.deepEqual(registered, ['kamkmchess_proof_source_x']);
});

test('a proof that stops with an error still reports every step it did not run', () => {
  const report = reportFailure([], [], new Error('the database could not be created'));
  const failed = report.steps.find((step) => step.id === 'the-proof-failed');
  assert.ok(failed);
  assert.equal(failed.passed, false);
  const missing = report.steps.filter((step) => step.id.endsWith('-ran'));
  assert.equal(missing.length, REQUIRED_STEPS.length);
  assert.ok(missing.every((step) => step.passed === false));
});

test('the service that serves again after the fence is closed is a required step', () => {
  assert.ok(REQUIRED_STEPS.includes('the-service-serves-again-after-the-fence-is-closed'));
});


test('the two services have to mount the same fence volume', () => {
  const shared = {
    postgres: { source: 'restorefence', target: '/var/lib/kamkmchess/restore-fence', readOnly: false },
    api: { source: 'restorefence', target: '/var/lib/kamkmchess/restore-fence', readOnly: true },
  };
  const agreement = fenceVolumeAgreement(shared);
  assert.equal(agreement.ok, true);
  assert.match(agreement.detail, /restorefence/);

  // Another volume at the same path is a different fence.
  const diverging = fenceVolumeAgreement({
    postgres: shared.postgres,
    api: { ...shared.api, source: 'otherfence' },
  });
  assert.equal(diverging.ok, false);
  assert.match(diverging.detail, /different volumes/);

  // The service that observes the fence may not write it.
  const writableApi = fenceVolumeAgreement({ postgres: shared.postgres, api: { ...shared.api, readOnly: false } });
  assert.equal(writableApi.ok, false);
  assert.match(writableApi.detail, /writable/);

  // The restore has to be able to write it.
  const readOnlyDatabase = fenceVolumeAgreement({ postgres: { ...shared.postgres, readOnly: true }, api: shared.api });
  assert.equal(readOnlyDatabase.ok, false);
  assert.match(readOnlyDatabase.detail, /read-only/);

  // A service that mounts nothing is not a fence.
  assert.equal(fenceVolumeAgreement({ postgres: shared.postgres, api: null }).ok, false);
});

test('the rendered configuration carries the volume of every service', () => {
  const rendered = JSON.stringify({
    services: {
      postgres: {
        environment: { ONLINE_RESTORE_FENCE_PATH: '/var/lib/kamkmchess/restore-fence' },
        volumes: [{ type: 'volume', source: 'restorefence', target: '/var/lib/kamkmchess/restore-fence', read_only: false }],
      },
      api: {
        environment: { ONLINE_RESTORE_FENCE_PATH: '/var/lib/kamkmchess/restore-fence' },
        volumes: [{ type: 'volume', source: 'restorefence', target: '/var/lib/kamkmchess/restore-fence', read_only: true }],
      },
    },
  });
  const paths = composeFencePaths(rendered);
  assert.equal(paths.postgres, '/var/lib/kamkmchess/restore-fence');
  assert.equal(paths.api, '/var/lib/kamkmchess/restore-fence');
  assert.equal(paths.volumes.postgres.source, 'restorefence');
  assert.equal(paths.volumes.postgres.readOnly, false);
  assert.equal(paths.volumes.api.readOnly, true);
  assert.equal(fenceVolumeAgreement(paths.volumes).ok, true);
});

test('the native proof reaches the database of the target with a parsed url', () => {
  // The url of the container is the url of the target with only the host
  // changed, so a target that is spelled localhost works as well.
  const inside = insideDatabaseUrl('postgres://postgres@localhost:55467/kamkmchess_online_test?sslmode=disable', 'kamkmchess_proof_target_x');
  assert.match(inside, /host\.docker\.internal:55467/);
  assert.match(inside, /kamkmchess_proof_target_x/);
  assert.match(inside, /sslmode=disable/);

  // The credentials of the target are kept.
  const withSecret = insideDatabaseUrl('postgres://proof:secret@127.0.0.1:55467/kamkmchess_online_test?sslmode=require', 'kamkmchess_proof_target_x');
  assert.match(withSecret, /proof:secret@host\.docker\.internal:55467/);
  assert.match(withSecret, /sslmode=require/);
});

test('the evidence only recovery of the runbook reads no bundle and no passphrase', async () => {
  // The recovery of a restore whose evidence directory was lost is given the
  // protected copy of the record alone. A command that still carries the
  // bundle or the passphrase is not the evidence only recovery, and the
  // parent rejected it in the round thirty.
  const runbook = await readFile(join('docs', 'implementation', 'MVP-operations.md'), 'utf8');
  const blocks = [...runbook.matchAll(/```sh\r?\n([\s\S]*?)```/g)].map((match) => match[1]);
  // Every documented command is a segment of its own.
  const commands = blocks
    .flatMap((block) => block.split(/(?=docker compose)/g))
    .filter((part) => part.includes('khabackup recover'));
  const evidenceOnly = commands.filter((part) => part.includes('--evidence'));
  assert.ok(evidenceOnly.length > 0, 'the runbook documents the evidence only recovery');
  for (const command of evidenceOnly) {
    assert.equal(/--file[= ]/.test(command), false, 'the evidence only recovery carries a bundle');
    assert.equal(/--passphrase-env[= ]/.test(command), false, 'the evidence only recovery carries a passphrase');
    assert.match(command, /unset KHA_BACKUP_PASSPHRASE/);
  }
  // The recovery with the bundle still carries the bundle and the
  // passphrase, so the guard above does not empty the runbook.
  assert.ok(commands.some((command) => command.includes('--file') && command.includes('--passphrase-env')));
});

test('the backup procedure copies the durable evidence of the restores', async () => {
  // The copy of the evidence is only durable when the backup procedure makes
  // it, and the program that makes it is the program the proofs measure.
  const backup = await readFile(join('deploy', 'backup.sh'), 'utf8');
  assert.match(backup, /copy-restore-evidence\.sh/);
  assert.match(backup, /\/backups\/restore-evidence/);
  const compose = await readFile(join('deploy', 'postgres.compose.yml'), 'utf8');
  // The programs of the deployment are mounted into the container, so the
  // operator and the backup run the very same files.
  assert.match(compose, /check-restore-id\.sh:\/opt\/kamkmchess-operator\/check-restore-id\.sh:ro/);
  assert.match(compose, /copy-restore-evidence\.sh:\/opt\/kamkmchess-operator\/copy-restore-evidence\.sh:ro/);
  // The destination of the copy is inside the mounted directory of the
  // bundles, and not in the writable layer of the container.
  assert.match(compose, /\.\/backups:\/backups/);
});

test('the identifier of a restore is checked by the rule of the production code', async () => {
  // The program that reads the identifier out of the marker of the lifecycle
  // is the one the proofs exercise, and its rule is the rule of the
  // production code.
  const program = await readFile(join('deploy', 'check-restore-id.sh'), 'utf8');
  assert.match(program, /\[!A-Za-z0-9\._-\]/);
  assert.match(program, /\[A-Za-z0-9\]\*/);
  assert.match(program, /-lt 8/);
  assert.match(program, /-gt 128/);
  // The rule of the program and the rule of the proof are the same one.
  assert.equal(RESTORE_ID_PATTERN.source, '^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$');
});

test('no operator-facing file ships the restore command that cannot read its secret', async () => {
  // The command that sources the private file as the restore user was the
  // defect of the round five, and it must not come back in any file.
  const broken = /exec --user 65532[^\n]*[\s\S]{0,200}?\. \/run\/secrets\/backup\.env/;
  const offenders = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.scratch' || entry.name === 'dist') continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!/\.(mjs|js|md|sh|py|yml|yaml|json|go|ts)$/.test(entry.name)) continue;
      const content = await readFile(full, 'utf8');
      if (broken.test(content)) offenders.push(full);
    }
  };
  await walk('.');
  assert.deepEqual(offenders, []);
});


test('only a named volume can be the shared fence volume', () => {
  const fence = '/var/lib/kamkmchess/restore-fence';
  const service = (volume) => JSON.stringify({
    services: {
      postgres: {
        environment: { ONLINE_RESTORE_FENCE_PATH: fence },
        volumes: [{ type: 'volume', source: 'restorefence', target: fence, read_only: false }, ...(volume ? [volume] : [])],
      },
      api: {
        environment: { ONLINE_RESTORE_FENCE_PATH: fence },
        volumes: [{ type: 'volume', source: 'restorefence', target: fence, read_only: true }, ...(volume ? [volume] : [])],
      },
    },
  });

  // The named volume is found.
  const named = composeFencePaths(service(null));
  assert.equal(named.volumes.postgres.source, 'restorefence');
  assert.equal(named.volumes.api.source, 'restorefence');
  assert.equal(fenceVolumeAgreement(named.volumes).ok, true);

  // An anonymous volume has no name to share.
  const anonymous = composeFencePaths(service({ type: 'volume', target: '/other' }));
  assert.equal(anonymous.volumes.postgres.source, 'restorefence');
  assert.equal(fenceVolumeAgreement(anonymous.volumes).ok, true);

  // A tmpfs and a bind mount are not volumes, and two of them with an empty
  // source would look like the same volume.
  const tmpfs = composeFencePaths(service({ type: 'tmpfs', target: fence }));
  assert.equal(tmpfs.volumes.postgres.source, 'restorefence');
  const bind = composeFencePaths(service({ type: 'bind', source: '/srv/fence', target: fence }));
  assert.equal(bind.volumes.api.source, 'restorefence');

  // A service that mounts nothing named at the fence path has no volume.
  const empty = JSON.stringify({
    services: {
      postgres: { environment: { ONLINE_RESTORE_FENCE_PATH: fence }, volumes: [{ type: 'tmpfs', target: fence }] },
      api: { environment: { ONLINE_RESTORE_FENCE_PATH: fence }, volumes: [{ type: 'volume', source: 'restorefence', target: fence, read_only: true }] },
    },
  });
  const withoutVolume = composeFencePaths(empty);
  assert.equal(withoutVolume.volumes.postgres, null);
  assert.equal(fenceVolumeAgreement(withoutVolume.volumes).ok, false);
});

test('the negative control of the volume comparison has to qualify', () => {
  // A configuration that did not render is not a detection.
  const failed = fenceVolumeControl({ rendered: false, volumes: { postgres: null, api: null } });
  assert.equal(failed.qualified, false);
  assert.match(failed.detail, /could not be rendered/);

  // A configuration without a named volume is not a detection either.
  const missing = fenceVolumeControl({ rendered: true, volumes: { postgres: null, api: { source: 'otherfence' } } });
  assert.equal(missing.qualified, false);
  assert.match(missing.detail, /mounts no named volume/);

  // A configuration that mounts the same volume is no control at all.
  const same = fenceVolumeControl({
    rendered: true,
    volumes: { postgres: { source: 'restorefence' }, api: { source: 'restorefence' } },
  });
  assert.equal(same.qualified, false);
  assert.match(same.detail, /no control at all/);

  // A configuration with another volume qualifies, and the agreement has to
  // refuse it.
  const diverging = fenceVolumeControl({
    rendered: true,
    volumes: { postgres: { source: 'restorefence' }, api: { source: 'otherfence' } },
  });
  assert.equal(diverging.qualified, true);
  const agreement = fenceVolumeAgreement({
    postgres: { source: 'restorefence', target: '/var/lib/kamkmchess/restore-fence', readOnly: false },
    api: { source: 'otherfence', target: '/var/lib/kamkmchess/restore-fence', readOnly: true },
  });
  assert.equal(agreement.ok, false);
  assert.match(agreement.detail, /different volumes/);
});

test('the native proof never writes the secret of the target to the report', () => {
  const url = new URL('postgres://proof:s3cr3t%20with%20space@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable');
  const steps = [
    { id: 'the-proof-failed', passed: false, detail: 'the migrations could not be applied: failed to connect to postgres://proof:s3cr3t%20with%20space@127.0.0.1:55467/kamkmchess_online_test' },
  ];
  // A tool prints the password decoded, the url of the target carries it
  // percent encoded: both forms have to be gone.
  const logs = ['the tool said: password s3cr3t with space is wrong', 'the tool said: password s3cr3t%20with%20space is wrong'];
  const report = redactReport(steps, logs, url);
  const text = JSON.stringify(report);
  assert.equal(text.includes('s3cr3t'), false);
  assert.equal(text.includes('s3cr3t%20with%20space'), false);
  assert.equal(text.includes('s3cr3t with space'), false);
  assert.match(report.steps[0].detail, /\*\*\*/);
  assert.match(report.logs[0], /\*\*\*/);
  assert.match(report.logs[1], /\*\*\*/);
  const cleanup = planRestoreCleanup({
    keep: true, containers: [], databases: [], volumes: ['owned-volume'],
    directory: 'owned-directory', logs: ['password s3cr3t with space', 'password s3cr3t%20with%20space'], url,
  });
  assert.equal(JSON.stringify(cleanup.manifest).includes('s3cr3t'), false);
});


test('the manifest of the run carries neither form of the secret of the target', () => {
  const url = new URL('postgres://proof:s3cr3t%20with%20space@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable');
  const logs = ['password s3cr3t with space', 'password s3cr3t%20with%20space'];
  const cleanup = planFenceCleanup({
    keep: true,
    containers: ['owned-container'],
    databases: ['owned-database'],
    volumes: ['owned-volume'],
    directory: 'owned-directory',
    logs,
    url,
  });
  const manifest = JSON.stringify(cleanup.manifest);
  assert.equal(manifest.includes('s3cr3t'), false);
  assert.equal(manifest.includes('s3cr3t%20with%20space'), false);
  assert.equal(manifest.includes('s3cr3t with space'), false);
  // The logs are still there, only the secret is gone.
  assert.equal(cleanup.manifest.logs.length, 2);
  assert.match(cleanup.manifest.logs[0], /\*\*\*/);
});


test('the barrier of the native import runs the real psql and pauses where it is told', () => {
  // Every case has its own program, with the mode written into it: the
  // environment of the loader is an explicit allowlist of the production
  // code and never carries a switch of the proof.
  const during = barrierScript('during', { application: 'kamkm_proof_barrier_during', marker: '/backups/barrier-during-committed', inject: '/fixtures/inject-during.sql' });
  const after = barrierScript('after', { application: 'kamkm_proof_barrier_after', marker: '/backups/barrier-after-committed' });
  const none = barrierScript('none', { application: 'kamkm_proof_barrier_none' });

  // The real loader is called with the arguments the tool passes.
  assert.match(during, /"\$REAL_PSQL" "\$@"/);
  assert.match(after, /"\$REAL_PSQL" "\$@"/);
  // The path of the loader is found in the image, not guessed.
  assert.match(during, /command -v psql/);
  // The marker of the "after" case is written after the psql committed, and
  // the program waits for the kill.
  assert.match(after, /touch \/backups\/barrier-after-committed/);
  assert.match(after, /while true/);
  // No program reads a switch of the proof from the environment.
  for (const program of [during, after, none]) {
    assert.equal(program.includes('KAMKM_BARRIER_MODE'), false);
    assert.equal(program.includes('KAMKM_REAL_PSQL'), false);
  }
  // The name of the application identifies the backend of the barrier.
  assert.match(during, /PGAPPNAME=kamkm_proof_barrier_during/);
  assert.match(after, /PGAPPNAME=kamkm_proof_barrier_after/);
});

test('the barrier of the import waits for the destructive statement of the real dump', () => {
  // The kill of the proof has to land after the import destroyed something.
  // A barrier that pauses after the first statement of the dump would pause
  // before the import touched anything, and the rollback of the transaction
  // would prove nothing at all.
  const during = barrierScript('during', {
    application: 'kamkm_proof_during',
    marker: '/backups/barrier-during',
    inject: '/fixtures/inject-during.sql',
  });
  // The program looks for the destructive statement of the real dump and
  // writes the marker of the barrier only after it.
  assert.match(during, /DROP TABLE IF EXISTS public\[\.\]online_removal_ledger;\$/);
  assert.match(during, /while \(\(getline line < inject\) > 0\) print line/);
  // The statements of the barrier are read from a file of their own, so the
  // program of the barrier stays a program and never a restatement of the
  // import.
  assert.match(during, /inject='\/fixtures\/inject-during\.sql'/);

  const injection = injectionScript({ relation: 'online_removal_ledger', marker: '/tmp/proof-barrier-during.txt' });
  // The barrier refuses the load when the relation of the removal ledger is
  // still there, so a barrier that did not run after the destructive
  // statement aborts the import instead of pretending that it did.
  assert.match(injection, /to_regclass\('online_removal_ledger'\) IS NOT NULL/);
  assert.match(injection, /RAISE EXCEPTION/);
  // The marker is written from inside the transaction and names the backend
  // that wrote it.
  assert.match(injection, /COPY \(SELECT 'pid=' \|\| pg_backend_pid\(\)::text/);
  assert.match(injection, /relation_present=/);
  assert.match(injection, /TO '\/tmp\/proof-barrier-during\.txt'/);
  // The transaction stays open, so the kill lands while it is open.
  assert.match(injection, /pg_sleep\(600\)/);
});

test('every case of the proof has a fence, a marker and an application name of its own', () => {
  const cases = proofCases('abc123def456');
  const names = Object.keys(cases);
  assert.deepEqual(names.sort(), ['after', 'during', 'evidence', 'nosink']);
  const fences = new Set();
  const markers = new Set();
  const applications = new Set();
  const databases = new Set();
  for (const name of names) {
    const entry = cases[name];
    // The fence of a case is a parent of its own, so the marker, the lock
    // and the evidence directory of one case never belong to another case.
    assert.equal(entry.fence, `/backups/fence-abc123def456/${name}`);
    assert.equal(entry.database, `kamkmchess_interruption_${name}_abc123def456`);
    // The marker of the commit of a case is the marker of that case alone.
    assert.equal(entry.marker, `/backups/barrier-${name}-abc123def456.committed`);
    fences.add(entry.fence);
    markers.add(entry.marker);
    applications.add(entry.application);
    applications.add(entry.plainApplication);
    databases.add(entry.database);
  }
  assert.equal(fences.size, names.length);
  assert.equal(markers.size, names.length);
  assert.equal(applications.size, names.length * 2);
  assert.equal(databases.size, names.length);
  // The evidence case is killed after the commit as well, so it uses the
  // barrier of the commit with a marker of its own.
  assert.equal(cases.evidence.barrier, 'after');
  assert.equal(cases.during.barrier, 'during');
  assert.equal(cases.nosink.barrier, 'none');
});

test('the identifier of a restore is only ever used as a name', () => {
  // The identifier of a restore becomes the name of the record of the owed
  // ledger, so a name that carries a path separator is refused before it
  // reaches a path.
  assert.equal(restoreIdIsUsable('restore-20261021T165057Z-2e2840f3d33b'), true);
  assert.equal(restoreIdIsUsable('restore-staged-abc123'), true);
  assert.equal(restoreIdIsUsable('../../etc/passwd'), false);
  assert.equal(restoreIdIsUsable('restore/2026'), false);
  assert.equal(restoreIdIsUsable('short'), false);
  assert.equal(restoreIdIsUsable(''), false);
  assert.equal(restoreIdIsUsable(undefined), false);
});

test('the interruption proof names every case it has to show', () => {
  for (const step of [
    'the-import-is-killed-during-the-transaction',
    'the-import-destroyed-the-removal-ledger-inside-the-transaction',
    'the-import-is-rolled-back',
    'the-import-is-killed-after-the-commit',
    'the-live-only-ledger-is-lost-from-the-database',
    'the-durable-evidence-of-the-owed-ledger-exists',
    'the-evidence-of-the-restore-names-its-own-restore',
    'the-recovery-refuses-the-lost-ledger',
    'the-take-over-replays-the-owed-ledger',
    'the-service-admits-after-the-replay',
    'the-recovery-refuses-the-lost-ledger-with-the-copied-record',
    'the-obligation-of-the-next-import-is-retained',
    'the-recovery-succeeds-with-the-copied-record-alone',
    'the-recovery-closed-the-fence-of-the-recovered-restore',
    'the-next-import-without-a-sink-is-refused',
    'the-refused-import-did-not-touch-the-database',
    'the-refused-take-over-keeps-the-crashed-restore',
    'the-removed-data-does-not-come-back',
    'the-control-survives',
  ]) {
    assert.ok(INTERRUPTION_REQUIRED_STEPS.includes(step), `${step} is not a required step`);
  }
  // The old expectation that a refused recovery leaves the evidence of the
  // run absent is gone: the obligation of the next import is durable and is
  // written again by the refused recovery.
  assert.equal(INTERRUPTION_REQUIRED_STEPS.includes('the-obligation-of-the-restore-is-still-owed'), false);
  assert.ok(INTERRUPTION_REQUIRED_STEPS.includes('the-obligation-of-the-next-import-is-retained'));
});

test('a proof that skipped a case is never green', () => {
  const report = fenceCompleteReport([], [], ['the proof stopped early']);
  const missing = report.steps.filter((step) => step.id.endsWith('-ran'));
  assert.equal(missing.length, FENCE_REQUIRED_STEPS.length);
  assert.ok(missing.every((step) => step.passed === false));

  const complete = fenceCompleteReport(
    FENCE_REQUIRED_STEPS.map((id) => ({ id, passed: true, detail: '' })),
    [],
    [],
  );
  assert.equal(complete.steps.filter((step) => step.id.endsWith('-ran')).length, 0);
});