'use strict';
// HomeCable's launcher — the first thing that runs, every start.
//
// 1. Picks which app version to run: the one that came with the installer, or
//    a newer one the updater downloaded (see core.js), skipping any that failed.
// 2. Shows the little updater window: "Checking for updates…". If there is one
//    it downloads it right there with a progress bar, swaps it in and restarts
//    straight into it ("✓ Updated to v1.5.0"). Offline? It just starts.
// 3. Hands over to the app (src/main/main.js of the chosen version) and closes
//    once the TV window is up.
//
// Settings → Updates → "Check when HomeCable starts" turns the window off; the
// app then starts instantly and updates download quietly in the background.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const core = require('./core');
let fs; try { fs = require('original-fs'); } catch { fs = require('fs'); }

const BUILTIN = { version: require('../../package.json').version, dir: path.join(__dirname, '..', '..'), builtin: true };
const REPO_DEFAULT = (() => { try { return require('../../package.json').homecable.github; } catch { return null; } })();

if (process.env.HOMECABLE_DATA) app.setPath('userData', process.env.HOMECABLE_DATA);

// Running from source (npm start): no launcher, the app as-is.
if (!app.isPackaged && !process.env.HOMECABLE_BOOT_TEST) {
  require('../main/main.js');
  return;
}
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

const userData = app.getPath('userData');
function log(...a) {
  try { fs.mkdirSync(userData, { recursive: true }); fs.appendFileSync(path.join(userData, 'homecable.log'), `[${new Date().toISOString()}] [updater] ${a.join(' ')}\n`); } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;

const shell = core.shellId();
const updatedArg = (process.argv.find((a) => a.startsWith('--hc-updated=')) || '').split('=')[1] || null;
const settings = core.readJson(path.join(userData, 'settings.json'), {});
const repo = settings.updateRepo && /^[\w.-]+\/[\w.-]+$/.test(settings.updateRepo) ? settings.updateRepo : REPO_DEFAULT;

let target;
try {
  target = core.pick({ builtin: BUILTIN, shell });
  core.tidy({ keep: [target.version], shell });
} catch (e) { log('version pick:', e.message); target = BUILTIN; }
const st0 = (() => { try { return core.readState(); } catch { return {}; } })();
if (st0.failed && Date.now() - st0.failed.at < 60e3) log(`v${st0.failed.version} didn't start — back on v${target.version}`);

// The chosen version's own pre-ready switches (GPU, autoplay…).
try { require(path.join(target.dir, 'src', 'main', 'switches.js')).apply(app); }
catch { require('../main/switches').apply(app); }

const pendingInstaller = (() => { try { return core.pendingInstaller(target.version); } catch { return null; } })();
const lastRun = settings.lastRunVersion || null;
const justUpdated = !!updatedArg || (lastRun && core.newer(target.version, lastRun));
const wantCheck = settings.updateOnStart !== false && !!repo && !updatedArg;
// The installed program lost its ffmpeg (1.4.11's cleanup bug emptied that folder):
// nothing can play. Repair it with the full installer from the latest release — at most
// every few hours, so an offline PC doesn't keep trying at every start.
const ffmpegExe = app.isPackaged && process.platform === 'win32' ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe') : null;
const repairFile = path.join(core.versionsDir(), 'repair.json');
const broken = !!ffmpegExe && !fs.existsSync(ffmpegExe) && !!repo && Date.now() - (core.readJson(repairFile, {}).at || 0) > 3 * 3600e3;
if (broken) log('ffmpeg is missing from the installed program — repairing with the full installer');

// Nothing to show: start the app right now, exactly like a plain start.
if (!wantCheck && !pendingInstaller && !justUpdated && !broken) start(target, null);
else app.whenReady().then(() => updaterWindow().catch((e) => { log('window:', e.stack || e.message); start(target, null); }));

// ---------------------------------------------------------------------------

function start(t, splash) {
  global.__hcBoot = {
    version: t.version, builtin: BUILTIN.version, fromDownload: !t.builtin, shell,
    checkedAt: global.__hcBootCheckedAt || 0,
  };
  // Everything in the app (Settings, the log, the phone API) reports this version.
  if (!t.builtin) app.getVersion = () => t.version;
  if (!t.builtin) { try { core.beginTrial(t.version); } catch {} }
  let seen = false;
  const onWin = (_, w) => {
    if (w === splash || seen) return;
    w.once('show', () => {
      if (seen) return;
      seen = true;
      app.removeListener('browser-window-created', onWin);
      // The TV window is up: this version works. Close the updater window.
      try { if (!t.builtin) core.markGood(t.version); } catch {}
      if (app.isPackaged) core.syncWindowsVersion(t.version, process.execPath, log);
      setTimeout(() => { try { splash?.destroy(); } catch {} }, 300);
    });
  };
  app.on('browser-window-created', onWin);
  try {
    require(path.join(t.dir, 'src', 'main', 'main.js'));
  } catch (e) {
    if (t.builtin) throw e;
    // A downloaded version that can't even load: never again, back to the last good one.
    log(`v${t.version} failed to load:`, e.message);
    try { core.markBad(t.version, e.stack || e.message); } catch {}
    app.relaunch({ args: process.argv.slice(1).filter((a) => !a.startsWith('--hc-updated=')) });
    app.exit(0);
  }
}

function makeSplash() {
  const off = !!process.env.HOMECABLE_OFFSCREEN;
  const w = new BrowserWindow({
    width: 360, height: 400, frame: false, resizable: false, maximizable: false, fullscreenable: false,
    show: false, center: true, backgroundColor: '#07080b', title: 'HomeCable',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'), skipTaskbar: off,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.loadFile(path.join(__dirname, 'splash.html'));
  if (off) { w.setPosition(-10000, -10000); w.once('ready-to-show', () => w.showInactive()); }
  else w.once('ready-to-show', () => w.show());
  return w;
}

async function updaterWindow() {
  const splash = makeSplash();
  await new Promise((r) => splash.webContents.once('did-finish-load', r));
  let shot = 0;
  const say = async (o) => {
    await splash.webContents.executeJavaScript(`window.hc && window.hc(${JSON.stringify(o)})`).catch(() => {});
    if (process.env.HOMECABLE_SPLASH_SHOTS) { // test hook: what the window showed
      await sleep(180);
      try { const img = await splash.webContents.capturePage(); fs.mkdirSync(process.env.HOMECABLE_SPLASH_SHOTS, { recursive: true }); fs.writeFileSync(path.join(process.env.HOMECABLE_SPLASH_SHOTS, `${Date.now()}-${++shot}.png`), img.toPNG()); } catch {}
    }
  };
  // "Start now" while a download runs: stop it, start the current version
  // (the app picks the download up again quietly in the background).
  const skip = new AbortController();
  splash.webContents.on('console-message', (...a) => { const msg = typeof a[0] === 'object' ? a[0].message : a[2]; if (msg === 'hc:skip') skip.abort(); });
  await say({ version: target.version });

  if (justUpdated) {
    log(`now on v${target.version}${lastRun ? ` (was v${lastRun})` : ''}`);
    await say({ state: 'done', text: `Updated to v${target.version}`, sub: 'Your channels and settings are all here.' });
    await sleep(1300);
  }
  if (pendingInstaller) return installNow(splash, say, pendingInstaller);
  if (!wantCheck && !broken) { await say({ state: 'start', text: 'Starting HomeCable…', sub: '' }); return start(target, splash); }

  await say({ state: 'check', text: 'Checking for updates…' });
  let info = null;
  const t0 = Date.now();
  try { info = await core.latest({ repo, current: target.version, timeoutMs: 6000, any: broken }); }
  catch (e) {
    log('check:', e.message);
    await say({ state: 'start', text: 'Couldn’t check for updates', sub: 'Starting anyway — it’ll try again later.' });
    await sleep(1100);
  }
  global.__hcBootCheckedAt = Date.now();
  if (Date.now() - t0 < 500) await sleep(500 - (Date.now() - t0)); // long enough to read
  // Repairing: the full installer of the latest version, whatever the shell says.
  const p = broken && info?.setup?.url ? { kind: 'installer' } : core.plan(info, shell);
  if (broken) { try { core.writeJson(repairFile, { at: Date.now(), version: info?.version || null }); } catch {} }
  const bad = (() => { try { return core.readState().bad || []; } catch { return []; } })();
  if (p?.kind === 'app' && !bad.includes(info.version)) {
    log(`v${info.version} found — downloading the app (${mb(info.app.size || 0)})`);
    await say({ state: 'download', text: `Downloading v${info.version}`, sub: info.app.size ? mb(info.app.size) : '', pct: 0, skip: true });
    try {
      await core.fetchApp({ ...info, app: info.app }, {
        current: target.version, signal: skip.signal,
        onProgress: (g, t) => { say({ pct: t ? g / t : null, sub: t ? `${mb(g)} of ${mb(t)}` : mb(g) }); },
      });
      log(`v${info.version} ready — restarting into it`);
      await say({ state: 'install', text: `Installing v${info.version}…`, sub: '', pct: 1, skip: false });
      await sleep(700);
      app.relaunch({ args: [...process.argv.slice(1).filter((a) => !a.startsWith('--hc-updated=')), `--hc-updated=${info.version}`] });
      app.exit(0);
      return;
    } catch (e) {
      log('download:', e.message);
      if (!skip.signal.aborted) { await say({ state: 'start', text: 'The update didn’t finish', sub: 'Starting this version — it’ll try again later.', skip: false }); await sleep(1300); }
    }
  } else if (p?.kind === 'installer') {
    log(broken ? `repairing with the v${info.version} installer (${mb(info.setup.size || 0)})` : `v${info.version} found — it needs the full installer (${mb(info.setup.size || 0)})`);
    await say({ state: 'download', text: broken ? 'Repairing HomeCable…' : `Downloading v${info.version}`, sub: info.setup.size ? mb(info.setup.size) : '', pct: 0, skip: true });
    try {
      const pend = await core.fetchInstaller(info, {
        current: target.version, signal: skip.signal,
        onProgress: (g, t) => { say({ pct: t ? g / t : null, sub: t ? `${mb(g)} of ${mb(t)}` : mb(g) }); },
      });
      return installNow(splash, say, pend);
    } catch (e) {
      log('download:', e.message);
      if (!skip.signal.aborted) { await say({ state: 'start', text: 'The update didn’t finish', sub: 'Starting this version — it’ll try again later.', skip: false }); await sleep(1300); }
    }
  } else if (info) log(`v${info.version} is out but can’t be applied here`);
  await say({ state: 'start', text: 'Starting HomeCable…', sub: '', skip: false, pct: null });
  start(target, splash);
}

// The full installer (only when Electron itself changed): silent, no clicks,
// HomeCable reopens on the new version by itself.
async function installNow(splash, say, p) {
  log(`installing v${p.version} with the full installer`);
  await say({ state: 'install', text: `Installing v${p.version}…`, sub: 'HomeCable closes for a moment and reopens by itself.', pct: null, skip: false });
  await sleep(1400);
  try { core.runInstaller(p, process.execPath); }
  catch (e) { log('installer:', e.message); await say({ state: 'start', text: 'Couldn’t start the installer', sub: 'Starting this version instead.' }); await sleep(1200); return start(target, splash); }
  app.exit(0);
}
