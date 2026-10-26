import assert from 'node:assert/strict';
import { test } from 'node:test';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { fmt, formatCwd, parseMcpConfig, countEnabledMcpServers, countConnectedMcp, parseHexColor, resolveColorValue, resolveFooterColors, DEFAULT_FOOTER_COLORS, FOREGROUND_THEME_TOKENS, composeFooterLines } from './helpers.ts';

test('composeFooterLines preserves the original layout without a center', () => {
  assert.deepEqual(composeFooterLines('left', '', 'right', 16), ['left       right']);
  assert.deepEqual(composeFooterLines('left', '', 'right', 5), [truncateToWidth('left right', 5)]);
});

test('composeFooterLines preserves legacy first-line truncation when left and right do not fit', () => {
  const left = 'very-long-left';
  const right = 'RIGHT';
  const width = 12;
  const legacyFirstLine = truncateToWidth(
    left + ' '.repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right))) + right, width,
  );
  for (const center of ['', 'model']) {
    const lines = composeFooterLines(left, center, right, width);
    assert.equal(lines[0], legacyFirstLine);
    assert.ok(!lines[0].includes(right));
    assert.equal(lines.length, center ? 2 : 1);
  }
});

test('composeFooterLines centers the model in the whole width with two spaces on each side', () => {
  const lines = composeFooterLines('left', 'model', 'right', 21);
  assert.deepEqual(lines, ['left    model   right']);
  assert.equal(lines[0].indexOf('model'), Math.floor((21 - 5) / 2));
  assert.deepEqual(composeFooterLines('left', 'model', 'right', 18), ['left  model  right']);
});

test('composeFooterLines wraps rather than discarding blocks when they cannot fit around the center', () => {
  assert.deepEqual(composeFooterLines('left', 'model', 'right', 17), ['left        right', '      model']);
});

test('composeFooterLines truncates only a center wider than the terminal on its own line', () => {
  assert.deepEqual(composeFooterLines('L', 'longmodel', 'R', 5), ['L   R', truncateToWidth('longmodel', 5)]);
});

test('composeFooterLines measures ANSI-colored blocks by visible columns', () => {
  const left = '\x1b[2mL\x1b[0m';
  const center = '\x1b[31mmodel\x1b[0m';
  const right = '\x1b[2mR\x1b[0m';
  const lines = composeFooterLines(left, center, right, 11);
  assert.deepEqual(lines, [`${left}  ${center}  ${right}`]);
  assert.equal(visibleWidth(lines[0]), 11);
  assert.deepEqual(composeFooterLines(left, center, right, 10), [`${left}        ${right}`, `  ${center}`]);
});

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

test('parseMcpConfig accepts valid MCP configs and rejects malformed structures', () => {
  assert.deepEqual(parseMcpConfig({}), {});
  assert.deepEqual(parseMcpConfig({ other: 1 }), { other: 1 });
  const valid = { mcpServers: { alpha: {}, beta: { enabled: false, command: 'x' } } };
  assert.deepEqual(parseMcpConfig(valid), valid);
  for (const raw of [undefined, null, [], 'x', 1, { mcpServers: null }, { mcpServers: [] }, { mcpServers: 'alpha' },
    { mcpServers: { alpha: 1 } }, { mcpServers: { alpha: null } }, { mcpServers: { alpha: [] } }, { mcpServers: { alpha: { enabled: 'no' } } }]) {
    assert.equal(parseMcpConfig(raw), undefined, JSON.stringify(raw));
  }
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

test('resolveFooterColors resolves provider defaults and configured overrides', () => {
  const tokens = new Set(['dim', 'success', 'error', 'accent']);
  const defaults = resolveFooterColors(undefined, tokens);
  assert.deepEqual(defaults.limitsAnthropic, { kind: 'hex', color: { kind: 'rgb', r: 217, g: 119, b: 87 } });
  assert.deepEqual(defaults.limitsCodex, { kind: 'hex', color: { kind: 'rgb', r: 74, g: 144, b: 226 } });
  assert.deepEqual(defaults.limitsProvider, { kind: 'token', token: 'dim' });
  const overrides = resolveFooterColors({ limitsAnthropic: 'accent', limitsCodex: '#123456' }, tokens);
  assert.deepEqual(overrides.limitsAnthropic, { kind: 'token', token: 'accent' });
  assert.deepEqual(overrides.limitsCodex, { kind: 'hex', color: { kind: 'rgb', r: 18, g: 52, b: 86 } });
});

test('resolveFooterColors uses defaults for missing and invalid configs', () => {
  const tokens = new Set(['dim', 'success', 'error', 'accent']);
  const defaults = Object.fromEntries(Object.entries(DEFAULT_FOOTER_COLORS).map(([key, value]) => [key, resolveColorValue(value, tokens)]));
  assert.deepEqual(resolveFooterColors(undefined, tokens), defaults);
  assert.deepEqual(resolveFooterColors({}, tokens), defaults);
  for (const raw of [null, [], 'dim']) {
    assert.deepEqual(resolveFooterColors(raw, tokens), defaults);
  }
});

test('resolveFooterColors applies each valid field independently', () => {
  const tokens = new Set(['dim', 'success', 'error', 'accent']);
  const defaults = Object.fromEntries(Object.entries(DEFAULT_FOOTER_COLORS).map(([key, value]) => [key, resolveColorValue(value, tokens)]));
  const red = { kind: 'hex', color: { kind: 'rgb', r: 255, g: 0, b: 0 } };
  assert.deepEqual(resolveFooterColors({ model: '#ff0000' }, tokens), { ...defaults, model: red });
  assert.deepEqual(resolveFooterColors({ mcpOk: '#ff0000' }, tokens), { ...defaults, mcpOk: red });
  assert.deepEqual(resolveFooterColors({ cwd: 'accent', branch: 'bad', mcpOk: '#ff0000' }, tokens), {
    ...defaults, cwd: { kind: 'token', token: 'accent' }, mcpOk: red,
  });
});
