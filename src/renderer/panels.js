import { html } from 'htm/preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { tv, fmtDur, ChannelLogo, Icon, ORDER_LABEL, PALETTE } from './util.js';
import { LookEditor } from './look.js';
import { VaultSettings } from './vault.js';
import { PhoneSettings } from './phonesettings.js';
import { ControlsMap } from './controls.js';
import { FreeTvDialog } from './libraryview.js';
import { ProfilesSettings, LEVEL_LABEL } from './profiles.js';

const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LOGOS = ['', '📺', '🎬', '🍿', '😂', '🚀', '🎨', '⛩️', '🌙', '🔍', '🦇', '🌍', '🍳', '💥', '🎸', '📻', '🏈', '👶', '🧪', '🎮', '📼', '🔀'];

function srcLabel(s) {
  if (s.label) return s.label;
  if (s.type === 'folder') return s.path;
  if (s.type === 'kind') return 'All ' + s.kind;
  return s.key || s.id;
}

// ---------- Source picker ----------
function SourcePicker({ value, onChange, onClose, title = 'Add content', allowLive }) {
  const [live, setLive] = useState([]);
  useEffect(() => { if (allowLive) tv.liveStations().then(setLive); }, []);
  const [tab, setTab] = useState('shows');
  const [shows, setShows] = useState([]);
  const [items, setItems] = useState([]);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(() => value.slice());
  const [folders, setFolders] = useState([]);
  useEffect(() => {
    tv.shows().then(setShows);
    tv.items().then(setItems);
    tv.state().then((s) => setFolders(s.stats.folders));
  }, []);
  const key = (s) => s.type + ':' + (s.key || s.id || s.path || s.kind || s.genre);
  const has = (s) => picked.some((p) => key(p) === key(s));
  const toggle = (s) => setPicked((p) => (has(s) ? p.filter((x) => key(x) !== key(s)) : [...p, s]));
  const ql = q.toLowerCase();
  const genres = useMemo(() => [...new Set(shows.flatMap((s) => s.genres))].sort(), [shows]);
  const movies = items.filter((i) => i.kind === 'movie' || i.kind === 'clip' || i.kind === 'short');
  const showFolders = useMemo(() => [...new Set(items.map((i) => i.folder))].sort(), [items]);
  const kinds = [['episode', 'All TV episodes'], ['movie', 'All movies'], ['music', 'All music'], ['short', 'All short clips (good for breaks)'], ['clip', 'All other videos']];

  const Row = ({ s, main, sub }) => html`<div class=${'pick-item' + (has(s) ? ' on' : '')} onClick=${() => toggle(s)}>
    <div class="box">${has(s) ? '✓' : ''}</div><div class="grow"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${main}</div>${sub && html`<div class="small muted">${sub}</div>`}</div></div>`;

  return html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal">
      <div class="modal-head"><h3>${title}</h3><button class="icon-btn" onClick=${onClose}><${Icon.close} /></button></div>
      <div class="modal-body">
        <div class="row" style="margin-bottom:12px">
          <div class="tabs" style="margin:0">
            ${[['shows', 'Shows'], ['movies', 'Movies & videos'], ['groups', 'Collections'], ['folders', 'Folders'], ...(allowLive ? [['live', '📡 Live TV']] : [])].map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}
          </div>
          <input class="input grow" placeholder="Search…" value=${q} onInput=${(e) => setQ(e.target.value)} />
        </div>
        <div class="pick-list">
          ${tab === 'shows' && (shows.length ? shows.filter((s) => s.name.toLowerCase().includes(ql)).map((s) => html`<${Row} s=${{ type: 'show', key: s.key, label: s.name }} main=${s.name} sub=${`${s.count} episodes · ~${fmtDur(s.avg)} each${s.genres.length ? ' · ' + s.genres.slice(0, 3).join(', ') : ''}`} />`) : html`<div class="list-row muted">No shows found yet. Add folders in Library.</div>`)}
          ${tab === 'movies' && movies.filter((m) => (m.title + m.path).toLowerCase().includes(ql)).slice(0, 500).map((m) => html`<${Row} s=${{ type: 'item', id: m.id, label: m.title }} main=${m.title + (m.year ? ` (${m.year})` : '')} sub=${`${m.kind} · ${fmtDur(m.duration)}`} />`)}
          ${tab === 'groups' && html`
            ${kinds.map(([k, l]) => html`<${Row} s=${{ type: 'kind', kind: k, label: l }} main=${l} sub=${items.filter((i) => i.kind === k).length + ' files — new ones join automatically'} />`)}
            ${genres.map((g) => html`<${Row} s=${{ type: 'genre', genre: g, label: g + ' shows' }} main=${g + ' shows'} sub="From online show info" />`)}`}
          ${tab === 'live' && (live.length ? live.filter((s) => s.name.toLowerCase().includes(ql)).map((s) => html`<${Row} s=${{ type: 'live', channelId: s.id, label: s.name }} main=${`${s.number} · ${s.name}`} sub=${[s.now ? 'Now: ' + s.now : '', s.group, s.dead ? 'off the air' : ''].filter(Boolean).join(' · ')} />`) : html`<div class="list-row muted">No live stations yet — add free TV in Library → Free TV.</div>`)}
          ${tab === 'folders' && html`
            <div class="pick-item" onClick=${async () => { const fs = await tv.pickFolders(); for (const f of fs) toggle({ type: 'folder', path: f, label: f.split(/[\\/]/).pop() }); }}>
              <div class="box">+</div><div class="grow"><b>Choose a folder…</b><div class="small muted">Everything inside, including future downloads (folder must be in your library)</div></div></div>
            ${[...new Set([...folders, ...showFolders])].filter((f) => f.toLowerCase().includes(ql)).slice(0, 400).map((f) => html`<${Row} s=${{ type: 'folder', path: f, label: f.split(/[\\/]/).pop() }} main=${f.split(/[\\/]/).pop()} sub=${f} />`)}`}
        </div>
      </div>
      <div class="modal-foot"><span class="muted grow">${picked.length} selected</span><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" onClick=${() => { onChange(picked); onClose(); }}>Done</button></div>
    </div>
  </div>`;
}

function Sources({ value, onChange, empty, allowLive }) {
  const [open, setOpen] = useState(false);
  return html`<div>
    <div class="row" style="flex-wrap:wrap;gap:6px">
      ${value.map((s, i) => html`<span class="chip">${s.type === 'folder' ? '📁 ' : s.type === 'show' ? '📺 ' : s.type === 'item' ? '🎬 ' : s.type === 'live' ? '📡 ' : '✨ '}${srcLabel(s)}<button onClick=${() => onChange(value.filter((_, j) => j !== i))}>×</button></span>`)}
      ${!value.length && html`<span class="muted small">${empty}</span>`}
      <button class="btn sm" onClick=${() => setOpen(true)}><${Icon.plus} /> Add</button>
    </div>
    ${open && html`<${SourcePicker} value=${value} onChange=${onChange} onClose=${() => setOpen(false)} allowLive=${allowLive} />`}
  </div>`;
}

function WeekView({ blocks }) {
  return html`<div class="week">
    <span></span><div class="ticks">${[0, 6, 12, 18, 24].map((h) => html`<span style=${`left:${(h / 24) * 100}%`}>${h === 0 || h === 24 ? '12a' : h === 12 ? '12p' : h > 12 ? h - 12 + 'p' : h + 'a'}</span>`)}</div>
    ${DAY_NAMES.map((d, di) => html`<span>${d}</span><div class="lane">${blocks.flatMap((b, bi) => {
      if (!b.days?.includes(di)) return [];
      const [sh, sm] = (b.start || '0:0').split(':').map(Number), [eh, em] = (b.end || '0:0').split(':').map(Number);
      const s = sh * 60 + sm; let e = eh * 60 + em; if (e <= s) e = 1440;
      return [html`<i title=${`${b.name || 'Block'} ${b.start}–${b.end}`} style=${`left:${(s / 1440) * 100}%;width:${((e - s) / 1440) * 100}%;background:${PALETTE[bi % PALETTE.length]}`}></i>`];
    })}</div>`)}
  </div>`;
}

// ---------- Channel editor ----------
const MY_MOVIES = { type: 'kind', kind: 'movie', mine: true, label: 'All your movies' };
const MY_SHOWS = { type: 'kind', kind: 'episode', mine: true, label: 'All your TV shows' };

export function ChannelEditor({ channel, onSave, onDelete, onClose }) {
  const [c, setC] = useState(() => JSON.parse(JSON.stringify(channel)));
  const [preview, setPreview] = useState(null);
  const set = (patch) => setC((v) => ({ ...v, ...patch }));
  useEffect(() => { tv.previewChannel(c).then(setPreview); }, [c.sources, c.blocks]);
  const setBlock = (i, patch) => set({ blocks: c.blocks.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  const addBlock = () => set({ blocks: [...c.blocks, { name: '', days: [1, 2, 3, 4, 5], start: '20:00', end: '21:00', order: 'sequential', sources: [] }] });

  return html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal">
      <div class="modal-head"><${ChannelLogo} ch=${c} size=${38} /><h3>${channel.id ? 'Edit channel' : 'New channel'}</h3><button class="icon-btn" onClick=${onClose}><${Icon.close} /></button></div>
      <div class="modal-body">
        <div class="form-grid">
          <label class="field">Channel name<input class="input" value=${c.name} onInput=${(e) => set({ name: e.target.value })} autofocus /></label>
          <label class="field">Number<input class="input" type="number" min="1" value=${c.number} onInput=${(e) => set({ number: +e.target.value })} /></label>
        </div>
        <div class="section-title">Network logo</div>
        <div class="small muted" style="margin:-4px 0 10px">Give the channel its own network mark — it shows in the guide, the banner and the channel bumpers. Pick a ready-made look, fine-tune it, or use a picture of your own.</div>
        <${LookEditor} name=${c.name || 'New Channel'} color=${c.color} value=${c.look || null} onChange=${(lk) => set({ look: lk })} channelId=${channel.id || null} />
        <div class="row" style="margin-top:14px;align-items:flex-start;gap:28px;flex-wrap:wrap">
          <label class="field">Color<div class="swatches">${PALETTE.map((p) => html`<button title=${p} class=${c.color === p ? 'on' : ''} style=${'background:' + p} onClick=${() => set({ color: p })}></button>`)}</div></label>
          ${!c.look && html`<label class="field">Emoji logo<div class="swatches">${LOGOS.map((l) => html`<button class=${c.logo === l ? 'on' : ''} style="background:var(--raise);font-size:15px" onClick=${() => set({ logo: l })}>${l || 'Aa'}</button>`)}</div></label>`}
        </div>

        <div class="section-title">Who can watch</div>
        <div class="seg">${[['auto', '✨ Auto'], ['all', 'Everyone (kids too)'], ['teen', 'Teens & grown-ups'], ['adult', 'Grown-ups only']].map(([k, l]) => html`<button class=${(c.rating || 'auto') === k ? 'on' : ''} onClick=${() => set({ rating: k === 'auto' ? null : k })}>${l}</button>`)}</div>
        ${!c.rating && html`<div class="small muted" style="margin-top:6px">Auto — HomeCable guesses from what’s on the channel, and re-guesses when its content changes.</div>`}
        ${!c.iptv && html`<div class="section-title">How it plays</div>
        <div class="seg how-plays">
          <button class=${!c.ondemand ? 'on' : ''} onClick=${() => set({ ondemand: false })}>📺 Like cable — on a schedule</button>
          <button class=${c.ondemand ? 'on' : ''} onClick=${() => set({ ondemand: true, sources: c.sources.length ? c.sources : [MY_MOVIES] })}>🎬 On demand — pick a movie</button>
        </div>
        ${c.ondemand && html`<div class="seg" style="margin-top:10px">
          <button class=${c.odStyle !== 'series' ? 'on' : ''} onClick=${() => set({ odStyle: 'movies' })}>Movies first</button>
          <button class=${c.odStyle === 'series' ? 'on' : ''} onClick=${() => set({ odStyle: 'series' })}>Shows first (Stream Demand — binge seasons)</button></div>`}
        <div class="small muted" style="margin-top:6px">${c.ondemand ? 'Tune to this channel and you get a wall of movie posters — pick one and it plays from the start, with pause, rewind and resume.' : 'Always on: shows air at set times, and you join them in progress.'}</div>`}
        <div class="section-title">${c.ondemand ? 'Movies to offer' : 'What plays'}</div>
        <${Sources} value=${c.sources} onChange=${(v) => set({ sources: v })} empty=${c.ondemand ? 'Nothing yet — add “All your movies”, a folder of films, or pick movies one by one.' : 'Nothing yet — add shows, movies or folders. (A channel with only time blocks is off air between them.)'} />
        ${c.ondemand && html`<button class="btn sm" style="margin-top:10px;margin-right:8px" onClick=${async () => {
          const f = await tv.onDemandPickFolder();
          if (!f || c.sources.some((x) => x.type === 'folder' && x.path.toLowerCase() === f.toLowerCase())) return;
          set({ sources: [...c.sources, { type: 'folder', path: f, label: 'Folder: ' + f.split(/[\\/]/).filter(Boolean).pop(), includePending: true }] });
          tv.scan([f]); // read it now, and watch it for new movies from then on
        }}><${Icon.folder} /> Choose a folder… (new movies join automatically)</button>`}
        ${c.ondemand && !c.sources.some((x) => x.type === 'kind' && x.kind === 'movie') && html`<button class="btn sm" style="margin-top:10px" onClick=${() => set({ sources: [...c.sources, MY_MOVIES] })}><${Icon.plus} /> All your movies (new ones join automatically)</button>`}
        ${!c.ondemand && html`
        <div class="row" style="margin-top:14px;flex-wrap:wrap">
          <div class="seg">${Object.entries(ORDER_LABEL).map(([k, l]) => html`<button class=${c.order === k ? 'on' : ''} onClick=${() => set({ order: k })}>${l}</button>`)}</div>
        </div>
        <div class="row" style="margin-top:12px;flex-wrap:wrap">
          <span class="muted small">Start programs on</span>
          <div class="seg">${[[30, ':00 and :30'], [60, 'the hour'], [15, 'quarter hours'], [0, 'back-to-back']].map(([k, l]) => html`<button class=${c.align === k ? 'on' : ''} onClick=${() => set({ align: k })}>${l}</button>`)}</div>
        </div>
        <div class="small muted" style="margin-top:6px;max-width:720px">${c.align === 0
          ? 'One continuous network: the next show starts the moment the last one ends, from whichever time block is on at that moment. A block takes over as soon as the show playing at its start time ends (nothing is cut off, nothing waits), and between blocks the last block keeps playing. Live blocks still start right on time.'
          : 'Like cable: shows start on the clock, with breaks or an “Up next” card in between, and time blocks start exactly on time. Pick “back-to-back” for no waiting.'}</div>
        `}
        ${preview && html`<div class="small muted" style="margin-top:10px">${preview.items} ${c.ondemand ? 'titles' : 'videos'} · ${preview.hours.toFixed(1)} hours of content</div>`}
        ${!c.ondemand && html`

        <div class="section-title">Breaks between shows</div>
        <${Sources} value=${c.filler} onChange=${(v) => set({ filler: v })} empty="Optional — add a folder of commercials, trailers or bumpers. Gaps without filler show an “Up next” card." />

        <div class="section-title">Time blocks <span style="text-transform:none;letter-spacing:0;font-weight:500">— air specific shows at set times, like a real schedule</span></div>
        ${c.blocks.length > 0 && html`<div style="margin-bottom:14px"><${WeekView} blocks=${c.blocks} /></div>`}
        ${c.blocks.map((b, i) => html`<div class="block-card" key=${b.id || i}>
          <div class="row" style="flex-wrap:wrap">
            <input class="input" style="width:180px" placeholder="Block name (e.g. Saturday Cartoons)" value=${b.name} onInput=${(e) => setBlock(i, { name: e.target.value })} />
            <div class="days">${DAYS.map((d, di) => html`<button class=${b.days.includes(di) ? 'on' : ''} title=${DAY_NAMES[di]} onClick=${() => setBlock(i, { days: b.days.includes(di) ? b.days.filter((x) => x !== di) : [...b.days, di].sort() })}>${d}</button>`)}</div>
            <input class="input" type="time" step="900" value=${b.start} onInput=${(e) => setBlock(i, { start: e.target.value })} />
            <span class="muted">to</span>
            <input class="input" type="time" step="900" value=${b.end} onInput=${(e) => setBlock(i, { end: e.target.value })} />
            <select class="select" value=${b.order} onChange=${(e) => setBlock(i, { order: e.target.value })}>${Object.entries(ORDER_LABEL).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select>
            <button class="icon-btn" title="Remove block" onClick=${() => set({ blocks: c.blocks.filter((_, j) => j !== i) })}><${Icon.trash} /></button>
          </div>
          <div style="margin-top:10px"><${Sources} allowLive value=${b.sources} onChange=${(v) => setBlock(i, { sources: v })} empty="Pick what airs in this block — your shows, or a live station (📡 Live TV tab)" /></div>
          ${b.date && html`<div class="small muted" style="margin-top:6px">One time only: ${b.date}</div>`}
        </div>`)}
        <button class="btn sm" onClick=${addBlock}><${Icon.plus} /> Add time block</button>`}
      </div>
      <div class="modal-foot">
        ${channel.id && html`<button class="btn danger" onClick=${() => onDelete(channel)} style="margin-right:auto"><${Icon.trash} /> Delete channel</button>`}
        <button class="btn" onClick=${onClose}>Cancel</button>
        <button class="btn primary" onClick=${() => onSave(c)} disabled=${!c.name.trim()}>Save channel</button>
      </div>
    </div>
  </div>`;
}

// ---------- Suggestions ----------
export function Suggestions({ list, onCreate, compact }) {
  const [on, setOn] = useState(() => new Set(list.filter((s) => s.recommended).map((s) => s.id)));
  useEffect(() => setOn(new Set(list.filter((s) => s.recommended).map((s) => s.id))), [list]);
  const tog = (id) => setOn((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  if (!list.length) return html`<p class="muted">No new suggestions — your library is already covered, or there isn't enough content yet.</p>`;
  return html`<div>
    <div style=${compact ? 'max-height:46vh;overflow:auto;margin:0 -14px' : ''}>
      ${list.map((s) => html`<div class=${'sug' + (on.has(s.id) ? ' on' : '')} onClick=${() => tog(s.id)}>
        <div class="pick-item ${on.has(s.id) ? 'on' : ''}" style="padding:0;border:0;background:none"><div class="box">${on.has(s.id) ? '✓' : ''}</div></div>
        <${ChannelLogo} ch=${s} size=${38} />
        <div class="meta"><b>${s.name}</b><span>${s.reason}</span></div>
      </div>`)}
    </div>
    <div class="row" style="margin-top:16px">
      <button class="btn ghost sm" onClick=${() => setOn(new Set(list.map((s) => s.id)))}>Select all</button>
      <button class="btn ghost sm" onClick=${() => setOn(new Set())}>None</button>
      <span class="grow"></span>
      <button class="btn primary" disabled=${!on.size} onClick=${() => onCreate(list.filter((s) => on.has(s.id)))}>Create ${on.size} channel${on.size === 1 ? '' : 's'}</button>
    </div>
  </div>`;
}

// ---------- Channels panel ----------
export function ChannelsPanel({ channels, setChannels, onTune, onEdit, toast }) {
  const [sugs, setSugs] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const drop = async (targetId, list) => {
    if (!dragId || dragId === targetId || !list.some((c) => c.id === dragId)) return;
    const ids = list.map((c) => c.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    setChannels(await tv.renumber(ids, list[0].number));
    toast('Channels renumbered');
  };
  const doImport = async () => {
    const r = await tv.importLegacy();
    if (!r) return;
    setChannels((await tv.state()).channels);
    toast(`Imported ${r.blocks} time blocks into “${r.channel.name}”` + (r.missing.length ? ` — couldn't find ${r.missing.join(', ')} on this PC` : r.scanning.length ? ' — scanning its folders now' : ''));
  };
  return html`<div class="overlay">
    <div class="overlay-head"><h2>Channels</h2><span class="muted" style="margin-bottom:6px">${channels.length} channels · drag to renumber</span><span class="grow"></span>
      ${channels.some((c) => c.iptv) && html`<button class="btn" onClick=${async () => { toast('Checking live stations…'); const r = await tv.iptvCheckAll(); toast(`${r.up} stations on the air, ${r.down} off the air`); setChannels((await tv.state()).channels); }}>📡 Check stations</button>`}
      ${channels.some((c) => c.iptv?.dead) && html`<button class="btn danger" onClick=${async () => { const r = await tv.iptvRemoveDead(); setChannels(r.channels); toast(`Removed ${r.removed} off-air stations`); }}>Remove off-air (${channels.filter((c) => c.iptv?.dead).length})</button>`}
      <button class="btn" onClick=${doImport}><${Icon.import} /> Import old schedule</button>
      <button class="btn" onClick=${async () => setSugs(await tv.suggest())}><${Icon.sparkle} /> Suggest channels</button>
      <button class="btn" title="A channel that shows a wall of your movies — pick one and watch it from the start" onClick=${() => onEdit({ name: 'Movies On Demand', number: '', ondemand: true, odStyle: 'movies', sources: [MY_MOVIES], filler: [], blocks: [], order: 'sequential', align: 30, color: '#7b61ff', logo: '🎬' })}>🎬 On Demand movies</button>
      <button class="btn" title="Stream on demand: your TV shows, season by season — the next episode plays by itself" onClick=${() => onEdit({ name: 'Stream Demand', number: '', ondemand: true, odStyle: 'series', sources: [MY_SHOWS], filler: [], blocks: [], order: 'sequential', align: 30, color: '#e0558a', logo: '📺' })}>📺 Stream Demand (stream shows on demand)</button>
      <button class="btn primary" onClick=${() => onEdit({ name: '', number: '', sources: [], filler: [], blocks: [], order: 'sequential', align: 30, color: PALETTE[channels.length % PALETTE.length], logo: '' })}><${Icon.plus} /> New channel</button>
    </div>
    <div class="overlay-body">
      ${sugs && html`<div class="card" style="margin-bottom:22px"><div class="row" style="margin-bottom:10px"><b class="grow">Suggested from your library</b><button class="icon-btn" onClick=${() => setSugs(null)}><${Icon.close} /></button></div>
        <${Suggestions} list=${sugs} compact onCreate=${async (list) => { setChannels(await tv.createChannels(list)); setSugs(null); toast(`Added ${list.length} channels`); }} /></div>`}
      ${[['Your channels', channels.filter((c) => !c.iptv)], ['📡 Live TV', channels.filter((c) => c.iptv && !c.iptv.dead)]].filter(([, l]) => l.length).map(([title, list]) => html`
        <div class="section-title row" style="gap:10px">${title} <span style="text-transform:none;letter-spacing:0;font-weight:500">· ${list.length} · drag to reorder, click a number to change it</span>
          ${list[0]?.iptv && html`<span class="grow"></span><span style="text-transform:none;letter-spacing:0;font-weight:500">Live stations start at</span>
            <input class="input" type="number" min="1" style="width:84px;height:30px" value=${list[0].number} onChange=${async (e) => setChannels(await tv.liveRenumber(+e.target.value))} />`}</div>
        <div class="cards">${list.map((c, i) => html`<div class=${'card ch-card' + (overId === c.id ? ' drag-over' : '')} key=${c.id} style=${`animation-delay:${Math.min(i, 20) * 20}ms`}
          draggable="true" onDragStart=${() => setDragId(c.id)} onDragEnd=${() => { setDragId(null); setOverId(null); }}
          onDragOver=${(e) => { e.preventDefault(); setOverId(c.id); }} onDrop=${() => drop(c.id, list)}>
          <${NumberBox} ch=${c} onSet=${async (n) => { setChannels(await tv.setNumber(c.id, n)); toast(`${c.name} is now channel ${n}`); }} />
          <${ChannelLogo} ch=${c} size=${42} />
          <div class="meta"><b>${c.name}</b><span>${c.iptv ? '' : c.sources.length ? c.sources.slice(0, 3).map(srcLabel).join(', ') + (c.sources.length > 3 ? ` +${c.sources.length - 3}` : '') : c.blocks.length ? `${c.blocks.length} time blocks` : 'Empty'}</span>
            <span>${c.iptv ? html`${c.iptv.dead ? html`<span style="color:var(--bad)">● Off the air</span>` : html`<span style="color:var(--good)">● Live</span>`} · ${c.iptv.group || 'Live TV'}` : c.ondemand ? html`<span class="od-badge" style="margin-left:0">On Demand</span> pick a movie` : `${ORDER_LABEL[c.order]}${c.blocks.length && c.sources.length ? ` · ${c.blocks.length} blocks` : ''}${c.blocks.some((b) => b.sources?.some((x) => x.type === 'live')) ? ' · 📡 live mixed in' : ''}`}</span></div>
          <button class="icon-btn" title="Watch" onClick=${() => onTune(c.id)}><${Icon.play} /></button>
          ${!c.iptv && html`<button class="icon-btn" title="Edit" onClick=${() => onEdit(c)}><${Icon.edit} /></button>`}
          ${c.iptv && html`<button class="icon-btn" title="Remove station" onClick=${async () => { setChannels(await tv.deleteChannel(c.id)); toast(`Removed ${c.name}`); }}><${Icon.trash} /></button>`}
        </div>`)}</div>`)}
      ${channels.some((c) => c.iptv?.dead) && html`<details class="offair-list"><summary>Off the air (${channels.filter((c) => c.iptv?.dead).length}) — hidden from surfing and the guide; re-checked every day</summary>
        ${channels.filter((c) => c.iptv?.dead).map((c) => html`<div class="list-row"><span class="faint" style="width:40px">${c.number}</span><span class="p">${c.name}</span>
          <button class="btn sm" onClick=${async () => { const ok = await tv.iptvRecheck(c.id); toast(ok ? `${c.name} is back on the air` : `${c.name} is still off the air`); setChannels((await tv.state()).channels); }}>Try again</button>
          <button class="btn sm ghost danger" onClick=${async () => setChannels(await tv.deleteChannel(c.id))}>Remove</button></div>`)}</details>`}
    </div>
  </div>`;
}

// ---------- Settings ----------
// The On Demand folder: drop movies in and they show up on the On Demand channel.
const FOLDER_ROWS = {
  movies: { key: 'onDemandFolder', icon: '🎬', title: 'On Demand folder', what: 'Movies', channel: 'On Demand channel', empty: 'Pick a folder for movies — HomeCable makes an On Demand channel that shows everything in it.' },
  series: { key: 'seriesFolder', icon: '📺', title: 'Stream Demand folder (shows)', what: 'Show folders (seasons and episodes)', channel: 'Stream Demand channel, ready to binge', empty: 'Pick a folder for TV shows — HomeCable makes a Stream Demand channel: show posters → seasons → episodes, playing one after another.' },
};
function OnDemandFolderRow({ settings, toast, kind = 'movies' }) {
  const K = FOLDER_ROWS[kind];
  const [busy, setBusy] = useState(false);
  const folder = settings[K.key];
  const choose = async () => {
    const f = await tv.onDemandPickFolder(folder);
    if (!f) return;
    setBusy(true);
    const r = await tv.onDemandUseFolder(f, { kind });
    setBusy(false);
    const ch = r.channels.find((c) => c.id === r.channelId);
    toast(`${K.icon} ${ch ? `Channel ${ch.number} (${ch.name})` : K.title} now shows ${f}${r.found ? ` — ${r.found} files found` : ''}`);
  };
  return html`<div class="settings-row"><div class="grow"><b>${K.icon} ${K.title}</b><span>${folder ? html`${K.what} you put in <code class="od-path">${folder}</code> show up on your ${K.channel} automatically.` : K.empty}</span></div>
    ${folder && html`<button class="btn sm" onClick=${() => tv.onDemandOpenFolder(kind)}>Open folder</button>`}
    <button class="btn sm primary" disabled=${busy} onClick=${choose}>${busy ? 'Reading…' : folder ? 'Change…' : 'Choose folder…'}</button></div>`;
}

// Start over: wipe HomeCable's channels, people and settings and run first-time setup again.
function StartOverRow() {
  const [ask, setAsk] = useState(false);
  return html`<div class="settings-row"><div class="grow"><b>Start over from scratch</b><span>Removes your channels, people, settings and library list, then runs the first-time setup again. Your video files are never touched.</span></div>
    <button class="btn sm danger" onClick=${() => setAsk(true)}>Start over…</button>
    ${ask && html`<div class="modal-bg" onClick=${() => setAsk(false)}><div class="modal narrow" onClick=${(e) => e.stopPropagation()}>
      <div class="modal-head"><h3>Start over from scratch?</h3></div>
      <div class="modal-body"><p>HomeCable will forget all your channels, people, settings and its list of your videos, restart, and walk you through the first-time setup again.</p>
        <p class="muted">Your movies, shows and music files stay exactly where they are.</p>
        <div class="row" style="justify-content:flex-end;gap:10px;margin-top:14px">
          <button class="btn gp-default" onClick=${() => setAsk(false)}>Keep everything</button>
          <button class="btn danger" onClick=${() => tv.startOver()}>Yes, start over</button></div></div></div></div>`}
  </div>`;
}

// Watching on a TV (Chromecast / Google TV) — open to everyone, it's just watching.
function CastSettings({ settings, setSettings, cast, tvs, onOpenCast }) {
  const last = settings.castLast;
  return html`
    <div class="settings-row"><div class="grow"><b>📺 Watch on a TV</b><span>${cast?.on ? `Playing on ${cast.device} right now.` : tvs?.length ? `${tvs.length === 1 ? tvs[0].name + ' is' : tvs.length + ' TVs are'} ready on your Wi-Fi.` : 'Chromecast and Google TV sets on your Wi-Fi show up here.'} Press K anytime (or hold View on a controller).</span></div>
      <button class="btn sm primary" onClick=${onOpenCast}>${cast?.on ? 'Casting options' : 'Choose a TV'}</button></div>
    ${last && html`<div class="settings-row"><div class="grow"><b>Start on ${last.name} automatically</b><span>When HomeCable opens and that TV is switched on, the picture goes straight to it.</span></div>
      <button class=${'toggle' + (settings.castAuto ? ' on' : '')} onClick=${() => setSettings({ castAuto: !settings.castAuto })}></button></div>`}`;
}

export function SettingsPanel({ settings, setSettings, onRunSetup, onShowTour, version, onEnrich, channels, onLock, stats, onOpenLibrary, toast, isAdult, profile, setProfile, onSwitch, cast, tvs, onOpenCast, vault, setVault, onOpenVault }) {
  const [freeOpen, setFreeOpen] = useState(false);
  const [notices, setNotices] = useState(null);
  const Toggle = ({ k }) => html`<button class=${'toggle' + (settings[k] ? ' on' : '')} onClick=${() => setSettings({ [k]: !settings[k] })}></button>`;
  return html`<div class="overlay">
    <div class="overlay-head"><h2>Settings</h2></div>
    <div class="overlay-body" style="max-width:820px">
      ${!isAdult ? html`
        <div class="settings-row"><div class="grow"><b>${profile?.list.find((p) => p.id === profile.active)?.avatar} ${profile?.list.find((p) => p.id === profile.active)?.name}</b><span>Ask a grown-up to change settings and channels.</span></div><button class="btn sm" onClick=${onSwitch}>Switch profile</button></div>
        <div class="settings-row"><div class="grow"><b>Picture size</b></div>
          <div class="seg">${[['fit', 'Fit'], ['fill', 'Fill'], ['stretch', 'Stretch']].map(([k, l]) => html`<button class=${(settings.fit || 'fit') === k ? 'on' : ''} onClick=${() => setSettings({ fit: k })}>${l}</button>`)}</div></div>
        <${CastSettings} settings=${settings} setSettings=${setSettings} cast=${cast} tvs=${tvs} onOpenCast=${onOpenCast} />
        <div class="section-title">Controls</div><${ControlsMap} />` : html`
      <div class="section-title" style="margin-top:0">People</div>
      ${profile && html`<${ProfilesSettings} view=${profile} setView=${setProfile} toast=${toast} />`}
      <div class="section-title">Library & updates</div>
      <div class="settings-row"><div class="grow"><b>When new videos show up</b><span>Automatic adds them to matching channels’ upcoming schedules. Review holds them in Library → New. Library only keeps them out of channels until you add them.</span></div>
        <div class="seg">${[['auto', 'Automatic'], ['review', 'Let me review'], ['library', 'Library only']].map(([k, l]) => html`<button class=${settings.newMedia === k ? 'on' : ''} onClick=${() => setSettings({ newMedia: k })}>${l}</button>`)}</div></div>
      <div class="settings-row"><div class="grow"><b>Check for new media</b><span>${stats?.lastScan ? `Last checked ${new Date(stats.lastScan).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. ` : ''}Folders on this PC are also watched live.</span></div>
        <div class="seg">${[['1h', 'Hourly'], ['6h', '6 h'], ['24h', 'Daily'], ['off', 'Never']].map(([k, l]) => html`<button class=${settings.scanInterval === k ? 'on' : ''} onClick=${() => setSettings({ scanInterval: k })}>${l}</button>`)}</div>
        <button class="btn sm" onClick=${() => { toast('Scanning…'); tv.scanAll().then((r) => toast(r.busy ? 'Already scanning…' : `Scan done — ${r.added || 0} new`)); }}>Scan now</button></div>
      <${OnDemandFolderRow} settings=${settings} toast=${toast} />
      <${OnDemandFolderRow} settings=${settings} toast=${toast} kind="series" />
      ${vault && html`<${VaultSettings} vault=${vault} setVault=${setVault} toast=${toast} onOpen=${onOpenVault} />`}
      <div class="settings-row"><div class="grow"><b>“New Arrivals” channel</b><span>Plays whatever was added in the last two weeks.</span></div><${Toggle} k="newArrivals" /></div>
      <div class="settings-row"><div class="grow"><b>Sources</b><span>${(stats?.folders.length || 0)} folders · ${(stats?.servers || []).length} media servers. Add network shares, NAS boxes and media servers.</span></div><button class="btn sm" onClick=${onOpenLibrary}>Manage in Library</button></div>
      <div class="settings-row"><div class="grow"><b>Free TV</b><span>Free live IPTV stations and public-domain classic movies, cartoons and TV.</span></div><button class="btn sm" onClick=${() => setFreeOpen(true)}>📡 Add free channels</button></div>
      <${AdsSettings} settings=${settings} setSettings=${setSettings} toast=${toast} />
      <div class="section-title">Watching</div>
      <${PhoneSettings} toast=${toast} />
      <${CastSettings} settings=${settings} setSettings=${setSettings} cast=${cast} tvs=${tvs} onOpenCast=${onOpenCast} />
      <div class="settings-row"><div class="grow"><b>Single channel mode</b><span>Lock the TV to one channel, all the time. Channel flipping is turned off; the guide shows just that channel's schedule.</span></div>
        <select class="select" style="min-width:220px" value=${settings.lockChannel || ''} onChange=${(e) => onLock(e.target.value)}>
          <option value="">Off — all channels</option>
          ${channels.map((c) => html`<option value=${c.id}>${c.number} · ${c.name}</option>`)}
        </select></div>
      <div class="settings-row"><div class="grow"><b>💬 Subtitles</b><span>Auto turns them on when the audio isn’t in your language — e.g. Japanese anime with English subtitles — and picks the full-dialogue track. T (or the CC button) switches tracks while watching; your choice is remembered per show.</span></div>
        <div class="seg">${[['auto', 'Auto'], ['on', 'Always'], ['off', 'Off']].map(([k, l]) => html`<button class=${(settings.subMode || 'auto') === k ? 'on' : ''} onClick=${() => setSettings({ subMode: k })}>${l}</button>`)}</div>
        <select class="select" value=${settings.subLang || 'eng'} onChange=${(e) => setSettings({ subLang: e.target.value })}>
          ${[['eng', 'English'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['por', 'Portuguese'], ['ita', 'Italian'], ['jpn', 'Japanese'], ['kor', 'Korean'], ['zho', 'Chinese'], ['rus', 'Russian'], ['ara', 'Arabic'], ['nld', 'Dutch']].map(([k, l]) => html`<option value=${k}>${l}</option>`)}
        </select></div>
      <div class="settings-row"><div class="grow"><b>🔊 Audio (dub or original)</b><span>For videos with more than one language — like anime with Japanese and English audio. “Prefer dub” plays the track in your language (set under Subtitles) when there is one. Change it while watching with V or the CC button; your choice is remembered per show.</span></div>
        <div class="seg">${[['orig', 'Original'], ['dub', 'Prefer dub']].map(([k, l]) => html`<button class=${(settings.audioPref || 'orig') === k ? 'on' : ''} onClick=${() => setSettings({ audioPref: k })}>${l}</button>`)}</div></div>
      <div class="settings-row"><div class="grow"><b>Picture size</b><span>Fit shows the whole picture; Fill zooms to remove black bars; Stretch fills the screen. Z or R3 switches while watching.</span></div>
        <div class="seg">${[['fit', 'Fit'], ['fill', 'Fill'], ['stretch', 'Stretch']].map(([k, l]) => html`<button class=${(settings.fit || 'fit') === k ? 'on' : ''} onClick=${() => setSettings({ fit: k })}>${l}</button>`)}</div></div>
      <div class="settings-row"><div class="grow"><b>Start in fullscreen</b><span>Open straight into fullscreen TV, like turning on a set. Esc (or B / ○ on a controller) leaves it.</span></div><${Toggle} k="startFullscreen" /></div>
      <div class="settings-row"><div class="grow"><b>📺 Channel bumpers</b><span>The channel’s own logo for a few seconds between shows, like a real network’s bumps. When commercials are on, one plays going into the break and another coming back.</span></div>
        ${settings.bumpersOn !== false && html`<div class="seg">${[3, 5, 8].map((s) => html`<button class=${(settings.bumperSeconds || 5) === s ? 'on' : ''} onClick=${() => setSettings({ bumperSeconds: s })}>${s}s</button>`)}</div>`}
        <${Toggle} k="bumpersOn" /></div>
      <div class="settings-row"><div class="grow"><b>Channel-change static</b><span>Show TV static while a channel tunes in.</span></div><${Toggle} k="transitions" /></div>
      <div class="settings-row"><div class="grow"><b>On-screen clock</b><span>Show the time in the corner while watching.</span></div><${Toggle} k="showClock" /></div>
      <div class="settings-row"><div class="grow"><b>Info banner</b><span>How long the channel banner stays up after changing channels.</span></div>
        <div class="seg">${[3, 5, 8].map((s) => html`<button class=${settings.bannerSeconds === s ? 'on' : ''} onClick=${() => setSettings({ bannerSeconds: s })}>${s}s</button>`)}</div></div>
      <div class="settings-row"><div class="grow"><b>Online show & movie info</b><span>Look up show genres and posters (TVmaze) and movie posters (Wikipedia) — only titles are sent. Movies with cover art in the file, or a picture beside them, never go online.</span></div>
        <button class="btn sm" onClick=${onEnrich}>Look up now</button><${Toggle} k="onlineMeta" /></div>
      <div class="settings-row"><div class="grow"><b>Setup</b><span>Run the first-time scan and channel suggestions again.</span></div><button class="btn sm" onClick=${onRunSetup}>Run setup</button></div>
      <div class="settings-row"><div class="grow"><b>Welcome tour</b><span>The quick walkthrough of everything HomeCable can do — channels, the guide, On Demand, tagging, the phone app.</span></div><button class="btn sm" onClick=${onShowTour}>Show the tour</button></div>
      <${StartOverRow} />
      <div class="settings-row"><div class="grow"><b>Troubleshooting</b><span>Open the log file.</span></div><button class="btn sm" onClick=${() => tv.openLog()}>Open log</button></div>
      <div class="section-title">Controls</div>
      <${ControlsMap} />
      ${freeOpen && html`<${FreeTvDialog} onClose=${() => setFreeOpen(false)} toast=${toast} />`}
      <div class="section-title">About</div>
      <div class="settings-row"><div class="grow"><b>HomeCable ${version}</b><span>Free, open-source software (MIT). No accounts, no telemetry, no tracking. Free TV comes from public lists and public-domain archives — HomeCable doesn't host any streams, and what you play is your responsibility.</span></div>
        <button class="btn sm" onClick=${async () => setNotices(await tv.notices())}>Privacy, content & licenses</button></div>
      <div class="settings-row"><div class="grow"><b>🔄 Updates</b><span>${settings.pendingUpdate?.version ? `v${settings.pendingUpdate.version} is downloaded and ready — it installs next time HomeCable starts. ` : ''}Checks GitHub for new versions, downloads them quietly without touching what's playing, and switches over on the next start. Updates keep your channels, people and settings.</span></div>
        <div class="seg">${[['start', 'At start'], ['1h', 'Hourly'], ['6h', '6 h'], ['24h', 'Daily']].map(([k, l]) => html`<button class=${(settings.updateEvery || '24h') === k ? 'on' : ''} onClick=${() => setSettings({ updateEvery: k })}>${l}</button>`)}</div>
        <button class="btn sm" onClick=${() => { toast('Checking for updates…'); tv.updateCheck().then((st) => toast(st.found ? `⬇ v${st.found} found — downloading in the background` : st.pending ? `v${st.pending.version} is ready — installs on the next start` : st.error ? `Couldn’t check: ${st.error}` : `You’re on the newest version (${st.current})`)).catch(() => toast('Couldn’t check for updates')); }}>Check now</button></div>
      <div class="settings-row"><div class="grow"><b>Say when an update is found</b><span>A small note in the top corner the moment a new version starts downloading. Turn it off and updates are completely invisible.</span></div><${Toggle} k="updateNotify" /></div>
      ${notices && html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && setNotices(null)}><div class="modal"><div class="modal-head"><h3>Privacy, content & licenses</h3><button class="icon-btn" onClick=${() => setNotices(null)}><${Icon.close} /></button></div>
        <div class="modal-body notices">${renderNotices(notices)}</div></div></div>`}`}
    </div>
  </div>`;
}

// Commercial breaks — just for fun, off by default.
export function AdsSettings({ settings, setSettings, toast }) {
  const [feed, setFeed] = useState(settings.adFeed || '');
  const [sync, setSync] = useState(null);
  const [packs, setPacks] = useState(null); // { bundled: { count, on }, packs: [{ name, count, on }], folder }
  const loadPacks = () => tv.adsPacks().then(setPacks).catch(() => {});
  useEffect(() => { loadPacks(); tv.adsStatus().then(setSync); }, [settings.adFeed, settings.adsOn, settings.adsBundled, settings.adPacks]);
  const on = !!settings.adsOn;
  const togglePack = (name, cur) => setSettings({ adPacks: { ...(settings.adPacks || {}), [name]: !cur } });
  return html`<div class="ads-box">
    <div class="settings-row" style="border:0"><div class="grow"><b>\u{1F4E3} Commercial breaks (just for fun)</b>
      <span>Want the full cable experience? Short, <b>funny, family-friendly</b> ads play between shows \u2014 HomeCable\u2019s own interdimensional joke ads, plus any ad packs you add. Off by default; turn it off anytime.</span></div>
      <button class=${'toggle' + (on ? ' on' : '')} onClick=${() => setSettings({ adsOn: !on })}></button></div>
    ${on && html`
      <div class="settings-row"><div class="grow"><b>Break length</b><span>Up to 45 seconds between shows.</span></div>
        <input type="range" min="10" max="45" step="5" value=${settings.adSeconds || 30} onChange=${(e) => setSettings({ adSeconds: +e.target.value })} style="width:180px;accent-color:var(--accent)" />
        <b style="width:44px;text-align:right">${settings.adSeconds || 30}s</b></div>
      <div class="settings-row"><div class="grow"><b>How often</b></div>
        <div class="seg">${[['every', 'After every show'], ['other', 'Every other show'], ['few', 'Now and then']].map(([k, l]) => html`<button class=${settings.adEvery === k ? 'on' : ''} onClick=${() => setSettings({ adEvery: k })}>${l}</button>`)}</div></div>
      <div class="settings-row"><div class="grow"><b>\u{1F4FC} HomeCable\u2019s own ads</b><span>${packs ? packs.bundled.count : '\u2026'} interdimensional joke ad${packs?.bundled.count === 1 ? '' : 's'} ship inside the app and play in a random order \u2014 nothing is fetched from the internet. New ones arrive with app updates.</span></div>
        <button class=${'toggle' + (settings.adsBundled !== false ? ' on' : '')} onClick=${() => setSettings({ adsBundled: settings.adsBundled === false })}></button></div>
      <div class="settings-row" style="align-items:flex-start"><div class="grow"><b>Your ad packs</b>
        <span>An ad pack is just a folder of short videos (45 seconds or less) \u2014 easy to zip, share and update. Add one with the button, or drop folders straight into the packs folder; each pack gets its own switch.</span>
        ${packs && packs.packs.length > 0 && html`<div style="margin-top:8px">${packs.packs.map((pk) => html`<div class="row" style="padding:4px 0">
          <span class="grow">\u{1F4C1} ${pk.name} <span class="muted small">\u00b7 ${pk.count} ad${pk.count === 1 ? '' : 's'}</span></span>
          <button class=${'toggle' + (pk.on ? ' on' : '')} onClick=${() => togglePack(pk.name, pk.on)}></button></div>`)}</div>`}
        ${packs && !packs.packs.length && html`<div class="muted small" style="margin-top:6px">No packs yet.</div>`}</div>
        <div class="row" style="flex-direction:column;align-items:stretch;gap:6px">
          <button class="btn sm" onClick=${async () => { const r = await tv.adsPackAdd(); if (r) { toast(`\u{1F4C1} \u201c${r.name}\u201d added \u2014 ${r.copied} video${r.copied === 1 ? '' : 's'} copied in`); loadPacks(); } }}>\u2795 Add a pack\u2026</button>
          <button class="btn sm ghost" title="Each folder in here is one ad pack" onClick=${() => tv.adsPacksOpen()}>\u{1F4C2} Open packs folder</button>
          <button class="btn sm ghost" onClick=${async () => { await tv.adsRescanPacks(); loadPacks(); toast('Ad packs rescanned'); }}>\u27F3 Rescan</button>
        </div></div>
      <div class="settings-row" style="flex-wrap:wrap"><div class="grow"><b>Hosted ad pack (optional)</b><span>An ad list you host online (https). Checked at start and every 6 hours; new ads download, removed ones disappear. No cookies or IDs are sent.
          ${sync?.at && settings.adFeed ? html`<br/>Last check: ${new Date(sync.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} \u2014 ${sync.error ? html`<span style="color:var(--warn)">${sync.error}</span>` : `${sync.count || 0} ads`}` : ''}</span></div>
        <input class="input" style="width:320px" placeholder="https://your-site.pages.dev/homecable-ads.json" value=${feed} onInput=${(e) => setFeed(e.target.value)} />
        <button class="btn sm" onClick=${async () => { toast('Syncing ads\u2026'); await setSettings({ adFeed: feed.trim() }); const st = await tv.adsStatus(); setSync(st); toast(st.error ? 'Couldn\u2019t sync: ' + st.error : `Ads synced \u2014 ${st.count || 0} ads`); }}>Save & sync</button></div>`}
  </div>`;
}

// Minimal renderer for NOTICES.md (headings, paragraphs, bullet lists, tables).
function renderNotices(md) {
  const out = [];
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^#\s/.test(l)) continue;
    if (/^##\s/.test(l)) { out.push(html`<div class="section-title">${l.slice(3)}</div>`); continue; }
    if (/^\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { if (!/^\|[-| ]+\|$/.test(lines[i])) rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim().replace(/`/g, ''))); i++; }
      i--;
      out.push(html`<table class="notice-table"><thead><tr>${rows[0].map((c) => html`<th>${c}</th>`)}</tr></thead><tbody>${rows.slice(1).map((r) => html`<tr>${r.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody></table>`);
      continue;
    }
    if (/^- /.test(l)) { out.push(html`<p class="muted" style="margin:6px 0">• ${l.slice(2).replace(/\*\*/g, '')}</p>`); continue; }
    if (l.trim()) out.push(html`<p>${l.replace(/\*\*/g, '').replace(/`/g, '')}</p>`);
  }
  return out;
}

// Click a channel number to type a new one (swaps with whatever had it).
function NumberBox({ ch, onSet }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(ch.number);
  if (!edit) return html`<button class="num num-btn" title="Change channel number" onClick=${() => { setV(ch.number); setEdit(true); }}>${ch.number}</button>`;
  const done = () => { setEdit(false); if (+v && +v !== ch.number) onSet(+v); };
  return html`<input class="input num-input" type="number" min="1" value=${v} autofocus onInput=${(e) => setV(e.target.value)} onBlur=${done} onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setEdit(false); e.stopPropagation(); }} />`;
}
