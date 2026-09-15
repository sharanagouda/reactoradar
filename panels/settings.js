// ─── Settings Panel + Shared Utilities ─────────────────────────────────────
function getStoredTheme() {
  try { return localStorage.getItem('rn-debug-theme') || 'dark'; } catch { return 'dark'; }
}
function setStoredTheme(t) {
  try { localStorage.setItem('rn-debug-theme', t); } catch {}
}
function getStoredFontSize() {
  try { return parseInt(localStorage.getItem('rn-debug-fontsize')) || 12; } catch { return 12; }
}
function setStoredFontSize(s) {
  try { localStorage.setItem('rn-debug-fontsize', String(s)); } catch {}
}

const FONT_FAMILIES = [
  { label: 'SF Mono', value: "'SFMono-Regular', 'SF Mono', monospace" },
  { label: 'Menlo', value: "Menlo, monospace" },
  { label: 'Monaco', value: "Monaco, monospace" },
  { label: 'Courier New', value: "'Courier New', Courier, monospace" },
  { label: 'System Mono', value: "monospace" },
];
function getStoredFontFamily() {
  try {
    const saved = localStorage.getItem('rn-debug-fontfamily');
    // Reset if saved value was a removed font
    if (saved && !FONT_FAMILIES.some(f => f.value === saved)) return FONT_FAMILIES[0].value;
    return saved || FONT_FAMILIES[0].value;
  } catch { return FONT_FAMILIES[0].value; }
}
function setStoredFontFamily(f) {
  try { localStorage.setItem('rn-debug-fontfamily', f); } catch {}
}
function applyFontFamily(family) {
  document.body.style.fontFamily = family;
}

// ─── Hidden URLs (Network tab) ───────────────────────────────────────────────
function getHiddenURLs() {
  try { return JSON.parse(localStorage.getItem('rn-debug-hidden-urls') || '[]'); } catch { return []; }
}
function setHiddenURLs(list) {
  try { localStorage.setItem('rn-debug-hidden-urls', JSON.stringify(list)); } catch {}
}
function addHiddenURL(url) {
  // Extract the base URL (without query params) as the pattern
  const pattern = url.split('?')[0];
  const list = getHiddenURLs();
  if (!list.includes(pattern)) {
    list.push(pattern);
    setHiddenURLs(list);
  }
  _updateHiddenBadge();
}
function removeHiddenURL(pattern) {
  const list = getHiddenURLs().filter(u => u !== pattern);
  setHiddenURLs(list);
  _updateHiddenBadge();
}
function isURLHidden(url) {
  const hidden = getHiddenURLs();
  if (!hidden.length) return false;
  const base = url.split('?')[0];
  return hidden.some(pattern => base === pattern || base.startsWith(pattern));
}
function _updateHiddenBadge() {
  const btn = $('netHiddenBtn');
  if (!btn) return;
  const count = getHiddenURLs().length;
  btn.textContent = count > 0 ? `Hidden (${count})` : 'Hidden';
  btn.style.display = count > 0 ? '' : 'none';
}

// ─── Tab Visibility ──────────────────────────────────────────────────────────
const TAB_CONFIG = [
  { id: 'console',     label: 'Console',      icon: '🖥', essential: true },
  { id: 'network',     label: 'Network',      icon: '📡', essential: true },
  { id: 'redux',       label: 'Redux',        icon: '🔲', essential: false },
  { id: 'ga4',         label: 'GA4 Events',   icon: '📊', essential: false },
  { id: 'storage',     label: 'AsyncStorage', icon: '💾', essential: false },
  { id: 'memory',      label: 'Memory',       icon: '🧠', essential: false, defaultHidden: true },
  { id: 'performance', label: 'Performance',  icon: '⚡', essential: false, defaultHidden: true },
  { id: 'react',       label: 'React Tree',   icon: '⚛️', essential: false },
  { id: 'native',      label: 'Native Logs',  icon: '📱', essential: false, defaultHidden: true },
];
function getTabVisibility() {
  try {
    const saved = JSON.parse(localStorage.getItem('rn-debug-tab-visibility') || '{}');
    const result = {};
    TAB_CONFIG.forEach(t => { result[t.id] = saved[t.id] !== undefined ? saved[t.id] : !t.defaultHidden; });
    return result;
  } catch {
    const result = {};
    TAB_CONFIG.forEach(t => { result[t.id] = !t.defaultHidden; });
    return result;
  }
}
function setTabVisibility(vis) {
  try { localStorage.setItem('rn-debug-tab-visibility', JSON.stringify(vis)); } catch {}
}
function getTabOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem('rn-debug-tab-order') || '[]');
    if (saved.length) {
      // Merge: keep saved order, append any new tabs not in saved list
      const allIds = TAB_CONFIG.map(t => t.id);
      const merged = saved.filter(id => allIds.includes(id));
      allIds.forEach(id => { if (!merged.includes(id)) merged.push(id); });
      return merged;
    }
  } catch {}
  return TAB_CONFIG.map(t => t.id);
}
function setTabOrder(order) {
  try { localStorage.setItem('rn-debug-tab-order', JSON.stringify(order)); } catch {}
}
function applyTabVisibility() {
  const vis = getTabVisibility();
  const order = getTabOrder();
  const nav = $('sidebar');
  if (!nav) return;
  // Reorder nav buttons according to saved order + hide disabled ones
  // Settings button always stays last
  const settingsBtn = nav.querySelector('.nav-btn[data-panel="settings"]');
  const spacer = nav.querySelector('.nav-spacer');
  const anchor = spacer || settingsBtn; // insert before spacer or settings
  order.forEach(tabId => {
    const btn = nav.querySelector(`.nav-btn[data-panel="${tabId}"]`);
    if (btn) {
      btn.style.display = vis[tabId] ? '' : 'none';
      nav.insertBefore(btn, anchor);
    }
  });
  // If active panel is now hidden, switch to first visible
  if (!vis[state.activePanel]) {
    const first = order.find(id => vis[id]);
    if (first) switchPanel(first);
  }
}
function isTabEnabled(tabId) {
  return getTabVisibility()[tabId] !== false;
}

function _buildTabVisGrid() {
  const container = $('tabVisibilityGrid');
  if (!container) return;
  container.innerHTML = '';
  const vis = getTabVisibility();
  const order = getTabOrder();
  let dragSrc = null;

  order.forEach(tabId => {
    const t = TAB_CONFIG.find(c => c.id === tabId);
    if (!t) return;

    const item = document.createElement('div');
    item.className = `tab-vis-item ${vis[t.id] ? 'active' : 'inactive'}`;
    item.dataset.tab = t.id;
    item.draggable = true;

    // Drag handle
    const drag = document.createElement('span');
    drag.className = 'tab-vis-drag';
    drag.textContent = '⠿';
    item.appendChild(drag);

    // Checkbox
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'tab-vis-check';
    check.checked = vis[t.id];
    if (t.essential) check.disabled = true;
    check.addEventListener('change', () => {
      const v = getTabVisibility();
      v[t.id] = check.checked;
      setTabVisibility(v);
      applyTabVisibility();
      item.classList.toggle('active', check.checked);
      item.classList.toggle('inactive', !check.checked);
    });
    item.appendChild(check);

    // Icon + label
    const icon = document.createElement('span');
    icon.className = 'tab-vis-icon';
    icon.textContent = t.icon;
    item.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'tab-vis-label';
    label.textContent = t.label;
    item.appendChild(label);

    if (t.essential) {
      const req = document.createElement('span');
      req.className = 'tab-vis-required';
      req.textContent = 'Required';
      item.appendChild(req);
    }

    // Drag events
    item.addEventListener('dragstart', (e) => {
      dragSrc = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      container.querySelectorAll('.tab-vis-item').forEach(el => el.classList.remove('drag-over'));
      dragSrc = null;
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragSrc && dragSrc !== item) item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (!dragSrc || dragSrc === item) return;
      // Reorder: move dragSrc before or after this item
      const items = [...container.querySelectorAll('.tab-vis-item')];
      const fromIdx = items.indexOf(dragSrc);
      const toIdx = items.indexOf(item);
      if (fromIdx < toIdx) {
        container.insertBefore(dragSrc, item.nextSibling);
      } else {
        container.insertBefore(dragSrc, item);
      }
      // Save new order
      const newOrder = [...container.querySelectorAll('.tab-vis-item')].map(el => el.dataset.tab);
      setTabOrder(newOrder);
      applyTabVisibility();
    });

    container.appendChild(item);
  });
}

function getStoredAppName() {
  try { return localStorage.getItem('rn-debug-appname') || 'ReactoRadar'; } catch { return 'ReactoRadar'; }
}
function setStoredAppName(n) {
  try { localStorage.setItem('rn-debug-appname', n); } catch {}
}
function getStoredMetroPort() {
  try { return parseInt(localStorage.getItem('rn-debug-metro-port')) || 8081; } catch { return 8081; }
}
function setStoredMetroPort(p) {
  try { localStorage.setItem('rn-debug-metro-port', String(p)); } catch {}
}
function applyAppName(name) {
  const logo = document.querySelector('.logo');
  if (logo) {
    // Split name — first part normal, last word in accent span
    const words = name.split(/(?=[A-Z])/);
    if (words.length >= 2) {
      logo.innerHTML = words.slice(0, -1).join('') + '<span>' + words[words.length - 1] + '</span>';
    } else {
      logo.textContent = name;
    }
  }
  document.title = name;
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // Tell main process (light themes need light nativeTheme for window chrome)
  const isLight = ['light', 'solarized-light'].includes(theme);
  window.electronAPI?.setTheme(isLight ? 'light' : 'dark');
}

function applyFontSize(size) {
  document.documentElement.style.setProperty('--app-font-size', size + 'px');
  document.body.style.fontSize = size + 'px';
  // Inject/update a <style> tag so ALL current and future elements get the size
  let styleEl = document.getElementById('dynamic-font-size');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'dynamic-font-size';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `
    .log-preview, .log-body, .log-text, .log-caller-inline,
    .net-cell, .net-cell-name, .net-type, .net-initiator, .net-size, .net-time, .net-status,
    .detail-content, .kv-val, .kv-key,
    .rdx-type, .rdx-entry-detail, .rdx-store-key-label,
    .storage-value-body, .storage-key-row,
    .sources-code, .source-line-code,
    .ov-leaf, .ov-key, .ov-preview, .ov-str, .ov-num, .ov-bool, .ov-null, .ov-undef,
    .perf-meter-label,
    .settings-label, .settings-hint {
      font-size: ${size}px !important;
    }
  `;
  const display = $('fontSizeDisplay');
  if (display) display.textContent = size + 'px';
}

function initSettingsPanel() {
  const panel = $('panel-settings');
  if (!panel) return;
  const current = getStoredTheme();
  const currentSize = getStoredFontSize();
   panel.innerHTML = `
    <div class="panel-toolbar">
      <span class="panel-label">Settings</span>
    </div>
    <div class="scroll-area">
      <div class="settings-two-col">
        <div class="settings-col-left">
          <div class="settings-section">
            <div class="settings-section-title">Appearance</div>
            <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:8px">
              <div>
                <div class="settings-label">Theme</div>
                <div class="settings-hint">Choose a color theme</div>
              </div>
              <div class="theme-grid" id="themeSwitcher"></div>
            </div>
            <div class="settings-row">
              <div>
                <div class="settings-label">Font Size</div>
                <div class="settings-hint">Adjust text size</div>
              </div>
              <div class="font-size-control">
                <button class="font-size-btn" id="fontSizeDown">A-</button>
                <span class="font-size-display" id="fontSizeDisplay">${currentSize}px</span>
                <button class="font-size-btn" id="fontSizeUp">A+</button>
              </div>
            </div>
            <div class="settings-row">
              <div>
                <div class="settings-label">Font Family</div>
              </div>
              <select id="fontFamilySelect" class="net-throttle-select" style="width:150px">
                ${FONT_FAMILIES.map(f => `<option value="${esc(f.value)}" ${f.value === getStoredFontFamily() ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}
              </select>
            </div>
            <div class="settings-row">
              <div>
                <div class="settings-label">App Name</div>
              </div>
              <div style="display:flex;align-items:center;gap:6px">
                <input id="appNameInput" class="net-search-input" style="width:120px;text-align:center" value="${getStoredAppName()}" />
                <button class="font-size-btn" id="appNameReset" title="Reset">Reset</button>
              </div>
            </div>
            <div class="settings-row">
              <div>
                <div class="settings-label">Toast Notifications</div>
                <div class="settings-hint">Show alerts for API errors and slow requests</div>
              </div>
              <label class="toggle-label" for="toastToggle">
                <input type="checkbox" id="toastToggle" class="toggle-input" ${getToastsEnabled() ? 'checked' : ''} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-title">Connection</div>
            <div class="settings-row">
              <div>
                <div class="settings-label">Bridge Ports</div>
                <div class="settings-hint">Redux :9090 · Storage :9091 · Network :9092</div>
              </div>
            </div>
            <div class="settings-row">
              <div>
                <div class="settings-label">Metro Port</div>
              </div>
              <input id="metroPortInput" type="number" class="net-search-input" style="width:70px;text-align:center" value="${getStoredMetroPort()}" />
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-title">About</div>
            <div class="settings-about">
              <div class="about-name" id="aboutAppName">${getStoredAppName()}</div>
              <div class="about-version" id="aboutVersion">v${state._appVersion || '...'}</div>
              <div class="about-desc">Standalone macOS debugger for React Native.<br/>Supports Hermes, New Arch, and RN 0.74+.</div>
              <div class="about-links" style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
                <span class="about-link" id="linkGithub">GitHub</span>
                <span class="about-link" id="linkDocs">Docs</span>
                <span class="about-link" id="linkLinkedIn">LinkedIn</span>
              </div>
              <div style="margin-top:12px;text-align:center">
                <button class="support-btn" id="linkSupport" title="Support ReactoRadar development">☕ Support this project</button>
              </div>
            </div>
          </div>
        </div>
        <div class="settings-col-right">
          <div class="settings-section">
            <div class="settings-section-title">Panels</div>
            <div class="settings-hint" style="margin-bottom:8px">Show/hide tabs and drag to reorder. Disabled tabs save memory.</div>
            <div class="tab-visibility-grid" id="tabVisibilityGrid"></div>
          </div>
          <div class="settings-section">
            <div class="settings-section-title">Keyboard Shortcuts</div>
            <div class="settings-shortcut-grid">
              <span class="sc-key">⌘K</span><span class="sc-label">Clear All</span>
              <span class="sc-key">⌘D</span><span class="sc-label">JS Debugger</span>
              <span class="sc-key">⌘R</span><span class="sc-label">React DevTools</span>
              <span class="sc-key">⌘⇧T</span><span class="sc-label">Toggle Theme</span>
              <span class="sc-key">⌘F</span><span class="sc-label">Find</span>
              <span class="sc-key">⌘1–9</span><span class="sc-label">Switch Panels</span>
              <span class="sc-key">⌘+/−</span><span class="sc-label">Zoom</span>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-title">Quick Start</div>
            <div class="settings-hint" style="line-height:1.8;font-size:11px">
              <b style="color:var(--text)">1.</b> <code style="color:var(--accent);background:var(--bg3);padding:1px 5px;border-radius:3px">npx reactoradar setup</code><br/>
              <b style="color:var(--text)">2.</b> <code style="color:var(--accent);background:var(--bg3);padding:1px 5px;border-radius:3px">npx reactoradar</code> or open app<br/>
              <b style="color:var(--text)">3.</b> <code style="color:var(--accent);background:var(--bg3);padding:1px 5px;border-radius:3px">npx react-native start</code><br/>
              <b style="color:var(--text)">4.</b> Console, Network, Redux auto-connect<br/>
              <b style="color:var(--text)">5.</b> <code style="color:var(--accent);background:var(--bg3);padding:1px 5px;border-radius:3px">npx reactoradar remove</code> to uninstall
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-title">Version History</div>
            <div class="settings-hint" style="margin-bottom:4px">Roll back to a previous version if you notice issues.</div>
            <div class="settings-hint rollback-steps" id="rollbackSteps" style="margin-bottom:10px;line-height:1.8;font-size:10px">
              <b style="color:var(--text)">How to roll back:</b><br/>
              <span id="rollbackDmgSteps" style="display:none">
                <b style="color:var(--text)">1.</b> Click <b>Download</b> on the version you want<br/>
                <b style="color:var(--text)">2.</b> Open the downloaded <code style="color:var(--accent);background:var(--bg3);padding:1px 4px;border-radius:3px">.dmg</code> file<br/>
                <b style="color:var(--text)">3.</b> Drag the app to Applications (replace existing)<br/>
                <b style="color:var(--text)">4.</b> Relaunch ReactoRadar
              </span>
              <span id="rollbackNpmSteps" style="display:none">
                <b style="color:var(--text)">1.</b> Run <code style="color:var(--accent);background:var(--bg3);padding:1px 4px;border-radius:3px">npx reactoradar@&lt;version&gt;</code> e.g. <code style="color:var(--accent);background:var(--bg3);padding:1px 4px;border-radius:3px">npx reactoradar@1.6.4</code><br/>
                <b style="color:var(--text)">2.</b> Or pin globally: <code style="color:var(--accent);background:var(--bg3);padding:1px 4px;border-radius:3px">npm i -g reactoradar@1.6.4</code><br/>
                <b style="color:var(--text)">3.</b> Run <code style="color:var(--accent);background:var(--bg3);padding:1px 4px;border-radius:3px">reactoradar</code> to launch
              </span>
            </div>
            <div id="versionHistoryList" class="version-history-list">
              <div style="color:var(--text-dim);font-size:11px;padding:12px;text-align:center">Loading versions...</div>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  // Build theme cards
  const themes = [
    { id: 'dark',            name: 'Dark',            colors: ['#0d0e11','#4facff','#3dd68c','#ff5e72'] },
    { id: 'light',           name: 'Light',           colors: ['#f5f6f8','#0969da','#1a7f37','#cf222e'] },
    { id: 'monokai',         name: 'Monokai',         colors: ['#272822','#66d9ef','#a6e22e','#f92672'] },
    { id: 'dracula',         name: 'Dracula',         colors: ['#282a36','#8be9fd','#50fa7b','#ff5555'] },
    { id: 'solarized-dark',  name: 'Solarized Dark',  colors: ['#002b36','#268bd2','#859900','#dc322f'] },
    { id: 'solarized-light', name: 'Solarized Light', colors: ['#fdf6e3','#268bd2','#859900','#dc322f'] },
    { id: 'nord',            name: 'Nord',            colors: ['#2e3440','#88c0d0','#a3be8c','#bf616a'] },
    { id: 'github-dark',     name: 'GitHub Dark',     colors: ['#0d1117','#58a6ff','#3fb950','#f85149'] },
    { id: 'one-dark',        name: 'One Dark',        colors: ['#282c34','#61afef','#98c379','#e06c75'] },
  ];
  // Tab visibility + drag reorder
  _buildTabVisGrid();

  const grid = $('themeSwitcher');
  themes.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'theme-card' + (current === t.id ? ' active' : '');
    btn.dataset.theme = t.id;
    btn.innerHTML = '<div class="theme-preview" style="background:' + t.colors[0] + '">' +
      '<span style="background:' + t.colors[1] + '"></span>' +
      '<span style="background:' + t.colors[2] + '"></span>' +
      '<span style="background:' + t.colors[3] + '"></span>' +
      '</div><div class="theme-name">' + t.name + '</div>';
    grid.appendChild(btn);
  });

  // Theme switcher
  $('themeSwitcher').addEventListener('click', (e) => {
    const btn = e.target.closest('.theme-card');
    if (!btn) return;
    const theme = btn.dataset.theme;
    document.querySelectorAll('#themeSwitcher .theme-card').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    setStoredTheme(theme);
    applyTheme(theme);
  });

  // About links
  $('linkGithub')?.addEventListener('click', () => {
    window.electronAPI?.openExternal('https://github.com/sharanagouda/reactoradar');
  });
  $('linkDocs')?.addEventListener('click', () => {
    window.electronAPI?.openExternal('https://github.com/sharanagouda/reactoradar#readme');
  });
  $('linkLinkedIn')?.addEventListener('click', () => {
    window.electronAPI?.openExternal('https://www.linkedin.com/in/sharanagoudamk/');
  });
  $('linkSupport')?.addEventListener('click', () => {
    window.electronAPI?.openExternal('https://razorpay.me/@reactoradar');
  });

  // App name
  $('appNameInput').addEventListener('change', (e) => {
    const name = e.target.value.trim() || 'ReactoRadar';
    setStoredAppName(name);
    applyAppName(name);
  });
  $('appNameReset').addEventListener('click', () => {
    setStoredAppName('ReactoRadar');
    $('appNameInput').value = 'ReactoRadar';
    applyAppName('ReactoRadar');
  });

  // Metro Port
  $('metroPortInput')?.addEventListener('change', (e) => {
    let port = parseInt(e.target.value.trim());
    if (isNaN(port) || port < 1024 || port > 65535) port = 8081;
    e.target.value = port;
    setStoredMetroPort(port);
    window.electronAPI?.setMetroPort(port);
  });

  // Font size controls
  $('fontSizeDown').addEventListener('click', () => {
    let size = getStoredFontSize();
    size = Math.max(8, size - 1);
    setStoredFontSize(size);
    applyFontSize(size);
  });
  $('fontSizeUp').addEventListener('click', () => {
    let size = getStoredFontSize();
    size = Math.min(20, size + 1);
    setStoredFontSize(size);
    applyFontSize(size);
  });

  // Font family
  $('fontFamilySelect')?.addEventListener('change', (e) => {
    const family = e.target.value;
    setStoredFontFamily(family);
    applyFontFamily(family);
  });

  // Toast toggle
  $('toastToggle')?.addEventListener('change', (e) => {
    setToastsEnabled(e.target.checked);
  });

  // Apply update banner if update info arrived before settings panel was created
  _applyUpdateBanner();

  // Fetch and render version history for rollback
  _loadVersionHistory();
}

function _loadVersionHistory() {
  const container = $('versionHistoryList');
  if (!container) return;
  if (!window.electronAPI || typeof window.electronAPI.fetchReleases !== 'function') {
    container.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:12px;text-align:center">Version history not available.</div>';
    return;
  }

  // Show appropriate rollback steps based on install type
  const isPackaged = !!state._isPackaged;
  const dmgSteps = $('rollbackDmgSteps');
  const npmSteps = $('rollbackNpmSteps');
  if (dmgSteps) dmgSteps.style.display = isPackaged ? '' : 'none';
  if (npmSteps) npmSteps.style.display = isPackaged ? 'none' : '';

  window.electronAPI.fetchReleases().then(releases => {
    if (!Array.isArray(releases) || releases.length === 0) {
      container.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:12px;text-align:center">Could not load versions.</div>';
      return;
    }

    const currentVersion = state._appVersion || '';
    container.innerHTML = '';

    releases.forEach(r => {
      if (!r || !r.version) return; // skip malformed entries

      const isCurrent = r.version === currentVersion;
      const row = document.createElement('div');
      row.className = 'version-row' + (isCurrent ? ' version-current' : '');

      // Safe date formatting
      let dateStr = '';
      if (r.date) {
        try {
          const d = new Date(r.date);
          if (!isNaN(d.getTime())) {
            dateStr = d.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
          }
        } catch { /* skip bad date */ }
      }

      // Build action button based on install type
      let actionHtml = '';
      if (isCurrent) {
        actionHtml = '<span class="version-installed">Installed</span>';
      } else if (isPackaged) {
        actionHtml = '<button class="version-install-btn" title="Download .dmg for this version">Download</button>';
      } else {
        actionHtml = `<button class="version-npm-btn" title="Copy npm install command">npx reactoradar@${esc(r.version)}</button>`;
      }

      row.innerHTML = `
        <div class="version-info">
          <span class="version-tag">v${esc(r.version)}${r.prerelease ? ' <span class="version-pre">pre</span>' : ''}${isCurrent ? ' <span class="version-badge">current</span>' : ''}</span>
          <span class="version-date">${esc(dateStr)}</span>
        </div>
        <div class="version-actions">
          ${actionHtml}
          <button class="version-notes-btn" title="View release notes">Notes</button>
        </div>`;

      // DMG download button — opens the .dmg asset or release page
      const installBtn = row.querySelector('.version-install-btn');
      if (installBtn) {
        installBtn.addEventListener('click', () => {
          const url = r.dmgUrl || r.htmlUrl || '';
          if (url) {
            window.electronAPI.openExternal(url);
          }
        });
      }

      // NPM copy button — copies the npx command to clipboard
      const npmBtn = row.querySelector('.version-npm-btn');
      if (npmBtn) {
        npmBtn.addEventListener('click', () => {
          const cmd = `npx reactoradar@${r.version}`;
          navigator.clipboard.writeText(cmd).then(() => {
            const orig = npmBtn.textContent;
            npmBtn.textContent = 'Copied!';
            npmBtn.style.color = 'var(--green)';
            setTimeout(() => { npmBtn.textContent = orig; npmBtn.style.color = ''; }, 2000);
          }).catch(() => {});
        });
      }

      // Notes button — show changelog in modal
      const notesBtn = row.querySelector('.version-notes-btn');
      if (notesBtn) {
        notesBtn.addEventListener('click', () => {
          if (r.version && typeof _showChangelog === 'function') {
            _showChangelog(r.version);
          }
        });
      }

      container.appendChild(row);
    });

    // If no rows were rendered (all entries were malformed)
    if (container.children.length === 0) {
      container.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:12px;text-align:center">No versions found.</div>';
    }
  }).catch(() => {
    if (container) {
      container.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:12px;text-align:center">Could not load versions. Check your internet connection.</div>';
    }
  });
}


// ─── Update Banner & Changelog (shared, used by IPC handlers) ──────────────
// Reusable — called from IPC handler AND from initSettingsPanel
function _applyUpdateBanner() {
  const info = state._updateAvailable;
  if (!info) return;
  const { current, latest, autoUpdate } = info;
  const downloaded = state._updateDownloaded;
  const targetVersion = downloaded || latest;

  const el = $('aboutVersion');
  if (el) {
    if (downloaded) {
      el.innerHTML = `v${current} <span style="color:var(--green);font-size:10px;margin-left:6px">v${downloaded} ready to install</span>`;
    } else {
      el.innerHTML = `v${current} <span style="color:var(--green);font-size:10px;margin-left:6px">v${latest} available</span>`;
    }
  }

  // Remove old buttons if state changed
  const oldBtn = $('updateBtn');
  if (oldBtn && downloaded && !oldBtn.dataset.isRestart) oldBtn.parentElement?.remove();
  const oldChangelog = $('changelogBtn');
  if (oldChangelog && downloaded && !oldChangelog.dataset.updated) oldChangelog.remove();

  const aboutEl = document.querySelector('.settings-about');
  if (!aboutEl) return;

  // Add "What's new?" link
  if (!$('changelogBtn')) {
    const link = document.createElement('div');
    link.style.cssText = 'margin-top:6px;text-align:center';
    link.innerHTML = `<span id="changelogBtn" class="about-link" style="font-size:10px;cursor:pointer" data-updated="${downloaded ? '1' : ''}">What's new in v${targetVersion}?</span>`;
    aboutEl.appendChild(link);
    $('changelogBtn')?.addEventListener('click', () => _showChangelog(targetVersion));
  }

  // Add update button
  if (!$('updateBtn')) {
    const btn = document.createElement('div');
    btn.style.cssText = 'margin-top:8px;text-align:center';
    if (downloaded) {
      btn.innerHTML = '<button id="updateBtn" data-is-restart="1" class="tb-btn primary" style="font-size:11px;padding:6px 16px">Restart & Update to v' + downloaded + '</button>';
      aboutEl.appendChild(btn);
      $('updateBtn')?.addEventListener('click', () => window.electronAPI?.installUpdate());
    } else if (autoUpdate) {
      btn.innerHTML = '<button id="updateBtn" class="tb-btn" style="font-size:11px;padding:6px 16px;opacity:0.7" disabled>Downloading v' + latest + '...</button>';
      aboutEl.appendChild(btn);
    } else {
      btn.innerHTML = '<button id="updateBtn" class="tb-btn primary" style="font-size:11px;padding:6px 16px">Download v' + latest + '</button>';
      aboutEl.appendChild(btn);
      $('updateBtn')?.addEventListener('click', () => window.electronAPI?.openExternal('https://github.com/sharanagouda/reactoradar/releases'));
    }
  }
}

async function _showChangelog(version) {
  if (!version || typeof version !== 'string') return;

  // Remove existing modal
  $('changelogModal')?.remove();

  const safeVersion = esc(version);
  const modal = document.createElement('div');
  modal.id = 'changelogModal';
  modal.className = 'changelog-modal-overlay';
  modal.innerHTML = `
    <div class="changelog-modal">
      <div class="changelog-header">
        <span class="changelog-title">What's New in v${safeVersion}</span>
        <button class="changelog-close" id="changelogClose">&times;</button>
      </div>
      <div class="changelog-body" id="changelogBody">
        <div style="color:var(--text-dim);padding:20px;text-align:center">Loading release notes...</div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Close handlers
  $('changelogClose')?.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  // Fetch changelog
  try {
    const notes = await window.electronAPI?.fetchChangelog(version);
    const body = $('changelogBody');
    if (!body) return;
    if (!notes || typeof notes !== 'string') {
      body.innerHTML = '<div style="color:var(--text-dim);padding:20px;text-align:center">No release notes available.</div>';
      return;
    }
    if (body && notes) {
      // Simple markdown-like rendering
      body.innerHTML = notes
        .replace(/^### (.+)$/gm, '<h3 style="color:var(--accent);font-size:12px;font-weight:700;margin:12px 0 6px">$1</h3>')
        .replace(/^## (.+)$/gm, '<h2 style="color:var(--text);font-size:14px;font-weight:700;margin:16px 0 8px">$1</h2>')
        .replace(/^- \*\*(.+?)\*\*(.*)$/gm, '<div style="margin:3px 0;font-size:11px;line-height:1.6"><b style="color:var(--text)">$1</b><span style="color:var(--text-dim)">$2</span></div>')
        .replace(/^- (.+)$/gm, '<div style="margin:3px 0;font-size:11px;line-height:1.6;color:var(--text-mid)">• $1</div>')
        .replace(/`([^`]+)`/g, '<code style="background:var(--bg3);padding:1px 4px;border-radius:3px;color:var(--accent);font-size:10px">$1</code>')
        // Convert markdown links [text](url) to clickable links
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a class="changelog-link" href="$2">$1</a>')
        // Convert bare URLs to clickable links (skip already wrapped in href="...")
        .replace(/(?<!href="|">)(https?:\/\/[^\s<)"]+)/g, '<a class="changelog-link" href="$1">$1</a>')
        // Make .dmg and .zip filenames clickable — link to GitHub release assets
        .replace(/(ReactoRadar-[\d.]+-arm64\.dmg)(?!\s*<\/a>)/g,
          `<a class="changelog-link" href="https://github.com/sharanagouda/reactoradar/releases/download/v${esc(version)}/$1">$1</a>`)
        .replace(/(ReactoRadar-[\d.]+-arm64-mac\.zip)(?!\s*<\/a>)/g,
          `<a class="changelog-link" href="https://github.com/sharanagouda/reactoradar/releases/download/v${esc(version)}/$1">$1</a>`)
        .replace(/\n\n/g, '<br/>');

      // Make all links open externally (not inside Electron)
      body.querySelectorAll('a.changelog-link').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const url = a.getAttribute('href');
          if (url) window.electronAPI?.openExternal(url);
        });
      });
    }
  } catch {
    const body = $('changelogBody');
    if (body) body.innerHTML = '<div style="color:var(--red);padding:20px;text-align:center">Could not fetch release notes</div>';
  }
}



