// Commercial breaks — just for fun. Off by default. The ads are the short
// videos shipped with HomeCable and your own ad packs (folders of short
// videos), and/or an ad list you host online:
//
//   { "ads": [ { "title": "Static-B-Gone", "url": "https://…/static.mp4", "duration": 15 } ] }
//
// Ads are library items of kind 'ad' (never scheduled as shows).
const crypto = require('crypto');
const { probe } = require('./ffmpeg');

const idFor = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

// ---------- Ad packs ----------
// A pack is a folder of short ad videos plus homecable-ads.json. Put the folder
// on any static file host (Cloudflare Pages, GitHub Pages, Netlify…) and every
// HomeCable that points at it keeps an up-to-date local copy. Players only ever
// talk to that host — never to the PC that made the ads — and send no cookies,
// IDs or analytics: just a plain GET for the list and for new videos.
const fs = require('fs');
const path = require('path');
const MANIFEST = 'homecable-ads.json';
const MAX_AD = 45;               // a break is at most 45 s, so longer ads could never air
const MAX_FILE = 150 * 1024 * 1024;
const MAX_TOTAL = 2 * 1024 * 1024 * 1024;

const sha256File = (f) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(f).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});
const niceTitle = (file) => path.basename(file, path.extname(file))
  .replace(/clipto ai video downloader/ig, '').replace(/\(\d+\)$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Commercial';

// Creator side: write the manifest into the folder.
async function makePack(folder) {
  const { mediaType } = require('./naming');
  const files = fs.readdirSync(folder).filter((f) => mediaType(f) === 'video');
  const ads = [], skipped = [];
  for (const f of files) {
    const full = path.join(folder, f);
    const info = await probe(full);
    if (!info?.duration) { skipped.push({ file: f, why: 'not a playable video' }); continue; }
    if (info.duration > MAX_AD + 0.5) { skipped.push({ file: f, why: `${Math.round(info.duration)} s — trim it to 45 s or less` }); continue; }
    ads.push({ title: niceTitle(f), file: f, duration: Math.round(info.duration * 100) / 100, size: fs.statSync(full).size, sha256: await sha256File(full) });
  }
  const manifest = { format: 'homecable-ads', version: 1, updated: new Date().toISOString(), ads };
  fs.writeFileSync(path.join(folder, MANIFEST), JSON.stringify(manifest, null, 2));
  return { count: ads.length, skipped, manifest: path.join(folder, MANIFEST) };
}

const plainFetch = (url, opts = {}) => fetch(url, {
  ...opts, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
  headers: { 'User-Agent': 'HomeCable', Accept: opts.accept || '*/*' }, signal: AbortSignal.timeout(opts.timeout || 30000),
});
const allowed = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(x.hostname)); } catch { return false; } };

// Player side: mirror the pack into a local cache and register the ads.
async function syncFeed(lib, url, cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const drop = () => { for (const [id, it] of Object.entries(lib.items)) if (it.server === 'ads:feed') delete lib.items[id]; };
  if (!url) { drop(); for (const f of fs.readdirSync(cacheDir)) fs.rmSync(path.join(cacheDir, f), { force: true }); lib.save(); return { count: 0, added: 0, removed: 0 }; }
  if (!allowed(url)) throw new Error('Ad list must be an https:// address');
  const res = await plainFetch(url, { accept: 'application/json' });
  if (!res.ok) throw new Error(`Ad list download failed (${res.status})`);
  const j = await res.json();
  const list = (Array.isArray(j) ? j : j.ads || []).slice(0, 500);
  let added = 0, total = 0;
  const keep = new Set();
  drop();
  for (const ad of list) {
    const src = ad.url || (ad.file && new URL(ad.file.split('/').map(encodeURIComponent).join('/'), url).href);
    if (!src || !allowed(src)) continue;
    if (ad.duration && +ad.duration > MAX_AD + 0.5) continue;
    const name = (ad.sha256 && /^[a-f0-9]{64}$/.test(ad.sha256) ? ad.sha256 : idFor(src)) + (path.extname(new URL(src).pathname).toLowerCase().match(/^\.(mp4|webm|m4v|mov|mkv)$/) ? path.extname(new URL(src).pathname).toLowerCase() : '.mp4');
    const local = path.join(cacheDir, name);
    keep.add(name);
    if (!fs.existsSync(local) || (ad.size && fs.statSync(local).size !== +ad.size)) {
      if (ad.size && (+ad.size > MAX_FILE || total + +ad.size > MAX_TOTAL)) continue;
      const r = await plainFetch(src, { timeout: 120000 });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_FILE) continue;
      // Integrity: what was published is what plays.
      if (ad.sha256 && crypto.createHash('sha256').update(buf).digest('hex') !== ad.sha256) continue;
      fs.writeFileSync(local + '.part', buf);
      fs.renameSync(local + '.part', local);
      added++;
    }
    total += fs.statSync(local).size;
    let duration = +ad.duration || 0;
    if (!duration) duration = (await probe(local))?.duration || 0;
    if (!(duration > 1 && duration <= MAX_AD + 0.5)) continue;
    const id = idFor('ads:feed|' + name);
    lib.items[id] = {
      id, kind: 'ad', title: String(ad.title || 'Commercial').slice(0, 80), duration, server: 'ads:feed', path: local, folder: cacheDir,
      added: Date.now(), status: 'active', mode: /\.(mp4|webm|m4v)$/.test(name) ? 'direct' : 'transcode', vcodec: null, size: fs.statSync(local).size,
    };
  }
  // Ads removed from the pack disappear from every player.
  let removed = 0;
  for (const f of fs.readdirSync(cacheDir)) if (!keep.has(f)) { fs.rmSync(path.join(cacheDir, f), { force: true }); removed++; }
  lib.save();
  return { count: keep.size, added, removed };
}

// Everything under the user's ad folder is an ad, not a show.
function markFolder(lib, folder) {
  if (!folder) return 0;
  const pre = folder.toLowerCase().replace(/[\\/]+$/, '');
  let n = 0;
  for (const it of lib.list()) if (!it.remote && it.path.toLowerCase().startsWith(pre) && it.duration <= MAX_AD + 0.5) { if (it.kind !== 'ad') { it.kind = 'ad'; it.show = null; it.showKey = null; } n++; }
  lib.save();
  return n;
}

module.exports = { syncFeed, markFolder, makePack, MANIFEST, MAX_AD };
