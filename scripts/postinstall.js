#!/usr/bin/env node

/**
 * postinstall.js - Downloads the prebuilt sigscan-runner binary for the
 * current platform. This script runs as a postinstall hook and is designed
 * to fail silently since the runner binary is optional (the extension can
 * fall back to forge or solc-js for gas estimation).
 *
 * Platform mapping:
 *   darwin-arm64  -> sigscan-runner-darwin-arm64
 *   darwin-x64    -> sigscan-runner-darwin-x64
 *   linux-x64     -> sigscan-runner-linux-x64
 *   linux-arm64   -> sigscan-runner-linux-arm64
 *   win32-x64     -> sigscan-runner-win32-x64.exe
 *
 * Uses only Node built-in modules (https, fs, path, os).
 */

'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GITHUB_OWNER = 'DevJSter';
const GITHUB_REPO = 'sigScan';
const RELEASE_TAG = 'latest';
const BASE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/${RELEASE_TAG}/download`;

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 60000; // 60 seconds

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

function getBinaryName() {
  const platform = process.platform;
  const arch = process.arch;

  const key = `${platform}-${arch}`;

  const platformMap = {
    'darwin-arm64': 'sigscan-runner-darwin-arm64',
    'darwin-x64': 'sigscan-runner-darwin-x64',
    'linux-x64': 'sigscan-runner-linux-x64',
    'linux-arm64': 'sigscan-runner-linux-arm64',
    'win32-x64': 'sigscan-runner-win32-x64.exe',
  };

  const binaryName = platformMap[key];
  if (!binaryName) {
    console.log(`[sigscan] No prebuilt binary available for ${key}. Skipping download.`);
    console.log('[sigscan] You can build from source: cd runner && cargo build --release');
    return null;
  }

  return binaryName;
}

function getOutputPath() {
  const isWindows = process.platform === 'win32';
  const binDir = path.join(__dirname, '..', 'bin');
  const outputName = isWindows ? 'sigscan-runner.exe' : 'sigscan-runner';
  return path.join(binDir, outputName);
}

// ---------------------------------------------------------------------------
// Download with redirect following
// ---------------------------------------------------------------------------

/**
 * Download a file from a URL, following redirects.
 * Returns a Promise that resolves to a Buffer.
 */
function download(url, redirectCount) {
  if (redirectCount === undefined) {
    redirectCount = 0;
  }

  if (redirectCount > MAX_REDIRECTS) {
    return Promise.reject(new Error('Too many redirects'));
  }

  return new Promise(function (resolve, reject) {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const request = transport.get(url, { timeout: TIMEOUT_MS }, function (response) {
      const statusCode = response.statusCode;

      // Handle redirects (301, 302, 303, 307, 308)
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        const redirectUrl = response.headers.location;
        // Consume the response body to free resources
        response.resume();
        resolve(download(redirectUrl, redirectCount + 1));
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        reject(new Error('HTTP ' + statusCode + ' for ' + url));
        return;
      }

      const chunks = [];
      response.on('data', function (chunk) {
        chunks.push(chunk);
      });
      response.on('end', function () {
        resolve(Buffer.concat(chunks));
      });
      response.on('error', reject);
    });

    request.on('error', reject);
    request.on('timeout', function () {
      request.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const binaryName = getBinaryName();
  if (!binaryName) {
    process.exit(0);
  }

  const outputPath = getOutputPath();
  const downloadUrl = `${BASE_URL}/${binaryName}`;

  // Skip if binary already exists and is executable
  if (fs.existsSync(outputPath)) {
    try {
      fs.accessSync(outputPath, fs.constants.X_OK);
      console.log(`[sigscan] Runner binary already exists at ${outputPath}. Skipping download.`);
      process.exit(0);
    } catch {
      // Exists but not executable, re-download
    }
  }

  console.log(`[sigscan] Downloading runner binary: ${binaryName}`);
  console.log(`[sigscan] URL: ${downloadUrl}`);

  try {
    const data = await download(downloadUrl);

    // Ensure bin directory exists
    const binDir = path.dirname(outputPath);
    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true });
    }

    // Write the binary
    fs.writeFileSync(outputPath, data);

    // Set executable permissions (skip on Windows)
    if (process.platform !== 'win32') {
      fs.chmodSync(outputPath, 0o755);
    }

    console.log(`[sigscan] Runner binary saved to ${outputPath}`);
    console.log(`[sigscan] Size: ${(data.length / 1024 / 1024).toFixed(1)} MB`);
  } catch (error) {
    // Fail silently - the runner is optional
    console.log(`[sigscan] Could not download runner binary: ${error.message}`);
    console.log('[sigscan] This is not critical - the extension will use forge or solc-js instead.');
    console.log('[sigscan] To build from source: cd runner && cargo build --release');
    process.exit(0);
  }
}

main().catch(function (error) {
  // Catch-all to ensure we never fail the install
  console.log(`[sigscan] Postinstall error: ${error.message}`);
  process.exit(0);
});
