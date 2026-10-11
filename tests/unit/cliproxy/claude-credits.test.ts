import { expect, test } from 'bun:test';
import { claudeCredits } from '../../../src/cliproxy/quota/claude-credits';
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
