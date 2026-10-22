import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAnthropicLimits, parseAnthropicUnifiedLimits, parseOpenAILimits, mergeProviderLimits, mergeAnthropicUnifiedLimits, mergeCodexUsageLimits, formatProviderLimitsLines, formatUnifiedLimitsLine, fetchAnthropicUsage, fetchCodexUsage } from './provider-limits.ts';

const mockFetch = (body, status = 200) => async (url, options) => {
  assert.equal(options.method, 'GET');
  assert.equal(options.headers.Authorization, 'Bearer test-token');
  if (url.includes('anthropic.com')) assert.equal(options.headers['anthropic-beta'], 'oauth-2025-04-20');
  return { ok: status === 200, status, json: async () => body };
};

test('fetchAnthropicUsage reads new limits and normalizes percentages and resets', async () => {
  assert.deepEqual(await fetchAnthropicUsage('test-token', mockFetch({ limits: [
    { kind: 'session', percent: 5, resets_at: '2030-01-01T15:00:00Z' },
    { kind: 'weekly_all', percent: 1, resets_at: 1893538800 },
  ] })), { fiveHour: { utilization: 0.05, reset: 1893510000, status: 'allowed' }, sevenDay: { utilization: 0.01, reset: 1893538800, status: 'allowed' } });
});

test('fetchAnthropicUsage supports legacy windows and ignores invalid fields', async () => {
  assert.deepEqual(await fetchAnthropicUsage('test-token', mockFetch({ five_hour: { utilization: 0.25, resets_at: '2030-01-01T15:00:00Z' }, seven_day: { utilization: 0 } })),
    { fiveHour: { utilization: 0.25, reset: 1893510000, status: 'allowed' }, sevenDay: { utilization: 0, status: 'allowed' } });
  assert.deepEqual(await fetchAnthropicUsage('test-token', mockFetch({ limits: [{ kind: 'session', percent: 150 }, { kind: 'weekly_scoped', percent: 10 }] })),
    { sevenDay: { utilization: 0.1, status: 'allowed' } });
});

test('fetchCodexUsage reads primary and secondary windows without inventing counters', async () => {
  const result = await fetchCodexUsage('test-token', mockFetch({ rate_limit: {
    primary_window: { used_percent: 12.5, reset_at: 1893510000, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 3, reset_at: 1893538800 },
  } }));
  assert.deepEqual(result, { primary: { percent: 12.5, reset: 1893510000 }, secondary: { percent: 3, reset: 1893538800 } });
  const formatted = formatProviderLimitsLines(new Map([['openai-codex', { requests: { remaining: 4, limit: 5 } }]]), new Map(), new Map([['openai-codex', result]]));
  assert.match(formatted[0], /^openai-codex req 4\/5 · 5h:13%\(сброс \d{2}:\d{2}\) · 7d:3%\(сброс \d{2}:\d{2} \d{2}\.\d{2}\)$/);
});

test('Codex passive headers and delayed active fetch retain both sources in either order', async () => {
  let finishFetch;
  const pending = new Promise((resolve) => { finishFetch = resolve; });
  const active = fetchCodexUsage('test-token', async () => pending);
  const counters = new Map();
  const windows = new Map();
  const provider = 'openai-codex';
  const headers = parseOpenAILimits({ 'x-ratelimit-remaining-requests': '4', 'x-ratelimit-limit-requests': '5' });
  counters.set(provider, mergeProviderLimits(counters.get(provider), headers));
  finishFetch({ ok: true, json: async () => ({ rate_limit: {
    primary_window: { used_percent: 12 }, secondary_window: { used_percent: 3 },
  } }) });
  windows.set(provider, mergeCodexUsageLimits(windows.get(provider), await active));
  assert.deepEqual(formatProviderLimitsLines(counters, new Map(), windows), ['openai-codex req 4/5 · 5h:12% · 7d:3%']);
  const reverseCounters = new Map();
  assert.deepEqual(formatProviderLimitsLines(reverseCounters, new Map(), windows), ['openai-codex 5h:12% · 7d:3%']);
  reverseCounters.set(provider, mergeProviderLimits(reverseCounters.get(provider), headers));
  assert.deepEqual(formatProviderLimitsLines(reverseCounters, new Map(), windows), ['openai-codex req 4/5 · 5h:12% · 7d:3%']);
});

test('mergeCodexUsageLimits preserves missing windows and fields in either arrival order', () => {
  const first = { primary: { percent: 12, reset: 1893510000 } };
  const second = { primary: { percent: 13 }, secondary: { percent: 3, reset: 1893538800 } };
  assert.deepEqual(mergeCodexUsageLimits(first, second), {
    primary: { percent: 13, reset: 1893510000 }, secondary: second.secondary,
  });
  assert.deepEqual(mergeCodexUsageLimits(second, first), {
    primary: first.primary, secondary: second.secondary,
  });
});

test('Codex duration reset and active-only provider lines', async () => {
  const originalNow = Date.now;
  Date.now = () => 1893510000000;
  try {
    const usage = await fetchCodexUsage('test-token', mockFetch({ rate_limit: { primary_window: { used_percent: 0, reset_after_seconds: 60 } } }));
    assert.deepEqual(usage, { primary: { percent: 0, reset: 1893510060 } });
    const lines = formatProviderLimitsLines(new Map(), new Map([['anthropic', { fiveHour: { utilization: 0.05 } }]]), new Map([['openai-codex', usage]]));
    assert.equal(lines[0], 'anthropic 5h:5%');
    assert.match(lines[1], /^openai-codex 5h:0%\(сброс \d{2}:\d{2}\)$/);
  } finally { Date.now = originalNow; }
});

test('usage fetches fail quietly on network errors, 401, invalid JSON and missing fields', async () => {
  for (const fetcher of [fetchAnthropicUsage, fetchCodexUsage]) {
    assert.equal(await fetcher('test-token', async () => { throw new Error('offline'); }), undefined);
    assert.equal(await fetcher('test-token', mockFetch({}, 401)), undefined);
    assert.equal(await fetcher('test-token', mockFetch({}, 403)), undefined);
    assert.equal(await fetcher('test-token', async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } })), undefined);
    assert.equal(await fetcher('test-token', mockFetch({})), undefined);
    assert.equal(await fetcher('test-token', mockFetch(null)), undefined);
  }
  assert.deepEqual(await fetchCodexUsage('test-token', mockFetch({ rate_limit: { primary_window: { used_percent: -1 }, secondary_window: { used_percent: 0 } } })), { secondary: { percent: 0 } });
});

test('parseAnthropicLimits reads complete request and token limits with ISO resets', () => {
  assert.deepEqual(parseAnthropicLimits({
    'anthropic-ratelimit-requests-remaining': '42',
    'anthropic-ratelimit-requests-limit': '50',
    'anthropic-ratelimit-requests-reset': '2026-10-22T12:00:00Z',
    'anthropic-ratelimit-tokens-remaining': '180000',
    'anthropic-ratelimit-tokens-limit': '200000',
    'anthropic-ratelimit-tokens-reset': '2026-10-22T12:01:00Z',
  }), {
    requests: { remaining: 42, limit: 50, reset: '2026-10-22T12:00:00Z' },
    tokens: { remaining: 180000, limit: 200000, reset: '2026-10-22T12:01:00Z' },
  });
});

test('parseAnthropicLimits accepts requests without tokens or reset', () => {
  assert.deepEqual(parseAnthropicLimits({
    'anthropic-ratelimit-requests-remaining': '0',
    'anthropic-ratelimit-requests-limit': '50',
  }), { requests: { remaining: 0, limit: 50 } });
});

test('parseAnthropicLimits accepts tokens without requests', () => {
  assert.deepEqual(parseAnthropicLimits({
    'anthropic-ratelimit-tokens-remaining': '100',
    'anthropic-ratelimit-tokens-limit': '200',
    'anthropic-ratelimit-tokens-reset': '2026-10-22T12:01:00Z',
  }), { tokens: { remaining: 100, limit: 200, reset: '2026-10-22T12:01:00Z' } });
});

test('parseAnthropicLimits ignores unrelated headers and an empty object', () => {
  assert.equal(parseAnthropicLimits({ 'content-type': 'application/json', 'x-ratelimit-limit-requests': '50' }), undefined);
  assert.equal(parseAnthropicLimits({}), undefined);
});

test('parseAnthropicLimits skips an invalid request pair but keeps valid tokens', () => {
  assert.deepEqual(parseAnthropicLimits({
    'anthropic-ratelimit-requests-remaining': '42oops',
    'anthropic-ratelimit-requests-limit': '50',
    'anthropic-ratelimit-tokens-remaining': '100',
    'anthropic-ratelimit-tokens-limit': '200',
  }), { tokens: { remaining: 100, limit: 200 } });
});

test('parseAnthropicLimits skips an invalid token limit but keeps valid requests', () => {
  assert.deepEqual(parseAnthropicLimits({
    'anthropic-ratelimit-requests-remaining': '42',
    'anthropic-ratelimit-requests-limit': '50',
    'anthropic-ratelimit-tokens-remaining': '100',
    'anthropic-ratelimit-tokens-limit': '200.5',
  }), { requests: { remaining: 42, limit: 50 } });
});

test('parseAnthropicLimits returns undefined for incomplete or wholly invalid pairs', () => {
  assert.equal(parseAnthropicLimits({ 'anthropic-ratelimit-requests-reset': '2026-10-22T12:00:00Z' }), undefined);
  assert.equal(parseAnthropicLimits({ 'anthropic-ratelimit-requests-remaining': '42' }), undefined);
  assert.equal(parseAnthropicLimits({
    'anthropic-ratelimit-requests-remaining': 'oops',
    'anthropic-ratelimit-requests-limit': '50',
    'anthropic-ratelimit-tokens-remaining': '100',
    'anthropic-ratelimit-tokens-limit': 'bad',
  }), undefined);
});

test('parseAnthropicUnifiedLimits reads both subscription windows', () => {
  assert.deepEqual(parseAnthropicUnifiedLimits({
    'anthropic-ratelimit-unified-5h-utilization': '0.05',
    'anthropic-ratelimit-unified-5h-reset': '1792686000',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': '0.0',
    'anthropic-ratelimit-unified-7d-reset': '1793271600',
    'anthropic-ratelimit-unified-7d-status': 'rejected',
    'anthropic-ratelimit-unified-status': 'allowed',
  }), {
    fiveHour: { utilization: 0.05, reset: 1792686000, status: 'allowed' },
    sevenDay: { utilization: 0, reset: 1793271600, status: 'rejected' },
  });
});

test('parseAnthropicUnifiedLimits accepts 5h without optional reset or status', () => {
  assert.deepEqual(parseAnthropicUnifiedLimits({
    'anthropic-ratelimit-unified-5h-utilization': '1',
  }), { fiveHour: { utilization: 1 } });
});

test('parseAnthropicUnifiedLimits accepts only 7d', () => {
  assert.deepEqual(parseAnthropicUnifiedLimits({
    'anthropic-ratelimit-unified-7d-utilization': '0',
    'anthropic-ratelimit-unified-7d-reset': '1793271600',
  }), { sevenDay: { utilization: 0, reset: 1793271600 } });
});

test('parseAnthropicUnifiedLimits ignores absent and aggregate-only headers', () => {
  assert.equal(parseAnthropicUnifiedLimits({}), undefined);
  assert.equal(parseAnthropicUnifiedLimits({ 'anthropic-ratelimit-unified-status': 'allowed' }), undefined);
});

test('parseAnthropicUnifiedLimits skips invalid utilization independently', () => {
  for (const invalid of ['oops', '-0.1', '1.1', 'NaN', 'Infinity', '', '0x1']) {
    assert.deepEqual(parseAnthropicUnifiedLimits({
      'anthropic-ratelimit-unified-5h-utilization': invalid,
      'anthropic-ratelimit-unified-7d-utilization': '0.25',
    }), { sevenDay: { utilization: 0.25 } });
    assert.equal(parseAnthropicUnifiedLimits({ 'anthropic-ratelimit-unified-5h-utilization': invalid }), undefined);
  }
});

test('parseAnthropicUnifiedLimits skips an invalid reset window but retains the other', () => {
  assert.deepEqual(parseAnthropicUnifiedLimits({
    'anthropic-ratelimit-unified-5h-utilization': '0.05',
    'anthropic-ratelimit-unified-5h-reset': 'not-a-number',
    'anthropic-ratelimit-unified-7d-utilization': '0.25',
  }), { sevenDay: { utilization: 0.25 } });
  for (const reset of ['oops', '9999999999999999']) {
    assert.equal(parseAnthropicUnifiedLimits({
      'anthropic-ratelimit-unified-7d-utilization': '0.25',
      'anthropic-ratelimit-unified-7d-reset': reset,
    }), undefined);
  }
});

test('formatUnifiedLimitsLine formats local reset time, and date only for a different day', () => {
  const today = new Date();
  const todayReset = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 15, 0).getTime() / 1000;
  const laterReset = new Date(2040, 9, 23, 15, 0).getTime() / 1000;
  assert.equal(formatUnifiedLimitsLine('anthropic', {
    fiveHour: { utilization: 0.05, reset: todayReset, status: 'allowed' },
    sevenDay: { utilization: 0, reset: laterReset, status: 'allowed' },
  }), 'anthropic 5h:5%(сброс 15:00) 7d:0%(сброс 15:00 23.10)');
  assert.equal(formatUnifiedLimitsLine('anthropic', { fiveHour: { utilization: 0.25 } }), 'anthropic 5h:25%');
  assert.equal(formatUnifiedLimitsLine('anthropic', { sevenDay: { utilization: 0 } }), 'anthropic 7d:0%');
  assert.equal(formatUnifiedLimitsLine('anthropic', {}), '');
});

test('mergeAnthropicUnifiedLimits retains the other window across partial responses', () => {
  assert.deepEqual(mergeAnthropicUnifiedLimits(
    { sevenDay: { utilization: 0.1, reset: 1793271600 } },
    { fiveHour: { utilization: 0.05 } },
  ), { sevenDay: { utilization: 0.1, reset: 1793271600 }, fiveHour: { utilization: 0.05 } });
});

test('formatProviderLimitsLines combines legacy and unified limits without repeating provider', () => {
  assert.deepEqual(formatProviderLimitsLines(
    new Map([['anthropic', { requests: { remaining: 4, limit: 5 } }]]),
    new Map([['anthropic', { fiveHour: { utilization: 0.05 } }], ['openai', { sevenDay: { utilization: 0 } }]]),
  ), ['anthropic req 4/5 · 5h:5%', 'openai 7d:0%']);
});

test('parseOpenAILimits reads complete request and token limits with raw duration resets', () => {
  assert.deepEqual(parseOpenAILimits({
    'x-ratelimit-remaining-requests': '42',
    'x-ratelimit-limit-requests': '50',
    'x-ratelimit-reset-requests': '6s',
    'x-ratelimit-remaining-tokens': '180000',
    'x-ratelimit-limit-tokens': '200000',
    'x-ratelimit-reset-tokens': '1h4m',
  }), {
    requests: { remaining: 42, limit: 50, reset: '6s' },
    tokens: { remaining: 180000, limit: 200000, reset: '1h4m' },
  });
});

test('parseOpenAILimits accepts requests without tokens or reset', () => {
  assert.deepEqual(parseOpenAILimits({
    'x-ratelimit-remaining-requests': '0',
    'x-ratelimit-limit-requests': '50',
  }), { requests: { remaining: 0, limit: 50 } });
});

test('parseOpenAILimits accepts tokens without requests and preserves a millisecond reset', () => {
  assert.deepEqual(parseOpenAILimits({
    'x-ratelimit-remaining-tokens': '100',
    'x-ratelimit-limit-tokens': '200',
    'x-ratelimit-reset-tokens': '30ms',
  }), { tokens: { remaining: 100, limit: 200, reset: '30ms' } });
});

test('parseOpenAILimits ignores unrelated headers and an empty object', () => {
  assert.equal(parseOpenAILimits({ 'content-type': 'application/json', 'anthropic-ratelimit-requests-limit': '50' }), undefined);
  assert.equal(parseOpenAILimits({}), undefined);
});

test('parseOpenAILimits skips an invalid request pair but keeps valid tokens', () => {
  assert.deepEqual(parseOpenAILimits({
    'x-ratelimit-remaining-requests': '42',
    'x-ratelimit-limit-requests': 'not-a-number',
    'x-ratelimit-remaining-tokens': '100',
    'x-ratelimit-limit-tokens': '200',
  }), { tokens: { remaining: 100, limit: 200 } });
});

test('parseOpenAILimits skips an invalid token pair but keeps valid requests', () => {
  assert.deepEqual(parseOpenAILimits({
    'x-ratelimit-remaining-requests': '42',
    'x-ratelimit-limit-requests': '50',
    'x-ratelimit-remaining-tokens': '100.5',
    'x-ratelimit-limit-tokens': '200',
  }), { requests: { remaining: 42, limit: 50 } });
});

test('parseOpenAILimits returns undefined for incomplete or wholly invalid pairs', () => {
  assert.equal(parseOpenAILimits({ 'x-ratelimit-reset-requests': '6s' }), undefined);
  assert.equal(parseOpenAILimits({ 'x-ratelimit-limit-tokens': '200' }), undefined);
  assert.equal(parseOpenAILimits({
    'x-ratelimit-remaining-requests': 'oops',
    'x-ratelimit-limit-requests': '50',
    'x-ratelimit-remaining-tokens': '100',
    'x-ratelimit-limit-tokens': 'bad',
  }), undefined);
});

test('mergeProviderLimits updates requests while keeping previous tokens', () => {
  const previous = {
    requests: { remaining: 8, limit: 50 },
    tokens: { remaining: 100, limit: 200, reset: '30ms' },
  };
  const next = parseOpenAILimits({
    'x-ratelimit-remaining-requests': '7',
    'x-ratelimit-limit-requests': '50',
  });
  assert.deepEqual(mergeProviderLimits(previous, next), {
    requests: { remaining: 7, limit: 50 },
    tokens: previous.tokens,
  });
});

test('mergeProviderLimits updates tokens while keeping previous requests', () => {
  const previous = {
    requests: { remaining: 8, limit: 50, reset: '6s' },
    tokens: { remaining: 100, limit: 200 },
  };
  const next = parseOpenAILimits({
    'x-ratelimit-remaining-tokens': '90',
    'x-ratelimit-limit-tokens': '200',
  });
  assert.deepEqual(mergeProviderLimits(previous, next), {
    requests: previous.requests,
    tokens: { remaining: 90, limit: 200 },
  });
});

test('mergeProviderLimits uses next unchanged when no previous entry exists', () => {
  const next = { requests: { remaining: 7, limit: 50 } };
  assert.strictEqual(mergeProviderLimits(undefined, next), next);
});

test('formatProviderLimitsLines hides an empty map', () => {
  assert.deepEqual(formatProviderLimitsLines(new Map()), []);
});

test('formatProviderLimitsLines formats a provider with requests only', () => {
  assert.deepEqual(formatProviderLimitsLines(new Map([
    ['anthropic', { requests: { remaining: 42, limit: 50 } }],
  ])), ['anthropic req 42/50']);
});

test('formatProviderLimitsLines formats a provider with tokens only', () => {
  assert.deepEqual(formatProviderLimitsLines(new Map([
    ['openai', { tokens: { remaining: 180000, limit: 200000 } }],
  ])), ['openai tok 180000/200000']);
});

test('formatProviderLimitsLines preserves map order, provider casing and both counters', () => {
  assert.deepEqual(formatProviderLimitsLines(new Map([
    ['OpenAI', { requests: { remaining: 4, limit: 5 }, tokens: { remaining: 800, limit: 1000 } }],
    ['anthropic', { requests: { remaining: 42, limit: 50 }, tokens: { remaining: 180000, limit: 200000 } }],
    ['openrouter', { requests: { remaining: 1, limit: 10 } }],
  ])), [
    'OpenAI req 4/5 · tok 800/1000',
    'anthropic req 42/50 · tok 180000/200000',
    'openrouter req 1/10',
  ]);
});

test('formatProviderLimitsLines skips a provider without counters', () => {
  assert.deepEqual(formatProviderLimitsLines(new Map([
    ['empty', {}],
    ['openai', { requests: { remaining: 4, limit: 5 } }],
  ])), ['openai req 4/5']);
  assert.deepEqual(formatProviderLimitsLines(new Map([['empty', {}]])), []);
});
