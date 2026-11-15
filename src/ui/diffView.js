// Virtualized diff renderer. Only visible rows exist in the DOM; each row's
// HTML (including syntax highlighting) is produced lazily for the visible
// chunk and memoized. Line-wrap mode disables virtualization since row
// heights become content-dependent.
import { buildRows, totalHeight, rowHeight } from '../diff/model.js';
import { generateUnifiedDiff } from '../diff/model.js';
import { getLang, lineStates, renderCodeHTML } from '../diff/highlight.js';
import { codeCharWidth, copyText } from './dom.js';

const GUTTER_W = { split: 58, unified: 88 };
const CODE_PAD = 28; // 14px padding each side
const OVERSCAN = 12;

export class DiffView {
  constructor(wrap, list) {
    this.wrap = wrap;
    this.list = list;
    this.rows = [];
    this.prefix = new Float64Array(1); // offsets, prefix[i] = top of row i
    this.model = null;
    this.expandSet = new Set();
    this.htmlCache = new Map();
    this.epoch = 0;
    this.rendered = new Map(); // rowIndex → element
    this.lang = null;
    this.statesA = null;
    this.statesB = null;
    this.prefs = null;
    this.pending = 0;
    this.names = { a: 'file-a', b: 'file-b' };

    wrap.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(wrap);
    list.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('.h-copy');
      if (copyBtn && copyBtn.dataset.hunk !== undefined) {
        e.stopPropagation();
        this.copyHunk(Number(copyBtn.dataset.hunk));
        return;
      }
      const fold = e.target.closest('.vrow-fold');
      if (fold && fold.dataset.key) {
        this.expandSet.add(fold.dataset.key);
        this.rebuild();
      }
    });
    // Right-click a hunk header copies that hunk as markdown
    list.addEventListener('contextmenu', (e) => {
      const hunkRow = e.target.closest('.vrow-hunk');
      if (!hunkRow) return;
      const idx = hunkRow.dataset.hunk;
      if (idx === undefined) return;
      e.preventDefault();
      this.copyHunk(Number(idx));
    });
  }

  setNames(a, b) {
    this.names = { a: a || 'file-a', b: b || 'file-b' };
  }

  setPrefs(prefs) {
    const prev = this.prefs;
    this.prefs = prefs;
    if (!this.model) return;
    const structural = !prev
      || prev.layout !== prefs.layout
      || prev.hideUnchanged !== prefs.hideUnchanged;
    const cosmetic = !prev
      || prev.syntax !== prefs.syntax
      || prev.manualLang !== prefs.manualLang
      || prev.wrap !== prefs.wrap
      || prev.cvd !== prefs.cvd;
    if (structural) this.rebuild();
    else if (cosmetic) {
      this.htmlCache.clear();
      this.prepareHighlight();
      this.rerenderAll();
    }
  }

  setModel(model, prefs) {
    this.model = model;
    this.prefs = prefs;
    this.expandSet = new Set();
    this.epoch++;
    this.rebuild();
  }

  clear() {
    this.model = null;
    this.rows = [];
    this.htmlCache.clear();
    this.rendered.clear();
    this.list.textContent = '';
    this.list.style.height = '0px';
  }

  prepareHighlight() {
    const p = this.prefs;
    this.lang = null;
    this.statesA = null;
    this.statesB = null;
    if (!this.model || p.syntax === 'off') return;
    const id = p.syntax === 'manual'
      ? p.manualLang
      : this.model.lang ?? null;
    this.lang = getLang(id);
    if (!this.lang) return;
    // one linear pass per document to carry block-comment/docstring state
    this.statesA = lineStates(this.model.aLines, this.lang);
    this.statesB = lineStates(this.model.bLines, this.lang);
  }

  rebuild() {
    if (!this.model || !this.prefs) return;
    this.prepareHighlight();
    this.rows = buildRows(this.model, {
      layout: this.prefs.layout,
      hideUnchanged: this.prefs.hideUnchanged,
      marksA: this.model.marksA,
      marksB: this.model.marksB,
    }, this.expandSet);
    // prefix-sum row offsets for binary search
    const n = this.rows.length;
    this.prefix = new Float64Array(n + 1);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      this.prefix[i] = acc;
      acc += rowHeight(this.rows[i]);
    }
    this.prefix[n] = acc;
    let hunkNo = 0;
    for (const row of this.rows) {
      if (row.t === 'hunk') row.hunkIndex = hunkNo++;
    }
    this.htmlCache.clear();
    this.rerenderAll();
  }

  rerenderAll() {
    for (const el of this.rendered.values()) el.remove();
    this.rendered.clear();
    const wrapOn = this.prefs?.wrap;
    if (wrapOn) {
      // static render: no fixed row height, so no virtualization
      this.list.style.height = 'auto';
      this.list.classList.add('wrap');
      const frag = document.createDocumentFragment();
      const cap = 20000;
      for (let i = 0; i < Math.min(this.rows.length, cap); i++) {
        frag.append(this.buildRowEl(i));
      }
      this.list.textContent = '';
      this.list.append(frag);
      return;
    }
    this.list.classList.remove('wrap');
    const cw = codeCharWidth();
    const gut = GUTTER_W[this.prefs?.layout ?? 'split'];
    const maxW = Math.ceil((this.model?.stats.maxLen ?? 1) * cw) + gut + CODE_PAD;
    this.list.style.width = `${maxW}px`;
    this.list.style.minWidth = '100%';
    this.list.style.height = `${this.prefix[this.prefix.length - 1]}px`;
    this.schedule();
  }

  schedule() {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.renderVisible();
    });
  }

  indexAt(y) {
    let lo = 0, hi = this.rows.length - 1, res = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.prefix[mid] <= y) { res = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return res;
  }

  renderVisible() {
    if (this.prefs?.wrap) return; // static render already done
    const wrap = this.wrap;
    const top = wrap.scrollTop;
    const bottom = top + wrap.clientHeight;
    let start = this.indexAt(Math.max(0, top - 200));
    let end = this.indexAt(bottom + 400) + 1 + OVERSCAN;
    start = Math.max(0, start - OVERSCAN);
    end = Math.min(this.rows.length, end);
    // drop far-offscreen rows
    for (const [idx, el] of this.rendered) {
      if (idx < start || idx >= end) {
        el.remove();
        this.rendered.delete(idx);
      }
    }
    for (let i = start; i < end; i++) {
      if (this.rendered.has(i)) continue;
      const el = this.buildRowEl(i);
      el.style.top = `${this.prefix[i]}px`;
      this.list.append(el);
      this.rendered.set(i, el);
    }
  }

  rowHTML(row) {
    const p = this.prefs;
    const split = p.layout === 'split';
    const lang = this.lang;
    const mk = (text, marks, idx, states, markClass) => {
      if (!text) return '';
      const st = states && idx >= 0 ? states[idx] : 0;
      return renderCodeHTML(text, lang, st, marks, markClass);
    };
    if (row.t === 'hunk') {
      const m = /^(@@ [^@]+@@ ?)(.*)$/.exec(row.label);
      const sig = m ? m[1] : row.label;
      const rest = m ? m[2] : '';
      const idx = row.hunkIndex ?? -1;
      const btn = `<button type="button" class="h-copy" data-hunk="${idx}" title="Copy hunk as markdown" aria-label="Copy hunk as markdown" style="float:right;margin-left:12px;padding:0 7px;font:inherit;line-height:1.5;color:inherit;background:transparent;border:1px solid currentColor;border-radius:4px;cursor:pointer;opacity:.75">Copy</button>`;
      return `<div class="vrow vrow-hunk" data-hunk="${idx}">${btn}<span class="h-sign">${escHtml(sig)}</span>${escHtml(rest)}</div>`;
    }
    if (row.t === 'fold') {
      return `<button type="button" class="vrow vrow-fold" data-key="${escHtml(row.key)}">⋯ ${row.count} unchanged line${row.count === 1 ? '' : 's'} ⋯</button>`;
    }
    if (row.t === 'ctx') {
      if (!split) {
        return urow('ctx', row.aNo, row.bNo, '', mk(row.at, null, row.aNo - 1, this.statesA, 'wadd'));
      }
      return drow(
        cell('ctx', row.aNo, '', mk(row.at, null, row.aNo - 1, this.statesA, 'wadd')),
        cell('ctx', row.bNo, '', mk(row.bt, null, row.bNo - 1, this.statesB, 'wadd')),
      );
    }
    if (row.t === 'pair') {
      const l = row.l, r = row.r;
      const lcls = l.ty === 3 ? 'gap' : 'del';
      const rcls = r.ty === 3 ? 'gap' : 'add';
      return drow(
        cell(lcls, l.no, l.ty === 2 ? '−' : '', mk(l.text, l.marks, l.no - 1, this.statesA, 'wdel')),
        cell(rcls, r.no, r.ty === 1 ? '+' : '', mk(r.text, r.marks, r.no - 1, this.statesB, 'wadd')),
      );
    }
    // unified del/add rows
    const cls = row.t === 'del' ? 'del' : 'add';
    const marker = row.t === 'del' ? '−' : '+';
    const states = row.t === 'del' ? this.statesA : this.statesB;
    const marks = row.t === 'del' ? row.marks : row.marks;
    const idx = (row.t === 'del' ? row.aNo : row.bNo) - 1;
    const markClass = row.t === 'del' ? 'wdel' : 'wadd';
    return urow(cls, row.aNo, row.bNo, marker, mk(row.text, marks, idx, states, markClass));
  }

  buildRowEl(i) {
    const cached = this.htmlCache.get(i);
    const row = this.rows[i];
    const height = rowHeight(row);
    let html = cached;
    if (html === undefined) {
      html = this.rowHTML(row);
      if (this.htmlCache.size > 8000) this.htmlCache.clear();
      this.htmlCache.set(i, html);
    }
    const el = document.createElement('div');
    el.className = 'vrow';
    el.style.height = `${height}px`;
    const template = document.createElement('template');
    template.innerHTML = html;
    el.append(...template.content.childNodes);
    return el;
  }

  copyHunk(hunkIndex) {
    const markdown = this.generateHunkMarkdown(hunkIndex);
    if (markdown) copyText(markdown);
    return markdown;
  }

  generateFileMarkdown() {
    if (!this.model) return '';
    const patch = generateUnifiedDiff(this.model, this.names.a, this.names.b);
    return fencedDiff(patch);
  }

  generateHunkMarkdown(hunkIndex) {
    if (!this.model) return '';
    const patch = generateUnifiedDiff(this.model, this.names.a, this.names.b);
    const lines = patch.split('\n');
    // file header (--- / +++ / metadata) precedes the first hunk
    const head = [];
    let i = 0;
    while (i < lines.length && !lines[i].startsWith('@@')) head.push(lines[i++]);
    const hunks = [];
    for (; i < lines.length; i++) {
      if (lines[i].startsWith('@@')) hunks.push([]);
      if (hunks.length) hunks[hunks.length - 1].push(lines[i]);
    }
    const hunk = hunks[hunkIndex];
    if (!hunk) return '';
    return fencedDiff([...head, ...hunk].join('\n'));
  }
}

// Wrap unified diff text in a ```diff fence for pasting into issues/PRs.
function fencedDiff(text) {
  return '```diff\n' + String(text).replace(/\n+$/, '') + '\n```\n';
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function cell(kind, no, marker, codeHtml) {
  const noTxt = no ? String(no) : '';
  return `<div class="dcell ${kind}"><div class="gut"><span class="no">${noTxt}</span><span class="mk">${marker}</span></div><span class="code">${codeHtml}</span></div>`;
}

function drow(leftHtml, rightHtml) {
  return `<div class="drow">${leftHtml}${rightHtml}</div>`;
}

function urow(kind, aNo, bNo, marker, codeHtml) {
  return `<div class="urow ${kind}"><div class="gut"><span class="no no-old">${aNo || ''}</span><span class="no no-new">${bNo || ''}</span><span class="mk">${marker}</span></div><span class="code">${codeHtml}</span></div>`;
}
