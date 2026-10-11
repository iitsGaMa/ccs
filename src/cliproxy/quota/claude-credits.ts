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
