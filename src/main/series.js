// HomeStreamer: turn a folder of shows into Netflix-style series, going by YOUR folders.
//   <HomeStreamer folder>\<Series folder>\…            → one series per folder
//   <Series folder>\<sub folder>\…                      → a season ("1st Season", "Nigakki", "OADs", "Extras")
//   files right in the series folder                    → its episodes ("Season N" when the names say so)
//   very short clips (creditless openings/endings)      → that series' "Extras"
// Episodes play in order: by season (numbered first, specials and extras last), then by
// episode number, then by file name. Shows found elsewhere in the library are grouped by
// their parsed show name and season instead.
const path = require('path');
const { naturalCompare } = require('./naming');

const TAGS = /\b(v\d+|complete|compete|uncut|uncensored|remastered|dual[ -]?audio|multi[ -]?subs?|subbed|dubbed|hd|fhd|uhd|sd|bd|bdrip|bluray|blu-ray|dvd|dvdrip|web|web-?dl|webrip|hdtv|\d{3,4}p|x26[45]|h\.?26[45]|hevc|avc|aac|flac|ac3|10[ -]?bit|8[ -]?bit|hi10p?)\b/gi;
// "[Doutei] Kodomo no Jikan Compete v2 [DVD]" → "Kodomo no Jikan"; "Loveless [v2][DVD][Soldado]" → "Loveless".
function cleanName(raw) {
  let s = String(raw || '')
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')          // [group] [DVD] {tags}
    .replace(/\([^)]*\)/g, ' ')                       // (complete) (2019) (1080p)
    .replace(/[_.]+/g, ' ')
    .replace(TAGS, ' ')
    .replace(/\b\d+\s*bits?\b|\bdd\s?\d?(\.\d)?\b|\bdts\b|\+\s*(sp|specials?|ova|oad)s?\b/gi, ' ')  // "10 bits", "DD", "+SP"
    .replace(/\s-\s?[A-Z0-9]{2,}\s*$/, ' ')         // a trailing " -EMBER" release group
    .replace(/\bseasons?\s*\d+(\s*[-~]\s*\d+)?\b|\bs\d{1,2}(\s*[-~]\s*s?\d{1,2})?\b/gi, ' ')  // "Season 1-9", "S01"
    .replace(/\b\d{1,3}\s*[-~]\s*\d{1,3}\b/g, ' ')    // "01-13" episode ranges
    .replace(/\s+season\s*$/i, ' ')
    .replace(/[([{]\s*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s\-–—:,]+|[\s\-–—:,]+$/g, '');
  return s || String(raw || '').trim();
}

const SPECIAL = /\b(oads?|ovas?|specials?|sp|extras?|bonus|omake|nc ?op|nc ?ed|creditless|trailers?|promos?|featurettes?|behind the scenes|deleted scenes)\b/i;
const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
// A season folder's label and sort position: numbered seasons first, other names next, specials last.
function seasonInfo(folderName) {
  const name = cleanName(folderName) || folderName;
  const m = /\bseason\s*(\d+)|\bs(\d{1,2})\b|\b(\d+)(?:st|nd|rd|th)\s*season|\bseries\s*(\d+)|\bpart\s*(\d+)/i.exec(folderName)
    || /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season/i.exec(folderName);
  if (m) { const n = +(m[1] || m[2] || m[3] || m[4] || m[5]) || ORD[(m[1] || '').toLowerCase()]; if (n) return { label: `Season ${n}`, rank: [0, n, ''] }; }
  if (SPECIAL.test(folderName)) return { label: name, rank: [2, 0, name.toLowerCase()] };
  return { label: name, rank: [1, 0, name.toLowerCase()] };
}
const cmpRank = (a, b) => a[0] - b[0] || a[1] - b[1] || naturalCompare(a[2], b[2]);
// A file name without [group] tags and hashes, for natural ordering ("Show 02" before "Show 10").
const fileKey = (p) => cleanName(path.basename(p, path.extname(p)));

// items: library items on the channel; roots: the channel's HomeStreamer folders.
function buildSeries(items, roots, { isShort = (it) => it.kind === 'short' } = {}) {
  const rootsAbs = roots.map((r) => path.resolve(r));
  const series = new Map();
  const loose = [];
  const get = (key, name, dir) => {
    if (!series.has(key)) series.set(key, { key, name, dir, seasons: new Map() });
    return series.get(key);
  };
  for (const it of items) {
    const p = it.path || '';
    const root = rootsAbs.find((r) => p.toLowerCase().startsWith(r.toLowerCase() + path.sep));
    let s = null, season = null;
    if (root) {
      const rel = path.relative(root, p).split(path.sep);
      if (rel.length >= 2) {
        const dir = path.join(root, rel[0]);
        s = get('f:' + dir.toLowerCase(), cleanName(rel[0]), dir);
        if (rel.length >= 3) season = seasonInfo(rel[1]);
      }
    }
    if (!s && it.showKey) s = get('s:' + it.showKey, it.show || cleanName(it.title));
    if (!s) { loose.push(it); continue; }
    if (!season) season = it.season != null ? { label: `Season ${it.season}`, rank: [0, it.season, ''] } : { label: 'Episodes', rank: [0, 0, ''] };
    if (isShort(it) && season.rank[0] !== 2) season = { label: 'Extras', rank: [3, 0, 'extras'] };
    if (!s.seasons.has(season.label)) s.seasons.set(season.label, { label: season.label, rank: season.rank, items: [] });
    s.seasons.get(season.label).items.push(it);
  }
  const out = [];
  for (const s of series.values()) {
    const seasons = [...s.seasons.values()].sort((a, b) => cmpRank(a.rank, b.rank));
    for (const se of seasons) se.items.sort((a, b) => ((a.episode ?? 1e9) - (b.episode ?? 1e9)) || naturalCompare(fileKey(a.path || a.title), fileKey(b.path || b.title)));
    out.push({ key: s.key, name: s.name, dir: s.dir || null, seasons: seasons.map((se) => ({ label: se.label, ids: se.items.map((i) => i.id) })) });
  }
  out.sort((a, b) => naturalCompare(a.name.replace(/^(the|a|an)\s+/i, ''), b.name.replace(/^(the|a|an)\s+/i, '')));
  return { series: out, loose };
}

module.exports = { buildSeries, cleanName, seasonInfo };
