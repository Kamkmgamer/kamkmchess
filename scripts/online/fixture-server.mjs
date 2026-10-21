// Build and run the local online fixture.
//
// The fixture is the real service composition (Go API, PostgreSQL, the pinned
// private rules worker) on loopback, with its own throwaway schema and its own
// signing key. This launcher finds a local test database, builds the tagged
// helper, starts it, waits for its readiness line and prints the descriptor
// path.
//
// It never deploys anything, never contacts a hosted identity provider and
// never prints a database password.
//
// Usage:
//   node scripts/online/fixture-server.mjs --descriptor .scratch/onlinefixture/descriptor.json
//   node scripts/online/fixture-server.mjs --stop .scratch/onlinefixture/descriptor.json
//   node scripts/online/fixture-server.mjs --print-env .scratch/onlinefixture/descriptor.json

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { FIXTURE_DESCRIPTOR_ENV, redactDatabaseUrl, resolveDatabaseUrl } from './fixture-client.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * @param {string[]} arguments_
 * @param {string} name
 * @returns {string|undefined}
 */
function option(arguments_, name) {
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  return arguments_[index + 1];
}

/**
 * @param {string[]} arguments_
 * @param {string} name
 * @returns {string[]}
 */
function options(arguments_, name) {
  const values = [];
  arguments_.forEach((value, index) => {
    if (value === name && arguments_[index + 1]) values.push(arguments_[index + 1]);
  });
  return values;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<void>}
 */
function runCommand(command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
    });
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} ${args[0]} failed with exit code ${code}`));
    });
  });
}

/**
 * Stops a running fixture using the descriptor's process id.
 * @param {string} descriptorPath
 * @returns {Promise<void>}
 */
async function stopFixture(descriptorPath) {
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  const pid = Number(descriptor.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('fixture descriptor has no usable process id');
  }
  process.kill(pid, 'SIGTERM');
  process.stdout.write(`sent SIGTERM to fixture process ${pid}\n`);
}

/**
 * Starts the fixture and waits for its readiness line.
 * @param {string[]} arguments_
 * @returns {Promise<void>}
 */
async function startFixture(arguments_) {
  const descriptorPath = resolve(option(arguments_, '--descriptor') ?? join('.scratch', 'onlinefixture', 'descriptor.json'));
  const rulesWorker = resolve(option(arguments_, '--rules-worker') ?? join('build', 'rules-worker', 'worker.mjs'));
  const origins = options(arguments_, '--allow-origin');
  const databaseUrl = await resolveDatabaseUrl();

  await mkdir(dirname(descriptorPath), { recursive: true });
  const binaryDir = join('.scratch', 'onlinefixture');
  await mkdir(binaryDir, { recursive: true });
  const binary = join(binaryDir, 'onlinefixture' + (process.platform === 'win32' ? '.exe' : ''));

  // The helper is behind a build tag, so a normal `go build ./...` never
  // produces it and the deployed API image never contains it.
  await runCommand('go', ['build', '-tags', 'onlinefixture', '-o', binary, './tools/onlinefixture'], root);

  try {
    await readFile(rulesWorker);
  } catch {
    await runCommand(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', 'build:rules-worker'], root);
  }

  const child = spawn(binary, [
    '--descriptor', descriptorPath,
    '--rules-worker', rulesWorker,
    ...origins.flatMap((origin) => ['--allow-origin', origin]),
    ...(option(arguments_, '--api-port') ? ['--api-port', option(arguments_, '--api-port')] : []),
    ...(arguments_.includes('--queue-enabled') ? ['--queue-enabled'] : []),
    ...(arguments_.includes('--friend-disabled') ? ['--friend-enabled=false'] : []),
  ], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, ONLINE_FIXTURE_DATABASE_URL: databaseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const ready = await new Promise((resolvePromise, rejectPromise) => {
    let buffer = '';
    const timer = setTimeout(() => rejectPromise(new Error('fixture did not become ready in time')), 60_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const line = buffer.split(/\r?\n/).find((entry) => entry.startsWith('ONLINE_FIXTURE_READY '));
      if (!line) return;
      clearTimeout(timer);
      resolvePromise(JSON.parse(line.slice('ONLINE_FIXTURE_READY '.length)));
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('exit', (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`fixture exited with code ${code} before it was ready`));
    });
  });

  const shutdown = () => {
    if (!child.killed) child.kill('SIGTERM');
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await writeFile(join(dirname(descriptorPath), 'fixture-summary.json'), `${JSON.stringify({
    baseUrl: ready.baseUrl,
    issuer: ready.issuer,
    schema: ready.schema,
    database: redactDatabaseUrl(ready.database),
    accounts: ready.accounts.map((account) => account.id),
    expiresAt: ready.expiresAt,
  }, null, 2)}\n`, 'utf8');

  process.stdout.write(`fixture ready at ${ready.baseUrl}\n`);
  process.stdout.write(`descriptor: ${descriptorPath}\n`);
  process.stdout.write(`schema: ${ready.schema}\n`);
  process.stdout.write(`accounts: ${ready.accounts.map((account) => account.id).join(', ')}\n`);
  process.stdout.write(`export ${FIXTURE_DESCRIPTOR_ENV}=${descriptorPath}\n`);
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes('--stop')) {
    const descriptorPath = option(arguments_, '--stop');
    if (!descriptorPath) throw new Error('--stop needs the descriptor path');
    await stopFixture(descriptorPath);
    return;
  }
  if (arguments_.includes('--print-env')) {
    const descriptorPath = option(arguments_, '--print-env');
    if (!descriptorPath) throw new Error('--print-env needs the descriptor path');
    process.stdout.write(`${FIXTURE_DESCRIPTOR_ENV}=${descriptorPath}\n`);
    return;
  }
  if (arguments_.includes('--clean')) {
    const directory = join('.scratch', 'onlinefixture');
    await rm(directory, { recursive: true, force: true });
    process.stdout.write(`removed ${directory}\n`);
    return;
  }
  await startFixture(arguments_);
}

await main();
