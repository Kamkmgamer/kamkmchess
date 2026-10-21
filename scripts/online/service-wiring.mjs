// Production wiring audit for the online feature switches.
//
// The browser asks GET /v1/online/features before it shows anything, and the
// server owns the two switches that decide which surfaces are mounted. Both
// switches are default off.
//
// This audit reads the application tree and reports:
//
//   - whether the feature route exists in the production composition;
//   - whether the two server switches are read by the server at all;
//   - whether an unset switch defaults to closed;
//   - whether the friend and queue route groups are mounted conditionally.
//
// It is written for the case where the browser flags exist but the server
// gates do not: that combination leaves the interface present and every
// surface closed, which is not a working feature.
//
// Usage:
//   node scripts/online/service-wiring.mjs [--root DIR] [--json]

import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

/**
 * @typedef {'blocker'|'warning'|'info'} Severity
 * @typedef {{ severity: Severity, code: string, message: string, remediation: string|null }} Finding
 */

/** The public feature route the browser asks before it shows anything. */
export const FEATURES_ROUTE = '/v1/online/features';

/** The server switches that own the rollout. */
export const SERVER_SWITCHES = ['ONLINE_FRIEND_ENABLED', 'ONLINE_QUEUE_ENABLED'];

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
 * Lists the Go files of the application tree.
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function goFiles(root) {
  /** @type {string[]} */
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
      if (entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) found.push(path);
    }
  };
  await walk(join(root, 'backend'));
  await walk(join(root, 'cmd'));
  return found.sort();
}

/**
 * Extracts the body of a Go function that starts at the given offset.
 * @param {string} text
 * @param {number} offset
 * @returns {string}
 */
function functionBodyAt(text, offset) {
  const start = text.lastIndexOf('\nfunc ', offset);
  if (start < 0) return '';
  const end = text.indexOf('\n}', offset);
  return end < 0 ? text.slice(start) : text.slice(start, end + 2);
}

/**
 * Finds the helper that reads a switch and reports whether an unset switch
 * leaves the surface closed.
 *
 * The check follows the actual read site. A read through a helper is checked
 * in that helper, so an unwired helper cannot pass the audit by sitting
 * somewhere else in the file.
 * @param {string} text
 * @param {string} name
 * @returns {'closed'|'open'|'unknown'}
 */
export function switchDefaultState(text, name) {
  const readPattern = new RegExp(`"${name}"`, 'g');
  const match = readPattern.exec(text);
  if (!match) return 'unknown';
  const readSite = match.index;

  // A read through a helper is decided by that helper. The helper receives
  // the lookup function, as in flag(getenv, "ONLINE_FRIEND_ENABLED").
  const before = text.slice(Math.max(0, readSite - 120), readSite);
  // The helper that reads this switch is the one immediately before it.
  /** @type {string|null} */
  let helperName = null;
  for (const candidate of before.matchAll(/(\w+)\(\s*getenv\s*,/g)) {
    helperName = candidate[1] ?? null;
  }
  let body = functionBodyAt(text, readSite);
  if (helperName) {
    const helperDefinition = new RegExp(`func ${helperName}\\(`);
    const helperMatch = helperDefinition.exec(text);
    if (helperMatch) {
      body = functionBodyAt(text, helperMatch.index);
    }
  }
  if (!body) return 'unknown';
  const readsTrue = /==\s*"true"/.test(body) || /EqualFold\([\s\S]{0,120}?"true"\)/.test(body);
  const fallsBackToTrue = /\|\|\s*true\b/.test(body) || /:\s*true\b/.test(body) || /return\s+true\b/.test(body);
  if (readsTrue && !fallsBackToTrue) return 'closed';
  if (fallsBackToTrue) return 'open';
  return 'unknown';
}

/**
 * Audits the production wiring.
 * @param {string} root
 * @returns {Promise<{findings: Finding[], sources: {file: string, switches: string[], featuresRoute: boolean}[]}>}
 */
export async function auditServiceWiring(root) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {{file: string, switches: string[], featuresRoute: boolean}[]} */
  const sources = [];

  let featuresRouteFiles = 0;
  const switchFiles = new Map(SERVER_SWITCHES.map((name) => [name, []]));
  /** @type {Record<string, 'closed'|'open'|'unknown'>} */
  const switchState = {};

  for (const file of await goFiles(root)) {
    const text = await readFile(file, 'utf8');
    const id = relative(root, file).split(sep).join('/');
    const switches = SERVER_SWITCHES.filter((name) => text.includes(name));
    const featuresRoute = text.includes(FEATURES_ROUTE);
    if (switches.length > 0 || featuresRoute) sources.push({ file: id, switches, featuresRoute });
    if (featuresRoute) featuresRouteFiles += 1;
    for (const name of switches) {
      switchFiles.get(name).push(id);
      const state = switchDefaultState(text, name);
      // A read in any file counts when at least one read closes by default.
      if (state === 'closed') switchState[name] = 'closed';
      else if (switchState[name] !== 'closed') switchState[name] = state;
    }
  }

  if (featuresRouteFiles === 0) {
    findings.push(finding(
      'blocker',
      'features-route-missing',
      `The production composition does not serve ${FEATURES_ROUTE}. The browser asks this route before it shows anything, so every surface stays closed and the interface cannot be reached.`,
      `Serve GET ${FEATURES_ROUTE} from the production composition and mount it unconditionally.`,
    ));
  } else {
    findings.push(finding('info', 'features-route-present', `The production composition serves ${FEATURES_ROUTE}.`, null));
  }

  for (const name of SERVER_SWITCHES) {
    const files = switchFiles.get(name) ?? [];
    if (files.length === 0) {
      findings.push(finding(
        'blocker',
        'server-switch-unused',
        `The server never reads ${name}. A browser flag cannot open a surface, so this surface cannot be enabled at all.`,
        `Read ${name} in the server configuration and mount the matching route group only when it is on.`,
      ));
      continue;
    }
    findings.push(finding(
      'info',
      'server-switch-read',
      `The server reads ${name} in ${files.join(', ')}.`,
      null,
    ));
  }

  for (const name of SERVER_SWITCHES) {
    if ((switchFiles.get(name) ?? []).length === 0) continue;
    const state = switchState[name];
    if (state === 'closed') {
      findings.push(finding('info', 'switch-default-closed', `An unset ${name} leaves the surface closed.`, null));
      continue;
    }
    findings.push(finding(
      'blocker',
      'switch-default-not-closed',
      state === 'open'
        ? `The read of ${name} can yield true, so an unset switch does not reliably close the surface.`
        : `The read of ${name} has no provable closed default. An unset switch must leave the surface closed.`,
      'Read the switch as false when it is unset or unparsable.',
    ));
  }

  const conditionalMount = sources.some((source) => source.switches.length > 0);
  if (!conditionalMount) {
    findings.push(finding(
      'blocker',
      'routes-not-conditional',
      'No production file both reads a feature switch and serves a route, so the route groups cannot be mounted conditionally.',
      'Mount the friend and queue route groups under the matching switch.',
    ));
  }

  return { findings, sources };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const rootIndex = arguments_.indexOf('--root');
  const root = rootIndex >= 0 ? arguments_[rootIndex + 1] : process.cwd();
  const report = await auditServiceWiring(root);
  if (arguments_.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      tool: 'scripts/online/service-wiring.mjs',
      mode: 'repository-files-only',
      disclaimer: 'This audit reads the application tree. It proves nothing about a deployed environment.',
      ...report,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`service wiring: ${report.findings.length} findings\n`);
    for (const item of report.findings) {
      process.stdout.write(`  ${item.severity.toUpperCase().padEnd(8)} ${item.code}\n           ${item.message}\n`);
      if (item.remediation) process.stdout.write(`           fix: ${item.remediation}\n`);
    }
  }
  if (report.findings.some((item) => item.severity === 'blocker')) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/online/service-wiring.mjs')) {
  await main();
}
