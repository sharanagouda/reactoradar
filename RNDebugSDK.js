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
  if (HOST_OVERRIDE) {
    return HOST_OVERRIDE;
  }
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
let _reqId = 0; // Monotonic counter for generated network request ids
const THROTTLE_DELAYS = { none: 0, fast3g: 500, slow3g: 2000, offline: -1 };
const SDK_STATUS_ACTION = 'sdk-status';
const STATE_NOT_SERIALIZABLE_ERROR = 'State not serializable';

function _safeClone(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function _toStringSafe(value) {
  try {
    return String(value);
  } catch {
    return '';
  }
}

function _toJSONMessage(obj) {
  try {
    return JSON.stringify({ ...obj, ts: Date.now() }, (_, v) => typeof v === 'bigint' ? v.toString() : v);
  } catch {
    return '';
  }
}

function _serializeReduxState(state) {
  try {
    const serialized = JSON.stringify(state, (_, v) => typeof v === 'bigint' ? v.toString() : v);
    if (serialized.length > 1_000_000) {
      return { __truncated: true, sizeBytes: serialized.length, keys: Object.keys(state || {}) };
    }
    return JSON.parse(serialized);
  } catch {
    return { __error: STATE_NOT_SERIALIZABLE_ERROR };
  }
}

function _serializeNetworkBody(body) {
  if (body == null) return null;
  if (typeof body === 'string') return body;
  const cloned = _safeClone(body, null);
  return cloned === null ? _toStringSafe(body) : cloned;
}

function _makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function _buildURL(baseURL, path) {
  if (!baseURL) return path || '';
  return baseURL.replace(/\/+$/, '') + '/' + String(path || '').replace(/^\/+/, '');
}

function _sendGAEvent(tag, name, params) {
  try {
    mainCh.send({ type: 'ga4', name: String(name), params: _safeClone(params, {}), tag });
  } catch {}
}

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
  let ws = null;
  const queue = [];
  let connected = false;
  let retryDelay = 2000;

  function scheduleReconnect() {
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 1.5, 30000);
  }

  function flushQueue() {
    const pending = queue.splice(0);
    for (const m of pending) {
      const isOpen = ws && ws.readyState === WebSocket.OPEN;
      if (!isOpen) {
        queue.push(m);
        break;
      }
      try {
        ws.send(m);
      } catch {
        queue.push(m);
        break;
      }
    }
  }

  function handleMessage(evt) {
    if (!onMessage) return;
    try {
      onMessage(JSON.parse(evt.data));
    } catch {}
  }

  function connect() {
    ws = null;
    connected = false;
    try {
      ws = new WebSocket(`ws://${HOST}:${port}`);
      ws.onopen = () => {
        connected = true;
        retryDelay = 2000;
        flushQueue();
      };
      ws.onmessage = handleMessage;
      ws.onclose = () => {
        connected = false;
        scheduleReconnect();
      };
      ws.onerror = () => {};
    } catch {
      scheduleReconnect();
    }
  }

  function send(obj) {
    const msg = _toJSONMessage(obj);
    if (!msg) return;

    if (connected && ws?.readyState === WebSocket.OPEN) {
      try {
        ws.send(msg);
        return;
      } catch {}
    }

    queue.push(msg);
    if (queue.length > 300) queue.shift();
  }

  connect();
  return { send };
}

// The main channel (console + network) listens for control messages from the debugger
const mainCh    = makeChannel(PORTS.NETWORK_AND_CONSOLE, 'main', (msg) => {
  if (msg.type !== 'control') return;

  if (msg.action === 'set-network-capture') _networkCaptureEnabled = !!msg.enabled;
  if (msg.action === 'set-throttle') _throttleProfile = msg.profile || 'none';
  if (msg.action === 'set-stack-trace') _stackTraceEnabled = !!msg.enabled;

  if (msg.action === 'pause-sdk') {
    _sdkPaused = true;
    _console.log('[RNDebugSDK] SDK paused — inspector/debugger can now inspect the app freely.');
    mainCh.send({ type: 'control', action: SDK_STATUS_ACTION, paused: true });
    return;
  }

  if (msg.action === 'resume-sdk') {
    _sdkPaused = false;
    _console.log('[RNDebugSDK] SDK resumed — interception re-enabled.');
    mainCh.send({ type: 'control', action: SDK_STATUS_ACTION, paused: false });
    return;
  }

  if (msg.action === 'query-sdk-status') {
    mainCh.send({ type: 'control', action: SDK_STATUS_ACTION, paused: _sdkPaused, debuggerDetected: _debuggerDetected });
  }
});
const reduxCh   = makeChannel(PORTS.REDUX,   'redux');
const storageCh = makeChannel(PORTS.STORAGE, 'storage');

// ─── Console Intercept ────────────────────────────────────────────────────────
function serializeArg(a) {
  const primitiveType = typeof a;
  if (a === null) return { t: 'null', v: null };
  if (a === undefined) return { t: 'undefined', v: undefined };
  if (primitiveType === 'string' || primitiveType === 'number' || primitiveType === 'boolean') return { t: primitiveType, v: a };
  if (primitiveType === 'symbol') return { t: 'string', v: a.toString() };
  if (primitiveType === 'function') return { t: 'string', v: `[Function: ${a.name || 'anonymous'}]` };
  if (a instanceof Error) return { t: 'object', v: { name: a.name, message: a.message, stack: a.stack } };

  if (Array.isArray(a)) {
    const clonedArray = _safeClone(a, null);
    if (clonedArray !== null) return { t: 'array', v: clonedArray };
    return { t: 'string', v: _toStringSafe(a) };
  }

  if (primitiveType === 'object') {
    const clonedObject = _safeClone(a, null);
    if (clonedObject !== null) return { t: 'object', v: clonedObject };
    return { t: 'string', v: _toStringSafe(a) };
  }

  return { t: 'string', v: _toStringSafe(a) };
}

const LEVELS = ['log','info','warn','error','debug'];
const _console = {};

// Pre-compiled regexes for stack parsing (avoid creating per call)
const _skipRe = /RNDebugSDK|apply \(native\)|call \(native\)|anonymous \(native\)|MessageQueue|__callFunction|__guard|callFunctionReturn|processTicksAndRejections/;
const _frameRe = /at\s+(.+?)(?:\s+\((.+?):(\d+):\d+\)|(?:\s+)?(.+?):(\d+):\d+)/;
const _consoleFnRe = /^console|^_console|^overrideMethod|^reactConsoleError|^anonymous$/;

function _parseFrame(frame) {
  const m = frame.match(_frameRe);
  if (!m) return null;
  return { fn: m[1] || '', src: m[2] || m[4] || '', ln: m[3] || m[5] || '' };
}

function _formatCallerFromParsed(parsed) {
  if (!parsed || _consoleFnRe.test(parsed.fn) || parsed.fn.length <= 2) return '';
  const hasRealSource = parsed.src && !parsed.src.includes('index.bundle') && /\.[jt]sx?$/.test(parsed.src);
  if (hasRealSource) {
    return `${parsed.src.split('/').pop()}:${parsed.ln}` + (parsed.fn.length > 2 ? ` (${parsed.fn})` : '');
  }
  if (parsed.fn.length >= 3 && parsed.fn !== 'Object' && parsed.fn !== 'Function') return parsed.fn;
  return '';
}

function _extractCaller() {
  const stack = (new Error().stack || '').split('\n');
  for (let i = 2; i < Math.min(stack.length, 15); i++) {
    const frame = stack[i]?.trim() || '';
    if (!frame || _skipRe.test(frame)) continue;
    const parsed = _parseFrame(frame);
    const caller = _formatCallerFromParsed(parsed);
    if (caller) return caller;
  }
  return '';
}

function _stringifyConsoleArg(a) {
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a, null, 2);
  } catch {
    return String(a);
  }
}

function _emitConsoleToChannel(level, args) {
  if (!_shouldIntercept()) return;
  const structuredArgs = args.map(serializeArg);
  const message = args.map(_stringifyConsoleArg).join(' ');
  const caller = _stackTraceEnabled ? _extractCaller() : '';
  mainCh.send({ type: 'console', level, message, args: structuredArgs, caller });
}

LEVELS.forEach(level => {
  const orig = console[level];
  if (typeof orig !== 'function') return;
  _console[level] = orig.bind(console);
  console[level] = (...args) => {
    try { _console[level](...args); } catch {}
    try { _emitConsoleToChannel(level, args); } catch {}
  };
});

// ─── Header Flattener (ensures all values are strings) ───────────────────────
function _flattenHeaders(h) {
  if (!h) return {};
  const flat = {};

  function assignHeader(k, v) {
    if (v == null) return;
    if (typeof v === 'object') {
      const serialized = _safeClone(v, null);
      flat[k] = serialized === null ? _toStringSafe(v) : _toStringSafe(JSON.stringify(serialized));
      return;
    }
    flat[k] = _toStringSafe(v);
  }

  try {
    if (typeof h.forEach === 'function') {
      h.forEach((v, k) => assignHeader(k, v));
      return flat;
    }

    if (typeof h === 'object') {
      Object.entries(h).forEach(([k, v]) => assignHeader(k, v));
      return flat;
    }
  } catch {}
  return flat;
}

function _responseHeadersToObject(headers) {
  const out = {};
  headers?.forEach?.((v, k) => {
    out[k] = v;
  });
  return out;
}

function _fetchMeta(input, init) {
  return {
    url: typeof input === 'string' ? input : input?.url || '',
    method: (init.method || 'GET').toUpperCase(),
    id: _makeId('f'),
  };
}

function _isBinaryResponse(contentType, contentLen) {
  return contentLen > 1_000_000 || /image|video|audio|octet-stream|font/i.test(contentType);
}

function _captureFetchBinaryResponse(resp, meta, t0, contentType, contentLen) {
  mainCh.send({
    type: 'network',
    phase: 'response',
    id: meta.id,
    url: meta.url,
    method: meta.method,
    status: resp.status,
    statusText: resp.statusText,
    duration: Date.now() - t0,
    responseHeaders: _responseHeadersToObject(resp.headers),
    responseBody: `[Binary ${contentType} — ${contentLen} bytes]`,
  });
}

function _captureFetchTextResponse(resp, meta, t0) {
  let clone;
  try {
    clone = resp.clone();
  } catch {
    return;
  }

  clone.text().then(body => {
    if (!_networkCaptureEnabled) return;
    let parsed = body;
    try {
      parsed = JSON.parse(body);
    } catch {}
    mainCh.send({
      type: 'network',
      phase: 'response',
      id: meta.id,
      url: meta.url,
      method: meta.method,
      status: resp.status,
      statusText: resp.statusText,
      duration: Date.now() - t0,
      responseHeaders: _responseHeadersToObject(clone.headers),
      responseBody: parsed,
    });
  }).catch(() => {});
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

  const meta = _fetchMeta(input, init);

  mainCh.send({ type: 'network', phase: 'request', id: meta.id, url: meta.url, method: meta.method,
    requestHeaders: _flattenHeaders(init.headers), requestBody: init.body || null });

  const t0 = Date.now();
  try {
    const resp = await _fetch(input, init);
    try {
      const contentType = resp.headers?.get?.('content-type') || '';
      const contentLen = parseInt(resp.headers?.get?.('content-length') || '0', 10);
      if (_isBinaryResponse(contentType, contentLen)) _captureFetchBinaryResponse(resp, meta, t0, contentType, contentLen);
      else _captureFetchTextResponse(resp, meta, t0);
    } catch {} // header access failed
    return resp;
  } catch (err) {
    mainCh.send({ type: 'network', phase: 'error', id: meta.id, url: meta.url, method: meta.method,
      duration: Date.now() - t0, error: err?.message || String(err) });
    throw err;
  }
};

// ─── Network Intercept via XHR readystatechange (RN 0.81 compatible) ─────────
// RN 0.81 + Reactotron both fight over XMLHttpRequest.prototype. Instead of
// patching prototype methods (which get overwritten), we use a non-invasive
// approach: wrap XMLHttpRequest constructor to add a readystatechange listener
// on every NEW instance. This works regardless of who patches the prototype.
function _makeXHRMeta() {
  return { id: _makeId('x'), method: 'GET', url: '', t0: 0, headers: {}, sent: false };
}

function _readXHRBody(xhr) {
  const rType = xhr.responseType || '';
  if (rType === 'json') return xhr.response;
  if (rType !== '' && rType !== 'text') {
    return `[${rType} response — ${xhr.response?.size || xhr.response?.byteLength || '?'} bytes]`;
  }

  let text = '';
  try {
    text = xhr.responseText || '';
  } catch {
    return '';
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function _parseXHRHeaders(xhr) {
  const respHeaders = {};
  try {
    const raw = xhr.getAllResponseHeaders() || '';
    raw.split('\r\n').forEach(line => {
      const idx = line.indexOf(':');
      if (idx > 0) respHeaders[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
  } catch {}
  return respHeaders;
}

function _emitXHRRequest(meta, body) {
  mainCh.send({
    type: 'network',
    phase: 'request',
    id: meta.id,
    url: meta.url,
    method: meta.method,
    requestHeaders: meta.headers,
    requestBody: _serializeNetworkBody(body),
  });
}

function _emitXHRDone(xhr, meta) {
  const duration = Date.now() - meta.t0;
  if (xhr.status <= 0) {
    mainCh.send({
      type: 'network',
      phase: 'error',
      id: meta.id,
      url: meta.url,
      method: meta.method,
      duration,
      error: 'Request failed (status 0)',
    });
    return;
  }

  mainCh.send({
    type: 'network',
    phase: 'response',
    id: meta.id,
    url: meta.url,
    method: meta.method,
    status: xhr.status,
    statusText: xhr.statusText,
    duration,
    responseHeaders: _parseXHRHeaders(xhr),
    responseBody: _readXHRBody(xhr),
  });
}

(function setupXHRNetworkCapture() {
  const _xhrTracker = new WeakMap();

  function wrapXHR() {
    const OrigXHR = global.XMLHttpRequest;
    if (!OrigXHR || OrigXHR.__dbgWrapped) return;

    function WrappedXHR() {
      const xhr = new OrigXHR();
      const meta = _makeXHRMeta();
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

      const _send = xhr.send.bind(xhr);
      xhr.send = function(body) {
        const shouldTrack = _shouldIntercept() && _networkCaptureEnabled && !meta.sent;
        if (shouldTrack) {
          meta.sent = true;
          _emitXHRRequest(meta, body);
        }
        return _send.apply(xhr, arguments);
      };

      // Listen for completion
      xhr.addEventListener('readystatechange', function() {
        if (xhr.readyState !== 4 || !meta.sent || !_shouldIntercept() || !_networkCaptureEnabled) return;
        try {
          _emitXHRDone(xhr, meta);
        } catch (e) {
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
function _captureImagePixel(url) {
  const id = `img_${_reqId++}`;
  const t0 = Date.now();
  const u = typeof url === 'string' ? url : _toStringSafe(url);
  mainCh.send({ type: 'network', phase: 'request', id, url: u, method: 'GET',
    requestHeaders: {}, requestBody: null, ts: t0, initiator: 'Image' });
  setTimeout(() => {
    mainCh.send({ type: 'network', phase: 'response', id, url: u, method: 'GET',
      status: 200, statusText: 'OK', duration: Date.now() - t0,
      responseHeaders: { 'content-type': 'image/gif' },
      responseBody: '[Tracking Pixel]', ts: t0 });
  }, 100);
}

function _setOriginalImageSrc(img, url, origSrcDesc, OrigImage) {
  if (origSrcDesc && origSrcDesc.set) {
    origSrcDesc.set.call(img, url);
    return;
  }
  try {
    OrigImage.prototype.__lookupSetter__?.('src')?.call(img, url);
  } catch {}
}

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
            try { _captureImagePixel(url); } catch {}
          }
          _setOriginalImageSrc(img, url, origSrcDesc, OrigImage);
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
function _captureBeacon(url, data) {
  const id = `beacon_${_reqId++}`;
  const t0 = Date.now();
  const u = typeof url === 'string' ? url : _toStringSafe(url);
  const body = data ? (typeof data === 'string' ? data : '[Beacon Data]') : null;
  mainCh.send({ type: 'network', phase: 'request', id, url: u, method: 'POST',
    requestHeaders: { 'content-type': 'text/plain' },
    requestBody: body, ts: t0, initiator: 'sendBeacon' });
  mainCh.send({ type: 'network', phase: 'response', id, url: u, method: 'POST',
    status: 200, statusText: 'OK', duration: 0,
    responseHeaders: {}, responseBody: '[Beacon Sent]', ts: t0 });
}

if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
  const _origBeacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = function(url, data) {
    if (_shouldIntercept() && _networkCaptureEnabled && url) {
      try { _captureBeacon(url, data); } catch {}
    }
    return _origBeacon(url, data);
  };
}

// ─── Axios Interceptor (belt-and-suspenders with XHR patch) ──────────────────
// Patches axios.create after a tick so import hoisting has resolved.
function _axiosHeaders(headers) {
  const source = typeof headers?.toJSON === 'function' ? headers.toJSON() : headers;
  return _flattenHeaders(source);
}

function _axiosMethod(method) {
  return (method || 'GET').toUpperCase();
}

function _sendAxiosRequest(config) {
  const id = _makeId('ax');
  config._dbgId = id;
  config._dbgT0 = Date.now();
  mainCh.send({
    type: 'network',
    phase: 'request',
    id,
    url: _buildURL(config.baseURL, config.url),
    method: _axiosMethod(config.method),
    requestHeaders: _axiosHeaders(config.headers),
    requestBody: _serializeNetworkBody(config.data),
  });
}

function _sendAxiosResponse(resp) {
  const c = resp.config || {};
  if (!c._dbgId) return;
  mainCh.send({
    type: 'network',
    phase: 'response',
    id: c._dbgId,
    url: _buildURL(c.baseURL, c.url),
    method: _axiosMethod(c.method),
    status: resp.status,
    statusText: resp.statusText,
    duration: c._dbgT0 ? Date.now() - c._dbgT0 : 0,
    responseHeaders: _axiosHeaders(resp.headers),
    responseBody: _serializeNetworkBody(resp.data),
  });
}

function _sendAxiosError(err) {
  const c = err?.config || {};
  if (!c._dbgId) return;

  const url = _buildURL(c.baseURL, c.url);
  const duration = c._dbgT0 ? Date.now() - c._dbgT0 : 0;
  const method = _axiosMethod(c.method);
  const response = err?.response;

  if (!response) {
    mainCh.send({ type: 'network', phase: 'error', id: c._dbgId, url, method, duration, error: err?.message || String(err) });
    return;
  }

  mainCh.send({
    type: 'network',
    phase: 'response',
    id: c._dbgId,
    url,
    method,
    status: response.status,
    statusText: response.statusText,
    duration,
    responseBody: _serializeNetworkBody(response.data),
  });
}

function _addDbgInterceptors(instance) {
  if (!instance || !instance.interceptors || instance.__dbgInt) return;
  instance.__dbgInt = true;

  instance.interceptors.request.use(config => {
    if (_shouldIntercept() && _networkCaptureEnabled) _sendAxiosRequest(config);
    return config;
  }, e => Promise.reject(e));

  instance.interceptors.response.use(resp => {
    if (_shouldIntercept() && _networkCaptureEnabled) _sendAxiosResponse(resp);
    return resp;
  }, err => {
    if (_shouldIntercept() && _networkCaptureEnabled) _sendAxiosError(err);
    return Promise.reject(err);
  });
}

setTimeout(() => {
  try {
    const axios = require('axios');
    if (!axios || axios.__dbgPatched) return;
    axios.__dbgPatched = true;

    _addDbgInterceptors(axios);
    const _create = axios.create.bind(axios);
    axios.create = function(...args) {
      const inst = _create(...args);
      _addDbgInterceptors(inst);
      return inst;
    };
    _console.log('[RNDebugSDK] Axios interceptor active (global + create)');
  } catch {}
}, 0);

// ─── Redux Enhancer ──────────────────────────────────────────────────────────
function _serializeReduxAction(action) {
  if (typeof action === 'function') {
    return { type: `[Function: ${action.name || 'thunk'}]` };
  }
  return action || { type: '@@UNKNOWN' };
}

function _sendReduxPayload(action, nextState, index) {
  reduxCh.send({
    type: 'redux',
    action: _serializeReduxAction(action),
    nextState: _serializeReduxState(nextState),
    index,
  });
}

function reduxEnhancer(createStore) {
  return (reducer, preloadedState, enhancer) => {
    const store = createStore(reducer, preloadedState, enhancer);
    let actionCount = 0;

    // Send initial state
    try {
      _sendReduxPayload({ type: '@@INIT' }, store.getState(), actionCount++);
    } catch {}

    const origDispatch = store.dispatch;
    store.dispatch = (action) => {
      const result = origDispatch(action);
      try {
        _sendReduxPayload(action, store.getState(), actionCount++);
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
    _sendReduxPayload(action, store.getState(), _mwActionCount++);
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
function _appendHermesMemory(perfData) {
  try {
    if (!global.HermesInternal || typeof global.HermesInternal.getRuntimeProperties !== 'function') return;
    const props = global.HermesInternal.getRuntimeProperties();
    perfData.heapUsed = props['js_heapSize'] || 0;
    perfData.heapTotal = props['js_totalHeapSize'] || 0;
    perfData.native = props['js_nativeHeapSize'] || 0;
  } catch {}
}

function _appendJSThreadTime(perfData) {
  try {
    if (global.performance && typeof global.performance.now === 'function') {
      perfData.jsThread = global.performance.now() % 16.67;
    }
  } catch {}
}

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
    _appendHermesMemory(perfData);
    _appendJSThreadTime(perfData);

    mainCh.send(perfData);
  }, 2000);
})();

// ─── GA4 / Firebase Analytics Interceptor ────────────────────────────────────
// Intercepts @react-native-firebase/analytics logEvent calls.
// The analytics() function returns a new instance each time, so we patch the
// PROTOTYPE of the analytics module class, not individual instances.
function _gaSafeParams(p) {
  if (!p || typeof p !== 'object') return p || {};
  return _safeClone(p, {});
}

function _gaMethodToEvent(name) {
  return name.replace(/^log/, '')
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

function _wrapGA4LogMethod(proto, methodName) {
  const orig = proto[methodName];
  if (typeof orig !== 'function') return;

  if (methodName === 'logEvent') {
    proto.logEvent = function(eventName, params, options) {
      _sendGAEvent('GA4', eventName, _gaSafeParams(params));
      return orig.call(this, eventName, params, options);
    };
    return;
  }

  const eventName = _gaMethodToEvent(methodName);
  proto[methodName] = function() {
    _sendGAEvent('GA4', eventName, _gaSafeParams(arguments[0]));
    return orig.apply(this, arguments);
  };
}

function _wrapGA4SetMethod(proto, methodName) {
  const orig = proto[methodName];
  if (typeof orig !== 'function') return;

  proto[methodName] = function() {
    const params = {};
    if (arguments.length === 1) params.value = _gaSafeParams(arguments[0]);
    if (arguments.length >= 2) {
      params.name = arguments[0];
      params.value = arguments[1];
    }
    _sendGAEvent('GA4', methodName, params);
    return orig.apply(this, arguments);
  };
}

function _patchGA4Prototype(proto) {
  if (!proto || proto.__reactoRadarPatched) return false;
  proto.__reactoRadarPatched = true;

  Object.getOwnPropertyNames(proto).forEach(methodName => {
    if (!methodName.startsWith('log')) return;
    _wrapGA4LogMethod(proto, methodName);
  });

  [
    'setUserId',
    'setUserProperty',
    'setUserProperties',
    'setConsent',
    'setDefaultEventParameters',
    'setAnalyticsCollectionEnabled',
  ].forEach(methodName => _wrapGA4SetMethod(proto, methodName));

  return true;
}

(function setupGA4Interceptor() {
  function patchAnalytics() {
    try {
      const analyticsModule = require('@react-native-firebase/analytics');
      if (!analyticsModule) return false;
      const analyticsFn = analyticsModule.default || analyticsModule;
      if (typeof analyticsFn !== 'function') return false;
      const instance = analyticsFn();
      if (!instance || !instance.logEvent) return false;
      const proto = Object.getPrototypeOf(instance);
      if (!_patchGA4Prototype(proto)) return false;
      _console.log('[RNDebugSDK] GA4 Analytics prototype interceptor active');
      return true;
    } catch {
      return false;
    }
  }

  if (!patchAnalytics()) [100, 500, 2000, 5000].forEach(delay => setTimeout(patchAnalytics, delay));

  setTimeout(() => {
    try {
      const mod = require('@react-native-firebase/analytics');
      if (!mod || mod.__reactoRadarWrapped) return;
      const origDefault = mod.default;
      if (typeof origDefault !== 'function') return;
      mod.__reactoRadarWrapped = true;
      mod.default = function() {
        const inst = origDefault.apply(this, arguments);
        if (inst && inst.logEvent) {
          const p = Object.getPrototypeOf(inst);
          if (p && !p.__reactoRadarPatched) patchAnalytics();
        }
        return inst;
      };
      Object.keys(origDefault).forEach(k => { mod.default[k] = origDefault[k]; });
    } catch {}
  }, 50);
})();

// ─── PostHog Interceptor ─────────────────────────────────────────────────────
function _wrapAnalyticsMethod(target, methodName, tag, mapper) {
  if (typeof target[methodName] !== 'function') return;
  const orig = target[methodName];
  target[methodName] = function() {
    const mapped = mapper(arguments, methodName);
    if (mapped) _sendGAEvent(tag, mapped.name, mapped.params);
    return orig.apply(this, arguments);
  };
}

(function setupPostHogInterceptor() {
  function patchPostHog() {
    try {
      const posthog = require('posthog-react-native');
      if (!posthog) return false;
      const ph = posthog.default || posthog;
      const target = typeof ph === 'function' ? ph.prototype : ph;
      if (!target || target.__reactoRadarPatched) return false;

      const methods = ['capture', 'identify', 'screen', 'alias', 'group', 'register', 'optIn', 'optOut'];
      methods.forEach(methodName => {
        _wrapAnalyticsMethod(target, methodName, 'PostHog', (args, name) => ({
          name: name === 'capture' ? (args[0] || name) : name,
          params: name === 'capture' ? (args[1] || {}) : (args[0] || {}),
        }));
      });
      target.__reactoRadarPatched = true;
      _console.log('[RNDebugSDK] PostHog interceptor active');
      return true;
    } catch { return false; }
  }
  if (!patchPostHog()) { [500, 2000, 5000].forEach(d => setTimeout(patchPostHog, d)); }
})();

// ─── Branch Interceptor ──────────────────────────────────────────────────────
function _patchBranchEventPrototype(branch) {
  if (!branch?.BranchEvent) return;
  const proto = branch.BranchEvent.prototype;
  if (!proto || proto.__reactoRadarPatched) return;

  ['logEvent', 'logTo'].forEach(methodName => {
    if (typeof proto[methodName] !== 'function') return;
    const orig = proto[methodName];
    proto[methodName] = function() {
      const name = this._name || this.name || 'BranchEvent';
      const data = this._customData || this.customData || {};
      _sendGAEvent('Branch', name, data);
      return orig.apply(this, arguments);
    };
  });

  proto.__reactoRadarPatched = true;
}

(function setupBranchInterceptor() {
  function patchBranch() {
    try {
      const branch = require('react-native-branch');
      if (!branch) return false;
      const br = branch.default || branch;
      if (!br || br.__reactoRadarPatched) return false;

      const methods = ['logEvent', 'logStandardEvent', 'logCustomEvent'];
      methods.forEach(methodName => {
        _wrapAnalyticsMethod(br, methodName, 'Branch', (args, name) => ({
          name: args[0] || name,
          params: args[1] || {},
        }));
      });

      _patchBranchEventPrototype(branch);

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
        _wrapAnalyticsMethod(aa, methodName, 'Algolia', args => ({
          name: methodName,
          params: args[0] || {},
        }));
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
