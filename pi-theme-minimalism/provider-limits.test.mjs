import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAnthropicLimits, parseOpenAILimits, mergeProviderLimits, formatProviderLimitsLines } from './provider-limits.ts';

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
