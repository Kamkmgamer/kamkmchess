// Proves the shared ownership of the durable restore fence.
//
// The restore writes the fence inside the database container, the service
// reads it from the shared volume as its own user. The proof shows three
// things with the real code:
//
//   - the database user cannot write the fence of the shared directory, so the
//     restore has to run as the user of the service;
//   - the service takes the fence and refuses traffic while it is held;
//   - the same process closes the fence and serves again.
//
// The holder is the real helper, so its container is kept until its log is
// read. Every resource of the run is removed in a guarded section, and a
// removal that fails is a failure of the proof.
//
// The target of the proof is explicit: the caller names the database, and the
// proof refuses anything it cannot serve before it changes anything.
//
// Usage:
//   node deploy/verify-fence-access.mjs [--json] [--keep]

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const CONTAINER = 'kamkmchess-kha67-local';
const ROOT = process.cwd();
const RUN = randomUUID().replace(/-/g, '').slice(0, 12);
const VOLUME = `kamkmchess-fence-access-${RUN}`;
const DIRECTORY = join(ROOT, '.scratch', 'fence-access', RUN);
const API_UID = '65532:65532';
const DATABASE_UID = '70:70';

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string, string>}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: options.cwd ?? ROOT, windowsHide: true, env: { ...process.env, ...(options.env ?? {}) } });
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
 * The target of the proof.
 *
 * The target is explicit: the caller names the database, and the proof
 * refuses anything it cannot serve. A target that is not the local fixture is
 * rejected before any resource is created, so a wrong configuration never
 * changes a database.
 * @param {{databaseUrl?: string, container?: string}} [options]
 * @returns {{ok: boolean, detail: string, url?: URL, container?: string, database?: string}}
 */
export function resolveTarget(options = {}) {
  const container = options.container ?? CONTAINER;
  const rawUrl = options.databaseUrl ?? 'postgres://postgres@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable';
  /** @type {URL} */
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, detail: 'the database url of the proof could not be parsed' };
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return { ok: false, detail: 'the target of the proof is not a postgres database' };
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (!loopback) {
    return { ok: false, detail: 'the target of the proof is not a local database' };
  }
  const database = url.pathname.replace(/^\//, '');
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    return { ok: false, detail: 'the database of the target is not a plain identifier' };
  }
  if (!url.port) {
    return { ok: false, detail: 'the target of the proof names no port' };
  }
  return { ok: true, detail: '', url, container, database };
}

/**
 * What the proof removes and what it keeps.
 * @param {{keep: boolean, containers: string[], databases: string[], volumes: string[], directory: string, logs: string[], container?: string, schema?: string, target?: string}} options
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
      container: options.container ?? CONTAINER,
      containers: [...options.containers],
      databases: [...options.databases],
      volumes: [...options.volumes],
      directory: options.directory,
      schema: options.schema ?? null,
      schemaKept: options.schemaKept === true,
      target: options.target ?? null,
      logs: [...options.logs],
    },
  };
}

/**
 * Hides the secret of the target in a text of the report.
 * @param {string} text
 * @param {URL} [url]
 * @returns {string}
 */
export function redact(text, url) {
  if (!text) return text;
  let output = String(text);
  if (!url || !url.password) return output;
  output = output.split(url.password).join('***');
  const encoded = encodeURIComponent(url.password);
  if (encoded !== url.password) output = output.split(encoded).join('***');
  return output;
}

/**
 * The schema the helper of this run uses.
 *
 * The helper derives the name from the run identifier it is given, so the
 * proof knows the name before it starts and never has to trust a name that
 * was read from a file.
 */
export const RUN_SCHEMA = `fence_probe_${RUN}`;

/**
 * The name of the schema of the run, when it is the one this run owns.
 *
 * A name that does not belong to this run is never dropped: another run or
 * another proof may own it.
 * @param {string} observed
 * @returns {string|null}
 */
export function ownedSchemaName(observed) {
  const name = String(observed ?? '').trim();
  return name === RUN_SCHEMA ? name : null;
}

/**
 * The fence path the runbook names in its restore command.
 * @param {string} runbook
 * @returns {string}
 */
export function documentedFencePath(runbook) {
  const match = /--fence[= ]+(\S+)/.exec(String(runbook ?? ''));
  return match ? match[1].trim().replace(/[`'.,;:]+$/, '') : '';
}

/**
 * The fence path the deployment note names.
 * @param {string} readme
 * @returns {string}
 */
export function readmeFencePath(readme) {
  const match = /ONLINE_RESTORE_FENCE_PATH=(\S+)/.exec(String(readme ?? ''));
  return match ? match[1].trim().replace(/[`'.,;:]+$/, '') : '';
}

/**
 * The fence paths of the rendered compose configuration.
 *
 * The configuration is rendered, not read: the service receives the rendered
 * value, so the rendered value is the one that has to agree with the
 * runbook.
 * @param {string} rendered the output of `docker compose config --format json`
 * @returns {{postgres: string, api: string}}
 */
export function composeFencePaths(rendered) {
  /** @type {{postgres: string, api: string}} */
  const paths = { postgres: '', api: '' };
  let configuration;
  try {
    configuration = JSON.parse(String(rendered ?? ''));
  } catch {
    return paths;
  }
  const services = configuration?.services ?? {};
  for (const name of ['postgres', 'api']) {
    const environment = services[name]?.environment ?? {};
    const value = environment.ONLINE_RESTORE_FENCE_PATH;
    paths[name] = typeof value === 'string' ? value.trim() : '';
  }
  return paths;
}

/**
 * Whether the runbook, the deployment note and the rendered configuration
 * name the same fence.
 *
 * A restore that holds a fence the API never reads leaves the API serving
 * during the import, so the three names have to be one name.
 * @param {{documented?: string, compose?: string, readme?: string}} paths
 * @returns {{ok: boolean, detail: string, distinct: string[]}}
 */
export function fencePathAgreement(paths) {
  const named = {
    runbook: String(paths.documented ?? '').trim(),
    configuration: String(paths.compose ?? '').trim(),
    note: String(paths.readme ?? '').trim(),
  };
  const missing = Object.entries(named).filter(([, value]) => value.length === 0).map(([name]) => name);
  const distinct = [...new Set(Object.values(named))];
  if (missing.length > 0) {
    return { ok: false, detail: `the ${missing.join(' and the ')} fence path could not be read`, distinct };
  }
  if (distinct.length !== 1) {
    return {
      ok: false,
      detail: `the runbook, the configuration and the note name ${distinct.length} different fences: ${distinct.join(' and ')}`,
      distinct,
    };
  }
  return { ok: true, detail: `the runbook, the configuration and the note name the same fence: ${distinct[0]}`, distinct };
}

/**
 * The image, the network and the address of the database container.
 * @param {string} container
 * @param {typeof run} io
 * @returns {Promise<{image: string, network: string, host: string}>}
 */
async function fixtureEndpoint(container, io) {
  const inspected = await io('docker', ['inspect', '--format', '{{.Config.Image}}', container]);
  const image = inspected.stdout.trim();
  if (!image) throw new Error('the image of the database container could not be read');
  const networks = await io('docker', ['inspect', '--format', '{{json .NetworkSettings.Networks}}', container]);
  /** @type {Record<string, {IPAddress?: string}>} */
  let parsed;
  try {
    parsed = JSON.parse(networks.stdout.trim() || '{}');
  } catch {
    throw new Error('the networks of the database container could not be read');
  }
  const network = Object.keys(parsed)[0];
  const host = parsed[network]?.IPAddress;
  if (!network || !host) throw new Error('the database container has no address');
  return { image, network, host };
}

/**
 * The url the holder uses to reach the selected target.
 *
 * Only the host changes: the container reaches the published port of the
 * host, and the credentials and the options of the target are kept.
 * @param {URL} target
 * @returns {string}
 */
export function holderDatabaseUrl(target) {
  const url = new URL(target.toString());
  url.hostname = 'host.docker.internal';
  return url.toString();
}

/**
 * Runs the helper in a container of the image of the database, as the given
 * user, with the volume of the run and the directory of the run mounted.
 * @param {{image: string, network: string, host: string}} endpoint
 * @param {string} user
 * @param {string[]} args
 * @param {boolean} detach
 * @param {typeof run} io
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function helper(endpoint, user, args, detach, io) {
  const command = ['run'];
  if (detach) command.push('--detach');
  else command.push('--rm', '-i');
  return io('docker', [
    ...command,
    '--network', endpoint.network,
    '--user', user,
    '--mount', `type=volume,source=${VOLUME},target=/backups`,
    '--mount', `type=bind,source=${DIRECTORY},target=/fixtures`,
    '--env', `KAMKM_PROBE_RUN=${RUN}`,
    '--env', 'KAMKM_PROBE_SCHEMA_FILE=/fixtures/schema-name',
    ...(detach ? ['--publish', '127.0.0.1::8099'] : []),
    ...(detach ? ['--entrypoint', '/fixtures/fenceprobe'] : []),
    endpoint.image,
    ...(detach ? [] : ['/fixtures/fenceprobe']),
    ...args,
  ]);
}

/**
 * Reads the fence paths of the deployment.
 *
 * The runbook, the deployment note and the rendered configuration are three
 * sources of one name. The configuration is rendered, because the service
 * receives the rendered value.
 * @param {typeof run} io
 * @returns {Promise<{documented: string, readme: string, postgres: string, api: string, detail: string}>}
 */
async function deploymentFencePaths(io) {
  const runbook = await readFile(join(ROOT, 'docs', 'implementation', 'MVP-operations.md'), 'utf8').catch(() => '');
  const note = await readFile(join(ROOT, 'deploy', 'README.md'), 'utf8').catch(() => '');
  const directory = await mkdtemp(join(tmpdir(), 'kamkmchess-fence-paths-'));
  try {
    // The rendering needs the files of the deployment and placeholders for
    // the secrets, never a real credential.
    await cp(join(ROOT, 'deploy', 'postgres.compose.yml'), join(directory, 'postgres.compose.yml'));
    await cp(join(ROOT, 'deploy', 'api.compose.yml'), join(directory, 'api.compose.yml'));
    await cp(join(ROOT, 'deploy', 'pg_hba.conf'), join(directory, 'pg_hba.conf'));
    await writeFile(join(directory, 'postgres.env'), 'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=fixture-only\nPOSTGRES_DB=kamkmchess\n', 'utf8');
    await writeFile(join(directory, 'api.env'), 'ONLINE_FIXTURE=1\n', 'utf8');
    const rendered = await io('docker', [
      'compose',
      '-f', join(directory, 'postgres.compose.yml'),
      '-f', join(directory, 'api.compose.yml'),
      'config', '--format', 'json',
    ], { cwd: directory });
    if (rendered.code !== 0) {
      return {
        documented: documentedFencePath(runbook),
        readme: readmeFencePath(note),
        postgres: '',
        api: '',
        detail: `the configuration could not be rendered: ${(rendered.stdout + rendered.stderr).trim().split('\n').slice(-1)[0] ?? ''}`,
      };
    }
    const paths = composeFencePaths(rendered.stdout);
    return {
      documented: documentedFencePath(runbook),
      readme: readmeFencePath(note),
      postgres: paths.postgres,
      api: paths.api,
      detail: '',
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Runs the fence helper with mounts of its own.
 *
 * The measurement needs the volume at the path of the deployment, and at the
 * path the runbook names, so a difference between the two shows up as a
 * fence the service cannot see.
 * @param {{image: string, network: string, host: string}} endpoint
 * @param {{user: string, args: string[], mounts: string[], readOnly?: boolean}} options
 * @param {typeof run} io
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function probe(endpoint, options, io) {
  return io('docker', [
    'run', '--rm', '-i',
    '--network', endpoint.network,
    '--user', options.user,
    ...options.mounts,
    '--mount', `type=bind,source=${DIRECTORY},target=/fixtures`,
    '--entrypoint', '/fixtures/fenceprobe',
    endpoint.image,
    ...options.args,
  ]);
}

/**
 * Proves that the fence the runbook opens is the fence the service reads.
 *
 * The restore writes into the volume of the run and the service reads its
 * own volume. Two volumes are needed when the two paths differ: a nested
 * mount of one volume would make a child path and its parent the same
 * directory, and the difference between the two paths would disappear. When
 * the paths are the same, the service reads the volume of the restore, and
 * it has to see the marker the restore wrote.
 * @param {{image: string, network: string, host: string}} endpoint
 * @param {{documented: string, configured: string, apiVolume: string}} paths
 * @param {typeof run} io
 * @returns {Promise<{passed: boolean, detail: string}>}
 */
async function measureFence(io, endpoint, paths) {
  const documented = String(paths.documented ?? '').trim();
  const configured = String(paths.configured ?? '').trim();
  if (!documented || !configured) {
    return { passed: false, detail: 'the fence paths of the deployment could not be read' };
  }
  const restoreMount = ['--mount', `type=volume,source=${VOLUME},target=${documented}`];
  const apiMount = ['--mount', `type=volume,source=${paths.apiVolume},target=${configured}`];
  // The same target twice is not a mount, and the two paths are the same
  // only when the deployment agrees with itself.
  const mounts = documented === configured ? [...restoreMount] : [...restoreMount, ...apiMount];
  // The shared directory belongs to the user of the service, the way the
  // compose entrypoint of the deployment prepares it.
  const prepared = await io('docker', [
    'run', '--rm', '--user', 'root:0', '--network', endpoint.network,
    ...mounts,
    endpoint.image, 'sh', '-c',
    `chown 65532:65532 ${documented} ${configured} && chmod 700 ${documented} ${configured}`,
  ]);
  if (prepared.code !== 0) {
    return { passed: false, detail: `the shared fence directory could not be prepared: ${(prepared.stdout + prepared.stderr).trim().split('\n')[0] ?? ''}` };
  }
  const opened = await probe(endpoint, { user: API_UID, args: ['fence-only', documented, `restore-runbook-${RUN}`], mounts: restoreMount }, io);
  if (opened.code !== 0) {
    return { passed: false, detail: `the fence of the runbook could not be opened: ${(opened.stdout + opened.stderr).trim().split('\n').slice(0, 2).join(' | ')}` };
  }
  // The service reads the fence from a read-only mount, the way the API
  // container reads it.
  const readable = ['--mount', `type=volume,source=${paths.apiVolume},target=${configured},readonly`];
  const state = await probe(endpoint, { user: API_UID, args: ['state', configured], mounts: readable }, io);
  const open = state.code === 3 && /open/i.test(state.stdout);
  return {
    passed: open,
    detail: open
      ? `the service reads the fence the runbook opens (${configured})`
      : `the service reads no fence at ${configured} while the runbook opens ${documented}`,
  };
}

/**
 * Proves the access.
 * @param {{keep?: boolean, databaseUrl?: string, container?: string, io?: typeof run}} [options]
 */
export async function verifyFenceAccess(options = {}) {
  const io = options.io ?? run;
  /** @type {{id: string, passed: boolean, detail: string}[]} */
  const steps = [];
  /** @type {string[]} */
  const logs = [];
  const containers = [];
  const volumes = [];
  const databases = [];
  let target = null;
  /** @type {{image: string, network: string, host: string}|null} */
  let endpoint;
  let schema = null;

  try {
    const resolved = resolveTarget(options);
    if (!resolved.ok) {
      steps.push({ id: 'the-target-of-the-proof-is-accepted', passed: false, detail: resolved.detail });
      return { steps, logs, limits: ['the target of the proof was refused'] };
    }
    target = resolved;
    steps.push({
      id: 'the-target-of-the-proof-is-accepted',
      passed: true,
      detail: `the proof runs against the ${target.database} database of the local fixture`,
    });

    endpoint = await fixtureEndpoint(String(target.container), io);

    // The published port is checked before anything is created, so a wrong
    // configuration never leaves a volume or a build behind.
    const published = await io('docker', ['port', String(target.container), '5432/tcp']);
    const publishedPort = (published.stdout || '').trim().split('\n')[0]?.split(':').pop() ?? '';
    if (!publishedPort || publishedPort !== target.url.port) {
      steps.push({
        id: 'the-target-addresses-the-published-port',
        passed: false,
        detail: 'the target of the proof does not address the published port of the container',
      });
      return { steps, logs, limits: ['the target of the proof does not address the fixture'] };
    }
    steps.push({
      id: 'the-target-addresses-the-published-port',
      passed: true,
      detail: `the target and the container agree on the port ${publishedPort}`,
    });

    // The runbook, the deployment note and the rendered configuration have to
    // name the same fence. A restore that holds a fence the service never
    // reads leaves the service serving during the import.
    const paths = await deploymentFencePaths(io);
    const agreement = fencePathAgreement({
      documented: paths.documented,
      compose: paths.postgres,
      readme: paths.readme,
    });
    const servicesAgree = paths.api.length > 0 && paths.api === paths.postgres;
    steps.push({
      id: 'the-runbook-and-the-configuration-name-the-same-fence',
      passed: agreement.ok && servicesAgree,
      detail: agreement.ok && servicesAgree
        ? agreement.detail
        : `${agreement.detail}${paths.detail ? ` (${paths.detail})` : ''}${paths.api && paths.postgres && !servicesAgree ? `; the api service names ${paths.api} and the database service names ${paths.postgres}` : ''}`,
    });

    await mkdir(DIRECTORY, { recursive: true });
    const created = await io('docker', ['volume', 'create', `--label=kamkmchess.ops.fence=${RUN}`, VOLUME]);
    if (created.code !== 0) throw new Error(`the volume of the run could not be created: ${created.stderr.trim()}`);
    volumes.push(VOLUME);

    // The service reads its own volume. When the two paths of the
    // deployment are the same, the service reads the volume of the restore,
    // because that is what the deployment mounts.
    const apiVolume = paths.documented && paths.documented === paths.postgres ? VOLUME : `${VOLUME}-api`;
    if (apiVolume !== VOLUME) {
      const createdApi = await io('docker', ['volume', 'create', `--label=kamkmchess.ops.fence=${RUN}`, apiVolume]);
      if (createdApi.code !== 0) throw new Error(`the volume of the service could not be created: ${createdApi.stderr.trim()}`);
      volumes.push(apiVolume);
    }

    // The fence the runbook opens and the fence the service reads are
    // measured, not assumed. The helper is built first, because the
    // measurement runs the real fence code.
    const built = await io('go', ['build', '-trimpath', '-tags', 'fenceprobe', '-o', join(DIRECTORY, 'fenceprobe'), './tools/fenceprobe'], {
      env: { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' },
    });
    if (built.code !== 0) throw new Error('the fence helper could not be built');

    const measured = await measureFence(io, endpoint, {
      documented: paths.documented,
      configured: paths.postgres,
      apiVolume,
    });
    steps.push({
      id: 'the-service-reads-the-fence-the-runbook-opens',
      passed: measured.passed,
      detail: measured.detail,
    });

    // The shared directory belongs to the user of the service, the way the
    // compose entrypoint of the deployment prepares it.
    const prepared = await io('docker', [
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

    // The database user may not write the fence of that directory.
    const refused = await helper(endpoint, DATABASE_UID, ['fence-only', `/backups/fence-${RUN}`, `restore-database-user-${RUN}`], false, io);
    logs.push(`database user: ${(refused.stdout + refused.stderr).trim()}`);
    steps.push({
      id: 'the-database-user-cannot-write-the-fence',
      passed: refused.code !== 0 && /permission denied/i.test(refused.stderr + refused.stdout),
      detail: refused.code !== 0 ? `the database user was refused: ${(refused.stderr + refused.stdout).trim().split('\n').slice(-1)[0] ?? ''}` : 'the database user was allowed to write the fence',
    });

    // The service takes the fence and holds it, and the same process closes it
    // and serves again.
    const databaseUrl = holderDatabaseUrl(target.url);
    const holder = await helper(endpoint, API_UID, ['serve', `/backups/fence-${RUN}`, databaseUrl, '8099', `restore-holder-${RUN}`], true, io);
    if (holder.code === 0 && holder.stdout.trim()) containers.push(holder.stdout.trim());
    let holderLog = '';
    if (holder.code === 0) {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const collected = await io('docker', ['logs', holder.stdout.trim()]);
        holderLog = `${collected.stdout}${collected.stderr}`.trim();
        if (holderLog.includes('serving')) break;
        const alive = await io('docker', ['inspect', '--format', '{{.State.Running}}', holder.stdout.trim()]);
        if (alive.code !== 0 || alive.stdout.trim() !== 'true') break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
      }
    }
    logs.push(`holder: ${holderLog}`);

    // The schema of the helper belongs to this run. The name the helper
    // writes is checked against the name this run owns, so a name of another
    // run is never dropped.
    const named = await io('docker', [
      'run', '--rm', '--network', endpoint.network,
      '--mount', `type=bind,source=${DIRECTORY},target=/fixtures`,
      endpoint.image, 'sh', '-c', 'cat /fixtures/schema-name 2>/dev/null',
    ]);
    const observed = (named.stdout || '').trim();
    schema = ownedSchemaName(observed);
    steps.push({
      id: 'the-schema-of-the-run-is-owned',
      passed: schema !== null,
      detail: schema !== null
        ? `the helper named its schema ${schema}, and the name belongs to this run`
        : `the helper named ${observed || 'no schema'} instead of ${RUN_SCHEMA}, so the proof does not touch it`,
    });

    const marker = await io('docker', [
      'run', '--rm', '--network', endpoint.network,
      '--mount', `type=volume,source=${VOLUME},target=/backups`,
      endpoint.image, 'sh', '-c', `test -e /backups/fence-${RUN}/restore-fence/owner && echo open || echo closed`,
    ]);
    steps.push({
      id: 'the-service-takes-the-fence',
      passed: marker.stdout.trim() === 'open',
      detail: marker.stdout.trim() === 'open' ? 'the marker of the lifecycle is there' : `the marker state is ${marker.stdout.trim() || 'unknown'}`,
    });

    const port = holder.code === 0
      ? (await io('docker', ['port', holder.stdout.trim(), '8099/tcp'])).stdout.trim().split('\n')[0]?.split(':').pop() ?? ''
      : '';

    if (!port) {
      steps.push({ id: 'the-service-refuses-while-the-fence-is-held', passed: false, detail: 'the service published no port' });
      steps.push({ id: 'the-service-serves-again-after-the-fence-is-closed', passed: false, detail: 'the service published no port' });
      return { steps, logs, limits: ['the service that holds the fence did not publish a port'] };
    }

    const refusedTraffic = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null);
    steps.push({
      id: 'the-service-refuses-while-the-fence-is-held',
      passed: refusedTraffic !== null && refusedTraffic.status === 503,
      detail: refusedTraffic !== null ? `the gate answered ${refusedTraffic.status} while the fence was held` : 'the gate did not answer',
    });

    // The same process closes the fence and serves again.
    const finished = await fetch(`http://127.0.0.1:${port}/finish`).catch(() => null);
    const served = finished !== null && finished.status === 200
      ? await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null)
      : null;
    steps.push({
      id: 'the-service-serves-again-after-the-fence-is-closed',
      passed: served !== null && served.status === 200,
      detail: finished !== null
        ? `the close answered ${finished.status} and the gate answered ${served !== null ? served.status : 'nothing'}`
        : 'the close was not answered',
    });

    // The holder is stopped here; the schema of the run is dropped in the
    // guarded section, so a run that stopped early leaves nothing behind
    // either.
    for (const id of containers) {
      const stopped = await io('docker', ['stop', '--time', '10', id]);
      if (stopped.code !== 0 && !/no such container/i.test(stopped.stderr)) {
        steps.push({ id: 'the-holder-is-stopped', passed: false, detail: `the holder could not be stopped: ${stopped.stderr.trim()}` });
      }
    }

    return {
      steps,
      logs,
      limits: [
        'The proof runs against the local fixture container, not against the deployment host.',
      ],
    };
  } catch (error) {
    // A failure of the proof is a result and not a crash: the report names
    // the step that failed, and the exit code refuses the run.
    steps.push({
      id: 'the-proof-failed',
      passed: false,
      detail: `the proof stopped: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { steps, logs, limits: ['the proof stopped with an error'] };
  } finally {
    const plan = planCleanup({
      keep: options.keep === true,
      containers,
      databases,
      volumes,
      directory: DIRECTORY,
      logs,
      container: target?.container,
      schema: schema ?? RUN_SCHEMA,
      schemaKept: options.keep === true,
      target: target ? `${target.container}/${target.database}` : null,
    });
    for (const id of plan.removeContainers) {
      const removed = await io('docker', ['rm', '--force', id]);
      if (removed.code !== 0 && !/no such container/i.test(removed.stderr)) {
        steps.push({ id: 'the-holder-is-removed', passed: false, detail: `the container ${id} could not be removed: ${removed.stderr.trim()}` });
      }
    }
    // The schema of this run is dropped in the selected target, and only
    // this run's schema: the name is the one the run owns. With the keep
    // option the schema stays, so it can be inspected, and the manifest says
    // so.
    if (!plan.keep && target) {
      const name = RUN_SCHEMA;
      const user = String(target.url.username || 'postgres');
      const present = await io('docker', [
        'exec', '-i', String(target.container), 'psql', '-U', user, '-d', String(target.database),
        '-At', '-c', `SELECT count(*) FROM pg_namespace WHERE nspname = '${name}'`,
      ]);
      const remaining = (present.stdout || '').trim();
      if (present.code === 0 && remaining === '0') {
        steps.push({ id: 'the-schema-of-the-run-is-dropped', passed: true, detail: `the schema ${name} of the run is not in the target` });
      } else if (present.code !== 0) {
        steps.push({ id: 'the-schema-of-the-run-is-dropped', passed: false, detail: `the schema ${name} could not be looked up: ${present.stderr.trim()}` });
      } else {
        const dropped = await io('docker', [
          'exec', '-i', String(target.container), 'psql', '-U', user, '-d', String(target.database),
          '-c', `DROP SCHEMA IF EXISTS ${name} CASCADE`,
        ]);
        const gone = await io('docker', [
          'exec', '-i', String(target.container), 'psql', '-U', user, '-d', String(target.database),
          '-At', '-c', `SELECT count(*) FROM pg_namespace WHERE nspname = '${name}'`,
        ]);
        steps.push({
          id: 'the-schema-of-the-run-is-dropped',
          passed: dropped.code === 0 && (gone.stdout || '').trim() === '0',
          detail: dropped.code === 0
            ? `the schema ${name} of the run is gone from the target`
            : `the schema ${name} could not be dropped: ${dropped.stderr.trim()}`,
        });
      }
    } else if (plan.keep) {
      steps.push({ id: 'the-schema-of-the-run-is-kept', passed: true, detail: `the schema ${RUN_SCHEMA} of the run is kept for inspection, and the manifest names it` });
    }
    for (const volume of plan.removeVolumes) {
      const removed = await io('docker', ['volume', 'rm', '--force', volume]);
      if (removed.code !== 0) {
        steps.push({ id: 'the-probe-volume-is-removed', passed: false, detail: `the volume ${volume} could not be removed: ${removed.stderr.trim()}` });
      }
    }
    if (plan.keep && volumes.length > 0) {
      // The resources of the run stay, and the manifest names exactly what
      // they are, so an operator can remove them.
      await mkdir(DIRECTORY, { recursive: true });
      await writeFile(join(DIRECTORY, 'manifest.json'), `${JSON.stringify(plan.manifest, null, 2)}\n`, 'utf8');
    }
    if (plan.removeDirectory && volumes.length > 0) {
      await rm(DIRECTORY, { recursive: true, force: true });
    }
    // The secret of the target is never written to the report.
    if (target?.url) {
      for (const step of steps) step.detail = redact(step.detail, target.url);
      for (let index = 0; index < logs.length; index += 1) logs[index] = redact(logs[index], target.url);
    }
  }
}

/**
 * The exit code of the proof.
 * @param {{passed: boolean}[]} steps
 * @returns {number}
 */
export function proofExitCode(steps) {
  return steps.some((step) => !step.passed) ? 1 : 0;
}

/**
 * The target the command line asks for.
 *
 * The container and the database url come from the environment, so an
 * operator can point the proof at another fixture without changing the
 * proof. The explicit options win over the environment.
 * @param {Record<string, string | undefined>} [environment]
 * @param {{databaseUrl?: string, container?: string}} [options]
 * @returns {{databaseUrl?: string, container?: string}}
 */
export function targetFromEnvironment(environment = process.env, options = {}) {
  /** @type {{databaseUrl?: string, container?: string}} */
  const target = {};
  const container = options.container ?? environment.ONLINE_FIXTURE_CONTAINER;
  const databaseUrl = options.databaseUrl ?? environment.ONLINE_FIXTURE_DATABASE_URL;
  if (container) target.container = container;
  if (databaseUrl) target.databaseUrl = databaseUrl;
  return target;
}

async function main() {
  const report = await verifyFenceAccess({
    keep: process.argv.includes('--keep'),
    ...targetFromEnvironment(process.env),
  });
  process.exitCode = proofExitCode(report.steps);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ tool: 'deploy/verify-fence-access.mjs', ...report }, null, 2)}\n`);
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

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('deploy/verify-fence-access.mjs')) {
  await main();
}
