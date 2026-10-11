import type { CliproxyUsageHistoryDetail } from './cliproxy-usage-transformer';

/** Recorded proxy traffic only; never infer account identity from model or pool. */
export function accountHistory(details: CliproxyUsageHistoryDetail[], now = new Date()) {
  const accounts = new Map<
    string,
    {
      accountId: string;
      firstRecordedAt: string;
      lastRecordedAt: string;
      days: Map<string, { day: string; tokens: number; cost: number; requests: number }>;
    }
  >();
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - 29);
  const firstDay = cutoff.toISOString().slice(0, 10);
  for (const row of details) {
    const stamp = new Date(row.timestamp);
    if (!row.accountId || row.failed || !Number.isFinite(stamp.getTime()) || stamp > now) continue;
    const counts = [
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cost,
      row.requestCount,
    ];
    if (counts.some((n) => !Number.isFinite(n) || n < 0)) continue;
    const date = stamp.toISOString();
    let account = accounts.get(row.accountId);
    if (!account) {
      account = {
        accountId: row.accountId,
        firstRecordedAt: date,
        lastRecordedAt: date,
        days: new Map(),
      };
      accounts.set(row.accountId, account);
    }
    if (date < account.firstRecordedAt) account.firstRecordedAt = date;
    if (date > account.lastRecordedAt) account.lastRecordedAt = date;
    const day = date.slice(0, 10);
    if (day < firstDay) continue;
    const bucket = account.days.get(day) ?? { day, tokens: 0, cost: 0, requests: 0 };
    bucket.tokens += row.inputTokens + row.outputTokens + row.cacheReadTokens;
    bucket.cost += row.cost;
    bucket.requests += row.requestCount;
    account.days.set(day, bucket);
  }
  return {
    source: 'cliproxy',
    timezone: 'UTC',
    accounts: [...accounts.values()].map((account) => ({
      ...account,
      days: [...account.days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    })),
  };
}
