'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'proj-')), 'projects.json');
process.env.PROJECTS_FILE = file;
const projects = require('../projects');

test('create stores references and rejects duplicate names (case-insensitive)', () => {
  const r = projects.create({ name: ' Shop ', description: 'd', repos: ['a/shop', 'a/shop'], databases: ['shop_db'], sites: ['/etc/nginx/sites-enabled/shop'] }, 'root');
  assert.ok(r.ok);
  assert.strictEqual(r.project.name, 'Shop');
  assert.deepStrictEqual(r.project.repos, ['a/shop']); // de-duplicated
  assert.strictEqual(r.project.createdBy, 'root');
  const dup = projects.create({ name: 'SHOP' });
  assert.strictEqual(dup.status, 409);
  assert.strictEqual(projects.list().length, 1);
});

test('sanitize rejects bad input', () => {
  assert.ok(projects.sanitize({}).error);
  assert.ok(projects.sanitize({ name: 'x'.repeat(81) }).error);
  assert.ok(projects.sanitize({ name: 'p', repos: ['../etc'] }).error);
  assert.ok(projects.sanitize({ name: 'p', repos: ['/abs'] }).error);
  assert.ok(projects.sanitize({ name: 'p', databases: ['bad name;drop'] }).error);
  assert.ok(projects.sanitize({ name: 'p', sites: ['relative/path'] }).error);
  assert.ok(projects.sanitize({ name: 'p', repos: 'nope' }).error);
  assert.ok(projects.sanitize({ name: 'p', databases: Array.from({ length: 51 }, (_, i) => 'db' + i) }).error);
  assert.deepStrictEqual(projects.sanitize({ name: 'p' }).value.repos, []);
});

test('update changes links, keeps id, and enforces unique names', () => {
  const a = projects.create({ name: 'Alpha' }, 'u').project;
  const b = projects.create({ name: 'Beta' }, 'u').project;
  const u = projects.update(a.id, { name: 'Alpha2', databases: ['alpha_db'] });
  assert.ok(u.ok);
  assert.strictEqual(u.project.id, a.id);
  assert.deepStrictEqual(u.project.databases, ['alpha_db']);
  assert.strictEqual(projects.update(a.id, { name: 'beta' }).status, 409);
  assert.strictEqual(projects.update(b.id, { name: 'Beta' }).ok, true); // own name is fine
  assert.strictEqual(projects.update('nonexistent', { name: 'z' }).status, 404);
});

test('remove deletes only the project', () => {
  const p = projects.create({ name: 'Temp' }, 'u').project;
  assert.ok(projects.remove(p.id).ok);
  assert.strictEqual(projects.remove(p.id).status, 404);
  assert.ok(!projects.list().some((x) => x.id === p.id));
});

test('remoteInfo builds a GitHub URL and strips credentials', () => {
  assert.deepStrictEqual(projects.remoteInfo('git@github.com:org/repo.git'), { remote: 'github.com/org/repo', github: 'https://github.com/org/repo' });
  assert.strictEqual(projects.remoteInfo('https://ghp_secret@github.com/org/repo.git').github, 'https://github.com/org/repo');
  assert.ok(!projects.remoteInfo('https://user:tok@github.com/org/repo').remote.includes('tok'));
  const other = projects.remoteInfo('https://user:tok@gitlab.com/o/r.git');
  assert.strictEqual(other.github, null);
  assert.ok(!other.remote.includes('tok'));
  assert.deepStrictEqual(projects.remoteInfo(''), { remote: '', github: null });
});

test('data/projects.json is git-ignored', () => {
  assert.ok(/^data\/projects\.json$/m.test(fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8')));
});

test('category is trimmed, optional, length-limited and can be changed/cleared', () => {
  assert.strictEqual(projects.sanitize({ name: 'p' }).value.category, '');
  assert.strictEqual(projects.sanitize({ name: 'p', category: '  Client   A ' }).value.category, 'Client A');
  assert.ok(projects.sanitize({ name: 'p', category: 'x'.repeat(41) }).error);
  const p = projects.create({ name: 'Catty', category: 'Internal' }, 'u').project;
  assert.strictEqual(p.category, 'Internal');
  assert.strictEqual(projects.update(p.id, { name: 'Catty', category: '' }).project.category, '');
});
