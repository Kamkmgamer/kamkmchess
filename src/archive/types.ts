import type {
  ArchiveChunkV1,
  ArchiveEventV1,
  GameCheckpointV1,
} from '../storage';

export interface ArchiveSnapshotV1 {
  checkpoint: GameCheckpointV1;
  events: ArchiveEventV1[];
  chunks: ArchiveChunkV1[];
}

export interface ArchiveChunkExportV1 {
  chunkId: string;
  gameId: string;
  sequence: number;
  receivedAtMs: number;
  isFinal: boolean;
  egressStatus: 'eligible' | 'credential-echo-quarantined';
  bytesBase64: string;
  sha256: string;
}

export interface GameArchiveExportV1 {
  format: 'kamkmchess.game-archive';
  schemaVersion: 1;
  exportedAtMs: number;
  checkpoint: GameCheckpointV1;
  events: ArchiveEventV1[];
  chunks: ArchiveChunkExportV1[];
}
