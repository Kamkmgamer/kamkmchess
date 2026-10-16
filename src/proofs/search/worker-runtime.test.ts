import { describe, expect, it, vi } from 'vitest';
import type { ProofSearchPassResult } from './types.js';
import type { ProofSearchWorkerReplyV1 } from './worker.js';
import type { ProofQuery } from '../types.js';
import type { ProofSearchPassOptionsV1 } from './types.js';
import { installProofSearchWorkerRuntime } from './worker-runtime.js';
import { createDeadnessQuery } from '../queries.js';
import { runProofSearchPass } from './search.js';

const query = createDeadnessQuery({
  gameId: 'worker-fixture', segmentId: 'segment-1', positionRevision: '1',
  analysisGeneration: '1', ownershipEpoch: '1',
  positionFen: 'k1b5/1p1p4/1P1P4/8/8/4p1p1/4P1P1/5B1K w - - 0 1',
});

function harness(run: (query: ProofQuery, options: ProofSearchPassOptionsV1) => Promise<ProofSearchPassResult>) {
  let receive: ((event: { data: unknown }) => void) | undefined;
  const replies: ProofSearchWorkerReplyV1[] = [];
  installProofSearchWorkerRuntime({
    addEventListener: (_type, listener) => { receive = listener; },
    postMessage: (reply) => { replies.push(reply); },
  }, run);
  return {
    replies,
    send(data: unknown) { receive?.({ data }); },
  };
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('proof search Worker runtime (ADJ-03/05/08)', () => {
  it('starts and resumes a pass with its query, checkpoint, and resource limits', async () => {
    const run = vi.fn(runProofSearchPass);
    const worker = harness(run);
    worker.send({ type: 'start', requestId: 'start-1', query, maxDiscoveredStates: 1, timeBudgetMs: 300 });
    await Promise.resolve();
    expect(run).toHaveBeenLastCalledWith(query, { maxDiscoveredStates: 1, timeBudgetMs: 300, signal: expect.any(AbortSignal) });
    expect(worker.replies[0]).toMatchObject({ type: 'result', requestId: 'start-1', result: { status: 'non-result', reason: 'state-budget' } });

    const firstReply = worker.replies[0];
    if (firstReply?.type !== 'result' || firstReply.result.status !== 'non-result' || firstReply.result.checkpoint === null) {
      throw new Error('A state cutoff must return a resumable non-result.');
    }
    const checkpoint = firstReply.result.checkpoint;
    worker.send({ type: 'resume', requestId: 'resume-1', query, checkpoint, maxDiscoveredStates: 8 });
    await vi.waitFor(() => expect(worker.replies).toHaveLength(2));
    expect(run).toHaveBeenLastCalledWith(query, { checkpoint, maxDiscoveredStates: 8, signal: expect.any(AbortSignal) });
    expect(worker.replies[1]).toMatchObject({ type: 'result', requestId: 'resume-1', result: { status: 'accepted', conclusion: 'dead' } });
  });

  it('forwards cancellation and publishes the resumable cancelled non-result', async () => {
    const cancellationQuery = createDeadnessQuery({
      gameId: 'worker-cancel', segmentId: 'segment-1', positionRevision: '1',
      analysisGeneration: '1', ownershipEpoch: '1',
      positionFen: '7k/8/8/NNNNN3/8/NNNNNNNN/8/KNNNNNNN w - - 0 1',
    });
    const worker = harness(runProofSearchPass);
    worker.send({ type: 'start', requestId: 'cancel-1', query: cancellationQuery });
    worker.send({ type: 'cancel', requestId: 'cancel-1' });
    await vi.waitFor(() => expect(worker.replies).toHaveLength(1));
    expect(worker.replies).toMatchObject([{ type: 'result', requestId: 'cancel-1', result: { status: 'non-result', reason: 'cancelled', checkpoint: expect.any(Object) } }]);
  });

  it('reports malformed requests and invalid resource limits', () => {
    const worker = harness(runProofSearchPass);
    worker.send({ type: 'resume', requestId: 'bad', query: {} });
    worker.send({ type: 'start', requestId: 'negative', query: {}, maxDiscoveredStates: -1 });
    worker.send({ type: 'start', requestId: 'extra', query: {}, surprise: true });
    expect(worker.replies).toEqual([
      { type: 'error', requestId: 'bad', reason: 'invalid-message' },
      { type: 'error', requestId: 'negative', reason: 'invalid-message' },
      { type: 'error', requestId: 'extra', reason: 'invalid-message' },
    ]);
  });

  it('does not publish an accepted verdict after explicit cancellation', async () => {
    const pending = deferred<ProofSearchPassResult>();
    const accepted = await runProofSearchPass(query);
    expect(accepted.status).toBe('accepted');
    const worker = harness(() => pending.promise);
    worker.send({ type: 'start', requestId: 'late-verdict', query });
    worker.send({ type: 'cancel', requestId: 'late-verdict' });
    pending.resolve(accepted);
    await pending.promise;
    expect(worker.replies).toEqual([]);
  });

  it('supersedes duplicate request IDs and prevents a stale pass from publishing', async () => {
    const first = deferred<ProofSearchPassResult>();
    const second = deferred<ProofSearchPassResult>();
    let firstSignal: AbortSignal | undefined;
    const receivedQueries: ProofQuery[] = [];
    let invocation = 0;
    const run = vi.fn((receivedQuery: ProofQuery, options: ProofSearchPassOptionsV1) => {
      receivedQueries.push(receivedQuery);
      firstSignal ??= options.signal;
      return invocation++ === 0 ? first.promise : second.promise;
    });
    const worker = harness(run);
    worker.send({ type: 'start', requestId: 'same', query });
    worker.send({ type: 'resume', requestId: 'same', query, checkpoint: null });
    expect(firstSignal?.aborted).toBe(true);
    expect(receivedQueries).toEqual([query, query]);
    const accepted = await runProofSearchPass(query);
    second.resolve(accepted);
    await vi.waitFor(() => expect(worker.replies).toHaveLength(1));
    if (!firstSignal) throw new Error('The first pass must receive its abort signal.');
    first.resolve(accepted);
    await Promise.resolve();
    expect(worker.replies).toHaveLength(1);
    expect(worker.replies[0]).toMatchObject({ type: 'result', requestId: 'same', result: { status: 'accepted' } });
  });
});
