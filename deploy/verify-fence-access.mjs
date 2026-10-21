// Proves that the API can read the durable restore fence.
//
// The restore writes the fence inside the database container, the API reads it
// from the shared volume as its own user. When the two cannot read the same
// file, the API refuses every request, and it refuses for the wrong reason:
// it never sees the fence close.
//
// This script reproduces the real pair: it writes a fence with the modes the
// restore uses, in a container that runs as the database user, and then reads
// it from the same volume as the API user.
//
// It creates and removes a throwaway volume. It never touches a deployment.
//
// Usage:
//   node deploy/verify-fence-access.mjs [--json]

import { spawn } from 'node:child_process';
import process from 'node:process';

const volume = 'kamkmchess-fence-access-probe';
const fenceDirectory = '/fence/restore-fence';
const fenceFile = `${fenceDirectory}/fence.json`;

/**
 * @param {string[]} args
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function docker(args) {
  return new Promise((resolvePromise) => {
    const child = spawn('docker', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolvePromise({ code: -1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Proves the access.
 * @returns {Promise<{readable: boolean, detail: string, listing: string, owner: string}>}
 */
export async function verifyFenceAccess() {
  await docker(['volume', 'rm', '-f', volume]);
  await docker(['volume', 'create', volume]);
  try {
    // The restore writes the fence as the database user with the modes the
    // fence code uses: a private directory and a private file.
    const written = await docker(['run', '--rm', '-v', `${volume}:/fence`, 'postgres:17', 'sh', '-c',
      `mkdir -p ${fenceDirectory} && chmod 700 ${fenceDirectory} && printf '%s' '{"restoreId":"probe"}' > ${fenceFile} && chmod 600 ${fenceFile} && ls -ln ${fenceDirectory}`]);
    const listing = written.stdout.trim();
    const owner = listing.split(/\s+/).slice(-2)[0] ?? 'unknown';

    // The API reads the same volume as its own user.
    const read = await docker(['run', '--rm', '--user', '65532:65532', '-v', `${volume}:/fence:ro`, 'postgres:17', 'sh', '-c',
      `cat ${fenceFile}`]);
    const readable = read.code === 0 && read.stdout.includes('restoreId');

    // The mitigation: the restore writes the fence as the user the API reads
    // it as, so the private mode of the file still holds.
    await docker(['run', '--rm', '--user', '65532:65532', '-v', `${volume}:/fence`, 'postgres:17', 'sh', '-c',
      `mkdir -p ${fenceDirectory} && chmod 700 ${fenceDirectory} && printf '%s' '{"restoreId":"probe"}' > ${fenceFile} && chmod 600 ${fenceFile}`]);
    const readAsOwner = await docker(['run', '--rm', '--user', '65532:65532', '-v', `${volume}:/fence:ro`, 'postgres:17', 'sh', '-c',
      `cat ${fenceFile}`]);
    const readableAsOwner = readAsOwner.code === 0 && readAsOwner.stdout.includes('restoreId');

    return {
      readable,
      readableAsOwner,
      owner,
      listing,
      detail: readable
        ? 'the API user can read the fence the restore wrote'
        : `the API user (65532) cannot read the fence the restore wrote (${read.stderr.trim().split('\n')[0] ?? 'unknown error'})`,
    };
  } finally {
    await docker(['volume', 'rm', '-f', volume]);
  }
}

async function main() {
  const report = await verifyFenceAccess();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      tool: 'deploy/verify-fence-access.mjs',
      disclaimer: 'A throwaway volume and two throwaway containers. No deployment is touched.',
      ...report,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`fence access: ${report.readable ? 'readable' : 'NOT READABLE'}\n`);
    process.stdout.write(`  ${report.detail}\n`);
    process.stdout.write(`  the fence is owned by ${report.owner}\n`);
    process.stdout.write(`  the restore writing as the API user makes it readable: ${report.readableAsOwner ? 'yes' : 'no'}\n`);
  }
  if (!report.readable) {
    process.stdout.write('  fix: run the restore as the user the API reads the fence as, or write the fence with a mode and group the API can read. The fence code owns the mode; the deployment owns the user.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('deploy/verify-fence-access.mjs')) {
  await main();
}
