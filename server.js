'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');
const auth = require('./auth');

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SAMPLE_INTERVAL_MS = 10_000;
const MAX_POINTS = 8640; // 24h @ 10s

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let history = [];
try {
  if (fs.existsSync(HISTORY_FILE)) {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(raw)) history = raw.slice(-MAX_POINTS);
  }
} catch { history = []; }

// ---- collectors ----
let prevCpu = null;
function cpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total, count: cpus.length };
}
function cpuPercent() {
  const cur = cpuSnapshot();
  if (!prevCpu) { prevCpu = cur; return 0; }
  const idleDiff = cur.idle - prevCpu.idle;
  const totalDiff = cur.total - prevCpu.total;
  prevCpu = cur;
  if (totalDiff <= 0) return 0;
  return Math.min(100, Math.max(0, (1 - idleDiff / totalDiff) * 100));
}
// prime first reading
prevCpu = cpuSnapshot();

function memInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  let available = null, swapTotal = 0, swapFree = 0, cached = 0, buffers = 0;
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k) => {
      const m = txt.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm'));
      return m ? parseInt(m[1], 10) * 1024 : null;
    };
    available = get('MemAvailable');
    swapTotal = get('SwapTotal') || 0;
    swapFree = get('SwapFree') || 0;
    cached = get('Cached') || 0;
    buffers = get('Buffers') || 0;
  } catch {}
  return { total, free, used, available, swapTotal, swapFree, swapUsed: swapTotal - swapFree, cached, buffers, pct: total ? (used / total) * 100 : 0 };
}

function diskInfo() {
  try {
    const out = execSync('df -k / | tail -1', { timeout: 3000 }).toString().trim().split(/\s+/);
    // Filesystem 1K-blocks Used Available Use% Mounted
    const total = parseInt(out[1], 10) * 1024;
    const used = parseInt(out[2], 10) * 1024;
    const avail = parseInt(out[3], 10) * 1024;
    const pct = parseFloat(out[4].replace('%', '')) || (total ? (used / total) * 100 : 0);
    let inodesPct = null;
    try {
      const io = execSync('df -i / | tail -1', { timeout: 3000 }).toString().trim().split(/\s+/);
      inodesPct = parseFloat((io[4] || '').replace('%', '')) || null;
    } catch {}
    return { total, used, avail, pct, inodesPct, mount: '/' };
  } catch {
    return { total: 0, used: 0, avail: 0, pct: 0, inodesPct: null, mount: '/' };
  }
}

function netInfo() {
  try {
    const txt = fs.readFileSync('/proc/net/dev', 'utf8');
    let rx = 0, tx = 0;
    for (const line of txt.split('\n').slice(2)) {
      const m = line.trim().match(/^(eth0|ens\d+|enp\d+s\d+|venet0|wlp\d+):\s*(.+)/);
      if (!m) {
        // sum all non-lo
        const m2 = line.trim().match(/^([^:]+):\s*(.+)/);
        if (!m2 || m2[1].trim() === 'lo') continue;
        const f = m2[2].trim().split(/\s+/);
        rx += parseInt(f[0], 10) || 0;
        tx += parseInt(f[8], 10) || 0;
        continue;
      }
      const f = m[2].trim().split(/\s+/);
      rx += parseInt(f[0], 10) || 0;
      tx += parseInt(f[8], 10) || 0;
    }
    return { rx, tx };
  } catch { return { rx: 0, tx: 0 }; }
}

function getStats() {
  const mem = memInfo();
  const disk = diskInfo();
  const load = os.loadavg();
  return {
    time: Date.now(),
    hostname: os.hostname(),
    uptime: os.uptime(),
    load: { l1: load[0], l5: load[1], l15: load[2] },
    cpu: { pct: Number(cpuPercent().toFixed(1)), cores: os.cpus().length, model: (os.cpus()[0] || {}).model || '' },
    mem: { ...mem, pct: Number(mem.pct.toFixed(1)) },
    disk: { ...disk, pct: Number(disk.pct.toFixed(1)) },
    net: netInfo(),
  };
}

function getProcesses(onlyUser = null) {
  return new Promise((resolve) => {
    exec('ps aux --sort=-%cpu', { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const lines = stdout.trim().split('\n').slice(1);
      const rows = lines.map((l) => {
        const p = l.trim().split(/\s+/);
        if (p.length < 11) return null;
        return {
          user: p[0], pid: p[1],
          cpu: parseFloat(p[2]) || 0, mem: parseFloat(p[3]) || 0,
          rss: p[5], stat: p[7], start: p[8],
          cmd: p.slice(10).join(' ').slice(0, 120),
        };
      }).filter((r) => r && (!onlyUser || r.user === onlyUser));
      resolve(rows.slice(0, 15));
    });
  });
}

const SERVICES = ['nginx', 'mysql', 'php8.4-fpm', 'mosquitto', 'redis-server', 'ssh'];
function getServices() {
  const out = SERVICES.map((s) => {
    try {
      const st = execSync(`systemctl is-active ${s} 2>/dev/null`, { timeout: 2000 }).toString().trim();
      return { name: s, active: st === 'active', status: st };
    } catch {
      return { name: s, active: false, status: 'unknown' };
    }
  });
  return out;
}

// ---- sampler ----
let lastStats = null;
function sample() {
  lastStats = getStats();
  history.push({
    t: lastStats.time,
    cpu: lastStats.cpu.pct,
    mem: lastStats.mem.pct,
    memUsed: lastStats.mem.used,
    disk: lastStats.disk.pct,
    l1: Number(lastStats.load.l1.toFixed(2)),
    l5: Number(lastStats.load.l5.toFixed(2)),
  });
  if (history.length > MAX_POINTS) history = history.slice(-MAX_POINTS);
}
sample();
setInterval(sample, SAMPLE_INTERVAL_MS);
setInterval(() => {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-MAX_POINTS))); } catch {}
}, 60_000);

// ---- http ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveFile(res, file) {
  const fp = path.join(PUBLIC_DIR, file);
  if (!fp.startsWith(PUBLIC_DIR) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    return send(res, 404, 'not found', 'text/plain');
  }
  send(res, 200, fs.readFileSync(fp), MIME[path.extname(fp)] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/api/health') return send(res, 200, JSON.stringify({ ok: true, time: Date.now() }));

  // ---- auth ----
  if (p === '/api/login' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const r = await auth.login(req, body && body.username, body && body.password);
    if (!r.ok) return send(res, r.status, JSON.stringify({ error: r.error }));
    res.setHeader('Set-Cookie', r.setCookie);
    return send(res, 200, JSON.stringify({ user: r.user, admin: r.admin }));
  }
  if (p === '/api/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', auth.logout(req));
    return send(res, 200, JSON.stringify({ ok: true }));
  }
  if (p === '/login' || p === '/login.html') {
    if (auth.getSession(req)) { res.writeHead(302, { Location: '/' }); return res.end(); }
    return serveFile(res, '/login.html');
  }

  const session = auth.getSession(req);
  if (!session) {
    if (p.startsWith('/api/')) return send(res, 401, JSON.stringify({ error: 'Unauthorized' }));
    res.writeHead(302, { Location: '/login' });
    return res.end();
  }

  if (p === '/api/me') return send(res, 200, JSON.stringify(session));
  if (p === '/api/stats') {
    const s = lastStats && (Date.now() - lastStats.time < SAMPLE_INTERVAL_MS * 1.5) ? lastStats : getStats();
    if (!lastStats || s !== lastStats) lastStats = s;
    return send(res, 200, JSON.stringify(s));
  }
  if (p === '/api/processes') {
    const rows = await getProcesses(session.admin ? null : session.user);
    return send(res, 200, JSON.stringify({ time: Date.now(), rows }));
  }
  if (p === '/api/services') return send(res, 200, JSON.stringify({ time: Date.now(), services: getServices() }));
  if (p === '/api/history') {
    const limit = Math.min(8640, Math.max(10, parseInt(url.searchParams.get('limit') || '720', 10)));
    return send(res, 200, JSON.stringify({ intervalMs: SAMPLE_INTERVAL_MS, points: history.slice(-limit) }));
  }

  let file = p === '/' ? '/index.html' : p;
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
  serveFile(res, file);
});

server.listen(PORT, HOST, () => console.log(`vps-monitor on http://${HOST}:${PORT}`));
