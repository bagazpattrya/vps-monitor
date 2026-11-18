'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const t = require('../traffic');

test('splitHostPort handles ipv4, ipv6 and missing port', () => {
  assert.deepStrictEqual(t.splitHostPort('1.2.3.4:443'), { host: '1.2.3.4', port: 443 });
  assert.deepStrictEqual(t.splitHostPort('[2001:db8::1]:22'), { host: '2001:db8::1', port: 22 });
  assert.deepStrictEqual(t.splitHostPort('nope'), { host: 'nope', port: null });
});

test('parseSs reads -H rows and process names', () => {
  const txt = [
    '0 0 1.2.3.4:443 5.6.7.8:51922 users:(("nginx",pid=111,fd=4))',
    '0 128 [::1]:631 [::1]:41000 users:(("cupsd",pid=222,fd=7))',
  ].join('\n');
  const rows = t.parseSs(txt);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].localPort, 443);
  assert.strictEqual(rows[0].peerHost, '5.6.7.8');
  assert.strictEqual(rows[0].proc, 'nginx');
  assert.strictEqual(rows[0].pid, 111);
  assert.strictEqual(rows[1].sendQ, 128);
  assert.strictEqual(rows[1].localPort, 631);
});

test('splitTraffic: only established hits to a listening port count as inbound', () => {
  const listen = t.listeningPorts(t.parseSs('0 0 0.0.0.0:80 0.0.0.0:*\n0 0 127.0.0.1:3001 0.0.0.0:*'));
  const est = t.parseSs('0 0 10.0.0.5:80 8.8.8.8:5000\n0 0 10.0.0.5:60000 1.1.1.1:443');
  const r = t.splitTraffic(est, listen);
  assert.strictEqual(r.inbound.length, 1);
  assert.strictEqual(r.inbound[0].peerHost, '8.8.8.8');
  assert.strictEqual(r.outbound.length, 1);
});

test('parseAccessLine: combined format', () => {
  const line = '203.0.113.9 - - [18/Nov/2026:10:11:12 +0700] "GET /index.php?x=1 HTTP/1.1" 200 512 "https://ref/" "Mozilla/5.0"';
  const r = t.parseAccessLine(line);
  assert.strictEqual(r.ip, '203.0.113.9');
  assert.strictEqual(r.method, 'GET');
  assert.strictEqual(r.path, '/index.php?x=1');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.bytes, 512);
  assert.strictEqual(r.ua, 'Mozilla/5.0');
  assert.strictEqual(r.probe, '');
});

test('parseAccessLine: vhost prefix, dash bytes, and rejects garbage', () => {
  const r = t.parseAccessLine('shop.example.com:443 198.51.100.7 - - [18/Nov/2026:10:11:12 +0700] "POST /login HTTP/1.1" 302 - "-" "curl/8"');
  assert.strictEqual(r.ip, '198.51.100.7');
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.bytes, 0);
  assert.strictEqual(t.parseAccessLine('not a log line'), null);
  assert.strictEqual(t.parseAccessLine(''), null);
});

test('classifyPath flags scanner paths but not normal pages', () => {
  assert.strictEqual(t.classifyPath('/.env'), 'secret-file');
  assert.strictEqual(t.classifyPath('/wp-login.php'), 'wordpress');
  assert.strictEqual(t.classifyPath('/phpmyadmin/index.php'), 'db-admin');
  assert.strictEqual(t.classifyPath('/../../etc/passwd'), 'exploit');
  assert.strictEqual(t.classifyPath('/about'), '');
  assert.strictEqual(t.classifyPath('/api/orders'), '');
});

test('readIncremental returns only new complete lines and survives truncation', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-')), 'access.log');
  const state = new Map();
  fs.writeFileSync(file, 'a\n');
  assert.strictEqual(t.readIncremental(file, state), 'a\n');
  assert.strictEqual(t.readIncremental(file, state), '');
  fs.appendFileSync(file, 'b\npart');
  assert.strictEqual(t.readIncremental(file, state), 'b\n');
  fs.writeFileSync(file, 'z\n'); // logrotate: file lebih kecil dari offset
  assert.strictEqual(t.readIncremental(file, state), 'z\n');
});

test('summarize counts status buckets, probes and top lists', () => {
  const rows = [
    { ip: '1.1.1.1', method: 'GET', path: '/', status: 200, probe: '' },
    { ip: '1.1.1.1', method: 'GET', path: '/.env', status: 404, probe: 'secret-file' },
    { ip: '2.2.2.2', method: 'POST', path: '/login', status: 500, probe: '' },
    { ip: '3.3.3.3', method: 'GET', path: '/old', status: 301, probe: '' },
  ];
  const s = t.summarize(rows);
  assert.strictEqual(s.stats.total, 4);
  assert.strictEqual(s.stats.ok, 1);
  assert.strictEqual(s.stats.redirect, 1);
  assert.strictEqual(s.stats.client, 1);
  assert.strictEqual(s.stats.server, 1);
  assert.strictEqual(s.stats.probes, 1);
  assert.strictEqual(s.stats.uniqueIps, 3);
  assert.deepStrictEqual(s.topIps[0], ['1.1.1.1', 2]);
  assert.ok(s.topPaths.some(([k]) => k === 'GET /.env'));
});
