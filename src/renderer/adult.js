// Adults only: off and out of sight until a grown-up turns it on and confirms they're 18 or
// older. Its stations are links people add themselves; they get their own button in the top
// bar and stay out of the channels, guide, surfing, phone and TV menu.
// src/main/main.js enforces it (adult:*): while it's off, nothing here runs.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { tv, Icon } from './util.js';

const plain = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// Whole years from a YYYY-MM-DD date; null if it isn't a real, past date.
export function ageFrom(birth, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (d.getMonth() !== +m[2] - 1 || d > now || +m[1] < 1900) return null;
  let a = now.getFullYear() - +m[1];
  if (now.getMonth() < +m[2] - 1 || (now.getMonth() === +m[2] - 1 && now.getDate() < +m[3])) a--;
  return a;
}

function AdultDialog({ onClose, onEnabled }) {
  const [birth, setBirth] = useState('');
  const [over, setOver] = useState(false);
  const [own, setOwn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const age = ageFrom(birth);
  const tooYoung = age != null && age < 18;
  const go = async () => {
    setBusy(true); setErr('');
    try { await tv.adultEnable({ birth, over18: over, ownLinks: own }); onEnabled(); }
    catch (e) { setErr(plain(e)); setBusy(false); }
  };
  const today = new Date().toISOString().slice(0, 10);
  return html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}><div class="modal consent-modal adult-consent">
    <div class="modal-head"><h3>Turn on Adults only?</h3><button class="icon-btn" title="Close" onClick=${onClose}><${Icon.close} /></button></div>
    <div class="modal-body"><div class="consent">
      <div class="consent-box bad"><b>🔞 Only for people 18 or older</b>
        <span>This is a place for adult live stations, which can be sexually explicit. Only turn it on if you’re 18 or older and adult content is legal where you live. Only grown-up profiles can see it.</span></div>
      <div class="consent-box"><b>📭 Nothing comes with it</b>
        <span>HomeCable doesn’t include, list or recommend any adult stations. You paste in your own playlist or stream links, and you’re responsible for having the right to watch what they carry.</span></div>
      <div class="consent-box"><b>🚪 Kept apart</b>
        <span>Its stations get their own button in the top bar. They never show up in your channels, the guide, channel surfing, the phone app or your TV’s media menu.</span></div>
      <div class="consent-box"><b>🌐 It goes online</b>
        <span>Links you add are fetched from wherever they’re hosted, and those servers can see your internet address, like any website.</span></div>
      <label class="field">Your date of birth
        <input class="input adult-birth" type="date" max=${today} value=${birth} onInput=${(e) => setBirth(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} /></label>
      <span class="muted small">Only used to check your age. It isn’t saved.</span>
      ${tooYoung && html`<div class="cat-nostream">Adults only is for people 18 or older.</div>`}
      <label class="consent-tick"><input type="checkbox" checked=${over} onChange=${(e) => setOver(e.target.checked)} /><span>I’m 18 or older, and adult content is legal where I live.</span></label>
      <label class="consent-tick"><input type="checkbox" checked=${own} onChange=${(e) => setOwn(e.target.checked)} /><span>I’m responsible for the links I add and for what I watch.</span></label>
      ${err && html`<div class="cat-nostream">${err}</div>`}
      <div class="row" style="justify-content:flex-end;gap:10px;margin-top:6px">
        <button class="btn" onClick=${onClose}>Keep it off</button>
        <button class="btn primary" disabled=${!(age >= 18) || !over || !own || busy} onClick=${go}>${busy ? 'Turning on…' : 'Turn on'}</button>
      </div>
    </div></div>
  </div></div>`;
}

// The row in Settings.
export function AdultSettings({ settings, setSettings, toast, onOpen, onOff }) {
  const [ask, setAsk] = useState(false);
  const on = !!settings.adultOn;
  const off = async () => {
    try { await tv.adultOff(); setSettings({ adultOn: false }); onOff?.(); toast?.('Adults only is off.'); }
    catch (e) { toast?.(plain(e)); }
  };
  return html`<div class="settings-row"><div class="grow"><b>🔞 Adults only</b>
      <span>${on ? 'On. Find it under “Adults only” in the top bar. Turning it off hides it again; your stations stay saved.' : 'Off, and hidden everywhere. A separate place for adult live stations you add yourself, for people 18 and older.'}</span></div>
    ${on && html`<button class="btn sm" onClick=${onOpen}>Open</button>`}
    ${on ? html`<button class="btn sm" onClick=${off}>Turn off</button>` : html`<button class="btn sm" onClick=${() => setAsk(true)}>Turn on…</button>`}
    ${ask && html`<${AdultDialog} onClose=${() => setAsk(false)} onEnabled=${() => { setAsk(false); setSettings({ adultOn: true }); toast?.('Turned on. Find it under “Adults only” in the top bar.'); }} />`}</div>`;
}

// Its own place: the stations you added, and a box to add more.
export function AdultView({ onTune, toast }) {
  const [list, setList] = useState(null);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(null); // null, or { n, total }
  const load = () => tv.adultList().then(setList).catch((e) => { toast?.(plain(e)); setList([]); });
  useEffect(() => { load(); return tv.onAdultProgress?.((p) => setBusy(p)); }, []);
  const add = async () => {
    if (!link.trim()) return;
    setBusy({ n: 0, total: 0 });
    try {
      const r = await tv.adultAdd(link.trim());
      toast?.(`Added ${r.added} station${r.added === 1 ? '' : 's'}${r.failed ? ` · ${r.failed} didn’t answer` : ''}${r.already ? ` · ${r.already} already here` : ''}`);
      if (r.added) setLink('');
      await load();
    } catch (e) { toast?.(plain(e)); }
    setBusy(null);
  };
  const remove = async (id) => { try { setList(await tv.adultRemove(id)); } catch (e) { toast?.(plain(e)); } };
  const removeAll = async () => { try { setList(await tv.adultRemoveAll()); toast?.('Removed every station.'); } catch (e) { toast?.(plain(e)); } };
  return html`<div class="overlay adult-view">
    <div class="overlay-head"><h2>🔞 Adults only</h2></div>
    <div class="overlay-body">
      <div class="adult-add">
        <input class="input grow" placeholder="Paste a playlist (.m3u) or stream link" value=${link} disabled=${!!busy}
          onInput=${(e) => setLink(e.target.value)} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') add(); }} />
        <button class="btn primary" disabled=${!!busy || !link.trim()} onClick=${add}>${busy ? (busy.total ? `Checking ${busy.n} of ${busy.total}…` : 'Reading…') : 'Add'}</button>
      </div>
      <p class="muted small">Each station is checked first, and only the ones that answer are added. Only add links you have the right to watch.</p>
      ${list === null ? html`<div class="cat-loading">Loading…</div>`
        : !list.length ? html`<div class="sr-empty"><h3>Nothing here yet</h3><p>HomeCable doesn’t come with any adult stations. Paste in a playlist or stream link of your own above.</p></div>`
          : html`<div class="adult-grid">${list.map((s) => html`<div class=${'adult-card' + (s.dead ? ' dead' : '')} key=${s.id}>
              <button class="adult-play" title=${`Watch ${s.name}`} onClick=${() => onTune(s.id)}>
                ${s.logo ? html`<img src=${s.logo} alt="" loading="lazy" referrerpolicy="no-referrer" onError=${(e) => { e.target.style.display = 'none'; }} />` : html`<span class="adult-initial">${(s.name || '?')[0]}</span>`}
                <b>${s.name}</b><span>${s.group || 'Live'}</span></button>
              <button class="icon-btn adult-x" title="Remove" onClick=${() => remove(s.id)}><${Icon.close} /></button></div>`)}</div>`}
      <div class="row adult-foot"><span class="muted small grow">Only grown-up profiles can see this. These stations stay out of your channels, the guide, channel surfing, the phone app and your TV’s media menu.</span>
        ${list?.length > 0 && html`<button class="btn sm" onClick=${removeAll}>Remove all</button>`}</div>
    </div>
  </div>`;
}
