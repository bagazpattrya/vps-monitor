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
  const state = { admin: true };
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const ctx = { req, res, url, readBody, send, session: state.admin ? { user: 'admin', admin: true } : { user: 'v', admin: false } };
    if (await o.handleWorker(ctx)) return;
    if (await o.handleAdmin(ctx)) return;
    send(res, 404, '{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  if (opts.projects !== false) { // worker mendaftarkan project-nya
    await fetch(base + '/api/wo/projects', { method: 'POST', headers: { Authorization: 'Bearer wrk', 'Content-Type': 'application/json' }, body: JSON.stringify({ projects: [{ key: 'lapila', target: 'development' }, { key: 'demo', target: null }] }) });
  }
  const call = (m, p, tok, body) => fetch(base + p, { method: m, headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { call, state, dataDir, tick: (ms) => { clock += ms; }, close: () => srv.close(), reopen: () => orch.create({ dataDir, workerToken: 'wrk', now: () => clock }) };
}
const good = { project_key: 'lapila', context: 'ctx', goals: ['a'] };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');

test('goals opsional', () => {
  assert.strictEqual(orch.validate({ project_key: 'lapila', context: 'ctx' }), null);
  assert.strictEqual(orch.validate({ project_key: 'lapila', context: 'ctx', goals: [] }), null);
});

test('validate menolak input buruk', () => {
  for (const bad of [null, {}, { ...good, project_key: '../x' }, { ...good, goals: Array(11).fill('a') }, { ...good, limits: { model: 'gpt' } }, { ...good, context: 'x'.repeat(4001) }]) {
    assert.ok(orch.validate(bad), JSON.stringify(bad));
  }
  assert.strictEqual(orch.validate(good), null);
});

test('worker route: tanpa/salah token -> 401, admin tidak boleh ambil WO, viewer -> 403', async () => {
  const t = await boot();
  assert.strictEqual((await t.call('GET', '/api/wo/next')).status, 401);
  assert.strictEqual((await t.call('GET', '/api/wo/next', 'salah')).status, 401);
  t.state.admin = false;
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

test('flag complexity: simple|complex disimpan, nilai lain dibuang', async () => {
  const t = await boot();
  const done = async (result) => {
    const { wo } = await (await t.call('POST', '/api/wo', null, good)).json();
    await t.call('GET', '/api/wo/next', 'wrk');
    return (await (await t.call('POST', `/api/wo/${wo.id}/complete`, 'wrk', { status: 'COMPLETED', result })).json()).wo.result;
  };
  const r1 = await done({ complexity: 'complex', complexity_reason: 'ubah skema DB' });
  assert.strictEqual(r1.complexity, 'complex');
  assert.strictEqual(r1.complexity_reason, 'ubah skema DB');
  const r2 = await done({ complexity: 'huge', complexity_reason: 5 });
  assert.strictEqual(r2.complexity, undefined);
  assert.strictEqual(r2.complexity_reason, undefined);
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

// ---- approve / reject / merge ----
const SHA = 'a'.repeat(40);
async function finished(t, result = { branch: 'wo/x-0', head_sha: SHA, patch: '+a\n-b' }, status = 'COMPLETED') {
  const { wo } = await (await t.call('POST', '/api/wo', null, good)).json();
  await t.call('GET', '/api/wo/next', 'wrk');
  await t.call('POST', `/api/wo/${wo.id}/complete`, 'wrk', { status, result });
  return wo.id;
}

test('approve -> worker dapat job merge -> merge-result MERGED', async () => {
  const t = await boot();
  const id = await finished(t);
  const a = await (await t.call('POST', `/api/wo/${id}/approve`, null, { note: 'ok' })).json();
  assert.strictEqual(a.wo.status, 'APPROVED');
  assert.strictEqual(a.wo.approved_by, 'admin');
  assert.strictEqual((await t.call('POST', `/api/wo/${id}/approve`, null, {})).status, 409); // klik ganda

  const next = await (await t.call('GET', '/api/wo/next', 'wrk')).json();
  assert.strictEqual(next.kind, 'merge');
  assert.strictEqual(next.wo.id, id);
  assert.strictEqual(next.wo.status, 'MERGING');
  assert.strictEqual(next.wo.result.head_sha, SHA);
  assert.strictEqual((await t.call('POST', `/api/wo/${id}/heartbeat`, 'wrk', {})).status, 200);

  assert.strictEqual((await t.call('POST', `/api/wo/${id}/merge-result`, 'wrk', { status: 'COMPLETED' })).status, 400);
  const m = await (await t.call('POST', `/api/wo/${id}/merge-result`, 'wrk', { status: 'MERGED', detail: 'ok', sha: 'b'.repeat(40), target: 'development' })).json();
  assert.strictEqual(m.wo.status, 'MERGED');
  assert.strictEqual(m.wo.merge.target, 'development');
  assert.strictEqual((await t.call('POST', `/api/wo/${id}/merge-result`, 'wrk', { status: 'MERGED' })).status, 409);
  t.close();
});

test('approve ditolak: tanpa head_sha/branch valid, status salah, atau bukan admin', async () => {
  const t = await boot();
  const noSha = await finished(t, { branch: 'wo/x-0' });
  assert.strictEqual((await t.call('POST', `/api/wo/${noSha}/approve`, null, {})).status, 409);
  const badBranch = await finished(t, { branch: 'main', head_sha: SHA }); // branch di luar wo/* dibuang
  assert.strictEqual((await t.call('POST', `/api/wo/${badBranch}/approve`, null, {})).status, 409);
  const failed = await finished(t, { branch: 'wo/x-0', head_sha: SHA }, 'FAILED');
  assert.strictEqual((await t.call('POST', `/api/wo/${failed}/approve`, null, {})).status, 409);
  const ok = await finished(t);
  t.state.admin = false;
  assert.strictEqual((await t.call('POST', `/api/wo/${ok}/approve`, null, {})).status, 403);
  t.close();
});

test('reject lalu approve -> 409; patch besar dipotong', async () => {
  const t = await boot();
  const id = await finished(t, { branch: 'wo/x-0', head_sha: SHA, patch: 'x'.repeat(300 * 1024) });
  const d = await (await t.call('GET', `/api/wo/${id}`)).json();
  assert.strictEqual(d.wo.result.patch.length, 200 * 1024);
  assert.strictEqual(d.wo.result.patch_truncated, true);
  assert.strictEqual((await (await t.call('POST', `/api/wo/${id}/reject`, null, { note: 'jelek' })).json()).wo.status, 'REJECTED');
  assert.strictEqual((await t.call('POST', `/api/wo/${id}/approve`, null, {})).status, 409);
  t.close();
});

test('merge job: lease habis -> APPROVED lagi, lalu MERGE_FAILED setelah 2 kali, boleh approve ulang', async () => {
  const t = await boot();
  const id = await finished(t);
  await t.call('POST', `/api/wo/${id}/approve`, null, {});
  await t.call('GET', '/api/wo/next', 'wrk'); // worker ambil lalu mati
  t.tick(11_000);
  assert.strictEqual((await (await t.call('GET', '/api/wo/next', 'wrk')).json()).kind, 'merge');
  t.tick(11_000);
  await t.call('GET', '/api/wo/next', 'wrk');
  const d = await (await t.call('GET', `/api/wo/${id}`)).json();
  assert.strictEqual(d.wo.status, 'MERGE_FAILED');
  assert.strictEqual((await t.call('POST', `/api/wo/${id}/approve`, null, {})).status, 200);
  t.close();
});

// ---- registry project ----
test('WO ke project yang tidak terdaftar ditolak; daftar tampil di GET /api/wo', async () => {
  const t = await boot();
  const bad = await t.call('POST', '/api/wo', null, { ...good, project_key: 'lain' });
  assert.strictEqual(bad.status, 400);
  assert.match((await bad.json()).error, /lapila, demo/);
  const list = await (await t.call('GET', '/api/wo')).json();
  assert.deepStrictEqual(list.projects, [{ key: 'lapila', target: 'development' }, { key: 'demo', target: null }]);
  assert.ok(list.projects_updated_at);
  t.close();
});

test('tanpa project terdaftar -> 400; registrasi harus Bearer worker dan valid', async () => {
  const t = await boot({ projects: false });
  assert.strictEqual((await t.call('POST', '/api/wo', null, good)).status, 400);
  assert.strictEqual((await t.call('POST', '/api/wo/projects', 'salah', { projects: [] })).status, 401);
  for (const bad of [{}, { projects: [{ key: '../x' }] }, { projects: [{ key: 'a', target: '-rf' }] }, { projects: [{ key: 'a' }, { key: 'a' }] }]) {
    assert.strictEqual((await t.call('POST', '/api/wo/projects', 'wrk', bad)).status, 400, JSON.stringify(bad));
  }
  assert.strictEqual((await t.call('POST', '/api/wo/projects', 'wrk', { projects: [{ key: 'lapila' }] })).status, 200);
  assert.strictEqual((await t.call('POST', '/api/wo', null, good)).status, 201);
  t.close();
});

test('registry selamat restart', async () => {
  const t = await boot();
  const again = orch.create({ dataDir: t.dataDir, workerToken: 'wrk' });
  const o = { req: { method: 'GET', headers: {} }, url: new URL('http://x/api/wo'), session: { admin: true }, send: (res, c, b) => { o.out = JSON.parse(b); } , res: {} };
  await again.handleAdmin(o);
  assert.strictEqual(o.out.projects.length, 2);
  t.close();
});

test('lampiran gambar: simpan, unduh (admin & worker), tolak non-gambar, nama jahat', async () => {
  const t = await boot();
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
  assert.strictEqual((await t.call('POST', '/api/wo', null, { ...good, images: ['data:image/png;base64,' + Buffer.from('bukan gambar').toString('base64')] })).status, 400);
  assert.strictEqual((await t.call('POST', '/api/wo', null, { ...good, images: [png, png, png, png, png] })).status, 400);
  const r = await t.call('POST', '/api/wo', null, { ...good, images: [png] });
  assert.strictEqual(r.status, 201);
  const { wo } = await r.json();
  assert.strictEqual(wo.images.length, 1);
  const u = `/api/wo/${wo.id}/img/${wo.images[0]}`;
  const a = await t.call('GET', u);
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.headers.get('content-type'), 'image/png');
  assert.strictEqual(a.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await t.call('GET', u, 'wrk')).status, 200);
  assert.strictEqual((await t.call('GET', u, 'salah')).status, 401);
  assert.strictEqual((await t.call('GET', `/api/wo/${wo.id}/img/0000000000000000.png`)).status, 404);
  assert.strictEqual((await t.call('GET', `/api/wo/${wo.id}/img/..%2Fx.png`)).status, 404);
  t.close();
});

test('db-dump: hanya Bearer worker + allowlist; gagal dump memutus koneksi', async () => {
  const ok = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dump-')), 'fake.sh');
  fs.writeFileSync(ok, '#!/bin/sh\nfor a; do last=$a; done\n[ "$last" = broken ] && { echo oops >&2; exit 2; }\necho "-- dump $last"\n', { mode: 0o755 });
  const t = await boot({ dumpDbs: ['good', 'broken'], dumpBin: ok });
  assert.strictEqual((await t.call('GET', '/api/wo/db-dump?db=good')).status, 401); // tanpa Bearer: ditolak, sesi admin tidak cukup
  assert.strictEqual((await t.call('GET', '/api/wo/db-dump?db=good', 'salah')).status, 401);
  assert.strictEqual((await t.call('GET', '/api/wo/db-dump?db=other', 'wrk')).status, 404);
  assert.strictEqual((await t.call('GET', '/api/wo/db-dump?db=a;b', 'wrk')).status, 404);
  const r = await t.call('GET', '/api/wo/db-dump?db=good', 'wrk');
  assert.strictEqual(r.status, 200);
  assert.match(require('zlib').gunzipSync(Buffer.from(await r.arrayBuffer())).toString(), /-- dump good/);
  const b = await t.call('GET', '/api/wo/db-dump?db=broken', 'wrk');
  assert.strictEqual(b.status, 500);
  t.close();
});

test('db_source: default dari registry, pilihan valid, tolak di luar daftar', async () => {
  const t = await boot();
  const reg = (projects) => t.call('POST', '/api/wo/projects', 'wrk', { projects });
  assert.strictEqual((await reg([{ key: 'lapila', db_sources: ['a_db', 'b_db'], db_default: 'zzz' }])).status, 400); // default harus ada di sources
  assert.strictEqual((await reg([{ key: 'lapila', db_sources: ['a;drop'] }])).status, 400);
  assert.strictEqual((await reg([{ key: 'lapila', target: 'development', db_sources: ['a_db', 'b_db'], db_default: 'b_db' }, { key: 'demo' }])).status, 200);
  const mk = async (b) => t.call('POST', '/api/wo', null, { ...good, ...b });
  assert.strictEqual((await (await mk({})).json()).wo.db_source, 'b_db'); // tanpa pilihan: default
  assert.strictEqual((await (await mk({ db_source: 'a_db' })).json()).wo.db_source, 'a_db');
  assert.strictEqual((await mk({ db_source: 'c_db' })).status, 400);
  assert.strictEqual((await mk({ project_key: 'demo', db_source: 'a_db' })).status, 400); // project tanpa sumber DB
  assert.strictEqual((await (await mk({ project_key: 'demo' })).json()).wo.db_source, undefined);
  t.close();
});
