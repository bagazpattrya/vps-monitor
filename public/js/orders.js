const $ = id => document.getElementById(id);

let orders = [];
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
    if (!m.superadmin) { location.href = '/'; return; }
    $('who').innerHTML = `<strong>${escHtml(m.user)}</strong><span class="role">superadmin</span>`;
    $('sideUserName').textContent = m.user;
    $('sideUserAvatar').textContent = String(m.user || '?').charAt(0);
    $('sideUserRole').textContent = 'superadmin';
    $('sideUser').style.display = '';
    ['Users', 'Files', 'Console', 'Orders', 'Backups', 'Sites', 'Deploy', 'Activity', 'Errors', 'Chat'].forEach(n => { if ($('navLink' + n)) $('navLink' + n).style.display = ''; });
    $('pm2RestartBtn').style.display = '';
    load();
    refreshTimer = setInterval(() => { if (!document.hidden) load(); }, 5000);
  }).catch(() => {});
}

$('logout').onclick = $('sideLogout').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
};

async function load() {
  try {
    const d = await api('GET', '/api/wo?limit=200');
    orders = d.work_orders || [];
    $('woBudget').textContent = `Biaya hari ini: ${fmtUsd(d.cost_today_usd)} dari batas harian $${d.daily_budget_usd}. Angka biaya dari total_cost_usd yang dilaporkan worker (notional jika memakai login subscription).`;
    render();
  } catch (e) {
    $('woList').innerHTML = `<tr><td colspan="6" style="color:var(--bad)">${escHtml(e.message)}</td></tr>`;
  }
}

function render() {
  const f = $('woFilter').value;
  const rows = orders.filter(w => !f || (f === 'active' ? ['PENDING', 'IN_PROGRESS'].includes(w.status) : w.status === f));
  const active = orders.filter(w => ['PENDING', 'IN_PROGRESS'].includes(w.status)).length;
  $('woBadge').textContent = `${orders.length} total · ${active} aktif`;
  if (!rows.length) {
    $('woList').innerHTML = `<tr><td colspan="6" style="color:var(--mut)">${orders.length ? 'Tidak ada yang cocok dengan filter.' : 'Belum ada Work Order. Klik “+ Work Order”.'}</td></tr>`;
    return;
  }
  $('woList').innerHTML = rows.map(w => `<tr data-id="${escHtml(w.id)}">
    <td><code>${escHtml(w.id)}</code></td>
    <td><span class="wo-st ${escHtml(w.status)}">${escHtml(w.status)}</span></td>
    <td>${escHtml(w.project_key)}</td>
    <td>${escHtml(short(w.context, 110))}</td>
    <td>${fmtUsd(w.cost_usd)}</td>
    <td>${escHtml(fmtTime(w.created_at))}</td>
  </tr>`).join('');
}

$('woList').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openDetail(tr.dataset.id);
});
$('woFilter').addEventListener('change', render);
$('woRefresh').addEventListener('click', load);

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
    ['Dibuat', fmtTime(w.created_at)],
    ['Selesai', w.completed_at ? fmtTime(w.completed_at) : ''],
    ['Percobaan', w.attempts],
    ['Model / batas', `${(w.limits || {}).model} · $${(w.limits || {}).max_budget_usd} · ${(w.limits || {}).timeout_sec}s`],
    ['Branch', r.branch],
    ['Biaya', r.cost_usd != null ? fmtUsd(r.cost_usd) : ''],
    ['Token', t.input != null ? `in ${t.input} · out ${t.output} · cache read ${t.cache_read} · cache write ${t.cache_creation}` : ''],
    ['Turn', r.turns],
    ['Verifikasi', r.verify_passed === true ? 'lulus' : r.verify_passed === false ? 'gagal' : ''],
  ]);
  h += `<div class="wo-lbl">Context</div><div class="wo-pre">${escHtml(w.context)}</div>`;
  h += `<div class="wo-lbl">Goals</div><div class="wo-pre">${escHtml((w.goals || []).map((g, i) => `${i + 1}. ${g}`).join('\n'))}</div>`;
  if ((w.files_hint || []).length) h += `<div class="wo-lbl">File untuk dimulai</div><div class="wo-pre">${escHtml(w.files_hint.join('\n'))}</div>`;
  if (r.diff_stat) h += `<div class="wo-lbl">Diff</div><div class="wo-pre">${escHtml(r.diff_stat)}</div>`;
  if (r.logs) h += `<div class="wo-lbl">Log / jawaban agent</div><div class="wo-pre">${escHtml(r.logs)}</div>`;
  if (w.screenshot_url) h += `<div class="wo-lbl">Screenshot</div><a href="${escHtml(w.screenshot_url)}" target="_blank" rel="noopener"><img class="wo-shot" src="${escHtml(w.screenshot_url)}" alt="screenshot"></a>`;
  if (w.status === 'COMPLETED' || w.status === 'NEEDS_REVIEW') h += `<p style="color:var(--mut);font-size:12px">Review di laptop: <code>git diff main...${escHtml(r.branch || '')}</code>. Merge dilakukan manual.</p>`;
  $('woDetailBody').innerHTML = h;
  $('woDetailModal').classList.add('open');
}
$('woDetailClose').addEventListener('click', () => $('woDetailModal').classList.remove('open'));

// ---- buat WO baru ----
const lines = s => s.split('\n').map(x => x.trim()).filter(Boolean);

$('woNew').addEventListener('click', () => { $('woNewErr').textContent = ''; $('woNewModal').classList.add('open'); $('woProject').focus(); });
$('woNewClose').addEventListener('click', () => $('woNewModal').classList.remove('open'));

$('woNewSubmit').addEventListener('click', async () => {
  const btn = $('woNewSubmit');
  const body = {
    project_key: $('woProject').value.trim(),
    context: $('woContext').value.trim(),
    goals: lines($('woGoals').value),
    limits: { model: $('woModel').value, max_budget_usd: Number($('woBudgetUsd').value), timeout_sec: Number($('woTimeout').value) },
  };
  const files = lines($('woFiles').value);
  if (files.length) body.files_hint = files;
  const url = $('woUrl').value.trim();
  if (url) body.verification = { target_url: url };
  btn.disabled = true; $('woNewErr').textContent = '';
  try {
    await api('POST', '/api/wo', body);
    $('woNewModal').classList.remove('open');
    ['woProject', 'woContext', 'woGoals', 'woFiles', 'woUrl'].forEach(i => { $(i).value = ''; });
    await load();
  } catch (e) {
    $('woNewErr').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') ['woNewModal', 'woDetailModal'].forEach(i => $(i).classList.remove('open'));
});
