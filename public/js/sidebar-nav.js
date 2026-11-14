// Keyboard navigation for the sidebar drawer (shared by every page).
//   Tab Tab        open the sidebar (two Tab presses within 400ms, focus not in a text field/terminal)
//   ↑ / ↓ / Tab    move between menu items (wraps around), Home / End jump to first / last
//   Enter          open the focused item (Enter in the search box opens the first match)
//   typing         jumps to the search box and filters the menu
//   Esc            close the sidebar and return focus to where it was
// Works with the existing markup: it only reads/sets the `open` class on #sidebar and
// #sidebarOverlay, so mouse open/close (hamburger, ✕, overlay) gets the same focus handling.
(() => {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const search = document.getElementById('navSearch');
  const brandBtn = document.getElementById('vpsMonitorBtn');
  if (!sidebar || !overlay) return;

  const DOUBLE_TAP_MS = 400;
  const isOpen = () => sidebar.classList.contains('open');
  const visible = (el) => el.getClientRects().length > 0;

  const items = () => [
    search,
    ...sidebar.querySelectorAll('.nav-link, .nav-action:not(:disabled), .side-user-logout'),
  ].filter((el) => el && visible(el));
  const links = () => [...sidebar.querySelectorAll('.nav-link')].filter(visible);

  const setOpen = (show) => {
    sidebar.classList.toggle('open', show);
    overlay.classList.toggle('open', show);
  };

  if (brandBtn) brandBtn.title = 'Toggle Navigation Menu (double-tap Tab)';

  // Focus handling is driven by the class change so it also covers mouse open/close.
  let returnFocus = null;
  let wasOpen = isOpen();
  new MutationObserver(() => {
    const open = isOpen();
    if (open === wasOpen) return;
    wasOpen = open;
    if (open) {
      returnFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
      const target = sidebar.querySelector('.nav-link.active') || links()[0] || search;
      if (target && visible(target)) target.focus();
    } else {
      // Only restore focus if it is still inside the (now hidden) sidebar or lost to <body>.
      const a = document.activeElement;
      if (!a || a === document.body || sidebar.contains(a)) {
        if (returnFocus && returnFocus.isConnected && visible(returnFocus)) returnFocus.focus();
        else if (a && sidebar.contains(a)) a.blur();
      }
      returnFocus = null;
    }
  }).observe(sidebar, { attributes: true, attributeFilter: ['class'] });

  const move = (dir) => {
    const list = items();
    if (!list.length) return;
    const cur = list.findIndex((el) => el === document.activeElement || el.contains(document.activeElement));
    let next;
    if (cur === -1) next = dir > 0 ? 0 : list.length - 1;
    else next = (cur + dir + list.length) % list.length;
    list[next].focus();
  };

  const inTextField = (el) => !!(el && el.closest && el.closest('input, textarea, select, [contenteditable], .xterm'));

  let lastTab = 0;
  document.addEventListener('keydown', (e) => {
    if (e.isComposing) return;

    if (!isOpen()) {
      // Double-tap Tab to open. The first Tab keeps its normal focus-moving behaviour.
      if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) { lastTab = 0; return; }
      if (inTextField(e.target)) { lastTab = 0; return; }
      const now = Date.now();
      if (lastTab && now - lastTab < DOUBLE_TAP_MS) {
        e.preventDefault();
        lastTab = 0;
        setOpen(true);
      } else {
        lastTab = now;
      }
      return;
    }

    // Sidebar is open: it owns the keyboard.
    const inSearch = document.activeElement === search;
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation(); // don't also close a project drawer / modal underneath
        setOpen(false);
        return;
      case 'ArrowDown': e.preventDefault(); move(1); return;
      case 'ArrowUp': e.preventDefault(); move(-1); return;
      case 'Tab': e.preventDefault(); move(e.shiftKey ? -1 : 1); return; // keep focus inside the drawer
      case 'Home':
      case 'End':
        if (inSearch) return; // cursor movement in the search box
        e.preventDefault();
        { const list = items(); const t = e.key === 'Home' ? list[0] : list[list.length - 1]; if (t) t.focus(); }
        return;
      case 'Enter':
        if (inSearch) { // open the first match
          e.preventDefault();
          const first = links()[0];
          if (first) first.click();
        }
        return; // links and buttons activate natively
    }

    // Printable key while a link/button is focused: send it to the search box.
    if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey && search && !inSearch) {
      search.focus();
    }
  }, true);
})();
