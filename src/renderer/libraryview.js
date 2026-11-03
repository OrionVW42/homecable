// The library, Netflix-style: every show and movie as a cover, in rows (Home) or a grid,
// a show opens to its seasons and episodes, movie series are grouped. Drag anything onto
// a channel; right-click hides; ✏ Edit opens the full editor.
import { html } from 'htm/preact';
import { TorrentsPanel } from './torrents.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { tv, fmtDur, ChannelLogo, Icon, epLabel } from './util.js';
import { SourcesPicker, FreeTvPicker, DEFAULT_FREE, freeFromSettings, applyFreeTv } from './sources.js';
import { ArtModal } from './ondemand.js';

const DND = 'application/x-homecable';
// Ads are never media — they live in Settings → Commercial breaks, not here.
const VIEWS = [
  ['all', 'Home', '🏠'], ['shows', 'TV shows', '📺'], ['movie', 'Movies', '🎬'], ['unknown', 'Not identified', '❔'],
  ['short', 'Short clips', '✂️'], ['music', 'Music', '🎵'], ['clip', 'Other videos', '📼'], ['recent', 'Recently added', '✨'],
  ['pending', 'New — needs review', '📥'], ['hidden', 'Hidden', '🚫'],
];
const KIND_SOURCE = { movie: 'All movies', short: 'All short clips', music: 'All music', clip: 'All other videos' };
const LIST_VIEWS = new Set(['short', 'music', 'clip', 'recent', 'pending', 'hidden']); // plain thumbnail grids
const errText = (e) => String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, '');

function dragSources(e, sources) {
  e.dataTransfer.setData(DND, JSON.stringify(sources));
  e.dataTransfer.effectAllowed = 'copy';
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.textContent = sources.length === 1 ? (sources[0].label || 'Item') : `${sources.length} items`;
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 20, 20);
  setTimeout(() => ghost.remove(), 0);
}
const readDrop = (e) => { try { return JSON.parse(e.dataTransfer.getData(DND) || '[]'); } catch { return []; } };

function Thumb({ item, thumb, poster }) {
  const [bad, setBad] = useState(false);
  const src = poster || item?.poster || item?.art || (item && item.kind !== 'music' ? thumb.replace('ID', item.id) : null);
  if (!src || bad) return html`<div class="lib-art-fallback">${item?.kind === 'music' ? '♪' : (item?.show || item?.title || '?').slice(0, 2).toUpperCase()}</div>`;
  return html`<img src=${src} loading="lazy" onError=${() => setBad(true)} />`;
}

// A cover: the real poster, or — when nothing could be found — one made from a frame of
// the video with its name on it, so every title still looks like a title.
function Cover({ poster, frame, title, label }) {
  const [bad, setBad] = useState(false);
  const [badFrame, setBadFrame] = useState(false);
  if (poster && !bad) return html`<img class="nf-img" src=${poster} loading="lazy" alt="" onError=${() => setBad(true)} />`;
  return html`<div class="nf-made">
    ${frame && !badFrame && html`<img src=${frame} loading="lazy" alt="" onError=${() => setBadFrame(true)} />`}
    <div class="nf-made-text"><b>${title}</b>${label && html`<span>${label}</span>`}</div></div>`;
}

// Movie series: titles that start the same ("Avatar…", "Spider-Man…", "The Naked Gun…").
const words = (t) => String(t || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'my', 'to', 'love', 'night', 'day', 'man', 'last', 'first', 'big', 'little', 'black', 'white', 'dark', 'blue', 'red', 'new', 'one', 'two', 'all']);
function collectionsOf(movies) {
  const key = (w, n) => (w.length >= n ? w.slice(0, n).join(' ') : null);
  const count = new Map();
  const ws = movies.map((m) => [m, words(m.title)]);
  for (const [, w] of ws) for (const n of [1, 2]) { const k = key(w, n); if (k) count.set(k, (count.get(k) || 0) + 1); }
  const ok1 = (k) => k && k.length >= 5 && !STOP.has(k) && !/^\d+$/.test(k);
  const groups = new Map();
  for (const [m, w] of ws) {
    const k2 = key(w, 2), k1 = key(w, 1);
    const k = k2 && count.get(k2) >= 2 && !(STOP.has(w[0]) && STOP.has(w[1])) ? k2 : ok1(k1) && count.get(k1) >= 2 ? k1 : null;
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const out = [];
  for (const [k, ms] of groups) {
    if (ms.length < 2) continue;
    // Its name: the words every title shares, in the first title's own spelling.
    const first = ms.map((m) => m.title).sort((a, b) => a.length - b.length)[0];
    const n = k.split(' ').length;
    let name = '', got = 0;
    for (const tok of first.split(/\s+/)) { if (got >= n) break; name += (name ? ' ' : '') + tok; got += words(tok).length; }
    name = name.replace(/[:\-–—,]+$/, '');
    out.push({ key: 'col:' + k, name, movies: ms.sort((a, b) => (a.year || a.yearFound || 0) - (b.year || b.yearFound || 0) || a.title.localeCompare(b.title)) });
  }
  return out;
}

// One horizontal row of covers, with arrows (Netflix-style).
function Row({ title, children, count }) {
  const ref = useRef(null);
  const [ends, setEnds] = useState({ left: false, right: false }); // arrows only where there's more to see
  const measure = () => { const el = ref.current; if (el) setEnds({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 }); };
  useEffect(() => { measure(); window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure); }, [count]);
  const go = (d) => ref.current?.scrollBy({ left: d * ref.current.clientWidth * 0.85, behavior: 'smooth' });
  if (!count) return null;
  return html`<section class="nf-row"><h3>${title}<span class="faint small"> ${count}</span></h3>
    <div class="nf-row-wrap">${ends.left && html`<button class="nf-arrow left" onClick=${() => go(-1)} aria-label="Back"><${Icon.left} /></button>`}
      <div class="nf-row-track" ref=${ref} onScroll=${measure}>${children}</div>
      ${ends.right && html`<button class="nf-arrow right" onClick=${() => go(1)} aria-label="More"><${Icon.right} /></button>`}</div></section>`;
}

// Channels rail: every channel is a drop target, plus "new channel from these".
function DropRail({ channels, onDrop, onNew }) {
  const [over, setOver] = useState(null);
  const zone = (id, fn) => ({
    onDragOver: (e) => { if (e.dataTransfer.types.includes(DND)) { e.preventDefault(); setOver(id); } },
    onDragLeave: () => setOver(null),
    onDrop: (e) => { e.preventDefault(); setOver(null); fn(readDrop(e)); },
  });
  return html`<aside class="lib-rail">
    <div class="rail-title">Drag here to add to a channel</div>
    <div class=${'rail-new' + (over === 'new' ? ' over' : '')} ...${zone('new', onNew)}><${Icon.plus} /> New channel from these</div>
    <div class="rail-list">
      ${channels.filter((c) => !c.iptv).map((c) => html`<div class=${'rail-ch' + (over === c.id ? ' over' : '')} ...${zone(c.id, (s) => onDrop(c, s))}>
        <span class="faint">${c.number}</span><${ChannelLogo} ch=${c} size=${28} /><span class="grow">${c.name}</span></div>`)}
    </div>
  </aside>`;
}

export function LibraryPanel({ stats, channels, setChannels, onPlay, onEdit, toast, isAdult = true }) {
  const [data, setData] = useState(null);
  const [view, setView] = useState('all');
  const [source, setSource] = useState(null); // filter by folder / server
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('title');
  const [sel, setSel] = useState(new Set());
  const [open, setOpen] = useState(null);     // details page: { type: 'show' | 'movie' | 'collection', key|id }
  const [episodes, setEpisodes] = useState([]);
  const [season, setSeason] = useState(null);
  const [dialog, setDialog] = useState(null); // 'sources' | 'free' | 'torrents' | { addTo: sources }
  const [edit, setEdit] = useState(null);     // the Edit dialog (name, pictures, tags, where it shows)
  const [tagging, setTagging] = useState(false); // "Find covers & tags" is running
  const [limit, setLimit] = useState(180);
  const [genre, setGenre] = useState(null);
  const mainRef = useRef(null);
  const [seed] = useState(() => Math.random()); // which recent title is featured (stays put while you browse)

  const load = () => tv.browse().then(setData);
  useEffect(() => { load(); }, [stats]);
  useEffect(() => { const off = tv.onProgressChanged?.(() => load()); return () => off?.(); }, []);
  useEffect(() => { if (open?.type === 'show') tv.episodes(open.key).then(setEpisodes); }, [open?.key, data]);
  useEffect(() => { setLimit(180); setSel(new Set()); }, [view, source, q]);
  useEffect(() => { setGenre(null); }, [view]);
  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); }, [open, view, source]);

  const thumb = data?.media.thumb || '';
  const frame = (id) => (id ? thumb.replace('ID', id) : null);
  const resume = data?.progress?.resume || {};
  const watched = data?.progress?.watched || {};
  const items = (view === 'hidden' ? data?.hidden : data?.items) || [];
  const inSource = (it) => !source || (source.type === 'server' ? it.server === source.id : String(it.path || '').toLowerCase().startsWith(source.path.toLowerCase()));
  const ql = q.trim().toLowerCase();
  const match = (it) => !ql || `${it.title} ${it.show || ''} ${it.year || ''}`.toLowerCase().includes(ql);
  const inGenre = (x) => !genre || (x.genres || []).includes(genre);

  // ---- what's in the library, as titles ----
  const shows = useMemo(() => (data?.shows || []).filter((s) => (!ql || s.name.toLowerCase().includes(ql)) && inGenre(s)
    && (!source || items.some((it) => s.keys.includes(it.showKey) && inSource(it)))), [data, q, source, genre]);
  const movies = useMemo(() => items.filter((it) => it.kind === 'movie' && inSource(it) && match(it) && inGenre(it)), [items, source, q, genre]);
  const collections = useMemo(() => collectionsOf(movies.filter((m) => !m.unidentified)), [movies]);
  const inCollection = useMemo(() => new Set(collections.flatMap((c) => c.movies.map((m) => m.id))), [collections]);
  const genres = useMemo(() => {
    const count = new Map();
    for (const x of [...(data?.shows || []), ...(data?.items || []).filter((i) => i.kind === 'movie')]) for (const g of x.genres || []) count.set(g, (count.get(g) || 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(b[0])).map(([g]) => g).slice(0, 24);
  }, [data]);
  const by = sort === 'added' ? (a, b) => (b.added || 0) - (a.added || 0)
    : sort === 'year' ? (a, b) => (b.year || b.yearFound || 0) - (a.year || a.yearFound || 0) || String(a.name || a.title).localeCompare(String(b.name || b.title))
    : (a, b) => String(a.name || a.title).localeCompare(String(b.name || b.title), undefined, { numeric: true });

  // The plain lists (clips, music, recent, review, hidden): thumbnails as before.
  const list = useMemo(() => {
    let l = items.filter((it) => inSource(it) && match(it) && (view === 'hidden' || inGenre(it)));
    if (view === 'pending') l = l.filter((it) => it.status === 'pending');
    else if (view === 'recent') return [...l].sort((a, b) => b.added - a.added).slice(0, 300);
    else if (view !== 'hidden') l = l.filter((it) => it.kind === view);
    return [...l].sort(sort === 'length' ? (a, b) => b.duration - a.duration : by);
  }, [items, view, source, q, sort, genre]);

  const srcOf = (it) => ({ type: 'item', id: it.id, label: it.show ? `${it.show} ${epLabel(it)}` : it.title });
  const showSrc = (s) => ({ type: 'show', key: s.key, label: s.name });
  const selectedSources = () => {
    const out = [];
    for (const id of sel) {
      if (id.startsWith('show:')) { const s = (data?.shows || []).find((x) => 'show:' + x.key === id); if (s) out.push(...s.keys.map((k) => ({ type: 'show', key: k, label: s.name }))); }
      else { const it = items.find((x) => x.id === id); if (it) out.push(srcOf(it)); }
    }
    return out;
  };
  const clickSel = (id, e) => setSel((cur) => {
    const n = new Set(e.ctrlKey || e.metaKey || e.shiftKey ? cur : []);
    if (n.has(id) && (e.ctrlKey || e.metaKey)) n.delete(id); else n.add(id);
    return n;
  });
  const startDrag = (e, id, own) => dragSources(e, sel.has(id) && sel.size > 1 ? selectedSources() : Array.isArray(own) ? own : [own]);
  const addTo = async (ch, sources) => {
    if (!sources.length) return;
    setChannels(await tv.addToChannel(ch.id, sources));
    toast(`Added ${sources.length === 1 ? sources[0].label : sources.length + ' items'} to ${ch.name}`);
  };
  const newFrom = (sources) => {
    if (!sources.length) return;
    onEdit({ name: sources.length === 1 ? sources[0].label : '', number: '', sources, filler: [], blocks: [], order: sources.length === 1 && sources[0].type === 'show' ? 'sequential' : 'shuffle', align: 30, color: '', logo: '' });
  };

  const pendingN = (data?.items || []).filter((it) => it.status === 'pending').length;
  const tagAll = () => {
    setTagging(true);
    toast('🏷 Looking everything up — covers and tags fill in as they’re found');
    tv.metaRefreshAll()
      .then((r) => { toast(`🏷 Found info for ${r.shows} show${r.shows === 1 ? '' : 's'} and ${r.movies} movie${r.movies === 1 ? '' : 's'}`); load(); })
      .catch((e) => toast(errText(e)))
      .finally(() => setTagging(false));
  };
  const fromTorrent = (x) => String(x?.server || '').startsWith('torrent:');
  const keepAction = (key) => ({ label: '📌 Keep (never auto-delete)', run: () => tv.torrentKeep(key, true).then(() => toast('📌 Kept — the torrent storage limit won’t delete it')) });
  const editShow = (s) => {
    const torrentShow = items.some((it) => s.keys.includes(it.showKey) && fromTorrent(it));
    setEdit({ kind: 'show', name: s.name, year: s.year, genres: s.genres || [], renamed: !!s.renamed, target: { showKey: s.key, name: s.name },
      actions: [...(torrentShow ? [keepAction('show:' + s.key)] : []), { label: '🚫 Hide this show', run: () => hideShow(s) }] });
  };
  const editItem = (it) => setEdit({ kind: 'movie', name: it.title, year: it.year || it.yearFound, genres: it.genres || [], renamed: !!it.renamed, target: { itemId: it.id }, others: movies.filter((x) => x.id !== it.id).map(({ id, title }) => ({ id, title })),
    actions: [...(fromTorrent(it) ? [keepAction(it.id)] : []), view === 'hidden' ? { label: '👁 Show it again', run: () => hideToggle(it, false) } : { label: '🚫 Hide it', run: () => hideToggle(it, true) }] });
  // A view and a folder filter are one choice at a time: picking one clears the other.
  const nav = (v) => { setView(v); setOpen(null); setSource(null); };
  const pickSource = (s) => { setSource(s); setOpen(null); if (LIST_VIEWS.has(view) || view === 'unknown') setView('all'); };
  // Right-click any video to hide it everywhere (channels and walls too) — quick for things you don't want.
  // It waits under Library -> Hidden, where a right-click (or 👁) brings it back. ✏ opens the editor.
  const hideToggle = async (it, on) => {
    await tv.itemsHide([it.id], on).catch((e) => toast(errText(e)));
    toast(on ? `🚫 “${it.title}” is hidden — find it under Hidden` : `👁 “${it.title}” is back`);
    load();
  };
  const hideShow = async (sh) => {
    const eps = await tv.episodes(sh.key);
    await tv.itemsHide(eps.map((e) => e.id), true).catch(() => {});
    toast(`🚫 “${sh.name}” is hidden (${eps.length} episodes) — find them under Hidden`);
    if (open?.key === sh.key) setOpen(null);
    load();
  };
  const folderSrc = (f) => ({ type: 'folder', path: f, label: f.split(/[\\/]/).filter(Boolean).pop() || f });
  // Two folders can share a last name ("Videos" and "OneDrive\Videos") — say which is which.
  const folderLabel = (f) => {
    const parts = f.split(/[\\/]/).filter(Boolean);
    const same = stats.folders.filter((x) => folderSrc(x).label.toLowerCase() === parts[parts.length - 1].toLowerCase()).length > 1;
    return same && parts.length > 1 ? `${parts[parts.length - 2]} › ${parts[parts.length - 1]}` : parts[parts.length - 1] || f;
  };

  // Where a show is up to: the episode in progress, else the first unwatched after the last watched one.
  const nextEp = (eps) => {
    const mid = eps.find((e) => resume[e.id]);
    if (mid) return mid;
    let last = -1;
    eps.forEach((e, i) => { if (watched[e.id]) last = i; });
    return eps[last + 1] || eps[0];
  };
  const pct = (it) => (resume[it.id] && it.duration ? Math.min(100, (resume[it.id] / it.duration) * 100) : watched[it.id] ? 100 : 0);

  // ---- cards ----
  const editBtn = (fn) => isAdult && html`<button class="lib-edit" title="Edit name, pictures, tags & where it shows" onClick=${(e) => { e.stopPropagation(); fn(); }}><${Icon.edit} /> Edit</button>`;
  const ShowCard = (s) => {
    const id = 'show:' + s.key;
    return html`<div class=${'lib-card nf-card' + (sel.has(id) ? ' sel' : '')} key=${id} draggable="true" tabindex="0" title=${s.name}
        onContextMenu=${(e) => { if (!isAdult) return; e.preventDefault(); hideShow(s); }}
        onDragStart=${(e) => startDrag(e, id, s.keys.map((k) => ({ type: 'show', key: k, label: s.name })))}
        onClick=${(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? clickSel(id, e) : setOpen({ type: 'show', key: s.key }))}
        onKeyDown=${(e) => e.key === 'Enter' && setOpen({ type: 'show', key: s.key })}>
      <div class="nf-cover"><${Cover} poster=${s.poster} frame=${frame(s.thumbId)} title=${s.name} label="TV show" />
        <span class="nf-badge">${s.seasons > 1 ? `${s.seasons} seasons` : `${s.count} ep`}</span>${editBtn(() => editShow(s))}</div>
      <div class="lib-cap"><b>${s.name}</b><span>${[s.year, s.genres?.[0]].filter(Boolean).join(' · ') || `${s.count} episodes`}</span></div></div>`;
  };
  const MovieCard = (it) => html`<div class=${'lib-card nf-card' + (sel.has(it.id) ? ' sel' : '')} key=${it.id} draggable="true" tabindex="0" title=${it.title}
      onContextMenu=${(e) => { if (!isAdult) return; e.preventDefault(); hideToggle(it, view !== 'hidden'); }}
      onDragStart=${(e) => startDrag(e, it.id, srcOf(it))}
      onClick=${(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? clickSel(it.id, e) : setOpen({ type: 'movie', id: it.id }))} onDblClick=${() => onPlay(it.id)}
      onKeyDown=${(e) => e.key === 'Enter' && setOpen({ type: 'movie', id: it.id })}>
    <div class="nf-cover"><${Cover} poster=${it.poster || it.art} frame=${frame(it.id)} title=${it.title} label=${it.kind === 'movie' ? 'Movie' : ''} />
      <button class="lib-play" title="Play now" onClick=${(e) => { e.stopPropagation(); onPlay(it.id); }}><${Icon.play} /></button>
      ${editBtn(() => editItem(it))}${pct(it) > 0 && html`<span class="nf-progress"><i style=${{ width: pct(it) + '%' }}></i></span>`}
      ${it.status === 'pending' && html`<span class="lib-tag new">NEW</span>`}</div>
    <div class="lib-cap"><b>${it.title}</b><span>${[it.year || it.yearFound, it.duration ? fmtDur(it.duration) : null, it.remote ? '🌐' : ''].filter(Boolean).join(' · ')}</span></div></div>`;
  const CollectionCard = (c) => html`<div class="lib-card nf-card nf-col" key=${c.key} draggable="true" tabindex="0" title=${c.name}
      onDragStart=${(e) => startDrag(e, c.key, c.movies.map(srcOf))} onClick=${() => setOpen({ type: 'collection', key: c.key })}
      onKeyDown=${(e) => e.key === 'Enter' && setOpen({ type: 'collection', key: c.key })}>
    <div class="nf-cover nf-stack">${c.movies.slice(0, 3).reverse().map((m, i, a) => html`<div class="nf-stack-card" style=${{ '--i': a.length - 1 - i }}><${Cover} poster=${m.poster || m.art} frame=${frame(m.id)} title=${m.title} /></div>`)}
      <span class="nf-badge">${c.movies.length} movies</span></div>
    <div class="lib-cap"><b>${c.name}</b><span>Movie series · ${c.movies.map((m) => m.year || m.yearFound).filter(Boolean).sort()[0] || ''}${c.movies.length > 1 ? '–' : ''}${c.movies.map((m) => m.year || m.yearFound).filter(Boolean).sort().pop() || ''}</span></div></div>`;
  const WideCard = (it) => html`<div class=${'lib-card nf-wide' + (sel.has(it.id) ? ' sel' : '')} key=${it.id} draggable="true" tabindex="0"
      onContextMenu=${(e) => { if (!isAdult) return; e.preventDefault(); hideToggle(it, view !== 'hidden'); }}
      onDragStart=${(e) => startDrag(e, it.id, srcOf(it))} onClick=${(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? clickSel(it.id, e) : onPlay(it.id))}>
    <div class="lib-art"><${Thumb} item=${it} thumb=${thumb} />
      <button class="lib-play" title="Play now" onClick=${(e) => { e.stopPropagation(); onPlay(it.id); }}><${Icon.play} /></button>
      ${pct(it) > 0 && html`<span class="nf-progress"><i style=${{ width: pct(it) + '%' }}></i></span>`}<span class="lib-tag">${fmtDur(it.duration)}</span></div>
    <div class="lib-cap"><b>${it.show ? `${it.show}` : it.title}</b><span>${it.show ? `${epLabel(it)} · ${it.title}` : it.kind}</span></div></div>`;

  if (!data) return html`<div class="overlay"><div class="overlay-head"><h2>Library</h2></div><div class="overlay-body muted">Loading…</div></div>`;

  // ---- Home: a featured title up top, then rows ----
  const known = (x) => !x.unidentified;
  const homeShows = shows.filter(known).sort(by);
  const homeMovies = [...collections, ...movies.filter((m) => known(m) && !inCollection.has(m.id))].sort((a, b) => by(a.movies ? { ...a.movies[0], title: a.name } : a, b.movies ? { ...b.movies[0], title: b.name } : b));
  const unknownT = [...shows.filter((s) => s.unidentified), ...movies.filter((m) => m.unidentified)];
  const cont = (data.items || []).filter((it) => resume[it.id] && inSource(it)).sort((a, b) => (b.added || 0) - (a.added || 0)).slice(0, 30);
  const titleCard = (x) => (x.keys ? ShowCard(x) : x.movies ? CollectionCard(x) : MovieCard(x));
  const pool = [...homeShows, ...movies.filter(known)].filter((x) => x.poster && (x.summary || x.genres?.length)).sort((a, b) => (b.added || 0) - (a.added || 0));
  const featured = pool.length ? pool[Math.floor(seed * Math.min(5, pool.length))] : null;
  const genreRows = genres.slice(0, 8).map((g) => [g, [...homeShows, ...movies.filter(known)].filter((x) => (x.genres || []).includes(g))]).filter(([, l]) => l.length >= 2);
  const recent = [...homeShows, ...movies.filter(known)].sort((a, b) => (b.added || 0) - (a.added || 0)).slice(0, 24);
  const clips = items.filter((it) => (it.kind === 'short' || it.kind === 'clip') && inSource(it) && match(it) && !it.remote);
  const music = items.filter((it) => it.kind === 'music' && inSource(it) && match(it));
  const streams = items.filter((it) => it.remote && it.kind !== 'episode' && it.kind !== 'movie' && inSource(it) && match(it));

  const Hero = (x) => {
    const isShow = !!x.keys;
    return html`<div class="nf-hero" style=${{ '--bg': `url("${x.poster}")` }}>
      <div class="nf-hero-text">
        <span class="nf-kicker">${isShow ? 'TV show' : 'Movie'}${x.genres?.length ? ' · ' + x.genres.slice(0, 3).join(' · ') : ''}</span>
        <h2>${x.name || x.title}</h2>
        <div class="nf-meta">${[x.year || x.yearFound, isShow ? (x.seasons > 1 ? `${x.seasons} seasons` : `${x.count} episodes`) : x.duration ? fmtDur(x.duration) : null].filter(Boolean).join(' · ')}</div>
        ${x.summary && html`<p>${x.summary}</p>`}
        <div class="row" style="gap:10px;justify-content:flex-start">
          <button class="btn primary nf-big" onClick=${async () => { if (isShow) { const eps = await tv.episodes(x.key); const n = nextEp(eps); if (n) onPlay(n.id); } else onPlay(x.id); }}><${Icon.play} /> Play</button>
          <button class="btn nf-big" onClick=${() => setOpen(isShow ? { type: 'show', key: x.key } : { type: 'movie', id: x.id })}><${Icon.info} /> More info</button></div>
      </div>
      <img class="nf-hero-poster" src=${x.poster} alt="" /></div>`;
  };

  // ---- a title's page ----
  const Details = () => {
    if (open.type === 'collection') {
      const c = collections.find((x) => x.key === open.key);
      if (!c) return html`<div class="muted">That series isn’t here any more.</div>`;
      return html`<div class="nf-page">
        <div class="nf-head" style=${{ '--bg': `url("${c.movies.find((m) => m.poster)?.poster || ''}")` }}><div class="nf-head-text">
          <span class="nf-kicker">Movie series</span><h2>${c.name}</h2><div class="nf-meta">${c.movies.length} movies</div>
          <div class="row" style="gap:10px;justify-content:flex-start"><button class="btn primary nf-big" onClick=${() => onPlay(c.movies[0].id)}><${Icon.play} /> Play the first</button>
            ${isAdult && html`<button class="btn nf-big" onClick=${() => setDialog({ addTo: c.movies.map(srcOf) })}><${Icon.plus} /> Add to channel</button>`}</div></div></div>
        <div class="nf-grid">${c.movies.map(MovieCard)}</div></div>`;
    }
    const isShow = open.type === 'show';
    const s = isShow ? (data.shows || []).find((x) => x.key === open.key || x.keys.includes(open.key)) : null;
    const it = !isShow ? (data.items || []).find((x) => x.id === open.id) : null;
    if (!s && !it) return html`<div class="muted">That isn’t in the library any more.</div>`;
    const x = s || it;
    const eps = isShow ? episodes : [];
    const seasons = [...new Set(eps.map((e) => e.season ?? 0))].sort((a, b) => a - b);
    const cur = seasons.includes(season) ? season : (nextEp(eps)?.season ?? seasons[0]);
    const shown = eps.filter((e) => (e.season ?? 0) === cur);
    const nx = isShow ? nextEp(eps) : null;
    const related = isShow ? (data.items || []).filter((m) => m.kind === 'movie' && words(m.title).join(' ').startsWith(words(s.name).join(' '))) : [];
    const col = !isShow ? collections.find((c) => c.movies.some((m) => m.id === it.id)) : null;
    const playLabel = isShow ? (nx && (resume[nx.id] || watched[eps[0]?.id]) ? `Resume ${epLabel(nx) || ''}` : 'Play') : resume[it.id] ? 'Resume' : 'Play';
    return html`<div class="nf-page">
      <div class="nf-head" style=${{ '--bg': x.poster ? `url("${x.poster}")` : 'none' }}>
        <div class="nf-head-poster"><${Cover} poster=${x.poster || x.art} frame=${frame(isShow ? s.thumbId : it.id)} title=${x.name || x.title} label=${isShow ? 'TV show' : 'Movie'} /></div>
        <div class="nf-head-text">
          <span class="nf-kicker">${isShow ? 'TV show' : 'Movie'}${x.unidentified ? ' · ❔ not identified yet' : ''}</span>
          <h2>${x.name || x.title}</h2>
          <div class="nf-meta">${[x.year || x.yearFound, isShow ? `${s.seasons} season${s.seasons === 1 ? '' : 's'} · ${s.count} episodes` : fmtDur(it.duration), s?.network].filter(Boolean).join(' · ')}</div>
          ${x.genres?.length > 0 && html`<div class="nf-genres">${x.genres.slice(0, 8).map((g) => html`<span>${g}</span>`)}</div>`}
          ${x.summary ? html`<p>${x.summary}</p>` : x.unidentified && isAdult ? html`<p class="muted">Couldn’t work out what this is from its name. Press Edit, type the name it’s known by, and pick its cover.</p>` : ''}
          <div class="row" style="gap:10px;justify-content:flex-start;flex-wrap:wrap">
            <button class="btn primary nf-big" onClick=${() => onPlay(isShow ? nx?.id : it.id)} disabled=${isShow && !nx}><${Icon.play} /> ${playLabel}</button>
            ${isAdult && html`<button class="btn nf-big" onClick=${() => (isShow ? editShow(s) : editItem(it))}><${Icon.edit} /> Edit</button>
              <button class="btn nf-big" onClick=${() => setDialog({ addTo: isShow ? s.keys.map((k) => ({ type: 'show', key: k, label: s.name })) : [srcOf(it)] })}><${Icon.plus} /> Add to channel</button>
              <button class="btn ghost" onClick=${() => (isShow ? hideShow(s) : hideToggle(it, true).then(() => setOpen(null)))}>🚫 Hide</button>`}
          </div>
        </div>
      </div>
      ${isShow && html`<div class="nf-eps-head"><h3>Episodes</h3>
        ${seasons.length > 1 && html`<div class="nf-seasons">${seasons.map((n) => html`<button class=${'chip' + (n === cur ? ' on' : '')} onClick=${() => setSeason(n)}>${n ? `Season ${n}` : 'Specials'}</button>`)}</div>`}</div>
        <div class="nf-eps">${shown.map((ep, i) => html`<div class=${'nf-ep' + (sel.has(ep.id) ? ' sel' : '') + (nx?.id === ep.id ? ' next' : '')} key=${ep.id} draggable="true"
            onDragStart=${(e) => startDrag(e, ep.id, srcOf(ep))} onClick=${(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? clickSel(ep.id, e) : onPlay(ep.id))}
            onContextMenu=${(e) => { if (!isAdult) return; e.preventDefault(); hideToggle(ep, true).then(() => tv.episodes(open.key).then(setEpisodes)); }}>
          <span class="nf-ep-n">${ep.episode ?? i + 1}</span>
          <div class="nf-ep-thumb"><${Thumb} item=${ep} thumb=${thumb} /><span class="nf-ep-play"><${Icon.play} /></span>
            ${pct(ep) > 0 && html`<span class="nf-progress"><i style=${{ width: pct(ep) + '%' }}></i></span>`}</div>
          <div class="nf-ep-text"><b>${ep.title}</b><span>${[epLabel(ep), fmtDur(ep.duration), watched[ep.id] ? '✓ watched' : resume[ep.id] ? `${fmtDur(ep.duration - resume[ep.id])} left` : null].filter(Boolean).join(' · ')}</span></div>
          ${ep.status === 'pending' && html`<span class="badge warn">new</span>`}</div>`)}</div>
        ${related.length > 0 && html`<${Row} title="Movies & specials" count=${related.length}>${related.map(MovieCard)}</${Row}>`}`}
      ${col && html`<${Row} title=${`More in ${col.name}`} count=${col.movies.length - 1}>${col.movies.filter((m) => m.id !== it.id).map(MovieCard)}</${Row}>`}
    </div>`;
  };

  const heading = open ? null : source ? source.label : VIEWS.find((v) => v[0] === view)[1];
  const posterGrid = !open && !LIST_VIEWS.has(view) && (view !== 'all' || ql || genre);
  const gridTitles = view === 'shows' ? shows.filter(known).sort(by) : view === 'movie' ? homeMovies : view === 'unknown' ? unknownT
    : [...shows, ...collections, ...movies.filter((m) => !inCollection.has(m.id))].sort((a, b) => by(a.movies ? { title: a.name } : a, b.movies ? { title: b.name } : b));

  return html`<div class="overlay lib">
    <div class="overlay-head">
      <h2>Library</h2><span class="muted" style="margin-bottom:6px">${data.shows?.length || 0} shows · ${(data.items || []).filter((i) => i.kind === 'movie').length} movies · ${stats.total} files${stats.scanning ? ' · scanning…' : ''}</span><span class="grow"></span>
      <input class="input" style="width:260px" placeholder="Search shows, movies, music…" value=${q} onInput=${(e) => { setQ(e.target.value); setOpen(null); }} />
      ${isAdult && html`<button class="btn" onClick=${() => tv.scanAll().then((r) => toast(r.busy ? 'Already scanning…' : `Scan done — ${r.added || 0} new`))} disabled=${stats.scanning}><${Icon.refresh} /> Scan now</button>
      <button class="btn" disabled=${tagging} title="Look every show and movie up by name — covers, tags, summaries" onClick=${tagAll}>${tagging ? 'Looking everything up…' : '🏷 Find covers & tags'}</button>
      <button class="btn" onClick=${() => setDialog('torrents')}>🧲 Torrents</button>
      <button class="btn" onClick=${() => setDialog('free')}>📡 Free TV</button>
      <button class="btn primary" onClick=${() => setDialog('sources')}><${Icon.plus} /> Add sources</button>`}
    </div>
    <div class="lib-body">
      <nav class="lib-nav">
        ${VIEWS.filter(([k]) => k !== 'unknown' || unknownT.length).map(([k, l, ic]) => html`<button class=${'lib-nav-item' + (view === k && !open && !source ? ' on' : '')} onClick=${() => nav(k)}
          draggable=${!!KIND_SOURCE[k]} onDragStart=${(e) => KIND_SOURCE[k] && dragSources(e, [{ type: 'kind', kind: k, label: KIND_SOURCE[k] }])}>
          <span>${ic}</span><span class="grow">${l}</span>${k === 'pending' && pendingN > 0 && html`<span class="badge">${pendingN}</span>`}${k === 'unknown' && html`<span class="badge">${unknownT.length}</span>`}</button>`)}
        <div class="lib-nav-title">Sources <span class="faint small">drag onto a channel</span></div>
        <button class=${'lib-nav-item' + (!source ? ' on-soft' : '')} onClick=${() => pickSource(null)}><span>🌐</span><span class="grow">All sources</span></button>
        ${stats.folders.map((f) => html`<button class=${'lib-nav-item' + (source?.path === f ? ' on' : '')} title=${f} onClick=${() => pickSource(source?.path === f ? null : folderSrc(f))}
          draggable="true" onDragStart=${(e) => dragSources(e, [folderSrc(f)])}><span>${f.startsWith('\\\\') ? '🖥️' : '📁'}</span><span class="grow ell">${folderLabel(f)}</span></button>`)}
        ${(stats.servers || []).map((s) => html`<button class=${'lib-nav-item' + (source?.id === s.id ? ' on' : '')} title=${s.detail || s.name} onClick=${() => pickSource(source?.id === s.id ? null : { type: 'server', id: s.id, label: s.name })}
          draggable="true" onDragStart=${(e) => dragSources(e, [{ type: 'server', id: s.id, label: s.name }])}><span>${s.id.startsWith('archive') ? '🏛️' : s.id.startsWith('torrent') ? '🧲' : '📡'}</span><span class="grow ell">${s.name}</span></button>`)}
      </nav>

      <main class="lib-main nf" ref=${mainRef}>
        ${open ? html`<button class="btn sm nf-back" onClick=${() => { setOpen(null); setSeason(null); }}><${Icon.left} /> Back</button>${Details()}` : html`
          <div class="row nf-bar">
            <b class="grow nf-title">${heading}</b>
            ${view === 'pending' && pendingN > 0 && html`
              <button class="btn sm primary" onClick=${async () => { const n = await tv.approve('all'); toast(`${n} videos added to your channels`); load(); }}>Approve all — add to channels</button>
              ${sel.size > 0 && html`<button class="btn sm" onClick=${async () => { const n = await tv.approve([...sel]); toast(`${n} approved`); setSel(new Set()); load(); }}>Approve selected</button>`}`}
            ${sel.size > 0 && html`<span class="muted small">${sel.size} selected — drag them, or</span>
              <button class="btn sm" onClick=${() => setDialog({ addTo: selectedSources() })}><${Icon.plus} /> Add to channel</button>
              <button class="btn sm ghost" onClick=${() => setSel(new Set())}>Clear</button>`}
            ${(view !== 'all' || ql || genre) && html`<select class="select" value=${sort} onChange=${(e) => setSort(e.target.value)}>
              <option value="title">A–Z</option><option value="added">Newest first</option><option value="year">By year</option>${LIST_VIEWS.has(view) && html`<option value="length">Longest first</option>`}</select>`}
          </div>
          ${view === 'pending' && html`<p class="muted small" style="margin-top:-6px">New media waits here when Settings → New media is set to “Let me review”. Approved videos join any channel that includes their folder, show or type.</p>`}
          ${view === 'hidden' && html`<p class="muted small" style="margin-top:-6px">Hidden by right-click: these stay out of every channel, wall and list. Right-click one (or press 👁) to bring it back.</p>`}
          ${view === 'unknown' && html`<p class="muted small" style="margin-top:-6px">These names didn’t match any show or movie online. Press Edit on one, type the name it’s known by, and pick its cover — or press 🏷 Find covers & tags to try again.</p>`}
          ${genres.length > 0 && !LIST_VIEWS.has(view) && view !== 'unknown' && html`<div class="row lib-genres nf-genre-bar">
            <button class=${'chip' + (!genre ? ' on' : '')} onClick=${() => setGenre(null)}>All</button>
            ${genres.map((g) => html`<button class=${'chip' + (genre === g ? ' on' : '')} onClick=${() => setGenre(genre === g ? null : g)}>${g}</button>`)}
          </div>`}
          ${!(data.items || []).length && html`<div class="empty" style="height:auto;padding:60px 0"><div><h2>Nothing here yet</h2><p>Add a folder, a network share or a media server — or turn on free TV.</p>
            <button class="btn primary" onClick=${() => setDialog('sources')}><${Icon.plus} /> Add sources</button></div></div>`}

          ${view === 'all' && !ql && !genre && html`
            ${featured && Hero(featured)}
            <${Row} title="Continue watching" count=${cont.length}>${cont.map(WideCard)}</${Row}>
            <${Row} title="TV shows" count=${homeShows.length}>${homeShows.map(ShowCard)}</${Row}>
            <${Row} title="Movies" count=${homeMovies.length}>${homeMovies.map(titleCard)}</${Row}>
            ${genreRows.map(([g, l]) => html`<${Row} title=${g} count=${l.length}>${l.map(titleCard)}</${Row}>`)}
            <${Row} title="Recently added" count=${recent.length}>${recent.map(titleCard)}</${Row}>
            <${Row} title="❔ Not identified — press Edit to name them" count=${unknownT.length}>${unknownT.map(titleCard)}</${Row}>
            <${Row} title="Clips & short videos" count=${clips.length}>${clips.slice(0, 60).map(WideCard)}</${Row}>
            <${Row} title="Music" count=${music.length}>${music.slice(0, 60).map(WideCard)}</${Row}>
            <${Row} title="From the internet" count=${streams.length}>${streams.slice(0, 60).map(WideCard)}</${Row}>`}

          ${posterGrid && html`<div class="nf-grid">${gridTitles.slice(0, limit).map(titleCard)}</div>
            ${!gridTitles.length && html`<div class="muted" style="padding:40px 0;text-align:center">Nothing matches.</div>`}
            ${gridTitles.length > limit && html`<div style="text-align:center;margin:20px"><button class="btn" onClick=${() => setLimit((n) => n + 300)}>Show more (${gridTitles.length - limit})</button></div>`}`}

          ${LIST_VIEWS.has(view) && html`<div class="lib-grid">
            ${list.slice(0, limit).map((it) => html`
              <div class=${'lib-card' + (sel.has(it.id) ? ' sel' : '')} key=${it.id} draggable="true" tabindex="0"
                onContextMenu=${(e) => { if (!isAdult) return; e.preventDefault(); hideToggle(it, view !== 'hidden'); }}
                onDragStart=${(e) => startDrag(e, it.id, srcOf(it))} onClick=${(e) => clickSel(it.id, e)} onDblClick=${() => onPlay(it.id)}>
              <div class="lib-art"><${Thumb} item=${it} thumb=${thumb} />
                ${view === 'hidden' ? html`<button class="lib-play" title="Show it again" onClick=${(e) => { e.stopPropagation(); hideToggle(it, false); }}>👁</button>`
                  : html`<button class="lib-play" title="Play now" onClick=${(e) => { e.stopPropagation(); onPlay(it.id); }}><${Icon.play} /></button>`}
                ${editBtn(() => editItem(it))}
                <span class="lib-tag">${fmtDur(it.duration)}</span>${it.status === 'pending' && html`<span class="lib-tag new">NEW</span>`}</div>
              <div class="lib-cap"><b>${it.title}</b><span>${[it.show && epLabel(it), it.year, it.remote ? '🌐' : ''].filter(Boolean).join(' · ') || it.kind}</span></div></div>`)}
          </div>
          ${list.length > limit && html`<div style="text-align:center;margin:20px"><button class="btn" onClick=${() => setLimit((n) => n + 300)}>Show more (${list.length - limit})</button></div>`}`}`}
      </main>

      ${isAdult ? html`<${DropRail} channels=${channels} onDrop=${addTo} onNew=${newFrom} />` : html`<aside class="lib-rail"></aside>`}
    </div>

    ${dialog === 'sources' && html`<${AddSourcesDialog} onClose=${() => setDialog(null)} toast=${toast} />`}
    ${dialog === 'free' && html`<${FreeTvDialog} onClose=${() => setDialog(null)} toast=${toast} />`}
    ${dialog === 'torrents' && html`<${TorrentsPanel} onClose=${() => { setDialog(null); load(); }} toast=${toast} onPlay=${onPlay} isAdult=${isAdult} />`}
    ${edit && html`<${ArtModal} what=${edit} onClose=${() => { setEdit(null); load(); }} onDone=${() => { setEdit(null); load(); }} toast=${toast} />`}
    ${dialog?.addTo && html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && setDialog(null)}><div class="modal narrow">
      <div class="modal-head"><h3>Add ${dialog.addTo.length === 1 ? `“${dialog.addTo[0].label}”` : dialog.addTo.length + ' items'} to…</h3><button class="icon-btn" onClick=${() => setDialog(null)}><${Icon.close} /></button></div>
      <div class="modal-body"><div class="pick-list" style="max-height:50vh">
        <div class="pick-item" onClick=${() => { newFrom(dialog.addTo); setDialog(null); }}><div class="box">+</div><b>New channel</b></div>
        ${channels.filter((c) => !c.iptv).map((c) => html`<div class="pick-item" onClick=${() => { addTo(c, dialog.addTo); setDialog(null); }}>
          <span class="faint" style="width:28px">${c.number}</span><${ChannelLogo} ch=${c} size=${26} /><span>${c.name}</span></div>`)}
      </div></div></div></div>`}
  </div>`;
}

function AddSourcesDialog({ onClose, toast }) {
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    const r = await tv.addSources(picked);
    setBusy(false);
    toast(`Added ${r.added} new files from ${picked.length} source${picked.length === 1 ? '' : 's'}`);
    onClose();
  };
  return html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}><div class="modal">
    <div class="modal-head"><h3>Add sources</h3><button class="icon-btn" onClick=${onClose}><${Icon.close} /></button></div>
    <div class="modal-body"><${SourcesPicker} value=${picked} onChange=${setPicked} autoSelect=${false} /></div>
    <div class="modal-foot"><span class="muted grow">${picked.length} selected</span><button class="btn" onClick=${onClose}>Cancel</button>
      <button class="btn primary" disabled=${!picked.length || busy} onClick=${add}>${busy ? 'Scanning…' : 'Add & scan'}</button></div>
  </div></div>`;
}

export function FreeTvDialog({ onClose, toast }) {
  const [free, setFree] = useState({ ...DEFAULT_FREE, live: false, classics: [] });
  // Open with what's already set up, so toggles made before stay put.
  useEffect(() => { tv.state().then((s) => setFree(freeFromSettings(s.settings.live))).catch(() => {}); }, []);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const go = () => {
    // Everything runs in the background — the slim bar up top shows progress.
    if (free.classics.length) tv.freeAdd(free.classics, 60).catch(() => {});
    if (free.live) tv.iptvAuto({ country: free.country, countries: free.countries || [free.country], categories: free.categories, languages: free.languages || [], anime: !!free.anime, max: free.max ?? 0, sources: free.sources || ['iptv-org', 'free-tv'], urls: free.m3u?.trim() ? [free.m3u.trim()] : [] }).catch(() => {});
    toast('📡 Adding free TV in the background — watch the bar up top; stations appear as they’re checked');
    onClose();
  };
  return html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}><div class="modal">
    <div class="modal-head"><h3>📡 Free TV from the internet</h3><button class="icon-btn" onClick=${onClose}><${Icon.close} /></button></div>
    <div class="modal-body"><${FreeTvPicker} value=${free} onChange=${setFree} />${status && html`<p class="muted">${status}</p>`}</div>
    <div class="modal-foot"><button class="btn" onClick=${onClose}>Cancel</button>
      <button class="btn primary" disabled=${busy || (!free.live && !free.classics.length)} onClick=${go}>${busy ? 'Adding…' : 'Add free channels'}</button></div>
  </div></div>`;
}
