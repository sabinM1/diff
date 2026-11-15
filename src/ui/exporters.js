// Export/copy actions for the text diff: download a .patch, copy the whole
// diff as GitHub-flavoured markdown. Kept out of main.js so the orchestration
// file only wires events and this cohesive "output" concern lives on its own.
import { generateUnifiedDiff } from '../diff/model.js';
import { copyText } from './dom.js';

// Trigger a client-side file download from an in-memory string.
function downloadText(text, filename, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // Safe to revoke immediately: the click has already resolved the blob URL.
  URL.revokeObjectURL(url);
}

const safeName = (n, fallback) => String(n || fallback).replace(/[^a-z0-9.-]/gi, '_');

// Download the current model as a unified diff patch. Returns false when there
// is nothing to export (no model, or identical input → empty patch).
export function downloadPatch(model, aName, bName) {
  if (!model) return false;
  const patch = generateUnifiedDiff(model, aName || 'file-a', bName || 'file-b');
  if (!patch) return false;
  downloadText(patch, `${safeName(aName, 'diff')}.patch`);
  return true;
}

// Copy the whole diff as a ```diff fenced markdown block. Returns a promise
// resolving to true on success so the caller can show "Copied"/"Copy failed".
export function copyDiffMarkdown(diffView) {
  const md = diffView?.generateFileMarkdown?.();
  if (!md) return Promise.resolve(false);
  return copyText(md);
}
