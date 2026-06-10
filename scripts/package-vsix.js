#!/usr/bin/env node
/**
 * Build a COMPLETE .vsix for this extension.
 *
 * Why this script exists
 * ----------------------
 * `vsce` cannot bundle our production deps on its own here:
 *   - `vsce package --no-dependencies` excludes node_modules entirely.
 *   - `vsce package` (without the flag) walks the npm dependency tree, which
 *     fails on this repo's pnpm symlinked node_modules layout.
 * The only runtime dependency that must ship inside the vsix is `solc`
 * (~9 MB of WASM). It is a webpack `external` (see webpack.config.js) that
 * SolcManager lazily `require()`s at runtime. Every other production dep
 * (chokidar, commander, ethers, glob, js-sha3, semver) is bundled INTO
 * dist/extension/extension.js by webpack, so it does not need node_modules.
 *
 * Strategy: let vsce build the bundle + manifest with `--no-dependencies`,
 * then inject a clean, flat install of the runtime externals under
 * `extension/node_modules/` inside the vsix zip.
 *
 * Usage:
 *   node scripts/package-vsix.js            # build <name>-<version>.vsix
 *   node scripts/package-vsix.js --install  # also `code --install-extension`
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const pkg = require(path.join(repoRoot, 'package.json'));

// Webpack `external` deps that are real npm packages required at runtime.
// `ws` is external too, but it is only reached via ethers' WebSocketProvider,
// which we never construct (HTTP-only RPC), so it is intentionally omitted.
// `vscode` is provided by the host; `sqlite3`/`fsevents` are optional natives.
const EXTERNAL_RUNTIME_DEPS = ['solc'];

const vsixName = `${pkg.name}-${pkg.version}.vsix`;
const vsixPath = path.join(repoRoot, vsixName);
const vsceBin = path.join(repoRoot, 'node_modules', '.bin', 'vsce');

const tmpDirs = [];
function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}
function log(msg) {
  process.stdout.write(`\n▸ ${msg}\n`);
}

function main() {
  const doInstall = process.argv.includes('--install');

  // 1. Clean dist so the package never carries stale webpack chunks
  //    (e.g. orphaned splitChunks output from a previous config).
  log('Cleaning dist/');
  fs.rmSync(path.join(repoRoot, 'dist'), { recursive: true, force: true });

  // 2. Package with vsce. Its prepublish step runs `npm run compile`
  //    (fresh webpack build). `--no-dependencies` => no node_modules included.
  log(`Packaging ${vsixName} (vsce --no-dependencies)`);
  if (!fs.existsSync(vsceBin)) {
    throw new Error(`vsce not found at ${vsceBin} — run \`pnpm install\` first.`);
  }
  fs.rmSync(vsixPath, { force: true });
  run(vsceBin, ['package', '--no-dependencies', '-o', vsixName], { cwd: repoRoot });

  // 3. Flat, isolated install of the runtime externals (real dirs, no symlinks).
  const depDir = mkTmp('0xtools-vsix-deps-');
  const deps = {};
  for (const name of EXTERNAL_RUNTIME_DEPS) {
    const range = pkg.dependencies && pkg.dependencies[name];
    if (!range) throw new Error(`${name} is not in package.json dependencies`);
    deps[name] = range;
  }
  fs.writeFileSync(
    path.join(depDir, 'package.json'),
    JSON.stringify({ name: 'vsix-runtime-deps', version: '0.0.0', private: true, dependencies: deps }, null, 2)
  );
  log(`Installing runtime externals flat: ${EXTERNAL_RUNTIME_DEPS.join(', ')}`);
  // --ignore-scripts is safe: modern solc ships soljson.js inside the package.
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: depDir });

  // 4. Stage under `extension/` (the vsix's content prefix) and inject into the zip.
  const stageDir = mkTmp('0xtools-vsix-stage-');
  const stageNm = path.join(stageDir, 'extension', 'node_modules');
  fs.cpSync(path.join(depDir, 'node_modules'), stageNm, { recursive: true, dereference: true });
  for (const junk of ['.bin', '.cache', '.package-lock.json']) {
    fs.rmSync(path.join(stageNm, junk), { recursive: true, force: true });
  }
  log('Injecting node_modules into vsix');
  run('zip', ['-r', '-q', vsixPath, 'extension/node_modules'], { cwd: stageDir });

  // 5. Sanity check: solc must be resolvable inside the vsix.
  const listing = execFileSync('unzip', ['-l', vsixPath], { encoding: 'utf8' });
  if (!/extension\/node_modules\/solc\/soljson\.js/.test(listing)) {
    throw new Error('solc/soljson.js missing from vsix after injection');
  }
  const sizeMB = (fs.statSync(vsixPath).size / 1024 / 1024).toFixed(1);
  log(`Built ${vsixName} (${sizeMB} MB) with solc bundled ✓`);

  // 6. Optionally install into VS Code.
  if (doInstall) {
    log('Installing into VS Code');
    run('code', ['--install-extension', vsixPath, '--force']);
  }
}

try {
  main();
} finally {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
}
