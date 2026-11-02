'use strict';
// Updates while HomeCable is running — the quiet half of the updater.
// (The other half is the little updater window at start: src/boot/boot.js.)
//
// run():   ask GitHub (title only, a plain User-Agent, nothing identifying). A new
//          version downloads in the background without touching what's playing —
//          normally just the app file (a few MB), the full installer only when
//          Electron itself changed. Progress goes to Settings live.
// apply(): "Update now" — restart straight into it. Nothing happens on a plain
//          close any more: no installer ever pops up behind your back.
// Test hooks: HOMECABLE_UPDATE_API (mock GitHub), HOMECABLE_VERSIONS_DIR,
//             HOMECABLE_SHELL, HOMECABLE_NO_INSTALL — see src/boot/core.js.
const core = require('../boot/core');

const EVERY_MS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3 };

function createUpdater({ app, log, send, settings, saveSettings }) {
  const boot = global.__hcBoot || null; // null when run from source
  const shell = boot ? boot.shell : core.shellId();
  const state = { phase: 'idle', latest: null, kind: null, pct: null, got: 0, total: 0, error: null, lastCheck: boot?.checkedAt || 0 };

  const repo = () => {
    const s = settings();
    if (s.updateRepo && /^[\w.-]+\/[\w.-]+$/.test(s.updateRepo)) return s.updateRepo;
    try { return require('../../package.json').homecable.github; } catch { return null; }
  };

  // A newer version that's downloaded, intact and ready: the app file for this
  // shell (not one that failed before), or a full installer.
  function ready() {
    const cur = app.getVersion();
    try {
      const bad = core.readState().bad || [];
      const v = core.installed(shell).find((x) => x.matches && !bad.includes(x.version) && core.newer(x.version, cur));
      if (v) return { version: v.version, kind: 'app', notes: v.notes };
      const p = core.pendingInstaller(cur);
      if (p) return { version: p.version, kind: 'installer', notes: p.notes || '' };
    } catch {}
    return null;
  }

  // Keep settings.pendingUpdate in step (Settings reads it) and tell the window.
  let lastSent = 0;
  function emit(force) {
    const r = ready();
    const s = settings();
    const was = JSON.stringify(s.pendingUpdate || null);
    s.pendingUpdate = r ? { version: r.version, kind: r.kind } : null;
    if (JSON.stringify(s.pendingUpdate) !== was) saveSettings();
    const now = Date.now();
    if (!force && state.phase === 'downloading' && now - lastSent < 250) return;
    lastSent = now;
    send('update-status', status());
  }

  async function check() {
    state.phase = 'checking'; state.error = null; emit(true);
    try {
      const info = await core.latest({ repo: repo(), current: app.getVersion(), timeoutMs: 8000 });
      state.lastCheck = Date.now();
      const s = settings(); s.lastUpdateCheck = state.lastCheck; saveSettings();
      state.latest = info ? { version: info.version, notes: info.notes } : null;
      state.kind = info ? core.plan(info, shell)?.kind || null : null;
      state.phase = ready() ? 'ready' : info ? 'found' : 'uptodate';
      emit(true);
      return info;
    } catch (e) {
      state.error = e.message; state.phase = 'error'; log('update check:', e.message); emit(true);
      return null;
    }
  }

  let running = null;
  function run(reason) {
    if (running) return running;
    running = (async () => {
      try {
        const info = await check();
        if (!info) return null;
        const p = core.plan(info, shell);
        const r = ready();
        if (r && !core.newer(info.version, r.version)) { state.phase = 'ready'; emit(true); return info; } // already here
        if (!p) return null;
        if (p.kind === 'app' && (core.readState().bad || []).includes(info.version)) { state.phase = 'uptodate'; emit(true); return null; }
        const s = settings();
        if (s.updateNotify !== false && s.updateNotified !== info.version) {
          s.updateNotified = info.version; saveSettings();
          send('update-toast', { version: info.version });
        }
        state.phase = 'downloading'; state.kind = p.kind; state.pct = 0; state.got = 0; state.total = p.size || 0; emit(true);
        const onProgress = (g, t) => { state.got = g; state.total = t; state.pct = t ? g / t : null; emit(); };
        if (p.kind === 'app') await core.fetchApp(info, { current: app.getVersion(), onProgress });
        else await core.fetchInstaller(info, { current: app.getVersion(), onProgress });
        log(`update v${info.version} downloaded (${p.kind === 'app' ? 'app file' : 'full installer'}, ${reason}) — ready for Update now / next start`);
        state.phase = 'ready'; state.pct = 1; emit(true);
        return info;
      } catch (e) {
        state.error = e.message; state.phase = 'error'; log('update:', e.message); emit(true);
        return null;
      } finally { running = null; }
    })();
    return running;
  }

  // "Update now": restart into the new version. The launcher shows its window,
  // swaps in the app file (or runs the full installer) and opens HomeCable again.
  function apply(closeWindow) {
    const r = ready();
    if (!r) return { ok: false };
    if (!boot && !process.env.HOMECABLE_FAKE_PACKAGED) { log('update ready (running from source — not restarting):', r.version); return { ok: false, dev: true }; }
    log(`Update now → v${r.version}`);
    app.relaunch();
    setTimeout(() => { try { closeWindow(); } catch { app.quit(); } }, 150);
    return { ok: true, version: r.version };
  }

  // While running: on the chosen rhythm (the start-up window covers each start).
  function due() {
    const s = settings();
    if (s.updateEvery === 'off') return false;
    const every = EVERY_MS[s.updateEvery] || EVERY_MS['24h'];
    return Date.now() - Math.max(s.lastUpdateCheck || 0, state.lastCheck || 0) >= every;
  }

  const hasReady = () => !!ready();
  function status() {
    const r = ready();
    let failed = null;
    try { const f = core.readState().failed; if (f && Date.now() - (f.at || 0) < 10 * 60e3 && core.newer(f.version, app.getVersion())) failed = f.version; } catch {}
    return {
      current: app.getVersion(), repo: repo(), phase: state.phase, kind: state.kind, pct: state.pct, got: state.got, total: state.total,
      error: state.error, lastCheck: state.lastCheck || settings().lastUpdateCheck || 0, latest: state.latest,
      ready: r, failed, launcher: !!boot, onStart: settings().updateOnStart !== false,
    };
  }
  // First look: maybe something finished downloading last time.
  if (ready()) state.phase = 'ready';
  setTimeout(() => emit(true), 0);
  return { check, run, apply, due, status, hasReady, newerThan: core.newer };
}

module.exports = { createUpdater, newer: core.newer };
