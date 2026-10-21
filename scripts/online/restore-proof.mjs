// The native restore proof.
//
// The proof runs the real command with the real database tools, in throwaway
// databases of this run, against the local fixture container. The fence lives
// in a volume of this run, which the restore and the service share, exactly
// as the deployment shares it.
//
// The cases are:
//
//   - the old bundle and the newer removal ledger are created with the tool;
//   - a restore without a fence is refused;
//   - the service takes the fence and refuses traffic while it is held;
//   - a restore while the fence is held is refused;
//   - the fence is not closed with a digest that does not belong to it;
//   - the death of the holder leaves the marker, and the service keeps
//     refusing;
//   - the take-over of the crashed restore finishes and closes the fence;
//   - the service serves again once the fence is closed;
//   - the published record of the removed subject is revoked and its seat is
//     anonymized, while a subject with no record in the ledger keeps its data.
//
// Every resource of the run is removed in a guarded section, and a failure of
// the removal is a failure of the proof.
//
// Usage:
//   node scripts/online/restore-proof.mjs [--json] [--keep]

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { holderDatabaseUrl, redact, resolveTarget } from '../../deploy/verify-fence-access.mjs';

const DEFAULT_CONTAINER = 'kamkmchess-kha67-local';
const DEFAULT_DATABASE_URL = 'postgres://postgres@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable';
const ROOT = process.cwd();
const RUN = randomUUID().replace(/-/g, '').slice(0, 12);
const PASSPHRASE = 'fixture-only-passphrase';
const DIRECTORY = join(ROOT, '.scratch', 'restore-fixture', RUN);
const VOLUME = `kamkmchess-proof-${RUN}`;

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
 * The image, the network and the address of the fixture database. The default
 * bridge resolves no container name, so the address is used.
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
 * Runs the backup command in a container of that image, on that network, with
 * the volume and the directory of the run mounted.
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @param {string} command
 * @param {{image: string, network: string, host: string}} endpoint
 */
function tool(args, env, command, endpoint) {
  return run('docker', [
    'run', '--rm', '-i',
    '--network', endpoint.network,
    '--add-host', 'host.docker.internal:host-gateway',
    ...Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    '--mount', `type=volume,source=${VOLUME},target=/backups`,
    '--mount', `type=bind,source=${DIRECTORY},target=/fixtures`,
    endpoint.image, command, ...args,
  ]);
}

/**
 * Starts the service that holds the fence and watches it.
 * @param {{image: string, network: string, host: string}} endpoint
 * @param {string} databaseUrl
 * @param {string} restoreId
 * @returns {Promise<{code: number, id: string, logs: string}>}
 */
async function startHolder(endpoint, databaseUrl, restoreId, mode = 'serve') {
  const started = await run('docker', [
    // The container is kept, so the log of an early exit can still be read.
    'run', '--detach',
    '--network', endpoint.network,
    '--add-host', 'host.docker.internal:host-gateway',
    '--user', '65532:65532',
    '--mount', `type=volume,source=${VOLUME},target=/backups`,
    '--mount', `type=bind,source=${DIRECTORY},target=/fixtures`,
    '--publish', '127.0.0.1::8099',
    '--env', 'KAMKM_PROBE_SCHEMA_FILE=/fixtures/schema-name',
    // The helper derives the name of its schema from the run, so the proof
    // knows the name and can drop exactly its own schema.
    '--env', `KAMKM_PROBE_RUN=${RUN}`,
    '--entrypoint', '/fixtures/fenceprobe',
    endpoint.image, mode, '/backups/fence-' + RUN, databaseUrl, '8099', restoreId,
  ]);
  if (started.code !== 0) return { code: started.code, id: '', logs: started.stderr };
  // The helper applies the migrations before it serves, so the proof waits for
  // its readiness line.
  let logs = '';
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const collected = await run('docker', ['logs', started.stdout.trim()]);
    logs = `${collected.stdout}${collected.stderr}`.trim();
    if (logs.includes('serving')) break;
    const alive = await run('docker', ['inspect', '--format', '{{.State.Running}}', started.stdout.trim()]);
    if (alive.code !== 0 || alive.stdout.trim() !== 'true') break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  return { code: 0, id: started.stdout.trim(), logs };
}

/**
 * Runs a statement in the database container of the target.
 * @param {{container: string}} context
 * @param {string} database
 * @param {string} statement
 */
function sql(context, database, statement) {
  return run('docker', ['exec', '-i', context.container, 'psql', '-U', 'postgres', '-d', database, '-At', '-c', statement]);
}

/**
 * Creates a database of the run.
 *
 * The name is registered by the caller as soon as the database exists, so a
 * migration that fails afterwards still leaves a database the cleanup owns.
 * @param {string} database
 */
async function createDatabase(context, database) {
  const created = await sql(context, 'postgres', `CREATE DATABASE ${database}`);
  if (created.code !== 0) throw new Error(`the database ${database} could not be created: ${created.stderr.trim()}`);
}

/**
 * The url of a database of the run, as a container of the deployment sees it.
 *
 * The url of the target is copied and only the host changes, so the
 * credentials and the options of the target are kept and a target that is
 * spelled localhost works as well.
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
 * Applies the migrations to a database of the run.
 *
 * The url of the host keeps the credentials and the options of the target,
 * and the url of the container is the same url with only the host changed,
 * so a target that is spelled localhost or that carries a password works.
 * @param {{target: {url: URL}}} context
 * @param {string} database
 */
export async function migrateDatabase(context, database) {
  const onHost = new URL(context.target.url);
  onHost.pathname = `/${database}`;
  const migrated = await run('go', ['run', './cmd/migrate'], { env: { DATABASE_URL: onHost.toString() } });
  if (migrated.code !== 0) throw new Error(`the migrations could not be applied to ${database}: ${migrated.stderr.trim()}`);
  return { host: onHost.toString(), inside: insideDatabaseUrl(context.target.url, database) };
}
/**
 * @param {string} database
 * @param {string} owner
 * @param {string} matchId
 */
async function seedMatch(context, database, owner, matchId) {
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const match = await sql(context, database, `INSERT INTO online_matches (match_id, schema_version, variant, starting_fen, position_fen, starting_time_ms, increment_ms, version, control_epoch, input_hash, rules_policy_version, status) VALUES ('${matchId}', 1, 'orthodox', '${fen}', '${fen}', 60000, 0, 1, 1, decode(repeat('00',32),'hex'), 'online-rules/1', 'active')`);
  if (match.code !== 0) throw new Error(`the match could not be seeded: ${match.stderr.trim()}`);
  const seat = await sql(context, database, `INSERT INTO online_seats (match_id, seat, owner_kind, owner_id, public_label, control_kind, model_label, control_epoch) VALUES ('${matchId}', 'white', 'account', '${owner}', 'Proof', 'human', NULL, 1)`);
  if (seat.code !== 0) throw new Error(`the seat could not be seeded: ${seat.stderr.trim()}`);
  const replay = await sql(context, database, `INSERT INTO online_public_replays (match_id, schema_version, replay_json, result_hash, game_kind, scored) VALUES ('${matchId}', 2, '{"moves":[]}'::jsonb, decode(repeat('00',32),'hex'), 'friend', true)`);
  if (replay.code !== 0) throw new Error(`the replay could not be seeded: ${replay.stderr.trim()}`);
}

/**
 * @param {string} database
 * @param {string} owner
 * @param {string} matchId
 */
async function seedRemoval(context, database, owner, matchId) {
  const digest = await sql(context, database, `SELECT encode(sha256(convert_to('kamkm.online.removal.v1:${owner}', 'UTF8')), 'hex')`);
  const subject = digest.stdout.trim();
  const inserted = await sql(context, database, `INSERT INTO online_removal_requests (removal_id, subject_kind, subject_id, scope, status, requested_at, verified_at, live_delete_due_at, recovery_sanitize_due_at) VALUES ('rm_proof_${RUN}', 'account', '${subject}', 'explicit_removal', 'verified', clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 day', clock_timestamp() + interval '30 days')`);
  if (inserted.code !== 0) throw new Error(`the removal request could not be seeded: ${inserted.stderr.trim()}`);
  const subjectRecord = await sql(context, database, `INSERT INTO online_removal_subjects (subject_id, removal_id, subject_kind, subject_ref, scope, removed_at) VALUES ('rs_proof_${RUN}', 'rm_proof_${RUN}', 'account', '${subject}', 'explicit_removal', clock_timestamp())`);
  if (subjectRecord.code !== 0) throw new Error(`the removal subject could not be seeded: ${subjectRecord.stderr.trim()}`);
  const ledger = await sql(context, database, `INSERT INTO online_removal_ledger (ledger_id, removal_id, subject_kind, subject_id, match_id, scope, removed_at) VALUES ('rl_proof_${RUN}', 'rm_proof_${RUN}', 'account', '${subject}', '${matchId}', 'explicit_removal', clock_timestamp())`);
  if (ledger.code !== 0) throw new Error(`the removal ledger could not be seeded: ${ledger.stderr.trim()}`);
  return subject;
}

/**
 * The state of the published record of a match.
 * @param {string} database
 * @param {string} matchId
 */
async function replayState(context, database, matchId) {
  const rows = await sql(context, database, `SELECT coalesce((revoked_at IS NOT NULL)::text, 'false') || '|' || (replay_json = '{}'::jsonb)::text || '|' || coalesce(revocation_marker_id, '') FROM online_public_replays WHERE match_id = '${matchId}'`);
  const line = rows.stdout.trim();
  if (!line) return { present: false, revoked: false, emptied: false, marker: '' };
  const [revoked, emptied, marker] = line.split('|');
  return { present: true, revoked: revoked === 'true', emptied: emptied === 'true', marker: marker ?? '' };
}

/**
 * The state of the marker of the fence.
 * @param {{image: string, network: string, host: string}} endpoint
 * @returns {Promise<string>}
 */
async function markerState(endpoint) {
  const state = await run('docker', [
    'run', '--rm', '--network', endpoint.network,
    '--mount', `type=volume,source=${VOLUME},target=/backups`,
    endpoint.image, 'sh', '-c', `test -e /backups/fence-${RUN}/restore-fence/owner && echo open || echo closed`,
  ]);
  return (state.stdout || '').trim() || 'unknown';
}

/**
 * The steps the proof has to show.
 *
 * A step that did not run is a failure: a proof that skipped a case must
 * never be green.
 */
export const REQUIRED_STEPS = [
  'the-old-bundle-is-encrypted-and-created',
  'the-newer-ledger-is-created',
  'a-restore-without-a-fence-is-refused',
  'the-shared-fence-directory-is-prepared',
  'the-service-takes-the-fence',
  'the-service-refuses-while-the-fence-is-held',
  'a-restore-while-the-fence-is-held-is-refused',
  'the-fence-is-not-closed-with-a-wrong-ledger',
  'the-fence-stays-open-after-the-death-of-the-holder',
  'the-take-over-of-the-crashed-restore-finishes',
  'the-fence-is-closed-after-the-take-over',
  'the-service-serves-again-after-the-fence-is-closed',
  'the-published-record-of-the-removed-subject-is-revoked',
  'a-subject-with-no-record-in-the-ledger-keeps-its-data',
  'the-seat-of-the-removed-subject-is-anonymized',
];

/**
 * Creates a database of the run and applies the migrations to it.
 *
 * The name is registered as soon as the database exists, before the
 * migration runs: a migration that fails leaves a database the cleanup owns,
 * so it is dropped instead of leaking into the fixture.
 * @param {string} name
 * @param {{create: (name: string) => Promise<void>, register: (name: string) => void, migrate: (name: string) => Promise<object>}} dependencies
 * @returns {Promise<object>}
 */
export async function createAndMigrate(name, dependencies) {
  await dependencies.create(name);
  dependencies.register(name);
  return dependencies.migrate(name);
}

/**
 * Hides the secret of the target in the report of the proof.
 *
 * The url of the target may carry a password, and the report names the
 * failures of the tools, so every step and every log line is cleaned before
 * it leaves the proof.
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
 * The report of a proof that stopped with an error.
 *
 * A failure is a result and not a crash: the report names the step that
 * failed and the steps that did not run.
 * @param {{id: string, passed: boolean, detail: string}[]} steps
 * @param {string[]} logs
 * @param {unknown} error
 * @returns {{steps: {id: string, passed: boolean, detail: string}[], logs: string[], limits: string[]}}
 */
export function reportFailure(steps, logs, error) {
  steps.push({
    id: 'the-proof-failed',
    passed: false,
    detail: `the proof stopped: ${error instanceof Error ? error.message : String(error)}`,
  });
  return completeReport(steps, logs, ['the proof stopped with an error']);
}

/**
 * The schema the helper of this run uses.
 *
 * The helper derives the name from the run identifier it is given, so the
 * proof knows the name before it starts and never drops the schema of
 * another run.
 */
export const RUN_SCHEMA = `fence_probe_${RUN}`;

/**
 * What the proof removes and what it keeps.
 *
 * With the keep option the resources of the run stay, and the manifest names
 * exactly what they are.
 * @param {{keep: boolean, containers: string[], databases: string[], volumes: string[], directory: string, logs: string[]}} options
 * @returns {{keep: boolean, removeContainers: string[], removeDatabases: string[], removeVolumes: string[], removeDirectory: boolean, manifest: object}}
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
      schemaKept: options.schemaKept === true,
      logs: options.logs.map(entry => redact(entry, options.url)),
    },
  };
}

/**
 * Completes the report of the proof.
 *
 * Every path out of the proof names the steps that did not run, so a run
 * that stopped early is never green.
 * @param {{id: string, passed: boolean, detail: string}[]} steps
 * @param {string[]} logs
 * @param {string[]} limits
 * @returns {{steps: {id: string, passed: boolean, detail: string}[], logs: string[], limits: string[]}}
 */
export function completeReport(steps, logs, limits) {
  for (const required of REQUIRED_STEPS) {
    const marker = `the-step-${required}-ran`;
    const index = steps.findIndex((step) => step.id === marker);
    if (steps.some((step) => step.id === required)) {
      // The step ran after the report was completed, so its marker is stale.
      if (index >= 0) steps.splice(index, 1);
      continue;
    }
    if (index < 0) {
      steps.push({ id: marker, passed: false, detail: 'the step did not run, so the proof is not complete' });
    }
  }
  return { steps, logs, limits };
}

/**
 * Runs the proof.
 * @param {{keep?: boolean}} [options]
 */
export async function runRestoreProof(options = {}) {
  /** @type {{id: string, passed: boolean, detail: string}[]} */
  const steps = [];
  /** @type {string[]} */
  const logs = [];
  const sourceDatabase = `kamkmchess_proof_source_${RUN}`;
  const targetDatabase = `kamkmchess_proof_target_${RUN}`;
  const binary = join(DIRECTORY, 'khabackup');
  const helper = join(DIRECTORY, 'fenceprobe');
  const command = '/fixtures/khabackup';
  const databases = [];
  const volumes = [];
  /** @type {{image: string, network: string, host: string}|null} */
  let endpoint;
  const holders = [];
  /** @type {{container: string, target: {url: URL}}|null} */
  let context = null;
  // The database that holds the schema of the helper. It is known only when
  // the run created it, so a refusal never looks for a database that is not
  // there.
  let acquiredSchemaDatabase = null;

  try {
    // The target of the proof is explicit: the container and the database
    // come from the environment or from the options, and a target that does
    // not address the fixture is refused before anything is created.
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
    await mkdir(DIRECTORY, { recursive: true });
    endpoint = await fixtureEndpoint(context.container);
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
    const created = await run('docker', ['volume', 'create', `--label=kamkmchess.ops.proof=${RUN}`, VOLUME]);
    if (created.code !== 0) throw new Error(`the volume of the run could not be created: ${created.stderr.trim()}`);
    volumes.push(VOLUME);

    const built = await run('go', ['build', '-trimpath', '-o', binary, './backend/backup/cmd/khabackup'], { env: { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' } });
    if (built.code !== 0) throw new Error('the backup command could not be built');
    const builtHelper = await run('go', ['build', '-trimpath', '-tags', 'fenceprobe', '-o', helper, './tools/fenceprobe'], { env: { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' } });
    if (builtHelper.code !== 0) throw new Error('the fence helper could not be built');

    // The databases of the run are registered as soon as they exist, so a
    // migration that fails still leaves a database the cleanup drops.
    const source = await createAndMigrate(sourceDatabase, {
      create: (name) => createDatabase(context, name),
      register: (name) => databases.push(name),
      migrate: (name) => migrateDatabase(context, name),
    });
    const target = await createAndMigrate(targetDatabase, {
      create: (name) => createDatabase(context, name),
      register: (name) => databases.push(name),
      migrate: (name) => migrateDatabase(context, name),
    });
    acquiredSchemaDatabase = targetDatabase;

    const owner = 'proof_owner';
    const matchId = 'proof_match_1';
    await seedMatch(context, sourceDatabase, owner, matchId);
    // A second subject owns a match that no removal names.
    await seedMatch(context, sourceDatabase, 'proof_owner_other', 'proof_match_2');

    const made = await tool(['create', '--class', 'daily', '--out', `/backups/old-${RUN}.kha`], { DATABASE_URL: source.inside, KHA_BACKUP_PASSPHRASE: PASSPHRASE }, command, endpoint);
    steps.push({ id: 'the-old-bundle-is-encrypted-and-created', passed: made.code === 0, detail: made.code === 0 ? 'the old bundle was created with the real tool' : `the bundle could not be created: ${made.stderr.trim()}` });
    if (made.code !== 0) return completeReport(steps, logs, ['the old bundle could not be created']);

    await seedRemoval(context, sourceDatabase, owner, matchId);
    const madeNewer = await tool(['create', '--class', 'daily', '--out', `/backups/newer-${RUN}.kha`], { DATABASE_URL: source.inside, KHA_BACKUP_PASSPHRASE: PASSPHRASE }, command, endpoint);
    steps.push({ id: 'the-newer-ledger-is-created', passed: madeNewer.code === 0, detail: madeNewer.code === 0 ? 'the newer bundle carries the removal ledger' : `the newer bundle could not be created: ${madeNewer.stderr.trim()}` });
    if (madeNewer.code !== 0) return completeReport(steps, logs, ['the newer bundle could not be created']);

    const noFence = await tool(['restore', '--file', `/backups/old-${RUN}.kha`, '--database-url-env', 'DATABASE_URL', '--passphrase-env', 'KHA_BACKUP_PASSPHRASE', '--apply'], { DATABASE_URL: target.inside, KHA_BACKUP_PASSPHRASE: PASSPHRASE }, command, endpoint);
    steps.push({
      id: 'a-restore-without-a-fence-is-refused',
      passed: noFence.code !== 0 && /fence/i.test(noFence.stderr + noFence.stdout),
      detail: noFence.code !== 0 ? 'the restore refused to run without a fence' : 'the restore ran without a fence',
    });

    // The shared fence directory belongs to the user that writes it, the way
    // the compose entrypoint of the deployment prepares it.
    const prepared = await run('docker', [
      'run', '--rm', '--user', 'root:0', '--network', endpoint.network,
      '--mount', `type=volume,source=${VOLUME},target=/backups`,
      endpoint.image, 'sh', '-c',
      `mkdir -p /backups/fence-${RUN} && chown 65532:65532 /backups/fence-${RUN} && chmod 700 /backups/fence-${RUN}`,
    ]);
    steps.push({
      id: 'the-shared-fence-directory-is-prepared',
      passed: prepared.code === 0,
      detail: prepared.code === 0 ? 'the fence directory belongs to the user of the service' : `the fence directory could not be prepared: ${prepared.stderr.trim()}`,
    });

    // The service that holds the fence and watches it. It reaches the fixture
    // database over the published port of the host.
    const gateDatabase = insideDatabaseUrl(context.target.url, targetDatabase);
    const holder = await startHolder(endpoint, gateDatabase, `restore-holder-${RUN}`);
    logs.push(`holder: ${holder.logs}`);
    if (holder.id) holders.push(holder.id);
    if (holder.code !== 0 || !holder.id) {
      steps.push({ id: 'the-service-takes-the-fence', passed: false, detail: `the service could not start: ${holder.logs || 'no container'}` });
      return completeReport(steps, logs, ['the service that holds the fence could not start']);
    }
    holders.push(holder.id);
    const inspected = await run('docker', ['port', holder.id, '8099/tcp']);
    const port = (inspected.stdout || '').trim().split('\n')[0]?.split(':').pop() ?? '';

    const marker = await markerState(endpoint);
    steps.push({
      id: 'the-service-takes-the-fence',
      passed: marker === 'open',
      detail: marker === 'open' ? 'the marker of the lifecycle is there' : `the marker state is ${marker}`,
    });

    if (port) {
      const refused = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null);
      steps.push({
        id: 'the-service-refuses-while-the-fence-is-held',
        passed: refused !== null && refused.status === 503,
        detail: refused !== null ? `the gate answered ${refused.status} while the fence was held` : 'the gate did not answer',
      });
    }

    const overlap = await tool(['restore', '--file', `/backups/old-${RUN}.kha`, '--newer-ledger', `/backups/newer-${RUN}.kha`, '--database-url-env', 'DATABASE_URL', '--passphrase-env', 'KHA_BACKUP_PASSPHRASE', '--fence', `/backups/fence-${RUN}`, '--restore-id', `restore-second-${RUN}`, '--apply'], { DATABASE_URL: target.inside, KHA_BACKUP_PASSPHRASE: PASSPHRASE }, command, endpoint);
    steps.push({
      id: 'a-restore-while-the-fence-is-held-is-refused',
      passed: overlap.code !== 0 && /in progress|already|live/i.test(overlap.stderr + overlap.stdout),
      detail: overlap.code !== 0 ? `the second restore was refused: ${overlap.stderr.trim().split('\n').slice(-1)[0] ?? ''}` : 'the second restore was accepted while the fence was held',
    });

    if (port) {
      const wrong = await fetch(`http://127.0.0.1:${port}/finish?wrong=1`).catch(() => null);
      const body = wrong === null ? '' : await wrong.text();
      const afterWrong = await markerState(endpoint);
      steps.push({
        id: 'the-fence-is-not-closed-with-a-wrong-ledger',
        passed: wrong !== null && wrong.status === 409 && /ledger|owner|digest|restore/i.test(body) && afterWrong === 'open',
        detail: wrong !== null
          ? `the close with a wrong removal ledger was refused with ${wrong.status} (${body.trim().slice(0, 120)}) and the marker is ${afterWrong}`
          : 'the close with a wrong removal ledger was not answered',
      });
    }

    // The holder dies without closing the fence.
    for (const id of holders) {
      const killed = await run('docker', ['kill', id]);
      // A holder that is already gone is the death case, not a failure of
      // the harness: the marker is the evidence.
      if (killed.code !== 0 && !/no such container|is not running/i.test(killed.stderr)) steps.push({ id: 'the-holder-is-stopped', passed: false, detail: `the holder could not be stopped: ${killed.stderr.trim()}` });
      const removed = await run('docker', ['rm', '--force', id]);
      if (removed.code !== 0 && !/no such container|is not running/i.test(removed.stderr)) {
        steps.push({ id: 'the-holder-is-removed', passed: false, detail: `the holder could not be removed: ${removed.stderr.trim()}` });
      }
    }
    holders.length = 0;
    const afterDeath = await markerState(endpoint);
    steps.push({
      id: 'the-fence-stays-open-after-the-death-of-the-holder',
      passed: afterDeath === 'open',
      detail: afterDeath === 'open' ? 'the marker of the lifecycle survived the death of the holder' : `the marker state is ${afterDeath}`,
    });

    const takeover = await tool(['restore', '--file', `/backups/old-${RUN}.kha`, '--newer-ledger', `/backups/newer-${RUN}.kha`, '--database-url-env', 'DATABASE_URL', '--passphrase-env', 'KHA_BACKUP_PASSPHRASE', '--fence', `/backups/fence-${RUN}`, '--restore-id', `restore-holder-${RUN}`, '--takeover', '--apply'], { DATABASE_URL: target.inside, KHA_BACKUP_PASSPHRASE: PASSPHRASE }, command, endpoint);
    steps.push({
      id: 'the-take-over-of-the-crashed-restore-finishes',
      passed: takeover.code === 0,
      detail: takeover.code === 0 ? `the take-over finished: ${takeover.stdout.trim().split('\n').filter(Boolean).slice(-1)[0] ?? ''}` : `the take-over failed: ${takeover.stderr.trim().split('\n').slice(-2).join(' | ')}`,
    });

    const afterTakeover = await markerState(endpoint);
    steps.push({
      id: 'the-fence-is-closed-after-the-take-over',
      passed: afterTakeover === 'closed',
      detail: afterTakeover === 'closed' ? 'the marker is gone after the take-over' : `the marker state is ${afterTakeover}`,
    });

    // A service that starts after the fence is closed serves again.
    const second = await startHolder(endpoint, gateDatabase, `restore-after-${RUN}`, 'watch');
    logs.push(`second holder: ${second.logs}`);
    if (second.id) {
      holders.push(second.id);
      const inspectedSecond = await run('docker', ['port', second.id, '8099/tcp']);
      const secondPort = (inspectedSecond.stdout || '').trim().split('\n')[0]?.split(':').pop() ?? '';
      if (secondPort) {
        const served = await fetch(`http://127.0.0.1:${secondPort}/healthz`).catch(() => null);
        steps.push({
          id: 'the-service-serves-again-after-the-fence-is-closed',
          passed: served !== null && served.status === 200,
          detail: served !== null ? `the gate answered ${served.status} after the fence was closed` : 'the gate did not answer',
        });
      }
    }

    const revoked = await replayState(context, targetDatabase, matchId);
    steps.push({
      id: 'the-published-record-of-the-removed-subject-is-revoked',
      passed: revoked.present && revoked.revoked && revoked.emptied && revoked.marker.length > 0,
      detail: revoked.present
        ? `the record is revoked=${revoked.revoked}, the payload is emptied=${revoked.emptied}, the marker is ${revoked.marker || 'empty'}`
        : 'the record is not in the restored copy',
    });

    const kept = await replayState(context, targetDatabase, 'proof_match_2');
    steps.push({
      id: 'a-subject-with-no-record-in-the-ledger-keeps-its-data',
      passed: kept.present && !kept.revoked,
      detail: kept.present ? `the record of the other subject is still published (revoked=${kept.revoked})` : 'the record of the other subject is missing',
    });

    const seat = await sql(context, targetDatabase, `SELECT owner_id FROM online_seats WHERE match_id = '${matchId}'`);
    steps.push({
      id: 'the-seat-of-the-removed-subject-is-anonymized',
      passed: seat.stdout.trim() === 'anonymized',
      detail: `the owner of the seat is ${seat.stdout.trim() || 'unknown'}`,
    });

    return completeReport(steps, logs, [
        'The 503 and the 200 of this proof come from two different services: the service that holds the fence and the service that watches it after the take-over. The same process is shown in deploy/verify-fence-access.mjs.',
        'The crash of the restore during its import is not exercised here; this proof kills the holder of the fence.',
        'The proof runs against the local fixture container, not against the deployment host.',
        'The ownership of the fence by the deployment user is covered by deploy/verify-fence-access.mjs.',
      ]);
  } catch (error) {
    // A failure of the proof is a result and not a crash: the report names
    // the step that failed and the steps that did not run, and the exit code
    // refuses the run.
    return reportFailure(steps, logs, error);
  } finally {
    const plan = planCleanup({
      keep: options.keep === true,
      containers: holders,
      databases,
      volumes,
      directory: DIRECTORY,
      logs,
      schema: RUN_SCHEMA,
      schemaDatabase: targetDatabase,
      schemaKept: options.keep === true,
      url: context?.target?.url,
    });
    // The secret of the target is never written to the report, and the
    // manifest carries the logs of the run, so the report is cleaned first.
    redactReport(steps, logs, context?.target?.url);
    if (plan.keep && (plan.manifest.volumes.length > 0 || plan.manifest.databases.length > 0 || plan.manifest.containers.length > 0)) {
      // The resources of the run stay, and the manifest names exactly what
      // they are, so an operator can remove them.
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
        steps.push({ id: 'the-holders-are-removed', passed: false, detail: 'a container of the run could not be removed: ' + removed.stderr.trim() });
      }
    }
    // The schema of the helper belongs to this run, and the helper is killed
    // before it can drop it, so the proof drops exactly its own schema. With
    // the keep option the schema stays, so it can be inspected.
    if (!plan.keep && context && acquiredSchemaDatabase) {
      // The schema is looked up and dropped in the database the helper
      // connected to, and the lookup happens before the databases of the run
      // are dropped, so the step reports the schema it really checked.
      const database = acquiredSchemaDatabase;
      const present = await sql(context, database, `SELECT count(*) FROM pg_namespace WHERE nspname = '${RUN_SCHEMA}'`);
      const remaining = (present.stdout || '').trim();
      if (present.code === 0 && remaining === '0') {
        steps.push({ id: 'the-schema-of-the-run-is-dropped', passed: true, detail: `the schema ${RUN_SCHEMA} of the run is not in ${database}` });
      } else if (present.code !== 0) {
        steps.push({ id: 'the-schema-of-the-run-is-dropped', passed: false, detail: `the schema ${RUN_SCHEMA} could not be looked up in ${database}: ${present.stderr.trim()}` });
      } else {
        const dropped = await sql(context, database, `DROP SCHEMA IF EXISTS ${RUN_SCHEMA} CASCADE`);
        const gone = await sql(context, database, `SELECT count(*) FROM pg_namespace WHERE nspname = '${RUN_SCHEMA}'`);
        steps.push({
          id: 'the-schema-of-the-run-is-dropped',
          passed: dropped.code === 0 && (gone.stdout || '').trim() === '0',
          detail: dropped.code === 0
            ? `the schema ${RUN_SCHEMA} of the run is gone from ${database}`
            : `the schema ${RUN_SCHEMA} could not be dropped from ${database}: ${dropped.stderr.trim()}`,
        });
      }
    } else if (acquiredSchemaDatabase) {
      steps.push({ id: 'the-schema-of-the-run-is-kept', passed: true, detail: `the schema ${RUN_SCHEMA} of the run is kept for inspection in ${acquiredSchemaDatabase}, and the manifest names it` });
    }
    for (const database of plan.removeDatabases) {
      const dropped = await sql(context, 'postgres', `DROP DATABASE IF EXISTS ${database}`);
      if (dropped.code !== 0) {
        steps.push({ id: 'the-fixture-databases-are-removed', passed: false, detail: `the database ${database} could not be dropped: ${dropped.stderr.trim()}` });
      }
    }
    for (const volume of plan.removeVolumes) {
      const removed = await run('docker', ['volume', 'rm', '--force', volume]);
      if (removed.code !== 0) {
        steps.push({ id: 'the-probe-volume-is-removed', passed: false, detail: `the volume ${volume} could not be removed: ${removed.stderr.trim()}` });
      }
    }
    if (plan.removeDirectory) {
      try {
        await rm(DIRECTORY, { recursive: true, force: true });
      } catch (error) {
        steps.push({ id: 'the-directory-of-the-run-is-removed', passed: false, detail: `the directory could not be removed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    // Cleanup can add tool errors after the manifest was written.
    redactReport(steps, logs, context?.target?.url);
  }
}

/**
 * The exit code of the proof.
 *
 * A failed step has to fail the command, in every output format, so a script
 * around it cannot mistake a failed proof for a passed one.
 * @param {{passed: boolean}[]} steps
 * @returns {number}
 */
export function proofExitCode(steps) {
  return steps.some((step) => !step.passed) ? 1 : 0;
}

async function main() {
  const report = await runRestoreProof({ keep: process.argv.includes('--keep') });
  // The exit code is decided before any output, so the format cannot change
  // the outcome.
  process.exitCode = proofExitCode(report.steps);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ tool: 'scripts/online/restore-proof.mjs', ...report }, null, 2)}\n`);
    return;
  }
  for (const step of report.steps) {
    process.stdout.write(`  ${step.passed ? 'PASS' : 'FAIL'} ${step.id}: ${step.detail}\n`);
  }
  for (const limit of report.limits ?? []) {
    process.stdout.write(`  ! ${limit}\n`);
  }
  for (const entry of report.logs ?? []) {
    process.stdout.write(`  log: ${entry}\n`);
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/online/restore-proof.mjs')) {
  await main();
}
