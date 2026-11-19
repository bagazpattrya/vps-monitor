'use strict';
// ---- traffic: koneksi yang sedang masuk (ss) + request yang dicoba ke access log nginx ----
// Tanpa dependency: `ss` dan file log nginx sudah ada di VPS. Semua fungsi murni dipisah
// supaya bisa dites tanpa nginx (lihat test/traffic.test.js).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ACCESS_DIR = process.env.NGINX_ACCESS_DIR || '/var/log/nginx';
const ACCESS_FILES = String(process.env.NGINX_ACCESS_LOGS || '').split(',').map((s) => s.trim()).filter(Boolean);
const FIRST_READ_BYTES = 512 * 1024; // baca ekor file saja saat pertama kali (log bisa ratusan MB)
const MAX_READ_BYTES = 1024 * 1024;
const MAX_REQUESTS = 500;
const MAX_LOGS = 20;
const CACHE_MS = 4000;
const PROBE_STATUS = 400; // mulai dari sini request dianggap "ditolak"

// Nama file access log: nginx default `access.log`, vhost biasanya `domain.access.log`.
function accessLogFiles() {
  if (ACCESS_FILES.length) return ACCESS_FILES.filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  let names = [];
  try { names = fs.readdirSync(ACCESS_DIR); } catch { return []; }
  return names
    .filter((n) => /access.*\.log$/i.test(n))
    .map((n) => path.join(ACCESS_DIR, n))
    .filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } })
    .slice(0, MAX_LOGS);
}

// `[::1]:631` / `1.2.3.4:443` -> { host, port }
function splitHostPort(s) {
  const str = String(s || '');
  const i = str.lastIndexOf(':');
  if (i < 0) return { host: str, port: null };
  return { host: str.slice(0, i).replace(/^\[|\]$/g, ''), port: parseInt(str.slice(i + 1), 10) || null };
}

// Baris `ss`: prefix (Netid/State, hanya tanpa -H) lalu "Recv-Q Send-Q local peer [users:(...)]".
// Kolom diambil dari belakang supaya aman untuk `ss`, `ss -H`, dan varian ber-`-p`.
function parseSs(text) {
  const rows = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const f = line.split(/\s+/).filter((t) => !t.startsWith('users:'));
    if (f.length < 4) continue;
    const n = f.length;
    const local = splitHostPort(f[n - 2]);
    const peer = splitHostPort(f[n - 1]);
    const p = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    rows.push({
      recvQ: parseInt(f[n - 4], 10) || 0,
      sendQ: parseInt(f[n - 3], 10) || 0,
      localHost: local.host,
      localPort: local.port,
      peerHost: peer.host,
      peerPort: peer.port,
      proc: p ? p[1] : '',
      pid: p ? parseInt(p[2], 10) : null,
    });
  }
  return rows;
}

function listeningPorts(rows) {
  const set = new Set();
  for (const r of rows) if (r.localPort) set.add(r.localPort);
  return set;
}

// Inbound = koneksi established yang masuk ke port tempat kita listen.
function splitTraffic(estRows, listenSet) {
  const inbound = [], outbound = [];
  for (const r of estRows) (listenSet.has(r.localPort) ? inbound : outbound).push(r);
  return { inbound, outbound };
}

const isPrivate = (h) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd][0-9a-f]{2}:)/i.test(h);
const isLoopback = (h) => h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h === '::' || /^127\./.test(h);

// Siapa di balik request: bot/agent, in-app browser (WA/IG/FB), HP, atau desktop.
// Urutan penting: bot dicek dulu supaya "WhatsApp/2.x" tidak dianggap bot.
const CLIENTS = [
  [/bot|crawler|spider|scrap|sync\/|curl\/|wget|python-requests|go-http-client|okhttp|node-fetch|axios|libwww|headless|phantom|sqlmap|nmap|masscan|zgrab|nuclei|semrush|ahrefs|censys/i, 'bot'],
  [/whatsapp/i, 'whatsapp'],
  [/fbav|fban|instagram|line\/|telegram|twitterbot|tiktok|micromessenger/i, 'in-app'],
  [/android|iphone|ipad|ipod|mobile|opera mini/i, 'mobile'],
  [/windows nt|macintosh|x11|linux|cros/i, 'desktop'],
];

function classifyClient(ua) {
  const s = String(ua || '');
  if (!s || s === '-') return 'unknown';
  for (const [re, tag] of CLIENTS) if (re.test(s)) return tag;
  return 'other';
}

// Pola path yang biasanya hanya dipakai scanner/exploit, bukan pengunjung asli.
const PROBES = [
  [/\/(\.env|\.git|\.svn|\.aws|\.ssh|\.ds_store)/i, 'secret-file'],
  [/\/wp-(login|admin|content|includes|config|json|xmlrpc)/i, 'wordpress'],
  [/\/(phpmyadmin|pma|adminer|myadmin|dbadmin)/i, 'db-admin'],
  [/(eval-stdin|auto_prepend|allow_url_include|\.\.\/)/i, 'exploit'],
  [/\/(shell|cmd|backup|dump|db)(\.php|\.sh|\.sql|\.zip|\.tar\.gz)$/i, 'backup-scan'],
  [/\/(vendor\/phpunit|\.well-known\/\.\.\/)/i, 'exploit'],
];

// Klasifikasi path -> tag probe, atau '' bila terlihat normal.
function classifyPath(p) {
  const clean = decodeURIComponent(String(p || '')).slice(0, 300);
  for (const [re, tag] of PROBES) if (re.test(clean)) return tag;
  return '';
}

// Format combined nginx: ip - user [time] "REQ" status bytes "ref" "ua"
// Format vhost sering diawali "$host" atau "$server_name" -> token IP dicari, bukan diasumsikan.
function parseAccessLine(line) {
  if (!line || line[0] === '#') return null;
  const m = line.match(/\[([^\]]+)\]\s+"([^"]*)"\s+(\d{3})\s+(\d+|-)(?:\s+"([^"]*)"\s+"([^"]*)"(?:\s+"([^"]*)")?)?/);
  if (!m) return null;
  const head = line.slice(0, m.index).trim().split(/\s+/);
  let ip = head.find((t) => /^[0-9a-f:.]+$/i.test(t) && (t.includes('.') || t.includes(':'))) || '';
  ip = ip.replace(/^"|"$/g, '');
  // Di belakang proxy lokal, IP asli ada di X-Forwarded-For (field ke-3 setelah UA, bila log_format memuatnya).
  const xff = (m[7] || '').split(',')[0].trim();
  if (xff && xff !== '-' && /^[0-9a-f:.]+$/i.test(xff) && (isLoopback(ip) || isPrivate(ip))) ip = xff;
  const req = m[2].split(' ');
  const pathPart = req[1] || '';
  return {
    ip,
    time: m[1],
    method: req[0] || '',
    path: pathPart.slice(0, 300),
    proto: req[2] || '',
    status: parseInt(m[3], 10),
    bytes: m[4] === '-' ? 0 : parseInt(m[4], 10) || 0,
    ref: m[5] || '',
    ua: (m[6] || '').slice(0, 200),
    visitor: classifyClient(m[6]),
    probe: classifyPath(pathPart),
  };
}

// Baca hanya baris baru sejak offset terakhir. Bila file mengecil (logrotate), mulai dari ekor.
function readIncremental(file, state) {
  let st;
  try { st = fs.statSync(file); } catch { return ''; }
  if (!st.isFile() || !st.size) return '';
  let start = state.has(file) ? state.get(file) : Math.max(0, st.size - FIRST_READ_BYTES);
  if (st.size < start) start = Math.max(0, st.size - FIRST_READ_BYTES);
  if (st.size === start) return '';
  const len = Math.min(st.size - start, MAX_READ_BYTES);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  let text = buf.toString('utf8');
  const nl = text.lastIndexOf('\n');
  if (nl < 0) return ''; // baris belum selesai ditulis nginx
  text = text.slice(0, nl + 1);
  state.set(file, start + Buffer.byteLength(text));
  return text;
}

// Semua IP unik sejak server hidup (ring 500 baris terlalu pendek: bot bisa menggeser IP lama).
const MAX_SEEN_IPS = 20000; // shortcut: batas memori, naikkan atau simpan ke disk bila perlu histori lintas restart
const seenIps = new Map();
function trackIps(rows) {
  for (const r of rows) {
    if (!r.ip) continue;
    const e = seenIps.get(r.ip);
    if (e) { e.hits++; e.last = r.time; seenIps.delete(r.ip); seenIps.set(r.ip, e); }
    else { seenIps.set(r.ip, { ip: r.ip, hits: 1, first: r.time, last: r.time, visitor: r.visitor }); if (seenIps.size > MAX_SEEN_IPS) seenIps.delete(seenIps.keys().next().value); }
  }
}

let reqRing = [];
let offsets = new Map();
let cache = { time: 0, data: null };

function drainLogs(state) {
  const files = accessLogFiles();
  const out = [];
  for (const f of files) {
    const text = readIncremental(f, state);
    if (!text) continue;
    const label = path.basename(f);
    for (const line of text.split('\n')) {
      const r = parseAccessLine(line);
      if (r) out.push({ ...r, log: label });
    }
  }
  if (out.length) {
    trackIps(out);
    reqRing = reqRing.concat(out).slice(-MAX_REQUESTS);
  }
  return out.length;
}

function summarize(rows) {
  const st = { total: rows.length, ok: 0, redirect: 0, client: 0, server: 0, probes: 0, uniqueIps: 0, bots: 0 };
  const ips = new Map(), paths = new Map(), visitors = new Map();
  for (const r of rows) {
    if (r.status >= 500) st.server++;
    else if (r.status >= 400) st.client++;
    else if (r.status >= 300) st.redirect++;
    else st.ok++;
    if (r.probe && r.status >= PROBE_STATUS) st.probes++;
    if (r.visitor === 'bot') st.bots++;
    visitors.set(r.visitor || 'unknown', (visitors.get(r.visitor || 'unknown') || 0) + 1);
    paths.set(r.method + ' ' + r.path, (paths.get(r.method + ' ' + r.path) || 0) + 1);
    const a = ips.get(r.ip) || { ip: r.ip, hits: 0, bytes: 0, visitor: r.visitor || 'unknown', ua: '', probes: 0 };
    a.hits++;
    a.bytes += r.bytes || 0;
    a.probes += r.probe && r.status >= PROBE_STATUS ? 1 : 0;
    if (!a.ua && r.ua) a.ua = r.ua;
    ips.set(r.ip, a);
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, v]);
  st.uniqueIps = ips.size;
  return {
    stats: st,
    topIps: [...ips.values()].sort((a, b) => b.hits - a.hits).slice(0, 8).map((a) => [a.ip, a.hits]),
    topPaths: top(paths, 8),
    visitors: top(visitors, 8),
    ipStats: [...ips.values()].sort((a, b) => b.hits - a.hits).slice(0, 50),
  };
}

function ss(args) {
  try {
    return execFileSync('ss', args, { encoding: 'utf8', timeout: 4000, maxBuffer: 2 * 1024 * 1024 });
  } catch { return ''; }
}

function collect(force = false) {
  if (!force && cache.data && Date.now() - cache.time < CACHE_MS) return cache.data;
  const listenSet = listeningPorts(parseSs(ss(['-Hltn'])));
  const { inbound, outbound } = splitTraffic(parseSs(ss(['-Htnp', 'state', 'established'])), listenSet);
  drainLogs(offsets);

  const requests = reqRing.slice().reverse();
  const { stats, topIps, topPaths, visitors, ipStats } = summarize(reqRing);
  const connView = (r) => ({ ...r, loopback: isLoopback(r.peerHost) });
  stats.uniqueIpsTotal = seenIps.size;
  const data = {
    time: Date.now(),
    uniqueIpList: [...seenIps.values()].reverse().slice(0, 200),
    listenPorts: [...listenSet].sort((a, b) => a - b),
    inbound: inbound.map(connView).sort((a, b) => b.recvQ + b.sendQ - (a.recvQ + a.sendQ)),
    outbound: outbound.length,
    remoteInbound: inbound.filter((r) => !isLoopback(r.peerHost)).length,
    stats,
    topIps,
    topPaths,
    visitors,
    ipStats,
    requests: requests.slice(0, MAX_REQUESTS),
    logs: accessLogFiles().map((f) => path.basename(f)),
  };
  cache = { time: data.time, data };
  return data;
}

module.exports = { accessLogFiles, splitHostPort, parseSs, listeningPorts, splitTraffic, classifyClient, classifyPath, parseAccessLine, readIncremental, summarize, trackIps, seenIps, collect, MAX_REQUESTS };
