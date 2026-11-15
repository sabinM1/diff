// Image comparison: canvas pipeline, alignment, and the six compare modes.
// All pixel data stays local — canvases are drawn from decoded bitmaps and
// analysis runs in the image worker.
import { pixelDiff, alignImages } from '../workers/client.js';
import { store } from '../storage/store.js';
import { h, fmtBytes } from '../ui/dom.js';

const MAX_COMPARE = 2048;    // analysis + render resolution cap (longest side)
const TILE = 24;             // highlight bounding-box tile size (compare px)

export class ImagePane {
  constructor(hooks) {
    this.hooks = hooks; // { onStats }
    this.a = null;
    this.b = null;
    this.mode = 'split';
    this.offset = { x: 0, y: 0 }; // native px, B relative to A
    this.view = { z: 1, tx: 0, ty: 0 };
    this.diffMap = null;
    this.boxes = [];
    this.flickerOn = false;
    this.flickerPhase = 0;
    this.alignBusy = false;
    this.epoch = 0;
    this.sliderPos = store.get().sliderPos;
    this._diffAbort = null; // AbortController for in-flight pixelDiff
    this.contentW = 0;      // logical stage width (split mode = 2*W + gap)

    this.el = document.getElementById('imgarea');
    this.stage = document.getElementById('imgstage');
    this.box = document.getElementById('imgbox');
    this.zoompan = document.getElementById('zoompan');
    this.stack = document.getElementById('cvstack');
    this.boxesEl = document.getElementById('boxes');
    this.handle = document.getElementById('divhandle');
    this.controls = document.getElementById('imgcontrols');
    this.cards = document.getElementById('detailsCards');
    this.rail = document.getElementById('detailsView');

    // The divider lives in the un-scaled image box so its hit target stays a
    // constant size while the image zooms. The line is positioned from the
    // rendered image bounds on every view change.
    this.box.append(this.handle);
    this.divLine = h('span', { class: 'div-line' });
    this.divLine.hidden = true;
    this.box.append(this.divLine);

    this.bindPanZoom();
    this.bindHandle();
  }

  // ------------------------------------------------------------- assets --

  async setAssets(a, b) {
    this.epoch++;
    const my = this.epoch;
    this.a = a;
    this.b = b;
    this.offset = { x: 0, y: 0 };
    this.diffMap = null;
    this.boxes = [];
    if (store.get().autoAlign) await this.runAutoAlign(my);
    if (my !== this.epoch) return; // superseded while aligning
    this.buildCompare();
    this.setMode(this.mode, true);
    this.emitStats();
  }

  clear() {
    this.epoch++;
    this._cancelDiff();
    this.a = null;
    this.b = null;
    this.diffMap = null;
    this.boxes = [];
    this.stack.textContent = '';
    this.boxesEl.textContent = '';
    this.controls.textContent = '';
    this.cards.textContent = '';
    this.rail.textContent = '';
    this.rail.hidden = true;
    this.handle.hidden = true;
    this.divLine.hidden = true;
    this.stopFlicker();
    this.zoompan.style.transform = '';
    this.el.hidden = false;
    this.stage.hidden = true;
    document.getElementById('imgempty').hidden = false;
  }

  async runAutoAlign(my) {
    if (!this.a || !this.b || this.alignBusy) return;
    this.alignBusy = true;
    const readout = document.getElementById('offsetReadout');
    const prev = readout.textContent;
    readout.textContent = 'aligning…';
    try {
      // clone the bitmaps: the worker consumes its copies on transfer
      const ba = await createImageBitmap(this.a.bitmap);
      const bb = await createImageBitmap(this.b.bitmap);
      const r = await alignImages(ba, bb);
      if (my === this.epoch) this.offset = { x: r.dx, y: r.dy };
    } catch { /* alignment is best-effort */ }
    this.alignBusy = false;
    if (my === this.epoch) this.updateReadout();
    else readout.textContent = prev;
  }

  updateReadout() {
    const s = this.offset;
    const fmt = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v)}`;
    document.getElementById('offsetReadout').textContent =
      `x ${fmt(s.x)} px · y ${fmt(s.y)} px`;
  }

  nudge(dx, dy) {
    if (!this.a || !this.b) return;
    this.offset.x += dx;
    this.offset.y += dy;
    this.buildCompare();
    this.setMode(this.mode, true);
    this.updateReadout();
    this.emitStats();
  }

  async resetAlignment() {
    if (!this.a || !this.b) return;
    this.offset = { x: 0, y: 0 };
    if (store.get().autoAlign) await this.runAutoAlign(this.epoch);
    this.buildCompare();
    this.setMode(this.mode, true);
    this.updateReadout();
    this.emitStats();
  }

  // ------------------------------------------------------ compare space --

  buildCompare() {
    if (!this.a || !this.b) return;
    this._cancelDiff();
    const max0 = Math.max(this.a.w, this.b.w, this.a.h, this.b.h);
    const k = Math.min(1, MAX_COMPARE / max0);
    this.W = Math.max(1, Math.round(Math.max(this.a.w, this.b.w) * k));
    this.H = Math.max(1, Math.round(Math.max(this.a.h, this.b.h) * k));
    this.k = k;
    this.contentW = this.W; // reset; split mode widens this
    this.cvA = mkCanvas(this.W, this.H);
    this.cvB = mkCanvas(this.W, this.H);
    const ca = this.cvA.getContext('2d');
    const cb = this.cvB.getContext('2d', { willReadFrequently: true });
    // "matched dimensions": both stretched into the shared compare space
    ca.drawImage(this.a.bitmap, 0, 0, this.W, this.H);
    cb.clearRect(0, 0, this.W, this.H);
    cb.drawImage(this.b.bitmap, this.offset.x * k, this.offset.y * k, this.W, this.H);
    this.diffMap = null;
    this.boxes = [];
    this.fit();
  }

  fit() {
    const bw = this.box.clientWidth || 600;
    const bh = this.box.clientHeight || 400;
    const cw = this.contentW || this.W;
    const z = Math.min(bw / cw, bh / this.H, 1);
    this.view = { z, tx: (bw - cw * z) / 2, ty: (bh - this.H * z) / 2 };
    this.applyView();
  }

  applyView() {
    const { z, tx, ty } = this.view;
    const cw = this.contentW || this.W;
    this.zoompan.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
    this.stack.style.width = `${cw}px`;
    this.stack.style.height = `${this.H}px`;
    // NOTE: never touch canvas.width/height here — that clears the bitmap
    if (this.mode === 'slider' && this.a) this.placeDivider();
  }

  // ------------------------------------------------------- pan and zoom --

  bindPanZoom() {
    this.box.addEventListener('wheel', (e) => {
      if (!this.a || e.ctrlKey) return;
      e.preventDefault();
      const r = this.box.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const { z, tx, ty } = this.view;
      const nz = Math.min(8, Math.max(0.05, z * Math.exp(-e.deltaY * 0.0015)));
      const f = nz / z;
      this.view = {
        z: nz,
        tx: px - (px - tx) * f,
        ty: py - (py - ty) * f,
      };
      this.applyView();
    }, { passive: false });

    this.box.addEventListener('dblclick', () => this.fit());
    window.addEventListener('resize', () => { if (this.a) this.fit(); });

    let panning = null;
    this.box.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.divhandle')) return;
      if (!this.a) return;
      panning = { x: e.clientX, y: e.clientY, tx: this.view.tx, ty: this.view.ty };
      this.box.setPointerCapture(e.pointerId);
      this.box.classList.add('is-panning');
    });
    this.box.addEventListener('pointermove', (e) => {
      if (!panning) return;
      this.view.tx = panning.tx + (e.clientX - panning.x);
      this.view.ty = panning.ty + (e.clientY - panning.y);
      this.applyView();
    });
    const endPan = (e) => {
      if (!panning) return;
      panning = null;
      this.box.classList.remove('is-panning');
      try { this.box.releasePointerCapture(e.pointerId); } catch { /* ok */ }
    };
    this.box.addEventListener('pointerup', endPan);
    this.box.addEventListener('pointercancel', endPan);
    this.box.classList.add('is-pan');
  }

  // ------------------------------------------------------------- modes --

  setMode(mode, force = false) {
    if (mode === this.mode && !force && this.a) {
      this.renderMode();
      return;
    }
    // Clear diffMap when leaving highlight mode to avoid stale data
    if (this.mode === 'highlight' && mode !== 'highlight') {
      this._cancelDiff();
      this.diffMap = null;
      this.boxes = [];
    }
    this.mode = mode;
    if (!this.a || !this.b) return;
    this.stopFlicker();
    this.stack.textContent = '';
    this.boxesEl.textContent = '';
    this.controls.textContent = '';
    const showStage = mode !== 'details';
    this.stage.hidden = !showStage;
    this.cards.hidden = mode !== 'details';
    this.handle.hidden = mode !== 'slider';
    this.divLine.hidden = mode !== 'slider';
    document.getElementById('alignbar').hidden =
      !(mode === 'split' || mode === 'fade' || mode === 'flicker' || mode === 'slider');
    if (!showStage) {
      this.buildDetailsCards();
      this.renderRail();
      return;
    }
    this.renderMode();
    this.renderRail();
    this.emitStats();
  }

  renderMode() {
    const mode = this.mode;
    this.stack.textContent = '';
    this.boxesEl.textContent = '';
    this.contentW = this.W; // non-split modes use the per-image width
    if (mode === 'split') {
      // Two full-size images side by side on ONE canvas: zoom/pan is synced
      // by construction (one shared transform), and zooming reveals the same
      // region on both sides at full detail.
      const gap = Math.max(8, Math.round(this.W * 0.03));
      const cw = this.W * 2 + gap;
      this.contentW = cw;
      const c = mkCanvas(cw, this.H);
      c.id = 'splitCv';
      const ctx = c.getContext('2d');
      ctx.fillStyle = cssVar('--gap-bg');
      ctx.fillRect(0, 0, cw, this.H);
      ctx.drawImage(this.cvA, 0, 0, this.W, this.H);
      ctx.drawImage(this.cvB, this.W + gap, 0, this.W, this.H);
      this.stack.append(c);
      this.controls.append(h('span', { class: 'imgctl' },
        'A (left) ⇄ B (right) · scroll to zoom · drag to pan · synced'));
    } else if (mode === 'fade') {
      const a = cloneCanvas(this.cvA);
      const b = cloneCanvas(this.cvB);
      b.className = 'fade-cv';
      b.style.opacity = String(store.get().fade);
      this.stack.append(a, b);
      this.controls.append(sliderCtl('Opacity', store.get().fade, 0, 1, 0.01, (v) => {
        store.set({ fade: v });
        b.style.opacity = String(v);
      }, (v) => `${Math.round(v * 100)}%`));
    } else if (mode === 'flicker') {
      const a = cloneCanvas(this.cvA);
      const b = cloneCanvas(this.cvB);
      b.className = 'fade-cv';
      b.style.opacity = '0';
      this.stack.append(a, b);
      const hz = store.get().flickerHz;
      const ctl = sliderCtl('Rate', hz, 1, 10, 0.5, (v) => {
        store.set({ flickerHz: v });
        label.textContent = `${v} Hz`;
      }, (v) => `${v} Hz`);
      const label = ctl.querySelector('.ctl-val');
      label.textContent = `${hz} Hz`;
      this.controls.append(ctl);
      this.startFlicker(a, b);
    } else if (mode === 'slider') {
      const a = cloneCanvas(this.cvA);
      const b = cloneCanvas(this.cvB);
      b.id = 'sliderB';
      this.sliderPos = store.get().sliderPos;
      // Both canvases must overlay exactly — use absolute positioning like fade mode
      a.style.position = 'absolute';
      a.style.inset = '0';
      b.style.position = 'absolute';
      b.style.inset = '0';
      this.stack.append(a, b);
      const dir = store.get().sliderDir;
      const dirBtn = h('button', {
        type: 'button',
        class: 'btn tiny',
        text: dir === 'v' ? 'Vertical ⇕' : 'Horizontal ⇔',
        onclick: () => {
          const next = store.get().sliderDir === 'v' ? 'h' : 'v';
          store.set({ sliderDir: next });
          this.placeDivider();
          dirBtn.textContent = next === 'v' ? 'Vertical ⇕' : 'Horizontal ⇔';
        },
      });
      this.controls.append(dirBtn);
      this.placeDivider();
    } else if (mode === 'highlight') {
      const c = mkCanvas(this.W, this.H);
      c.id = 'highlightCv';
      this.stack.append(c);
      const str = store.get().highlightStrength;
      const ctl = sliderCtl('Threshold', str, 0, 100, 1, (v) => {
        store.set({ highlightStrength: v });
        label.textContent = String(v);
        this.renderHighlight();
        this.emitStats();
      }, (v) => String(v));
      const label = ctl.querySelector('.ctl-val');
      label.textContent = String(str);
      this.controls.append(ctl);
      this.renderHighlight();
    }
    this.fit();
    this.renderRail();
  }

  startFlicker(a, b) {
    this.stopFlicker();
    this.flickerOn = true;
    let last = -1;
    const tick = (now) => {
      if (!this.flickerOn || this.mode !== 'flicker') return;
      const hz = store.get().flickerHz;
      const phase = Math.floor((now / 1000) * hz) % 2;
      if (phase !== last) {
        b.style.opacity = phase ? '1' : '0';
        last = phase;
      }
      this.flickerRaf = requestAnimationFrame(tick);
    };
    this.flickerRaf = requestAnimationFrame(tick);
  }

  stopFlicker() {
    this.flickerOn = false;
    if (this.flickerRaf) cancelAnimationFrame(this.flickerRaf);
    this.flickerRaf = null;
  }

  // ------------------------------------------------------- slider mode --

  placeDivider(pos = this.sliderPos) {
    const dir = store.get().sliderDir;
    pos = Math.min(100, Math.max(0, pos));
    const b = this.stack.querySelector('#sliderB');
    if (!b) return;
    const vertical = dir === 'v';
    b.style.clipPath = vertical
      ? `inset(0 0 0 ${pos}%)`
      : `inset(${pos}% 0 0 0)`;

    // Position the line and handle against the *rendered image* bounds, not
    // the outer box: the image is letterboxed/zoomed, and using the box would
    // make the divider drift away from the pointer.
    const zp = this.zoompan.getBoundingClientRect();
    const bx = this.box.getBoundingClientRect();
    const left = zp.left - bx.left;
    const top = zp.top - bx.top;
    const w = zp.width;
    const hgt = zp.height;

    const line = this.divLine;
    line.hidden = false;
    if (vertical) {
      Object.assign(line.style, {
        left: `${left + (w * pos) / 100}px`, top: `${top}px`,
        width: '2px', height: `${hgt}px`, transform: 'translateX(-1px)',
      });
    } else {
      Object.assign(line.style, {
        left: `${left}px`, top: `${top + (hgt * pos) / 100}px`,
        width: `${w}px`, height: '2px', transform: 'translateY(-1px)',
      });
    }

    this.handle.hidden = false;
    const hx = vertical ? left + (w * pos) / 100 : left + w / 2;
    const hy = vertical ? top + hgt / 2 : top + (hgt * pos) / 100;
    Object.assign(this.handle.style, {
      left: `${hx}px`, top: `${hy}px`,
      marginLeft: '-15px', marginTop: '-15px',
      cursor: vertical ? 'ew-resize' : 'ns-resize',
    });
    this.handle.style.transform = '';
    this.handle.setAttribute('aria-valuenow', String(Math.round(pos)));
    this.handle.setAttribute('aria-orientation', vertical ? 'vertical' : 'horizontal');
  }

  bindHandle() {
    let dragging = false;
    this.handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      this.handle.classList.add('is-drag');
      this.handle.setPointerCapture(e.pointerId);
    });
    this.handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const r = this.zoompan.getBoundingClientRect();
      const vertical = store.get().sliderDir === 'v';
      const pos = vertical
        ? ((e.clientX - r.left) / Math.max(1, r.width)) * 100
        : ((e.clientY - r.top) / Math.max(1, r.height)) * 100;
      this.sliderPos = Math.min(100, Math.max(0, pos));
      this.placeDivider(this.sliderPos);
    });
    const end = (e) => {
      dragging = false;
      this.handle.classList.remove('is-drag');
      // Persist once at the end of the gesture instead of on every move.
      store.set({ sliderPos: this.sliderPos });
      try { this.handle.releasePointerCapture(e.pointerId); } catch { /* ok */ }
    };
    this.handle.addEventListener('pointerup', end);
    this.handle.addEventListener('pointercancel', end);
    this.handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 5 : 1;
      let pos = this.sliderPos;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') pos -= step;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') pos += step;
      else return;
      e.preventDefault();
      this.sliderPos = Math.min(100, Math.max(0, pos));
      store.set({ sliderPos: this.sliderPos });
      this.placeDivider(this.sliderPos);
    });
  }

  // ----------------------------------------------------- highlight mode --

  _cancelDiff() {
    if (this._diffAbort) {
      this._diffAbort.abort();
      this._diffAbort = null;
    }
  }

  async ensureDiffMap() {
    if (this.diffMap || !this.a || !this.b) return;
    this._cancelDiff();
    const abort = new AbortController();
    this._diffAbort = abort;
    const ca = this.cvA.getContext('2d', { willReadFrequently: true });
    const cb = this.cvB.getContext('2d', { willReadFrequently: true });
    const da = ca.getImageData(0, 0, this.W, this.H).data;
    const db = cb.getImageData(0, 0, this.W, this.H).data;
    try {
      const r = await pixelDiff(da.slice(), db.slice(), this.W, this.H);
      if (abort.signal.aborted) return; // superseded by an alignment/mode change
      this.diffMap = r.map;
      this.computeBoxes();
    } catch (e) {
      if (e.name !== 'AbortError') { /* stats degrade gracefully */ }
    } finally {
      // Only release the slot if we still own it — a newer request may have
      // replaced _diffAbort while we were awaiting.
      if (this._diffAbort === abort) this._diffAbort = null;
    }
  }

  computeBoxes() {
    if (!this.diffMap) return;
    const th = threshold();
    const { W, H } = this;
    const cols = Math.ceil(W / TILE), rows = Math.ceil(H / TILE);
    const active = new Uint8Array(cols * rows);
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        let cnt = 0;
        const y1 = Math.min(H, (ty + 1) * TILE);
        const x1 = Math.min(W, (tx + 1) * TILE);
        for (let y = ty * TILE; y < y1; y += 2) {
          for (let x = tx * TILE; x < x1; x += 2) {
            if (this.diffMap[y * W + x] > th) cnt++;
          }
        }
        active[ty * cols + tx] = cnt > 4 ? 1 : 0;
      }
    }
    // flood-merge adjacent active tiles into bounding boxes
    const seen = new Uint8Array(cols * rows);
    const boxes = [];
    for (let i = 0; i < active.length; i++) {
      if (!active[i] || seen[i]) continue;
      const queue = [i];
      seen[i] = 1;
      let x0 = cols, x1 = -1, y0 = rows, y1 = -1;
      while (queue.length) {
        const cur = queue.pop();
        const cx = cur % cols, cy = (cur / cols) | 0;
        x0 = Math.min(x0, cx); x1 = Math.max(x1, cx);
        y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
        for (const d of [-1, 1, -cols, cols]) {
          const nx = cur + d;
          if (nx < 0 || nx >= active.length || seen[nx] || !active[nx]) continue;
          if (d === -1 && cx === 0) continue;
          if (d === 1 && cx === cols - 1) continue;
          seen[nx] = 1;
          queue.push(nx);
        }
      }
      boxes.push({
        x: x0 * TILE, y: y0 * TILE,
        w: Math.min(W, (x1 + 1) * TILE) - x0 * TILE,
        h: Math.min(H, (y1 + 1) * TILE) - y0 * TILE,
        sign: classifyBox(this.cvA, this.cvB, x0 * TILE, y0 * TILE,
          Math.min(W, (x1 + 1) * TILE), Math.min(H, (y1 + 1) * TILE)),
      });
    }
    this.boxes = boxes.slice(0, 60); // keep the overlay readable
  }

  async renderHighlight() {
    await this.ensureDiffMap();
    const c = this.stack.querySelector('#highlightCv');
    if (!c || !this.diffMap) return;
    const ctx = c.getContext('2d');
    const th = threshold();
    const strong = cssVar('--changed-text');
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.drawImage(this.cvA, 0, 0);
    const img = ctx.getImageData(0, 0, this.W, this.H);
    const d = img.data;
    const [sr, sg, sb] = hexToRgb(strong);
    const map = this.diffMap;
    for (let p = 0, i = 0; p < map.length; p++, i += 4) {
      const v = map[p];
      if (v <= th) continue;
      // tint: stronger the larger the difference
      const f = Math.min(1, (v - th) / (255 - th)) * 0.75 + 0.25;
      d[i] = Math.round(d[i] * (1 - f) + sr * f);
      d[i + 1] = Math.round(d[i + 1] * (1 - f) + sg * f);
      d[i + 2] = Math.round(d[i + 2] * (1 - f) + sb * f);
    }
    ctx.putImageData(img, 0, 0);
    // bounding boxes as DOM overlays (they follow zoom/pan with the stage)
    this.boxesEl.textContent = '';
    this.boxes.forEach((box, idx) => {
      const el = h('div', { class: 'diff-box' });
      Object.assign(el.style, {
        left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px`,
      });
      el.append(h('span', { class: 'db-tag', text: `${box.sign}${idx + 1}` }));
      this.boxesEl.append(el);
    });
    this.emitStats();
  }

  async emitStats() {
    if (!this.a || !this.b) return;
    let pct = null;
    if (this.mode === 'highlight' && this.diffMap) {
      const th = threshold();
      let diff = 0;
      for (let p = 0; p < this.diffMap.length; p++) if (this.diffMap[p] > th) diff++;
      pct = (diff / this.diffMap.length) * 100;
    }
    this.hooks.onStats?.({
      a: this.a, b: this.b,
      W: this.W, H: this.H,
      offset: this.offset,
      pct,
      regions: { add: this.boxes.filter(b => b.sign === '+').length, rem: this.boxes.filter(b => b.sign === '−').length },
    });
  }

  // ------------------------------------------------------------ export --

  async downloadPNG() {
    if (!this.a) return;
    const c = mkCanvas(this.W, this.H);
    const ctx = c.getContext('2d');
    if (this.mode === 'highlight') {
      await this.ensureDiffMap();
      ctx.drawImage(this.stack.querySelector('#highlightCv') ?? this.cvA, 0, 0);
      // bake the boxes in — the export should carry the annotations
      const th = threshold();
      const strong = cssVar('--changed-text');
      ctx.strokeStyle = strong;
      ctx.font = '12px monospace';
      this.boxes.forEach((box, idx) => {
        ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w, box.h);
        ctx.fillStyle = cssVar('--changed-bg');
        ctx.fillRect(box.x, box.y - 14, 24, 14);
        ctx.fillStyle = strong;
        ctx.fillText(`${box.sign}${idx + 1}`, box.x + 4, box.y - 2);
      });
      void th;
    } else if (this.mode === 'slider') {
      const pos = this.sliderPos;
      const dir = store.get().sliderDir;
      ctx.drawImage(this.cvA, 0, 0);
      ctx.save();
      if (dir === 'v') {
        ctx.beginPath();
        ctx.rect(this.W * pos / 100, 0, this.W, this.H);
        ctx.clip();
      } else {
        ctx.beginPath();
        ctx.rect(0, this.H * pos / 100, this.W, this.H);
        ctx.clip();
      }
      ctx.drawImage(this.cvB, 0, 0);
      ctx.restore();
      ctx.strokeStyle = cssVar('--accent');
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (dir === 'v') {
        ctx.moveTo(this.W * pos / 100, 0);
        ctx.lineTo(this.W * pos / 100, this.H);
      } else {
        ctx.moveTo(0, this.H * pos / 100);
        ctx.lineTo(this.W, this.H * pos / 100);
      }
      ctx.stroke();
    } else {
      return;
    }
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `diffbench-${this.mode}.png` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ----------------------------------------------------------- details --

  buildDetailsCards() {
    if (!this.a || !this.b) return;
    const rows = (asset) => {
      const f = [
        ['Filename', asset.name],
        ['Dimensions', `${asset.w} × ${asset.h}`],
        ['File size', fmtBytes(asset.bytes)],
        ['MIME type', asset.mime],
        ['Last modified', new Date(asset.lastModified).toLocaleString()],
        ...Object.entries(asset.exif),
      ];
      return f;
    };
    const ra = rows(this.a), rb = rows(this.b);
    const mapA = new Map(ra), mapB = new Map(rb);

    // Unified comparison: union of every key from both sides so B-only EXIF
    // fields are not silently dropped. Only differing rows are listed.
    const allKeys = new Set([
      ...['Filename', 'Dimensions', 'File size', 'MIME type', 'Last modified'],
      ...ra.map(([k]) => k),
      ...rb.map(([k]) => k),
    ]);
    const diffs = [];
    for (const k of allKeys) {
      const va = mapA.get(k);
      const vb = mapB.get(k);
      if (va === vb) continue;
      diffs.push([k, va ?? '—', vb ?? '—']);
    }
    const grid = h('div', { class: 'exif-compare' });
    if (diffs.length) {
      grid.append(h('div', { class: 'dcard-head', text: `Differences (${diffs.length})` }));
      for (const [k, va, vb] of diffs) {
        grid.append(h('div', { class: 'meta-row exif-diff' },
          h('span', { class: 'mk-key', text: k }),
          h('span', { class: 'mk-val old-val', text: String(va) }),
          h('span', { class: 'mk-val new-val chg', text: String(vb) }),
        ));
      }
    } else {
      grid.append(h('div', { class: 'dcard-head', text: 'No metadata differences' }));
    }

    const card = (asset, vals, other) => {
      const c = h('div', { class: 'dcard' }, h('div', { class: 'dcard-head', text: asset.name }));
      for (const [k, v] of vals) {
        const changed = other.has(k) && other.get(k) !== v;
        c.append(h('div', { class: 'meta-row' },
          h('span', { class: 'mk-key', text: k }),
          h('span', { class: `mk-val${changed ? ' chg' : ''}`, text: v }),
        ));
      }
      return c;
    };
    this.cards.textContent = '';
    this.cards.append(
      h('div', { class: 'dcard exif-diff-card' }, grid),
      card(this.a, ra, mapB),
      card(this.b, rb, mapA),
    );
  }

  renderRail() {
    if (!this.a || !this.b) return;
    const sameSize = this.a.w === this.b.w && this.a.h === this.b.h;
    const chips = [];
    if (!sameSize) chips.push(h('span', { class: 'chip chg', text: 'size differs' }));
    else chips.push(h('span', { class: 'chip same', text: 'same size' }));
    if (this.boxes.length) {
      const add = this.boxes.filter(b => b.sign === '+').length;
      const rem = this.boxes.filter(b => b.sign === '−').length;
      if (add) chips.push(h('span', { class: 'chip add', text: `+${add} region${add === 1 ? '' : 's'}` }));
      if (rem) chips.push(h('span', { class: 'chip rem', text: `−${rem} region${rem === 1 ? '' : 's'}` }));
    }
    const keys = new Map([
      ['Dimensions', (x) => `${x.w} × ${x.h}`],
      ['File size', (x) => fmtBytes(x.bytes)],
      ['MIME type', (x) => x.mime],
      ['Last modified', (x) => new Date(x.lastModified).toLocaleString()],
    ]);
    const exifKeys = new Set([...Object.keys(this.a.exif), ...Object.keys(this.b.exif)]);
    for (const k of exifKeys) keys.set(k, (x) => x.exif[k] ?? '—');

    const rowsEl = h('div', { class: 'dr-list' });
    for (const [k, get] of keys) {
      const va = get(this.a);
      const vb = get(this.b);
      const changed = va !== vb;
      rowsEl.append(h('div', { class: 'meta-row' },
        h('span', { class: 'mk-key', text: k }),
        h('span', {
          class: `mk-val${changed ? ' chg' : ' faint'}`,
          html: changed ? `${esc(va)} → ${esc(vb)}` : esc(va),
        }),
      ));
    }
    this.rail.textContent = '';
    this.rail.append(
      h('div', { class: 'dr-head' },
        h('h2', { class: 'rail-title' }, h('span', { class: 'faint' }, '# '), 'File details'),
        h('button', {
          type: 'button', class: 'iconbtn tiny', 'aria-label': 'Close details',
          title: 'Close', onclick: () => store.set({ detailsOpen: false }),
        }, h('span', { text: '×' })),
      ),
      h('div', { class: 'dr-headline mono' }, `${this.a.name} ⇄ ${this.b.name}`),
      h('div', { class: 'dr-chips' }, chips),
      rowsEl,
    );
  }
}

// ------------------------------------------------------------- helpers --

function mkCanvas(w, hgt) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hgt;
  return c;
}

function cloneCanvas(c) {
  const n = mkCanvas(c.width, c.height);
  n.getContext('2d').drawImage(c, 0, 0);
  return n;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function hexToRgb(s) {
  const m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function threshold() {
  return Math.round(store.get().highlightStrength * 0.8);
}

function sliderCtl(label, value, min, max, step, onInput, fmt) {
  const val = h('span', { class: 'ctl-val', text: fmt(value) });
  const input = h('input', {
    type: 'range', min: String(min), max: String(max), step: String(step),
    value: String(value), 'aria-label': label,
  });
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    val.textContent = fmt(v);
    onInput(v);
  });
  return h('div', { class: 'imgctl' },
    h('span', { class: 'microlabel', text: label }), input, val);
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// sign of a changed region: compare mean luminance inside the box
function classifyBox(cvA, cvB, x0, y0, x1, y1) {
  const a = cvA.getContext('2d').getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data;
  const b = cvB.getContext('2d').getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data;
  let sa = 0, sb = 0;
  const n = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    sa += a[i] + a[i + 1] + a[i + 2];
    sb += b[i] + b[i + 1] + b[i + 2];
  }
  sa /= n; sb /= n;
  // B much darker here → content removed; otherwise content added
  return sb < sa * 0.72 ? '−' : '+';
}
