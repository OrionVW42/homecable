// Movies, TV shows and anime, as covers, in HomeCable's black and orange. Pick the genres you
// like, then rows on the front page; search, filters and sorting across the whole index; a page
// for each title with its story and the ways to play it, or "No streams available". Shows have
// their seasons and episodes, with their movies, OVAs and specials in the order to watch.
import { html } from 'htm/preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { tv, Icon, fmtDur } from './util.js';

const SORTS = [['popular', 'Most known'], ['newest', 'Newest'], ['oldest', 'Oldest'], ['az', 'A–Z'], ['za', 'Z–A']];
export const KINDS = [['movie', 'Movies'], ['tv', 'TV shows'], ['anime', 'Anime']];
const NOUN = { movie: ['film', 'films'], tv: ['show', 'shows'], anime: ['title', 'titles'] };
const ABOUT = { movie: 'American films, 1950 to today', tv: 'TV shows', anime: 'anime series, movies and OVAs' };
const plain = (e) => String(e?.message || e).replace(/^.*Error: /, '');
const mbSize = (n) => (n == null ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
// The quality of a torrent, from its name — the labels and order the play buttons use.
const QUALITIES = ['2160p', '1080p', '720p', '480p', 'SD'];
const qualityOf = (name = '') => { const n = name.toLowerCase(); if (/2160p|\buhd\b|\b4k\b/.test(n)) return '2160p'; if (/1080p|fullhd|\bfhd\b/.test(n)) return '1080p'; if (/720p|\bhd\b/.test(n)) return '720p'; if (/480p|dvdrip|sdtv|\bsd\b/.test(n)) return '480p'; return 'SD'; };
const art = new Map(); // id → cover, for this session
let onArt = null;
tv.onCatalogArt?.(({ id, url }) => { art.set(id, url); onArt?.(id); });

// Covers load as cards come into view.
const seenIds = new Set();
let pendingIds = [], pendingT = null;
const wantArt = (id) => { if (seenIds.has(id)) return; seenIds.add(id); pendingIds.push(id); clearTimeout(pendingT); pendingT = setTimeout(() => { tv.catalogArt(pendingIds); pendingIds = []; }, 200); };

function Card({ m, onOpen }) {
  const ref = useRef(null);
  const [, tick] = useState(0);
  const poster = m.poster || art.get(m.id);
  useEffect(() => {
    if (poster || !ref.current) return undefined;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { wantArt(m.id); io.disconnect(); } }, { rootMargin: '300px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [m.id, poster]);
  useEffect(() => { const t = setInterval(() => { if (!poster && art.has(m.id)) tick((n) => n + 1); }, 1500); return () => clearInterval(t); }, [poster, m.id]);
  const pct = m.resume && m.duration ? Math.min(100, (m.resume / m.duration) * 100) : 0;
  return html`<button class="cat-card" ref=${ref} title=${`${m.title} (${m.year})`} onClick=${() => onOpen(m.id, m.title)}>
    <div class="cat-cover">${poster ? html`<img src=${poster} loading="lazy" alt="" />` : html`<div class="cat-noart"><b>${m.title}</b><span>${m.year}</span></div>`}
      ${m.playable && html`<span class="cat-play-tag">▶ Plays</span>`}${m.watched && html`<span class="cat-seen">✓</span>`}
      ${pct > 0 && html`<span class="cat-progress"><i style=${{ width: pct + '%' }}></i></span>`}</div>
    <div class="cat-cap"><b>${m.title}</b><span>${[m.year, m.genres?.[0]].filter(Boolean).join(' · ')}</span></div></button>`;
}

function Row({ title, items, onOpen }) {
  const ref = useRef(null);
  const go = (d) => ref.current?.scrollBy({ left: d * ref.current.clientWidth * 0.85, behavior: 'smooth' });
  return html`<section class="cat-row"><h3>${title}</h3><div class="cat-row-wrap">
    <button class="cat-arrow left" aria-label="Back" onClick=${() => go(-1)}><${Icon.left} /></button>
    <div class="cat-track" ref=${ref}>${items.map((m) => html`<${Card} key=${m.id} m=${m} onOpen=${onOpen} />`)}</div>
    <button class="cat-arrow right" aria-label="More" onClick=${() => go(1)}><${Icon.right} /></button></div></section>`;
}

// Run a torrent search across the turned-on sources and report the best-seeded result per
// quality as results arrive. onUpdate is called with an updater, like a setState. Returns a stop fn.
function runTorrentSearch(query, onUpdate) {
  let sid = null, live = true; const buf = [], pend = [];
  const take = (m) => {
    if (m.event === 'search') {
      buf.push(...(m.results || []).map((r) => ({ ...r, key: `${r.engine}|${r.link || r.page}` })));
      const best = {};
      for (const r of buf) { const q = qualityOf(r.name); if (!best[q] || (r.seeds || 0) > (best[q].seeds || 0)) best[q] = r; }
      if (live) onUpdate((t) => ({ best, done: !!t?.done }));
    } else if (m.event === 'search-done' && live) onUpdate((t) => ({ best: t?.best || {}, done: true }));
  };
  const off = tv.onTorrentSearch((m) => { if (sid == null) { pend.push(m); return; } if (m.searchId === sid) take(m); });
  tv.searchRun(query, 'all').then((r) => { sid = r.searchId; for (const m of pend) if (m.searchId === sid) take(m); })
    .catch((e) => { if (live) onUpdate({ best: {}, done: true, error: plain(e) }); });
  return () => { live = false; off?.(); };
}

// Like runTorrentSearch, but hands back every result as it arrives (keyed, not grouped) so the
// caller can sort them into scopes. Calls onResults(resultArray) and onDone(). Returns a stop fn.
function runTorrentSearchRaw(query, onResults, onDone) {
  let sid = null, live = true; const pend = [];
  const take = (m) => {
    if (m.event === 'search') { if (live && m.results?.length) onResults(m.results.map((r) => ({ ...r, key: `${r.engine}|${r.link || r.page}` }))); }
    else if (m.event === 'search-done' && live) onDone?.();
  };
  const off = tv.onTorrentSearch((m) => { if (sid == null) { pend.push(m); return; } if (m.searchId === sid) take(m); });
  tv.searchRun(query, 'all').then((r) => { sid = r.searchId; for (const m of pend) if (m.searchId === sid) take(m); })
    .catch(() => { if (live) onDone?.(); });
  return () => { live = false; off?.(); };
}

// What to search for an episode: the show (or part) name with a SxxExx tag for a numbered season,
// the title on its own for a one-off movie, OVA or special, else the part name plus the number.
const pad2 = (n) => String(n).padStart(2, '0');
function episodeQuery(part, e) {
  const base = part.names?.[0] || part.title || '';
  if (part.type === 'season' && part.season != null) return `${base} S${pad2(part.season)}E${pad2(e.n)}`;
  if (part.episodes.length <= 1) return base;
  return `${base} ${e.n}`;
}

// Which scope a torrent is, from its release name: the whole series, several seasons, one season,
// or a single episode. The scope decides which group's play buttons it can fill.
function scopeOf(name = '') {
  const n = name.toLowerCase();
  if (/\bcomplete\b|all\s*seasons|the\s*complete\s*series|\bcollection\b|\bseries\b\s*\d*\s*-\s*\d|\bbatch\b/.test(n)) return 'series';
  if (/s\d{1,2}\s*[-–]\s*s?\d{1,2}|seasons?\s*\d{1,2}\s*[-–]\s*\d{1,2}/.test(n)) return 'multiseason';
  if (/s\d{1,2}\s*[ex._-]?\s*e\d{1,3}|\b\d{1,2}x\d{2,3}\b|\bepisode\s*\d+|\b-\s*\d{1,4}\b(?!\s*p)/.test(n)) return 'episode';
  if (/\bs\d{1,2}\b|season\s*\d{1,2}/.test(n)) return 'season';
  return 'episode';
}
// The season number a result is for, when it names one (used to keep "Season N" to that season).
function seasonNumOf(name = '') { const m = /\bs(\d{1,2})\b|season\s*(\d{1,2})/i.exec(name); return m ? +(m[1] || m[2]) : null; }
// The season + episode a single-episode release is for, from the many ways releases name them —
// SxxExx, 1x03, "Episode 7", "E07", or anime's absolute "Show - 07". null when it isn't one episode.
function epInfoOf(name = '') {
  let m;
  if ((m = /s(\d{1,2})\s*[._-]?\s*e(\d{1,3})/i.exec(name))) return { season: +m[1], ep: +m[2] };
  if ((m = /\b(\d{1,2})x(\d{2,3})\b/.exec(name))) return { season: +m[1], ep: +m[2] };
  if ((m = /\bepisode\s*(\d{1,4})/i.exec(name))) return { season: null, ep: +m[1] };
  if ((m = /(?:^|[\s_.([-])e[p]?\.?\s*(\d{1,4})(?=$|[\s_.)\]v-])/i.exec(name))) return { season: null, ep: +m[1] };
  if ((m = /\s[-–]\s*(\d{1,4})(?:v\d)?\s*(?=$|[\s[(])/.exec(name))) return { season: null, ep: +m[1] };
  return null;
}

// The play buttons on a film's page in torrent mode: one per quality found, each the
// result with the most seeders, highest quality first. Click one to start and play it.
function torrentButtons({ tor, busy, playTorrent }) {
  if (!tor) return html`<span class="muted">Searching your torrent sources…</span>`;
  if (tor.error) return html`<div class="cat-nostream">Couldn’t search: ${tor.error}</div>`;
  const qs = QUALITIES.filter((q) => tor.best[q]);
  if (!qs.length) return html`<div class="cat-nostream">${tor.done ? 'No torrents found. Try turning on more sources in Torrents → Search engines.' : 'Searching your torrent sources…'}</div>`;
  return qs.map((q) => { const r = tor.best[q]; const seeders = r.seeds == null ? 'web seed' : `${r.seeds} seeder${r.seeds === 1 ? '' : 's'}`; return html`<button class="btn cat-playbtn" disabled=${!!busy} onClick=${() => playTorrent(r)}><${Icon.play} /> ${busy === r.key ? 'Starting…' : `Play ${q}`}<small>${seeders}${r.size ? ` · ${mbSize(r.size)}` : ''}</small></button>`; });
}

const dayOf = (s) => { const d = s ? new Date(s + 'T12:00:00') : null; return d && !isNaN(d) ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''; };

// Seasons and episodes, with movies, OVAs and specials in the order to watch them. A season that
// has anything to play gets a button, which starts at its next unwatched episode.
// The pack scopes a series is offered by, highest-reach first; episodes are offered on their rows.
const SCOPES = [['series', 'Whole series'], ['multiseason', 'Multiple seasons'], ['season', 'This season'], ['other', 'Best matches']];

function ShowGuide({ id, onPlayEpisode, onPlay = () => {}, toast, torrentMode = false, onFullSearch = null, showTitle = '' }) {
  const [g, setG] = useState(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState(null);
  const [busy, setBusy] = useState('');
  const [tors, setTors] = useState({}); // torrent mode: episode key → { best, done, error } from a manual find
  const [pool, setPool] = useState([]); // torrent mode: every result found for the viewed part, keyed and deduped
  const [poolDone, setPoolDone] = useState(false);
  const stops = useRef({});
  // Load the episode guide; clear everything (searches included) when the title changes.
  useEffect(() => {
    let live = true; setG(null); setErr(''); setSel(null);
    for (const s of Object.values(stops.current)) s?.(); stops.current = {}; setTors({});
    tv.catalogGuide(id).then((r) => { if (live) setG(r); }).catch((e) => { if (live) setErr(plain(e)); });
    return () => { live = false; for (const s of Object.values(stops.current)) s?.(); stops.current = {}; };
  }, [id]);
  // Pick the part to show: the one you were last on, else the first with anything to play, else the first.
  const part = useMemo(() => {
    if (!g?.parts?.length) return null;
    const anyInPart = (p) => p.episodes.some((e) => !!g.sources[e.key]);
    const lastPart = g.last && g.parts.find((p) => p.episodes.some((e) => e.key === g.last));
    return g.parts.find((p) => p.key === sel) || lastPart || g.parts.find(anyInPart) || g.parts[0];
  }, [g, sel]);
  const season = part?.season ?? null;
  // Torrent mode: search the turned-on sources for the viewed part by the name releases use
  // (the same name the full-search button uses — anime titles differ from the catalog's), plus a
  // "complete" query for whole-series packs. Every result is kept so each scope can offer buttons.
  const searchName = part?.names?.[0] || part?.title || showTitle;
  useEffect(() => {
    setPool([]); setPoolDone(false);
    if (!torrentMode || !searchName) return undefined;
    const add = (rs) => setPool((prev) => { const seen = new Set(prev.map((r) => r.key)); const more = rs.filter((r) => !seen.has(r.key)); return more.length ? [...prev, ...more] : prev; });
    const base = season != null ? `${searchName} S${pad2(season)}` : searchName;
    const queries = [...new Set([searchName, base, `${searchName} complete`])];
    let left = queries.length;
    const done = () => { if (--left <= 0) setPoolDone(true); };
    const offs = queries.map((q) => runTorrentSearchRaw(q, add, done));
    return () => offs.forEach((o) => o?.());
  }, [torrentMode, searchName, season]);
  // Sort the pool: whole-series and multi-season packs, this season's packs, a best-seeded result
  // per quality per episode (matched by number), and a "Best matches" catch-all so nothing is lost.
  const groups = useMemo(() => {
    const out = { series: {}, multiseason: {}, season: {}, other: {} };
    const eps = new Map(); // episode number → { quality: result }
    const pick = (b, r) => { const q = qualityOf(r.name); if (!b[q] || (r.seeds || 0) > (b[q].seeds || 0)) b[q] = r; };
    for (const r of pool) {
      const sc = scopeOf(r.name);
      if (sc === 'series' || sc === 'multiseason') { pick(out[sc], r); continue; }
      if (sc === 'season') { const sn = seasonNumOf(r.name); if (season == null || sn == null || sn === season) pick(out.season, r); else pick(out.other, r); continue; }
      const info = epInfoOf(r.name); // an episode: file it on its row when we can place it, always keep it in "Best matches"
      if (info && (info.season == null || season == null || info.season === season)) { let b = eps.get(info.ep); if (!b) eps.set(info.ep, (b = {})); pick(b, r); }
      pick(out.other, r);
    }
    return { ...out, eps };
  }, [pool, season]);

  const start = async (key) => {
    setBusy(key);
    try { onPlayEpisode(await tv.catalogOpenEpisode(id, key)); } catch (e) { toast(plain(e)); }
    setBusy('');
  };
  // Manual single-episode search, when the pool didn't place one for this episode.
  const searchEp = (p, e) => {
    if (e.key in tors) return;
    setTors((all) => ({ ...all, [e.key]: { best: {}, done: false } }));
    const upd = (fn) => setTors((all) => ({ ...all, [e.key]: typeof fn === 'function' ? fn(all[e.key]) : fn }));
    stops.current[e.key] = runTorrentSearch(episodeQuery(p, e), upd);
  };
  const playTor = async (r) => {
    setBusy(r.key);
    try {
      const x = await tv.searchPlay(r.engine, { link: r.link, page: r.page, name: r.name });
      if (x.itemId) onPlay(x.itemId);
      else toast(`🧲 ${x.name || 'Added'}: it will play once a video is ready, see My torrents`);
    } catch (e) { toast(plain(e)); }
    setBusy('');
  };
  // An episode's play buttons: from the pool if it matched there, else a manual find, else (once
  // searched) its own best-per-quality buttons.
  const epTorrent = (p, e) => {
    const fromPool = groups.eps.get(e.n);
    if (fromPool && Object.keys(fromPool).length) return html`<div class="cat-ep-tor">${torrentButtons({ tor: { best: fromPool, done: poolDone }, busy, playTorrent: playTor })}</div>`;
    return e.key in tors
      ? html`<div class="cat-ep-tor">${torrentButtons({ tor: tors[e.key], busy, playTorrent: playTor })}</div>`
      : html`<button class="btn sm ghost" disabled=${!!busy} onClick=${() => searchEp(p, e)}><${Icon.magnet} /> Find torrent</button>`;
  };
  const partQuery = (p) => { const base = p.names?.[0] || p.title || showTitle || ''; return p.type === 'season' && p.season != null ? `${base} S${pad2(p.season)}` : base; };

  if (err) return html`<div class="cat-nostream cat-guide-msg">${err}</div>`;
  if (!g) return html`<div class="muted cat-guide-msg">Getting the episode list…</div>`;
  if (!g.parts?.length || !part) return html`<div class="cat-guide"><div class="cat-nostream">No streams available</div><div class="muted small cat-guide-msg">No episode list was found for this title.</div></div>`;
  const has = (e) => !!g.sources[e.key];
  const anyInPart = (p) => p.episodes.some(has);
  const total = Object.keys(g.sources).length;
  const count = part.episodes.filter(has).length;
  const single = part.episodes.length === 1 && part.type !== 'season';
  const scopeList = SCOPES.filter(([k]) => k !== 'season' || season != null);
  const anyScope = scopeList.some(([k]) => Object.keys(groups[k]).length);
  return html`<section class="cat-guide">
    <div class="cat-guide-top"><h3>Watch order</h3>${total === 0 && !torrentMode && html`<div class="cat-nostream">No streams available</div>`}</div>
    <div class="cat-parts" role="tablist">${g.parts.map((p, i) => html`<button role="tab" aria-selected=${p === part} class=${'cat-part' + (p === part ? ' on' : '') + (anyInPart(p) ? ' plays' : '')} title=${p.title} onClick=${() => setSel(p.key)}><small>${i + 1}</small><span>${p.type === 'season' ? p.label : p.title || p.label}</span></button>`)}</div>
    <div class="cat-part-head"><div><b>${part.title}</b><span class="muted small">${[part.year, single ? '' : `${part.episodes.length} episode${part.episodes.length === 1 ? '' : 's'}`, count && !single ? `${count} can play` : ''].filter(Boolean).join(' · ')}</span></div>
      ${count > 0 ? html`<button class="btn cat-playbtn" disabled=${!!busy} onClick=${() => start(part.key)}><${Icon.play} /> ${busy === part.key ? 'Starting…' : single ? 'Play' : 'Play season'}</button>`
        : !torrentMode ? html`<span class="muted small">No streams available</span>` : null}</div>
    ${torrentMode && html`<div class="cat-tor-scopes">
      ${!anyScope ? html`<div class=${poolDone ? 'cat-nostream' : 'muted'}>${poolDone ? (single ? 'No torrents found. Try turning on more sources, or search all sources.' : 'No series or season packs found — try a single episode below, or search all sources.') : 'Searching your torrent sources…'}</div>`
        : scopeList.map(([k, label]) => Object.keys(groups[k]).length ? html`<div class="cat-tor-scope"><h4>${k === 'season' ? `Season ${season}` : label}</h4>
            <div class="cat-streams">${torrentButtons({ tor: { best: groups[k], done: poolDone }, busy, playTorrent: playTor })}</div></div>` : null)}
    </div>`}
    ${torrentMode && onFullSearch && html`<button class="btn ghost sm cat-fullsearch" onClick=${() => onFullSearch(partQuery(part))}><${Icon.magnet} /> Search all torrent sources…<small>for this ${part.type === 'season' ? 'season' : 'title'}</small></button>`}
    ${!single && html`<ol class="cat-eps">${part.episodes.map((e) => { const p = g.progress?.[e.key]; const s = g.sources[e.key]; return html`<li class=${'cat-ep' + (s ? ' plays' : '') + (p?.watched ? ' seen' : '')}>
      <span class="cat-ep-n">${e.n}</span>
      <div class="cat-ep-text"><b>${e.title}</b><span class="muted small">${[dayOf(e.air), e.runtime ? fmtDur(e.runtime * 60) : '', s?.sourceName, p?.watched ? '✓ Watched' : p?.resume ? `Stopped at ${fmtDur(p.resume)}` : ''].filter(Boolean).join(' · ')}</span>${e.summary && html`<p>${e.summary}</p>`}</div>
      ${s ? html`<button class="btn sm" disabled=${!!busy} onClick=${() => start(e.key)}><${Icon.play} /> ${busy === e.key ? 'Starting…' : p?.resume && !p.watched ? 'Resume' : 'Play'}</button>`
        : torrentMode ? epTorrent(part, e) : null}
    </li>`; })}</ol>`}
    <div class="muted small cat-guide-from">Episode list from ${g.from}.</div>
  </section>`;
}

// First visit to each section: which genres do you like? Changeable any time.
function GenrePicker({ kind, genres, picked, onDone, onClose }) {
  const [sel, setSel] = useState(picked || []);
  const flip = (g) => setSel((l) => (l.includes(g) ? l.filter((x) => x !== g) : [...l, g]));
  const name = KINDS.find(([k]) => k === kind)[1];
  return html`<div class="cat-pick">
    <h2>What do you like to watch?</h2>
    <p class="muted">Pick some genres, and ${name === 'Movies' ? 'movies' : name === 'Anime' ? 'anime' : name} from them will come first. You can change this any time.</p>
    <div class="cat-pick-grid">${genres.slice(0, 28).map((g) => html`<button class=${'cat-pick-g' + (sel.includes(g) ? ' on' : '')} aria-pressed=${sel.includes(g)} onClick=${() => flip(g)}>${sel.includes(g) ? '✓ ' : ''}${g}</button>`)}</div>
    <div class="row cat-pick-go">${onClose && html`<button class="btn" onClick=${onClose}>Cancel</button>`}<button class="btn" onClick=${() => onDone([])}>Show everything</button><button class="btn primary cat-pick-done" disabled=${!sel.length} onClick=${() => onDone(sel)}>Show me these</button></div>
  </div>`;
}

// The big picture at the top of the front page: something from what you like.
function Hero({ m, onOpen }) {
  const [poster, setPoster] = useState(m.poster || art.get(m.id) || null);
  useEffect(() => { setPoster(m.poster || art.get(m.id) || null); if (!m.poster) wantArt(m.id); const t = setInterval(() => { const a = art.get(m.id); if (a) { setPoster(a); clearInterval(t); } }, 1000); return () => clearInterval(t); }, [m.id]);
  return html`<div class="cat-hero" style=${{ '--bg': poster ? `url("${poster}")` : 'none' }}>
    <div class="cat-hero-text"><h2>${m.title}</h2><div class="cat-meta">${m.year}${m.genres?.length ? ` · ${m.genres.slice(0, 3).join(' · ')}` : ''}</div>
      <button class="btn primary cat-hero-btn" onClick=${() => onOpen(m.id)}>See more</button></div>
  </div>`;
}

function Details({ id, onOpen, onBack, onPlay, toast, torrentMode = false, onFullSearch = null, onPlayEpisode = () => {} }) {
  const [d, setD] = useState(null);
  const [sources, setSources] = useState(null);
  const [busy, setBusy] = useState('');
  const isShow = /^(tv|anime):/.test(id); // shows list what can play in their guide, below
  const [tor, setTor] = useState(null); // torrent-mode: { best: {quality: result}, done, error }
  const [own, setOwn] = useState(null); // torrent-mode: your own copies, which are played without searching
  useEffect(() => {
    setD(null); setSources(null); setOwn(null);
    if (torrentMode && !isShow) tv.catalogSources(id, { own: true }).then(setOwn).catch(() => setOwn([]));
    tv.catalogDetails(id).then(setD).catch((e) => toast(plain(e)));
    if (!torrentMode && !isShow) tv.catalogSources(id).then(setSources).catch(() => setSources([]));
  }, [id]);
  // Torrent mode: unless you own this film, search the turned-on sources for it and keep the
  // best-seeded result per quality as it comes in, so each quality shows one play button.
  const title = d?.title;
  useEffect(() => {
    if (!torrentMode || isShow || !title || own === null || own.length) return undefined;
    setTor(null);
    return runTorrentSearch(title, setTor);
  }, [torrentMode, title, own]);
  const play = async (quality) => {
    setBusy(quality);
    try { const r = await tv.catalogOpen(id, quality); onPlay(r.itemId); } catch (e) { toast(plain(e)); }
    setBusy('');
  };
  const playTorrent = async (r) => {
    setBusy(r.key);
    try {
      const x = await tv.searchPlay(r.engine, { link: r.link, page: r.page, name: r.name });
      if (x.itemId) onPlay(x.itemId);
      else toast(`🧲 ${x.name || title}: added — it will play once a video is ready, see My torrents`);
    } catch (e) { toast(plain(e)); }
    setBusy('');
  };
  if (!d) return html`<div class="cat-loading">Loading…</div>`;
  const poster = d.poster || art.get(id);
  return html`<div class="cat-page">
    <button class="btn sm cat-back" onClick=${onBack}><${Icon.left} /> Back</button>
    <div class="cat-head" style=${{ '--bg': poster ? `url("${poster}")` : 'none' }}>
      <div class="cat-head-poster">${poster ? html`<img src=${poster} alt="" />` : html`<div class="cat-noart"><b>${d.title}</b><span>${d.year}</span></div>`}</div>
      <div class="cat-head-text">
        <h2>${d.title}</h2>
        <div class="cat-meta">${[d.year, d.runtime ? fmtDur(d.runtime * 60) : null, d.rating].filter(Boolean).join(' · ')}</div>
        ${(d.tags || d.genres)?.length > 0 && html`<div class="cat-genres">${(d.tags || d.genres).slice(0, 12).map((g) => html`<span>${g}</span>`)}</div>`}
        ${d.summary && html`<p>${d.summary}</p>`}
        ${d.directors?.length > 0 && html`<div class="cat-credit"><b>Directed by</b> ${d.directors.join(', ')}</div>`}
        ${d.cast?.length > 0 && html`<div class="cat-credit"><b>Starring</b> ${d.cast.join(', ')}</div>`}
        ${!isShow && html`<div class="cat-streams">
          ${torrentMode && own && !own.length ? torrentButtons({ tor, busy, playTorrent })
            : (torrentMode ? own : sources) === null ? html`<span class="muted">Looking for streams…</span>`
              : !(torrentMode ? own : sources).length ? html`<div class="cat-nostream">No streams available</div>`
                : (torrentMode ? own : sources).map((s) => html`<button class="btn cat-playbtn" disabled=${!!busy} onClick=${() => play(s.quality)}><${Icon.play} /> ${busy === s.quality ? 'Starting…' : `${d.resumeAt ? 'Resume' : 'Play'} ${s.quality}`}<small>${s.sourceName}</small></button>`)}
          ${torrentMode && onFullSearch && html`<button class="btn ghost cat-fullsearch" onClick=${() => onFullSearch(d.title)}><${Icon.magnet} /> Search all torrent sources…<small>if none of these are right</small></button>`}
        </div>`}
        ${d.resumeAt > 0 && html`<div class="muted small">You stopped at ${fmtDur(d.resumeAt)}.</div>`}
      </div>
    </div>
    ${d.kind !== 'movie' && html`<${ShowGuide} id=${id} onPlayEpisode=${onPlayEpisode} onPlay=${onPlay} toast=${toast} torrentMode=${torrentMode} onFullSearch=${onFullSearch} showTitle=${d.title} />`}
    ${d.sameName?.length > 0 && html`<${Row} title="Others with this name" items=${d.sameName} onOpen=${onOpen} />`}
    ${d.similar?.length > 0 && html`<${Row} title="More like this" items=${d.similar} onOpen=${onOpen} />`}
  </div>`;
}

export function CatalogView({ settings, setSettings, onPlay, toast, onFullSearch = null, kind = 'movie', setKind = () => {}, onPlayEpisode = () => {} }) {
  // When films are set to play through torrents, the film's page offers torrent play
  // buttons (best-seeded per quality, from the sources you have on) instead of the usual ones.
  const torrentMode = settings?.moviesPlayBy === 'torrent' && !!settings?.torrentsOn;
  // Filters are remembered per section; older settings held the films' at the top level.
  const allPrefs = settings?.catalogPrefs || {};
  const prefs = allPrefs[kind] || (kind === 'movie' ? allPrefs : {});
  const likes = settings?.catalogLikes?.[kind];
  const [picking, setPicking] = useState(false);
  const [meta, setMeta] = useState(null);
  const [home, setHome] = useState(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(prefs.sort || 'popular');
  const [genres, setGenres] = useState(prefs.genres || []);
  const [decade, setDecade] = useState(prefs.decade || null);
  const [playable, setPlayable] = useState(!!prefs.playable);
  const [res, setRes] = useState(null);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(null);
  const main = useRef(null);
  const filtering = !!(q.trim() || genres.length || decade || playable || sort !== 'popular');

  // Switching section starts it fresh, with its own remembered filters.
  useEffect(() => { setOpen(null); setQ(''); setRes(null); setHome(null); setMeta(null); setPicking(false); setSort(prefs.sort || 'popular'); setGenres(prefs.genres || []); setDecade(prefs.decade || null); setPlayable(!!prefs.playable); tv.catalogMeta(kind).then(setMeta).catch(() => {}); main.current?.scrollTo({ top: 0 }); }, [kind]);
  useEffect(() => { if (!open) tv.catalogHome(kind, likes || []).then(setHome).catch(() => {}); }, [open, kind, (likes || []).join('|')]);
  // What you were looking for is remembered between visits.
  useEffect(() => { const { sort: _s, genres: _g, decade: _d, playable: _p, ...rest } = allPrefs; const legacy = { sort: _s, genres: _g, decade: _d, playable: _p }; setSettings?.({ catalogPrefs: { ...(kind !== 'movie' && _s !== undefined ? { movie: legacy } : {}), ...rest, [kind]: { sort, genres, decade, playable } } }); }, [sort, genres, decade, playable]);
  useEffect(() => { setPage(0); }, [q, sort, genres, decade, playable]);
  useEffect(() => {
    if (!filtering) { setRes(null); return undefined; }
    const t = setTimeout(() => tv.catalogBrowse({ kind, q, genres, decade, sort, playable, page }).then((r) => setRes((cur) => (page > 0 && cur ? { ...r, items: [...cur.items, ...r.items] } : r))).catch(() => {}), 180);
    return () => clearTimeout(t);
  }, [kind, q, sort, genres, decade, playable, page, filtering]);
  useEffect(() => { main.current?.scrollTo({ top: 0 }); }, [open]);
  const toggleGenre = (g) => setGenres((l) => (l.includes(g) ? l.filter((x) => x !== g) : [...l, g]));
  const saveLikes = (l) => { setSettings?.({ catalogLikes: { ...(settings?.catalogLikes || {}), [kind]: l } }); setPicking(false); main.current?.scrollTo({ top: 0 }); };
  const askLikes = meta && !filtering && !open && (picking || !Array.isArray(likes));
  const heroItem = !filtering && !open && (home?.rows || []).find((r) => r.title !== 'Continue watching' && r.title !== 'Ready to play')?.items?.[0];
  const [one, many] = NOUN[kind];
  const clear = () => { setQ(''); setGenres([]); setDecade(null); setPlayable(false); setSort('popular'); };

  return html`<div class="overlay cat">
    <div class="overlay-head cat-top">
      <div class="seg cat-kinds" role="tablist">${KINDS.map(([k, l]) => html`<button role="tab" aria-selected=${k === kind} class=${k === kind ? 'on' : ''} onClick=${() => setKind(k)}>${l}</button>`)}</div>
      <span class="muted">${meta ? `${meta.total.toLocaleString()} ${ABOUT[kind]}` : ''}</span><span class="grow"></span>
      <button class="btn sm cat-likes" onClick=${() => { clear(); setOpen(null); setPicking(true); }}>Genres you like</button>
      <input class="input cat-search" placeholder=${`Search every ${one}…`} value=${q} onInput=${(e) => { setQ(e.target.value); setOpen(null); }} />
    </div>
    <div class="cat-filters">
      <select class="select" value=${sort} onChange=${(e) => setSort(e.target.value)}>${SORTS.map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select>
      <select class="select" value=${decade || ''} onChange=${(e) => setDecade(+e.target.value || null)}><option value="">Any decade</option>${(meta?.decades || []).map((d) => html`<option value=${d}>${d}s</option>`)}</select>
      <button class=${'chip' + (playable ? ' on' : '')} onClick=${() => setPlayable(!playable)}>▶ Plays now</button>
      <div class="cat-chips">${(meta?.genres || []).slice(0, 30).map((g) => html`<button class=${'chip' + (genres.includes(g) ? ' on' : '')} onClick=${() => toggleGenre(g)}>${g}</button>`)}</div>
      ${filtering && html`<button class="btn sm ghost" onClick=${clear}>Clear</button>`}
    </div>
    <main class="cat-main" ref=${main}>
      ${askLikes ? html`<${GenrePicker} kind=${kind} genres=${meta.genres} picked=${likes} onDone=${saveLikes} onClose=${Array.isArray(likes) ? () => setPicking(false) : null} />`
        : open ? html`<${Details} key=${open} id=${open} onOpen=${setOpen} onBack=${() => setOpen(null)} onPlay=${onPlay} toast=${toast} torrentMode=${torrentMode} onFullSearch=${onFullSearch} onPlayEpisode=${onPlayEpisode} />`
        : filtering ? html`<div class="muted small cat-count">${res ? `${res.total.toLocaleString()} ${res.total === 1 ? one : many}` : 'Searching…'}</div>
          <div class="cat-grid">${(res?.items || []).map((m) => html`<${Card} key=${m.id} m=${m} onOpen=${setOpen} />`)}</div>
          ${res && res.items.length < res.total && html`<div class="cat-more"><button class="btn" onClick=${() => setPage((p) => p + 1)}>Show more</button></div>`}`
          : html`${heroItem && html`<${Hero} m=${heroItem} onOpen=${setOpen} />`}${(home?.rows || []).map((r) => html`<${Row} key=${r.title} title=${r.title} items=${r.items} onOpen=${setOpen} />`)}`}
    </main>
  </div>`;
}
