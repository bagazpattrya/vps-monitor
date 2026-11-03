// Small, safe markdown renderer for the AI chat. parseMarkdown() is pure (tested in Node);
// renderMarkdown() builds DOM nodes with createElement/textContent only, never innerHTML,
// so HTML found in logs or files cannot execute. Only http(s) links are ever linked.
(function (root) {
  'use strict';

  const INLINE_SRC = /(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*|\*([^\s*](?:[^*\n]*?[^\s*])?)\*|(https?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"])/;
  const SAFE_URL = /^https?:\/\//i;
  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function pushText(out, v) {
    if (!v) return;
    const last = out[out.length - 1];
    if (last && last.t === 'text') last.v += v; else out.push({ t: 'text', v });
  }

  function parseInline(s) {
    const out = [];
    let last = 0;
    let m;
    const re = new RegExp(INLINE_SRC.source, 'g'); // own regex per call: parseInline recurses
    while ((m = re.exec(s))) {
      pushText(out, s.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1]) out.push({ t: 'code', v: m[2] });
      else if (m[3] !== undefined) {
        if (SAFE_URL.test(m[4])) out.push({ t: 'a', href: m[4], c: parseInline(m[3]) });
        else pushText(out, m[0]);
      } else if (m[5] !== undefined) out.push({ t: 'b', c: parseInline(m[5]) });
      else if (m[6] !== undefined) out.push({ t: 'i', c: parseInline(m[6]) });
      else out.push({ t: 'a', href: m[7], c: [{ t: 'text', v: m[7] }] });
    }
    pushText(out, s.slice(last));
    return out;
  }

  function splitRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => parseInline(c.trim()));
  }

  function parseList(lines, i) {
    const first = LIST_RE.exec(lines[i]);
    const base = first[1].length;
    const ordered = /\d/.test(first[2]);
    const list = { t: ordered ? 'ol' : 'ul', items: [] };
    if (ordered) list.start = parseInt(first[2], 10);
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { // blank line: the list goes on only if the next item is at this level or deeper
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        const nm = j < lines.length ? LIST_RE.exec(lines[j]) : null;
        if (nm && nm[1].length >= base) { i = j; continue; }
        break;
      }
      const m = LIST_RE.exec(line);
      if (m && m[1].length === base) { list.items.push({ c: parseInline(m[3]), sub: null }); i++; continue; }
      if (m && m[1].length > base && list.items.length) {
        const [sub, ni] = parseList(lines, i);
        list.items[list.items.length - 1].sub = sub;
        i = ni;
        continue;
      }
      if (!m && list.items.length && /^\s+\S/.test(line) && line.match(/^\s*/)[0].length > base) { // wrapped item text
        const item = list.items[list.items.length - 1];
        pushText(item.c, '\n' + line.trim());
        i++;
        continue;
      }
      break;
    }
    return [list, i];
  }

  function parseBlocks(lines) {
    const out = [];
    let i = 0;
    const startsBlock = (l) => /^\s*(`{3,}|~{3,})/.test(l) || /^#{1,4}\s/.test(l) || LIST_RE.test(l) || /^\s*>/.test(l);
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;
      if ((m = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/.exec(line))) {
        const closer = new RegExp('^\\s*' + m[1][0] + '{' + m[1].length + ',}\\s*$');
        const body = [];
        i++;
        while (i < lines.length && !closer.test(lines[i])) body.push(lines[i++]);
        i++;
        out.push({ t: 'code', lang: m[2] || '', text: body.join('\n') });
        continue;
      }
      if ((m = /^(#{1,4})\s+(.*?)\s*#*\s*$/.exec(line))) { out.push({ t: 'h', l: m[1].length, c: parseInline(m[2]) }); i++; continue; }
      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const head = splitRow(line);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
        out.push({ t: 'table', head, rows });
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push({ t: 'hr' }); i++; continue; }
      if (LIST_RE.test(line)) { const [list, ni] = parseList(lines, i); out.push(list); i = ni; continue; }
      if (/^\s*>/.test(line)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push({ t: 'quote', c: parseBlocks(q) });
        continue;
      }
      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++]);
      out.push({ t: 'p', c: parseInline(para.join('\n')) });
    }
    return out;
  }

  function parseMarkdown(src) {
    return parseBlocks(String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n'));
  }

  // ---- DOM (browser only) ----
  function copyText(text, btn) {
    const done = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); };
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(done, () => {}); return; }
    const ta = document.createElement('textarea'); // fallback for plain http
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    ta.remove();
  }

  function el(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  function inlineToDom(nodes, parent) {
    for (const n of nodes) {
      if (n.t === 'text') parent.appendChild(document.createTextNode(n.v));
      else if (n.t === 'code') { el('code', 'md-inline', parent).textContent = n.v; }
      else if (n.t === 'b') inlineToDom(n.c, el('strong', '', parent));
      else if (n.t === 'i') inlineToDom(n.c, el('em', '', parent));
      else if (n.t === 'a') {
        const a = el('a', '', parent);
        a.href = n.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
        inlineToDom(n.c, a);
      }
    }
  }

  function listToDom(list, parent) {
    const l = el(list.t, '', parent);
    if (list.t === 'ol' && list.start && list.start !== 1) l.start = list.start;
    for (const it of list.items) {
      const li = el('li', '', l);
      inlineToDom(it.c, li);
      if (it.sub) listToDom(it.sub, li);
    }
  }

  function blocksToDom(blocks, parent) {
    for (const b of blocks) {
      if (b.t === 'p') inlineToDom(b.c, el('p', '', parent));
      else if (b.t === 'h') inlineToDom(b.c, el('h' + (b.l + 2), 'md-h', parent)); // h1 -> h3 inside a chat
      else if (b.t === 'hr') el('hr', '', parent);
      else if (b.t === 'quote') blocksToDom(b.c, el('blockquote', '', parent));
      else if (b.t === 'ul' || b.t === 'ol') listToDom(b, parent);
      else if (b.t === 'code') {
        const box = el('div', 'md-codeblock', parent);
        const head = el('div', 'md-codehead', box);
        el('span', '', head).textContent = b.lang || 'code';
        const btn = el('button', 'md-copy', head);
        btn.type = 'button'; btn.textContent = 'Copy';
        btn.onclick = () => copyText(b.text, btn);
        el('code', '', el('pre', '', box)).textContent = b.text;
      } else if (b.t === 'table') {
        const wrap = el('div', 'md-table', parent);
        const t = el('table', '', wrap);
        const tr = el('tr', '', el('thead', '', t));
        for (const c of b.head) inlineToDom(c, el('th', '', tr));
        const tb = el('tbody', '', t);
        for (const r of b.rows) { const row = el('tr', '', tb); for (const c of r) inlineToDom(c, el('td', '', row)); }
      }
    }
  }

  function renderMarkdown(src) {
    const frag = document.createDocumentFragment();
    blocksToDom(parseMarkdown(src), frag);
    return frag;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { parseMarkdown, parseInline };
  else { root.parseMarkdown = parseMarkdown; root.renderMarkdown = renderMarkdown; }
})(typeof window !== 'undefined' ? window : globalThis);
