'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execSync, exec, execFile, spawn } = require('child_process');
const auth = require('./auth');

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.jsonl');
const MAX_ACTIVITY = 5000;
const SAMPLE_INTERVAL_MS = 10_000;
const MAX_POINTS = 8640; // 24h @ 10s
const SCAN_ROOT = process.env.SCAN_DIR || '/var/www';
// Keyword global (dipisah koma) untuk menyembunyikan project dari non-superadmin.
// Keyword per-user ditambahkan di atas ini (lihat hiddenKeywordsFor).
const GLOBAL_HIDDEN_KEYWORDS = String(process.env.HIDDEN_PROJECT_KEYWORDS || '')
  .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let history = [];
try {
  if (fs.existsSync(HISTORY_FILE)) {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(raw)) history = raw.slice(-MAX_POINTS);
  }
} catch { history = []; }

// ---- user activity log (append-only JSONL, ring in-memory) ----
let activity = [];
let activityDirty = false;
try {
  if (fs.existsSync(ACTIVITY_FILE)) {
    activity = fs.readFileSync(ACTIVITY_FILE, 'utf8').split('\n').filter(Boolean).slice(-MAX_ACTIVITY)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
} catch { activity = []; }

function logActivity(user, action, target, details = '') {
  activity.push({ t: Date.now(), user: String(user || '?'), action: String(action || '').slice(0, 40), target: String(target ?? '').slice(0, 200), details: String(details ?? '').slice(0, 300) });
  if (activity.length > MAX_ACTIVITY) activity = activity.slice(-MAX_ACTIVITY);
  activityDirty = true;
}
setInterval(() => {
  if (!activityDirty) return;
  try { fs.writeFileSync(ACTIVITY_FILE, activity.map((a) => JSON.stringify(a)).join('\n') + '\n'); activityDirty = false; } catch {}
}, 60_000).unref();

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

// ---- disk I/O stats collector (/proc/diskstats) ----
let prevDiskStats = null;
function getDiskIO() {
  try {
    const txt = fs.readFileSync('/proc/diskstats', 'utf8');
    let readBytes = 0, writeBytes = 0, readOps = 0, writeOps = 0;
    for (const line of txt.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 14) continue;
      const dev = parts[2];
      if (!/^(sd[a-z]+|vd[a-z]+|nvme\d+n\d+|xvd[a-z]+|hd[a-z]+)$/.test(dev)) continue;
      readOps += parseInt(parts[3], 10) || 0;
      readBytes += (parseInt(parts[5], 10) || 0) * 512;
      writeOps += parseInt(parts[7], 10) || 0;
      writeBytes += (parseInt(parts[9], 10) || 0) * 512;
    }
    const now = Date.now();
    let readRate = 0, writeRate = 0, rIops = 0, wIops = 0;
    if (prevDiskStats && now > prevDiskStats.time) {
      const dt = (now - prevDiskStats.time) / 1000;
      if (dt > 0) {
        readRate = Math.max(0, (readBytes - prevDiskStats.readBytes) / dt);
        writeRate = Math.max(0, (writeBytes - prevDiskStats.writeBytes) / dt);
        rIops = Math.max(0, (readOps - prevDiskStats.readOps) / dt);
        wIops = Math.max(0, (writeOps - prevDiskStats.writeOps) / dt);
      }
    }
    prevDiskStats = { time: now, readBytes, writeBytes, readOps, writeOps };
    return {
      readBytes,
      writeBytes,
      readRate: Math.round(readRate),
      writeRate: Math.round(writeRate),
      readIops: Math.round(rIops),
      writeIops: Math.round(wIops),
      totalIops: Math.round(rIops + wIops)
    };
  } catch {
    return { readBytes: 0, writeBytes: 0, readRate: 0, writeRate: 0, readIops: 0, writeIops: 0, totalIops: 0 };
  }
}
getDiskIO(); // prime first reading

// ---- storage breakdown collector ----
let storageCache = { time: 0, data: null };

function getStorageBreakdown(force = false) {
  const now = Date.now();
  if (!force && storageCache.data && (now - storageCache.time < 60_000)) {
    return storageCache.data;
  }

  // 1. Partitions & Mounts
  const mounts = [];
  try {
    const lines = execSync('df -k -P 2>/dev/null', { timeout: 4000 }).toString().trim().split('\n').slice(1);
    const inodesMap = {};
    try {
      const iLines = execSync('df -i -P 2>/dev/null', { timeout: 4000 }).toString().trim().split('\n').slice(1);
      for (const il of iLines) {
        const parts = il.trim().split(/\s+/);
        if (parts.length >= 6) {
          inodesMap[parts[5]] = {
            total: parseInt(parts[1], 10) || 0,
            used: parseInt(parts[2], 10) || 0,
            avail: parseInt(parts[3], 10) || 0,
            pct: parseFloat((parts[4] || '').replace('%', '')) || 0,
          };
        }
      }
    } catch {}

    for (const line of lines) {
      const p = line.trim().split(/\s+/);
      if (p.length < 6) continue;
      const fsName = p[0];
      const target = p[5];
      // Filter pseudo/virtual filesystems, include real disks, mnt, /
      if (fsName.startsWith('/dev/') || target === '/' || target.startsWith('/mnt') || target.startsWith('/home')) {
        const total = (parseInt(p[1], 10) || 0) * 1024;
        const used = (parseInt(p[2], 10) || 0) * 1024;
        const avail = (parseInt(p[3], 10) || 0) * 1024;
        const pct = parseFloat((p[4] || '').replace('%', '')) || 0;
        const inode = inodesMap[target] || null;
        mounts.push({
          fs: fsName,
          mount: target,
          total,
          used,
          avail,
          pct,
          inodesPct: inode ? inode.pct : null,
          inodesUsed: inode ? inode.used : null,
          inodesTotal: inode ? inode.total : null,
        });
      }
    }
  } catch {}

  // 2. Key Directories breakdown
  const candidateDirs = ['/var/www', '/var/log', '/var/lib/mysql', '/home', '/tmp', '/var/cache', '/var/lib/docker'];
  if (SCAN_ROOT && !candidateDirs.includes(SCAN_ROOT)) candidateDirs.unshift(SCAN_ROOT);
  const dirs = [];
  for (const d of candidateDirs) {
    if (!fs.existsSync(d)) continue;
    try {
      const duOut = execSync(`du -sk "${d}" 2>/dev/null`, { timeout: 4000 }).toString().trim().split(/\s+/);
      const bytes = (parseInt(duOut[0], 10) || 0) * 1024;
      dirs.push({ path: d, bytes });
    } catch {}
  }
  dirs.sort((a, b) => b.bytes - a.bytes);

  // 3. Project breakdown under SCAN_ROOT
  const projects = [];
  try {
    const list = getGitProjects();
    for (const p of list.slice(0, 15)) {
      try {
        const duOut = execSync(`du -sk "${p.path}" 2>/dev/null`, { timeout: 3000 }).toString().trim().split(/\s+/);
        const totalBytes = (parseInt(duOut[0], 10) || 0) * 1024;
        let storageLogsBytes = 0;
        const logDir = path.join(p.path, 'storage', 'logs');
        if (fs.existsSync(logDir)) {
          try {
            const lOut = execSync(`du -sk "${logDir}" 2>/dev/null`, { timeout: 2000 }).toString().trim().split(/\s+/);
            storageLogsBytes = (parseInt(lOut[0], 10) || 0) * 1024;
          } catch {}
        }
        projects.push({
          name: p.name,
          relPath: p.relPath,
          bytes: totalBytes,
          logsBytes: storageLogsBytes,
        });
      } catch {}
    }
    projects.sort((a, b) => b.bytes - a.bytes);
  } catch {}

  // 4. System Caches (journald, apt archives, docker)
  let journaldBytes = null;
  try {
    const jOut = execSync('journalctl --disk-usage 2>/dev/null', { timeout: 2000 }).toString();
    const m = jOut.match(/take up\s+([0-9.]+)([KMGT]?)/i);
    if (m) {
      const val = parseFloat(m[1]);
      const unit = (m[2] || 'M').toUpperCase();
      const mult = unit === 'G' ? 1024 ** 3 : (unit === 'M' ? 1024 ** 2 : (unit === 'K' ? 1024 : 1));
      journaldBytes = Math.round(val * mult);
    }
  } catch {}

  let aptCacheBytes = null;
  if (fs.existsSync('/var/cache/apt/archives')) {
    try {
      const du = execSync('du -sk /var/cache/apt/archives 2>/dev/null', { timeout: 2000 }).toString().trim().split(/\s+/);
      aptCacheBytes = (parseInt(du[0], 10) || 0) * 1024;
    } catch {}
  }

  let dockerBytes = null;
  if (fs.existsSync('/var/lib/docker')) {
    try {
      const du = execSync('du -sk /var/lib/docker 2>/dev/null', { timeout: 2000 }).toString().trim().split(/\s+/);
      dockerBytes = (parseInt(du[0], 10) || 0) * 1024;
    } catch {}
  }

  // 5. Large Logs Hotspots (> 2MB)
  const largeLogs = [];
  try {
    const scanPaths = ['/var/log'];
    if (SCAN_ROOT && fs.existsSync(SCAN_ROOT)) scanPaths.push(SCAN_ROOT);
    const cmd = `find ${scanPaths.map(x => `"${x}"`).join(' ')} -maxdepth 5 -type f -name '*.log*' -size +2M -printf '%s %p\\n' 2>/dev/null | sort -nr | head -n 12`;
    const out = execSync(cmd, { timeout: 3000 }).toString().trim();
    if (out) {
      for (const l of out.split('\n')) {
        const parts = l.trim().split(/\s+/);
        if (parts.length >= 2) {
          const b = parseInt(parts[0], 10) || 0;
          const full = parts.slice(1).join(' ');
          const isProj = Boolean(SCAN_ROOT && full.startsWith(SCAN_ROOT));
          const rel = isProj ? path.relative(SCAN_ROOT, full) : full;
          largeLogs.push({ bytes: b, path: rel, isProject: isProj });
        }
      }
    }
  } catch {}

  const result = {
    time: now,
    mounts,
    dirs,
    projects,
    scanRoot: SCAN_ROOT,
    caches: {
      journald: journaldBytes,
      apt: aptCacheBytes,
      docker: dockerBytes,
    },
    largeLogs,
    io: getDiskIO(),
  };
  storageCache = { time: now, data: result };
  return result;
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

function osName() {
  try {
    const f = fs.readFileSync('/etc/os-release', 'utf8');
    const m = f.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    if (m) return m[1];
  } catch {}
  return os.type() + ' ' + os.release();
}

function getStats() {
  const mem = memInfo();
  const disk = diskInfo();
  const load = os.loadavg();
  return {
    time: Date.now(),
    hostname: os.hostname(),
    os: osName(),
    uptime: os.uptime(),
    load: { l1: load[0], l5: load[1], l15: load[2] },
    cpu: { pct: Number(cpuPercent().toFixed(1)), cores: os.cpus().length, model: (os.cpus()[0] || {}).model || '' },
    mem: { ...mem, pct: Number(mem.pct.toFixed(1)) },
    disk: { ...disk, pct: Number(disk.pct.toFixed(1)) },
    net: netInfo(),
    io: getDiskIO(),
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

const SERVICES = ['nginx', 'mysql', 'php8.4-fpm', 'mosquitto', 'redis-server', 'ssh', 'cron', 'supervisor'];
function getServices() {
  const out = SERVICES.map((s) => {
    try {
      // Jangan pakai 2>/dev/null saja: systemctl exit !=0 saat inactive sehingga execSync throw
      // dan status jadi 'unknown'. Pakai || true agar output 'inactive' tetap terbaca.
      const st = execSync(`systemctl is-active ${s} 2>&1 || true`, { timeout: 2000 }).toString().trim().split('\n')[0].trim();
      if (!st) return { name: s, active: false, status: 'unknown' };
      return { name: s, active: st === 'active', status: st };
    } catch {
      return { name: s, active: false, status: 'unknown' };
    }
  });
  return out;
}

// ---- workers (supervisor + cron + laravel logs) ----
const SUPERVISOR_CONF_DIRS = ['/etc/supervisor/conf.d', '/etc/supervisor.d', '/etc/supervisord.d', '/etc/supervisor'];
const LARAVEL_LOG_CANDIDATES = (process.env.LARAVEL_LOGS || '').split(',').map((s) => s.trim()).filter(Boolean);

function parseSupervisorConf(file) {
  let progs = [];
  try {
    const txt = fs.readFileSync(file, 'utf8');
    let cur = null;
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*\[program:(.+?)\]/);
      if (m) { cur = { name: m[1].trim(), file, command: '', logfile: '' }; progs.push(cur); continue; }
      if (!cur) continue;
      const cm = line.match(/^\s*command\s*=\s*(.+)/);
      if (cm) cur.command = cm[1].trim();
      const lm = line.match(/^\s*stdout_logfile\s*=\s*(.+)/);
      if (lm) cur.logfile = lm[1].trim();
    }
  } catch {}
  return progs;
}

function getSupervisorProgs() {
  let progs = [];
  for (const d of SUPERVISOR_CONF_DIRS) {
    try {
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.conf') && !f.endsWith('.ini')) continue;
        progs = progs.concat(parseSupervisorConf(path.join(d, f)));
      }
    } catch {}
  }
  // also pick up laravel projects with workers even without supervisor conf
  for (const p of getGitProjects()) {
    if (fs.existsSync(path.join(p.path, 'artisan')) && !progs.some((x) => x.name === p.name)) {
      progs.push({ name: p.name + ' (queue)', file: p.path, command: 'php artisan queue:work', logfile: path.join(p.path, 'storage', 'logs', 'laravel.log') });
    }
  }
  return progs;
}

function getSupervisorStatus() {
  return new Promise((resolve) => {
    exec('supervisorctl status 2>&1', { timeout: 5000 }, (err, stdout) => {
      const procs = [];
      if (stdout) {
        for (const line of stdout.trim().split('\n')) {
          const m = line.match(/^(\S+)\s+(\S+)(.*)$/);
          if (!m) continue;
          procs.push({ name: m[1], state: m[2], detail: m[3].trim().slice(0, 120) });
        }
      }
      const confs = getSupervisorProgs();
      // merge: supervisorctl output wins; conf yang tidak ada di output berarti belum di-load supervisor
      // (misal project Laravel tanpa conf) → tandai 'NO CONF' bukan 'UNKNOWN' agar jelas.
      for (const c of confs) {
        if (!procs.some((p) => p.name === c.name || p.name.startsWith(c.name + ':'))) {
          procs.push({ name: c.name, state: 'NO CONF', detail: (c.command || '').slice(0, 120) + ' — belum ada conf supervisor, restart via service tidak berlaku', logfile: c.logfile });
        }
      }
      // attach logfile + running pid from conf
      for (const p of procs) {
        const c = confs.find((x) => x.name === p.name || p.name.startsWith(x.name + ':'));
        if (c && c.logfile) p.logfile = c.logfile;
        if (!p.logfile && p.detail && /logfile=(\S+)/.test(p.detail)) p.logfile = p.detail.match(/logfile=(\S+)/)[1];
      }
      resolve({ available: !err || (stdout && stdout.trim().length > 0), procs });
    });
  });
}

function parseCronLine(line, user) {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  const m = t.match(/^(@\w+|\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
  if (!m) return null;
  return { user, schedule: m[1], cmd: m[2] };
}

function getCronJobs() {
  const jobs = [];
  try {
    const users = new Set(['root', 'www-data']);
    try { users.add(os.userInfo().username); } catch {}
    try {
      for (const row of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
        const f = row.split(':');
        if (f.length >= 3) {
          const uid = parseInt(f[2], 10);
          if ((uid >= 1000 || uid === 0 || f[0] === 'www-data') && f[0]) users.add(f[0]);
        }
      }
    } catch {}
    for (const u of users) {
      try {
        const out = execSync(`crontab -u ${u} -l 2>/dev/null`, { timeout: 3000 }).toString();
        for (const line of out.split('\n')) {
          const j = parseCronLine(line, u);
          if (j) jobs.push({ ...j, source: 'crontab:' + u });
        }
      } catch {}
    }
    // Also parse /etc/crontab (format: min hour dom mon dow user cmd)
    try {
      if (fs.existsSync('/etc/crontab')) {
        for (const line of fs.readFileSync('/etc/crontab', 'utf8').split('\n')) {
          const t = line.trim();
          if (!t || t.startsWith('#')) continue;
          const m = t.match(/^(@\w+|\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S+)\s+(.+)$/);
          if (m && !['root', 'daemon'].includes(m[2]) || (m && /artisan|backup|worker|php|python/i.test(m[3]))) {
            jobs.push({ user: m[2], schedule: m[1], cmd: m[3], source: 'system:/etc/crontab' });
          }
        }
      }
    } catch {}
  } catch {}
  // detect artisan schedule:run workers liveness via ps
  let schedProcs = [];
  try {
    const ps = execSync('ps aux 2>/dev/null | grep -E "artisan (schedule:run|queue:work|horizon)" | grep -v grep', { timeout: 3000 }).toString().trim();
    if (ps) schedProcs = ps.split('\n').slice(0, 10);
  } catch {}
  return { jobs, schedProcs };
}

// ---- laravel schedule:list (apa sebenarnya yang dijalankan tiap `schedule:run`) ----
const scheduleCache = new Map(); // dir -> { time, data }
function cronArtisanDirs() {
  const dirs = new Set();
  for (const j of getCronJobs().jobs) {
    const m = String(j.cmd).match(/cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*&&.*artisan\s+schedule:run/);
    const d = m && (m[1] || m[2] || m[3]);
    if (d && fs.existsSync(path.join(d, 'artisan'))) dirs.add(d);
  }
  return dirs;
}
function parseScheduleList(out) {
  const tasks = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*?)\s*\.{2,}\s*(?:Next Due:\s*)?(.*)$/);
    if (m) tasks.push({ expr: m[1], cmd: m[2].trim(), next: m[3].trim() });
  }
  return tasks;
}
function getScheduleList(dir) {
  const hit = scheduleCache.get(dir);
  if (hit && Date.now() - hit.time < 60_000) return Promise.resolve(hit.data);
  return new Promise((resolve) => {
    let uid = null;
    const me = typeof process.getuid === 'function' ? process.getuid() : null;
    try { uid = fs.statSync(dir).uid; } catch {}
    const artisan = path.join(dir, 'artisan');
    const cmd = (uid !== null && uid !== me)
      ? `sudo -H -u "#${uid}" php "${artisan}" schedule:list --no-ansi 2>&1`
      : `php "${artisan}" schedule:list --no-ansi 2>&1`;
    exec(cmd, { timeout: 25_000, cwd: dir, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      const raw = String(stdout || '').trim();
      const data = { dir, name: path.basename(dir), ok: !err, raw: raw.slice(0, 8000), tasks: err ? [] : parseScheduleList(raw) };
      if (err) data.error = (raw.split('\n').filter(Boolean).pop() || err.message).slice(0, 300);
      scheduleCache.set(dir, { time: Date.now(), data });
      resolve(data);
    });
  });
}
async function getAllSchedules() {
  const dirs = [...cronArtisanDirs()];
  const out = [];
  for (let i = 0; i < dirs.length; i += 3) { // maks 3 paralel supaya scan tidak bikin spike CPU sendiri
    out.push(...await Promise.all(dirs.slice(i, i + 3).map(getScheduleList)));
  }
  return out;
}

function updateCronSchedule(user, oldSchedule, newSchedule, cmd, source) {
  return new Promise((resolve) => {
    if (source && String(source).startsWith('system:')) {
      return resolve({ ok: false, error: 'Job ini dari ' + source + ' (system cron). Edit via SSH sebagai root, misal: sudo nano ' + source.replace('system:', '') });
    }
    if (!user || typeof user !== 'string' || !/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user)) {
      return resolve({ ok: false, error: 'Invalid user' });
    }
    const cleanSched = (newSchedule || '').trim();
    if (!/^(@\w+|\S+\s+\S+\s+\S+\s+\S+\s+\S+)$/.test(cleanSched)) {
      return resolve({ ok: false, error: 'Invalid cron format (must be 5 fields, e.g. */5 * * * *)' });
    }
    let current;
    try {
      current = execSync(`crontab -u ${user} -l 2>/dev/null`).toString();
    } catch (e) {
      return resolve({ ok: false, error: 'Cannot read crontab for user ' + user });
    }
    const lines = current.split('\n');
    let replaced = false;
    const cleanCmd = (cmd || '').trim();
    const newLines = lines.map((l) => {
      const trimmed = l.trim();
      if (!replaced && !trimmed.startsWith('#') && trimmed.includes(cleanCmd)) {
        replaced = true;
        return `${cleanSched} ${cleanCmd}`;
      }
      return l;
    });

    if (!replaced) {
      // Beri pesan spesifik bila job ternyata milik system file (umum: semua job yang tampil saat ini dari /etc/crontab).
      try {
        if (fs.existsSync('/etc/crontab') && fs.readFileSync('/etc/crontab', 'utf8').includes(cleanCmd.slice(0, 40))) {
          return resolve({ ok: false, error: 'Job tidak ada di crontab -u ' + user + '. Kemungkinan ini system cron (/etc/crontab). Edit via SSH sebagai root.' });
        }
      } catch {}
      return resolve({ ok: false, error: 'Cron job command not found in crontab' });
    }

    try {
      const child = exec(`crontab -u ${user} -`, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: (stderr || err.message).trim() });
        resolve({ ok: true, output: `Schedule updated to ${cleanSched}` });
      });
      child.stdin.write(newLines.join('\n'));
      child.stdin.end();
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

function tailLog(file, lines = 100) {
  return new Promise((resolve) => {
    if (!file || typeof file !== 'string' || file.includes('\0')) return resolve({ ok: false, error: 'Invalid log path' });
    const norm = path.normalize(file);
    if (!path.isAbsolute(norm)) return resolve({ ok: false, error: 'Log path must be absolute' });
    const allow = /^(\/var\/log\/|\/home\/[^/]+\/|\/var\/www\/|\/tmp\/)/.test(norm);
    if (!allow) return resolve({ ok: false, error: 'Log path not allowed' });
    exec(`tail -n ${Math.min(500, Math.max(10, parseInt(lines, 10) || 100))} "${norm.replace(/"/g, '')}" 2>&1`, { timeout: 5000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (!fs.existsSync(norm)) return resolve({ ok: false, error: 'Log file not found: ' + norm });
      resolve({ ok: true, path: norm, output: (stdout || '').slice(-20000) });
    });
  });
}

function laravelLogPaths() {
  const paths = [...LARAVEL_LOG_CANDIDATES];
  for (const p of getGitProjects()) {
    const f = path.join(p.path, 'storage', 'logs', 'laravel.log');
    if (fs.existsSync(f) && !paths.includes(f)) paths.push(f);
  }
  return paths.slice(0, 20);
}

function restartServiceUnit(unit) {
  return new Promise((resolve) => {
    const allow = ['cron', 'supervisor', 'supervisord'];
    if (!allow.includes(unit)) return resolve({ ok: false, error: 'Unit not allowed' });
    exec(`systemctl restart ${unit} 2>&1`, { timeout: 15000 }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '');
      if (err) return resolve({ ok: false, error: err.message, output: out });
      resolve({ ok: true, output: out || `systemctl restart ${unit} ok` });
    });
  });
}

function supervisorAction(action, name) {
  return new Promise((resolve) => {
    if (!['restart', 'start', 'stop'].includes(action)) return resolve({ ok: false, error: 'Invalid action' });
    if (typeof name !== 'string' || !name || /[;&|$()`\\]/.test(name) || name.length > 128) return resolve({ ok: false, error: 'Invalid program name' });
    exec(`supervisorctl ${action} "${name}" 2>&1`, { timeout: 15000 }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '');
      if (err && /ERROR|FATAL|no such/i.test(out)) return resolve({ ok: false, error: err.message, output: out });
      resolve({ ok: !err, output: out });
    });
  });
}

// ---- git projects scanner ----
let gitCache = { time: 0, projects: [] };

function scanGitDirs(baseDir, maxDepth = 6) {
  const repos = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && e.name === '.git') {
        repos.push(dir);
        return;
      }
    }
    for (const e of entries) {
      if (e.isDirectory() && !['node_modules', 'vendor', '.cache', 'storage', 'wp-includes', 'wp-admin'].includes(e.name)) {
        walk(path.join(dir, e.name), depth + 1);
      }
    }
  }
  walk(baseDir, 1);
  return repos;
}

function gitCmdFor(dir, args) {
  let uid = null;
  try { uid = fs.statSync(dir).uid; } catch {}
  const me = (typeof process.getuid === 'function') ? process.getuid() : 0;
  if (uid !== null && uid !== me) return `sudo -H -u "#${uid}" git -C "${dir}" ${args}`;
  return `git -C "${dir}" ${args}`;
}

function ensureFilemodeFalse(dir) {
  try { execSync(gitCmdFor(dir, 'config core.filemode false 2>/dev/null'), { timeout: 2000 }); } catch {}
}

// Superadmin melihat semuanya; user lain: keyword global + keyword miliknya sendiri.
function hiddenKeywordsFor(session) {
  if (!session || session.superadmin) return [];
  return [...new Set([...GLOBAL_HIDDEN_KEYWORDS, ...(session.hiddenKeywords || [])])];
}
// true bila nilai (string, atau objek yang di-JSON-kan) mengandung salah satu keyword.
function isHidden(session, value) {
  const kws = hiddenKeywordsFor(session);
  if (!kws.length || value == null) return false;
  const s = (typeof value === 'string' ? value : JSON.stringify(value)).toLowerCase();
  return kws.some((k) => s.includes(k));
}

function getGitProjects(force = false) {
  const now = Date.now();
  if (!force && gitCache.time && (now - gitCache.time < 30_000)) return gitCache.projects;
  const dirs = scanGitDirs(SCAN_ROOT, 6);
  const projects = dirs.map((d) => {
    const rel = path.relative(SCAN_ROOT, d);
    const name = path.basename(d);
    const parts = rel.split(path.sep);
    const group = parts.length > 1 ? parts[0] : 'Projects';
    const base = { name, group, relPath: rel, path: d, remote: '', lastPull: null };
    try {
      ensureFilemodeFalse(d);
    } catch {}
    // rev-parse dulu: kalau gagal (repo rusak / permission), tetap tampilkan sebagai BROKEN
    // supaya tidak hilang misterius dari panel.
    let branch = 'unknown';
    try {
      branch = execSync(gitCmdFor(d, 'rev-parse --abbrev-ref HEAD 2>/dev/null'), { timeout: 2000 }).toString().trim() || 'unknown';
    } catch (e) {
      return { ...base, branch: 'BROKEN', hash: '—', time: '—', message: 'git repo tidak bisa dibaca (' + String((e && e.message) || e).slice(0, 100) + ')', dirty: false, broken: true };
    }
    try {
      const log = execSync(gitCmdFor(d, 'log -1 --format="%h|%cr|%s" 2>/dev/null'), { timeout: 2000 }).toString().trim().split('|');
      const dirty = execSync(gitCmdFor(d, 'status --porcelain 2>/dev/null'), { timeout: 2000 }).toString().trim().length > 0;
      let remote = '';
      try { remote = execSync(gitCmdFor(d, 'remote get-url origin 2>/dev/null'), { timeout: 1500 }).toString().trim(); } catch {}
      let lastPull = null;
      try {
        const fetchHead = path.join(d, '.git', 'FETCH_HEAD');
        if (fs.existsSync(fetchHead)) {
          lastPull = fs.statSync(fetchHead).mtimeMs;
        } else {
          const ct = execSync(gitCmdFor(d, 'log -1 --format="%ct" 2>/dev/null'), { timeout: 1500 }).toString().trim();
          if (ct) lastPull = parseInt(ct, 10) * 1000;
        }
      } catch {}
      return { ...base, branch, hash: log[0] || '—', time: log[1] || '—', message: log[2] || '—', dirty, remote, lastPull };
    } catch (e) {
      return { ...base, branch, hash: '—', time: '—', message: 'git repo error (' + String((e && e.message) || e).slice(0, 100) + ')', dirty: false, remote: '', lastPull: null, broken: true };
    }
  }).filter(Boolean);
  gitCache = { time: now, projects };
  return projects;
}

// Validasi relPath project git (whitelist) dan kembalikan { full, uid, me } atau { error }.
function resolveGitProject(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('..') || rel.startsWith('/')) return { error: 'Invalid project' };
  const full = path.normalize(path.join(SCAN_ROOT, rel));
  if (!full.startsWith(SCAN_ROOT + path.sep) && full !== SCAN_ROOT) return { error: 'Invalid project' };
  if (!getGitProjects().some((p) => p.path === full)) return { error: 'Project not in verified whitelist' };
  if (!fs.existsSync(path.join(full, 'artisan'))) return { error: 'Bukan project Laravel (artisan tidak ditemukan)' };
  let uid = null;
  try { uid = fs.statSync(full).uid; } catch {}
  const me = (typeof process.getuid === 'function') ? process.getuid() : 0;
  return { full, uid, me };
}

// Daftar seeder (class) di database/seeders, termasuk subfolder.
function listSeeders(dir) {
  const root = path.join(dir, 'database', 'seeders');
  const out = [];
  const walk = (d, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(d, e.name), prefix + e.name + '\\');
      else if (/^[A-Za-z0-9_]+\.php$/.test(e.name)) out.push(prefix + e.name.slice(0, -4));
    }
  };
  walk(root, '');
  return out.sort((a, b) => a.localeCompare(b));
}

async function runSeeders(rel, classes) {
  const pr = resolveGitProject(rel);
  if (pr.error) return { ok: false, error: pr.error };
  const available = new Set(listSeeders(pr.full));
  if (!Array.isArray(classes) || !classes.length) return { ok: false, error: 'Pilih minimal satu seeder' };
  for (const c of classes) if (typeof c !== 'string' || !available.has(c)) return { ok: false, error: `Seeder tidak valid: ${c}` };
  let output = '';
  let allOk = true;
  for (const c of classes) {
    // Subfolder -> namespace Database\Seeders\Sub\Class; root seeder tetap class name saja.
    const cls = c.includes('\\') ? `Database\\Seeders\\${c}` : c;
    const args = [path.join(pr.full, 'artisan'), 'db:seed', `--class=${cls}`, '--force'];
    const r = (pr.uid !== null && pr.uid !== pr.me)
      ? await runFile('sudo', ['-H', '-u', `#${pr.uid}`, 'php', ...args], { cwd: pr.full, timeout: 120000 })
      : await runFile('php', args, { cwd: pr.full, timeout: 120000 });
    output += `\n--- php artisan db:seed --class=${cls} ${r.ok ? '' : '[FAILED] '}---\n${r.output || r.error || ''}\n`;
    if (!r.ok) { allOk = false; break; }
  }
  return { ok: allOk, output: output.trim() };
}

// Jalankan perintah shell di folder project sebagai owner folder (sama seperti git pull / artisan).
function runInProject(pr, script, timeout) {
  const env = { COMPOSER_ALLOW_SUPERUSER: '1', COMPOSER_NO_INTERACTION: '1', TERM: 'dumb', NO_COLOR: '1' };
  return (pr.uid !== null && pr.uid !== pr.me)
    ? runFile('sudo', ['-H', '-u', `#${pr.uid}`, 'bash', '-c', script], { cwd: pr.full, timeout, env })
    : runFile('bash', ['-c', script], { cwd: pr.full, timeout, env });
}

async function runComposerUpdate(rel) {
  const pr = resolveGitProject(rel);
  if (pr.error) return { ok: false, error: pr.error };
  if (!fs.existsSync(path.join(pr.full, 'composer.json'))) return { ok: false, error: 'composer.json tidak ditemukan' };
  const r = await runInProject(pr, 'composer update --no-interaction --no-progress 2>&1', 300_000);
  return { ok: r.ok, output: `$ composer update\n${r.output || r.error || ''}`.trim(), error: r.ok ? undefined : (r.error || 'composer update gagal') };
}

async function runTerminalCommand(rel, command) {
  const pr = resolveGitProject(rel);
  if (pr.error) return { ok: false, error: pr.error };
  if (typeof command !== 'string' || !command.trim() || command.length > 2000) return { ok: false, error: 'Perintah tidak valid' };
  const r = await runInProject(pr, `${command} 2>&1`, 60_000);
  return { ok: r.ok, output: r.output || r.error || '', error: r.ok ? undefined : r.error };
}

function readProjectEnv(rel) {
  const pr = resolveGitProject(rel);
  if (pr.error) return { ok: false, error: pr.error };
  const f = path.join(pr.full, '.env');
  try { return { ok: true, content: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '', exists: fs.existsSync(f) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Simpan .env (in-place agar owner/mode tetap), lalu php artisan optimize:clear.
async function saveProjectEnv(rel, content) {
  const pr = resolveGitProject(rel);
  if (pr.error) return { ok: false, error: pr.error };
  if (typeof content !== 'string' || content.length > 256 * 1024) return { ok: false, error: 'Konten .env tidak valid / terlalu besar' };
  const f = path.join(pr.full, '.env');
  let output = '';
  try {
    const existed = fs.existsSync(f);
    if (existed) { try { fs.copyFileSync(f, f + '.bak'); } catch {} }
    fs.writeFileSync(f, content);
    if (!existed && pr.uid !== null && pr.uid !== pr.me) { try { fs.chownSync(f, pr.uid, fs.statSync(pr.full).gid); } catch {} }
    output += '.env tersimpan\n';
  } catch (e) {
    return { ok: false, error: 'Gagal menyimpan .env: ' + e.message };
  }
  const args = [path.join(pr.full, 'artisan'), 'optimize:clear'];
  const r = (pr.uid !== null && pr.uid !== pr.me)
    ? await runFile('sudo', ['-H', '-u', `#${pr.uid}`, 'php', ...args], { cwd: pr.full, timeout: 60000 })
    : await runFile('php', args, { cwd: pr.full, timeout: 60000 });
  output += `\n--- php artisan optimize:clear ${r.ok ? '' : '[FAILED] '}---\n${r.output || r.error || ''}`;
  return { ok: r.ok, output: output.trim() };
}

function pullGitProject(targetPath) {
  return new Promise((resolve) => {
    const list = getGitProjects();
    const match = list.find((p) => p.path === targetPath);
    if (!match) return resolve({ ok: false, error: 'Project not in verified whitelist' });
    // Run git as dir owner so private https (credential.store) and ssh keys work.
    // App runs as root (for unix_chkpwd) but root has no git credentials.
    let uid = null;
    try { uid = fs.statSync(targetPath).uid; } catch {}
    const me = (typeof process.getuid === 'function') ? process.getuid() : 0;
    const gitCmd = (uid !== null && uid !== me)
      ? `sudo -H -u "#${uid}" git -C "${targetPath}" pull`
      : `git -C "${targetPath}" pull`;
    ensureFilemodeFalse(targetPath);
    const runFix = (out) => {
      let combined = out;
      try {
        const isLaravel = fs.existsSync(path.join(targetPath, 'artisan'));
        const isWP = fs.existsSync(path.join(targetPath, 'wp-load.php'));
        
        // Laravel post-update tasks: migrate + Spatie permission seed + optimize:clear
        if (isLaravel) {
          const artisanCmd = (cmd) => (uid !== null && uid !== me)
            ? `sudo -H -u "#${uid}" php "${path.join(targetPath, 'artisan')}" ${cmd}`
            : `php "${path.join(targetPath, 'artisan')}" ${cmd}`;
          
          try {
            const migOut = execSync(`${artisanCmd('migrate --force')} 2>&1`, { timeout: 45_000, cwd: targetPath }).toString();
            combined += '\n--- php artisan migrate --force ---\n' + migOut;
          } catch (mErr) {
            combined += '\n--- php artisan migrate --force [FAILED] ---\n' + (mErr.stdout || mErr.message);
          }

          // Auto-detect Spatie permission seeders (tanpa perlu rename file di project)
          try {
            const seedersDir = path.join(targetPath, 'database', 'seeders');
            if (fs.existsSync(seedersDir)) {
              const files = fs.readdirSync(seedersDir);
              const matches = files.filter((f) => /^(roles?|permissions?|roles?.*permissions?|permissions?.*roles?)seeder\.php$/i.test(f));
              for (const seederFile of matches) {
                const className = path.basename(seederFile, '.php');
                try {
                  const sOut = execSync(`${artisanCmd(`db:seed --class=${className} --force`)} 2>&1`, { timeout: 45_000, cwd: targetPath }).toString();
                  combined += `\n--- php artisan db:seed --class=${className} --force ---\n` + sOut;
                } catch (sErr) {
                  combined += `\n--- php artisan db:seed --class=${className} [FAILED] ---\n` + (sErr.stdout || sErr.message);
                }
              }
            }
          } catch {}

          // Spatie permission cache reset
          try {
            const pReset = execSync(`${artisanCmd('permission:cache-reset')} 2>&1`, { timeout: 20_000, cwd: targetPath }).toString();
            if (pReset && !/there are no commands/i.test(pReset)) {
              combined += '\n--- php artisan permission:cache-reset ---\n' + pReset;
            }
          } catch {}

          try {
            const optOut = execSync(`${artisanCmd('optimize:clear')} 2>&1`, { timeout: 30_000, cwd: targetPath }).toString();
            combined += '\n--- php artisan optimize:clear ---\n' + optOut;
          } catch (oErr) {
            combined += '\n--- php artisan optimize:clear [FAILED] ---\n' + (oErr.stdout || oErr.message);
          }
        }

        // Auto-fix permissions agar CRUD dan webserver tidak 500
        if (isLaravel || isWP) {
          let owner = null;
          try { owner = execSync(`id -nu ${uid} 2>/dev/null`, { timeout: 2000 }).toString().trim(); } catch {}
          if (owner && uid !== null && fs.existsSync('/var/www/fix-permissions.sh')) {
            const fixOut = execSync(`bash /var/www/fix-permissions.sh "${targetPath}" --user "${owner}" 2>&1`, { timeout: 30_000 }).toString();
            combined += '\n--- fix-permissions ---\n' + fixOut;
          }
        }
      } catch (fErr) {
        combined += '\n--- post-update error ---\n' + fErr.message;
      }
      return { ok: true, output: combined };
    };
    exec(gitCmd, { timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      gitCache.time = 0; // invalidate cache
      const out = (stdout || '') + (stderr || '');
      if (!err) return resolve(runFix(out));
      // Jika gagal karena local changes (umumnya sisa mode/permission, bukan edit beneran),
      // amankan dulu via stash lalu coba pull sekali lagi. Tidak pakai reset --hard agar tidak hapus kerjaan.
      // Repo nyangkut di state conflict (unmerged files / merge atau rebase belum selesai, mis. sisa pull/stash pop gagal).
      // Recovery non-destruktif: abort merge/rebase, `git reset` (mixed) hanya membersihkan index — isi file working tree
      // (termasuk conflict marker) tetap ada dan ikut di-stash di bawah, jadi tidak ada kerjaan yang hilang.
      const stuck = /unmerged files|unresolved conflict|not concluded your merge|rebase in progress|You are in the middle of/i.test(out);
      if (stuck || /would be overwritten|local changes|Your local changes|stash your changes/i.test(out)) {
        const asOwner = (a) => (uid !== null && uid !== me)
          ? `sudo -H -u "#${uid}" git -C "${targetPath}" ${a}`
          : `git -C "${targetPath}" ${a}`;
        const stashCmd = asOwner(`stash push --include-untracked -m "auto-panel ${new Date().toISOString()}"`);
        let prep = '';
        if (stuck) {
          for (const a of ['merge --abort', 'rebase --abort', 'cherry-pick --abort', 'reset']) {
            try { prep += `$ git ${a}\n` + execSync(`${asOwner(a)} 2>&1`, { timeout: 15_000 }).toString() + '\n'; }
            catch (e) { prep += `$ git ${a} [skip]\n`; }
          }
        }
        exec(stashCmd, { timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (serr, sstdout, sstderr) => {
          const sout = prep + (sstdout || '') + (sstderr || '');
          exec(gitCmd, { timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err2, stdout2, stderr2) => {
            gitCache.time = 0;
            const out2 = out + '\n--- autostash ---\n' + sout + '\n--- retry pull ---\n' + ((stdout2 || '') + (stderr2 || ''));
            if (err2) return resolve({ ok: false, error: err2.message + ' (local changes di-stash otomatis, cek git stash list)', output: out2 });
            return resolve(runFix(out2));
          });
        });
        return;
      }
      return resolve({ ok: false, error: err.message, output: out });
    });
  });
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

function audit(user, action, target, details = '') {
  const ts = new Date().toISOString();
  console.log(`[AUDIT ${ts}] user=${user} action=${action} target=${target}${details ? ' ' + details : ''}`);
  logActivity(user, action, target, details);
}

// ---- Mini File Explorer helpers ----
const FS_TEXT_EXTS = new Set([
  '.txt', '.md', '.json', '.js', '.mjs', '.cjs', '.ts', '.html', '.htm', '.css',
  '.scss', '.sass', '.less', '.xml', '.yaml', '.yml', '.conf', '.config', '.ini',
  '.sh', '.bash', '.php', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp',
  '.h', '.hpp', '.sql', '.env', '.log', '.htaccess', '.service', '.lock', '.svg'
]);

function safeFsPath(p) {
  if (!p || typeof p !== 'string') return SCAN_ROOT;
  if (p.includes('\0')) return null;
  return path.resolve(p);
}

function getFsBookmarks() {
  const b = [
    { name: 'Projects', path: SCAN_ROOT },
    { name: 'Web (/var/www)', path: '/var/www' },
    { name: 'Logs (/var/log)', path: '/var/log' },
    { name: 'Nginx (/etc/nginx)', path: '/etc/nginx' },
    { name: 'Backups (/var/backups)', path: '/var/backups' },
    { name: 'Home (/home)', path: '/home' },
    { name: 'Root (/)', path: '/' },
  ];
  return b.filter((x) => fs.existsSync(x.path));
}

function listFsDirectory(dirPath) {
  const real = safeFsPath(dirPath);
  if (!real || !fs.existsSync(real)) throw new Error('Directory not found');
  const stat = fs.statSync(real);
  if (!stat.isDirectory()) throw new Error('Path is not a directory');

  let raw;
  try {
    raw = fs.readdirSync(real, { withFileTypes: true });
  } catch (err) {
    throw new Error('Permission denied or unreadable directory');
  }

  const entries = [];
  for (const item of raw) {
    const full = path.join(real, item.name);
    let s = null;
    try { s = fs.statSync(full); } catch {}
    const isDir = item.isDirectory();
    entries.push({
      name: item.name,
      isDir,
      isSymlink: item.isSymbolicLink(),
      size: s ? s.size : 0,
      mtime: s ? s.mtimeMs : 0,
      mode: s ? (s.mode & 0o777).toString(8) : '---',
      ext: isDir ? '' : path.extname(item.name).toLowerCase(),
    });
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const parent = real === path.dirname(real) ? null : path.dirname(real);
  return {
    current: real,
    parent,
    entries,
    bookmarks: getFsBookmarks(),
  };
}

function readFsFile(filePath, maxBytes = 524_288) {
  const real = safeFsPath(filePath);
  if (!real || !fs.existsSync(real)) throw new Error('File not found');
  const stat = fs.statSync(real);
  if (stat.isDirectory()) throw new Error('Path is a directory, not a file');

  const ext = path.extname(real).toLowerCase();
  const fd = fs.openSync(real, 'r');
  const buf = Buffer.alloc(Math.min(stat.size, maxBytes));
  const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);

  let isText = FS_TEXT_EXTS.has(ext) || path.basename(real).startsWith('.');
  if (!isText) {
    // Check first 512 bytes for null byte
    let nullFound = false;
    for (let i = 0; i < Math.min(bytesRead, 512); i++) {
      if (buf[i] === 0) { nullFound = true; break; }
    }
    isText = !nullFound;
  }

  return {
    path: real,
    name: path.basename(real),
    size: stat.size,
    mtime: stat.mtimeMs,
    isText,
    truncated: stat.size > maxBytes,
    content: isText ? buf.slice(0, bytesRead).toString('utf8') : null,
  };
}

// ---- Backup Monitoring & Download helpers ----
// Lokasi netral (tidak di home user mana pun agar awet walau akun dihapus).
// Set BACKUP_DIR di ecosystem.config.js bila beda lokasi.
const BACKUP_CANDIDATES = [
  process.env.BACKUP_DIR,
  '/var/backups/mysql'
].filter(Boolean);

function getBackupRootDir() {
  for (const c of BACKUP_CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function getBackupInfo() {
  const root = getBackupRootDir();
  if (!root) {
    return {
      available: false,
      root: null,
      totalFiles: 0,
      totalBytes: 0,
      latestTime: null,
      categories: { daily: 0, weekly: 0, monthly: 0, other: 0 },
      files: [],
      logTail: null,
      canRun: false,
    };
  }

  const files = [];
  let totalBytes = 0;
  let latestTime = null;
  const categories = { daily: 0, weekly: 0, monthly: 0, other: 0 };

  function scanFolder(dir, category) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && dir === root) {
        const cat = ['daily', 'weekly', 'monthly'].includes(e.name.toLowerCase()) ? e.name.toLowerCase() : 'other';
        scanFolder(full, cat);
      } else if (e.isFile()) {
        if (e.name === 'backup.log' || e.name.startsWith('.')) continue;
        if (!/\.(sql|gz|tar|tgz|zip|dump|bak)$/i.test(e.name)) continue;
        let s = null;
        try { s = fs.statSync(full); } catch {}
        if (!s) continue;

        totalBytes += s.size;
        if (!latestTime || s.mtimeMs > latestTime) latestTime = s.mtimeMs;

        const cat = category || 'other';
        categories[cat] = (categories[cat] || 0) + 1;

        // Extract clean DB name from pattern (e.g. "bfin_db_backup12okt2026-DAILY.sql.gz" -> "bfin_db")
        let dbName = e.name.replace(/_backup\d+.*$/i, '').replace(/_\d{8}_\d{6}.*$/i, '').replace(/\.(sql|gz|tar|tgz|zip|dump|bak).*$/i, '');
        if (!dbName || dbName === e.name) dbName = e.name.split('.')[0];

        files.push({
          name: e.name,
          relPath: path.relative(root, full),
          category: cat,
          dbName,
          size: s.size,
          mtime: s.mtimeMs,
        });
      }
    }
  }

  scanFolder(root, null);
  files.sort((a, b) => b.mtime - a.mtime);

  // Read tail of backup.log if exists
  let logTail = null;
  const logFile = path.join(root, 'backup.log');
  if (fs.existsSync(logFile)) {
    try {
      const txt = fs.readFileSync(logFile, 'utf8').trim().split('\n');
      logTail = txt.slice(-60).join('\n');
    } catch {}
  }

  const scriptPath = fs.existsSync('/usr/local/bin/backup-mysql.sh') ? '/usr/local/bin/backup-mysql.sh' : null;

  return {
    available: true,
    root,
    totalFiles: files.length,
    totalBytes,
    latestTime,
    categories,
    files,
    logTail,
    canRun: Boolean(scriptPath),
  };
}

// Daftar database live (selain DB sistem), disaring hidden keywords untuk non-superadmin.
const SYSTEM_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
async function listDatabases(session) {
  const r = await runFile('mysql', ['-BNe', 'SELECT table_schema, ROUND(SUM(data_length+index_length)) FROM information_schema.tables GROUP BY table_schema UNION SELECT schema_name, 0 FROM information_schema.schemata ORDER BY 1'], { timeout: 15000 });
  if (!r.ok) return { ok: false, error: 'Gagal membaca daftar database: ' + r.output.trim().slice(0, 300) };
  const map = new Map();
  for (const line of r.output.split('\n')) {
    const [name, size] = line.split('\t');
    if (!name || !/^[A-Za-z0-9_$.-]+$/.test(name) || SYSTEM_DBS.has(name.toLowerCase())) continue;
    map.set(name, Math.max(map.get(name) || 0, Number(size) || 0));
  }
  const databases = [...map].filter(([n]) => !isHidden(session, n)).map(([name, size]) => ({ name, size })).sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, databases };
}

// Terapkan hidden keywords ke daftar backup: file disaring, total dihitung ulang,
// dan baris log yang menyebut keyword dibuang.
function filterBackupInfo(session, info) {
  if (!info || !info.available || !hiddenKeywordsFor(session).length) return info;
  const files = info.files.filter((f) => !isHidden(session, [f.name, f.relPath, f.dbName]));
  const categories = { daily: 0, weekly: 0, monthly: 0, other: 0 };
  let totalBytes = 0;
  let latestTime = null;
  for (const f of files) {
    categories[f.category] = (categories[f.category] || 0) + 1;
    totalBytes += f.size;
    if (!latestTime || f.mtime > latestTime) latestTime = f.mtime;
  }
  const logTail = info.logTail == null ? null
    : info.logTail.split('\n').filter((l) => !isHidden(session, l)).join('\n');
  return { ...info, files, totalFiles: files.length, totalBytes, latestTime, categories, logTail };
}

// Backup berjalan di background; UI polling /api/backups/status.
// Progress = estimasi dari durasi backup sebelumnya (script tidak melaporkan persen).
const BACKUP_META_FILE = path.join(DATA_DIR, 'backup-meta.json');
const backupJob = { running: false, startedAt: 0, finishedAt: 0, ok: null, output: '', expectedMs: 0 };

function loadBackupExpectedMs() {
  try { return JSON.parse(fs.readFileSync(BACKUP_META_FILE, 'utf8')).lastDurationMs || 0; } catch { return 0; }
}

function startManualBackup() {
  if (backupJob.running) return { ok: true, already: true };
  const script = fs.existsSync('/usr/local/bin/backup-mysql.sh') ? '/usr/local/bin/backup-mysql.sh' : null;
  if (!script) return { ok: false, error: 'Script /usr/local/bin/backup-mysql.sh tidak ditemukan' };

  let uid = null;
  try { uid = fs.statSync(script).uid; } catch {}
  const me = (typeof process.getuid === 'function') ? process.getuid() : 0;
  const cmd = (uid !== null && uid !== me)
    ? `sudo -H -u "#${uid}" bash "${script}" --cron 2>&1`
    : `bash "${script}" --cron 2>&1`;

  Object.assign(backupJob, { running: true, startedAt: Date.now(), finishedAt: 0, ok: null, output: '', expectedMs: loadBackupExpectedMs() });
  const child = spawn('bash', ['-c', cmd]);
  const append = (d) => { backupJob.output = (backupJob.output + d.toString()).slice(-20000); };
  const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 180_000);
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (e) => append(e.message));
  child.on('close', (code) => {
    clearTimeout(timer);
    backupJob.running = false;
    backupJob.finishedAt = Date.now();
    backupJob.ok = code === 0;
    if (!backupJob.output) backupJob.output = backupJob.ok ? 'Backup selesai' : `Backup gagal (exit ${code})`;
    if (backupJob.ok) {
      try { fs.writeFileSync(BACKUP_META_FILE, JSON.stringify({ lastDurationMs: backupJob.finishedAt - backupJob.startedAt })); } catch {}
    }
  });
  return { ok: true };
}

function backupStatus() {
  const j = backupJob;
  const elapsed = j.startedAt ? (j.finishedAt || Date.now()) - j.startedAt : 0;
  let percent = null;
  if (j.running && j.expectedMs > 0) percent = Math.min(95, Math.round((elapsed / j.expectedMs) * 100));
  if (!j.running && j.ok) percent = 100;
  return { running: j.running, ok: j.ok, elapsedMs: elapsed, expectedMs: j.expectedMs, percent, output: j.output };
}

// Cari seeder role/permission/user untuk dijalankan setelah migrate fresh.
// Dipakai deploy project baru saja (DB kosong) — skip bila tidak ada.
// TIDAK dipakai di pull flow (data live, seeder user bisa duplikat/reset user).
function detectRoleSeeders(dir) {
  try {
    const seedersDir = path.join(dir, 'database', 'seeders');
    if (!fs.existsSync(seedersDir)) return [];
    const files = fs.readdirSync(seedersDir);
    const isRolePerm = (f) => /^(roles?|permissions?|roles?.*permissions?|permissions?.*roles?)seeder\.php$/i.test(f);
    const isUser = (f) => /^userseeder\.php$/i.test(f);
    const matched = files.filter((f) => isRolePerm(f) || isUser(f));
    // role/permission dulu, user terakhir (user bisa referensi role)
    matched.sort((a, b) => (isUser(a) ? 1 : 0) - (isUser(b) ? 1 : 0));
    return matched.map((f) => path.basename(f, '.php'));
  } catch { return []; }
}

// ---- Auto Deploy (Laravel Git-based SOP, langsung ke domain produksi) ----
// Prinsip permission (anti bootstrap/cache 500):
// - root hanya untuk: mysql, nginx, certbot, supervisor, cron, chown.
// - git clone / composer / artisan SELALU sebagai deployer (user:www-data).
// - .env 660, code 664, dir 775+setgid, storage+bootstrap/cache +ACL, verifikasi tulis www-data.
const DEPLOY_JOBS = new Map();
let deploySeq = 0;

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

function runCmd(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: opts.timeout || 120000, cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: (stdout || '') + (stderr || ''), error: err ? err.message : null });
    });
  });
}
function runFile(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeout || 120000, cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: (stdout || '') + (stderr || ''), error: err ? err.message : null });
    });
  });
}
const asUser = (user, prog, args) => `sudo -H -u ${user} ${prog} ${args.map(shq).join(' ')}`;

function vErr(msg) { return { ok: false, error: msg }; }
function vDir(v) {
  v = String(v || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(v) || v === '.' || v === '..') return vErr('Nama folder tidak valid (huruf/angka/._-)');
  return { ok: true, value: v };
}
function vDomain(v) {
  v = String(v || '').trim().toLowerCase();
  if (v.length > 253 || !/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z]{2,}$/.test(v)) return vErr('Domain tidak valid');
  return { ok: true, value: v };
}
function vRepo(v) {
  v = String(v || '').trim();
  const m = v.match(/^(https:\/\/github\.com\/bagazpattrya\/[A-Za-z0-9._-]+(\.git)?|git@github\.com:bagazpattrya\/[A-Za-z0-9._-]+(\.git)?)$/);
  if (!m) return vErr('Repo harus github.com/bagazpattrya/* (https atau ssh)');
  return { ok: true, value: v };
}
function vBranch(v) {
  v = String(v || 'main').trim() || 'main';
  if (!/^[A-Za-z0-9._/-]+$/.test(v) || v.length > 100) return vErr('Branch tidak valid');
  return { ok: true, value: v };
}
function vLinuxUser(v) {
  v = String(v || '').trim();
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(v)) return vErr('User deploy tidak valid');
  try {
    const out = execSync(`id -nG ${v} 2>/dev/null`).toString().trim().split(/\s+/);
    if (!out.includes('www-data')) return vErr(`User ${v} belum masuk grup www-data (jalankan: usermod -aG www-data ${v})`);
  } catch { return vErr(`User Linux ${v} tidak ada`); }
  return { ok: true, value: v };
}
function vDbIdent(v, what, max) {
  v = String(v || '').trim();
  // Dash diizinkan (SOP WP pakai demo-lapila_user); identifier selalu di-quote/backtick saat dipakai.
  if (!/^[A-Za-z0-9_$-]+$/.test(v) || v.length > max) return vErr(`${what} hanya boleh huruf/angka/_/-/$ (maks ${max})`);
  return { ok: true, value: v };
}
function vAbsPath(v, what) {
  v = String(v || '').trim();
  if (!v.startsWith('/') || v.includes('\0')) return vErr(`${what} harus absolute path`);
  return { ok: true, value: path.normalize(v) };
}
function phpBin() {
  if (fs.existsSync('/run/php/php8.4-fpm.sock') && fs.existsSync('/usr/bin/php8.4')) return 'php8.4';
  if (fs.existsSync('/usr/bin/php8.4')) return 'php8.4';
  if (fs.existsSync('/usr/bin/php8.5')) return 'php8.5';
  return 'php';
}
function jobRedact(job, s) {
  let out = String(s || '');
  for (const sec of job.secrets || []) if (sec) out = out.split(sec).join('***');
  return out;
}
function jobStep(job, name, status, output) {
  const clean = jobRedact(job, output || '');
  let st = job.steps.find((s) => s.name === name);
  if (!st) { st = { name, status, output: '' }; job.steps.push(st); }
  st.status = status;
  if (clean) st.output = (st.output ? st.output + '\n' : '') + clean.slice(-8000);
  try { fs.appendFileSync(job.logFile, `\n===== ${name} [${status}] =====\n${clean.slice(-8000)}`); } catch {}
}
function newJob(type, label, secrets) {
  const id = `dep-${Date.now().toString(36)}-${(++deploySeq).toString(36)}`;
  const job = { id, type, label, status: 'running', steps: [], secrets: secrets || [], createdAt: Date.now(), logFile: path.join(DATA_DIR, `${id}.log`) };
  DEPLOY_JOBS.set(id, job);
  if (DEPLOY_JOBS.size > 20) { const first = DEPLOY_JOBS.keys().next().value; DEPLOY_JOBS.delete(first); }
  return job;
}
function jobPublic(job) {
  return { id: job.id, type: job.type, label: job.label, status: job.status, steps: job.steps, createdAt: job.createdAt, warn: job.warn || null };
}

async function runDeployJob(job, p) {
  const dest = path.join('/var/www', p.dir);
  const isWP = p.framework === 'wordpress' || p.framework === 'wordpress-theme';
  const mysql = (sql) => runFile('mysql', ['-BNe', sql], { timeout: 15000 });
  const ago = async (prog, args, opts) => runCmd(asUser(p.deployer, prog, args), opts);
  try {
    let r;
    // 1. validasi sudah lolos di handler; cek folder belum ada
    jobStep(job, 'validate', 'running', `dir=${p.dir} domain=${p.domain} repo=${p.repo} branch=${p.branch} deployer=${p.deployer} db=${p.dbName}/${p.dbUser} fw=${p.framework} type=${p.projectType} queue=${p.useQueue} scheduler=${p.useScheduler}`);
    if (fs.existsSync(dest)) throw new Error(`Folder ${dest} sudah ada`);
    jobStep(job, 'validate', 'ok', 'semua input valid');

    if (p.dryRun) {
      const checkRepos = p.framework === 'wordpress-theme'
        ? [{ label: 'theme', repo: p.themeRepo }]
        : [{ label: 'site', repo: p.repo }];
      for (const cr of checkRepos) {
        jobStep(job, `dry-run: git ls-remote (${cr.label})`, 'running', '');
        let r = await ago('git', ['ls-remote', cr.repo, 'HEAD'], { timeout: 30000 });
        if (!r.ok) throw new Error(`git ls-remote ${cr.label} gagal (repo/akses deploy key?)\n` + r.output);
        jobStep(job, `dry-run: git ls-remote (${cr.label})`, 'ok', r.output.slice(0, 300));
      }
      if (p.framework === 'wordpress-theme') {
        jobStep(job, 'dry-run: wordpress.org', 'running', '');
        let r = await runCmd('curl -sIL -m 20 -o /dev/null -w "%{http_code}" https://wordpress.org/latest.tar.gz 2>&1', { timeout: 30000 });
        if (r.output.trim() !== '200') throw new Error('wordpress.org/latest.tar.gz tidak reachable\n' + r.output);
        jobStep(job, 'dry-run: wordpress.org', 'ok', 'HTTP 200');
      }
      if (isWP) {
        jobStep(job, 'dry-run: wp-cli', 'running', '');
        // --allow-root hanya untuk cek versi; eksekusi asli selalu sebagai deployer via sudo.
        r = await runCmd('/usr/local/bin/wp --version --allow-root 2>&1', { timeout: 15000 });
        if (!r.ok) throw new Error('wp-cli tidak tersedia\n' + r.output);
        jobStep(job, 'dry-run: wp-cli', 'ok', r.output.trim());
      }
      jobStep(job, 'dry-run: mysql', 'running', '');
      r = await mysql('SELECT 1;');
      if (!r.ok) throw new Error('mysql root socket gagal\n' + r.output);
      jobStep(job, 'dry-run: mysql', 'ok', 'root socket OK');
      jobStep(job, 'dry-run: dns+nginx', 'running', '');
      r = await runCmd(`getent ahosts ${shq(p.domain)} 2>&1 || true`, { timeout: 15000 });
      jobStep(job, 'dry-run: dns+nginx', r.output.trim() ? 'ok' : 'fail', r.output || '(domain belum resolve)');
      if (!r.output.trim()) throw new Error(`DNS ${p.domain} belum mengarah ke mana pun`);
      r = await runCmd('nginx -t 2>&1', { timeout: 15000 });
      jobStep(job, 'dry-run: dns+nginx', r.ok ? 'ok' : 'fail', r.output);
      if (!r.ok) throw new Error('nginx -t gagal (butuh root / config rusak)');
      job.status = 'done';
      return;
    }

    // 2. MySQL
    jobStep(job, 'mysql: create db+user', 'running', '');
    // CREATE IF NOT EXISTS saja tidak cukup: retry dengan password baru harus update password user lama.
    // sqlStr: escape backslash DULU lalu quote — password ber-backslash kalau tidak, MySQL salah parse.
    const sqlStr = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    r = await mysql(`CREATE DATABASE IF NOT EXISTS \`${p.dbName}\`; CREATE USER IF NOT EXISTS '${p.dbUser}'@'localhost' IDENTIFIED BY '${sqlStr(p.dbPass)}'; ALTER USER '${p.dbUser}'@'localhost' IDENTIFIED BY '${sqlStr(p.dbPass)}'; GRANT ALL PRIVILEGES ON \`${p.dbName}\`.* TO '${p.dbUser}'@'localhost'; FLUSH PRIVILEGES;`);
    if (!r.ok) throw new Error('mysql setup gagal\n' + r.output);
    jobStep(job, 'mysql: create db+user', 'ok', 'database + user siap');

    // 3. Clone sebagai deployer. Pre-create dir sebagai root dulu karena grup
    // www-data hanya r-x di /var/www (ACL) sehingga deployer tidak bisa mkdir langsung.
    // Mode wordpress-theme: bukan clone site, tapi download WordPress core fresh.
    jobStep(job, p.framework === 'wordpress-theme' ? 'wp core download' : 'git clone', 'running', '');
    r = await runCmd(`mkdir -p ${shq(dest)} && chown ${p.deployer}:www-data ${shq(dest)} && chmod 2755 ${shq(dest)}`);
    if (!r.ok) throw new Error('mkdir project gagal\n' + r.output);
    job.createdDir = dest; // penanda untuk rollback: folder ini milik job ini (validate menjamin belum ada sebelumnya)
    if (p.framework === 'wordpress-theme') {
      r = await runCmd(`curl -s -m 120 -o /tmp/wp-core-${job.id}.tar.gz https://wordpress.org/latest.tar.gz 2>&1 && tar -xzf /tmp/wp-core-${job.id}.tar.gz -C /tmp 2>&1 && cp -a /tmp/wordpress/. ${shq(dest)}/ 2>&1 && rm -rf /tmp/wordpress /tmp/wp-core-${job.id}.tar.gz`, { timeout: 300000 });
      if (!r.ok) throw new Error('download/extract WordPress core gagal\n' + r.output);
      await runCmd(`chown -R ${p.deployer}:www-data ${shq(dest)}`);
      jobStep(job, 'wp core download', 'ok', 'WordPress core fresh terpasang');
    } else {
    r = await ago('git', ['clone', '--branch', p.branch, p.repo, dest], { timeout: 300000 });
    if (!r.ok) throw new Error('git clone gagal\n' + r.output);
    await runCmd(`chown -R ${p.deployer}:www-data ${shq(dest)}`);
    await ago('git', ['-C', dest, 'config', 'core.filemode', 'false']);
    await ago('git', ['-C', dest, 'config', 'core.sharedRepository', 'group']);
    jobStep(job, 'git clone', 'ok', r.output.slice(-2000));
    }

    // 4. composer (wajib Laravel; WP hanya bila repo bawa composer.json)
    if (isWP && !fs.existsSync(path.join(dest, 'composer.json'))) {
      jobStep(job, 'composer install', 'skip', 'tidak ada composer.json');
    } else {
      if (!fs.existsSync(path.join(dest, 'composer.json'))) throw new Error('composer.json tidak ada (bukan project yang didukung?)');
      jobStep(job, 'composer install', 'running', '');
      r = await ago('composer', ['install', `--working-dir=${dest}`, '--no-interaction', '--prefer-dist', '--optimize-autoloader', '--no-dev'], { timeout: 600000 });
      if (!r.ok) throw new Error('composer install gagal\n' + r.output.slice(-3000));
      jobStep(job, 'composer install', 'ok', r.output.slice(-1500));
    }

    // 5. config app: .env (Laravel) / wp-config.php (WordPress)
    if (isWP) {
      jobStep(job, 'wp-config.php', 'running', '');
      const samplePath = path.join(dest, 'wp-config-sample.php');
      if (!fs.existsSync(samplePath)) throw new Error('wp-config-sample.php tidak ada (bukan WordPress?)');
      let wp = fs.readFileSync(samplePath, 'utf8');
      // phpStr: escape backslash DULU lalu quote (PHP single-quote: \\ dan \' satu-satunya escape).
      const phpStr = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const wset = (k, v) => {
        const re = new RegExp(`define\\(\\s*'${k}'\\s*,\\s*'.*?'\\s*\\)`);
        // replacer FUNCTION, bukan string: nilai acak (salts/password) mengandung $& $' $` $$
        // yang di String.replace ditafsirkan pola khusus -> wp-config rusak acak (parse error).
        const repl = `define( '${k}', '${phpStr(v)}' )`;
        wp = re.test(wp) ? wp.replace(re, () => repl) : wp + `\n${repl};\n`;
      };
      wset('DB_NAME', p.dbName);
      wset('DB_USER', p.dbUser);
      wset('DB_PASSWORD', p.dbPass);
      wp = wp.replace(/(\$table_prefix\s*=\s*')[^']*(')/, (m, a, b) => `${a}${p.tablePrefix}${b}`);
      // salts: coba API wordpress.org, fallback random lokal.
      // Validasi KELENGKAPAN (8 define utuh): fetch terpotong = wp-config rusak = parse error misterius di eval wp-cli.
      let salts = '';
      r = await runCmd(`curl -s -m 15 https://api.wordpress.org/secret-key/1.1/salt/ 2>&1`, { timeout: 20000 });
      const saltKeys = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'];
      if (r.ok && saltKeys.every((k) => new RegExp(`define\\(\\s*'${k}'\\s*,\\s*'[^']+'\\s*\\);`).test(r.output))) salts = r.output;
      else {
        const { randomBytes } = require('crypto');
        salts = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT']
          .map((k) => `define( '${k}', '${randomBytes(48).toString('hex')}' );`).join('\n');
      }
      wp = wp.replace(/define\(\s*'AUTH_KEY'[\s\S]*?NONCE_SALT'\s*,\s*'[^']*'\s*\)/, () => salts);
      if (!/AUTH_KEY/.test(wp)) wp += '\n' + salts + '\n';
      wp += `\ndefine( 'WP_HOME', 'https://${p.domain}' );\ndefine( 'WP_SITEURL', 'https://${p.domain}' );\ndefine( 'DISABLE_WP_CRON', true );\ndefine( 'FS_METHOD', 'direct' );\n`;
      fs.writeFileSync(path.join(dest, 'wp-config.php'), wp);
      await runCmd(`chown ${p.deployer}:www-data ${shq(path.join(dest, 'wp-config.php'))} && chmod 640 ${shq(path.join(dest, 'wp-config.php'))}`);
      // Gate: wp-cli men-EVAL wp-config.php — file rusak = error misterius. Gagal cepat di sini dengan pesan jelas.
      r = await runCmd(`php -l ${shq(path.join(dest, 'wp-config.php'))} 2>&1`, { timeout: 30000 });
      if (!r.ok || !/No syntax errors/.test(r.output)) throw new Error('wp-config.php hasil generate rusak (php -l gagal)\n' + r.output.slice(-1500));
      jobStep(job, 'wp-config.php', 'ok', `prefix=${p.tablePrefix} salts=${/api.wordpress.org/.test(salts) ? 'wordpress.org' : 'lokal'}`);
    } else {
    jobStep(job, '.env', 'running', '');
    const exPath = path.join(dest, '.env.example');
    if (!fs.existsSync(exPath)) throw new Error('.env.example tidak ada (bukan Laravel?)');
    let env = fs.readFileSync(exPath, 'utf8');
    const setEnv = (k, v) => {
      const re = new RegExp(`^${k}=.*$`, 'm');
      // Function replacer: nilai dengan $ (SMTP password dsb) bukan pola khusus String.replace.
      env = re.test(env) ? env.replace(re, () => `${k}=${v}`) : env + `\n${k}=${v}\n`;
    };
    setEnv('APP_URL', `https://${p.domain}`);
    // Paksa mysql: banyak .env.example Laravel default DB_CONNECTION=sqlite.
    setEnv('DB_CONNECTION', 'mysql');
    if (!/^DB_HOST=/m.test(env)) env += '\nDB_HOST=127.0.0.1\n';
    if (!/^DB_PORT=/m.test(env)) env += '\nDB_PORT=3306\n';
    setEnv('DB_DATABASE', p.dbName);
    setEnv('DB_USERNAME', p.dbUser);
    setEnv('DB_PASSWORD', p.dbPass);
    if (p.appName) setEnv('APP_NAME', `"${p.appName.replace(/"/g, '')}"`);
    const qv = (v) => (/[\s#]/.test(v) ? `"${v.replace(/"/g, '')}"` : v);
    setEnv('MAIL_MAILER', p.mail.mailer);
    if (p.mail.scheme) setEnv('MAIL_SCHEME', p.mail.scheme);
    if (p.mail.mailer === 'smtp') {
      if (p.mail.host) setEnv('MAIL_HOST', p.mail.host);
      if (p.mail.port) setEnv('MAIL_PORT', p.mail.port);
      if (p.mail.username) setEnv('MAIL_USERNAME', qv(p.mail.username));
      if (p.mail.password) setEnv('MAIL_PASSWORD', qv(p.mail.password));
    }
    if (p.mail.fromAddress) setEnv('MAIL_FROM_ADDRESS', qv(p.mail.fromAddress));
    if (p.mail.fromName) setEnv('MAIL_FROM_NAME', `"${p.mail.fromName.replace(/"/g, '')}"`);
    for (const [k, v] of Object.entries(p.envExtra || {})) setEnv(k, v);
    if (p.appKey) {
      if (!/^base64:[A-Za-z0-9+/=]+$/.test(p.appKey)) throw new Error('APP_KEY format salah (harus base64:...)');
      setEnv('APP_KEY', p.appKey);
    }
    fs.writeFileSync(path.join(dest, '.env'), env);
    await runCmd(`chown ${p.deployer}:www-data ${shq(path.join(dest, '.env'))} && chmod 660 ${shq(path.join(dest, '.env'))}`);
    if (!p.appKey) {
      r = await ago(phpBin(), [path.join(dest, 'artisan'), 'key:generate', '--force'], { timeout: 60000 });
      if (!r.ok) throw new Error('key:generate gagal\n' + r.output);
    }
    jobStep(job, '.env', 'ok', p.appKey ? 'APP_KEY reuse dari project lama' : 'APP_KEY baru di-generate');
    } // end Laravel .env

    // 6. DB: migrate/seed/import (Laravel) atau wp install/import (WordPress)
    if (isWP && p.projectType === 'new') {
      jobStep(job, 'wp core install', 'running', '');
      r = await ago('/usr/local/bin/wp', ['core', 'install', `--path=${dest}`, `--url=https://${p.domain}`, `--title=${p.wpTitle}`, `--admin_user=${p.wpAdminUser}`, `--admin_password=${p.wpAdminPass}`, `--admin_email=${p.wpAdminEmail}`, '--skip-email'], { timeout: 120000, env: { WP_CLI_CACHE_DIR: '/tmp/wp-cli-cache' } });
      if (!r.ok) throw new Error('wp core install gagal\n' + r.output.slice(-3000));
      jobStep(job, 'wp core install', 'ok', r.output.slice(-1500));
    } else if (p.projectType === 'new') {
      jobStep(job, 'migrate --force', 'running', '');
      r = await ago(phpBin(), [path.join(dest, 'artisan'), 'migrate', '--force'], { timeout: 300000 });
      if (!r.ok) throw new Error('migrate gagal\n' + r.output.slice(-3000));
      jobStep(job, 'migrate --force', 'ok', r.output.slice(-1500));

      // Seeder role/permission/user bila ada di database/seeders, skip bila tidak ada.
      const seeders = detectRoleSeeders(dest);
      if (!seeders.length) {
        jobStep(job, 'db:seed role/user', 'skip', 'tidak ada seeder role/permission/user');
      } else {
        jobStep(job, 'db:seed role/user', 'running', seeders.join(', '));
        let sOut = '';
        for (const cls of seeders) {
          r = await ago(phpBin(), [path.join(dest, 'artisan'), 'db:seed', `--class=${cls}`, '--force'], { timeout: 120000 });
          sOut += `\n--- db:seed --class=${cls} --force ---\n` + r.output.slice(-2000);
          if (!r.ok) throw new Error(`seeder ${cls} gagal\n` + r.output.slice(-3000));
        }
        r = await ago(phpBin(), [path.join(dest, 'artisan'), 'permission:cache-reset'], { timeout: 60000 });
        jobStep(job, 'db:seed role/user', 'ok', sOut.slice(-4000));
      }
    } else {
      jobStep(job, 'import sql', 'running', p.sqlPath);
      if (!fs.existsSync(p.sqlPath)) throw new Error(`File SQL tidak ada: ${p.sqlPath}`);
      const isGz = p.sqlPath.endsWith('.gz');
      const imp = isGz
        ? `zcat ${shq(p.sqlPath)} | MYSQL_PWD=${shq(p.dbPass)} mysql -u ${shq(p.dbUser)} ${shq(p.dbName)}`
        : `MYSQL_PWD=${shq(p.dbPass)} mysql -u ${shq(p.dbUser)} ${shq(p.dbName)} < ${shq(p.sqlPath)}`;
      r = await runCmd(imp, { timeout: 600000 });
      if (!r.ok) throw new Error('import SQL gagal (cek kredensial DB / file corrupt)\n' + r.output.slice(-3000));
      jobStep(job, 'import sql', 'ok', `import ${p.sqlPath} OK (kredensial DB terverifikasi)`);
    }

    // 6b. Theme dari GitHub (mode wordpress-theme saja, new maupun existing).
    if (p.framework === 'wordpress-theme') {
      jobStep(job, 'theme clone', 'running', `${p.themeRepo} -> wp-content/themes/${p.themeFolder}`);
      const themeDest = path.join(dest, 'wp-content', 'themes', p.themeFolder);
      if (fs.existsSync(themeDest)) throw new Error(`Folder theme sudah ada: ${themeDest}`);
      r = await ago('git', ['clone', '--branch', p.themeBranch, p.themeRepo, themeDest], { timeout: 300000 });
      if (!r.ok) throw new Error('theme clone gagal\n' + r.output);
      await runCmd(`chown -R ${p.deployer}:www-data ${shq(themeDest)}`);
      await ago('git', ['-C', themeDest, 'config', 'core.filemode', 'false']);
      await ago('git', ['-C', themeDest, 'config', 'core.sharedRepository', 'group']);
      jobStep(job, 'theme clone', 'ok', r.output.slice(-1500));

      // Aktivasi theme — WAJIB sukses: tujuan mode ini = site jalan memakai theme dari repo.
      // (Tanpa step ini theme hanya ada di folder; WP tetap pakai theme default.)
      jobStep(job, 'theme activate', 'running', p.themeFolder);
      r = await ago('/usr/local/bin/wp', ['theme', 'activate', p.themeFolder, `--path=${dest}`], { timeout: 60000 });
      if (!r.ok) throw new Error(`aktivasi theme gagal — pastikan style.css punya header "Theme Name" dan nama folder = stylesheet\n` + r.output.slice(-2000));
      jobStep(job, 'theme activate', 'ok', r.output.slice(-800));
    }

    // 6c. Plugin wajib WP baru: Advanced Custom Fields (free) install+activate.
    // Non-fatal (warn): site tetap jalan tanpa ACF, tapi theme yang depend bisa error.
    // Catatan: ACF PRO butuh lisensi/zip manual — tidak bisa auto-install.
    if (isWP && p.projectType === 'new') {
      jobStep(job, 'plugin ACF', 'running', '');
      r = await ago('/usr/local/bin/wp', ['plugin', 'install', 'advanced-custom-fields', '--activate', `--path=${dest}`], { timeout: 180000, env: { WP_CLI_CACHE_DIR: '/tmp/wp-cli-cache' } });
      if (!r.ok) {
        jobStep(job, 'plugin ACF', 'warn', 'install/activate ACF gagal, install manual via wp-admin:\n' + r.output.slice(-1500));
        job.warn = (job.warn ? job.warn + ' | ' : '') + 'ACF gagal terinstall otomatis';
      } else jobStep(job, 'plugin ACF', 'ok', r.output.slice(-1500));
    }

    // 7-8. storage:link + optimize + fix perms + gate (Laravel). WP: langsung perms.
    if (isWP) {
      jobStep(job, 'storage:link + optimize', 'skip', 'bukan Laravel');
    } else {
    jobStep(job, 'storage:link + optimize', 'running', '');
    r = await ago(phpBin(), [path.join(dest, 'artisan'), 'storage:link'], { timeout: 60000 });
    r = await ago(phpBin(), [path.join(dest, 'artisan'), 'optimize:clear'], { timeout: 120000 });
    jobStep(job, 'storage:link + optimize', 'ok', r.output.slice(-1000));
    }
    jobStep(job, 'fix-permissions + gate www-data', 'running', '');
    r = await runCmd(`bash /var/www/fix-permissions.sh ${shq(dest)} --user ${shq(p.deployer)} 2>&1`, { timeout: 120000 });
    if (!r.ok) throw new Error('fix-permissions gagal\n' + r.output.slice(-2000));
    await runCmd(`chmod 640 ${shq(path.join(dest, isWP ? 'wp-config.php' : '.env'))} 2>/dev/null || true`);
    for (const sub of (isWP ? ['wp-content/uploads'] : ['storage', 'bootstrap/cache'])) {
      const wd = shq(path.join(dest, sub));
      // JANGAN chmod 2755 di sini: itu menurunkan mask ACL dari fix-permissions.sh menjadi r-x
      // sehingga www-data terkunci (gate gagal). Standar script: 775+setgid, lalu setfacl
      // dijalankan SESUDAH chmod agar mask dihitung ulang dan www-data tetap rwx.
      await runCmd(`mkdir -p ${wd} && chown ${p.deployer}:www-data ${wd} && chmod 2775 ${wd} && { setfacl -m u:www-data:rwx -m d:u:www-data:rwx ${wd} 2>/dev/null; } || true`);
      const t = path.join(dest, sub, '.writetest-www-data');
      const w = await runCmd(`sudo -n -u www-data touch ${shq(t)} 2>&1 && rm -f ${shq(t)}`, { timeout: 15000 });
      if (!w.ok) throw new Error(`GATE GAGAL: www-data tidak bisa tulis ke ${sub} — deploy dihentikan sebelum go-live\n` + w.output);
    }
    jobStep(job, 'fix-permissions + gate www-data', 'ok', isWP ? 'www-data bisa tulis wp-content/uploads' : 'www-data bisa tulis storage/ + bootstrap/cache');

    // 9. DNS
    jobStep(job, 'dns check', 'running', p.domain);
    r = await runCmd(`getent ahosts ${shq(p.domain)} 2>&1 || true`, { timeout: 15000 });
    if (!r.output.trim()) throw new Error(`DNS ${p.domain} belum resolve — buat A record dulu (SOP step 9)`);
    jobStep(job, 'dns check', 'ok', r.output.trim().split('\n')[0]);

    // 10-11. nginx
    jobStep(job, 'nginx vhost', 'running', '');
    const vhost = `server {\n    listen 80;\n    listen [::]:80;\n    server_name ${p.domain};\n    root ${dest}${isWP ? '' : '/public'};\n    index index.php;\n    location / {\n        try_files $uri $uri/ /index.php?$query_string;\n    }\n    location ~ \\.php$ {\n        include snippets/fastcgi-php.conf;\n        fastcgi_pass unix:/run/php/${phpBin()}-fpm.sock;\n    }\n    location ~ /\\.ht {\n        deny all;\n    }\n    client_max_body_size ${isWP ? '200M' : '50M'};\n}\n`;
    fs.writeFileSync(`/etc/nginx/sites-available/${p.domain}`, vhost);
    job.createdVhost = p.domain;
    await runCmd(`ln -sf /etc/nginx/sites-available/${shq(p.domain)} /etc/nginx/sites-enabled/${shq(p.domain)}`);
    r = await runCmd('nginx -t 2>&1', { timeout: 15000 });
    if (!r.ok) throw new Error('nginx -t gagal\n' + r.output);
    r = await runCmd('systemctl reload nginx 2>&1', { timeout: 30000 });
    if (!r.ok) throw new Error('nginx reload gagal\n' + r.output);
    r = await runCmd(`curl -s -m 15 -o /dev/null -w "%{http_code}" http://${p.domain}/ 2>&1`, { timeout: 30000 });
    jobStep(job, 'nginx vhost', 'ok', `http://${p.domain} -> ${r.output.trim()}`);

    // 12. certbot (non-fatal)
    jobStep(job, 'certbot ssl', 'running', '');
    r = await runCmd(`certbot --nginx -d ${shq(p.domain)} --non-interactive --agree-tos --register-unsafely-without-email --redirect 2>&1`, { timeout: 180000 });
    jobStep(job, 'certbot ssl', r.ok ? 'ok' : 'warn', r.output.slice(-2000) || '(tidak ada output)');
    if (!r.ok) job.warn = 'SSL gagal — site jalan di HTTP, ulangi certbot manual setelah DNS propagasi penuh';

    // 13. supervisor worker (Laravel + queue saja; WP tidak butuh)
    if (isWP) {
      jobStep(job, 'supervisor worker', 'skip', 'WordPress tidak pakai queue worker');
    } else if (p.useQueue) {
      jobStep(job, 'supervisor worker', 'running', '');
      const conf = `[program:${p.domain}-worker]\nprocess_name=%(program_name)s_%(process_num)02d\ncommand=php ${dest}/artisan queue:work --sleep=3 --tries=3\nautostart=true\nautorestart=true\nuser=www-data\nnumprocs=1\nredirect_stderr=true\nstdout_logfile=${dest}/storage/logs/worker.log\n`;
      fs.writeFileSync(`/etc/supervisor/conf.d/${p.domain}-worker.conf`, conf);
      job.createdSupervisor = `${p.domain}-worker`;
      r = await runCmd('supervisorctl reread 2>&1 && supervisorctl update 2>&1', { timeout: 60000 });
      r = await runCmd(`supervisorctl start ${shq(p.domain + '-worker:*')} 2>&1`, { timeout: 60000 });
      // Worker PHP butuh waktu boot — poll sampai RUNNING (maks ~30 dtk), jangan cek sekali langsung.
      let stOut = '';
      for (let i = 0; i < 10; i++) {
        await new Promise((s) => setTimeout(s, 3000));
        r = await runCmd(`supervisorctl status ${shq(p.domain + '-worker:*')} 2>&1`, { timeout: 15000 });
        stOut = r.output;
        if (/RUNNING/.test(stOut)) break;
        if (/FATAL|BACKOFF|STOPPED|ERROR/.test(stOut)) break;
      }
      if (!/RUNNING/.test(stOut)) throw new Error('worker tidak RUNNING\n' + stOut);
      jobStep(job, 'supervisor worker', 'ok', stOut.trim());
    } else jobStep(job, 'supervisor worker', 'skip', 'nonaktif (opsi)');

    // 14. cron scheduler (opsional, idempoten). WP: wp-cron tiap 5 mnt (DISABLE_WP_CRON sudah true di wp-config).
    if (p.useScheduler) {
      jobStep(job, 'cron scheduler', 'running', '');
      const line = isWP
        ? `*/5 * * * * cd ${dest} && php wp-cron.php >> /dev/null 2>&1`
        : `* * * * * cd ${dest} && php artisan schedule:run >> /dev/null 2>&1`;
      r = await runCmd(`crontab -u www-data -l 2>/dev/null | grep -F ${shq(dest)} || true`, { timeout: 15000 });
      if (r.output.includes(dest)) {
        jobStep(job, 'cron scheduler', 'skip', 'cron sudah ada (tidak diduplikasi)');
      } else {
        r = await runCmd(`(crontab -u www-data -l 2>/dev/null; echo ${shq(line)}) | crontab -u www-data - 2>&1`, { timeout: 15000 });
        if (!r.ok) throw new Error('tambah cron gagal\n' + r.output);
        jobStep(job, 'cron scheduler', 'ok', line);
      }
    } else jobStep(job, 'cron scheduler', 'skip', 'nonaktif (opsi)');

    // 15. verifikasi akhir
    jobStep(job, 'verify', 'running', '');
    r = await runCmd(`curl -sk -m 15 -o /dev/null -w "%{http_code}" https://${p.domain}/ 2>&1`, { timeout: 30000 });
    const httpsCode = r.output.trim();
    const permDirs = isWP ? [path.join(dest, 'wp-content')] : [path.join(dest, 'storage'), path.join(dest, 'bootstrap/cache')];
    r = await runCmd(`find ${permDirs.map(shq).join(' ')} -type d -perm -o+w 2>/dev/null | head`, { timeout: 15000 });
    if (r.output.trim()) throw new Error('Masih ada dir o+writable di storage/bootstrap (harusnya kosong)\n' + r.output);
    jobStep(job, 'verify', 'ok', `https=${httpsCode}, tidak ada dir o+writable`);
    job.status = 'done';
  } catch (e) {
    jobStep(job, 'ERROR', 'fail', String((e && e.message) || e).slice(0, 3000));
    // Rollback artefak yang dibuat job ini agar retry bisa jalan bersih.
    // - Folder project: aman dihapus (validate menjamin belum ada sebelum job).
    // - Vhost nginx: hapus + reload bila sempat dibuat.
    // - Database SENGAJA dibiarkan (bisa jadi sudah ada sebelumnya; CREATE IF NOT EXISTS aman retry).
    try {
      const notes = ['database dibiarkan (aman retry, IF NOT EXISTS)'];
      if (job.createdVhost && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(job.createdVhost)) {
        await runCmd(`rm -f /etc/nginx/sites-enabled/${job.createdVhost} /etc/nginx/sites-available/${job.createdVhost} && nginx -t 2>&1 && systemctl reload nginx 2>&1`, { timeout: 30000 });
        notes.push(`vhost ${job.createdVhost} dihapus`);
      }
      if (job.createdSupervisor && /^[a-zA-Z0-9.-]+-worker$/.test(job.createdSupervisor)) {
        await runCmd(`supervisorctl stop ${shq(job.createdSupervisor + ':*')} 2>&1; rm -f /etc/supervisor/conf.d/${job.createdSupervisor}.conf; supervisorctl reread 2>&1; supervisorctl update 2>&1`, { timeout: 60000 });
        notes.push(`supervisor ${job.createdSupervisor} dihentikan+dihapus`);
      }
      if (job.createdDir && job.createdDir === path.join('/var/www', p.dir) && fs.existsSync(job.createdDir)) {
        await runCmd(`(crontab -u www-data -l 2>/dev/null | grep -v -F ${shq(job.createdDir)} || true) | crontab -u www-data - 2>&1`, { timeout: 15000 });
        await runCmd(`rm -rf ${shq(job.createdDir)}`, { timeout: 60000 });
        notes.push(`folder ${job.createdDir} dihapus (+cron line bila ada)`);
      }
      jobStep(job, 'rollback', 'ok', notes.join('; '));
    } catch (rbErr) {
      jobStep(job, 'rollback', 'fail', 'rollback tidak sempurna, cek manual: ' + String((rbErr && rbErr.message) || rbErr).slice(0, 500));
    }
    job.status = 'failed';
  }
}

// ---- Storage transfer dari host lama (rsync via screen, SOP migrate) ----
function xferName(project) {
  return `vps-xfer-${String(project).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40)}-${String(Date.now() % 100000)}`;
}
async function runTransferJob(job, t) {
  const fail = (msg, out) => { jobStep(job, 'ERROR', 'fail', msg + (out ? '\n' + String(out).slice(-2000) : '')); job.status = 'failed'; };
  try {
    jobStep(job, 'validate', 'running', `project=${t.project} ${t.user}@${t.host}:${t.port} src=${t.src}`);
    const projDir = path.join('/var/www', t.project);
    if (!fs.existsSync(projDir)) throw new Error(`Project ${t.project} tidak ada di /var/www`);
    const dest = path.join(projDir, 'storage/app/public') + '/';
    if (!/^[A-Za-z0-9._-]+$/.test(t.project)) throw new Error('Nama project tidak valid');
    if (!/^([a-zA-Z0-9.-]+|\d{1,3}(\.\d{1,3}){3})$/.test(t.host)) throw new Error('IP/host tidak valid');
    const port = parseInt(t.port, 10);
    if (!(port >= 1 && port <= 65535)) throw new Error('Port 1-65535');
    if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(t.user)) throw new Error('SSH user tidak valid');
    const src = path.normalize(t.src);
    if (!src.startsWith('/') || src.includes('\0')) throw new Error('Source harus absolute path');
    jobStep(job, 'validate', 'ok', `dest=${dest}`);

    jobStep(job, 'preflight nc', 'running', `${t.host}:${port}`);
    let r = await runFile('nc', ['-zv', '-w', '8', t.host, String(port)], { timeout: 15000 });
    if (!r.ok) { fail(`Port ${port} di ${t.host} tidak terjangkau — cek IP/port di control panel host lama`, r.output); return; }
    jobStep(job, 'preflight nc', 'ok', r.output.trim().split('\n').slice(-2).join(' '));

    if (t.authType === 'password') {
      r = await runCmd('command -v sshpass 2>/dev/null || (apt-get update -qq 2>&1 | tail -n 1; apt-get install -y -qq sshpass 2>&1 | tail -n 2)', { timeout: 180000 });
      r = await runCmd('command -v sshpass', { timeout: 10000 });
      if (!r.ok) { fail('sshpass tidak tersedia dan apt install gagal', r.output); return; }
    }
    await runCmd(`mkdir -p ${shq(dest)} && chown www-data:www-data ${shq(dest)}`);

    const name = xferName(t.project);
    job.transfer = { name, logFile: path.join(DATA_DIR, `${job.id}.xfer.log`), dest };
    const sshBase = `ssh -p ${port} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10`;
    const rsyncInner = `rsync -avz --progress -e ${shq(sshBase)} ${shq(t.user + '@' + t.host + ':' + src + '/')} ${shq(dest)} >> ${shq(job.transfer.logFile)} 2>&1; echo "RSYNC_EXIT:$?" >> ${shq(job.transfer.logFile)}`;
    const launch = t.authType === 'password'
      ? `env SSHPASS=${shq(t.password)} screen -S ${shq(name)} -dm bash -c ${shq(`export SSHPASS; sshpass -e ${rsyncInner}`)}}`
      : `screen -S ${shq(name)} -dm bash -c ${shq(rsyncInner)}`;
    try { fs.writeFileSync(job.transfer.logFile, `transfer ${name} dimulai ${new Date().toISOString()}\n`); } catch {}
    r = await runCmd(`echo "" >> ${shq(job.transfer.logFile)} 2>/dev/null; ${launch} 2>&1`, { timeout: 15000 });
    await new Promise((s) => setTimeout(s, 1500));
    r = await runCmd(`screen -ls 2>&1 | grep ${shq(name)} || true`, { timeout: 10000 });
    if (!r.output.includes(name)) {
      const tail = fs.existsSync(job.transfer.logFile) ? fs.readFileSync(job.transfer.logFile, 'utf8').slice(-1500) : '';
      fail('screen session gagal start', tail);
      return;
    }
    jobStep(job, 'rsync running', 'ok', `screen ${name} (poll status untuk progres, cancel tersedia)`);
    job.status = 'running-transfer';
  } catch (e) { fail(String((e && e.message) || e)); }
}
function transferStatus(job) {
  if (!job.transfer) return { running: false, logTail: null, exitCode: null };
  let log = '';
  try { log = fs.readFileSync(job.transfer.logFile, 'utf8'); } catch {}
  let exitCode = null;
  const m = log.match(/RSYNC_EXIT:(\d+)/);
  if (m) exitCode = parseInt(m[1], 10);
  let running = false;
  try {
    const out = execSync(`screen -ls 2>&1 || true`, { timeout: 10000 }).toString();
    running = out.includes(job.transfer.name);
  } catch {}
  if (exitCode !== null && !running && job.status === 'running-transfer') {
    job.status = exitCode === 0 ? 'finishing' : 'failed';
    try {
      if (exitCode === 0 && !fs.existsSync(job.transfer.logFile + '.chowned')) {
        execSync(`chown -R www-data:www-data ${job.transfer.dest} 2>&1`);
        fs.writeFileSync(job.transfer.logFile + '.chowned', 'ok');
        fs.appendFileSync(job.transfer.logFile, '\n[chown www-data:www-data dest OK]\n');
      }
      if (exitCode === 23) fs.appendFileSync(job.transfer.logFile, '\n[code 23 = 1+ file gagal (biasanya permission 1 file), scroll ke atas cari failed-file lines]\n');
    } catch (e) { try { fs.appendFileSync(job.transfer.logFile, '\n[chown gagal: ' + e.message + ']\n'); } catch {} }
    if (exitCode === 0) job.status = 'done';
    jobStep(job, exitCode === 0 ? 'rsync done' : 'rsync failed', exitCode === 0 ? 'ok' : 'fail', log.slice(-3000));
  }
  return { running, name: job.transfer.name, dest: job.transfer.dest, exitCode, logTail: log.split('\n').slice(-40).join('\n') };
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
    if (!r.ok) { logActivity(body && body.username, 'auth.login.fail', '', String(r.error || '').slice(0, 100)); return send(res, r.status, JSON.stringify({ error: r.error })); }
    logActivity(r.user, 'auth.login', '', `role=${r.role || ''}`);
    res.setHeader('Set-Cookie', r.setCookie);
    return send(res, 200, JSON.stringify({ user: r.user, admin: r.admin, role: r.role }));
  }
  if (p === '/api/logout' && req.method === 'POST') {
    const s0 = auth.getSession(req);
    if (s0) logActivity(s0.user, 'auth.logout', '');
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

  const needSuper = () => send(res, 403, JSON.stringify({ error: 'Superadmin required' }));

  if (p === '/api/me') {
    const { hiddenKeywords: _hk, ...me } = session; // keyword tidak perlu sampai ke browser
    return send(res, 200, JSON.stringify({ ...me, linuxLogin: auth.ALLOW_LINUX_LOGIN }));
  }
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
  if (p === '/api/storage') {
    const force = url.searchParams.get('force') === '1';
    const s = getStorageBreakdown(force);
    if (!hiddenKeywordsFor(session).length) return send(res, 200, JSON.stringify(s));
    return send(res, 200, JSON.stringify({
      ...s,
      projects: (s.projects || []).filter((x) => !isHidden(session, [x.name, x.relPath])),
      largeLogs: (s.largeLogs || []).filter((x) => !isHidden(session, x.path)),
    }));
  }
  if (p === '/api/workers') {
    const [sup, crn] = await Promise.all([getSupervisorStatus(), Promise.resolve(getCronJobs())]);
    if (!hiddenKeywordsFor(session).length) {
      return send(res, 200, JSON.stringify({ time: Date.now(), supervisor: sup, cron: crn, laravelLogs: laravelLogPaths() }));
    }
    // sup = {available, procs[]}, crn = {jobs[], schedProcs[]} — filter isi array-nya, bukan object-nya.
    const supOut = sup && Array.isArray(sup.procs) ? { ...sup, procs: sup.procs.filter((x) => !isHidden(session, x)) } : sup;
    const crnOut = crn && Array.isArray(crn.jobs) ? { ...crn, jobs: crn.jobs.filter((x) => !isHidden(session, [x.user, x.cmd])) } : crn;
    return send(res, 200, JSON.stringify({
      time: Date.now(),
      supervisor: supOut,
      cron: crnOut,
      laravelLogs: laravelLogPaths().filter((x) => !isHidden(session, x)),
    }));
  }
  if (p === '/api/workers/schedule') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    if (url.searchParams.get('all') === '1') {
      audit(session.user, 'worker.schedule', 'all', 'scan');
      const all = (await getAllSchedules()).filter((x) => !isHidden(session, x.dir));
      return send(res, 200, JSON.stringify({ time: Date.now(), apps: all }));
    }
    const dir = url.searchParams.get('dir');
    if (!dir || !cronArtisanDirs().has(dir) || isHidden(session, dir)) return send(res, 404, JSON.stringify({ error: 'Not found' }));
    return send(res, 200, JSON.stringify(await getScheduleList(dir)));
  }
  if (p === '/api/workers/supervisor' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    if (isHidden(session, body && body.name)) return send(res, 404, JSON.stringify({ error: 'Not found' }));
    audit(session.user, 'worker.supervisor', body && body.name, body && body.action);
    const r = await supervisorAction(body && body.action, body && body.name);
    return send(res, r.ok ? 200 : 500, JSON.stringify(r));
  }
  if (p === '/api/pm2/restart' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    audit(session.user, 'pm2.restart', process.env.pm_id || 'vps-monitor', 'restart');
    send(res, 200, JSON.stringify({ ok: true }));
    // Jalankan setelah response terkirim; proses ini sendiri akan di-restart oleh pm2.
    setTimeout(() => {
      const target = process.env.pm_id !== undefined ? process.env.pm_id : (process.env.PM2_APP_NAME || 'vps-monitor');
      const child = spawn('pm2', ['restart', String(target)], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
      child.on('error', () => {});
      child.unref();
    }, 300);
    return;
  }
  if (p === '/api/workers/service' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    audit(session.user, 'worker.service', body && body.unit, 'restart');
    const r = await restartServiceUnit(body && body.unit);
    return send(res, r.ok ? 200 : 500, JSON.stringify(r));
  }
  if (p === '/api/workers/cron' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    audit(session.user, 'worker.cron', body && body.user, `${body && body.oldSchedule} -> ${body && body.newSchedule}`);
    const r = await updateCronSchedule(body && body.user, body && body.oldSchedule, body && body.newSchedule, body && body.cmd, body && body.source);
    return send(res, r.ok ? 200 : 500, JSON.stringify(r));
  }
  if (p === '/api/workers/log') {
    const file = url.searchParams.get('file');
    const lines = url.searchParams.get('lines') || 100;
    if (isHidden(session, file)) return send(res, 404, JSON.stringify({ ok: false, error: 'Not found' }));
    const r = await tailLog(file, lines);
    return send(res, r.ok ? 200 : 404, JSON.stringify(r));
  }
  if (p === '/api/users' && req.method === 'GET') {
    if (!session.superadmin) return needSuper();
    return send(res, 200, JSON.stringify({ users: auth.listAppUsers() }));
  }
  if (p === '/api/users' && req.method === 'POST') {
    if (!session.superadmin) return needSuper();
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const r = await auth.createAppUser(body && body.username, body && body.password, body && (body.role || (body.admin ? 'admin' : 'viewer')), body && body.hiddenKeywords);
    if (!r.ok) return send(res, 400, JSON.stringify({ error: r.error }));
    audit(session.user, 'user.create', r.user.username, `role=${r.user.role}`);
    return send(res, 200, JSON.stringify(r));
  }
  if (p === '/api/users' && req.method === 'PATCH') {
    if (!session.superadmin) return needSuper();
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const target = String((body && body.username) || '');
    const isSelf = target.toLowerCase() === String(session.user).toLowerCase();
    if (isSelf && (body.disabled === true || body.admin === false || (body.role && body.role !== 'superadmin'))) {
      return send(res, 400, JSON.stringify({ error: 'Cannot demote or disable yourself' }));
    }
    // Jangan sampai tidak ada superadmin tersisa (superadmin terakhir tidak boleh di-demote/disable).
    const all = auth.listAppUsers();
    const tgt = all.find((u) => u.username.toLowerCase() === target.toLowerCase());
    const demoting = tgt && tgt.role === 'superadmin' && !tgt.disabled &&
      ((body.role && body.role !== 'superadmin') || body.admin === false || body.disabled === true);
    if (demoting && all.filter((u) => u.role === 'superadmin' && !u.disabled).length <= 1) {
      return send(res, 400, JSON.stringify({ error: 'Cannot demote or disable the last superadmin' }));
    }
    const r = await auth.updateAppUser(target, { role: body.role, admin: body.role ? undefined : body.admin, hiddenKeywords: body.hiddenKeywords, disabled: body.disabled, password: body.password });
    if (!r.ok) return send(res, 400, JSON.stringify({ error: r.error }));
    audit(session.user, 'user.update', r.user.username, `role=${r.user.role}`);
    return send(res, 200, JSON.stringify(r));
  }
  if (p === '/api/users' && req.method === 'DELETE') {
    if (!session.superadmin) return needSuper();
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const target = String((body && body.username) || '');
    if (target.toLowerCase() === String(session.user).toLowerCase()) {
      return send(res, 400, JSON.stringify({ error: 'Cannot delete yourself' }));
    }
    const r = auth.deleteAppUser(target);
    if (!r.ok) return send(res, 400, JSON.stringify({ error: r.error }));
    audit(session.user, 'user.delete', target);
    return send(res, 200, JSON.stringify(r));
  }
  if (p === '/api/history') {
    const limit = Math.min(8640, Math.max(10, parseInt(url.searchParams.get('limit') || '720', 10)));
    return send(res, 200, JSON.stringify({ intervalMs: SAMPLE_INTERVAL_MS, points: history.slice(-limit) }));
  }
  if (p === '/api/activity/track' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req, 2048)); } catch { return send(res, 204, ''); }
    const action = String((body && body.action) || '').slice(0, 24).replace(/[^\w.]/g, '');
    if (action) logActivity(session.user, 'ui.' + action, body && body.target, body && body.details);
    return send(res, 204, '');
  }
  if (p === '/api/activity' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    const limit = Math.min(1000, Math.max(10, parseInt(url.searchParams.get('limit') || '200', 10)));
    const qUser = String(url.searchParams.get('user') || '').toLowerCase();
    const qAction = String(url.searchParams.get('action') || '').toLowerCase();
    const qSearch = String(url.searchParams.get('search') || '').toLowerCase();
    let rows = activity;
    if (qUser) rows = rows.filter((a) => String(a.user).toLowerCase().includes(qUser));
    if (qAction) rows = rows.filter((a) => String(a.action).toLowerCase().includes(qAction));
    if (qSearch) rows = rows.filter((a) => (a.target + ' ' + a.details).toLowerCase().includes(qSearch));
    if (hiddenKeywordsFor(session).length) rows = rows.filter((a) => !isHidden(session, [a.target, a.details]));
    const out = rows.slice(-limit).reverse();
    return send(res, 200, JSON.stringify({ total: rows.length, entries: out }));
  }
  if (p === '/api/backups' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    const info = filterBackupInfo(session, getBackupInfo());
    return send(res, 200, JSON.stringify(info));
  }
  if (p === '/api/backups/run' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    audit(session.user, 'backup.run', 'mysql');
    const r = startManualBackup();
    return send(res, r.ok ? 200 : 500, JSON.stringify(r));
  }
  if (p === '/api/backups/status' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    return send(res, 200, JSON.stringify(backupStatus()));
  }
  if (p === '/api/backups/databases' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    const r = await listDatabases(session);
    return send(res, r.ok ? 200 : 500, JSON.stringify(r));
  }
  if (p === '/api/backups/dump' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    const db = url.searchParams.get('db') || '';
    // Harus ada di daftar yang boleh dilihat user ini (sudah memfilter hidden keywords + DB sistem).
    const list = await listDatabases(session);
    if (!list.ok || !list.databases.some((d) => d.name === db)) return send(res, 404, 'Database not found', 'text/plain');
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const filename = `${db}_dump_${stamp}.sql.gz`;
    audit(session.user, 'database.dump', db);
    const dump = spawn('mysqldump', ['--single-transaction', '--routines', '--triggers', '--events', '--no-tablespaces', db], { stdio: ['ignore', 'pipe', 'pipe'] });
    const gz = zlib.createGzip();
    let started = false;
    let errText = '';
    const head = () => { if (!started) { started = true; res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${filename}"` }); } };
    dump.stderr.on('data', (d) => { errText = (errText + d).slice(-2000); });
    dump.on('error', (e) => { if (!started) send(res, 500, 'mysqldump gagal: ' + e.message, 'text/plain'); else res.destroy(); });
    gz.on('data', (chunk) => { head(); res.write(chunk); });
    // Akhiri response hanya bila mysqldump sukses; bila gagal, putus koneksi supaya tidak tampak sebagai dump utuh.
    const gzDone = new Promise((r) => gz.on('end', r));
    dump.on('close', async (code) => {
      if (code !== 0) {
        console.log(`[DUMP] ${db} exit=${code} ${errText}`);
        gz.destroy();
        return started ? res.destroy() : send(res, 500, 'mysqldump gagal: ' + errText.trim(), 'text/plain');
      }
      await gzDone;
      head();
      res.end();
    });
    req.on('close', () => { try { dump.kill(); } catch {} });
    dump.stdout.pipe(gz);
    return;
  }
  if (p === '/api/backups/download') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    const rel = url.searchParams.get('file');
    if (!rel || typeof rel !== 'string' || rel.includes('..') || rel.includes('\0')) {
      return send(res, 400, 'Invalid backup file path', 'text/plain');
    }
    if (isHidden(session, rel)) return send(res, 404, 'Backup file not found', 'text/plain');
    const root = getBackupRootDir();
    if (!root) return send(res, 404, 'Backup storage not configured', 'text/plain');
    const full = path.normalize(path.join(root, rel));
    if (!full.startsWith(root + path.sep) && full !== root) {
      return send(res, 400, 'Invalid backup file path', 'text/plain');
    }
    // Tolak symlink yang keluar dari root (path.join + startsWith tidak resolve symlink).
    let real = null;
    try { real = fs.realpathSync(full); } catch { return send(res, 404, 'Backup file not found', 'text/plain'); }
    let realRoot = root;
    try { realRoot = fs.realpathSync(root); } catch {}
    if (!real.startsWith(realRoot + path.sep) && real !== realRoot) {
      return send(res, 400, 'Invalid backup file path', 'text/plain');
    }
    if (!fs.existsSync(real) || fs.statSync(real).isDirectory()) {
      return send(res, 404, 'Backup file not found', 'text/plain');
    }
    const stat = fs.statSync(real);
    const filename = path.basename(real);
    audit(session.user, 'backup.download', rel, `size=${stat.size}`);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'Content-Length': stat.size,
    });
    fs.createReadStream(real).pipe(res);
    return;
  }
  if (p === '/api/fs/list') {
    if (!session.superadmin) return needSuper();
    const targetDir = url.searchParams.get('path') || SCAN_ROOT;
    try {
      const data = listFsDirectory(targetDir);
      audit(session.user, 'fs.list', data.current, `entries=${data.entries.length}`);
      return send(res, 200, JSON.stringify(data));
    } catch (err) {
      return send(res, 400, JSON.stringify({ error: err.message }));
    }
  }
  if (p === '/api/fs/read') {
    if (!session.superadmin) return needSuper();
    const targetFile = url.searchParams.get('path');
    if (!targetFile) return send(res, 400, JSON.stringify({ error: 'Path required' }));
    try {
      const data = readFsFile(targetFile);
      audit(session.user, 'fs.read', data.path, `size=${data.size}`);
      return send(res, 200, JSON.stringify(data));
    } catch (err) {
      return send(res, 400, JSON.stringify({ error: err.message }));
    }
  }
  if (p === '/api/fs/download') {
    if (!session.superadmin) return needSuper();
    const target = safeFsPath(url.searchParams.get('path'));
    if (!target || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      return send(res, 404, 'File not found', 'text/plain');
    }
    const filename = path.basename(target);
    const stat = fs.statSync(target);
    audit(session.user, 'fs.download', target, `size=${stat.size}`);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'Content-Length': stat.size,
    });
    fs.createReadStream(target).pipe(res);
    return;
  }
  if (p === '/api/git/projects') {
    const projects = getGitProjects().filter((x) => !isHidden(session, [x.name, x.relPath]));
    const safe = projects.map(({ path: _p, ...rest }) => rest); // hide absolute path
    return send(res, 200, JSON.stringify({ time: Date.now(), scanRoot: SCAN_ROOT, projects: safe }));
  }
  if (p === '/api/git/seeders') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    const rel = url.searchParams.get('relPath');
    if (isHidden(session, rel)) return send(res, 404, JSON.stringify({ error: 'Not found' }));
    const pr = resolveGitProject(rel);
    if (pr.error) return send(res, 400, JSON.stringify({ error: pr.error }));
    return send(res, 200, JSON.stringify({ seeders: listSeeders(pr.full) }));
  }
  if (p === '/api/git/env' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    const rel = url.searchParams.get('relPath');
    if (isHidden(session, rel)) return send(res, 404, JSON.stringify({ error: 'Not found' }));
    audit(session.user, 'git.env.read', rel);
    const r = readProjectEnv(rel);
    return send(res, r.ok ? 200 : 400, JSON.stringify(r));
  }
  if (p === '/api/git/env' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    if (isHidden(session, body && body.relPath)) return send(res, 404, JSON.stringify({ error: 'Not found' }));
    audit(session.user, 'git.env.save', body && body.relPath);
    const r = await saveProjectEnv(body && body.relPath, body && body.content);
    return send(res, r.ok ? 200 : 500, JSON.stringify(r));
  }
  if (p === '/api/git/seed' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    if (isHidden(session, body && body.relPath)) return send(res, 404, JSON.stringify({ error: 'Not found' }));
    audit(session.user, 'git.seed', body && body.relPath, Array.isArray(body && body.classes) ? body.classes.join(',') : '');
    const r = await runSeeders(body && body.relPath, body && body.classes);
    return send(res, r.ok ? 200 : 500, JSON.stringify(r));
  }
  if (p === '/api/git/composer' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    if (isHidden(session, body && body.relPath)) return send(res, 404, JSON.stringify({ error: 'Not found' }));
    audit(session.user, 'git.composer', body && body.relPath, 'composer update');
    const r = await runComposerUpdate(body && body.relPath);
    return send(res, r.ok ? 200 : 500, JSON.stringify(r));
  }
  if (p === '/api/git/terminal' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    if (isHidden(session, body && body.relPath)) return send(res, 404, JSON.stringify({ error: 'Not found' }));
    audit(session.user, 'git.terminal', body && body.relPath, String((body && body.command) || '').slice(0, 200));
    const r = await runTerminalCommand(body && body.relPath, body && body.command);
    return send(res, r.ok ? 200 : 500, JSON.stringify(r));
  }
  if (p === '/api/git/pull' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const rel = body && body.relPath;
    if (typeof rel !== 'string' || !rel || rel.includes('..') || rel.startsWith('/')) {
      return send(res, 400, JSON.stringify({ error: 'Invalid project' }));
    }
    const full = path.normalize(path.join(SCAN_ROOT, rel));
    if (!full.startsWith(SCAN_ROOT + path.sep) && full !== SCAN_ROOT) {
      return send(res, 400, JSON.stringify({ error: 'Invalid project' }));
    }
    audit(session.user, 'git.pull', rel);
    const r = await pullGitProject(full);
    if (!r.ok) return send(res, 500, JSON.stringify(r));
    return send(res, 200, JSON.stringify(r));
  }

  if (p === '/api/deploy' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req, 65536)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const fwEarly = body.framework === 'wordpress' ? 'wordpress' : (body.framework === 'wordpress-theme' ? 'wordpress-theme' : 'laravel');
    const checks = [
      ['dir', vDir(body.dir)], ['domain', vDomain(body.domain)],
      ['deployer', vLinuxUser(body.deployer)],
      ['dbName', vDbIdent(body.dbName, 'Nama database', 64)], ['dbUser', vDbIdent(body.dbUser, 'User database', 32)],
    ];
    // Mode wordpress-theme tidak pakai repo site (core fresh dari wordpress.org).
    if (fwEarly !== 'wordpress-theme') checks.splice(2, 0, ['repo', vRepo(body.repo)], ['branch', vBranch(body.branch)]);
    for (const [k, c] of checks) if (!c.ok) return send(res, 400, JSON.stringify({ error: `${k}: ${c.error}` }));
    if (typeof body.dbPass !== 'string' || body.dbPass.length < 8) return send(res, 400, JSON.stringify({ error: 'dbPass: minimal 8 karakter' }));
    if (/[\r\n\0]/.test(body.dbPass)) return send(res, 400, JSON.stringify({ error: 'dbPass tidak boleh ada baris baru' }));
    // Samakan dengan policy MySQL validate_password MEDIUM + check_user_name (cek di awal agar gagal cepat, bukan di tengah deploy).
    {
      const pw = body.dbPass;
      const need = [];
      if (!/[a-z]/.test(pw)) need.push('huruf kecil');
      if (!/[A-Z]/.test(pw)) need.push('huruf besar');
      if (!/[0-9]/.test(pw)) need.push('angka');
      if (!/[^A-Za-z0-9]/.test(pw)) need.push('karakter spesial');
      if (need.length) return send(res, 400, JSON.stringify({ error: `dbPass kurang: ${need.join(', ')} (syarat MySQL MEDIUM)` }));
      const low = pw.toLowerCase();
      for (const u of [String(body.dbUser || '').toLowerCase(), String(body.dbName || '').toLowerCase()]) {
        if (u && u.length >= 4 && low.includes(u)) return send(res, 400, JSON.stringify({ error: 'dbPass tidak boleh mengandung nama user/database (ditolak MySQL)' }));
      }
    }
    const projectType = body.projectType === 'existing' ? 'existing' : 'new';
    const sqlPath = projectType === 'existing' ? String(body.sqlPath || '').trim() : '';
    if (projectType === 'existing') {
      const c = vAbsPath(sqlPath, 'Path SQL');
      if (!c.ok) return send(res, 400, JSON.stringify({ error: c.error }));
      if (!/\.(sql|sql\.gz)$/i.test(sqlPath)) return send(res, 400, JSON.stringify({ error: 'File SQL harus .sql / .sql.gz' }));
      if (!fs.existsSync(sqlPath)) return send(res, 400, JSON.stringify({ error: `File SQL tidak ada: ${sqlPath}` }));
    }
    const envExtra = {};
    for (const line of String(body.envExtra || '').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 1) return send(res, 400, JSON.stringify({ error: `envExtra baris salah (KEY=VALUE): ${t.slice(0, 40)}` }));
      const k = t.slice(0, i).trim();
      if (!/^[A-Z][A-Z0-9_]*$/.test(k) || ['APP_URL', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD', 'APP_KEY'].includes(k)) {
        return send(res, 400, JSON.stringify({ error: `envExtra key tidak valid / reserved: ${k}` }));
      }
      envExtra[k] = t.slice(i + 1).trim();
    }
    const mailIn = (body.mail && typeof body.mail === 'object') ? body.mail : {};
    const mail = {
      mailer: mailIn.mailer === 'smtp' ? 'smtp' : 'log',
      scheme: String(mailIn.scheme || '').trim().slice(0, 20),
      host: String(mailIn.host || '').trim().slice(0, 253),
      port: String(mailIn.port || '').trim(),
      username: String(mailIn.username || ''),
      password: String(mailIn.password || ''),
      fromAddress: String(mailIn.fromAddress || '').trim().slice(0, 253),
      fromName: String(mailIn.fromName || '').trim().slice(0, 100),
    };
    if (mail.port && !/^\d{1,5}$/.test(mail.port)) return send(res, 400, JSON.stringify({ error: 'SMTP port harus angka' }));
    if (mail.host && !/^[A-Za-z0-9.-]+$/.test(mail.host)) return send(res, 400, JSON.stringify({ error: 'SMTP host tidak valid' }));
    const framework = fwEarly;
    let tablePrefix = 'wp_', wpTitle = null, wpAdminUser = null, wpAdminEmail = null, wpAdminPass = null;
    let themeRepo = null, themeFolder = null, themeBranch = 'main';
    const isWP = framework === 'wordpress' || framework === 'wordpress-theme';
    if (isWP) {
      tablePrefix = String(body.tablePrefix || 'wp_').trim() || 'wp_';
      if (!/^[A-Za-z0-9_]+$/.test(tablePrefix) || tablePrefix.length > 20) return send(res, 400, JSON.stringify({ error: 'Table prefix hanya huruf/angka/_ (maks 20)' }));
      if (!tablePrefix.endsWith('_')) tablePrefix += '_';
      if (projectType === 'new') {
        wpTitle = String(body.wpTitle || '').trim().slice(0, 100);
        wpAdminUser = String(body.wpAdminUser || '').trim();
        wpAdminEmail = String(body.wpAdminEmail || '').trim();
        wpAdminPass = String(body.wpAdminPass || '');
        if (!wpTitle) return send(res, 400, JSON.stringify({ error: 'Site title wajib (WordPress baru)' }));
        if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(wpAdminUser)) return send(res, 400, JSON.stringify({ error: 'WP admin user 3-32 karakter' }));
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(wpAdminEmail)) return send(res, 400, JSON.stringify({ error: 'WP admin email tidak valid' }));
        if (wpAdminPass.length < 8) return send(res, 400, JSON.stringify({ error: 'WP admin password minimal 8 karakter' }));
      }
    }
    if (framework === 'wordpress-theme') {
      const tr = vRepo(body.themeRepo);
      if (!tr.ok) return send(res, 400, JSON.stringify({ error: `themeRepo: ${tr.error}` }));
      themeRepo = tr.value;
      themeFolder = String(body.themeFolder || '').trim();
      const tf = vDir(themeFolder);
      if (!tf.ok) return send(res, 400, JSON.stringify({ error: `themeFolder: ${tf.error}` }));
      themeFolder = tf.value;
      themeBranch = String(body.themeBranch || 'main').trim() || 'main';
      if (!/^[A-Za-z0-9._/-]+$/.test(themeBranch) || themeBranch.length > 100) return send(res, 400, JSON.stringify({ error: 'Theme branch tidak valid' }));
    }
    const cv = Object.fromEntries(checks.map(([k, c]) => [k, c.value]));
    const params = {
      dir: cv.dir, domain: cv.domain, repo: cv.repo || null, branch: cv.branch || 'main',
      deployer: cv.deployer, dbName: cv.dbName, dbUser: cv.dbUser, dbPass: body.dbPass,
      projectType, sqlPath, appName: String(body.appName || '').trim().slice(0, 100) || null,
      appKey: String(body.appKey || '').trim() || null,
      useQueue: body.useQueue !== false, useScheduler: body.useScheduler !== false,
      dryRun: body.dryRun === true, envExtra, mail,
      framework, tablePrefix, wpTitle, wpAdminUser, wpAdminEmail, wpAdminPass,
      themeRepo, themeFolder, themeBranch,
    };
    const job = newJob('deploy', `${params.dir} (${params.domain})`, [params.dbPass, params.mail.password, params.wpAdminPass].filter(Boolean));
    audit(session.user, 'deploy.start', params.dir, `${params.domain} dryRun=${params.dryRun}`);
    runDeployJob(job, params).catch((e) => { jobStep(job, 'ERROR', 'fail', String((e && e.message) || e)); job.status = 'failed'; });
    return send(res, 200, JSON.stringify({ ok: true, id: job.id }));
  }
  if (p === '/api/deploy/status' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    const job = DEPLOY_JOBS.get(url.searchParams.get('id'));
    if (!job || isHidden(session, job.label)) return send(res, 404, JSON.stringify({ error: 'Job tidak ada (mungkin server restart)' }));
    return send(res, 200, JSON.stringify(jobPublic(job)));
  }
  if (p === '/api/deploy/jobs' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    return send(res, 200, JSON.stringify({ jobs: [...DEPLOY_JOBS.values()].map(jobPublic).filter((j) => !isHidden(session, j.label)) }));
  }
  if (p === '/api/deploy/transfer' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req, 65536)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const t = {
      project: String(body.project || '').trim(), host: String(body.host || '').trim(),
      port: String(body.port || '22').trim(), user: String(body.user || '').trim(),
      authType: body.authType === 'key' ? 'key' : 'password',
      password: String(body.password || ''), src: String(body.src || '').trim(),
    };
    const job = newJob('transfer', `${t.project} <- ${t.user}@${t.host}`, [t.password]);
    audit(session.user, 'transfer.start', t.project, `${t.user}@${t.host}:${t.port}`);
    runTransferJob(job, t).catch((e) => { jobStep(job, 'ERROR', 'fail', String((e && e.message) || e)); job.status = 'failed'; });
    return send(res, 200, JSON.stringify({ ok: true, id: job.id }));
  }
  if (p === '/api/deploy/transfer/status' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    const job = DEPLOY_JOBS.get(url.searchParams.get('id'));
    if (!job || job.type !== 'transfer') return send(res, 404, JSON.stringify({ error: 'Job tidak ada' }));
    return send(res, 200, JSON.stringify({ ...jobPublic(job), transfer: transferStatus(job) }));
  }
  if (p === '/api/deploy/transfer/cancel' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const job = DEPLOY_JOBS.get(body.id);
    if (!job || !job.transfer) return send(res, 404, JSON.stringify({ error: 'Job tidak ada' }));
    await runCmd(`screen -S ${shq(job.transfer.name)} -X quit 2>&1`, { timeout: 15000 });
    job.status = 'cancelled';
    audit(session.user, 'transfer.cancel', job.transfer.name);
    return send(res, 200, JSON.stringify({ ok: true }));
  }

  let file = p === '/' ? '/index.html' : p;
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
  serveFile(res, file);
});

server.listen(PORT, HOST, () => console.log(`vps-monitor on http://${HOST}:${PORT}`));
