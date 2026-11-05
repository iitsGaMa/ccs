/**
 * Homelab fork: subscription profile attached to Claude quota readings.
 *
 * Kept outside the upstream usage fetcher so its retry and cancellation
 * semantics stay untouched. Failures never hide a valid quota reading.
 */
import { readClaudeAuthData } from './quota-fetcher-claude';
import type { ClaudeQuotaResult } from './quota-types';

type ClaudePlan = NonNullable<ClaudeQuotaResult['plan']>;

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const PROFILE_TTL_MS = 15 * 60_000;
const profileCache = new Map<string, { expires: number; value?: ClaudePlan }>();

function toObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function fetchClaudePlan(accountId: string): Promise<ClaudePlan | undefined> {
  const held = profileCache.get(accountId);
  if (held && held.expires > Date.now()) return held.value;
  let value: ClaudePlan | undefined;
  try {
    const auth = await readClaudeAuthData(accountId);
    if (!auth || auth.isExpired) return held?.value;
    const response = await fetch(PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const org = toObject(toObject(await response.json())?.['organization']);
      if (org) {
        value = {
          organizationType:
            typeof org['organization_type'] === 'string' ? org['organization_type'] : undefined,
          rateLimitTier:
            typeof org['rate_limit_tier'] === 'string' ? org['rate_limit_tier'] : undefined,
        };
      }
    }
  } catch {
    /* Profile failure must not hide valid quotas. */
  }
  profileCache.set(accountId, { expires: Date.now() + PROFILE_TTL_MS, value });
  return value;
}

/** Attach the cached plan to a successful reading, never to an error result. */
export async function withClaudePlan(result: ClaudeQuotaResult): Promise<ClaudeQuotaResult> {
  if (!result.success || !result.accountId) return result;
  const plan = await fetchClaudePlan(result.accountId);
  return plan ? { ...result, plan } : result;
}
