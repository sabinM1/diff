// Diffbench orchestrator: mode switching, the text diff pipeline, the batch
// queue, image pairing, shortcuts, and all toolbar/rail wiring.
import { store, getRecent, setRecent } from './storage/store.js';
import { initTheme } from './theme/theme.js';
import { h, $, fmtBytes, fmtPct, plural } from './ui/dom.js';
import { Editors } from './ui/editorPanes.js';
import { DiffView } from './ui/diffView.js';
import { buildSettings } from './ui/settingsRail.js';
import { QueueRail, fileAbbr } from './ui/queueRail.js';
import { segmented } from './ui/controls.js';
import { diffText } from './workers/client.js';
import { detectLang } from './diff/highlight.js';
import { ImageAsset, makeThumb } from './image/loader.js';
import { ImagePane } from './image/imagePane.js';
import { phashBitmap } from './workers/client.js';
import { hamming } from './image/phash.js';
import { downloadPatch, copyDiffMarkdown } from './ui/exporters.js';

const els = {
  app: $('#app'),
  modeSeg: $('#modeSeg'),
  filepair: $('#filepair'),
  fpA: $('#fpA'),
  fpB: $('#fpB'),
  layoutSeg: $('#layoutSeg'),
  compareSeg: $('#compareSeg'),
  swapBtn: $('#swapBtn'),
  clearBtn: $('#clearBtn'),
  autoAlignRow: $('#autoAlignRow'),
  detailsBtn: $('#detailsBtn'),
  downloadPatchBtn: $('#downloadPatchBtn'),
  copyMdBtn: $('#copyMdBtn'),
  settingsBtn: $('#settingsBtn'),
  settingsTopBtn: $('#settingsTopBtn'),
  alignbar: $('#alignbar'),
  emptyState: $('#emptyState'),
  dropzone: $('#dropzone'),
  dropTitle: $('#dropTitle'),
  dropProse: $('#dropProse'),
  recentHint: $('#recentHint'),
  editors: $('#editors'),
  diffarea: $('#diffarea'),
  diffwrap: $('#diffwrap'),
  vlist: $('#vlist'),
  imgarea: $('#imgarea'),
  statsL: $('#statsL'),
  statsR: $('#statsR'),
  railBatch: $('#railBatch'),
  railSide: $('#railSide'),
  settingsView: $('#settingsView'),
  detailsView: $('#detailsView'),
  filePicker: $('#filePicker'),
  addPairBtn: $('#addPairBtn'),
  addFoldersBtn: $('#addFoldersBtn'),
  folderChooser: $('#folderChooser'),
  queueBtn: $('#queueBtn'),
};

// ------------------------------------------------------------ app state --

const state = {
  mode: 'text',           // text | image
  compare: 'split',       // image compare mode
  diffEpoch: 0,
  queue: new Map(),       // id → pair record
  queueSeq: 0,
  activePairId: null,
  assets: { a: null, b: null },
  model: null,
};

const editors = new Editors({
  onInput: (side, value) => {
    if (!value) state.pairsNames[side] = '';
    if (store.get().realtime) scheduleDiff();
    updateEmptyState();
    updateFilepair();
  },
  onFile: (side, file) => loadTextFile(side, file),
  onCompare: () => runDiff(true),
});

state.pairsNames = { a: '', b: '' };

const diffView = new DiffView(els.diffwrap, els.vlist);

const queueRail = new QueueRail($('#queueList'), {
  onActivate: (id) => activatePair(id),
  onRemove: (id) => removePair(id),
});

const imagePane = new ImagePane({
  onStats: (s) => renderImageStats(s),
});

// ------------------------------------------------------------- helpers --

function setMode(mode) {
  state.mode = mode;
  for (const btn of els.modeSeg.querySelectorAll('.seg-item')) {
    const on = btn.dataset.mode === mode;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  const img = mode === 'image';
  els.layoutSeg.hidden = img;
  els.compareSeg.hidden = !img;
  els.autoAlignRow.hidden = !img;
  els.detailsBtn.hidden = !img;
  els.downloadPatchBtn.hidden = img;
  els.copyMdBtn.hidden = img;
  els.editors.hidden = img;
  els.diffarea.hidden = img;
  els.imgarea.hidden = !img;
  els.alignbar.hidden = !img || !['split', 'fade', 'flicker', 'slider'].includes(state.compare);
  els.dropTitle.textContent = img ? 'Drop two images to compare' : 'Drop two files to compare';
  els.dropProse.textContent = img
    ? 'PNG · JPEG · WebP · AVIF — up to 250 MB each.'
    : 'Or paste text below — .txt, .md and code files up to 250 MB each.';
  els.recentHint.hidden = !img;
  els.filePicker.accept = img ? 'image/*' : '';
  updateEmptyState();
  updateRailSide();
  updateFilepair();
  if (img) renderRecentHint();
}

function setCompare(mode) {
  state.compare = mode;
  for (const btn of els.compareSeg.querySelectorAll('.seg-item')) {
    const on = btn.dataset.compare === mode;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  els.alignbar.hidden = !['split', 'fade', 'flicker', 'slider'].includes(mode);
  imagePane.setMode(mode, true);
  updateRailSide();
}

function updateRailSide() {
  const showDetails = state.mode === 'image' && state.assets.a
    && (state.compare === 'details' || store.get().detailsOpen);
  els.settingsView.hidden = !!showDetails;
  els.detailsView.hidden = !showDetails;
  els.detailsBtn.classList.toggle('is-active', showDetails);
}

function updateEmptyState() {
  const hasText = !els.editors.hidden && editors.hasAnyText();
  const hasImages = state.mode === 'image' && !!(state.assets.a && state.assets.b);
  els.emptyState.hidden = hasText || hasImages;
  document.getElementById('imgempty').hidden = hasImages;
  document.getElementById('imgstage').hidden =
    !(state.mode === 'image' && hasImages) || state.compare === 'details';
}

function updateFilepair() {
  let a = 'buffer', b = 'buffer';
  if (state.mode === 'text') {
    a = state.pairsNames.a || editors.value('a') || '';
    b = state.pairsNames.b || editors.value('b') || '';
    if (!state.pairsNames.a) a = a ? 'buffer' : '';
    if (!state.pairsNames.b) b = b ? 'buffer' : '';
  } else {
    a = state.assets.a?.name ?? 'buffer';
    b = state.assets.b?.name ?? 'buffer';
  }
  els.fpA.textContent = a || '—';
  els.fpB.textContent = b || '—';
}

// ------------------------------------------------------- text pipeline --

let diffTimer = 0;
function scheduleDiff() {
  clearTimeout(diffTimer);
  diffTimer = setTimeout(() => runDiff(), 150);
}

// Above these sizes we degrade expensive features instead of rejecting the
// file: syntax highlighting and per-character marks are skipped, and the
// diff falls back to line-level output so the main thread stays responsive.
const LARGE_TEXT_BYTES = 8 * 1024 * 1024;
const CHAR_LIMIT_BYTES = 2 * 1024 * 1024;

async function runDiff(force = false) {
  if (state.mode !== 'text') return;
  const a = editors.value('a');
  const b = editors.value('b');
  if (!a && !b) {
    state.model = null;
    state.huge = false;
    diffView.clear();
    renderTextStats(null);
    els.downloadPatchBtn.hidden = true;
    els.copyMdBtn.hidden = true;
    return;
  }
  if (!force && !store.get().realtime && state.model) return; // wait for Compare
  const my = ++state.diffEpoch;
  const p = store.get();
  const totalBytes = a.length + b.length;
  const huge = totalBytes > LARGE_TEXT_BYTES;
  let precision = p.precision;
  if (huge) precision = 'off';
  else if (precision === 'char' && totalBytes > CHAR_LIMIT_BYTES) precision = 'word';
  const effPrefs = huge ? { ...p, syntax: 'off' } : p;
  let lang = null;
  if (!huge) {
    const langSrc = (state.pairsNames.a || '') + ' ' + (state.pairsNames.b || '');
    if (p.syntax === 'manual') lang = p.manualLang;
    else lang = detectLang(a + '\n' + b, langSrc.trim() || null);
  }
  try {
    const r = await diffText(a, b, { ignoreWs: p.hideWs, precision });
    if (my !== state.diffEpoch) return;
    state.model = { ...r, lang };
    state.huge = huge;
    diffView.setNames(state.pairsNames.a, state.pairsNames.b);
    diffView.setModel(state.model, effPrefs);
    renderTextStats(r.stats, precision, null, huge);
    const hasChanges = r.stats.added + r.stats.removed > 0;
    els.downloadPatchBtn.hidden = !hasChanges;
    els.copyMdBtn.hidden = !hasChanges;
  } catch (err) {
    renderTextStats(null, null, String(err.message ?? err));
    els.downloadPatchBtn.hidden = true;
    els.copyMdBtn.hidden = true;
  }
}

function chip(cls, text) { return h('span', { class: `chip ${cls}`, text }); }

function renderTextStats(stats, precision, error, huge) {
  els.statsL.textContent = '';
  els.statsR.textContent = '';
  if (error) {
    els.statsL.append(h('span', { text: `diff error: ${error}` }));
    return;
  }
  if (!stats) {
    els.statsL.append(h('span', { class: 'faint', text: 'no input' }));
    return;
  }
  if (stats.added === 0 && stats.removed === 0) {
    els.statsL.append(chip('same', 'no changes'), h('span', { class: 'faint', text: 'identical' }));
  } else {
    els.statsL.append(
      chip('add', `+${stats.added}`),
      chip('rem', `−${stats.removed}`),
      h('span', { text: 'lines' }),
      h('span', { class: 'stats-sep', text: '·' }),
      h('span', { text: plural(stats.hunks, 'hunk') }),
      h('span', { class: 'stats-sep', text: '·' }),
      h('span', { text: `${cap(precision ?? 'smart')} precision` }),
    );
  }
  if (huge) {
    els.statsL.append(
      h('span', { class: 'stats-sep', text: '·' }),
      chip('chg', 'large file · highlighting off'),
    );
  }
  const pct = stats.aBytes === stats.bBytes ? 0 : ((stats.bBytes - stats.aBytes) / Math.max(1, stats.aBytes)) * 100;
  els.statsR.append(h('span', {
    text: `${fmtBytes(stats.aBytes)} → ${fmtBytes(stats.bBytes)} (${fmtPct(pct)})`,
  }));
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function renderImageStats(s) {
  if (!s) return;
  els.statsL.textContent = '';
  els.statsR.textContent = '';
  els.statsL.append(
    h('span', { text: `A ${s.a.w}×${s.a.h}` }),
    h('span', { class: 'stats-sep', text: '·' }),
    h('span', { text: `B ${s.b.w}×${s.b.h}` }),
    h('span', { class: 'stats-sep', text: '·' }),
    h('span', {
      text: `offset x ${s.offset.x >= 0 ? '+' : '−'}${Math.abs(s.offset.x)} · y ${s.offset.y >= 0 ? '+' : '−'}${Math.abs(s.offset.y)}`,
    }),
  );
  if (s.pct !== null && s.pct !== undefined) {
    els.statsL.append(
      h('span', { class: 'stats-sep', text: '·' }),
      h('span', { text: `${s.pct.toFixed(1)}% pixels differ` }),
    );
  }
  if (s.regions && (s.regions.add || s.regions.rem)) {
    els.statsL.append(
      h('span', { class: 'stats-sep', text: '·' }),
      s.regions.add ? chip('add', `+${s.regions.add} regions`) : h('span'),
      s.regions.rem ? chip('rem', `−${s.regions.rem} regions`) : h('span'),
    );
  }
  const pct = s.a.bytes === s.b.bytes ? 0 : ((s.b.bytes - s.a.bytes) / Math.max(1, s.a.bytes)) * 100;
  els.statsR.append(h('span', {
    text: `${fmtBytes(s.a.bytes)} → ${fmtBytes(s.b.bytes)} (${fmtPct(pct)})`,
  }));
}

// -------------------------------------------------------- file loading --

async function loadTextFile(side, file) {
  try {
    const text = await readTextFile(file, (read, total) => {
      const pct = total ? Math.round((read / total) * 100) : 0;
      els.statsL.textContent = '';
      els.statsL.append(h('span', { class: 'faint', text: `reading ${file.name} — ${pct}%` }));
    });
    if (side === 'a') state.pairsNames.a = file.name;
    else state.pairsNames.b = file.name;
    editors.setValue(side, text, file.name);
    updateEmptyState();
    updateFilepair();
    runDiff(true);
  } catch (err) {
    // binary or unreadable file — say so instead of silently doing nothing
    editors.setValue(side, '', '');
    renderTextStats(null, null, `${file.name}: ${err.message}`);
  }
}

// Chunked, non-blocking read. Small files use the fast path; large files are
// streamed so the UI can paint progress and the main thread never stalls on
// a single multi-hundred-megabyte decode.
const STREAM_THRESHOLD = 4 * 1024 * 1024;
async function readTextFile(file, onProgress) {
  if (file.size <= STREAM_THRESHOLD || typeof file.stream !== 'function') {
    return file.text();
  }
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  const parts = [];
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    parts.push(decoder.decode(value, { stream: true }));
    onProgress?.(read, file.size);
    // yield so progress can render between chunks
    await new Promise((r) => setTimeout(r, 0));
  }
  parts.push(decoder.decode());
  return parts.join('');
}

async function loadImageFile(file, side) {
  try {
    const asset = await ImageAsset.fromFile(file);
    state.assets[side] = asset;
    if (side === 'a') state.pairsNames.a = file.name; else state.pairsNames.b = file.name;
    setRecent({ imgA: state.assets.a?.name ?? '', imgB: state.assets.b?.name ?? '' });
    if (state.assets.a && state.assets.b) {
      await imagePane.setAssets(state.assets.a, state.assets.b);
    }
    updateEmptyState();
    updateFilepair();
    renderRecentHint();
  } catch (err) {
    els.statsL.textContent = '';
    els.statsL.append(h('span', { text: `error: ${err.message}` }));
  }
}

function renderRecentHint() {
  const r = getRecent();
  if (r.imgA && r.imgB) {
    els.recentHint.textContent = `Recent: ${r.imgA} ⇄ ${r.imgB}`;
    els.recentHint.hidden = false;
  }
}

// -------------------------------------------------------- batch queue --

function addPairFromFiles(files) {
  const list = [...files].filter((f) => f instanceof File);
  if (!list.length) return;
  if (list.length === 2) {
    addPair(list[0], list[1]);
    return;
  }
  // pair by matching filename
  const byName = new Map();
  for (const f of list) {
    const arr = byName.get(f.name) ?? [];
    arr.push(f);
    byName.set(f.name, arr);
  }
  let added = 0;
  for (const arr of byName.values()) {
    if (arr.length >= 2) {
      addPair(arr[0], arr[1]);
      added++;
    }
  }
  if (!added && list.length) addPair(list[0], list[1]);
}

async function addPair(aFile, bFile) {
  const id = `p${++state.queueSeq}`;
  const isImage = aFile.type.startsWith('image/') || bFile.type.startsWith('image/');
  const pair = {
    id,
    kind: isImage ? 'image' : 'text',
    aFile, bFile,
    aName: aFile.name, bName: bFile.name,
    aText: null, bText: null,
    assets: { a: null, b: null },
  };
  state.queue.set(id, pair);
  queueRail.addRow({
    id,
    kind: pair.kind,
    aName: pair.aName,
    bName: pair.bName,
    icon: fileAbbr(pair.aName, pair.kind),
  });
  if (isImage) {
    const [a, b] = await Promise.all([ImageAsset.fromFile(aFile), ImageAsset.fromFile(bFile)]);
    pair.assets = { a, b };
    const thumb = makeThumb(a);
    const entry = $('#queueList').querySelector(`[data-id="${id}"] .qrow-icon`);
    if (entry) { entry.textContent = ''; entry.append(thumb); }
    // perceptual hash → similar/different chip
    try {
      const ha = await createImageBitmap(a.bitmap);
      const hb = await createImageBitmap(b.bitmap);
      const [r1, r2] = await Promise.all([phashBitmap(ha), phashBitmap(hb)]);
      const d = hamming(r1.hash, r2.hash);
      pair.phashDist = d;
      queueRail.setChips(id, [{ cls: d <= 8 ? 'same' : 'rem', text: d <= 8 ? 'similar' : 'different' }]);
    } catch {
      queueRail.setChips(id, []);
    }
  } else {
    const [a, b] = await Promise.all([readTextFile(aFile), readTextFile(bFile)]);
    pair.aText = a;
    pair.bText = b;
    try {
      const r = await diffText(a, b, { ignoreWs: store.get().hideWs, precision: 'word' });
      const s = r.stats;
      queueRail.setChips(id, s.added || s.removed
        ? [{ cls: 'add', text: `+${s.added}` }, { cls: 'rem', text: `−${s.removed}` }]
        : [{ cls: 'same', text: 'no changes' }]);
    } catch {
      queueRail.setChips(id, []);
    }
  }
  if (!state.activePairId) activatePair(id);
}

async function activatePair(id) {
  const pair = state.queue.get(id);
  if (!pair) return;
  state.activePairId = id;
  queueRail.setActive(id);
  if (pair.kind === 'text') {
    if (pair.aText === null) {
      pair.aText = await readTextFile(pair.aFile);
      pair.bText = await readTextFile(pair.bFile);
    }
    state.pairsNames.a = pair.aName;
    state.pairsNames.b = pair.bName;
    if (state.mode !== 'text') setMode('text');
    editors.setValue('a', pair.aText, pair.aName);
    editors.setValue('b', pair.bText, pair.bName);
    updateEmptyState();
    runDiff(true);
  } else {
    if (!pair.assets.a) {
      pair.assets = {
        a: await ImageAsset.fromFile(pair.aFile),
        b: await ImageAsset.fromFile(pair.bFile),
      };
    }
    state.assets = pair.assets;
    state.pairsNames.a = pair.aName;
    state.pairsNames.b = pair.bName;
    if (state.mode !== 'image') setMode('image');
    await imagePane.setAssets(pair.assets.a, pair.assets.b);
    updateEmptyState();
    updateFilepair();
  }
}

function removePair(id) {
  const pair = state.queue.get(id);
  state.queue.delete(id);
  queueRail.removeRow(id);
  if (state.activePairId === id) {
    state.activePairId = null;
    if (pair?.kind === 'image') {
      state.assets = { a: null, b: null };
      imagePane.clear();
      updateEmptyState();
    }
  }
}

// ---------------------------------------------------------- drag/drop --

function bindGlobalDrop() {
  for (const target of [els.dropzone, els.diffwrap, document.getElementById('imgarea')]) {
    target.addEventListener('dragover', (e) => {
      e.preventDefault();
      target.classList.add('is-drag');
    });
    target.addEventListener('dragleave', () => target.classList.remove('is-drag'));
  }
  els.dropzone.addEventListener('drop', handleDrop);
  els.diffwrap.addEventListener('drop', handleDrop);
  document.getElementById('imgarea').addEventListener('drop', handleDrop);
  // prevent the browser from navigating when a drop misses our handlers
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

function handleDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  if (state.mode === 'image') {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (imgs.length === 2) {
      loadImageFile(imgs[0], 'a').then(() => loadImageFile(imgs[1], 'b'));
    } else if (imgs.length > 2) {
      addPairFromFiles(imgs);
    } else if (imgs.length === 1) {
      loadImageFile(imgs[0], state.assets.a ? 'b' : 'a');
    }
  } else if (files.length === 2) {
    loadTextFile('a', files[0]);
    loadTextFile('b', files[1]);
  } else if (files.length > 2) {
    addPairFromFiles(files);
  } else {
    loadTextFile(editors.value('a') ? 'b' : 'a', files[0]);
  }
}

// ------------------------------------------------------------- wiring --

function bindTopbar() {
  els.modeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-item');
    if (btn) setMode(btn.dataset.mode);
  });
}

const layoutSeg = segmented([['split', 'Split'], ['unified', 'Unified']],
  store.get().layout, (v) => store.set({ layout: v }), 'Layout');
els.layoutSeg.replaceChildren(...layoutSeg.el.children);
const compareSeg = segmented([
  ['split', 'Split'], ['fade', 'Fade'], ['flicker', 'Flicker'],
  ['slider', 'Slider'], ['highlight', 'Highlight'], ['details', 'Details'],
], 'split', (v) => setCompare(v), 'Compare mode');
els.compareSeg.replaceChildren(...compareSeg.el.children);

const alignSwitch = (() => {
  const btn = document.getElementById('autoAlignSwitch');
  btn.addEventListener('click', async () => {
    const on = btn.getAttribute('aria-checked') !== 'true';
    store.set({ autoAlign: on });
    if (on && state.assets.a && state.assets.b) {
      await imagePane.resetAlignment();
    }
  });
  return btn;
})();

function bindToolbar() {
  const drawerMq = window.matchMedia('(max-width: 1023.98px)');
  const openDrawer = (rail) => {
    rail.classList.add('is-open');
    document.getElementById('drawerBackdrop').classList.add('is-open');
  };
  const closeDrawers = () => {
    els.railSide.classList.remove('is-open');
    els.railBatch.classList.remove('is-open');
    document.getElementById('drawerBackdrop').classList.remove('is-open');
  };

  // Mobile/tablet: queue button opens the batch drawer
  els.queueBtn.addEventListener('click', () => openDrawer(els.railBatch));
  // Show queue + top-bar settings buttons on tablet/mobile
  const updateQueueBtn = () => {
    els.queueBtn.hidden = !drawerMq.matches;
    els.settingsTopBtn.hidden = !drawerMq.matches;
  };
  updateQueueBtn();
  drawerMq.addEventListener('change', updateQueueBtn);

  els.settingsTopBtn.addEventListener('click', () => {
    if (els.railSide.classList.contains('is-open')) closeDrawers();
    else openDrawer(els.railSide);
  });

  els.swapBtn.addEventListener('click', async () => {
    if (state.mode === 'text') {
      editors.swap();
      const na = state.pairsNames.a;
      state.pairsNames.a = state.pairsNames.b;
      state.pairsNames.b = na;
      updateFilepair();
      runDiff(true);
    } else if (state.assets.a && state.assets.b) {
      const a = state.assets.a;
      state.assets = { a: state.assets.b, b: a };
      await imagePane.setAssets(state.assets.a, state.assets.b);
      updateFilepair();
    }
  });
  els.clearBtn.addEventListener('click', () => {
    if (state.mode === 'text') {
      state.pairsNames = { a: '', b: '' };
      editors.clear();
      state.model = null;
      state.huge = false;
      diffView.clear();
      renderTextStats(null);
      els.downloadPatchBtn.hidden = true;
      els.copyMdBtn.hidden = true;
      updateEmptyState();
      updateFilepair();
    } else {
      state.assets = { a: null, b: null };
      imagePane.clear();
      updateEmptyState();
      updateFilepair();
    }
  });
  els.detailsBtn.addEventListener('click', () => {
    if (state.compare === 'details') setCompare('split');
    else setCompare('details');
  });
  els.downloadPatchBtn.addEventListener('click', () => {
    downloadPatch(state.model, state.pairsNames.a, state.pairsNames.b);
  });
  els.copyMdBtn.addEventListener('click', async () => {
    if (!state.model) return;
    const ok = await copyDiffMarkdown(diffView);
    const label = ok ? 'Copied' : 'Copy failed';
    const prev = els.copyMdBtn.textContent;
    els.copyMdBtn.textContent = label;
    setTimeout(() => { els.copyMdBtn.textContent = prev; }, 1200);
  });
  els.settingsBtn.addEventListener('click', () => {
    if (drawerMq.matches) {
      if (els.railSide.classList.contains('is-open')) closeDrawers();
      else openDrawer(els.railSide);
    } else {
      els.railSide.classList.toggle('side-collapsed');
      document.getElementById('railCollapsed').hidden =
        !els.railSide.classList.contains('side-collapsed');
    }
  });
  document.getElementById('collapseSide').addEventListener('click', () => {
    els.railSide.classList.add('side-collapsed');
    document.getElementById('railCollapsed').hidden = false;
  });
  document.getElementById('reopenSide').addEventListener('click', () => {
    els.railSide.classList.remove('side-collapsed');
    document.getElementById('railCollapsed').hidden = true;
  });
  // addPairBtn and addFoldersBtn keep their original behavior (file picker / folder chooser)
  // They are in the rail-foot which is visible in the mobile drawer
  // No special mobile handling needed here
  // Close drawers when clicking backdrop
  document.getElementById('drawerBackdrop').addEventListener('click', closeDrawers);
  document.getElementById('resetAlignBtn').addEventListener('click', () => imagePane.resetAlignment());
  for (const btn of document.querySelectorAll('.padbtn')) {
    btn.addEventListener('click', () => {
      const [dx, dy] = btn.dataset.nudge.split(',').map(Number);
      imagePane.nudge(dx, dy);
    });
  }
  els.dropzone.addEventListener('click', () => els.filePicker.click());
  els.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.filePicker.click(); }
  });
  els.filePicker.addEventListener('change', () => {
    addPairFromFiles(els.filePicker.files);
    els.filePicker.value = '';
  });
  els.addPairBtn.addEventListener('click', () => els.filePicker.click());
  els.addFoldersBtn.addEventListener('click', () => {
    els.folderChooser.hidden = !els.folderChooser.hidden;
  });
  bindFolderChooser();
  alignSwitch.setAttribute('aria-checked', String(store.get().autoAlign));
}

function bindFolderChooser() {
  const picked = { a: null, b: null };
  const pickA = $('#pickFolderA');
  const pickB = $('#pickFolderB');
  const go = $('#addFolderPair');
  const setup = (input, side) => {
    input.addEventListener('change', () => {
      picked[side] = [...input.files];
      input.value = '';
      if (picked.a && picked.b) go.disabled = false;
    });
  };
  setup(document.getElementById('folderPickerA'), 'a');
  setup(document.getElementById('folderPickerB'), 'b');
  pickA.addEventListener('click', () => document.getElementById('folderPickerA').click());
  pickB.addEventListener('click', () => document.getElementById('folderPickerB').click());
  go.addEventListener('click', () => {
    // pair by matching filename across the two folders
    const map = new Map(picked.b.map((f) => [f.name, f]));
    for (const f of picked.a) {
      const other = map.get(f.name);
      if (other) addPair(f, other);
    }
    els.folderChooser.hidden = true;
    go.disabled = true;
  });
}

function bindShortcuts() {
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
    if (mod && e.key === 'Enter' && !inField) {
      e.preventDefault();
      if (state.mode === 'text') runDiff(true);
      return;
    }
    if (e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (state.mode === 'text') editors.focus('a');
      return;
    }
    if (e.altKey && (e.key === 'j' || e.key === 'J')) {
      e.preventDefault();
      if (state.mode === 'text') editors.focus('b');
      return;
    }
    // Arrow keys nudge image alignment (10 px, Shift = 1 px fine-tune)
    if (state.mode === 'image' && !inField
      && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)
      && !els.alignbar.hidden) {
      e.preventDefault();
      const step = e.shiftKey ? 1 : 10;
      const d = {
        ArrowUp: [0, -step], ArrowDown: [0, step],
        ArrowLeft: [-step, 0], ArrowRight: [step, 0],
      }[e.key];
      imagePane.nudge(d[0], d[1]);
    }
    if (e.key === 'Escape') {
      if (els.railSide.classList.contains('is-open')) {
        els.railSide.classList.remove('is-open');
        document.getElementById('drawerBackdrop').classList.remove('is-open');
      }
      if (els.railBatch.classList.contains('is-open')) {
        els.railBatch.classList.remove('is-open');
        document.getElementById('drawerBackdrop').classList.remove('is-open');
      }
    }
  });
}

// ------------------------------------------------------------- boot --

function applyPrefs(p, prev) {
  layoutSeg.set(p.layout);
  compareSeg.set(state.compare);
  alignSwitch.setAttribute('aria-checked', String(p.autoAlign));
  editors.setRealtime(p.realtime);
  editors.setWrap(p.wrap);
  diffView.setPrefs(state.huge ? { ...p, syntax: 'off' } : p);
  updateRailSide();
  // compute-affecting options need a fresh diff
  if (state.mode === 'text' && state.model
    && (prev.hideWs !== p.hideWs || prev.precision !== p.precision || prev.realtime !== p.realtime)) {
    runDiff(true);
  }
  if (state.mode === 'text' && p.realtime && prev.realtime !== p.realtime) runDiff(true);
}

let firstPrefs = true;
function onStoreChange(p) {
  const prev = firstPrefs ? { ...p, hideWs: !p.hideWs, precision: null } : { ...lastPrefs };
  firstPrefs = false;
  lastPrefs = { ...p };
  applyPrefs(p, prev);
}
let lastPrefs = store.get();

function boot() {
  initTheme();
  buildSettings(els.settingsView);
  bindTopbar();
  bindToolbar();
  bindGlobalDrop();
  bindShortcuts();
  editors.setRealtime(store.get().realtime);
  setMode('text');
  store.on(onStoreChange);
  applyPrefs(store.get(), lastPrefs);
  document.getElementById('detailsView').hidden = true;
}

boot();
