// Movies, TV shows and anime, as covers, in HomeCable's black and orange. Pick the genres you
// like, then rows on the front page; search, filters and sorting across the whole index; a page
// for each title with its story and the ways to play it, or "No streams available". Shows have
// their seasons and episodes, with their movies, OVAs and specials in the order to watch.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
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
function ShowGuide({ id, onPlayEpisode, toast }) {
  const [g, setG] = useState(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState(null);
  const [busy, setBusy] = useState('');
  useEffect(() => { let live = true; setG(null); setErr(''); setSel(null); tv.catalogGuide(id).then((r) => { if (live) setG(r); }).catch((e) => { if (live) setErr(plain(e)); }); return () => { live = false; }; }, [id]);
  if (err) return html`<div class="cat-nostream cat-guide-msg">${err}</div>`;
  if (!g) return html`<div class="muted cat-guide-msg">Getting the episode list…</div>`;
  if (!g.parts?.length) return html`<div class="cat-guide"><div class="cat-nostream">No streams available</div><div class="muted small cat-guide-msg">No episode list was found for this title.</div></div>`;
  const has = (e) => !!g.sources[e.key];
  const anyInPart = (p) => p.episodes.some(has);
  const lastPart = g.last && g.parts.find((p) => p.episodes.some((e) => e.key === g.last));
  const part = g.parts.find((p) => p.key === sel) || lastPart || g.parts.find(anyInPart) || g.parts[0];
  const start = async (key) => {
    setBusy(key);
    try { onPlayEpisode(await tv.catalogOpenEpisode(id, key)); } catch (e) { toast(plain(e)); }
    setBusy('');
  };
  const total = Object.keys(g.sources).length;
  const count = part.episodes.filter(has).length;
  const single = part.episodes.length === 1 && part.type !== 'season';
  return html`<section class="cat-guide">
    <div class="cat-guide-top"><h3>Watch order</h3>${total === 0 && html`<div class="cat-nostream">No streams available</div>`}</div>
    <div class="cat-parts" role="tablist">${g.parts.map((p, i) => html`<button role="tab" aria-selected=${p === part} class=${'cat-part' + (p === part ? ' on' : '') + (anyInPart(p) ? ' plays' : '')} title=${p.title} onClick=${() => setSel(p.key)}><small>${i + 1}</small><span>${p.type === 'season' ? p.label : p.title || p.label}</span></button>`)}</div>
    <div class="cat-part-head"><div><b>${part.title}</b><span class="muted small">${[part.year, single ? '' : `${part.episodes.length} episode${part.episodes.length === 1 ? '' : 's'}`, count && !single ? `${count} can play` : ''].filter(Boolean).join(' · ')}</span></div>
      ${count > 0 ? html`<button class="btn cat-playbtn" disabled=${!!busy} onClick=${() => start(part.key)}><${Icon.play} /> ${busy === part.key ? 'Starting…' : single ? 'Play' : 'Play season'}</button>` : html`<span class="muted small">No streams available</span>`}</div>
    ${!single && html`<ol class="cat-eps">${part.episodes.map((e) => { const p = g.progress?.[e.key]; const s = g.sources[e.key]; return html`<li class=${'cat-ep' + (s ? ' plays' : '') + (p?.watched ? ' seen' : '')}>
      <span class="cat-ep-n">${e.n}</span>
      <div class="cat-ep-text"><b>${e.title}</b><span class="muted small">${[dayOf(e.air), e.runtime ? fmtDur(e.runtime * 60) : '', s?.sourceName, p?.watched ? '✓ Watched' : p?.resume ? `Stopped at ${fmtDur(p.resume)}` : ''].filter(Boolean).join(' · ')}</span>${e.summary && html`<p>${e.summary}</p>`}</div>
      ${s && html`<button class="btn sm" disabled=${!!busy} onClick=${() => start(e.key)}><${Icon.play} /> ${busy === e.key ? 'Starting…' : p?.resume && !p.watched ? 'Resume' : 'Play'}</button>`}
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
  useEffect(() => {
    setD(null); setSources(null);
    tv.catalogDetails(id).then(setD).catch((e) => toast(plain(e)));
    if (!torrentMode && !isShow) tv.catalogSources(id).then(setSources).catch(() => setSources([]));
  }, [id]);
  // Torrent mode: search the turned-on sources for this film and keep the best-seeded
  // result per quality as it comes in, so each quality shows one play button.
  const title = d?.title;
  useEffect(() => {
    if (!torrentMode || isShow || !title) return;
    let sid = null, live = true; const buf = [], pend = [];
    setTor(null);
    const take = (m) => {
      if (m.event === 'search') { buf.push(...(m.results || []).map((r) => ({ ...r, key: `${r.engine}|${r.link || r.page}` }))); const best = {}; for (const r of buf) { const q = qualityOf(r.name); if (!best[q] || (r.seeds || 0) > (best[q].seeds || 0)) best[q] = r; } if (live) setTor((t) => ({ best, done: !!t?.done })); }
      else if (m.event === 'search-done' && live) setTor((t) => ({ best: t?.best || {}, done: true }));
    };
    const off = tv.onTorrentSearch((m) => { if (sid == null) { pend.push(m); return; } if (m.searchId === sid) take(m); });
    tv.searchRun(title, 'all').then((r) => { sid = r.searchId; for (const m of pend) if (m.searchId === sid) take(m); })
      .catch((e) => { if (live) setTor({ best: {}, done: true, error: plain(e) }); });
    return () => { live = false; off?.(); };
  }, [torrentMode, title]);
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
          ${torrentMode ? torrentButtons({ tor, busy, playTorrent })
            : sources === null ? html`<span class="muted">Looking for streams…</span>`
              : !sources.length ? html`<div class="cat-nostream">No streams available</div>`
                : sources.map((s) => html`<button class="btn cat-playbtn" disabled=${!!busy} onClick=${() => play(s.quality)}><${Icon.play} /> ${busy === s.quality ? 'Starting…' : `${d.resumeAt ? 'Resume' : 'Play'} ${s.quality}`}<small>${s.sourceName}</small></button>`)}
          ${torrentMode && onFullSearch && html`<button class="btn ghost cat-fullsearch" onClick=${() => onFullSearch(d.title)}><${Icon.magnet} /> Search all torrent sources…<small>if none of these are right</small></button>`}
        </div>`}
        ${d.resumeAt > 0 && html`<div class="muted small">You stopped at ${fmtDur(d.resumeAt)}.</div>`}
      </div>
    </div>
    ${d.kind !== 'movie' && html`<${ShowGuide} id=${id} onPlayEpisode=${onPlayEpisode} toast=${toast} />`}
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
