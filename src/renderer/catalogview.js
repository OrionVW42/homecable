// The Movies tab: every American film from 1950 on, as covers, in HomeCable's black and
// orange. Rows on the front page; search, filters and sorting across the whole index; a page
// for each film with its story, credits and the ways to play it, or "No streams available".
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { tv, Icon, fmtDur } from './util.js';

const SORTS = [['popular', 'Most known'], ['newest', 'Newest'], ['oldest', 'Oldest'], ['az', 'A–Z'], ['za', 'Z–A']];
const plain = (e) => String(e?.message || e).replace(/^.*Error: /, '');
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
  return html`<button class="cat-card" ref=${ref} title=${`${m.title} (${m.year})`} onClick=${() => onOpen(m.id)}>
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

function Details({ id, onOpen, onBack, onPlay, toast }) {
  const [d, setD] = useState(null);
  const [sources, setSources] = useState(null);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    setD(null); setSources(null);
    tv.catalogDetails(id).then(setD).catch((e) => toast(plain(e)));
    tv.catalogSources(id).then(setSources).catch(() => setSources([]));
  }, [id]);
  const play = async (quality) => {
    setBusy(quality);
    try { const r = await tv.catalogOpen(id, quality); onPlay(r.itemId); } catch (e) { toast(plain(e)); }
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
        ${d.genres?.length > 0 && html`<div class="cat-genres">${d.genres.map((g) => html`<span>${g}</span>`)}</div>`}
        ${d.summary && html`<p>${d.summary}</p>`}
        ${d.directors?.length > 0 && html`<div class="cat-credit"><b>Directed by</b> ${d.directors.join(', ')}</div>`}
        ${d.cast?.length > 0 && html`<div class="cat-credit"><b>Starring</b> ${d.cast.join(', ')}</div>`}
        <div class="cat-streams">
          ${sources === null ? html`<span class="muted">Looking for streams…</span>`
            : !sources.length ? html`<div class="cat-nostream">No streams available</div>`
              : sources.map((s) => html`<button class="btn cat-playbtn" disabled=${!!busy} onClick=${() => play(s.quality)}><${Icon.play} /> ${busy === s.quality ? 'Starting…' : `${d.resumeAt ? 'Resume' : 'Play'} ${s.quality}`}<small>${s.sourceName}</small></button>`)}
        </div>
        ${d.resumeAt > 0 && html`<div class="muted small">You stopped at ${fmtDur(d.resumeAt)}.</div>`}
      </div>
    </div>
    ${d.sameName?.length > 0 && html`<${Row} title="Other films with this name" items=${d.sameName} onOpen=${onOpen} />`}
    ${d.similar?.length > 0 && html`<${Row} title="More like this" items=${d.similar} onOpen=${onOpen} />`}
  </div>`;
}

export function CatalogView({ settings, setSettings, onPlay, toast }) {
  const prefs = settings?.catalogPrefs || {};
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

  useEffect(() => { tv.catalogMeta().then(setMeta).catch(() => {}); tv.catalogHome().then(setHome).catch(() => {}); }, []);
  useEffect(() => { if (!open) tv.catalogHome().then(setHome).catch(() => {}); }, [open]);
  // What you were looking for is remembered between visits.
  useEffect(() => { setSettings?.({ catalogPrefs: { sort, genres, decade, playable } }); }, [sort, genres, decade, playable]);
  useEffect(() => { setPage(0); }, [q, sort, genres, decade, playable]);
  useEffect(() => {
    if (!filtering) { setRes(null); return undefined; }
    const t = setTimeout(() => tv.catalogBrowse({ q, genres, decade, sort, playable, page }).then((r) => setRes((cur) => (page > 0 && cur ? { ...r, items: [...cur.items, ...r.items] } : r))).catch(() => {}), 180);
    return () => clearTimeout(t);
  }, [q, sort, genres, decade, playable, page, filtering]);
  useEffect(() => { main.current?.scrollTo({ top: 0 }); }, [open]);
  const toggleGenre = (g) => setGenres((l) => (l.includes(g) ? l.filter((x) => x !== g) : [...l, g]));
  const clear = () => { setQ(''); setGenres([]); setDecade(null); setPlayable(false); setSort('popular'); };

  return html`<div class="overlay cat">
    <div class="overlay-head cat-top">
      <h2>Movies</h2><span class="muted">${meta ? `${meta.total.toLocaleString()} American films, 1950 to today` : ''}</span><span class="grow"></span>
      <input class="input cat-search" placeholder="Search every film…" value=${q} onInput=${(e) => { setQ(e.target.value); setOpen(null); }} />
    </div>
    <div class="cat-filters">
      <select class="select" value=${sort} onChange=${(e) => setSort(e.target.value)}>${SORTS.map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select>
      <select class="select" value=${decade || ''} onChange=${(e) => setDecade(+e.target.value || null)}><option value="">Any decade</option>${(meta?.decades || []).map((d) => html`<option value=${d}>${d}s</option>`)}</select>
      <button class=${'chip' + (playable ? ' on' : '')} onClick=${() => setPlayable(!playable)}>▶ Plays now</button>
      <div class="cat-chips">${(meta?.genres || []).slice(0, 30).map((g) => html`<button class=${'chip' + (genres.includes(g) ? ' on' : '')} onClick=${() => toggleGenre(g)}>${g}</button>`)}</div>
      ${filtering && html`<button class="btn sm ghost" onClick=${clear}>Clear</button>`}
    </div>
    <main class="cat-main" ref=${main}>
      ${open ? html`<${Details} id=${open} onOpen=${setOpen} onBack=${() => setOpen(null)} onPlay=${onPlay} toast=${toast} />`
        : filtering ? html`<div class="muted small cat-count">${res ? `${res.total.toLocaleString()} film${res.total === 1 ? '' : 's'}` : 'Searching…'}</div>
          <div class="cat-grid">${(res?.items || []).map((m) => html`<${Card} key=${m.id} m=${m} onOpen=${setOpen} />`)}</div>
          ${res && res.items.length < res.total && html`<div class="cat-more"><button class="btn" onClick=${() => setPage((p) => p + 1)}>Show more</button></div>`}`
          : (home?.rows || []).map((r) => html`<${Row} key=${r.title} title=${r.title} items=${r.items} onOpen=${setOpen} />`)}
    </main>
  </div>`;
}
