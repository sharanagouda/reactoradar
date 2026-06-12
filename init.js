// ─────────────────────────────────────────────────────────────────────────────
// init.js — IPC wiring, button handlers, memory monitor, and panel initialization
// This file loads LAST — after app.js (state/helpers) and all panel scripts.
// ─────────────────────────────────────────────────────────────────────────────

// ─── CDP Button ───────────────────────────────────────────────────────────────
$('btnCDP')?.addEventListener('click', () => {
  // Tell main process to open the CDP DevTools window with the best available target
  window.electronAPI?.openCDPTarget(null); // null = use latest known target
});

// ─── Screenshot Button ────────────────────────────────────────────────────────
$('btnScreenshot')?.addEventListener('click', takeScreenshot);

// ─────────────────────────────────────────────────────────────────────────────
// IPC from Main
// ─────────────────────────────────────────────────────────────────────────────
if (window.electronAPI) {
  window.electronAPI.on('ports', ports => { state.ports = ports; });

  window.electronAPI.on('cdp-targets', targets => {
    state.cdpTargets = targets;
    const btn = $('btnCDP');
    if (btn) {
      const hasCDP = targets?.length > 0;
      const port = state.ports?.METRO || getStoredMetroPort();
      btn.textContent = hasCDP
        ? `JS Debugger (:${port}) [${targets.length}] ↗`
        : `JS Debugger (:${port}) ↗`;
      btn.style.opacity = hasCDP ? '1' : '0.5';
      if (hasCDP) {
        btn.onclick = () => window.electronAPI.openCDPTarget(targets[0].webSocketDebuggerUrl);
      }
    }
  });

  window.electronAPI.on('redux-event', handleReduxEvent);
  window.electronAPI.on('network-event', handleNetworkEvent);
  window.electronAPI.on('storage-event', handleStorageEvent);

  window.electronAPI.on('ga4-event', handleGA4Event);

  window.electronAPI.on('perf-event', event => {
    handlePerfEvent(event);
    handleMemoryEvent(event);
  });

  window.electronAPI.on('clear-all-ui', clearAll);

  // Device disconnect → debounced freeMemory. Reconnect → clearAll (fresh session).
  let _disconnectTimer = null;
  let _wasDisconnected = false;

  window.electronAPI.on('device-all-disconnected', () => {
    _wasDisconnected = true;
    clearTimeout(_disconnectTimer);
    _disconnectTimer = setTimeout(() => {
      console.log('[App] All devices disconnected — freeing memory');
      freeMemory();
    }, 3000);
  });

  const _handleReconnect = () => {
    clearTimeout(_disconnectTimer);
    _disconnectTimer = null;
    if (_wasDisconnected) {
      _wasDisconnected = false;
      console.log('[App] Device reconnected — clearing old session data');
      clearAll();
    }
  };

  window.electronAPI.on('redux-connected', on => { if (on) _handleReconnect(); updateDeviceBanner('redux', on); });
  window.electronAPI.on('network-connected', on => { if (on) _handleReconnect(); updateDeviceBanner('network', on); });
  window.electronAPI.on('storage-connected', on => { if (on) _handleReconnect(); updateDeviceBanner('storage', on); });
  window.electronAPI.on('react-dt-status', on => { updateDeviceBanner('reactDT', on); });

  // Cmd+F — focus the search input for the active panel
  function _handleFind() {
    // If network detail is open, focus the detail search
    if (state.activePanel === 'network' && state.network.selectedId) {
      const wrap = $('detailSearchWrap');
      const input = $('detailSearchInput');
      if (wrap && input) {
        wrap.style.display = 'flex';
        input.focus();
        input.select();
        return;
      }
    }
    const searchMap = {
      console: 'consoleSearch',
      network: 'netSearchInput',
      ga4: 'ga4Search',
      redux: 'reduxSearch',
      storage: 'storageSearch',
    };
    const inputId = searchMap[state.activePanel];
    if (inputId) {
      const el = $(inputId);
      if (el) { el.focus(); el.select(); }
    }
    // Also show/focus Console bottom find bar
    if (state.activePanel === 'console') {
      const bar = $('consoleFindBar');
      if (bar) { bar.style.display = 'flex'; $('consoleFindInput')?.focus(); }
    }
  }
  window.electronAPI.on('focus-search', _handleFind);
  // Direct keyboard fallback — Electron menu accelerators can miss in some contexts
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      _handleFind();
    }
  });

  window.electronAPI.on('app-version', (version, isPackaged) => {
    state._appVersion = version;
    state._isPackaged = !!isPackaged;
    // Update anywhere the version is displayed
    document.querySelectorAll('#aboutVersion').forEach(el => el.textContent = 'v' + version);
  });

  window.electronAPI.on('update-available', ({ current, latest, autoUpdate }) => {
    state._updateAvailable = { current, latest, autoUpdate };
    _applyUpdateBanner();
  });

  window.electronAPI.on('update-downloaded', ({ version }) => {
    state._updateDownloaded = version;
    _applyUpdateBanner();
  });

  window.electronAPI.on('trigger-open-cdp', () => {
    window.electronAPI?.openCDPTarget(null);
  });

  // Theme toggle from menu shortcut (Cmd+Shift+T)
  window.electronAPI.on('theme-changed', theme => {
    document.documentElement.setAttribute('data-theme', theme);
    setStoredTheme(theme);
    document.querySelectorAll('#themeSwitcher .theme-card')
      .forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
  });

  // Console event IPC
  window.electronAPI.on('console-event', addConsoleLog);
}

// ─── Memory Monitor ──────────────────────────────────────────────────────────
// Check memory usage periodically and warn user before it causes blank screen
let _memoryWarningShown = false;
setInterval(() => {
  if (!window.performance || !performance.memory) return;
  const used = performance.memory.usedJSHeapSize;
  const limit = performance.memory.jsHeapSizeLimit;
  const pct = used / limit;
  // Warn at 70% usage
  if (pct > 0.7 && !_memoryWarningShown) {
    _memoryWarningShown = true;
    const banner = document.createElement('div');
    banner.id = 'memoryWarning';
    banner.className = 'memory-warning';
    const usedMB = Math.round(used / 1024 / 1024);
    banner.innerHTML = `<span>High memory usage (${usedMB}MB) — ReactoRadar may become unresponsive.</span>`
      + `<button class="memory-warn-btn" id="memWarnClear">Clear All Data</button>`
      + `<button class="memory-warn-btn" id="memWarnDismiss">Dismiss</button>`;
    document.body.prepend(banner);
    $('memWarnClear')?.addEventListener('click', () => {
      // Clear all panel data
      state.console.logs = []; _consolePending = [];
      _lastLogMsg = ''; _lastLogRow = null; _lastLogCount = 1;
      $('cBadge').textContent = '0'; renderConsole();
      state.network.requests = {}; state.network.order = []; state.network.selectedId = null;
      $('nBadge').textContent = '0'; renderNetwork();
      state.redux.actions = []; state.redux.states = []; state.redux.selected = -1;
      $('rBadge').textContent = '0'; renderRedux();
      banner.remove(); _memoryWarningShown = false;
    });
    $('memWarnDismiss')?.addEventListener('click', () => { banner.remove(); });
  }
  // Reset flag when memory drops
  if (pct < 0.5) _memoryWarningShown = false;
}, 30000); // Check every 30 seconds

// Apply saved theme + font size + font family + app name on load

applyTheme(getStoredTheme());
applyFontSize(getStoredFontSize());
applyFontFamily(getStoredFontFamily());
applyAppName(getStoredAppName());
applyTabVisibility();

// Send stored metro port to backend
window.electronAPI?.setMetroPort(getStoredMetroPort());

// ─────────────────────────────────────────────────────────────────────────────
// INIT — Panel initialization (all panel scripts must be loaded before this)
// ─────────────────────────────────────────────────────────────────────────────
initConsolePanel();
initNetworkPanel();
initGA4Panel();
initPerformancePanel();
initMemoryPanel();
initReduxPanel();
initStoragePanel();
initReactPanel();
initNativeLogsPanel();
initSettingsPanel();
