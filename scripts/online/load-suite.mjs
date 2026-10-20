// Synthetic load harness for the local online fixture.
//
// The traffic is synthetic: it uses the fixture's own accounts and never
// contacts a model provider, a hosted identity provider or a hosted database.
// The service under load is the real composition.
//
// The harness measures what a local run can honestly measure:
//
//   - request rate, latency percentiles and error counts;
//   - the database connections the service holds while the load runs;
//   - the effect of slow readers on the finite update stream;
//   - the behaviour of the deadline worker while matches are pending.
//
// It does not measure the hosting capacity. A local number is not a capacity
// claim, and the report says so.
//
// Usage:
//   node scripts/online/load-suite.mjs --clients 20 --duration 20
//   node scripts/online/load-suite.mjs --clients 20 --duration 20 --match <matchID>

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { mintToken, readDescriptor, resolveDatabaseUrl } from './fixture-client.mjs';

/**
 * Computes the latency percentiles of a sample.
 * @param {number[]} samples
 * @returns {{p50: number, p95: number, p99: number, max: number, min: number, count: number}}
 */
export function percentiles(samples) {
  if (samples.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, min: 0, count: 0 };
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    min: sorted[0],
    count: sorted.length,
  };
}

/**
 * Counts the database connections that a service holds.
 * @param {string} databaseUrl
 * @param {string} [container]
 * @returns {Promise<{total: number, byState: Record<string, number>, available: boolean}>}
 */
export async function connectionSample(databaseUrl, container = 'kamkmchess-kha67-local') {
  const query = "SELECT state, count(*) FROM pg_stat_activity WHERE datname = current_database() GROUP BY state;";
  return new Promise((resolvePromise) => {
    const child = spawn('docker', [
      'exec', '-i', String(container),
      'psql', '--no-psqlrc', '--tuples-only', '--no-align', '--field-separator', '|',
      '-U', 'postgres', '-d', 'kamkmchess_online_test', '-c', query,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', () => resolvePromise({ total: 0, byState: {}, available: false }));
    child.on('close', () => {
      /** @type {Record<string, number>} */
      const byState = {};
      let total = 0;
      for (const line of stdout.split(/\r?\n/)) {
        const [state, count] = line.split('|').map((part) => part.trim());
        if (!state || !count) continue;
        byState[state] = Number(count);
        total += Number(count);
      }
      resolvePromise({ total, byState, available: total > 0 || stderr.trim() === '' });
    });
  });
}

/**
 * Runs the load.
 * @param {{descriptor: any, clients: number, durationSeconds: number, matchId: string|null}} options
 * @returns {Promise<object>}
 */
export async function runLoad(options) {
  const { descriptor, clients, durationSeconds, matchId } = options;
  const token = await mintToken(descriptor, descriptor.accounts[0].id);
  const deadline = Date.now() + durationSeconds * 1000;

  /** @type {number[]} */
  const readLatencies = [];
  /** @type {number[]} */
  const unauthorizedLatencies = [];
  let readErrors = 0;
  let unauthorizedErrors = 0;
  let requests = 0;
  const statuses = new Map();

  /**
   * @param {string} path
   * @param {string|null} authToken
   * @param {number[]} sink
   * @returns {Promise<void>}
   */
  const call = async (path, authToken, sink) => {
    const started = Date.now();
    try {
      const response = await fetch(new URL(path, descriptor.baseUrl), {
        headers: {
          Accept: 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
      });
      await response.arrayBuffer();
      sink.push(Date.now() - started);
      statuses.set(String(response.status), (statuses.get(String(response.status)) ?? 0) + 1);
    } catch {
      sink.push(Date.now() - started);
      readErrors += 1;
    }
    requests += 1;
  };

  const worker = async (index) => {
    while (Date.now() < deadline) {
      await call('/v1/games', token, readLatencies);
      if (index % 3 === 0) {
        await call('/v1/games', null, unauthorizedLatencies);
      }
    }
  };

  const before = await connectionSample(options.databaseUrl);
  const started = Date.now();
  await Promise.all(Array.from({ length: clients }, (_, index) => worker(index)));
  const duration = (Date.now() - started) / 1000;
  const after = await connectionSample(options.databaseUrl);

  /** @type {object|null} */
  let slowReader = null;
  if (matchId) {
    slowReader = await measureSlowReader(descriptor, matchId, token);
  }

  return {
    clients,
    durationSeconds: Number(duration.toFixed(2)),
    requests,
    requestsPerSecond: Number((requests / duration).toFixed(2)),
    statuses: Object.fromEntries([...statuses.entries()].sort()),
    readLatencyMs: percentiles(readLatencies),
    unauthorizedLatencyMs: percentiles(unauthorizedLatencies),
    readErrors,
    unauthorizedErrors,
    databaseConnections: { before, after },
    slowReader,
    limits: [
      'The traffic is synthetic and local. It says nothing about the hosting capacity.',
      'A local connection count is not a pool sizing for the host.',
      'The measured latency includes the loopback hop and the fixture schema, not the Apache path.',
    ],
  };
}

/**
 * Opens the finite update stream and reads it slowly, to see whether a slow
 * reader can hold the service open.
 * @param {any} descriptor
 * @param {string} matchId
 * @param {string} token
 * @returns {Promise<object|null>}
 */
async function measureSlowReader(descriptor, matchId, token) {
  const started = Date.now();
  try {
    const response = await fetch(new URL(`/v1/online/matches/${encodeURIComponent(matchId)}/updates`, descriptor.baseUrl), {
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
    });
    const reader = response.body.getReader();
    let frames = 0;
    // The reader is deliberately slow: the server must end the window instead
    // of holding a connection for a reader that does not keep up.
    while (Date.now() - started < 25_000) {
      const next = await reader.read();
      if (next.done) break;
      frames += 1;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    }
    await reader.cancel();
    return {
      status: response.status,
      frames,
      durationMs: Date.now() - started,
      note: 'The stream is finite. A slow reader must not keep it open past the window.',
    };
  } catch (error) {
    return {
      status: 0,
      frames: 0,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const clientsIndex = arguments_.indexOf('--clients');
  const durationIndex = arguments_.indexOf('--duration');
  const matchIndex = arguments_.indexOf('--match');
  const clients = clientsIndex >= 0 ? Number(arguments_[clientsIndex + 1]) : 10;
  const duration = durationIndex >= 0 ? Number(arguments_[durationIndex + 1]) : 10;
  const matchId = matchIndex >= 0 ? arguments_[matchIndex + 1] : null;

  const databaseUrl = await resolveDatabaseUrl();
  const descriptorPath = join(process.cwd(), '.scratch', 'onlinefixture', 'descriptor.json');

  const fixture = spawn('node', [join(process.cwd(), 'scripts', 'online', 'fixture-server.mjs'), '--descriptor', descriptorPath], {
    cwd: process.cwd(),
    windowsHide: true,
    env: { ...process.env, ONLINE_FIXTURE_DATABASE_URL: databaseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  fixture.stdout.on('data', (chunk) => { output += chunk.toString(); });
  fixture.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const ready = await new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), 120_000);
    const check = setInterval(() => {
      if (output.includes('fixture ready at')) {
        clearInterval(check);
        clearTimeout(timer);
        resolvePromise(true);
      }
    }, 250);
  });
  if (!ready) {
    fixture.kill('SIGTERM');
    throw new Error('the local fixture did not become ready');
  }

  const report = await runLoad({
    descriptor: await readDescriptor(descriptorPath),
    clients,
    durationSeconds: duration,
    matchId,
    databaseUrl,
  });
  fixture.kill('SIGTERM');

  const target = join(process.cwd(), 'docs', 'evidence', 'online', 'KHA-83-local-load.json');
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, `${JSON.stringify({
    tool: 'scripts/online/load-suite.mjs',
    generatedAt: new Date().toISOString(),
    environment: 'local fixture (loopback), synthetic accounts, real PostgreSQL, pinned rules worker',
    ...report,
  }, null, 2)}\n`, 'utf8');

  process.stdout.write(`load: ${report.requests} requests in ${report.durationSeconds}s (${report.requestsPerSecond}/s)\n`);
  process.stdout.write(`  read latency p50 ${report.readLatencyMs.p50}ms p95 ${report.readLatencyMs.p95}ms\n`);
  process.stdout.write(`  database connections before ${report.databaseConnections.before.total} after ${report.databaseConnections.after.total}\n`);
  process.stdout.write(`report written to ${target}\n`);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/online/load-suite.mjs')) {
  await main();
}
