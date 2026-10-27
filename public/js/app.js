
const $ = id => document.getElementById(id);

const fmtBytes = (b) => {
  if (!b || b <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(i > 2 ? 1 : 0) + ' ' + u[i];
};

const barColor = (pct) => {
  if (pct >= 90) return 'var(--bad)';
  if (pct >= 75) return 'var(--warn)';
  return 'var(--ac)';
};

const setBar = (el, pct) => {
  el.style.width = Math.min(100, Math.max(0, pct)) + '%';
  el.style.backgroundColor = barColor(pct);
};

const fmtCpu = (m) => (m || '')
  .replace(/\s*with\s+Radeon.*$/i, '')
  .replace(/\s*\d+-Core\s+Processor.*$/i, '')
  .replace(/\s*Processor.*$/i, '')
  .replace(/\(R\)|\(TM\)|CPU/gi, '')
  .replace(/@\s*[\d.]+\s*GHz/gi, '')
  .replace(/\s+/g, ' ')
  .trim();

let chart;
let histLimit = 720;
let prevNet = null;
let rawProcs = [];
let procSort = 'cpu';
let rawSpikes = [];
let procMeta = { intervalMs: 5000, cores: 0, spikeThreshold: 70, sampledAt: 0 };
let errorData = null;
let errorViewEntries = [];
let errorLevel = 'all';
const errorSelected = new Set();

async function j(u) {
  const r = await fetch(u);
  if (r.status === 401) {
    location.href = '/login';
    throw new Error('unauthorized');
  }
  if (!r.ok) throw new Error('fetch error');
  return r.json();
}

let isAdmin = false;
let isSuper = false;
j('/api/me').then(m => {
  isAdmin = !!m.admin;
  isSuper = !!m.superadmin;
  $('who').innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.7"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><strong>${m.user}</strong>${m.role === 'superadmin' ? '<span class="role">superadmin</span>' : m.admin ? '<span class="role">admin</span>' : ''}`;
  $('sideUserName').textContent = m.user;
  $('sideUserAvatar').textContent = String(m.user || '?').charAt(0);
  $('sideUserRole').textContent = m.role === 'superadmin' ? 'superadmin' : m.admin ? 'admin' : 'viewer';
  $('sideUser').style.display = '';
  if (m.admin) {
    if ($('navLinkUsers') && m.superadmin) $('navLinkUsers').style.display = '';
    if ($('navLinkFiles') && m.superadmin) $('navLinkFiles').style.display = '';
    if ($('navLinkBackups')) $('navLinkBackups').style.display = '';
    if ($('navLinkSites')) $('navLinkSites').style.display = '';
    if ($('navLinkDeploy')) $('navLinkDeploy').style.display = '';
    if ($('navLinkActivity')) $('navLinkActivity').style.display = '';
    if ($('navLinkErrors')) $('navLinkErrors').style.display = '';
    if ($('procSpikeCard')) $('procSpikeCard').style.display = '';
    if ($('mysqlQueryCard')) $('mysqlQueryCard').style.display = '';
    $('pm2RestartBtn').style.display = '';
  }
  if (!m.admin && ['users', 'files', 'backups', 'deploy', 'activity', 'sites', 'errors'].includes(currentView())) location.hash = '#/overview';
  if (!m.superadmin && ['users', 'files'].includes(currentView())) location.hash = '#/overview';
  if (m.admin && currentView() === 'errors') errors();
  if (m.admin && currentView() === 'processes') { procs(); mysqlQueries(); }
  document.body.classList.toggle('no-pull', !m.admin);
}).catch(() => {});

function trackActivity(action, target, details) {
  try {
    fetch('/api/activity/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, target: String(target || ''), details: String(details || '') }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

// Klik penting: tombol/tab/aksi (bukan nav sidebar = sudah dilacak sebagai view).
let lastClickTrack = { key: '', t: 0 };
document.addEventListener('click', (e) => {
  const el = e.target.closest('button, .tab, .nav-action, [data-depjob], [data-pull], [data-gitpull], [data-cat], [data-sort], [data-limit], [data-filter]');
  if (!el || el.closest('.sidebar-close') || el.id === 'vpsMonitorBtn') return;
  if (['logout', 'sideLogout', 'sidebarClose', 'sidebarOverlay'].includes(el.id)) return;
  const label = (el.dataset.track || el.id || el.dataset.sort || el.dataset.limit || el.dataset.filter || el.dataset.cat || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!label) return;
  const now = Date.now();
  if (label === lastClickTrack.key && now - lastClickTrack.t < 600) return;
  lastClickTrack = { key: label, t: now };
  trackActivity('click', label, el.tagName.toLowerCase());
}, true);

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Request gagal');
  return d;
}

// ---- Backup Monitoring ----
let rawBackups = [];
let backupFilterCat = 'all';

function fmtBackupAge(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Baru saja';
  if (mins < 60) return `${mins} menit yang lalu`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} jam yang lalu`;
  const days = Math.floor(hrs / 24);
  return `${days} hari yang lalu`;
}

async function backups() {
  if (!isAdmin) return;
  try {
    const d = await j('/api/backups');
    rawBackups = d.files || [];
    $('backupTotalFiles').textContent = d.totalFiles || 0;
    $('backupTotalSize').textContent = `${fmtBytes(d.totalBytes || 0)} total`;
    $('backupRootPath').textContent = d.root || 'Tidak tersedia';
    $('backupCountDaily').textContent = (d.categories || {}).daily || 0;
    $('backupCountWeekly').textContent = (d.categories || {}).weekly || 0;
    $('backupCountMonthly').textContent = (d.categories || {}).monthly || 0;

    if (d.latestTime) {
      $('backupLatestAge').textContent = fmtBackupAge(d.latestTime);
      $('backupLatestExact').textContent = new Date(d.latestTime).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      const ageMs = Date.now() - d.latestTime;
      if (ageMs <= 86400000 * 1.5) {
        $('backupStatusPill').textContent = 'HEALTHY';
        $('backupStatusPill').className = 'pill ok';
        $('backupLatestBadge').textContent = 'Fresh (≤36 jam)';
      } else {
        $('backupStatusPill').textContent = 'STALE';
        $('backupStatusPill').className = 'pill warn';
        $('backupLatestBadge').textContent = 'Terlambat (>36 jam)';
      }
    } else {
      $('backupLatestAge').textContent = '—';
      $('backupLatestExact').textContent = 'Belum ada backup';
      $('backupStatusPill').textContent = 'EMPTY';
      $('backupStatusPill').className = 'pill down';
      $('backupLatestBadge').textContent = '—';
    }

    $('backupRunBtn').style.display = d.canRun ? '' : 'none';
    const logBox = $('backupLogBox');
    if (d.logTail) {
      logBox.textContent = d.logTail;
    } else {
      logBox.textContent = 'Log backup.log tidak tersedia.';
    }

    renderBackups();
  } catch {
    $('backupList').innerHTML = '<tr><td colspan="6" style="color:var(--bad);text-align:center;padding:18px">Gagal memuat data backup</td></tr>';
  }
}

function renderBackups() {
  const q = ($('backupSearch').value || '').trim().toLowerCase();
  const list = rawBackups.filter(b => {
    if (backupFilterCat !== 'all' && b.category !== backupFilterCat) return false;
    if (!q) return true;
    return b.name.toLowerCase().includes(q) || b.dbName.toLowerCase().includes(q);
  });

  $('backupFilteredCount').textContent = `${list.length} file`;
  if (!list.length) {
    $('backupList').innerHTML = `<tr><td colspan="6" style="color:var(--mut);text-align:center;padding:18px">${rawBackups.length ? 'Tidak ada backup yang cocok dengan filter' : 'Belum ada file backup yang terdeteksi'}</td></tr>`;
    return;
  }

  const catColor = (c) => c === 'daily' ? 'ok' : (c === 'weekly' ? 'warn' : (c === 'monthly' ? 'down' : ''));
  $('backupList').innerHTML = list.map(b => {
    const fullDate = b.mtime ? new Date(b.mtime).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    const stale = b.mtime && (Date.now() - b.mtime > 86400000 * 3) ? ' <span class="pill down">stale</span>' : '';
    return `
      <tr>
        <td><strong>${escHtml(b.dbName)}</strong>${stale}</td>
        <td><code style="font-size:11.5px">${escHtml(b.name)}</code></td>
        <td><span class="pill ${catColor(b.category)}">${escHtml(b.category.toUpperCase())}</span></td>
        <td style="color:var(--mut);font-family:var(--font-mono)">${fmtBytes(b.size)}</td>
        <td style="color:var(--mut)">${fullDate}</td>
        <td style="text-align:right;white-space:nowrap">
          <a href="/api/backups/download?file=${encodeURIComponent(b.relPath)}" class="btn-sm ok" style="text-decoration:none" download>⬇ Download</a>
          <button class="btn-sm danger" data-del-backup="${escHtml(b.relPath)}" style="margin-left:6px">Hapus</button>
        </td>
      </tr>
    `;
  }).join('');
}

// ---- Mini File Explorer ----
let fsCurrentPath = '';
let fsParentPath = null;
let rawFsEntries = [];
let fsCurrentPreviewPath = '';

let fsSelected = new Set();

function fsArchiveUrl(dir, names) {
  return `/api/fs/archive?dir=${encodeURIComponent(dir)}` + names.map(n => `&name=${encodeURIComponent(n)}`).join('');
}

function updateFsSelUI() {
  const n = fsSelected.size;
  $('fsBtnDownloadSel').style.display = n ? '' : 'none';
  $('fsBtnDownloadSel').textContent = `⬇ Download terpilih (${n}) .tar.gz`;
  const all = $('fsSelAll');
  const visible = document.querySelectorAll('#fsList .fs-sel');
  all.checked = visible.length > 0 && [...visible].every(c => c.checked);
}

async function loadFs(dirPath) {
  if (!isAdmin) return;
  fsSelected = new Set();
  try {
    const url = dirPath ? `/api/fs/list?path=${encodeURIComponent(dirPath)}` : '/api/fs/list';
    const d = await j(url);
    fsCurrentPath = d.current;
    fsParentPath = d.parent;
    rawFsEntries = d.entries || [];
    renderFsBreadcrumbs(d.current);
    renderFsBookmarks(d.bookmarks || []);
    renderFsList();
    $('fsBtnUp').disabled = !fsParentPath;
  } catch (err) {
    $('fsList').innerHTML = `<tr><td colspan="7" style="color:var(--bad);text-align:center;padding:18px">${escHtml(err.message || 'Gagal membuka direktori')}</td></tr>`;
  }
}

function renderFsBreadcrumbs(fullPath) {
  const parts = fullPath.split('/').filter(Boolean);
  let html = `<a href="javascript:void(0)" class="fs-crumb" data-path="/" style="color:var(--ac);text-decoration:none">/</a>`;
  let accum = '';
  for (let i = 0; i < parts.length; i++) {
    accum += '/' + parts[i];
    const isLast = i === parts.length - 1;
    html += ` <span style="opacity:0.4">/</span> `;
    if (isLast) {
      html += `<strong style="color:var(--tx)">${escHtml(parts[i])}</strong>`;
    } else {
      html += `<a href="javascript:void(0)" class="fs-crumb" data-path="${escHtml(accum)}" style="color:var(--ac);text-decoration:none">${escHtml(parts[i])}</a>`;
    }
  }
  $('fsBreadcrumbs').innerHTML = html;
}

function renderFsBookmarks(bookmarks) {
  $('fsBookmarks').innerHTML = bookmarks.map(b => `
    <button class="btn-sm fs-bmark" data-path="${escHtml(b.path)}" title="${escHtml(b.path)}">${escHtml(b.name)}</button>
  `).join('');
}

function renderFsList() {
  const q = ($('fsFilterInput').value || '').trim().toLowerCase();
  const list = rawFsEntries.filter(e => !q || e.name.toLowerCase().includes(q));
  $('fsEntriesCount').textContent = `${list.length} item${list.length === 1 ? '' : 's'}`;

  if (!list.length) {
    $('fsList').innerHTML = `<tr><td colspan="7" style="color:var(--mut);text-align:center;padding:18px">${rawFsEntries.length ? 'Tidak ada file yang cocok dengan filter' : 'Direktori kosong'}</td></tr>`;
    return;
  }

  $('fsList').innerHTML = list.map(item => {
    const full = (fsCurrentPath === '/' ? '' : fsCurrentPath) + '/' + item.name;
    const icon = item.isDir ? '📁' : (['.sh','.bash','.py','.php','.js','.ts'].includes(item.ext) ? '📜' : (['.zip','.tar','.gz','.tgz'].includes(item.ext) ? '🗜️' : '📄'));
    const sizeStr = item.isDir ? '—' : fmtBytes(item.size);
    const mtimeStr = item.mtime ? new Date(item.mtime).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    const clickAttr = item.isDir ? `class="fs-open-dir" data-path="${escHtml(full)}" style="cursor:pointer;color:var(--ac);font-weight:600"` : `class="fs-preview-file" data-path="${escHtml(full)}" style="cursor:pointer;color:var(--tx)"`;

    return `
      <tr>
        <td style="width:28px;text-align:center"><input type="checkbox" class="fs-sel" data-name="${escHtml(item.name)}"${fsSelected.has(item.name) ? ' checked' : ''}></td>
        <td style="font-size:15px;text-align:center">${icon}</td>
        <td>
          <span ${clickAttr}>${escHtml(item.name)}</span>
        </td>
        <td style="color:var(--mut);font-family:var(--font-mono)">${sizeStr}</td>
        <td><code>${escHtml(item.mode)}</code></td>
        <td style="color:var(--mut)">${mtimeStr}</td>
        <td style="text-align:right;white-space:nowrap">
          ${item.isDir
            ? `<button class="btn-sm fs-open-dir" data-path="${escHtml(full)}">Buka</button>
               <a href="${fsArchiveUrl(fsCurrentPath, [item.name])}" class="btn-sm ok" style="text-decoration:none;display:inline-block;margin-left:4px" title="Download folder (.tar.gz)" download>⬇</a>`
            : `<button class="btn-sm fs-preview-file" data-path="${escHtml(full)}">Lihat</button>
               <a href="/api/fs/download?path=${encodeURIComponent(full)}" class="btn-sm ok" style="text-decoration:none;display:inline-block;margin-left:4px" download>⬇</a>`
          }
        </td>
      </tr>
    `;
  }).join('');
}

async function previewFsFile(filePath) {
  fsCurrentPreviewPath = filePath;
  $('fsPreviewTitle').textContent = filePath.split('/').pop() || 'Preview';
  $('fsPreviewSize').textContent = 'Loading...';
  $('fsPreviewContent').textContent = 'Memuat isi file...';
  $('fsPreviewNotice').style.display = 'none';
  $('fsPreviewDownloadBtn').onclick = () => {
    location.href = `/api/fs/download?path=${encodeURIComponent(filePath)}`;
  };
  $('fsPreviewModal').classList.add('open');

  try {
    const d = await j(`/api/fs/read?path=${encodeURIComponent(filePath)}`);
    $('fsPreviewTitle').textContent = d.name;
    $('fsPreviewSize').textContent = fmtBytes(d.size);

    if (d.truncated) {
      $('fsPreviewNotice').textContent = `File berukuran besar (${fmtBytes(d.size)}). Hanya menampilkan 512 KB pertama. Gunakan tombol Download untuk mengunduh seluruh file.`;
      $('fsPreviewNotice').style.display = 'block';
    }

    if (!d.isText) {
      $('fsPreviewNotice').textContent = 'File binary tidak dapat ditampilkan sebagai teks. Klik tombol Download di atas.';
      $('fsPreviewNotice').style.display = 'block';
      $('fsPreviewContent').textContent = '[Binary File]';
    } else {
      $('fsPreviewContent').textContent = d.content || '(File kosong)';
    }
  } catch (err) {
    $('fsPreviewContent').textContent = 'Gagal membaca file: ' + err.message;
  }
}

// ---- User Management ----
let rawUsers = [];
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtUserDate(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return '—'; }
}
async function users() {
  if (!isAdmin) return;
  try {
    const d = await j('/api/users');
    rawUsers = d.users || [];
    renderUsers();
  } catch {
    $('usersList').innerHTML = '<tr><td colspan="6" style="color:var(--bad);text-align:center;padding:18px">Gagal memuat data pengguna</td></tr>';
  }
}
function renderUsers() {
  $('userCount').textContent = rawUsers.length;
  if (!rawUsers.length) {
    $('usersList').innerHTML = '<tr><td colspan="6" style="color:var(--mut);text-align:center;padding:18px">Belum ada user panel. Tambahkan user pertama.</td></tr>';
    return;
  }
  $('usersList').innerHTML = rawUsers.map(u => `
    <tr>
      <td><strong>${escHtml(u.username)}</strong></td>
      <td>${u.role === 'superadmin' ? '<span class="pill ok">superadmin</span>' : u.admin ? '<span class="pill ok">admin</span>' : '<span class="pill">viewer</span>'}${u.role !== 'superadmin' && (u.hiddenKeywords || []).length ? ` <span class="pill" title="Project tersembunyi: ${escHtml(u.hiddenKeywords.join(', '))}">hide ${u.hiddenKeywords.length}</span>` : ''}</td>
      <td>${u.disabled ? '<span class="pill down">disabled</span>' : '<span class="pill ok">active</span>'}</td>
      <td style="color:var(--mut)">${fmtUserDate(u.createdAt)}</td>
      <td style="color:var(--mut)">${fmtUserDate(u.updatedAt)}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn-sm" data-edit-user="${escHtml(u.username)}">Edit</button>
        <button class="btn-sm" data-reset-user="${escHtml(u.username)}" title="Nonaktif / aktifkan akun">${u.disabled ? 'Aktifkan' : 'Nonaktif'}</button>
        <button class="btn-sm danger" data-del-user="${escHtml(u.username)}">Hapus</button>
      </td>
    </tr>
  `).join('');
}

// ---- Hosted Sites ----
let rawSites = [];
let siteStatus = {};      // id -> hasil probe dari /api/sites/check
let siteChecking = false;
let siteDelTarget = null;
async function sites() {
  if (!isAdmin) return;
  try {
    const d = await j('/api/sites');
    rawSites = d.sites || [];
    renderSites();
    checkSites();
  } catch {
    $('sitesList').innerHTML = '<tr><td colspan="7" style="color:var(--bad);text-align:center;padding:18px">Gagal memuat sites</td></tr>';
  }
}
async function checkSites() {
  if (siteChecking) return;
  siteChecking = true;
  siteStatus = {};
  renderSites();
  try {
    const d = await j('/api/sites/check');
    siteStatus = Object.fromEntries((d.results || []).map(r => [r.id, r]));
  } catch {}
  siteChecking = false;
  renderSites();
}
function siteStatusHtml(s) {
  const st = siteStatus[s.id];
  if (!st) return siteChecking ? '<span style="color:var(--mut)">memeriksa…</span>' : '<span style="color:var(--mut)">—</span>';
  let main;
  if (st.state === 'up') main = `<span class="pill ok">UP ${st.http.status}</span> <span style="color:var(--mut);font-size:11px">${st.http.ms}ms</span>`;
  else if (st.state === 'warn') main = `<span class="pill warn">HTTP ${st.http.status}</span>`;
  else if (st.state === 'down') main = `<span class="pill down">DOWN${st.http && st.http.status ? ' ' + st.http.status : ''}</span>`;
  else main = '<span class="pill">tidak dicek</span>';
  const why = (st.reasons || []).length ? `<div style="color:var(--bad);font-size:11px;margin-top:3px">${st.reasons.map(escHtml).join('<br>')}</div>` : '';
  return main + why;
}
function renderSites() {
  const q = ($('sitesSearch').value || '').trim().toLowerCase();
  const onlyInactive = $('sitesFilter').value === 'inactive';
  const list = rawSites.filter(s =>
    (!q || [s.file, s.root, s.upstream, ...(s.domains || [])].join(' ').toLowerCase().includes(q)) &&
    (!onlyInactive || (siteStatus[s.id] && siteStatus[s.id].inactive)));
  const inactiveCount = rawSites.filter(s => siteStatus[s.id] && siteStatus[s.id].inactive).length;
  $('sitesCount').textContent = (list.length === rawSites.length ? rawSites.length : `${list.length}/${rawSites.length}`) + (inactiveCount ? ` · ${inactiveCount} tidak aktif` : '');
  if (!list.length) {
    const msg = !rawSites.length ? 'Tidak ada site nginx yang enabled'
      : onlyInactive ? (siteChecking ? 'Memeriksa status site…' : 'Tidak ada site yang tidak aktif')
      : 'Tidak ada site yang cocok dengan filter';
    $('sitesList').innerHTML = `<tr><td colspan="7" style="color:var(--mut);text-align:center;padding:18px">${msg}</td></tr>`;
    return;
  }
  $('sitesList').innerHTML = list.map((s, i) => {
    const scheme = s.ssl ? 'https' : 'http';
    // Wildcard / regex server_name (*.x.com, ~^..) tidak bisa dikunjungi langsung.
    const visit = dm => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(dm)
      ? ` <a class="btn-sm ok" style="text-decoration:none;margin-left:6px" href="${scheme}://${escHtml(dm)}" target="_blank" rel="noopener noreferrer">Visit ↗</a>` : '';
    const domains = (s.domains || []).length
      ? s.domains.map(dm => `<div><strong>${escHtml(dm)}</strong>${visit(dm)}</div>`).join('')
      : `<span style="color:var(--mut)">${s.defaultServer ? '(default server)' : '—'}</span>`;
    const target = s.broken
      ? `<span style="color:var(--bad)">${escHtml(s.error || 'rusak')}</span>`
      : s.type === 'proxy' || s.type === 'php' ? `<span style="font-family:var(--font-mono)">${escHtml(s.upstream)}</span>`
      : s.root ? `<span style="font-family:var(--font-mono)">${escHtml(s.root)}</span>${s.rootExists === false ? ' <span class="pill down">root tidak ada</span>' : ''}`
      : '<span style="color:var(--mut)">—</span>';
    return `
    <tr>
      <td>${domains}</td>
      <td>${siteStatusHtml(s)}</td>
      <td>${s.broken ? '<span class="pill down">broken</span>' : `<span class="pill">${escHtml(s.type)}</span>`}</td>
      <td>${s.ssl ? '<span class="pill ok">https</span>' : '<span class="pill warn">http</span>'}</td>
      <td>${target}</td>
      <td style="color:var(--mut);font-family:var(--font-mono)" title="${escHtml(s.dir)}">${escHtml(s.file)}</td>
      <td style="text-align:right;white-space:nowrap"><button class="btn-sm" data-cfg-site="${escHtml(s.id)}" title="Lihat config nginx yang aktif">Config</button> <button class="btn-sm danger" data-del-site="${escHtml(s.id)}" title="Hapus config nginx saja">Hapus config</button> <button class="btn-sm danger" data-und-site="${escHtml(s.id)}" title="Hapus deployment: nginx + folder + git">Undeploy</button></td>
    </tr>`;
  }).join('');
}
async function openSiteConfig(id) {
  const s = rawSites.find(x => x.id === id);
  if (!s) return;
  $('siteCfgTitle').textContent = 'Config nginx — ' + s.file;
  $('siteCfgMeta').textContent = s.id;
  $('siteCfgContent').textContent = 'Memuat config...';
  $('siteCfgModal').classList.add('open');
  try {
    const d = await j('/api/sites/config?id=' + encodeURIComponent(id));
    $('siteCfgMeta').textContent = d.realPath !== d.file ? `${d.file} → ${d.realPath}` : d.file;
    $('siteCfgMeta').textContent += `  ·  ${fmtBytes(d.size)}  ·  diubah ${new Date(d.mtime).toLocaleString()}`;
    $('siteCfgContent').textContent = d.content || '(File kosong)';
  } catch (e) {
    $('siteCfgContent').textContent = 'Gagal membaca config: ' + e.message;
  }
}
function openSiteDelete(id) {
  const s = rawSites.find(x => x.id === id);
  if (!s) return;
  siteDelTarget = s;
  const st = siteStatus[id];
  $('siteDelInfo').innerHTML = `<div><strong>${escHtml((s.domains || []).join(', ') || s.file)}</strong></div>
    <div style="color:var(--mut);font-family:var(--font-mono);font-size:12px">${escHtml(s.id)}</div>` +
    (st && st.reasons && st.reasons.length ? `<div style="color:var(--bad);margin-top:4px">${st.reasons.map(escHtml).join(' · ')}</div>`
      : st && !st.inactive ? '<div style="color:var(--warn);margin-top:4px">⚠ Site ini terdeteksi masih aktif.</div>' : '');
  $('siteDelPassword').value = '';
  $('siteDelErr').style.display = 'none';
  $('siteDelConfirm').disabled = false;
  $('siteDelModal').classList.add('open');
  setTimeout(() => $('siteDelPassword').focus(), 50);
}
function closeSiteDelete() { $('siteDelModal').classList.remove('open'); siteDelTarget = null; }
async function confirmSiteDelete() {
  if (!siteDelTarget) return;
  const btn = $('siteDelConfirm');
  const showErr = (m) => { $('siteDelErr').textContent = m; $('siteDelErr').style.display = ''; };
  if (!$('siteDelPassword').value) return showErr('Password wajib diisi');
  btn.disabled = true;
  try {
    const d = await api('POST', '/api/sites/delete', { id: siteDelTarget.id, password: $('siteDelPassword').value });
    closeSiteDelete();
    $('gitModalTitle').textContent = 'Site dihapus';
    $('gitModalBody').textContent = [d.output, d.warning, d.backup && ('Backup config: ' + d.backup)].filter(Boolean).join('\n');
    $('gitModalBody').className = 'modal-body ' + (d.warning ? 'err' : 'ok');
    $('gitModal').classList.add('open');
    sites();
  } catch (e) {
    showErr(e.message);
    btn.disabled = false;
    $('siteDelPassword').select();
  }
}

// ---- Activity Log ----
let rawActivity = [];
let activityTimer = null;
let activityTotal = 0;
const ACTIVITY_LABELS = {
  'ui.view': ['viewing page', ''],
  'ui.click': ['click', ''],
  'auth.login': ['login', 'ok'],
  'auth.login.fail': ['login FAILED', 'down'],
  'auth.logout': ['logout', ''],
  'git.pull': ['git pull', 'warn'],
  'git.seed': ['git seed', 'warn'],
  'git.composer': ['composer update', 'warn'],
  'git.terminal': ['terminal cmd', 'warn'],
  'git.db.sync': ['sync db', 'warn'],
  'git.db.sync.denied': ['sync db DENIED', 'down'],
  'git.db.sync.fail': ['sync db FAILED', 'down'],
  'backup.run': ['backup run', 'warn'],
  'backup.download': ['backup download', ''],
  'deploy.start': ['deploy', 'warn'],
  'undeploy.start': ['undeploy', 'down'],
  'undeploy.done': ['undeploy done', 'down'],
  'undeploy.denied': ['undeploy DENIED', 'down'],
  'undeploy.fail': ['undeploy FAILED', 'down'],
  'transfer.start': ['transfer', 'warn'],
  'transfer.cancel': ['transfer cancel', 'down'],
  'user.create': ['user create', 'warn'],
  'user.update': ['user update', 'warn'],
  'user.delete': ['user delete', 'down'],
  'site.delete': ['site delete', 'down'],
  'site.delete.denied': ['site delete DENIED', 'down'],
  'site.delete.fail': ['site delete FAILED', 'down'],
  'worker.supervisor': ['worker', ''],
  'worker.service': ['service', ''],
  'worker.cron': ['cron', ''],
  'pm2.restart': ['pm2 restart', 'warn'],
  'fs.list': ['fs list', ''],
  'fs.read': ['fs read', ''],
  'fs.download': ['fs download', ''],
};
function activityLabel(a) {
  const e = ACTIVITY_LABELS[a] || [a, ''];
  return `<span class="pill ${e[1]}">${escHtml(e[0])}</span>`;
}
async function activity() {
  if (!isAdmin) return;
  try {
    const d = await j('/api/activity?limit=200');
    rawActivity = d.entries || [];
    activityTotal = d.total || rawActivity.length;
    renderActivity();
  } catch {
    $('activityList').innerHTML = '<tr><td colspan="5" style="color:var(--bad);text-align:center;padding:18px">Gagal memuat activity</td></tr>';
  }
}
function renderActivity() {
  const q = ($('activitySearch').value || '').trim().toLowerCase();
  const qu = ($('activityUser').value || '').trim().toLowerCase();
  const qa = $('activityAction').value;
  let list = rawActivity;
  if (q) list = list.filter((a) => (a.target + ' ' + a.details).toLowerCase().includes(q));
  if (qu) list = list.filter((a) => String(a.user).toLowerCase().includes(qu));
  if (qa) list = list.filter((a) => String(a.action).startsWith(qa));
  $('activityCount').textContent = list.length + (list.length !== rawActivity.length ? ' / ' + rawActivity.length : '');
  if (!list.length) {
    $('activityList').innerHTML = '<tr><td colspan="5" style="color:var(--mut);text-align:center;padding:18px">Tidak ada aktivitas cocok.</td></tr>';
    return;
  }
  $('activityList').innerHTML = list.map((a) => `
    <tr>
      <td style="color:var(--mut);white-space:nowrap">${fmtUserDate(a.t)}</td>
      <td><strong>${escHtml(a.user)}</strong></td>
      <td>${activityLabel(a.action)}</td>
      <td style="font-family:var(--font-mono);font-size:12px">${escHtml(a.target)}</td>
      <td style="color:var(--mut);font-size:12px">${escHtml(a.details)}</td>
    </tr>
  `).join('');
}
function activityAutoToggle() {
  if (activityTimer) { clearInterval(activityTimer); activityTimer = null; }
  if ($('activityAuto').checked && currentView() === 'activity') {
    activityTimer = setInterval(() => { if (currentView() === 'activity') activity(); else activityAutoToggle(); }, 10000);
  }
}
$('activityRefresh').onclick = () => activity();
$('activitySearch').addEventListener('input', renderActivity);
$('activityUser').addEventListener('input', renderActivity);
$('activityAction').addEventListener('change', renderActivity);
$('activityAuto').addEventListener('change', activityAutoToggle);

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
$('logout').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
};

async function stats() {
  try {
    const s = await j('/api/stats');
    $('host').innerHTML = `<strong>${s.hostname}</strong>`;
    if (s.os && s.os !== s.hostname) {
      $('os').textContent = s.os;
      $('os').style.display = '';
      $('hostBox').title = s.os;
    } else {
      $('os').style.display = 'none';
      $('hostBox').title = '';
    }

    const up = Math.floor(s.uptime);
    const d = Math.floor(up / 86400), h = Math.floor((up % 86400) / 3600), m = Math.floor((up % 3600) / 60);
    $('uptime').textContent = `up ${d}d ${h}h ${m}m`;
    $('time').textContent = new Date(s.time).toLocaleTimeString();

    // CPU
    $('cores').textContent = `${s.cpu.cores} Cores`;
    $('cpu').textContent = s.cpu.pct.toFixed(1) + '\%';
    const cm = fmtCpu(s.cpu.model);
    $('cpuModel').textContent = cm;
    $('cpuModel').title = s.cpu.model || '';
    setBar($('cpuBar'), s.cpu.pct);$('load').textContent = `${s.load.l1.toFixed(2)} · ${s.load.l5.toFixed(2)} · ${s.load.l15.toFixed(2)}`;

    // Memory
    $('mem').textContent = s.mem.pct.toFixed(1) + '\%';$('memDet').textContent = `${fmtBytes(s.mem.used)} / ${fmtBytes(s.mem.total)}`;
    $('memAvail').textContent = s.mem.available ? `${fmtBytes(s.mem.available)} avail` : '';
    setBar($('memBar'), s.mem.pct);$('swap').textContent = s.mem.swapTotal ? `Swap: ${fmtBytes(s.mem.swapUsed)} / ${fmtBytes(s.mem.swapTotal)}` : 'Swap: Off';
    $('cached').textContent = `Cache: ${fmtBytes((s.mem.cached || 0) + (s.mem.buffers || 0))}`;

    // Disk
    $('disk').textContent = s.disk.pct.toFixed(1) + '\%';$('diskFree').textContent = `${fmtBytes(s.disk.avail)} free`;
    $('diskDet').textContent = `${fmtBytes(s.disk.used)} / ${fmtBytes(s.disk.total)}`;
    $('inodes').textContent = s.disk.inodesPct != null ? `Inodes ${s.disk.inodesPct}%` : 'Mount /';
    setBar($('diskBar'), s.disk.pct);

    // Network Live Throughput + Total
    if (prevNet && s.time > prevNet.time) {
      const dt = (s.time - prevNet.time) / 1000;
      const rxRate = Math.max(0, (s.net.rx - prevNet.rx) / dt);
      const txRate = Math.max(0, (s.net.tx - prevNet.tx) / dt);
      $('netRxRate').textContent = fmtBytes(rxRate) + '/s';$('netTxRate').textContent = fmtBytes(txRate) + '/s';
    }
    prevNet = { rx: s.net.rx, tx: s.net.tx, time: s.time };
    $('netTotal').textContent = `↓ ${fmtBytes(s.net.rx)} · ↑ ${fmtBytes(s.net.tx)}`;

    // Live Disk I/O sync
    if (s.io) updateStorageIO(s.io);
  } catch (e) {}
}

function updateStorageIO(io) {
  if (!io) return;
  const rEl = $('storageIoRead'), wEl = $('storageIoWrite'), tEl = $('storageIoRate'), iEl = $('storageIoIops');
  if (rEl) rEl.textContent = `↓ ${fmtBytes(io.readRate || 0)}/s`;
  if (wEl) wEl.textContent = `↑ ${fmtBytes(io.writeRate || 0)}/s`;
  const totRate = (io.readRate || 0) + (io.writeRate || 0);
  if (tEl) tEl.textContent = `${fmtBytes(totRate)}/s`;
  if (iEl) iEl.textContent = `${io.totalIops || 0} IOPS`;
}

function fmtProcDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

function renderProcs() {
  const q = ($('procSearch').value || '').trim().toLowerCase();
  const minCpu = parseFloat($('procMinCpu').value) || 0;
  const filtered = rawProcs
    .filter(r => !q || String(r.cmd || '').toLowerCase().includes(q) || String(r.user || '').toLowerCase().includes(q) || String(r.pid).includes(q))
    .filter(r => (Number(r.cpu) || 0) >= minCpu)
    .sort((a, b) => (Number(b[procSort]) || 0) - (Number(a[procSort]) || 0));

  $('procCount').textContent = `${filtered.length} / ${rawProcs.length}`;
  if (!filtered.length) {
    $('procs').innerHTML = '<tr><td colspan="8" style="color:var(--mut)">No processes match the current filter</td></tr>';
    return;
  }
  $('procs').innerHTML = filtered.map(r => {
    const rssBytes = (parseInt(r.rss, 10) || 0) * 1024;
    const hot = (Number(r.cpu) || 0) >= 50;
    const safeCmd = escHtml(r.cmd);
    return `<tr class="${hot ? 'proc-row-spike' : ''}">
      <td><code>${escHtml(r.pid)}</code></td>
      <td><strong>${escHtml(r.user)}</strong></td>
      <td style="color:var(--mut)">${escHtml(r.stat || '—')}</td>
      <td>
        <div class="usage-cell">
          <span style="width:52px">${(Number(r.cpu) || 0).toFixed(1)}%</span>
          <div class="mini-bar"><i style="width:${Math.min(100, Number(r.cpu) || 0)}%;background:${barColor(Number(r.cpu) || 0)}"></i></div>
        </div>
      </td>
      <td>
        <div class="usage-cell">
          <span style="width:44px">${(Number(r.mem) || 0).toFixed(1)}%</span>
          <div class="mini-bar"><i style="width:${Math.min(100, Number(r.mem) || 0)}%;background:${barColor(Number(r.mem) || 0)}"></i></div>
        </div>
      </td>
      <td style="color:var(--mut)">${fmtBytes(rssBytes)}</td>
      <td style="color:var(--mut)">${escHtml(r.etime || '—')}</td>
      <td><code class="cmd-code" title="${safeCmd}">${safeCmd}</code></td>
    </tr>`;
  }).join('');
}

function renderProcSummary() {
  const top = rawProcs.slice().sort((a, b) => (Number(b.cpu) || 0) - (Number(a.cpu) || 0))[0];
  const systemCpu = Number(procMeta.systemCpu) || 0;
  $('procCpuNow').textContent = `${systemCpu.toFixed(1)}%`;
  $('procCpuSub').textContent = `${procMeta.cores || '—'} cores`;
  $('procCpuPill').className = 'pill ' + (systemCpu >= 85 ? 'down' : systemCpu >= 70 ? 'warn' : 'ok');
  $('procSampleInfo').textContent = procMeta.sampledAt
    ? new Date(procMeta.sampledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'warming up';

  $('procTopCpu').textContent = top ? `${(Number(top.cpu) || 0).toFixed(1)}%` : '—';
  $('procTopUser').textContent = top ? `PID ${top.pid} · ${top.user}` : '—';
  $('procTopCmd').textContent = top ? top.cmd : '—';
  $('procTopCmd').title = top ? top.cmd : '';
  $('procTopPill').className = 'pill ' + (top && Number(top.cpu) >= 80 ? 'down' : 'warn');

  $('procSpikeCount').textContent = rawSpikes.length;
  $('procSpikeBadge').textContent = rawSpikes.length;
  $('procSpikeHistoryCount').textContent = rawSpikes.length;
  $('procSpikeThreshold').textContent = `${procMeta.spikeThreshold || 70}%`;
  $('procIntervalNote').textContent = `${(procMeta.intervalMs || 5000) / 1000}s`;

  const last = rawSpikes[0];
  if (last) {
    $('procLastSpikeCpu').textContent = `${(Number(last.peakCpu) || 0).toFixed(1)}%`;
    $('procLastSpikeTime').textContent = new Date(last.lastSeen || last.start).toLocaleString([]);
    $('procLastSpikeProc').textContent = last.top ? `PID ${last.top.pid} · ${last.top.user} · ${last.top.cmd}` : 'aggregate load';
    $('procLastSpikeProc').title = $('procLastSpikeProc').textContent;
    $('procLastSpikePill').className = 'pill down';
  } else {
    $('procLastSpikeCpu').textContent = '—';
    $('procLastSpikeTime').textContent = 'No spike recorded';
    $('procLastSpikeProc').textContent = '—';
    $('procLastSpikeProc').title = '';
    $('procLastSpikePill').className = 'pill ok';
  }
}

function renderProcessSpikes() {
  if (!isAdmin || !$('procSpikeList')) return;
  if (!rawSpikes.length) {
    $('procSpikeList').innerHTML = '<tr><td colspan="6" style="color:var(--mut)">No CPU spikes recorded in the selected window.</td></tr>';
    return;
  }
  $('procSpikeList').innerHTML = rawSpikes.map((s, i) => {
    const top = s.top || {};
    const safeCmd = escHtml(top.cmd || '—');
    return `<tr>
      <td>${escHtml(new Date(s.start).toLocaleString([]))}</td>
      <td>${escHtml(fmtProcDuration(s.durationSec))}</td>
      <td style="color:var(--bad);font-weight:600">${(Number(s.peakCpu) || 0).toFixed(1)}%</td>
      <td>${top.pid ? `<code>${escHtml(top.pid)}</code> · ${escHtml(top.user || '—')}` : '—'}</td>
      <td><code class="cmd-code" title="${safeCmd}">${safeCmd}</code></td>
      <td style="text-align:right"><button class="btn-sm" data-spike-index="${i}">Detail</button></td>
    </tr>`;
  }).join('');
}

function showSpikeDetail(index) {
  const s = rawSpikes[index];
  if (!s) return;
  const lines = [
    `Started: ${new Date(s.start).toLocaleString([])}`,
    `Last seen: ${new Date(s.lastSeen || s.start).toLocaleString([])}`,
    `Duration: ${fmtProcDuration(s.durationSec)}`,
    `Peak system CPU: ${(Number(s.peakCpu) || 0).toFixed(1)}%`,
    `Peak process CPU: ${(Number(s.peakProcCpu) || 0).toFixed(1)}%`,
    `Samples: ${s.samples || 1}`,
    '',
    'Top processes:',
  ];
  for (const p of (s.top5 || [])) {
    lines.push(`  ${String(p.cpu).padStart(6)}%  PID ${p.pid}  ${p.user}  ${p.cmd}`);
  }
  if (s.queries && s.queries.length) {
    lines.push('', 'MySQL queries running during the spike (longest first):');
    for (const q of s.queries) {
      lines.push(`  ${fmtProcDuration(q.time)} · ${q.user}@${q.db || '-'} · seen ${q.seen}x${q.state ? ' · ' + q.state : ''}`, `    ${q.info}`);
    }
  }
  openModalText(`CPU spike · ${new Date(s.start).toLocaleString([])}`, lines.join('\n'));
}

async function procs() {
  try {
    const d = await j('/api/processes?limit=200&hours=24');
    rawProcs = d.rows || [];
    rawSpikes = d.spikes || [];
    procMeta = {
      intervalMs: d.intervalMs || 5000,
      cores: d.cores || 0,
      spikeThreshold: d.spikeThreshold || 70,
      sampledAt: d.sampledAt || 0,
      systemCpu: d.systemCpu || 0,
    };
    renderProcs();
    renderProcSummary();
    renderProcessSpikes();
  } catch (e) {}
}

// ---- MySQL running queries ----
let rawMysqlQueries = [];
let mysqlQueryError = '';

function renderMysqlQueries() {
  if (!$('mysqlQueries')) return;
  if (mysqlQueryError) {
    $('mysqlQueryCount').textContent = '0';
    $('mysqlQueries').innerHTML = `<tr><td colspan="8" style="color:var(--bad)">${escHtml(mysqlQueryError)}</td></tr>`;
    return;
  }
  const q = ($('mysqlQuerySearch').value || '').trim().toLowerCase();
  const showIdle = $('mysqlShowSleep').checked;
  const filtered = rawMysqlQueries.filter(r =>
    (showIdle || r.command !== 'Sleep') &&
    (!q || `${r.id} ${r.user} ${r.db} ${r.state} ${r.info}`.toLowerCase().includes(q)));
  $('mysqlQueryCount').textContent = `${filtered.length} / ${rawMysqlQueries.length}`;
  if (!filtered.length) {
    $('mysqlQueries').innerHTML = '<tr><td colspan="8" style="color:var(--mut)">No active queries right now</td></tr>';
    return;
  }
  $('mysqlQueries').innerHTML = filtered.map((r, i) => {
    const slow = r.command !== 'Sleep' && r.time >= 5;
    const info = (r.info || '').replace(/\s+/g, ' ').trim();
    return `<tr class="${slow ? 'proc-row-spike' : ''}">
      <td>${r.id}</td>
      <td>${escHtml(r.user)}</td>
      <td>${escHtml(r.db || '—')}</td>
      <td>${escHtml(r.command)}</td>
      <td>${escHtml(fmtProcDuration(r.time))}</td>
      <td>${escHtml(r.state || '—')}</td>
      <td style="font-family:var(--font-mono);font-size:11px;word-break:break-all;cursor:${info ? 'pointer' : 'default'}" ${info ? `data-mysql-query="${r.id}" title="Click to view full query"` : ''}>${escHtml(info.length > 200 ? info.slice(0, 200) + '…' : info) || '—'}</td>
      <td style="text-align:right">${r.command !== 'Sleep' && info ? `<button class="btn-sm" data-mysql-kill="${r.id}">Kill</button>` : ''}</td>
    </tr>`;
  }).join('');
}

async function killMysqlQuery(id) {
  const r = rawMysqlQueries.find(x => x.id === id);
  if (!r) return;
  const snippet = r.info.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!confirm(`Kill query on connection ${r.id}?\n\n${r.user}@${r.db || '-'} · running ${fmtProcDuration(r.time)}\n\n${snippet}`)) return;
  try {
    const res = await fetch('/api/mysql/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: r.id, info: r.info }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) alert(d.error || 'Failed to kill query');
  } catch (e) {
    alert('Failed to kill query');
  }
  mysqlQueries();
}

async function mysqlQueries() {
  if (!isAdmin || !$('mysqlQueries')) return;
  try {
    const r = await fetch('/api/mysql/processlist');
    if (r.status === 401) { location.href = '/login'; return; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      mysqlQueryError = d.error || 'Failed to read MySQL processlist';
      rawMysqlQueries = [];
    } else {
      mysqlQueryError = '';
      rawMysqlQueries = d.rows || [];
    }
    renderMysqlQueries();
  } catch (e) {}
}

// ---- Error logs ----
function renderErrorKpis() {
  if (!errorData) return;
  const s = errorData.summary || {};
  const h = Number(errorData.windowHours);
  const windowLabel = h > 0 ? `last ${h}h` : 'all available';
  $('errorCritical').textContent = s.critical || 0;
  $('errorErrors').textContent = s.error || 0;
  $('errorWarnings').textContent = s.warning || 0;
  $('errorSources').textContent = s.activeSources || 0;
  $('errorScanned').textContent = `${errorData.scannedSources || 0} files`;
  $('errorCriticalSub').textContent = windowLabel;
  $('errorErrorsSub').textContent = windowLabel;
  $('errorWarningsSub').textContent = windowLabel;
  $('errorSourcesSub').textContent = 'logs with errors';
  $('errorCriticalFoot').textContent = `${s.critical || 0} critical`;
  $('errorErrorsFoot').textContent = `${s.error || 0} errors`;
  $('errorWarningsFoot').textContent = `${s.warning || 0} warnings`;
  $('errorCriticalPill').className = 'pill ' + ((s.critical || 0) > 0 ? 'down' : 'ok');
  $('errorCriticalPill').textContent = (s.critical || 0) > 0 ? 'ATTENTION' : 'CLEAR';
  $('errorErrorsPill').className = 'pill ' + ((s.error || 0) > 0 ? 'warn' : 'ok');
  $('errorErrorsPill').textContent = (s.error || 0) > 0 ? 'ACTIVE' : 'CLEAR';
  $('errorWarningsPill').className = 'pill ok';
  $('errorWarningsPill').textContent = 'INFO';
  $('errorSourcesPill').textContent = `${errorData.scannedSources || 0} scanned`;
}

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
  if (cur && projects.includes(cur)) sel.value = cur;
}

function syncErrorSelection() {
  const bar = $('errorSelectionBar');
  if (!bar) return;
  const count = $('errorSelectedCount');
  if (count) count.textContent = errorSelected.size;
  bar.hidden = errorSelected.size === 0;
  const all = $('errorSelectAll');
  if (!all) return;
  const boxes = [...$('errorList').querySelectorAll('input[data-error-id]')];
  const checked = boxes.filter(b => b.checked).length;
  all.checked = boxes.length > 0 && checked === boxes.length;
  all.indeterminate = checked > 0 && checked < boxes.length;
}

function renderErrors() {
  if (!errorData) return;
  const q = ($('errorSearch').value || '').trim().toLowerCase();
  const project = $('errorProject').value;
  const counts = errorProjectCounts();
  const entries = (errorData.entries || []).filter(e => {
    if (project && e.project !== project) return false;
    if (errorLevel === 'critical' && !e.critical) return false;
    if (errorLevel === 'error' && e.level !== 'ERROR') return false;
    if (errorLevel === 'warning' && e.level !== 'WARNING') return false;
    if (q && ![e.message, e.project, e.source, e.level].some(v => String(v || '').toLowerCase().includes(q))) return false;
    return true;
  }).sort((a, b) => ((counts.get(b.project) || 0) - (counts.get(a.project) || 0)) || (b.t - a.t));
  errorViewEntries = entries;
  $('errorBadge').textContent = `${entries.length} / ${(errorData.entries || []).length}`;

  if (!entries.length) {
    $('errorList').innerHTML = '<tr><td colspan="6" style="color:var(--mut)">No errors match the current filter.</td></tr>';
    syncErrorSelection();
    return;
  }
  $('errorList').innerHTML = entries.map((e, i) => {
    const lvl = e.level === 'WARNING' ? 'warn' : e.critical ? 'down' : 'warn';
    const when = e.t ? new Date(e.t).toLocaleString([]) : '—';
    return `<tr class="${e.critical ? 'err-row-crit' : ''}">
      <td><input type="checkbox" data-error-id="${escHtml(e.id)}" aria-label="Pilih error ${escHtml(e.project)}" ${errorSelected.has(e.id) ? 'checked' : ''} /></td>
      <td><span class="pill ${lvl}">${escHtml(e.level)}</span></td>
      <td style="color:var(--mut);white-space:nowrap">${escHtml(when)}</td>
      <td><span class="err-project-pill">${escHtml(e.project)}</span><div style="font-size:10px;color:var(--mut);margin-top:3px;font-family:var(--font-mono)">${escHtml(e.source)}</div></td>
      <td class="err-msg-cell">${escHtml(e.message || '(empty)')}</td>
      <td style="text-align:right"><span class="err-row-actions">
        <button class="btn-sm" data-error-index="${i}">Detail</button>
        <button class="btn-sm danger" data-error-delete="${escHtml(e.id)}" title="Hapus baris log ini" aria-label="Hapus baris log ini">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
        </button>
      </span></td>
    </tr>`;
  }).join('');
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

async function errors(force = false) {
  if (!isAdmin) return;
  try {
    const hours = $('errorWindow') ? ($('errorWindow').value || '24') : '24';
    const d = await j(`/api/logs/errors?hours=${encodeURIComponent(hours)}${force ? '&force=1' : ''}`);
    errorData = d;
    errorSelected.clear();
    renderErrorKpis();
    renderErrorProjects();
    renderErrors();
  } catch (e) {
    if ($('errorList')) $('errorList').innerHTML = `<tr><td colspan="6" style="color:var(--bad)">${escHtml(e.message || 'Failed loading logs')}</td></tr>`;
  }
}

function showErrorDetail(index) {
  const e = errorViewEntries[index];
  if (!e) return;
  const lines = [
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

async function storage(force = false) {
  try {
    const btn = $('storageRefresh');
    if (force && btn) { btn.disabled = true; btn.textContent = 'Analyzing...'; }
    const d = await j(`/api/storage${force ? '?force=1' : ''}`);
    if (btn) { btn.disabled = false; btn.textContent = '↻ Analyze Storage'; }

    // Mounts
    const mounts = d.mounts || [];
    $('storageSummary').textContent = `${mounts.length} partition${mounts.length > 1 ? 's' : ''}`;

    // 1. Primary Mount KPI Card
    const rootMount = mounts.find(m => m.mount === '/') || mounts[0];
    if (rootMount) {
      const rPct = rootMount.pct || 0;
      $('storageRootPct').textContent = rPct.toFixed(1) + '%';
      $('storageRootFree').textContent = `${fmtBytes(rootMount.avail)} free`;
      $('storageRootUsed').textContent = `${fmtBytes(rootMount.used)} / ${fmtBytes(rootMount.total)}`;
      $('storageRootInodes').textContent = rootMount.inodesPct != null ? `${rootMount.inodesPct}%` : 'N/A';
      setBar($('storageRootBar'), rPct);
      const pill = $('storageRootPill');
      if (pill) {
        pill.className = `pill ${rPct >= 90 ? 'down' : (rPct >= 75 ? 'warn' : 'ok')}`;
        pill.textContent = rPct >= 90 ? 'Critical' : (rPct >= 75 ? 'Warning' : 'Healthy');
      }
    }

    // 2. Disk I/O card
    if (d.io) updateStorageIO(d.io);

    // 3. Caches Card
    const caches = d.caches || {};
    const aptBytes = caches.apt || 0;
    const jBytes = caches.journald || 0;
    const totalReclaimable = aptBytes + jBytes;
    $('storageReclaimable').textContent = fmtBytes(totalReclaimable);
    $('storageAptCache').textContent = aptBytes ? fmtBytes(aptBytes) : 'Clean';
    $('storageJournald').textContent = jBytes ? fmtBytes(jBytes) : '—';

    // 4. Large Logs Hotspots Card
    const logs = d.largeLogs || [];
    const totalLogBytes = logs.reduce((acc, l) => acc + (l.bytes || 0), 0);
    $('storageHotspotCount').textContent = `${logs.length} file${logs.length === 1 ? '' : 's'}`;
    $('storageHotspotTotal').textContent = fmtBytes(totalLogBytes);
    $('storageHotspotBar').style.width = Math.min(100, Math.max(10, (totalLogBytes / (100 * 1024 * 1024)) * 100)) + '%';

    // Mounts List
    if (!mounts.length) {
      $('mountsList').innerHTML = '<span style="color:var(--mut);font-size:12px">No partitions detected</span>';
    } else {
      $('mountsList').innerHTML = mounts.map(m => {
        const pct = m.pct || 0;
        const color = barColor(pct);
        const inodeAlert = m.inodesPct != null && m.inodesPct >= 80;
        return `<div class="worker-card" style="padding:10px 12px">
          <div class="worker-head">
            <div class="worker-title-box">
              <div class="worker-title" style="display:flex;align-items:center;gap:6px">
                <span>${m.mount}</span>
                <span style="font-size:11px;color:var(--mut);font-weight:400">(${m.fs})</span>
              </div>
              <div class="worker-meta" style="margin-top:3px">
                <strong>${fmtBytes(m.used)}</strong> / ${fmtBytes(m.total)} (${fmtBytes(m.avail)} free)
                ${m.inodesPct != null ? `<span style="margin-left:6px;opacity:0.8">· Inodes ${m.inodesPct}% ${inodeAlert ? '<span style="color:var(--bad);font-weight:600">⚠ High</span>' : ''}</span>` : ''}
              </div>
            </div>
            <span class="pill ${pct >= 90 ? 'down' : (pct >= 75 ? 'warn' : 'ok')}">${pct.toFixed(0)}%</span>
          </div>
          <div class="bar" style="margin:8px 0 2px"><i style="width:${Math.min(100, pct)}%;background-color:${color}"></i></div>
        </div>`;
      }).join('');
    }

    // Critical directories
    const dirs = d.dirs || [];
    const maxDirBytes = Math.max(...dirs.map(x => x.bytes), 1);
    if (!dirs.length) {
      $('storageDirsList').innerHTML = '<span style="color:var(--mut);font-size:12px">No directory data</span>';
    } else {
      $('storageDirsList').innerHTML = dirs.map(dir => {
        const ratio = (dir.bytes / maxDirBytes) * 100;
        return `<div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:12px;margin-bottom:3px">
            <code style="background:transparent;padding:0;color:var(--tx)">${dir.path}</code>
            <strong style="color:var(--tx)">${fmtBytes(dir.bytes)}</strong>
          </div>
          <div class="mini-bar" style="width:100%;height:4px"><i style="width:${Math.min(100, ratio)}%;background:var(--ac)"></i></div>
        </div>`;
      }).join('');
    }

    // Top projects
    $('storageScanRoot').textContent = d.scanRoot || 'Projects';
    const projs = d.projects || [];
    const maxProjBytes = Math.max(...projs.map(x => x.bytes), 1);
    if (!projs.length) {
      $('storageProjectsList').innerHTML = '<span style="color:var(--mut);font-size:12px">No projects scanned</span>';
    } else {
      $('storageProjectsList').innerHTML = projs.slice(0, 8).map(pr => {
        const ratio = (pr.bytes / maxProjBytes) * 100;
        return `<div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:12px;margin-bottom:3px">
            <span style="font-weight:500;color:var(--tx);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${pr.relPath}">${pr.name}</span>
            <span style="color:var(--mut);font-size:11px">
              ${pr.logsBytes > 2 * 1024 * 1024 ? `<span style="color:var(--warn);font-weight:500">logs ${fmtBytes(pr.logsBytes)}</span> · ` : ''}
              <strong style="color:var(--tx)">${fmtBytes(pr.bytes)}</strong>
            </span>
          </div>
          <div class="mini-bar" style="width:100%;height:4px"><i style="width:${Math.min(100, ratio)}%;background:var(--ok)"></i></div>
        </div>`;
      }).join('');
    }

    // Large Log Hotspots
    if (!logs.length) {
      $('storageLogsList').innerHTML = '<span style="color:var(--mut);font-size:12px">No oversized logs detected (&gt; 2MB)</span>';
    } else {
      $('storageLogsList').innerHTML = logs.map(l => {
        const isBig = l.bytes > 10 * 1024 * 1024;
        return `<div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:12px;margin-bottom:3px">
            <span style="font-family:var(--font-mono);font-size:11px;color:var(--tx);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${l.path}">${l.path}</span>
            <span style="color:${isBig ? 'var(--bad)' : 'var(--warn)'};font-weight:600;font-size:11px;margin-left:8px;flex-shrink:0">${fmtBytes(l.bytes)}</span>
          </div>
          <div class="mini-bar" style="width:100%;height:3px"><i style="width:${Math.min(100, (l.bytes / (20 * 1024 * 1024)) * 100)}%;background:${isBig ? 'var(--bad)' : 'var(--warn)'}"></i></div>
        </div>`;
      }).join('');
    }
  } catch (e) {
    $('mountsList').innerHTML = '<span style="color:var(--bad);font-size:12px">Failed loading storage breakdown</span>';
  }
}

async function svc() {
  try {
    const d = await j('/api/services');
    const upCount = d.services.filter(s => s.active).length;
    $('svcSummary').innerHTML = `<strong>${upCount}/${d.services.length}</strong> active`;
    $('svc').innerHTML = d.services.map(s => `
      <div class="svc-item">
        <span class="svc-name" title="${s.name}">${s.name}</span>
        <span class="pill ${s.active ? 'ok' : 'down'}">${s.active ? '● Active' : '○ ' + s.status}</span>
      </div>
    `).join('');
  } catch (e) {}
}

async function hist() {
  try {
    const d = await j(`/api/history?limit=${histLimit}`);
    const labels = d.points.map(p => new Date(p.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    const datasets = [
      {
        label: 'CPU %',
        data: d.points.map(p => p.cpu),
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.12)',
        fill: true,
        borderWidth: 1.8,
        pointRadius: 0,
        tension: 0.3
      },
      {
        label: 'MEM %',
        data: d.points.map(p => p.mem),
        borderColor: '#10b981',
        backgroundColor: 'rgba(16, 185, 129, 0.08)',
        fill: true,
        borderWidth: 1.8,
        pointRadius: 0,
        tension: 0.3
      },
      {
        label: 'Load1 (x10)',
        data: d.points.map(p => +(p.l1 * 10).toFixed(1)),
        borderColor: '#f59e0b',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.3,
        borderDash: [4, 4]
      }
    ];

    if (!chart) {
      chart = new Chart($('hist'), {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              labels: { color: '#8a94a6', boxWidth: 12, usePointStyle: true, font: { size: 11 } }
            },
            tooltip: {
              backgroundColor: '#171b24',
              titleColor: '#f0f4f8',
              bodyColor: '#cbd5e1',
              borderColor: '#2d3446',
              borderWidth: 1
            }
          },
          scales: {
            x: {
              ticks: { color: '#64748b', maxTicksLimit: 8, font: { size: 11 } },
              grid: { color: 'rgba(34, 39, 52, 0.5)' }
            },
            y: {
              min: 0,
              max: 100,
              ticks: { color: '#64748b', stepSize: 25, callback: v => v + '%', font: { size: 11 } },
              grid: { color: 'rgba(34, 39, 52, 0.5)' }
            }
          }
        }
      });
    } else {
      chart.data.labels = labels;
      chart.data.datasets = datasets;
      chart.update();
    }
  } catch (e) {}
}

// UI Events
$('procSearch').addEventListener('input', renderProcs);
if ($('procMinCpu')) $('procMinCpu').addEventListener('input', renderProcs);
if ($('procRefresh')) $('procRefresh').addEventListener('click', procs);
if ($('mysqlQueryRefresh')) $('mysqlQueryRefresh').addEventListener('click', mysqlQueries);
if ($('mysqlQuerySearch')) $('mysqlQuerySearch').addEventListener('input', renderMysqlQueries);
if ($('mysqlShowSleep')) $('mysqlShowSleep').addEventListener('change', renderMysqlQueries);
if ($('mysqlQueries')) {
  $('mysqlQueries').addEventListener('click', (e) => {
    const kill = e.target.closest('[data-mysql-kill]');
    if (kill) return killMysqlQuery(parseInt(kill.dataset.mysqlKill, 10));
    const cell = e.target.closest('[data-mysql-query]');
    if (!cell) return;
    const r = rawMysqlQueries.find(x => x.id === parseInt(cell.dataset.mysqlQuery, 10));
    if (r) openModalText(`MySQL query · ID ${r.id} · ${r.user}@${r.db || '-'} · ${fmtProcDuration(r.time)}`, r.info);
  });
}
if ($('procSpikeList')) {
  $('procSpikeList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-spike-index]');
    if (btn) showSpikeDetail(parseInt(btn.dataset.spikeIndex, 10));
  });
}

if ($('errorSearch')) $('errorSearch').addEventListener('input', renderErrors);
if ($('errorProject')) $('errorProject').addEventListener('change', renderErrors);
if ($('errorWindow')) $('errorWindow').addEventListener('change', () => errors());
if ($('errorRefresh')) $('errorRefresh').addEventListener('click', () => errors(true));
if ($('errorLevelTabs')) {
  $('errorLevelTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    document.querySelectorAll('#errorLevelTabs .tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    errorLevel = btn.dataset.level || 'all';
    renderErrors();
  });
}
if ($('errorList')) {
  $('errorList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-error-delete]');
    if (del) { deleteErrorRows([del.dataset.errorDelete]); return; }
    const btn = e.target.closest('[data-error-index]');
    if (btn) showErrorDetail(parseInt(btn.dataset.errorIndex, 10));
  });
  $('errorList').addEventListener('change', (e) => {
    const box = e.target.closest('input[data-error-id]');
    if (!box) return;
    if (box.checked) errorSelected.add(box.dataset.errorId);
    else errorSelected.delete(box.dataset.errorId);
    syncErrorSelection();
  });
}
if ($('errorSelectAll')) {
  $('errorSelectAll').addEventListener('change', (e) => {
    const check = e.target.checked;
    $('errorList').querySelectorAll('input[data-error-id]').forEach(box => {
      box.checked = check;
      if (check) errorSelected.add(box.dataset.errorId);
      else errorSelected.delete(box.dataset.errorId);
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

$('sortTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('#sortTabs .tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  procSort = btn.dataset.sort;
  renderProcs();
});

$('histTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('#histTabs .tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  histLimit = parseInt(btn.dataset.limit, 10);
  hist();
});

let rawGitProjects = [];
let scanRootDir = '';

function fmtDateTime(ts) {
  if (!ts) return 'Never';
  const d = new Date(ts);
  return d.toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function updateBatchButton() {
  const checked = document.querySelectorAll('.git-check:checked');
  const count = checked.length;
  $('gitSelectedCount').textContent = count;
  $('gitBatchPull').style.display = count > 0 ? 'inline-flex' : 'none';

  document.querySelectorAll('.git-item').forEach(item => {
    const chk = item.querySelector('.repo-check');
    if (chk && chk.checked) {
      item.classList.add('selected');
    } else {
      item.classList.remove('selected');
    }
  });
}

function renderGitProjects() {
  const q = ($('gitSearch').value || '').trim().toLowerCase();
  const filtered = rawGitProjects.filter(r =>
    !q ||
    r.name.toLowerCase().includes(q) ||
    r.group.toLowerCase().includes(q) ||
    r.branch.toLowerCase().includes(q) ||
    r.hash.toLowerCase().includes(q) ||
    r.message.toLowerCase().includes(q)
  );

  $('gitCount').textContent = filtered.length;
  if (!filtered.length) {
    $('gitList').innerHTML = `<span style="color:var(--mut);font-size:12px">${rawGitProjects.length ? 'No repositories match filter' : 'No git repositories found'}</span>`;
    updateBatchButton();
    return;
  }

  const groups = {};
  for (const item of filtered) {
    const g = item.group || 'Projects';
    if (!groups[g]) groups[g] = [];
    groups[g].push(item);
  }

  $('gitList').innerHTML = Object.keys(groups).sort().map(grpName => {
    const items = groups[grpName];
    return `
      <div class="git-group" data-grp="${grpName}">
        <div class="git-group-head">
          <span class="git-group-title">
            <input type="checkbox" class="git-check group-check" title="Select all in ${grpName}" />
            ${grpName}
          </span>
          <span class="badge"><strong>${items.length}</strong> repos</span>
        </div>
        <div class="git-group-items">
          ${items.map(r => `
            <div class="git-item" id="item-${r.relPath.replace(/[^a-zA-Z0-9_-]/g, '_')}">
              <input type="checkbox" class="git-check repo-check" data-rel="${r.relPath}" />
              <div class="git-info">
                <div class="git-name">
                  <span>${r.name}</span>
                  <span class="pill ok">${r.branch}</span>
                  ${r.isDev ? '<span class="pill">DEV</span>' : ''}
                  ${r.dirty ? '<span class="pill down">modified</span>' : ''}
                </div>
                <div class="git-meta"><code>${r.hash}</code> · ${r.time} · ${r.message.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>
                <div class="git-last-pull">Last Update: <strong>${fmtDateTime(r.lastPull)}</strong></div>
              </div>
              <div class="pull-split">
                <button class="btn-pull" data-rel="${r.relPath}" title="git pull + migrate + optimize:clear">↻ Update</button>
                <button class="btn-pull-more" data-rel="${r.relPath}" title="More actions">▾</button>
                <div class="pull-menu">
                  ${r.isDev ? `<button class="act-dbsync" data-rel="${r.relPath}">Sync DB dari Project Lain…</button>` : ''}
                  <button class="act-seed" data-rel="${r.relPath}">Run Seeder…</button>
                  <button class="act-env" data-rel="${r.relPath}">Edit .env…</button>
                  <button class="act-composer" data-rel="${r.relPath}">Composer Update</button>
                  <button class="act-term" data-rel="${r.relPath}">Terminal…</button>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');

  updateBatchButton();
}

async function gitProjects() {
  try {
    const d = await j('/api/git/projects');
    rawGitProjects = d.projects || [];
    scanRootDir = d.scanRoot || '';
    renderGitProjects();
  } catch (e) {
    $('gitList').innerHTML = '<span style="color:var(--bad);font-size:12px">Failed loading git projects</span>';
  }
}

async function doPull(relPath, btn) {
  const safeId = 'item-' + relPath.replace(/[^a-zA-Z0-9_-]/g, '_');
  const card = document.getElementById(safeId);
  if (btn) { btn.disabled = true; btn.textContent = 'Updating...'; }
  if (card) { card.className = 'git-item pulling'; }

  try {
    const res = await fetch('/api/git/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relPath })
    });
    const d = await res.json();
    if (card) { card.className = 'git-item ' + (d.ok ? 'pull-ok' : 'pull-err'); }
    if (btn) {
      btn.textContent = d.ok ? '✓ Updated' : '✕ Error';
      setTimeout(() => { btn.disabled = false; btn.textContent = '↻ Update'; }, 3000);
    }
    return { relPath, ok: d.ok, output: d.output || d.error || 'Done' };
  } catch (err) {
    if (card) { card.className = 'git-item pull-err'; }
    if (btn) {
      btn.textContent = '✕ Error';
      setTimeout(() => { btn.disabled = false; btn.textContent = '↻ Update'; }, 3000);
    }
    return { relPath, ok: false, output: err.message };
  }
}

async function doBatchPull() {
  const checked = Array.from(document.querySelectorAll('.repo-check:checked'));
  if (!checked.length) return;

  const batchBtn = $('gitBatchPull');
  batchBtn.disabled = true;
  batchBtn.textContent = 'Updating Batch...';

  const results = [];
  for (let i = 0; i < checked.length; i++) {
    const chk = checked[i];
    const rel = chk.dataset.rel;
    batchBtn.textContent = `Updating (${i + 1}/${checked.length})...`;
    const card = chk.closest('.git-item');
    const btn = card ? card.querySelector('.btn-pull') : null;
    const r = await doPull(rel, btn);
    results.push(r);
  }

  batchBtn.disabled = false;
  batchBtn.textContent = `↻ Update Selected (${checked.length})`;

  // Display summary in modal
  const okCount = results.filter(r => r.ok).length;
  $('gitModalTitle').textContent = `Batch Update Completed: ${okCount}/${results.length} Succeeded`;
  $('gitModalBody').textContent = results.map(r => `[${r.ok ? 'OK' : 'ERR'}] ${r.relPath}\n${r.output}\n${'='.repeat(40)}`).join('\n\n');
  $('gitModalBody').className = 'modal-body ' + (okCount === results.length ? 'ok' : 'err');
  $('gitModal').classList.add('open');

  gitProjects();
}

function humanCron(expr) {
  const e = (expr || '').trim();
  if (e === '* * * * *') return 'Setiap menit';
  if (e === '*/2 * * * *') return 'Setiap 2 menit';
  if (e === '*/5 * * * *') return 'Setiap 5 menit';
  if (e === '*/10 * * * *') return 'Setiap 10 menit';
  if (e === '*/15 * * * *') return 'Setiap 15 menit';
  if (e === '*/30 * * * *') return 'Setiap 30 menit';
  if (e === '0 * * * *' || e === '@hourly') return 'Setiap jam (menit 00)';
  if (e === '0 0 * * *' || e === '@daily') return 'Setiap hari jam 00:00';
  if (e === '0 0 * * 0' || e === '@weekly') return 'Setiap Minggu jam 00:00';
  if (e === '0 0 1 * *' || e === '@monthly') return 'Setiap tanggal 1 jam 00:00';

  const m = e.match(/^(\d+|\*|\*\/\d+)\s+(\d+|\*|\*\/\d+)\s+(\*|\d+)\s+(\*|\d+)\s+(\*|\d+)$/);
  if (m) {
    const [, min, hr, dom, mon, dow] = m;
    if (dom === '*' && mon === '*' && dow === '*') {
      if (!isNaN(min) && !isNaN(hr)) return `Setiap hari jam ${hr.padStart(2, '0')}:${min.padStart(2, '0')}`;
      if (min.startsWith('*/') && hr === '*') return `Setiap ${min.slice(2)} menit`;
    }
  }
  return e;
}

let activeEditCron = null;

function openEditCron(user, schedule, cmd, source) {
  activeEditCron = { user, schedule, cmd, source };
  $('cronModalTitle').textContent = `Edit Cron (${user})`;
  $('cronEditCmd').textContent = cmd;

  const preset = $('cronPreset');
  const found = Array.from(preset.options).some(o => o.value === schedule);
  if (found) {
    preset.value = schedule;
    $('cronCustomWrap').style.display = 'none';
  } else {
    preset.value = 'custom';
    $('cronCustom').value = schedule;
    $('cronCustomWrap').style.display = 'block';
  }
  updateCronPreview();
  $('cronModal').classList.add('open');
}

function updateCronPreview() {
  const p = $('cronPreset').value;
  const expr = p === 'custom' ? $('cronCustom').value.trim() : p;
  $('cronLivePreview').textContent = `${expr} (${humanCron(expr)})`;
}

$('cronPreset').addEventListener('change', () => {
  $('cronCustomWrap').style.display = $('cronPreset').value === 'custom' ? 'block' : 'none';
  updateCronPreview();
});
$('cronCustom').addEventListener('input', updateCronPreview);
$('cronModalClose').addEventListener('click', () => $('cronModal').classList.remove('open'));
$('cronModalCancel').addEventListener('click', () => $('cronModal').classList.remove('open'));

$('cronModalSave').addEventListener('click', async () => {
  if (!activeEditCron) return;
  const p = $('cronPreset').value;
  const newSched = p === 'custom' ? $('cronCustom').value.trim() : p;
  if (!newSched) return alert('Schedule tidak boleh kosong');

  const btn = $('cronModalSave');
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';

  try {
    const res = await fetch('/api/workers/cron', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: activeEditCron.user,
        oldSchedule: activeEditCron.schedule,
        newSchedule: newSched,
        cmd: activeEditCron.cmd,
        source: activeEditCron.source
      })
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'Gagal mengubah cron');
    $('cronModal').classList.remove('open');
    workers();
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan Schedule';
  }
});
let workerFilter = 'all';

function renderSupervisorList() {
  const q = ($('workerSearch').value || '').trim().toLowerCase();
  const filtered = rawSupProcs.filter(p => {
    const ok = /RUNNING/i.test(p.state);
    if (workerFilter === 'running' && !ok) return false;
    if (workerFilter === 'down' && ok) return false;
    if (!q) return true;
    return (p.name || '').toLowerCase().includes(q) || (p.detail || '').toLowerCase().includes(q);
  });

  $('supCount').textContent = `${filtered.length}/${rawSupProcs.length}`;
  if (!filtered.length) {
    $('supList').innerHTML = `<span style="color:var(--mut);font-size:12px">${rawSupProcs.length ? 'No workers match filter' : 'No supervisor workers found'}</span>`;
    return;
  }

  $('supList').innerHTML = filtered.map(p => {
    const ok = /RUNNING/i.test(p.state);
    const esc = (p.name || '').replace(/"/g, '&quot;');
    
    // Clean name if formatted group:name
    let displayName = p.name;
    const parts = p.name.split(':');
    if (parts.length === 2 && parts[0] === parts[1]) {
      displayName = parts[0];
    }

    // Parse detail: pid X, uptime Y
    let pid = null;
    let uptime = null;
    if (p.detail) {
      const pm = p.detail.match(/pid\s+(\d+)/i);
      if (pm) pid = pm[1];
      const um = p.detail.match(/uptime\s+([^\,]+)/i);
      if (um) uptime = um[1].trim();
    }

    return `<div class="worker-card ${!ok ? 'is-down' : ''}">
      <div class="worker-head">
        <div class="worker-title-box">
          <div class="worker-title" title="${esc}">${displayName}</div>
          <div class="worker-meta">
            ${pid ? `<code>PID ${pid}</code>` : ''}
            ${uptime ? `<span>up ${uptime}</span>` : ''}
            ${!pid && !uptime && p.detail ? `<span>${p.detail.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>` : ''}
          </div>
        </div>
        <span class="pill ${ok ? 'ok' : 'down'}">${p.state || 'UNKNOWN'}</span>
      </div>
      <div class="worker-actions">
        ${p.logfile ? `<button class="btn-sm" data-log="${p.logfile.replace(/"/g, '&quot;')}">Log</button>` : ''}
        <button class="btn-sm ok" data-sup="restart" data-name="${esc}">Restart</button>
        ${ok
          ? `<button class="btn-sm danger" data-sup="stop" data-name="${esc}">Stop</button>`
          : `<button class="btn-sm ok" data-sup="start" data-name="${esc}">Start</button>`
        }
      </div>
    </div>`;
  }).join('');
}

async function workers() {
  try {
    const d = await j('/api/workers');
    const sup = d.supervisor || { available: false, procs: [] };
    const cron = d.cron || { jobs: [], schedProcs: [] };
    const logs = d.laravelLogs || [];

    rawSupProcs = sup.procs || [];
    const running = rawSupProcs.filter(p => /RUNNING/i.test(p.state)).length;
    $('workerBadge').innerHTML = sup.available
      ? `<strong>${running}/${rawSupProcs.length}</strong> running`
      : `<strong>no supervisor</strong>`;

    renderSupervisorList();

    // Cron jobs
    if (!cron.jobs.length) {
      $('cronList').innerHTML = '<tr><td colspan="5" style="color:var(--mut)">No cron jobs found</td></tr>';
    } else {
      $('cronList').innerHTML = cron.jobs.map(c => {
        const tr = humanCron(c.schedule);
        const escUser = (c.user || '').replace(/"/g, '&quot;');
        const escSched = (c.schedule || '').replace(/"/g, '&quot;');
        const escCmd = (c.cmd || '').replace(/"/g, '&quot;');
        const escSrc = (c.source || '').replace(/"/g, '&quot;');
        const isSystem = (c.source || '').startsWith('system:');
        return `<tr>
          <td><strong>${c.user}</strong>${isSystem ? `<div style="font-size:10px;color:var(--mut)">${c.source}</div>` : ''}</td>
          <td><code>${c.schedule}</code></td>
          <td style="color:var(--ac);font-weight:500">${tr}</td>
          <td><code class="cmd-code" title="${escCmd}">${c.cmd.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></td>
          <td style="text-align:right;white-space:nowrap">
            ${schedDir(c.cmd) ? `<button class="btn-sm" data-sched-tasks="${schedDir(c.cmd).replace(/"/g, '&quot;')}" title="Lihat task yang dijalankan schedule:run">☰ Tasks</button> ` : ''}
            ${isSystem
              ? `<span style="font-size:11px;color:var(--mut)" title="System cron hanya bisa diedit via SSH sebagai root">🔒 system</span>`
              : `<button class="btn-sm" data-edit-cron="1" data-user="${escUser}" data-sched="${escSched}" data-cmd="${escCmd}" data-source="${escSrc}">✎ Edit</button>`}
          </td>
        </tr>`;
      }).join('');
    }

    // Laravel logs select
    const sel = $('laravelLogSelect');
    const cur = sel.value;
    sel.innerHTML = '<option value="">Pilih file log...</option>' + logs.map(f => `<option value="${f}">${f}</option>`).join('');
    if (cur && logs.includes(cur)) sel.value = cur;
  } catch (e) {
    $('supList').innerHTML = '<span style="color:var(--bad);font-size:12px">Failed loading workers</span>';
  }
}

async function supAction(action, name, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try {
    const res = await fetch('/api/workers/supervisor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, name })
    });
    const d = await res.json();
    $('gitModalTitle').textContent = `supervisorctl ${action} ${name}`;
    $('gitModalBody').textContent = d.output || d.error || 'Done';
    $('gitModalBody').className = 'modal-body ' + (d.ok ? 'ok' : 'err');
    $('gitModal').classList.add('open');
    workers();
  } catch (err) {
    $('gitModalTitle').textContent = `supervisorctl ${action} ${name}`;
    $('gitModalBody').textContent = err.message;
    $('gitModalBody').className = 'modal-body err';
    $('gitModal').classList.add('open');
  }
  if (btn) { btn.disabled = false; btn.textContent = action[0].toUpperCase() + action.slice(1); }
}

async function serviceRestart(unit, btn) {
  if (!confirm(`Restart ${unit} service?`)) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Restarting...'; }
  try {
    const res = await fetch('/api/workers/service', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unit })
    });
    const d = await res.json();
    $('gitModalTitle').textContent = `systemctl restart ${unit}`;
    $('gitModalBody').textContent = d.output || d.error || 'Done';
    $('gitModalBody').className = 'modal-body ' + (d.ok ? 'ok' : 'err');
    $('gitModal').classList.add('open');
    workers(); svc();
  } catch (err) {
    $('gitModalTitle').textContent = `systemctl restart ${unit}`;
    $('gitModalBody').textContent = err.message;
    $('gitModalBody').className = 'modal-body err';
    $('gitModal').classList.add('open');
  }
  if (btn) { btn.disabled = false; btn.textContent = unit === 'cron' ? '↻ Restart Cron Service' : '↻ Restart Supervisor Daemon'; }
}

async function viewLog(file) {
  if (!file) return;
  $('gitModalTitle').textContent = `tail: ${file}`;
  $('gitModalBody').textContent = 'Loading...';
  $('gitModalBody').className = 'modal-body';
  $('gitModal').classList.add('open');
  try {
    const d = await j(`/api/workers/log?file=${encodeURIComponent(file)}&lines=100`);
    $('gitModalBody').textContent = d.output || '(empty)';
  } catch (e) {
    const r = await fetch(`/api/workers/log?file=${encodeURIComponent(file)}&lines=100`);
    const d = await r.json().catch(() => ({}));
    $('gitModalBody').textContent = d.error || 'Failed loading log';
    $('gitModalBody').className = 'modal-body err';
  }
}

$('workerRefresh').addEventListener('click', workers);
$('workerSearch').addEventListener('input', renderSupervisorList);

$('workerFilterTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('#workerFilterTabs .tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  workerFilter = btn.dataset.filter;
  renderSupervisorList();
});
$('btnRestartCron').addEventListener('click', (e) => serviceRestart('cron', e.target));
$('btnRestartSup').addEventListener('click', (e) => serviceRestart('supervisor', e.target));
$('btnViewSelectedLog').addEventListener('click', () => viewLog($('laravelLogSelect').value));
$('supList').addEventListener('click', (e) => {
  const log = e.target.closest('[data-log]');
  if (log) { viewLog(log.dataset.log); return; }
  const b = e.target.closest('[data-sup]');
  if (b) supAction(b.dataset.sup, b.dataset.name, b);
});
function schedDir(cmd) {
  const m = String(cmd || '').match(/cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*&&.*artisan\s+schedule:run/);
  return m ? (m[1] || m[2] || m[3]) : '';
}
function openModalText(title, text, ok) {
  $('gitModalTitle').textContent = title;
  $('gitModalBody').textContent = text;
  $('gitModalBody').className = 'modal-body' + (ok === false ? ' err' : '');
  $('gitModal').classList.add('open');
}
async function showSchedTasks(dir) {
  openModalText('schedule:list — ' + dir, 'Loading...');
  try {
    const d = await j('/api/workers/schedule?dir=' + encodeURIComponent(dir));
    if (!d.ok) return openModalText('schedule:list — ' + dir, d.error || d.raw || 'Failed', false);
    openModalText('schedule:list — ' + dir, d.tasks.length
      ? d.tasks.map(t => `${t.expr.padEnd(16)} ${t.cmd}\n${' '.repeat(17)}next: ${t.next}`).join('\n')
      : (d.raw || '(no scheduled tasks)'));
  } catch (e) { openModalText('schedule:list — ' + dir, e.message, false); }
}
async function scanAllSched(btn) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = 'Scanning...';
  openModalText('Scheduled tasks — semua app', 'Scanning... (bisa 10-60 detik, booting tiap app Laravel)');
  try {
    const d = await j('/api/workers/schedule?all=1');
    const rows = [];
    const failed = [];
    for (const a of d.apps) {
      if (!a.ok) { failed.push(`${a.name}: ${a.error}`); continue; }
      for (const t of a.tasks) rows.push({ app: a.name, ...t });
    }
    // task yang bukan "* * * * *" dulu — itu yang biasanya penyebab spike periodik
    const isMin = (t) => t.expr.trim() === '* * * * *';
    rows.sort((x, y) => (isMin(x) - isMin(y)) || x.expr.localeCompare(y.expr) || x.app.localeCompare(y.app));
    const w = Math.max(10, ...rows.map(r => r.app.length));
    let out = `${rows.length} task di ${d.apps.length} app\n\n` +
      rows.map(r => `${r.expr.padEnd(16)} ${r.app.padEnd(w)}  ${r.cmd}`).join('\n');
    if (failed.length) out += '\n\n--- gagal ---\n' + failed.join('\n');
    openModalText('Scheduled tasks — semua app', out);
  } catch (e) { openModalText('Scheduled tasks — semua app', e.message, false); }
  btn.disabled = false; btn.textContent = old;
}
$('btnScanSched').addEventListener('click', (e) => scanAllSched(e.target));
$('cronList').addEventListener('click', (e) => {
  const t = e.target.closest('[data-sched-tasks]');
  if (t) { showSchedTasks(t.dataset.schedTasks); return; }
  const b = e.target.closest('[data-edit-cron]');
  if (b) openEditCron(b.dataset.user, b.dataset.sched, b.dataset.cmd, b.dataset.source);
});
function depFrameworkToggle() {
  const fw = $('depFramework').value;
  const wp = fw === 'wordpress' || fw === 'wordpress-theme';
  $('depWpOnly').style.display = wp ? '' : 'none';
  $('depThemeOnly').style.display = fw === 'wordpress-theme' ? '' : 'none';
  // Field Laravel-only disembunyikan untuk kedua mode WordPress
  for (const id of ['depAppNameWrap', 'depAppKeyWrap', 'depEnvExtraWrap', 'depMailWrap', 'depQueueWrap', 'depRepoWrap', 'depBranchWrap']) {
    const el = $(id);
    if (!el) continue;
    // repo+branch site tidak dipakai di mode theme (core fresh + theme repo)
    if (id === 'depRepoWrap' || id === 'depBranchWrap') { el.style.display = fw === 'wordpress-theme' ? 'none' : ''; continue; }
    el.style.display = wp ? 'none' : '';
  }
  const sched = $('depSched');
  if (sched) sched.nextSibling.textContent = wp ? ' WP-Cron (cron www-data tiap 5 mnt)' : ' Scheduler (cron www-data)';
}
$('depFramework').addEventListener('change', depFrameworkToggle);
$('depWpShow').addEventListener('click', () => {
  const el = $('depWpPass');
  el.type = el.type === 'password' ? 'text' : 'password';
});
$('depWpGen').addEventListener('click', () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%-_?';
  const buf = new Uint32Array(12);
  crypto.getRandomValues(buf);
  $('depWpPass').value = Array.from(buf, x => chars[x % chars.length]).join('');
});
$('depDryRun').addEventListener('click', () => depSubmit(true));
// Auto-fill berantai: repo -> folder -> dbName/dbUser. Field yang sudah diketik manual tidak dioverride.
const depAuto = { folder: true, dbName: true, dbUser: true };
for (const [id, key] of [['depDir', 'folder'], ['depDbName', 'dbName'], ['depDbUser', 'dbUser']]) {
  $(id).addEventListener('input', () => { depAuto[key] = false; });
}
function depRepoName() {
  const m = $('depRepo').value.trim().match(/[:/]([^/:]+?)(\.git)?$/);
  return m ? m[1] : '';
}
$('depRepo').addEventListener('input', () => {
  const name = depRepoName();
  if (name && depAuto.folder && !$('depDir').value) { $('depDir').value = name; depCascadeFolder(); }
});
let depThemeAuto = true;
$('depThemeFolder').addEventListener('input', () => { depThemeAuto = false; });
$('depThemeRepo').addEventListener('input', () => {
  const m = $('depThemeRepo').value.trim().match(/[:/]([^/:]+?)(\.git)?$/);
  if (m && m[1] && depThemeAuto && !$('depThemeFolder').value) $('depThemeFolder').value = m[1];
});
function depCascadeFolder() {
  const f = $('depDir').value.trim();
  if (!f) return;
  if (depAuto.dbName && !$('depDbName').value) $('depDbName').value = `${f}_db`;
  if (depAuto.dbUser && !$('depDbUser').value) $('depDbUser').value = `${f}_user_sql`;
}
$('depDir').addEventListener('input', depCascadeFolder);
$('depShowPass').addEventListener('click', () => {
  const el = $('depDbPass');
  el.type = el.type === 'password' ? 'text' : 'password';
});
$('depMailShow').addEventListener('click', () => {
  const el = $('depMailPass');
  el.type = el.type === 'password' ? 'text' : 'password';
});
$('depCopyPass').addEventListener('click', async () => {
  const v = $('depDbPass').value;
  if (!v) return alert('Password masih kosong');
  try { await navigator.clipboard.writeText(v); alert('Password tercopy'); }
  catch { $('depDbPass').select(); document.execCommand('copy'); alert('Password tercopy'); }
});
$('depGenPass').addEventListener('click', () => {
  // 16 karakter, DIJAMIN lolos policy MySQL MEDIUM: atas+kecil+angka+spesial, tanpa yang bermasalah di shell/SQL.
  const up = 'ABCDEFGHJKLMNPQRSTUVWXYZ', lo = 'abcdefghijkmnopqrstuvwxyz', dg = '23456789', sp = '!@#%-_?';
  const all = up + lo + dg + sp;
  const buf = new Uint32Array(16);
  crypto.getRandomValues(buf);
  const pick = (s, i) => s[buf[i] % s.length];
  const arr = [pick(up, 0), pick(lo, 1), pick(dg, 2), pick(sp, 3)];
  for (let i = 4; i < 16; i++) arr.push(pick(all, i));
  for (let i = arr.length - 1; i > 0; i--) { const j = buf[i] % (i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  $('depDbPass').value = arr.join('');
});
$('depStart').addEventListener('click', () => depSubmit(false));
$('deployJobsRefresh').addEventListener('click', () => deployJobsRefresh(false));
$('depJobs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-depjob]');
  if (b) depShow(b.dataset.depjob);
});
$('xStart').addEventListener('click', xferSubmit);
$('xCancel').addEventListener('click', async () => {
  if (!xferActiveId) return;
  if (!confirm('Cancel transfer ini?')) return;
  try {
    await api('POST', '/api/deploy/transfer/cancel', { id: xferActiveId });
    clearTimeout(xferPollTimer);
    $('xCancel').style.display = 'none';
    xferPoll();
  } catch (e) { alert('Error: ' + e.message); }
});
$('storageRefresh').addEventListener('click', () => storage(true));

// Sidebar Drawer & View Router (#/overview, #/storage, #/workers, #/git, #/processes)
const toggleSidebar = (open) => {
  const sb = $('sidebar');
  const ov = $('sidebarOverlay');
  const show = typeof open === 'boolean' ? open : !sb.classList.contains('open');
  sb.classList.toggle('open', show);
  ov.classList.toggle('open', show);
};

const VALID_VIEWS = ['overview', 'storage', 'workers', 'git', 'processes', 'backups', 'files', 'users', 'activity', 'deploy', 'sites', 'errors'];

function currentView() {
  const h = (location.hash || '').replace(/^#\/?/, '').split('?')[0].trim().toLowerCase();
  return VALID_VIEWS.includes(h) ? h : 'overview';
}

function navigateView(name, refresh = true) {
  const view = VALID_VIEWS.includes(name) ? name : 'overview';
  document.querySelectorAll('.view-pane').forEach(p => p.classList.remove('active'));
  const pane = $('view-' + view);
  if (pane) pane.classList.add('active');

  document.querySelectorAll('.sidebar .nav-link').forEach(l => {
    l.classList.toggle('active', l.dataset.view === view);
  });

  window.scrollTo({ top: 0, behavior: 'instant' });

  if (refresh) {
    trackActivity('view', view);
    if (view === 'overview') {
      stats(); svc(); hist();
      setTimeout(() => { try { if (typeof chart !== 'undefined' && chart) chart.resize(); } catch {} }, 80);
    }
    if (view === 'storage') storage();
    if (view === 'workers') workers();
    if (view === 'git') gitProjects();
    if (view === 'processes') { procs(); mysqlQueries(); }
    if (view === 'errors') errors();
    if (view === 'backups') backups();
    if (view === 'files') loadFs(fsCurrentPath);
    if (view === 'users') users();
    if (view === 'activity') { activity(); activityAutoToggle(); }
    if (view === 'deploy') { deployJobsRefresh(); undLoadTargets(); }
    if (view === 'sites') sites();
  }
}

window.addEventListener('hashchange', () => navigateView(currentView()));

$('vpsMonitorBtn').addEventListener('click', () => toggleSidebar());
$('sidebarClose').addEventListener('click', () => toggleSidebar(false));
$('sidebarOverlay').addEventListener('click', () => toggleSidebar(false));

// Ctrl/Cmd+F -> fokus ke kolom filter di halaman aktif (atau di modal yang sedang terbuka).
// Bila kolom filter sudah fokus, tekan lagi akan membuka pencarian bawaan browser.
// Halaman tanpa kolom filter (Overview, Storage, Users) langsung memakai pencarian browser.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return;
  const visible = (el) => el.getClientRects().length > 0;
  const inputs = [...document.querySelectorAll('input[type="search"]')].filter(visible);
  const modal = inputs.find(el => el.closest('.modal, .modal-backdrop, [role="dialog"], dialog'));
  const pane = document.querySelector('.view-pane.active');
  const target = modal || (pane && inputs.find(el => pane.contains(el)));
  if (!target || document.activeElement === target) return;
  e.preventDefault();
  target.focus();
  target.select();
});

document.querySelectorAll('.sidebar .nav-link').forEach(link => {
  link.addEventListener('click', () => {
    toggleSidebar(false);
  });
});

// ---- Auto Deploy ----
let depActiveId = null;
let depPollTimer = null;
let xferActiveId = null;
let xferPollTimer = null;

function depForm() {
  return {
    dir: $('depDir').value.trim(), repo: $('depRepo').value.trim(), branch: $('depBranch').value.trim() || 'main',
    domain: $('depDomain').value.trim(), deployer: $('depDeployer').value.trim(),
    framework: $('depFramework').value,
    themeRepo: $('depThemeRepo').value.trim(), themeFolder: $('depThemeFolder').value.trim(),
    themeBranch: $('depThemeBranch').value.trim() || 'main',
    projectType: $('depType').value, dbName: $('depDbName').value.trim(), dbUser: $('depDbUser').value.trim(),
    dbPass: $('depDbPass').value, sqlPath: $('depSqlPath').value.trim(),
    appName: $('depAppName').value.trim(), appKey: $('depAppKey').value.trim(),
    tablePrefix: $('depWpPrefix').value.trim(), wpTitle: $('depWpTitle').value.trim(),
    wpAdminUser: $('depWpUser').value.trim(), wpAdminEmail: $('depWpEmail').value.trim(), wpAdminPass: $('depWpPass').value,
    envExtra: $('depEnvExtra').value, useQueue: $('depQueue').checked, useScheduler: $('depSched').checked,
    mail: {
      mailer: $('depMailMailer').value, scheme: $('depMailScheme').value.trim(),
      host: $('depMailHost').value.trim(), port: $('depMailPort').value.trim(),
      username: $('depMailUser').value, password: $('depMailPass').value,
      fromAddress: $('depMailFrom').value.trim(), fromName: $('depMailFromName').value.trim(),
    },
  };
}
function depStepPill(s) {
  const cls = s.status === 'ok' ? 'ok' : (s.status === 'fail' ? 'down' : '');
  const icon = s.status === 'ok' ? '✓ ' : (s.status === 'fail' ? '✕ ' : (s.status === 'running' ? '… ' : (s.status === 'skip' ? '− ' : (s.status === 'warn' ? '! ' : ''))));
  return `<span class="pill ${cls}" title="${(s.output || '').replace(/"/g, '&quot;').slice(-500)}">${icon}${s.name}</span>`;
}
async function depShow(id) {
  depActiveId = id;
  try {
    const d = await api('GET', `/api/deploy/status?id=${encodeURIComponent(id)}`);
    $('deployJobsCount').textContent = d.steps.length;
    $('depSteps').innerHTML = d.steps.map(depStepPill).join('') || '<span style="color:var(--mut);font-size:12px">Menunggu...</span>';
    const last = [...d.steps].reverse().find(s => s.output) || d.steps[d.steps.length - 1];
    $('depOutput').textContent = `[${d.id}] status=${d.status}${d.warn ? ' WARN: ' + d.warn : ''}\n\n` + (last && last.output ? `--- ${last.name} ---\n${last.output}` : '(belum ada output)');
    const running = ['running', 'running-transfer'].includes(d.status);
    if (running && !depPollTimer) depPollTimer = setInterval(() => { if (depActiveId) depShow(depActiveId); else clearInterval(depPollTimer); }, 3000);
    if (!running && depPollTimer) { clearInterval(depPollTimer); depPollTimer = null; }
    deployJobsRefresh(true);
  } catch (e) { $('depOutput').textContent = 'Error: ' + e.message; }
}
async function deployJobsRefresh(silent) {
  try {
    const d = await api('GET', '/api/deploy/jobs');
    $('deployJobsCount').textContent = d.jobs.length;
    $('depJobs').innerHTML = d.jobs.length ? d.jobs.map(j =>
      `<button class="btn-sm${j.id === depActiveId ? ' ok' : ''}" data-depjob="${j.id}">${j.type === 'transfer' ? '⇄' : (j.type === 'undeploy' ? '🗑' : '🚀')} ${j.label} — ${j.status}</button>`
    ).join('') : '<span style="color:var(--mut);font-size:12px">Belum ada job.</span>';
    // setelah reload halaman: sambung lagi ke transfer yang masih jalan supaya tombol tetap terkunci
    const live = d.jobs.find(j => j.type === 'transfer' && (j.status === 'running' || j.status === 'running-transfer'));
    if (live && !xferActiveId) { xferActiveId = live.id; xferPoll(); }
  } catch (e) { if (!silent) alert('Error: ' + e.message); }
}
async function depSubmit(dryRun) {
  const body = { ...depForm(), dryRun };
  const isThemeForm = body.framework === 'wordpress-theme';
  // repo site tidak dipakai di mode theme (core fresh), jadi tidak wajib diisi
  if (!body.dir || (!isThemeForm && !body.repo) || !body.domain || !body.deployer || !body.dbName || !body.dbUser || !body.dbPass) return alert('Isi semua field bertanda *');
  if (body.projectType === 'existing' && !body.sqlPath) return alert('Project existing wajib isi path SQL di server');
  const isWpForm = body.framework === 'wordpress' || body.framework === 'wordpress-theme';
  if (isWpForm && body.projectType === 'new' && (!body.wpTitle || !body.wpAdminUser || !body.wpAdminEmail || !body.wpAdminPass)) return alert('WordPress baru wajib isi site title + admin user/email/password');
  if (body.framework === 'wordpress-theme' && (!body.themeRepo || !body.themeFolder)) return alert('Mode theme wajib isi theme repo + folder');
  if (!confirm(dryRun ? 'Jalankan dry-run check (tanpa perubahan)?' : `Mulai deploy ${body.dir} (${body.domain})? Proses makan waktu beberapa menit.`)) return;
  try {
    const r = await api('POST', '/api/deploy', body);
    depShow(r.id);
  } catch (e) { alert('Error: ' + e.message); }
}
let xferSubmitting = false;
function setXferBusy(on) {
  const b = $('xStart');
  b.disabled = on;
  b.classList.toggle('busy', on);
  b.innerHTML = on ? '<span class="xfer-spin"></span> Transfer berjalan…' : '⇄ Start Transfer';
  $('xForm').disabled = on;
  $('xBar').style.display = on ? '' : 'none';
}
async function xferSubmit() {
  if (xferSubmitting || $('xStart').disabled) return;
  const body = {
    project: $('xProject').value.trim(), host: $('xHost').value.trim(), port: $('xPort').value.trim() || '22',
    user: $('xUser').value.trim(), authType: $('xAuth').value, password: $('xPassword').value, src: $('xSrc').value.trim(),
  };
  if (!body.project || !body.host || !body.user || !body.src) return alert('Isi project, host, user, source path');
  if (body.authType === 'password' && !body.password) return alert('Isi password SSH');
  xferSubmitting = true;
  try {
    if (!confirm(`Start transfer ke ${body.project}/storage/app/public dari ${body.user}@${body.host}?`)) return;
    setXferBusy(true);
    const r = await api('POST', '/api/deploy/transfer', body);
    $('xPassword').value = '';
    xferActiveId = r.id;
    $('xCancel').style.display = '';
    xferPoll();
  } catch (e) { setXferBusy(false); alert('Error: ' + e.message); }
  finally { xferSubmitting = false; }
}
async function xferPoll() {
  if (!xferActiveId) return;
  try {
    const d = await api('GET', `/api/deploy/transfer/status?id=${encodeURIComponent(xferActiveId)}`);
    const t = d.transfer || {};
    $('xStatus').innerHTML = `Transfer <strong>${t.name || ''}</strong>: ` +
      (t.exitCode !== null && t.exitCode !== undefined ? (t.exitCode === 0 ? '<strong style="color:var(--ok)">SELESAI OK</strong>' : `<strong style="color:var(--bad)">GAGAL (exit ${t.exitCode})</strong>`) : (t.running ? '<strong>BERJALAN…</strong> (biarkan, bisa lama untuk folder besar)' : `status job: ${d.status}`));
    $('xLog').textContent = t.logTail || (t.name ? '(belum ada log)' : '(menyiapkan: validasi, cek koneksi, install sshpass jika perlu…)');
    const active = d.status === 'running' || d.status === 'running-transfer';
    const finished = t.exitCode !== null && t.exitCode !== undefined;
    if (active && !finished) {
      setXferBusy(true);
      $('xCancel').style.display = '';
      clearTimeout(xferPollTimer);
      xferPollTimer = setTimeout(xferPoll, active && !t.name ? 2000 : 5000);
    } else {
      setXferBusy(false);
      $('xCancel').style.display = 'none';
    }
    deployJobsRefresh(true);
  } catch (e) { $('xStatus').textContent = 'Error: ' + e.message; }
}

// ---- Un-deploy ----
let undTargets = [];
let undActiveId = null;
let undPollTimer = null;

function undRenderInfo() {
  const t = undTargets.find((x) => x.dir === $('undTarget').value);
  const db = t && t.db;
  const dbShared = !!(db && db.sharedWith && db.sharedWith.length);
  const userShared = !!(db && db.userSharedWith && db.userSharedWith.length);
  const dbLocal = !!(db && db.local !== false);
  $('undDropDb').disabled = !db || dbShared || !dbLocal;
  $('undDropDbUser').disabled = !db || !db.user || dbShared || userShared || !dbLocal;
  $('undRemoveSsl').disabled = !t || !t.ssl;
  if (!db || dbShared || !dbLocal) $('undDropDb').checked = false;
  if (!db || !db.user || dbShared || userShared || !dbLocal) $('undDropDbUser').checked = false;
  if (!t || !t.ssl) $('undRemoveSsl').checked = false;
  $('undDbLabel').textContent = db
    ? `(${db.name}${db.user ? ' / ' + db.user : ''}${dbShared ? ' — dipakai juga oleh ' + db.sharedWith.join(', ') : ''}${!dbLocal ? ' — host/port bukan MySQL lokal' : ''})`
    : '';
  $('undDbUserLabel').textContent = db && db.user
    ? `(${db.user}${userShared ? ' — dipakai juga oleh ' + db.userSharedWith.join(', ') : ''})`
    : '';
  if (!t) {
    $('undDropDb').checked = false;
    $('undDropDbUser').checked = false;
    $('undRemoveSsl').checked = false;
    $('undInfo').textContent = 'Pilih project...';
    $('undStart').disabled = true;
    return;
  }
  const domains = t.domains.length
    ? t.domains.map(escHtml).join(', ')
    : '<span style="color:var(--warn)">(tanpa vhost nginx)</span>';
  const dbTxt = db
    ? `${escHtml(db.name)}${db.user ? ' / ' + escHtml(db.user) : ''} <span style="opacity:.7">(${escHtml(db.source)}${db.host ? ', host ' + escHtml(db.host) : ''})</span>` +
      (dbShared ? ` <span style="color:var(--warn)">— DB dipakai juga oleh ${escHtml(db.sharedWith.join(', '))}</span>` : '') +
      (userShared ? ` <span style="color:var(--warn)">— user dipakai juga oleh ${escHtml(db.userSharedWith.join(', '))}</span>` : '') +
      (!dbLocal ? ' <span style="color:var(--warn)">— host/port bukan MySQL lokal, drop DB dinonaktifkan</span>' : '')
    : '<span style="color:var(--warn)">tidak terdeteksi</span>';
  $('undInfo').innerHTML = `<div><strong>${escHtml(t.dir)}</strong> · ${escHtml(t.framework)}${t.git ? ' · git repo' : ''}</div>
    <div style="font-family:var(--font-mono);font-size:11px;margin-top:3px">${escHtml(t.path)}</div>
    <div style="margin-top:4px">Domain: ${domains}</div>
    <div style="margin-top:4px">Database: ${dbTxt}</div>`;
  $('undStart').disabled = false;
}

async function undLoadTargets() {
  try {
    const d = await api('GET', '/api/undeploy/targets');
    undTargets = d.targets || [];
    const prev = $('undTarget').value;
    $('undTarget').innerHTML = undTargets.length
      ? '<option value="">— pilih project —</option>' + undTargets.map((t) => {
          const dm = t.domains.length ? ' — ' + t.domains.join(', ') : '';
          const db = t.db ? ' — DB ' + t.db.name : '';
          return `<option value="${escHtml(t.dir)}">${escHtml(t.dir + dm + db)}</option>`;
        }).join('')
      : '<option value="">Tidak ada project terdeteksi</option>';
    if (undTargets.some((t) => t.dir === prev)) $('undTarget').value = prev;
    undRenderInfo();
  } catch (e) {
    undTargets = [];
    $('undTarget').innerHTML = '<option value="">Gagal memuat project</option>';
    $('undInfo').textContent = 'Error: ' + e.message;
    $('undStart').disabled = true;
  }
}

async function openUndeployForSite(siteId) {
  const s = rawSites.find((x) => x.id === siteId);
  if (!s) return;
  if (!s.root) return alert('Site ini tidak punya root folder, jadi tidak ada project yang bisa di-undeploy.');
  // Tampilkan view dulu tanpa refresh, pilih target, baru ubah hash. Kalau hash diubah
  // lebih awal, hashchange bisa memuat ulang daftar dan menghapus pilihan yang baru diset.
  navigateView('deploy', false);
  await undLoadTargets();
  // Hanya root project itu sendiri (WordPress) atau <project>/public (Laravel).
  // Jangan pakai startsWith: root /var/www/group/subproject bukan milik target /var/www/group.
  const root = s.root.replace(/\/+$/, '');
  const t = undTargets.find((x) => root === x.path || root === x.path + '/public');
  if (!t) return alert(`Project untuk ${s.root} tidak terdeteksi sebagai folder project langsung di server.`);
  $('undTarget').value = t.dir;
  undRenderInfo();
  if (location.hash !== '#/deploy') location.hash = '#/deploy';
  $('undeployCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => $('undConfirm').focus(), 250);
}

async function undSubmit() {
  const t = undTargets.find((x) => x.dir === $('undTarget').value);
  if (!t) return alert('Pilih project yang akan di-undeploy');
  const confirmName = $('undConfirm').value.trim();
  if (confirmName !== t.dir) return alert(`Ketik nama folder persis: ${t.dir}`);
  if (!$('undPassword').value) return alert('Password akun wajib diisi');
  const dropDb = $('undDropDb').checked && !$('undDropDb').disabled && t.db && t.db.local !== false;
  const dropDbUser = dropDb && $('undDropDbUser').checked && !$('undDropDbUser').disabled;
  const removeSsl = $('undRemoveSsl').checked && !$('undRemoveSsl').disabled;
  const lines = [
    `UN-DEPLOY ${t.dir}`,
    '',
    `Folder  : ${t.path} (termasuk .git)`,
    `Nginx   : ${t.domains.join(', ') || '(tidak ada vhost)'}`,
    'Worker  : supervisor + cron project dihapus',
    dropDb ? `Database: ${t.db.name} (backup otomatis dulu)` : 'Database: dibiarkan',
    dropDbUser ? `DB user : ${t.db.user}` : 'DB user : dibiarkan',
    removeSsl ? `SSL     : ${t.domains.join(', ') || '(tidak ada)'}` : 'SSL     : dibiarkan',
    '',
    'Tindakan ini TIDAK BISA DIBATALKAN. Lanjutkan?',
  ];
  if (!confirm(lines.join('\n'))) return;
  const btn = $('undStart');
  btn.disabled = true;
  $('undStatus').textContent = 'Memulai un-deploy...';
  $('undOutput').textContent = '';
  $('undSteps').innerHTML = '';
  try {
    const r = await api('POST', '/api/undeploy', {
      dir: t.dir, confirm: confirmName, password: $('undPassword').value,
      dbName: dropDb && t.db ? t.db.name : '',
      dbUser: dropDbUser && t.db ? t.db.user : '',
      dropDb, dropDbUser, removeSsl,
    });
    $('undPassword').value = '';
    undActiveId = r.id;
    undPoll();
    deployJobsRefresh(true);
  } catch (e) {
    btn.disabled = false;
    $('undStatus').textContent = 'Gagal: ' + e.message;
    alert('Error: ' + e.message);
  }
}

async function undPoll() {
  if (!undActiveId) return;
  try {
    const d = await api('GET', `/api/deploy/status?id=${encodeURIComponent(undActiveId)}`);
    const cls = d.status === 'done' ? 'ok' : (d.status === 'failed' ? 'down' : '');
    $('undStatus').innerHTML = `<span class="pill ${cls}">${escHtml(d.status)}</span> ${escHtml(d.label)}`;
    $('undSteps').innerHTML = d.steps.map(depStepPill).join('') || '<span style="color:var(--mut);font-size:12px">Menunggu...</span>';
    const last = [...d.steps].reverse().find((s) => s.output) || d.steps[d.steps.length - 1];
    $('undOutput').textContent = (last && last.output ? `--- ${last.name} ---\n${last.output}` : '(belum ada output)');
    deployJobsRefresh(true);
    if (d.status === 'running') {
      clearTimeout(undPollTimer);
      undPollTimer = setTimeout(undPoll, 3000);
    } else {
      undActiveId = null;
      $('undStart').disabled = false;
      await undLoadTargets();
    }
  } catch (e) {
    $('undStatus').textContent = 'Error: ' + e.message;
    $('undStart').disabled = false;
    undActiveId = null;
  }
}

// Un-deploy events
$('undRefresh').addEventListener('click', undLoadTargets);
$('undTarget').addEventListener('change', undRenderInfo);
$('undStart').addEventListener('click', undSubmit);
$('undConfirm').addEventListener('keydown', (e) => { if (e.key === 'Enter') undSubmit(); });
$('undPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') undSubmit(); });

// UI Events
$('gitSearch').addEventListener('input', renderGitProjects);

$('gitRefresh').addEventListener('click', () => {
  $('gitList').innerHTML = '<span style="color:var(--mut);font-size:12px">Scanning for repositories...</span>';
  gitProjects();
});

$('gitBatchPull').addEventListener('click', doBatchPull);

$('gitList').addEventListener('change', (e) => {
  if (e.target.classList.contains('group-check')) {
    const grp = e.target.closest('.git-group');
    if (grp) {
      grp.querySelectorAll('.repo-check').forEach(c => c.checked = e.target.checked);
    }
  }
  updateBatchButton();
});

let seedRel = null;
const closePullMenus = () => document.querySelectorAll('.pull-menu.open').forEach(m => m.classList.remove('open'));
document.addEventListener('click', (e) => { if (!e.target.closest('.pull-split')) closePullMenus(); });

async function openSeedModal(rel) {
  seedRel = rel;
  $('seedModalTitle').textContent = `Run Seeder: ${rel}`;
  $('seedList').textContent = 'Loading…';
  $('seedOut').style.display = 'none';
  $('seedRun').disabled = true;
  $('seedModal').classList.add('open');
  try {
    const d = await j('/api/git/seeders?relPath=' + encodeURIComponent(rel));
    const list = d.seeders || [];
    $('seedList').innerHTML = list.length
      ? list.map(s => `<label><input type="checkbox" class="seed-chk" value="${escHtml(s)}" /> ${escHtml(s)}</label>`).join('')
      : '<span style="color:var(--mut);font-size:12px;padding:6px 8px;display:block">Tidak ada seeder di database/seeders</span>';
  } catch (e) {
    $('seedList').innerHTML = `<span style="color:var(--bad);font-size:12px;padding:6px 8px;display:block">${escHtml(e.message || 'Gagal memuat seeder')}</span>`;
  }
}
$('seedList').addEventListener('change', () => {
  $('seedRun').disabled = !document.querySelector('.seed-chk:checked');
});
$('seedRun').addEventListener('click', async () => {
  const classes = Array.from(document.querySelectorAll('.seed-chk:checked')).map(c => c.value);
  if (!classes.length) return;
  if (!confirm(`Jalankan ${classes.length} seeder di ${seedRel}?\n\n${classes.join('\n')}`)) return;
  const btn = $('seedRun');
  btn.disabled = true; btn.textContent = 'Running…';
  const out = $('seedOut');
  out.style.display = ''; out.className = 'modal-body'; out.textContent = 'Menjalankan…';
  try {
    const d = await api('POST', '/api/git/seed', { relPath: seedRel, classes });
    out.textContent = d.output || 'Done';
    out.classList.add('ok');
  } catch (e) {
    out.textContent = e.message;
    out.classList.add('err');
  }
  btn.textContent = 'Run Selected';
  btn.disabled = !document.querySelector('.seed-chk:checked');
});
const closeSeedModal = () => $('seedModal').classList.remove('open');
$('seedModalClose').addEventListener('click', closeSeedModal);
$('seedCancel').addEventListener('click', closeSeedModal);
$('seedModal').addEventListener('click', (e) => { if (e.target === $('seedModal')) closeSeedModal(); });

let envRel = null;
async function openEnvModal(rel) {
  envRel = rel;
  $('envModalTitle').textContent = `Edit .env: ${rel}`;
  const ta = $('envText');
  ta.value = 'Loading…'; ta.disabled = true;
  $('envSave').disabled = true;
  $('envOut').style.display = 'none';
  $('envModal').classList.add('open');
  try {
    const d = await j('/api/git/env?relPath=' + encodeURIComponent(rel));
    ta.value = d.content || '';
    ta.disabled = false;
    $('envSave').disabled = false;
  } catch (e) {
    ta.value = e.message || 'Gagal memuat .env';
  }
}
$('envSave').addEventListener('click', async () => {
  if (!confirm(`Simpan .env di ${envRel} lalu jalankan optimize:clear?`)) return;
  const btn = $('envSave');
  btn.disabled = true; btn.textContent = 'Saving…';
  const out = $('envOut');
  out.style.display = ''; out.className = 'modal-body'; out.textContent = 'Menyimpan…';
  try {
    const d = await api('POST', '/api/git/env', { relPath: envRel, content: $('envText').value });
    out.textContent = d.output || 'Done';
    out.classList.add('ok');
  } catch (e) {
    out.textContent = e.message;
    out.classList.add('err');
  }
  btn.textContent = 'Save & Optimize Clear';
  btn.disabled = false;
});
const closeEnvModal = () => $('envModal').classList.remove('open');
$('envModalClose').addEventListener('click', closeEnvModal);
$('envCancel').addEventListener('click', closeEnvModal);

let termRel = null;
function openTermModal(rel) {
  termRel = rel;
  $('termModalTitle').textContent = `Terminal: ${rel}`;
  $('termOut').textContent = '';
  $('termModal').classList.add('open');
  $('termInput').focus();
}
$('termForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cmd = $('termInput').value.trim();
  if (!cmd) return;
  const out = $('termOut');
  const btn = $('termRun');
  btn.disabled = true; $('termInput').disabled = true;
  out.textContent += `$ ${cmd}\n`;
  try {
    const d = await api('POST', '/api/git/terminal', { relPath: termRel, command: cmd });
    out.textContent += (d.output || '') + '\n';
  } catch (err) {
    out.textContent += `[error] ${err.message}\n`;
  }
  $('termInput').value = '';
  btn.disabled = false; $('termInput').disabled = false;
  $('termInput').focus();
  out.scrollTop = out.scrollHeight;
});
const closeTermModal = () => $('termModal').classList.remove('open');
$('termModalClose').addEventListener('click', closeTermModal);
$('termModal').addEventListener('click', (e) => { if (e.target === $('termModal')) closeTermModal(); });

let dbSyncTarget = null;
let dbSyncSources = [];
async function openDbSyncModal(rel) {
  dbSyncTarget = rel;
  $('dbSyncModalTitle').textContent = `Sync DB ke: ${rel}`;
  $('dbSyncTargetInfo').textContent = rel;
  $('dbSyncSource').innerHTML = '<option value="">Memuat sumber database...</option>';
  $('dbSyncSource').disabled = true;
  $('dbSyncSrcDb').textContent = '—';
  $('dbSyncDstDb').textContent = '—';
  $('dbSyncPassword').value = '';
  $('dbSyncErr').style.display = 'none';
  $('dbSyncRun').disabled = true;
  $('dbSyncModal').classList.add('open');
  try {
    const d = await j('/api/git/db/sources?relPath=' + encodeURIComponent(rel));
    dbSyncSources = d.sources || [];
    $('dbSyncDstDb').textContent = d.target.db || '(DB kosong di .env)';
    if (!dbSyncSources.length) {
      $('dbSyncSource').innerHTML = '<option value="">Tidak ada project lain dengan DB</option>';
      return;
    }
    $('dbSyncSource').innerHTML = dbSyncSources.map(s => {
      const isDef = s.relPath === d.defaultSource ? 'selected' : '';
      return `<option value="${escHtml(s.relPath)}" ${isDef}>${escHtml(s.name)} (DB: ${escHtml(s.db)})</option>`;
    }).join('');
    $('dbSyncSource').disabled = false;
    updateDbSyncSelection();
    $('dbSyncRun').disabled = false;
  } catch (err) {
    $('dbSyncErr').textContent = err.message || 'Gagal memuat daftar project';
    $('dbSyncErr').style.display = '';
  }
}
function updateDbSyncSelection() {
  const sel = $('dbSyncSource').value;
  const s = dbSyncSources.find(x => x.relPath === sel);
  $('dbSyncSrcDb').textContent = s ? s.db : '—';
}
$('dbSyncSource').addEventListener('change', updateDbSyncSelection);
const closeDbSyncModal = () => { $('dbSyncModal').classList.remove('open'); dbSyncTarget = null; };
$('dbSyncModalClose').addEventListener('click', closeDbSyncModal);
$('dbSyncCancel').addEventListener('click', closeDbSyncModal);
$('dbSyncModal').addEventListener('click', (e) => { if (e.target === $('dbSyncModal')) closeDbSyncModal(); });
$('dbSyncRun').addEventListener('click', async () => {
  if (!dbSyncTarget) return;
  const sourceRel = $('dbSyncSource').value;
  if (!sourceRel) return alert('Pilih project sumber');
  const password = $('dbSyncPassword').value;
  if (!password) {
    $('dbSyncErr').textContent = 'Password akun wajib diisi untuk konfirmasi';
    $('dbSyncErr').style.display = '';
    $('dbSyncPassword').focus();
    return;
  }
  const s = dbSyncSources.find(x => x.relPath === sourceRel);
  const srcDb = s ? s.db : sourceRel;
  const dstDb = $('dbSyncDstDb').textContent;
  const syncStorage = $('dbSyncStorage').checked;
  const storageNote = syncStorage ? '\n+ Storage dev akan dibersihkan & disalin dari source' : '';
  if (!confirm(`Konfirmasi overwrite database:\n\nSumber: ${srcDb} (read-only, aman)\nTarget: ${dstDb} (akan ditimpa data terbaru)${storageNote}\n\nDatabase target akan dibackup otomatis sebelum ditimpa. Lanjutkan?`)) return;

  const btn = $('dbSyncRun');
  btn.disabled = true;
  btn.textContent = 'Menyalin DB…';
  $('dbSyncErr').style.display = 'none';

  try {
    const d = await api('POST', '/api/git/db/sync', {
      relPath: dbSyncTarget,
      sourceRelPath: sourceRel,
      password,
      syncStorage
    });
    closeDbSyncModal();
    $('gitModalTitle').textContent = `Sync DB Selesai: ${dstDb}`;
    $('gitModalBody').textContent = d.output || 'Sukses';
    $('gitModalBody').className = 'modal-body ok';
    $('gitModal').classList.add('open');
    gitProjects();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '⇄ Sync DB Sekarang';
    $('dbSyncErr').textContent = err.message;
    $('dbSyncErr').style.display = '';
    $('dbSyncPassword').select();
  }
});

async function doComposerUpdate(rel) {
  if (!confirm(`Jalankan "composer update" di ${rel}?\n\nIni memperbarui dependency & composer.lock, bisa memakan beberapa menit.`)) return;
  $('gitModalTitle').textContent = `Composer Update: ${rel}`;
  $('gitModalBody').className = 'modal-body';
  $('gitModalBody').textContent = 'Menjalankan composer update… (bisa beberapa menit)';
  $('gitModal').classList.add('open');
  try {
    const d = await api('POST', '/api/git/composer', { relPath: rel });
    $('gitModalBody').textContent = d.output || 'Done';
    $('gitModalBody').className = 'modal-body ok';
  } catch (err) {
    $('gitModalBody').textContent = err.message;
    $('gitModalBody').className = 'modal-body err';
  }
  gitProjects();
}

$('gitList').addEventListener('click', async (e) => {
  const dbsyncBtn = e.target.closest('.act-dbsync');
  if (dbsyncBtn) { closePullMenus(); openDbSyncModal(dbsyncBtn.dataset.rel); return; }
  const termBtn = e.target.closest('.act-term');
  if (termBtn) { closePullMenus(); openTermModal(termBtn.dataset.rel); return; }
  const compBtn = e.target.closest('.act-composer');
  if (compBtn) { closePullMenus(); doComposerUpdate(compBtn.dataset.rel); return; }
  const envBtn = e.target.closest('.act-env');
  if (envBtn) { closePullMenus(); openEnvModal(envBtn.dataset.rel); return; }
  const more =e.target.closest('.btn-pull-more');
  if (more) {
    const menu = more.parentElement.querySelector('.pull-menu');
    const wasOpen = menu.classList.contains('open');
    closePullMenus();
    if (!wasOpen) menu.classList.add('open');
    return;
  }
  const seedBtn = e.target.closest('.act-seed');
  if (seedBtn) { closePullMenus(); openSeedModal(seedBtn.dataset.rel); return; }
  const btn = e.target.closest('.btn-pull');
  if (btn && btn.dataset.rel) {
    const rel = btn.dataset.rel;
    const r = await doPull(rel, btn);
    $('gitModalTitle').textContent = `Update: ${rel}`;
    $('gitModalBody').textContent = r.output;
    $('gitModalBody').className = 'modal-body ' + (r.ok ? 'ok' : 'err');
    $('gitModal').classList.add('open');
    gitProjects();
    return;
  }

  // Click card to toggle checkbox
  if (!e.target.classList.contains('git-check')) {
    const item = e.target.closest('.git-item');
    if (item) {
      const chk = item.querySelector('.repo-check');
      if (chk) {
        chk.checked = !chk.checked;
        updateBatchButton();
      }
    }
  }
});

$('gitModalClose').addEventListener('click', () => $('gitModal').classList.remove('open'));
$('gitModal').addEventListener('click', (e) => {
  if (e.target === $('gitModal')) $('gitModal').classList.remove('open');
});

// Backup Events
$('backupRefreshBtn').addEventListener('click', backups);
$('sitesRefresh').addEventListener('click', sites);
$('sitesSearch').addEventListener('input', renderSites);
$('sitesFilter').addEventListener('change', renderSites);
$('sitesList').addEventListener('click', (e) => {
  const c = e.target.closest('[data-cfg-site]');
  if (c) return openSiteConfig(c.dataset.cfgSite);
  const b = e.target.closest('[data-del-site]');
  if (b) openSiteDelete(b.dataset.delSite);
  const u = e.target.closest('[data-und-site]');
  if (u) return openUndeployForSite(u.dataset.undSite);
});
$('siteCfgClose').addEventListener('click', () => $('siteCfgModal').classList.remove('open'));
$('siteCfgModal').addEventListener('click', (e) => { if (e.target === $('siteCfgModal')) $('siteCfgModal').classList.remove('open'); });
$('siteCfgCopy').addEventListener('click', async () => {
  const b = $('siteCfgCopy');
  try { await navigator.clipboard.writeText($('siteCfgContent').textContent); b.textContent = 'Copied ✓'; }
  catch { b.textContent = 'Gagal'; }
  setTimeout(() => { b.textContent = 'Copy'; }, 1500);
});
$('siteDelClose').addEventListener('click', closeSiteDelete);
$('siteDelCancel').addEventListener('click', closeSiteDelete);
$('siteDelConfirm').addEventListener('click', confirmSiteDelete);
$('siteDelPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmSiteDelete(); if (e.key === 'Escape') closeSiteDelete(); });
$('backupSearch').addEventListener('input', renderBackups);
$('backupList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-del-backup]');
  if (!btn) return;
  const rel = btn.dataset.delBackup;
  if (!confirm(`Hapus file backup?\n\n${rel}\n\nTindakan ini tidak bisa dibatalkan.`)) return;
  btn.disabled = true;
  try {
    await api('DELETE', '/api/backups/delete', { file: rel });
    await backups();
  } catch (err) {
    btn.disabled = false;
    alert('Gagal menghapus: ' + (err.message || err));
  }
});
$('backupFilterTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('#backupFilterTabs .tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  backupFilterCat = btn.dataset.cat || 'all';
  renderBackups();
});
$('btnToggleBackupLog').addEventListener('click', () => {
  const box = $('backupLogBox');
  const btn = $('btnToggleBackupLog');
  if (box.style.display === 'none') {
    box.style.display = 'block';
    btn.textContent = 'Sembunyikan Log';
  } else {
    box.style.display = 'none';
    btn.textContent = 'Tampilkan Log';
  }
});
let backupPollTimer = null;
function renderBackupProgress(st) {
  const box = $('backupProgress'), bar = $('backupProgressBar');
  box.style.display = 'block';
  const sec = Math.round(st.elapsedMs / 1000);
  const indeterminate = st.running && st.percent == null;
  bar.style.width = (indeterminate ? 100 : (st.percent || 0)) + '%';
  bar.style.opacity = indeterminate ? '.5' : '1';
  bar.style.background = (!st.running && st.ok === false) ? 'var(--err, #e5484d)' : 'var(--ok)';
  $('backupProgressPct').textContent = st.running
    ? (st.percent != null ? `~${st.percent}% · ${sec}s` : `${sec}s`)
    : (st.ok ? `100% · ${sec}s` : `Gagal · ${sec}s`);
  $('backupProgressLabel').textContent = st.running ? 'Menjalankan backup...' : (st.ok ? 'Backup selesai' : 'Backup gagal');
  const log = $('backupProgressLog');
  log.textContent = st.output || '';
  log.scrollTop = log.scrollHeight;
}
function stopBackupPoll() { clearInterval(backupPollTimer); backupPollTimer = null; }
async function pollBackup() {
  const btn = $('backupRunBtn');
  try {
    const st = await api('GET', '/api/backups/status');
    renderBackupProgress(st);
    if (st.running) {
      btn.disabled = true;
      btn.textContent = 'Menjalankan Backup...';
      return;
    }
  } catch {}
  stopBackupPoll();
  btn.disabled = false;
  btn.textContent = '▶ Jalankan Backup Sekarang';
  backups();
}
function watchBackup() {
  stopBackupPoll();
  pollBackup();
  backupPollTimer = setInterval(pollBackup, 1500);
}
$('backupRunBtn').addEventListener('click', async () => {
  if (!confirm('Jalankan proses backup MySQL sekarang di server? Ini akan mengeksekusi /usr/local/bin/backup-mysql.sh')) return;
  const btn = $('backupRunBtn');
  btn.disabled = true;
  btn.textContent = 'Menjalankan Backup...';
  try {
    await api('POST', '/api/backups/run');
    watchBackup();
  } catch (err) {
    alert(err.message || 'Gagal menjalankan backup');
    btn.disabled = false;
    btn.textContent = '▶ Jalankan Backup Sekarang';
  }
});

// Download Database (dump live)
let dbDumpItems = [];
function renderDbDump() {
  const q = $('dbDumpSearch').value.trim().toLowerCase();
  const items = dbDumpItems.filter((d) => d.name.toLowerCase().includes(q));
  $('dbDumpList').innerHTML = items.length ? items.map((d) => `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--bd, rgba(255,255,255,.08))">
      <div><strong>${escHtml(d.name)}</strong> <span style="color:var(--mut);font-size:12px">${fmtBytes(d.size)}</span></div>
      <a href="/api/backups/dump?db=${encodeURIComponent(d.name)}" class="btn-sm ok" style="text-decoration:none" download>⬇ Download</a>
    </div>`).join('') : '<div style="color:var(--mut)">Tidak ada database.</div>';
}
$('dbDumpBtn').addEventListener('click', async () => {
  $('dbDumpModal').classList.add('open');
  $('dbDumpSearch').value = '';
  $('dbDumpList').textContent = 'Loading…';
  try {
    dbDumpItems = (await api('GET', '/api/backups/databases')).databases || [];
    renderDbDump();
  } catch (err) { $('dbDumpList').textContent = err.message || 'Gagal memuat database'; }
});
$('dbDumpSearch').addEventListener('input', renderDbDump);
$('dbDumpClose').addEventListener('click', () => $('dbDumpModal').classList.remove('open'));

// File Explorer Events
$('fsBtnRefresh').addEventListener('click', () => loadFs(fsCurrentPath));
$('fsBtnUp').addEventListener('click', () => {
  if (fsParentPath) loadFs(fsParentPath);
});
$('fsFilterInput').addEventListener('input', renderFsList);

$('fsBreadcrumbs').addEventListener('click', (e) => {
  const link = e.target.closest('.fs-crumb');
  if (link && link.dataset.path) loadFs(link.dataset.path);
});

$('fsBookmarks').addEventListener('click', (e) => {
  const btn = e.target.closest('.fs-bmark');
  if (btn && btn.dataset.path) loadFs(btn.dataset.path);
});

$('fsList').addEventListener('change', (e) => {
  const cb = e.target.closest('.fs-sel');
  if (!cb) return;
  cb.checked ? fsSelected.add(cb.dataset.name) : fsSelected.delete(cb.dataset.name);
  updateFsSelUI();
});
$('fsSelAll').addEventListener('change', (e) => {
  document.querySelectorAll('#fsList .fs-sel').forEach(c => {
    c.checked = e.target.checked;
    e.target.checked ? fsSelected.add(c.dataset.name) : fsSelected.delete(c.dataset.name);
  });
  updateFsSelUI();
});
$('fsBtnDownloadSel').addEventListener('click', () => {
  if (fsSelected.size) location.href = fsArchiveUrl(fsCurrentPath, [...fsSelected]);
});

$('fsList').addEventListener('click', (e) => {
  const dirEl = e.target.closest('.fs-open-dir');
  if (dirEl && dirEl.dataset.path) {
    loadFs(dirEl.dataset.path);
    return;
  }
  const fileEl = e.target.closest('.fs-preview-file');
  if (fileEl && fileEl.dataset.path) {
    previewFsFile(fileEl.dataset.path);
  }
});

$('fsPreviewModalClose').addEventListener('click', () => $('fsPreviewModal').classList.remove('open'));
$('fsPreviewModal').addEventListener('click', (e) => {
  if (e.target === $('fsPreviewModal')) $('fsPreviewModal').classList.remove('open');
});

// User Management Events
$('usersRefresh').addEventListener('click', () => users());
$('btnOpenAddUser').addEventListener('click', () => {
  $('addUsername').value = '';
  $('addPassword').value = '';
  $('addRole').value = 'viewer';
  $('addHidden').value = '';
  $('addUserErr').style.display = 'none';
  $('addUserModal').classList.add('open');
});
$('addUserModalClose').addEventListener('click', () => $('addUserModal').classList.remove('open'));
$('addUserCancel').addEventListener('click', () => $('addUserModal').classList.remove('open'));
$('addUserModal').addEventListener('click', (e) => {
  if (e.target === $('addUserModal')) $('addUserModal').classList.remove('open');
});

$('addUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('addUsername').value.trim();
  const password = $('addPassword').value;
  const role = $('addRole').value;
  const hiddenKeywords = $('addHidden').value;
  const errEl = $('addUserErr');
  const btn = $('addUserSubmit');
  errEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  try {
    await api('POST', '/api/users', { username, password, role, hiddenKeywords });
    $('addUserModal').classList.remove('open');
    users();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan User';
  }
});

$('editUserModalClose').addEventListener('click', () => $('editUserModal').classList.remove('open'));
$('editUserCancel').addEventListener('click', () => $('editUserModal').classList.remove('open'));
$('editUserModal').addEventListener('click', (e) => {
  if (e.target === $('editUserModal')) $('editUserModal').classList.remove('open');
});

$('editUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('editUsername').value;
  const role = $('editRole').value;
  const hiddenKeywords = $('editHidden').value;
  const disabled = $('editDisabled').checked;
  const password = $('editPassword').value.trim();
  const errEl = $('editUserErr');
  const btn = $('editUserSubmit');
  errEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  const payload = { username, role, hiddenKeywords, disabled };
  if (password) payload.password = password;
  try {
    await api('PATCH', '/api/users', payload);
    $('editUserModal').classList.remove('open');
    users();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan Perubahan';
  }
});

$('usersList').addEventListener('click', async (e) => {
  const editBtn = e.target.closest('[data-edit-user]');
  if (editBtn) {
    const uname = editBtn.dataset.editUser;
    const u = rawUsers.find(x => x.username === uname);
    if (!u) return;
    $('editUsername').value = u.username;
    $('editUsernameDisplay').textContent = u.username;
    $('editPassword').value = '';
    $('editRole').value = u.role || (u.admin ? 'admin' : 'viewer');
    $('editHidden').value = (u.hiddenKeywords || []).join(', ');
    $('editDisabled').checked = !!u.disabled;
    $('editUserErr').style.display = 'none';
    $('editUserModal').classList.add('open');
    return;
  }

  const toggleBtn = e.target.closest('[data-reset-user]');
  if (toggleBtn) {
    const uname = toggleBtn.dataset.resetUser;
    const u = rawUsers.find(x => x.username === uname);
    if (!u) return;
    toggleBtn.disabled = true;
    try {
      await api('PATCH', '/api/users', { username: uname, disabled: !u.disabled });
      users();
    } catch (err) {
      alert(err.message);
      toggleBtn.disabled = false;
    }
    return;
  }

  const delBtn = e.target.closest('[data-del-user]');
  if (delBtn) {
    const uname = delBtn.dataset.delUser;
    if (!confirm(`Hapus user "${uname}"? Akun ini tidak akan bisa login lagi.`)) return;
    delBtn.disabled = true;
    try {
      await api('DELETE', '/api/users', { username: uname });
      users();
    } catch (err) {
      alert(err.message);
      delBtn.disabled = false;
    }
  }
});

// Fullscreen Monitor (Overview, History, Services)
function syncFullscreenUI() {
  const on = document.body.classList.contains('fullscreen-focus');
  $('fsLabel').textContent = on ? 'Exit' : 'Fullscreen';
  $('fsIcon').innerHTML = on
    ? '<path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>'
    : '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>';
  try { if (typeof chart !== 'undefined' && chart) chart.resize(); } catch {}
}

$('fullscreenBtn').addEventListener('click', async () => {
  const willBeOn = !document.body.classList.contains('fullscreen-focus');
  if (willBeOn) {
    // Selalu masuk overview saat fullscreen NOC monitor diaktifkan
    if (location.hash !== '#/overview') {
      location.hash = '#/overview';
    } else {
      navigateView('overview');
    }
  }
  // Browser fullscreen API — fallback tetap aktif walau API gagal diblokir
  try {
    if (willBeOn && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    } else if (!willBeOn && document.exitFullscreen && document.fullscreenElement) {
      await document.exitFullscreen();
    }
  } catch {}
  document.body.classList.toggle('fullscreen-focus', willBeOn);
  syncFullscreenUI();
});

document.addEventListener('fullscreenchange', () => {
  // Jika user keluar via ESC browser, sinkron ulang state tampilan
  if (!document.fullscreenElement && document.body.classList.contains('fullscreen-focus')) {
    document.body.classList.remove('fullscreen-focus');
    syncFullscreenUI();
  }
});

// Init & Smart View-Based Intervals
const initV = currentView();
navigateView(initV);

// Stats selalu update tiap 3 detik untuk status bar atas & overview
setInterval(stats, 3000);

// Polling spesifik hanya jika view terkait sedang aktif (hemat CPU VPS)
setInterval(() => {
  const v = currentView();
  if (v === 'overview') { svc(); hist(); }
  else if (v === 'workers') { workers(); }
  else if (v === 'storage') { storage(); }
  else if (v === 'git') { gitProjects(); }
  else if (v === 'backups') { backups(); }
  else if (v === 'users') { users(); }
  else if (v === 'errors') { errors(); }
}, 15000);

// Processes dipoll lebih cepat (5 detik), hanya saat view Processes aktif
setInterval(() => { if (currentView() === 'processes') { procs(); mysqlQueries(); } }, 5000);

// Section collapsible (Running Processes, MySQL Queries, Spike History), state disimpan di localStorage
document.querySelectorAll('[data-collapsible]').forEach((card) => {
  const title = card.querySelector('.sec-title');
  if (!title) return;
  const key = 'collapsed:' + card.id;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'collapse-toggle';
  btn.setAttribute('aria-label', 'Toggle section');
  title.prepend(btn);

  const apply = (collapsed) => {
    card.classList.toggle('collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
  };
  try { apply(localStorage.getItem(key) === '1'); } catch { apply(false); }

  title.addEventListener('click', () => {
    const collapsed = !card.classList.contains('collapsed');
    apply(collapsed);
    try { localStorage.setItem(key, collapsed ? '1' : '0'); } catch {}
  });
});
