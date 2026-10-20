// Backup coverage and removal-ledger audit.
//
// A backup is only useful if it covers every table that holds live data, and
// a restore is only safe if the newest removal ledger is applied before the
// restored database serves traffic.
//
// This audit answers both questions from the repository:
//
//   1. does the dump cover the whole database, so every migrated table is in
//      the bundle?
//   2. does the restore path reapply the deletion ledger, including the
//      online removal markers, before the restored copy is used?
//
// It also prints the runbook hooks an operator must follow. It never restores,
// never connects to a hosted database and never claims a rehearsal happened.
//
// Usage:
//   node scripts/online/backup-coverage.mjs [--root DIR] [--json]

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { parseMigrationTables } from '../../deploy/runtime-grants.mjs';

/**
 * @typedef {'blocker'|'warning'|'info'} Severity
 * @typedef {{ severity: Severity, code: string, message: string, remediation: string|null }} Finding
 */

/** Tables that carry the removal ledger. */
export const REMOVAL_LEDGER_TABLES = ['deletion_tombstones', 'online_deletion_markers'];

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
 * Returns every table the migrations create.
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export async function migrationTables(root) {
  const directory = join(root, 'backend', 'migrations');
  /** @type {Set<string>} */
  const tables = new Set();
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.sql')) continue;
    for (const table of parseMigrationTables(await readFile(join(directory, name), 'utf8'))) {
      tables.add(table);
    }
  }
  return [...tables].sort();
}

/**
 * @param {string} root
 * @returns {Promise<{tables: string[], dumpIsFullDatabase: boolean, dumpFilters: string[], restoresGameLedger: boolean, restoresOnlineLedger: boolean, planRecoveryUsed: boolean, runbookMentionsLedger: boolean}>}
 */
export async function inspectBackup(root) {
  const pgtools = await readFile(join(root, 'backend', 'backup', 'cmd', 'khabackup', 'pgtools.go'), 'utf8');
  const main = await readFile(join(root, 'backend', 'backup', 'cmd', 'khabackup', 'main.go'), 'utf8');
  const backup = await readFile(join(root, 'backend', 'backup', 'backup.go'), 'utf8');
  const restore = await readFile(join(root, 'backend', 'backup', 'restore.go').replace(/\\/g, '/'), 'utf8').catch(() => '');
  const runbook = await readFile(join(root, 'docs', 'implementation', 'MVP-operations.md'), 'utf8').catch(() => '');

  const dumpArguments = pgtools.match(/arguments := \[\]string\{[^}]*\}/)?.[0] ?? '';
  const dumpFilters = [...dumpArguments.matchAll(/--table[= ]"?([A-Za-z0-9_]+)"?/g)].map((match) => match[1]);
  const dumpIsFullDatabase = /pg_dump|--format=plain/.test(pgtools) && dumpFilters.length === 0;

  const restoresGameLedger = /deletion_tombstones/.test(pgtools) || /deletion_tombstones/.test(backup);
  const restoresOnlineLedger = /online_deletion_markers/.test(pgtools + backup + restore + main);
  const planRecoveryUsed = /PlanDeletionRecovery|PlanRestore/.test(main + backup + restore);
  const runbookMentionsLedger = /newer-ledger|ledger/i.test(runbook);

  return {
    tables: await migrationTables(root),
    dumpIsFullDatabase,
    dumpFilters,
    restoresGameLedger,
    restoresOnlineLedger,
    planRecoveryUsed,
    runbookMentionsLedger,
  };
}

/**
 * Audits the backup coverage.
 * @param {Awaited<ReturnType<typeof inspectBackup>>} state
 * @returns {Finding[]}
 */
export function auditBackup(state) {
  /** @type {Finding[]} */
  const findings = [];
  if (!state.dumpIsFullDatabase) {
    findings.push(finding(
      'blocker',
      'dump-not-full-database',
      state.dumpFilters.length > 0
        ? `The dump filters tables (${state.dumpFilters.join(', ')}), so a table outside the filter is not in the bundle.`
        : 'The dump does not look like a full logical database export.',
      'Dump the whole database so every migrated table is covered.',
    ));
  } else {
    findings.push(finding(
      'info',
      'dump-covers-database',
      `The export dumps the whole database, so all ${state.tables.length} migrated tables are covered.`,
      null,
    ));
  }
  if (!state.restoresGameLedger) {
    findings.push(finding(
      'blocker',
      'game-ledger-not-reapplied',
      'The restore path does not reapply the game deletion ledger, so a restored copy can resurrect a deleted game.',
      'Apply the deletion ledger inside the restore transaction.',
    ));
  } else {
    findings.push(finding('info', 'game-ledger-reapplied', 'The restore path reapplies the game deletion ledger.', null));
  }
  if (!state.restoresOnlineLedger) {
    findings.push(finding(
      'blocker',
      'online-removal-ledger-uncovered',
      'The restore path does not reapply the online removal markers, so a restored copy can publish a replay whose erasure was requested.',
      'Extend the backup ledger to the online removal markers and reapply them with the newest bundle before the restored copy serves traffic.',
    ));
  } else {
    findings.push(finding('info', 'online-removal-ledger-reapplied', 'The restore path reapplies the online removal markers.', null));
  }
  if (!state.planRecoveryUsed) {
    findings.push(finding(
      'blocker',
      'restore-plan-missing',
      'The restore command does not plan the deletion recovery, so an operator cannot review what a restore would resurrect before it runs.',
      'Plan the deletion recovery and print it before applying a restore.',
    ));
  }
  if (!state.runbookMentionsLedger) {
    findings.push(finding(
      'warning',
      'runbook-ledger-step-missing',
      'The operations runbook does not document the ledger step, so an operator can restore without reapplying the removal ledger.',
      'Document the ledger step in docs/implementation/MVP-operations.md.',
    ));
  }
  for (const table of REMOVAL_LEDGER_TABLES) {
    if (!state.tables.includes(table)) {
      findings.push(finding(
        'warning',
        'ledger-table-missing',
        `The removal ledger table ${table} is not created by the migrations, so no ledger can be carried by a backup.`,
        'Add the migration that creates the table.',
      ));
    }
  }
  return findings;
}

/**
 * Returns the runbook hooks an operator follows for a restore.
 * @param {Awaited<ReturnType<typeof inspectBackup>>} state
 * @returns {{steps: string[], commands: string[], warnings: string[]}}
 */
export function restoreRunbookHooks(state) {
  return {
    steps: [
      'Restore into a separate database. Never point a rehearsal at the live database.',
      'Apply the newest deletion ledger of every newer daily bundle with --newer-ledger before the restored copy serves traffic.',
      'Verify that no removed replay and no deleted game is readable in the restored copy.',
      'Only then cut traffic over, and record the bundle labels that were applied.',
    ],
    commands: [
      'khabackup restore --file <bundle> --database-url-env DATABASE_URL --passphrase-env KHA_BACKUP_PASSPHRASE --newer-ledger <newer bundle> --apply',
      'khabackup plan --file <bundle> --database-url-env DATABASE_URL --passphrase-env KHA_BACKUP_PASSPHRASE --newer-ledger <newer bundle>',
    ],
    warnings: state.restoresOnlineLedger
      ? []
      : [
        'The online removal markers are not reapplied by the current restore command. An online replay whose erasure was requested can come back with an old bundle.',
      ],
  };
}

/**
 * Runs the audit.
 * @param {string} root
 * @returns {Promise<{findings: Finding[], hooks: ReturnType<typeof restoreRunbookHooks>, tables: string[]}>}
 */
export async function auditBackupCoverage(root) {
  const state = await inspectBackup(root);
  return {
    findings: auditBackup(state),
    hooks: restoreRunbookHooks(state),
    tables: state.tables,
  };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const rootIndex = arguments_.indexOf('--root');
  const root = rootIndex >= 0 ? arguments_[rootIndex + 1] : process.cwd();
  const report = await auditBackupCoverage(root);
  if (arguments_.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      tool: 'scripts/online/backup-coverage.mjs',
      mode: 'repository-files-only',
      disclaimer: 'This audit reads the repository only. It does not restore, does not connect to a hosted database and certifies no rehearsal.',
      ...report,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`backup coverage: ${report.tables.length} migrated tables\n`);
    for (const item of report.findings) {
      process.stdout.write(`  ${item.severity.toUpperCase().padEnd(8)} ${item.code}\n           ${item.message}\n`);
      if (item.remediation) process.stdout.write(`           fix: ${item.remediation}\n`);
    }
    process.stdout.write('\nrestore hooks:\n');
    for (const step of report.hooks.steps) process.stdout.write(`  - ${step}\n`);
    for (const warning of report.hooks.warnings) process.stdout.write(`  ! ${warning}\n`);
  }
  if (report.findings.some((item) => item.severity === 'blocker')) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/online/backup-coverage.mjs')) {
  await main();
}
