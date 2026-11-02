// HomeCable on a phone — served by the PC to paired phones.
//   Watch:  live channels, On Demand and Stream Demand, streamed from the PC to this phone
//           (progress is shared with the PC: start on one, finish on the other).
//   Remote: control what the PC (or the TV it casts to) is showing.
import { html, render } from 'htm/preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

// ---------- connection ----------
const KEY = (() => {
  const m = location.hash.match(/k=([0-9a-f]{32,})/);
  if (m) { try { sessionStorage.setItem('hc-k', m[1]); } catch {} history.replaceState(null, '', location.pathname); return m[1]; }
  try { return sessionStorage.getItem('hc-k'); } catch { return null; }
})();
const bridge = window.Android || null; // the HomeCable phone app (pairing, rotation)
class Unpaired extends Error {}
async function api(path, body) {
  const r = await fetch('/api/' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) throw new Unpaired('unpaired');
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'The PC said no');
  return r.json();
}
const clock = (s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const mins = (s) => { const m = Math.round((s || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
const epLabel = (e) => e.label || (e.season != null && e.episode != null ? `S${e.season} · E${e.episode}` : '');
const backStack = []; // Android Back: closes the top-most thing
window.hcBack = () => { const f = backStack.pop(); if (f) { f(); return true; } return false; };
const useBack = (on, fn) => useEffect(() => { if (!on) return; backStack.push(fn); return () => { const i = backStack.lastIndexOf(fn); if (i >= 0) backStack.splice(i, 1); }; }, [on]);

function App() {
  const [state, setState] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState(() => { try { return localStorage.getItem('hc-tab') || 'watch'; } catch { return 'watch'; } });
  const [playing, setPlaying] = useState(null); // what plays on the phone
  const [toastMsg, setToast] = useState(null);
  const toast = (m) => { setToast(m); clearTimeout(toast.t); toast.t = setTimeout(() => setToast(null), 3000); };
  const load = () => api('state').then((s) => { setState(s); setErr(null); }).catch((e) => setErr(e));
  useEffect(() => { if (!KEY) setErr(new Unpaired()); else load(); }, []);
  const go = (t) => { setTab(t); try { localStorage.setItem('hc-tab', t); } catch {} };
  // What the PC is showing, and whether it's casting to a TV — kept fresh for every screen.
  const [live, setLive] = useState({ now: null, cast: null });
  useEffect(() => {
    if (!state) return;
    let on = true;
    const f = () => api('now').then((x) => on && setLive({ now: x.now, cast: x.cast || null })).catch(() => {});
    f();
    const t = setInterval(f, 2500);
    return () => { on = false; clearInterval(t); };
  }, [!!state]);
  const cast = live.cast || state?.cast || null;

  if (err) return html`<div class="center">
    <div class="big-ic">📡</div>
    <h2>${err instanceof Unpaired ? 'This phone isn’t paired' : 'Can’t reach the PC'}</h2>
    <p class="muted">${err instanceof Unpaired ? 'On the PC: Settings → Phone app → Pair a phone, then scan the code again.' : 'Make sure HomeCable is open on the PC, and the phone is on the same Wi-Fi (or your VPN is on).'}</p>
    <div class="row">${!(err instanceof Unpaired) && html`<button class="btn primary" onClick=${load}>Try again</button>`}
      ${bridge && html`<button class="btn" onClick=${() => (err instanceof Unpaired && bridge.pairAgain ? bridge.pairAgain() : bridge.home())}>${err instanceof Unpaired ? 'Scan again' : 'Change PC'}</button>`}</div>
  </div>`;
  if (!state) return html`<div class="center"><div class="spin"></div></div>`;

  return html`<div class="app">
    <header class="top">
      <div class="brand"><img class="logo" src="icon.svg" alt="" /><div class="grow"><b>HomeCable</b><span>${state.pc}</span></div></div>
      <div class="seg">
        <button class=${tab === 'watch' ? 'on' : ''} onClick=${() => go('watch')}>📱 Watch</button>
        <button class=${tab === 'remote' ? 'on' : ''} onClick=${() => go('remote')}>🎮 Remote</button>
      </div>
    </header>
    ${tab === 'watch' ? html`<${Watch} state=${state} cast=${cast} onPlay=${setPlaying} toast=${toast} onPc=${() => go('remote')} />` : html`<${Remote} state=${state} now=${live.now || state.now} cast=${cast} toast=${toast} goWatch=${() => go('watch')} />`}
    ${playing && html`<${Player} what=${playing} cast=${cast} onClose=${() => setPlaying(null)} toast=${toast} onPc=${() => { setPlaying(null); go('remote'); }} />`}
    ${toastMsg && html`<div class="toast">${toastMsg}</div>`}
  </div>`;
}

// ---------- Watch: channels, On Demand, Stream Demand ----------
function Watch({ state, cast, onPlay, toast, onPc }) {
  const od = state.channels.filter((c) => c.ondemand);
  const sections = [['live', '📺 Channels'], ...od.map((c) => [c.id, c.odStyle === 'series' ? '🍿 Stream Demand' : '🎬 On Demand']), ...(state.vault ? [['vault', '🗂 ' + state.vault.name]] : [])];
  const [sec, setSec] = useState(() => { try { const s = localStorage.getItem('hc-sec'); return sections.some(([k]) => k === s) ? s : 'live'; } catch { return 'live'; } });
  const pick = (k) => { setSec(k); try { localStorage.setItem('hc-sec', k); } catch {} };
  return html`<div class="watch">
    <nav class="chips">${sections.map(([k, l]) => html`<button class=${'chip' + (sec === k ? ' on' : '')} onClick=${() => pick(k)}>${l}</button>`)}</nav>
    ${sec === 'live' ? html`<${Channels} state=${state} cast=${cast} onPlay=${onPlay} toast=${toast} onPc=${onPc} />`
      : sec === 'vault' ? html`<${Vault} name=${state.vault.name} onPlay=${onPlay} toast=${toast} />`
      : html`<${Library} key=${sec} channel=${od.find((c) => c.id === sec)} cast=${cast} onPlay=${onPlay} toast=${toast} onPc=${onPc} />`}
  </div>`;
}

function Channels({ state, cast, onPlay, toast, onPc }) {
  const [guide, setGuide] = useState({});
  const [sheet, setSheet] = useState(null);
  useBack(!!sheet, () => setSheet(null));
  useEffect(() => {
    const now = Date.now();
    api(`guide?from=${now}&to=${now + 60e3}`).then((rows) => setGuide(Object.fromEntries(rows.map((r) => [r.id, r.entries?.[0]])))).catch(() => {});
  }, []);
  const list = state.channels.filter((c) => !c.ondemand);
  return html`<div class="list">
    ${list.map((c) => { const e = guide[c.id]; return html`<button class="ch-row" onClick=${() => setSheet(c)}>
      <span class="ch-num" style=${`--c:${c.color || '#556'}`}>${c.number}</span>
      <div class="grow"><b>${c.name}</b><small>${c.live ? '● Live' : ''}${e ? (c.live ? ' · ' : '') + (e.title || '') : ''}</small></div>
    </button>`; })}
    ${sheet && html`<${Sheet} title=${`${sheet.number} · ${sheet.name}`} onClose=${() => setSheet(null)}>
      <button class="btn primary wide" onClick=${() => { onPlay({ channel: sheet }); setSheet(null); }}>▶ Watch on this phone</button>
      <button class="btn wide" onClick=${() => api('remote', { play: { channelId: sheet.id } }).then(() => { toast(cast?.on ? `📡 ${sheet.name} is on ${cast.device}` : `📺 ${sheet.name} is on the PC`); setSheet(null); onPc(); })}>${cast?.on ? `📡 Put it on ${cast.device}` : '📺 Put it on the PC'}</button>
    <//>`}
  </div>`;
}

// The locked section: its password first (checked by the PC), locked again when you leave
// this screen or put the app away.
let vaultUnlocked = false;
const lockVault = () => { if (vaultUnlocked) { vaultUnlocked = false; api('vault/lock', {}).catch(() => {}); } };
window.hcPause = () => { if (!document.querySelector('.player')) lockVault(); };
document.addEventListener('visibilitychange', () => { if (document.hidden && !document.querySelector('.player')) lockVault(); });
function Vault({ name, onPlay, toast }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => () => lockVault(), []);
  const go = async (e) => {
    e?.preventDefault();
    const r = await api('vault/unlock', { password: pw }).catch(() => ({ ok: false }));
    setPw('');
    if (r.ok) { vaultUnlocked = true; setOpen(true); return; }
    setMsg(r.wait ? `Too many tries — wait ${r.wait} s` : 'That’s not it — try again');
  };
  if (open) return html`<${Library} channel=${{ id: 'vault', name, vault: true }} onPlay=${onPlay} toast=${toast} onLocked=${() => { vaultUnlocked = false; setOpen(false); }} />`;
  return html`<form class="vault" onSubmit=${go}>
    <div class="big-ic">🔒</div><h2>${name}</h2><p class="muted">Enter the password to open.</p>
    <input class="search" type="password" placeholder="Password" value=${pw} onInput=${(e) => { setPw(e.target.value); setMsg(''); }} autocomplete="off" />
    <button class="btn primary wide" type="submit" disabled=${!pw}>Open</button>
    <p class="vault-msg">${msg}</p></form>`;
}

// On Demand / Stream Demand (and any On Demand screen): posters → show → episodes.
function Library({ channel, cast, onPlay, toast, onPc, onLocked }) {
  const [data, setData] = useState(null);
  const [show, setShow] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [q, setQ] = useState('');
  useBack(!!show, () => setShow(null));
  useBack(!!sheet, () => setSheet(null));
  const load = (refresh) => api(channel.vault ? `vault/list${refresh ? '?refresh=1' : ''}` : `ondemand?id=${channel.id}${refresh ? '&refresh=1' : ''}`).then(setData).catch((e) => { if (channel.vault) onLocked?.(); else toast(e.message); });
  useEffect(() => { load(false).then(() => load(true)); }, [channel.id]);
  const { shows, movies } = useMemo(() => {
    if (!data) return { shows: [], movies: [] };
    const byId = new Map(data.items.map((m) => [m.id, m]));
    const used = new Set();
    const shows = (data.series || []).map((s) => {
      const eps = [];
      for (const se of s.seasons) se.ids.forEach((id, i) => { const m = byId.get(id); if (m) { used.add(id); eps.push({ ...m, seasonLabel: se.label, n: i + 1, label: `${/^Season \d+$/.test(se.label) ? 'S' + se.label.replace('Season ', '') : se.label} · E${i + 1}`, title: m.epTitle && m.epTitle.toLowerCase() !== s.name.toLowerCase() ? m.epTitle : `Episode ${i + 1}` }); } });
      return { key: s.key, name: s.name, poster: s.poster || eps[0]?.thumb, eps, seasons: s.seasons.map((x) => x.label) };
    }).filter((s) => s.eps.length);
    return { shows, movies: data.items.filter((m) => !used.has(m.id)) };
  }, [data]);
  if (!data) return html`<div class="center"><div class="spin"></div></div>`;
  const last = data.showLast || {};
  const match = (t) => !q || String(t).toLowerCase().includes(q.toLowerCase());
  const s = show && shows.find((x) => x.key === show);
  const playEp = (sh, ep, at, where) => {
    const i = sh.eps.findIndex((e) => e.id === ep.id);
    const queue = sh.eps.slice(i + 1).map((e) => ({ id: e.id, title: e.title, label: e.label, show: sh.name }));
    const opts = { queue, seriesKey: sh.key, label: ep.label, title: ep.title };
    if (where === 'pc') api('remote', { play: { channelId: channel.id, itemId: ep.id, at, opts } }).then(() => { toast(cast?.on ? `📡 Playing on ${cast.device}` : '📺 Playing on the PC'); onPc(); });
    else onPlay({ itemId: ep.id, at, title: ep.title, sub: `${sh.name} · ${ep.label}`, showKey: sh.key, queue: sh.eps.slice(i + 1), channelId: channel.id, vault: !!channel.vault });
  };
  const playMovie = (m, at, where) => {
    if (where === 'pc') api('remote', { play: { channelId: channel.id, itemId: m.id, at } }).then(() => { toast(cast?.on ? `📡 Playing on ${cast.device}` : '📺 Playing on the PC'); onPc(); });
    else onPlay({ itemId: m.id, at, title: m.title, sub: m.year || '', channelId: channel.id, vault: !!channel.vault });
  };
  const next = (sh) => {
    const l = last[sh.key]; const lastId = typeof l === 'string' ? l : l?.id;
    const i = sh.eps.findIndex((e) => e.id === lastId);
    if (i < 0) return { ep: sh.eps[0], at: 0, label: `Play ${sh.eps[0].label}` };
    if (sh.eps[i].resume > 10) return { ep: sh.eps[i], at: sh.eps[i].resume, label: `Continue ${sh.eps[i].label}` };
    if (l && typeof l === 'object' && !l.done) return { ep: sh.eps[i], at: 0, label: `Continue ${sh.eps[i].label}` };
    if (sh.eps[i + 1]) return { ep: sh.eps[i + 1], at: 0, label: `Next: ${sh.eps[i + 1].label}` };
    return { ep: sh.eps[0], at: 0, label: `Watch again` };
  };

  // The locked section plays on this phone only (the PC stays locked).
  const sheetFor = (title, onPhone, onPc2, resume) => setSheet({ title, onPhone, onPc: channel.vault ? null : onPc2, resume });
  return html`<div class="lib">
    ${s ? html`<div class="show">
      <button class="link" onClick=${() => setShow(null)}>← All</button>
      <div class="show-head">${s.poster && html`<img src=${s.poster} alt="" />`}<div><h2>${s.name}</h2><small class="muted">${s.eps.length} episodes</small>
        ${(() => { const n = next(s); return html`<button class="btn primary" onClick=${() => sheetFor(n.label, (at) => playEp(s, n.ep, at), (at) => playEp(s, n.ep, at, 'pc'), n.at)}>▶ ${n.label}</button>`; })()}</div></div>
      ${s.seasons.map((label) => html`<h4 class="season">${label}</h4>${s.eps.filter((e) => e.seasonLabel === label).map((e) => {
        const pct = e.resume > 10 && e.duration ? Math.min(100, (e.resume / e.duration) * 100) : e.watched ? 100 : 0;
        return html`<button class="ep" onClick=${() => sheetFor(`${e.label} · ${e.title}`, (at) => playEp(s, e, at), (at) => playEp(s, e, at, 'pc'), e.resume > 10 ? e.resume : 0)}>
          <div class="ep-art">${e.thumb && html`<img src=${e.thumb} loading="lazy" alt="" />`}${pct > 0 && html`<i style=${`width:${pct}%`}></i>`}</div>
          <div class="grow"><b>${e.n}. ${e.title}</b><small>${mins(e.duration)}${e.resume > 10 ? ` · ${clock(e.resume)} watched` : e.watched ? ' · ✓ watched' : ''}</small></div></button>`; })}`)}
    </div>` : html`
      <input class="search" placeholder="Search…" value=${q} onInput=${(e) => setQ(e.target.value)} />
      ${shows.filter((x) => match(x.name)).length > 0 && html`<h4 class="row-title">Shows</h4><div class="grid">${shows.filter((x) => match(x.name)).map((x) => html`<button class="tile" onClick=${() => setShow(x.key)}>
        ${x.poster ? html`<img src=${x.poster} loading="lazy" alt="" />` : html`<div class="card">${x.name}</div>`}<span>${x.name}</span></button>`)}</div>`}
      ${movies.filter((m) => match(m.title)).length > 0 && html`<h4 class="row-title">Movies</h4><div class="grid">${movies.filter((m) => match(m.title)).map((m) => html`<button class="tile" onClick=${() => sheetFor(m.title, (at) => playMovie(m, at), (at) => playMovie(m, at, 'pc'), m.resume > 10 ? m.resume : 0)}>
        ${m.poster || m.thumb ? html`<img src=${m.poster || m.thumb} loading="lazy" alt="" />` : html`<div class="card">${m.title}</div>`}${m.resume > 10 && m.duration ? html`<i class="prog" style=${`width:${Math.min(100, (m.resume / m.duration) * 100)}%`}></i>` : ''}<span>${m.title}</span></button>`)}</div>`}
      ${!shows.length && !movies.length && html`<p class="muted center-text">Nothing here yet — add videos to this folder on the PC.</p>`}`}
    ${sheet && html`<${Sheet} title=${sheet.title} onClose=${() => setSheet(null)}>
      ${sheet.resume > 0 && html`<button class="btn primary wide" onClick=${() => { sheet.onPhone(sheet.resume); setSheet(null); }}>▶ Resume from ${clock(sheet.resume)} on this phone</button>`}
      <button class=${'btn wide' + (sheet.resume > 0 ? '' : ' primary')} onClick=${() => { sheet.onPhone(0); setSheet(null); }}>${sheet.resume > 0 ? '⟲ Start over on this phone' : '▶ Watch on this phone'}</button>
      ${sheet.onPc && html`<button class="btn wide" onClick=${() => { sheet.onPc(sheet.resume || 0); setSheet(null); }}>${cast?.on ? `📡 ${sheet.resume > 0 ? `Resume on ${cast.device} (${clock(sheet.resume)})` : `Play on ${cast.device}`}` : sheet.resume > 0 ? `📺 Resume on the PC (${clock(sheet.resume)})` : '📺 Play on the PC'}</button>`}
    <//>`}
  </div>`;
}

function Sheet({ title, onClose, children }) {
  return html`<div class="sheet-bg" onClick=${onClose}><div class="sheet" onClick=${(e) => e.stopPropagation()}><h3>${title}</h3>${children}<button class="btn ghost wide" onClick=${onClose}>Cancel</button></div></div>`;
}

// ---------- the phone's own player ----------
function Player({ what, cast, onClose, toast, onPc }) {
  const vid = useRef(null);
  const [cur, setCur] = useState(what); // current thing (episodes roll on)
  const [r, setR] = useState(null); // answer from the PC (play info)
  const [src, setSrc] = useState(null); // { url, mode, base, offset }
  const [ui, setUi] = useState(true);
  const [paused, setPaused] = useState(false);
  const [, tick] = useState(0);
  const [subs, setSubs] = useState(null);
  const [subOn, setSubOn] = useState(null);
  const [track, setTrack] = useState(null); // WebVTT url
  const [audio, setAudio] = useState(0);
  const [menu, setMenu] = useState(false);
  const [err, setErr] = useState(null);
  const hide = useRef(null);
  useBack(true, onClose);
  useBack(menu, () => setMenu(false));
  const poke = () => { setUi(true); clearTimeout(hide.current); hide.current = setTimeout(() => setUi(false), 3500); };
  // Turning: follows the phone's auto-rotate; the ⟳ button flips it by hand (back to auto when you leave).
  const [turn, setTurn] = useState('auto');
  const rotate = () => {
    const portraitNow = window.innerHeight > window.innerWidth;
    const want = portraitNow ? 'landscape' : 'portrait';
    setTurn(want);
    if (bridge?.orientation) bridge.orientation(want);
    else screen.orientation?.lock?.(want).catch(() => {});
  };
  const [pip, setPip] = useState(false); // the little floating bubble (press Home while playing)
  useEffect(() => {
    poke();
    // Sideways: the video gets the whole screen (no status / navigation bars).
    const fit = () => bridge?.fullscreen?.(window.innerWidth > window.innerHeight);
    fit(); addEventListener('resize', fit);
    window.hcPip = (on) => { setPip(!!on); if (on) setUi(false); };
    // Pressing Home while something plays: Android turns this into a floating bubble.
    const v = vid.current;
    const rep = () => { try { bridge?.playing?.(!!v && !v.paused && !v.ended, v?.videoWidth || 16, v?.videoHeight || 9); } catch {} };
    for (const ev of ['playing', 'pause', 'ended']) v?.addEventListener(ev, rep);
    return () => { removeEventListener('resize', fit); window.hcPip = null; window.hcPipAction = null; try { bridge?.playing?.(false, 16, 9); } catch {} for (const ev of ['playing', 'pause', 'ended']) v?.removeEventListener(ev, rep); bridge?.fullscreen?.(false); bridge?.orientation?.('auto'); screen.orientation?.unlock?.(); };
  }, []);

  const vod = !!cur.itemId;
  const len = vod ? r?.item?.duration || 0 : r?.entry ? (r.entry.end - r.entry.start) / 1000 : 0;
  const pos = () => (src ? src.base + (vid.current?.currentTime || 0) : 0);

  // Load what to play.
  useEffect(() => {
    let live = true;
    setR(null); setSrc(null); setErr(null); setSubs(null); setSubOn(null); setTrack(null); setAudio(0);
    (vod ? api(`vod?id=${cur.itemId}&t=${cur.at || 0}`) : api(`tune?id=${cur.channel.id}`)).then((x) => {
      if (!live) return;
      if (!x?.play) { setErr(vod ? 'This video can’t be played' : x?.entry?.title ? `Nothing playing right now — ${x.entry.title}` : 'Nothing on right now'); return; }
      setR(x);
      const p = x.play;
      setSrc({ url: p.url, mode: p.mode, base: p.mode === 'direct' ? 0 : p.startedAt || 0, offset: p.mode === 'direct' ? (vod ? cur.at || 0 : p.offset || 0) : 0, live: p.mode === 'live' });
      if (vod) api(`subs?id=${cur.itemId}`).then((sx) => { if (!live) return; setSubs(sx); if (sx?.pick) setSubOn(sx.pick); if (sx?.audio?.length && sx.audioPick !== sx.audioDefault) setAudio(sx.audioPick); else setAudio(sx?.audioDefault || 0); }).catch(() => {});
    }).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [cur]);

  // Different audio / picture subtitles need a different stream from the PC (from where you are).
  const altKey = useRef('');
  useEffect(() => {
    if (!vod || !subs || !src) return;
    const tr = subs.tracks.find((t) => t.id === subOn);
    const burn = tr?.kind === 'image' ? tr.id : null;
    const plainAudio = !subs.audio?.length || audio === (subs.audioDefault || 0);
    const k = `${burn}|${plainAudio ? '' : audio}`;
    if (k === altKey.current) return;
    const first = !altKey.current;
    altKey.current = k;
    if (first && !burn && plainAudio) return;
    const at = vid.current && vid.current.readyState >= 2 ? pos() : (cur.at || 0);
    if (!burn && plainAudio) { const p = r.play; setSrc({ url: p.mode === 'direct' ? p.url : p.url.replace(/([?&]t=)[\d.]+/, '$1' + at.toFixed(2)), mode: p.mode, base: p.mode === 'direct' ? 0 : at, offset: p.mode === 'direct' ? at : 0 }); return; }
    api(`alt?id=${cur.itemId}&t=${at.toFixed(2)}${burn ? `&burn=${burn}` : ''}${plainAudio ? '' : `&audio=${audio}`}`).then((x) => setSrc({ url: x.url, mode: 'transcode', base: at, offset: 0 }));
  }, [subs, subOn, audio, !!src]);
  // Text subtitles, lined up with where the stream starts.
  useEffect(() => {
    const tr = subs?.tracks.find((t) => t.id === subOn);
    if (!tr || tr.kind !== 'text' || !src) { setTrack(null); return; }
    api(`subsurl?id=${cur.itemId}&s=${tr.id}&t=${src.mode === 'direct' ? 0 : src.base}`).then((x) => setTrack(x.url));
  }, [subOn, src?.url]);
  // Subtitles drawn by us (not the browser): one copy of each line, just inside the bottom of the picture.
  const [lines, setLines] = useState([]);
  useEffect(() => {
    const v = vid.current;
    setLines([]);
    if (!v) return;
    for (const t of v.textTracks) t.mode = 'disabled';
    const tt = track && v.textTracks[v.textTracks.length - 1];
    if (!tt) return;
    tt.mode = 'hidden';
    const on = () => { const seen = new Set(); setLines([...(tt.activeCues || [])].sort((a, b) => a.startTime - b.startTime).map((c) => c.text.replace(/<[^>]+>/g, '').trim()).filter((x) => x && !seen.has(x) && seen.add(x))); };
    tt.addEventListener('cuechange', on);
    return () => tt.removeEventListener('cuechange', on);
  }, [track]);
  const subBottom = () => {
    const v = vid.current;
    if (!v || !v.videoWidth) return 40;
    const W = v.clientWidth, H = v.clientHeight;
    const shownH = Math.min(H, (W * v.videoHeight) / v.videoWidth);
    return (H - shownH) / 2 + shownH * 0.06;
  };

  // Start the video.
  useEffect(() => {
    const v = vid.current;
    if (!v || !src) return;
    let done = false;
    const meta = () => { if (!done && src.mode === 'direct' && src.offset > 1) { done = true; v.currentTime = src.offset; } v.play().catch(() => {}); };
    v.addEventListener('loadedmetadata', meta);
    v.src = src.url; v.load();
    return () => v.removeEventListener('loadedmetadata', meta);
  }, [src?.url]);

  // Progress: shared with the PC.
  const save = (finished) => { if (!vod || !r) return; const p = pos(); if (p < 3 && !finished) return; api('progress', { id: cur.itemId, pos: finished ? 0 : p, len, showKey: cur.showKey || null, finished: !!finished }).catch(() => {}); };
  useEffect(() => { if (!vod) return; const t = setInterval(() => { if (!vid.current?.paused) save(); }, 10000); return () => { clearInterval(t); save(); }; }, [cur, r]);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 500); return () => clearInterval(t); }, []);

  // While dragging the bar: where you're headed, with a little picture of that spot.
  const [drag, setDrag] = useState(null);
  const frameUrl = (t) => `/frame/${cur.itemId}?k=${KEY}&t=${Math.max(0, Math.round((t || 0) / 5) * 5)}${cur.vault ? '&p=1' : ''}`;
  const nextUp = vod && cur.queue?.length ? cur.queue[0] : null;
  const playNext = () => { if (!nextUp) return onClose(); save(true); setCur({ ...cur, itemId: nextUp.id, at: 0, title: nextUp.title, sub: cur.sub?.split(' · ')[0] + ' · ' + nextUp.label, queue: cur.queue.slice(1) }); };
  const ended = () => { if (vod) { save(true); if (nextUp) playNext(); else onClose(); } else setCur({ ...cur }); };

  const seek = (t) => {
    if (!src || src.live || !vod && !r?.play) return;
    t = Math.max(0, Math.min(len - 1, t));
    if (src.mode === 'direct') { vid.current.currentTime = t; return; }
    setSrc({ ...src, url: src.url.replace(/([?&]t=)[\d.]+/, '$1' + t.toFixed(2)), base: t });
  };
  const toggle = () => { const v = vid.current; if (!v) return; if (v.paused) { v.play(); setPaused(false); } else { v.pause(); setPaused(true); } poke(); };
  const [castSheet, setCastSheet] = useState(null); // null | 'loading' | [{id,name}]
  useBack(!!castSheet, () => setCastSheet(null));
  const openCast = (e) => { e.stopPropagation(); setCastSheet('loading'); api('tvs').then((x) => setCastSheet(x.tvs || [])).catch(() => setCastSheet([])); };
  const playElsewhere = () => (vod ? { channelId: cur.channelId, itemId: cur.itemId, at: pos(), opts: cur.showKey ? { queue: (cur.queue || []).map((x) => ({ id: x.id, title: x.title, label: x.label, show: x.show })), seriesKey: cur.showKey, title: cur.title } : {} } : { channelId: cur.channel.id });
  const castTo = (tvd) => { save(); api('cast', { deviceId: tvd.id, play: playElsewhere() }).then(() => { toast(`📡 Playing on ${tvd.name}`); onPc(); }).catch((e) => toast(e.message)); };
  const handOff = () => {
    const at = pos();
    save();
    void at;
    api('remote', { play: playElsewhere() }).then(() => { toast('📺 Moved to the PC'); onPc(); });
  };
  const bar = useRef(null);
  const frac = (e) => { const b = bar.current.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)); };
  const sDown = (e) => { e.stopPropagation(); try { bar.current.setPointerCapture(e.pointerId); } catch {} setDrag(frac(e) * len); poke(); };
  const sMove = (e) => { if (drag == null) return; e.stopPropagation(); setDrag(frac(e) * len); poke(); };
  const sUp = (e) => { if (drag == null) return; e.stopPropagation(); const t = frac(e) * len; setDrag(null); seek(t); poke(); };
  // The bubble's buttons (tap the bubble and Android shows them): back 10, pause/play, forward 10.
  window.hcPipAction = (cmd) => {
    const v = vid.current;
    if (!v) return;
    if (cmd === 'pause') { v.pause(); setPaused(true); }
    else if (cmd === 'play') { v.play(); setPaused(false); }
    else if (cmd === 'rew') seek(pos() - 10);
    else if (cmd === 'fwd') seek(pos() + 10);
  };
  const title = cur.title || cur.channel?.name;
  const sub = vod ? cur.sub : r?.entry ? [r.entry.title, r.entry.sub].filter(Boolean).join(' · ') : '';
  const p = pos();

  return html`<div class=${'player' + (pip ? ' pip' : '')} onClick=${poke}>
    <video ref=${vid} playsinline crossorigin="anonymous" onEnded=${ended} onPlaying=${() => setPaused(false)} onPause=${() => setPaused(true)} onError=${() => setErr('The PC couldn’t send this video')}>
      ${track && html`<track key=${track} kind="subtitles" src=${track} default />`}</video>
    ${lines.length > 0 && html`<div class="p-subs" style=${`bottom:${subBottom()}px`}>${lines.map((l) => html`<div><span>${l}</span></div>`)}</div>`}
    ${!src && !err && html`<div class="p-center"><div class="spin"></div></div>`}
    ${err && html`<div class="p-center"><p>${err}</p><button class="btn" onClick=${onClose}>Back</button></div>`}
    ${(() => { const i = subs?.intro; return vod && i && !pip && p >= i.start - 1 && p < i.end - 3 && html`<button class="p-skip" onClick=${(e) => { e.stopPropagation(); seek(i.end); poke(); }}>⏭ Skip intro</button>`; })()}
    <div class=${'p-ui' + (ui || paused ? '' : ' hide') + (pip ? ' hide' : '')}>
      <div class="p-top"><button class="icon" title="Back" onClick=${(e) => { e.stopPropagation(); onClose(); }}>←</button>
        <div class="grow"><b>${title}</b><small>${sub}</small></div>
        ${vod && subs && html`<button class="icon cc" onClick=${(e) => { e.stopPropagation(); setMenu(true); }}>CC</button>`}
        <button class="icon" title=${turn === 'auto' ? 'Rotate' : 'Rotate (tap again to switch back)'} onClick=${(e) => { e.stopPropagation(); rotate(); poke(); }}>⟳</button>
        ${!cur.vault && html`<button class="icon" title="Play on the PC or a TV" onClick=${openCast}>📺</button>`}</div>
      ${src && !src.live && html`<div class="p-mid">
        <button class="icon big" onClick=${(e) => { e.stopPropagation(); seek(p - 10); poke(); }}>⟲10</button>
        <button class="icon huge" onClick=${(e) => { e.stopPropagation(); toggle(); }}>${paused ? '▶' : '❚❚'}</button>
        <button class="icon big" onClick=${(e) => { e.stopPropagation(); seek(p + 10); poke(); }}>10⟳</button></div>`}
      ${src?.live && html`<div class="p-mid"><button class="icon huge" onClick=${(e) => { e.stopPropagation(); toggle(); }}>${paused ? '▶' : '❚❚'}</button></div>`}
      ${vod && len > 0 && html`<div class="p-bottom"><span>${clock(drag ?? p)}</span>
        <div class="p-bar" ref=${bar} onPointerDown=${sDown} onPointerMove=${sMove} onPointerUp=${sUp} onPointerCancel=${() => setDrag(null)} onClick=${(e) => e.stopPropagation()}>
          <i style=${`width:${Math.min(100, ((drag ?? p) / len) * 100)}%`}></i><b class="p-knob" style=${`left:${Math.min(100, ((drag ?? p) / len) * 100)}%`}></b>
          ${drag != null && html`<div class="p-peek" style=${`left:${Math.min(86, Math.max(14, (drag / len) * 100))}%`}><img src=${frameUrl(drag)} alt="" /><span>${clock(drag)}</span></div>`}
        </div>
        <span>${clock(len)}</span>${nextUp && html`<button class="btn sm" onClick=${(e) => { e.stopPropagation(); playNext(); }}>Next ⏭</button>`}</div>`}
    </div>
    ${castSheet && html`<div class="sheet-bg" onClick=${(e) => { e.stopPropagation(); setCastSheet(null); }}><div class="sheet" onClick=${(e) => e.stopPropagation()}>
      <h3>Play on…</h3>
      ${cast?.on && html`<button class="opt stop" onClick=${() => { setCastSheet(null); api('cast/stop', {}).then(() => toast(`⏹ Stopped casting to ${cast.device}`)).catch((e) => toast(e.message)); }}>⏹ Stop casting on ${cast.device}</button>`}
      <button class="opt" onClick=${() => { setCastSheet(null); handOff(); }}>💻 The PC</button>
      ${castSheet === 'loading' ? html`<div class="muted small" style="padding:8px 12px">Looking for TVs…</div>`
        : castSheet.map((t) => html`<button class="opt" onClick=${() => { setCastSheet(null); castTo(t); }}>📡 ${t.name}${cast?.on && cast.deviceId === t.id ? ' · casting now' : ''}</button>`)}
      ${Array.isArray(castSheet) && !castSheet.length && html`<div class="muted small" style="padding:8px 12px">No TVs found on the network — the PC looks for Chromecast / Google TV sets.</div>`}
      <button class="btn ghost wide" onClick=${() => setCastSheet(null)}>Cancel</button></div></div>`}
    ${menu && html`<div class="sheet-bg" onClick=${(e) => { e.stopPropagation(); setMenu(false); }}><div class="sheet av" onClick=${(e) => e.stopPropagation()}>
      ${subs.audio?.length > 0 && html`<h4>Audio</h4>${subs.audio.map((a) => html`<button class=${'opt' + (audio === a.n ? ' on' : '')} onClick=${() => setAudio(a.n)}>${audio === a.n ? '✓ ' : ''}${a.label}</button>`)}`}
      <h4>Subtitles</h4>
      <button class=${'opt' + (!subOn ? ' on' : '')} onClick=${() => setSubOn(null)}>${!subOn ? '✓ ' : ''}Off</button>
      ${subs.tracks.map((t) => html`<button class=${'opt' + (subOn === t.id ? ' on' : '')} onClick=${() => setSubOn(t.id)}>${subOn === t.id ? '✓ ' : ''}${t.label}</button>`)}
      <button class="btn ghost wide" onClick=${() => setMenu(false)}>Done</button></div></div>`}
  </div>`;
}

// ---------- Remote: for the TV you're casting to, or for the PC itself ----------
function Remote({ state, now, cast, toast, goWatch }) {
  const [pcMode, setPcMode] = useState(false); // while casting: control the PC's own screen instead
  const [screen, setScreen] = useState(null); // 'guide' — opens here, on this device
  const [sheet, setSheet] = useState(null); // 'av' (audio & subtitles) | 'pick' (channel list)
  const castOn = !!cast?.on;
  const tvMode = castOn && !pcMode;
  useEffect(() => { if (!castOn) { setPcMode(false); setScreen(null); setSheet((s) => (s === 'av' ? null : s)); } }, [castOn]);
  useBack(!!sheet, () => setSheet(null));
  const send = (b) => { navigator.vibrate?.(15); api('remote', b).catch((e) => toast(e.message)); };
  const btn = (button) => () => send({ button });
  const key = (k) => () => send({ key: k });
  const stopCast = () => api('cast/stop', {}).then(() => toast('⏹ Casting stopped — back on the PC')).catch((e) => toast(e.message));
  const stale = !now || Date.now() - (now.at || 0) > 8000;
  const av = now?.av;

  if (screen === 'guide') return html`<${GuidePick} state=${state} where=${tvMode ? cast.device : 'the PC'}
    onBack=${() => setScreen(null)}
    onPick=${(c) => { send({ play: { channelId: c.id } }); toast(tvMode ? `📡 ${c.name} is on ${cast.device}` : `📺 ${c.name} is on the PC`); setScreen(null); }} />`;

  return html`<div class="remote">
    ${castOn && html`<div class="seg target">
      <button class=${tvMode ? 'on' : ''} onClick=${() => setPcMode(false)}>📡 ${cast.device}</button>
      <button class=${!tvMode ? 'on' : ''} onClick=${() => setPcMode(true)}>💻 PC screen</button>
    </div>`}
    <div class="now">${stale ? html`<small class="muted">Waiting for the PC…</small>` : html`
      ${now.art && (now.art.startsWith('/') || now.art.startsWith('https:')) && html`<img class="now-art" src=${now.art} alt="" />`}
      <div class="grow now-info">
        <small class="muted">${castOn ? `📡 On ${cast.device}` : now.channel ? `${now.channel.number} · ${now.channel.name}` : 'On the PC'}${now.paused ? ' · paused' : ''}${now.muted ? ' · muted' : ''}</small>
        <b>${now.title || '—'}</b>${now.sub && html`<small class="muted">${now.sub}</small>`}
        ${now.len > 0 && html`<div class="now-bar"><i style=${`width:${Math.min(100, (now.pos / now.len) * 100)}%`}></i></div><small class="muted">${clock(now.pos)} / ${clock(now.len)}</small>`}
      </div>`}</div>
    <div class="r-row">
      <button class="r" onClick=${key('ChannelDown')}>CH ▼</button>
      <button class="r" onClick=${key('ChannelUp')}>CH ▲</button>
      <button class="r" onClick=${key('AudioVolumeDown')}>🔉</button>
      <button class="r" onClick=${key('AudioVolumeUp')}>🔊</button>
      <button class="r" onClick=${key('m')}>${now?.muted ? '🔈' : '🔇'}</button>
    </div>
    ${tvMode ? html`
      <div class="r-row">
        <button class="r" onClick=${btn('LT')}>⟲ 10</button>
        <button class="r wide" onClick=${btn('X')}>${now?.paused ? '▶ Play' : '❚❚ Pause'}</button>
        <button class="r" onClick=${btn('RT')}>10 ⟳</button>
      </div>
      <div class="r-row">
        <button class="r" onClick=${() => setScreen('guide')}>☰ Guide</button>
        <button class="r" onClick=${goWatch}>🎬 Shows & movies</button>
      </div>
      <div class="r-row">
        <button class="r" onClick=${() => (av ? setSheet('av') : toast('No audio or subtitle choices right now'))}>CC / Audio</button>
        <button class="r" onClick=${key('n')}>Next ep ⏭</button>
      </div>
      <button class="btn wide stop" onClick=${stopCast}>⏹ Stop casting</button>
      <p class="muted small center-text">The guide and menus open here, on this screen — what you pick plays on ${cast.device}.</p>
    ` : html`
      <div class="dpad">
        <button class="d up" onClick=${btn('UP')}>▲</button>
        <button class="d left" onClick=${btn('LEFT')}>◀</button>
        <button class="d ok" onClick=${btn('A')}>OK</button>
        <button class="d right" onClick=${btn('RIGHT')}>▶</button>
        <button class="d down" onClick=${btn('DOWN')}>▼</button>
      </div>
      <div class="r-row">
        <button class="r" onClick=${btn('B')}>↩ Back</button>
        <button class="r" onClick=${key('g')}>☰ Guide</button>
        <button class="r" onClick=${btn('Y')}>⚙ Menu</button>
        <button class="r" onClick=${key('BackToTV')}>📺 TV</button>
      </div>
      <div class="r-row">
        <button class="r" onClick=${btn('LT')}>⟲ 10</button>
        <button class="r wide" onClick=${btn('X')}>${now?.paused ? '▶ Play' : '❚❚ Pause'}</button>
        <button class="r" onClick=${btn('RT')}>10 ⟳</button>
      </div>
      <div class="r-row">
        <button class="r" onClick=${key('v')}>CC / Audio</button>
        <button class="r" onClick=${key('n')}>Next ep ⏭</button>
        <button class="r" onClick=${key('i')}>ⓘ Info</button>
        <button class="r" onClick=${key('f')}>⛶</button>
      </div>
      <button class="btn wide" onClick=${() => setSheet('pick')}>📺 Choose a channel for the PC</button>
      ${castOn && html`<button class="btn wide stop" onClick=${stopCast}>⏹ Stop casting on ${cast.device}</button>`}
    `}
    ${sheet === 'pick' && html`<${Sheet} title="Put on the PC" onClose=${() => setSheet(null)}>
      <div class="pick-list">${state.channels.map((c) => html`<button class="ch-row" onClick=${() => { send({ play: { channelId: c.id } }); setSheet(null); }}>
        <span class="ch-num" style=${`--c:${c.color || '#556'}`}>${c.number}</span><div class="grow"><b>${c.name}</b></div></button>`)}</div>
    <//>`}
    ${sheet === 'av' && av && html`<${Sheet} title=${`Audio & subtitles${tvMode ? ` — ${cast.device}` : ''}`} onClose=${() => setSheet(null)}>
      ${av.audio?.length > 1 && html`<h4>Audio</h4>${av.audio.map((a) => html`<button class=${'opt' + (av.audioOn === a.n ? ' on' : '')} onClick=${() => send({ av: { audio: a.n } })}>${av.audioOn === a.n ? '✓ ' : ''}${a.label}</button>`)}`}
      <h4>Subtitles</h4>
      <button class=${'opt' + (!av.on ? ' on' : '')} onClick=${() => send({ av: { sub: null } })}>${!av.on ? '✓ ' : ''}Off</button>
      ${av.tracks.map((t) => html`<button class=${'opt' + (av.on === t.id ? ' on' : '')} onClick=${() => send({ av: { sub: t.id } })}>${av.on === t.id ? '✓ ' : ''}${t.label}</button>`)}
    <//>`}
  </div>`;
}

// The TV guide, on this device: what's on now (and next) on every channel — tap to play it.
function GuidePick({ state, where, onBack, onPick }) {
  const [rows, setRows] = useState(null);
  useBack(true, onBack);
  useEffect(() => {
    const t0 = Date.now();
    api(`guide?from=${t0}&to=${t0 + 2 * 3600e3}`).then((g) => setRows(Object.fromEntries(g.map((r) => [r.id, r.entries || []])))).catch(() => setRows({}));
  }, []);
  const when = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return html`<div class="guidepick">
    <div class="g-head"><button class="icon" onClick=${onBack}>←</button><div class="grow"><b>TV Guide</b><small class="muted">Tap a channel — it plays on ${where}</small></div></div>
    ${!rows ? html`<div class="center-text"><div class="spin" style="margin:0 auto"></div></div>` : state.channels.filter((c) => !c.ondemand).map((c) => {
      const [e, nx] = rows[c.id] || [];
      return html`<button class="ch-row" onClick=${() => onPick(c)}>
        <span class="ch-num" style=${`--c:${c.color || '#556'}`}>${c.number}</span>
        <div class="grow"><b>${c.name}</b>
          <small>${e ? [e.title, e.sub].filter(Boolean).join(' · ') : '—'}</small>
          ${nx && html`<small class="muted">Next · ${when(nx.start)} — ${nx.title || ''}</small>`}</div>
      </button>`;
    })}
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
