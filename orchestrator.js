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
const CLEANUP_RESULTS = ['DONE', 'SKIPPED', 'FAILED']; // laporan worker setelah mencoba menghapus branch WO yang di-reject
const BRANCH_RE = /^wo\/[\w.-]+$/;
const REVIEWABLE = ['COMPLETED', 'NEEDS_REVIEW', 'MERGE_FAILED']; // boleh di-approve / reject
const REVISABLE = [...REVIEWABLE, 'REJECTED', 'FAILED', 'OVER_BUDGET']; // boleh dikirim balik ke worker untuk revisi di branch yang sama
const MAX_REVISIONS = 20;
const DONE = ['COMPLETED', 'FAILED', 'OVER_BUDGET', 'NEEDS_REVIEW', 'REJECTED', 'MERGED', 'MERGE_FAILED']; // boleh dipangkas
const DELETABLE = ['NEEDS_REVIEW', 'MERGED', 'REJECTED', 'FAILED', 'OVER_BUDGET']; // selesai dan tidak menunggu keputusan; boleh dihapus admin
const MAX_LINK_REPOS = 50;
const MAX_PATCH = 200 * 1024;
const MODELS = ['haiku', 'sonnet', 'opus'];
const PRIORITIES = ['highest', 'high', 'medium', 'low', 'lowest']; // urutan = urutan ambil worker
const QUEUED = ['PENDING', 'APPROVED']; // belum diambil worker: prioritas masih boleh diubah
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
  if (b.priority !== undefined && !PRIORITIES.includes(b.priority)) return 'priority harus salah satu: ' + PRIORITIES.join(',');
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
  const onMerged = opts.onMerged || null; // (repos, scope 'dev'|'all') => Promise<[{repo, ok, detail}]>: pull folder VPS ter-link setelah MERGED
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

  // Peta project_key -> { repos: [{ repo (relPath di VPS), url }] }; admin memilih repo mana yang di-deploy saat itu untuk tombol Deploy / Buka website di UI.
  const linksFile = path.join(dataDir, 'wo-links.json');
  let links = {};
  try { links = JSON.parse(fs.readFileSync(linksFile, 'utf8')); } catch { /* belum ada */ }
  for (const k of Object.keys(links)) if (!Array.isArray(links[k].repos)) links[k] = { repos: links[k].repo ? [{ repo: links[k].repo, url: links[k].url || '' }] : [] }; // bentuk lama {repo,url}

  // Tulis atomik. Node satu thread + tulis sinkron = tidak ada balapan antar request.
  const save = () => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(wos), { mode: 0o660 }); fs.renameSync(tmp, file); };
  const send = (ctx, code, obj) => ctx.send(ctx.res, code, JSON.stringify(obj));

  function view(w) {
    return {
      id: w.id, status: w.status, priority: w.priority || 'medium', project_key: w.project_key, ...w.payload, attempts: w.attempts, result: w.result,
      screenshot_url: w.screenshot ? `/api/wo/shot/${w.screenshot}` : null, cost_usd: w.cost_usd,
      created_at: new Date(w.created_at).toISOString(), completed_at: w.completed_at ? new Date(w.completed_at).toISOString() : null,
      created_by: w.created_by || null, approved_by: w.approved_by || null, approved_at: w.approved_at ? new Date(w.approved_at).toISOString() : null,
      review_note: w.review_note || null, merge: w.merge || null, autopull: w.autopull || null, pull_scope: w.pull_scope || null,
      cleanup: w.cleanup ? { state: w.cleanup.state, detail: w.cleanup.detail || null } : null,
      revision: w.revision || null, revisions: w.revisions || [],
    };
  }

  const dayStart = () => { const d = new Date(now()); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const spentToday = () => wos.filter((w) => w.created_at >= dayStart()).reduce((a, w) => a + (w.cost_usd || 0), 0);

  // Return { w, kind } dengan kind 'merge' (WO yang sudah di-approve), 'run' (WO baru), atau 'cleanup' (hapus branch WO yang
  // di-reject; hanya jika worker memintanya, supaya worker lama tidak salah menjalankan agent), atau null.
  function claim(wantCleanup) {
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
      if (w.cleanup && w.cleanup.state === 'RUNNING' && w.cleanup.lease_until < t) {
        changed = true; w.cleanup.attempts += 1; w.cleanup.lease_until = null;
        if (w.cleanup.attempts >= MAX_ATTEMPTS) { w.cleanup.state = 'FAILED'; w.cleanup.detail = 'lease habis berulang kali (worker mati?)'; }
        else w.cleanup.state = 'PENDING';
      }
    }
    let w = top('APPROVED'); // merge dulu: cepat, dan menunggu keputusan manusia
    let kind = 'merge';
    if (!w) { w = top('PENDING'); kind = 'run'; }
    if (w) { w.status = kind === 'merge' ? 'MERGING' : 'IN_PROGRESS'; w.lease_until = t + leaseMs; changed = true; }
    else if (wantCleanup) { // paling akhir: pekerjaan nyata lebih penting dari beres-beres
      const c = wos.find((x) => x.cleanup && x.cleanup.state === 'PENDING');
      if (c) { c.cleanup.state = 'RUNNING'; c.cleanup.lease_until = t + leaseMs; w = c; kind = 'cleanup'; changed = true; }
    }
    if (changed) save();
    return w ? { w, kind } : null;
  }

  // WO berstatus `status` dengan prioritas tertinggi; seri = yang dibuat paling dulu (wos berurutan waktu buat).
  // WO lama tanpa priority dianggap medium.
  const rank = (w) => PRIORITIES.indexOf(w.priority || 'medium');
  function top(status) {
    let best = null;
    for (const x of wos) if (x.status === status && (!best || rank(x) < rank(best))) best = x;
    return best;
  }

  function rmFiles(w) {
    if (w.screenshot) fs.rm(path.join(shotDir, w.screenshot), () => {});
    fs.rm(path.join(imgDir, w.id), { recursive: true, force: true }, () => {});
  }

  function prune() {
    while (wos.length > MAX_KEEP) {
      const i = wos.findIndex((w) => DONE.includes(w.status));
      if (i < 0) break;
      rmFiles(wos.splice(i, 1)[0]);
    }
    const cutoff = now() - KEEP_SHOT_MS;
    for (const w of wos) {
      if (w.screenshot && w.completed_at && w.completed_at < cutoff) { fs.rm(path.join(shotDir, w.screenshot), () => {}); w.screenshot = null; }
      if (w.payload.images && w.payload.images.length && w.completed_at && w.completed_at < cutoff) { fs.rm(path.join(imgDir, w.id), { recursive: true, force: true }, () => {}); w.payload.images = []; }
    }
  }

  const isWorkerRoute = (p, m) => (m === 'GET' && (p === '/api/wo/next' || p === '/api/wo/db-dump' || p === '/api/wo/db-list')) || (m === 'POST' && (p === '/api/wo/projects' || /^\/api\/wo\/[\w.-]+\/(heartbeat|complete|merge-result|cleanup-result)$/.test(p)));

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
        const c = claim(url.searchParams.get('cleanup') === '1');
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
      const repos = (links[w.project_key] || {}).repos || [];
      if (body.status === 'MERGED' && onMerged && repos.length) w.autopull = { state: 'RUNNING', results: [], at: now() };
      save(); audit('worker', 'wo.merge', w.id, `${body.status} ${w.merge.target}`);
      if (w.autopull && w.autopull.state === 'RUNNING') { // jalan di belakang: worker tidak menunggu git pull
        Promise.resolve().then(() => onMerged(repos.map((r) => r.repo), w.pull_scope === 'all' ? 'all' : 'dev'))
          .then((results) => { w.autopull = { state: 'DONE', results, at: now() }; })
          .catch((e) => { w.autopull = { state: 'FAILED', results: [], detail: String((e && e.message) || e).slice(0, 500), at: now() }; })
          .then(() => { save(); audit('system', 'wo.autopull', w.id, w.autopull.state); });
      }
      return send(ctx, 200, { wo: view(w) }), true;
    }
    if (action === 'cleanup-result') {
      if (!CLEANUP_RESULTS.includes(body.status)) return send(ctx, 400, { error: 'status harus salah satu: ' + CLEANUP_RESULTS.join(',') }), true;
      if (!w.cleanup || w.cleanup.state !== 'RUNNING') return send(ctx, 409, { error: 'tidak ada cleanup berjalan' }), true;
      w.cleanup = { state: body.status, detail: String(body.detail || '').slice(0, 500), attempts: w.cleanup.attempts, at: now() };
      save(); audit('worker', 'wo.cleanup', w.id, body.status);
      return send(ctx, 200, { wo: view(w) }), true;
    }
    if (!FINAL.includes(body.status)) return send(ctx, 400, { error: 'status harus salah satu: ' + FINAL.join(',') }), true;
    if (w.status !== 'IN_PROGRESS') return send(ctx, 409, { error: 'WO berstatus ' + w.status }), true;
    const result = body.result && typeof body.result === 'object' ? body.result : {};
    if (typeof result.patch === 'string' && result.patch.length > MAX_PATCH) { result.patch = result.patch.slice(0, MAX_PATCH); result.patch_truncated = true; }
    if (!/^[0-9a-f]{7,40}$/.test(result.head_sha || '')) delete result.head_sha;   // dipakai untuk memastikan yang di-merge = yang direview
    if (!/^[0-9a-f]{7,40}$/.test(result.base_sha || '')) delete result.base_sha; // awal branch WO: dipakai revisi untuk patch penuh
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
    w.cost_usd = (w.cost_usd || 0) + (Number.isFinite(result.cost_usd) ? result.cost_usd : 0); // revisi menambah biaya, bukan menimpa
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
        // id dipakai di URL, nama folder & branch: user disanitasi ke [\w-]
        id: `WO-${String(session.user || '').replace(/[^\w-]/g, '').slice(0, 20) || 'user'}-${crypto.randomBytes(3).toString('hex')}`,
        status: 'PENDING', priority: b.priority || 'highest', project_key: b.project_key, attempts: 0, lease_until: null, result: null, screenshot: null, cost_usd: 0,
        created_at: t, completed_at: null, created_by: session.user,
        payload: {
          context: b.context, goals: b.goals || [], files_hint: b.files_hint || [], verification: b.verification || {},
          limits: limitsOf(b),
        },
      };
      if (dbSource) w.payload.db_source = dbSource;
      if (imgs.length) w.payload.images = saveImgs(w.id, imgs);
      wos.push(w); prune(); save();
      audit(session.user, 'wo.create', w.id, b.project_key);
      return send(ctx, 201, { wo: view(w) }), true;
    }
    if (p === '/api/wo' && req.method === 'GET') {
      const limit = clamp(url.searchParams.get('limit'), 1, 200, 50);
      return send(ctx, 200, { cost_today_usd: spentToday(), daily_budget_usd: dailyBudget, links, projects: registry.list, projects_updated_at: registry.updated_at ? new Date(registry.updated_at).toISOString() : null, work_orders: wos.slice(-limit).reverse().map(view) }), true;
    }
    if (p === '/api/wo/links' && req.method === 'GET') return send(ctx, 200, { links }), true;
    if (p === '/api/wo/links' && req.method === 'POST') {
      let b;
      try { b = JSON.parse(await ctx.readBody(req, 32 * 1024)); } catch { return send(ctx, 400, { error: 'Bad request' }), true; }
      const key = b && b.project_key;
      if (typeof key !== 'string' || !/^[\w.-]{1,64}$/.test(key) || !(registry.list.some((x) => x.key === key) || wos.some((w) => w.project_key === key))) return send(ctx, 400, { error: 'project tidak dikenal' }), true;
      if (!Array.isArray(b.repos) || b.repos.length > MAX_LINK_REPOS) return send(ctx, 400, { error: `repos harus daftar maks ${MAX_LINK_REPOS}` }), true;
      const repos = [];
      for (const x of b.repos) {
        const repo = x && typeof x.repo === 'string' ? x.repo.trim() : '', url = x && typeof x.url === 'string' ? x.url.trim() : '';
        if (!repo || repo.length > 300 || repo.includes('..') || repo.startsWith('/') || repo.includes('\0')) return send(ctx, 400, { error: 'repo tidak valid' }), true;
        if (url && (url.length > 300 || !/^https?:\/\/[^\s]+$/i.test(url))) return send(ctx, 400, { error: 'url harus http(s)://' }), true;
        if (!repos.some((r) => r.repo === repo)) repos.push({ repo, url });
      }
      if (repos.length) links[key] = { repos }; else delete links[key];
      fs.writeFileSync(linksFile, JSON.stringify(links), { mode: 0o660 });
      audit(session.user, 'wo.link', key, repos.map((r) => r.repo).join(',').slice(0, 300));
      return send(ctx, 200, { links }), true;
    }
    if (p === '/api/wo/delete' && req.method === 'POST') {
      let b;
      try { b = JSON.parse(await ctx.readBody(req, 64 * 1024)); } catch { return send(ctx, 400, { error: 'Bad request' }), true; }
      if (!b || !Array.isArray(b.ids) || b.ids.length > 200 || !b.ids.every((x) => typeof x === 'string')) return send(ctx, 400, { error: 'ids harus daftar maks 200' }), true;
      const deleted = [], skipped = [];
      for (const id of new Set(b.ids)) {
        const i = wos.findIndex((x) => x.id === id);
        if (i < 0) skipped.push({ id, reason: 'tidak ada' });
        else if (!DELETABLE.includes(wos[i].status)) skipped.push({ id, reason: 'status ' + wos[i].status });
        else if (wos[i].cleanup && ['PENDING', 'RUNNING'].includes(wos[i].cleanup.state)) skipped.push({ id, reason: 'menunggu cleanup branch di worker' });
        else { rmFiles(wos.splice(i, 1)[0]); deleted.push(id); }
      }
      if (deleted.length) { save(); audit(session.user, 'wo.delete', deleted.length + ' WO', deleted.join(',').slice(0, 300)); }
      return send(ctx, 200, { deleted, skipped }), true;
    }
    const img = IMG_ROUTE.exec(p);
    if (img && req.method === 'GET') return serveImg(ctx, img), true;
    const shot = /^\/api\/wo\/shot\/([^/]+)$/.exec(p);
    if (shot && req.method === 'GET') {
      if (!SHOT_RE.test(shot[1])) return send(ctx, 404, { error: 'Not found' }), true;
      try { ctx.send(ctx.res, 200, fs.readFileSync(path.join(shotDir, shot[1])), 'image/png'); } catch { send(ctx, 404, { error: 'Not found' }); }
      return true;
    }
    const pr = /^\/api\/wo\/([\w.-]+)\/priority$/.exec(p);
    if (pr && req.method === 'POST') {
      const w = wos.find((x) => x.id === pr[1]);
      if (!w) return send(ctx, 404, { error: 'WO tidak ditemukan' }), true;
      let b;
      try { b = JSON.parse(await ctx.readBody(req, 4096)); } catch { return send(ctx, 400, { error: 'Bad request' }), true; }
      if (!b || !PRIORITIES.includes(b.priority)) return send(ctx, 400, { error: 'priority harus salah satu: ' + PRIORITIES.join(',') }), true;
      if (!QUEUED.includes(w.status)) return send(ctx, 409, { error: 'WO berstatus ' + w.status + ': prioritas hanya bisa diubah selama antre' }), true;
      const old = w.priority || 'medium';
      w.priority = b.priority; save();
      audit(session.user, 'wo.priority', w.id, `${old} -> ${w.priority}`);
      return send(ctx, 200, { wo: view(w) }), true;
    }
    const act = /^\/api\/wo\/([\w.-]+)\/(approve|reject|revise)$/.exec(p);
    if (act && req.method === 'POST') {
      const w = wos.find((x) => x.id === act[1]);
      if (!w) return send(ctx, 404, { error: 'WO tidak ditemukan' }), true;
      let b = {};
      try { const raw = await ctx.readBody(req, act[2] === 'revise' ? CREATE_LIMIT : 8192); b = raw ? JSON.parse(raw) : {}; } catch { return send(ctx, 400, { error: 'Bad request' }), true; }
      if (act[2] === 'revise') return revise(ctx, w, b), true;
      if (!REVIEWABLE.includes(w.status)) return send(ctx, 409, { error: 'WO berstatus ' + w.status }), true;
      const r0 = w.result || {};
      if (act[2] === 'approve') {
        const r = w.result || {};
        if (!r.head_sha || !r.branch) return send(ctx, 409, { error: 'WO ini tidak punya branch/head_sha (dibuat sebelum fitur merge), merge manual di laptop' }), true;
        if (b.pull !== undefined && b.pull !== 'dev' && b.pull !== 'all') return send(ctx, 400, { error: "pull harus 'dev' atau 'all'" }), true;
        w.status = 'APPROVED'; w.merge = null; w.merge_attempts = 0; w.autopull = null;
        w.pull_scope = b.pull === 'all' ? 'all' : 'dev';
        w.approved_by = session.user; w.approved_at = now();
        audit(session.user, 'wo.approve', w.id, `${r.branch} pull=${w.pull_scope}`);
      } else {
        w.status = 'REJECTED'; w.approved_by = session.user; w.approved_at = now();
        if (BRANCH_RE.test(r0.branch || '')) w.cleanup = { state: 'PENDING', attempts: 0 }; // worker menghapus branch lokal WO ini
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

  const limitsOf = (b) => ({ max_budget_usd: clamp(b.limits && b.limits.max_budget_usd, 0.05, 3, 0.5), timeout_sec: clamp(b.limits && b.limits.timeout_sec, 30, 1800, 600), model: (b.limits && b.limits.model) || 'sonnet' });

  // Simpan lampiran WO (sudah lolos decodeImages) ke data/wo-images/<id>/; return nama file.
  function saveImgs(id, imgs) {
    const dir = path.join(imgDir, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return imgs.map(({ buf, ext }) => {
      const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(dir, name), buf, { mode: 0o600 });
      return name;
    });
  }

  // Kirim WO kembali ke antrean: worker melanjutkan branch yang sama (commit baru di atas head_sha yang direview)
  // dengan catatan reviewer di prompt, lalu hasilnya direview ulang (approve -> merge seperti biasa).
  function revise(ctx, w, b) {
    const session = ctx.session;
    const note = typeof b.note === 'string' ? b.note.trim() : '';
    if (!note || note.length > 4000) return send(ctx, 400, { error: 'note (alasan revisi) wajib, maks 4000 karakter' });
    const err = validate({ ...b, project_key: w.project_key, context: note, verification: undefined }); // goals, files_hint, limits, priority: aturan sama dengan WO baru
    if (err) return send(ctx, 400, { error: err });
    let imgs;
    try { imgs = chats.decodeImages(b.images); } catch (e) { return send(ctx, 400, { error: e.message }); }
    if (!REVISABLE.includes(w.status)) return send(ctx, 409, { error: 'WO berstatus ' + w.status });
    const r = w.result || {};
    const src = BRANCH_RE.test(r.branch || '') && r.head_sha ? r : w.revision; // revisi yang gagal tidak membawa head_sha: pakai branch revisi sebelumnya
    if (!src) return send(ctx, 409, { error: 'WO ini tidak punya branch/commit untuk direvisi, buat WO baru' });
    if (w.cleanup && ['RUNNING', 'DONE'].includes(w.cleanup.state)) return send(ctx, 409, { error: 'branch WO sudah/sedang dihapus worker, buat WO baru' });
    if ((w.revisions || []).length >= MAX_REVISIONS) return send(ctx, 409, { error: `batas ${MAX_REVISIONS} revisi tercapai, buat WO baru` });
    const spent = spentToday();
    if (spent >= dailyBudget) return send(ctx, 429, { error: `budget harian habis ($${spent.toFixed(2)}/$${dailyBudget})` });
    const images = imgs.length ? saveImgs(w.id, imgs) : [];
    if (images.length) w.payload.images = [...(w.payload.images || []), ...images]; // ikut diunduh worker seperti lampiran WO
    if (b.limits) w.payload.limits = limitsOf(b);
    if (b.priority) w.priority = b.priority;
    w.revisions = [...(w.revisions || []), { note, goals: b.goals || [], files_hint: b.files_hint || [], images, by: session.user, at: new Date(now()).toISOString(), from_status: w.status, head_sha: src.head_sha }];
    w.revision = { n: w.revisions.length, branch: src.branch, head_sha: src.head_sha, base_sha: src.base_sha || null };
    w.status = 'PENDING'; w.attempts = 0; w.lease_until = null;
    w.cleanup = null; w.merge = null; w.merge_attempts = 0; w.autopull = null; w.approved_by = null; w.approved_at = null;
    w.review_note = note.slice(0, 500);
    save();
    audit(session.user, 'wo.revise', w.id, `#${w.revision.n} ${src.branch}`);
    return send(ctx, 200, { wo: view(w) });
  }

  prune();
  return { handleWorker, handleAdmin, isWorkerRoute, validate };
}

module.exports = { create, validate, PRIORITIES };
