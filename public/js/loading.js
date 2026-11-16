// Progress bar tipis di atas halaman, hanya untuk pindah halaman sungguhan (klik link, reload,
// redirect lewat location). Request fetch/AJAX (polling, tombol update, dll.) sengaja tidak
// memunculkan apa-apa.
(function () {
  let bar = null;
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
  // beforeunload hanya terpanggil kalau browser benar-benar akan meninggalkan halaman ini
  // (link biasa, reload, location.href = ...). Klik hash (#), target=_blank, download, atau
  // ctrl/cmd+klik tidak memicunya, jadi tidak ada bar yang nyangkut.
  let skip = false;
  window.addEventListener('beforeunload', () => {
    if (!skip && document.body) getBar().classList.add('on');
  });
  // Download file lewat location.href juga memicu beforeunload padahal halaman tidak berpindah,
  // jadi lewat helper ini bar-nya dilewati.
  window.downloadUrl = (url) => {
    skip = true;
    location.href = url;
    setTimeout(() => { skip = false; }, 1000);
  };
  // Kembali lewat back/forward (bfcache) menampilkan halaman lama dengan bar masih menyala.
  window.addEventListener('pageshow', () => {
    if (bar) bar.classList.remove('on');
  });
})();
