'use strict';
// In-app updates, straight from GitHub Releases — no update server, no accounts.
// check():   GET api.github.com/repos/<owner/repo>/releases/latest (title only,
//            a plain User-Agent, nothing identifying) and compare versions.
// download(): stream the HomeCable-Setup-*.exe asset quietly to userData/updates
//            while whatever's playing keeps playing.
// applyPending(): on quit (and at boot, in case quit never ran) start the saved
//            installer silently (/S keeps channels & settings) and relaunch.
// Test hooks: HOMECABLE_UPDATE_API points the check at a mock server;
//            HOMECABLE_NO_INSTALL writes updates/apply-attempt.txt instead of installing.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const API = process.env.HOMECABLE_UPDATE_API || 'https://api.github.com';
const EVERY_MS = { start: 0, '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3 };
const MAX_EXE = 1024 * 1024 * 1024; // sanity cap on the installer size (1 GB)

const parseVer = (v) => String(v || '').trim().replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
const newer = (a, b) => { // true when version a is newer than b
  const x = parseVer(a), y = parseVer(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

function okHost(url) {
  if (process.env.HOMECABLE_UPDATE_API) return true; // mock server in tests
  try {
    const h = new URL(url).hostname;
    return h === 'github.com' || h === 'api.github.com' || h === 'objects.githubusercontent.com' || h.endsWith('.githubusercontent.com');
  } catch { return false; }
}

function createUpdater({ app, log, send, settings, saveSettings }) {
  const dir = () => path.join(app.getPath('userData'), 'updates');
  const state = { checking: false, downloading: false, latest: null, error: null, lastCheck: 0 };

  const repo = () => {
    const s = settings();
    if (s.updateRepo && /^[\w.-]+\/[\w.-]+$/.test(s.updateRepo)) return s.updateRepo;
    try { return require('../../package.json').homecable.github; } catch { return null; }
  };

  // Ask GitHub what the newest release is. Returns {version,url,size,name} when
  // it's newer than what's running, null otherwise.
  async function check() {
    const r = repo();
    if (!r) return null;
    state.checking = true; state.error = null;
    try {
      const res = await fetch(`${API}/repos/${r}/releases/latest`, {
        headers: { 'User-Agent': `HomeCable/${app.getVersion()}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000), redirect: 'follow',
      });
      if (!res.ok) throw new Error(`GitHub said ${res.status}`);
      const rel = await res.json();
      const version = String(rel.tag_name || '').replace(/^v/i, '');
      const asset = (rel.assets || []).find((a) => /^HomeCable-Setup-.*\.exe$/i.test(a.name || ''));
      state.lastCheck = Date.now();
      const s = settings(); s.lastUpdateCheck = Date.now(); saveSettings();
      if (!asset || !newer(version, app.getVersion())) { state.latest = null; return null; }
      state.latest = { version, url: asset.browser_download_url, size: asset.size || 0, name: asset.name };
      return state.latest;
    } catch (e) {
      state.error = e.message; log('update check:', e.message); return null;
    } finally { state.checking = false; }
  }

  // Quietly pull the installer down. Nothing on screen; playback is untouched.
  async function download(info) {
    if (!okHost(info.url)) throw new Error('update host not allowed: ' + info.url);
    if (info.size > MAX_EXE) throw new Error('update too big');
    fs.rmSync(dir(), { recursive: true, force: true });
    fs.mkdirSync(dir(), { recursive: true });
    const file = path.join(dir(), info.name);
    state.downloading = true;
    try {
      const res = await fetch(info.url, { headers: { 'User-Agent': `HomeCable/${app.getVersion()}` }, redirect: 'follow' });
      if (!res.ok) throw new Error(`download said ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (info.size && buf.length !== info.size) throw new Error(`download incomplete (${buf.length}/${info.size})`);
      fs.writeFileSync(file + '.part', buf);
      fs.renameSync(file + '.part', file);
      const s = settings();
      s.pendingUpdate = { version: info.version, file, size: buf.length, at: Date.now(), tries: 0 };
      saveSettings();
      log('update downloaded:', info.version, `(${(buf.length / 1e6).toFixed(0)} MB) — installs on the next restart`);
      return true;
    } finally { state.downloading = false; }
  }

  // One full quiet cycle: check, say so once (top-left, briefly), download.
  let running = null;
  function run(reason) {
    if (running) return running;
    running = (async () => {
      try {
        const info = await check();
        if (!info) return null;
        const s = settings();
        if (s.pendingUpdate?.version === info.version && fs.existsSync(s.pendingUpdate.file || '')) return info; // already ready
        if (s.updateNotify !== false && s.updateNotified !== info.version) {
          s.updateNotified = info.version; saveSettings();
          send('update-toast', { version: info.version });
        }
        if (!state.downloading) await download(info);
        return info;
      } catch (e) { state.error = e.message; log('update:', e.message); return null; }
      finally { running = null; }
    })();
    return running;
  }

  // Start the downloaded installer and get out of its way. Returns true when the
  // caller should quit (boot path); at quit it just fires and the app exits anyway.
  function applyPending(when) {
    const s = settings();
    const p = s.pendingUpdate;
    if (!p || !p.file) return false;
    const drop = (why) => { log('update dropped:', why); s.pendingUpdate = null; saveSettings(); try { fs.rmSync(dir(), { recursive: true, force: true }); } catch {} return false; };
    if (!newer(p.version, app.getVersion())) return drop('already on ' + app.getVersion());
    if (!fs.existsSync(p.file) || (p.size && fs.statSync(p.file).size !== p.size)) return drop('installer missing or damaged');
    if (process.env.HOMECABLE_NO_INSTALL) {
      fs.writeFileSync(path.join(dir(), 'apply-attempt.txt'), `${p.version} ${when}`);
      return false;
    }
    if (!app.isPackaged) { log('update ready (dev build — not installing):', p.version); return false; }
    if ((p.tries || 0) >= 2) return drop('installer ran twice without updating');
    p.tries = (p.tries || 0) + 1; saveSettings();
    // A tiny batch: wait for the app to close, install silently (keeps channels,
    // people and settings — the installer's silent default), then start the new one.
    const bat = path.join(dir(), 'apply-update.cmd');
    fs.writeFileSync(bat, [
      '@echo off',
      'ping -n 4 127.0.0.1 >nul',
      `"${p.file}" /S`,
      `start "" "${process.execPath}"`,
    ].join('\r\n'));
    try {
      spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      log('update installing on exit:', p.version, `(${when})`);
      return true;
    } catch (e) { log('update spawn failed:', e.message); return false; }
  }

  // First boot of the day (or whenever the chosen interval has passed).
  function due() {
    const s = settings();
    const every = EVERY_MS[s.updateEvery] ?? EVERY_MS['24h'];
    const since = Date.now() - (s.lastUpdateCheck || 0);
    if (s.updateEvery === 'start') return since > 60e3; // every launch, but not twice a minute
    return since >= (every || EVERY_MS['24h']);
  }

  const status = () => ({ current: app.getVersion(), repo: repo(), ...state, pending: settings().pendingUpdate || null });
  return { check, download, run, applyPending, due, status };
}

module.exports = { createUpdater, newer };
