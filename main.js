'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell, nativeTheme, nativeImage, dialog } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const { WebSocketServer, WebSocket } = require('ws');
let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch {}

// ─── Ports ────────────────────────────────────────────────────────────────────
const PORTS = {
  METRO:         8081,   // Metro bundler (CDP proxy lives here)
  REACT_DT:      8097,   // react-devtools-core server port
  REDUX_BRIDGE:  9090,   // our custom Redux WS bridge
  STORAGE_BRIDGE:9091,   // AsyncStorage WS bridge
  NETWORK_BRIDGE:9092,   // Network intercept WS bridge
};

// ─── Windows ──────────────────────────────────────────────────────────────────
let mainWindow = null;
let devtoolsWindow = null;  // hosts the embedded CDP DevTools frontend
let _forceQuit = false;

// Safe IPC send — prevents "Object has been destroyed" crash
function _send(channel, ...args) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args);
    }
  } catch {}
}

// ─── State ────────────────────────────────────────────────────────────────────
let reduxClients   = new Set();
let storageClients = new Set();
let networkClients = new Set();
const _bridgeServers = [];  // track bridge WSS instances for cleanup on quit

// ─── Set dock icon ASAP (before app ready) ──────────────────────────────────
const _appIcon = nativeImage.createFromPath(path.join(__dirname, 'ReactoRadar.png'));

// ─── Single Instance Lock ────────────────────────────────────────────────────
// Prevent multiple ReactoRadar instances from running simultaneously.
// If a second instance launches, focus the existing window instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another instance is already running — show a dialog and quit
  const { dialog } = require('electron');
  app.whenReady().then(() => {
    dialog.showErrorBox(
      'ReactoRadar is already running',
      'Another instance of ReactoRadar is already open.\n\nPlease close the existing instance first, or check your system tray / dock.\n\nIf the old version is stuck, run:\n  kill $(lsof -ti :9092) \nin your terminal to stop it.'
    );
    app.quit();
  });
} else {
  app.on('second-instance', () => {
    // Focus the existing window when someone tries to open a second instance
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
if (gotLock) app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';

  // Set dock icon on macOS
  if (process.platform === 'darwin' && !_appIcon.isEmpty()) {
    try { app.dock.setIcon(_appIcon); } catch {}
  }

  await createMainWindow();

  // Send version + install type to renderer — try package.json, fallback to app.getVersion()
  let appVersion;
  try { appVersion = require('./package.json').version; } catch { appVersion = app.getVersion(); }
  const isPackaged = app.isPackaged;
  // Send multiple times to ensure renderer catches it (covers race conditions)
  mainWindow.webContents.on('did-finish-load', () => {
    // Send immediately + retries
    _send('app-version', appVersion, isPackaged);
    [500, 2000, 5000].forEach(delay => {
      setTimeout(() => _send('app-version', appVersion, isPackaged), delay);
    });
  });

  // Check for updates (non-blocking)
  checkForUpdates();
  startBridgeServers();
  // React DevTools relay NOT started by default — it blocks RN's built-in inspector.
  // Started on-demand when user clicks React tab or Cmd+R.
  setupMetroCDPProxy();
  setupIPC();
  buildMenu();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  _forceQuit = true;
  // Free renderer memory before shutdown (logs are not cleared — user may still see them briefly)
  _send('device-all-disconnected');
  // Close CDP DevTools window if open
  if (devtoolsWindow && !devtoolsWindow.isDestroyed()) {
    devtoolsWindow.destroy();
    devtoolsWindow = null;
  }
  // Close all WS servers gracefully
  if (reactDTServer) {
    reactDTServer.close();
    reactDTClients.forEach(ws => ws.close());
    reactDTClients.clear();
  }
  // Close bridge servers and disconnect all clients
  _bridgeServers.forEach(wss => {
    wss.clients.forEach(ws => ws.close());
    wss.close();
  });
  reduxClients.clear();
  storageClients.clear();
  networkClients.clear();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

// ─── Main Window ──────────────────────────────────────────────────────────────
async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0b0e',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: _appIcon,
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open the JS Debugger panel (CDP DevTools) in a second window
  mainWindow.webContents.on('did-finish-load', () => {
    _send('ports', PORTS);
  });

  // Close confirmation dialog
  mainWindow.on('close', (e) => {
    if (_forceQuit) return;
    e.preventDefault();
    dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      title: 'Close ReactoRadar',
      message: 'Are you sure you want to quit?',
      detail: 'Active debug sessions will be disconnected.',
    }).then(({ response }) => {
      if (response === 0) {
        _forceQuit = true;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
        app.quit();
      }
    });
  });
}

// ─── Update Checker ──────────────────────────────────────────────────────────
function _semverCompare(a, b) {
  // Returns 1 if a > b, -1 if a < b, 0 if equal
  const pa = (a || '').split('.').map(Number);
  const pb = (b || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0, vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function checkForUpdates() {
  const currentVersion = require('./package.json').version;

  // ─── Electron Auto-Updater (for .dmg installs) ────────────────────────────
  // Downloads and installs updates from GitHub Releases automatically.
  if (autoUpdater && app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      console.log(`[AutoUpdate] New version available: ${info.version}`);
      const payload = { current: currentVersion, latest: info.version, autoUpdate: true };
      [500, 2000].forEach(delay => setTimeout(() => _send('update-available', payload), delay));
    });

    autoUpdater.on('update-downloaded', (info) => {
      console.log(`[AutoUpdate] Update downloaded: ${info.version}`);
      _send('update-downloaded', { version: info.version });
    });

    autoUpdater.on('error', (err) => {
      console.warn('[AutoUpdate] Error:', err?.message);
    });

    // Check after a short delay to not block startup
    setTimeout(() => {
      try { autoUpdater.checkForUpdates(); } catch {}
    }, 5000);
    // Also check periodically (every 2 hours)
    setInterval(() => {
      try { autoUpdater.checkForUpdates(); } catch {}
    }, 2 * 60 * 60 * 1000);
    return;
  }

  // ─── Fallback: npm registry check (for npx users) ─────────────────────────
  https.get('https://registry.npmjs.org/reactoradar/latest', (res) => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => {
      try {
        const latest = JSON.parse(data).version;
        if (latest && _semverCompare(latest, currentVersion) > 0) {
          const payload = { current: currentVersion, latest, autoUpdate: false };
          [500, 2000, 5000].forEach(delay => {
            setTimeout(() => _send('update-available', payload), delay);
          });
          console.log(`[Update] New version available: ${latest} (current: ${currentVersion})`);
        }
      } catch {}
    });
  }).on('error', () => {});
}

// ─── CDP DevTools Window (JS breakpoints, Sources, Console) ──────────────────
let lastKnownTargets = [];

function openCDPWindow(target) {
  if (devtoolsWindow && !devtoolsWindow.isDestroyed()) {
    devtoolsWindow.focus();
    return;
  }

  // Build the frontend URL from Metro's provided devtoolsFrontendUrl
  // Metro /json/list returns: { devtoolsFrontendUrl: "/debugger-frontend/rn_fusebox.html?ws=...", ... }
  let frontendUrl;
  if (target.devtoolsFrontendUrl) {
    // Metro provides the exact path — use it
    frontendUrl = `http://localhost:${PORTS.METRO}${target.devtoolsFrontendUrl}`;
  } else if (target.webSocketDebuggerUrl) {
    // Fallback: construct URL manually with rn_fusebox (RN 0.76+) or rn_inspector (older)
    const wsUrl = target.webSocketDebuggerUrl;
    frontendUrl = `http://localhost:${PORTS.METRO}/debugger-frontend/rn_fusebox.html?ws=${encodeURIComponent(wsUrl)}&sources.hide_add_folder=true`;
  } else {
    console.warn('[CDP] No usable target URL');
    return;
  }

  const titleSuffix = target.deviceName ? ` — ${target.deviceName}` : '';
  devtoolsWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0b0e',
    title: `JS Debugger${titleSuffix}`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  console.log(`[CDP] Loading DevTools: ${frontendUrl}`);
  devtoolsWindow.loadURL(frontendUrl);

  devtoolsWindow.on('closed', () => { devtoolsWindow = null; });
}

// ─── Metro CDP — fetch targets on demand (no continuous polling) ──────────────
// Continuous polling causes Metro's dev-middleware WebSocket to crash with
// "readyState 3 (CLOSED)" when connections are opened/closed rapidly.
// Instead, we fetch targets only when the user needs them.
function fetchCDPTargets(callback) {
  http.get(`http://localhost:${PORTS.METRO}/json/list`, (res) => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => {
      try {
        const targets = JSON.parse(data);
        const rnTargets = targets.filter(t =>
          t.type === 'node' || t.devtoolsFrontendUrl
        );
        lastKnownTargets = rnTargets;
        _send('cdp-targets', rnTargets);
        if (callback) callback(rnTargets);
      } catch (_) {
        if (callback) callback([]);
      }
    });
  }).on('error', () => {
    lastKnownTargets = [];
    _send('cdp-targets', []);
    if (callback) callback([]);
  });
}

function setupMetroCDPProxy() {
  // Single fetch after app starts (not continuous polling)
  setTimeout(() => fetchCDPTargets(), 3000);
}

// ─── React DevTools Relay Server (Component Tree + Profiler) ─────────────────
// React Native automatically connects to ws://localhost:8097 in dev mode.
// We run a simple WS relay on that port. When a standalone react-devtools
// window connects (via `npx react-devtools`) or when the RN app connects,
// we track the connection and relay messages between frontend ↔ backend.
let reactDTServer = null;
let reactDTClients = new Set();

function startReactDevToolsServer() {
  try {
    reactDTServer = new WebSocketServer({ port: PORTS.REACT_DT });
    reactDTServer.on('error', (err) => {
      console.warn(`[ReactDT] Server error: ${err.message}`);
      if (err.code === 'EADDRINUSE') {
        _send('react-dt-status', false);
      }
    });
    reactDTServer.on('connection', (ws) => {
      reactDTClients.add(ws);
      console.log(`[ReactDT] Client connected (total: ${reactDTClients.size})`);
      _send('react-dt-status', true);

      // Relay messages between all connected clients (frontend ↔ backend)
      ws.on('message', (data) => {
        reactDTClients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(data);
          }
        });
      });

      ws.on('error', (err) => {
        console.warn(`[ReactDT] Client error:`, err.message);
      });

      ws.on('close', () => {
        reactDTClients.delete(ws);
        console.log(`[ReactDT] Client disconnected (total: ${reactDTClients.size})`);
        if (reactDTClients.size === 0) {
          _send('react-dt-status', false);
        }
      });
    });
    console.log(`[ReactDT] Relay server on :${PORTS.REACT_DT}`);
  } catch (e) {
    console.warn('[ReactDT] Failed to start relay server:', e.message);
  }
}

// ─── Bridge Servers (Redux, Storage, Network) ─────────────────────────────────
function startBridgeServers() {
  // Redux Bridge
  startBridge(PORTS.REDUX_BRIDGE, 'redux', reduxClients, (event) => {
    // console.log('[REDUX-DEBUG] Event from SDK:', event?.type, event?.action?.type);
    _send('redux-event', event);
  });

  // AsyncStorage Bridge
  startBridge(PORTS.STORAGE_BRIDGE, 'storage', storageClients, (event) => {
    _send('storage-event', event);
  });

  // Network + Console + Perf Bridge (port 9092 carries all types from RNDebugSDK)
  startBridge(PORTS.NETWORK_BRIDGE, 'network', networkClients, (event) => {
    if (event.type === 'control') return;
    if (event.type === 'console') {
      _send('console-event', event);
    } else if (event.type === 'perf') {
      _send('perf-event', event);
    } else if (event.type === 'ga4') {
      _send('ga4-event', event);
    } else {
      _send('network-event', event);
    }
  });
}

function startBridge(port, name, clients, onEvent) {
  try {
    const wss = new WebSocketServer({ port });
    _bridgeServers.push(wss);
    wss.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[${name}] Port ${port} is already in use — another ReactoRadar or debugger may be running.`);
        const { dialog } = require('electron');
        dialog.showErrorBox(
          `Port ${port} is in use`,
          `ReactoRadar cannot start the ${name} bridge because port ${port} is already occupied.\n\nThis usually means an older version of ReactoRadar is still running.\n\nTo fix this, run the following in your terminal:\n  kill $(lsof -ti :${port})\n\nThen restart ReactoRadar.`
        );
      }
    });
    wss.on('connection', (ws) => {
      clients.add(ws);
      console.log(`[${name}] RN app connected`);
      _send(`${name}-connected`, true);

      ws.on('message', (raw) => {
        try {
          const event = JSON.parse(raw.toString());
          onEvent(event);
        } catch (e) {
          console.warn(`[${name}] Failed to parse message:`, e.message);
        }
      });

      ws.on('error', (err) => {
        console.warn(`[${name}] Client error:`, err.message);
      });

      ws.on('close', () => {
        clients.delete(ws);
        if (clients.size === 0) {
          _send(`${name}-connected`, false);
          // When every bridge has zero clients, tell the renderer to clear old data
          if (reduxClients.size === 0 && storageClients.size === 0 && networkClients.size === 0) {
            console.log('[Bridge] All device connections closed — sending clear signal');
            _send('device-all-disconnected');
          }
        }
      });
    });
    console.log(`[${name}] Bridge on :${port}`);
  } catch (e) {
    console.error(`[${name}] Failed to start bridge on port ${port}:`, e.message);
  }
}

// ─── IPC from Renderer ────────────────────────────────────────────────────────
function setupIPC() {
  ipcMain.on('open-cdp-target', (_, wsUrl) => {
    // Always fetch fresh targets, then open
    fetchCDPTargets((targets) => {
      if (wsUrl && targets.length > 0) {
        const target = targets.find(t => t.webSocketDebuggerUrl === wsUrl) || targets[0];
        openCDPWindow(target);
      } else if (targets.length > 0) {
        const target = targets.find(t =>
          t.reactNative?.capabilities?.prefersFuseboxFrontend
        ) || targets[0];
        openCDPWindow(target);
      }
    });
  });

  ipcMain.on('open-react-devtools', () => {
    // Start the relay server if not already running
    if (!reactDTServer) startReactDevToolsServer();
    // Launch standalone react-devtools via npx in a background process
    try {
      const { spawn } = require('child_process');
      const env = { ...process.env };
      // Remove ELECTRON_RUN_AS_NODE to prevent npx from running in Electron's Node
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn('npx', ['react-devtools'], {
        stdio: 'ignore',
        detached: true,
        env,
      });
      child.unref();
      console.log('[ReactDevTools] Launched standalone react-devtools');
      _send('react-dt-status', 'launched');
    } catch (e) {
      console.error('[ReactDevTools] Failed to launch:', e.message);
      // Fallback: show instructions in a dialog
      const { dialog } = require('electron');
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'React DevTools',
        message: 'Could not launch React DevTools automatically.',
        detail: 'Run this command in your terminal:\n\nnpx react-devtools\n\nIt will connect to your app on port 8097.',
        buttons: ['OK'],
      });
    }
  });

  // clear-all is handled by renderer via clear-all-ui IPC from menu

  ipcMain.on('set-metro-port', (_, port) => {
    const p = parseInt(port);
    if (isNaN(p) || p < 1024 || p > 65535) return;
    PORTS.METRO = p;
    fetchCDPTargets();
    _send('ports', PORTS);
  });

  ipcMain.on('set-network-capture', (_, enabled) => {
    // Broadcast to connected RN apps so they can stop/start intercepting
    networkClients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'control', action: 'set-network-capture', enabled }));
      }
    });
  });

  // Track the RN project root — detected from Metro or setup
  let _rnProjectRoot = null;

  ipcMain.handle('read-source-file', async (_, filepath) => {
    const fs = require('fs');
    try {
      // Try absolute path first
      if (path.isAbsolute(filepath) && fs.existsSync(filepath)) {
        return fs.readFileSync(filepath, 'utf8');
      }

      // Find the RN project root by checking where Metro is running
      if (!_rnProjectRoot) {
        // Look for common project paths
        const candidates = [];
        // Check Metro's cwd by looking at the source map paths
        const home = process.env.HOME || '';
        // Scan for directories containing package.json with react-native
        // Dynamically find RN project directories
        const searchDirs = [];
        // Scan home directory for common RN project patterns
        try {
          const homeItems = require('fs').readdirSync(home);
          homeItems.forEach(dir => {
            const full = path.join(home, dir);
            try {
              const sub = require('fs').readdirSync(full);
              sub.forEach(s => {
                const projDir = path.join(full, s);
                if (require('fs').existsSync(path.join(projDir, 'package.json')) &&
                    require('fs').existsSync(path.join(projDir, 'node_modules', 'react-native'))) {
                  searchDirs.push(projDir);
                }
                // One level deeper (e.g., ~/Company/branch/project)
                try {
                  require('fs').readdirSync(projDir).forEach(ss => {
                    const deep = path.join(projDir, ss);
                    if (require('fs').existsSync(path.join(deep, 'package.json')) &&
                        require('fs').existsSync(path.join(deep, 'node_modules', 'react-native'))) {
                      searchDirs.push(deep);
                    }
                  });
                } catch {}
              });
            } catch {}
          });
        } catch {}
        // Also try to detect from Metro's /json endpoint
        try {
          const result = require('child_process').execSync(
            `lsof -i :${PORTS.METRO} -t 2>/dev/null | head -1 | xargs -I{} lsof -p {} -Fn 2>/dev/null | grep '^n/' | grep 'node_modules' | head -1 | sed 's|^n||;s|/node_modules.*||'`,
            { encoding: 'utf8', timeout: 3000 }
          ).trim();
          if (result && fs.existsSync(result)) candidates.unshift(result);
        } catch {}

        candidates.push(...searchDirs);
        for (const dir of candidates) {
          const full = path.join(dir, filepath);
          if (fs.existsSync(full)) {
            _rnProjectRoot = dir;
            break;
          }
        }
      }

      if (_rnProjectRoot) {
        const full = path.join(_rnProjectRoot, filepath);
        if (fs.existsSync(full)) return fs.readFileSync(full, 'utf8');
      }

      // Last resort: search recursively from home
      const homeSearch = path.join(process.env.HOME || '', filepath);
      if (fs.existsSync(homeSearch)) return fs.readFileSync(homeSearch, 'utf8');

      return null;
    } catch (e) {
      return null;
    }
  });

  ipcMain.on('set-stack-trace-capture', (_, enabled) => {
    networkClients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'control', action: 'set-stack-trace', enabled }));
      }
    });
  });

  ipcMain.on('set-network-throttle', (_, profile) => {
    // Broadcast throttle config to connected RN apps
    networkClients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'control', action: 'set-throttle', profile }));
      }
    });
  });

  ipcMain.on('open-external', (_, url) => {
    if (url && typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      shell.openExternal(url);
    }
  });

  ipcMain.handle('fetch-changelog', async (_, version) => {
    if (!version || typeof version !== 'string' || !/^[\d]+\.[\d]+\.[\d]+/.test(version)) {
      return 'Invalid version.';
    }
    return new Promise((resolve) => {
      https.get(`https://api.github.com/repos/sharanagouda/reactoradar/releases/tags/v${version}`, {
        headers: { 'User-Agent': 'ReactoRadar', 'Accept': 'application/vnd.github.v3+json' }
      }, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try { resolve(JSON.parse(data).body || 'No release notes available.'); }
          catch { resolve('Could not fetch release notes.'); }
        });
      }).on('error', () => resolve('Could not connect to GitHub.'));
    });
  });

  // Fetch all releases for version history / rollback
  ipcMain.handle('fetch-releases', async () => {
    return new Promise((resolve) => {
      https.get('https://api.github.com/repos/sharanagouda/reactoradar/releases?per_page=20', {
        headers: { 'User-Agent': 'ReactoRadar', 'Accept': 'application/vnd.github.v3+json' }
      }, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const releases = JSON.parse(data);
            if (!Array.isArray(releases)) { resolve([]); return; }
            const mapped = [];
            for (const r of releases) {
              if (!r || typeof r !== 'object') continue;
              const tag = r.tag_name || '';
              const version = tag.replace(/^v/, '');
              if (!version) continue; // skip entries with no version
              const assets = Array.isArray(r.assets) ? r.assets : [];
              mapped.push({
                version,
                tag,
                name: r.name || tag || version,
                date: r.published_at || null,
                prerelease: !!r.prerelease,
                body: r.body || '',
                dmgUrl: (assets.find(a => a && a.name && a.name.endsWith('.dmg')) || {}).browser_download_url || '',
                zipUrl: (assets.find(a => a && a.name && a.name.endsWith('.zip')) || {}).browser_download_url || '',
                htmlUrl: r.html_url || '',
              });
            }
            resolve(mapped);
          } catch { resolve([]); }
        });
      }).on('error', () => resolve([]));
    });
  });

  ipcMain.on('install-update', () => {
    if (autoUpdater) {
      autoUpdater.quitAndInstall(false, true);
    }
  });

  ipcMain.on('capture-screenshot', async () => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const image = await mainWindow.webContents.capturePage();
      const png = image.toPNG();
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filePath = path.join(app.getPath('downloads'), `ReactoRadar-${ts}.png`);
      require('fs').writeFileSync(filePath, png);
      shell.showItemInFolder(filePath);
      console.log(`[Screenshot] Saved to ${filePath}`);
    } catch (e) {
      console.error('[Screenshot] Failed:', e.message);
    }
  });

  // ─── Native Log Streaming ──────────────────────────────────────────────────
  let _nativeLogProcess = null;

  // Auto-detect which native platform is available
  ipcMain.handle('detect-native-platform', () => {
    const { execSync } = require('child_process');
    function tryCmd(cmd) { try { return execSync(cmd, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'], timeout: 5000 }).trim(); } catch { return ''; } }

    const result = { android: false, iosSim: false, iosDevice: false, adbPath: false };

    // Check adb
    const adbCheck = tryCmd('which adb');
    result.adbPath = !!adbCheck;
    if (adbCheck) {
      const devices = tryCmd('adb devices');
      result.android = devices.includes('emulator') || /\b[A-Z0-9]{6,}\s+device\b/i.test(devices);
    }

    // Check iOS simulator
    const simCheck = tryCmd('xcrun simctl list devices booted 2>/dev/null');
    result.iosSim = simCheck.includes('Booted');

    // Check iOS device
    const idevice = tryCmd('idevice_id -l 2>/dev/null');
    result.iosDevice = !!(idevice && idevice.trim().length > 0);

    return result;
  });

  ipcMain.on('start-native-logs', (_, platform) => {
    // Kill existing process
    if (_nativeLogProcess) {
      try { _nativeLogProcess.kill('SIGTERM'); } catch {}
      _nativeLogProcess = null;
    }

    const { spawn } = require('child_process');
    let cmd, args;

    if (platform === 'android') {
      // adb logcat — show only new logs from now (not historical buffer)
      cmd = 'adb';
      // -T 1 = last 1 line then real-time. Include Firebase tags at Verbose level for GA4 event capture.
      args = ['logcat', '-v', 'threadtime', '-T', '1', 'FA:V', 'FA-SVC:V', 'FirebaseAnalytics:V', '*:W'];
    } else if (platform === 'ios-sim') {
      // Use macOS unified log to capture iOS simulator logs
      // processImagePath CONTAINS "CoreSimulator" filters to simulator processes only
      // Captures errors + Firebase/FIRAnalytics events (requires -FIRDebugEnabled in Xcode scheme)
      cmd = '/usr/bin/log';
      args = ['stream', '--style', 'syslog', '--predicate',
        'processImagePath CONTAINS "CoreSimulator" AND (messageType >= error OR composedMessage CONTAINS "firebase" OR composedMessage CONTAINS "FIRAnalytics" OR composedMessage CONTAINS "Logging event" OR composedMessage CONTAINS "GoogleAnalytics" OR composedMessage CONTAINS "[GA4]")'];
    } else if (platform === 'ios-device') {
      // idevicesyslog for real iOS device
      cmd = 'idevicesyslog';
      args = [];
    } else {
      _send('native-status', { connected: false, error: `Unknown platform: ${platform}` });
      return;
    }

    try {
      _nativeLogProcess = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      _send('native-status', { connected: true, platform });
      console.log(`[NativeLogs] Started ${cmd} ${args.join(' ')} (pid: ${_nativeLogProcess.pid})`);

      let buffer = '';
      _nativeLogProcess.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line
        lines.forEach(line => {
          if (!line.trim()) return;
          const parsed = _parseNativeLog(line, platform);
          if (parsed) _send('native-log', parsed);
        });
      });

      _nativeLogProcess.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) _send('native-log', { level: 'error', message: text, source: 'stderr', ts: Date.now() });
      });

      // Guard against stream errors (broken pipe, etc.)
      _nativeLogProcess.stdout.on('error', () => {});
      _nativeLogProcess.stderr.on('error', () => {});

      _nativeLogProcess.on('close', (code) => {
        _nativeLogProcess = null;
        _send('native-status', { connected: false, error: code ? `Process exited with code ${code}` : 'Disconnected' });
      });

      _nativeLogProcess.on('error', (err) => {
        _nativeLogProcess = null;
        _send('native-status', { connected: false, error: `Failed to start ${cmd}: ${err.message}. Is it installed?` });
      });

    } catch (e) {
      _send('native-status', { connected: false, error: e.message });
    }
  });

  ipcMain.on('stop-native-logs', () => {
    if (_nativeLogProcess) {
      try { _nativeLogProcess.kill(); } catch {}
      _nativeLogProcess = null;
      _send('native-status', { connected: false });
    }
  });

  // Clean up on quit
  app.on('before-quit', () => {
    if (_nativeLogProcess) { try { _nativeLogProcess.kill(); } catch {} }
  });

  // Firebase/GA tag detection for both Android and iOS
  const _firebaseTags = new Set(['FA', 'FA-SVC', 'FA:Application', 'FA:Service', 'FirebaseAnalytics', 'FIRAnalytics', 'firebase', 'google.analytics', 'AnalyticsService']);
  const _firebaseTagRe = /^(FA|FA-SVC|FA:Application|FA:Service|FirebaseAnalytics|FIRAnalytics|firebase|google\.analytics|AnalyticsService)/i;

  function _parseFirebaseEvent(message, tag) {
    if (!message) return null;
    // Android FA tag patterns:
    // "Logging event (FE): session_start(_s), Bundle[{...}]"
    // "Setting event parameter: engagement_time_msec = 1234"
    // "Screen exposed: main_screen"
    let m;
    if ((m = message.match(/Logging event\s*\(?(\w+)?\)?\s*:\s*(\S+?)(?:\((\w+)\))?\s*,?\s*Bundle\[\{(.*)\}\]/i))) {
      const params = {};
      // Parse "key=value, key=value" from Bundle
      if (m[4]) m[4].split(/,\s*/).forEach(p => { const [k, v] = p.split('='); if (k) params[k.trim()] = v ? v.trim() : ''; });
      return { eventName: m[2] || m[3] || 'unknown', source: m[1] || 'native', params };
    }
    if ((m = message.match(/Logging event\s*\(?(\w+)?\)?\s*:\s*(\S+)/i))) {
      return { eventName: m[2], source: m[1] || 'native', params: {} };
    }
    // iOS FIRAnalytics pattern: "Logging event: origin, name, params: { ... }"
    if ((m = message.match(/Logging event:\s*(\w+),\s*(\w+),\s*params:\s*(\{.*\})/i))) {
      let params = {};
      try { params = JSON.parse(m[3]); } catch {}
      return { eventName: m[2], source: m[1] || 'native', params };
    }
    return null;
  }

  function _parseNativeLog(line, platform) {
    if (platform === 'android') {
      // Android logcat format: "06-05 10:30:45.123  1234  5678 E TAG: message"
      const m = line.match(/^\d{2}-\d{2}\s+(\d{2}:\d{2}:\d{2})\.\d+\s+\d+\s+\d+\s+([VDIWEF])\s+([^:]+):\s*(.*)/);
      if (m) {
        const levelMap = { V: 'verbose', D: 'debug', I: 'info', W: 'warn', E: 'error', F: 'fatal' };
        const tag = m[3].trim();
        const parsed = { ts: Date.now(), time: m[1], level: levelMap[m[2]] || 'info', tag, message: m[4], raw: line };
        // Detect Firebase/GA events
        if (_firebaseTagRe.test(tag)) {
          parsed.firebase = true;
          const fe = _parseFirebaseEvent(m[4], tag);
          if (fe) parsed.firebaseEvent = fe;
        }
        return parsed;
      }
      return { ts: Date.now(), level: 'info', message: line, raw: line };
    }
    if (platform === 'ios-sim' || platform === 'ios-device') {
      // syslog style: "2026-06-05 10:30:45.123456+0530  localhost process[pid]: (subsystem) [category] <Level>: message"
      const m1 = line.match(/(\d{2}:\d{2}:\d{2})\.\d+[^\s]*\s+\S+\s+(\S+)\[\d+\].*?<(\w+)>:\s*(.*)/);
      if (m1) {
        const levelMap = { Notice: 'info', Info: 'info', Default: 'info', Debug: 'debug', Error: 'error', Fault: 'fatal' };
        const parsed = { ts: Date.now(), time: m1[1], level: levelMap[m1[3]] || 'info', tag: m1[2], message: m1[4], raw: line };
        if (_firebaseTagRe.test(m1[2]) || /FIRAnalytics|GoogleAnalytics|firebase/i.test(m1[4])) {
          parsed.firebase = true;
          const fe = _parseFirebaseEvent(m1[4], m1[2]);
          if (fe) parsed.firebaseEvent = fe;
        }
        return parsed;
      }
      // idevicesyslog format: "Jun  5 10:30:45 iPhone MyApp(libsystem)[123] <Error>: message"
      const m2 = line.match(/\w+\s+\d+\s+(\d{2}:\d{2}:\d{2})\s+\S+\s+(\S+?)[\[(].*?<(\w+)>:\s*(.*)/);
      if (m2) {
        const levelMap = { Notice: 'info', Info: 'info', Debug: 'debug', Warning: 'warn', Error: 'error', Critical: 'fatal' };
        const parsed = { ts: Date.now(), time: m2[1], level: levelMap[m2[3]] || 'info', tag: m2[2], message: m2[4], raw: line };
        if (_firebaseTagRe.test(m2[2]) || /FIRAnalytics|GoogleAnalytics|firebase/i.test(m2[4])) {
          parsed.firebase = true;
          const fe = _parseFirebaseEvent(m2[4], m2[2]);
          if (fe) parsed.firebaseEvent = fe;
        }
        return parsed;
      }
      // Fallback
      const timeMatch = line.match(/(\d{2}:\d{2}:\d{2})/);
      return { ts: Date.now(), time: timeMatch ? timeMatch[1] : '', level: 'info', message: line, raw: line };
    }
    return { ts: Date.now(), level: 'info', message: line, raw: line };
  }

  ipcMain.on('set-theme', (_, theme) => {
    nativeTheme.themeSource = theme === 'light' ? 'light' : 'dark';
    const bg = theme === 'light' ? '#f5f6f8' : '#0a0b0e';
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(bg);
    }
  });
}

// ─── macOS App Menu ───────────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Debugger',
      submenu: [
        {
          label: 'Open JS Debugger (CDP)',
          accelerator: 'Cmd+D',
          click: () => { _send('trigger-open-cdp'); },
        },
        {
          label: 'Open React DevTools',
          accelerator: 'Cmd+R',
          click: () => { ipcMain.emit('open-react-devtools'); },
        },
        { type: 'separator' },
        {
          label: 'Clear All',
          accelerator: 'Cmd+K',
          click: () => { _send('clear-all-ui'); },
        },
        { type: 'separator' },
        {
          label: 'Next Theme',
          accelerator: 'Cmd+Shift+T',
          click: () => {
            const themes = ['dark','light','monokai','dracula','solarized-dark','solarized-light','nord','github-dark','one-dark'];
            const current = nativeTheme.themeSource || 'dark';
            const idx = themes.indexOf(current);
            const next = themes[(idx + 1) % themes.length];
            nativeTheme.themeSource = next.includes('light') ? 'light' : 'dark';
            if (mainWindow && !mainWindow.isDestroyed()) {
              _send('theme-changed', next);
            }
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find',
          accelerator: 'Cmd+F',
          click: () => { _send('focus-search'); },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
