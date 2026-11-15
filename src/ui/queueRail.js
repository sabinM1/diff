// Batch queue rail. Rows are [icon|thumb][filenames][chips] with the
// initial icon hidden in the full-width layout and shown when the rail
// collapses (see styles.css breakpoints). Rows for text pairs carry
// +N / −N chips (or "no changes"); image rows carry a similar/different
// chip from the perceptual hash.
import { h } from './dom.js';

export class QueueRail {
  constructor(el, { onActivate, onRemove }) {
    this.list = el;
    this.onActivate = onActivate;
    this.onRemove = onRemove;
    this.rows = new Map();
    this.activeId = null;
  }

  setCount(n) {
    document.getElementById('queueCount').textContent = String(n);
  }

  // pair: { id, kind: 'text'|'image', aName, bName, icon (text abbr or canvas) }
  addRow(pair) {
    const icon = h('span', { class: 'qrow-icon', 'aria-hidden': 'true' });
    if (pair.thumb) icon.append(pair.thumb);
    else icon.textContent = pair.icon ?? '?';

    const names = h('div', { class: 'qrow-names' },
      h('span', { class: 'qrow-name', text: pair.aName || 'buffer' }),
      h('span', { class: 'qrow-sub' },
        h('span', { class: 'faint' }, '⇄ '),
        pair.bName || 'buffer'),
    );

    const chips = h('div', { class: 'qrow-chips' },
      h('span', { class: 'chip same', text: '…' }));

    const remove = h('button', {
      type: 'button',
      class: 'iconbtn tiny qrow-remove',
      'aria-label': `Remove ${pair.aName} ⇄ ${pair.bName}`,
      title: 'Remove',
      onclick: (e) => {
        e.stopPropagation();
        this.onRemove(pair.id);
      },
    }, h('span', { text: '×' }));

    const row = h('div', {
      class: 'queue-row',
      role: 'listitem',
      tabindex: '0',
      dataset: { id: pair.id },
      onclick: () => this.onActivate(pair.id),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.onActivate(pair.id); }
      },
    }, icon, names, chips, remove);

    this.list.append(row);
    this.rows.set(pair.id, { row, chips });
    this.setCount(this.rows.size);
  }

  // chips: array of { cls, text } — replaced wholesale
  setChips(id, chips) {
    const entry = this.rows.get(id);
    if (!entry) return;
    entry.chips.textContent = '';
    if (!chips.length) {
      entry.chips.append(h('span', { class: 'chip same', text: 'no changes' }));
    } else {
      for (const c of chips) {
        entry.chips.append(h('span', { class: `chip ${c.cls}`, text: c.text }));
      }
    }
  }

  setActive(id) {
    this.activeId = id;
    for (const [rowId, entry] of this.rows) {
      entry.row.classList.toggle('is-active', rowId === id);
    }
  }

  removeRow(id) {
    const entry = this.rows.get(id);
    if (!entry) return;
    entry.row.remove();
    this.rows.delete(id);
    this.setCount(this.rows.size);
  }

  clear() {
    this.list.textContent = '';
    this.rows.clear();
    this.setCount(0);
  }
}

// filename → 1–2 char abbreviation for the queue icon.
// Images use their extension-derived abbreviation too (e.g. PNG, JPG) so
// different formats are distinguishable instead of every image showing "IM".
export function fileAbbr(name, kind) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  if (m) return m[1].slice(0, 2).toUpperCase();
  if (kind === 'image') return 'IM';
  return (name || '?').slice(0, 2).toUpperCase();
}
