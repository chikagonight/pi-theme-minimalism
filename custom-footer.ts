import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { readStoredCredential, type ExtensionAPI, type ThemeColor } from '@earendil-works/pi-coding-agent';
import { type McpConfig, fmt, formatCwd, parseMcpConfig, countEnabledMcpServers, countConnectedMcp, resolveFooterColors, composeFooterLines, FOREGROUND_THEME_TOKENS } from './pi-theme-minimalism/helpers.ts';
import { parseAnthropicLimits, parseAnthropicUnifiedLimits, parseOpenAILimits, mergeProviderLimits, mergeAnthropicUnifiedLimits, mergeCodexUsageLimits, formatProviderLimitsSegments, fetchAnthropicUsage, fetchCodexUsage, type ProviderLimits, type AnthropicUnifiedLimits, type CodexUsageLimits } from './pi-theme-minimalism/provider-limits.ts';

const validTokens = new Set(FOREGROUND_THEME_TOKENS);

// Codex subscription usage is refetched after a Codex model response, at most once per this interval
// (counted from the end of the previous request) and never in parallel.
const CODEX_USAGE_REFRESH_MS = 5 * 60_000;

function isMissingFile(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// Render must never throw: a missing config means "no servers"; an unreadable, malformed or
// structurally invalid one (e.g. mid-edit, permissions, replaced by a directory) keeps the last valid value.
const lastValidMcpConfig = new Map<string, McpConfig>();
function readMcpConfig(path: string): McpConfig | undefined {
  try {
    const config = parseMcpConfig(JSON.parse(readFileSync(path, 'utf8')));
    if (config) lastValidMcpConfig.set(path, config);
    return config ?? lastValidMcpConfig.get(path);
  } catch (error) {
    if (!isMissingFile(error)) return lastValidMcpConfig.get(path);
    lastValidMcpConfig.delete(path);
    return undefined;
  }
}

// Any read or parse failure falls back to default colors (field-level validation is in resolveFooterColors).
function readColorConfig(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  let stopSession: (() => void) | undefined;
  pi.on('session_shutdown', () => {
    stopSession?.();
    stopSession = undefined;
  });
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    stopSession?.();

    const home = homedir();
    const limitsByProvider = new Map<string, ProviderLimits>();
    const unifiedByProvider = new Map<string, AnthropicUnifiedLimits>();
    const codexByProvider = new Map<string, CodexUsageLimits>();
    let requestWidgetRender: (() => void) | undefined;
    // A slow startup request must not replace limits already seen in a model response.
    let anthropicUpdated = false;
    // Aborted on session_shutdown so in-flight usage requests neither linger nor update a dead session.
    const usageAbort = new AbortController();
    let codexLoadedAt = -Infinity; // when the last Codex usage request settled
    let codexLoading = false;
    const loadUsage = async (provider: 'anthropic' | 'openai-codex') => {
      if (provider === 'openai-codex') {
        if (codexLoading || Date.now() - codexLoadedAt < CODEX_USAGE_REFRESH_MS) return;
        codexLoading = true;
      }
      try {
        const credential = readStoredCredential(provider);
        if (credential?.type !== 'oauth') return;
        const options = { signal: usageAbort.signal };
        if (provider === 'anthropic') {
          const usage = await fetchAnthropicUsage(credential.access, fetch, options);
          if (usage && !usageAbort.signal.aborted) {
            unifiedByProvider.set(provider, anthropicUpdated
              ? mergeAnthropicUnifiedLimits(usage, unifiedByProvider.get(provider)!) : usage);
            requestWidgetRender?.();
          }
        } else {
          const usage = await fetchCodexUsage(credential.access, fetch, options);
          if (usage && !usageAbort.signal.aborted) {
            codexByProvider.set(provider, mergeCodexUsageLimits(codexByProvider.get(provider), usage));
            requestWidgetRender?.();
          }
        }
      } catch { /* Missing or unreadable credentials must not affect the footer. */ } finally {
        if (provider === 'openai-codex') {
          codexLoading = false;
          codexLoadedAt = Date.now();
        }
      }
    };
    void loadUsage('anthropic');
    void loadUsage('openai-codex');
    const unsubscribeProviderResponse = pi.on('after_provider_response', (event, responseCtx) => {
      const providerId = responseCtx.model?.provider;
      if (!providerId) return;
      if (providerId === 'openai-codex') void loadUsage(providerId);
      const limits = providerId === 'anthropic' ? parseAnthropicLimits(event.headers)
        : providerId === 'openai' ? parseOpenAILimits(event.headers)
        : parseAnthropicLimits(event.headers) ?? parseOpenAILimits(event.headers);
      const unified = providerId === 'anthropic' ? parseAnthropicUnifiedLimits(event.headers) : undefined;
      if (limits) limitsByProvider.set(providerId, mergeProviderLimits(limitsByProvider.get(providerId), limits));
      if (unified) {
        anthropicUpdated = true;
        unifiedByProvider.set(providerId, mergeAnthropicUnifiedLimits(unifiedByProvider.get(providerId), unified));
      }
      if (limits || unified) requestWidgetRender?.();
    });
    stopSession = () => {
      unsubscribeProviderResponse();
      usageAbort.abort();
      requestWidgetRender = undefined;
    };
    ctx.ui.setWidget('provider-limits', (tui, theme) => {
      requestWidgetRender = () => tui.requestRender();
      return {
        dispose() { requestWidgetRender = undefined; },
        invalidate() {},
        render(width: number): string[] {
          const segments = formatProviderLimitsSegments(limitsByProvider, unifiedByProvider, codexByProvider);
          if (segments.length === 0) return [];
          const colors = resolveFooterColors(readColorConfig(join(home, '.pi/agent/pi-theme-minimalism/colors.json')), validTokens);
          const line = segments.map(({ provider, text }) => {
            const color = colors[provider === 'anthropic' ? 'limitsAnthropic' : provider === 'openai-codex' ? 'limitsCodex' : 'limitsProvider'];
            return color.kind === 'token' ? theme.fg(color.token as ThemeColor, text) : theme.style(text, { fg: color.color });
          }).join('  ');
          return [truncateToWidth(line, width)];
        },
      };
    }, { placement: 'aboveEditor' });
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          let input = 0;
          let output = 0;
          for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type === 'message' && entry.message.role === 'assistant') {
              const message = entry.message as AssistantMessage;
              input += message.usage.input;
              output += message.usage.output;
            }
          }

          const colors = resolveFooterColors(readColorConfig(join(home, '.pi/agent/pi-theme-minimalism/colors.json')), validTokens);
          const paint = (key: keyof typeof colors, text: string): string => {
            const color = colors[key];
            return color.kind === 'token' ? theme.fg(color.token as ThemeColor, text) : theme.style(text, { fg: color.color });
          };
          const branch = footerData.getGitBranch();
          const left = paint('cwd', formatCwd(ctx.cwd, home)) + (branch === null ? '' : ` ${paint('branch', `(${branch})`)}`);
          const blocks = [paint('tokens', `↑${fmt(input)} ↓${fmt(output)}`)];
          const usage = ctx.getContextUsage();
          if (usage !== undefined) blocks.push(paint('context', `${usage.tokens === null ? '—' : fmt(usage.tokens)}/${fmt(usage.contextWindow)}`));
          const userConfig = readMcpConfig(join(home, '.pi/agent/mcp.json'));
          const projectConfig = ctx.isProjectTrusted() ? readMcpConfig(join(ctx.cwd, '.pi/mcp.json')) : undefined;
          const { total, names } = countEnabledMcpServers(userConfig, projectConfig);
          const tools = pi.getAllTools();
          const connected = countConnectedMcp(tools.map((tool) => tool.namespace?.name ?? ''), names);
          const right = blocks.join('  ') + (total === 0 ? '' : `  ${paint(connected === total ? 'mcpOk' : 'mcpBad', `MCP:${connected}/${total}`)}`);

          const center = ctx.model ? paint('model', ctx.model.name + (ctx.thinkingLevel ? ` · ${ctx.thinkingLevel}` : '')) : '';
          return composeFooterLines(left, center, right, width);
        },
      };
    });
  });
}
