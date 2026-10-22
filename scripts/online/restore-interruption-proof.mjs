// The native restore interruption proof.
//
// The native proof of the restore shows the lifecycle of a restore that
// finishes. This proof shows the interruptions that decide whether a removed
// subject can come back:
//
//   - the restore is killed while the import transaction is open: the
//     transaction is rolled back, so the live removals are still in the
//     database and the take-over replays them;
//   - the restore is killed after the import committed and before the
//     removal ledger was replayed: the import replaced the schema, so the
//     removals that only the live database carried are gone, the recovery
//     refuses and keeps the service closed, and the take-over replays the
//     exact ledger the restore owed from the durable evidence next to the
//     marker of the lifecycle;
//   - the durable evidence of a restore is copied to a protected place, the
//     evidence directory of the run is lost, and the recovery of a restore
//     whose removals are applied and erased succeeds with the copy alone.
//
// The kill is real and deterministic. The restore runs the real binary of the
// repository against a real encrypted bundle, and the loader is the real
// psql: the proof only puts a barrier in front of it.
//
//   during  the barrier waits for the destructive statement of the real dump
//           and holds the import transaction open with a marker statement, so
//           the kill lands while the transaction is open and after the
//           import already destroyed the removal ledger of the live database;
//   after   the barrier waits after the real psql committed, so the kill
//           lands between the commit of the import and the replay of the
//           removals;
//   none    the real psql runs without a barrier, for the take-over.
//
// Every case has a fence of its own, a marker of its own and an application
// name of its own. Nothing of one case can be mistaken for the state of
// another case: the owner of the fence, the record of the owed ledger and the
// backend of the barrier are read for the case they belong to.
//
// Usage:
//   node scripts/online/restore-interruption-proof.mjs [--json] [--keep]

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { holderDatabaseUrl, redact, resolveTarget } from '../../deploy/verify-fence-access.mjs';

const DEFAULT_CONTAINER = 'kamkmchess-kha67-local';
const DEFAULT_DATABASE_URL = 'postgres://postgres@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable';
const ROOT = process.cwd();
const RUN = randomUUID().replace(/-/g, '').slice(0, 12);
const PASSPHRASE = 'fixture-only-passphrase';
const DIRECTORY = join(ROOT, '.scratch', 'restore-interruption', RUN);
const VOLUME = `kamkmchess-interruption-${RUN}`;
// The parent of the fences of the cases. Every case has a fence of its own
// below it, so the marker of a case, its lock and its evidence directory
// never belong to another case.
const FENCE_ROOT = `/backups/fence-${RUN}`;
// The protected copy of a record of the run. It is outside every fence
// parent, so the loss of an evidence directory never takes it with it.
const PROTECTED = `/backups/protected-${RUN}`;
const API_UID = '65532:65532';
// The relation whose destruction inside the import transaction is measured.
// The dump of the real tool drops it, and the rows of the live database that
// only the live database carried are gone with it.
const BARRIER_RELATION = 'online_removal_ledger';

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string, string>}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolvePromise({ code: -1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
    child.stdin.end();
  });
}

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

/**
 * The shape of the identifier of a restore.
 *
 * The identifier becomes a name of a file, so it may not carry a path
 * separator. The pattern is the one of the production code: the proof never
 * builds a path from a name it did not check.
 */
export const RESTORE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

/**
 * Reports whether an identifier of a restore can be used as a name.
 * @param {unknown} value
 * @returns {boolean}
 */
export function restoreIdIsUsable(value) {
  return typeof value === 'string' && RESTORE_ID_PATTERN.test(value);
}

/**
 * The cases of the proof.
 *
 * Every case has a fence of its own, a database of its own, an application
 * name of its own and a marker of its own. The isolation is the point: a
 * barrier of one case may never be mistaken for the barrier of another one.
 * @param {string} run
 * @returns {Record<string, {fence: string, database: string, application: string, marker: string}>}
 */
export function proofCases(run) {
  const cases = {};
  // The barrier of a case. The evidence case is killed after the commit as
  // well, so it uses the barrier of the commit with a marker of its own.
  const barriers = { during: 'during', after: 'after', evidence: 'after', nosink: 'none' };
  for (const name of ['during', 'after', 'evidence', 'nosink']) {
    cases[name] = {
      fence: `/backups/fence-${run}/${name}`,
      database: `kamkmchess_interruption_${name}_${run}`,
      application: `kamkm_proof_${name}_${run}`,
      // The loader without a barrier of the case. The take-over of a case
      // runs without a barrier, and the application name of it is the name of
      // the case as well, so a backend of one case is never the backend of
      // another one.
      plainApplication: `kamkm_proof_plain_${name}_${run}`,
      marker: `/backups/barrier-${name}-${run}.committed`,
      barrier: barriers[name],
    };
  }
  return cases;
}

/**
 * The statements the barrier injects into the real import.
 *
 * The statements run inside the transaction of the real import, after the
 * destructive statement of the real dump has run. The first statement refuses
 * the load when the relation is still there, so a barrier that did not run
 * after the destructive statement aborts the import instead of pretending
 * that it did.
 *
 * The second statement writes a marker from inside the transaction, so the
 * proof reads the state the import itself saw and the backend that saw it.
 * The third statement holds the transaction open, so the kill lands while it
 * is open.
 *
 * The content of the marker holds no private payload: it names the backend
 * and whether the relation of the removal ledger is still there.
 * @param {{relation: string, marker: string}} options
 * @returns {string}
 */
export function injectionScript(options) {
  const relation = options.relation;
  const marker = options.marker;
  return `-- The statements of the proof barrier of the import.
--
-- They run inside the transaction of the real import, after the destructive
-- statement of the real dump has run.
DO $proof$ BEGIN
  IF to_regclass('${relation}') IS NOT NULL THEN
    RAISE EXCEPTION 'the proof barrier did not run after the destructive statement of the import';
  END IF;
END $proof$;
--
-- The marker of the barrier, written from inside the transaction.
COPY (SELECT 'pid=' || pg_backend_pid()::text || ' relation_present=' || (to_regclass('${relation}') IS NOT NULL)::text) TO '${marker}';
--
-- The transaction stays open here, so the kill lands while it is open.
SELECT pg_sleep(600);
`;
}

/**
 * The barrier of the native import.
 *
 * The real psql runs the real dump. The barrier only decides when the
 * restore is killed.
 * @param {string} mode during, after or none
 * @param {{application?: string, marker?: string, inject?: string, pattern?: string}} [options]
 * @returns {string}
 */
export function barrierScript(mode, options = {}) {
  const application = options.application ?? `kamkm_proof_barrier_${mode}`;
  const marker = options.marker ?? `/backups/barrier-${mode}`;
  if (mode === 'during') {
    const inject = options.inject ?? '/fixtures/inject-during.sql';
    const pattern = options.pattern ?? `^DROP TABLE IF EXISTS public[.]${BARRIER_RELATION};$`;
    return `#!/bin/sh
# The barrier of the native import, in the mode that holds the import
# transaction open.
#
# The real psql runs the real dump. The barrier waits for the destructive
# statement of the dump and then writes the marker of the import from inside
# the transaction, so the kill lands while the transaction is open and after
# the import already destroyed the removal ledger of the live database.
#
# The mode is written into this program: the environment of the loader is an
# explicit allowlist of the production code and never carries a switch of the
# proof.
set -e
REAL_PSQL="$(command -v psql)"
export PGAPPNAME=${application}
awk -v inject='${inject}' -v pattern='${pattern}' 'BEGIN { done = 0 } { print; if (!done && $0 ~ pattern) { while ((getline line < inject) > 0) print line; close(inject); done = 1 } }' \\
  | "$REAL_PSQL" "$@"
`;
  }
  if (mode === 'after') {
    return `#!/bin/sh
# The barrier of the native import, in the mode that waits after the commit.
#
# The real psql runs the real dump and the import commits. The program then
# writes the marker of the commit and waits, so the kill lands between the
# commit of the import and the replay of the removals.
#
# The mode is written into this program: the environment of the loader is an
# explicit allowlist of the production code and never carries a switch of the
# proof.
set -e
REAL_PSQL="$(command -v psql)"
export PGAPPNAME=${application}
"$REAL_PSQL" "$@"
touch ${marker}
while true; do sleep 1; done
`;
  }
  return `#!/bin/sh
# The loader of the import without a barrier: the real psql runs the real
# dump.
set -e
REAL_PSQL="$(command -v psql)"
export PGAPPNAME=${application}
"$REAL_PSQL" "$@"
`;
}

/**
 * The steps the proof has to show.
 *
 * A step that did not run is a failure: a proof that skipped a case must
 * never be green.
 */
export const REQUIRED_STEPS = [
  'the-target-of-the-proof-is-accepted',
  'the-target-addresses-the-published-port',
  'the-old-bundle-is-created',
  'the-newer-bundle-is-created',
  'the-live-only-removals-are-seeded',
  'the-import-is-killed-during-the-transaction',
  'the-import-destroyed-the-removal-ledger-inside-the-transaction',
  'the-import-is-rolled-back',
  'the-marker-names-the-restore-while-it-is-alive',
  'the-marker-names-the-restore-that-crashed',
  'the-marker-names-the-same-restore-after-the-crash',
  'the-evidence-of-the-restore-names-its-own-restore',
  'the-recovery-refuses-the-unsanitized-fixture',
  'the-take-over-replays-the-owed-ledger-of-the-rolled-back-restore',
  'the-import-is-killed-after-the-commit',
  'the-import-was-committed',
  'the-live-only-ledger-is-lost-from-the-database',
  'the-durable-evidence-of-the-owed-ledger-exists',
  'the-gate-stays-closed-after-the-kill',
  'the-recovery-refuses-the-lost-ledger',
  'the-repeated-recovery-refuses',
  'the-take-over-replays-the-owed-ledger',
  'the-service-admits-after-the-replay',
  'the-evidence-of-the-owed-ledger-is-written-before-the-import',
  'the-restore-of-the-copied-evidence-is-killed-after-the-commit',
  'the-record-of-the-owed-ledger-is-copied-to-a-protected-place',
  'the-evidence-directory-of-the-run-is-lost',
  'the-recovery-refuses-the-lost-ledger-with-the-copied-record',
  'the-obligation-of-the-next-import-is-retained',
  'the-take-over-applies-the-owed-ledger-of-the-copied-evidence',
  'the-crash-after-the-replay-is-staged',
  'the-record-of-the-replayed-ledger-is-copied-to-a-protected-place',
  'the-recovery-succeeds-with-the-copied-record-alone',
  'the-recovery-closed-the-fence-of-the-recovered-restore',
  'the-service-admits-after-the-recovery-from-the-copy',
  'the-removed-data-is-still-erased-after-the-recovery',
  'the-next-import-without-a-sink-is-refused',
  'the-refused-import-did-not-touch-the-database',
  'the-refused-take-over-keeps-the-crashed-restore',
  'the-unrelated-control-survives-the-lost-evidence',
  'the-private-payload-is-in-the-bundle-and-in-the-restored-database',
  'the-private-payload-of-the-removed-subject-is-gone',
  'the-tombstone-of-the-removed-private-game-is-retained',
  'the-unrelated-private-payload-survives',
  'the-session-of-the-removed-subject-is-fenced',
  'the-removed-data-does-not-come-back',
  'the-control-survives',
];

/**
 * Completes the report of the proof.
 * @param {{id: string, passed: boolean, detail: string}[]} steps
 * @param {string[]} logs
 * @param {string[]} limits
 * @returns {{steps: {id: string, passed: boolean, detail: string}[], logs: string[], limits: string[]}}
 */
export function completeReport(steps, logs, limits) {
  for (const required of REQUIRED_STEPS) {
    if (!steps.some((step) => step.id === required)) {
      steps.push({ id: `the-step-${required}-ran`, passed: false, detail: 'the step did not run, so the proof is not complete' });
    }
  }
  return { steps, logs, limits };
}

/**
 * Hides the secret of the target in the report of the proof.
 * @param {{id: string, passed: boolean, detail: string}[]} steps
 * @param {string[]} logs
 * @param {URL} [url]
 * @returns {{steps: {id: string, passed: boolean, detail: string}[], logs: string[]}}
 */
export function redactReport(steps, logs, url) {
  if (!url || !url.password) return { steps, logs };
  for (const step of steps) step.detail = redact(step.detail, url);
  for (let index = 0; index < logs.length; index += 1) logs[index] = redact(logs[index], url);
  return { steps, logs };
}

/**
 * The url of a database of the run, as a container of the deployment sees it.
 * @param {URL|string} targetUrl
 * @param {string} database
 * @returns {string}
 */
export function insideDatabaseUrl(targetUrl, database) {
  const url = new URL(String(targetUrl));
  url.pathname = `/${database}`;
  return holderDatabaseUrl(url);
}

/**
 * What the proof removes and what it keeps.
 * @param {{keep: boolean, containers: string[], databases: string[], volumes: string[], directory: string, logs: string[], schema?: string, schemaDatabase?: string, url?: URL}} options
 */
export function planCleanup(options) {
  const keep = options.keep === true;
  return {
    keep,
    removeContainers: keep ? [] : [...options.containers],
    removeDatabases: keep ? [] : [...options.databases],
    removeVolumes: keep ? [] : [...options.volumes],
    removeDirectory: !keep,
    manifest: {
      run: RUN,
      containers: [...options.containers],
      databases: [...options.databases],
      volumes: [...options.volumes],
      directory: options.directory,
      schema: options.schema ?? null,
      schemaDatabase: options.schemaDatabase ?? null,
      schemaKept: keep,
      logs: options.logs.map((entry) => redact(entry, options.url)),
    },
  };
}

/**
 * The state of the removal ledger of a database.
 * @param {{container: string}} context
 * @param {string} database
 * @returns {Promise<{matches: string, subjects: string, gates: string}>}
 */
async function removalState(context, database) {
  const query = async (statement) => {
    const result = await run('docker', ['exec', '-i', context.container, 'psql', '-U', 'postgres', '-d', database, '-At', '-c', statement]);
    return (result.stdout || '').trim();
  };
  return {
    matches: await query(`SELECT count(*) FROM online_removal_ledger`),
    subjects: await query(`SELECT count(*) FROM online_removal_subjects`),
    gates: await query(`SELECT count(*) FROM online_restore_gates`),
  };
}

/**
 * The state of the published record of a match.
 * @param {{container: string}} context
 * @param {string} database
 * @param {string} matchId
 */
async function replayState(context, database, matchId) {
  const result = await run('docker', [
    'exec', '-i', context.container, 'psql', '-U', 'postgres', '-d', database, '-At', '-c',
    `SELECT coalesce((revoked_at IS NOT NULL)::text, 'false') || '|' || (replay_json = '{}'::jsonb)::text || '|' || coalesce(revocation_marker_id, '') FROM online_public_replays WHERE match_id = '${matchId}'`,
  ]);
  const line = (result.stdout || '').trim();
  if (!line) return { present: false, revoked: false, emptied: false, marker: '' };
  const [revoked, emptied, marker] = line.split('|');
  return { present: true, revoked: revoked === 'true', emptied: emptied === 'true', marker: marker ?? '' };
}

/**
 * The owner of the seat of a match.
 * @param {{container: string}} context
 * @param {string} database
 * @param {string} matchId
 */
async function seatOwner(context, database, matchId) {
  const result = await run('docker', [
    'exec', '-i', context.container, 'psql', '-U', 'postgres', '-d', database, '-At', '-c',
    `SELECT owner_id FROM online_seats WHERE match_id = '${matchId}'`,
  ]);
  return (result.stdout || '').trim();
}

/**
 * Runs the proof.
 * @param {{keep?: boolean, databaseUrl?: string, container?: string}} [options]
 */
export async function runInterruptionProof(options = {}) {
  /** @type {{id: string, passed: boolean, detail: string}[]} */
  const steps = [];
  /** @type {string[]} */
  const logs = [];
  const databases = [];
  const volumes = [];
  const containers = [];
  /** @type {{container: string, target: {url: URL}}|null} */
  let context = null;
  const sourceDatabase = `kamkmchess_interruption_source_${RUN}`;
  const cases = proofCases(RUN);

  const resolved = resolveTarget({
    container: options.container ?? process.env.ONLINE_FIXTURE_CONTAINER ?? DEFAULT_CONTAINER,
    databaseUrl: options.databaseUrl ?? process.env.ONLINE_FIXTURE_DATABASE_URL ?? DEFAULT_DATABASE_URL,
  });
  if (!resolved.ok) {
    steps.push({ id: 'the-target-of-the-proof-is-accepted', passed: false, detail: resolved.detail });
    return completeReport(steps, logs, ['the target of the proof was refused']);
  }
  context = { container: String(resolved.container), target: resolved };
  steps.push({
    id: 'the-target-of-the-proof-is-accepted',
    passed: true,
    detail: `the proof runs against the ${resolved.database} database of ${context.container}`,
  });

  try {
    const published = await run('docker', ['port', context.container, '5432/tcp']);
    const publishedPort = (published.stdout || '').trim().split('\n')[0]?.split(':').pop() ?? '';
    if (!publishedPort || publishedPort !== resolved.url.port) {
      steps.push({
        id: 'the-target-addresses-the-published-port',
        passed: false,
        detail: 'the target of the proof does not address the published port of the container',
      });
      return completeReport(steps, logs, ['the target of the proof does not address the fixture']);
    }
    steps.push({
      id: 'the-target-addresses-the-published-port',
      passed: true,
      detail: `the target and the container agree on the port ${publishedPort}`,
    });

    await mkdir(DIRECTORY, { recursive: true });
    const created = await run('docker', ['volume', 'create', `--label=kamkmchess.ops.interruption=${RUN}`, VOLUME]);
    if (created.code !== 0) throw new Error(`the volume of the run could not be created: ${created.stderr.trim()}`);
    volumes.push(VOLUME);

    const endpoint = await fixtureEndpoint(context.container);

    // The fence directory belongs to the user of the service, the way the
    // compose entrypoint of the deployment prepares it. Every case has a
    // fence parent of its own below it.
    const prepared = await run('docker', [
      'run', '--rm', '--user', 'root:0', '--network', endpoint.network,
      '--mount', `type=volume,source=${VOLUME},target=/backups`,
      endpoint.image, 'sh', '-c',
      `mkdir -p ${FENCE_ROOT} && chown 65532:65532 /backups ${FENCE_ROOT} && chmod 700 ${FENCE_ROOT}` +
      Object.values(cases).map((entry) => ` && mkdir -p ${entry.fence} && chown 65532:65532 ${entry.fence} && chmod 700 ${entry.fence}`).join('') +
      ` && mkdir -p ${PROTECTED} && chown 65532:65532 ${PROTECTED} && chmod 700 ${PROTECTED}`,
    ]);
    if (prepared.code !== 0) throw new Error(`the shared fence directories could not be prepared: ${prepared.stderr.trim()}`);

    const binary = join(DIRECTORY, 'khabackup');
    const helper = join(DIRECTORY, 'fenceprobe');
    const evidenceHelper = join(DIRECTORY, 'restoreevidence');
    const built = await run('go', ['build', '-trimpath', '-o', binary, './backend/backup/cmd/khabackup'], { env: { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' } });
    if (built.code !== 0) throw new Error('the backup command could not be built');
    const builtHelper = await run('go', ['build', '-trimpath', '-tags', 'fenceprobe', '-o', helper, './tools/fenceprobe'], { env: { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' } });
    if (builtHelper.code !== 0) throw new Error('the fence helper could not be built');
    // The fence helper runs as the restore user and writes its run-owned
    // schema name into this throwaway bind mount.
    await chmod(DIRECTORY, 0o777);
    const builtEvidence = await run('go', ['build', '-trimpath', '-tags', 'restoreevidence', '-o', evidenceHelper, './tools/restoreevidence'], { env: { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' } });
    if (builtEvidence.code !== 0) throw new Error('the evidence helper could not be built');

    // Every case has its own program, its own marker and its own
    // application name.
    for (const [name, entry] of Object.entries(cases)) {
      const program = join(DIRECTORY, `psql-${name}.sh`);
      const plain = join(DIRECTORY, `psql-${name}-none.sh`);
      const inject = join(DIRECTORY, `inject-${name}.sql`);
      await writeFile(program, barrierScript(entry.barrier, {
        application: entry.application,
        marker: entry.marker,
        inject: `/fixtures/inject-${name}.sql`,
      }), 'utf8');
      await chmod(program, 0o755);
      // The loader without a barrier, for the take-over of the case.
      await writeFile(plain, barrierScript('none', { application: entry.plainApplication }), 'utf8');
      await chmod(plain, 0o755);
      if (entry.barrier === 'during') {
        // The marker of the barrier is written by the server, so it lives in
        // the container of the database and not in the volume of the client.
        await writeFile(inject, injectionScript({
          relation: BARRIER_RELATION,
          marker: `/tmp/proof-barrier-${name}-${RUN}.txt`,
        }), 'utf8');
      }
    }

    const sourceUrl = insideDatabaseUrl(context.target.url, sourceDatabase);
    const sql = async (database, statement) => {
      const result = await run('docker', ['exec', '-i', context.container, 'psql', '-U', 'postgres', '-d', database, '-At', '-c', statement]);
      return { code: result.code, text: (result.stdout || '').trim(), error: (result.stderr || '').trim() };
    };
    const createDatabase = async (database) => {
      const result = await run('docker', ['exec', '-i', context.container, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c', `CREATE DATABASE ${database}`]);
      if (result.code !== 0) throw new Error(`the database ${database} could not be created: ${result.stderr.trim()}`);
      databases.push(database);
    };
    const migrate = async (database) => {
      const url = new URL(context.target.url);
      url.pathname = `/${database}`;
      const result = await run('go', ['run', './cmd/migrate'], { env: { DATABASE_URL: url.toString() } });
      if (result.code !== 0) throw new Error(`the migrations could not be applied to ${database}: ${result.stderr.trim()}`);
    };

    await createDatabase(sourceDatabase);
    await migrate(sourceDatabase);
    for (const name of ['during', 'after', 'evidence', 'nosink']) {
      await createDatabase(cases[name].database);
      await migrate(cases[name].database);
    }

    // The source carries the match of the removed subject and the match of
    // the control. The removals are seeded into the live databases
    // afterwards, so no bundle carries them.
    const matchId = 'proof_match_removed';
    const controlId = 'proof_match_control';
    const seed = async (database) => {
      const fen = 'rnbqkbnr/ppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      for (const [id, owner] of [[matchId, 'proof_owner'], [controlId, 'proof_owner_other']]) {
        const match = await sql(database, `INSERT INTO online_matches (match_id, schema_version, variant, starting_fen, position_fen, starting_time_ms, increment_ms, version, control_epoch, input_hash, rules_policy_version, status) VALUES ('${id}', 1, 'orthodox', '${fen}', '${fen}', 60000, 0, 1, 1, decode(repeat('00',32),'hex'), 'online-rules/1', 'active')`);
        if (match.code !== 0) throw new Error(`the match ${id} could not be seeded: ${match.error}`);
        const seat = await sql(database, `INSERT INTO online_seats (match_id, seat, owner_kind, owner_id, public_label, control_kind, model_label, control_epoch) VALUES ('${id}', 'white', 'account', '${owner}', 'Proof', 'human', NULL, 1)`);
        if (seat.code !== 0) throw new Error(`the seat of ${id} could not be seeded: ${seat.error}`);
        const replay = await sql(database, `INSERT INTO online_public_replays (match_id, schema_version, replay_json, result_hash, game_kind, scored) VALUES ('${id}', 2, '{"moves":[]}'::jsonb, decode(repeat('00',32),'hex'), 'friend', true)`);
        if (replay.code !== 0) throw new Error(`the replay of ${id} could not be seeded: ${replay.error}`);
      }
    };
    await seed(sourceDatabase);
    for (const name of ['during', 'after', 'evidence', 'nosink']) await seed(cases[name].database);

    // The private payload of the removed subject and of an unrelated
    // subject. The bundle carries both, the import brings both into the
    // target, and the removal of the subject erases only its own payload.
    const seedPrivatePayload = async (database) => {
      const payload = `'\\x${Buffer.from('{"private":"payload"}', 'utf8').toString('hex')}'::bytea`;
      const chunk = `'\\x${Buffer.from('{"chunk":1}', 'utf8').toString('hex')}'::bytea`;
      const event = `'\\x${Buffer.from('{"event":1}', 'utf8').toString('hex')}'::bytea`;
      const result = `'\\x${Buffer.from('{"result":1}', 'utf8').toString('hex')}'::bytea`;
      const controlBody = `'\\x${Buffer.from('{"control":"payload"}', 'utf8').toString('hex')}'::bytea`;
      for (const [game, owner, body] of [['proof_private_game', 'proof_owner_private', payload], ['proof_control_game', 'proof_owner_control', controlBody]]) {
        const inserted = await sql(database, `INSERT INTO games (game_id, owner_id, revision, ownership_epoch, checkpoint_json) VALUES ('${game}', '${owner}', 1, 1, ${body})`);
        if (inserted.code !== 0) throw new Error(`the private game ${game} could not be seeded: ${inserted.error}`);
      }
      const seededChunk = await sql(database, `INSERT INTO archive_chunks (game_id, sequence, item_id, raw_json, sha256) VALUES ('proof_private_game', 0, 'proof_private_item', ${chunk}, encode(sha256(convert_to('{"chunk":1}','UTF8')), 'hex'))`);
      if (seededChunk.code !== 0) throw new Error(`the private archive chunk could not be seeded: ${seededChunk.error}`);
      const seededEvent = await sql(database, `INSERT INTO archive_events (game_id, sequence, item_id, raw_json) VALUES ('proof_private_game', 0, 'proof_private_event', ${event})`);
      if (seededEvent.code !== 0) throw new Error(`the private archive event could not be seeded: ${seededEvent.error}`);
      const seededOperation = await sql(database, `INSERT INTO operations (owner_id, game_id, operation_id, request_hash, revision, ownership_epoch, accepted_at, result_json) VALUES ('proof_owner_private', 'proof_private_game', 'proof_private_operation', decode(repeat('11',32),'hex'), 1, 1, clock_timestamp(), ${result})`);
      if (seededOperation.code !== 0) throw new Error(`the private operation receipt could not be seeded: ${seededOperation.error}`);
      const controlChunk = await sql(database, `INSERT INTO archive_chunks (game_id, sequence, item_id, raw_json, sha256) VALUES ('proof_control_game', 0, 'proof_control_item', ${chunk}, encode(sha256(convert_to('{"chunk":1}','UTF8')), 'hex'))`);
      const controlOperation = await sql(database, `INSERT INTO operations (owner_id, game_id, operation_id, request_hash, revision, ownership_epoch, accepted_at, result_json) VALUES ('proof_owner_control', 'proof_control_game', 'proof_control_operation', decode(repeat('22',32),'hex'), 1, 1, clock_timestamp(), ${result})`);
      if (controlOperation.code !== 0) throw new Error(`the operation receipt of the control could not be seeded: ${controlOperation.error}`);
      if (controlChunk.code !== 0) throw new Error(`the archive chunk of the control could not be seeded: ${controlChunk.error}`);
      const controlEvent = await sql(database, `INSERT INTO archive_events (game_id, sequence, item_id, raw_json) VALUES ('proof_control_game', 0, 'proof_control_event', ${event})`);
      if (controlEvent.code !== 0) throw new Error(`the archive event of the control could not be seeded: ${controlEvent.error}`);
    };
    await seedPrivatePayload(sourceDatabase);
    for (const name of ['during', 'after', 'evidence', 'nosink']) await seedPrivatePayload(cases[name].database);

    // The live only row of the target is the snapshot of the import: the
    // bundle does not carry it, the import replaces it, and a rollback
    // leaves it where it was.
    async function seedLiveOnly(database) {
      const fen = 'rnbqkbnr/ppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      await sql(database, `INSERT INTO online_matches (match_id, schema_version, variant, starting_fen, position_fen, starting_time_ms, increment_ms, version, control_epoch, input_hash, rules_policy_version, status) VALUES ('proof_match_live_only', 1, 'orthodox', '${fen}', '${fen}', 60000, 0, 1, 1, decode(repeat('00',32),'hex'), 'online-rules/1', 'active')`);
      await sql(database, `INSERT INTO online_seats (match_id, seat, owner_kind, owner_id, public_label, control_kind, model_label, control_epoch) VALUES ('proof_match_live_only', 'white', 'account', 'proof_owner_live_only', 'Proof', 'human', NULL, 1)`);
      await sql(database, `INSERT INTO online_public_replays (match_id, schema_version, replay_json, result_hash, game_kind, scored) VALUES ('proof_match_live_only', 2, '{"moves":[]}'::jsonb, decode(repeat('00',32),'hex'), 'friend', true)`);
    }
    for (const name of ['during', 'after', 'evidence', 'nosink']) await seedLiveOnly(cases[name].database);

    // The two bundles are created before the removals exist, so no bundle and
    // no newer export carries them: they are live only.
    const tool = async (args, env) => run('docker', [
      'run', '--rm', '-i',
      '--network', endpoint.network,
      '--add-host', 'host.docker.internal:host-gateway',
      '--user', API_UID,
      '--mount', `type=volume,source=${VOLUME},target=/backups`,
      '--mount', `type=bind,source=${DIRECTORY},target=/fixtures`,
      ...Object.entries(env ?? {}).map(([name, value]) => ['--env', `${name}=${value}`]).flat(),
      '--entrypoint', '/fixtures/khabackup',
      endpoint.image, ...args,
    ]);

    // The evidence only recovery runs without a bundle and without a
    // passphrase. The command refuses to start when the environment carries
    // a passphrase, so the proof shows that the recovery really did without
    // one.
    const evidenceOnlyTool = async (args, env) => run('docker', [
      'run', '--rm', '-i',
      '--network', endpoint.network,
      '--add-host', 'host.docker.internal:host-gateway',
      '--user', API_UID,
      '--mount', `type=volume,source=${VOLUME},target=/backups`,
      '--mount', `type=bind,source=${DIRECTORY},target=/fixtures`,
      ...Object.entries(env ?? {}).map(([name, value]) => ['--env', `${name}=${value}`]).flat(),
      '--entrypoint', 'sh',
      endpoint.image, '-c',
      'test -z "${KHA_BACKUP_PASSPHRASE:-}" && exec /fixtures/khabackup "$@"',
      'khabackup', ...args,
    ]);

    // The helper of the evidence uses the production reader of the privacy
    // service, so the proof does not restate the validation of a record.
    const evidenceHelperRun = async (args, env) => run('docker', [
      'run', '--rm',
      '--network', endpoint.network,
      '--add-host', 'host.docker.internal:host-gateway',
      '--user', API_UID,
      '--mount', `type=volume,source=${VOLUME},target=/backups`,
      '--mount', `type=bind,source=${DIRECTORY},target=/fixtures`,
      ...Object.entries(env ?? {}).map(([name, value]) => ['--env', `${name}=${value}`]).flat(),
      '--entrypoint', '/fixtures/restoreevidence',
      endpoint.image, ...args,
    ]);

    const oldBundle = `/backups/old-${RUN}.kha`;
    const newerBundle = `/backups/newer-${RUN}.kha`;
    const made = await tool(['create', '--class', 'daily', '--out', oldBundle], { DATABASE_URL: sourceUrl, KHA_BACKUP_PASSPHRASE: PASSPHRASE });
    steps.push({
      id: 'the-old-bundle-is-created',
      passed: made.code === 0,
      detail: made.code === 0 ? 'the old bundle was created with the real tool' : `the bundle could not be created: ${made.stderr.trim()}`,
    });
    if (made.code !== 0) return completeReport(steps, logs, ['the old bundle could not be created']);
    const madeNewer = await tool(['create', '--class', 'daily', '--out', newerBundle], { DATABASE_URL: sourceUrl, KHA_BACKUP_PASSPHRASE: PASSPHRASE });
    steps.push({
      id: 'the-newer-bundle-is-created',
      passed: madeNewer.code === 0,
      detail: madeNewer.code === 0 ? 'the newer bundle carries no removal either' : `the newer bundle could not be created: ${madeNewer.stderr.trim()}`,
    });
    if (madeNewer.code !== 0) return completeReport(steps, logs, ['the newer bundle could not be created']);

    // The live only removals: one match bound removal and one subject
    // removal of a subject that played no match at all.
    //
    // The fixture is deliberate and it is not a removal the service made:
    // the request is marked verified and the ledger carries the removal,
    // but the rows of the database are still unsanitized. The proof shows
    // that the replay of the owed ledger sanitizes them, not that the
    // service created them.
    //
    // The identifiers of the two removals are independent, the way the
    // identifiers of a live database are independent: the request of a
    // subject removal is not derived from the record of the subject. A seed
    // that made them equal would collide on the primary key of the request,
    // which is a property of the seed and not of the ledger.
    const reference = async (database, owner) => (await sql(database, `SELECT encode(sha256(convert_to('kamkm.online.removal.v1:${owner}', 'UTF-8')), 'hex')`)).text;
    const seedRemovals = async (database) => {
      const removed = await reference(database, 'proof_owner');
      const privateSubject = await reference(database, 'proof_owner_private');
      const request = await sql(database, `INSERT INTO online_removal_requests (removal_id, subject_kind, subject_id, scope, status, requested_at, verified_at, live_delete_due_at, recovery_sanitize_due_at) VALUES ('rm_interruption_match_${RUN}', 'account', '${removed}', 'explicit_removal', 'verified', clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 day', clock_timestamp() + interval '30 days')`);
      if (request.code !== 0) throw new Error(`the removal request could not be seeded: ${request.error}`);
      const ledger = await sql(database, `INSERT INTO online_removal_ledger (ledger_id, removal_id, subject_kind, subject_id, match_id, scope, removed_at) VALUES ('rl_interruption_match_${RUN}', 'rm_interruption_match_${RUN}', 'account', '${removed}', '${matchId}', 'explicit_removal', clock_timestamp())`);
      if (ledger.code !== 0) throw new Error(`the removal ledger could not be seeded: ${ledger.error}`);
      const subjectRequest = await sql(database, `INSERT INTO online_removal_requests (removal_id, subject_kind, subject_id, scope, status, requested_at, verified_at, live_delete_due_at, recovery_sanitize_due_at) VALUES ('rm_interruption_subject_${RUN}', 'account', '${privateSubject}', 'explicit_removal', 'verified', clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 day', clock_timestamp() + interval '30 days')`);
      if (subjectRequest.code !== 0) throw new Error(`the subject removal request could not be seeded: ${subjectRequest.error}`);
      const subject = await sql(database, `INSERT INTO online_removal_subjects (subject_id, removal_id, subject_kind, subject_ref, scope, removed_at) VALUES ('rs_interruption_subject_${RUN}', 'rm_interruption_subject_${RUN}', 'account', '${privateSubject}', 'explicit_removal', clock_timestamp())`);
      if (subject.code !== 0) throw new Error(`the subject removal could not be seeded: ${subject.error}`);
      return { removed, privateSubject };
    };
    const references = await seedRemovals(cases.during.database);
    for (const name of ['after', 'evidence', 'nosink']) await seedRemovals(cases[name].database);
    const subjectOnly = await sql(cases.during.database, `SELECT count(*) FROM online_removal_subjects WHERE subject_id = 'rs_interruption_subject_${RUN}'`);
    const inBundle = await sql(sourceDatabase, `SELECT count(*) FROM online_removal_subjects WHERE subject_id = 'rs_interruption_subject_${RUN}'`);
    const live = await removalState(context, cases.during.database);
    steps.push({
      id: 'the-live-only-removals-are-seeded',
      passed: live.matches === '1' && live.subjects === '1' && subjectOnly.text === '1' && inBundle.text === '0',
      detail: `the live database carries ${live.matches} match bound removal and ${live.subjects} subject removal, the subject only record is there (${subjectOnly.text}) and no bundle carries it (${inBundle.text})`,
    });

    // ---- the helpers of the cases ---------------------------------------
    // The restore names itself: the command line of the restore cannot name
    // it, so the identifier of the restore is the one the marker of the
    // lifecycle carries.
    const fenceOwner = async (fence) => {
      const marker = await run('docker', [
        'run', '--rm', '--user', 'root:0', '--network', endpoint.network,
        '--mount', `type=volume,source=${VOLUME},target=/backups`,
        endpoint.image, 'sh', '-c', `cat ${fence}/restore-fence/owner 2>/dev/null`,
      ]);
      try {
        const owner = JSON.parse((marker.stdout || '').trim());
        return {
          restoreId: typeof owner.restoreId === 'string' ? owner.restoreId : '',
          digest: typeof owner.expectedLedgerDigest === 'string' ? owner.expectedLedgerDigest : '',
        };
      } catch {
        return { restoreId: '', digest: '' };
      }
    };
    const fenceMarkerState = async (fence) => {
      const marker = await run('docker', [
        'run', '--rm', '--user', 'root:0', '--network', endpoint.network,
        '--mount', `type=volume,source=${VOLUME},target=/backups`,
        endpoint.image, 'sh', '-c',
        `test -e ${fence}/restore-fence/owner && echo open || echo closed`,
      ]);
      return (marker.stdout || '').trim() || 'unknown';
    };
    // The record of the owed ledger is validated with the production reader
    // of the privacy service. The content of the record is never printed.
    const validateEvidence = async (fence, owner) => {
      if (!restoreIdIsUsable(owner.restoreId) || !/^[0-9a-f]{64}$/i.test(owner.digest)) {
        return { valid: false, reason: 'the marker of the lifecycle names no usable restore' };
      }
      const verified = await evidenceHelperRun([
        'verify',
        '--evidence', `${fence}/restore-requirements/${owner.restoreId}.json`,
        '--restore-id', owner.restoreId,
        '--digest', owner.digest,
      ]);
      let answer;
      try {
        answer = JSON.parse((verified.stdout || '').trim() || '{}');
      } catch {
        answer = { valid: false, reason: 'the answer of the evidence helper could not be read' };
      }
      return { valid: answer.valid === true, reason: answer.reason ?? 'the evidence does not name the restore' };
    };
    const containerLog = async (id) => {
      const collected = await run('docker', ['logs', id]);
      return (collected.stdout + collected.stderr).trim().split('\n').slice(-4).join(' | ');
    };
    const containerRunning = async (id) => {
      const alive = await run('docker', ['inspect', '--format', '{{.State.Running}}', id]);
      return alive.code === 0 && alive.stdout.trim() === 'true';
    };
    // The restore runs in its own container, so it can be killed exactly at
    // the barrier.
    const startRestore = async (database, mode) => {
      const url = insideDatabaseUrl(context.target.url, database);
      const started = await run('docker', [
        'run', '--detach',
        '--network', endpoint.network,
        '--add-host', 'host.docker.internal:host-gateway',
        '--user', API_UID,
        '--mount', `type=volume,source=${VOLUME},target=/backups`,
        '--mount', `type=bind,source=${DIRECTORY},target=/fixtures`,
        '--env', `DATABASE_URL=${url}`,
        '--env', `KHA_BACKUP_PASSPHRASE=${PASSPHRASE}`,
        '--entrypoint', '/fixtures/khabackup',
        endpoint.image, 'restore',
        '--file', oldBundle,
        '--newer-ledger', newerBundle,
        '--fence', cases[mode].fence,
        '--database-url-env', 'DATABASE_URL',
        '--passphrase-env', 'KHA_BACKUP_PASSPHRASE',
        '--psql', `/fixtures/psql-${mode}.sh`,
        '--apply',
      ]);
      if (started.code !== 0 || !started.stdout.trim()) {
        throw new Error(`the restore could not be started: ${(started.stdout + started.stderr).trim()}`);
      }
      const id = started.stdout.trim();
      containers.push(id);
      return id;
    };
    // The marker of the commit of the import of a case. Every case has a
    // marker of its own, so a marker of a previous case can never finish a
    // wait of another case.
    const waitForCommit = async (entry) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const marker = await run('docker', [
          'run', '--rm', '--network', endpoint.network,
          '--mount', `type=volume,source=${VOLUME},target=/backups`,
          endpoint.image, 'sh', '-c', `test -e ${entry.marker} && echo committed || echo waiting`,
        ]);
        if ((marker.stdout || '').trim() === 'committed') return true;
        await sleep(1000);
      }
      return false;
    };
    // The owner of the fence of a case is read while the restore is alive.
    // The binding of the lifecycle writes the digest of the removal ledger
    // and the durable evidence of it. The owner marker alone does not prove
    // that the record was written, so the proof waits for the record itself
    // and opens it with the production reader.
    const waitForBoundLedger = async (fence, container) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const owner = await fenceOwner(fence);
        if (owner.restoreId && owner.digest.length === 64) {
          const record = await validateEvidence(fence, owner);
          if (record.valid) return { owner, record };
        }
        if (!(await containerRunning(container))) return null;
        await sleep(500);
      }
      return null;
    };
    // The barrier of the "during" case: the import transaction is open, the
    // backend of the barrier holds the exclusive lock of the relation of the
    // removal ledger, and the marker of the barrier was written from inside
    // the transaction.
    const waitForDestructiveTransaction = async (entry, oid) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const backend = await sql('postgres', `SELECT pid FROM pg_stat_activity WHERE application_name = '${entry.application}' AND datname = '${entry.database}' AND xact_start IS NOT NULL AND state = 'active' AND query LIKE '%pg_sleep%'`);
        if (backend.code === 0 && backend.text) {
          const pid = backend.text.split('\n')[0].trim();
          const lock = await sql(entry.database, `SELECT count(*) FROM pg_locks WHERE pid = ${Number(pid)} AND relation = ${Number(oid)} AND mode = 'AccessExclusiveLock' AND granted`);
          const marker = await run('docker', ['exec', context.container, 'cat', `/tmp/proof-barrier-${entry.name}-${RUN}.txt`]);
          const markerText = (marker.stdout || '').trim();
          if (lock.text === '1' && markerText.includes(`pid=${pid}`) && markerText.includes('relation_present=false')) {
            return { open: true, pid, marker: markerText };
          }
        }
        await sleep(1000);
      }
      return { open: false, pid: '', marker: '' };
    };

    // ---- the kill during the import transaction -------------------------
    const duringEntry = cases.during;
    const duringOid = (await sql(duringEntry.database, `SELECT oid FROM pg_class WHERE relname = '${BARRIER_RELATION}' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')`)).text;
    const duringContainer = await startRestore(duringEntry.database, 'during');
    const duringBarrier = await waitForDestructiveTransaction({ ...duringEntry, name: 'during' }, duringOid);
    const duringOwnerAtBarrier = await fenceOwner(duringEntry.fence);
    steps.push({
      id: 'the-marker-names-the-restore-while-it-is-alive',
      passed: duringOwnerAtBarrier.restoreId.length > 0 && restoreIdIsUsable(duringOwnerAtBarrier.restoreId),
      detail: duringOwnerAtBarrier.restoreId
        ? `the marker of the lifecycle names the restore ${duringOwnerAtBarrier.restoreId} while the restore is alive at the barrier`
        : 'the marker of the lifecycle names no restore while the restore is alive',
    });
    steps.push({
      id: 'the-import-destroyed-the-removal-ledger-inside-the-transaction',
      passed: duringBarrier.open && duringBarrier.marker.includes('relation_present=false'),
      detail: duringBarrier.open
        ? `the import transaction of the backend ${duringBarrier.pid} holds the exclusive lock of the relation of the removal ledger and the marker of the barrier says the relation is gone inside the transaction: ${duringBarrier.marker}`
        : 'the import transaction did not destroy the relation of the removal ledger before the barrier',
    });
    const killedDuring = await run('docker', ['kill', duringContainer]);
    const duringAlive = await containerRunning(duringContainer);
    steps.push({
      id: 'the-import-is-killed-during-the-transaction',
      passed: duringBarrier.open && killedDuring.code === 0 && !duringAlive,
      detail: duringBarrier.open && killedDuring.code === 0 && !duringAlive
        ? `the import transaction was open with the removal ledger destroyed inside it, the container of the restore was killed (${killedDuring.stdout.trim()}) and the process is gone`
        : `the import transaction was not open when the restore was killed: ${await containerLog(duringContainer)}`,
    });
    await run('docker', ['rm', '--force', duringContainer]);
    containers.splice(containers.indexOf(duringContainer), 1);

    const afterRollback = await removalState(context, duringEntry.database);
    const replayAfterRollback = await replayState(context, duringEntry.database, matchId);
    const liveOnlyAfterRollback = await replayState(context, duringEntry.database, 'proof_match_live_only');
    steps.push({
      id: 'the-import-is-rolled-back',
      passed: afterRollback.matches === '1' && afterRollback.subjects === '1' && replayAfterRollback.present && !replayAfterRollback.revoked && liveOnlyAfterRollback.present,
      detail: `the transaction was rolled back: the live removals are still there (${afterRollback.matches} match bound, ${afterRollback.subjects} subject), the record of the removed match is not revoked, and the live only row of the target survived the import`,
    });

    // ---- the recovery of the rolled back restore ------------------------
    const duringOwner = await fenceOwner(duringEntry.fence);
    steps.push({
      id: 'the-marker-names-the-same-restore-after-the-crash',
      passed: duringOwner.restoreId.length > 0 && duringOwner.restoreId === duringOwnerAtBarrier.restoreId,
      detail: duringOwner.restoreId === duringOwnerAtBarrier.restoreId && duringOwner.restoreId.length > 0
        ? `the marker of the crashed restore still names the restore ${duringOwner.restoreId}`
        : `the marker names ${duringOwner.restoreId || 'nothing'} after the crash, and it named ${duringOwnerAtBarrier.restoreId || 'nothing'} at the barrier`,
    });
    steps.push({
      id: 'the-marker-names-the-restore-that-crashed',
      passed: duringOwner.restoreId.length > 0,
      detail: duringOwner.restoreId
        ? `the marker of the lifecycle names the restore ${duringOwner.restoreId} (the restore names itself, the command line cannot name it)`
        : 'the marker of the lifecycle names no restore',
    });
    const duringEvidence = await validateEvidence(duringEntry.fence, duringOwner);
    steps.push({
      id: 'the-evidence-of-the-restore-names-its-own-restore',
      passed: duringEvidence.valid,
      detail: duringEvidence.valid
        ? `the record of the owed ledger of this restore is the record of this restore, and its digest is the digest the marker names`
        : `the record of the owed ledger does not name its own restore: ${duringEvidence.reason}`,
    });
    const recoveredDuring = await tool([
      'recover',
      '--file', oldBundle,
      '--restore-id', duringOwner.restoreId,
      '--fence', duringEntry.fence,
      '--database-url-env', 'DATABASE_URL',
      '--passphrase-env', 'KHA_BACKUP_PASSPHRASE',
    ], { DATABASE_URL: insideDatabaseUrl(context.target.url, duringEntry.database), KHA_BACKUP_PASSPHRASE: PASSPHRASE });
    const gateDuring = await sql(duringEntry.database, `SELECT count(*) FROM online_restore_gates WHERE serving_allowed = false`);
    steps.push({
      id: 'the-recovery-refuses-the-unsanitized-fixture',
      passed: recoveredDuring.code !== 0
        && /not applied in the database|is not applied/i.test(recoveredDuring.stderr + recoveredDuring.stdout),
      detail: recoveredDuring.code !== 0
        ? `the recovery refused the database whose rows are still unsanitized, and the fence of the lifecycle stays open, so the service stays closed (${gateDuring.text || 'unknown'} blocking gate): ${(recoveredDuring.stderr + recoveredDuring.stdout).trim().split('\n').slice(-1)[0] ?? ''}`
        : 'the recovery closed the fence of a database whose rows are still unsanitized',
    });
    // The take-over of the same restore replays the owed ledger, sanitizes
    // the rows and closes the fence.
    const takeoverDuring = await tool([
      'restore',
      '--file', oldBundle,
      '--newer-ledger', newerBundle,
      '--fence', duringEntry.fence,
      '--restore-id', duringOwner.restoreId,
      '--takeover',
      '--database-url-env', 'DATABASE_URL',
      '--passphrase-env', 'KHA_BACKUP_PASSPHRASE',
      '--psql', '/fixtures/psql-during-none.sh',
      '--apply',
    ], { DATABASE_URL: insideDatabaseUrl(context.target.url, duringEntry.database), KHA_BACKUP_PASSPHRASE: PASSPHRASE });
    const afterTakeoverDuring = await removalState(context, duringEntry.database);
    const sanitizedDuring = await sql(duringEntry.database, `SELECT count(*) FROM games WHERE game_id = 'proof_private_game' AND checkpoint_json = '{}'::bytea`);
    steps.push({
      id: 'the-take-over-replays-the-owed-ledger-of-the-rolled-back-restore',
      passed: takeoverDuring.code === 0 && afterTakeoverDuring.matches === '1' && afterTakeoverDuring.subjects === '1' && sanitizedDuring.text === '1',
      detail: takeoverDuring.code === 0
        ? `the take-over replayed the owed ledger of the rolled back restore (${afterTakeoverDuring.matches} match bound, ${afterTakeoverDuring.subjects} subject) and sanitized the private payload (${sanitizedDuring.text})`
        : `the take-over of the rolled back restore failed: ${takeoverDuring.stderr.trim().split('\n').slice(-1)[0] ?? ''}`,
    });

    // ---- the kill after the commit --------------------------------------
    const afterEntry = cases.after;
    const afterContainer = await startRestore(afterEntry.database, 'after');
    const committed = await waitForCommit(afterEntry);
    const afterOwnerAtBarrier = await fenceOwner(afterEntry.fence);
    const afterEvidenceAtBarrier = await validateEvidence(afterEntry.fence, afterOwnerAtBarrier);
    const killedAfter = await run('docker', ['kill', afterContainer]);
    const afterAlive = await containerRunning(afterContainer);
    steps.push({
      id: 'the-import-is-killed-after-the-commit',
      passed: committed && killedAfter.code === 0 && !afterAlive,
      detail: committed && killedAfter.code === 0 && !afterAlive
        ? `the real psql committed the import, the container of the restore was killed (${killedAfter.stdout.trim()}) before the removal ledger was replayed and the process is gone`
        : `the import did not commit before the restore was killed: ${await containerLog(afterContainer)}`,
    });
    await run('docker', ['rm', '--force', afterContainer]);
    containers.splice(containers.indexOf(afterContainer), 1);

    const afterImport = await removalState(context, afterEntry.database);
    const replayAfterImport = await replayState(context, afterEntry.database, matchId);
    const liveOnlyAfterImport = await replayState(context, afterEntry.database, 'proof_match_live_only');
    const payloadInSource = await sql(sourceDatabase, `SELECT count(*) FROM games WHERE game_id = 'proof_private_game' AND length(checkpoint_json) > 2`);
    const payloadAfterImport = await sql(afterEntry.database, `SELECT count(*) FROM games WHERE game_id = 'proof_private_game' AND length(checkpoint_json) > 2`);
    const archiveAfterImport = await sql(afterEntry.database, `SELECT count(*) FROM archive_chunks WHERE game_id = 'proof_private_game' AND length(raw_json) > 2`);
    const eventAfterImport = await sql(afterEntry.database, `SELECT count(*) FROM archive_events WHERE game_id = 'proof_private_game' AND length(raw_json) > 2`);
    const receiptAfterImport = await sql(afterEntry.database, `SELECT count(*) FROM operations WHERE game_id = 'proof_private_game' AND length(result_json) > 2`);
    steps.push({
      id: 'the-private-payload-is-in-the-bundle-and-in-the-restored-database',
      passed: payloadInSource.text === '1' && payloadAfterImport.text === '1'
        && archiveAfterImport.text === '1' && eventAfterImport.text === '1' && receiptAfterImport.text === '1',
      detail: `the bundle carries the private payload of the removed subject (${payloadInSource.text}) and the import brought it into the target: the checkpoint (${payloadAfterImport.text}), the archive chunk (${archiveAfterImport.text}), the archive event (${eventAfterImport.text}) and the operation receipt (${receiptAfterImport.text})`,
    });
    steps.push({
      id: 'the-import-was-committed',
      passed: replayAfterImport.present && !replayAfterImport.revoked && !liveOnlyAfterImport.present,
      detail: replayAfterImport.present && !liveOnlyAfterImport.present
        ? 'the import committed: the record of the removed match is in the restored database, it is not revoked, and the live only row of the target is gone'
        : 'the import did not replace the row of the target',
    });
    steps.push({
      id: 'the-live-only-ledger-is-lost-from-the-database',
      passed: afterImport.matches === '0' && afterImport.subjects === '0',
      detail: `the import replaced the schema: the live only removals are gone from the database (${afterImport.matches} match bound, ${afterImport.subjects} subject)`,
    });

    // The durable evidence of the owed ledger is next to the marker of the
    // lifecycle, and it is readable by its owner only. The identifier of the
    // restore is the one the marker names.
    const afterOwner = await fenceOwner(afterEntry.fence);
    const evidence = await run('docker', [
      'run', '--rm', '--user', 'root:0', '--network', endpoint.network,
      '--mount', `type=volume,source=${VOLUME},target=/backups`,
      endpoint.image, 'sh', '-c',
      `stat -c '%a %u' ${afterEntry.fence}/restore-requirements 2>&1; ls -l ${afterEntry.fence}/restore-requirements 2>&1 | tail -n 1`,
    ]);
    const evidenceText = (evidence.stdout + evidence.stderr).trim();
    steps.push({
      id: 'the-durable-evidence-of-the-owed-ledger-exists',
      passed: evidence.code === 0 && /\b700 65532\b/.test(evidenceText) && /-rw-------/.test(evidenceText)
        && afterEvidenceAtBarrier.valid && afterOwner.restoreId === afterOwnerAtBarrier.restoreId,
      detail: evidence.code === 0 && /-rw-------/.test(evidenceText)
        ? `the evidence of the owed ledger is there and private, and it is the record of the restore of this case: ${evidenceText.split('\n').join(' | ')}`
        : `the evidence of the owed ledger is missing or not private: ${evidenceText.split('\n').join(' | ')}`,
    });

    // ---- the gate stays closed ------------------------------------------
    const gate = await startGate(context, endpoint, afterEntry, containers);
    const refused = await waitForGate(gate.port);
    steps.push({
      id: 'the-gate-stays-closed-after-the-kill',
      passed: refused !== null && refused.status === 503,
      detail: refused !== null ? `the gate answered ${refused.status} while the fence of the killed restore is open` : 'the gate did not answer',
    });
    await run('docker', ['rm', '--force', gate.id]);
    containers.splice(containers.indexOf(gate.id), 1);

    // ---- the recovery refuses the lost ledger ---------------------------
    const recovered = await tool([
      'recover',
      '--file', oldBundle,
      '--restore-id', afterOwner.restoreId,
      '--fence', afterEntry.fence,
      '--database-url-env', 'DATABASE_URL',
      '--passphrase-env', 'KHA_BACKUP_PASSPHRASE',
    ], { DATABASE_URL: insideDatabaseUrl(context.target.url, afterEntry.database), KHA_BACKUP_PASSPHRASE: PASSPHRASE });
    const stillLost = await removalState(context, afterEntry.database);
    // The refusal is bound by its reason and not by its exit code: a
    // recovery that fails for another reason is not the refusal the proof
    // measures.
    const lostLedgerReason = /not applied in the database|is not applied/i.test(recovered.stderr + recovered.stdout);
    steps.push({
      id: 'the-recovery-refuses-the-lost-ledger',
      passed: recovered.code !== 0 && lostLedgerReason && stillLost.matches === '0' && stillLost.subjects === '0',
      detail: recovered.code !== 0 && lostLedgerReason
        ? `the recovery refused a database that lost the removals: ${recovered.stderr.trim().split('\n').slice(-1)[0] ?? ''}`
        : `the recovery did not refuse the database that lost the removals for the right reason: ${(recovered.stderr + recovered.stdout).trim().split('\n').slice(-1)[0] ?? ''}`,
    });

    // A second recovery has nothing to recover: the fence of the crashed
    // restore is closed.
    const repeated = await tool([
      'recover',
      '--file', oldBundle,
      '--restore-id', afterOwner.restoreId,
      '--fence', afterEntry.fence,
      '--database-url-env', 'DATABASE_URL',
      '--passphrase-env', 'KHA_BACKUP_PASSPHRASE',
    ], { DATABASE_URL: insideDatabaseUrl(context.target.url, afterEntry.database), KHA_BACKUP_PASSPHRASE: PASSPHRASE });
    // The reason of the second refusal is the one of a closed lifecycle.
    const closedReason = /there is no restore fence to recover/i.test(repeated.stderr + repeated.stdout);
    steps.push({
      id: 'the-repeated-recovery-refuses',
      passed: repeated.code !== 0 && closedReason,
      detail: repeated.code !== 0 && closedReason
        ? `a second recovery of the same restore refuses: ${repeated.stderr.trim().split('\n').slice(-1)[0] ?? ''}`
        : `the second recovery was refused for another reason: ${(repeated.stderr + repeated.stdout).trim().split('\n').slice(-1)[0] ?? ''}`,
    });

    // ---- the take-over replays the owed ledger --------------------------
    const takeover = await tool([
      'restore',
      '--file', oldBundle,
      '--newer-ledger', newerBundle,
      '--fence', afterEntry.fence,
      '--restore-id', afterOwner.restoreId,
      '--takeover',
      '--database-url-env', 'DATABASE_URL',
      '--passphrase-env', 'KHA_BACKUP_PASSPHRASE',
      '--psql', '/fixtures/psql-after-none.sh',
      '--apply',
    ], { DATABASE_URL: insideDatabaseUrl(context.target.url, afterEntry.database), KHA_BACKUP_PASSPHRASE: PASSPHRASE });
    const afterTakeover = await removalState(context, afterEntry.database);
    steps.push({
      id: 'the-take-over-replays-the-owed-ledger',
      passed: takeover.code === 0 && afterTakeover.matches === '1' && afterTakeover.subjects === '1',
      detail: takeover.code === 0
        ? `the take-over finished and the owed ledger is applied again (${afterTakeover.matches} match bound, ${afterTakeover.subjects} subject)`
        : `the take-over failed: ${takeover.stderr.trim().split('\n').slice(-2).join(' | ')}`,
    });

    // ---- the service admits again ---------------------------------------
    const gateAfter = await startGate(context, endpoint, afterEntry, containers);
    const served = await waitForGate(gateAfter.port);
    steps.push({
      id: 'the-service-admits-after-the-replay',
      passed: served !== null && served.status === 200,
      detail: served !== null ? `the gate answered ${served.status} after the owed ledger was replayed` : 'the gate did not answer',
    });
    await run('docker', ['rm', '--force', gateAfter.id]);
    containers.splice(containers.indexOf(gateAfter.id), 1);

    // ---- the copied protected evidence ---------------------------------
    // A case of its own: the restore binds the ledger it owes, the import is
    // killed after the commit, the record of the run is copied to a
    // protected place, the evidence directory of the run is lost, and the
    // recovery proves the owed ledger with the copy alone, without the
    // bundle of the restore.
    const evidenceEntry = cases.evidence;
    const evidenceContainer = await startRestore(evidenceEntry.database, 'evidence');
    // The record of the owed ledger is written before the import, so the
    // proof waits for the binding of the lifecycle before it lets the import
    // go on.
    const bound = await waitForBoundLedger(evidenceEntry.fence, evidenceContainer);
    const evidenceOwner = bound?.owner ?? null;
    // The owner marker alone does not prove that the record was written: the
    // marker carries the identifier of the restore before the ledgers are
    // read, and only the binding of the lifecycle writes the digest and the
    // record. The record is therefore opened with the production reader.
    const evidenceRecord = bound?.record ?? { valid: false, reason: 'the marker of the lifecycle names no bound removal ledger' };
    steps.push({
      id: 'the-evidence-of-the-owed-ledger-is-written-before-the-import',
      passed: evidenceOwner !== null && evidenceOwner.restoreId.length > 0
        && evidenceOwner.digest.length === 64 && evidenceRecord.valid,
      detail: evidenceOwner && evidenceOwner.restoreId && evidenceRecord.valid
        ? `the record of the owed ledger of this run is on the disk before the import, and it names the restore ${evidenceOwner.restoreId} and the digest of the marker`
        : `the record of the owed ledger was not written before the import: ${evidenceRecord.reason}`,
    });
    const evidenceCommitted = await waitForCommit(evidenceEntry);
    const evidenceOwnerAfter = await fenceOwner(evidenceEntry.fence);
    const killedEvidence = await run('docker', ['kill', evidenceContainer]);
    const evidenceAlive = await containerRunning(evidenceContainer);
    await run('docker', ['rm', '--force', evidenceContainer]);
    containers.splice(containers.indexOf(evidenceContainer), 1);
    steps.push({
      id: 'the-restore-of-the-copied-evidence-is-killed-after-the-commit',
      passed: evidenceCommitted && killedEvidence.code === 0 && !evidenceAlive
        && evidenceOwnerAfter.restoreId.length > 0 && evidenceOwnerAfter.restoreId === evidenceOwner?.restoreId,
      detail: evidenceCommitted && killedEvidence.code === 0 && !evidenceAlive
        ? `the import of this restore committed (${evidenceCommitted}) and the restore ${evidenceOwnerAfter.restoreId || 'of no name'} was killed before the removals were replayed and the process is gone`
        : `the restore of the copied evidence was not killed after the commit: committed ${evidenceCommitted}, kill ${killedEvidence.code}, alive ${evidenceAlive}`,
    });
    // The record of this run is copied to a protected place: a directory of
    // mode 0700 and a record of mode 0600, both owned by the restore user.
    // The content of the record is never printed.
    const copy = `${PROTECTED}/${evidenceOwnerAfter.restoreId}.json`;
    const copied = await run('docker', [
      'run', '--rm', '--user', '65532:65532', '--network', endpoint.network,
      '--mount', `type=volume,source=${VOLUME},target=/backups`,
      endpoint.image, 'sh', '-c',
      `cp ${evidenceEntry.fence}/restore-requirements/${evidenceOwnerAfter.restoreId}.json ${copy} && chmod 600 ${copy} && stat -c '%a %u' ${copy} && stat -c '%a %u' ${PROTECTED}`,
    ]);
    const copyText = (copied.stdout + copied.stderr).trim();
    steps.push({
      id: 'the-record-of-the-owed-ledger-is-copied-to-a-protected-place',
      passed: copied.code === 0 && /\b600 65532\b/.test(copyText) && /\b700 65532\b/.test(copyText),
      detail: `the record of the owed ledger of this run was copied to a protected place of the run, owned by the restore user: ${copyText}`,
    });
    // The evidence directory of this run is lost. Only the directory of this
    // run is removed, and the path of it is verified before it is removed.
    const lost = await run('docker', [
      'run', '--rm', '--user', '65532:65532', '--network', endpoint.network,
      '--mount', `type=volume,source=${VOLUME},target=/backups`,
      endpoint.image, 'sh', '-c',
      `target=${evidenceEntry.fence}/restore-requirements; resolved=$(readlink -f "$target"); if [ "$resolved" != "${evidenceEntry.fence}/restore-requirements" ]; then echo out-of-scope; exit 1; fi; if [ ! -d "$resolved" ]; then echo missing; exit 1; fi; rm -rf "$resolved" && echo lost`,
    ]);
    steps.push({
      id: 'the-evidence-directory-of-the-run-is-lost',
      passed: lost.code === 0 && (lost.stdout || '').includes('lost'),
      detail: lost.code === 0
        ? 'the evidence directory of this run was removed, and only that directory'
        : `the evidence directory of this run could not be removed: ${(lost.stdout + lost.stderr).trim()}`,
    });
    // The recovery with the copy alone: no bundle of the restore, so the
    // copy of the record is the only description of what the restore owed,
    // and no passphrase, because the bundle is not read at all.
    //
    // The removals of this restore are not applied in the database: the
    // import replaced them. The recovery therefore refuses, and the service
    // stays closed.
    const recoveredWithCopy = await evidenceOnlyTool([
      'recover',
      '--restore-id', evidenceOwnerAfter.restoreId,
      '--evidence', copy,
      '--fence', evidenceEntry.fence,
      '--database-url-env', 'DATABASE_URL',
    ], { DATABASE_URL: insideDatabaseUrl(context.target.url, evidenceEntry.database) });
    const pendingGate = await sql(evidenceEntry.database, `SELECT count(*) FROM online_restore_gates WHERE serving_allowed = false`);
    steps.push({
      id: 'the-recovery-refuses-the-lost-ledger-with-the-copied-record',
      passed: recoveredWithCopy.code !== 0
        && /not applied in the database|is not applied/i.test(recoveredWithCopy.stderr + recoveredWithCopy.stdout),
      detail: recoveredWithCopy.code !== 0
        ? `the recovery took the copied record alone, without a bundle and without a passphrase, and refused the database that lost the removals: ${(recoveredWithCopy.stderr + recoveredWithCopy.stdout).trim().split('\n').slice(-1)[0] ?? ''}`
        : 'the recovery accepted a database that lost the removals',
    });
    // The obligation of the next import is durable: the refused recovery
    // wrote the record again, so a restore that comes next replays the
    // removals the crashed restore owed.
    const retained = await run('docker', [
      'run', '--rm', '--user', 'root:0', '--network', endpoint.network,
      '--mount', `type=volume,source=${VOLUME},target=/backups`,
      endpoint.image, 'sh', '-c',
      `stat -c '%a %u' ${evidenceEntry.fence}/restore-requirements 2>&1; ls ${evidenceEntry.fence}/restore-requirements 2>&1 | head -n 2`,
    ]);
    const retainedText = (retained.stdout + retained.stderr).trim();
    steps.push({
      id: 'the-obligation-of-the-next-import-is-retained',
      passed: /\b700 65532\b/.test(retainedText) && retainedText.includes(`${evidenceOwnerAfter.restoreId}.json`),
      detail: `the obligation of the next import is retained: the record of the owed ledger is on the disk again and private, and the restore gates of the database are ${pendingGate.text}: ${retainedText.split('\n').join(' | ')}`,
    });
    // ---- the take-over applies the owed ledger of this case --------------
    const evidenceTakeover = await tool([
      'restore',
      '--file', oldBundle,
      '--newer-ledger', newerBundle,
      '--fence', evidenceEntry.fence,
      '--takeover',
      '--database-url-env', 'DATABASE_URL',
      '--passphrase-env', 'KHA_BACKUP_PASSPHRASE',
      '--psql', '/fixtures/psql-evidence-none.sh',
      '--apply',
    ], { DATABASE_URL: insideDatabaseUrl(context.target.url, evidenceEntry.database), KHA_BACKUP_PASSPHRASE: PASSPHRASE });
    const evidenceApplied = await removalState(context, evidenceEntry.database);
    const evidenceErased = await sql(evidenceEntry.database, `SELECT count(*) FROM online_seats WHERE match_id = '${matchId}' AND owner_id = 'anonymized'`);
    steps.push({
      id: 'the-take-over-applies-the-owed-ledger-of-the-copied-evidence',
      passed: evidenceTakeover.code === 0 && evidenceApplied.matches === '1' && evidenceApplied.subjects === '1' && evidenceErased.text === '1',
      detail: evidenceTakeover.code === 0
        ? `the take-over replayed the owed ledger of the copied evidence (${evidenceApplied.matches} match bound, ${evidenceApplied.subjects} subject) and the seat of the removed match is anonymized (${evidenceErased.text})`
        : `the take-over of the copied evidence failed: ${evidenceTakeover.stderr.trim().split('\n').slice(-1)[0] ?? ''}`,
    });
    // ---- the crash after the replay --------------------------------------
    // The boundary of a restore that replayed its removal ledger and died
    // before it closed the fence is staged with the production code of the
    // privacy service: the lifecycle is opened, the removal ledger the
    // database really holds is bound to it, the durable evidence of it is
    // written, and the helper ends without closing the fence. The recovery
    // that follows is the real binary.
    const stagedRestoreID = `restore-staged-${RUN}`;
    const staged = await evidenceHelperRun([
      'stage',
      '--fence', evidenceEntry.fence,
      '--database-url-env', 'DATABASE_URL',
      '--restore-id', stagedRestoreID,
    ], { DATABASE_URL: insideDatabaseUrl(context.target.url, evidenceEntry.database) });
    let stagedAnswer = {};
    try {
      stagedAnswer = JSON.parse((staged.stdout || '').trim() || '{}');
    } catch {
      stagedAnswer = {};
    }
    const stagedFence = await fenceOwner(evidenceEntry.fence);
    steps.push({
      id: 'the-crash-after-the-replay-is-staged',
      passed: staged.code === 0 && stagedAnswer.staged === true
        && stagedFence.restoreId === stagedRestoreID && stagedFence.digest.length === 64
        && stagedAnswer.digest === stagedFence.digest,
      detail: staged.code === 0 && stagedAnswer.staged === true
        ? `the lifecycle of the restore ${stagedRestoreID} is open and bound to the removal ledger the database really holds (${stagedAnswer.matches} match bound, ${stagedAnswer.subjects} subject); the replay is applied and the close of the restore never ran`
        : `the crash after the replay could not be staged: ${(staged.stdout + staged.stderr).trim()}`,
    });
    // The record of the staged restore is copied to the protected place of
    // the run and validated with the production reader.
    const stagedCopy = `${PROTECTED}/${stagedRestoreID}.json`;
    const stagedCopied = await run('docker', [
      'run', '--rm', '--user', '65532:65532', '--network', endpoint.network,
      '--mount', `type=volume,source=${VOLUME},target=/backups`,
      endpoint.image, 'sh', '-c',
      `cp ${evidenceEntry.fence}/restore-requirements/${stagedRestoreID}.json ${stagedCopy} && chmod 600 ${stagedCopy} && stat -c '%a %u' ${stagedCopy}`,
    ]);
    const stagedCopyText = (stagedCopied.stdout + stagedCopied.stderr).trim();
    const stagedValidated = await validateEvidence(evidenceEntry.fence, stagedFence);
    steps.push({
      id: 'the-record-of-the-replayed-ledger-is-copied-to-a-protected-place',
      passed: stagedCopied.code === 0 && /\b600 65532\b/.test(stagedCopyText) && stagedValidated.valid,
      detail: `the record of the replayed ledger was copied to the protected place of the run and it names its own restore: ${stagedCopyText}`,
    });
    // The evidence directory is lost again, and only that directory.
    const lostAgain = await run('docker', [
      'run', '--rm', '--user', '65532:65532', '--network', endpoint.network,
      '--mount', `type=volume,source=${VOLUME},target=/backups`,
      endpoint.image, 'sh', '-c',
      `target=${evidenceEntry.fence}/restore-requirements; resolved=$(readlink -f "$target"); if [ "$resolved" != "${evidenceEntry.fence}/restore-requirements" ]; then echo out-of-scope; exit 1; fi; if [ ! -d "$resolved" ]; then echo missing; exit 1; fi; rm -rf "$resolved" && echo lost`,
    ]);
    if (lostAgain.code !== 0 || !(lostAgain.stdout || '').includes('lost')) {
      throw new Error(`the evidence directory of the copied case could not be removed: ${(lostAgain.stdout + lostAgain.stderr).trim()}`);
    }
    // The recovery with the copy alone succeeds: the removals are applied
    // and erased, so the recovery releases the gate and closes the fence.
    const succeeded = await evidenceOnlyTool([
      'recover',
      '--restore-id', stagedRestoreID,
      '--evidence', stagedCopy,
      '--fence', evidenceEntry.fence,
      '--database-url-env', 'DATABASE_URL',
    ], { DATABASE_URL: insideDatabaseUrl(context.target.url, evidenceEntry.database) });
    steps.push({
      id: 'the-recovery-succeeds-with-the-copied-record-alone',
      passed: succeeded.code === 0 && /recovered the restore/i.test(succeeded.stdout + succeeded.stderr),
      detail: succeeded.code === 0
        ? `the recovery took the copied record alone, without a bundle and without a passphrase, and recovered the restore: ${(succeeded.stdout + succeeded.stderr).trim().split('\n').slice(-1)[0] ?? ''}`
        : `the recovery of the copied record failed: ${(succeeded.stdout + succeeded.stderr).trim().split('\n').slice(-1)[0] ?? ''}`,
    });
    const fenceAfterRecovery = await fenceMarkerState(evidenceEntry.fence);
    steps.push({
      id: 'the-recovery-closed-the-fence-of-the-recovered-restore',
      passed: fenceAfterRecovery === 'closed',
      detail: `the fence of the recovered restore is ${fenceAfterRecovery}`,
    });
    const gateAfterRecovery = await startGate(context, endpoint, evidenceEntry, containers);
    const servedAfterRecovery = await waitForGate(gateAfterRecovery.port);
    steps.push({
      id: 'the-service-admits-after-the-recovery-from-the-copy',
      passed: servedAfterRecovery !== null && servedAfterRecovery.status === 200,
      detail: servedAfterRecovery !== null
        ? `the gate answered ${servedAfterRecovery.status} after the recovery of the copied record`
        : 'the gate did not answer',
    });
    await run('docker', ['rm', '--force', gateAfterRecovery.id]);
    containers.splice(containers.indexOf(gateAfterRecovery.id), 1);
    const erasedAfterRecovery = await sql(evidenceEntry.database, `SELECT count(*) FROM online_seats WHERE match_id = '${matchId}' AND owner_id = 'anonymized'`);
    const erasedReplay = await replayState(context, evidenceEntry.database, matchId);
    const emptiedAfterRecovery = await sql(evidenceEntry.database, `SELECT count(*) FROM games WHERE game_id = 'proof_private_game' AND checkpoint_json = '{}'::bytea`);
    steps.push({
      id: 'the-removed-data-is-still-erased-after-the-recovery',
      passed: erasedAfterRecovery.text === '1' && erasedReplay.revoked && erasedReplay.emptied && emptiedAfterRecovery.text === '1',
      detail: `the seat of the removed match is still anonymized (${erasedAfterRecovery.text}), its replay is still revoked (${erasedReplay.revoked}) and the private payload is still erased (${emptiedAfterRecovery.text})`,
    });
    const controlAfterCopy = await sql(evidenceEntry.database, `SELECT count(*) FROM games WHERE game_id = 'proof_control_game' AND length(checkpoint_json) > 2`);
    steps.push({
      id: 'the-unrelated-control-survives-the-lost-evidence',
      passed: controlAfterCopy.text === '1',
      detail: `the private payload of the unrelated subject survived the loss of the evidence (${controlAfterCopy.text})`,
    });

    // ---- the next import without a removal ledger sink ------------------
    // The refusal is measured with the real library, against a real
    // database and a real encrypted bundle, with a counter on the importer.
    const noSinkEntry = cases.nosink;
    const owedBefore = await removalState(context, noSinkEntry.database);
    const seatBefore = await seatOwner(context, noSinkEntry.database, matchId);
    const replayBefore = await replayState(context, noSinkEntry.database, matchId);
    // The obligation of the next import is real: the lifecycle of a restore
    // that crashed is staged with the production code, so the evidence
    // directory holds a record of a restore that owes removals.
    const noSinkRestoreID = `restore-nosink-${RUN}`;
    const stagedNoSink = await evidenceHelperRun([
      'stage',
      '--fence', noSinkEntry.fence,
      '--database-url-env', 'DATABASE_URL',
      '--restore-id', noSinkRestoreID,
    ], { DATABASE_URL: insideDatabaseUrl(context.target.url, noSinkEntry.database) });
    const noSink = await run('docker', [
      'run', '--rm',
      '--network', endpoint.network,
      '--add-host', 'host.docker.internal:host-gateway',
      '--user', API_UID,
      '--mount', `type=volume,source=${VOLUME},target=/backups`,
      '--mount', `type=bind,source=${DIRECTORY},target=/fixtures`,
      '--env', `DATABASE_URL=${insideDatabaseUrl(context.target.url, noSinkEntry.database)}`,
      '--env', `KHA_BACKUP_PASSPHRASE=${PASSPHRASE}`,
      '--entrypoint', '/fixtures/restoreevidence',
      endpoint.image, 'nosink',
      '--fence', noSinkEntry.fence,
      '--database-url-env', 'DATABASE_URL',
      '--passphrase-env', 'KHA_BACKUP_PASSPHRASE',
      '--restore-id', `restore-nosink-attempt-${RUN}`,
      '--file', oldBundle,
      '--takeover',
    ]);
    let noSinkAnswer = {};
    try {
      noSinkAnswer = JSON.parse((noSink.stdout || '').trim() || '{}');
    } catch {
      noSinkAnswer = {};
    }
    steps.push({
      id: 'the-next-import-without-a-sink-is-refused',
      passed: stagedNoSink.code === 0 && noSink.code === 0 && noSinkAnswer.refused === true
        && noSinkAnswer.ledgerConflict === true && noSinkAnswer.imports === 0
        && /removals are owed/i.test(noSinkAnswer.error ?? ''),
      detail: noSinkAnswer.refused === true
        ? `a restore without the removal ledger sink is refused with the conflict of the owed removals and imported ${noSinkAnswer.imports} times: ${noSinkAnswer.error ?? ''}`
        : `a restore without the removal ledger sink was not refused: ${(noSink.stdout + noSink.stderr).trim()}`,
    });
    const owedAfter = await removalState(context, noSinkEntry.database);
    const seatAfter = await seatOwner(context, noSinkEntry.database, matchId);
    const replayAfter = await replayState(context, noSinkEntry.database, matchId);
    steps.push({
      id: 'the-refused-import-did-not-touch-the-database',
      passed: owedAfter.matches === owedBefore.matches && owedAfter.subjects === owedBefore.subjects
        && seatAfter === seatBefore && replayAfter.present === replayBefore.present && replayAfter.revoked === replayBefore.revoked,
      detail: `the refused import changed nothing: the removal ledger of the database is still ${owedAfter.matches} match bound and ${owedAfter.subjects} subject, the seat of the removed match is owned by ${seatAfter || 'nobody'} and the replay is ${replayAfter.revoked ? 'revoked' : 'published'}`,
    });
    // The refused take-over gave the lifecycle back and put the marker of
    // the crashed restore back, so the crashed restore is still recoverable.
    const noSinkFence = await fenceOwner(noSinkEntry.fence);
    steps.push({
      id: 'the-refused-take-over-keeps-the-crashed-restore',
      passed: noSinkFence.restoreId === noSinkRestoreID,
      detail: noSinkFence.restoreId === noSinkRestoreID
        ? `the refused take-over put the marker of the crashed restore back: the fence still names the restore ${noSinkFence.restoreId}`
        : `the refused take-over left the fence naming ${noSinkFence.restoreId || 'nothing'} instead of the crashed restore ${noSinkRestoreID}`,
    });

    // ---- the private payload of the removed subject ---------------------
    const emptied = await sql(afterEntry.database, `SELECT count(*) FROM games WHERE game_id = 'proof_private_game' AND checkpoint_json = '{}'::bytea AND deleted_at IS NOT NULL`);
    const chunks = await sql(afterEntry.database, `SELECT count(*) FROM archive_chunks WHERE game_id = 'proof_private_game'`);
    const events = await sql(afterEntry.database, `SELECT count(*) FROM archive_events WHERE game_id = 'proof_private_game'`);
    const operation = await sql(afterEntry.database, `SELECT count(*) FROM operations WHERE game_id = 'proof_private_game' AND result_json = '{}'::bytea`);
    const tombstone = await sql(afterEntry.database, `SELECT count(*) FROM deletion_tombstones WHERE game_id = 'proof_private_game'`);
    const controlPayload = await sql(afterEntry.database, `SELECT count(*) FROM games WHERE game_id = 'proof_control_game' AND checkpoint_json = '\\x7b22636f6e74726f6c223a227061796c6f6164227d'::bytea`);
    const controlChunks = await sql(afterEntry.database, `SELECT count(*) FROM archive_chunks WHERE game_id = 'proof_control_game' AND length(raw_json) > 2`);
    const controlEvents = await sql(afterEntry.database, `SELECT count(*) FROM archive_events WHERE game_id = 'proof_control_game' AND length(raw_json) > 2`);
    const controlReceipts = await sql(afterEntry.database, `SELECT count(*) FROM operations WHERE game_id = 'proof_control_game' AND length(result_json) > 2`);
    const tombstonePayload = await sql(afterEntry.database, `SELECT count(*) FROM deletion_tombstones t JOIN games g ON g.game_id = t.game_id WHERE t.game_id = 'proof_private_game' AND length(g.checkpoint_json) > 2`);
    const session = await sql(afterEntry.database, `SELECT count(*) FROM online_session_revocations WHERE subject_id = 'proof_owner_private'`);
    const sessionCount = session.code === 0 ? Number(session.text) : -1;
    steps.push({
      id: 'the-private-payload-of-the-removed-subject-is-gone',
      passed: emptied.text === '1' && chunks.text === '0' && events.text === '0' && operation.text === '1',
      detail: `the checkpoint of the removed subject is empty (${emptied.text}), its archive chunk (${chunks.text}) and its archive event (${events.text}) are gone and its operation receipt is emptied (${operation.text})`,
    });
    steps.push({
      id: 'the-tombstone-of-the-removed-private-game-is-retained',
      passed: tombstone.text === '1' && tombstonePayload.text === '0',
      detail: `the payload free tombstone of the removed game is retained (${tombstone.text}) and carries no private payload (${tombstonePayload.text} payload rows)`,
    });
    steps.push({
      id: 'the-unrelated-private-payload-survives',
      passed: controlPayload.text === '1' && controlChunks.text === '1' && controlEvents.text === '1' && controlReceipts.text === '1',
      detail: `the private payload of the unrelated subject survived byte for byte (${controlPayload.text} game, ${controlChunks.text} archive chunk, ${controlEvents.text} archive event, ${controlReceipts.text} operation receipt)`,
    });
    steps.push({
      id: 'the-session-of-the-removed-subject-is-fenced',
      passed: sessionCount > 0,
      detail: `the sessions of the removed subject are fenced (${sessionCount} revocation)`,
    });

    // ---- the removed data and the control -------------------------------
    const revoked = await replayState(context, afterEntry.database, matchId);
    const seat = await seatOwner(context, afterEntry.database, matchId);
    const control = await replayState(context, afterEntry.database, controlId);
    const controlSeat = await seatOwner(context, afterEntry.database, controlId);
    steps.push({
      id: 'the-removed-data-does-not-come-back',
      passed: revoked.present && revoked.revoked && revoked.emptied && revoked.marker !== '' && seat === 'anonymized',
      detail: `the record of the removed match is revoked (${revoked.revoked}), emptied (${revoked.emptied}) with the marker ${revoked.marker || 'none'} and its seat is owned by ${seat || 'nobody'}`,
    });
    steps.push({
      id: 'the-control-survives',
      passed: control.present && !control.revoked && controlSeat === 'proof_owner_other',
      detail: `the match of the subject that was not removed is published (${control.present && !control.revoked}) and its seat is owned by ${controlSeat || 'nobody'}`,
    });

    logs.push(`the removed subject reference: ${references.removed}`);
    logs.push(`the subject without a match: ${references.privateSubject}`);

    return completeReport(steps, logs, [
      'The kill is real: the restore of the real binary is killed by the container runtime while the real psql holds the import.',
      'The proof runs against the local fixture container, not against the deployment host.',
      'The crash after the replay is staged with the production code of the privacy service: the lifecycle is opened, the removal ledger the database really holds is bound to it and the helper ends without closing it. The recovery that follows is the real binary of the command.',
      'The container proofs are reproduced by the workflow container-proofs on a Linux engine; this report was measured on the local engine of the developer.',
    ]);
  } catch (error) {
    steps.push({
      id: 'the-proof-failed',
      passed: false,
      detail: `the proof stopped: ${error instanceof Error ? error.message : String(error)}`,
    });
    return completeReport(steps, logs, ['the proof stopped with an error']);
  } finally {
    const plan = planCleanup({
      keep: options.keep === true,
      containers,
      databases,
      volumes,
      directory: DIRECTORY,
      logs,
      url: context?.target?.url,
    });
    redactReport(steps, logs, context?.target?.url);
    if (plan.keep && (plan.manifest.volumes.length > 0 || plan.manifest.databases.length > 0)) {
      try {
        await mkdir(DIRECTORY, { recursive: true });
        await writeFile(join(DIRECTORY, 'manifest.json'), `${JSON.stringify(plan.manifest, null, 2)}\n`, 'utf8');
      } catch (error) {
        steps.push({ id: 'the-manifest-of-the-run-is-written', passed: false, detail: `the manifest could not be written: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    for (const id of plan.removeContainers) {
      const removed = await run('docker', ['rm', '--force', id]);
      if (removed.code !== 0 && !/no such container|is not running/i.test(removed.stderr)) {
        steps.push({ id: 'the-containers-are-removed', passed: false, detail: `the container ${id} could not be removed: ${removed.stderr.trim()}` });
      }
    }
    for (const database of plan.removeDatabases) {
      const dropped = await run('docker', ['exec', '-i', context.container, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c', `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`]);
      if (dropped.code !== 0) {
        steps.push({ id: 'the-databases-are-removed', passed: false, detail: `the database ${database} could not be dropped: ${dropped.stderr.trim()}` });
      }
    }
    for (const volume of plan.removeVolumes) {
      const removed = await run('docker', ['volume', 'rm', '--force', volume]);
      if (removed.code !== 0) {
        steps.push({ id: 'the-volume-is-removed', passed: false, detail: `the volume could not be removed: ${removed.stderr.trim()}` });
      }
    }
    if (plan.removeDirectory) {
      try {
        await rm(DIRECTORY, { recursive: true, force: true });
      } catch (error) {
        steps.push({ id: 'the-directory-of-the-run-is-removed', passed: false, detail: `the directory could not be removed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    redactReport(steps, logs, context?.target?.url);
  }
}

/**
 * The image, the network and the address of the fixture database.
 * @param {string} container
 * @returns {Promise<{image: string, network: string, host: string}>}
 */
async function fixtureEndpoint(container) {
  const inspected = await run('docker', ['inspect', '--format', '{{.Config.Image}}', container]);
  const image = inspected.stdout.trim();
  if (!image) throw new Error('the image of the fixture database could not be read');
  const networks = await run('docker', ['inspect', '--format', '{{json .NetworkSettings.Networks}}', container]);
  /** @type {Record<string, {IPAddress?: string}>} */
  let parsed;
  try {
    parsed = JSON.parse(networks.stdout.trim() || '{}');
  } catch {
    throw new Error('the networks of the fixture database could not be read');
  }
  const network = Object.keys(parsed)[0];
  const host = parsed[network]?.IPAddress;
  if (!network || !host) throw new Error('the fixture database has no address');
  return { image, network, host };
}

/**
 * Starts the service that observes the fence.
 * @param {{container: string, target: {url: URL}}} context
 * @param {{image: string, network: string, host: string}} endpoint
 * @param {{fence: string, database: string}} entry
 * @param {string[]} tracked
 * @returns {Promise<{id: string, port: string}>}
 */
async function startGate(context, endpoint, entry, tracked) {
  const url = insideDatabaseUrl(context.target.url, entry.database);
  const started = await run('docker', [
    'run', '--detach',
    '--network', endpoint.network,
    '--add-host', 'host.docker.internal:host-gateway',
    '--user', API_UID,
    '--mount', `type=volume,source=${VOLUME},target=/backups`,
    '--mount', `type=bind,source=${DIRECTORY},target=/fixtures`,
    '--publish', '127.0.0.1::8099',
    '--entrypoint', '/fixtures/fenceprobe',
    endpoint.image, 'watch', entry.fence, url, '8099', `restore-gate-${RUN}`,
  ]);
  if (started.code !== 0 || !started.stdout.trim()) {
    throw new Error(`the service that observes the fence could not be started: ${(started.stdout + started.stderr).trim()}`);
  }
  const id = started.stdout.trim();
  // The container is tracked before anything else can fail, so a throw never
  // leaves it behind.
  tracked.push(id);
  let port = '';
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const inspected = await run('docker', ['port', id, '8099/tcp']);
    port = (inspected.stdout || '').trim().split('\n')[0]?.split(':').pop() ?? '';
    if (port) break;
    const alive = await run('docker', ['inspect', '--format', '{{.State.Running}}', id]);
    if (alive.code !== 0 || alive.stdout.trim() !== 'true') break;
    await sleep(1000);
  }
  if (!port) {
    const logs = await run('docker', ['logs', id]);
    throw new Error(`the service that observes the fence published no port: ${(logs.stdout + logs.stderr).trim()}`);
  }
  return { id, port };
}

/**
 * Waits for the gate to answer.
 *
 * The service needs a moment to listen, and the answer of the gate is the
 * one the proof measures: 503 while the fence is held, 200 after it closed.
 * @param {string} port
 * @returns {Promise<{status: number}|null>}
 */
async function waitForGate(port) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const answer = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null);
    if (answer !== null) return answer;
    await sleep(500);
  }
  return null;
}

/**
 * The exit code of the proof.
 * @param {{passed: boolean}[]} steps
 * @returns {number}
 */
export function proofExitCode(steps) {
  return steps.some((step) => !step.passed) ? 1 : 0;
}

async function main() {
  const report = await runInterruptionProof({ keep: process.argv.includes('--keep') });
  process.exitCode = proofExitCode(report.steps);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ tool: 'scripts/online/restore-interruption-proof.mjs', ...report }, null, 2)}\n`);
    return;
  }
  for (const step of report.steps) {
    process.stdout.write(`  ${step.passed ? 'PASS' : 'FAIL'} ${step.id}: ${step.detail}\n`);
  }
  for (const entry of report.logs ?? []) {
    process.stdout.write(`  log: ${entry}\n`);
  }
  for (const limit of report.limits ?? []) {
    process.stdout.write(`  ! ${limit}\n`);
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/online/restore-interruption-proof.mjs')) {
  await main();
}
