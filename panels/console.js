// ─── Console Panel + Shared Renderers ─────────────────────────────────────
// Load saved log level filters from localStorage
function getStoredLogLevels() {
  try {
    const saved = localStorage.getItem('rn-debug-log-levels');
    if (saved) return JSON.parse(saved);
  } catch {}
  return { log: true, info: true, warn: true, error: true, debug: true, redux: false };
}
function setStoredLogLevels(levels) {
  try { localStorage.setItem('rn-debug-log-levels', JSON.stringify(levels)); } catch {}
}

function initConsolePanel() {
  const panel = $('panel-console');
  if (!panel) return;
  const levels = getStoredLogLevels();
  state.console.levelFilters = levels;
  state.console.showRedux = !!levels.redux;

  panel.innerHTML = `
    <div class="panel-toolbar">
      <span class="panel-label">Console</span>
      <span class="badge" id="cBadge">0</span>
      <input id="consoleSearch" class="net-search-input" style="margin-left:12px" placeholder="Filter logs..." />
      <div class="ml-auto" style="display:flex;align-items:center;gap:6px">
        <button class="panel-clear-btn" id="consoleExport" title="Export logs as JSON">Export</button>
        <button class="panel-clear-btn" id="consoleClear" title="Clear console">Clear</button>
        <div class="console-level-dropdown" id="consoleLevelDropdown">
          <button class="console-level-btn" id="consoleLevelBtn">Levels ▾</button>
          <div class="console-level-menu" id="consoleLevelMenu">
            <label class="console-level-option"><input type="checkbox" data-level="log" ${levels.log ? 'checked' : ''} /><span class="lvl-dot" style="background:var(--text-mid)"></span>Log</label>
            <label class="console-level-option"><input type="checkbox" data-level="info" ${levels.info ? 'checked' : ''} /><span class="lvl-dot" style="background:var(--accent)"></span>Info</label>
            <label class="console-level-option"><input type="checkbox" data-level="warn" ${levels.warn ? 'checked' : ''} /><span class="lvl-dot" style="background:var(--yellow)"></span>Warn</label>
            <label class="console-level-option"><input type="checkbox" data-level="error" ${levels.error ? 'checked' : ''} /><span class="lvl-dot" style="background:var(--red)"></span>Error</label>
            <label class="console-level-option"><input type="checkbox" data-level="debug" ${levels.debug ? 'checked' : ''} /><span class="lvl-dot" style="background:var(--accent2)"></span>Debug</label>
            <div style="border-top:1px solid var(--border);margin:4px 0"></div>
            <label class="console-level-option"><input type="checkbox" data-level="redux" ${levels.redux ? 'checked' : ''} /><span class="lvl-dot" style="background:var(--green)"></span>Redux Actions</label>
          </div>
        </div>
      </div>
    </div>
    <div class="scroll-area" id="consoleList">
      <div class="empty-state" id="consoleEmpty">
        <div class="icon">⬛</div>
        <div class="label">No logs yet</div>
        <div class="hint">Logs will appear here automatically</div>
      </div>
    </div>
    <div class="console-find-bar" id="consoleFindBar" style="display:none">
      <input id="consoleFindInput" class="console-find-input" placeholder="Find in logs... (Cmd+F)" />
      <span id="consoleFindCount" class="console-find-count"></span>
      <button class="console-find-btn" id="consoleFindPrev" title="Previous">▲</button>
      <button class="console-find-btn" id="consoleFindNext" title="Next">▼</button>
      <button class="console-find-btn" id="consoleFindClose" title="Close (Esc)">✕</button>
    </div>`;

  // Search filter
  $('consoleSearch').addEventListener('input', (e) => {
    state.console.searchFilter = e.target.value.toLowerCase().trim();
    renderConsole();
  });

  // Level dropdown toggle
  $('consoleLevelBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('consoleLevelMenu').classList.toggle('open');
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#consoleLevelDropdown')) {
      $('consoleLevelMenu')?.classList.remove('open');
    }
  });

  // Level checkbox changes
  $('consoleLevelMenu').addEventListener('change', (e) => {
    const checkbox = e.target;
    const level = checkbox.dataset.level;
    if (level) {
      state.console.levelFilters[level] = checkbox.checked;
      if (level === 'redux') state.console.showRedux = checkbox.checked;
      setStoredLogLevels(state.console.levelFilters);
      updateLevelBtnText();
      renderConsole();
    }
  });

  updateLevelBtnText();

  $('consoleExport')?.addEventListener('click', () => {
    const data = JSON.stringify(state.console.logs, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `reactoradar-console-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
  });

  $('consoleClear').addEventListener('click', () => {
    state.console.logs = [];
    _consolePending = [];
    _lastLogMsg = ''; _lastLogRow = null; _lastLogCount = 1;
    $('cBadge').textContent = '0';
    renderConsole();
  });

  // Find bar (Cmd+F)
  let _findMatches = [];
  let _findIdx = -1;

  function doFind(term) {
    // Clear previous highlights
    document.querySelectorAll('.console-find-highlight').forEach(el => {
      el.replaceWith(el.textContent);
    });
    _findMatches = [];
    _findIdx = -1;
    if (!term) { $('consoleFindCount').textContent = ''; return; }

    const rows = document.querySelectorAll('#consoleList .log-row');
    rows.forEach(row => {
      const text = row.textContent.toLowerCase();
      if (text.includes(term.toLowerCase())) _findMatches.push(row);
    });
    $('consoleFindCount').textContent = _findMatches.length ? `${_findMatches.length} found` : 'No matches';
    if (_findMatches.length) { _findIdx = 0; _findMatches[0].scrollIntoView({ block: 'nearest' }); _findMatches[0].style.outline = '1px solid var(--accent)'; }
  }

  function findNav(dir) {
    if (!_findMatches.length) return;
    if (_findMatches[_findIdx]) _findMatches[_findIdx].style.outline = '';
    _findIdx = (_findIdx + dir + _findMatches.length) % _findMatches.length;
    _findMatches[_findIdx].scrollIntoView({ block: 'nearest' });
    _findMatches[_findIdx].style.outline = '1px solid var(--accent)';
    $('consoleFindCount').textContent = `${_findIdx + 1}/${_findMatches.length}`;
  }

  $('consoleFindInput').addEventListener('input', (e) => doFind(e.target.value));
  $('consoleFindPrev').addEventListener('click', () => findNav(-1));
  $('consoleFindNext').addEventListener('click', () => findNav(1));
  $('consoleFindClose').addEventListener('click', () => {
    $('consoleFindBar').style.display = 'none';
    if (_findMatches[_findIdx]) _findMatches[_findIdx].style.outline = '';
    _findMatches = []; _findIdx = -1;
    $('consoleFindInput').value = '';
    $('consoleFindCount').textContent = '';
  });
  $('consoleFindInput').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('consoleFindClose').click();
    if (e.key === 'Enter') findNav(e.shiftKey ? -1 : 1);
  });
}

function updateLevelBtnText() {
  const levels = state.console.levelFilters;
  const logLevels = { log: levels.log, info: levels.info, warn: levels.warn, error: levels.error, debug: levels.debug };
  const allOn = Object.values(logLevels).every(v => v);
  const allOff = Object.values(logLevels).every(v => !v);
  const btn = $('consoleLevelBtn');
  if (!btn) return;
  let text = '';
  if (allOn) text = 'All Levels';
  else if (allOff) text = 'None';
  else text = Object.entries(logLevels).filter(([, v]) => v).map(([k]) => k.charAt(0).toUpperCase() + k.slice(1)).join(', ');
  if (levels.redux) text += (text ? ' + ' : '') + 'Redux';
  btn.textContent = text + ' ▾';
}

// Console is fed via IPC (network-event handled in IPC section above)

// ─── Toast Notifications ─────────────────────────────────────────────────────
let _toastContainer = null;
const _activeToasts = {};

function getToastsEnabled() {
  try { return localStorage.getItem('rn-debug-toasts') !== 'false'; } catch { return true; }
}
function setToastsEnabled(v) {
  try { localStorage.setItem('rn-debug-toasts', v ? 'true' : 'false'); } catch {}
}

function showToast(message, type, targetPanel) {
  if (!getToastsEnabled()) return;
  if (!_toastContainer) {
    _toastContainer = document.createElement('div');
    _toastContainer.id = 'toastContainer';
    _toastContainer.className = 'toast-container';
    document.body.appendChild(_toastContainer);
  }
  // Don't show toast if user is already on the target panel
  if (targetPanel && state.activePanel === targetPanel) return;

  // Deduplicate: if same message already showing, increment count
  const key = `${type}:${message}`;
  if (_activeToasts[key] && _activeToasts[key].el.parentNode) {
    const existing = _activeToasts[key];
    existing.count++;
    const msgEl = existing.el.querySelector('.toast-msg');
    if (msgEl) msgEl.textContent = `${message} (${existing.count})`;
    // Reset auto-remove timer
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => {
      if (existing.el.parentNode) existing.el.remove();
      delete _activeToasts[key];
    }, 5000);
    return;
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type || 'info'}`;
  toast.innerHTML = `<span class="toast-msg">${esc(message)}</span>`;
  if (targetPanel) {
    const btn = document.createElement('span');
    btn.className = 'toast-action';
    btn.textContent = 'View';
    btn.addEventListener('click', () => { switchPanel(targetPanel); toast.remove(); delete _activeToasts[key]; });
    toast.appendChild(btn);
  }
  const close = document.createElement('span');
  close.className = 'toast-close';
  close.textContent = '✕';
  close.addEventListener('click', () => { toast.remove(); delete _activeToasts[key]; });
  toast.appendChild(close);

  _toastContainer.appendChild(toast);
  const timer = setTimeout(() => {
    if (toast.parentNode) toast.remove();
    delete _activeToasts[key];
  }, 5000);
  _activeToasts[key] = { el: toast, count: 1, timer };
  // Keep max 3 toasts
  const toasts = _toastContainer.querySelectorAll('.toast');
  if (toasts.length > 3) { toasts[0].remove(); }
}

// ─── Batched console append (fixes re-render performance) ────────────────────
let _consolePending = [];
let _consoleRAF = null;

let _lastLogMsg = '';
let _lastLogRow = null;
let _lastLogCount = 1;

const MAX_CONSOLE_LOGS = 5000;

function addConsoleLog(event) {
  state.console.logs.push(event);
  // Cap in-memory logs to prevent memory leak
  if (state.console.logs.length > MAX_CONSOLE_LOGS) {
    state.console.logs = state.console.logs.slice(-MAX_CONSOLE_LOGS);
  }
  _consolePending.push(event);

  // Batch DOM updates via rAF — only one paint per frame
  if (!_consoleRAF) {
    _consoleRAF = requestAnimationFrame(flushConsoleBatch);
  }
}

function flushConsoleBatch() {
  _consoleRAF = null;
  const batch = _consolePending;
  _consolePending = [];
  if (!batch.length) return;

  $('cBadge').textContent = state.console.logs.length;

  const list = $('consoleList');
  const empty = $('consoleEmpty');
  if (!list) return;

  const { levelFilters, searchFilter } = state.console;
  const frag = document.createDocumentFragment();
  let added = 0;

  batch.forEach(l => {
    // Redux logs use showRedux flag; regular logs use levelFilters
    if (l.level === 'redux') {
      if (!state.console.showRedux) return;
    } else if (levelFilters && !levelFilters[l.level]) return;
    if (searchFilter && !l.message?.toLowerCase().includes(searchFilter)) return;

    // Group consecutive identical messages
    const msgKey = `${l.level}:${l.message || ''}`;
    if (msgKey === _lastLogMsg && _lastLogRow && _lastLogRow.parentNode) {
      _lastLogCount++;
      let badge = _lastLogRow.querySelector('.log-group-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'log-group-badge';
        _lastLogRow.insertBefore(badge, _lastLogRow.firstChild);
      }
      badge.textContent = _lastLogCount;
      return; // Don't add a new row
    }

    _lastLogMsg = msgKey;
    _lastLogCount = 1;
    const row = buildLogRow(l);
    _lastLogRow = row;
    frag.appendChild(row);
    added++;
  });

  if (added > 0) {
    // Hide empty state as soon as we have visible rows
    if (empty) empty.style.display = 'none';
    // Auto-scroll only if user is already near the bottom (within 150px)
    const wasAtBottom = (list.scrollHeight - list.scrollTop - list.clientHeight) < 150;
    list.appendChild(frag);
    // Keep DOM size manageable — remove oldest rows
    const rows = list.querySelectorAll('.log-row');
    const MAX_DOM_ROWS = 2000;
    if (rows.length > MAX_DOM_ROWS) {
      const toRemove = rows.length - MAX_DOM_ROWS;
      for (let i = 0; i < toRemove; i++) rows[i].remove();
    }
    if (wasAtBottom) list.scrollTop = list.scrollHeight;
  }
}


// NOTE: console-event IPC listener is registered in init.js

// ─── Object Tree Renderer (Chrome DevTools-like) ─────────────────────────────
// Builds interactive, collapsible DOM nodes for objects/arrays.

// Collect all entries for an object: own data properties + prototype getter values.
// Getter-derived keys use the clean name (e.g. "deliveryId") and skip backing
// fields (e.g. "_deliveryId") so the log output mirrors the model's public API.
function collectEntries(val) {
  if (Array.isArray(val)) return val.map((v, i) => [i, v]);

  const result = {};
  const getterKeys = new Set();

  // 1. Walk prototype chain and invoke getters
  let proto = Object.getPrototypeOf(val);
  while (proto && proto !== Object.prototype) {
    const descs = Object.getOwnPropertyDescriptors(proto);
    for (const [k, desc] of Object.entries(descs)) {
      if (k === 'constructor') continue;
      if (desc.get && !(k in result)) {
        try { result[k] = desc.get.call(val); } catch { /* skip broken getters */ }
        getterKeys.add(k);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }

  // 2. Add own data properties, but skip backing fields whose getter is present.
  //    Convention: getter "foo" backs "_foo"; if "foo" was collected, skip "_foo".
  const ownKeys = Object.keys(val);
  for (const k of ownKeys) {
    const clean = k.startsWith('_') ? k.slice(1) : null;
    if (clean && getterKeys.has(clean)) continue; // skip _backing field
    if (!(k in result)) result[k] = val[k];
  }

  // Sort keys alphabetically for consistent, readable display
  return Object.entries(result).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

function objPreview(val, maxLen) {
  maxLen = maxLen || 80;
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    const items = [];
    let len = 2; // [ ]
    for (let i = 0; i < val.length && len < maxLen; i++) {
      const s = primitivePreview(val[i]);
      len += s.length + 2;
      items.push(s);
    }
    const suffix = items.length < val.length ? ', ...' : '';
    return `(${val.length}) [${items.join(', ')}${suffix}]`;
  }
  if (typeof val === 'object') {
    const entries = collectEntries(val);
    if (entries.length === 0) return '{}';
    const items = [];
    let len = 2;
    for (let i = 0; i < entries.length && len < maxLen; i++) {
      const s = `${entries[i][0]}: ${primitivePreview(entries[i][1])}`;
      len += s.length + 2;
      items.push(s);
    }
    const suffix = items.length < entries.length ? ', ...' : '';
    return `{${items.join(', ')}${suffix}}`;
  }
  return primitivePreview(val);
}

function primitivePreview(val) {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (typeof val === 'string') return val.length > 50 ? `"${val.slice(0,50)}..."` : `"${val}"`;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) return `Array(${val.length})`;
  if (typeof val === 'object') return `{...}`;
  if (typeof val === 'function') return `[Function: ${val.name || 'anonymous'}]`;
  return safeStr(val);
}

function createTreeNode(key, val, startCollapsed) {
  const isArray = Array.isArray(val);
  const isObj = val !== null && typeof val === 'object';

  if (!isObj) {
    // Primitive leaf
    const row = document.createElement('div');
    row.className = 'ov-leaf';
    if (key !== null) {
      const k = document.createElement('span');
      k.className = 'ov-key';
      k.textContent = isNaN(key) ? `${key}: ` : `${key}: `;
      row.appendChild(k);
    }
    row.appendChild(createPrimitiveSpan(val));
    // Right-click to copy value
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const items = [];
      if (key !== null) items.push({ label: `Copy value of "${key}"`, action: () => navigator.clipboard.writeText(safeStr(val)) });
      items.push({ label: 'Copy as JSON', action: () => { try { navigator.clipboard.writeText(JSON.stringify(val)); } catch { navigator.clipboard.writeText(safeStr(val)); } } });
      showContextMenu(e, items);
    });
    return row;
  }

  // Collapsible object/array
  const container = document.createElement('div');
  container.className = 'ov-node';

  const header = document.createElement('div');
  header.className = 'ov-header';

  const arrow = document.createElement('span');
  arrow.className = 'ov-arrow';
  arrow.textContent = '\u25B6'; // ▶
  header.appendChild(arrow);

  if (key !== null) {
    const k = document.createElement('span');
    k.className = 'ov-key';
    k.textContent = `${key}: `;
    header.appendChild(k);
  }

  const preview = document.createElement('span');
  preview.className = 'ov-preview';
  preview.textContent = objPreview(val);
  header.appendChild(preview);

  container.appendChild(header);

  const children = document.createElement('div');
  children.className = 'ov-children';
  children.style.display = 'none';

  let populated = false;

  function populateChildren() {
    if (populated) return;
    populated = true;
    const entries = collectEntries(val);
    entries.forEach(([k, v]) => {
      children.appendChild(createTreeNode(k, v, true));
    });
    // For arrays show length, for objects show prototype hint
    if (isArray) {
      const lenNode = document.createElement('div');
      lenNode.className = 'ov-leaf ov-meta';
      lenNode.textContent = `length: ${val.length}`;
      children.appendChild(lenNode);
    }
  }

  let expanded = !startCollapsed;
  if (expanded) {
    populateChildren();
    children.style.display = 'block';
    arrow.textContent = '\u25BC'; // ▼
    arrow.classList.add('expanded');
    preview.style.display = 'none';
  }

  header.addEventListener('click', (e) => {
    e.stopPropagation();
    expanded = !expanded;
    if (expanded) {
      populateChildren();
      children.style.display = 'block';
      arrow.textContent = '\u25BC';
      arrow.classList.add('expanded');
      preview.style.display = 'none';
    } else {
      children.style.display = 'none';
      arrow.textContent = '\u25B6';
      arrow.classList.remove('expanded');
      preview.style.display = '';
    }
  });

  // Right-click on any node to copy its subtree
  header.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const items = [];
    if (key !== null) {
      items.push({ label: `Copy "${key}" value`, action: () => {
        try { navigator.clipboard.writeText(JSON.stringify(val, null, 2)); } catch { navigator.clipboard.writeText(safeStr(val)); }
      }});
      items.push({ label: `Copy "${key}" key-value`, action: () => {
        try { navigator.clipboard.writeText(JSON.stringify({ [key]: val }, null, 2)); } catch { navigator.clipboard.writeText(`${key}: ${safeStr(val)}`); }
      }});
    }
    items.push({ label: 'Copy entire object', action: () => {
      try { navigator.clipboard.writeText(JSON.stringify(val, null, 2)); } catch { navigator.clipboard.writeText(safeStr(val)); }
    }});
    items.push({ label: 'Copy path', action: () => navigator.clipboard.writeText(key !== null ? String(key) : '') });
    showContextMenu(e, items);
  });

  container.appendChild(children);
  return container;
}

function _safeStr(val) {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  try { return JSON.stringify(val, null, 2); } catch { return '[Complex object]'; }
}

function createPrimitiveSpan(val) {
  const s = document.createElement('span');
  if (val === null) { s.className = 'ov-null'; s.textContent = 'null'; }
  else if (val === undefined) { s.className = 'ov-undef'; s.textContent = 'undefined'; }
  else if (typeof val === 'string') { s.className = 'ov-str'; s.textContent = `"${val}"`; }
  else if (typeof val === 'number') { s.className = 'ov-num'; s.textContent = String(val); }
  else if (typeof val === 'boolean') { s.className = 'ov-bool'; s.textContent = String(val); }
  else { s.textContent = _safeStr(val); }
  return s;
}

// Parse a structured arg from the SDK (or fall back to raw message string)
function renderConsoleArg(arg) {
  if (!arg || typeof arg !== 'object' || !arg.t) {
    // Backward compat: raw string
    const s = document.createElement('span');
    s.className = 'ov-str';
    s.textContent = _safeStr(arg);
    return s;
  }
  const { t, v } = arg;
  if (t === 'string') {
    const s = document.createElement('span');
    s.className = 'log-text';
    s.textContent = v;
    return s;
  }
  if (t === 'number') { return createPrimitiveSpan(v); }
  if (t === 'boolean') { return createPrimitiveSpan(v); }
  if (t === 'null') { return createPrimitiveSpan(null); }
  if (t === 'undefined') { return createPrimitiveSpan(undefined); }
  if (t === 'object' || t === 'array') {
    return createTreeNode(null, v, false);
  }
  const s = document.createElement('span');
  s.textContent = _safeStr(v);
  return s;
}

// Build the body of a console log row. If structured args exist, render each;
// otherwise fall back to the flat message string and try to detect JSON in it.
function buildLogBody(logEntry) {
  const container = document.createElement('div');
  container.className = 'log-body';

  if (logEntry.args && Array.isArray(logEntry.args) && logEntry.args.length > 0) {
    // Structured args from updated SDK
    logEntry.args.forEach((arg, i) => {
      if (i > 0) container.appendChild(document.createTextNode(' '));
      container.appendChild(renderConsoleArg(arg));
    });
  } else if (logEntry.message != null) {
    // Legacy / flat message — try to parse JSON objects out of it
    const msg = safeStr(logEntry.message);
    // Try parsing the whole message as JSON
    try {
      const parsed = JSON.parse(msg);
      if (typeof parsed === 'object' && parsed !== null) {
        container.appendChild(createTreeNode(null, parsed, false));
        return container;
      }
    } catch {}

    // Otherwise render as text, but look for embedded JSON blocks
    // If it looks like it contains JSON, try to pretty-render inline
    const jsonRe = /(\{[\s\S]*\}|\[[\s\S]*\])/;
    const match = msg.match(jsonRe);
    if (match && match[0].length > 2) {
      try {
        const parsed = JSON.parse(match[0]);
        // There's text before/after
        const before = msg.slice(0, match.index);
        const after = msg.slice(match.index + match[0].length);
        if (before) container.appendChild(document.createTextNode(before));
        container.appendChild(createTreeNode(null, parsed, false));
        if (after) container.appendChild(document.createTextNode(after));
        return container;
      } catch {}
    }

    // Plain text
    const span = document.createElement('span');
    span.className = 'log-text';
    span.textContent = msg;
    container.appendChild(span);
  }

  return container;
}

function buildLogRow(l) {
  const div = document.createElement('div');
  div.className = `log-row entry ${l.level}`;

  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  timeSpan.textContent = ts(l.ts);
  div.appendChild(timeSpan);

  const lvlSpan = document.createElement('span');
  lvlSpan.className = `lvl-badge lvl-${l.level}`;
  lvlSpan.textContent = l.level;
  div.appendChild(lvlSpan);

  // Arrow (inline, not inside body-wrap)
  const arrow = document.createElement('span');
  arrow.className = 'log-arrow';
  arrow.textContent = '\u25B6';
  div.appendChild(arrow);

  // Body wrapper
  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'log-body-wrap';

  // Single-line preview: message text + caller
  const preview = document.createElement('div');
  preview.className = 'log-preview';
  const msgText = (l.message || '').replace(/\n/g, ' ').slice(0, 200);
  const previewText = document.createElement('span');
  previewText.textContent = msgText + ((l.message || '').length > 200 ? '...' : '');
  preview.appendChild(previewText);
  bodyWrap.appendChild(preview);

  // Full content (hidden by default)
  const full = document.createElement('div');
  full.className = 'log-full';
  full.style.display = 'none';
  full.appendChild(buildLogBody(l));
  bodyWrap.appendChild(full);

  let expanded = false;
  // Only toggle on click, NOT on text selection drag
  let _mouseDownPos = null;
  bodyWrap.addEventListener('mousedown', (e) => {
    _mouseDownPos = { x: e.clientX, y: e.clientY };
  });
  bodyWrap.addEventListener('click', (e) => {
    // Don't toggle if user is selecting text (dragged mouse)
    if (_mouseDownPos) {
      const dx = Math.abs(e.clientX - _mouseDownPos.x);
      const dy = Math.abs(e.clientY - _mouseDownPos.y);
      if (dx > 3 || dy > 3) return; // user dragged to select
    }
    // Don't toggle if there's an active text selection
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;
    // Don't toggle if clicking inside object tree expander
    if (e.target.closest('.ov-header')) return;
    expanded = !expanded;
    if (expanded) {
      preview.style.display = 'none';
      full.style.display = 'block';
      arrow.textContent = '\u25BC';
      arrow.classList.add('expanded');
    } else {
      preview.style.display = '';
      full.style.display = 'none';
      arrow.textContent = '\u25B6';
      arrow.classList.remove('expanded');
    }
  });

  // Right-click → copy options
  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const items = [];

    // Copy selected text
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) {
      items.push({ label: 'Copy Selection', action: () => navigator.clipboard.writeText(sel.toString()) });
    }

    // Copy full log message
    items.push({ label: 'Copy Message', action: () => {
      navigator.clipboard.writeText(l.message || '');
    }});

    // Copy as JSON (if structured args exist)
    if (l.args && l.args.length > 0) {
      items.push({ label: 'Copy as JSON', action: () => {
        const json = l.args.map(a => {
          if (a.t === 'object' || a.t === 'array') return JSON.stringify(a.v, null, 2);
          return safeStr(a.v);
        }).join(' ');
        navigator.clipboard.writeText(json);
      }});
    }

    // Copy caller location
    if (l.caller) {
      items.push({ label: 'Copy Caller', action: () => navigator.clipboard.writeText(l.caller) });
    }

    showContextMenu(e, items);
  });

  div.appendChild(bodyWrap);
  return div;
}

// ─── Shared context menu helper ──────────────────────────────────────────────
function showContextMenu(e, items) {
  document.querySelectorAll('.ctx-menu').forEach(el => el.remove());
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  items.forEach(({ label, action }) => {
    if (label === '—' || !action) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      return;
    }
    const item = document.createElement('div');
    item.className = 'ctx-item';
    item.textContent = label;
    item.addEventListener('click', () => { action(); menu.remove(); });
    menu.appendChild(item);
  });
  menu.style.left = Math.min(e.clientX, window.innerWidth - 200) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - items.length * 32 - 10) + 'px';
  document.body.appendChild(menu);
  setTimeout(() => {
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
    document.addEventListener('click', close);
  }, 0);
}

// Full re-render — only used on filter/level change, NOT on every incoming log
function renderConsole() {
  const list = $('consoleList');
  const empty = $('consoleEmpty');
  if (!list) return;

  const { levelFilters, searchFilter } = state.console;
  const visible = state.console.logs.filter(l => {
    // Redux logs use showRedux flag; regular logs use levelFilters
    if (l.level === 'redux') {
      if (!state.console.showRedux) return false;
    } else if (levelFilters && !levelFilters[l.level]) return false;
    if (searchFilter && !l.message?.toLowerCase().includes(searchFilter)) return false;
    return true;
  });

  list.querySelectorAll('.log-row').forEach(e => e.remove());
  if (!empty) { /* guard */ }
  else if (visible.length > 0) {
    empty.style.display = 'none';
  } else if (state.console.logs.length > 0) {
    const lbl = empty.querySelector('.label');
    const hint = empty.querySelector('.hint');
    if (lbl) lbl.textContent = 'No matching logs';
    if (hint) hint.textContent = 'Adjust level filters or clear search to see logs';
    empty.style.display = 'flex';
  } else {
    const lbl = empty.querySelector('.label');
    const hint = empty.querySelector('.hint');
    if (lbl) lbl.textContent = 'No logs yet';
    if (hint) hint.textContent = 'Logs will appear here automatically';
    empty.style.display = 'flex';
  }

  // Render only the last N visible rows for performance
  const MAX_RENDER = 5000;
  const toRender = visible.length > MAX_RENDER ? visible.slice(-MAX_RENDER) : visible;
  if (visible.length > MAX_RENDER) {
    const info = document.createElement('div');
    info.className = 'log-row';
    info.style.cssText = 'color:var(--text-dim);font-size:10px;padding:6px 14px;text-align:center;font-style:italic';
    info.textContent = `${visible.length - MAX_RENDER} older logs hidden for performance`;
    list.appendChild(info);
  }

  const frag = document.createDocumentFragment();
  toRender.forEach(l => frag.appendChild(buildLogRow(l)));
  list.appendChild(frag);
  list.scrollTop = list.scrollHeight;
}

