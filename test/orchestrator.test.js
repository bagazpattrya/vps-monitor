'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const orch = require('../orchestrator');

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };

// Server mini yang meniru pemasangan di server.js: worker (Bearer) dulu, lalu session admin.
async function boot(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-'));
  let clock = 1_000_000;
  const o = orch.create({ dataDir, workerToken: 'wrk', leaseSec: 10, dailyBudget: 5, now: () => clock, ...opts });
  const state = { superadmin: true };
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const ctx = { req, res, url, readBody, send, session: state.superadmin ? { user: 'admin', superadmin: true } : { user: 'v', superadmin: false } };
    if (await o.handleWorker(ctx)) return;
    if (await o.handleAdmin(ctx)) return;
    send(res, 404, '{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (m, p, tok, body) => fetch(base + p, { method: m, headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { call, state, dataDir, tick: (ms) => { clock += ms; }, close: () => srv.close(), reopen: () => orch.create({ dataDir, workerToken: 'wrk', now: () => clock }) };
}
const good = { project_key: 'lapila', context: 'ctx', goals: ['a'] };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');

test('validate menolak input buruk', () => {
  for (const bad of [null, {}, { ...good, project_key: '../x' }, { ...good, goals: [] }, { ...good, limits: { model: 'gpt' } }, { ...good, context: 'x'.repeat(4001) }]) {
    assert.ok(orch.validate(bad), JSON.stringify(bad));
  }
  assert.strictEqual(orch.validate(good), null);
});

test('worker route: tanpa/salah token -> 401, admin tidak boleh ambil WO, non-superadmin -> 403', async () => {
  const t = await boot();
  assert.strictEqual((await t.call('GET', '/api/wo/next')).status, 401);
  assert.strictEqual((await t.call('GET', '/api/wo/next', 'salah')).status, 401);
  t.state.superadmin = false;
  assert.strictEqual((await t.call('POST', '/api/wo', null, good)).status, 403);
  assert.strictEqual((await t.call('GET', '/api/wo')).status, 403);
  t.close();
});

test('tanpa ORCH_WORKER_TOKEN endpoint worker mati (503)', async () => {
  const t = await boot({ workerToken: '' });
  assert.strictEqual((await t.call('GET', '/api/wo/next', 'apa-saja')).status, 503);
  t.close();
});

test('alur penuh: buat -> next -> heartbeat -> complete(png) -> detail, data selamat restart', async () => {
  const t = await boot();
  const { wo } = await (await t.call('POST', '/api/wo', null, { ...good, limits: { max_budget_usd: 99 } })).json();
  assert.strictEqual(wo.status, 'PENDING');
  assert.strictEqual(wo.limits.max_budget_usd, 1); // di-clamp

  const next = await (await t.call('GET', '/api/wo/next', 'wrk')).json();
  assert.strictEqual(next.wo.id, wo.id);
  assert.strictEqual((await (await t.call('GET', '/api/wo/next', 'wrk')).json()).wo, null); // tidak diberikan dua kali
  assert.strictEqual((await t.call('POST', `/api/wo/${wo.id}/heartbeat`, 'wrk', {})).status, 200);

  const done = await t.call('POST', `/api/wo/${wo.id}/complete`, 'wrk', { status: 'COMPLETED', result: { cost_usd: 0.12, diff_stat: '1 file' }, screenshot_b64: PNG });
  const d = await done.json();
  assert.strictEqual(d.wo.status, 'COMPLETED');
  assert.strictEqual(d.wo.cost_usd, 0.12);
  const shot = await t.call('GET', d.wo.screenshot_url);
  assert.strictEqual(shot.status, 200);
  assert.strictEqual((await t.call('POST', `/api/wo/${wo.id}/complete`, 'wrk', { status: 'FAILED' })).status, 409); // sudah final

  const list = await (await t.call('GET', '/api/wo')).json();
  assert.strictEqual(list.cost_today_usd, 0.12);
  assert.strictEqual(t.reopen().isWorkerRoute('/api/wo/next', 'GET'), true);
  assert.ok(JSON.parse(fs.readFileSync(path.join(t.dataDir, 'work-orders.json'), 'utf8')).some((w) => w.id === wo.id));
  t.close();
});

test('screenshot bukan PNG tidak disimpan; status ngawur ditolak', async () => {
  const t = await boot();
  const { wo } = await (await t.call('POST', '/api/wo', null, good)).json();
  await t.call('GET', '/api/wo/next', 'wrk');
  assert.strictEqual((await t.call('POST', `/api/wo/${wo.id}/complete`, 'wrk', { status: 'PWNED' })).status, 400);
  const d = await (await t.call('POST', `/api/wo/${wo.id}/complete`, 'wrk', { status: 'FAILED', screenshot_b64: Buffer.from('<script>').toString('base64') })).json();
  assert.strictEqual(d.wo.screenshot_url, null);
  t.close();
});

test('path traversal pada screenshot ditolak', async () => {
  const t = await boot();
  assert.strictEqual((await t.call('GET', '/api/wo/shot/..%2Fwork-orders.json')).status, 404);
  assert.strictEqual((await t.call('GET', '/api/wo/shot/abc.png')).status, 404);
  t.close();
});

test('lease habis: kembali PENDING, lalu FAILED setelah 2 kali', async () => {
  const t = await boot();
  const { wo } = await (await t.call('POST', '/api/wo', null, good)).json();
  await t.call('GET', '/api/wo/next', 'wrk'); // lalu "worker mati"
  t.tick(11_000);
  const again = await (await t.call('GET', '/api/wo/next', 'wrk')).json();
  assert.strictEqual(again.wo.id, wo.id);
  assert.strictEqual(again.wo.attempts, 1);
  t.tick(11_000);
  await t.call('GET', '/api/wo/next', 'wrk'); // memicu reklaim -> FAILED
  assert.strictEqual((await (await t.call('GET', `/api/wo/${wo.id}`)).json()).wo.status, 'FAILED');
  t.close();
});

test('budget harian habis -> 429', async () => {
  const t = await boot({ dailyBudget: 0.1 });
  const { wo } = await (await t.call('POST', '/api/wo', null, good)).json();
  await t.call('GET', '/api/wo/next', 'wrk');
  await t.call('POST', `/api/wo/${wo.id}/complete`, 'wrk', { status: 'COMPLETED', result: { cost_usd: 0.2 } });
  assert.strictEqual((await t.call('POST', '/api/wo', null, good)).status, 429);
  t.close();
});
