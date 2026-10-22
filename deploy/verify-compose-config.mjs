// Proves that the database configuration still reaches PostgreSQL.
//
// The compose file prepares the shared fence directory before the database
// starts, so it overrides the entrypoint of the image. The command arguments
// have to survive that override, or the database would start without TLS, the
// reviewed host authentication file, the password encryption or the memory
// settings.
//
// The proof starts the **actual compose service** with a throwaway
// configuration, so the entrypoint and the command are the rendered ones, and
// then asks the **running server** for its settings.
//
// Safety: the compose file carries a fixed project name, so every call names
// a **random project** explicitly. The proof therefore never touches the
// containers, the volumes or the network of a running deployment, and it
// removes every resource of its own project, even when the start failed
// halfway.
//
// The proof also runs the previous entrypoint, the one that dropped the
// arguments, and shows that the server then starts with the wrong settings.
// The broken server has to start and answer, otherwise the comparison would
// prove nothing. A proof that cannot fail is not a proof.
//
// Usage:
//   node deploy/verify-compose-config.mjs [--json]

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/**
 * @param {string[]} args
 * @param {{cwd?: string, stdin?: string}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: options.cwd ?? process.cwd(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolvePromise({ code: -1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * The settings the reviewed configuration has to produce.
 */
const EXPECTED = {
  ssl: 'on',
  hba_file: '/etc/postgresql/pg_hba.conf',
  password_encryption: 'scram-sha-256',
  max_connections: '60',
  shared_buffers: '128MB',
};

/**
 * Removes every resource of one compose project.
 *
 * The project name is random, so the removal cannot reach a deployment. The
 * volumes and the network are removed by label as well, because a failed
 * start can leave them behind.
 * @param {string} root
 * @param {string} directory
 * @param {string} project
 * @returns {Promise<string>} the problems of the removal, empty when it was clean
 */
async function cleanupProject(root, directory, project) {
  /** @type {string[]} */
  const problems = [];
  const compose = ['compose', '--project-name', project, '-f', join(directory, 'postgres.compose.yml')];
  const down = await run('docker', [...compose, 'down', '--volumes', '--remove-orphans'], { cwd: root });
  if (down.code !== 0) {
    problems.push(`the project did not stop cleanly: ${(down.stdout + down.stderr).trim().split('\n').slice(-1)[0] ?? ''}`);
  }
  for (const kind of ['volume', 'network']) {
    const listed = await run('docker', [kind, 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}']);
    if (listed.code !== 0) {
      problems.push(`the ${kind}s of the project could not be listed: ${(listed.stdout + listed.stderr).trim()}`);
      continue;
    }
    for (const name of listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      const removed = await run('docker', [kind, 'rm', '--force', name]);
      if (removed.code !== 0) {
        problems.push(`the ${kind} ${name} could not be removed: ${(removed.stdout + removed.stderr).trim()}`);
      }
    }
  }
  return problems.join(' | ');
}

/**
 * Removes a throwaway directory even when a container wrote a root-owned
 * bind-mounted path into it. The proof intentionally runs its service as
 * root, while the CI runner owns the temporary directory, so a plain
 * fs.rm() can otherwise fail on the evidence directory.
 * @param {string} root
 * @param {string} directory
 * @param {string} helperImage
 * @returns {Promise<string>} an error description, or an empty string
 */
async function removeThrowawayDirectory(root, directory, helperImage) {
  try {
    await rm(directory, { recursive: true, force: true });
    return '';
  } catch (error) {
    const cleanup = await run('docker', [
      'run', '--rm', '--user', '0:0', '--entrypoint', '/bin/sh',
      '--mount', `type=bind,source=${directory},target=/cleanup`,
      helperImage, '-c', 'rm -rf /cleanup/* /cleanup/.[!.]* /cleanup/..?*',
    ], { cwd: root });
    if (cleanup.code === 0) {
      try {
        await rm(directory, { recursive: true, force: true });
        return '';
      } catch (retryError) {
        return `the throwaway directory could not be removed after root cleanup: ${retryError instanceof Error ? retryError.message : String(retryError)}`;
      }
    }
    return `the throwaway directory could not be removed: ${error instanceof Error ? error.message : String(error)}; root cleanup failed: ${(cleanup.stdout + cleanup.stderr).trim()}`;
  }
}

/**
 * Measures the reading of the private secret file.
 *
 * The file of the deployment is owned by the operator and has mode 0600, so
 * the restore user cannot read it. The documented command therefore reads it
 * as root and hands the values to the restore through the environment. The
 * measurement runs inside the container, on a copy of the file, so the mode
 * and the owner are the ones of Linux and not the ones of the host of the
 * proof.
 * @param {string} root
 * @param {string} directory
 * @param {string} project
 * @returns {Promise<{prepared: string, refused: string, handed: string, mode: string, gosu: string}>}
 */
async function measureSecret(root, directory, project) {
  const compose = ['compose', '--project-name', project, '-f', join(directory, 'postgres.compose.yml')];
  const inside = '/var/lib/kamkmchess/restore-secret.env';
  const exec = async (user, script) => {
    const result = await run('docker', [...compose, 'exec', '-T', '--user', user, 'postgres', 'sh', '-c', script], { cwd: root });
    return `${result.code}:${(result.stdout + result.stderr).trim()}`;
  };
  const prepared = await exec('root', `cp /run/secrets/backup.env ${inside} && chown 0:0 ${inside} && chmod 600 ${inside}`);
  // The negative control: the restore user cannot read the file.
  const refused = await exec('65532:65532', `set -a; . ${inside}; set +a`);
  // The documented reading side: root reads the file, the restore user
  // receives the values in its environment.
  const handed = await exec('root', `set -a; . ${inside}; set +a; exec gosu 65532:65532 sh -c 'test -n "$DATABASE_URL" && test -n "$KHA_BACKUP_PASSPHRASE"'`);
  const mode = await exec('root', `stat -c '%a %u' ${inside}`);
  const gosu = await exec('root', 'command -v gosu');
  return { prepared, refused, handed, mode, gosu };
}

/**
 * Measures the durable path of the protected copy of the durable evidence.
 *
 * The copy of the evidence of a restore has to survive the loss of the
 * evidence directory, so it is written onto a mounted path and it is covered
 * by the backup of the deployment. The measurement runs inside the real
 * service container with the real program of the repository, and it reads the
 * outcome from the host as well: a file that is visible outside the container
 * is on a mounted path, and a file that is not is in the writable layer of the
 * container and dies with it.
 *
 * The lock of the lifecycle is measured as well, because a copy that is made
 * while a restore is running can be a half written record.
 * @param {string} root
 * @param {string} directory
 * @param {string} project
 * @param {string} helperImage
 * @returns {Promise<{staged: string, copied: string, directory: string, record: string, lock: string, host: string, refused: string, held: string}>}
 */
async function measureDurableEvidence(root, directory, project, helperImage) {
  const compose = ['compose', '--project-name', project, '-f', join(directory, 'postgres.compose.yml')];
  const fence = '/var/lib/kamkmchess/restore-fence';
  const destination = '/backups/restore-evidence';
  const record = 'restore-proof-000000';
  const exec = async (script, options = {}) => {
    const result = await run('docker', [...compose, 'exec', '-T', ...(options.user ? ['--user', options.user] : []), 'postgres', 'sh', '-c', script], { cwd: root });
    return { code: result.code, text: `${result.stdout}${result.stderr}`.trim() };
  };
  // The record of the owed ledger is staged by the user that owns the
  // lifecycle, the way the restore writes it.
  const staged = await exec(
    `install -d -m 700 ${fence}/restore-requirements && install -m 600 /dev/null ${fence}/restore-requirements/${record}.json`,
    { user: '65532:65532' },
  );
  const copied = await exec(`sh /opt/kamkmchess-operator/copy-restore-evidence.sh ${destination}`);
  const modes = await exec(`stat -c '%a %u' ${destination} ${destination}/${record}.json ${fence}/restore-fence.lock`);
  // The outcome on the host: the file is on the mounted path of the backup
  // directory, so it survives the recreation of the container. The directory
  // is intentionally private to uid 65532, so the CI runner cannot inspect it
  // directly. Read it through a root helper container with the same bind mount.
  const hostCheck = await run('docker', [
    'run', '--rm', '--user', '0:0', '--entrypoint', '/bin/sh',
    '--mount', `type=bind,source=${join(directory, 'backups', 'restore-evidence')},target=/evidence,readonly`,
    helperImage, '-c', 'ls -1A /evidence',
  ], { cwd: root });
  const host = hostCheck.code === 0
    ? hostCheck.stdout.trim()
    : `unreadable: ${(hostCheck.stdout + hostCheck.stderr).trim()}`;
  // The negative control: while a restore holds the lock of the lifecycle,
  // the copy is refused.
  const holder = await run('docker', [...compose, 'exec', '-d', '-T', '--user', '65532:65532', 'postgres', 'sh', '-c', `exec 9>"${fence}/restore-fence.lock"; flock 9; sleep 60`], { cwd: root });
  let held = '';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const probe = await exec(`flock -n ${fence}/restore-fence.lock true`, { user: '65532:65532' });
    if (probe.code !== 0) {
      held = 'the lock of the lifecycle is held';
      break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  const refused = await exec(`sh /opt/kamkmchess-operator/copy-restore-evidence.sh ${destination}`);
  // The failure that is not a running restore: the destination cannot be
  // created, so the copy fails with its own reason and its own exit code.
  const failed = await exec(`sh /opt/kamkmchess-operator/copy-restore-evidence.sh /proc/restore-evidence`);
  // The lock itself cannot be opened: the file of the lock is a directory.
  // That is a failure of the lock and never a running restore.
  const brokenFence = await exec('mkdir -p /tmp/fence-broken/restore-fence.lock');
  const lockFailed = await run('docker', [
    ...compose, 'exec', '-T', '-e', 'ONLINE_RESTORE_FENCE_PATH=/tmp/fence-broken',
    'postgres', 'sh', '/opt/kamkmchess-operator/copy-restore-evidence.sh', destination,
  ], { cwd: root });
  return {
    staged: `${staged.code}:${staged.text}`,
    copied: `${copied.code}:${copied.text}`,
    directory: modes.text.split('\n')[0] ?? '',
    record: modes.text.split('\n')[1] ?? '',
    lock: modes.text.split('\n')[2] ?? '',
    host,
    refused: `${refused.code}:${refused.text}`,
    failed: `${failed.code}:${failed.text}`,
    lockFailed: `${brokenFence.code === 0 ? lockFailed.code : -1}:${`${lockFailed.stdout}${lockFailed.stderr}`.trim()}`,
    held: held || holder.stderr.trim(),
  };
}

/**
 * Measures the procedure that reads the identifier of the restore.
 *
 * The identifier becomes the name of a file, so the procedure that reads it
 * has to refuse everything the production rule refuses. The measurement runs
 * the real program of the repository inside the real service container.
 * @param {string} root
 * @param {string} directory
 * @param {string} project
 * @returns {Promise<{accepted: string, refused: string}>}
 */
async function measureRestoreIdentifier(root, directory, project) {
  const compose = ['compose', '--project-name', project, '-f', join(directory, 'postgres.compose.yml')];
  const exec = async (script) => {
    const result = await run('docker', [...compose, 'exec', '-T', 'postgres', 'sh', '-c', script], { cwd: root });
    return { code: result.code, text: `${result.stdout}${result.stderr}`.trim() };
  };
  const write = async (name, content) => exec(`printf '%s' '${content}' > /tmp/${name}`);
  const check = async (name) => exec(`sh /opt/kamkmchess-operator/check-restore-id.sh /tmp/${name}`);
  const accepted = 'restore-20261021T165057Z-2e2840f3d33b';
  await write('marker-accepted.json', `{"restoreId":"${accepted}","expectedLedgerDigest":"${'0'.repeat(64)}"}`);
  await write('marker-dot.json', '{"restoreId":".hidden-restore-name"}');
  await write('marker-short.json', '{"restoreId":"short12"}');
  await write('marker-long.json', `{"restoreId":"${'a'.repeat(129)}"}`);
  await write('marker-separator.json', '{"restoreId":"restore/../../etc/passwd"}');
  const good = await check('marker-accepted.json');
  const refusals = [];
  for (const name of ['marker-dot.json', 'marker-short.json', 'marker-long.json', 'marker-separator.json']) {
    refusals.push(await check(name));
  }
  return {
    accepted: `${good.code}:${good.text}`,
    refused: refusals.map((entry) => `${entry.code}:${entry.text}`).join(' | '),
  };
}

/**
 * Starts a compose project and reads the settings of the running server.
 *
 * The start happens inside the guarded section, so a project that fails
 * halfway is still removed.
 * @param {string} root
 * @param {string} directory
 * @param {string} project
 * @param {string} helperImage
 * @returns {Promise<{code: number, settings: Record<string, string>, output: string, ready: boolean, cleanup: string}>}
 */
async function readServerSettings(root, directory, project, helperImage) {
  /** @type {{code: number, settings: Record<string, string>, output: string, ready: boolean, cleanup: string}} */
  const result = { code: 0, settings: {}, output: '', ready: false, cleanup: '', secret: null, durable: null, identifier: null };
  const compose = ['compose', '--project-name', project, '-f', join(directory, 'postgres.compose.yml')];
  try {
    const up = await run('docker', [...compose, 'up', '--detach'], { cwd: root });
    if (up.code !== 0) {
      result.code = up.code;
      result.output = `the service did not start: ${(up.stdout + up.stderr).trim()}`;
      return result;
    }
    // The service is polled until it accepts a connection, because the first
    // start initialises the data directory.
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const probe = await run('docker', [...compose, 'exec', '-T', '--user', 'postgres', 'postgres', 'pg_isready', '-U', 'postgres'], { cwd: root });
      if (probe.code === 0) {
        // The readiness has to hold, because a server that is still starting
        // answers a query with a transient error.
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
        const again = await run('docker', [...compose, 'exec', '-T', '--user', 'postgres', 'postgres', 'pg_isready', '-U', 'postgres'], { cwd: root });
        if (again.code === 0) {
          result.ready = true;
          break;
        }
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    }
    if (!result.ready) {
      const logs = await run('docker', [...compose, 'logs', '--tail', '20'], { cwd: root });
      result.code = 1;
      result.output = `the service did not become ready: ${(logs.stdout || logs.stderr).trim().split('\n').slice(-3).join(' | ')}`;
      return result;
    }
    for (const name of Object.keys(EXPECTED)) {
      // The service runs as root for the entrypoint, so the query runs as the
      // database user, exactly as an operator would. A server that is still
      // starting answers with a transient error, so the query is retried.
      let value = { code: -1, stdout: '', stderr: '' };
      for (let attempt = 0; attempt < 5; attempt += 1) {
        value = await run('docker', [...compose, 'exec', '-T', '--user', 'postgres', 'postgres', 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c', `SHOW ${name}`], { cwd: root });
        if (value.code === 0) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
      }
      if (value.code !== 0) {
        result.code = value.code;
        result.output = `the setting ${name} could not be read: ${(value.stdout + value.stderr).trim()}`;
        return result;
      }
      result.settings[name] = (value.stdout || '').trim().split('\n').pop() ?? '';
    }
    // The private secret of the restore is measured while the service runs.
    result.secret = await measureSecret(root, directory, project);
    // The durable path of the protected copy of the evidence, and the
    // procedure that reads the identifier of the restore.
    result.durable = await measureDurableEvidence(root, directory, project, helperImage);
    result.identifier = await measureRestoreIdentifier(root, directory, project);
    return result;
  } finally {
    result.cleanup = await cleanupProject(root, directory, project);
  }
}

/**
 * Builds the helper image that writes the certificate of the throwaway
 * service.
 * @param {string} root
 * @returns {Promise<{code: number, image: string, output: string}>}
 */
async function buildHelper(root) {
  const tag = `kamkmchess-fenceprobe:compose-${randomUUID().slice(0, 8)}`;
  const staging = await mkdtemp(join(tmpdir(), 'kamkmchess-fenceprobe-image-'));
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const runBuild = promisify(execFile);
    try {
      await runBuild('go', ['build', '-trimpath', '-tags', 'fenceprobe', '-o', join(staging, 'fenceprobe'), './tools/fenceprobe'], {
        cwd: root,
        env: { ...process.env, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' },
      });
    } catch (error) {
      const failure = /** @type {any} */ (error);
      return { code: 1, image: tag, output: failure.stderr ?? String(failure.message) };
    }
    await writeFile(join(staging, 'Dockerfile'), [
      'FROM postgres:16-alpine',
      'COPY fenceprobe /usr/local/bin/fenceprobe',
      'ENTRYPOINT ["/usr/local/bin/fenceprobe"]',
      '',
    ].join('\n'), 'utf8');
    const image = await run('docker', ['build', '--tag', tag, staging]);
    return { code: image.code, image: tag, output: image.stderr };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Prepares a throwaway deployment directory with the reviewed configuration.
 * @param {string} root
 * @param {string} directory
 * @param {boolean} broken use the entrypoint that drops the arguments
 * @param {string} helperImage
 * @param {(command: string, args: string[], options?: {cwd?: string, stdin?: string}) => Promise<{code: number, stdout: string, stderr: string}>} [runCommand] the runner of the commands
 * @returns {Promise<{code: number, output: string}>}
 */
export async function prepare(root, directory, broken, helperImage, runCommand = run) {
  await cp(join(root, 'deploy', 'postgres.compose.yml'), join(directory, 'postgres.compose.yml'));
  await cp(join(root, 'deploy', 'pg_hba.conf'), join(directory, 'pg_hba.conf'));
  // The operator programs of the deployment are measured inside the real
  // service container, so the throwaway deployment carries the very files of
  // the repository. The compose file mounts them into the container.
  await cp(join(root, 'deploy', 'check-restore-id.sh'), join(directory, 'check-restore-id.sh'));
  await cp(join(root, 'deploy', 'copy-restore-evidence.sh'), join(directory, 'copy-restore-evidence.sh'));
  // The compose file reads its secrets from a file that only exists on the
  // server. The rendering needs a placeholder, never a real credential.
  await writeFile(join(directory, 'postgres.env'), 'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=fixture-only\nPOSTGRES_DB=kamkmchess\n', 'utf8');
  // The private file of the restore carries the passphrase and the database
  // url, both placeholders: a rendering and a measurement never need a real
  // credential.
  await writeFile(join(directory, 'backup.env'), 'KHA_BACKUP_PASSPHRASE=fixture-only\nDATABASE_URL=postgres://kamkmchess_migrator:fixture-only@127.0.0.1:5432/kamkmchess?sslmode=require\n', 'utf8');

  // The reviewed configuration mounts a certificate and its key. The image
  // has no openssl, so the helper writes one.
  //
  // The directory of the mount has to exist before the helper is started: a
  // bind mount of a path that does not exist is refused by the engine, so the
  // certificate of the proof would never be written.
  const tlsDirectory = join(directory, 'tls');
  await mkdir(tlsDirectory, { recursive: true });
  const certificate = await runCommand('docker', [
    'run', '--rm', '--user', 'root:0',
    '--mount', `type=bind,source=${tlsDirectory},target=/tls`,
    helperImage, 'cert', '/tls',
  ]);
  if (certificate.code !== 0) {
    return { code: certificate.code, output: `the certificate could not be written: ${(certificate.stdout + certificate.stderr).trim()}` };
  }

  if (broken) {
    // The entrypoint of the round-five candidate: it prepares the directory
    // and then starts the database with a fixed command, so the configured
    // arguments never reach PostgreSQL.
    const composePath = join(directory, 'postgres.compose.yml');
    const composed = (await readFile(composePath, 'utf8')).replace(/\r\n/g, '\n');
    const start = composed.indexOf('    entrypoint:');
    const end = composed.indexOf('      - --', start);
    if (start < 0 || end < 0) throw new Error('the compose entrypoint could not be read');
    const replaced = composed.slice(0, start) + [
      '    entrypoint:',
      '      - /bin/sh',
      '      - -c',
      '      - >-',
      '        mkdir -p /var/lib/kamkmchess/restore-fence &&',
      '        chown 65532:65532 /var/lib/kamkmchess/restore-fence &&',
      '        chmod 700 /var/lib/kamkmchess/restore-fence &&',
      '        exec docker-entrypoint.sh postgres',
      '',
    ].join('\n') + composed.slice(end + '      - --\n'.length);
    await writeFile(composePath, replaced, 'utf8');
  }
  return { code: 0, output: '' };
}

/**
 * Proves the configuration.
 * @param {string} root
 * @returns {Promise<{steps: {id: string, passed: boolean, detail: string}[], settings: Record<string, string>}>}
 */
export async function verifyComposeConfig(root) {
  /** @type {{id: string, passed: boolean, detail: string}[]} */
  const steps = [];
  const helper = await buildHelper(root);
  if (helper.code !== 0) {
    steps.push({ id: 'the-helper-image-exists', passed: false, detail: `the helper image could not be built: ${helper.output.trim().split('\n').slice(-1)[0] ?? ''}` });
    return { steps, settings: {} };
  }
  steps.push({ id: 'the-helper-image-exists', passed: true, detail: 'the helper image was built for this run' });

  const directory = await mkdtemp(join(tmpdir(), 'kamkmchess-compose-'));
  const project = `kamkmchess-compose-${randomUUID().slice(0, 12)}`;
  try {
    const prepared = await prepare(root, directory, false, helper.image);
    steps.push({
      id: 'the-throwaway-configuration-is-complete',
      passed: prepared.code === 0,
      detail: prepared.code === 0 ? 'the throwaway configuration carries the certificate and the placeholders' : prepared.output,
    });
    if (prepared.code !== 0) return { steps, settings: {} };

    const current = await readServerSettings(root, directory, project, helper.image);
    const mismatched = Object.entries(EXPECTED).filter(([name, value]) => current.settings[name] !== value);
    steps.push({
      id: 'the-database-keeps-its-settings',
      passed: current.code === 0 && mismatched.length === 0,
      detail: current.code === 0 && mismatched.length === 0
        ? 'the running server has the reviewed settings'
        : `the running server differs: ${mismatched.map(([name, value]) => `${name}=${current.settings[name] || 'unknown'} instead of ${value}`).join(', ')}${current.output ? ` (${current.output.split('\n').slice(-1)[0]})` : ''}`,
    });
    steps.push({
      id: 'the-settings-are-read-from-the-running-server',
      passed: current.code === 0 && Object.keys(current.settings).length === Object.keys(EXPECTED).length,
      detail: `the settings were read from the running server: ${JSON.stringify(current.settings)}`,
    });
    // The private secret of the restore: the file stays private, the restore
    // user cannot read it, and the documented command hands the values to the
    // restore through the environment.
    const secret = current.secret;
    const copied = secret?.prepared?.startsWith('0:') === true;
    const refused = secret?.refused ?? '';
    const handed = secret?.handed ?? '';
    const mode = secret?.mode ?? '';
    const gosu = secret?.gosu ?? '';
    steps.push({
      id: 'the-private-secret-is-prepared-for-the-measurement',
      passed: copied,
      detail: copied ? 'a copy of the secret file carries the mode and the owner of Linux inside the container' : `the copy of the secret file could not be prepared: ${refused}`,
    });
    steps.push({
      id: 'the-restore-user-cannot-read-the-secret-file',
      passed: /^[^0]/.test(refused) && /permission denied/i.test(refused),
      detail: /^[^0]/.test(refused) && /permission denied/i.test(refused)
        ? 'the restore user is refused the private file, so the file has to be read by another user'
        : `the restore user was not refused the private file: ${refused}`,
    });
    steps.push({
      id: 'the-documented-command-hands-the-secret-to-the-restore-user',
      passed: handed.startsWith('0:') && gosu.includes('/gosu'),
      detail: handed.startsWith('0:') && gosu.includes('/gosu')
        ? 'the shell reads the file as root and the restore user receives the values in its environment'
        : `the values did not reach the restore user: ${handed} (gosu: ${gosu})`,
    });
    steps.push({
      id: 'the-secret-file-keeps-its-private-mode',
      passed: mode.startsWith('0:600 0'),
      detail: mode.startsWith('0:600 0')
        ? 'the file is still 0600 and owned by root after the restore command ran'
        : `the file is not private any more: ${mode}`,
    });
    steps.push({
      id: 'the-throwaway-resources-are-removed',
      passed: current.cleanup === '',
      detail: current.cleanup === '' ? 'the containers, the volumes and the network of the project are gone' : current.cleanup,
    });

    // The durable path of the protected copy of the evidence of a restore.
    const durable = current.durable;
    const staged = durable?.staged ?? '';
    const copiedEvidence = durable?.copied ?? '';
    const directoryMode = durable?.directory ?? '';
    const recordMode = durable?.record ?? '';
    const lockMode = durable?.lock ?? '';
    const host = durable?.host ?? '';
    const refusedCopy = durable?.refused ?? '';
    const held = durable?.held ?? '';
    steps.push({
      id: 'the-evidence-of-a-restore-is-copied-onto-a-mounted-path',
      passed: staged.startsWith('0:') && copiedEvidence.startsWith('0:') && host.includes('restore-proof-000000.json'),
      detail: staged.startsWith('0:') && copiedEvidence.startsWith('0:') && host.includes('restore-proof-000000.json')
        ? `the record of the owed ledger was copied into the backup directory of the deployment and the copy is visible outside the container: ${host}`
        : `the evidence was not copied onto a mounted path: staged ${staged}, copied ${copiedEvidence}, host ${host}`,
    });
    steps.push({
      id: 'the-copy-of-the-evidence-is-private',
      passed: /^700 65532$/.test(directoryMode) && /^600 65532$/.test(recordMode),
      detail: /^700 65532$/.test(directoryMode) && /^600 65532$/.test(recordMode)
        ? `the protected copy is private to the user that restores it: the directory is ${directoryMode} and the record is ${recordMode}`
        : `the protected copy is not private: the directory is ${directoryMode || 'unknown'} and the record is ${recordMode || 'unknown'}`,
    });
    steps.push({
      id: 'the-lock-of-the-lifecycle-belongs-to-the-restore-user',
      passed: /^600 65532$/.test(lockMode),
      detail: /^600 65532$/.test(lockMode)
        ? `the lock of the lifecycle was created by the user that owns it (${lockMode}), so the restore can open it`
        : `the lock of the lifecycle carries ${lockMode || 'an unknown mode and owner'} and the restore may not be able to open it`,
    });
    steps.push({
      id: 'the-copy-is-refused-while-a-restore-holds-the-lifecycle',
      passed: held.includes('the lock of the lifecycle is held') && /^75:/.test(refusedCopy) && /holds the lifecycle/i.test(refusedCopy),
      detail: held.includes('the lock of the lifecycle is held') && /^75:/.test(refusedCopy) && /holds the lifecycle/i.test(refusedCopy)
        ? 'a restore holds the lock of the lifecycle and the copy of the evidence is refused with the documented exit code 75, so the copy is never a half written record'
        : `the copy was not refused while the lifecycle was held: ${held || 'the lock was never held'}, ${refusedCopy}`,
    });
    const failedCopy = durable?.failed ?? '';
    steps.push({
      id: 'the-failure-of-the-copy-is-not-reported-as-a-running-restore',
      passed: /^1:/.test(failedCopy) && !/holds the lifecycle/i.test(failedCopy),
      detail: /^1:/.test(failedCopy) && !/holds the lifecycle/i.test(failedCopy)
        ? `a copy that fails for another reason keeps its own reason and its own exit code, so the backup procedure can tell it from a restore that holds the lifecycle: ${failedCopy}`
        : `the failure of the copy was not told apart from a running restore: ${failedCopy}`,
    });
    const lockFailed = durable?.lockFailed ?? '';
    steps.push({
      id: 'the-failure-of-the-lock-is-not-reported-as-a-running-restore',
      passed: /^1:/.test(lockFailed) && /can't create.*restore-fence\.lock.*is a directory/i.test(lockFailed),
      detail: /^1:/.test(lockFailed) && /can't create.*restore-fence\.lock.*is a directory/i.test(lockFailed)
        ? `a lock that cannot be opened fails with its own status and its own message, and it is never reported as a restore that holds the lifecycle: ${lockFailed}`
        : `the failure of the lock was not told apart from a running restore: ${lockFailed}`,
    });
    // The procedure that reads the identifier of the restore.
    const identifier = current.identifier;
    const accepted = identifier?.accepted ?? '';
    const refusedIdentifiers = identifier?.refused ?? '';
    steps.push({
      id: 'the-identifier-of-the-restore-is-read-by-the-production-rule',
      passed: accepted.startsWith('0:') && accepted.includes('restore-20261021T165057Z-2e2840f3d33b'),
      detail: accepted.startsWith('0:') && accepted.includes('restore-20261021T165057Z-2e2840f3d33b')
        ? 'the procedure reads the identifier of the restore out of the marker of the lifecycle'
        : `the procedure did not read the identifier: ${accepted}`,
    });
    steps.push({
      id: 'the-identifier-procedure-refuses-an-unusable-identifier',
      passed: refusedIdentifiers.split(' | ').length === 4
        && refusedIdentifiers.split(' | ').every((entry) => entry.startsWith('1:')),
      detail: refusedIdentifiers.split(' | ').length === 4
        && refusedIdentifiers.split(' | ').every((entry) => entry.startsWith('1:'))
        ? 'the procedure refuses an identifier with a leading dot, one that is too short, one that is too long and one that carries a path separator'
        : `the procedure did not refuse every unusable identifier: ${refusedIdentifiers}`,
    });

    // The proof has to be able to fail: the entrypoint of the round-five
    // candidate dropped the arguments. The broken server has to start and
    // answer, otherwise the comparison would prove nothing.
    const brokenDirectory = await mkdtemp(join(tmpdir(), 'kamkmchess-compose-broken-'));
    const brokenProject = `kamkmchess-compose-broken-${randomUUID().slice(0, 12)}`;
    try {
      const brokenPrepared = await prepare(root, brokenDirectory, true, helper.image);
      if (brokenPrepared.code !== 0) {
        steps.push({ id: 'the-proof-detects-a-dropped-argument', passed: false, detail: brokenPrepared.output });
      } else {
        const broken = await readServerSettings(root, brokenDirectory, brokenProject, helper.image);
        const brokenMismatch = Object.entries(EXPECTED).filter(([name, value]) => broken.settings[name] !== value);
        steps.push({
          id: 'the-proof-detects-a-dropped-argument',
          passed: broken.ready && broken.code === 0 && brokenMismatch.length > 0,
          detail: broken.ready && broken.code === 0 && brokenMismatch.length > 0
            ? `the server started with the previous entrypoint and lost ${brokenMismatch.map(([name]) => name).join(', ')}, so the proof can fail`
            : `the broken variant did not start or answer, so the comparison would prove nothing: ${broken.output}`,
        });
        steps.push({
          id: 'the-broken-resources-are-removed',
          passed: broken.cleanup === '',
          detail: broken.cleanup === '' ? 'the resources of the broken project are gone' : broken.cleanup,
        });
      }
    } finally {
      const removed = await removeThrowawayDirectory(root, brokenDirectory, helper.image);
      if (removed) steps.push({ id: 'the-broken-directory-is-removed', passed: false, detail: removed });
    }
    return { steps, settings: current.settings };
  } finally {
    // The resources of this run are removed even when a step failed, and the
    // removal of the helper image is checked.
    const leftovers = await cleanupProject(root, directory, project);
    if (leftovers) {
      steps.push({ id: 'the-run-left-nothing-behind', passed: false, detail: leftovers });
    }
    const removedDirectory = await removeThrowawayDirectory(root, directory, helper.image);
    if (removedDirectory) {
      steps.push({ id: 'the-run-directory-is-removed', passed: false, detail: removedDirectory });
    }
    const removed = await run('docker', ['image', 'rm', '--force', helper.image]);
    if (removed.code !== 0) {
      steps.push({ id: 'the-helper-image-is-removed', passed: false, detail: `the helper image could not be removed: ${(removed.stdout + removed.stderr).trim()}` });
    }
  }
}

async function main() {
  const report = await verifyComposeConfig(process.cwd());
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      tool: 'deploy/verify-compose-config.mjs',
      disclaimer: 'The compose service runs from a throwaway directory in a throwaway project. Nothing of a running deployment is touched.',
      ...report,
    }, null, 2)}\n`);
  } else {
    for (const step of report.steps) {
      process.stdout.write(`  ${step.passed ? 'PASS' : 'FAIL'} ${step.id}: ${step.detail}\n`);
    }
  }
  if (report.steps.some((step) => !step.passed)) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('deploy/verify-compose-config.mjs')) {
  await main();
}
