import type { CloudClient, CloudConflict } from './client';
import { createConflict, matchesCloudSeed } from './client';
import type { CoordinationPort } from './coordinator';
import type { GameCheckpointV1, StoredGameV1 } from '../storage/types';

export interface CloudLocalPort {
  read(gameId: string): Promise<StoredGameV1 | null>;
  knownCredentials(accountId: string): Promise<readonly string[]>;
  acknowledgedArchiveCursor(gameId: string): Promise<{ readonly eventsThrough: number | null; readonly chunksThrough: number | null }>;
  stableOperationId(gameId: string, checkpointRevision: number): Promise<string>;
  prepareCloudCheckpoint(gameId: string, local: GameCheckpointV1, minimumRevision: number, epoch: number): Promise<GameCheckpointV1>;
  recordAcknowledgement(gameId: string, cloudRevision: number, cloudEpoch: number, checkpointRevision: number, cursor: { eventsThrough: number | null; chunksThrough: number | null }): Promise<void>;
  preserveConflict(gameId: string, local: StoredGameV1, cloud: unknown): Promise<void>;
  preserveAcceptedCloudSnapshot(gameId: string, checkpoint: GameCheckpointV1, archiveBatch: unknown): Promise<{ eventsThrough: number | null; chunksThrough: number | null }>;
  beginTakeoverAdoption(gameId: string, expectedRevision: number, expectedEpoch: number): Promise<void>;
  pendingTakeoverAdoption(gameId: string): Promise<{ expectedRevision: number; expectedEpoch: number } | null>;
  clearTakeoverAdoption(gameId: string): Promise<void>;
  adoptAcceptedCloudSnapshot(gameId: string, epoch: number): Promise<{ databaseName: string; registryScope: string }>;
  completeTakeoverAdoption(gameId: string, cloudRevision: number, cloudEpoch: number, checkpointRevision: number, cursor: { eventsThrough: number | null; chunksThrough: number | null }): Promise<void>;
  applyOwnerDeletion(accountId: string, gameId: string): Promise<void>;
}

export type SyncResult =
  | { readonly kind: 'synced'; readonly revision: number; readonly epoch: number; readonly adopted?: true }
  | { readonly kind: 'offline'; readonly message: string }
  | { readonly kind: 'conflict'; readonly conflict: CloudConflict };

export interface CloudSyncManager {
  sync(gameId: string, acknowledgedRevision: number | null, ownershipEpoch: number): Promise<SyncResult>;
  takeover(gameId: string, expectedRevision: number, expectedEpoch: number): Promise<SyncResult>;
  deleteAccountGame(gameId: string, expectedRevision: number, expectedEpoch: number): Promise<void>;
}

export function createCloudSyncManager(options: {
  accountId: string;
  client: CloudClient;
  coordination: CoordinationPort;
  local: CloudLocalPort;
  online?: () => boolean;
  beforeTakeoverAdoption?: (gameId: string) => Promise<void>;
}): CloudSyncManager {
  const { accountId, client, coordination, local } = options;
  const online = options.online ?? (() => typeof navigator === 'undefined' || navigator.onLine);
  return {
    async sync(gameId, acknowledgedRevision, ownershipEpoch) {
      if (!online()) return { kind: 'offline', message: 'Saved locally. Use Sync again when this device is online; the game clock keeps running.' };
      return coordination.run({ gameId, revision: acknowledgedRevision ?? 0, epoch: ownershipEpoch }, async () => {
        let game: StoredGameV1 | null = null;
        try {
          const pending = await local.pendingTakeoverAdoption(gameId);
          if (pending) {
            const head = await client.read(gameId);
            if (head && head.epoch > pending.expectedEpoch) {
              const archive = await client.readArchiveBatch(gameId);
              assertAcceptedArchiveFence(archive, head);
              const cursor = await local.preserveAcceptedCloudSnapshot(gameId, head.checkpoint, archive);
              await options.beforeTakeoverAdoption?.(gameId);
              await local.adoptAcceptedCloudSnapshot(gameId, head.epoch);
              await local.completeTakeoverAdoption(gameId, head.revision, head.epoch, head.checkpoint.revision, cursor);
              coordination.publish({ gameId, revision: head.revision, epoch: head.epoch, kind: 'taken-over' });
              return { kind: 'synced', revision: head.revision, epoch: head.epoch, adopted: true } as const;
            }
            if (head && head.epoch === pending.expectedEpoch && head.revision === pending.expectedRevision) await local.clearTakeoverAdoption(gameId);
            else if (head) {
              game = await local.read(gameId);
              if (!game) throw new Error('The local game is unavailable while recovering cloud takeover.');
              return { kind: 'conflict', conflict: createConflict(game, head) } as const;
            }
          }
          game = await local.read(gameId);
          if (!game || game.checkpoint.namespace.kind !== 'account' || game.checkpoint.namespace.accountId !== accountId) throw new Error('This account cannot sync that local game.');
          if (!online()) return { kind: 'offline', message: 'Saved locally. Use Sync again when this device is online; the game clock keeps running.' } as const;
          const credentials = await local.knownCredentials(accountId);
          let baseRevision = acknowledgedRevision;
          let baseEpoch = ownershipEpoch;
          let accepted: Awaited<ReturnType<CloudClient['read']>>;
          if (baseRevision === null) {
            let created;
            try { created = await client.create(game, credentials); }
            catch (error) {
              if (status(error) !== 409 && !isNetworkFailure(error)) throw error;
              const existing = await client.read(gameId).catch(() => null);
              if (!existing && isNetworkFailure(error)) throw error;
              if (!existing || !matchesCloudSeed(game.checkpoint, existing, accountId)) throw error;
              created = existing;
            }
            baseRevision = created.revision;
            baseEpoch = created.epoch;
          }
          const cursor = await local.acknowledgedArchiveCursor(gameId);
          const cloudCheckpoint = await local.prepareCloudCheckpoint(gameId, game.checkpoint, Math.max(game.checkpoint.revision + 1, 2), baseEpoch);
          const operationId = await local.stableOperationId(gameId, cloudCheckpoint.revision);
          try {
            accepted = (await client.commit({ ...game, checkpoint: cloudCheckpoint }, baseRevision, baseEpoch, operationId, credentials, cursor)).game;
          } catch (error) {
            if (!isNetworkFailure(error)) throw error;
            const receipt = await client.lookupOperation(gameId, operationId).catch(() => null);
            const result = receipt && 'result' in receipt ? receipt.result : null;
            const receiptGame = result && typeof result === 'object' && result !== null && 'id' in result ? result as typeof accepted : null;
            if (!receiptGame) throw error;
            accepted = receiptGame;
          }
          const eventSequence = game.events.at(-1)?.sequence ?? cursor.eventsThrough;
          const chunkSequence = game.chunks.at(-1)?.sequence ?? cursor.chunksThrough;
          const sentCursor = { eventsThrough: eventSequence, chunksThrough: chunkSequence };
          await local.recordAcknowledgement(gameId, accepted.revision, accepted.epoch, accepted.checkpoint.revision, sentCursor);
          coordination.publish({ gameId, revision: accepted.revision, epoch: accepted.epoch, kind: 'changed' });
          return { kind: 'synced', revision: accepted.revision, epoch: accepted.epoch } as const;
        } catch (error) {
          if (status(error) === 409 || status(error) === 412) {
            const cloud = await client.read(gameId).catch(() => null);
            if (game) await local.preserveConflict(gameId, game, cloud);
            if (!game) throw error;
            return { kind: 'conflict', conflict: createConflict(game, cloud) } as const;
          }
          if (isNetworkFailure(error)) return { kind: 'offline', message: 'Saved locally. Use Sync again when this device is online; the game clock keeps running.' } as const;
          throw error;
        }
      });
    },
    async takeover(gameId, expectedRevision, expectedEpoch) {
      if (!online()) return { kind: 'offline', message: 'Takeover needs a connection. Use Take over again when this device is online; the local game remains available.' };
      const game = await local.read(gameId);
      if (!game) throw new Error('The local game is unavailable.');
      return coordination.run({ gameId, revision: expectedRevision, epoch: expectedEpoch }, async () => {
        try {
          await local.beginTakeoverAdoption(gameId, expectedRevision, expectedEpoch);
          const accepted = await client.read(gameId);
          if (!accepted) throw new Error('The accepted cloud game is unavailable.');
          if (accepted.revision !== expectedRevision || accepted.epoch !== expectedEpoch) {
            await local.clearTakeoverAdoption(gameId);
            await local.preserveConflict(gameId, game, { checkpoint: accepted.checkpoint });
            return { kind: 'conflict', conflict: createConflict(game, accepted) } as const;
          }
          const archive = await client.readArchiveBatch(gameId);
          assertAcceptedArchiveFence(archive, accepted);
          await local.preserveAcceptedCloudSnapshot(gameId, accepted.checkpoint, archive);
          await local.preserveConflict(gameId, game, { checkpoint: accepted.checkpoint, archiveBatch: archive });
          const takenOver = await client.takeover(gameId, expectedRevision, expectedEpoch);
          const current = await client.read(gameId);
          if (!current || current.revision !== takenOver.revision || current.epoch !== takenOver.epoch || JSON.stringify(current.checkpoint) !== JSON.stringify(takenOver.checkpoint)) {
            await local.preserveConflict(gameId, game, current);
            return { kind: 'conflict', conflict: createConflict(game, current) } as const;
          }
          const currentArchive = await client.readArchiveBatch(gameId);
          assertAcceptedArchiveFence(currentArchive, current);
          const acceptedCursor = await local.preserveAcceptedCloudSnapshot(gameId, current.checkpoint, currentArchive);
          await options.beforeTakeoverAdoption?.(gameId);
          await local.adoptAcceptedCloudSnapshot(gameId, current.epoch);
          await local.completeTakeoverAdoption(gameId, current.revision, current.epoch, current.checkpoint.revision, acceptedCursor);
          coordination.publish({ gameId, revision: current.revision, epoch: current.epoch, kind: 'taken-over' });
          return { kind: 'synced', revision: current.revision, epoch: current.epoch } as const;
        } catch (error) {
          if (status(error) === 409 || status(error) === 412) {
            const cloud = await client.read(gameId).catch(() => null);
            await local.preserveConflict(gameId, game, cloud);
            return { kind: 'conflict', conflict: createConflict(game, cloud) } as const;
          }
          throw error;
        }
      });
    },
    async deleteAccountGame(gameId, expectedRevision, expectedEpoch) {
      await client.delete(gameId, expectedRevision, expectedEpoch);
      await local.applyOwnerDeletion(accountId, gameId);
      coordination.publish({ gameId, kind: 'deleted' });
    },
  };
}

function status(error: unknown): number | undefined { return typeof error === 'object' && error !== null && 'status' in error ? (error as { status?: number }).status : undefined; }

function assertAcceptedArchiveFence(value: unknown, cloud: NonNullable<Awaited<ReturnType<CloudClient['read']>>>): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('The accepted cloud archive is invalid.');
  const archive = value as Record<string, unknown>;
  if (archive.format !== 'kamkmchess.cloud-archive-batch' || archive.schemaVersion !== 1 || archive.gameId !== cloud.id ||
      archive.baseRevision !== cloud.revision || archive.baseOwnershipEpoch !== cloud.epoch || archive.checkpointRevision !== cloud.checkpoint.revision ||
      !Array.isArray(archive.events) || !Array.isArray(archive.chunks)) {
    throw new Error('The accepted cloud archive does not match the current game revision, ownership epoch, and checkpoint.');
  }
}

function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return typeof DOMException !== 'undefined' && error instanceof DOMException && ['AbortError', 'NetworkError'].includes(error.name);
}
