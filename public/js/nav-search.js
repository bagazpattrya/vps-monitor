// Menu search in the navbar (shared by every page). Opens a palette that lists the sidebar links.
//   Shift Shift / Ctrl+K   open or close   ·   ↑ ↓ move   ·   Enter open   ·   Esc close
(() => {
  const bar = document.querySelector('.header-right');
  if (!bar) return;
  const DOUBLE_MS = 400;

  const btn = document.createElement('button');
  btn.className = 'btn'; btn.type = 'button'; btn.id = 'navSearchBtn';
  btn.title = 'Cari menu (Shift Shift / Ctrl+K)';
  btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><span class="nav-search-label">Cari menu</span>';
  bar.prepend(btn);

  const pal = document.createElement('div');
  pal.className = 'palette'; pal.hidden = true;
  pal.innerHTML = '<div class="palette-box" role="dialog" aria-label="Cari menu"><input class="input" id="paletteInput" placeholder="Cari menu..." autocomplete="off" spellcheck="false" /><div class="palette-list" id="paletteList"></div></div>';
  document.body.append(pal);
  const input = pal.querySelector('input'), list = pal.querySelector('.palette-list');
  let sel = 0, shown = [];

  const links = () => [...document.querySelectorAll('.sidebar .nav-link')].filter((l) => getComputedStyle(l).display !== 'none');
  const render = () => {
    const q = input.value.trim().toLowerCase();
    shown = links().filter((l) => !q || l.textContent.toLowerCase().includes(q));
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((l, i) => {
      const row = document.createElement('div');
      row.className = 'palette-item' + (i === sel ? ' sel' : '');
      row.style.setProperty('--c', (l.getAttribute('style') || '').match(/--c:([\d,]+)/)?.[1] || '99,102,241');
      row.append(l.querySelector('.nav-ico').cloneNode(true), l.textContent.trim());
      row.onclick = () => go(l);
      row.onmousemove = () => { if (sel !== i) { sel = i; mark(); } };
      return row;
    }));
    if (!shown.length) list.innerHTML = '<div class="palette-empty">Tidak ada menu</div>';
  };
  const mark = () => { [...list.children].forEach((r, i) => r.classList.toggle('sel', i === sel)); list.children[sel]?.scrollIntoView({ block: 'nearest' }); };
  const isOpen = () => !pal.hidden;
  const open = () => { sel = 0; input.value = ''; pal.hidden = false; render(); input.focus(); };
  const close = () => { pal.hidden = true; };
  const go = (l) => { close(); l.click(); };

  btn.onclick = open;
  pal.addEventListener('mousedown', (e) => { if (e.target === pal) close(); });
  input.addEventListener('input', () => { sel = 0; render(); });

  let lastShift = 0;
  document.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (isOpen()) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) { sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length; mark(); } return; }
      if (e.key === 'Enter') { e.preventDefault(); if (shown[sel]) go(shown[sel]); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); isOpen() ? close() : open(); return; }
    if (e.key !== 'Shift') { lastShift = 0; return; }
    // Typing in a field (or the terminal) never counts, except the palette's own input so Shift Shift can close it.
    if (e.repeat || (e.target.closest?.('input, textarea, select, [contenteditable], .xterm') && e.target !== input)) { lastShift = 0; return; }
    const now = Date.now();
    if (lastShift && now - lastShift < DOUBLE_MS) { e.preventDefault(); lastShift = 0; isOpen() ? close() : open(); } else lastShift = now;
  }, true);
})();
