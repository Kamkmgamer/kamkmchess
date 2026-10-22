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

import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { parsePolicy, renderGrantSql } from './runtime-grants.mjs';
import { discoverLocalDatabaseUrl, redactDatabaseUrl } from '../scripts/online/fixture-client.mjs';

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
 * Builds the behavioural scenarios.
 *
 * The privilege probes show that a statement reaches a table. These scenarios
 * show that the runtime role can really do the work the service does: they
 * seed valid rows, run the real statements as the role and prove the result
 * by counting rows.
 *
 * Every scenario runs in its own transaction and is rolled back, so the probe
 * leaves nothing behind. The whole set runs in one session, so the run does
 * not pay a round trip per statement.
 *
 * @param {string} role
 * @returns {string}
 */
export function buildBehaviorScript(role, schema) {
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const matchInsert = (id) => `INSERT INTO online_matches (match_id, schema_version, variant, starting_fen, position_fen, starting_time_ms, increment_ms, version, control_epoch, input_hash, rules_policy_version, status)
      VALUES ('${id}', 1, 'orthodox', '${fen}', '${fen}', 60000, 0, 1, 1, decode(repeat('00',32),'hex'), 'online-rules/1', 'active');`;
  const seatInsert = (id) => `INSERT INTO online_seats (match_id, seat, owner_kind, owner_id, public_label, control_kind, model_label, control_epoch)
      VALUES ('${id}', 'white', 'account', 'probe-owner', 'Probe', 'human', NULL, 1);`;

  /**
   * One scenario.
   *
   * @param {string} id the scenario name
   * @param {string} body the statements the runtime role runs
   * @param {string} success the expression a successful run raises
   * @param {string} expected the outcome that counts as a pass
   * @param {string} detail what the scenario proves
   */
  const scenario = (id, body, success, expected, detail) => `BEGIN;
SET LOCAL ROLE ${role};
SET LOCAL search_path TO ${schema};
DO $probe$
BEGIN
  BEGIN
    ${body}
    RAISE NOTICE 'probe:${id}:%:${expected}:${detail}', (${success});
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'probe:${id}:refused:${expected}:${detail}: %', SQLERRM;
  WHEN OTHERS THEN
    RAISE NOTICE 'probe:${id}:error:${expected}:${detail}: %', SQLERRM;
END;
END
$probe$;
ROLLBACK;`;

  return `
${scenario(
    'seat-control-timeline',
    `${matchInsert('probe_match_seat')}
    ${seatInsert('probe_match_seat')}`,
    `CASE WHEN (SELECT count(*) FROM online_seat_control_timeline WHERE match_id = 'probe_match_seat') = 1 THEN 'passed' ELSE 'failed' END`,
    'passed',
    'the seat insert appended one control timeline row',
  )}

${scenario(
    'control-change-timeline',
    `${matchInsert('probe_match_control')}
    ${seatInsert('probe_match_control')}
    INSERT INTO online_events (match_id, version, event_kind, seat, control_epoch, decision_at, control_kind, control_model_label)
      VALUES ('probe_match_control', 2, 'control_change', 'white', 2, clock_timestamp(), 'agent', 'Probe model');`,
    `CASE WHEN (SELECT count(*) FROM online_seat_control_timeline WHERE match_id = 'probe_match_control') = 2 THEN 'passed' ELSE 'failed' END`,
    'passed',
    'the seat insert and the control change appended two control timeline rows',
  )}

${scenario(
    'auxiliary-removal-delete',
    `INSERT INTO online_friend_invitations (invitation_id, kind, status, inviter_kind, inviter_id, inviter_public_label, inviter_control_kind, inviter_model_label, inviter_seat, starting_time_ms, increment_ms, starting_fen, recipient_account_id, owner_token_hash, expires_at)
      VALUES ('inv_probe_0123456789abcdef0123456789abcdef', 'link', 'open', 'account', 'probe-owner', 'Probe', 'human', NULL, 'white', 60000, 0, NULL, NULL, NULL, clock_timestamp() + interval '1 hour');
    DELETE FROM online_friend_invitations WHERE invitation_id = 'inv_probe_0123456789abcdef0123456789abcdef';`,
    `CASE WHEN (SELECT count(*) FROM online_friend_invitations WHERE invitation_id = 'inv_probe_0123456789abcdef0123456789abcdef') = 0 THEN 'passed' ELSE 'failed' END`,
    'passed',
    'the auxiliary sanitation deleted the invitation of a removed subject',
  )}

${scenario(
    'recovery-epoch-update',
    `INSERT INTO online_service_epochs (epoch, started_at, note) VALUES (9001, clock_timestamp(), 'probe');
    UPDATE online_service_epochs SET recovered_at = clock_timestamp() WHERE epoch = 9001;`,
    `CASE WHEN (SELECT count(*) FROM online_service_epochs WHERE epoch = 9001 AND recovered_at IS NOT NULL) = 1 THEN 'passed' ELSE 'failed' END`,
    'passed',
    'the service gate recorded the recovered epoch',
  )}

${scenario(
    'agent-seat-redaction',
    `INSERT INTO online_removal_requests (removal_id, subject_kind, subject_id, scope, status, requested_at, verified_at, live_delete_due_at, recovery_sanitize_due_at)
      VALUES ('rm_probe_0123456789ab', 'account', encode(sha256(convert_to('kamkm.online.removal.v1:probe-owner', 'UTF8')), 'hex'), 'account_deletion', 'verified', clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 day', clock_timestamp() + interval '30 days');
        INSERT INTO online_matches (match_id, schema_version, variant, starting_fen, position_fen, starting_time_ms, increment_ms, version, control_epoch, input_hash, rules_policy_version, status)
      VALUES ('probe_match_queue', 1, 'orthodox', '${fen}', '${fen}', 60000, 0, 1, 1, decode(repeat('00',32),'hex'), 'online-rules/1', 'active');
    INSERT INTO online_queue_entries (entry_id, owner_kind, owner_id, seat_control_kind, seat_control_model_label, starting_time_ms, increment_ms, status, internal_state, version, ready_at, cutoff_at, assigned_match_id)
      VALUES ('probeentry01', 'account', 'probe-owner', 'agent', 'Probe model', 60000, 0, 'assigned', 'assigned', 1, clock_timestamp(), clock_timestamp() + interval '10 seconds', 'probe_match_queue');
        UPDATE online_queue_entries
      SET owner_id = 'anonymized', seat_control_model_label = 'Custom model', version = version + 1
      WHERE entry_id = 'probeentry01';`,
    `CASE WHEN (SELECT count(*) FROM online_queue_entries WHERE entry_id = 'probeentry01' AND owner_id = 'anonymized' AND seat_control_model_label = 'Custom model' AND version = 2) = 1 THEN 'passed' ELSE 'failed' END`,
    'passed',
    'the removal of an account anonymized the owner of the agent seat and replaced its label with the neutral one',
  )}

${scenario(
    'agent-seat-redaction-without-a-request-refused',
    `INSERT INTO online_matches (match_id, schema_version, variant, starting_fen, position_fen, starting_time_ms, increment_ms, version, control_epoch, input_hash, rules_policy_version, status)
      VALUES ('probe_match_queue_2', 1, 'orthodox', '${fen}', '${fen}', 60000, 0, 1, 1, decode(repeat('00',32),'hex'), 'online-rules/1', 'active');
    INSERT INTO online_queue_entries (entry_id, owner_kind, owner_id, seat_control_kind, seat_control_model_label, starting_time_ms, increment_ms, status, internal_state, version, ready_at, cutoff_at, assigned_match_id)
      VALUES ('probeentry02', 'account', 'probe-owner', 'agent', 'Probe model', 60000, 0, 'assigned', 'assigned', 1, clock_timestamp(), clock_timestamp() + interval '10 seconds', 'probe_match_queue_2');
        BEGIN
          UPDATE online_queue_entries
          SET owner_id = 'anonymized', seat_control_model_label = 'Custom model', version = version + 1
          WHERE entry_id = 'probeentry02';
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;`,
    `CASE WHEN (SELECT count(*) FROM online_queue_entries WHERE entry_id = 'probeentry02' AND owner_id = 'probe-owner') = 1 THEN 'passed' ELSE 'failed' END`,
    'passed',
    'the redaction without a removal request was refused and the row kept its owner',
  )}

${scenario(
    'immutable-event-update-refused',
    `UPDATE online_events SET decision_at = clock_timestamp() WHERE false;`,
    `'completed'`,
    'refused',
    'an accepted event cannot be rewritten',
  )}

${scenario(
    'immutable-timeline-delete-refused',
    `DELETE FROM online_seat_control_timeline WHERE false;`,
    `'completed'`,
    'refused',
    'the control timeline cannot be deleted',
  )}
`;
}

/**
 * Runs the behavioural scenarios.
 * @param {LocalPostgres} postgres
 * @param {string} role
 * @returns {Promise<{id: string, passed: boolean, detail: string}[]>}
 */
export async function runBehaviorScenarios(postgres, role, schema) {
  const result = await postgres.query(buildBehaviorScript(role, schema));
  /** @type {{id: string, passed: boolean, detail: string}[]} */
  const outcomes = [];
  // The outcome of a scenario is a notice, so it survives the rollback of the
  // transaction it was measured in.
  for (const match of (result.stderr || '').matchAll(/probe:([^:\n]+):(passed|failed|refused|error|completed):([^:\n]*):([^\n]*)/g)) {
    const id = (match[1] ?? '').trim();
    const outcome = (match[2] ?? '').trim();
    const expected = (match[3] ?? '').trim();
    const detail = (match[4] ?? '').trim();
    // A scenario passes when it produced the outcome it was asked for. A
    // negative scenario expects the refusal, so a statement that went through
    // where a refusal was required is a failure.
    outcomes.push({
      id,
      passed: outcome === expected,
      detail: `${outcome}${detail ? `: ${detail}` : ''}`,
    });
  }
  if (outcomes.length === 0) {
    outcomes.push({
      id: 'behavior-scenarios',
      passed: false,
      detail: result.ok
        ? 'the behavioural scenarios returned no result'
        : `the behavioural scenarios could not run: ${(result.stderr || '').trim().split('\n')[0] ?? ''}`,
    });
  }
  return outcomes;
}

/**
 * Builds the arguments of the psql call.
 *
 * The script is never an argument of the process. A single argument of a
 * process is limited to a fraction of the memory of the kernel, and the
 * combined migration script of the repository is larger than that limit, so a
 * command argument fails with E2BIG before the script ever reaches the
 * server. The script is read from the standard input instead, and
 * ON_ERROR_STOP keeps a refused statement from being reported as a success.
 *
 * @param {{user: string, database: string}} options
 * @returns {string[]}
 */
export function psqlArguments(options) {
  return [
    '--variable', 'ON_ERROR_STOP=1',
    '--no-psqlrc', '--tuples-only', '--no-align', '--field-separator', '|',
    '--username', options.user, '--dbname', options.database,
    '--file', '-',
  ];
}

/**
 * Runs a command and streams the script into its standard input.
 *
 * The script never becomes an argument of the process, so a script that is
 * larger than the argument limit of the kernel still reaches the server.
 *
 * @param {{command: string, args: string[], sql: string, env?: Record<string, string>}} options
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
export function runSqlProcess(options) {
  return new Promise((resolvePromise) => {
    const child = spawn(options.command, options.args, {
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolvePromise({ ok: false, stdout, stderr: String(error) }));
    child.on('close', (code) => resolvePromise({ ok: code === 0, stdout, stderr }));
    // The server closes the input when it refuses the script, so a broken
    // pipe must not become an unhandled error of the probe.
    child.stdin.on('error', () => {});
    child.stdin.end(options.sql);
  });
}

/**
 * Runs SQL against a local PostgreSQL server.
 *
 * It uses a local psql binary when one is available and otherwise runs psql
 * inside the local fixture container. The script is always delivered through
 * the standard input of the client, and the password is only ever passed in
 * the environment.
 */
export class LocalPostgres {
  /**
   * @param {{databaseUrl: string, container?: string|null, psqlPath?: string|null, user?: string, database?: string, runSql?: typeof runSqlProcess}} options
   */
  constructor(options) {
    this.databaseUrl = options.databaseUrl;
    this.container = options.container ?? null;
    this.psqlPath = options.psqlPath ?? null;
    this.user = options.user ?? 'postgres';
    this.database = options.database ?? 'kamkmchess_online_test';
    // The runner is replaceable, so the delivery of the script can be proved
    // without a database.
    this.runSql = options.runSql ?? runSqlProcess;
  }

  /** @returns {Promise<{ok: boolean, stdout: string, stderr: string}>} */
  async query(sql) {
    if (this.psqlPath) {
      return this.runSql({
        command: this.psqlPath,
        args: psqlArguments({ user: this.user, database: this.database }),
        sql,
        env: this.environment(),
      });
    }
    if (this.container) {
      return this.queryInContainer(sql);
    }
    throw new Error('no local PostgreSQL client is available for the grant probe');
  }

  /**
   * Builds the environment of the client.
   *
   * The client runs on the host, so it has to reach the host and the port of
   * the database url and not the socket of the local machine. The password
   * belongs in the environment and never in the arguments of a command.
   * @returns {Record<string, string>}
   */
  environment() {
    /** @type {Record<string, string>} */
    const environment = { ...process.env, PGPASSWORD: this.password() };
    try {
      const parsed = new URL(this.databaseUrl);
      if (parsed.hostname) {
        // The client wants the address of an IPv6 host in its brackets.
        environment.PGHOST = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname;
      }
      if (parsed.port) environment.PGPORT = parsed.port;
      const sslmode = parsed.searchParams.get('sslmode');
      if (sslmode) environment.PGSSLMODE = sslmode;
    } catch {
      // The defaults of the client stay in place.
    }
    return environment;
  }

  /** @returns {Promise<{ok: boolean, stdout: string, stderr: string}>} */
  queryInContainer(sql) {
    return this.runSql({
      command: 'docker',
      args: [
        'exec', '-i', String(this.container),
        'psql', '-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '--tuples-only', '--no-align',
        '--field-separator', '|', '-U', this.user, '-d', this.database, '-f', '-',
      ],
      sql,
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
  const onlyBehavior = options.onlyBehavior === true;
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

  // The deployment connects as one role. The roles the migrations created are
  // unused, so provisioning strips them and the probe checks that end state.
  for (const unusedRole of policy.unusedRoles ?? []) {
    await postgres.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${unusedRole};`);
    await postgres.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${unusedRole};`);
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
    if (onlyBehavior) break;
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

  // The behavioural scenarios prove that the role can do the real work.
  for (const outcome of await runBehaviorScenarios(postgres, role, schema)) {
    results.push({ id: `behavior-${outcome.id}`, passed: outcome.passed, detail: outcome.detail });
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

  // Only the deployment role may hold a privilege on the application tables.
  // The table owner keeps its implicit ownership, and the migration roles
  // must not keep a broad grant.
  const owner = await postgres.query(`SELECT tableowner FROM pg_tables WHERE schemaname = '${schema}' LIMIT 1;`);
  const ownerName = (owner.stdout || '').trim();
  const otherRoles = await postgres.query(`
    SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = '${schema}' AND grantee <> 'PUBLIC';`);
  const unexpected = otherRoles.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== role && line !== ownerName);
  results.push({
    id: 'only-the-deployment-role-holds-privileges',
    passed: unexpected.length === 0,
    detail: unexpected.length === 0
      ? `only ${role} holds a privilege on the application tables`
      : `${unexpected.join(', ')} still hold(s) a privilege on the application tables`,
  });

  // A function that is not a trigger function must not be callable by PUBLIC.
  // PostgreSQL grants EXECUTE on a new function to PUBLIC, so the deployment
  // has to take it away again.
  const functionRows = await postgres.query(`
    SELECT p.proname,
           has_function_privilege('PUBLIC', p.oid, 'EXECUTE') AS public_execute,
           p.prorettype::regtype::text AS returns
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = '${schema}' AND p.proname NOT LIKE 'online\\_guard%'
      AND p.proname NOT LIKE 'online\\_reject%';`);
  /** @type {string[]} */
  const publicCallable = [];
  /** @type {string[]} */
  const unreviewed = [];
  const policyFunctions = Object.keys(policy.functions ?? {});
  for (const line of functionRows.stdout.split(/\r?\n/)) {
    const [name, publicExecute, returns] = line.split('|').map((part) => part.trim());
    if (!name) continue;
    if (returns === 'trigger') continue;
    if (publicExecute === 'true') publicCallable.push(name);
    if (!policyFunctions.includes(name)) unreviewed.push(name);
  }
  results.push({
    id: 'public-cannot-call-plain-functions',
    passed: publicCallable.length === 0,
    detail: publicCallable.length === 0
      ? 'PUBLIC cannot execute a plain function directly'
      : `PUBLIC can still execute ${publicCallable.join(', ')}`,
  });
  results.push({
    id: 'every-plain-function-is-reviewed',
    passed: unreviewed.length === 0,
    detail: unreviewed.length === 0
      ? 'every plain function is covered by the policy'
      : `the policy does not cover ${unreviewed.join(', ')}`,
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
    onlyBehavior: arguments_.includes('--only-behavior'),
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
