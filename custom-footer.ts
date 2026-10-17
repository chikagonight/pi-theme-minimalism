import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ThemeColor } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { fmt, formatCwd, countEnabledMcpServers, countConnectedMcp, resolveFooterColors, FOREGROUND_THEME_TOKENS } from './custom-theme-minimalism/helpers.ts';

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
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return;

    const home = homedir();
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

          const colors = resolveFooterColors(readColorConfig(join(home, '.pi/agent/custom-theme-minimalism/colors.json')), validTokens);
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

          const pad = ' '.repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
          return [truncateToWidth(left + pad + right, width)];
        },
      };
    });
  });
}
