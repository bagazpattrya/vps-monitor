// Indikator loading bersama: progress bar tipis di atas halaman untuk request yang lambat.
// Request cepat (mis. polling 3 detik) tidak memunculkan apa-apa; bar baru tampil kalau ada
// request yang masih berjalan setelah SHOW_AFTER ms, jadi tidak berkedip.
(function () {
  const SHOW_AFTER = 400;
  let pending = 0, timer = null, bar = null;
  const getBar = () => {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'top-progress';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Loading');
    bar.innerHTML = '<span></span>';
    document.body.appendChild(bar);
    return bar;
  };
  const start = () => {
    if (++pending !== 1) return;
    timer = setTimeout(() => { if (pending > 0) getBar().classList.add('on'); }, SHOW_AFTER);
  };
  const done = () => {
    if (pending > 0 && --pending === 0) {
      clearTimeout(timer);
      if (bar) bar.classList.remove('on');
    }
  };
  const orig = window.fetch.bind(window);
  window.fetch = function () {
    start();
    return orig.apply(null, arguments).finally(done);
  };
})();
