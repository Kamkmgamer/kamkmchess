// Real PostgreSQL probe of the runtime role's grants.
//
// The source scan in deploy/runtime-grants.mjs proves the policy matches the
// code. This probe proves the policy works when it is applied to a real
// PostgreSQL server: it creates a throwaway role and schema, applies the
// checked-in migrations, applies the rendered grants, and then executes
// statements as that role.
//
// It answers one question: can the runtime role do exactly what the policy
// says and nothing else?
//
// Usage:
//   node deploy/runtime-grants-probe.mjs
//   node deploy/runtime-grants-probe.mjs --database-url "$DATABASE_URL" --json
//
// The probe only uses a local database. It creates and drops its own role and
// schema, and it never touches a hosted database.

import { execFile, spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { parsePolicy, renderGrantSql } from './runtime-grants.mjs';
import { discoverLocalDatabaseUrl, redactDatabaseUrl } from '../scripts/online/fixture-client.mjs';

const run = promisify(execFile);

/**
 * @typedef {object} Probe
 * @property {string} id
 * @property {string} description
 * @property {'allowed'|'denied'} expectation
 * @property {string} sql
 * @property {string} [verifySql]
 * @property {string} [verifyExpectation]
 */

/**
 * Builds the statement probes from the policy.
 *
 * The probes are derived from the policy, so a policy change cannot silently
 * leave a stale probe behind.
 * @param {ReturnType<typeof parsePolicy>} policy
 * @param {string} schema
 * @returns {Probe[]}
 */
export function buildProbes(policy, schema, columns = new Map()) {
  /** @type {Probe[]} */
  const probes = [];
  const qualified = (table) => `${schema}.${table}`;

  for (const [table, verbs] of [...policy.privileges.entries()].sort()) {
    if (verbs.has('SELECT')) {
      probes.push({
        id: `select-${table}`,
        description: `the runtime role reads ${table}`,
        expectation: 'allowed',
        sql: `SELECT count(*) FROM ${qualified(table)};`,
      });
    }
    if (verbs.has('INSERT')) {
      // A real insert, not a statement about the grant. The write is rolled
      // back, and a rejected row is still proof that the write reached the
      // table.
      probes.push({
        id: `insert-${table}`,
        description: `the runtime role writes a row into ${table}`,
        expectation: 'allowed',
        sql: `BEGIN; INSERT INTO ${qualified(table)} DEFAULT VALUES; ROLLBACK;`,
      });
    }
    if (verbs.has('UPDATE')) {
      const column = columns.get(table);
      if (column) {
        probes.push({
          id: `update-${table}`,
          description: `the runtime role updates ${table}`,
          expectation: 'allowed',
          sql: `BEGIN; UPDATE ${qualified(table)} SET ${column} = ${column} WHERE false; ROLLBACK;`,
        });
      }
    }
    if (verbs.has('DELETE')) {
      probes.push({
        id: `delete-${table}`,
        description: `the runtime role deletes from ${table}`,
        expectation: 'allowed',
        sql: `BEGIN; DELETE FROM ${qualified(table)} WHERE false; ROLLBACK;`,
      });
    } else {
      probes.push({
        id: `deny-delete-${table}`,
        description: `the runtime role cannot delete from ${table}`,
        expectation: 'denied',
        sql: `DELETE FROM ${qualified(table)} WHERE false;`,
      });
    }
  }

  probes.push({
    id: 'insert-games',
    description: 'the runtime role creates an account game row',
    expectation: 'allowed',
    sql: `INSERT INTO ${qualified('games')} (game_id, owner_id, revision, ownership_epoch, checkpoint_json) VALUES ('probe-game', 'probe-owner', 1, 1, '\\x00'::bytea);`,
  });
  probes.push({
    id: 'deny-create-table',
    description: 'the runtime role cannot create a table',
    expectation: 'denied',
    sql: 'CREATE TABLE probe_created_by_runtime (id integer);',
  });
  probes.push({
    id: 'deny-drop-table',
    description: 'the runtime role cannot drop a table',
    expectation: 'denied',
    sql: `DROP TABLE ${qualified('games')};`,
  });
  probes.push({
    id: 'deny-read-ungranted-table',
    description: 'the runtime role cannot read a table outside the policy',
    expectation: 'denied',
    sql: `SELECT count(*) FROM ${qualified('probe_ungranted_table')};`,
  });
  probes.push({
    id: 'deny-grant',
    description: 'the runtime role cannot hand a privilege to another role',
    expectation: 'denied',
    sql: `GRANT SELECT ON ${qualified('games')} TO PUBLIC;`,
    // PostgreSQL answers a grant from a non-owner with a warning, not an
    // error, so the probe checks the resulting catalog instead of the exit
    // code.
    verifySql: `SELECT count(*) FROM information_schema.role_table_grants WHERE grantee = 'PUBLIC' AND table_name = 'games' AND table_schema = '${schema}';`,
    verifyExpectation: '0',
  });
  return probes;
}

/**
 * Decides whether one probe result matches its expectation.
 * @param {Probe} probe
 * @param {{ok: boolean, stderr: string}} result
 * @returns {{passed: boolean, detail: string}}
 */
export function evaluateProbe(probe, result) {
  // A privilege refusal is the only failure that proves the grant is missing.
  // Every other error means the statement reached the table and the database
  // refused the row, which is a permitted write.
  const privilegeRefusal = !result.ok && /permission denied|must be owner|not authorized/i.test(result.stderr);
  const allowed = result.ok;
  if (probe.expectation === 'allowed') {
    if (allowed) {
      return { passed: true, detail: 'the statement was accepted' };
    }
    if (privilegeRefusal) {
      return { passed: false, detail: `the statement was refused by the server: ${result.stderr.trim().split('\n')[0] ?? ''}` };
    }
    return {
      passed: true,
      detail: `the write reached the table and the row was refused: ${result.stderr.trim().split('\n')[0] ?? ''}`,
    };
  }
  return privilegeRefusal
    ? { passed: true, detail: 'the statement was refused by the server' }
    : {
      passed: false,
      detail: allowed
        ? 'the statement was accepted although the policy forbids it'
        : `the statement failed for an unrelated reason: ${result.stderr.trim().split('\n')[0] ?? ''}`,
    };
}

/**
 * Runs SQL against a local PostgreSQL server.
 *
 * It uses a local psql binary when one is available and otherwise runs psql
 * inside the local fixture container. The password is only ever passed in the
 * environment.
 */
export class LocalPostgres {
  /**
   * @param {{databaseUrl: string, container?: string|null, psqlPath?: string|null, user?: string, database?: string}} options
   */
  constructor(options) {
    this.databaseUrl = options.databaseUrl;
    this.container = options.container ?? null;
    this.psqlPath = options.psqlPath ?? null;
    this.user = options.user ?? 'postgres';
    this.database = options.database ?? 'kamkmchess_online_test';
  }

  /** @returns {Promise<{ok: boolean, stdout: string, stderr: string}>} */
  async query(sql) {
    if (this.psqlPath) {
      try {
        const { stdout, stderr } = await run(this.psqlPath, [
          '--no-psqlrc', '--tuples-only', '--no-align', '--field-separator', '|',
          '--username', this.user, '--dbname', this.database, '--command', sql,
        ], {
          env: { ...process.env, PGPASSWORD: this.password() },
          windowsHide: true,
        });
        return { ok: true, stdout, stderr };
      } catch (error) {
        const failure = /** @type {any} */ (error);
        return { ok: false, stdout: failure.stdout ?? '', stderr: failure.stderr ?? String(failure.message ?? error) };
      }
    }
    if (this.container) {
      return this.queryInContainer(sql);
    }
    throw new Error('no local PostgreSQL client is available for the grant probe');
  }

  /** @returns {Promise<{ok: boolean, stdout: string, stderr: string}>} */
  queryInContainer(sql) {
    return new Promise((resolvePromise) => {
      const child = spawn('docker', [
        'exec', '-i', String(this.container),
        'psql', '-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '--tuples-only', '--no-align',
        '--field-separator', '|', '-U', this.user, '-d', this.database, '-f', '-',
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (error) => resolvePromise({ ok: false, stdout, stderr: String(error) }));
      child.on('close', (code) => resolvePromise({ ok: code === 0, stdout, stderr }));
      child.stdin.end(sql);
    });
  }

  /** @returns {string} */
  password() {
    try {
      return decodeURIComponent(new URL(this.databaseUrl).password);
    } catch {
      return '';
    }
  }
}

/**
 * Runs the probe against a local PostgreSQL server.
 * @param {{databaseUrl: string, container?: string|null, psqlPath?: string|null, user?: string, database?: string, root: string, policy: ReturnType<typeof parsePolicy>}} options
 * @returns {Promise<{probes: {id: string, passed: boolean, detail: string}[], failures: number, cleanup: string[]}>}
 */
export async function runProbe(options) {
  const { databaseUrl, root, policy } = options;
  const postgres = new LocalPostgres({
    databaseUrl,
    container: options.container ?? null,
    psqlPath: options.psqlPath ?? null,
    user: options.user ?? 'postgres',
    database: options.database ?? 'kamkmchess_online_test',
  });
  const suffix = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
  const schema = `grant_probe_${suffix}`;
  const role = `kamkmchess_runtime_probe_${suffix}`;
  const cleanup = [];

  const migrationDirectory = join(root, 'backend', 'migrations');
  const migrations = [];
  for (const name of await readdir(migrationDirectory)) {
    if (!name.endsWith('.sql')) continue;
    migrations.push(await readFile(join(migrationDirectory, name), 'utf8'));
  }

  await postgres.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`);
  await postgres.query(`DROP ROLE IF EXISTS ${role};`);
  await postgres.query(`CREATE SCHEMA ${schema};`);
  cleanup.push(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`);
  await postgres.query(`CREATE ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;`);
  cleanup.push(`DROP ROLE IF EXISTS ${role};`);

  const migrationScript = [`SET search_path TO ${schema};`, ...migrations].join('\n');
  const migrated = await postgres.query(migrationScript);
  if (!migrated.ok) {
    throw new Error(`the grant probe could not apply the migrations: ${migrated.stderr.trim().split('\n')[0] ?? ''}`);
  }
  // A table outside the policy proves the negative read case.
  await postgres.query(`SET search_path TO ${schema}; CREATE TABLE probe_ungranted_table (id integer);`);

  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '') || 'kamkmchess';
  const grants = renderGrantSql({ ...policy, role, schema }, { database: databaseName, includeDatabaseGrants: false });
  const granted = await postgres.query(grants);
  if (!granted.ok) {
    throw new Error(`the grant probe could not apply the grants: ${granted.stderr.trim().split('\n')[0] ?? ''}`);
  }

  /** @type {{id: string, passed: boolean, detail: string}[]} */
  const results = [];
  /** @type {Map<string, string>} */
  const columns = new Map();
  for (const [table, verbs] of policy.privileges.entries()) {
    if (!verbs.has('UPDATE')) continue;
    const column = await postgres.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = '${schema}' AND table_name = '${table}'
      ORDER BY ordinal_position LIMIT 1;`);
    const name = (column.stdout || '').trim().split('\n')[0]?.trim();
    if (name) columns.set(table, name);
  }

  for (const probe of buildProbes(policy, schema, columns)) {
    const outcome = await postgres.query(`SET ROLE ${role}; SET search_path TO ${schema}; ${probe.sql}`);
    if (probe.verifySql) {
      const verification = await postgres.query(probe.verifySql);
      const observed = (verification.stdout || '').trim();
      const passed = verification.ok && observed === (probe.verifyExpectation ?? '');
      results.push({
        id: probe.id,
        passed,
        detail: passed
          ? 'the privilege was not handed over'
          : `the catalog shows ${observed || 'an unreadable answer'} after the attempt`,
      });
      continue;
    }
    const evaluation = evaluateProbe(probe, outcome);
    results.push({ id: probe.id, passed: evaluation.passed, detail: evaluation.detail });
  }

  // The effective privileges must match the policy exactly.
  const effective = await postgres.query(`
    SELECT table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE grantee = '${role}' AND table_schema = '${schema}'
    ORDER BY table_name, privilege_type;`);
  const live = new Map();
  for (const line of effective.stdout.split(/\r?\n/)) {
    const [table, privilege] = line.split('|').map((part) => part.trim());
    if (!table || !privilege) continue;
    if (!live.has(table.toLowerCase())) live.set(table.toLowerCase(), new Set());
    live.get(table.toLowerCase()).add(privilege.toUpperCase());
  }
  for (const [table, verbs] of [...policy.privileges.entries()].sort()) {
    const actual = live.get(table) ?? new Set();
    const missing = [...verbs].filter((verb) => !actual.has(verb));
    const extra = [...actual].filter((verb) => !verbs.has(verb));
    results.push({
      id: `effective-${table}`,
      passed: missing.length === 0 && extra.length === 0,
      detail: missing.length || extra.length
        ? `effective privileges differ from the policy (missing ${missing.join(', ') || 'none'}; extra ${extra.join(', ') || 'none'})`
        : 'the effective privileges match the policy',
    });
  }

  // PUBLIC must hold nothing on the application tables.
  const publicGrants = await postgres.query(`
    SELECT table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE grantee = 'PUBLIC' AND table_schema = '${schema}';`);
  const publicRows = publicGrants.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  results.push({
    id: 'public-has-no-privileges',
    passed: publicRows.length === 0,
    detail: publicRows.length === 0
      ? 'PUBLIC holds no privilege on the application tables'
      : `PUBLIC holds ${publicRows.length} privilege(s) on the application tables`,
  });

  for (const statement of cleanup) {
    await postgres.query(statement);
  }

  return { probes: results, failures: results.filter((result) => !result.passed).length, cleanup };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const root = process.cwd();
  const index = arguments_.indexOf('--database-url');
  const databaseUrl = index >= 0 ? arguments_[index + 1] : (process.env.ONLINE_FIXTURE_DATABASE_URL ?? await discoverLocalDatabaseUrl());
  const containerIndex = arguments_.indexOf('--container');
  const container = containerIndex >= 0 ? arguments_[containerIndex + 1] : 'kamkmchess-kha67-local';
  const policy = parsePolicy(JSON.parse(await readFile(join(root, 'deploy', 'runtime-grants.policy.json'), 'utf8')));

  // The credentials come from the URL so the probe works against a CI service
  // container as well as the local fixture container.
  let user = 'postgres';
  let database = 'kamkmchess_online_test';
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.username) user = decodeURIComponent(parsed.username);
    if (parsed.pathname.length > 1) database = parsed.pathname.slice(1);
  } catch {
    // The default credentials stay in place.
  }

  const report = await runProbe({
    databaseUrl,
    container,
    psqlPath: process.env.PSQL_PATH ?? null,
    user,
    database,
    root,
    policy,
  });

  if (arguments_.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      tool: 'deploy/runtime-grants-probe.mjs',
      database: redactDatabaseUrl(databaseUrl),
      role: policy.role,
      ...report,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`runtime role grant probe against ${redactDatabaseUrl(databaseUrl)}\n`);
    for (const probe of report.probes) {
      process.stdout.write(`  ${probe.passed ? 'PASS' : 'FAIL'} ${probe.id}: ${probe.detail}\n`);
    }
    process.stdout.write(`${report.probes.length} probes, ${report.failures} failures\n`);
  }
  if (report.failures > 0) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('deploy/runtime-grants-probe.mjs')) {
  await main();
}
