'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseMarkdown, parseInline } = require('../public/js/md.js');

const walk = (nodes, fn) => { for (const n of nodes || []) { fn(n); walk(n.c, fn); for (const it of n.items || []) { walk(it.c, fn); if (it.sub) walk([it.sub], fn); } for (const r of n.rows || []) for (const cell of r) walk(cell, fn); for (const h of n.head || []) walk(h, fn); } };
const kinds = (src) => { const k = new Set(); walk(parseMarkdown(src), (n) => k.add(n.t)); return k; };

test('paragraph keeps single newlines', () => {
  assert.deepStrictEqual(parseMarkdown('a\nb'), [{ t: 'p', c: [{ t: 'text', v: 'a\nb' }] }]);
});

test('headings 1-4, five hashes is a paragraph', () => {
  assert.strictEqual(parseMarkdown('## Title')[0].l, 2);
  assert.strictEqual(parseMarkdown('##### x')[0].t, 'p');
});

test('inline bold italic code', () => {
  const c = parseInline('**b** and *i* and `c`');
  assert.deepStrictEqual(c.map((n) => n.t), ['b', 'text', 'i', 'text', 'code']);
  assert.strictEqual(c[4].v, 'c');
});

test('globs and snake_case are not formatting', () => {
  assert.deepStrictEqual(parseInline('use *.log and *.txt'), [{ t: 'text', v: 'use *.log and *.txt' }]);
  assert.deepStrictEqual(parseInline('my_var_name'), [{ t: 'text', v: 'my_var_name' }]);
});

test('inline code is literal', () => {
  assert.deepStrictEqual(parseInline('`**x**`'), [{ t: 'code', v: '**x**' }]);
});

test('code fence keeps content literal; unclosed fence still becomes code', () => {
  assert.deepStrictEqual(parseMarkdown('```js\n<b>x</b> **y**\n```'), [{ t: 'code', lang: 'js', text: '<b>x</b> **y**' }]);
  assert.deepStrictEqual(parseMarkdown('```\nopen\nforever'), [{ t: 'code', lang: '', text: 'open\nforever' }]);
});

test('lists: bullets, ordered with start, nested', () => {
  const l = parseMarkdown('- a\n- b\n  - c\n- d')[0];
  assert.strictEqual(l.t, 'ul');
  assert.strictEqual(l.items.length, 3);
  assert.strictEqual(l.items[1].sub.items[0].c[0].v, 'c');
  const o = parseMarkdown('3. x\n\n4. y')[0];
  assert.strictEqual(o.t, 'ol');
  assert.strictEqual(o.start, 3);
  assert.strictEqual(o.items.length, 2);
});

test('table', () => {
  const t = parseMarkdown('| A | B |\n|---|---|\n| 1 | **2** |')[0];
  assert.strictEqual(t.t, 'table');
  assert.strictEqual(t.head.length, 2);
  assert.strictEqual(t.rows[0][1][0].t, 'b');
});

test('quote and hr', () => {
  assert.strictEqual(parseMarkdown('> hi')[0].t, 'quote');
  assert.strictEqual(parseMarkdown('---')[0].t, 'hr');
});

test('only http(s) links; javascript: and data: stay as text', () => {
  const ok = parseInline('[a](https://x.com/p?q=1)');
  assert.deepStrictEqual(ok, [{ t: 'a', href: 'https://x.com/p?q=1', c: [{ t: 'text', v: 'a' }] }]);
  for (const bad of ['[a](javascript:alert(1))', '[a](data:text/html,x)', '[a](//evil.com)', '[a](vbscript:x)']) {
    assert.ok(!kinds(bad).has('a'), bad);
  }
  assert.strictEqual(parseInline('see https://a.io/x.')[1].href, 'https://a.io/x');
});

test('HTML and script tags stay literal text', () => {
  const nodes = parseMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>');
  assert.deepStrictEqual([...kinds('<script>alert(1)</script>')].sort(), ['p', 'text']);
  assert.ok(nodes[0].c[0].v.includes('<script>'));
});

test('empty and weird input does not hang or throw', () => {
  assert.deepStrictEqual(parseMarkdown(''), []);
  for (const s of ['|', '- ', '1.', '```', '>', '* * *', '|a|\n|-|', '\n\n\n', '**', '`', '[', '](']) parseMarkdown(s);
});
