const $ = id => document.getElementById(id);

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

let isAdmin = false, isSuper = false;
j('/api/me').then(m => {
  isAdmin = !!m.admin; isSuper = !!m.superadmin;
  $('who').innerHTML = `<strong>${escHtml(m.user)}</strong>${m.role === 'superadmin' ? '<span class="role">superadmin</span>' : m.admin ? '<span class="role">admin</span>' : ''}`;
  $('sideUserName').textContent = m.user;
  $('sideUserAvatar').textContent = String(m.user || '?').charAt(0);
  $('sideUserRole').textContent = m.role === 'superadmin' ? 'superadmin' : m.admin ? 'admin' : 'viewer';
  $('sideUser').style.display = '';
  if (!m.superadmin) { location.href = '/'; return; }
  ['Users', 'Files', 'Console'].forEach(n => { if (m.superadmin && $('navLink' + n)) $('navLink' + n).style.display = ''; });
  ['Backups', 'Sites', 'Deploy', 'Activity', 'Errors', 'Chat'].forEach(n => { if ($('navLink' + n)) $('navLink' + n).style.display = ''; });
  $('pm2RestartBtn').style.display = '';
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


// ---- Console ----
const THEME = {
  background: '#0b0e13', foreground: '#d7dde8', cursor: '#d7dde8', selectionBackground: '#33415c',
  black: '#1c212d', red: '#f87171', green: '#34d399', yellow: '#fbbf24', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#d7dde8',
  brightBlack: '#5b667a', brightRed: '#fca5a5', brightGreen: '#6ee7b7', brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#f8fafc',
};
let term = null, fit = null, ws = null, connected = false;
const enc = new TextEncoder();

function setState(text, cls) {
  const b = $('conState');
  b.textContent = text;
  b.style.color = cls === 'ok' ? 'var(--ok)' : cls === 'bad' ? 'var(--bad)' : '';
}

function ensureTerm() {
  if (term) return;
  term = new Terminal({ cursorBlink: true, fontSize: 14, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', theme: THEME, scrollback: 5000, allowProposedApi: false });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('term'));
  term.onData((d) => { if (connected) ws.send(JSON.stringify({ t: 'in', d })); });
  const refit = () => {
    if ($('term').offsetParent === null) return;
    try { fit.fit(); } catch {}
    if (connected) ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
  };
  new ResizeObserver(refit).observe($('term'));
}

function showGate(msg) {
  $('conGate').hidden = false;
  $('conErr').textContent = msg || '';
  $('conClose').hidden = true;
  $('conReconnect').hidden = true;
  $('conPw').value = '';
  $('conPw').focus();
}

function connect(password) {
  ensureTerm();
  try { fit.fit(); } catch {}
  setState('connecting…');
  $('conGo').disabled = true;
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/console/ws');
  ws.binaryType = 'arraybuffer';
  let opened = false, ended = false;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', password, cols: term.cols, rows: term.rows }));
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') { term.write(new Uint8Array(ev.data)); return; }
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'ready') {
      opened = true; connected = true;
      $('conGate').hidden = true; $('conGo').disabled = false;
      $('conClose').hidden = false; $('conReconnect').hidden = true;
      setState('connected', 'ok');
      term.reset(); term.focus();
      ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
    } else if (m.t === 'error') {
      ended = true;
      if (!opened) showGate(m.error); else term.write(`\r\n\x1b[31m[${m.error}]\x1b[0m\r\n`);
    } else if (m.t === 'exit') {
      ended = true;
      term.write(`\r\n\x1b[90m[shell exited${m.code != null ? ' with code ' + m.code : ''}]\x1b[0m\r\n`);
    }
  };
  ws.onclose = () => {
    connected = false;
    $('conGo').disabled = false;
    if (!opened) {
      if (!ended) showGate('Could not connect (not allowed, too many open consoles, or server unreachable)');
      setState('disconnected', 'bad');
      return;
    }
    setState('disconnected', 'bad');
    $('conClose').hidden = true;
    $('conReconnect').hidden = false;
  };
}

$('conGate').addEventListener('submit', (e) => {
  e.preventDefault();
  const pw = $('conPw').value;
  $('conErr').textContent = '';
  if (pw) connect(pw);
});
$('conReconnect').onclick = () => { term.reset(); showGate(); };
$('conClose').onclick = () => { if (ws) ws.close(); };
$('conClear').onclick = () => { if (term) { term.clear(); term.focus(); } };
$('conPw').focus();
