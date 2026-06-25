// ─── Redux Panel ───────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// REDUX PANEL
// ─────────────────────────────────────────────────────────────────────────────
function initReduxPanel() {
  const panel = $('panel-redux');
  if (!panel) return;
  panel.innerHTML = `
    <div class="panel-toolbar">
      <span class="panel-label">Redux</span>
      <span class="badge" id="rBadge">0</span>
      <input id="reduxSearch" class="net-search-input" style="margin-left:12px" placeholder="Filter actions..." />
      <div class="ml-auto" style="display:flex;align-items:center;gap:8px">
        <button class="panel-clear-btn" id="reduxClear" title="Clear redux">Clear</button>
        <button class="panel-clear-btn" id="reduxSort" title="Toggle sort order">Time ▲</button>
        <div class="time-travel-bar" style="border:none;padding:0;margin:0">
          <button class="tt-btn" onclick="reduxJumpTo(state.redux.selected-1)">◀</button>
          <span class="tt-label" id="ttLabel">—/—</span>
          <button class="tt-btn" onclick="reduxJumpTo(state.redux.selected+1)">▶</button>
        </div>
      </div>
    </div>
    <div class="scroll-area" id="reduxContent">
      <div class="empty-state" id="reduxEmpty">
        <div class="icon">🔲</div>
        <div class="label">No actions dispatched</div>
        <div class="hint">Connect Redux store to RNDebugSDK</div>
      </div>
    </div>`;

  $('reduxSearch').addEventListener('input', (e) => {
    state.redux.searchFilter = e.target.value.toLowerCase().trim();
    renderRedux();
  });

  $('reduxClear').addEventListener('click', () => {
    state.redux.actions = [];
    state.redux.states = [];
    state.redux.selected = -1;
    $('rBadge').textContent = '0';
    renderRedux();
  });

  $('reduxSort').addEventListener('click', () => {
    state.redux.sortDir = state.redux.sortDir === 'desc' ? 'asc' : 'desc';
    $('reduxSort').textContent = state.redux.sortDir === 'desc' ? 'Time \u25BC' : 'Time \u25B2';
    renderRedux();
  });
}

window.reduxJumpTo = idx => {
  const { actions } = state.redux;
  if (!actions.length) return;
  idx = Math.max(0, Math.min(actions.length - 1, idx));
  state.redux.selected = idx;
  renderRedux();
};

// Fast deep equality check for Redux state comparison
function _deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch { return false; }
}

// Find leaf-level changes between two values (for Redux store diff)
function _findLeafChanges(oldVal, newVal, basePath, maxDepth) {
  const changes = [];
  if (maxDepth === undefined) maxDepth = 5;

  function walk(a, b, path, depth) {
    if (depth > maxDepth) {
      if (!_deepEqual(a, b)) changes.push({ path, oldVal: a, newVal: b });
      return;
    }
    if (a === b) return;
    if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
      changes.push({ path, oldVal: a, newVal: b });
      return;
    }
    const allKeys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    allKeys.forEach(k => {
      if (!_deepEqual(a[k], b[k])) {
        const childPath = path ? `${path}.${k}` : k;
        if (a[k] != null && b[k] != null && typeof a[k] === 'object' && typeof b[k] === 'object' && !Array.isArray(a[k])) {
          walk(a[k], b[k], childPath, depth + 1);
        } else {
          changes.push({ path: childPath, oldVal: a[k], newVal: b[k] });
        }
      }
    });
  }

  walk(oldVal, newVal, '', 0);
  return changes;
}

// Create a tree node with changed paths highlighted in a different color
function _createHighlightedTree(key, val, changedPaths, currentPath, isOld) {
  const isArray = Array.isArray(val);
  const isObj = val !== null && typeof val === 'object';
  const myPath = key !== null ? (currentPath ? `${currentPath}.${key}` : String(key)) : currentPath;
  const isChanged = changedPaths.has(myPath);

  if (!isObj) {
    // Leaf value
    const row = document.createElement('div');
    row.className = 'ov-leaf' + (isChanged ? ' rdx-highlight' : '');
    if (isChanged) row.style.cssText = isOld
      ? 'background:rgba(255,94,114,.12);border-radius:3px;padding:1px 4px;'
      : 'background:rgba(61,214,140,.12);border-radius:3px;padding:1px 4px;';
    if (key !== null) {
      const k = document.createElement('span');
      k.className = 'ov-key';
      k.style.color = isChanged ? (isOld ? 'var(--red)' : 'var(--green)') : '';
      k.textContent = `${key}: `;
      row.appendChild(k);
    }
    const v = document.createElement('span');
    v.className = 'ov-prim';
    if (isChanged) v.style.fontWeight = '700';
    if (val === null) { v.textContent = 'null'; v.style.color = isChanged ? (isOld ? 'var(--red)' : 'var(--green)') : 'var(--text-dim)'; }
    else if (typeof val === 'string') { v.textContent = `"${val}"`; v.style.color = isChanged ? (isOld ? 'var(--red)' : 'var(--green)') : 'var(--green)'; }
    else if (typeof val === 'number') { v.textContent = String(val); v.style.color = isChanged ? (isOld ? 'var(--red)' : 'var(--green)') : 'var(--accent2)'; }
    else if (typeof val === 'boolean') { v.textContent = String(val); v.style.color = isChanged ? (isOld ? 'var(--red)' : 'var(--green)') : 'var(--accent2)'; }
    else { v.textContent = _safeStr(val); }
    row.appendChild(v);
    return row;
  }

  // Object/Array — check if any descendants changed
  const hasChangedDescendant = [...changedPaths].some(p => p === myPath || p.startsWith(myPath ? myPath + '.' : ''));
  const container = document.createElement('div');
  container.className = 'ov-node';

  const header = document.createElement('div');
  header.className = 'ov-header';

  const arrow = document.createElement('span');
  arrow.className = 'ov-arrow';
  arrow.textContent = '\u25B6';
  header.appendChild(arrow);

  if (key !== null) {
    const k = document.createElement('span');
    k.className = 'ov-key';
    if (hasChangedDescendant) k.style.color = isOld ? 'var(--red)' : 'var(--green)';
    k.textContent = `${key}: `;
    header.appendChild(k);
  }

  const preview = document.createElement('span');
  preview.className = 'ov-preview';
  preview.textContent = isArray ? `Array(${val.length})` : `{${Object.keys(val).length} keys}`;
  header.appendChild(preview);

  container.appendChild(header);

  const children = document.createElement('div');
  children.className = 'ov-children';
  // Always start collapsed — user expands what they need
  children.style.display = 'none';

  let populated = false;
  function populate() {
    if (populated) return;
    populated = true;
    const entries = isArray ? val.map((v, i) => [i, v]) : Object.entries(val).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    entries.forEach(([k, v]) => {
      children.appendChild(_createHighlightedTree(k, v, changedPaths, myPath, isOld));
    });
  }

  header.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = children.style.display !== 'none';
    children.style.display = open ? 'none' : 'block';
    arrow.textContent = open ? '\u25B6' : '\u25BC';
    if (!open) populate();
  });

  container.appendChild(children);
  return container;
}

function handleReduxEvent(event) {
  if (event.type !== 'redux') return;
  // Skip processing if Redux tab is disabled (saves memory)
  if (!isTabEnabled('redux')) return;
  const { action, nextState } = event;
  const idx = state.redux.actions.length;

  const prevState = state.redux.states.length > 0 ? state.redux.states[state.redux.states.length - 1] : null;
  const changedKeys = [];
  if (prevState && nextState && typeof prevState === 'object' && typeof nextState === 'object') {
    const allKeys = [...new Set([...Object.keys(prevState), ...Object.keys(nextState)])].sort();
    allKeys.forEach(k => { if (!_deepEqual(prevState[k], nextState[k])) changedKeys.push(k); });
  }

  const actionEntry = { type: action?.type || '?', payload: action, ts: event.ts, index: idx, changedKeys };
  state.redux.actions.push(actionEntry);
  state.redux.states.push(nextState);
  // Cap Redux history to prevent memory leak (full state stored per action)
  const MAX_REDUX_HISTORY = 500;
  if (state.redux.actions.length > MAX_REDUX_HISTORY) {
    const trim = state.redux.actions.length - MAX_REDUX_HISTORY;
    state.redux.actions.splice(0, trim);
    state.redux.states.splice(0, trim);
    // Re-index remaining actions
    state.redux.actions.forEach((a, i) => a.index = i);
    if (state.redux.selected >= 0) state.redux.selected = Math.max(0, state.redux.selected - trim);
  }
  // Don't auto-select — keep all collapsed until user clicks
  $('rBadge').textContent = state.redux.actions.length;
  renderRedux();

  // Always add Redux actions to console logs — visibility controlled by showRedux filter
  {
    const msg = `[Redux] ${actionEntry.type}` + (changedKeys.length ? ` (changed: ${changedKeys.join(', ')})` : '');
    addConsoleLog({
      level: 'redux',
      message: msg,
      args: [{ t: 'string', v: `[Redux] ${actionEntry.type}` }, { t: 'object', v: action }],
      ts: event.ts,
      _isRedux: true,
    });
  }
}

// Assign a consistent color to each Redux action category (e.g. ANALYTICS, CART, USER)
const _reduxCatColors = {};
const _reduxColorPalette = [
  'var(--accent)',   // blue
  'var(--green)',    // green
  'var(--orange)',   // orange
  'var(--accent2)',  // purple
  '#e06c75',        // coral
  '#56b6c2',        // teal
  '#c678dd',        // magenta
  '#d19a66',        // gold
  '#98c379',        // lime
  '#e5c07b',        // yellow
];
let _reduxColorIdx = 0;
function _reduxCategoryColor(category) {
  if (!_reduxCatColors[category]) {
    _reduxCatColors[category] = _reduxColorPalette[_reduxColorIdx % _reduxColorPalette.length];
    _reduxColorIdx++;
  }
  return _reduxCatColors[category];
}

function renderRedux() {
  const content = $('reduxContent');
  const empty = $('reduxEmpty');
  if (!content) return;

  const { actions, states, selected, searchFilter, sortDir } = state.redux;
  let visible = searchFilter ? actions.filter(a => a.type.toLowerCase().includes(searchFilter)) : [...actions];
  if (sortDir === 'desc') visible = [...visible].reverse();

  empty.style.display = visible.length ? 'none' : 'flex';
  content.querySelectorAll('.rdx-entry').forEach(e => e.remove());
  if (!visible.length) return;

  const ttLabel = $('ttLabel');
  if (ttLabel) ttLabel.textContent = selected >= 0 ? `${selected + 1}/${actions.length}` : `—/${actions.length}`;

  const frag = document.createDocumentFragment();
  visible.forEach(a => {
    const isSelected = a.index === selected;

    const entry = document.createElement('div');
    entry.className = 'rdx-entry' + (isSelected ? ' selected' : '');

    // Row header — always visible
    const header = document.createElement('div');
    header.className = 'rdx-entry-header';
    const changesBadge = a.changedKeys?.length ? `<span class="rdx-changes">${a.changedKeys.length} changed</span>` : '';
    // Color-code action type by category prefix (e.g. ANALYTICS/, CART/, USER/)
    const typeParts = a.type.split('/');
    let typeHtml;
    if (typeParts.length >= 2) {
      const catColor = _reduxCategoryColor(typeParts[0]);
      typeHtml = `<span class="rdx-type-cat" style="color:${catColor}">${esc(typeParts[0])}/</span><span class="rdx-type-name">${esc(typeParts.slice(1).join('/'))}</span>`;
    } else {
      typeHtml = `<span class="rdx-type">${esc(a.type)}</span>`;
    }
    header.innerHTML = `<span class="rdx-index">#${a.index}</span>${typeHtml}<span class="rdx-header-right">${changesBadge}<span class="rdx-time">${ts(a.ts)}</span></span>`;
    // Toggle: click to expand, click again to collapse
    header.addEventListener('click', () => {
      state.redux.selected = isSelected ? -1 : a.index;
      renderRedux();
    });
    // Right-click to copy action type
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e, [
        { label: 'Copy Action Type', action: () => navigator.clipboard.writeText(a.type) },
        { label: 'Copy Action Payload', action: () => navigator.clipboard.writeText(JSON.stringify(a.payload, null, 2)) },
      ]);
    });
    // Allow text selection on the action type
    header.style.userSelect = 'text';
    entry.appendChild(header);

    // Expanded detail — only for explicitly selected action
    if (isSelected) {
      const detail = document.createElement('div');
      detail.className = 'rdx-entry-detail';

      // Close button
      const closeBtn = document.createElement('button');
      closeBtn.className = 'rdx-close-btn';
      closeBtn.textContent = '✕';
      closeBtn.title = 'Close';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.redux.selected = -1;
        renderRedux();
      });
      detail.appendChild(closeBtn);

      // Changed keys badges
      if (a.changedKeys?.length > 0) {
        const keysEl = document.createElement('div');
        keysEl.className = 'redux-changed-keys';
        keysEl.innerHTML = `<span class="redux-changed-label">Changed:</span> ${a.changedKeys.map(k =>
          `<span class="redux-changed-key">${esc(k)}</span>`).join(' ')}`;
        detail.appendChild(keysEl);
      }

      // Payload
      if (a.payload) {
        const pLabel = document.createElement('div');
        pLabel.className = 'redux-section-title';
        pLabel.textContent = 'Action Payload';
        detail.appendChild(pLabel);
        detail.appendChild(createTreeNode(null, a.payload, false));
      }

      // Store changes — two-column layout: Previous | Current
      const prevS = a.index > 0 ? states[a.index - 1] : null;
      const currS = states[a.index];
      if (currS && typeof currS === 'object' && a.changedKeys?.length > 0) {
        a.changedKeys.forEach(key => {
          const keyWrap = document.createElement('div');
          keyWrap.className = 'rdx-store-diff';

          const kLabel = document.createElement('div');
          kLabel.className = 'rdx-store-key-label';
          kLabel.textContent = key;
          keyWrap.appendChild(kLabel);

          const oldVal = prevS ? prevS[key] : undefined;
          const newVal = currS[key];

          // Find which sub-keys changed (for highlighting)
          const changedPaths = new Set();
          _findLeafChanges(oldVal, newVal, '').forEach(c => changedPaths.add(c.path));

          // Two-column grid: Previous | Current
          const grid = document.createElement('div');
          grid.className = 'rdx-diff-grid';

          // Previous column
          const prevCol = document.createElement('div');
          prevCol.className = 'rdx-diff-col prev';
          const prevLabel = document.createElement('div');
          prevLabel.className = 'rdx-state-label prev';
          prevLabel.textContent = '- Previous';
          prevCol.appendChild(prevLabel);
          if (oldVal !== undefined) {
            prevCol.appendChild(_createHighlightedTree(null, oldVal, changedPaths, '', true));
          } else {
            const na = document.createElement('span');
            na.style.cssText = 'color:var(--text-dim);font-size:10px;font-style:italic';
            na.textContent = 'undefined';
            prevCol.appendChild(na);
          }
          grid.appendChild(prevCol);

          // Current column
          const currCol = document.createElement('div');
          currCol.className = 'rdx-diff-col curr';
          const currLabel = document.createElement('div');
          currLabel.className = 'rdx-state-label curr';
          currLabel.textContent = '+ Current';
          currCol.appendChild(currLabel);
          if (newVal !== undefined) {
            currCol.appendChild(_createHighlightedTree(null, newVal, changedPaths, '', false));
          } else {
            const na = document.createElement('span');
            na.style.cssText = 'color:var(--text-dim);font-size:10px;font-style:italic';
            na.textContent = 'undefined';
            currCol.appendChild(na);
          }
          grid.appendChild(currCol);

          // Right-click to copy on each column
          prevCol.addEventListener('contextmenu', (e) => {
            e.preventDefault(); e.stopPropagation();
            showContextMenu(e, [
              { label: 'Copy Previous Value', action: () => navigator.clipboard.writeText(JSON.stringify(oldVal, null, 2)) },
              { label: 'Copy Current Value', action: () => navigator.clipboard.writeText(JSON.stringify(newVal, null, 2)) },
              { label: `Copy "${key}" key`, action: () => navigator.clipboard.writeText(key) },
            ]);
          });
          currCol.addEventListener('contextmenu', (e) => {
            e.preventDefault(); e.stopPropagation();
            showContextMenu(e, [
              { label: 'Copy Current Value', action: () => navigator.clipboard.writeText(JSON.stringify(newVal, null, 2)) },
              { label: 'Copy Previous Value', action: () => navigator.clipboard.writeText(JSON.stringify(oldVal, null, 2)) },
              { label: `Copy "${key}" key`, action: () => navigator.clipboard.writeText(key) },
            ]);
          });

          keyWrap.appendChild(grid);
          detail.appendChild(keyWrap);
        });
      }

      entry.appendChild(detail);
    }

    frag.appendChild(entry);
  });

  content.appendChild(frag);
  // Scroll selected entry into view
  const selEl = content.querySelector('.rdx-entry.selected');
  if (selEl) {
    selEl.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }
}

