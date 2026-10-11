export interface ClaudeCreditAmount {
  value: number;
  currency: string;
}
export interface ClaudeCredits {
  enabled?: boolean;
  reason?: string;
  used?: ClaudeCreditAmount;
  limit?: ClaudeCreditAmount;
  balance?: ClaudeCreditAmount;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function amount(value: unknown): ClaudeCreditAmount | undefined {
  const raw = object(value);
  if (
    !raw ||
    typeof raw.amount_minor !== 'number' ||
    !Number.isFinite(raw.amount_minor) ||
    raw.amount_minor < 0 ||
    typeof raw.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(raw.currency) ||
    typeof raw.exponent !== 'number' ||
    !Number.isInteger(raw.exponent) ||
    raw.exponent < 0 ||
    raw.exponent > 6
  )
    return undefined;
  return { value: raw.amount_minor / 10 ** raw.exponent, currency: raw.currency };
}
/** Spend caps and wallet balances are distinct; never derive one from the other. */
export function claudeCredits(payload: Record<string, unknown>): ClaudeCredits | undefined {
  const spend = object(payload.spend);
  if (!spend) return undefined;
  return {
    enabled: typeof spend.enabled === 'boolean' ? spend.enabled : undefined,
    reason: typeof spend.disabled_reason === 'string' ? spend.disabled_reason : undefined,
    used: amount(spend.used),
    limit: amount(spend.limit),
    balance: amount(spend.balance),
  };
}

/** Promotional cloud credits follow CodexBar's interpretation of iguana_necktie.
 * Values are USD already; never mix them with prepaid spend or recurring quotas.
 */
export function claudeCloudCredits(payload: Record<string, unknown>) {
  const raw = object(payload.iguana_necktie);
  if (!raw) return undefined;
  const limit = raw.limit_dollars;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return undefined;
  const valid = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= limit;
  if (raw.used_dollars != null && !valid(raw.used_dollars)) return undefined;
  if (raw.remaining_dollars != null && !valid(raw.remaining_dollars)) return undefined;
  const remaining = valid(raw.remaining_dollars)
    ? raw.remaining_dollars
    : valid(raw.used_dollars)
      ? limit - raw.used_dollars
      : undefined;
  if (remaining === undefined) return undefined;
  const expiry =
    raw.resets_at == null
      ? undefined
      : typeof raw.resets_at === 'string'
        ? Date.parse(raw.resets_at)
        : NaN;
  if (expiry !== undefined && !Number.isFinite(expiry)) return undefined;
  return {
    limitDollars: limit,
    usedDollars: limit - remaining,
    remainingDollars: remaining,
    expiresAt: expiry === undefined ? undefined : new Date(expiry).toISOString(),
    locked: typeof raw.locked_reason === 'string' && raw.locked_reason.trim().length > 0,
  };
}
