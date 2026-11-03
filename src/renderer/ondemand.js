// On Demand channels: tune in and you get a wall of posters instead of a schedule.
//  • Movies: pick one and it plays from the start (or where you left off).
//  • Series ("Stream Demand"): a poster per show → seasons → episodes, with
//    "Continue S2 · E4", and the next episode plays by itself (binge).
// Pause / rewind / fast-forward work as usual. Back returns here (to the same show);
// channel up/down, the number keys and the guide still flip channels like anywhere else.
import { html } from 'htm/preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { tv, fmtClock, ChannelLogo, Icon } from './util.js';
import { focusDefault } from './gamepad.js';

const SORTS = [['az', 'A–Z'], ['new', 'Recently added'], ['year', 'Newest first'], ['old', 'Oldest first']];
const runtime = (s) => { const m = Math.round((s || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
const epLabel = (m) => m.label || (m.season != null ? `S${m.season} · E${m.episode}` : m.title);
const sortKey = (t) => String(t || '').replace(/^(the|a|an)\s+/i, '').toLowerCase();
const byEpisode = (a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || String(a.title).localeCompare(String(b.title), undefined, { numeric: true });
// Which show page was open when an episode started — so Back returns to it.
const reopen = new Map();

// Hold a poster (or right-click it) to change the picture; a normal click still plays/opens.
function holdArt(onArt, onPick) {
  if (!onArt) return { onClick: onPick };
  let t = null, fired = false;
  return {
    onPointerDown: (e) => { if (e.button) return; fired = false; t = setTimeout(() => { t = null; fired = true; onArt(); }, 650); },
    onPointerUp: () => { if (t) { clearTimeout(t); t = null; } },
    onPointerLeave: () => { if (t) { clearTimeout(t); t = null; } fired = false; },
    onContextMenu: (e) => { e.preventDefault(); if (t) { clearTimeout(t); t = null; } fired = true; onArt(); },
    onClick: (e) => { if (fired) { fired = false; e.preventDefault(); e.stopPropagation(); return; } onPick?.(e); },
  };
}

function Art({ src, title, sub }) {
  const [bad, setBad] = useState(false);
  if (src && !bad) return html`<img src=${src} loading="lazy" alt="" onError=${() => setBad(true)} />`;
  return html`<div class="od-card"><span>${title}</span>${sub && html`<small>${sub}</small>`}</div>`; // no art anywhere: a clean title card
}

// Where a show picks up: the episode you're partway through, else the one after the last you watched.
function upNext(show, last) {
  const eps = show.eps;
  const lastId = typeof last === 'string' ? last : last?.id;
  const i = eps.findIndex((e) => e.id === lastId);
  if (i < 0) return { ep: eps[0], at: 0, label: `Play ${epLabel(eps[0])}` };
  if (eps[i].resume > 10) return { ep: eps[i], at: eps[i].resume, label: `Continue ${epLabel(eps[i])}` };
  if (last && typeof last === 'object' && !last.done) return { ep: eps[i], at: 0, label: `Continue ${epLabel(eps[i])}` };
  if (eps[i + 1]) return { ep: eps[i + 1], at: 0, label: `Next: ${epLabel(eps[i + 1])}`, started: true };
  return { ep: eps[0], at: 0, label: `Watch again from ${epLabel(eps[0])}`, done: true };
}

export function OnDemandWall({ channel, isAdult, onPlay, toast }) {
  const series = channel.odStyle === 'series';
  const [data, setData] = useState(null);
  const [sort, setSort] = useState(() => { try { return localStorage.getItem('od-sort') || 'az'; } catch { return 'az'; } });
  const [ask, setAsk] = useState(null); // { title, resume, duration, go(at) } — Resume / Start from the beginning
  const [art, setArt] = useState(null); // change-the-picture dialog: { kind, name, year, target }
  const [genre, setGenre] = useState(''); // '' = everything
  const [mv, setMv] = useState(null); // drag-and-drop: { ids, name, to: show }
  const [tagging, setTagging] = useState(false); // "Update show & movie info" is running
  const [reset, setReset] = useState(null); // show whose watch history is about to be forgotten
  const [checking, setChecking] = useState(false);
  const [news, setNews] = useState(null);
  const [open, setOpen] = useState(() => reopen.get(channel.id) || null); // show page (showKey)
  const load = () => tv.onDemandList(channel.id).then(setData);
  const [opened, setOpened] = useState(0); // bumps when the locked section is unlocked
  // Every time the wall opens (tuning in, or coming back from a movie): show what we
  // know right away, then look in the folder for anything added or deleted since.
  useEffect(() => {
    let live = true;
    setData(null); setNews(null); setGenre(''); load();
    setChecking(true);
    tv.onDemandRefresh(channel.id).then((r) => {
      if (!live) return;
      setChecking(false);
      if (r?.added || r?.removed) { load(); setNews([r.added && `${r.added} new`, r.removed && `${r.removed} removed`].filter(Boolean).join(' · ')); }
    }).catch(() => live && setChecking(false));
    return () => { live = false; };
  }, [channel.id, opened]);
  // Posters arriving in the background (new videos, online look-ups) fill in live.
  useEffect(() => tv.onLibraryChanged(() => load()), [channel.id]);
  useEffect(() => { if (data) setTimeout(focusDefault, 60); }, [!!data, channel.id, open]);

  // Shows (episodes grouped) and everything else (movies, loose videos).
  const { shows, movies } = useMemo(() => {
    const map = new Map(), rest = [];
    const cmp0 = (a, b, na, nb) => (sort === 'new' ? (b.added || 0) - (a.added || 0) : sort === 'year' ? (b.year || 0) - (a.year || 0) : sort === 'old' ? (a.year || 9999) - (b.year || 9999) : 0) || sortKey(na).localeCompare(sortKey(nb), undefined, { numeric: true });
    if (data?.series) {
      // Stream Demand: one series per folder, seasons by subfolder, already in watching order.
      const byId = new Map(data.items.map((m) => [m.id, m]));
      const used = new Set();
      const list = data.series.map((sr) => {
        const seasons = sr.seasons.map((se) => {
          const short = /^Season (\d+)$/.exec(se.label);
          const eps = se.ids.map((id) => byId.get(id)).filter(Boolean).map((m, i) => {
            used.add(m.id);
            const n = i + 1;
            // "Kodomo no Jikan 03" → "Episode 3"; keep real titles ("Brother Love").
            let t = String(m.epTitle || m.title).replace(new RegExp('^' + sr.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[-–:]?\\s*', 'i'), '').replace(/^s\d+\s*e?p?\s*\d+\s*[-–:]?\s*/i, '');
            if (!t || /^(e|ep|episode)?\s*\d+(v\d+)?$/i.test(t)) t = `Episode ${m.episode ?? n}`;
            return { ...m, title: t, show: sr.name, n, label: short ? `S${short[1]} · E${n}` : `${se.label} · ${n}` };
          });
          return { label: se.label, eps };
        }).filter((se) => se.eps.length);
        let eps = seasons.flatMap((se) => se.eps);
        if (sr.ord) {
          const matched = eps.filter((e) => sr.ord[e.id] != null).length;
          if (matched >= eps.length * 0.6) eps = eps.map((e, i) => [e, i]).sort(([a, ai], [b, bi]) => (sr.ord[a.id] ?? 1e9 + ai) - (sr.ord[b.id] ?? 1e9 + bi) || ai - bi).map(([e]) => e);
        }
        return { key: sr.key, name: sr.name, renamed: !!sr.renamed, poster: sr.poster, thumb: eps[0]?.thumb, seasons, eps, added: Math.max(0, ...eps.map((e) => e.added || 0)), year: eps.find((e) => e.year)?.year || null, genres: sr.genres || [] };
      }).filter((s) => s.eps.length);
      list.sort((a, b) => cmp0(a, b, a.name, b.name));
      const rest2 = data.items.filter((m) => !used.has(m.id)).sort((a, b) => cmp0(a, b, a.title, b.title));
      return { shows: list, movies: rest2 };
    }
    for (const m of data?.items || []) {
      if (!m.showKey) { rest.push(m); continue; }
      if (!map.has(m.showKey)) map.set(m.showKey, { key: m.showKey, name: m.show, poster: m.showPoster || null, eps: [], added: 0, year: null, genres: m.showGenres || [], renamed: !!m.showRenamed });
      const s = map.get(m.showKey);
      s.eps.push(m); s.added = Math.max(s.added, m.added || 0); s.year = s.year || m.year;
      if (!s.poster && m.thumb) s.thumb = m.thumb;
    }
    const list = [...map.values()];
    for (const s of list) s.eps.sort(byEpisode);
    list.sort((a, b) => cmp0(a, b, a.name, b.name));
    rest.sort((a, b) => cmp0(a, b, a.title, b.title));
    return { shows: list, movies: rest };
  }, [data, sort]);
  const last = data?.showLast || {};
  // Genres (found by the online lookups): chips that narrow the wall.
  const genres = useMemo(() => {
    const count = new Map();
    for (const x of [...shows, ...movies]) for (const g of x.genres || []) count.set(g, (count.get(g) || 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(b[0])).map(([g]) => g).slice(0, 14);
  }, [shows, movies]);
  const showsV = genre ? shows.filter((x) => (x.genres || []).includes(genre)) : shows;
  const moviesV = genre ? movies.filter((x) => (x.genres || []).includes(genre)) : movies;
  const filmsV = moviesV.filter((m) => m.kind === 'movie');
  const otherV = moviesV.filter((m) => m.kind !== 'movie');
  const inProgress = showsV.filter((s) => last[s.key] && !upNext(s, last[s.key]).done);
  const resumable = moviesV.filter((m) => m.resume > 10);
  const show = open && shows.find((s) => s.key === open);
  // One click looks everything on this wall up by name: posters, genres, anime and all.
  const doTag = () => {
    setTagging(true);
    tv.metaRefresh(channel.id)
      .then((r) => { toast(r && (r.shows || r.movies) ? `🏷 Updated ${r.shows} show${r.shows === 1 ? '' : 's'} and ${r.movies} movie${r.movies === 1 ? '' : 's'}` : '🏷 Everything here already has its info'); load(); })
      .catch((e) => toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, '')))
      .finally(() => setTagging(false));
  };

  const pickMovie = (m) => (m.resume > 10 ? setAsk({ title: m.title, resume: m.resume, duration: m.duration, go: (at) => onPlay(m.id, at) }) : onPlay(m.id, 0));
  const playEp = (s, ep, at) => {
    reopen.set(channel.id, s.key);
    const i = s.eps.findIndex((e) => e.id === ep.id);
    // The rest of the series, in order — the next one plays by itself.
    const queue = s.eps.slice(i + 1).map((e) => ({ id: e.id, title: e.title, show: s.name, label: e.label }));
    onPlay(ep.id, at, { queue, seriesKey: s.key, label: ep.label, title: ep.title });
  };
  const openShow = (key) => { reopen.set(channel.id, key); setOpen(key); };
  const closeShow = () => { reopen.delete(channel.id); setOpen(null); };
  useEffect(() => { if (ask || reset) setTimeout(focusDefault, 30); }, [ask, reset]);
  // "Start from the beginning" on a show: forget how far you are in all its episodes (asked first).
  const doReset = async (s) => {
    await tv.resetProgress({ ids: s.eps.map((e) => e.id), showKey: s.key });
    setReset(null);
    toast(`⟲ ${s.name} starts from the beginning`);
    load();
  };
  // Back (Esc / Backspace / B on a controller) leaves the show page first.
  useEffect(() => {
    if (!show) return;
    const onKey = (e) => { if ((e.key === 'Escape' || e.key === 'Backspace') && !e.target.closest?.('input, textarea')) { e.preventDefault(); e.stopPropagation(); closeShow(); } };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [!!show]);
  const setSortSaved = (k) => { setSort(k); try { localStorage.setItem('od-sort', k); } catch {} };

  // Plain helpers, not components: a component defined in here would remount every
  // render and the remote's highlight would be lost.
  const artFor = (x, kind) => (kind === 'movie'
    ? { kind, name: x.title, year: x.year, genres: x.genres || [], renamed: !!x.renamed, target: { itemId: x.id }, others: movies.filter((m2) => m2.id !== x.id).map((m2) => ({ id: m2.id, title: m2.title })) }
    : { kind, name: x.name, year: x.year, genres: x.genres || [], renamed: !!x.renamed, target: { showKey: x.key, name: x.name }, movedIds: (x.eps || []).filter((e) => e.moved).map((e) => e.id) });
  // Drag a video (or a mis-grouped show) onto a show to put it inside (asked first).
  const onDrop = (payload, to) => { if (!payload || payload.ids.some((id) => to.eps.some((e) => e.id === id))) return; setMv({ ...payload, to }); };
  const doMove = () => { tv.showMove(mv.ids, mv.to.key).then(() => { toast(`✓ “${mv.name}” is now inside ${mv.to.name}`); setMv(null); load(); }).catch((e) => { setMv(null); toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, '')); }); };
  const showsGrid = (list, first) => html`<div class="od-grid">${list.map((s, i) => html`<${ShowTile} s=${s} last=${last[s.key]} first=${first && i === 0} onPick=${() => openShow(s.key)} onArt=${() => setArt(artFor(s, 'show'))} onDrop=${(p) => onDrop(p, s)} />`)}</div>`;
  const moviesGrid = (list, first) => html`<div class="od-grid">${list.map((m, i) => html`<${Tile} m=${m} onPick=${pickMovie} first=${first && i === 0} onArt=${() => setArt(artFor(m, 'movie'))} />`)}</div>`;
  const empty = data && !shows.length && !movies.length;
  const what = series ? 'shows' : 'movies';
  if (data?.locked) return html`<div class="overlay ondemand"><${Unlock} name=${channel.name} onOpen=${() => setOpened((n) => n + 1)} /></div>`;
  const locked = !!channel.locked;

  return html`<div class="overlay ondemand">
    <div class="od-head">
      <${ChannelLogo} ch=${channel} size=${44} />
      <div class="grow"><div class="od-kicker">${locked ? 'Your collection · locks when you leave' : series ? 'Stream Demand · your shows' : 'On Demand · your movies'}</div><h2>${channel.name}</h2></div>
      ${locked && html`<button class="btn sm" onClick=${() => tv.vaultLock().then(() => setOpened((n) => n + 1))}>🔒 Lock</button>`}
      ${checking ? html`<span class="od-check"><span class="spin"></span> Checking for new ${what}…</span>` : news && html`<span class="od-check done">✓ ${news}</span>`}
      ${!show && html`<div class="seg">${SORTS.map(([k, l]) => html`<button class=${sort === k ? 'on' : ''} onClick=${() => setSortSaved(k)}>${l}</button>`)}</div>`}
    </div>
    ${!show && data && !data.locked && (genres.length > 0 || isAdult) && html`<div class="od-genres">
      ${genres.length > 0 && html`<button class=${'chip' + (!genre ? ' on' : '')} onClick=${() => setGenre('')}>All</button>
        ${genres.map((g) => html`<button class=${'chip' + (genre === g ? ' on' : '')} onClick=${() => setGenre(genre === g ? '' : g)}>${g}</button>`)}`}
      <span class="grow"></span>
      ${isAdult && html`<button class="btn sm" disabled=${tagging} title="Look everything here up by name: posters, genres, anime and more" onClick=${doTag}>${tagging ? 'Looking up names…' : '🏷 Update show & movie info'}</button>`}
    </div>`}
    <div class="overlay-body od-body">
      ${!data && html`<div class="muted" style="padding:20px 0">Loading…</div>`}
      ${empty && html`<div class="od-empty"><h3>No ${what} here yet</h3>
        ${data.folders?.length ? html`<p class="muted">Put ${series ? 'show folders (with their seasons and episodes)' : 'movies'} in <code class="od-path">${data.folders[0]}</code> — they show up here automatically, with posters.</p>
          ${!locked && html`<button class="btn primary gp-default" onClick=${() => tv.onDemandOpenFolder(series ? 'series' : 'movies')}>📂 Open the folder</button>`}`
        : html`<p class="muted">Videos on this PC show up automatically after a scan. Grown-ups can change what this channel offers in Channels.</p>`}</div>`}

      ${show ? html`<${ShowPage} s=${show} last=${last[show.key]} onPlay=${(ep, at) => playEp(show, ep, at)} onBack=${closeShow} onArt=${() => setArt(artFor(show, 'show'))}
          onAsk=${(e) => setAsk({ title: `${epLabel(e)} — ${e.title}`, resume: e.resume, duration: e.duration, go: (at) => playEp(show, e, at) })}
          onReset=${() => setReset(show)} />` : !empty && data && html`
        ${(inProgress.length > 0 || resumable.length > 0) && html`<div class="od-row-title">Continue watching</div>
          <div class="od-grid">
            ${inProgress.slice(0, 6).map((s, i) => html`<${ShowTile} s=${s} last=${last[s.key]} first=${i === 0} onPick=${() => { const n = upNext(s, last[s.key]); playEp(s, n.ep, n.at); }} cont onArt=${() => setArt(artFor(s, 'show'))} />`)}
            ${resumable.slice(0, 6).map((m, i) => html`<${Tile} m=${m} onPick=${pickMovie} first=${!inProgress.length && i === 0} onArt=${() => setArt(artFor(m, 'movie'))} />`)}
          </div>`}
        ${series ? html`
          ${showsV.length > 0 && html`<div class="od-row-title">Shows <span>${showsV.length}</span></div>${showsGrid(showsV, !inProgress.length && !resumable.length)}`}
          ${filmsV.length > 0 && html`<div class="od-row-title">Movies <span>${filmsV.length}</span></div>${moviesGrid(filmsV, !showsV.length && !inProgress.length && !resumable.length)}`}
          ${otherV.length > 0 && html`<div class="od-row-title other">Other videos <span>${otherV.length}</span></div>${moviesGrid(otherV, false)}`}`
        : html`
          ${filmsV.length > 0 && html`<div class="od-row-title">${resumable.length || inProgress.length ? 'All movies' : 'Movies'} <span>${filmsV.length}</span></div>${moviesGrid(filmsV, !inProgress.length && !resumable.length)}`}
          ${otherV.length > 0 && html`<div class="od-row-title other">Other videos <span>${otherV.length}</span></div>${moviesGrid(otherV, false)}`}
          ${showsV.length > 0 && html`<div class="od-row-title">Series <span>${showsV.length}</span></div>${showsGrid(showsV, !moviesV.length && !inProgress.length && !resumable.length)}`}`}
        ${genre && !showsV.length && !moviesV.length && html`<div class="muted" style="padding:20px 0">Nothing tagged “${genre}” here yet.</div>`}`}
    </div>
    ${ask && html`<div class="modal-bg" onClick=${() => setAsk(null)}><div class="modal narrow od-ask" onClick=${(e) => e.stopPropagation()}>
      <div class="modal-body">
        <h3>${ask.title}</h3>
        <p class="muted">You stopped at ${fmtClock(ask.resume)} of ${runtime(ask.duration)}.</p>
        <div class="row" style="gap:12px;justify-content:center">
          <button class="btn primary big gp-default" onClick=${() => { setAsk(null); ask.go(ask.resume); }}>▶ Resume from ${fmtClock(ask.resume)}</button>
          <button class="btn big" onClick=${() => { setAsk(null); ask.go(0); }}>⟲ Start from the beginning</button>
        </div>
      </div></div></div>`}
    ${art && html`<${ArtModal} what=${art} onClose=${() => setArt(null)} onDone=${() => { setArt(null); load(); }} toast=${toast} />`}
    ${mv && html`<div class="modal-bg" onClick=${() => setMv(null)}><div class="modal narrow od-ask" onClick=${(e) => e.stopPropagation()}>
      <div class="modal-body">
        <h3>Put “${mv.name}” inside “${mv.to.name}”?</h3>
        <p class="muted">It will show with ${mv.to.name}’s episodes (season and episode numbers decide where; otherwise it lands under “OVAs & extras”). Your files aren’t moved or changed — hold ${mv.to.name}’s poster → Edit to undo.</p>
        <div class="row" style="gap:12px;justify-content:center">
          <button class="btn big gp-default" onClick=${() => setMv(null)}>Leave it where it is</button>
          <button class="btn primary big" onClick=${doMove}>✓ Move it in</button>
        </div>
      </div></div></div>`}
    ${reset && html`<div class="modal-bg" onClick=${() => setReset(null)}><div class="modal narrow od-ask" onClick=${(e) => e.stopPropagation()}>
      <div class="modal-body">
        <h3>Start ${reset.name} from the beginning?</h3>
        <p class="muted">This forgets how far you've watched its ${reset.eps.length} episode${reset.eps.length === 1 ? '' : 's'} — every ✓ and “minutes watched” on this show is cleared. Your files aren't touched.</p>
        <div class="row" style="gap:12px;justify-content:center">
          <button class="btn big gp-default" onClick=${() => setReset(null)}>Keep my place</button>
          <button class="btn danger big" onClick=${() => doReset(reset)}>⟲ Yes, reset this show</button>
        </div>
      </div></div></div>`}
  </div>`;
}

// The locked section asks for its password first (nothing about what's inside is shown).
function Unlock({ name, onOpen }) {
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState('');
  const go = async () => {
    const r = await tv.vaultUnlock(pw);
    if (r?.ok) { setPw(''); onOpen(); return; }
    setPw('');
    setMsg(r?.wait ? `Too many tries — wait ${r.wait} s` : 'That’s not it — try again');
  };
  return html`<div class="vault-lock">
    <div class="vault-ic">🔒</div>
    <h2>${name}</h2>
    <p class="muted">Enter the password to open.</p>
    <form class="row" style="gap:10px;justify-content:center" onSubmit=${(e) => { e.preventDefault(); go(); }}>
      <input class="input gp-default" type="password" autofocus placeholder="Password" value=${pw} onInput=${(e) => { setPw(e.target.value); setMsg(''); }} style="width:240px" />
      <button class="btn primary" type="submit" disabled=${!pw}>Open</button>
    </form>
    <div class="vault-msg">${msg}</div>
  </div>`;
}

function Tile({ m, onPick, first, onArt }) {
  const pct = m.resume > 10 && m.duration ? Math.min(100, (m.resume / m.duration) * 100) : 0;
  return html`<button class=${'od-tile' + (first ? ' gp-default' : '')} title=${m.title} draggable=${!!onArt}
    onDragStart=${(e) => e.dataTransfer.setData('text/hc', JSON.stringify({ ids: [m.id], name: m.title }))} ...${holdArt(onArt, () => onPick(m))}>
    <div class="od-poster"><${Art} src=${m.poster} title=${m.title} sub=${m.year} />${pct > 0 && html`<i class="od-progress" style=${`width:${pct}%`}></i>`}</div>
    <b>${m.title}</b><small>${[m.year, runtime(m.duration)].filter(Boolean).join(' · ')}</small>
  </button>`;
}

function ShowTile({ s, last, onPick, first, cont, onArt, onDrop }) {
  const seasons = s.seasons ? s.seasons.filter((x) => x.label !== 'Extras').length : new Set(s.eps.map((e) => e.season ?? 0)).size;
  const n = last ? upNext(s, last) : null;
  const dnd = onDrop ? {
    onDragStart: (e) => e.dataTransfer.setData('text/hc', JSON.stringify({ ids: s.eps.map((x) => x.id), name: s.name })),
    onDragOver: (e) => { e.preventDefault(); e.currentTarget.classList.add('drop'); },
    onDragLeave: (e) => e.currentTarget.classList.remove('drop'),
    onDrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('drop'); try { onDrop(JSON.parse(e.dataTransfer.getData('text/hc') || 'null')); } catch {} },
  } : {};
  return html`<button class=${'od-tile' + (first ? ' gp-default' : '')} title=${s.name} draggable=${!!onDrop} ...${dnd} ...${holdArt(onArt, onPick)}>
    <div class="od-poster"><${Art} src=${s.poster || s.thumb} title=${s.name} sub=${`${s.eps.length} episode${s.eps.length === 1 ? '' : 's'}`} />${cont && n && html`<span class="od-next">▶ ${epLabel(n.ep)}</span>`}</div>
    <b>${s.name}</b><small>${cont && n ? n.label : `${seasons > 1 ? `${seasons} seasons · ` : ''}${s.eps.length} episode${s.eps.length === 1 ? '' : 's'}`}</small>
  </button>`;
}

// The standard tags, plus the anime words fans actually sort by (they appear
// once something is tagged Anime, and always in the Tags page).
export const TAGS = ['Anime', 'Animation', 'Action', 'Adventure', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'Horror', 'Musical', 'Mystery', 'Romance', 'Science fiction', 'Superhero', 'Thriller', 'War', 'Western', 'Sports', 'Biography', 'History', 'Music', 'Kids', 'Teen', 'Reality'];
// What it is (format) and what it's about — the editor's other tag sections.
export const FORMAT_TAGS = ['TV show', 'Movie', 'Miniseries', 'Special', 'OVA', 'ONA', 'Anime series', 'Anime movie', 'Animated movie', 'Live action', 'Short film', 'Docuseries', 'Web series', 'Stand-up', 'Concert', 'Music video', 'Pilot', 'Extras', 'Trailer'];
export const ABOUT_TAGS = ['Police', 'Crime', 'Mockumentary', 'Parody', 'Satire', 'Dark comedy', 'Coming of age', 'Space', 'Aliens', 'Time travel', 'Post-apocalyptic', 'Zombies', 'Vampires', 'Monsters', 'Ghosts', 'Magic', 'Robots', 'Martial arts', 'Spy', 'Military', 'Medical', 'Legal', 'Political', 'Workplace', 'Prison', 'Pirates', 'Dinosaurs', 'Fairy tale', 'Survival', 'Road trip', 'Cars', 'Food', 'True story', 'Based on a book', 'Based on a comic', 'Sequel', 'Prequel', 'Remake', 'Reboot', 'Spin-off'];
export const ERA_TAGS = ['1950s', '1960s', '1970s', '1980s', '1990s', '2000s', '2010s', '2020s', 'Classic', 'Cult', 'Blockbuster', 'Award winner', 'Favorite', 'Comfort watch', 'Binge-worthy'];
export const ANIME_TAGS = ['Shounen', 'Shoujo', 'Seinen', 'Josei', 'Isekai', 'Mecha', 'Slice of Life', 'Sports', 'Dubbed', 'Subbed', 'Magical girl', 'Harem', 'Idol', 'Psychological', 'Supernatural', 'Ecchi', 'Kodomo', 'Studio Ghibli'];
// The editor's tag sections (right-click in the Library, ✏ on the walls).
export const TV_TAGS = ['Sitcom', 'Cartoon', 'Adult animation', 'Kids', 'Teen', 'Reality', 'Game show', 'Talk show', 'Sketch comedy', 'Soap', 'Anthology', 'Procedural', 'Late night', 'Competition', 'Cooking show', 'Home & DIY', 'Nature', 'True crime', 'Sports', 'News', 'Saturday morning'];
export const MOVIE_TAGS = ['Indie', 'Foreign', 'Holiday', 'Christmas', 'Halloween', 'Family movie night', 'Date night', 'Disney', 'Pixar', 'Marvel', 'DC', 'Star Wars', 'Studio Ghibli', 'Musical', 'Epic', 'Heist', 'Disaster', 'Noir', 'Slasher', 'Rom-com'];

// Change a movie's or a show's picture: candidates found online (name only is sent),
// or any picture file on this PC. Grown-ups only — the PC answers viewers with "ask a grown-up".
export function ArtModal({ what, onClose, onDone, toast }) {
  const [q, setQ] = useState(what.name);
  const [cands, setCands] = useState('looking'); // 'looking' | [{ url, name, label }]
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState(what.genres || []);
  const [showName, setShowName] = useState(String(what.name).replace(/\s*\((19|20)\d{2}\)\s*$/, ''));
  const [withOthers, setWithOthers] = useState(true);
  const err = (e) => String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, '');
  const look = (text) => {
    setCands('looking');
    tv.artCandidates({ kind: what.kind, name: text, year: text === what.name ? what.year : null })
      .then(setCands)
      .catch((e) => { if (/grown-up/i.test(String(e))) { toast('Ask a grown-up to change this'); onClose(); } else setCands([]); });
  };
  useEffect(() => { look(what.name); }, []);
  // What it is, where it's from, where it plays — and tags suggested by looking it up online.
  const [info, setInfo] = useState(null);
  useEffect(() => { tv.editDetails?.(what.target).then(setInfo).catch(() => setInfo(null)); }, []);
  const use = (source) => {
    setBusy(true);
    tv.artSet(what.target, source)
      .then(() => { toast('\u{1F5BC} The picture is updated'); onDone(); })
      .catch((e) => { setBusy(false); toast(err(e)); });
  };
  const pickFile = async () => { const f = await tv.artPickFile(); if (f) use({ file: f }); };
  const rename = (to) => {
    setBusy(true);
    tv.nameSet(what.target, to)
      .then((r) => { toast(r.name ? `✓ Renamed to \u201c${r.name}\u201d` : '\u21a9 Back to its original name'); onDone(); })
      .catch((e) => { setBusy(false); toast(err(e)); });
  };
  const unmove = () => {
    setBusy(true);
    tv.showMove(what.movedIds, null)
      .then(() => { toast('\u21a9 Put back'); onDone(); })
      .catch((e) => { setBusy(false); toast(err(e)); });
  };
  // Tags: tap to turn on or off (saved straight away; lookups never overwrite hand-set tags).
  const toggleTag = (g) => {
    const next = tags.includes(g) ? tags.filter((x) => x !== g) : [...tags, g];
    setTags(next);
    tv.tagsSet(what.target, next).catch((e) => toast(err(e)));
  };
  const norm0 = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const lookalikes = what.kind === 'movie' && norm0(showName).length > 2 ? (what.others || []).filter((o) => norm0(o.title).startsWith(norm0(showName))) : [];
  const makeShow = () => {
    const nm = showName.trim();
    if (!nm) return;
    const ids = [what.target.itemId, ...(withOthers ? lookalikes.map((x) => x.id) : [])];
    setBusy(true);
    tv.showMake(ids, nm)
      .then((r) => { toast(`\u{1F4FA} \u201c${nm}\u201d is a show now (${r.count} video${r.count === 1 ? '' : 's'})`); onDone(); })
      .catch((e) => { setBusy(false); toast(err(e)); });
  };
  const suggest = Array.isArray(cands) && cands[0]?.name && norm0(cands[0].name) !== norm0(what.name) ? cands[0].name : null;
  const tagList = [...new Set([...TAGS, ...(tags.includes('Anime') ? ANIME_TAGS : []), ...tags])];
  return html`<div class="modal-bg" onClick=${onClose}><div class="modal od-art" onClick=${(e) => e.stopPropagation()}>
    <div class="modal-body">
      <h3>Edit \u201c${what.name}\u201d</h3>
      ${info?.suggest?.length > 0 && html`<div class="od-suggest-tags"><span class="muted small">Suggested tags:</span>
        ${info.suggest.filter((g) => !tags.includes(g)).map((g) => html`<button class="chip sugg" disabled=${busy} onClick=${() => toggleTag(g)}>+ ${g}</button>`)}
        ${info.suggest.some((g) => !tags.includes(g)) && html`<button class="btn sm" disabled=${busy} onClick=${() => { const next = [...new Set([...tags, ...info.suggest])]; setTags(next); tv.tagsSet(what.target, next).catch((e) => toast(err(e))); }}>✓ Add all</button>`}</div>`}
      ${info?.match && html`<div class="od-match"><span class=${'od-sure ' + info.match.confidence}>${{ sure: '\u2713 Sure', likely: '\u2713 Likely', maybe: '? Maybe', guess: '? Best guess' }[info.match.confidence] || ''}</span>
        <span>This is most probably <b>${info.match.name}</b>${info.match.year ? ` (${info.match.year})` : ''}</span>
        <span class="muted small">matched by ${info.match.sources.join(' + ')}${info.match.others?.length ? ` \u00b7 or: ${info.match.others.join(', ')}` : ''}</span></div>`}
      ${info && html`<div class="od-info">
        ${info.summary && html`<p>${info.summary.replace(/<[^>]+>/g, '').slice(0, 420)}</p>`}
        <div class="od-info-row">
          ${info.year ? html`<span>📅 ${info.year}</span>` : ''}
          ${info.episodes ? html`<span>📺 ${info.episodes} episode${info.episodes === 1 ? '' : 's'}${info.seasons > 1 ? ` · ${info.seasons} seasons` : ''}</span>` : ''}
          ${info.duration ? html`<span>⏱ ${Math.round(info.duration / 60)} min</span>` : ''}
          ${info.watched ? html`<span>✓ ${info.watched} watched</span>` : ''}
          ${info.from && html`<span class="ell" title=${info.from}>${info.from}</span>`}
        </div>
        <div class="od-info-row muted">${info.on.length ? `Plays on: ${info.on.slice(0, 6).join(' · ')}${info.on.length > 6 ? ` +${info.on.length - 6}` : ''}` : 'Not on any channel yet — drag it onto one in the Library.'}${info.torrent && info.kept ? ' · 📌 kept' : ''}</div>
      </div>`}
      <form class="row" style="gap:8px;margin-top:10px" onSubmit=${(e) => { e.preventDefault(); look(q); }}>
        <input class="input grow" value=${q} onInput=${(e) => setQ(e.target.value)} placeholder=${what.kind === 'show' ? 'Show name' : 'Movie name'} />
        <button class="btn" type="button" disabled=${busy || !q.trim() || q.trim() === what.name} onClick=${() => rename(q.trim())}><${Icon.edit} /> Rename</button>
        <button class="btn" type="submit">\u{1F50D} Find pictures</button>
        <button class="btn" type="button" onClick=${pickFile}>\u{1F4C1} Picture file\u2026</button>
      </form>
      ${(suggest || what.renamed) && html`<div class="od-suggest">
        ${suggest && html`<span>Found online: <b>\u201c${suggest}\u201d</b></span><button class="btn sm primary" disabled=${busy} onClick=${() => rename(suggest)}>\u2713 Use the correct name</button>`}
        ${what.renamed && html`<button class="btn sm" disabled=${busy} onClick=${() => rename('')}>\u21a9 Back to the original name</button>`}
      </div>`}
      ${info?.od?.length > 0 && html`<h4 class="od-h4">Show it on</h4>
        <div class="od-tags">${info.od.map((o) => html`<button class=${'chip' + (o.on ? ' on' : '')} disabled=${busy}
          onClick=${() => tv.editOnDemand(what.target, o.id, !o.on).then((now) => { setInfo((i) => ({ ...i, od: i.od.map((x) => (x.id === o.id ? { ...x, on: now } : x)) })); toast(now ? `${o.style === 'series' ? '🍿' : '🎬'} On ${o.name}` : `Taken off ${o.name}`); }).catch((e) => toast(err(e)))}>
          ${o.on ? '✓ ' : ''}${o.style === 'series' ? '🍿' : '🎬'} ${o.name}</button>`)}</div>`}
      <h4 class="od-h4">Tags</h4>
      ${(() => {
        const groups = [['What it is', FORMAT_TAGS], ['Genres', TAGS], ['About', ABOUT_TAGS], ...(what.kind === 'show' ? [['TV', TV_TAGS], ['Movies', MOVIE_TAGS]] : [['Movies', MOVIE_TAGS], ['TV', TV_TAGS]]), ['Anime', ANIME_TAGS], ['Era & more', ERA_TAGS]];
        const known = new Set(groups.flatMap((g) => g[1]));
        const own = tags.filter((g) => !known.has(g));
        const chip = (g) => html`<button class=${'chip' + (tags.includes(g) ? ' on' : '')} disabled=${busy} onClick=${() => toggleTag(g)}>${tags.includes(g) ? '\u2713 ' : ''}${g}</button>`;
        return html`${groups.map(([title, list], gi) => (gi < 2 ? html`<div class="od-tag-group"><span class="od-tag-title">${title}</span><div class="od-tags">${list.map(chip)}</div></div>`
          : html`<details class="od-tag-group od-tag-more" open=${list.some((t) => tags.includes(t))}><summary class="od-tag-title">${title} <span class="faint">${list.filter((t) => tags.includes(t)).length || ""}</span></summary><div class="od-tags">${list.map(chip)}</div></details>`))}
          <div class="od-tag-group"><span class="od-tag-title">Your own</span><div class="od-tags">${own.map(chip)}
            <form class="row" style="gap:6px" onSubmit=${(e) => { e.preventDefault(); const v = e.currentTarget.elements.t.value.trim(); if (v && !tags.includes(v)) toggleTag(v); e.currentTarget.reset(); }}><input class="input sm" name="t" placeholder="New tag…" style="width:140px" /><button class="btn sm" type="submit">+ Add</button></form></div></div>`;
      })()}
      <div class="od-tags" hidden>${tagList.map((g) => html`<button class=${'chip' + (tags.includes(g) ? ' on' : '')} disabled=${busy} onClick=${() => toggleTag(g)}>${tags.includes(g) ? '\u2713 ' : ''}${g}</button>`)}</div>
      ${what.kind === 'movie' && html`
        <h4 class="od-h4">Not a movie?</h4>
        <div class="row" style="gap:8px">
          <input class="input grow" value=${showName} onInput=${(e) => setShowName(e.target.value)} placeholder="Show name" />
          <button class="btn" disabled=${busy || !showName.trim()} onClick=${makeShow}>\u{1F4FA} Make it a show episode</button>
        </div>
        ${lookalikes.length > 0 && html`<label class="row small muted" style="gap:8px;justify-content:flex-start;margin-top:6px;cursor:pointer"><input type="checkbox" checked=${withOthers} onChange=${(e) => setWithOthers(e.target.checked)} /> Also move the ${lookalikes.length} other video${lookalikes.length === 1 ? '' : 's'} that look like \u201c${showName.trim()}\u201d into it</label>`}`}
      ${what.movedIds?.length > 0 && html`<button class="btn sm" style="margin-top:10px" onClick=${unmove}>\u21a9 Put ${what.movedIds.length} moved video${what.movedIds.length === 1 ? '' : 's'} back where ${what.movedIds.length === 1 ? 'it' : 'they'} came from</button>`}
      ${cands === 'looking' ? html`<div class="muted" style="padding:16px 0">Looking it up a few ways (IMDb, TVmaze, iTunes, Wikipedia)\u2026</div>`
        : html`<div class="od-art-pick">
          ${cands[0] && html`<button class="od-art-best" disabled=${busy} title=${cands[0].label} onClick=${() => use({ url: cands[0].url })}>
            <img src=${cands[0].url} alt="" />
            <span class="od-best-tag">${cands[0].best ? (cands[0].sure === 'sure' || cands[0].sure === 'likely' ? '\u2605 Most likely' : '\u2605 Best guess') : '\u2605 Closest'}</span>
            <span class="od-best-label">${cands[0].label}</span>
            <span class="btn sm primary">\u2713 Use this cover</span></button>`}
          <div class="od-art-grid">
            ${cands.slice(1).map((c) => html`<button class="od-art-cand" disabled=${busy} title=${c.label} onClick=${() => use({ url: c.url })}><img src=${c.url} loading="lazy" alt="" /><span>${c.label}</span></button>`)}
            ${!cands.length && html`<div class="muted" style="grid-column:1/-1">Nothing matched online under any spelling \u2014 type the name the way it\u2019s known above and press Find, or use a picture file from this PC.</div>`}
          </div>
        </div>`}
      <div class="row" style="justify-content:flex-end;margin-top:12px;gap:8px">
        ${(what.actions || []).map((a) => html`<button class="btn sm" disabled=${busy} onClick=${async () => { setBusy(true); try { await a.run(); } finally { setBusy(false); } if (/Hide|Show it again/.test(a.label)) onDone(); }}>${a.label}</button>`)}
        <span class="grow"></span>
        <button class="btn primary" onClick=${onClose}>Done</button></div>
    </div></div></div>`;
}

function ShowPage({ s, last, onPlay, onBack, onAsk, onReset, onArt }) {
  // Seasons: the series' own (folder-based) ones, or grouped by season number.
  const groups = s.seasons || [...new Set(s.eps.map((e) => e.season ?? 0))].sort((a, b) => a - b).map((x) => ({ label: x ? `Season ${x}` : 'Specials', eps: s.eps.filter((e) => (e.season ?? 0) === x) }));
  const seasons = groups.map((g) => g.label);
  const n = upNext(s, last);
  const [season, setSeason] = useState(() => (groups.find((g) => g.eps.some((e) => e.id === n.ep.id)) || groups[0])?.label);
  const eps = (groups.find((g) => g.label === season) || groups[0])?.eps || [];
  return html`<div class="od-show">
    <div class="od-show-head">
      <div class="od-show-art" title="Hold or right-click to change the picture" ...${holdArt(onArt)}><${Art} src=${s.poster || s.thumb} title=${s.name} /></div>
      <div class="od-show-meta">
        <h1>${s.name}</h1>
        <div class="muted">${s.genres?.length ? s.genres.slice(0, 4).join(' · ') + ' · ' : ''}${seasons.length > 1 ? `${seasons.length} seasons · ` : ''}${s.eps.length} episodes</div>
        <div class="row" style="gap:10px;margin-top:16px;flex-wrap:wrap">
          <button class="btn primary big gp-default" onClick=${() => onPlay(n.ep, n.at)}>▶ ${n.label}</button>
          ${n.at > 0 && html`<button class="btn big" onClick=${() => onPlay(n.ep, 0)}>⟲ Start ${epLabel(n.ep)} over</button>`}
          <button class="btn big" onClick=${onBack}>← All shows</button>
          ${(last || s.eps.some((e) => e.resume > 10 || e.watched)) && html`<button class="btn big ghost" title="Forget how far you've watched this show (asks first)" onClick=${onReset}>⟲ Start from the beginning</button>`}
        </div>
        <div class="small muted" style="margin-top:10px">Episodes play one after another — just sit back. Back returns here.</div>
      </div>
    </div>
    ${seasons.length > 1 && html`<div class="seg od-seasons">${seasons.map((x) => html`<button class=${x === season ? 'on' : ''} onClick=${() => setSeason(x)}>${x}</button>`)}</div>`}
    <div class="od-eps">${eps.map((e) => {
      const pct = e.resume > 10 && e.duration ? Math.min(100, (e.resume / e.duration) * 100) : e.watched ? 100 : 0;
      const isNext = e.id === n.ep.id;
      return html`<button class=${'od-ep' + (isNext ? ' next' : '')} onClick=${() => (e.resume > 10 ? onAsk(e) : onPlay(e, 0))}>
        <div class="od-ep-art"><${Art} src=${e.thumb} title=${epLabel(e)} />${pct > 0 && html`<i class=${'od-progress' + (e.watched && !(e.resume > 10) ? ' done' : '')} style=${`width:${pct}%`}></i>`}${e.watched && !(e.resume > 10) && html`<span class="od-ep-done">✓</span>`}</div>
        <div class="od-ep-meta"><b>${e.n ?? e.episode ?? ''}${e.n != null || e.episode != null ? '. ' : ''}${e.title}</b><small>${[season, runtime(e.duration), e.resume > 10 ? `${fmtClock(e.resume)} watched` : e.watched && '✓ Watched'].filter(Boolean).join(' · ')}</small></div>
        ${isNext && html`<span class="od-ep-tag">${n.at > 0 ? 'Continue' : 'Up next'}</span>`}
      </button>`;
    })}</div>
  </div>`;
}
