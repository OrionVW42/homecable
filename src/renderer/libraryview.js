// The library: browse everything, play anything on demand, and drag shows,
// movies, folders or whole collections onto channels.
import { html } from 'htm/preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { tv, fmtDur, ChannelLogo, Icon, epLabel } from './util.js';
import { SourcesPicker, FreeTvPicker, DEFAULT_FREE, freeFromSettings, applyFreeTv } from './sources.js';
import { ArtModal } from './ondemand.js';

const DND = 'application/x-homecable';
// Ads are never media — they live in Settings → Commercial breaks, not here.
const VIEWS = [
  ['all', 'Everything', '🗂️'], ['shows', 'TV shows', '📺'], ['movie', 'Movies', '🎬'], ['short', 'Short clips', '✂️'],
  ['music', 'Music', '🎵'], ['clip', 'Other videos', '📼'], ['recent', 'Recently added', '✨'], ['pending', 'New — needs review', '📥'],
  ['hidden', 'Hidden', '🚫'],
];
const KIND_SOURCE = { movie: 'All movies', short: 'All short clips', music: 'All music', clip: 'All other videos' };

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
  const [show, setShow] = useState(null);     // open show → episode list
  const [episodes, setEpisodes] = useState([]);
  const [dialog, setDialog] = useState(null); // 'sources' | 'free' | { addTo: sources }
  const [edit, setEdit] = useState(null); // the Edit dialog (name, picture, tags, make-a-show)
  const [tagging, setTagging] = useState(false); // "Update all info" is running
  const [limit, setLimit] = useState(180);

  const load = () => tv.browse().then(setData);
  useEffect(() => { load(); }, [stats]);
  useEffect(() => { if (show) tv.episodes(show.key).then(setEpisodes); }, [show, data]);
  useEffect(() => { setLimit(180); setSel(new Set()); }, [view, source, q]);

  const items = (view === 'hidden' ? data?.hidden : data?.items) || [];
  const [genre, setGenre] = useState(null); // tag chips: the main way to organize
  useEffect(() => { setGenre(null); }, [view]);
  const thumb = data?.media.thumb || '';
  const inSource = (it) => !source || (source.type === 'server' ? it.server === source.id : it.path.toLowerCase().startsWith(source.path.toLowerCase()));
  const ql = q.trim().toLowerCase();
  const match = (it) => !ql || `${it.title} ${it.show || ''} ${it.year || ''}`.toLowerCase().includes(ql);

  const genres = useMemo(() => {
    const count = new Map();
    for (const x of [...(data?.shows || []), ...(data?.items || [])]) for (const g of x.genres || []) count.set(g, (count.get(g) || 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(b[0])).map(([g]) => g).slice(0, 16);
  }, [data]);
  const inGenre = (x) => !genre || (x.genres || []).includes(genre);
  const list = useMemo(() => {
    let l = items.filter((it) => inSource(it) && match(it) && (view === 'hidden' || inGenre(it)));
    if (view === 'pending') l = l.filter((it) => it.status === 'pending');
    else if (view === 'recent') l = [...l].sort((a, b) => b.added - a.added).slice(0, 300);
    else if (view !== 'all' && view !== 'shows' && view !== 'hidden') l = l.filter((it) => it.kind === view);
    if (view === 'all') l = l.filter((it) => it.kind !== 'episode' && it.kind !== 'ad'); // shows appear as show cards
    const by = sort === 'added' ? (a, b) => b.added - a.added
      : sort === 'length' ? (a, b) => b.duration - a.duration
      : sort === 'year' ? (a, b) => (b.year || 0) - (a.year || 0) || (a.title || '').localeCompare(b.title || '')
      : (a, b) => (a.title || '').localeCompare(b.title || '');
    // "Everything": the auto-detected clips and internet streams keep to the
    // bottom, in their own sections, so your movies stay front and center.
    const band = (it) => (view !== 'all' ? 0 : it.remote ? 2 : it.kind === 'short' || it.kind === 'clip' ? 1 : 0);
    if (view !== 'recent') l = [...l].sort((a, b) => band(a) - band(b) || by(a, b));
    return l;
  }, [items, view, source, q, sort, genre]);
  const bandOf = (it) => (it.remote ? 2 : it.kind === 'short' || it.kind === 'clip' ? 1 : 0);
  const BAND_LABEL = { 1: '✂️ Clips & short videos — kept down here to stay organized', 2: '🌐 Streams from the internet' };
  const shows = useMemo(() => (data?.shows || []).filter((s) => (!ql || s.name.toLowerCase().includes(ql)) && inGenre(s) && (!source || items.some((it) => it.showKey === s.key && inSource(it)))), [data, q, source, genre]);
  const showCards = view === 'all' || view === 'shows' ? shows : [];

  const srcOf = (it) => ({ type: 'item', id: it.id, label: it.show ? `${it.show} ${epLabel(it)}` : it.title });
  const showSrc = (s) => ({ type: 'show', key: s.key, label: s.name });
  const selectedSources = () => {
    const out = [];
    for (const id of sel) {
      if (id.startsWith('show:')) { const s = shows.find((x) => 'show:' + x.key === id); if (s) out.push(showSrc(s)); }
      else { const it = items.find((x) => x.id === id); if (it) out.push(srcOf(it)); }
    }
    return out;
  };
  const clickSel = (id, e) => {
    setSel((cur) => {
      const n = new Set(e.ctrlKey || e.metaKey || e.shiftKey ? cur : []);
      if (n.has(id) && (e.ctrlKey || e.metaKey)) n.delete(id); else n.add(id);
      return n;
    });
  };
  const startDrag = (e, id, own) => dragSources(e, sel.has(id) && sel.size > 1 ? selectedSources() : [own]);

  const addTo = async (ch, sources) => {
    if (!sources.length) return;
    setChannels(await tv.addToChannel(ch.id, sources));
    toast(`Added ${sources.length === 1 ? sources[0].label : sources.length + ' items'} to ${ch.name}`);
  };
  const newFrom = (sources) => {
    if (!sources.length) return;
    onEdit({ name: sources.length === 1 ? sources[0].label : '', number: '', sources, filler: [], blocks: [], order: sources.length === 1 && sources[0].type === 'show' ? 'sequential' : 'shuffle', align: 30, color: '', logo: '' });
  };

  const pendingN = items.filter((it) => it.status === 'pending').length;
  // One click for everything: look every show and movie up by name (old entries too).
  const tagAll = () => {
    setTagging(true);
    tv.metaRefreshAll()
      .then((r) => { toast(`🏷 Updated info for ${r.shows} show${r.shows === 1 ? '' : 's'} and ${r.movies} movie${r.movies === 1 ? '' : 's'}`); load(); })
      .catch((e) => toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, '')))
      .finally(() => setTagging(false));
  };
  const editShow = (s) => setEdit({ kind: 'show', name: s.name, year: null, genres: s.genres || [], renamed: !!s.renamed, target: { showKey: s.key, name: s.name } });
  const editItem = (it) => setEdit({ kind: 'movie', name: it.title, year: it.year, genres: it.genres || [], renamed: !!it.renamed, target: { itemId: it.id }, others: list.filter((x) => x.id !== it.id).map(({ id, title }) => ({ id, title })) });
  const nav = (v) => { setView(v); setShow(null); };
  // Right-click any video to hide it everywhere (channels and walls too); it waits
  // under Library -> Hidden, where a right-click (or the eye button) brings it back.
  const hideToggle = async (it, on) => {
    await tv.itemsHide([it.id], on).catch((e) => toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, '')));
    toast(on ? `🚫 “${it.title}” is hidden — find it under Hidden` : `👁 “${it.title}” is back`);
    load();
  };
  const hideShow = async (sh) => {
    const eps = await tv.episodes(sh.key);
    await tv.itemsHide(eps.map((e) => e.id), true).catch(() => {});
    toast(`🚫 “${sh.name}” is hidden (${eps.length} episodes) — find them under Hidden`);
    load();
  };
  const folderSrc = (f) => ({ type: 'folder', path: f, label: f.split(/[\\/]/).filter(Boolean).pop() || f });

  if (!data) return html`<div class="overlay"><div class="overlay-head"><h2>Library</h2></div><div class="overlay-body muted">Loading…</div></div>`;

  return html`<div class="overlay lib">
    <div class="overlay-head">
      <h2>Library</h2><span class="muted" style="margin-bottom:6px">${stats.total} files${stats.scanning ? ' · scanning…' : ''}</span><span class="grow"></span>
      <input class="input" style="width:260px" placeholder="Search shows, movies, music…" value=${q} onInput=${(e) => setQ(e.target.value)} />
      ${isAdult && html`<button class="btn" onClick=${() => tv.scanAll().then((r) => toast(r.busy ? 'Already scanning…' : `Scan done — ${r.added || 0} new`))} disabled=${stats.scanning}><${Icon.refresh} /> Scan now</button>
      <button class="btn" disabled=${tagging} title="Look everything up by name: names, posters, genres, anime, airing order — old entries too" onClick=${tagAll}>${tagging ? 'Looking everything up…' : '🏷 Update all info'}</button>
      <button class="btn" onClick=${() => setDialog('free')}>📡 Free TV</button>
      <button class="btn primary" onClick=${() => setDialog('sources')}><${Icon.plus} /> Add sources</button>`}
    </div>
    <div class="lib-body">
      <nav class="lib-nav">
        ${VIEWS.map(([k, l, ic]) => html`<button class=${'lib-nav-item' + (view === k && !show ? ' on' : '')} onClick=${() => nav(k)}
          draggable=${!!KIND_SOURCE[k]} onDragStart=${(e) => KIND_SOURCE[k] && dragSources(e, [{ type: 'kind', kind: k, label: KIND_SOURCE[k] }])}>
          <span>${ic}</span><span class="grow">${l}</span>${k === 'pending' && pendingN > 0 && html`<span class="badge">${pendingN}</span>`}</button>`)}
        <div class="lib-nav-title">Sources <span class="faint small">drag onto a channel</span></div>
        <button class=${'lib-nav-item' + (!source ? ' on-soft' : '')} onClick=${() => setSource(null)}><span>🌐</span><span class="grow">All sources</span></button>
        ${stats.folders.map((f) => html`<button class=${'lib-nav-item' + (source?.path === f ? ' on-soft' : '')} title=${f} onClick=${() => setSource(source?.path === f ? null : folderSrc(f))}
          draggable="true" onDragStart=${(e) => dragSources(e, [folderSrc(f)])}><span>${f.startsWith('\\\\') ? '🖥️' : '📁'}</span><span class="grow ell">${folderSrc(f).label}</span></button>`)}
        ${(stats.servers || []).map((s) => html`<button class=${'lib-nav-item' + (source?.id === s.id ? ' on-soft' : '')} title=${s.detail || s.name} onClick=${() => setSource(source?.id === s.id ? null : { type: 'server', id: s.id, label: s.name })}
          draggable="true" onDragStart=${(e) => dragSources(e, [{ type: 'server', id: s.id, label: s.name }])}><span>${s.id.startsWith('archive') ? '🏛️' : '📡'}</span><span class="grow ell">${s.name}</span></button>`)}
      </nav>

      <main class="lib-main">
        ${show ? html`
          <div class="row" style="margin-bottom:16px">
            <button class="btn sm" onClick=${() => setShow(null)}><${Icon.left} /> Back</button>
            <h3 style="margin:0;font:700 22px var(--display)" class="grow">${show.name}</h3>
            <button class="btn sm" onClick=${() => episodes[0] && onPlay(episodes[0].id)}><${Icon.play} /> Play from the start</button>
            ${isAdult && html`<button class="btn sm" title="Name, picture & tags" onClick=${() => editShow(show)}>✏ Edit show</button>`}
            <button class="btn sm" onClick=${() => setDialog({ addTo: [showSrc(show)] })}><${Icon.plus} /> Add to channel</button>
          </div>
          <div class="ep-list">${episodes.map((ep) => html`<div class=${'ep-row' + (sel.has(ep.id) ? ' sel' : '')} draggable="true" onDragStart=${(e) => startDrag(e, ep.id, srcOf(ep))}
              onClick=${(e) => clickSel(ep.id, e)} onDblClick=${() => onPlay(ep.id)}>
            <span class="ep-num">${epLabel(ep) || '—'}</span><span class="grow ell">${ep.title}</span><span class="faint small">${fmtDur(ep.duration)}</span>
            ${ep.status === 'pending' && html`<span class="badge warn">new</span>`}
            <button class="icon-btn" title="Play" onClick=${(e) => { e.stopPropagation(); onPlay(ep.id); }}><${Icon.play} /></button></div>`)}</div>`
        : html`
          <div class="row" style="margin-bottom:14px">
            <b class="grow">${source ? source.label : VIEWS.find((v) => v[0] === view)[1]}</b>
            ${view === 'pending' && pendingN > 0 && html`
              <button class="btn sm primary" onClick=${async () => { const n = await tv.approve('all'); toast(`${n} videos added to your channels`); load(); }}>Approve all — add to channels</button>
              ${sel.size > 0 && html`<button class="btn sm" onClick=${async () => { const n = await tv.approve([...sel]); toast(`${n} approved`); setSel(new Set()); load(); }}>Approve selected</button>`}`}
            ${sel.size > 0 && html`<span class="muted small">${sel.size} selected — drag them, or</span>
              <button class="btn sm" onClick=${() => setDialog({ addTo: selectedSources() })}><${Icon.plus} /> Add to channel</button>
              <button class="btn sm ghost" onClick=${() => setSel(new Set())}>Clear</button>`}
            <select class="select" value=${sort} onChange=${(e) => setSort(e.target.value)}>
              <option value="title">A–Z</option><option value="added">Newest first</option><option value="year">By year</option><option value="length">Longest first</option></select>
          </div>
          ${view === 'pending' && html`<p class="muted small" style="margin-top:-6px">New media waits here when Settings → New media is set to “Let me review”. Approved videos join any channel that includes their folder, show or type.</p>`}
          ${view === 'hidden' && html`<p class="muted small" style="margin-top:-6px">Hidden by right-click: these stay out of every channel, wall and list. Right-click one (or press 👁) to bring it back.</p>`}
          ${genres.length > 0 && view !== 'hidden' && view !== 'pending' && html`<div class="row lib-genres" style="flex-wrap:wrap;gap:6px;margin:-4px 0 12px">
            <button class=${'chip' + (!genre ? ' on' : '')} onClick=${() => setGenre(null)}>All</button>
            ${genres.map((g) => html`<button class=${'chip' + (genre === g ? ' on' : '')} onClick=${() => setGenre(genre === g ? null : g)}>${g}</button>`)}
          </div>`}
          ${!showCards.length && !list.length && html`<div class="empty" style="height:auto;padding:60px 0"><div><h2>Nothing here yet</h2><p>Add a folder, a network share or a media server — or turn on free TV.</p>
            <button class="btn primary" onClick=${() => setDialog('sources')}><${Icon.plus} /> Add sources</button></div></div>`}
          <div class="lib-grid">
            ${showCards.map((s) => { const first = items.find((it) => it.showKey === s.key); const id = 'show:' + s.key; return html`<div class=${'lib-card' + (sel.has(id) ? ' sel' : '')} key=${id} draggable="true"
                onContextMenu=${(e) => { if (!isAdult) return; e.preventDefault(); hideShow(s); }}
                onDragStart=${(e) => startDrag(e, id, showSrc(s))} onClick=${(e) => (e.ctrlKey || e.shiftKey ? clickSel(id, e) : setShow(s))} tabindex="0">
              <div class=${'lib-art' + (s.poster ? ' tall' : '')}><${Thumb} item=${first} thumb=${thumb} poster=${s.poster} /><span class="lib-tag">${s.count} ep</span>
                ${isAdult && html`<button class="lib-edit" title="Edit name, picture & tags" onClick=${(e) => { e.stopPropagation(); editShow(s); }}>✏</button>`}</div>
              <div class="lib-cap"><b>${s.name}</b><span>${s.seasons > 1 ? s.seasons + ' seasons · ' : ''}~${fmtDur(s.avg)}</span></div></div>`; })}
            ${list.slice(0, limit).map((it, i, arr) => html`
              ${view === 'all' && bandOf(it) > 0 && (i === 0 || bandOf(arr[i - 1]) !== bandOf(it)) && html`<div class="lib-sec">${BAND_LABEL[bandOf(it)]}</div>`}
              <div class=${'lib-card' + (sel.has(it.id) ? ' sel' : '')} key=${it.id} draggable="true" tabindex="0"
                onContextMenu=${(e) => { if (!isAdult) return; e.preventDefault(); hideToggle(it, view !== 'hidden'); }}
                onDragStart=${(e) => startDrag(e, it.id, srcOf(it))} onClick=${(e) => clickSel(it.id, e)} onDblClick=${() => onPlay(it.id)}>
              <div class="lib-art"><${Thumb} item=${it} thumb=${thumb} />
                ${view === 'hidden' ? html`<button class="lib-play" title="Show it again" onClick=${(e) => { e.stopPropagation(); hideToggle(it, false); }}>👁</button>`
                  : html`<button class="lib-play" title="Play now" onClick=${(e) => { e.stopPropagation(); onPlay(it.id); }}><${Icon.play} /></button>`}
                ${isAdult && html`<button class="lib-edit" title="Edit name, picture & tags" onClick=${(e) => { e.stopPropagation(); editItem(it); }}>✏</button>`}
                <span class="lib-tag">${fmtDur(it.duration)}</span>${it.status === 'pending' && html`<span class="lib-tag new">NEW</span>`}</div>
              <div class="lib-cap"><b>${it.title}</b><span>${[it.show && epLabel(it), it.year, it.remote ? '🌐' : ''].filter(Boolean).join(' · ') || it.kind}</span></div></div>`)}
          </div>
          ${list.length > limit && html`<div style="text-align:center;margin:20px"><button class="btn" onClick=${() => setLimit((n) => n + 300)}>Show more (${list.length - limit})</button></div>`}`}
      </main>

      ${isAdult ? html`<${DropRail} channels=${channels} onDrop=${addTo} onNew=${newFrom} />` : html`<aside class="lib-rail"></aside>`}
    </div>

    ${dialog === 'sources' && html`<${AddSourcesDialog} onClose=${() => setDialog(null)} toast=${toast} />`}
    ${dialog === 'free' && html`<${FreeTvDialog} onClose=${() => setDialog(null)} toast=${toast} />`}
    ${edit && html`<${ArtModal} what=${edit} onClose=${() => setEdit(null)} onDone=${() => { setEdit(null); load(); }} toast=${toast} />`}
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
