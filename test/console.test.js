'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { handleUpgrade, FrameParser, encodeFrame, acceptKey } = require('../console.js');

function maskedFrame(opcode, payload, { fin = true } = {}) {
  const mask = crypto.randomBytes(4);
  const data = Buffer.from(payload);
  const masked = Buffer.from(data.map((b, i) => b ^ mask[i & 3]));
  let head;
  if (data.length < 126) head = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | data.length]);
  else { head = Buffer.alloc(4); head[0] = (fin ? 0x80 : 0) | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(data.length, 2); }
  return Buffer.concat([head, mask, masked]);
}

test('acceptKey matches RFC 6455 example', () => {
  assert.strictEqual(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('FrameParser: split chunks, 16-bit length, fragmentation, control frames', () => {
  const got = [];
  const p = new FrameParser((op, d) => got.push([op, d.toString()]));
  const f = maskedFrame(1, 'hello');
  p.push(f.subarray(0, 3)); p.push(f.subarray(3));
  const big = 'x'.repeat(300);
  p.push(maskedFrame(1, big));
  p.push(Buffer.concat([maskedFrame(1, 'ab', { fin: false }), maskedFrame(0, 'cd')]));
  p.push(maskedFrame(9, 'ping'));
  assert.deepStrictEqual(got, [[1, 'hello'], [1, big], [1, 'abcd'], [9, 'ping']]);
});

test('FrameParser rejects unmasked, oversized and fragmented-control frames', () => {
  assert.throws(() => new FrameParser(() => {}).push(Buffer.from([0x81, 0x01, 0x41])), /not masked/);
  assert.throws(() => new FrameParser(() => {}, 10).push(maskedFrame(1, 'x'.repeat(11))), /too large/);
  assert.throws(() => new FrameParser(() => {}).push(maskedFrame(9, 'x', { fin: false })), /control/);
});

// ---- integration against a real shell ----
function startServer(session, passwordOk = true) {
  const audits = [];
  const auth = {
    getSession: () => session,
    confirmPassword: async (_s, pw) => (pw === 'secret' && passwordOk ? { ok: true } : { ok: false, status: 403, error: 'Password salah' }),
    clientIp: () => '127.0.0.1',
  };
  const srv = http.createServer((q, r) => r.end());
  srv.on('upgrade', (req, sock, head) => handleUpgrade(req, sock, head, { auth, audit: (...a) => audits.push(a) }));
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, audits, port: srv.address().port })));
}

function connect(port, { origin = true } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    let head = '';
    const msgs = [];
    let upgraded = false;
    const parserFrames = [];
    s.on('connect', () => s.write(`GET /api/console/ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${origin ? `Origin: http://127.0.0.1:${port}\r\n` : ''}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      if (!upgraded) {
        head += d.toString('latin1');
        const i = head.indexOf('\r\n\r\n');
        if (i < 0) return;
        const status = parseInt(head.split(' ')[1], 10);
        if (status !== 101) { s.destroy(); return resolve({ status }); }
        upgraded = true;
        d = Buffer.from(head.slice(i + 4), 'latin1');
        resolve({ status, sock: s, msgs, send: (op, p) => s.write(maskedFrame(op, p)) });
      }
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) { // server frames are unmasked
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) break;
        msgs.push({ op: buf[0] & 0x0f, data: buf.subarray(off, off + len) });
        buf = buf.subarray(off + len);
      }
    });
    s.on('error', reject);
  });
}
const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); } throw new Error('timeout'); };
const text = (c) => c.msgs.filter((m) => m.op === 2).map((m) => m.data.toString()).join('');
const json = (c) => c.msgs.filter((m) => m.op === 1).map((m) => JSON.parse(m.data.toString()));

test('refuses non-superadmin, anonymous and cross-origin', async () => {
  for (const [session, opts, code] of [[null, {}, 401], [{ user: 'a', admin: true, superadmin: false }, {}, 403], [{ user: 'a', admin: true, superadmin: true }, { origin: false }, 403]]) {
    const { srv, port } = await startServer(session);
    assert.strictEqual((await connect(port, opts)).status, code);
    srv.close();
  }
});

test('wrong password never starts a shell', async () => {
  const { srv, port, audits } = await startServer({ user: 'root', admin: true, superadmin: true });
  const c = await connect(port);
  c.send(1, JSON.stringify({ t: 'auth', password: 'nope', cols: 80, rows: 24 }));
  await waitFor(() => json(c).find((m) => m.t === 'error'));
  assert.ok(audits.some((a) => a[1] === 'console.denied'));
  assert.ok(!audits.some((a) => a[1] === 'console.open'));
  c.sock.destroy(); srv.close();
});

test('real PTY: runs commands, tty, resize, exit code, audit', async (t) => {
  const { srv, port, audits } = await startServer({ user: 'root', admin: true, superadmin: true });
  process.env.CONSOLE_SHELL = '/bin/sh';
  const c = await connect(port);
  c.send(1, JSON.stringify({ t: 'auth', password: 'secret', cols: 100, rows: 30 }));
  await waitFor(() => json(c).find((m) => m.t === 'ready'));
  c.send(1, JSON.stringify({ t: 'in', d: 'echo A$((6*7))B; tty; stty size\n' }));
  await waitFor(() => /A42B/.test(text(c)) && /\d+ \d+/.test(text(c)));
  assert.match(text(c), /\/dev\/(pts|tty)/);
  assert.match(text(c), /30 100/);
  c.send(1, JSON.stringify({ t: 'resize', cols: 120, rows: 40 }));
  c.send(1, JSON.stringify({ t: 'in', d: 'stty size\n' }));
  await waitFor(() => /40 120/.test(text(c)));
  c.send(1, JSON.stringify({ t: 'in', d: 'exit 3\n' }));
  const ex = await waitFor(() => json(c).find((m) => m.t === 'exit'));
  assert.strictEqual(ex.code, 3);
  await waitFor(() => audits.some((a) => a[1] === 'console.close'));
  assert.ok(audits.some((a) => a[1] === 'console.open'));
  c.sock.destroy(); srv.close();
});

test('closing the socket kills the shell', async () => {
  const { srv, port, audits } = await startServer({ user: 'root', admin: true, superadmin: true });
  process.env.CONSOLE_SHELL = '/bin/sh';
  const c = await connect(port);
  c.send(1, JSON.stringify({ t: 'auth', password: 'secret' }));
  await waitFor(() => json(c).find((m) => m.t === 'ready'));
  c.send(1, JSON.stringify({ t: 'in', d: 'echo PID=$$\n' }));
  const pid = parseInt((await waitFor(() => text(c).match(/PID=(\d+)/))) [1], 10);
  c.sock.destroy();
  await waitFor(() => audits.some((a) => a[1] === 'console.close'));
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  srv.close();
});
