// The Channel Manager: one bright screen to grow and tune an existing channel.
// Pick the channel up top, add shows and movies from "Good fits" (suggested by
// shared tags), see and trim what's on it now, change its name, number, look,
// order and timing — then Save. The bottom shows the channel like it's cable:
// its real schedule for the next few hours.
import { html } from 'htm/preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { tv, fmtTime, entryText, ChannelLogo, Icon, ORDER_LABEL, PALETTE } from './util.js';
import { LookEditor } from './look.js';

const srcKey = (s) => s.type + ':' + (s.key || s.id || s.path || s.kind || s.genre || s.channelId);

export function ChannelManager({ channels, setChannels, onTune, onEdit, toast, initialId }) {
  const list = channels.filter((c) => !c.iptv && !c.locked);
  const [id, setId] = useState(() => (list.some((c) => c.id === initialId) ? initialId : list[0]?.id || null));
  const [work, setWork] = useState(null);      // the channel being edited (working copy)
  const [rel, setRel] = useState(null);        // { current, suggest, genres } from the PC
  const [strip, setStrip] = useState(null);    // the cable strip: what it's airing
  const [added, setAdded] = useState([]);      // picked from suggestions, not saved yet
  const [removedNow, setRemovedNow] = useState([]); // taken off just now, not saved yet
  const [tab, setTab] = useState('shows');
  const [q, setQ] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fine, setFine] = useState(false);     // the look & colors drawer
  const savedRef = useRef(null);

  const load = async (chId) => {
    // Always edit the freshest copy the PC has — the app's list can lag a beat.
    const ch = (await tv.state()).channels.find((c) => c.id === chId) || channels.find((c) => c.id === chId);
    if (!ch) { setWork(null); return; }
    savedRef.current = JSON.stringify(ch);
    setWork(JSON.parse(JSON.stringify(ch)));
    setAdded([]); setRemovedNow([]); setDirty(false); setFine(false);
    setRel(null);
    tv.channelRelated(chId).then(setRel).catch(() => setRel({ current: { shows: [], movies: [] }, suggest: { shows: [], movies: [] }, genres: [] }));
    loadStrip(ch);
  };
  const loadStrip = (ch) => {
    if (!ch || ch.ondemand) { setStrip(null); return; }
    const from = Date.now() - 30 * 60e3;
    tv.guide(from, Date.now() + 4.5 * 3600e3).then((rows) => {
      const raw = rows.find((r) => r.id === ch.id)?.entries || [];
      // Breaks, bumpers and "up next" ride along with the show before them, like a real guide.
      const out = [];
      for (const e of raw) {
        const prev = out[out.length - 1];
        if ((e.type === 'filler' || e.type === 'upnext' || e.type === 'ad' || e.type === 'ident') && prev && prev.type === 'program') prev.end = e.end;
        else out.push({ ...e });
      }
      setStrip(out.filter((e) => e.end > Date.now()).slice(0, 10));
    }).catch(() => setStrip(null));
  };
  useEffect(() => { if (id) load(id); }, [id]);
  useEffect(() => tv.onScheduleChanged(() => { const ch = channels.find((c) => c.id === id); if (ch) loadStrip(ch); }), [id, channels]);
  // Saved from somewhere else (the advanced editor, a phone): pick the new version up.
  useEffect(() => { const ch = channels.find((c) => c.id === id); if (ch && savedRef.current && JSON.stringify(ch) !== savedRef.current && !dirty) load(id); }, [channels]);

  const set = (patch) => { setWork((w) => ({ ...w, ...patch })); setDirty(true); };
  const removeSource = (s) => set({ sources: work.sources.filter((x) => srcKey(x) !== srcKey(s)) });
  // Group-fed content (a folder, "all movies", a genre): taking it off means the
  // channel remembers "not this one" instead of dropping the whole source.
  const addExclude = (key, name) => {
    if ((work.exclude || []).includes(key)) return;
    set({ exclude: [...(work.exclude || []), key] });
    setRemovedNow((r) => [...r, { key, name }]);
  };
  const unExclude = (key) => {
    set({ exclude: (work.exclude || []).filter((k) => k !== key) });
    setRemovedNow((r) => r.filter((x) => x.key !== key));
  };
  const addShow = (s) => {
    if ((work.exclude || []).includes('show:' + s.key)) return unExclude('show:' + s.key);
    if (work.sources.some((x) => x.type === 'show' && x.key === s.key)) return;
    set({ sources: [...work.sources, { type: 'show', key: s.key, label: s.name }] });
    setAdded((a) => [...a, { kind: 'show', key: s.key, name: s.name, poster: s.poster || s.thumb, count: s.count }]);
  };
  const addMovie = (m) => {
    if ((work.exclude || []).includes('item:' + m.id)) return unExclude('item:' + m.id);
    if (work.sources.some((x) => x.type === 'item' && x.id === m.id)) return;
    set({ sources: [...work.sources, { type: 'item', id: m.id, label: m.title }] });
    setAdded((a) => [...a, { kind: 'movie', id: m.id, name: m.title, poster: m.poster || m.thumb, year: m.year }]);
  };
  const unAdd = (x) => {
    setAdded((a) => a.filter((y) => y !== x));
    set({ sources: work.sources.filter((s) => !(x.kind === 'show' ? s.type === 'show' && s.key === x.key : s.type === 'item' && s.id === x.id)) });
  };
  const save = async () => {
    setSaving(true);
    try {
      const listNew = await tv.updateChannel(work);
      setChannels(listNew);
      toast(`💾 Saved “${work.name}” — the schedule picks it up from here`);
      await load(work.id);
    } catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, '')); }
    setSaving(false);
  };
  const revert = () => { if (savedRef.current) { setWork(JSON.parse(savedRef.current)); setAdded([]); setDirty(false); } };

  // What's on it now, with pending removals filtered out live.
  const hasShowSrc = (key) => work?.sources.some((s) => s.type === 'show' && s.key === key);
  const hasItemSrc = (mid) => work?.sources.some((s) => s.type === 'item' && s.id === mid);
  const ex = work?.exclude || [];
  const curShows = (rel?.current.shows || []).filter((s) => (!s.removable || hasShowSrc(s.key)) && !ex.includes('show:' + s.key));
  const curMovies = (rel?.current.movies || []).filter((m) => (!m.removable || hasItemSrc(m.id)) && !ex.includes('item:' + m.id));
  // Everything taken off by hand (saved earlier + just now), for one-click restore.
  const removedAll = [...(rel?.excluded || []), ...removedNow].filter((x, i, a) => ex.includes(x.key) && a.findIndex((y) => y.key === x.key) === i);
  const addedKeys = new Set(added.map((x) => x.key || x.id));
  const otherSources = (work?.sources || []).filter((s) => s.type !== 'show' && s.type !== 'item');
  const ql = q.trim().toLowerCase();
  const sugShows = (rel?.suggest.shows || []).filter((s) => !addedKeys.has(s.key) && (!ql || s.name.toLowerCase().includes(ql)));
  const sugMovies = (rel?.suggest.movies || []).filter((m) => !addedKeys.has(m.id) && (!ql || m.title.toLowerCase().includes(ql)));
  const now = Date.now();

  if (!list.length) return html`<div class="overlay"><div class="overlay-head"><h2>Manage channels</h2></div>
    <div class="overlay-body"><p class="muted">No channels of your own yet — make one in the Channel list, or run Setup.</p></div></div>`;

  return html`<div class="overlay manager">
    <div class="overlay-head">
      <h2>Manage channels</h2>
      <select class="select mgr-pick" value=${id || ''} onChange=${(e) => setId(e.target.value)}>
        ${list.map((c) => html`<option value=${c.id}>${c.number} · ${c.name}${c.ondemand ? ' (On Demand)' : ''}</option>`)}
      </select>
      ${work && html`<button class="btn sm" title="Watch this channel" onClick=${() => onTune(work.id)}><${Icon.play} /> Watch</button>`}
      ${work && !work.ondemand && html`<button class="btn sm" title="Time blocks, breaks between shows and more" onClick=${() => onEdit(channels.find((c) => c.id === work.id))}><${Icon.edit} /> Time blocks & more</button>`}
      <span class="grow"></span>
      ${dirty && html`<span class="muted small">Unsaved changes</span><button class="btn sm ghost" onClick=${revert}>Undo changes</button>`}
      <button class="btn primary" disabled=${!dirty || saving} onClick=${save}>${saving ? 'Saving…' : '💾 Save channel'}</button>
    </div>
    ${work && html`<div class="overlay-body mgr-body">
      <div class="mgr-settings card">
        <${ChannelLogo} ch=${work} size=${56} />
        <label class="field">Name<input class="input" style="width:200px" value=${work.name} onInput=${(e) => set({ name: e.target.value })} /></label>
        <label class="field">Number<input class="input" type="number" min="1" style="width:80px" value=${work.number} onInput=${(e) => set({ number: +e.target.value })} /></label>
        ${!work.ondemand && html`<label class="field">Plays<div class="seg">${Object.entries(ORDER_LABEL).map(([k, l]) => html`<button class=${work.order === k ? 'on' : ''} title=${l} onClick=${() => set({ order: k })}>${{ sequential: 'In order', shuffle: 'Shuffle', random: 'Random', ordered: 'List order' }[k]}</button>`)}</div></label>
        <label class="field">Shows start<div class="seg">${[[30, ':00/:30'], [60, 'On the hour'], [15, 'Quarter hours'], [0, 'Back-to-back']].map(([k, l]) => html`<button class=${work.align === k ? 'on' : ''} onClick=${() => set({ align: k })}>${l}</button>`)}</div></label>`}
        <label class="field">Who can watch<div class="seg">${[['auto', 'Auto'], ['all', 'Everyone'], ['teen', 'Teens+'], ['adult', 'Grown-ups']].map(([k, l]) => html`<button class=${(work.rating || 'auto') === k ? 'on' : ''} title=${k === 'auto' ? 'HomeCable guesses from what’s on the channel' : ''} onClick=${() => set({ rating: k === 'auto' ? null : k })}>${l}</button>`)}</div></label>
        <button class=${'btn sm' + (fine ? ' primary' : '')} onClick=${() => setFine(!fine)}>🎨 Logo & colors</button>
      </div>
      ${fine && html`<div class="card" style="margin-bottom:14px">
        <${LookEditor} name=${work.name} color=${work.color} value=${work.look || null} onChange=${(lk) => set({ look: lk })} channelId=${work.id} toast=${toast} />
        <label class="field" style="margin-top:10px">Channel color<div class="swatches">${PALETTE.map((p) => html`<button title=${p} class=${work.color === p ? 'on' : ''} style=${'background:' + p} onClick=${() => set({ color: p })}></button>`)}</div></label>
      </div>`}

      <div class="mgr-cols">
        <div class="mgr-col">
          <div class="section-title row" style="gap:10px">✨ Good fits to add
            ${rel?.genres?.length > 0 && html`<span class="mgr-why">because this channel likes ${rel.genres.slice(0, 3).join(', ')}</span>`}</div>
          <div class="row" style="margin-bottom:10px">
            <div class="seg"><button class=${tab === 'shows' ? 'on' : ''} onClick=${() => setTab('shows')}>📺 Shows</button><button class=${tab === 'movies' ? 'on' : ''} onClick=${() => setTab('movies')}>🎬 Movies</button></div>
            <input class="input grow" placeholder="Search your library…" value=${q} onInput=${(e) => setQ(e.target.value)} />
          </div>
          <div class="mgr-grid">
            ${!rel && html`<div class="muted" style="padding:14px">Looking through your library…</div>`}
            ${rel && tab === 'shows' && sugShows.map((s) => html`<button class="mgr-card" key=${s.key} title=${(s.genres || []).join(' · ') || s.name} onClick=${() => addShow(s)}>
              <div class="mgr-art">${(s.poster || s.thumb) && html`<img src=${s.poster || s.thumb} loading="lazy" alt="" onError=${(e) => { e.target.style.display = 'none'; }} />`}<i class="mgr-add">＋</i></div>
              <b>${s.name}</b><small>${s.count} episode${s.count === 1 ? '' : 's'}${s.sc > 0 ? ' · good fit' : ''}</small>
            </button>`)}
            ${rel && tab === 'movies' && sugMovies.map((m) => html`<button class="mgr-card" key=${m.id} title=${(m.genres || []).join(' · ') || m.title} onClick=${() => addMovie(m)}>
              <div class="mgr-art">${(m.poster || m.thumb) && html`<img src=${m.poster || m.thumb} loading="lazy" alt="" onError=${(e) => { e.target.style.display = 'none'; }} />`}<i class="mgr-add">＋</i></div>
              <b>${m.title}</b><small>${m.year || 'Movie'}${m.sc > 0 ? ' · good fit' : ''}</small>
            </button>`)}
            ${rel && ((tab === 'shows' && !sugShows.length) || (tab === 'movies' && !sugMovies.length)) && html`<div class="muted" style="padding:14px">${ql ? 'Nothing matches that search.' : 'Everything is already on this channel.'}</div>`}
          </div>
        </div>
        <div class="mgr-col">
          <div class="section-title">📺 On this channel</div>
          ${otherSources.length > 0 && html`<div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:10px">
            ${otherSources.map((s) => html`<span class="chip">${s.type === 'folder' ? '📁 ' : s.type === 'live' ? '📡 ' : '✨ '}${s.label || s.path || s.kind || s.genre}<button title="Take it off the channel" onClick=${() => removeSource(s)}>×</button></span>`)}
          </div>`}
          <div class="mgr-grid">
            ${added.map((x) => html`<div class="mgr-card here new" key=${'new-' + (x.key || x.id)}>
              <div class="mgr-art">${x.poster && html`<img src=${x.poster} loading="lazy" alt="" onError=${(e) => { e.target.style.display = 'none'; }} />`}<span class="mgr-new">NEW</span></div>
              <b>${x.name}</b><small>${x.kind === 'show' ? `${x.count} episodes` : x.year || 'Movie'}</small>
              <button class="mgr-x" title="Never mind" onClick=${() => unAdd(x)}>✕</button>
            </div>`)}
            ${curShows.map((s) => html`<div class="mgr-card here" key=${s.key}>
              <div class="mgr-art">${(s.poster || s.thumb) && html`<img src=${s.poster || s.thumb} loading="lazy" alt="" onError=${(e) => { e.target.style.display = 'none'; }} />`}</div>
              <b>${s.name}</b><small>${s.count} episode${s.count === 1 ? '' : 's'}${s.via ? ` · via ${s.via}` : ''}</small>
              <button class="mgr-x" title=${s.removable ? 'Take this show off the channel' : 'Take this show off the channel (it comes in ' + (s.via || 'a group') + ', so it goes on the removed list)'} onClick=${() => (s.removable ? removeSource({ type: 'show', key: s.key }) : addExclude('show:' + s.key, s.name))}>✕</button>
            </div>`)}
            ${curMovies.map((m) => html`<div class="mgr-card here" key=${m.id}>
              <div class="mgr-art">${(m.poster || m.thumb) && html`<img src=${m.poster || m.thumb} loading="lazy" alt="" onError=${(e) => { e.target.style.display = 'none'; }} />`}</div>
              <b>${m.title}</b><small>${m.year || m.kind || 'Movie'}${m.via ? ` · via ${m.via}` : ''}</small>
              <button class="mgr-x" title=${m.removable ? 'Take this movie off the channel' : 'Take this movie off the channel (it comes in ' + (m.via || 'a group') + ', so it goes on the removed list)'} onClick=${() => (m.removable ? removeSource({ type: 'item', id: m.id }) : addExclude('item:' + m.id, m.title))}>✕</button>
            </div>`)}
            ${rel && !curShows.length && !curMovies.length && !added.length && html`<div class="muted" style="padding:14px">Nothing on it yet — add shows and movies from the left.</div>`}
          </div>
          ${removedAll.length > 0 && html`<div class="small muted" style="margin-top:10px">Removed by hand — click to bring back:</div>
          <div class="row" style="flex-wrap:wrap;gap:6px;margin-top:6px">
            ${removedAll.map((x) => html`<button class="chip" title="Put it back on the channel" onClick=${() => unExclude(x.key)}>↩ ${x.name || x.key}</button>`)}
          </div>`}
        </div>
      </div>

      <div class="section-title" style="margin-top:18px">${work.ondemand ? '🎬 How it looks on the air' : '📺 On the air — the next few hours'}${dirty && !work.ondemand ? html` <span class="mgr-why">save to see the new schedule</span>` : ''}</div>
      <div class="mgr-strip">
        <div class="mgr-strip-ch"><b>${work.number}</b><${ChannelLogo} ch=${work} size=${40} /><span>${work.name}</span></div>
        ${work.ondemand
          ? html`<div class="mgr-cell on-now" style="flex:1"><div class="t">On Demand — pick a ${work.odStyle === 'series' ? 'show' : 'movie'}</div><div class="s">${(rel ? curShows.length + curMovies.length + added.length : '…')} titles on the wall, any time</div></div>`
          : strip === null
            ? html`<div class="mgr-cell" style="flex:1"><div class="t">Loading the schedule…</div></div>`
            : strip.map((e) => { const tx = entryText(e); const on = e.start <= now && now < e.end; return html`<div class=${'mgr-cell ' + e.type + (on ? ' on-now' : '')} style=${`flex:${Math.max(1, Math.min(6, (e.end - e.start) / 1800e3))}`}>
              <div class="t">${on ? '● ' : ''}${tx.title}</div><div class="s">${fmtTime(e.start)}${tx.sub ? ' · ' + tx.sub : ''}</div>
            </div>`; })}
      </div>
    </div>`}
  </div>`;
}
