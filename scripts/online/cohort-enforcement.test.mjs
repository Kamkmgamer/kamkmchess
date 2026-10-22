// Offline tests for the cohort enforcement audit.
//
// Every test uses a throwaway tree or a synthetic run. Nothing here touches
// a database, a network service or a credential.

import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  auditCohortEnforcement,
  COHORT_SETTINGS,
  COHORT_WIRING_MARKER,
  cohortEnforcementTests,
  passedTests,
  provedWiring,
} from './cohort-enforcement.mjs';
import {
  buildPacket,
  cohortEnforcementRequirement,
  evaluateRequirements,
  recordedCohortRequirement,
  runtimeCohortRequirement,
} from './feature-gates.mjs';
import {
  cohortCommitment,
  commitmentOfAccounts,
  COHORT_COMMITMENT_ALGORITHM,
} from './cohort-commitment.mjs';

const trees = [];

after(async () => {
  await Promise.all(trees.map((directory) => rm(directory, { recursive: true, force: true })));
});

/**
 * The material of a cohort, as the gate reads it.
 *
 * The material carries the count and the commitment of the set and never an
 * account subject.
 * @param {string[]} accounts
 * @returns {any}
 */
function cohortMaterial(accounts) {
  const commitment = commitmentOfAccounts(accounts);
  return {
    gate: 'friend',
    source: '.secrets/online-cohort/friend-cohort.json',
    present: true,
    invalid: false,
    refused: false,
    count: commitment?.count ?? 0,
    commitment: commitment?.commitment ?? null,
    algorithm: commitment?.algorithm ?? COHORT_COMMITMENT_ALGORITHM,
    evidence: commitment ? { algorithm: commitment.algorithm, commitment: commitment.commitment, count: commitment.count } : null,
    evidenceCommitment: commitment?.commitment ?? null,
    evidenceCount: commitment?.count ?? null,
    evidenceHasRawAccounts: false,
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
 * Builds a throwaway tree.
 * @param {{composition?: string, tests?: Record<string, string>}} options
 * @returns {Promise<string>}
 */
async function makeTree(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kha-cohort-'));
  trees.push(root);
  await write(root, 'backend/serverapp/server.go', options.composition ?? [
    'package serverapp',
    '',
    'func Open() {',
    '\tfriendCohort := cohort.Parse(getenv("ONLINE_FRIEND_COHORT"))',
    '\tqueueCohort := cohort.Parse(getenv("ONLINE_QUEUE_COHORT"))',
    '\tfriend := httpapi.NewFriends(friends, onlineService, authorizer, httpapi.FriendsOptions{',
    '\t\tAllowedOrigins: cfg.Clerk.AllowedOrigins,',
    '\t\tCohort: cfg.Online.FriendCohort,',
    '\t})',
    '\tqueue := httpapi.NewQueue(queueService, authorizer, httpapi.QueueOptions{',
    '\t\tAllowedOrigins: cfg.Clerk.AllowedOrigins,',
    '\t\tCohort: cfg.Online.QueueCohort,',
    '\t})',
    '}',
  ].join('\n'));
  const tests = options.tests ?? {
    'backend/httpapi/cohort_test.go': 'package httpapi\n\nfunc TestTheCohortRefusesAnExcludedAccount(t *testing.T) {}\n',
  };
  for (const [path, content] of Object.entries(tests)) {
    await write(root, path, content);
  }
  return root;
}

/**
 * A run that reports every named test as passed.
 * @param {string[]} names
 * @param {string[]} [surfaces]
 */
function passingRunner(names, surfaces = ['friend', 'queue']) {
  return async () => ({
    code: 0,
    stdout: [
      ...names.map((name) => `--- PASS: ${name} (0.00s)`),
      ...surfaces.map((surface) => `    cohort_wiring_test.go:1: ${COHORT_WIRING_MARKER} ${surface}=proven`),
    ].join('\n'),
    stderr: '',
    failed: false,
    missing: false,
  });
}

test('the audit reads the enforcement tests of the tree', async () => {
  const root = await makeTree({
    tests: {
      'backend/cohort/cohort_test.go': 'package cohort\n\nfunc TestTheCohortNeverExcludesAGuest(t *testing.T) {}\nfunc TestSomethingElse(t *testing.T) {}\n',
      'backend/httpapi/cohort_test.go': 'package httpapi\n\nfunc TestTheCohortRefusesAnExcludedAccount(t *testing.T) {}\n',
    },
  });
  const names = await cohortEnforcementTests(root);
  assert.deepEqual(names, ['TestTheCohortNeverExcludesAGuest', 'TestTheCohortRefusesAnExcludedAccount']);
});

test('the audit is proven when the proof of the tree proved the wiring and the tests pass', async () => {
  const root = await makeTree();
  const report = await auditCohortEnforcement({
    root,
    gate: 'friend',
    runner: passingRunner(['TestTheCohortRefusesAnExcludedAccount']),
  });
  const blockers = report.findings.filter((item) => item.severity === 'blocker');
  assert.deepEqual(blockers, []);
  assert.equal(report.ran, true);
});

test('the audit reports a composition that is missing', async () => {
  const root = await makeTree();
  await rm(join(root, 'backend', 'serverapp', 'server.go'));
  const report = await auditCohortEnforcement({ root, gate: 'friend', runner: passingRunner([]) });
  const codes = report.findings.map((item) => item.code);
  assert.ok(codes.includes('cohort-composition-missing'));
});

test('the audit reports a run that did not prove the wiring of the composition', async () => {
  // A run without the marker of the proof did not observe the wiring of the
  // composition, so the gate may not report the enforcement as met.
  const root = await makeTree();
  const report = await auditCohortEnforcement({
    root,
    gate: 'friend',
    runner: passingRunner(['TestTheCohortRefusesAnExcludedAccount'], []),
  });
  const codes = report.findings.map((item) => item.code);
  assert.ok(codes.includes('cohort-wiring-unproven'));
  const blocker = report.findings.find((item) => item.code === 'cohort-wiring-unproven');
  assert.equal(blocker.severity, 'blocker');
  assert.match(blocker.message, /friend/);
});

test('the audit reports the surface of the gate whose wiring was not proved', async () => {
  const root = await makeTree();
  const report = await auditCohortEnforcement({
    root,
    gate: 'queue',
    runner: passingRunner(['TestTheCohortRefusesAnExcludedAccount'], ['queue']),
  });
  const codes = report.findings.map((item) => item.code);
  assert.ok(codes.includes('cohort-wiring-unproven'));
  const blocker = report.findings.find((item) => item.code === 'cohort-wiring-unproven');
  assert.match(blocker.message, /friend/);
  assert.ok(!blocker.message.includes('queue surface'));
});

test('the audit reports a tree without an enforcement test', async () => {
  const root = await makeTree({ tests: {} });
  const report = await auditCohortEnforcement({ root, gate: 'friend', runner: passingRunner([]) });
  const codes = report.findings.map((item) => item.code);
  assert.ok(codes.includes('cohort-enforcement-tests-missing'));
});

test('the audit reports a failed run', async () => {
  const root = await makeTree();
  const report = await auditCohortEnforcement({
    root,
    gate: 'friend',
    runner: async () => ({ code: 1, stdout: '--- FAIL: TestTheCohortRefusesAnExcludedAccount\n', stderr: 'boom', failed: true, missing: false }),
  });
  const codes = report.findings.map((item) => item.code);
  assert.ok(codes.includes('cohort-enforcement-tests-failed'));
});

test('the audit reports a test that did not run', async () => {
  const root = await makeTree();
  const report = await auditCohortEnforcement({
    root,
    gate: 'friend',
    runner: passingRunner(['TestAnotherTest']),
  });
  const codes = report.findings.map((item) => item.code);
  assert.ok(codes.includes('cohort-enforcement-test-not-passed'));
});

test('the audit reports a missing toolchain', async () => {
  const root = await makeTree();
  const report = await auditCohortEnforcement({
    root,
    gate: 'friend',
    runner: async () => ({ code: null, stdout: '', stderr: 'spawn go ENOENT', failed: true, missing: true }),
  });
  const codes = report.findings.map((item) => item.code);
  assert.ok(codes.includes('cohort-enforcement-toolchain-missing'));
});

test('the audit of the queue gate covers the friend surface as well', async () => {
  const root = await makeTree();
  const report = await auditCohortEnforcement({
    root,
    gate: 'queue',
    runner: passingRunner(['TestTheCohortRefusesAnExcludedAccount']),
  });
  assert.deepEqual(report.findings.filter((item) => item.severity === 'blocker'), []);
  assert.deepEqual(report.settings, ['ONLINE_QUEUE_COHORT', 'ONLINE_FRIEND_COHORT']);
});

test('the audit reads the names of the tests that passed', () => {
  const passed = passedTests('--- PASS: TestTheCohortOne (0.01s)\n--- PASS: TestTheCohortTwo (0.02s)\n--- FAIL: TestTheCohortThree\n');
  assert.deepEqual([...passed].sort(), ['TestTheCohortOne', 'TestTheCohortTwo']);
});

test('the audit reads the surfaces whose wiring the run proved', () => {
  const proved = provedWiring(`    cohort_wiring_test.go:1: ${COHORT_WIRING_MARKER} friend=proven\n    cohort_wiring_test.go:1: ${COHORT_WIRING_MARKER} queue=proven\n`);
  assert.deepEqual([...proved].sort(), ['friend', 'queue']);
  assert.deepEqual([...provedWiring('nothing here')], []);
});

test('the gate keeps the enforcement unmet until it is observed', async () => {
  const root = await makeTree();
  const blocked = await auditCohortEnforcement({
    root,
    gate: 'friend',
    runner: async () => ({ code: 1, stdout: '', stderr: 'boom', failed: true, missing: false }),
  });
  const unmet = cohortEnforcementRequirement('friend', blocked);
  assert.equal(unmet.id, 'cohort-enforcement');
  assert.equal(unmet.status, 'unmet');

  const proven = await auditCohortEnforcement({
    root,
    gate: 'friend',
    runner: passingRunner(['TestTheCohortRefusesAnExcludedAccount']),
  });
  const met = cohortEnforcementRequirement('friend', proven);
  assert.equal(met.status, 'met');
});

test('a recorded cohort of accounts does not report the enforcement as met', async () => {
  // The recorded cohort of the owner names the accounts of the opt-in.
  const recorded = recordedCohortRequirement('friend', cohortMaterial(['user_a', 'user_b']));
  assert.equal(recorded.id, 'cohort');
  assert.equal(recorded.status, 'met');
  // The recorded set is not the enforcement, and the gate never claims it
  // from the list.
  assert.match(recorded.detail, /not the enforcement/i);
  assert.equal(recordedCohortRequirement('friend', null).status, 'unmet');
  assert.equal(recordedCohortRequirement('friend', cohortMaterial([])).status, 'unmet');
  assert.equal(COHORT_SETTINGS.friend, 'ONLINE_FRIEND_COHORT');
  assert.equal(COHORT_SETTINGS.queue, 'ONLINE_QUEUE_COHORT');
});

/**
 * Copies the tree of the repository into an isolated directory.
 *
 * The copy is the mutation fixture: the audit has to see the change and
 * nothing else.
 * @returns {Promise<string>}
 */
async function makeRepositoryTree() {
  const root = await mkdtemp(join(tmpdir(), 'kha-cohort-mutation-'));
  trees.push(root);
  const source = process.cwd();
  await cp(join(source, 'backend'), join(root, 'backend'), { recursive: true });
  await cp(join(source, 'go.mod'), join(root, 'go.mod'));
  await cp(join(source, 'go.sum'), join(root, 'go.sum'));
  return root;
}

test('the audit fails closed when the composition reads the cohort and then ignores it', async () => {
  // The mutation of the finding: the assignment of the cohort of the friend
  // surface is commented out, so the request path admits every signed-in
  // account while the source still names the assignment.
  const tree = await makeRepositoryTree();
  const file = join(tree, 'backend', 'serverapp', 'server.go');
  const original = await readFile(file, 'utf8');
  const mutated = original.replace(
    /(\n\t\t)Cohort: cfg\.Online\.FriendCohort,/,
    '$1// Cohort: cfg.Online.FriendCohort,',
  );
  assert.notEqual(mutated, original, 'the mutation has to comment out the assignment');
  assert.ok(mutated.includes('// Cohort: cfg.Online.FriendCohort,'));
  await writeFile(file, mutated, 'utf8');

  const report = await auditCohortEnforcement({ root: tree, gate: 'friend' });
  const blockers = report.findings.filter((item) => item.severity === 'blocker');
  assert.ok(blockers.length > 0, 'the audit has to report the mutation as a blocker');
  assert.ok(blockers.some((item) => item.code === 'cohort-enforcement-tests-failed'));
});

test('the audit proves the wiring of the untouched tree', async () => {
  const tree = await makeRepositoryTree();
  const report = await auditCohortEnforcement({ root: tree, gate: 'friend' });
  const blockers = report.findings.filter((item) => item.severity === 'blocker');
  assert.deepEqual(blockers, []);
  assert.ok(report.tests.length > 0);
});

// The runtime cohort of the release gate.
//
// A packet that names a cohort setting without the cohort of the server
// would let an owner believe that the access is restricted while every
// signed-in account is still admitted, so the gate requires the runtime
// cohort to be measured and to match the recorded one. The two sets are
// compared by their commitment, so neither of them is read into a report.

test('the runtime cohort of the host is an unsatisfied predicate without a measurement', () => {
  const recorded = cohortMaterial(['user_a']);
  assert.equal(runtimeCohortRequirement('friend', { recorded, host: null }).status, 'unmet');
  assert.equal(runtimeCohortRequirement('friend', { recorded, host: { status: 'pending' } }).status, 'unmet');
  assert.equal(runtimeCohortRequirement('friend', { recorded, host: { status: 'verified' } }).status, 'unmet');
  assert.match(runtimeCohortRequirement('friend', { recorded, host: { status: 'verified' } }).detail, /runtime cohort/i);
});

test('the runtime cohort of the host has to match the recorded cohort', () => {
  const recorded = cohortMaterial(['user_a', 'user_b']);
  const matching = runtimeCohortRequirement('friend', {
    recorded,
    host: { status: 'verified', cohort: { algorithm: recorded.algorithm, commitment: recorded.commitment, count: recorded.count } },
  });
  assert.equal(matching.status, 'met');
  const mismatched = runtimeCohortRequirement('friend', {
    recorded,
    host: { status: 'verified', cohort: { algorithm: recorded.algorithm, commitment: cohortCommitment(['user_a']).commitment, count: 1 } },
  });
  assert.equal(mismatched.status, 'unmet');
  assert.match(mismatched.detail, /does not match/i);
});

test('a gate without a recorded cohort has no runtime cohort to measure', () => {
  const requirement = runtimeCohortRequirement('friend', { recorded: null, host: { status: 'verified' } });
  assert.equal(requirement.status, 'unmet');
  assert.match(requirement.detail, /admits every signed-in account/i);
});

test('the count of the cohort is part of the record of both cohorts', () => {
  const recorded = cohortMaterial(['user_a', 'user_b']);

  // The recorded evidence carries the commitment and the count. A record
  // that carries the commitment and no count has not recorded the size of
  // the set, so it is an unmet requirement.
  const withoutCount = { ...recorded, evidenceCount: null };
  const absent = recordedCohortRequirement('friend', withoutCount);
  assert.equal(absent.status, 'unmet');
  assert.match(absent.detail, /count/i);

  // A count that is not a positive integer is no count at all.
  for (const count of [0, -1, 1.5]) {
    const malformed = { ...recorded, evidenceCount: count };
    assert.equal(recordedCohortRequirement('friend', malformed).status, 'unmet', `the count ${count} is not a count`);
  }

  // The host record carries the commitment and the count as well.
  const measured = runtimeCohortRequirement('friend', {
    recorded,
    host: { status: 'verified', cohort: { algorithm: recorded.algorithm, commitment: recorded.commitment } },
  });
  assert.equal(measured.status, 'unmet');
  assert.match(measured.detail, /count/i);
  for (const count of [0, -1, 1.5]) {
    const malformed = runtimeCohortRequirement('friend', {
      recorded,
      host: { status: 'verified', cohort: { algorithm: recorded.algorithm, commitment: recorded.commitment, count } },
    });
    assert.equal(malformed.status, 'unmet', `the count ${count} is not a count`);
  }
});

test('the packet of a gate without a recorded cohort names no account and is not deployable', () => {
  const packet = buildPacket('friend', {
    evaluation: {
      gate: 'friend',
      requirements: [{ id: 'release-decision', title: 'decision', status: 'met', detail: 'Approved', remediation: null }],
      recordedCohort: null,
    },
  });
  assert.equal(packet.deployable, false);
  assert.equal(packet.configuration.cohortCount, null);
  assert.equal(packet.configuration.cohortCommitment, null);
  assert.match(packet.configuration.cohortNote, /admits every signed-in account/i);
});

test('the packet names the count and the commitment of the recorded cohort and is deployable only with them', () => {
  const recorded = cohortMaterial(['user_a', 'user_b']);
  const packet = buildPacket('friend', {
    evaluation: {
      gate: 'friend',
      requirements: [{ id: 'release-decision', title: 'decision', status: 'met', detail: 'Approved', remediation: null }],
      recordedCohort: { count: recorded.count, commitment: recorded.commitment, algorithm: recorded.algorithm, source: recorded.source },
    },
  });
  assert.equal(packet.configuration.cohortCount, 2);
  assert.equal(packet.configuration.cohortCommitment, recorded.commitment);
  assert.equal(packet.deployable, true);
  assert.deepEqual(packet.blockedBy, []);
  // The packet never carries an account subject of the cohort.
  assert.ok(!JSON.stringify(packet).includes('user_a'));
  assert.ok(!JSON.stringify(packet).includes('user_b'));
});

test('the packet of a gate with an unmet runtime cohort is not deployable', () => {
  const recorded = cohortMaterial(['user_a']);
  const packet = buildPacket('friend', {
    evaluation: {
      gate: 'friend',
      requirements: [
        { id: 'release-decision', title: 'decision', status: 'met', detail: 'Approved', remediation: null },
        { id: 'runtime-cohort', title: 'the runtime cohort of the host', status: 'unmet', detail: 'not measured', remediation: null },
      ],
      recordedCohort: { count: recorded.count, commitment: recorded.commitment, algorithm: recorded.algorithm, source: recorded.source },
    },
  });
  assert.equal(packet.deployable, false);
  assert.ok(packet.blockedBy.includes('runtime-cohort'));
});

test('the gate keeps the runtime cohort unmet while the host proof is missing', async () => {
  const requirements = await evaluateRequirements({
    gate: 'friend',
    root: process.cwd(),
    decision: { decision: 'approved', approver: 'owner', decidedAt: '2026-10-22', commit: 'abc123' },
    cohort: cohortMaterial(['user_a']),
    host: null,
  });
  const runtime = requirements.find((item) => item.id === 'runtime-cohort');
  assert.equal(runtime.status, 'unmet');
  assert.ok(requirements.some((item) => item.status !== 'met'));
});
