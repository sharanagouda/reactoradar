/**
 * RNDebugSDK.js
 * Place in: src/debug/RNDebugSDK.js
 *
 * Usage in index.js (MUST be the very first import):
 *   if (__DEV__) require('./src/debug/RNDebugSDK');
 *
 * For Redux, use the exported enhancer:
 *   import { reduxEnhancer } from './src/debug/RNDebugSDK';
 *   const store = configureStore({ ..., enhancers: [reduxEnhancer] });
 *
 * For AsyncStorage monitoring, wrap your AsyncStorage calls:
 *   import { watchAsyncStorage } from './src/debug/RNDebugSDK';
 *   watchAsyncStorage(); // call once early in app
 */

if (typeof __DEV__ === 'undefined' || !__DEV__) {
  module.exports = { reduxEnhancer: x => x, reduxMiddleware: () => next => action => next(action), watchAsyncStorage: () => {} };
} else {

// ─── Config ───────────────────────────────────────────────────────────────────
// Auto-detect platform: Android emulator → 10.0.2.2  |  iOS sim → 127.0.0.1
// For real devices: Android uses adb reverse (so 10.0.2.2 works via port forwarding),
// iOS real device needs the Mac's LAN IP — override HOST_OVERRIDE below if needed.
const HOST_OVERRIDE = null; // Set to your Mac's LAN IP for iOS real device, e.g. '192.168.1.100'

function _detectHost() {
  if (HOST_OVERRIDE) return HOST_OVERRIDE;
  try {
    const { Platform } = require('react-native');
    if (Platform.OS === 'android') return '10.0.2.2';
    return '127.0.0.1'; // iOS simulator
  } catch { return '127.0.0.1'; }
}
const HOST = _detectHost();

const PORTS = {
  NETWORK_AND_CONSOLE: 9092, // unified feed for network + console
  REDUX:               9090, // Redux state + actions
  STORAGE:             9091, // AsyncStorage snapshots
};

// ─── Feature Flags (can be toggled by debugger app) ──────────────────────────
let _networkCaptureEnabled = true;
let _stackTraceEnabled = false; // Disabled by default for performance
let _throttleProfile = 'none'; // 'none', 'fast3g', 'slow3g', 'offline'
const THROTTLE_DELAYS = { none: 0, fast3g: 500, slow3g: 2000, offline: -1 };

// ─── SDK Pause/Resume (allows inspector to work without SDK interference) ────
// When paused, console/fetch/XHR interception is disabled so the RN inspector
// and CDP debugger can work without conflicts. Controlled via the debugger app.
let _sdkPaused = false;

function _isSDKActive() {
  return !_sdkPaused;
}

// ─── Debugger Detection ──────────────────────────────────────────────────────
// Detect if a CDP debugger (Chrome DevTools / Hermes inspector) is attached.
// When detected, we back off our patches to avoid conflicts with the inspector.
let _debuggerDetected = false;
let _debuggerCheckInterval = null;

function _checkDebuggerAttached() {
  // Method 1: Check if Hermes debugger globals are set (only when actively connected)
  const hermesDebugger = !!(global.__DEBUGGER_CONNECTED__ || global.__HERMES_DEBUGGER_CONNECTED__);
  // Method 2: Check React DevTools hook for active debugger session
  const rdtHook = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const rdtDebugger = !!(rdtHook && rdtHook._debuggerAttached);
  // Note: global.__inspector and global.__inspectorGlobalObject are always present
  // on Hermes as part of the built-in inspector infrastructure. They do NOT indicate
  // that a debugger is actively connected. Only check explicit connection flags.

  const wasDetected = _debuggerDetected;
  _debuggerDetected = hermesDebugger || rdtDebugger;

  if (_debuggerDetected && !wasDetected) {
    _console.log('[RNDebugSDK] Debugger detected — SDK interception paused to avoid inspector conflicts. Use the ReactoRadar app to resume.');
  } else if (!_debuggerDetected && wasDetected) {
    _console.log('[RNDebugSDK] Debugger disconnected — SDK interception resumed.');
  }
}

// Check periodically (every 3s) — lightweight, no performance impact
_debuggerCheckInterval = setInterval(_checkDebuggerAttached, 3000);
// Also check once immediately after a short delay (debugger may attach during startup)
setTimeout(_checkDebuggerAttached, 1000);

function _shouldIntercept() {
  return _isSDKActive() && !_debuggerDetected;
}

// ─── WebSocket Factory ────────────────────────────────────────────────────────
function makeChannel(port, name, onMessage) {
  let ws = null, queue = [], connected = false, retryDelay = 2000;

  function connect() {
    ws = null;
    connected = false;
    try {
      ws = new WebSocket(`ws://${HOST}:${port}`);
      ws.onopen = () => {
        connected = true;
        retryDelay = 2000;
        const pending = queue.splice(0);
        for (const m of pending) {
          try { if (ws.readyState === WebSocket.OPEN) ws.send(m); else { queue.push(m); break; } }
          catch { queue.push(m); break; }
        }
      };
      ws.onmessage = (evt) => {
        if (onMessage) {
          try { onMessage(JSON.parse(evt.data)); } catch {}
        }
      };
      ws.onclose = () => { connected = false; setTimeout(connect, retryDelay); retryDelay = Math.min(retryDelay * 1.5, 30000); };
      ws.onerror = () => {};
    } catch { setTimeout(connect, retryDelay); retryDelay = Math.min(retryDelay * 1.5, 30000); }
  }

  function send(obj) {
    let msg;
    try {
      msg = JSON.stringify({ ...obj, ts: Date.now() }, (_, v) => typeof v === 'bigint' ? v.toString() : v);
    } catch { return; }
    if (connected && ws?.readyState === WebSocket.OPEN) { try { ws.send(msg); } catch {} }
    else { queue.push(msg); if (queue.length > 300) queue.shift(); }
  }

  connect();
  return { send };
}

// The main channel (console + network) listens for control messages from the debugger
const mainCh    = makeChannel(PORTS.NETWORK_AND_CONSOLE, 'main', (msg) => {
  if (msg.type === 'control') {
    if (msg.action === 'set-network-capture') _networkCaptureEnabled = !!msg.enabled;
    if (msg.action === 'set-throttle') _throttleProfile = msg.profile || 'none';
    if (msg.action === 'set-stack-trace') _stackTraceEnabled = !!msg.enabled;
    // Pause/Resume SDK interception (allows inspector to work)
    if (msg.action === 'pause-sdk') {
      _sdkPaused = true;
      _console.log('[RNDebugSDK] SDK paused — inspector/debugger can now inspect the app freely.');
      mainCh.send({ type: 'control', action: 'sdk-status', paused: true });
    }
    if (msg.action === 'resume-sdk') {
      _sdkPaused = false;
      _console.log('[RNDebugSDK] SDK resumed — interception re-enabled.');
      mainCh.send({ type: 'control', action: 'sdk-status', paused: false });
    }
    // Query current status
    if (msg.action === 'query-sdk-status') {
      mainCh.send({ type: 'control', action: 'sdk-status', paused: _sdkPaused, debuggerDetected: _debuggerDetected });
    }
  }
});
const reduxCh   = makeChannel(PORTS.REDUX,   'redux');
const storageCh = makeChannel(PORTS.STORAGE, 'storage');

// ─── Console Intercept ────────────────────────────────────────────────────────
function serializeArg(a) {
  if (a === null) return { t: 'null', v: null };
  if (a === undefined) return { t: 'undefined', v: undefined };
  if (typeof a === 'string') return { t: 'string', v: a };
  if (typeof a === 'number') return { t: 'number', v: a };
  if (typeof a === 'boolean') return { t: 'boolean', v: a };
  if (typeof a === 'symbol') return { t: 'string', v: a.toString() };
  if (typeof a === 'function') return { t: 'string', v: `[Function: ${a.name || 'anonymous'}]` };
  if (a instanceof Error) return { t: 'object', v: { name: a.name, message: a.message, stack: a.stack } };
  if (Array.isArray(a)) {
    try { const j = JSON.parse(JSON.stringify(a)); return { t: 'array', v: j }; }
    catch { return { t: 'string', v: String(a) }; }
  }
  if (typeof a === 'object') {
    try { const j = JSON.parse(JSON.stringify(a)); return { t: 'object', v: j }; }
    catch { return { t: 'string', v: String(a) }; }
  }
  return { t: 'string', v: String(a) };
}

const LEVELS = ['log','info','warn','error','debug'];
const _console = {};

// Pre-compiled regexes for stack parsing (avoid creating per call)
const _skipRe = /RNDebugSDK|apply \(native\)|call \(native\)|anonymous \(native\)|MessageQueue|__callFunction|__guard|callFunctionReturn|processTicksAndRejections/;
const _frameRe = /at\s+(.+?)(?:\s+\((.+?):(\d+):\d+\)|(?:\s+)?(.+?):(\d+):\d+)/;

function _extractCaller() {
  const stack = (new Error().stack || '').split('\n');
  for (let i = 2; i < Math.min(stack.length, 15); i++) {
    const frame = stack[i]?.trim() || '';
    if (!frame || _skipRe.test(frame)) continue;
    const m = frame.match(_frameRe);
    if (!m) continue;
    const fn = m[1] || '', src = m[2] || m[4] || '', ln = m[3] || m[5] || '';
    // Skip console internals and single-char minified names from Hermes
    if (/^console|^_console|^overrideMethod|^reactConsoleError|^anonymous$/.test(fn)) continue;
    if (fn.length <= 2) continue; // Skip minified single/double-char names like "a", "b", "Oa"
    // Real source file
    if (src && !src.includes('index.bundle') && /\.[jt]sx?$/.test(src)) {
      return `${src.split('/').pop()}:${ln}` + (fn.length > 2 ? ` (${fn})` : '');
    }
    // Named function from bundle — must be meaningful (3+ chars, starts with uppercase = component)
    if (fn.length >= 3 && fn !== 'Object' && fn !== 'Function') return fn;
  }
  return '';
}

LEVELS.forEach(level => {
  const orig = console[level];
  if (typeof orig !== 'function') return;
  _console[level] = orig.bind(console);
  console[level] = (...args) => {
    try { _console[level](...args); } catch {}
    try {
      // Skip interception when SDK is paused or debugger is attached
      // This prevents double-logging and message queue deadlocks with CDP
      if (!_shouldIntercept()) return;
      const structuredArgs = args.map(serializeArg);
      const message = args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a, null, 2); } catch { return String(a); }
      }).join(' ');
      // Stack trace capture controlled by toggle (disabled by default for performance)
      // When enabled: captures for all levels. When disabled: skips entirely.
      const caller = _stackTraceEnabled ? _extractCaller() : '';
      mainCh.send({ type: 'console', level, message, args: structuredArgs, caller });
    } catch {} // end of interception try
  };
});

// ─── Header Flattener (ensures all values are strings) ───────────────────────
function _flattenHeaders(h) {
  if (!h) return {};
  const flat = {};
  try {
    // Handle Headers object (has forEach)
    if (typeof h.forEach === 'function') {
      h.forEach((v, k) => { flat[k] = String(v); });
      return flat;
    }
    // Handle plain object — stringify nested objects
    if (typeof h === 'object') {
      Object.entries(h).forEach(([k, v]) => {
        if (v == null) return;
        flat[k] = (typeof v === 'object') ? JSON.stringify(v) : String(v);
      });
      return flat;
    }
  } catch {}
  return flat;
}

// ─── Fetch Intercept ─────────────────────────────────────────────────────────
const _fetch = global.fetch;
global.fetch = async (input, init = {}) => {
  // When SDK is paused or debugger is attached, pass through without interception
  // This prevents racing with CDP's own Fetch.enable domain
  if (!_shouldIntercept()) return _fetch(input, init);

  // Throttle: simulate slow network or offline
  const delay = THROTTLE_DELAYS[_throttleProfile] || 0;
  if (delay === -1) return Promise.reject(new TypeError('Network request failed (offline throttle)'));
  if (delay > 0) await new Promise(r => setTimeout(r, delay));

  if (!_networkCaptureEnabled) return _fetch(input, init);

  const url   = typeof input === 'string' ? input : input?.url || '';
  const method = (init.method || 'GET').toUpperCase();
  const id    = `f-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;

  mainCh.send({ type: 'network', phase: 'request', id, url, method,
    requestHeaders: _flattenHeaders(init.headers), requestBody: init.body || null });

  const t0 = Date.now();
  try {
    const resp = await _fetch(input, init);
    try {
      const contentType = resp.headers?.get?.('content-type') || '';
      const contentLen = parseInt(resp.headers?.get?.('content-length') || '0', 10);
      if (contentLen > 1_000_000 || /image|video|audio|octet-stream|font/i.test(contentType)) {
        const rHeaders = {};
        resp.headers?.forEach?.((v, k) => { rHeaders[k] = v; });
        mainCh.send({ type: 'network', phase: 'response', id, url: String(typeof input === 'string' ? input : input?.url || ''),
          method, status: resp.status, statusText: resp.statusText, duration: Date.now() - t0,
          responseHeaders: rHeaders, responseBody: `[Binary ${contentType} — ${contentLen} bytes]` });
      } else {
        try {
          const clone = resp.clone();
          clone.text().then(body => {
            if (!_networkCaptureEnabled) return;
            let parsed = body;
            try { parsed = JSON.parse(body); } catch {}
            const rHeaders = {};
            clone.headers?.forEach?.((v, k) => { rHeaders[k] = v; });
            mainCh.send({ type: 'network', phase: 'response', id, url, method,
              status: resp.status, statusText: resp.statusText,
              duration: Date.now() - t0, responseHeaders: rHeaders, responseBody: parsed });
          }).catch(() => {});
        } catch {} // clone failed — skip capture
      }
    } catch {} // header access failed
    return resp;
  } catch (err) {
    mainCh.send({ type: 'network', phase: 'error', id, url, method,
      duration: Date.now() - t0, error: err?.message || String(err) });
    throw err;
  }
};

// ─── Network Intercept via XHR readystatechange (RN 0.81 compatible) ─────────
// RN 0.81 + Reactotron both fight over XMLHttpRequest.prototype. Instead of
// patching prototype methods (which get overwritten), we use a non-invasive
// approach: wrap XMLHttpRequest constructor to add a readystatechange listener
// on every NEW instance. This works regardless of who patches the prototype.
(function setupXHRNetworkCapture() {
  const _xhrTracker = new WeakMap();

  function wrapXHR() {
    const OrigXHR = global.XMLHttpRequest;
    if (!OrigXHR || OrigXHR.__dbgWrapped) return;

    function WrappedXHR() {
      const xhr = new OrigXHR();
      const meta = { id: `x-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, method: 'GET', url: '', t0: 0, headers: {}, sent: false };
      _xhrTracker.set(xhr, meta);

      // Wrap open
      const _open = xhr.open.bind(xhr);
      xhr.open = function(method, url) {
        meta.method = (method || 'GET').toUpperCase();
        meta.url = String(url);
        meta.t0 = Date.now();
        meta.sent = false;
        return _open.apply(xhr, arguments);
      };

      // Wrap setRequestHeader
      const _setHeader = xhr.setRequestHeader.bind(xhr);
      xhr.setRequestHeader = function(key, value) {
        meta.headers[key] = value;
        return _setHeader.apply(xhr, arguments);
      };

       // Wrap send
       const _send = xhr.send.bind(xhr);
       xhr.send = function(body) {
         if (_shouldIntercept() && _networkCaptureEnabled && !meta.sent) {
           meta.sent = true;
           let reqBody = null;
           if (body != null) {
             try { reqBody = typeof body === 'string' ? body : JSON.parse(JSON.stringify(body)); } catch { reqBody = String(body); }
           }
           mainCh.send({ type: 'network', phase: 'request', id: meta.id, url: meta.url,
             method: meta.method, requestHeaders: meta.headers, requestBody: reqBody });
         }
         return _send.apply(xhr, arguments);
       };

      // Listen for completion
       xhr.addEventListener('readystatechange', function() {
         if (xhr.readyState !== 4 || !meta.sent || !_shouldIntercept() || !_networkCaptureEnabled) return;
        try {
          const duration = Date.now() - meta.t0;
          if (xhr.status > 0) {
            // Safely read response body — responseText throws if responseType is blob/arraybuffer
            let respBody = null;
            const rType = xhr.responseType || '';
            if (rType === '' || rType === 'text') {
              try { respBody = xhr.responseText || ''; } catch { respBody = ''; }
              try { respBody = JSON.parse(respBody); } catch {}
            } else if (rType === 'json') {
              respBody = xhr.response;
            } else {
              // blob, arraybuffer, document — can't serialize, show type info
              respBody = `[${rType} response — ${xhr.response?.size || xhr.response?.byteLength || '?'} bytes]`;
            }
            const respHeaders = {};
            try {
              const raw = xhr.getAllResponseHeaders() || '';
              raw.split('\r\n').forEach(line => {
                const idx = line.indexOf(':');
                if (idx > 0) respHeaders[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
              });
            } catch {}
            mainCh.send({ type: 'network', phase: 'response', id: meta.id, url: meta.url,
              method: meta.method, status: xhr.status, statusText: xhr.statusText,
              duration, responseHeaders: respHeaders, responseBody: respBody });
          } else {
            mainCh.send({ type: 'network', phase: 'error', id: meta.id, url: meta.url,
              method: meta.method, duration: Date.now() - meta.t0, error: 'Request failed (status 0)' });
          }
        } catch (e) {
          // Safety net — never let our interceptor crash the app
          mainCh.send({ type: 'network', phase: 'response', id: meta.id, url: meta.url,
            method: meta.method, status: xhr.status || 0, duration: Date.now() - meta.t0,
            responseBody: `[Error reading response: ${e.message}]` });
        }
      });

      return xhr;
    }

    // Copy static properties and prototype
    WrappedXHR.prototype = OrigXHR.prototype;
    WrappedXHR.UNSENT = 0;
    WrappedXHR.OPENED = 1;
    WrappedXHR.HEADERS_RECEIVED = 2;
    WrappedXHR.LOADING = 3;
    WrappedXHR.DONE = 4;
    WrappedXHR.__dbgWrapped = true;
    // Keep reference to original for Reactotron etc
    WrappedXHR.__original = OrigXHR;

    global.XMLHttpRequest = WrappedXHR;
    _console.log('[RNDebugSDK] XHR constructor wrapped for network capture');
  }

   // Wrap immediately if available
   if (global.XMLHttpRequest) wrapXHR();
})();

// ─── Image / Pixel Tracking Interceptor ──────────────────────────────────────
// Captures tracking pixels loaded via new Image().src = url
(function wrapImage() {
  if (!global.Image) return;
  const OrigImage = global.Image;
  global.Image = function(w, h) {
    const img = new OrigImage(w, h);
    const origSrcDesc = Object.getOwnPropertyDescriptor(OrigImage.prototype, 'src') ||
                        Object.getOwnPropertyDescriptor(HTMLImageElement?.prototype || {}, 'src');

    // In React Native, Image may not have a standard src setter — use a Proxy-like approach
    let _src = '';
    try {
      Object.defineProperty(img, 'src', {
        get() { return _src; },
        set(url) {
          _src = url;
          if (_shouldIntercept() && _networkCaptureEnabled && url) {
            const id = `img_${_reqId++}`;
            const t0 = Date.now();
            try {
              const u = typeof url === 'string' ? url : String(url);
              mainCh.send({ type: 'network', phase: 'request', id, url: u, method: 'GET',
                requestHeaders: {}, requestBody: null, ts: t0, initiator: 'Image' });
              // Report as completed after a brief delay (pixel loads are fire-and-forget)
              setTimeout(() => {
                mainCh.send({ type: 'network', phase: 'response', id, url: u, method: 'GET',
                  status: 200, statusText: 'OK', duration: Date.now() - t0,
                  responseHeaders: { 'content-type': 'image/gif' },
                  responseBody: '[Tracking Pixel]', ts: t0 });
              }, 100);
            } catch {}
          }
          // Call original setter if it exists
          if (origSrcDesc && origSrcDesc.set) { origSrcDesc.set.call(img, url); }
          else { try { OrigImage.prototype.__lookupSetter__?.('src')?.call(img, url); } catch {} }
        },
        configurable: true, enumerable: true
      });
    } catch {} // If defineProperty fails, Image tracking is skipped silently
    return img;
  };
  global.Image.prototype = OrigImage.prototype;
  Object.defineProperty(global.Image, 'name', { value: 'Image' });
})();

// ─── sendBeacon Interceptor ──────────────────────────────────────────────────
// Captures navigator.sendBeacon calls (used for analytics/tracking)
if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
  const _origBeacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = function(url, data) {
    if (_shouldIntercept() && _networkCaptureEnabled && url) {
      const id = `beacon_${_reqId++}`;
      const t0 = Date.now();
      try {
        const u = typeof url === 'string' ? url : String(url);
        mainCh.send({ type: 'network', phase: 'request', id, url: u, method: 'POST',
          requestHeaders: { 'content-type': 'text/plain' },
          requestBody: data ? (typeof data === 'string' ? data : '[Beacon Data]') : null, ts: t0, initiator: 'sendBeacon' });
        mainCh.send({ type: 'network', phase: 'response', id, url: u, method: 'POST',
          status: 200, statusText: 'OK', duration: 0,
          responseHeaders: {}, responseBody: '[Beacon Sent]', ts: t0 });
      } catch {}
    }
    return _origBeacon(url, data);
  };
}

// ─── Axios Interceptor (belt-and-suspenders with XHR patch) ──────────────────
// Patches axios.create after a tick so import hoisting has resolved.
setTimeout(() => {
  try {
    const axios = require('axios');
    if (!axios || axios.__dbgPatched) return;
    axios.__dbgPatched = true;

    function addDbgInterceptors(instance) {
      if (!instance || !instance.interceptors || instance.__dbgInt) return;
      instance.__dbgInt = true;
       instance.interceptors.request.use(config => {
         if (!_shouldIntercept() || !_networkCaptureEnabled) return config;
        const id = `ax-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
        config._dbgId = id;
        config._dbgT0 = Date.now();
        const url = config.baseURL
          ? config.baseURL.replace(/\/+$/, '') + '/' + (config.url || '').replace(/^\/+/, '')
          : (config.url || '');
        const h = _flattenHeaders(typeof config.headers?.toJSON === 'function' ? config.headers.toJSON() : config.headers);
        let body = null;
        if (config.data != null) { try { body = typeof config.data === 'string' ? config.data : JSON.parse(JSON.stringify(config.data)); } catch { body = String(config.data); } }
        mainCh.send({ type:'network', phase:'request', id, url, method:(config.method||'GET').toUpperCase(), requestHeaders:h, requestBody:body });
        return config;
      }, e => Promise.reject(e));
       instance.interceptors.response.use(resp => {
         if (!_shouldIntercept() || !_networkCaptureEnabled) return resp;
         const c = resp.config || {};
         if (!c._dbgId) return resp;
        const url = c.baseURL ? c.baseURL.replace(/\/+$/,'') + '/' + (c.url||'').replace(/^\/+/,'') : (c.url||'');
        const dur = c._dbgT0 ? Date.now() - c._dbgT0 : 0;
        const rh = {};
        try { const h = typeof resp.headers?.toJSON === 'function' ? resp.headers.toJSON() : resp.headers;
          if (h) Object.entries(h).forEach(([k,v]) => { if (typeof v === 'string') rh[k] = v; }); } catch {}
        let body = resp.data;
        if (body && typeof body === 'object') { try { body = JSON.parse(JSON.stringify(body)); } catch {} }
        mainCh.send({ type:'network', phase:'response', id:c._dbgId, url, method:(c.method||'GET').toUpperCase(),
          status:resp.status, statusText:resp.statusText, duration:dur, responseHeaders:rh, responseBody:body });
        return resp;
       }, err => {
         if (!_shouldIntercept() || !_networkCaptureEnabled) return Promise.reject(err);
         const c = err?.config || {};
         if (c._dbgId) {
          const url = c.baseURL ? c.baseURL.replace(/\/+$/,'') + '/' + (c.url||'').replace(/^\/+/,'') : (c.url||'');
          const dur = c._dbgT0 ? Date.now() - c._dbgT0 : 0;
          const r = err?.response;
          if (r) { let b = r.data; if (b && typeof b === 'object') { try { b = JSON.parse(JSON.stringify(b)); } catch {} }
            mainCh.send({ type:'network', phase:'response', id:c._dbgId, url, method:(c.method||'GET').toUpperCase(), status:r.status, statusText:r.statusText, duration:dur, responseBody:b });
          } else { mainCh.send({ type:'network', phase:'error', id:c._dbgId, url, method:(c.method||'GET').toUpperCase(), duration:dur, error:err?.message||String(err) }); }
        }
        return Promise.reject(err);
      });
    }

    addDbgInterceptors(axios);
    const _create = axios.create.bind(axios);
    axios.create = function(...args) {
      const inst = _create(...args);
      addDbgInterceptors(inst);
      return inst;
    };
    _console.log('[RNDebugSDK] Axios interceptor active (global + create)');
  } catch {}
}, 0);

// ─── Redux Enhancer ──────────────────────────────────────────────────────────
function reduxEnhancer(createStore) {
  return (reducer, preloadedState, enhancer) => {
    const store = createStore(reducer, preloadedState, enhancer);
    let actionCount = 0;

    // Send initial state
    try {
      const initState = store.getState();
      let safeInit;
      try {
        const s = JSON.stringify(initState, (_, v) => typeof v === 'bigint' ? v.toString() : v);
        safeInit = s.length > 1_000_000 ? { __truncated: true, sizeBytes: s.length, keys: Object.keys(initState) } : JSON.parse(s);
      } catch { safeInit = { __error: 'State not serializable' }; }
      reduxCh.send({ type: 'redux', action: { type: '@@INIT' }, nextState: safeInit, index: actionCount++ });
    } catch {}

    const origDispatch = store.dispatch;
    store.dispatch = (action) => {
      const result = origDispatch(action);
      try {
        const nextState = store.getState();
        const safeAction = typeof action === 'function'
          ? { type: `[Function: ${action.name || 'thunk'}]` }
          : (action || { type: '@@UNKNOWN' });
        let safeState;
        try {
          const s = JSON.stringify(nextState, (_, v) => typeof v === 'bigint' ? v.toString() : v);
          safeState = s.length > 1_000_000
            ? { __truncated: true, sizeBytes: s.length, keys: Object.keys(nextState) }
            : JSON.parse(s);
        } catch { safeState = { __error: 'State not serializable' }; }
        reduxCh.send({ type: 'redux', action: safeAction, nextState: safeState, index: actionCount++ });
      } catch {}
      return result;
    };
    return store;
  };
}

// ─── Redux Toolkit middleware (alternative) ───────────────────────────────────
// If you use RTK configureStore, add this to middleware array instead:
let _mwActionCount = 0;
const reduxMiddleware = store => next => action => {
  const result = next(action);
  try {
    const nextState = store.getState();
    const safeAction = typeof action === 'function'
      ? { type: `[Function: ${action.name || 'thunk'}]` }
      : (action || { type: '@@UNKNOWN' });
    let safeState;
    try {
      const s = JSON.stringify(nextState, (_, v) => typeof v === 'bigint' ? v.toString() : v);
      safeState = s.length > 1_000_000
        ? { __truncated: true, sizeBytes: s.length, keys: Object.keys(nextState) }
        : JSON.parse(s);
    } catch { safeState = { __error: 'State not serializable' }; }
    reduxCh.send({ type: 'redux', action: safeAction, nextState: safeState, index: _mwActionCount++ });
  } catch {}
  return result;
};

// ─── AsyncStorage Monitor ─────────────────────────────────────────────────────
let _asyncStoragePatched = false;
function watchAsyncStorage() {
  if (_asyncStoragePatched) return; // Only patch once
  _asyncStoragePatched = true;
  try {
    const RNAsyncStorage = require('@react-native-async-storage/async-storage').default;
    if (!RNAsyncStorage) return;

    // Send full snapshot once on first connect
    RNAsyncStorage.getAllKeys().then(keys => {
      if (!keys?.length) return;
      RNAsyncStorage.multiGet(keys).then(pairs => {
        const snapshot = Object.fromEntries(pairs);
        storageCh.send({ type: 'storage', action: 'snapshot', key: snapshot });
      }).catch(() => {});
    }).catch(() => {});

    // Patch individual methods
    const _setItem = RNAsyncStorage.setItem.bind(RNAsyncStorage);
    RNAsyncStorage.setItem = async (key, value, ...rest) => {
      const result = await _setItem(key, value, ...rest);
      storageCh.send({ type: 'storage', action: 'set', key, value });
      return result;
    };

    const _removeItem = RNAsyncStorage.removeItem.bind(RNAsyncStorage);
    RNAsyncStorage.removeItem = async (key, ...rest) => {
      const result = await _removeItem(key, ...rest);
      storageCh.send({ type: 'storage', action: 'remove', key });
      return result;
    };

    const _mergeItem = RNAsyncStorage.mergeItem.bind(RNAsyncStorage);
    RNAsyncStorage.mergeItem = async (key, value, ...rest) => {
      const result = await _mergeItem(key, value, ...rest);
      // Read back merged value
      RNAsyncStorage.getItem(key).then(v => storageCh.send({ type: 'storage', action: 'set', key, value: v })).catch(() => {});
      return result;
    };

    const _clear = RNAsyncStorage.clear.bind(RNAsyncStorage);
    RNAsyncStorage.clear = async (...rest) => {
      const result = await _clear(...rest);
      storageCh.send({ type: 'storage', action: 'snapshot', key: {} });
      return result;
    };

    console.log('[RNDebugSDK] AsyncStorage monitoring active');
  } catch (e) {
    console.warn('[RNDebugSDK] AsyncStorage not available:', e.message);
  }
}

// ─── Fix: Guard against "Debug JS Remotely" crash on Hermes/New Arch ─────────
// RN 0.74+ with Hermes removed DevSettings.setIsDebuggingRemotely.
// Some packages (react-native-devsettings, etc.) still call it and crash.
// We patch it as a no-op to prevent the crash.
try {
  const { NativeModules } = require('react-native');
  const DevSettings = NativeModules?.DevSettings;
  if (DevSettings && typeof DevSettings.setIsDebuggingRemotely !== 'function') {
    DevSettings.setIsDebuggingRemotely = () => {
      _console.warn('[RNDebugSDK] "Debug JS Remotely" is not available on Hermes. Use "Open DevTools" instead — it will open in the ReactoRadar app.');
    };
  }
} catch {}

// ─── Performance + Memory Metrics ────────────────────────────────────────────
// Sends FPS, JS thread time, and memory stats every 2 seconds
(function startPerfMetrics() {
  let frameCount = 0;
  let lastTime = Date.now();

  // FPS counter using requestAnimationFrame
  function countFrame() {
    frameCount++;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(countFrame);
    }
  }
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(countFrame);
  }

  setInterval(() => {
    const now = Date.now();
    const elapsed = (now - lastTime) / 1000;
    const fps = elapsed > 0 ? Math.round(frameCount / elapsed) : 0;
    frameCount = 0;
    lastTime = now;

    const perfData = { type: 'perf', fps };

    // Hermes memory stats
    try {
      if (global.HermesInternal && typeof global.HermesInternal.getRuntimeProperties === 'function') {
        const props = global.HermesInternal.getRuntimeProperties();
        perfData.heapUsed = props['js_heapSize'] || 0;
        perfData.heapTotal = props['js_totalHeapSize'] || 0;
        perfData.native = props['js_nativeHeapSize'] || 0;
      }
    } catch {}

    // Try Performance API for thread timing
    try {
      if (global.performance && typeof global.performance.now === 'function') {
        perfData.jsThread = global.performance.now() % 16.67; // approximate frame time
      }
    } catch {}

    mainCh.send(perfData);
  }, 2000);
})();

// ─── GA4 / Firebase Analytics Interceptor ────────────────────────────────────
// Intercepts @react-native-firebase/analytics logEvent calls.
// The analytics() function returns a new instance each time, so we patch the
// PROTOTYPE of the analytics module class, not individual instances.
(function setupGA4Interceptor() {
  function patchAnalytics() {
    try {
      const analyticsModule = require('@react-native-firebase/analytics');
      if (!analyticsModule) return false;

      // Get the default export (the analytics factory function)
      const analyticsFn = analyticsModule.default || analyticsModule;
      if (typeof analyticsFn !== 'function') return false;

      // Create one instance to get access to its prototype
      const instance = analyticsFn();
      if (!instance || !instance.logEvent) return false;

      const proto = Object.getPrototypeOf(instance);
      if (!proto || proto.__reactoRadarPatched) return false;
      proto.__reactoRadarPatched = true;

      // Helper to safely serialize params
      function _safeParams(p) {
        if (!p || typeof p !== 'object') return p || {};
        try { return JSON.parse(JSON.stringify(p)); } catch { return {}; }
      }

      // Convert method name to event name: logAddToCart → add_to_cart
      function _methodToEvent(name) {
        // Remove 'log' prefix, then convert camelCase to snake_case
        return name.replace(/^log/, '')
          .replace(/([A-Z])/g, '_$1')
          .toLowerCase()
          .replace(/^_/, '');
      }

      // Dynamically wrap ALL methods that start with 'log' on the prototype
      // This catches logEvent, logPurchase, logAddToCart, logScreenView, etc.
      // Also catches any future methods Firebase adds.
      Object.getOwnPropertyNames(proto).forEach(methodName => {
        if (!methodName.startsWith('log') || typeof proto[methodName] !== 'function') return;

        const orig = proto[methodName];

        if (methodName === 'logEvent') {
          // logEvent has signature: (eventName, params, options?)
          proto.logEvent = function(eventName, params, options) {
            try { mainCh.send({ type: 'ga4', name: eventName, params: _safeParams(params), tag: 'GA4' }); } catch {}
            return orig.call(this, eventName, params, options);
          };
        } else {
          // All other log methods: logPurchase(params), logScreenView(params), etc.
          const eventName = _methodToEvent(methodName);
          proto[methodName] = function() {
            try {
              // First argument is always the params object (or undefined for logAppOpen, logTutorialBegin, etc.)
              const params = arguments[0];
              mainCh.send({ type: 'ga4', name: eventName, params: _safeParams(params), tag: 'GA4' });
            } catch {}
            return orig.apply(this, arguments);
          };
        }
      });

      // Also wrap set* methods to track user properties/consent
      ['setUserId', 'setUserProperty', 'setUserProperties', 'setConsent', 'setDefaultEventParameters', 'setAnalyticsCollectionEnabled'].forEach(methodName => {
        if (!proto[methodName] || typeof proto[methodName] !== 'function') return;
        const orig = proto[methodName];
        proto[methodName] = function() {
          try {
            const params = {};
            // Capture the arguments as key-value
            if (arguments.length === 1) params.value = _safeParams(arguments[0]);
            else if (arguments.length >= 2) { params.name = arguments[0]; params.value = arguments[1]; }
            mainCh.send({ type: 'ga4', name: methodName, params, tag: 'GA4' });
          } catch {}
          return orig.apply(this, arguments);
        };
      });

      _console.log('[RNDebugSDK] GA4 Analytics prototype interceptor active');
      return true;
    } catch (e) {
      return false;
    }
  }

  // Try immediately, then retry at increasing delays
  if (!patchAnalytics()) {
    [100, 500, 2000, 5000].forEach(delay => {
      setTimeout(() => patchAnalytics(), delay);
    });
  }

  // Fallback: also patch the module's default export function to wrap returned instances
  setTimeout(() => {
    try {
      const mod = require('@react-native-firebase/analytics');
      if (!mod || mod.__reactoRadarWrapped) return;
      const origDefault = mod.default;
      if (typeof origDefault !== 'function') return;
      mod.__reactoRadarWrapped = true;
      mod.default = function() {
        const inst = origDefault.apply(this, arguments);
        // Ensure prototype is patched (in case new prototype was created)
        if (inst && inst.logEvent) {
          const p = Object.getPrototypeOf(inst);
          if (p && !p.__reactoRadarPatched) patchAnalytics();
        }
        return inst;
      };
      // Copy static properties
      Object.keys(origDefault).forEach(k => { mod.default[k] = origDefault[k]; });
    } catch {}
  }, 50);
})();

// ─── PostHog Interceptor ─────────────────────────────────────────────────────
(function setupPostHogInterceptor() {
  function patchPostHog() {
    try {
      const posthog = require('posthog-react-native');
      if (!posthog) return false;
      const ph = posthog.default || posthog;
      // PostHog may export a class or singleton
      const target = typeof ph === 'function' ? ph.prototype : ph;
      if (!target || target.__reactoRadarPatched) return false;

      const methods = ['capture', 'identify', 'screen', 'alias', 'group', 'register', 'optIn', 'optOut'];
      methods.forEach(methodName => {
        if (typeof target[methodName] !== 'function') return;
        const orig = target[methodName];
        target[methodName] = function() {
          try {
            const name = methodName === 'capture' ? (arguments[0] || methodName) : methodName;
            const params = methodName === 'capture' ? (arguments[1] || {}) : (arguments[0] || {});
            try { mainCh.send({ type: 'ga4', name: String(name), params: JSON.parse(JSON.stringify(params)), tag: 'PostHog' }); } catch {}
          } catch {}
          return orig.apply(this, arguments);
        };
      });
      target.__reactoRadarPatched = true;
      _console.log('[RNDebugSDK] PostHog interceptor active');
      return true;
    } catch { return false; }
  }
  if (!patchPostHog()) { [500, 2000, 5000].forEach(d => setTimeout(patchPostHog, d)); }
})();

// ─── Branch Interceptor ──────────────────────────────────────────────────────
(function setupBranchInterceptor() {
  function patchBranch() {
    try {
      const branch = require('react-native-branch');
      if (!branch) return false;
      const br = branch.default || branch;
      if (!br || br.__reactoRadarPatched) return false;

      // Branch.logEvent is a static method
      const methods = ['logEvent', 'logStandardEvent', 'logCustomEvent'];
      methods.forEach(methodName => {
        if (typeof br[methodName] !== 'function') return;
        const orig = br[methodName];
        br[methodName] = function() {
          try {
            const name = arguments[0] || methodName;
            const params = arguments[1] || {};
            try { mainCh.send({ type: 'ga4', name: String(name), params: JSON.parse(JSON.stringify(params)), tag: 'Branch' }); } catch {}
          } catch {}
          return orig.apply(this, arguments);
        };
      });

      // Also intercept BranchEvent constructor if available
      if (branch.BranchEvent) {
        const OrigBE = branch.BranchEvent;
        const origLogTo = OrigBE.prototype.logTo;
        if (origLogTo && !OrigBE.prototype.__reactoRadarPatched) {
          OrigBE.prototype.logTo = function() {
            try {
              mainCh.send({ type: 'ga4', name: this._name || 'BranchEvent', params: JSON.parse(JSON.stringify(this._customData || {})), tag: 'Branch' });
            } catch {}
            return origLogTo.apply(this, arguments);
          };
          OrigBE.prototype.__reactoRadarPatched = true;
        }
      }

      br.__reactoRadarPatched = true;
      _console.log('[RNDebugSDK] Branch interceptor active');
      return true;
    } catch { return false; }
  }
  if (!patchBranch()) { [500, 2000, 5000].forEach(d => setTimeout(patchBranch, d)); }
})();

// ─── MoEngage Interceptor ────────────────────────────────────────────────────
(function setupMoEngageInterceptor() {
  function patchMoEngage() {
    try {
      const moe = require('react-native-moengage');
      if (!moe) return false;
      const ReactMoE = moe.default || moe.ReactMoE || moe;
      if (!ReactMoE || ReactMoE.__reactoRadarPatched) return false;

      const target = typeof ReactMoE === 'function' ? ReactMoE.prototype : ReactMoE;
      const methods = ['trackEvent', 'setUserAttribute', 'setAlias', 'setUniqueId', 'setUserName', 'setEmail'];
      methods.forEach(methodName => {
        if (typeof target[methodName] !== 'function') return;
        const orig = target[methodName];
        target[methodName] = function() {
          try {
            const name = methodName === 'trackEvent' ? (arguments[0] || methodName) : methodName;
            const params = methodName === 'trackEvent' ? (arguments[1] || {}) : { value: arguments[0] };
            try { mainCh.send({ type: 'ga4', name: String(name), params: JSON.parse(JSON.stringify(params)), tag: 'MoEngage' }); } catch {}
          } catch {}
          return orig.apply(this, arguments);
        };
      });
      target.__reactoRadarPatched = true;
      _console.log('[RNDebugSDK] MoEngage interceptor active');
      return true;
    } catch { return false; }
  }
  if (!patchMoEngage()) { [500, 2000, 5000].forEach(d => setTimeout(patchMoEngage, d)); }
})();

// ─── Algolia Search Insights Interceptor ─────────────────────────────────────
(function setupAlgoliaInterceptor() {
  function patchAlgolia() {
    try {
      const insights = require('search-insights');
      if (!insights) return false;
      const aa = insights.default || insights;
      if (!aa || aa.__reactoRadarPatched) return false;

      const methods = ['clickedObjectIDs', 'clickedObjectIDsAfterSearch', 'clickedFilters',
        'convertedObjectIDs', 'convertedObjectIDsAfterSearch', 'convertedFilters',
        'viewedObjectIDs', 'viewedFilters'];
      methods.forEach(methodName => {
        if (typeof aa[methodName] !== 'function') return;
        const orig = aa[methodName];
        aa[methodName] = function() {
          try {
            const params = arguments[0] || {};
            try { mainCh.send({ type: 'ga4', name: methodName, params: JSON.parse(JSON.stringify(params)), tag: 'Algolia' }); } catch {}
          } catch {}
          return orig.apply(this, arguments);
        };
      });
      aa.__reactoRadarPatched = true;
      _console.log('[RNDebugSDK] Algolia Insights interceptor active');
      return true;
    } catch { return false; }
  }
  if (!patchAlgolia()) { [500, 2000, 5000].forEach(d => setTimeout(patchAlgolia, d)); }
})();

console.log(`[RNDebugSDK] Connected to ${HOST} | Console+Network:${PORTS.NETWORK_AND_CONSOLE} Redux:${PORTS.REDUX} Storage:${PORTS.STORAGE}`);

module.exports = { reduxEnhancer, reduxMiddleware, watchAsyncStorage };
}
