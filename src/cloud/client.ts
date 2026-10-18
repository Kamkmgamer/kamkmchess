import { assertAccountArchive, assertAccountCheckpoint, createCloudArchiveBatch } from './contracts';
import type { CloudGameV1, CloudOperationReceiptV1 } from './contracts';
import type { GameCheckpointV1, StoredGameV1 } from '../storage/types';
import { readGameCheckpoint } from '../archive';

export interface CloudRuntimeConfig {
  readonly apiBaseUrl?: string;
}

export interface CloudClientOptions {
  readonly config: CloudRuntimeConfig;
  readonly accountId: string;
  readonly getToken: () => Promise<string>;
  readonly fetcher?: typeof fetch;
}

export interface CloudConflict {
  readonly kind: 'revision-conflict';
  readonly local: StoredGameV1;
  readonly cloud: CloudGameV1 | null;
  readonly message: string;
}

export interface CloudClient {
  read(gameId: string): Promise<CloudGameV1 | null>;
  readArchiveBatch(gameId: string): Promise<unknown>;
  create(game: StoredGameV1, knownCredentials?: readonly string[]): Promise<CloudGameV1>;
  commit(game: StoredGameV1, expectedRevision: number, expectedEpoch: number, operationId: string, knownCredentials?: readonly string[], cursor?: { eventsThrough: number | null; chunksThrough: number | null }): Promise<CloudOperationReceiptV1>;
  lookupOperation(gameId: string, operationId: string): Promise<JsonObject | null>;
  takeover(gameId: string, expectedRevision: number, expectedEpoch: number): Promise<CloudGameV1>;
  delete(gameId: string, expectedRevision: number, expectedEpoch: number): Promise<void>;
}

type JsonObject = Record<string, unknown>;

export class GoCloudClient implements CloudClient {
  private readonly base: URL;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: CloudClientOptions) {
    if (!options.config.apiBaseUrl) throw new Error('Cloud sync is not configured.');
    this.base = new URL(options.config.apiBaseUrl);
    if (!['https:', 'http:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash) {
      throw new Error('The cloud API base URL is invalid.');
    }
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname);
    if (this.base.protocol !== 'https:' && !localHost) throw new Error('The cloud API must use HTTPS outside localhost development.');
    this.fetcher = options.fetcher ?? fetch;
  }

  async read(gameId: string): Promise<CloudGameV1 | null> {
    try { return parseCloudGame(await this.request(`/v1/games/${encodeURIComponent(gameId)}`), this.options.accountId, gameId); }
    catch (error) { if (statusOf(error) === 404) return null; throw error; }
  }

  async readArchiveBatch(gameId: string): Promise<unknown> {
    return this.request(`/v1/games/${encodeURIComponent(gameId)}/archive-batch`);
  }

  async create(game: StoredGameV1, knownCredentials: readonly string[] = []): Promise<CloudGameV1> {
    const checkpoint = createCloudSeedCheckpoint(game.checkpoint, this.options.accountId);
    assertAccountCheckpoint(checkpoint, this.options.accountId, knownCredentials);
    assertAccountArchive(game, knownCredentials);
    const response = await this.request('/v1/games', { method: 'POST', body: JSON.stringify({ gameId: checkpoint.gameId, checkpoint }) });
    return parseCloudGame(response, this.options.accountId, checkpoint.gameId);
  }

  async commit(game: StoredGameV1, expectedRevision: number, expectedEpoch: number, operationId: string, knownCredentials: readonly string[] = [], cursor = { eventsThrough: null, chunksThrough: null }): Promise<CloudOperationReceiptV1> {
    const checkpoint = game.checkpoint;
    assertAccountCheckpoint(checkpoint, this.options.accountId, knownCredentials);
    assertAccountArchive(game, knownCredentials);
    const archiveBatch = createCloudArchiveBatch(checkpoint.gameId, expectedRevision, expectedEpoch, checkpoint, game.events, game.chunks, cursor);
    return parseReceipt(await this.request(`/v1/games/${encodeURIComponent(checkpoint.gameId)}/commit`, {
      method: 'POST', body: JSON.stringify({ operationId, expectedRevision, expectedEpoch, checkpoint, archiveBatch }),
    }), this.options.accountId, checkpoint.gameId);
  }

  async lookupOperation(gameId: string, operationId: string): Promise<JsonObject | null> {
    try { return asObject(await this.request(`/v1/games/${encodeURIComponent(gameId)}/operations/${encodeURIComponent(operationId)}`)); }
    catch (error) { if (statusOf(error) === 404) return null; throw error; }
  }

  async takeover(gameId: string, expectedRevision: number, expectedEpoch: number): Promise<CloudGameV1> {
    return parseCloudGame(await this.request(`/v1/games/${encodeURIComponent(gameId)}/takeover`, {
      method: 'POST', body: JSON.stringify({ expectedRevision, expectedEpoch }),
    }), this.options.accountId, gameId);
  }

  async delete(gameId: string, expectedRevision: number, expectedEpoch: number): Promise<void> {
    await this.request(`/v1/games/${encodeURIComponent(gameId)}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision, expectedEpoch }) });
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.options.getToken();
    const response = await this.fetcher(new URL(path, this.base), {
      ...init,
      credentials: 'omit',
      redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
    if (!response.ok) {
      const failure = new Error(`Cloud API request failed (${response.status}).`) as Error & { status?: number };
      failure.status = response.status;
      throw failure;
    }
    if (response.status === 204) return null;
    return response.json();
  }
}

export function createCloudSeedCheckpoint(checkpoint: GameCheckpointV1, accountId: string): GameCheckpointV1 {
  if (checkpoint.namespace.kind !== 'account' || checkpoint.namespace.accountId !== accountId) {
    throw new Error('Only an explicitly account-owned game can be created in cloud storage.');
  }
  const seed: GameCheckpointV1 = {
    ...checkpoint,
    revision: 1,
    ownershipEpoch: 1,
    rules: { ...checkpoint.rules, moves: [] },
    history: {
      ...checkpoint.history,
      segments: checkpoint.history.segments.map((segment) => ({ ...segment, messageIds: [] })),
      messages: [],
    },
    archive: {
      ...checkpoint.archive,
      currentLine: { ...checkpoint.archive.currentLine, eventIds: [] },
      discardedLines: [],
    },
  };
  return readGameCheckpoint(seed);
}

export function matchesCloudSeed(local: GameCheckpointV1, cloud: CloudGameV1, accountId: string): boolean {
  return JSON.stringify(createCloudSeedCheckpoint(local, accountId)) === JSON.stringify(cloud.checkpoint);
}

export function createConflict(local: StoredGameV1, cloud: CloudGameV1 | null): CloudConflict {
  return { kind: 'revision-conflict', local, cloud, message: 'Cloud history changed elsewhere. Both the local continuation and acknowledged cloud history are preserved; choose an explicit takeover or continue separately.' };
}

export function readCloudRuntimeConfig(value: unknown): CloudRuntimeConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const config = typeof source.cloud === 'object' && source.cloud !== null ? source.cloud as Record<string, unknown> : source;
  return typeof config.apiBaseUrl === 'string' && config.apiBaseUrl.trim() === config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {};
}

function parseCloudGame(value: unknown, accountId: string, expectedGameId?: string): CloudGameV1 {
  const object = asObject(value);
  if (typeof object.id !== 'string' || !Number.isSafeInteger(object.revision) || (object.revision as number) < 1 || !Number.isSafeInteger(object.epoch) || (object.epoch as number) < 1 || typeof object.createdAt !== 'string' || typeof object.updatedAt !== 'string' || expectedGameId && object.id !== expectedGameId) {
    throw new Error('The cloud API returned an invalid game record.');
  }
  const checkpoint = readGameCheckpoint(object.checkpoint);
  if (checkpoint.gameId !== object.id || checkpoint.namespace.kind !== 'account' || checkpoint.namespace.accountId !== accountId || checkpoint.ownershipEpoch > (object.epoch as number)) {
    throw new Error('The cloud API returned a game with an invalid identity or ownership epoch.');
  }
  return { id: object.id, revision: object.revision as number, epoch: object.epoch as number, checkpoint, createdAt: object.createdAt, updatedAt: object.updatedAt };
}

function parseReceipt(value: unknown, accountId: string, gameId: string): CloudOperationReceiptV1 {
  const object = asObject(value);
  if (typeof object.duplicate !== 'boolean') throw new Error('The cloud API returned an invalid operation receipt.');
  return { game: parseCloudGame(object.game, accountId, gameId), operation: object.operation as never, duplicate: object.duplicate };
}

function asObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('The cloud API returned an invalid response.');
  return value as JsonObject;
}

function statusOf(error: unknown): number | undefined { return typeof error === 'object' && error !== null && 'status' in error ? (error as { status?: number }).status : undefined; }
