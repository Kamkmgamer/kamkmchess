// Least-privilege runtime grant policy for the API's database role.
//
// The policy is explicit: every application table is listed with the exact
// privileges the runtime role needs. There is no blanket grant, no
// `GRANT ALL ON ALL TABLES` and no default privilege that would silently
// widen the role when a later migration adds a table.
//
// The check has three parts:
//
//   1. the migration files name the authoritative table set;
//   2. the Go writer's own statements name the verbs it uses per table;
//   3. the policy must grant every verb the writer uses, and must not grant a
//      verb the writer never uses.
//
// That makes the policy reviewable in a pull request and keeps it honest when
// another worker adds a table or a statement.
//
// Usage:
//   node deploy/runtime-grants.mjs --check          # policy against the tree
//   node deploy/runtime-grants.mjs --emit            # the SQL an operator runs
//   node deploy/runtime-grants.mjs --verify --database-url "$DATABASE_URL"

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const WRITE_VERBS = ['INSERT', 'UPDATE', 'DELETE'];
const ALL_VERBS = ['SELECT', ...WRITE_VERBS];

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
 * Returns the tables a migration reads inside a SQL function.
 *
 * A trigger or normalization function reads its tables with the privileges of
 * the invoking role, so the runtime role needs those privileges even though
 * no Go statement names the table.
 * @param {string} sql
 * @returns {string[]}
 */
export function parseMigrationReads(sql) {
  const reads = new Set();
  for (const match of sql.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    reads.add(match[1].toLowerCase());
  }
  return [...reads].sort();
}

/**
 * Returns the tables a migration file creates.
 * @param {string} sql
 * @returns {string[]}
 */
export function parseMigrationTables(sql) {
  const tables = new Set();
  const pattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const match of sql.matchAll(pattern)) {
    tables.add(match[1].toLowerCase());
  }
  return [...tables].sort();
}

/**
 * Returns the privileges a migration grants to a role.
 *
 * A migration that grants privileges can widen a role without any review, so
 * the audit reports it next to the reviewed policy.
 * @param {string} sql
 * @returns {{role: string, table: string, privileges: string[]}[]}
 */
export function parseMigrationGrants(sql) {
  /** @type {{role: string, table: string, privileges: string[]}[]} */
  const grants = [];
  const pattern = /GRANT\s+([A-Za-z,\s]+?)\s+ON\s+(?:TABLE\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s+TO\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const match of sql.matchAll(pattern)) {
    const privileges = (match[1] ?? '')
      .split(',')
      .map((part) => part.trim().toUpperCase())
      .filter((part) => part.length > 0);
    const table = (match[2] ?? '').split('.').pop()?.toLowerCase() ?? '';
    const role = match[3] ?? '';
    if (!table || !role) continue;
    grants.push({ role, table, privileges });
  }
  return grants;
}

/**
 * Returns the sequences a migration creates.
 * @param {string} sql
 * @returns {string[]}
 */
export function parseMigrationSequences(sql) {
  const sequences = new Set();
  for (const match of sql.matchAll(/CREATE\s+SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    sequences.add(match[1].toLowerCase());
  }
  return [...sequences].sort();
}

/**
 * Returns the functions a migration creates.
 *
 * A trigger function can only run as a trigger, so PostgreSQL refuses a direct
 * call. A plain function can be called by anyone who holds EXECUTE, and
 * PostgreSQL grants EXECUTE on a new function to PUBLIC.
 * @param {string} sql
 * @returns {{name: string, trigger: boolean}[]}
 */
export function parseMigrationFunctions(sql) {
  /** @type {{name: string, trigger: boolean}[]} */
  const functions = [];
  const pattern = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*RETURNS\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const match of sql.matchAll(pattern)) {
    functions.push({
      name: (match[1] ?? '').toLowerCase(),
      trigger: (match[2] ?? '').toLowerCase() === 'trigger',
    });
  }
  return functions;
}

/**
 * Strips Go comments and interpreted string literals so a scan does not match
 * prose. Raw string literals are kept: in Go they carry the SQL statements
 * this scan is looking for.
 * @param {string} source
 * @returns {string}
 */
export function stripGoLiterals(source) {
  let result = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '`') {
      const end = source.indexOf('`', index + 1);
      const literal = end < 0 ? source.slice(index) : source.slice(index, end + 1);
      result += literal;
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end;
      result += ' ';
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      result += ' ';
      continue;
    }
    if (character === '"') {
      let end = index + 1;
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\\') end += 1;
        end += 1;
      }
      result += '""';
      index = Math.min(end + 1, source.length);
      continue;
    }
    result += character;
    index += 1;
  }
  return result;
}

/**
 * Returns the statement verbs the Go writer uses per table.
 * @param {string} source
 * @returns {Map<string, Set<string>>}
 */
export function scanGoUsage(source) {
  const text = stripGoLiterals(source);
  const usage = new Map();
  /**
   * @param {string} table
   * @param {string} verb
   */
  const record = (table, verb) => {
    const name = table.toLowerCase();
    if (!usage.has(name)) usage.set(name, new Set());
    usage.get(name).add(verb);
  };
  for (const match of text.matchAll(/INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) record(match[1], 'INSERT');
  for (const match of text.matchAll(/DELETE\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) record(match[1], 'DELETE');
  for (const match of text.matchAll(/UPDATE\s+(?:ONLY\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:AS\s+)?[A-Za-z_][A-Za-z0-9_]*)?\s+SET\b/gi)) record(match[1], 'UPDATE');
  for (const match of text.matchAll(/\bFROM\s+(?:ONLY\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/gi)) record(match[1], 'SELECT');
  return usage;
}

/**
 * Normalizes a parsed policy.
 * @param {any} raw
 * @returns {{role: string, schema: string, privileges: Map<string, Set<string>>, rationale: Record<string, string>}}
 */
export function parsePolicy(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('policy is not an object');
  const privileges = new Map();
  for (const [table, verbs] of Object.entries(raw.privileges ?? {})) {
    if (!Array.isArray(verbs)) throw new Error(`policy entry ${table} is not a list of privileges`);
    const normalized = new Set();
    for (const verb of verbs) {
      const upper = String(verb).toUpperCase();
      if (upper === 'ALL') {
        throw new Error(`policy entry ${table} requests ALL privileges; the policy must list privileges one by one`);
      }
      if (!ALL_VERBS.includes(upper)) throw new Error(`policy entry ${table} names an unknown privilege ${verb}`);
      normalized.add(upper);
    }
    privileges.set(table.toLowerCase(), normalized);
  }
  return {
    role: String(raw.role ?? 'kamkmchess_runtime'),
    unusedRoles: Array.isArray(raw.unusedRoles) ? raw.unusedRoles.map((name) => String(name)) : [],
    functions: raw.functions && typeof raw.functions === 'object' ? raw.functions : {},
    schema: String(raw.schema ?? 'public'),
    privileges,
    rationale: raw.rationale ?? {},
  };
}

/**
 * Compares the policy with the migration tables and the writer's statements.
 * @param {{policy: ReturnType<typeof parsePolicy>, tables: string[], usage: Map<string, Set<string>>}} input
 * @returns {Finding[]}
 */
export function auditGrants({ policy, tables, usage, migrationGrants = [], sequences = [], functions = [], migrationReads = [] }) {
  const reads = new Set(migrationReads.map((table) => table.toLowerCase()));
  /** @type {Finding[]} */
  const findings = [];
  const migrated = new Set(tables.map((table) => table.toLowerCase()));
  const known = new Set([...migrated, ...policy.privileges.keys()]);

  for (const grant of migrationGrants) {
    const granted = policy.privileges.get(grant.table);
    if (grant.role === policy.role) {
      const extra = grant.privileges.filter((verb) => !granted || !granted.has(verb));
      if (extra.length > 0) {
        findings.push(finding(
          'blocker',
          'migration-grant-exceeds-policy',
          `A migration grants ${extra.join(', ')} on ${grant.table} to ${grant.role}, which the reviewed policy does not grant.`,
          `Remove the grant from the migration or extend the policy deliberately. The policy is the reviewed least-privilege contract.`,
        ));
      }
      continue;
    }
    findings.push(finding(
      'warning',
      'migration-grants-unreviewed-role',
      `A migration grants ${grant.privileges.join(', ')} on ${grant.table} to ${grant.role}, a role the deployment does not connect as.`,
      `The deployment connects as ${policy.role}. Provisioning revokes the privileges of the unused roles, so they cannot hold anything.`,
    ));
  }

  for (const sequence of sequences) {
    findings.push(finding(
      'blocker',
      'sequence-missing-grant',
      `The migration creates the sequence ${sequence}, which the policy does not grant.`,
      `Grant USAGE, SELECT and UPDATE on the sequence ${sequence} in the policy, or remove the sequence.`,
    ));
  }

  if (functions.length > 0) {
    const plain = functions.filter((entry) => !entry.trigger).map((entry) => entry.name);
    const triggerCount = functions.length - plain.length;
    findings.push(finding(
      'info',
      'trigger-functions-need-no-grant',
      `The migrations create ${triggerCount} guard function(s). PostgreSQL checks a trigger function's EXECUTE privilege when the trigger is created, and it refuses a direct call, so the runtime role needs no grant for them.`,
      null,
    ));
    for (const name of plain) {
      if (policy.functions?.[name]) {
        findings.push(finding(
          'info',
          'function-execute-reviewed',
          `The function ${name} can be called directly, so the policy revokes EXECUTE from PUBLIC and grants it to ${policy.role} only.`,
          null,
        ));
        continue;
      }
      findings.push(finding(
        'blocker',
        'function-public-execute',
        `The function ${name} is not a trigger function, so PostgreSQL lets anyone with EXECUTE call it directly, outside the write path that owns it. The policy does not cover it.`,
        `Add ${name} to the function section of the policy so the deployment revokes EXECUTE from PUBLIC.`,
      ));
    }
  }

  for (const table of [...migrated].sort()) {
    if (!policy.privileges.has(table)) {
      findings.push(finding(
        'blocker',
        'grant-missing-table',
        `The migration creates ${table}, but the runtime policy grants nothing on it. The API would fail on that table at run time.`,
        `Add ${table} to deploy/runtime-grants.policy.json with the privileges the writer uses.`,
      ));
    }
  }
  for (const table of [...policy.privileges.keys()].sort()) {
    if (!migrated.has(table)) {
      findings.push(finding(
        'warning',
        'grant-unknown-table',
        `The policy grants privileges on ${table}, which no migration creates. The grant statement would fail.`,
        'Remove the entry or add the migration that creates the table.',
      ));
    }
  }

  for (const [table, verbs] of [...usage.entries()].sort()) {
    if (!known.has(table)) continue;
    const granted = policy.privileges.get(table);
    if (!granted) continue;
    for (const verb of verbs) {
      if (granted.has(verb)) continue;
      const severity = verb === 'SELECT' ? 'warning' : 'blocker';
      findings.push(finding(
        severity,
        severity === 'blocker' ? 'grant-missing-privilege' : 'grant-missing-read',
        `The writer issues ${verb} on ${table}, but the runtime policy does not grant ${verb}.`,
        `Grant ${verb} on ${table}, or remove the statement.`,
      ));
    }
  }

  for (const [table, granted] of [...policy.privileges.entries()].sort()) {
    const used = usage.get(table);
    if (!used) {
      if (reads.has(table)) {
        // A SQL function reads the table with the privileges of the invoking
        // role, so the grant is required even without a Go statement.
        findings.push(finding(
          'info',
          'grant-used-by-migration-function',
          `The policy grants ${[...granted].join(', ')} on ${table}, which a migration function reads at run time.`,
          null,
        ));
        continue;
      }
      findings.push(finding(
        'warning',
        'grant-unused-table',
        `The policy grants ${[...granted].join(', ')} on ${table}, but no writer statement names that table.`,
        'Check whether the table is written by another component, or remove the grant.',
      ));
      continue;
    }
    for (const verb of granted) {
      if (used.has(verb)) continue;
      if (verb === 'SELECT') continue;
      findings.push(finding(
        'warning',
        'grant-unused-privilege',
        `The policy grants ${verb} on ${table}, but the writer never issues ${verb}.`,
        'Remove the privilege so the role stays least-privilege.',
      ));
    }
  }

  for (const [table, granted] of policy.privileges.entries()) {
    if (!granted.has('SELECT')) {
      findings.push(finding(
        'blocker',
        'grant-missing-select',
        `The policy does not grant SELECT on ${table}. No table can be read without it.`,
        `Grant SELECT on ${table}.`,
      ));
    }
  }

  return findings;
}

/**
 * Renders the SQL an operator runs. It is explicit per table and contains no
 * blanket grant.
 * @param {ReturnType<typeof parsePolicy>} policy
 * @param {{database?: string}} [options]
 * @returns {string}
 */
export function renderGrantSql(policy, options = {}) {
  const database = options.database ?? 'kamkmchess';
  const includeDatabaseGrants = options.includeDatabaseGrants !== false;
  const lines = [
    '-- Generated by deploy/runtime-grants.mjs. Review before running.',
    '-- One explicit statement per table. No blanket grant, no default privilege.',
  ];
  if (includeDatabaseGrants) {
    lines.push(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC;`);
    lines.push(`GRANT CONNECT ON DATABASE ${database} TO ${policy.role};`);
  }
  lines.push(
    `REVOKE CREATE ON SCHEMA ${policy.schema} FROM PUBLIC;`,
    `REVOKE ALL ON SCHEMA ${policy.schema} FROM PUBLIC;`,
    `GRANT USAGE ON SCHEMA ${policy.schema} TO ${policy.role};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${policy.schema} REVOKE ALL ON TABLES FROM PUBLIC;`,
  );
  for (const table of [...policy.privileges.keys()].sort()) {
    const granted = [...policy.privileges.get(table)].sort();
    lines.push(`REVOKE ALL ON TABLE ${policy.schema}.${table} FROM ${policy.role};`);
    lines.push(`GRANT ${granted.join(', ')} ON TABLE ${policy.schema}.${table} TO ${policy.role};`);
  }
  const functionNames = Object.keys(policy.functions ?? {}).sort();
  if (functionNames.length > 0) {
    const list = functionNames.map((name) => `'${name}'`).join(', ');
    lines.push('-- A function that is not a trigger function can be called directly. PostgreSQL');
    lines.push('-- grants EXECUTE on it to PUBLIC, so the deployment takes it away again.');
    lines.push('DO $kamkmchess$');
    lines.push('DECLARE entry record;');
    lines.push('BEGIN');
    lines.push(`  FOR entry IN SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '${policy.schema}' AND p.proname IN (${list}) LOOP`);
    lines.push(`    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', entry.signature);`);
    lines.push(`    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${policy.role}', entry.signature);`);
    lines.push('  END LOOP;');
    lines.push('END');
    lines.push('$kamkmchess$;');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Reads the granted privileges of one role from a live database.
 * @param {string} databaseUrl
 * @param {string} psqlPath
 * @param {string} role
 * @param {string} schema
 * @returns {Promise<Map<string, Set<string>>>}
 */
export async function readLiveGrants(databaseUrl, psqlPath, role, schema) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const query = [
    'SELECT table_name, privilege_type',
    "FROM information_schema.role_table_grants",
    `WHERE grantee = '${role.replace(/'/g, "''")}'`,
    `AND table_schema = '${schema.replace(/'/g, "''")}'`,
    'ORDER BY table_name, privilege_type;',
  ].join(' ');
  const { stdout } = await run(psqlPath, ['--no-psqlrc', '--tuples-only', '--no-align', '--field-separator', '|', '--command', query], {
    env: { ...process.env, PGPASSWORD: passwordOf(databaseUrl) },
    windowsHide: true,
  });
  /** @type {Map<string, Set<string>>} */
  const grants = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const [table, privilege] = line.split('|').map((part) => part.trim());
    if (!table || !privilege) continue;
    if (!grants.has(table.toLowerCase())) grants.set(table.toLowerCase(), new Set());
    grants.get(table.toLowerCase()).add(privilege.toUpperCase());
  }
  return grants;
}

/**
 * Extracts the password from a database URL for the psql environment.
 * @param {string} databaseUrl
 * @returns {string}
 */
export function passwordOf(databaseUrl) {
  try {
    return decodeURIComponent(new URL(databaseUrl).password);
  } catch {
    return '';
  }
}

/**
 * Compares the live grants with the policy.
 * @param {ReturnType<typeof parsePolicy>} policy
 * @param {Map<string, Set<string>>} live
 * @returns {Finding[]}
 */
export function auditLiveGrants(policy, live) {
  /** @type {Finding[]} */
  const findings = [];
  for (const [table, granted] of [...policy.privileges.entries()].sort()) {
    const actual = live.get(table);
    if (!actual) {
      findings.push(finding('blocker', 'live-grant-missing', `The runtime role has no grant on ${table}.`, 'Run the generated SQL.'));
      continue;
    }
    for (const verb of granted) {
      if (!actual.has(verb)) {
        findings.push(finding('blocker', 'live-grant-missing-privilege', `The runtime role is missing ${verb} on ${table}.`, 'Run the generated SQL.'));
      }
    }
    for (const verb of actual) {
      if (granted.has(verb)) continue;
      findings.push(finding('blocker', 'live-grant-extra', `The runtime role holds ${verb} on ${table}, which the policy does not grant.`, 'Revoke the extra privilege.'));
    }
  }
  for (const table of [...live.keys()].sort()) {
    if (policy.privileges.has(table)) continue;
    findings.push(finding('warning', 'live-grant-unknown-table', `The runtime role holds grants on ${table}, which the policy does not mention.`, 'Revoke the grants or extend the policy.'));
  }
  return findings;
}

/**
 * Lists the repository files that hold the writer's statements.
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function goSources(root) {
  const found = [];
  /**
   * @param {string} directory
   */
  const walk = async (directory) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.name.endsWith('.go')) continue;
      if (entry.name.endsWith('_test.go')) continue;
      found.push(path);
    }
  };
  await walk(join(root, 'backend'));
  await walk(join(root, 'cmd'));
  return found.sort();
}

/**
 * Loads the tree state the audit needs.
 * @param {string} root
 * @returns {Promise<{policy: ReturnType<typeof parsePolicy>, tables: string[], usage: Map<string, Set<string>>}>}
 */
export async function loadTree(root) {
  const policy = parsePolicy(JSON.parse(await readFile(join(root, 'deploy', 'runtime-grants.policy.json'), 'utf8')));
  const migrationDirectory = join(root, 'backend', 'migrations');
  /** @type {Set<string>} */
  const tables = new Set();
  /** @type {Set<string>} */
  const sequences = new Set();
  /** @type {{name: string, trigger: boolean}[]} */
  const functions = [];
  /** @type {{role: string, table: string, privileges: string[]}[]} */
  const migrationGrants = [];
  /** @type {Set<string>} */
  const migrationReads = new Set();
  for (const name of await readdir(migrationDirectory)) {
    if (!name.endsWith('.sql')) continue;
    const sql = await readFile(join(migrationDirectory, name), 'utf8');
    for (const table of parseMigrationTables(sql)) tables.add(table);
    for (const sequence of parseMigrationSequences(sql)) sequences.add(sequence);
    for (const fn of parseMigrationFunctions(sql)) functions.push(fn);
    for (const grant of parseMigrationGrants(sql)) migrationGrants.push(grant);
    for (const table of parseMigrationReads(sql)) migrationReads.add(table);
  }
  const usage = new Map();
  for (const file of await goSources(root)) {
    const found = scanGoUsage(await readFile(file, 'utf8'));
    for (const [table, verbs] of found) {
      if (!usage.has(table)) usage.set(table, new Set());
      for (const verb of verbs) usage.get(table).add(verb);
    }
  }
  return { policy, tables: [...tables].sort(), sequences: [...sequences].sort(), functions, migrationGrants, migrationReads: [...migrationReads].sort(), usage };
}

/**
 * Prints a report.
 * @param {Finding[]} findings
 */
function printFindings(findings) {
  for (const item of findings) {
    process.stdout.write(`  ${item.severity.toUpperCase().padEnd(8)} ${item.code}\n           ${item.message}\n`);
    if (item.remediation) process.stdout.write(`           fix: ${item.remediation}\n`);
  }
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const root = process.cwd();
  const { policy, tables, usage, migrationGrants, migrationReads, sequences, functions } = await loadTree(root);
  const findings = auditGrants({ policy, tables, usage, migrationGrants, sequences, functions, migrationReads });

  if (arguments_.includes('--emit')) {
    process.stdout.write(renderGrantSql(policy));
    return;
  }
  if (arguments_.includes('--propose')) {
    // The proposal names the privileges the writer uses for every table the
    // policy does not cover yet, so a new migration can be granted without
    // guessing. A reviewer still decides whether the proposal is right.
    for (const table of tables) {
      if (policy.privileges.has(table)) continue;
      const verbs = usage.get(table) ?? new Set(['SELECT']);
      process.stdout.write(`  "${table}": [${[...verbs].map((verb) => `"${verb}"`).join(', ')}],\n`);
    }
    return;
  }
  if (arguments_.includes('--verify')) {
    const index = arguments_.indexOf('--database-url');
    const databaseUrl = index >= 0 ? arguments_[index + 1] : process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('--verify needs --database-url');
    const psqlIndex = arguments_.indexOf('--psql');
    const psqlPath = psqlIndex >= 0 ? arguments_[psqlIndex + 1] : 'psql';
    try {
      const live = await readLiveGrants(databaseUrl, psqlPath, policy.role, policy.schema);
      findings.push(...auditLiveGrants(policy, live));
    } catch (error) {
      findings.push(finding('warning', 'live-verify-unavailable', `The live grant check could not run: ${error instanceof Error ? error.message : String(error)}`, 'Install psql or pass --psql.'));
    }
  }

  const blockers = findings.filter((item) => item.severity === 'blocker');
  process.stdout.write(`runtime grant audit: ${blockers.length === 0 ? 'clear' : 'blocked'} (${findings.length} findings)\n`);
  printFindings(findings);
  if (blockers.length > 0) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('deploy/runtime-grants.mjs')) {
  await main();
}
