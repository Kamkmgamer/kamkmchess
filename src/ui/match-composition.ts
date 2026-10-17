import { DEFAULT_TIME_CONTROL } from '../clocks/index.js';
import { getOrCreateGameController } from '../controller/index.js';
import type { GameController, GameControllerSetupV1 } from '../controller/index.js';
import { openGameStore } from '../storage/index.js';
import type { GameStore } from '../storage/index.js';

const ACTIVE_GAME_KEY = 'kamkmchess.active-game.v1';
const storePromise = openGameStore();

export interface LocalGameOptions {
  readonly startingFen?: string;
  readonly startingTimeMinutes?: number;
  readonly incrementSeconds?: number;
}

export interface LocalGameSession {
  readonly gameId: string;
  readonly controller: GameController;
}

/** Composition owns storage and the one active game writer for this page lifetime. */
export class MatchComposition {
  async openActiveGame(): Promise<LocalGameSession> {
    const store = await storePromise;
    const savedId = window.localStorage.getItem(ACTIVE_GAME_KEY);
    const gameId = savedId ?? crypto.randomUUID();
    const setup = this.localSetup();
    const session = this.bindController(gameId, store);
    await session.controller.initialize(setup);
    window.localStorage.setItem(ACTIVE_GAME_KEY, gameId);
    return session;
  }

  async startNewLocalGame(options: LocalGameOptions = {}): Promise<LocalGameSession> {
    const store = await storePromise;
    const gameId = crypto.randomUUID();
    const setup = this.localSetup(options);
    const session = this.bindController(gameId, store);
    await session.controller.initialize(setup);
    window.localStorage.setItem(ACTIVE_GAME_KEY, gameId);
    return session;
  }

  private bindController(gameId: string, store: GameStore): LocalGameSession {
    const controller = getOrCreateGameController({
      gameId,
      store,
      clockPolicy: { maxReferenceDivergenceMs: 5_000 },
    });
    return { gameId, controller };
  }

  private localSetup(options: LocalGameOptions = {}): GameControllerSetupV1 {
    const startingTimeMinutes = options.startingTimeMinutes ?? DEFAULT_TIME_CONTROL.startingTimeMs / 60_000;
    const incrementSeconds = options.incrementSeconds ?? DEFAULT_TIME_CONTROL.incrementMs / 1_000;
    return {
      humanSide: 'white',
      namespace: { kind: 'guest' },
      ownershipEpoch: 0,
      ...(options.startingFen === undefined ? {} : { startingFen: options.startingFen }),
      timeControl: {
        startingTimeMs: startingTimeMinutes * 60_000,
        incrementMs: incrementSeconds * 1_000,
      },
    };
  }
}
