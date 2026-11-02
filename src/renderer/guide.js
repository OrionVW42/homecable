import { html } from 'htm/preact';
import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import { tv, fmtTime, entryText, ChannelLogo, Icon } from './util.js';

const SLOT = 30 * 60e3;
const SPAN = 2.5 * 3600e3; // visible window

// Cable-style grid guide. The live picture shrinks to the top-right corner
// while it's open (handled by the Player's `pip` class).
export function Guide({ channels, tunedId, onTune, onClose, mixTargets = [], toast }) {
  const [mix, setMix] = useState(null); // live programme being mixed into a channel
  const [q, setQ] = useState(''); // the search bar up top
  const [genre, setGenre] = useState(''); // the genre filter beside it
  const [gmap, setGmap] = useState({}); // channel id → its genres
  useEffect(() => { tv.channelGenres().then(setGmap).catch(() => {}); }, [channels]);
  const [start, setStart] = useState(() => Math.floor(Date.now() / SLOT) * SLOT);
  const [rows, setRows] = useState([]);
  const [sel, setSel] = useState({ ch: Math.max(0, channels.findIndex((c) => c.id === tunedId)), t: Date.now() });
  const [now, setNow] = useState(Date.now());
  const rowsRef = useRef();
  const mdrag = useRef(null); // middle-button drag: pan channels and time
  // Search narrows the rows: channel names, and what's on them now or next.
  const ql = q.trim().toLowerCase();
  const byGenre = (c) => !genre || (gmap[c.id] || []).includes(genre);
  const chans = channels.filter((c) => byGenre(c) && (!ql || c.name.toLowerCase().includes(ql)
    || (rows.find((r) => r.id === c.id)?.entries || []).some((e) => String(e.title || '').toLowerCase().includes(ql) || String(e.show || '').toLowerCase().includes(ql))));
  const allGenres = (() => {
    const count = new Map();
    for (const c of channels) for (const g of gmap[c.id] || []) count.set(g, (count.get(g) || 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(b[0]));
  })();
  useEffect(() => { setSel((s) => ({ ...s, ch: 0 })); }, [ql, genre]);
  // The mouse wheel scrolls the channel rows, pop-out or fullscreen alike.
  useEffect(() => {
    const el = rowsRef.current;
    if (!el) return;
    const onWheel = (e) => { el.scrollTop += e.deltaY; e.preventDefault(); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const load = useCallback(() => tv.guide(start - SLOT, start + SPAN + SLOT).then(setRows), [start]);
  useEffect(() => { load(); }, [load, channels]);
  useEffect(() => tv.onScheduleChanged(load), [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, []);

  // Breaks and "up next" gaps belong to the program before them, like the
  // half-hour boxes on a real cable guide.
  const entriesFor = (i) => {
    const raw = rows.find((r) => r.id === chans[i]?.id)?.entries || [];
    const out = [];
    for (const e of raw) {
      const prev = out[out.length - 1];
      if ((e.type === 'filler' || e.type === 'upnext' || e.type === 'ad' || e.type === 'ident') && prev && prev.type === 'program') prev.end = e.end;
      else out.push({ ...e });
    }
    return out;
  };
  const selEntry = entriesFor(sel.ch).find((e) => e.start <= sel.t && sel.t < e.end) || null;
  const selCh = chans[sel.ch];

  // Keep the selected row in view.
  useEffect(() => {
    const el = rowsRef.current?.children[sel.ch];
    el?.scrollIntoView({ block: 'nearest' });
  }, [sel.ch]);

  useEffect(() => {
    const key = (e) => {
      if (e.target.closest?.('input, textarea, select')) return; // typing in the search bar
      const list = entriesFor(sel.ch);
      const cur = list.findIndex((x) => x.start <= sel.t && sel.t < x.end);
      const end = start + SPAN;
      if (e.key === 'ArrowDown') { setSel((s) => ({ ...s, ch: Math.min(chans.length - 1, s.ch + 1) })); }
      else if (e.key === 'ArrowUp') { setSel((s) => ({ ...s, ch: Math.max(0, s.ch - 1) })); }
      else if (e.key === 'ArrowRight') {
        const nx = list[cur + 1];
        if (nx) { const t = Math.max(nx.start, start) + 1000; setSel((s) => ({ ...s, t })); if (nx.start >= end - SLOT / 2) setStart((v) => v + SLOT); }
      } else if (e.key === 'ArrowLeft') {
        const pv = list[cur - 1];
        if (pv && pv.end > Date.now()) { const t = Math.max(pv.start, Date.now()) + 1000; setSel((s) => ({ ...s, t })); if (pv.start < start) setStart((v) => Math.max(Math.floor(Date.now() / SLOT) * SLOT, v - SLOT)); }
      } else if (e.key === 'PageDown') setSel((s) => ({ ...s, ch: Math.min(chans.length - 1, s.ch + 6) }));
      else if (e.key === 'PageUp') setSel((s) => ({ ...s, ch: Math.max(0, s.ch - 6) }));
      else if (e.key === 'Enter') { if (selCh) onTune(selCh.id); }
      else if ((e.key === 'm' || e.key === 'MixLive') && selEntry?.stationId) setMix(selEntry);
      else return;
      e.preventDefault(); e.stopPropagation();
    };
    if (mix) return; // the mix dialog has the keys
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [sel, rows, start, channels, mix]);

  const pos = (t) => ((t - start) / SPAN) * 100;
  const shift = (d) => setStart((v) => Math.max(Math.floor(Date.now() / SLOT) * SLOT, v + d * SLOT));
  const t = entryText(selEntry);

  return html`<div class="overlay guide">
    <div class="guide-top">
      <div class="time">${selCh ? `${selCh.number} · ${selCh.name}` : ''}${selEntry ? (selEntry.type === 'ondemand' ? ' · Any time' : ` · ${fmtTime(selEntry.start)} – ${fmtTime(selEntry.end)}`) : ''}</div>
      <h2>${t.title}</h2>
      <div class="muted">${t.sub}${selEntry?.block ? ` · ${selEntry.block} block` : ''}</div>
      ${selEntry?.summary && html`<p>${selEntry.summary}</p>`}
      <div class="row" style="margin-top:10px">
        <button class="btn primary sm" onClick=${() => selCh && onTune(selCh.id)}>Watch channel ${selCh?.number ?? ''}</button>
        ${selEntry?.stationId && mixTargets.length > 0 && html`<button class="btn sm" onClick=${() => setMix(selEntry)}>📺 Mix into a channel <kbd>M</kbd></button>`}
        <button class="btn sm" onClick=${onClose}>Close guide <kbd>G</kbd></button>
        <input class="input guide-search" placeholder="🔍 Search channels & shows…" value=${q} onInput=${(e) => setQ(e.target.value)} />
        ${allGenres.length > 0 && html`<select class="select guide-genre" value=${genre} onChange=${(e) => setGenre(e.target.value)}>
          <option value="">🏷 All genres</option>
          ${allGenres.map(([g, n]) => html`<option value=${g}>${g} (${n})</option>`)}
        </select>`}
      </div>
    </div>
    <div class="grid-wrap">
      <div class="grid-times">
        <div class="corner">
          <button class="icon-btn" title="Earlier" onClick=${() => shift(-1)}><${Icon.left} /></button>
          <button class="icon-btn" title="Later" onClick=${() => shift(1)}><${Icon.right} /></button>
          <span class="small faint" style="margin-left:6px">${new Date(start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>
        </div>
        <div class="slots">${[0, 1, 2, 3, 4].map((i) => html`<span style=${`left:${pos(start + i * SLOT)}%`}>${fmtTime(start + i * SLOT)}</span>`)}</div>
      </div>
      <div class="grid-rows" ref=${rowsRef}
        onAuxClick=${(e) => e.button === 1 && e.preventDefault()}
        onPointerDown=${(e) => { if (e.button !== 1) return; e.preventDefault(); mdrag.current = { x: e.clientX, y: e.clientY, top: rowsRef.current.scrollTop, steps: 0 }; try { e.currentTarget.setPointerCapture(e.pointerId); } catch {} }}
        onPointerMove=${(e) => { const d = mdrag.current; if (!d) return; rowsRef.current.scrollTop = d.top - (e.clientY - d.y); const steps = Math.trunc((d.x - e.clientX) / 110); if (steps !== d.steps) { shift(steps - d.steps); d.steps = steps; } }}
        onPointerUp=${() => { mdrag.current = null; }}
        onPointerCancel=${() => { mdrag.current = null; }}>
        ${chans.map((ch, i) => html`<div class=${'grid-row' + (ch.id === tunedId ? ' tuned' : '')} key=${ch.id}>
          <div class="ch" onClick=${() => onTune(ch.id)} title="Watch"><b>${ch.number}</b><${ChannelLogo} ch=${ch} size=${32} /><span>${ch.name}</span></div>
          <div class="cells">
            ${now >= start && now < start + SPAN && html`<div class="nowline" style=${`left:${pos(now)}%`}></div>`}
            ${entriesFor(i).filter((e) => e.end > start && e.start < start + SPAN).map((e) => {
              const l = Math.max(0, pos(e.start)), r = Math.min(100, pos(e.end));
              const tx = entryText(e);
              const isSel = i === sel.ch && e.start <= sel.t && sel.t < e.end;
              const onNow = e.start <= now && now < e.end;
              return html`<div class=${`cell ${e.type}${isSel ? ' sel' : ''}${onNow ? ' on-now' : ''}`} style=${`left:calc(${l}% + 3px);width:calc(${r - l}% - 6px)`}
                onClick=${() => setSel({ ch: i, t: Math.max(e.start, now) + 1 })} onDblClick=${() => onTune(ch.id)}>
                <div class="t">${e.start < start ? '‹ ' : ''}${tx.title}</div>
                <div class="s">${tx.sub || fmtTime(e.start)}</div>
              </div>`;
            })}
          </div>
        </div>`)}
      </div>
    </div>
    ${mix && html`<${MixDialog} entry=${mix} station=${channels.find((c) => c.id === mix.stationId)} targets=${mixTargets} onClose=${() => setMix(null)} toast=${toast} />`}
  </div>`;
}

// Put a live programme (e.g. the 5 PM news) into one of your own channels.
function MixDialog({ entry, station, targets, onClose, toast }) {
  const day = new Date(entry.start).toLocaleDateString([], { weekday: 'long' });
  const [target, setTarget] = useState(targets[0]?.id);
  const [repeat, setRepeat] = useState('weekly');
  const [name, setName] = useState(entry.program || entry.title);
  const go = async () => {
    await tv.liveMix({ channelId: target, stationId: entry.stationId, start: entry.start, end: entry.end, repeat, name });
    const ch = targets.find((c) => c.id === target);
    toast?.(`“${name}” will air on ${ch.number} ${ch.name} — ${repeat === 'once' ? 'once' : repeat === 'daily' ? 'every day' : repeat === 'weekdays' ? 'weekdays' : 'every ' + day} at ${fmtTime(entry.start)}`);
    onClose();
  };
  return html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}><div class="modal narrow">
    <div class="modal-head"><h3>Mix into a channel</h3><button class="icon-btn" onClick=${onClose}><${Icon.close} /></button></div>
    <div class="modal-body">
      <p class="muted" style="margin-top:0">Play <b style="color:var(--text)">${station?.name}</b> on one of your channels from ${fmtTime(entry.start)} to ${fmtTime(entry.end)}. Your own programming fills the rest of the day.</p>
      <label class="field">Name<input class="input" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
      <label class="field" style="margin-top:12px">On channel
        <select class="select" value=${target} onChange=${(e) => setTarget(e.target.value)}>${targets.map((c) => html`<option value=${c.id}>${c.number} · ${c.name}</option>`)}</select></label>
      <div class="field" style="margin-top:12px">How often
        <div class="seg">${[['once', 'Just this time'], ['weekly', 'Every ' + day], ['weekdays', 'Weekdays'], ['daily', 'Every day']].map(([k, l]) => html`<button class=${repeat === k ? 'on' : ''} onClick=${() => setRepeat(k)}>${l}</button>`)}</div></div>
    </div>
    <div class="modal-foot"><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${!target} onClick=${go}>Add to channel</button></div>
  </div></div>`;
}
