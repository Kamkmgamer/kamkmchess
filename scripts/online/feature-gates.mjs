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
// The account subjects of a cohort are private. They live in one protected
// operator input outside the tracked tree, and the gate carries only the
// count and the commitment of the set. No report, no packet and no line of
// stdout of this tool ever names an account subject.
//
// Usage:
//   node scripts/online/feature-gates.mjs evaluate --gate friend [--json]
//   node scripts/online/feature-gates.mjs evaluate --gate queue [--json]
//   node scripts/online/feature-gates.mjs packet --gate friend [--json]

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { auditBackupCoverage } from './backup-coverage.mjs';
import { auditCohortEnforcement, COHORT_SETTINGS } from './cohort-enforcement.mjs';
import {
  COHORT_COMMITMENT_ALGORITHM,
  commitmentOfAccounts,
  isSupportedAlgorithm,
  readCommitment,
  readGateProtectedCohort,
} from './cohort-commitment.mjs';
import { buildEvidenceLedger } from './evidence-ledger.mjs';
import { auditGrants, loadTree } from '../../deploy/runtime-grants.mjs';

/**
 * @typedef {'met'|'unmet'|'external'} RequirementStatus
 * @typedef {{ id: string, title: string, status: RequirementStatus, detail: string, remediation: string|null }} Requirement
 * @typedef {{
 *   gate: string,
 *   source: string,
 *   present: boolean,
 *   invalid: boolean,
 *   refused: boolean,
 *   count: number,
 *   commitment: string|null,
 *   algorithm: string,
 *   evidence: any,
 *   evidenceCommitment: string|null,
 *   evidenceCount: number|null,
 *   evidenceHasRawAccounts: boolean,
 * }} CohortMaterial
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
 * Reads an optional JSON record and reports why it is unusable.
 *
 * A record that is missing, a record that is not JSON and a record that is
 * JSON of another shape are three different problems, and the gate has to
 * tell them apart: the remediation of a missing record is not the remediation
 * of a broken one, and a broken record is not a record at all.
 * @param {string} path
 * @returns {Promise<{present: boolean, valid: boolean, body: any}>}
 */
export async function readEvidenceRecord(path) {
  /** @type {string} */
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { present: false, valid: false, body: null };
  }
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { present: true, valid: false, body: null };
    }
    return { present: true, valid: true, body };
  } catch {
    return { present: true, valid: false, body: null };
  }
}

/**
 * Reports whether a value is a non-empty string.
 * @param {any} value
 * @returns {boolean}
 */
function isNamed(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Reports whether a value is the count of a cohort.
 *
 * The count of a set is public: it is the number of accounts of the set, so
 * a report may carry it. It is also part of the record of a cohort, so a
 * commitment without a count does not prove the size of the set. The count
 * has to be a positive integer, so an absent count, a count that is not an
 * integer, a zero and a negative number are all no count at all.
 * @param {any} value
 * @returns {boolean}
 */
function isCohortCount(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * Reports whether a record carries the account subjects of a cohort.
 *
 * The subjects are private: they live in the protected operator input and in
 * the server configuration, and a record of the evidence tree carries the
 * count and the commitment of the set instead.
 * @param {any} record
 * @returns {boolean}
 */
function carriesAccountSubjects(record) {
  if (!record || typeof record !== 'object') return false;
  if (Array.isArray(record.accounts) && record.accounts.length > 0) return true;
  const cohort = record.cohort;
  if (cohort && typeof cohort === 'object' && Array.isArray(cohort.accounts) && cohort.accounts.length > 0) return true;
  return false;
}

/**
 * Evaluates the requirements that do not depend on the evidence ledger.
 * @param {{gate: string, root: string, decision: any, cohort: CohortMaterial, host: any}} input
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
  requirements.push(recordedCohortRequirement(input.gate, cohort));
  requirements.push(runtimeCohortRequirement(input.gate, { recorded: cohort, host: input.host }));

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
 * The path of the recorded evidence of a cohort, relative to the root.
 * @param {string} gate
 * @returns {string}
 */
export function cohortEvidencePath(gate) {
  return `docs/evidence/online/release-decisions/${gate}-cohort.json`;
}

const COHORT_SOURCE_LABEL = 'the protected operator input';

/**
 * A fixed safe label for the protected operator input.
 *
 * A filename or path component may itself be private, so reports never carry
 * any part of the input path.
 * @param {string} root
 * @param {string} path
 * @returns {string}
 */
export function cohortSource(root, path) {
  void root;
  void path;
  return COHORT_SOURCE_LABEL;
}

/**
 * Reads the cohort material of a gate.
 *
 * The material is in two places and only one of them carries an identifier.
 *
 * The protected operator input carries the account subjects of the cohort.
 * It lives outside the tracked tree, it is read here and it is never
 * reported: the gate keeps the count and the commitment of the set and
 * drops the subjects.
 *
 * The recorded evidence carries the commitment and the count of the same
 * set. It is the part an owner can review and a reviewer can check, and it
 * never names an account subject.
 * @param {string} root
 * @param {string} gate
 * @param {{cohortInput?: string|null}} [options]
 * @returns {Promise<CohortMaterial>}
 */
export async function readCohortMaterial(root, gate, options = {}) {
  const protectedInput = await readGateProtectedCohort({ root, gate, input: options.cohortInput ?? null });
  const evidence = await readOptional(join(root, 'docs', 'evidence', 'online', 'release-decisions', `${gate}-cohort.json`));
  const commitment = commitmentOfAccounts(protectedInput.accounts);
  const recorded = readCommitment(evidence);
  const source = cohortSource(root, protectedInput.path);
  return {
    gate,
    source,
    present: protectedInput.present,
    invalid: protectedInput.invalid,
    refused: protectedInput.refused,
    count: commitment?.count ?? 0,
    commitment: commitment?.commitment ?? null,
    algorithm: COHORT_COMMITMENT_ALGORITHM,
    evidence,
    evidenceCommitment: recorded?.commitment ?? null,
    evidenceCount: recorded?.count ?? null,
    evidenceHasRawAccounts: Array.isArray(evidence?.accounts) && evidence.accounts.length > 0,
  };
}

/**
 * Builds the requirement of the recorded opt-in cohort.
 *
 * The recorded cohort is the set of accounts the owner opted in. It is
 * private: the account subjects live in the protected operator input and the
 * evidence carries only the count and the commitment of the set.
 *
 * The evidence has to carry the count as well as the commitment: the count
 * is the public size of the set, and a record that carries a commitment and
 * no count has not recorded it. An absent count, a count that is not an
 * integer, a zero and a negative number are all unmet requirements.
 *
 * The evidence has to carry the algorithm as well. The algorithm is the
 * evidence of how the commitment was made, so it is never assumed: a record
 * that names no algorithm and a record that names another algorithm are both
 * unmet requirements, even when the commitment and the count match.
 *
 * The recorded cohort is not the enforcement of the cohort: a file that names
 * a commitment proves nothing about the running server, so the enforcement
 * is a requirement of its own.
 * @param {string} gate
 * @param {CohortMaterial} cohort
 * @returns {Requirement}
 */
export function recordedCohortRequirement(gate, cohort) {
  if (!cohort) {
    return requirement(
      'cohort',
      'the recorded opt-in cohort',
      'unmet',
      'No cohort is recorded, so no opt-in cohort exists.',
      `Record the cohort in the protected operator input and its commitment in ${cohortEvidencePath(gate)}.`,
    );
  }
  if (cohort.refused) {
    return requirement(
      'cohort',
      'the recorded opt-in cohort',
      'unmet',
      'The protected operator input lies inside the tracked tree. The account subjects are private, so a protected input may never be committed.',
      `Move the protected operator input outside the tracked tree and point the gate at it with --cohort-input.`,
    );
  }
  if (!cohort.present) {
    return requirement(
      'cohort',
      'the recorded opt-in cohort',
      'unmet',
      'The protected operator input is missing, so no cohort is recorded.',
      `Record the account subjects in the protected operator input at ${cohort.source} and the commitment of the set in ${cohortEvidencePath(gate)}.`,
    );
  }
  if (cohort.invalid) {
    return requirement(
      'cohort',
      'the recorded opt-in cohort',
      'unmet',
      'The protected operator input names no account, so it names no cohort.',
      `Record the account subjects in the protected operator input at ${cohort.source}.`,
    );
  }
  if (cohort.evidenceHasRawAccounts) {
    return requirement(
      'cohort',
      'the recorded opt-in cohort',
      'unmet',
      'The recorded evidence carries the account subjects of the cohort. The subjects are private and they belong in the protected operator input, never in the evidence tree.',
      `Replace the accounts of ${cohortEvidencePath(gate)} with the count and the commitment of the set.`,
    );
  }
  if (!cohort.evidence) {
    return requirement(
      'cohort',
      'the recorded opt-in cohort',
      'unmet',
      'No commitment of the cohort is recorded in the evidence tree.',
      `Record the count and the commitment of the set in ${cohortEvidencePath(gate)}.`,
    );
  }
  if (!isNamed(cohort.evidence?.commitment)) {
    return requirement(
      'cohort',
      'the recorded opt-in cohort',
      'unmet',
      'The recorded evidence names no commitment of the cohort, so it proves nothing about the protected operator input.',
      `Record the count and the commitment of the set in ${cohortEvidencePath(gate)}.`,
    );
  }
  if (!isNamed(cohort.evidence?.algorithm)) {
    return requirement(
      'cohort',
      'the recorded opt-in cohort',
      'unmet',
      'The recorded evidence names no algorithm of the commitment, so it proves nothing about the protected operator input. A record that names no algorithm is no record of a cohort at all.',
      `Record the algorithm, the commitment and the count of the set in ${cohortEvidencePath(gate)}.`,
    );
  }
  if (!isSupportedAlgorithm(cohort.evidence.algorithm)) {
    return requirement(
      'cohort',
      'the recorded opt-in cohort',
      'unmet',
      `The recorded evidence names another algorithm than ${COHORT_COMMITMENT_ALGORITHM}, so the two commitments are not comparable.`,
      `Record the evidence with ${COHORT_COMMITMENT_ALGORITHM} in ${cohortEvidencePath(gate)}.`,
    );
  }
  if (!cohort.evidenceCommitment) {
    return requirement(
      'cohort',
      'the recorded opt-in cohort',
      'unmet',
      'The recorded evidence names no commitment of the cohort, so it proves nothing about the protected operator input.',
      `Record the count and the commitment of the set in ${cohortEvidencePath(gate)}.`,
    );
  }
  if (cohort.evidenceCommitment !== cohort.commitment) {
    return requirement(
      'cohort',
      'the recorded opt-in cohort',
      'unmet',
      'The recorded commitment does not match the protected operator input, so the evidence describes another set of accounts than the recorded one.',
      `Record the commitment of the set of ${cohort.source} in ${cohortEvidencePath(gate)}.`,
    );
  }
  if (!isCohortCount(cohort.evidenceCount)) {
    return requirement(
      'cohort',
      'the recorded opt-in cohort',
      'unmet',
      'The recorded evidence names no count of the cohort, so the size of the recorded set is unproven. A count that is absent, that is not an integer or that is not a positive number is no count at all.',
      `Record the count of the set of ${cohort.source} in ${cohortEvidencePath(gate)}.`,
    );
  }
  if (cohort.evidenceCount !== cohort.count) {
    return requirement(
      'cohort',
      'the recorded opt-in cohort',
      'unmet',
      'The recorded count does not match the protected operator input, so the evidence describes another set of accounts than the recorded one.',
      `Record the count of the set of ${cohort.source} in ${cohortEvidencePath(gate)}.`,
    );
  }
  return requirement(
    'cohort',
    'the recorded opt-in cohort',
    'met',
    `The cohort names ${cohort.count} account(s) and the evidence carries the commitment of that set. The account subjects are private: they stay in the protected operator input and the gate never reports one. The recorded set is not the enforcement of the cohort: the server has to narrow the account access itself, and that is a separate requirement of this gate.`,
  );
}

/**
 * Builds the requirement of the runtime cohort.
 *
 * The recorded cohort is the set of accounts the owner opted in, and the
 * runtime cohort is the set the running server actually carries. A packet
 * that names a setting without the cohort of the server would let an
 * operator believe that the access is restricted while the running server
 * admits every signed-in account, so the gate requires the runtime cohort to
 * be measured and to match the recorded one.
 *
 * The two sets are compared by their commitment, never by their members: the
 * gate holds no account subject of either side. The commitment of a set is
 * the digest of its canonical form, so two commitments are equal exactly
 * when the two sets of accounts are equal.
 *
 * The measured cohort has to carry the count as well as the commitment: the
 * count is the public size of the cohort, and a host record that carries a
 * commitment and no count has not measured it. An absent count, a count that
 * is not an integer, a zero and a negative number are all unmet requirements.
 *
 * The requirement is never satisfied by a file that does not exist: an
 * unknown runtime cohort is an unmet requirement, and the gate stays blocked.
 * @param {string} gate
 * @param {{recorded: CohortMaterial, host: any}} input
 * @returns {Requirement}
 */
export function runtimeCohortRequirement(gate, input) {
  const recorded = input.recorded;
  if (!recorded || recorded.count === 0 || !recorded.commitment) {
    return requirement(
      'runtime-cohort',
      'the runtime cohort of the host',
      'unmet',
      'No cohort is recorded, so there is no runtime cohort to measure. An unset cohort setting admits every signed-in account.',
      `Record the cohort in the protected operator input at ${recorded?.source ?? 'the protected operator input'} and measure the cohort of the running server.`,
    );
  }
  const host = input.host;
  if (!host) {
    return requirement(
      'runtime-cohort',
      'the runtime cohort of the host',
      'unmet',
      'No host record exists, so the cohort of the running server is unknown. The gate may not open a surface whose runtime cohort was never measured.',
      'Record the commitment and the count of the cohort of the running server in the cohort field of docs/evidence/online/KHA-83-host.json.',
    );
  }
  if (host.status !== 'verified') {
    return requirement(
      'runtime-cohort',
      'the runtime cohort of the host',
      'unmet',
      `The host record reports "${host.status ?? 'unknown'}", so the cohort of the running server is unverified.`,
      'Complete the host verification before a cohort opens.',
    );
  }
  const runtime = host.cohort && typeof host.cohort === 'object' ? host.cohort : null;
  if (!runtime) {
    return requirement(
      'runtime-cohort',
      'the runtime cohort of the host',
      'unmet',
      'The host record names no runtime cohort, so the gate cannot prove that the running server narrows the account access to the recorded cohort.',
      'Record the commitment and the count of the cohort of the running server in the cohort field of docs/evidence/online/KHA-83-host.json.',
    );
  }
  if (Array.isArray(runtime.accounts) && runtime.accounts.length > 0) {
    return requirement(
      'runtime-cohort',
      'the runtime cohort of the host',
      'unmet',
      'The host record carries the account subjects of the runtime cohort. The subjects are private, so the record carries the commitment and the count of the set instead.',
      'Replace the accounts of the cohort field of docs/evidence/online/KHA-83-host.json with the count and the commitment of the set.',
    );
  }
  if (!isNamed(runtime.commitment)) {
    return requirement(
      'runtime-cohort',
      'the runtime cohort of the host',
      'unmet',
      'The host record names no commitment of the runtime cohort, so the gate cannot prove that the running server narrows the account access to the recorded cohort.',
      'Record the commitment and the count of the cohort of the running server in the cohort field of docs/evidence/online/KHA-83-host.json.',
    );
  }
  if (!isNamed(runtime.algorithm)) {
    return requirement(
      'runtime-cohort',
      'the runtime cohort of the host',
      'unmet',
      'The host record names no algorithm of the commitment of the runtime cohort, so the gate cannot prove that the running server narrows the account access to the recorded cohort. A record that names no algorithm is no record of a cohort at all.',
      'Record the algorithm, the commitment and the count of the cohort of the running server in the cohort field of docs/evidence/online/KHA-83-host.json.',
    );
  }
  if (!isSupportedAlgorithm(runtime.algorithm)) {
    return requirement(
      'runtime-cohort',
      'the runtime cohort of the host',
      'unmet',
      `The host record was measured with another algorithm than ${COHORT_COMMITMENT_ALGORITHM}, so the two commitments are not comparable.`,
      `Measure the cohort of the running server with ${COHORT_COMMITMENT_ALGORITHM}.`,
    );
  }
  const measured = readCommitment(runtime);
  if (!measured) {
    return requirement(
      'runtime-cohort',
      'the runtime cohort of the host',
      'unmet',
      'The host record names no commitment of the runtime cohort, so the gate cannot prove that the running server narrows the account access to the recorded cohort.',
      'Record the commitment and the count of the cohort of the running server in the cohort field of docs/evidence/online/KHA-83-host.json.',
    );
  }
  if (measured.algorithm !== recorded.algorithm) {
    return requirement(
      'runtime-cohort',
      'the runtime cohort of the host',
      'unmet',
      'The runtime cohort of the host was measured with another algorithm, so the two commitments are not comparable.',
      `Measure the cohort of the running server with ${recorded.algorithm}.`,
    );
  }
  if (measured.commitment !== recorded.commitment) {
    return requirement(
      'runtime-cohort',
      'the runtime cohort of the host',
      'unmet',
      'The runtime cohort of the host does not match the recorded cohort. The server would narrow the account access to another set of accounts than the one the owner recorded.',
      'Set the cohort of the server to the recorded accounts and measure the running server again.',
    );
  }
  if (!isCohortCount(measured.count)) {
    return requirement(
      'runtime-cohort',
      'the runtime cohort of the host',
      'unmet',
      'The host record names no count of the runtime cohort, so the size of the cohort of the running server is unmeasured. A count that is absent, that is not an integer or that is not a positive number is no count at all.',
      'Record the commitment and the count of the cohort of the running server in the cohort field of docs/evidence/online/KHA-83-host.json.',
    );
  }
  if (measured.count !== recorded.count) {
    return requirement(
      'runtime-cohort',
      'the runtime cohort of the host',
      'unmet',
      'The runtime cohort of the host does not match the recorded cohort. The server would narrow the account access to another set of accounts than the one the owner recorded.',
      'Set the cohort of the server to the recorded accounts and measure the running server again.',
    );
  }
  return requirement(
    'runtime-cohort',
    'the runtime cohort of the host',
    'met',
    `The runtime cohort of the host carries the ${recorded.count} recorded account(s). The two sets were compared by their commitment, so no account subject of either side was read into the report.`,
  );
}

/**
 * Builds the requirement of the enforced cohort.
 *
 * The recorded cohort and the enforced cohort are two different things. The
 * recorded cohort names the accounts of the opt-in, and a file that names
 * them proves nothing about the running server: the enforcement is its own
 * requirement, and it is only met when the audit observed it.
 * @param {string} gate
 * @param {{findings: {severity: string, message: string}[], tests: string[]}} enforcement
 * @returns {Requirement}
 */
export function cohortEnforcementRequirement(gate, enforcement) {
  const blockers = enforcement.findings.filter((item) => item.severity === 'blocker');
  const settings = enforcement.settings ?? [COHORT_SETTINGS[gate]];
  return requirement(
    'cohort-enforcement',
    'the enforced account cohort',
    blockers.length === 0 ? 'met' : 'unmet',
    blockers.length === 0
      ? `The enforcement tests of the tree passed and the proof of the composition proved that the cohort of ${settings.join(' and ')} reaches the request path of the surface.`
      : blockers.map((item) => item.message).join(' '),
    blockers.length === 0 ? null : 'Wire the cohort into the request path of the surface and make the enforcement tests of the tree pass.',
  );
}

/**
 * The evidence path of the accepted friend cohort run, relative to the root.
 */
export const FRIEND_RUN_EVIDENCE_PATH = 'docs/evidence/online/KHA-84-friend-run.json';

/**
 * The evidence path of the recorded friend cohort, relative to the root.
 */
export const FRIEND_COHORT_EVIDENCE_PATH = 'docs/evidence/online/release-decisions/friend-cohort.json';

/**
 * Builds the requirement of the accepted friend cohort run.
 *
 * The public queue opens only after an accepted friend cohort run. A file at
 * the recorded path is not an accepted run: the record has to name an
 * accepted outcome, an acceptor, a date and a tested commit, and it has to be
 * bound to the friend cohort that was accepted, by the commitment, the count
 * and the algorithm of the set. A record that names another set of accounts
 * than the accepted friend cohort is a run of another cohort, so it never
 * opens the queue.
 *
 * The two sets are compared by their commitment, never by their members: the
 * account subjects of the friend cohort are private, so the record carries
 * the count and the commitment of the set and never an identifier.
 * @param {{run: {present: boolean, valid: boolean, body: any}, cohort: {present: boolean, valid: boolean, body: any}}} input
 * @returns {Requirement}
 */
export function friendCohortRunRequirement(input) {
  const run = input.run;
  const cohort = input.cohort;
  if (!run || !run.present) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'No friend cohort run is recorded, so the public queue has no accepted run to require.',
      `Record the accepted friend cohort run in ${FRIEND_RUN_EVIDENCE_PATH}.`,
    );
  }
  if (!run.valid) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'The friend cohort run record is not a JSON object, so it records no run.',
      `Replace the record with the accepted friend cohort run in ${FRIEND_RUN_EVIDENCE_PATH}.`,
    );
  }
  const body = run.body;
  if (Object.keys(body).length === 0) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'The friend cohort run record is empty, so it records no run.',
      `Record the accepted friend cohort run in ${FRIEND_RUN_EVIDENCE_PATH}.`,
    );
  }
  if (carriesAccountSubjects(body)) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'The recorded friend run carries the account subjects of the cohort. The subjects are private, so the record carries the count and the commitment of the set instead.',
      `Replace the account subjects of ${FRIEND_RUN_EVIDENCE_PATH} with the count and the commitment of the set.`,
    );
  }
  if (body.status !== 'accepted') {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      `The friend cohort run reports "${body.status ?? 'unknown'}", not an accepted run. A file at the recorded path is not an accepted run.`,
      `Record the outcome of the friend cohort run as an accepted run in ${FRIEND_RUN_EVIDENCE_PATH}.`,
    );
  }
  if (!isNamed(body.acceptedBy) || !isNamed(body.acceptedAt) || !isNamed(body.commit)) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'The recorded friend run names no acceptor, date or tested commit.',
      'Complete the friend run record before the queue can open.',
    );
  }
  const runCohort = body.cohort && typeof body.cohort === 'object' && !Array.isArray(body.cohort) ? body.cohort : null;
  if (!runCohort) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'The friend cohort run names no cohort, so it is not bound to the accepted friend cohort.',
      `Record the algorithm, the commitment and the count of the cohort of the run in ${FRIEND_RUN_EVIDENCE_PATH}.`,
    );
  }
  if (!isNamed(runCohort.commitment)) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'The friend cohort run names no commitment of the cohort, so it is not bound to the accepted friend cohort.',
      `Record the algorithm, the commitment and the count of the cohort of the run in ${FRIEND_RUN_EVIDENCE_PATH}.`,
    );
  }
  if (!isNamed(runCohort.algorithm)) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'The friend cohort run names no algorithm of the commitment, so it is not comparable with the accepted friend cohort. A record that names no algorithm is no record of a cohort at all.',
      `Record the algorithm of the commitment of the cohort of the run in ${FRIEND_RUN_EVIDENCE_PATH}.`,
    );
  }
  if (!isSupportedAlgorithm(runCohort.algorithm)) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      `The friend cohort run was recorded with another algorithm than ${COHORT_COMMITMENT_ALGORITHM}, so the two commitments are not comparable.`,
      `Record the run with ${COHORT_COMMITMENT_ALGORITHM}.`,
    );
  }
  const runCommitment = readCommitment(runCohort);
  if (!runCommitment) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'The friend cohort run names no commitment of the cohort, so it is not bound to the accepted friend cohort.',
      `Record the algorithm, the commitment and the count of the cohort of the run in ${FRIEND_RUN_EVIDENCE_PATH}.`,
    );
  }
  if (!Number.isInteger(runCohort.count) || runCohort.count <= 0) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'The friend cohort run names no count of the cohort, so it is not bound to the accepted friend cohort.',
      `Record the count of the cohort of the run in ${FRIEND_RUN_EVIDENCE_PATH}.`,
    );
  }
  if (!cohort || !cohort.present) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'No friend cohort is recorded, so the recorded run cannot be bound to an accepted friend cohort.',
      `Record the algorithm, the commitment and the count of the friend cohort in ${FRIEND_COHORT_EVIDENCE_PATH}.`,
    );
  }
  if (!cohort.valid) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'The friend cohort record is not a JSON object, so no accepted friend cohort is recorded.',
      `Replace the record with the algorithm, the commitment and the count of the friend cohort in ${FRIEND_COHORT_EVIDENCE_PATH}.`,
    );
  }
  if (!isNamed(cohort.body?.commitment)) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'The recorded friend cohort names no commitment of the set, so the recorded run cannot be bound to it.',
      `Record the algorithm, the commitment and the count of the friend cohort in ${FRIEND_COHORT_EVIDENCE_PATH}.`,
    );
  }
  if (!isNamed(cohort.body?.algorithm)) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'The recorded friend cohort names no algorithm of the commitment, so it is not comparable with the accepted friend cohort. A record that names no algorithm is no record of a cohort at all.',
      `Record the algorithm of the commitment of the friend cohort in ${FRIEND_COHORT_EVIDENCE_PATH}.`,
    );
  }
  if (!isSupportedAlgorithm(cohort.body.algorithm)) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      `The recorded friend cohort was recorded with another algorithm than ${COHORT_COMMITMENT_ALGORITHM}, so the two commitments are not comparable.`,
      `Record the friend cohort with ${COHORT_COMMITMENT_ALGORITHM}.`,
    );
  }
  const accepted = readCommitment(cohort.body);
  if (!accepted) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'The recorded friend cohort names no commitment of the set, so the recorded run cannot be bound to it.',
      `Record the algorithm, the commitment and the count of the friend cohort in ${FRIEND_COHORT_EVIDENCE_PATH}.`,
    );
  }
  if (!Number.isInteger(cohort.body.count) || cohort.body.count <= 0) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'The recorded friend cohort names no count of the set, so the count of the run cannot be bound to it.',
      `Record the count of the friend cohort in ${FRIEND_COHORT_EVIDENCE_PATH}.`,
    );
  }
  if (accepted.algorithm !== runCommitment.algorithm) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'The friend cohort run was recorded with another algorithm, so the two commitments are not comparable.',
      `Record the run with ${accepted.algorithm}.`,
    );
  }
  if (accepted.commitment !== runCommitment.commitment) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'The friend cohort run does not match the recorded friend cohort. The queue would open on a run of another set of accounts than the accepted friend cohort.',
      'Run the friend cohort of the recorded commitment and record that run.',
    );
  }
  if (accepted.count !== runCommitment.count) {
    return requirement(
      'friend-cohort-run',
      'the accepted friend cohort run',
      'unmet',
      'The friend cohort run names another count of the set than the recorded friend cohort.',
      `Record the run of the ${accepted.count} account(s) of the recorded friend cohort.`,
    );
  }
  return requirement(
    'friend-cohort-run',
    'the accepted friend cohort run',
    'met',
    `The friend cohort run was accepted by ${body.acceptedBy} on ${body.acceptedAt} for commit ${body.commit}, and it names the same ${runCommitment.count} account(s) of the accepted friend cohort. The two sets were compared by their commitment, so no account subject of either side was read into the report.`,
  );
}

/**
 * Evaluates one gate.
 * @param {{gate: string, root: string, cohortInput?: string|null}} options
 * @returns {Promise<{gate: string, status: 'ready'|'blocked', requirements: Requirement[], recordedCohort: {count: number, commitment: string, algorithm: string, source: string}|null}>}
 */
export async function evaluateGate(options) {
  const { gate, root } = options;
  if (!GATE_SCENARIOS[gate]) throw new Error(`unknown gate ${gate}`);
  const ledger = await buildEvidenceLedger(root);
  const decision = await readOptional(join(root, 'docs', 'evidence', 'online', 'release-decisions', `${gate}.json`));
  const cohort = await readCohortMaterial(root, gate, options);
  const host = await readOptional(join(root, 'docs', 'evidence', 'online', 'KHA-83-host.json'));

  const requirements = [
    ...(await evaluateRequirements({ gate, root, decision, cohort, host })),
    ...evaluateEvidence(ledger, gate),
  ];

  // The enforcement of the cohort is a requirement of its own. The recorded
  // cohort is a set of accounts, and a file that names its commitment proves
  // nothing: the server has to narrow the account access in its request
  // path, and the audit proves that with the enforcement tests of the tree.
  const enforcement = await auditCohortEnforcement({ root, gate });
  requirements.push(cohortEnforcementRequirement(gate, enforcement));

  if (gate === 'queue') {
    // The public queue opens only after an accepted friend cohort run. The
    // record has to name an accepted outcome and the accepted friend cohort
    // it ran with, so a file that merely exists never clears the
    // prerequisite of the queue.
    const friendCohort = await readEvidenceRecord(join(root, ...FRIEND_COHORT_EVIDENCE_PATH.split('/')));
    const friendRun = await readEvidenceRecord(join(root, ...FRIEND_RUN_EVIDENCE_PATH.split('/')));
    requirements.push(friendCohortRunRequirement({ run: friendRun, cohort: friendCohort }));
  }

  const blocked = requirements.some((item) => item.status !== 'met');
  return {
    gate,
    status: blocked ? 'blocked' : 'ready',
    requirements,
    // The recorded cohort travels with the evaluation as a count and a
    // commitment. The account subjects of the cohort are private: they stay
    // in the protected operator input and the evaluation never names one.
    recordedCohort: cohort.count > 0 && cohort.commitment
      ? {
        count: cohort.count,
        commitment: cohort.commitment,
        algorithm: cohort.algorithm,
        source: cohort.source,
      }
      : null,
  };
}

/**
 * Builds the reversible rollout packet for a gate.
 * @param {string} gate
 * @param {{root: string, evaluation: Awaited<ReturnType<typeof evaluateGate>>}} input
 * @returns {object}
 */
export function buildPacket(gate, { evaluation }) {
  const variable = gate === 'friend' ? 'ONLINE_FRIEND_ENABLED' : 'ONLINE_QUEUE_ENABLED';
  // The name of the cohort setting is not written out here. The audit of the
  // enforcement owns the names of the settings, and a packet that names a
  // setting of its own could name a setting the server does not read, so an
  // operator would set a variable that narrows nothing.
  const cohortSetting = COHORT_SETTINGS[gate];
  if (!cohortSetting) throw new Error(`unknown gate ${gate}`);
  const recorded = evaluation.recordedCohort ?? null;
  const count = recorded?.count ?? 0;
  const blockedBy = evaluation.requirements.filter((item) => item.status !== 'met').map((item) => item.id);
  // The packet is deployable only when every requirement of the gate is met
  // and the cohort of the packet names a set of accounts. A packet without a
  // cohort would narrow nothing, and an unset cohort admits every signed-in
  // account.
  const deployable = blockedBy.length === 0 && count > 0 && Boolean(recorded?.commitment);
  return {
    gate,
    deployable,
    blockedBy,
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
      cohort: cohortSetting,
      note2: 'The cohort is an allowlist of accounts. A guest is never excluded by the cohort, because a guest must be able to create and accept a friend link.',
      // The size of the recorded set and its commitment. The account subjects
      // of the cohort are private: they live in the protected operator input
      // and the packet never names one of them.
      cohortCount: count > 0 ? count : null,
      cohortCommitment: recorded?.commitment ?? null,
      cohortAlgorithm: recorded?.algorithm ?? null,
      cohortSource: recorded ? COHORT_SOURCE_LABEL : null,
      cohortNote: 'The value of the setting is the account subjects of the protected operator input. They are private, so the packet carries the count and the commitment of the set and never an identifier. A cohort that names no account is not a narrowing: an unset or empty value admits every signed-in account.',
      cohortVerification: 'The host record carries the same commitment and the same count for the cohort of the running server. Another commitment is another set of accounts, and the gate stays blocked.',
    },
    verification: [
      'GET /v1/online/features reports the switch state.',
      'A cohort account creates an invitation and a guest accepts it.',
      'An account outside the cohort is refused, and a guest is never refused.',
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

/**
 * Renders the packet for the console.
 *
 * The rendered text is the whole output of the command. It carries the count
 * and the commitment of the cohort and never an account subject.
 * @param {string} gate
 * @param {object} payload
 * @param {{status: string}} evaluation
 * @returns {string}
 */
export function renderPacket(gate, payload, evaluation) {
  /** @type {string[]} */
  const lines = [];
  lines.push(`rollout packet for the ${gate} gate (${evaluation.status})`);
  lines.push(`  deployable: ${payload.deployable}`);
  if (payload.blockedBy.length > 0) {
    lines.push(`  blocked by: ${payload.blockedBy.join(', ')}`);
  }
  lines.push(`  configuration: ${payload.configuration.surface}=true, cohort ${payload.configuration.cohort}`);
  lines.push(`  cohort accounts: ${payload.configuration.cohortCount ?? 0} (the identifiers are private and are never printed)`);
  lines.push(`  cohort commitment: ${payload.configuration.cohortCommitment ?? 'none recorded'}`);
  lines.push(`  cohort source: ${payload.configuration.cohortSource ?? 'none recorded'}`);
  lines.push(`  rollback: ${payload.rollback.action}`);
  lines.push(`  rollback is irreversible: ${payload.rollback.irreversible}`);
  lines.push(`  blast radius: ${payload.blastRadius}`);
  for (const precondition of payload.preconditions) {
    lines.push(`  ${precondition.status.toUpperCase().padEnd(8)} ${precondition.id}: ${precondition.detail}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Renders the evaluation for the console.
 * @param {string} gate
 * @param {{status: string, requirements: Requirement[]}} evaluation
 * @returns {string}
 */
export function renderEvaluation(gate, evaluation) {
  /** @type {string[]} */
  const lines = [];
  lines.push(`${gate} gate: ${evaluation.status}`);
  for (const item of evaluation.requirements) {
    lines.push(`  ${item.status.toUpperCase().padEnd(8)} ${item.id}: ${item.detail}`);
    if (item.remediation) lines.push(`           fix: ${item.remediation}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const mode = arguments_[0] ?? 'evaluate';
  const gateIndex = arguments_.indexOf('--gate');
  const gate = gateIndex >= 0 ? arguments_[gateIndex + 1] : 'friend';
  const rootIndex = arguments_.indexOf('--root');
  const root = rootIndex >= 0 ? arguments_[rootIndex + 1] : process.cwd();
  // The protected operator input of the cohort. It carries the account
  // subjects of the cohort, it lives outside the tracked tree, and it is
  // never printed.
  const cohortInputIndex = arguments_.indexOf('--cohort-input');
  const cohortInput = cohortInputIndex >= 0 ? arguments_[cohortInputIndex + 1] : null;

  const evaluation = await evaluateGate({ gate, root, cohortInput });
  const payload = mode === 'packet'
    ? buildPacket(gate, { evaluation })
    : evaluation;

  if (arguments_.includes('--json')) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (mode === 'packet') {
    process.stdout.write(renderPacket(gate, payload, evaluation));
  } else {
    process.stdout.write(renderEvaluation(gate, evaluation));
  }
  if (evaluation.status === 'blocked' && mode !== 'packet') process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/online/feature-gates.mjs')) {
  await main();
}
