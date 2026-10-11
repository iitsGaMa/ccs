/**
 * Claude Quota Response Normalization Helpers
 *
 * Parses Anthropic policy-limits or OAuth-usage payloads into normalized windows and core usage summary.
 */

import type { ClaudeCoreUsageSummary, ClaudeQuotaWindow } from './quota-types';
import { clampPercent } from '../../utils/percentage';

// Distinguishes epoch milliseconds from seconds (1e12 ~= 2001-09-09T01:46:40Z).
const EPOCH_MS_THRESHOLD = 1e12;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeTimestamp(value: unknown): string | null {
  const asNum = asNumber(value);
  if (asNum !== null) {
    const millis = asNum > EPOCH_MS_THRESHOLD ? asNum : asNum * 1000;
    const date = new Date(millis);
    return isNaN(date.getTime()) ? null : date.toISOString();
  }

  const str = asString(value);
  if (!str) return null;

  // Numeric strings can be either epoch seconds or epoch milliseconds.
  if (/^\d+$/.test(str)) {
    const numeric = Number(str);
    if (isFinite(numeric)) {
      const millis = numeric > EPOCH_MS_THRESHOLD ? numeric : numeric * 1000;
      const date = new Date(millis);
      return isNaN(date.getTime()) ? null : date.toISOString();
    }
  }

  const date = new Date(str);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

function getClaudeWindowLabel(rateLimitType: string): string {
  switch (rateLimitType) {
    case 'five_hour':
      return 'Session limit';
    case 'seven_day':
      return 'Weekly limit';
    case 'seven_day_opus':
      return 'Opus limit';
    case 'seven_day_sonnet':
      return 'Sonnet limit';
    case 'seven_day_oauth_apps':
      return 'OAuth apps limit';
    case 'seven_day_cowork':
      return 'Cowork limit';
    case 'overage':
      return 'Extra usage';
    default:
      if (!rateLimitType) return 'Unknown limit';
      return rateLimitType
        .split(/[_-]+/g)
        .filter((part) => part.length > 0)
        .map((part) =>
          /^\d+$/.test(part) ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`
        )
        .join(' ');
  }
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Unit of the `utilization` field in a Claude quota payload.
 *
 * Anthropic exposes utilization in two different units depending on the
 * payload form:
 *   - The `restrictions` payload (array or object map) returns a 0..1 ratio
 *     (e.g. 0.25 for 25% used).
 *   - The OAuth `oauth/usage` endpoint returns a percent value 0..100
 *     (e.g. 25 for 25% used; values like 1 for 1% used).
 *
 * The previous heuristic of "value <= 1 means ratio, otherwise percent"
 * silently misinterpreted boundary values like 1.0 (1% used) from the
 * OAuth payload as 100% used. Each call site now passes the unit it
 * knows it is parsing.
 */
type UtilizationUnit = 'ratio' | 'percent';

function normalizeUtilization(
  raw: Record<string, unknown>,
  unit: UtilizationUnit
): {
  utilization: number | null;
  usedPercent: number;
  remainingPercent: number;
} {
  const utilizationRaw = asNumber(raw['utilization']);
  const usedPercentRaw = asNumber(raw['usedPercent'] ?? raw['used_percent']);
  const remainingPercentRaw = asNumber(raw['remainingPercent'] ?? raw['remaining_percent']);

  if (utilizationRaw !== null) {
    const usedPercent =
      unit === 'ratio'
        ? clampPercent(clampUnit(utilizationRaw) * 100)
        : clampPercent(utilizationRaw);
    return {
      utilization: usedPercent / 100,
      usedPercent,
      remainingPercent: clampPercent(100 - usedPercent),
    };
  }

  if (usedPercentRaw !== null) {
    const usedPercent = clampPercent(usedPercentRaw);
    return {
      utilization: usedPercent / 100,
      usedPercent,
      remainingPercent: clampPercent(100 - usedPercent),
    };
  }

  if (remainingPercentRaw !== null) {
    const remainingPercent = clampPercent(remainingPercentRaw);
    const usedPercent = clampPercent(100 - remainingPercent);
    return {
      utilization: usedPercent / 100,
      usedPercent,
      remainingPercent,
    };
  }

  return {
    utilization: null,
    usedPercent: 0,
    remainingPercent: 100,
  };
}

function normalizeRateLimitType(value: unknown, fallbackKey?: string): string {
  const direct = asString(value);
  if (direct) return direct;
  if (fallbackKey) return fallbackKey;
  return 'unknown';
}

function toObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeRestriction(
  raw: Record<string, unknown>,
  fallbackKey: string | undefined,
  unit: UtilizationUnit
): ClaudeQuotaWindow | null {
  const rateLimitType = normalizeRateLimitType(
    raw['rateLimitType'] ?? raw['rate_limit_type'] ?? raw['claim'] ?? raw['claimAbbrev'],
    fallbackKey
  );
  if (!rateLimitType || rateLimitType === 'unknown') return null;

  const status = asString(raw['status']) || 'unknown';
  const resetAt =
    normalizeTimestamp(raw['resetsAt'] ?? raw['resets_at'] ?? raw['resetAt'] ?? raw['reset_at']) ||
    null;
  const overageResetsAt =
    normalizeTimestamp(
      raw['overageResetsAt'] ??
        raw['overage_resets_at'] ??
        raw['overageResetAt'] ??
        raw['overage_reset_at']
    ) || null;

  const { utilization, usedPercent, remainingPercent } = normalizeUtilization(raw, unit);

  return {
    rateLimitType,
    label: getClaudeWindowLabel(rateLimitType),
    status,
    utilization,
    usedPercent,
    remainingPercent,
    resetAt,
    surpassedThreshold: asBoolean(raw['surpassedThreshold'] ?? raw['surpassed_threshold']),
    severity: asString(raw['severity']) || undefined,
    overageStatus: asString(raw['overageStatus'] ?? raw['overage_status']) || undefined,
    overageResetsAt,
    overageDisabledReason:
      asString(raw['overageDisabledReason'] ?? raw['overage_disabled_reason']) || undefined,
    isUsingOverage: asBoolean(raw['isUsingOverage'] ?? raw['is_using_overage']),
    hasExtraUsageEnabled: asBoolean(raw['hasExtraUsageEnabled'] ?? raw['has_extra_usage_enabled']),
  };
}

/**
 * Parse raw policy limits response into normalized windows.
 * Supports both policy-limits `restrictions` payloads and OAuth usage payloads
 * keyed by window name (`five_hour`, `seven_day`, `seven_day_sonnet`, ...).
 */
function isClaudeOAuthUsageWindowCandidate(key: string, raw: Record<string, unknown>): boolean {
  // Internal codenames can look like quotas but have no published meaning.
  if (key !== 'five_hour' && !WEEKLY_RATE_LIMIT_TYPES.has(key)) return false;
  if (asNumber(raw['utilization']) === null) return false;

  const resetAt = raw['resetsAt'] ?? raw['resets_at'] ?? raw['resetAt'] ?? raw['reset_at'] ?? null;
  return resetAt !== null && resetAt !== undefined;
}

export function buildClaudeQuotaWindows(payload: Record<string, unknown>): ClaudeQuotaWindow[] {
  const rawRestrictions = payload['restrictions'];
  const windows: ClaudeQuotaWindow[] = [];

  if (Array.isArray(rawRestrictions)) {
    for (const item of rawRestrictions) {
      const raw = toObject(item);
      if (!raw) continue;
      // policy-limits restrictions[] returns utilization as a 0..1 ratio.
      const window = normalizeRestriction(raw, undefined, 'ratio');
      if (window) windows.push(window);
    }
  } else if (toObject(rawRestrictions)) {
    for (const [key, value] of Object.entries(rawRestrictions as Record<string, unknown>)) {
      const raw = toObject(value);
      if (!raw) continue;
      // policy-limits restrictions{} returns utilization as a 0..1 ratio.
      const window = normalizeRestriction(raw, key, 'ratio');
      if (window) windows.push(window);
    }
  } else if (toObject(payload)) {
    // The named limits array carries model scopes omitted from legacy fields.
    for (const item of Array.isArray(payload['limits']) ? payload['limits'] : []) {
      const raw = toObject(item);
      if (!raw) continue;
      const kind = asString(raw['kind']);
      const percent = asNumber(raw['percent']);
      const resetAt = normalizeTimestamp(raw['resets_at']);
      if (!kind || percent === null || percent < 0 || !resetAt) continue;
      const scope = toObject(raw['scope']);
      const model = toObject(scope?.['model']);
      const modelName = asString(model?.['display_name']);
      const suffix = asString(model?.['id']) ?? modelName;
      const rateLimitType =
        kind === 'session'
          ? 'five_hour'
          : kind === 'weekly_all'
            ? 'seven_day'
            : kind.startsWith('weekly_')
              ? `seven_day_${kind.slice(7)}${suffix ? `_${suffix}` : ''}`
              : null;
      if (!rateLimitType) continue;
      const window = normalizeRestriction(
        { ...raw, rateLimitType, utilization: percent },
        undefined,
        'percent'
      );
      if (window) {
        if (modelName) window.label = modelName;
        windows.push(window);
      }
    }
    for (const [key, value] of Object.entries(payload)) {
      const raw = toObject(value);
      if (!raw) continue;
      if (!isClaudeOAuthUsageWindowCandidate(key, raw)) continue;
      // OAuth /oauth/usage payloads return utilization as percent 0..100.
      const window = normalizeRestriction(raw, key, 'percent');
      if (window && !windows.some((entry) => entry.rateLimitType === window.rateLimitType))
        windows.push(window);
    }

    // Some responses may contain a single restriction object directly,
    // matching the policy-limits ratio shape.
    if (windows.length === 0) {
      const direct = normalizeRestriction(payload, undefined, 'ratio');
      if (direct) windows.push(direct);
    }
  }

  const seen = new Set<string>();
  const unique: ClaudeQuotaWindow[] = [];
  for (const window of windows) {
    const key = `${window.rateLimitType}:${window.resetAt ?? ''}:${window.status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(window);
  }

  return unique.sort((a, b) => a.rateLimitType.localeCompare(b.rateLimitType));
}

function toEpochMs(iso: string | null): number | null {
  if (!iso) return null;
  const value = new Date(iso).getTime();
  return isNaN(value) ? null : value;
}

function pickMostRestrictiveWeekly(windows: ClaudeQuotaWindow[]): ClaudeQuotaWindow | null {
  if (windows.length === 0) return null;
  return [...windows].sort((a, b) => {
    if (a.remainingPercent !== b.remainingPercent) {
      return a.remainingPercent - b.remainingPercent;
    }
    const aReset = toEpochMs(a.resetAt);
    const bReset = toEpochMs(b.resetAt);
    if (aReset === null && bReset === null) return 0;
    if (aReset === null) return 1;
    if (bReset === null) return -1;
    return aReset - bReset;
  })[0];
}

function mapCoreWindow(window: ClaudeQuotaWindow | null): ClaudeCoreUsageSummary['fiveHour'] {
  if (!window) return null;
  return {
    rateLimitType: window.rateLimitType,
    label: window.label,
    remainingPercent: window.remainingPercent,
    resetAt: window.resetAt,
    status: window.status,
  };
}

const WEEKLY_RATE_LIMIT_TYPES = new Set([
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_oauth_apps',
  'seven_day_cowork',
]);

export function isClaudeWeeklyRateLimitType(rateLimitType: string): boolean {
  return WEEKLY_RATE_LIMIT_TYPES.has(rateLimitType) || rateLimitType.startsWith('seven_day_scoped');
}

export function pickMostRestrictiveClaudeWeeklyWindow(
  windows: ClaudeQuotaWindow[]
): ClaudeQuotaWindow | null {
  const weeklyCandidates = windows.filter((window) =>
    isClaudeWeeklyRateLimitType(window.rateLimitType)
  );
  return pickMostRestrictiveWeekly(weeklyCandidates);
}

/**
 * Build explicit 5h + weekly usage summary from Claude policy windows.
 */
export function buildClaudeCoreUsageSummary(windows: ClaudeQuotaWindow[]): ClaudeCoreUsageSummary {
  if (!windows || windows.length === 0) {
    return { fiveHour: null, weekly: null };
  }

  const fiveHourWindow = windows.find((window) => window.rateLimitType === 'five_hour') || null;
  const weeklyWindow = pickMostRestrictiveClaudeWeeklyWindow(windows);

  if (fiveHourWindow && weeklyWindow) {
    return {
      fiveHour: mapCoreWindow(fiveHourWindow),
      weekly: mapCoreWindow(weeklyWindow),
    };
  }

  // Fallback: infer shortest/longest reset windows from non-overage limits.
  const nonOverage = windows.filter((window) => window.rateLimitType !== 'overage');
  const withReset = nonOverage
    .map((window) => ({
      window,
      resetMs: toEpochMs(window.resetAt),
    }))
    .filter((entry) => entry.resetMs !== null)
    .sort((a, b) => (a.resetMs as number) - (b.resetMs as number));

  const inferredWeekly =
    weeklyWindow ||
    [...withReset].reverse().find((entry) => entry.window !== fiveHourWindow)?.window ||
    pickMostRestrictiveWeekly(nonOverage.filter((window) => window !== fiveHourWindow));
  const inferredFiveHour =
    fiveHourWindow ||
    withReset.find((entry) => entry.window !== inferredWeekly)?.window ||
    pickMostRestrictiveWeekly(nonOverage.filter((window) => window !== inferredWeekly));

  return {
    fiveHour: mapCoreWindow(inferredFiveHour),
    weekly: mapCoreWindow(inferredWeekly),
  };
}
