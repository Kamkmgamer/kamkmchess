import { describe, expect, it, vi } from 'vitest';
import {
  CONFIRM_ACCOUNT_DELETION,
  CONFIRM_EXPLICIT_REMOVAL,
  accountDeletionPath,
  explicitRemovalPath,
  guestRemovalPath,
  parseOnlinePublicModelLabel,
  parseOnlineRemovalReport,
  publicModelLabelPath,
  registerPublicModelLabel,
  requestAccountDeletion,
  requestExplicitRemoval,
  requestGuestRemoval,
} from './privacy';
import type { AuthorizedRequester, AuthorizedResult } from './request';

const REPORT = {
  schemaVersion: 1,
  removalId: 'rm_public_1',
  scope: 'explicit_removal',
  status: 'applied',
  anonymizedMatches: 0,
  removedMatches: 3,
  verifiedAt: '2026-10-21T10:00:00Z',
  liveDeletedAt: '2026-10-21T10:00:05Z',
  liveDeleteDueAt: '2026-10-22T10:00:00Z',
  recoverySanitizeDueAt: '2026-11-20T10:00:00Z',
};

function stubRequester(data: unknown, ok = true, status = 200) {
  const request = vi.fn(async (_scope: unknown, init: { path: string; method?: string; body?: unknown }) => ({
    status,
    ok,
    data: init.body === undefined ? data : data,
  }));
  return { requester: { request } as unknown as AuthorizedRequester, request };
}

describe('privacy contracts', () => {
  it('reads a removal report', () => {
    const report = parseOnlineRemovalReport(REPORT);
    expect(report.scope).toBe('explicit_removal');
    expect(report.removedMatches).toBe(3);
    expect(report.liveDeleteDueAt).toBe('2026-10-22T10:00:00Z');
  });

  it('refuses an unknown scope and an unknown field', () => {
    expect(() => parseOnlineRemovalReport({ ...REPORT, scope: 'everything' })).toThrow(/unsupported removal scope/);
    expect(() => parseOnlineRemovalReport({ ...REPORT, routingId: 'private-route' })).toThrow(/unexpected field/);
  });

  it('reads a public model label', () => {
    const label = parseOnlinePublicModelLabel({ schemaVersion: 1, labelId: 'kl_public_1', publicLabel: 'My chess model' });
    expect(label.publicLabel).toBe('My chess model');
  });

  it('builds the privacy paths', () => {
    expect(accountDeletionPath()).toBe('/v1/privacy/account/deletion');
    expect(explicitRemovalPath()).toBe('/v1/privacy/account/removal');
    expect(guestRemovalPath()).toBe('/v1/privacy/guest/removal');
    expect(publicModelLabelPath()).toBe('/v1/privacy/account/model-labels');
  });
});

describe('privacy calls', () => {
  it('sends the account deletion confirmation and never a routing identifier', async () => {
    const { requester, request } = stubRequester(REPORT);
    const report = await requestAccountDeletion(requester);
    expect(report.removalId).toBe('rm_public_1');
    const [, init] = request.mock.calls[0] as unknown as [unknown, { path: string; method?: string; body?: unknown }];
    expect(init.path).toBe('/v1/privacy/account/deletion');
    expect(init.method).toBe('POST');
    expect(init.body).toEqual({ confirm: CONFIRM_ACCOUNT_DELETION });
    expect(JSON.stringify(init.body)).not.toContain('routing');
  });

  it('sends the explicit removal confirmation', async () => {
    const { requester, request } = stubRequester(REPORT);
    await requestExplicitRemoval(requester);
    const [, init] = request.mock.calls[0] as unknown as [unknown, { path: string; body?: unknown }];
    expect(init.path).toBe('/v1/privacy/account/removal');
    expect(init.body).toEqual({ confirm: CONFIRM_EXPLICIT_REMOVAL });
  });

  it('sends the guest removal with the guest scope', async () => {
    const { requester, request } = stubRequester(REPORT);
    await requestGuestRemoval(requester, 'match-public-1', 'white');
    const [scope, init] = request.mock.calls[0] as unknown as [unknown, { path: string; body?: unknown }];
    expect(scope).toEqual({ kind: 'match-seat', matchId: 'match-public-1', seat: 'white' });
    expect(init.path).toBe('/v1/privacy/guest/removal');
    expect(init.body).toEqual({ confirm: CONFIRM_EXPLICIT_REMOVAL });
  });

  it('registers the public label without a routing identifier', async () => {
    const { requester, request } = stubRequester({ schemaVersion: 1, labelId: 'kl_public_1', publicLabel: 'My chess model' });
    const label = await registerPublicModelLabel(requester, 'My chess model');
    expect(label.publicLabel).toBe('My chess model');
    const [, init] = request.mock.calls[0] as unknown as [unknown, { path: string; body?: unknown }];
    expect(init.path).toBe('/v1/privacy/account/model-labels');
    expect(init.body).toEqual({ publicLabel: 'My chess model' });
    expect(JSON.stringify(init.body)).not.toContain('routing');
  });

  it('fails when the service refuses the call', async () => {
    const { requester } = stubRequester(null, false, 401);
    await expect(requestAccountDeletion(requester)).rejects.toThrow(/answered 401/);
  });
});

// The answer of the requester is the parsed body of the service.
export type { AuthorizedResult };
