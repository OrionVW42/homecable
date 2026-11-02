'use strict';
// After `electron-builder --win`: make the two small release files the updater
// uses next to the installer —
//   dist/homecable-app-<v>.asar   the app itself (what most updates swap in)
//   dist/homecable-update.json    { version, shell, app:{name,size,sha256}, setup:{name,size} }
// Upload all three (Setup exe + these two) to the GitHub release.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const dist = path.join(root, 'dist');
const res = path.join(dist, 'win-unpacked', 'resources');
const v = pkg.version;

const shell = JSON.parse(fs.readFileSync(path.join(res, 'shell.json'), 'utf8'));
const asarSrc = path.join(res, 'app.asar');
const buf = fs.readFileSync(asarSrc);
const appName = `homecable-app-${v}.asar`;
fs.writeFileSync(path.join(dist, appName), buf);
const setupName = `HomeCable-Setup-${v}.exe`;
const setup = fs.existsSync(path.join(dist, setupName)) ? { name: setupName, size: fs.statSync(path.join(dist, setupName)).size } : null;
const manifest = {
  version: v,
  shell: shell.shell,
  electron: shell.electron,
  app: { name: appName, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') },
  setup,
  built: new Date().toISOString(),
};
fs.writeFileSync(path.join(dist, 'homecable-update.json'), JSON.stringify(manifest, null, 2));
console.log(`update files for v${v}: ${appName} (${(buf.length / 1e6).toFixed(1)} MB), homecable-update.json (shell ${shell.shell})`);
