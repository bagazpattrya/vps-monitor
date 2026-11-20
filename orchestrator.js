'use strict';
// ---- orchestrator: antrean Work Order (WO) untuk worker di laptop ----
// Tanpa dependency. Server hanya menyimpan data: tidak ada exec/spawn di sini, agent jalan di laptop.
// Admin (admin/superadmin, lewat session) membuat dan melihat WO; worker (Bearer ORCH_WORKER_TOKEN)
// mengambil, heartbeat, dan melapor. Lihat docs/orchestrator.md.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FINAL = ['COMPLETED', 'FAILED', 'OVER_BUDGET', 'NEEDS_REVIEW'];
const MODELS = ['haiku', 'sonnet', 'opus'];
const MAX_ATTEMPTS = 2;
const MAX_KEEP = 500;
const KEEP_SHOT_MS = 30 * 86400000;
const MAX_SHOT = 2 * 1024 * 1024;
const BODY_LIMIT = 3 * 1024 * 1024; // PNG 2 MB dalam base64 ~2.8 MB
const SHOT_RE = /^[a-f0-9]{32}\.png$/;

const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const strList = (v, maxN, maxLen) => Array.isArray(v) && v.length <= maxN && v.every((x) => str(x, maxLen));
const clamp = (n, lo, hi, d) => (n !== null && n !== undefined && Number.isFinite(Number(n)) ? Math.min(Math.max(Number(n), lo), hi) : d);

function validate(b) {
  if (!b || typeof b !== 'object') return 'body harus JSON object';
  if (typeof b.project_key !== 'string' || !/^[\w.-]{1,64}$/.test(b.project_key)) return 'project_key tidak valid';
  if (!str(b.context, 4000)) return 'context wajib (maks 4000 karakter)';
  if (!strList(b.goals, 10, 500) || !b.goals.length) return 'goals wajib: 1-10 string';
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
  const now = opts.now || Date.now;
  const audit = opts.audit || (() => {});
  const file = path.join(dataDir, 'work-orders.json');
  const shotDir = path.join(dataDir, 'wo-shots');
  fs.mkdirSync(shotDir, { recursive: true });

  let wos = [];
  try { wos = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* belum ada */ }

  // Tulis atomik. Node satu thread + tulis sinkron = tidak ada balapan antar request.
  const save = () => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(wos), { mode: 0o660 }); fs.renameSync(tmp, file); };
  const send = (ctx, code, obj) => ctx.send(ctx.res, code, JSON.stringify(obj));

  function view(w) {
    return {
      id: w.id, status: w.status, project_key: w.project_key, ...w.payload, attempts: w.attempts, result: w.result,
      screenshot_url: w.screenshot ? `/api/wo/shot/${w.screenshot}` : null, cost_usd: w.cost_usd,
      created_at: new Date(w.created_at).toISOString(), completed_at: w.completed_at ? new Date(w.completed_at).toISOString() : null,
    };
  }

  const dayStart = () => { const d = new Date(now()); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const spentToday = () => wos.filter((w) => w.created_at >= dayStart()).reduce((a, w) => a + (w.cost_usd || 0), 0);

  function claim() {
    const t = now();
    let changed = false;
    for (const w of wos) { // lease habis: balik PENDING, atau FAILED jika sudah terlalu sering
      if (w.status === 'IN_PROGRESS' && w.lease_until < t) {
        changed = true; w.attempts += 1; w.lease_until = null;
        if (w.attempts >= MAX_ATTEMPTS) { w.status = 'FAILED'; w.completed_at = t; w.result = { status: 'FAILED', logs: 'lease habis berulang kali (worker mati?)' }; }
        else w.status = 'PENDING';
      }
    }
    const w = wos.find((x) => x.status === 'PENDING'); // wos berurutan waktu buat = FIFO
    if (w) { w.status = 'IN_PROGRESS'; w.lease_until = t + leaseMs; changed = true; }
    if (changed) save();
    return w || null;
  }

  function prune() {
    while (wos.length > MAX_KEEP) {
      const i = wos.findIndex((w) => FINAL.includes(w.status));
      if (i < 0) break;
      const [w] = wos.splice(i, 1);
      if (w.screenshot) fs.rm(path.join(shotDir, w.screenshot), () => {});
    }
    const cutoff = now() - KEEP_SHOT_MS;
    for (const w of wos) {
      if (w.screenshot && w.completed_at && w.completed_at < cutoff) { fs.rm(path.join(shotDir, w.screenshot), () => {}); w.screenshot = null; }
    }
  }

  const isWorkerRoute = (p, m) => (m === 'GET' && p === '/api/wo/next') || (m === 'POST' && /^\/api\/wo\/[\w.-]+\/(heartbeat|complete)$/.test(p));

  function workerAuthOk(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return false;
    const a = Buffer.from(m[1]), b = Buffer.from(workerToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Endpoint worker. Return true jika request ini milik orchestrator (sudah dijawab).
  async function handleWorker(ctx) {
    const { req, url } = ctx;
    const p = url.pathname;
    if (!isWorkerRoute(p, req.method)) return false;
    if (!workerToken) return send(ctx, 503, { error: 'ORCH_WORKER_TOKEN belum diatur' }), true;
    if (!workerAuthOk(req)) return send(ctx, 401, { error: 'unauthorized' }), true;

    if (p === '/api/wo/next') {
      const deadline = now() + clamp(url.searchParams.get('wait'), 0, 30, 0) * 1000;
      let closed = false;
      req.on('close', () => { closed = true; });
      for (;;) {
        const w = claim();
        if (w) return send(ctx, 200, { wo: view(w) }), true;
        if (closed || now() >= deadline) return send(ctx, 200, { wo: null }), true;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const [, , , id, action] = p.split('/');
    const w = wos.find((x) => x.id === id);
    if (!w) return send(ctx, 404, { error: 'WO tidak ditemukan' }), true;

    if (action === 'heartbeat') {
      if (w.status !== 'IN_PROGRESS') return send(ctx, 409, { ok: false }), true;
      w.lease_until = now() + leaseMs; save();
      return send(ctx, 200, { ok: true }), true;
    }

    let body;
    try { body = JSON.parse(await ctx.readBody(req, BODY_LIMIT)); } catch { return send(ctx, 400, { error: 'body bukan JSON / terlalu besar' }), true; }
    if (!FINAL.includes(body.status)) return send(ctx, 400, { error: 'status harus salah satu: ' + FINAL.join(',') }), true;
    if (w.status !== 'IN_PROGRESS') return send(ctx, 409, { error: 'WO berstatus ' + w.status }), true;
    const result = body.result && typeof body.result === 'object' ? body.result : {};

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
      try { b = JSON.parse(await ctx.readBody(req, 64 * 1024)); } catch { return send(ctx, 400, { error: 'Bad request' }), true; }
      const err = validate(b);
      if (err) return send(ctx, 400, { error: err }), true;
      const spent = spentToday();
      if (spent >= dailyBudget) return send(ctx, 429, { error: `budget harian habis ($${spent.toFixed(2)}/$${dailyBudget})` }), true;
      const t = now();
      const w = {
        id: `WO-${new Date(t).toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`,
        status: 'PENDING', project_key: b.project_key, attempts: 0, lease_until: null, result: null, screenshot: null, cost_usd: 0,
        created_at: t, completed_at: null,
        payload: {
          context: b.context, goals: b.goals, files_hint: b.files_hint || [], verification: b.verification || {},
          limits: { max_budget_usd: clamp(b.limits && b.limits.max_budget_usd, 0.05, 1, 0.5), timeout_sec: clamp(b.limits && b.limits.timeout_sec, 30, 1800, 600), model: (b.limits && b.limits.model) || 'sonnet' },
        },
      };
      wos.push(w); prune(); save();
      audit(session.user, 'wo.create', w.id, b.project_key);
      return send(ctx, 201, { wo: view(w) }), true;
    }
    if (p === '/api/wo' && req.method === 'GET') {
      const limit = clamp(url.searchParams.get('limit'), 1, 200, 50);
      return send(ctx, 200, { cost_today_usd: spentToday(), daily_budget_usd: dailyBudget, work_orders: wos.slice(-limit).reverse().map(view) }), true;
    }
    const shot = /^\/api\/wo\/shot\/([^/]+)$/.exec(p);
    if (shot && req.method === 'GET') {
      if (!SHOT_RE.test(shot[1])) return send(ctx, 404, { error: 'Not found' }), true;
      try { ctx.send(ctx.res, 200, fs.readFileSync(path.join(shotDir, shot[1])), 'image/png'); } catch { send(ctx, 404, { error: 'Not found' }); }
      return true;
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
