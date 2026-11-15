// Small bundled syntax highlighter — zero dependencies, CSP-safe.
// Regex-free single-pass scanner per line; multi-line constructs (block
// comments, Python docstrings, Markdown fences, HTML comments) are carried
// by a per-line state array computed once per document. The scanner is a
// heuristic subset (no regex literals, no nested templates) — enough for
// diff reading.
//
// Token classes: kw, str, com, num, fn, ty (see styles.css .tk-*).

const SET = (s) => new Set((s ?? '').split(' ').filter(Boolean));

const LANGS = {
  c: {
    name: 'C',
    exts: ['.c', '.h'],
    line: ['//'],
    block: [['/*', '*/']],
    kw: SET('auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while defined'),
    ty: SET('char double float int long short signed unsigned void size_t ssize_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t bool FILE'),
    preproc: true,
  },
  cpp: {
    name: 'C++',
    exts: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.h++'],
    line: ['//'],
    block: [['/*', '*/']],
    kw: SET('alignas alignof and auto break case catch class co_await co_return co_yield concept const consteval constexpr constinit const_cast continue decltype default delete do dynamic_cast else enum explicit export extern for friend goto if inline mutable namespace new noexcept not operator or private protected public register reinterpret_cast requires return sizeof static static_assert static_cast struct switch template this thread_local throw try typedef typeid typename union using virtual volatile while defined'),
    ty: SET('bool char char8_t char16_t char32_t double float int long short signed unsigned void size_t std string vector map set unique_ptr shared_ptr'),
    preproc: true,
  },
  python: {
    name: 'Python',
    exts: ['.py', '.pyw', '.pyi'],
    line: ['#'],
    blockString: ['"""', "'''"],
    kw: SET('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'),
    ty: SET('bool bytes dict float frozenset int list object set str tuple type None True False Exception ValueError TypeError KeyError IndexError RuntimeError OSError'),
  },
  javascript: {
    name: 'JavaScript',
    exts: ['.js', '.mjs', '.cjs', '.jsx'],
    line: ['//'],
    block: [['/*', '*/']],
    kw: SET('as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield'),
    ty: SET('true false null undefined NaN Infinity Boolean Number String Symbol Array Object Map Set WeakMap WeakSet Promise Proxy JSON Math Date Error RegExp'),
  },
  typescript: {
    name: 'TypeScript',
    exts: ['.ts', '.tsx', '.mts', '.cts'],
    line: ['//'],
    block: [['/*', '*/']],
    kw: SET('abstract as asserts async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let namespace new of override private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield'),
    ty: SET('true false null undefined NaN Infinity any unknown never void boolean number string symbol object Array Object Map Set Promise JSON Math Date Error RegExp Record Partial Pick Omit'),
  },
  json: {
    name: 'JSON',
    exts: ['.json', '.jsonc', '.json5'],
    line: ['//'],
    block: [['/*', '*/']],
    kw: SET('true false null'),
    ty: SET(),
    jsonKeys: true,
  },
  html: {
    name: 'HTML',
    exts: ['.html', '.htm', '.xhtml'],
    mode: 'html',
  },
  css: {
    name: 'CSS',
    exts: ['.css'],
    mode: 'css',
    line: ['//'],
    block: [['/*', '*/']],
    kw: SET('important media supports keyframes import charset font-face layer'),
  },
  markdown: {
    name: 'Markdown',
    exts: ['.md', '.markdown', '.mdown'],
    mode: 'md',
  },
  rust: {
    name: 'Rust',
    exts: ['.rs'],
    line: ['//'],
    block: [['/*', '*/']],
    kw: SET('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while'),
    ty: SET('bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize String Vec Option Result Box Rc Arc HashMap HashSet BTreeMap Cow'),
  },
  go: {
    name: 'Go',
    exts: ['.go'],
    line: ['//'],
    block: [['/*', '*/']],
    kw: SET('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'),
    ty: SET('bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any true false nil'),
  },
  java: {
    name: 'Java',
    exts: ['.java'],
    line: ['//'],
    block: [['/*', '*/']],
    kw: SET('abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public record return static strictfp super switch synchronized this throw throws transient try var volatile while yield sealed permits'),
    ty: SET('boolean byte char double float int long short void String Integer Long Boolean Double Object List Map Set ArrayList HashMap Optional Stream Exception RuntimeException'),
  },
};

const EXT_MAP = new Map();
for (const [id, lang] of Object.entries(LANGS)) {
  for (const ext of lang.exts ?? []) EXT_MAP.set(ext, id);
}

// Content sniffing when no filename is known.
function sniff(text) {
  const head = text.slice(0, 4000);
  if (/^#!.*\bpython/.test(head)) return 'python';
  if (/^#!.*\bnode/.test(head)) return 'javascript';
  if (/^#!.*\b(ruby|perl|bash|sh)\b/.test(head)) return null;
  if (/^\s*<(!doctype|html|\?xml)/i.test(head)) return 'html';
  if (/^\s*[{[]/.test(head) && /"\s*:/.test(head)) return 'json';
  if (/\bpackage\s+\w+/.test(head) && /\bfunc\s/.test(head)) return 'go';
  if (/\bfn\s+\w+\s*\(/.test(head)) return 'rust';
  if (/^\s*def\s+\w+\s*\(|^\s*import\s+\w+$/m.test(head)) return 'python';
  if (/#include\s*[<"]/.test(head)) return /std::|\bclass\b|\bnamespace\b/.test(head) ? 'cpp' : 'c';
  if (/\bpublic\s+(static\s+)?(class|interface|record|void)\b/.test(head)) return 'java';
  if (/\binterface\s+\w+|\btype\s+\w+\s*=|:\s*(string|number|boolean)\b/.test(head) && /(const|let|function|import)/.test(head)) return 'typescript';
  if (/\b(function|const|let|var)\b|=>/.test(head)) return 'javascript';
  if (/^\s*[.#@][\w-]+\s*\{/m.test(head) || /:\s*[^;{}]+\s*;/m.test(head)) return 'css';
  if (/^#{1,6}\s+\S/m.test(head) && /(\n[-*] |\n\* |\[.+?\]\()/.test(head)) return 'markdown';
  return null;
}

export function detectLang(text, filename) {
  if (filename) {
    const m = /\.([A-Za-z0-9_]+)$/.exec(filename.toLowerCase());
    if (m) {
      const id = EXT_MAP.get('.' + m[1]);
      if (id) return id;
    }
  }
  return sniff(text);
}

export function getLang(id) { return id ? LANGS[id] ?? null : null; }
export function listLangs() { return Object.entries(LANGS).map(([id, l]) => [id, l.name]); }

// ---- multi-line state (0 = outside any block construct) -----------------

function countOutside(line, tokens, lineComments) {
  // heuristic: counts block delimiters ignoring the part after a line
  // comment start (strings containing delimiters are rare in real code)
  let cut = line.length;
  for (const lc of lineComments ?? []) {
    const i = line.indexOf(lc);
    if (i >= 0 && i < cut) cut = i;
  }
  let delta = 0;
  for (const [open] of tokens ?? []) {
    let idx = 0;
    while ((idx = line.indexOf(open, idx)) >= 0 && idx < cut) { delta++; idx += open.length; }
  }
  for (const [open, close] of tokens ?? []) {
    let idx = 0;
    while ((idx = line.indexOf(close, idx)) >= 0 && idx < cut) { delta--; idx += close.length; }
  }
  return delta;
}

// Returns the block state BEFORE each line (Uint8Array of lines.length).
export function lineStates(lines, lang) {
  const states = new Uint8Array(lines.length);
  if (!lang) return states;
  let st = 0;
  if (lang.mode === 'md') {
    for (let i = 0; i < lines.length; i++) {
      states[i] = st;
      if (/^\s*(```|~~~)/.test(lines[i])) st = st ? 0 : 1;
    }
    return states;
  }
  if (lang.mode === 'html') {
    for (let i = 0; i < lines.length; i++) {
      states[i] = st;
      const d = countOutside(lines[i], [['<!--', '-->']], null);
      st = (st + d + 2) % 2;
    }
    return states;
  }
  if (lang.blockString) {
    for (let i = 0; i < lines.length; i++) {
      states[i] = st;
      const line = lines[i];
      let d = 0;
      for (const tq of lang.blockString) {
        let idx = 0;
        while ((idx = line.indexOf(tq, idx)) >= 0) { d++; idx += tq.length; }
      }
      st = (st + d) % 2;
    }
    return states;
  }
  const toks = lang.block ?? null;
  if (!toks) return states;
  for (let i = 0; i < lines.length; i++) {
    states[i] = st;
    st = (st + countOutside(lines[i], toks, lang.line) + 4) % 2;
  }
  return states;
}

// ---- per-line tokenizer ---------------------------------------------------

const NUM_RE = /^(0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)[uUlLfF]*/;
const ID_START = /[A-Za-z_$]/;
const ID_RE = /^[A-Za-z_$][\w$]*/;

function scanPlain(line, lang, ranges) {
  const n = line.length;
  let i = 0;
  while (i < n) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    // line comment
    if (lang.line) {
      for (const lc of lang.line) {
        if (line.startsWith(lc, i)) { ranges.push(['com', i, n]); return; }
      }
    }
    // numbers
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(line[i + 1] ?? ''))) {
      const m = NUM_RE.exec(line.slice(i));
      if (m) { ranges.push(['num', i, i + m[0].length]); i += m[0].length; continue; }
    }
    // identifiers
    if (ID_START.test(ch)) {
      const m = ID_RE.exec(line.slice(i));
      const word = m ? m[0] : ch;
      const end = i + word.length;
      // function call: identifier followed by '('
      let k = end;
      while (k < n && line[k] === ' ') k++;
      if (lang.kw?.has(word)) ranges.push(['kw', i, end]);
      else if (lang.ty?.has(word)) ranges.push(['ty', i, end]);
      else if (lang.mode !== 'md' && line[k] === '(') ranges.push(['fn', i, end]);
      else if (/^[A-Z]/.test(word) && lang.mode !== 'md' && lang.kw && !lang.jsonKeys) ranges.push(['ty', i, end]);
      i = end;
      continue;
    }
    i++;
  }
}

function scanLine(line, lang, inState) {
  // returns { ranges: [type, start, end][], outState }
  const ranges = [];
  const n = line.length;
  let st = inState;

  if (lang.mode === 'md') {
    if (/^\s*#{1,6}\s/.test(line)) return { ranges: [['kw', 0, n]], outState: st };
    if (/^\s*(```|~~~)/.test(line)) return { ranges: [['str', 0, n]], outState: st ? 0 : 1 };
    if (st) return { ranges: [['str', 0, n]], outState: st };
    // inline code and link URLs
    for (const m of line.matchAll(/`[^`]*`|\[[^\]]*\]\([^)]*\)|^\s*[-*+>]\s/g)) {
      const t = m[0];
      if (t.startsWith('`')) ranges.push(['str', m.index, m.index + t.length]);
      else if (t.endsWith(')')) {
        const ui = m.index + t.lastIndexOf('(') + 1;
        ranges.push(['num', ui, m.index + t.length - 1]);
      } else ranges.push(['kw', m.index, m.index + t.length]);
    }
    return { ranges, outState: st };
  }

  if (lang.mode === 'html') {
    if (st) {
      const close = line.indexOf('-->');
      if (close < 0) return { ranges: [['com', 0, n]], outState: 1 };
      ranges.push(['com', 0, close + 3]);
      const rest = scanLine(line.slice(close + 3), lang, 0);
      for (const r of rest.ranges) ranges.push([r[0], r[1] + close + 3, r[2] + close + 3]);
      return { ranges, outState: 0 };
    }
    let i = 0;
    while (i < n) {
      const c = line.indexOf('<', i);
      if (c < 0) break;
      if (line.startsWith('<!--', c)) {
        const close = line.indexOf('-->', c);
        if (close < 0) { ranges.push(['com', c, n]); return { ranges, outState: 1 }; }
        ranges.push(['com', c, close + 3]);
        i = close + 3;
        continue;
      }
      // tag name
      let j = c + 1;
      const slash = line[j] === '/' ? 1 : 0;
      const m = /^[A-Za-z][\w:-]*/.exec(line.slice(j + slash));
      if (!m) { i = c + 1; continue; }
      ranges.push(['kw', c, j + slash + m[0].length]);
      j += slash + m[0].length;
      // attributes until '>'
      while (j < n && line[j] !== '>') {
        if (line[j] === '"' || line[j] === "'") {
          const q = line[j];
          const e = line.indexOf(q, j + 1);
          const end = e < 0 ? n : e + 1;
          ranges.push(['str', j, end]);
          j = end;
        } else {
          const am = /^\s*([A-Za-z_@:][\w@:.-]*)/.exec(line.slice(j));
          if (am) { ranges.push(['fn', j + am[0].length - am[1].length, j + am[0].length]); j += am[0].length; }
          else j++;
        }
      }
      i = j + 1;
    }
    return { ranges, outState: 0 };
  }

  if (lang.mode === 'css') {
    let i = 0;
    while (i < n) {
      const ch = line[i];
      if (line.startsWith('/*', i)) {
        const e = line.indexOf('*/', i + 2);
        if (e < 0) { ranges.push(['com', i, n]); return { ranges, outState: 1 }; }
        ranges.push(['com', i, e + 2]);
        i = e + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const e = line.indexOf(ch, i + 1);
        ranges.push(['str', i, e < 0 ? n : e + 1]);
        i = e < 0 ? n : e + 1;
        continue;
      }
      if (ch === '@') {
        const m = /^@[\w-]+/.exec(line.slice(i));
        if (m) { ranges.push(['kw', i, i + m[0].length]); i += m[0].length; continue; }
      }
      if (ch === '#' && /^#[0-9a-fA-F]{3,8}\b/.test(line.slice(i))) {
        const m = /^#[0-9a-fA-F]{3,8}/.exec(line.slice(i));
        ranges.push(['num', i, i + m[0].length]);
        i += m[0].length;
        continue;
      }
      if (/\d/.test(ch)) {
        const m = /^-?\d[\d.]*(px|em|rem|vh|vw|s|ms|deg|fr|%|ch|pt)?/.exec(line.slice(i));
        if (m) { ranges.push(['num', i, i + m[0].length]); i += m[0].length; continue; }
      }
      // property: identifier directly followed by ':'
      const im = /^[A-Za-z-][\w-]*/.exec(line.slice(i));
      if (im && /^\s*:/.test(line.slice(i + im[0].length))) {
        ranges.push(['fn', i, i + im[0].length]);
        i += im[0].length;
        continue;
      }
      i++;
    }
    return { ranges, outState: 0 };
  }

  // generic C-family / Python / JSON scanner
  const preproc = lang.preproc && /^\s*#/.test(line);
  if (preproc) return { ranges: [['kw', /^\s*/.exec(line)[0].length, n]], outState: st };
  if (st) {
    // inside a block comment (generic languages)
    const close = (lang.block ?? [])[0]?.[1];
    if (close) {
      const e = line.indexOf(close);
      if (e < 0) return { ranges: [['com', 0, n]], outState: 1 };
      ranges.push(['com', 0, e + close.length]);
      const rest = scanLine(line.slice(e + close.length), lang, 0);
      for (const r of rest.ranges) ranges.push([r[0], r[1] + e + close.length, r[2] + e + close.length]);
      return { ranges, outState: 0 };
    }
    if (lang.blockString) {
      // python docstring continuation
      let e = -1, which = '';
      for (const tq of lang.blockString) {
        const i2 = line.indexOf(tq);
        if (i2 >= 0 && (e < 0 || i2 < e)) { e = i2; which = tq; }
      }
      if (e < 0) return { ranges: [['str', 0, n]], outState: 1 };
      ranges.push(['str', 0, e + which.length]);
      const rest = scanLine(line.slice(e + which.length), lang, 0);
      for (const r of rest.ranges) ranges.push([r[0], r[1] + e + which.length, r[2] + e + which.length]);
      return { ranges, outState: 0 };
    }
  }

  const strings = lang.jsonKeys || lang.mode !== 'html'
    ? [['"', '"', '\\'], ["'", "'", '\\'], ['`', '`', '\\']]
    : [];
  if (lang.blockString) strings.push([lang.blockString[0], lang.blockString[0], '\\']);

  let i = 0;
  while (i < n) {
    const ch = line[i];
    // line comment
    if (lang.line) {
      let hit = false;
      for (const lc of lang.line) {
        if (line.startsWith(lc, i)) { ranges.push(['com', i, n]); i = n; hit = true; break; }
      }
      if (hit) continue;
    }
    // strings (with python triple-quote starts)
    let matched = false;
    for (const [open, , esc] of strings) {
      if (!line.startsWith(open, i)) continue;
      let j = i + open.length;
      while (j < n) {
        if (esc && line[j] === '\\') { j += 2; continue; }
        if (line.startsWith(open, j)) { j += open.length; break; }
        j++;
      }
      ranges.push(['str', i, Math.min(j, n)]);
      i = Math.min(j, n);
      matched = true;
      break;
    }
    if (matched) continue;
    // numbers
    if (/\d/.test(ch)) {
      const m = NUM_RE.exec(line.slice(i));
      if (m) { ranges.push(['num', i, i + m[0].length]); i += m[0].length; continue; }
    }
    // identifiers
    if (ID_START.test(ch)) {
      const m = ID_RE.exec(line.slice(i));
      const word = m[0];
      const end = i + word.length;
      let k = end;
      while (k < n && line[k] === ' ') k++;
      if (lang.kw?.has(word)) ranges.push(['kw', i, end]);
      else if (lang.ty?.has(word)) ranges.push(['ty', i, end]);
      else if (line[k] === '(') ranges.push(['fn', i, end]);
      else if (lang.jsonKeys && end < n && /^\s*:/.test(line.slice(end))) ranges.push(['fn', i, end]);
      else if (/^[A-Z]/.test(word)) ranges.push(['ty', i, end]);
      i = end;
      continue;
    }
    i++;
  }
  return { ranges, outState: st };
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const esc = (s) => s.replace(/[&<>]/g, (c) => ESC[c]);

// Renders one line to HTML: escaped text with .tk-* spans and word marks.
// marks is a flat [start, end, ...] array; markClass is 'wadd' or 'wdel'.
export function renderCodeHTML(line, lang, inState, marks, markClass) {
  if (!line) return '';
  let tokens = [];
  if (lang) tokens = scanLine(line, lang, inState).ranges;
  if (!marks) {
    let html = '';
    let pos = 0;
    for (const [type, s, e] of tokens) {
      if (s > pos) html += esc(line.slice(pos, s));
      html += `<span class="tk-${type}">${esc(line.slice(s, e))}</span>`;
      pos = Math.max(pos, e);
    }
    html += esc(line.slice(pos));
    return html;
  }
  // walk the line in intervals bounded by mark and token edges, so marks
  // can nest tokens (e.g. <mark><span class="tk-kw">)
  const bounds = new Set([0, line.length]);
  for (let k = 0; k < marks.length; k += 2) { bounds.add(marks[k]); bounds.add(marks[k + 1]); }
  for (const [, s, e] of tokens) { bounds.add(s); bounds.add(e); }
  const cuts = [...bounds].sort((a, b) => a - b);
  const markAt = (p) => {
    for (let m = 0; m < marks.length; m += 2) {
      if (marks[m] <= p && p < marks[m + 1]) return markClass;
    }
    return null;
  };
  const tokAt = (p) => {
    for (const [type, s, e] of tokens) {
      if (s <= p && p < e) return type;
    }
    return null;
  };
  let html = '';
  for (let k = 0; k + 1 < cuts.length; k++) {
    const s = cuts[k], e = cuts[k + 1];
    if (e <= s) continue;
    const text = esc(line.slice(s, e));
    const cls = tokAt(s);
    const mk = markAt(s);
    const inner = cls ? `<span class="tk-${cls}">${text}</span>` : text;
    html += mk ? `<mark class="${mk}">${inner}</mark>` : inner;
  }
  return html;
}
