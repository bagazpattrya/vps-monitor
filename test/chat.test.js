'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildClaudeArgs, parseStreamLine, buildSandbox, createLimiter } = require('../chat.js');

const UUID = '123e4567-e89b-12d3-a456-426614174000';

test('buildClaudeArgs includes allow list and deny list', () => {
  const a = buildClaudeArgs({});
  assert.ok(a.includes('-p'));
  assert.strictEqual(a[a.indexOf('--allowedTools') + 1], 'Read,Grep,Glob');
  const deny = a[a.indexOf('--disallowedTools') + 1];
  for (const t of ['Bash', 'Edit', 'Write', 'WebFetch', 'Read(**/.env*)']) assert.ok(deny.includes(t), t);
  assert.strictEqual(a[a.indexOf('--setting-sources') + 1], 'user');
  assert.ok(!a.includes('--dangerously-skip-permissions'));
});

test('buildClaudeArgs adds --resume only for a UUID', () => {
  const a = buildClaudeArgs({ sessionId: UUID });
  assert.strictEqual(a[a.indexOf('--resume') + 1], UUID);
  assert.throws(() => buildClaudeArgs({ sessionId: '--dangerously-skip-permissions' }), /bad session/);
});

test('parseStreamLine extracts assistant text', () => {
  const l = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
  assert.deepStrictEqual(parseStreamLine(l), { text: 'hi' });
});

test('parseStreamLine extracts result', () => {
  assert.deepStrictEqual(parseStreamLine('{"type":"result","session_id":"S","is_error":false}'), { sessionId: 'S', done: true });
  const e = parseStreamLine('{"type":"result","session_id":"S","is_error":true,"result":"boom"}');
  assert.strictEqual(e.done, true);
  assert.ok(e.error);
});

test('parseStreamLine ignores garbage', () => {
  assert.strictEqual(parseStreamLine('not json'), null);
  assert.strictEqual(parseStreamLine(''), null);
});

test('buildSandbox links only given directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbroot-'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sbbase-'));
  for (const d of ['a', 'b', '.git']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'f'), 'x');
  const dir = buildSandbox(base, 'u', ['a', 'f', '.git', '../x'], root);
  assert.deepStrictEqual(fs.readdirSync(dir), ['a']);
  assert.ok(fs.lstatSync(path.join(dir, 'a')).isSymbolicLink());
  buildSandbox(base, 'u', ['b'], root);
  assert.deepStrictEqual(fs.readdirSync(dir), ['b']);
});

test('limiter blocks concurrent and over-quota', () => {
  let t = 0;
  const lim = createLimiter({ perHour: 20, now: () => t });
  const first = lim.acquire('u');
  assert.strictEqual(first.ok, true);
  const second = lim.acquire('u');
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.status, 429);
  first.release();
  for (let i = 1; i < 20; i++) lim.acquire('u').release();
  assert.strictEqual(lim.acquire('u').ok, false);
  t += 3600_001;
  assert.strictEqual(lim.acquire('u').ok, true);
});
