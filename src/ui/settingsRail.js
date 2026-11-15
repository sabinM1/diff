// The right rail: settings groups + the image-mode details rail.
// Controls bind straight to the prefs store; every control refreshes on
// any store change so external updates (e.g. toolbar buttons) stay in sync.
import { store } from '../storage/store.js';
import { segmented, switchCtl, checkboxCtl } from './controls.js';
import { h } from './dom.js';
import { listLangs } from '../diff/highlight.js';

export function buildSettings(container) {
  container.textContent = '';
  const controls = [];

  const group = (title, ...children) => {
    const g = h('div', { class: 'set-group' }, h('h4', { text: title }));
    g.append(...children.flat());
    container.append(g);
    return g;
  };

  // Layout
  const layoutSeg = segmented([['split', 'Split'], ['unified', 'Unified']],
    store.get().layout, (v) => store.set({ layout: v }), 'Layout');
  group('Layout', layoutSeg.el);
  controls.push(layoutSeg);

  // Editor
  const rt = switchCtl(store.get().realtime, (v) => store.set({ realtime: v }), 'Real-time editor');
  const lw = switchCtl(store.get().wrap, (v) => store.set({ wrap: v }), 'Line wrap');
  group('Editor',
    h('div', { class: 'set-row' }, h('span', { class: 'row-label', text: 'Real-time editor' }), rt.el),
    h('div', { class: 'set-row' }, h('span', { class: 'row-label', text: 'Line wrap' }), lw.el),
  );

  // Diff
  const hw = checkboxCtl(store.get().hideWs, (v) => store.set({ hideWs: v }), 'Hide whitespace changes');
  const hu = checkboxCtl(store.get().hideUnchanged, (v) => store.set({ hideUnchanged: v }), 'Hide unchanged lines');
  group('Diff', hw.el, hu.el);

  // Diff precision
  const precSeg = segmented([['smart', 'Smart'], ['word', 'Word'], ['char', 'Char']],
    store.get().precision, (v) => store.set({ precision: v }), 'Diff precision');
  group('Diff precision', precSeg.el);
  controls.push(precSeg);

  // Syntax
  const synSeg = segmented([['auto', 'Auto'], ['manual', 'Manual'], ['off', 'Off']],
    store.get().syntax, (v) => store.set({ syntax: v }), 'Syntax highlighting');
  const langSel = h('select', {
    class: 'lang-select',
    'aria-label': 'Language',
    onchange: () => store.set({ manualLang: langSel.value }),
  });
  for (const [id, name] of listLangs()) {
    langSel.append(h('option', { value: id, text: name }));
  }
  langSel.value = store.get().manualLang;
  const langRow = h('div', { class: 'set-row' },
    h('span', { class: 'row-label', text: 'Language' }), langSel);
  group('Syntax', synSeg.el, langRow);
  controls.push(synSeg);
  controls.push(langRow);

  // Accessibility
  const cvdSeg = segmented([['std', 'Standard'], ['cvd', 'CVD-safe']],
    store.get().cvd ? 'cvd' : 'std', (v) => store.set({ cvd: v === 'cvd' }), 'Diff colours');
  group('Accessibility', cvdSeg.el);
  controls.push(cvdSeg);

  // Footer note (humanist sans per spec)
  container.append(h('p', { class: 'set-note' },
    'Smart follows structure · Word marks changed words · Char marks every glyph.'));

  const refresh = (p) => {
    layoutSeg.set(p.layout);
    rt.set(p.realtime);
    lw.set(p.wrap);
    hw.set(p.hideWs);
    hu.set(p.hideUnchanged);
    precSeg.set(p.precision);
    synSeg.set(p.syntax);
    cvdSeg.set(p.cvd ? 'cvd' : 'std');
    langSel.value = p.manualLang;
    langRow.hidden = p.syntax !== 'manual';
  };
  refresh(store.get());
  store.on(refresh);
}
