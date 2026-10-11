import { expect, test } from 'bun:test';
import { accountHistory } from '../../../src/web-server/usage/account-history';
const now = new Date('2026-10-11T12:00:00Z');
const row = {
  accountId: 'one@example.com',
  model: 'claude',
  timestamp: '2026-10-11T10:00:00Z',
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 30,
  cost: 0.1,
  requestCount: 1,
  failed: false,
};
test('keeps account attribution and aggregates UTC days', () => {
  const result = accountHistory([row, row, { ...row, accountId: 'two@example.com' }], now);
  expect(result.accounts[0].days).toEqual([
    { day: '2026-10-11', tokens: 120, cost: 0.2, requests: 2 },
  ]);
  expect(result.accounts[1].days[0].tokens).toBe(60);
});
test('does not assign unknown, failed or future traffic to an account', () => {
  expect(
    accountHistory(
      [
        { ...row, accountId: undefined },
        { ...row, failed: true },
        { ...row, timestamp: '2026-10-12T00:00:00Z' },
      ],
      now
    ).accounts
  ).toEqual([]);
});
