// Short dramas: series and channels from YouTube, played in YouTube's own player, with
// episodes in order, Next, and picking up where you stopped. Off and hidden until a grown-up
// turns it on (Settings → Free TV). src/main/main.js refuses dramas:* while it's off.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { tv, Icon } from './util.js';

const plain = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

// The row in Settings → Free TV.
export function DramaSettings({ settings, setSettings, toast, onOpen }) {
  const on = !!settings.dramasOn;
  const flip = async () => {
    try { await tv.dramasSet(!on); setSettings({ dramasOn: !on }); toast?.(on ? 'Short dramas are off.' : 'Turned on. Find them under “Short Dramas” in the top bar.'); }
    catch (e) { toast?.(plain(e)); }
  };
  return html`<div class="settings-row"><div class="grow"><b>🎭 Short dramas</b>
      <span>Series of one-to-ten-minute episodes from the studios’ own YouTube channels, plus any YouTube playlist you add. They play in YouTube’s own player, so YouTube’s ads and terms apply and YouTube can see your internet address. Grown-up profiles only.</span></div>
    ${on && html`<button class="btn sm" onClick=${onOpen}>Open</button>`}
    <button class=${'toggle' + (on ? ' on' : '')} aria-label="Short dramas" aria-pressed=${on} onClick=${flip}></button></div>`;
}

// YouTube's player, in a frame served by HomeCable's media server. Talks by messages only.
function YtFrame({ load, onEvent, frameRef }) {
  const [src, setSrc] = useState(null);
  const origin = useRef('');
  useEffect(() => { tv.dramasPlayerUrl().then((u) => { origin.current = new URL(u).origin; setSrc(u); }).catch(() => {}); }, []);
  useEffect(() => {
    const on = (e) => { if (e.origin === origin.current && e.data?.hc === 'yt') onEvent(e.data); };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [onEvent]);
  const sendLoad = () => frameRef.current?.contentWindow?.postMessage({ hc: 'yt', cmd: 'load', ...load }, origin.current);
  useEffect(() => { if (src && load) sendLoad(); }, [src, JSON.stringify(load)]);
  return src ? html`<iframe class="yt-frame" ref=${frameRef} src=${src} allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen title="YouTube player" onLoad=${sendLoad}></iframe>` : html`<div class="yt-frame"></div>`;
}

function Watch({ item, onBack, toast }) {
  const frame = useRef(null);
  const isList = item.kind === 'playlist';
  const start = item.progress && !item.progress.done ? item.progress : { i: 0, t: 0 };
  const [load] = useState(isList ? { list: item.ref, index: start.i || 0, t: start.t > 5 ? start.t : 0 } : { video: item.ref, t: start.t > 5 ? start.t : 0 });
  const [ids, setIds] = useState(isList ? [] : [item.ref]);
  const [titles, setTitles] = useState({});
  const [now, setNow] = useState({ i: start.i || 0, s: -1 });
  const [blocked, setBlocked] = useState(null);
  const [big, setBig] = useState(false);
  const saved = useRef(0);
  const send = (m) => frame.current?.contentWindow?.postMessage({ hc: 'yt', ...m }, '*');
  useEffect(() => { if (ids.length) tv.dramasTitles(ids).then(setTitles).catch(() => {}); }, [ids.join()]);
  const onEvent = (m) => {
    if (m.ev === 'playlist') { setIds(m.ids); return; }
    if (m.ev === 'error') {
      // 101/150: the owner only lets it play on YouTube. Say so, and move on.
      if (m.code === 101 || m.code === 150 || m.code === 100) { setBlocked(m.id || ids[m.i] || null); if (isList) setTimeout(() => send({ cmd: 'next' }), 5000); }
      return;
    }
    if (m.ev === 'state' || m.ev === 'ended') {
      const i = isList ? Math.max(0, m.i ?? 0) : 0;
      setNow({ i, s: m.s, t: m.t, d: m.d, id: m.id });
      if (m.s === 1) setBlocked(null);
      const n = isList ? ids.length || 0 : 1;
      const last = n && i >= n - 1;
      const done = m.ev === 'ended' && last;
      // Every 10 seconds while it plays, and at the end of each episode.
      if ((m.s === 1 && Date.now() - saved.current > 10000) || m.ev === 'ended') {
        saved.current = Date.now();
        const next = m.ev === 'ended' && !last ? { i: i + 1, t: 0 } : { i, t: m.ev === 'ended' ? 0 : m.t };
        tv.dramasProgress(item.id, { ...next, n, done }).catch(() => {});
      }
    }
  };
  const ep = (k) => titles[k]?.title || `Episode ${ids.indexOf(k) + 1}`;
  return html`<div class=${'drama-watch' + (big ? ' big' : '')}>
    <div class="drama-bar">
      <button class="btn sm" onClick=${onBack}><${Icon.left} /> Back</button>
      <b class="grow">${item.title}${isList && ids.length ? html` <span class="muted">· Episode ${now.i + 1} of ${ids.length}</span>` : ''}</b>
      ${isList && html`<button class="btn sm" disabled=${now.i <= 0} onClick=${() => send({ cmd: 'prev' })}>Previous</button><button class="btn sm" disabled=${ids.length > 0 && now.i >= ids.length - 1} onClick=${() => send({ cmd: 'next' })}>Next</button>`}
      <button class="btn sm" onClick=${() => setBig((b) => !b)}>${big ? 'Smaller' : 'Bigger'}</button>
    </div>
    <div class="drama-main">
      <div class="drama-player">
        <${YtFrame} load=${load} onEvent=${onEvent} frameRef=${frame} />
        ${blocked && html`<div class="drama-blocked">This episode can only be watched on YouTube itself.${isList ? ' Moving to the next one…' : ''}
          <a href=${watchUrl(blocked)} target="_blank" rel="noreferrer">Watch it on YouTube</a></div>`}
      </div>
      ${isList && !big && html`<div class="drama-eps">${!ids.length ? html`<div class="muted small">Loading episodes…</div>` : ids.map((k, i) => html`
        <button class=${'drama-ep' + (i === now.i ? ' on' : '') + (titles[k] && !titles[k].embed ? ' off' : '')} key=${k} onClick=${() => send({ cmd: 'at', i })}>
          <img src=${thumb(k)} alt="" loading="lazy" referrerpolicy="no-referrer" /><span><b>${i + 1}</b> ${ep(k)}</span></button>`)}</div>`}
    </div>
  </div>`;
}

const Card = ({ title, sub, img, onClick, onRemove, pct }) => html`<div class="drama-card">
  <button class="drama-open" onClick=${onClick}>
    <div class="drama-thumb">${img ? html`<img src=${img} alt="" loading="lazy" referrerpolicy="no-referrer" />` : html`<span>🎭</span>`}${pct > 0 && html`<i style=${`width:${Math.min(100, pct)}%`}></i>`}</div>
    <b>${title}</b>${sub && html`<span>${sub}</span>`}</button>
  ${onRemove && html`<button class="icon-btn drama-x" title="Remove" onClick=${onRemove}><${Icon.close} /></button>`}</div>`;

export function DramasView({ toast }) {
  const [home, setHome] = useState(null);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [watch, setWatch] = useState(null);
  const load = () => tv.dramasHome().then(setHome).catch((e) => { toast?.(plain(e)); setHome({ series: [], channels: [] }); });
  useEffect(() => { load(); }, []);
  const add = async () => {
    if (!link.trim()) return;
    setBusy(true);
    try { const r = await tv.dramasAdd(link.trim()); toast?.(r.already ? 'That one is already here.' : r.kind === 'channel' ? 'Channel added.' : 'Added.'); setLink(''); await load(); }
    catch (e) { toast?.(plain(e)); }
    setBusy(false);
  };
  const remove = async (id) => { try { await tv.dramasRemove(id); await load(); } catch (e) { toast?.(plain(e)); } };
  if (watch) return html`<div class="overlay dramas-view"><div class="overlay-body drama-body"><${Watch} item=${watch} toast=${toast} onBack=${() => { setWatch(null); load(); }} /></div></div>`;
  const going = (home?.series || []).filter((s) => s.progress && !s.progress.done);
  const sub = (s) => (s.progress?.done ? 'Watched' : s.progress && s.kind === 'playlist' ? `Episode ${s.progress.i + 1}${s.progress.n ? ` of ${s.progress.n}` : ''}` : s.by);
  const pct = (s) => (s.progress?.n ? ((s.progress.i + (s.progress.done ? 1 : 0)) / s.progress.n) * 100 : 0);
  return html`<div class="overlay dramas-view">
    <div class="overlay-head"><h2>🎭 Short Dramas</h2></div>
    <div class="overlay-body">
      <div class="drama-add">
        <input class="input grow" placeholder="Paste a YouTube playlist, video or channel link" value=${link} disabled=${busy}
          onInput=${(e) => setLink(e.target.value)} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') add(); }} />
        <button class="btn primary" disabled=${busy || !link.trim()} onClick=${add}>${busy ? 'Adding…' : 'Add'}</button>
      </div>
      <p class="muted small">A whole series is usually a playlist on the studio’s channel: open it on YouTube and copy its link. Episodes play in order, and it remembers where you stopped.</p>
      ${home === null ? html`<div class="cat-loading">Loading…</div>` : html`
        ${going.length > 0 && html`<h3 class="drama-h">Continue watching</h3><div class="drama-row">${going.map((s) => html`<${Card} key=${'c' + s.id} title=${s.title} sub=${sub(s)} img=${s.thumb} pct=${pct(s)} onClick=${() => setWatch(s)} />`)}</div>`}
        <h3 class="drama-h">Your series</h3>
        ${home.series.length ? html`<div class="drama-row">${home.series.map((s) => html`<${Card} key=${s.id} title=${s.title} sub=${sub(s)} img=${s.thumb} pct=${pct(s)} onClick=${() => setWatch(s)} onRemove=${() => remove(s.id)} />`)}</div>`
          : html`<p class="muted">None yet. Paste a playlist link above.</p>`}
        ${home.channels.map((c) => html`<div class="drama-ch" key=${c.id}><h3 class="drama-h">Latest from ${c.name}<button class="btn ghost sm" title="Remove this channel" onClick=${() => remove(c.id)}>Remove</button></h3>
          ${c.failed ? html`<p class="muted small">YouTube didn’t answer. Try again later.</p>` : html`<div class="drama-row">${c.videos.map((v) => html`<${Card} key=${v.id} title=${v.title} img=${v.thumb} pct=${v.progress?.done ? 100 : 0}
            onClick=${() => setWatch({ id: 'v:' + v.id, kind: 'video', ref: v.id, title: v.title, progress: v.progress })} />`)}</div>`}</div>`)}`}
    </div>
  </div>`;
}
