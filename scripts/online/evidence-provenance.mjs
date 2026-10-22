// The provenance of an evidence record.
//
// A record is a claim about the behaviour of a scenario. A claim closes an
// acceptance scenario only when a verifiable run source recorded that
// behaviour. This module reads the run sources of the tree and reports what
// each source really observed, so the evidence ledger can refuse a record
// that no run backs.
//
// The trust rule:
//
//   - a record that claims a pass needs a run source that recorded the
//     scenario at the very commit the record names, and that recorded it as
//     passed;
//   - a record that claims a partial observation needs a run source that
//     recorded the scenario at that very commit;
//   - a failed or a blocked record needs no run source: it never opens a
//     gate and it can only lower the status of a scenario;
//   - the command of the record has to be the command of the run source. Two
//     different commands are two different commands, and a run source that
//     names no command certifies nothing, so it cannot back a record;
//   - a kind of evidence without a registered run source fails closed. No
//     record of that kind closes a scenario until such a source exists, so
//     a native run, a host measurement, a live cohort and an owner decision
//     never open a gate on a claim in a file.
//
// The rule compares the commit, the command and the outcome of a record
// with the run source that produced them. It does not judge the prose of a
// record and it does not decide whether the mapped tests cover the whole
// approved scenario: that is the judgement of the acceptance map and of the
// operator who ran the tests.
//
// Usage:
//   import { buildEvidenceRecords } from './evidence-provenance.mjs';

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * @typedef {'not_run'|'failed'|'partial'|'passed'} Outcome
 * @typedef {{ outcome: Outcome, detail: string }} Observed
 * @typedef {{ id: string, kind: string, path: string, commit: string, command: string|null, outcomes: Map<string, Observed> }} RunChannel
 * @typedef {{ channels: RunChannel[], problems: {path: string, problems: string[]}[] }} RunSources
 */

/** The path of the local run source, relative to the root of the tree. */
export const LOCAL_RUN_SOURCE = 'docs/evidence/online/KHA-80-integration.json';

/** The path of the map from a scenario to the browser cases, relative to the root. */
export const BROWSER_MAP = 'scripts/online/browser-map.json';

/**
 * The run sources that may back a record of each kind.
 *
 * A kind without a source fails closed. The native assistive technology, the
 * deployed host, the released cohort and the owner decision have no
 * verifiable artifact in the tree yet, so a record of those kinds closes
 * nothing. Registering a channel for a kind is the only way to open it, and
 * the artifact of the run has to carry the outcome of the scenario.
 */
export const EVIDENCE_SOURCES = {
  local: ['local-integration', 'local-browser'],
  native: [],
  host: [],
  live: [],
  owner: [],
};

/** The outcomes from the weakest to the strongest. */
const OUTCOME_ORDER = ['not_run', 'failed', 'partial', 'passed'];

/**
 * Reads a JSON file.
 * @param {string} path
 * @returns {Promise<{body: any, error: string|null}>}
 */
async function readJson(path) {
  try {
    return { body: JSON.parse(await readFile(path, 'utf8')), error: null };
  } catch (error) {
    return { body: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Reads a non-empty string.
 * @param {any} value
 * @returns {string|null}
 */
function namedString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Normalizes a command for the comparison.
 *
 * The whitespace of a command is not part of it, but the command itself is:
 * two different commands are two different commands, even when one of them
 * contains the other.
 * @param {any} value
 * @returns {string}
 */
export function normalizeCommand(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Reports the strength of an outcome.
 * @param {string} outcome
 * @returns {number}
 */
export function outcomeRank(outcome) {
  const index = OUTCOME_ORDER.indexOf(outcome);
  return index < 0 ? 0 : index;
}

/**
 * Combines the outcomes of two channels of the same scenario.
 *
 * A failure dominates, because a run that observed the scenario and failed
 * it contradicts a run that observed it and passed it. An observation that
 * did not happen is no observation at all, so it never dominates.
 * @param {string} a
 * @param {string} b
 * @returns {Outcome}
 */
export function combineOutcomes(a, b) {
  if (a === 'failed' || b === 'failed') return 'failed';
  if (a === 'passed' || b === 'passed') return 'passed';
  if (a === 'partial' || b === 'partial') return 'partial';
  return 'not_run';
}

/**
 * Normalizes the status of a coverage entry of a run source.
 * @param {any} status
 * @returns {Outcome}
 */
function normalizeOutcome(status) {
  if (status === 'passed') return 'passed';
  if (status === 'partial') return 'partial';
  if (status === 'failed') return 'failed';
  if (status === 'not_implemented') return 'failed';
  return 'not_run';
}

/**
 * Builds the channel of the local integration run.
 *
 * The channel observes the scenarios of the acceptance map through the
 * coverage of the run: a scenario is observed when the run mapped it, and it
 * is passed when every mapped test of the scenario ran and passed.
 *
 * The channel certifies nothing it cannot show: a run without a command
 * names no run, and a run without a green exit code certifies no pass. The
 * per-test coverage of such a run is not evidence of a pass, so the outcome
 * of every scenario of the run is capped.
 * @param {any} report
 * @param {string} [path]
 * @returns {RunChannel|null}
 */
export function integrationChannel(report, path = LOCAL_RUN_SOURCE) {
  if (!report || typeof report !== 'object') return null;
  const commit = namedString(report.commit);
  if (!commit) return null;
  const command = namedString(report.command);
  const exitCode = report.goTestExitCode;
  /** @type {Outcome} */
  const ceiling = command === null
    ? 'not_run'
    : typeof exitCode !== 'number'
      ? 'not_run'
      : exitCode === 0 ? 'passed' : 'failed';
  /** @type {Map<string, Observed>} */
  const outcomes = new Map();
  for (const entry of Array.isArray(report.coverage) ? report.coverage : []) {
    const scenarioId = namedString(entry?.scenarioId);
    if (!scenarioId) continue;
    const observed = normalizeOutcome(entry?.status);
    outcomes.set(scenarioId, {
      outcome: ceiling === 'passed' ? observed : observed === 'failed' ? 'failed' : ceiling,
      detail: typeof entry?.detail === 'string' ? entry.detail : '',
    });
  }
  return {
    id: 'local-integration',
    kind: 'local',
    path,
    commit,
    command,
    outcomes,
  };
}

/**
 * Builds the channel of the browser clients.
 *
 * The browser map names the cases that exercise a scenario. The cases prove
 * the behaviour they exercise, but the map carries no statement that they
 * cover the whole approved scenario, so the browser evidence closes a
 * scenario only when the map says that the coverage of the scenario is
 * complete. Without that statement the browser evidence is partial.
 *
 * The channel certifies nothing it cannot show: a run without a command
 * names no run, so the outcome of every scenario of the run is capped.
 * @param {any} report
 * @param {any} map
 * @param {string} [path]
 * @returns {RunChannel|null}
 */
export function browserChannel(report, map, path = LOCAL_RUN_SOURCE) {
  if (!report || typeof report !== 'object') return null;
  const browser = report.browser && typeof report.browser === 'object' ? report.browser : null;
  const commit = namedString(browser?.commit) ?? namedString(report.commit);
  if (!commit) return null;
  const command = namedString(browser?.command);
  const scenarios = map && typeof map === 'object' && map.scenarios && typeof map.scenarios === 'object'
    ? map.scenarios
    : {};
  const coverage = map && typeof map === 'object' && map.coverage && typeof map.coverage === 'object'
    ? map.coverage
    : {};
  const missingRoutes = Array.isArray(report.routes?.notImplemented) ? report.routes.notImplemented : [];
  /** @type {Map<string, Observed>} */
  const outcomes = new Map();
  for (const [scenarioId, cases] of Object.entries(scenarios)) {
    const titles = Array.isArray(cases) ? cases.filter((entry) => typeof entry === 'string' && entry.trim() !== '') : [];
    /** @type {Outcome} */
    let outcome;
    if (!browser) {
      outcome = 'not_run';
    } else if (browser.status === 'unavailable') {
      // The fixture never became ready, so no browser case ran.
      outcome = 'not_run';
    } else if (browser.status !== 'passed') {
      outcome = 'failed';
    } else if (missingRoutes.length > 0) {
      // A route the production code does not register cannot carry a browser
      // scenario either, so the browser evidence is a failure and not a pass.
      outcome = 'failed';
    } else if (!browserCasesPassed(browser, titles)) {
      outcome = 'failed';
    } else {
      outcome = coverage[scenarioId] === 'complete' ? 'passed' : 'partial';
    }
    if (command === null && outcome !== 'failed') {
      // A run that names no command certifies no pass.
      outcome = 'not_run';
    }
    outcomes.set(scenarioId, { outcome, detail: titles.join('; ') });
  }
  return {
    id: 'local-browser',
    kind: 'local',
    path,
    commit,
    command,
    outcomes,
  };
}

/**
 * Reports whether the browser cases of a scenario passed in the run.
 *
 * A run that lists its cases proves every case it lists. A run without the
 * list of its cases proved the whole suite, and the map names the cases of
 * that suite.
 * @param {any} browser
 * @param {string[]} titles
 * @returns {boolean}
 */
function browserCasesPassed(browser, titles) {
  const tests = Array.isArray(browser.tests) ? browser.tests : [];
  if (tests.length === 0) return true;
  /** @type {Map<string, any>} */
  const byTitle = new Map();
  for (const test of tests) {
    const title = namedString(test?.title);
    if (title) byTitle.set(title, test);
  }
  return titles.every((title) => {
    const test = byTitle.get(title);
    return test ? browserCasePassed(test) : false;
  });
}

/**
 * Reports whether one browser case passed.
 * @param {any} test
 * @returns {boolean}
 */
function browserCasePassed(test) {
  const status = String(test?.status ?? '');
  if (status !== 'expected' && status !== 'passed') return false;
  const outcomes = Array.isArray(test?.outcomes) ? test.outcomes.map((entry) => String(entry)) : null;
  if (!outcomes || outcomes.length === 0) return true;
  if (outcomes.some((outcome) => ['failed', 'unexpected', 'timedOut', 'interrupted', 'skipped'].includes(outcome))) return false;
  return outcomes.includes('passed');
}

/**
 * Reads the run sources of the tree.
 *
 * The run source of the local evidence is the recorded local run. It yields
 * one channel per recorded run: the database run and the browser run. A
 * channel without a commit backs nothing, because a run without a tested
 * commit describes no tree.
 * @param {string} root
 * @returns {Promise<RunSources>}
 */
export async function readRunSources(root) {
  /** @type {RunChannel[]} */
  const channels = [];
  /** @type {{path: string, problems: string[]}[]} */
  const problems = [];
  const map = await readJson(join(root, ...BROWSER_MAP.split('/')));
  if (map.error) {
    problems.push({ path: BROWSER_MAP, problems: [`the browser map is not readable JSON: ${map.error}`] });
  }
  const { body: report, error } = await readJson(join(root, ...LOCAL_RUN_SOURCE.split('/')));
  if (error) {
    problems.push({ path: LOCAL_RUN_SOURCE, problems: [`the run source is not readable JSON: ${error}`] });
    return { channels, problems };
  }
  const integration = integrationChannel(report, LOCAL_RUN_SOURCE);
  if (integration) channels.push(integration);
  const browser = browserChannel(report, map.body, LOCAL_RUN_SOURCE);
  if (browser) channels.push(browser);
  return { channels, problems };
}

/**
 * Reports what the run sources observed for a scenario at a commit.
 *
 * The commit is part of the lookup: a run that observed the scenario at
 * another commit observed another tree and says nothing about this one.
 * @param {RunSources} sources
 * @param {{kind: string, scenarioId: string, commit: string}} query
 * @returns {{outcome: Outcome, channel: RunChannel, path: string, command: string|null, detail: string}|null}
 */
export function deriveOutcome(sources, { kind, scenarioId, commit }) {
  const registered = EVIDENCE_SOURCES[kind] ?? [];
  /** @type {Outcome|null} */
  let outcome = null;
  /** @type {RunChannel|null} */
  let channel = null;
  /** @type {string[]} */
  const details = [];
  for (const candidate of sources?.channels ?? []) {
    if (!registered.includes(candidate.id)) continue;
    if (candidate.commit !== commit) continue;
    const observed = candidate.outcomes.get(scenarioId);
    if (!observed) continue;
    outcome = outcome === null ? observed.outcome : combineOutcomes(outcome, observed.outcome);
    if (!channel) channel = candidate;
    if (observed.detail) details.push(observed.detail);
  }
  if (outcome === null || !channel) return null;
  return { outcome, channel, path: channel.path, command: channel.command, detail: details.join(' | ') };
}

/**
 * Reports the commits the run sources of the tree carry.
 * @param {RunSources} sources
 * @returns {string[]}
 */
export function sourceCommits(sources) {
  const commits = new Set();
  for (const channel of sources?.channels ?? []) {
    if (channel.commit) commits.add(channel.commit);
  }
  return [...commits].sort();
}

/**
 * Checks the provenance of a record.
 *
 * A record that claims an observation needs a run source behind it. The
 * problems are the reasons why the record is not evidence.
 * @param {any} record
 * @param {RunSources} sources
 * @returns {string[]}
 */
export function provenanceProblems(record, sources) {
  /** @type {string[]} */
  const problems = [];
  const status = record?.status;
  if (status !== 'passed' && status !== 'partial') return problems;
  const kind = typeof record?.kind === 'string' ? record.kind : '';
  const scenarioId = typeof record?.scenarioId === 'string' ? record.scenarioId.trim() : '';
  const commit = typeof record?.commit === 'string' ? record.commit.trim() : '';
  const registered = EVIDENCE_SOURCES[kind] ?? [];
  if (registered.length === 0) {
    problems.push(`no verifiable run source is registered for a ${kind} run, so the record cannot close ${scenarioId}`);
    return problems;
  }
  const derived = deriveOutcome(sources, { kind, scenarioId, commit });
  if (!derived) {
    const carried = sourceCommits(sources);
    problems.push(`no run source recorded ${scenarioId} at commit ${commit}, so the record is not evidence${carried.length > 0 ? `; the run sources carry ${carried.join(', ')}` : ''}`);
    return problems;
  }
  if (!derived.command) {
    // A run that names no command certifies no pass and no partial
    // observation, so it cannot back the record.
    problems.push(`the run source ${derived.path} records no command for the ${derived.channel.id} run, so it cannot back the record`);
    return problems;
  }
  const command = normalizeCommand(record?.command);
  if (command !== normalizeCommand(derived.command)) {
    problems.push(`the record names another command than the run source ${derived.path}`);
    return problems;
  }
  if (outcomeRank(status) > outcomeRank(derived.outcome)) {
    problems.push(`the record claims ${status}, but the run source ${derived.path} recorded ${derived.outcome} for ${scenarioId} at commit ${commit}`);
  }
  return problems;
}

/**
 * Builds the records of a run.
 *
 * The records are built from the same channels the ledger reads, so a run
 * never writes a claim that the ledger refuses. One record per scenario:
 * the database run observes a scenario first, and the browser run confirms
 * it or fails it.
 * @param {{report: any, contract: any, browserMap: any}} input
 * @returns {{scenarioId: string, status: string, kind: string, commit: string, command: string, expected: string, actual: string, notes: string}[]}
 */
export function buildEvidenceRecords({ report, contract, browserMap }) {
  const integration = integrationChannel(report);
  const browser = browserChannel(report, browserMap);
  /** @type {Map<string, any>} */
  const records = new Map();
  const scenarioOf = (scenarioId) => contract?.cases?.find((entry) => entry.id === scenarioId);

  for (const entry of Array.isArray(report?.coverage) ? report.coverage : []) {
    const scenarioId = namedString(entry?.scenarioId);
    if (!scenarioId) continue;
    const observed = integration?.outcomes.get(scenarioId);
    if (!observed || observed.outcome === 'not_run') continue;
    const scenario = scenarioOf(scenarioId);
    records.set(scenarioId, {
      scenarioId,
      status: observed.outcome,
      kind: 'local',
      commit: integration.commit,
      command: integration.command ?? '',
      expected: scenario?.scenario ?? '',
      actual: entry?.status === 'not_implemented'
        ? `The scenario is not implemented: ${observed.detail}.`
        : `${observed.detail} against ${report.database} with the pinned rules worker bundle.`,
      notes: 'Local evidence only. It does not certify a native run, a live host or a released cohort.',
    });
  }

  for (const scenarioId of Object.keys(browserMap?.scenarios ?? {})) {
    const observed = browser?.outcomes.get(scenarioId);
    if (!observed) continue;
    const existing = records.get(scenarioId);
    if (existing) {
      // The browser run confirms the scenario or fails it. It never raises
      // the status of the database evidence.
      const combined = combineOutcomes(existing.status, observed.outcome);
      if (combined !== existing.status) {
        existing.status = combined;
        existing.actual = `${existing.actual} The browser run did not pass, so this scenario carries no passing evidence: ${observed.detail}.`;
        existing.notes = `${existing.notes} The browser run did not pass, so this scenario carries no passing evidence.`;
      }
      continue;
    }
    if (observed.outcome === 'not_run') continue;
    const scenario = scenarioOf(scenarioId);
    records.set(scenarioId, {
      scenarioId,
      status: observed.outcome,
      kind: 'local',
      commit: browser.commit,
      command: browser.command ?? '',
      expected: scenario?.scenario ?? '',
      actual: observed.outcome === 'passed'
        ? `The browser cases passed against the real service and the map states that they cover the scenario: ${observed.detail}.`
        : observed.outcome === 'partial'
          ? `The browser cases passed against the real service, but they cover part of the approved scenario: ${observed.detail}.`
          : `The browser run did not pass, so this scenario carries no passing evidence: ${observed.detail}.`,
      notes: observed.outcome === 'failed'
        ? 'The browser run did not pass, so this record is a failure and not a pass.'
        : 'Local browser evidence. It does not certify a native assistive-technology run, a live host or a released cohort.',
    });
  }

  return [...records.values()];
}
