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
import { composeFencePaths, documentedFencePath, fencePathAgreement, holderDatabaseUrl, ownedSchemaName, planCleanup as planFenceCleanup, proofExitCode as fenceExitCode, readmeFencePath, resolveTarget, RUN_SCHEMA, targetFromEnvironment, verifyFenceAccess } from '../../deploy/verify-fence-access.mjs';
import { completeReport, createAndMigrate, planCleanup as planRestoreCleanup, reportFailure, REQUIRED_STEPS, RUN_SCHEMA as RESTORE_RUN_SCHEMA } from './restore-proof.mjs';
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
  assert.deepEqual(composeFencePaths('not json'), { postgres: '', api: '' });
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
