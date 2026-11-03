'use strict';
// The update engine, shared by the launcher (src/boot/boot.js — the little
// updater window at start) and the running app (src/main/updater.js — quiet
// background checks + "Update now").
//
// How an update works — like Discord, not like a reinstall:
//   * Every release publishes, next to the full installer, the app itself as
//     one small file (homecable-app-<v>.asar, a few MB) plus a manifest
//     (homecable-update.json: version, sha256, size, and the "shell" id).
//   * The shell is everything that is NOT the app file: Electron, FFmpeg,
//     Whisper, the bundled ads. Its id is a hash written at build time into
//     resources/shell.json. Same shell id → only the app file changed → it is
//     downloaded, checked (sha256) and put beside the others in
//     %LOCALAPPDATA%\HomeCable\app-versions\<v>\app.asar. Nothing installed is
//     overwritten, nothing is uninstalled, and the next start simply runs it.
//   * Different shell id (Electron itself changed — rare) → the full installer
//     is downloaded and run silently from the updater window instead.
//   * A new version that fails to start is marked bad and the previous one
//     runs again by itself.
const path = require('path');
const crypto = require('crypto');
// Electron's patched fs treats *.asar files as folders; the plain one doesn't.
let fs; try { fs = require('original-fs'); } catch { fs = require('fs'); }

const MANIFEST = 'homecable-update.json';
const MAX_APP = 512 * 1024 * 1024; // sanity caps
const MAX_EXE = 1024 * 1024 * 1024;

const parseVer = (v) => String(v || '').trim().replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
const newer = (a, b) => { // true when version a is newer than b
  const x = parseVer(a), y = parseVer(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
const validVer = (v) => /^\d+\.\d+\.\d+$/.test(String(v || ''));

const api = () => process.env.HOMECABLE_UPDATE_API || 'https://api.github.com';
function okHost(url) {
  if (process.env.HOMECABLE_UPDATE_API) return true; // a mock server in tests
  try {
    const h = new URL(url).hostname;
    return h === 'github.com' || h === 'api.github.com' || h.endsWith('.githubusercontent.com');
  } catch { return false; }
}

// Where downloaded app versions live. Outside the program folder so it works
// for per-machine installs too, and never roams with the profile.
function versionsDir() {
  if (process.env.HOMECABLE_VERSIONS_DIR) return process.env.HOMECABLE_VERSIONS_DIR;
  const base = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
  return path.join(base, 'HomeCable', 'app-versions');
}

// The installed shell's id (written by build/afterPack.js). null in dev, where
// there is no shell to match — so dev builds never take app-file updates.
function shellId() {
  if (process.env.HOMECABLE_SHELL) return process.env.HOMECABLE_SHELL;
  try { return JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'shell.json'), 'utf8')).shell || null; } catch { return null; }
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2));
  fs.renameSync(f + '.tmp', f);
}

// ---- asking GitHub ---------------------------------------------------------

async function getJson(url, version, timeoutMs) {
  const res = await fetch(url, {
    headers: { 'User-Agent': `HomeCable/${version}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(timeoutMs || 8000), redirect: 'follow',
  });
  if (!res.ok) throw new Error(`GitHub said ${res.status}`);
  return res.json();
}

// The newest release, or null when it isn't newer than `current`.
// → { version, notes, setup:{url,size,name}|null, app:{url,size,sha256,name,shell}|null }
async function latest({ repo, current, timeoutMs, any = false }) { // any: even if not newer (repairs)
  if (!repo) return null;
  const rel = await getJson(`${api()}/repos/${repo}/releases/latest`, current, timeoutMs);
  const version = String(rel.tag_name || '').replace(/^v/i, '');
  if (!validVer(version) || (!any && !newer(version, current))) return null;
  const assets = rel.assets || [];
  const setupA = assets.find((a) => /^HomeCable-Setup-.*\.exe$/i.test(a.name || ''));
  const manA = assets.find((a) => a.name === MANIFEST);
  let app = null;
  if (manA && okHost(manA.browser_download_url)) {
    try {
      const m = await getJson(manA.browser_download_url, current, timeoutMs);
      const appA = assets.find((a) => a.name === m?.app?.name);
      if (m.version === version && appA && /^[0-9a-f]{64}$/.test(m.app.sha256 || '') && m.shell) {
        app = { url: appA.browser_download_url, size: m.app.size || appA.size || 0, sha256: m.app.sha256, name: appA.name, shell: m.shell };
      }
    } catch { /* no usable manifest → full installer */ }
  }
  const setup = setupA ? { url: setupA.browser_download_url, size: setupA.size || 0, name: setupA.name } : null;
  if (!app && !setup) return null;
  return { version, notes: String(rel.body || '').slice(0, 4000), setup, app };
}

// What it takes to get there from this install.
function plan(info, shell) {
  if (!info) return null;
  if (info.app && shell && info.app.shell === shell) return { kind: 'app', size: info.app.size };
  if (info.setup) return { kind: 'installer', size: info.setup.size };
  return null;
}

// ---- downloading -----------------------------------------------------------

// Stream to disk with progress; verify size (and sha256 when given) before the
// file takes its real name. Throws on anything wrong — a half file never counts.
async function download(url, dest, { size, sha256, version, onProgress, max, signal } = {}) {
  if (!okHost(url)) throw new Error('update host not allowed: ' + url);
  if (size && size > (max || MAX_EXE)) throw new Error('update too big');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  const res = await fetch(url, { headers: { 'User-Agent': `HomeCable/${version || '0'}` }, redirect: 'follow', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30 * 60e3)]) : AbortSignal.timeout(30 * 60e3) });
  if (!res.ok || !res.body) throw new Error(`download said ${res.status}`);
  const total = size || +res.headers.get('content-length') || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.openSync(part, 'w');
  let got = 0, lastTick = 0;
  try {
    for await (const chunk of res.body) {
      const b = Buffer.from(chunk);
      fs.writeSync(out, b); hash.update(b); got += b.length;
      if (got > (max || MAX_EXE)) throw new Error('update too big');
      const now = Date.now();
      if (onProgress && (now - lastTick > 120 || got === total)) { lastTick = now; onProgress(got, total); }
    }
  } catch (e) { fs.closeSync(out); try { fs.rmSync(part, { force: true }); } catch {} throw e; }
  fs.closeSync(out);
  try {
    if (size && got !== size) throw new Error(`download incomplete (${got}/${size})`);
    if (sha256 && hash.digest('hex') !== sha256) throw new Error('download damaged (checksum mismatch)');
  } catch (e) { try { fs.rmSync(part, { force: true }); } catch {} throw e; }
  fs.rmSync(dest, { force: true });
  fs.renameSync(part, dest);
  onProgress?.(got, total || got);
  return got;
}

// ---- the versions on this PC ----------------------------------------------
// app-versions\
//   state.json            { trial:{version,boots}, bad:[...], good }
//   1.4.9\app.asar        the app file
//   1.4.9\meta.json       { version, shell, size, sha256, notes, at }

const stateFile = () => path.join(versionsDir(), 'state.json');
const readState = () => ({ bad: [], ...readJson(stateFile(), {}) });
const writeState = (s) => writeJson(stateFile(), s);

// Downloaded versions that belong to this shell and look intact.
function installed(shell) {
  const root = versionsDir();
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!validVer(n)) continue;
    const meta = readJson(path.join(root, n, 'meta.json'), null);
    const asar = path.join(root, n, 'app.asar');
    let st = null; try { st = fs.statSync(asar); } catch {}
    if (!meta || meta.version !== n || !st || (meta.size && st.size !== meta.size)) continue;
    dropLink(path.join(root, n, 'app.asar.unpacked')); // 1.4.10-1.4.11 put a link here: take it away (see below)
    out.push({ version: n, dir: asar, shell: meta.shell, notes: meta.notes || '', matches: !!shell && meta.shell === shell });
  }
  return out.sort((a, b) => (newer(a.version, b.version) ? -1 : 1));
}

// 1.4.10 and 1.4.11 gave each downloaded version a link (a junction) to the installed
// program's ffmpeg folder. Cleaning up an old version once emptied that REAL folder
// (1.4.11, 2026-11-02: no channel would play). ffmpeg is found in the installed folder
// directly (src/main/ffmpeg.js), so no links are made any more, and the old ones are
// removed in a way that can only remove a link: rmdir takes away a junction, and fails —
// harmlessly — on a real folder that still has files in it.
function dropLink(p) {
  try {
    fs.readlinkSync(p); // only links have a target; a real folder throws here
    try { fs.rmdirSync(p); } catch { fs.unlinkSync(p); }
  } catch {}
}
// Remove one version's folder WITHOUT ever recursing: its link (if any), its own files,
// then the folder itself only if it is empty. Anything unexpected is simply left.
function removeVersionDir(dir) {
  dropLink(path.join(dir, 'app.asar.unpacked'));
  let names = []; try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = path.join(dir, n);
    try { if (fs.lstatSync(p).isFile()) fs.unlinkSync(p); } catch {}
  }
  try { fs.rmdirSync(dir); } catch {}
}

// Download one app version into place (used by both the window and the app).
async function fetchApp(info, { current, onProgress, signal } = {}) {
  const dir = path.join(versionsDir(), info.version);
  const asar = path.join(dir, 'app.asar');
  const size = await download(info.app.url, asar, { size: info.app.size, sha256: info.app.sha256, version: current, onProgress, signal, max: MAX_APP });
  writeJson(path.join(dir, 'meta.json'), { version: info.version, shell: info.app.shell, size, sha256: info.app.sha256, notes: info.notes || '', at: Date.now() });
  const st = readState();
  st.bad = (st.bad || []).filter((v) => v !== info.version); // a fresh copy gets a fresh chance
  writeState(st);
  return { version: info.version, dir: asar };
}

// Which app to run: the newest of the built-in one and the downloaded ones that
// fit this shell and haven't failed. A version on trial that already got two
// starts without ever opening its window is marked bad here.
function pick({ builtin, shell }) {
  const st = readState();
  if (st.trial && (st.trial.boots || 0) >= 2) {
    st.bad = [...new Set([...(st.bad || []), st.trial.version])];
    st.failed = { version: st.trial.version, at: Date.now() };
    st.trial = null; writeState(st);
  }
  let best = { version: builtin.version, dir: builtin.dir, builtin: true };
  for (const v of installed(shell)) {
    if (!v.matches || (st.bad || []).includes(v.version)) continue;
    if (newer(v.version, best.version)) { best = { version: v.version, dir: v.dir, builtin: false, notes: v.notes }; break; }
  }
  return best;
}

// Starting `version` now: count the try until the app says its window is up.
function beginTrial(version) {
  const st = readState();
  if (st.good === version) return;
  if (st.trial?.version === version) st.trial.boots = (st.trial.boots || 0) + 1;
  else st.trial = { version, boots: 1 };
  writeState(st);
}
function markGood(version) {
  const st = readState();
  const changed = st.good !== version || st.trial;
  st.good = version; st.trial = null;
  if (changed) writeState(st);
}
function markBad(version, why) {
  const st = readState();
  st.bad = [...new Set([...(st.bad || []), version])];
  st.failed = { version, why: String(why || '').slice(0, 300), at: Date.now() };
  if (st.trial?.version === version) st.trial = null;
  writeState(st);
}

// Keep what's running, the newest, and one to fall back on; drop the rest
// (and anything built for another shell — a full install made those useless).
function tidy({ keep = [], shell }) {
  const all = installed(shell);
  const fits = all.filter((v) => v.matches);
  const save = new Set([...keep, ...fits.slice(0, 2).map((v) => v.version)]);
  const root = versionsDir();
  let names = []; try { names = fs.readdirSync(root); } catch {}
  for (const n of names) {
    const p = path.join(root, n);
    if (n === 'state.json' || n === 'installer' || save.has(n)) continue;
    try { if (fs.lstatSync(p).isDirectory()) removeVersionDir(p); } catch {}
  }
}

// ---- the full installer (only when Electron itself changed) -----------------

const installerDir = () => path.join(versionsDir(), 'installer');
const pendingFile = () => path.join(installerDir(), 'pending.json');

async function fetchInstaller(info, { current, onProgress, signal } = {}) {
  const file = path.join(installerDir(), info.setup.name);
  try { for (const f of fs.readdirSync(installerDir())) if (f !== info.setup.name) fs.rmSync(path.join(installerDir(), f), { force: true, recursive: true }); } catch {}
  const size = await download(info.setup.url, file, { size: info.setup.size, version: current, onProgress, signal, max: MAX_EXE });
  const p = { version: info.version, file, size, notes: info.notes || '', at: Date.now(), tries: 0 };
  writeJson(pendingFile(), p);
  return p;
}
function pendingInstaller(current) {
  const p = readJson(pendingFile(), null);
  if (!p) return null;
  let ok = false; try { ok = fs.statSync(p.file).size === p.size; } catch {}
  if (!ok || !newer(p.version, current) || (p.tries || 0) >= 2) { dropInstaller(); return null; }
  return p;
}
function dropInstaller() { try { fs.rmSync(installerDir(), { recursive: true, force: true }); } catch {} }

// Run the silent installer once this app has closed, then start the new one.
// A windowless helper (wscript): no console box, nothing to click.
function runInstaller(p, exePath) {
  p.tries = (p.tries || 0) + 1; writeJson(pendingFile(), p);
  if (process.env.HOMECABLE_NO_INSTALL) {
    fs.writeFileSync(path.join(installerDir(), 'apply-attempt.txt'), `${p.version}`);
    return true;
  }
  const vbs = path.join(installerDir(), 'apply-update.vbs');
  fs.writeFileSync(vbs, [
    'WScript.Sleep 2500',
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${p.file}"" /S --updated", 0, True`,
    `sh.Run """${exePath}""", 1, False`,
  ].join('\r\n'));
  require('child_process').spawn('wscript.exe', ['//B', '//Nologo', vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return true;
}

// ---- Windows "Installed apps" ----------------------------------------------
// After an app-file update the version Windows shows would still be the old
// one; set it on our own uninstall entry (per-user installs; per-machine ones
// need admin, so those quietly keep the installer's number).
function syncWindowsVersion(version, exePath, log) {
  if (process.platform !== 'win32' || process.env.HOMECABLE_NO_REG) return;
  const { execFile } = require('child_process');
  const root = process.env.HOMECABLE_REG_KEY || 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
  execFile('reg', ['query', root, '/s', '/f', 'HomeCable', '/d', '/e'], { windowsHide: true }, (err, out) => {
    if (err && !out) return;
    const keys = String(out).split(/\r?\n/).filter((l) => /^HKEY_/i.test(l.trim())).map((l) => l.trim());
    const exeDir = path.dirname(exePath).toLowerCase();
    for (const k of keys) {
      execFile('reg', ['query', k], { windowsHide: true }, (e2, o2) => {
        const txt = String(o2 || '');
        const cur = (txt.match(/DisplayVersion\s+REG_SZ\s+(\S+)/) || [])[1];
        const loc = ((txt.match(/UninstallString\s+REG_(?:EXPAND_)?SZ\s+(.+)/) || [])[1] || '').trim().toLowerCase();
        if (!/DisplayName\s+REG_SZ\s+HomeCable\s*$/m.test(txt) || cur === version) return;
        if (loc && !loc.includes(exeDir) && !process.env.HOMECABLE_REG_KEY) return;
        execFile('reg', ['add', k, '/v', 'DisplayVersion', '/d', version, '/f'], { windowsHide: true }, (e3) => {
          if (!e3) log?.(`Windows now lists HomeCable as ${version}`);
        });
      });
    }
  });
}

module.exports = {
  MANIFEST, newer, parseVer, validVer, okHost, versionsDir, shellId, readJson, writeJson,
  latest, plan, download, installed, fetchApp, pick, beginTrial, markGood, markBad, readState, tidy,
  fetchInstaller, pendingInstaller, dropInstaller, runInstaller, syncWindowsVersion, dropLink, removeVersionDir,
};
