/* Ledger — objective tracker PWA with GitHub Gist sync.
   Local-first: localStorage is always the working copy. The Gist is a shared
   mirror that every device merges into, per-record, newest-write-wins.

   Schema v2 adds folders. Each folder carries its own set of toggles, so
   "Awaiting reply / Needs my reply" and "Checked / Complete" can coexist. One
   toggle per folder is nominated as its done toggle, which is what the Open
   filter hides and what the stats line counts. */
'use strict';

/* ================= constants ================= */
/* Bump APP_VERSION and CACHE in sw.js together on every release — the version
   shown beside the wordmark is how you tell which build a device is running. */
const APP_VERSION = '2.4.2';
const KEY = 'ledger.db.v1';
const CFGKEY = 'ledger.cfg.v1';

/* v2 lives in its own Gist file. A v1 client would strip the fields it does not
   know about and push the result back, wiping folders and flags for everyone;
   giving v2 a separate filename makes that impossible. ledger.json is left in
   place untouched, as a frozen pre-folders backup. */
const GIST_FILE = 'ledger-v2.json';
const GIST_FILE_V1 = 'ledger.json';
const GIST_DESC = 'Ledger — objective tracker (synced data)';

const API = 'https://api.github.com';
const PUSH_DEBOUNCE = 1800;
const POLL_MS = 60000;
const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;

const PROJ_FIELDS = ['id', 'folderId', 'name', 'owner', 'notes', 'exception', 'tags', 'flags', 'pinned', 'archived', 'deleted', 'createdAt', 'updatedAt'];
const PANEL_DEF = { x: 20, y: 20, w: 270, h: 230, collapsed: false };
const FOLDER_FIELDS = ['id', 'name', 'toggles', 'doneKey', 'initialStance', 'order', 'deleted', 'createdAt', 'updatedAt'];
const FILTER_KEYS = ['all', 'open', 'action', 'waiting', 'exceptions', 'done', 'archived'];

/* Toggles are steps in order, and each carries a stance: after ticking it, is
   the ball in your court or someone else's? The furthest-along ticked step wins,
   so Drafted (pending) → Checked (actionable) → Pending (pending) reads as a
   progression rather than a set of independent flags. An objective therefore has
   exactly one stance and can never appear in both lists.
   With nothing ticked yet, the folder's initialStance applies. */
const STANCES = [
  { id: 'none', glyph: '–', label: 'No bearing on Actionable / Pending', tone: '#7A7480' },
  { id: 'action', glyph: '!', label: 'Ticking this makes it Actionable — your move', tone: '#C96A5E' },
  { id: 'pending', glyph: '…', label: 'Ticking this makes it Pending — waiting on someone', tone: '#8A63D2' }
];
/* never returns -1: an unknown stance reads as 'none' rather than crashing the
   editor on STANCES[-1] */
const stanceOrder = s => Math.max(0, STANCES.findIndex(x => x.id === s));
const SWIPE_W = 168;    // width of the revealed action tray
const SWIPE_TRIGGER = 58;
/* Long enough to swallow the synthetic click a gesture emits on release (that
   arrives within a few ms), short enough that a deliberate follow-up tap — a
   tray button, a menu item — still lands. */
const CLICK_GUARD_MS = 220;
const DEFAULT_FILTER = 'open';   // finished work stays out of the way until asked for

/* Toggle colours are stored as hex so any colour is expressible. The named
   tones of v2.0 migrate to their hex equivalents on read. */
const TONE_HEX = { gold: '#D4AF37', purple: '#8A63D2', red: '#C96A5E', cream: '#F4F0E8' };
const PALETTE = ['#D4AF37', '#E8C96A', '#8A63D2', '#B79CE8', '#C96A5E', '#5EA8C9', '#6FC98B', '#F4F0E8'];
const DEFAULT_TONE = '#D4AF37';

/* ================= helpers ================= */
const $ = sel => document.querySelector(sel);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = p => (p || 'p') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const now = () => Date.now();

function relTime(ts) {
  if (!ts) return 'never';
  const d = now() - ts;
  if (d < 45000) return 'just now';
  if (d < 3600000) return Math.round(d / 60000) + 'm ago';
  if (d < 86400000) return Math.round(d / 3600000) + 'h ago';
  if (d < 7 * 86400000) return Math.round(d / 86400000) + 'd ago';
  return new Date(ts).toLocaleDateString();
}
function stampTime(ts) {
  return ts ? new Date(ts).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}

const EXC_SVG = '<svg class="exc-ico" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path class="tri" d="M12 3.6 21.6 20.4H2.4z"/>' +
  '<rect class="mk" x="11.1" y="9.4" width="1.8" height="5.6" rx="0.9"/>' +
  '<circle class="mk" cx="12" cy="17.4" r="1.1"/></svg>';

/* ================= schema ================= */
const isHex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

function normalizeToggle(t, i) {
  const label = typeof t.label === 'string' && t.label.trim() ? t.label : 'Toggle ' + (i + 1);
  const tone = isHex(t.tone) ? t.tone.toUpperCase() : (TONE_HEX[t.tone] || DEFAULT_TONE);
  const stance = STANCES.some(s => s.id === t.stance) ? t.stance : 'none';
  return { key: t.key || uid('t'), label, tone, stance };
}

function normalizeFolder(f, i) {
  const toggles = (Array.isArray(f.toggles) ? f.toggles : []).map(normalizeToggle);
  const list = toggles.length ? toggles : [{ key: uid('t'), label: 'Done', tone: 'gold' }];
  const has = k => list.some(t => t.key === k);
  const doneKey = has(f.doneKey) ? f.doneKey : list[list.length - 1].key;
  // v2.1 stored one action/waiting toggle per folder; fold those into stances
  if (f.actionKey || f.waitKey) {
    for (const t of list) {
      if (t.stance !== 'none') continue;
      if (t.key === f.actionKey) t.stance = 'action';
      else if (t.key === f.waitKey) t.stance = 'pending';
    }
  }
  return {
    id: f.id || uid('f'),
    name: typeof f.name === 'string' ? f.name : '',
    toggles: list,
    doneKey,
    initialStance: (f.initialStance === 'pending' || f.initialStance === 'none') ? f.initialStance : 'action',
    order: typeof f.order === 'number' ? f.order : i,
    deleted: !!f.deleted,
    createdAt: f.createdAt || now(),
    updatedAt: f.updatedAt || f.createdAt || now()
  };
}

/* Tags are lower-cased and de-duplicated on the way in, so the same tag typed
   two ways on two devices still matches. */
function normTags(list) {
  const out = [];
  for (const raw of (Array.isArray(list) ? list : [])) {
    const t = String(raw || '').trim().toLowerCase().replace(/^#/, '');
    if (t && !out.includes(t)) out.push(t);
  }
  return out.sort();
}
const parseTags = str => normTags(String(str || '').split(/[,\n]/));
const tagsToStr = tags => (tags || []).join(', ');

function normalizeProject(p) {
  const flags = {};
  if (p.flags && typeof p.flags === 'object') {
    for (const k of Object.keys(p.flags)) if (p.flags[k]) flags[k] = true;
  }
  return {
    id: p.id || uid(),
    folderId: p.folderId || '',
    name: typeof p.name === 'string' ? p.name : '',
    owner: typeof p.owner === 'string' ? p.owner : '',
    notes: typeof p.notes === 'string' ? p.notes : '',
    exception: typeof p.exception === 'string' ? p.exception : '',
    tags: normTags(p.tags),
    flags,
    pinned: !!p.pinned,
    archived: !!p.archived,
    deleted: !!p.deleted,
    createdAt: p.createdAt || now(),
    updatedAt: p.updatedAt || p.createdAt || now()
  };
}

function defaultFolder(name, toggles, doneLabel) {
  const list = toggles.map((t, i) => normalizeToggle(t, i));
  const done = list.find(t => t.label === doneLabel) || list[list.length - 1];
  return normalizeFolder({ id: uid('f'), name, toggles: list, doneKey: done.key, order: 0 }, 0);
}

/* v1 had no folders and a fixed Checked/Complete pair on every project. Fold
   that into one folder carrying the same two toggles, so nothing changes
   visually for existing objectives. */
function migrate(d) {
  if (!d || typeof d !== 'object') return blankDb();
  if (d.v === 2 && Array.isArray(d.folders) && Array.isArray(d.projects)) {
    return {
      v: 2,
      folders: d.folders.map(normalizeFolder),
      projects: d.projects.map(normalizeProject)
    };
  }
  if (!Array.isArray(d.projects)) return blankDb();

  const folder = defaultFolder('Projects', [
    { key: 'checked', label: 'Checked', tone: 'purple' },
    { key: 'complete', label: 'Complete', tone: 'gold' }
  ], 'Complete');
  const projects = d.projects.map(p => normalizeProject({
    ...p,
    folderId: folder.id,
    flags: { checked: !!p.checked, complete: !!p.complete }
  }));
  return { v: 2, folders: [folder], projects };
}

function blankDb() {
  const solar = defaultFolder('Projects', [
    { key: 'checked', label: 'Checked', tone: 'purple' },
    { key: 'complete', label: 'Complete', tone: 'gold' }
  ], 'Complete');
  return { v: 2, folders: [solar], projects: [] };
}

/* ================= persistence ================= */
function loadDb() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) { /* corrupted — start fresh */ }
  return blankDb();
}
function saveDb() { try { localStorage.setItem(KEY, canon(db)); } catch (e) { toast('Local storage is full', true); } }

function loadCfg() {
  try {
    const raw = localStorage.getItem(CFGKEY);
    if (raw) {
      const c = JSON.parse(raw);
      if (c && typeof c === 'object') return {
        token: c.token || '',
        gistId: c.gistId || '',
        lastSyncAt: c.lastSyncAt || 0,
        // guarded: a stale or hand-edited value must not hide every objective
        filter: FILTER_KEYS.includes(c.filter) ? c.filter : DEFAULT_FILTER,
        folder: c.folder || 'all',
        // panel geometry is a property of this screen, so it is never synced
        panel: Object.assign({}, PANEL_DEF, (c.panel && typeof c.panel === 'object') ? c.panel : {})
      };
    }
  } catch (e) { /* ignore */ }
  return { token: '', gistId: '', lastSyncAt: 0, filter: DEFAULT_FILTER, folder: 'all', panel: Object.assign({}, PANEL_DEF) };
}
function saveCfg() { try { localStorage.setItem(CFGKEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ } }

/* Stable serialisation — used for storage, for the Gist payload, and for change
   detection, so all three agree byte for byte across devices. */
function canonFlags(flags) {
  const o = {};
  for (const k of Object.keys(flags || {}).sort()) if (flags[k]) o[k] = true;
  return o;
}
function canon(d) {
  const folders = (d.folders || []).slice().sort((a, b) => (a.order - b.order) || (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1));
  const projects = (d.projects || []).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || (a.id < b.id ? -1 : 1));
  return JSON.stringify({
    v: 2,
    folders: folders.map(f => {
      const o = {};
      for (const k of FOLDER_FIELDS) {
        o[k] = k === 'toggles'
          ? f.toggles.map(t => ({ key: t.key, label: t.label, tone: t.tone, stance: t.stance }))
          : f[k];
      }
      return o;
    }),
    projects: projects.map(p => {
      const o = {};
      for (const k of PROJ_FIELDS) {
        o[k] = k === 'flags' ? canonFlags(p.flags) : k === 'tags' ? normTags(p.tags) : p[k];
      }
      return o;
    })
  }, null, 2);
}

/* ================= state ================= */
let db = loadDb();
let cfg = loadCfg();
let view = { screen: 'home', id: null };
let ui = {
  q: '', filter: cfg.filter, folder: cfg.folder,
  modal: null, editFolder: null, confirm: null, menu: null,
  swipeId: null, suppressUntil: 0, tonePick: null, hint: null,
  toastMsg: '', toastBad: false, toastTimer: null,
  needsRender: false, focusName: false,
  syncState: 'idle', syncMsg: ''
};
let pushTimer = null;
let pollTimer = null;

/* Layout is chosen by viewport width, not by user agent: a resized desktop
   window and a tablet both get the layout that actually fits. */
const mqWide = window.matchMedia('(min-width: 900px)');
const mqRail = window.matchMedia('(min-width: 1100px)');
const wide = () => mqWide.matches;
const rail = () => mqRail.matches;

/* ================= record helpers ================= */
const liveFolders = () => db.folders.filter(f => !f.deleted).sort((a, b) => (a.order - b.order) || (a.createdAt - b.createdAt));
const live = () => db.projects.filter(p => !p.deleted);
const byId = id => db.projects.find(p => p.id === id) || null;
const folderById = id => db.folders.find(f => f.id === id && !f.deleted) || null;
const folderOf = p => folderById(p.folderId) || liveFolders()[0] || null;
const hasExc = p => !!(p.exception && p.exception.trim());

/* ================= tag suggestions =================
   No model involved — the signal is already in your own data. A tag is worth
   suggesting when it literally appears in this objective's text, when it keeps
   company with tags already applied, or simply because you use it a lot. */
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'has', 'have', 'will',
  'your', 'you', 'their', 'they', 'not', 'but', 'all', 'any', 'can', 'out', 'our', 'its', 'into', 'onto', 'been',
  'were', 'than', 'then', 'when', 'what', 'which', 'about', 'after', 'before', 'over', 'under', 'more', 'most',
  'some', 'such', 'only', 'also', 'just', 'via', 'per', 'get', 'got', 'new', 'one', 'two', 'need', 'needs']);

const wordsOf = s => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w));

function tagStats() {
  const count = new Map(), co = new Map();
  for (const p of live()) {
    for (const t of p.tags) count.set(t, (count.get(t) || 0) + 1);
    for (const a of p.tags) {
      if (!co.has(a)) co.set(a, new Map());
      const m = co.get(a);
      for (const b of p.tags) if (a !== b) m.set(b, (m.get(b) || 0) + 1);
    }
  }
  return { count, co };
}

function suggestTags(p, limit) {
  const { count, co } = tagStats();
  const have = new Set(p.tags);
  const text = (p.name + ' ' + p.owner + ' ' + p.notes + ' ' + p.exception).toLowerCase();
  const tokens = new Set(wordsOf(text));
  const out = [];
  for (const [tag, n] of count) {
    if (have.has(tag)) continue;
    let score = Math.min(n, 10);          // how often you reach for it at all
    let why = 'frequent';
    if (text.includes(tag) || tokens.has(tag)) { score += 100; why = 'match'; }
    else if (wordsOf(tag).some(w => tokens.has(w))) { score += 60; why = 'match'; }
    for (const t of p.tags) {
      const m = co.get(t);
      if (m && m.has(tag)) { score += 30 * m.get(tag); if (why === 'frequent') why = 'related'; }
    }
    out.push({ tag, score, why, n });
  }
  out.sort((a, b) => b.score - a.score || b.n - a.n || (a.tag < b.tag ? -1 : 1));
  return out.slice(0, limit || 8);
}

function isDone(p) {
  const f = folderOf(p);
  return !!(f && p.flags[f.doneKey]);
}
/* The furthest-along ticked step decides where an objective stands. Exactly one
   stance, so it can never show up under both Actionable and Pending. */
function stanceOf(p) {
  if (isDone(p)) return 'done';
  const f = folderOf(p);
  if (!f) return 'none';
  for (let i = f.toggles.length - 1; i >= 0; i--) {
    const t = f.toggles[i];
    if (t.stance !== 'none' && p.flags[t.key]) return t.stance;
  }
  return f.initialStance;               // nothing ticked yet
}
const isAction = p => stanceOf(p) === 'action';
const isWaiting = p => stanceOf(p) === 'pending';

/* The selected folder, or null when the All chip is active. */
function currentFolder() {
  if (ui.folder === 'all') return null;
  return folderById(ui.folder);
}

function touch(rec) { rec.updatedAt = now(); saveDb(); schedulePush(); }

function createProject() {
  const f = currentFolder() || liveFolders()[0];
  if (!f) { toast('Create a folder first', true); return; }
  const p = normalizeProject({ folderId: f.id });
  db.projects.push(p);
  saveDb(); schedulePush();
  view = { screen: 'detail', id: p.id };
  ui.focusName = true;
  render(true);
}

function createFolder() {
  const order = liveFolders().length;
  const f = normalizeFolder({
    name: 'New folder',
    toggles: [
      { key: uid('t'), label: 'Checked', tone: 'purple', stance: 'action' },
      { key: uid('t'), label: 'Done', tone: 'gold' }
    ],
    order
  }, order);
  f.doneKey = f.toggles[1].key;
  db.folders.push(f);
  saveDb(); schedulePush();
  ui.folder = f.id; cfg.folder = f.id; saveCfg();
  ui.editFolder = f.id;
  render(true);
}

function deleteProject(id) {
  const p = byId(id);
  if (!p) return;
  p.deleted = true;
  touch(p);
  ui.confirm = null;
  view = { screen: 'home', id: null };
  render(true);
  toast('Objective deleted');
}

function deleteFolder(id) {
  const f = folderById(id);
  const others = liveFolders().filter(x => x.id !== id);
  if (!f || !others.length) { ui.confirm = null; render(true); return; }
  const target = others[0];
  let moved = 0;
  for (const p of live()) {
    if (p.folderId === id) { p.folderId = target.id; p.updatedAt = now(); moved++; }
  }
  f.deleted = true;
  f.updatedAt = now();
  saveDb(); schedulePush();
  ui.confirm = null;
  ui.editFolder = null;
  if (ui.folder === id) { ui.folder = 'all'; cfg.folder = 'all'; saveCfg(); }
  render(true);
  toast(moved ? 'Folder deleted · ' + moved + ' moved to ' + target.name : 'Folder deleted');
}

/* ================= merge ================= */
function mergeList(localList, remoteList, norm) {
  const map = new Map();
  for (const r of (localList || [])) map.set(r.id, r);
  for (const raw of (remoteList || [])) {
    const r = norm(raw);
    const cur = map.get(r.id);
    if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) map.set(r.id, r);
  }
  const t = now();
  return [...map.values()].filter(r => !(r.deleted && t - (r.updatedAt || 0) > TOMBSTONE_MS));
}

function mergeDb(local, remote) {
  const r = migrate(remote);
  return {
    v: 2,
    folders: mergeList(local.folders, r.folders, normalizeFolder),
    projects: mergeList(local.projects, r.projects, normalizeProject)
  };
}

/* ================= GitHub Gist API ================= */
async function api(method, path, body) {
  const headers = {
    'Authorization': 'Bearer ' + cfg.token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  } catch (e) {
    throw new Error('Could not reach GitHub');
  }
  if (!res.ok) {
    let msg = 'GitHub returned ' + res.status;
    try { const j = await res.json(); if (j && j.message) msg = j.message; } catch (e) { /* no body */ }
    if (res.status === 401) msg = 'Token rejected — it needs the "gist" scope.';
    else if (res.status === 404) msg = 'Gist not found — check the ID, or create a new one.';
    else if (res.status === 403) msg = 'GitHub rate limit hit — try again shortly.';
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

async function readFile(g, name) {
  const f = g && g.files && g.files[name];
  if (!f) return null;
  let content = f.content;
  if (f.truncated && f.raw_url) content = await (await fetch(f.raw_url, { cache: 'no-store' })).text();
  try { return JSON.parse(content); } catch (e) { return null; }
}

async function gistPull() {
  const g = await api('GET', '/gists/' + encodeURIComponent(cfg.gistId));
  const v2 = await readFile(g, GIST_FILE);
  if (v2) return v2;
  // First run against a Gist that still only holds v1 — import it once.
  const v1 = await readFile(g, GIST_FILE_V1);
  return v1 ? migrate(v1) : blankDb();
}

async function gistPush(payload) {
  await api('PATCH', '/gists/' + encodeURIComponent(cfg.gistId), { files: { [GIST_FILE]: { content: payload } } });
}

async function gistCreate() {
  const g = await api('POST', '/gists', {
    description: GIST_DESC,
    public: false,
    files: { [GIST_FILE]: { content: canon(db) } }
  });
  return g.id;
}

/* ================= sync engine ================= */
function linked() { return !!(cfg.token && cfg.gistId); }

function schedulePush() {
  if (!linked()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { doSync(); }, PUSH_DEBOUNCE);
}

let syncing = false;
async function doSync(opts) {
  opts = opts || {};
  if (!linked()) { ui.syncState = 'unlinked'; renderSyncChip(); return; }
  if (syncing) return;
  if (!navigator.onLine) { ui.syncState = 'offline'; renderSyncChip(); return; }

  syncing = true;
  clearTimeout(pushTimer);
  ui.syncState = 'syncing'; ui.syncMsg = ''; renderSyncChip();
  try {
    const remote = await gistPull();
    const merged = mergeDb(db, remote);
    const before = canon(db);
    const after = canon(merged);
    if (after !== before) {
      db = merged;
      saveDb();
      if (view.screen === 'detail') {
        const p = byId(view.id);
        if (!p || p.deleted) view = { screen: 'home', id: null };
      }
      render();
    }
    if (after !== canon(migrate(remote))) await gistPush(after);
    cfg.lastSyncAt = now(); saveCfg();
    ui.syncState = 'ok'; ui.syncMsg = '';
    if (opts.loud) toast('Synced');
  } catch (e) {
    ui.syncState = 'error';
    ui.syncMsg = e.message || 'Sync failed';
    if (opts.loud) toast(ui.syncMsg, true);
  } finally {
    syncing = false;
    renderSyncChip();
    if (ui.modal === 'settings') render();
  }
}

/* ================= toast ================= */
function toast(msg, bad) {
  ui.toastMsg = msg; ui.toastBad = !!bad;
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => { ui.toastMsg = ''; render(); }, 2600);
  render();
}

/* ================= views ================= */
function syncChipHTML() {
  let cls = '', label = '';
  if (!linked()) { cls = ''; label = 'NOT LINKED'; }
  else if (ui.syncState === 'syncing') { cls = 'busy'; label = 'SYNCING'; }
  else if (ui.syncState === 'error') { cls = 'err'; label = 'SYNC ERROR'; }
  else if (ui.syncState === 'offline' || !navigator.onLine) { cls = ''; label = 'OFFLINE'; }
  else { cls = 'ok'; label = 'SYNCED ' + relTime(cfg.lastSyncAt).toUpperCase(); }
  return '<div class="sync-row"><button class="sync-chip ' + cls + '" data-act="settings">' +
    '<span class="sdot"></span>' + esc(label) + '</button></div>';
}

function brandHTML() {
  return '<div class="wordmark-wrap">' +
    '<div class="wordmark">Ledger<span class="ver">v' + esc(APP_VERSION) + '</span></div>' +
    '<div class="gold-rule"></div>' +
    '<div class="stats" id="stats">' + esc(statsText()) + '</div>' +
  '</div>';
}

/* The colour travels as inline custom properties rather than a class, so any
   hex works. Pre-computed rgba avoids relying on color-mix() support. */
function toneVars(hex) {
  return '--t:' + hex + ';--t-b:' + hexToRgba(hex, 0.55) + ';--t-bg:' + hexToRgba(hex, 0.14);
}
function togglesHTML(p, big) {
  const f = folderOf(p);
  if (!f) return '';
  const k = big ? ' lg' : '';
  return f.toggles.map(t =>
    '<button class="tgl' + (p.flags[t.key] ? ' on' : '') + k + '" style="' + toneVars(t.tone) + '"' +
    ' data-act="tgl" data-id="' + p.id + '" data-k="' + t.key + '">' +
    '<span class="dot"></span><span>' + esc(t.label) + '</span></button>'
  ).join('');
}

function folderChipsHTML() {
  const fs = liveFolders();
  return '<div class="seg folders">' +
    '<button class="' + (ui.folder === 'all' ? 'active' : '') + '" data-act="folder" data-id="all">All</button>' +
    fs.map(f => '<button class="' + (ui.folder === f.id ? 'active' : '') + '" data-act="folder" data-id="' + f.id + '">' + esc(f.name || 'Untitled') + '</button>').join('') +
    '<button class="add" data-act="new-folder" aria-label="New folder">+</button>' +
    (currentFolder() ? '<button class="add" data-act="edit-folder" data-id="' + currentFolder().id + '" aria-label="Edit folder">⚙</button>' : '') +
  '</div>';
}

function folderRailHTML() {
  const fs = liveFolders();
  const count = fid => live().filter(p => (fid === 'all' || p.folderId === fid) && (ui.filter !== 'open' || !isDone(p))).length;
  const row = (id, name) =>
    '<button class="rail-row' + (ui.folder === id ? ' active' : '') + '" data-act="folder" data-id="' + id + '">' +
      '<span class="rname">' + esc(name) + '</span><span class="rcount">' + count(id) + '</span>' +
    '</button>';
  return '<div class="pane pane-rail">' +
    '<div class="rail-label">FOLDERS</div>' +
    row('all', 'All') +
    fs.map(f => row(f.id, f.name || 'Untitled')).join('') +
    '<button class="rail-row ghost" data-act="new-folder"><span class="rname">+ New folder</span></button>' +
    (currentFolder() ? '<button class="rail-row ghost" data-act="edit-folder" data-id="' + currentFolder().id + '"><span class="rname">⚙ Edit “' + esc(currentFolder().name || 'Untitled') + '”</span></button>' : '') +
  '</div>';
}

function filtersHTML() {
  const F = [['all', 'All'], ['open', 'Open'], ['action', 'Actionable'], ['waiting', 'Pending'],
             ['exceptions', 'Exceptions'], ['done', 'Done'], ['archived', 'Archived']];
  return '<div class="seg">' + F.map(([k, l]) =>
    '<button class="' + (ui.filter === k ? 'active' : '') + '" data-act="filter" data-f="' + k + '">' + l + '</button>').join('') + '</div>';
}
function searchHTML() {
  return '<div class="search-pill"><input id="q" type="search" placeholder="Search objectives" value="' + esc(ui.q) + '" autocomplete="off" autocorrect="off" spellcheck="false"></div>';
}
function fabHTML(small) {
  return '<button class="fab' + (small ? ' sm' : '') + '" data-act="new" aria-label="Add objective">+</button>';
}

function filtered() {
  const raw = ui.q.trim().toLowerCase();
  // "#tag" searches tags only; a bare word searches everything including tags,
  // which is what makes a tag reach across folders.
  const tagOnly = raw.startsWith('#');
  const q = tagOnly ? raw.slice(1) : raw;
  const fid = ui.folder;
  return live().filter(p => {
    if (ui.filter === 'archived') { if (!p.archived) return false; }
    else if (p.archived) return false;
    if (fid !== 'all' && p.folderId !== fid) return false;
    if (ui.filter === 'open' && isDone(p)) return false;
    if (ui.filter === 'done' && !isDone(p)) return false;
    if (ui.filter === 'action' && !isAction(p)) return false;
    if (ui.filter === 'waiting' && !isWaiting(p)) return false;
    if (ui.filter === 'exceptions' && !hasExc(p)) return false;
    if (q) {
      if (tagOnly) {
        if (!p.tags.some(t => t.includes(q))) return false;
      } else {
        // ticked steps are searchable too: "drafted" finds everything Drafted
        const f = folderOf(p);
        const steps = f ? f.toggles.filter(t => p.flags[t.key]).map(t => t.label).join(' ') : '';
        const hay = (p.name + ' ' + p.owner + ' ' + p.notes + ' ' + p.exception + ' ' +
                     p.tags.join(' ') + ' ' + steps + ' ' + (f ? f.name : '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
    }
    return true;
  }).sort((a, b) => {
    if (hasExc(a) !== hasExc(b)) return hasExc(a) ? -1 : 1;
    if (isDone(a) !== isDone(b)) return isDone(a) ? 1 : -1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

function cardHTML(p) {
  const f = folderOf(p);
  // state classes live on the wrapper, which owns the border — see cardHTML notes
  const cls = ['card-wrap'];
  if (isDone(p)) cls.push('is-complete');
  else if (Object.keys(p.flags).length) cls.push('is-checked');
  if (hasExc(p)) cls.push('is-exception');
  if (wide() && p.id === view.id) cls.push('is-selected');
  const bits = [];
  if (ui.folder === 'all' && f) bits.push(esc((f.name || 'Untitled').toUpperCase()));
  if (p.owner && p.owner.trim()) bits.push(esc(p.owner.trim().toUpperCase()));
  bits.push(relTime(p.updatedAt).toUpperCase());
  if (p.archived) cls.push('is-archived');

  const tags = p.tags.length
    ? '<div class="pc-tags">' + p.tags.slice(0, 4).map(t =>
        '<button class="tag" data-act="tag" data-t="' + esc(t) + '">#' + esc(t) + '</button>').join('') +
      (p.tags.length > 4 ? '<span class="tag more">+' + (p.tags.length - 4) + '</span>' : '') + '</div>'
    : '';

  const open = ui.swipeId === p.id;
  if (open) cls.push('open');
  if (p.archived) cls.push('is-archived');
  return '<div class="' + cls.join(' ') + '" data-wrap="' + p.id + '">' +
    '<div class="card-actions">' +
      '<button class="swipe-btn arch" data-act="archive" data-id="' + p.id + '">' + (p.archived ? 'Restore' : 'Archive') + '</button>' +
      '<button class="swipe-btn del" data-act="ask-delete" data-id="' + p.id + '">Delete</button>' +
    '</div>' +
    '<div class="proj-card" data-act="open" data-id="' + p.id + '"' +
      (open ? ' style="transform:translateX(-' + SWIPE_W + 'px)"' : '') + '>' +
      '<div class="pc-head"><div class="pc-titles">' +
      '<div class="pc-name">' + esc(p.name.trim() || 'Untitled objective') + '</div>' +
      '<div class="pc-meta">' + bits.join(' · ') + '</div>' +
      '</div>' + (hasExc(p) ? EXC_SVG : '') + '</div>' +
      tags +
      '<div class="pc-tgls">' + togglesHTML(p) + '</div>' +
    '</div>' +
  '</div>';
}

function listHTML() {
  const rows = filtered();
  if (!rows.length) {
    const anyHere = live().some(p => ui.folder === 'all' || p.folderId === ui.folder);
    const f = currentFolder();
    let msg;
    const noStance = st => f && f.initialStance !== st && !f.toggles.some(t => t.stance === st);
    if (!anyHere) msg = 'Nothing here yet.<br>Tap + to add an objective.';
    // a stance filter that nothing in this folder can ever reach is a setup gap
    else if (ui.filter === 'action' && noStance('action')) msg = 'Nothing in “' + esc(f.name) + '” can be <b style="color:#C96A5E">Actionable</b> yet.<br>Give a step the <b>!</b> stance, or set the folder to start as Actionable.';
    else if (ui.filter === 'waiting' && noStance('pending')) msg = 'Nothing in “' + esc(f.name) + '” can be <b style="color:#8A63D2">Pending</b> yet.<br>Give a step the <b>…</b> stance in the folder editor.';
    else msg = 'Nothing matches this view.';
    return '<div class="empty-note">' + msg + '</div>';
  }
  return '<div class="card-list">' + rows.map(cardHTML).join('') + '</div>';
}

function statsText() {
  const scope = live().filter(p => ui.folder === 'all' || p.folderId === ui.folder);
  const done = scope.filter(isDone).length;
  const exc = scope.filter(hasExc).length;
  const parts = [scope.length + (scope.length === 1 ? ' OBJECTIVE' : ' OBJECTIVES'), done + ' DONE'];
  if (exc) parts.push(exc + (exc === 1 ? ' EXCEPTION' : ' EXCEPTIONS'));
  return parts.join(' · ');
}

/* Gold chips are inferred from this objective's own words or from tags that
   travel with the ones already on it; plain chips are just your common tags. */
function suggestHTML(p) {
  const sug = suggestTags(p, 8);
  if (!sug.length) return '';
  return '<div class="tag-suggest">' + sug.map(s =>
    '<button class="tag suggest' + (s.why === 'frequent' ? '' : ' hot') + '" data-act="add-tag" data-t="' + esc(s.tag) + '"' +
    ' title="' + (s.why === 'match' ? 'mentioned in this objective' : s.why === 'related' ? 'usually used alongside your current tags' : 'one of your most used tags') + '">' +
    '<span class="plus">+</span>' + esc(s.tag) + '</button>').join('') + '</div>';
}

/* ================= pinned overlay (desktop) =================
   A floating list that stays put while you work elsewhere. Draggable by its
   header, resizable from its corner, and its geometry is remembered per screen. */
const pinned = () => live().filter(p => p.pinned && !p.archived)
  .sort((a, b) => (hasExc(b) ? 1 : 0) - (hasExc(a) ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0));

function pinRowHTML(p) {
  return '<div class="pin-row' + (p.id === view.id ? ' on' : '') + '" data-act="open" data-id="' + p.id + '">' +
    (hasExc(p) ? '<span class="pin-exc">!</span>' : '') +
    '<span class="pin-name">' + esc(p.name.trim() || 'Untitled') + '</span>' +
    '<button class="pin-x" data-act="unpin" data-id="' + p.id + '" aria-label="Unpin">✕</button>' +
  '</div>';
}

function pinPanelHTML() {
  const items = pinned();
  if (!wide() || !items.length || pipOpen()) return '';   // popped out: don't draw it twice
  const g = cfg.panel;
  const canPop = !!window.documentPictureInPicture;
  return '<div class="pin-panel' + (g.collapsed ? ' collapsed' : '') + '" id="pin-panel"' +
    ' style="left:' + g.x + 'px;bottom:' + g.y + 'px;width:' + g.w + 'px;' + (g.collapsed ? '' : 'height:' + g.h + 'px;') + '">' +
    '<div class="pin-head" data-pinhead="1">' +
      '<span class="pin-title">PINNED · ' + items.length + '</span>' +
      (canPop ? '<button class="pin-btn" data-act="pip" title="Pop out into an always-on-top window" aria-label="Pop out">⧉</button>' : '') +
      '<button class="pin-btn" data-act="pin-collapse" aria-label="Collapse">' + (g.collapsed ? '▲' : '▼') + '</button>' +
    '</div>' +
    (g.collapsed ? '' : '<div class="pin-body">' + items.map(pinRowHTML).join('') + '</div>') +
  '</div>';
}

/* ================= popped-out pinned window =================
   Document Picture-in-Picture gives a genuine OS-level window that floats above
   everything and survives minimising Ledger — a DOM panel never could. Chromium
   only, and it needs a user gesture, so it hangs off a button. */
let pipWin = null;
const pipOpen = () => !!(pipWin && !pipWin.closed);

async function openPip() {
  if (!window.documentPictureInPicture) { toast('This browser has no pop-out support', true); return; }
  if (pipOpen()) { pipWin.focus(); return; }
  const g = cfg.panel;
  try {
    pipWin = await documentPictureInPicture.requestWindow({
      width: Math.max(240, Math.round(g.w)),
      height: Math.max(220, Math.round(g.h))
    });
  } catch (err) {
    pipWin = null;
    toast('Could not open the pop-out', true);
    return;
  }
  const d = pipWin.document;
  d.title = 'Ledger — Pinned';
  const link = d.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('style.css', location.href).href;
  d.head.appendChild(link);
  d.body.className = 'pip-body';
  d.addEventListener('click', handleClick);      // same delegation, second document
  pipWin.addEventListener('pagehide', () => { pipWin = null; render(true); });
  renderPip();
  render(true);
}

function renderPip() {
  if (!pipOpen()) return;
  const items = pinned();
  pipWin.document.body.innerHTML =
    '<div class="pip-head"><span class="pin-title">PINNED · ' + items.length + '</span></div>' +
    '<div class="pin-body">' +
      (items.length ? items.map(pinRowHTML).join('') : '<div class="pip-empty">Nothing pinned.<br>Pin an objective in Ledger and it appears here.</div>') +
    '</div>';
}

function menuHTML() {
  if (!ui.menu) return '';
  return ui.menu.kind === 'card' ? cardMenuHTML() : folderMenuHTML();
}

function cardMenuHTML() {
  const p = byId(ui.menu.id);
  if (!p) return '';
  const at = ui.menu.x != null;
  const others = liveFolders().filter(f => f.id !== p.folderId);
  return '<div class="menu-scrim" data-act="close-menu"></div>' +
    '<div class="menu-sheet items' + (at ? ' at-cursor' : '') + '" id="menu-sheet"' +
      (at ? ' style="left:' + ui.menu.x + 'px;top:' + ui.menu.y + 'px"' : '') + '>' +
      '<div class="m-title">' + esc(p.name.trim() || 'Untitled objective') + '</div>' +
      '<button class="m-item gold" data-act="menu-open-card" data-id="' + p.id + '">Open</button>' +
      // distinct act names so these never collide with the detail pane's buttons
      '<button class="m-item" data-act="menu-pin" data-id="' + p.id + '">' + (p.pinned ? 'Unpin' : 'Pin to overlay') + '</button>' +
      '<button class="m-item" data-act="menu-archive" data-id="' + p.id + '">' + (p.archived ? 'Restore' : 'Archive') + '</button>' +
      (others.length
        ? '<div class="m-sub">MOVE TO</div>' + others.map(f =>
            '<button class="m-item dim" data-act="menu-move" data-id="' + p.id + '" data-f="' + f.id + '">' + esc(f.name || 'Untitled') + '</button>').join('')
        : '') +
      '<button class="m-item red" data-act="menu-delete" data-id="' + p.id + '">Delete</button>' +
      '<button class="m-item dim" data-act="close-menu">Cancel</button>' +
    '</div>';
}

function folderMenuHTML() {
  const f = ui.menu && folderById(ui.menu.id);
  if (!f) return '';
  const canDelete = liveFolders().length > 1;
  // a right-click belongs under the cursor; a press-and-hold belongs in the
  // bottom sheet where the thumb already is
  const at = ui.menu.x != null;
  return '<div class="menu-scrim" data-act="close-menu"></div>' +
    '<div class="menu-sheet items' + (at ? ' at-cursor' : '') + '" id="menu-sheet"' +
      (at ? ' style="left:' + ui.menu.x + 'px;top:' + ui.menu.y + 'px"' : '') + '>' +
      '<div class="m-title">' + esc(f.name || 'Untitled') + '</div>' +
      '<button class="m-item gold" data-act="menu-edit" data-id="' + f.id + '">Edit folder &amp; toggles</button>' +
      '<button class="m-item" data-act="menu-only" data-id="' + f.id + '">Show only this folder</button>' +
      '<button class="m-item" data-act="menu-new">New folder</button>' +
      (canDelete ? '<button class="m-item red" data-act="ask-del-folder" data-id="' + f.id + '">Delete folder</button>' : '') +
      '<button class="m-item dim" data-act="close-menu">Cancel</button>' +
    '</div>';
}

/* Explanations are collapsed behind an ⓘ so a screen you already understand
   stays quiet. One open at a time; the choice is not persisted. */
function lblHTML(text, forId, hintId, cls) {
  const tag = forId ? '<label class="lbl' + (cls ? ' ' + cls : '') + '" for="' + forId + '">' + text + '</label>'
                    : '<span class="lbl' + (cls ? ' ' + cls : '') + '">' + text + '</span>';
  if (!hintId) return tag;
  const open = ui.hint === hintId;
  return '<div class="lbl-row">' + tag +
    '<button class="info-btn' + (open ? ' on' : '') + '" data-act="hint" data-h="' + hintId + '"' +
    ' aria-expanded="' + open + '" aria-label="Explain this">i</button></div>';
}
function hintHTML(hintId, html) {
  return ui.hint === hintId ? '<div class="hint">' + html + '</div>' : '';
}

function doneFabHTML() {
  return '<button class="done-fab" data-act="home"><span class="chk">✓</span>Done</button>';
}

/* Phone: one screen at a time, list pushed aside by the detail view.
   Folder and filter chips sit in the bottom cluster with search and add, so the
   controls used on every visit stay inside right-thumb reach. */
function narrowHTML() {
  if (view.screen === 'detail' && byId(view.id)) return detailHTML(false) + doneFabHTML();
  return '<div class="screen home">' +
      brandHTML() + syncChipHTML() +
      '<div id="list-host">' + listHTML() + '</div>' +
      // a real element, not container padding: Chrome drops the bottom padding
      // of a scrollable flex column, which left the last card under the toolbar
      '<div class="foot-spacer"></div>' +
    '</div>' +
    '<div class="bottom-stack">' +
      folderChipsHTML() + filtersHTML() +
      '<div class="bottom-bar">' + searchHTML() + fabHTML() + '</div>' +
    '</div>';
}

/* Desktop: list and detail side by side, plus a folder rail once there is room. */
function wideHTML() {
  const p = byId(view.id);
  return '<div class="split' + (rail() ? ' with-rail' : '') + '">' +
    (rail() ? folderRailHTML() : '') +
    '<div class="pane pane-list">' +
      brandHTML() + syncChipHTML() +
      '<div class="search-row">' + searchHTML() + fabHTML(true) + '</div>' +
      (rail() ? '' : folderChipsHTML()) +
      filtersHTML() +
      '<div id="list-host">' + listHTML() + '</div>' +
    '</div>' +
    '<div class="pane pane-detail">' +
      (p && !p.deleted ? detailHTML(true) : emptyPaneHTML()) +
    '</div>' +
  '</div>';
}

function emptyPaneHTML() {
  const n = live().length;
  return '<div class="pane-empty">' +
    '<div class="pe-mark">' + (n ? '‹' : '+') + '</div>' +
    '<div>' + (n ? 'Select an objective to see its detail.' : 'No objectives yet.') + '</div>' +
    (n ? '' : '<button class="btn ghost-gold" data-act="new" style="flex:none;padding-left:22px;padding-right:22px">New objective</button>') +
  '</div>';
}

function detailHTML(inPane) {
  const p = byId(view.id);
  if (!p) return inPane ? emptyPaneHTML() : narrowHTML();
  const fs = liveFolders();
  return '<div class="screen detail' + (inPane ? ' in-pane' : '') + '">' +
    (inPane ? '' :
    '<div class="head">' +
      '<button class="icon-btn" data-act="home" aria-label="Back">‹</button>' +
      '<div class="titles"><div class="sub">Objective</div></div>' +
    '</div>') +

    '<div class="field"><label class="lbl" for="f-name">NAME</label>' +
      '<input class="inp" id="f-name" data-f="name" value="' + esc(p.name) + '" placeholder="What is this objective?" autocomplete="off"></div>' +

    '<div class="btn-row wrap">' + togglesHTML(p, true) + '</div>' +

    '<div class="field"><label class="lbl" for="f-folder">FOLDER</label>' +
      '<select class="inp" id="f-folder">' +
        fs.map(f => '<option value="' + f.id + '"' + (f.id === p.folderId ? ' selected' : '') + '>' + esc(f.name || 'Untitled') + '</option>').join('') +
      '</select></div>' +

    '<div class="field">' + lblHTML('TAGS', 'f-tags', 'tags') +
      '<input class="inp" id="f-tags" value="' + esc(tagsToStr(p.tags)) + '" placeholder="concord, alectra, interconnection" autocomplete="off" autocapitalize="none" spellcheck="false">' +
      suggestHTML(p) +
      hintHTML('tags', 'Comma separated. Tags cut across folders — put the same tag on a solar project and its email thread, then tap it on any card to pull both up. Suggestions below are gold when inferred from this objective’s own words, plain when they are simply tags you use often.') +
    '</div>' +

    '<div class="field"><label class="lbl" for="f-owner">OWNER / REFERENCE</label>' +
      '<input class="inp" id="f-owner" data-f="owner" value="' + esc(p.owner) + '" placeholder="Optional" autocomplete="off"></div>' +

    '<div class="field"><label class="lbl" for="f-notes">NOTES</label>' +
      '<textarea class="inp tall" id="f-notes" data-f="notes" placeholder="Detail, context, next steps…">' + esc(p.notes) + '</textarea></div>' +

    '<div class="field">' + lblHTML('EXCEPTION', 'f-exc', 'exc', 'exc') +
      '<textarea class="inp exc" id="f-exc" data-f="exception" placeholder="Blockers, deviations, anything that needs flagging…">' + esc(p.exception) + '</textarea>' +
      hintHTML('exc', 'Anything written here raises the exception marker on the home card. Leave it empty to clear the flag.') +
    '</div>' +

    '<div class="divider"></div>' +
    '<div class="stamp">CREATED ' + esc(stampTime(p.createdAt)) + '<br>UPDATED ' + esc(stampTime(p.updatedAt)) + '</div>' +
    '<div class="btn-row wrap">' +
      '<button class="btn ' + (p.pinned ? 'ghost-gold' : 'ghost') + '" data-act="pin" data-id="' + p.id + '">' + (p.pinned ? '★ Pinned' : '☆ Pin') + '</button>' +
      '<button class="btn ghost" data-act="archive" data-id="' + p.id + '">' + (p.archived ? 'Restore' : 'Archive') + '</button>' +
      '<button class="btn danger" data-act="ask-delete" data-id="' + p.id + '">Delete</button>' +
    '</div>' +
    (inPane ? '' : '<div class="modal-pad"></div>') +
  '</div>';
}

/* ---- folder editor ---- */
function folderEditorHTML() {
  const f = folderById(ui.editFolder);
  if (!f) return '';
  const canDelete = liveFolders().length > 1;
  const n = live().filter(p => p.folderId === f.id).length;
  return '<div class="modal-full">' +
    '<div class="modal-head"><div class="modal-label">FOLDER</div>' +
      '<button class="close-btn" data-act="close-folder" aria-label="Close">✕</button></div>' +

    '<div class="field"><label class="lbl" for="fe-name">NAME</label>' +
      '<input class="inp" id="fe-name" value="' + esc(f.name) + '" placeholder="Folder name" autocomplete="off"></div>' +

    '<div class="field">' + lblHTML('STARTS AS', '', 'starts') +
      '<div class="seg inline">' +
        [['action', 'Actionable'], ['pending', 'Pending'], ['none', 'Neither']].map(([s, l]) =>
          '<button class="' + (f.initialStance === s ? 'active' : '') + '" data-act="folder-initial" data-s="' + s + '">' + l + '</button>').join('') +
      '</div>' +
      hintHTML('starts', 'Where a brand-new objective sits before anything is ticked.') +
    '</div>' +

    '<div class="field">' + lblHTML('STEPS, IN ORDER', '', 'steps') +
      hintHTML('steps',
      '★ marks the folder’s <b>done</b> state: hidden by the Open filter and tallied above. Every folder has exactly one.<br><br>' +
      'The second button cycles what ticking that step <i>means</i>:<br>' +
      '<b style="color:#C96A5E">!</b> → it becomes <b>Actionable</b> (your move) · ' +
      '<b style="color:#8A63D2">…</b> → it becomes <b>Pending</b> (someone else’s) · ' +
      '<b style="color:#7A7480">–</b> → no bearing.<br><br>' +
      'The <b>furthest-along ticked step wins</b>, so Drafted <b style="color:#8A63D2">…</b> then Checked ' +
      '<b style="color:#C96A5E">!</b> then Pending <b style="color:#8A63D2">…</b> walks an objective through the ' +
      'progression. Any number of steps can carry the same stance, and nothing is ever in both lists at once.<br><br>' +
      'Press and hold a row (or drag the ⠿ handle) to reorder. Cards show steps in this order.') +
    '</div>' +

    '<div class="tgl-editor" id="tgl-editor">' + f.toggles.map((t, i) =>
      '<div class="tgl-row" data-row="' + t.key + '" data-i="' + i + '">' +
        '<span class="grip" data-grip="' + t.key + '" aria-hidden="true">⠿</span>' +
        '<button class="tone-swatch" style="background:' + t.tone + '" data-act="tgl-tone" data-k="' + t.key + '" aria-label="Change colour"></button>' +
        '<input class="inp" data-tglabel="' + t.key + '" value="' + esc(t.label) + '" placeholder="Label" autocomplete="off">' +
        '<button class="star' + (f.doneKey === t.key ? ' on' : '') + '" style="--t:#D4AF37"' +
        ' data-act="tgl-done" data-k="' + t.key + '" title="Done state for this folder" aria-label="Done state">★</button>' +
        (() => {
          const s = STANCES[stanceOrder(t.stance)];
          return '<button class="star stance' + (t.stance === 'none' ? '' : ' on') + '" style="--t:' + s.tone + '"' +
            ' data-act="tgl-stance" data-k="' + t.key + '" title="' + esc(s.label) + '" aria-label="' + esc(s.label) + '">' + s.glyph + '</button>';
        })() +
        (f.toggles.length > 1 ? '<button class="close-btn" data-act="tgl-del" data-k="' + t.key + '" aria-label="Remove toggle">✕</button>' : '') +
        (ui.tonePick === t.key
          ? '<div class="palette">' + PALETTE.map(h =>
              '<button class="pswatch' + (h.toUpperCase() === t.tone ? ' on' : '') + '" style="background:' + h + '" data-act="tgl-set-tone" data-k="' + t.key + '" data-h="' + h + '" aria-label="' + h + '"></button>').join('') +
            '<label class="pswatch custom" aria-label="Custom colour">' +
              '<input type="color" data-customtone="' + t.key + '" value="' + t.tone + '">' +
            '</label></div>'
          : '') +
      '</div>').join('') +
    '</div>' +
    '<button class="add-card" data-act="tgl-add">+ Add step</button>' +

    '<div class="divider"></div>' +
    '<div class="stamp">' + n + (n === 1 ? ' OBJECTIVE' : ' OBJECTIVES') + ' IN THIS FOLDER</div>' +
    (canDelete
      ? '<div class="btn-row"><button class="btn danger" data-act="ask-del-folder" data-id="' + f.id + '">Delete folder</button></div>'
      : '<div class="status-line">The last folder cannot be deleted.</div>') +
    '<div class="modal-pad"></div>' +
    '<button class="done-fab" data-act="close-folder"><span class="chk">✓</span>Done</button>' +
  '</div>';
}

function settingsHTML() {
  const l = linked();
  let status = '<div class="status-line">Not linked. Your data is on this device only.</div>';
  if (ui.syncState === 'syncing') status = '<div class="status-line">Syncing…</div>';
  else if (ui.syncState === 'error') status = '<div class="status-line err">' + esc(ui.syncMsg) + '</div>';
  else if (l) status = '<div class="status-line good">Linked · last synced ' + esc(relTime(cfg.lastSyncAt)) + '</div>';

  return '<div class="modal-full">' +
    '<div class="modal-head"><div class="modal-label">SYNC &amp; DATA</div>' +
      '<button class="close-btn" data-act="close-modal" aria-label="Close">✕</button></div>' +

    status +

    '<div class="step"><span class="snum">STEP 1</span>' +
      '<p>Create a GitHub token with only the <code>gist</code> scope: ' +
      '<a href="https://github.com/settings/tokens/new?scopes=gist&amp;description=Ledger" target="_blank" rel="noopener">github.com/settings/tokens/new</a>. ' +
      'Tick <code>gist</code>, nothing else. Copy the token and paste it below.</p>' +
      '<input class="inp" id="f-token" type="password" placeholder="ghp_…" value="' + esc(cfg.token) + '" autocomplete="off" autocorrect="off" spellcheck="false"></div>' +

    '<div class="step"><span class="snum">STEP 2</span>' +
      '<p>On your first device, create the secret Gist that holds the data. On every other device, paste that same Gist ID instead.</p>' +
      '<input class="inp" id="f-gist" placeholder="Gist ID" value="' + esc(cfg.gistId) + '" autocomplete="off" autocorrect="off" spellcheck="false">' +
      '<div class="btn-row">' +
        '<button class="btn ghost-gold" data-act="create-gist"' + (cfg.token ? '' : ' disabled') + '>Create new Gist</button>' +
        '<button class="btn primary" data-act="sync-now"' + (l ? '' : ' disabled') + '>Sync now</button>' +
      '</div></div>' +

    '<div class="step"><span class="snum">BACKUP</span>' +
      '<p>A plain JSON copy, independent of GitHub.</p>' +
      '<div class="btn-row">' +
        '<button class="btn ghost" data-act="export">Export</button>' +
        '<button class="btn ghost" data-act="import">Import</button>' +
      '</div></div>' +

    (l ? '<div class="btn-row"><button class="btn danger" data-act="unlink">Unlink this device</button></div>' : '') +
    '<div class="stamp">Objectives stay on this device even when unlinked.<br>LEDGER v' + esc(APP_VERSION) + ' · SCHEMA V2</div>' +
    '<div class="modal-pad"></div>' +
    '<button class="done-fab" data-act="close-modal"><span class="chk">✓</span>Done</button>' +
  '</div>';
}

function confirmHTML() {
  const c = ui.confirm;
  if (!c) return '';
  let title = '', body = '', act = '', id = '';
  if (c.kind === 'project') {
    const p = byId(c.id);
    if (!p) return '';
    title = p.name.trim() || 'Untitled objective';
    body = 'Delete this objective? It will be removed from every synced device.';
    act = 'do-delete'; id = p.id;
  } else {
    const f = folderById(c.id);
    if (!f) return '';
    const n = live().filter(p => p.folderId === f.id).length;
    const target = liveFolders().find(x => x.id !== f.id);
    title = f.name || 'Untitled';
    body = n
      ? 'Delete this folder? Its ' + n + (n === 1 ? ' objective' : ' objectives') + ' will move to “' + (target ? target.name : '') + '”, keeping their text but losing this folder’s toggle states.'
      : 'Delete this folder? It is empty.';
    act = 'do-del-folder'; id = f.id;
  }
  return '<div class="menu-scrim" data-act="close-confirm"></div>' +
    '<div class="menu-sheet">' +
      '<div class="m-title">' + esc(title) + '</div>' +
      '<div class="m-body">' + esc(body) + '</div>' +
      '<div class="btn-row">' +
        '<button class="btn ghost" data-act="close-confirm">Cancel</button>' +
        '<button class="btn danger" data-act="' + act + '" data-id="' + id + '">Delete</button>' +
      '</div>' +
    '</div>';
}

/* ================= render ================= */
function isTyping() {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

function render(force) {
  if (!force && isTyping()) { ui.needsRender = true; return; }
  ui.needsRender = false;

  let html = wide() ? wideHTML() : narrowHTML();
  html += pinPanelHTML();
  if (ui.editFolder) html += folderEditorHTML();
  if (ui.modal === 'settings') html += settingsHTML();
  if (ui.menu) html += menuHTML();
  if (ui.confirm) html += confirmHTML();
  if (ui.toastMsg) html += '<div class="toast' + (ui.toastBad ? ' bad' : '') + '">' + esc(ui.toastMsg) + '</div>';
  $('#app').innerHTML = html;

  if (ui.focusName) {
    ui.focusName = false;
    const el = $('#f-name');
    if (el) el.focus();
  }
  renderPip();
  syncBottomPad();
  document.dispatchEvent(new Event('ledger:rendered'));
}

/* Measure the bottom cluster so the list can scroll clear of it. A fixed guess
   left the last card underneath once the chip rows wrapped onto a second line. */
let padRO = null;
function syncBottomPad() {
  const app = $('#app');
  if (!app) return;
  const bar = document.querySelector('.bottom-stack');
  app.style.setProperty('--bottom-pad', bar ? bar.offsetHeight + 'px' : '0px');
  if (bar && window.ResizeObserver) {
    if (padRO) padRO.disconnect();
    padRO = new ResizeObserver(() => {
      if (bar.isConnected) app.style.setProperty('--bottom-pad', bar.offsetHeight + 'px');
    });
    padRO.observe(bar);
  }
}

/* Cheap partial updates so typing in search never rebuilds the screen. */
function renderList() {
  const host = $('#list-host');
  if (host) host.innerHTML = listHTML();
  const st = $('#stats');
  if (st) st.textContent = statsText();
}
/* Suggestions are inferred from the objective's own words, so they have to keep
   up as those words are typed — but re-rendering the pane would eat the caret. */
function renderSuggest() {
  const p = byId(view.id);
  if (!p) return;
  const host = document.querySelector('.tag-suggest');
  const html = suggestHTML(p);
  if (host) {
    if (!html) { host.remove(); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    host.replaceWith(tmp.firstElementChild);
  } else if (html) {
    const inp = $('#f-tags');
    if (inp) inp.insertAdjacentHTML('afterend', html);
  }
}

/* Nudge a cursor-anchored menu back inside the window if it would hang off. */
function placeMenu() {
  const el = $('#menu-sheet');
  if (!el || !el.classList.contains('at-cursor') || !ui.menu) return;
  const w = el.offsetWidth, h = el.offsetHeight;
  const x = Math.max(8, Math.min(window.innerWidth - w - 8, ui.menu.x));
  const y = Math.max(8, Math.min(window.innerHeight - h - 8, ui.menu.y));
  el.style.left = x + 'px';
  el.style.top = y + 'px';
}

function renderSyncChip() {
  const row = document.querySelector('.sync-row');
  if (!row) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = syncChipHTML();
  row.replaceWith(tmp.firstElementChild);
}

/* ================= events ================= */
function handleClick(e) {
  // A drag that ended just now must not also register as a tap. This expires on
  // a clock rather than on the next click: if the browser fires no click after
  // the drag, a flag would sit there and eat an unrelated tap later.
  if (now() < ui.suppressUntil) { ui.suppressUntil = 0; e.stopPropagation(); e.preventDefault(); return; }

  const el = e.target.closest('[data-act]');

  // tapping anywhere else closes an open action tray instead of acting
  if (ui.swipeId && (!el || (el.dataset.act !== 'archive' && el.dataset.act !== 'ask-delete'))) {
    ui.swipeId = null; render(true);
    if (!el || el.closest('.proj-card')) return;
  }
  if (!el) return;
  const act = el.dataset.act;

  if (act === 'tag') {
    e.stopPropagation();
    ui.q = '#' + el.dataset.t;
    ui.folder = 'all'; cfg.folder = 'all';
    ui.filter = 'all'; cfg.filter = 'all';
    saveCfg(); render(true);
    toast('Showing #' + el.dataset.t + ' across all folders');
    return;
  }
  if (act === 'archive' || act === 'menu-archive') {
    const p = byId(el.dataset.id);
    if (!p) return;
    p.archived = !p.archived;
    touch(p);
    ui.swipeId = null;
    ui.menu = null;
    render(true);
    toast(p.archived ? 'Archived' : 'Restored');
    return;
  }

  if (act === 'open') { view = { screen: 'detail', id: el.dataset.id }; render(true); return; }
  if (act === 'home') { view = { screen: 'home', id: null }; render(true); return; }
  if (act === 'new') { createProject(); return; }
  if (act === 'filter') { ui.filter = el.dataset.f; cfg.filter = ui.filter; saveCfg(); render(true); return; }
  if (act === 'folder') { ui.folder = el.dataset.id; cfg.folder = ui.folder; saveCfg(); render(true); return; }
  if (act === 'new-folder') { createFolder(); return; }
  if (act === 'edit-folder') { ui.editFolder = el.dataset.id; ui.tonePick = null; render(true); return; }
  if (act === 'close-folder') { readFolderFields(); ui.editFolder = null; ui.tonePick = null; render(true); return; }

  if (act === 'hint') { ui.hint = ui.hint === el.dataset.h ? null : el.dataset.h; render(true); return; }
  if (act === 'close-menu') { ui.menu = null; render(true); return; }
  if (act === 'menu-open-card') { ui.menu = null; view = { screen: 'detail', id: el.dataset.id }; render(true); return; }
  if (act === 'menu-move') {
    const p = byId(el.dataset.id);
    const f = folderById(el.dataset.f);
    ui.menu = null;
    if (!p || !f) { render(true); return; }
    p.folderId = f.id;
    touch(p);
    render(true);
    toast('Moved to ' + f.name);
    return;
  }
  if (act === 'menu-edit') { ui.menu = null; ui.editFolder = el.dataset.id; ui.tonePick = null; render(true); return; }
  if (act === 'menu-only') { ui.menu = null; ui.folder = el.dataset.id; cfg.folder = ui.folder; saveCfg(); render(true); return; }
  if (act === 'menu-new') { ui.menu = null; createFolder(); return; }

  if (act === 'pin' || act === 'unpin' || act === 'menu-pin') {
    e.stopPropagation();
    const p = byId(el.dataset.id);
    if (!p) return;
    p.pinned = act === 'unpin' ? false : !p.pinned;
    touch(p);
    ui.menu = null;
    render(true);
    if (!wide() && p.pinned) toast('Pinned — the overlay shows on desktop');
    return;
  }
  if (act === 'pin-collapse') {
    cfg.panel.collapsed = !cfg.panel.collapsed;
    saveCfg(); render(true);
    return;
  }

  if (act === 'add-tag') {
    const p = byId(view.id);
    if (!p) return;
    p.tags = normTags(p.tags.concat(el.dataset.t));
    touch(p);
    render(true);
    return;
  }
  if (act === 'settings') { ui.modal = 'settings'; render(true); return; }
  if (act === 'close-modal') { readSettingsFields(); ui.modal = null; render(true); return; }
  if (act === 'ask-delete' || act === 'menu-delete') { ui.menu = null; ui.confirm = { kind: 'project', id: el.dataset.id }; render(true); return; }
  if (act === 'ask-del-folder') { readFolderFields(); ui.menu = null; ui.confirm = { kind: 'folder', id: el.dataset.id }; render(true); return; }
  if (act === 'close-confirm') { ui.confirm = null; render(true); return; }
  if (act === 'do-delete') { deleteProject(el.dataset.id); return; }
  if (act === 'do-del-folder') { deleteFolder(el.dataset.id); return; }

  if (act === 'tgl') {
    e.stopPropagation();
    const p = byId(el.dataset.id);
    if (!p) return;
    const k = el.dataset.k;
    if (p.flags[k]) delete p.flags[k]; else p.flags[k] = true;
    touch(p);
    // A card vanishing under your thumb reads as a glitch unless it is explained.
    const gone = !filtered().some(x => x.id === p.id);
    render(true);
    if (gone) {
      const f = folderOf(p);
      toast(f && k === f.doneKey && !p.flags[k] === false ? 'Done — hidden from this view' : 'Hidden from this view');
    }
    return;
  }

  /* ---- folder editor ---- */
  if (act === 'tgl-tone') {
    readFolderFields();
    ui.tonePick = ui.tonePick === el.dataset.k ? null : el.dataset.k;
    render(true); return;
  }
  if (act === 'tgl-set-tone') {
    readFolderFields();
    const f = folderById(ui.editFolder);
    const t = f && f.toggles.find(x => x.key === el.dataset.k);
    if (!t) return;
    t.tone = el.dataset.h.toUpperCase();
    ui.tonePick = null;
    touch(f); render(true); return;
  }
  if (act === 'tgl-done') {
    readFolderFields();
    const f = folderById(ui.editFolder);
    if (!f) return;
    f.doneKey = el.dataset.k;             // exactly one per folder, always owned
    touch(f); render(true); return;
  }
  if (act === 'tgl-stance') {
    readFolderFields();
    const f = folderById(ui.editFolder);
    const t = f && f.toggles.find(x => x.key === el.dataset.k);
    if (!t) return;
    t.stance = STANCES[(stanceOrder(t.stance) + 1) % STANCES.length].id;   // – → ! → … → –
    touch(f); render(true); return;
  }
  if (act === 'folder-initial') {
    readFolderFields();
    const f = folderById(ui.editFolder);
    if (!f) return;
    f.initialStance = el.dataset.s;
    touch(f); render(true); return;
  }
  if (act === 'tgl-add') {
    readFolderFields();
    const f = folderById(ui.editFolder);
    if (!f) return;
    f.toggles.push(normalizeToggle({ label: 'New toggle', tone: '#F4F0E8' }, f.toggles.length));
    touch(f); render(true); return;
  }
  if (act === 'tgl-del') {
    readFolderFields();
    const f = folderById(ui.editFolder);
    if (!f || f.toggles.length <= 1) return;
    const k = el.dataset.k;
    f.toggles = f.toggles.filter(t => t.key !== k);
    if (f.doneKey === k) f.doneKey = f.toggles[f.toggles.length - 1].key;
    // leave each objective's stored flag alone: re-adding the toggle restores it
    touch(f); render(true); return;
  }

  if (act === 'sync-now') {
    readSettingsFields();
    if (!cfg.token) { toast('Paste a token first', true); return; }
    if (!cfg.gistId) { toast('Create a Gist, or paste an existing ID', true); return; }
    doSync({ loud: true });
    return;
  }
  if (act === 'unlink') { cfg.token = ''; cfg.gistId = ''; cfg.lastSyncAt = 0; saveCfg(); ui.syncState = 'unlinked'; render(true); toast('Unlinked'); return; }
  if (act === 'export') { doExport(); return; }
  if (act === 'import') { doImport(); return; }
  if (act === 'create-gist') { doCreateGist(el); return; }
  if (act === 'pip') { openPip(); return; }
}
document.addEventListener('click', handleClick);

/* Field edits write straight through to the model — no re-render, so the
   caret and scroll position survive. */
document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'q') { ui.q = el.value; renderList(); return; }
  if (el.id === 'f-token') { cfg.token = el.value.trim(); saveCfg(); refreshSettingsButtons(); return; }
  if (el.id === 'f-gist') { cfg.gistId = parseGistId(el.value); saveCfg(); refreshSettingsButtons(); return; }
  if (el.id === 'fe-name' || el.dataset.tglabel) { readFolderFields(); return; }
  if (el.id === 'f-tags') {
    const p = byId(view.id);
    if (!p) return;
    p.tags = parseTags(el.value);
    touch(p);
    renderSuggest();
    if (wide()) renderList();
    return;
  }
  if (!el.dataset || !el.dataset.f) return;
  const p = byId(view.id);
  if (!p) return;
  p[el.dataset.f] = el.value;
  touch(p);
  renderSuggest();
  // On desktop the list sits beside the field being edited, so keep it live.
  // Safe for the caret: the focused input is in the detail pane, and only the
  // list subtree is replaced.
  if (wide()) renderList();
});

document.addEventListener('change', e => {
  if (e.target.dataset && e.target.dataset.customtone) {
    readFolderFields();
    const f = folderById(ui.editFolder);
    const t = f && f.toggles.find(x => x.key === e.target.dataset.customtone);
    if (!t) return;
    t.tone = e.target.value.toUpperCase();
    ui.tonePick = null;
    touch(f); render(true);
    return;
  }
  if (e.target.id !== 'f-folder') return;
  const p = byId(view.id);
  if (!p) return;
  p.folderId = e.target.value;
  touch(p);
  render(true);
  const f = folderById(p.folderId);
  if (f) toast('Moved to ' + f.name);
});

document.addEventListener('focusout', () => {
  setTimeout(() => { if (ui.needsRender && !isTyping()) render(); }, 0);
});

/* ================= swipe to reveal =================
   Pointer events so this works with a finger and with a trackpad drag. The
   card follows the finger 1:1 while dragging, then snaps with an overshoot
   curve. Vertical intent wins early so the list still scrolls normally.

   Disabled once the folder rail is on screen: there, a horizontal card drag
   means "move to that folder" instead. */
(() => {
  let id = null, startX = 0, startY = 0, card = null, axis = null, dx = 0;

  const cardEl = t => t && t.closest && t.closest('.proj-card');

  document.addEventListener('pointerdown', e => {
    if (e.button != null && e.button !== 0) return;
    if (rail()) return;
    const c = cardEl(e.target);
    if (!c || e.target.closest('.tgl') || e.target.closest('.tag')) return;
    id = c.parentElement.dataset.wrap;
    card = c; axis = null; dx = 0;
    startX = e.clientX; startY = e.clientY;
    card.style.transition = 'none';
  });

  document.addEventListener('pointermove', e => {
    if (!card) return;
    const mx = e.clientX - startX, my = e.clientY - startY;
    if (!axis) {
      if (Math.abs(mx) < 6 && Math.abs(my) < 6) return;
      axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
      if (axis === 'y') { reset(); return; }        // let the list scroll
      card.parentElement.classList.add('swiping');  // only now reveal the tray
    }
    const base = ui.swipeId === id ? -SWIPE_W : 0;
    dx = Math.max(-SWIPE_W - 26, Math.min(18, base + mx));   // rubber-band both ends
    card.style.transform = 'translateX(' + dx + 'px)';
  });

  function finish() {
    if (!card) return;
    const opened = dx < -SWIPE_TRIGGER;
    card.style.transition = '';                      // hand back to the bouncy CSS curve
    card.style.transform = opened ? 'translateX(-' + SWIPE_W + 'px)' : '';
    card.parentElement.classList.toggle('open', opened);
    card.parentElement.classList.remove('swiping');
    const changed = (ui.swipeId === id) !== opened;
    ui.swipeId = opened ? id : null;
    if (axis === 'x') ui.suppressUntil = now() + CLICK_GUARD_MS;   // a drag is not a tap
    card = null; axis = null;
    if (changed) { /* DOM already reflects it; no re-render, so the animation runs */ }
  }
  function reset() {
    if (!card) return;
    card.style.transition = '';
    card.style.transform = ui.swipeId === id ? 'translateX(-' + SWIPE_W + 'px)' : '';
    card.parentElement.classList.remove('swiping');
    card = null; axis = null;
  }

  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', reset);
})();

/* ================= drag a card onto a folder (desktop rail) ================= */
(() => {
  let src = null, ghost = null, startX = 0, startY = 0, live = false, target = null;

  function clearTarget() {
    if (target) target.classList.remove('drop-on');
    target = null;
  }
  function end(commit) {
    if (ghost) ghost.remove();
    ghost = null;
    if (commit && target && src) {
      const fid = target.dataset.id;
      const p = byId(src);
      if (p && fid && fid !== 'all' && p.folderId !== fid) {
        p.folderId = fid;
        touch(p);
        const f = folderById(fid);
        clearTarget(); src = null; live = false;
        render(true);
        toast('Moved to ' + (f ? f.name : 'folder'));
        return;
      }
    }
    clearTarget();
    if (live) ui.suppressUntil = now() + CLICK_GUARD_MS;
    src = null; live = false;
  }

  document.addEventListener('pointerdown', e => {
    if (!rail() || (e.button != null && e.button !== 0)) return;
    const c = e.target.closest && e.target.closest('.proj-card');
    if (!c || e.target.closest('.tgl') || e.target.closest('.tag')) return;
    src = c.dataset.id; startX = e.clientX; startY = e.clientY; live = false;
  });

  document.addEventListener('pointermove', e => {
    if (!src) return;
    if (!live) {
      if (Math.abs(e.clientX - startX) < 8 && Math.abs(e.clientY - startY) < 8) return;
      live = true;
      const p = byId(src);
      ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.textContent = (p && p.name.trim()) || 'Untitled objective';
      document.body.appendChild(ghost);
      document.body.classList.add('dragging');
    }
    ghost.style.left = e.clientX + 'px';
    ghost.style.top = e.clientY + 'px';
    if (ghost) ghost.style.visibility = 'hidden';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    if (ghost) ghost.style.visibility = '';
    const row = under && under.closest && under.closest('.rail-row[data-id]');
    if (row !== target) {
      clearTarget();
      if (row && row.dataset.id !== 'all') { target = row; target.classList.add('drop-on'); }
    }
  });

  document.addEventListener('pointerup', () => { document.body.classList.remove('dragging'); end(true); });
  document.addEventListener('pointercancel', () => { document.body.classList.remove('dragging'); end(false); });
})();

/* ================= reorder toggles (folder editor) =================
   Press and hold a row, or grab the ⠿ handle, then drag. Rows are shifted with
   transforms during the drag and the array is spliced once on drop, so the
   editor is not re-rendered mid-gesture. */
(() => {
  let holdTimer = null, row = null, rows = [], idx = 0, startY = 0, dy = 0, h = 0, live = false;

  function cleanup() {
    clearTimeout(holdTimer); holdTimer = null;
    for (const r of rows) { r.style.transition = ''; r.style.transform = ''; r.classList.remove('lifted'); }
    rows = []; row = null; live = false; dy = 0;
  }

  function begin() {
    live = true;
    row.classList.add('lifted');
    for (const r of rows) if (r !== row) r.style.transition = 'transform 0.16s ease';
    if (navigator.vibrate) navigator.vibrate(8);
  }

  document.addEventListener('pointerdown', e => {
    if (!ui.editFolder || (e.button != null && e.button !== 0)) return;
    const r = e.target.closest && e.target.closest('.tgl-row');
    if (!r) return;
    const onGrip = !!(e.target.dataset && e.target.dataset.grip);
    if (!onGrip && (e.target.tagName === 'INPUT' || e.target.closest('button'))) return;
    row = r;
    rows = [...document.querySelectorAll('.tgl-row')];
    idx = rows.indexOf(row);
    h = row.getBoundingClientRect().height + 10;   // row height + gap
    startY = e.clientY; dy = 0; live = false;
    if (onGrip) begin();
    else holdTimer = setTimeout(begin, 350);       // press and hold
  });

  document.addEventListener('pointermove', e => {
    if (!row) return;
    if (!live) {
      // moving before the hold completes means they meant to scroll
      if (Math.abs(e.clientY - startY) > 8) cleanup();
      return;
    }
    e.preventDefault();
    dy = e.clientY - startY;
    row.style.transform = 'translateY(' + dy + 'px)';
    const shift = Math.round(dy / h);
    const to = Math.max(0, Math.min(rows.length - 1, idx + shift));
    rows.forEach((r, i) => {
      if (r === row) return;
      let off = 0;
      if (i > idx && i <= to) off = -h;
      else if (i < idx && i >= to) off = h;
      r.style.transform = 'translateY(' + off + 'px)';
    });
  });

  document.addEventListener('pointerup', () => {
    if (!row) return;
    if (!live) { cleanup(); return; }
    const to = Math.max(0, Math.min(rows.length - 1, idx + Math.round(dy / h)));
    const f = folderById(ui.editFolder);
    cleanup();
    if (!f) return;
    if (to !== idx) {
      readFolderFields();
      const [moved] = f.toggles.splice(idx, 1);
      f.toggles.splice(to, 0, moved);
      touch(f);
    }
    ui.suppressUntil = now() + CLICK_GUARD_MS;
    render(true);
  });
  document.addEventListener('pointercancel', cleanup);
})();

/* ================= pinned overlay: drag and resize =================
   Geometry is clamped into the viewport on every commit, so a panel dragged to
   the edge and then met with a smaller window cannot end up unreachable. */
(() => {
  let panel = null, sx = 0, sy = 0, ox = 0, oy = 0;

  function clamp() {
    const g = cfg.panel;
    const el = $('#pin-panel');
    const w = el ? el.offsetWidth : g.w;
    const h = el ? el.offsetHeight : g.h;
    g.x = Math.max(0, Math.min(window.innerWidth - Math.min(w, window.innerWidth), g.x));
    g.y = Math.max(0, Math.min(window.innerHeight - Math.min(h, window.innerHeight), g.y));
  }

  document.addEventListener('pointerdown', e => {
    const head = e.target.closest && e.target.closest('[data-pinhead]');
    if (!head || e.target.closest('button')) return;
    panel = $('#pin-panel');
    if (!panel) return;
    panel.classList.add('dragging');
    sx = e.clientX; sy = e.clientY;
    ox = cfg.panel.x; oy = cfg.panel.y;
    e.preventDefault();
  });

  document.addEventListener('pointermove', e => {
    if (!panel) return;
    cfg.panel.x = ox + (e.clientX - sx);
    cfg.panel.y = oy - (e.clientY - sy);   // anchored to the bottom edge
    clamp();
    panel.style.left = cfg.panel.x + 'px';
    panel.style.bottom = cfg.panel.y + 'px';
  });

  function drop() {
    if (!panel) return;
    panel.classList.remove('dragging');
    panel = null;
    clamp(); saveCfg();
  }
  document.addEventListener('pointerup', drop);
  document.addEventListener('pointercancel', drop);

  /* the native resize grip changes the element directly, so read it back */
  let ro = null;
  function watch() {
    const el = $('#pin-panel');
    if (!el || !window.ResizeObserver) return;
    if (ro) ro.disconnect();
    ro = new ResizeObserver(() => {
      if (!el.isConnected || cfg.panel.collapsed) return;
      const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
      if (w !== cfg.panel.w || h !== cfg.panel.h) { cfg.panel.w = w; cfg.panel.h = h; saveCfg(); }
    });
    ro.observe(el);
  }
  window.addEventListener('resize', () => { clamp(); const el = $('#pin-panel'); if (el) { el.style.left = cfg.panel.x + 'px'; el.style.bottom = cfg.panel.y + 'px'; } });
  document.addEventListener('ledger:rendered', watch);
})();

/* ================= pull down at the top to sync =================
   Works with a finger (drag past the top of the list) and with a wheel or
   trackpad (keep scrolling up once already at the top). */
(() => {
  const THRESH = 74;
  let sc = null, startY = 0, dist = 0, armed = false, ind = null;

  const scrollerOf = t => t && t.closest && t.closest('.pane-list, .screen');

  function indicator() {
    if (!ind) {
      ind = document.createElement('div');
      ind.className = 'pull-ind';
      document.body.appendChild(ind);
    }
    return ind;
  }
  function show(d, ready) {
    const el = indicator();
    el.textContent = ready ? '↑  release to sync' : '↓  pull to sync';
    el.classList.toggle('ready', ready);
    el.style.opacity = Math.min(1, d / 40);
    el.style.transform = 'translateX(-50%) translateY(' + Math.min(d * 0.5, 46) + 'px)';
  }
  function hide() {
    if (!ind) return;
    ind.style.opacity = '0';
    ind.style.transform = 'translateX(-50%) translateY(0)';
  }

  document.addEventListener('pointerdown', e => {
    const s = scrollerOf(e.target);
    if (!s || s.scrollTop > 0) return;
    if (e.target.closest('.tgl, .tag, .swipe-btn, button, input, textarea, select')) return;
    sc = s; startY = e.clientY; dist = 0; armed = false;
  });

  document.addEventListener('pointermove', e => {
    if (!sc) return;
    if (sc.scrollTop > 0) { sc = null; hide(); return; }
    dist = e.clientY - startY;
    if (dist <= 0) { if (armed) { armed = false; hide(); } return; }
    armed = true;
    show(dist, dist >= THRESH);
  });

  function release() {
    if (!sc) return;
    const go = armed && dist >= THRESH;
    sc = null; armed = false;
    hide();
    if (go) doSync({ loud: true });
  }
  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);

  /* wheel / trackpad: keep pushing up once the list is already at the top */
  let acc = 0, decay = null;
  document.addEventListener('wheel', e => {
    const s = scrollerOf(e.target);
    if (!s || s.scrollTop > 0 || e.deltaY >= 0) { acc = 0; hide(); return; }
    acc += -e.deltaY;
    show(acc * 0.5, acc * 0.5 >= THRESH);
    clearTimeout(decay);
    decay = setTimeout(() => { acc = 0; hide(); }, 400);
    if (acc * 0.5 >= THRESH) { acc = 0; clearTimeout(decay); hide(); doSync({ loud: true }); }
  }, { passive: true });
})();

/* ================= folder context menu =================
   Right-click on desktop, press-and-hold on a phone — both land on the folder
   itself rather than making you hunt for a settings button elsewhere. */
(() => {
  const folderEl = t => t && t.closest && t.closest('[data-act="folder"], .rail-row[data-id]');
  function openFor(el, pt) {
    const id = el.dataset.id;
    if (!id || id === 'all') return false;
    ui.menu = { kind: 'folder', id, x: pt ? pt.x : null, y: pt ? pt.y : null };
    render(true);
    placeMenu();
    if (navigator.vibrate) navigator.vibrate(8);
    return true;
  }

  document.addEventListener('contextmenu', e => {
    const el = folderEl(e.target);
    if (el) {
      e.preventDefault();
      openFor(el, { x: e.clientX, y: e.clientY });
      return;
    }
    // cards answer right-click too — phones keep the swipe tray instead, so
    // this is bound to contextmenu only and never to press-and-hold
    const card = e.target.closest && e.target.closest('.proj-card');
    if (!card) return;
    e.preventDefault();
    ui.menu = { kind: 'card', id: card.dataset.id, x: e.clientX, y: e.clientY };
    render(true);
    placeMenu();
  });

  let timer = null, sx = 0, sy = 0;
  document.addEventListener('pointerdown', e => {
    if (ui.editFolder) return;                 // the editor owns press-and-hold there
    const el = folderEl(e.target);
    if (!el) return;
    sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => {
      timer = null;
      if (openFor(el)) ui.suppressUntil = now() + CLICK_GUARD_MS;
    }, 500);
  });
  const cancel = () => { clearTimeout(timer); timer = null; };
  document.addEventListener('pointermove', e => {
    if (timer && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) cancel();
  });
  document.addEventListener('pointerup', cancel);
  document.addEventListener('pointercancel', cancel);
  document.addEventListener('scroll', cancel, true);
})();

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (ui.menu) { ui.menu = null; render(true); }
    else if (ui.confirm) { ui.confirm = null; render(true); }
    else if (ui.editFolder) { readFolderFields(); ui.editFolder = null; render(true); }
    else if (ui.modal) { readSettingsFields(); ui.modal = null; render(true); }
    else if (view.screen === 'detail') { view = { screen: 'home', id: null }; render(true); }
  }
  if (e.key === 'Enter' && e.target.id === 'f-name') e.target.blur();
});

/* A pasted Gist URL is far likelier than a bare ID, so accept either. */
function parseGistId(v) {
  const s = (v || '').trim();
  const m = s.match(/([0-9a-f]{20,})/i);
  return m ? m[1] : s;
}

function readSettingsFields() {
  const t = $('#f-token'), g = $('#f-gist');
  if (t) cfg.token = t.value.trim();
  if (g) cfg.gistId = parseGistId(g.value);
  saveCfg();
}

/* Typing in the token/gist fields deliberately does not re-render (it would
   eat the caret), so the buttons that depend on them are updated by hand. */
function refreshSettingsButtons() {
  const c = document.querySelector('[data-act="create-gist"]');
  const s = document.querySelector('[data-act="sync-now"]');
  if (c) c.disabled = !cfg.token;
  if (s) s.disabled = !linked();
}

/* Same reasoning for the folder editor: pull the live field values into the
   model before any action that re-renders, so nothing typed is lost. */
function readFolderFields() {
  const f = folderById(ui.editFolder);
  if (!f) return;
  let dirty = false;
  const nameEl = $('#fe-name');
  if (nameEl && nameEl.value !== f.name) { f.name = nameEl.value; dirty = true; }
  for (const el of document.querySelectorAll('[data-tglabel]')) {
    const t = f.toggles.find(x => x.key === el.dataset.tglabel);
    if (t && t.label !== el.value) { t.label = el.value; dirty = true; }
  }
  if (dirty) touch(f);
}

async function doCreateGist(btn) {
  readSettingsFields();
  if (!cfg.token) { toast('Paste a token first', true); return; }
  btn.disabled = true;
  ui.syncState = 'syncing'; ui.syncMsg = '';
  try {
    cfg.gistId = await gistCreate();
    cfg.lastSyncAt = now();
    saveCfg();
    ui.syncState = 'ok';
    render(true);
    toast('Gist created — paste the ID on your other device');
  } catch (e) {
    ui.syncState = 'error'; ui.syncMsg = e.message || 'Could not create the Gist';
    render(true);
    toast(ui.syncMsg, true);
  }
}

function doExport() {
  const blob = new Blob([canon(db)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ledger-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function doImport() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(String(r.result));
        if (!d || !Array.isArray(d.projects)) throw new Error('bad shape');
        db = mergeDb(db, d);
        saveDb();
        render(true);
        toast('Imported');
        schedulePush();
      } catch (e) { toast('That file is not a Ledger export', true); }
    };
    r.readAsText(f);
  };
  inp.click();
}

/* ================= lifecycle ================= */
/* matchMedia 'change' is not dependable everywhere, so the resize event backs
   it up. Both funnel through one guard, so a re-render only happens when the
   layout actually crosses a breakpoint. */
let lastWide = wide(), lastRail = rail();
function onViewportChange() {
  if (wide() === lastWide && rail() === lastRail) return;
  lastWide = wide(); lastRail = rail();
  render(true);
}
mqWide.addEventListener('change', onViewportChange);
mqRail.addEventListener('change', onViewportChange);
window.addEventListener('resize', onViewportChange);

window.addEventListener('online', () => { ui.syncState = 'idle'; doSync(); });
window.addEventListener('offline', () => { ui.syncState = 'offline'; renderSyncChip(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') doSync();
  else { clearTimeout(pushTimer); if (linked()) doSync(); }
});

/* Update path. The worker is asked to check for a new build on every launch and
   every time the app returns to the foreground; when a new one takes over, the
   page reloads itself once so the running code matches the installed build. */
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || refreshing) return;   // first install has nothing stale to replace
    refreshing = true;
    location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      // update() rejects whenever the network is unreachable, which is routine
      // for an offline-capable app — swallow it rather than leaking a rejection
      const check = () => { try { reg.update().catch(() => {}); } catch (e) { /* ignore */ } };
      check();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    }).catch(() => { /* offline support is optional */ });
  });
}

/* Write straight back on boot so a v1 store is upgraded on disk immediately,
   rather than being re-migrated on every launch until the first edit. */
saveDb();
render(true);
if (linked()) { ui.syncState = 'idle'; doSync(); }
else ui.syncState = 'unlinked';
pollTimer = setInterval(() => { if (document.visibilityState === 'visible') doSync(); }, POLL_MS);
