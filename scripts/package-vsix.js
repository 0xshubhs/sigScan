#!/usr/bin/env node
/**
 * Build the .vsix for this extension.
 *
 * Every production dependency (chokidar, commander, ethers, glob, js-sha3,
 * semver, solc/wrapper, @openchainxyz/abi-guesser) is bundled INTO
 * dist/extension/extension.js by webpack, so the vsix ships NO node_modules.
 *
 * The full `solc` npm package (with its ~9 MB bundled soljson WASM) stays a
 * webpack external and is deliberately NOT shipped: SolcManager downloads the
 * exact compiler a project needs from binaries.soliditylang.org on first use
 * (keccak-verified, cached in globalStorage), and `require('solc')` failing
 * inside the packaged extension simply disables the offline-bundled fallback.
 *
 * After a successful build the vsix is also published to the landing site
 * (website/public/downloads/, with VERSION/VSIX_SIZE synced in app/page.tsx)
 * and installed into VS Code.
 *
 * Usage:
 *   node scripts/package-vsix.js               # build + publish to website + install
 *   node scripts/package-vsix.js --no-install  # skip `code --install-extension`
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const pkg = require(path.join(repoRoot, 'package.json'));

const vsixName = `${pkg.name}-${pkg.version}.vsix`;
const vsixPath = path.join(repoRoot, vsixName);
const vsceBin = path.join(repoRoot, 'node_modules', '.bin', 'vsce');

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}
function log(msg) {
  process.stdout.write(`\n▸ ${msg}\n`);
}

// Copy the fresh vsix into the landing site's downloads folder, drop stale
// versions, and keep the VERSION/VSIX_SIZE constants in app/page.tsx in sync
// so the site's buttons always point at the file that actually exists.
function publishToWebsite() {
  const downloadsDir = path.join(repoRoot, 'website', 'public', 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });
  for (const f of fs.readdirSync(downloadsDir)) {
    if (f.endsWith('.vsix') && f !== vsixName) fs.rmSync(path.join(downloadsDir, f));
  }
  fs.copyFileSync(vsixPath, path.join(downloadsDir, vsixName));

  const pagePath = path.join(repoRoot, 'website', 'app', 'page.tsx');
  const sizeKB = `${Math.round(fs.statSync(vsixPath).size / 1024)} KB`;
  let page = fs.readFileSync(pagePath, 'utf8');
  page = page
    .replace(/const VERSION = "[^"]*";/, `const VERSION = "${pkg.version}";`)
    .replace(/const VSIX_SIZE = "[^"]*";/, `const VSIX_SIZE = "${sizeKB}";`)
    .replace(/\["\d+ KB", "WHOLE VSIX"\]/, `["${sizeKB}", "WHOLE VSIX"]`);
  fs.writeFileSync(pagePath, page);
  log(`Published to website/public/downloads/${vsixName} (page.tsx → v${pkg.version}, ${sizeKB})`);
}

function main() {
  const doInstall = !process.argv.includes('--no-install');

  // 1. Clean dist so the package never carries stale webpack chunks.
  log('Cleaning dist/');
  fs.rmSync(path.join(repoRoot, 'dist'), { recursive: true, force: true });

  // 2. Package with vsce. Its prepublish step runs `npm run compile`
  //    (fresh webpack build). `--no-dependencies` => no node_modules included.
  log(`Packaging ${vsixName} (vsce --no-dependencies)`);
  if (!fs.existsSync(vsceBin)) {
    throw new Error(`vsce not found at ${vsceBin} — run \`npm install\` first.`);
  }
  fs.rmSync(vsixPath, { force: true });
  run(vsceBin, ['package', '--no-dependencies', '-o', vsixName], { cwd: repoRoot });

  // 3. Sanity checks: the bundle must be present; the 9 MB soljson must NOT be.
  const listing = execFileSync('unzip', ['-l', vsixPath], { encoding: 'utf8' });
  if (!/extension\/dist\/extension\/extension\.js/.test(listing)) {
    throw new Error('dist/extension/extension.js missing from vsix');
  }
  if (/soljson/.test(listing)) {
    throw new Error('A soljson compiler leaked into the vsix — it must stay download-on-demand');
  }
  if (/node_modules/.test(listing)) {
    throw new Error('node_modules leaked into the vsix — all runtime deps must be webpack-bundled');
  }
  const sizeMB = (fs.statSync(vsixPath).size / 1024 / 1024).toFixed(1);
  log(`Built ${vsixName} (${sizeMB} MB, solc downloads on demand) ✓`);

  // 4. Publish to the landing site.
  publishToWebsite();

  // 5. Install into VS Code (skip with --no-install).
  if (doInstall) {
    log('Installing into VS Code');
    try {
      run('code', ['--install-extension', vsixPath, '--force']);
    } catch (err) {
      log(`VS Code install failed (${err.message}) — vsix is still built and published`);
    }
  }
}

main();
