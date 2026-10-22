// Offline tests of the requirement of the accepted friend cohort run.
//
// The public queue opens only after an accepted friend cohort run. A file at
// the recorded path is not an accepted run: the record has to name an
// accepted outcome, and it has to be bound to the friend cohort that was
// accepted, by the commitment, the count and the algorithm of the set.
//
// Every test uses a throwaway tree or a synthetic record. Nothing here
// touches a database, a network service or a credential, and no real account
// subject is used.

import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { cohortCommitment } from './cohort-commitment.mjs';
import {
  evaluateGate,
  FRIEND_COHORT_EVIDENCE_PATH,
  FRIEND_RUN_EVIDENCE_PATH,
  friendCohortRunRequirement,
} from './feature-gates.mjs';

/** The synthetic account subject of the tests. It is never a real account. */
const SENTINEL = 'user_sensitive_probe_123';

/** The recorded friend cohort of the tests. */
const COHORT = cohortCommitment([SENTINEL, 'user_other_probe']);

const trees = [];

after(async () => {
  await Promise.all(trees.map((directory) => rm(directory, { recursive: true, force: true })));
});

/**
 * Builds a record of the evidence tree.
 * @param {string} path
 * @param {any} body
 * @returns {{present: boolean, valid: boolean, body: any}}
 */
function record(body) {
  return { present: true, valid: true, body };
}

/**
 * Builds a record that is not usable at all.
 * @returns {{present: boolean, valid: boolean, body: any}}
 */
function absent() {
  return { present: false, valid: false, body: null };
}

/**
 * Builds a record that is present but broken.
 * @returns {{present: boolean, valid: boolean, body: any}}
 */
function malformed() {
  return { present: true, valid: false, body: null };
}

/**
 * Builds an accepted run of the recorded friend cohort.
 * @param {any} [overrides]
 * @returns {any}
 */
function acceptedRun(overrides = {}) {
  return {
    status: 'accepted',
    acceptedBy: 'the owner of the friend release',
    acceptedAt: '2026-05-04T09:00:00Z',
    commit: '0b24151',
    cohort: {
      algorithm: COHORT.algorithm,
      commitment: COHORT.commitment,
      count: COHORT.count,
    },
    ...overrides,
  };
}

/**
 * Writes a file of a throwaway tree.
 * @param {string} root
 * @param {string} path
 * @param {string} content
 */
async function write(root, path, content) {
  const target = join(root, ...path.split('/'));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content, 'utf8');
}

/**
 * Builds a throwaway tree that the queue gate can evaluate.
 *
 * The tree carries the files the gate reads and no enforcement test, so the
 * gate reports the missing enforcement instead of running the tests of the
 * repository.
 * @param {{run?: string|null, cohort?: string|null}} [options]
 * @returns {Promise<string>}
 */
async function makeGateTree(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kha-friend-run-'));
  trees.push(root);
  const source = process.cwd();
  await cp(join(source, 'docs', 'spec', 'online-play-acceptance.json'), join(root, 'docs', 'spec', 'online-play-acceptance.json'));
  await cp(join(source, 'deploy', 'runtime-grants.policy.json'), join(root, 'deploy', 'runtime-grants.policy.json'));
  await cp(join(source, 'backend', 'migrations'), join(root, 'backend', 'migrations'), { recursive: true });
  await mkdir(join(root, 'backend', 'backup', 'cmd', 'khabackup'), { recursive: true });
  for (const file of ['backend/backup/cmd/khabackup/pgtools.go', 'backend/backup/cmd/khabackup/main.go', 'backend/backup/backup.go']) {
    await cp(join(source, ...file.split('/')), join(root, ...file.split('/')));
  }
  if (options.cohort !== null) {
    await write(root, FRIEND_COHORT_EVIDENCE_PATH, options.cohort ?? `${JSON.stringify({
      algorithm: COHORT.algorithm,
      commitment: COHORT.commitment,
      count: COHORT.count,
    }, null, 2)}\n`);
  }
  if (options.run !== null) {
    await write(root, FRIEND_RUN_EVIDENCE_PATH, options.run ?? `${JSON.stringify(acceptedRun(), null, 2)}\n`);
  }
  return root;
}

/**
 * Reads the requirement of the accepted friend cohort run of an evaluation.
 * @param {any} evaluation
 * @returns {any}
 */
function runRequirement(evaluation) {
  const found = evaluation.requirements.find((item) => item.id === 'friend-cohort-run');
  assert.ok(found, 'the queue gate reports the friend cohort run');
  return found;
}

test('an absent friend run leaves the queue without an accepted run', () => {
  const requirement = friendCohortRunRequirement({ run: absent(), cohort: record(COHORT) });
  assert.equal(requirement.id, 'friend-cohort-run');
  assert.equal(requirement.status, 'unmet');
  assert.match(requirement.detail, /No friend cohort run is recorded/i);
  assert.match(requirement.remediation, /KHA-84-friend-run\.json/);
});

test('a malformed friend run records no run at all', () => {
  const requirement = friendCohortRunRequirement({ run: malformed(), cohort: record(COHORT) });
  assert.equal(requirement.status, 'unmet');
  assert.match(requirement.detail, /not a JSON object/i);
});

test('an empty friend run is not an accepted run', () => {
  const requirement = friendCohortRunRequirement({ run: record({}), cohort: record(COHORT) });
  assert.equal(requirement.status, 'unmet');
  assert.match(requirement.detail, /empty/i);
});

test('a friend run that reports another outcome is not an accepted run', () => {
  const failed = friendCohortRunRequirement({
    run: record(acceptedRun({ status: 'failed' })),
    cohort: record(COHORT),
  });
  assert.equal(failed.status, 'unmet');
  assert.match(failed.detail, /not an accepted run/i);
  const undecided = friendCohortRunRequirement({
    run: record(acceptedRun({ status: undefined })),
    cohort: record(COHORT),
  });
  assert.equal(undecided.status, 'unmet');
  assert.match(undecided.detail, /not an accepted run/i);
});

test('an accepted friend run that names no acceptor, date or commit is incomplete', () => {
  const requirement = friendCohortRunRequirement({
    run: record(acceptedRun({ acceptedBy: '', acceptedAt: undefined, commit: undefined })),
    cohort: record(COHORT),
  });
  assert.equal(requirement.status, 'unmet');
  assert.match(requirement.detail, /acceptor, date or tested commit/i);
});

test('a friend run that names no cohort is not bound to the accepted friend cohort', () => {
  const requirement = friendCohortRunRequirement({
    run: record(acceptedRun({ cohort: undefined })),
    cohort: record(COHORT),
  });
  assert.equal(requirement.status, 'unmet');
  assert.match(requirement.detail, /not bound to the accepted friend cohort/i);
});

test('a friend run that names another commitment is not the accepted friend cohort', () => {
  const other = cohortCommitment(['user_another_probe']);
  const requirement = friendCohortRunRequirement({
    run: record(acceptedRun({ cohort: { algorithm: COHORT.algorithm, commitment: other.commitment, count: COHORT.count } })),
    cohort: record(COHORT),
  });
  assert.equal(requirement.status, 'unmet');
  assert.match(requirement.detail, /does not match the recorded friend cohort/i);
});

test('a friend run that names another count is not the accepted friend cohort', () => {
  const requirement = friendCohortRunRequirement({
    run: record(acceptedRun({ cohort: { algorithm: COHORT.algorithm, commitment: COHORT.commitment, count: COHORT.count + 1 } })),
    cohort: record(COHORT),
  });
  assert.equal(requirement.status, 'unmet');
  assert.match(requirement.detail, /another count/i);
});

test('a friend run that names another algorithm is not comparable', () => {
  const requirement = friendCohortRunRequirement({
    run: record(acceptedRun({ cohort: { algorithm: 'sha256-other-set-v1', commitment: COHORT.commitment, count: COHORT.count } })),
    cohort: record(COHORT),
  });
  assert.equal(requirement.status, 'unmet');
  assert.match(requirement.detail, /not comparable/i);
});

test('a friend run without a recorded friend cohort cannot be bound to one', () => {
  const absentCohort = friendCohortRunRequirement({ run: record(acceptedRun()), cohort: absent() });
  assert.equal(absentCohort.status, 'unmet');
  assert.match(absentCohort.detail, /No friend cohort is recorded/i);
  const brokenCohort = friendCohortRunRequirement({ run: record(acceptedRun()), cohort: malformed() });
  assert.equal(brokenCohort.status, 'unmet');
  assert.match(brokenCohort.detail, /not a JSON object/i);
  const noCommitment = friendCohortRunRequirement({ run: record(acceptedRun()), cohort: record({ count: 2 }) });
  assert.equal(noCommitment.status, 'unmet');
  assert.match(noCommitment.detail, /no commitment of the set/i);
  const noCount = friendCohortRunRequirement({ run: record(acceptedRun()), cohort: record({ algorithm: COHORT.algorithm, commitment: COHORT.commitment }) });
  assert.equal(noCount.status, 'unmet');
  assert.match(noCount.detail, /no count of the set/i);
});

test('a friend run that carries the account subjects of the cohort is refused', () => {
  const requirement = friendCohortRunRequirement({
    run: record(acceptedRun({ cohort: { algorithm: COHORT.algorithm, commitment: COHORT.commitment, count: COHORT.count, accounts: [SENTINEL] } })),
    cohort: record(COHORT),
  });
  assert.equal(requirement.status, 'unmet');
  assert.match(requirement.detail, /private/i);
  assert.ok(!JSON.stringify(requirement).includes(SENTINEL));
});

test('an accepted friend run of the recorded friend cohort meets the requirement', () => {
  const requirement = friendCohortRunRequirement({ run: record(acceptedRun()), cohort: record(COHORT) });
  assert.equal(requirement.id, 'friend-cohort-run');
  assert.equal(requirement.status, 'met');
  assert.equal(requirement.remediation, null);
  assert.match(requirement.detail, /accepted/i);
  assert.ok(!JSON.stringify(requirement).includes(SENTINEL));
});

test('the queue gate keeps an empty friend run from clearing its prerequisite', async () => {
  const root = await makeGateTree({ run: '{}\n' });
  const evaluation = await evaluateGate({ gate: 'queue', root });
  const requirement = runRequirement(evaluation);
  assert.equal(requirement.status, 'unmet');
  assert.equal(evaluation.status, 'blocked');
  assert.ok(evaluation.requirements.some((item) => item.id === 'friend-cohort-run'));
});

test('the queue gate blocks a friend run that names another cohort', async () => {
  const other = cohortCommitment(['user_another_probe']);
  const root = await makeGateTree({
    run: `${JSON.stringify(acceptedRun({ cohort: { algorithm: COHORT.algorithm, commitment: other.commitment, count: COHORT.count } }), null, 2)}\n`,
  });
  const evaluation = await evaluateGate({ gate: 'queue', root });
  assert.equal(runRequirement(evaluation).status, 'unmet');
  assert.equal(evaluation.status, 'blocked');
});

test('the queue gate reports an accepted friend run of the recorded cohort', async () => {
  const root = await makeGateTree();
  const evaluation = await evaluateGate({ gate: 'queue', root });
  const requirement = runRequirement(evaluation);
  assert.equal(requirement.status, 'met');
  assert.ok(!JSON.stringify(evaluation).includes(SENTINEL));
});

// The algorithm of a cohort record.
//
// The run and the recorded cohort are compared by their algorithm, their
// commitment and their count. The algorithm is the evidence of how the
// commitment was made, so it is never assumed: a record that names no
// algorithm and a record that names another algorithm never bind the run to
// the accepted friend cohort.

test('a friend run whose cohort names no algorithm is not comparable', () => {
  for (const algorithm of [undefined, '', '   ']) {
    /** @type {any} */
    const cohort = { commitment: COHORT.commitment, count: COHORT.count };
    if (algorithm !== undefined) cohort.algorithm = algorithm;
    const requirement = friendCohortRunRequirement({ run: record(acceptedRun({ cohort })), cohort: record(COHORT) });
    assert.equal(requirement.status, 'unmet', `the algorithm ${JSON.stringify(algorithm)} is no algorithm`);
    assert.match(requirement.detail, /algorithm/i);
    assert.ok(!JSON.stringify(requirement).includes(SENTINEL));
  }
});

test('a recorded friend cohort that names no algorithm is not comparable', () => {
  for (const algorithm of [undefined, '', '   ']) {
    /** @type {any} */
    const body = { commitment: COHORT.commitment, count: COHORT.count };
    if (algorithm !== undefined) body.algorithm = algorithm;
    const requirement = friendCohortRunRequirement({ run: record(acceptedRun()), cohort: record(body) });
    assert.equal(requirement.status, 'unmet', `the algorithm ${JSON.stringify(algorithm)} is no algorithm`);
    assert.match(requirement.detail, /algorithm/i);
    assert.ok(!JSON.stringify(requirement).includes(SENTINEL));
  }
});

test('a friend run and a recorded cohort that name another algorithm are not comparable', () => {
  // The commitment and the count are the ones of the accepted cohort, so only
  // the algorithm can keep the run from being bound to it.
  const other = { algorithm: 'sha256-other-set-v1', commitment: COHORT.commitment, count: COHORT.count };
  const run = friendCohortRunRequirement({ run: record(acceptedRun({ cohort: other })), cohort: record(COHORT) });
  assert.equal(run.status, 'unmet');
  assert.match(run.detail, /not comparable/i);
  const accepted = friendCohortRunRequirement({ run: record(acceptedRun()), cohort: record(other) });
  assert.equal(accepted.status, 'unmet');
  assert.match(accepted.detail, /not comparable/i);
  // Both sides name the same other algorithm, and the two commitments are
  // still not comparable: the tree reproduces only the supported one.
  const both = friendCohortRunRequirement({ run: record(acceptedRun({ cohort: other })), cohort: record(other) });
  assert.equal(both.status, 'unmet');
  assert.match(both.detail, /not comparable/i);
  assert.ok(!JSON.stringify(both).includes(SENTINEL));
});

test('the queue gate blocks a friend run whose cohort names no algorithm', async () => {
  const root = await makeGateTree({
    run: `${JSON.stringify(acceptedRun({ cohort: { commitment: COHORT.commitment, count: COHORT.count } }), null, 2)}\n`,
  });
  const evaluation = await evaluateGate({ gate: 'queue', root });
  assert.equal(runRequirement(evaluation).status, 'unmet');
  assert.equal(evaluation.status, 'blocked');
});

test('the queue gate blocks a recorded friend cohort that names no algorithm', async () => {
  const root = await makeGateTree({
    cohort: `${JSON.stringify({ commitment: COHORT.commitment, count: COHORT.count }, null, 2)}\n`,
  });
  const evaluation = await evaluateGate({ gate: 'queue', root });
  assert.equal(runRequirement(evaluation).status, 'unmet');
  assert.equal(evaluation.status, 'blocked');
});
