// ─── GA4 Events Panel ──────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// GA4 EVENT INSPECTOR
// ─────────────────────────────────────────────────────────────────────────────
const ga4State = { events: [], selected: -1, searchFilter: '', sortDir: 'desc', sourceFilter: 'GA4' };
const _ga4SourceColors = { GA4: '#ffa500', PostHog: '#1d4aff', Branch: '#09b83e', MoEngage: '#00c853', Bloomreach: '#e8236b', GTM: '#4285f4' };

function initGA4Panel() {
  const panel = $('panel-ga4');
  if (!panel) return;
  panel.innerHTML = `
    <div class="panel-toolbar">
      <span class="panel-label">GA4 Events</span>
      <span class="badge" id="ga4Badge">0</span>
      <input id="ga4Search" class="net-search-input" style="margin-left:12px" placeholder="Filter events..." />
      <div class="ml-auto" style="display:flex;align-items:center;gap:6px">
        <label class="toggle-label" for="ga4ColorToggle" style="font-size:10px;gap:4px">
          <span style="color:var(--text-dim)">Colors</span>
          <input type="checkbox" id="ga4ColorToggle" class="toggle-input" ${getGA4ColorsEnabled() ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
        <button class="panel-clear-btn" id="ga4Clear" title="Clear GA4 events">Clear</button>
      </div>
    </div>
    <div class="ga4-source-filters" id="ga4SourceFilters">
      <button class="ga4-source-btn" data-source="all">All</button>
      <button class="ga4-source-btn active" data-source="GA4" style="--src-color:#ffa500">Firebase</button>
      <button class="ga4-source-btn" data-source="PostHog" style="--src-color:#1d4aff">PostHog</button>
      <button class="ga4-source-btn" data-source="Branch" style="--src-color:#09b83e">Branch</button>
      <button class="ga4-source-btn" data-source="MoEngage" style="--src-color:#00c853">MoEngage</button>
    </div>
    <div class="ga4-layout">
      <div class="ga4-list-pane">
        <div class="ga4-list-header">
          <span class="ga4-hcell ga4-sort-btn" id="ga4SortBtn" style="width:90px;cursor:pointer" title="Click to toggle sort order">Time <span id="ga4SortIcon">\u25BC</span></span>
          <span class="ga4-hcell" style="width:70px">Source</span>
          <span class="ga4-hcell" style="flex:1">Event</span>
        </div>
        <div class="scroll-area" id="ga4List">
          <div class="empty-state" id="ga4Empty">
            <div class="icon" style="font-size:28px;opacity:.2">📊</div>
            <div class="label">No GA4 events yet</div>
            <div class="hint">Events from @react-native-firebase/analytics will appear here</div>
          </div>
        </div>
      </div>
      <div class="ga4-resize-handle" id="ga4ResizeHandle"></div>
      <div class="ga4-detail-pane" id="ga4DetailPane">
        <div class="ga4-detail-header">EVENT DETAIL</div>
        <div class="scroll-area ga4-detail-content" id="ga4Detail">
          <span style="color:var(--text-dim);padding:16px;display:block">Click an event to inspect</span>
        </div>
      </div>
    </div>
    <div class="ga4-summary" id="ga4Summary">
      <span class="ga4-summary-label">Total: 0</span>
    </div>`;

  $('ga4Search').addEventListener('input', (e) => {
    ga4State.searchFilter = e.target.value.toLowerCase().trim();
    renderGA4List();
    renderGA4Summary(); // update active chip highlight
  });

  $('ga4ColorToggle')?.addEventListener('change', (e) => {
    setGA4ColorsEnabled(e.target.checked);
    renderGA4List();
    renderGA4Summary();
  });

  // Source filter buttons
  $('ga4SourceFilters')?.querySelectorAll('.ga4-source-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      ga4State.sourceFilter = btn.dataset.source;
      $('ga4SourceFilters').querySelectorAll('.ga4-source-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderGA4List();
      renderGA4Summary();
    });
  });

  $('ga4Clear').addEventListener('click', () => {
    ga4State.events = [];
    ga4State.selected = -1;
    ga4State.searchFilter = '';
    const search = $('ga4Search');
    if (search) search.value = '';
    $('ga4Badge').textContent = '0';
    renderGA4List();
    renderGA4Summary();
    // Clear detail pane
    const detail = $('ga4Detail');
    if (detail) detail.innerHTML = '<div class="ga4-detail-empty" style="color:var(--text-dim);padding:20px;text-align:center;font-size:11px">Select an event to view details</div>';
  });

  $('ga4SortBtn').addEventListener('click', () => {
    ga4State.sortDir = ga4State.sortDir === 'desc' ? 'asc' : 'desc';
    $('ga4SortIcon').textContent = ga4State.sortDir === 'desc' ? '\u25BC' : '\u25B2';
    renderGA4List();
  });

  // Resizable divider between list and detail
  const resizeHandle = $('ga4ResizeHandle');
  const detailPane = $('ga4DetailPane');
  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = detailPane.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    function onMove(ev) {
      const delta = startX - ev.clientX;
      detailPane.style.width = Math.max(200, Math.min(window.innerWidth * 0.8, startWidth + delta)) + 'px';
    }
    function onUp() {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function handleGA4Event(event) {
  if (!isTabEnabled('ga4')) return;
  ga4State.events.push({
    name: event.name || '?',
    params: event.params || {},
    tag: event.tag || 'GA4',
    source: event.source || '',
    ts: event.ts || Date.now(),
    index: ga4State.events.length,
  });
  $('ga4Badge').textContent = ga4State.events.length;

  // Append to list (batched via rAF)
  if (!ga4State._raf) {
    ga4State._raf = requestAnimationFrame(() => {
      ga4State._raf = null;
      renderGA4List();
      renderGA4Summary();
    });
  }
}

// Assign consistent color to each GA4 event name
const _ga4EventColors = {};
const _ga4ColorPalette = [
  '#4facff',  // blue
  '#3dd68c',  // green
  '#ff813f',  // orange
  '#c678dd',  // purple
  '#e06c75',  // coral
  '#56b6c2',  // teal
  '#d19a66',  // gold
  '#98c379',  // lime
  '#e5c07b',  // yellow
  '#ff5e72',  // red
  '#61afef',  // light blue
  '#be5046',  // rust
];
let _ga4ColorIdx = 0;
function _ga4EventColor(name) {
  if (!getGA4ColorsEnabled()) return ''; // empty = inherit default text color
  if (!_ga4EventColors[name]) {
    _ga4EventColors[name] = _ga4ColorPalette[_ga4ColorIdx % _ga4ColorPalette.length];
    _ga4ColorIdx++;
  }
  return _ga4EventColors[name];
}
function getGA4ColorsEnabled() {
  try { return localStorage.getItem('rn-debug-ga4-colors') === 'true'; } catch { return false; }
}
function setGA4ColorsEnabled(v) {
  try { localStorage.setItem('rn-debug-ga4-colors', v ? 'true' : 'false'); } catch {}
}

function renderGA4List() {
  const list = $('ga4List');
  const empty = $('ga4Empty');
  if (!list) return;

  const { searchFilter, sortDir, sourceFilter } = ga4State;
  let visible = ga4State.events.filter(e => {
    if (sourceFilter !== 'all' && (e.tag || 'GA4') !== sourceFilter) return false;
    if (searchFilter && !e.name.toLowerCase().includes(searchFilter)) return false;
    return true;
  });

  // Sort: newest first (desc) or oldest first (asc)
  if (sortDir === 'desc') {
    visible = [...visible].reverse();
  }

  empty.style.display = visible.length ? 'none' : 'flex';
  list.querySelectorAll('.ga4-row').forEach(e => e.remove());

  // Cap at 500 rows
  const MAX = 500;
  const toRender = visible.length > MAX ? visible.slice(0, MAX) : visible;

  const frag = document.createDocumentFragment();
  toRender.forEach(e => {
    const row = document.createElement('div');
    row.className = 'ga4-row' + (e.index === ga4State.selected ? ' selected' : '');

    const time = new Date(e.ts).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const evtColor = _ga4EventColor(e.name);
    const colorStyle = evtColor ? `color:${evtColor}` : '';
    const srcTag = e.tag || 'GA4';
    const srcColor = _ga4SourceColors[srcTag] || 'var(--text-dim)';
    row.innerHTML = `
      <span class="ga4-cell ga4-time">${time}</span>
      <span class="ga4-cell ga4-source-badge" style="width:70px"><span class="ga4-src-tag" style="background:${srcColor}22;color:${srcColor};border:1px solid ${srcColor}44">${esc(srcTag)}</span></span>
      <span class="ga4-cell ga4-name" style="${colorStyle}">${esc(e.name)}</span>`;

    row.addEventListener('click', () => {
      ga4State.selected = e.index;
      list.querySelectorAll('.ga4-row').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      renderGA4Detail(e);
    });

    // Right-click to copy
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showContextMenu(ev, [
        { label: 'Copy Event Name', action: () => navigator.clipboard.writeText(e.name) },
        { label: 'Copy as JSON', action: () => navigator.clipboard.writeText(JSON.stringify({ event: e.name, params: e.params }, null, 2)) },
      ]);
    });

    frag.appendChild(row);
  });
  list.appendChild(frag);
}

function renderGA4Detail(e) {
  let detail = $('ga4Detail');
  if (!detail) return;

  const time = new Date(e.ts).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Clone-replace to remove stale event listeners
  const fresh = detail.cloneNode(false);
  detail.parentNode.replaceChild(fresh, detail);
  detail = fresh;

  // Header info
  const header = document.createElement('div');
  header.className = 'ga4-detail-info';
  const srcTag = e.tag || 'GA4';
  const srcColor = _ga4SourceColors[srcTag] || 'var(--text-dim)';
  header.innerHTML = `
    <div class="ga4-detail-row"><span class="ga4-detail-key">Event Name</span><span class="ga4-detail-val" style="${_ga4EventColor(e.name) ? 'color:' + _ga4EventColor(e.name) + ';' : ''}font-weight:600;font-size:1.1em">${esc(e.name)}</span></div>
    <div class="ga4-detail-row"><span class="ga4-detail-key">Source</span><span class="ga4-detail-val"><span class="ga4-src-tag" style="background:${srcColor}22;color:${srcColor};border:1px solid ${srcColor}44">${esc(srcTag)}</span></span></div>
    <div class="ga4-detail-row"><span class="ga4-detail-key">Timestamp</span><span class="ga4-detail-val">${time}</span></div>
`;
  detail.appendChild(header);

  // Separator
  const sep = document.createElement('div');
  sep.className = 'ga4-detail-sep';
  detail.appendChild(sep);

  // Parameters as key-value list with collapsible objects
  if (e.params && typeof e.params === 'object') {
    const keys = Object.keys(e.params).sort();
    keys.forEach(key => {
      const val = e.params[key];
      const row = document.createElement('div');
      row.className = 'ga4-param-row';

      const keyEl = document.createElement('span');
      keyEl.className = 'ga4-param-key';
      keyEl.textContent = key;
      row.appendChild(keyEl);

      if (val && typeof val === 'object') {
        // Collapsible object tree
        const treeWrap = document.createElement('span');
        treeWrap.className = 'ga4-param-val';
        treeWrap.appendChild(createTreeNode(null, val, true));
        row.appendChild(treeWrap);
      } else {
        const valEl = document.createElement('span');
        valEl.className = 'ga4-param-val';
        valEl.textContent = val === null ? 'null' : val === undefined ? 'undefined' : JSON.stringify(val);
        if (typeof val === 'string') valEl.style.color = 'var(--green)';
        else if (typeof val === 'number') valEl.style.color = 'var(--orange)';
        else if (typeof val === 'boolean') valEl.style.color = 'var(--accent2)';
        row.appendChild(valEl);
      }

      detail.appendChild(row);
    });
  }

  // Right-click on detail
  detail.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    showContextMenu(ev, [
      { label: 'Copy All Parameters', action: () => navigator.clipboard.writeText(JSON.stringify(e.params, null, 2)) },
      { label: 'Copy Event JSON', action: () => navigator.clipboard.writeText(JSON.stringify({ event: e.name, params: e.params, timestamp: e.ts }, null, 2)) },
    ]);
  });
}

function renderGA4Summary() {
  const summary = $('ga4Summary');
  if (!summary) return;

  const counts = {};
  const eventsForSummary = ga4State.sourceFilter === 'all'
    ? ga4State.events
    : ga4State.events.filter(e => (e.tag || 'GA4') === ga4State.sourceFilter);
  eventsForSummary.forEach(e => {
    counts[e.name] = (counts[e.name] || 0) + 1;
  });

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  summary.innerHTML = '';

  // Filter events by active source
  const filteredEvents = ga4State.sourceFilter === 'all'
    ? ga4State.events
    : ga4State.events.filter(e => (e.tag || 'GA4') === ga4State.sourceFilter);

  const totalLabel = document.createElement('span');
  totalLabel.className = 'ga4-summary-label';
  totalLabel.textContent = `Total: ${filteredEvents.length}`;
  summary.appendChild(totalLabel);

  sorted.forEach(([name, count]) => {
    const chip = document.createElement('span');
    const isActive = ga4State.searchFilter === name.toLowerCase();
    const chipColor = _ga4EventColor(name);
    chip.className = 'ga4-summary-chip' + (isActive ? ' active' : '');
    if (chipColor) {
      chip.style.borderColor = chipColor;
      if (isActive) chip.style.background = chipColor + '22';
      chip.innerHTML = `<b style="color:${chipColor}">${esc(name)}</b><span class="chip-count">${count}</span>`;
    } else {
      chip.innerHTML = `<b>${esc(name)}</b><span class="chip-count">${count}</span>`;
    }
    chip.addEventListener('click', () => {
      const search = $('ga4Search');
      if (isActive) {
        // Clear filter
        ga4State.searchFilter = '';
        if (search) search.value = '';
      } else {
        // Set filter to this event name
        ga4State.searchFilter = name.toLowerCase();
        if (search) search.value = name;
      }
      renderGA4List();
      renderGA4Summary();
    });
    summary.appendChild(chip);
  });
}

