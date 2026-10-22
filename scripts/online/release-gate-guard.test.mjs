// Offline tests of the release gate assertion of the continuous integration.
//
// The assertion states the one invariant that the continuous integration
// owns: in an environment without an owner approval, both release gates have
// to stay blocked. The gates are synthetic here, so the tests observe the
// assertion itself and not the state of the repository.
//
// Nothing here touches a database, a network service or a credential, and no
// real account subject is used.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertReleaseGatesBlocked,
  GUARDED_GATES,
  guardExitCode,
  renderGuardReport,
} from './release-gate-guard.mjs';

/**
 * A synthetic evaluation of a gate.
 * @param {string} status
 * @returns {any}
 */
function evaluation(status) {
  return {
    gate: 'friend',
    status,
    requirements: status === 'blocked'
      ? [{ id: 'release-decision', title: 'the recorded owner release decision', status: 'unmet', detail: 'No release decision is recorded for this gate.', remediation: null }]
      : [],
    recordedCohort: null,
  };
}

/**
 * An evaluator that answers with a chosen status per gate.
 * @param {Record<string, string>} statuses
 * @returns {(options: any) => Promise<any>}
 */
function evaluatorOf(statuses) {
  /** @type {string[]} */
  const seen = [];
  const evaluate = async (options) => {
    seen.push(options.gate);
    return evaluation(statuses[options.gate] ?? 'blocked');
  };
  evaluate.seen = seen;
  return evaluate;
}

/**
 * An evaluator that fails for one gate.
 * @param {string} failing
 * @param {string} message
 * @returns {(options: any) => Promise<any>}
 */
function failingEvaluator(failing, message) {
  return async (options) => {
    if (options.gate === failing) throw new Error(message);
    return evaluation('blocked');
  };
}

test('the assertion covers the friend gate and the public queue gate', () => {
  assert.deepEqual(GUARDED_GATES, ['friend', 'queue']);
});

test('two blocked gates pass the assertion', async () => {
  const evaluate = evaluatorOf({ friend: 'blocked', queue: 'blocked' });
  const report = await assertReleaseGatesBlocked({ root: process.cwd(), evaluate });
  assert.equal(report.ok, true);
  assert.deepEqual(report.failures, []);
  assert.equal(report.gates.length, 2);
  assert.ok(report.gates.every((gate) => gate.blocked === true && gate.status === 'blocked'));
  assert.equal(guardExitCode(report), 0);
});

test('the assertion evaluates both gates, so an omitted gate is never a passed one', async () => {
  const evaluate = evaluatorOf({ friend: 'blocked', queue: 'blocked' });
  await assertReleaseGatesBlocked({ root: process.cwd(), evaluate });
  assert.deepEqual(evaluate.seen, ['friend', 'queue']);
});

test('a ready friend gate fails the assertion and names the gate', async () => {
  const evaluate = evaluatorOf({ friend: 'ready', queue: 'blocked' });
  const report = await assertReleaseGatesBlocked({ root: process.cwd(), evaluate });
  assert.equal(report.ok, false);
  assert.equal(report.failures.length, 1);
  const failure = report.failures[0];
  assert.equal(failure.gate, 'friend');
  assert.equal(failure.code, 'gate-open');
  assert.match(failure.detail, /friend/);
  assert.match(failure.detail, /ready/);
  assert.equal(guardExitCode(report), 1);
});

test('a ready queue gate fails the assertion and names the gate', async () => {
  const evaluate = evaluatorOf({ friend: 'blocked', queue: 'ready' });
  const report = await assertReleaseGatesBlocked({ root: process.cwd(), evaluate });
  assert.equal(report.ok, false);
  const failure = report.failures[0];
  assert.equal(failure.gate, 'queue');
  assert.equal(failure.code, 'gate-open');
  assert.match(failure.detail, /queue/);
  assert.match(failure.detail, /ready/);
  assert.equal(guardExitCode(report), 1);
});

test('a gate that reports an unknown status is not a blocked gate', async () => {
  const evaluate = evaluatorOf({ friend: 'blocked', queue: 'unknown' });
  const report = await assertReleaseGatesBlocked({ root: process.cwd(), evaluate });
  assert.equal(report.ok, false);
  assert.equal(report.failures[0].gate, 'queue');
  assert.equal(report.failures[0].code, 'gate-open');
});

test('an evaluator that fails on the friend gate fails the assertion', async () => {
  const evaluate = failingEvaluator('friend', 'the evidence ledger could not be read');
  const report = await assertReleaseGatesBlocked({ root: process.cwd(), evaluate });
  assert.equal(report.ok, false);
  const failure = report.failures[0];
  assert.equal(failure.gate, 'friend');
  assert.equal(failure.code, 'evaluator-error');
  assert.match(failure.detail, /friend/);
  assert.match(failure.detail, /the evidence ledger could not be read/);
  assert.equal(guardExitCode(report), 1);
});

test('an evaluator that fails on the queue gate fails the assertion', async () => {
  const evaluate = failingEvaluator('queue', 'the enforcement tests could not be run');
  const report = await assertReleaseGatesBlocked({ root: process.cwd(), evaluate });
  assert.equal(report.ok, false);
  const failure = report.failures[0];
  assert.equal(failure.gate, 'queue');
  assert.equal(failure.code, 'evaluator-error');
  assert.match(failure.detail, /the enforcement tests could not be run/);
});

test('the report of a failing assertion names the gate that opened', async () => {
  const evaluate = evaluatorOf({ friend: 'blocked', queue: 'ready' });
  const report = await assertReleaseGatesBlocked({ root: process.cwd(), evaluate });
  const rendered = renderGuardReport(report);
  assert.match(rendered, /queue gate: ready/);
  assert.match(rendered, /FAILED queue/);
  // The gate that is blocked is named as well, so the report shows the state
  // of both gates.
  assert.match(rendered, /friend gate: blocked/);
});

test('the report of a passing assertion names both blocked gates', async () => {
  const evaluate = evaluatorOf({ friend: 'blocked', queue: 'blocked' });
  const report = await assertReleaseGatesBlocked({ root: process.cwd(), evaluate });
  const rendered = renderGuardReport(report);
  assert.match(rendered, /release gate guard: blocked/);
  assert.match(rendered, /friend gate: blocked/);
  assert.match(rendered, /queue gate: blocked/);
  assert.ok(!rendered.includes('FAILED'));
});

test('the continuous integration runs the assertion and does not swallow the gates', async () => {
  const workflow = await readFile(join(process.cwd(), '.github', 'workflows', 'online-ops.yml'), 'utf8');
  // The assertion is the step of the job.
  assert.match(workflow, /node scripts\/online\/release-gate-guard\.mjs/);
  // The swallowed evaluation is gone: a status that is swallowed hides an
  // opened gate.
  assert.ok(!/feature-gates\.mjs evaluate[^\n]*\|\|\s*true/.test(workflow));
  // The test of the assertion runs in the same job.
  assert.match(workflow, /node --test[^\n]*scripts\/online\/release-gate-guard\.test\.mjs/);
});
