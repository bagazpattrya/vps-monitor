// Theme (dark default, light optional). Loaded synchronously in <head> to avoid a flash.
(function () {
  var KEY = 'theme';
  function get() { try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; } catch (e) { return 'dark'; } }
  function apply(t) {
    document.documentElement.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t === 'light' ? '#f4f6fa' : '#090b0e');
  }
  function set(t) {
    try { localStorage.setItem(KEY, t); } catch (e) {}
    apply(t);
    document.dispatchEvent(new CustomEvent('themechange', { detail: t }));
  }
  apply(get());
  window.theme = { get: get, set: set, toggle: function () { set(get() === 'light' ? 'dark' : 'light'); } };
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.theme-toggle').forEach(function (b) {
      b.addEventListener('click', window.theme.toggle);
    });
  });
})();
