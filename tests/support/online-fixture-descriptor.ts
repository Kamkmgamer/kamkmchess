/**
 * The descriptor of the online fixture of a run.
 *
 * The fixture-dependent browser cases need the real service: the Go API, a
 * real PostgreSQL schema, the pinned private rules worker and the real
 * authorization code. The descriptor is the machine-readable handoff of that
 * service, and the environment names the file that holds it.
 *
 * Three states are honest here, and they are never mixed up:
 *
 *   - no descriptor at all: the run had no fixture, so the cases skip. A
 *     skipped case is not a passed case, so such a run proves nothing about
 *     the online service and it is never recorded as online coverage;
 *   - a descriptor and a mismatch between the build and the fixture, a closed
 *     surface, a missing route or a missing field: the run fails;
 *   - a descriptor the caller supplied that cannot be read or that does not
 *     have the shape of a descriptor: the run fails. An unusable descriptor
 *     is a broken run and not an absent fixture, so it is never a silent
 *     skip.
 *
 * The base URL of the descriptor is the address the fixture's credential is
 * sent to, so it is parsed and compared with the loopback origin of the
 * fixture. A base URL that only looks like the loopback address is a broken
 * descriptor and fails the run. The rule itself is the shared one of
 * `scripts/shared/fixture-base-url.mjs`, the same module the Node tooling of
 * the fixture uses, so the two readers cannot drift apart.
 *
 * ONLINE_FIXTURE_STRICT=1 makes the absent descriptor fail as well.
 */
import { readFile } from 'node:fs/promises';

import { describeFixtureBaseUrlProblem } from '../../scripts/shared/fixture-base-url.mjs';

/** The environment variable that names the descriptor file of the run. */
export const ONLINE_FIXTURE_DESCRIPTOR_ENV = 'ONLINE_FIXTURE_DESCRIPTOR';

/** The environment variable that makes a missing descriptor fail. */
export const ONLINE_FIXTURE_STRICT_ENV = 'ONLINE_FIXTURE_STRICT';

/** The descriptor the fixture writes for the harness. */
export interface OnlineFixtureDescriptor {
  readonly baseUrl: string;
  readonly issuer: string;
  readonly allowedOrigins: readonly string[];
  readonly accounts: readonly { readonly id: string; readonly token: string }[];
  readonly keyPath: string;
}

/** The state of the descriptor of a run. */
export type OnlineFixtureDescriptorState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly descriptor: OnlineFixtureDescriptor }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * The decision the fixture-dependent cases take.
 *
 * The coverage field says what the run proves. A run without a fixture has no
 * online coverage, whatever the run of the rest of the suite reports.
 */
export type OnlineFixtureGate =
  | {
    readonly action: 'run';
    readonly descriptor: OnlineFixtureDescriptor;
    readonly coverage: 'covered';
    readonly message: string;
  }
  | {
    readonly action: 'skip';
    readonly descriptor: null;
    readonly coverage: 'not_covered';
    readonly message: string;
  }
  | {
    readonly action: 'fail';
    readonly descriptor: null;
    readonly coverage: 'not_covered';
    readonly message: string;
  };

/** The path of the descriptor file of the run. An empty path means none. */
export function onlineFixtureDescriptorPath(env: NodeJS.ProcessEnv = process.env): string {
  return (env[ONLINE_FIXTURE_DESCRIPTOR_ENV] ?? '').trim();
}

/**
 * Whether the run is strict.
 *
 * A strict run treats a missing descriptor as a failure of the run, because
 * the run then claims to cover the online service and does not.
 */
export function onlineFixtureIsStrict(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[ONLINE_FIXTURE_STRICT_ENV] ?? '').trim() === '1';
}

/**
 * The reason the descriptor of the run is unusable.
 *
 * The answer is null when the value is a descriptor. Every other answer names
 * the field that is missing or the field that has the wrong shape, so the
 * failure of a run says what the caller has to fix.
 *
 * The base URL is the address the credential of the fixture travels to: the
 * browser mints a signed session token and sends it to that URL, so the shape
 * of the URL decides where a secret travels. The check is a parse of the URL
 * and not a prefix of its text, and it is the shared rule of
 * `scripts/shared/fixture-base-url.mjs`, the same module the Node tooling of
 * the fixture uses. A text prefix accepts
 * `http://127.0.0.1.attacker.example`, which starts with the loopback address
 * and is not the loopback address at all.
 */
function describeDescriptorProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'the descriptor is not an object';
  }
  const descriptor = value as Partial<Record<keyof OnlineFixtureDescriptor, unknown>>;
  const baseUrlProblem = describeFixtureBaseUrlProblem(descriptor.baseUrl);
  if (baseUrlProblem) {
    return `the descriptor has no loopback base URL of the fixture: ${baseUrlProblem}`;
  }
  if (typeof descriptor.issuer !== 'string' || descriptor.issuer.length === 0) {
    return 'the descriptor has no issuer';
  }
  if (typeof descriptor.keyPath !== 'string' || descriptor.keyPath.length === 0) {
    return 'the descriptor has no path of the signing key';
  }
  if (!Array.isArray(descriptor.accounts) || descriptor.accounts.length === 0) {
    return 'the descriptor has no accounts';
  }
  for (const account of descriptor.accounts) {
    if (!account || typeof account !== 'object') {
      return 'an account of the descriptor is not an object';
    }
    const entry = account as { id?: unknown; token?: unknown };
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      return 'an account of the descriptor has no id';
    }
    if (typeof entry.token !== 'string' || entry.token.length === 0) {
      return 'an account of the descriptor has no token';
    }
  }
  if (descriptor.allowedOrigins !== undefined) {
    if (!Array.isArray(descriptor.allowedOrigins)) {
      return 'the allowed origins of the descriptor are not a list';
    }
    if (descriptor.allowedOrigins.some(origin => typeof origin !== 'string')) {
      return 'the allowed origins of the descriptor are not a list of strings';
    }
  }
  return null;
}

/** The message of a failure that has no message of its own. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the descriptor of the run.
 *
 * The answer is absent when the run named no descriptor at all. It is invalid
 * when the caller named one and it cannot be used, and the reason says why.
 */
export async function resolveOnlineFixtureDescriptor(
  options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<OnlineFixtureDescriptorState> {
  const path = options.path ?? onlineFixtureDescriptorPath(options.env ?? process.env);
  if (!path) return { kind: 'absent' };
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return {
      kind: 'invalid',
      reason: `the online fixture descriptor ${path} could not be read: ${describeError(error)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      kind: 'invalid',
      reason: `the online fixture descriptor ${path} is not valid JSON: ${describeError(error)}`,
    };
  }
  const problem = describeDescriptorProblem(parsed);
  if (problem) {
    return { kind: 'invalid', reason: `the online fixture descriptor ${path} is not usable: ${problem}` };
  }
  const value = parsed as {
    baseUrl: string;
    issuer: string;
    allowedOrigins?: unknown;
    accounts: { id: string; token: string }[];
    keyPath: string;
  };
  return {
    kind: 'present',
    descriptor: {
      baseUrl: value.baseUrl,
      issuer: value.issuer,
      allowedOrigins: Array.isArray(value.allowedOrigins) ? value.allowedOrigins as string[] : [],
      accounts: value.accounts,
      keyPath: value.keyPath,
    },
  };
}

/**
 * Decides what the fixture-dependent cases of a file do.
 *
 * The reason names what the cases need, so the skip of a run without a
 * fixture says what was not covered.
 */
export async function openOnlineFixtureGate(
  options: { reason: string; path?: string; env?: NodeJS.ProcessEnv },
): Promise<OnlineFixtureGate> {
  const env = options.env ?? process.env;
  const state = await resolveOnlineFixtureDescriptor(
    options.path === undefined ? { env } : { path: options.path, env },
  );
  if (state.kind === 'present') {
    return {
      action: 'run',
      descriptor: state.descriptor,
      coverage: 'covered',
      message: 'the online fixture of the run is available',
    };
  }
  if (state.kind === 'invalid') {
    return { action: 'fail', descriptor: null, coverage: 'not_covered', message: state.reason };
  }
  const strict = onlineFixtureIsStrict(env);
  const message = strict
    ? `no online fixture descriptor: ${options.reason}, and ONLINE_FIXTURE_STRICT=1 makes the missing descriptor a failure of the run`
    : `no online fixture descriptor: ${options.reason}, so these cases did not run and the run proves no online fixture coverage`;
  return {
    action: strict ? 'fail' : 'skip',
    descriptor: null,
    coverage: 'not_covered',
    message,
  };
}
