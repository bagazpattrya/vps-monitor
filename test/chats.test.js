'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const chats = require('../chats.js');

process.env.CHAT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const b64 = (b) => b.toString('base64');

test('isChatId accepts only 24 lowercase hex', () => {
  assert.ok(chats.isChatId('a'.repeat(24)));
  for (const x of ['../../users', 'a'.repeat(23), 'a'.repeat(25), 'A'.repeat(24), '', null, 5]) assert.ok(!chats.isChatId(x), String(x));
});

test('create, get, list newest first, title from message', async () => {
  const a = chats.createChat('alice', { message: '  ' + 'x'.repeat(100), model: 'sonnet' });
  assert.strictEqual(a.title, 'x'.repeat(60));
  assert.ok(chats.isChatId(a.id));
  await sleep(5);
  const b = chats.createChat('alice', { message: 'second', model: 'haiku' });
  assert.deepStrictEqual(chats.listChats('alice').map((c) => c.id), [b.id, a.id]);
  await sleep(5);
  chats.updateChat('alice', a.id, (c) => { c.messages.push({ role: 'user', text: 'hi', t: 1 }); });
  assert.deepStrictEqual(chats.listChats('alice').map((c) => c.id), [a.id, b.id]);
  assert.strictEqual(chats.getChat('alice', a.id).messages.length, 1);
});

test('other users and bad ids get null/false and nothing is touched', () => {
  const a = chats.createChat('alice2', { message: 'secret', model: 'sonnet' });
  assert.strictEqual(chats.getChat('bob', a.id), null);
  assert.strictEqual(chats.deleteChat('bob', a.id), false);
  assert.strictEqual(chats.updateChat('bob', a.id, () => {}), null);
  assert.ok(chats.getChat('alice2', a.id));
  assert.strictEqual(chats.getChat('alice2', '../../x'), null);
  assert.strictEqual(chats.deleteChat('alice2', '../../x'), false);
});

test('updateChat on a missing chat does not create a file', () => {
  const id = 'b'.repeat(24);
  assert.strictEqual(chats.updateChat('carol', id, (c) => { c.title = 'x'; }), null);
  assert.ok(!fs.existsSync(path.join(chats.userDir('carol'), id + '.json')));
});

test('rename trims and caps at 80; empty is refused', () => {
  const a = chats.createChat('dave', { message: 'm', model: 'sonnet' });
  assert.strictEqual(chats.renameChat('dave', a.id, '  ' + 'y'.repeat(90)).title, 'y'.repeat(80));
  assert.strictEqual(chats.renameChat('dave', a.id, '   '), null);
});

test('deleteChat removes json and images folder', () => {
  const a = chats.createChat('erin', { message: 'm', model: 'sonnet' });
  chats.saveImages('erin', a.id, [{ buf: PNG, ext: 'png' }]);
  assert.ok(fs.existsSync(path.join(chats.userDir('erin'), a.id, 'img')));
  assert.strictEqual(chats.deleteChat('erin', a.id), true);
  assert.ok(!fs.existsSync(path.join(chats.userDir('erin'), a.id)));
  assert.ok(!fs.existsSync(path.join(chats.userDir('erin'), a.id + '.json')));
});

test('createChat keeps at most max chats per user, dropping the oldest', async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) { ids.push(chats.createChat('frank', { message: 'm' + i, model: 'sonnet' }, 2).id); await sleep(5); }
  const left = chats.listChats('frank').map((c) => c.id);
  assert.strictEqual(left.length, 2);
  assert.ok(!left.includes(ids[0]));
});

test('sniffImage recognises png jpeg gif webp and rejects text', () => {
  assert.strictEqual(chats.sniffImage(PNG).ext, 'png');
  assert.strictEqual(chats.sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)])).ext, 'jpg');
  assert.strictEqual(chats.sniffImage(Buffer.from('GIF89a......')).ext, 'gif');
  assert.strictEqual(chats.sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])).ext, 'webp');
  assert.strictEqual(chats.sniffImage(Buffer.from('<script>alert(1)</script>')), null);
});

test('decodeImages enforces type, size and count', () => {
  assert.deepStrictEqual(chats.decodeImages(undefined), []);
  const ok = chats.decodeImages(['data:image/png;base64,' + b64(PNG), b64(PNG)]);
  assert.strictEqual(ok.length, 2);
  assert.strictEqual(ok[0].ext, 'png');
  assert.throws(() => chats.decodeImages([b64(Buffer.from('not an image at all'))]), /Unsupported/);
  assert.throws(() => chats.decodeImages(Array(5).fill(b64(PNG))), /Max 4/);
  assert.throws(() => chats.decodeImages([123]), /Invalid/);
  assert.throws(() => chats.decodeImages('x'), /Invalid/);
  const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
  assert.throws(() => chats.decodeImages([b64(big)]), /too large/);
});

test('saveImages writes server-made names', () => {
  const a = chats.createChat('gina', { message: 'm', model: 'sonnet' });
  const names = chats.saveImages('gina', a.id, [{ buf: PNG, ext: 'png' }, { buf: PNG, ext: 'png' }]);
  assert.strictEqual(names.length, 2);
  assert.notStrictEqual(names[0], names[1]);
  for (const n of names) {
    assert.match(n, /^[a-f0-9]{16}\.(png|jpg|webp|gif)$/);
    assert.deepStrictEqual(fs.readFileSync(path.join(chats.userDir('gina'), a.id, 'img', n)), PNG);
  }
});
