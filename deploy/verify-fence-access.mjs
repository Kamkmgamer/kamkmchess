// Proves that the API observes the durable restore fence.
//
// The restore writes the fence inside the database container, the API reads it
// from the shared volume as its own user. When the two cannot read the same
// file, the API refuses every request, and it refuses for the wrong reason:
// it never sees the fence close.
//
// The proof uses the real fence code and the real serving gate of the privacy
// service through the build-tagged fenceprobe helper, the real user of each
// service, the deployment database image and a volume this run creates for
// itself. It shows:
//
//   1. the shared directory belongs to the user the API reads it as;
//   2. the database user cannot write the fence into that directory, so the
//      restore has to run as the API user;
//   3. the API user observes the OPEN fence and the HTTP gate refuses traffic;
//   4. the API user observes the CLOSED fence and the HTTP gate serves again.
//
// Every container exit is checked, the volume carries an owned label and is
// removed only when this run created it, and the helper image tag is unique
// per run.
//
// Usage:
//   node deploy/verify-fence-access.mjs [--json] [--keep]

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const API_UID = '65532:65532';
const API_USER = '65532';
// The deployment database image. Its postgres user owns the volume content
// when the restore runs as the database user.
const DATABASE_IMAGE = 'postgres:16-alpine';
const DATABASE_UID = '70:70';
const FENCE_PATH = '/fence/restore-fence/fence.json';
const OWNED_LABEL = 'kamkmchess.ops.fence-probe';

/**
 * @param {string[]} args
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function docker(args) {
  return new Promise((resolvePromise) => {
    const child = spawn('docker', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolvePromise({ code: -1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Builds the helper image with a tag that belongs to this run.
 * @param {string} root
 * @param {string} tag
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function buildImage(root, tag) {
  const staging = await mkdtemp(join(tmpdir(), 'kamkmchess-fenceprobe-'));
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    /** @type {{code: number, stdout: string, stderr: string}} */
    let build;
    try {
      const result = await run('go', ['build', '-trimpath', '-tags', 'fenceprobe', '-o', join(staging, 'fenceprobe'), './tools/fenceprobe'], {
        cwd: root,
        env: { ...process.env, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' },
      });
      build = { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = /** @type {any} */ (error);
      build = { code: typeof failure.code === 'number' ? failure.code : -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? String(failure.message) };
    }
    if (build.code !== 0) {
      return { code: build.code, stdout: build.stdout, stderr: build.stderr };
    }
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(staging, 'Dockerfile'), [
      `FROM ${DATABASE_IMAGE}`,
      'COPY fenceprobe /usr/local/bin/fenceprobe',
      'ENTRYPOINT ["/usr/local/bin/fenceprobe"]',
      '',
    ].join('\n'), 'utf8');
    const image = await docker(['build', '--tag', tag, staging]);
    return { code: image.code, stdout: image.stdout, stderr: image.stderr };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Runs one fenceprobe command in a container.
 * @param {{volume: string, user: string, image: string, args: string[]}} options
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function probe(options) {
  return docker([
    'run', '--rm',
    '--user', options.user,
    '--mount', `type=volume,source=${options.volume},target=/fence`,
    options.image,
    ...options.args,
  ]);
}

/**
 * Proves the access.
 * @param {string} root
 * @param {{databaseUrl?: string}} [options]
 * @returns {Promise<{remedied: boolean, steps: {id: string, passed: boolean, detail: string}[], volume: string, image: string}>}
 */
export async function verifyFenceAccess(root, options = {}) {
  const run = randomUUID().replace(/-/g, '').slice(0, 12);
  const volume = `kamkmchess-fence-probe-${run}`;
  const image = `kamkmchess-fenceprobe:${run}`;
  /** @type {{id: string, passed: boolean, detail: string}[]} */
  const steps = [];

  const built = await buildImage(root, image);
  if (built.code !== 0) {
    steps.push({ id: 'image-builds', passed: false, detail: `the helper image could not be built: ${built.stderr.trim().split('\n').slice(-1)[0] ?? ''}` });
    return { remedied: false, steps, volume, image };
  }

  const created = await docker(['volume', 'create', '--label', `${OWNED_LABEL}=${run}`, volume]);
  if (created.code !== 0) {
    steps.push({ id: 'volume-created', passed: false, detail: `the throwaway volume could not be created: ${created.stderr.trim()}` });
    return { remedied: false, steps, volume, image };
  }

  try {
    // The deployment prepares the shared directory for the user the API reads
    // it as, exactly as the compose file does.
    const directory = await docker([
      'run', '--rm', '--user', 'root:0',
      '--mount', `type=volume,source=${volume},target=/fence`,
      DATABASE_IMAGE, 'sh', '-c',
      `mkdir -p /fence/restore-fence && chown ${API_USER}:${API_USER} /fence/restore-fence && chmod 700 /fence/restore-fence`,
    ]);
    steps.push({
      id: 'shared-directory-prepared',
      passed: directory.code === 0,
      detail: directory.code === 0
        ? 'the shared fence directory belongs to the API user'
        : `the shared fence directory could not be prepared: ${directory.stderr.trim().split('\n')[0] ?? ''}`,
    });

    // The database user cannot write the fence into that directory, so the
    // restore has to run as the API user. The refusal has to be a permission
    // refusal and it must leave no file behind.
    const unremedied = await probe({ volume, user: DATABASE_UID, image, args: ['write', FENCE_PATH, 'restore-database-user', '00'.repeat(32)] });
    const permissionRefused = unremedied.code !== 0 && /permission denied/i.test(unremedied.stderr);
    const afterRefusal = await docker([
      'run', '--rm', '--user', 'root:0',
      '--mount', `type=volume,source=${volume},target=/fence`,
      DATABASE_IMAGE, 'sh', '-c',
      'ls -1 /fence/restore-fence 2>/dev/null | wc -l',
    ]);
    const noFile = (afterRefusal.stdout || '').trim() === '0';
    steps.push({
      id: 'restore-must-run-as-the-api-user',
      passed: permissionRefused && noFile,
      detail: permissionRefused && noFile
        ? 'the database user is refused with a permission error and leaves no fence behind'
        : `the database user was not refused as expected (code ${unremedied.code}): ${unremedied.stderr.trim().split('\n')[0] ?? ''}`,
    });

    // The API user writes the fence and observes it.
    const write = await probe({ volume, user: API_UID, image, args: ['write', FENCE_PATH, 'restore-api-user', '11'.repeat(32)] });
    const open = await probe({ volume, user: API_UID, image, args: ['state', FENCE_PATH] });
    steps.push({
      id: 'api-user-observes-the-open-fence',
      passed: write.code === 0 && open.code === 3 && open.stdout.trim() === 'open',
      detail: write.code === 0 && open.code === 3 && open.stdout.trim() === 'open'
        ? 'the API user observes the open fence the restore wrote'
        : `the fence was not observable: write=${write.code} state=${open.code} ${open.stdout.trim() || open.stderr.trim().split('\n')[0] || ''}`,
    });

    // The production gate refuses traffic while the fence is open and serves
    // again after the restore finished.
    const databaseUrl = options.databaseUrl ?? 'postgres://postgres@host.docker.internal:55467/kamkmchess_online_test?sslmode=disable';
    const gate = await docker([
      'run', '--rm', '--detach', '--user', API_UID,
      '--mount', `type=volume,source=${volume},target=/fence`,
      '--publish', '127.0.0.1::8099',
      image, 'serve', FENCE_PATH, databaseUrl, '8099',
    ]);
    let port = '';
    if (gate.code === 0) {
      const inspected = await docker(['port', gate.stdout.trim(), '8099/tcp']);
      port = (inspected.stdout || '').trim().split('\n')[0]?.split(':').pop() ?? '';
    }
    let refused = false;
    let resumed = false;
    let gateLog = '';
    if (port) {
      // The helper applies the migrations before it serves, so the proof waits
      // for its readiness line instead of guessing a delay.
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const logs = await docker(['logs', gate.stdout.trim()]);
        gateLog = `${logs.stdout}${logs.stderr}`.trim().split('\n').slice(-3).join(' | ');
        if (gateLog.includes('serving')) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
      }
      const during = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null);
      refused = during !== null && during.status === 503;
      const cleared = await probe({ volume, user: API_UID, image, args: ['clear', FENCE_PATH] });
      if (cleared.code === 0) {
        const after = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null);
        resumed = after !== null && after.status === 200;
      }
      await docker(['rm', '--force', gate.stdout.trim()]);
    }
    steps.push({
      id: 'the-gate-refuses-during-the-restore',
      passed: refused,
      detail: refused
        ? 'the production gate answers 503 while the fence is open'
        : `the gate did not refuse the traffic during the restore${gateLog ? `: ${gateLog}` : ''}`,
    });
    steps.push({
      id: 'the-gate-serves-after-the-restore',
      passed: resumed,
      detail: resumed ? 'the production gate serves again after the fence is closed' : 'the gate did not serve again after the fence was closed',
    });

    return {
      remedied: steps.every((step) => step.passed),
      steps,
      volume,
      image,
    };
  } finally {
    // Only the volume this run created is removed, and only when it still
    // carries the label of this run.
    const labels = await docker(['volume', 'inspect', '--format', '{{index .Labels "kamkmchess.ops.fence-probe"}}', volume]);
    if (labels.code === 0 && labels.stdout.trim() === run) {
      await docker(['volume', 'rm', '--force', volume]);
    }
    await docker(['image', 'rm', '--force', image]);
  }
}

async function main() {
  const root = process.cwd();
  const report = await verifyFenceAccess(root);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      tool: 'deploy/verify-fence-access.mjs',
      disclaimer: 'Throwaway containers, a throwaway volume this run created and the local fixture database. No deployment is touched.',
      ...report,
    }, null, 2)}\n`);
  } else {
    for (const step of report.steps) {
      process.stdout.write(`  ${step.passed ? 'PASS' : 'FAIL'} ${step.id}: ${step.detail}\n`);
    }
    process.stdout.write(`fence access: ${report.remedied ? 'observable after the remedy' : 'NOT OBSERVABLE'}\n`);
    process.stdout.write('  scope: this proves the shared ownership, the permission boundary and the serving gate.\n');
    process.stdout.write('  it is not the restore proof: the encrypted restore, a crash during the\n');
    process.stdout.write('  restore, a wrong clear and an overlapping restore need the stable fence\n');
    process.stdout.write('  lifecycle of the privacy service and the real pg_dump and psql tools.\n');
  }
  if (!report.remedied) {
    process.stdout.write('  the restore has to run as the user the API reads the fence as, or the fence needs a mode and a group the API can read.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('deploy/verify-fence-access.mjs')) {
  await main();
}
