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
  return { o, call, state, dataDir, tick: (ms) => { clock += ms; }, close: () => srv.close(), reopen: () => orch.create({ dataDir, workerToken: 'wrk', now: () => clock }) };
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
  assert.strictEqual(wo.limits.max_budget_usd, 3); // di-clamp

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
  assert.deepStrictEqual(list.projects, [{ key: 'lapila', target: 'development', db_sources: [], db_default: null }, { key: 'demo', target: null, db_sources: [], db_default: null }]);
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

test('db_sync: info sync terakhir dari worker, pilihan sync per WO', async () => {
  const t = await boot();
  const reg = (projects) => t.call('POST', '/api/wo/projects', 'wrk', { projects });
  assert.strictEqual((await reg([{ key: 'lapila', db_sync_info: { ttl_hours: 6, last: { 'a;b': 1 } } }])).status, 400);
  assert.strictEqual((await reg([{ key: 'lapila', db_sync_info: { ttl_hours: 'x', last: {} } }])).status, 400);
  assert.strictEqual((await reg([{ key: 'lapila', db_sources: ['a_db'], db_sync_info: { ttl_hours: 6, last: { a_db: 1700000000000 } } }])).status, 200);
  const list = await (await t.call('GET', '/api/wo')).json();
  assert.deepStrictEqual(list.projects[0].db_sync_info, { ttl_hours: 6, last: { a_db: 1700000000000 } });
  const mk = async (b) => t.call('POST', '/api/wo', null, { ...good, ...b });
  assert.strictEqual((await (await mk({ db_sync: false })).json()).wo.db_sync, false);
  assert.strictEqual((await (await mk({ db_sync: true })).json()).wo.db_sync, true);
  assert.strictEqual((await (await mk({})).json()).wo.db_sync, undefined);
  assert.strictEqual((await mk({ db_sync: 'ya' })).status, 400);
  t.close();
});

test('links: simpan daftar repo, dedupe, hapus, tolak url/repo buruk, viewer 403', async () => {
  const t = await boot();
  const L = { project_key: 'lapila', repos: [{ repo: 'hr-kti', url: 'https://kti.test' }, { repo: 'hr-oso', url: '' }, { repo: 'hr-kti', url: 'https://dup.test' }] };
  assert.strictEqual((await t.call('POST', '/api/wo/links', null, L)).status, 200);
  const got = (await (await t.call('GET', '/api/wo/links')).json()).links.lapila;
  assert.deepStrictEqual(got.repos, [{ repo: 'hr-kti', url: 'https://kti.test' }, { repo: 'hr-oso', url: '' }]);
  assert.strictEqual((await (await t.call('GET', '/api/wo')).json()).links.lapila.repos.length, 2);
  const R = (r) => ({ project_key: 'lapila', repos: [r] });
  for (const bad of [R({ repo: 'a', url: 'javascript:alert(1)' }), R({ repo: '../etc' }), R({ repo: '/abs' }), R({ repo: '' }), { ...L, project_key: '../x' }, { ...L, project_key: 'tidakada' }, { project_key: 'lapila', repos: 'x' }, { project_key: 'lapila', repos: Array(51).fill({ repo: 'a' }) }]) {
    assert.strictEqual((await t.call('POST', '/api/wo/links', null, bad)).status, 400, JSON.stringify(bad));
  }
  assert.strictEqual((await t.call('POST', '/api/wo/links', null, { project_key: 'lapila', repos: [] })).status, 200);
  assert.strictEqual((await (await t.call('GET', '/api/wo/links')).json()).links.lapila, undefined);
  t.state.admin = false;
  assert.strictEqual((await t.call('POST', '/api/wo/links', null, L)).status, 403);
  assert.strictEqual((await t.call('POST', '/api/wo/delete', null, { ids: [] })).status, 403);
  t.close();
});

test('links: file lama {repo,url} dibaca sebagai daftar', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-'));
  fs.writeFileSync(path.join(dataDir, 'wo-links.json'), JSON.stringify({ lapila: { repo: 'apps/x', url: 'https://x.test' } }));
  const o = orch.create({ dataDir, workerToken: 'wrk' });
  let out;
  await o.handleAdmin({ req: { method: 'GET', headers: {} }, url: new URL('http://x/api/wo/links'), session: { user: 'a', admin: true }, send: (r, c, b) => { out = JSON.parse(b); }, readBody });
  assert.deepStrictEqual(out.links.lapila.repos, [{ repo: 'apps/x', url: 'https://x.test' }]);
});

test('delete: hanya MERGED/REJECTED/FAILED/OVER_BUDGET; sisanya skipped', async () => {
  const t = await boot();
  const reviewable = await finished(t);
  const merged = await finished(t);
  await t.call('POST', `/api/wo/${merged}/approve`, null, {});
  await t.call('GET', '/api/wo/next', 'wrk');
  await t.call('POST', `/api/wo/${merged}/merge-result`, 'wrk', { status: 'MERGED' });
  const pending = (await (await t.call('POST', '/api/wo', null, good)).json()).wo.id;
  const r = await (await t.call('POST', '/api/wo/delete', null, { ids: [pending, reviewable, merged, 'WO-nope'] })).json();
  assert.deepStrictEqual(r.deleted, [merged]);
  assert.deepStrictEqual(r.skipped.map((s) => s.id).sort(), [pending, reviewable, 'WO-nope'].sort());
  const ids = (await (await t.call('GET', '/api/wo')).json()).work_orders.map((w) => w.id);
  assert.ok(!ids.includes(merged) && ids.includes(pending) && ids.includes(reviewable));
  assert.strictEqual((await t.call('POST', '/api/wo/delete', null, { ids: 'x' })).status, 400);
  assert.strictEqual((await t.call('POST', '/api/wo/delete', null, { ids: Array(201).fill('a') })).status, 400);
  t.close();
});

// ---- cleanup branch setelah reject ----
const nextC = async (t, q = '?cleanup=1') => (await t.call('GET', '/api/wo/next' + q, 'wrk')).json();

test('reject -> job cleanup hanya untuk worker yang minta (?cleanup=1); lapor DONE', async () => {
  const t = await boot();
  const id = await finished(t);
  const rj = await (await t.call('POST', `/api/wo/${id}/reject`, null, {})).json();
  assert.strictEqual(rj.wo.cleanup.state, 'PENDING');
  assert.strictEqual((await nextC(t, '')).wo, null, 'worker lama tidak dapat job cleanup');
  const c = await nextC(t);
  assert.strictEqual(c.kind, 'cleanup');
  assert.strictEqual(c.wo.id, id);
  assert.strictEqual(c.wo.result.branch, 'wo/x-0');
  assert.strictEqual((await nextC(t)).wo, null, 'sedang RUNNING: tidak dibagikan ulang');
  assert.strictEqual((await t.call('POST', `/api/wo/${id}/cleanup-result`, 'wrk', { status: 'MERGED' })).status, 400);
  const d = await (await t.call('POST', `/api/wo/${id}/cleanup-result`, 'wrk', { status: 'DONE', detail: 'branch dihapus' })).json();
  assert.strictEqual(d.wo.cleanup.state, 'DONE');
  assert.strictEqual(d.wo.status, 'REJECTED');
  assert.strictEqual((await t.call('POST', `/api/wo/${id}/cleanup-result`, 'wrk', { status: 'DONE' })).status, 409);
  t.close();
});

test('cleanup: approve atau reject tanpa branch tidak membuat job; viewer tidak bisa lapor', async () => {
  const t = await boot();
  const nob = await finished(t, { cost_usd: 0 }); // tanpa branch/head_sha
  assert.strictEqual((await (await t.call('POST', `/api/wo/${nob}/reject`, null, {})).json()).wo.cleanup, null);
  const ok = await finished(t);
  await t.call('POST', `/api/wo/${ok}/approve`, null, {});
  assert.strictEqual((await nextC(t)).kind, 'merge'); // approve: hanya job merge
  assert.strictEqual((await nextC(t)).wo, null);
  assert.strictEqual((await t.call('POST', `/api/wo/${ok}/cleanup-result`, null, { status: 'DONE' })).status, 401); // tanpa Bearer
  t.close();
});

test('cleanup: lease habis -> PENDING lagi, 2 kali -> FAILED; WO menunggu cleanup tidak bisa dihapus', async () => {
  const t = await boot();
  const id = await finished(t);
  await t.call('POST', `/api/wo/${id}/reject`, null, {});
  let r = await (await t.call('POST', '/api/wo/delete', null, { ids: [id] })).json();
  assert.deepStrictEqual(r.deleted, []);
  assert.match(r.skipped[0].reason, /cleanup/);
  assert.strictEqual((await nextC(t)).kind, 'cleanup');
  t.tick(11_000);
  assert.strictEqual((await nextC(t)).kind, 'cleanup', 'lease habis -> dibagikan lagi');
  t.tick(11_000);
  assert.strictEqual((await nextC(t)).wo, null);
  assert.strictEqual((await (await t.call('GET', `/api/wo/${id}`)).json()).wo.cleanup.state, 'FAILED');
  r = await (await t.call('POST', '/api/wo/delete', null, { ids: [id] })).json();
  assert.deepStrictEqual(r.deleted, [id]); // FAILED cleanup tidak menahan hapus
  t.close();
});

test('MERGED memicu onMerged dengan folder ter-link, hasil tersimpan di autopull', async () => {
  const calls = [];
  const t = await boot({ onMerged: async (repos, scope) => { calls.push([repos, scope]); return [{ repo: repos[0], ok: true, detail: 'ok' }]; } });
  await t.call('POST', '/api/wo/links', null, { project_key: 'lapila', repos: [{ repo: 'lapila-dev', url: '' }] });
  const id = await finished(t);
  assert.strictEqual((await t.call('POST', `/api/wo/${id}/approve`, null, { pull: 'prod' })).status, 400);
  await t.call('POST', `/api/wo/${id}/approve`, null, { pull: 'all' });
  await t.call('GET', '/api/wo/next', 'wrk');
  const m = await (await t.call('POST', `/api/wo/${id}/merge-result`, 'wrk', { status: 'MERGED' })).json();
  assert.strictEqual(m.wo.autopull.state, 'RUNNING');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(calls, [[['lapila-dev'], 'all']]);
  const d = await (await t.call('GET', '/api/wo')).json();
  const w = d.work_orders.find((x) => x.id === id);
  assert.strictEqual(w.autopull.state, 'DONE');
  assert.strictEqual(w.autopull.results[0].ok, true);
  t.close();
});

test('deploy manual dari modal: /pulled menimpa hasil autopull per folder ter-link', async () => {
  const t = await boot({ onMerged: async (repos) => repos.map((repo) => ({ repo, ok: false, detail: 'dilewati: ada perubahan lokal' })) });
  await t.call('POST', '/api/wo/links', null, { project_key: 'lapila', repos: [{ repo: 'lapila-dev', url: '' }, { repo: 'lapila-prod', url: '' }] });
  const id = await finished(t);
  assert.strictEqual((await t.call('POST', `/api/wo/${id}/pulled`, null, { results: [{ repo: 'lapila-dev', ok: true }] })).status, 409); // belum MERGED
  await t.call('POST', `/api/wo/${id}/approve`, null, { pull: 'all' });
  await t.call('GET', '/api/wo/next', 'wrk');
  await t.call('POST', `/api/wo/${id}/merge-result`, 'wrk', { status: 'MERGED' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual((await t.call('POST', `/api/wo/${id}/pulled`, null, { results: [{ repo: 'other', ok: true }] })).status, 400);
  const w = (await (await t.call('POST', `/api/wo/${id}/pulled`, null, { results: [{ repo: 'lapila-dev', ok: true, detail: 'ok' }] })).json()).wo;
  assert.deepStrictEqual(w.autopull.results.map((r) => [r.repo, r.ok]).sort(), [['lapila-dev', true], ['lapila-prod', false]]);
  t.close();
});

test('priority: default highest, worker ambil prioritas tertinggi dulu (seri FIFO), bisa diubah selama antre', async () => {
  const t = await boot();
  assert.ok(orch.validate({ ...good, priority: 'urgent' }));
  assert.strictEqual(orch.validate({ ...good, external_ref: "BUG-123" }), null);
  assert.ok(orch.validate({ ...good, external_ref: "x".repeat(101) }));
  assert.strictEqual((await t.call('POST', '/api/wo', null, { ...good, priority: 'urgent' })).status, 400);
  const mk = async (priority) => (await (await t.call('POST', '/api/wo', null, priority ? { ...good, priority } : good)).json()).wo;
  const low = await mk('low');
  const med1 = await mk('medium');
  const med2 = await mk('medium');
  const def = await mk();
  assert.strictEqual(def.priority, 'highest');

  // naikkan low -> high: sekarang di depan medium, di belakang highest
  assert.strictEqual((await t.call('POST', `/api/wo/${low.id}/priority`, null, { priority: 'nope' })).status, 400);
  const up = await (await t.call('POST', `/api/wo/${low.id}/priority`, null, { priority: 'high' })).json();
  assert.strictEqual(up.wo.priority, 'high');

  const order = [];
  for (let i = 0; i < 4; i++) order.push((await (await t.call('GET', '/api/wo/next', 'wrk')).json()).wo.id);
  assert.deepStrictEqual(order, [def.id, low.id, med1.id, med2.id]);

  // sudah diambil worker: tidak bisa diubah; viewer: 403
  assert.strictEqual((await t.call('POST', `/api/wo/${def.id}/priority`, null, { priority: 'low' })).status, 409);
  t.state.admin = false;
  assert.strictEqual((await t.call('POST', `/api/wo/${low.id}/priority`, null, { priority: 'low' })).status, 403);
  t.close();
});

// ---- revisi di branch yang sama ----
test('revisi: reject -> revise -> worker dapat branch lama + catatan -> complete -> approve', async () => {
  const t = await boot();
  const id = await finished(t, { branch: 'wo/x-0', head_sha: SHA, base_sha: 'c'.repeat(40), patch: '+a', cost_usd: 0.2 });
  await t.call('POST', `/api/wo/${id}/reject`, null, {});
  assert.strictEqual((await t.call('POST', `/api/wo/${id}/revise`, null, {})).status, 400, 'note wajib');
  const rv = await (await t.call('POST', `/api/wo/${id}/revise`, null, { note: 'tombol kurang besar' })).json();
  assert.strictEqual(rv.wo.status, 'PENDING');
  assert.strictEqual(rv.wo.cleanup, null, 'cleanup PENDING dibatalkan: branch dipakai lagi');
  assert.deepStrictEqual(rv.wo.revision, { n: 1, branch: 'wo/x-0', head_sha: SHA, base_sha: 'c'.repeat(40) });
  assert.strictEqual(rv.wo.revisions[0].note, 'tombol kurang besar');
  assert.strictEqual(rv.wo.revisions[0].from_status, 'REJECTED');

  const next = await (await t.call('GET', '/api/wo/next?cleanup=1', 'wrk')).json();
  assert.strictEqual(next.kind, 'run');
  assert.strictEqual(next.wo.revision.branch, 'wo/x-0');
  const SHA2 = 'd'.repeat(40);
  const c = await (await t.call('POST', `/api/wo/${id}/complete`, 'wrk', { status: 'COMPLETED', result: { branch: 'wo/x-0', head_sha: SHA2, base_sha: 'c'.repeat(40), cost_usd: 0.3 } })).json();
  assert.strictEqual(c.wo.status, 'COMPLETED');
  assert.ok(Math.abs(c.wo.cost_usd - 0.5) < 1e-9, 'biaya revisi ditambahkan');
  assert.strictEqual((await (await t.call('POST', `/api/wo/${id}/approve`, null, {})).json()).wo.status, 'APPROVED');
  const m = await (await t.call('GET', '/api/wo/next', 'wrk')).json();
  assert.strictEqual(m.kind, 'merge');
  assert.strictEqual(m.wo.result.head_sha, SHA2, 'merge memakai commit hasil revisi');
  t.close();
});

test('revisi: revisi gagal tetap bisa direvisi lagi dari branch revisi; ditolak jika branch sudah dihapus / status salah', async () => {
  const t = await boot();
  const id = await finished(t);
  assert.strictEqual((await t.call('POST', `/api/wo/${id}/revise`, null, { note: 'a' })).status, 200, 'langsung dari COMPLETED');
  await t.call('GET', '/api/wo/next', 'wrk');
  assert.strictEqual((await t.call('POST', `/api/wo/${id}/revise`, null, { note: 'b' })).status, 409, 'IN_PROGRESS');
  await t.call('POST', `/api/wo/${id}/complete`, 'wrk', { status: 'FAILED', result: { logs: 'x' } });
  const rv = await (await t.call('POST', `/api/wo/${id}/revise`, null, { note: 'c' })).json();
  assert.strictEqual(rv.wo.revision.head_sha, SHA);
  assert.strictEqual(rv.wo.revisions.length, 2);

  const nob = await finished(t, { logs: 'tanpa branch' }, 'FAILED');
  assert.strictEqual((await t.call('POST', `/api/wo/${nob}/revise`, null, { note: 'x' })).status, 409, 'tanpa branch');
  t.state.admin = false;
  assert.strictEqual((await t.call('POST', `/api/wo/${id}/revise`, null, { note: 'x' })).status, 403);
  t.close();
});

test('revisi: branch yang sudah dihapus worker tidak bisa direvisi', async () => {
  const t = await boot();
  const id = await finished(t);
  await t.call('POST', `/api/wo/${id}/reject`, null, {});
  assert.strictEqual((await (await t.call('GET', '/api/wo/next?cleanup=1', 'wrk')).json()).kind, 'cleanup');
  assert.strictEqual((await t.call('POST', `/api/wo/${id}/revise`, null, { note: 'x' })).status, 409, 'cleanup RUNNING');
  await t.call('POST', `/api/wo/${id}/cleanup-result`, 'wrk', { status: 'DONE' });
  assert.strictEqual((await t.call('POST', `/api/wo/${id}/revise`, null, { note: 'x' })).status, 409, 'cleanup DONE');
  t.close();
});

test('revisi: bawa gambar, goals, files_hint, prioritas, limit; gambar bisa diunduh worker', async () => {
  const t = await boot();
  const id = await finished(t);
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
  assert.strictEqual((await t.call('POST', `/api/wo/${id}/revise`, null, { note: 'x', goals: Array(11).fill('g') })).status, 400);
  assert.strictEqual((await t.call('POST', `/api/wo/${id}/revise`, null, { note: 'x', images: [png, png, png, png, png] })).status, 400);
  const rv = await (await t.call('POST', `/api/wo/${id}/revise`, null, { note: 'lihat gambar', goals: ['tombol biru'], files_hint: ['a.php'], images: [png], priority: 'low', limits: { model: 'opus', max_budget_usd: 9 } })).json();
  const r = rv.wo.revisions[0];
  assert.deepStrictEqual([r.goals, r.files_hint, r.images.length], [['tombol biru'], ['a.php'], 1]);
  assert.deepStrictEqual(rv.wo.images, r.images, 'gambar revisi masuk lampiran WO');
  assert.strictEqual(rv.wo.priority, 'low');
  assert.deepStrictEqual([rv.wo.limits.model, rv.wo.limits.max_budget_usd], ['opus', 3]);
  assert.strictEqual((await t.call('GET', `/api/wo/${id}/img/${r.images[0]}`, 'wrk')).status, 200);
  t.close();
});

test('GET /api/wo/projects + repoDirs: daftar project untuk API eksternal dan folder ter-link untuk chat', async () => {
  const t = await boot();
  assert.strictEqual((await t.call('POST', '/api/wo/links', null, { project_key: 'demo', repos: [{ repo: 'demo-dev', url: '' }] })).status, 200);
  const r = await (await t.call('GET', '/api/wo/projects')).json();
  assert.deepStrictEqual(r.projects.map((x) => [x.key, x.repos]), [['lapila', []], ['demo', ['demo-dev']]]);
  assert.deepStrictEqual(t.o.repoDirs('demo'), ['demo-dev']);
  assert.deepStrictEqual(t.o.repoDirs('nope'), []);
  t.close();
});
