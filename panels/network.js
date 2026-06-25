// ─── Network Panel ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// NETWORK PANEL (Chrome DevTools-style)
// ─────────────────────────────────────────────────────────────────────────────
const NET_COLS = [
  { key: 'name',      label: 'Name',      width: 380, min: 150 },
  { key: 'status',    label: 'Status',    width: 60,  min: 40 },
  { key: 'type',      label: 'Type',      width: 70,  min: 40 },
  { key: 'initiator', label: 'Initiator', width: 80,  min: 50 },
  { key: 'size',      label: 'Size',      width: 65,  min: 40 },
  { key: 'time',      label: 'Time',      width: 65,  min: 40 },
  { key: 'waterfall', label: 'Waterfall', width: 100, min: 60 },
];

function initNetworkPanel() {
  const panel = $('panel-network');
  if (!panel) return;
  panel.innerHTML = `
    <div class="panel-toolbar">
      <span class="panel-label">Network</span>
      <span class="badge" id="nBadge">0</span>
      <div class="ml-auto" style="display:flex;align-items:center;gap:6px">
        <button class="panel-clear-btn" id="networkExport" title="Export as HAR">Export HAR</button>
        <button class="panel-clear-btn" id="networkClear" title="Clear network">Clear</button>
        <label class="toggle-label" for="netToggle">
          <span class="toggle-text" id="netToggleText">Capture ON</span>
          <input type="checkbox" id="netToggle" class="toggle-input" checked />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="net-filter-bar" id="netFilterBar">
      <input id="netSearchInput" class="net-search-input" placeholder="Filter URLs..." />
      <div class="net-type-filters" id="netTypeFilters">
        <button class="net-type-btn" data-type="all">All</button>
        <button class="net-type-btn active" data-type="fetch">Fetch/XHR</button>
        <button class="net-type-btn" data-type="js">JS</button>
        <button class="net-type-btn" data-type="css">CSS</button>
        <button class="net-type-btn" data-type="img">Img</button>
        <button class="net-type-btn" data-type="media">Media</button>
        <button class="net-type-btn" data-type="font">Font</button>
        <button class="net-type-btn" data-type="doc">Doc</button>
        <button class="net-type-btn" data-type="ws">WS</button>
      </div>
      <div class="net-status-filters" id="netStatusFilters">
        <button class="net-status-btn active" data-status="all">All</button>
        <button class="net-status-btn" data-status="2xx">2xx</button>
        <button class="net-status-btn" data-status="errors">Errors</button>
        <button class="net-status-btn net-slow-btn" data-status="slow">Slow (>1s)</button>
      </div>
      <div class="net-hidden-wrap" style="position:relative;margin-left:4px">
        <button class="net-status-btn net-hidden-btn" id="netHiddenBtn" style="display:none" title="Manage hidden URLs">Hidden</button>
        <div class="net-hidden-dropdown" id="netHiddenDropdown" style="display:none"></div>
      </div>
      <div class="net-throttle" id="netThrottle">
        <select id="netThrottleSelect" class="net-throttle-select">
          <option value="none">No throttling</option>
          <option value="fast3g">Fast 3G</option>
          <option value="slow3g">Slow 3G</option>
          <option value="offline">Offline</option>
        </select>
      </div>
    </div>
    <div class="net-layout">
      <div class="net-table-wrap" id="netTableWrap">
        <div class="net-header" id="netHeader"></div>
        <div class="net-rows" id="netRows">
          <div class="empty-state" id="networkEmpty">
            <div class="icon">📡</div>
            <div class="label">No requests yet</div>
            <div class="hint">API calls will appear here automatically</div>
          </div>
        </div>
      </div>
      <div class="net-detail-pane" id="netDetailPane">
        <div class="net-detail-bar">
          <div class="detail-tabs" id="netDetailTabs"></div>
          <div class="detail-search-wrap" id="detailSearchWrap" style="display:none">
            <input id="detailSearchInput" class="detail-search-input" placeholder="Search key or value..." />
            <span id="detailSearchCount" class="detail-search-count"></span>
            <button class="detail-search-nav" id="detailSearchPrev" title="Previous">&#9650;</button>
            <button class="detail-search-nav" id="detailSearchNext" title="Next">&#9660;</button>
            <button class="detail-search-close" id="detailSearchClose" title="Close search">&times;</button>
          </div>
          <button class="detail-close" id="netDetailClose" title="Close">&times;</button>
        </div>
        <div class="detail-content" id="netDetailContent"></div>
      </div>
    </div>
    <div class="net-stats-bar" id="netStatsBar">
      <span id="netStatsTotal">0 requests</span>
      <span class="net-stats-sep">|</span>
      <span id="netStatsAvg">Avg: —</span>
      <span class="net-stats-sep">|</span>
      <span id="netStatsSlowest">Slowest: —</span>
      <span class="net-stats-sep">|</span>
      <span id="netStatsErrors">Errors: 0</span>
      <span class="net-stats-sep">|</span>
      <span id="netStatsSlow">Slow (>1s): 0</span>
    </div>`;

  $('netToggle').addEventListener('change', (e) => {
    state.network.enabled = e.target.checked;
    $('netToggleText').textContent = e.target.checked ? 'Capture ON' : 'Capture OFF';
    window.electronAPI?.setNetworkCapture(e.target.checked);
  });

  // Network search input
  $('netSearchInput').addEventListener('input', (e) => {
    state.network.searchFilter = e.target.value.toLowerCase().trim();
    renderNetwork();
  });

  // Type filter buttons
  $('netTypeFilters').addEventListener('click', (e) => {
    const btn = e.target.closest('.net-type-btn');
    if (!btn) return;
    $('netTypeFilters').querySelectorAll('.net-type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.network.typeFilter = btn.dataset.type;
    renderNetwork();
  });

  // Status filter buttons (All / 2xx / Errors / Slow)
  $('netStatusFilters').addEventListener('click', (e) => {
    const btn = e.target.closest('.net-status-btn');
    if (!btn) return;
    $('netStatusFilters').querySelectorAll('.net-status-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.network.statusFilter = btn.dataset.status;
    renderNetwork();
  });

  // Hidden URLs button
  $('netHiddenBtn')?.addEventListener('click', () => {
    const dd = $('netHiddenDropdown');
    if (!dd) return;
    const isOpen = dd.style.display !== 'none';
    if (isOpen) { dd.style.display = 'none'; return; }
    // Build dropdown with hidden URL list
    const hidden = getHiddenURLs();
    dd.innerHTML = '';
    if (!hidden.length) { dd.style.display = 'none'; return; }
    const title = document.createElement('div');
    title.className = 'net-hidden-title';
    title.innerHTML = `<span>Hidden URLs (${hidden.length})</span><button class="net-hidden-clear" id="netHiddenClearAll">Clear All</button>`;
    dd.appendChild(title);
    hidden.forEach(pattern => {
      const row = document.createElement('div');
      row.className = 'net-hidden-row';
      const label = document.createElement('span');
      label.className = 'net-hidden-url';
      label.textContent = pattern;
      label.title = pattern;
      row.appendChild(label);
      const btn = document.createElement('button');
      btn.className = 'net-hidden-unhide';
      btn.textContent = 'Unhide';
      btn.addEventListener('click', () => {
        removeHiddenURL(pattern);
        row.remove();
        renderNetwork();
        if (!getHiddenURLs().length) dd.style.display = 'none';
      });
      row.appendChild(btn);
      dd.appendChild(row);
    });
    dd.style.display = 'block';
    // Clear all handler
    dd.querySelector('#netHiddenClearAll')?.addEventListener('click', () => {
      setHiddenURLs([]);
      _updateHiddenBadge();
      dd.style.display = 'none';
      renderNetwork();
    });
  });
  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const dd = $('netHiddenDropdown');
    if (dd && dd.style.display !== 'none' && !e.target.closest('.net-hidden-wrap')) {
      dd.style.display = 'none';
    }
  });
  // Initialize hidden badge
  _updateHiddenBadge();

  // Throttle select
  $('netThrottleSelect').addEventListener('change', (e) => {
    state.network.throttle = e.target.value;
    // Send throttle config to the RN app
    window.electronAPI?.setNetworkThrottle(state.network.throttle);
  });

  // Export network as HAR
  $('networkExport')?.addEventListener('click', () => {
    const entries = state.network.order.map(id => {
      const r = state.network.requests[id];
      if (!r) return null;
      return {
        startedDateTime: new Date(r.ts || Date.now()).toISOString(),
        time: r.duration || 0,
        request: {
          method: r.method || 'GET',
          url: r.url || '',
          headers: Object.entries(r.requestHeaders || {}).map(([n, v]) => ({ name: n, value: v })),
          postData: r.requestBody ? { mimeType: 'application/json', text: typeof r.requestBody === 'object' ? JSON.stringify(r.requestBody) : safeStr(r.requestBody) } : undefined,
        },
        response: {
          status: r.status || 0,
          statusText: r.statusText || '',
          headers: Object.entries(r.responseHeaders || {}).map(([n, v]) => ({ name: n, value: v })),
          content: { size: -1, mimeType: 'application/json', text: r.responseBody ? (typeof r.responseBody === 'object' ? JSON.stringify(r.responseBody) : safeStr(r.responseBody)) : '' },
        },
        timings: { send: 0, wait: r.duration || 0, receive: 0 },
      };
    }).filter(Boolean);
    const har = { log: { version: '1.2', creator: { name: 'ReactoRadar', version: '1.6.0' }, entries } };
    const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `reactoradar-network-${Date.now()}.har`; a.click();
    URL.revokeObjectURL(url);
  });

  // Clear network
  $('networkClear').addEventListener('click', () => {
    state.network.requests = {};
    state.network.order = [];
    state.network.selectedId = null;
    closeNetDetail();
    $('nBadge').textContent = '0';
    renderNetwork();
  });

  // Close detail button
  $('netDetailClose').addEventListener('click', closeNetDetail);

  // Detail panel search
  let _detailSearchMatches = [];
  let _detailSearchIdx = -1;

  function _detailSearch() {
    const term = $('detailSearchInput')?.value?.trim().toLowerCase();
    const body = $('netDetailContent');
    if (!body || !term) { _detailClearSearch(); return; }

    // Remove old highlights
    body.querySelectorAll('.detail-search-hl').forEach(el => {
      const parent = el.parentNode;
      parent.replaceChild(document.createTextNode(el.textContent), el);
      parent.normalize();
    });

    _detailSearchMatches = [];
    _detailSearchIdx = -1;

    // Walk all text nodes and highlight matches
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    textNodes.forEach(node => {
      const text = node.textContent;
      const lower = text.toLowerCase();
      if (!lower.includes(term)) return;

      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      let idx;
      while ((idx = lower.indexOf(term, lastIdx)) !== -1) {
        if (idx > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, idx)));
        const hl = document.createElement('span');
        hl.className = 'detail-search-hl';
        hl.textContent = text.slice(idx, idx + term.length);
        _detailSearchMatches.push(hl);
        frag.appendChild(hl);
        lastIdx = idx + term.length;
      }
      if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      node.parentNode.replaceChild(frag, node);
    });

    // Update count
    const countEl = $('detailSearchCount');
    if (countEl) countEl.textContent = _detailSearchMatches.length ? `${_detailSearchMatches.length} found` : 'No match';

    // Navigate to first match
    if (_detailSearchMatches.length) _detailNavTo(0);
  }

  function _detailNavTo(idx) {
    // Remove active highlight from previous
    if (_detailSearchIdx >= 0 && _detailSearchMatches[_detailSearchIdx]) {
      _detailSearchMatches[_detailSearchIdx].classList.remove('active');
    }
    _detailSearchIdx = idx;
    const el = _detailSearchMatches[idx];
    if (!el) return;
    el.classList.add('active');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Update count
    const countEl = $('detailSearchCount');
    if (countEl) countEl.textContent = `${idx + 1}/${_detailSearchMatches.length}`;
  }

  function _detailClearSearch() {
    const body = $('netDetailContent');
    if (body) {
      body.querySelectorAll('.detail-search-hl').forEach(el => {
        const parent = el.parentNode;
        parent.replaceChild(document.createTextNode(el.textContent), el);
        parent.normalize();
      });
    }
    _detailSearchMatches = [];
    _detailSearchIdx = -1;
    const countEl = $('detailSearchCount');
    if (countEl) countEl.textContent = '';
  }

  $('detailSearchInput')?.addEventListener('input', () => {
    clearTimeout($('detailSearchInput')._debounce);
    $('detailSearchInput')._debounce = setTimeout(_detailSearch, 200);
  });
  $('detailSearchInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!_detailSearchMatches.length) return;
      const next = e.shiftKey
        ? (_detailSearchIdx - 1 + _detailSearchMatches.length) % _detailSearchMatches.length
        : (_detailSearchIdx + 1) % _detailSearchMatches.length;
      _detailNavTo(next);
    }
    if (e.key === 'Escape') {
      _detailClearSearch();
      $('detailSearchWrap').style.display = 'none';
    }
  });
  $('detailSearchNext')?.addEventListener('click', () => {
    if (!_detailSearchMatches.length) return;
    _detailNavTo((_detailSearchIdx + 1) % _detailSearchMatches.length);
  });
  $('detailSearchPrev')?.addEventListener('click', () => {
    if (!_detailSearchMatches.length) return;
    _detailNavTo((_detailSearchIdx - 1 + _detailSearchMatches.length) % _detailSearchMatches.length);
  });
  $('detailSearchClose')?.addEventListener('click', () => {
    _detailClearSearch();
    $('detailSearchInput').value = '';
    $('detailSearchWrap').style.display = 'none';
  });

  buildNetHeader();
}

// ─── Column header with sort icons + full-height resize handles ──────────────
function buildNetHeader() {
  const header = $('netHeader');
  header.innerHTML = '';
  NET_COLS.forEach((col, i) => {
    const cell = document.createElement('div');
    cell.className = 'net-hcell';
    cell.style.width = col.width + 'px';
    cell.dataset.col = col.key;

    const label = document.createElement('span');
    label.className = 'net-hcell-label';
    label.textContent = col.label;
    cell.appendChild(label);

    if (col.key !== 'waterfall') {
      const sortIcon = document.createElement('span');
      sortIcon.className = 'net-sort-icon';
      if (state.network.sortCol === col.key) {
        sortIcon.textContent = state.network.sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
        sortIcon.classList.add('active');
      }
      cell.appendChild(sortIcon);
      cell.addEventListener('click', (e) => {
        if (e.target.closest('.net-hcell-resize')) return;
        if (state.network.sortCol === col.key) {
          state.network.sortDir = state.network.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.network.sortCol = col.key;
          state.network.sortDir = col.key === 'name' ? 'asc' : 'desc';
        }
        buildNetHeader();
        renderNetwork();
      });
      cell.style.cursor = 'pointer';
    }

    // Resize handle in header
    if (i < NET_COLS.length - 1) {
      const handle = document.createElement('div');
      handle.className = 'net-hcell-resize';
      handle.addEventListener('mousedown', (e) => startColResize(e, col));
      cell.appendChild(handle);
    }
    header.appendChild(cell);
  });

  // Build full-height resize overlay lines
  buildResizeOverlays();
}

function buildResizeOverlays() {
  // Remove old overlays
  document.querySelectorAll('.net-resize-overlay').forEach(e => e.remove());
  const tableWrap = $('netTableWrap');
  if (!tableWrap) return;
  // Make the table wrap position:relative for overlay positioning
  tableWrap.style.position = 'relative';

  let leftOffset = 0;
  NET_COLS.forEach((col, i) => {
    leftOffset += col.width;
    if (i >= NET_COLS.length - 1) return; // no handle after last column

    const overlay = document.createElement('div');
    overlay.className = 'net-resize-overlay';
    overlay.style.left = (leftOffset - 3) + 'px';
    overlay.addEventListener('mousedown', (e) => startColResize(e, col));
    tableWrap.appendChild(overlay);
  });
}

function startColResize(e, col) {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const startW = col.width;

  // Add visual feedback
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  function onMove(ev) {
    const delta = ev.clientX - startX;
    col.width = Math.max(col.min, startW + delta);
    // Update header + all data cells for this column
    document.querySelectorAll(`.net-cell[data-col="${col.key}"], .net-hcell[data-col="${col.key}"]`)
      .forEach(el => el.style.width = col.width + 'px');
    // Keep detail pane aligned with Name column
    if (col.key === 'name' && state.network.selectedId) {
      const pane = $('netDetailPane');
      if (pane) pane.style.left = (col.width + 1) + 'px';
    }
    // Reposition overlays
    buildResizeOverlays();
  }
  function onUp() {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ─── Network type matching ──────────────────────────────────────────────────
function matchNetType(r, type) {
  const ct = (r.responseHeaders?.['content-type'] || r.responseHeaders?.['Content-Type'] || '').toLowerCase();
  const url = (r.url || '').toLowerCase();
  switch (type) {
    case 'fetch': // Fetch/XHR — show API calls (JSON, text, form data), exclude static assets
      return !ct.includes('image') && !ct.includes('font') && !ct.includes('video') && !ct.includes('audio')
        && !/\.(png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|otf|eot|mp4|mp3|css)(\?|$)/.test(url);
    case 'js':    return ct.includes('javascript') || /\.(js|jsx|bundle)(\?|$)/.test(url);
    case 'css':   return ct.includes('css') || /\.css(\?|$)/.test(url);
    case 'img':   return ct.includes('image') || /\.(png|jpg|jpeg|gif|svg|webp|ico|avif|bmp)(\?|$)/.test(url);
    case 'media': return ct.includes('video') || ct.includes('audio') || /\.(mp4|mp3|wav|webm|ogg|m3u8)(\?|$)/.test(url);
    case 'font':  return ct.includes('font') || /\.(woff2?|ttf|otf|eot)(\?|$)/.test(url);
    case 'doc':   return ct.includes('html') || ct.includes('xml') || /\.(html?|xml)(\?|$)/.test(url);
    case 'ws':    return url.startsWith('ws://') || url.startsWith('wss://');
    default:      return true;
  }
}

let _netRAF = null;

function handleNetworkEvent(event) {
  if (event.type === 'console') { addConsoleLog(event); return; }
  if (event.type !== 'network') return;
  if (!state.network.enabled) return;

  const { id, phase } = event;
  if (phase === 'request') {
    state.network.requests[id] = { ...event, _tab: 'headers' };
    if (!state.network.order.includes(id)) state.network.order.push(id);
    // Cap network history to prevent memory leak
    const MAX_NET_HISTORY = 1000;
    if (state.network.order.length > MAX_NET_HISTORY) {
      const trimIds = state.network.order.splice(0, state.network.order.length - MAX_NET_HISTORY);
      trimIds.forEach(tid => delete state.network.requests[tid]);
    }
    $('nBadge').textContent = state.network.order.length;
  } else {
    Object.assign(state.network.requests[id] || (state.network.requests[id] = {}), event);
    // Toast for errors and slow APIs
    const r = state.network.requests[id];
    if (r && (phase === 'response' || phase === 'error')) {
      const name = r.url?.split('/').pop()?.split('?')[0] || r.url || '?';
      if (r.phase === 'error' || (r.status && r.status >= 400)) {
        showToast(`API Error: ${r.status || 'ERR'} ${name}`, 'error', 'network');
      } else if ((r.duration || 0) >= 3000) {
        showToast(`Slow API: ${(r.duration/1000).toFixed(1)}s — ${name}`, 'warn', 'network');
      }
    }
  }
  if (!_netRAF) {
    _netRAF = requestAnimationFrame(() => {
      _netRAF = null;
      renderNetwork();
    });
  }
}

// ─── Sort network IDs ───────────────────────────────────────────────────────
function sortNetworkIds(ids) {
  const { sortCol, sortDir } = state.network;
  const reqs = state.network.requests;
  const sorted = [...ids].sort((a, b) => {
    const ra = reqs[a], rb = reqs[b];
    if (!ra || !rb) return 0;
    let va, vb;
    switch (sortCol) {
      case 'name':
        va = (ra.url || '').toLowerCase(); vb = (rb.url || '').toLowerCase();
        return va < vb ? -1 : va > vb ? 1 : 0;
      case 'status':
        va = ra.status || 0; vb = rb.status || 0;
        return va - vb;
      case 'type':
        va = (ra.responseHeaders?.['content-type'] || '').toLowerCase();
        vb = (rb.responseHeaders?.['content-type'] || '').toLowerCase();
        return va < vb ? -1 : va > vb ? 1 : 0;
      case 'size':
        // Use cached size or estimate — avoid JSON.stringify in sort comparator
        va = ra._cachedSize ?? (ra._cachedSize = typeof ra.responseBody === 'string' ? ra.responseBody.length : (ra.responseBody != null ? 100 : 0));
        vb = rb._cachedSize ?? (rb._cachedSize = typeof rb.responseBody === 'string' ? rb.responseBody.length : (rb.responseBody != null ? 100 : 0));
        return va - vb;
      case 'time':
      default:
        va = ra.ts || 0; vb = rb.ts || 0;
        return va - vb;
    }
  });
  if (sortDir === 'desc') sorted.reverse();
  return sorted;
}

// ─── Render network rows ────────────────────────────────────────────────────
function renderNetwork() {
  const rows = $('netRows');
  const empty = $('networkEmpty');
  if (!rows) return;

  const { statusFilter, typeFilter, searchFilter } = state.network;
  const visible = state.network.order.filter(id => {
    const r = state.network.requests[id];
    if (!r) return false;
    if (statusFilter === '2xx' && !(r.status >= 200 && r.status < 300)) return false;
    if (statusFilter === 'errors' && !(r.phase === 'error' || r.status >= 400)) return false;
    if (statusFilter === 'slow' && !((r.duration || 0) >= 1000)) return false;
    if (searchFilter && !r.url?.toLowerCase().includes(searchFilter)) return false;
    if (typeFilter !== 'all' && !matchNetType(r, typeFilter)) return false;
    if (isURLHidden(r.url || '')) return false;
    return true;
  });

  // Sort: apply current sort, default = newest first
  const sortedVisible = sortNetworkIds(visible);

  empty.style.display = sortedVisible.length ? 'none' : 'flex';
  rows.querySelectorAll('.net-row').forEach(e => e.remove());

  // Waterfall scale: find min/max timestamps
  let wfMin = Infinity, wfMax = 0;
  sortedVisible.forEach(id => {
    const r = state.network.requests[id];
    if (r.ts) { wfMin = Math.min(wfMin, r.ts); wfMax = Math.max(wfMax, r.ts + (r.duration || 0)); }
  });
  const wfRange = Math.max(wfMax - wfMin, 1);

  // Render max 300 rows for performance
  const MAX_NET_ROWS = 300;
  const toRender = sortedVisible.length > MAX_NET_ROWS ? sortedVisible.slice(0, MAX_NET_ROWS) : sortedVisible;

  const frag = document.createDocumentFragment();
  if (sortedVisible.length > MAX_NET_ROWS) {
    const info = document.createElement('div');
    info.className = 'net-row';
    info.style.cssText = 'color:var(--text-dim);font-size:10px;padding:6px 14px;justify-content:center;font-style:italic';
    info.textContent = `Showing ${MAX_NET_ROWS} of ${sortedVisible.length} requests`;
    frag.appendChild(info);
  }
  toRender.forEach(id => {
    const r = state.network.requests[id];
    frag.appendChild(buildNetRow(r, wfMin, wfRange));
  });
  rows.appendChild(frag);
  _updateNetStats();
}

function _updateNetStats() {
  const allReqs = state.network.order.map(id => state.network.requests[id]).filter(Boolean);
  const completed = allReqs.filter(r => r.duration != null);
  const total = allReqs.length;
  const errors = allReqs.filter(r => r.phase === 'error' || (r.status && r.status >= 400)).length;
  const slow = completed.filter(r => r.duration >= 1000).length;
  const durations = completed.map(r => r.duration);
  const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  const slowest = durations.length ? Math.max(...durations) : 0;
  const slowestReq = completed.find(r => r.duration === slowest);
  const slowestName = slowestReq ? (tryURL(slowestReq.url)?.pathname?.split('/').pop() || slowestReq.url?.split('/').pop() || '?') : '—';

  const el = (id, text) => { const e = $(id); if (e) e.textContent = text; };
  el('netStatsTotal', `${total} requests`);
  el('netStatsAvg', `Avg: ${avg ? (avg > 999 ? `${(avg/1000).toFixed(1)}s` : `${avg}ms`) : '—'}`);
  el('netStatsSlowest', `Slowest: ${slowest ? (slowest > 999 ? `${(slowest/1000).toFixed(1)}s` : `${slowest}ms`) + ` (${slowestName})` : '—'}`);
  el('netStatsErrors', `Errors: ${errors}`);
  el('netStatsSlow', `Slow (>1s): ${slow}`);
  // Highlight if there are slow or errored requests
  if (slow > 0) $('netStatsSlow')?.classList.add('warn');
  else $('netStatsSlow')?.classList.remove('warn');
  if (errors > 0) $('netStatsErrors')?.classList.add('err');
  else $('netStatsErrors')?.classList.remove('err');
}

function _isHttpError(r) {
  return r.phase === 'error' || (r.status && r.status >= 400);
}

function buildNetRow(r, wfMin, wfRange) {
  const row = document.createElement('div');
  const rowSlow = !_isHttpError(r) && (r.duration || 0) >= 1000;
  const rowVerySlow = !_isHttpError(r) && (r.duration || 0) >= 3000;
  row.className = 'net-row' + (r.id === state.network.selectedId ? ' selected' : '') + (_isHttpError(r) ? ' error' : '') + (rowVerySlow ? ' very-slow' : rowSlow ? ' slow' : '');
  row.dataset.id = r.id;

  const urlObj = tryURL(r.url);
  const pathname = urlObj ? urlObj.pathname : r.url || '';
  const filename = pathname.split('/').filter(Boolean).pop() || pathname;
  const host = urlObj ? urlObj.host : '';

  // Name — show method + full path (expands with column)
  const nameCell = document.createElement('div');
  nameCell.className = 'net-cell net-cell-name';
  nameCell.dataset.col = 'name';
  nameCell.style.width = NET_COLS[0].width + 'px';
  const method = r.method || '?';
  const mClass = ['GET','POST','PUT','PATCH','DELETE'].includes(method) ? `m-${method}` : 'm-other';
  const fullPath = urlObj ? urlObj.pathname + urlObj.search : r.url || '';
  const isErr = _isHttpError(r);
  const pathCls = isErr ? ' net-path-error' : '';
  nameCell.innerHTML = `<span class="method-badge ${mClass}">${method}</span> <span class="net-path${pathCls}" title="${esc(r.url)}">${esc(fullPath)}</span><span class="net-host">${esc(host)}</span>`;
  row.appendChild(nameCell);

  // Status
  const statusCell = document.createElement('div');
  statusCell.className = 'net-cell net-status';
  statusCell.dataset.col = 'status';
  statusCell.style.width = NET_COLS[1].width + 'px';
  let statusStr = '...', sCls = 's-pending';
  if (r.phase === 'error') { statusStr = 'ERR'; sCls = 's-err'; }
  else if (r.status) {
    statusStr = String(r.status);
    const group = Math.floor(r.status / 100);
    // 1xx info, 2xx success, 3xx redirect, 4xx client error, 5xx server error
    if (group >= 4) sCls = 's-err';
    else sCls = `s-${group}`;
  }
  statusCell.className += ` ${sCls}`;
  statusCell.textContent = statusStr;
  row.appendChild(statusCell);

  // Type (content-type from response headers)
  const typeCell = document.createElement('div');
  typeCell.className = 'net-cell net-type';
  typeCell.dataset.col = 'type';
  typeCell.style.width = NET_COLS[2].width + 'px';
  const ct = r.responseHeaders?.['content-type'] || r.responseHeaders?.['Content-Type'] || '';
  typeCell.textContent = ct.split(';')[0].replace('application/', '').replace('text/', '') || '—';
  row.appendChild(typeCell);

  // Initiator
  const initCell = document.createElement('div');
  initCell.className = 'net-cell net-initiator';
  initCell.dataset.col = 'initiator';
  initCell.style.width = NET_COLS[3].width + 'px';
  initCell.textContent = r.initiator || 'xhr';
  row.appendChild(initCell);

  // Size
  const sizeCell = document.createElement('div');
  sizeCell.className = 'net-cell net-size';
  sizeCell.dataset.col = 'size';
  sizeCell.style.width = NET_COLS[4].width + 'px';
  const bodyStr = typeof r.responseBody === 'string' ? r.responseBody : (r.responseBody != null ? JSON.stringify(r.responseBody) : '');
  sizeCell.textContent = bodyStr.length > 0 ? formatSize(bodyStr.length) : '—';
  row.appendChild(sizeCell);

  // Time
  const timeCell = document.createElement('div');
  const dur = r.duration || 0;
  const slowClass = dur >= 3000 ? ' very-slow' : dur >= 1000 ? ' slow' : '';
  timeCell.className = 'net-cell net-time' + slowClass;
  timeCell.dataset.col = 'time';
  timeCell.style.width = NET_COLS[5].width + 'px';
  timeCell.textContent = r.duration != null ? (r.duration > 999 ? `${(r.duration/1000).toFixed(1)}s` : `${r.duration}ms`) : '...';
  row.appendChild(timeCell);

  // Waterfall
  const wfCell = document.createElement('div');
  wfCell.className = 'net-cell net-waterfall';
  wfCell.dataset.col = 'waterfall';
  wfCell.style.width = NET_COLS[6].width + 'px';
  if (r.ts) {
    const left = ((r.ts - wfMin) / wfRange) * 100;
    const width = Math.max(2, ((r.duration || 50) / wfRange) * 100);
    let barCls = 'pending';
    if (r.phase === 'error') barCls = 'err';
    else if (r.status && r.status >= 400) barCls = 'err';
    else if (r.status) barCls = `s${Math.floor(r.status/100)}`;
    wfCell.innerHTML = `<div class="wf-bar ${barCls}" style="left:${left}%;width:${width}%"></div>`;
  }
  row.appendChild(wfCell);

  // Click to select and show detail
  row.addEventListener('click', () => selectNetRequest(r.id));

  // Right-click for context menu (copy as cURL)
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showNetContextMenu(e, r);
  });

  return row;
}

// ─── Select request → overlay detail pane over Status/Type/etc columns ───────
function selectNetRequest(id) {
  state.network.selectedId = id;
  const r = state.network.requests[id];
  if (!r) return;

  // Highlight selected row
  document.querySelectorAll('#netRows .net-row').forEach(el =>
    el.classList.toggle('selected', el.dataset.id === id)
  );

  // Position detail pane to overlay everything after the Name column
  const pane = $('netDetailPane');
  const nameColWidth = NET_COLS[0].width;
  pane.style.left = (nameColWidth + 1) + 'px'; // +1 for the border
  pane.classList.add('open');
  r._tab = r._tab || 'headers';
  renderNetDetailTabs(r);
  renderNetDetailContent(r);
}

function closeNetDetail() {
  state.network.selectedId = null;
  const pane = $('netDetailPane');
  if (pane) pane.classList.remove('open');
  document.querySelectorAll('#netRows .net-row').forEach(el =>
    el.classList.remove('selected')
  );
}

function _estimateSize(val) {
  if (val == null) return 0;
  if (typeof val === 'string') return val.length;
  try { return JSON.stringify(val).length; } catch { return 0; }
}

function _formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

function renderNetDetailTabs(r) {
  const tabs = $('netDetailTabs');
  tabs.innerHTML = '';

  const tabDefs = [
    { label: 'Headers', key: 'headers' },
    { label: 'Request', key: 'request', sizeFrom: 'requestBody' },
    { label: 'Preview', key: 'preview', sizeFrom: 'responseBody' },
    { label: 'Response', key: 'response', sizeFrom: 'responseBody' },
  ];

  tabDefs.forEach(({ label, key, sizeFrom }) => {
    const btn = document.createElement('button');
    btn.className = 'detail-tab' + (r._tab === key ? ' active' : '');
    let text = label;
    if (sizeFrom && r[sizeFrom]) {
      const size = _estimateSize(r[sizeFrom]);
      if (size > 0) text += ` (${_formatBytes(size)})`;
    }
    btn.textContent = text;
    btn.addEventListener('click', () => {
      r._tab = key;
      tabs.querySelectorAll('.detail-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderNetDetailContent(r);
    });
    tabs.appendChild(btn);
  });

  // Show search box for Preview/Response tabs
  const searchWrap = $('detailSearchWrap');
  if (searchWrap) {
    searchWrap.style.display = (r._tab === 'preview' || r._tab === 'response' || r._tab === 'headers') ? 'flex' : 'none';
  }
}

function renderNetDetailContent(r) {
  let body = $('netDetailContent');
  if (!body) return;
  // Clone-replace to remove all stale event listeners (prevents contextmenu leak)
  const fresh = body.cloneNode(false);
  body.parentNode.replaceChild(fresh, body);
  body = fresh;
  const tab = r._tab || 'headers';

  if (tab === 'headers') {
    const rqH = r.requestHeaders || {};
    const rsH = r.responseHeaders || {};
    const renderH = (title, h) => {
      const keys = Object.keys(h);
      if (!keys.length) return `<div class="section-label">${title}</div><span style="color:var(--text-dim)">none</span>`;
      return `<div class="section-label">${title}</div><div class="kv-grid">${keys.map(k => {
        let val = h[k];
        if (val && typeof val === 'object') { try { val = JSON.stringify(val); } catch { val = '[Complex object]'; } }
        return `<span class="kv-key">${esc(k)}</span><span class="kv-val">${esc(val)}</span>`;
      }).join('')}</div>`;
    };
    body.innerHTML = `<div class="section-label" style="margin-top:0">General</div>
      <div class="kv-grid">
        <span class="kv-key">Request URL</span><span class="kv-val">${esc(r.url)}</span>
        <span class="kv-key">Method</span><span class="kv-val">${esc(r.method)}</span>
        <span class="kv-key">Status</span><span class="kv-val ${r.phase === 'error' ? 's-err' : r.status ? (r.status >= 400 ? 's-err' : 's-' + Math.floor(r.status/100)) : 's-pending'}">${r.phase === 'error' ? (r.status || 'ERR') : (r.status || 'Pending')} ${r.statusText || (r.phase === 'error' ? r.error || 'Network Error' : '')}</span>
      </div>
      ${renderH('Response Headers', rsH)}
      ${renderH('Request Headers', rqH)}`;
  } else if (tab === 'request') {
    if (!r.requestBody) {
      body.innerHTML = '<span style="color:var(--text-dim)">No request body</span>';
    } else {
      body.innerHTML = '';
      let reqData = r.requestBody;
      if (typeof reqData === 'string') {
        try { reqData = JSON.parse(reqData); } catch {}
      }
      if (reqData && typeof reqData === 'object') {
        body.appendChild(createTreeNode(null, reqData, false));
        body.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showPreviewCopyMenu(e, reqData);
        });
      } else {
        body.innerHTML = renderJSON(r.requestBody);
      }
    }
  } else if (tab === 'preview') {
    const isErrStatus = _isHttpError(r);
    if (r.phase === 'error' && !r.responseBody) { body.innerHTML = `<span style="color:var(--red)">${esc(r.error || 'Request failed')}</span>`; return; }
    if (!r.responseBody && r.phase !== 'response') { body.innerHTML = '<span style="color:var(--text-dim)">Pending...</span>'; return; }
    if (r.responseBody == null || r.responseBody === '') { body.innerHTML = '<span style="color:var(--text-dim)">Empty response body</span>'; return; }
    // Render as collapsible JSON tree with right-click copy
    const val = r.responseBody;
    let treeData = val;
    if (typeof val === 'string') {
      try { treeData = JSON.parse(val); } catch {
        body.innerHTML = `<span style="color:${isErrStatus ? 'var(--red)' : 'inherit'}">${esc(val)}</span>`;
        return;
      }
    }
    if (treeData && typeof treeData === 'object') {
      body.innerHTML = '';
      // Show error status banner above the response body
      if (isErrStatus) {
        const errBanner = document.createElement('div');
        errBanner.style.cssText = 'color:var(--red);font-weight:600;padding:4px 0 8px;font-size:11px;border-bottom:1px solid rgba(255,94,114,.15);margin-bottom:8px';
        errBanner.textContent = `${r.status || 'ERR'} ${r.statusText || r.error || 'Error'}`;
        body.appendChild(errBanner);
      }
      body.appendChild(createTreeNode(null, treeData, false));
      // Right-click on preview to copy the whole object or clicked node value
      body.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showPreviewCopyMenu(e, treeData);
      });
    } else {
      body.innerHTML = isErrStatus
        ? `<span style="color:var(--red)">${esc(safeStr(r.responseBody))}</span>`
        : '<span style="color:var(--text-dim)">No preview available</span>';
    }
  } else if (tab === 'response') {
    const isErrStatus = _isHttpError(r);
    if (r.phase === 'error' && !r.responseBody) { body.innerHTML = `<span style="color:var(--red)">${esc(r.error || 'Request failed')}</span>`; return; }
    if (!r.responseBody && r.phase !== 'response') { body.innerHTML = '<span style="color:var(--text-dim)">Pending...</span>'; return; }
    if (r.responseBody == null || r.responseBody === '') { body.innerHTML = '<span style="color:var(--text-dim)">Empty response body</span>'; return; }
    if (isErrStatus) {
      const errBanner = document.createElement('div');
      errBanner.style.cssText = 'color:var(--red);font-weight:600;padding:4px 0 8px;font-size:11px;border-bottom:1px solid rgba(255,94,114,.15);margin-bottom:8px';
      errBanner.textContent = `${r.status || 'ERR'} ${r.statusText || r.error || 'Error'}`;
      body.innerHTML = '';
      body.appendChild(errBanner);
      const raw = document.createElement('div');
      raw.style.color = 'var(--red)';
      raw.innerHTML = renderJSON(r.responseBody);
      body.appendChild(raw);
    } else {
      body.innerHTML = renderJSON(r.responseBody);
    }
    // Right-click to copy response object
    body.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const sel = window.getSelection();
      const items = [];
      if (sel && sel.toString().length > 0) {
        items.push({ label: 'Copy Selection', action: () => navigator.clipboard.writeText(sel.toString()) });
      }
      items.push({ label: 'Copy Response Object', action: () => {
        try {
          const data = typeof r.responseBody === 'string' ? JSON.parse(r.responseBody) : r.responseBody;
          navigator.clipboard.writeText(JSON.stringify(_sortKeys(data), null, 2));
        } catch { navigator.clipboard.writeText(safeStr(r.responseBody)); }
      }});
      items.push({ label: 'Copy Response (minified)', action: () => {
        try {
          const data = typeof r.responseBody === 'string' ? JSON.parse(r.responseBody) : r.responseBody;
          navigator.clipboard.writeText(JSON.stringify(_sortKeys(data)));
        } catch { navigator.clipboard.writeText(safeStr(r.responseBody)); }
      }});
      showContextMenu(e, items);
    });
  }
}

// ─── Network context menus ──────────────────────────────────────────────────
function showNetContextMenu(e, r) {
  const items = [
    { label: 'Copy as cURL', action: () => navigator.clipboard.writeText(buildCurlCommand(r)) },
    { label: 'Copy URL', action: () => navigator.clipboard.writeText(r.url || '') },
  ];
  if (r.responseBody) {
    items.push({ label: 'Copy Response', action: () => {
      const text = typeof r.responseBody === 'string' ? r.responseBody : JSON.stringify(r.responseBody, null, 2);
      navigator.clipboard.writeText(text);
    }});
  }
  // Hide URL option
  items.push({ label: '—', action: null }); // separator
  items.push({ label: 'Hide this URL', action: () => {
    addHiddenURL(r.url || '');
    renderNetwork();
  }});
  showContextMenu(e, items);
}

function showPreviewCopyMenu(e, fullData) {
  const items = [
    { label: 'Copy Object', action: () => navigator.clipboard.writeText(JSON.stringify(_sortKeys(fullData), null, 2)) },
  ];
  const sel = window.getSelection();
  if (sel && sel.toString().length > 0) {
    items.push({ label: 'Copy Selection', action: () => navigator.clipboard.writeText(sel.toString()) });
  }
  const keyEl = e.target.closest('.ov-key');
  const leafEl = e.target.closest('.ov-leaf');
  if (keyEl || leafEl) {
    items.push({ label: 'Copy Value', action: () => navigator.clipboard.writeText((leafEl || keyEl.parentElement).textContent) });
  }
  showContextMenu(e, items);
}

function buildCurlCommand(r) {
  let cmd = `curl '${r.url}'`;
  if (r.method && r.method !== 'GET') cmd += ` -X ${r.method}`;
  const headers = r.requestHeaders || {};
  Object.entries(headers).forEach(([k, v]) => {
    cmd += ` \\\n  -H '${k}: ${v}'`;
  });
  if (r.requestBody) {
    const body = typeof r.requestBody === 'string' ? r.requestBody : JSON.stringify(r.requestBody);
    cmd += ` \\\n  --data-raw '${body.replace(/'/g, "'\\''")}'`;
  }
  return cmd;
}

