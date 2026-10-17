import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fmt, formatCwd, countEnabledMcpServers, countConnectedMcp, parseHexColor, resolveColorValue, resolveFooterColors, DEFAULT_FOOTER_COLORS, FOREGROUND_THEME_TOKENS } from './helpers.ts';

test('fmt formats token boundaries without rounding up to 1000.0k', () => {
  for (const [input, expected] of [[0, '0'], [999, '999'], [1000, '1.0k'], [76300, '76.3k'], [999900, '999.9k'], [999949, '999.9k'], [999950, '1.0M'], [999999, '1.0M'], [1000000, '1.0M']]) {
    assert.equal(fmt(input), expected);
    assert.notEqual(fmt(input), '1000.0k');
  }
});

test('formatCwd replaces only the home directory prefix', () => {
  assert.equal(formatCwd('/home/me', '/home/me'), '~');
  assert.equal(formatCwd('/home/me/project', '/home/me'), '~/project');
  assert.equal(formatCwd('/home/meeting', '/home/me'), '/home/meeting');
  assert.equal(formatCwd('/tmp/home/me', '/home/me'), '/tmp/home/me');
});

test('countEnabledMcpServers merges and honors project enabled overrides', () => {
  const user = { mcpServers: { alpha: { enabled: true }, beta: { enabled: false }, gamma: {} } };
  const project = { mcpServers: { alpha: { enabled: false }, beta: { enabled: true }, gamma: { description: 'override' }, delta: {} } };
  assert.deepEqual(countEnabledMcpServers(user, project), { total: 3, names: ['beta', 'gamma', 'delta'] });
  assert.deepEqual(countEnabledMcpServers(undefined, undefined), { total: 0, names: [] });
  assert.deepEqual(countEnabledMcpServers({ mcpServers: { beta: { enabled: false } } }, { mcpServers: { beta: {} } }), { total: 0, names: [] });
});

test('countConnectedMcp matches exact normalized namespaces, not substrings or duplicate tools', () => {
  assert.equal(countConnectedMcp(['mcp__alpha', 'mcp__alpha', 'mcp__my_server', 'mcp__alphabet', 'other'], ['alpha', 'my-server', 'missing']), 2);
  assert.equal(countConnectedMcp([], ['alpha']), 0);
});

test('parseHexColor accepts short and long RGB hex and rejects invalid input', () => {
  assert.deepEqual(parseHexColor('#fff'), { kind: 'rgb', r: 255, g: 255, b: 255 });
  assert.deepEqual(parseHexColor('#000000'), { kind: 'rgb', r: 0, g: 0, b: 0 });
  assert.deepEqual(parseHexColor('#0af'), { kind: 'rgb', r: 0, g: 170, b: 255 });
  assert.deepEqual(parseHexColor('#Aa00Ff'), { kind: 'rgb', r: 170, g: 0, b: 255 });
  for (const value of ['red', '#gg0000', '#12345', '', '#1234567', ' #fff']) {
    assert.equal(parseHexColor(value), undefined);
  }
});

test('foreground theme tokens include late entries and exclude background slots', () => {
  const tokens = new Set(FOREGROUND_THEME_TOKENS);
  assert.equal(FOREGROUND_THEME_TOKENS.length, 49);
  assert.equal(tokens.size, 49);
  for (const token of ['accent', 'dim', 'success', 'error', 'searchMatchText', 'syntaxPunctuation', 'thinkingMax', 'bashMode']) {
    assert.ok(tokens.has(token), token);
  }
  for (const token of ['selectedBg', 'searchMatchBg', 'toolPendingBg', 'userMessageBg']) {
    assert.ok(!tokens.has(token), token);
  }
  assert.deepEqual(resolveColorValue('bashMode', tokens), { kind: 'token', token: 'bashMode' });
});

test('resolveColorValue accepts foreground tokens and hex, rejects other values', () => {
  const tokens = new Set(['dim', 'success']);
  assert.deepEqual(resolveColorValue('dim', tokens), { kind: 'token', token: 'dim' });
  assert.deepEqual(resolveColorValue('#0af', tokens), { kind: 'hex', color: { kind: 'rgb', r: 0, g: 170, b: 255 } });
  for (const value of ['unknown', 42, undefined, null]) {
    assert.deepEqual(resolveColorValue(value, tokens), { kind: 'invalid' });
  }
});

test('resolveFooterColors uses defaults for missing and invalid configs', () => {
  const tokens = new Set(['dim', 'success', 'error', 'accent']);
  const defaults = Object.fromEntries(Object.entries(DEFAULT_FOOTER_COLORS).map(([key, token]) => [key, { kind: 'token', token }]));
  assert.deepEqual(resolveFooterColors(undefined, tokens), defaults);
  assert.deepEqual(resolveFooterColors({}, tokens), defaults);
  for (const raw of [null, [], 'dim']) {
    assert.deepEqual(resolveFooterColors(raw, tokens), defaults);
  }
});

test('resolveFooterColors applies each valid field independently', () => {
  const tokens = new Set(['dim', 'success', 'error', 'accent']);
  const defaults = Object.fromEntries(Object.entries(DEFAULT_FOOTER_COLORS).map(([key, token]) => [key, { kind: 'token', token }]));
  const red = { kind: 'hex', color: { kind: 'rgb', r: 255, g: 0, b: 0 } };
  assert.deepEqual(resolveFooterColors({ mcpOk: '#ff0000' }, tokens), { ...defaults, mcpOk: red });
  assert.deepEqual(resolveFooterColors({ cwd: 'accent', branch: 'bad', mcpOk: '#ff0000' }, tokens), {
    ...defaults, cwd: { kind: 'token', token: 'accent' }, mcpOk: red,
  });
});
