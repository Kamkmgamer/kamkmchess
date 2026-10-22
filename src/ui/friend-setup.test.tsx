/**
 * The setup of a friend invitation (KHA-75).
 *
 * The fixture drives the pure browser rules of the setup and the rendered
 * preview. It sends no request and spends nothing.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { friendInvitationPreview, friendInvitationRequest, isPlayableFen } from './friend-setup';
import { FriendInvitationPreview } from './friend-preview';
import type { FriendInvitation } from '../online/friend-routes.js';

const STANDARD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const CUSTOM_FEN = '8/8/8/8/4k3/8/8/4K3 w - - 0 1';

function invitation(overrides: Partial<FriendInvitation> = {}): FriendInvitation {
  return {
    schemaVersion: 2,
    invitationId: 'invitation-00000001',
    kind: 'link',
    status: 'open',
    inviterLabel: 'Guest',
    inviterSeat: 'white',
    inviterControl: { kind: 'human' },
    timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
    startingFen: null,
    expiresAt: '2026-10-22T10:00:00.000Z',
    createdAt: '2026-10-21T10:00:00.000Z',
    consumedAt: null,
    cancelledAt: null,
    matchId: null,
    ...overrides,
  };
}

describe('the setup of a friend invitation', () => {
  it('sends the color, the clock, the position and the human seat the owner chose', () => {
    const setup = friendInvitationRequest({
      kind: 'link',
      seat: 'black',
      control: 'human',
      recipient: '',
      startingFen: CUSTOM_FEN,
      timeControl: { startingTimeMs: 180_000, incrementMs: 3_000 },
      modelLabel: null,
      accountSignedIn: false,
    });
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    expect(setup.request).toEqual({
      kind: 'link',
      seat: 'black',
      timeControl: { startingTimeMs: 180_000, incrementMs: 3_000 },
      startingFen: CUSTOM_FEN,
      control: { kind: 'human' },
    });
    // A link never names a recipient, so the service never sees one.
    expect('recipientUsername' in setup.request).toBe(false);
  });

  it('sends the public label of the own agent when the owner plays its agent', () => {
    const setup = friendInvitationRequest({
      kind: 'link',
      seat: 'white',
      control: 'agent',
      recipient: '',
      startingFen: '',
      timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
      modelLabel: 'GPT-4o',
      accountSignedIn: false,
    });
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    expect(setup.request.control).toEqual({ kind: 'agent', modelLabel: 'GPT-4o' });
    // The standard position is the absence of a custom position.
    expect('startingFen' in setup.request).toBe(false);
  });

  it('never offers a built-in engine seat in friend setup', () => {
    const setup = friendInvitationRequest({
      kind: 'link',
      seat: 'white',
      control: 'human',
      recipient: '',
      startingFen: '',
      timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
      modelLabel: null,
      accountSignedIn: false,
    });
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    expect(setup.request.control.kind).not.toBe('engine');
  });

  it('names the public name of the recipient of a challenge and refuses a challenge without an account', () => {
    const named = friendInvitationRequest({
      kind: 'challenge',
      seat: 'white',
      control: 'human',
      recipient: ' recipient_name ',
      startingFen: '',
      timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
      modelLabel: null,
      accountSignedIn: true,
    });
    expect(named.ok).toBe(true);
    if (!named.ok) return;
    // The request carries the public name of the recipient. The account
    // subject of the recipient is resolved by the service.
    expect(named.request.recipientUsername).toBe('recipient_name');
    expect('recipientAccountId' in named.request).toBe(false);

    const guest = friendInvitationRequest({
      kind: 'challenge',
      seat: 'white',
      control: 'human',
      recipient: 'user_recipient',
      startingFen: '',
      timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
      modelLabel: null,
      accountSignedIn: false,
    });
    expect(guest.ok).toBe(false);
    if (guest.ok) return;
    expect(guest.message).toBe('Sign in to challenge a friend.');
  });

  it('refuses a challenge without a recipient and an unparsable position', () => {
    const withoutRecipient = friendInvitationRequest({
      kind: 'challenge',
      seat: 'white',
      control: 'human',
      recipient: '   ',
      startingFen: '',
      timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
      modelLabel: null,
      accountSignedIn: true,
    });
    expect(withoutRecipient.ok).toBe(false);
    if (withoutRecipient.ok) return;
    expect(withoutRecipient.message).toBe('Enter the recipient username.');

    const broken = friendInvitationRequest({
      kind: 'link',
      seat: 'white',
      control: 'human',
      recipient: '',
      startingFen: 'not a position',
      timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
      modelLabel: null,
      accountSignedIn: false,
    });
    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.message).toBe('The position is not a valid FEN.');
  });

  it('refuses an agent seat without a model of the owner', () => {
    const setup = friendInvitationRequest({
      kind: 'link',
      seat: 'white',
      control: 'agent',
      recipient: '',
      startingFen: '',
      timeControl: { startingTimeMs: 300_000, incrementMs: 2_000 },
      modelLabel: null,
      accountSignedIn: false,
    });
    expect(setup.ok).toBe(false);
    if (setup.ok) return;
    expect(setup.message).toBe('Choose your agent first.');
  });

  it('reads the standard position and a custom position of the game', () => {
    expect(isPlayableFen(STANDARD_FEN)).toBe(true);
    expect(isPlayableFen(CUSTOM_FEN)).toBe(true);
    expect(isPlayableFen('not a position')).toBe(false);
  });
});

describe('the preview of a friend invitation', () => {
  it('shows the inviter, the color, the clock and the custom board', () => {
    const text = friendInvitationPreview(invitation({ startingFen: CUSTOM_FEN }));
    expect(text).toContain('Guest');
    expect(text).toContain('white');
    expect(text).toContain('Your color black');
    expect(text).toContain('5+2');
    // The board the inviter chose is visible before the acceptance.
    expect(text).toContain(CUSTOM_FEN);
  });

  it('names no pairing that was not agreed', () => {
    const text = friendInvitationPreview(invitation());
    expect(text).not.toContain('agent');
    expect(text).not.toContain('Agent');
    expect(text).not.toContain('engine');
  });

  it('renders the preview of the invitation as the status of the screen', () => {
    const markup = renderToStaticMarkup(<FriendInvitationPreview invitation={invitation({ startingFen: CUSTOM_FEN })} />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('Guest');
    expect(markup).toContain(CUSTOM_FEN);
  });
});
