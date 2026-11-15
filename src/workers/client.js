// Promise-based worker clients. Two single-thread workers keep the two
// pipelines independent: image alignment (~100 ms searches) must never
// queue behind keystroke diffs.
const URL_TEXT = new URL('./diff.worker.js', import.meta.url);
let shared = null;

function spawn() {
  if (!shared) shared = new Worker(URL_TEXT, { type: 'module' });
  return shared;
}

function call(worker, msg, transfer) {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const onMessage = (e) => {
      if (e.data.id !== id) return;
      worker.removeEventListener('message', onMessage);
      if (e.data.ok) resolve(e.data.payload);
      else reject(new Error(e.data.error));
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ ...msg, id }, transfer);
  });
}

// Monotonic request ids: collision-free and cheap. The counter is per main
// thread and workers echo the id back unchanged, so it never wraps in
// practice (2^53 requests would be needed).
let reqSeq = 0;
function nextId() { return ++reqSeq; }

export function textWorker() { return spawn(); }

export function diffText(aText, bText, opts) {
  return call(spawn(), {
    type: 'text',
    aText,
    bText,
    ignoreWs: !!opts.ignoreWs,
    precision: opts.precision ?? 'smart',
  });
}

// Image jobs use a dedicated worker so text diffs stay responsive.
let imgWorker = null;
function imageWorker() {
  if (!imgWorker) imgWorker = new Worker(URL_TEXT, { type: 'module' });
  return imgWorker;
}

export function alignImages(aBitmap, bBitmap) {
  return call(imageWorker(), { type: 'align', a: aBitmap, b: bBitmap }, [aBitmap, bBitmap]);
}

export function phashBitmap(bitmap) {
  return call(imageWorker(), { type: 'phash', bitmap }, [bitmap]);
}

export function pixelDiff(aData, bData, w, h) {
  return call(imageWorker(), { type: 'pixdiff', aData, bData, aW: w, aH: h },
    [aData.buffer, bData.buffer]);
}
