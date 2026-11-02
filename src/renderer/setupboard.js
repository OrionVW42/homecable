// First-run "Here's what we found": every movie and TV show HomeCable found, and
// where each one goes. HomeCable makes a best guess (Set it all up for me) or starts
// empty (I'll do it myself); either way you can drag things around, or click any
// card for a plain checklist. A movie or show can be in more than one place.
import { html } from 'htm/preact';
import { useMemo, useState } from 'preact/hooks';
import { PALETTE } from './util.js';

const OD = { id: 'od', kind: 'ondemand', name: 'Movies On Demand', logo: '🎬', color: '#7b61ff', number: 1, blurb: 'Pick a movie, watch it from the start' };
const HS = { id: 'hs', kind: 'series', name: 'Stream Demand', logo: '📺', color: '#e0558a', number: 2, blurb: 'Binge shows: seasons, episodes, next one plays itself' };

// The starting plan. guess=true: HomeCable's best guess; false: everything unplaced.
export function initialPlan(inv, guess, { odFolder, seriesFolder } = {}) {
  const dests = [];
  const members = {};
  // On Demand shows what's in the on-demand folder; Stream Demand, the shows folder.
  // (Drag anything else in from the board if you like.)
  const inside = (dir, root) => !!(root && dir && (dir.toLowerCase() + '\\').startsWith(root.toLowerCase().replace(/[\\/]+$/, '') + '\\'));
  const odMovies = inv.movies.filter((m) => inside(m.folder, odFolder));
  const hsShows = inv.shows.filter((s) => (s.folders || []).some((f) => inside(f, seriesFolder)));
  dests.push({ ...OD }); members.od = guess ? odMovies.map((m) => 'm:' + m.id) : [];
  dests.push({ ...HS }); members.hs = guess ? hsShows.map((s) => 's:' + s.key) : [];
  for (const g of inv.guess) {
    if (!g.members.length || !g.recommended) continue;
    dests.push({ id: g.id, kind: 'channel', name: g.name, logo: g.logo || '', color: g.color, order: g.order, align: g.align, reason: g.reason });
    members[g.id] = guess ? [...g.members] : [];
  }
  // Channels that aren't about movies or shows (music radio, short clips): simple on/off extras.
  const extras = inv.guess.filter((g) => !g.members.length).map((g) => ({ ...g, on: !!g.recommended }));
  return { dests, members, extras };
}

// The plan → channels to create.
export function planToChannels(plan, inv, { odFolder, seriesFolder }) {
  const allMovies = inv.movies.map((m) => 'm:' + m.id), allShows = inv.shows.map((s) => 's:' + s.key);
  const sourcesFor = (keys, d) => {
    const set = new Set(keys);
    const out = [];
    const everyMovie = allMovies.length && allMovies.every((k) => set.has(k));
    const everyShow = allShows.length && allShows.every((k) => set.has(k));
    // Everything of a kind → a source that also picks up new ones automatically.
    if (everyMovie && d.kind === 'channel') out.push({ type: 'kind', kind: 'movie', mine: true, label: 'All your movies' });
    if (!(everyMovie && d.kind === 'channel')) for (const k of keys) if (k.startsWith('m:')) out.push({ type: 'item', id: k.slice(2), label: inv.movies.find((m) => 'm:' + m.id === k)?.title || 'Movie' });
    if (everyShow && d.kind === 'channel') out.push({ type: 'kind', kind: 'episode', mine: true, label: 'All your TV shows' });
    if (!(everyShow && d.kind === 'channel')) for (const k of keys) if (k.startsWith('s:')) out.push({ type: 'show', key: k.slice(2), label: inv.shows.find((s) => 's:' + s.key === k)?.name || 'Show' });
    if (d.kind === 'ondemand' && odFolder) out.push({ type: 'folder', path: odFolder, label: 'On Demand folder', includePending: true });
    if (d.kind === 'series' && seriesFolder) out.push({ type: 'folder', path: seriesFolder, label: 'Stream Demand folder', includePending: true });
    return out;
  };
  const list = [];
  for (const d of plan.dests) {
    const keys = plan.members[d.id] || [];
    const sources = sourcesFor(keys, d);
    if (!sources.length) continue;
    if (d.kind === 'ondemand' || d.kind === 'series') list.push({ name: d.name, logo: d.logo, color: d.color, number: d.number, ondemand: true, odStyle: d.kind === 'series' ? 'series' : 'movies', sources });
    else if (keys.length) {
      const onlyMovies = keys.every((k) => k.startsWith('m:'));
      // No align set here: the setup's overall timing choice fills it in later.
      list.push({ name: d.name, logo: d.logo, color: d.color, order: d.order || (onlyMovies ? 'shuffle' : 'sequential'), align: d.align, sources });
    }
  }
  for (const x of plan.extras) if (x.on) { const { members, on, id, recommended, reason, ...ch } = x; list.push(ch); }
  return list;
}

const countOf = (keys) => {
  const m = keys.filter((k) => k.startsWith('m:')).length, s = keys.length - m;
  return [m && `${m} movie${m === 1 ? '' : 's'}`, s && `${s} show${s === 1 ? '' : 's'}`].filter(Boolean).join(' · ') || 'empty';
};

export function SetupBoard({ inv, plan, setPlan, guessed, onGuess }) {
  const [tab, setTab] = useState(inv.movies.length ? 'movies' : 'shows');
  const [filter, setFilter] = useState('all'); // 'all' | 'unplaced' | a destination id
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  const [pick, setPick] = useState(null); // card being placed with the checklist
  const [renaming, setRenaming] = useState(null);
  const [dragEnded, setDragEnded] = useState(0); // a drag isn't also a click

  const where = useMemo(() => {
    const w = {};
    for (const d of plan.dests) for (const k of plan.members[d.id] || []) (w[k] = w[k] || []).push(d);
    return w;
  }, [plan]);
  const cards = tab === 'movies'
    ? inv.movies.map((m) => ({ key: 'm:' + m.id, title: m.title, sub: [m.year, Math.round(m.duration / 60) + ' min'].filter(Boolean).join(' · '), art: m.poster }))
    : inv.shows.map((s) => ({ key: 's:' + s.key, title: s.name, sub: `${s.seasons > 1 ? s.seasons + ' seasons · ' : ''}${s.count} episodes`, art: s.poster || s.thumb, genres: s.genres }));
  const shown = cards.filter((c) => filter === 'all' || (filter === 'unplaced' ? !(where[c.key] || []).length : (plan.members[filter] || []).includes(c.key)));
  const unplaced = [...inv.movies.map((m) => 'm:' + m.id), ...inv.shows.map((s) => 's:' + s.key)].filter((k) => !(where[k] || []).length).length;

  const update = (fn) => setPlan((p) => { const n = { ...p, members: { ...p.members }, dests: [...p.dests] }; fn(n); return n; });
  const add = (destId, keys) => update((n) => { n.members[destId] = [...new Set([...(n.members[destId] || []), ...keys])]; });
  const remove = (destId, key) => update((n) => { n.members[destId] = (n.members[destId] || []).filter((k) => k !== key); });
  const toggle = (destId, key) => ((plan.members[destId] || []).includes(key) ? remove(destId, key) : add(destId, [key]));
  const newChannel = (withKey) => {
    const id = 'new-' + Date.now();
    update((n) => { n.dests.push({ id, kind: 'channel', name: `My Channel ${n.dests.filter((d) => d.kind === 'channel').length + 1}`, logo: '', color: PALETTE[n.dests.length % PALETTE.length] }); n.members[id] = withKey ? [withKey] : []; });
    setRenaming(id);
    return id;
  };
  const dropOn = (destId) => { if (drag) add(destId, [drag]); setDrag(null); setOver(null); };
  const kindOK = (d, key) => !(d.kind === 'ondemand' && key.startsWith('s:')) && !(d.kind === 'series' && key.startsWith('m:'));

  return html`<div class="board">
    <p class="lead board-found">We found <b>${inv.movies.length} movie${inv.movies.length === 1 ? '' : 's'}</b> and <b>${inv.shows.length} TV show${inv.shows.length === 1 ? '' : 's'}</b>${inv.other.episodes ? ` (${inv.other.episodes} episodes)` : ''}${inv.other.music ? `, plus ${inv.other.music} songs` : ''}${inv.other.clips ? ` and ${inv.other.clips} short clips` : ''}.
      ${guessed ? ' Here’s where HomeCable would put them — change anything you like.' : ' Put each one where you want it.'}</p>
    <div class="board-help">🖱️ <b>Drag</b> a movie or show onto a channel to add it there — or <b>click it</b> for a checklist. Something can be in more than one place (say, On Demand <i>and</i> “80s Movies”). Click <b>✕</b> on a tag to take it out. Anything not placed stays in your Library.
      ${!guessed && html` <button class="btn sm" onClick=${onGuess}>✨ Fill in HomeCable’s best guess</button>`}</div>

    <div class="board-dests">
      ${plan.dests.map((d) => html`<div class=${'dest' + (over === d.id ? ' over' : '') + (filter === d.id ? ' sel' : '')} style=${`--c:${d.color}`}
          onDragOver=${(e) => { if (drag && kindOK(d, drag)) { e.preventDefault(); setOver(d.id); } }} onDragLeave=${() => setOver(null)} onDrop=${() => dropOn(d.id)}>
        <button class="dest-main" onClick=${() => setFilter(filter === d.id ? 'all' : d.id)} title="Show what's in it">
          <span class="dest-logo">${d.logo || d.name.slice(0, 2).toUpperCase()}</span>
          <span class="dest-meta">${renaming === d.id ? html`<input class="input" style="height:28px" value=${d.name} autofocus onClick=${(e) => e.stopPropagation()}
                onInput=${(e) => { const v = e.target.value; update((n) => { n.dests = n.dests.map((x) => (x.id === d.id ? { ...x, name: v } : x)); }); }} onBlur=${() => setRenaming(null)} onKeyDown=${(e) => e.key === 'Enter' && setRenaming(null)} />`
            : html`<b>${d.name}</b>`}
            <small>${d.kind === 'ondemand' ? 'On Demand · ' : d.kind === 'series' ? 'Binge · ' : 'Channel · '}${countOf(plan.members[d.id] || [])}</small></span></button>
        ${d.kind === 'channel' && html`<div class="dest-tools">
          <button class="icon-btn sm" title="Rename" onClick=${() => setRenaming(d.id)}>✎</button>
          <button class="icon-btn sm" title="Remove this channel" onClick=${() => { update((n) => { n.dests = n.dests.filter((x) => x.id !== d.id); delete n.members[d.id]; }); if (filter === d.id) setFilter('all'); }}>✕</button></div>`}
        ${filter === d.id && html`<div class="dest-bulk">
          ${d.kind !== 'series' && inv.movies.length > 0 && html`<button class="btn sm" onClick=${() => add(d.id, inv.movies.map((m) => 'm:' + m.id))}>+ all movies</button>`}
          ${d.kind !== 'ondemand' && inv.shows.length > 0 && html`<button class="btn sm" onClick=${() => add(d.id, inv.shows.map((s) => 's:' + s.key))}>+ all shows</button>`}
          <button class="btn sm" onClick=${() => update((n) => { n.members[d.id] = []; })}>Empty it</button></div>`}
        ${filter === d.id && d.kind === 'channel' && html`<div class="dest-tune">
          <span class="small faint">Plays</span>
          <div class="seg">${[['sequential', 'In order'], ['shuffle', 'Shuffle'], ['random', 'Random']].map(([k, l]) => html`<button class=${(d.order || 'sequential') === k ? 'on' : ''} title=${{ sequential: 'Episodes in order, shows take turns', shuffle: 'Everything plays once before anything repeats', random: 'Fully random — anything, any time' }[k]} onClick=${() => update((n) => { n.dests = n.dests.map((x) => (x.id === d.id ? { ...x, order: k } : x)); })}>${l}</button>`)}</div>
          <span class="small faint">Starts</span>
          <div class="seg">${[[30, ':00/:30'], [0, 'Back-to-back']].map(([k, l]) => html`<button class=${(d.align ?? 30) === k ? 'on' : ''} onClick=${() => update((n) => { n.dests = n.dests.map((x) => (x.id === d.id ? { ...x, align: k } : x)); })}>${l}</button>`)}</div>
        </div>`}
      </div>`)}
      <div class=${'dest new' + (over === 'new' ? ' over' : '')} onDragOver=${(e) => { if (drag) { e.preventDefault(); setOver('new'); } }} onDragLeave=${() => setOver(null)}
        onDrop=${() => { if (drag) newChannel(drag); setDrag(null); setOver(null); }}>
        <button class="dest-main" onClick=${() => newChannel(null)}><span class="dest-logo">＋</span><span class="dest-meta"><b>New channel</b><small>Drop something here to start one</small></span></button>
      </div>
    </div>

    <div class="row board-bar">
      <div class="seg">
        ${inv.movies.length > 0 && html`<button class=${tab === 'movies' ? 'on' : ''} onClick=${() => setTab('movies')}>🎬 Movies (${inv.movies.length})</button>`}
        ${inv.shows.length > 0 && html`<button class=${tab === 'shows' ? 'on' : ''} onClick=${() => setTab('shows')}>📺 TV shows (${inv.shows.length})</button>`}
      </div>
      <span class="grow"></span>
      <div class="seg">
        <button class=${filter === 'all' ? 'on' : ''} onClick=${() => setFilter('all')}>Everything</button>
        <button class=${filter === 'unplaced' ? 'on' : ''} onClick=${() => setFilter('unplaced')}>Not placed yet (${unplaced})</button>
      </div>
    </div>
    ${filter !== 'all' && filter !== 'unplaced' && html`<div class="small muted" style="margin:-4px 0 8px">Showing what’s in <b>${plan.dests.find((d) => d.id === filter)?.name}</b> — click it again to see everything.</div>`}

    <div class="board-grid">
      ${shown.map((c) => html`<div class=${'bcard' + (drag === c.key ? ' dragging' : '')} key=${c.key} draggable="true"
          onDragStart=${(e) => { setDrag(c.key); e.dataTransfer.effectAllowed = 'copy'; }} onDragEnd=${() => { setDrag(null); setOver(null); setDragEnded(Date.now()); }}>
        <button class="bcard-main" onClick=${() => { if (Date.now() - dragEnded > 400) setPick(c); }} title="Where should this go?">
          <div class="bcard-art">${c.art ? html`<img src=${c.art} loading="lazy" alt="" onError=${(e) => { e.target.style.display = 'none'; }} />` : ''}<span>${c.title}</span></div>
          <b>${c.title}</b><small>${c.sub}</small></button>
        <div class="bcard-tags">${(where[c.key] || []).map((d) => html`<span class="tag" style=${`--c:${d.color}`}>${d.logo} ${d.name}<button title=${`Take it out of ${d.name}`} onClick=${() => remove(d.id, c.key)}>✕</button></span>`)}
          ${!(where[c.key] || []).length && html`<span class="tag none">Library only</span>`}</div>
      </div>`)}
      ${!shown.length && html`<div class="muted" style="padding:16px">Nothing here.</div>`}
    </div>

    ${plan.extras.length > 0 && html`<div class="opt-section" style="margin-top:18px">Extra channels</div>
      ${plan.extras.map((x, i) => html`<div class="opt-row"><div class="grow"><b>${x.logo} ${x.name}</b><span>${x.reason}</span></div>
        <button class=${'toggle' + (x.on ? ' on' : '')} onClick=${() => setPlan((p) => ({ ...p, extras: p.extras.map((y, j) => (j === i ? { ...y, on: !y.on } : y)) }))}></button></div>`)}`}

    ${pick && html`<div class="modal-bg" onClick=${() => setPick(null)}><div class="modal narrow" onClick=${(e) => e.stopPropagation()}>
      <div class="modal-head"><h3>Where should “${pick.title}” go?</h3></div>
      <div class="modal-body">
        ${plan.dests.filter((d) => kindOK(d, pick.key)).map((d, i) => html`<button class=${'check-row' + (i === 0 ? ' gp-default' : '')} onClick=${() => toggle(d.id, pick.key)}>
          <span class=${'box' + ((plan.members[d.id] || []).includes(pick.key) ? ' on' : '')}>${(plan.members[d.id] || []).includes(pick.key) ? '✓' : ''}</span>
          <span class="grow"><b>${d.logo} ${d.name}</b><small>${d.kind === 'ondemand' ? OD.blurb : d.kind === 'series' ? HS.blurb : d.reason || 'A channel that plays around the clock'}</small></span></button>`)}
        <button class="check-row" onClick=${() => { newChannel(pick.key); setPick(null); }}><span class="box">＋</span><span class="grow"><b>A new channel…</b><small>Start a channel with this in it</small></span></button>
        <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" onClick=${() => setPick(null)}>Done</button></div>
      </div></div></div>`}
  </div>`;
}
