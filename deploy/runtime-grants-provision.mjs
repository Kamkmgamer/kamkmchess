// The deployment renders the grants of the policy a second time.
//
// `deploy/runtime-grants.mjs` renders the reviewed SQL for the operator and
// for the grant probe, and `deploy/provision-runtime.py` writes the SQL of the
// provisioning run by hand. Two renderers of one policy can drift apart, and
// a policy entry the Python routine does not render leaves the runtime role
// without a privilege: every write of that class fails at run time while the
// gates, which apply the Node renderer, stay green.
//
// This module closes that gap. It captures the statements the **actual**
// provisioning routine emits and compares them with the statements of the
// reviewed renderer, which is rendered from the reviewed policy.
//
// The comparison is a comparison of canonical statements, not a comparison of
// raw text: the two renderers break the same statement over different lines.
// The provisioning routine applies everything the reviewed renderer applies
// and it applies the defensive revokes of `INTENTIONAL_DEFENSIVE_REVOKES` on
// top of it. Those extra revokes are deliberate, they are listed explicitly,
// and a statement that is neither of the two is a blocker.
//
// Usage:
//   node deploy/runtime-grants-provision.mjs            # the gate of the pull request
//   node deploy/runtime-grants-provision.mjs --json     # the findings as JSON

import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { parsePolicy, renderGrantSql } from './runtime-grants.mjs';

/**
 * The statements the provisioning routine emits on purpose and the reviewed
 * renderer does not.
 *
 * Every entry is a revoke that takes a privilege away. They are the defence
 * of the deployment against the defaults of PostgreSQL and against the broad
 * grants of the migrations: the defaults of the tables, of the sequences and
 * of the functions go to PUBLIC, the migrations grant the tables of the
 * application to the roles the deployment does not connect as, and PUBLIC
 * holds the usage of the sequence of the checkpoints.
 *
 * The list is explicit on purpose. A statement that is not in it is a
 * blocker, so a change of the provisioning routine is reviewed in the pull
 * request instead of passing unnoticed.
 */
export const INTENTIONAL_DEFENSIVE_REVOKES = [
  'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC',
  'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC',
  'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC',
  'REVOKE ALL ON SEQUENCE public.online_service_health_order FROM PUBLIC',
  'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM kamkm_online_api',
  'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM kamkm_online_api',
  'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM kamkm_online_api',
  'REVOKE ALL ON SCHEMA public FROM kamkm_online_api',
  'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM kamkm_online_rules',
  'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM kamkm_online_rules',
  'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM kamkm_online_rules',
  'REVOKE ALL ON SCHEMA public FROM kamkm_online_rules',
];

/**
 * @typedef {'blocker'|'warning'|'info'} Severity
 * @typedef {{ severity: Severity, code: string, message: string, remediation: string|null }} Finding
 */

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
 * Splits a SQL script into its statements.
 *
 * A quoted literal may hold a semicolon, so the split follows the quoting,
 * and a line comment holds no statement and is dropped.
 * @param {string} sql
 * @returns {string[]}
 */
export function splitSqlStatements(sql) {
  /** @type {string[]} */
  const statements = [];
  let current = '';
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (character === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index);
      index = end < 0 ? sql.length : end;
      continue;
    }
    if (character === "'" || character === '"' || character === '$') {
      const end = closingLiteral(sql, index, character);
      current += sql.slice(index, end);
      index = end;
      continue;
    }
    if (character === ';') {
      statements.push(current);
      current = '';
      index += 1;
      continue;
    }
    current += character;
    index += 1;
  }
  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

/**
 * Returns the index after the literal that starts at the given index.
 *
 * A single quoted literal escapes its quote by doubling it, a dollar quoted
 * block ends at its own tag.
 * @param {string} sql
 * @param {number} start
 * @param {string} character
 * @returns {number}
 */
function closingLiteral(sql, start, character) {
  if (character === '$') {
    const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(start));
    if (!tag) return start + 1;
    const end = sql.indexOf(tag[0], start + tag[0].length);
    return end < 0 ? sql.length : end + tag[0].length;
  }
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === character) {
      if (sql[index + 1] === character) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

/**
 * Reduces a statement to the comparable form.
 *
 * The two renderers break the same statement over different lines, so the
 * white space is collapsed and the terminator is dropped. The case is kept,
 * because both renderers write the keywords in upper case and the names in
 * lower case.
 * @param {string} statement
 * @returns {string}
 */
export function canonicalStatement(statement) {
  return statement.replace(/\s+/g, ' ').trim().replace(/;$/, '').trim();
}

/**
 * Compares the statements of the provisioning routine with the statements of
 * the reviewed renderer.
 *
 * The provisioning routine applies everything the reviewed renderer applies,
 * and it applies the defensive revokes of `INTENTIONAL_DEFENSIVE_REVOKES` on
 * top of it. A statement on either side that is not accounted for is a
 * blocker.
 * @param {{provisionStatements: string[], renderedStatements: string[]}} input
 * @returns {Finding[]}
 */
export function auditProvisionStatements({ provisionStatements, renderedStatements }) {
  /** @type {Finding[]} */
  const findings = [];
  const provision = new Set(provisionStatements.map(canonicalStatement));
  const rendered = new Set(renderedStatements.map(canonicalStatement));
  for (const statement of rendered) {
    if (provision.has(statement)) continue;
    findings.push(finding(
      'blocker',
      'provision-renderer-statement-missing',
      `The provisioning routine does not apply the statement of the reviewed renderer: ${statement}`,
      'Apply the statement in deploy/provision-runtime.py, or remove it from the reviewed renderer.',
    ));
  }
  for (const statement of provision) {
    if (rendered.has(statement)) continue;
    if (INTENTIONAL_DEFENSIVE_REVOKES.includes(statement)) continue;
    findings.push(finding(
      'blocker',
      'provision-unreviewed-statement',
      `The provisioning routine applies a statement that the reviewed renderer does not apply and that is not an intentional defensive revoke: ${statement}`,
      'Add the statement to INTENTIONAL_DEFENSIVE_REVOKES after reviewing it, or remove it from deploy/provision-runtime.py.',
    ));
  }
  for (const statement of INTENTIONAL_DEFENSIVE_REVOKES) {
    if (provision.has(statement)) continue;
    findings.push(finding(
      'blocker',
      'provision-defensive-revoke-missing',
      `The provisioning routine does not apply the intentional defensive revoke: ${statement}`,
      'Apply the statement in deploy/provision-runtime.py, or remove it from INTENTIONAL_DEFENSIVE_REVOKES.',
    ));
  }
  return findings;
}

/**
 * Returns the interpreter that runs the provisioning routine.
 *
 * The name of the interpreter differs between the hosts: a Linux image carries
 * python3 and no python alias, while a Windows host often carries only
 * python. A candidate is used only when it really is Python 3, because a host
 * may also carry an alias that opens the store instead of running the script.
 * @returns {string}
 */
export function findPythonInterpreter() {
  const refused = [];
  for (const name of ['python3', 'python']) {
    const probe = spawnSync(name, ['-c', 'import sys; sys.stdout.write(str(sys.version_info[0]))'], { encoding: 'utf8', windowsHide: true });
    if (probe.error) {
      refused.push(`${name} is not on the PATH`);
      continue;
    }
    if (probe.status !== 0 || (probe.stdout ?? '').trim() !== '3') {
      refused.push(`${name} is not a Python 3 interpreter`);
      continue;
    }
    return name;
  }
  throw new Error(`the provisioning gate needs a Python 3 interpreter: ${refused.join('; ')}`);
}

/**
 * Captures the statements the real provisioning routine emits.
 *
 * The routine runs against a database, so the capture replaces the database
 * call with a recorder and isolates the migration subprocess and the change
 * of the working directory. The grants are rendered by the routine itself, so
 * the capture is the deployment and not an approximation of it.
 * @param {{root: string, python: string}} input
 * @returns {Promise<string[]>}
 */
export async function captureProvisionSql({ root, python }) {
  const directory = await mkdtemp(join(tmpdir(), 'provision-capture-'));
  try {
    await writeFile(join(directory, 'runtime.env'), 'DATABASE_URL=postgres://unused:capture@127.0.0.1:5432/unused?sslmode=disable\n');
    await writeFile(join(directory, 'api.env'), '');
    await writeFile(join(directory, 'backup.env'), 'DATABASE_URL=postgres://unused:capture@127.0.0.1:5432/unused?sslmode=disable\n');
    await copyFile(join(root, 'deploy', 'runtime-grants.policy.json'), join(directory, 'runtime-grants.policy.json'));
    const result = spawnSync(
      python,
      ['-B', join(root, 'deploy', 'capture-provision-sql.py'), join(root, 'deploy', 'provision-runtime.py')],
      { cwd: directory, encoding: 'utf8', windowsHide: true },
    );
    if (result.error) throw new Error(`run the provisioning routine: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`run the provisioning routine: ${(result.stderr || '').trim().split('\n')[0] ?? ''}`);
    }
    /** @type {string[]} */
    let blocks;
    try {
      blocks = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`read the statements of the provisioning routine: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new Error('the provisioning routine emitted no statement');
    }
    // The routine hands the statements to the database in blocks, and a block
    // holds several statements.
    return blocks.flatMap((block) => splitSqlStatements(block));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Runs the whole gate: the capture of the real routine and the comparison
 * with the reviewed renderer of the policy.
 * @param {{root: string, python?: string}} input
 * @returns {Promise<{findings: Finding[], statements: string[], rendered: string[]}>}
 */
export async function auditProvisioning({ root, python }) {
  const policy = parsePolicy(JSON.parse(await readFile(join(root, 'deploy', 'runtime-grants.policy.json'), 'utf8')));
  const statements = await captureProvisionSql({ root, python: python ?? findPythonInterpreter() });
  const rendered = splitSqlStatements(renderGrantSql(policy));
  return { findings: auditProvisionStatements({ provisionStatements: statements, renderedStatements: rendered }), statements, rendered };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const root = process.cwd();
  const { findings } = await auditProvisioning({ root });
  const blockers = findings.filter((item) => item.severity === 'blocker');
  if (arguments_.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ findings, blockers: blockers.length })}\n`);
  } else {
    process.stdout.write(`provisioning grant audit: ${blockers.length === 0 ? 'clear' : 'blocked'} (${findings.length} findings)\n`);
    for (const item of findings) {
      process.stdout.write(`  ${item.severity.toUpperCase().padEnd(8)} ${item.code}\n           ${item.message}\n`);
      if (item.remediation) process.stdout.write(`           fix: ${item.remediation}\n`);
    }
  }
  if (blockers.length > 0) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('deploy/runtime-grants-provision.mjs')) {
  await main();
}
