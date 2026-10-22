export type ProviderLimits = {
  requests?: { remaining: number; limit: number; reset?: string };
  tokens?: { remaining: number; limit: number; reset?: string };
};

export type AnthropicUnifiedLimits = {
  fiveHour?: { utilization: number; reset?: number; status?: string };
  sevenDay?: { utilization: number; reset?: number; status?: string };
};

export type CodexUsageLimits = {
  primary?: { percent: number; reset?: number };
  secondary?: { percent: number; reset?: number };
};

type UnifiedWindow = NonNullable<AnthropicUnifiedLimits['fiveHour']>;

function resetSeconds(value: unknown): number | undefined {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) / 1000 : NaN;
  return Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(new Date(seconds * 1000).getTime()) ? seconds : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function percentage(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function anthroWindow(value: unknown, modern: boolean): UnifiedWindow | undefined {
  const data = record(value);
  const used = modern ? percentage(data?.percent) : percentage(typeof data?.utilization === 'number' ? data.utilization * 100 : undefined);
  if (used === undefined) return undefined;
  const reset = resetSeconds(data?.resets_at);
  return { utilization: used / 100, ...(reset !== undefined && { reset }), status: 'allowed' };
}

export async function fetchAnthropicUsage(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<AnthropicUnifiedLimits | undefined> {
  try {
    const response = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
    });
    if (!response.ok) return undefined;
    const data = record(await response.json());
    if (!data) return undefined;
    let fiveHour: UnifiedWindow | undefined;
    let sevenDay: UnifiedWindow | undefined;
    if (Array.isArray(data.limits)) {
      for (const item of data.limits) {
        const limit = record(item);
        if (limit?.kind === 'session') fiveHour = anthroWindow(limit, true) ?? fiveHour;
        else if (limit?.kind === 'weekly_all' || (typeof limit?.kind === 'string' && limit.kind.startsWith('weekly'))) {
          if (!sevenDay || limit.kind === 'weekly_all') sevenDay = anthroWindow(limit, true) ?? sevenDay;
        }
      }
    } else {
      fiveHour = anthroWindow(data.five_hour, false);
      sevenDay = anthroWindow(data.seven_day, false) ?? anthroWindow(data.seven_day_opus, false) ?? anthroWindow(data.seven_day_sonnet, false);
    }
    return fiveHour || sevenDay ? { ...(fiveHour && { fiveHour }), ...(sevenDay && { sevenDay }) } : undefined;
  } catch { return undefined; }
}

function codexWindow(value: unknown): NonNullable<CodexUsageLimits['primary']> | undefined {
  const data = record(value);
  const percent = percentage(data?.used_percent);
  if (percent === undefined) return undefined;
  const reset = resetSeconds(data?.reset_at) ?? (typeof data?.reset_after_seconds === 'number' && Number.isFinite(data.reset_after_seconds) && data.reset_after_seconds >= 0
    ? resetSeconds(Date.now() / 1000 + data.reset_after_seconds) : undefined);
  return { percent, ...(reset !== undefined && { reset }) };
}

export async function fetchCodexUsage(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<CodexUsageLimits | undefined> {
  try {
    const response = await fetchImpl('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET', headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return undefined;
    const limits = record(record(await response.json())?.rate_limit);
    const primary = codexWindow(limits?.primary_window);
    const secondary = codexWindow(limits?.secondary_window);
    return primary || secondary ? { ...(primary && { primary }), ...(secondary && { secondary }) } : undefined;
  } catch { return undefined; }
}


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

export function mergeCodexUsageLimits(previous: CodexUsageLimits | undefined, next: CodexUsageLimits): CodexUsageLimits {
  if (!previous) return next;
  return {
    ...previous,
    ...(next.primary && { primary: { ...previous.primary, ...next.primary } }),
    ...(next.secondary && { secondary: { ...previous.secondary, ...next.secondary } }),
  };
}

export function renderBar(percent: number, width = 5): string {
  const filled = Math.round(percent / 100 * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function formatDurationUntil(resetUnixSeconds: number, nowUnixSeconds: number): string {
  const minutes = Math.floor(Math.max(0, resetUnixSeconds - nowUnixSeconds) / 60);
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
  return `${minutes}m`;
}

function formatUsageWindow(label: string, percent: number, reset: number | undefined, now: number): string {
  const rounded = Math.round(percent);
  return `${label}|${renderBar(rounded)}|${rounded}%|${reset === undefined ? '-' : formatDurationUntil(reset, now)}`;
}

export function formatUnifiedLimitsLine(provider: string, limits: AnthropicUnifiedLimits, now = Date.now() / 1000): string {
  const windows: string[] = [];
  if (limits.fiveHour) windows.push(formatUsageWindow('5h', limits.fiveHour.utilization * 100, limits.fiveHour.reset, now));
  if (limits.sevenDay) windows.push(formatUsageWindow('wk', limits.sevenDay.utilization * 100, limits.sevenDay.reset, now));
  return windows.length ? `${provider} ${windows.join('||')}` : '';
}

export function formatCodexLimitsLine(provider: string, limits: CodexUsageLimits, now = Date.now() / 1000): string {
  const windows: string[] = [];
  if (limits.primary) windows.push(formatUsageWindow('5h', limits.primary.percent, limits.primary.reset, now));
  if (limits.secondary) windows.push(formatUsageWindow('wk', limits.secondary.percent, limits.secondary.reset, now));
  return windows.length ? `${provider} ${windows.join('||')}` : '';
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

export function formatProviderLimitsLines(limitsByProvider: Map<string, ProviderLimits>, unifiedByProvider: Map<string, AnthropicUnifiedLimits> = new Map(), codexByProvider: Map<string, CodexUsageLimits> = new Map(), now = Date.now() / 1000): string[] {
  const lines: string[] = [];
  for (const provider of new Set([...limitsByProvider.keys(), ...unifiedByProvider.keys(), ...codexByProvider.keys()])) {
    const limits = limitsByProvider.get(provider);
    const counters: string[] = [];
    if (limits?.requests) counters.push(`req ${limits.requests.remaining}/${limits.requests.limit}`);
    if (limits?.tokens) counters.push(`tok ${limits.tokens.remaining}/${limits.tokens.limit}`);
    const unified = unifiedByProvider.get(provider);
    const unifiedLine = unified ? formatUnifiedLimitsLine(provider, unified, now) : '';
    if (unifiedLine) counters.push(unifiedLine.slice(provider.length + 1));
    const codex = codexByProvider.get(provider);
    const codexLine = codex ? formatCodexLimitsLine(provider, codex, now) : '';
    if (codexLine) counters.push(codexLine.slice(provider.length + 1));
    if (counters.length) lines.push(`${provider} ${counters.join(' · ')}`);
  }
  return lines;
}
