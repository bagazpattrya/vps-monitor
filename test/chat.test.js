'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const chat = require('../chat.js');
const chats = require('../chats.js');
const { buildClaudeArgs, parseStreamLine, buildSandbox, scopeDirs, createLimiter } = chat;

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

test('buildSandbox makes a clean empty folder per user, no symlinks', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sbbase-'));
  const dir = buildSandbox(base, 'u');
  fs.writeFileSync(path.join(dir, 'old'), 'x');
  assert.strictEqual(buildSandbox(base, 'u'), dir);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('scopeDirs: admin gets only valid visible project dirs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdroot-'));
  for (const d of ['a', 'b', '.git', '_uploads']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'f'), 'x');
  assert.deepStrictEqual(scopeDirs({ superadmin: false, projects: ['a', 'f', '.git', '../x', '_uploads', 'nope'], root, extra: ['/tmp'] }), [path.join(root, 'a')]);
});

test('scopeDirs: superadmin gets the root plus existing absolute extra dirs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdroot-'));
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'sdextra-'));
  assert.deepStrictEqual(scopeDirs({ superadmin: true, projects: [], root, extra: [extra, '/does/not/exist', 'relative/path'] }), [root, extra]);
});

test('buildClaudeArgs puts one --add-dir with all dirs last', () => {
  const a = buildClaudeArgs({ model: 'haiku', sessionId: UUID, addDirs: ['/x/a', '/x/b'] });
  assert.deepStrictEqual(a.slice(-3), ['--add-dir', '/x/a', '/x/b']);
  assert.ok(!buildClaudeArgs({}).includes('--add-dir'));
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
  else if (msg === 'uuid') {
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } });
    line({ type: 'result', session_id: '123e4567-e89b-12d3-a456-426614174000', is_error: false });
  } else if (msg === 'again') {
    line({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(process.argv.slice(2)) }] } });
    line({ type: 'result', session_id: '123e4567-e89b-12d3-a456-426614174000', is_error: false });
  } else if (msg === 'partial') {
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'part' }] } });
    setTimeout(() => {}, 20000);
  } else if (msg.startsWith('img')) {
    line({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify({ msg, files: require('fs').readdirSync('_uploads') }) }] } });
    line({ type: 'result', session_id: 'S', is_error: false });
  }
  else if (msg === 'tool') {
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'ERROR', path: 'projA/laravel.log' } }] } });
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } });
    line({ type: 'result', session_id: 'S', is_error: false });
  }
  else if (msg === 'shell' || msg === 'shellwrite' || msg === 'badtoken') {
    const cfg = JSON.parse(process.argv[process.argv.indexOf('--mcp-config') + 1]).mcpServers.vpsmon;
    const body = JSON.stringify({ token: msg === 'badtoken' ? 'wrong' : cfg.env.VPSMON_APPROVAL_TOKEN, tool_name: msg === 'shellwrite' ? 'Write' : 'Bash', input: { command: 'tail -n 5 x.log', description: 'last lines' } });
    const u = new URL(cfg.env.VPSMON_APPROVAL_URL);
    const rq = require('http').request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST' }, (rs) => {
      let d = ''; rs.on('data', (c) => (d += c)).on('end', () => {
        line({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify({ status: rs.statusCode, decision: d ? JSON.parse(d) : null, argv: process.argv.slice(2) }) }] } });
        line({ type: 'result', session_id: 'S', is_error: false });
      });
    });
    rq.end(body);
  }
  else if (msg === 'sleep') { require('fs').writeFileSync('pid', String(process.pid)); setTimeout(() => {}, 20000); }
});
`, { mode: 0o755 });
process.env.CLAUDE_BIN = FAKE;
process.env.CHAT_DATA_DIR = path.join(tmp, 'chats');
process.env.CHAT_SANDBOX_DIR = path.join(tmp, 'sb');
process.env.SCAN_DIR = tmp;
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';

let n = 0;
function run({ admin = true, superadmin = false, projects = [], body, user, close, timeoutMs, onEvent } = {}) {
  if (timeoutMs) process.env.CHAT_TIMEOUT_MS = String(timeoutMs); else delete process.env.CHAT_TIMEOUT_MS;
  const req = new EventEmitter();
  const out = { status: 0, chunks: [], logs: [] };
  const res = Object.assign(new EventEmitter(), { writeHead(s) { out.status = s; }, write(c) { out.chunks.push(String(c)); if (onEvent && String(c).startsWith('data: ')) onEvent(JSON.parse(String(c).slice(6)), session); }, end(c) { if (c) out.chunks.push(String(c)); } });
  const session = { user: user || 'u' + (++n), admin, superadmin };
  const p = chat.handleChat({ req, res, session, body, projects, log: (...a) => out.logs.push(a) }).then(() => {
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

test('handleChat rejects unknown or malformed chatId with 404', async () => {
  for (const id of ['--help', '../../x', 'a'.repeat(24)]) assert.strictEqual((await run({ body: { message: 'ok', chatId: id } })).status, 404, id);
});

test('handleChat rejects bad images with 400 and creates no chat', async () => {
  const user = 'imgbad';
  for (const images of [['bm90IGFuIGltYWdl'], Array(5).fill('x'), 'x']) {
    assert.strictEqual((await run({ user, body: { message: 'ok', images } })).status, 400);
  }
  assert.deepStrictEqual(chats.listChats(user), []);
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

// ---- persistence and images ----
const PNG64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]).toString('base64');

test('handleChat saves the conversation and returns chatId first', async () => {
  const user = 'persist';
  const r = await run({ user, body: { message: 'ok', model: 'haiku' } });
  assert.ok(chats.isChatId(r.events[0].chatId));
  const c = chats.getChat(user, r.events[0].chatId);
  assert.strictEqual(c.model, 'haiku');
  assert.strictEqual(c.title, 'ok');
  assert.deepStrictEqual(c.messages.map((m) => m.role), ['user', 'assistant']);
  assert.strictEqual(c.messages[0].text, 'ok');
  assert.ok(c.messages[1].text.includes('"msg":"ok"'));
  assert.strictEqual(c.claudeSessionId, 'S');
});

test('handleChat keeps the user message and an error message when claude fails', async () => {
  const user = 'failsave';
  const r = await run({ user, body: { message: 'fail' } });
  const c = chats.getChat(user, r.events[0].chatId);
  assert.strictEqual(c.messages[0].text, 'fail');
  const last = c.messages[c.messages.length - 1];
  assert.strictEqual(last.error, true);
});

test('handleChat saves partial text when the client disconnects', async () => {
  const user = 'partial';
  const created = chats.createChat(user, { message: 'x', model: 'sonnet' });
  await run({ user, body: { message: 'partial', chatId: created.id }, close: 700 });
  const c = chats.getChat(user, created.id);
  assert.strictEqual(c.messages[c.messages.length - 1].text, 'part');
});

test('handleChat resumes with the stored session id only when it is a UUID', async () => {
  const user = 'resume';
  const first = await run({ user, body: { message: 'uuid' } });
  const id = first.events[0].chatId;
  const argvOf = async () => JSON.parse((await run({ user, body: { message: 'again', chatId: id } })).events.find((e) => e.text).text);
  const a = await argvOf();
  assert.strictEqual(a[a.indexOf('--resume') + 1], UUID);
  chats.updateChat(user, id, (c) => { c.claudeSessionId = '--help'; });
  assert.ok(!(await argvOf()).includes('--resume'));
});

test('handleChat stores images, copies them to _uploads and names them in the prompt', async () => {
  const user = 'withimg';
  const r = await run({ user, body: { message: 'img please', images: ['data:image/png;base64,' + PNG64] } });
  const t = JSON.parse(r.events.find((e) => e.text).text);
  assert.strictEqual(t.files.length, 1);
  assert.ok(t.msg.startsWith('img please'));
  assert.ok(t.msg.includes('_uploads/' + t.files[0]));
  const c = chats.getChat(user, r.events[0].chatId);
  assert.strictEqual(c.messages[0].text, 'img please');
  assert.strictEqual(c.messages[0].images.length, 1);
  assert.ok(fs.existsSync(path.join(chats.userDir(user), c.id, 'img', c.messages[0].images[0])));
});

test('handleChat does not recreate a chat deleted while it streams', async () => {
  const user = 'deleted';
  const created = chats.createChat(user, { message: 'x', model: 'sonnet' });
  const p = run({ user, body: { message: 'sleep', chatId: created.id }, timeoutMs: 800 });
  await new Promise((r) => setTimeout(r, 400));
  chats.deleteChat(user, created.id);
  await p;
  assert.strictEqual(chats.getChat(user, created.id), null);
  assert.ok(!fs.existsSync(path.join(chats.userDir(user), created.id + '.json')));
});

// ---- tool activity ----
test('parseStreamLine reports tool use with a short detail', () => {
  const tu = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  assert.deepStrictEqual(parseStreamLine(tu('Read', { file_path: 'projA/a.log' })), { tool: 'Read projA/a.log' });
  assert.deepStrictEqual(parseStreamLine(tu('Grep', { pattern: 'ERROR' })), { tool: 'Grep ERROR' });
  assert.deepStrictEqual(parseStreamLine(tu('Bash', { command: 'tail -n 50 x.log' })), { tool: 'Bash tail -n 50 x.log' });
  assert.deepStrictEqual(parseStreamLine(tu('Glob', {})), { tool: 'Glob' });
  assert.strictEqual(parseStreamLine(tu('Bash', { command: 'x'.repeat(500) })).tool.length, 100);
});

test('parseStreamLine returns text and tool together', () => {
  const l = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', name: 'Grep', input: { pattern: 'E' } }] } });
  assert.deepStrictEqual(parseStreamLine(l), { text: 'looking', tool: 'Grep E' });
});

test('handleChat streams tool events and does not save them', async () => {
  const user = 'toolev';
  const r = await run({ user, body: { message: 'tool' } });
  assert.ok(r.events.some((e) => e.tool === 'Grep ERROR'));
  const c = chats.getChat(user, r.events[0].chatId);
  assert.deepStrictEqual(c.messages.map((m) => m.text), ['tool', 'done']);
});

// ---- search scope in handleChat ----
test('handleChat gives a superadmin SCAN_DIR and extra dirs, an admin only visible projects', async () => {
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'extra-'));
  fs.mkdirSync(path.join(tmp, 'p1'), { recursive: true });
  process.env.CHAT_EXTRA_DIRS = extra + ',/does/not/exist';
  const dirsOf = async (opts) => { const a = JSON.parse((await run({ body: { message: 'ok' }, ...opts })).events.find((e) => e.text).text).argv; const i = a.indexOf('--add-dir'); return i < 0 ? [] : a.slice(i + 1); };
  assert.deepStrictEqual(await dirsOf({ superadmin: true }), [tmp, extra]);
  assert.deepStrictEqual(await dirsOf({ projects: ['p1', 'hidden-not-listed'] }), [path.join(tmp, 'p1')]);
  assert.deepStrictEqual(await dirsOf({ projects: [] }), []);
  delete process.env.CHAT_EXTRA_DIRS;
});

test('system prompt tells Claude how to search gitignored logs', () => {
  const a = buildClaudeArgs({});
  const prompt = a[a.indexOf('--append-system-prompt') + 1];
  assert.ok(prompt.includes('.gitignore'));
  assert.ok(prompt.includes('exact file path'));
});

// ---- commands with confirmation ----
const FAKE_BWRAP = path.join(tmp, 'fake-bwrap.js');
fs.writeFileSync(FAKE_BWRAP, `#!/usr/bin/env node
const { spawn } = require('child_process');
const a = process.argv.slice(2);
const i = a.indexOf('--');
spawn(a[i + 1], a.slice(i + 2), { stdio: 'inherit' }).on('exit', (c) => process.exit(c == null ? 1 : c));
`, { mode: 0o755 });

async function withShell(fn, { root = true, shell = '1', bwrap = FAKE_BWRAP } = {}) {
  const saved = { CHAT_SHELL: process.env.CHAT_SHELL, CHAT_BWRAP: process.env.CHAT_BWRAP, CHAT_USER: process.env.CHAT_USER };
  if (shell) process.env.CHAT_SHELL = shell; else delete process.env.CHAT_SHELL;
  process.env.CHAT_BWRAP = bwrap;
  process.env.CHAT_USER = os.userInfo().username;
  chat._test.setIsRoot(() => root);
  try { return await fn(); } finally {
    chat._test.setIsRoot(() => typeof process.getuid === 'function' && process.getuid() === 0);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    delete process.env.CHAT_APPROVAL_MS;
  }
}
const answer = (session, id, allow) => { const out = { status: 0 }; chat.handleConfirm({ res: { writeHead(s) { out.status = s; }, end() {} }, session, body: { id, allow } }); return out.status; };
const shellText = (r) => JSON.parse(r.events.find((e) => e.text).text);

test('shell: approve runs the command, argv has the MCP flags, decision is logged', () => withShell(async () => {
  const r = await run({ superadmin: true, user: 'sh1', body: { message: 'shell' }, onEvent: (ev, session) => { if (ev.confirm) assert.strictEqual(answer(session, ev.confirm.id, true), 200); } });
  const c = r.events.find((e) => e.confirm).confirm;
  assert.strictEqual(c.tool, 'Bash');
  assert.strictEqual(c.command, 'tail -n 5 x.log');
  const t = shellText(r);
  assert.strictEqual(t.decision.behavior, 'allow');
  assert.ok(t.argv.includes('--permission-prompt-tool') && t.argv.includes('--strict-mcp-config'));
  assert.strictEqual(t.argv[t.argv.indexOf('--permission-mode') + 1], 'default');
  assert.ok(!t.argv[t.argv.indexOf('--disallowedTools') + 1].split(',').includes('Bash'));
  assert.ok(t.argv[t.argv.indexOf('--disallowedTools') + 1].split(',').includes('Write'));
  assert.deepStrictEqual(r.logs.find((l) => l[1] === 'chat.run').slice(0, 4), ['sh1', 'chat.run', 'tail -n 5 x.log', 'approved']);
}));

test('shell: deny is passed to Claude and logged', () => withShell(async () => {
  const r = await run({ superadmin: true, user: 'sh2', body: { message: 'shell' }, onEvent: (ev, session) => { if (ev.confirm) answer(session, ev.confirm.id, false); } });
  assert.strictEqual(shellText(r).decision.behavior, 'deny');
  assert.strictEqual(r.logs.find((l) => l[1] === 'chat.run')[3], 'denied');
}));

test('shell: another user cannot answer; the owner still can', () => withShell(async () => {
  let intruder = 0;
  await run({ superadmin: true, user: 'sh3', body: { message: 'shell' }, onEvent: (ev, session) => {
    if (!ev.confirm) return;
    intruder = answer({ user: 'someone-else', superadmin: true }, ev.confirm.id, true);
    assert.strictEqual(answer({ user: 'sh3', admin: true, superadmin: false }, ev.confirm.id, true), 403);
    answer(session, ev.confirm.id, true);
  } });
  assert.strictEqual(intruder, 404);
}));

test('shell: only Bash can be approved; unknown token gets 403', () => withShell(async () => {
  const w = await run({ superadmin: true, user: 'sh4', body: { message: 'shellwrite' } });
  assert.ok(!w.events.some((e) => e.confirm));
  assert.strictEqual(shellText(w).decision.behavior, 'deny');
  const b = await run({ superadmin: true, user: 'sh5', body: { message: 'badtoken' } });
  assert.strictEqual(shellText(b).status, 403);
}));

test('shell: no answer means deny, and the run timeout does not fire while waiting', () => withShell(async () => {
  process.env.CHAT_APPROVAL_MS = '700';
  const r = await run({ superadmin: true, user: 'sh6', body: { message: 'shell' }, timeoutMs: 250 });
  assert.strictEqual(shellText(r).decision.behavior, 'deny');
  assert.ok(!r.events.some((e) => e.error), JSON.stringify(r.events));
}));

test('shell: client disconnect while a confirmation is pending frees everything', () => withShell(async () => {
  let id = '';
  await run({ superadmin: true, user: 'sh7', body: { message: 'shell' }, close: 400, onEvent: (ev) => { if (ev.confirm) id = ev.confirm.id; } });
  assert.ok(id);
  assert.strictEqual(answer({ user: 'sh7', superadmin: true }, id, true), 404);
  assert.strictEqual((await run({ user: 'sh7', body: { message: 'ok' } })).status, 200);
}));

test('shell stays off for admin, without CHAT_SHELL, without bwrap, or when not root', async () => {
  const argvOf = async (opts) => shellText(await run({ body: { message: 'ok' }, ...opts })).argv;
  const off = (a) => !a.includes('--mcp-config') && a[a.indexOf('--permission-mode') + 1] === 'dontAsk';
  await withShell(async () => assert.ok(off(await argvOf({ superadmin: false }))));
  await withShell(async () => assert.ok(off(await argvOf({ superadmin: true }))), { shell: '' });
  await withShell(async () => assert.ok(off(await argvOf({ superadmin: true }))), { bwrap: '/no/such/bwrap' });
  await withShell(async () => assert.ok(off(await argvOf({ superadmin: true }))), { root: false });
});

test('shellAvailable matches the same rule (used for the header badge)', async () => {
  await withShell(async () => {
    assert.strictEqual(chat.shellAvailable({ superadmin: true }), true);
    assert.strictEqual(chat.shellAvailable({ superadmin: false }), false);
  });
  assert.strictEqual(chat.shellAvailable({ superadmin: true }), false);
});

test('shell: claude is started through bwrap with a read-only root', () => withShell(async () => {
  const seen = path.join(tmp, 'bwrap-args.json');
  const spy = path.join(tmp, 'spy-bwrap.js');
  fs.writeFileSync(spy, `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)));
const { spawn } = require('child_process');
const a = process.argv.slice(2); const i = a.indexOf('--');
spawn(a[i + 1], a.slice(i + 2), { stdio: 'inherit' }).on('exit', (c) => process.exit(c == null ? 1 : c));
`, { mode: 0o755 });
  process.env.CHAT_BWRAP = spy;
  await run({ superadmin: true, user: 'sh8', body: { message: 'ok' } });
  const a = JSON.parse(fs.readFileSync(seen, 'utf8'));
  assert.deepStrictEqual(a.slice(0, 3), ['--ro-bind', '/', '/']);
  for (const f of ['--die-with-parent', '--unshare-pid', '--tmpfs']) assert.ok(a.includes(f), f);
  assert.strictEqual(a[a.indexOf('--') + 1], FAKE);
}));
