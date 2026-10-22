import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';

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

function startFooter(theme = { fg: (_token, text) => text, style: (text) => text }) {
  const handlers = new Map();
  let widgetFactory;
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  };
  customFooter(pi);
  handlers.get('session_start')({}, {
    mode: 'tui',
    ui: {
      setWidget(_name, factory) { widgetFactory = factory; },
      setFooter() {},
    },
  });
  assert.equal(typeof widgetFactory, 'function');
  const widget = widgetFactory({ requestRender() {} }, theme);
  return {
    headers: (provider = 'openai-codex', responseHeaders = headers) => handlers.get('after_provider_response')({ headers: responseHeaders }, { model: { provider } }),
    lines: () => widget.render(120),
    shutdown: () => handlers.get('session_shutdown')(),
  };
}

test('provider widget renders one line with provider-specific colors and dim fallback', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false });
  try {
    const theme = {
      fg: (token, text) => `<${token}>${text}</${token}>`,
      style: (text, { fg }) => `<${fg.r},${fg.g},${fg.b}>${text}</color>`,
    };
    const footer = startFooter(theme);
    try {
      assert.deepEqual(footer.lines(), []);
      footer.headers('anthropic', { 'anthropic-ratelimit-requests-remaining': '2', 'anthropic-ratelimit-requests-limit': '5' });
      assert.deepEqual(footer.lines(), ['<217,119,87>anthropic req 2/5</color>']);
      footer.headers('openai-codex');
      footer.headers('zai', { 'x-ratelimit-remaining-requests': '1', 'x-ratelimit-limit-requests': '3' });
      assert.deepEqual(footer.lines(), ['<217,119,87>anthropic req 2/5</color>  <74,144,226>openai-codex req 4/5</color>  <dim>zai req 1/3</dim>']);
    } finally { footer.shutdown(); }
  } finally { globalThis.fetch = originalFetch; }
});

for (const headersFirst of [true, false]) {
  test(`Codex session_start and after_provider_response merge when ${headersFirst ? 'headers precede fetch' : 'fetch precedes headers'}`, async () => {
    const originalFetch = globalThis.fetch;
    let finishFetch;
    globalThis.fetch = (url, options) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      return new Promise((resolve) => { finishFetch = resolve; });
    };
    let footer;
    try {
      footer = startFooter(); // Fresh extension state and maps for each arrival order.
      assert.equal(typeof finishFetch, 'function');
      if (headersFirst) {
        footer.headers();
        assert.deepEqual(footer.lines(), ['openai-codex req 4/5']);
      }
      finishFetch({ ok: true, json: async () => ({ rate_limit: {
        primary_window: { used_percent: 12 }, secondary_window: { used_percent: 3 },
      } }) });
      await new Promise((resolve) => setImmediate(resolve));
      if (!headersFirst) {
        assert.deepEqual(footer.lines(), ['openai-codex 5h|█░░░░|12%|-||wk|░░░░░|3%|-']);
        footer.headers();
      }
      assert.deepEqual(footer.lines(), expected);
    } finally {
      footer?.shutdown();
      globalThis.fetch = originalFetch;
    }
  });
}
