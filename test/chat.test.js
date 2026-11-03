'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const chat = require('../chat.js');
const { buildClaudeArgs, parseStreamLine, buildSandbox, createLimiter } = chat;

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

// ---- handleChat, with a fake `claude` binary driven by the message text ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-'));
const FAKE = path.join(tmp, 'fake-claude.js');
fs.writeFileSync(FAKE, `#!/usr/bin/env node
let msg = '';
process.stdin.on('data', (d) => (msg += d)).on('end', () => {
  const line = (o) => console.log(JSON.stringify(o));
  if (msg === 'ok') {
    line({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify({ argv: process.argv.slice(2), msg, env: Object.keys(process.env) }) }] } });
    line({ type: 'result', session_id: 'S', is_error: false });
  } else if (msg === 'fail') { console.log('garbage'); process.exit(1); }
  else if (msg === 'sleep') { require('fs').writeFileSync('pid', String(process.pid)); setTimeout(() => {}, 20000); }
});
`, { mode: 0o755 });
process.env.CLAUDE_BIN = FAKE;
process.env.CHAT_SANDBOX_DIR = path.join(tmp, 'sb');
process.env.SCAN_DIR = tmp;
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';

let n = 0;
function run({ admin = true, body, user, close, timeoutMs } = {}) {
  if (timeoutMs) process.env.CHAT_TIMEOUT_MS = String(timeoutMs); else delete process.env.CHAT_TIMEOUT_MS;
  const req = new EventEmitter();
  const out = { status: 0, chunks: [] };
  const res = Object.assign(new EventEmitter(), { writeHead(s) { out.status = s; }, write(c) { out.chunks.push(String(c)); }, end(c) { if (c) out.chunks.push(String(c)); } });
  const session = { user: user || 'u' + (++n), admin };
  const p = chat.handleChat({ req, res, session, body, projects: [], log: () => {} }).then(() => {
    out.events = out.chunks.join('').split('\n\n').filter((x) => x.startsWith('data: ')).map((x) => JSON.parse(x.slice(6)));
    return out;
  });
  if (close) setTimeout(() => res.emit('close'), close);
  return p;
}

test('handleChat rejects viewer with 403', async () => {
  assert.strictEqual((await run({ admin: false, body: { message: 'ok' } })).status, 403);
});

test('handleChat rejects bad messages with 400', async () => {
  for (const m of ['', 123, 'x'.repeat(4001)]) assert.strictEqual((await run({ body: { message: m } })).status, 400);
});

test('handleChat rejects bad sessionId with 400', async () => {
  assert.strictEqual((await run({ body: { message: 'ok', sessionId: '--help' } })).status, 400);
});

test('handleChat streams text, session id, done; env and argv are safe', async () => {
  const r = await run({ body: { message: 'ok' } });
  assert.strictEqual(r.status, 200);
  const t = JSON.parse(r.events.find((e) => e.text).text);
  assert.strictEqual(t.msg, 'ok');
  assert.ok(t.argv.includes('--allowedTools'));
  for (const k of t.env) assert.ok(['PATH', 'HOME', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(k), k);
  assert.ok(r.events.some((e) => e.sessionId === 'S'));
  assert.ok(r.events.some((e) => e.done));
});

test('handleChat non-zero exit without result sends error then done', async () => {
  const r = await run({ body: { message: 'fail' } });
  assert.ok(r.events.some((e) => e.error));
  assert.ok(r.events.some((e) => e.done));
});

test('handleChat client disconnect kills child and frees lock', async () => {
  const user = 'dc';
  await run({ user, body: { message: 'sleep' }, close: 600 });
  const pid = Number(fs.readFileSync(path.join(tmp, 'sb', user, 'pid'), 'utf8'));
  await new Promise((r) => setTimeout(r, 100));
  assert.throws(() => process.kill(pid, 0));
  assert.strictEqual((await run({ user, body: { message: 'ok' } })).status, 200);
});

test('handleChat timeout sends error', async () => {
  const r = await run({ body: { message: 'sleep' }, timeoutMs: 700 });
  assert.ok(r.events.some((e) => e.error));
});

// ---- model selection ----
test('chatModels defaults and respects CHAT_MODELS', () => {
  delete process.env.CHAT_MODELS;
  assert.deepStrictEqual(chat.chatModels(), { models: ['haiku', 'sonnet', 'opus'], default: 'sonnet' });
  process.env.CHAT_MODELS = 'haiku, bad model!,opus';
  assert.deepStrictEqual(chat.chatModels(), { models: ['haiku', 'opus'], default: 'haiku' });
  delete process.env.CHAT_MODELS;
});

test('buildClaudeArgs adds --model only for an allowed model', () => {
  const a = buildClaudeArgs({ model: 'haiku' });
  assert.strictEqual(a[a.indexOf('--model') + 1], 'haiku');
  assert.ok(!buildClaudeArgs({}).includes('--model'));
  for (const m of ['--help', 'gpt-4', 'haiku,opus']) assert.throws(() => buildClaudeArgs({ model: m }), /bad model/);
});

test('handleChat rejects unknown model with 400', async () => {
  assert.strictEqual((await run({ body: { message: 'ok', model: '--help' } })).status, 400);
});

test('handleChat passes the chosen model, default sonnet', async () => {
  const argvOf = async (body) => JSON.parse((await run({ body })).events.find((e) => e.text).text).argv;
  const a = await argvOf({ message: 'ok', model: 'haiku' });
  assert.strictEqual(a[a.indexOf('--model') + 1], 'haiku');
  const b = await argvOf({ message: 'ok' });
  assert.strictEqual(b[b.indexOf('--model') + 1], 'sonnet');
});
