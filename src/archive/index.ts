import { ArchiveError, encodeBase64, sha256Hex } from './codec';
import {
  assertArchiveReferenceIntegrity,
  readArchiveChunk,
  readArchiveEvent,
  readGameArchive,
  readGameCheckpoint,
} from './validation';
import type { ArchiveSnapshotV1, GameArchiveExportV1 } from './types';
import type { ArchiveChunkV1, ArchiveEventV1, GameCheckpointV1 } from '../storage';

export type { ArchiveChunkExportV1, ArchiveSnapshotV1, GameArchiveExportV1 } from './types';
export { ArchiveError } from './codec';
export { sha256Hex } from './codec';
export {
  assertArchiveReferenceIntegrity,
  readArchiveChunk,
  readArchiveEvent,
  readGameCheckpoint,
  verifyChunkDigest,
} from './validation';

export interface PreparedArchiveRecordsV1 {
  events: ArchiveEventV1[];
  chunks: ArchiveChunkV1[];
  quarantined: boolean;
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function joinBytes(chunks: ArchiveChunkV1[]): Uint8Array {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.bytes.length, 0);
  const joined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk.bytes, offset);
    offset += chunk.bytes.length;
  }
  return joined;
}

function jsonContainsText(value: unknown, text: string): boolean {
  if (typeof value === 'string') return value.includes(text);
  if (Array.isArray(value)) return value.some((entry) => jsonContainsText(entry, text));
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, entry]) => key.includes(text) || jsonContainsText(entry, text));
}

export function snapshotKnownCredentials(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ArchiveError('invalid-archive', 'Credential checks must contain strings only.');
  }
  const credentials: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const credential: unknown = value[index];
    if (typeof credential !== 'string') {
      throw new ArchiveError('invalid-archive', 'Credential checks must contain strings only.');
    }
    credentials.push(credential);
  }
  return Object.freeze(credentials);
}

export function checkpointHasCredentialEcho(
  checkpoint: GameCheckpointV1,
  knownCredentials: readonly string[],
): boolean {
  return snapshotKnownCredentials(knownCredentials).some(
    (credential) => credential.length > 0 && jsonContainsText(checkpoint, credential),
  );
}

export function quarantineArchiveEchoes(
  events: ArchiveEventV1[],
  chunks: ArchiveChunkV1[],
  credentials: readonly string[],
): PreparedArchiveRecordsV1 {
  const chunksById = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  const encoder = new TextEncoder();

  for (const credential of credentials) {
    if (typeof credential !== 'string') {
      throw new ArchiveError('invalid-archive', 'Credential checks must contain strings only.');
    }
    if (credential.length === 0) continue;
    const marker = encoder.encode(credential);
    const matchedChunkIds = new Set<string>(
      chunks
        .filter((chunk) => chunk.egressStatus === 'credential-echo-quarantined')
        .map((chunk) => chunk.chunkId),
    );
    for (const chunk of chunks) {
      const { bytes, ...metadata } = chunk;
      if (containsBytes(bytes, marker) || jsonContainsText(metadata, credential)) matchedChunkIds.add(chunk.chunkId);
    }
    for (const event of events) {
      const eventChunks = event.chunkIds
        .map((chunkId) => chunksById.get(chunkId))
        .filter((chunk): chunk is ArchiveChunkV1 => chunk !== undefined);
      if (event.egressStatus === 'credential-echo-quarantined' || event.chunkIds.some((chunkId) => matchedChunkIds.has(chunkId))) {
        event.egressStatus = 'credential-echo-quarantined';
        for (const chunk of eventChunks) matchedChunkIds.add(chunk.chunkId);
      } else if (eventChunks.length > 1 && containsBytes(joinBytes(eventChunks), marker)) {
        event.egressStatus = 'credential-echo-quarantined';
        for (const chunk of eventChunks) matchedChunkIds.add(chunk.chunkId);
      } else if (jsonContainsText(event, credential)) {
        event.egressStatus = 'credential-echo-quarantined';
        for (const chunk of eventChunks) matchedChunkIds.add(chunk.chunkId);
      }
    }
    for (const chunk of chunks) {
      if (matchedChunkIds.has(chunk.chunkId)) chunk.egressStatus = 'credential-echo-quarantined';
    }
  }

  const quarantined =
    events.some((event) => event.egressStatus === 'credential-echo-quarantined') ||
    chunks.some((chunk) => chunk.egressStatus === 'credential-echo-quarantined');
  return { events, chunks, quarantined };
}

export async function prepareArchiveRecords(
  eventInputs: readonly ArchiveEventV1[],
  chunkInputs: readonly ArchiveChunkV1[],
  knownCredentials: readonly string[],
): Promise<PreparedArchiveRecordsV1> {
  const credentials = snapshotKnownCredentials(knownCredentials);
  const events = eventInputs.map((event) => readArchiveEvent(event));
  const chunks = await Promise.all(
    chunkInputs.map(async (chunk) => {
      const normalized = readArchiveChunk(chunk);
      normalized.sha256 = await sha256Hex(normalized.bytes);
      return normalized;
    }),
  );
  const prepared = quarantineArchiveEchoes(events, chunks, credentials);
  return {
    events: [...prepared.events].sort((left, right) => left.sequence - right.sequence),
    chunks: [...prepared.chunks].sort((left, right) => left.sequence - right.sequence),
    quarantined: prepared.quarantined,
  };
}

export async function exportGameArchive(
  snapshot: ArchiveSnapshotV1,
  knownCredentials: readonly string[],
  exportedAtMs = Date.now(),
): Promise<GameArchiveExportV1> {
  const credentials = snapshotKnownCredentials(knownCredentials);
  const checkpoint = readGameCheckpoint(snapshot.checkpoint);
  const prepared = await prepareArchiveRecords(snapshot.events, snapshot.chunks, credentials);
  if (
    prepared.quarantined ||
    checkpoint.archive.egressStatus === 'credential-echo-quarantined' ||
    checkpointHasCredentialEcho(checkpoint, credentials)
  ) {
    snapshot.checkpoint = checkpointWithQuarantine(checkpoint, true);
    for (const preparedEvent of prepared.events) {
      if (preparedEvent.egressStatus !== 'credential-echo-quarantined') continue;
      const original = snapshot.events.find((event) => event.eventId === preparedEvent.eventId);
      if (original) original.egressStatus = 'credential-echo-quarantined';
    }
    for (const preparedChunk of prepared.chunks) {
      if (preparedChunk.egressStatus !== 'credential-echo-quarantined') continue;
      const original = snapshot.chunks.find((chunk) => chunk.chunkId === preparedChunk.chunkId);
      if (original) original.egressStatus = 'credential-echo-quarantined';
    }
    throw new ArchiveError(
      'credential-echo',
      'Export is blocked because the archive contains a recognized credential echo.',
    );
  }
  assertArchiveReferenceIntegrity(checkpoint, prepared.events, prepared.chunks);

  const archive: GameArchiveExportV1 = {
    format: 'kamkmchess.game-archive',
    schemaVersion: 1,
    exportedAtMs,
    checkpoint,
    events: prepared.events,
    chunks: prepared.chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      gameId: chunk.gameId,
      sequence: chunk.sequence,
      receivedAtMs: chunk.receivedAtMs,
      isFinal: chunk.isFinal,
      egressStatus: chunk.egressStatus,
      bytesBase64: encodeBase64(chunk.bytes),
      sha256: chunk.sha256,
    })),
  };
  if (credentials.some((credential) => credential.length > 0 && jsonContainsText(archive, credential))) {
    const encodedEchoChunkIds = new Set(
      archive.chunks
        .filter((chunk) => credentials.some((credential) => credential.length > 0 && chunk.bytesBase64.includes(credential)))
        .map((chunk) => chunk.chunkId),
    );
    snapshot.checkpoint = checkpointWithQuarantine(checkpoint, true);
    for (const chunk of snapshot.chunks) {
      if (encodedEchoChunkIds.has(chunk.chunkId)) chunk.egressStatus = 'credential-echo-quarantined';
    }
    for (const event of snapshot.events) {
      if (!event.chunkIds.some((chunkId) => encodedEchoChunkIds.has(chunkId))) continue;
      event.egressStatus = 'credential-echo-quarantined';
      for (const chunk of snapshot.chunks) {
        if (event.chunkIds.includes(chunk.chunkId)) chunk.egressStatus = 'credential-echo-quarantined';
      }
    }
    throw new ArchiveError('credential-echo', 'Export is blocked because the archive contains a recognized credential echo.');
  }
  return archive;
}

export async function validateGameArchive(value: unknown): Promise<GameArchiveExportV1> {
  return readGameArchive(value);
}

export async function unpackGameArchive(archive: unknown): Promise<ArchiveSnapshotV1> {
  const validated = await readGameArchive(archive);
  const events = validated.events;
  const chunks = await Promise.all(
    validated.chunks.map(async (chunk) => {
      const binary = atob(chunk.bytesBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return {
        chunkId: chunk.chunkId,
        gameId: chunk.gameId,
        sequence: chunk.sequence,
        receivedAtMs: chunk.receivedAtMs,
        isFinal: chunk.isFinal,
        egressStatus: chunk.egressStatus,
        bytes,
        sha256: chunk.sha256,
      };
    }),
  );
  return { checkpoint: validated.checkpoint, events, chunks };
}

export function checkpointWithQuarantine(
  checkpoint: ArchiveSnapshotV1['checkpoint'],
  quarantined: boolean,
): ArchiveSnapshotV1['checkpoint'] {
  if (!quarantined) return checkpoint;
  return {
    ...checkpoint,
    archive: { ...checkpoint.archive, egressStatus: 'credential-echo-quarantined' },
  };
}
