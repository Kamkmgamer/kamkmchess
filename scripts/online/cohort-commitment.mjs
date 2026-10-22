// The commitment of an account cohort.
//
// A cohort of a surface names opaque account subjects: the identifiers that
// the verified session of a signed-in account carries in its `sub` claim.
// The subjects are private. They are read from the session, they belong in
// the server configuration, and they never belong in the evidence tree, in a
// rollout packet, in a report or on stdout.
//
// The tooling therefore never compares two cohorts by their members. It
// compares them by their commitment: the one-way digest of the canonical form
// of the set. The canonical form of a set of identifiers is unique (every
// identifier is trimmed, an empty one is dropped, the rest is deduplicated
// and sorted by code unit), so two cohorts carry the same commitment exactly
// when they are the same set of accounts, up to a collision of the digest.
//
// The identifiers themselves live in one protected operator input, outside
// the tracked tree. The tracked evidence carries the algorithm, the count and
// the commitment, and nothing else.
//
// The boundary of the tracked tree is decided on the canonical path of the
// input, so it names the file that a reader would really open. A protected
// input that is a link to a file of the tracked tree is refused before its
// content is read, and a tracked file can never feed the gate as a protected
// input.
//
// Usage:
//   node scripts/online/cohort-commitment.mjs --input .secrets/online-cohort/friend-cohort.json
//   node scripts/online/cohort-commitment.mjs --env ONLINE_FRIEND_COHORT
//   node scripts/online/cohort-commitment.mjs --gate friend --root .

import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

/** The algorithm of the commitment. */
export const COHORT_COMMITMENT_ALGORITHM = 'sha256-canonical-set-v1';

/**
 * Reports whether a value names the supported algorithm of a commitment.
 *
 * The algorithm is the evidence of how a commitment was made. Only the
 * supported algorithm is a commitment of a cohort of this tree, so a record
 * that names another one names a commitment the tree cannot reproduce.
 * @param {any} value
 * @returns {boolean}
 */
export function isSupportedAlgorithm(value) {
  return typeof value === 'string' && value.trim() === COHORT_COMMITMENT_ALGORITHM;
}

/** The domain of the digest, so a commitment of a cohort is never another digest. */
const COHORT_COMMITMENT_DOMAIN = 'online-cohort';

/** The directory of the protected operator inputs, relative to the root of the tree. */
export const PROTECTED_COHORT_DIRECTORY = join('.secrets', 'online-cohort');

/**
 * The homes of a protected input inside the tree.
 *
 * Both directories are ignored by git, so a protected input in one of them
 * is never committed. Every other place inside the tree is refused.
 */
export const PROTECTED_COHORT_HOMES = ['.secrets', '.scratch'];

/**
 * The path of the protected operator input of a gate.
 * @param {string} root
 * @param {string} gate
 * @returns {string}
 */
export function protectedCohortPath(root, gate) {
  return join(root, ...PROTECTED_COHORT_DIRECTORY.split(/[\\/]/), `${gate}-cohort.json`);
}

/**
 * The canonical form of a set of account identifiers.
 *
 * The form is the sorted, deduplicated list of the trimmed identifiers. It is
 * the canonical form of a *set*: the order of a cohort setting does not
 * change the membership of the cohort, so it does not change the commitment
 * either.
 * @param {any} accounts
 * @returns {string[]}
 */
export function canonicalAccounts(accounts) {
  if (!Array.isArray(accounts)) return [];
  /** @type {Set<string>} */
  const unique = new Set();
  for (const account of accounts) {
    if (typeof account !== 'string') continue;
    const trimmed = account.trim();
    if (trimmed === '') continue;
    unique.add(trimmed);
  }
  return [...unique].sort();
}

/**
 * The accounts of a setting value.
 *
 * The value of a cohort setting is the comma-separated list of the account
 * subjects. The parser is the one of the server: every token is trimmed and
 * an empty token is ignored.
 * @param {any} value
 * @returns {string[]}
 */
export function parseCohortValue(value) {
  if (typeof value !== 'string') return [];
  return value.split(',').map((token) => token.trim()).filter((token) => token !== '');
}

/**
 * The commitment of a set of account identifiers.
 *
 * The commitment is one-way: it does not recover the set. It confirms a
 * candidate set, so it is only as private as the identifiers it covers. An
 * account subject is a high-entropy opaque identifier, so a candidate set
 * cannot be enumerated from the commitment.
 *
 * The shape of the result is the shape of a recorded evidence, so the
 * report of this tool can be pasted into the evidence tree as it is.
 * @param {any} accounts
 * @returns {{algorithm: string, commitment: string, count: number}}
 */
export function cohortCommitment(accounts) {
  const canonical = canonicalAccounts(accounts);
  const message = `${COHORT_COMMITMENT_DOMAIN}:${COHORT_COMMITMENT_ALGORITHM}\n${canonical.join('\n')}`;
  const digest = createHash('sha256').update(message, 'utf8').digest('hex');
  return {
    algorithm: COHORT_COMMITMENT_ALGORITHM,
    commitment: `sha256:${digest}`,
    count: canonical.length,
  };
}

/**
 * Reads a commitment of a record.
 *
 * A record of a cohort names the algorithm, the commitment and the count. A
 * record that names no commitment is no commitment at all, and a record that
 * names no algorithm is no record of a cohort at all: the algorithm is the
 * evidence of how the commitment was made, so it is never assumed and never
 * substituted. A record that names another algorithm names a commitment this
 * tree cannot reproduce, so it is not a commitment of a cohort here either.
 *
 * Every record of the evidence tree therefore has to name the supported
 * algorithm explicitly. A record that does not is a missing record, and a
 * missing record leaves the gate blocked.
 * @param {any} record
 * @returns {{algorithm: string, commitment: string, count: number|null}|null}
 */
export function readCommitment(record) {
  if (!record || typeof record !== 'object') return null;
  const algorithm = typeof record.algorithm === 'string' ? record.algorithm.trim() : '';
  // The algorithm is never assumed: an absent or a blank one is no evidence
  // of a commitment, and an unsupported one is a commitment of another form.
  if (!isSupportedAlgorithm(algorithm)) return null;
  const commitment = typeof record.commitment === 'string' ? record.commitment.trim() : '';
  if (commitment === '') return null;
  const count = Number.isInteger(record.count) ? record.count : null;
  return { algorithm, commitment, count };
}

/**
 * Reports whether a path lies inside a tree, once both are absolute.
 *
 * A relation that is still absolute lies on another drive, so the path is
 * outside the tree. Only a true parent traversal leaves the tree, so the
 * first component of the relation has to be '..' itself. A component that
 * merely begins with two dots (a directory named '..cohort', for example) is
 * an ordinary directory of the tree, so the path lies inside it.
 * @param {string} absoluteRoot
 * @param {string} absolutePath
 * @returns {boolean}
 */
function insideRelation(absoluteRoot, absolutePath) {
  const relation = relative(absoluteRoot, absolutePath);
  if (relation === '') return true;
  // A relation that is still absolute lies on another drive, so the path is
  // outside the tree.
  if (isAbsolute(relation)) return false;
  const parts = relation.split(/[\\/]/);
  // Only a true parent traversal leaves the tree, so the first component of
  // the relation has to be '..' itself. A component that merely begins with
  // two dots (a directory named '..cohort', for example) is an ordinary
  // directory of the tree, so the path lies inside it.
  if (parts[0] === '..') return false;
  return !PROTECTED_COHORT_HOMES.includes(parts[0]);
}

/**
 * Reports whether a path lies inside the tracked tree.
 *
 * The tracked tree is the part of the repository that a commit carries. An
 * account subject may never live there, so a protected input inside it is
 * refused instead of read. Only the ignored homes of a protected input
 * (`.secrets` and `.scratch`) and a path outside the tree are accepted.
 *
 * The decision is lexical: it names the path, not the file behind it. The
 * canonical decision is `insideTrackedTreeCanonical`.
 * @param {string} root
 * @param {string} path
 * @returns {boolean}
 */
export function insideTrackedTree(root, path) {
  const absoluteRoot = resolve(root);
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(absoluteRoot, path);
  return insideRelation(absoluteRoot, absolutePath);
}

/**
 * The canonical form of a path: the real path of the file behind it.
 *
 * Every symbolic link of the path is resolved, so the form names the file
 * that a reader would really open. A path that does not exist has no file
 * behind it, so the canonical form of its directory is used with its own
 * name: the directory of a missing file may still be a link into the tracked
 * tree, and that link has to be seen.
 * @param {string} path
 * @returns {Promise<string|null>} The canonical path, or null when neither
 * the path nor its directory can be resolved.
 */
export async function canonicalPath(path) {
  try {
    return await realpath(path);
  } catch {
    const directory = dirname(path);
    try {
      return join(await realpath(directory), basename(path));
    } catch {
      return null;
    }
  }
}

/**
 * The boundary of the tracked tree for a path.
 *
 * The boundary is decided twice: once on the name of the path and once on the
 * file behind it. A protected input is accepted only when both of them lie
 * outside the tracked tree, so a link into the tree is refused and a name
 * inside the tree is refused as well.
 * @param {string} root
 * @param {string} path
 * @returns {Promise<{absolutePath: string, canonical: string|null, refused: boolean}>}
 */
async function trackedBoundary(root, path) {
  const absoluteRoot = resolve(root);
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(absoluteRoot, path);
  const canonicalRoot = (await canonicalPath(absoluteRoot)) ?? absoluteRoot;
  const canonical = await canonicalPath(absolutePath);
  const named = insideRelation(absoluteRoot, absolutePath);
  // Nothing could be resolved, so the name of the path is the only thing
  // that is known about it.
  const located = canonical === null ? named : insideRelation(canonicalRoot, canonical);
  return { absolutePath, canonical, refused: named || located };
}

/**
 * Reports whether a path lies inside the tracked tree, once every link of it
 * is resolved.
 *
 * The tracked tree is decided by the file that a reader would really open,
 * not only by the name of the path. A protected input that is a symbolic link
 * to a file of the tracked tree is refused, and so is a protected input whose
 * directory is a link into the tracked tree. Only a protected input whose
 * real file lies in an ignored home of the tree (`.secrets` and `.scratch`)
 * or outside the tree is accepted.
 * @param {string} root
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function insideTrackedTreeCanonical(root, path) {
  const boundary = await trackedBoundary(root, path);
  return boundary.refused;
}

/**
 * Reads the protected operator input of a cohort.
 *
 * The read never throws and never prints an identifier. A missing file is a
 * missing input, an unreadable file is an invalid input, and both of them
 * leave the gate blocked.
 *
 * The boundary of the tracked tree is decided before the content of the file
 * is read, and it is decided on the canonical path: a protected input that is
 * a link to a file of the tracked tree is refused without its content ever
 * being read, so a tracked file can never feed the gate as a protected
 * input.
 * @param {string} path
 * @param {{root?: string}} [options]
 * @returns {Promise<{path: string, present: boolean, invalid: boolean, refused: boolean, accounts: string[]}>}
 */
export async function readProtectedCohort(path, options = {}) {
  const root = options.root ?? process.cwd();
  const empty = { path, present: false, invalid: false, refused: false, accounts: [] };
  // A protected input inside the tracked tree is a leak waiting to happen.
  // The name of the path and the file behind it both have to be outside it.
  const boundary = await trackedBoundary(root, path);
  if (boundary.refused) {
    return { ...empty, refused: true };
  }
  // The content is read through the canonical path, so the bytes that are
  // parsed are the bytes of the file whose place was approved.
  /** @type {string} */
  let text;
  try {
    text = await readFile(boundary.canonical ?? boundary.absolutePath, 'utf8');
  } catch {
    return empty;
  }
  /** @type {any} */
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ...empty, present: true, invalid: true };
  }
  /** @type {any[]} */
  let accounts;
  if (typeof body === 'string') {
    accounts = parseCohortValue(body);
  } else if (body && typeof body === 'object') {
    if (Array.isArray(body.accounts)) accounts = body.accounts;
    else if (typeof body.value === 'string') accounts = parseCohortValue(body.value);
    else if (Array.isArray(body.cohort)) accounts = body.cohort;
    else return { ...empty, present: true, invalid: true };
  } else {
    return { ...empty, present: true, invalid: true };
  }
  const cleaned = canonicalAccounts(accounts);
  if (cleaned.length === 0) return { ...empty, present: true, invalid: true };
  return { path, present: true, invalid: false, refused: false, accounts: cleaned };
}

/**
 * The protected input of a gate.
 * @param {{root: string, gate: string, input?: string|null}} options
 * @returns {Promise<{path: string, present: boolean, invalid: boolean, refused: boolean, accounts: string[]}>}
 */
export async function readGateProtectedCohort(options) {
  const explicit = options.input ?? null;
  const path = explicit && explicit !== ''
    ? resolve(options.root, explicit)
    : protectedCohortPath(options.root, options.gate);
  return readProtectedCohort(path, { root: options.root });
}

/**
 * The commitment of the protected input of a gate.
 * @param {string[]} accounts
 * @returns {{algorithm: string, commitment: string, count: number}|null}
 */
export function commitmentOfAccounts(accounts) {
  const canonical = canonicalAccounts(accounts);
  if (canonical.length === 0) return null;
  return cohortCommitment(canonical);
}

/**
 * Reports whether two cohorts are the same set of accounts.
 *
 * The comparison is over the commitments, so it never holds an identifier of
 * either side. A missing commitment on either side is never a match: an
 * unknown cohort is not a matching cohort. A record that names no algorithm
 * and a record that names another algorithm are never a match either: two
 * commitments are only comparable when both sides name the same algorithm.
 * @param {any} left
 * @param {any} right
 * @returns {boolean}
 */
export function sameCommitment(left, right) {
  const a = readCommitment(left);
  const b = readCommitment(right);
  if (!a || !b) return false;
  if (a.algorithm !== b.algorithm) return false;
  if (a.commitment !== b.commitment) return false;
  if (a.count !== null && b.count !== null && a.count !== b.count) return false;
  return true;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const rootIndex = arguments_.indexOf('--root');
  const root = rootIndex >= 0 ? arguments_[rootIndex + 1] : process.cwd();
  const gateIndex = arguments_.indexOf('--gate');
  const gate = gateIndex >= 0 ? arguments_[gateIndex + 1] : 'friend';
  const inputIndex = arguments_.indexOf('--input');
  const input = inputIndex >= 0 ? arguments_[inputIndex + 1] : null;
  const envIndex = arguments_.indexOf('--env');
  const environment = envIndex >= 0 ? arguments_[envIndex + 1] : null;

  /** @type {string[]} */
  let accounts;
  /** @type {string} */
  let source;
  if (environment) {
    accounts = parseCohortValue(process.env[environment] ?? '');
    source = `the environment variable ${environment}`;
  } else {
    const protectedInput = await readGateProtectedCohort({ root, gate, input });
    if (protectedInput.refused) {
      process.stdout.write('the protected input may not live inside the tracked tree\n');
      process.exitCode = 1;
      return;
    }
    if (!protectedInput.present) {
      process.stdout.write(`no protected operator input was found at ${protectedInput.path}\n`);
      process.exitCode = 1;
      return;
    }
    if (protectedInput.invalid) {
      process.stdout.write(`the protected operator input at ${protectedInput.path} names no account\n`);
      process.exitCode = 1;
      return;
    }
    accounts = protectedInput.accounts;
    source = protectedInput.path;
  }

  const record = commitmentOfAccounts(accounts);
  if (!record) {
    process.stdout.write('the cohort names no account\n');
    process.exitCode = 1;
    return;
  }
  // The report carries the commitment and the count. It never carries an
  // identifier of the cohort.
  if (arguments_.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ...record, source }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`algorithm:   ${record.algorithm}\n`);
  process.stdout.write(`commitment: ${record.commitment}\n`);
  process.stdout.write(`count:      ${record.count}\n`);
  process.stdout.write(`source:     ${source}\n`);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/online/cohort-commitment.mjs')) {
  await main();
}
