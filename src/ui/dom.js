// DOM helpers shared by the UI modules.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel) => document.querySelector(sel);

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtPct(x) {
  const s = (Math.abs(x) < 0.05 ? 0 : x).toFixed(1);
  return x > 0 ? `+${s}%` : `${s}%`;
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API can be missing on http:// origins — legacy fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

// Monospace advance width for the code font, measured once.
let charW = null;
export function codeCharWidth() {
  if (charW !== null) return charW;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = '12px "JetBrains Mono", "SF Mono", "Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
  charW = ctx.measureText('X'.repeat(100)).width / 100 || 7.2;
  return charW;
}
