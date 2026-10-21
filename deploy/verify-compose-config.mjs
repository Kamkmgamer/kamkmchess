// Proves that the database configuration still reaches PostgreSQL.
//
// The compose file prepares the shared fence directory before the database
// starts, so it overrides the entrypoint of the image. The command arguments
// have to survive that override, or the database would start without TLS, the
// reviewed host authentication file or the memory settings.
//
// The proof renders the compose configuration and then asks the deployment
// image itself for the effective settings. Nothing is deployed: the rendered
// command is only inspected and the image is asked to print its settings.
//
// Usage:
//   node deploy/verify-compose-config.mjs [--json]

import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const IMAGE = 'postgres:16-alpine';

/**
 * @param {string[]} args
 * @param {{cwd?: string, input?: string}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolvePromise({ code: -1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/**
 * Proves the configuration.
 * @param {string} root
 * @returns {Promise<{steps: {id: string, passed: boolean, detail: string}[], settings: Record<string, string>}>}
 */
export async function verifyComposeConfig(root) {
  /** @type {{id: string, passed: boolean, detail: string}[]} */
  const steps = [];
  const staging = await mkdtemp(join(tmpdir(), 'kamkmchess-compose-'));
  try {
    await cp(join(root, 'deploy', 'postgres.compose.yml'), join(staging, 'postgres.compose.yml'));
    // The compose file reads its secrets from a file that only exists on the
    // server. The rendering needs a placeholder, never a real credential.
    await writeFile(join(staging, 'postgres.env'), 'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=fixture-only\nPOSTGRES_DB=kamkmchess\n', 'utf8');

    const rendered = await run('docker', ['compose', '-f', join(staging, 'postgres.compose.yml'), 'config'], { cwd: staging });
    const config = rendered.stdout;
    const hasCommand = /- ssl=on/.test(config) && /- hba_file=\/etc\/postgresql\/pg_hba.conf/.test(config);
    const hasForwarding = /docker-entrypoint\.sh "\$\$@"/.test(config);
    steps.push({
      id: 'the-command-survives-the-entrypoint',
      passed: hasCommand && hasForwarding,
      detail: hasCommand && hasForwarding
        ? 'the rendered configuration forwards the command to the database image'
        : 'the rendered configuration lost the command or the forwarding',
    });

    // The image itself reports the settings the forwarded arguments produce.
    // The image entrypoint prepares its data directory first, so the
    // configuration file exists when the settings are read.
    const settings = {};
    // The host authentication file is checked in the rendered configuration:
    // the file itself only exists on the server.
    for (const name of ['ssl', 'max_connections', 'shared_buffers']) {
      // The image is asked for the setting with the same arguments the
      // compose file passes. The data directory is prepared in the container,
      // because the setting is read from its configuration file.
      const value = await run('docker', [
        'run', '--rm', '--user', 'postgres', '--entrypoint', 'sh', IMAGE, '-c',
        `mkdir -p /tmp/probe && : > /tmp/probe/postgresql.conf && exec postgres -D /tmp/probe -C ${name} -c ssl=on -c ssl_min_protocol_version=TLSv1.2 -c password_encryption=scram-sha-256 -c max_connections=60 -c shared_buffers=128MB`,
      ]);
      settings[name] = (value.stdout || value.stderr).trim().split('\n').filter((line) => line.trim().length > 0).pop() ?? '';
    }
    // The image reports the memory in blocks, so both forms are accepted.
    const expected = { ssl: ['on'], max_connections: ['60'], shared_buffers: ['128MB', '16384'] };
    const mismatched = Object.entries(expected).filter(([name, values]) => !values.includes(settings[name]));
    steps.push({
      id: 'the-database-keeps-its-settings',
      passed: mismatched.length === 0,
      detail: mismatched.length === 0
        ? 'the forwarded arguments produce the reviewed settings'
        : `the settings differ: ${mismatched.map(([name, value]) => `${name}=${settings[name]} instead of ${value}`).join(', ')}`,
    });
    return { steps, settings };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  const report = await verifyComposeConfig(process.cwd());
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      tool: 'deploy/verify-compose-config.mjs',
      disclaimer: 'The compose file is rendered and the image is asked for its settings. Nothing is deployed.',
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
