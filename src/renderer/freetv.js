// The Free TV stations page (Edit → Free TV stations): every live station in
// one place — search and genre-filter what you have, hide (👁) or remove (✕)
// any of them, and find new ones by name, genre or country across the whole
// iptv-org index, each tested before it joins the lineup.
import { html } from 'htm/preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { tv, Icon } from './util.js';
import { FreeTvDialog } from './libraryview.js';

const agoText = (t) => { const m = Math.round((Date.now() - t) / 60e3); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

export function FreeTvPanel({ isAdult, setChannels, toast, onTune }) {
  const [list, setList] = useState(null);     // your stations
  const [genres, setGenres] = useState({ have: [], all: [] });
  const [q, setQ] = useState('');
  const [genre, setGenre] = useState('');
  // find-more state
  const [fq, setFq] = useState('');
  const [fGenre, setFGenre] = useState('');
  const [fCountry, setFCountry] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState({});   // url -> 'trying' | 'dead'
  const [bulk, setBulk] = useState(false);
  const [auto, setAuto] = useState(false);    // auto-remove dead (user's call, off by default)

  const [gs, setGs] = useState(null);        // program guide report
  const [gBusy, setGBusy] = useState(false);
  const load = () => { tv.iptvList().then(setList); tv.guidesStatus().then(setGs).catch(() => {}); tv.iptvGenres().then(setGenres); tv.state().then((s) => setAuto(!!s.settings.live?.autoRemove)).catch(() => {}); };
  useEffect(load, []);

  const mine = useMemo(() => (list || []).filter((c) =>
    (!q || c.name.toLowerCase().includes(q.toLowerCase())) &&
    (!genre || c.group.toLowerCase().includes(genre.toLowerCase()))), [list, q, genre]);

  const hide = async (c, on) => {
    setChannels(await tv.channelHide(c.id, on));
    load();
    toast(on ? `🙈 ${c.name} hidden — it keeps its spot here` : `👁 ${c.name} is back on the guide`);
  };
  const remove = async (c) => {
    setChannels(await tv.deleteChannel(c.id));
    load();
    toast(`✕ ${c.name} removed`);
  };
  const search = async () => {
    setSearching(true); setResults(null);
    try {
      const r = await tv.iptvSearch({ q: fq, category: fGenre, country: fCountry });
      setResults(r);
    } catch { toast('Couldn’t reach the station index — are you online?'); }
    setSearching(false);
  };
  const add = async (st) => {
    setAdding((a) => ({ ...a, [st.url]: 'trying' }));
    const r = await tv.iptvAddOne(st).catch(() => ({ ok: false, why: 'something went wrong' }));
    if (r.ok) {
      setAdding((a) => ({ ...a, [st.url]: undefined }));
      setResults((res) => (res ? { ...res, results: res.results.filter((x) => x.url !== st.url) } : res));
      load();
      toast(`📡 ${r.name} added — channel ${r.number}`);
    } else {
      setAdding((a) => ({ ...a, [st.url]: 'dead' }));
      toast(`Couldn’t add it — ${r.why || 'station not answering'}`);
    }
  };

  if (!isAdult) return html`<div class="overlay"><div class="overlay-head"><h2>Free TV</h2></div><div class="overlay-body"><p class="muted">Ask a grown-up to change the stations.</p></div></div>`;
  const Row = (c) => html`<div class=${'ftv-row' + (c.hidden ? ' off' : '')} key=${c.id}>
    ${c.logo ? html`<img class="ftv-logo" src=${c.logo} loading="lazy" onError=${(e) => { e.target.style.visibility = 'hidden'; }} />` : html`<span class="ftv-logo">📺</span>`}
    <b class="ftv-num">${c.number}</b>
    <div class="grow"><b>${c.name}</b><span class="faint small"> ${[c.provider && `via ${c.provider}`, c.group, c.country && c.country.toUpperCase()].filter(Boolean).join(' · ')}${c.guide === false ? ' · no schedule yet' : ''}${c.dead ? ' · 💤 off the air lately' : ''}${c.hidden ? ' · hidden from the guide' : ''}</span></div>
    ${!c.hidden && html`<button class="btn sm" title="Watch" onClick=${() => onTune(c.id)}>▶</button>`}
    <button class="btn sm" title=${c.hidden ? 'Show it again' : 'Hide from the guide (keeps it here)'} onClick=${() => hide(c, !c.hidden)}>${c.hidden ? '👁 Show' : '🙈'}</button>
    <button class="btn sm" title="Remove completely" onClick=${() => remove(c)}>✕</button>
  </div>`;

  return html`<div class="overlay">
    <div class="overlay-head"><h2>📡 Free TV stations</h2>
      <span class="faint" style="margin-left:10px">${list ? `${list.length} station${list.length === 1 ? '' : 's'}${list.some((c) => c.hidden) ? ` · ${list.filter((c) => c.hidden).length} hidden` : ''}` : ''}</span>
      <span class="grow"></span>
      ${(list || []).some((c) => c.dead) && html`<button class="btn sm" onClick=${async () => { const r = await tv.iptvRemoveDead(); setChannels(r.channels); load(); toast(`🧹 ${r.removed} dead station${r.removed === 1 ? '' : 's'} removed`); }}>🧹 Remove ${list.filter((c) => c.dead).length} dead</button>`}
      <button class="btn sm" onClick=${() => setBulk(true)}>📡 Add in bulk (languages, countries, regions)…</button></div>
    <div class="overlay-body" style="max-width:980px">

      ${gs && gs.stations > 0 && html`<div class="guide-report">
        <div class="grow"><b>🗓 Program guide: ${gs.withGuide.toLocaleString()} of ${gs.stations.toLocaleString()} stations have a real schedule</b>
          <div class="faint small">${Object.entries(gs.bySource || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n.toLocaleString()} from ${k}`).join(' · ')}${gs.at ? ` · updated ${agoText(gs.at)}` : ''}${gs.until ? ` · good until about ${new Date(gs.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</div>
          <div class="faint small">Pluto TV stations use Pluto’s own schedule, exact to the minute. Others come from free public guides; stations with no schedule show “Live”. It refreshes by itself before it runs out.</div></div>
        <button class="btn sm" disabled=${gBusy || gs.refreshing} onClick=${async () => { setGBusy(true); toast('🗓 Refreshing the program guide — this takes a minute or two'); try { setGs(await tv.refreshGuides()); load(); toast('🗓 Program guide updated'); } catch { toast('Couldn’t refresh the guide — are you online?'); } setGBusy(false); }}>${gBusy || gs.refreshing ? 'Refreshing…' : '↻ Refresh guide now'}</button></div>`}
      <div class="row" style="gap:8px;margin-bottom:10px">
        <input class="input grow" placeholder="Search your stations…" value=${q} onInput=${(e) => setQ(e.target.value)} />
        <select class="select" value=${genre} onChange=${(e) => setGenre(e.target.value)}>
          <option value="">All genres</option>
          ${genres.have.map((g) => html`<option value=${g}>${g}</option>`)}
        </select></div>
      ${!list ? html`<div class="progress indeterminate"><i></i></div>`
        : !list.length ? html`<p class="muted">No live stations yet — use <b>Find new stations</b> below, or the bulk add.</p>`
        : html`<div class="ftv-list">${mine.map(Row)}</div>
          ${!mine.length && html`<p class="muted">Nothing matches “${q || genre}”.</p>`}`}

      <div class="row" style="gap:10px;margin-top:14px;align-items:center">
        <div class="grow"><b style="font-size:13.5px">Auto-remove stations that stay dead</b><div class="faint small">Off = you decide. Every start, HomeCable re-checks the lineup against the station index and ADDS new working stations; ones that stop answering just get a 💤 mark until you remove them (or turn this on).</div></div>
        <button class=${'toggle' + (auto ? ' on' : '')} onClick=${async () => { const r = await tv.iptvAutoRemove(!auto); setAuto(r.autoRemove); }}></button></div>

      <div class="section-title" style="margin-top:22px">Find new stations</div>
      <p class="muted small" style="margin:2px 0 10px">Searches the community iptv-org index — thousands of free, publicly available stations. Each one is tested before it joins your lineup.</p>
      <div class="row" style="gap:8px;margin-bottom:10px">
        <input class="input grow" placeholder="Station name — try “NASA”, “Rai”, “anime”…" value=${fq} onInput=${(e) => setFq(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') search(); e.stopPropagation(); }} />
        <select class="select" value=${fGenre} onChange=${(e) => setFGenre(e.target.value)}>
          <option value="">Any genre</option>
          ${genres.all.map((g) => html`<option value=${g}>${g}</option>`)}
        </select>
        <input class="input" style="width:90px" maxlength="2" placeholder="country" title="Two-letter country code — us, uk, jp…" value=${fCountry} onInput=${(e) => setFCountry(e.target.value.toLowerCase())} />
        <button class="btn primary" disabled=${searching} onClick=${search}>${searching ? 'Searching…' : 'Search'}</button></div>
      ${searching && html`<div class="progress indeterminate"><i></i></div>`}
      ${results && html`
        ${!results.results.length ? html`<p class="muted">Nothing found${fq ? ` for “${fq}”` : ''} — try fewer filters.</p>` : html`
        <div class="ftv-list">${results.results.map((st) => html`<div class="ftv-row" key=${st.url}>
          ${st.logo ? html`<img class="ftv-logo" src=${st.logo} loading="lazy" onError=${(e) => { e.target.style.visibility = 'hidden'; }} />` : html`<span class="ftv-logo">📺</span>`}
          <div class="grow"><b>${st.name}</b><span class="faint small"> ${[st.group, st.country && st.country.toUpperCase()].filter(Boolean).join(' · ')}</span></div>
          ${adding[st.url] === 'dead' && html`<span class="faint small">not answering</span>`}
          <button class="btn sm primary" disabled=${adding[st.url] === 'trying'} onClick=${() => add(st)}>${adding[st.url] === 'trying' ? 'Testing…' : '＋ Add'}</button>
        </div>`)}</div>
        <p class="faint small" style="margin-top:6px">Showing ${results.results.length} of ${results.searched.toLocaleString()} stations looked through.</p>`}`}
    </div>
    ${bulk && html`<${FreeTvDialog} onClose=${() => { setBulk(false); load(); }} toast=${toast} />`}
  </div>`;
}
