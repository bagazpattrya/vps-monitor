'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execSync, exec, execFile, spawn } = require('child_process');
const crypto = require('crypto');
// Node tidak membaca .env otomatis; loadEnvFile tidak menimpa env yang sudah di-set (mis. pm2).
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}
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
const PROC_INTERVAL_MS = 5_000;
const PROC_MAX_SPIKES = 500;
const PROC_SPIKE_SYSTEM = 70;
const PROC_SPIKE_PROCESS = 80;
const SPIKE_QUERY_INTERVAL_MS = 10_000;
const SPIKE_MAX_QUERIES = 10;
const PROC_SPIKES_FILE = path.join(DATA_DIR, 'process-spikes.json');
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

let processSpikes = [];
try {
  if (fs.existsSync(PROC_SPIKES_FILE)) {
    const raw = JSON.parse(fs.readFileSync(PROC_SPIKES_FILE, 'utf8'));
    if (Array.isArray(raw)) processSpikes = raw.slice(-PROC_MAX_SPIKES);
  }
} catch { processSpikes = []; }

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
    const s = fs.statfsSync('/');
    const total = s.blocks * s.bsize;
    const avail = s.bavail * s.bsize;
    const free = s.bfree * s.bsize;
    const used = total - free;
    const pct = total ? (used / total) * 100 : 0;
    const inodesPct = s.files ? ((s.files - s.ffree) / s.files) * 100 : null;
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

function getProcesses(onlyUser = null, limit = 200) {
  let rows = lastProcSnapshot && lastProcSnapshot.rows.length ? lastProcSnapshot.rows : readProcSnapshot();
  if (onlyUser) rows = rows.filter((r) => r.user === onlyUser);
  return rows.slice(0, Math.max(15, Math.min(500, limit)));
}

// ---- live process sampler + CPU spike history ----
let procClockTicks = 100;
try {
  const ticks = parseInt(execSync('getconf CLK_TCK 2>/dev/null', { timeout: 1000 }).toString().trim(), 10);
  if (ticks > 0) procClockTicks = ticks;
} catch {}

let lastProcSnapshot = {
  time: 0,
  rows: [],
  total: 0,
  cores: os.cpus().length,
  intervalMs: PROC_INTERVAL_MS,
  spikeThreshold: PROC_SPIKE_SYSTEM,
};
let procPrev = new Map();
let procSpikesDirty = false;
let passwdCache = { time: 0, map: new Map() };

function uidToName(uid) {
  if (!passwdCache.map.size || Date.now() - passwdCache.time > 60_000) {
    const map = new Map();
    try {
      for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
        const f = line.split(':');
        if (f.length >= 3) map.set(parseInt(f[2], 10), f[0]);
      }
    } catch {}
    passwdCache = { time: Date.now(), map };
  }
  return passwdCache.map.get(Number(uid)) || String(uid);
}

function formatProcDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

function formatProcDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function readProcSnapshot() {
  const now = Date.now();
  let uptime = 0;
  try { uptime = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]) || 0; } catch {}
  const bootMs = now - uptime * 1000;
  const totalMemKb = os.totalmem() / 1024;
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)); } catch { return []; }

  const rows = [];
  const nextPrev = new Map();

  for (const pid of pids) {
    let stat;
    try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { continue; }
    const open = stat.indexOf('(');
    const close = stat.lastIndexOf(')');
    if (open < 0 || close < 0) continue;
    const comm = stat.slice(open + 1, close);
    const f = stat.slice(close + 2).trim().split(/\s+/);
    if (f.length < 20) continue;

    const totalTicks = (parseInt(f[11], 10) || 0) + (parseInt(f[12], 10) || 0);
    const startTicks = parseInt(f[19], 10) || 0;
    const prev = procPrev.get(pid);
    let cpu = 0;
    if (prev && prev.startTicks === startTicks) {
      const dt = (now - prev.t) / 1000;
      if (dt > 0) cpu = Math.max(0, ((totalTicks - prev.totalTicks) / procClockTicks / dt) * 100);
    }
    nextPrev.set(pid, { t: now, totalTicks, startTicks });

    let uid = 0;
    try { uid = fs.statSync(`/proc/${pid}`).uid; } catch {}
    let cmd = comm;
    try {
      const parts = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (parts.length) cmd = parts.join(' ');
    } catch {}
    let rssKb = 0;
    try {
      const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m);
      if (m) rssKb = parseInt(m[1], 10) || 0;
    } catch {}

    const startedAt = bootMs + (startTicks / procClockTicks) * 1000;
    const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
    rows.push({
      pid: String(pid),
      ppid: String(f[1] || ''),
      user: uidToName(uid),
      cpu: Math.round(cpu * 10) / 10,
      mem: Math.round((rssKb / totalMemKb) * 1000) / 10,
      rss: String(rssKb),
      stat: f[0] || '?',
      start: formatProcDate(startedAt),
      elapsed,
      etime: formatProcDuration(elapsed),
      cmd: (cmd || comm).slice(0, 300),
    });
  }

  procPrev = nextPrev;
  return rows;
}

function pickSpikeProc(row) {
  return row ? { pid: row.pid, user: row.user, cpu: row.cpu, mem: row.mem, cmd: row.cmd } : null;
}

function isMysqlProc(row) {
  return Boolean(row) && /^(mysqld|mariadbd)$/.test(path.basename(String(row.cmd || '').split(' ')[0]));
}

// Saat mysqld jadi biang spike, ambil query yang sedang jalan dari PROCESSLIST dan simpan di episode.
// Snapshot hanya sekali per SPIKE_QUERY_INTERVAL_MS; query yang selesai di antara dua snapshot tidak tertangkap.
let spikeQueryBusy = false;
let spikeQueryAt = 0;
async function captureSpikeQueries(ep) {
  if (spikeQueryBusy || Date.now() - spikeQueryAt < SPIKE_QUERY_INTERVAL_MS) return;
  spikeQueryBusy = true;
  spikeQueryAt = Date.now();
  try {
    const r = await getMysqlProcessList(null, 4000);
    if (!r.ok) return;
    const byKey = new Map((ep.queries || []).map((q) => [`${q.user}|${q.db}|${q.info}`, q]));
    for (const row of r.rows) {
      if (!row.info || ['Sleep', 'Daemon', 'Binlog Dump'].includes(row.command)) continue;
      const key = `${row.user}|${row.db}|${row.info.slice(0, 1000)}`;
      const q = byKey.get(key);
      if (q) {
        q.time = Math.max(q.time, row.time);
        q.seen += 1;
      } else {
        byKey.set(key, { user: row.user, host: row.host, db: row.db, state: row.state, time: row.time, seen: 1, info: row.info.slice(0, 1000) });
      }
    }
    ep.queries = [...byKey.values()].sort((a, b) => b.time - a.time).slice(0, SPIKE_MAX_QUERIES);
    procSpikesDirty = true;
  } finally {
    spikeQueryBusy = false;
  }
}

function recordProcessSpike(systemCpu, top) {
  const topProc = top[0] || null;
  const processCpu = topProc ? topProc.cpu : 0;
  if (systemCpu < PROC_SPIKE_SYSTEM && processCpu < PROC_SPIKE_PROCESS) return;

  const now = Date.now();
  const last = processSpikes[processSpikes.length - 1];
  const top5 = top.slice(0, 5).map(pickSpikeProc);
  let ep;

  if (last && now - last.lastSeen < 60_000 && (last.top ? last.top.pid : null) === (topProc ? topProc.pid : null)) {
    ep = last;
    last.lastSeen = now;
    last.durationSec = Math.round((now - last.start) / 1000);
    last.peakCpu = Math.max(last.peakCpu || 0, systemCpu);
    last.peakProcCpu = Math.max(last.peakProcCpu || 0, processCpu);
    if (topProc && processCpu >= (last.top ? last.top.cpu : 0)) {
      last.top = pickSpikeProc(topProc);
      last.top5 = top5;
    }
    last.samples = (last.samples || 1) + 1;
  } else {
    ep = {
      id: String(now),
      start: now,
      lastSeen: now,
      durationSec: 0,
      peakCpu: Math.round(systemCpu * 10) / 10,
      peakProcCpu: Math.round(processCpu * 10) / 10,
      top: pickSpikeProc(topProc),
      top5,
      samples: 1,
    };
    processSpikes.push(ep);
    if (processSpikes.length > PROC_MAX_SPIKES) processSpikes = processSpikes.slice(-PROC_MAX_SPIKES);
  }
  procSpikesDirty = true;
  if (isMysqlProc(topProc)) captureSpikeQueries(ep).catch(() => {});
}

function sampleProcesses() {
  const rows = readProcSnapshot();
  if (!rows.length) return;
  const sorted = rows.slice().sort((a, b) => b.cpu - a.cpu);
  const systemCpu = Number(lastStats && lastStats.cpu ? lastStats.cpu.pct : 0) || 0;
  const hadBaseline = Boolean(lastProcSnapshot.time);
  lastProcSnapshot = {
    time: Date.now(),
    rows: sorted,
    total: rows.length,
    cores: os.cpus().length,
    intervalMs: PROC_INTERVAL_MS,
    spikeThreshold: PROC_SPIKE_SYSTEM,
  };
  if (hadBaseline) recordProcessSpike(systemCpu, sorted);
}

setInterval(() => {
  if (!procSpikesDirty) return;
  try {
    fs.writeFileSync(PROC_SPIKES_FILE, JSON.stringify(processSpikes.slice(-PROC_MAX_SPIKES)));
    procSpikesDirty = false;
  } catch {}
}, 60_000).unref();

const SERVICES = ['nginx', 'mysql', 'php8.4-fpm', 'mosquitto', 'redis-server', 'ssh', 'cron', 'supervisor'];
let servicesCache = { time: 0, data: [] };
function getServices() {
  const now = Date.now();
  if (servicesCache.data.length && now - servicesCache.time < 5000) return servicesCache.data;
  try {
    const lines = execSync(`systemctl is-active ${SERVICES.join(' ')} 2>&1 || true`, { timeout: 2000 }).toString().trim().split('\n');
    servicesCache.data = SERVICES.map((s, i) => {
      const st = (lines[i] || '').trim();
      return { name: s, active: st === 'active', status: st || 'unknown' };
    });
    servicesCache.time = now;
  } catch {
    if (!servicesCache.data.length) {
      servicesCache.data = SERVICES.map((s) => ({ name: s, active: false, status: 'unknown' }));
    }
  }
  return servicesCache.data;
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

// ---- aggregated project + system error logs ----
const LOG_TAIL_BYTES = 256 * 1024;
const LOG_MAX_SOURCES = 40;
const LOG_MAX_ENTRIES = 2000;
const LOG_MAX_ENTRIES_PER_SOURCE = 400;
const LOG_CACHE_MS = 30_000;
let errorLogsCache = { time: 0, data: null };

const SYSTEM_LOG_FILES = [
  ['/var/log/nginx/error.log', 'nginx/error.log'],
  ['/var/log/mysql/error.log', 'mysql/error.log'],
  ['/var/log/mysqld.log', 'mysqld.log'],
  ['/var/log/supervisor/supervisord.log', 'supervisor/supervisord.log'],
];

function readLogTail(file, maxBytes = LOG_TAIL_BYTES) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0) return '';
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    let text = buf.toString('utf8');
    if (st.size > len) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text;
  } catch { return ''; }
}

function discoverLogSources() {
  const out = [];
  const seen = new Set();

  function add(file, meta) {
    let st;
    try { st = fs.statSync(file); } catch { return; }
    if (!st.isFile() || st.size === 0) return;
    const key = path.resolve(file);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...meta, path: file, bytes: st.size, mtime: st.mtimeMs });
  }

  for (const p of getGitProjects()) {
    for (const sub of ['storage/logs', 'logs']) {
      const dir = path.join(p.path, sub);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.log')) continue;
        const rel = path.posix.join(String(p.relPath || p.name).split(path.sep).join('/'), sub, name);
        add(path.join(dir, name), {
          id: 'project:' + rel,
          project: p.name,
          source: sub + '/' + name,
          system: false,
        });
      }
    }
  }

  // Beberapa instalasi menjalankan panel tanpa memuat .env; tetap cakup workspace utama.
  const fallbackRoot = '/home/zae/Codingan';
  if (SCAN_ROOT !== fallbackRoot && fs.existsSync(fallbackRoot)) {
    for (const dir of scanGitDirs(fallbackRoot, 6)) {
      const project = path.basename(dir);
      for (const sub of ['storage/logs', 'logs']) {
        const logDir = path.join(dir, sub);
        let names = [];
        try { names = fs.readdirSync(logDir); } catch { continue; }
        for (const name of names) {
          if (!name.endsWith('.log')) continue;
          const rel = path.posix.join('Codingan', path.relative(fallbackRoot, dir).split(path.sep).join('/'), sub, name);
          add(path.join(logDir, name), {
            id: 'project:' + rel,
            project,
            source: sub + '/' + name,
            system: false,
          });
        }
      }
    }
  }

  for (const f of LARAVEL_LOG_CANDIDATES) {
    add(f, { id: 'laravel:' + path.basename(f), project: 'Laravel', source: path.basename(f), system: true });
  }

  for (const [file, label] of SYSTEM_LOG_FILES) {
    add(file, { id: 'system:' + label, project: 'System', source: label, system: true });
  }

  for (const dir of ['/var/log/nginx', '/var/log/php', '/var/log']) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/\.log$/i.test(name)) continue;
      if (dir === '/var/log/nginx' && !/^error.*\.log$/i.test(name) && !/^.*error\.log$/i.test(name)) continue;
      if (dir === '/var/log' && !/^php.*(?:-fpm|error).*\.log$/i.test(name)) continue;
      if (dir === '/var/log/php' && !/^.*\.log$/i.test(name)) continue;
      const full = path.join(dir, name);
      const label = (dir === '/var/log' ? '' : dir.replace('/var/log/', '') + '/') + name;
      add(full, { id: 'system:' + label, project: 'System', source: label, system: true });
    }
  }

  return out.sort((a, b) => b.mtime - a.mtime).slice(0, LOG_MAX_SOURCES);
}

function normalizeLogLevel(raw) {
  const k = String(raw || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (k === 'WARN' || k === 'WARNING') return 'WARNING';
  if (k === 'ERROR' || k === 'ERR') return 'ERROR';
  if (k === 'CRIT' || k === 'CRITICAL') return 'CRITICAL';
  if (k === 'ALERT') return 'ALERT';
  if (k === 'EMERG' || k === 'EMERGENCY') return 'EMERGENCY';
  if (k === 'FATAL') return 'CRITICAL';
  return '';
}

const CRITICAL_ERROR_RE = /(SQLSTATE|Uncaught|Fatal(?:Error)?|OutOfMemory|Allowed memory size|Maximum execution time|Deadlock|ECONNREFUSED|Connection refused|No space left|BindingResolutionException|QueryException|ParseError|Segmentation fault|panic|OOMKilled|Could not resolve host)/i;

function isCriticalLogLevel(level, message) {
  if (['EMERGENCY', 'ALERT', 'CRITICAL'].includes(level)) return true;
  return level === 'ERROR' && CRITICAL_ERROR_RE.test(String(message || ''));
}

function parseLogTime(value, fallback) {
  let s = String(value || '').trim().replace(/^\[|\]$/g, '');
  if (!s) return fallback;
  if (/^\d{4}\/\d{2}\/\d{2}/.test(s)) s = s.replace(/\//g, '-');
  s = s.replace(/(\.\d{3})\d+/, '$1');
  let t = Date.parse(s);
  if (Number.isNaN(t)) t = Date.parse(s.replace(' ', 'T'));
  return Number.isNaN(t) ? fallback : t;
}

function makeLogEntry(level, timeStr, message, line, source, fallbackTime, lineIndex = 0) {
  const lvl = normalizeLogLevel(level);
  if (!lvl) return null;
  const t = parseLogTime(timeStr, fallbackTime);
  const msg = String(message || '').trim();
  return {
    sourceId: source.id,
    project: source.project,
    source: source.source,
    system: !!source.system,
    t,
    level: lvl,
    critical: isCriticalLogLevel(lvl, msg),
    message: msg.slice(0, 800),
    detail: String(line || '').slice(0, 8000),
    _start: lineIndex,
    _end: lineIndex,
  };
}

function errorEntryId(entry) {
  const raw = entry.raw || '';
  return crypto.createHash('sha1').update(entry.sourceId + '\n' + raw).digest('hex').slice(0, 16);
}

function parseLogText(text, source) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let cur = null;
  const fallback = source.mtime || Date.now();
  const push = () => {
    if (cur) {
      cur.raw = lines.slice(cur._start, cur._end + 1).join('\n');
      out.push(cur);
    }
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    let m = line.match(/^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?[^\]]*)\]\s+(?:([a-zA-Z0-9_-]+)\.)?([A-Z]+):\s*(.*)/);
    if (m) {
      push();
      cur = makeLogEntry(m[3], m[1], m[4], line, source, fallback, i);
      continue;
    }

    m = line.match(/^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})\s+\[([a-z]+)\]\s*(.*)/i);
    if (m) {
      push();
      cur = makeLogEntry(m[2], m[1], m[3], line, source, fallback, i);
      continue;
    }

    m = line.match(/^\[(\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2})\]\s+([A-Z]+):\s*(.*)/);
    if (m) {
      push();
      cur = makeLogEntry(m[2], m[1], m[3], line, source, fallback, i);
      continue;
    }

    m = line.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s+\d+\s+\[([A-Z]+)\]\s*(.*)/);
    if (m) {
      push();
      cur = makeLogEntry(m[2], m[1], m[3], line, source, fallback, i);
      continue;
    }

    if (line.charAt(0) === '{') {
      let obj = null;
      try { obj = JSON.parse(line); } catch {}
      if (obj && typeof obj === 'object') {
        push();
        const msg = [obj.message, obj.error].filter(Boolean).map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' — ');
        cur = makeLogEntry(obj.level || obj.severity, obj.timestamp || obj.time, msg || line, line, source, fallback, i);
        continue;
      }
    }

    m = line.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+\[?([A-Za-z]+)\]?\s*[:-]?\s*(.*)/);
    if (m) {
      push();
      cur = makeLogEntry(m[2], m[1], m[3], line, source, fallback, i);
      continue;
    }

    m = line.match(/^\[?(ERROR|WARN(?:ING)?|CRITICAL|ALERT|EMERGENCY|FATAL)\]?\b[:\s-]+(.*)/i);
    if (m) {
      push();
      cur = makeLogEntry(m[1], '', m[2], line, source, fallback, i);
      continue;
    }

    if (!cur) continue;
    cur._end = i;
    if (cur.detail.length < 8000) cur.detail += '\n' + line;
  }

  push();
  return out.slice(-LOG_MAX_ENTRIES_PER_SOURCE);
}

function collectErrorLogs(force = false) {
  const now = Date.now();
  if (!force && errorLogsCache.data && now - errorLogsCache.time < LOG_CACHE_MS) return errorLogsCache.data;

  const sources = discoverLogSources();
  const entries = [];
  for (const source of sources) {
    const text = readLogTail(source.path);
    if (text) entries.push(...parseLogText(text, source));
  }
  entries.sort((a, b) => b.t - a.t);

  const data = {
    time: now,
    sources: sources.map((s) => ({
      id: s.id,
      project: s.project,
      source: s.source,
      system: !!s.system,
      bytes: s.bytes,
      mtime: s.mtime,
    })),
    entries: entries.slice(0, LOG_MAX_ENTRIES),
  };
  errorLogsCache = { time: now, data };
  return data;
}

function scrubLogText(text) {
  let s = String(text || '');
  if (SCAN_ROOT) s = s.split(SCAN_ROOT).join('<project-root>');
  if (ROOT) s = s.split(ROOT).join('<app-root>');
  const fallback = '/home/zae/Codingan';
  if (fallback && s.includes(fallback)) s = s.split(fallback).join('<project-root>');
  return s;
}

function buildErrorReport(hours, force = false, session = null) {
  const data = collectErrorLogs(force);
  const since = hours > 0 ? Date.now() - hours * 3600_000 : 0;
  const visibleSources = data.sources.filter((s) => !isHidden(session, [s.project, s.source]));
  const visibleIds = new Set(visibleSources.map((s) => s.id));
  const entries = data.entries
    .filter((e) => visibleIds.has(e.sourceId) && (!since || e.t >= since))
    .filter((e) => !isHidden(session, [e.project, e.source, e.message, e.detail]));

  const sourceCounts = new Map();
  const summary = { critical: 0, error: 0, warning: 0, total: entries.length };
  for (const e of entries) {
    if (e.critical) summary.critical++;
    if (e.level === 'ERROR') summary.error++;
    else if (e.level === 'WARNING') summary.warning++;
    const c = sourceCounts.get(e.sourceId) || { critical: 0, error: 0, warning: 0, total: 0 };
    c.total++;
    if (e.critical) c.critical++;
    if (e.level === 'ERROR') c.error++;
    else if (e.level === 'WARNING') c.warning++;
    sourceCounts.set(e.sourceId, c);
  }

  const sources = visibleSources.map((s) => ({
    ...s,
    counts: sourceCounts.get(s.id) || { critical: 0, error: 0, warning: 0, total: 0 },
  }));
  summary.activeSources = sources.filter((s) => s.counts.total > 0).length;

  return {
    time: Date.now(),
    generatedAt: data.time,
    windowHours: hours,
    scannedSources: visibleSources.length,
    summary,
    sources,
    entries: entries.slice(0, 500).map((e) => ({
      id: errorEntryId(e),
      sourceId: e.sourceId,
      t: e.t,
      level: e.level,
      critical: e.critical,
      project: e.project,
      source: e.source,
      message: scrubLogText(e.message),
      detail: scrubLogText(e.detail),
    })),
  };
}

function deleteErrorEntries(ids, session) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string').slice(0, 200));
  const result = { ok: true, deleted: 0, failed: [] };
  if (!wanted.size) return result;

  const data = collectErrorLogs(true);
  const byId = new Map(discoverLogSources().map((s) => [s.id, s]));
  const targets = new Map();
  for (const e of data.entries) {
    const id = errorEntryId(e);
    if (!wanted.has(id) || isHidden(session, [e.project, e.source, e.message, e.detail])) continue;
    if (!byId.has(e.sourceId)) continue;
    if (!targets.has(e.sourceId)) targets.set(e.sourceId, new Set());
    targets.get(e.sourceId).add(id);
  }

  for (const [sourceId, targetIds] of targets) {
    const src = byId.get(sourceId);
    try {
      const st = fs.statSync(src.path);
      if (!st.isFile()) throw new Error('not a regular file');
      if (st.size > 64 * 1024 * 1024) throw new Error('file too large to edit');
      const text = fs.readFileSync(src.path, 'utf8');
      const ranges = parseLogText(text, src)
        .filter((e) => targetIds.has(errorEntryId(e)))
        .map((e) => [e._start, e._end])
        .sort((a, b) => b[0] - a[0]);
      if (!ranges.length) throw new Error('log line not found (file changed)');
      const st2 = fs.statSync(src.path);
      if (st2.size !== st.size || st2.mtimeMs !== st.mtimeMs) throw new Error('log changed during delete, retry');
      const lines = text.split(/\r?\n/);
      for (const [start, end] of ranges) lines.splice(start, end - start + 1);
      fs.writeFileSync(src.path, lines.join('\n'));
      result.deleted += ranges.length;
    } catch (e) {
      result.failed.push({
        source: src.source,
        error: e.code === 'EACCES' || e.code === 'EPERM' ? 'permission denied' : (e.message || 'failed'),
      });
    }
  }
  errorLogsCache = { time: 0, data: null };
  return result;
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

function parseEnvText(txt) {
  const out = {};
  for (const line of String(txt || '').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
function projectDbInfo(full) {
  let env = {};
  try { env = parseEnvText(fs.readFileSync(path.join(full, '.env'), 'utf8')); } catch {}
  return { db: env.DB_DATABASE || '', user: env.DB_USERNAME || '', connection: env.DB_CONNECTION || '' };
}
function isDevProjectName(name) {
  return /(^|[-_.])(dev|development)($|[-_.])/i.test(String(name || '')) || /(dev|development)$/i.test(String(name || ''));
}
function sqlEsc(v) { return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

// Superadmin melihat semuanya; user lain: keyword global + keyword miliknya sendiri.
function hiddenKeywordsFor(session) {
  if (!session || session.superadmin) return [];
  return [...new Set([...GLOBAL_HIDDEN_KEYWORDS, ...(session.hiddenKeywords || [])])];
}
// Keyword dicocokkan sebagai kata utuh, bukan substring: keyword pendek seperti "eo"
// tidak boleh ikut menyembunyikan "neogate" (n-eo-gate). Pemisah = selain huruf/angka.
const KEYWORD_RE_CACHE = new Map();
function keywordRegex(k) {
  let re = KEYWORD_RE_CACHE.get(k);
  if (!re) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`(^|[^a-z0-9])${esc}(?=$|[^a-z0-9])`, 'i');
    KEYWORD_RE_CACHE.set(k, re);
  }
  return re;
}
// true bila nilai (string, atau objek yang di-JSON-kan) mengandung salah satu keyword.
function isHidden(session, value) {
  const kws = hiddenKeywordsFor(session);
  if (!kws.length || value == null) return false;
  const s = (typeof value === 'string' ? value : JSON.stringify(value)).toLowerCase();
  return kws.some((k) => keywordRegex(k).test(s));
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
    const isLaravel = fs.existsSync(path.join(d, 'artisan'));
    const isDev = isDevProjectName(name);
    const base = { name, group, relPath: rel, path: d, remote: '', lastPull: null, isLaravel, isDev };
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
  if (!fs.existsSync(path.join(pr.full, 'artisan'))) return { ok: false, error: 'Bukan project Laravel (artisan tidak ditemukan)' };
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

function findBestSourceMatch(targetName, sources) {
  const cleanTokens = targetName
    .toLowerCase()
    .replace(/(^|[-_.])(dev|development)($|[-_.])/g, ' ')
    .split(/[-_.\s]+/)
    .filter((t) => t.length > 1);
  if (!cleanTokens.length) return null;
  let best = null;
  let bestScore = -1;
  for (const s of sources) {
    if (isDevProjectName(s.name)) continue;
    const sName = s.name.toLowerCase();
    const sTokens = sName.split(/[-_.\s]+/).filter((t) => t.length > 1);
    let score = 0;
    const exactClean = targetName.toLowerCase().replace(/[-_.]?dev[-_.]?/g, '');
    if (sName === exactClean) score += 20;
    let matched = 0;
    for (const token of cleanTokens) {
      if (sTokens.includes(token)) { matched++; score += 5; }
      else if (sName.includes(token)) { matched++; score += 2; }
    }
    score -= Math.abs(sTokens.length - cleanTokens.length);
    if (matched > 0 && score > bestScore) { bestScore = score; best = s.relPath; }
  }
  return best;
}

// Info untuk modal "Sync DB": target (harus dev) + daftar project sumber + saran default.
function getSyncDbInfo(rel) {
  const pr = resolveGitProject(rel);
  if (pr.error) return { ok: false, error: pr.error };
  const targetName = path.basename(pr.full);
  const target = projectDbInfo(pr.full);
  const targetDev = isDevProjectName(targetName);
  const sources = getGitProjects()
    .filter((x) => x.path !== pr.full && x.isLaravel)
    .map((x) => {
      const info = projectDbInfo(x.path);
      return { relPath: x.relPath, name: x.name, db: info.db };
    })
    .filter((x) => x.db)
    .sort((a, b) => a.name.localeCompare(b.name));
  const def = findBestSourceMatch(targetName, sources);
  return { ok: true, target: { relPath: rel, name: targetName, db: target.db, isDev: targetDev }, sources, defaultSource: def };
}

// Salin storage/app/public source -> target. Target dibersihkan dulu (kecuali .gitignore),
// supaya file lama tidak menumpuk jadi duplikat.
async function syncProjectStorage(pr, sp) {
  const src = path.join(sp.full, 'storage', 'app', 'public');
  const dst = path.join(pr.full, 'storage', 'app', 'public');
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return { ok: true, output: 'Storage source tidak ada — dilewati' };
  await runCmd(`mkdir -p ${shq(dst)}`);
  let r = await runCmd(`find ${shq(dst)} -mindepth 1 -depth ! -name .gitignore -delete 2>&1`, { timeout: 120000 });
  if (!r.ok) return { ok: false, error: 'Clean storage target gagal\n' + r.output };
  r = await runCmd(`rsync -a --delete --exclude=.gitignore ${shq(src + '/')} ${shq(dst + '/')} 2>&1`, { timeout: 600000 });
  if (!r.ok) return { ok: false, error: 'Rsync storage gagal\n' + r.output };
  try {
    const st = fs.statSync(pr.full);
    await runCmd(`chown -R ${st.uid}:${st.gid} ${shq(dst)} 2>&1`);
  } catch {}
  return { ok: true, output: 'storage/app/public disalin (target dibersihkan dulu)' };
}

// Copy DB source -> DB target (target dev). Source hanya dibaca via single-transaction dump.
async function syncProjectDb(pr, sp, targetDb, sourceDb, targetUser, opts = {}) {
  const mysql = (sql, timeout) => runFile('mysql', ['-BNe', sql], { timeout: timeout || 15000 });
  const bdir = fs.existsSync('/var/backups/mysql') ? '/var/backups/mysql' : DATA_DIR;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backup = path.join(bdir, `dev-db-sync-${targetDb}-${stamp}.sql.gz`);

  let r = await mysql(`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${sqlEsc(sourceDb)}';`);
  if (!r.ok) return { ok: false, error: 'Cek DB source gagal\n' + r.output };
  if (!r.output.trim()) return { ok: false, error: `DB source ${sourceDb} tidak ditemukan` };

  r = await mysql(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${sqlEsc(targetDb)}';`);
  const hasTarget = r.ok && parseInt(r.output.trim(), 10) > 0;
  if (hasTarget) {
    r = await runFile('bash', ['-o', 'pipefail', '-c', `mysqldump --single-transaction --quick --routines --triggers --events --no-tablespaces ${shq(targetDb)} | gzip > ${shq(backup)}`], { timeout: 600000 });
    if (!r.ok) return { ok: false, error: 'Backup DB target gagal, sync dibatalkan\n' + r.output };
  }

  r = await mysql(`DROP DATABASE IF EXISTS \`${targetDb}\`; CREATE DATABASE \`${targetDb}\`;`);
  if (!r.ok) return { ok: false, error: 'Recreate DB target gagal\n' + r.output };
  if (targetUser) {
    const u = vDbIdent(targetUser, 'DB_USERNAME target', 32);
    if (u.ok) await mysql(`GRANT ALL PRIVILEGES ON \`${targetDb}\`.* TO '${u.value}'@'localhost'; FLUSH PRIVILEGES;`);
  }

  r = await runFile('bash', ['-o', 'pipefail', '-c', `mysqldump --single-transaction --quick --routines --triggers --events --no-tablespaces ${shq(sourceDb)} | mysql ${shq(targetDb)}`], { timeout: 600000 });
  if (!r.ok) return { ok: false, error: 'Import DB gagal. Backup target: ' + backup + '\n' + r.output };

  let output = `Source: ${sourceDb}\nTarget: ${targetDb}\n` + (hasTarget ? `Backup target: ${backup}\n` : 'Target kosong (tidak perlu backup)\n');
  if (opts.syncStorage) {
    const st = await syncProjectStorage(pr, sp);
    if (!st.ok) return { ok: false, error: 'Storage sync gagal (DB sudah terlanjur disalin). ' + st.error };
    output += `\nStorage: ${st.output}`;
  }
  const runArtisan = (args) => (pr.uid !== null && pr.uid !== pr.me)
    ? runFile('sudo', ['-H', '-u', `#${pr.uid}`, 'php', path.join(pr.full, 'artisan'), ...args], { cwd: pr.full, timeout: 120000 })
    : runFile('php', [path.join(pr.full, 'artisan'), ...args], { cwd: pr.full, timeout: 120000 });
  for (const [label, args] of [['migrate --force', ['migrate', '--force']], ['optimize:clear', ['optimize:clear']]]) {
    const q = await runArtisan(args);
    output += `\n--- php artisan ${label} ${q.ok ? '' : '[FAILED] '}---\n${q.output || q.error || ''}`;
  }
  return { ok: true, output: output.trim(), backup: hasTarget ? backup : null };
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
        const isNode = !isLaravel && !isWP && fs.existsSync(path.join(targetPath, 'package.json'));

        // Node.js post-update tasks: npm install + build + pm2 restart
        if (isNode) {
          const dirName = path.basename(targetPath);
          try {
            const npmOut = execSync(`cd "${targetPath}" && sudo -H -u "#${uid}" npm install --omit=dev 2>&1`, { timeout: 120_000 }).toString();
            combined += '\n--- npm install --omit=dev ---\n' + npmOut;
          } catch (nErr) {
            combined += '\n--- npm install [FAILED] ---\n' + (nErr.stdout || nErr.message);
          }
          try {
            const pkg = JSON.parse(fs.readFileSync(path.join(targetPath, 'package.json'), 'utf8'));
            if (pkg.scripts && pkg.scripts.build) {
              const bOut = execSync(`cd "${targetPath}" && sudo -H -u "#${uid}" npm run build 2>&1`, { timeout: 120_000 }).toString();
              combined += '\n--- npm run build ---\n' + bOut;
            }
          } catch {}
          try {
            const pmOut = execSync(`sudo -H -u "#${uid}" pm2 restart "${dirName}" 2>&1 || pm2 restart "${dirName}" 2>&1`, { timeout: 30_000 }).toString();
            combined += `\n--- pm2 restart ${dirName} ---\n` + pmOut;
          } catch (pErr) {
            combined += `\n--- pm2 restart ${dirName} [FAILED] ---\n` + (pErr.stdout || pErr.message);
          }
        }

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
              // + system setting: nama beda per project (SystemSettingSeeder / SettingSeeder)
              const matches = files.filter((f) => /^(roles?|permissions?|roles?.*permissions?|permissions?.*roles?|(system)?settings?)seeder\.php$/i.test(f));
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
        const stashMsg = `auto-panel ${new Date().toISOString()}`;
        const stashCmd = asOwner(`stash push --include-untracked -m "${stashMsg}"`);
        let prep = '';
        if (stuck) {
          for (const a of ['merge --abort', 'rebase --abort', 'cherry-pick --abort', 'reset']) {
            try { prep += `$ git ${a}\n` + execSync(`${asOwner(a)} 2>&1`, { timeout: 15_000 }).toString() + '\n'; }
            catch (e) { prep += `$ git ${a} [skip]\n`; }
          }
        }
        exec(stashCmd, { timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (serr, sstdout, sstderr) => {
          const sout = prep + (sstdout || '') + (sstderr || '');
          // Kalau stash gagal, jangan lanjut: reset --hard di bawah bisa menghapus perubahan lokal.
          if (serr) return resolve({ ok: false, error: 'Gagal menyimpan local changes ke stash: ' + serr.message, output: out + '\n--- autostash ---\n' + sout });
          exec(gitCmd, { timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err2, stdout2, stderr2) => {
            gitCache.time = 0;
            const out2 = out + '\n--- autostash ---\n' + sout + '\n--- retry pull ---\n' + ((stdout2 || '') + (stderr2 || ''));
            if (err2) {
              // Pull kedua juga gagal (mis. conflict dengan perubahan upstream). Jangan tinggalkan
              // merge/rebase belum selesai, karena pull berikutnya akan gagal "unmerged files".
              for (const a of ['merge --abort', 'rebase --abort', 'cherry-pick --abort']) {
                try { execSync(`${asOwner(a)} 2>&1`, { timeout: 15_000 }); } catch {}
              }
              try { execSync(`${asOwner('reset --hard HEAD')} 2>&1`, { timeout: 15_000 }); } catch {}
              gitCache.time = 0;
              return resolve({ ok: false, error: err2.message + ' (perubahan lokal aman di git stash, repo dikembalikan ke kondisi bersih)', output: out2 });
            }
            // Pull berhasil: kembalikan perubahan lokal yang tadi di-stash supaya fix lokal tidak hilang.
            let topStash = '';
            try { topStash = execSync(`${asOwner('stash list -1 --format=%s')} 2>&1`, { timeout: 10_000 }).toString().trim(); } catch {}
            if (!topStash.endsWith(stashMsg)) return resolve(runFix(out2));
            exec(asOwner('stash pop'), { timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (perr, pstdout, pstderr) => {
              gitCache.time = 0;
              let out3 = out2 + '\n--- restore local changes (stash pop) ---\n' + ((pstdout || '') + (pstderr || ''));
              // stash pop yang conflict meninggalkan index unmerged + conflict marker di file.
              // Stash tetap tersimpan, jadi bersihkan working tree agar pull berikutnya tidak gagal.
              if (!perr) {
                let checkOut = '';
                try { execSync(`${asOwner('diff --check')} 2>&1`, { timeout: 10_000 }); }
                catch (e) { checkOut = (e.stdout || '') + (e.stderr || ''); }
                if (/leftover conflict marker/i.test(checkOut)) {
                  perr = new Error('leftover conflict marker');
                  out3 += '\n' + checkOut;
                }
              }
              if (perr) {
                try { execSync(`${asOwner('reset --hard HEAD')} 2>&1`, { timeout: 15_000 }); } catch {}
                gitCache.time = 0;
                return resolve({ ok: false, error: 'Pull berhasil, tapi perubahan lokal tidak bisa digabung otomatis (conflict). Perubahan lokal aman di git stash; repo dikembalikan ke versi hasil pull. Cek repo: ' + targetPath, output: out3 });
              }
              return resolve(runFix(out3));
            });
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
sampleProcesses();
setInterval(sampleProcesses, PROC_INTERVAL_MS);
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

const staticCache = new Map();

function serveFile(req, res, file) {
  const fp = path.join(PUBLIC_DIR, file);
  if (!fp.startsWith(PUBLIC_DIR)) return send(res, 404, 'not found', 'text/plain');
  let st;
  try { st = fs.statSync(fp); } catch { return send(res, 404, 'not found', 'text/plain'); }
  if (st.isDirectory()) return send(res, 404, 'not found', 'text/plain');

  const type = MIME[path.extname(fp)] || 'application/octet-stream';
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }

  let hit = staticCache.get(fp);
  if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
    const raw = fs.readFileSync(fp);
    const compress = /^(text\/|application\/(json|javascript))/.test(type) && raw.length > 1024;
    hit = { mtimeMs: st.mtimeMs, size: st.size, etag, raw, gz: compress ? zlib.gzipSync(raw) : null };
    staticCache.set(fp, hit);
  }

  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag };
  let body = hit.raw;
  if (hit.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
    body = hit.gz;
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(body);
}

let archiveActive = false;

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

// Resolve + validasi path file backup relatif terhadap root. Dipakai download & delete.
// Menolak traversal, symlink keluar root, dan file yang disembunyikan untuk user ini.
function resolveBackupFile(session, rel) {
  if (!rel || typeof rel !== 'string' || rel.includes('..') || rel.includes('\0')) {
    return { error: 'Invalid backup file path', code: 400 };
  }
  if (isHidden(session, rel)) return { error: 'Backup file not found', code: 404 };
  const root = getBackupRootDir();
  if (!root) return { error: 'Backup storage not configured', code: 404 };
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(root + path.sep) && full !== root) return { error: 'Invalid backup file path', code: 400 };
  let real;
  try { real = fs.realpathSync(full); } catch { return { error: 'Backup file not found', code: 404 }; }
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch {}
  if (!real.startsWith(realRoot + path.sep) && real !== realRoot) return { error: 'Invalid backup file path', code: 400 };
  let stat;
  try { stat = fs.statSync(real); } catch { return { error: 'Backup file not found', code: 404 }; }
  if (stat.isDirectory()) return { error: 'Backup file not found', code: 404 };
  return { real, stat, filename: path.basename(real) };
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

// Query MySQL yang sedang berjalan (SHOW PROCESSLIST). Koneksi monitor sendiri dikecualikan.
// Output `mysql -B` meng-escape \n \t \\ di dalam nilai, jadi di-unescape setelah split per-baris.
async function getMysqlProcessList(session, timeout = 8000) {
  const sql = "SELECT ID, USER, SUBSTRING_INDEX(HOST, ':', 1), IFNULL(DB, ''), COMMAND, TIME, IFNULL(STATE, ''), IFNULL(LEFT(INFO, 2000), '') FROM information_schema.PROCESSLIST WHERE ID <> CONNECTION_ID() ORDER BY TIME DESC LIMIT 500";
  const r = await runFile('mysql', ['-BNe', sql], { timeout });
  if (!r.ok) return { ok: false, error: 'Gagal membaca processlist MySQL: ' + r.output.trim().slice(0, 300) };
  const unesc = (v) => v.replace(/\\([nt\\])/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : '\\'));
  const rows = [];
  for (const line of r.output.split('\n')) {
    if (!line) continue;
    const f = line.split('\t');
    if (f.length < 8) continue;
    const row = { id: Number(f[0]), user: f[1], host: f[2], db: f[3], command: f[4], time: Number(f[5]) || 0, state: f[6], info: unesc(f.slice(7).join('\t')) };
    if (session && isHidden(session, [row.db, row.user, row.info])) continue;
    rows.push(row);
  }
  return { ok: true, time: Date.now(), rows };
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
function checkPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(() => resolve(true)); });
    srv.listen(port, '127.0.0.1');
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
function newJob(type, label, secrets, owner) {
  const id = `dep-${Date.now().toString(36)}-${(++deploySeq).toString(36)}`;
  const job = { id, type, label, owner: owner || null, status: 'running', steps: [], secrets: secrets || [], createdAt: Date.now(), logFile: path.join(DATA_DIR, `${id}.log`) };
  DEPLOY_JOBS.set(id, job);
  if (DEPLOY_JOBS.size > 20) { const first = DEPLOY_JOBS.keys().next().value; DEPLOY_JOBS.delete(first); }
  return job;
}
// Job selalu terlihat oleh user yang membuatnya, walaupun labelnya cocok dengan hidden keyword.
// Tanpa ini, keyword pendek seperti "eo" ikut cocok di tengah kata "n-eo-gate" dan job yang
// sedang berjalan mendadak balas 404 "Job tidak ada (mungkin server restart)".
function jobVisible(session, job) {
  if (!job) return false;
  if (job.owner && session && String(job.owner).toLowerCase() === String(session.user).toLowerCase()) return true;
  return !isHidden(session, job.label);
}
function jobPublic(job) {
  return { id: job.id, type: job.type, label: job.label, status: job.status, steps: job.steps, createdAt: job.createdAt, warn: job.warn || null };
}

async function runDeployJob(job, p) {
  const dest = path.join('/var/www', p.dir);
  const isWP = p.framework === 'wordpress' || p.framework === 'wordpress-theme';
  const isNode = p.framework === 'nodejs';
  const mysql = (sql) => runFile('mysql', ['-BNe', sql], { timeout: 15000 });
  const ago = async (prog, args, opts) => runCmd(asUser(p.deployer, prog, args), opts);
  try {
    let r;
    // 1. validasi sudah lolos di handler; cek folder belum ada
    jobStep(job, 'validate', 'running', `dir=${p.dir} domain=${p.domain} repo=${p.repo} branch=${p.branch} deployer=${p.deployer} fw=${p.framework}${isNode ? ` port=${p.nodePort}` : ''}${p.useDb ? ` db=${p.dbName}/${p.dbUser}` : ''}`);
    if (fs.existsSync(dest)) throw new Error(`Folder ${dest} sudah ada`);
    if (isNode && (!p.nodePort || p.nodePort < 1 || p.nodePort > 65535)) throw new Error('Port Node.js harus 1-65535');
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
      if (isNode) {
        jobStep(job, 'dry-run: node + pm2', 'running', '');
        r = await runCmd('node -v 2>&1', { timeout: 15000 });
        if (!r.ok) throw new Error('Node.js belum terinstall di server\n' + r.output);
        const nVer = r.output.trim();
        r = await runCmd('which pm2 2>&1', { timeout: 15000 });
        const pm2Ok = r.ok && !!r.output.trim();
        jobStep(job, 'dry-run: node + pm2', pm2Ok ? 'ok' : 'warn', `Node=${nVer}, PM2=${pm2Ok ? 'OK' : 'belum ada (di-install otomatis)'}`);
        jobStep(job, 'dry-run: port check', 'running', `port ${p.nodePort}`);
        const portFree = await checkPortFree(p.nodePort);
        jobStep(job, 'dry-run: port check', portFree ? 'ok' : 'fail', portFree ? `port ${p.nodePort} bebas (siap dipakai)` : `port ${p.nodePort} sudah digunakan`);
        if (!portFree) throw new Error(`Port ${p.nodePort} sudah digunakan oleh service lain`);
      }
      if (p.useDb) {
        jobStep(job, 'dry-run: mysql', 'running', '');
        r = await mysql('SELECT 1;');
        if (!r.ok) throw new Error('mysql root socket gagal\n' + r.output);
        jobStep(job, 'dry-run: mysql', 'ok', 'root socket OK');
      }
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
    if (p.useDb && p.dbName && p.dbUser && p.dbPass) {
      jobStep(job, 'mysql: create db+user', 'running', '');
      // CREATE IF NOT EXISTS saja tidak cukup: retry dengan password baru harus update password user lama.
      // sqlStr: escape backslash DULU lalu quote — password ber-backslash kalau tidak, MySQL salah parse.
      const sqlStr = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      r = await mysql(`CREATE DATABASE IF NOT EXISTS \`${p.dbName}\`; CREATE USER IF NOT EXISTS '${p.dbUser}'@'localhost' IDENTIFIED BY '${sqlStr(p.dbPass)}'; ALTER USER '${p.dbUser}'@'localhost' IDENTIFIED BY '${sqlStr(p.dbPass)}'; GRANT ALL PRIVILEGES ON \`${p.dbName}\`.* TO '${p.dbUser}'@'localhost'; FLUSH PRIVILEGES;`);
      if (!r.ok) throw new Error('mysql setup gagal\n' + r.output);
      jobStep(job, 'mysql: create db+user', 'ok', 'database + user siap');
    } else {
      jobStep(job, 'mysql: create db+user', 'skip', isNode ? 'tanpa database' : '');
    }

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

    // 4. composer (wajib Laravel; WP hanya bila repo bawa composer.json) / npm (Node.js)
    if (isNode) {
      jobStep(job, 'composer install', 'skip', 'bukan PHP');
      if (!fs.existsSync(path.join(dest, 'package.json'))) throw new Error('package.json tidak ada di repo (bukan project Node.js?)');
      jobStep(job, 'npm install', 'running', '');
      r = await runCmd(`cd ${shq(dest)} && sudo -H -u ${p.deployer} npm install 2>&1`, { timeout: 600000 });
      if (!r.ok) throw new Error('npm install gagal\n' + r.output.slice(-3000));
      jobStep(job, 'npm install', 'ok', r.output.slice(-1500));

      let pkg = {};
      try { pkg = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')); } catch {}
      const hasBuild = p.nodeBuild || (pkg.scripts && pkg.scripts.build);
      if (hasBuild) {
        jobStep(job, 'npm run build', 'running', p.nodeBuild || 'npm run build');
        const bCmd = p.nodeBuild ? `cd ${shq(dest)} && sudo -H -u ${p.deployer} ${p.nodeBuild} 2>&1` : `cd ${shq(dest)} && sudo -H -u ${p.deployer} npm run build 2>&1`;
        r = await runCmd(bCmd, { timeout: 600000 });
        if (!r.ok) throw new Error('npm build gagal\n' + r.output.slice(-3000));
        jobStep(job, 'npm run build', 'ok', r.output.slice(-1500));
      } else {
        jobStep(job, 'npm run build', 'skip', 'tidak ada build script');
      }
    } else if (isWP && !fs.existsSync(path.join(dest, 'composer.json'))) {
      jobStep(job, 'composer install', 'skip', 'tidak ada composer.json');
    } else {
      if (!fs.existsSync(path.join(dest, 'composer.json'))) throw new Error('composer.json tidak ada (bukan project yang didukung?)');
      jobStep(job, 'composer install', 'running', '');
      r = await ago('composer', ['install', `--working-dir=${dest}`, '--no-interaction', '--prefer-dist', '--optimize-autoloader', '--no-dev'], { timeout: 600000 });
      if (!r.ok) throw new Error('composer install gagal\n' + r.output.slice(-3000));
      jobStep(job, 'composer install', 'ok', r.output.slice(-1500));
    }

    // 5. config app: .env (Laravel / Node.js) / wp-config.php (WordPress)
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
    } else if (isNode) {
      jobStep(job, '.env', 'running', '');
      const exPath = path.join(dest, '.env.example');
      let env = fs.existsSync(exPath) ? fs.readFileSync(exPath, 'utf8') : '';
      const envVal = (v) => {
        v = String(v);
        return /[\s#"'\\]/.test(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v;
      };
      const setEnv = (k, v) => {
        const re = new RegExp(`^${k}=.*$`, 'm');
        env = re.test(env) ? env.replace(re, () => `${k}=${v}`) : env + `\n${k}=${v}\n`;
      };
      setEnv('PORT', p.nodePort);
      setEnv('NODE_ENV', 'production');
      setEnv('APP_URL', `https://${p.domain}`);
      if (p.useDb && p.dbName) {
        setEnv('DB_CONNECTION', 'mysql');
        setEnv('DB_HOST', '127.0.0.1');
        setEnv('DB_PORT', '3306');
        setEnv('DB_DATABASE', p.dbName);
        setEnv('DB_USERNAME', p.dbUser);
        setEnv('DB_PASSWORD', envVal(p.dbPass));
        setEnv('DATABASE_URL', envVal(`mysql://${p.dbUser}:${p.dbPass}@127.0.0.1:3306/${p.dbName}`));
      }
      for (const [k, v] of Object.entries(p.envExtra || {})) setEnv(k, v);
      fs.writeFileSync(path.join(dest, '.env'), env);
      await runCmd(`chown ${p.deployer}:www-data ${shq(path.join(dest, '.env'))} && chmod 660 ${shq(path.join(dest, '.env'))}`);
      jobStep(job, '.env', 'ok', `PORT=${p.nodePort}, NODE_ENV=production${p.useDb ? ', DB=' + p.dbName : ''}`);
    } else {
    jobStep(job, '.env', 'running', '');
    const exPath = path.join(dest, '.env.example');
    if (!fs.existsSync(exPath)) throw new Error('.env.example tidak ada (bukan Laravel?)');
    let env = fs.readFileSync(exPath, 'utf8');
    // Quote nilai .env bila mengandung #/spasi/quote/backslash. Password acak bisa mengandung #;
    // tanpa quote phpdotenv memotong nilai di # -> "Access denied" walau import SQL sukses.
    const envVal = (v) => {
      v = String(v);
      return /[\s#"'\\]/.test(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v;
    };
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
    setEnv('DB_PASSWORD', envVal(p.dbPass));
    if (p.appName) setEnv('APP_NAME', `"${p.appName.replace(/"/g, '')}"`);
    const qv = envVal;
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
    if (isNode) {
      if (p.useDb && p.projectType === 'existing' && p.sqlPath) {
        jobStep(job, 'import sql', 'running', p.sqlPath);
        if (!fs.existsSync(p.sqlPath)) throw new Error(`File SQL tidak ada: ${p.sqlPath}`);
        const isGz = p.sqlPath.endsWith('.gz');
        const imp = isGz
          ? `zcat ${shq(p.sqlPath)} | MYSQL_PWD=${shq(p.dbPass)} mysql -u ${shq(p.dbUser)} ${shq(p.dbName)}`
          : `MYSQL_PWD=${shq(p.dbPass)} mysql -u ${shq(p.dbUser)} ${shq(p.dbName)} < ${shq(p.sqlPath)}`;
        r = await runCmd(imp, { timeout: 600000 });
        if (!r.ok) throw new Error('import SQL gagal (cek kredensial DB / file corrupt)\n' + r.output.slice(-3000));
        jobStep(job, 'import sql', 'ok', `import ${p.sqlPath} OK`);
      } else {
        jobStep(job, 'database migrate/seed', 'skip', p.useDb ? 'database siap' : 'tanpa database');
      }
    } else if (isWP && p.projectType === 'new') {
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

    // 7-8. storage:link + optimize + fix perms + gate (Laravel). WP / Node: langsung perms.
    if (isWP || isNode) {
      jobStep(job, 'storage:link + optimize', 'skip', 'bukan Laravel');
    } else {
    jobStep(job, 'storage:link + optimize', 'running', '');
    r = await ago(phpBin(), [path.join(dest, 'artisan'), 'storage:link'], { timeout: 60000 });
    r = await ago(phpBin(), [path.join(dest, 'artisan'), 'optimize:clear'], { timeout: 120000 });
    jobStep(job, 'storage:link + optimize', 'ok', r.output.slice(-1000));
    }
    jobStep(job, 'fix-permissions + gate www-data', 'running', '');
    if (fs.existsSync('/var/www/fix-permissions.sh')) {
      r = await runCmd(`bash /var/www/fix-permissions.sh ${shq(dest)} --user ${shq(p.deployer)} 2>&1`, { timeout: 120000 });
      if (!r.ok) throw new Error('fix-permissions gagal\n' + r.output.slice(-2000));
    }
    await runCmd(`chmod 640 ${shq(path.join(dest, isWP ? 'wp-config.php' : '.env'))} 2>/dev/null || true`);
    if (!isNode) {
      for (const sub of (isWP ? ['wp-content/uploads'] : ['storage', 'bootstrap/cache'])) {
        const wd = shq(path.join(dest, sub));
        await runCmd(`mkdir -p ${wd} && chown ${p.deployer}:www-data ${wd} && chmod 2775 ${wd} && { setfacl -m u:www-data:rwx -m d:u:www-data:rwx ${wd} 2>/dev/null; } || true`);
        const t = path.join(dest, sub, '.writetest-www-data');
        const w = await runCmd(`sudo -n -u www-data touch ${shq(t)} 2>&1 && rm -f ${shq(t)}`, { timeout: 15000 });
        if (!w.ok) throw new Error(`GATE GAGAL: www-data tidak bisa tulis ke ${sub} — deploy dihentikan sebelum go-live\n` + w.output);
      }
      jobStep(job, 'fix-permissions + gate www-data', 'ok', isWP ? 'www-data bisa tulis wp-content/uploads' : 'www-data bisa tulis storage/ + bootstrap/cache');
    } else {
      jobStep(job, 'fix-permissions + gate www-data', 'ok', `permission ${p.deployer}:www-data siap`);
    }

    // 9. DNS
    jobStep(job, 'dns check', 'running', p.domain);
    r = await runCmd(`getent ahosts ${shq(p.domain)} 2>&1 || true`, { timeout: 15000 });
    if (!r.output.trim()) throw new Error(`DNS ${p.domain} belum resolve — buat A record dulu (SOP step 9)`);
    jobStep(job, 'dns check', 'ok', r.output.trim().split('\n')[0]);

    // 10-11. nginx
    jobStep(job, 'nginx vhost', 'running', '');
    const vhost = isNode
      ? `server {\n    listen 80;\n    listen [::]:80;\n    server_name ${p.domain};\n    root ${dest};\n\n    location / {\n        proxy_pass http://127.0.0.1:${p.nodePort};\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_cache_bypass $http_upgrade;\n        proxy_read_timeout 60s;\n    }\n    location ~ /\\.ht {\n        deny all;\n    }\n    client_max_body_size 50M;\n}\n`
      : `server {\n    listen 80;\n    listen [::]:80;\n    server_name ${p.domain};\n    root ${dest}${isWP ? '' : '/public'};\n    index index.php;\n    location / {\n        try_files $uri $uri/ /index.php?$query_string;\n    }\n    location ~ \\.php$ {\n        include snippets/fastcgi-php.conf;\n        fastcgi_pass unix:/run/php/${phpBin()}-fpm.sock;\n    }\n    location ~ /\\.ht {\n        deny all;\n    }\n    client_max_body_size ${isWP ? '200M' : '50M'};\n}\n`;
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

    // 13. PM2 (Node.js) / supervisor worker (Laravel)
    if (isNode) {
      jobStep(job, 'pm2 start', 'running', '');
      let pm2Check = await runCmd('which pm2 2>&1');
      if (!pm2Check.ok || !pm2Check.output.trim()) {
        await runCmd('npm install -g pm2 2>&1', { timeout: 180000 });
      }
      await runCmd(`sudo -H -u ${p.deployer} pm2 delete ${shq(p.dir)} 2>&1 || true`);

      let pkg = {};
      try { pkg = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')); } catch {}

      let startCmd;
      if (fs.existsSync(path.join(dest, 'ecosystem.config.js'))) {
        startCmd = `cd ${shq(dest)} && sudo -H -u ${p.deployer} pm2 start ecosystem.config.js`;
      } else if (p.nodeScript && p.nodeScript.startsWith('npm ')) {
        startCmd = `cd ${shq(dest)} && sudo -H -u ${p.deployer} pm2 start npm --name ${shq(p.dir)} -- ${p.nodeScript.slice(4)}`;
      } else if (p.nodeScript && fs.existsSync(path.join(dest, p.nodeScript))) {
        startCmd = `cd ${shq(dest)} && sudo -H -u ${p.deployer} pm2 start ${shq(p.nodeScript)} --name ${shq(p.dir)}`;
      } else if (pkg.scripts && pkg.scripts.start) {
        startCmd = `cd ${shq(dest)} && sudo -H -u ${p.deployer} pm2 start npm --name ${shq(p.dir)} -- start`;
      } else if (fs.existsSync(path.join(dest, 'server.js'))) {
        startCmd = `cd ${shq(dest)} && sudo -H -u ${p.deployer} pm2 start server.js --name ${shq(p.dir)}`;
      } else if (fs.existsSync(path.join(dest, 'index.js'))) {
        startCmd = `cd ${shq(dest)} && sudo -H -u ${p.deployer} pm2 start index.js --name ${shq(p.dir)}`;
      } else {
        startCmd = `cd ${shq(dest)} && sudo -H -u ${p.deployer} pm2 start npm --name ${shq(p.dir)} -- start`;
      }

      r = await runCmd(startCmd, { timeout: 60000 });
      if (!r.ok) throw new Error('pm2 start gagal\n' + r.output.slice(-2000));
      job.createdPm2 = p.dir;
      await runCmd(`sudo -H -u ${p.deployer} pm2 save 2>&1 || true`);

      let pm2Status = '';
      for (let i = 0; i < 10; i++) {
        await new Promise((s) => setTimeout(s, 2000));
        r = await runCmd(`sudo -H -u ${p.deployer} pm2 jlist 2>&1`, { timeout: 15000 });
        try {
          const list = JSON.parse(r.output);
          const item = list.find((x) => x.name === p.dir);
          if (item && item.pm2_env) {
            pm2Status = item.pm2_env.status;
            if (pm2Status === 'online') break;
          }
        } catch {}
      }
      jobStep(job, 'pm2 start', pm2Status === 'online' ? 'ok' : 'warn', `status=${pm2Status || 'unknown'}`);
      jobStep(job, 'supervisor worker', 'skip', 'Node.js dikelola via PM2');
    } else if (isWP) {
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
    if (isNode) {
      jobStep(job, 'cron scheduler', 'skip', 'Node.js menggunakan PM2');
    } else if (p.useScheduler) {
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
    const permDirs = isWP ? [path.join(dest, 'wp-content')] : (isNode ? [] : [path.join(dest, 'storage'), path.join(dest, 'bootstrap/cache')]);
    if (permDirs.length) {
      r = await runCmd(`find ${permDirs.map(shq).join(' ')} -type d -perm -o+w 2>/dev/null | head`, { timeout: 15000 });
      if (r.output.trim()) throw new Error('Masih ada dir o+writable di storage/bootstrap (harusnya kosong)\n' + r.output);
    }
    jobStep(job, 'verify', 'ok', `https=${httpsCode}${permDirs.length ? ', tidak ada dir o+writable' : ''}`);
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
      if (job.createdPm2 && /^[a-zA-Z0-9._-]+$/.test(job.createdPm2)) {
        await runCmd(`sudo -H -u ${p.deployer} pm2 delete ${shq(job.createdPm2)} 2>&1 || true; sudo -H -u ${p.deployer} pm2 save 2>&1 || true`);
        notes.push(`pm2 ${job.createdPm2} dihapus`);
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
      ? `env SSHPASS=${shq(t.password)} screen -S ${shq(name)} -dm bash -c ${shq(`export SSHPASS; sshpass -e ${rsyncInner}`)}`
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

// ---- hosted sites (nginx sites-enabled + conf.d) ----
const NGINX_SITE_DIRS = (process.env.NGINX_SITE_DIRS || '/etc/nginx/sites-enabled,/etc/nginx/conf.d')
  .split(',').map((x) => x.trim()).filter(Boolean);

// Parser nginx minimal: ambil server{} beserta server_name, listen, ssl, root, dan proxy_pass/fastcgi_pass di location.
function parseNginxServers(text) {
  const servers = [];
  const stack = [];
  let cur = null, curDepth = 0;
  const src = String(text).replace(/#.*$/gm, '');
  const re = /([^;{}]*)([;{}])/g;
  let m;
  while ((m = re.exec(src))) {
    const stmt = m[1].trim(), d = m[2];
    if (d === '{') {
      stack.push(stmt);
      if (!cur && stmt === 'server') {
        cur = { names: [], listens: [], ssl: false, root: '', upstream: '', type: '', redirect: false, defaultServer: false };
        curDepth = stack.length;
      }
    } else if (d === '}') {
      stack.pop();
      if (cur && stack.length < curDepth) { servers.push(cur); cur = null; }
    } else if (cur && stmt) {
      const [name, ...args] = stmt.split(/\s+/);
      const atServer = stack.length === curDepth;
      if (atServer && name === 'server_name') cur.names.push(...args);
      else if (atServer && name === 'listen') {
        cur.listens.push(args.join(' '));
        if (args.includes('ssl')) cur.ssl = true;
        if (args.includes('default_server')) cur.defaultServer = true;
      }
      else if (name === 'ssl_certificate') cur.ssl = true;
      else if (name === 'root' && !cur.root) cur.root = args[0] || '';
      else if (atServer && name === 'return' && /^30[1278]$/.test(args[0] || '')) cur.redirect = true;
      else if (name === 'proxy_pass' && !cur.upstream) { cur.upstream = args[0] || ''; cur.type = 'proxy'; }
      else if (name === 'fastcgi_pass' && !cur.upstream) { cur.upstream = args[0] || ''; cur.type = 'php'; }
    }
  }
  return servers;
}

// Satu baris per file config (certbot memecah satu situs jadi blok 443 + blok redirect 80, digabung di sini).
function getHostedSites() {
  const sites = [];
  for (const dir of NGINX_SITE_DIRS) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files.sort()) {
      if (f.startsWith('.') || f.endsWith('.bak') || f.endsWith('~')) continue;
      const full = path.join(dir, f);
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { sites.push({ id: full, file: f, dir, domains: [], broken: true, error: 'Config tidak bisa dibaca (symlink putus / permission)' }); continue; }
      const servers = parseNginxServers(text);
      if (!servers.length) continue; // bukan file vhost (mis. conf.d/*.conf berisi upstream saja)
      const domains = [...new Set(servers.flatMap((s) => s.names).filter((n) => n && n !== '_'))];
      const withContent = servers.find((s) => s.type) || servers.find((s) => s.root) || servers[0];
      const root = (servers.find((s) => s.root) || {}).root || '';
      const ports = [...new Set(servers.flatMap((s) => s.listens).map((l) => (l.match(/(\d{2,5})(?:\s|$)/) || [])[1]).filter(Boolean))];
      sites.push({
        id: full,
        file: f,
        dir,
        domains,
        ssl: servers.some((s) => s.ssl),
        ports,
        type: withContent.type || (root ? 'static' : (servers.every((s) => s.redirect) ? 'redirect' : 'other')),
        root,
        rootExists: root ? fs.existsSync(root) : null,
        upstream: withContent.upstream || '',
        defaultServer: servers.some((s) => s.defaultServer),
      });
    }
  }
  return sites;
}

// ---- site status probe ----
// HTTP dicek langsung ke nginx lokal (127.0.0.1) dengan header Host = domain, jadi hasilnya
// menggambarkan nginx + aplikasi di VPS ini, bukan DNS/CDN. DNS dicek terpisah.
const SITE_DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const visitableDomains = (site) => (site.domains || []).filter((d) => SITE_DOMAIN_RE.test(d));

function probeLocalHttp(site, domain) {
  return new Promise((resolve) => {
    const started = Date.now();
    const ports = site.ports || [];
    const useTls = !!site.ssl && (ports.includes('443') || !ports.length);
    const port = useTls ? 443 : parseInt(ports.includes('80') ? '80' : (ports[0] || '80'), 10);
    const mod = useTls ? require('https') : http;
    const r = mod.request({ host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 5000, headers: { Host: domain, 'User-Agent': 'vps-monitor-probe', Connection: 'close' }, ...(useTls ? { servername: domain, rejectUnauthorized: false } : {}) }, (resp) => {
      resp.destroy();
      resolve({ status: resp.statusCode, ms: Date.now() - started });
    });
    r.on('timeout', () => { r.destroy(); resolve({ error: 'timeout', ms: Date.now() - started }); });
    r.on('error', (e) => resolve({ error: (e && e.code) || 'error', ms: Date.now() - started }));
    r.end();
  });
}

async function resolvesDomain(domain) {
  try {
    const r = await Promise.race([
      require('dns').promises.lookup(domain, { all: true }),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), 3000)),
    ]);
    return { ok: r.length > 0, ips: r.map((x) => x.address) };
  } catch (e) {
    return { ok: false, ips: [], unknown: !(e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA')) };
  }
}

async function probeSite(site) {
  const out = { id: site.id, reasons: [] };
  if (site.broken) { out.state = 'down'; out.reasons.push('config rusak'); out.inactive = true; return out; }
  const domains = visitableDomains(site);
  if (!domains.length) { out.state = 'unknown'; out.inactive = false; return out; }
  const [http1, dnsRes] = await Promise.all([probeLocalHttp(site, domains[0]), Promise.all(domains.map(resolvesDomain))]);
  out.http = http1;
  out.ips = [...new Set(dnsRes.flatMap((d) => d.ips))];
  out.dns = dnsRes.some((d) => d.ok) ? 'ok' : (dnsRes.every((d) => d.unknown) ? 'unknown' : 'none');
  if (http1.error) { out.state = 'down'; out.reasons.push('nginx tidak merespons (' + http1.error + ')'); }
  else if (http1.status >= 500) { out.state = 'down'; out.reasons.push('HTTP ' + http1.status + ' (backend bermasalah)'); }
  else if (http1.status >= 400) out.state = 'warn';
  else out.state = 'up';
  if (out.dns === 'none') out.reasons.push('domain tidak resolve di DNS');
  if (site.rootExists === false) out.reasons.push('folder root tidak ada');
  out.inactive = out.state === 'down' || out.dns === 'none' || site.rootExists === false;
  return out;
}

async function probeSites(sites) {
  const results = [];
  for (let i = 0; i < sites.length; i += 6) results.push(...await Promise.all(sites.slice(i, i + 6).map(probeSite)));
  return results;
}

// ---- site delete (backup config -> hapus -> nginx -t -> reload; rollback bila nginx -t gagal) ----
const REMOVED_SITES_DIR = path.join(DATA_DIR, 'removed-sites');
const NGINX_AVAILABLE_DIR = process.env.NGINX_AVAILABLE_DIR || '/etc/nginx/sites-available';
const NGINX_ENABLED_DIR = process.env.NGINX_ENABLED_DIR || '/etc/nginx/sites-enabled';

async function deleteHostedSite(site) {
  if ((site.upstream || '').match(new RegExp(`(127\\.0\\.0\\.1|localhost|\\[::1\\]):${PORT}(\\D|$)`))) {
    return { ok: false, status: 400, error: 'Ini vhost panel monitor ini sendiri, tidak boleh dihapus dari sini' };
  }
  const full = site.id;
  let isLink = false, linkTarget = null, realTarget = null, text = null;
  try { isLink = fs.lstatSync(full).isSymbolicLink(); } catch (e) { return { ok: false, error: 'File config tidak ditemukan' }; }
  if (isLink) {
    try { linkTarget = fs.readlinkSync(full); } catch {}
    try { realTarget = fs.realpathSync(full); } catch {}
  }
  try { text = fs.readFileSync(full, 'utf8'); } catch {}

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  let backup = null;
  try {
    fs.mkdirSync(REMOVED_SITES_DIR, { recursive: true, mode: 0o700 });
    backup = path.join(REMOVED_SITES_DIR, `${stamp}-${site.file}`);
    fs.writeFileSync(backup, `# removed by vps-monitor from ${full}${linkTarget ? ' (symlink -> ' + linkTarget + ')' : ''}\n${text == null ? '# (config tidak terbaca / symlink putus)\n' : text}`, { mode: 0o600 });
  } catch (e) { return { ok: false, error: 'Gagal membuat backup config, penghapusan dibatalkan: ' + e.message }; }

  // File asli di sites-available ikut dihapus hanya bila memang di sana (backup sudah tersimpan).
  const removeTarget = realTarget && realTarget !== full && realTarget.startsWith(NGINX_AVAILABLE_DIR + path.sep);
  try {
    fs.unlinkSync(full);
    if (removeTarget) fs.unlinkSync(realTarget);
  } catch (e) {
    return { ok: false, error: 'Gagal menghapus file: ' + e.message };
  }

  const rollback = () => {
    try {
      if (isLink) {
        if (removeTarget && text != null) fs.writeFileSync(realTarget, text);
        fs.symlinkSync(linkTarget, full);
      } else if (text != null) fs.writeFileSync(full, text);
    } catch {}
  };
  const t = await runCmd('nginx -t 2>&1', { timeout: 15000 });
  if (!t.ok) { rollback(); try { fs.unlinkSync(backup); } catch {} return { ok: false, error: 'nginx -t gagal setelah penghapusan, config dikembalikan.\n' + t.output.trim() }; }
  const r = await runCmd('systemctl reload nginx 2>&1', { timeout: 30000 });
  const what = removeTarget ? 'symlink + file sites-available' : 'file config';
  if (!r.ok) return { ok: true, backup, warning: 'Config terhapus tapi reload nginx gagal: ' + r.output.trim(), output: `${what} dihapus` };
  return { ok: true, backup, output: `${what} dihapus, nginx di-reload` };
}

// ---- Un-deploy (hapus deployment: nginx vhost, folder+git, worker/cron; DB/SSL opsional) ----
// Hanya folder langsung di SCAN_ROOT yang boleh dihapus. Parser .env/wp-config di sini
// hanya mengambil nama DB/user (tidak pernah password) untuk ditampilkan + opsi drop.
const REMOVED_DB_DIR = path.join(DATA_DIR, 'removed-dbs');

// Root nginx yang dianggap milik project ini: folder itu sendiri (WordPress) atau
// <folder>/public (Laravel). Jangan cocokkan <folder>/<subproject> — kalau folder
// seperti /var/www/bz punya banyak subproject, menghapus bz akan menghapus semuanya.
function siteRootBelongsToTarget(root, target) {
  if (!root) return false;
  const norm = (x) => path.normalize(String(x).trim().replace(/^['"]|['"]$/g, '')).replace(/[\\/]+$/, '');
  const r = norm(root);
  const t = norm(target);
  return r === t || r === t + path.sep + 'public';
}

function readEnvValue(file, key) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const m = txt.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm'));
    if (!m) return null;
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v.trim() || null;
  } catch { return null; }
}
function readWpDefine(file, key) {
  try {
    // Buang komentar dulu supaya define contoh/komentar tidak ikut terbaca.
    const txt = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const m = txt.match(new RegExp(`^\\s*define\\(\\s*['"]${key}['"]\\s*,\\s*['"]([^'"]*)['"]\\s*\\)`, 'm'));
    return m ? (m[1].trim() || null) : null;
  } catch { return null; }
}
// Panel hanya boleh drop DB yang benar-benar ada di MySQL lokal (socket/host localhost).
// Jangan sampai DB_HOST remote kebetulan punya nama sama dengan DB lokal lalu yang dihapus DB lokal.
function dbEndpointLocal(host, port) {
  const raw = String(host || '').trim().replace(/^['"]|['"]$/g, '');
  let h = raw;
  let p = String(port || '').trim().replace(/^['"]|['"]$/g, '');
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    h = end > 0 ? raw.slice(1, end) : raw;
    const rest = end > 0 ? raw.slice(end + 1) : '';
    if (/^:\d+$/.test(rest)) p = rest.slice(1);
  } else {
    const m = raw.match(/^([^:]+):(\d+)$/);
    if (m) { h = m[1]; p = m[2]; }
    else if (raw.includes(':') && !/^[0-9a-f:]+$/i.test(raw)) h = raw.split(':')[0]; // host:/socket/path
  }
  h = h.toLowerCase();
  if (h && h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') return false;
  if (p && p !== '3306') return false;
  return true;
}
function detectProjectDb(dir) {
  const ident = (v) => (v && /^[A-Za-z0-9_$-]+$/.test(v) ? v : null);
  const envPath = path.join(dir, '.env');
  const conn = readEnvValue(envPath, 'DB_CONNECTION');
  // Hanya tawarkan drop DB untuk MySQL/MariaDB; sqlite/pgsql jangan disentuh.
  const envDb = (!conn || /^(mysql|mariadb)$/i.test(conn)) ? ident(readEnvValue(envPath, 'DB_DATABASE')) : null;
  if (envDb) {
    const host = readEnvValue(envPath, 'DB_HOST');
    const port = readEnvValue(envPath, 'DB_PORT');
    return { name: envDb, user: ident(readEnvValue(envPath, 'DB_USERNAME')), source: '.env', host, port, local: dbEndpointLocal(host, port) };
  }
  const wpDb = ident(readWpDefine(path.join(dir, 'wp-config.php'), 'DB_NAME'));
  if (wpDb) {
    const host = readWpDefine(path.join(dir, 'wp-config.php'), 'DB_HOST');
    return { name: wpDb, user: ident(readWpDefine(path.join(dir, 'wp-config.php'), 'DB_USER')), source: 'wp-config.php', host, port: null, local: dbEndpointLocal(host, null) };
  }
  return null;
}
function undeployTargets(session) {
  let entries = [];
  try { entries = fs.readdirSync(SCAN_ROOT, { withFileTypes: true }); } catch { return []; }
  const panelDir = path.resolve(ROOT);
  // Pindai DB semua folder langsung (termasuk yang tidak layak di-undeploy) supaya
  // DB/user yang dipakai project lain tidak pernah ditawarkan untuk di-drop.
  const dbByDir = new Map();
  const dbProjects = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const full = path.resolve(SCAN_ROOT, e.name);
    if (full === panelDir) continue;
    try {
      const st = fs.lstatSync(full);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
    } catch { continue; }
    const db = detectProjectDb(full);
    if (!db) continue;
    const rec = { dir: e.name, db, hidden: isHidden(session, [e.name, full]) };
    dbByDir.set(e.name, db);
    dbProjects.push(rec);
  }
  const allSites = getHostedSites();
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const full = path.resolve(SCAN_ROOT, e.name);
    if (full === panelDir) continue; // jangan pernah tawarkan panel monitor sendiri
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    const sites = allSites.filter((s) => siteRootBelongsToTarget(s.root, full))
      .filter((s) => !isHidden(session, [s.file, s.domains, s.root, s.upstream]));
    const git = fs.existsSync(path.join(full, '.git'));
    const laravel = fs.existsSync(path.join(full, 'artisan'));
    const wordpress = fs.existsSync(path.join(full, 'wp-config.php')) || fs.existsSync(path.join(full, 'wp-includes'));
    const nodejs = fs.existsSync(path.join(full, 'package.json'));
    if (!sites.length && !git && !laravel && !wordpress && !nodejs) continue;
    if (isHidden(session, [e.name, full])) continue;
    out.push({
      dir: e.name,
      path: full,
      domains: [...new Set(sites.flatMap((s) => s.domains).filter(Boolean))],
      sites: sites.map((s) => ({ id: s.id, file: s.file, dir: s.dir, domains: s.domains, ssl: !!s.ssl })),
      git,
      framework: laravel ? 'laravel' : (wordpress ? 'wordpress' : (nodejs ? 'nodejs' : 'other')),
      db: dbByDir.get(e.name) || detectProjectDb(full),
      ssl: sites.some((s) => s.ssl),
    });
  }
  // DB / user yang dipakai folder lain jangan ditawarkan untuk di-drop.
  const dbUsage = new Map();
  const userUsage = new Map();
  const addUsage = (map, key, rec) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(rec);
  };
  for (const rec of dbProjects) {
    addUsage(dbUsage, rec.db.name, rec);
    if (rec.db.user) addUsage(userUsage, rec.db.user, rec);
  }
  const label = (rec) => rec.hidden ? 'project tersembunyi' : rec.dir;
  for (const t of out) {
    if (!t.db) continue;
    t.db.sharedWith = [...new Set((dbUsage.get(t.db.name) || []).filter((rec) => rec.dir !== t.dir).map(label))];
    t.db.userSharedWith = t.db.user
      ? [...new Set((userUsage.get(t.db.user) || []).filter((rec) => rec.dir !== t.dir).map(label))]
      : [];
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}
function supervisorConfsFor(target) {
  const dirs = process.env.SUPERVISOR_CONF_DIR ? [process.env.SUPERVISOR_CONF_DIR] : SUPERVISOR_CONF_DIRS;
  // Boundary check: /var/www/foo tidak boleh match worker /var/www/foobar.
  const esc = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^A-Za-z0-9_.-])${esc}(?![A-Za-z0-9_.-])`);
  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      // Hanya file conf yang benar-benar dibaca supervisor (bukan .bak/.disabled/file sampah).
      if (!f.isFile() || f.name.startsWith('.') || f.name.endsWith('~') || !/\.(conf|ini)$/i.test(f.name)) continue;
      if (/^supervisord?\.conf$/i.test(f.name)) continue; // jangan pernah hapus config utama
      const full = path.join(dir, f.name);
      if (seen.has(full)) continue;
      seen.add(full);
      let txt = '';
      try { txt = fs.readFileSync(full, 'utf8'); } catch { continue; }
      // Cek hanya baris directive yang benar-benar menjalankan worker, bukan komentar
      // atau path yang hanya kebetulan disebut di logfile program lain.
      const blocks = [...txt.matchAll(/^\[program:([^\]]+)\]([\s\S]*?)(?=^\[[^\]]+\]|(?![\s\S]))/gm)];
      const names = blocks.filter(([, , body]) =>
        body.split(/\r?\n/).some((l) => !/^\s*[;#]/.test(l) && /^\s*(command|directory|environment)\s*=/.test(l) && re.test(l))
      ).map(([, name]) => name);
      if (!names.length) continue;
      // Jangan hapus seluruh file kalau masih ada program/section lain di dalamnya.
      const otherSections = /^\[(?!program:)[^\]]+\]/m.test(txt);
      out.push({ file: full, names, removeFile: names.length === blocks.length && !otherSections });
    }
  }
  return out;
}
// Jangan hapus certbot cert kalau masih dipakai vhost lain (mis. wildcard/SAN bersama).
function certUsedByOtherSites(domain) {
  const needle = `/etc/letsencrypt/live/${domain}/`;
  for (const dir of NGINX_SITE_DIRS) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (f.startsWith('.') || f.endsWith('.bak') || f.endsWith('~')) continue;
      try {
        if (fs.readFileSync(path.join(dir, f), 'utf8').includes(needle)) return path.join(dir, f);
      } catch {}
    }
  }
  return null;
}
function dbUserHasOtherGrants(user, db) {
  return new Promise((resolve) => {
    runFile('mysql', ['-BNe', `SHOW GRANTS FOR '${sqlEsc(user)}'@'localhost';`], { timeout: 15000 }).then((g) => {
      if (!g.ok) return resolve(true); // tidak bisa diverifikasi -> jangan drop user
      const lines = g.output.split('\n').map((x) => x.trim()).filter(Boolean);
      const other = lines.some((l) => {
        const m = l.match(/^GRANT\s+.*?\s+ON\s+(.+?)\s+TO\s+/i);
        if (!m) return true;
        const scope = m[1].trim();
        if (scope === '*.*' && /^GRANT\s+USAGE\s+ON\s+\*\.\*/i.test(l)) return false;
        return scope !== `\`${db}\`.*`;
      });
      resolve(other);
    }).catch(() => resolve(true));
  });
}

async function runUndeployJob(job, p) {
  const target = path.resolve(p.path);
  try {
    jobStep(job, 'validate', 'running', `dir=${p.dir} path=${target} db=${p.db ? p.db.name : '-'} dropDb=${!!p.dropDb} dropDbUser=${!!p.dropDbUser} removeSsl=${!!p.removeSsl}`);
    if (path.dirname(target) !== path.resolve(SCAN_ROOT)) throw new Error('Target bukan folder langsung di ' + SCAN_ROOT);
    if (target === path.resolve(ROOT)) throw new Error('Folder panel monitor tidak boleh dihapus');
    let st;
    try { st = fs.lstatSync(target); } catch { throw new Error(`Folder ${target} tidak ada`); }
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Target bukan folder biasa (symlink ditolak)');
    if ((await runCmd(`mountpoint -q -- ${shq(target)}`, { timeout: 10000 })).ok) throw new Error('Target adalah mount point, tidak boleh dihapus');
    const conflict = [...DEPLOY_JOBS.values()].find((j) => j.id !== job.id && j.status === 'running' && (j.undeployDir === p.dir || String(j.label || '').startsWith(p.dir + ' (')));
    if (conflict) throw new Error(`Job lain untuk ${p.dir} masih berjalan (${conflict.id})`);
    jobStep(job, 'validate', 'ok', 'target valid');

    // 1. DB opsional: backup WAJIB sukses sebelum ada perubahan destruktif. Ditaruh paling
    //    awal supaya kalau backup gagal, worker/cron/vhost/folder masih utuh.
    let dbDump = null;
    if (p.dropDb) {
      if (!p.db || p.db.local === false) throw new Error('DB host/port bukan MySQL lokal — drop DB dibatalkan');
      const db = p.db.name;
      const dbi = vDbIdent(db, 'Nama database', 64);
      if (!dbi.ok) throw new Error(dbi.error);
      if (SYSTEM_DBS.has(String(db).toLowerCase())) throw new Error('Database sistem tidak boleh dihapus');
      jobStep(job, 'mysql: backup database', 'running', db);
      const bdir = fs.existsSync('/var/backups/mysql') ? '/var/backups/mysql' : REMOVED_DB_DIR;
      try { fs.mkdirSync(bdir, { recursive: true, mode: 0o700 }); } catch {}
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      dbDump = path.join(bdir, `undeploy-${db}-${stamp}.sql.gz`);
      const cmd = `mysqldump --single-transaction --quick --routines --triggers --events --no-tablespaces --default-character-set=utf8mb4 ${shq(db)} 2>${shq(dbDump + '.err')} | gzip -c > ${shq(dbDump)}`;
      const r = await runFile('bash', ['-o', 'pipefail', '-c', cmd], { timeout: 600000 });
      const dumpOk = r.ok && fs.existsSync(dbDump) && fs.statSync(dbDump).size > 0;
      if (!dumpOk) {
        let err = r.output;
        try { err += fs.readFileSync(dbDump + '.err', 'utf8'); } catch {}
        try { if (fs.existsSync(dbDump)) fs.unlinkSync(dbDump); } catch {}
        throw new Error('backup database gagal — belum ada yang dihapus\n' + String(err).slice(-2500));
      }
      try { fs.unlinkSync(dbDump + '.err'); } catch {}
      try { fs.chmodSync(dbDump, 0o600); } catch {}
      jobStep(job, 'mysql: backup database', 'ok', dbDump);
    } else {
      jobStep(job, 'mysql: backup database', 'skip', 'opsi nonaktif');
    }

    // 2. Supervisor worker milik project ini (dicari dari path project di file conf).
    jobStep(job, 'supervisor worker', 'running', '');
    const progs = supervisorConfsFor(target);
    if (!progs.length) {
      jobStep(job, 'supervisor worker', 'skip', 'tidak ada worker untuk project ini');
    } else {
      let out = '';
      let partial = false;
      for (const pr of progs) {
        for (const name of pr.names) {
          const r = await runCmd(`supervisorctl stop ${shq(name + ':*')} 2>&1`, { timeout: 30000 });
          out += `stop ${name}: ${r.output.trim()}\n`;
        }
        if (!pr.removeFile) {
          partial = true;
          out += `${pr.file}: berisi program lain — file TIDAK dihapus (hapus manual bila perlu)\n`;
          continue;
        }
        try { fs.unlinkSync(pr.file); } catch (e) { throw new Error(`hapus ${pr.file} gagal: ${e.message}`); }
        out += `hapus ${pr.file}\n`;
      }
      const rr = await runCmd('supervisorctl reread 2>&1 && supervisorctl update 2>&1', { timeout: 60000 });
      out += rr.output.trim();
      jobStep(job, 'supervisor worker', rr.ok && !partial ? 'ok' : 'warn', out);
    }

    // 2b. PM2 process (bila ada)
    await runCmd(`pm2 delete ${shq(target)} 2>&1 || true; pm2 save 2>&1 || true`);

    // 3. Cron www-data yang menyebut path project ini saja (tidak menyentuh cron lain).
    //    Boundary path penting: /var/www/foo jangan sampai menghapus cron /var/www/foobar.
    jobStep(job, 'cron scheduler', 'running', '');
    const ct = await runCmd('crontab -u www-data -l 2>/dev/null || true', { timeout: 15000 });
    const escTarget = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cronRe = new RegExp(`(^|[^A-Za-z0-9_.-])${escTarget}(?![A-Za-z0-9_.-])`);
    if (!cronRe.test(ct.output)) {
      jobStep(job, 'cron scheduler', 'skip', 'tidak ada cron untuk project ini');
    } else {
      const pat = `(^|[^[:alnum:]_.-])${escTarget}([^[:alnum:]_.-]|$)`;
      const r = await runCmd(`(crontab -u www-data -l 2>/dev/null | grep -v -E ${shq(pat)} || true) | crontab -u www-data - 2>&1`, { timeout: 15000 });
      if (!r.ok) throw new Error('hapus cron gagal\n' + r.output);
      jobStep(job, 'cron scheduler', 'ok', 'cron line project dihapus');
    }

    // 4. Nginx: hanya site yang tadi terlihat oleh user (p.sites), bukan semua root yang cocok.
    //    Re-cek root saat job jalan: kalau config sempat diubah ke project lain, jangan dihapus.
    jobStep(job, 'nginx vhost', 'running', '');
    const liveSites = new Map(getHostedSites().map((s) => [s.id, s]));
    const seenSites = new Set();
    const sites = (p.sites || []).map((x) => liveSites.get(x.id))
      .filter((s) => s && siteRootBelongsToTarget(s.root, target))
      .filter((s) => {
        let key = s.id;
        try { key = fs.realpathSync(s.id); } catch {}
        if (seenSites.has(key)) return false;
        seenSites.add(key);
        return true;
      });
    if (!sites.length) {
      jobStep(job, 'nginx vhost', 'skip', 'tidak ada vhost dengan root project ini');
    } else {
      const notes = [];
      for (const site of sites) {
        const d = await deleteHostedSite(site);
        if (!d.ok) throw new Error(`hapus vhost ${site.file} gagal: ${d.error}`);
        let note = `${site.file}: ${d.output}${d.backup ? ' (backup: ' + d.backup + ')' : ''}`;
        // deleteHostedSite menghapus sites-available hanya bila sites-enabled berupa symlink.
        // Kalau config di-copy (bukan symlink), pastikan file kembarannya juga dihapus.
        const avail = path.join(NGINX_AVAILABLE_DIR, site.file);
        if (path.resolve(site.dir) === path.resolve(NGINX_ENABLED_DIR) && fs.existsSync(avail)) {
          const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 17);
          const backup = path.join(REMOVED_SITES_DIR, `${stamp}-${site.file}-available`);
          try {
            const text = fs.readFileSync(avail, 'utf8');
            fs.mkdirSync(REMOVED_SITES_DIR, { recursive: true, mode: 0o700 });
            fs.writeFileSync(backup, `# removed by vps-monitor undeploy from ${avail}\n${text}`, { mode: 0o600 });
            fs.unlinkSync(avail);
            note += `; sites-available dihapus (backup: ${backup})`;
          } catch (e) {
            throw new Error(`hapus ${avail} gagal: ${e.message}`);
          }
        }
        notes.push(note);
      }
      jobStep(job, 'nginx vhost', 'ok', notes.join('\n'));
    }

    // 5. SSL opsional (sertifikat certbot; non-fatal bila tidak ada).
    if (p.removeSsl) {
      jobStep(job, 'ssl cert', 'running', '');
      const sslDomains = [...new Set(sites.filter((s) => s.ssl).flatMap((s) => s.domains))];
      if (!sslDomains.length) {
        jobStep(job, 'ssl cert', 'skip', 'tidak ada sertifikat SSL terdeteksi');
      } else {
        let out = '';
        let warn = false;
        for (const d of sslDomains) {
          const other = certUsedByOtherSites(d);
          if (other) {
            warn = true;
            out += `\n--- ${d} ---\nDIPERTAHANKAN: cert masih dipakai vhost lain (${other})`;
            continue;
          }
          const r = await runCmd(`certbot delete --cert-name ${shq(d)} --non-interactive 2>&1`, { timeout: 120000 });
          out += `\n--- ${d} ---\n` + r.output.trim();
          if (!r.ok) warn = true;
        }
        jobStep(job, 'ssl cert', warn ? 'warn' : 'ok', out.slice(-4000));
      }
    } else {
      jobStep(job, 'ssl cert', 'skip', 'opsi nonaktif');
    }

    // 6. Database opsional: DROP setelah backup sukses. User hanya di-drop bila
    //    grant-nya tidak dipakai database lain.
    if (p.dropDb) {
      const db = p.db.name;
      jobStep(job, 'mysql: drop database', 'running', db);
      let r = await runFile('mysql', ['-BNe', `DROP DATABASE IF EXISTS \`${db}\`;`], { timeout: 60000 });
      if (!r.ok) throw new Error('drop database gagal\n' + r.output);
      jobStep(job, 'mysql: drop database', 'ok', `database ${db} dihapus (backup: ${dbDump})`);

      if (p.dropDbUser && p.db.user) {
        jobStep(job, 'mysql: drop user', 'running', p.db.user);
        const other = await dbUserHasOtherGrants(p.db.user, db);
        if (other) {
          jobStep(job, 'mysql: drop user', 'warn', `user ${p.db.user} masih punya grant lain / tidak bisa diverifikasi — TIDAK dihapus`);
        } else {
          r = await runFile('mysql', ['-BNe', `DROP USER IF EXISTS '${sqlEsc(p.db.user)}'@'localhost';`], { timeout: 60000 });
          if (!r.ok) jobStep(job, 'mysql: drop user', 'warn', 'drop user gagal (database sudah dihapus)\n' + r.output);
          else jobStep(job, 'mysql: drop user', 'ok', `user ${p.db.user} dihapus`);
        }
      } else {
        jobStep(job, 'mysql: drop user', 'skip', 'opsi nonaktif / user tidak terdeteksi');
      }
    } else {
      jobStep(job, 'mysql: drop database', 'skip', 'opsi nonaktif');
      jobStep(job, 'mysql: drop user', 'skip', 'opsi nonaktif');
    }

    // 7. Folder + .git. Dijalankan paling akhir supaya kalau step sebelumnya gagal,
    //    source masih ada untuk diperbaiki/di-retry.
    jobStep(job, 'hapus folder + git', 'running', target);
    const du = await runCmd(`du -sh ${shq(target)} 2>/dev/null | cut -f1`, { timeout: 60000 });
    const rm = await runCmd(`rm -rf -- ${shq(target)}`, { timeout: 600000 });
    if (!rm.ok || fs.existsSync(target)) throw new Error('hapus folder gagal\n' + rm.output);
    jobStep(job, 'hapus folder + git', 'ok', `dihapus ${du.output.trim() || '?'} (${target})`);

    jobStep(job, 'verify', 'ok', 'vhost + folder sudah tidak ada; DNS/CDN di luar server tidak diubah');
    job.status = 'done';
    if (job.owner) audit(job.owner, 'undeploy.done', target, `dir=${p.dir}`);
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 3000);
    jobStep(job, 'ERROR', 'fail', msg);
    job.status = 'failed';
    if (job.owner) audit(job.owner, 'undeploy.fail', target, msg.slice(0, 200));
  }
}

// ---- Rename project folder / database ----
// Folder: mv + tulis ulang path lama di vhost nginx, supervisor conf, dan cron www-data.
// Database: dump -> DB baru -> grant -> update .env/wp-config -> drop DB lama (backup dulu).
function pathBoundaryRe(p) {
  return new RegExp(`(^|[^A-Za-z0-9_.-])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_.-])`, 'g');
}
const replacePath = (text, from, to) => text.replace(pathBoundaryRe(from), (m, pre) => pre + to);

// Target rename dari relPath repo (boleh bersarang, mis. Microspace/app) di bawah SCAN_ROOT.
function renameTarget(session, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const root = path.resolve(SCAN_ROOT);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep) || full === path.resolve(ROOT)) return null;
  try { const st = fs.lstatSync(full); if (!st.isDirectory() || st.isSymbolicLink()) return null; } catch { return null; }
  if (isHidden(session, [rel, full])) return null;
  const db = detectProjectDb(full);
  if (db) {
    const others = scanGitDirs(SCAN_ROOT, 6).map((d) => path.resolve(d)).filter((d) => d !== full);
    db.sharedWith = others.filter((d) => { const o = detectProjectDb(d); return o && o.name === db.name; }).map((d) => path.relative(root, d));
  }
  const sites = getHostedSites().filter((s) => siteRootBelongsToTarget(s.root, full));
  return {
    dir: path.relative(root, full), path: full, name: path.basename(full), db,
    sites: sites.map((s) => ({ id: s.id, file: s.file })),
  };
}

async function runRenameJob(job, p) {
  const oldPath = path.resolve(p.path);
  const label = p.dir;
  try {
    jobStep(job, 'validate', 'running', `dir=${p.dir} newDir=${p.newDir || '-'} db=${p.db ? p.db.name : '-'} newDb=${p.newDb || '-'}`);
    if (!oldPath.startsWith(path.resolve(SCAN_ROOT) + path.sep)) throw new Error('Target di luar ' + SCAN_ROOT);
    if (!fs.existsSync(oldPath)) throw new Error(`Folder ${oldPath} tidak ada`);
    const newPath = p.newDir ? path.join(path.dirname(oldPath), p.newDir) : null;
    if (newPath && fs.existsSync(newPath)) throw new Error(`Folder ${newPath} sudah ada`);
    const conflict = [...DEPLOY_JOBS.values()].find((j) => j.id !== job.id && j.status === 'running' && (j.undeployDir === p.dir || String(j.label || '').startsWith(p.dir + ' (')));
    if (conflict) throw new Error(`Job lain untuk ${p.dir} masih berjalan (${conflict.id})`);
    jobStep(job, 'validate', 'ok', 'target valid');

    // 1. Database dulu (path folder lama masih valid untuk .env).
    if (p.newDb) {
      const oldDb = p.db.name;
      const nd = p.newDb;
      jobStep(job, 'mysql: rename database', 'running', `${oldDb} -> ${nd}`);
      const ex = await runFile('mysql', ['-BNe', `SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${sqlEsc(nd)}';`], { timeout: 30000 });
      if (!ex.ok) throw new Error('cek database gagal\n' + ex.output);
      if (ex.output.trim() !== '0') throw new Error(`Database ${nd} sudah ada`);
      const bdir = fs.existsSync('/var/backups/mysql') ? '/var/backups/mysql' : REMOVED_DB_DIR;
      try { fs.mkdirSync(bdir, { recursive: true, mode: 0o700 }); } catch {}
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const dump = path.join(bdir, `rename-${oldDb}-${stamp}.sql.gz`);
      let r = await runFile('bash', ['-o', 'pipefail', '-c', `mysqldump --single-transaction --quick --routines --triggers --events --no-tablespaces --default-character-set=utf8mb4 ${shq(oldDb)} | gzip -c > ${shq(dump)}`], { timeout: 600000 });
      if (!r.ok || !fs.existsSync(dump) || fs.statSync(dump).size === 0) throw new Error('backup database gagal — belum ada perubahan\n' + r.output.slice(-2000));
      try { fs.chmodSync(dump, 0o600); } catch {}
      r = await runFile('mysql', ['-BNe', `CREATE DATABASE \`${nd}\` CHARACTER SET utf8mb4;`], { timeout: 30000 });
      if (!r.ok) throw new Error('buat database baru gagal\n' + r.output);
      const undoNew = () => runFile('mysql', ['-BNe', `DROP DATABASE IF EXISTS \`${nd}\`;`], { timeout: 60000 });
      r = await runFile('bash', ['-o', 'pipefail', '-c', `gunzip -c ${shq(dump)} | mysql --default-character-set=utf8mb4 ${shq(nd)}`], { timeout: 600000 });
      if (!r.ok) { await undoNew(); throw new Error('import ke database baru gagal (DB baru dibatalkan, DB lama utuh)\n' + r.output.slice(-2000)); }
      const cnt = (db) => runFile('mysql', ['-BNe', `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${sqlEsc(db)}';`], { timeout: 30000 });
      const [a, b] = [await cnt(oldDb), await cnt(nd)];
      if (!a.ok || !b.ok || a.output.trim() !== b.output.trim()) { await undoNew(); throw new Error(`jumlah tabel beda (${a.output.trim()} vs ${b.output.trim()}) — DB baru dibatalkan, DB lama utuh`); }
      if (p.db.user) {
        r = await runFile('mysql', ['-BNe', `GRANT ALL PRIVILEGES ON \`${nd}\`.* TO '${sqlEsc(p.db.user)}'@'localhost'; FLUSH PRIVILEGES;`], { timeout: 30000 });
        if (!r.ok) { await undoNew(); throw new Error('grant ke DB baru gagal (DB baru dibatalkan)\n' + r.output); }
      }
      // Update config project.
      const file = path.join(oldPath, p.db.source);
      const txt = fs.readFileSync(file, 'utf8');
      const next = p.db.source === '.env'
        ? txt.replace(/^(\s*DB_DATABASE\s*=).*$/m, `$1${nd}`)
        : txt.replace(/(define\(\s*['"]DB_NAME['"]\s*,\s*)['"][^'"]*['"]/, `$1'${nd}'`);
      if (next === txt) { await undoNew(); throw new Error(`gagal mengubah nama DB di ${p.db.source} (DB baru dibatalkan)`); }
      fs.writeFileSync(file, next);
      for (const f of ['config.php']) { try { fs.unlinkSync(path.join(oldPath, 'bootstrap/cache', f)); } catch {} }
      r = await runFile('mysql', ['-BNe', `DROP DATABASE \`${oldDb}\`;`], { timeout: 60000 });
      if (p.db.user) await runFile('mysql', ['-BNe', `REVOKE ALL PRIVILEGES ON \`${oldDb}\`.* FROM '${sqlEsc(p.db.user)}'@'localhost';`], { timeout: 30000 });
      jobStep(job, 'mysql: rename database', r.ok ? 'ok' : 'warn', `${oldDb} -> ${nd}; backup: ${dump}${r.ok ? '' : '\nDB lama gagal di-drop: ' + r.output}`);
    } else {
      jobStep(job, 'mysql: rename database', 'skip', 'tidak diminta');
    }

    // 2. Folder.
    if (!newPath) { jobStep(job, 'rename folder', 'skip', 'tidak diminta'); }
    else {
      jobStep(job, 'rename folder', 'running', `${oldPath} -> ${newPath}`);
      const progs = supervisorConfsFor(oldPath);
      for (const pr of progs) for (const name of pr.names) await runCmd(`supervisorctl stop ${shq(name + ':*')} 2>&1`, { timeout: 30000 });
      const mv = await runCmd(`mv -T -- ${shq(oldPath)} ${shq(newPath)}`, { timeout: 120000 });
      if (!mv.ok) throw new Error('mv gagal\n' + mv.output);
      for (const f of ['config.php', 'routes-v7.php', 'events.php']) { try { fs.unlinkSync(path.join(newPath, 'bootstrap/cache', f)); } catch {} }

      const undo = []; // [file, teks asli]
      const rewrite = (file, label) => {
        const txt = fs.readFileSync(file, 'utf8');
        const next = replacePath(txt, oldPath, newPath);
        if (next === txt) return false;
        undo.push([file, txt]);
        fs.writeFileSync(file, next);
        return label;
      };
      const notes = [];
      let nginxChanged = false;
      try {
        const live = new Map(getHostedSites().map((s) => [s.id, s]));
        const seen = new Set();
        for (const x of p.sites || []) {
          const s = live.get(x.id);
          if (!s) continue;
          let real = s.id; try { real = fs.realpathSync(s.id); } catch {}
          if (seen.has(real)) continue;
          seen.add(real);
          if (rewrite(real)) { nginxChanged = true; notes.push('nginx: ' + real); }
        }
        for (const pr of progs) if (rewrite(pr.file)) notes.push('supervisor: ' + pr.file);
        if (nginxChanged) {
          const t = await runCmd('nginx -t 2>&1', { timeout: 15000 });
          if (!t.ok) throw new Error('nginx -t gagal\n' + t.output);
        }
      } catch (e) {
        for (const [f, txt] of undo) { try { fs.writeFileSync(f, txt); } catch {} }
        await runCmd(`mv -T -- ${shq(newPath)} ${shq(oldPath)}`);
        if (progs.length) await runCmd('supervisorctl reread 2>&1 && supervisorctl update 2>&1', { timeout: 60000 });
        for (const pr of progs) for (const name of pr.names) await runCmd(`supervisorctl start ${shq(name + ':*')} 2>&1`, { timeout: 30000 });
        throw new Error('rename folder dibatalkan, semua dikembalikan: ' + e.message);
      }
      // Cron www-data.
      const ct = await runCmd('crontab -u www-data -l 2>/dev/null || true', { timeout: 15000 });
      if (pathBoundaryRe(oldPath).test(ct.output)) {
        const tmp = path.join(os.tmpdir(), `cron-${job.id}`);
        fs.writeFileSync(tmp, replacePath(ct.output, oldPath, newPath), { mode: 0o600 });
        const r = await runCmd(`crontab -u www-data ${shq(tmp)} 2>&1`, { timeout: 15000 });
        try { fs.unlinkSync(tmp); } catch {}
        notes.push(r.ok ? 'cron: diperbarui' : 'cron GAGAL diperbarui (edit manual)\n' + r.output);
      }
      const rl = nginxChanged ? await runCmd('systemctl reload nginx 2>&1', { timeout: 30000 }) : { ok: true };
      const sv = progs.length ? await runCmd('supervisorctl reread 2>&1 && supervisorctl update 2>&1', { timeout: 60000 }) : { ok: true };
      for (const pr of progs) for (const name of pr.names) await runCmd(`supervisorctl start ${shq(name + ':*')} 2>&1`, { timeout: 30000 });
      jobStep(job, 'rename folder', rl.ok ? 'ok' : 'warn', `${oldPath} -> ${newPath}\n${notes.join('\n')}${rl.ok ? '' : '\nreload nginx gagal: ' + rl.output}${sv.ok ? '' : '\nsupervisor: ' + sv.output}`);
    }
    jobStep(job, 'verify', 'ok', 'selesai. Catatan: APP_URL/domain tidak diubah; php-fpm opcache mungkin perlu reload.');
    job.status = 'done';
    if (job.owner) audit(job.owner, 'rename.done', label, `newDir=${p.newDir || '-'} newDb=${p.newDb || '-'}`);
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 3000);
    jobStep(job, 'ERROR', 'fail', msg);
    job.status = 'failed';
    if (job.owner) audit(job.owner, 'rename.fail', label, msg.slice(0, 200));
  }
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
    return serveFile(req, res, '/login.html');
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
    const limit = Math.max(15, Math.min(500, parseInt(url.searchParams.get('limit'), 10) || 200));
    const hours = Math.max(0, Math.min(168, parseInt(url.searchParams.get('hours'), 10) || 24));
    let rows = lastProcSnapshot.rows.length ? lastProcSnapshot.rows : getProcesses();
    if (!session.admin) rows = rows.filter((r) => r.user === session.user);
    const total = rows.length;
    rows = rows.slice().sort((a, b) => (b.cpu || 0) - (a.cpu || 0)).slice(0, limit);
    let spikes = [];
    if (session.admin) {
      const since = hours > 0 ? Date.now() - hours * 3600_000 : 0;
      spikes = processSpikes
        .filter((s) => !since || s.lastSeen >= since)
        .slice(-100)
        .reverse()
        .map((sp) => sp.queries ? { ...sp, queries: sp.queries.filter((q) => !isHidden(session, [q.db, q.user, q.info])) } : sp);
    }
    return send(res, 200, JSON.stringify({
      time: Date.now(),
      sampledAt: lastProcSnapshot.time,
      intervalMs: PROC_INTERVAL_MS,
      cores: lastProcSnapshot.cores,
      systemCpu: Number(lastStats && lastStats.cpu ? lastStats.cpu.pct : 0) || 0,
      spikeThreshold: PROC_SPIKE_SYSTEM,
      total,
      rows,
      spikes,
    }));
  }
  if (p === '/api/logs/errors') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    const hours = Math.max(0, Math.min(168, parseInt(url.searchParams.get('hours'), 10) || 24));
    const report = buildErrorReport(hours, url.searchParams.get('force') === '1', session);
    return send(res, 200, JSON.stringify(report));
  }
  if (p === '/api/logs/errors/delete' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const ids = Array.isArray(body && body.ids) ? body.ids : [];
    const r = deleteErrorEntries(ids, session);
    if (r.deleted) audit(session.user, 'logs.delete', `${r.deleted} entries`, ids.length > 1 ? 'bulk' : 'single');
    errorLogsCache = { time: 0, data: null };
    return send(res, 200, JSON.stringify(r));
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
  if (p === '/api/mysql/processlist' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    const r = await getMysqlProcessList(session);
    return send(res, r.ok ? 200 : 500, JSON.stringify(r));
  }
  if (p === '/api/mysql/kill' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const id = Number(body && body.id);
    if (!Number.isInteger(id) || id <= 0) return send(res, 400, JSON.stringify({ error: 'Invalid connection id' }));
    const list = await getMysqlProcessList(session);
    if (!list.ok) return send(res, 500, JSON.stringify(list));
    const row = list.rows.find((r) => r.id === id);
    if (!row) return send(res, 404, JSON.stringify({ error: 'Connection no longer exists' }));
    if (['system user', 'event_scheduler'].includes(row.user)) return send(res, 400, JSON.stringify({ error: 'Refusing to kill a MySQL system thread' }));
    // Pastikan yang dimatikan memang query yang dilihat user (koneksi yang sama bisa sudah pindah ke query lain).
    const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    if (norm(row.info) !== norm(body.info)) return send(res, 409, JSON.stringify({ error: 'Query has changed since you loaded the list. Refresh and try again.' }));
    const r = await runFile('mysql', ['-BNe', `KILL QUERY ${id}`], { timeout: 8000 });
    if (!r.ok) return send(res, 500, JSON.stringify({ ok: false, error: 'KILL QUERY gagal: ' + r.output.trim().slice(0, 300) }));
    audit(session.user, 'mysql.kill', `id=${id} ${row.user}@${row.db || '-'} ran ${row.time}s`, norm(row.info));
    return send(res, 200, JSON.stringify({ ok: true }));
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
    const r = resolveBackupFile(session, rel);
    if (r.error) return send(res, r.code, r.error, 'text/plain');
    audit(session.user, 'backup.download', rel, `size=${r.stat.size}`);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(r.filename)}"`,
      'Content-Length': r.stat.size,
    });
    fs.createReadStream(r.real).pipe(res);
    return;
  }
  if (p === '/api/backups/delete' && req.method === 'DELETE') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const rel = String((body && body.file) || '');
    const r = resolveBackupFile(session, rel);
    if (r.error) return send(res, r.code, JSON.stringify({ error: r.error }));
    try { fs.unlinkSync(r.real); } catch (e) { return send(res, 500, JSON.stringify({ error: 'Gagal menghapus: ' + e.message })); }
    audit(session.user, 'backup.delete', rel, `size=${r.stat.size}`);
    return send(res, 200, JSON.stringify({ ok: true }));
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
  if (p === '/api/fs/archive') {
    if (!session.superadmin) return needSuper();
    const dir = safeFsPath(url.searchParams.get('dir'));
    const names = url.searchParams.getAll('name');
    if (!dir || !names.length || names.some((n) => !n || n === '..' || n.includes('/') || n.includes('\0') || !fs.existsSync(path.join(dir, n)))) {
      return send(res, 400, 'Bad request', 'text/plain');
    }
    if (archiveActive) return send(res, 429, 'Arsip lain sedang berjalan, coba lagi nanti', 'text/plain');
    const label = names.length === 1 ? names[0] : (path.basename(dir) || 'root') + '-selected';
    audit(session.user, 'fs.archive', dir, `items=${names.join(',')}`);
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(label)}.tar.gz"`,
    });
    // '--' mencegah nama diawali '-' dibaca sebagai opsi tar; warning (file unreadable) diabaikan.
    // Prioritas CPU/IO terendah + gzip -1 agar web/MySQL di VPS 2 core tidak tercekik.
    archiveActive = true;
    const tar = spawn('nice', ['-n', '19', 'ionice', '-c3', 'tar', '-I', 'gzip -1', '-cf', '-', '-C', dir, '--', ...names], { stdio: ['ignore', 'pipe', 'ignore'] });
    tar.stdout.pipe(res);
    tar.on('error', () => res.end());
    tar.on('close', () => { archiveActive = false; });
    req.on('close', () => { try { tar.kill(); } catch {} });
    return;
  }
  if (p === '/api/sites' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    const all = getHostedSites();
    // Site disembunyikan bila nama file, domain, atau root-nya mengandung hidden keyword user ini.
    const sites = all.filter((x) => !isHidden(session, [x.file, x.domains, x.root, x.upstream]));
    return send(res, 200, JSON.stringify({ time: Date.now(), sites }));
  }
  if (p === '/api/sites/check' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    const sites = getHostedSites().filter((x) => !isHidden(session, [x.file, x.domains, x.root, x.upstream]));
    return send(res, 200, JSON.stringify({ time: Date.now(), results: await probeSites(sites) }));
  }
  if (p === '/api/sites/config' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    // Hanya file yang ada di daftar site (dan tidak tersembunyi untuk user ini) yang boleh dibaca.
    const site = getHostedSites().find((x) => x.id === url.searchParams.get('id'));
    if (!site || isHidden(session, [site.file, site.domains, site.root, site.upstream])) return send(res, 404, JSON.stringify({ error: 'Site tidak ditemukan' }));
    try {
      const real = fs.realpathSync(site.id);
      const st = fs.statSync(real);
      const content = fs.readFileSync(real, 'utf8').slice(0, 512 * 1024);
      audit(session.user, 'site.config.view', site.file, '');
      return send(res, 200, JSON.stringify({ file: site.id, realPath: real, size: st.size, mtime: st.mtimeMs, content }));
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: 'Config tidak bisa dibaca: ' + e.message }));
    }
  }
  if (p === '/api/sites/delete' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    // Hanya site yang ada di daftar (dan tidak tersembunyi untuk user ini) yang boleh dihapus.
    const site = getHostedSites().find((x) => x.id === (body && body.id));
    if (!site || isHidden(session, [site.file, site.domains, site.root, site.upstream])) return send(res, 404, JSON.stringify({ error: 'Site tidak ditemukan' }));
    const pw = await auth.confirmPassword(session, body && body.password);
    if (!pw.ok) {
      audit(session.user, 'site.delete.denied', site.file, pw.error);
      return send(res, pw.status, JSON.stringify({ error: pw.error }));
    }
    audit(session.user, 'site.delete', site.file, site.domains.join(','));
    const r = await deleteHostedSite(site);
    if (!r.ok) audit(session.user, 'site.delete.fail', site.file, String(r.error || '').slice(0, 200));
    return send(res, r.ok ? 200 : (r.status || 500), JSON.stringify(r));
  }
  if (p === '/api/git/projects') {
    const projects = getGitProjects().filter((x) => !isHidden(session, [x.name, x.relPath]));
    const safe = projects.map(({ path: _p, ...rest }) => rest); // hide absolute path
    return send(res, 200, JSON.stringify({ time: Date.now(), scanRoot: SCAN_ROOT, projects: safe }));
  }
  if (p === '/api/git/db/sources' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    const rel = url.searchParams.get('relPath');
    if (isHidden(session, rel)) return send(res, 404, JSON.stringify({ error: 'Not found' }));
    const r = getSyncDbInfo(rel);
    if (!r.ok) return send(res, 400, JSON.stringify({ error: r.error }));
    r.sources = r.sources.filter((x) => !isHidden(session, [x.name, x.relPath, x.db]));
    if (r.defaultSource && !r.sources.some((x) => x.relPath === r.defaultSource)) r.defaultSource = null;
    return send(res, 200, JSON.stringify(r));
  }
  if (p === '/api/git/db/sync' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const rel = body && body.relPath;
    const srcRel = body && body.sourceRelPath;
    if (isHidden(session, rel) || isHidden(session, srcRel)) return send(res, 404, JSON.stringify({ error: 'Not found' }));
    const pr = resolveGitProject(rel);
    if (pr.error) return send(res, 400, JSON.stringify({ error: pr.error }));
    const sp = resolveGitProject(srcRel);
    if (sp.error) return send(res, 400, JSON.stringify({ error: 'Source: ' + sp.error }));
    if (pr.full === sp.full) return send(res, 400, JSON.stringify({ error: 'Source dan target tidak boleh sama' }));
    const t = projectDbInfo(pr.full);
    const s = projectDbInfo(sp.full);
    const targetName = path.basename(pr.full);
    if (!isDevProjectName(targetName)) {
      return send(res, 400, JSON.stringify({ error: 'Target bukan project dev (nama folder harus mengandung "dev")' }));
    }
    const td = vDbIdent(t.db, 'DB_DATABASE target', 64);
    if (!td.ok) return send(res, 400, JSON.stringify({ error: td.error + ' (cek .env target)' }));
    const sd = vDbIdent(s.db, 'DB_DATABASE source', 64);
    if (!sd.ok) return send(res, 400, JSON.stringify({ error: sd.error + ' (cek .env source)' }));
    if (td.value === sd.value) return send(res, 400, JSON.stringify({ error: 'DB source dan target sama — dibatalkan' }));
    if (SYSTEM_DBS.has(td.value.toLowerCase())) return send(res, 400, JSON.stringify({ error: 'Target DB sistem tidak boleh ditimpa' }));
    const pw = await auth.confirmPassword(session, body && body.password);
    if (!pw.ok) {
      audit(session.user, 'git.db.sync.denied', rel, pw.error);
      return send(res, pw.status, JSON.stringify({ error: pw.error }));
    }
    const syncStorage = !!(body && body.syncStorage);
    audit(session.user, 'git.db.sync', rel, `from=${sp.full} srcDb=${sd.value} dstDb=${td.value} storage=${syncStorage}`);
    const r = await syncProjectDb(pr, sp, td.value, sd.value, t.user, { syncStorage });
    if (!r.ok) audit(session.user, 'git.db.sync.fail', rel, String(r.error || '').slice(0, 200));
    return send(res, r.ok ? 200 : 500, JSON.stringify(r));
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
    const fwEarly = ['wordpress', 'wordpress-theme', 'nodejs'].includes(body.framework) ? body.framework : 'laravel';
    const isNode = fwEarly === 'nodejs';
    const useDb = isNode ? (body.nodeUseDb === true) : true;
    const checks = [
      ['dir', vDir(body.dir)], ['domain', vDomain(body.domain)],
      ['deployer', vLinuxUser(body.deployer)],
    ];
    if (useDb) {
      checks.push(
        ['dbName', vDbIdent(body.dbName, 'Nama database', 64)],
        ['dbUser', vDbIdent(body.dbUser, 'User database', 32)]
      );
    }
    // Mode wordpress-theme tidak pakai repo site (core fresh dari wordpress.org).
    if (fwEarly !== 'wordpress-theme') checks.splice(2, 0, ['repo', vRepo(body.repo)], ['branch', vBranch(body.branch)]);
    for (const [k, c] of checks) if (!c.ok) return send(res, 400, JSON.stringify({ error: `${k}: ${c.error}` }));
    if (useDb) {
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
    }
    const projectType = body.projectType === 'existing' ? 'existing' : 'new';
    const sqlPath = (useDb && projectType === 'existing') ? String(body.sqlPath || '').trim() : '';
    if (useDb && projectType === 'existing') {
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
    let nodePort = 3000;
    let nodeScript = 'npm start';
    let nodeBuild = '';
    if (isNode) {
      const pNum = parseInt(body.nodePort || '3000', 10);
      if (isNaN(pNum) || pNum < 1 || pNum > 65535) return send(res, 400, JSON.stringify({ error: 'nodePort: port harus antara 1-65535' }));
      nodePort = pNum;
      nodeScript = String(body.nodeScript || 'npm start').trim().slice(0, 200) || 'npm start';
      nodeBuild = String(body.nodeBuild || '').trim().slice(0, 200);
    }
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
      deployer: cv.deployer, dbName: cv.dbName || null, dbUser: cv.dbUser || null, dbPass: body.dbPass || null,
      useDb, nodePort, nodeScript, nodeBuild,
      projectType, sqlPath, appName: String(body.appName || '').trim().slice(0, 100) || null,
      appKey: String(body.appKey || '').trim() || null,
      useQueue: body.useQueue !== false, useScheduler: body.useScheduler !== false,
      dryRun: body.dryRun === true, envExtra, mail,
      framework, tablePrefix, wpTitle, wpAdminUser, wpAdminEmail, wpAdminPass,
      themeRepo, themeFolder, themeBranch,
    };
    const job = newJob('deploy', `${params.dir} (${params.domain})`, [params.dbPass, params.mail.password, params.wpAdminPass].filter(Boolean), session.user);
    audit(session.user, 'deploy.start', params.dir, `${params.domain} dryRun=${params.dryRun}`);
    runDeployJob(job, params).catch((e) => { jobStep(job, 'ERROR', 'fail', String((e && e.message) || e)); job.status = 'failed'; });
    return send(res, 200, JSON.stringify({ ok: true, id: job.id }));
  }
  if (p === '/api/deploy/status' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    const job = DEPLOY_JOBS.get(url.searchParams.get('id'));
    if (!jobVisible(session, job)) return send(res, 404, JSON.stringify({ error: 'Job tidak ada (mungkin server restart)' }));
    return send(res, 200, JSON.stringify(jobPublic(job)));
  }
  if (p === '/api/deploy/jobs' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    return send(res, 200, JSON.stringify({ jobs: [...DEPLOY_JOBS.values()].filter((j) => jobVisible(session, j)).map(jobPublic) }));
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
    const busy = [...DEPLOY_JOBS.values()].find((j) => j.type === 'transfer' && j.xferProject === t.project && (j.status === 'running' || j.status === 'running-transfer'));
    if (busy) return send(res, 409, JSON.stringify({ error: `Transfer untuk ${t.project} masih berjalan (${busy.id}). Tunggu selesai atau cancel dulu.` }));
    const job = newJob('transfer', `${t.project} <- ${t.user}@${t.host}`, [t.password], session.user);
    job.xferProject = t.project;
    audit(session.user, 'transfer.start', t.project, `${t.user}@${t.host}:${t.port}`);
    runTransferJob(job, t).catch((e) => { jobStep(job, 'ERROR', 'fail', String((e && e.message) || e)); job.status = 'failed'; });
    return send(res, 200, JSON.stringify({ ok: true, id: job.id }));
  }
  if (p === '/api/deploy/transfer/status' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    const job = DEPLOY_JOBS.get(url.searchParams.get('id'));
    if (!job || job.type !== 'transfer' || !jobVisible(session, job)) return send(res, 404, JSON.stringify({ error: 'Job tidak ada' }));
    return send(res, 200, JSON.stringify({ ...jobPublic(job), transfer: transferStatus(job) }));
  }
  if (p === '/api/deploy/transfer/cancel' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const job = DEPLOY_JOBS.get(body.id);
    if (!job || !job.transfer || !jobVisible(session, job)) return send(res, 404, JSON.stringify({ error: 'Job tidak ada' }));
    await runCmd(`screen -S ${shq(job.transfer.name)} -X quit 2>&1`, { timeout: 15000 });
    job.status = 'cancelled';
    audit(session.user, 'transfer.cancel', job.transfer.name);
    return send(res, 200, JSON.stringify({ ok: true }));
  }

  // ---- Un-deploy API ----
  if (p === '/api/undeploy/targets' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    return send(res, 200, JSON.stringify({ time: Date.now(), targets: undeployTargets(session) }));
  }
  if (p === '/api/undeploy' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req, 65536)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    // Target selalu diambil ulang dari whitelist server (bukan path bebas dari browser).
    const target = typeof body.dir === 'string' ? undeployTargets(session).find((t) => t.dir === body.dir) : null;
    if (!target) return send(res, 404, JSON.stringify({ error: 'Project tidak ditemukan / tidak bisa di-undeploy' }));
    if (String(body.confirm || '') !== target.dir) {
      return send(res, 400, JSON.stringify({ error: `Ketik nama folder persis untuk konfirmasi: ${target.dir}` }));
    }
    const dropDb = body.dropDb === true;
    const dropDbUser = body.dropDbUser === true;
    const removeSsl = body.removeSsl === true;
    if (dropDb && !target.db) return send(res, 400, JSON.stringify({ error: 'Database project tidak terdeteksi — drop DB tidak bisa dijalankan' }));
    if (dropDb && target.db.local === false) {
      return send(res, 400, JSON.stringify({ error: 'DB project memakai host/port bukan MySQL lokal — drop DB dibatalkan' }));
    }
    if (dropDb && String(body.dbName || '') !== target.db.name) {
      return send(res, 400, JSON.stringify({ error: 'Nama database berubah sejak halaman dimuat — refresh daftar project lalu ulangi' }));
    }
    if (dropDb && target.db.sharedWith && target.db.sharedWith.length) {
      return send(res, 400, JSON.stringify({ error: `Database ${target.db.name} juga dipakai project lain (${target.db.sharedWith.join(', ')}) — drop DB dibatalkan` }));
    }
    if (dropDb && SYSTEM_DBS.has(String(target.db.name).toLowerCase())) return send(res, 400, JSON.stringify({ error: 'Database sistem tidak boleh dihapus' }));
    if (dropDbUser && (!dropDb || !target.db || !target.db.user)) {
      return send(res, 400, JSON.stringify({ error: 'Drop DB user butuh drop database + nama user yang terdeteksi' }));
    }
    if (dropDbUser && String(body.dbUser || '') !== target.db.user) {
      return send(res, 400, JSON.stringify({ error: 'Nama DB user berubah sejak halaman dimuat — refresh daftar project lalu ulangi' }));
    }
    if (dropDbUser && target.db.userSharedWith && target.db.userSharedWith.length) {
      return send(res, 400, JSON.stringify({ error: `DB user ${target.db.user} juga dipakai project lain (${target.db.userSharedWith.join(', ')}) — drop user dibatalkan` }));
    }
    const pw = await auth.confirmPassword(session, body.password);
    if (!pw.ok) {
      audit(session.user, 'undeploy.denied', target.dir, pw.error);
      return send(res, pw.status, JSON.stringify({ error: pw.error }));
    }
    const conflict = [...DEPLOY_JOBS.values()].find((j) => j.status === 'running' && (j.undeployDir === target.dir || String(j.label || '').startsWith(target.dir + ' (')));
    if (conflict) return send(res, 409, JSON.stringify({ error: `Job lain untuk ${target.dir} masih berjalan (${conflict.id})` }));

    const job = newJob('undeploy', `${target.dir} (${target.domains.join(', ') || 'tanpa domain'})`, [], session.user);
    job.undeployDir = target.dir;
    audit(session.user, 'undeploy.start', target.dir, `dropDb=${dropDb} dropDbUser=${dropDbUser} removeSsl=${removeSsl}`);
    runUndeployJob(job, { ...target, dropDb, dropDbUser, removeSsl }).catch((e) => {
      jobStep(job, 'ERROR', 'fail', String((e && e.message) || e));
      job.status = 'failed';
    });
    return send(res, 200, JSON.stringify({ ok: true, id: job.id }));
  }

  // ---- Rename project / database API ----
  if (p === '/api/rename/target' && req.method === 'GET') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    const target = renameTarget(session, url.searchParams.get('relPath'));
    if (!target) return send(res, 404, JSON.stringify({ error: 'Project tidak ditemukan' }));
    return send(res, 200, JSON.stringify({ target }));
  }
  if (p === '/api/rename' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req, 65536)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const target = renameTarget(session, body.dir);
    if (!target) return send(res, 404, JSON.stringify({ error: 'Project tidak ditemukan' }));
    let newDir = '';
    let newDb = '';
    if (body.newDir) {
      const v = vDir(body.newDir);
      if (!v.ok) return send(res, 400, JSON.stringify({ error: v.error }));
      newDir = v.value;
      if (newDir === target.name) newDir = '';
      else if (newDir.startsWith('.') || fs.existsSync(path.join(path.dirname(target.path), newDir))) return send(res, 400, JSON.stringify({ error: `Folder ${newDir} sudah ada / tidak valid` }));
    }
    if (body.newDb) {
      const v = vDbIdent(body.newDb, 'Nama database', 64);
      if (!v.ok) return send(res, 400, JSON.stringify({ error: v.error }));
      newDb = v.value;
      if (!target.db) return send(res, 400, JSON.stringify({ error: 'Database project tidak terdeteksi' }));
      if (target.db.local === false) return send(res, 400, JSON.stringify({ error: 'DB project bukan MySQL lokal' }));
      if (String(body.dbName || '') !== target.db.name) return send(res, 400, JSON.stringify({ error: 'Nama database berubah sejak halaman dimuat — refresh lalu ulangi' }));
      if (target.db.sharedWith && target.db.sharedWith.length) return send(res, 400, JSON.stringify({ error: `Database ${target.db.name} juga dipakai project lain (${target.db.sharedWith.join(', ')})` }));
      if (SYSTEM_DBS.has(target.db.name.toLowerCase()) || SYSTEM_DBS.has(newDb.toLowerCase())) return send(res, 400, JSON.stringify({ error: 'Database sistem tidak boleh dipakai' }));
      if (newDb === target.db.name) newDb = '';
    }
    if (!newDir && !newDb) return send(res, 400, JSON.stringify({ error: 'Tidak ada perubahan nama' }));
    const pw = await auth.confirmPassword(session, body.password);
    if (!pw.ok) {
      audit(session.user, 'rename.denied', target.dir, pw.error);
      return send(res, pw.status, JSON.stringify({ error: pw.error }));
    }
    const conflict = [...DEPLOY_JOBS.values()].find((j) => j.status === 'running' && (j.undeployDir === target.dir || String(j.label || '').startsWith(target.dir + ' (')));
    if (conflict) return send(res, 409, JSON.stringify({ error: `Job lain untuk ${target.dir} masih berjalan (${conflict.id})` }));
    const job = newJob('rename', `${target.dir} (rename -> ${newDir || target.dir}${newDb ? ', db ' + newDb : ''})`, [], session.user);
    job.undeployDir = target.dir;
    audit(session.user, 'rename.start', target.dir, `newDir=${newDir || '-'} newDb=${newDb || '-'}`);
    runRenameJob(job, { ...target, newDir, newDb }).catch((e) => { jobStep(job, 'ERROR', 'fail', String((e && e.message) || e)); job.status = 'failed'; });
    return send(res, 200, JSON.stringify({ ok: true, id: job.id }));
  }

  let file = p === '/' ? '/index.html' : p;
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
  serveFile(req, res, file);
});

server.listen(PORT, HOST, () => console.log(`vps-monitor on http://${HOST}:${PORT}`));
