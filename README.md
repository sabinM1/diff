# Diffbench

A fully client-side diff checker for text and images. No backend, no uploads, no telemetry, and no runtime dependencies — everything runs in your browser and nothing leaves your machine.

## Features

**Text**
- Line-level diff using patience anchoring plus a Myers middle-snake search, with word/character refinement on changed lines
- Syntax highlighting for 12 languages (C, C++, Python, JavaScript, TypeScript, JSON, HTML, CSS, Markdown, Rust, Go, Java) with shebang/content auto-detection
- Split and unified layouts, side-by-side or inline; optional line wrapping
- Whitespace-insensitive comparison, hide-unchanged-lines, large-file step budget
- **Export unified diff** (`.patch`) and **copy a file or single hunk as GitHub-flavored markdown**

**Images**
- Perceptual hash (dHash) to spot identical or near-identical images instantly
- Pixel diff with a threshold slider and bounding-box change detection
- Auto-alignment via an edge-map pyramid search, plus manual nudging
- Six compare modes: split (synced pan/zoom), fade, flicker, slider, highlight, details
- **Details view** with EXIF comparison between the two images (union of tags, `A → B` values, changed tags highlighted)

**Everything else**
- Drag-and-drop, file picker, or folder-pair batch add; multi-pair queue
- Recent image pair names (never contents) remembered in `localStorage`
- Light/dark theme with pre-paint theme restore (no flash), colour-vision-deficiency mode
- Keyboard-driven, virtualized rendering, Web Workers for all heavy lifting
- Strict CSP: no inline scripts/styles, no third-party origins

## Tech Stack

- Native ES modules, no framework and no bundler
- Two module Web Workers (`src/workers/diff.worker.js`) handling text diff and image work
- `localStorage` for preferences and recent image pair names
- CSS custom properties for theming
- Zero-dependency Node scripts for build (`build.mjs`), dev server (`dev-server.mjs`) and tests

## Quick Start

Node 18+ is required for the dev server, build and tests. There is nothing to install — `package.json` has no dependencies.

```bash
npm run dev     # http://localhost:8080 (PORT and HOST env vars override)
npm test        # diff/patch/alignment unit tests
npm run build   # copy the runtime files into ./dist
npm run serve   # serve ./dist at http://localhost:8080
```

Opening `index.html` straight from `file://` will not work: ES module workers and imports require an `http://` origin.

## Deploy to GitHub Pages

1. Push the repository to GitHub.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `master` (or run the workflow manually). `.github/workflows/deploy.yml` runs `npm test`, `npm run build` and publishes `dist/`.

Because all asset paths are relative, the site works from both a user site (`https://user.github.io/`) and a project subpath (`https://user.github.io/repo/`). The empty `.nojekyll` file is copied into `dist/` so GitHub Pages serves the tree verbatim.

Any other static host (Netlify, Cloudflare Pages, S3, nginx) works the same way: run `npm run build` and serve `dist/`.

## Project Structure

```
index.html               # App shell + strict CSP meta
styles.css               # All styling and theme tokens
favicon.svg
build.mjs                # Zero-dep build: copies runtime files into dist/
dev-server.mjs           # Zero-dep static dev server
src/
├── main.js              # Entry point: state, wiring, shortcuts
├── diff/
│   ├── core.js          # Line diff (patience + Myers), word/char refinement
│   ├── highlight.js     # Single-pass syntax highlighter (12 languages)
│   └── model.js         # Diff model, unified diff/patch generation
├── image/
│   ├── align.js         # Edge-map pyramid alignment
│   ├── exif.js          # EXIF parsing
│   ├── imagePane.js     # Canvas compare modes, synced zoom
│   ├── loader.js        # Image decode (createImageBitmap + fallbacks)
│   └── phash.js         # Perceptual hash (dHash)
├── storage/
│   └── store.js         # Versioned localStorage prefs + recent names
├── theme/
│   ├── init.js          # Pre-paint theme restore (classic script)
│   └── theme.js         # Runtime theme/CVD switching
├── ui/
│   ├── controls.js      # Segmented controls, switches
│   ├── diffView.js      # Virtualized diff renderer, markdown export
│   ├── dom.js           # Tiny element helper
│   ├── editorPanes.js   # Textareas, drop zones, file/paste/copy actions
│   ├── exporters.js     # Patch download, markdown copy
│   ├── queueRail.js     # File pair queue
│   └── settingsRail.js  # Settings drawer
└── workers/
    ├── client.js        # Worker lifecycle, request/response protocol
    └── diff.worker.js    # text | align | phash | pixdiff handlers
tests/diff.test.mjs      # Unit tests: core, patch, alignment, phash
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + Enter` | Run the text diff |
| `Alt + K` / `Alt + J` | Focus the original / changed editor |
| `←` `→` `↑` `↓` | Nudge image alignment by 10 px (`Shift` = 1 px) |
| `Enter` / `Space` on the drop zone | Open the file picker |
| `Esc` | Close the queue/settings drawers |

Shortcuts are suppressed while a text field has focus. Each diff hunk also has a `Copy` button (markdown), and right-clicking a row copies that hunk.

## Browser Support

- Chrome/Edge 100+
- Firefox 100+
- Safari 15.4+

Requires: ES2022 modules, module Web Workers, `createImageBitmap`, `OffscreenCanvas`, `localStorage`. Image decoding falls back to `<img>` + canvas where `createImageBitmap` is unavailable.

## Design Notes

Heavy work runs in two module Web Workers so image alignment never queues behind keystroke diffs, and the diff core falls back to a wholesale replace once a 40 M-step budget is exhausted. Line-wrap mode deliberately disables virtualization and caps at 20k rows, since measuring wrapped heights is the only way to keep scroll position stable.

## Contributing

Issues and PRs are welcome. Please run `npm test` and `npm run build` before submitting.

## AI Disclosure

This project was written with substantial AI assistance (agentic coding tools) and human review. AI was used for scaffolding, refactors, documentation and test drafting; the architecture, the diff algorithms (patience anchoring, Myers middle-snake, edge-map pyramid alignment) and every design decision here were reviewed and are maintained by a human. The algorithms are original implementations written from published literature, not ports of existing libraries.

## License

MIT — see [LICENSE](LICENSE).
