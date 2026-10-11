import { expect, test } from 'bun:test';
import {
  buildClaudeQuotaWindows,
  buildClaudeCoreUsageSummary,
} from '../../../src/cliproxy/quota/quota-fetcher-claude-normalizer';

test('reads scoped weekly limits alongside session without a global weekly quota', () => {
  const resets_at = '2026-10-17T04:00:00Z';
  const windows = buildClaudeQuotaWindows({
    seven_day: null,
    five_hour: { utilization: 13, resets_at },
    limits: [
      { kind: 'session', percent: 13, resets_at },
      { kind: 'weekly_scoped', percent: 0, resets_at, scope: { model: { display_name: 'Fable' } } },
    ],
  });
  expect(windows).toHaveLength(2);
  expect(windows[1]).toMatchObject({ label: 'Fable', usedPercent: 0, remainingPercent: 100 });
  expect(buildClaudeCoreUsageSummary(windows).weekly?.label).toBe('Fable');
});

test('does not turn internal billing fields or malformed limits into quotas', () => {
  const resets_at = '2026-10-17T04:00:00Z';
  const windows = buildClaudeQuotaWindows({
    five_hour: { utilization: 2, resets_at },
    seven_day: { utilization: 7, resets_at },
    iguana_necktie: { utilization: 0, resets_at, limit_dollars: 250 },
    limits: [{ kind: 'weekly_scoped', percent: null, resets_at }],
  });
  expect(windows.map((window) => window.rateLimitType)).toEqual(['five_hour', 'seven_day']);
  expect(windows[1].usedPercent).toBe(7);
});
