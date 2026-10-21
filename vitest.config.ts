import { defineConfig } from 'vitest/config';
import { availableParallelism } from 'node:os';

/**
 * The number of workers of the test runner.
 *
 * The suite contains a few CPU bound files: the perft of the rules module, the
 * proof search and the controller flows. The default pool of the runner is the
 * number of the logical processors of the host, so the suite alone saturates
 * every core of a machine that also runs the database suite of the service or
 * a review swarm. The wall clock of a CPU bound file then depends on the
 * other work of the host, and a test that asserts a move count fails with a
 * timeout of the runner instead of with its own assertion.
 *
 * The pool therefore keeps two cores of headroom for the system and for the
 * other processes of the host. The files of the suite are small, so the wall
 * clock of the whole suite hardly moves, and the CPU bound files keep a core
 * each.
 */
const maxWorkers = Math.max(2, availableParallelism() - 2);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
    maxWorkers,
  },
});
