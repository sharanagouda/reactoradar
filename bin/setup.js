#!/usr/bin/env node
'use strict';

/**
 * ReactoRadar — Auto Setup
 *
 * Usage:
 *   node bin/setup.js <path-to-rn-project>   # install into RN project
 *   node bin/setup.js <path-to-rn-project> --uninstall   # remove from RN project
 *
 * What it does (install):
 *   1. Validates the target is a React Native project
 *   2. Copies RNDebugSDK.js into the project
 *   3. Detects platform (iOS sim / Android emu / device) and sets HOST
 *   4. Patches the entry file (index.js / index.tsx) to load the SDK
 *   5. Detects Redux (@reduxjs/toolkit or redux) and patches the store
 *   6. Runs adb reverse for Android
 *   7. Prints summary
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');
const readline = require('readline');

// ─── Colors ──────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  dim:   '\x1b[2m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  red:   '\x1b[31m',
  cyan:  '\x1b[36m',
  magenta:'\x1b[35m',
};
const log   = (...a) => console.log(C.green + '  ✓' + C.reset, ...a);
const warn  = (...a) => console.log(C.yellow + '  ⚠' + C.reset, ...a);
const err   = (...a) => console.log(C.red + '  ✗' + C.reset, ...a);
const info  = (...a) => console.log(C.cyan + '  →' + C.reset, ...a);
const title = (t) => console.log('\n' + C.bold + C.magenta + '  ' + t + C.reset);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function dirExists(p)  { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function readJSON(p)   { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(C.cyan + '  ? ' + C.reset + question + ' ', answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function getMacLanIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '192.168.1.100';
}

function tryExec(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim(); } catch { return ''; }
}

// ─── SDK Marker ──────────────────────────────────────────────────────────────
const SDK_MARKER_START = '// ── RNDebugSDK setup ──';
const SDK_MARKER_END   = '// ── /RNDebugSDK setup ──';

// ─── Detect platform ────────────────────────────────────────────────────────
function detectPlatform() {
  // Check if Android emulator is running
  const adbDevices = tryExec('adb devices 2>/dev/null');
  const hasAndroidEmu = adbDevices.includes('emulator');
  const hasAndroidDevice = /\b[A-Z0-9]{6,}\s+device\b/i.test(adbDevices) && !hasAndroidEmu;

  // Check if iOS simulator is running
  const xcrun = tryExec('xcrun simctl list devices booted 2>/dev/null');
  const hasIOSSim = xcrun.includes('Booted');

  // Check if iOS real device is connected via USB
  let hasIOSDevice = false;
  // Method 1: idevice_id (from libimobiledevice — brew install libimobiledevice)
  const idevice = tryExec('idevice_id -l 2>/dev/null');
  if (idevice && idevice.trim().length > 0) hasIOSDevice = true;
  // Method 2: system_profiler (slower but always available on macOS)
  if (!hasIOSDevice) {
    const profiler = tryExec('system_profiler SPUSBDataType 2>/dev/null');
    if (profiler && (profiler.includes('iPhone') || profiler.includes('iPad'))) hasIOSDevice = true;
  }

  return { hasAndroidEmu, hasAndroidDevice, hasIOSSim, hasIOSDevice };
}

function getLanIP() {
  // Get the Mac's LAN IP address for real device connections
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal/loopback and IPv6
      if (iface.internal || iface.family !== 'IPv4') continue;
      // Prefer en0 (Wi-Fi) or en1
      if (iface.address && iface.address.startsWith('192.168.') || iface.address.startsWith('10.') || iface.address.startsWith('172.')) {
        return iface.address;
      }
    }
  }
  return null;
}

function pickHost(platform) {
  const hasRealDevice = platform.hasAndroidDevice || platform.hasIOSDevice;
  const hasSimOrEmu = platform.hasIOSSim || platform.hasAndroidEmu;

  // Real device (iOS or Android) — needs LAN IP or adb reverse
  if (platform.hasIOSDevice && !hasSimOrEmu) {
    const lanIP = getLanIP();
    if (lanIP) return { host: lanIP, reason: `iOS device detected via USB (LAN IP: ${lanIP})` };
    return { host: '127.0.0.1', reason: 'iOS device detected but LAN IP not found — ensure Mac and device are on same WiFi' };
  }
  if (platform.hasAndroidDevice && !hasSimOrEmu) {
    return { host: '10.0.2.2', reason: 'Android device detected (using adb reverse)' };
  }

  // Simulator/Emulator only
  if (platform.hasIOSSim && !platform.hasAndroidEmu && !hasRealDevice) {
    return { host: '127.0.0.1', reason: 'iOS Simulator detected' };
  }
  if (platform.hasAndroidEmu && !platform.hasIOSSim && !hasRealDevice) {
    return { host: '10.0.2.2', reason: 'Android Emulator detected' };
  }

  // Mixed: real device + simulator/emulator
  if (hasRealDevice && hasSimOrEmu) {
    // If iOS device + iOS sim: prefer sim (127.0.0.1), user can switch for device
    if (platform.hasIOSSim) {
      return { host: '127.0.0.1', reason: 'iOS Sim + real device detected (defaulting to Sim — change HOST for device)' };
    }
    // Android device + emu: adb reverse handles both
    return { host: '10.0.2.2', reason: 'Android Emu + device detected (adb reverse handles both)' };
  }

  // Both sim + emu
  if (platform.hasIOSSim && platform.hasAndroidEmu) {
    return { host: '127.0.0.1', reason: 'Both iOS Sim + Android Emu detected (defaulting to iOS, Android uses adb reverse)' };
  }

  // Nothing running — try to detect LAN IP for real device use later
  const lanIP = getLanIP();
  if (lanIP) {
    return { host: '127.0.0.1', reason: `No running devices (default). For real device use HOST: ${lanIP}` };
  }
  return { host: '127.0.0.1', reason: 'No running devices detected (default)' };
}

// ─── Find entry file ─────────────────────────────────────────────────────────
function findEntryFile(projectDir) {
  const candidates = ['index.js', 'index.tsx', 'index.ts'];
  for (const f of candidates) {
    if (fileExists(path.join(projectDir, f))) return f;
  }
  return null;
}

// ─── Find Redux store file ───────────────────────────────────────────────────
function findStoreFile(projectDir) {
  const searchDirs = [
    'src', 'app', 'store', 'redux', 'state',
    'src/store', 'src/redux', 'src/state', 'src/app', 'src/app/store',
    'app/store', 'app/redux', 'app/state',
    'src/features', 'src/lib', 'src/config', 'src/core',
    'src/services', 'src/utils',
  ];
  const storeNames = ['store.ts', 'store.js', 'store.tsx', 'store.jsx', 'index.ts', 'index.js', 'index.tsx'];

  // 1. Check common store file locations
  for (const dir of searchDirs) {
    for (const name of storeNames) {
      const p = path.join(projectDir, dir, name);
      if (fileExists(p)) {
        const content = fs.readFileSync(p, 'utf8');
        if (content.includes('configureStore') || content.includes('createStore')) {
          return path.join(dir, name);
        }
      }
    }
  }

  // 2. Check App.tsx / App.js (common pattern: store created in root component)
  const rootAppFiles = ['src/App.tsx', 'src/App.js', 'App.tsx', 'App.js', 'app/App.tsx', 'app/App.js'];
  for (const f of rootAppFiles) {
    const p = path.join(projectDir, f);
    if (fileExists(p)) {
      const content = fs.readFileSync(p, 'utf8');
      if (content.includes('configureStore') || content.includes('createStore')) {
        return f;
      }
    }
  }

  // 3. Deep search: recursively find files with actual createStore()/configureStore() calls
  //    Skip files that merely reference configureStore as a parameter/type name
  try {
    const glob = (dir, depth) => {
      if (depth > 4) return null;
      let entries;
      try { entries = fs.readdirSync(path.join(projectDir, dir), { withFileTypes: true }); } catch { return null; }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'debug') continue;
        const rel = path.join(dir, e.name);
        if (e.isFile() && /\.(ts|js|tsx|jsx)$/.test(e.name)) {
          const content = fs.readFileSync(path.join(projectDir, rel), 'utf8');
          // Must contain actual call: configureStore({ or createStore( — not just the word as a type/param
          if (/configureStore\s*\(/.test(content) || /createStore\s*\(/.test(content)) {
            return rel;
          }
        }
        if (e.isDirectory()) {
          const found = glob(rel, depth + 1);
          if (found) return found;
        }
      }
      return null;
    };
    return glob('src', 0) || glob('app', 0) || glob('.', 1);
  } catch { return null; }
}

// ─── Install ─────────────────────────────────────────────────────────────────
async function install(projectDir) {
  const debuggerDir = path.resolve(__dirname, '..');

  title('ReactoRadar — Auto Setup');
  console.log();

  // 1. Validate RN project
  info('Validating React Native project...');
  const pkg = readJSON(path.join(projectDir, 'package.json'));
  if (!pkg) {
    err('No package.json found at ' + projectDir);
    process.exit(1);
  }
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!allDeps['react-native']) {
    err('Not a React Native project (no react-native dependency)');
    process.exit(1);
  }
  log('React Native project found:', C.bold + pkg.name + C.reset, '(' + (allDeps['react-native']) + ')');

  // 2. Detect platform and set HOST
  info('Detecting running devices...');
  const platform = detectPlatform();
  const { host, reason } = pickHost(platform);
  log('HOST =', C.bold + host + C.reset, C.dim + '(' + reason + ')' + C.reset);

  // 3. Copy SDK
  info('Installing RNDebugSDK...');
  const sdkSrc = path.join(debuggerDir, 'sdk', 'RNDebugSDK.js');
  const sdkDestDir = path.join(projectDir, 'src', 'debug');
  const sdkDest = path.join(sdkDestDir, 'RNDebugSDK.js');

  if (!fileExists(sdkSrc)) {
    err('SDK source file not found at: ' + sdkSrc);
    err('This may be a corrupted installation. Try: npm cache clean --force && npx reactoradar@latest setup');
    process.exit(1);
  }

  try {
    fs.mkdirSync(sdkDestDir, { recursive: true });
  } catch (e) {
    err('Failed to create directory ' + sdkDestDir + ': ' + e.message);
    process.exit(1);
  }

  // Read SDK, patch HOST_OVERRIDE for real device support
  // The SDK auto-detects Android emulator vs iOS simulator at runtime.
  // For real devices, we set HOST_OVERRIDE to the Mac's LAN IP.
  let sdkContent = fs.readFileSync(sdkSrc, 'utf8');
  const isRealDevice = reason.includes('device') || reason.includes('LAN IP');
  if (isRealDevice && host !== '127.0.0.1' && host !== '10.0.2.2') {
    sdkContent = sdkContent.replace(
      /const HOST_OVERRIDE = null;/,
      `const HOST_OVERRIDE = '${host}';`
    );
    log('HOST_OVERRIDE set to', C.bold + host + C.reset, '(real device LAN IP)');
  } else {
    log('HOST auto-detect enabled', C.dim + '(Android: 10.0.2.2, iOS: 127.0.0.1)' + C.reset);
  }
  try {
    fs.writeFileSync(sdkDest, sdkContent);
  } catch (e) {
    err('Failed to write SDK file to ' + sdkDest + ': ' + e.message);
    process.exit(1);
  }

  // Verify the file was actually written
  if (!fileExists(sdkDest)) {
    err('SDK file was not created at ' + sdkDest + ' — check directory permissions');
    process.exit(1);
  }
  log('Copied RNDebugSDK.js →', C.dim + 'src/debug/RNDebugSDK.js' + C.reset);

  // 4. Patch entry file
  info('Patching entry file...');
  const entryFile = findEntryFile(projectDir);
  if (!entryFile) {
    warn('No index.js/tsx found — you\'ll need to add the SDK import manually');
    console.log(C.dim + '    Add to your entry file:' + C.reset);
    console.log(C.dim + '      if (__DEV__) { require("./src/debug/RNDebugSDK"); }' + C.reset);
  } else {
    const entryPath = path.join(projectDir, entryFile);
    let entryContent = fs.readFileSync(entryPath, 'utf8');

    if (entryContent.includes('RNDebugSDK')) {
      log('Entry file already has RNDebugSDK import — skipping');
    } else {
      const sdkImport = `${SDK_MARKER_START}
if (__DEV__) {
  const { watchAsyncStorage } = require('./src/debug/RNDebugSDK');
  watchAsyncStorage();
}
${SDK_MARKER_END}
`;
      entryContent = sdkImport + entryContent;
      fs.writeFileSync(entryPath, entryContent);
      log('Patched', C.bold + entryFile + C.reset, '— SDK loads automatically in dev mode');
    }
  }

   // 5. Detect and wire Redux
   info('Checking for Redux...');
   const hasRedux = allDeps['@reduxjs/toolkit'] || allDeps['redux'];
   if (hasRedux) {
     const storeFile = findStoreFile(projectDir);
     if (storeFile) {
       const storePath = path.join(projectDir, storeFile);
       const storeContent = fs.readFileSync(storePath, 'utf8');

       // Compute relative path from store file to SDK
       const storeDir = path.dirname(path.join(projectDir, storeFile));
       let relSDK = path.relative(storeDir, path.join(projectDir, 'src', 'debug', 'RNDebugSDK'))
         .replace(/\\/g, '/'); // Windows compat
       if (!relSDK.startsWith('.')) relSDK = './' + relSDK;

       if (storeContent.includes('RNDebugSDK')) {
         // Check if the require path is correct — fix stale/wrong paths from older setup versions
         const wrongPathRe = /require\(['"]([^'"]*RNDebugSDK[^'"]*)['"]\)/g;
         let hasWrongPath = false;
         let fixedContent = storeContent;
         let match;
         while ((match = wrongPathRe.exec(storeContent)) !== null) {
           const existingPath = match[1];
           // Normalize: strip .js extension for comparison
           const normalizedExisting = existingPath.replace(/\.js$/, '');
           const normalizedExpected = relSDK.replace(/\.js$/, '');
           if (normalizedExisting !== normalizedExpected) {
             hasWrongPath = true;
             fixedContent = fixedContent.replace(match[0], `require('${relSDK}')`);
           }
         }
         // Also fix import statements
         const wrongImportRe = /from\s+['"]([^'"]*RNDebugSDK[^'"]*)['"]/g;
         while ((match = wrongImportRe.exec(storeContent)) !== null) {
           const existingPath = match[1];
           const normalizedExisting = existingPath.replace(/\.js$/, '');
           const normalizedExpected = relSDK.replace(/\.js$/, '');
           if (normalizedExisting !== normalizedExpected) {
             hasWrongPath = true;
             fixedContent = fixedContent.replace(match[0], `from '${relSDK}'`);
           }
         }
         if (hasWrongPath) {
           fs.writeFileSync(storePath, fixedContent);
           log('Fixed stale SDK path in', C.bold + storeFile + C.reset, '→', C.cyan + relSDK + C.reset);
         } else {
           log('Redux store already has RNDebugSDK wired correctly — skipping');
         }
        } else if (/createStore\s*\(/.test(storeContent)) {
          // Legacy createStore (check this BEFORE configureStore — a file may have both
          // if the user named their wrapper function "configureStore" but uses Redux's createStore inside)
          // Legacy createStore — try to auto-patch by adding reduxMiddleware to middleware array
          let patched = storeContent;
          let didPatch = false;

          // Pattern 1: middleware array exists — push reduxMiddleware into it
          // e.g. const middleware = []; or const middleware = [sagaMiddleware];
          if (/(?:const|let|var)\s+middleware\s*=\s*\[/.test(storeContent) && !storeContent.includes('reduxMiddleware') && !storeContent.includes('RNDebugSDK')) {
            // Add the require + push after the middleware array declaration
            patched = patched.replace(
              /((?:const|let|var)\s+middleware\s*=\s*\[[^\]]*\];?)/,
              `$1\n  if (__DEV__) { try { const { reduxMiddleware } = require('${relSDK}'); if (reduxMiddleware) middleware.push(reduxMiddleware); } catch {} }`
            );
            if (patched !== storeContent) {
              didPatch = true;
            }
          }

          // Pattern 2: applyMiddleware(...middleware) exists but no middleware array — inject inline
          if (!didPatch && storeContent.includes('applyMiddleware') && !storeContent.includes('reduxMiddleware') && !storeContent.includes('RNDebugSDK')) {
            // Find the if (__DEV__) block near middleware setup and add there
            // Or add before the createStore call
            const createStoreMatch = storeContent.match(/createStore\s*\(/);
            if (createStoreMatch) {
              const idx = storeContent.indexOf(createStoreMatch[0]);
              const insertPoint = storeContent.lastIndexOf('\n', idx);
              if (insertPoint > 0) {
                patched = storeContent.slice(0, insertPoint) +
                  `\n  if (__DEV__) { try { const { reduxMiddleware } = require('${relSDK}'); if (reduxMiddleware) middleware.push(reduxMiddleware); } catch {} }` +
                  storeContent.slice(insertPoint);
                if (patched !== storeContent) didPatch = true;
              }
            }
          }

          if (didPatch) {
            fs.writeFileSync(storePath, patched);
            log('Patched', C.bold + storeFile + C.reset, '— Redux middleware wired (legacy createStore)');
          } else {
            warn('Legacy createStore found at', C.bold + storeFile + C.reset);
            console.log(C.dim + '    Could not auto-patch. Add manually:' + C.reset);
            console.log(C.dim + `      if (__DEV__) { try { const { reduxMiddleware } = require('${relSDK}'); middleware.push(reduxMiddleware); } catch {} }` + C.reset);
            console.log(C.dim + '    Add this BEFORE the createStore() call in your middleware setup.' + C.reset);
           }
         } else if (/configureStore\s*\(\s*\{/.test(storeContent)) {
          // RTK configureStore({ ... }) — actual Redux Toolkit usage
          if (storeContent.includes('middleware:') || storeContent.includes('middleware :')) {
            warn('Redux store found at', C.bold + storeFile + C.reset, '— has custom middleware');
            console.log(C.dim + '    Add manually to your middleware:' + C.reset);
            console.log(C.dim + `      import { reduxMiddleware } from '${relSDK}';` + C.reset);
            console.log(C.dim + '      middleware: (getDefault) => __DEV__' + C.reset);
            console.log(C.dim + '        ? getDefault().concat(reduxMiddleware)' + C.reset);
            console.log(C.dim + '        : getDefault(),' + C.reset);
          } else {
            const patched = storeContent.replace(
              /(configureStore\s*\(\s*\{)/,
              `$1\n  middleware: (getDefaultMiddleware) =>\n    __DEV__\n      ? getDefaultMiddleware().concat(require('${relSDK}').reduxMiddleware)\n      : getDefaultMiddleware(),`
            );
            if (patched !== storeContent) {
              fs.writeFileSync(storePath, patched);
              log('Patched', C.bold + storeFile + C.reset, '— Redux middleware wired (RTK)');
            } else {
              warn('Could not auto-patch', storeFile, '— wire Redux manually');
            }
          }
         }
      } else {
       warn('Redux detected but store file not found automatically');
       console.log(C.dim + '    Add to your store setup:' + C.reset);
       console.log(C.dim + '      import { reduxMiddleware } from \'./src/debug/RNDebugSDK\';' + C.reset);
     }
   } else {
     log('No Redux detected — skipping');
   }

  // 6. adb reverse for Android
  if (platform.hasAndroidEmu || platform.hasAndroidDevice) {
    info('Setting up adb reverse...');
    const ports = [9090, 9091, 9092, 8097];
    let allGood = true;
    for (const port of ports) {
      const result = tryExec(`adb reverse tcp:${port} tcp:${port} 2>&1`);
      if (result.includes('error')) {
        warn(`adb reverse tcp:${port} failed`);
        allGood = false;
      }
    }
    if (allGood) {
      log('adb reverse set for ports 9090, 9091, 9092, 8097');
    }
  }

  // 7. Add debug scripts to package.json
  info('Adding debug scripts to package.json...');
  const projPkg = readJSON(path.join(projectDir, 'package.json'));
  if (projPkg && projPkg.scripts) {
    let changed = false;
    if (!projPkg.scripts['debug:start']) {
      projPkg.scripts['debug:start'] = 'npx reactoradar';
      changed = true;
    }
    if (!projPkg.scripts['debug:metro']) {
      projPkg.scripts['debug:metro'] = 'BROWSER=' + path.join(debuggerDir, 'bin/open-debugger.sh') + ' npx react-native start --reset-cache';
      changed = true;
    }
    if (!projPkg.scripts['debug:remove']) {
      projPkg.scripts['debug:remove'] = 'npx reactoradar remove';
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify(projPkg, null, 2) + '\n');
      log('Added scripts: debug:start, debug:metro, debug:remove');
    } else {
      log('Debug scripts already present');
    }
  }

  // 8. Add .gitignore entry if not present
  const gitignorePath = path.join(projectDir, '.gitignore');
  if (fileExists(gitignorePath)) {
    const gitignore = fs.readFileSync(gitignorePath, 'utf8');
    if (!gitignore.includes('RNDebugSDK')) {
      fs.appendFileSync(gitignorePath, '\n# ReactoRadar SDK (dev only)\nsrc/debug/RNDebugSDK.js\n');
      log('Added RNDebugSDK.js to .gitignore');
    }
  }

  // Summary
  title('Setup Complete!');
  console.log();
  console.log(C.dim + '  Files modified:' + C.reset);
  console.log(C.dim + '    + src/debug/RNDebugSDK.js   (SDK)' + C.reset);
  if (entryFile) console.log(C.dim + '    ~ ' + entryFile + '                (entry patched)' + C.reset);
  console.log();
  // Check if .dmg app is installed
  const dmgInstalled = require('fs').existsSync('/Applications/ReactoRadar.app');

  console.log(C.bold + '  Next steps:' + C.reset);
  if (dmgInstalled) {
    console.log('    1. Start the debugger:  ' + C.cyan + 'open "/Applications/ReactoRadar.app"' + C.reset);
  } else {
    console.log('    1. Start the debugger:  ' + C.cyan + 'npx reactoradar' + C.reset);
    console.log('       ' + C.dim + '(or download .dmg from https://github.com/sharanagouda/reactoradar/releases)' + C.reset);
  }
  console.log('    2. Run your RN app:     ' + C.cyan + 'npx react-native start --reset-cache' + C.reset);
  console.log('    3. Console, Network, Storage auto-connect');
  console.log();
  console.log(C.bold + '  Tip: Open DevTools from simulator → launches ReactoRadar (not Chrome):' + C.reset);
  console.log('    ' + C.cyan + 'BROWSER=' + path.join(debuggerDir, 'bin/open-debugger.sh') + ' npx react-native start' + C.reset);
  console.log();
  if (platform.hasAndroidDevice || platform.hasAndroidEmu) {
    console.log(C.dim + '  Tip: If adb reverse drops, re-run:' + C.reset);
    console.log(C.dim + '    adb reverse tcp:9090 tcp:9090 && adb reverse tcp:9091 tcp:9091 && adb reverse tcp:9092 tcp:9092' + C.reset);
    console.log();
  }
  if (platform.hasIOSDevice) {
    const lanIP = getLanIP();
    console.log(C.bold + '  iOS Real Device:' + C.reset);
    if (lanIP) {
      console.log('    HOST is set to ' + C.cyan + lanIP + C.reset + ' (your Mac\'s LAN IP)');
      console.log('    Ensure your device is on the ' + C.bold + 'same WiFi network' + C.reset + ' as this Mac');
    } else {
      console.log(C.yellow + '    Could not detect LAN IP. Manually set HOST in src/debug/RNDebugSDK.js' + C.reset);
      console.log('    to your Mac\'s IP (e.g., 192.168.1.x). Find it with: ' + C.cyan + 'ifconfig en0' + C.reset);
    }
    console.log();
  }
  // Show LAN IP tip even when no device is connected (for future reference)
  if (!platform.hasIOSDevice && !platform.hasAndroidDevice) {
    const lanIP = getLanIP();
    if (lanIP) {
      console.log(C.dim + '  For real device debugging, change HOST in src/debug/RNDebugSDK.js to: ' + C.cyan + lanIP + C.reset);
      console.log();
    }
  }
  console.log(C.dim + '  To remove: npx reactoradar remove' + C.reset);
  console.log();
}

// ─── Uninstall ───────────────────────────────────────────────────────────────
function uninstall(projectDir) {
  title('ReactoRadar — Uninstall');
  console.log();

  // Remove SDK file
  const sdkPath = path.join(projectDir, 'src', 'debug', 'RNDebugSDK.js');
  if (fileExists(sdkPath)) {
    fs.unlinkSync(sdkPath);
    log('Removed src/debug/RNDebugSDK.js');
    // Remove debug dir if empty
    const debugDir = path.join(projectDir, 'src', 'debug');
    try {
      const remaining = fs.readdirSync(debugDir);
      if (remaining.length === 0) {
        fs.rmdirSync(debugDir);
        log('Removed empty src/debug/ directory');
      }
    } catch {}
  } else {
    warn('SDK file not found — may already be removed');
  }

  // Remove SDK import from entry file
  const entryFile = findEntryFile(projectDir);
  if (entryFile) {
    const entryPath = path.join(projectDir, entryFile);
    let content = fs.readFileSync(entryPath, 'utf8');
    const markerRe = new RegExp(
      escapeRegExp(SDK_MARKER_START) + '[\\s\\S]*?' + escapeRegExp(SDK_MARKER_END) + '\\n?',
      'g'
    );
    const cleaned = content.replace(markerRe, '');
    if (cleaned !== content) {
      fs.writeFileSync(entryPath, cleaned);
      log('Removed SDK import from', C.bold + entryFile + C.reset);
    }
  }

  // Remove from store files
  const storeFile = findStoreFile(projectDir);
  if (storeFile) {
    const storePath = path.join(projectDir, storeFile);
    let content = fs.readFileSync(storePath, 'utf8');

    // Remove marker blocks
    const markerRe = new RegExp(
      escapeRegExp(SDK_MARKER_START) + '[\\s\\S]*?' + escapeRegExp(SDK_MARKER_END) + '\\n?',
      'g'
    );
    let cleaned = content.replace(markerRe, '');

    // Remove inline require of RNDebugSDK in configureStore
    cleaned = cleaned.replace(
      /\s*middleware:\s*\(getDefaultMiddleware\)\s*=>\s*\n?\s*__DEV__\s*\n?\s*\?\s*getDefaultMiddleware\(\)\.concat\(require\(['"]\.\/src\/debug\/RNDebugSDK['"]\)\.reduxMiddleware\)\s*\n?\s*:\s*getDefaultMiddleware\(\),?\n?/g,
      '\n'
    );
    // Clean up double newlines left behind
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    if (cleaned !== content) {
      fs.writeFileSync(storePath, cleaned);
      log('Removed SDK from', C.bold + storeFile + C.reset);
    }
  }

  // Remove .gitignore entry
  const gitignorePath = path.join(projectDir, '.gitignore');
  if (fileExists(gitignorePath)) {
    let gitignore = fs.readFileSync(gitignorePath, 'utf8');
    const cleaned = gitignore.replace(/\n# ReactoRadar SDK \(dev only\)\nsrc\/debug\/RNDebugSDK\.js\n?/g, '');
    if (cleaned !== gitignore) {
      fs.writeFileSync(gitignorePath, cleaned);
      log('Removed from .gitignore');
    }
  }

  title('Uninstall Complete');
  console.log();
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const isUninstall = args.includes('--uninstall') || args.includes('--remove');
  let projectArg = args.find(a => !a.startsWith('--'));

  // If no path given, check if current directory is an RN project
  if (!projectArg) {
    const cwd = process.cwd();
    const cwdPkg = readJSON(path.join(cwd, 'package.json'));
    const cwdDeps = { ...cwdPkg?.dependencies, ...cwdPkg?.devDependencies };
    if (cwdPkg && cwdDeps['react-native']) {
      // Running from inside an RN project — use current directory
      projectArg = cwd;
      info('Detected RN project in current directory:', C.bold + cwdPkg.name + C.reset);
    } else {
      // Not in an RN project — show help
      console.log();
      console.log(C.bold + '  ReactoRadar — Setup CLI' + C.reset);
      console.log();
      console.log('  Run from inside your React Native project:');
      console.log('    ' + C.cyan + 'node /path/to/rn-debug-app/bin/setup.js' + C.reset);
      console.log();
      console.log('  Or specify the path:');
      console.log('    ' + C.cyan + 'node /path/to/rn-debug-app/bin/setup.js /path/to/rn-project' + C.reset);
      console.log('    ' + C.cyan + 'node /path/to/rn-debug-app/bin/setup.js /path/to/rn-project --uninstall' + C.reset);
      console.log();
      process.exit(0);
    }
  }

  const projectDir = path.resolve(projectArg);

  if (!dirExists(projectDir)) {
    err('Directory not found:', projectDir);
    process.exit(1);
  }

  if (isUninstall) {
    uninstall(projectDir);
  } else {
    await install(projectDir);
  }
}

main().catch(e => { err(e.message); process.exit(1); });
