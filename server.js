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
const SCAN_ROOT = process.env.SCAN_DIR || (fs.existsSync('/home/zae/Codingan') ? '/home/zae/Codingan' : '/var/www');

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
      if (/would be overwritten|local changes|Your local changes|stash your changes/i.test(out)) {
        const stashCmd = (uid !== null && uid !== me)
          ? `sudo -H -u "#${uid}" git -C "${targetPath}" stash push --include-untracked -m "auto-panel ${new Date().toISOString()}"`
          : `git -C "${targetPath}" stash push --include-untracked -m "auto-panel ${new Date().toISOString()}"`;
        exec(stashCmd, { timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (serr, sstdout, sstderr) => {
          const sout = (sstdout || '') + (sstderr || '');
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
  if (p === '/api/storage') {
    const force = url.searchParams.get('force') === '1';
    const s = getStorageBreakdown(force);
    return send(res, 200, JSON.stringify(s));
  }
  if (p === '/api/workers') {
    const [sup, crn] = await Promise.all([getSupervisorStatus(), Promise.resolve(getCronJobs())]);
    return send(res, 200, JSON.stringify({ time: Date.now(), supervisor: sup, cron: crn, laravelLogs: laravelLogPaths() }));
  }
  if (p === '/api/workers/supervisor' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const r = await supervisorAction(body && body.action, body && body.name);
    return send(res, r.ok ? 200 : 500, JSON.stringify(r));
  }
  if (p === '/api/workers/service' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const r = await restartServiceUnit(body && body.unit);
    return send(res, r.ok ? 200 : 500, JSON.stringify(r));
  }
  if (p === '/api/workers/cron' && req.method === 'POST') {
    if (!session.admin) return send(res, 403, JSON.stringify({ error: 'Admin required' }));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const r = await updateCronSchedule(body && body.user, body && body.oldSchedule, body && body.newSchedule, body && body.cmd, body && body.source);
    return send(res, r.ok ? 200 : 500, JSON.stringify(r));
  }
  if (p === '/api/workers/log') {
    const file = url.searchParams.get('file');
    const lines = url.searchParams.get('lines') || 100;
    const r = await tailLog(file, lines);
    return send(res, r.ok ? 200 : 404, JSON.stringify(r));
  }
  if (p === '/api/history') {
    const limit = Math.min(8640, Math.max(10, parseInt(url.searchParams.get('limit') || '720', 10)));
    return send(res, 200, JSON.stringify({ intervalMs: SAMPLE_INTERVAL_MS, points: history.slice(-limit) }));
  }
  if (p === '/api/git/projects') {
    const projects = getGitProjects();
    const safe = projects.map(({ path: _p, ...rest }) => rest); // hide absolute path
    return send(res, 200, JSON.stringify({ time: Date.now(), scanRoot: SCAN_ROOT, projects: safe }));
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
    const r = await pullGitProject(full);
    if (!r.ok) return send(res, 500, JSON.stringify(r));
    return send(res, 200, JSON.stringify(r));
  }

  let file = p === '/' ? '/index.html' : p;
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
  serveFile(res, file);
});

server.listen(PORT, HOST, () => console.log(`vps-monitor on http://${HOST}:${PORT}`));
