const { app, BrowserWindow, ipcMain, dialog, powerSaveBlocker, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { Store } = require('./store');
const { Library, quickScanRoots, deepScanRoots } = require('./library');
const { Scheduler } = require('./scheduler');
const { createUpdater } = require('./updater');
const { suggestChannels, PALETTE } = require('./suggest');
const { startServer } = require('./server');
const cast = require('./cast');
const artwork = require('./artwork');
const { buildSeries, cleanName } = require('./series');
const subtitles = require('./subtitles');
const captions = require('./captions');
const { createPhone } = require('./phone');
const { ALLOWS: PROFILE_ALLOWS } = require('./profiles');
const { parsePath } = require('./naming');
let phone = null;
const handlerFns = {}; // every IPC answer, by name (the phone API reuses them)
const { importLegacySchedule } = require('./legacyImport');
const { enrichLibrary, lookupShow } = require('./metadata');
const network = require('./network');
const iptv = require('./iptv');
const free = require('./freecontent');
const adsLib = require('./ads');
const epg = require('./epg');
const { Profiles, autoRating } = require('./profiles');

// Profile path + Chromium switches (the launcher already did this when it runs us).
require('./switches').apply(app);
// The launcher (src/boot/boot.js) holds the single-instance lock already.
const BOOT = global.__hcBoot || null;
if (!BOOT && !app.requestSingleInstanceLock()) { app.quit(); return; }

let win, store, lib, sched, media, channels, settings, profiles, updater, sleepBlock = null;
const logFile = () => path.join(app.getPath('userData'), 'homecable.log');
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try { fs.appendFileSync(logFile(), line); } catch {}
  if (!app.isPackaged) process.stdout.write(line);
}

const DEFAULT_SETTINGS = { setupDone: false, onlineMeta: true, transitions: true, showClock: true, volume: 0.9, muted: false, lastChannel: null, prevChannel: null, bannerSeconds: 5, lockChannel: null, startFullscreen: false, brightness: 1, fit: 'fit',
  // auto / manual / in-between
  newMedia: 'auto',          // 'auto' = onto channels · 'review' = inbox first · 'library' = library only
  scanInterval: '6h',        // 'off' | '1h' | '6h' | '24h' (folders are also watched live)
  newArrivals: false,        // the "New Arrivals" channel appears only when you choose it (setup offers it on)
  lastScan: 0,
  // Commercial breaks — just for fun, ON by default (the Showtime setup page and
  // Settings are the chance to turn them off). The ads are the short videos that
  // ship with HomeCable plus any ad packs you add; each pack has a switch.
  adsOn: true, adSeconds: 30, adEvery: 'every', adFeed: '', adFolder: '',
  // Channel bumpers: a few seconds of the channel's own logo between shows (like
  // a real network), and in/out of commercial breaks when those are on.
  bumpersOn: true, bumperSeconds: 5,
  // In-app updates from GitHub Releases: checked quietly, downloaded quietly,
  // installed when the app restarts. 'start' | '1h' | '6h' | '24h'.
  updateEvery: '24h', updateOnStart: true, updateNotify: true, updateRepo: '', lastUpdateCheck: 0, updateNotified: '', pendingUpdate: null,
  // Free live TV: what to keep the lineup stocked with, and where its numbers start.
  live: null,                // { country, categories, max, sources: ['iptv-org','free-tv'], urls: [] } once set up
  liveStart: 100, lastLiveRefresh: 0,
};
const BUILT_IN_AD_FEED = (() => { try { return require('../../package.json').homecable?.adFeed || ''; } catch { return ''; } })();
const adFeedUrl = () => settings.adFeed || BUILT_IN_AD_FEED;
const SCAN_MS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3 };

function saveChannels() { store.write('channels', channels); quietOnDemandFolders(); ratingCache.clear(); }
// On Demand folders are only read when the On Demand screen opens (see 'ondemand:refresh').
const onDemandFolders = (ch) => ch.sources.filter((x) => x.type === 'folder').map((x) => x.path);
function quietOnDemandFolders() { lib?.setQuietFolders(channels.filter((c) => c.ondemand).flatMap(onDemandFolders)); }
function saveSettings() { store.write('settings', settings); }
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

function nextNumber(from = 2) {
  const used = new Set(channels.map((c) => c.number));
  let n = from; // cable starts at 2; live IPTV stations start at 100
  while (used.has(n)) n++;
  return n;
}

// The channel's network look (its made logo): font, badge shape, colors, text —
// or a picture file of your own. Only how the channel is drawn, never what plays.
function cleanLook(lk) {
  if (!lk || typeof lk !== 'object') return null;
  const hex = (x) => (/^#[0-9a-fA-F]{3,8}$/.test(String(x || '')) ? x : null);
  return {
    font: ['impact', 'modern', 'classic', 'script', 'fun', 'tech'].includes(lk.font) ? lk.font : 'modern',
    shape: ['badge', 'circle', 'pill', 'tilt', 'bare'].includes(lk.shape) ? lk.shape : 'badge',
    c1: hex(lk.c1), c2: hex(lk.c2),
    text: String(lk.text || '').slice(0, 14),
    custom: typeof lk.custom === 'string' && lk.custom ? String(lk.custom).slice(0, 300) : null,
  };
}

function normalizeChannel(c) {
  return {
    id: c.id && !String(c.id).startsWith('sug-') ? c.id : crypto.randomUUID(),
    number: Number.isInteger(+c.number) && +c.number > 0 ? +c.number : nextNumber(),
    name: String(c.name || 'New Channel').slice(0, 60),
    logo: c.logo || '',
    look: cleanLook(c.look),
    color: c.color || PALETTE[channels.length % PALETTE.length],
    order: ['shuffle', 'sequential', 'ordered', 'random'].includes(c.order) ? c.order : 'sequential',
    align: [0, 15, 30, 60].includes(+c.align) ? +c.align : 30,
    sources: Array.isArray(c.sources) ? c.sources : [],
    // Things taken off the channel by hand in the Manager ("show:<key>" / "item:<id>").
    exclude: Array.isArray(c.exclude) ? c.exclude.filter((x) => /^(show|item):./.test(String(x))).slice(0, 500) : [],
    filler: Array.isArray(c.filler) ? c.filler : [],
    blocks: Array.isArray(c.blocks) ? c.blocks.map((b) => ({ ...b, id: b.id || crypto.randomUUID().slice(0, 8) })) : [],
    ...(c.iptv ? { iptv: c.iptv } : {}),
    // On demand: no schedule — tuning in shows a wall of its movies to pick from.
    ...(c.ondemand && !c.iptv ? { ondemand: true, odStyle: c.odStyle === 'series' ? 'series' : 'movies', ...(c.locked ? { locked: true } : {}) } : {}),
    // Who can see it: 'all' (kids too), 'teen', 'adult'. Picked automatically unless set.
    rating: ['all', 'teen', 'adult'].includes(c.rating) ? c.rating : null,
    // Unchecked from being seen (guide right-click / Free TV manager): stays in the
    // lineup lists for restoring, but out of the guide, surfing and the phone.
    ...(c.hidden ? { hidden: true } : {}),
    // Hearted in the guide (right-click → ❤): the ♥ filter shows only these.
    ...(c.fav ? { fav: true } : {}),
  };
}

// Every live station gets a genre tag, so the guide's genre filter and the Free
// TV manager can group as many of them as possible: the index's own group when
// it has one, otherwise a guess from the station's name. 'Live TV' is the
// honest fallback for the truly unknowable.
const GENRE_GUESS = [
  ['News', /news|cnn|msnbc|bbc|weather|c-?span|bloomberg|headline/i],
  ['Sports', /sport|espn|nfl|nba|mlb|nhl|golf|tennis|racing|motor|fight|wwe|ufc|bein|dazn/i],
  ['Movies', /movie|cinema|film|flix|screen|hollywood/i],
  ['Kids', /kids|cartoon|toon|junior|baby|teen|anime|nick|pbs kids/i],
  ['Music', /music|mtv|vevo|hits|radio|fm\b|concert|stingray/i],
  ['Comedy', /comedy|funny|laugh|sitcom/i],
  ['Documentary', /docu|discovery|history|nat ?geo|science|wild|nature|planet|crime/i],
  ['Classic', /classic|retro|rerun|nostalgia|westerns/i],
  ['Entertainment', /entertain|drama|series|novelas|reality|lifestyle/i],
];
function stationGenre(name, group) {
  const g = String(group || '').split(/[;,/]/)[0].trim();
  if (g && !/^(undefined|general)$/i.test(g)) return g[0].toUpperCase() + g.slice(1).toLowerCase();
  for (const [tag, re] of GENRE_GUESS) if (re.test(String(name || ''))) return tag;
  return 'Live TV';
}

// Keep live-station numbers gapless: visible stations count up from liveStart,
// hidden ones are parked after them (numbers stay unique for when they return).
function renumberIptv() {
  const live = channels.filter((c) => c.iptv).sort((a, b) => a.number - b.number);
  let n = settings.liveStart || 100;
  for (const c of live.filter((x) => !x.hidden)) c.number = n++;
  for (const c of live.filter((x) => x.hidden)) c.number = n++;
}
// A channel with no rating set is guessed from its content — guessed fresh (and
// never saved) so adding grown-up shows to a channel re-rates it for kids' eyes.
const ratingCache = new Map();
const ratingOf = (c) => c.rating || ratingCache.get(c.id) || (() => { const v = autoRating(c, lib); ratingCache.set(c.id, v); return v; })();
// What the current profile is allowed to see.
const visible = () => channels.filter((c) => profiles.allows(ratingOf(c)));

function sortedChannels() { return visible().filter((c) => !c.locked).sort((a, b) => a.number - b.number); }

function libraryStats() {
  const items = lib.list();
  const count = (k) => items.filter((i) => i.kind === k).length;
  return { total: items.length, episodes: count('episode'), movies: count('movie'), music: count('music'), shorts: count('short'), clips: count('clip'), shows: lib.shows().length, folders: lib.folders, servers: lib.servers.map(({ id, name, detail }) => ({ id, name, detail })), pending: lib.pendingCount(), scanning: lib.scanning, lastScan: settings.lastScan };
}

function describe(entry) {
  if (!entry) return null;
  const it = entry.itemId ? lib.items[entry.itemId] : null;
  return { ...entry, path: it?.path, width: it?.width, height: it?.height, poster: it?.showKey ? showArtUrl(it.showKey) : it?.kind === 'movie' ? posterUrl(it) || it.art || null : null, summary: it?.showKey ? lib.meta[it.showKey]?.summary || null : null };
}

// Casting to a Chromecast: { session, device, lanIp } while a TV is connected.
let casting = null;
let castDevices = [];
const castState = () => (casting ? { on: true, device: casting.device.name, deviceId: casting.device.id, mode: casting.mode } : { on: false, mode: settings.castMode || 'mirror' });

function playFor(item, offset, opts = {}) {
  // The TV's built-in player (and a phone's) handles fewer formats than this PC: H.264 MP4 as
  // it is, everything else repackaged or converted — so those pick their own mode.
  const mode = opts.phone || casting?.mode === 'media' ? item.castForce || cast.castMode(item) : item.forceMode || item.mode;
  return { mode, url: media.urlFor(item.id, { mode, t: offset }), offset: mode === 'direct' ? offset : 0, startedAt: offset, audioOnly: item.kind === 'music' };
}

// On-demand channels: one all-day "pick a movie" slot in the guide and banner.
function onDemandEntry(ch, t) {
  const d = new Date(t); d.setHours(0, 0, 0, 0);
  const n = onDemandItems(ch).length;
  return { start: d.getTime(), end: d.getTime() + 86400e3, type: 'ondemand', kind: 'ondemand', title: ch.name, sub: `On Demand · ${n} movie${n === 1 ? '' : 's'} — pick one`, show: null };
}
// Taken off the channel by hand?
function chExcluded(ch, it) {
  const ex = ch.exclude;
  if (!ex || !ex.length) return false;
  return ex.includes('item:' + it.id) || (it.showKey && ex.includes('show:' + it.showKey)) || (it.showKeyUser && ex.includes('show:' + it.showKeyUser));
}
function onDemandItems(ch, open = vaultOpen) {
  if (ch.locked && !open) return [];
  const allowed = ch.locked ? null : new Set(allowedItems().map((i) => i.id));
  const seen = new Set(), out = [];
  const series = ch.odStyle === 'series';
  for (const s of ch.sources) for (const it of lib.resolve(ch.locked && s.type === 'folder' ? { ...s, private: true, includePending: true, includeShorts: true } : series && s.type === 'folder' ? { ...s, includeShorts: true } : s)) if (!seen.has(it.id) && (!allowed || allowed.has(it.id)) && it.duration > 0 && it.kind !== 'music' && !chExcluded(ch, it)) { seen.add(it.id); out.push(it); }
  return out;
}

// ---- The locked section: a password-protected On Demand screen with a plain name you pick.
// Its folders are hidden from everything else (channels, Library, guide, setup, poster
// lookups online), it's only for grown-up profiles, and it locks again when you leave.
let vaultOpen = false;
let vaultFails = 0, vaultWait = 0;
const vaultChannel = () => channels.find((c) => c.locked && c.ondemand);
const vaultHash = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
function applyVault() {
  lib?.setPrivateFolders(settings.vault?.folders || []);
  const ch = vaultChannel();
  if (ch && settings.vault) {
    ch.name = settings.vault.name;
    ch.sources = settings.vault.folders.map((f) => ({ type: 'folder', path: f, label: 'Locked folder', includePending: true }));
  }
}
// Settings as the screen sees them: never the locked section's password hash.
const shownSettings = () => { const { vault, ...rest } = settings; return rest; };
// The password, checked the same way everywhere (5 wrong tries → 30 s wait, shared).
function vaultCheck(password) {
  const v = settings.vault;
  if (!v) return { ok: false };
  if (Date.now() < vaultWait) return { ok: false, wait: Math.ceil((vaultWait - Date.now()) / 1000) };
  const a = Buffer.from(vaultHash(password, v.salt), 'hex'), b = Buffer.from(v.hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { if (++vaultFails >= 5) { vaultWait = Date.now() + 30e3; vaultFails = 0; } return { ok: false }; }
  vaultFails = 0;
  return { ok: true };
}
function vaultView() {
  const v = settings.vault;
  if (!v || !profiles.isAdult()) return { set: false, adult: profiles.isAdult() };
  return { set: true, adult: true, name: v.name, showButton: v.showButton !== false, phone: v.phone !== false, open: vaultOpen, channelId: vaultChannel()?.id || null, folders: v.folders };
}
function vaultScan() {
  const folders = (settings.vault?.folders || []).filter((f) => fs.existsSync(f));
  return folders.length ? lib.scan(folders, { remember: true, prune: true, policy: 'auto' }) : Promise.resolve({});
}
// Posters for locked videos come only from the files themselves (never looked up online).
async function vaultPosters() {
  const dir = path.join(app.getPath('userData'), 'posters');
  const ch = vaultChannel();
  if (!ch) return;
  for (const it of onDemandItems(ch)) {
    if (it.kind === 'episode' || !artwork.needsPoster(it, false, true)) continue;
    try { await artwork.findPoster(it, { dir, online: false, siblings: 1, log }); } catch {}
  }
}
// HomeStreamer: the channel's videos as Netflix-style series (one per folder, seasons by subfolder).
function seriesFor(ch, items = onDemandItems(ch)) {
  return buildSeries(items, onDemandFolders(ch).filter((f) => fs.existsSync(f)));
}
// Subtitle tracks per video (probed once per file version; one entry per video,
// so re-downloaded files replace their old entry instead of piling up).
const subsCache = new Map();
async function subsInfo(it) {
  const cur = subsCache.get(it.id);
  if (cur && cur.m === (it.mtime || 0)) return cur.p;
  const perFolder = lib.list().filter((x) => x.folder === it.folder && x.kind !== 'music').length;
  const p = subtitles.subtitlesFor(it, { lang: settings.subLang || 'eng', mode: settings.subMode || 'auto', videosInFolder: perFolder });
  subsCache.set(it.id, { m: it.mtime || 0, p });
  return p;
}
const posterDir = () => path.join(app.getPath('userData'), 'posters');
const RETRY_TAGS_MS = 7 * 24 * 3600e3; // a movie Wikipedia doesn't know waits a week before another try
const seriesArtId = (key) => 'series-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
// A series' poster: a picture in its folder (cached), or one looked up by its name.
function seriesPoster(s) { return showArtUrl(s.key); }
// A show's poster by its key: the user's own pick / folder picture (a cached file), else the looked-up one.
function showArtUrl(key) {
  const m = lib.meta[key];
  if (m?.posterFile && fs.existsSync(m.posterFile)) return media.artUrl(seriesArtId(key)) + '&v=' + (m.at || 0);
  return m?.poster || null;
}
async function findSeriesPosters(online) {
  for (const ch of channels.filter((c) => c.ondemand && c.odStyle === 'series')) {
    for (const s of seriesFor(ch).series) {
      if (lib.meta[s.key]?.posterFile || (lib.meta[s.key] && !s.dir)) continue;
      // 1. poster.jpg / folder.jpg / cover.jpg … in the series folder
      if (s.dir) {
        let pic = null;
        try { const names = fs.readdirSync(s.dir); pic = ['poster', 'folder', 'cover', 'show', 'series', 'banner'].flatMap((n) => artwork.IMG.map((e) => n + e)).map((c) => names.find((x) => x.toLowerCase() === c)).find(Boolean); } catch {}
        if (pic) {
          fs.mkdirSync(posterDir(), { recursive: true });
          const out = path.join(posterDir(), seriesArtId(s.key) + '.jpg');
          if (await artwork.toJpeg(path.join(s.dir, pic), out)) { lib.meta[s.key] = { ...(lib.meta[s.key] || {}), name: s.name, posterFile: out, at: Date.now() }; continue; }
        }
      }
      // 2. online by the series' name (TVmaze; the name only)
      if (online && !lib.meta[s.key]) { try { lib.meta[s.key] = await lookupShow(s.name); } catch (e) { if (/fetch failed|timeout|abort/i.test(String(e))) return; } }
    }
  }
}
const posterUrl = (it) => (it.poster ? media.artUrl(it.id) + '&v=' + (it.posterAt || 0) : null);

// Movie posters: embedded art, a picture next to the file, else looked up by name.
let posterRun = null;
function findMoviePosters({ force = false } = {}) {
  if (posterRun) return posterRun;
  let offline = false;
  posterRun = (async () => {
    const dir = path.join(app.getPath('userData'), 'posters');
    const online = !!settings.onlineMeta;
    // Your movies, plus anything (but episodes and music) on an On Demand channel.
    const onDemand = new Set(channels.filter((c) => c.ondemand && !c.locked).flatMap((c) => onDemandItems(c)).filter((it) => it.kind !== 'episode' && it.kind !== 'music').map((it) => it.id));
    const items = lib.list().filter((it) => (it.kind === 'movie' || onDemand.has(it.id)) && !String(it.server || '').startsWith('archive:'));
    const perFolder = new Map();
    for (const it of lib.list()) if (it.kind !== 'music' && it.folder) perFolder.set(it.folder, (perFolder.get(it.folder) || 0) + 1);
    // force (the "Look up now" button): every movie still without a poster, ignoring when it was last tried.
    const todo = items.filter((it) => force ? !(it.poster && fs.existsSync(it.poster)) : artwork.needsPoster(it, online, true));
    let found = 0, n = 0, lastSend = 0;
    for (const it of todo) {
      let ok = false;
      try { ok = await artwork.findPoster(it, { dir, online: online && !offline, siblings: perFolder.get(it.folder) || 1, log }); }
      catch (e) { if (e.offline) { offline = true; log('posters: online lookups unavailable for now (offline or rate-limited) — local art only'); } }
      if (ok) found++;
      n++;
      if (online && !offline) await new Promise((r2) => setTimeout(r2, 300)); // gentle on Wikipedia
      if (Date.now() - lastSend > 1500) { lastSend = Date.now(); send('posters-progress', { n, total: todo.length }); send('library-changed', libraryStats()); }
    }
    await findSeriesPosters(online && !offline).catch((e) => log('series posters', e));
    // Episodes on an On Demand channel wear their show's poster (TVmaze, show name only).
    if (online && !offline) {
      const odShows = [...new Set(channels.filter((c) => c.ondemand).flatMap((c) => onDemandItems(c)).filter((it) => it.kind === 'episode' && it.showKey && !lib.meta[it.showKey]).map((it) => it.showKey))];
      for (const key of odShows) {
        const show = lib.shows().find((x) => x.key === key);
        if (!show) continue;
        try { lib.meta[key] = await lookupShow(show.name); found++; } catch (e) { if (/fetch failed|timeout|abort/i.test(String(e))) break; }
      }
      if (odShows.length) { lib.save(); send('library-changed', libraryStats()); }
    }
    if (todo.length) { lib.save(); log(`posters: ${found} found for ${todo.length} movies`); send('posters-progress', { n: todo.length, total: todo.length, done: true }); send('library-changed', libraryStats()); }
    return { checked: todo.length, found };
  })().finally(() => { posterRun = null; });
  return posterRun;
}

// Tune a channel live, or time-shifted to wall-clock time `atTime` (DVR
// buffer: anything the channel aired in the last few hours).
// Live IPTV channels have no schedule of their own: an hour-long "Live" slot.
function liveEntry(ch, t) {
  // Real listings when the station has a guide; otherwise an hour-long "Live" slot.
  const g = guides[ch.id]?.find((p) => p.start <= t && t < p.end);
  if (g) return { start: g.start, end: g.end, type: 'program', kind: 'live', title: ch.name, program: g.title, show: null, live: true, sub: [g.title, g.sub].filter(Boolean).join(' — '), summary: g.desc, poster: ch.iptv.logo || null };
  const start = Math.floor(t / HOUR_MS) * HOUR_MS;
  const nextG = guides[ch.id]?.find((p) => p.start > start && p.start < start + HOUR_MS);
  return { start, end: nextG ? nextG.start : start + HOUR_MS, type: 'program', kind: 'live', title: ch.name, show: null, live: true, sub: ch.iptv.group || 'Live TV', poster: ch.iptv.logo || null };
}
let guides = {};
const HOUR_MS = 3600e3;
let liveSeq = 0;

// TVs on the network, kept fresh in the background so "Cast" opens instantly.
// A TV stays listed for a few minutes after it was last heard from (mDNS answers can be missed).
const tvSeen = new Map();
async function lookForTvs() {
  // Automated tests: one pretend TV, and no real discovery (HOMECABLE_FAKE_TV).
  if (process.env.HOMECABLE_FAKE_TV) { castDevices = [{ id: 'fake-tv', name: 'Test TV', model: 'Fake', host: '127.0.0.1', fake: true }]; return castDevices; }
  const found = await cast.discover().catch(() => []);
  const now = Date.now();
  for (const d of found) tvSeen.set(d.id, { ...d, seen: now });
  for (const [id, d] of tvSeen) if (now - d.seen > 5 * 60e3 && casting?.device.id !== id) tvSeen.delete(id);
  const before = castDevices.map((d) => d.id).sort().join();
  castDevices = [...tvSeen.values()];
  if (castDevices.map((d) => d.id).sort().join() !== before) send('cast-devices', publicDevices());
  return castDevices;
}
// The TV you used last comes first.
const publicDevices = () => castDevices
  .map(({ id, name, model }) => ({ id, name, model, last: settings.castLast?.id === id }))
  .sort((a, b) => b.last - a.last || a.name.localeCompare(b.name));

async function startCasting(deviceId, mode = settings.castMode || 'mirror') {
  mode = mode === 'media' ? 'media' : 'mirror';
  if (casting?.device.id === deviceId) return casting.mode === mode ? castState() : setCastMode(mode);
  if (casting) await stopCasting('switch');
  let device = castDevices.find((d) => d.id === deviceId);
  if (!device) { await lookForTvs(); device = castDevices.find((d) => d.id === deviceId); }
  if (!device) throw new Error('That TV isn’t answering — is it switched on?');
  const lanIp = device.fake ? '127.0.0.1' : cast.localAddressFor(device.host);
  if (!lanIp) throw new Error('This PC isn’t on the same network as that TV');
  const session = device.fake ? new cast.FakeSession() : new cast.CastSession(device);
  await session.connect();
  await session.launch();
  await media.openCast();
  if (mode === 'media') media.stopStreams(); // the picture moves to the TV
  casting = { session, device, lanIp, mode };
  session.on('media', (st) => {
    send('cast-media', { playerState: st.playerState, idleReason: st.idleReason, currentTime: st.currentTime, mediaSessionId: st.mediaSessionId });
    trackMirrorDelay(st);
  });
  session.on('closed', (reason) => {
    if (casting?.session !== session) return;
    casting = null;
    stopMirrorStream();
    media.closeCast(); media.stopStreams();
    log('cast ended:', reason);
    send('cast-state', { ...castState(), reason });
  });
  settings.castLast = { id: device.id, name: device.name };
  settings.castMode = mode;
  saveSettings();
  log('casting to', device.name, device.host, 'serving from', lanIp, 'mode', mode);
  send('cast-state', castState());
  if (mode === 'mirror') loadMirror();
  return castState();
}

// ---- "Cast everything": mirror the HomeCable window ----
// The window records itself (H.264 + sound, in small pieces); ffmpeg repackages that
// into the fragmented MP4 the Chromecast plays, straight down the TV's connection.
let mirrorStream = null;
function stopMirrorStream() {
  const m = mirrorStream;
  mirrorStream = null;
  if (!m) return;
  send('mirror', { on: false });
  try { m.ff.stdin.end(); } catch {}
  setTimeout(() => { try { m.ff.kill('SIGKILL'); } catch {} }, 500);
  try { m.res.end(); } catch {}
}
function mirrorRequest(req, res) {
  if (casting?.mode !== 'mirror') { res.writeHead(404); return res.end(); }
  stopMirrorStream();
  const { spawn } = require('child_process');
  const ff = spawn(require('./ffmpeg').ffmpegPath(), ['-hide_banner', '-loglevel', 'error',
    '-fflags', '+nobuffer+genpts', '-flags', 'low_delay', '-probesize', '64k', '-analyzeduration', '0',
    '-f', 'webm', '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '300000', '-flush_packets', '1', '-f', 'mp4', 'pipe:1'], { windowsHide: true });
  const m = (mirrorStream = { ff, res, bytes: 0, started: Date.now() });
  let err = '';
  ff.stderr.on('data', (c) => { err = (err + c).slice(-1000); });
  ff.on('close', (code) => { if (code && mirrorStream === m) log('mirror ffmpeg exited', code, err.trim()); });
  ff.stdin.on('error', () => {});
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  ff.stdout.on('data', (c) => { m.bytes += c.length; if (!m.firstByteAt) m.firstByteAt = Date.now(); });
  ff.stdout.pipe(res);
  req.on('close', () => { if (mirrorStream === m) stopMirrorStream(); });
  send('mirror', { on: true }); // the window starts recording itself
}
// How far the TV is behind this screen while mirroring (for diagnostics). Note: the
// Chromecast's built-in player keeps a few seconds of buffer for a live stream and
// can't be skipped ahead — seeking past what it has stalls it (tried, reverted).
function trackMirrorDelay(st) {
  const m = mirrorStream;
  if (!m?.firstByteAt || casting?.mode !== 'mirror' || st.playerState !== 'PLAYING' || typeof st.currentTime !== 'number') return;
  m.behind = (Date.now() - m.firstByteAt) / 1000 - st.currentTime;
}
setInterval(() => { if (mirrorStream && casting?.mode === 'mirror') casting.session.status(); }, 3000);

async function loadMirror() {
  if (casting?.mode !== 'mirror') return;
  const url = media.mirrorUrl(casting.lanIp);
  try { await casting.session.load({ url, contentType: 'video/mp4', live: true, title: 'HomeCable', subtitle: 'Your TV, live like cable' }); }
  catch (e) { log('mirror load failed', e.message); send('toast', 'The TV could not show the mirrored screen - try "Just the picture" in the cast menu'); }
}
async function setCastMode(mode) {
  if (!casting) { settings.castMode = mode; saveSettings(); return castState(); }
  if (casting.mode === mode) return castState();
  casting.mode = mode;
  settings.castMode = mode;
  saveSettings();
  if (mode === 'mirror') { media.stopStreams(); await loadMirror(); } else stopMirrorStream();
  log('cast mode', mode);
  send('cast-state', castState()); // the app re-tunes: picture-only sends the video itself
  return castState();
}

// "Start on my TV": when HomeCable opens, cast to the remembered TV as soon as it's seen.
let autoCastDone = false;
function watchForTvs() {
  const round = async () => {
    await lookForTvs();
    if (autoCastDone || casting || !settings.castAuto || !settings.castLast) return;
    if (!castDevices.some((d) => d.id === settings.castLast.id)) return;
    autoCastDone = true;
    try { await startCasting(settings.castLast.id); send('toast', `📺 Playing on ${settings.castLast.name}`); }
    catch (e) { log('auto-cast failed', e.message); send('toast', `Couldn’t reach ${settings.castLast.name} — still playing here`); }
  };
  setTimeout(round, 2500);
  setTimeout(round, 9000); // TVs waking up answer late
  setInterval(round, 90e3);
  // Stop trying to auto-cast a while after start (it's a "when HomeCable opens" thing).
  setTimeout(() => { autoCastDone = true; }, 60e3);
}

// ---- On Demand folder ----
// Videos\On Demand by default — or a folder you already made with that name.
// Two kinds of on-demand folder:
//   movies → "Movies On Demand" (channel 1), series → "HomeStreamer" (channel 2) for binge-watching shows.
const OD_KINDS = {
  movies: { setting: 'onDemandFolder', folder: 'On Demand', match: /^(homecable )?on[ -]?demand$/i, name: 'Movies On Demand', logo: '🎬', color: '#7b61ff', number: 1, label: 'On Demand folder' },
  series: { setting: 'seriesFolder', folder: 'Stream Demand', match: /^(stream ?demand|steam ?demand|home ?streamer|tv ?shows|series|shows)$/i, name: 'Stream Demand', logo: '📺', color: '#e0558a', number: 2, label: 'Stream Demand folder' },
};
const odKind = (k) => OD_KINDS[k] || OD_KINDS.movies;
// Videos\On Demand / Videos\HomeStreamer by default — or a folder you already made with a matching name.
function defaultOnDemandFolder(kind = 'movies') {
  const K = odKind(kind);
  const videos = process.env.HOMECABLE_VIDEOS || app.getPath('videos');
  try {
    const own = fs.readdirSync(videos, { withFileTypes: true }).find((d) => d.isDirectory() && K.match.test(d.name));
    if (own) return path.join(videos, own.name);
  } catch {}
  return path.join(videos, K.folder);
}
// Make the folder (if needed), read it, and point an On Demand / HomeStreamer channel at it.
async function useOnDemandFolder(folder, { channelId = null, makeChannel = true, kind = 'movies' } = {}) {
  const K = odKind(kind);
  const style = kind === 'series' ? 'series' : 'movies';
  folder = path.resolve(String(folder || ''));
  fs.mkdirSync(folder, { recursive: true });
  const old = settings[K.setting];
  settings[K.setting] = folder;
  saveSettings();
  const src = { type: 'folder', path: folder, label: K.label, includePending: true };
  const same = (x) => x.type === 'folder' && x.path.toLowerCase() === folder.toLowerCase();
  const usesOld = (c) => c.ondemand && old && c.sources.some((x) => x.type === 'folder' && x.path.toLowerCase() === old.toLowerCase());
  // The channel that uses the old folder (or the one asked for) switches to the new one.
  let ch = channelId ? channels.find((c) => c.id === channelId) : channels.find(usesOld);
  if (!ch && makeChannel) ch = channels.find((c) => c.ondemand && (c.odStyle || 'movies') === style && c.name === K.name);
  if (ch) {
    ch.ondemand = true;
    ch.odStyle = style;
    ch.sources = [...ch.sources.filter((x) => !(x.type === 'folder' && old && x.path.toLowerCase() === old.toLowerCase()) && !same(x) && !(x.type === 'kind' && x.mine)), src];
  } else if (makeChannel) {
    // Like a cable box: On Demand on channel 1, HomeStreamer on 2 (when free).
    ch = normalizeChannel({ name: K.name, logo: K.logo, color: K.color, ondemand: true, odStyle: style, number: channels.some((c) => c.number === K.number) ? null : K.number, sources: [src], rating: null });
    channels.push(ch);
  }
  saveChannels();
  send('channels-changed');
  log(`${K.label}:`, folder);
  const scan = () => lib.scan([folder], { policy: 'auto' });
  let r = await scan();
  for (let i = 0; r?.busy && i < 120; i++) { await new Promise((ok) => setTimeout(ok, 1000)); r = await scan(); }
  findMoviePosters().catch((e) => log('posters', e));
  return { folder, channelId: ch?.id || null, found: r?.found || 0, channels: sortedChannels() };
}

async function stopCasting(reason) {
  const c = casting;
  if (!c) return castState();
  casting = null;
  await c.session.stop();
  media.closeCast(); media.stopStreams();
  log('cast stopped:', reason);
  send('cast-state', { ...castState(), reason });
  return castState();
}

function tune(id, atTime, opts = {}) {
  const ch = visible().find((c) => c.id === id);
  if (!ch) return null;
  const now = Date.now();
  if (ch.ondemand) {
    if (!ch.locked && !opts.phone && settings.lastChannel !== id) { settings.prevChannel = settings.lastChannel; settings.lastChannel = id; saveSettings(); }
    return { channel: ch, ondemand: true, entry: onDemandEntry(ch, now), next: null, play: null, offset: 0, now, at: now, earliest: now };
  }
  if (ch.iptv) {
    if (!opts.phone && settings.lastChannel !== id) { settings.prevChannel = settings.lastChannel; settings.lastChannel = id; saveSettings(); }
    const entry = liveEntry(ch, now);
    return { channel: ch, entry, next: { ...liveEntry(ch, entry.end) }, offset: 0, now, at: now, earliest: now,
      play: { mode: 'live', url: media.liveUrl(ch.id, ++liveSeq), offset: 0, startedAt: 0, audioOnly: !!ch.iptv.audioOnly } };
  }
  sched.ensure([ch], now);
  const earliest = sched.stateOf(ch).programs[0]?.start ?? now;
  const t = atTime && atTime < now - 1500 ? Math.max(atTime, earliest) : now;
  let at = sched.at(ch, t);
  if (!at && t === now) { sched.rebuild(ch, now); at = sched.at(ch, now); }
  if (!at) return { channel: ch, entry: null, earliest, at: t };
  if (!opts.phone && settings.lastChannel !== id) { settings.prevChannel = settings.lastChannel; settings.lastChannel = id; saveSettings(); }
  const { entry, next, offset } = at;
  if (entry.type === 'live') {
    const st = channels.find((c) => c.id === entry.liveId && c.iptv);
    const le = st ? liveEntry(st, t) : null;
    const e = { ...describe(entry), live: true, kind: 'live', title: st?.name || entry.title, sub: [entry.block, le?.program].filter(Boolean).join(' · ') || 'Live', poster: st?.iptv.logo || null };
    return { channel: ch, entry: e, next: describe(next), offset, now, at: t, earliest,
      play: st ? { mode: 'live', url: media.liveUrl(st.id, ++liveSeq), offset: 0, startedAt: 0, audioOnly: !!st.iptv.audioOnly } : null };
  }
  const item = entry.itemId ? lib.items[entry.itemId] : null;
  return { channel: ch, entry: describe(entry), next: describe(next), offset, play: item ? playFor(item, offset, opts) : null, now, at: t, earliest };
}

let adSync = { at: 0, error: null, count: 0 };
async function syncAds() {
  try {
    const r = await adsLib.syncFeed(lib, adFeedUrl(), path.join(app.getPath('userData'), 'ads-cache'));
    adSync = { at: Date.now(), error: null, ...r };
    if (r.added || r.removed) { applyAds(); for (const ch of channels) if (!ch.iptv) sched.rebuild(ch); send('schedule-changed'); }
    log('ads synced', JSON.stringify(r));
  } catch (e) {
    adSync = { ...adSync, at: Date.now(), error: e.message };
    log('ad sync', e.message);
  }
  return adSync;
}

// ---- Ad packs ----
// An ad pack is just a folder of short videos (45 s or less) — easy to zip,
// share and update. Two homes: the pack that ships inside HomeCable itself
// (assets/ads in source, resources/ads installed — updates arrive with the app),
// and your own packs, one folder each, under <data>\ad-packs\. Every pack has
// its own on/off switch; breaks shuffle whatever's on. No hosting, no internet.
// Ads are never media: they live in breaks only, never in the Library or walls.
const bundledAdsDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'ads') : path.join(__dirname, '../../assets/ads'));
const adPacksDir = () => path.join(app.getPath('userData'), 'ad-packs');
// Which pack an ad belongs to: ':bundled', a pack folder's name, or null (hosted feed / legacy).
function adPackOf(it) {
  const p = String(it.path || '').toLowerCase();
  if (p.startsWith(bundledAdsDir().toLowerCase() + path.sep)) return ':bundled';
  const home = adPacksDir().toLowerCase() + path.sep;
  if (p.startsWith(home)) return String(it.path).slice(home.length).split(/[\\/]/)[0];
  return null;
}
// Is this ad's pack switched on? An ad no switch covers (an orphan from a moved
// install or an old setup) never airs — every ad answers to some switch.
function adEnabled(it) {
  const pk = adPackOf(it);
  if (pk === ':bundled') return settings.adsBundled !== false;
  if (pk) return (settings.adPacks || {})[pk] !== false;
  return it.server === 'ads:feed'; // hosted-pack ads (synced feed)
}
const packDirs = () => {
  const out = [];
  if (fs.existsSync(bundledAdsDir())) out.push(bundledAdsDir());
  try { for (const d of fs.readdirSync(adPacksDir(), { withFileTypes: true })) if (d.isDirectory()) out.push(path.join(adPacksDir(), d.name)); } catch {}
  return out;
};
async function loadAdPacks(alsoRebuild = false) {
  // Ads whose files are gone, and orphans no switch covers (another install's
  // bundled folder, an old setup), drop out of the library entirely.
  let dropped = 0;
  for (const [id, it] of Object.entries(lib.items)) {
    if (it.kind !== 'ad' || it.remote) continue;
    if (!fs.existsSync(it.path) || (!adPackOf(it) && it.server !== 'ads:feed')) { delete lib.items[id]; dropped++; }
  }
  const dirs = packDirs();
  let added = 0;
  if (dirs.length) {
    let r = await lib.scan(dirs, { remember: false, prune: false, policy: 'auto', minBytes: 64 * 1024 }).catch(() => null);
    for (let i = 0; r?.busy && i < 60; i++) { await new Promise((ok) => setTimeout(ok, 1000)); r = await lib.scan(dirs, { remember: false, prune: false, policy: 'auto', minBytes: 64 * 1024 }).catch(() => null); }
    added = r?.added || 0;
    for (const dir of dirs) adsLib.markFolder(lib, dir);
    // Numbered files get clean names — the banner says "Ad 3", not "Episode 3".
    for (const it of Object.values(lib.items)) {
      if (it.kind !== 'ad' || !adPackOf(it)) continue;
      const base = path.basename(it.path, path.extname(it.path));
      it.title = /^\d+$/.test(base) ? 'Ad ' + base : base;
    }
    lib.save();
  }
  if ((added || dropped || alsoRebuild) && settings.adsOn) {
    applyAds();
    for (const ch of channels) if (!ch.iptv) sched.rebuild(ch);
    send('schedule-changed');
  }
  if (added || dropped) log(`ad packs: ${added} added, ${dropped} stale removed (${dirs.length} packs)`);
  return { added, dropped, packs: dirs.length };
}
// One-time (1.4.0): the ads now live inside the app — nothing points at a synced
// folder (OneDrive) or a hosted ad pack any more unless it's set up fresh.
function migrateAds() {
  if (settings.adsV140) return false;
  const old = String(settings.adFolder || '');
  for (const [id, it] of Object.entries(lib.items)) if (it.server === 'ads:feed') delete lib.items[id];
  if (old) {
    const pre = old.toLowerCase().replace(/[\\/]+$/, '') + path.sep;
    for (const [id, it] of Object.entries(lib.items)) if (!it.remote && String(it.path).toLowerCase().startsWith(pre)) delete lib.items[id];
    try { lib.removeFolder(old); } catch {}
    log('ads: forgot the old ad folder', old);
  }
  lib.save();
  settings.adFolder = '';
  settings.adFeed = '';
  delete settings.adsBuiltIn; // the joke cards are gone — the shipped videos are the joke ads now
  settings.adsV140 = true;
  saveSettings();
  return true;
}

// Feed the scheduler the current ad settings + pool: real video ads only — the
// pack that ships with HomeCable plus whichever of your packs are switched on.
function applyAds() {
  sched.ads = {
    enabled: !!settings.adsOn, seconds: Math.max(5, Math.min(45, +settings.adSeconds || 30)), every: settings.adEvery,
    pool: () => lib.list().filter((i) => i.kind === 'ad' && i.duration <= 60 && adEnabled(i)).map((i) => ({ id: i.id, title: i.title, duration: i.duration })),
  };
}
const AD_KEYS = ['adsOn', 'adSeconds', 'adEvery', 'adFeed', 'adFolder', 'adsBundled'];

// Channel bumpers: the channel's own logo for a few seconds between shows.
function applyIdents() { sched.idents = settings.bumpersOn === false ? null : { enabled: true, seconds: Math.max(3, Math.min(10, +settings.bumperSeconds || 5)) }; }

// Adults see the whole library; teens and kids only what's on channels they can see.
// Ads are never media: they live in commercial breaks only, never in these lists.
function allowedItems() {
  if (profiles.isAdult()) return lib.list().filter((i) => i.kind !== 'ad');
  const ids = new Set();
  for (const ch of visible()) for (const s of [...ch.sources, ...ch.blocks.flatMap((b) => b.sources || [])]) for (const it of lib.resolve(s)) if (!chExcluded(ch, it)) ids.add(it.id);
  return lib.list().filter((i) => ids.has(i.id) && i.kind !== 'ad');
}

function itemSummary(i) {
  return { id: i.id, poster: posterUrl(i), posterFrom: i.posterFrom || null, title: i.titleUser || i.title, renamed: !!i.titleUser, show: lib.meta[i.showKeyUser || i.showKey]?.nameOverride || i.showUser || i.show, showKey: i.showKeyUser || i.showKey, season: i.seasonUser ?? i.season, episode: i.episodeUser ?? i.episode, kind: i.kindUser || i.kind, duration: i.duration, path: i.path,
    year: i.year, folder: i.folder, mode: i.mode, status: i.status || 'active', added: i.added, remote: !!i.remote, server: i.server || null, art: i.art || null, genres: i.genres || null, moved: !!i.showKeyUser };
}

// Look in every folder and media server; new things follow the new-media policy.
async function scanEverything() {
  if (lib.scanning) return { busy: true };
  const r = await lib.rescanAll({ policy: settings.newMedia });
  settings.lastScan = Date.now();
  saveSettings();
  ensureNewArrivals();
  if (r.added) send('new-media', { added: r.added, pending: r.pending, policy: settings.newMedia });
  return r;
}

// Free live TV: fetch the public lists, test every station, and add the ones
// that actually play — progressively, in the background.
let iptvJob = null;
async function iptvAutoAdd({ country = 'us', countries = null, regions = [], categories = [], languages = [], max = 100, urls = [], skipPresets = false, sources = ['iptv-org', 'free-tv'], anime = false } = {}) {
  if (iptvJob) return iptvJob;
  const ccs = [...new Set((Array.isArray(countries) && countries.length ? countries : [country]).map((c) => String(c).toLowerCase()))];
  iptvJob = (async () => {
    const all = [...(skipPresets || !sources.includes('iptv-org') ? [] : [...ccs.map((cc) => iptv.presetUrl({ country: cc })), ...(regions || []).map((rg) => iptv.presetUrl({ region: rg })), ...languages.map((l) => iptv.presetUrl({ language: l })), ...categories.map((c) => iptv.presetUrl({ category: c }))]), ...urls];
    const lists = await Promise.all(all.map((u) => iptv.fetchPlaylist(u).catch((e) => { log('playlist', u, e.message); return []; })));
    if (!skipPresets && sources.includes('free-tv')) for (const cc of ccs) lists.unshift(await iptv.fetchFreeTv(cc).catch((e) => { log('free-tv', e.message); return []; }));
    if (anime) lists.unshift(await iptv.fetchAnime().catch((e) => { log('anime', e.message); return []; }));
    playlistGuides = [...new Set(lists.flatMap((l) => l.tvgUrls || []))].slice(0, 4);
    const have = new Set(channels.filter((c) => c.iptv).map((c) => c.iptv.url));
    const seenName = new Set(channels.filter((c) => c.iptv).map((c) => c.name.toLowerCase()));
    const candidates = [];
    for (const st of lists.flat()) {
      if (st.flags.geo || have.has(st.url) || seenName.has(st.name.toLowerCase())) continue;
      have.add(st.url); seenName.add(st.name.toLowerCase());
      candidates.push(st);
    }
    // Most-watched kinds of channels first; religious/shopping/government last; at
    // most two stations per network brand so one broadcaster can't fill the lineup.
    const PREFER = ['movies', 'news', 'entertainment', 'kids', 'animation', 'sports', 'comedy', 'music', 'classic', 'series', 'documentary', 'family', 'general', 'science', 'cooking', 'travel', 'outdoor'];
    const LAST = ['religious', 'shop', 'legislative', 'business', 'weather', 'auto'];
    const rank = (st) => {
      const g = (st.group || '').toLowerCase();
      const p = PREFER.findIndex((x) => g.includes(x));
      if (st.anime) return -1; // asked for anime: those go first
      return (LAST.some((x) => g.includes(x)) ? 100 : p < 0 ? 50 : p) - (/1080p|720p/.test(st.name) ? 0.5 : 0) + (st.flags.part ? 20 : 0);
    };
    candidates.sort((a, b) => rank(a) - rank(b));
    const perBrand = new Map();
    const brand = (n) => n.toLowerCase().replace(/\(.*?\)/g, '').split(/\s+/)[0];
    const kept = [];
    for (const st of candidates) { const b = brand(st.name); const n = perBrand.get(b) || 0; if (n < 2) { perBrand.set(b, n + 1); kept.push(st); } }
    candidates.length = 0; candidates.push(...kept);
    const cap = max > 0 ? max : Infinity; // 0 = no limit: every station that works
    let added = 0, checked = 0, i = 0, lastSave = 0;
    send('iptv-progress', { checked, total: candidates.length, added, running: true });
    await Promise.all(Array.from({ length: 10 }, async () => {
      // Each worker shrugs off anything a station throws at it — a stream that
      // doesn't answer in time is skipped and the next one is tried.
      while (i < candidates.length && added < cap) {
        const st = candidates[i++];
        try {
          const check = await iptv.checkStream(st, 10000);
          checked++;
          if (check.ok && added < cap) {
            added++;
            channels.push(normalizeChannel({
              number: nextNumber(settings.liveStart || 100), name: st.name.slice(0, 60), color: PALETTE[channels.length % PALETTE.length],
              iptv: { url: st.url, logo: st.logo, group: st.group, genre: stationGenre(st.name, st.group), tvgId: st.tvgId, country: st.country, userAgent: st.userAgent, referer: st.referer, audioOnly: !check.video, mode: check.video && check.video !== 'h264' ? 'transcode' : 'copy' },
            }));
            // Saving is synchronous (whole channel list to disk) — doing it for every
            // station stuttered whatever was PLAYING during a big add. Save at most
            // every few seconds; the final save below catches the rest.
            if (Date.now() - lastSave > 3000) { lastSave = Date.now(); saveChannels(); }
            send('channels-changed');
          }
        } catch (e) { checked++; log('iptv check', st.name, e.message); }
        send('iptv-progress', { checked, total: candidates.length, added, running: true, name: st.name });
      }
    }));
    saveChannels();
    // Done: tell every screen to refresh so the new stations appear right away.
    send('channels-changed');
    send('schedule-changed');
    send('iptv-progress', { checked, total: candidates.length, added, running: false });
    log('iptv auto: checked', checked, 'added', added);
    return { added, checked };
  })();
  try { return await iptvJob; } finally { iptvJob = null; }
}

// Program guides for live stations (free-streamer guides + playlist-declared + epg.pw by country).
let playlistGuides = [];
// Fetched iptv-org playlists, kept for the session so searching is instant.
const iptvCatalog = new Map();
// Free guide files for the big free streamers (i.mjh.nz, see NOTICES.md) — only
// fetched when the lineup actually has stations from that service, so "what's on"
// shows the real programme names and times instead of hour-long "Live" slots.
function providerGuides(stations, cc) {
  const urls = [];
  const has = (re) => stations.some((s) => re.test(s.url || ''));
  if (has(/pluto\.tv/i)) urls.push(`https://i.mjh.nz/PlutoTV/${cc}.xml.gz`, 'https://i.mjh.nz/PlutoTV/all.xml.gz');
  if (has(/samsung/i)) urls.push(`https://i.mjh.nz/SamsungTVPlus/${cc}.xml.gz`, 'https://i.mjh.nz/SamsungTVPlus/all.xml.gz');
  if (has(/plex\.tv/i)) urls.push('https://i.mjh.nz/Plex/us.xml.gz');
  if (has(/stirr/i)) urls.push('https://i.mjh.nz/Stirr/all.xml.gz');
  if (has(/roku/i)) urls.push('https://i.mjh.nz/Roku/all.xml.gz');
  return urls;
}
async function refreshGuides() {
  const stations = channels.filter((c) => c.iptv).map((c) => ({ id: c.id, name: c.name, tvgId: c.iptv.tvgId, url: c.iptv.url }));
  if (!stations.length) return 0;
  const cc = settings.live?.country || 'us';
  const urls = [...new Set([...providerGuides(stations, cc), ...epg.COUNTRY_GUIDES(cc).slice(1), ...playlistGuides, ...(settings.live?.guideUrls || [])])];
  const g = await epg.buildGuide(stations, urls, { log });
  guides = g;
  store.write('guides', { at: Date.now(), guides });
  send('schedule-changed');
  return Object.keys(g).length;
}

// Once a day: re-test stations, drop ones that stayed off the air, top the lineup up, refresh guides.
async function refreshLive() {
  if (!settings.live) return;
  settings.lastLiveRefresh = Date.now();
  saveSettings();
  // NEVER probe the station being WATCHED: many free servers allow one
  // connection per viewer and kick the live session when the test connects —
  // that was "my stream just randomly died mid-show" after the boot re-scan
  // shipped. The watched channel keeps its current state untouched.
  const live = channels.filter((c) => c.iptv && c.id !== settings.lastChannel);
  // A few at a time, not one by one — re-checking hundreds of stations serially
  // took ages; in parallel the whole lineup is done in a couple of minutes.
  if (live.length) {
    const results = await iptv.checkMany(live.map((c) => c.iptv), { concurrency: 8 });
    live.forEach((ch, i) => {
      const r = results[i]?.check || { ok: false };
      if (r.ok) { delete ch.iptv.dead; ch.iptv.misses = 0; } else { ch.iptv.dead = ch.iptv.dead || Date.now(); ch.iptv.misses = (ch.iptv.misses || 0) + 1; }
    });
  }
  // Removing stations is the USER's call, not the program's (Free TV manager →
  // Remove dead). Auto-remove is opt-in; even then the channel being WATCHED
  // (settings.lastChannel) is never pulled out from under them. The 💤 dead
  // mark itself is informational either way.
  const gone = settings.live.autoRemove
    ? channels.filter((c) => c.iptv && c.iptv.misses >= 3 && c.id !== settings.lastChannel).map((c) => c.id)
    : [];
  channels = channels.filter((c) => !gone.includes(c.id));
  if (gone.includes(settings.lockChannel)) settings.lockChannel = null;
  if (gone.includes(settings.lastChannel)) settings.lastChannel = channels.find((c) => !c.ondemand)?.id || null;
  if (gone.length) saveSettings();
  saveChannels();
  const have = channels.filter((c) => c.iptv).length;
  const cap = settings.live.max > 0 ? settings.live.max : Infinity;
  if (have < cap) await iptvAutoAdd({ ...settings.live, max: cap === Infinity ? 0 : cap - have });
  await refreshGuides();
  send('channels-changed');
  log('live refresh: removed', gone.length, 'now', channels.filter((c) => c.iptv).length);
}

// A cable-style "New Arrivals" channel that plays whatever was added lately.
function ensureNewArrivals() {
  if (!settings.newArrivals || !channels.length) return;
  if (channels.some((c) => c.sources.some((s) => s.type === 'recent'))) return;
  if (!lib.resolve({ type: 'recent', days: 14 }).length) return;
  const ch = normalizeChannel({ name: 'New Arrivals', logo: '✨', order: 'shuffle', align: settings.defaultAlign ?? 30 /* follows the timing picked in setup */, sources: [{ type: 'recent', days: 14, label: 'Added in the last 2 weeks' }] });
  channels.push(ch);
  saveChannels();
  sched.ensure([ch]);
  send('channels-changed');
}

let miniBack = null; // the window's size before mini mode
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1440, Math.round(width * 0.85)), height: Math.min(900, Math.round(height * 0.85)), minWidth: 860, minHeight: 440,
    backgroundColor: '#07080b', frame: false, show: false, title: 'HomeCable',
    icon: path.join(__dirname, '../../assets/icon.png'),
    // backgroundThrottling OFF: HomeCable plays in the background by design.
    // With it on (the default), a hidden window's timers drop to once a minute,
    // so the between-shows rollover lagged minutes behind and looked frozen —
    // exactly "it just stopped while I was working / it ended and never moved on".
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  // Automated checks can run without popping a window up on the screen.
  if (process.env.HOMECABLE_OFFSCREEN) { win.setPosition(-10000, -10000); win.setSkipTaskbar(true); win.showInactive(); }
  else win.once('ready-to-show', () => { win.show(); if (settings.startFullscreen) win.setFullScreen(true); });
  win.on('enter-full-screen', () => send('fullscreen', true));
  win.on('leave-full-screen', () => send('fullscreen', false));
  win.on('maximize', () => send('maximized', true));
  win.on('unmaximize', () => send('maximized', false));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

function handlers() {
  // Changing things is for grown-ups; watching is for everyone.
  const ADMIN = new Set(['channels:create', 'channels:update', 'channels:delete', 'channels:renumber', 'channels:setNumber', 'channels:addSources', 'channels:related', 'channels:logoPick', 'live:mix', 'live:renumber',
    'iptv:add', 'iptv:auto', 'iptv:removeDead', 'iptv:checkAll', 'iptv:recheck', 'iptv:addOne', 'iptv:autoRemove', 'channels:hide', 'free:add', 'sources:add', 'sources:removeServer', 'library:scan', 'library:rescan',
    'library:removeFolder', 'library:approve', 'library:scanAll', 'library:pickFolders', 'import:legacy', 'ads:makePack', 'ads:pickFolder', 'ads:sync', 'ads:packAdd', 'ads:packsOpen', 'ads:rescanPacks', 'guides:refresh',
    'profiles:upsert', 'profiles:remove', 'profiles:setLock', 'profiles:ask', 'ondemand:useFolder', 'ondemand:pickFolder', 'art:set', 'art:candidates', 'art:pickFile', 'meta:refresh', 'meta:refreshAll', 'name:set', 'show:move', 'show:make', 'tags:set', 'items:hide', 'app:startOver', 'vault:create', 'vault:update', 'vault:remove', 'phone:enable', 'phone:pairStart', 'phone:forget', 'phone:setLevel']);
  const VIEWER_SETTINGS = new Set(['volume', 'muted', 'brightness', 'fit', 'lastChannel', 'prevChannel', 'arcadeScores', 'castAuto', 'castHinted', 'vodResume', 'vodWatched', 'castMode', 'showLast', 'subMode', 'subLang', 'audioPref', 'liveCaptions']);
  const h = (name, fn) => (handlerFns[name] = fn, ipcMain.handle(name, async (_e, ...a) => {
    if (ADMIN.has(name) && !profiles.isAdult()) throw new Error('Ask a grown-up to do that');
    if (name === 'settings:set' && !profiles.isAdult() && Object.keys(a[0] || {}).some((k) => !VIEWER_SETTINGS.has(k))) throw new Error('Ask a grown-up to change settings');
    try { return await fn(...a); } catch (err) { log('ipc', name, err.stack || err); throw err; }
  }));
  let fails = 0, lockedUntil = 0;

  // Profiles
  h('profiles:view', () => profiles.view());
  h('profiles:switch', (id, secret) => {
    if (Date.now() < lockedUntil) return { ok: false, wait: Math.ceil((lockedUntil - Date.now()) / 1000) };
    const ok = profiles.switchTo(id, secret);
    if (!ok) { if (++fails >= 5) { lockedUntil = Date.now() + 30e3; fails = 0; } return { ok: false }; }
    fails = 0;
    vaultOpen = false;
    // A channel this profile can't see is no longer "last watched".
    if (!visible().some((c) => c.id === settings.lastChannel)) { settings.lastChannel = sortedChannels()[0]?.id || null; saveSettings(); }
    send('channels-changed');
    return { ok: true, view: profiles.view() };
  });
  h('profiles:upsert', (p) => profiles.upsert(p));
  h('profiles:remove', (id) => profiles.remove(id));
  h('profiles:setLock', (id, type, secret) => profiles.setLock(id, type, secret));
  h('profiles:ask', (on) => { profiles.askAtStart = !!on; profiles.save(); return profiles.view(); });
  h('channels:setRating', (id, rating) => {
    if (!profiles.isAdult()) throw new Error('Ask a grown-up to do that');
    const ch = channels.find((c) => c.id === id);
    if (ch && ['all', 'teen', 'adult'].includes(rating)) { ch.rating = rating; saveChannels(); send('channels-changed'); }
    return sortedChannels();
  });

  h('state', () => ({ channels: sortedChannels(), settings: shownSettings(), stats: libraryStats(), version: app.getVersion(), profile: profiles.view(), isAdult: profiles.isAdult(), cast: castState() }));

  // ---- Chromecast ----
  h('cast:devices', async (refresh) => {
    if (process.env.HOMECABLE_NO_CAST && !refresh) return publicDevices(); // automated tests: don't go looking for real TVs
    if (refresh || !castDevices.length) await lookForTvs();
    return publicDevices();
  });
  h('cast:start', (deviceId, mode) => startCasting(deviceId, mode));
  h('cast:mode', (mode) => setCastMode(mode === 'media' ? 'media' : 'mirror'));
  h('mirror:sourceId', () => win.getMediaSourceId());
  h('mirror:stats', () => (mirrorStream ? { behind: mirrorStream.behind ?? null, bytes: mirrorStream.bytes } : null));
  ipcMain.on('mirror:chunk', (_e, buf) => { const m = mirrorStream; if (m && buf) { try { m.ff.stdin.write(Buffer.from(buf)); } catch {} } });
  h('cast:stop', () => stopCasting('user'));
  h('cast:state', () => castState()); // light — the phone app asks every couple of seconds
  h('cast:load', async (o) => {
    if (!casting) throw new Error('Not casting');
    const url = media.castUrl(o.url, casting.lanIp);
    if (!url) throw new Error('Can’t send that to the TV');
    const [, route, id] = new URL(o.url).pathname.split('/');
    const item = lib.items[id];
    const contentType = route === 'direct' && item ? media.contentTypeFor(item) || 'video/mp4' : o.audioOnly ? 'audio/mp4' : 'video/mp4';
    // Only pictures the TV can fetch itself (public web artwork).
    let image = /^https:\/\//.test(o.image || '') ? o.image : undefined;
    const artId = !image && /\/art\/([^/?]+)/.exec(o.image || '')?.[1];
    if (artId && /^https:/.test(lib.items[artId]?.posterUrl || '')) image = lib.items[artId].posterUrl;
    try {
      const st = await casting.session.load({ url, contentType, live: route === 'live', startAt: o.startAt || 0, title: o.title, subtitle: o.subtitle, image, music: o.audioOnly });
      return { ok: true, mediaSessionId: st?.mediaSessionId ?? null };
    } catch (e) {
      log('cast load failed', e.message, route, item?.path || '');
      return { ok: false, error: e.message };
    }
  });
  h('cast:control', (type, t) => {
    const s = casting?.session;
    if (!s) return;
    if (type === 'PLAY') s.play(); else if (type === 'PAUSE') s.pause(); else if (type === 'SEEK') s.seek(t); else if (type === 'STATUS') s.status();
    else if (type === 'VOLUME') s.setVolume(t);
  });
  h('settings:set', async (patch) => {
    if (patch && 'vault' in patch) { patch = { ...patch }; delete patch.vault; } // only changed through vault:*
    if ('subMode' in patch || 'subLang' in patch) subsCache.clear(); // (audioPref is applied per request)
    Object.assign(settings, patch);
    lib.defaultPolicy = settings.newMedia;
    saveSettings();
    if ('newArrivals' in patch) ensureNewArrivals();
    if (AD_KEYS.some((k) => k in patch) || 'adPacks' in patch || 'bumpersOn' in patch || 'bumperSeconds' in patch) {
      if ('adFeed' in patch || ('adsOn' in patch && settings.adsOn)) await syncAds();
      if ('adFolder' in patch && settings.adFolder) { await lib.scan([settings.adFolder], { prune: false, policy: 'auto', minBytes: 64 * 1024 }); adsLib.markFolder(lib, settings.adFolder); }
      applyAds();
      applyIdents();
      // Re-plan what hasn't aired yet; what's on now keeps playing. One channel
      // at a time with a breath between each — a solid block of re-planning used
      // to starve the media server and stall whatever was PLAYING.
      for (const ch of channels) if (!ch.iptv) { sched.rebuild(ch); await new Promise((r) => setImmediate(r)); }
      send('schedule-changed');
    }
    return shownSettings();
  });
  h('ads:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Folder with your own funny ads (short videos)', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('ads:makePack', async (folder) => adsLib.makePack(folder || settings.adFolder));
  h('ads:sync', () => syncAds());
  h('ads:status', () => ({ feed: adFeedUrl(), builtInFeed: BUILT_IN_AD_FEED, ...adSync }));
  h('ads:count', () => {
    const ads = lib.list().filter((i) => i.kind === 'ad');
    const bundled = ads.filter((i) => adPackOf(i) === ':bundled').length;
    return { bundled, yours: ads.length - bundled };
  });
  // Ad packs: the one shipped with the app, plus one folder per pack of your own.
  h('ads:packs', () => {
    const ads = lib.list().filter((i) => i.kind === 'ad');
    const packs = [];
    try {
      for (const d of fs.readdirSync(adPacksDir(), { withFileTypes: true })) if (d.isDirectory())
        packs.push({ name: d.name, count: ads.filter((i) => adPackOf(i) === d.name).length, on: (settings.adPacks || {})[d.name] !== false });
    } catch {}
    return { bundled: { count: ads.filter((i) => adPackOf(i) === ':bundled').length, on: settings.adsBundled !== false }, packs: packs.sort((a, b) => a.name.localeCompare(b.name)), folder: adPacksDir() };
  });
  // "Add a pack…": copies a folder of short videos into <data>\ad-packs\<name>.
  h('ads:packAdd', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Pick a folder of short ad videos (45 seconds or less) — it becomes one pack', properties: ['openDirectory'] });
    if (r.canceled) return null;
    const src = r.filePaths[0];
    const { mediaType } = require('./naming');
    const name = path.basename(src).replace(/[<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Ad pack';
    const dest = path.join(adPacksDir(), name);
    fs.mkdirSync(dest, { recursive: true });
    let copied = 0;
    for (const f of fs.readdirSync(src)) if (mediaType(f) === 'video') { fs.copyFileSync(path.join(src, f), path.join(dest, f)); copied++; }
    const res = await loadAdPacks(true);
    return { name, copied, registered: res.added };
  });
  h('ads:packsOpen', () => { fs.mkdirSync(adPacksDir(), { recursive: true }); return shell.openPath(adPacksDir()); });
  // One random shipped ad, playable — the setup page shows it off.
  h('ads:preview', () => {
    const ads = lib.list().filter((i) => i.kind === 'ad' && adPackOf(i) === ':bundled');
    if (!ads.length) return null;
    const a = ads[Math.floor(Math.random() * ads.length)];
    return { url: media.urlFor(a.id, { mode: 'direct' }), title: a.title };
  });
  h('ads:rescanPacks', () => loadAdPacks(true));

  h('tune', (id, at) => tune(id, at));

  h('channels:genres', () => {
    const out = {};
    for (const ch of sortedChannels()) {
      if (ch.iptv) { out[ch.id] = [...new Set([ch.iptv.genre || stationGenre(ch.name, ch.iptv.group), ...String(ch.iptv.group || '').split(/[;,/]/).map((x) => x.trim()).filter(Boolean)])]; continue; }
      if (ch.ondemand) { out[ch.id] = []; continue; }
      const prof = new Map();
      for (const s of ch.sources) for (const it of lib.resolve(s)) {
        if (chExcluded(ch, it)) continue;
        const k = it.showKeyUser || it.showKey;
        for (const g of (k ? lib.meta[k]?.genres : it.genres) || []) prof.set(g, (prof.get(g) || 0) + 1);
      }
      out[ch.id] = [...prof.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map((x) => x[0]);
    }
    return out;
  });
  h('guide', (from, to) => {
    // On Demand / Stream Demand aren't channels you tune into on a schedule — they're not in the guide.
    const list = sortedChannels().filter((c) => !c.ondemand);
    sched.ensure(list);
    const liveRow = (ch) => {
      const out = [];
      for (let t = from; t < to && out.length < 60;) {
        const e = liveEntry(ch, t);
        // Sloppy guide data can overlap programmes — clip each cell to start
        // where the last one ended, so titles never draw on top of each other.
        const start = Math.max(e.start, t);
        const end = Math.max(e.end, start + 60e3);
        out.push({ ...e, start, end, title: e.program || ch.name, sub: e.program ? e.sub.replace(e.program, '').replace(/^ — /, '') : 'Live', stationId: ch.id });
        t = end;
      }
      return out;
    };
    return list.map((ch) => ch.iptv ? { id: ch.id, live: true, entries: liveRow(ch) } : ({ id: ch.id, entries: sched.range(ch, from, to).map((e) => ({ start: e.start, end: e.end, type: e.type, title: e.title, show: e.show, season: e.season, episode: e.episode, kind: e.kind, block: e.block })) }));
  });
  // The <video> element couldn't decode a "direct" file: remember and transcode instead.
  h('playback:failed', (itemId, code, channelId) => {
    const ch = channelId && channels.find((c) => c.id === channelId);
    if (ch?.iptv) {
      // While casting, a station the TV can't take isn't "off the air" — just re-encode it.
      if (casting?.mode === 'media' && ch.iptv.mode === 'transcode') return null;
      // Couldn't copy the station's video as-is: re-encode it from now on.
      // Already re-encoding and still failing: nothing more to try right now —
      // but NEVER flag a station dead while someone is watching it (that pulled
      // it out of the guide mid-watch). The boot/daily lineup check handles
      // stations that are truly gone; the player keeps quietly retrying.
      if (ch.iptv.mode === 'transcode') return null;
      ch.iptv.mode = 'transcode';
      saveChannels();
      log('iptv fallback to transcode', ch.name);
      return 'transcode';
    }
    const it = lib.items[itemId];
    if (!it) return null;
    if (casting?.mode === 'media') {
      // Only for the TV: playback on this PC keeps its own (better) mode.
      const was = it.castForce || cast.castMode(it);
      if (was === 'transcode') return null;
      it.castForce = was === 'direct' && it.vcodec === 'h264' ? 'remux' : 'transcode';
      log('cast fallback', was, '->', it.castForce, it.path);
      return it.castForce;
    }
    const cur = it.forceMode || it.mode;
    it.forceMode = cur === 'direct' ? (it.vcodec === 'h264' ? 'remux' : 'transcode') : 'transcode';
    if (cur === 'transcode') return null;
    log('playback fallback', cur, '->', it.forceMode, it.path);
    lib.save();
    return it.forceMode;
  });
  h('playing', (on) => {
    if (on && sleepBlock == null) sleepBlock = powerSaveBlocker.start('prevent-display-sleep');
    if (!on && sleepBlock != null) { powerSaveBlocker.stop(sleepBlock); sleepBlock = null; }
  });

  // Library
  // Tests can point "your usual places" at a fixed folder.
  // Each root says whether it's a video place: only those get pre-ticked in setup
  // (Downloads, Desktop and whole drives stay listed but unticked — media is the
  // job; nobody wants their code or ComfyUI folders indexed).
  h('library:quickRoots', () => (process.env.HOMECABLE_QUICK_ROOTS
    ? process.env.HOMECABLE_QUICK_ROOTS.split(';').map((p) => ({ path: p, video: true }))
    : quickScanRoots().map((p) => ({ path: p, video: /^(videos|movies|movie|tv|tv shows|shows|film|films|media|video|plex|jellyfin|recordings|dvr)$/i.test(path.basename(p)) }))));
  h('library:scan', async (kind) => {
    const roots = Array.isArray(kind) ? kind : kind === 'deep' ? deepScanRoots() : quickScanRoots();
    const r = await lib.scan(roots, { prune: true });
    return r;
  });
  h('library:rescan', () => lib.scan(lib.folders, { prune: true }));
  h('library:pickFolders', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Add folders with videos', properties: ['openDirectory', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  h('library:removeFolder', (f) => { lib.removeFolder(f); return libraryStats(); });
  h('library:shows', () => lib.shows().map(({ key, name, count, seasons, avg, meta, folders }) => ({ key, name, count, seasons, avg, folders, poster: meta?.poster || null, genres: meta?.genres || [] })));
  h('library:items', (kind) => lib.list().filter((i) => i.kind !== 'ad' && (!kind || i.kind === kind))
    .map(({ id, title, show, season, episode, kind, duration, path: p, year, folder, mode }) => ({ id, title, show, season, episode, kind, duration, path: p, year, folder, mode })));
  h('library:enrich', async () => {
    const n = await enrichLibrary(lib, (n, total, name) => send('enrich-progress', { n, total, name }));
    findMoviePosters({ force: true }).catch((e) => log('posters', e));
    return n;
  });
  h('posters:find', () => findMoviePosters({ force: true }));

  // The On Demand folder: drop movies in, they appear on the On Demand channel.
  h('ondemand:defaultFolder', (kind) => settings[odKind(kind).setting] || defaultOnDemandFolder(kind));
  h('ondemand:pickFolder', async (start) => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a folder', defaultPath: start || settings.onDemandFolder || app.getPath('videos'), properties: ['openDirectory', 'createDirectory', 'promptToCreate'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('ondemand:useFolder', (folder, opts) => useOnDemandFolder(folder, opts));
  // Opening (or coming back to) the On Demand screen: look in its folders for added or deleted movies.
  h('ondemand:refresh', async (channelId) => {
    const ch = channels.find((c) => c.id === channelId && c.ondemand);
    if (ch?.locked) {
      if (!vaultOpen) return { added: 0, removed: 0 };
      let r = await vaultScan();
      for (let i = 0; r?.busy && i < 60; i++) { await new Promise((ok) => setTimeout(ok, 1000)); r = await vaultScan(); }
      vaultPosters().catch(() => {});
      return { added: r?.added || 0, removed: r?.removed || 0, busy: !!r?.busy };
    }
    const folders = ch ? onDemandFolders(ch).filter((f) => fs.existsSync(f)) : [];
    if (!folders.length) return { added: 0, removed: 0 };
    let r = await lib.scan(folders, { remember: true, prune: true, policy: 'auto' });
    for (let i = 0; r?.busy && i < 60; i++) { await new Promise((ok) => setTimeout(ok, 1000)); r = await lib.scan(folders, { remember: true, prune: true, policy: 'auto' }); }
    if (r?.added) findMoviePosters().catch((e) => log('posters', e));
    return { added: r?.added || 0, removed: r?.removed || 0, busy: !!r?.busy };
  });
  // The locked section
  h('vault:status', () => vaultView());
  h('vault:defaultFolder', (name) => path.join(process.env.HOMECABLE_VIDEOS || app.getPath('videos'), String(name || 'Archive').replace(/[<>:"/\\|?*]+/g, '').trim() || 'Archive'));
  h('vault:create', async ({ name, password, folder } = {}) => {
    name = String(name || '').trim().slice(0, 30) || 'Archive';
    if (String(password || '').length < 4) throw new Error('Use at least 4 characters');
    folder = path.resolve(String(folder || ''));
    fs.mkdirSync(folder, { recursive: true });
    const salt = crypto.randomBytes(16).toString('hex');
    settings.vault = { name, salt, hash: vaultHash(password, salt), folders: [folder], showButton: true };
    if (!vaultChannel()) channels.push(normalizeChannel({ name, logo: '🗂', color: '#5b6478', ondemand: true, odStyle: 'movies', locked: true, rating: 'adult', number: nextNumber(900), sources: [] }));
    else vaultChannel().rating = 'adult';
    applyVault(); saveSettings(); saveChannels();
    vaultOpen = false;
    send('channels-changed');
    // Anything already in the library from that folder disappears from everywhere else now.
    send('library-changed', libraryStats());
    log('locked section set up');
    return vaultView();
  });
  h('vault:unlock', (password) => {
    if (!profiles.isAdult()) return { ok: false };
    const r = vaultCheck(password);
    if (r.ok) vaultOpen = true;
    return r;
  });
  h('vault:lock', () => { vaultOpen = false; return true; });
  h('vault:update', async (p = {}) => {
    const v = settings.vault;
    if (!v) return vaultView();
    if (p.name != null) v.name = String(p.name).trim().slice(0, 30) || v.name;
    if (p.showButton != null) v.showButton = !!p.showButton;
    if (p.phone != null) v.phone = !!p.phone;
    if (p.addFolder) { const f = path.resolve(p.addFolder); if (!v.folders.some((x) => x.toLowerCase() === f.toLowerCase())) v.folders.push(f); }
    if (p.removeFolder && v.folders.length > 1) v.folders = v.folders.filter((x) => x.toLowerCase() !== String(p.removeFolder).toLowerCase());
    if (p.newPassword != null) {
      const c = vaultCheck(p.oldPassword || '');
      if (!c.ok) throw new Error(c.wait ? `Too many tries — wait ${c.wait} s` : 'The current password is wrong');
      if (String(p.newPassword).length < 4) throw new Error('Use at least 4 characters');
      v.salt = crypto.randomBytes(16).toString('hex'); v.hash = vaultHash(p.newPassword, v.salt);
    }
    applyVault(); saveSettings(); saveChannels();
    send('channels-changed'); send('library-changed', libraryStats());
    return vaultView();
  });
  // Removing the section never touches your files: they just stop being locked.
  h('vault:remove', (password) => {
    const v = settings.vault;
    if (!v) return vaultView();
    const c = vaultCheck(password || '');
    if (!c.ok) throw new Error(c.wait ? `Too many tries — wait ${c.wait} s` : 'Wrong password');
    const ch = vaultChannel();
    if (ch) { channels = channels.filter((c) => c !== ch); sched.remove(ch.id); }
    delete settings.vault; vaultOpen = false;
    applyVault(); saveSettings(); saveChannels();
    send('channels-changed'); send('library-changed', libraryStats());
    return vaultView();
  });
  // Mini player: the window shrinks to a small always-on-top video you can resize and
  // drag anywhere, so you can watch while you work. P (or its button) toggles it.
  h('win:mini', (on) => {
    if (!win) return false;
    if (on === 'toggle') on = !miniBack;
    if (on && !miniBack) {
      miniBack = { bounds: win.getBounds(), max: win.isMaximized(), full: win.isFullScreen() };
      if (miniBack.full) win.setFullScreen(false);
      if (miniBack.max) win.unmaximize();
      win.setMinimumSize(300, 170);
      const wa = screen.getPrimaryDisplay().workArea;
      win.setBounds({ x: wa.x + wa.width - 540, y: wa.y + wa.height - 320, width: 520, height: 300 });
      win.setAlwaysOnTop(true, 'floating');
    } else if (!on && miniBack) {
      win.setAlwaysOnTop(false);
      win.setMinimumSize(860, 440);
      win.setBounds(miniBack.bounds);
      if (miniBack.max) win.maximize();
      if (miniBack.full) win.setFullScreen(true);
      miniBack = null;
    }
    send('mini', !!miniBack);
    return !!miniBack;
  });
  h('ondemand:openFolder', (kind) => { const f = settings[odKind(kind).setting]; return f && shell.openPath(f); });

  // On-demand channels: the movies to pick from (posters, resume points).
  h('ondemand:list', (channelId) => {
    const ch = visible().find((c) => c.id === channelId && c.ondemand);
    if (!ch) return null;
    if (ch.locked && !vaultOpen) return { channel: { id: ch.id, name: ch.name, number: ch.number, color: ch.color, logo: ch.logo, ondemand: true, locked: true, odStyle: 'movies' }, locked: true, style: 'movies', items: [], showLast: {}, folders: [] };
    return onDemandList(ch, vaultOpen);
  });
  // The locked section on a paired phone (the phone checked its own password and unlock).
  h('vault:phoneInfo', () => (settings.vault && settings.vault.phone !== false && vaultChannel() ? { name: settings.vault.name } : null));
  h('vault:check', (password) => vaultCheck(password));
  h('vault:phoneList', () => { const ch = vaultChannel(); return ch ? onDemandList(ch, true) : null; });
  h('vault:phoneRefresh', async () => {
    // Like the PC's refresh: wait out a scan that's already running instead of giving up.
    let r = await vaultScan();
    for (let i = 0; r?.busy && i < 30; i++) { await new Promise((ok) => setTimeout(ok, 1000)); r = await vaultScan(); }
    vaultPosters().catch(() => {});
    return { added: r?.added || 0, removed: r?.removed || 0 };
  });
  // Videos dragged into another show land inside it (and leave wherever they were shown before).
  function applyMoves(series, items) {
    const here = new Set(items.map((i) => i.id));
    for (const sr of series) for (const se of sr.seasons) se.ids = se.ids.filter((id) => { const o = lib.items[id]?.showKeyUser; return !o || o === sr.key; });
    for (const sr of series) {
      for (const it of Object.values(lib.items)) {
        if (it.showKeyUser !== sr.key || !here.has(it.id)) continue;
        if (sr.seasons.some((se) => se.ids.includes(it.id))) continue;
        const own = it.season != null && sr.seasons.find((se) => se.label === `Season ${it.season}`);
        if (own) { own.ids.push(it.id); own.ids.sort((a, b) => (lib.items[a]?.episode ?? 999) - (lib.items[b]?.episode ?? 999)); }
        else { let xe = sr.seasons.find((se) => se.label === 'OVAs & extras'); if (!xe) { xe = { label: 'OVAs & extras', ids: [] }; sr.seasons.push(xe); } xe.ids.push(it.id); }
      }
      sr.seasons = sr.seasons.filter((se) => se.ids.length);
    }
    for (let i = series.length - 1; i >= 0; i--) if (!series[i].seasons.length) series.splice(i, 1);
    // Shows made by hand ("this is part of a show"): they get their own row here.
    const extra = new Map();
    for (const it of Object.values(lib.items)) {
      if (!it.showKeyUser || !here.has(it.id) || series.some((sr) => sr.key === it.showKeyUser)) continue;
      if (!extra.has(it.showKeyUser)) extra.set(it.showKeyUser, { key: it.showKeyUser, name: it.showUser || it.show || 'Show', dir: null, seasons: [] });
      const sr = extra.get(it.showKeyUser);
      const s = it.seasonUser ?? it.season;
      const label = s != null ? `Season ${s}` : 'Episodes';
      let se = sr.seasons.find((x) => x.label === label);
      if (!se) { se = { label, ids: [] }; sr.seasons.push(se); }
      se.ids.push(it.id);
    }
    for (const sr of extra.values()) {
      sr.seasons.sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true }));
      for (const se of sr.seasons) se.ids.sort((a, b) => ((lib.items[a]?.episodeUser ?? lib.items[a]?.episode ?? 999) - (lib.items[b]?.episodeUser ?? lib.items[b]?.episode ?? 999)) || String(lib.items[a]?.title || '').localeCompare(String(lib.items[b]?.title || ''), undefined, { numeric: true }));
      series.push(sr);
    }
  }
  // The real airing order (from the online lookup): OVAs between seasons play where they aired.
  function orderFor(key, seasons) {
    const o = lib.meta[key]?.order;
    if (!o) return null;
    const ord = {};
    let sp = 0;
    for (const se of seasons) {
      const m = /^Season (\d+)$/i.exec(se.label);
      const special = !m && /ova|special|extra|movie|film/i.test(se.label);
      se.ids.forEach((id, i) => {
        const it = lib.items[id];
        if (!it) return;
        const s = m ? +m[1] : it.season;
        let v = !special && s != null ? o.bySE[`${s}x${it.episode ?? i + 1}`] : undefined;
        if (v === undefined && (special || s == null)) v = o.specials[sp++];
        if (v !== undefined) ord[id] = v;
      });
    }
    return Object.keys(ord).length ? ord : null;
  }
  function onDemandList(ch, open) {
    const resume = settings.vodResume || {};
    const seen = settings.vodWatched || {};
    const items = onDemandItems(ch, open);
    return { channel: ch, style: ch.odStyle || 'movies', showLast: settings.showLast || {}, folders: ch.sources.filter((x) => x.type === 'folder').map((x) => x.path),
      ...(ch.odStyle === 'series' || ch.locked ? (() => {
        let { series } = seriesFor(ch, items);
        series = series.map((x) => ({ ...x, seasons: x.seasons.map((se) => ({ ...se, ids: [...se.ids] })) }));
        applyMoves(series, items);
        return { series: series.map((x) => ({ key: x.key, name: lib.meta[x.key]?.nameOverride || x.name, renamed: !!lib.meta[x.key]?.nameOverride, poster: seriesPoster(x), seasons: x.seasons, genres: lib.meta[x.key]?.genres || [], ord: orderFor(x.key, x.seasons) })) };
      })() : {}),
      items: items.map((it) => ({ ...itemSummary(it), resume: resume[it.id] || 0, watched: !!seen[it.id], epTitle: cleanName(path.basename(it.path || it.title, path.extname(it.path || ''))) || it.title,
        poster: it.showKey ? null : posterUrl(it) || it.art || null,
        showPoster: (it.showKeyUser || it.showKey) ? showArtUrl(it.showKeyUser || it.showKey) : null,
        showGenres: (it.showKeyUser || it.showKey) ? lib.meta[it.showKeyUser || it.showKey]?.genres || null : null,
        showRenamed: (it.showKeyUser || it.showKey) ? !!lib.meta[it.showKeyUser || it.showKey]?.nameOverride : false,
        thumb: it.kind === 'episode' || it.showKey ? media.thumbUrl(it.id) : null })) };
  }
  h('items:hide', (ids, on) => {
    let n = 0;
    for (const id of Array.isArray(ids) ? ids : [ids]) {
      const it = lib.items[id];
      if (!it) continue;
      if (on) it.hiddenUser = true; else delete it.hiddenUser;
      n++;
    }
    lib.save();
    // Hidden things leave the air too: re-plan what hasn't aired yet.
    for (const ch of channels) if (!ch.iptv && !ch.ondemand) sched.rebuild(ch);
    send('library-changed', libraryStats());
    send('schedule-changed');
    return { ok: true, count: n, hidden: !!on };
  });
  h('library:reveal', (p) => shell.showItemInFolder(p));
  h('library:approve', (ids) => lib.approve(ids));
  h('library:pending', () => lib.list().filter((i) => i.status === 'pending').map(itemSummary));
  h('library:browse', () => ({ items: allowedItems().map(itemSummary), hidden: profiles.isAdult() ? lib.hiddenList().map(itemSummary) : [], shows: lib.shows().map(({ key, name, count, seasons, avg, meta }) => ({ key, name: meta?.nameOverride || name, renamed: !!meta?.nameOverride, count, seasons, avg, poster: meta?.poster || null, genres: meta?.genres || [] })), media: { thumb: media.thumbUrl('ID') } }));
  h('library:episodes', (key) => lib.episodesOf(key).map(itemSummary));
  h('library:scanAll', () => scanEverything());

  // ---- Changing a movie's or a show's picture by hand (hold a poster on the wall) ----
  const uaHeaders = { 'User-Agent': 'HomeCable/1.0 (home media player)', Accept: 'application/json' };
  // Names from folders carry release junk ("S01-S06", "1080p", "x265") — lookups search without it.
  const lookupName = (s) => String(s || '').replace(/[\[(].*?[\])]/g, ' ')
    .replace(/\b(s\d{1,2}(?:-s?\d{1,2})?|seasons? \d+(?:-\d+)?|complete|collection|pack|batch|\d{3,4}p|[48]k|x26[45]|h26[45]|hevc|avc|aac|ac3|bluray|brrip|webrip|web[- ]?dl|dvdrip|hdtv|remux|remaster(?:ed)?|uncut|extended|dual[- ]?audio|multi[- ]?subs?|subbed|dubbed|dub|eng|jpn)\b/gi, ' ')
    .replace(/[._]+/g, ' ').replace(/\s{2,}/g, ' ').replace(/[\s\-–—]+$/, '').trim();
  h('art:candidates', async (q) => {
    // q: { kind: 'movie' | 'show', name, year } — only the name (and year) is sent.
    const out = [];
    const seen = new Set();
    q = { ...q, name: lookupName(q.name) || String(q.name || '') };
    if (q.kind === 'show') {
      const r = await fetch('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(q.name), { signal: AbortSignal.timeout(10000), headers: uaHeaders });
      if (r.ok) for (const x of await r.json()) {
        const img = x.show?.image?.original || x.show?.image?.medium;
        if (img && !seen.has(img)) { seen.add(img); out.push({ url: img, name: x.show.name, label: [x.show.name, (x.show.premiered || '').slice(0, 4)].filter(Boolean).join(' · ') }); }
      }
    } else {
      const tryPage = async (p) => {
        try {
          const j = await (await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(p.replace(/ /g, '_')), { signal: AbortSignal.timeout(10000), headers: uaHeaders })).json();
          const img = j.originalimage?.source || j.thumbnail?.source;
          const url = img && (j.thumbnail?.source || img).replace(/\/\d+px-/, '/500px-');
          if (j.type === 'standard' && url && !seen.has(url)) { seen.add(url); out.push({ url, name: j.title.replace(/\s*\((\d{4} )?film\)\s*$/i, ''), label: [j.title, j.description].filter(Boolean).join(' — ') }); }
        } catch {}
      };
      if (q.year) await tryPage(`${q.name} (${q.year} film)`);
      await tryPage(`${q.name} (film)`);
      await tryPage(q.name);
      try {
        // The REST search endpoint (api.php turns Electron's requests away).
        const s = await (await fetch('https://en.wikipedia.org/w/rest.php/v1/search/page?' + new URLSearchParams({ q: `${q.name} ${q.year || ''} film`.trim(), limit: '8' }), { signal: AbortSignal.timeout(10000), headers: uaHeaders })).json();
        for (const r2 of s.pages || []) await tryPage(r2.title);
      } catch {}
      // Stubborn movies: a second, plainer search pass (no 'film' bias), so big
      // titles whose article isn't worded that way still turn up.
      if (out.length < 4) {
        try {
          const s2 = await (await fetch('https://en.wikipedia.org/w/rest.php/v1/search/page?' + new URLSearchParams({ q: q.name, limit: '8' }), { signal: AbortSignal.timeout(10000), headers: uaHeaders })).json();
          for (const r3 of s2.pages || []) await tryPage(r3.title);
        } catch {}
        if (/^the /i.test(q.name)) await tryPage(q.name.replace(/^the /i, ''));
      }
    }
    return out.slice(0, 18);
  });
  // "Update show & movie info": look everything on this wall up by name — genres,
  // posters, anime and all. Runs by itself for auto libraries (new finds get info as
  // they're scanned); this button is the one-click version for manual ones.
  h('meta:refresh', async (channelId) => {
    const ch = channels.find((c) => c.id === channelId && c.ondemand);
    if (!ch) return null;
    const items = onDemandItems(ch, true);
    let shows = 0, movies = 0;
    // Shows, by name (new ones, and ones saved before language / anime / genres were kept).
    // Folder-built walls (Stream Demand) group by the folder's key — look those up too.
    const sNames = new Map();
    if (ch.odStyle === 'series' || ch.locked) for (const s of seriesFor(ch, items).series) sNames.set(s.key, lib.meta[s.key]?.nameOverride || s.name);
    for (const i of items) if (i.showKey && !sNames.has(i.showKey)) sNames.set(i.showKey, lib.meta[i.showKey]?.nameOverride || lib.shows().find((x) => x.key === i.showKey)?.name || i.show);
    for (const [key, name] of sNames) {
      const m = lib.meta[key];
      if (m && !m.notFound && 'id' in m) continue;
      if (!name) continue;
      try {
        const r = await lookupShow(lookupName(name) || name);
        const merged = { ...(m || {}), ...r };
        if (m?.genresUser) { merged.genres = m.genres; merged.genresUser = true; } // tags set by hand win
        if (!r.notFound) { delete merged.notFound; shows++; }
        // The show's episodes in airing order (specials and OVAs land between the seasons they aired in).
        if (r.id) {
          try {
            const eps = await (await fetch(`https://api.tvmaze.com/shows/${r.id}/episodes?specials=1`, { signal: AbortSignal.timeout(10000), headers: uaHeaders })).json();
            const inOrder = eps.filter((e) => e.airstamp || e.airdate).sort((a, b) => new Date(a.airstamp || a.airdate) - new Date(b.airstamp || b.airdate));
            const bySE = {}, specials = [];
            inOrder.forEach((e, i) => { if (e.number != null && (!e.type || e.type === 'regular')) bySE[`${e.season}x${e.number}`] = i; else specials.push(i); });
            if (Object.keys(bySE).length) merged.order = { bySE, specials };
          } catch {}
        }
        lib.meta[key] = merged;
      } catch (e) { if (/fetch failed|timeout|abort/i.test(String(e))) break; }
      await new Promise((ok) => setTimeout(ok, 550)); // stay under TVmaze's 20 req / 10 s
    }
    // Movies: a poster when there isn't one, and genres from how Wikipedia describes the film.
    for (const it of items.filter((i) => !i.showKey && i.kind === 'movie')) {
      const needG = !(it.genres || []).length && (!it.genresTried || Date.now() - it.genresTried > RETRY_TAGS_MS);
      let got = false;
      try {
        if (artwork.needsPoster(it, true)) got = await artwork.findPoster(it, { dir: posterDir(), online: true, siblings: 2, log });
        if (needG && !(it.genres || []).length) {
          const hit = await artwork.wikipediaPoster(it.title, it.year).catch(() => null);
          if (hit?.genres?.length) { it.genres = hit.genres; got = true; }
          it.genresTried = Date.now();
        }
      } catch (e) { if (e.offline) break; }
      if (got) movies++;
      await new Promise((ok) => setTimeout(ok, 250));
    }
    lib.save();
    send('library-changed', libraryStats());
    return { shows, movies };
  });
  // Renaming a show or a movie (hold its poster → Edit): only how it's shown changes, never your files.
  h('name:set', (target, name) => {
    name = String(name || '').trim().slice(0, 120);
    if (!name) { // back to the original name
      if (target.itemId) { const it = lib.items[target.itemId]; if (it) delete it.titleUser; }
      else if (lib.meta[target.showKey]) delete lib.meta[target.showKey].nameOverride;
      lib.save();
      send('library-changed', libraryStats());
      return { ok: true, name: null };
    }
    if (target.itemId) {
      const it = lib.items[target.itemId];
      if (!it) throw new Error('That video isn’t in the library any more');
      it.titleUser = name;
    } else {
      lib.meta[target.showKey] = { ...(lib.meta[target.showKey] || {}), nameOverride: name };
    }
    lib.save();
    send('library-changed', libraryStats());
    return { ok: true, name };
  });
  // Drag a video (or a whole mis-grouped show) onto a show: it belongs there now.
  h('show:move', (ids, showKey) => {
    for (const id of Array.isArray(ids) ? ids : []) {
      const it = lib.items[id];
      if (!it) continue;
      if (showKey) it.showKeyUser = String(showKey);
      else { delete it.showKeyUser; delete it.showUser; delete it.kindUser; delete it.seasonUser; delete it.episodeUser; }
    }
    lib.save();
    send('library-changed', libraryStats());
    return { ok: true };
  });
  // Tags turned on/off by hand — kept even when info is looked up again.
  h('tags:set', (target, genres) => {
    const list = [...new Set((Array.isArray(genres) ? genres : []).map((g) => String(g).trim()).filter(Boolean))].slice(0, 20);
    if (target.itemId) {
      const it = lib.items[target.itemId];
      if (!it) throw new Error('That video isn’t in the library any more');
      it.genres = list;
      it.genresUser = true;
    } else {
      lib.meta[target.showKey] = { ...(lib.meta[target.showKey] || {}), genres: list, genresUser: true };
    }
    lib.save();
    send('library-changed', libraryStats());
    return { ok: true, genres: list };
  });
  // "This is part of a show": loose videos become that show's episodes (files untouched).
  h('show:make', (ids, name) => {
    name = String(name || '').trim().slice(0, 120);
    if (!name) throw new Error('Give the show a name first');
    const key = 'u:' + name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    let n = 0;
    for (const id of Array.isArray(ids) ? ids : []) {
      const it = lib.items[id];
      if (!it) continue;
      it.kindUser = 'episode';
      it.showKeyUser = key;
      it.showUser = name;
      if (it.season == null || it.episode == null) {
        try {
          const p = parsePath(it.path || it.title || '');
          if (it.season == null && p.season != null) it.seasonUser = p.season;
          if (it.episode == null && p.episode != null) it.episodeUser = p.episode;
        } catch {}
      }
      n++;
    }
    if (!lib.meta[key]?.nameOverride) lib.meta[key] = { ...(lib.meta[key] || {}), nameOverride: name };
    lib.save();
    send('library-changed', libraryStats());
    return { ok: true, key, name, count: n };
  });
  // One click for the whole library: every On Demand screen's shows and movies, old entries included.
  h('meta:refreshAll', async () => {
    let shows = 0, movies = 0;
    for (const ch of channels.filter((c) => c.ondemand)) {
      const r = await handlerFns['meta:refresh'](ch.id).catch(() => null);
      if (r) { shows += r.shows; movies += r.movies; }
    }
    return { shows, movies };
  });
  h('art:pickFile', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Pick a picture', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('art:set', async (target, source) => {
    // target: { itemId } (a movie) or { showKey, name } (a show); source: { url } (https) or { file } (a picture on this PC).
    fs.mkdirSync(posterDir(), { recursive: true });
    const out = target.itemId ? path.join(posterDir(), target.itemId + '.jpg') : path.join(posterDir(), seriesArtId(target.showKey) + '.jpg');
    let ok = false;
    if (source.url && /^https:\/\//.test(source.url)) {
      const raw = out + '.dl';
      const r = await fetch(source.url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': uaHeaders['User-Agent'] } });
      if (r.ok) { fs.writeFileSync(raw, Buffer.from(await r.arrayBuffer())); ok = await artwork.toJpeg(raw, out); try { fs.unlinkSync(raw); } catch {} }
    } else if (source.file) {
      ok = await artwork.toJpeg(source.file, out);
    }
    if (!ok) throw new Error('That picture couldn’t be used — try another one');
    if (target.itemId) {
      const it = lib.items[target.itemId];
      if (!it) throw new Error('That video isn’t in the library any more');
      Object.assign(it, { poster: out, posterFrom: 'user', posterUserSet: true, posterAt: Date.now() });
    } else {
      lib.meta[target.showKey] = { ...(lib.meta[target.showKey] || {}), name: target.name || lib.meta[target.showKey]?.name, posterFile: out, posterUserSet: true, at: Date.now() };
    }
    lib.save();
    send('library-changed', libraryStats());
    return { ok: true, poster: target.itemId ? posterUrl(lib.items[target.itemId]) : showArtUrl(target.showKey) };
  });

  // Network
  // HOMECABLE_DEMO (product-page recordings): a neutral PC name and none of the
  // real network's devices, drives or shares on screen.
  h('network:discover', () => (process.env.HOMECABLE_DEMO ? { thisPc: { name: 'Living Room PC', drives: [] }, dlna: [], pcs: [] } : network.discoverAll()));
  h('network:shares', (host) => network.listShares(host));
  h('sources:add', async (srcs) => {
    // srcs: [{ type:'folder', path }] or [{ type:'dlna', server }]
    const folders = srcs.filter((s) => s.type === 'folder').map((s) => s.path);
    const res = { added: 0 };
    if (folders.length) {
      // A scan may already be running (the regular rescan) — wait it out instead
      // of silently adding nothing.
      let r = await lib.scan(folders, { prune: false, policy: settings.setupDone ? settings.newMedia : 'auto' });
      for (let i = 0; r?.busy && i < 120; i++) { await new Promise((ok) => setTimeout(ok, 1000)); r = await lib.scan(folders, { prune: false, policy: settings.setupDone ? settings.newMedia : 'auto' }); }
      res.added += r.added || 0;
    }
    for (const s of srcs.filter((x) => x.type === 'dlna')) { const r = await lib.scanServer(s.server, { policy: settings.setupDone ? settings.newMedia : 'auto' }); res.added += r.added || 0; }
    res.total = lib.list().length;
    return res;
  });
  h('sources:removeServer', (id) => { lib.removeServer(id); return libraryStats(); });

  // On demand (play anything from the library, full seeking)
  h('vod:play', (itemId, t = 0, opts = {}) => {
    const raw = lib.items[itemId];
    const locked = raw && lib.isPrivate(raw.path);
    if (locked && !(vaultOpen && profiles.isAdult()) && !opts.vaultOk) return null;
    const it = locked ? raw : allowedItems().find((i) => i.id === itemId);
    if (!it) return null;
    if (locked) return { item: itemSummary(it), next: null, play: playFor(it, t), now: Date.now() };
    const next = it.showKey ? lib.episodesOf(it.showKey).find((e, i, a) => a[i - 1]?.id === it.id) : null;
    // Anime gets the guessed 90-second "Skip intro" (that timing is an anime OP thing).
    const anime = [...(lib.meta[it.showKeyUser || it.showKey]?.genres || []), ...(it.genres || [])].includes('Anime');
    return { item: itemSummary(it), next: next ? itemSummary(next) : null, anime, play: playFor(it, t, opts), now: Date.now() };
  });

  // IPTV
  h('iptv:fetch', async (opts) => iptv.fetchPlaylist(opts.url || iptv.presetUrl(opts)));
  h('iptv:countries', async () => {
    try { const r = await fetch('https://iptv-org.github.io/api/countries.json', { signal: AbortSignal.timeout(15000) }); return (await r.json()).map((c) => ({ code: c.code, name: c.name, flag: c.flag })).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { return []; }
  });
  h('iptv:categories', () => iptv.CATEGORIES);
  h('iptv:regions', async () => {
    try { const r = await fetch('https://iptv-org.github.io/api/regions.json', { signal: AbortSignal.timeout(15000) }); return (await r.json()).map((x) => ({ code: String(x.code).toLowerCase(), name: x.name })).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { return []; }
  });
  h('iptv:check', (list) => iptv.checkMany(list, { onProgress: (n, total, name) => send('iptv-progress', { n, total, name }) }));
  // Free TV from the internet
  h('free:collections', () => free.COLLECTIONS);
  h('free:add', async (colls, rows = 60) => {
    for (const coll of colls) {
      const { serverId, def, added } = await free.importCollection(lib, coll, { rows, onProgress: (n, total, name) => send('free-progress', { coll, n, total, name }) });
      log('archive', coll, 'added', added);
      if (!channels.some((c) => c.sources.some((s) => s.type === 'server' && s.id === serverId))) {
        const ch = normalizeChannel({ name: def.name, logo: def.logo, order: 'shuffle', align: 30, sources: [{ type: 'server', id: serverId, label: def.name + ' (Internet Archive)' }] });
        channels.push(ch);
        sched.ensure([ch]);
      }
    }
    saveChannels();
    send('channels-changed');
    send('free-progress', { done: true });
    return sortedChannels();
  });
  // ---- The Free TV manager (Edit → Free TV stations) ----
  h('iptv:list', () => channels.filter((c) => c.iptv).sort((a, b) => a.number - b.number)
    .map((c) => ({ id: c.id, number: c.number, name: c.name, group: c.iptv.genre || c.iptv.group || '', country: c.iptv.country || '', logo: c.iptv.logo || '', hidden: !!c.hidden, dead: !!c.iptv.dead })));
  h('iptv:genres', () => {
    const have = [...new Set(channels.filter((c) => c.iptv).map((c) => c.iptv.genre || stationGenre(c.name, c.iptv.group)))].sort();
    return { have, all: iptv.CATEGORIES };
  });
  // Search the iptv-org index by name / genre / country. Lists are cached for the
  // session; `urls` (tests) searches those playlists instead of going online.
  h('iptv:search', async ({ q = '', category = '', country = '', urls = null } = {}) => {
    const kind = urls ? 'urls:' + urls.join(',') : country ? 'country:' + String(country).toLowerCase() : category ? 'category:' + String(category).toLowerCase() : 'index';
    if (!iptvCatalog.has(kind)) {
      const list = urls ? (await Promise.all(urls.map((u) => iptv.fetchPlaylist(u).catch(() => [])))).flat()
        : await iptv.fetchPlaylist(kind === 'index' ? `${iptv.IPTV_ORG}/index.m3u` : kind.startsWith('country:') ? iptv.presetUrl({ country: kind.slice(8) }) : iptv.presetUrl({ category: kind.slice(9) }));
      iptvCatalog.set(kind, list);
      if (iptvCatalog.size > 12) iptvCatalog.delete(iptvCatalog.keys().next().value);
    }
    const base = iptvCatalog.get(kind);
    const have = new Set(channels.filter((c) => c.iptv).map((c) => c.iptv.url));
    const qq = q.trim().toLowerCase(), cat = String(category).toLowerCase();
    const results = [], seen = new Set();
    for (const st of base) {
      if (st.flags?.geo || have.has(st.url) || seen.has(st.url)) continue;
      if (qq && !st.name.toLowerCase().includes(qq)) continue;
      if (cat && !String(st.group || '').toLowerCase().includes(cat)) continue;
      seen.add(st.url);
      results.push({ name: st.name, url: st.url, group: st.group || '', country: st.country || '', logo: st.logo || '', tvgId: st.tvgId, userAgent: st.userAgent, referer: st.referer });
      if (results.length >= 120) break;
    }
    return { results, searched: base.length };
  });
  // Add one station by hand: it's tested first, exactly like the bulk add.
  h('iptv:addOne', async (st) => {
    if (!st?.url || !/^https?:\/\//i.test(st.url)) return { ok: false, why: 'bad url' };
    if (channels.some((c) => c.iptv?.url === st.url)) return { ok: false, why: 'already in your lineup' };
    const check = await iptv.checkStream(st, 12000);
    if (!check.ok) return { ok: false, why: 'not answering right now' };
    const ch = normalizeChannel({
      number: nextNumber(settings.liveStart || 100), name: String(st.name || 'Station').slice(0, 60), color: PALETTE[channels.length % PALETTE.length],
      iptv: { url: st.url, logo: st.logo, group: st.group, genre: stationGenre(st.name, st.group), tvgId: st.tvgId, country: st.country, userAgent: st.userAgent, referer: st.referer, audioOnly: !check.video, mode: check.video && check.video !== 'h264' ? 'transcode' : 'copy' },
    });
    channels.push(ch);
    renumberIptv();
    saveChannels();
    send('channels-changed'); send('schedule-changed');
    refreshGuides().catch(() => {});
    return { ok: true, id: ch.id, number: ch.number, name: ch.name };
  });
  // Heart a channel (guide right-click) — the guide's ♥ filter shows only these.
  h('channels:fav', (id, on = true) => {
    const ch = channels.find((c) => c.id === id);
    if (ch) { ch.fav = !!on; if (!on) delete ch.fav; saveChannels(); send('channels-changed'); }
    return sortedChannels();
  });
  // Uncheck a channel from being seen (or bring it back) and fix the numbers.
  h('channels:hide', (id, on = true) => {
    const ch = channels.find((c) => c.id === id);
    if (!ch) return sortedChannels();
    ch.hidden = !!on;
    if (!on) delete ch.hidden;
    if (on && settings.lockChannel === id) { settings.lockChannel = null; saveSettings(); }
    if (ch.iptv) renumberIptv();
    saveChannels();
    send('channels-changed'); send('schedule-changed');
    return sortedChannels();
  });
  h('iptv:auto', (opts) => {
    // Remember what the lineup should be stocked with, for the daily refresh.
    settings.live = { country: opts.country || (opts.countries || [])[0] || 'us', countries: opts.countries || [opts.country || 'us'], regions: opts.regions || [], categories: opts.categories || [], languages: opts.languages || [], max: opts.max ?? 0, sources: opts.sources || ['iptv-org', 'free-tv'], urls: opts.urls || [], anime: !!opts.anime };
    saveSettings();
    iptvAutoAdd(settings.live).then(() => refreshGuides()).catch((e) => log('iptv auto', e.stack));
    return { started: true };
  });
  h('iptv:sources', () => iptv.SOURCES);
  h('iptv:languages', async () => {
    try { const r = await fetch('https://iptv-org.github.io/api/languages.json', { signal: AbortSignal.timeout(15000) }); return (await r.json()).map((l) => ({ code: l.code, name: l.name })); }
    catch { return []; }
  });
  // "Try again" on a hidden station.
  h('iptv:recheck', async (id) => {
    const ch = channels.find((c) => c.id === id && c.iptv);
    if (!ch) return null;
    const r = await iptv.checkStream(ch.iptv, 12000);
    if (r.ok) { delete ch.iptv.dead; ch.iptv.misses = 0; ch.iptv.mode = r.video && r.video !== 'h264' ? 'transcode' : 'copy'; } else ch.iptv.dead = Date.now();
    saveChannels();
    send('channels-changed');
    return r.ok;
  });
  h('guides:refresh', () => refreshGuides());
  h('live:stations', () => channels.filter((c) => c.iptv && !c.iptv.dead).map((c) => ({ id: c.id, number: c.number, name: c.name, logo: c.iptv.logo, group: c.iptv.group, dead: !!c.iptv.dead, now: liveEntry(c, Date.now()).program || null })));
  // "Mix into a channel": put a live programme (or a whole time slot) into one of your channels.
  h('live:mix', ({ channelId, stationId, start, end, repeat, name }) => {
    const ch = channels.find((c) => c.id === channelId && !c.iptv);
    const st = channels.find((c) => c.id === stationId && c.iptv);
    if (!ch || !st) return null;
    const s = new Date(start), e = new Date(end);
    const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const ymd = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
    const days = repeat === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : repeat === 'weekdays' ? [1, 2, 3, 4, 5] : [s.getDay()];
    ch.blocks.push({ id: crypto.randomUUID().slice(0, 8), name: name || st.name, start: hm(s), end: hm(e), order: 'sequential', ...(repeat === 'once' ? { date: ymd, days: [] } : { days }), sources: [{ type: 'live', channelId: st.id, label: st.name }] });
    saveChannels();
    sched.rebuild(ch);
    send('schedule-changed');
    return sortedChannels();
  });
  // Re-test every live station; mark the ones that are off the air.
  h('iptv:checkAll', async () => {
    const live = channels.filter((c) => c.iptv);
    let i = 0, up = 0, down = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (i < live.length) {
        const ch = live[i++];
        const r = await iptv.checkStream(ch.iptv, 12000);
        if (r.ok) { up++; delete ch.iptv.dead; ch.iptv.misses = 0; ch.iptv.mode = r.video && r.video !== 'h264' ? 'transcode' : 'copy'; ch.iptv.audioOnly = !r.video; }
        else { down++; ch.iptv.dead = Date.now(); }
        send('iptv-progress', { checked: up + down, total: live.length, running: true, name: ch.name, recheck: true });
      }
    }));
    saveChannels();
    send('channels-changed');
    send('iptv-progress', { checked: up + down, total: live.length, running: false, recheck: true });
    return { up, down };
  });
  h('live:renumber', (start) => {
    // Move every live station into a block starting at `start`, keeping their order.
    settings.liveStart = Math.max(1, +start || 100);
    saveSettings();
    const live = channels.filter((c) => c.iptv).sort((a, b) => a.number - b.number);
    const mine = new Set(channels.filter((c) => !c.iptv).map((c) => c.number));
    let n = settings.liveStart;
    for (const c of live) { while (mine.has(n)) n++; c.number = n++; }
    saveChannels();
    send('channels-changed');
    return sortedChannels();
  });
  h('channels:setNumber', (id, number) => {
    const ch = channels.find((c) => c.id === id);
    number = Math.max(1, Math.floor(+number) || 0);
    if (!ch || !number) return sortedChannels();
    const clash = channels.find((c) => c.id !== id && c.number === number);
    if (clash) clash.number = ch.number; // swap, like re-ordering presets on a TV
    ch.number = number;
    saveChannels();
    send('channels-changed');
    return sortedChannels();
  });
  // Auto-removing stations that stay dead: the user's choice, OFF by default.
  h('iptv:autoRemove', (on) => {
    if (settings.live) { settings.live.autoRemove = !!on; saveSettings(); }
    return { autoRemove: !!settings.live?.autoRemove };
  });
  h('iptv:removeDead', () => {
    const dead = channels.filter((c) => c.iptv?.dead).map((c) => c.id);
    channels = channels.filter((c) => !dead.includes(c.id));
    if (dead.includes(settings.lockChannel)) { settings.lockChannel = null; saveSettings(); }
    saveChannels();
    send('channels-changed');
    return { removed: dead.length, channels: sortedChannels() };
  });
  h('iptv:add', (stations) => {
    for (const st of stations) {
      const audioOnly = st.check && !st.check.video;
      channels.push(normalizeChannel({
        number: nextNumber(settings.liveStart || 100), name: st.name.slice(0, 60), logo: '', color: PALETTE[channels.length % PALETTE.length],
        iptv: { url: st.url, logo: st.logo, group: st.group, userAgent: st.userAgent, referer: st.referer, audioOnly, mode: st.check?.video && st.check.video !== 'h264' ? 'transcode' : 'copy' },
      }));
    }
    saveChannels();
    send('channels-changed');
    return sortedChannels();
  });

  // Channels
  h('suggest', () => suggestChannels(lib, channels));
  // First-run setup, "Here's what we found": every movie and show of yours, plus
  // HomeCable's best guess for where each goes (the suggested channels' contents).
  // Subtitles for whatever's playing: the tracks, what Auto picks, and how to get them.
  h('subs:list', async (itemId) => {
    const it = lib.items[itemId];
    if (!it) return null;
    const info = await subsInfo(it);
    // Your last choice for this show wins over Auto ("off" included).
    const key = it.showKey || it.folder;
    const pref = (settings.subChoice || {})[key];
    let pick = info.pick;
    if (pref === 'off') pick = null;
    else if (pref) pick = info.tracks.find((t) => t.lang === pref)?.id || pick;
    // Audio: your choice for this show, else "prefer dub" when there's one in your language, else the file's default.
    const audio = info.audio || [];
    const aPref = (settings.audioChoice || {})[key];
    const def = audio[0]; // what plays without picking (the stream's first track)
    let audioPick = def ? def.n : 0;
    const byLang = (l) => audio.find((a) => a.lang === l);
    if (aPref && aPref !== 'orig' && byLang(aPref)) audioPick = byLang(aPref).n;
    else if (!aPref && settings.audioPref === 'dub' && byLang(settings.subLang || 'eng')) audioPick = byLang(settings.subLang || 'eng').n;
    // Listening in your own language: subtitles only if you chose them for this show.
    const heard = audio.find((a) => a.n === audioPick)?.lang;
    if (heard && heard === (settings.subLang || 'eng') && !pref && info.audioLang !== heard) pick = info.tracks.find((t) => t.lang === heard && /sign|song|forced/i.test(t.label))?.id || null;
    if (settings.subMode === 'off') pick = null;
    return { tracks: info.tracks, pick, audioLang: info.audioLang, showKey: key, intro: info.intro || null, outro: info.outro || null,
      audio: audio.length > 1 ? audio.map((a) => ({ n: a.n, lang: a.lang, label: a.label })) : [], audioPick, audioDefault: def ? def.n : 0 };
  });
  h('subs:url', (itemId, trackId, t) => media.subsUrl(itemId, trackId, t));
  h('subs:burnUrl', (itemId, trackId, t) => media.burnUrl(itemId, +String(trackId).slice(1), t));
  // A stream with another audio track and/or picture subtitles burned in, starting at t.
  h('vod:altUrl', (itemId, o = {}) => {
    const it = lib.items[itemId];
    if (!it) return null;
    const burn = o.burn != null ? +String(o.burn).replace(/^e/, '') : null;
    const remux = o.phone ? cast.castMode(it) !== 'transcode' : it.mode !== 'transcode' && it.mode !== 'audio';
    return media.altUrl(itemId, { burn, audio: +o.audio || 0, t: +o.t || 0, remux });
  });
  // Live captions (speech → text on this PC)
  h('captions:available', () => captions.available());
  h('captions:chunk', (buf, prompt) => captions.transcribe(new Uint8Array(buf), { translate: (settings.subLang || 'eng') === 'eng', prompt }));
  // Where you are in a movie / episode, and where a show is up to.
  h('progress:save', ({ id, pos = 0, len = 0, showKey = null, finished = false, started = false } = {}) => {
    if (!id) return null;
    const resume = { ...(settings.vodResume || {}) };
    const seen = { ...(settings.vodWatched || {}) };
    const credits = Math.min(300, len * 0.1);
    const watched = !!finished || (len > 0 && pos >= len - credits);
    if (!started) {
      if (pos > 10 && !watched) resume[id] = Math.round(pos); else delete resume[id];
      if (watched) seen[id] = seen[id] || Date.now();
      const keys = Object.keys(resume);
      if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete resume[k];
      const ks = Object.keys(seen);
      if (ks.length > 2000) for (const k of ks.slice(0, ks.length - 2000)) delete seen[k];
    }
    settings.vodResume = resume; settings.vodWatched = seen;
    if (showKey) settings.showLast = { ...(settings.showLast || {}), [showKey]: { id, done: started ? false : watched } };
    saveSettings();
    send('progress-changed', { vodResume: settings.vodResume, vodWatched: settings.vodWatched, showLast: settings.showLast });
    return { vodResume: settings.vodResume, vodWatched: settings.vodWatched, showLast: settings.showLast };
  });
  // "Start from the beginning": forget the resume points and ✓ marks of these videos.
  h('progress:reset', ({ ids = [], showKey = null } = {}) => {
    const resume = { ...(settings.vodResume || {}) };
    const seen = { ...(settings.vodWatched || {}) };
    for (const id of ids) { delete resume[id]; delete seen[id]; }
    settings.vodResume = resume; settings.vodWatched = seen;
    if (showKey && settings.showLast) { const m = { ...settings.showLast }; delete m[showKey]; settings.showLast = m; }
    saveSettings();
    send('progress-changed', { vodResume: settings.vodResume, vodWatched: settings.vodWatched, showLast: settings.showLast || {} });
    return true;
  });
  // Phones: tune without changing what the PC remembers as its last channel.
  h('tune:phone', (id) => tune(id, undefined, { phone: true }));
  // The phone app (pairing, remote control)
  h('phone:status', () => phone.view());
  h('phone:enable', (on) => phone.enable(on));
  h('phone:pairStart', () => phone.pairStart());
  h('phone:pairStop', () => phone.pairStop());
  h('phone:forget', (id) => phone.forget(id));
  h('phone:setLevel', (id, level) => phone.setLevel(id, level));
  h('remote:now', (n) => { phone.setNow(n); });
  h('audio:remember', (key, lang) => { settings.audioChoice = { ...(settings.audioChoice || {}), [key]: lang }; saveSettings(); });
  h('subs:remember', (key, choice) => { settings.subChoice = { ...(settings.subChoice || {}), [key]: choice }; saveSettings(); subsCache.clear(); });
  h('app:startOver', () => {
    if (casting) stopCasting('start over').catch(() => {});
    fs.writeFileSync(path.join(app.getPath('userData'), 'start-over'), '');
    app.relaunch();
    setTimeout(() => app.exit(0), 300);
  });
  h('setup:inventory', () => {
    const mine = (i) => !String(i.server || '').startsWith('archive:');
    const all = lib.list().filter((i) => i.kind !== 'ad');
    const movies = all.filter((i) => i.kind === 'movie' && mine(i))
      .map((i) => ({ id: i.id, title: i.title, year: i.year || null, poster: posterUrl(i) || i.art || null, duration: i.duration, folder: i.folder }))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
    const shows = lib.shows().filter((x) => lib.episodesOf(x.key).some(mine))
      .map((x) => ({ key: x.key, name: x.name, poster: x.meta?.poster || null, thumb: media.thumbUrl(lib.episodesOf(x.key)[0]?.id), count: x.count, seasons: x.seasons, genres: x.meta?.genres || [], folders: x.folders || [] }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const movieIds = new Set(movies.map((m) => m.id)), showKeys = new Set(shows.map((x) => x.key));
    const guess = suggestChannels(lib, channels).filter((x) => !x.ondemand).map((x) => {
      const members = new Set();
      for (const src of x.sources || []) for (const it of lib.resolve(src)) {
        if (movieIds.has(it.id)) members.add('m:' + it.id);
        if (it.showKey && showKeys.has(it.showKey)) members.add('s:' + it.showKey);
      }
      return { ...x, members: [...members] };
    });
    const count = (k) => all.filter((i) => i.kind === k && mine(i)).length;
    return { movies, shows, guess, other: { music: count('music'), clips: count('clip') + count('short'), episodes: shows.reduce((n, x) => n + x.count, 0) } };
  });
  h('channels:create', (list) => {
    const made = [];
    for (const c of [].concat(list)) {
      const ch = normalizeChannel(c);
      // Two channels never share a number: a newcomer wanting a taken one moves on.
      if (channels.some((x) => x.number === ch.number)) ch.number = nextNumber();
      channels.push(ch); made.push(ch);
    }
    saveChannels();
    sched.ensure(made);
    send('channels-changed');
    return sortedChannels();
  });
  h('channels:update', (c) => {
    const i = channels.findIndex((x) => x.id === c.id);
    if (i < 0) return sortedChannels();
    // Two channels can't share a number: the edited one wins, the other moves.
    const clash = channels.find((x) => x.id !== c.id && x.number === +c.number);
    channels[i] = normalizeChannel({ ...channels[i], ...c });
    if (clash) clash.number = nextNumber();
    saveChannels();
    sched.rebuild(channels[i]);
    send('schedule-changed');
    return sortedChannels();
  });
  h('channels:delete', (id) => { if (settings.lockChannel === id) { settings.lockChannel = null; saveSettings(); } channels = channels.filter((c) => c.id !== id); sched.remove(id); saveChannels(); return sortedChannels(); });
  h('channels:addSources', (id, srcs) => {
    // Drag & drop from the library onto a channel.
    const ch = channels.find((c) => c.id === id);
    if (!ch) return sortedChannels();
    const key = (s) => s.type + ':' + (s.key || s.id || s.path || s.kind || s.genre);
    for (const s of srcs) if (!ch.sources.some((x) => key(x) === key(s))) ch.sources.push(s);
    saveChannels();
    sched.rebuild(ch);
    send('schedule-changed');
    return sortedChannels();
  });
  h('channels:renumber', (ids, start = 2) => {
    // Reorder one section; whoever else held those numbers moves out of the way.
    const moving = new Set(ids);
    ids.forEach((id, n) => { const c = channels.find((x) => x.id === id); if (c) c.number = start + n; });
    const taken = new Set(channels.filter((c) => moving.has(c.id)).map((c) => c.number));
    for (const c of channels) if (!moving.has(c.id) && taken.has(c.number)) { c.number = nextNumber(start + ids.length); taken.add(c.number); }
    saveChannels();
    send('channels-changed');
    return sortedChannels();
  });
  h('channels:preview', (c) => {
    // How much content would this channel have?
    const ids = new Set();
    let dur = 0;
    for (const s of [...(c.sources || []), ...(c.blocks || []).flatMap((b) => b.sources || [])])
      for (const it of lib.resolve(s)) if (!ids.has(it.id) && !chExcluded(c, it)) { ids.add(it.id); dur += it.duration; }
    return { items: ids.size, hours: dur / 3600 };
  });
  // The Channel Manager: what's on a channel now, and what from your library would fit it
  // (by shared tags, then by what's newest). Only names and pictures — nothing is changed.
  h('channels:related', (channelId) => {
    const ch = channels.find((c) => c.id === channelId && !c.locked);
    if (!ch) return null;
    const srcOf = new Map(); // item id → the channel source it came from
    const excluded = [];
    for (const s of [...ch.sources, ...(ch.blocks || []).flatMap((b) => b.sources || [])])
      for (const it of lib.resolve(s)) {
        if (chExcluded(ch, it)) {
          const key = it.showKeyUser || it.showKey ? 'show:' + (it.showKeyUser || it.showKey) : 'item:' + it.id;
          if (!excluded.some((x) => x.key === key)) excluded.push({ key, name: it.showKeyUser || it.showKey ? (lib.meta[it.showKeyUser || it.showKey]?.nameOverride || it.showUser || it.show || it.title) : (it.titleUser || it.title) });
          continue;
        }
        if (!srcOf.has(it.id)) srcOf.set(it.id, s);
      }
    const showName = (k) => lib.meta[k]?.nameOverride || lib.shows().find((x) => x.key === k)?.name || k.replace(/^[a-z]+:/, '');
    const showThumb = (k) => { const ep = lib.episodesOf(k)[0]; return ep ? media.thumbUrl(ep.id) : null; };
    const curShows = new Map(), curMovies = [];
    for (const id of srcOf.keys()) {
      const it = lib.items[id];
      if (!it || lib.isPrivate(it.path)) continue;
      const k = it.showKeyUser || it.showKey;
      if (k) { if (!curShows.has(k)) curShows.set(k, { n: 0, via: srcOf.get(id) }); curShows.get(k).n++; }
      else if ((it.kindUser || it.kind) !== 'music') curMovies.push(it);
    }
    // The channel's taste: which tags its content wears most.
    const prof = new Map();
    for (const k of curShows.keys()) for (const g of lib.meta[k]?.genres || []) prof.set(g, (prof.get(g) || 0) + 1);
    for (const it of curMovies) for (const g of it.genres || []) prof.set(g, (prof.get(g) || 0) + 1);
    const score = (gs) => (gs || []).reduce((n, g) => n + (prof.get(g) || 0), 0);
    const explicitShow = (k) => ch.sources.some((s) => s.type === 'show' && s.key === k);
    const explicitItem = (id) => ch.sources.some((s) => s.type === 'item' && s.id === id);
    const viaLabel = (s) => (!s ? null : s.type === 'folder' ? `folder ${String(s.path).split(/[\\/]/).pop()}` : s.type === 'kind' ? (s.label || 'all ' + s.kind) : s.type === 'genre' ? `${s.genre} shows` : null);
    const current = {
      shows: [...curShows.entries()].map(([k, v]) => ({ key: k, name: showName(k), count: v.n, poster: showArtUrl(k), thumb: showThumb(k), genres: lib.meta[k]?.genres || [], removable: explicitShow(k), via: explicitShow(k) ? null : viaLabel(v.via) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
      movies: curMovies.map((m) => ({ id: m.id, title: m.titleUser || m.title, year: m.year || null, kind: m.kindUser || m.kind, poster: posterUrl(m) || m.art || null, thumb: media.thumbUrl(m.id), genres: m.genres || [], removable: explicitItem(m.id), via: explicitItem(m.id) ? null : viaLabel(srcOf.get(m.id)) }))
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true })),
    };
    const sugShows = lib.shows().filter((s) => !curShows.has(s.key) && lib.episodesOf(s.key).some((e) => !lib.isPrivate(e.path)))
      .map((s) => ({ key: s.key, name: lib.meta[s.key]?.nameOverride || s.name, count: s.count, poster: showArtUrl(s.key), thumb: showThumb(s.key), genres: lib.meta[s.key]?.genres || [], sc: score(lib.meta[s.key]?.genres) }))
      .sort((a, b) => b.sc - a.sc || b.count - a.count).slice(0, 60);
    const movedIn = new Set(curMovies.map((m) => m.id));
    const sugMovies = lib.list().filter((i) => (i.kindUser || i.kind) === 'movie' && !movedIn.has(i.id) && !lib.isPrivate(i.path) && !String(i.server || '').startsWith('archive:'))
      .map((m) => ({ id: m.id, title: m.titleUser || m.title, year: m.year || null, poster: posterUrl(m) || m.art || null, thumb: media.thumbUrl(m.id), genres: m.genres || [], sc: score(m.genres) }))
      .sort((a, b) => b.sc - a.sc || (b.added || 0) - (a.added || 0)).slice(0, 60);
    return { current, suggest: { shows: sugShows, movies: sugMovies }, excluded, genres: [...prof.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map((x) => x[0]) };
  });
  // A picture of your own as the channel's logo (copied, your file stays put).
  h('channels:logoPick', async (id) => {
    const ch = channels.find((c) => c.id === id);
    const r = await dialog.showOpenDialog(win, { title: 'Pick a picture for the channel logo', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
    if (r.canceled || !ch) return null;
    const dir = path.join(app.getPath('userData'), 'logos');
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(r.filePaths[0]).toLowerCase() || '.png';
    for (const e of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) { try { fs.rmSync(path.join(dir, id + e), { force: true }); } catch {} }
    fs.copyFileSync(r.filePaths[0], path.join(dir, id + ext));
    return media.artUrl('chlogo-' + id + ext) + '&v=' + Date.now();
  });

  h('import:legacy', async () => {
    // Kivy saved it in user_data_dir: %APPDATA%ideo\data.txt for "VideoApp".
    const guess = ['video', 'videoapp', 'VideoApp'].map((d) => path.join(app.getPath('appData'), d, 'data.txt')).find((f) => fs.existsSync(f));
    const r = await dialog.showOpenDialog(win, { title: 'Open the old VideoApp schedule (data.txt)', defaultPath: guess, filters: [{ name: 'Schedule', extensions: ['txt'] }, { name: 'All files', extensions: ['*'] }], properties: ['openFile'] });
    if (r.canceled) return null;
    const { blocks, folders } = importLegacySchedule(fs.readFileSync(r.filePaths[0], 'utf8'));
    const ch = normalizeChannel({ name: 'Classic Schedule', logo: '📺', order: 'shuffle', align: 0, blocks, sources: [] }); // one continuous network, like the old player
    channels.push(ch);
    saveChannels();
    const existing = folders.filter((f) => fs.existsSync(f));
    const missing = folders.filter((f) => !fs.existsSync(f));
    if (existing.length) lib.scan(existing, { prune: false }).then(() => { sched.rebuild(ch); send('schedule-changed'); }).catch(() => {});
    else sched.ensure([ch]);
    return { channel: ch, blocks: blocks.length, scanning: existing, missing };
  });

  h('win:fullscreen', (on) => { win.setFullScreen(on == null ? !win.isFullScreen() : !!on); return win.isFullScreen(); });
  h('win:minimize', () => win.minimize());
  h('win:maximize', () => { if (win.isMaximized()) win.unmaximize(); else win.maximize(); });
  h('win:close', () => win.close());
  h('openLog', () => shell.openPath(logFile()));
  h('notices', () => fs.readFileSync(path.join(__dirname, '../../NOTICES.md'), 'utf8'));
  // "Check now": answer as soon as the check is done — the download carries on
  // in the background (Settings shows its progress live).
  h('update:check', async () => { const info = await updater.check(); if (info) updater.run('manual'); return { ...updater.status(), found: info ? info.version : null }; });
  h('update:status', () => updater.status());
  // "Update now": restart straight into the new version (the updater window
  // swaps it in and HomeCable reopens by itself).
  h('update:apply', () => updater.apply(() => win.close()));
}

// "Start over from scratch" (Settings, or the installer's "start fresh"): clear
// HomeCable's own data before anything is loaded — channels, people, settings,
// library, posters — so the first-time setup runs again. Video files are untouched.
function startOverIfAsked(dir) {
  const flag = path.join(dir, 'start-over');
  if (!fs.existsSync(flag)) return;
  for (const f of fs.readdirSync(dir)) {
    if (/\.json(\.bak|\.tmp)?$/.test(f) || f === 'posters' || f === 'thumbs') { try { fs.rmSync(path.join(dir, f), { recursive: true, force: true }); } catch {} }
  }
  try { fs.rmSync(flag, { force: true }); } catch {}
}

app.whenReady().then(async () => {
  startOverIfAsked(app.getPath('userData'));
  store = new Store(app.getPath('userData'));
  channels = store.read('channels', []);
  settings = { ...DEFAULT_SETTINGS, ...store.read('settings', {}) };
  // Background update checks + "Update now" (installing happens in the
  // launcher's updater window at start — never on close).
  updater = createUpdater({ app, log, send, settings: () => settings, saveSettings });
  if (settings.updateEvery === 'start') { settings.updateEvery = '24h'; saveSettings(); } // the start-up window does that now
  lib = new Library(store);
  sched = new Scheduler(store, lib);
  profiles = new Profiles(store);
  const thumbDir = path.join(app.getPath('userData'), 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });
  media = await startServer(lib, log, {
    thumbDir,
    liveFor: (id) => channels.find((c) => c.id === id)?.iptv || null,
    subtitleArgs: async (id, s, t) => {
      const it = lib.items[id];
      const info = it && (await subsInfo(it));
      const tr = info?._all.find((x) => x.id === s);
      return tr && tr.kind === 'text' ? subtitles.vttArgs(it, tr, t) : null;
    },
    posterFor: (id) => (id.startsWith('chlogo-') && /^[\w.-]+$/.test(id.slice(7)) && !id.includes('..') ? path.join(app.getPath('userData'), 'logos', id.slice(7))
      : id.startsWith('series-') ? path.join(posterDir(), id + '.jpg') : lib.items[id]?.poster || null),
    mirror: (req, res) => mirrorRequest(req, res),
  });
  lib.defaultPolicy = settings.newMedia;
  // Uploaded channel-logo pictures are served with this run's media token — refresh saved links.
  for (const c of channels) if (c.look?.custom) { const m = /art\/(chlogo-[\w.-]+)/.exec(c.look.custom); if (m) c.look.custom = media.artUrl(m[1]); }
  // One-time: stations added before genre tags existed get theirs now, so the
  // guide's genre filter groups the whole lineup, not just new arrivals.
  { let tagged = 0; for (const c of channels) if (c.iptv && !c.iptv.genre) { c.iptv.genre = stationGenre(c.name, c.iptv.group); tagged++; } if (tagged) { saveChannels(); log('live stations genre-tagged:', tagged); } }
  const adsMigrated = migrateAds();
  applyAds();
  applyIdents();
  // Register the ad packs (the one that ships inside the app + yours; unchanged files are skipped).
  setTimeout(() => loadAdPacks(adsMigrated).catch((e) => log('ad packs', e.message)), 2500);
  // The welcome tour shows once, after a fresh first-time setup. PCs that were
  // already set up before it existed don't get it popped at them (Settings has it),
  // and automated test runs (offscreen window) never get the popup.
  if ((settings.setupDone || process.env.HOMECABLE_OFFSCREEN) && settings.tourDone === undefined) { settings.tourDone = true; saveSettings(); }
  // Keep the ad pack in sync: at start, then every 6 hours (every 30 min while offline).
  if (settings.adsOn) setTimeout(syncAds, 8000);
  setInterval(() => { if (settings.adsOn && adFeedUrl() && Date.now() - (adSync.at || 0) > (adSync.error ? 30 * 60e3 : 6 * 3600e3)) syncAds(); }, 5 * 60e3);
  log('HomeCable', app.getVersion(), 'media server', media.base, 'library items', lib.list().length);
  if (!process.env.HOMECABLE_NO_CAST) watchForTvs();
  setTimeout(() => findMoviePosters().catch((e) => log('posters', e)), 12000);

  lib.on('progress', (p) => send('scan-progress', p));
  let posterTimer = null;
  lib.on('changed', () => {
    ratingCache.clear(); // new content can change what a channel is rated
    // New movies: look for their posters once the scan settles.
    clearTimeout(posterTimer);
    posterTimer = setTimeout(() => findMoviePosters().catch((e) => log('posters', e)), 4000);
    sched.libraryChanged(channels);
    send('library-changed', libraryStats());
    send('schedule-changed');
  });
  // One-time fix (1.1.2): On Demand / Stream Demand show what's in THEIR folder — earlier
  // setups also pointed them at every movie / every episode on the PC.
  if (!settings.odFolderOnly) {
    let changed = false;
    for (const c of channels.filter((x) => x.ondemand && x.sources.some((s) => s.type === 'folder'))) {
      const keep = c.sources.filter((s) => !(s.type === 'kind' && (s.mine || /^All your/.test(s.label || ''))));
      if (keep.length !== c.sources.length) { c.sources = keep; changed = true; }
    }
    for (const c of channels.filter((x) => x.ondemand && x.odStyle === 'series' && x.name === 'HomeStreamer')) { c.name = 'Stream Demand'; changed = true; }
    if (changed) { saveChannels(); log('on demand: now showing only their own folders'); }
    settings.odFolderOnly = true; saveSettings();
  }
  applyVault();
  media.item = (id) => lib.items[id] || null;
  // What a kids/teens phone may play: everything on the channels its level can see (cached briefly).
  const phoneAllow = { at: 0, kids: null, teens: null };
  const allowedIdsFor = (level) => {
    if (!level || level === 'adults') return null;
    if (Date.now() - phoneAllow.at > 15000) {
      for (const lv of ['kids', 'teens']) {
        const ids = new Set();
        for (const ch of channels) {
          if (ch.locked || !PROFILE_ALLOWS[lv].includes(ratingOf(ch) || 'all')) continue;
          for (const s of [...ch.sources, ...ch.blocks.flatMap((b) => b.sources || [])]) for (const it of lib.resolve(s)) if (!chExcluded(ch, it)) ids.add(it.id);
        }
        phoneAllow[lv] = ids;
      }
      phoneAllow.at = Date.now();
    }
    return phoneAllow[level] || phoneAllow.kids;
  };
  phone = createPhone({ settings, saveSettings, media, send, log, profiles, allowedIdsFor,
    call: async (name, ...a) => handlerFns[name](...a),
    isDenied: (it) => !it || lib.isPrivate(it.path),
    filesRoot: path.join(__dirname, '..', 'phone'), nodeModules: path.join(__dirname, '..', '..', 'node_modules'),
    pcName: () => (process.env.HOMECABLE_DEMO ? 'Living Room PC' : os.hostname()) });
  if (settings.phone?.enabled) phone.enable(true).catch((e) => log('phone', e.message));
  captions.setLog(log);
  app.on('will-quit', () => captions.stop());
  quietOnDemandFolders();
  handlers();
  createWindow();
  lib.watch();
  // Look for new media: shortly after start (catches anything added while the
  // app was closed) and then on the chosen schedule.
  if (settings.setupDone) setTimeout(() => scanEverything().catch((e) => log('rescan', e)), 5000);
  setInterval(() => {
    const every = SCAN_MS[settings.scanInterval];
    if (settings.setupDone && every && Date.now() - settings.lastScan >= every) scanEverything().catch((e) => log('scan', e));
  }, 5 * 60e3);
  // Live TV: last guides from disk, then keep guides fresh (12 h) and the lineup checked (daily).
  guides = store.read('guides', { guides: {} }).guides || {};
  setTimeout(() => { if (settings.live && Date.now() - (store.read('guides', {}).at || 0) > 12 * 3600e3) refreshGuides().catch((e) => log('guides', e.message)); }, 15000);
  // Every start: scan the lineup against the iptv database in the background —
  // stations that work come back, three-strikes-dead ones go, new ones that fit
  // your saved languages/countries/regions are added, and the guide refreshes.
  setTimeout(() => { if (settings.live) refreshLive().catch((e) => log('live refresh', e.message)); }, 25000);
  setInterval(() => {
    if (!settings.live) return;
    if (Date.now() - settings.lastLiveRefresh > 24 * 3600e3) refreshLive().catch((e) => log('live refresh', e.message));
    else if (Date.now() - (store.read('guides', {}).at || 0) > 12 * 3600e3) refreshGuides().catch((e) => log('guides', e.message));
  }, 30 * 60e3);
  // Keep every channel's timeline topped up.
  setInterval(() => { try { sched.ensure(channels); } catch (e) { log('ensure', e.stack); } }, 10 * 60e3);
  // First start after an update: say so, warmly — people should KNOW the
  // delete-and-reinstall they half-saw was the update doing its job.
  if (settings.lastRunVersion && updater.newerThan(app.getVersion(), settings.lastRunVersion)) {
    const from = settings.lastRunVersion;
    setTimeout(() => send('update-done', { version: app.getVersion(), from }), 3500);
  } else if (updater.status().failed && settings.updateFailedSaid !== updater.status().failed) {
    // A downloaded version wouldn't start, so the launcher went back to this one. Say so once.
    const bad = updater.status().failed;
    settings.updateFailedSaid = bad; saveSettings();
    setTimeout(() => send('toast', `v${bad} didn’t start properly — you’re back on v${app.getVersion()}. It’ll try the next update.`), 3500);
  }
  if (settings.lastRunVersion !== app.getVersion()) { settings.lastRunVersion = app.getVersion(); saveSettings(); }
  // Updates while running: on the chosen rhythm (the start-up window already
  // checked if it was on). Found ones download quietly; "Update now" or the
  // next start switches over.
  if (updater.due()) setTimeout(() => updater.run('boot'), 2500);
  setInterval(() => { if (updater.due()) updater.run('timer'); }, 30 * 60e3);
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', async () => { if (casting) await Promise.race([stopCasting('quit'), new Promise((r) => setTimeout(r, 2500))]); media?.stopStreams(); lib?.close(); if (sched) store.write('schedule', sched.state); app.quit(); });
