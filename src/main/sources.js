// Where a title in the index can be played. Each source answers find(movie) with the ways it
// can play that exact title; anything none of them can play says "No streams available".
// Built in: your own library, and the Internet Archive's free films (items marked public
// domain or Creative Commons). Those play straight from the web, or through their own torrent
// if you chose that and torrents are on; the torrent lock always wins.
const crypto = require('crypto');
const { norm, similar } = require('./identify');

const UA = { 'User-Agent': 'HomeCable (home media player)', Accept: 'application/json' };
const FREE = 'licenseurl:(*publicdomain* OR *creativecommons*)';
const json = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: UA }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
const label = (h) => (h >= 1000 ? '1080p' : h >= 700 ? '720p' : h >= 450 ? '480p' : 'SD');
const RANK = { '1080p': 0, '720p': 1, '480p': 2, SD: 3 };
const exact = (a, b) => norm(a) === norm(b);
const nearYear = (a, b) => !a || !b || Math.abs(+a - +b) <= 1;
// A license label is only what the uploader typed. Anything named like a rip of a commercial
// release isn't believed, and a same-named clip isn't the film: features run 40 minutes or more.
const RIP = /criterion|blu-?ray|bdrip|brrip|web-?rip|web-?dl|dvdrip|hdtv|remux|x.?26[45]|h.?265|hevc|yify|yts|rarbg/i;
const seconds = (v) => { const p = String(v || '').split(':').map(Number); return p.length > 1 ? p.reduce((n, x) => n * 60 + (x || 0), 0) : +v || 0; };
const MIN_FEATURE = 40 * 60;

// One file per quality: no doubles, best first. An MP4 beats anything else at the same quality.
function bestFiles(files) {
  const by = new Map();
  for (const f of files || []) {
    if (!/\.(mp4|m4v|mkv|webm|ogv|avi|mpe?g)$/i.test(f.name || '') || f.private === 'true' || RIP.test(f.name) || (f.length != null && seconds(f.length) < MIN_FEATURE)) continue;
    const q = label(+f.height || 0);
    const cur = by.get(q);
    const score = (/\.mp4$/i.test(f.name) ? 2 : 0) + (/h\.?264/i.test(f.format || '') ? 1 : 0);
    if (!cur || score > cur.score || (score === cur.score && +(f.size || 0) > +(cur.f.size || 0))) by.set(q, { f, score });
  }
  return [...by.entries()].sort((a, b) => RANK[a[0]] - RANK[b[0]]).map(([quality, { f }]) => ({ quality, name: f.name, size: +f.size || 0, duration: seconds(f.length), h264: /\.mp4$/i.test(f.name) && /h\.?264/i.test(f.format || '') }));
}

const archive = {
  id: 'archive',
  name: 'Internet Archive',
  async find(m) {
    const words = m.title.replace(/[()":\[\]{}^~\\!*?]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!words) return [];
    const q = `title:(${words}) AND mediatype:movies AND ${FREE}`;
    const j = await json(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=year&fl[]=date&fl[]=licenseurl&rows=25&sort[]=downloads+desc&output=json`);
    const hits = (j?.response?.docs || []).filter((d) => exact(d.title, m.title) && !RIP.test(`${d.identifier} ${d.title}`) && nearYear(d.year || String(d.date || '').slice(0, 4), m.year));
    const out = new Map();
    for (const d of hits.slice(0, 4)) {
      const meta = await json(`https://archive.org/metadata/${encodeURIComponent(d.identifier)}/files`).catch(() => null);
      // Only files that say how long they run: a file with no length can't be shown to be the feature.
      for (const f of bestFiles((meta?.result || []).filter((x) => x.length != null))) if (!out.has(f.quality)) out.set(f.quality, { source: 'archive', sourceName: 'Internet Archive', quality: f.quality, size: f.size, duration: f.duration, h264: f.h264, archive: { id: d.identifier, file: f.name }, license: d.licenseurl || '' });
    }
    return [...out.values()];
  },
  async open(s, ctx) {
    if (ctx.playBy !== 'torrent' || !ctx.torrentsOn) return playFromWeb(s, ctx.lib);
    // The item's own torrent, this one file only, cleared after watching.
    const r = await ctx.torrents.add(`https://archive.org/download/${s.archive.id}/${s.archive.id}_archive.torrent`, { policy: 'auto', onlyName: s.archive.file, watchOnly: true });
    if (!r.items?.length) throw new Error('This film could not be read');
    return r.items[0];
  },
};

// Straight from the Internet Archive, like the Free Classics: nothing is downloaded. The same
// film is the same item every time, so resume follows it.
function playFromWeb(s, lib) {
  const { id: item, file } = s.archive;
  const id = crypto.createHash('sha1').update(`movies|${item}|${file}`).digest('hex').slice(0, 12);
  if (!lib.items[id]) {
    lib.items[id] = {
      id, path: `Internet Archive/Movies/${file}`, folder: 'Internet Archive/Movies', size: s.size || 0, mtime: 0, added: Date.now(),
      kind: 'movie', title: file, duration: s.duration || 0, remote: true, catalogOnly: true, url: `https://archive.org/download/${encodeURIComponent(item)}/${file.split('/').map(encodeURIComponent).join('/')}`,
      art: `https://archive.org/services/img/${encodeURIComponent(item)}`, mode: s.h264 ? 'direct' : 'transcode', status: 'active', source: 'archive',
    };
    lib.save();
  }
  return id;
}

const library = {
  id: 'library',
  name: 'Your library',
  async find(m, ctx) {
    return ctx.items().filter((i) => (i.kindUser || i.kind) === 'movie' && !i.torrent && !i.catalogOnly && exact(i.titleUser || i.title, m.title) && nearYear(i.year, m.year))
      .map((i) => ({ source: 'library', sourceName: 'Your library', quality: i.height >= 1000 ? '1080p' : i.height >= 700 ? '720p' : i.height >= 450 ? '480p' : 'SD', itemId: i.id }));
  },
  async open(s) { return s.itemId; },
};

const SOURCES = [library, archive];

// Every way to play this title, best quality first, with one entry per quality.
async function findSources(movie, ctx) {
  const all = [];
  for (const src of SOURCES) {
    if (src.id === 'archive' && ctx.free === false) continue;
    try { all.push(...await src.find(movie, ctx)); } catch (e) { ctx.failed = true; ctx.log?.('a source had no answer:', src.id); }
  }
  return onePerQuality(all);
}
function onePerQuality(all) {
  const seen = new Map();
  for (const s of all) if (!seen.has(s.quality)) seen.set(s.quality, s); // your own copy comes first
  return [...seen.values()].sort((a, b) => RANK[a.quality] - RANK[b.quality]);
}
const openSource = (s, ctx) => {
  const src = SOURCES.find((x) => x.id === s?.source);
  if (!src) throw new Error('That stream is no longer available');
  return src.open(s, ctx);
};

module.exports = { findSources, openSource, onePerQuality, bestFiles, similar };
