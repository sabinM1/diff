// Preference persistence. One JSON blob under a versioned key; unknown
// fields are dropped on load so downgrades never crash.
const KEY = 'diffbench:prefs:v1';
const CURRENT_VERSION = 1;

const DEFAULTS = {
  theme: null,            // null = follow prefers-color-scheme
  layout: 'split',
  realtime: true,
  wrap: false,
  hideWs: false,
  hideUnchanged: false,
  precision: 'smart',
  syntax: 'auto',         // auto | manual | off
  manualLang: 'javascript',
  cvd: false,
  autoAlign: true,
  fade: 0.5,
  flickerHz: 3,
  sliderDir: 'v',
  sliderPos: 50,
  highlightStrength: 18,
  detailsOpen: false,
};

function migrate(data, fromVersion) {
  // Future migrations go here. Example:
  // if (fromVersion < 2) { data.newField = 'default'; }
  return data;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS, _version: CURRENT_VERSION };
    const data = JSON.parse(raw);
    const version = data._version ?? 1;
    const migrated = migrate(data, version);
    const out = { ...DEFAULTS, _version: CURRENT_VERSION };
    for (const k of Object.keys(DEFAULTS)) {
      if (migrated[k] !== undefined && typeof migrated[k] === typeof DEFAULTS[k]) {
        out[k] = migrated[k];
      }
    }
    return out;
  } catch (e) {
    console.warn('[diffbench] Failed to load preferences:', e);
    return { ...DEFAULTS, _version: CURRENT_VERSION };
  }
}

function save(prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
    return true;
  } catch (e) {
    if (e.name === 'QuotaExceededError' || e.code === 22) {
      console.warn('[diffbench] localStorage quota exceeded, preferences not saved');
    } else if (e.name === 'SecurityError') {
      console.warn('[diffbench] localStorage unavailable (private/incognito mode), preferences not saved');
    } else {
      console.warn('[diffbench] Failed to save preferences:', e);
    }
    return false;
  }
}

let prefs = load();
const subs = new Set();

export const store = {
  get: () => prefs,
  set(patch) {
    prefs = { ...prefs, ...patch };
    save(prefs);
    for (const fn of subs) fn(prefs);
  },
  on(fn) { subs.add(fn); return () => subs.delete(fn); },
};

// Recent pair names for the empty-state hints (names only, never contents).
const RKEY = 'diffbench:recent:v1';
const RECENT_VERSION = 1;

function migrateRecent(data, fromVersion) {
  // Future migrations for recent data go here
  return data;
}

export function getRecent() {
  try {
    const raw = localStorage.getItem(RKEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    const version = data._version ?? 1;
    const migrated = migrateRecent(data, version);
    return migrated;
  } catch (e) {
    console.warn('[diffbench] Failed to load recent files:', e);
    return {};
  }
}

export function setRecent(patch) {
  try {
    const next = { ...getRecent(), ...patch, _version: RECENT_VERSION };
    localStorage.setItem(RKEY, JSON.stringify(next));
  } catch (e) {
    if (e.name === 'QuotaExceededError' || e.code === 22) {
      console.warn('[diffbench] localStorage quota exceeded, recent files not saved');
    } else if (e.name === 'SecurityError') {
      console.warn('[diffbench] localStorage unavailable (private/incognito mode), recent files not saved');
    } else {
      console.warn('[diffbench] Failed to save recent files:', e);
    }
  }
}