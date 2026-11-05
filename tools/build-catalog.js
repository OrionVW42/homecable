// Builds the movie index that ships with HomeCable: American films from 1950 on, from
// Wikidata (its data is CC0, free to reuse). One polite query a year, in order.
//   node tools/build-catalog.js     → src/main/data/movies.json.gz
// Each row: [title, year, imdbId, popularity, [genres], wikidataId]. Popularity is how many
// Wikipedia languages cover the film. Facts only: no streams, links or torrents.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'src', 'main', 'data', 'movies.json.gz');
const UA = 'HomeCable catalog builder (open-source media player; https://github.com/OrionVW42/homecable)';
const FIRST = 1950, LAST = new Date().getFullYear();
const MIN_POP = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const query = (y) => `SELECT ?f ?fLabel ?imdb ?sl (MIN(?d) AS ?date) (GROUP_CONCAT(DISTINCT ?gl;separator='|') AS ?genres) WHERE {
  ?f wdt:P31/wdt:P279* wd:Q11424; wdt:P495 wd:Q30; wdt:P577 ?d; wikibase:sitelinks ?sl.
  OPTIONAL { ?f wdt:P345 ?imdb } OPTIONAL { ?f wdt:P136 ?g. ?g rdfs:label ?gl. FILTER(LANG(?gl)='en') }
  FILTER(YEAR(?d)=${y}) SERVICE wikibase:label { bd:serviceParam wikibase:language 'en,mul'. }
} GROUP BY ?f ?fLabel ?imdb ?sl`;

const NICE = { 'science fiction': 'Science fiction', 'sci-fi': 'Science fiction', 'film noir': 'Noir', 'romantic comedy': 'Rom-com', 'rom-com': 'Rom-com', 'superhero': 'Superhero', 'biographical': 'Biography', 'biopic': 'Biography', 'historical': 'History', 'animated': 'Animation', 'traditionally animated': 'Animation', 'computer-animated': 'Animation', 'children\'s': 'Kids', 'teen': 'Teen', 'martial arts': 'Martial arts', 'slasher': 'Slasher', 'heist': 'Heist', 'disaster': 'Disaster', 'christmas': 'Christmas', 'buddy': 'Buddy', 'coming-of-age': 'Coming of age', 'road': 'Road movie', 'spy': 'Spy', 'sports': 'Sports', 'war': 'War', 'western': 'Western', 'musical': 'Musical', 'horror': 'Horror', 'comedy': 'Comedy', 'drama': 'Drama', 'action': 'Action', 'adventure': 'Adventure', 'fantasy': 'Fantasy', 'thriller': 'Thriller', 'mystery': 'Mystery', 'crime': 'Crime', 'romance': 'Romance', 'romantic': 'Romance', 'documentary': 'Documentary', 'family': 'Family', 'political': 'Political', 'satire': 'Satire', 'parody': 'Parody', 'zombie': 'Zombies', 'vampire': 'Vampires', 'monster': 'Monsters', 'dance': 'Dance', 'psychological thriller': 'Thriller', 'crime thriller': 'Crime' };
function genres(raw) {
  const out = new Set();
  for (const g of String(raw || '').toLowerCase().split('|')) {
    const k = g.replace(/\b(film|films|movie|movies|genre|fiction film)\b/g, '').replace(/\s+/g, ' ').trim();
    if (NICE[k]) out.add(NICE[k]);
    else for (const word of Object.keys(NICE)) if (k.includes(word) && word.length > 4) { out.add(NICE[word]); break; }
  }
  return [...out].slice(0, 6);
}
// Not features for this index: shorts, adult films, and entries with no real title.
const skip = (raw) => /\bshort film|pornograph|\badult film|erotic film|\bshort\b/i.test(String(raw || ''));

async function year(y) {
  for (let tries = 0; tries < 6; tries++) {
    try {
      const r = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query(y)), { signal: AbortSignal.timeout(90000), headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' } });
      if (r.ok) return JSON.parse(await r.text()).results.bindings;
      console.log(y, 'answered', r.status, '— waiting');
      await sleep((+r.headers.get('retry-after') || 30) * 1000);
    } catch (e) { console.log(y, e.name, '— waiting'); await sleep(20000); }
  }
  throw new Error('gave up on ' + y);
}

(async () => {
  const rows = new Map();
  for (let y = FIRST; y <= LAST; y++) {
    const got = await year(y);
    let n = 0;
    for (const b of got) {
      const title = b.fLabel?.value || '', qid = b.f.value.split('/').pop();
      if (!title || /^Q\d+$/.test(title) || skip(b.genres?.value)) continue;
      const imdb = /^tt\d+$/.test(b.imdb?.value || '') ? b.imdb.value : null;
      const row = [title, y, imdb, +b.sl.value || 0, genres(b.genres?.value), qid];
      const key = imdb || qid;
      if (!rows.has(key) || rows.get(key)[3] < row[3]) { rows.set(key, row); n++; }
    }
    console.log(y, got.length, 'found,', n, 'kept, total', rows.size);
    await sleep(1500);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // Popular films only: covered by at least this many Wikipedia languages.
  const list = [...rows.values()].filter((r) => r[3] >= MIN_POP).sort((a, b) => b[3] - a[3] || b[1] - a[1]);
  fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(list), { level: 9 }));
  console.log('DONE', list.length, 'movies,', (fs.statSync(OUT).size / 1e6).toFixed(1), 'MB');
})().catch((e) => { console.error(e); process.exit(1); });
