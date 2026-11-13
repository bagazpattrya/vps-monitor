'use strict';
// Console: a real interactive shell (PTY) in the browser, superadmin only.
// Transport is a minimal RFC 6455 WebSocket (no dependencies). The PTY comes from
// scripts/pty-helper.py because Node has no built-in pty.
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1 << 20; // 1 MiB per client message
const AUTH_TIMEOUT_MS = 20_000;
const IDLE_TIMEOUT_MS = 30 * 60_000;
const RECHECK_MS = 30_000;
const MAX_PER_USER = 3;
const BACKPRESSURE = 4 << 20;
const HELPER = path.join(__dirname, 'scripts', 'pty-helper.py');

// ---- WebSocket framing ----
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

// Incremental parser for client->server frames. Calls onMessage(opcode, Buffer) for
// complete messages (opcode 1 text, 2 binary, 8 close, 9 ping, 10 pong). Throws on protocol errors.
class FrameParser {
  constructor(onMessage, maxMessage = MAX_MESSAGE) {
    this.buf = Buffer.alloc(0);
    this.onMessage = onMessage;
    this.maxMessage = maxMessage;
    this.frag = null; // { opcode, chunks, size }
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = !!(b[0] & 0x80);
      if (b[0] & 0x70) throw new Error('reserved bits set');
      const opcode = b[0] & 0x0f;
      if (!(b[1] & 0x80)) throw new Error('client frame not masked');
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessage)) throw new Error('message too large');
        len = Number(big); off = 10;
      }
      if (len > this.maxMessage) throw new Error('message too large');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);

      if (opcode >= 8) { // control frames: must not be fragmented, <=125 bytes
        if (!fin || len > 125) throw new Error('bad control frame');
        this.onMessage(opcode, data);
        continue;
      }
      if (opcode === 0) { // continuation
        if (!this.frag) throw new Error('unexpected continuation');
        this.frag.size += data.length;
        if (this.frag.size > this.maxMessage) throw new Error('message too large');
        this.frag.chunks.push(data);
        if (fin) { const f = this.frag; this.frag = null; this.onMessage(f.opcode, Buffer.concat(f.chunks)); }
      } else if (opcode === 1 || opcode === 2) {
        if (this.frag) throw new Error('new message during fragmentation');
        if (fin) this.onMessage(opcode, data);
        else this.frag = { opcode, chunks: [data], size: data.length };
      } else throw new Error('bad opcode');
    }
  }
}

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const active = new Map(); // user -> count

// Handles `GET /api/console/ws` upgrade requests. `deps`: { auth, audit }.
function handleUpgrade(req, socket, head, deps) {
  const { auth, audit } = deps;
  const refuse = (code, msg) => {
    socket.end(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  const session = auth.getSession(req);
  if (!session) return refuse(401, 'Unauthorized');
  if (!session.superadmin) return refuse(403, 'Forbidden');
  if (process.env.CONSOLE_DISABLE === '1') return refuse(403, 'Forbidden');
  if (!sameOrigin(req)) return refuse(403, 'Forbidden');
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') return refuse(400, 'Bad Request');
  if ((active.get(session.user) || 0) >= MAX_PER_USER) return refuse(429, 'Too Many Requests');

  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  socket.setNoDelay(true);
  active.set(session.user, (active.get(session.user) || 0) + 1);

  let child = null;
  let closed = false;
  let authed = false;
  let bytesIn = 0, bytesOut = 0;
  const started = Date.now();
  let lastInput = Date.now();

  const sendJson = (o) => { if (!socket.destroyed) socket.write(encodeFrame(1, Buffer.from(JSON.stringify(o)))); };
  const finish = (reason, notify) => {
    if (closed) return;
    closed = true;
    clearTimeout(authTimer);
    clearInterval(watchdog);
    if (notify) { try { sendJson(notify); } catch {} }
    if (child) { try { child.stdin.end(); } catch {} setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref(); }
    try { socket.write(encodeFrame(8, Buffer.alloc(0))); } catch {}
    socket.end();
    const left = (active.get(session.user) || 1) - 1;
    if (left > 0) active.set(session.user, left); else active.delete(session.user);
    if (authed) audit(session.user, 'console.close', 'shell', `${reason} ${Math.round((Date.now() - started) / 1000)}s in=${bytesIn}B out=${bytesOut}B`);
  };

  const authTimer = setTimeout(() => finish('auth-timeout', { t: 'error', error: 'Timed out' }), AUTH_TIMEOUT_MS);

  // Re-check the login every so often so logout / role change / disabled account closes the shell.
  const watchdog = setInterval(() => {
    const s = auth.getSession(req);
    if (!s || !s.superadmin || s.user !== session.user) return finish('session-ended', { t: 'error', error: 'Session ended' });
    if (Date.now() - lastInput > IDLE_TIMEOUT_MS) finish('idle', { t: 'error', error: 'Closed after 30 minutes of inactivity' });
  }, RECHECK_MS);
  watchdog.unref();

  const startShell = (cols, rows) => {
    const shell = process.env.CONSOLE_SHELL || (process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/bash');
    const home = os.homedir();
    // Do not hand the monitor's own secrets (.env tokens) to the shell.
    const env = {
      PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: home, USER: os.userInfo().username, LOGNAME: os.userInfo().username, SHELL: shell,
      TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'C.UTF-8',
    };
    child = spawn(process.env.CONSOLE_PYTHON || 'python3', [HELPER, shell, String(cols), String(rows)], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    child.on('error', (e) => finish('spawn-error', { t: 'error', error: e.code === 'ENOENT' ? 'python3 is required on the server for the Console' : String(e.message) }));
    child.stderr.on('data', (d) => { if (!closed) socket.write(encodeFrame(2, Buffer.from(d))); });
    child.stdout.on('data', (d) => {
      bytesOut += d.length;
      if (closed) return;
      socket.write(encodeFrame(2, d));
      if (socket.writableLength > BACKPRESSURE) { child.stdout.pause(); socket.once('drain', () => child.stdout.resume()); }
    });
    child.on('exit', (code) => finish('shell-exit', { t: 'exit', code }));
    child.stdin.on('error', () => {});
    child.stdio[3].on('error', () => {});
    sendJson({ t: 'ready' });
  };

  const onMessage = async (opcode, data) => {
    if (closed) return;
    if (opcode === 8) return finish('client-close');
    if (opcode === 9) { socket.write(encodeFrame(10, data)); return; }
    if (opcode === 10) return;
    if (!authed) {
      if (opcode !== 1) return finish('protocol', { t: 'error', error: 'Bad request' });
      let m;
      try { m = JSON.parse(data.toString('utf8')); } catch { return finish('protocol', { t: 'error', error: 'Bad request' }); }
      if (!m || m.t !== 'auth' || authed === 'pending') return finish('protocol', { t: 'error', error: 'Bad request' });
      authed = 'pending';
      const pw = await auth.confirmPassword(session, m.password);
      if (closed) return;
      if (!pw.ok) { authed = false; audit(session.user, 'console.denied', 'shell', pw.error); return finish('denied', { t: 'error', error: pw.error }); }
      authed = true;
      clearTimeout(authTimer);
      audit(session.user, 'console.open', 'shell', `ip=${auth.clientIp ? auth.clientIp(req) : req.socket.remoteAddress}`);
      startShell(clampInt(m.cols, 20, 500, 80), clampInt(m.rows, 5, 200, 24));
      return;
    }
    if (authed !== true || !child) return;
    lastInput = Date.now();
    if (opcode === 2) { bytesIn += data.length; child.stdin.write(data); return; }
    let m;
    try { m = JSON.parse(data.toString('utf8')); } catch { return; }
    if (m && m.t === 'in' && typeof m.d === 'string') { bytesIn += Buffer.byteLength(m.d); child.stdin.write(m.d); }
    else if (m && m.t === 'resize') child.stdio[3].write(`${clampInt(m.cols, 20, 500, 80)} ${clampInt(m.rows, 5, 200, 24)}\n`);
  };

  const parser = new FrameParser((op, d) => { onMessage(op, d).catch(() => finish('error')); });
  socket.on('data', (chunk) => {
    try { parser.push(chunk); } catch { finish('protocol', { t: 'error', error: 'Protocol error' }); }
  });
  // http.Server sockets are allowHalfOpen: a vanished browser only gives 'end', never 'close'.
  socket.on('end', () => finish('disconnect'));
  socket.on('close', () => finish('disconnect'));
  socket.on('error', () => finish('socket-error'));
  if (head && head.length) socket.emit('data', head);
}

module.exports = { handleUpgrade, FrameParser, encodeFrame, acceptKey };
