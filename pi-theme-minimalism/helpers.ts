import { truncateToWidth, visibleWidth, type Color } from '@earendil-works/pi-tui';

// Foreground tokens from pi-coding-agent's theme-tokens.ts — update if Pi adds new tokens.
export const FOREGROUND_THEME_TOKENS: readonly string[] = [
  'accent', 'border', 'borderAccent', 'borderMuted', 'success', 'error', 'warning',
  'muted', 'dim', 'text', 'thinkingText', 'scrollbarTrack', 'scrollbarThumb',
  'searchMatchText', 'userMessageText', 'customMessageText', 'customMessageLabel',
  'toolTitle', 'toolOutput', 'mdHeading', 'mdLink', 'mdLinkUrl', 'mdCode',
  'mdCodeBlock', 'mdCodeBlockBorder', 'mdQuote', 'mdQuoteBorder', 'mdHr',
  'mdListBullet', 'toolDiffAdded', 'toolDiffRemoved', 'toolDiffContext',
  'syntaxComment', 'syntaxKeyword', 'syntaxFunction', 'syntaxVariable',
  'syntaxString', 'syntaxNumber', 'syntaxType', 'syntaxOperator',
  'syntaxPunctuation', 'thinkingOff', 'thinkingMinimal', 'thinkingLow',
  'thinkingMedium', 'thinkingHigh', 'thinkingXhigh', 'thinkingMax', 'bashMode',
];

export type FooterColorKey = 'cwd' | 'branch' | 'model' | 'tokens' | 'context' | 'mcpOk' | 'mcpBad' | 'limitsProvider' | 'limitsAnthropic' | 'limitsCodex';
export const DEFAULT_FOOTER_COLORS: Record<FooterColorKey, string> = {
  cwd: 'dim', branch: 'dim', model: 'accent', tokens: 'dim', context: 'dim', mcpOk: 'success', mcpBad: 'error', limitsProvider: 'dim', limitsAnthropic: '#D97757', limitsCodex: '#4A90E2',
};

type ResolvedColor = { kind: 'token'; token: string } | { kind: 'hex'; color: Color };

export function parseHexColor(value: string): Color | undefined {
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return undefined;
  const hex = value.length === 4 ? [...value.slice(1)].map((digit) => digit + digit).join('') : value.slice(1);
  return { kind: 'rgb', r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
}

export function resolveColorValue(value: unknown, validTokens: ReadonlySet<string>): ResolvedColor | { kind: 'invalid' } {
  if (typeof value !== 'string') return { kind: 'invalid' };
  if (validTokens.has(value)) return { kind: 'token', token: value };
  const color = parseHexColor(value);
  return color ? { kind: 'hex', color } : { kind: 'invalid' };
}

export function resolveFooterColors(rawConfig: unknown, validTokens: ReadonlySet<string>): Record<FooterColorKey, ResolvedColor> {
  const config = rawConfig !== null && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
    ? rawConfig as Record<string, unknown> : {};
  const colors = {} as Record<FooterColorKey, ResolvedColor>;
  for (const key of Object.keys(DEFAULT_FOOTER_COLORS) as FooterColorKey[]) {
    const candidate = resolveColorValue(config[key], validTokens);
    const fallback = resolveColorValue(DEFAULT_FOOTER_COLORS[key], validTokens);
    if (candidate.kind !== 'invalid') colors[key] = candidate;
    else if (fallback.kind !== 'invalid') colors[key] = fallback;
    else throw new Error(`Invalid default footer color: ${key}`);
  }
  return colors;
}

export function composeFooterLines(left: string, center: string, right: string, width: number): string[] {
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  // Preserve the pre-model footer's first line; clipping left/right in extremely narrow terminals is outside this feature's scope.
  const firstLine = () => truncateToWidth(left + ' '.repeat(Math.max(1, width - leftWidth - rightWidth)) + right, width);
  if (!center) return [firstLine()];

  const centerWidth = visibleWidth(center);
  const centerStart = Math.floor((width - centerWidth) / 2);
  if (centerStart >= leftWidth + 2 && centerStart + centerWidth + 2 <= width - rightWidth) {
    return [left + ' '.repeat(centerStart - leftWidth) + center
      + ' '.repeat(width - rightWidth - centerStart - centerWidth) + right];
  }
  return [firstLine(), truncateToWidth(' '.repeat(Math.max(0, centerStart)) + center, width)];
}

export function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const thousands = (n / 1000).toFixed(1);
    if (Number(thousands) < 1000) return `${thousands}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCwd(cwd: string, home: string): string {
  if (cwd === home) return '~';
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

type McpConfig = { mcpServers?: Record<string, { enabled?: boolean }> };

export function countEnabledMcpServers(userConfig?: McpConfig, projectConfig?: McpConfig): { total: number; names: string[] } {
  const servers = { ...userConfig?.mcpServers };
  for (const [name, config] of Object.entries(projectConfig?.mcpServers ?? {})) {
    servers[name] = { ...servers[name], ...config };
  }
  const names = Object.entries(servers).filter(([, config]) => config?.enabled !== false).map(([name]) => name);
  return { total: names.length, names };
}

export function countConnectedMcp(allToolNamespaces: string[], serverNames: string[]): number {
  const namespaces = new Set(allToolNamespaces);
  return serverNames.filter((name) => namespaces.has(`mcp__${name.replace(/-/g, '_')}`)).length;
}
