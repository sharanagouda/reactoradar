#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', magenta: '\x1b[35m',
};

const args = process.argv.slice(2);
const command = args[0] || 'start';
const appDir = path.resolve(__dirname, '..');

// electron is a devDependency (electron-builder requires that), so `npx reactoradar`
// doesn't get it installed automatically. It's installed on demand into a directory
// of its own — never into appDir, since appDir's own package.json lists build-only
// devDependencies (electron-builder, electron-devtools-installer) that `npm install`
// would reconcile and install alongside it. Persisting the side install means
// electron is only ever downloaded once per machine, not on every fresh npx run.
const electronRuntimeDir = path.join(os.homedir(), '.reactoradar', 'electron-runtime');

function findElectronBin() {
  const appDirBin = path.join(appDir, 'node_modules', '.bin', 'electron');
  if (fs.existsSync(appDirBin)) return appDirBin;
  const sideBin = path.join(electronRuntimeDir, 'node_modules', '.bin', 'electron');
  if (fs.existsSync(sideBin)) return sideBin;
  return null;
}

function installElectron() {
  console.log(C.yellow + '  Installing electron (first run only)...' + C.reset);
  const pkg = require(path.join(appDir, 'package.json'));
  const electronRange = (pkg.devDependencies && pkg.devDependencies.electron) || 'latest';
  fs.mkdirSync(electronRuntimeDir, { recursive: true });
  const sidePkgPath = path.join(electronRuntimeDir, 'package.json');
  if (!fs.existsSync(sidePkgPath)) {
    fs.writeFileSync(sidePkgPath, JSON.stringify({ name: 'reactoradar-electron-runtime', private: true }));
  }
  execSync(`npm install electron@${electronRange} --no-save --no-audit --no-fund`, {
    cwd: electronRuntimeDir,
    stdio: 'inherit',
  });
  return path.join(electronRuntimeDir, 'node_modules', '.bin', 'electron');
}

function printHelp() {
  console.log();
  console.log(C.bold + C.magenta + '  ReactoRadar' + C.reset + ' — React Native debugging tool');
  console.log();
  console.log('  Usage:');
  console.log(`    ${C.cyan}npx rn-debugger${C.reset}              Launch the debugger app`);
  console.log(`    ${C.cyan}npx rn-debugger setup${C.reset}        Install SDK into current RN project`);
  console.log(`    ${C.cyan}npx rn-debugger remove${C.reset}       Remove SDK from current RN project`);
  console.log(`    ${C.cyan}npx rn-debugger help${C.reset}         Show this help`);
  console.log();
  console.log('  Or add to your RN project\'s package.json:');
  console.log(`    ${C.dim}"debug:setup": "npx rn-debugger setup"${C.reset}`);
  console.log(`    ${C.dim}"debug:start": "npx rn-debugger"${C.reset}`);
  console.log(`    ${C.dim}"debug:remove": "npx rn-debugger remove"${C.reset}`);
  console.log();
}

switch (command) {
  case 'start':
  case 'launch':
  case 'open': {
    const electronPath = findElectronBin() || installElectron();
    console.log(C.green + '  Launching ReactoRadar...' + C.reset);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath, [appDir], { env, stdio: 'inherit', detached: true });
    child.unref();
    break;
  }

  case 'setup':
  case 'init':
  case 'install': {
    const setupScript = path.join(appDir, 'bin', 'setup.js');
    const projectPath = args[1] || process.cwd();
    // Set argv BEFORE requiring setup.js so it reads the correct path
    process.argv = [process.argv[0], setupScript, projectPath];
    require(setupScript);
    break;
  }

  case 'remove':
  case 'uninstall': {
    const setupScript = path.join(appDir, 'bin', 'setup.js');
    const projectPath = args[1] || process.cwd();
    process.argv = [process.argv[0], setupScript, projectPath, '--uninstall'];
    require(setupScript);
    break;
  }

  case 'help':
  case '--help':
  case '-h':
  default:
    printHelp();
    break;
}
