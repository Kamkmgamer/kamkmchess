// Offline tests for the least-privilege runtime grant policy.
//
// The tests build throwaway trees, so they never touch a database and never
// depend on the live application.

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import process from 'node:process';
import { after, test } from 'node:test';

import {
  auditGrants,
  auditLiveGrants,
  loadTree,
  parseMigrationTables,
  parseMigrationReads,
  parsePolicy,
  renderGrantSql,
  scanGoUsage,
  stripGoLiterals,
} from './runtime-grants.mjs';

const trees = [];

after(async () => {
  await Promise.all(trees.map((directory) => rm(directory, { recursive: true, force: true })));
});

test('migration parsing names every created table', () => {
  const sql = `
    CREATE TABLE IF NOT EXISTS games (id text primary key);
    CREATE TABLE online_events (id bigint primary key);
    create table if not exists online_clocks (id bigint primary key);
  `;
  assert.deepEqual(parseMigrationTables(sql), ['games', 'online_clocks', 'online_events']);
});

test('go literals and comments do not create phantom table usage', () => {
  const source = `
    package online
    // INSERT INTO online_moves is mentioned in a comment.
    const q = "INSERT INTO online_fake (id) VALUES ($1)";
    /* UPDATE online_other SET x = 1 */
    func run() { _, _ = db.Exec(ctx, ` + "`INSERT INTO online_real (id) VALUES ($1)`" + `) }
  `;
  const usage = scanGoUsage(source);
  assert.ok(usage.has('online_real'));
  assert.ok(!usage.has('online_fake'));
  assert.ok(!usage.has('online_other'));
  assert.ok(!usage.has('online_moves'));
});

test('a policy that requests ALL is refused', () => {
  assert.throws(() => parsePolicy({ privileges: { games: ['ALL'] } }), /ALL privileges/);
  assert.throws(() => parsePolicy({ privileges: { games: ['TRUNCATE'] } }), /unknown privilege/);
});

test('a missing table grant is a blocker and an unused grant is a warning', () => {
  const policy = parsePolicy({
    role: 'kamkmchess_runtime',
    privileges: { games: ['SELECT', 'INSERT'], online_events: ['SELECT', 'INSERT', 'UPDATE'] },
  });
  const findings = auditGrants({
    policy,
    tables: ['games', 'online_events', 'online_seats'],
    usage: new Map([
      ['games', new Set(['SELECT', 'INSERT'])],
      ['online_events', new Set(['SELECT', 'INSERT'])],
    ]),
  });
  const codes = findings.map((finding) => finding.code);
  assert.ok(codes.includes('grant-missing-table'));
  assert.ok(codes.includes('grant-unused-privilege'));
  const missing = findings.find((finding) => finding.code === 'grant-missing-table');
  assert.equal(missing.severity, 'blocker');
});

test('a write the policy does not grant is a blocker', () => {
  const policy = parsePolicy({ privileges: { online_events: ['SELECT'] } });
  const findings = auditGrants({
    policy,
    tables: ['online_events'],
    usage: new Map([['online_events', new Set(['SELECT', 'INSERT'])]]),
  });
  const missing = findings.find((finding) => finding.code === 'grant-missing-privilege');
  assert.ok(missing);
  assert.equal(missing.severity, 'blocker');
});

test('the rendered SQL grants one table at a time and never uses a blanket grant', () => {
  const policy = parsePolicy({ privileges: { games: ['SELECT', 'INSERT'], online_events: ['SELECT'] } });
  const sql = renderGrantSql(policy, { database: 'kamkmchess' });
  assert.match(sql, /GRANT INSERT, SELECT ON TABLE public\.games TO kamkmchess_runtime;/);
  assert.match(sql, /GRANT SELECT ON TABLE public\.online_events TO kamkmchess_runtime;/);
  assert.doesNotMatch(sql, /GRANT ALL ON ALL TABLES/);
  assert.doesNotMatch(sql, /GRANT ALL ON TABLE/);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;/);
});

test('a live grant set that drifts from the policy is reported', () => {
  const policy = parsePolicy({ privileges: { games: ['SELECT', 'INSERT'] } });
  const live = new Map([['games', new Set(['SELECT', 'INSERT', 'UPDATE'])]]);
  const findings = auditLiveGrants(policy, live);
  assert.ok(findings.some((finding) => finding.code === 'live-grant-extra'));
  const missing = auditLiveGrants(policy, new Map());
  assert.ok(missing.some((finding) => finding.code === 'live-grant-missing'));
});

test('the checked-in policy matches the checked-in tree', async () => {
  const root = process.cwd();
  const { policy, tables, usage, sequences, functions } = await loadTree(root);
  const findings = auditGrants({ policy, tables, usage, sequences, functions });
  const blockers = findings.filter((finding) => finding.severity === 'blocker');
  assert.equal(blockers.length, 0, JSON.stringify(blockers, null, 2));
});

test('the tree loader finds the migration tables and the writer statements', async () => {
  const root = process.cwd();
  const { tables, usage } = await loadTree(root);
  assert.ok(tables.includes('online_matches'));
  assert.ok(tables.includes('games'));
  assert.ok(usage.has('online_events'));
  assert.ok(usage.get('online_events').has('INSERT'));
});

test('the remediation of a stripped role names what the grant probe proves', () => {
  const policy = parsePolicy({
    role: 'kamkmchess_runtime',
    unusedRoles: ['kamkm_online_rules'],
    privileges: { alpha: ['SELECT'] },
  });
  const findings = auditGrants({
    policy,
    tables: ['alpha'],
    usage: new Map(),
    migrationGrants: [{ role: 'kamkm_online_rules', table: 'alpha', privileges: ['SELECT'] }],
  });
  const reported = findings.find((finding) => finding.code === 'migration-grant-stripped-role');
  assert.ok(reported);
  // The probe reads the table privileges of the unused role, so the claim
  // names the tables. It reads no sequence right of the role, so the claim
  // does not say that the role holds nothing.
  assert.match(reported.remediation, /no table privilege/);
  assert.match(reported.remediation, /reads no sequence right/);
  assert.doesNotMatch(reported.remediation, /holds nothing/);
});

test('comment stripping leaves executable statements alone', () => {
  const stripped = stripGoLiterals('a := "text" // note\nb := 2');
  assert.ok(!stripped.includes('"text"'));
  assert.ok(stripped.includes('b := 2'));
});

test('a read that is not a table is not a read of a table', () => {
  const sql = `
    CREATE OR REPLACE FUNCTION online_public_replay_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.replay_json IS DISTINCT FROM raw_label THEN
        RETURN NEW;
      END IF;
      SELECT count(*) FROM OLD.replay_json;
      SELECT count(*) FROM online_public_replays;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `;
  const reads = parseMigrationReads(sql);
  // The right side of a comparison and a row reference are not tables.
  assert.ok(!reads.includes('raw_label'));
  assert.ok(!reads.includes('replay_json'));
  assert.ok(reads.includes('online_public_replays'));
});
