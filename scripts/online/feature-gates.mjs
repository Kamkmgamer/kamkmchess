// Release gates for the friend cohort and the public queue.
//
// Two independent gates. Each one answers the same question from recorded
// material: may this surface be opened to the recorded cohort, and what exactly
// has to happen, in which order, and how is it undone?
//
// The gate never opens a surface. It reads configuration, evidence and
// decisions, and it prints a packet an operator and the owner can act on.
//
// The public queue is a separate gate with a separate decision. Enabling the
// queue requires an accepted friend cohort first, but it never adds an owner
// game cap.
//
// Usage:
//   node scripts/online/feature-gates.mjs evaluate --gate friend [--json]
//   node scripts/online/feature-gates.mjs evaluate --gate queue [--json]
//   node scripts/online/feature-gates.mjs packet --gate friend [--json]

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { auditBackupCoverage } from './backup-coverage.mjs';
import { buildEvidenceLedger } from './evidence-ledger.mjs';
import { auditGrants, loadTree } from '../../deploy/runtime-grants.mjs';

/**
 * @typedef {'met'|'unmet'|'external'} RequirementStatus
 * @typedef {{ id: string, title: string, status: RequirementStatus, detail: string, remediation: string|null }} Requirement
 */

/** The scenarios each gate depends on. */
export const GATE_SCENARIOS = {
  friend: {
    local: ['FRI-01', 'FRI-02', 'FRI-03', 'FRI-04', 'MAT-01', 'MAT-02', 'MAT-03', 'MAT-04', 'MAT-07', 'MAT-09', 'MAT-10', 'MAT-11', 'MAT-12', 'ARC-02', 'ARC-03', 'ARC-04', 'ARC-06', 'ARC-07', 'ARC-08', 'ARC-09', 'ARC-11', 'HIS-10'],
    native: ['UX-02', 'UX-03', 'UX-04', 'UX-05', 'UX-06'],
    host: ['ARC-05', 'ARC-12', 'ARC-13', 'ARC-14', 'HIS-06', 'HIS-07'],
  },
  queue: {
    local: ['QUE-01', 'QUE-03', 'QUE-09', 'QUE-11', 'QUE-12'],
    native: [],
    host: ['ARC-14'],
  },
};

/**
 * @param {string} id
 * @param {string} title
 * @param {RequirementStatus} status
 * @param {string} detail
 * @param {string|null} [remediation]
 * @returns {Requirement}
 */
function requirement(id, title, status, detail, remediation = null) {
  return { id, title, status, detail, remediation };
}

/**
 * Reads an optional JSON file.
 * @param {string} path
 * @returns {Promise<any|null>}
 */
async function readOptional(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Evaluates the requirements that do not depend on the evidence ledger.
 * @param {{gate: string, root: string, decision: any, cohort: any, host: any}} input
 * @returns {Promise<Requirement[]>}
 */
export async function evaluateRequirements(input) {
  /** @type {Requirement[]} */
  const requirements = [];

  const decision = input.decision;
  if (!decision) {
    requirements.push(requirement(
      'release-decision',
      'the recorded owner release decision',
      'unmet',
      'No release decision is recorded for this gate.',
      `Record the owner decision in docs/evidence/online/release-decisions/${input.gate}.json with the decision, the approver, the date and the tested commit.`,
    ));
  } else if (decision.decision !== 'approved') {
    requirements.push(requirement(
      'release-decision',
      'the recorded owner release decision',
      'unmet',
      `The recorded decision is "${decision.decision ?? 'unknown'}", not an approval.`,
      'Only an approved decision opens a gate.',
    ));
  } else if (!decision.commit || !decision.approver || !decision.decidedAt) {
    requirements.push(requirement(
      'release-decision',
      'the recorded owner release decision',
      'unmet',
      'The recorded decision names no approver, date or tested commit.',
      'Complete the decision record before the gate can open.',
    ));
  } else {
    requirements.push(requirement(
      'release-decision',
      'the recorded owner release decision',
      'met',
      `Approved by ${decision.approver} on ${decision.decidedAt} for commit ${decision.commit}.`,
    ));
  }

  const cohort = input.cohort;
  if (!cohort || !Array.isArray(cohort.accounts) || cohort.accounts.length === 0) {
    requirements.push(requirement(
      'cohort',
      'the recorded opt-in cohort',
      'unmet',
      'No cohort is recorded, so no opt-in cohort exists.',
      `Record the cohort accounts in docs/evidence/online/release-decisions/${input.gate}-cohort.json.`,
    ));
  } else {
    requirements.push(requirement(
      'cohort',
      'the recorded opt-in cohort',
      'met',
      `The cohort names ${cohort.accounts.length} account(s).`,
    ));
  }

  const host = input.host;
  if (!host) {
    requirements.push(requirement(
      'host-verification',
      'the host verification record',
      'external',
      'No host verification record exists. Apache flushing, TLS, CORS, private worker reachability and capacity are measured on the host, not locally.',
      'Record the host verification in docs/evidence/online/KHA-83-host.json with the environment identifiers and the sanitized results.',
    ));
  } else if (host.status !== 'verified') {
    requirements.push(requirement(
      'host-verification',
      'the host verification record',
      'external',
      `The host record reports "${host.status ?? 'unknown'}".`,
      'Complete the host verification before the cohort opens.',
    ));
  } else {
    requirements.push(requirement(
      'host-verification',
      'the host verification record',
      'met',
      `The host was verified on ${host.verifiedAt ?? 'an unrecorded date'} for commit ${host.commit ?? 'an unrecorded commit'}.`,
    ));
  }

  const backup = await auditBackupCoverage(input.root);
  const backupBlockers = backup.findings.filter((item) => item.severity === 'blocker');
  requirements.push(requirement(
    'backup-coverage',
    'backup coverage and the removal ledger',
    backupBlockers.length === 0 ? 'met' : 'unmet',
    backupBlockers.length === 0
      ? 'The backup covers the whole database and the restore reapplies the removal ledger.'
      : backupBlockers.map((item) => item.message).join(' '),
    backupBlockers.length === 0 ? null : 'Fix the reported backup findings before a cohort opens.',
  ));

  const tree = await loadTree(input.root);
  const grantFindings = auditGrants(tree);
  const grantBlockers = grantFindings.filter((item) => item.severity === 'blocker');
  requirements.push(requirement(
    'runtime-grants',
    'the least-privilege runtime grants',
    grantBlockers.length === 0 ? 'met' : 'unmet',
    grantBlockers.length === 0
      ? `The runtime policy grants the ${tree.tables.length} migrated tables exactly what the writer uses.`
      : grantBlockers.map((item) => item.message).join(' '),
    grantBlockers.length === 0 ? null : 'Fix the reported grant findings.',
  ));

  return requirements;
}

/**
 * Evaluates the evidence ledger part of a gate.
 * @param {Awaited<ReturnType<typeof buildEvidenceLedger>>} ledger
 * @param {string} gate
 * @returns {Requirement[]}
 */
export function evaluateEvidence(ledger, gate) {
  const definition = GATE_SCENARIOS[gate];
  /** @type {Requirement[]} */
  const requirements = [];
  /** @type {Record<string, {missing: string[], failed: string[], wrongKind: string[]}>} */
  const groups = {
    local: { missing: [], failed: [], wrongKind: [] },
    native: { missing: [], failed: [], wrongKind: [] },
    host: { missing: [], failed: [], wrongKind: [] },
  };
  for (const [group, scenarios] of Object.entries(definition)) {
    for (const scenario of scenarios) {
      const entry = ledger.cases.find((item) => item.id === scenario);
      if (!entry) {
        groups[group].missing.push(scenario);
        continue;
      }
      if (entry.status !== 'passed') {
        groups[group].failed.push(`${scenario} (${entry.status})`);
        continue;
      }
      const expectedKind = group === 'local' ? 'local' : group === 'native' ? 'native' : 'host';
      if (entry.kind !== expectedKind && !(expectedKind === 'local' && entry.kind === 'host')) {
        groups[group].wrongKind.push(`${scenario} (${entry.kind})`);
      }
    }
  }
  const describe = (group) => {
    const state = groups[group];
    if (state.missing.length > 0) return `No evidence is recorded for ${state.missing.join(', ')}.`;
    if (state.failed.length > 0) return `The evidence is not passing for ${state.failed.join(', ')}.`;
    if (state.wrongKind.length > 0) return `These scenarios need another evidence kind and have ${state.wrongKind.join(', ')}.`;
    return null;
  };

  const localProblem = describe('local');
  requirements.push(requirement(
    'local-evidence',
    'the recorded local evidence',
    localProblem ? 'unmet' : 'met',
    localProblem ?? 'Every local scenario of this gate has passing evidence.',
    localProblem ? 'Run the integration suite and record the missing evidence.' : null,
  ));
  if (definition.native.length > 0) {
    const nativeProblem = describe('native');
    requirements.push(requirement(
      'native-evidence',
      'the recorded native assistive-technology evidence',
      nativeProblem ? 'unmet' : 'met',
      nativeProblem ?? 'Every native scenario of this gate has a native run.',
      nativeProblem ? 'Run the flows on the real devices with the real assistive technology.' : null,
    ));
  }
  if (definition.host.length > 0) {
    const hostProblem = describe('host');
    requirements.push(requirement(
      'host-evidence',
      'the recorded host evidence',
      hostProblem ? 'external' : 'met',
      hostProblem ?? 'Every host scenario of this gate has a host record.',
      hostProblem ? 'Measure the host and record the sanitized result.' : null,
    ));
  }
  return requirements;
}

/**
 * Evaluates one gate.
 * @param {{gate: string, root: string}} options
 * @returns {Promise<{gate: string, status: 'ready'|'blocked', requirements: Requirement[]}>}
 */
export async function evaluateGate(options) {
  const { gate, root } = options;
  if (!GATE_SCENARIOS[gate]) throw new Error(`unknown gate ${gate}`);
  const ledger = await buildEvidenceLedger(root);
  const decision = await readOptional(join(root, 'docs', 'evidence', 'online', 'release-decisions', `${gate}.json`));
  const cohort = await readOptional(join(root, 'docs', 'evidence', 'online', 'release-decisions', `${gate}-cohort.json`));
  const host = await readOptional(join(root, 'docs', 'evidence', 'online', 'KHA-83-host.json'));

  const requirements = [
    ...(await evaluateRequirements({ gate, root, decision, cohort, host })),
    ...evaluateEvidence(ledger, gate),
  ];
  if (gate === 'queue') {
    const friendCohort = await readOptional(join(root, 'docs', 'evidence', 'online', 'release-decisions', 'friend-cohort.json'));
    const friendRun = await readOptional(join(root, 'docs', 'evidence', 'online', 'KHA-84-friend-run.json'));
    requirements.push(requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      friendCohort && friendRun ? 'met' : 'unmet',
      friendCohort && friendRun
        ? 'The friend cohort ran and its outcome was recorded.'
        : 'The public queue needs an accepted friend cohort run before it opens.',
      'Record the friend cohort run in docs/evidence/online/KHA-84-friend-run.json.',
    ));
  }

  const blocked = requirements.some((item) => item.status !== 'met');
  return { gate, status: blocked ? 'blocked' : 'ready', requirements };
}

/**
 * Builds the reversible rollout packet for a gate.
 * @param {string} gate
 * @param {{root: string, evaluation: Awaited<ReturnType<typeof evaluateGate>>}} input
 * @returns {object}
 */
export function buildPacket(gate, { evaluation }) {
  const variable = gate === 'friend' ? 'ONLINE_FRIEND_ENABLED' : 'ONLINE_QUEUE_ENABLED';
  return {
    gate,
    generatedFor: 'operator review; this packet is never applied by a tool',
    testedCommit: evaluation.requirements.find((item) => item.id === 'release-decision')?.detail ?? null,
    preconditions: evaluation.requirements.map((item) => ({
      id: item.id,
      status: item.status,
      requirement: item.title,
      detail: item.detail,
    })),
    configuration: {
      surface: variable,
      value: 'true',
      note: 'The surface is opened by the server switch. The cohort narrows which accounts may use it.',
      cohort: gate === 'friend' ? 'ONLINE_FRIEND_COHORT' : 'ONLINE_QUEUE_COHORT',
      note2: 'The cohort is an allowlist of accounts. A guest is never excluded by the cohort, because a guest must be able to create and accept a friend link.',
    },
    verification: [
      'GET /v1/online/features reports the switch state.',
      'A cohort account creates an invitation and a guest accepts it.',
      'The queue entries report their window, allocation and fallback.',
      'The removal ledger and the backup rehearsal stay green.',
    ],
    monitoring: [
      'Accepted matches, aborted matches and the failure reason of each command.',
      'The number of open update streams and the database connections they hold.',
      'Queue entries that reach their cutoff without an allocation.',
      'Removal requests and the age of the oldest unreplayed removal.',
    ],
    rollback: {
      action: `Set ${variable}=false in the server configuration and restart the API container.`,
      effect: 'New creations stop immediately. Running matches continue, results stay final, issued guest credentials stay valid until they expire.',
      irreversible: false,
      steps: [
        `Set ${variable}=false and reload the API container.`,
        'Confirm GET /v1/online/features reports the surface as closed.',
        'Confirm running matches still answer and no new match is created.',
        'Keep the cohort list for the next attempt and record the reason in the evidence.',
      ],
    },
    blastRadius: gate === 'friend'
      ? 'Friend invitations, link joins and rematches. Offline play, the account storage API and the public queue are unaffected.'
      : 'Public queue entries, allocations and the Stockfish fallback. Friend play and offline play are unaffected.',
    stopCondition: 'Stop or roll back on a material failure: a wrong result, a lost or duplicated move, a privacy leak, an unbounded growth of open streams or a database pool that cannot keep up.',
  };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const mode = arguments_[0] ?? 'evaluate';
  const gateIndex = arguments_.indexOf('--gate');
  const gate = gateIndex >= 0 ? arguments_[gateIndex + 1] : 'friend';
  const rootIndex = arguments_.indexOf('--root');
  const root = rootIndex >= 0 ? arguments_[rootIndex + 1] : process.cwd();

  const evaluation = await evaluateGate({ gate, root });
  const payload = mode === 'packet'
    ? buildPacket(gate, { evaluation })
    : evaluation;

  if (arguments_.includes('--json')) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (mode === 'packet') {
    process.stdout.write(`rollout packet for the ${gate} gate (${evaluation.status})\n`);
    process.stdout.write(`  configuration: ${payload.configuration.surface}=true, cohort ${payload.configuration.cohort}\n`);
    process.stdout.write(`  rollback: ${payload.rollback.action}\n`);
    process.stdout.write(`  rollback is irreversible: ${payload.rollback.irreversible}\n`);
    process.stdout.write(`  blast radius: ${payload.blastRadius}\n`);
    for (const precondition of payload.preconditions) {
      process.stdout.write(`  ${precondition.status.toUpperCase().padEnd(8)} ${precondition.id}: ${precondition.detail}\n`);
    }
  } else {
    process.stdout.write(`${gate} gate: ${evaluation.status}\n`);
    for (const item of evaluation.requirements) {
      process.stdout.write(`  ${item.status.toUpperCase().padEnd(8)} ${item.id}: ${item.detail}\n`);
      if (item.remediation) process.stdout.write(`           fix: ${item.remediation}\n`);
    }
  }
  if (evaluation.status === 'blocked' && mode !== 'packet') process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/online/feature-gates.mjs')) {
  await main();
}
