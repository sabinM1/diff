// Synchronous theme bootstrap. Loaded as a classic (non-module) <script> in
// <head> BEFORE the stylesheet so the correct data-theme / .cvd class is on
// <html> at first paint — eliminating the flash of the wrong theme when the
// user's explicit choice differs from the OS preference.
//
// Must stay dependency-free and side-effect-only; CSP allows it via
// script-src 'self'. Keep the storage key/field names in sync with store.js.
(function () {
  try {
    var raw = localStorage.getItem('diffbench:prefs:v1');
    if (!raw) return;
    var p = JSON.parse(raw);
    var root = document.documentElement;
    if (p && (p.theme === 'dark' || p.theme === 'light')) {
      root.setAttribute('data-theme', p.theme);
    }
    if (p && p.cvd) root.classList.add('cvd');
  } catch (e) {
    /* first run, private mode, or corrupt data — fall through to CSS default */
  }
})();
