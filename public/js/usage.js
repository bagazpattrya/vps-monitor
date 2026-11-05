const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const k = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n));
const usd = n => '$' + n.toFixed(2);
const LABELS = { five_hour: 'Session (5 jam)', seven_day: 'Mingguan (7 hari)', seven_day_opus: 'Mingguan Opus', seven_day_sonnet: 'Mingguan Sonnet' };

async function j(u) {
  const r = await fetch(u);
  if (r.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  if (!r.ok) throw new Error('fetch error');
  return r.json();
}

j('/api/me').then(m => {
  if (!m.admin) { location.href = '/'; return; }
  $('who').innerHTML = `<strong>${esc(m.user)}</strong>${m.role === 'superadmin' ? '<span class="role">superadmin</span>' : '<span class="role">admin</span>'}`;
  $('sideUserName').textContent = m.user;
  $('sideUserAvatar').textContent = String(m.user || '?').charAt(0);
  $('sideUserRole').textContent = m.role === 'superadmin' ? 'superadmin' : 'admin';
  $('sideUser').style.display = '';
  ['Users', 'Files'].forEach(n => { if (m.superadmin && $('navLink' + n)) $('navLink' + n).style.display = ''; });
  ['Backups', 'Sites', 'Deploy', 'Activity', 'Errors', 'Chat', 'Usage'].forEach(n => { if ($('navLink' + n)) $('navLink' + n).style.display = ''; });
  $('pm2RestartBtn').style.display = '';
  if (!m.superadmin) $('userCard').style.display = 'none';
}).catch(() => {});
$('logout').onclick = $('sideLogout').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/login'; };

async function stats() {
  try {
    const s = await j('/api/stats');
    $('host').innerHTML = `<strong>${esc(s.hostname)}</strong>`;
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
$('pm2RestartBtn').onclick = async () => {
  if (!confirm('Restart aplikasi VPS Monitor via pm2? Dashboard akan terputus beberapa detik.')) return;
  try { await fetch('/api/pm2/restart', { method: 'POST' }); setTimeout(() => location.reload(), 4000); } catch (e) { alert('Restart gagal'); }
};

function until(sec) {
  const d = sec * 1000 - Date.now();
  if (d <= 0) return 'sudah reset';
  const h = Math.floor(d / 3.6e6), m = Math.floor(d % 3.6e6 / 6e4);
  return h >= 24 ? `reset ${Math.floor(h / 24)}h ${h % 24}j lagi` : `reset ${h}j ${m}m lagi`;
}

function renderLimits(l) {
  const box = $('limits');
  if (!l) { box.innerHTML = '<span style="color:var(--mut)">Belum ada data. Kirim satu chat dulu.</span>'; $('limAge').textContent = '—'; return; }
  const mins = Math.round((Date.now() - l.t) / 6e4);
  $('limAge').textContent = 'diperbarui ' + (mins < 1 ? 'baru saja' : mins < 60 ? mins + ' mnt lalu' : Math.round(mins / 60) + ' jam lalu');
  box.innerHTML = Object.entries(l.windows).map(([key, w]) => {
    const pct = Math.min(100, Math.round((w.utilization || 0) * 100));
    const col = pct >= 90 ? 'var(--bad)' : pct >= 70 ? 'var(--warn)' : 'var(--ok)';
    return `<div class="usage-lim"><div style="color:var(--mut);font-size:12px">${esc(LABELS[key] || key)}</div><div class="usage-pct">${pct}%</div><div class="bar"><i style="width:${pct}%;background:${col}"></i></div><div style="color:var(--mut);font-size:12px">${w.resetsAt ? until(w.resetsAt) : ''}${w.status && w.status !== 'allowed' ? ' · ' + esc(w.status) : ''}</div></div>`;
  }).join('');
}

// Inline SVG bar chart. series: [{key,color}] stacked; days: [{day,...values}]
function chart(el, days, series, fmt) {
  const W = 900, H = 220, L = 44, B = 22, T = 8, iw = W - L - 8, ih = H - B - T;
  const tot = d => series.reduce((a, s) => a + (d[s.key] || 0), 0);
  const max = Math.max(...days.map(tot), 1e-9);
  const bw = iw / days.length;
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const y = T + ih - ih * i / 4;
    g += `<line x1="${L}" x2="${W - 8}" y1="${y}" y2="${y}" stroke="var(--border)"/><text x="${L - 6}" y="${y + 3}" text-anchor="end">${fmt(max * i / 4)}</text>`;
  }
  days.forEach((d, i) => {
    let y = T + ih;
    const x = L + i * bw + bw * 0.15, w = bw * 0.7;
    let tip = `${d.day}: ` + series.map(s => `${s.key} ${fmt(d[s.key] || 0)}`).join(', ');
    for (const s of series) {
      const h = ih * (d[s.key] || 0) / max;
      y -= h;
      if (h > 0) g += `<rect class="b" x="${x}" y="${y}" width="${w}" height="${h}" fill="${s.color}"><title>${esc(tip)}</title></rect>`;
    }
    if (days.length <= 31 ? i % Math.ceil(days.length / 10) === 0 : i % 10 === 0) g += `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${d.day.slice(5)}</text>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
}

const rows = o => Object.entries(o).sort((a, b) => b[1].cost - a[1].cost).map(([n, a]) => `<tr><td>${esc(n)}</td><td>${a.runs}</td><td>${usd(a.cost)}</td><td>${k(a.input)}</td><td>${k(a.output)}</td><td>${k(a.cacheRead)}</td></tr>`).join('') || '<tr><td colspan="6" style="color:var(--mut)">Belum ada data</td></tr>';

async function load() {
  const u = await j('/api/chat/usage?days=' + $('range').value);
  renderLimits(u.limits);
  const days = [];
  for (let i = u.days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 864e5).toLocaleDateString('sv');
    days.push({ day, ...(u.daily[day] || {}) });
  }
  $('costTotal').textContent = usd(u.total.cost) + ' · ' + u.total.runs + ' runs';
  $('tokTotal').textContent = 'in ' + k(u.total.input) + ' · out ' + k(u.total.output);
  chart($('chartCost'), days, [{ key: 'cost', color: 'var(--ac)' }], usd);
  chart($('chartTok'), days, [{ key: 'input', color: 'var(--ac)' }, { key: 'output', color: 'var(--ok)' }, { key: 'cacheRead', color: 'var(--warn)' }], k);
  $('byModel').innerHTML = rows(u.byModel);
  $('byUser').innerHTML = rows(u.byUser);
}
$('range').onchange = load;
load();
setInterval(load, 60_000);
