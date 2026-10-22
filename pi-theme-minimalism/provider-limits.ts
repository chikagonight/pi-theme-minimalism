export type ProviderLimits = {
  requests?: { remaining: number; limit: number; reset?: string };
  tokens?: { remaining: number; limit: number; reset?: string };
};

export type AnthropicUnifiedLimits = {
  fiveHour?: { utilization: number; reset?: number; status?: string };
  sevenDay?: { utilization: number; reset?: number; status?: string };
};

type UnifiedWindow = NonNullable<AnthropicUnifiedLimits['fiveHour']>;

function parseUnifiedWindow(headers: Record<string, string>, window: '5h' | '7d'): UnifiedWindow | undefined {
  const prefix = `anthropic-ratelimit-unified-${window}-`;
  const rawUtilization = headers[`${prefix}utilization`];
  if (rawUtilization === undefined || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(rawUtilization)) return undefined;
  const utilization = Number(rawUtilization);
  if (!Number.isFinite(utilization) || utilization < 0 || utilization > 1) return undefined;
  const rawReset = headers[`${prefix}reset`];
  let reset: number | undefined;
  if (rawReset !== undefined) {
    if (!/^(0|[1-9]\d*)$/.test(rawReset)) return undefined;
    reset = Number(rawReset);
    if (!Number.isSafeInteger(reset) || !Number.isFinite(new Date(reset * 1000).getTime())) return undefined;
  }
  const status = headers[`${prefix}status`];
  return { utilization, ...(reset !== undefined && { reset }), ...(status && { status }) };
}

export function parseAnthropicUnifiedLimits(headers: Record<string, string>): AnthropicUnifiedLimits | undefined {
  const fiveHour = parseUnifiedWindow(headers, '5h');
  const sevenDay = parseUnifiedWindow(headers, '7d');
  return fiveHour || sevenDay ? { ...(fiveHour && { fiveHour }), ...(sevenDay && { sevenDay }) } : undefined;
}

export function mergeAnthropicUnifiedLimits(previous: AnthropicUnifiedLimits | undefined, next: AnthropicUnifiedLimits): AnthropicUnifiedLimits {
  return previous ? { ...previous, ...next } : next;
}

export function formatUnifiedLimitsLine(provider: string, limits: AnthropicUnifiedLimits): string {
  const today = new Date();
  const windows: string[] = [];
  for (const [label, window] of [['5h', limits.fiveHour], ['7d', limits.sevenDay]] as const) {
    if (!window) continue;
    let text = `${label}:${Math.round(window.utilization * 100)}%`;
    if (window.reset !== undefined) {
      const date = new Date(window.reset * 1000);
      const pad = (value: number) => String(value).padStart(2, '0');
      const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
      const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
      text += `(сброс ${time}${label === '7d' && !sameDay ? ` ${pad(date.getDate())}.${pad(date.getMonth() + 1)}` : ''})`;
    }
    windows.push(text);
  }
  return windows.length ? `${provider} ${windows.join(' ')}` : '';
}

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

export function formatProviderLimitsLines(limitsByProvider: Map<string, ProviderLimits>, unifiedByProvider: Map<string, AnthropicUnifiedLimits> = new Map()): string[] {
  const lines: string[] = [];
  for (const provider of new Set([...limitsByProvider.keys(), ...unifiedByProvider.keys()])) {
    const limits = limitsByProvider.get(provider);
    const counters: string[] = [];
    if (limits?.requests) counters.push(`req ${limits.requests.remaining}/${limits.requests.limit}`);
    if (limits?.tokens) counters.push(`tok ${limits.tokens.remaining}/${limits.tokens.limit}`);
    const unified = unifiedByProvider.get(provider);
    const unifiedLine = unified ? formatUnifiedLimitsLine(provider, unified) : '';
    if (unifiedLine) counters.push(unifiedLine.slice(provider.length + 1));
    if (counters.length) lines.push(`${provider} ${counters.join(' · ')}`);
  }
  return lines;
}
