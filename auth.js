'use strict';
// Login against local Linux accounts (zero dependencies).
// Passwords are verified with PAM's unix_chkpwd helper, which only works for
// arbitrary users when the process runs as root.
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_HOURS || '12', 10) * 3600_000;
const COOKIE = 'vpsmon_sid';
const MIN_UID = 1000;
const ADMIN_GROUPS = ['sudo', 'wheel', 'admin', 'www-data'];
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;
const CHKPWD_CANDIDATES = ['/usr/sbin/unix_chkpwd', '/sbin/unix_chkpwd', '/usr/lib/unix_chkpwd'];
const USERNAME_RE = /^[a-z_][a-z0-9_.-]{0,31}$/i;

const sessions = new Map(); // token -> { user, admin, exp }
const fails = new Map();    // key -> { n, until }

function readPasswd() {
  const rows = [];
  for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
    const f = line.split(':');
    if (f.length < 7) continue;
    rows.push({ name: f[0], uid: parseInt(f[2], 10), shell: f[6].trim() });
  }
  return rows;
}

function readGroups() {
  const groups = {};
  try {
    for (const line of fs.readFileSync('/etc/group', 'utf8').split('\n')) {
      const f = line.split(':');
      if (f.length < 4) continue;
      groups[f[0]] = f[3] ? f[3].split(',') : [];
    }
  } catch {}
  return groups;
}

// Returns { name, admin } for an account allowed to log in, else null.
function lookupUser(name) {
  if (!USERNAME_RE.test(name)) return null;
  let u;
  try { u = readPasswd().find((r) => r.name === name); } catch { return null; }
  if (!u) return null;
  if (u.uid !== 0 && u.uid < MIN_UID) return null;                 // system accounts
  if (/(nologin|\/false)$/.test(u.shell) || !u.shell) return null; // no interactive shell
  const groups = readGroups();
  const admin = u.uid === 0 || ADMIN_GROUPS.some((g) => (groups[g] || []).includes(name));
  return { name, admin };
}

function checkPasswordChkpwd(name, password) {
  return new Promise((resolve) => {
    const bin = CHKPWD_CANDIDATES.find((p) => fs.existsSync(p));
    if (!bin) return resolve(false);
    const child = spawn(bin, [name, 'nullok'], { stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.on('error', () => {});
    // unix_chkpwd closes stdin immediately when running outside its
    // expected PAM/sandbox context — add tiny delay so the pipe write lands
    setTimeout(() => {
      try { child.stdin.end(Buffer.concat([Buffer.from(password, 'utf8'), Buffer.from([0])])); } catch {}
    }, 50);
  });
}

// Fallback PAM verification via su (works both as root in production and as
// regular user in development where unix_chkpwd AppArmor may reject calls).
function checkPasswordSu(name, password) {
  return new Promise((resolve) => {
    const child = spawn('su', ['-s', '/bin/sh', name, '-c', 'exit 0'], { stdio: ['pipe', 'ignore', 'ignore'], timeout: 8000 });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.on('error', () => {});
    try {
      child.stdin.write(password + '\n');
      child.stdin.end();
    } catch { resolve(false); }
  });
}

function checkPassword(name, password) {
  return checkPasswordChkpwd(name, password).then((ok) => {
    if (ok) return true;
    return checkPasswordSu(name, password);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function getSession(req) {
  const tok = parseCookies(req)[COOKIE];
  if (!tok) return null;
  const s = sessions.get(tok);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(tok); return null; }
  return { user: s.user, admin: s.admin };
}

function clientIp(req) {
  const ra = req.socket.remoteAddress || '';
  // only trust the proxy header when the request came from the local nginx
  if (ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1') {
    return String(req.headers['x-real-ip'] || ra);
  }
  return ra;
}

function isSecure(req) {
  return req.headers['x-forwarded-proto'] === 'https';
}

function cookieHeader(req, value, maxAgeSec) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}` + (isSecure(req) ? '; Secure' : '');
}

// Resolves { ok, status, error?, setCookie?, user?, admin? }
async function login(req, name, password) {
  const key = clientIp(req);
  const f = fails.get(key);
  if (f && f.until > Date.now()) return { ok: false, status: 429, error: 'Too many attempts, try again later' };

  const bad = (extra = {}) => {
    const cur = fails.get(key);
    const n = (cur && cur.until === 0 ? cur.n : 0) + 1;
    fails.set(key, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
    return { ok: false, status: 401, error: 'Invalid username or password', ...extra };
  };

  if (typeof name !== 'string' || typeof password !== 'string' || !password || password.length > 256 || password.includes('\0')) return bad();
  const user = lookupUser(name);
  // Always run the password check so unknown vs. known users are indistinguishable by timing.
  const valid = await checkPassword(user ? user.name : 'nobody-' + crypto.randomBytes(4).toString('hex'), password);
  if (!user || !valid) return bad();

  fails.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user: user.name, admin: user.admin, exp: Date.now() + SESSION_TTL_MS });
  return { ok: true, status: 200, user: user.name, admin: user.admin, setCookie: cookieHeader(req, token, SESSION_TTL_MS / 1000) };
}

function logout(req) {
  const tok = parseCookies(req)[COOKIE];
  if (tok) sessions.delete(tok);
  return cookieHeader(req, '', 0);
}

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp < now) sessions.delete(t);
  for (const [k, f] of fails) if (f.until && f.until < now) fails.delete(k);
}, 60_000).unref();

module.exports = { login, logout, getSession };
