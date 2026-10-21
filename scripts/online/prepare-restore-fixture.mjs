// Prepares the native stages of the encrypted restore proof.
//
// The stages are independent of the fence lifecycle, so they can be prepared
// while the privacy service finishes its own work:
//
//   1. the database tools are present in the deployment image;
//   2. the backup command is built from the checked-in source;
//   3. the configuration has to address the local fixture container, and a
//      database of this run is created there with the checked-in migrations;
//   4. an encrypted bundle is created with the real tool, using the dump of
//      the server it comes from, verified and copied to the host;
//   5. the commands of the restore, the crash, the wrong clear, the overlap
//      and the resume are written down with the lifecycle they need.
//
// Everything the run creates belongs to the run: the database, the container
// paths and the bundle carry a random identifier, and the database and the
// container files are removed when the run ends. A cleanup that fails is
// reported as a failure, not as a note.
//
// The restore itself is **not** run here. The fence lifecycle of the privacy
// service is still in review, so the restore would run against an interface
// that is not accepted.
//
// Usage:
//   node scripts/online/prepare-restore-fixture.mjs [--json] [--keep]

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const CONTAINER = 'kamkmchess-kha67-local';
const ROOT = process.cwd();

/**
 * Removes the database url and the passphrase from an output.
 * @param {string} text
 * @returns {string}
 */
function redact(text) {
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, 'postgres://redacted')
    .replace(/(KHA_BACKUP_PASSPHRASE=)[^\s"']+/gi, '$1redacted');
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string, string>}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
    });
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
 * Prepares the stages.
 * @param {{keep?: boolean}} [options]
 * @returns {Promise<{stages: {id: string, passed: boolean, detail: string}[], commands: string[], bundle: object}>}
 */
export async function prepareRestoreFixture(options = {}) {
  /** @type {{id: string, passed: boolean, detail: string}[]} */
  const stages = [];
  const identifier = randomUUID().replace(/-/g, '').slice(0, 12);
  const directory = join(ROOT, '.scratch', 'restore-fixture');
  await mkdir(directory, { recursive: true });

  const commands = [
    '# The restore, the crash, the wrong clear, the overlap and the resume need the',
    '# fence lifecycle of the privacy service: an ownership handle that is held for',
    '# the whole restore, a finish and a release, and a takeover that cannot clear a',
    '# live restore. The candidate is not integrated and the interface is not',
    '# accepted, so these commands are prepared and not run.',
    'docker compose -f postgres.compose.yml -f api.compose.yml exec --user 65532 postgres sh -c \'',
    '  set -a; . /run/secrets/backup.env; set +a',
    '  exec /opt/kamkmchess/khabackup restore --file <bundle> --newer-ledger <newer bundle> \\',
    '    --fence <fence directory> --database-url-env DATABASE_URL --passphrase-env KHA_BACKUP_PASSPHRASE --apply\'',
    '# The same command with the process killed during the import leaves the fence',
    '# open, and the service refuses to serve until the recovery finished.',
    '# A clear without the ownership handle, and a second restore while the first',
    '# holds the fence, both have to be refused.',
  ];

  /** @type {{path: string, created: boolean, output: string}} */
  const bundle = { path: '', created: false, output: '' };
  const database = `kamkmchess_restore_fixture_${identifier}`;
  const toolPath = `/tmp/khabackup-${identifier}`;
  const bundleInContainer = `/tmp/older-bundle-${identifier}.kha`;
  const binary = join(directory, `khabackup-${identifier}`);
  const bundlePath = join(directory, `older-bundle-${identifier}.kha`);

  try {
    const tools = await run('docker', ['exec', CONTAINER, 'sh', '-c', 'pg_dump --version; psql --version']);
    const toolLines = `${tools.stdout}${tools.stderr}`.split(/\r?\n/).filter((line) => line.includes('PostgreSQL'));
    stages.push({
      id: 'the-database-tools-are-present',
      passed: tools.code === 0 && toolLines.length >= 2,
      detail: toolLines.length >= 2 ? toolLines.join(' | ') : 'the image does not carry both database tools',
    });

    const build = await run('go', ['build', '-trimpath', '-o', binary, './backend/backup/cmd/khabackup'], {
      env: { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' },
    });
    stages.push({
      id: 'the-backup-command-is-built',
      passed: build.code === 0,
      detail: build.code === 0 ? 'the backup command was built from the checked-in source' : `the build failed: ${redact(build.stderr.trim().split('\n').slice(-1)[0] ?? '')}`,
    });

    // The configuration has to address the fixture container, because that is
    // where the database of this run is created. A configuration that points
    // anywhere else is refused before anything is changed.
    const base = new URL(process.env.ONLINE_FIXTURE_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:55467/kamkmchess_online_test?sslmode=disable');
    const published = await run('docker', ['port', CONTAINER, '5432/tcp']);
    const publishedPort = (published.stdout || '').trim().split('\n')[0]?.split(':').pop() ?? '';
    const addressesTheFixture = ['127.0.0.1', 'localhost', '::1'].includes(base.hostname) && base.port === publishedPort;
    stages.push({
      id: 'the-configuration-addresses-the-fixture-server',
      passed: addressesTheFixture,
      detail: addressesTheFixture
        ? 'the configuration addresses the local fixture container'
        : 'the configured database does not address the local fixture container, so the preparation refuses to change anything',
    });
    if (!addressesTheFixture) {
      await writeFile(join(directory, 'restore-stages.md'), `${commands.join('\n')}\n`, 'utf8');
      return { stages, commands, bundle };
    }

    const scoped = new URL(base.toString());
    scoped.pathname = `/${database}`;
    const passphrase = process.env.KHA_BACKUP_PASSPHRASE ?? 'fixture-only-passphrase';

    const created = await run('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-c', `CREATE DATABASE ${database}`]);
    const migrated = created.code === 0
      ? await run('go', ['run', './cmd/migrate'], { env: { DATABASE_URL: scoped.toString() } })
      : { code: created.code, stdout: '', stderr: created.stderr };
    stages.push({
      id: 'the-fixture-database-exists',
      passed: migrated.code === 0,
      detail: migrated.code === 0
        ? `the migrations were applied to the ${database} database of the fixture container`
        : `the fixture database could not be prepared: ${redact((migrated.stderr || migrated.stdout).trim().split('\n').slice(-1)[0] ?? '')}`,
    });

    // The tool runs inside the fixture container, because the dump has to
    // come from the same PostgreSQL version as the server.
    const copied = await run('docker', ['cp', binary, `${CONTAINER}:${toolPath}`]);
    stages.push({
      id: 'the-backup-command-reaches-the-container',
      passed: copied.code === 0,
      detail: copied.code === 0 ? 'the command was copied into the container' : `the command could not be copied into the container: ${redact((copied.stdout + copied.stderr).trim())}`,
    });

    if (copied.code === 0) {
      // The container reaches the fixture server through the host, and the
      // address is set on the parsed url, not by replacing text in it.
      const containerTarget = new URL(scoped.toString());
      containerTarget.hostname = 'host.docker.internal';
      const containerURL = containerTarget.toString();
      const inContainer = (arguments_) => run('docker', [
        'exec', '--env', `DATABASE_URL=${containerURL}`, '--env', `KHA_BACKUP_PASSPHRASE=${passphrase}`,
        CONTAINER, toolPath, ...arguments_,
      ]);

      const made = await inContainer(['create', '--class', 'daily', '--out', bundleInContainer]);
      bundle.output = redact(`${made.stdout}${made.stderr}`).trim().split('\n').slice(-3).join(' | ');
      stages.push({
        id: 'an-encrypted-bundle-exists',
        passed: made.code === 0,
        detail: made.code === 0 ? 'the encrypted bundle was created with the real tool' : `the bundle could not be created: ${bundle.output}`,
      });
      if (made.code === 0) {
        const verified = await inContainer(['verify', '--file', bundleInContainer]);
        stages.push({
          id: 'the-bundle-verifies',
          passed: verified.code === 0,
          detail: verified.code === 0 ? 'the bundle verifies with the real tool' : `the bundle did not verify: ${redact((verified.stdout + verified.stderr).trim().split('\n').slice(-1)[0] ?? '')}`,
        });
        const copiedBack = await run('docker', ['cp', `${CONTAINER}:${bundleInContainer}`, bundlePath]);
        if (copiedBack.code === 0) {
          // The bundle is on the host only now, so it is only reported now.
          bundle.path = bundlePath;
          bundle.created = true;
        }
        stages.push({
          id: 'the-bundle-is-on-the-host',
          passed: copiedBack.code === 0,
          detail: copiedBack.code === 0 ? `the encrypted bundle was copied to ${bundlePath}` : `the bundle could not be copied back: ${redact((copiedBack.stdout + copiedBack.stderr).trim())}`,
        });
      }
    }
    await writeFile(join(directory, 'restore-stages.md'), `${commands.join('\n')}\n`, 'utf8');
    return { stages, commands, bundle };
  } finally {
    if (!options.keep) {
      // The container files and the database of this run are removed, and a
      // cleanup that fails is a failure of the run.
      const removed = await run('docker', ['exec', CONTAINER, 'rm', '-f', toolPath, bundleInContainer]);
      if (removed.code !== 0) {
        stages.push({ id: 'the-container-files-are-removed', passed: false, detail: `the container files could not be removed: ${redact((removed.stdout + removed.stderr).trim())}` });
      }
      const dropped = await run('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${database}`]);
      if (dropped.code !== 0) {
        stages.push({ id: 'the-fixture-database-is-removed', passed: false, detail: `the fixture database could not be dropped: ${redact((dropped.stdout + dropped.stderr).trim())}` });
      }
      await rm(binary, { force: true });
    }
  }
}

async function main() {
  const report = await prepareRestoreFixture({ keep: process.argv.includes('--keep') });
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      tool: 'scripts/online/prepare-restore-fixture.mjs',
      disclaimer: 'The stages run against the local fixture container with a database of this run. The restore is not run, because the fence lifecycle of the privacy service is not accepted yet.',
      ...report,
    }, null, 2)}\n`);
  } else {
    for (const stage of report.stages) {
      process.stdout.write(`  ${stage.passed ? 'PASS' : 'FAIL'} ${stage.id}: ${stage.detail}\n`);
    }
    process.stdout.write('the restore stages are prepared in .scratch/restore-fixture/restore-stages.md\n');
  }
  if (report.stages.some((stage) => !stage.passed)) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/online/prepare-restore-fixture.mjs')) {
  await main();
}
