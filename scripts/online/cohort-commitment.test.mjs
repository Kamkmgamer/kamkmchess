// Offline tests of the commitment of an account cohort.
//
// The account subjects of a cohort are private. These tests use a synthetic
// sentinel as the subject, and they prove that the sentinel never reaches a
// returned value, a report, a packet or a line of stdout, while a matching
// commitment still passes the runtime cohort and a changed cohort still
// blocks it.
//
// Every test uses a throwaway tree. Nothing here touches a database, a
// network service or a credential, and no real account subject is used.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';

import {
  canonicalAccounts,
  cohortCommitment,
  commitmentOfAccounts,
  COHORT_COMMITMENT_ALGORITHM,
  insideTrackedTree,
  insideTrackedTreeCanonical,
  parseCohortValue,
  readCommitment,
  readProtectedCohort,
  sameCommitment,
} from './cohort-commitment.mjs';
import {
  buildPacket,
  readCohortMaterial,
  recordedCohortRequirement,
  renderEvaluation,
  renderPacket,
  runtimeCohortRequirement,
} from './feature-gates.mjs';

const run = promisify(execFile);

/** The synthetic account subject of the tests. It is never a real account. */
const SENTINEL = 'user_sensitive_probe_123';

const trees = [];

after(async () => {
  await Promise.all(trees.map((directory) => rm(directory, { recursive: true, force: true })));
});

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
 * The codes of an error that a platform refuses a link with.
 * @param {any} error
 * @returns {boolean}
 */
function refusesALink(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  return code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS';
}

/**
 * Links the protected input of a tree to a file.
 *
 * The direct form of the link is a symbolic link to the file. A platform that
 * refuses a symbolic link to a file (Windows without the developer mode)
 * still allows a directory junction, so the home of the protected input
 * becomes a link to the directory that carries the file. Both forms are real
 * links that a reader follows to the file.
 * @param {string} root
 * @param {string} file The file the protected input resolves to.
 * @returns {Promise<{link: string, mechanism: string}|null>} The protected
 * input and the form of the link, or null when the platform refused every
 * form of a link.
 */
async function linkProtectedInput(root, file) {
  const home = join(root, '.secrets', 'online-cohort');
  await mkdir(home, { recursive: true });
  const link = join(home, 'friend-cohort.json');
  try {
    await symlink(file, link, 'file');
    return { link, mechanism: 'a symbolic link to the file' };
  } catch (error) {
    if (!refusesALink(error)) throw error;
  }
  await rm(home, { recursive: true, force: true });
  try {
    await symlink(dirname(file), home, 'junction');
  } catch (error) {
    if (refusesALink(error)) return null;
    throw error;
  }
  return { link, mechanism: 'a directory junction to the directory of the file' };
}

/**
 * Builds a throwaway tree that carries the material of a cohort.
 * @param {{accounts?: string[], protected?: boolean, evidence?: boolean, host?: any}} [options]
 * @returns {Promise<{root: string, commitment: {algorithm: string, commitment: string, count: number}}>}
 */
async function makeTree(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kha-cohort-privacy-'));
  trees.push(root);
  const accounts = options.accounts ?? [SENTINEL];
  const commitment = cohortCommitment(accounts);
  if (options.protected !== false) {
    await write(root, '.secrets/online-cohort/friend-cohort.json', `${JSON.stringify({ accounts }, null, 2)}\n`);
  }
  if (options.evidence !== false) {
    await write(root, 'docs/evidence/online/release-decisions/friend-cohort.json', `${JSON.stringify({
      algorithm: commitment.algorithm,
      commitment: commitment.commitment,
      count: commitment.count,
    }, null, 2)}\n`);
  }
  if (options.host) {
    await write(root, 'docs/evidence/online/KHA-83-host.json', `${JSON.stringify(options.host, null, 2)}\n`);
  }
  return { root, commitment };
}

/**
 * Builds a throwaway tree that the release gate can evaluate.
 *
 * The tree carries the files the gate reads and nothing else, so the gate
 * reports the missing evidence instead of running the enforcement tests of
 * the repository.
 * @param {{accounts?: string[], host?: any}} [options]
 * @returns {Promise<{root: string, commitment: {algorithm: string, commitment: string, count: number}}>}
 */
async function makeGateTree(options = {}) {
  const { root, commitment } = await makeTree(options);
  const source = process.cwd();
  await cp(join(source, 'docs', 'spec', 'online-play-acceptance.json'), join(root, 'docs', 'spec', 'online-play-acceptance.json'));
  await cp(join(source, 'deploy', 'runtime-grants.policy.json'), join(root, 'deploy', 'runtime-grants.policy.json'));
  await cp(join(source, 'backend', 'migrations'), join(root, 'backend', 'migrations'), { recursive: true });
  await mkdir(join(root, 'backend', 'backup', 'cmd', 'khabackup'), { recursive: true });
  for (const file of ['backend/backup/cmd/khabackup/pgtools.go', 'backend/backup/cmd/khabackup/main.go', 'backend/backup/backup.go']) {
    await cp(join(source, ...file.split('/')), join(root, ...file.split('/')));
  }
  return { root, commitment };
}

test('the canonical form of a set of identifiers is trimmed, deduplicated and sorted', () => {
  assert.deepEqual(canonicalAccounts(['user_b', ' user_a ', 'user_b', '', '   ', 42, null]), ['user_a', 'user_b']);
  assert.deepEqual(canonicalAccounts('not a list'), []);
  assert.deepEqual(canonicalAccounts(undefined), []);
});

test('the parser of a setting value ignores the empty tokens', () => {
  assert.deepEqual(parseCohortValue('user_a, user_b ,,'), ['user_a', 'user_b']);
  assert.deepEqual(parseCohortValue(''), []);
  assert.deepEqual(parseCohortValue(undefined), []);
});

test('the commitment of a set does not change with the order of the set', () => {
  const first = cohortCommitment(['user_a', 'user_b']);
  const second = cohortCommitment(['user_b', 'user_a']);
  assert.equal(first.commitment, second.commitment);
  assert.equal(first.algorithm, COHORT_COMMITMENT_ALGORITHM);
  assert.equal(first.count, 2);
});

test('two different sets carry two different commitments', () => {
  const recorded = cohortCommitment(['user_a', 'user_b']);
  const changed = cohortCommitment(['user_a', 'user_c']);
  assert.notEqual(recorded.commitment, changed.commitment);
  assert.equal(sameCommitment(recorded, changed), false);
  assert.equal(sameCommitment(recorded, cohortCommitment(['user_a', 'user_b'])), true);
});

test('a record that names no commitment is no commitment', () => {
  assert.equal(readCommitment(null), null);
  assert.equal(readCommitment({}), null);
  assert.equal(readCommitment({ commitment: '  ' }), null);
  assert.equal(sameCommitment({ commitment: 'sha256:x' }, null), false);
});

// The algorithm of a cohort record.
//
// The algorithm is the evidence of how the commitment was made, so it is
// never assumed: a record that names no algorithm is no record of a cohort
// at all, and a record that names another algorithm names a commitment this
// tree cannot reproduce. Both are missing evidence, so both leave the gate
// blocked, even when the commitment and the count match.

test('a record that names no algorithm is no commitment', () => {
  assert.equal(readCommitment({ commitment: 'sha256:x' }), null);
  assert.equal(readCommitment({ commitment: 'sha256:x', algorithm: '' }), null);
  assert.equal(readCommitment({ commitment: 'sha256:x', algorithm: '   ' }), null);
  assert.equal(readCommitment({ commitment: 'sha256:x', algorithm: 42 }), null);
  assert.equal(readCommitment({ commitment: 'sha256:x', algorithm: null }), null);
  // Two records that agree on a commitment without an algorithm are not a
  // matching cohort: an unknown algorithm is never a comparable one.
  assert.equal(sameCommitment({ commitment: 'sha256:x' }, { commitment: 'sha256:x' }), false);
});

test('a record that names another algorithm is no commitment of this tree', () => {
  const other = { algorithm: 'sha256-other-set-v1', commitment: 'sha256:x', count: 1 };
  assert.equal(readCommitment(other), null);
  assert.equal(sameCommitment(other, { ...other }), false);
  // A record that names the supported algorithm is still read as it is.
  assert.deepEqual(
    readCommitment({ algorithm: COHORT_COMMITMENT_ALGORITHM, commitment: 'sha256:x', count: 2 }),
    { algorithm: COHORT_COMMITMENT_ALGORITHM, commitment: 'sha256:x', count: 2 },
  );
});

test('a protected input inside the tracked tree is refused', () => {
  const root = process.cwd();
  assert.equal(insideTrackedTree(root, join(root, 'docs', 'evidence', 'online', 'friend-cohort.json')), true);
  assert.equal(insideTrackedTree(root, join(root, 'backend', 'cohort.json')), true);
  assert.equal(insideTrackedTree(root, join(root, 'cohort.json')), true);
  assert.equal(insideTrackedTree(root, join(root, '.secrets', 'online-cohort', 'friend-cohort.json')), false);
  assert.equal(insideTrackedTree(root, join(root, '.scratch', 'online-cohort', 'friend-cohort.json')), false);
  assert.equal(insideTrackedTree(root, join(root, '..', 'outside.json')), false);
});

test('a first component that begins with two dots is inside the tree and is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kha-cohort-privacy-'));
  trees.push(root);

  // A directory whose name begins with two dots is an ordinary directory of
  // the tree, not a parent traversal, so the path lies inside the tree.
  assert.equal(insideTrackedTree(root, join(root, '..cohort', 'accounts.json')), true);
  assert.equal(insideTrackedTree(root, join(root, '..data', 'accounts.json')), true);
  assert.equal(insideTrackedTree(root, join(root, '..cohort')), true);
  assert.equal(insideTrackedTree(root, join(root, '..cohort', 'nested', 'accounts.json')), true);

  // A true parent traversal is outside the tree.
  assert.equal(insideTrackedTree(root, join(root, '..', 'outside.json')), false);
  assert.equal(insideTrackedTree(root, join(root, '..', '..', 'outside.json')), false);

  // The ignored homes of a protected input keep their handling.
  assert.equal(insideTrackedTree(root, join(root, '.secrets', 'online-cohort', 'friend-cohort.json')), false);
  assert.equal(insideTrackedTree(root, join(root, '.scratch', 'online-cohort', 'friend-cohort.json')), false);

  // The input in the in-tree directory is refused, never read.
  const inTree = join(root, '..cohort', 'accounts.json');
  await write(root, '..cohort/accounts.json', JSON.stringify({ accounts: [SENTINEL] }));
  const input = await readProtectedCohort(inTree, { root });
  assert.equal(input.refused, true);
  assert.equal(input.present, false);
  assert.equal(input.invalid, false);
  assert.deepEqual(input.accounts, []);
  assert.ok(!JSON.stringify(input).includes(SENTINEL));
});

test('a protected input that names no account is an invalid input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kha-cohort-privacy-'));
  trees.push(root);
  await write(root, '.secrets/online-cohort/friend-cohort.json', '{"accounts":[]}');
  const input = await readProtectedCohort(join(root, '.secrets', 'online-cohort', 'friend-cohort.json'), { root });
  assert.equal(input.present, true);
  assert.equal(input.invalid, true);
  assert.deepEqual(input.accounts, []);
});

test('a protected input that resolves into the tracked tree is refused before it is read', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kha-cohort-privacy-'));
  trees.push(root);
  await write(root, 'docs/friend-cohort.json', JSON.stringify({ accounts: [SENTINEL] }));
  const linked = await linkProtectedInput(root, join(root, 'docs', 'friend-cohort.json'));
  if (!linked) {
    t.skip('the platform refused every form of a link, so the case is only covered by a runner that can create one (the Linux job of .github/workflows/online-ops.yml)');
    return;
  }

  // The name of the protected input lies in an ignored home of the tree, so
  // the lexical decision alone would accept it. The file behind the name
  // lies in the tracked tree, so the canonical decision refuses it.
  t.diagnostic(`the protected input is linked with ${linked.mechanism}`);
  assert.equal(insideTrackedTree(root, linked.link), false);
  assert.equal(await insideTrackedTreeCanonical(root, linked.link), true);

  const input = await readProtectedCohort(linked.link, { root });
  assert.equal(input.refused, true);
  assert.equal(input.present, false);
  assert.equal(input.invalid, false);
  assert.deepEqual(input.accounts, []);
  // The tracked file really carries a subject, and the refusal never read it.
  const tracked = await readFile(join(root, 'docs', 'friend-cohort.json'), 'utf8');
  assert.ok(tracked.includes(SENTINEL));
  assert.ok(!JSON.stringify(input).includes(SENTINEL));

  // The gate refuses the linked input too, so the gate stays blocked.
  const material = await readCohortMaterial(root, 'friend', { cohortInput: linked.link });
  assert.equal(material.refused, true);
  assert.equal(material.count, 0);
  assert.equal(material.commitment, null);
  const requirement = recordedCohortRequirement('friend', material);
  assert.equal(requirement.status, 'unmet');
  assert.ok(!JSON.stringify(material).includes(SENTINEL));
});

test('a protected input outside the tracked tree stays usable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kha-cohort-privacy-'));
  trees.push(root);
  const outside = await mkdtemp(join(tmpdir(), 'kha-cohort-outside-'));
  trees.push(outside);
  await writeFile(join(outside, 'friend-cohort.json'), JSON.stringify({ accounts: [SENTINEL] }), 'utf8');

  // A real file outside the tree is accepted.
  assert.equal(insideTrackedTree(root, join(outside, 'friend-cohort.json')), false);
  assert.equal(await insideTrackedTreeCanonical(root, join(outside, 'friend-cohort.json')), false);
  const outsideInput = await readProtectedCohort(join(outside, 'friend-cohort.json'), { root });
  assert.equal(outsideInput.refused, false);
  assert.equal(outsideInput.present, true);
  assert.equal(outsideInput.invalid, false);
  assert.deepEqual(outsideInput.accounts, [SENTINEL]);

  // A real file in an ignored home of the tree is accepted too.
  await write(root, '.secrets/online-cohort/friend-cohort.json', JSON.stringify({ accounts: [SENTINEL] }));
  const home = join(root, '.secrets', 'online-cohort', 'friend-cohort.json');
  assert.equal(await insideTrackedTreeCanonical(root, home), false);
  const homeInput = await readProtectedCohort(home, { root });
  assert.equal(homeInput.refused, false);
  assert.equal(homeInput.present, true);
  assert.equal(homeInput.invalid, false);
  assert.deepEqual(homeInput.accounts, [SENTINEL]);
});

test('a protected input that resolves to a file outside the tracked tree stays usable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kha-cohort-privacy-'));
  trees.push(root);
  const outside = await mkdtemp(join(tmpdir(), 'kha-cohort-outside-'));
  trees.push(outside);
  await writeFile(join(outside, 'friend-cohort.json'), JSON.stringify({ accounts: [SENTINEL] }), 'utf8');
  const linked = await linkProtectedInput(root, join(outside, 'friend-cohort.json'));
  if (!linked) {
    t.skip('the platform refused every form of a link, so the case is only covered by a runner that can create one (the Linux job of .github/workflows/online-ops.yml)');
    return;
  }

  t.diagnostic(`the protected input is linked with ${linked.mechanism}`);
  assert.equal(await insideTrackedTreeCanonical(root, linked.link), false);
  const input = await readProtectedCohort(linked.link, { root });
  assert.equal(input.refused, false);
  assert.equal(input.present, true);
  assert.equal(input.invalid, false);
  assert.deepEqual(input.accounts, [SENTINEL]);
});

test('the canonical boundary keeps the lexical cases of the tracked tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kha-cohort-privacy-'));
  trees.push(root);
  await write(root, 'docs/cohort.json', JSON.stringify({ accounts: [SENTINEL] }));

  // A true parent traversal is outside the tree.
  assert.equal(insideTrackedTree(root, join(root, '..', 'outside.json')), false);
  assert.equal(await insideTrackedTreeCanonical(root, join(root, '..', 'outside.json')), false);
  // A directory of the tree is inside it.
  assert.equal(insideTrackedTree(root, join(root, 'docs', 'cohort.json')), true);
  assert.equal(await insideTrackedTreeCanonical(root, join(root, 'docs', 'cohort.json')), true);
  // A directory whose name begins with two dots is an ordinary directory of
  // the tree, so it is inside it.
  assert.equal(await insideTrackedTreeCanonical(root, join(root, '..cohort', 'accounts.json')), true);
  // The ignored homes of a protected input keep their handling.
  assert.equal(await insideTrackedTreeCanonical(root, join(root, '.secrets', 'online-cohort', 'friend-cohort.json')), false);
  assert.equal(await insideTrackedTreeCanonical(root, join(root, '.scratch', 'online-cohort', 'friend-cohort.json')), false);
});

test('the material of a gate carries the count and the commitment and never a subject', async () => {
  const { root, commitment } = await makeTree();
  const material = await readCohortMaterial(root, 'friend');
  assert.equal(material.count, 1);
  assert.equal(material.commitment, commitment.commitment);
  assert.equal(material.evidenceCommitment, commitment.commitment);
  assert.ok(!JSON.stringify(material).includes(SENTINEL));
});

test('a custom protected filename never appears in cohort reports or packets', async () => {
  const { root, commitment } = await makeTree();
  const filename = 'SENTINEL-SUBJECT-42.json';
  const customInput = join(root, '.secrets', 'online-cohort', filename);
  await write(root, `.secrets/online-cohort/${filename}`, JSON.stringify({ accounts: [SENTINEL] }));

  const material = await readCohortMaterial(root, 'friend', { cohortInput: customInput });
  assert.equal(material.present, true);
  assert.equal(material.count, commitment.count);
  assert.equal(material.commitment, commitment.commitment);
  assert.equal(material.source, 'the protected operator input');

  const requirement = recordedCohortRequirement('friend', material);
  assert.equal(requirement.status, 'met');
  const evaluation = {
    gate: 'friend',
    status: 'blocked',
    requirements: [
      requirement,
      { id: 'runtime-cohort', title: 'the runtime cohort of the host', status: 'unmet', detail: 'not measured', remediation: null },
    ],
    recordedCohort: {
      count: material.count,
      commitment: material.commitment,
      algorithm: material.algorithm,
      source: material.source,
    },
  };
  const packet = buildPacket('friend', { evaluation });
  assert.equal(packet.configuration.cohortCount, commitment.count);
  assert.equal(packet.configuration.cohortCommitment, commitment.commitment);
  assert.equal(packet.deployable, false);

  const jsonReport = JSON.stringify({ material, requirement, evaluation, packet });
  const rendered = `${renderEvaluation('friend', evaluation)}${renderPacket('friend', packet, evaluation)}`;
  for (const output of [JSON.stringify(material), JSON.stringify(requirement), JSON.stringify(packet), jsonReport, rendered]) {
    assert.ok(!output.includes(filename), `private filename leaked in: ${output}`);
    assert.ok(!output.includes(SENTINEL), `private subject leaked in: ${output}`);
  }
});

test('a protected input that lies inside the tracked tree is refused by the gate', async () => {
  const { root } = await makeTree();
  await write(root, 'docs/evidence/online/friend-cohort.json', JSON.stringify({ accounts: [SENTINEL] }));
  const material = await readCohortMaterial(root, 'friend', {
    cohortInput: 'docs/evidence/online/friend-cohort.json',
  });
  assert.equal(material.refused, true);
  assert.equal(material.count, 0);
  assert.equal(material.commitment, null);
  const requirement = recordedCohortRequirement('friend', material);
  assert.equal(requirement.status, 'unmet');
  assert.match(requirement.detail, /private/i);
  assert.ok(!JSON.stringify(material).includes(SENTINEL));
});

test('the recorded requirement is met by a matching commitment and unmet by a changed one', async () => {
  const { root } = await makeTree();
  const material = await readCohortMaterial(root, 'friend');
  const recorded = recordedCohortRequirement('friend', material);
  assert.equal(recorded.id, 'cohort');
  assert.equal(recorded.status, 'met');
  assert.ok(!recorded.detail.includes(SENTINEL));

  // A protected input that names another set than the recorded evidence is
  // an unmet requirement, never a met one.
  await write(root, '.secrets/online-cohort/friend-cohort.json', JSON.stringify({ accounts: ['user_other'] }));
  const changed = await readCohortMaterial(root, 'friend');
  const mismatch = recordedCohortRequirement('friend', changed);
  assert.equal(mismatch.status, 'unmet');
  assert.match(mismatch.detail, /does not match/i);
});

test('a recorded evidence that carries the subjects of the cohort is refused', async () => {
  const { root } = await makeTree();
  await write(root, 'docs/evidence/online/release-decisions/friend-cohort.json', JSON.stringify({
    accounts: [SENTINEL],
    count: 1,
  }));
  const material = await readCohortMaterial(root, 'friend');
  const requirement = recordedCohortRequirement('friend', material);
  assert.equal(requirement.status, 'unmet');
  assert.match(requirement.detail, /private/i);
});

test('a matching commitment passes the runtime cohort and a changed cohort blocks it', async () => {
  const recorded = cohortCommitment(['user_a', 'user_b']);
  const matching = {
    status: 'verified',
    cohort: { algorithm: recorded.algorithm, commitment: recorded.commitment, count: recorded.count },
  };
  const changed = {
    status: 'verified',
    cohort: { algorithm: recorded.algorithm, commitment: cohortCommitment(['user_a', 'user_c']).commitment, count: 2 },
  };
  const material = {
    gate: 'friend',
    source: '.secrets/online-cohort/friend-cohort.json',
    present: true,
    invalid: false,
    refused: false,
    count: recorded.count,
    commitment: recorded.commitment,
    algorithm: recorded.algorithm,
    evidence: null,
    evidenceCommitment: null,
    evidenceCount: null,
    evidenceHasRawAccounts: false,
  };
  const pass = runtimeCohortRequirement('friend', { recorded: material, host: matching });
  assert.equal(pass.status, 'met');
  assert.ok(!pass.detail.includes(SENTINEL));
  const blocked = runtimeCohortRequirement('friend', { recorded: material, host: changed });
  assert.equal(blocked.status, 'unmet');
  assert.match(blocked.detail, /does not match/i);
});

test('a host record that carries the subjects of the runtime cohort is refused', () => {
  const material = {
    count: 1,
    commitment: cohortCommitment([SENTINEL]).commitment,
    algorithm: COHORT_COMMITMENT_ALGORITHM,
    source: '.secrets/online-cohort/friend-cohort.json',
  };
  const requirement = runtimeCohortRequirement('friend', {
    recorded: material,
    host: { status: 'verified', cohort: { accounts: [SENTINEL] } },
  });
  assert.equal(requirement.status, 'unmet');
  assert.match(requirement.detail, /private/i);
  assert.ok(!requirement.detail.includes(SENTINEL));
});

test('the packet names the count and the commitment and never a subject', () => {
  const commitment = cohortCommitment([SENTINEL]);
  const packet = buildPacket('friend', {
    evaluation: {
      gate: 'friend',
      requirements: [{ id: 'release-decision', title: 'decision', status: 'met', detail: 'Approved', remediation: null }],
      recordedCohort: { count: 1, commitment: commitment.commitment, algorithm: commitment.algorithm, source: '.secrets/online-cohort/friend-cohort.json' },
    },
  });
  assert.equal(packet.configuration.cohortCount, 1);
  assert.equal(packet.configuration.cohortCommitment, commitment.commitment);
  assert.equal(packet.deployable, true);
  const report = JSON.stringify(packet);
  assert.ok(!report.includes(SENTINEL));
  assert.ok(!report.includes('cohortAccounts'));
  assert.ok(!report.includes('cohortValue'));
});

test('the console output of the gate names no subject', async () => {
  const { root, commitment } = await makeTree();
  const material = await readCohortMaterial(root, 'friend');
  const evaluation = {
    gate: 'friend',
    status: 'blocked',
    requirements: [
      { id: 'cohort', title: 'the recorded opt-in cohort', status: 'met', detail: 'The cohort names 1 account(s).', remediation: null },
      { id: 'runtime-cohort', title: 'the runtime cohort of the host', status: 'unmet', detail: 'not measured', remediation: null },
    ],
    recordedCohort: { count: material.count, commitment: material.commitment, algorithm: material.algorithm, source: material.source },
  };
  const packet = buildPacket('friend', { evaluation });
  const rendered = renderPacket('friend', packet, evaluation);
  assert.ok(!rendered.includes(SENTINEL));
  assert.ok(rendered.includes(commitment.commitment));
  const reported = renderEvaluation('friend', evaluation);
  assert.ok(!reported.includes(SENTINEL));
});

test('the commitment tool prints the commitment and never a subject', async () => {
  const { root, commitment } = await makeTree();
  const tool = join(process.cwd(), 'scripts', 'online', 'cohort-commitment.mjs');
  const { stdout } = await run(process.execPath, [tool, '--input', join(root, '.secrets', 'online-cohort', 'friend-cohort.json'), '--json']);
  assert.ok(!stdout.includes(SENTINEL));
  assert.match(stdout, /sha256:/);
  assert.equal(JSON.parse(stdout).commitment, commitment.commitment);
  assert.equal(JSON.parse(stdout).count, 1);
});

test('the packet of the gate names no subject on stdout', async () => {
  const recorded = cohortCommitment([SENTINEL]);
  const { root } = await makeGateTree({
    host: { status: 'verified', cohort: { algorithm: recorded.algorithm, commitment: recorded.commitment, count: recorded.count } },
  });
  const tool = join(process.cwd(), 'scripts', 'online', 'feature-gates.mjs');
  const { stdout } = await run(process.execPath, [tool, 'packet', '--gate', 'friend', '--root', root, '--json']);
  assert.ok(!stdout.includes(SENTINEL));
  const packet = JSON.parse(stdout);
  assert.equal(packet.configuration.cohortCount, 1);
  assert.equal(packet.configuration.cohortCommitment, recorded.commitment);
  const runtime = packet.preconditions.find((item) => item.id === 'runtime-cohort');
  assert.equal(runtime.status, 'met');
  assert.ok(!runtime.detail.includes(SENTINEL));
});

test('the packet of the gate blocks a changed cohort and names no subject', async () => {
  const changed = cohortCommitment(['user_other_probe']);
  const { root } = await makeGateTree({
    host: { status: 'verified', cohort: { algorithm: changed.algorithm, commitment: changed.commitment, count: changed.count } },
  });
  const tool = join(process.cwd(), 'scripts', 'online', 'feature-gates.mjs');
  const { stdout } = await run(process.execPath, [tool, 'packet', '--gate', 'friend', '--root', root, '--json']);
  assert.ok(!stdout.includes(SENTINEL));
  assert.ok(!stdout.includes('user_other_probe'));
  const packet = JSON.parse(stdout);
  assert.equal(packet.deployable, false);
  assert.ok(packet.blockedBy.includes('runtime-cohort'));
  const runtime = packet.preconditions.find((item) => item.id === 'runtime-cohort');
  assert.equal(runtime.status, 'unmet');
  assert.match(runtime.detail, /does not match/i);
});

test('the evidence tree of the gate carries no subject of the cohort', async () => {
  const { root } = await makeGateTree();
  const evidence = await readFile(join(root, 'docs', 'evidence', 'online', 'release-decisions', 'friend-cohort.json'), 'utf8');
  assert.ok(!evidence.includes(SENTINEL));
  const commitment = commitmentOfAccounts([SENTINEL]);
  assert.equal(commitment?.count, 1);
});

// The count of a cohort.
//
// The count is public: it is the number of accounts of the set, so a report
// may carry it. It is also part of the record of a cohort, so a commitment
// without a count has not recorded the size of the set. An absent count, a
// count that is not an integer, a zero and a negative number are all unmet
// requirements, and the account subjects stay private in every case.

/**
 * Writes the recorded evidence of a tree with a chosen count.
 *
 * The count is written as it is, so a test can omit it or malform it. The
 * commitment is never changed, so the count is the only thing that varies.
 * @param {string} root
 * @param {any} commitment The commitment of the recorded set.
 * @param {any} count The count of the record, or undefined to omit it.
 */
async function writeEvidenceCount(root, commitment, count) {
  /** @type {any} */
  const body = { algorithm: commitment.algorithm, commitment: commitment.commitment };
  if (count !== undefined) body.count = count;
  await write(root, 'docs/evidence/online/release-decisions/friend-cohort.json', `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * Writes the host record of a tree with a chosen count.
 * @param {string} root
 * @param {any} commitment The commitment of the measured set.
 * @param {any} count The count of the record, or undefined to omit it.
 */
async function writeHostCount(root, commitment, count) {
  /** @type {any} */
  const cohort = { algorithm: commitment.algorithm, commitment: commitment.commitment };
  if (count !== undefined) cohort.count = count;
  await write(root, 'docs/evidence/online/KHA-83-host.json', `${JSON.stringify({ status: 'verified', cohort }, null, 2)}\n`);
}

test('the recorded requirement is unmet when the evidence carries no count', async () => {
  const { root, commitment } = await makeTree();
  await writeEvidenceCount(root, commitment, undefined);
  const material = await readCohortMaterial(root, 'friend');
  assert.equal(material.evidenceCount, null);
  const requirement = recordedCohortRequirement('friend', material);
  assert.equal(requirement.status, 'unmet');
  assert.match(requirement.detail, /count/i);
  assert.ok(!requirement.detail.includes(SENTINEL));
});

test('the recorded requirement is unmet when the evidence carries a malformed count', async () => {
  for (const count of ['1', 1.5, null, true, Number.NaN]) {
    const { root, commitment } = await makeTree();
    await writeEvidenceCount(root, commitment, count);
    const material = await readCohortMaterial(root, 'friend');
    const requirement = recordedCohortRequirement('friend', material);
    assert.equal(requirement.status, 'unmet', `the count ${JSON.stringify(count)} is not a count`);
    assert.match(requirement.detail, /count/i);
    assert.ok(!requirement.detail.includes(SENTINEL));
  }
});

test('the recorded requirement is unmet when the evidence carries a zero or a negative count', async () => {
  for (const count of [0, -1, -3]) {
    const { root, commitment } = await makeTree();
    await writeEvidenceCount(root, commitment, count);
    const material = await readCohortMaterial(root, 'friend');
    const requirement = recordedCohortRequirement('friend', material);
    assert.equal(requirement.status, 'unmet', `the count ${count} is not a count`);
    assert.match(requirement.detail, /count/i);
    assert.ok(!requirement.detail.includes(SENTINEL));
  }
});

test('the recorded requirement is met by a matching positive count and unmet by another one', async () => {
  const { root, commitment } = await makeTree();
  await writeEvidenceCount(root, commitment, commitment.count);
  const material = await readCohortMaterial(root, 'friend');
  const met = recordedCohortRequirement('friend', material);
  assert.equal(met.status, 'met');
  assert.ok(!met.detail.includes(SENTINEL));

  const { root: other, commitment: otherCommitment } = await makeTree();
  await writeEvidenceCount(other, otherCommitment, otherCommitment.count + 1);
  const changed = await readCohortMaterial(other, 'friend');
  const unmet = recordedCohortRequirement('friend', changed);
  assert.equal(unmet.status, 'unmet');
  assert.match(unmet.detail, /does not match/i);
});

test('the runtime requirement is unmet when the host record carries no count', async () => {
  const { root, commitment } = await makeTree();
  await writeHostCount(root, commitment, undefined);
  const material = await readCohortMaterial(root, 'friend');
  const requirement = runtimeCohortRequirement('friend', {
    recorded: material,
    host: { status: 'verified', cohort: { algorithm: commitment.algorithm, commitment: commitment.commitment } },
  });
  assert.equal(requirement.status, 'unmet');
  assert.match(requirement.detail, /count/i);
  assert.ok(!requirement.detail.includes(SENTINEL));
});

test('the runtime requirement is unmet when the host record carries a malformed count', async () => {
  for (const count of ['1', 1.5, null, true, Number.NaN]) {
    const { root, commitment } = await makeTree();
    await writeHostCount(root, commitment, count);
    const material = await readCohortMaterial(root, 'friend');
    const requirement = runtimeCohortRequirement('friend', {
      recorded: material,
      host: { status: 'verified', cohort: { algorithm: commitment.algorithm, commitment: commitment.commitment, count } },
    });
    assert.equal(requirement.status, 'unmet', `the count ${JSON.stringify(count)} is not a count`);
    assert.match(requirement.detail, /count/i);
    assert.ok(!requirement.detail.includes(SENTINEL));
  }
});

test('the runtime requirement is unmet when the host record carries a zero or a negative count', async () => {
  for (const count of [0, -1, -3]) {
    const { root, commitment } = await makeTree();
    await writeHostCount(root, commitment, count);
    const material = await readCohortMaterial(root, 'friend');
    const requirement = runtimeCohortRequirement('friend', {
      recorded: material,
      host: { status: 'verified', cohort: { algorithm: commitment.algorithm, commitment: commitment.commitment, count } },
    });
    assert.equal(requirement.status, 'unmet', `the count ${count} is not a count`);
    assert.match(requirement.detail, /count/i);
    assert.ok(!requirement.detail.includes(SENTINEL));
  }
});

test('the runtime requirement is met by a matching positive count and unmet by another one', async () => {
  const { root, commitment } = await makeTree();
  await writeHostCount(root, commitment, commitment.count);
  const material = await readCohortMaterial(root, 'friend');
  const met = runtimeCohortRequirement('friend', {
    recorded: material,
    host: { status: 'verified', cohort: { algorithm: commitment.algorithm, commitment: commitment.commitment, count: commitment.count } },
  });
  assert.equal(met.status, 'met');
  assert.ok(!met.detail.includes(SENTINEL));

  const unmet = runtimeCohortRequirement('friend', {
    recorded: material,
    host: { status: 'verified', cohort: { algorithm: commitment.algorithm, commitment: commitment.commitment, count: commitment.count + 1 } },
  });
  assert.equal(unmet.status, 'unmet');
  assert.match(unmet.detail, /does not match/i);
});

test('the packet of the gate blocks a host record that carries no count', async () => {
  const recorded = cohortCommitment([SENTINEL]);
  const { root } = await makeGateTree();
  await writeHostCount(root, recorded, undefined);
  const tool = join(process.cwd(), 'scripts', 'online', 'feature-gates.mjs');
  const { stdout } = await run(process.execPath, [tool, 'packet', '--gate', 'friend', '--root', root, '--json']);
  assert.ok(!stdout.includes(SENTINEL));
  const packet = JSON.parse(stdout);
  assert.equal(packet.deployable, false);
  assert.ok(packet.blockedBy.includes('runtime-cohort'));
  const runtime = packet.preconditions.find((item) => item.id === 'runtime-cohort');
  assert.equal(runtime.status, 'unmet');
  assert.match(runtime.detail, /count/i);
  assert.ok(!runtime.detail.includes(SENTINEL));
});

// The algorithm of a cohort record at the gate.
//
// The gate compares a cohort record by its algorithm, its commitment and its
// count. The algorithm is the evidence of how the commitment was made, so it
// is never assumed and never substituted: a record that names no algorithm
// and a record that names another algorithm are unmet requirements, even when
// the commitment and the count match the recorded set exactly.

/**
 * Writes the recorded evidence of a tree with a chosen algorithm.
 *
 * The commitment and the count are the ones of the recorded set, so the
 * algorithm is the only thing that varies.
 * @param {string} root
 * @param {any} commitment The commitment of the recorded set.
 * @param {any} algorithm The algorithm of the record, or undefined to omit it.
 */
async function writeEvidenceAlgorithm(root, commitment, algorithm) {
  /** @type {any} */
  const body = { commitment: commitment.commitment, count: commitment.count };
  if (algorithm !== undefined) body.algorithm = algorithm;
  await write(root, 'docs/evidence/online/release-decisions/friend-cohort.json', `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * The cohort record of a host with a chosen algorithm.
 * @param {any} commitment The commitment of the measured set.
 * @param {any} algorithm The algorithm of the record, or undefined to omit it.
 * @returns {any}
 */
function hostWithAlgorithm(commitment, algorithm) {
  /** @type {any} */
  const cohort = { commitment: commitment.commitment, count: commitment.count };
  if (algorithm !== undefined) cohort.algorithm = algorithm;
  return { status: 'verified', cohort };
}

test('the recorded requirement is unmet when the evidence names no algorithm', async () => {
  for (const algorithm of [undefined, '', '   ']) {
    const { root, commitment } = await makeTree();
    await writeEvidenceAlgorithm(root, commitment, algorithm);
    const material = await readCohortMaterial(root, 'friend');
    const requirement = recordedCohortRequirement('friend', material);
    assert.equal(requirement.status, 'unmet', `the algorithm ${JSON.stringify(algorithm)} is no algorithm`);
    assert.match(requirement.detail, /algorithm/i);
    assert.ok(!requirement.detail.includes(SENTINEL));
  }
});

test('the recorded requirement is unmet when the evidence names another algorithm', async () => {
  // The commitment and the count are the ones of the recorded set, so only
  // the algorithm can keep the record from proving the cohort.
  const { root, commitment } = await makeTree();
  await writeEvidenceAlgorithm(root, commitment, 'sha256-other-set-v1');
  const material = await readCohortMaterial(root, 'friend');
  const requirement = recordedCohortRequirement('friend', material);
  assert.equal(requirement.status, 'unmet');
  assert.match(requirement.detail, /not comparable/i);
  assert.ok(!requirement.detail.includes(SENTINEL));
});

test('the runtime requirement is unmet when the host record names no algorithm', async () => {
  for (const algorithm of [undefined, '', '   ']) {
    const { root, commitment } = await makeTree();
    const material = await readCohortMaterial(root, 'friend');
    const requirement = runtimeCohortRequirement('friend', {
      recorded: material,
      host: hostWithAlgorithm(commitment, algorithm),
    });
    assert.equal(requirement.status, 'unmet', `the algorithm ${JSON.stringify(algorithm)} is no algorithm`);
    assert.match(requirement.detail, /algorithm/i);
    assert.ok(!requirement.detail.includes(SENTINEL));
  }
});

test('the runtime requirement is unmet when the host record names another algorithm', async () => {
  // The commitment and the count are the ones of the recorded set, so only
  // the algorithm can keep the host record from proving the runtime cohort.
  const { root, commitment } = await makeTree();
  const material = await readCohortMaterial(root, 'friend');
  const requirement = runtimeCohortRequirement('friend', {
    recorded: material,
    host: hostWithAlgorithm(commitment, 'sha256-other-set-v1'),
  });
  assert.equal(requirement.status, 'unmet');
  assert.match(requirement.detail, /not comparable/i);
  assert.ok(!requirement.detail.includes(SENTINEL));
});

test('the packet of the gate blocks a host record that names no algorithm', async () => {
  const recorded = cohortCommitment([SENTINEL]);
  const { root } = await makeGateTree({ host: hostWithAlgorithm(recorded, undefined) });
  const tool = join(process.cwd(), 'scripts', 'online', 'feature-gates.mjs');
  const { stdout } = await run(process.execPath, [tool, 'packet', '--gate', 'friend', '--root', root, '--json']);
  assert.ok(!stdout.includes(SENTINEL));
  const packet = JSON.parse(stdout);
  assert.equal(packet.deployable, false);
  assert.ok(packet.blockedBy.includes('runtime-cohort'));
  const runtime = packet.preconditions.find((item) => item.id === 'runtime-cohort');
  assert.equal(runtime.status, 'unmet');
  assert.match(runtime.detail, /algorithm/i);
});

test('the packet of the gate blocks a recorded cohort that names another algorithm', async () => {
  const recorded = cohortCommitment([SENTINEL]);
  const { root } = await makeGateTree({
    host: { status: 'verified', cohort: { algorithm: recorded.algorithm, commitment: recorded.commitment, count: recorded.count } },
  });
  await writeEvidenceAlgorithm(root, recorded, 'sha256-other-set-v1');
  const tool = join(process.cwd(), 'scripts', 'online', 'feature-gates.mjs');
  const { stdout } = await run(process.execPath, [tool, 'packet', '--gate', 'friend', '--root', root, '--json']);
  assert.ok(!stdout.includes(SENTINEL));
  const packet = JSON.parse(stdout);
  assert.equal(packet.deployable, false);
  assert.ok(packet.blockedBy.includes('cohort'));
  const cohort = packet.preconditions.find((item) => item.id === 'cohort');
  assert.equal(cohort.status, 'unmet');
  assert.match(cohort.detail, /not comparable/i);
});
