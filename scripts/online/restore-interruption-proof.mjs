// The native restore interruption proof.
//
// The native proof of the restore shows the lifecycle of a restore that
// finishes. This proof shows the two interruptions that decide whether a
// removed subject can come back:
//
//   - the restore is killed while the import transaction is open: the
//     transaction is rolled back, so the live removals are still in the
//     database and the recovery closes the fence;
//   - the restore is killed after the import committed and before the
//     removal ledger was replayed: the import replaced the schema, so the
//     removals that only the live database carried are gone, the recovery
//     refuses and keeps the gate closed, and the take-over replays the
//     exact ledger the restore owed from the durable evidence next to the
//     marker of the lifecycle.
//
// The kill is real and deterministic. The restore runs the real binary of the
// repository against a real encrypted bundle, and the loader is the real
// psql: the proof only puts a barrier in front of it.
//
//   during  the barrier holds the import transaction open with a marker
//           statement, so the kill lands while the transaction is active;
//   after   the barrier waits after the real psql committed, so the kill
//           lands between the commit of the import and the replay of the
//           removals;
//   none    the real psql runs without a barrier, for the take-over.
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
const FENCE = `/backups/fence-${RUN}`;
const API_UID = '65532:65532';

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
 * The barrier of the native import.
 *
 * The real psql runs the real dump. The barrier only decides when the
 * restore is killed.
 * @param {string} mode during, after or none
 * @returns {string}
 */
export function barrierScript(mode, options = {}) {
  const application = options.application ?? `kamkm_proof_barrier_${mode}`;
  const marker = options.marker ?? `/backups/barrier-${mode}`;
  if (mode === 'during') {
    return `#!/bin/sh
# The barrier of the native import, in the mode that holds the import
# transaction open.
#
# The real psql runs the real dump. The marker statement is a statement
# inside the import transaction, so the backend waits inside the transaction
# and the kill lands while the transaction is active.
#
# The mode is written into this program: the environment of the loader is an
# explicit allowlist of the production code and never carries a switch of
# the proof.
set -e
REAL_PSQL="$(command -v psql)"
export PGAPPNAME=${application}
awk 'BEGIN { done = 0 } { print; if (!done && index($0, ";") > 0) { print "SELECT pg_sleep(600);"; done = 1 } }' \\
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
# explicit allowlist of the production code and never carries a switch of
# the proof.
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
  'the-import-is-rolled-back',
  'the-marker-names-the-restore-while-it-is-alive',
  'the-marker-names-the-restore-that-crashed',
  'the-marker-names-the-same-restore-after-the-crash',
  'the-recovery-closes-the-fence-of-the-rolled-back-restore',
  'the-import-is-killed-after-the-commit',
  'the-import-was-committed',
  'the-live-only-ledger-is-lost-from-the-database',
  'the-durable-evidence-of-the-owed-ledger-exists',
  'the-gate-stays-closed-after-the-kill',
  'the-recovery-refuses-the-lost-ledger',
  'the-repeated-recovery-refuses',
  'the-take-over-replays-the-owed-ledger',
  'the-service-admits-after-the-replay',
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
  const targetDuring = `kamkmchess_interruption_during_${RUN}`;
  const targetAfter = `kamkmchess_interruption_after_${RUN}`;

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
    // compose entrypoint of the deployment prepares it.
    const prepared = await run('docker', [
      'run', '--rm', '--user', 'root:0', '--network', endpoint.network,
      '--mount', `type=volume,source=${VOLUME},target=/backups`,
      endpoint.image, 'sh', '-c',
      `mkdir -p ${FENCE} && chown 65532:65532 /backups ${FENCE} && chmod 700 ${FENCE}`,
    ]);
    if (prepared.code !== 0) throw new Error(`the shared fence directory could not be prepared: ${prepared.stderr.trim()}`);

    const binary = join(DIRECTORY, 'khabackup');
    const helper = join(DIRECTORY, 'fenceprobe');
    const barriers = {
      during: join(DIRECTORY, 'psql-during.sh'),
      after: join(DIRECTORY, 'psql-after.sh'),
      none: join(DIRECTORY, 'psql-none.sh'),
    };
    const markers = {
      during: '/backups/barrier-during-committed',
      after: '/backups/barrier-after-committed',
      none: '/backups/barrier-none-committed',
    };
    const applications = {
      during: 'kamkm_proof_barrier_during',
      after: 'kamkm_proof_barrier_after',
      none: 'kamkm_proof_barrier_none',
    };
    const built = await run('go', ['build', '-trimpath', '-o', binary, './backend/backup/cmd/khabackup'], { env: { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' } });
    if (built.code !== 0) throw new Error('the backup command could not be built');
    const builtHelper = await run('go', ['build', '-trimpath', '-tags', 'fenceprobe', '-o', helper, './tools/fenceprobe'], { env: { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' } });
    if (builtHelper.code !== 0) throw new Error('the fence helper could not be built');
    for (const mode of ['during', 'after', 'none']) {
      await writeFile(barriers[mode], barrierScript(mode, { application: applications[mode], marker: markers[mode] }), 'utf8');
      // The barrier is a program: the restore executes it.
      await chmod(barriers[mode], 0o755);
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
    await createDatabase(targetDuring);
    await migrate(targetDuring);
    await createDatabase(targetAfter);
    await migrate(targetAfter);

    // The source carries the match of the removed subject and the match of the
    // control. The removals are seeded into the live databases afterwards, so
    // no bundle carries them.
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
    await seed(targetDuring);
    await seed(targetAfter);
    // The private payload of the removed subject and of an unrelated
    // subject. The bundle carries both, the import brings both into the
    // target, and the removal of the subject erases only its own payload.
    const seedPrivatePayload = async (database) => {
      const payload = `'\\x${Buffer.from('{"private":"payload"}', 'utf8').toString('hex')}'::bytea`;
      const chunk = `'\\x${Buffer.from('{"chunk":1}', 'utf8').toString('hex')}'::bytea`;
      const event = `'\\x${Buffer.from('{"event":1}', 'utf8').toString('hex')}'::bytea`;
      const result = `'\\x${Buffer.from('{"result":1}', 'utf8').toString('hex')}'::bytea`;
      for (const [game, owner, body] of [['proof_private_game', 'proof_owner_private', payload], ['proof_control_game', 'proof_owner_control', chunk]]) {
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
      if (controlChunk.code !== 0) throw new Error(`the archive chunk of the control could not be seeded: ${controlChunk.error}`);
      const controlEvent = await sql(database, `INSERT INTO archive_events (game_id, sequence, item_id, raw_json) VALUES ('proof_control_game', 0, 'proof_control_event', ${event})`);
      if (controlEvent.code !== 0) throw new Error(`the archive event of the control could not be seeded: ${controlEvent.error}`);
    };
    await seedPrivatePayload(sourceDatabase);

    // The live only row of the target is the snapshot of the import: the
    // bundle does not carry it, the import replaces it, and a rollback
    // leaves it where it was.
    await seedLiveOnly(targetDuring);
    await seedLiveOnly(targetAfter);

    // The live only row of the target: the bundle does not carry it.
    async function seedLiveOnly(database) {
      const fen = 'rnbqkbnr/ppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      await sql(database, `INSERT INTO online_matches (match_id, schema_version, variant, starting_fen, position_fen, starting_time_ms, increment_ms, version, control_epoch, input_hash, rules_policy_version, status) VALUES ('proof_match_live_only', 1, 'orthodox', '${fen}', '${fen}', 60000, 0, 1, 1, decode(repeat('00',32),'hex'), 'online-rules/1', 'active')`);
      await sql(database, `INSERT INTO online_seats (match_id, seat, owner_kind, owner_id, public_label, control_kind, model_label, control_epoch) VALUES ('proof_match_live_only', 'white', 'account', 'proof_owner_live_only', 'Proof', 'human', NULL, 1)`);
      await sql(database, `INSERT INTO online_public_replays (match_id, schema_version, replay_json, result_hash, game_kind, scored) VALUES ('proof_match_live_only', 2, '{"moves":[]}'::jsonb, decode(repeat('00',32),'hex'), 'friend', true)`);
    }

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
    const references = await seedRemovals(targetDuring);
    await seedRemovals(targetAfter);
    const subjectOnly = await sql(targetDuring, `SELECT count(*) FROM online_removal_subjects WHERE subject_id = 'rs_interruption_subject_${RUN}'`);
    const inBundle = await sql(sourceDatabase, `SELECT count(*) FROM online_removal_subjects WHERE subject_id = 'rs_interruption_subject_${RUN}'`);
    const live = await removalState(context, targetDuring);
    steps.push({
      id: 'the-live-only-removals-are-seeded',
      passed: live.matches === '1' && live.subjects === '1' && subjectOnly.text === '1' && inBundle.text === '0',
      detail: `the live database carries ${live.matches} match bound removal and ${live.subjects} subject removal, the subject only record is there (${subjectOnly.text}) and no bundle carries it (${inBundle.text})`,
    });


    // The restore runs in its own container, so it can be killed exactly at
    // the barrier.
    const startRestore = async (database, restoreId, mode) => {
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
        '--fence', FENCE,
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

    // The barrier of the "during" case: the import transaction is open and
    // the backend of the barrier is busy inside it.
    const waitForTransaction = async (database) => {
      for (let attempt = 0; attempt < 45; attempt += 1) {
        const state = await sql('postgres', `SELECT count(*) FROM pg_stat_activity WHERE application_name = '${applications.during}' AND datname = '${database}' AND xact_start IS NOT NULL AND query LIKE '%pg_sleep%'`);
        if (state.text === '1') return true;
        const alive = await run('docker', ['inspect', '--format', '{{.State.Running}}', containers[containers.length - 1]]);
        if (alive.code !== 0 || alive.stdout.trim() !== 'true') return false;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
      }
      return false;
    };
    // The barrier of the "after" case: the real psql committed.
    const fenceOwnerId = async () => {
      const marker = await run('docker', [
        'run', '--rm', '--user', 'root:0', '--network', endpoint.network,
        '--mount', `type=volume,source=${VOLUME},target=/backups`,
        endpoint.image, 'sh', '-c', `cat ${FENCE}/restore-fence/owner 2>/dev/null`,
      ]);
      try {
        const owner = JSON.parse((marker.stdout || '').trim());
        return typeof owner.restoreId === 'string' ? owner.restoreId : '';
      } catch {
        return '';
      }
    };
    const containerLog = async (id) => {
      const collected = await run('docker', ['logs', id]);
      return (collected.stdout + collected.stderr).trim().split('\n').slice(-4).join(' | ');
    };
    const waitForCommit = async () => {
      for (let attempt = 0; attempt < 45; attempt += 1) {
        const marker = await run('docker', [
          'run', '--rm', '--network', endpoint.network,
          '--mount', `type=volume,source=${VOLUME},target=/backups`,
          endpoint.image, 'sh', '-c', `test -e ${markers.after} && echo committed || echo waiting`,
        ]);
        if (marker.stdout.trim() === 'committed') return true;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
      }
      return false;
    };

    // ---- the kill during the import transaction -------------------------
    const duringId = `restore-during-${RUN}`;
    const duringContainer = await startRestore(targetDuring, duringId, 'during');
    const transactionOpen = await waitForTransaction(targetDuring);
    const duringOwnerAtBarrier = await fenceOwnerId();
    steps.push({
      id: 'the-marker-names-the-restore-while-it-is-alive',
      passed: duringOwnerAtBarrier.length > 0,
      detail: duringOwnerAtBarrier
        ? `the marker of the lifecycle names the restore ${duringOwnerAtBarrier} while the restore is alive at the barrier`
        : 'the marker of the lifecycle names no restore while the restore is alive',
    });
    const killedDuring = await run('docker', ['kill', duringContainer]);
    steps.push({
      id: 'the-import-is-killed-during-the-transaction',
      passed: transactionOpen && killedDuring.code === 0,
      detail: transactionOpen
        ? `the import transaction was open (the barrier of the real psql) and the restore was killed with signal ${killedDuring.stdout.trim()}`
        : `the import transaction was not open when the restore was killed: ${await containerLog(duringContainer)}`,
    });
    await run('docker', ['rm', '--force', duringContainer]);
    containers.splice(containers.indexOf(duringContainer), 1);

    const afterRollback = await removalState(context, targetDuring);
    const replayAfterRollback = await replayState(context, targetDuring, matchId);
    const liveOnlyAfterRollback = await replayState(context, targetDuring, 'proof_match_live_only');
    steps.push({
      id: 'the-import-is-rolled-back',
      passed: afterRollback.matches === '1' && afterRollback.subjects === '1' && replayAfterRollback.present && !replayAfterRollback.revoked && liveOnlyAfterRollback.present,
      detail: `the transaction was rolled back: the live removals are still there (${afterRollback.matches} match bound, ${afterRollback.subjects} subject), the record of the removed match is not revoked, and the live only row of the target survived the import`,
    });

    // ---- the recovery of the rolled back restore ------------------------
    const duringOwner = await fenceOwnerId();
    steps.push({
      id: 'the-marker-names-the-same-restore-after-the-crash',
      passed: duringOwner.length > 0 && duringOwner === duringOwnerAtBarrier,
      detail: duringOwner === duringOwnerAtBarrier && duringOwner.length > 0
        ? `the marker of the crashed restore still names the restore ${duringOwner}`
        : `the marker names ${duringOwner || 'nothing'} after the crash, and it named ${duringOwnerAtBarrier || 'nothing'} at the barrier`,
    });
    steps.push({
      id: 'the-marker-names-the-restore-that-crashed',
      passed: duringOwner.length > 0,
      detail: duringOwner
        ? `the marker of the lifecycle names the restore ${duringOwner} (the restore names itself, the command line cannot name it)`
        : 'the marker of the lifecycle names no restore',
    });
    const recoveredDuring = await tool([
      'recover',
      '--file', oldBundle,
      '--restore-id', duringOwner,
      '--fence', FENCE,
      '--database-url-env', 'DATABASE_URL',
      '--passphrase-env', 'KHA_BACKUP_PASSPHRASE',
    ], { DATABASE_URL: insideDatabaseUrl(context.target.url, targetDuring), KHA_BACKUP_PASSPHRASE: PASSPHRASE });
    const afterRecovery = await removalState(context, targetDuring);
    steps.push({
      id: 'the-recovery-closes-the-fence-of-the-rolled-back-restore',
      passed: recoveredDuring.code === 0 && afterRecovery.matches === '1' && afterRecovery.subjects === '1',
      detail: recoveredDuring.code === 0
        ? 'the recovery of the rolled back restore closed the fence, and the removals it owed are still applied'
        : `the recovery of the rolled back restore failed: ${recoveredDuring.stderr.trim().split('\n').slice(-1)[0] ?? ''}`,
    });

    // ---- the kill after the commit --------------------------------------
    const afterId = `restore-after-${RUN}`;
    const afterContainer = await startRestore(targetAfter, afterId, 'after');
    const committed = await waitForCommit();
    const killedAfter = await run('docker', ['kill', afterContainer]);
    steps.push({
      id: 'the-import-is-killed-after-the-commit',
      passed: committed && killedAfter.code === 0,
      detail: committed
        ? `the real psql committed the import and the restore was killed with signal ${killedAfter.stdout.trim()} before the removal ledger was replayed`
        : `the import did not commit before the restore was killed: ${await containerLog(afterContainer)}`,
    });
    await run('docker', ['rm', '--force', afterContainer]);
    containers.splice(containers.indexOf(afterContainer), 1);

    const afterImport = await removalState(context, targetAfter);
    const replayAfterImport = await replayState(context, targetAfter, matchId);
    const liveOnlyAfterImport = await replayState(context, targetAfter, 'proof_match_live_only');
    const payloadInSource = await sql(sourceDatabase, `SELECT count(*) FROM games WHERE game_id = 'proof_private_game' AND length(checkpoint_json) > 2`);
    const payloadAfterImport = await sql(targetAfter, `SELECT count(*) FROM games WHERE game_id = 'proof_private_game' AND length(checkpoint_json) > 2`);
    steps.push({
      id: 'the-private-payload-is-in-the-bundle-and-in-the-restored-database',
      passed: payloadInSource.text === '1' && payloadAfterImport.text === '1',
      detail: `the bundle carries the private payload of the removed subject (${payloadInSource.text}) and the import brought it into the target (${payloadAfterImport.text})`,
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
    const afterOwner = await fenceOwnerId();
    const evidence = await run('docker', [
      'run', '--rm', '--user', 'root:0', '--network', endpoint.network,
      '--mount', `type=volume,source=${VOLUME},target=/backups`,
      endpoint.image, 'sh', '-c',
      `stat -c '%a %u' ${FENCE}/restore-requirements 2>&1; ls -l ${FENCE}/restore-requirements 2>&1 | tail -n 1`,
    ]);
    const evidenceText = (evidence.stdout + evidence.stderr).trim();
    steps.push({
      id: 'the-durable-evidence-of-the-owed-ledger-exists',
      passed: evidence.code === 0 && /\b700 65532\b/.test(evidenceText) && /-rw-------/.test(evidenceText),
      detail: evidence.code === 0 && /-rw-------/.test(evidenceText)
        ? `the evidence of the owed ledger is there and private: ${evidenceText.split('\n').join(' | ')}`
        : `the evidence of the owed ledger is missing or not private: ${evidenceText.split('\n').join(' | ')}`,
    });

    // ---- the gate stays closed ------------------------------------------
    const gate = await startGate(context, endpoint, targetAfter, containers);
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
      '--restore-id', afterOwner,
      '--fence', FENCE,
      '--database-url-env', 'DATABASE_URL',
      '--passphrase-env', 'KHA_BACKUP_PASSPHRASE',
    ], { DATABASE_URL: insideDatabaseUrl(context.target.url, targetAfter), KHA_BACKUP_PASSPHRASE: PASSPHRASE });
    const stillLost = await removalState(context, targetAfter);
    steps.push({
      id: 'the-recovery-refuses-the-lost-ledger',
      passed: recovered.code !== 0 && stillLost.matches === '0' && stillLost.subjects === '0',
      detail: recovered.code !== 0
        ? `the recovery refused a database that lost the removals: ${recovered.stderr.trim().split('\n').slice(-1)[0] ?? ''}`
        : 'the recovery closed the fence of a database that lost the removals',
    });

    // A second recovery has nothing to recover: the fence of the crashed
    // restore is closed.
    const repeated = await tool([
      'recover',
      '--file', oldBundle,
      '--restore-id', afterOwner,
      '--fence', FENCE,
      '--database-url-env', 'DATABASE_URL',
      '--passphrase-env', 'KHA_BACKUP_PASSPHRASE',
    ], { DATABASE_URL: insideDatabaseUrl(context.target.url, targetAfter), KHA_BACKUP_PASSPHRASE: PASSPHRASE });
    steps.push({
      id: 'the-repeated-recovery-refuses',
      passed: repeated.code !== 0,
      detail: repeated.code !== 0
        ? `a second recovery of the same restore refuses: ${repeated.stderr.trim().split('\n').slice(-1)[0] ?? ''}`
        : 'a second recovery of a closed restore was accepted',
    });

    // ---- the take-over replays the owed ledger --------------------------
    const takeover = await tool([
      'restore',
      '--file', oldBundle,
      '--newer-ledger', newerBundle,
      '--fence', FENCE,
      '--restore-id', afterId,
      '--takeover',
      '--database-url-env', 'DATABASE_URL',
      '--passphrase-env', 'KHA_BACKUP_PASSPHRASE',
      '--psql', '/fixtures/psql-none.sh',
      '--apply',
    ], { DATABASE_URL: insideDatabaseUrl(context.target.url, targetAfter), KHA_BACKUP_PASSPHRASE: PASSPHRASE });
    const afterTakeover = await removalState(context, targetAfter);
    steps.push({
      id: 'the-take-over-replays-the-owed-ledger',
      passed: takeover.code === 0 && afterTakeover.matches === '1' && afterTakeover.subjects === '1',
      detail: takeover.code === 0
        ? `the take-over finished and the owed ledger is applied again (${afterTakeover.matches} match bound, ${afterTakeover.subjects} subject)`
        : `the take-over failed: ${takeover.stderr.trim().split('\n').slice(-2).join(' | ')}`,
    });

    // ---- the service admits again ---------------------------------------
    const gateAfter = await startGate(context, endpoint, targetAfter, containers);
    const served = await waitForGate(gateAfter.port);
    steps.push({
      id: 'the-service-admits-after-the-replay',
      passed: served !== null && served.status === 200,
      detail: served !== null ? `the gate answered ${served.status} after the owed ledger was replayed` : 'the gate did not answer',
    });
    await run('docker', ['rm', '--force', gateAfter.id]);
    containers.splice(containers.indexOf(gateAfter.id), 1);

    // ---- the private payload of the removed subject ---------------------
    const emptied = await sql(targetAfter, `SELECT count(*) FROM games WHERE game_id = 'proof_private_game' AND checkpoint_json = '{}'::bytea AND deleted_at IS NOT NULL`);
    const chunks = await sql(targetAfter, `SELECT count(*) FROM archive_chunks WHERE game_id = 'proof_private_game'`);
    const events = await sql(targetAfter, `SELECT count(*) FROM archive_events WHERE game_id = 'proof_private_game'`);
    const operation = await sql(targetAfter, `SELECT count(*) FROM operations WHERE game_id = 'proof_private_game' AND result_json = '{}'::bytea`);
    const tombstone = await sql(targetAfter, `SELECT count(*) FROM deletion_tombstones WHERE game_id = 'proof_private_game'`);
    const controlPayload = await sql(targetAfter, `SELECT count(*) FROM games WHERE game_id = 'proof_control_game' AND length(checkpoint_json) > 2`);
    const controlChunks = await sql(targetAfter, `SELECT count(*) FROM archive_chunks WHERE game_id = 'proof_control_game'`);
    const session = await sql(targetAfter, `SELECT count(*) FROM online_session_revocations WHERE subject_id = 'proof_owner_private'`);
    steps.push({
      id: 'the-private-payload-of-the-removed-subject-is-gone',
      passed: emptied.text === '1' && chunks.text === '0' && events.text === '0' && operation.text === '1',
      detail: `the checkpoint of the removed subject is empty (${emptied.text}), its archive chunk (${chunks.text}) and its archive event (${events.text}) are gone and its operation receipt is emptied (${operation.text})`,
    });
    steps.push({
      id: 'the-tombstone-of-the-removed-private-game-is-retained',
      passed: tombstone.text === '1',
      detail: `the payload free tombstone of the removed game is retained (${tombstone.text})`,
    });
    steps.push({
      id: 'the-unrelated-private-payload-survives',
      passed: controlPayload.text === '1' && controlChunks.text === '1',
      detail: `the private payload of the unrelated subject survived (${controlPayload.text} game, ${controlChunks.text} archive chunk)`,
    });
    steps.push({
      id: 'the-session-of-the-removed-subject-is-fenced',
      passed: session.text >= '1',
      detail: `the sessions of the removed subject are fenced (${session.text} revocation)`,
    });

    // ---- the removed data and the control -------------------------------
    const revoked = await replayState(context, targetAfter, matchId);
    const seat = await seatOwner(context, targetAfter, matchId);
    const control = await replayState(context, targetAfter, controlId);
    const controlSeat = await seatOwner(context, targetAfter, controlId);
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
        steps.push({ id: 'the-volume-is-removed', passed: false, detail: `the volume ${volume} could not be removed: ${removed.stderr.trim()}` });
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
 * @param {string} database
 * @returns {Promise<{id: string, port: string}>}
 */
async function startGate(context, endpoint, database, tracked) {
  const url = insideDatabaseUrl(context.target.url, database);
  const started = await run('docker', [
    'run', '--detach',
    '--network', endpoint.network,
    '--add-host', 'host.docker.internal:host-gateway',
    '--user', API_UID,
    '--mount', `type=volume,source=${VOLUME},target=/backups`,
    '--mount', `type=bind,source=${DIRECTORY},target=/fixtures`,
    '--publish', '127.0.0.1::8099',
    '--entrypoint', '/fixtures/fenceprobe',
    endpoint.image, 'watch', FENCE, url, '8099', `restore-gate-${RUN}`,
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
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
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
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
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
