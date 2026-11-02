// Optional online lookup of show genres / posters / summaries via TVmaze
// (free, no API key). Only show names are sent. Results cache in library.meta.
async function lookupShow(name) {
  const res = await fetch('https://api.tvmaze.com/singlesearch/shows?q=' + encodeURIComponent(name), { signal: AbortSignal.timeout(10000) });
  if (res.status === 404) return { notFound: true, at: Date.now(), language: null };
  if (!res.ok) throw new Error('TVmaze ' + res.status);
  const j = await res.json();
  const genres = [...(j.genres || [])];
  // "Anime" isn't a TVmaze genre: an animated, Japanese-language show is one.
  if (j.type === 'Animation' && !genres.includes('Animation')) genres.push('Animation');
  if (j.type === 'Animation' && j.language === 'Japanese' && !genres.includes('Anime')) genres.unshift('Anime');
  return {
    id: j.id, name: j.name, genres, type: j.type, language: j.language || null, premiered: j.premiered,
    poster: j.image?.medium || null, network: j.network?.name || j.webChannel?.name || null,
    summary: (j.summary || '').replace(/<[^>]+>/g, '').slice(0, 400), at: Date.now(),
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
