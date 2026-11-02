// Suggests channels from what's in the library. Pure function of the library
// contents + existing channels; the UI lets the user tick which ones to create.
const PALETTE = ['#ff5a5f', '#ffb400', '#00a699', '#7b61ff', '#2d9cdb', '#f2994a', '#eb5757', '#27ae60', '#bb6bd9', '#56ccf2', '#e0558a', '#6fcf97'];

// Folder/genre words → themed channel.
const THEMES = [
  { name: 'Cartoon Network', match: /\b(cartoons?|animated|animation|toons?|kids|children|nick(elodeon)?|disney)\b/i, genres: ['Children', 'Family', 'Animation'], logo: '🎨' },
  { name: 'Anime', match: /\b(anime|animes)\b/i, genres: ['Anime'], logo: '⛩️' },
  { name: 'Sci-Fi Channel', match: /\b(sci-?fi|science fiction|space)\b/i, genres: ['Science-Fiction'], logo: '🚀' },
  { name: 'Comedy Central', match: /\b(comedy|comedies|sitcoms?|stand-?up)\b/i, genres: ['Comedy'], logo: '😂' },
  { name: 'Drama', match: /\b(drama|dramas)\b/i, genres: ['Drama'], logo: '🎭' },
  { name: 'Crime & Mystery', match: /\b(crime|mystery|detective|true crime)\b/i, genres: ['Crime', 'Mystery', 'Legal'], logo: '🔍' },
  { name: 'Horror', match: /\b(horror|scary|halloween)\b/i, genres: ['Horror', 'Supernatural', 'Thriller'], logo: '🦇' },
  { name: 'Discovery', match: /\b(documentar(y|ies)|docs?|nature|history|science|wildlife)\b/i, genres: ['Nature', 'History', 'Science'], logo: '🌍' },
  { name: 'Food Network', match: /\b(cooking|food|kitchen|chef|recipes?|baking)\b/i, genres: ['Food'], logo: '🍳' },
  { name: 'Action', match: /\b(action|superhero(es)?|marvel|dc)\b/i, genres: ['Action', 'Adventure'], logo: '💥' },
  { name: 'Reality TV', match: /\b(reality)\b/i, genres: ['Reality', 'Game Show'], logo: '📺' },
  { name: 'MTV', match: /\b(music videos?|concerts?|mtv)\b/i, genres: ['Music'], logo: '🎸' },
];

function suggestChannels(lib, existing = []) {
  const items = lib.list();
  const shows = lib.shows();
  const out = [];
  const usedNames = new Set(existing.map((c) => c.name.toLowerCase()));
  const add = (s) => {
    if (usedNames.has(s.name.toLowerCase())) return;
    usedNames.add(s.name.toLowerCase());
    out.push({ id: 'sug-' + out.length, color: PALETTE[out.length % PALETTE.length], order: 'sequential', align: 30, ...s });
  };
  const movies = items.filter((i) => i.kind === 'movie');
  const shorts = items.filter((i) => i.kind === 'short');
  const music = items.filter((i) => i.kind === 'music');
  const showSrc = (list) => list.map((s) => ({ type: 'show', key: s.key, label: s.name }));
  const desc = (list) => list.slice(0, 4).map((s) => s.name).join(', ') + (list.length > 4 ? ` +${list.length - 4} more` : '');

  // Themed channels from folder names and (when fetched) TVmaze genres.
  for (const th of THEMES) {
    const hit = shows.filter((s) => s.folders.some((f) => th.match.test(f)) || (s.meta?.genres || []).some((g) => th.genres.includes(g)));
    if (hit.length >= 2) add({ name: th.name, logo: th.logo, reason: `${hit.length} shows: ${desc(hit)}`, sources: showSrc(hit), recommended: true });
  }

  // Runtime-based blocks: half-hour vs hour-long shows.
  const half = shows.filter((s) => s.avg >= 15 * 60 && s.avg <= 33 * 60);
  const hour = shows.filter((s) => s.avg > 36 * 60 && s.avg <= 70 * 60);
  if (half.length >= 3) add({ name: 'Half-Hour Hits', logo: '📼', reason: `${half.length} half-hour shows, each in episode order`, sources: showSrc(half), recommended: true });
  if (hour.length >= 3) add({ name: 'Prime Time', logo: '🌙', reason: `${hour.length} hour-long shows, each in episode order`, sources: showSrc(hour), recommended: true });

  // Cable's "On Demand": a wall of your own full-length movies to pick from.
  const myMovies = movies.filter((m) => !String(m.server || '').startsWith('archive:'));
  if (myMovies.length >= 2 && !existing.some((c) => c.ondemand && c.odStyle !== 'series')) add({ name: 'Movies On Demand', logo: '🎬', color: '#7b61ff', ondemand: true, reason: `${myMovies.length} of your movies — pick one and watch from the start, with resume`, sources: [{ type: 'kind', kind: 'movie', mine: true, label: 'All your movies' }], recommended: true });
  if (movies.length >= 3) {
    add({ name: 'Movie Channel', logo: '🎬', order: 'shuffle', align: 30, reason: `${movies.length} movies, shuffled`, sources: [{ type: 'kind', kind: 'movie', label: 'All movies' }], recommended: true });
    // Decade channels when there are enough dated movies.
    const byDecade = new Map();
    for (const m of movies) if (m.year) { const d = Math.floor(m.year / 10) * 10; byDecade.set(d, (byDecade.get(d) || []).concat(m)); }
    for (const [d, list] of [...byDecade].sort()) {
      if (list.length >= 6) add({ name: `${String(d).slice(2)}s Movies`, logo: '🍿', order: 'shuffle', reason: `${list.length} movies from the ${d}s`, sources: list.map((m) => ({ type: 'item', id: m.id, label: m.title })) });
    }
  }

  if (shows.length >= 2) {
    add({ name: 'Everything', logo: '🔀', order: 'sequential', reason: `All ${shows.length} shows${movies.length ? ' and movies' : ''} on rotation`, sources: [{ type: 'kind', kind: 'episode', label: 'All TV episodes' }, ...(movies.length ? [{ type: 'kind', kind: 'movie', label: 'All movies' }] : [])], recommended: shows.length >= 6 });
  }

  // A 24/7 marathon for each show with real depth.
  for (const s of shows.filter((s) => s.count >= 8).sort((a, b) => b.count - a.count)) {
    add({ name: `${s.name} 24/7`, logo: '', order: 'sequential', reason: `${s.count} episodes${s.seasons > 1 ? ` across ${s.seasons} seasons` : ''}, in order`, sources: [{ type: 'show', key: s.key, label: s.name }], recommended: s.count >= 20 });
  }

  // Small libraries: still offer something for every show and the movies.
  if (out.length < 4) {
    for (const s of shows.filter((s) => s.count >= 2 && s.count < 8)) add({ name: s.name, logo: '', reason: `${s.count} episodes, in order`, sources: [{ type: 'show', key: s.key, label: s.name }], recommended: true });
    if (movies.length && movies.length < 3) add({ name: 'Movie Channel', logo: '🎬', order: 'shuffle', reason: `${movies.length} movie${movies.length > 1 ? 's' : ''} — new ones join automatically`, sources: [{ type: 'kind', kind: 'movie', label: 'All movies' }], recommended: true });
  }

  if (music.length >= (out.length < 4 ? 2 : 10)) add({ name: 'Radio', logo: '📻', order: 'shuffle', align: 0, reason: `${music.length} songs, shuffled`, sources: [{ type: 'kind', kind: 'music', label: 'All music' }], recommended: true });
  if (shorts.length >= 5) add({ name: 'Shorts & Clips', logo: '✂️', order: 'shuffle', align: 0, reason: `${shorts.length} short videos`, sources: [{ type: 'kind', kind: 'short', label: 'All short clips' }] });

  return out;
}

module.exports = { suggestChannels, PALETTE };
