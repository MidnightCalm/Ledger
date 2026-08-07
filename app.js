/* Ledger — objective tracker PWA with GitHub Gist sync.
   Local-first: localStorage is always the working copy. The Gist is a shared
   mirror that every device merges into, per-project, newest-write-wins. */
'use strict';

/* ================= constants ================= */
/* Bump APP_VERSION and CACHE in sw.js together on every release — the version
   shown beside the wordmark is how you tell which build a device is running. */
const APP_VERSION = '1.3.0';
const KEY = 'ledger.db.v1';
const CFGKEY = 'ledger.cfg.v1';
const GIST_FILE = 'ledger.json';
const GIST_DESC = 'Ledger — objective tracker (synced data)';
const API = 'https://api.github.com';
const PUSH_DEBOUNCE = 1800;
const POLL_MS = 60000;
const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;
const FIELDS = ['id', 'name', 'owner', 'notes', 'exception', 'complete', 'checked', 'deleted', 'createdAt', 'updatedAt'];
const FILTER_KEYS = ['all', 'open', 'unchecked', 'exceptions', 'complete'];
const DEFAULT_FILTER = 'open';   // completed work stays out of the way until asked for

/* ================= helpers ================= */
const $ = sel => document.querySelector(sel);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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

/* ================= persistence ================= */
function normalize(p) {
  return {
    id: p.id || uid(),
    name: typeof p.name === 'string' ? p.name : '',
    owner: typeof p.owner === 'string' ? p.owner : '',
    notes: typeof p.notes === 'string' ? p.notes : '',
    exception: typeof p.exception === 'string' ? p.exception : '',
    complete: !!p.complete,
    checked: !!p.checked,
    deleted: !!p.deleted,
    createdAt: p.createdAt || now(),
    updatedAt: p.updatedAt || p.createdAt || now()
  };
}

function loadDb() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.projects)) return { v: 1, projects: d.projects.map(normalize) };
    }
  } catch (e) { /* corrupted — start fresh */ }
  return { v: 1, projects: [] };
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
        filter: FILTER_KEYS.includes(c.filter) ? c.filter : DEFAULT_FILTER
      };
    }
  } catch (e) { /* ignore */ }
  return { token: '', gistId: '', lastSyncAt: 0, filter: DEFAULT_FILTER };
}
function saveCfg() { try { localStorage.setItem(CFGKEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ } }

/* Stable serialisation — used for storage, for the Gist payload, and for
   change detection, so all three agree byte for byte. */
function canon(d) {
  const projects = (d.projects || []).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || (a.id < b.id ? -1 : 1));
  return JSON.stringify({
    v: 1,
    projects: projects.map(p => { const o = {}; for (const k of FIELDS) o[k] = p[k]; return o; })
  }, null, 2);
}

/* ================= state ================= */
let db = loadDb();
let cfg = loadCfg();
let view = { screen: 'home', id: null };
let ui = {
  q: '', filter: cfg.filter, modal: null, confirm: null,
  toastMsg: '', toastBad: false, toastTimer: null,
  needsRender: false, focusName: false,
  syncState: 'idle', syncMsg: '', busy: false
};
let pushTimer = null;
let pollTimer = null;

/* Layout is chosen by viewport width, not by user agent: a resized desktop
   window and a tablet both get the layout that actually fits. */
const mqWide = window.matchMedia('(min-width: 900px)');
const wide = () => mqWide.matches;

/* ================= project ops ================= */
const live = () => db.projects.filter(p => !p.deleted);
const byId = id => db.projects.find(p => p.id === id) || null;
const hasExc = p => !!(p.exception && p.exception.trim());

function touch(p) { p.updatedAt = now(); saveDb(); schedulePush(); }

function createProject() {
  const p = normalize({ name: '' });
  db.projects.push(p);
  saveDb(); schedulePush();
  view = { screen: 'detail', id: p.id };
  ui.focusName = true;
  render(true);
}

function deleteProject(id) {
  const p = byId(id);
  if (!p) return;
  p.deleted = true;
  p.updatedAt = now();
  saveDb(); schedulePush();
  ui.confirm = null;
  view = { screen: 'home', id: null };
  render(true);
  toast('Objective deleted');
}

/* ================= merge ================= */
function mergeDb(local, remote) {
  const map = new Map();
  for (const p of (local.projects || [])) map.set(p.id, p);
  for (const raw of (remote.projects || [])) {
    const r = normalize(raw);
    const cur = map.get(r.id);
    if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) map.set(r.id, r);
  }
  const t = now();
  const projects = [...map.values()].filter(p => !(p.deleted && t - (p.updatedAt || 0) > TOMBSTONE_MS));
  return { v: 1, projects };
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

async function gistPull() {
  const g = await api('GET', '/gists/' + encodeURIComponent(cfg.gistId));
  const f = g && g.files && g.files[GIST_FILE];
  if (!f) return { v: 1, projects: [] };
  let content = f.content;
  if (f.truncated && f.raw_url) content = await (await fetch(f.raw_url, { cache: 'no-store' })).text();
  try {
    const d = JSON.parse(content);
    if (d && Array.isArray(d.projects)) return d;
  } catch (e) { /* remote file is not ours / corrupted — treat as empty */ }
  return { v: 1, projects: [] };
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
    if (after !== canon(remote)) await gistPush(after);
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

function togglesHTML(p, big) {
  const k = big ? ' lg' : '';
  return ['checked', 'complete'].map(key =>
    '<button class="tgl k-' + key + (p[key] ? ' on' : '') + k + '" data-act="tgl" data-id="' + p.id + '" data-k="' + key + '">' +
    '<span class="dot"></span><span>' + (key === 'checked' ? 'Checked' : 'Complete') + '</span></button>'
  ).join('');
}

function filtered() {
  const q = ui.q.trim().toLowerCase();
  return live().filter(p => {
    if (ui.filter === 'open' && p.complete) return false;
    if (ui.filter === 'complete' && !p.complete) return false;
    if (ui.filter === 'unchecked' && p.checked) return false;
    if (ui.filter === 'exceptions' && !hasExc(p)) return false;
    if (q) {
      const hay = (p.name + ' ' + p.owner + ' ' + p.notes + ' ' + p.exception).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    // exceptions first, then incomplete, then most recently touched
    if (hasExc(a) !== hasExc(b)) return hasExc(a) ? -1 : 1;
    if (a.complete !== b.complete) return a.complete ? 1 : -1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

function cardHTML(p) {
  const cls = ['proj-card'];
  if (p.checked) cls.push('is-checked');
  if (p.complete) cls.push('is-complete');
  if (hasExc(p)) cls.push('is-exception');
  if (wide() && p.id === view.id) cls.push('is-selected');
  const bits = [];
  if (p.owner && p.owner.trim()) bits.push(esc(p.owner.trim().toUpperCase()));
  bits.push(relTime(p.updatedAt).toUpperCase());
  return '<div class="' + cls.join(' ') + '" data-act="open" data-id="' + p.id + '">' +
    '<div class="pc-head"><div class="pc-titles">' +
    '<div class="pc-name">' + esc(p.name.trim() || 'Untitled objective') + '</div>' +
    '<div class="pc-meta">' + bits.join(' · ') + '</div>' +
    '</div>' + (hasExc(p) ? EXC_SVG : '') + '</div>' +
    '<div class="pc-tgls">' + togglesHTML(p) + '</div>' +
    '</div>';
}

function listHTML() {
  const rows = filtered();
  if (!rows.length) {
    const all = live().length;
    const msg = !all
      ? 'Nothing tracked yet.<br>Tap + to add your first objective.'
      : 'Nothing matches this view.';
    return '<div class="empty-note">' + msg + '</div>';
  }
  return '<div class="card-list">' + rows.map(cardHTML).join('') + '</div>';
}

function statsText() {
  const a = live();
  const done = a.filter(p => p.complete).length;
  const exc = a.filter(hasExc).length;
  const parts = [a.length + (a.length === 1 ? ' OBJECTIVE' : ' OBJECTIVES'), done + ' COMPLETE'];
  if (exc) parts.push(exc + (exc === 1 ? ' EXCEPTION' : ' EXCEPTIONS'));
  return parts.join(' · ');
}

const FILTERS = [['all', 'All'], ['open', 'Open'], ['unchecked', 'Unchecked'], ['exceptions', 'Exceptions'], ['complete', 'Complete']];

function brandHTML() {
  return '<div class="wordmark-wrap">' +
    '<div class="wordmark">Ledger<span class="ver">v' + esc(APP_VERSION) + '</span></div>' +
    '<div class="gold-rule"></div>' +
    '<div class="stats" id="stats">' + esc(statsText()) + '</div>' +
  '</div>';
}
function filtersHTML() {
  return '<div class="seg">' + FILTERS.map(([k, l]) =>
    '<button class="' + (ui.filter === k ? 'active' : '') + '" data-act="filter" data-f="' + k + '">' + l + '</button>').join('') + '</div>';
}
function searchHTML() {
  return '<div class="search-pill"><input id="q" type="search" placeholder="Search objectives" value="' + esc(ui.q) + '" autocomplete="off" autocorrect="off" spellcheck="false"></div>';
}
function fabHTML(small) {
  return '<button class="fab' + (small ? ' sm' : '') + '" data-act="new" aria-label="Add objective">+</button>';
}

/* Everything autosaves as you type, so this is navigation rather than a save
   gate — but it sits under the thumb, which the top-corner back arrow does not. */
function doneFabHTML() {
  return '<button class="done-fab" data-act="home"><span class="chk">✓</span>Done</button>';
}

/* Phone: one screen at a time, list pushed aside by the detail view. */
function narrowHTML() {
  if (view.screen === 'detail' && byId(view.id)) return detailHTML(false) + doneFabHTML();
  return '<div class="screen home">' +
      brandHTML() + syncChipHTML() + filtersHTML() +
      '<div id="list-host">' + listHTML() + '</div>' +
    '</div>' +
    '<div class="bottom-bar">' + searchHTML() + fabHTML() + '</div>';
}

/* Desktop: list and detail side by side — no navigation, edit while you scan. */
function wideHTML() {
  const p = byId(view.id);
  return '<div class="split">' +
    '<div class="pane pane-list">' +
      brandHTML() + syncChipHTML() +
      '<div class="search-row">' + searchHTML() + fabHTML(true) + '</div>' +
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
  return '<div class="screen detail' + (inPane ? ' in-pane' : '') + '">' +
    (inPane ? '' :
    '<div class="head">' +
      '<button class="icon-btn" data-act="home" aria-label="Back">‹</button>' +
      '<div class="titles"><div class="sub">Objective</div></div>' +
    '</div>') +

    '<div class="field"><label class="lbl" for="f-name">NAME</label>' +
      '<input class="inp" id="f-name" data-f="name" value="' + esc(p.name) + '" placeholder="What is this objective?" autocomplete="off"></div>' +

    '<div class="btn-row">' + togglesHTML(p, true) + '</div>' +

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
    '<div class="stamp">Objectives stay on this device even when unlinked.<br>LEDGER v' + esc(APP_VERSION) + '</div>' +
  '</div>';
}

function confirmHTML() {
  const p = byId(ui.confirm);
  if (!p) return '';
  return '<div class="menu-scrim" data-act="close-confirm"></div>' +
    '<div class="menu-sheet">' +
      '<div class="m-title">' + esc(p.name.trim() || 'Untitled objective') + '</div>' +
      '<div class="m-body">Delete this objective? It will be removed from every synced device.</div>' +
      '<div class="btn-row">' +
        '<button class="btn ghost" data-act="close-confirm">Cancel</button>' +
        '<button class="btn danger" data-act="do-delete" data-id="' + p.id + '">Delete</button>' +
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
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;

  if (act === 'open') { view = { screen: 'detail', id: el.dataset.id }; render(true); return; }
  if (act === 'home') { view = { screen: 'home', id: null }; render(true); return; }
  if (act === 'new') { createProject(); return; }
  if (act === 'filter') { ui.filter = el.dataset.f; cfg.filter = ui.filter; saveCfg(); render(true); return; }
  if (act === 'settings') { ui.modal = 'settings'; render(true); return; }
  if (act === 'close-modal') { readSettingsFields(); ui.modal = null; render(true); return; }
  if (act === 'ask-delete') { ui.confirm = el.dataset.id; render(true); return; }
  if (act === 'close-confirm') { ui.confirm = null; render(true); return; }
  if (act === 'do-delete') { deleteProject(el.dataset.id); return; }

  if (act === 'tgl') {
    e.stopPropagation();
    const p = byId(el.dataset.id);
    if (!p) return;
    const k = el.dataset.k;
    p[k] = !p[k];
    // Marking complete implies it has been checked; that is the usual order of events.
    if (k === 'complete' && p.complete) p.checked = true;
    touch(p);
    // A card vanishing under your thumb reads as a glitch unless it is explained.
    const gone = !filtered().some(x => x.id === p.id);
    render(true);
    if (gone) toast(k === 'complete' && p.complete ? 'Completed — hidden from this view' : 'Hidden from this view');
    return;
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

document.addEventListener('focusout', () => {
  setTimeout(() => { if (ui.needsRender && !isTyping()) render(); }, 0);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (ui.confirm) { ui.confirm = null; render(true); }
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
   layout actually crosses the breakpoint. */
let lastWide = wide();
function onViewportChange() {
  if (wide() === lastWide) return;
  lastWide = wide();
  render(true);
}
mqWide.addEventListener('change', onViewportChange);
window.addEventListener('resize', onViewportChange);
window.addEventListener('online', () => { ui.syncState = 'idle'; doSync(); });
window.addEventListener('offline', () => { ui.syncState = 'offline'; renderSyncChip(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') doSync();
  else { clearTimeout(pushTimer); if (linked()) doSync(); }
});

/* Update path. The worker is asked to check for a new build on every launch and
   every time the app returns to the foreground; when a new one takes over, the
   page reloads itself once so the running code matches the installed build.
   Without this an installed PWA can sit on a stale bundle indefinitely. */
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
      reg.update();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update();
      });
    }).catch(() => { /* offline support is optional */ });
  });
}

render(true);
if (linked()) { ui.syncState = 'idle'; doSync(); }
else ui.syncState = 'unlinked';
pollTimer = setInterval(() => { if (document.visibilityState === 'visible') doSync(); }, POLL_MS);
