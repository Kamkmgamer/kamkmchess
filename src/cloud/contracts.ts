import type { ArchiveChunkV1, ArchiveEventV1, GameCheckpointV1, JsonValue } from '../storage/types';
import { readGameCheckpoint } from '../archive';

export interface CloudGameV1 {
  readonly id: string;
  readonly revision: number;
  readonly epoch: number;
  readonly checkpoint: GameCheckpointV1;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CloudOperationReceiptV1 {
  readonly game: CloudGameV1;
  readonly operation: JsonValue;
  readonly duplicate: boolean;
}

export interface CloudArchiveBatchV1 {
  readonly format: 'kamkmchess.cloud-archive-batch';
  readonly schemaVersion: 1;
  readonly gameId: string;
  readonly baseRevision: number | null;
  readonly baseOwnershipEpoch: number;
  readonly checkpointRevision: number;
  readonly eventsAfterSequence: number | null;
  readonly eventsThroughSequence: number | null;
  readonly chunksAfterSequence: number | null;
  readonly chunksThroughSequence: number | null;
  readonly events: readonly ArchiveEventV1[];
  readonly chunks: readonly CloudChunkV1[];
}

export interface CloudChunkV1 extends Omit<ArchiveChunkV1, 'bytes'> {
  readonly bytesBase64: string;
}

export function createCloudArchiveBatch(
  gameId: string,
  baseRevision: number | null,
  baseOwnershipEpoch: number,
  checkpoint: GameCheckpointV1,
  events: readonly ArchiveEventV1[],
  chunks: readonly ArchiveChunkV1[],
  cursor: { readonly eventsThrough: number | null; readonly chunksThrough: number | null } = { eventsThrough: null, chunksThrough: null },
): CloudArchiveBatchV1 {
  const sortedEvents = [...events].filter((event) => cursor.eventsThrough === null || event.sequence > cursor.eventsThrough).sort((a, b) => a.sequence - b.sequence);
  const sortedChunks = [...chunks].filter((chunk) => cursor.chunksThrough === null || chunk.sequence > cursor.chunksThrough).sort((a, b) => a.sequence - b.sequence);
  return {
    format: 'kamkmchess.cloud-archive-batch',
    schemaVersion: 1,
    gameId,
    baseRevision,
    baseOwnershipEpoch,
    checkpointRevision: checkpoint.revision,
    eventsAfterSequence: cursor.eventsThrough,
    eventsThroughSequence: sortedEvents.at(-1)?.sequence ?? cursor.eventsThrough,
    chunksAfterSequence: cursor.chunksThrough,
    chunksThroughSequence: sortedChunks.at(-1)?.sequence ?? cursor.chunksThrough,
    events: sortedEvents,
    chunks: sortedChunks.map((chunk) => {
      const { bytes, ...record } = chunk;
      return { ...record, bytesBase64: bytesToBase64(bytes) };
    }),
  };
}

export function assertAccountCheckpoint(checkpoint: GameCheckpointV1, accountId: string, credentials: readonly string[] = []): void {
  checkpoint = readGameCheckpoint(checkpoint);
  if (checkpoint.namespace.kind !== 'account' || checkpoint.namespace.accountId !== accountId) {
    throw new Error('Only the signed-in account namespace can be sent to cloud sync.');
  }
  if (checkpoint.archive.egressStatus !== 'eligible') throw new Error('This archive is quarantined and must stay local until its credential echo is resolved.');
  if (containsCredentialField(checkpoint.extensions) || checkpointContainsCredential(checkpoint, credentials)) {
    throw new Error('The checkpoint contains credential data and was kept local.');
  }
}

export function assertAccountArchive(game: { readonly events: readonly ArchiveEventV1[]; readonly chunks: readonly ArchiveChunkV1[] }, credentials: readonly string[] = []): void {
  if (!Array.isArray(credentials) || credentials.some((credential) => typeof credential !== 'string')) throw new Error('Credential checks must contain strings only.');
  const eventText = JSON.stringify(game.events);
  if (game.events.some((event) => event.egressStatus !== 'eligible')) throw new Error('A quarantined archive event must stay local until its credential echo is resolved.');
  if (game.chunks.some((chunk) => chunk.egressStatus !== 'eligible')) throw new Error('A quarantined archive chunk must stay local until its credential echo is resolved.');
  if (credentials.some((secret) => secret && (eventText.includes(secret) || game.chunks.some((chunk) => bytesIncludeText(chunk.bytes, secret))))) {
    throw new Error('The archive contains credential data and was kept local.');
  }
}

function checkpointContainsCredential(checkpoint: GameCheckpointV1, credentials: readonly string[]): boolean {
  if (!Array.isArray(credentials) || credentials.some((credential) => typeof credential !== 'string')) {
    throw new Error('Credential checks must contain strings only.');
  }
  const encoded = JSON.stringify(checkpoint);
  return credentials.some((secret) => secret.length > 0 && encoded.includes(secret));
}

function containsCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentialField);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, nested]) => /api.?key|authorization|access.?token|secret|credential.?values/i.test(key) || containsCredentialField(nested));
}

function bytesIncludeText(bytes: Uint8Array, value: string): boolean {
  const marker = new TextEncoder().encode(value);
  if (!marker.length || marker.length > bytes.length) return false;
  outer: for (let start = 0; start <= bytes.length - marker.length; start += 1) {
    for (let offset = 0; offset < marker.length; offset += 1) if (bytes[start + offset] !== marker[offset]) continue outer;
    return true;
  }
  return false;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
