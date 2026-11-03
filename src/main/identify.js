// Working out what a show or movie really is, from a messy file / folder / torrent name.
// No single lookup is trusted on its own:
//   1. the name is tried several ways (release junk, year, "The", "&"/"and", the part
//      before ":" or " - ", "FamilyGuy" -> "Family Guy", trailing "US"/"UK" ...)
//   2. three free, key-less sources are asked: TVmaze (shows), Apple's iTunes catalog
//      (shows + movies, big cover art) and Wikipedia (shows + movies)
//   3. every answer is scored against every variant of the name (+ the year when known);
//      answers that several sources agree on get a bonus. Best first, the rest kept as
//      alternatives (the editor shows them beside the best guess).
// It keeps going through variants and sources until something matches well — a single
// miss never means "not found". Only the name (and year) is ever sent.
const UA = { 'User-Agent': 'HomeCable/1.0 (home media player)', Accept: 'application/json' };

async function getJson(url, ms = 10000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: UA });
  if (r.status === 404) return null;
  if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
  return r.json();
}

// ---- names ----
const JUNK = /\b(s\d{1,2}(?:\s*-\s*s?\d{1,2})?(?:e\d{1,3})?|\d{1,2}x\d{2,3}|seasons? \d+(?:\s*-\s*\d+)?|complete(?: series)?|collection|pack|batch|\d{3,4}p|[48]k|uhd|imax|hdr\d*|x26[45]|h\.?26[45]|hevc|avc|aac\d?(?:\.\d)?|ac3|dts|ddp?\d?(?:\.\d)?|atmos|bluray|blu-ray|brrip|bdrip|webrip|web[- ]?dl|dvdrip|dvd|hdtv|remux|proper|repack|remaster(?:ed)?|uncut|unrated|extended|director'?s cut|dual[- ]?audio|multi[- ]?subs?|subbed|dubbed|dub|eng(?:lish)?|jpn|10bit|8bit|yts|yify|rarbg|eztv|ettv|nf|amzn|dsnp|hmax)\b/gi;
// Names from folders / torrents carry release junk ("S01-S06", "1080p", "x265") — search without it.
function lookupName(s) {
  return String(s || '')
    .replace(/\.(mkv|mp4|m4v|avi|mov|wmv|webm|ts|m2ts|mpg|mpeg|flv|ogv)$/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/\bWEB\b/g, ' ') // "WEB" in capitals is a release tag ("Charlotte's Web" stays)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?!(19|20)\d{2}\))[^)]*\)/g, ' ') // brackets go, except a "(1999)"
    .replace(JUNK, ' ')
    .replace(/\s*-\s*[A-Z0-9]{2,12}$/, (m) => (/(19|20)\d{2}$/.test(m) ? m : ' ')) // "-GROUP" at the end (all caps)
    .replace(/\s{2,}/g, ' ').replace(/[\s\-–—,:]+$/, '').trim();
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/^(the|a|an) /, '').replace(/[^a-z0-9]+/g, '');
const words = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !['the', 'a', 'an', 'and', 'of'].includes(w));
// A plausible release year (1900 .. next year): "Blade Runner 2049" has no year in it.
const YEAR_MAX = new Date().getFullYear() + 1;
const yearOf = (s) => { for (const m of String(s || '').matchAll(/(?:^|[^0-9])((?:19|20)\d{2})(?=[^0-9p]|$)/g)) if (+m[1] <= YEAR_MAX && m.index > 0) return +m[1]; return null; };

// The ways a name gets tried, best first.
function variants(raw) {
  const out = [];
  const add = (v) => { v = String(v || '').replace(/\s{2,}/g, ' ').replace(/^[\s\-–—:,]+|[\s\-–—:,]+$/g, '').trim(); if (v.length > 1 && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v); };
  const base = lookupName(raw) || String(raw || '').trim();
  const y = yearOf(base);
  const noYear = (y ? base.replace(new RegExp('\\(?\\b' + y + '\\b\\)?', 'g'), ' ') : base).replace(/\s{2,}/g, ' ').trim() || base;
  add(noYear); add(base);
  add(noYear.replace(/([a-z])([A-Z])/g, '$1 $2')); // "FamilyGuy"
  add(noYear.replace(/\s+\(?(us|uk|au|ca|nz)\)?$/i, ''));
  add(noYear.replace(/'/g, ''));
  add(noYear.replace(/\band\b/gi, '&')); add(noYear.replace(/&/g, 'and'));
  if (/^the /i.test(noYear)) add(noYear.replace(/^the /i, '')); else add('The ' + noYear);
  for (const sep of [':', ' - ', ' – ', ' — ']) if (noYear.includes(sep)) add(noYear.split(sep)[0]);
  add(noYear.split(/\s+aka\s+/i)[0]);
  add(noYear.replace(/\s+(part|vol(?:ume)?|chapter)\s*\d+$/i, ''));
  add(noYear.replace(/\s+\d+$/, '')); // "Show 2" -> "Show" (last; sequels keep their number above)
  return out.slice(0, 8);
}

// How alike two names are, 0..1 (word overlap + letter pairs, exact = 1).
function similar(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const pairs = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const p = s.slice(i, i + 2); m.set(p, (m.get(p) || 0) + 1); } return m; };
  const pa = pairs(na), pb = pairs(nb);
  let hit = 0; for (const [p, n] of pa) hit += Math.min(n, pb.get(p) || 0);
  const dice = (2 * hit) / Math.max(1, na.length - 1 + nb.length - 1);
  const wa = words(a), wb = new Set(words(b));
  const tok = wa.length && wb.size ? (2 * wa.filter((w) => wb.has(w)).length) / (wa.length + wb.size) : 0;
  let s = Math.max(dice, tok) * 0.97;
  if (na.length > 3 && nb.length > 3 && (nb.startsWith(na) || na.startsWith(nb))) s = Math.max(s, 0.8 * Math.min(na.length, nb.length) / Math.max(na.length, nb.length) + 0.15);
  return Math.min(0.99, s);
}

// ---- genres -> HomeCable's tags ----
const GENRE_MAP = {
  'science-fiction': ['Science fiction'], 'sci-fi & fantasy': ['Science fiction', 'Fantasy'], 'science fiction': ['Science fiction'], 'sci-fi': ['Science fiction'],
  'action & adventure': ['Action', 'Adventure'], 'kids & family': ['Family', 'Kids'], children: ['Kids'], kids: ['Kids'], 'reality tv': ['Reality'], reality: ['Reality'],
  'talk show': ['Talk show'], 'game show': ['Game show'], 'game-show': ['Game show'], news: ['News'], sports: ['Sports'], 'music feature films': ['Musical'], music: ['Musical'],
  'concert films': ['Musical'], classics: ['Classic'], independent: ['Indie'], foreign: ['Foreign'], holiday: ['Holiday'], history: ['History'], biography: ['Biography'],
  'comedy': ['Comedy'], 'drama': ['Drama'], 'animation': ['Animation'], 'anime': ['Anime', 'Animation'], 'horror': ['Horror'], 'thriller': ['Thriller'], 'suspense': ['Thriller'],
  'romance': ['Romance'], 'documentary': ['Documentary'], 'western': ['Western'], 'crime': ['Crime'], 'mystery': ['Mystery'], 'fantasy': ['Fantasy'], 'adventure': ['Adventure'],
  'action': ['Action'], 'family': ['Family'], 'war': ['War'], 'supernatural': ['Fantasy'], 'espionage': ['Thriller'], 'musical': ['Musical'], 'superhero': ['Superhero'],
  'young adult': ['Teen'], 'teens': ['Teen'], 'soap': ['Soap'],
};
function mapGenres(list) {
  const out = [];
  for (const g of list || []) for (const t of GENRE_MAP[String(g).toLowerCase().trim()] || [String(g).trim()]) if (t && !out.includes(t)) out.push(t);
  return out.filter((g) => !/^(tv shows?|movies?|scripted|all)$/i.test(g));
}

// ---- sources ----
// Each returns [{ source, kind, name, year, poster, posterSmall, genres, summary, rank, ...extra }]
async function tvmaze(name) {
  const j = await getJson('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(name));
  return (j || []).slice(0, 8).map((x, i) => {
    const s = x.show || {};
    const g = [...(s.genres || [])];
    if (s.type === 'Animation') g.push('Animation');
    if (s.type === 'Animation' && s.language === 'Japanese') g.unshift('Anime');
    if (s.type === 'Reality') g.push('Reality');
    if (s.type === 'Talk Show') g.push('Talk show');
    if (s.type === 'Game Show') g.push('Game show');
    if (s.type === 'News') g.push('News');
    if (s.type === 'Documentary') g.push('Documentary');
    if (s.type === 'Animation' && s.language !== 'Japanese') g.push('Cartoon');
    return {
      source: 'TVmaze', kind: 'show', name: s.name, year: +(s.premiered || '').slice(0, 4) || null, rank: i, apiScore: x.score,
      poster: s.image?.original || s.image?.medium || null, posterSmall: s.image?.medium || null,
      genres: mapGenres(g), summary: (s.summary || '').replace(/<[^>]+>/g, '').slice(0, 500),
      tvmazeId: s.id, type: s.type, language: s.language || null, network: s.network?.name || s.webChannel?.name || null, premiered: s.premiered || null,
      weight: s.weight || 0,
    };
  });
}
const big = (u) => (u ? u.replace(/\/\d+x\d+bb\./, '/600x600bb.') : null);
async function itunes(name, kind) {
  const p = kind === 'show' ? { media: 'tvShow', entity: 'tvSeason' } : { media: 'movie', entity: 'movie' };
  const j = await getJson('https://itunes.apple.com/search?' + new URLSearchParams({ term: name, ...p, limit: '15', country: 'US' }));
  const out = [];
  for (const [i, r] of (j?.results || []).entries()) {
    const nm = kind === 'show' ? r.artistName || String(r.collectionName || '').replace(/,\s*(season|series|vol\.?)\s*\d+.*$/i, '') : r.trackName;
    if (!nm) continue;
    const season = kind === 'show' ? +(String(r.collectionName || '').match(/season\s*(\d+)/i)?.[1] || 0) || null : null;
    out.push({
      source: 'iTunes', kind, name: nm, year: +(r.releaseDate || '').slice(0, 4) || null, rank: i, season,
      poster: big(r.artworkUrl100 || r.artworkUrl60), posterSmall: r.artworkUrl100 || null,
      genres: mapGenres([r.primaryGenreName]), summary: String(r.longDescription || r.description || '').slice(0, 500),
      label: kind === 'show' ? r.collectionName : null,
    });
  }
  return out;
}
// IMDb's public title suggestions (what its search box uses): shows AND movies, with posters
// and years — the widest net. No genres, so the others confirm it and supply those.
const IMDB_KIND = (q) => (/tv (series|mini-?series)|tv special|podcast series/i.test(q || '') ? 'show' : /feature|movie|short|tv movie|video/i.test(q || '') ? 'movie' : null);
async function imdb(name) {
  const s = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  const j = await getJson(`https://v2.sg.media-imdb.com/suggestion/${s[0]}/${encodeURIComponent(s)}.json`);
  return (j?.d || []).filter((x) => /^tt/.test(x.id || '') && IMDB_KIND(x.q)).slice(0, 8).map((x, i) => {
    const img = x.i?.imageUrl || null;
    const sized = img ? img.replace(/\._V1_.*\.jpg$/, '._V1_QL80_UX600_.jpg') : null;
    const kind = IMDB_KIND(x.q);
    const g = [];
    if (/short/i.test(x.q)) g.push('Short film');
    if (/mini-?series/i.test(x.q)) g.push('Miniseries');
    return { source: 'IMDb', kind, name: x.l, year: x.y || null, rank: i, poster: sized, posterSmall: sized, genres: g, summary: '', imdbId: x.id, cast: x.s || '' };
  });
}

// Film genres, read from how Wikipedia describes it ("2001 Japanese animated fantasy film").
const GENRE_WORDS = [
  ['Animation', /\banimat(ed|ion)\b/i], ['Science fiction', /\bscience[ -]fiction|\bsci[ -]fi\b/i], ['Horror', /\bhorror\b/i],
  ['Comedy', /\bcomedy\b|\bsitcom\b/i], ['Drama', /\bdrama\b/i], ['Action', /\baction\b/i], ['Fantasy', /\bfantasy\b/i],
  ['Thriller', /\bthriller\b/i], ['Romance', /\bromance\b|\bromantic\b/i], ['Documentary', /\bdocumentary\b/i],
  ['Crime', /\bcrime\b|\bheist\b/i], ['Western', /\bwestern\b/i], ['Adventure', /\badventure\b/i], ['Mystery', /\bmystery\b/i],
  ['Musical', /\bmusical\b/i], ['Family', /\bfamily film|children's (film|television|series)/i], ['War', /\bwar film/i], ['Superhero', /\bsuperhero\b/i],
  ['Sitcom', /\bsitcom\b/i], ['Adult animation', /\badult animated\b/i], ['Kids', /\bchildren's\b/i], ['Miniseries', /\bminiseries\b/i],
  ['Reality', /\breality (television|tv|show|series)\b/i], ['Biography', /\bbiographical\b/i], ['History', /\bhistorical\b/i], ['Short film', /\bshort film\b/i],
];
function genresFromText(text) {
  const out = GENRE_WORDS.filter(([, re]) => re.test(text)).map(([g]) => g);
  if (out.includes('Animation') && /japanese/i.test(text)) out.unshift('Anime');
  return out;
}

const WIKI_SHOW =/television series|tv series|sitcom|animated series|web series|anime|miniseries|television program|soap opera|talk show|game show|reality (tv|television|show)/i;
const WIKI_FILM = /\bfilm\b|\bmovie\b|animated feature/i;
async function wikiPage(title, kind) {
  const j = await getJson('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g, '_')), 8000).catch(() => null); // 429 on a guessed title just means "try the next one"
  if (!j || j.type !== 'standard') return null;
  const d = `${j.description || ''} ${String(j.extract || '').slice(0, 300)}`;
  if (!(kind === 'show' ? WIKI_SHOW : WIKI_FILM).test(d)) return null;
  const img = j.originalimage?.source || j.thumbnail?.source || null;
  const o = j.originalimage;
  const poster = img && (o && o.width <= 1000 ? o.source : (j.thumbnail?.source || img).replace(/\/\d+px-/, '/500px-'));
  return {
    source: 'Wikipedia', kind, name: j.title.replace(/\s*\((\d{4} )?(film|movie|(American |British |Japanese |Canadian |animated )*(TV|television|web|animated) (series|program|sitcom)|miniseries|anime)\)\s*$/i, ''),
    year: yearOf(j.description) || yearOf(String(j.extract || '').slice(0, 200)), rank: 0, poster, posterSmall: j.thumbnail?.source || poster,
    genres: genresFromText(d), summary: String(j.extract || '').slice(0, 500), label: [j.title, j.description].filter(Boolean).join(' — '),
  };
}
async function wikipedia(name, kind, year) {
  const pages = kind === 'show'
    ? [name, `${name} (TV series)`, `${name} (American TV series)`, `${name} (animated series)`]
    : [name, ...(year ? [`${name} (${year} film)`] : []), `${name} (film)`];
  const out = [];
  for (const p of pages) { const r = await wikiPage(p, kind); if (r && !out.some((x) => x.name === r.name && x.poster === r.poster)) out.push(r); if (out.length && similar(out[0].name, name) > 0.9) break; }
  if (out.length < 2) {
    const s = await getJson('https://en.wikipedia.org/w/rest.php/v1/search/page?' + new URLSearchParams({ q: `${name} ${year || ''} ${kind === 'show' ? 'TV series' : 'film'}`.replace(/\s+/g, ' ').trim(), limit: '6' })).catch(() => null);
    for (const pg of (s?.pages || []).slice(0, 5)) {
      const r = await wikiPage(pg.title, kind).catch(() => null);
      if (r && !out.some((x) => x.name === r.name && x.poster === r.poster)) out.push({ ...r, rank: out.length });
    }
  }
  return out;
}

// ---- tags beyond genres: what it's about (from the summary), its format, its era ----
const KEYWORD_TAGS = [
  ['Police', /\b(police|cops?|detectives?|sheriff'?s?|deputies|precinct|lapd|nypd)\b/i], ['Crime', /\b(crime|criminal|gangsters?|mafia|mob boss|heist)\b/i],
  ['Zombies', /\bzombies?\b/i], ['Vampires', /\bvampires?\b/i], ['Monsters', /\bmonsters?\b|\bkaiju\b/i], ['Ghosts', /\bghosts?\b|\bhaunt/i],
  ['Space', /\b(outer space|spaceship|starship|galaxy|galactic|astronauts?|space station)\b/i], ['Aliens', /\baliens?\b|extraterrestrial/i],
  ['Superhero', /\bsuper-?heroe?s?\b|\bsuperpowers?\b/i], ['Spy', /\b(spy|spies|espionage|secret agent|cia|mi6)\b/i],
  ['Martial arts', /martial arts|kung fu|karate|samurai|ninjas?/i], ['Time travel', /time travel/i], ['Post-apocalyptic', /post-apocalyptic|apocalyp/i],
  ['Mockumentary', /mockumentary/i], ['Parody', /\bparod(y|ies)\b|\bspoofs?\b/i], ['Satire', /\bsatir/i], ['Dark comedy', /black comedy|dark comedy/i],
  ['Coming of age', /coming[- ]of[- ]age/i], ['Medical', /\b(hospital|surgeons?|medical drama|paramedics?)\b/i], ['Legal', /\b(lawyers?|attorneys?|courtroom|legal drama)\b/i],
  ['Political', /\bpolitic(al|s)\b/i], ['Military', /\b(military|soldiers?|army|marines|navy seals?)\b/i], ['Sports', /\b(football|basketball|baseball|soccer|boxing|wrestling|hockey|olympic)\b/i],
  ['Stand-up', /stand-?up comed/i], ['Christmas', /\bchristmas\b|\bsanta\b/i], ['Halloween', /\bhalloween\b/i], ['Teen', /\bteen(age|agers?)?\b|high school/i],
  ['Kids', /\bchildren'?s (series|programme|program|television|film)\b|\bpreschool/i], ['Workplace', /\b(workplace|office|employees|coworkers)\b/i],
  ['Family', /\bfamily (film|sitcom|comedy|drama)\b/i], ['Fairy tale', /fairy tale|fairytale|princess/i], ['Dinosaurs', /dinosaur/i], ['Robots', /\brobots?\b|\bandroids?\b|\bmecha\b/i],
  ['Pirates', /\bpirates?\b/i], ['Magic', /\bmagic(al)?\b|\bwizards?\b|\bwitch(es)?\b|\bsorcer/i], ['Survival', /\bsurviv(al|e|ors?)\b/i], ['Prison', /\bprison\b|\binmates?\b/i],
  ['Road trip', /road trip/i], ['Cars', /\b(racing|race car|street racing|cars)\b/i], ['Music', /\b(band|singer|musicians?|rock star|rapper)\b/i], ['Food', /\b(cooking|chef|restaurant|baking)\b/i],
  ['True story', /based on (a )?true|true story|real[- ]life/i], ['Based on a book', /based on (the )?(novel|book)/i], ['Based on a comic', /based on (the )?(comic|manga|graphic novel)/i],
  ['Remake', /\bremake\b/i], ['Reboot', /\breboot\b/i], ['Sequel', /\bsequel\b/i], ['Prequel', /\bprequel\b/i], ['Spin-off', /spin-?off/i],
];
const ADULT_TOON = /adult swim|comedy central|fxx|\bfx\b|fox|netflix|hulu|mtv|cartoon network/i;
// Tags that describe it, best first: genres (from the sources), what it's about (summary),
// then its format and era. `auto` = the ones safe to apply by themselves.
function suggestTags(m, name = '') {
  const g = [...(m.genres || [])];
  const text = `${m.summary || ''}`;
  const about = KEYWORD_TAGS.filter(([, re]) => re.test(text)).map(([t]) => t).slice(0, 6);
  const anim = g.includes('Animation');
  if (anim && g.includes('Comedy') && !g.includes('Kids') && !g.includes('Anime') && ADULT_TOON.test(m.network || '') && m.kind === 'show') about.push('Adult animation');
  if (m.kind === 'show' && g.includes('Comedy') && !g.includes('Sitcom') && (m.type === 'Scripted' || m.type === 'Animation' || /sitcom/i.test(text))) about.push('Sitcom');
  const fmt = [];
  fmt.push(m.kind === 'show' ? 'TV show' : 'Movie');
  if (g.includes('Anime')) fmt.push(m.kind === 'show' ? 'Anime series' : 'Anime movie');
  else if (anim && m.kind === 'movie') fmt.push('Animated movie');
  if (!anim && !g.includes('Documentary')) fmt.push('Live action');
  if (/\b(ova|oad)\b/i.test(name)) fmt.push('OVA');
  if (/\bona\b/i.test(name)) fmt.push('ONA');
  if (/\bspecial\b/i.test(name)) fmt.push('Special');
  if (/miniseries|mini-series|limited series/i.test(text) || g.includes('Miniseries')) fmt.push('Miniseries');
  if (g.includes('Short film')) fmt.push('Short film');
  if (/web series/i.test(text)) fmt.push('Web series');
  if (g.includes('Documentary') && m.kind === 'show') fmt.push('Docuseries');
  const era = m.year ? [`${String(m.year).slice(0, 3)}0s`] : [];
  if (m.year && m.year < 1975) era.push('Classic');
  // A comedy filed as a documentary is a mockumentary (Reno 911!, The Office).
  if (g.includes('Comedy') && g.includes('Documentary')) { g.splice(g.indexOf('Documentary'), 1); about.unshift('Mockumentary'); fmt.splice(fmt.indexOf('Docuseries') >>> 0, fmt.includes('Docuseries') ? 1 : 0); }
  const out = [...new Set([...g, ...about, ...fmt, ...era])];
  // Summary words are only suggested for these (a summary mentioning a teenager doesn't make a teen show).
  const MAYBE = new Set(['Teen', 'Workplace', 'Music', 'Survival', 'Magic', 'Cars', 'Food', 'Military', 'Political', 'Family', 'Prison', 'Road trip', 'Ghosts', 'Monsters']);
  const auto = [...new Set([...g, ...about.filter((t) => !MAYBE.has(t))])];
  return { all: out, auto };
}

// ---- tags from names alone (locked videos: nothing is looked up online) ----
// The adult words only ever apply inside the locked section (opts.adult).
const ADULT_WORDS = [
  ['Amateur', /\bamateur|homemade|home ?made\b/i], ['Professional', /\bstudio|professional|brazzers|vixen|blacked|tushy|reality ?kings|bangbros|naughty ?america|digital ?playground\b/i],
  ['Solo', /\bsolo\b/i], ['Couple', /\bcouples?\b/i], ['Threesome', /\bthreesome|3some|ffm|mmf\b/i], ['Group', /\bgroup|orgy|gangbang\b/i],
  ['Lesbian', /\blesbian|girl ?on ?girl|\bgg\b/i], ['Gay', /\bgay\b/i], ['Trans', /\btrans|tgirl|shemale\b/i], ['Straight', /\bstraight\b/i],
  ['MILF', /\bmilf|cougar\b/i], ['Mature', /\bmature|gilf\b/i], ['Teen (18+)', /\b(18|19) ?(yo|year)|\bteen\b/i], ['College', /\bcollege|dorm\b/i],
  ['POV', /\bpov\b/i], ['Compilation', /\bcompilation|\bcompil|\bpmv\b|\bbest of\b/i], ['Softcore', /\bsoftcore|erotic|sensual\b/i], ['Hardcore', /\bhardcore\b/i],
  ['Romantic', /\bromantic|passionate|lovemaking\b/i], ['Massage', /\bmassage\b/i], ['Outdoor', /\boutdoors?|public|beach\b/i], ['Shower', /\bshower|bath\b/i],
  ['BDSM', /\bbdsm|bondage|domina|submissive|spank/i], ['Fetish', /\bfetish|feet|foot|latex|leather|stockings|nylon/i], ['Roleplay', /\broleplay|role ?play|step ?(sis|mom|bro|dad)|nurse|teacher|maid/i],
  ['Cosplay', /\bcosplay\b/i], ['Hentai', /\bhentai\b/i], ['Cartoon (adult)', /\bcartoon|animated|3d ?anim|\bsfm\b/i], ['Vintage', /\bvintage|retro\b/i],
  ['VR', /\bvr\b|180x180|\b3dh\b|\bsbs\b/i], ['4K', /\b2160p|\b4k\b|\buhd\b/i], ['Webcam', /\bcam(girl|show)?\b|webcam|onlyfans/i], ['Interview', /\binterview|casting\b/i],
  ['Big cast', /\bparty\b/i], ['Behind the scenes', /\bbts\b|behind the scenes/i], ['JAV', /\bjav\b|\b[a-z]{2,5}-\d{3,4}\b/i],
];
function localTags(text, { adult = false } = {}) {
  const t = String(text || '').replace(/[._]+/g, ' ');
  const out = [];
  for (const [g, re] of GENRE_WORDS) if (re.test(t)) out.push(g);
  for (const [g, re] of KEYWORD_TAGS) if (re.test(t) && !out.includes(g)) out.push(g);
  if (adult) for (const [g, re] of ADULT_WORDS) if (re.test(t) && !out.includes(g)) out.push(g);
  if (adult && !out.includes('Adult')) out.unshift('Adult');
  const y = yearOf(t);
  if (y) out.push(`${String(y).slice(0, 3)}0s`);
  return out.slice(0, 14);
}

// ---- putting it together ----
function scoreOne(c, names, year, kind) {
  let s = Math.max(...names.map((n) => similar(n, c.name)));
  if (year && c.year) s += Math.abs(c.year - year) <= 1 ? 0.12 : -0.12;
  if (kind && c.kind && kind !== 'auto' && c.kind !== kind) s -= 0.25;
  s -= Math.min(0.08, (c.rank || 0) * 0.015);
  if (c.source === 'TVmaze' && c.weight) s += Math.min(0.04, c.weight / 2500);
  if (!c.poster) s -= 0.05;
  return s;
}
const cache = new Map(); // key -> { at, p }
const TTL = 30 * 60e3;
// q: { name, kind: 'show' | 'movie' | 'auto', year? }
// -> { best: match | null, matches: [match], images: [{ url, name, label, source, best }] }
//    match: { name, year, kind, poster, genres, summary, sources: [..], score, confidence, tvmazeId?, ... }
function identify(q) {
  const key = JSON.stringify([q.kind, norm(q.name), q.year || null]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const p = run(q).catch((e) => { cache.delete(key); throw e; });
  cache.set(key, { at: Date.now(), p });
  return p;
}
async function run({ name, kind = 'auto', year = null }) {
  year = year || yearOf(name);
  const names = variants(name);
  if (!names.length) return { best: null, matches: [], images: [] };
  const kinds = kind === 'auto' ? ['show', 'movie'] : [kind];
  const found = [];
  let errors = 0, tries = 0;
  const ask = async (fn) => { tries++; try { found.push(...((await fn()) || [])); } catch (e) { errors++; if (e.status === 429) await new Promise((r) => setTimeout(r, 1500)); } };
  const goodEnough = () => found.some((c) => scoreOne(c, names, year, kind) >= 0.9) && new Set(found.filter((c) => scoreOne(c, names, year, kind) >= 0.85).map((c) => c.source)).size >= 2;
  for (const [i, v] of names.entries()) {
    const jobs = [];
    if (i < 4) jobs.push(ask(() => imdb(v).then((r) => (kind === 'auto' ? r : r.filter((c) => c.kind === kind)))));
    for (const k of kinds) {
      if (k === 'show') jobs.push(ask(() => tvmaze(v)));
      if (k === 'show') jobs.push(ask(() => itunes(v, k))); // Apple's movie search no longer answers
      if (i < 2) jobs.push(ask(() => wikipedia(v, k, year)));
    }
    await Promise.all(jobs);
    if (goodEnough()) break;
    // Not sure yet: keep trying the other spellings (never give up after one miss).
    if (i >= 2 && found.some((c) => scoreOne(c, names, year, kind) >= 0.95)) break;
  }
  if (!found.length && errors && errors === tries) throw Object.assign(new Error('offline'), { offline: true });
  // Test the front-runner against the other sources by ITS proper name ("Avatar: The Way of
  // Water", "Charlotte's Web") — that's where genres, the summary and second opinions come from.
  const lead = [...found].sort((a, b) => scoreOne(b, names, year, kind) - scoreOne(a, names, year, kind))[0];
  if (lead && !names.some((n) => n.toLowerCase() === lead.name.toLowerCase())) {
    names.push(lead.name);
    const k = lead.kind;
    await Promise.all([
      ask(() => wikipedia(lead.name, k, lead.year || year)),
      ...(k === 'show' ? [ask(() => tvmaze(lead.name)), ask(() => itunes(lead.name, 'show'))] : []),
    ]);
  } else if (lead && !found.some((c) => c.source !== lead.source && norm(c.name) === norm(lead.name))) {
    await ask(() => wikipedia(lead.name, lead.kind, lead.year || year));
  }
  // Group answers that are the same title (same name, near-same year), across sources.
  const groups = [];
  for (const c of found) {
    c.score = scoreOne(c, names, year, kind);
    const g = groups.find((x) => x.kind === c.kind && norm(x.name) === norm(c.name) && !(c.source === 'IMDb' && x.items.some((o) => o.source === 'IMDb' && o.imdbId !== c.imdbId)) && (!x.year || !c.year || Math.abs(x.year - c.year) <= 2 || c.kind === 'show'));
    if (g) g.items.push(c); else groups.push({ kind: c.kind, name: c.name, year: c.year, items: [c] });
  }
  const order = { TVmaze: 0, IMDb: 1, Wikipedia: 2, iTunes: 3 };
  const matches = groups.map((g) => {
    const srcs = [...new Set(g.items.map((c) => c.source))];
    const top = Math.max(...g.items.map((c) => c.score));
    const score = top + 0.08 * (srcs.length - 1);
    const by = (f) => g.items.filter((c) => c[f]?.length || (c[f] && typeof c[f] !== 'object')).sort((a, b) => b.score - a.score || order[a.source] - order[b.source]);
    const tv = g.items.filter((c) => c.source === 'TVmaze').sort((a, b) => b.score - a.score)[0];
    // Genres: from every source that agrees (TVmaze's are the most precise for shows).
    const genres = [];
    for (const c of g.items.sort((a, b) => order[a.source] - order[b.source])) for (const t of c.genres || []) if (!genres.includes(t)) genres.push(t);
    const posters = [];
    // Show posters: TVmaze's poster, then the show's (not a season's) art, then seasons.
    for (const c of [...g.items].sort((a, b) => order[a.source] - order[b.source] || (a.season || 0) - (b.season || 0) || b.score - a.score)) if (c.poster && !posters.some((p) => p.url === c.poster)) posters.push({ url: c.poster, source: c.source, label: c.label || [c.name, c.year].filter(Boolean).join(' · ') });
    return {
      kind: g.kind, name: tv?.name || by('name')[0]?.name || g.name, year: Math.min(...g.items.map((c) => c.year || 9999)) === 9999 ? null : Math.min(...g.items.map((c) => c.year || 9999)),
      poster: posters[0]?.url || null, posters, genres, summary: (by('summary')[0] || {}).summary || '', sources: srcs, score,
      confidence: score >= 0.95 ? 'sure' : score >= 0.8 ? 'likely' : score >= 0.6 ? 'maybe' : 'guess',
      tvmazeId: tv?.tvmazeId || null, type: tv?.type || null, language: tv?.language || null, network: tv?.network || null, premiered: tv?.premiered || null,
    };
  }).sort((a, b) => b.score - a.score);
  // Always the most probable answer (its confidence says how sure) — never nothing when anything was found.
  const best = matches[0] || null;
  if (best) { const t = suggestTags(best, name); best.tags = t.all; best.autoTags = t.auto; }
  // Pictures: the best match's first, then each runner-up's best one, then the rest.
  const images = [], seen = new Set();
  const push = (m, p, isBest) => { if (!p?.url || seen.has(p.url)) return; seen.add(p.url); images.push({ url: p.url, name: m.name, source: p.source, best: !!isBest, label: `${[m.name, m.year].filter(Boolean).join(' · ')} — ${p.source}`, sure: m.confidence }); };
  if (best) best.posters.slice(0, 1).forEach((p) => push(best, p, true));
  for (const m of matches.slice(0, 8)) m.posters.slice(0, 1).forEach((p) => push(m, p));
  for (const m of matches.slice(0, 8)) m.posters.slice(1, 4).forEach((p) => push(m, p));
  return { best, matches: matches.slice(0, 12), images: images.slice(0, 24), tried: names };
}

module.exports = { identify, variants, lookupName, similar, mapGenres, norm, yearOf, genresFromText, suggestTags, localTags };
