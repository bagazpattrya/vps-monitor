'use strict';
// ---- orchestrator: antrean Work Order (WO) untuk worker di laptop ----
// Tanpa dependency. Server hanya menyimpan data: tidak ada exec/spawn di sini, agent jalan di laptop.
// Admin (admin/superadmin, lewat session) membuat, melihat, approve/reject WO; worker (Bearer ORCH_WORKER_TOKEN)
// mengambil, heartbeat, dan melapor. Approve membuat worker me-merge branch WO ke branch `target` yang diatur
// di projects.json LAPTOP (VPS tidak bisa memilih target). Lihat docs/orchestrator.md.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');
const chats = require('./chats');

const COMPLEXITY = ['simple', 'complex'];
const FINAL = ['COMPLETED', 'FAILED', 'OVER_BUDGET', 'NEEDS_REVIEW']; // status yang boleh dilaporkan worker setelah menjalankan agent
const MERGE_RESULTS = ['MERGED', 'MERGE_FAILED'];
const REVIEWABLE = ['COMPLETED', 'NEEDS_REVIEW', 'MERGE_FAILED']; // boleh di-approve / reject
const DONE = ['COMPLETED', 'FAILED', 'OVER_BUDGET', 'NEEDS_REVIEW', 'REJECTED', 'MERGED', 'MERGE_FAILED']; // boleh dipangkas
const MAX_PATCH = 200 * 1024;
const MODELS = ['haiku', 'sonnet', 'opus'];
const MAX_ATTEMPTS = 2;
const MAX_KEEP = 500;
const KEEP_SHOT_MS = 30 * 86400000;
const MAX_SHOT = 2 * 1024 * 1024;
const BODY_LIMIT = 3 * 1024 * 1024; // PNG 2 MB dalam base64 ~2.8 MB
const SHOT_RE = /^[a-f0-9]{32}\.png$/;
const CREATE_LIMIT = 30 * 1024 * 1024; // 4 gambar x 5 MB dalam base64; hanya untuk POST /api/wo
const IMG_RE = /^[a-f0-9]{16}\.(png|jpg|webp|gif)$/;
const IMG_ROUTE = /^\/api\/wo\/([\w.-]+)\/img\/([^/]+)$/;
const IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const strList = (v, maxN, maxLen) => Array.isArray(v) && v.length <= maxN && v.every((x) => str(x, maxLen));
const clamp = (n, lo, hi, d) => (n !== null && n !== undefined && Number.isFinite(Number(n)) ? Math.min(Math.max(Number(n), lo), hi) : d);

function validate(b) {
  if (!b || typeof b !== 'object') return 'body harus JSON object';
  if (typeof b.project_key !== 'string' || !/^[\w.-]{1,64}$/.test(b.project_key)) return 'project_key tidak valid';
  if (!str(b.context, 4000)) return 'context wajib (maks 4000 karakter)';
  if (b.goals !== undefined && !strList(b.goals, 10, 500)) return 'goals opsional: maks 10 string';
  if (b.files_hint !== undefined && !strList(b.files_hint, 20, 200)) return 'files_hint tidak valid';
  const l = b.limits || {};
  if (l.model !== undefined && !MODELS.includes(l.model)) return 'model harus salah satu: ' + MODELS.join(',');
  const v = b.verification;
  if (v !== undefined && (typeof v !== 'object' || v === null || (v.target_url !== undefined && !str(v.target_url, 300)))) return 'verification tidak valid';
  return null;
}

function create(opts = {}) {
  const dataDir = opts.dataDir;
  const leaseMs = (Number(opts.leaseSec) || 120) * 1000;
  const dailyBudget = Number.isFinite(Number(opts.dailyBudget)) && opts.dailyBudget !== undefined ? Number(opts.dailyBudget) : 5;
  const workerToken = opts.workerToken || '';
  const dumpDbs = opts.dumpDbs || []; // allowlist DB yang boleh ditarik worker (ORCH_DUMP_DBS)
  const dumpBin = opts.dumpBin || 'mysqldump';
  const now = opts.now || Date.now;
  const audit = opts.audit || (() => {});
  const file = path.join(dataDir, 'work-orders.json');
  const shotDir = path.join(dataDir, 'wo-shots');
  const imgDir = path.join(dataDir, 'wo-images');
  fs.mkdirSync(shotDir, { recursive: true });

  let wos = [];
  try { wos = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* belum ada */ }

  // Daftar project (key + target merge, TANPA path) yang didaftarkan worker laptop. Dipakai untuk dropdown
  // dan untuk menolak WO ke project yang tidak dikenal worker.
  const projFile = path.join(dataDir, 'wo-projects.json');
  let registry = { list: [], updated_at: null };
  try { registry = JSON.parse(fs.readFileSync(projFile, 'utf8')); } catch { /* belum ada */ }

  // Tulis atomik. Node satu thread + tulis sinkron = tidak ada balapan antar request.
  const save = () => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(wos), { mode: 0o660 }); fs.renameSync(tmp, file); };
  const send = (ctx, code, obj) => ctx.send(ctx.res, code, JSON.stringify(obj));

  function view(w) {
    return {
      id: w.id, status: w.status, project_key: w.project_key, ...w.payload, attempts: w.attempts, result: w.result,
      screenshot_url: w.screenshot ? `/api/wo/shot/${w.screenshot}` : null, cost_usd: w.cost_usd,
      created_at: new Date(w.created_at).toISOString(), completed_at: w.completed_at ? new Date(w.completed_at).toISOString() : null,
      approved_by: w.approved_by || null, approved_at: w.approved_at ? new Date(w.approved_at).toISOString() : null,
      review_note: w.review_note || null, merge: w.merge || null,
    };
  }

  const dayStart = () => { const d = new Date(now()); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const spentToday = () => wos.filter((w) => w.created_at >= dayStart()).reduce((a, w) => a + (w.cost_usd || 0), 0);

  // Return { w, kind } dengan kind 'merge' (WO yang sudah di-approve) atau 'run' (WO baru), atau null.
  function claim() {
    const t = now();
    let changed = false;
    for (const w of wos) { // lease habis: kembali ke antrean, atau gagal jika sudah terlalu sering
      if (w.status === 'IN_PROGRESS' && w.lease_until < t) {
        changed = true; w.attempts += 1; w.lease_until = null;
        if (w.attempts >= MAX_ATTEMPTS) { w.status = 'FAILED'; w.completed_at = t; w.result = { status: 'FAILED', logs: 'lease habis berulang kali (worker mati?)' }; }
        else w.status = 'PENDING';
      } else if (w.status === 'MERGING' && w.lease_until < t) {
        changed = true; w.merge_attempts = (w.merge_attempts || 0) + 1; w.lease_until = null;
        if (w.merge_attempts >= MAX_ATTEMPTS) { w.status = 'MERGE_FAILED'; w.merge = { status: 'MERGE_FAILED', detail: 'lease habis berulang kali (worker mati?)', at: t }; }
        else w.status = 'APPROVED';
      }
    }
    let w = wos.find((x) => x.status === 'APPROVED'); // merge dulu: cepat, dan menunggu keputusan manusia
    let kind = 'merge';
    if (!w) { w = wos.find((x) => x.status === 'PENDING'); kind = 'run'; } // wos berurutan waktu buat = FIFO
    if (w) { w.status = kind === 'merge' ? 'MERGING' : 'IN_PROGRESS'; w.lease_until = t + leaseMs; changed = true; }
    if (changed) save();
    return w ? { w, kind } : null;
  }

  function prune() {
    while (wos.length > MAX_KEEP) {
      const i = wos.findIndex((w) => DONE.includes(w.status));
      if (i < 0) break;
      const [w] = wos.splice(i, 1);
      if (w.screenshot) fs.rm(path.join(shotDir, w.screenshot), () => {});
      fs.rm(path.join(imgDir, w.id), { recursive: true, force: true }, () => {});
    }
    const cutoff = now() - KEEP_SHOT_MS;
    for (const w of wos) {
      if (w.screenshot && w.completed_at && w.completed_at < cutoff) { fs.rm(path.join(shotDir, w.screenshot), () => {}); w.screenshot = null; }
      if (w.payload.images && w.payload.images.length && w.completed_at && w.completed_at < cutoff) { fs.rm(path.join(imgDir, w.id), { recursive: true, force: true }, () => {}); w.payload.images = []; }
    }
  }

  const isWorkerRoute = (p, m) => (m === 'GET' && (p === '/api/wo/next' || p === '/api/wo/db-dump' || p === '/api/wo/db-list')) || (m === 'POST' && (p === '/api/wo/projects' || /^\/api\/wo\/[\w.-]+\/(heartbeat|complete|merge-result)$/.test(p)));

  function workerAuthOk(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return false;
    const a = Buffer.from(m[1]), b = Buffer.from(workerToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Stream mysqldump | gzip untuk worker. Hanya DB di allowlist. Jika gagal, koneksi diputus (bukan diakhiri) supaya
  // tidak tampak seperti dump utuh; worker juga menjalankan `gzip -t`.
  function dumpDb(ctx, db) {
    const { req, res } = ctx;
    if (!/^\w{1,64}$/.test(db) || !dumpDbs.includes(db)) return send(ctx, 404, { error: 'DB tidak ada di ORCH_DUMP_DBS' });
    audit('worker', 'wo.dump', db, '');
    const d = spawn(dumpBin, ['--single-transaction', '--quick', '--routines', '--triggers', '--events', '--no-tablespaces', db], { stdio: ['ignore', 'pipe', 'pipe'] });
    const gz = zlib.createGzip();
    let started = false, err = '';
    const head = () => { if (!started) { started = true; res.writeHead(200, { 'Content-Type': 'application/gzip', 'Cache-Control': 'no-store' }); } };
    d.stderr.on('data', (c) => { err = (err + c).slice(-500); });
    d.on('error', (e) => { if (!started) send(ctx, 500, { error: 'mysqldump gagal: ' + e.message }); else res.destroy(); });
    gz.on('data', (c) => { head(); res.write(c); });
    const gzDone = new Promise((r) => gz.on('end', r));
    d.on('close', async (code) => {
      if (code !== 0) { gz.destroy(); return started ? res.destroy() : send(ctx, 500, { error: 'mysqldump gagal: ' + err.trim() }); }
      await gzDone; head(); res.end();
    });
    req.on('close', () => { try { d.kill(); } catch { /* sudah selesai */ } });
    d.stdout.pipe(gz);
  }

  // Kirim lampiran WO. `w.id` dibuat server (hex), nama file divalidasi regex: tidak ada traversal.
  function serveImg(ctx, m) {
    const w = wos.find((x) => x.id === m[1]);
    if (!w || !IMG_RE.test(m[2]) || !(w.payload.images || []).includes(m[2])) return send(ctx, 404, { error: 'Not found' });
    try {
      ctx.res.setHeader('X-Content-Type-Options', 'nosniff');
      ctx.send(ctx.res, 200, fs.readFileSync(path.join(imgDir, w.id, m[2])), IMG_TYPES[m[2].split('.')[1]]);
    } catch { send(ctx, 404, { error: 'Not found' }); }
  }

  // Endpoint worker. Return true jika request ini milik orchestrator (sudah dijawab).
  async function handleWorker(ctx) {
    const { req, url } = ctx;
    const p = url.pathname;
    const im = req.method === 'GET' && req.headers.authorization && IMG_ROUTE.exec(p); // path sama dengan admin; dibedakan oleh header Bearer
    if (!im && !isWorkerRoute(p, req.method)) return false;
    if (!workerToken) return send(ctx, 503, { error: 'ORCH_WORKER_TOKEN belum diatur' }), true;
    if (!workerAuthOk(req)) return send(ctx, 401, { error: 'unauthorized' }), true;

    if (im) return serveImg(ctx, im), true;

    if (p === '/api/wo/db-dump') { dumpDb(ctx, url.searchParams.get('db') || ''); return true; }

    if (p === '/api/wo/db-list') { send(ctx, 200, { dbs: dumpDbs }); return true; }

    if (p === '/api/wo/next') {
      const deadline = now() + clamp(url.searchParams.get('wait'), 0, 30, 0) * 1000;
      let closed = false;
      req.on('close', () => { closed = true; });
      for (;;) {
        const c = claim();
        if (c) return send(ctx, 200, { wo: view(c.w), kind: c.kind }), true;
        if (closed || now() >= deadline) return send(ctx, 200, { wo: null }), true;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    if (p === '/api/wo/projects') {
      let b;
      try { b = JSON.parse(await ctx.readBody(req, 64 * 1024)); } catch { return send(ctx, 400, { error: 'body bukan JSON / terlalu besar' }), true; }
      const list = b && b.projects;
      const okSources = (x) => x.db_sources == null || (Array.isArray(x.db_sources) && x.db_sources.length <= 30 && x.db_sources.every((d) => /^\w{1,64}$/.test(d)) && (x.db_default == null || x.db_sources.includes(x.db_default)));
      const okItem = (x) => x && typeof x.key === 'string' && /^[\w.-]{1,64}$/.test(x.key) && (x.target == null || (typeof x.target === 'string' && /^[\w][\w./-]{0,99}$/.test(x.target))) && okSources(x);
      if (!Array.isArray(list) || list.length > 100 || !list.every(okItem) || new Set(list.map((x) => x.key)).size !== list.length) return send(ctx, 400, { error: 'projects tidak valid' }), true;
      registry = { list: list.map((x) => ({ key: x.key, target: x.target || null, db_sources: x.db_sources || [], db_default: x.db_default || (x.db_sources && x.db_sources[0]) || null })), updated_at: now() };
      fs.writeFileSync(projFile, JSON.stringify(registry), { mode: 0o660 });
      return send(ctx, 200, { ok: true, count: list.length }), true;
    }

    const [, , , id, action] = p.split('/');
    const w = wos.find((x) => x.id === id);
    if (!w) return send(ctx, 404, { error: 'WO tidak ditemukan' }), true;

    if (action === 'heartbeat') {
      if (w.status !== 'IN_PROGRESS' && w.status !== 'MERGING') return send(ctx, 409, { ok: false }), true;
      w.lease_until = now() + leaseMs; save();
      return send(ctx, 200, { ok: true }), true;
    }

    let body;
    try { body = JSON.parse(await ctx.readBody(req, BODY_LIMIT)); } catch { return send(ctx, 400, { error: 'body bukan JSON / terlalu besar' }), true; }
    if (action === 'merge-result') {
      if (!MERGE_RESULTS.includes(body.status)) return send(ctx, 400, { error: 'status harus salah satu: ' + MERGE_RESULTS.join(',') }), true;
      if (w.status !== 'MERGING') return send(ctx, 409, { error: 'WO berstatus ' + w.status }), true;
      w.status = body.status; w.lease_until = null;
      w.merge = { status: body.status, detail: String(body.detail || '').slice(0, 2000), sha: /^[0-9a-f]{7,40}$/.test(body.sha || '') ? body.sha : null, target: String(body.target || '').slice(0, 100), at: now() };
      save(); audit('worker', 'wo.merge', w.id, `${body.status} ${w.merge.target}`);
      return send(ctx, 200, { wo: view(w) }), true;
    }
    if (!FINAL.includes(body.status)) return send(ctx, 400, { error: 'status harus salah satu: ' + FINAL.join(',') }), true;
    if (w.status !== 'IN_PROGRESS') return send(ctx, 409, { error: 'WO berstatus ' + w.status }), true;
    const result = body.result && typeof body.result === 'object' ? body.result : {};
    if (typeof result.patch === 'string' && result.patch.length > MAX_PATCH) { result.patch = result.patch.slice(0, MAX_PATCH); result.patch_truncated = true; }
    if (!/^[0-9a-f]{7,40}$/.test(result.head_sha || '')) delete result.head_sha;   // dipakai untuk memastikan yang di-merge = yang direview
    if (!/^wo\/[\w.-]+$/.test(result.branch || '')) delete result.branch;
    // Flag dari agent: dipakai untuk memprioritaskan audit (complex dulu). Nilai selain simple|complex dibuang.
    if (!COMPLEXITY.includes(result.complexity)) delete result.complexity;
    if (typeof result.complexity_reason === 'string') result.complexity_reason = result.complexity_reason.slice(0, 300); else delete result.complexity_reason;

    let shot = null;
    if (typeof body.screenshot_b64 === 'string' && body.screenshot_b64) {
      const buf = Buffer.from(body.screenshot_b64, 'base64');
      if (buf.length <= MAX_SHOT && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) { // magic byte PNG
        shot = crypto.randomBytes(16).toString('hex') + '.png';
        fs.writeFileSync(path.join(shotDir, shot), buf, { mode: 0o660 });
      }
    }
    result.status = body.status;
    w.status = body.status; w.result = result; w.screenshot = shot; w.lease_until = null; w.completed_at = now();
    w.cost_usd = Number.isFinite(result.cost_usd) ? result.cost_usd : 0;
    prune(); save();
    return send(ctx, 200, { wo: view(w) }), true;
  }

  // Endpoint admin (session login, role admin ke atas). Return true jika milik orchestrator.
  async function handleAdmin(ctx) {
    const { req, url, session } = ctx;
    const p = url.pathname;
    if (p !== '/api/wo' && !p.startsWith('/api/wo/')) return false;
    if (!session || !session.admin) return send(ctx, 403, { error: 'Admin required' }), true;

    if (p === '/api/wo' && req.method === 'POST') {
      let b;
      try { b = JSON.parse(await ctx.readBody(req, CREATE_LIMIT)); } catch { return send(ctx, 400, { error: 'Bad request' }), true; }
      const err = validate(b);
      if (err) return send(ctx, 400, { error: err }), true;
      if (!registry.list.length) return send(ctx, 400, { error: 'belum ada project terdaftar: jalankan worker di laptop dulu' }), true;
      if (!registry.list.some((x) => x.key === b.project_key)) return send(ctx, 400, { error: `project "${b.project_key}" tidak dikenal worker. Pilihan: ${registry.list.map((x) => x.key).join(', ')}` }), true;
      const reg = registry.list.find((x) => x.key === b.project_key);
      let dbSource = null;
      if (b.db_source !== undefined && b.db_source !== null && b.db_source !== '') {
        if (typeof b.db_source !== 'string' || !(reg.db_sources || []).includes(b.db_source)) return send(ctx, 400, { error: `db_source tidak valid. Pilihan: ${(reg.db_sources || []).join(', ') || '(project ini tidak punya sumber DB)'}` }), true;
        dbSource = b.db_source;
      } else if ((reg.db_sources || []).length) dbSource = reg.db_default;
      let imgs;
      try { imgs = chats.decodeImages(b.images); } catch (e) { return send(ctx, 400, { error: e.message }), true; }
      const spent = spentToday();
      if (spent >= dailyBudget) return send(ctx, 429, { error: `budget harian habis ($${spent.toFixed(2)}/$${dailyBudget})` }), true;
      const t = now();
      const w = {
        id: `WO-${new Date(t).toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`,
        status: 'PENDING', project_key: b.project_key, attempts: 0, lease_until: null, result: null, screenshot: null, cost_usd: 0,
        created_at: t, completed_at: null,
        payload: {
          context: b.context, goals: b.goals || [], files_hint: b.files_hint || [], verification: b.verification || {},
          limits: { max_budget_usd: clamp(b.limits && b.limits.max_budget_usd, 0.05, 1, 0.5), timeout_sec: clamp(b.limits && b.limits.timeout_sec, 30, 1800, 600), model: (b.limits && b.limits.model) || 'sonnet' },
        },
      };
      if (dbSource) w.payload.db_source = dbSource;
      if (imgs.length) {
        const dir = path.join(imgDir, w.id);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        w.payload.images = imgs.map(({ buf, ext }) => {
          const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
          fs.writeFileSync(path.join(dir, name), buf, { mode: 0o600 });
          return name;
        });
      }
      wos.push(w); prune(); save();
      audit(session.user, 'wo.create', w.id, b.project_key);
      return send(ctx, 201, { wo: view(w) }), true;
    }
    if (p === '/api/wo' && req.method === 'GET') {
      const limit = clamp(url.searchParams.get('limit'), 1, 200, 50);
      return send(ctx, 200, { cost_today_usd: spentToday(), daily_budget_usd: dailyBudget, projects: registry.list, projects_updated_at: registry.updated_at ? new Date(registry.updated_at).toISOString() : null, work_orders: wos.slice(-limit).reverse().map(view) }), true;
    }
    const img = IMG_ROUTE.exec(p);
    if (img && req.method === 'GET') return serveImg(ctx, img), true;
    const shot = /^\/api\/wo\/shot\/([^/]+)$/.exec(p);
    if (shot && req.method === 'GET') {
      if (!SHOT_RE.test(shot[1])) return send(ctx, 404, { error: 'Not found' }), true;
      try { ctx.send(ctx.res, 200, fs.readFileSync(path.join(shotDir, shot[1])), 'image/png'); } catch { send(ctx, 404, { error: 'Not found' }); }
      return true;
    }
    const act = /^\/api\/wo\/([\w.-]+)\/(approve|reject)$/.exec(p);
    if (act && req.method === 'POST') {
      const w = wos.find((x) => x.id === act[1]);
      if (!w) return send(ctx, 404, { error: 'WO tidak ditemukan' }), true;
      let b = {};
      try { const raw = await ctx.readBody(req, 4096); b = raw ? JSON.parse(raw) : {}; } catch { return send(ctx, 400, { error: 'Bad request' }), true; }
      if (!REVIEWABLE.includes(w.status)) return send(ctx, 409, { error: 'WO berstatus ' + w.status }), true;
      if (act[2] === 'approve') {
        const r = w.result || {};
        if (!r.head_sha || !r.branch) return send(ctx, 409, { error: 'WO ini tidak punya branch/head_sha (dibuat sebelum fitur merge), merge manual di laptop' }), true;
        w.status = 'APPROVED'; w.merge = null; w.merge_attempts = 0;
        w.approved_by = session.user; w.approved_at = now();
        audit(session.user, 'wo.approve', w.id, r.branch);
      } else {
        w.status = 'REJECTED'; w.approved_by = session.user; w.approved_at = now();
        audit(session.user, 'wo.reject', w.id, '');
      }
      w.review_note = String(b.note || '').slice(0, 500);
      save();
      return send(ctx, 200, { wo: view(w) }), true;
    }
    const one = /^\/api\/wo\/([\w.-]+)$/.exec(p);
    if (one && req.method === 'GET') {
      const w = wos.find((x) => x.id === one[1]);
      return w ? send(ctx, 200, { wo: view(w) }) : send(ctx, 404, { error: 'WO tidak ditemukan' }), true;
    }
    return false;
  }

  prune();
  return { handleWorker, handleAdmin, isWorkerRoute, validate };
}

module.exports = { create, validate };
