/**
 * Public history and public replay contracts (KHA-78).
 *
 * The public replay and the public game history are allowlisted projections
 * of a completed online match. They are readable without signing in, and they
 * carry the starting position, the accepted moves, the time control, the
 * result, the public participants and the declared control of every accepted
 * move.
 *
 * Two rules shape the module.
 *
 * A declared model label is a declaration, never a provider attestation. The
 * `attribution` block of a replay always states that the source is
 * `declared` and that the provider did not verify it.
 *
 * A control change never relabels earlier play. The control of a move is the
 * control that was in effect when the move was accepted, and the terminal
 * action carries the control of the seat that ended the game.
 *
 * The module never reads a credential. A public read is a signed-out read, and
 * the privacy calls live in `./privacy`.
 */

/** The version of the public replay wire contract. */
export const ONLINE_PUBLIC_REPLAY_SCHEMA_VERSION = 2;

/** The version of the public profile history wire contract. */
export const ONLINE_PROFILE_HISTORY_SCHEMA_VERSION = 1;

/** The declared control of one seat. */
export type OnlineControlKind = 'human' | 'agent' | 'engine';

/** The kind of a published online game. */
export type OnlineGameKind = 'friend' | 'queue' | 'fallback';

/** The result one participant earned in one game. */
export type OnlineOutcome = 'win' | 'draw' | 'loss' | 'abort';

/** The declared control of one seat. */
export interface OnlineDeclaredControl {
  readonly kind: OnlineControlKind;
  /** The publishable model label. It is never a private routing identity. */
  readonly modelLabel?: string;
  /** Always `declared`. The service never attests a provider. */
  readonly declaration: 'declared';
}

/** One public participant of a replay. */
export interface OnlineReplayParticipant {
  readonly seat: 'white' | 'black';
  readonly publicLabel: string;
  /** The control of the seat at the end of the match. */
  readonly control: OnlineDeclaredControl;
}

/** One accepted move with the control that produced it. */
export interface OnlineReplayMove {
  readonly version: number;
  readonly seat: 'white' | 'black';
  readonly uci: string;
  readonly san: string;
  /** The control that was in effect when the move was accepted. */
  readonly control: OnlineDeclaredControl;
}

/** The action that ended the game. */
export interface OnlineTerminalAction {
  readonly kind: string;
  readonly seat: 'white' | 'black';
  /** The control of the seat that performed the action. */
  readonly control: OnlineDeclaredControl;
}

/** How the control of a game is known. */
export interface OnlineAttribution {
  readonly source: 'declared';
  /** Always false. A declared model is not a provider attestation. */
  readonly providerVerified: false;
}

/** The public replay of one completed online match. */
export interface OnlinePublicReplay {
  readonly schemaVersion: number;
  readonly matchId: string;
  readonly variant: 'orthodox';
  readonly startingFen: string;
  readonly timeControl: { readonly startingTimeMs: number; readonly incrementMs: number };
  readonly gameKind: OnlineGameKind;
  /** False for an abort. An abort is published as an unscored game. */
  readonly scored: boolean;
  readonly attribution: OnlineAttribution;
  readonly participants: readonly OnlineReplayParticipant[];
  readonly moves: readonly OnlineReplayMove[];
  readonly terminal: OnlineTerminalAction | null;
  readonly result: { readonly kind: string; readonly winner: 'white' | 'black' | null; readonly reason: string };
  readonly rulesPolicyVersion: string;
  readonly completedAt: string;
}

/** The aggregate result counts of one profile. */
export interface OnlineHistoryTotals {
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  readonly aborts: number;
  /** The scored results. An abort is never scored. */
  readonly scored: number;
}

/** One published game of a profile. */
export interface OnlineHistoryEntry {
  readonly matchId: string;
  readonly replayPath: string;
  readonly gameKind: OnlineGameKind;
  readonly outcome: OnlineOutcome;
  readonly scored: boolean;
  /** `Deleted player` after an ordinary account deletion. */
  readonly opponentLabel: string;
  readonly completedAt: string;
}

/** The public game history of one profile. */
export interface OnlineProfileHistory {
  readonly schemaVersion: number;
  readonly profileId: string;
  readonly totals: OnlineHistoryTotals;
  readonly games: readonly OnlineHistoryEntry[];
}

/** The path of the canonical public replay route. */
export function publicReplayPath(matchId: string): string {
  return `/v1/public/matches/${encodeURIComponent(matchId)}/replay`;
}

/** The path of the public profile history route. */
export function profileHistoryPath(profileId: string): string {
  return `/v1/public/profiles/${encodeURIComponent(profileId)}/history`;
}

/**
 * The compact label of a declared control.
 *
 * The interface renders a compact label instead of a separate list of
 * declared models. A human seat is `Human`, an agent seat is `Agent` with its
 * publishable label, and the browser engine is `Engine` with its label.
 */
export function compactControlLabel(control: OnlineDeclaredControl): string {
  switch (control.kind) {
    case 'human':
      return 'Human';
    case 'agent':
      return control.modelLabel ? `Agent · ${control.modelLabel}` : 'Agent';
    case 'engine':
      return control.modelLabel ? `Engine · ${control.modelLabel}` : 'Engine';
    default:
      return 'Human';
  }
}

/** The options of a signed-out public read. */
export interface OnlinePublicReadOptions {
  /** The trusted service origin. A read never leaves it. */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

/**
 * Reads the public replay of one completed match.
 *
 * The read needs no credential. A match that has not completed and a replay
 * that was removed share the not found answer.
 */
export async function fetchOnlinePublicReplay(
  matchId: string,
  options: OnlinePublicReadOptions,
): Promise<OnlinePublicReplay> {
  const payload = await readPublicJson(options, publicReplayPath(matchId));
  return parseOnlinePublicReplay(payload);
}

/**
 * Reads the public game history of one profile.
 *
 * The read needs no credential.
 */
export async function fetchOnlineProfileHistory(
  profileId: string,
  options: OnlinePublicReadOptions,
): Promise<OnlineProfileHistory> {
  const payload = await readPublicJson(options, profileHistoryPath(profileId));
  return parseOnlineProfileHistory(payload);
}

/** Reads one public JSON document. */
async function readPublicJson(options: OnlinePublicReadOptions, path: string): Promise<unknown> {
  const base = new URL(options.baseUrl);
  const target = new URL(path, base);
  if (target.origin !== base.origin) {
    throw new Error('A public online read must stay on the trusted service origin.');
  }
  const fetcher = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const response = await fetcher(target.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`The public online service answered ${response.status}.`);
  }
  return (await response.json()) as unknown;
}

/** Parses the public replay of one completed online match. */
export function parseOnlinePublicReplay(value: unknown): OnlinePublicReplay {
  const path = 'publicReplay';
  const record = objectValue(value, path);
  onlyKeys(record, [
    'schemaVersion',
    'matchId',
    'variant',
    'startingFen',
    'timeControl',
    'gameKind',
    'scored',
    'attribution',
    'participants',
    'moves',
    'terminal',
    'result',
    'rulesPolicyVersion',
    'completedAt',
  ], path);
  requiredKeys(record, [
    'schemaVersion',
    'matchId',
    'variant',
    'startingFen',
    'timeControl',
    'gameKind',
    'scored',
    'attribution',
    'participants',
    'moves',
    'result',
    'rulesPolicyVersion',
    'completedAt',
  ], path);
  if (integerValue(record.schemaVersion, `${path}.schemaVersion`) !== ONLINE_PUBLIC_REPLAY_SCHEMA_VERSION) {
    throw new Error(`${path}.schemaVersion: unsupported schema version`);
  }
  if (record.variant !== 'orthodox') {
    throw new Error(`${path}.variant: unsupported variant`);
  }
  const gameKind = stringValue(record.gameKind, `${path}.gameKind`);
  if (gameKind !== 'friend' && gameKind !== 'queue' && gameKind !== 'fallback') {
    throw new Error(`${path}.gameKind: unsupported game kind`);
  }
  const scored = booleanValue(record.scored, `${path}.scored`);
  const result = parseResult(record.result, `${path}.result`);
  if (scored === (result.kind === 'abort')) {
    throw new Error(`${path}.scored: an abort is never scored`);
  }
  if (!Array.isArray(record.participants) || record.participants.length !== 2) {
    throw new Error(`${path}.participants: expected two public participants`);
  }
  const participants = record.participants.map((participant, index) => {
    const participantPath = `${path}.participants[${index}]`;
    const item = objectValue(participant, participantPath);
    onlyKeys(item, ['seat', 'publicLabel', 'control'], participantPath);
    requiredKeys(item, ['seat', 'publicLabel', 'control'], participantPath);
    return {
      seat: seatValue(item.seat, `${participantPath}.seat`),
      publicLabel: publicLabelValue(item.publicLabel, `${participantPath}.publicLabel`),
      control: parseControl(item.control, `${participantPath}.control`),
    };
  });
  if (participants[0]?.seat === participants[1]?.seat) {
    throw new Error(`${path}.participants: duplicate public seat`);
  }
  if (!Array.isArray(record.moves)) {
    throw new Error(`${path}.moves: expected moves array`);
  }
  const moves = record.moves.map((move, index) => {
    const movePath = `${path}.moves[${index}]`;
    const item = objectValue(move, movePath);
    onlyKeys(item, ['version', 'seat', 'uci', 'san', 'control'], movePath);
    requiredKeys(item, ['version', 'seat', 'uci', 'san', 'control'], movePath);
    return {
      version: positiveInteger(item.version, `${movePath}.version`),
      seat: seatValue(item.seat, `${movePath}.seat`),
      uci: uciValue(item.uci, `${movePath}.uci`),
      san: sanValue(item.san, `${movePath}.san`),
      control: parseControl(item.control, `${movePath}.control`),
    };
  });
  let terminal: OnlineTerminalAction | null = null;
  if (record.terminal !== undefined && record.terminal !== null) {
    const terminalPath = `${path}.terminal`;
    const item = objectValue(record.terminal, terminalPath);
    onlyKeys(item, ['kind', 'seat', 'control'], terminalPath);
    requiredKeys(item, ['kind', 'seat', 'control'], terminalPath);
    terminal = {
      kind: stringValue(item.kind, `${terminalPath}.kind`),
      seat: seatValue(item.seat, `${terminalPath}.seat`),
      control: parseControl(item.control, `${terminalPath}.control`),
    };
  }
  return {
    schemaVersion: ONLINE_PUBLIC_REPLAY_SCHEMA_VERSION,
    matchId: idValue(record.matchId, `${path}.matchId`),
    variant: 'orthodox',
    startingFen: fenValue(record.startingFen, `${path}.startingFen`),
    timeControl: parseTimeControl(record.timeControl, `${path}.timeControl`),
    gameKind,
    scored,
    attribution: parseAttribution(record.attribution, `${path}.attribution`),
    participants,
    moves,
    terminal,
    result,
    rulesPolicyVersion: stringValue(record.rulesPolicyVersion, `${path}.rulesPolicyVersion`),
    completedAt: timestampValue(record.completedAt, `${path}.completedAt`),
  };
}

/** Parses the public game history of one profile. */
export function parseOnlineProfileHistory(value: unknown): OnlineProfileHistory {
  const path = 'profileHistory';
  const record = objectValue(value, path);
  onlyKeys(record, ['schemaVersion', 'profileId', 'totals', 'games'], path);
  requiredKeys(record, ['schemaVersion', 'profileId', 'totals', 'games'], path);
  if (integerValue(record.schemaVersion, `${path}.schemaVersion`) !== ONLINE_PROFILE_HISTORY_SCHEMA_VERSION) {
    throw new Error(`${path}.schemaVersion: unsupported schema version`);
  }
  const totalsPath = `${path}.totals`;
  const totalsValue = objectValue(record.totals, totalsPath);
  onlyKeys(totalsValue, ['wins', 'draws', 'losses', 'aborts', 'scored'], totalsPath);
  requiredKeys(totalsValue, ['wins', 'draws', 'losses', 'aborts', 'scored'], totalsPath);
  if (!Array.isArray(record.games)) {
    throw new Error(`${path}.games: expected games array`);
  }
  const games = record.games.map((game, index) => {
    const gamePath = `${path}.games[${index}]`;
    const item = objectValue(game, gamePath);
    onlyKeys(item, ['matchId', 'replayPath', 'gameKind', 'outcome', 'scored', 'opponentLabel', 'completedAt'], gamePath);
    requiredKeys(item, ['matchId', 'replayPath', 'gameKind', 'outcome', 'scored', 'opponentLabel', 'completedAt'], gamePath);
    const gameKind = stringValue(item.gameKind, `${gamePath}.gameKind`);
    if (gameKind !== 'friend' && gameKind !== 'queue' && gameKind !== 'fallback') {
      throw new Error(`${gamePath}.gameKind: unsupported game kind`);
    }
    const outcome = stringValue(item.outcome, `${gamePath}.outcome`);
    if (outcome !== 'win' && outcome !== 'draw' && outcome !== 'loss' && outcome !== 'abort') {
      throw new Error(`${gamePath}.outcome: unsupported outcome`);
    }
    return {
      matchId: idValue(item.matchId, `${gamePath}.matchId`),
      replayPath: publicLabelValue(item.replayPath, `${gamePath}.replayPath`),
      gameKind: gameKind as OnlineGameKind,
      outcome: outcome as OnlineOutcome,
      scored: booleanValue(item.scored, `${gamePath}.scored`),
      opponentLabel: publicLabelValue(item.opponentLabel, `${gamePath}.opponentLabel`),
      completedAt: timestampValue(item.completedAt, `${gamePath}.completedAt`),
    };
  });
  return {
    schemaVersion: ONLINE_PROFILE_HISTORY_SCHEMA_VERSION,
    profileId: idValue(record.profileId, `${path}.profileId`),
    totals: {
      wins: nonNegativeInteger(totalsValue.wins, `${totalsPath}.wins`),
      draws: nonNegativeInteger(totalsValue.draws, `${totalsPath}.draws`),
      losses: nonNegativeInteger(totalsValue.losses, `${totalsPath}.losses`),
      aborts: nonNegativeInteger(totalsValue.aborts, `${totalsPath}.aborts`),
      scored: nonNegativeInteger(totalsValue.scored, `${totalsPath}.scored`),
    },
    games,
  };
}

/** Parses the declared control of one seat. */
function parseControl(value: unknown, path: string): OnlineDeclaredControl {
  const record = objectValue(value, path);
  onlyKeys(record, ['kind', 'modelLabel', 'declaration'], path);
  requiredKeys(record, ['kind', 'declaration'], path);
  const kind = stringValue(record.kind, `${path}.kind`);
  if (kind !== 'human' && kind !== 'agent' && kind !== 'engine') {
    throw new Error(`${path}.kind: unsupported control kind`);
  }
  if (record.declaration !== 'declared') {
    throw new Error(`${path}.declaration: an attribution is always declared`);
  }
  if (kind === 'human') {
    if (record.modelLabel !== undefined) {
      throw new Error(`${path}.modelLabel: a human control has no model`);
    }
    return { kind, declaration: 'declared' };
  }
  const modelLabel = publicLabelValue(record.modelLabel, `${path}.modelLabel`);
  return { kind, modelLabel, declaration: 'declared' };
}

/** Parses the attribution of a replay. */
function parseAttribution(value: unknown, path: string): OnlineAttribution {
  const record = objectValue(value, path);
  onlyKeys(record, ['source', 'providerVerified'], path);
  requiredKeys(record, ['source', 'providerVerified'], path);
  if (record.source !== 'declared') {
    throw new Error(`${path}.source: an attribution is always declared`);
  }
  if (record.providerVerified !== false) {
    throw new Error(`${path}.providerVerified: an attribution is never provider verified`);
  }
  return { source: 'declared', providerVerified: false };
}

/** Parses the result of one game. */
function parseResult(value: unknown, path: string): { kind: string; winner: 'white' | 'black' | null; reason: string } {
  const record = objectValue(value, path);
  onlyKeys(record, ['kind', 'winner', 'reason'], path);
  requiredKeys(record, ['kind', 'winner', 'reason'], path);
  const kind = stringValue(record.kind, `${path}.kind`);
  if (kind !== 'win' && kind !== 'draw' && kind !== 'abort') {
    throw new Error(`${path}.kind: unsupported result kind`);
  }
  const winner = record.winner === null ? null : seatValue(record.winner, `${path}.winner`);
  return { kind, winner, reason: stringValue(record.reason, `${path}.reason`) };
}

/** Parses the time control of one game. */
function parseTimeControl(value: unknown, path: string): { startingTimeMs: number; incrementMs: number } {
  const record = objectValue(value, path);
  onlyKeys(record, ['startingTimeMs', 'incrementMs'], path);
  requiredKeys(record, ['startingTimeMs', 'incrementMs'], path);
  const startingTimeMs = positiveInteger(record.startingTimeMs, `${path}.startingTimeMs`);
  const incrementMs = nonNegativeInteger(record.incrementMs, `${path}.incrementMs`);
  if (startingTimeMs > 86_400_000 || incrementMs > 60_000) {
    throw new Error(`${path}: time control out of range`);
  }
  return { startingTimeMs, incrementMs };
}

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path}: expected an object`);
  }
  return value as JsonObject;
}

function onlyKeys(value: JsonObject, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${path}: unexpected field ${key}`);
    }
  }
}

function requiredKeys(value: JsonObject, keys: readonly string[], path: string): void {
  for (const key of keys) {
    if (!(key in value)) {
      throw new Error(`${path}: missing field ${key}`);
    }
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${path}: expected a string`);
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${path}: expected a boolean`);
  }
  return value;
}

function integerValue(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${path}: expected a safe integer`);
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  const number = integerValue(value, path);
  if (number < 1) {
    throw new Error(`${path}: expected a positive integer`);
  }
  return number;
}

function nonNegativeInteger(value: unknown, path: string): number {
  const number = integerValue(value, path);
  if (number < 0) {
    throw new Error(`${path}: expected a non-negative integer`);
  }
  return number;
}

function timestampValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${path}: expected an ISO timestamp`);
  }
  return text;
}

function seatValue(value: unknown, path: string): 'white' | 'black' {
  const text = stringValue(value, path);
  if (text === 'white' || text === 'black') {
    return text;
  }
  throw new Error(`${path}: expected white or black`);
}

function idValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(text)) {
    throw new Error(`${path}: invalid id`);
  }
  return text;
}

function uciValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(text)) {
    throw new Error(`${path}: invalid uci move`);
  }
  return text;
}

function sanValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (text.length < 1 || text.length > 16 || !/^[a-hA-Z1-8=+#xO-]+$/.test(text)) {
    throw new Error(`${path}: invalid SAN`);
  }
  return text;
}

function fenValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (text.length < 4 || text.length > 128 || text.split(' ').length < 6) {
    throw new Error(`${path}: invalid fen`);
  }
  return text;
}

function publicLabelValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (
    text.length < 1 ||
    text.length > 64 ||
    text.trim() !== text ||
    text.includes('@') ||
    text.includes('://') ||
    hasControlCharacter(text)
  ) {
    throw new Error(`${path}: invalid public label`);
  }
  return text;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}
