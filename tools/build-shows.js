// Builds the TV and anime index that ships with HomeCable, from Wikidata (its data is CC0, free to
// reuse), in the same way as tools/build-catalog.js.
//   node tools/build-shows.js     → src/main/data/shows.json.gz
// Each row: [title, year, imdbId, popularity, [genres], wikidataId, 'tv'|'anime', aniListId, malId,
// format]. Popularity is how many Wikipedia languages cover it. Facts only: no streams, links or
// torrents. Episodes, seasons and watch order are looked up when you open a title.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'src', 'main', 'data', 'shows.json.gz');
const UA = 'HomeCable catalog builder (open-source media player; https://github.com/OrionVW42/homecable)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TV_MIN = 8, ANIME_MIN = 3;

const SETS = [
  // Anime first, so a title that's both is only ever anime.
  { kind: 'anime', format: 'TV', cls: ['Q63952888'], min: ANIME_MIN },
  { kind: 'anime', format: 'MOVIE', cls: ['Q20650540'], min: ANIME_MIN },
  { kind: 'anime', format: 'OVA', cls: ['Q220898'], min: ANIME_MIN },
  { kind: 'tv', format: 'TV', cls: ['Q5398426', 'Q581714', 'Q1259759', 'Q15416'], min: TV_MIN },
];
// Split up so each answer fits inside Wikidata's time limit.
const BANDS = [[TV_MIN, 9], [10, 11], [12, 14], [15, 19], [20, 29], [30, 49], [50, 9999]];

const query = (s, lo, hi) => `SELECT ?f ?fLabel ?imdb ?ani ?mal ?sl (MIN(?d) AS ?date) (GROUP_CONCAT(DISTINCT ?gl;separator='|') AS ?genres) WHERE {
  VALUES ?c { ${s.cls.map((c) => 'wd:' + c).join(' ')} } ?f wdt:P31 ?c; wikibase:sitelinks ?sl. FILTER(?sl >= ${lo} && ?sl <= ${hi})
  OPTIONAL { ?f wdt:P580 ?d } OPTIONAL { ?f wdt:P577 ?d }
  OPTIONAL { ?f wdt:P345 ?imdb } OPTIONAL { ?f wdt:P8729 ?ani } OPTIONAL { ?f wdt:P4086 ?mal }
  OPTIONAL { ?f wdt:P136 ?g. ?g rdfs:label ?gl. FILTER(LANG(?gl)='en') }
  SERVICE wikibase:label { bd:serviceParam wikibase:language 'en,mul'. }
} GROUP BY ?f ?fLabel ?imdb ?ani ?mal ?sl`;

const NICE = { 'science fiction': 'Science fiction', 'sci-fi': 'Science fiction', sitcom: 'Comedy', 'situation comedy': 'Comedy', animated: 'Animation', animation: 'Animation', cartoon: 'Animation', superhero: 'Superhero', historical: 'History', 'period drama': 'History', teen: 'Teen', "children's": 'Kids', preschool: 'Kids', medical: 'Medical', legal: 'Legal', 'police procedural': 'Crime', procedural: 'Crime', reality: 'Reality', 'game show': 'Game show', 'talk show': 'Talk show', 'soap opera': 'Soap', telenovela: 'Soap', news: 'News', anthology: 'Anthology', spy: 'Spy', sports: 'Sports', war: 'War', western: 'Western', musical: 'Musical', horror: 'Horror', comedy: 'Comedy', drama: 'Drama', action: 'Action', adventure: 'Adventure', fantasy: 'Fantasy', thriller: 'Thriller', mystery: 'Mystery', crime: 'Crime', romance: 'Romance', romantic: 'Romance', documentary: 'Documentary', family: 'Family', political: 'Political', satire: 'Satire', parody: 'Parody', zombie: 'Zombies', vampire: 'Vampires', supernatural: 'Supernatural', dystopia: 'Dystopia', 'post-apocalyptic': 'Dystopia',
  // Anime's own
  'shōnen': 'Shounen', shonen: 'Shounen', shounen: 'Shounen', 'shōjo': 'Shoujo', shojo: 'Shoujo', shoujo: 'Shoujo', seinen: 'Seinen', josei: 'Josei', isekai: 'Isekai', mecha: 'Mecha', 'slice of life': 'Slice of life', 'magical girl': 'Magical girl', harem: 'Harem', 'martial arts': 'Martial arts', psychological: 'Psychological', music: 'Music', school: 'School' };
function genres(raw) {
  const out = new Set();
  for (const g of String(raw || '').toLowerCase().split('|')) {
    const k = g.replace(/\b(television|tv|series|show|program|programme|film|films|anime|manga|genre|fiction)\b/g, '').replace(/\s+/g, ' ').trim();
    if (NICE[k]) out.add(NICE[k]);
    else for (const word of Object.keys(NICE)) if (k.includes(word) && word.length > 4) { out.add(NICE[word]); break; }
  }
  return [...out].slice(0, 6);
}
// Never in the index.
const skip = (raw) => /hentai|pornograph|\badult (film|animation|video)|erotic|\becchi\b/i.test(String(raw || ''));

async function ask(q, name) {
  for (let tries = 0; tries < 6; tries++) {
    try {
      const r = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), { signal: AbortSignal.timeout(90000), headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' } });
      if (r.ok) return JSON.parse(await r.text()).results.bindings;
      console.log(name, 'answered', r.status, '— waiting');
      await sleep((+r.headers.get('retry-after') || 30) * 1000);
    } catch (e) { console.log(name, e.name, '— waiting'); await sleep(20000); }
  }
  throw new Error('gave up on ' + name);
}

(async () => {
  const rows = new Map();
  for (const s of SETS) {
    const bands = s.kind === 'anime' ? [[ANIME_MIN, 9999]] : BANDS;
    for (const [lo, hi] of bands) {
      const got = await ask(query(s, lo, hi), `${s.kind}/${s.format} ${lo}-${hi}`);
      for (const b of got) {
        const title = b.fLabel?.value || '', qid = b.f.value.split('/').pop();
        if (!title || /^Q\d+$/.test(title) || skip(b.genres?.value)) continue;
        if (s.kind === 'tv' && /\banime\b/i.test(b.genres?.value || '')) continue; // tagged anime but not filed as it
        if (rows.has(qid)) continue; // anime came first, and a repeat adds nothing
        const year = b.date?.value ? +b.date.value.slice(0, 4) : 0;
        if (!year) continue;
        const imdb = /^tt\d+$/.test(b.imdb?.value || '') ? b.imdb.value : null;
        const g = genres(b.genres?.value);
        if (s.kind === 'anime' && !g.includes('Animation')) g.push('Animation');
        rows.set(qid, [title, year, imdb, +b.sl.value || 0, g, qid, s.kind, +b.ani?.value || null, +b.mal?.value || null, s.format]);
      }
      console.log(s.kind, s.format, lo, hi, got.length, 'found, total', rows.size);
      await sleep(1500);
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const list = [...rows.values()].sort((a, b) => b[3] - a[3] || b[1] - a[1]);
  fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(list), { level: 9 }));
  const n = (f) => list.filter(f).length;
  console.log('DONE', n((r) => r[6] === 'tv'), 'tv,', n((r) => r[6] === 'anime'), 'anime,', n((r) => r[7]), 'with AniList,', n((r) => r[8]), 'with MAL,', n((r) => r[2]), 'with IMDb,', (fs.statSync(OUT).size / 1e6).toFixed(2), 'MB');
})().catch((e) => { console.error(e); process.exit(1); });
