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

const isLoopback = (h) => h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h === '::' || /^127\./.test(h);

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
  const m = line.match(/\[([^\]]+)\]\s+"([^"]*)"\s+(\d{3})\s+(\d+|-)(?:\s+"([^"]*)"\s+"([^"]*)")?/);
  if (!m) return null;
  const head = line.slice(0, m.index).trim().split(/\s+/);
  let ip = head.find((t) => /^[0-9a-f:.]+$/i.test(t) && (t.includes('.') || t.includes(':'))) || '';
  ip = ip.replace(/^"|"$/g, '');
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
    reqRing = reqRing.concat(out).slice(-MAX_REQUESTS);
  }
  return out.length;
}

function summarize(rows) {
  const st = { total: rows.length, ok: 0, redirect: 0, client: 0, server: 0, probes: 0, uniqueIps: 0 };
  const ips = new Map(), paths = new Map();
  for (const r of rows) {
    if (r.status >= 500) st.server++;
    else if (r.status >= 400) st.client++;
    else if (r.status >= 300) st.redirect++;
    else st.ok++;
    if (r.probe && r.status >= PROBE_STATUS) st.probes++;
    ips.set(r.ip, (ips.get(r.ip) || 0) + 1);
    paths.set(r.method + ' ' + r.path, (paths.get(r.method + ' ' + r.path) || 0) + 1);
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, v]);
  st.uniqueIps = ips.size;
  return { stats: st, topIps: top(ips, 8), topPaths: top(paths, 8) };
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
  const { stats, topIps, topPaths } = summarize(reqRing);
  const connView = (r) => ({ ...r, loopback: isLoopback(r.peerHost) });
  const data = {
    time: Date.now(),
    listenPorts: [...listenSet].sort((a, b) => a - b),
    inbound: inbound.map(connView).sort((a, b) => b.recvQ + b.sendQ - (a.recvQ + a.sendQ)),
    outbound: outbound.length,
    remoteInbound: inbound.filter((r) => !isLoopback(r.peerHost)).length,
    stats,
    topIps,
    topPaths,
    requests: requests.slice(0, MAX_REQUESTS),
    logs: accessLogFiles().map((f) => path.basename(f)),
  };
  cache = { time: data.time, data };
  return data;
}

module.exports = { accessLogFiles, splitHostPort, parseSs, listeningPorts, splitTraffic, classifyPath, parseAccessLine, readIncremental, summarize, collect, MAX_REQUESTS };
