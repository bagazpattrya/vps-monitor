'use strict';
// Per-user saved conversations (one JSON file each) and image attachment helpers.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_CHATS = 200;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ID_RE = /^[a-f0-9]{24}$/;

// Dibaca saat dipanggil supaya test bisa mengganti folder.
const dataDir = () => process.env.CHAT_DATA_DIR || path.join(__dirname, 'data', 'chats');
const userDir = (user) => path.join(dataDir(), String(user).replace(/[^A-Za-z0-9._-]/g, '_'));
const isChatId = (id) => typeof id === 'string' && ID_RE.test(id);
const chatFile = (user, id) => path.join(userDir(user), id + '.json');

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function getChat(user, id) {
  if (!isChatId(id)) return null;
  try { return JSON.parse(fs.readFileSync(chatFile(user, id), 'utf8')); } catch { return null; }
}

function listChats(user) {
  let files = [];
  try { files = fs.readdirSync(userDir(user)).filter((f) => f.endsWith('.json')); } catch { return []; }
  const rows = [];
  for (const f of files) {
    const c = getChat(user, f.slice(0, -5));
    if (c) rows.push({ id: c.id, title: c.title, model: c.model, updatedAt: c.updatedAt });
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

function deleteChat(user, id) {
  if (!isChatId(id) || !fs.existsSync(chatFile(user, id))) return false;
  fs.rmSync(chatFile(user, id), { force: true });
  fs.rmSync(path.join(userDir(user), id), { recursive: true, force: true });
  return true;
}

function createChat(user, { message, model }, max = MAX_CHATS) {
  const now = Date.now();
  const chat = {
    id: crypto.randomBytes(12).toString('hex'),
    title: String(message || '').trim().slice(0, 60) || 'New chat',
    model, claudeSessionId: '', createdAt: now, updatedAt: now, messages: [],
  };
  writeAtomic(chatFile(user, chat.id), chat);
  const all = listChats(user);
  for (const old of all.slice(max)) deleteChat(user, old.id);
  return chat;
}

// Baca, ubah, tulis dalam satu langkah sinkron. null bila chat sudah tidak ada (mis. dihapus saat streaming).
function updateChat(user, id, fn) {
  const chat = getChat(user, id);
  if (!chat) return null;
  fn(chat);
  chat.updatedAt = Date.now();
  writeAtomic(chatFile(user, id), chat);
  return chat;
}

function renameChat(user, id, title) {
  const t = typeof title === 'string' ? title.trim().slice(0, 80) : '';
  if (!t) return null;
  return updateChat(user, id, (c) => { c.title = t; });
}

// ---- images ----
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', type: 'image/png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  const head = buf.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return { ext: 'gif', type: 'image/gif' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return null;
}

// list: array of base64 strings (optionally data URLs). Throws Error with a user-facing message.
function decodeImages(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error('Invalid images');
  if (list.length > MAX_IMAGES) throw new Error('Max ' + MAX_IMAGES + ' images per message');
  return list.map((s) => {
    if (typeof s !== 'string') throw new Error('Invalid image');
    const raw = s.replace(/^data:[^;,]+;base64,/, '');
    if (raw.length > MAX_IMAGE_BYTES * 1.4) throw new Error('Image too large (max 5 MB)');
    const buf = Buffer.from(raw, 'base64');
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('Image too large (max 5 MB)');
    const kind = sniffImage(buf);
    if (!kind) throw new Error('Unsupported image (use PNG, JPEG, WebP or GIF)');
    return { buf, ext: kind.ext };
  });
}

function saveImages(user, id, imgs) {
  const dir = path.join(userDir(user), id, 'img');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return imgs.map(({ buf, ext }) => {
    const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(dir, name), buf, { mode: 0o600 });
    return name;
  });
}

module.exports = {
  MAX_CHATS, isChatId, userDir, createChat, getChat, listChats, updateChat, renameChat, deleteChat,
  sniffImage, decodeImages, saveImages,
};
