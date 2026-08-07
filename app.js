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
const APP_VERSION = '2.0.0';
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

const PROJ_FIELDS = ['id', 'folderId', 'name', 'owner', 'notes', 'exception', 'tags', 'flags', 'archived', 'deleted', 'createdAt', 'updatedAt'];
const FOLDER_FIELDS = ['id', 'name', 'toggles', 'doneKey', 'order', 'deleted', 'createdAt', 'updatedAt'];
const FILTER_KEYS = ['all', 'open', 'exceptions', 'done', 'archived'];
const SWIPE_W = 168;    // width of the revealed action tray
const SWIPE_TRIGGER = 58;
const DEFAULT_FILTER = 'open';   // finished work stays out of the way until asked for
const TONES = ['gold', 'purple', 'red', 'cream'];

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
function normalizeToggle(t, i) {
  const label = typeof t.label === 'string' && t.label.trim() ? t.label : 'Toggle ' + (i + 1);
  return {
    key: t.key || uid('t'),
    label,
    tone: TONES.includes(t.tone) ? t.tone : 'gold'
  };
}

function normalizeFolder(f, i) {
  const toggles = (Array.isArray(f.toggles) ? f.toggles : []).map(normalizeToggle);
  const list = toggles.length ? toggles : [{ key: uid('t'), label: 'Done', tone: 'gold' }];
  const doneKey = list.some(t => t.key === f.doneKey) ? f.doneKey : list[list.length - 1].key;
  return {
    id: f.id || uid('f'),
    name: typeof f.name === 'string' ? f.name : '',
    toggles: list,
    doneKey,
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
        folder: c.folder || 'all'
      };
    }
  } catch (e) { /* ignore */ }
  return { token: '', gistId: '', lastSyncAt: 0, filter: DEFAULT_FILTER, folder: 'all' };
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
      for (const k of FOLDER_FIELDS) o[k] = k === 'toggles' ? f.toggles.map(t => ({ key: t.key, label: t.label, tone: t.tone })) : f[k];
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
  modal: null, editFolder: null, confirm: null,
  swipeId: null, suppressUntil: 0,
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

function isDone(p) {
  const f = folderOf(p);
  return !!(f && p.flags[f.doneKey]);
}

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
      { key: uid('t'), label: 'Checked', tone: 'purple' },
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

function togglesHTML(p, big) {
  const f = folderOf(p);
  if (!f) return '';
  const k = big ? ' lg' : '';
  return f.toggles.map(t =>
    '<button class="tgl t-' + t.tone + (p.flags[t.key] ? ' on' : '') + k + '" data-act="tgl" data-id="' + p.id + '" data-k="' + t.key + '">' +
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
  const F = [['all', 'All'], ['open', 'Open'], ['exceptions', 'Exceptions'], ['done', 'Done'], ['archived', 'Archived']];
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
    if (ui.filter === 'exceptions' && !hasExc(p)) return false;
    if (q) {
      if (tagOnly) {
        if (!p.tags.some(t => t.includes(q))) return false;
      } else {
        const hay = (p.name + ' ' + p.owner + ' ' + p.notes + ' ' + p.exception + ' ' + p.tags.join(' ')).toLowerCase();
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
  const cls = ['proj-card'];
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
  return '<div class="card-wrap' + (open ? ' open' : '') + '" data-wrap="' + p.id + '">' +
    '<div class="card-actions">' +
      '<button class="swipe-btn arch" data-act="archive" data-id="' + p.id + '">' + (p.archived ? 'Restore' : 'Archive') + '</button>' +
      '<button class="swipe-btn del" data-act="ask-delete" data-id="' + p.id + '">Delete</button>' +
    '</div>' +
    '<div class="' + cls.join(' ') + '" data-act="open" data-id="' + p.id + '"' +
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
    const msg = !anyHere
      ? 'Nothing here yet.<br>Tap + to add an objective.'
      : 'Nothing matches this view.';
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

function doneFabHTML() {
  return '<button class="done-fab" data-act="home"><span class="chk">✓</span>Done</button>';
}

/* Phone: one screen at a time, list pushed aside by the detail view. */
function narrowHTML() {
  if (view.screen === 'detail' && byId(view.id)) return detailHTML(false) + doneFabHTML();
  return '<div class="screen home">' +
      brandHTML() + syncChipHTML() + folderChipsHTML() + filtersHTML() +
      '<div id="list-host">' + listHTML() + '</div>' +
    '</div>' +
    '<div class="bottom-bar">' + searchHTML() + fabHTML() + '</div>';
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

    '<div class="field"><label class="lbl" for="f-tags">TAGS</label>' +
      '<input class="inp" id="f-tags" value="' + esc(tagsToStr(p.tags)) + '" placeholder="concord, alectra, interconnection" autocomplete="off" autocapitalize="none" spellcheck="false">' +
      '<div class="hint">Comma separated. Tags cut across folders — put the same tag on a solar project and its email thread, then tap it on any card to pull both up.</div></div>' +

    '<div class="field"><label class="lbl" for="f-owner">OWNER / REFERENCE</label>' +
      '<input class="inp" id="f-owner" data-f="owner" value="' + esc(p.owner) + '" placeholder="Optional" autocomplete="off"></div>' +

    '<div class="field"><label class="lbl" for="f-notes">NOTES</label>' +
      '<textarea class="inp tall" id="f-notes" data-f="notes" placeholder="Detail, context, next steps…">' + esc(p.notes) + '</textarea></div>' +

    '<div class="field"><label class="lbl exc" for="f-exc">EXCEPTION</label>' +
      '<textarea class="inp exc" id="f-exc" data-f="exception" placeholder="Blockers, deviations, anything that needs flagging…">' + esc(p.exception) + '</textarea>' +
      '<div class="hint">Anything written here raises the exception marker on the home card. Leave it empty to clear the flag.</div></div>' +

    '<div class="divider"></div>' +
    '<div class="stamp">CREATED ' + esc(stampTime(p.createdAt)) + '<br>UPDATED ' + esc(stampTime(p.updatedAt)) + '</div>' +
    '<div class="btn-row"><button class="btn danger" data-act="ask-delete" data-id="' + p.id + '">Delete objective</button></div>' +
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

    '<div class="field"><span class="lbl">TOGGLES</span>' +
      '<div class="hint">These are the switches every objective in this folder gets. The one marked ★ is the folder’s “done” state — it is what the Open filter hides and what the count above tallies.</div></div>' +

    '<div class="tgl-editor">' + f.toggles.map((t, i) =>
      '<div class="tgl-row">' +
        '<button class="tone-swatch tone-' + t.tone + '" data-act="tgl-tone" data-k="' + t.key + '" aria-label="Change colour"></button>' +
        '<input class="inp" data-tglabel="' + t.key + '" value="' + esc(t.label) + '" placeholder="Label" autocomplete="off">' +
        '<button class="star' + (f.doneKey === t.key ? ' on' : '') + '" data-act="tgl-done" data-k="' + t.key + '" aria-label="Mark as the done state">★</button>' +
        (f.toggles.length > 1 ? '<button class="close-btn" data-act="tgl-del" data-k="' + t.key + '" aria-label="Remove toggle">✕</button>' : '') +
      '</div>').join('') +
    '</div>' +
    '<button class="add-card" data-act="tgl-add">+ Add toggle</button>' +

    '<div class="divider"></div>' +
    '<div class="stamp">' + n + (n === 1 ? ' OBJECTIVE' : ' OBJECTIVES') + ' IN THIS FOLDER</div>' +
    (canDelete
      ? '<div class="btn-row"><button class="btn danger" data-act="ask-del-folder" data-id="' + f.id + '">Delete folder</button></div>'
      : '<div class="status-line">The last folder cannot be deleted.</div>') +
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
  if (ui.editFolder) html += folderEditorHTML();
  if (ui.modal === 'settings') html += settingsHTML();
  if (ui.confirm) html += confirmHTML();
  if (ui.toastMsg) html += '<div class="toast' + (ui.toastBad ? ' bad' : '') + '">' + esc(ui.toastMsg) + '</div>';
  $('#app').innerHTML = html;

  if (ui.focusName) {
    ui.focusName = false;
    const el = $('#f-name');
    if (el) el.focus();
  }
}

/* Cheap partial updates so typing in search never rebuilds the screen. */
function renderList() {
  const host = $('#list-host');
  if (host) host.innerHTML = listHTML();
  const st = $('#stats');
  if (st) st.textContent = statsText();
}
function renderSyncChip() {
  const row = document.querySelector('.sync-row');
  if (!row) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = syncChipHTML();
  row.replaceWith(tmp.firstElementChild);
}

/* ================= events ================= */
document.addEventListener('click', e => {
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
  if (act === 'archive') {
    const p = byId(el.dataset.id);
    if (!p) return;
    p.archived = !p.archived;
    touch(p);
    ui.swipeId = null;
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
  if (act === 'edit-folder') { ui.editFolder = el.dataset.id; render(true); return; }
  if (act === 'close-folder') { readFolderFields(); ui.editFolder = null; render(true); return; }
  if (act === 'settings') { ui.modal = 'settings'; render(true); return; }
  if (act === 'close-modal') { readSettingsFields(); ui.modal = null; render(true); return; }
  if (act === 'ask-delete') { ui.confirm = { kind: 'project', id: el.dataset.id }; render(true); return; }
  if (act === 'ask-del-folder') { readFolderFields(); ui.confirm = { kind: 'folder', id: el.dataset.id }; render(true); return; }
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
    const f = folderById(ui.editFolder);
    const t = f && f.toggles.find(x => x.key === el.dataset.k);
    if (!t) return;
    t.tone = TONES[(TONES.indexOf(t.tone) + 1) % TONES.length];
    touch(f); render(true); return;
  }
  if (act === 'tgl-done') {
    readFolderFields();
    const f = folderById(ui.editFolder);
    if (!f) return;
    f.doneKey = el.dataset.k;
    touch(f); render(true); return;
  }
  if (act === 'tgl-add') {
    readFolderFields();
    const f = folderById(ui.editFolder);
    if (!f) return;
    f.toggles.push({ key: uid('t'), label: 'New toggle', tone: 'cream' });
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
});

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
    if (wide()) renderList();
    return;
  }
  if (!el.dataset || !el.dataset.f) return;
  const p = byId(view.id);
  if (!p) return;
  p[el.dataset.f] = el.value;
  touch(p);
  // On desktop the list sits beside the field being edited, so keep it live.
  // Safe for the caret: the focused input is in the detail pane, and only the
  // list subtree is replaced.
  if (wide()) renderList();
});

document.addEventListener('change', e => {
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
   curve. Vertical intent wins early so the list still scrolls normally. */
(() => {
  let id = null, startX = 0, startY = 0, card = null, axis = null, dx = 0;

  const cardEl = t => t && t.closest && t.closest('.proj-card');

  document.addEventListener('pointerdown', e => {
    if (e.button != null && e.button !== 0) return;
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
    const changed = (ui.swipeId === id) !== opened;
    ui.swipeId = opened ? id : null;
    if (axis === 'x') ui.suppressUntil = now() + 400;   // a drag is not a tap
    card = null; axis = null;
    if (changed) { /* DOM already reflects it; no re-render, so the animation runs */ }
  }
  function reset() {
    if (!card) return;
    card.style.transition = '';
    card.style.transform = ui.swipeId === id ? 'translateX(-' + SWIPE_W + 'px)' : '';
    card = null; axis = null;
  }

  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', reset);
})();

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (ui.confirm) { ui.confirm = null; render(true); }
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
