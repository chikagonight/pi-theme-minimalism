export type ProviderLimits = {
  requests?: { remaining: number; limit: number; reset?: string };
  tokens?: { remaining: number; limit: number; reset?: string };
};

function parseCounter(headers: Record<string, string>, remainingKey: string, limitKey: string, resetKey: string): ProviderLimits['requests'] {
  const remaining = headers[remainingKey];
  const limit = headers[limitKey];
  if (remaining === undefined || limit === undefined || !/^(0|[1-9]\d*)$/.test(remaining) || !/^(0|[1-9]\d*)$/.test(limit)) return undefined;
  const parsedRemaining = Number(remaining);
  const parsedLimit = Number(limit);
  if (!Number.isSafeInteger(parsedRemaining) || !Number.isSafeInteger(parsedLimit)) return undefined;
  const reset = headers[resetKey];
  return reset === undefined ? { remaining: parsedRemaining, limit: parsedLimit } : { remaining: parsedRemaining, limit: parsedLimit, reset };
}

export function parseAnthropicLimits(headers: Record<string, string>): ProviderLimits | undefined {
  const requests = parseCounter(headers, 'anthropic-ratelimit-requests-remaining', 'anthropic-ratelimit-requests-limit', 'anthropic-ratelimit-requests-reset');
  const tokens = parseCounter(headers, 'anthropic-ratelimit-tokens-remaining', 'anthropic-ratelimit-tokens-limit', 'anthropic-ratelimit-tokens-reset');
  return requests || tokens ? { ...(requests && { requests }), ...(tokens && { tokens }) } : undefined;
}

export function parseOpenAILimits(headers: Record<string, string>): ProviderLimits | undefined {
  const requests = parseCounter(headers, 'x-ratelimit-remaining-requests', 'x-ratelimit-limit-requests', 'x-ratelimit-reset-requests');
  const tokens = parseCounter(headers, 'x-ratelimit-remaining-tokens', 'x-ratelimit-limit-tokens', 'x-ratelimit-reset-tokens');
  return requests || tokens ? { ...(requests && { requests }), ...(tokens && { tokens }) } : undefined;
}

export function mergeProviderLimits(previous: ProviderLimits | undefined, next: ProviderLimits): ProviderLimits {
  if (!previous) return next;
  return {
    ...previous,
    ...(next.requests !== undefined && { requests: next.requests }),
    ...(next.tokens !== undefined && { tokens: next.tokens }),
  };
}

export function formatProviderLimitsLines(limitsByProvider: Map<string, ProviderLimits>): string[] {
  const lines: string[] = [];
  for (const [provider, limits] of limitsByProvider) {
    const counters: string[] = [];
    if (limits.requests) counters.push(`req ${limits.requests.remaining}/${limits.requests.limit}`);
    if (limits.tokens) counters.push(`tok ${limits.tokens.remaining}/${limits.tokens.limit}`);
    if (counters.length) lines.push(`${provider} ${counters.join(' · ')}`);
  }
  return lines;
}
