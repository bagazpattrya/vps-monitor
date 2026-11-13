const $ = id => document.getElementById(id);

let errorData = null;
let errorViewEntries = [];
let errorLevel = 'all';
let errorSorted = [];
let errorShowLimit = 100;
const errorSelected = new Set();

async function j(u) {
  const r = await fetch(u);
  if (r.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  if (!r.ok) throw new Error('fetch error');
  return r.json();
}
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Request gagal');
  return d;
}
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function openModalText(title, text, ok) {
  $('gitModalTitle').textContent = title;
  $('gitModalBody').textContent = text;
  $('gitModalBody').className = 'modal-body' + (ok === false ? ' err' : '');
  $('gitModal').classList.add('open');
}
$('gitModalClose').addEventListener('click', () => $('gitModal').classList.remove('open'));

let isAdmin = false;
j('/api/me').then(m => {
  isAdmin = !!m.admin;
  $('who').innerHTML = `<strong>${escHtml(m.user)}</strong>${m.role === 'superadmin' ? '<span class="role">superadmin</span>' : m.admin ? '<span class="role">admin</span>' : ''}`;
  $('sideUserName').textContent = m.user;
  $('sideUserAvatar').textContent = String(m.user || '?').charAt(0);
  $('sideUserRole').textContent = m.role === 'superadmin' ? 'superadmin' : m.admin ? 'admin' : 'viewer';
  $('sideUser').style.display = '';
  if (!m.admin) { location.href = '/'; return; }
  ['Users', 'Files', 'Console'].forEach(n => { if (m.superadmin && $('navLink' + n)) $('navLink' + n).style.display = ''; });
  ['Backups', 'Sites', 'Deploy', 'Activity', 'Errors', 'Chat'].forEach(n => { if ($('navLink' + n)) $('navLink' + n).style.display = ''; });
  $('pm2RestartBtn').style.display = '';
  errors();
}).catch(() => {});

$('logout').onclick = $('sideLogout').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
};
$('pm2RestartBtn').onclick = async () => {
  if (!confirm('Restart aplikasi VPS Monitor via pm2? Dashboard akan terputus beberapa detik.')) return;
  const btn = $('pm2RestartBtn');
  btn.disabled = true;
  btn.classList.add('busy');
  btn.querySelector('.nav-action-label').textContent = 'Restarting…';
  try {
    await api('POST', '/api/pm2/restart');
    setTimeout(() => location.reload(), 4000);
  } catch (e) {
    alert('Restart gagal: ' + e.message);
    btn.disabled = false;
    btn.classList.remove('busy');
    btn.querySelector('.nav-action-label').textContent = 'PM2 Restart';
  }
};

async function stats() {
  try {
    const s = await j('/api/stats');
    $('host').innerHTML = `<strong>${escHtml(s.hostname)}</strong>`;
    if (s.os && s.os !== s.hostname) { $('os').textContent = s.os; $('os').style.display = ''; $('hostBox').title = s.os; }
    else { $('os').style.display = 'none'; $('hostBox').title = ''; }
    const up = Math.floor(s.uptime);
    $('uptime').textContent = `up ${Math.floor(up / 86400)}d ${Math.floor((up % 86400) / 3600)}h ${Math.floor((up % 3600) / 60)}m`;
    $('time').textContent = new Date(s.time).toLocaleTimeString();
  } catch (e) {}
}
stats();
setInterval(stats, 3000);

const toggleSidebar = (open) => {
  const show = typeof open === 'boolean' ? open : !$('sidebar').classList.contains('open');
  $('sidebar').classList.toggle('open', show);
  $('sidebarOverlay').classList.toggle('open', show);
};
$('vpsMonitorBtn').addEventListener('click', () => toggleSidebar());
$('sidebarClose').addEventListener('click', () => toggleSidebar(false));
$('sidebarOverlay').addEventListener('click', () => toggleSidebar(false));
$('navSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
$('navSearch').addEventListener('input', (e) => {
  const q = e.target.textContent.trim().toLowerCase();
  document.querySelectorAll('.sidebar .nav-link').forEach(l => l.classList.toggle('nav-hide', !!q && !l.textContent.toLowerCase().includes(q)));
});

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return;
  const t = $('errorSearch');
  if (document.activeElement === t) return;
  e.preventDefault(); t.focus(); t.select();
});

// ---- Error logs ----
function errorProjectCounts() {
  const counts = new Map();
  for (const s of (errorData && errorData.sources) || []) {
    if (!s.project) continue;
    counts.set(s.project, (counts.get(s.project) || 0) + ((s.counts && s.counts.total) || 0));
  }
  return counts;
}

function renderErrorProjects() {
  const sel = $('errorProject');
  if (!sel || !errorData) return;
  const cur = sel.value;
  const counts = errorProjectCounts();
  const projects = [...counts.keys()].sort((a, b) => (counts.get(b) - counts.get(a)) || a.localeCompare(b));
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  sel.innerHTML = `<option value="">All projects (${total})</option>` + projects.map(p =>
    `<option value="${escHtml(p)}">${escHtml(p)} (${counts.get(p)})</option>`
  ).join('');
  const want = pendingProject || cur;
  if (want && projects.includes(want)) sel.value = want;
}

function syncErrorSelection() {
  const bar = $('errorSelectionBar');
  if (!bar) return;
  const count = $('errorSelectedCount');
  if (count) count.textContent = errorSelected.size;
  bar.hidden = errorSelected.size === 0;
  const all = $('errorSelectAll');
  if (!all) return;
  const boxes = [...$('errorList').querySelectorAll('input[data-error-ids]')];
  const checked = boxes.filter(b => b.checked).length;
  all.checked = boxes.length > 0 && checked === boxes.length;
  all.indeterminate = checked > 0 && checked < boxes.length;
}

function errorGroupKey(e) {
  const norm = String(e.message || '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '#')
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ').trim().slice(0, 200);
  return e.level + '|' + norm;
}

function renderErrors() {
  if (!errorData) return;
  const q = ($('errorSearch').value || '').trim().toLowerCase();
  const project = $('errorProject').value;
  const entries = errorSorted.filter(e => {
    if (project && e.project !== project) return false;
    if (errorLevel === 'critical' && !e.critical) return false;
    if (errorLevel === 'error' && e.level !== 'ERROR') return false;
    if (errorLevel === 'warning' && e.level !== 'WARNING') return false;
    if (q && ![e.message, e.project, e.source, e.level].some(v => String(v || '').toLowerCase().includes(q))) return false;
    return true;
  });
  $('errorBack').hidden = !project;
  $('errorTitle').textContent = project || 'Error Logs';
  $('errorHeadProjects').hidden = !!project;
  $('errorHeadGroups').hidden = !project;
  const list = $('errorList');
  const empty = '<tr><td colspan="6" style="color:var(--mut)">No errors match the current filter.</td></tr>';

  if (!project) {
    // Overview: satu baris per project.
    const byProject = new Map();
    for (const e of entries) {
      let p = byProject.get(e.project);
      if (!p) byProject.set(e.project, p = { name: e.project, critical: 0, error: 0, warning: 0, total: 0, last: 0 });
      p.total++;
      if (e.critical) p.critical++;
      if (e.level === 'ERROR') p.error++;
      else if (e.level === 'WARNING') p.warning++;
      if (e.t > p.last) p.last = e.t;
    }
    const rows = [...byProject.values()].sort((a, b) => (b.critical - a.critical) || (b.total - a.total) || a.name.localeCompare(b.name));
    errorViewEntries = [];
    $('errorBadge').textContent = `${rows.length} projects · ${entries.length} entries`;
    list.innerHTML = rows.length ? rows.map(p => `<tr class="${p.critical ? 'err-row-crit' : ''}" data-error-project="${escHtml(p.name)}" style="cursor:pointer">
      <td><span class="err-project-pill">${escHtml(p.name)}</span></td>
      <td>${p.critical ? `<span class="pill down">${p.critical}</span>` : '<span style="color:var(--mut)">0</span>'}</td>
      <td>${p.error}</td>
      <td>${p.warning}</td>
      <td><strong>${p.total}</strong></td>
      <td style="color:var(--mut);white-space:nowrap">${p.last ? escHtml(new Date(p.last).toLocaleString([])) : '—'}</td>
    </tr>`).join('') : empty;
    syncErrorSelection();
    return;
  }

  // Detail project: error yang sama (angka/uuid diabaikan) digabung + dihitung.
  const map = new Map();
  for (const e of entries) {
    const k = errorGroupKey(e);
    let g = map.get(k);
    if (!g) map.set(k, g = { latest: e, count: 0, first: e.t, last: e.t, ids: [], sources: new Set() });
    g.count++;
    g.ids.push(e.id);
    g.sources.add(e.source);
    if (e.t >= g.last) { g.last = e.t; g.latest = e; }
    if (e.t < g.first) g.first = e.t;
  }
  const groups = [...map.values()].sort((a, b) => (b.latest.critical - a.latest.critical) || (b.count - a.count) || (b.last - a.last));
  errorViewEntries = groups;
  $('errorBadge').textContent = `${groups.length} groups · ${entries.length} entries`;
  if (!groups.length) { list.innerHTML = empty; syncErrorSelection(); return; }

  const shown = groups.slice(0, errorShowLimit);
  const more = groups.length > shown.length
    ? `<tr><td colspan="6" style="text-align:center"><button class="btn-sm" id="errorShowMore">Tampilkan lebih banyak (${shown.length} / ${groups.length})</button></td></tr>` : '';
  list.innerHTML = shown.map((g, i) => {
    const e = g.latest;
    const lvl = e.level === 'WARNING' ? 'warn' : e.critical ? 'down' : 'warn';
    const ids = g.ids.join(',');
    const checked = g.ids.every(id => errorSelected.has(id));
    return `<tr class="${e.critical ? 'err-row-crit' : ''}">
      <td><input type="checkbox" data-error-ids="${ids}" aria-label="Pilih grup error" ${checked ? 'checked' : ''} /></td>
      <td><span class="pill ${lvl}">${escHtml(e.level)}</span></td>
      <td><strong>×${g.count}</strong></td>
      <td style="color:var(--mut);white-space:nowrap">${escHtml(new Date(g.last).toLocaleString([]))}<div style="font-size:10px;font-family:var(--font-mono)">${escHtml([...g.sources].slice(0, 2).join(', '))}</div></td>
      <td class="err-msg-cell">${escHtml(e.message || '(empty)')}</td>
      <td style="text-align:right"><span class="err-row-actions">
        <button class="btn-sm" data-error-index="${i}">Detail</button>
        <button class="btn-sm" data-error-solve="${ids}" title="Tandai solved: kirim ke workspace lalu hapus dari log">✓ Solved</button>
        <button class="btn-sm danger" data-error-delete="${ids}" title="Hapus semua baris log di grup ini" aria-label="Hapus grup log ini">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
        </button>
      </span></td>
    </tr>`;
  }).join('') + more;
  syncErrorSelection();
}

async function deleteErrorRows(ids) {
  ids = [...new Set(ids.filter(Boolean))];
  if (!ids.length) return;
  const label = ids.length === 1 ? 'baris log ini' : `${ids.length} baris log terpilih`;
  if (!confirm(`Hapus ${label}?\n\nBaris akan dihapus permanen dari file log asli di server dan tidak bisa dikembalikan.`)) return;
  try {
    const d = await api('POST', '/api/logs/errors/delete', { ids });
    errorSelected.clear();
    await errors(true);
    if (d.failed && d.failed.length) {
      openModalText(
        `Hapus log: ${d.deleted || 0} terhapus, ${d.failed.length} gagal`,
        d.failed.map(f => `${f.source}: ${f.error}`).join('\n'),
        false
      );
    }
  } catch (e) {
    openModalText('Hapus log gagal', e.message || 'Request gagal', false);
  }
}

// Grup yang dipilih -> array of id[] (satu grup = satu record di workspace).
let solveGroups = [];
function openSolve(groups) {
  solveGroups = groups.filter(g => g.length);
  if (!solveGroups.length) return;
  $('solveModalTitle').textContent = solveGroups.length === 1 ? 'Tandai solved' : `Tandai ${solveGroups.length} grup solved`;
  $('solveText').value = '';
  $('solveErr').textContent = '';
  $('solveSubmit').disabled = false;
  $('solveModal').classList.add('open');
  $('solveText').focus();
}
function selectedGroups() {
  const out = [];
  for (const g of errorViewEntries) if (g.ids.every(id => errorSelected.has(id))) out.push(g.ids);
  return out;
}
$('solveModalClose').addEventListener('click', () => $('solveModal').classList.remove('open'));
$('solveSubmit').addEventListener('click', async () => {
  const solution = $('solveText').value.trim();
  if (!solution) { $('solveErr').textContent = 'Solusi wajib diisi'; return; }
  $('solveSubmit').disabled = true;
  $('solveErr').textContent = '';
  try {
    const d = await api('POST', '/api/logs/errors/resolve', { groups: solveGroups, solution });
    $('solveModal').classList.remove('open');
    errorSelected.clear();
    await errors(true);
    if (d.failed && d.failed.length) {
      openModalText(
        `Solved: ${d.sent || 0} terkirim, ${d.failed.length} gagal`,
        d.failed.map(f => `${f.source}: ${f.error}`).join('\n'),
        false
      );
    }
  } catch (e) {
    $('solveErr').textContent = e.message || 'Request gagal';
    $('solveSubmit').disabled = false;
  }
});
if ($('errorSolveSelected')) $('errorSolveSelected').addEventListener('click', () => openSolve(selectedGroups()));

let errorSig = '';
async function errors(force = false, quiet = false) {
  if (!isAdmin) return;
  if (!quiet && $('errorList')) $('errorList').innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--mut);padding:24px"><span class="spin"></span> Loading logs…</td></tr>';
  try {
    const hours = $('errorWindow') ? ($('errorWindow').value || '24') : '24';
    let qs = `hours=${encodeURIComponent(hours === 'custom' ? 0 : hours)}`;
    if (hours === 'custom') {
      const f = Date.parse($('errorFrom').value), t = Date.parse($('errorTo').value);
      if (f) qs += `&from=${f}`;
      if (t) qs += `&to=${t}`;
    }
    const d = await j(`/api/logs/errors?${qs}${force ? '&force=1' : ''}`);
    // Polling otomatis: kalau data sama, jangan render ulang (hindari kedip / reset scroll & seleksi).
    const sig = JSON.stringify((d.entries || []).map(e => e.id));
    if (quiet && errorData && sig === errorSig) return;
    errorSig = sig;
    errorData = d;
    const counts = errorProjectCounts();
    errorSorted = (d.entries || []).slice().sort((a, b) => ((counts.get(b.project) || 0) - (counts.get(a.project) || 0)) || (b.t - a.t));
    if (quiet) {
      const alive = new Set(errorSorted.map(e => e.id));
      for (const id of [...errorSelected]) if (!alive.has(id)) errorSelected.delete(id);
    } else errorSelected.clear();
    renderErrorProjects();
    renderErrors();
  } catch (e) {
    if (quiet && errorData) return;
    if ($('errorList')) $('errorList').innerHTML = `<tr><td colspan="6" style="color:var(--bad)">${escHtml(e.message || 'Failed loading logs')}</td></tr>`;
  }
}

function showErrorDetail(index) {
  const g = errorViewEntries[index];
  if (!g) return;
  const e = g.latest;
  const lines = [
    `Occurrences: ${g.count} (first ${new Date(g.first).toLocaleString([])}, last ${new Date(g.last).toLocaleString([])})`,
    `Project: ${e.project}`,
    `Source: ${e.source}`,
    `Level: ${e.level}${e.critical ? ' (critical)' : ''}`,
    `Time: ${e.t ? new Date(e.t).toLocaleString([]) : '—'}`,
    '',
    e.message || '(empty)',
    '',
    e.detail || '',
  ];
  openModalText(`${e.level} · ${e.project}`, lines.join('\n'), e.critical ? false : undefined);
}

let errorSearchTimer;
const rerenderErrors = () => { errorShowLimit = 100; renderErrors(); };
if ($('errorSearch')) $('errorSearch').addEventListener('input', () => { clearTimeout(errorSearchTimer); errorSearchTimer = setTimeout(rerenderErrors, 200); });
// Drill-down project masuk history, jadi tombol Back (touchpad/browser) kembali ke daftar project di halaman ini.
let pendingProject = new URLSearchParams(location.search).get('project') || '';
function setProject(name, push = true) {
  const sel = $('errorProject');
  pendingProject = name;
  sel.value = name;
  if (sel.value !== name) {
    const o = document.createElement('option');
    o.value = name; o.textContent = name;
    sel.appendChild(o);
    sel.value = name;
  }
  if (push && (new URLSearchParams(location.search).get('project') || '') !== name) {
    history.pushState({ project: name }, '', name ? '/errors?project=' + encodeURIComponent(name) : '/errors');
  }
  rerenderErrors();
}
window.addEventListener('popstate', () => setProject(new URLSearchParams(location.search).get('project') || '', false));
if ($('errorProject')) $('errorProject').addEventListener('change', () => setProject($('errorProject').value));
if ($('errorBack')) $('errorBack').addEventListener('click', () => setProject(''));
if ($('errorWindow')) $('errorWindow').addEventListener('change', () => {
  const custom = $('errorWindow').value === 'custom';
  $('errorFrom').hidden = $('errorTo').hidden = !custom;
  errors();
});
['errorFrom', 'errorTo'].forEach(id => { if ($(id)) $(id).addEventListener('change', () => errors()); });
if ($('errorRefresh')) $('errorRefresh').addEventListener('click', () => errors(true));
if ($('errorLevelTabs')) {
  $('errorLevelTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    document.querySelectorAll('#errorLevelTabs .tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    errorLevel = btn.dataset.level || 'all';
    rerenderErrors();
  });
}
if ($('errorList')) {
  $('errorList').addEventListener('click', (e) => {
    if (e.target.closest('#errorShowMore')) { errorShowLimit += 200; renderErrors(); return; }
    const solve = e.target.closest('[data-error-solve]');
    if (solve) { openSolve([solve.dataset.errorSolve.split(',')]); return; }
    const del = e.target.closest('[data-error-delete]');
    if (del) { deleteErrorRows(del.dataset.errorDelete.split(',')); return; }
    const row = e.target.closest('[data-error-project]');
    if (row) { setProject(row.dataset.errorProject); return; }
    const btn = e.target.closest('[data-error-index]');
    if (btn) showErrorDetail(parseInt(btn.dataset.errorIndex, 10));
  });
  $('errorList').addEventListener('change', (e) => {
    const box = e.target.closest('input[data-error-ids]');
    if (!box) return;
    for (const id of box.dataset.errorIds.split(',')) box.checked ? errorSelected.add(id) : errorSelected.delete(id);
    syncErrorSelection();
  });
}
if ($('errorSelectAll')) {
  $('errorSelectAll').addEventListener('change', (e) => {
    const check = e.target.checked;
    $('errorList').querySelectorAll('input[data-error-ids]').forEach(box => {
      box.checked = check;
      for (const id of box.dataset.errorIds.split(',')) check ? errorSelected.add(id) : errorSelected.delete(id);
    });
    syncErrorSelection();
  });
}
if ($('errorDeleteSelected')) $('errorDeleteSelected').addEventListener('click', () => deleteErrorRows([...errorSelected]));
if ($('errorClearSelection')) {
  $('errorClearSelection').addEventListener('click', () => {
    errorSelected.clear();
    renderErrors();
  });
}

setInterval(() => { if (isAdmin) errors(false, true); }, 15000);
