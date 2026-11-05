// A show's guide: its seasons and episodes, with its movies, OVAs and specials placed in the order
// to watch them. TV comes from TVmaze and Wikidata, anime from AniList. Only facts about the show:
// no streams, links or torrents. Only the show's name or id is sent.
const { norm } = require('./identify');

const UA = { 'User-Agent': 'HomeCable (home media player)', Accept: 'application/json' };
const get = async (url, headers = UA) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
};
const plain = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const isoOf = (d) => (d?.year ? `${d.year}-${String(d.month || 1).padStart(2, '0')}-${String(d.day || 1).padStart(2, '0')}` : '');
const yearOf = (iso) => +String(iso || '').slice(0, 4) || null;
const closeYear = (a, b) => !a || !b || Math.abs(a - b) <= 1;

// ---- TV ----
// Seasons in number order. A movie or special goes right after the season it came out during.
function tvParts(showName, episodes, films = []) {
  const seasons = new Map(), extras = [];
  for (const e of episodes || []) {
    if (e.number == null || e.type === 'significant_special') {
      if (e.type !== 'insignificant_special') extras.push({ key: `x${e.id}`, type: 'special', label: 'Special', title: e.name, date: e.airdate || '', summary: plain(e.summary) });
      continue;
    }
    if (!seasons.has(e.season)) seasons.set(e.season, []);
    seasons.get(e.season).push(e);
  }
  const parts = [...seasons.keys()].sort((a, b) => a - b).map((n) => {
    const eps = seasons.get(n).sort((a, b) => a.number - b.number);
    return { key: `s${n}`, type: 'season', label: `Season ${n}`, title: `Season ${n}`, season: n, names: [showName], date: eps[0].airdate || '', year: yearOf(eps[0].airdate),
      episodes: eps.map((e) => ({ key: `s${n}e${e.number}`, n: e.number, title: e.name || `Episode ${e.number}`, air: e.airdate || '', runtime: e.runtime || null, summary: plain(e.summary) })) };
  });
  for (const f of films) extras.push({ key: `f${f.qid}`, type: 'movie', label: 'Movie', title: f.title, date: f.date || '', summary: '' });
  for (const x of extras.sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    const part = { ...x, names: [x.title], year: yearOf(x.date), episodes: [{ key: x.key, n: 1, title: x.title, air: x.date, summary: x.summary }] };
    delete part.summary;
    const at = x.date ? parts.findIndex((p) => p.date && p.date > x.date) : -1;
    if (at === -1) parts.push(part); else parts.splice(at, 0, part);
  }
  return parts;
}

// Films that belong to this show, as Wikidata records it.
async function tvFilms(qid) {
  if (!qid) return [];
  const q = `SELECT DISTINCT ?f ?fLabel (MIN(?d) AS ?date) WHERE { VALUES ?link { wdt:P179 wdt:P8345 wdt:P144 } ?f ?link wd:${qid}; wdt:P31/wdt:P279* wd:Q11424; wdt:P577 ?d. SERVICE wikibase:label { bd:serviceParam wikibase:language 'en,mul'. } } GROUP BY ?f ?fLabel LIMIT 25`;
  const j = await get('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), { ...UA, Accept: 'application/sparql-results+json' });
  return (j?.results?.bindings || []).map((b) => ({ qid: b.f.value.split('/').pop(), title: b.fLabel?.value || '', date: String(b.date?.value || '').slice(0, 10) })).filter((f) => f.title && !/^Q\d+$/.test(f.title));
}

async function tvGuide(m) {
  let show = m.imdb ? await get(`https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(m.imdb)}`).catch(() => null) : null;
  if (!show) {
    const hit = await get(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(m.title)}`);
    if (hit && norm(hit.name) === norm(m.title) && closeYear(yearOf(hit.premiered), m.year)) show = hit;
  }
  if (!show) return null;
  const episodes = await get(`https://api.tvmaze.com/shows/${show.id}/episodes?specials=1`);
  const films = await tvFilms(m.qid).catch(() => []);
  return { from: 'TVmaze', summary: plain(show.summary), poster: show.image?.original || show.image?.medium || null, genres: show.genres || [], network: show.network?.name || show.webChannel?.name || null, parts: tvParts(m.title, episodes, films) };
}

// ---- Anime ----
const FOLLOW = new Set(['PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY']);
const KEEP = new Set(['TV', 'TV_SHORT', 'ONA', 'OVA', 'MOVIE', 'SPECIAL']);
const FIELDS = 'id idMal format episodes duration isAdult description(asHtml:false) genres tags{name rank isAdult} coverImage{large} nextAiringEpisode{episode} startDate{year month day} title{english romaji} streamingEpisodes{title} relations{edges{relationType node{id type format isAdult}}}';
const ani = async (query) => {
  const r = await fetch('https://graphql.anilist.co', { method: 'POST', signal: AbortSignal.timeout(15000), headers: { ...UA, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status);
  return (await r.json()).data || {};
};
const aniName = (n) => n.title?.english || n.title?.romaji || '';

// Everything in the franchise, in the order it came out.
function animeParts(nodes) {
  const list = [...nodes].filter((n) => KEEP.has(n.format) && !n.isAdult).sort((a, b) => isoOf(a.startDate).localeCompare(isoOf(b.startDate)) || a.id - b.id);
  let season = 0;
  return list.map((n) => {
    const title = aniName(n), date = isoOf(n.startDate);
    const names = [...new Set([n.title?.english, n.title?.romaji].filter(Boolean))];
    const count = n.episodes || (n.nextAiringEpisode?.episode ? n.nextAiringEpisode.episode - 1 : 0) || 1;
    const named = new Map();
    for (const e of n.streamingEpisodes || []) { const x = /^Episode (\d+)\s*[-:]\s*(.+)$/.exec(e.title || ''); if (x) named.set(+x[1], x[2]); }
    if (n.format === 'MOVIE' || (n.format === 'SPECIAL' && count === 1)) {
      const type = n.format === 'MOVIE' ? 'movie' : 'special';
      return { key: `a${n.id}`, type, label: type === 'movie' ? 'Movie' : 'Special', title, names, date, year: yearOf(date), episodes: [{ key: `a${n.id}`, n: 1, title, air: date }] };
    }
    const seasonal = n.format === 'TV' || n.format === 'TV_SHORT' || n.format === 'ONA';
    const label = seasonal ? `Season ${++season}` : n.format === 'OVA' ? 'OVA' : 'Specials';
    return { key: `a${n.id}`, type: seasonal ? 'season' : n.format === 'OVA' ? 'ova' : 'special', label, title, names, date, year: yearOf(date), ...(seasonal ? { season } : {}),
      episodes: Array.from({ length: Math.min(count, 2000) }, (_, i) => ({ key: seasonal ? `s${season}e${i + 1}` : `a${n.id}e${i + 1}`, n: i + 1, title: named.get(i + 1) || `Episode ${i + 1}` })) };
  });
}

async function animeGuide(m) {
  const first = m.ani ? `Media(id:${+m.ani},type:ANIME)` : m.mal ? `Media(idMal:${+m.mal},type:ANIME)` : `Media(search:${JSON.stringify(m.title)},type:ANIME,sort:SEARCH_MATCH)`;
  const root = (await ani(`{m:${first}{${FIELDS}}}`)).m;
  if (!root || root.isAdult) return null;
  if (!m.ani && !m.mal && ![root.title?.english, root.title?.romaji].some((t) => norm(t) === norm(m.title))) return null;
  const nodes = new Map([[root.id, root]]);
  let wave = [root];
  // A few at a time: this walks the franchise from sequel to sequel, without asking too often.
  while (wave.length && nodes.size < 40) {
    const ids = new Set();
    for (const n of wave) for (const e of n.relations?.edges || []) if (FOLLOW.has(e.relationType) && e.node?.type === 'ANIME' && KEEP.has(e.node.format) && !e.node.isAdult && !nodes.has(e.node.id)) ids.add(e.node.id);
    if (!ids.size) break;
    const batch = [...ids].slice(0, 12);
    const got = await ani(`{${batch.map((id, i) => `n${i}:Media(id:${id},type:ANIME){${FIELDS}}`).join(' ')}}`);
    wave = Object.values(got).filter(Boolean);
    for (const n of wave) nodes.set(n.id, n);
  }
  const tags = (root.tags || []).filter((t) => !t.isAdult && t.rank >= 60).map((t) => t.name).slice(0, 8);
  return { from: 'AniList', summary: plain(root.description), poster: root.coverImage?.large || null, genres: ['Anime', ...(root.genres || []).filter((g) => g !== 'Hentai' && g !== 'Ecchi'), ...tags], parts: animeParts(nodes.values()) };
}

// One title's cover, for anime and shows with no IMDb id.
async function coverFor(m) {
  if (m.kind === 'anime') {
    const first = m.ani ? `Media(id:${+m.ani},type:ANIME)` : m.mal ? `Media(idMal:${+m.mal},type:ANIME)` : null;
    if (!first) return null;
    const n = (await ani(`{m:${first}{isAdult coverImage{large}}}`)).m;
    return n && !n.isAdult ? n.coverImage?.large || null : null;
  }
  const hit = await get(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(m.title)}`);
  return hit && norm(hit.name) === norm(m.title) && closeYear(yearOf(hit.premiered), m.year) ? hit.image?.medium || null : null;
}

// Anime first; a franchise AniList doesn't know falls back to TV listings.
const guideFor = async (m) => (m.kind === 'anime' ? (await animeGuide(m)) || tvGuide(m) : tvGuide(m));

module.exports = { guideFor, coverFor, tvParts, animeParts };
