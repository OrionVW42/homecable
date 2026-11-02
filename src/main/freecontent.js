// Free, legal content that can run like cable: public-domain collections on
// the Internet Archive (classic films, cartoons, TV). Items stream straight
// from archive.org and are scheduled like any other library media.
const crypto = require('crypto');
const { parsePath, showKey } = require('./naming');

const COLLECTIONS = [
  { id: 'feature_films', name: 'Classic Movies', logo: '🎞️', kind: 'movie', desc: 'Public-domain feature films' },
  { id: 'classic_cartoons', name: 'Classic Cartoons', logo: '🐭', kind: 'clip', desc: 'Golden-age animation' },
  { id: 'classic_tv', name: 'Classic TV', logo: '📺', kind: 'episode', desc: 'Vintage TV episodes' },
  { id: 'film_noir', name: 'Film Noir', logo: '🕵️', kind: 'movie', desc: 'Crime and noir classics' },
  { id: 'SciFi_Horror', name: 'Sci-Fi & Horror', logo: '👽', kind: 'movie', desc: 'B-movies and creature features' },
];
// Keep the default lineup family-friendly.
const SKIP = /\b(sex|nud(e|ity)|erotic|stag|burlesque|striptease|porn|xxx)\b/i;

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'HomeCable (home media player)' } });
  if (!r.ok) throw new Error('archive.org ' + r.status);
  return r.json();
}

async function listCollection(coll, rows = 60) {
  const q = encodeURIComponent(`collection:(${coll}) AND mediatype:(movies)`);
  const url = `https://archive.org/advancedsearch.php?q=${q}&fl[]=identifier&fl[]=title&fl[]=year&fl[]=licenseurl&sort[]=downloads+desc&rows=${rows * 2}&output=json`;
  const j = await getJson(url);
  return j.response.docs.filter((d) => !SKIP.test(d.title || '')).slice(0, rows);
}

// Pick the H.264 MP4 and its exact running time.
async function resolveItem(doc) {
  const j = await getJson(`https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`);
  const lic = j.metadata?.licenseurl || '';
  if (lic && !/publicdomain|zero/i.test(lic)) return null; // public domain only
  const files = j.files || [];
  const f = files.find((x) => /h\.264/i.test(x.format || '') && /\.mp4$/i.test(x.name))
    || files.find((x) => /mpeg4/i.test(x.format || '') && /\.mp4$/i.test(x.name));
  const length = parseFloat(f?.length);
  if (!f || !(length > 30)) return null;
  const year = +String(j.metadata?.year || j.metadata?.date || '').slice(0, 4) || null;
  return {
    identifier: doc.identifier, title: (j.metadata?.title || doc.title || doc.identifier).replace(/\s+/g, ' ').trim(), year,
    url: `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${encodeURIComponent(f.name)}`,
    duration: length, size: +f.size || 0, art: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
  };
}

// Add a collection to the library as remote items; returns the server id to use as a channel source.
async function importCollection(lib, coll, { rows = 60, onProgress } = {}) {
  const def = COLLECTIONS.find((c) => c.id === coll) || { id: coll, name: coll, kind: 'movie' };
  const serverId = 'archive:' + coll;
  const docs = await listCollection(coll, rows);
  let done = 0, added = 0, i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < docs.length) {
      const doc = docs[i++];
      let r = null;
      try { r = await resolveItem(doc); } catch {}
      onProgress?.(++done, docs.length, doc.title);
      if (!r) continue;
      const id = crypto.createHash('sha1').update(serverId + '|' + r.identifier).digest('hex').slice(0, 12);
      if (lib.items[id]) continue;
      // "Dragnet - The Big Break" → show "Dragnet"; titles without a show stay single programs.
      const parsed = parsePath(`${def.name}/${r.title}.mp4`);
      const show = def.kind === 'episode' ? (parsed.show || (r.title.match(/^(.{3,40}?)\s+[-–:]\s+/) || [])[1] || null) : null;
      const kind = r.duration < 180 ? 'short' : show ? 'episode' : def.kind === 'episode' ? 'clip' : def.kind === 'movie' && r.duration < 40 * 60 ? 'clip' : def.kind;
      lib.items[id] = {
        id, path: `Internet Archive/${def.name}/${r.title}`, folder: `Internet Archive/${def.name}`, size: r.size, mtime: 0, added: Date.now(),
        kind, title: r.title, year: r.year, duration: r.duration, remote: true, show, showKey: show ? showKey(show) : null, season: show ? parsed.season ?? 1 : null, episode: show ? parsed.episode ?? null : null, server: serverId, url: r.url, art: r.art,
        mode: 'direct', vcodec: 'h264', acodec: 'aac', status: 'active', source: 'archive',
      };
      added++;
    }
  }));
  if (!lib.servers.some((s) => s.id === serverId)) lib.servers.push({ id: serverId, name: `Internet Archive — ${def.name}`, kind: 'archive', collection: coll, detail: def.desc });
  lib.save();
  lib.emit('changed');
  return { serverId, added, def };
}

module.exports = { COLLECTIONS, importCollection, listCollection, resolveItem };
