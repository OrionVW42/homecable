// Free IPTV: M3U playlists (your own, or the public iptv-org lists of
// free-to-air streams). Stations become live channels in the lineup.
const { spawn } = require('child_process');
const { ffmpegPath, parseProbe } = require('./ffmpeg');

const IPTV_ORG = 'https://iptv-org.github.io/iptv';
// Curated official free-to-air streams (Free-TV/IPTV), filtered by country.
const FREE_TV = 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8';
const SOURCES = [
  { id: 'iptv-org', name: 'iptv-org', desc: 'The big public list of free streams (by country and category)' },
  { id: 'free-tv', name: 'Free-TV', desc: 'Curated official free-to-air broadcasters' },
];
const CATEGORIES = ['animation', 'auto', 'business', 'classic', 'comedy', 'cooking', 'culture', 'documentary', 'education', 'entertainment', 'family', 'general', 'kids', 'legislative', 'lifestyle', 'movies', 'music', 'news', 'outdoor', 'relax', 'religious', 'science', 'series', 'shop', 'sports', 'travel', 'weather'];

function presetUrl({ country, category, language, region }) {
  if (category) return `${IPTV_ORG}/categories/${category}.m3u`;
  if (language) return `${IPTV_ORG}/languages/${language}.m3u`;
  if (region) return `${IPTV_ORG}/regions/${String(region).toLowerCase()}.m3u`;
  return `${IPTV_ORG}/countries/${(country || 'us').toLowerCase()}.m3u`;
}

function parseM3U(text) {
  const out = [];
  // Playlists can point at their own program guide(s).
  const header = (text.match(/^#EXTM3U[^\n]*/) || [''])[0];
  out.tvgUrls = ((header.match(/(?:x-tvg-url|url-tvg)="([^"]+)"/i) || [])[1] || '').split(',').map((u) => u.trim()).filter(Boolean);
  let cur = null, opts = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      for (const m of line.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1].toLowerCase()] = m[2];
      const name = line.slice(line.lastIndexOf(',') + 1).trim();
      cur = { name: name || attrs['tvg-name'] || 'Channel', logo: attrs['tvg-logo'] || '', group: attrs['group-title'] || '', tvgId: attrs['tvg-id'] || '', country: (attrs['tvg-country'] || '').toLowerCase() };
      opts = {};
    } else if (line.startsWith('#EXTVLCOPT:')) {
      const [k, ...v] = line.slice(11).split('=');
      if (/user-agent/i.test(k)) opts.userAgent = v.join('=');
      if (/referrer|referer/i.test(k)) opts.referer = v.join('=');
    } else if (!line.startsWith('#') && cur) {
      // Skip geo-blocked / not-24/7 markers iptv-org puts in names.
      const clean = cur.name.replace(/\s*\[(Geo-blocked|Not 24\/7)\]/gi, '').replace(/\s*[ⓈⒼⓎ]+\s*$/u, '').trim();
      out.push({ ...cur, name: clean, flags: { geo: /geo-blocked/i.test(cur.name), part: /not 24\/7/i.test(cur.name) }, url: line, ...opts });
      cur = null;
    }
  }
  return out;
}

async function fetchPlaylist(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'HomeCable' } });
  if (!res.ok) throw new Error(`Playlist download failed (${res.status})`);
  return parseM3U(await res.text());
}

// Free-TV's list, just the stations for one country.
async function fetchFreeTv(country) {
  const all = await fetchPlaylist(FREE_TV);
  const cc = (country || '').toLowerCase();
  const out = all.filter((s) => !cc || s.country === cc || (s.tvgId || '').toLowerCase().endsWith('.' + cc));
  out.tvgUrls = all.tvgUrls.filter((u) => new RegExp(`_${cc}\\d|_${cc}_`, 'i').test(u));
  return out;
}

function inputArgs(st) {
  const a = ['-hide_banner', '-nostdin'];
  if (st.userAgent) a.push('-user_agent', st.userAgent);
  if (st.referer) a.push('-referer', st.referer);
  a.push('-rw_timeout', '15000000');
  return a;
}

// Is the stream up, and can we copy it as-is? Resolves { ok, video, audio }.
// ALWAYS resolves: a station that doesn't answer in time is simply not ok and the
// checker moves on — one dead stream can never wedge an add (or the progress bar).
function checkStream(st, timeout = 12000) {
  return new Promise((resolve) => {
    let err = '', done = false, t = null, hard = null;
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); clearTimeout(hard); resolve(r); };
    let p;
    try { p = spawn(ffmpegPath(), [...inputArgs(st), '-i', st.url, '-t', '0.1', '-f', 'null', '-'], { windowsHide: true }); } catch { return finish({ ok: false }); }
    t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeout);
    // Backstop: even if the killed process never reports closing (stuck network
    // I/O on Windows can do this), the slot is freed and the station skipped.
    hard = setTimeout(() => finish({ ok: false }), timeout + 8000);
    p.stderr.on('data', (c) => { err += c; if (err.length > 100000) { try { p.kill(); } catch {} } });
    p.on('error', () => finish({ ok: false }));
    p.on('close', () => {
      const info = parseProbe(err);
      finish({ ok: !!(info.video || info.audio), video: info.video, audio: info.audio, width: info.width, height: info.height });
    });
  });
}

async function checkMany(list, { concurrency = 6, onProgress } = {}) {
  let i = 0, done = 0;
  const out = new Array(list.length);
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < list.length) {
      const k = i++;
      out[k] = { ...list[k], check: await checkStream(list[k]).catch(() => ({ ok: false })) };
      onProgress?.(++done, list.length, list[k].name);
    }
  }));
  return out;
}

// Args to restream a live channel into fragmented MP4 for the player.
function liveArgs(st, mode) {
  const a = [...inputArgs(st), '-loglevel', 'error', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    // Start quickly and near the live edge instead of minutes behind.
    '-analyzeduration', '3000000', '-probesize', '3000000', '-fflags', '+genpts+discardcorrupt'];
  if (/\.m3u8?(\?|$)/i.test(st.url)) a.push('-live_start_index', '-3');
  a.push('-i', st.url, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn');
  if (mode === 'copy') a.push('-c:v', 'copy');
  else a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', 'yadif=deint=interlaced');
  a.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return a;
}

// Free anime stations, found by name across the whole public index.
const ANIME = /anime|crunchyroll|retrocrush|toonami|naruto|pok[eé]mon|one piece|dragon ?ball|sailor moon|yu-?gi-?oh|gundam|hidive|otaku|animax|tokusatsu|power rangers|voltron|robotech/i;
async function fetchAnime() {
  const [all, anim] = await Promise.all([fetchPlaylist(`${IPTV_ORG}/index.m3u`), fetchPlaylist(presetUrl({ category: 'animation' }))]);
  const seen = new Set();
  return [...anim, ...all].filter((s) => ANIME.test(s.name) && !seen.has(s.url) && seen.add(s.url)).map((s) => ({ ...s, group: 'Anime', anime: true }));
}

module.exports = { fetchAnime, fetchFreeTv, FREE_TV, SOURCES, inputArgs, presetUrl, parseM3U, fetchPlaylist, checkStream, checkMany, liveArgs, CATEGORIES, IPTV_ORG };
