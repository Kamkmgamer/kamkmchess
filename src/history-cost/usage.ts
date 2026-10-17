import type { ProviderProtocol } from '../providers/protocols';

export type UsageCostCategoryV1 = 'input' | 'cachedInput' | 'cacheWriteInput' | 'output';

export interface UsageRateCardV1 {
  providerId: string;
  modelRoutingId: string;
  currency: string;
  source: string;
  effectiveAt: string;
  perMillionTokens: Partial<Record<UsageCostCategoryV1, number>>;
}

export interface MeasuredChargeV1 {
  amount: number;
  currency: string;
  source: string;
  recordedAt: string;
  providerChargeId?: string;
}

export interface UsageRequestContextV1 {
  requestId: string;
  purpose: 'move' | 'diagnostic' | 'format-correction' | 'manual-retry' | 'other';
  outcome: 'complete' | 'failed' | 'incomplete' | 'aborted';
  recordedAt: string;
  protocol: ProviderProtocol;
  rawUsage: unknown | null;
  rateCard?: UsageRateCardV1;
  measuredCharge?: MeasuredChargeV1;
}

export interface UsageAccountingV1 {
  requestId: string;
  purpose: UsageRequestContextV1['purpose'];
  outcome: UsageRequestContextV1['outcome'];
  recordedAt: string;
  protocol: ProviderProtocol;
  rawUsage: unknown | null;
  billedTokens: Partial<Record<UsageCostCategoryV1, number>> | null;
  rateCard: UsageRateCardV1 | null;
  estimate: { amount: number; currency: string } | null;
  measuredCharge: MeasuredChargeV1 | null;
  status: 'estimated' | 'measured' | 'estimated-and-measured' | 'unknown';
  unknownReason?: 'usage-missing' | 'usage-incomplete' | 'rate-missing' | 'currency-mismatch';
}

interface NormalizedUsage {
  categories: Partial<Record<UsageCostCategoryV1, number>>;
  complete: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function normalizeUsage(protocol: ProviderProtocol, value: unknown | null): NormalizedUsage | null {
  const usage = record(value);
  if (usage === null) return null;
  if (protocol === 'anthropic-messages') {
    const input = count(usage.input_tokens);
    const output = count(usage.output_tokens);
    const cacheRead = count(usage.cache_read_input_tokens);
    const cacheWrite = count(usage.cache_creation_input_tokens);
    const categories: NormalizedUsage['categories'] = {};
    if (input !== undefined) categories.input = input;
    if (cacheRead !== undefined) categories.cachedInput = cacheRead;
    if (cacheWrite !== undefined) categories.cacheWriteInput = cacheWrite;
    if (output !== undefined) categories.output = output;
    return {
      categories,
      complete: input !== undefined && output !== undefined && cacheRead !== undefined && cacheWrite !== undefined,
    };
  }

  const isResponses = protocol === 'responses';
  const input = count(isResponses ? usage.input_tokens : usage.prompt_tokens);
  const output = count(isResponses ? usage.output_tokens : usage.completion_tokens);
  const inputDetails = record(isResponses ? usage.input_tokens_details : usage.prompt_tokens_details);
  const cached = count(inputDetails?.cached_tokens);
  const categories: NormalizedUsage['categories'] = {};
  if (input !== undefined) {
    if (cached !== undefined) {
      if (cached > input) return { categories, complete: false };
      categories.input = input - cached;
      categories.cachedInput = cached;
    } else {
      categories.input = input;
    }
  }
  if (output !== undefined) categories.output = output;
  // Reasoning tokens are already included in output_tokens/completion_tokens.
  return {
    categories,
    complete: input !== undefined && output !== undefined && cached !== undefined,
  };
}

function estimate(
  usage: NormalizedUsage,
  rates: UsageRateCardV1,
): { amount: number; currency: string } | null {
  let amount = 0;
  for (const category of ['input', 'cachedInput', 'cacheWriteInput', 'output'] as const) {
    const tokens = usage.categories[category];
    if (tokens === undefined) continue;
    const rate = rates.perMillionTokens[category];
    if (rate === undefined) {
      if (tokens === 0) continue;
      return null;
    }
    if (!Number.isFinite(rate) || rate < 0) return null;
    amount += tokens * rate / 1_000_000;
  }
  return { amount, currency: rates.currency };
}

export function accountUsage(request: UsageRequestContextV1): UsageAccountingV1 {
  const normalized = normalizeUsage(request.protocol, request.rawUsage);
  const rateCard = request.rateCard ?? null;
  const measuredCharge = request.measuredCharge ?? null;
  let estimateResult: UsageAccountingV1['estimate'] = null;
  let unknownReason: UsageAccountingV1['unknownReason'];

  if (normalized === null) {
    unknownReason = 'usage-missing';
  } else if (!normalized.complete) {
    unknownReason = 'usage-incomplete';
  } else if (rateCard === null) {
    unknownReason = 'rate-missing';
  } else {
    estimateResult = estimate(normalized, rateCard);
    if (estimateResult === null) unknownReason = 'rate-missing';
    if (measuredCharge !== null && measuredCharge.currency !== rateCard.currency) {
      unknownReason = 'currency-mismatch';
    }
  }

  const status: UsageAccountingV1['status'] = estimateResult !== null && measuredCharge !== null
    ? 'estimated-and-measured'
    : estimateResult !== null
      ? 'estimated'
      : measuredCharge !== null
        ? 'measured'
        : 'unknown';

  return {
    requestId: request.requestId,
    purpose: request.purpose,
    outcome: request.outcome,
    recordedAt: request.recordedAt,
    protocol: request.protocol,
    rawUsage: request.rawUsage,
    billedTokens: normalized?.categories ?? null,
    rateCard,
    estimate: estimateResult,
    measuredCharge,
    status,
    ...(unknownReason === undefined ? {} : { unknownReason }),
  };
}

export interface UsageTotalV1 {
  currency: string | null;
  estimatedAmount: number | null;
  measuredAmount: number | null;
  unknownRequests: number;
  requestCount: number;
}

export function totalUsage(rows: readonly UsageAccountingV1[]): UsageTotalV1 {
  const currencies = new Set<string>();
  let estimatedAmount = 0;
  let measuredAmount = 0;
  let hasEstimate = false;
  let hasMeasured = false;
  let unknownRequests = 0;
  for (const row of rows) {
    if (row.estimate !== null) {
      currencies.add(row.estimate.currency);
      estimatedAmount += row.estimate.amount;
      hasEstimate = true;
    }
    if (row.measuredCharge !== null) {
      currencies.add(row.measuredCharge.currency);
      measuredAmount += row.measuredCharge.amount;
      hasMeasured = true;
    }
    if (row.status === 'unknown') unknownRequests += 1;
  }
  if (currencies.size > 1) {
    return { currency: null, estimatedAmount: null, measuredAmount: null, unknownRequests, requestCount: rows.length };
  }
  return {
    currency: currencies.values().next().value ?? null,
    estimatedAmount: hasEstimate ? estimatedAmount : null,
    measuredAmount: hasMeasured ? measuredAmount : null,
    unknownRequests,
    requestCount: rows.length,
  };
}
