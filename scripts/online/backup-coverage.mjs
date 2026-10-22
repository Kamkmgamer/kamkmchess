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
 * Removes the comments of a Go source.
 *
 * The length of the source is preserved, so every position of the result is
 * the position of the original. A comment never runs the code, so a scan that
 * reads the comments reads text the compiler ignores.
 * @param {string} source
 * @param {boolean} [keepStrings] when false the string literals are removed too
 * @returns {string}
 */
export function stripGoComments(source, keepStrings = true) {
  const out = source.split('');
  let index = 0;
  const blank = (from, to) => {
    for (let cursor = from; cursor < to && cursor < source.length; cursor += 1) {
      if (source[cursor] !== '\n') out[cursor] = ' ';
    }
  };
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      blank(index, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      const end = close === -1 ? source.length : close + 2;
      blank(index, end);
      index = end;
      continue;
    }
    if (char === '"' || char === '`' || char === "'") {
      const quote = char;
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === '\\' && quote !== '`') {
          cursor += 2;
          continue;
        }
        if (source[cursor] === quote) break;
        cursor += 1;
      }
      const end = Math.min(cursor + 1, source.length);
      if (!keepStrings) blank(index + 1, end - 1);
      index = end;
      continue;
    }
    index += 1;
  }
  return out.join('');
}

/**
 * Reads the functions of a Go source.
 *
 * Only the top level functions are read, and only their bodies. A method of a
 * type is read as a function of its own name, which is enough to follow the
 * calls of the restore path.
 * @param {string} source
 * @returns {Map<string, {name: string, start: number, end: number, body: string}>}
 */
export function goFunctions(source) {
  const stripped = stripGoComments(source, false);
  /** @type {Map<string, {name: string, start: number, end: number, body: string}>} */
  const functions = new Map();
  const pattern = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
  let match = pattern.exec(stripped);
  while (match !== null) {
    const open = stripped.indexOf('{', pattern.lastIndex);
    if (open === -1) break;
    let depth = 0;
    let close = -1;
    for (let index = open; index < stripped.length; index += 1) {
      const char = stripped[index];
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    if (close === -1) break;
    functions.set(match[1], { name: match[1], start: open + 1, end: close, body: stripped.slice(open + 1, close) });
    pattern.lastIndex = close;
    match = pattern.exec(stripped);
  }
  return functions;
}

/**
 * Finds the parenthesis that closes the one at the given index.
 * @param {string} body
 * @param {number} index the index of the opening parenthesis
 * @returns {number} the index of the closing parenthesis, -1 when there is none
 */
function matchParenthesis(body, index) {
  let depth = 0;
  for (let cursor = index; cursor < body.length; cursor += 1) {
    const char = body[cursor];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

/**
 * Splits an argument list at its top level commas.
 * @param {string} text
 * @returns {string[]}
 */
function splitArguments(text) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/**
 * Reads the calls of a function body.
 *
 * A call is a receiver, a method and the arguments. The position of the call
 * is the position of the receiver in the source, so two calls can be ordered.
 * @param {string} body
 * @param {number} offset the position of the body in the source
 * @returns {{receiver: string, method: string, position: number, args: string[]}[]}
 */
function methodCalls(body, offset) {
  /** @type {{receiver: string, method: string, position: number, args: string[]}[]} */
  const calls = [];
  const pattern = /([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match = pattern.exec(body);
  while (match !== null) {
    const open = match.index + match[0].length - 1;
    const close = matchParenthesis(body, open);
    calls.push({
      receiver: match[1],
      method: match[2],
      position: offset + match.index,
      args: close === -1 ? [] : splitArguments(body.slice(open + 1, close)),
    });
    match = pattern.exec(body);
  }
  return calls;
}

/**
 * Reads the calls of a function body that name a function of the file.
 * @param {string} body
 * @param {number} offset
 * @returns {{name: string, position: number, args: string[]}[]}
 */
function plainCalls(body, offset) {
  /** @type {{name: string, position: number, args: string[]}[]} */
  const calls = [];
  const pattern = /(?<![A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match = pattern.exec(body);
  while (match !== null) {
    const open = match.index + match[0].length - 1;
    const close = matchParenthesis(body, open);
    calls.push({
      name: match[1],
      position: offset + match.index,
      args: close === -1 ? [] : splitArguments(body.slice(open + 1, close)),
    });
    match = pattern.exec(body);
  }
  return calls;
}

/**
 * Verifies that the restore path replays the current removal ledger.
 *
 * A text search cannot answer this. The interface of the removal sink names
 * the same method as the call that does the work, so a restore that never
 * calls it still carries the name, and a search over the whole file still
 * finds it. This verifier reads the functions of the file, follows the calls
 * the restore makes, and reports the replay calls it finds, where they sit and
 * what they replay.
 *
 * It answers four questions about the restore path:
 *
 *   1. does the restore replay the online removal ledger at all?
 *   2. does it replay the merged ledger, and not the ledger of the bundle?
 *   3. does the replay happen after the import of the export?
 *   4. does the replay happen before the restore gate is released?
 *
 * A question the verifier cannot answer is a failure, never a pass.
 * @param {string} source the source of backend/backup/backup.go
 * @returns {{restoreFound: boolean, appliesTombstones: boolean, appliesRemovalRecords: boolean, appliesSubjectRemovalRecords: boolean, replaysMergedLedger: boolean, replayAfterImport: boolean, replayBeforeGateRelease: boolean, replayBeforeFenceClose: boolean, problems: string[]}}
 */
export function verifyRestoreReplay(source) {
  /** @type {string[]} */
  const problems = [];
  const functions = goFunctions(source);
  const restore = functions.get('Restore');
  if (!restore) {
    problems.push('the restore function was not found in the backup package');
    return {
      restoreFound: false,
      appliesTombstones: false,
      appliesRemovalRecords: false,
      appliesSubjectRemovalRecords: false,
      replaysMergedLedger: false,
      replayAfterImport: false,
      replayBeforeGateRelease: false,
      replayBeforeFenceClose: false,
      problems,
    };
  }

  // The functions the restore reaches, and the position of the call that
  // reaches them. The position of a reached function is the earliest call
  // that can reach it, so a replay that hides in a helper cannot pretend to
  // happen later than it does.
  /** @type {Map<string, number>} */
  const entry = new Map([['Restore', restore.start]]);
  /** @type {Set<string>} */
  const reachable = new Set(['Restore']);
  /** @type {string[]} */
  const queue = ['Restore'];
  while (queue.length > 0) {
    const name = /** @type {string} */ (queue.shift());
    const fn = functions.get(name);
    if (!fn) continue;
    const position = /** @type {number} */ (entry.get(name));
    const calls = [
      ...methodCalls(fn.body, fn.start).map((call) => ({ name: call.method, position: call.position, args: call.args })),
      ...plainCalls(fn.body, fn.start),
    ];
    for (const call of calls) {
      if (!functions.has(call.name)) continue;
      const effective = name === 'Restore' ? call.position : position;
      const known = entry.get(call.name);
      if (known === undefined || effective < known) entry.set(call.name, effective);
      if (!reachable.has(call.name)) {
        reachable.add(call.name);
        queue.push(call.name);
      }
    }
  }

  // The calls of the reachable path, with the position they act at.
  /** @type {{receiver: string, method: string, position: number, args: string[]}[]} */
  const calls = [];
  for (const name of reachable) {
    const fn = functions.get(name);
    if (!fn) continue;
    const effective = name === 'Restore' ? null : /** @type {number} */ (entry.get(name));
    for (const call of methodCalls(fn.body, fn.start)) {
      calls.push({
        receiver: call.receiver,
        method: call.method,
        position: effective === null ? call.position : effective,
        args: call.args,
      });
    }
  }

  const lastIdentifier = (receiver) => receiver.split('.').pop() ?? receiver;
  const imports = calls.filter((call) => call.method === 'Restore' && /restorer/i.test(lastIdentifier(call.receiver ?? '')));
  const tombstones = calls.filter((call) => call.method === 'ApplyTombstones');
  const removals = calls.filter((call) => call.method === 'ApplyRemovalRecords' && /removal/i.test(lastIdentifier(call.receiver ?? '')));
  const subjectRemovals = calls.filter((call) => call.method === 'ApplySubjectRemovalRecords' && /removal/i.test(lastIdentifier(call.receiver ?? '')));
  const gateReleases = calls.filter((call) => call.method === 'ReleaseRestoreGate');
  // The fence is closed with the ledger the restore applied. The last close
  // is the one that lets the restored copy serve.
  const fenceCloses = calls.filter((call) => call.method === 'Finish' && /handle|fence/i.test(lastIdentifier(call.receiver ?? '')));

  // The variables that carry the merged ledger. A merge only counts when it
  // combines the ledger of the bundle with another source, so the replay
  // cannot be the ledger of the bundle alone.
  /** @type {Set<string>} */
  const merged = new Set();
  for (const name of reachable) {
    const fn = functions.get(name);
    if (!fn) continue;
    const assignments = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:,\s*[A-Za-z_][A-Za-z0-9_]*\s*)?:?=\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    let match = assignments.exec(fn.body);
    while (match !== null) {
      const callee = match[2];
      if (/^merge.*removal/i.test(callee)) {
        const open = match.index + match[0].length - 1;
        const close = matchParenthesis(fn.body, open);
        const args = close === -1 ? [] : splitArguments(fn.body.slice(open + 1, close));
        // The context is not a ledger source, so two sources are the minimum.
        if (args.length >= 3) merged.add(match[1]);
      }
      match = assignments.exec(fn.body);
    }
  }

  const replaysMerged = (calls_) => calls_.every((call) => {
    const argument = call.args[1] ?? '';
    const root = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(argument)?.[1] ?? '';
    return merged.has(root);
  });

  const appliesRemovalRecords = removals.length > 0;
  const appliesSubjectRemovalRecords = subjectRemovals.length > 0;
  const replaysMergedLedger = appliesRemovalRecords
    && appliesSubjectRemovalRecords
    && replaysMerged(removals)
    && replaysMerged(subjectRemovals);
  const importPosition = imports.length === 0 ? null : Math.max(...imports.map((call) => call.position));
  const replayAfterImport = importPosition !== null
    && [...removals, ...subjectRemovals].every((call) => call.position > importPosition);
  const releasePosition = gateReleases.length === 0 ? null : Math.min(...gateReleases.map((call) => call.position));
  const replayBeforeGateRelease = releasePosition === null
    ? true
    : [...removals, ...subjectRemovals].every((call) => call.position < releasePosition);
  const fenceClosePosition = fenceCloses.length === 0 ? null : Math.max(...fenceCloses.map((call) => call.position));
  const replayBeforeFenceClose = fenceClosePosition === null
    ? true
    : [...removals, ...subjectRemovals].every((call) => call.position < fenceClosePosition);

  if (!imports.length) problems.push('the restore does not import the export of the bundle');
  if (!tombstones.length) problems.push('the restore does not reapply the game deletion ledger');
  if (!appliesRemovalRecords) problems.push('the restore does not replay the online removal ledger');
  if (!appliesSubjectRemovalRecords) problems.push('the restore does not replay the subject level removal ledger');
  if (appliesRemovalRecords && appliesSubjectRemovalRecords && !replaysMergedLedger) {
    problems.push('the restore replays a ledger that is not the merged ledger');
  }
  if (importPosition !== null && !replayAfterImport) {
    problems.push('the restore replays the removal ledger before the import of the export');
  }
  if (releasePosition !== null && !replayBeforeGateRelease) {
    problems.push('the restore releases the restore gate before the removal ledger is replayed');
  }
  if (fenceClosePosition !== null && !replayBeforeFenceClose) {
    problems.push('the restore closes the restore fence before the removal ledger is replayed');
  }

  return {
    restoreFound: true,
    appliesTombstones: tombstones.length > 0,
    appliesRemovalRecords,
    appliesSubjectRemovalRecords,
    replaysMergedLedger,
    replayAfterImport,
    replayBeforeGateRelease,
    replayBeforeFenceClose,
    problems,
  };
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
 * Reads the local retention policy of the repo-managed recovery bundles.
 *
 * The owner contract asks for the old recovery copies to be removed or
 * sanitized within thirty days. The rotation of the managed directory can
 * only promise that for the bundles it manages, so the audit reads what the
 * repository actually does:
 *
 *   1. is a maximum age of thirty days declared for the ordinary bundles?
 *   2. does the planner apply it, independent of the count of the rotation?
 *   3. does the rotation report an unresolved retention and fail closed?
 *   4. does the deployment run the rotation over the managed directory?
 *   5. does the durable restore evidence stay outside the pruning?
 *
 * The audit reads the repository only. It says nothing about a copy on an
 * offsite store, nothing about the schedule of the host and nothing about
 * the sanitization of a recovery copy.
 * @param {{plan: string, main: string, deployment: string}} sources
 * @returns {{capDays: number, capDeclared: boolean, capApplied: boolean, unresolvedReported: boolean, rotationFailsClosed: boolean, deploymentAppliesRotation: boolean, evidenceOutsidePruning: boolean}}
 */
export function inspectLocalRetention({ plan, main, deployment }) {
  const capDays = Number(/MaxBundleAgeDays\s*=\s*(\d+)/.exec(plan)?.[1] ?? 0);
  const capDeclared = capDays === 30;
  const capApplied = /MaxBundleAge\b/.test(plan) && /Before\(cutoff\)/.test(plan);
  const unresolvedReported = /ErrRetentionUnresolved/.test(main) && /"unresolved"/.test(main);
  const rotationFailsClosed = /ErrRetentionUnresolved/.test(main) && /plan\.Unresolved/.test(main);
  const deploymentAppliesRotation = /khabackup rotate --dir \S+ --apply/.test(deployment);
  const evidenceOutsidePruning = /entry\.IsDir\(\)/.test(main)
    && /copy-restore-evidence\.sh \/backups\/restore-evidence/.test(deployment);
  return {
    capDays,
    capDeclared,
    capApplied,
    unresolvedReported,
    rotationFailsClosed,
    deploymentAppliesRotation,
    evidenceOutsidePruning,
  };
}

/**
 * @param {string} root
 * @returns {Promise<{tables: string[], dumpIsFullDatabase: boolean, dumpFilters: string[], restoresGameLedger: boolean, restoresOnlineLedger: boolean, planRecoveryUsed: boolean, runbookMentionsLedger: boolean}>}
 */
export async function inspectBackup(root) {
  const pgtools = await readFile(join(root, 'backend', 'backup', 'cmd', 'khabackup', 'pgtools.go'), 'utf8');
  const main = await readFile(join(root, 'backend', 'backup', 'cmd', 'khabackup', 'main.go'), 'utf8');
  const backup = await readFile(join(root, 'backend', 'backup', 'backup.go'), 'utf8');
  const removals = await readFile(join(root, 'backend', 'backup', 'removals.go'), 'utf8').catch(() => '');
  const privacy = await readFile(join(root, 'backend', 'privacy', 'ledger.go'), 'utf8').catch(() => '');
  const plan = await readFile(join(root, 'backend', 'backup', 'plan.go'), 'utf8').catch(() => '');
  const deployment = await readFile(join(root, 'deploy', 'backup.sh'), 'utf8').catch(() => '');
  const runbook = await readFile(join(root, 'docs', 'implementation', 'MVP-operations.md'), 'utf8').catch(() => '');

  const dumpArguments = pgtools.match(/arguments := \[\]string\{[^}]*\}/)?.[0] ?? '';
  const dumpFilters = [...dumpArguments.matchAll(/--table[= ]"?([A-Za-z0-9_]+)"?/g)].map((match) => match[1]);
  const dumpIsFullDatabase = /pg_dump|--format=plain/.test(pgtools) && dumpFilters.length === 0;

  // The restore path is read, not searched. A search over the text of the
  // package finds the name of the replay method in the interface of the sink
  // even when the restore never calls it, so the audit follows the calls of
  // the restore instead.
  const restoreReplay = verifyRestoreReplay(backup);
  const restoresGameLedger = (/deletion_tombstones/.test(pgtools) || /deletion_tombstones/.test(backup))
    && restoreReplay.appliesTombstones
    && restoreReplay.replayAfterImport;
  // The online removal ledger is reapplied when the restore replays the
  // merged ledger after the import and before the restore gate is released,
  // and when the ledger itself lives in a table.
  const removalLedgerTable = /online_removal_ledger/.test(privacy) || /online_removal_ledger/.test(pgtools);
  const removalSinkDeclared = /ApplyRemovalRecords/.test(removals) && /ApplySubjectRemovalRecords/.test(removals);
  const restoresOnlineLedger = removalLedgerTable
    && removalSinkDeclared
    && restoreReplay.appliesRemovalRecords
    && restoreReplay.appliesSubjectRemovalRecords
    && restoreReplay.replaysMergedLedger
    && restoreReplay.replayAfterImport
    && restoreReplay.replayBeforeGateRelease
    && restoreReplay.replayBeforeFenceClose;
  const planRecoveryUsed = /PlanDeletionRecovery|PlanRestore/.test(main + backup);

  // The restore gate must be consulted before the restored copy serves. The
  // gate exists in the privacy service; a gate nobody calls is not a gate.
  const gateFunction = /func \(s \*Service\) (Serving\w+)\(/.exec(privacy)?.[1] ?? null;
  let servingGateWired = false;
  if (gateFunction) {
    /** @type {string[]} */
    const goFiles = [];
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
        if (entry.name.endsWith('.go')) goFiles.push(path);
      }
    };
    await walk(join(root, 'backend'));
    for (const file of goFiles) {
      const id = file.slice(root.length + 1).split('\\').join('/');
      if (id === 'backend/privacy/ledger.go') continue;
      if (id.endsWith('_test.go')) continue;
      const text = await readFile(file, 'utf8');
      if (text.includes(`${gateFunction}(`)) {
        servingGateWired = true;
        break;
      }
    }
  }

  const runbookMentionsLedger = /newer-ledger|ledger/i.test(runbook);

  // The restore refuses to run without a durable fence, so the documented
  // restore command has to name it.
  const restoreCommand = runbook.match(/khabackup restore[^\n]*(?:\n[^\n]*){0,4}/)?.[0] ?? '';
  const restoreNamesFence = /--fence|ONLINE_RESTORE_FENCE_PATH/.test(restoreCommand);

  return {
    tables: await migrationTables(root),
    dumpIsFullDatabase,
    dumpFilters,
    restoresGameLedger,
    restoresOnlineLedger,
    planRecoveryUsed,
    servingGateWired,
    gateFunction,
    runbookMentionsLedger,
    restoreCommand,
    restoreNamesFence,
    restoreReplay,
    retention: inspectLocalRetention({ plan, main, deployment }),
  };
}

/**
 * Renders the reasons the restore path verifier found.
 *
 * The reasons name the exact failure, so a reader does not have to guess
 * which part of the restore path is broken.
 * @param {Awaited<ReturnType<typeof inspectBackup>>} state
 * @returns {string}
 */
function replayReasons(state) {
  const problems = state.restoreReplay?.problems ?? [];
  if (problems.length === 0) return '';
  return ` The restore path verifier found: ${problems.join('; ')}.`;
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
      `The restore path does not reapply the game deletion ledger, so a restored copy can resurrect a deleted game.${replayReasons(state)}`,
      'Apply the deletion ledger inside the restore transaction.',
    ));
  } else {
    findings.push(finding('info', 'game-ledger-reapplied', 'The restore path reapplies the game deletion ledger.', null));
  }
  if (!state.restoresOnlineLedger) {
    findings.push(finding(
      'blocker',
      'online-removal-ledger-uncovered',
      `The restore path does not reapply the online removal ledger before the restored copy serves traffic, so a restored copy can publish a replay whose erasure was requested.${replayReasons(state)}`,
      'Replay the merged removal ledger in the restore, after the import and before the restore gate is released.',
    ));
  } else {
    findings.push(finding('info', 'online-removal-ledger-reapplied', 'The restore path reapplies the online removal ledger.', null));
  }
  if (!state.servingGateWired) {
    findings.push(finding(
      'blocker',
      'restore-gate-not-wired',
      state.gateFunction
        ? `The restore gate exists (${state.gateFunction}) but no production read path consults it, so a restored copy can serve traffic before the removal ledger is applied.`
        : 'No restore gate exists, so a restored copy can serve traffic before the removal ledger is applied.',
      'Consult the restore gate before any public read and before any mutation of a restored copy.',
    ));
  } else {
    findings.push(finding('info', 'restore-gate-wired', 'A production path consults the restore gate before serving.', null));
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
  if (state.restoreCommand && !state.restoreNamesFence) {
    findings.push(finding(
      'blocker',
      'restore-command-without-fence',
      'The documented restore command names no durable fence, and the restore refuses to run without one.',
      'Add the fence path to the restore command in docs/implementation/MVP-operations.md.',
    ));
  } else if (state.restoreCommand) {
    findings.push(finding('info', 'restore-command-names-fence', 'The documented restore command names the durable fence.', null));
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
  // The local retention policy of the repo-managed bundles. The audit reads
  // the repository only: it says nothing about a copy on an offsite store and
  // nothing about the schedule of the host.
  const retention = state.retention ?? {};
  if (!retention.capDeclared) {
    findings.push(finding(
      'blocker',
      'local-retention-cap-missing',
      'The rotation of the repo-managed bundles declares no maximum age, so an old recovery copy can outlive the thirty day target of the owner contract.',
      'Declare a maximum age of thirty days for the ordinary bundles of the managed directory.',
    ));
  } else if (!retention.capApplied) {
    findings.push(finding(
      'blocker',
      'local-retention-cap-not-applied',
      `The rotation declares a maximum age of ${retention.capDays} days, but the planner does not apply it, so a bundle that is too old stays in the directory.`,
      'Apply the maximum age in the rotation planner, independent of the count of the rotation.',
    ));
  } else {
    findings.push(finding(
      'info',
      'local-retention-cap-enforced',
      `The rotation retires every ordinary repo-managed bundle that passed the maximum age of ${retention.capDays} days.`,
      null,
    ));
  }
  if (!retention.unresolvedReported || !retention.rotationFailsClosed) {
    findings.push(finding(
      'blocker',
      'retention-unresolved-not-reported',
      'The rotation does not report an unresolved retention and fail closed, so the run of the backup can claim success while an old recovery copy remains.',
      'Report the unresolved bundles of the rotation and exit with a nonzero status while they remain.',
    ));
  } else {
    findings.push(finding(
      'info',
      'retention-unresolved-fails-closed',
      'The rotation fails closed on a bundle it may not delete, so the backup cannot claim success while an old recovery copy remains.',
      null,
    ));
  }
  if (!retention.deploymentAppliesRotation) {
    findings.push(finding(
      'blocker',
      'deployment-rotation-missing',
      'The deployment script does not run the rotation over the managed directory, so the maximum age of the bundles is never enforced.',
      'Run "khabackup rotate --dir <managed directory> --apply" in deploy/backup.sh.',
    ));
  } else {
    findings.push(finding(
      'info',
      'deployment-rotation-applied',
      'The deployment runs the rotation over the managed directory, so the maximum age is enforced on every run of the backup.',
      null,
    ));
  }
  if (!retention.evidenceOutsidePruning) {
    findings.push(finding(
      'warning',
      'restore-evidence-inside-the-pruning',
      'The durable restore evidence is not provably outside the pruning of the bundles, so the rotation could retire the evidence of a restore.',
      'Keep the evidence in its own directory of the managed directory and never let the rotation descend into a subdirectory.',
    ));
  } else {
    findings.push(finding(
      'info',
      'restore-evidence-outside-the-pruning',
      'The durable restore evidence lives in its own directory and the rotation never descends into a subdirectory, so the evidence is never retired by the age rule.',
      null,
    ));
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
        `The online removal markers are not reapplied by the current restore path. An online replay whose erasure was requested can come back with an old bundle.${replayReasons(state)}`,
      ],
  };
}

/**
 * Runs the audit.
 * @param {string} root
 * @returns {Promise<{findings: Finding[], hooks: ReturnType<typeof restoreRunbookHooks>, tables: string[], restoreReplay: Awaited<ReturnType<typeof inspectBackup>>['restoreReplay']}>}
 */
export async function auditBackupCoverage(root) {
  const state = await inspectBackup(root);
  return {
    findings: auditBackup(state),
    hooks: restoreRunbookHooks(state),
    tables: state.tables,
    restoreReplay: state.restoreReplay,
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
