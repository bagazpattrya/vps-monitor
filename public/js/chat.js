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
const MAX_IMAGES = 4, MAX_BYTES = 5 * 1024 * 1024;
const msgs = $('msgs'), input = $('input'), modelSel = $('model');
const EXAMPLES = ['Which projects do I have?', 'Summarize the recent errors in my logs', 'Explain how this project is structured'];
let currentId = '';
let busy = false;
let pending = []; // [{ dataUrl }]
let stick = true; // follow new output only while the user is at the bottom

const imgUrl = (id, name) => `/api/chats/${id}/img/${name}`;
const nearBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
const scrollDown = (force) => { if (force || stick) msgs.scrollTop = msgs.scrollHeight; };
msgs.addEventListener('scroll', () => { stick = nearBottom(); $('toBottom').hidden = stick; });
$('toBottom').onclick = () => { stick = true; msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' }); };

function row(cls) {
  $('empty') && $('empty').remove();
  const d = document.createElement('div');
  d.className = 'chat-row ' + cls;
  msgs.appendChild(d);
  return d;
}

function addUser(text, images) {
  const r = row('user');
  const box = document.createElement('div');
  box.className = 'ubox';
  for (const src of images || []) {
    const a = document.createElement('a');
    a.href = src; a.target = '_blank'; a.rel = 'noopener';
    const im = document.createElement('img');
    im.src = src; im.loading = 'lazy';
    a.appendChild(im); box.appendChild(a);
  }
  const t = document.createElement('div');
  t.textContent = text; // user text is plain
  box.appendChild(t);
  r.appendChild(box);
  scrollDown(true);
}

function addBot(model) {
  const r = row('bot');
  const head = document.createElement('div');
  head.className = 'bot-head';
  const av = document.createElement('span');
  av.className = 'bot-av'; av.textContent = '✦';
  const name = document.createElement('b');
  name.textContent = 'Claude';
  const mod = document.createElement('span');
  mod.textContent = model || '';
  head.append(av, name, mod);
  const body = document.createElement('div');
  body.className = 'md-body';
  r.append(head, body);
  return { row: r, body };
}

function addErr(text) {
  row('err').textContent = text;
  scrollDown(true);
}

// Card asking the user to approve a command Claude wants to run.
function showConfirm(parent, c, before) {
  const card = document.createElement('div');
  card.className = 'confirm';
  const title = document.createElement('div');
  title.className = 'confirm-title';
  title.textContent = 'Claude wants to run a command';
  const pre = document.createElement('pre');
  pre.textContent = c.command;
  card.append(title, pre);
  if (c.description) { const d = document.createElement('div'); d.className = 'confirm-desc'; d.textContent = c.description; card.appendChild(d); }
  const bar = document.createElement('div');
  bar.className = 'confirm-bar';
  const ok = document.createElement('button'), no = document.createElement('button');
  ok.type = no.type = 'button';
  ok.className = 'confirm-ok'; ok.textContent = 'Approve';
  no.className = 'confirm-no'; no.textContent = 'Deny';
  const answer = async (allow) => {
    ok.disabled = no.disabled = true;
    const res = document.createElement('span');
    res.className = 'confirm-result';
    try { await api('POST', '/api/chat/confirm', { id: c.id, allow }); res.textContent = allow ? 'Approved' : 'Denied'; }
    catch (e) { res.textContent = 'Could not send: ' + e.message; }
    bar.replaceChildren(res);
  };
  ok.onclick = () => answer(true);
  no.onclick = () => answer(false);
  bar.append(ok, no);
  card.appendChild(bar);
  parent.insertBefore(card, before || null);
  scrollDown(true);
}

const setBot = (body, text) => body.replaceChildren(renderMarkdown(text));

function showEmpty() {
  const d = document.createElement('div');
  d.className = 'chat-empty';
  d.id = 'empty';
  const h = document.createElement('h2');
  h.textContent = 'How can I help?';
  const p = document.createElement('p');
  p.textContent = 'Ask about your projects, code or error logs.';
  d.append(h, p);
  for (const t of EXAMPLES) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.textContent = t;
    b.onclick = () => { if (!busy) submitText(t); };
    d.appendChild(b);
  }
  msgs.appendChild(d);
}

function renderChat(chat) {
  msgs.textContent = '';
  $('chatTitle').textContent = chat ? chat.title : 'AI Chat';
  if (!chat || !chat.messages.length) showEmpty();
  for (const m of chat ? chat.messages : []) {
    if (m.role === 'user') addUser(m.text, (m.images || []).map((n) => imgUrl(chat.id, n)));
    else if (m.error) addErr(m.text);
    else setBot(addBot(chat.model).body, m.text);
  }
  stick = true;
  scrollDown(true);
}

async function openChat(id) {
  const chat = await j('/api/chats/' + id);
  currentId = id;
  localStorage.setItem('chatCurrent', id);
  if ([...modelSel.options].some((o) => o.value === chat.model)) modelSel.value = chat.model;
  renderChat(chat);
  markActive();
  $('chatList').classList.remove('open');
}

function markActive() {
  document.querySelectorAll('.chat-item').forEach((el) => el.classList.toggle('active', el.dataset.id === currentId));
}

function dayGroup(t) {
  const n = new Date();
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  return t >= today ? 'Today' : t >= today - 86400000 ? 'Yesterday' : 'Earlier';
}

async function loadList() {
  const list = await j('/api/chats');
  const box = $('chats');
  box.textContent = '';
  let lastGroup = '';
  for (const c of list) {
    const g = dayGroup(c.updatedAt);
    if (g !== lastGroup) {
      const lab = document.createElement('div');
      lab.className = 'chat-group'; lab.textContent = g;
      box.appendChild(lab);
      lastGroup = g;
    }
    const rowEl = document.createElement('div');
    rowEl.className = 'chat-item';
    rowEl.dataset.id = c.id;
    const title = document.createElement('span');
    title.className = 'chat-item-title';
    title.textContent = c.title;
    title.title = new Date(c.updatedAt).toLocaleString();
    title.onclick = () => { if (!busy) openChat(c.id); };
    const ren = document.createElement('button');
    ren.className = 'chat-item-btn'; ren.textContent = '✎'; ren.title = 'Rename';
    ren.onclick = async () => {
      const t = prompt('Rename chat', c.title);
      if (t && t.trim()) { await api('PATCH', '/api/chats/' + c.id, { title: t.trim() }); loadList(); if (c.id === currentId) $('chatTitle').textContent = t.trim().slice(0, 80); }
    };
    const del = document.createElement('button');
    del.className = 'chat-item-btn'; del.textContent = '✕'; del.title = 'Delete';
    del.onclick = async () => {
      if (busy || !confirm('Delete this chat permanently?')) return;
      await api('DELETE', '/api/chats/' + c.id);
      if (c.id === currentId) newChat();
      loadList();
    };
    rowEl.append(title, ren, del);
    box.appendChild(rowEl);
  }
  markActive();
  return list;
}

function newChat() {
  if (busy) return;
  currentId = '';
  localStorage.removeItem('chatCurrent');
  pending = []; renderThumbs();
  renderChat(null);
  markActive();
  $('chatList').classList.remove('open');
  input.focus();
}

// ---- attachments ----
function renderThumbs() {
  const box = $('thumbs');
  box.textContent = '';
  pending.forEach((p, i) => {
    const w = document.createElement('div');
    w.className = 'thumb';
    const im = document.createElement('img');
    im.src = p.dataUrl;
    const x = document.createElement('button');
    x.type = 'button'; x.textContent = '✕'; x.title = 'Remove';
    x.onclick = () => { pending.splice(i, 1); renderThumbs(); };
    w.append(im, x);
    box.appendChild(w);
  });
}

function addFiles(files) {
  for (const f of files) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) { addErr('Unsupported file: ' + f.name + ' (use PNG, JPEG, WebP or GIF)'); continue; }
    if (f.size > MAX_BYTES) { addErr(f.name + ' is larger than 5 MB'); continue; }
    if (pending.length >= MAX_IMAGES) { addErr('Max ' + MAX_IMAGES + ' images per message'); break; }
    const r = new FileReader();
    r.onload = () => { if (pending.length < MAX_IMAGES) { pending.push({ dataUrl: r.result }); renderThumbs(); } };
    r.readAsDataURL(f);
  }
}
$('attach').onclick = () => $('file').click();
$('file').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
const card = document.querySelector('.chat-card');
card.addEventListener('dragover', (e) => e.preventDefault());
card.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });

// ---- composer ----
const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; };
input.addEventListener('input', autosize);

// ---- send ----
async function sendMessage(message, images) {
  busy = true;
  $('send').disabled = true;
  stick = true;
  addUser(message, images);
  const bot = addBot(modelSel.value);
  let replyText = '';
  let segText = ''; // text since the last confirmation card, so later text renders below the card
  // Status "Claude is thinking… 12s" with bouncing dots; stays until the whole answer is done.
  const status = document.createElement('div');
  status.className = 'think';
  const dots = document.createElement('span');
  dots.className = 'dots';
  dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  const label = document.createElement('span');
  let what = 'Claude is thinking…';
  const t0 = Date.now();
  const tick = () => { label.textContent = what + ' · ' + Math.floor((Date.now() - t0) / 1000) + 's'; };
  tick();
  const timer = setInterval(tick, 1000);
  status.append(dots, label);
  bot.row.appendChild(status);
  scrollDown(true);
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, chatId: currentId || undefined, model: modelSel.value || undefined, images: images.length ? images : undefined }) });
    if (r.status === 401) { location.href = '/login'; return; }
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      addErr(d.error || 'Request failed');
      if (r.status === 404) { currentId = ''; localStorage.removeItem('chatCurrent'); }
      return;
    }
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
        if (ev.chatId) { currentId = ev.chatId; localStorage.setItem('chatCurrent', currentId); }
        if (ev.confirm) {
          showConfirm(bot.row, ev.confirm, status);
          const nb = document.createElement('div');
          nb.className = 'md-body';
          bot.row.insertBefore(nb, status);
          bot.body = nb;
          segText = '';
        }
        if (ev.tool) { what = ev.tool + '…'; tick(); }
        if (ev.text) { replyText += (replyText ? '\n\n' : '') + ev.text; segText += (segText ? '\n\n' : '') + ev.text; setBot(bot.body, segText); scrollDown(); }
        if (ev.error) addErr(ev.error);
      }
    }
  } catch (e) {
    addErr('Connection lost');
  } finally {
    clearInterval(timer);
    status.remove();
    if (!replyText) bot.row.remove();
    busy = false;
    $('send').disabled = false;
    input.focus();
    loadList().catch(() => {});
  }
}

function submitText(text) {
  if (busy) return;
  const t = text.trim();
  if (!t && !pending.length) return;
  const images = pending.map((p) => p.dataUrl);
  pending = []; renderThumbs();
  input.value = ''; autosize();
  sendMessage(t || 'Please look at the attached image(s).', images);
}

$('chatForm').addEventListener('submit', (e) => { e.preventDefault(); submitText(input.value); });
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('chatForm').requestSubmit(); } });
$('newChat').onclick = newChat;
$('toggleList').onclick = () => $('chatList').classList.toggle('open');
modelSel.addEventListener('change', () => localStorage.setItem('chatModel', modelSel.value));

// ---- start ----
renderChat(null);
(async () => {
  try {
    const m = await j('/api/chat/models');
    for (const x of m.models) modelSel.add(new Option(x, x));
    const saved = localStorage.getItem('chatModel');
    modelSel.value = m.models.includes(saved) ? saved : m.default;
    if (m.shell) $('modeBadge').textContent = 'read-only · commands need approval';
    const list = await loadList();
    const last = localStorage.getItem('chatCurrent');
    const id = list.some((c) => c.id === last) ? last : '';
    if (id) await openChat(id);
  } catch (e) {}
})();
