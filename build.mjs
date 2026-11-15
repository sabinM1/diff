// Dependency-free build: Diffbench ships native ES modules, so "building"
// means producing a clean, self-contained dist/ that any static host can
// serve verbatim. No bundler, no transpiler, no minifier — nothing to trust
// and nothing to install. Files keep their relative layout so subpath
// hosting (https://user.github.io/repo/) works without rewrites.
import { cpSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// Everything the browser needs at runtime. Deliberately explicit so an
// accidental secret or scratch file can never leak into the artifact.
const entries = ['index.html', 'styles.css', 'favicon.svg', 'src', '.nojekyll'];

for (const name of entries) {
  const from = join(root, name);
  if (!existsSync(from)) {
    throw new Error(`build: expected entry "${name}" is missing`);
  }
  cpSync(from, join(dist, name), {
    recursive: statSync(from).isDirectory(),
  });
}

let files = 0;
let bytes = 0;
(function walk(dir) {
  for (const it of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, it.name);
    if (it.isDirectory()) walk(p);
    else { files++; bytes += statSync(p).size; }
  }
})(dist);

console.log(`dist/ ready — ${files} files, ${(bytes / 1024).toFixed(1)} KiB`);
