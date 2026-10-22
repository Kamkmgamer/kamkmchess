import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  OnlineConfirmPanel,
  OnlineOfferPanel,
  OnlineOwnOfferStatus,
  OnlineRecoveryPanel,
  OnlineWorkspace,
} from './online-workspace';
import {
  acceptOnlineDraw,
  acceptOnlineTakeback,
  claimOnlineWin,
  keepOnlineWaiting,
  offerOnlineDraw,
  offerOnlineTakeback,
  onlineConfirmCopy,
  onlineIncomingOffers,
  onlineOwnOffers,
  onlineRecoveryState,
  onlineTakebackAllowed,
  onlineTakebackMoveNumber,
  onlineTakebackTarget,
} from './online-match-controls';
import { createOnlineComposition } from '../online/composition';
import type { OnlineComposition } from '../online/composition';
import type { OnlineMatchCommandClient } from '../online/match-client';
import type { OnlineClaimInput, OnlinePresenceClient, OnlinePresenceView } from '../online/presence-client';
import type { OnlineMatchView, OnlineOfferView } from '../online/updates';

/**
 * The online match controls of the screen (KHA-74).
 *
 * The tests prove the decisions of the controls and the copy they show: a
 * draw offer is an offer, a takeback names the exact version of the position
 * it restores, and the abandonment claim exists only while the service
 * publishes it.
 */

const MOVE_WHITE: { version: number; seat: 'white'; uci: string; san: string; resultingFen: string } = {
  version: 2,
  seat: 'white',
  uci: 'e2e4',
  san: 'e4',
  resultingFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
};

const MOVE_BLACK: { version: number; seat: 'black'; uci: string; san: string; resultingFen: string } = {
  version: 3,
  seat: 'black',
  uci: 'e7e5',
  san: 'e5',
  resultingFen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
};

function matchView(overrides: Partial<OnlineMatchView> = {}): OnlineMatchView {
  return {
    schemaVersion: 2,
    matchId: 'match-00000001',
    variant: 'orthodox',
    startingFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    positionFen: MOVE_WHITE.resultingFen,
    timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
    version: 3,
    controlEpoch: 1,
    rulesPolicyVersion: 'online-rules/1',
    status: 'active',
    result: null,
    seats: [
      { seat: 'white', publicLabel: 'Alice', control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
      { seat: 'black', publicLabel: 'Bob', control: { kind: 'human' }, controlEpoch: 1, illegalAttemptsSpent: 0, formatCorrectionsSpent: 0 },
    ],
    clock: {
      whiteMs: 300_000,
      blackMs: 300_000,
      activeSeat: 'white',
      activeSince: '2026-10-21T10:00:00.000Z',
      deadlineAt: null,
      whiteMoved: true,
      blackMoved: true,
      turnNumber: 2,
      replySeat: null,
      replyDeadlineAt: null,
    },
    moves: [MOVE_WHITE, MOVE_BLACK],
    pendingOffers: [],
    createdAt: '2026-10-21T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:00.000Z',
    completedAt: null,
    yourSeat: 'white',
    ...overrides,
  };
}

function offer(overrides: Partial<OnlineOfferView> = {}): OnlineOfferView {
  return {
    offerId: 'offer-draw-0001',
    kind: 'draw',
    seat: 'black',
    targetVersion: null,
    baseVersion: 4,
    createdAt: '2026-10-21T10:00:00.000Z',
    ...overrides,
  };
}

function presenceView(overrides: Partial<OnlinePresenceView> = {}): OnlinePresenceView {
  return {
    schemaVersion: 1,
    matchId: 'match-00000001',
    version: 3,
    controlEpoch: 1,
    status: 'active',
    seats: [
      { seat: 'white', state: 'connected', lastHeartbeatAt: '2026-10-21T10:01:00.000Z', leaseExpiresAt: '2026-10-21T10:01:15.000Z', offlineSince: null, keepWaitingAt: null },
      { seat: 'black', state: 'offline', lastHeartbeatAt: '2026-10-21T10:00:00.000Z', leaseExpiresAt: '2026-10-21T10:00:15.000Z', offlineSince: '2026-10-21T10:00:15.000Z', keepWaitingAt: null },
    ],
    serviceState: 'healthy',
    recovered: true,
    claim: {
      eligible: true,
      reason: 'eligible',
      opponentSeat: 'black',
      offlineSince: '2026-10-21T10:00:15.000Z',
      graceSecondsLeft: 0,
      waitingSince: null,
    },
    yourSeat: 'white',
    ...overrides,
  };
}

/** The commands a fake command client received. */
interface CommandCalls {
  offerDraw: number;
  acceptDraw: string[];
  offerTakeback: number[];
  acceptTakeback: string[];
}

/** A command client that records the commands it received. */
function commandRecorder(): { client: OnlineMatchCommandClient; calls: CommandCalls } {
  const calls: CommandCalls = { offerDraw: 0, acceptDraw: [], offerTakeback: [], acceptTakeback: [] };
  const client = {
    setVersion: () => undefined,
    setControlEpoch: () => undefined,
    offerDraw: async () => { calls.offerDraw += 1; },
    acceptDraw: async (offerId: string) => { calls.acceptDraw.push(offerId); },
    offerTakeback: async (targetVersion: number) => { calls.offerTakeback.push(targetVersion); },
    acceptTakeback: async (offerId: string) => { calls.acceptTakeback.push(offerId); },
  } as unknown as OnlineMatchCommandClient;
  return { client, calls };
}

/** The presence calls a fake presence client received. */
interface PresenceCalls {
  keepWaiting: number;
  claims: OnlineClaimInput[];
}

/** A presence client that records the calls it received. */
function presenceRecorder(): { client: OnlinePresenceClient; calls: PresenceCalls } {
  const calls: PresenceCalls = { keepWaiting: 0, claims: [] };
  const client = {
    keepWaiting: async () => {
      calls.keepWaiting += 1;
      return presenceView().seats[0]!;
    },
    claimAbandonment: async (input: OnlineClaimInput) => {
      calls.claims.push(input);
      return {
        schemaVersion: 2,
        matchId: 'match-00000001',
        operationId: 'operation-0001',
        outcome: 'accepted',
        version: 4,
        controlEpoch: 1,
        decidedAt: '2026-10-21T10:02:00.000Z',
      };
    },
  } as unknown as OnlinePresenceClient;
  return { client, calls };
}

describe('the draw offer of an online match', () => {
  it('offers a draw instead of agreeing it', async () => {
    const { client, calls } = commandRecorder();
    await offerOnlineDraw(client);
    // The browser offers the draw. The opponent still has to accept it, so
    // the service never receives an acceptance from this seat.
    expect(calls.offerDraw).toBe(1);
    expect(calls.acceptDraw).toEqual([]);
    expect(onlineConfirmCopy('draw')).toBe('Offer a draw? The opponent must accept.');
    expect(onlineConfirmCopy('draw')).not.toContain('cannot be undone');
  });

  it('accepts the draw offer of the opponent with its exact identifier', async () => {
    const { client, calls } = commandRecorder();
    await acceptOnlineDraw(client, 'offer-draw-0001');
    // The acceptance names the exact offer of the service, and it never offers
    // a draw of its own.
    expect(calls.acceptDraw).toEqual(['offer-draw-0001']);
    expect(calls.offerDraw).toBe(0);
  });
});

describe('the takeback of an online match', () => {
  it('offers the takeback with the exact target version of the position', async () => {
    const view = matchView();
    const target = onlineTakebackTarget(view);
    // The service restores the position of the named version, so the target
    // is the version before the discarded move.
    expect(target).toEqual({ targetVersion: 2, moveNumber: 2 });
    const { client, calls } = commandRecorder();
    await offerOnlineTakeback(client, target?.targetVersion ?? 0);
    expect(calls.offerTakeback).toEqual([2]);
  });

  it('names the opening position for the first move of the match', () => {
    const view = matchView({ moves: [MOVE_WHITE] });
    expect(onlineTakebackTarget(view)).toEqual({ targetVersion: 1, moveNumber: 1 });
  });

  it('finds the move a takeback target discards', () => {
    const view = matchView();
    expect(onlineTakebackMoveNumber(view, 2)).toBe(2);
    expect(onlineTakebackMoveNumber(view, 1)).toBe(1);
    expect(onlineTakebackMoveNumber(view, 99)).toBeNull();
  });

  it('offers the takeback only after the opening exchange', () => {
    expect(onlineTakebackAllowed(matchView())).toBe(true);
    expect(onlineTakebackAllowed(matchView({ status: 'completed' }))).toBe(false);
    expect(onlineTakebackAllowed(matchView({
      clock: { ...matchView().clock, blackMoved: false },
    }))).toBe(false);
  });

  it('accepts the takeback offer of the opponent with its exact identifier', async () => {
    const { client, calls } = commandRecorder();
    await acceptOnlineTakeback(client, 'offer-takeback-0001');
    expect(calls.acceptTakeback).toEqual(['offer-takeback-0001']);
    expect(calls.offerTakeback).toEqual([]);
  });
});

describe('the confirmation of an online match', () => {
  it('distinguishes an offer from a final agreement', () => {
    const draw = renderToStaticMarkup(<OnlineConfirmPanel
      action="draw"
      busy={false}
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />);
    // The draw is an offer, so the copy never claims that it is done.
    expect(draw).toContain('Offer a draw? The opponent must accept.');
    expect(draw).not.toContain('cannot be undone');
    const takeback = renderToStaticMarkup(<OnlineConfirmPanel
      action="takeback"
      busy={false}
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />);
    expect(takeback).toContain('Offer a takeback? The opponent must accept.');
    expect(takeback).not.toContain('cannot be undone');
    const resign = renderToStaticMarkup(<OnlineConfirmPanel
      action="resign"
      busy={false}
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />);
    // The resignation is final, so the copy says that it cannot be undone.
    expect(resign).toContain('Resign this game? It cannot be undone.');
  });

  it('names the confirmation group of the action', () => {
    const draw = renderToStaticMarkup(<OnlineConfirmPanel action="draw" busy={false} onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(draw).toContain('aria-label="Confirm draw offer"');
    const takeback = renderToStaticMarkup(<OnlineConfirmPanel action="takeback" busy={false} onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(takeback).toContain('aria-label="Confirm takeback offer"');
    const resign = renderToStaticMarkup(<OnlineConfirmPanel action="resign" busy={false} onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(resign).toContain('aria-label="Confirm resignation"');
  });

  it('names the move a takeback offer discards', () => {
    const takeback = renderToStaticMarkup(<OnlineConfirmPanel
      action="takeback"
      busy={false}
      moveNumber={2}
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />);
    expect(takeback).toContain('Take back move 2? The opponent must accept.');
  });
});

describe('the offers of an online match', () => {
  it('separates the offers of the opponent from the offers of this browser', () => {
    const view = matchView({
      pendingOffers: [
        offer({ offerId: 'offer-draw-0001', seat: 'black' }),
        offer({ offerId: 'offer-takeback-0001', kind: 'takeback', seat: 'white', targetVersion: 2 }),
      ],
    });
    expect(onlineIncomingOffers(view, 'white').map(entry => entry.offerId)).toEqual(['offer-draw-0001']);
    expect(onlineOwnOffers(view, 'white').map(entry => entry.offerId)).toEqual(['offer-takeback-0001']);
  });

  it('hides an offer that the owner ignored', () => {
    const view = matchView({ pendingOffers: [offer({ offerId: 'offer-draw-0001', seat: 'black' })] });
    expect(onlineIncomingOffers(view, 'white', ['offer-draw-0001'])).toEqual([]);
  });

  it('offers an explicit acceptance and an ignore action', () => {
    const view = matchView();
    const markup = renderToStaticMarkup(<OnlineOfferPanel
      view={view}
      offers={onlineIncomingOffers(matchView({ pendingOffers: [offer()] }), 'white')}
      busy={false}
      onAccept={() => undefined}
      onIgnore={() => undefined}
    />);
    expect(markup).toContain('aria-label="Offers of the opponent"');
    expect(markup).toContain('aria-label="Accept draw offer"');
    expect(markup).toContain('aria-label="Ignore offer"');
    expect(markup).toContain('The opponent offered a draw.');
  });

  it('names the takeback offer of the opponent with its move', () => {
    const view = matchView();
    const markup = renderToStaticMarkup(<OnlineOfferPanel
      view={view}
      offers={[offer({ offerId: 'offer-takeback-0001', kind: 'takeback', seat: 'black', targetVersion: 2 })]}
      busy={false}
      onAccept={() => undefined}
      onIgnore={() => undefined}
    />);
    expect(markup).toContain('aria-label="Accept takeback offer"');
    expect(markup).toContain('The opponent offered a takeback of move 2.');
  });

  it('shows the open offer of this browser as an offer', () => {
    const view = matchView();
    const markup = renderToStaticMarkup(<OnlineOwnOfferStatus
      view={view}
      offers={[offer({ offerId: 'offer-draw-0002', seat: 'white' })]}
    />);
    expect(markup).toContain('aria-label="Your offers"');
    expect(markup).toContain('Draw offered. The opponent must accept.');
    expect(markup).not.toContain('cannot be undone');
  });
});

describe('the recovery of an offline opponent', () => {
  it('offers the claim only while the service published it', () => {
    const eligible = onlineRecoveryState(presenceView());
    expect(eligible.claimAllowed).toBe(true);
    expect(eligible.keepWaitingAllowed).toBe(true);
    expect(eligible.note).toContain('claim the win');

    // The grace period of the offline minute is not a claim yet.
    const waiting = onlineRecoveryState(presenceView({
      claim: {
        eligible: false,
        reason: 'offline-grace-period',
        opponentSeat: 'black',
        offlineSince: '2026-10-21T10:00:15.000Z',
        graceSecondsLeft: 20,
        waitingSince: null,
      },
    }));
    expect(waiting.claimAllowed).toBe(false);
    expect(waiting.keepWaitingAllowed).toBe(true);
    expect(waiting.note).toContain('20 seconds');

    // A degraded service never offers the claim.
    const degraded = onlineRecoveryState(presenceView({ serviceState: 'degraded' }));
    expect(degraded.claimAllowed).toBe(false);
    expect(degraded.keepWaitingAllowed).toBe(true);

    // A service that is still recovering offers nothing. It is not serving,
    // so it cannot confirm that the opponent is absent.
    const recovering = onlineRecoveryState(presenceView({ recovered: false }));
    expect(recovering.claimAllowed).toBe(false);
    expect(recovering.keepWaitingAllowed).toBe(false);
    expect(recovering.note).toContain('not available');
  });

  it('says nothing while the opponent is connected', () => {
    const connected = onlineRecoveryState(presenceView({
      seats: [
        { seat: 'white', state: 'connected', lastHeartbeatAt: '2026-10-21T10:01:00.000Z', leaseExpiresAt: '2026-10-21T10:01:15.000Z', offlineSince: null, keepWaitingAt: null },
        { seat: 'black', state: 'connected', lastHeartbeatAt: '2026-10-21T10:01:00.000Z', leaseExpiresAt: '2026-10-21T10:01:15.000Z', offlineSince: null, keepWaitingAt: null },
      ],
    }));
    expect(connected.note).toBe('');
    expect(connected.claimAllowed).toBe(false);
    expect(connected.keepWaitingAllowed).toBe(false);
  });

  it('renders the claim and the keep waiting action of the published state', () => {
    const markup = renderToStaticMarkup(<OnlineRecoveryPanel
      presence={presenceView()}
      busy={false}
      onClaim={() => undefined}
      onKeepWaiting={() => undefined}
    />);
    expect(markup).toContain('aria-label="Opponent offline"');
    expect(markup).toContain('aria-label="Claim win"');
    expect(markup).toContain('aria-label="Keep waiting"');
  });

  it('offers no claim while the service withholds it', () => {
    const markup = renderToStaticMarkup(<OnlineRecoveryPanel
      presence={presenceView({
        claim: {
          eligible: false,
          reason: 'offline-grace-period',
          opponentSeat: 'black',
          offlineSince: '2026-10-21T10:00:15.000Z',
          graceSecondsLeft: 20,
          waitingSince: null,
        },
      })}
      busy={false}
      onClaim={() => undefined}
      onKeepWaiting={() => undefined}
    />);
    expect(markup).not.toContain('aria-label="Claim win"');
    expect(markup).toContain('aria-label="Keep waiting"');
  });

  it('claims the win with the version and the epoch the browser saw', async () => {
    const { client, calls } = presenceRecorder();
    await claimOnlineWin(client, { expectedVersion: 3, controlEpoch: 1 });
    expect(calls.claims).toEqual([{ expectedVersion: 3, controlEpoch: 1 }]);
  });

  it('keeps waiting without conceding a result', async () => {
    const { client, calls } = presenceRecorder();
    await keepOnlineWaiting(client);
    expect(calls.keepWaiting).toBe(1);
    expect(calls.claims).toEqual([]);
  });
});

/**
 * The screen with the new controls.
 *
 * The composition publishes the canonical view of the match, so the screen
 * renders the offers of the opponent and the new actions of the board tools.
 */
function compositionWithView(view: OnlineMatchView): OnlineComposition {
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/updates') ? { schemaVersion: 1, cursor: view.version, snapshot: view } : view;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return createOnlineComposition({ baseUrl: 'https://api.example.test', fetch: fetcher });
}

/** Lets the workspace learn the canonical view of the match. */
async function untilSnapshot(composition: OnlineComposition): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (composition.workspace.state('match-00000001')?.snapshot === null && Date.now() < deadline) {
    await new Promise<void>(resolve => { setTimeout(resolve, 10); });
  }
}

describe('the online screen with the match controls', () => {
  it('names the draw action as an offer and offers a takeback', async () => {
    const composition = compositionWithView(matchView());
    composition.workspace.attach({
      matchId: 'match-00000001',
      seat: 'white',
      credential: {
        kind: 'guest',
        guestId: 'guest-1',
        matchId: 'match-00000001',
        seat: 'white',
        issue: async () => 'token',
      },
    });
    await untilSnapshot(composition);
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => undefined} />);
    // The online draw is an offer, so the action never promises an agreement.
    expect(markup).toContain('aria-label="Offer a draw"');
    expect(markup).not.toContain('Agree a draw');
    // The takeback is offered with its own action.
    expect(markup).toContain('aria-label="Offer a takeback"');
    composition.dispose();
  });

  it('renders the acceptance of the offer of the opponent', async () => {
    const composition = compositionWithView(matchView({
      pendingOffers: [offer({ offerId: 'offer-draw-0001', seat: 'black' })],
    }));
    composition.workspace.attach({
      matchId: 'match-00000001',
      seat: 'white',
      credential: {
        kind: 'guest',
        guestId: 'guest-1',
        matchId: 'match-00000001',
        seat: 'white',
        issue: async () => 'token',
      },
    });
    await untilSnapshot(composition);
    const markup = renderToStaticMarkup(<OnlineWorkspace composition={composition} onClose={() => undefined} />);
    expect(markup).toContain('aria-label="Accept draw offer"');
    expect(markup).toContain('aria-label="Ignore offer"');
    expect(markup).toContain('The opponent offered a draw.');
    composition.dispose();
  });
});
