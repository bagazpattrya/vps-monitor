'use strict';
// Login against local Linux accounts (zero dependencies).
// Passwords are verified with PAM's unix_chkpwd helper, which only works for
// arbitrary users when the process runs as root.
const fs = require('fs');
const path = require('path');
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
// Matikan login via akun Linux (unix_chkpwd) bila hanya user aplikasi yang boleh masuk.
// Set ALLOW_LINUX_LOGIN=0 di env. Default 1 (aman: tidak mengunci siapa pun).
// PENTING: buat minimal 1 app admin dulu sebelum set 0, kalau tidak tidak ada
// yang bisa login sama sekali (users.json saat ini mungkin masih kosong).
const ALLOW_LINUX_LOGIN = String(process.env.ALLOW_LINUX_LOGIN ?? '1') !== '0';
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

const ROLES = ['viewer', 'admin', 'superadmin'];
const sessions = new Map(); // token -> { user, source: 'app'|'linux', role, exp }
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
  if (s.source === 'app') {
    // Baca ulang dari users.json supaya perubahan role/keyword/disabled langsung berlaku.
    const u = loadAppUsers().find((x) => x.username.toLowerCase() === String(s.user).toLowerCase());
    if (!u || u.disabled) { sessions.delete(tok); return null; }
    const role = roleOf(u);
    return { user: u.username, source: 'app', role, admin: role !== 'viewer', superadmin: role === 'superadmin', hiddenKeywords: role === 'superadmin' ? [] : normKeywords(u.hiddenKeywords) };
  }
  return { user: s.user, source: 'linux', role: s.role, admin: s.role !== 'viewer', superadmin: s.role === 'superadmin', hiddenKeywords: [] };
}

// Konfirmasi ulang password untuk aksi destruktif. Dicek terhadap akun milik session sendiri
// (user app atau akun Linux). Gagal berulang dikunci supaya session curian tidak bisa brute-force.
async function confirmPassword(session, password) {
  const key = 'confirm:' + String(session.user).toLowerCase();
  const f = fails.get(key);
  if (f && f.until > Date.now()) return { ok: false, status: 429, error: 'Terlalu banyak percobaan password, coba lagi nanti' };
  let valid = false;
  if (typeof password === 'string' && password && password.length <= 256 && !password.includes('\0')) {
    if (session.source === 'app') {
      const u = loadAppUsers().find((x) => x.username.toLowerCase() === String(session.user).toLowerCase());
      valid = !!u && await verifyPassword(password, u.salt, u.hash);
    } else {
      valid = !!lookupUser(session.user) && await checkPassword(session.user, password);
    }
  }
  if (!valid) {
    const cur = fails.get(key);
    const n = (cur && cur.until === 0 ? cur.n : 0) + 1;
    fails.set(key, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
    return { ok: false, status: 403, error: 'Password salah' };
  }
  fails.delete(key);
  return { ok: true };
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

// ---- App Users (Virtual web panel users, independent of OS Linux accounts) ----
function loadAppUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAppUsers(users) {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
}

// Role efektif sebuah user app. Data lama hanya punya boolean `admin`:
// admin:true tanpa `role` dianggap superadmin (admin yang sudah ada tidak kehilangan akses).
function roleOf(u) {
  if (u && ROLES.includes(u.role)) return u.role;
  return u && u.admin ? 'superadmin' : 'viewer';
}

function normKeywords(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[\r\n,]+/);
  const out = [];
  for (const x of arr) {
    const k = String(x || '').trim().toLowerCase().slice(0, 64);
    if (k && !out.includes(k)) out.push(k);
  }
  return out.slice(0, 50);
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(derivedKey.toString('hex'));
    });
  });
}

async function verifyPassword(password, salt, expectedHash) {
  try {
    const key = await hashPassword(password, salt);
    const a = Buffer.from(key, 'hex');
    const b = Buffer.from(expectedHash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function revokeUserSessions(username) {
  const lower = String(username).toLowerCase();
  for (const [token, s] of sessions.entries()) {
    if (s.user && s.user.toLowerCase() === lower) {
      sessions.delete(token);
    }
  }
}

function listAppUsers() {
  return loadAppUsers().map((u) => ({
    username: u.username,
    role: roleOf(u),
    admin: roleOf(u) !== 'viewer',
    hiddenKeywords: normKeywords(u.hiddenKeywords),
    disabled: !!u.disabled,
    createdAt: u.createdAt || null,
    updatedAt: u.updatedAt || null,
  }));
}

async function createAppUser(username, password, role = 'viewer', hiddenKeywords = []) {
  if (role === true) role = 'admin';
  if (!ROLES.includes(role)) role = 'viewer';
  const name = String(username || '').trim();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(name)) {
    return { ok: false, error: 'Username must be 3-32 alphanumeric characters (. _ - allowed)' };
  }
  if (typeof password !== 'string' || password.length < 6) {
    return { ok: false, error: 'Password must be at least 6 characters long' };
  }
  const users = loadAppUsers();
  if (users.some((u) => u.username.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: 'Username already exists' };
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPassword(password, salt);
  const newUser = {
    username: name,
    salt,
    hash,
    role,
    admin: role !== 'viewer',
    hiddenKeywords: normKeywords(hiddenKeywords),
    disabled: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  users.push(newUser);
  saveAppUsers(users);
  return {
    ok: true,
    user: {
      username: newUser.username,
      role: newUser.role,
      admin: newUser.admin,
      hiddenKeywords: newUser.hiddenKeywords,
      disabled: newUser.disabled,
      createdAt: newUser.createdAt,
    },
  };
}

async function updateAppUser(username, changes = {}) {
  const name = String(username || '').trim();
  const users = loadAppUsers();
  const idx = users.findIndex((u) => u.username.toLowerCase() === name.toLowerCase());
  if (idx === -1) return { ok: false, error: 'User not found' };

  const target = users[idx];
  let sessionRevokeNeeded = false;

  if (typeof changes.role === 'string' && ROLES.includes(changes.role)) {
    target.role = changes.role;
    target.admin = changes.role !== 'viewer';
  } else if (typeof changes.admin === 'boolean') {
    target.role = changes.admin ? (roleOf(target) === 'viewer' ? 'admin' : roleOf(target)) : 'viewer';
    target.admin = changes.admin;
  }
  if (changes.hiddenKeywords !== undefined) {
    target.hiddenKeywords = normKeywords(changes.hiddenKeywords);
  }
  if (typeof changes.disabled === 'boolean') {
    target.disabled = changes.disabled;
    if (target.disabled) sessionRevokeNeeded = true;
  }
  if (changes.password) {
    if (typeof changes.password !== 'string' || changes.password.length < 6) {
      return { ok: false, error: 'Password must be at least 6 characters long' };
    }
    const newSalt = crypto.randomBytes(16).toString('hex');
    target.salt = newSalt;
    target.hash = await hashPassword(changes.password, newSalt);
    sessionRevokeNeeded = true;
  }

  target.updatedAt = Date.now();
  users[idx] = target;
  saveAppUsers(users);
  if (sessionRevokeNeeded) revokeUserSessions(target.username);

  return {
    ok: true,
    user: {
      username: target.username,
      role: roleOf(target),
      admin: roleOf(target) !== 'viewer',
      hiddenKeywords: normKeywords(target.hiddenKeywords),
      disabled: target.disabled,
      updatedAt: target.updatedAt,
    },
  };
}

function deleteAppUser(username) {
  const name = String(username || '').trim();
  const users = loadAppUsers();
  const filtered = users.filter((u) => u.username.toLowerCase() !== name.toLowerCase());
  if (filtered.length === users.length) return { ok: false, error: 'User not found' };
  saveAppUsers(filtered);
  revokeUserSessions(name);
  return { ok: true };
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

  // 1. Check local application users first
  const appUsers = loadAppUsers();
  const appUser = appUsers.find((u) => u.username.toLowerCase() === name.toLowerCase());
  if (appUser) {
    if (appUser.disabled) return { ok: false, status: 403, error: 'Account is disabled' };
    const valid = await verifyPassword(password, appUser.salt, appUser.hash);
    if (!valid) return bad();

    fails.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { user: appUser.username, source: 'app', exp: Date.now() + SESSION_TTL_MS });
    const role = roleOf(appUser);
    return { ok: true, status: 200, user: appUser.username, role, admin: role !== 'viewer', setCookie: cookieHeader(req, token, SESSION_TTL_MS / 1000) };
  }

  // 2. Fallback to local Linux system accounts (bisa dimatikan via ALLOW_LINUX_LOGIN=0).
  // Otorisasi git pull/restart/etc TIDAK tergantung akun Linux: yang dipakai hanya
  // session.admin (dari users.json) dan proses app yang jalan sebagai root mengeksekusi
  // git sebagai owner folder. Jadi user aplikasi tanpa akun Linux tetap bisa pull.
  if (!ALLOW_LINUX_LOGIN) return bad();
  const user = lookupUser(name);
  // Always run the password check so unknown vs. known users are indistinguishable by timing.
  const valid = await checkPassword(user ? user.name : 'nobody-' + crypto.randomBytes(4).toString('hex'), password);
  if (!user || !valid) return bad();

  fails.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  // Akun Linux: sudo/root = superadmin (perilaku lama = akses penuh), lainnya viewer.
  const lrole = user.admin ? 'superadmin' : 'viewer';
  sessions.set(token, { user: user.name, source: 'linux', role: lrole, exp: Date.now() + SESSION_TTL_MS });
  return { ok: true, status: 200, user: user.name, role: lrole, admin: user.admin, setCookie: cookieHeader(req, token, SESSION_TTL_MS / 1000) };
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

module.exports = {
  login,
  logout,
  getSession,
  confirmPassword,
  ALLOW_LINUX_LOGIN,
  listAppUsers,
  createAppUser,
  updateAppUser,
  deleteAppUser,
  loadAppUsers,
  ROLES,
  roleOf,
  normKeywords,
};
