'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  filter: '',
  activePanel: 'console',
  ports: {},

  console: { logs: [], levelFilters: { log: true, info: true, warn: true, error: true, debug: true }, searchFilter: '', showRedux: false },

  network: {
    requests: {},
    order: [],
    statusFilter: 'all',
    typeFilter: 'fetch',
    searchFilter: '',
    throttle: 'none',
    enabled: true,
    selectedId: null,
    sortCol: 'time',
    sortDir: 'desc',
  },

  redux: {
    actions: [],
    states: [],
    selected: -1,
    searchFilter: '',
    sortDir: 'asc',
  },

  storage: {
    entries: {},    // key → value string
    keys: [],       // ordered keys
    selected: null,
    searchFilter: '',
  },

  // Device connection tracking
  connections: { redux: false, network: false, storage: false, reactDT: false },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => s == null ? '' : String(s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const ts = ms => new Date(ms).toLocaleTimeString('en',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});

// Safe string conversion — never returns [object Object]
function safeStr(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  try { return JSON.stringify(val); } catch { return '[Complex object]'; }
}


function pretty(val) {
  if (val == null) return '';
  if (typeof val === 'string') { try { return JSON.stringify(JSON.parse(val),null,2); } catch{} return val; }
  return JSON.stringify(val, null, 2);
}

function syntaxHighlight(json) {
  return json
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, m => {
      if (/^"/.test(m)) return /:$/.test(m) ? `<span class="json-key">${m}</span>` : `<span class="json-str">${m}</span>`;
      if (/true|false/.test(m)) return `<span class="json-bool">${m}</span>`;
      if (/null/.test(m)) return `<span class="json-null">${m}</span>`;
      return `<span class="json-num">${m}</span>`;
    });
}

// Sort object keys alphabetically for display (recursive)
function _sortKeys(obj) {
  if (Array.isArray(obj)) return obj.map(_sortKeys);
  if (obj !== null && typeof obj === 'object') {
    const sorted = {};
    Object.keys(obj).sort().forEach(k => { sorted[k] = _sortKeys(obj[k]); });
    return sorted;
  }
  return obj;
}

function renderJSON(val) {
  if (val == null) return '<span style="color:var(--text-dim)">Empty response</span>';
  try {
    let data = val;
    // Parse string JSON so we can sort keys
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return syntaxHighlight(esc(data)); } }
    const sorted = _sortKeys(data);
    const str = JSON.stringify(sorted, null, 2);
    if (!str || str === '{}' || str === '""') return '<span style="color:var(--text-dim)">Empty response body</span>';
    return syntaxHighlight(esc(str));
  } catch { try { return esc(JSON.stringify(val)); } catch { return esc('[Unserializable data]'); } }
}

function tryURL(url) { try { return new URL(url); } catch { return null; } }

// Extract short caller display from the SDK's caller string.
// SDK now sends: "HomeScreen.tsx:42 (HomeScreen)" or "ProductDetails" or "file.tsx:10"
function extractCallerShort(caller) {
  if (!caller) return '';
  // Already short format from SDK — just clean up
  const trimmed = caller.replace(/^\s*at\s+/, '').trim();
  // If it's just a function name (no file), return as-is
  if (!trimmed.includes(':') && !trimmed.includes('/')) return trimmed;
  // If it's "file.tsx:42 (FuncName)", return "file.tsx:42"
  const m = trimmed.match(/^([^/\\\s]+\.[jt]sx?:\d+)/);
  if (m) return m[1];
  // Fallback
  return trimmed.length > 40 ? trimmed.slice(-40) : trimmed;
}

function highlight(html, term) {
  if (!term) return html;
  const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi');
  return html.replace(re, '<mark>$1</mark>');
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function _getPanelOrder() {
  const order = getTabOrder();
  // Always include settings at the end
  if (!order.includes('settings')) order.push('settings');
  return order;
}

function switchPanel(panel) {
  if (!$(`panel-${panel}`)) return;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const btn = document.querySelector(`.nav-btn[data-panel="${panel}"]`);
  if (btn) btn.classList.add('active');
  $(`panel-${panel}`).classList.add('active');
  state.activePanel = panel;
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchPanel(btn.dataset.panel));
});

// Keyboard shortcuts: Cmd+1–9 for panel switching, Cmd+K clear
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const num = parseInt(e.key);
  const panelOrder = _getPanelOrder();
  if (num >= 1 && num <= panelOrder.length) {
    e.preventDefault();
    const vis = getTabVisibility();
    const target = panelOrder[num - 1];
    if (vis[target] !== false) switchPanel(target);
  }
  if (e.key === 'k') {
    e.preventDefault();
    clearActiveTab();
  }
  if (e.key === 's') {
    e.preventDefault();
    takeScreenshot();
  }
});

// Global filter removed — each panel has its own search input

// ─── Clear (each panel has its own clear button now) ─────────────────────────

function clearActiveTab() {
  switch (state.activePanel) {
    case 'console':
      state.console.logs = [];
      _consolePending = [];
      $('cBadge').textContent = '0';
      renderConsole();
      break;
    case 'network':
      state.network.requests = {};
      state.network.order = [];
      state.network.selectedId = null;
      closeNetDetail();
      $('nBadge').textContent = '0';
      renderNetwork();
      break;
    case 'redux':
      state.redux.actions = [];
      state.redux.states = [];
      state.redux.selected = -1;
      $('rBadge').textContent = '0';
      renderRedux();
      break;
    case 'storage':
      state.storage.entries = {};
      state.storage.keys = [];
      state.storage.selected = null;
      $('sBadge').textContent = '0';
      renderStorage();
      break;
    case 'ga4':
      ga4State.events = [];
      ga4State.selected = -1;
      $('ga4Badge').textContent = '0';
      renderGA4List();
      renderGA4Summary();
      break;
    case 'performance':
      perfState.fps = [];
      perfState.jsThread = [];
      perfState.uiThread = [];
      perfState.data = [];
      const perfFPS = $('perfFPS'); if (perfFPS) perfFPS.textContent = '—';
      const perfJS = $('perfJS'); if (perfJS) perfJS.textContent = '—';
      const perfUI = $('perfUI'); if (perfUI) perfUI.textContent = '—';
      clearPerfCanvas('perfFPSCanvas');
      clearPerfCanvas('perfJSCanvas');
      clearPerfCanvas('perfUICanvas');
      break;
    case 'memory':
      const memHU = $('memHeapUsed'); if (memHU) memHU.textContent = '—';
      const memHT = $('memHeapTotal'); if (memHT) memHT.textContent = '—';
      const memN = $('memNative'); if (memN) memN.textContent = '—';
      break;
    case 'native':
      _nativeState.logs = [];
      if ($('nativeBadge')) $('nativeBadge').textContent = '0';
      const nativeList = $('nativeLogList');
      if (nativeList) nativeList.innerHTML = '';
      break;
    default:
      break;
  }
}

// Clear all (used by IPC clear-all-ui from menu Cmd+K, and on device disconnect)
function clearAll() {
  // Cancel pending render batches
  if (_consoleRAF) { cancelAnimationFrame(_consoleRAF); _consoleRAF = null; }
  if (_netRAF) { cancelAnimationFrame(_netRAF); _netRAF = null; }
  if (_storageRAF) { cancelAnimationFrame(_storageRAF); _storageRAF = null; }
  // Console
  state.console.logs = [];
  _consolePending = [];
  _lastLogMsg = ''; _lastLogRow = null; _lastLogCount = 1;
  // Network
  state.network.requests = {};
  state.network.order = [];
  state.network.selectedId = null;
  closeNetDetail();
  // Redux
  state.redux.actions = [];
  state.redux.states = [];
  state.redux.selected = -1;
  // Storage
  state.storage.entries = {};
  state.storage.keys = [];
  state.storage.selected = null;
  // GA4
  ga4State.events = [];
  ga4State.selected = -1;
  ga4State.searchFilter = '';
  const ga4Search = $('ga4Search');
  if (ga4Search) ga4Search.value = '';
  const ga4Detail = $('ga4Detail');
  if (ga4Detail) ga4Detail.innerHTML = '';
  // Native logs
  _nativeState.logs = [];
  const nativeList = $('nativeLogList');
  if (nativeList) nativeList.innerHTML = '';
  // Performance
  perfState.fps = [];
  perfState.jsThread = [];
  perfState.uiThread = [];
  perfState.data = [];
  const perfFPS = $('perfFPS'); if (perfFPS) perfFPS.textContent = '—';
  const perfJS = $('perfJS'); if (perfJS) perfJS.textContent = '—';
  const perfUI = $('perfUI'); if (perfUI) perfUI.textContent = '—';
  clearPerfCanvas('perfFPSCanvas');
  clearPerfCanvas('perfJSCanvas');
  clearPerfCanvas('perfUICanvas');
  // Memory
  const memHU = $('memHeapUsed'); if (memHU) memHU.textContent = '—';
  const memHT = $('memHeapTotal'); if (memHT) memHT.textContent = '—';
  const memN = $('memNative'); if (memN) memN.textContent = '—';
  // Badges
  const cB = $('cBadge'); if (cB) cB.textContent = '0';
  const nB = $('nBadge'); if (nB) nB.textContent = '0';
  const rB = $('rBadge'); if (rB) rB.textContent = '0';
  const sB = $('sBadge'); if (sB) sB.textContent = '0';
  if ($('ga4Badge')) $('ga4Badge').textContent = '0';
  if ($('nativeBadge')) $('nativeBadge').textContent = '0';
  // Re-render all
  renderConsole();
  renderNetwork();
  renderRedux();
  renderStorage();
  if (typeof renderGA4List === 'function') { renderGA4List(); renderGA4Summary(); }
}

// Free heavy in-memory data without clearing the visible UI.
// Called on device disconnect and app quit to reduce memory footprint
// while keeping logs/network/redux visible for inspection.
function freeMemory() {
  // Drop response/request bodies from network requests (biggest memory hog)
  for (const id of state.network.order) {
    const r = state.network.requests[id];
    if (r) { r.responseBody = null; r.requestBody = null; }
  }
  // Trim console logs to a small tail (keep last 200 for reference)
  if (state.console.logs.length > 200) {
    state.console.logs = state.console.logs.slice(-200);
  }
  // Drop full Redux state snapshots (keep action metadata)
  state.redux.states = [];
  // Drop storage values (keep keys for reference)
  for (const k in state.storage.entries) {
    state.storage.entries[k] = null;
  }
  // Trim GA4 events
  if (ga4State.events.length > 200) {
    ga4State.events = ga4State.events.slice(-200);
  }
  // Trim native logs
  if (_nativeState.logs.length > 200) {
    _nativeState.logs = _nativeState.logs.slice(-200);
  }
  // Drop performance timeline data
  perfState.data = [];
  perfState.fps = [];
  perfState.jsThread = [];
  perfState.uiThread = [];
  // Flush pending console batch
  _consolePending = [];
}

// ─── Device Connection Status (inline in titlebar) ───────────────────────────
function updateDeviceBanner(service, connected) {
  state.connections[service] = connected;
  const el = $('deviceStatus');
  const text = $('deviceText');
  if (!el || !text) return;

  const any = state.connections.redux || state.connections.network || state.connections.storage || state.connections.reactDT;

  if (any) {
    el.className = 'device-status connected';
    text.textContent = 'Device connected';
  } else {
    el.className = 'device-status waiting';
    text.textContent = 'Waiting for device...';
  }
}


function takeScreenshot() {
  const btn = $('btnScreenshot');
  if (!btn) return;
  const origText = btn.innerHTML;
  btn.innerHTML = '<span style="opacity:0.6">Saving...</span>';
  // Use Electron's native capturePage — always works, no DOM rendering issues
  window.electronAPI?.captureScreenshot();
  btn.innerHTML = '<span style="color:var(--green)">Saved!</span>';
  setTimeout(() => { btn.innerHTML = origText; }, 2000);
}
