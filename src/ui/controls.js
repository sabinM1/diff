// Reusable control factories bound to the prefs store.
import { h } from './dom.js';

// items: [[value, label], ...] → { el, set(value) }
export function segmented(items, value, onChange, ariaLabel) {
  const el = h('div', { class: 'seg', role: 'group', 'aria-label': ariaLabel });
  const btns = new Map();
  for (const [val, label] of items) {
    const btn = h('button', {
      type: 'button',
      class: 'seg-item',
      text: label,
      'aria-pressed': String(val === value),
      dataset: { value: val },
      onclick: () => onChange(btn.dataset.value),
    });
    btns.set(val, btn);
    el.append(btn);
  }
  return {
    el,
    set(v) {
      for (const [val, btn] of btns) {
        btn.classList.toggle('is-active', val === v);
        btn.setAttribute('aria-pressed', String(val === v));
      }
    },
  };
}

// 30×16 switch, role="switch"
export function switchCtl(checked, onChange, ariaLabel) {
  const el = h('button', {
    type: 'button',
    class: 'switch',
    role: 'switch',
    'aria-checked': String(checked),
    'aria-label': ariaLabel,
    onclick: () => onChange(el.getAttribute('aria-checked') !== 'true'),
  });
  return { el, set(v) { el.setAttribute('aria-checked', String(v)); } };
}

// 14×14 checkbox row, role="checkbox" (styled box, real semantics)
export function checkboxCtl(checked, onChange, label) {
  const box = h('span', { class: 'cbx', role: 'checkbox', 'aria-checked': String(checked), tabindex: '0' });
  const toggle = () => {
    if (box.getAttribute('aria-disabled') === 'true') return;
    onChange(box.getAttribute('aria-checked') !== 'true');
  };
  box.addEventListener('click', toggle);
  box.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
  });
  const el = h('div', { class: 'checkbox-row' },
    box,
    h('span', { class: 'cb-label', onclick: toggle }, label),
  );
  return { el, box, set(v) { box.setAttribute('aria-checked', String(v)); } };
}
