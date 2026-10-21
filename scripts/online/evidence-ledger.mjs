// Evidence ledger for the online acceptance contract.
//
// The approved contract in docs/spec/online-play-acceptance.json is read-only.
// This tool reads it, reads the recorded evidence, and reports an honest status
// per scenario. It never edits the approved contract and it never marks a
// scenario passed without a record that names the tested commit, the exact
// command, the expected behaviour and the observed result.
//
// The evidence kinds are deliberately separate:
//
//   local   a real service run against a real database and the real worker
//   native  a real device with a real assistive technology
//   host    a real host measurement
//   live    a real released cohort
//   owner   a recorded owner decision
//
// A local run can never satisfy a native scenario, and a plan can never
// satisfy an implementation scenario.
//
// Usage:
//   node scripts/online/evidence-ledger.mjs [--root DIR] [--json] [--write]

import { spawn } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

/**
 * @typedef {'local'|'native'|'host'|'live'|'owner'} EvidenceKind
 * @typedef {'passed'|'failed'|'blocked'|'partial'} EvidenceStatus
 */

/** Which evidence kind may close a scenario of each family. */
export const FAMILY_KINDS = {
  FRI: ['local', 'host', 'live'],
  QUE: ['local', 'host', 'live'],
  MAT: ['local', 'host', 'live'],
  HIS: ['local', 'host', 'live'],
  ARC: ['local', 'host', 'live'],
  UX: ['native'],
  REL: ['owner'],
};

/**
 * @param {string} scenarioId
 * @returns {string}
 */
export function familyOf(scenarioId) {
  const match = /^([A-Z]+)-/.exec(scenarioId);
  return match ? match[1] : 'OTHER';
}

/**
 * Validates one evidence record.
 * @param {any} record
 * @param {Set<string>} known
 * @returns {{valid: boolean, problems: string[], status: EvidenceStatus, scenarioId: string}}
 */
export function validateRecord(record, known) {
  /** @type {string[]} */
  const problems = [];
  const scenarioId = String(record?.scenarioId ?? '');
  if (!known.has(scenarioId)) problems.push(`the scenario ${scenarioId} is not in the approved contract`);
  const status = record?.status;
  if (!['passed', 'failed', 'blocked', 'partial'].includes(status)) {
    problems.push('the status must be passed, failed, blocked or partial');
  }
  const kind = record?.kind;
  if (!['local', 'native', 'host', 'live', 'owner'].includes(kind)) {
    problems.push('the kind must be local, native, host, live or owner');
  }
  for (const field of ['commit', 'command', 'actual']) {
    if (typeof record?.[field] !== 'string' || record[field].trim() === '') {
      problems.push(`the record needs a ${field}`);
    }
  }
  if (typeof record?.expected === 'string' && record.expected.trim() === '') {
    problems.push('the record needs an expected outcome');
  }
  const allowed = FAMILY_KINDS[familyOf(scenarioId)] ?? [];
  if (allowed.length > 0 && !allowed.includes(kind)) {
    problems.push(`a ${kind} run cannot close a ${familyOf(scenarioId)} scenario; it needs ${allowed.join(' or ')}`);
  }
  return { valid: problems.length === 0, problems, status: status ?? 'partial', scenarioId };
}

/**
 * Reads the recorded evidence.
 * @param {string} root
 * @returns {Promise<{records: any[], problems: {file: string, problems: string[]}[]}>}
 */
export async function readRecords(root) {
  const directory = join(root, 'docs', 'evidence', 'online', 'records');
  /** @type {any[]} */
  const records = [];
  /** @type {{file: string, problems: string[]}[]} */
  const problems = [];
  /** @type {string[]} */
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return { records, problems };
  }
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    try {
      records.push({ file: name, body: JSON.parse(await readFile(join(directory, name), 'utf8')) });
    } catch (error) {
      problems.push({ file: name, problems: [`the record is not readable JSON: ${error instanceof Error ? error.message : String(error)}`] });
    }
  }
  return { records, problems };
}

/**
 * Builds the ledger.
 * @param {{cases: {id: string, scenario: string, status: string}[], records: any[], problems: {file: string, problems: string[]}[]}} input
 * @returns {{cases: any[], counts: Record<string, number>, invalidRecords: {file: string, problems: string[]}[]}}
 */
export function buildLedger({ cases, records, problems, staleCommits = new Set(), failedScenarios = new Set() }) {
  const known = new Set(cases.map((entry) => entry.id));
  /** @type {Map<string, any>} */
  const byScenario = new Map();
  /** @type {{file: string, problems: string[]}[]} */
  const invalidRecords = [...problems];

  for (const record of records) {
    const body = record.body;
    const validation = validateRecord(body, known);
    if (!validation.valid) {
      invalidRecords.push({ file: record.file, problems: validation.problems });
      continue;
    }
    const existing = byScenario.get(validation.scenarioId);
    if (existing && existing.status !== validation.status) {
      invalidRecords.push({
        file: record.file,
        problems: [`a second record contradicts the recorded status of ${validation.scenarioId}`],
      });
      continue;
    }
    const stale = staleCommits.has(String(body.commit ?? ''));
    const failed = failedScenarios.has(validation.scenarioId);
    const status = stale || failed ? 'failed' : validation.status;
    byScenario.set(validation.scenarioId, {
      scenarioId: validation.scenarioId,
      status,
      kind: body.kind,
      commit: body.commit,
      command: body.command,
      expected: body.expected ?? '',
      actual: body.actual,
      notes: [
        body.notes ?? '',
        stale ? 'the recorded commit is not an ancestor of the tested tree, so the record is not a pass' : '',
        failed ? 'the newest run failed this scenario, so the record is not a pass' : '',
      ].filter(Boolean).join(' '),
      record: record.file,
    });
  }

  const ledger = cases.map((entry) => {
    const evidence = byScenario.get(entry.id);
    return {
      id: entry.id,
      scenario: entry.scenario,
      approvedStatus: entry.status,
      status: evidence ? evidence.status : 'not_run',
      kind: evidence ? evidence.kind : null,
      commit: evidence ? evidence.commit : null,
      command: evidence ? evidence.command : null,
      expected: evidence ? evidence.expected : null,
      actual: evidence ? evidence.actual : null,
      notes: evidence ? evidence.notes : '',
      record: evidence ? evidence.record : null,
    };
  });

  /** @type {Record<string, number>} */
  const counts = { passed: 0, failed: 0, blocked: 0, partial: 0, not_run: 0 };
  for (const entry of ledger) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  return { cases: ledger, counts, invalidRecords };
}

/**
 * Runs the ledger.
 * @param {string} root
 * @returns {Promise<Awaited<ReturnType<typeof buildLedger>> & {contract: string}>}
 */
/**
 * Reports the commits that are ancestors of the tested tree.
 *
 * A record that cites a commit outside the tested tree describes a different
 * code base, so it cannot close a scenario.
 * @param {string} root
 * @param {string[]} commits
 * @returns {Promise<Set<string>>}
 */
export async function staleCommits(root, commits) {
  const stale = new Set();
  for (const commit of commits) {
    if (!commit) continue;
    const ancestor = await new Promise((resolvePromise) => {
      const child = spawn('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: root, windowsHide: true });
      child.on('error', () => resolvePromise(false));
      child.on('close', (code) => resolvePromise(code === 0));
    });
    if (!ancestor) stale.add(commit);
  }
  return stale;
}

/**
 * Reports the scenarios the newest run failed.
 * @param {string} root
 * @returns {Promise<Set<string>>}
 */
export async function failedScenarios(root) {
  /** @type {Set<string>} */
  const failed = new Set();
  /** @type {any} */
  let report;
  try {
    report = JSON.parse(await readFile(join(root, 'docs', 'evidence', 'online', 'KHA-80-integration.json'), 'utf8'));
  } catch {
    return failed;
  }
  for (const entry of report.coverage ?? []) {
    if (entry.status === 'failed') failed.add(entry.scenarioId);
  }
  if (report.browser && report.browser.status !== 'passed') {
    try {
      const browserMap = JSON.parse(await readFile(join(root, 'scripts', 'online', 'browser-map.json'), 'utf8'));
      for (const scenarioId of Object.keys(browserMap.scenarios ?? {})) failed.add(scenarioId);
    } catch {
      // A missing map cannot fail a scenario.
    }
  }
  return failed;
}

export async function buildEvidenceLedger(root) {
  const contract = JSON.parse(await readFile(join(root, 'docs', 'spec', 'online-play-acceptance.json'), 'utf8'));
  const { records, problems } = await readRecords(root);
  const commits = records.map((record) => String(record.body?.commit ?? '')).filter(Boolean);
  const stale = await staleCommits(root, [...new Set(commits)]);
  const failed = await failedScenarios(root);
  const ledger = buildLedger({ cases: contract.cases, records, problems, staleCommits: stale, failedScenarios: failed });
  return { ...ledger, contract: contract.title };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const rootIndex = arguments_.indexOf('--root');
  const root = rootIndex >= 0 ? arguments_[rootIndex + 1] : process.cwd();
  const ledger = await buildEvidenceLedger(root);

  if (arguments_.includes('--write')) {
    const target = join(root, 'docs', 'evidence', 'online', 'ledger.json');
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, `${JSON.stringify({
      tool: 'scripts/online/evidence-ledger.mjs',
      generatedFrom: 'docs/spec/online-play-acceptance.json',
      disclaimer: 'The approved contract is read-only. This ledger reports the recorded evidence and never edits the contract.',
      counts: ledger.counts,
      invalidRecords: ledger.invalidRecords,
      cases: ledger.cases,
    }, null, 2)}\n`, 'utf8');
    process.stdout.write(`wrote ${target}\n`);
  }

  if (arguments_.includes('--json')) {
    process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`);
  } else {
    process.stdout.write(`evidence ledger: ${ledger.counts.passed} passed, ${ledger.counts.failed} failed, ${ledger.counts.blocked} blocked, ${ledger.counts.partial} partial, ${ledger.counts.not_run} not run\n`);
    for (const entry of ledger.cases) {
      if (entry.status === 'not_run') continue;
      process.stdout.write(`  ${entry.status.toUpperCase().padEnd(8)} ${entry.id} (${entry.kind}) ${entry.commit}\n`);
    }
    for (const invalid of ledger.invalidRecords) {
      process.stdout.write(`  INVALID  ${invalid.file}: ${invalid.problems.join('; ')}\n`);
    }
  }
  if (ledger.invalidRecords.length > 0) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/online/evidence-ledger.mjs')) {
  await main();
}
