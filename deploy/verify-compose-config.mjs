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
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/**
 * @param {string[]} args
 * @param {{cwd?: string}} [options]
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
    child.stdin.end();
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
 * Starts a compose project and reads the settings of the running server.
 *
 * The start happens inside the guarded section, so a project that fails
 * halfway is still removed.
 * @param {string} root
 * @param {string} directory
 * @param {string} project
 * @returns {Promise<{code: number, settings: Record<string, string>, output: string, ready: boolean, cleanup: string}>}
 */
async function readServerSettings(root, directory, project) {
  /** @type {{code: number, settings: Record<string, string>, output: string, ready: boolean, cleanup: string}} */
  const result = { code: 0, settings: {}, output: '', ready: false, cleanup: '', secret: null };
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
 * @returns {Promise<{code: number, output: string}>}
 */
async function prepare(root, directory, broken, helperImage) {
  await cp(join(root, 'deploy', 'postgres.compose.yml'), join(directory, 'postgres.compose.yml'));
  await cp(join(root, 'deploy', 'pg_hba.conf'), join(directory, 'pg_hba.conf'));
  // The compose file reads its secrets from a file that only exists on the
  // server. The rendering needs a placeholder, never a real credential.
  await writeFile(join(directory, 'postgres.env'), 'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=fixture-only\nPOSTGRES_DB=kamkmchess\n', 'utf8');
  // The private file of the restore carries the passphrase and the database
  // url, both placeholders: a rendering and a measurement never need a real
  // credential.
  await writeFile(join(directory, 'backup.env'), 'KHA_BACKUP_PASSPHRASE=fixture-only\nDATABASE_URL=postgres://kamkmchess_migrator:fixture-only@127.0.0.1:5432/kamkmchess?sslmode=require\n', 'utf8');

  // The reviewed configuration mounts a certificate and its key. The image
  // has no openssl, so the helper writes one.
  const certificate = await run('docker', [
    'run', '--rm', '--user', 'root:0',
    '--mount', `type=bind,source=${join(directory, 'tls')},target=/tls`,
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

    const current = await readServerSettings(root, directory, project);
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
        const broken = await readServerSettings(root, brokenDirectory, brokenProject);
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
      await rm(brokenDirectory, { recursive: true, force: true });
    }
    return { steps, settings: current.settings };
  } finally {
    // The resources of this run are removed even when a step failed, and the
    // removal of the helper image is checked.
    const leftovers = await cleanupProject(root, directory, project);
    if (leftovers) {
      steps.push({ id: 'the-run-left-nothing-behind', passed: false, detail: leftovers });
    }
    await rm(directory, { recursive: true, force: true });
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
