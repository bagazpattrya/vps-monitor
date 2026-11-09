'use strict';
// "Projects" = grouping of existing resources: git repos (deployments), databases and nginx sites.
// Only references are stored (relPath / db name / nginx config path); live status is joined in by server.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_PROJECTS = 200;
const MAX_LINKS = 50;
const ID_RE = /^[a-f0-9]{16}$/;
const DB_RE = /^[A-Za-z0-9_$.-]{1,64}$/;

// Dibaca saat dipanggil supaya test bisa mengganti file.
const dataFile = () => process.env.PROJECTS_FILE || path.join(__dirname, 'data', 'projects.json');

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    return Array.isArray(d.projects) ? d.projects : [];
  } catch { return []; }
}

function save(projects) {
  const file = dataFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, projects }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const validRepo = (s) => typeof s === 'string' && s.length > 0 && s.length <= 300 && !s.includes('..') && !s.startsWith('/') && !s.includes('\0');
const validSite = (s) => typeof s === 'string' && s.length > 0 && s.length <= 500 && s.startsWith('/') && !s.includes('..') && !s.includes('\0');

function cleanList(v, ok, label) {
  if (v == null) return { value: [] };
  if (!Array.isArray(v)) return { error: `${label}: harus berupa daftar` };
  const out = [];
  for (const x of v) {
    if (!ok(x)) return { error: `${label}: nilai tidak valid` };
    if (!out.includes(x)) out.push(x);
  }
  if (out.length > MAX_LINKS) return { error: `${label}: maksimal ${MAX_LINKS} item` };
  return { value: out };
}

// Validasi + normalisasi input form. Mengembalikan { value } atau { error }.
function sanitize(input) {
  const i = input && typeof input === 'object' ? input : {};
  const name = typeof i.name === 'string' ? i.name.trim() : '';
  if (!name) return { error: 'Nama project wajib diisi' };
  if (name.length > 80) return { error: 'Nama project maksimal 80 karakter' };
  const description = typeof i.description === 'string' ? i.description.trim() : '';
  if (description.length > 500) return { error: 'Deskripsi maksimal 500 karakter' };
  const repos = cleanList(i.repos, validRepo, 'repos');
  if (repos.error) return repos;
  const databases = cleanList(i.databases, (s) => typeof s === 'string' && DB_RE.test(s), 'databases');
  if (databases.error) return databases;
  const sites = cleanList(i.sites, validSite, 'sites');
  if (sites.error) return sites;
  return { value: { name, description, repos: repos.value, databases: databases.value, sites: sites.value } };
}

const nameTaken = (list, name, exceptId) => list.some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase());

function list() {
  return load().sort((a, b) => a.name.localeCompare(b.name));
}

function create(input, user) {
  const s = sanitize(input);
  if (s.error) return { ok: false, status: 400, error: s.error };
  const all = load();
  if (all.length >= MAX_PROJECTS) return { ok: false, status: 400, error: `Maksimal ${MAX_PROJECTS} project` };
  if (nameTaken(all, s.value.name)) return { ok: false, status: 409, error: 'Nama project sudah dipakai' };
  const now = Date.now();
  const project = { id: crypto.randomBytes(8).toString('hex'), ...s.value, createdBy: String(user || ''), createdAt: now, updatedAt: now };
  all.push(project);
  save(all);
  return { ok: true, project };
}

function update(id, input) {
  if (!ID_RE.test(String(id))) return { ok: false, status: 404, error: 'Project tidak ditemukan' };
  const all = load();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, status: 404, error: 'Project tidak ditemukan' };
  const s = sanitize(input);
  if (s.error) return { ok: false, status: 400, error: s.error };
  if (nameTaken(all, s.value.name, id)) return { ok: false, status: 409, error: 'Nama project sudah dipakai' };
  all[idx] = { ...all[idx], ...s.value, updatedAt: Date.now() };
  save(all);
  return { ok: true, project: all[idx] };
}

function remove(id) {
  if (!ID_RE.test(String(id))) return { ok: false, status: 404, error: 'Project tidak ditemukan' };
  const all = load();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, status: 404, error: 'Project tidak ditemukan' };
  const [gone] = all.splice(idx, 1);
  save(all);
  return { ok: true, project: gone };
}

// Remote git -> URL web GitHub tanpa kredensial (https://token@github.com/o/r.git -> https://github.com/o/r).
// Mengembalikan { remote, github } ; remote selalu dibersihkan dari userinfo, github null bila bukan GitHub.
function remoteInfo(raw) {
  const r = String(raw || '').trim();
  if (!r) return { remote: '', github: null };
  let m = r.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!m) m = r.match(/^https?:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (m) return { remote: `github.com/${m[1]}/${m[2]}`, github: `https://github.com/${m[1]}/${m[2]}` };
  return { remote: r.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/\s]+@/i, '$1'), github: null };
}

module.exports = { list, create, update, remove, sanitize, remoteInfo };
