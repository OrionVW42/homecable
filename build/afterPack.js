'use strict';
// electron-builder afterPack: stamp resources/shell.json with the "shell" id —
// a hash of everything that ships besides the app file itself (Electron's
// version, FFmpeg, Whisper, the bundled ads). The updater compares it with a
// release's manifest: same id → just swap in the new app file; different →
// that release needs the full installer. (src/boot/core.js)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKIP = new Set(['app.asar', 'app-update.yml', 'shell.json']);

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (!rel.includes('/') && SKIP.has(e.name)) continue;
    if (e.isDirectory()) walk(full, base, out);
    else out.push([rel, full]);
  }
}

function shellOf(resources, electronVersion) {
  const files = [];
  walk(resources, resources, files);
  const h = crypto.createHash('sha256');
  h.update(`electron ${electronVersion}\n`);
  for (const [rel, full] of files) {
    const fh = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    h.update(`${rel} ${fh}\n`);
  }
  return { shell: h.digest('hex').slice(0, 32), electron: electronVersion, files: files.length };
}

exports.default = async function afterPack(context) {
  const resources = path.join(context.appOutDir, 'resources');
  const electronVersion = context.packager.config.electronVersion || require('electron/package.json').version;
  const s = shellOf(resources, electronVersion);
  fs.writeFileSync(path.join(resources, 'shell.json'), JSON.stringify(s, null, 2));
  console.log(`  • shell id ${s.shell} (electron ${s.electron}, ${s.files} files)`);
};
exports.shellOf = shellOf;
