// Regression tests of the preparation of the throwaway deployment.
//
// The compose configuration mounts the directory of the certificate into the
// container that writes the certificate. A bind mount of a path that does not
// exist is refused by the engine, so the directory has to exist before the
// helper is started. The proof below runs the preparation with a recorder of
// the commands, so the order of the steps is observed without a container.

import assert from 'node:assert/strict';
import { stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { prepare } from './verify-compose-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Builds a recorder of the commands of the preparation.
 *
 * The recorder answers like the engine of the containers does: a bind mount
 * of a path that does not exist is refused.
 * @returns {{calls: {command: string, args: string[]}[], run: (command: string, args: string[]) => Promise<{code: number, stdout: string, stderr: string}>}}
 */
function recordingEngine() {
  /** @type {{command: string, args: string[]}[]} */
  const calls = [];
  return {
    calls,
    run: async (command, args) => {
      calls.push({ command, args });
      const mount = args.find((argument) => argument.startsWith('type=bind,source='));
      if (mount) {
        const source = mount.slice('type=bind,source='.length).split(',target=')[0];
        const exists = await stat(source).then(() => true, () => false);
        if (!exists) {
          return {
            code: 1,
            stdout: '',
            stderr: `docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: ${source}`,
          };
        }
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

test('the directory of the certificate exists before the helper is started', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'kamkmchess-compose-test-'));
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const engine = recordingEngine();

  const prepared = await prepare(root, directory, false, 'kamkmchess-fenceprobe:helper', engine.run);

  assert.equal(prepared.code, 0, prepared.output);
  const mounted = engine.calls.find((call) => call.args.includes('cert'));
  assert.ok(mounted, 'the helper was never started');
  const mount = mounted.args.find((argument) => argument.startsWith('type=bind,source='));
  assert.ok(mount, 'the helper was started without a bind mount');
  const source = mount.slice('type=bind,source='.length).split(',target=')[0];
  assert.equal(source, join(directory, 'tls'));
});

test('the directory of the certificate exists after the preparation', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'kamkmchess-compose-test-'));
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const engine = recordingEngine();

  await prepare(root, directory, false, 'kamkmchess-fenceprobe:helper', engine.run);

  const information = await stat(join(directory, 'tls'));
  assert.ok(information.isDirectory(), 'the directory of the certificate is not a directory');
});

test('the preparation refuses a helper that cannot write the certificate', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'kamkmchess-compose-test-'));
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });

  const prepared = await prepare(root, directory, false, 'kamkmchess-fenceprobe:helper', async () => ({
    code: 1,
    stdout: '',
    stderr: 'the helper refused the certificate',
  }));

  assert.equal(prepared.code, 1);
  assert.match(prepared.output, /the certificate could not be written/);
});
