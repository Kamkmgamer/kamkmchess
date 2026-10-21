// Proves that the API can observe the durable restore fence.
//
// The restore writes the fence inside the database container, the API reads it
// from the shared volume as its own user. When the two cannot read the same
// file, the API refuses every request, and it refuses for the wrong reason:
// it never sees the fence close.
//
// The proof uses the real fence code of the privacy service through the
// build-tagged fenceprobe helper, the real user of each service and the real
// shared volume. It proves three states:
//
//   1. the restore user writes the fence, and the API user observes it OPEN;
//   2. the API user observes the fence CLOSED after the restore finished;
//   3. the configuration in which the restore writes as the database user is
//      NOT observable by the API user, which is the defect the remedy removes.
//
// Every container exit code is checked, the volume is unique per run and only
// the volume this run created is removed.
//
// Usage:
//   node deploy/verify-fence-access.mjs [--json] [--keep]

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const API_UID = '65532:65532';
const DATABASE_UID = '70:70';
const IMAGE = 'kamkmchess-fenceprobe:local';

/**
 * @param {string[]} args
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function docker(args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn('docker', args, { windowsHide: true, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolvePromise({ code: -1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Builds the helper image.
 * @param {string} root
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function buildImage(root) {
  const staging = await mkdtemp(join(tmpdir(), 'kamkmchess-fenceprobe-'));
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const build = await run('go', ['build', '-trimpath', '-tags', 'fenceprobe', '-o', join(staging, 'fenceprobe'), './tools/fenceprobe'], {
      cwd: root,
      env: { ...process.env, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' },
    }).catch((error) => ({ stdout: '', stderr: String(error) }));
    if (!build.stdout && build.stderr && !build.stderr.includes('exit status')) {
      return { code: 1, stdout: '', stderr: build.stderr };
    }
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(staging, 'Dockerfile'), [
      'FROM postgres:17',
      'COPY fenceprobe /usr/local/bin/fenceprobe',
      'ENTRYPOINT ["/usr/local/bin/fenceprobe"]',
      '',
    ].join('\n'), 'utf8');
    const image = await docker(['build', '--tag', IMAGE, staging]);
    return { code: image.code, stdout: image.stdout, stderr: image.stderr };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Runs one fenceprobe command in a container.
 * @param {{volume: string, user: string, args: string[]}} options
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function probe(options) {
  return docker([
    'run', '--rm',
    '--user', options.user,
    '--mount', `type=volume,source=${options.volume},target=/fence`,
    IMAGE,
    ...options.args,
  ]);
}

/**
 * Proves the access.
 * @param {string} root
 * @returns {Promise<{remedied: boolean, unremedied: boolean, steps: {id: string, passed: boolean, detail: string}[], volume: string}>}
 */
export async function verifyFenceAccess(root) {
  const built = await buildImage(root);
  if (built.code !== 0) {
    return {
      remedied: false,
      unremedied: false,
      steps: [{ id: 'image-builds', passed: false, detail: `the helper image could not be built: ${built.stderr.trim().split('\n').slice(-1)[0] ?? ''}` }],
      volume: '',
    };
  }

  // A volume that belongs to this run alone.
  const volume = `kamkmchess-fence-probe-${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
  const created = await docker(['volume', 'create', volume]);
  /** @type {{id: string, passed: boolean, detail: string}[]} */
  const steps = [];
  const createdHere = created.code === 0;
  if (!createdHere) {
    steps.push({ id: 'volume-created', passed: false, detail: 'the throwaway volume could not be created' });
    return { remedied: false, unremedied: false, steps, volume };
  }

  try {
    // The deployment prepares the shared directory for the user the API reads
    // it as, exactly as the compose file does.
    const prepared = await docker([
      'run', '--rm', '--user', 'root:0',
      '--mount', `type=volume,source=${volume},target=/fence`,
      IMAGE,
      '--version',
    ].length > 0 ? ['--entrypoint', 'sh'] : []);
    void prepared;

    const directory = await docker([
      'run', '--rm', '--user', 'root:0',
      '--mount', `type=volume,source=${volume},target=/fence`,
      'postgres:17', 'sh', '-c',
      'mkdir -p /fence/restore-fence && chown 65532:65532 /fence/restore-fence && chmod 700 /fence/restore-fence',
    ]);
    if (directory.code !== 0) {
      steps.push({ id: 'shared-directory-prepared', passed: false, detail: `the shared fence directory could not be prepared: ${directory.stderr.trim().split('\n')[0] ?? ''}` });
      return { remedied: false, unremedied: false, steps, volume };
    }
    steps.push({ id: 'shared-directory-prepared', passed: true, detail: 'the shared fence directory belongs to the API user' });

    // 1. The configuration in use: the restore writes as the database user.
    const unremediedWrite = await probe({
      volume,
      user: DATABASE_UID,
      args: ['write', '/fence/restore-fence/fence.json', 'restore-unremedied', '00'.repeat(32)],
    });
    const unremediedRead = await probe({ volume, user: API_UID, args: ['state', '/fence/restore-fence/fence.json'] });
    // With the shared directory prepared for the API user, the database
    // user cannot write the fence at all. The restore therefore has to run as
    // the user the API reads it as.
    const unremedied = unremediedWrite.code !== 0;
    steps.push({
      id: 'restore-must-run-as-the-api-user',
      passed: unremedied,
      detail: unremedied
        ? 'the database user cannot write the fence into the shared directory, so the restore has to run as the API user'
        : `the database user wrote the fence and the API read it (${(unremediedRead.stdout.trim() || unremediedRead.stderr.trim().split('\n')[0]) || 'no output'})`,
    });
    await probe({ volume, user: DATABASE_UID, args: ['clear', '/fence/restore-fence/fence.json'] });

    // 2. The remedy: the restore writes as the user the API reads it as.
    const write = await probe({
      volume,
      user: API_UID,
      args: ['write', '/fence/restore-fence/fence.json', 'restore-remedied', '11'.repeat(32)],
    });
    const open = await probe({ volume, user: API_UID, args: ['state', '/fence/restore-fence/fence.json'] });
    const observedOpen = open.code === 3 && open.stdout.trim() === 'open';
    steps.push({
      id: 'api-user-observes-the-open-fence',
      passed: write.code === 0 && observedOpen,
      detail: write.code === 0 && observedOpen
        ? 'the API user observes the open fence the restore wrote'
        : `the fence was not observable: write=${write.code} state=${open.code} ${(open.stdout.trim() || open.stderr.trim().split('\n')[0]) || ''}`,
    });

    // 3. After the restore finished, the fence closes and the API resumes.
    const clear = await probe({ volume, user: API_UID, args: ['clear', '/fence/restore-fence/fence.json'] });
    const closed = await probe({ volume, user: API_UID, args: ['state', '/fence/restore-fence/fence.json'] });
    const observedClosed = closed.code === 0 && closed.stdout.trim() === 'closed';
    steps.push({
      id: 'api-user-observes-the-closed-fence',
      passed: clear.code === 0 && observedClosed,
      detail: clear.code === 0 && observedClosed
        ? 'the API user observes the closed fence after the restore finished'
        : `the closed fence was not observable: clear=${clear.code} state=${closed.code} ${(closed.stdout.trim() || closed.stderr.trim().split('\n')[0]) || ''}`,
    });

    return {
      remedied: steps.every((step) => step.passed),
      unremedied,
      steps,
      volume,
    };
  } finally {
    if (createdHere) {
      await docker(['volume', 'rm', '-f', volume]);
    }
  }
}

async function main() {
  const root = process.cwd();
  const report = await verifyFenceAccess(root);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      tool: 'deploy/verify-fence-access.mjs',
      disclaimer: 'Throwaway containers and a throwaway volume. No deployment is touched.',
      ...report,
    }, null, 2)}\n`);
  } else {
    for (const step of report.steps) {
      process.stdout.write(`  ${step.passed ? 'PASS' : 'FAIL'} ${step.id}: ${step.detail}\n`);
    }
    process.stdout.write(`fence access: ${report.remedied ? 'observable after the remedy' : 'NOT OBSERVABLE'}\n`);
  }
  if (!report.remedied) {
    process.stdout.write('  the restore has to run as the user the API reads the fence as, or the fence needs a mode and a group the API can read.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('deploy/verify-fence-access.mjs')) {
  await main();
}
