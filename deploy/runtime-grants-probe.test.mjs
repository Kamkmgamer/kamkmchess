// Regression tests of the delivery of the script of the grant probe.
//
// The combined migration script of the repository is larger than the limit of
// a single argument of a process, so the probe has to deliver the script
// through the standard input of the client. A delivery as a command argument
// fails with E2BIG before the script ever reaches the server, which is the
// failure the pull request has to repair.
//
// The tests below need no database: the runner of the client is replaced by a
// recorder, and the process runner is proved with a real child process.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import process from 'node:process';

import { LocalPostgres, evaluateProbe, psqlArguments, runSqlProcess } from './runtime-grants-probe.mjs';

// The kernel refuses a single argument of a process that is larger than this.
const ARGUMENT_LIMIT = 128 * 1024;

/**
 * Builds a recorder that refuses a script that is carried by an argument.
 * @param {{ok?: boolean, stdout?: string, stderr?: string}} [outcome]
 * @returns {{calls: {command: string, args: string[], sql: string, env: Record<string, string>}[], runSql: (options: any) => Promise<{ok: boolean, stdout: string, stderr: string}>}}
 */
function recordingRunner(outcome = {}) {
  /** @type {{command: string, args: string[], sql: string, env: Record<string, string>}[]} */
  const calls = [];
  return {
    calls,
    runSql: async (options) => {
      // The kernel refuses the process before the script reaches the server.
      const length = options.args.reduce((total, argument) => total + argument.length + 1, 0);
      if (length > ARGUMENT_LIMIT) {
        const error = new Error('spawn E2BIG');
        error.code = 'E2BIG';
        throw error;
      }
      calls.push(options);
      return { ok: outcome.ok ?? true, stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '' };
    },
  };
}

test('the arguments of the client read the script from the standard input', () => {
  const args = psqlArguments({ user: 'probe', database: 'probe_db' });
  assert.ok(args.includes('--file'), 'the client does not read a file');
  assert.ok(args.includes('-'), 'the client does not read the standard input');
  assert.ok(args.includes('ON_ERROR_STOP=1'), 'the client does not stop at the first error');
  assert.ok(!args.includes('--command'), 'the client still carries a script as a command argument');
});

test('a script that is larger than the argument limit reaches the server through the standard input', async () => {
  const recorder = recordingRunner();
  const postgres = new LocalPostgres({
    databaseUrl: 'postgres://probe:secret@127.0.0.1:5432/probe_db',
    psqlPath: 'psql',
    runSql: recorder.runSql,
  });
  const sql = `SET search_path TO probe;\n${'-- a statement of the migration\n'.repeat(8000)}`;
  assert.ok(sql.length > ARGUMENT_LIMIT, 'the script of the test is not larger than the limit of an argument');

  const result = await postgres.query(sql);

  assert.equal(result.ok, true);
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].sql, sql);
  assert.ok(
    !recorder.calls[0].args.some((argument) => argument.includes('a statement of the migration')),
    'the script is still carried by an argument of the client',
  );
});

test('the password of the database is only passed in the environment', async () => {
  const recorder = recordingRunner();
  const postgres = new LocalPostgres({
    databaseUrl: 'postgres://probe:secret@127.0.0.1:5432/probe_db',
    psqlPath: 'psql',
    runSql: recorder.runSql,
  });

  await postgres.query('SELECT 1;');

  assert.equal(recorder.calls[0].env.PGPASSWORD, 'secret');
  assert.ok(
    !recorder.calls[0].args.some((argument) => argument.includes('secret')),
    'the password is carried by an argument of the client',
  );
});

test('the script reaches the standard input of a real process', async () => {
  const result = await runSqlProcess({
    command: process.execPath,
    args: ['-e', 'process.stdin.pipe(process.stdout)'],
    sql: 'SELECT 1;\n',
    env: process.env,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'SELECT 1;\n');
});

test('a refused statement is reported as a failure with the message of the server', async () => {
  const result = await runSqlProcess({
    command: process.execPath,
    args: ['-e', 'process.stderr.write("ERROR: permission denied for table games\\n"); process.exit(3);'],
    sql: 'DELETE FROM probe.games;',
    env: process.env,
  });

  assert.equal(result.ok, false);
  assert.match(result.stderr, /permission denied for table games/);
});

test('a refused statement proves that the privilege is missing', async () => {
  const recorder = recordingRunner({ ok: false, stderr: 'ERROR: permission denied for table games' });
  const postgres = new LocalPostgres({
    databaseUrl: 'postgres://probe:secret@127.0.0.1:5432/probe_db',
    psqlPath: 'psql',
    runSql: recorder.runSql,
  });

  const outcome = await postgres.query('DELETE FROM probe.games;');
  const evaluation = evaluateProbe(
    { id: 'deny-delete-games', description: 'the runtime role cannot delete from games', expectation: 'denied', sql: 'DELETE FROM probe.games;' },
    outcome,
  );

  assert.equal(evaluation.passed, true, evaluation.detail);
});

test('a client that cannot be started is a failure and not a crash', async () => {
  const result = await runSqlProcess({
    command: 'kamkmchess-no-such-postgresql-client',
    args: ['--file', '-'],
    sql: 'SELECT 1;',
    env: process.env,
  });

  assert.equal(result.ok, false);
  assert.match(result.stderr, /kamkmchess-no-such-postgresql-client/);
});
