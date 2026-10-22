// The assertion of the release gates of the continuous integration.
//
// The friend gate and the public queue gate are two independent gates, and
// both of them stay blocked until the owner records a release decision for
// the gate. The local scenario evidence is never a release approval: a
// passing scenario closes a scenario of the acceptance map and nothing else,
// so no evidence of a run may open a surface.
//
// The assertion therefore states the one invariant that the continuous
// integration owns: in an environment without an owner approval, both gates
// have to stay blocked.
//
// It evaluates **both** gates, and it fails when
//
//   - the evaluator of a gate fails, because an unevaluated gate is never a
//     blocked gate, and
//   - a gate reports itself as ready, because a ready gate would open a
//     surface without a recorded owner approval.
//
// The exit status of the assertion is the exit status of the job. A status
// that is swallowed hides an opened gate, so the tool never swallows one.
//
// The tool opens nothing, turns nothing on and authorizes no release. It only
// reports the state of the gates of the tree it reads.
//
// Usage:
//   node scripts/online/release-gate-guard.mjs [--root DIR] [--json]

import process from 'node:process';

import { evaluateGate } from './feature-gates.mjs';

/**
 * @typedef {{gate: string, status: string, blocked: boolean, error: string|null, unmet: string[]}} GateReport
 * @typedef {{gate: string, code: 'gate-open'|'evaluator-error', detail: string}} GuardFailure
 * @typedef {{ok: boolean, gates: GateReport[], failures: GuardFailure[]}} GuardReport
 */

/** The gates the assertion covers. Both of them have to stay blocked. */
export const GUARDED_GATES = ['friend', 'queue'];

/**
 * Evaluates a gate and catches the failure of the evaluator.
 *
 * An evaluator that throws is not a blocked gate, so the failure is carried
 * out of the evaluation instead of ending the run of the assertion.
 * @param {(options: any) => Promise<any>} evaluate
 * @param {any} options
 * @returns {Promise<{evaluation: any|null, error: string|null}>}
 */
async function evaluateSafely(evaluate, options) {
  try {
    return { evaluation: await evaluate(options), error: null };
  } catch (error) {
    return { evaluation: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Asserts that every guarded gate is blocked.
 *
 * The evaluator is injected, so the assertion can be observed with a
 * synthetic gate: a gate that is ready, a gate that cannot be evaluated and
 * a gate that is blocked are three different outcomes, and only the third one
 * passes.
 *
 * A gate passes only when the evaluator reports it as blocked. Every other
 * outcome is a failure: a ready gate is an opened surface, an unknown status
 * is not a proof of anything, and an evaluator that throws proves nothing at
 * all.
 * @param {{root: string, gates?: string[], evaluate?: (options: any) => Promise<any>, cohortInput?: string|null}} input
 * @returns {Promise<GuardReport>}
 */
export async function assertReleaseGatesBlocked(input) {
  const gates = input.gates ?? GUARDED_GATES;
  const evaluate = input.evaluate ?? evaluateGate;
  /** @type {GateReport[]} */
  const reports = [];
  /** @type {GuardFailure[]} */
  const failures = [];

  for (const gate of gates) {
    const outcome = await evaluateSafely(evaluate, {
      gate,
      root: input.root,
      cohortInput: input.cohortInput ?? null,
    });
    if (outcome.error !== null) {
      reports.push({ gate, status: 'error', blocked: false, error: outcome.error, unmet: [] });
      failures.push({
        gate,
        code: 'evaluator-error',
        detail: `The ${gate} release gate could not be evaluated: ${outcome.error}. An unevaluated gate is never a blocked gate.`,
      });
      continue;
    }

    const evaluation = outcome.evaluation;
    const status = typeof evaluation?.status === 'string' ? evaluation.status : 'unknown';
    const requirements = Array.isArray(evaluation?.requirements) ? evaluation.requirements : [];
    const unmet = requirements.filter((item) => item.status !== 'met').map((item) => item.id);
    const blocked = status === 'blocked';
    reports.push({ gate, status, blocked, error: null, unmet });
    if (!blocked) {
      failures.push({
        gate,
        code: 'gate-open',
        detail: `The ${gate} release gate reports "${status}" and is not blocked, so it would open a surface without a recorded owner release approval.`,
      });
    }
  }

  return { ok: failures.length === 0, gates: reports, failures };
}

/**
 * Renders the assertion for the console.
 *
 * The rendering names the gate that is not blocked, so a failing run says
 * which of the two surfaces would have opened.
 * @param {GuardReport} report
 * @returns {string}
 */
export function renderGuardReport(report) {
  /** @type {string[]} */
  const lines = [];
  lines.push(`release gate guard: ${report.ok ? 'blocked' : 'failed'}`);
  for (const gate of report.gates) {
    const unmet = gate.unmet.length > 0 ? ` (blocked by: ${gate.unmet.join(', ')})` : '';
    lines.push(`  ${gate.gate} gate: ${gate.status}${unmet}`);
  }
  for (const failure of report.failures) {
    lines.push(`  FAILED ${failure.gate}: ${failure.detail}`);
  }
  if (report.ok) {
    lines.push('  every guarded gate is blocked, so no release surface opens in this environment.');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The exit status of the assertion.
 * @param {GuardReport} report
 * @returns {number}
 */
export function guardExitCode(report) {
  return report.ok ? 0 : 1;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const rootIndex = arguments_.indexOf('--root');
  const root = rootIndex >= 0 ? arguments_[rootIndex + 1] : process.cwd();
  const cohortInputIndex = arguments_.indexOf('--cohort-input');
  const cohortInput = cohortInputIndex >= 0 ? arguments_[cohortInputIndex + 1] : null;

  const report = await assertReleaseGatesBlocked({ root, cohortInput });
  if (arguments_.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      tool: 'scripts/online/release-gate-guard.mjs',
      guardedGates: GUARDED_GATES,
      disclaimer: 'This assertion reads the repository and the gates of it. It opens nothing and authorizes no release.',
      ...report,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(renderGuardReport(report));
  }
  process.exitCode = guardExitCode(report);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/online/release-gate-guard.mjs')) {
  await main();
}
