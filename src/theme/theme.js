// Theme handling. Auto follows prefers-color-scheme until the user picks a
// side explicitly; the choice persists in the prefs store. CVD-safe mode
// swaps only the diff tint tokens via the html.cvd class.
import { store } from '../storage/store.js';

function systemTheme() {
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function effectiveTheme() {
  const explicit = document.documentElement.getAttribute('data-theme');
  return explicit ?? systemTheme();
}

export function applyTheme() {
  const { theme, cvd } = store.get();
  if (theme) document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
  document.documentElement.classList.toggle('cvd', !!cvd);
  const btn = document.getElementById('themeBtn');
  if (btn) {
    btn.setAttribute('aria-label', 'Toggle color theme (currently ' + effectiveTheme() + ')');
    btn.title = 'Toggle theme';
  }
}

export function initTheme() {
  applyTheme();
  store.on(applyTheme);
  document.getElementById('themeBtn').addEventListener('click', () => {
    store.set({ theme: effectiveTheme() === 'dark' ? 'light' : 'dark' });
  });
}
