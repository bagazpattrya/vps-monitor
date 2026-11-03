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

let isAdmin = false;
j('/api/me').then(m => {
  isAdmin = !!m.admin;
  $('who').innerHTML = `<strong>${escHtml(m.user)}</strong>${m.role === 'superadmin' ? '<span class="role">superadmin</span>' : m.admin ? '<span class="role">admin</span>' : ''}`;
  $('sideUserName').textContent = m.user;
  $('sideUserAvatar').textContent = String(m.user || '?').charAt(0);
  $('sideUserRole').textContent = m.role === 'superadmin' ? 'superadmin' : m.admin ? 'admin' : 'viewer';
  $('sideUser').style.display = '';
  if (!m.admin) { location.href = '/'; return; }
  ['Users', 'Files'].forEach(n => { if (m.superadmin && $('navLink' + n)) $('navLink' + n).style.display = ''; });
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

// ---- Chat ----
const msgs = $('msgs');
const input = $('input');
let sessionId = sessionStorage.getItem('chatSession') || '';
let busy = false;

const modelSel = $('model');
j('/api/chat/models').then((m) => {
  for (const x of m.models) modelSel.add(new Option(x, x));
  const saved = localStorage.getItem('chatModel');
  modelSel.value = m.models.includes(saved) ? saved : m.default;
}).catch(() => {});
modelSel.addEventListener('change', () => localStorage.setItem('chatModel', modelSel.value));

function bubble(cls, text) {
  const d = document.createElement('div');
  d.className = 'chat-msg ' + cls;
  d.textContent = text; // textContent only: replies may contain HTML-like text from logs/files
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight;
  return d;
}

async function sendMessage(message) {
  busy = true;
  $('send').disabled = true;
  bubble('user', message);
  const reply = bubble('bot', '');
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, sessionId: sessionId || undefined, model: modelSel.value || undefined }) });
    if (r.status === 401) { location.href = '/login'; return; }
    if (!r.ok) { reply.className = 'chat-msg err'; reply.textContent = (await r.json().catch(() => ({}))).error || 'Request failed'; return; }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!line.startsWith('data: ')) continue;
        let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev.text) reply.textContent += (reply.textContent ? '\n\n' : '') + ev.text;
        if (ev.sessionId) { sessionId = ev.sessionId; sessionStorage.setItem('chatSession', sessionId); }
        if (ev.error) bubble('err', ev.error);
        msgs.scrollTop = msgs.scrollHeight;
      }
    }
  } catch (e) {
    bubble('err', 'Connection lost');
  } finally {
    if (!reply.textContent) reply.remove();
    busy = false;
    $('send').disabled = false;
    input.focus();
  }
}

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const m = input.value.trim();
  if (!m || busy) return;
  input.value = '';
  sendMessage(m);
});
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chatForm').requestSubmit(); } });
$('newChat').addEventListener('click', () => {
  if (busy) return;
  sessionId = '';
  sessionStorage.removeItem('chatSession');
  msgs.textContent = '';
});
