import { describe, expect, it } from 'vitest';
import { accountUsage, totalUsage, type UsageRateCardV1 } from './usage';

const rates: UsageRateCardV1 = {
  providerId: 'provider',
  modelRoutingId: 'model-alias',
  currency: 'USD',
  source: 'provider published pricing',
  effectiveAt: '2026-10-01',
  perMillionTokens: { input: 1, cachedInput: 0.5, cacheWriteInput: 1.25, output: 2 },
};

describe('native usage accounting', () => {
  it('[CST-03] accounts Chat Completions cache reads without double-counting reasoning output', () => {
    const row = accountUsage({
      requestId: 'chat-1', purpose: 'move', outcome: 'complete', recordedAt: '2026-10-18T00:00:00Z',
      protocol: 'chat-completions',
      rawUsage: { prompt_tokens: 1_000, completion_tokens: 400, prompt_tokens_details: { cached_tokens: 600 }, completion_tokens_details: { reasoning_tokens: 250 } },
      rateCard: rates,
    });
    expect(row.billedTokens).toEqual({ input: 400, cachedInput: 600, output: 400 });
    expect(row.estimate).toEqual({ amount: 0.0015, currency: 'USD' });
    expect(row.rawUsage).toMatchObject({ completion_tokens_details: { reasoning_tokens: 250 } });
    expect(row.status).toBe('estimated');
  });

  it('[CST-03] preserves Responses native categories and separates reported provider charges', () => {
    const row = accountUsage({
      requestId: 'response-1', purpose: 'format-correction', outcome: 'failed', recordedAt: '2026-10-18T00:01:00Z',
      protocol: 'responses',
      rawUsage: { input_tokens: 500, output_tokens: 200, input_tokens_details: { cached_tokens: 300 }, output_tokens_details: { reasoning_tokens: 100 }, future_field: 'kept' },
      rateCard: rates,
      measuredCharge: { amount: 0.0008, currency: 'USD', source: 'provider invoice record', recordedAt: '2026-10-18T00:02:00Z', providerChargeId: 'charge-1' },
    });
    expect(row.estimate).toEqual({ amount: 0.00075, currency: 'USD' });
    expect(row.measuredCharge?.amount).toBe(0.0008);
    expect(row.status).toBe('estimated-and-measured');
    expect(row.rawUsage).toMatchObject({ future_field: 'kept' });
  });

  it('[CST-03] accounts Anthropic cache creation and cache reads as separate billed categories', () => {
    const row = accountUsage({
      requestId: 'messages-1', purpose: 'diagnostic', outcome: 'complete', recordedAt: '2026-10-18T00:03:00Z',
      protocol: 'anthropic-messages',
      rawUsage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 300, output_tokens: 50 },
      rateCard: rates,
    });
    expect(row.billedTokens).toEqual({ input: 100, cachedInput: 200, cacheWriteInput: 300, output: 50 });
    expect(row.estimate).toEqual({ amount: 0.000675, currency: 'USD' });
  });

  it('[CST-03] reports missing usage or rates as unknown rather than zero', () => {
    const missingUsage = accountUsage({
      requestId: 'missing', purpose: 'manual-retry', outcome: 'aborted', recordedAt: 'now',
      protocol: 'responses', rawUsage: null, rateCard: rates,
    });
    const missingRate = accountUsage({
      requestId: 'missing-rate', purpose: 'other', outcome: 'complete', recordedAt: 'now',
      protocol: 'responses', rawUsage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
    });
    expect(missingUsage).toMatchObject({ status: 'unknown', estimate: null, unknownReason: 'usage-missing' });
    expect(missingRate).toMatchObject({ status: 'unknown', estimate: null, unknownReason: 'rate-missing' });
    expect(totalUsage([missingUsage, missingRate])).toMatchObject({ estimatedAmount: null, measuredAmount: null, unknownRequests: 2 });
  });

  it('[CST-03] does not combine incompatible currencies and keeps request purpose visible', () => {
    const usd = accountUsage({
      requestId: 'usd', purpose: 'move', outcome: 'complete', recordedAt: 'now', protocol: 'responses',
      rawUsage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } }, rateCard: { ...rates, perMillionTokens: { input: 1, output: 1 } },
    });
    const eur = accountUsage({
      requestId: 'eur', purpose: 'manual-retry', outcome: 'failed', recordedAt: 'later', protocol: 'responses',
      rawUsage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } }, rateCard: { ...rates, currency: 'EUR', perMillionTokens: { input: 1, output: 1 } },
    });
    expect(totalUsage([usd, eur]).currency).toBeNull();
    expect(eur.purpose).toBe('manual-retry');
    expect(eur.outcome).toBe('failed');
  });
});
