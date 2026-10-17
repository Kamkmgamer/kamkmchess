import type { ControllerSnapshotV1, GameController, GameControllerIntentResultV1 } from '../controller/index.js';
import type { CoordinateMove, Promotion, Square } from '../rules/index.js';

const SQUARE = /^[a-h][1-8]$/;

export function parseCoordinateMove(value: string): CoordinateMove | null {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(normalized)) return null;
  const move: CoordinateMove = {
    from: normalized.slice(0, 2) as Square,
    to: normalized.slice(2, 4) as Square,
  };
  const promotion = normalized[4] as Promotion | undefined;
  return promotion === undefined ? move : { ...move, promotion };
}

export function isSquare(value: string): value is Square {
  return SQUARE.test(value);
}

/** All board input reaches the controller through this fenced human-move intent. */
export function submitBoardMove(
  controller: GameController,
  snapshot: ControllerSnapshotV1,
  move: CoordinateMove,
): Promise<GameControllerIntentResultV1> {
  return controller.dispatch({ schemaVersion: 1, kind: 'human-move', fence: snapshot.fence, move });
}

/** Start a local game only after the controller has accepted setup classification evidence. */
export function startClassifiedLocalGame(
  controller: GameController,
  snapshot: ControllerSnapshotV1,
): Promise<ControllerSnapshotV1> {
  if (snapshot.adjudication.status !== 'setup-ready' ||
      snapshot.checkpoint.result.kind !== 'pending-adjudication' ||
      snapshot.checkpoint.clocks.activeSide !== null) return Promise.resolve(snapshot);
  return controller.startGame(snapshot.fence);
}

export function isLocalBoardInputDisabled(snapshot: ControllerSnapshotV1, working: boolean): boolean {
  return working || snapshot.checkpoint.result.kind !== 'unresolved' || snapshot.readiness !== 'ready' ||
    snapshot.clockReading?.status !== 'running';
}
