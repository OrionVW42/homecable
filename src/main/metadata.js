// Optional online lookup of show genres / posters / summaries. The name is tried several
// ways and checked against TVmaze, IMDb, iTunes and Wikipedia (identify.js) — the most
// probable match wins. Only show names are sent. Results cache in library.meta.
const { identify } = require('./identify');

async function lookupShow(name) {
  let r;
  try { r = await identify({ name, kind: 'show' }); } catch (e) { throw new Error(e.offline ? 'fetch failed' : String(e.message || e)); }
  const b = r.best;
  if (!b) return { notFound: true, at: Date.now(), language: null };
  return {
    id: b.tvmazeId || null, name: b.name, genres: (b.autoTags || b.genres || []).slice(0, 12), suggest: b.tags || [], type: b.type || null, language: b.language || null, premiered: b.premiered || (b.year ? String(b.year) : null),
    poster: b.poster || null, network: b.network || null, summary: (b.summary || '').slice(0, 400), at: Date.now(),
    anime: (b.genres || []).includes('Anime'), confidence: b.confidence, sources: b.sources,
  };
}

async function enrichLibrary(lib, onProgress) {
  const shows = lib.shows().filter((s) => !lib.meta[s.key]);
  let n = 0;
  for (const s of shows) {
    try {
      lib.meta[s.key] = await lookupShow(s.name);
    } catch (e) {
      if (/fetch failed|timeout|abort/i.test(String(e))) break; // offline — try again next time
    }
    onProgress?.(++n, shows.length, s.name);
    await new Promise((r) => setTimeout(r, 550)); // stay under TVmaze's 20 req / 10 s
  }
  lib.save();
  return n;
}

module.exports = { enrichLibrary, lookupShow };
