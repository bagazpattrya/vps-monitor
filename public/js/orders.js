const $ = id => document.getElementById(id);

let orders = [];
let projects = [];
let projectSig = '';
const ACTIVE = ['PENDING', 'IN_PROGRESS', 'APPROVED', 'MERGING'];
const REVIEWABLE = ['COMPLETED', 'NEEDS_REVIEW', 'MERGE_FAILED'];
const REVISABLE = [...REVIEWABLE, 'REJECTED', 'FAILED', 'OVER_BUDGET']; // sama dengan server
// Revisi = worker lanjut di branch WO yang sama; butuh branch yang masih ada (server tetap memeriksa ulang).
const canRevise = w => REVISABLE.includes(w.status) && !!(((w.result || {}).branch && (w.result || {}).head_sha) || w.revision)
  && !(w.cleanup && ['RUNNING', 'DONE'].includes(w.cleanup.state));
const DELETABLE = ['NEEDS_REVIEW', 'MERGED', 'REJECTED', 'FAILED', 'OVER_BUDGET']; // sama dengan server
const PRIORITIES = ['highest', 'high', 'medium', 'low', 'lowest']; // sama dengan server
const QUEUED = ['PENDING', 'APPROVED']; // prioritas boleh diubah
let links = {};
const selected = new Set();
let shown = []; // WO yang tampil sekarang (setelah filter)
let refreshTimer = null;

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Request gagal');
  return d;
}
// Semua nilai di halaman ini datang dari worker/AI: selalu di-escape.
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const fmtTime = iso => (iso ? new Date(iso).toLocaleString() : '—');
const fmtUsd = n => (n || n === 0 ? '$' + Number(n).toFixed(3) : '—');
const short = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

j_me();
function j_me() {
  fetch('/api/me').then(r => {
    if (r.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
    return r.json();
  }).then(m => {
    if (!m.admin) { location.href = '/'; return; }
    $('who').innerHTML = `<strong>${escHtml(m.user)}</strong>${m.role === 'superadmin' ? '<span class="role">superadmin</span>' : '<span class="role">admin</span>'}`;
    $('sideUserName').textContent = m.user;
    $('sideUserAvatar').textContent = String(m.user || '?').charAt(0);
    $('sideUserRole').textContent = m.role === 'superadmin' ? 'superadmin' : 'admin';
    $('sideUser').style.display = '';
    ['Backups', 'Sites', 'Deploy', 'Activity', 'Errors', 'Chat', 'Orders'].forEach(n => { if ($('navLink' + n)) $('navLink' + n).style.display = ''; });
    if (m.superadmin) ['Users', 'Files', 'Console'].forEach(n => { if ($('navLink' + n)) $('navLink' + n).style.display = ''; });
    $('pm2RestartBtn').style.display = '';
    load();
    refreshTimer = setInterval(() => { if (!document.hidden) load(); }, 5000);
  }).catch(() => {});
}

async function stats() {
  try {
    const s = await (await fetch('/api/stats')).json();
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

async function load() {
  try {
    const d = await api('GET', '/api/wo?limit=200');
    orders = d.work_orders || [];
    projects = d.projects || [];
    links = d.links || {};
    fillProjects();
    // isDev tiap folder, untuk label dev/produksi di rowActions. Cache server 30 detik.
    api('GET', '/api/git/projects').then(g => { gitList = g.projects || []; render(); }).catch(() => {});
    $('woBudget').textContent = `Biaya hari ini: ${fmtUsd(d.cost_today_usd)} dari batas harian $${d.daily_budget_usd}. Angka biaya dari total_cost_usd yang dilaporkan worker (notional jika memakai login subscription).`;
    render();
  } catch (e) {
    $('woList').innerHTML = `<tr><td colspan="8" style="color:var(--bad)">${escHtml(e.message)}</td></tr>`;
  }
}

function render() {
  const f = $('woFilter').value;
  const pf = $('woProjectFilter').value;
  const cf = $('woComplexFilter').value;
  const cx = w => (w.result && w.result.complexity) || 'none';
  const rows = orders.filter(w => (!pf || w.project_key === pf) && (!cf || cx(w) === cf) && (!f || (f === 'active' ? ACTIVE.includes(w.status) : f === 'APPROVED' ? ['APPROVED', 'MERGING'].includes(w.status) : w.status === f)));
  const active = orders.filter(w => ACTIVE.includes(w.status)).length;
  $('woBadge').textContent = `${orders.length} total · ${active} aktif`;
  shown = rows;
  [...selected].forEach(id => { const w = orders.find(x => x.id === id); if (!w || !DELETABLE.includes(w.status)) selected.delete(id); });
  syncSel();
  if (!rows.length) {
    $('woList').innerHTML = `<tr><td colspan="8" style="color:var(--mut)">${orders.length ? 'Tidak ada yang cocok dengan filter.' : 'Belum ada Work Order. Klik “+ Work Order”.'}</td></tr>`;
    return;
  }
  const row = w => `<tr data-id="${escHtml(w.id)}">
    <td>${DELETABLE.includes(w.status) ? `<input type="checkbox" class="wo-chk" data-id="${escHtml(w.id)}"${selected.has(w.id) ? ' checked' : ''}>` : ''}</td>
    <td><code>${escHtml(w.id)}</code></td>
    <td><span class="wo-st ${escHtml(w.status)}">${escHtml(w.status)}</span>${ACTIVE.includes(w.status) ? ` <span class="wo-pr ${escHtml(w.priority)}" title="Prioritas antrean">${escHtml(w.priority)}</span>` : ''}${cx(w) !== 'none' ? ` <span class="wo-cx ${cx(w)}">${cx(w)}</span>` : ''}</td>
    <td>${escHtml(w.project_key)}</td>
    <td class="wo-ctx" title="${escHtml(w.context)}">${escHtml(w.context)}</td>
    <td>${fmtUsd(w.cost_usd)}</td>
    <td>${escHtml(fmtTime(w.created_at))}</td>
    <td class="wo-acts">${rowActions(w)}</td>
  </tr>`;
  const g = $('woGroup').value;
  if (!g) { $('woList').innerHTML = rows.map(row).join(''); return; }
  const key = w => (g === 'project' ? w.project_key : w.status);
  const groups = new Map();
  rows.forEach(w => { if (!groups.has(key(w))) groups.set(key(w), []); groups.get(key(w)).push(w); });
  $('woList').innerHTML = [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([k, list]) =>
    `<tr class="wo-grp"><td colspan="8"><strong>${escHtml(k)}</strong> <span style="color:var(--mut)">· ${list.length}</span>${g === 'project' ? ` <button class="btn-sm" data-plink="${escHtml(k)}" style="margin-left:8px">Folder VPS</button>` : ''}</td></tr>` + list.map(row).join('')).join('');
}

function syncSel() {
  $('woDelSel').style.display = selected.size ? '' : 'none';
  $('woDelSel').textContent = `Hapus terpilih (${selected.size})`;
  const del = shown.filter(w => DELETABLE.includes(w.status));
  $('woCheckAll').checked = del.length > 0 && del.every(w => selected.has(w.id));
}

// Kolom aksi per baris. REVIEWABLE: Approve (pull dev / pull semua) + Reject. Setelah itu tampil status proses
// (menunggu worker -> merging -> git pull -> hasil), di-refresh oleh auto-refresh 5 detik.
const SCOPE_TXT = { dev: 'dev', all: 'dev + produksi' };
function rowActions(w) {
  const a = (act, cls, txt, tip) => `<button class="btn-sm ${cls} wo-act" data-act="${act}" data-id="${escHtml(w.id)}" title="${escHtml(tip)}">${txt}</button>`;
  const st = (txt, tip, color) => `<span class="wo-prog" style="font-size:12px;color:var(${color || '--mut'})" title="${escHtml(tip || '')}">${escHtml(txt)}</span>`;
  const rv = canRevise(w) ? a('revise', '', 'Revisi', 'Kirim balik ke worker dengan catatan, dikerjakan di branch yang sama') : '';
  if (REVIEWABLE.includes(w.status)) return ((w.result || {}).head_sha ? a('approve', 'ok', 'Approve', 'Merge ke branch target, lalu pilih folder dev/produksi yang di-pull') : '') + rv + a('reject', 'danger', 'Reject', 'Tolak WO');
  if (rv) return rv;
  let scope = SCOPE_TXT[w.pull_scope] || 'dev';
  if (w.pull_repos) { // pilihan per folder: label dev / produksi / dev + produksi sesuai folder yang dicentang
    const kinds = new Set(w.pull_repos.map(r => (gitList.find(x => x.relPath === r) || {}).isDev === false ? 'produksi' : 'dev'));
    scope = kinds.size ? [...kinds].sort().join(' + ') : 'tanpa pull';
  }
  if (w.status === 'APPROVED') return st('⏳ menunggu worker merge', 'pull: ' + scope);
  if (w.status === 'MERGING') return st('⏳ merging…', 'pull: ' + scope);
  if (w.status !== 'MERGED') return '';
  const ap = w.autopull;
  if (!ap) return st('✓ merged', linkRepos(w).length ? '' : 'Belum ada folder VPS ter-link: tidak ada pull', '--ok');
  if (ap.state === 'RUNNING') return st(`⏳ git pull (${scope})…`);
  if (ap.state === 'FAILED') return st('✕ pull gagal', ap.detail, '--bad');
  // Folder ter-link yang tidak ikut di-pull tapi sudah berisi commit merge WO (server: w.pulled_in) dihitung pulled.
  const g = r => gitList.find(x => x.relPath === r) || {};
  const same = (w.pulled_in || []).filter(r => !(ap.results || []).some(x => x.repo === r && x.ok));
  const res = [...(ap.results || []).filter(r => !same.includes(r.repo)), ...same.map(repo => ({ repo, ok: true, same: true }))];
  const ok = res.filter(r => r.ok).length;
  if (!w.pull_repos && res.some(r => r.ok && g(r.repo).isDev === false)) scope = SCOPE_TXT.all;
  const tip = res.map(r => `${r.ok ? '✓' : '✕'} ${r.repo}${r.same ? ' (commit sudah ada)' : r.ok ? '' : ': ' + r.detail}`).join('\n');
  if (!res.length) return st('✓ merged · tanpa folder ' + scope, '', '--ok');
  return st(`${ok === res.length ? '✓' : '⚠'} pulled ${ok}/${res.length} (${scope})`, tip, ok === res.length ? '--ok' : '--warn-tx');
}
async function rowAct(btn) {
  const w = orders.find(x => x.id === btn.dataset.id), act = btn.dataset.act;
  if (!w) return;
  if (act === 'approve') return approveDialog(w, load);
  if (act === 'revise') return openRevise(w);
  if (!confirm(`Reject ${w.id}?`)) return;
  btn.disabled = true;
  try {
    await api('POST', `/api/wo/${encodeURIComponent(w.id)}/reject`, {});
    await load();
  } catch (e) { alert(e.message); }
  btn.disabled = false;
}

$('woList').addEventListener('click', e => {
  const ab = e.target.closest('.wo-act');
  if (ab) { rowAct(ab); return; }
  const pl = e.target.closest('[data-plink]');
  if (pl) { projLink(pl.dataset.plink); return; }
  const chk = e.target.closest('.wo-chk');
  if (chk) { chk.checked ? selected.add(chk.dataset.id) : selected.delete(chk.dataset.id); syncSel(); return; }
  const tr = e.target.closest('tr[data-id]');
  if (tr) openDetail(tr.dataset.id);
});
$('woFilter').addEventListener('change', render);
$('woProjectFilter').addEventListener('change', () => { try { localStorage.setItem('woProjectFilter', $('woProjectFilter').value); } catch { /* abaikan */ } $('woProjLink').style.display = $('woProjectFilter').value ? '' : 'none'; render(); });
// Atur folder per project tanpa harus menunggu ada WO MERGED.
function projLink(key) {
  const w = { project_key: key };
  if (!w.project_key) return;
  $('woDetailTitle').textContent = 'Folder VPS · ' + w.project_key;
  $('woDetailBody').innerHTML = '<div id="woDeploy"><div id="woDeployOut"></div></div>';
  $('woDetailModal').classList.add('open');
  linkForm(w);
}
$('woProjLink').addEventListener('click', () => projLink($('woProjectFilter').value));
$('woComplexFilter').addEventListener('change', render);
$('woRefresh').addEventListener('click', load);
try { $('woGroup').value = localStorage.getItem('woGroup') || ''; } catch { /* storage diblokir */ }
$('woGroup').addEventListener('change', () => { try { localStorage.setItem('woGroup', $('woGroup').value); } catch { /* abaikan */ } render(); });
$('woSelDone').addEventListener('click', () => { shown.filter(w => DELETABLE.includes(w.status)).forEach(w => selected.add(w.id)); render(); });
$('woCheckAll').addEventListener('change', e => {
  shown.filter(w => DELETABLE.includes(w.status)).forEach(w => (e.target.checked ? selected.add(w.id) : selected.delete(w.id)));
  render();
});
// Hapus butuh dua klik; hanya id yang dipilih (dan tampil) yang dikirim.
let delArmed = null;
$('woDelSel').addEventListener('click', async () => {
  const btn = $('woDelSel');
  if (!delArmed) {
    btn.textContent = `Yakin hapus ${selected.size}? Klik lagi`;
    delArmed = setTimeout(() => { delArmed = null; syncSel(); }, 6000);
    return;
  }
  clearTimeout(delArmed); delArmed = null;
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/wo/delete', { ids: [...selected] });
    r.deleted.forEach(id => selected.delete(id));
    if (r.skipped.length) alert('Dilewati:\n' + r.skipped.map(x => `${x.id}: ${x.reason}`).join('\n'));
    await load();
  } catch (e) { alert('Hapus gagal: ' + e.message); } finally { btn.disabled = false; syncSel(); }
});

function kv(rows) {
  return '<dl class="wo-kv">' + rows.filter(r => r[1] !== null && r[1] !== undefined && r[1] !== '').map(r => `<dt>${escHtml(r[0])}</dt><dd>${r[2] ? r[1] : escHtml(r[1])}</dd>`).join('') + '</dl>';
}

function openDetail(id) {
  const w = orders.find(x => x.id === id);
  if (!w) return;
  const r = w.result || {};
  const t = r.tokens || {};
  $('woDetailTitle').textContent = w.id;
  let h = kv([
    ['Status', `<span class="wo-st ${escHtml(w.status)}">${escHtml(w.status)}</span>`, true],
    ['Project', w.project_key],
    ['Prioritas', QUEUED.includes(w.status)
      ? `<select id="woPrioEdit" class="input">${PRIORITIES.map(p => `<option value="${p}"${p === w.priority ? ' selected' : ''}>${p}</option>`).join('')}</select> <span id="woPrioErr" style="color:var(--bad)"></span>`
      : escHtml(w.priority), true],
    ['Kompleksitas', r.complexity ? `${r.complexity}${r.complexity_reason ? ' — ' + r.complexity_reason : ''}` : ''],
    ['Dibuat', fmtTime(w.created_at) + (w.created_by ? ' · ' + w.created_by : '')],
    ['Selesai', w.completed_at ? fmtTime(w.completed_at) : ''],
    ['Percobaan', w.attempts],
    ['Model / batas', `${(w.limits || {}).model} · $${(w.limits || {}).max_budget_usd} · ${(w.limits || {}).timeout_sec}s`],
    ['Branch', r.branch],
    ['Biaya', r.cost_usd != null ? fmtUsd(r.cost_usd) : ''],
    ['Token', t.input != null ? `in ${t.input} · out ${t.output} · cache read ${t.cache_read} · cache write ${t.cache_creation}` : ''],
    ['Turn', r.turns],
    ['Verifikasi', r.verify_passed === true ? 'lulus' : r.verify_passed === false ? 'gagal' : ''],
    ['Commit', r.head_sha ? r.head_sha.slice(0, 10) : ''],
    [w.status === 'REJECTED' ? 'Ditolak oleh' : 'Disetujui oleh', w.approved_by ? `${w.approved_by} · ${fmtTime(w.approved_at)}` : ''],
    ['Branch lokal', w.cleanup ? ({ PENDING: 'menunggu worker menghapus', RUNNING: 'sedang dihapus worker…', DONE: 'dihapus', SKIPPED: 'dilewati', FAILED: 'gagal dihapus' }[w.cleanup.state] || w.cleanup.state) + (w.cleanup.detail ? ' — ' + w.cleanup.detail : '') : ''],
    ['Merge', w.merge ? `${w.merge.status}${w.merge.target ? ' → ' + w.merge.target : ''}${w.merge.sha ? ' @ ' + w.merge.sha.slice(0, 10) : ''}` : ''],
  ]);
  if (w.merge && w.merge.detail) h += `<div class="wo-pre">${escHtml(w.merge.detail)}</div>`;
  if (w.autopull) {
    const ap = w.autopull, res = ap.results || [];
    h += `<div class="wo-lbl">Pull otomatis (${escHtml(SCOPE_TXT[w.pull_scope] || 'dev')})</div><div class="wo-pre">${escHtml(ap.state === 'RUNNING' ? '⏳ sedang pull…'
      : ap.state === 'FAILED' ? '✕ ' + (ap.detail || 'gagal')
      : res.length ? res.map(r => `${r.ok ? '✓' : '✕'} ${r.repo}: ${r.detail}`).join('\n\n') : 'Tidak ada folder yang cocok ter-link.')}</div>`;
  }
  if (w.status === 'MERGED') h += '<div class="wo-lbl">Deploy</div><div id="woDeploy"></div>';
  h += `<div class="wo-lbl">Context</div><div class="wo-pre">${escHtml(w.context)}</div>`;
  if ((w.goals || []).length) h += `<div class="wo-lbl">Goals</div><div class="wo-pre">${escHtml(w.goals.map((g, i) => `${i + 1}. ${g}`).join('\n'))}</div>`;
  if ((w.files_hint || []).length) h += `<div class="wo-lbl">File untuk dimulai</div><div class="wo-pre">${escHtml(w.files_hint.join('\n'))}</div>`;
  if ((w.images || []).length) h += `<div class="wo-lbl">Lampiran</div><div class="chat-thumbs">${w.images.map(n => { const u = `/api/wo/${encodeURIComponent(w.id)}/img/${encodeURIComponent(n)}`; return `<a href="${escHtml(u)}" class="thumb zoom"><img src="${escHtml(u)}" alt="lampiran"></a>`; }).join('')}</div>`;
  if ((w.revisions || []).length) h += `<div class="wo-lbl">Riwayat revisi</div><div class="wo-pre">${escHtml(w.revisions.map((x, i) => `#${i + 1} · ${x.by || ''} · ${fmtTime(x.at)} (dari ${x.from_status})\n${x.note}`
    + ((x.goals || []).length ? `\nGoals: ${x.goals.join('; ')}` : '') + ((x.files_hint || []).length ? `\nFile: ${x.files_hint.join(', ')}` : '')
    + ((x.images || []).length ? `\n${x.images.length} gambar (lihat Lampiran)` : '')).join('\n\n'))}</div>`;
  if (r.patch) h += `<div class="wo-lbl">Patch${r.patch_truncated ? ' (dipotong 200 KB)' : ''}</div><div class="wo-pre wo-patch">${renderPatch(r.patch)}</div>`;
  if (r.diff_stat) h += `<div class="wo-lbl">Diff</div><div class="wo-pre">${escHtml(r.diff_stat)}</div>`;
  if (r.logs) h += `<div class="wo-lbl">Log / jawaban agent</div><div class="wo-pre">${escHtml(r.logs)}</div>`;
  if (w.screenshot_url) h += `<div class="wo-lbl">Screenshot</div><a href="${escHtml(w.screenshot_url)}" class="zoom"><img class="wo-shot" src="${escHtml(w.screenshot_url)}" alt="screenshot"></a>`;
  if (REVIEWABLE.includes(w.status)) {
    h += r.head_sha
      ? `<div class="wo-actions"><button class="btn-sm ok" id="woApprove">Approve</button>${canRevise(w) ? '<button class="btn-sm" id="woRevise">Revisi</button>' : ''}<button class="btn-sm danger" id="woReject">Reject</button><span id="woActErr"></span></div>
         <p style="color:var(--mut);font-size:12px">Approve membuat worker di laptop me-merge <code>${escHtml(r.branch || '')}</code> ke branch target yang diatur di <code>projects.json</code> laptop, lalu push. Setelah MERGED, VPS otomatis <code>git pull</code> folder yang ter-link: pilih folder dev/produksi yang di-pull saat Approve. Folder dengan perubahan lokal dilewati. ${w.status === 'NEEDS_REVIEW' ? '<strong>Status NEEDS_REVIEW: ada masalah, baca log dulu.</strong>' : ''}</p>`
      : `<div class="wo-actions">${canRevise(w) ? '<button class="btn-sm" id="woRevise">Revisi</button>' : ''}<button class="btn-sm danger" id="woReject">Reject</button><span id="woActErr"></span></div>
         <p style="color:var(--mut);font-size:12px">Tidak ada commit untuk di-merge: agent tidak mengubah file (baca log di atas), atau WO lama. ${canRevise(w) ? 'Kirim <em>Revisi</em> dengan instruksi yang jelas, atau ' : 'Buat WO baru dengan instruksi yang jelas, atau '}<em>Reject</em>.</p>`;
  }
  else if (canRevise(w)) h += `<div class="wo-actions"><button class="btn-sm" id="woRevise">Revisi</button><span id="woActErr"></span></div>
    <p style="color:var(--mut);font-size:12px">Revisi mengirim WO kembali ke worker dengan catatanmu. Worker melanjutkan branch <code>${escHtml(r.branch || (w.revision || {}).branch || '')}</code> (commit baru di atasnya), lalu hasilnya direview ulang.</p>`;
  $('woDetailBody').innerHTML = h;
  if (w.status === 'MERGED') deployBox(w);
  $('woDetailModal').classList.add('open');
  bindActions(w);
  const pe = $('woPrioEdit');
  if (pe) pe.addEventListener('change', async () => {
    pe.disabled = true; $('woPrioErr').textContent = '';
    try { await api('POST', `/api/wo/${encodeURIComponent(w.id)}/priority`, { priority: pe.value }); await load(); openDetail(w.id); }
    catch (e) { $('woPrioErr').textContent = e.message; pe.disabled = false; }
  });
}
// gambar lampiran/screenshot: popup, bukan pindah halaman
$('woDetailBody').addEventListener('click', e => {
  const a = e.target.closest('a.zoom');
  if (!a) return;
  e.preventDefault();
  $('woImgBig').src = a.getAttribute('href');
  $('woImgModal').classList.add('open');
});
$('woImgModal').addEventListener('click', () => $('woImgModal').classList.remove('open'));
$('woDetailClose').addEventListener('click', () => $('woDetailModal').classList.remove('open'));

// ---- buat WO baru ----
// ---- lampiran gambar (pola sama dengan chat.js) ----
const MAX_IMAGES = 4, MAX_BYTES = 5 * 1024 * 1024;
let pending = [];
function renderThumbs() {
  const box = $('woThumbs');
  box.textContent = '';
  pending.forEach((p, i) => {
    const w = document.createElement('div');
    w.className = 'thumb';
    const im = document.createElement('img');
    im.src = p.dataUrl;
    im.style.cursor = 'pointer'; im.title = 'Klik untuk menggambar';
    im.onclick = () => annotate(p.dataUrl, url => { pending[i].dataUrl = url; renderThumbs(); });
    const x = document.createElement('button');
    x.type = 'button'; x.textContent = '✕'; x.title = 'Hapus';
    x.onclick = () => { pending.splice(i, 1); renderThumbs(); };
    w.append(im, x);
    box.appendChild(w);
  });
}
// Editor coretan: gambar di atas gambar lampiran, hasil dikembalikan sebagai dataURL.
function annotate(src, onSave) {
  const COLORS = ['#ef4444', '#facc15', '#22c55e', '#3b82f6', '#ffffff', '#000000'];
  const ov = document.createElement('div');
  ov.className = 'anno-ov';
  const bar = document.createElement('div');
  bar.className = 'anno-bar';
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  let color = COLORS[0], strokes = [], cur = null, base = null;
  const dots = COLORS.map(c => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'anno-dot'; b.style.background = c;
    b.onclick = () => { color = c; dots.forEach(d => d.classList.toggle('on', d === b)); };
    return b;
  });
  dots[0].classList.add('on');
  const size = document.createElement('input');
  size.type = 'range'; size.min = 1; size.max = 40; size.value = 6;
  const mk = (t, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn-sm ' + (cls || ''); b.textContent = t; b.onclick = fn; return b; };
  const close = () => ov.remove();
  const sp = document.createElement('span'); sp.style.flex = '1';
  bar.append(...dots, size,
    mk('↶ Undo', '', () => { strokes.pop(); redraw(); }),
    mk('Hapus coretan', '', () => { strokes = []; redraw(); }),
    sp,
    mk('Batal', '', close),
    mk('✓ Simpan', 'ok', () => {
      let u = cv.toDataURL('image/png');
      if (u.length > MAX_BYTES * 1.3) u = cv.toDataURL('image/jpeg', 0.9);
      close(); onSave(u);
    }));
  function stroke(st) {
    ctx.strokeStyle = ctx.fillStyle = st.c; ctx.lineWidth = st.w; ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    st.p.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (st.p.length === 1) { ctx.arc(st.p[0][0], st.p[0][1], st.w / 2, 0, 7); ctx.fill(); } else ctx.stroke();
  }
  function redraw() { ctx.drawImage(base, 0, 0); strokes.forEach(stroke); }
  const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.width / r.width]; };
  cv.onpointerdown = e => { cv.setPointerCapture(e.pointerId); cur = { c: color, w: size.value * cv.width / cv.getBoundingClientRect().width, p: [pos(e)] }; strokes.push(cur); redraw(); };
  cv.onpointermove = e => { if (cur) { cur.p.push(pos(e)); redraw(); } };
  cv.onpointerup = cv.onpointercancel = () => { cur = null; };
  ov.append(bar, cv);
  document.body.appendChild(ov);
  base = new Image();
  base.onload = () => { cv.width = base.naturalWidth; cv.height = base.naturalHeight; redraw(); };
  base.src = src;
}
function addFiles(files) {
  const err = m => { $('woNewErr').textContent = m; };
  for (const f of files) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) { err('File tidak didukung: ' + f.name + ' (PNG, JPEG, WebP, GIF)'); continue; }
    if (f.size > MAX_BYTES) { err(f.name + ' lebih dari 5 MB'); continue; }
    if (pending.length >= MAX_IMAGES) { err('Maks ' + MAX_IMAGES + ' gambar'); break; }
    const r = new FileReader();
    r.onload = () => { if (pending.length < MAX_IMAGES) { pending.push({ dataUrl: r.result }); renderThumbs(); } };
    r.readAsDataURL(f);
  }
}
$('woAttach').onclick = () => $('woFile').click();
$('woFile').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
const woModal = $('woNewModal');
woModal.addEventListener('paste', e => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
woModal.addEventListener('dragover', e => e.preventDefault());
woModal.addEventListener('drop', e => { e.preventDefault(); addFiles(e.dataTransfer.files); });

const lines = s => s.split('\n').map(x => x.trim()).filter(Boolean);

// Drawer yang sama dipakai untuk WO baru dan untuk revisi (revising = WO yang direvisi).
// Draf WO baru disimpan saat drawer dipakai revisi, lalu dikembalikan, supaya ketikan tidak hilang.
let revising = null, draft = null;
const FORM_IDS = ['woContext', 'woGoals', 'woFiles', 'woPriority', 'woModel', 'woBudgetUsd', 'woTimeout'];
function setMode(w) {
  revising = w;
  $('woNewTitle').textContent = w ? 'Revisi ' + w.id : 'Work Order baru';
  $('woNewIntro').innerHTML = w
    ? `Worker melanjutkan branch <code>${escHtml((w.result || {}).branch || (w.revision || {}).branch || '')}</code> (commit baru di atasnya) dengan catatan ini, lalu hasilnya direview ulang.`
    : 'Dikerjakan oleh worker di laptop pada branch git baru. Satu WO = satu tujuan sempit.';
  $('woProjBox').style.display = w ? 'none' : '';
  $('woContextLbl').textContent = w ? 'Apa yang harus diperbaiki' : 'Context';
  $('woGoals').placeholder = w ? 'Tambahan goals untuk revisi ini (opsional)' : 'Bottom nav tidak tertutup footer\nTanpa horizontal overflow';
  $('woNewSubmit').textContent = w ? 'Kirim revisi' : 'Kirim ke antrean';
  $('woNewErr').textContent = '';
}
function openRevise(w) {
  if (!revising) draft = { pending, vals: FORM_IDS.map(i => $(i).value) };
  setMode(w);
  ['woContext', 'woGoals', 'woFiles'].forEach(i => { $(i).value = ''; });
  const l = w.limits || {};
  $('woPriority').value = w.priority || 'medium'; $('woModel').value = l.model || 'sonnet';
  $('woBudgetUsd').value = l.max_budget_usd || 0.5; $('woTimeout').value = l.timeout_sec || 600;
  pending = []; renderThumbs();
  $('woDetailModal').classList.remove('open');
  $('woNewModal').classList.add('open'); $('woContext').focus();
}
function closeNew() {
  $('woNewModal').classList.remove('open');
  if (!revising) return;
  setMode(null);
  if (draft) { pending = draft.pending; FORM_IDS.forEach((i, k) => { $(i).value = draft.vals[k]; }); draft = null; }
  else { ['woContext', 'woGoals', 'woFiles'].forEach(i => { $(i).value = ''; }); pending = []; }
  renderThumbs();
}
const openNew = () => { if (revising) closeNew(); $('woNewErr').textContent = ''; $('woNewModal').classList.add('open'); $('woProjectSearch').focus(); };
$('woNew').addEventListener('click', openNew);
// Tab (tanpa fokus di elemen apa pun, tidak ada panel terbuka) = buka drawer WO baru
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
  if (document.activeElement && document.activeElement !== document.body) return;
  if (document.querySelector('.modal-backdrop.open, .sidebar.open')) return;
  e.preventDefault(); openNew();
});
$('woNewClose').addEventListener('click', closeNew);

$('woNewSubmit').addEventListener('click', async () => {
  const btn = $('woNewSubmit');
  if (revising) return submitRevise(btn);
  if (!$('woProject').value) { $('woNewErr').textContent = 'Pilih project dulu'; return; }
  const body = {
    project_key: $('woProject').value,
    context: $('woContext').value.trim(),
    priority: $('woPriority').value,
    limits: { model: $('woModel').value, max_budget_usd: Number($('woBudgetUsd').value), timeout_sec: Number($('woTimeout').value) },
  };
  const goals = lines($('woGoals').value);
  if (goals.length) body.goals = goals;
  const files = lines($('woFiles').value);
  if (files.length) body.files_hint = files;
  if ($('woDbSrcBox').style.display !== 'none' && $('woDb').value) body.db_source = $('woDb').value;
  if ($('woDbBox').style.display !== 'none') body.db_sync = $('woDbSync').checked;
  if (pending.length) body.images = pending.map(p => p.dataUrl);
  btn.disabled = true; $('woNewErr').textContent = '';
  try {
    await api('POST', '/api/wo', body);
    $('woNewModal').classList.remove('open');
    ['woContext', 'woGoals', 'woFiles'].forEach(i => { $(i).value = ''; });
    pending = []; renderThumbs();
    await load();
  } catch (e) {
    $('woNewErr').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { ['woImgModal', 'woDetailModal'].forEach(i => $(i).classList.remove('open')); if ($('woNewModal').classList.contains('open')) closeNew(); }
});

// Patch: tiap baris di-escape lalu diberi kelas warna (nilai berasal dari AI, jangan pernah tanpa escape).
function renderPatch(patch) {
  return String(patch).split('\n').map(l => {
    const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? 'pf'
      : l.startsWith('@@') ? 'ph' : l.startsWith('+') ? 'pa' : l.startsWith('-') ? 'pd' : '';
    return `<span class="${cls}">${escHtml(l)}</span>`;
  }).join('\n');
}

// Popup Approve: pilih folder ter-link (dev/produksi) yang di-pull setelah MERGED. Popup ini sekaligus konfirmasi.
let approving = null; // { w, done }
function approveDialog(w, done) {
  approving = { w, done };
  $('woApproveTitle').textContent = 'Approve ' + w.id;
  // Daftar folder ter-link, dikelompokkan DEV / PRODUKSI; default semua folder yang ditemukan dicentang.
  // Tiap grup punya tombol Select all (toggle centang semua / kosongkan).
  const rs = linkRepos(w).map(r => ({ repo: r.repo, g: gitList.find(x => x.relPath === r.repo) }));
  const grp = (title, list) => !list.length ? '' : `<div class="wo-pull-grp"><div style="margin:8px 0 2px;font-size:12px;color:var(--mut);display:flex;align-items:center;gap:8px">${title}${list.some(x => x.g) ? ' <button type="button" class="btn-sm wo-pull-all" style="padding:0 6px;font-size:11px">Select all</button>' : ''}</div>` + list.map(({ repo, g }) =>
    `<label style="display:block;margin:4px 0"><input type="checkbox" class="wo-pull-chk" value="${escHtml(repo)}"${g ? ' checked' : ''}> <code>${escHtml(repo)}</code>${g ? ` <span style="color:var(--mut);font-size:12px">${escHtml(g.branch || '')}${g.dirty ? ' · ⚠ perubahan lokal' : ''}</span>` : ' <span style="color:var(--bad);font-size:12px">folder tidak ditemukan</span>'}</label>`).join('') + '</div>';
  $('woPullRepos').innerHTML = rs.length
    ? grp('DEV', rs.filter(r => r.g && r.g.isDev)) + grp('PRODUKSI', rs.filter(r => r.g && !r.g.isDev)) + grp('LAINNYA', rs.filter(r => !r.g))
    : '<p style="color:var(--mut)">Belum ada folder VPS ter-link ke project ini: tidak ada pull. Atur lewat tombol "Folder VPS".</p>';
  $('woApproveErr').textContent = ''; $('woApproveGo').disabled = false;
  $('woApproveModal').classList.add('open');
}
const closeApprove = () => { approving = null; $('woApproveModal').classList.remove('open'); };
$('woApproveClose').addEventListener('click', closeApprove);
$('woApproveCancel').addEventListener('click', closeApprove);
// Select all per grup: jika semua sudah dicentang -> kosongkan, selain itu centang semua.
$('woPullRepos').addEventListener('click', e => {
  const b = e.target.closest('.wo-pull-all'); if (!b) return;
  const chks = [...b.closest('.wo-pull-grp').querySelectorAll('.wo-pull-chk')];
  const all = chks.every(c => c.checked);
  chks.forEach(c => { c.checked = !all; });
});
$('woApproveGo').addEventListener('click', async () => {
  if (!approving) return;
  const { w, done } = approving, repos = [...document.querySelectorAll('.wo-pull-chk:checked')].map(c => c.value);
  $('woApproveGo').disabled = true;
  try {
    await api('POST', `/api/wo/${encodeURIComponent(w.id)}/approve`, { repos });
    closeApprove();
    await done();
  } catch (e) { $('woApproveErr').textContent = e.message; $('woApproveGo').disabled = false; }
});

async function submitRevise(btn) {
  const w = revising, note = $('woContext').value.trim();
  if (!note) { $('woNewErr').textContent = 'Tulis apa yang harus diperbaiki'; return; }
  const body = { note, priority: $('woPriority').value,
    limits: { model: $('woModel').value, max_budget_usd: Number($('woBudgetUsd').value), timeout_sec: Number($('woTimeout').value) } };
  const goals = lines($('woGoals').value), files = lines($('woFiles').value);
  if (goals.length) body.goals = goals;
  if (files.length) body.files_hint = files;
  if (pending.length) body.images = pending.map(p => p.dataUrl);
  btn.disabled = true; $('woNewErr').textContent = '';
  try {
    await api('POST', `/api/wo/${encodeURIComponent(w.id)}/revise`, body);
    pending = [];
    closeNew();
    await load();
  } catch (e) { $('woNewErr').textContent = e.message; }
  finally { btn.disabled = false; }
}

function bindActions(w) {
  const rv = $('woRevise');
  if (rv) rv.addEventListener('click', () => openRevise(w));
  const rj = $('woReject');
  if (!rj) return;
  if ($('woApprove')) $('woApprove').addEventListener('click', () => approveDialog(w, async () => { await load(); openDetail(w.id); }));
  rj.addEventListener('click', async () => {
    rj.disabled = true; $('woActErr').textContent = '';
    try {
      await api('POST', `/api/wo/${encodeURIComponent(w.id)}/reject`, {});
      await load();
      openDetail(w.id);
    } catch (e) { $('woActErr').textContent = e.message; rj.disabled = false; }
  });
}

// Dropdown project (form WO dan filter) diisi dari daftar worker + project yang sudah punya WO.
// Hanya dibangun ulang jika isinya berubah, supaya pilihan user tidak ter-reset oleh auto-refresh 5 detik.
function fillProjects() {
  const count = {};
  orders.forEach(w => { count[w.project_key] = (count[w.project_key] || 0) + 1; });
  const keys = [...new Set([...projects.map(p => p.key), ...Object.keys(count)])].sort();
  const sig = JSON.stringify([keys, count, projects]);
  if (sig === projectSig) return;
  // Build pertama: pulihkan pilihan project terakhir dari localStorage.
  let keepF = $('woProjectFilter').value;
  if (!projectSig) try { keepF = localStorage.getItem('woProjectFilter') || ''; } catch { /* storage diblokir */ }
  projectSig = sig;

  const pf = $('woProjectFilter');
  pf.innerHTML = '<option value="">Semua project</option>' + keys.map(k => `<option value="${escHtml(k)}">${escHtml(k)} (${count[k] || 0})</option>`).join('');
  pf.value = keys.includes(keepF) ? keepF : '';
  $('woProjLink').style.display = pf.value ? '' : 'none';

  // Form WO: kosong → pakai project WO terakhir.
  const sel = $('woProject');
  let keep = sel.value;
  if (!keep) try { keep = localStorage.getItem('woProject') || ''; } catch { /* storage diblokir */ }
  if (!projects.length) {
    sel.innerHTML = '<option value="">Belum ada project terdaftar — jalankan worker di laptop</option>';
    sel.disabled = true; $('woNewSubmit').disabled = true;
  } else {
    sel.disabled = false; $('woNewSubmit').disabled = false;
    sel.innerHTML = '<option value="">— pilih project —</option>' + projects.map(p => `<option value="${escHtml(p.key)}">${escHtml(p.key)}</option>`).join('');
    sel.value = projects.some(p => p.key === keep) ? keep : '';
    filterProjects();
  }
  projectNote(); dbPicker();
}
function projectNote() {
  const p = projects.find(x => x.key === $('woProject').value);
  $('woProjectNote').textContent = !p ? '' : p.target ? `Setelah Approve, hasilnya di-merge ke branch “${p.target}” di laptop.` : 'Project ini belum diaktifkan untuk merge: hasil hanya berupa branch wo/… di laptop.';
}
function dbPicker() {
  const p = projects.find(x => x.key === $('woProject').value), src = (p && p.db_sources) || [];
  $('woDbBox').style.display = src.length || (p && p.db_sync_info) ? '' : 'none';
  $('woDbSrcBox').style.display = src.length ? '' : 'none';
  $('woDb').innerHTML = src.map(d => `<option value="${escHtml(d)}">${escHtml(d)}${d === p.db_default ? ' (default)' : ''}</option>`).join('');
  if (src.length) $('woDb').value = p.db_default || src[0];
  dbLast();
}
// Info backup DB lokal worker per sumber; default centang jika belum pernah / lebih tua dari TTL worker.
function dbLast() {
  const p = projects.find(x => x.key === $('woProject').value), info = p && p.db_sync_info;
  if (!info) { $('woDbLast').textContent = 'Worker belum melaporkan waktu backup terakhir (update worker laptop).'; $('woDbSync').checked = true; return; }
  const at = info.last[(p.db_sources || []).length ? $('woDb').value : ''];
  $('woDbSync').checked = !at || Date.now() - at > info.ttl_hours * 3600e3;
  $('woDbLast').textContent = at ? `Backup DB lokal terakhir: ${new Date(at).toLocaleString()}` : 'Belum pernah di-backup ke lokal.';
}
// Cari project: saring opsi select; pilih otomatis match pertama bila pilihan sekarang tersaring.
function filterProjects() {
  const q = $('woProjectSearch').value.trim().toLowerCase(), sel = $('woProject');
  let first = null;
  for (const o of sel.options) {
    if (!o.value) { o.hidden = !!q; continue; }
    const hit = !q || o.value.toLowerCase().includes(q);
    o.hidden = !hit;
    if (hit && !first) first = o;
  }
  const cur = sel.selectedOptions[0];
  if (q && first && (!cur || cur.hidden) && sel.value !== first.value) { sel.value = first.value; sel.dispatchEvent(new Event('change')); }
}
$('woProjectSearch').addEventListener('input', filterProjects);
$('woProjectSearch').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('woContext').focus(); } });
$('woProject').addEventListener('change', () => { try { localStorage.setItem('woProject', $('woProject').value); } catch { /* abaikan */ } projectNote(); dbPicker(); });
$('woDb').addEventListener('change', dbLast);

// Deploy WO MERGED. Satu project bisa terhubung ke banyak folder VPS (satu repo GitHub di-clone ke banyak folder).
// Folder yang di-pull dipilih manual tiap kali (default kosong): deploy ke produksi harus disengaja.
// Link (folder + URL) per project disimpan di server lewat /api/wo/links.
let gitList = [];
const remoteLabel = r => String(r || '(tanpa remote)').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/\s]+@/i, '$1').replace(/^git@/, '').replace(/^https?:\/\//, '').replace(/\.git$/, '');
const linkRepos = w => ((links[w.project_key] || {}).repos || []);

async function deployBox(w) {
  const box = $('woDeploy');
  const rs = linkRepos(w);
  let info = {};
  if (!rs.length) {
    box.innerHTML = '<div class="wo-actions"><button class="btn-sm" id="woLinkBtn">Atur folder VPS &amp; website</button></div><div id="woDeployOut"></div>';
    $('woLinkBtn').onclick = () => linkForm(w);
    return;
  }
  box.innerHTML = `<div class="wo-actions"><button class="btn-sm ok" id="woDeployBtn" disabled>Deploy terpilih (0)</button><button class="btn-sm" id="woPickAll">Pilih semua</button><button class="btn-sm" id="woPickNone">Kosongkan</button><button class="btn-sm" id="woLinkBtn">Atur folder</button></div>
    <div class="wo-deploy-list">${rs.map((r, i) => {
      return `<div class="wo-deploy-row" data-i="${i}"><label><input type="checkbox" class="dep-chk" data-i="${i}"> <code>${escHtml(r.repo)}</code></label>
        <span class="dep-meta">memuat info git…</span>
        ${r.url ? `<a href="${escHtml(r.url)}" target="_blank" rel="noopener">Buka website ↗</a>` : ''}<span class="dep-res"></span></div>`;
    }).join('')}</div><div id="woDeployOut"></div>`;
  // info git (lambat: status semua repo) dimuat belakangan supaya daftar langsung tampil
  const infoReady = api('GET', '/api/git/projects').then(d => {
    info = Object.fromEntries((d.projects || []).map(g => [g.relPath, g]));
  }).catch(() => { /* info commit tidak wajib */ }).then(() => {
    rs.forEach((r, i) => {
      const g = info[r.repo], el = box.querySelector(`.wo-deploy-row[data-i="${i}"] .dep-meta`);
      if (el) el.innerHTML = g ? `${escHtml(g.branch || '')} @ ${escHtml(g.hash || '')}${g.dirty ? ' <strong style="color:var(--warn-tx)" title="Ada perubahan lokal yang belum di-commit">⚠ perubahan lokal</strong>' : ''}` : '<span style="color:var(--bad)">folder tidak ditemukan</span>';
    });
  });
  const chks = () => [...box.querySelectorAll('.dep-chk')];
  const sync = () => { const n = chks().filter(c => c.checked).length; $('woDeployBtn').disabled = !n; $('woDeployBtn').textContent = `Deploy terpilih (${n})`; };
  box.addEventListener('change', e => { if (e.target.classList.contains('dep-chk')) sync(); });
  $('woPickAll').onclick = () => { chks().forEach(c => { c.checked = true; }); sync(); };
  $('woPickNone').onclick = () => { chks().forEach(c => { c.checked = false; }); sync(); };
  $('woLinkBtn').onclick = () => linkForm(w);
  $('woDeployBtn').onclick = async () => {
    const picked = chks().filter(c => c.checked).map(c => Number(c.dataset.i));
    await infoReady; // cek perubahan lokal butuh info git
    const dirty = picked.filter(i => (info[rs[i].repo] || {}).dirty).map(i => rs[i].repo);
    if (dirty.length && !confirm('Folder ini punya perubahan lokal yang belum di-commit:\n' + dirty.join('\n') + '\n\nTetap deploy?')) return;
    $('woDeployBtn').disabled = true;
    let ok = 0;
    const done = [];
    for (const i of picked) { // berurutan: satu gagal tidak menghentikan yang lain
      const res = box.querySelector(`.wo-deploy-row[data-i="${i}"] .dep-res`);
      res.textContent = '⏳ pulling…';
      try {
        const r = await api('POST', '/api/git/pull', { relPath: rs[i].repo });
        res.innerHTML = '<span style="color:var(--ok)">✓ ok</span>'; ok++;
        done.push({ repo: rs[i].repo, ok: true, detail: r.output || 'ok' });
        res.title = r.output || '';
        $('woDeployOut').innerHTML += `<div class="wo-lbl">${escHtml(rs[i].repo)}</div><div class="wo-pre">${escHtml(r.output || 'Selesai')}</div>`;
      } catch (e) {
        res.innerHTML = '<span style="color:var(--bad)">✕ gagal</span>';
        done.push({ repo: rs[i].repo, ok: false, detail: e.message });
        $('woDeployOut').innerHTML += `<div class="wo-lbl">${escHtml(rs[i].repo)}</div><div class="wo-pre" style="color:var(--bad)">${escHtml(e.message)}</div>`;
      }
    }
    $('woDeployBtn').textContent = `Selesai: ${ok}/${picked.length} berhasil`;
    try { await api('POST', `/api/wo/${encodeURIComponent(w.id)}/pulled`, { results: done }); load(); } catch (e) { /* status daftar saja, deploy tetap jalan */ }
    $('woDeployBtn').disabled = false;
  };
}

// Form pilih folder VPS (dikelompokkan per remote) + URL website tiap folder.
async function linkForm(w) {
  let list = gitList;
  try { list = gitList = (await api('GET', '/api/git/projects')).projects || []; } catch (e) { /* pakai cache */ }
  const cur = Object.fromEntries(linkRepos(w).map(r => [r.repo, r.url || '']));
  const groups = new Map();
  list.forEach(g => { const k = remoteLabel(g.remote); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(g); });
  // Link lama yang foldernya sudah tidak ada tetap tampil supaya tidak hilang diam-diam.
  Object.keys(cur).filter(r => !list.some(g => g.relPath === r)).forEach(r => { if (!groups.has('(folder tidak ditemukan)')) groups.set('(folder tidak ditemukan)', []); groups.get('(folder tidak ditemukan)').push({ relPath: r }); });
  const sorted = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  $('woDeployOut').innerHTML = `<div class="wo-lbl">Folder VPS untuk project ${escHtml(w.project_key)}</div>
    <input id="lkFilter" class="input" placeholder="Cari folder / remote…" style="width:100%;margin-bottom:6px">
    <div id="lkList" style="max-height:260px;overflow:auto">${sorted.map(([k, gs]) => `<div class="lk-grp" data-k="${escHtml(k.toLowerCase())}"><label><input type="checkbox" class="lk-all"> <strong>${escHtml(k)}</strong> <span style="color:var(--mut)">· ${gs.length} folder</span></label>
      ${gs.map(g => `<div class="lk-row" data-f="${escHtml(g.relPath.toLowerCase())}" style="display:flex;gap:6px;align-items:center;margin:3px 0 3px 22px"><label style="min-width:180px"><input type="checkbox" class="lk-chk" data-r="${escHtml(g.relPath)}"${g.relPath in cur ? ' checked' : ''}> <code>${escHtml(g.relPath)}</code></label><input class="input lk-url" placeholder="https://website (opsional)" value="${escHtml(cur[g.relPath] || '')}" style="flex:1"></div>`).join('')}</div>`).join('')}</div>
    <div class="wo-actions"><button class="btn-sm ok" id="lkSave">Simpan</button><button class="btn-sm" id="lkCancel">Batal</button><span id="lkErr" style="color:var(--bad)"></span></div>`;
  const L = $('lkList');
  $('lkFilter').oninput = e => {
    const q = e.target.value.trim().toLowerCase();
    L.querySelectorAll('.lk-grp').forEach(g => {
      const gm = g.dataset.k.includes(q); let any = false;
      g.querySelectorAll('.lk-row').forEach(r => { const m = !q || gm || r.dataset.f.includes(q); r.style.display = m ? 'flex' : 'none'; any = any || m; });
      g.style.display = any ? '' : 'none';
    });
  };
  L.addEventListener('change', e => {
    if (e.target.classList.contains('lk-all')) e.target.closest('.lk-grp').querySelectorAll('.lk-row').forEach(r => { if (r.style.display !== 'none') r.querySelector('.lk-chk').checked = e.target.checked; });
  });
  $('lkCancel').onclick = () => deployBox(w);
  $('lkSave').onclick = async () => {
    const repos = [...L.querySelectorAll('.lk-row')].filter(r => r.querySelector('.lk-chk').checked).map(r => ({ repo: r.querySelector('.lk-chk').dataset.r, url: r.querySelector('.lk-url').value.trim() }));
    try { links = (await api('POST', '/api/wo/links', { project_key: w.project_key, repos })).links || {}; deployBox(w); }
    catch (e) { $('lkErr').textContent = e.message; }
  };
}
