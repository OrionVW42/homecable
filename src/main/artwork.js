// Movie posters for the On Demand wall. Tried in order, first hit wins:
//   1. cover art inside the file   (MP4 "covr" atom, MKV image attachment — ffmpeg
//                                     exposes both as an "attached picture" stream)
//   2. a picture next to the movie  ("Movie (1999).jpg", "Movie-poster.png",
//                                     or poster/folder/cover.jpg when the movie has
//                                     its own folder)
//   3. online, by title + year      (Wikipedia's film articles; only when "Online
//                                     show & movie info" is on, and only the movie's
//                                     name and year are sent)
// Every poster is converted to a small JPEG in the cache, so the wall loads fast
// and works offline afterwards.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ffmpegPath } = require('./ffmpeg');

const IMG = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];
const RETRY_ONLINE_MS = 7 * 24 * 3600e3;

function ff(args, timeout = 20000) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', (code) => { clearTimeout(t); resolve(code === 0); });
  });
}
const exists = (f) => { try { return fs.statSync(f).size > 500; } catch { return false; } };

// Any picture → poster-sized JPEG (500 px wide).
async function toJpeg(input, out) {
  const tmp = out + '.tmp.jpg';
  const ok = await ff(['-i', input, '-frames:v', '1', '-vf', 'scale=500:-2', '-pix_fmt', 'yuvj420p', '-q:v', '3', tmp]);
  if (ok && exists(tmp)) { fs.renameSync(tmp, out); return true; }
  try { fs.unlinkSync(tmp); } catch {}
  return false;
}

// 1. Cover art embedded in the file: "-map 0:v -map -0:V" keeps only the video
// streams that are attached pictures (V = real video, so it's subtracted).
async function embedded(item, out) {
  if (item.remote) return false;
  const tmp = out + '.tmp.jpg';
  const ok = await ff(['-i', item.path, '-map', '0:v', '-map', '-0:V', '-frames:v', '1', '-vf', 'scale=500:-2', '-pix_fmt', 'yuvj420p', '-q:v', '3', tmp]);
  if (ok && exists(tmp)) { fs.renameSync(tmp, out); return true; }
  try { fs.unlinkSync(tmp); } catch {}
  return false;
}

// 2. A picture beside the file.
function sidecarFor(item, siblingsInFolder) {
  if (item.remote || !item.path) return null;
  const dir = path.dirname(item.path);
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const base = path.basename(item.path, path.extname(item.path)).toLowerCase();
  const cands = [];
  for (const ext of IMG) for (const suffix of ['', '-poster', '.poster', ' poster', '-cover', '-folder']) cands.push(base + suffix + ext);
  // Folder-wide names only count when this movie has the folder to itself.
  if (siblingsInFolder <= 1) for (const ext of IMG) for (const n of ['poster', 'folder', 'cover', 'movie', 'default']) cands.push(n + ext);
  for (const c of cands) if (lower.has(c)) return path.join(dir, lower.get(c));
  return null;
}

// 3. Online lookups (title + year only).
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/^(the|a|an) /, '').replace(/[^a-z0-9]+/g, '');
// Film genres, read from how Wikipedia describes it ("2001 Japanese animated fantasy film").
const GENRE_WORDS = [
  ['Animation', /\banimat(ed|ion)\b/i], ['Science fiction', /\bscience[ -]fiction|\bsci[ -]fi\b/i], ['Horror', /\bhorror\b/i],
  ['Comedy', /\bcomedy\b/i], ['Drama', /\bdrama\b/i], ['Action', /\baction\b/i], ['Fantasy', /\bfantasy\b/i],
  ['Thriller', /\bthriller\b/i], ['Romance', /\bromance\b|\bromantic\b/i], ['Documentary', /\bdocumentary\b/i],
  ['Crime', /\bcrime\b|\bheist\b/i], ['Western', /\bwestern\b/i], ['Adventure', /\badventure\b/i], ['Mystery', /\bmystery\b/i],
  ['Musical', /\bmusical\b/i], ['Family', /\bfamily film|children's film/i], ['War', /\bwar film/i], ['Superhero', /\bsuperhero\b/i],
];
function genresFromText(text) {
  const out = GENRE_WORDS.filter(([, re]) => re.test(text)).map(([g]) => g);
  if (out.includes('Animation') && /japanese/i.test(text)) out.unshift('Anime');
  return out;
}
async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'HomeCable/1.0 (home media player)', Accept: 'application/json' } });
  // Rate-limited: stop the whole online pass for now (it resumes on a later run)
  // instead of hammering on and making the block longer.
  if (r.status === 429) throw Object.assign(new Error('rate limited'), { status: 429, offline: true });
  if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
  return r.json();
}
async function wikipediaPoster(title, year) {
  // The page itself, if it's a film with a picture (500 px rendition: big enough, small to download).
  const filmPage = async (p, named) => {
    try {
      const j = await getJson('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(p.replace(/ /g, '_')));
      const img = j.originalimage?.source || j.thumbnail?.source;
      const isFilm = /film|movie|animated feature/i.test(j.description || '') && (!year || named || String(j.extract || '').includes(String(year)));
      if (j.type !== 'standard' || !img || !isFilm) return null;
      const o = j.originalimage;
      return { url: o && o.width <= 1000 ? o.source : (j.thumbnail?.source || img).replace(/\/\d+px-/, '/500px-'), title: j.title, year,
        genres: genresFromText(`${j.description || ''} ${String(j.extract || '').slice(0, 300)}`) };
    } catch (e) { if (e.status && e.status !== 404) throw e; return null; }
  };
  for (const p of [...(year ? [`${title} (${year} film)`] : []), `${title} (film)`, title]) {
    const hit = await filmPage(p, /\(\d{4} film\)/.test(p));
    if (hit) return hit;
  }
  // File names can't hold ":" or "?" — "Ali G Who Iz I" is really "Ali G: Who Iz I?". Search,
  // and accept a result whose title matches once punctuation is ignored.
  const want = norm(title);
  // The REST search endpoint — api.php turns Electron's requests away.
  const q0 = await getJson('https://en.wikipedia.org/w/rest.php/v1/search/page?' + new URLSearchParams({ q: `${title} ${year || ''} film`.trim(), limit: '8' }));
  const q = { query: { search: q0.pages || [] } };
  for (const r of q.query?.search || []) {
    if (norm(r.title.replace(/\s*\((\d{4} )?film\)$/i, '')) !== want) continue;
    const hit = await filmPage(r.title, /\(\d{4} film\)/.test(r.title));
    if (hit) return hit;
  }
  return null;
}
async function download(url, out) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'HomeCable/1.0 (home media player)' } });
  if (!r.ok) return false;
  const raw = out + '.dl';
  fs.writeFileSync(raw, Buffer.from(await r.arrayBuffer()));
  const ok = await toJpeg(raw, out);
  try { fs.unlinkSync(raw); } catch {}
  return ok;
}

// Find a poster for one movie. Updates the item's poster fields; returns true if it has one.
async function findPoster(item, { dir, online = false, siblings = 1, log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, item.id + '.jpg');
  const done = (from, extra = {}) => { Object.assign(item, { poster: out, posterFrom: from, posterAt: Date.now() }, extra); return true; };
  if (await embedded(item, out)) return done('file');
  const side = sidecarFor(item, siblings);
  if (side && await toJpeg(side, out)) return done('folder', { posterSource: side });
  item.posterTried = Date.now();
  if (!online) return false;
  for (const look of [wikipediaPoster]) {
    try {
      const hit = await look(item.title, item.year);
      if (hit && await download(hit.url, out)) return done('online', { posterUrl: hit.url, ...(hit.genres?.length && !(item.genres || []).length ? { genres: hit.genres } : {}) });
    } catch (e) {
      log('poster lookup', look.name, item.title, String(e.message || e));
      if (/fetch failed|timeout|abort|ENOTFOUND/i.test(String(e))) throw Object.assign(new Error('offline'), { offline: true });
    }
  }
  item.posterOnlineTried = Date.now();
  return false;
}

// Which movies still need a look: no poster yet (or its cache file vanished), and
// not tried recently. Local checks are cheap and redone after a rescan; online
// lookups that found nothing wait a week before trying again.
function needsPoster(item, online, anyKind = false) {
  if (item.kind !== 'movie' && !anyKind) return false;
  if (item.poster && fs.existsSync(item.poster)) return false;
  if (item.posterUserSet) return false;
  if (!item.posterTried) return true;
  if (item.mtime && item.posterTried < item.mtime) return true;
  return online && (!item.posterOnlineTried || Date.now() - item.posterOnlineTried > RETRY_ONLINE_MS);
}

module.exports = { findPoster, needsPoster, sidecarFor, wikipediaPoster, genresFromText, norm, toJpeg, IMG };
