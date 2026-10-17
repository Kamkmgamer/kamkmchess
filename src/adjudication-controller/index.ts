import type { AdjudicationAnalysisRunnerV1 } from '../adjudication/index.js';
import type {
  AdjudicationWorkV1,
  ControllerFenceV1,
  ControllerSnapshotV1,
  GameController,
} from '../controller/index.js';

export interface ControllerAnalysisV1 {
  /** One explicit action authorizes one bounded pass. */
  continueAnalysis(fence: ControllerFenceV1): Promise<ControllerSnapshotV1>;
  stopAnalysis(fence: ControllerFenceV1): Promise<ControllerSnapshotV1>;
  close(): Promise<void>;
}

function sameFence(left: ControllerFenceV1, right: ControllerFenceV1): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.gameId === right.gameId && left.segmentId === right.segmentId &&
    left.side === right.side && left.revision === right.revision &&
    left.positionRevision === right.positionRevision &&
    left.requestGeneration === right.requestGeneration &&
    left.analysisGeneration === right.analysisGeneration &&
    left.ownershipEpoch === right.ownershipEpoch &&
    left.modelConfigurationIdentity === right.modelConfigurationIdentity;
}

/** Connects durable controller authorization to local Worker execution. */
export function createControllerAnalysis(
  controller: GameController,
  runner: AdjudicationAnalysisRunnerV1,
): ControllerAnalysisV1 {
  let active: AdjudicationWorkV1 | null = null;
  let closed = false;
  const cancelActive = () => {
    const prior = active;
    active = null;
    if (prior !== null) runner.stopAnalysis(prior.requestId);
  };
  const unsubscribe = controller.subscribe((snapshot) => {
    if (active !== null && !sameFence(active.fence, snapshot.fence)) cancelActive();
  });

  return {
    async continueAnalysis(fence) {
      if (closed) throw new Error('The controller analysis session is closed.');
      const work = await controller.continueAdjudication(fence);
      if (closed || work === null) return controller.snapshot();
      const snapshot = controller.snapshot();
      if (!sameFence(work.fence, snapshot.fence)) return snapshot;
      cancelActive();
      active = work;
      try {
        const result = await runner.continueAnalysis({
          requestId: work.requestId,
          namespace: snapshot.checkpoint.namespace,
          query: work.query,
        });
        if (closed || active !== work) return controller.snapshot();
        return await controller.acceptAdjudicationResult({
          requestId: work.requestId,
          fence: work.fence,
          query: work.query,
          result,
        });
      } finally {
        if (active === work) active = null;
      }
    },

    async stopAnalysis(fence) {
      if (closed) throw new Error('The controller analysis session is closed.');
      // Fence the durable result before letting a cancellation reply run.
      // A stale Stop must leave the current authorized pass alone.
      return await controller.stopAdjudication(fence);
    },

    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      const prior = active;
      cancelActive();
      runner.close();
      if (prior !== null) {
        const snapshot = controller.snapshot();
        if (snapshot.adjudication.requestId === prior.requestId) {
          await controller.stopAdjudication(snapshot.fence);
        }
      }
    },
  };
}
