// The movie index: American films from 1950 on (src/main/data/movies.json.gz, built by
// tools/build-catalog.js from Wikidata). Browse, sort and filter here; covers, summaries and
// credits are looked up by name when you look at a title, then remembered on this PC.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { identify, norm } = require('./identify');
const { findSources, openSource, onePerQuality } = require('./sources');

const UA = { 'User-Agent': 'HomeCable (home media player)', Accept: 'application/json' };
const SOURCE_TTL = 3 * 24 * 3600e3;

class Catalog {
  constructor({ store, settings, log = () => {}, items = () => [], torrents = () => null, lib }) {
    this.store = store; this.settings = settings; this.log = log; this.items = items; this.torrents = torrents; this.lib = lib;
    this.cache = store.read('catalogCache', { art: {}, info: {}, sources: {} });
    this.cache.art = this.cache.art || {}; this.cache.info = this.cache.info || {}; this.cache.sources = this.cache.sources || {};
    this.list = null; this.byId = null; this._artQ = []; this._artBusy = 0;
  }
  _load() {
    if (this.list) return;
    let rows = [];
    try { rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'data', 'movies.json.gz')))); } catch (e) { this.log('movie index:', e.message); }
    this.list = rows.map(([title, year, imdb, pop, genres, qid]) => ({ id: imdb || qid, title, year, imdb, pop, genres: genres || [], qid, key: norm(title) }));
    this.byId = new Map(this.list.map((m) => [m.id, m]));
  }
  _free() { return this.settings().moviesFree !== false; }
  // Known to play, as things stand now: a remembered free film doesn't count once you've turned those off.
  _plays(id) { const l = this.cache.sources[id]?.list || []; return this._free() ? l.length > 0 : l.some((s) => s.source !== 'archive'); }
  _save() { clearTimeout(this._t); this._t = setTimeout(() => this.store.write('catalogCache', this.cache), 1000); this._t.unref?.(); }
  // A card: what the row needs, plus whether it's known to play and how far you got.
  _card(m) {
    const seen = this.settings().catalogSeen?.[m.id];
    const res = this.settings().vodResume || {}, watched = this.settings().vodWatched || {};
    return { id: m.id, title: m.title, year: m.year, genres: m.genres, pop: m.pop, poster: this.cache.art[m.id] || null, playable: this._plays(m.id), resume: seen ? res[seen.itemId] || 0 : 0, duration: seen?.duration || 0, watched: !!(seen && watched[seen.itemId]) };
  }
  meta() {
    this._load();
    const count = new Map();
    for (const m of this.list) for (const g of m.genres) count.set(g, (count.get(g) || 0) + 1);
    return { total: this.list.length, genres: [...count.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g), decades: [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020] };
  }
  // Search, filter and sort everything.
  browse({ q = '', genres = [], decade = null, sort = 'popular', playable = false, page = 0, limit = 60 } = {}) {
    this._load();
    const k = norm(q), words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    let l = this.list;
    if (k) l = l.filter((m) => m.key.includes(k) || words.every((w) => m.title.toLowerCase().includes(w)));
    if (genres.length) l = l.filter((m) => genres.every((g) => m.genres.includes(g)));
    if (decade) l = l.filter((m) => m.year >= decade && m.year < decade + 10);
    if (playable) l = l.filter((m) => this._plays(m.id));
    const by = { popular: (a, b) => b.pop - a.pop, newest: (a, b) => b.year - a.year || b.pop - a.pop, oldest: (a, b) => a.year - b.year || b.pop - a.pop, az: (a, b) => a.title.localeCompare(b.title), za: (a, b) => b.title.localeCompare(a.title) }[sort];
    if (k) { const rank = (m) => (m.key === k ? 0 : m.key.startsWith(k) ? 1 : 2); l = [...l].sort((a, b) => rank(a) - rank(b) || (by ? by(a, b) : 0)); } else if (by && sort !== 'popular') l = [...l].sort(by);
    return { total: l.length, items: l.slice(page * limit, (page + 1) * limit).map((m) => this._card(m)) };
  }
  // The front page: what you're in the middle of, what plays, then groups of the best known.
  home() {
    this._load();
    const top = (f, n = 24) => { const out = []; for (const m of this.list) { if (f(m)) { out.push(this._card(m)); if (out.length >= n) break; } } return out; };
    const seen = Object.entries(this.settings().catalogSeen || {}).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    const res = this.settings().vodResume || {}, watched = this.settings().vodWatched || {};
    const cont = seen.filter(([, s]) => res[s.itemId] && !watched[s.itemId]).map(([id]) => this.byId.get(id)).filter(Boolean).map((m) => this._card(m));
    const again = seen.filter(([, s]) => watched[s.itemId]).map(([id]) => this.byId.get(id)).filter(Boolean).slice(0, 24).map((m) => this._card(m));
    const lastGenre = seen.map(([id]) => this.byId.get(id)?.genres[0]).find(Boolean);
    const playable = top((m) => this._plays(m.id), 40);
    const rows = [['Continue watching', cont], ['Ready to play', playable], ['Most known films', top(() => true)]];
    if (lastGenre) rows.push([`More ${lastGenre}`, top((m) => m.genres.includes(lastGenre) && !this.settings().catalogSeen?.[m.id])]);
    for (const g of ['Comedy', 'Action', 'Drama', 'Horror', 'Science fiction', 'Animation', 'Thriller', 'Romance', 'Western', 'Musical', 'Noir', 'Documentary']) rows.push([g, top((m) => m.genres.includes(g))]);
    for (const d of [2020, 2010, 2000, 1990, 1980, 1970, 1960, 1950]) rows.push([`The ${d}s`, top((m) => m.year >= d && m.year < d + 10)]);
    rows.push(['Watched', again]);
    return { rows: rows.filter(([, l]) => l.length).map(([title, items]) => ({ title, items })) };
  }
  // Films the Internet Archive marks as free, matched to the index, so "Ready to play" has something to show.
  async refreshFree() {
    if (!this._free() || Date.now() - (this.cache.freeAt || 0) < 24 * 3600e3 || this._freeBusy) return;
    this._freeBusy = true;
    try {
      this._load();
      const q = 'mediatype:movies AND collection:(feature_films OR film_noir OR sci-fi_horror OR comedy_films OR classic_tv) AND licenseurl:(*publicdomain* OR *creativecommons*)';
      const j = await (await fetch(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=title&fl[]=year&rows=400&sort[]=downloads+desc&output=json`, { signal: AbortSignal.timeout(20000), headers: UA })).json();
      const byKey = new Map();
      for (const m of this.list) { if (!byKey.has(m.key)) byKey.set(m.key, []); byKey.get(m.key).push(m); }
      let n = 0;
      for (const d of j?.response?.docs || []) {
        const m = (byKey.get(norm(d.title)) || []).find((x) => !d.year || Math.abs(x.year - +d.year) <= 1);
        if (!m || this._plays(m.id)) continue;
        if (n++ > 60) break;
        await this.sources(m.id).catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
      }
      this.cache.freeAt = Date.now();
      this._save();
    } finally { this._freeBusy = false; }
  }
  // Covers: asked for as cards come into view, a few at a time, then remembered.
  art(ids, send) {
    if (!this.settings().onlineMeta) return;
    this._load();
    const want = (ids || []).filter((id) => this.byId.has(id) && !this.cache.art[id] && !this._artQ.includes(id)).slice(0, 80);
    this._artQ.push(...want);
    this._pump(send);
  }
  _pump(send) {
    while (this._artBusy < 3 && this._artQ.length) {
      const id = this._artQ.shift();
      this._artBusy++;
      this._cover(this.byId.get(id)).then((url) => { if (url) { this.cache.art[id] = url; this._save(); send('catalog-art', { id, url }); } }).catch(() => {})
        .finally(() => { this._artBusy--; setTimeout(() => this._pump(send), 120); });
    }
  }
  // The exact film, by its IMDb id: never a lookalike's cover.
  async _cover(m) {
    const s = m.title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s || !m.imdb) return null;
    const j = await (await fetch(`https://v2.sg.media-imdb.com/suggestion/${s[0]}/${encodeURIComponent(s.slice(0, 60))}.json`, { signal: AbortSignal.timeout(10000), headers: UA })).json();
    const hit = (j?.d || []).find((x) => x.id === m.imdb);
    const img = hit?.i?.imageUrl;
    return img ? img.replace(/\._V1_.*\.jpg$/, '._V1_QL70_UX360_.jpg') : null;
  }
  // The page for one title: summary, credits, runtime, rating, similar films, ways to play.
  async details(id) {
    this._load();
    const m = this.byId.get(id);
    if (!m) return null;
    let info = this.cache.info[id];
    if (!info && this.settings().onlineMeta) {
      info = {};
      const r = await identify({ name: m.title, kind: 'movie', year: m.year }).catch(() => null);
      const b = r?.best;
      if (b && norm(b.name) === m.key && (!b.year || Math.abs(b.year - m.year) <= 1)) { const text = b.summary || ''; const end = Math.max(text.lastIndexOf('. '), text.endsWith('.') ? text.length - 1 : -1); info.summary = end > 80 ? text.slice(0, end + 1) : text; if (!this.cache.art[id] && b.poster) this.cache.art[id] = b.poster; }
      const credits = await this._credits(m).catch(() => null);
      if (credits) { Object.assign(info, credits); this.cache.info[id] = info; this._save(); } // a failed lookup is tried again next time
    }
    const similar = [];
    for (const x of this.list) { if (x.id !== id && x.genres.filter((g) => m.genres.includes(g)).length >= Math.min(2, m.genres.length) && m.genres.length) { similar.push(this._card(x)); if (similar.length >= 18) break; } }
    const sameName = this.list.filter((x) => x.id !== id && x.key === m.key).slice(0, 6).map((x) => this._card(x));
    const seen = this.settings().catalogSeen?.[id];
    return { ...this._card(m), imdb: m.imdb, ...(info || {}), similar, sameName, resumeAt: seen ? (this.settings().vodResume || {})[seen.itemId] || 0 : 0 };
  }
  async _credits(m) {
    const q = `SELECT ?p ?v ?name WHERE { VALUES ?p { wdt:P57 wdt:P161 wdt:P2047 wdt:P1657 } wd:${m.qid} ?p ?v. OPTIONAL { ?v rdfs:label ?name. FILTER(LANG(?name) IN ('en', 'mul')) } } LIMIT 60`;
    const j = await (await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), { signal: AbortSignal.timeout(12000), headers: { ...UA, Accept: 'application/sparql-results+json' } })).json();
    const out = { directors: [], cast: [] };
    for (const b of j?.results?.bindings || []) {
      const p = b.p.value.split('/').pop(), v = b.name?.value || '';
      if (p === 'P57') { if (v) out.directors.push(v); } else if (p === 'P161') { if (v) out.cast.push(v); }
      else if (p === 'P2047') out.runtime = Math.round(+b.v.value) || null; else if (p === 'P1657' && v) out.rating = v;
    }
    out.directors = [...new Set(out.directors)]; out.cast = [...new Set(out.cast)].slice(0, 12);
    return out;
  }
  async sources(id, { fresh = false } = {}) {
    this._load();
    const m = this.byId.get(id);
    if (!m) return [];
    const c = this.cache.sources[id];
    const free = this._free();
    const ctx = { items: this.items, log: this.log, free };
    // What you own is always looked at again. A free film found lately is remembered, so opening
    // a film doesn't ask the Archive every time.
    if (!free || (c && !fresh && Date.now() - c.at < SOURCE_TTL)) {
      const own = await findSources(m, { ...ctx, free: false });
      return onePerQuality([...own, ...(free ? c.list.filter((s) => s.source === 'archive') : [])]);
    }
    const list = await findSources(m, ctx);
    if (!ctx.failed) { this.cache.sources[id] = { at: Date.now(), list }; this._save(); } // a failed lookup is tried again next time
    return list;
  }
  // Press play: start that source, and remember the film so resume and history follow it.
  async open(id, quality) {
    this._load();
    const m = this.byId.get(id);
    if (!m) throw new Error('That title is not in the index');
    const list = await this.sources(id);
    const s = list.find((x) => x.quality === quality) || list[0];
    if (!s) throw new Error('No streams available');
    const st = this.settings();
    const itemId = await openSource(s, { torrents: this.torrents(), items: this.items, lib: this.lib, playBy: st.moviesPlayBy, torrentsOn: !!st.torrentsOn });
    const it = this.lib.items[itemId];
    if (it && s.source !== 'library') { Object.assign(it, { titleUser: m.title, year: m.year, kindUser: 'movie', catalogId: id, catalogOnly: true, genres: it.genres?.length ? it.genres : m.genres }); this.lib.save(); }
    st.catalogSeen = { ...(st.catalogSeen || {}), [id]: { itemId, at: Date.now(), duration: it?.duration || 0 } };
    return { itemId };
  }
  // Start over: forget where you were in this film (your resume point and ✓ mark).
  forget(id) { const st = this.settings(); if (st.catalogSeen) { const { [id]: _, ...rest } = st.catalogSeen; st.catalogSeen = rest; } return true; }
  close() { clearTimeout(this._t); try { this.store.write('catalogCache', this.cache); } catch {} }
}

module.exports = { Catalog };
