// Build and verify the deployment runtime image, locally.
//
// The image carries the private rules runtime: the pinned Node 24 runtime and
// the bundled rules worker that the Go match authority runs as a child
// process. This script builds the image from the deploy context and proves the
// runtime composition inside it:
//
//   - the image runs the pinned Node version;
//   - the rules bundle is present at the configured entry path;
//   - the worker answers a real protocol request;
//   - the API binary is present and executable;
//   - the container runs as a non-root user;
//   - no credential file is baked into the image.
//
// It never pushes the image, never deploys it and never connects the image to
// a database. It builds and inspects a local image only.
//
// Usage:
//   node deploy/verify-runtime-image.mjs [--json] [--keep]
//   node deploy/verify-runtime-image.mjs --node-version 24.22.0

import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(process.cwd());
const deploy = join(root, 'deploy');

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string, string>, input?: string}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...(options.env ?? {}) },
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolvePromise({ code: -1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Runs a command and returns stdout, throwing on failure.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string, string>, input?: string}} [options]
 * @returns {Promise<string>}
 */
async function runOrFail(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

/**
 * Verifies the runtime image.
 * @param {{nodeVersion: string, keep: boolean}} options
 * @returns {Promise<{checks: {id: string, passed: boolean, detail: string}[], image: string}>}
 */
export async function verifyRuntimeImage(options) {
  /** @type {{id: string, passed: boolean, detail: string}[]} */
  const checks = [];
  const staging = join(root, '.scratch', 'runtime-image');
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, 'bin'), { recursive: true });
  await mkdir(join(staging, 'rules-worker'), { recursive: true });

  // The Go binary is cross-compiled for the deployment target.
  const build = await run('go', ['build', '-trimpath', '-o', join(staging, 'bin', 'kamkmchess-api'), './cmd/server'], {
    env: { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' },
  });
  if (build.code !== 0) {
    throw new Error(`the API binary could not be built: ${build.stderr.trim().split('\n').slice(-1)[0] ?? ''}`);
  }
  checks.push({ id: 'api-binary-built', passed: true, detail: 'the API binary was cross-compiled for linux/amd64' });

  const bundle = join(root, 'build', 'rules-worker', 'worker.mjs');
  try {
    await readFile(bundle);
  } catch {
    const built = await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', 'build:rules-worker'], { cwd: root });
    if (built.code !== 0) {
      throw new Error('the rules worker bundle could not be built');
    }
  }
  for (const name of ['worker.mjs', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.txt']) {
    await copyFile(join(root, 'build', 'rules-worker', name), join(staging, 'rules-worker', name));
  }
  checks.push({ id: 'rules-bundle-staged', passed: true, detail: 'the rules bundle and its notices were staged' });

  const image = 'kamkmchess-api:verify';
  const dockerBuild = await run('docker', ['build', '--file', join(deploy, 'api.Dockerfile'), '--tag', image, staging], { cwd: root });
  checks.push({
    id: 'image-builds',
    passed: dockerBuild.code === 0,
    detail: dockerBuild.code === 0 ? `the image ${image} was built locally` : `docker build failed: ${dockerBuild.stderr.trim().split('\n').slice(-1)[0] ?? ''}`,
  });
  if (dockerBuild.code !== 0) {
    return { checks, image };
  }

  const nodeVersion = (await runOrFail('docker', ['run', '--rm', '--entrypoint', 'node', image, '--version'])).trim();
  checks.push({
    id: 'pinned-node-runtime',
    passed: nodeVersion === `v${options.nodeVersion}`,
    detail: `the image runs ${nodeVersion}`,
  });

  const entry = '/opt/kamkmchess/rules-worker/worker.mjs';
  const entryExists = await run('docker', ['run', '--rm', '--entrypoint', 'ls', image, '-l', entry]);
  checks.push({
    id: 'rules-entry-present',
    passed: entryExists.code === 0,
    detail: entryExists.code === 0 ? 'the rules bundle is present at the configured entry path' : 'the rules bundle is missing from the image',
  });

  // A real protocol request proves the worker runs inside the image.
  const request = {
    protocolVersion: 1,
    requestId: 'runtime-image-check',
    rulesPolicyVersion: 'online-rules/1',
    matchVersion: 1,
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    history: ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'],
    intent: { kind: 'move', from: 'e2', to: 'e4' },
  };
  const worker = await run('docker', ['run', '--rm', '-i', '--entrypoint', 'node', image, entry], { input: `${JSON.stringify(request)}\n` });
  /** @type {boolean} */
  let answered;
  try {
    const parsed = JSON.parse(worker.stdout.trim().split(/\r?\n/)[0] ?? '');
    answered = parsed.status === 'ok' && parsed.requestId === 'runtime-image-check' && parsed.candidate?.move?.to === 'e4';
  } catch {
    answered = false;
  }
  checks.push({
    id: 'rules-worker-answers',
    passed: answered,
    detail: answered ? 'the worker answered a real protocol request inside the image' : `the worker did not answer correctly: ${worker.stdout.trim().slice(0, 160)}`,
  });

  const identity = await run('docker', ['run', '--rm', '--entrypoint', 'id', image]);
  checks.push({
    id: 'non-root-user',
    passed: identity.code === 0 && /uid=65532/.test(identity.stdout),
    detail: identity.stdout.trim() || 'the container identity could not be read',
  });

  // The image must not carry a credential. The public certificate authority
  // bundle of the base image is not a credential.
  const listing = await run('docker', ['run', '--rm', '--entrypoint', 'sh', image, '-c',
    'find / -maxdepth 3 \\( -name "*.env" -o -name "*secret*" -o -name "*password*" -o -name "*.pem" -o -name "*.key" \\) 2>/dev/null | grep -v "^/etc/ssl" | grep -v "^/sys" | grep -v "^/proc" | head -20']);
  const secrets = listing.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  checks.push({
    id: 'no-credential-file',
    passed: secrets.length === 0,
    detail: secrets.length === 0 ? 'no credential file is baked into the image' : `the image contains ${secrets.join(', ')}`,
  });

  const apiBinary = await run('docker', ['run', '--rm', '--entrypoint', 'ls', image, '-l', '/usr/local/bin/kamkmchess-api']);
  checks.push({
    id: 'api-binary-present',
    passed: apiBinary.code === 0,
    detail: apiBinary.code === 0 ? 'the API binary is present in the image' : 'the API binary is missing from the image',
  });

  if (!options.keep) {
    await run('docker', ['image', 'rm', '--force', image]);
    await rm(staging, { recursive: true, force: true });
  }
  return { checks, image };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const versionIndex = arguments_.indexOf('--node-version');
  const nodeVersion = versionIndex >= 0 ? arguments_[versionIndex + 1] : '24.22.0';
  const report = await verifyRuntimeImage({ nodeVersion, keep: arguments_.includes('--keep') });
  const failures = report.checks.filter((check) => !check.passed);

  if (arguments_.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      tool: 'deploy/verify-runtime-image.mjs',
      disclaimer: 'The image is built and inspected locally. Nothing is pushed, deployed or connected to a database.',
      ...report,
    }, null, 2)}\n`);
  } else {
    for (const check of report.checks) {
      process.stdout.write(`  ${check.passed ? 'PASS' : 'FAIL'} ${check.id}: ${check.detail}\n`);
    }
    process.stdout.write(`${report.checks.length} checks, ${failures.length} failures\n`);
  }
  if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('deploy/verify-runtime-image.mjs')) {
  await main();
}
