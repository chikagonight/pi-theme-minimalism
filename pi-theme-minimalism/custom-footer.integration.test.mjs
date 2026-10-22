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

function startFooter() {
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
  const widget = widgetFactory({ requestRender() {} }, { fg: (_token, text) => text, style: (text) => text });
  return {
    headers: () => handlers.get('after_provider_response')({ headers }, { model: { provider: 'openai-codex' } }),
    lines: () => widget.render(120),
    shutdown: () => handlers.get('session_shutdown')(),
  };
}

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
