import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { readStoredCredential, type ExtensionAPI, type ThemeColor } from '@earendil-works/pi-coding-agent';
import { fmt, formatCwd, countEnabledMcpServers, countConnectedMcp, resolveFooterColors, composeFooterLines, FOREGROUND_THEME_TOKENS } from './pi-theme-minimalism/helpers.ts';
import { parseAnthropicLimits, parseAnthropicUnifiedLimits, parseOpenAILimits, mergeProviderLimits, mergeAnthropicUnifiedLimits, mergeCodexUsageLimits, formatProviderLimitsSegments, fetchAnthropicUsage, fetchCodexUsage, type ProviderLimits, type AnthropicUnifiedLimits, type CodexUsageLimits } from './pi-theme-minimalism/provider-limits.ts';

const validTokens = new Set(FOREGROUND_THEME_TOKENS);

type McpConfig = { mcpServers?: Record<string, { enabled?: boolean }> };

function readMcpConfig(path: string): McpConfig | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as McpConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function readColorConfig(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export default function (pi: ExtensionAPI) {
  let unsubscribeProviderResponse: (() => void) | undefined;
  pi.on('session_shutdown', () => {
    unsubscribeProviderResponse?.();
    unsubscribeProviderResponse = undefined;
  });
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return;

    const home = homedir();
    const limitsByProvider = new Map<string, ProviderLimits>();
    const unifiedByProvider = new Map<string, AnthropicUnifiedLimits>();
    const codexByProvider = new Map<string, CodexUsageLimits>();
    let requestWidgetRender: (() => void) | undefined;
    // A slow startup request must not replace limits already seen in a model response.
    let anthropicUpdated = false;
    const loadUsage = async () => {
      await Promise.all((['anthropic', 'openai-codex'] as const).map(async (provider) => {
        try {
          const credential = readStoredCredential(provider);
          if (credential?.type !== 'oauth') return;
          if (provider === 'anthropic') {
            const usage = await fetchAnthropicUsage(credential.access);
            if (usage) {
              unifiedByProvider.set(provider, anthropicUpdated
                ? mergeAnthropicUnifiedLimits(usage, unifiedByProvider.get(provider)!) : usage);
              requestWidgetRender?.();
            }
          } else {
            const usage = await fetchCodexUsage(credential.access);
            if (usage) {
              codexByProvider.set(provider, mergeCodexUsageLimits(codexByProvider.get(provider), usage));
              requestWidgetRender?.();
            }
          }
        } catch { /* Missing or unreadable credentials must not affect the footer. */ }
      }));
    };
    void loadUsage();
    unsubscribeProviderResponse = pi.on('after_provider_response', (event, responseCtx) => {
      const providerId = responseCtx.model?.provider;
      if (!providerId) return;
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
