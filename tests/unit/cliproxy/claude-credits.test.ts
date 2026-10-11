import { expect, test } from 'bun:test';
import { claudeCredits, claudeCloudCredits } from '../../../src/cliproxy/quota/claude-credits';
test('preserves used amount and cap without inventing wallet balance', () => {
  const result = claudeCredits({
    spend: {
      enabled: true,
      used: { amount_minor: 8019, currency: 'EUR', exponent: 2 },
      limit: { amount_minor: 8000, currency: 'EUR', exponent: 2 },
      balance: null,
    },
  });
  expect(result?.used).toEqual({ value: 80.19, currency: 'EUR' });
  expect(result?.limit?.value).toBe(80);
  expect(result?.balance).toBeUndefined();
});
test('missing units and internal promotional fields never become credits', () => {
  expect(claudeCredits({ iguana_necktie: { remaining_dollars: 250 } })).toBeUndefined();
  expect(
    claudeCredits({
      spend: {
        enabled: false,
        disabled_reason: 'out_of_credits',
        used: { amount_minor: 0 },
        balance: null,
      },
    })
  ).toMatchObject({
    enabled: false,
    reason: 'out_of_credits',
    used: undefined,
    balance: undefined,
  });
});

test('cloud credits remain USD, prefer reported balance and retain expiration', () => {
  expect(
    claudeCloudCredits({
      iguana_necktie: {
        limit_dollars: 250,
        used_dollars: 10,
        remaining_dollars: 250,
        resets_at: '2026-11-05T07:59:00+00:00',
        locked_reason: null,
      },
    })
  ).toEqual({
    limitDollars: 250,
    usedDollars: 0,
    remainingDollars: 250,
    expiresAt: '2026-11-05T07:59:00.000Z',
    locked: false,
  });
  expect(
    claudeCloudCredits({ iguana_necktie: { limit_dollars: 250, used_dollars: 250 } })
      ?.remainingDollars
  ).toBe(0);
});
test('malformed cloud balance is omitted without affecting ordinary credits', () => {
  expect(
    claudeCloudCredits({ iguana_necktie: { limit_dollars: 250, remaining_dollars: 251 } })
  ).toBeUndefined();
});
