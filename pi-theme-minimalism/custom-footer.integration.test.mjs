import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { registerHooks } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Only the pi credential boundary is mocked; the extension and its event handlers are real.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@earendil-works/pi-coding-agent') {
      return { url: 'data:text/javascript,export const readStoredCredential = (provider) => provider === "openai-codex" ? { type: "oauth", access: "test-token" } : undefined;', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { default: customFooter } = await import('../custom-footer.ts');
hooks.deregister();

const headers = { 'x-ratelimit-remaining-requests': '4', 'x-ratelimit-limit-requests': '5' };
const expected = ['openai-codex req 4/5 · 5h|█░░░░|12%|-||wk|░░░░░|3%|-'];
const plainTheme = { fg: (_token, text) => text, style: (text) => text };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const codexUsage = (primary, secondary = 3) => ({ ok: true, json: async () => ({ rate_limit: {
  primary_window: { used_percent: primary }, secondary_window: { used_percent: secondary },
} }) });

// Every session gets its own HOME so the user's ~/.pi/agent files never leak into the tests.
const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'pi-footer-test-'));
  mkdirSync(join(home, '.pi/agent/pi-theme-minimalism'), { recursive: true });
  mkdirSync(join(home, 'project/.pi'), { recursive: true });
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function mockFetch(impl) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl;
  cleanups.push(() => { globalThis.fetch = originalFetch; });
}

function startFooter({ theme = plainTheme, home = makeHome(), model = { name: 'gpt-5', provider: 'openai-codex' }, tools = [] } = {}) {
  const handlers = new Map();
  let widgetFactory;
  let footerFactory;
  const branchListeners = new Set();
  const renders = { widget: 0, footer: 0 };
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
      return () => { if (handlers.get(name) === handler) handlers.delete(name); };
    },
    getAllTools: () => tools,
  };
  const ctx = {
    mode: 'tui',
    cwd: join(home, 'project'),
    model,
    thinkingLevel: 'high',
    isProjectTrusted: () => true,
    getContextUsage: () => ({ tokens: 1500, contextWindow: 200000 }),
    sessionManager: { getBranch: () => [
      { type: 'message', message: { role: 'assistant', usage: { input: 1200, output: 300 } } },
      { type: 'message', message: { role: 'user' } },
    ] },
    ui: {
      setWidget(_name, factory) { widgetFactory = factory; },
      setFooter(factory) { footerFactory = factory; },
    },
  };
  customFooter(pi);
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try { handlers.get('session_start')({ type: 'session_start' }, ctx); } finally { process.env.HOME = originalHome; }
  assert.equal(typeof widgetFactory, 'function');
  assert.equal(typeof footerFactory, 'function');
  const widget = widgetFactory({ requestRender() { renders.widget++; } }, theme);
  const footer = footerFactory({ requestRender() { renders.footer++; } }, theme, {
    getGitBranch: () => 'main',
    onBranchChange(listener) {
      branchListeners.add(listener);
      return () => branchListeners.delete(listener);
    },
  });
  return {
    ctx, home, handlers, branchListeners, renders, footer,
    headers: (provider = 'openai-codex', responseHeaders = headers) => handlers.get('after_provider_response')?.({ headers: responseHeaders }, { model: { provider } }),
    lines: () => widget.render(120),
    footerLines: (width = 120) => footer.render(width),
    shutdown: () => handlers.get('session_shutdown')?.({ type: 'session_shutdown', reason: 'quit' }),
  };
}

test('provider widget renders one line with provider-specific colors and dim fallback', async () => {
  mockFetch(async () => ({ ok: false }));
  const theme = {
    fg: (token, text) => `<${token}>${text}</${token}>`,
    style: (text, { fg }) => `<${fg.r},${fg.g},${fg.b}>${text}</color>`,
  };
  const footer = startFooter({ theme });
  try {
    assert.deepEqual(footer.lines(), []);
    footer.headers('anthropic', { 'anthropic-ratelimit-requests-remaining': '2', 'anthropic-ratelimit-requests-limit': '5' });
    assert.deepEqual(footer.lines(), ['<217,119,87>anthropic req 2/5</color>']);
    footer.headers('openai-codex');
    footer.headers('zai', { 'x-ratelimit-remaining-requests': '1', 'x-ratelimit-limit-requests': '3' });
    assert.deepEqual(footer.lines(), ['<217,119,87>anthropic req 2/5</color>  <74,144,226>openai-codex req 4/5</color>  <dim>zai req 1/3</dim>']);
  } finally { footer.shutdown(); }
});

for (const headersFirst of [true, false]) {
  test(`Codex session_start and after_provider_response merge when ${headersFirst ? 'headers precede fetch' : 'fetch precedes headers'}`, async () => {
    let finishFetch;
    mockFetch((url, options) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      return new Promise((resolve) => { finishFetch = resolve; });
    });
    const footer = startFooter(); // Fresh extension state and maps for each arrival order.
    try {
      assert.equal(typeof finishFetch, 'function');
      if (headersFirst) {
        footer.headers();
        assert.deepEqual(footer.lines(), ['openai-codex req 4/5']);
      }
      finishFetch(codexUsage(12));
      await tick();
      if (!headersFirst) {
        assert.deepEqual(footer.lines(), ['openai-codex 5h|█░░░░|12%|-||wk|░░░░░|3%|-']);
        footer.headers();
      }
      assert.deepEqual(footer.lines(), expected);
    } finally { footer.shutdown(); }
  });
}

test('footer renders cwd, branch, model, tokens, context and MCP status with colors from the isolated HOME', () => {
  mockFetch(async () => ({ ok: false }));
  const home = makeHome();
  writeFileSync(join(home, '.pi/agent/pi-theme-minimalism/colors.json'), JSON.stringify({ model: 'warning', mcpBad: '#ff0000' }));
  writeFileSync(join(home, '.pi/agent/mcp.json'), JSON.stringify({ mcpServers: { alpha: {}, 'beta-x': {}, off: { enabled: false } } }));
  const theme = {
    fg: (token, text) => `<${token}>${text}</${token}>`,
    style: (text, { fg }) => `<${fg.r},${fg.g},${fg.b}>${text}</color>`,
  };
  const footer = startFooter({ theme, home, tools: [{ namespace: { name: 'mcp__alpha' } }, { name: 'read' }] });
  try {
    const [line, ...rest] = footer.footerLines(400);
    assert.deepEqual(rest, []);
    assert.match(line, /^<dim>~\/project<\/dim> <dim>\(main\)<\/dim> +<warning>gpt-5 · high<\/warning> +<dim>↑1\.2k ↓300<\/dim>  <dim>1\.5k\/200\.0k<\/dim>  <255,0,0>MCP:1\/2<\/color>$/);
  } finally { footer.shutdown(); }
});

test('footer follows model changes and wraps the model when the terminal is narrow', () => {
  mockFetch(async () => ({ ok: false }));
  const footer = startFooter();
  try {
    assert.match(footer.footerLines(80)[0], /gpt-5 · high/);
    footer.ctx.model = { name: 'claude-opus', provider: 'anthropic' };
    footer.ctx.thinkingLevel = undefined;
    const [line] = footer.footerLines(80);
    assert.match(line, /claude-opus/);
    assert.doesNotMatch(line, /gpt-5|· high/);
    footer.ctx.model = undefined;
    assert.deepEqual(footer.footerLines(40).length, 1);
    footer.ctx.model = { name: 'gpt-5', provider: 'openai-codex' };
    footer.ctx.thinkingLevel = 'high';
    const narrow = footer.footerLines(30);
    assert.equal(narrow.length, 2);
    assert.equal(narrow[1].trim(), 'gpt-5 · high');
  } finally { footer.shutdown(); }
});

test('footer render survives broken, unreadable or replaced MCP configs and keeps the last valid one', () => {
  mockFetch(async () => ({ ok: false }));
  const footer = startFooter({ tools: [{ namespace: { name: 'mcp__alpha' } }] });
  const userConfig = join(footer.home, '.pi/agent/mcp.json');
  const projectConfig = join(footer.home, 'project/.pi/mcp.json');
  const mcp = () => footer.footerLines(200)[0].match(/MCP:\d+\/\d+/)?.[0];
  try {
    assert.equal(mcp(), undefined);
    writeFileSync(userConfig, JSON.stringify({ mcpServers: { alpha: {}, beta: {} } }));
    writeFileSync(projectConfig, JSON.stringify({ mcpServers: { gamma: {} } }));
    assert.equal(mcp(), 'MCP:1/3');

    for (const broken of ['{ "mcpServers": ', 'null', '[]', '{"mcpServers": []}', '{"mcpServers": "alpha"}', '{"mcpServers": {"alpha": 1}}']) {
      writeFileSync(userConfig, broken);
      assert.equal(mcp(), 'MCP:1/3', broken);
    }
    writeFileSync(projectConfig, '{oops');
    assert.equal(mcp(), 'MCP:1/3');

    if (process.getuid?.() !== 0) {
      writeFileSync(userConfig, JSON.stringify({ mcpServers: { alpha: {} } }));
      assert.equal(mcp(), 'MCP:1/2');
      chmodSync(userConfig, 0o000);
      assert.equal(mcp(), 'MCP:1/2');
      chmodSync(userConfig, 0o600);
    }

    rmSync(userConfig);
    mkdirSync(userConfig);
    assert.doesNotThrow(() => footer.footerLines(200));
    assert.match(mcp(), /^MCP:1\/[23]$/);

    // A removed config is a valid state: its servers disappear.
    rmSync(userConfig, { recursive: true });
    rmSync(projectConfig);
    assert.equal(mcp(), undefined);
  } finally { footer.shutdown(); }
});

test('footer and widget render with default colors when colors.json is broken or replaced by a directory', () => {
  mockFetch(async () => ({ ok: false }));
  const theme = {
    fg: (token, text) => `<${token}>${text}</${token}>`,
    style: (text, { fg }) => `<${fg.r},${fg.g},${fg.b}>${text}</color>`,
  };
  const footer = startFooter({ theme });
  const colors = join(footer.home, '.pi/agent/pi-theme-minimalism/colors.json');
  try {
    footer.headers('zai', { 'x-ratelimit-remaining-requests': '1', 'x-ratelimit-limit-requests': '3' });
    writeFileSync(colors, '{ broken');
    assert.match(footer.footerLines(200)[0], /<accent>gpt-5 · high<\/accent>/);
    rmSync(colors);
    mkdirSync(colors);
    assert.match(footer.footerLines(200)[0], /<accent>gpt-5 · high<\/accent>/);
    assert.deepEqual(footer.lines(), ['<dim>zai req 1/3</dim>']);
  } finally { footer.shutdown(); }
});

test('Codex usage refreshes after Codex responses at most once per TTL and never in parallel', async () => {
  const signals = [];
  const pending = [];
  mockFetch((_url, options) => {
    signals.push(options.signal);
    return new Promise((resolve) => pending.push(resolve));
  });
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  cleanups.push(() => { Date.now = originalNow; });
  const footer = startFooter();
  try {
    assert.equal(pending.length, 1); // startup request
    footer.headers();
    now += 10 * 60_000;
    footer.headers();
    assert.equal(pending.length, 1, 'no parallel request while the startup request is in flight');
    pending[0](codexUsage(12));
    await tick();
    assert.deepEqual(footer.lines(), expected);

    footer.headers();
    assert.equal(pending.length, 1, 'fresh data is not refetched within the TTL');
    footer.headers('anthropic', {});
    now += 10 * 60_000;
    footer.headers('anthropic', {});
    assert.equal(pending.length, 1, 'other providers do not trigger a Codex refresh');

    footer.headers();
    assert.equal(pending.length, 2, 'a Codex response after the TTL refreshes usage');
    footer.headers();
    assert.equal(pending.length, 2);
    const rendersBefore = footer.renders.widget;
    pending[1](codexUsage(40, 7));
    await tick();
    assert.ok(footer.renders.widget > rendersBefore);
    assert.deepEqual(footer.lines(), ['openai-codex req 4/5 · 5h|██░░░|40%|-||wk|░░░░░|7%|-']);
    assert.ok(signals.every((signal) => signal instanceof AbortSignal));
  } finally { footer.shutdown(); }
});

test('session_shutdown aborts in-flight usage requests, ignores late results and unsubscribes listeners', async () => {
  const signals = [];
  let finishFetch;
  mockFetch((_url, options) => {
    signals.push(options.signal);
    return new Promise((resolve) => { finishFetch = resolve; });
  });
  const footer = startFooter();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
  assert.equal(footer.branchListeners.size, 1);
  footer.branchListeners.forEach((listener) => listener());
  assert.equal(footer.renders.footer, 1);

  footer.shutdown();
  assert.equal(signals[0].aborted, true);
  assert.equal(footer.handlers.has('after_provider_response'), false);
  assert.doesNotThrow(() => footer.shutdown(), 'shutdown is idempotent');

  finishFetch(codexUsage(50));
  await tick();
  assert.deepEqual(footer.lines(), []);
  assert.equal(footer.renders.widget, 0);

  footer.footer.dispose();
  assert.equal(footer.branchListeners.size, 0);
});
